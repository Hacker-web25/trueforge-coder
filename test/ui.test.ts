/**
 * Headless full-stack test: the REAL bundled extension (dist/extension.js) runs against a fake `vscode`,
 * its chat panel (media/chat.js) runs in jsdom, and the agent runs on a REAL local TrueForge with a scripted model.
 * Run `npm run build` first.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module, { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
// @ts-ignore plain ESM helper
import { putProvider } from '../scripts/setup-lib.mjs';
import { startMockLlm, type MockLlm } from './mockLlm';
import { createFakeVscode, type FakeEnv } from './fakeVscode';

const TF = process.env.TRUEFORGE_URL ?? 'http://localhost:8790';
const repo = path.resolve(new URL('..', import.meta.url).pathname);
const FILE = ['def add(a, b):', '    return a + b', '', '', 'def sub(a, b):', '    return a - b', '', '', 'def mul(a, b):', '    return a * b', ''].join('\n');

let mock: MockLlm;
let root: string;
let env: FakeEnv;
let dom: JSDOM;
let ext: any;
const ctx: any = { subscriptions: [] };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, what: string, ms = 20000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await sleep(40);
  }
  throw new Error(`timed out waiting for ${what}\nDOM log:\n${dom?.window.document.getElementById('log')?.textContent?.slice(-1500)}`);
}
const q = (sel: string) => dom.window.document.querySelector(sel) as any;
const qa = (sel: string) => [...dom.window.document.querySelectorAll(sel)] as any[];
const idle = () => waitFor(() => !q('#send').hidden, 'run to finish (Send visible again)', 30000);
const logText = () => q('#log').textContent as string;

async function resetFiles() {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'calc.py'), FILE);
}

function submit(text: string) {
  q('#input').value = text;
  q('#composer').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tfc-ui-'));
  await resetFiles();
  mock = await startMockLlm(9911);
  await putProvider(TF, { name: 'mock', base_url: 'http://127.0.0.1:9911/v1', api_key: 'test-key-not-real', models: [{ name: 'mock-model', model_id: 'mock-model' }] });
  await putProvider(TF, { name: 'bad', base_url: 'http://127.0.0.1:9911/bad/v1', api_key: 'test-key-not-real', models: [{ name: 'mock-model', model_id: 'mock-model' }] });
  env = { root, config: { baseUrl: TF, mcpPort: 8795, models: ['mock/mock-model'], retries: 0, contextBudgetTokens: 3000, compactionTriggerTokens: 16000 }, commands: new Map(), executed: [], views: [], infoMessages: [], errorMessages: [], quickPickMode: 'accept-all', opened: [] };
  const fake = createFakeVscode(env);
  const M = Module as any;
  const orig = M._load;
  M._load = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? fake : orig.call(this, request, ...rest);
  };
  ctx.extensionUri = fake.Uri.file(repo);
  ext = createRequire(import.meta.url)(path.join(repo, 'dist/extension.js'));
  await ext.activate(ctx);

  // Stand up the chat panel in jsdom, wired to the extension's webview provider.
  const { provider } = env.views.find(v => v.type === 'trueforgeCoder.chat')!;
  let receive: (m: any) => void = () => {};
  const view = {
    webview: {
      options: {}, html: '', cspSource: 'test',
      asWebviewUri: (u: any) => u,
      postMessage: async (m: any) => { dom?.window.dispatchEvent(new dom.window.MessageEvent('message', { data: m })); return true; },
      onDidReceiveMessage: (cb: (m: any) => void) => { receive = cb; return { dispose() {} }; },
    },
    show() {}, onDidDispose() {},
  };
  provider.resolveWebviewView(view);
  const html = view.webview.html.replace(/<script[^>]*src=[^>]*><\/script>/, '').replace(/<link[^>]*>/, '');
  dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  (dom.window as any).acquireVsCodeApi = () => ({ postMessage: (m: any) => receive(m) });
  dom.window.eval(readFileSync(path.join(repo, 'media/chat.js'), 'utf8'));
});

after(async () => {
  for (const d of ctx.subscriptions) { try { d.dispose?.(); } catch { /* ignore */ } }
  await mock?.close();
  await fs.rm(root, { recursive: true, force: true });
});

const editScript = (ctxm: any) => {
  if (ctxm.turn === 0) return { text: 'Plan: read then edit calc.py.', toolCalls: [{ name: ctxm.find('read_file'), args: { path: 'calc.py' } }] };
  if (ctxm.turn === 1)
    return { toolCalls: [{ name: ctxm.find('propose_edit'), args: { path: 'calc.py', edits: [{ old_text: '    return a + b', new_text: '    """Add."""\n    return a + b' }, { old_text: '    return a * b', new_text: '    """Multiply."""\n    return a * b' }] } }] };
  return { text: 'All done.' };
};

test('chat panel: context card, hunk review (reject one hunk), apply, then Undo last run restores the file', async () => {
  mock.setScript(editScript);
  submit('Add docstrings to add() and mul() in @calc.py');
  await waitFor(() => qa('details').length > 0, 'context pack card');
  assert.match(q('details').textContent, /Context pack: \d+ items/);
  assert.match(q('details').textContent, /calc\.py/);
  const review = await waitFor(() => qa('.review:not(.done)')[0], 'review card');
  const boxes = qa('.review:not(.done) input[type=checkbox]');
  assert.equal(boxes.length, 2, 'two hunks shown');
  boxes[1].checked = false;
  boxes[1].dispatchEvent(new dom.window.Event('change'));
  assert.match(review.querySelector('button.primary').textContent, /Apply 1 of 2/);
  review.querySelector('button.primary').click();
  await idle();
  const after1 = await fs.readFile(path.join(root, 'calc.py'), 'utf8');
  assert.match(after1, /"""Add\."""/);
  assert.doesNotMatch(after1, /Multiply/);
  assert.match(logText(), /Done with mock\/mock-model/);
  assert.match(logText(), /Applied 1\/2 hunk/);
  assert.equal(q('#undo').disabled, false, 'undo enabled after a run that changed files');
  // diff editor was opened natively
  assert.ok(env.executed.some(e => e.id === 'vscode.diff'), 'native diff opened');
  // Undo
  q('#undo').click();
  await waitFor(async () => (await fs.readFile(path.join(root, 'calc.py'), 'utf8')) === FILE, 'file restored', 5000).catch(() => {});
  await sleep(300);
  assert.equal(await fs.readFile(path.join(root, 'calc.py'), 'utf8'), FILE);
  assert.match(logText(), /Reverted/);
});

test('Stop button cancels a running agent', async () => {
  mock.setScript(() => ({ text: 'working ', hang: true }));
  submit('long task');
  await waitFor(() => !q('#stop').hidden, 'Stop visible');
  await sleep(2000);
  q('#stop').click();
  await idle();
  assert.match(logText(), /Stopped/);
});

test('failing first model: automatic fallback, notice shown, run completes on the second model', async () => {
  env.config.models = ['bad/mock-model', 'mock/mock-model'];
  mock.setScript(editScript);
  submit('Add docstrings');
  const review = await waitFor(() => qa('.review:not(.done)')[0], 'review card after fallback', 30000);
  review.querySelector('button.primary').click();
  await idle();
  assert.match(logText(), /Model bad\/mock-model failed/);
  assert.match(logText(), /falling back to mock\/mock-model/);
  assert.match(logText(), /Done with mock\/mock-model/);
  assert.match(await fs.readFile(path.join(root, 'calc.py'), 'utf8'), /"""Add\."""/);
  env.config.models = ['mock/mock-model'];
});

test('inline edit command: native hunk picker, one propose_edit, applied', async () => {
  await resetFiles();
  const fake = (createRequire(import.meta.url) as any)('vscode');
  const abs = path.join(root, 'calc.py');
  fake.window.activeTextEditor = {
    document: { uri: fake.Uri.file(abs), getText: () => '    return a - b', lineAt: () => ({ range: {} }) },
    selection: { isEmpty: false, start: { line: 5 }, end: { line: 5 }, active: { line: 5 } },
  };
  env.inputBoxAnswer = 'add a docstring';
  mock.setScript(c => (c.turn === 0 ? { toolCalls: [{ name: c.find('propose_edit'), args: { path: 'calc.py', edits: [{ old_text: '    return a - b', new_text: '    """Subtract."""\n    return a - b' }] } }] } : { text: 'ok' }));
  await env.commands.get('trueforgeCoder.inlineEdit')!();
  assert.match(await fs.readFile(abs, 'utf8'), /"""Subtract\."""/);
});

test('Stop mid-run after one approved file: the run is all-or-nothing and the file is reverted', async () => {
  await resetFiles();
  mock.setScript(c => {
    if (c.turn === 0) return { toolCalls: [{ name: c.find('propose_edit'), args: { path: 'calc.py', edits: [{ old_text: '    return a + b', new_text: '    """Add."""\n    return a + b' }] } }] };
    return { text: 'continuing ', hang: true };
  });
  const reviewsBefore = qa('.review').length;
  const logBefore = logText().length;
  submit('two-step task');
  const review = await waitFor(() => qa('.review').length > reviewsBefore && qa('.review:not(.done)')[0], 'new review card');
  review.querySelector('button.primary').click();
  await waitFor(() => /Applied 1\/1 hunk/.test(logText().slice(logBefore)), 'first file applied');
  assert.match(await fs.readFile(path.join(root, 'calc.py'), 'utf8'), /"""Add\."""/);
  await waitFor(() => !q('#stop').hidden, 'still running');
  await sleep(1500);
  q('#stop').click();
  await idle();
  assert.match(logText(), /all-or-nothing/);
  assert.equal(await fs.readFile(path.join(root, 'calc.py'), 'utf8'), FILE);
});

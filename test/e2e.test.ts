import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
// @ts-ignore plain ESM helper shared with the setup script
import { putProvider, putMcpServer } from '../scripts/setup-lib.mjs';
import { startMockLlm, type MockLlm } from './mockLlm';
import { fsHost } from './fsHost';
import { CodeIndex } from '../src/core/retrieval';
import { ApprovalLedger } from '../src/core/ledger';
import { EditorTools } from '../src/core/editorTools';
import { startEditorMcpServer, type RunningMcp } from '../src/core/mcpServer';
import { ForgeRunner, specFromManifest, type RunnerHooks, type ToolCallInfo } from '../src/core/runner';
import { decideApproval, type ReviewUi } from '../src/core/review';

const TF = process.env.TRUEFORGE_URL ?? 'http://localhost:8790';
const manifest = JSON.parse(readFileSync(new URL('../agent/forge-agent.json', import.meta.url), 'utf8')).manifest;

const FILE_A = ['def add(a, b):', '    return a + b', '', '', 'def sub(a, b):', '    return a - b', '', '', 'def mul(a, b):', '    return a * b', ''].join('\n');

let mock: MockLlm;
let mcp: RunningMcp;
let root: string;
let tools: EditorTools;
let ledger: ApprovalLedger;
let resets = 0;

async function resetFiles() {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'calc.py'), FILE_A);
  await fs.writeFile(path.join(root, 'tests/test_calc.py'), 'from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n');
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tfc-e2e-'));
  await resetFiles();
  mock = await startMockLlm(9911);
  ledger = new ApprovalLedger();
  const index = new CodeIndex(root);
  await index.build();
  tools = new EditorTools(fsHost(root), index, ledger, { budgetTokens: 3000 });
  mcp = await startEditorMcpServer(tools, 8791);
  await putProvider(TF, { name: 'mock', base_url: 'http://127.0.0.1:9911/v1', api_key: 'test-key-not-real', models: [{ name: 'mock-model', model_id: 'mock-model' }] });
  await putProvider(TF, { name: 'bad', base_url: 'http://127.0.0.1:9911/bad/v1', api_key: 'test-key-not-real', models: [{ name: 'mock-model', model_id: 'mock-model' }] });
  await putProvider(TF, { name: 'auth', base_url: 'http://127.0.0.1:9911/auth/v1', api_key: 'test-key-not-real', models: [{ name: 'mock-model', model_id: 'mock-model' }] });
  await putMcpServer(TF, { name: 'vscode-editor', url: mcp.url });
});

after(async () => {
  await mcp?.close();
  await mock?.close();
  await fs.rm(root, { recursive: true, force: true });
});

function hooks(ui: ReviewUi, log: string[], signalRef: { s?: AbortSignal } = {}): RunnerHooks {
  return {
    status: m => log.push(`status:${m}`),
    textDelta: () => {},
    toolCall: (i: ToolCallInfo) => log.push(`call:${i.name}`),
    toolResult: (_id, c) => log.push(`result:${c.slice(0, 80).replace(/\n/g, ' ')}`),
    approve: (info, signal) => decideApproval(tools, info, ui, signal),
    modelFailure: i => log.push(`failure:${i.model}->${i.next ?? 'none'}`),
    resetWorkspace: async () => {
      resets++;
      await resetFiles();
    },
  };
}

const runner = (models: string[], retries = 0) => new ForgeRunner({ baseUrl: TF, models, retries, backoffMs: 50, spec: m => specFromManifest(manifest, m) });

test('agent reads, proposes a 2-hunk edit + a new file; user accepts 1 hunk; only that lands', async () => {
  await resetFiles();
  mock.setScript(ctx => {
    if (ctx.turn === 0) return { text: 'Plan: read calc.py, edit it, add a test.', toolCalls: [{ name: ctx.find('read_file'), args: { path: 'calc.py' } }] };
    if (ctx.turn === 1)
      return {
        toolCalls: [
          {
            name: ctx.find('propose_edit'),
            args: { path: 'calc.py', edits: [{ old_text: '    return a + b', new_text: '    """Add two numbers."""\n    return a + b' }, { old_text: '    return a * b', new_text: '    """Multiply two numbers."""\n    return a * b' }] },
          },
        ],
      };
    if (ctx.turn === 2) return { toolCalls: [{ name: ctx.find('write_new_file'), args: { path: 'tests/test_mul.py', content: 'from calc import mul\n\n\ndef test_mul():\n    assert mul(2, 3) == 6\n' } }] };
    return { text: 'Done.' };
  });
  const seen: { rel: string; hunks: number }[] = [];
  const ui: ReviewUi = {
    async reviewChange({ rel, isNew, set }) {
      seen.push({ rel, hunks: set.hunks.length });
      // accept only the first hunk of the edit; accept the new file entirely
      return { accepted: new Set(isNew ? set.hunks.map(h => h.id) : [set.hunks[0].id]) };
    },
    confirmCommand: async () => false,
  };
  const log: string[] = [];
  const out = await runner(['mock/mock-model']).run('Add docstrings to add and mul, and a test for mul.', hooks(ui, log));
  assert.equal(out.status, 'done', JSON.stringify(out) + '\n' + log.join('\n'));
  const calc = await fs.readFile(path.join(root, 'calc.py'), 'utf8');
  assert.match(calc, /Add two numbers/);
  assert.doesNotMatch(calc, /Multiply two numbers/);
  assert.equal(await fs.readFile(path.join(root, 'tests/test_mul.py'), 'utf8'), 'from calc import mul\n\n\ndef test_mul():\n    assert mul(2, 3) == 6\n');
  assert.deepEqual(seen, [{ rel: 'calc.py', hunks: 2 }, { rel: 'tests/test_mul.py', hunks: 1 }]);
  assert.ok(log.some(l => l.startsWith('result:Applied 1/2')), log.join('\n'));
});

test('rejecting every hunk leaves the workspace untouched and the model is told', async () => {
  await resetFiles();
  const before = await fs.readFile(path.join(root, 'calc.py'), 'utf8');
  mock.setScript(ctx => {
    if (ctx.turn === 0) return { toolCalls: [{ name: ctx.find('propose_edit'), args: { path: 'calc.py', edits: [{ old_text: '    return a - b', new_text: '    return b - a' }] } }] };
    return { text: 'Understood, leaving it.' };
  });
  const ui: ReviewUi = { reviewChange: async () => ({ accepted: new Set() }), confirmCommand: async () => false };
  const log: string[] = [];
  const out = await runner(['mock/mock-model']).run('Swap sub operands', hooks(ui, log));
  assert.equal(out.status, 'done', JSON.stringify(out));
  assert.equal(await fs.readFile(path.join(root, 'calc.py'), 'utf8'), before);
  assert.ok(log.some(l => /rejected every hunk|denied|Nothing was written/i.test(l)), log.join('\n'));
});

test('a write tool call without a user grant is refused by the editor itself (defense in depth)', async () => {
  await resetFiles();
  const before = await fs.readFile(path.join(root, 'calc.py'), 'utf8');
  const res = await tools.applyApproved('propose_edit', { path: 'calc.py', edits: [{ old_text: 'a + b', new_text: 'a - b' }] } as any);
  assert.match(res, /^REFUSED/);
  assert.equal(await fs.readFile(path.join(root, 'calc.py'), 'utf8'), before);
});

test('cancel stops a running turn and the runner reports cancelled', async () => {
  await resetFiles();
  mock.setScript(() => ({ text: 'Thinking out loud ', hang: true }));
  const ui: ReviewUi = { reviewChange: async () => ({ accepted: new Set() }), confirmCommand: async () => false };
  const r = runner(['mock/mock-model']);
  const log: string[] = [];
  const p = r.run('long task', hooks(ui, log));
  await new Promise(res => setTimeout(res, 2500));
  const t0 = Date.now();
  await r.cancel();
  const out = await p;
  assert.equal(out.status, 'cancelled', JSON.stringify(out));
  assert.ok(Date.now() - t0 < 8000, 'cancel should be prompt');
});

test('automatic fallback: failing first model is rolled back and the second model completes the task', async () => {
  await resetFiles();
  resets = 0;
  mock.setScript(ctx => {
    if (ctx.turn === 0) return { toolCalls: [{ name: ctx.find('propose_edit'), args: { path: 'calc.py', edits: [{ old_text: '    return a - b', new_text: '    """Subtract."""\n    return a - b' }] } }] };
    return { text: 'Done via fallback.' };
  });
  const ui: ReviewUi = { reviewChange: async ({ set }) => ({ accepted: new Set(set.hunks.map(h => h.id)) }), confirmCommand: async () => false };
  const log: string[] = [];
  const out = await runner(['bad/mock-model', 'mock/mock-model'], 0).run('Document sub', hooks(ui, log));
  assert.equal(out.status, 'done', JSON.stringify(out) + '\n' + log.join('\n'));
  assert.equal((out as any).model, 'mock/mock-model');
  assert.ok(resets >= 1, 'workspace reset before fallback');
  assert.ok(log.some(l => l.startsWith('failure:bad/mock-model->mock/mock-model')), log.join('\n'));
  assert.match(await fs.readFile(path.join(root, 'calc.py'), 'utf8'), /Subtract/);
});

test('transient failure is retried with back-off before falling back; invalid key falls back immediately', async () => {
  await resetFiles();
  mock.setScript(() => ({ text: 'ok' }));
  const ui: ReviewUi = { reviewChange: async () => ({ accepted: new Set() }), confirmCommand: async () => false };
  const log1: string[] = [];
  const out1 = await runner(['bad/mock-model', 'mock/mock-model'], 1).run('hi', hooks(ui, log1));
  assert.equal(out1.status, 'done');
  assert.equal(log1.filter(l => l.startsWith('failure:bad/mock-model')).length, 2, '503 is attempted twice (1 retry)');
  const log2: string[] = [];
  const out2 = await runner(['auth/mock-model', 'mock/mock-model'], 1).run('hi', hooks(ui, log2));
  assert.equal(out2.status, 'done');
  assert.equal(log2.filter(l => l.startsWith('failure:auth/mock-model')).length, 1, '401 is not retried');
  const log3: string[] = [];
  const out3 = await runner(['auth/mock-model'], 1).run('hi', hooks(ui, log3));
  assert.equal(out3.status, 'failed');
  assert.match((out3 as any).error, /401|Unauthorized|invalid API key/i);
});

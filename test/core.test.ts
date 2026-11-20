import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeHunks, composeContent } from '../src/core/hunks';
import { planEdits } from '../src/core/editPlanner';
import { ApprovalLedger } from '../src/core/ledger';
import { Checkpoints } from '../src/core/checkpoints';
import { CodeIndex } from '../src/core/retrieval';
import { buildContextPack, findMentions } from '../src/core/context';
import { EditorTools } from '../src/core/editorTools';
import { fsHost } from './fsHost';
import { pickModels } from '../src/core/nvidiaModels';

const SRC = ['def a():', '    return 1', '', '', 'def b():', '    return 2', '', '', 'def c():', '    return 3', ''].join('\n');

test('hunks: independent hunks compose back to original / proposed / mixes', () => {
  const proposed = SRC.replace('return 1', 'return 10').replace('return 3', 'return 30');
  const set = computeHunks(SRC, proposed);
  assert.equal(set.hunks.length, 2);
  assert.equal(composeContent(set, new Set()), SRC);
  assert.equal(composeContent(set, new Set([0, 1])), proposed);
  assert.equal(composeContent(set, new Set([1])), SRC.replace('return 3', 'return 30'));
});

test('planner: exact-once matching with helpful errors', () => {
  assert.equal((planEdits(SRC, [{ old_text: 'return 2', new_text: 'return 20' }]) as any).proposed, SRC.replace('return 2', 'return 20'));
  const missing = planEdits(SRC, [{ old_text: 'return 99', new_text: 'x' }]);
  assert.equal(missing.ok, false);
  const ambiguous = planEdits(SRC, [{ old_text: 'return', new_text: 'x' }]);
  assert.equal(ambiguous.ok, false);
});

test('ledger: grants are one-shot and bound to the exact call', () => {
  const l = new ApprovalLedger();
  const args = { path: 'a.py', edits: [{ old_text: 'x', new_text: 'y' }] };
  l.grant('propose_edit', args, { kind: 'write', path: '/a.py', content: 'y', base: 'x', accepted: 1, total: 1, rejected: [] });
  assert.equal(l.consume('write_new_file', args), undefined);
  assert.ok(l.consume('propose_edit', args));
  assert.equal(l.consume('propose_edit', args), undefined, 'second use refused');
});

test('checkpoints: undo restores edited files and deletes created ones; rollbackCurrent clears the run', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tfc-cp-'));
  const host = { ...fsHost(root), remove: (abs: string) => fs.rm(abs, { force: true }) };
  const cp = new Checkpoints(host);
  await fs.writeFile(path.join(root, 'x.py'), 'one');
  cp.begin('run 1');
  await host.writeText(path.join(root, 'x.py'), 'two'); cp.record(path.join(root, 'x.py'), 'one', 'two');
  await host.writeText(path.join(root, 'y.py'), 'new'); cp.record(path.join(root, 'y.py'), undefined, 'new');
  cp.end();
  assert.equal(cp.canUndo, true);
  await cp.undoLast();
  assert.equal(await fs.readFile(path.join(root, 'x.py'), 'utf8'), 'one');
  await assert.rejects(fs.stat(path.join(root, 'y.py')));
  cp.begin('run 2');
  await host.writeText(path.join(root, 'x.py'), 'three'); cp.record(path.join(root, 'x.py'), 'one', 'three');
  await cp.rollbackCurrent();
  assert.equal(await fs.readFile(path.join(root, 'x.py'), 'utf8'), 'one');
  assert.equal(cp.end(), undefined, 'rolled-back run is not kept for undo');
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tfc-ctx-'));
  await fs.mkdir(path.join(root, 'src/pkg'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/pkg/helpers.py'), 'import os\n\n\ndef get_debug_flag():\n    """Is debug on."""\n    val = os.environ.get("DEBUG")\n    return val.lower() not in {"0", "false"}\n\n\ndef unrelated_thing():\n    return 42\n');
  await fs.writeFile(path.join(root, 'src/pkg/cli.py'), 'def routes_command():\n    """Show routes."""\n    pass\n\n\ndef main():\n    return routes_command()\n');
  await fs.writeFile(path.join(root, 'tests/test_helpers.py'), 'from pkg.helpers import get_debug_flag\n\n\ndef test_flag():\n    assert get_debug_flag() in (True, False)\n');
  const index = new CodeIndex(root);
  await index.build();
  return { root, index };
}

test('mentions: @file and @symbol are resolved; punctuation is stripped', async () => {
  assert.deepEqual(findMentions('look at @src/pkg/cli.py, and @get_debug_flag. Email a@b.com'), ['src/pkg/cli.py', 'get_debug_flag']);
  const { root, index } = await fixture();
  const pack = await buildContextPack({ root, index, userText: 'explain @get_debug_flag and @src/pkg/cli.py', budgetTokens: 3000 });
  const labels = pack.entries.filter(e => e.kind === 'mention').map(e => e.label);
  assert.ok(labels.some(l => l.includes('src/pkg/helpers.py') && l.includes('get_debug_flag')), labels.join('|'));
  assert.ok(labels.includes('src/pkg/cli.py'));
  assert.ok(pack.usedTokens <= 3000);
});

test('retrieval: unmentioned relevant code is found, stays within budget, and explains itself', async () => {
  const { root, index } = await fixture();
  const pack = await buildContextPack({ root, index, userText: 'make get_debug_flag also treat "off" as false', budgetTokens: 1200 });
  const retrieved = pack.entries.filter(e => e.kind === 'retrieved');
  assert.ok(retrieved.length > 0);
  assert.ok(retrieved.some(e => e.label.includes('helpers.py')), JSON.stringify(retrieved));
  assert.ok(retrieved.every(e => e.reason.length > 0));
  assert.ok(pack.usedTokens <= pack.budgetTokens);
});

test('editor tools: path escape and .git writes are refused', async () => {
  const { root, index } = await fixture();
  const tools = new EditorTools(fsHost(root), index, new ApprovalLedger());
  const esc = await tools.prepareEdit({ path: '../outside.py', edits: [{ old_text: 'a', new_text: 'b' }] });
  assert.equal(esc.ok, false);
  const git = await tools.prepareNewFile({ path: '.git/hooks/pre-commit', content: 'x' });
  assert.equal(git.ok, false);
});

test('nvidia model picker: registers only what the key can see, best first', () => {
  const r = pickModels(['meta/llama-3.3-70b-instruct', 'nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'some/other']);
  assert.deepEqual(r.chain, ['nvidia/nemotron-3-5-lightning', 'nvidia/nemotron-3-ultra', 'nvidia/llama-3-3-70b']);
  assert.deepEqual(pickModels(['x/y']).chain, []);
});

test('stale-write guard: an approved edit is refused if the file changed after review', async () => {
  const { root, index } = await fixture();
  const ledger = new ApprovalLedger();
  const tools = new EditorTools(fsHost(root), index, ledger);
  const args = { path: 'src/pkg/cli.py', edits: [{ old_text: 'return routes_command()', new_text: 'return routes_command() or 0' }] };
  const prepared = await tools.prepareEdit(args);
  assert.ok(prepared.ok);
  if (!prepared.ok) return;
  ledger.grant('propose_edit', args, { kind: 'write', path: prepared.abs, content: composeContent(prepared.set, new Set([0])), base: prepared.set.original, accepted: 1, total: 1, rejected: [] });
  await fs.appendFile(prepared.abs, '# someone else edited\n');
  const res = await tools.applyApproved('propose_edit', args as any);
  assert.match(res, /^REFUSED: the file changed/);
  assert.doesNotMatch(await fs.readFile(prepared.abs, 'utf8'), /or 0/);
});

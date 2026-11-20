/**
 * "Golden run" on the REAL Flask 3.1.3 repo with a scripted model: proves that retrieval, MCP tools, the approval flow,
 * run_command and the real verification commands work together on the actual demo repository.
 * Needs: FLASK_DIR (default /tmp/prep-test/flask-demo, prepared by demo/prepare-flask.sh) and a running TrueForge.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
// @ts-ignore plain ESM helper
import { putProvider, putMcpServer } from '../scripts/setup-lib.mjs';
import { startMockLlm, type MockLlm } from './mockLlm';
import { fsHost } from './fsHost';
import { CodeIndex } from '../src/core/retrieval';
import { ApprovalLedger } from '../src/core/ledger';
import { EditorTools } from '../src/core/editorTools';
import { startEditorMcpServer, type RunningMcp } from '../src/core/mcpServer';
import { ForgeRunner, specFromManifest } from '../src/core/runner';
import { decideApproval, type ReviewUi } from '../src/core/review';
import { buildContextPack } from '../src/core/context';

const TF = process.env.TRUEFORGE_URL ?? 'http://localhost:8790';
const FLASK = process.env.FLASK_DIR ?? '/tmp/prep-test/flask-demo';
const here = path.resolve(new URL('..', import.meta.url).pathname);
const skip = !existsSync(path.join(FLASK, '.venv')) ? 'FLASK_DIR not prepared (run demo/prepare-flask.sh)' : false;
const manifest = JSON.parse(readFileSync(path.join(here, 'agent/forge-agent.json'), 'utf8')).manifest;
const inlineManifest = JSON.parse(readFileSync(path.join(here, 'agent/forge-agent-inline.json'), 'utf8')).manifest;

const TASK_A = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const TASK_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

let mock: MockLlm, mcp: RunningMcp, tools: EditorTools, ledger: ApprovalLedger;
const sh = (cmd: string, cwd = FLASK) => execSync(cmd, { cwd, encoding: 'utf8', shell: '/bin/bash', stdio: ['ignore', 'pipe', 'pipe'] });
const resetRepo = () => sh('git checkout -q -- . && git clean -fdq -e .venv');

before(async () => {
  if (skip) return;
  resetRepo();
  mock = await startMockLlm(9911);
  ledger = new ApprovalLedger();
  const index = new CodeIndex(FLASK);
  await index.build();
  tools = new EditorTools(fsHost(FLASK), index, ledger, { budgetTokens: 6000 });
  mcp = await startEditorMcpServer(tools, 8792);
  await putProvider(TF, { name: 'mock', base_url: 'http://127.0.0.1:9911/v1', api_key: 'test-key-not-real', models: [{ name: 'mock-model', model_id: 'mock-model' }] });
  await putMcpServer(TF, { name: 'vscode-editor', url: mcp.url });
});
after(async () => {
  if (skip) return;
  await mcp?.close();
  await mock?.close();
  resetRepo();
});

const acceptAll = (seen: string[]): ReviewUi => ({
  reviewChange: async ({ rel, set }) => { seen.push(`${rel}:${set.hunks.length}`); return { accepted: new Set(set.hunks.map(h => h.id)) }; },
  confirmCommand: async () => true,
});
const hooks = (ui: ReviewUi, log: string[]) => ({
  status: () => {}, textDelta: () => {}, toolCall: (i: any) => log.push(`call:${i.name.split('__').pop()}`), toolResult: (_: string, c: string) => log.push(`result:${c.slice(0, 100).replace(/\n/g, ' ')}`),
  approve: (info: any, signal: AbortSignal) => decideApproval(tools, info, ui, signal),
  modelFailure: () => {}, resetWorkspace: async () => {},
});

test('context pack for the exact Task B wording surfaces cli.py, test_cli.py and docs/cli.rst (no files mentioned)', { skip }, async () => {
  const pack = await buildContextPack({ root: FLASK, index: tools.index, userText: TASK_B, budgetTokens: 6000 });
  const files = new Set(pack.entries.map(e => e.label.split(':')[0]));
  console.log('Task B context pack:', pack.usedTokens, '/', pack.budgetTokens, [...files].join(', '));
  for (const f of ['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst']) assert.ok([...files].some(x => x === f), `missing ${f}; got ${[...files].join(', ')}`);
});

test('Task A (inline agent definition): edit get_debug_flag, review, verify FLASK_DEBUG=off -> False', { skip }, async () => {
  assert.equal(sh('. .venv/bin/activate && FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"').trim(), 'True', 'baseline: off is truthy before the edit');
  const sel = sh("sed -n '28,33p' src/flask/helpers.py");
  mock.setScript(c => {
    if (c.turn === 0) return { toolCalls: [{ name: c.find('propose_edit'), args: { path: 'src/flask/helpers.py', edits: [{
      old_text: '    """Get whether debug mode should be enabled for the app, indicated by the\n    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.\n    """\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no"})',
      new_text: '    """Get whether debug mode should be enabled for the app, indicated by the\n    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.\n\n    The values ``0``, ``false``, ``no``, ``off`` and ``n`` (case-insensitive)\n    are treated as false, as is an empty or unset variable. Any other value\n    enables debug mode.\n    """\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})',
    }] } }] };
    return { text: 'Updated.' };
  });
  const seen: string[] = [];
  const out = await new ForgeRunner({ baseUrl: TF, models: ['mock/mock-model'], retries: 0, spec: m => specFromManifest(inlineManifest, m) })
    .run(`Inline edit in src/flask/helpers.py, lines 28-33.\nInstruction: ${TASK_A}\n\nSelected code:\n\`\`\`\n${sel}\n\`\`\``, hooks(acceptAll(seen), []));
  assert.equal(out.status, 'done', JSON.stringify(out));
  assert.deepEqual(seen.length, 1);
  assert.equal(sh('. .venv/bin/activate && FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"').trim(), 'False');
  assert.equal(sh('. .venv/bin/activate && FLASK_DEBUG=OFF python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"').trim(), 'False');
  assert.equal(sh('. .venv/bin/activate && FLASK_DEBUG=1 python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"').trim(), 'True');
  resetRepo();
});

test('Task B (agent definition): 3 files edited, pytest run through approved run_command, flask config masks secrets', { skip }, async () => {
  resetRepo();
  const cmd = '. .venv/bin/activate && pytest tests/test_cli.py -q';
  mock.setScript(c => {
    switch (c.turn) {
      case 0: return { text: 'Plan: cli.py (command), tests/test_cli.py (test), docs/cli.rst (docs).', toolCalls: [{ name: c.find('find_relevant_code'), args: { query: 'flask CLI built-in commands routes_command FlaskGroup add_command tests docs' } }] };
      case 1: return { toolCalls: [{ name: c.find('propose_edit'), args: { path: 'src/flask/cli.py', edits: [
        { old_text: 'import inspect\nimport os', new_text: 'import inspect\nimport json\nimport os' },
        { old_text: '            self.add_command(routes_command)\n', new_text: '            self.add_command(routes_command)\n            self.add_command(config_command)\n' },
        { old_text: 'cli = FlaskGroup(', new_text: '_SENSITIVE_CONFIG_WORDS = ("SECRET", "PASSWORD", "TOKEN", "KEY")\n\n\n@click.command("config", short_help="Show the loaded application config as JSON.")\n@with_appcontext\ndef config_command() -> None:\n    """Print the loaded application\'s configuration as JSON. Values of keys\n    containing SECRET, PASSWORD, TOKEN or KEY are shown as ``***``.\n    """\n    data = {\n        key: "***" if any(w in str(key).upper() for w in _SENSITIVE_CONFIG_WORDS) else value\n        for key, value in current_app.config.items()\n    }\n    click.echo(json.dumps(data, indent=2, sort_keys=True, default=str))\n\n\ncli = FlaskGroup(' },
      ] } }] };
      case 2: return { toolCalls: [{ name: c.find('propose_edit'), args: { path: 'tests/test_cli.py', edits: [
        { old_text: 'import importlib.metadata\nimport os', new_text: 'import importlib.metadata\nimport json\nimport os' },
        { old_text: 'def test_run_exclude_patterns():', new_text: 'def test_config_command_masks_secrets(runner):\n    app = Flask(__name__)\n    app.config.update(\n        MY_SECRET="s3cr3t", DB_PASSWORD="pw", API_TOKEN="tok", STRIPE_KEY="sk", PAGE_SIZE=20\n    )\n    result = runner.invoke(FlaskGroup(create_app=lambda: app), ["config"])\n    assert result.exit_code == 0\n    data = json.loads(result.output)\n    for key in ("MY_SECRET", "DB_PASSWORD", "API_TOKEN", "STRIPE_KEY"):\n        assert data[key] == "***"\n    assert data["PAGE_SIZE"] == 20\n\n\ndef test_run_exclude_patterns():' },
      ] } }] };
      case 3: return { toolCalls: [{ name: c.find('propose_edit'), args: { path: 'docs/cli.rst', edits: [
        { old_text: 'Custom Commands\n---------------\n', new_text: 'Show the Configuration\n----------------------\n\nThe :func:`config <cli.config_command>` command prints the loaded\napplication\'s configuration as JSON. The values of any key containing\n``SECRET``, ``PASSWORD``, ``TOKEN`` or ``KEY`` are replaced with ``***``. ::\n\n    $ flask config\n\n\nCustom Commands\n---------------\n' },
      ] } }] };
      case 4: return { toolCalls: [{ name: c.find('run_command'), args: { command: cmd } }] };
      default: return { text: 'Added `flask config`, a test and docs; tests pass.' };
    }
  });
  const seen: string[] = [];
  const log: string[] = [];
  const out = await new ForgeRunner({ baseUrl: TF, models: ['mock/mock-model'], retries: 0, spec: m => specFromManifest(manifest, m) }).run(TASK_B, hooks(acceptAll(seen), log));
  assert.equal(out.status, 'done', JSON.stringify(out) + log.join('\n'));
  console.log('review cards:', seen.join(' | '));
  assert.equal(seen.length, 3, 'three files reviewed');
  assert.ok(log.some(l => /result:.*exit code 0/.test(l) || /passed/.test(l)), log.join('\n'));
  const changed = sh('git status --short | grep -v "^?? .venv" || true').split('\n').filter(Boolean).map(l => l.slice(3)).sort();
  assert.deepEqual(changed, ['docs/cli.rst', 'src/flask/cli.py', 'tests/test_cli.py']);
  assert.match(sh('. .venv/bin/activate && pytest tests/test_cli.py -q 2>&1 | tail -1'), /\d+ passed/);
  assert.match(sh('. .venv/bin/activate && flask --help'), /^\s+config\s+Show the loaded application config as JSON\./m);
  const json = JSON.parse(sh('. .venv/bin/activate && cd ' + path.join(here, 'demo/demoapp') + ' && flask --app app config'));
  assert.equal(json.SECRET_KEY, '***'); assert.equal(json.API_TOKEN, '***'); assert.equal(json.DB_PASSWORD, '***'); assert.equal(json.STRIPE_KEY, '***');
  assert.equal(json.PAGE_SIZE, 20); assert.equal(json.SITE_NAME, 'Demo');
});

#!/usr/bin/env node
// One-shot setup of a LOCAL TrueForge for TrueForge Coder.
//   NVIDIA_API_KEY=nvapi-... node scripts/setup-trueforge.mjs [--trueforge http://localhost:8790] [--broken] [--mcp-port 8791]
// What it does (all against your own TrueForge on localhost):
//   1. registers your NVIDIA build.nvidia.com models as an OpenAI-compatible provider named "nvidia"
//   2. registers the editor tool server (MCP) as the connector "vscode-editor"
//   3. saves the two agent definitions in agent/*.json as TrueForge agents
//   4. with --broken: also registers "nvidia-broken" (invalid key) to demonstrate Task C
// The API key is read from the environment only; it is sent to your local TrueForge and never printed or written to disk.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { api, putProvider, putMcpServer, putAgent, listNvidiaModels, pickModels, NVIDIA_BASE_URL } from './setup-lib.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const base = opt('--trueforge', 'http://localhost:8790');
const mcpPort = opt('--mcp-port', '8791');
const nvidiaUrl = opt('--nvidia-base-url', NVIDIA_BASE_URL);
const wantBroken = args.includes('--broken');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = f => JSON.parse(readFileSync(path.join(root, 'agent', f), 'utf8'));

const ok = m => console.log(`  ✓ ${m}`);
const warn = m => console.log(`  ! ${m}`);

console.log(`TrueForge Coder setup → ${base}`);
try {
  await api(base, 'GET', '/api/v1/settings/model-providers');
} catch (e) {
  console.error(`\nCannot reach TrueForge at ${base}: ${e.message}\nStart it first (Node >= 22.14):\n  OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest\n`);
  process.exit(1);
}
ok('TrueForge is reachable');

let chain = [];
const key = process.env.NVIDIA_API_KEY;
if (!key) {
  warn('NVIDIA_API_KEY is not set: skipping model registration. Add your key in TrueForge → Settings → Models (custom OpenAI-compatible provider named "nvidia", base URL ' + NVIDIA_BASE_URL + '), or run the VS Code command "TrueForge Coder: Set Up NVIDIA Models".');
} else {
  try {
    const ids = await listNvidiaModels(nvidiaUrl, key);
    const { models, chain: picked } = pickModels(ids);
    if (!models.length) throw new Error('your key cannot see any of the supported coding models (' + 'nemotron-3.5-lightning, nemotron-3-ultra, llama-3.3-70b, gpt-oss-120b, kimi-k2, deepseek-v3.1)');
    await putProvider(base, { name: 'nvidia', base_url: nvidiaUrl, api_key: key, models });
    chain = picked;
    ok(`registered provider "nvidia" with ${models.length} model(s): ${models.map(m => m.name).join(', ')}`);
    if (wantBroken) {
      await putProvider(base, { name: 'nvidia-broken', base_url: nvidiaUrl, api_key: 'invalid-key-for-resilience-demo', models: [models[0]] });
      ok(`registered "nvidia-broken/${models[0].name}" (deliberately invalid key) for the Task C demo`);
    }
  } catch (e) {
    console.error(`  ✗ NVIDIA setup failed: ${e.message}`);
    process.exitCode = 1;
  }
}

try {
  await putMcpServer(base, { name: 'vscode-editor', url: `http://127.0.0.1:${mcpPort}/mcp` });
  ok(`registered MCP connector "vscode-editor" → http://127.0.0.1:${mcpPort}/mcp (the extension serves it while VS Code is open)`);
} catch (e) {
  console.error(`  ✗ connector registration failed: ${e.message}`);
  process.exitCode = 1;
}

for (const f of chain.length ? ['forge-agent.json', 'forge-agent-inline.json'] : []) {
  try {
    const def = agent(f);
    if (chain[0]) def.manifest.model.name = chain[0];
    await putAgent(base, def);
    ok(`saved TrueForge agent "${def.name}" from agent/${f}`);
  } catch (e) {
    console.error(`  ✗ could not save agent ${f}: ${e.message}`);
    process.exitCode = 1;
  }
}

if (!chain.length) warn('Saved agents were skipped because no model is registered yet. Add the "nvidia" provider, then run this script again (the extension also works without saved agents: it sends the same definition inline).');
if (chain.length) console.log(`\nModel chain for VS Code (setting trueforgeCoder.models):\n  ${JSON.stringify(chain)}`);
console.log('\nNext: open the project folder in VS Code with the TrueForge Coder extension installed.');

// Shared by scripts/setup-trueforge.mjs (real setup) and the end-to-end tests.
// Talks to a running TrueForge over its HTTP API. Never logs or stores API keys.

export async function api(base, method, path, body) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const msg = json?.error?.message ?? text.slice(0, 300);
    throw new Error(`${method} ${path} -> ${res.status}: ${msg}`);
  }
  return json;
}

/** Register (or update) an OpenAI-compatible model provider inside TrueForge. */
export function putProvider(base, { name, base_url, api_key, models }) {
  return api(base, 'PUT', '/api/v1/settings/model-providers', {
    manifest: {
      type: 'custom',
      name,
      base_url,
      auth: { api_key },
      models: models.map(m => ({
        name: m.name,
        model_id: m.model_id,
        properties: { context_length: m.context_length ?? 131072, max_output_tokens: m.max_output_tokens ?? 4096 },
      })),
    },
  });
}

/** Register (or update) the editor's MCP server as a TrueForge connector. */
export function putMcpServer(base, { name, url, description }) {
  return api(base, 'PUT', '/api/v1/settings/mcp-servers', {
    manifest: { type: 'remote', name, url, description: description ?? 'TrueForge Coder editor tools (local VS Code extension)' },
  });
}

/** Create or replace a saved agent definition (name must match ^[a-z][a-z0-9-]{0,62}[a-z0-9]$). Idempotent. */
export async function putAgent(base, def) {
  const list = await api(base, 'GET', '/api/v1/agents');
  const existing = (list?.data ?? []).find(a => a.name === def.name);
  if (existing) return api(base, 'PUT', `/api/v1/agents/${existing.id}`, { description: def.description, manifest: def.manifest });
  return api(base, 'POST', '/api/v1/agents', def);
}

/** Ask NVIDIA which models this key can use. Used only by the setup script, key comes from the environment. */
export async function listNvidiaModels(baseUrl, apiKey) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`NVIDIA /models returned ${res.status}`);
  const j = await res.json();
  return (j.data ?? []).map(m => m.id);
}

export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

/** Models we are willing to register from NVIDIA's free build.nvidia.com catalog, best first (tool calling required).
 *  NVIDIA's own Nemotron models lead: Lightning (3B active, built for fast tool-calling loops) is the primary, Ultra (550B, strongest
 *  reasoning) the fallback, then a non-reasoning model as a safety net. */
export const PREFERRED = [
  { model_id: 'nvidia/nemotron-3.5-lightning-30b-a3b', name: 'nemotron-3-5-lightning', context_length: 1000000, max_output_tokens: 16384 },
  { model_id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'nemotron-3-ultra', context_length: 1000000, max_output_tokens: 16384 },
  { model_id: 'meta/llama-3.3-70b-instruct', name: 'llama-3-3-70b', context_length: 131072, max_output_tokens: 4096 },
  { model_id: 'openai/gpt-oss-120b', name: 'gpt-oss-120b', context_length: 131072, max_output_tokens: 8192 },
  { model_id: 'moonshotai/kimi-k2-instruct', name: 'kimi-k2', context_length: 131072, max_output_tokens: 8192 },
  { model_id: 'deepseek-ai/deepseek-v3.1', name: 'deepseek-v3-1', context_length: 131072, max_output_tokens: 8192 },
];

/** Given the model ids the key can actually see, choose what to register and the fallback chain (max 3). */
export function pickModels(available) {
  const have = new Set(available);
  const models = PREFERRED.filter(m => have.has(m.model_id));
  return { models, chain: models.slice(0, 3).map(m => `nvidia/${m.name}`) };
}

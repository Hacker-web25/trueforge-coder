import http from 'node:http';

/** A scripted OpenAI-compatible chat-completions server (streaming + non-streaming). Stands in for NVIDIA NIM in tests. */
export interface Ctx {
  toolNames: string[];
  toolResults: string[];
  lastUser: string;
  turn: number; // number of tool results seen so far in this conversation
  find(suffix: string): string; // resolve the model-visible name of an editor tool
}
export type Step = { text?: string; toolCalls?: { name: string; args: unknown }[]; delayMs?: number; hang?: boolean };
export type Script = (ctx: Ctx) => Step;

export interface MockLlm {
  port: number;
  requests: number;
  setScript(s: Script): void;
  close(): Promise<void>;
}

export async function startMockLlm(port: number): Promise<MockLlm> {
  let script: Script = () => ({ text: 'ok' });
  let count = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      count++;
      const url = req.url ?? '';
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: ['mock-model', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'meta/llama-3.3-70b-instruct'].map(id => ({ id })) }));
        return;
      }
      // "auth" provider: always 401, like an invalid API key.
      if (url.startsWith('/auth/')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized: invalid API key (mock)' } }));
        return;
      }
      // "bad" provider: always an upstream failure, like an expired key or an outage.
      if (url.startsWith('/bad/')) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream unavailable (mock outage)' } }));
        return;
      }
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        /* ignore */
      }
      const messages: any[] = body.messages ?? [];
      const tools: any[] = body.tools ?? [];
      const toolNames = tools.map(t => t.function?.name ?? t.name).filter(Boolean);
      const toolResults = messages.filter(m => m.role === 'tool').map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      const lastUser = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg?.content ?? '');
      const ctx: Ctx = {
        toolNames,
        toolResults,
        lastUser,
        turn: toolResults.length,
        find: suffix => {
          const hit = toolNames.find(n => n === suffix || n.endsWith(`__${suffix}`) || n.endsWith(`_${suffix}`) || n.endsWith(`.${suffix}`) || n.endsWith(suffix));
          if (!hit) throw new Error(`mock: tool ${suffix} not offered; offered=${toolNames.join(',')}`);
          return hit;
        },
      };
      let step: Step;
      try {
        step = script(ctx);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String((e as Error).message) } }));
        return;
      }
      const base = { id: `chatcmpl-${count}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model ?? 'mock-model' };
      const calls = (step.toolCalls ?? []).map((c, i) => ({ index: i, id: `call_${count}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: step.text ?? null, tool_calls: calls.length ? calls : undefined }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const run = async () => {
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        if (step.text) {
          const words = step.text.split(/(?<=\s)/);
          for (const w of words) {
            send({ ...base, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] });
            if (step.delayMs) await new Promise(r => setTimeout(r, step.delayMs));
          }
        }
        if (step.hang) {
          // keep streaming slowly so a cancel can land mid-run
          for (let i = 0; i < 600 && !res.destroyed; i++) {
            send({ ...base, choices: [{ index: 0, delta: { content: `tick${i} ` }, finish_reason: null }] });
            await new Promise(r => setTimeout(r, 200));
          }
        }
        if (calls.length) send({ ...base, choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] });
        send({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
        res.write('data: [DONE]\n\n');
        res.end();
      };
      run().catch(() => res.end());
    });
  });
  await new Promise<void>(r => server.listen(port, '127.0.0.1', r));
  return {
    port,
    get requests() {
      return count;
    },
    setScript(s) {
      script = s;
    },
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ToolCallInfo {
  id: string;
  name: string;
  server?: string;
  args: any;
  threadId: string;
}

export interface Decision {
  allow: boolean;
  reason?: string;
}

export interface RunnerHooks {
  status(message: string): void;
  textDelta(messageId: string, delta: string, threadId: string): void;
  toolCall(info: ToolCallInfo): void;
  toolResult(toolCallId: string, content: string): void;
  thread?(evt: { kind: 'created' | 'done'; threadId: string; title?: string; agent?: string }): void;
  /** TrueForge's context engineering at work: automatic compaction of a thread's context. */
  compaction?(evt: { kind: 'started' | 'finished'; threadId: string; durationMs?: number; inputTokens?: number }): void;
  /** The agent wants to run a gated tool. The editor shows the change; the user decides. */
  approve(info: ToolCallInfo, signal: AbortSignal): Promise<Decision>;
  modelFailure(info: { model: string; attempt: number; message: string; retrying: boolean; next?: string }): void;
  /** Called before a retry / fallback so edits applied by the failed attempt can be rolled back. */
  resetWorkspace(): Promise<void>;
}

export type RunOutcome =
  | { status: 'done'; model: string; sessionId: string; finalText: string }
  | { status: 'cancelled'; model?: string; sessionId?: string }
  | { status: 'failed'; error: string };

export interface RunnerOptions {
  baseUrl: string;
  /** Builds the TrueForge agent spec (camelCase SDK shape) for a given model name. */
  spec: (model: string) => any;
  /** Ordered model chain: provider/model names configured in TrueForge. */
  models: string[];
  retries: number;
  backoffMs?: number;
}

class ModelFailure extends Error {}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>(resolve => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Drives one TrueForge agent run from the editor:
 *  - creates a session with an inline agent spec (model + MCP-exposed editor tools),
 *  - streams turn events (text deltas, tool calls, results, subagent threads),
 *  - pauses on tool.approval_required, asks the editor/user, resumes with user.tool_approval,
 *  - cancels through sessions.cancel,
 *  - on model failure: retries with exponential backoff, then falls back to the next configured model.
 * The extension never calls a model provider; every model call goes through TrueForge.
 */
export class ForgeRunner {
  private client: TrueForge;
  private sessionId?: string;
  private abort = new AbortController();
  private cancelled = false;

  constructor(private opts: RunnerOptions) {
    this.client = new TrueForge({ baseUrl: opts.baseUrl, timeoutInSeconds: 600 });
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.abort.abort();
    if (this.sessionId) {
      try {
        await this.client.sessions.cancel(this.sessionId);
      } catch {
        /* already finished */
      }
    }
  }

  async run(userText: string, hooks: RunnerHooks): Promise<RunOutcome> {
    this.cancelled = false;
    this.abort = new AbortController();
    let lastError = 'unknown error';
    const models = this.opts.models;
    for (let m = 0; m < models.length; m++) {
      const model = models[m];
      for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
        if (this.cancelled) return { status: 'cancelled' };
        try {
          hooks.status(`Running on TrueForge with ${model}${attempt ? ` (retry ${attempt})` : ''}…`);
          const out = await this.runOnce(model, userText, hooks);
          if (out.status === 'cancelled' || this.cancelled) return { status: 'cancelled', model, sessionId: this.sessionId };
          return out;
        } catch (e) {
          if (this.cancelled) return { status: 'cancelled', model, sessionId: this.sessionId };
          lastError = (e as Error).message || String(e);
          // A bad key or a forbidden model will not fix itself: skip the retries and go straight to the next model.
          const permanent = /\b(401|403|unauthori[sz]ed|forbidden|invalid[ _-]?api[ _-]?key|authentication)\b/i.test(lastError);
          const retrying = attempt < this.opts.retries && !permanent;
          const next = retrying ? model : models[m + 1];
          hooks.modelFailure({ model, attempt: attempt + 1, message: lastError, retrying, next });
          await hooks.resetWorkspace();
          if (!retrying) break;
          await sleep((this.opts.backoffMs ?? 1000) * 2 ** attempt, this.abort.signal);
        }
      }
    }
    return { status: 'failed', error: lastError };
  }

  private async runOnce(model: string, userText: string, hooks: RunnerHooks): Promise<RunOutcome> {
    let session;
    try {
      ({ data: session } = await this.client.sessions.create({ agent: { spec: this.opts.spec(model) } }));
    } catch (e) {
      throw new ModelFailure(`Could not open a TrueForge session for ${model}: ${(e as Error).message}`);
    }
    this.sessionId = session.id;
    if (this.cancelled) return { status: 'cancelled' };

    const events = new Map<string, any>();
    const announced = new Set<string>();
    let turnId: string | undefined;
    let lastEventId: string | undefined;
    let finalText = '';

    const announceCalls = (msg: any) => {
      for (const tc of msg.toolCalls ?? []) {
        if (!tc?.id || announced.has(tc.id)) continue;
        let args: any = {};
        try {
          args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          continue; // arguments still streaming
        }
        announced.add(tc.id);
        hooks.toolCall({ id: tc.id, name: tc.toolInfo?.name ?? tc.function?.name ?? 'tool', server: tc.toolInfo?.serverName, args, threadId: msg.threadId });
      }
    };

    let stream: AsyncIterable<any> = await this.client.sessions.createTurnStream(session.id, { input: [{ type: 'user.message', content: userText }] });

    for (let guard = 0; guard < 200; guard++) {
      const pending: any[] = [];
      let done: any;
      let paused = false;
      for await (const ev of stream) {
        lastEventId = ev.id;
        if (isEventDelta(ev)) {
          const base = events.get(ev.id);
          if (base) {
            mergeEventDelta(base, ev);
            if (ev.content) hooks.textDelta(ev.id, ev.content, ev.threadId);
            if (ev.finishReason) announceCalls(base);
          }
          continue;
        }
        events.set(ev.id, ev);
        switch (ev.type) {
          case 'turn.created':
            turnId = ev.turnId;
            break;
          case 'model.message':
            if (typeof ev.content === 'string' && ev.content) hooks.textDelta(ev.id, ev.content, ev.threadId);
            if (ev.finishReason) announceCalls(ev);
            break;
          case 'tool.response':
            hooks.toolResult(ev.toolCallId, ev.content);
            break;
          case 'tool.approval_required':
            pending.push(ev);
            break;
          case 'thread.created':
            hooks.thread?.({ kind: 'created', threadId: ev.threadId, title: ev.title, agent: ev.agentInfo?.name });
            break;
          case 'thread.context_compaction_started':
            hooks.compaction?.({ kind: 'started', threadId: ev.threadId });
            break;
          case 'thread.context_compaction_finished':
            hooks.compaction?.({ kind: 'finished', threadId: ev.threadId, durationMs: ev.durationMs, inputTokens: ev.usage?.inputTokens ?? ev.usage?.promptTokens });
            break;
          case 'thread.done':
            hooks.thread?.({ kind: 'done', threadId: ev.threadId });
            break;
          case 'turn.update':
            if (ev.state?.status === 'paused') paused = true;
            break;
          case 'turn.done':
            done = ev;
            break;
        }
        if (paused || done) break;
      }

      if (done) {
        const st = done.state;
        if (st.status === 'cancelled') return { status: 'cancelled', model, sessionId: session.id };
        if (st.status === 'error') throw new ModelFailure(st.message || 'The model call failed.');
        const out = st.output;
        finalText = typeof out?.content === 'string' ? out.content : finalText;
        return { status: 'done', model, sessionId: session.id, finalText };
      }

      if (!paused) {
        if (this.cancelled) return { status: 'cancelled', model, sessionId: session.id };
        // The connection dropped without a terminal event: resume from the last event id.
        if (!turnId) throw new ModelFailure('The TrueForge stream ended before the turn started.');
        stream = await this.client.sessions.subscribeToTurn(session.id, turnId, { afterEventId: lastEventId }, { timeoutInSeconds: 600 });
        continue;
      }

      // Paused: collect decisions for every pending gated call, one at a time.
      const answers: any[] = [];
      for (const p of pending) {
        for (const ref of p.toolCalls as { id: string; sourceEventId: string }[]) {
          const msg = events.get(ref.sourceEventId);
          const call = msg?.toolCalls?.find((t: any) => t.id === ref.id);
          let args: any = {};
          try {
            args = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            /* leave empty */
          }
          const info: ToolCallInfo = { id: ref.id, name: call?.toolInfo?.name ?? call?.function?.name ?? 'tool', server: call?.toolInfo?.serverName, args, threadId: p.threadId };
          let decision: Decision;
          try {
            decision = await hooks.approve(info, this.abort.signal);
          } catch {
            decision = { allow: false, reason: 'Cancelled by the user.' };
          }
          if (this.cancelled) return { status: 'cancelled', model, sessionId: session.id };
          answers.push({ type: 'user.tool_approval', threadId: p.threadId, toolCallId: ref.id, approval: decision.allow ? { status: 'allow' } : { status: 'deny', reason: decision.reason ?? 'Rejected by the user.' } });
        }
      }
      if (!turnId) throw new ModelFailure('Paused turn has no id.');
      // Subscribe first, then send answers, then read what they produce (the documented order).
      const resume = await this.client.sessions.subscribeToTurn(session.id, turnId, { afterEventId: lastEventId }, { timeoutInSeconds: 600 });
      await this.client.sessions.createTurnEvents(session.id, turnId, { events: answers });
      stream = resume;
    }
    throw new ModelFailure('Too many pause/resume cycles in one turn.');
  }
}

/** snake_case wire-format JSON (as in agent/*.json) -> camelCase shape the TypeScript SDK expects. */
export function camelize(value: any): any {
  if (Array.isArray(value)) return value.map(camelize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), camelize(v)]));
  }
  return value;
}

/** Build the SDK agent spec from a manifest JSON (as stored in agent/*.json) for a specific model. */
export function specFromManifest(manifest: any, model: string, extra?: { mcpServerName?: string }): any {
  const spec = camelize(manifest);
  spec.model = { ...spec.model, name: model };
  if (extra?.mcpServerName && Array.isArray(spec.mcpServers)) {
    spec.mcpServers = spec.mcpServers.map((s: any) => (s.name === 'vscode-editor' ? { ...s, name: extra.mcpServerName } : s));
  }
  return spec;
}

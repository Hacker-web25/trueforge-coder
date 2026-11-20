import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { EditorTools } from './editorTools';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const guard = async (fn: () => Promise<string> | string): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (e) {
    return fail((e as Error).message);
  }
};

/**
 * The editor exposed as MCP tools. TrueForge's agent — not this extension — decides which of these to call.
 * Tools that change the workspace (propose_edit, write_new_file, run_command) are gated TWICE: TrueForge pauses
 * the turn for approval, and the tool itself refuses to act unless the editor recorded the user's decision.
 */
export function buildEditorMcpServer(tools: EditorTools): McpServer {
  const server = new McpServer({ name: 'vscode-editor', version: '0.1.0' });

  server.registerTool(
    'find_relevant_code',
    {
      description:
        'Automatic code retrieval. Given a natural-language description of the task, returns the most relevant code snippets (ranked, with line numbers and the reason each was chosen) packed into a token budget. Use this FIRST when you do not know which files are involved.',
      inputSchema: { query: z.string().describe('What you are looking for / the task, in plain words or identifiers'), budget_tokens: z.number().int().positive().optional().describe('Token budget for the returned snippets (default 6000)') },
      annotations: { readOnlyHint: true },
    },
    async a => guard(() => tools.findRelevantCode(a)),
  );

  server.registerTool(
    'read_file',
    {
      description: 'Read a workspace file with line numbers. Long files are paged: pass start_line/end_line (max 400 lines per call).',
      inputSchema: { path: z.string().describe('Workspace-relative path'), start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional() },
      annotations: { readOnlyHint: true },
    },
    async a => guard(() => tools.readFile(a)),
  );

  server.registerTool(
    'list_dir',
    { description: 'List a workspace directory.', inputSchema: { path: z.string().optional().describe('Workspace-relative directory (default: root)') }, annotations: { readOnlyHint: true } },
    async a => guard(() => tools.listDir(a)),
  );

  server.registerTool(
    'search_code',
    {
      description: 'Regex search (case-insensitive) across workspace files. Returns file:line: text. Use it to find definitions, usages and tests of a symbol.',
      inputSchema: { pattern: z.string(), glob: z.string().optional().describe('Optional path glob such as "src/**/*.py" or "tests/*.py"'), max_results: z.number().int().positive().optional() },
      annotations: { readOnlyHint: true },
    },
    async a => guard(() => tools.searchCode(a)),
  );

  server.registerTool(
    'propose_edit',
    {
      description:
        'Propose changes to an EXISTING file as search/replace edits. Each old_text must match exactly one place in the file (copy it exactly from read_file, without the line-number prefix). The user reviews the diff hunk by hunk in the editor and may reject some hunks; the result tells you what was applied. Make all related changes to one file in a single call (several edits).',
      inputSchema: {
        path: z.string().describe('Workspace-relative path of an existing file'),
        edits: z.array(z.object({ old_text: z.string().describe('Exact existing text to replace (must be unique in the file)'), new_text: z.string().describe('Replacement text') })).min(1),
        summary: z.string().optional().describe('One line saying what this change does and why'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async a => guard(() => tools.applyApproved('propose_edit', a)),
  );

  server.registerTool(
    'write_new_file',
    {
      description: 'Create a NEW file (fails if it already exists). The user reviews the file in the editor before it is written.',
      inputSchema: { path: z.string(), content: z.string(), summary: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async a => guard(() => tools.applyApproved('write_new_file', a)),
  );

  server.registerTool(
    'run_command',
    {
      description: 'Run a shell command in the workspace root (for example the project\'s tests). The user must approve every command first. 120 second limit.',
      inputSchema: { command: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async a => guard(() => tools.runApproved(a)),
  );

  return server;
}

export interface RunningMcp {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Stateless Streamable-HTTP MCP endpoint on loopback only: one server+transport per request. */
export async function startEditorMcpServer(tools: EditorTools, port: number, log: (m: string) => void = () => {}): Promise<RunningMcp> {
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const server = buildEditorMcpServer(tools);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log(`MCP request failed: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => resolve());
  });
  const addr = httpServer.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  log(`Editor MCP server listening on http://127.0.0.1:${actual}/mcp`);
  return { url: `http://127.0.0.1:${actual}/mcp`, port: actual, close: () => new Promise(r => httpServer.close(() => r())) };
}

import * as vscode from 'vscode';
import * as path from 'node:path';
import { CodeIndex } from './core/retrieval';
import { ApprovalLedger } from './core/ledger';
import { EditorTools } from './core/editorTools';
import { startEditorMcpServer, type RunningMcp } from './core/mcpServer';
import { ForgeRunner, specFromManifest, type RunnerHooks, type ToolCallInfo } from './core/runner';
import { decideApproval, type ReviewUi } from './core/review';
import { Checkpoints } from './core/checkpoints';
import { buildContextPack } from './core/context';
import { NVIDIA_BASE_URL, pickModels } from './core/nvidiaModels';
import { vscodeHost } from './vscode/host';
import { DiffDocs, DIFF_SCHEME } from './vscode/diffDocs';
import { ChatView } from './vscode/chatView';
import { ChatReviewUi, QuickPickReviewUi } from './vscode/reviewUis';
// @ts-ignore plain ESM helper shared with scripts/setup-trueforge.mjs
import { putMcpServer, putProvider, listNvidiaModels } from '../scripts/setup-lib.mjs';
import agentManifest from '../agent/forge-agent.json';
import inlineManifest from '../agent/forge-agent-inline.json';

const MCP_NAME = 'vscode-editor';
const base = (n: string) => n.split(/__|\.|\//).pop() ?? n;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const out = vscode.window.createOutputChannel('TrueForge Coder');
  context.subscriptions.push(out);
  const log = (m: string) => out.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`);
  const cfg = () => vscode.workspace.getConfiguration('trueforgeCoder');

  const chat = new ChatView(context.extensionUri);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatView.viewType, chat, { webviewOptions: { retainContextWhenHidden: true } }));
  const diffs = new DiffDocs();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffs));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'trueforgeCoder.openChat';
  status.show();
  context.subscriptions.push(status);
  const setStatus = (text: string, tip?: string) => {
    status.text = `$(hubot) ${text}`;
    status.tooltip = tip ?? 'TrueForge Coder';
    chat.post({ type: 'status', text });
  };
  const chain = () => cfg().get<string[]>('models', ['nvidia/nemotron-3-5-lightning', 'nvidia/nemotron-3-ultra']);
  setStatus(`TrueForge: ${chain()[0]?.split('/').pop() ?? 'no model'}`, 'Model chain: ' + chain().join(' → '));

  const folder = vscode.workspace.workspaceFolders?.[0];
  const needFolder = () => void vscode.window.showWarningMessage('TrueForge Coder: open a folder first (File → Open Folder).');
  const open = (id: string, fn: (...a: any[]) => any) => context.subscriptions.push(vscode.commands.registerCommand(id, folder ? fn : needFolder));

  const baseUrl = () => cfg().get<string>('baseUrl', 'http://localhost:8790').replace(/\/$/, '');
  const sessionUrl = (id?: string) => (id ? `${baseUrl()}/sessions/${id}` : baseUrl());

  context.subscriptions.push(
    vscode.commands.registerCommand('trueforgeCoder.openChat', () => chat.focus()),
    vscode.commands.registerCommand('trueforgeCoder.openTrueForge', () => vscode.env.openExternal(vscode.Uri.parse(baseUrl()))),
  );
  if (!folder) {
    context.subscriptions.push(vscode.commands.registerCommand('trueforgeCoder.inlineEdit', needFolder), vscode.commands.registerCommand('trueforgeCoder.cancel', needFolder), vscode.commands.registerCommand('trueforgeCoder.undoLastRun', needFolder));
    chat.onSend = needFolder;
    return;
  }
  const root = folder.uri.fsPath;

  // ---- core wiring -------------------------------------------------------------------------------------------
  const ledger = new ApprovalLedger();
  const index = new CodeIndex(root);
  const host = vscodeHost(
    root,
    (abs, before, after) => {
      checkpoints.record(abs, before, after);
      log(`wrote ${path.relative(root, abs)}`);
    },
    () => cfg().get<string>('commandPreamble', '').trim(),
  );
  const checkpoints = new Checkpoints(host);
  const tools = new EditorTools(host, index, ledger, { budgetTokens: cfg().get<number>('contextBudgetTokens', 6000) });
  let reindexTimer: NodeJS.Timeout | undefined;
  const reindex = () => {
    clearTimeout(reindexTimer);
    reindexTimer = setTimeout(() => void index.build().then(() => log(`index: ${index.fileCount} files`)).catch(e => log(`index error: ${e}`)), 400);
  };
  void index.build().then(() => log('index ready'));
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidChange(reindex);
  watcher.onDidCreate(reindex);
  watcher.onDidDelete(reindex);
  context.subscriptions.push(watcher);

  let mcp: RunningMcp | undefined;
  let mcpError: string | undefined;
  try {
    const first = cfg().get<number>('mcpPort', 8791);
    for (let p = first; p < first + 6 && !mcp; p++) {
      try {
        mcp = await startEditorMcpServer(tools, p, log);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      }
    }
    if (!mcp) throw new Error(`ports ${first}-${first + 5} are all in use`);
    log(`editor MCP server at ${mcp.url}`);
  } catch (e) {
    mcpError = String((e as Error).message ?? e);
    log(`could not start editor MCP server: ${mcpError}`);
  }
  context.subscriptions.push({ dispose: () => void mcp?.close() });

  async function ensureConnected(): Promise<string | undefined> {
    if (!mcp) return `The editor tool server could not start (${mcpError}). Change trueforgeCoder.mcpPort and reload the window.`;
    try {
      await putMcpServer(baseUrl(), { name: MCP_NAME, url: mcp.url });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
        return `TrueForge is not reachable at ${baseUrl()}. Start it with:\n  OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest\n(the allow-list lets TrueForge call this editor's local tool server).`;
      }
      return `Could not register the editor tools in TrueForge: ${msg}`;
    }
    return undefined;
  }

  let allowAllCommands = false; // set by the "Allow all commands this session" button; forgotten when VS Code restarts
  async function confirmCommand(command: string): Promise<boolean> {
    if (allowAllCommands || cfg().get<boolean>('autoApproveCommands', false)) return true;
    const pick = await vscode.window.showWarningMessage(
      `TrueForge Coder wants to run a command in your workspace:\n\n${command}`,
      { modal: true },
      'Run command',
      'Allow all commands this session',
    );
    if (pick === 'Allow all commands this session') allowAllCommands = true;
    return pick === 'Run command' || pick === 'Allow all commands this session';
  }
  const chatUi: ReviewUi = new ChatReviewUi(chat, diffs, confirmCommand);
  const inlineUi: ReviewUi = new QuickPickReviewUi(diffs, confirmCommand);

  // ---- run orchestration -------------------------------------------------------------------------------------
  let busy = false;
  let runner: ForgeRunner | undefined;
  let lastSession: string | undefined;

  const refreshUndo = () => chat.post({ type: 'undoState', can: checkpoints.canUndo, label: checkpoints.lastLabel });

  async function run(userText: string, mode: 'agent' | 'inline', progress?: vscode.Progress<{ message?: string }>, token?: vscode.CancellationToken): Promise<void> {
    if (busy) {
      void vscode.window.showInformationMessage('TrueForge Coder is already working on a task. Stop it first.');
      return;
    }
    busy = true;
    chat.post({ type: 'busy', value: true });
    const ui = mode === 'inline' ? inlineUi : chatUi;
    try {
      if (mode === 'agent') chat.post({ type: 'user', text: userText });
      const problem = await ensureConnected();
      if (problem) {
        chat.post({ type: 'notice', level: 'error', text: problem });
        void vscode.window.showErrorMessage(problem.split('\n')[0]);
        return;
      }

      let prompt = userText;
      if (mode === 'agent') {
        const ed = vscode.window.activeTextEditor;
        const pack = await buildContextPack({
          root,
          index,
          userText,
          budgetTokens: cfg().get<number>('contextBudgetTokens', 6000),
          active: ed && ed.document.uri.scheme === 'file' && !ed.document.uri.fsPath.startsWith(root + path.sep + '.git')
            ? {
                rel: path.relative(root, ed.document.uri.fsPath).split(path.sep).join('/'),
                selection: ed.selection.isEmpty ? undefined : { startLine: ed.selection.start.line + 1, endLine: ed.selection.end.line + 1, text: ed.document.getText(ed.selection) },
              }
            : undefined,
        });
        chat.post({ type: 'context', entries: pack.entries, used: pack.usedTokens, budget: pack.budgetTokens });
        prompt = userText + pack.prompt;
      }

      const manifest = (mode === 'inline' ? inlineManifest : agentManifest).manifest;
      const compaction = cfg().get<number>('compactionTriggerTokens', 16000);
      const spec = (model: string) => {
        const s = specFromManifest(manifest, model, { mcpServerName: MCP_NAME });
        if (mode === 'agent' && compaction > 0) {
          s.config = { ...s.config, contextManagement: { ...(s.config?.contextManagement ?? {}), compaction: { enabled: true, trigger: { type: 'input_tokens', value: compaction } } } };
        }
        return s;
      };
      runner = new ForgeRunner({ baseUrl: baseUrl(), models: chain(), retries: cfg().get<number>('retries', 1), spec });
      token?.onCancellationRequested(() => void runner?.cancel());
      ledger.clear();
      checkpoints.begin(userText.slice(0, 60));
      const announced = new Set<string>();

      const hooks: RunnerHooks = {
        status: m => {
          setStatus(m.replace(/^Running on TrueForge with /, 'TrueForge: ').replace(/…$/, ''));
          progress?.report({ message: m });
          chat.post({ type: 'notice', level: '', text: m });
        },
        textDelta: (id, text) => chat.post({ type: 'delta', id, text }),
        toolCall: (info: ToolCallInfo) => {
          if (announced.has(info.id)) return;
          announced.add(info.id);
          const n = base(info.name);
          const a = info.args ?? {};
          const summary = n === 'run_command' ? String(a.command ?? '') : n === 'find_relevant_code' ? String(a.query ?? '') : n === 'search_code' ? String(a.pattern ?? '') : String(a.path ?? '');
          chat.post({ type: 'tool', id: info.id, name: n, summary });
          progress?.report({ message: `${n} ${summary}`.slice(0, 80) });
        },
        toolResult: (id, text) => chat.post({ type: 'toolResult', id, text }),
        thread: e => chat.post({ type: 'notice', level: '', text: e.kind === 'created' ? `Subagent started: ${e.agent ?? ''} ${e.title ?? ''}`.trim() : `Subagent finished: ${e.title ?? e.threadId}` }),
        compaction: e => chat.post({ type: 'notice', level: 'ok', text: e.kind === 'started' ? 'TrueForge is compacting the conversation context…' : `TrueForge compacted the context (${e.durationMs ?? '?'} ms).` }),
        approve: (info, signal) => decideApproval(tools, info, ui, signal),
        modelFailure: f => {
          const text = `Model ${f.model} failed: ${f.message.slice(0, 200)}. ${f.retrying ? 'Retrying after a short back-off…' : f.next ? `Restoring the workspace and falling back to ${f.next}.` : 'No fallback model left.'}`;
          log(text);
          chat.post({ type: 'notice', level: 'warn', text });
          progress?.report({ message: f.next && !f.retrying ? `${f.model} failed, falling back to ${f.next}` : `${f.model} failed` });
          // Inline edits have no visible chat panel, so surface the failure where the user is looking.
          if (mode === 'inline') void vscode.window.showWarningMessage(`TrueForge Coder: ${text}`);
          if (f.next && !f.retrying) setStatus(`TrueForge: falling back to ${f.next.split('/').pop()}`);
        },
        resetWorkspace: async () => {
          ledger.clear();
          const files = await checkpoints.rollbackCurrent();
          if (files.length) chat.post({ type: 'notice', level: 'ok', text: `Workspace restored: ${files.map(f => path.relative(root, f)).join(', ')}` });
          else chat.post({ type: 'notice', level: 'ok', text: 'Workspace unchanged by the failed attempt.' });
        },
      };

      const outcome = await runner.run(prompt, hooks);
      lastSession = runner.currentSessionId ?? lastSession;
      chat.post({ type: 'session', show: Boolean(lastSession), title: sessionUrl(lastSession) });
      const cp = checkpoints.end();
      if (outcome.status === 'done') {
        chat.post({ type: 'notice', level: 'ok', text: `Done with ${outcome.model}.${cp ? ` ${cp.before.size} file(s) changed — "Undo last run" reverts them.` : ' No files changed.'}` });
        setStatus(`TrueForge: ${outcome.model.split('/').pop()} ✓`);
      } else if (outcome.status === 'cancelled') {
        let note = 'Stopped. Pending changes were not applied.';
        if (cp && cfg().get<boolean>('rollbackOnCancel', true)) {
          const files = await checkpoints.undoLast();
          note = `Stopped. The run was all-or-nothing, so ${files.length} file(s) it had already changed were reverted: ${files.map(f => path.relative(root, f)).join(', ')}.`;
          reindex();
        } else if (cp) note += ` ${cp.before.size} already-approved file(s) stay changed; use "Undo last run" to revert them.`;
        chat.post({ type: 'notice', level: 'warn', text: note });
        setStatus('TrueForge: stopped');
      } else {
        const msg = `Every model in the chain failed: ${outcome.error}. Nothing was changed in your workspace.`;
        chat.post({ type: 'notice', level: 'error', text: msg });
        void vscode.window.showErrorMessage(`TrueForge Coder: ${msg.slice(0, 300)}`);
        setStatus('TrueForge: all models failed');
      }
    } catch (e) {
      checkpoints.end();
      log(`run error: ${(e as Error).stack ?? e}`);
      chat.post({ type: 'notice', level: 'error', text: `Unexpected error: ${(e as Error).message ?? e}` });
    } finally {
      busy = false;
      runner = undefined;
      chat.post({ type: 'busy', value: false });
      refreshUndo();
    }
  }

  chat.onSend = text => void run(text, 'agent');
  chat.onCancel = () => void cancel();
  chat.onUndo = () => void undo();
  chat.onOpenSession = () => void vscode.env.openExternal(vscode.Uri.parse(sessionUrl(lastSession)));

  async function cancel() {
    if (!runner) return;
    chat.post({ type: 'notice', level: 'warn', text: 'Stopping…' });
    await runner.cancel();
  }
  async function undo() {
    if (busy) return void vscode.window.showInformationMessage('Stop the current run before undoing.');
    const label = checkpoints.lastLabel;
    const files = await checkpoints.undoLast();
    if (files.length) {
      chat.post({ type: 'notice', level: 'ok', text: `Reverted "${label}": ${files.map(f => path.relative(root, f)).join(', ')}` });
      void vscode.window.showInformationMessage(`TrueForge Coder reverted ${files.length} file(s).`);
      reindex();
    } else void vscode.window.showInformationMessage('Nothing to undo.');
    refreshUndo();
  }

  // ---- commands ---------------------------------------------------------------------------------------------
  open('trueforgeCoder.cancel', cancel);
  open('trueforgeCoder.undoLastRun', undo);

  open('trueforgeCoder.inlineEdit', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') return void vscode.window.showInformationMessage('Open a file and (optionally) select the code to change.');
    const sel = ed.selection.isEmpty ? ed.document.lineAt(ed.selection.active.line).range : new vscode.Range(ed.selection.start, ed.selection.end);
    const instruction = await vscode.window.showInputBox({ title: 'TrueForge inline edit', prompt: 'What should change in the selected code?', placeHolder: 'e.g. add type hints and a docstring', ignoreFocusOut: true });
    if (!instruction) return;
    const rel = path.relative(root, ed.document.uri.fsPath).split(path.sep).join('/');
    const text = ed.document.getText(sel);
    const prompt = `Inline edit in ${rel}, lines ${sel.start.line + 1}-${sel.end.line + 1}.\nInstruction: ${instruction}\n\nSelected code:\n\`\`\`\n${text}\n\`\`\`\nChange only what the instruction asks for, using one propose_edit call on ${rel}.`;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'TrueForge inline edit', cancellable: true }, (progress, token) => run(prompt, 'inline', progress, token));
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('trueforgeCoder.selectModel', async () => {
      let names: string[] = [];
      try {
        const res = await fetch(`${baseUrl()}/api/v1/settings/model-providers`);
        const j = (await res.json()) as { data?: { name: string; manifest?: { models?: { name: string }[] } }[] };
        names = (j.data ?? []).flatMap(p => (p.manifest?.models ?? []).map(m => `${p.name}/${m.name}`));
      } catch (e) {
        return void vscode.window.showErrorMessage(`Could not list models from TrueForge at ${baseUrl()}: ${(e as Error).message}`);
      }
      if (!names.length) return void vscode.window.showWarningMessage('TrueForge has no models yet. Run "TrueForge Coder: Set Up NVIDIA Models" first.');
      const current = chain();
      const first = await vscode.window.showQuickPick(names.map(n => ({ label: n, description: current[0] === n ? 'current primary' : '' })), { title: 'Primary model (runs first)', placeHolder: current.join(' → ') });
      if (!first) return;
      const rest = names.filter(n => n !== first.label);
      const mode = await vscode.window.showQuickPick(
        [
          { label: 'Fall back to the other configured models', detail: [first.label, ...rest].join(' → '), value: [first.label, ...rest] },
          { label: 'Only this model (no fallback)', detail: first.label, value: [first.label] },
        ],
        { title: 'If the primary model fails…' },
      );
      if (!mode) return;
      await cfg().update('models', mode.value, vscode.ConfigurationTarget.Global);
      setStatus(`TrueForge: ${mode.value[0].split('/').pop()}`, 'Model chain: ' + mode.value.join(' → '));
      chat.post({ type: 'notice', level: 'ok', text: `Model chain: ${mode.value.join(' → ')}` });
    }),
    vscode.commands.registerCommand('trueforgeCoder.connect', async () => {
      const problem = await ensureConnected();
      if (problem) void vscode.window.showErrorMessage(problem.split('\n')[0]);
      else void vscode.window.showInformationMessage(`TrueForge Coder: editor tools registered in TrueForge as "${MCP_NAME}" (${mcp?.url}).`);
    }),
    vscode.commands.registerCommand('trueforgeCoder.setupNvidia', async () => {
      const key = await vscode.window.showInputBox({
        title: 'NVIDIA API key (build.nvidia.com)',
        prompt: 'Sent only to your local TrueForge, which stores it. Never written to your workspace or settings.',
        password: true,
        ignoreFocusOut: true,
        validateInput: v => (v && v.length > 20 ? undefined : 'Paste the key that starts with nvapi-'),
      });
      if (!key) return;
      try {
        const ids: string[] = await listNvidiaModels(NVIDIA_BASE_URL, key);
        const { models, chain: picked } = pickModels(ids);
        if (!models.length) throw new Error('This key cannot see any of the supported coding models.');
        await putProvider(baseUrl(), { name: 'nvidia', base_url: NVIDIA_BASE_URL, api_key: key, models });
        await cfg().update('models', picked, vscode.ConfigurationTarget.Global);
        setStatus(`TrueForge: ${picked[0].split('/').pop()}`, 'Model chain: ' + picked.join(' → '));
        void vscode.window.showInformationMessage(`TrueForge Coder: registered ${models.length} NVIDIA model(s). Chain: ${picked.join(' → ')}`);
      } catch (e) {
        void vscode.window.showErrorMessage(`NVIDIA setup failed: ${(e as Error).message}`);
      }
    }),
  );

  refreshUndo();
  log(`TrueForge Coder ready. Workspace ${root}. TrueForge ${baseUrl()}. Models ${chain().join(' → ')}`);
}

export function deactivate(): void {}

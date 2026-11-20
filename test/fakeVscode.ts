/* Minimal in-memory stand-in for the `vscode` API, enough to run the real bundled extension headlessly. */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface FakeEnv {
  root: string;
  config: Record<string, unknown>;
  commands: Map<string, (...a: any[]) => any>;
  executed: { id: string; args: any[] }[];
  views: { type: string; provider: any }[];
  infoMessages: string[];
  errorMessages: string[];
  inputBoxAnswer?: string;
  quickPickMode: 'accept-all' | { rejectAll?: boolean };
  opened: string[];
}

export function createFakeVscode(env: FakeEnv) {
  class Uri {
    constructor(public scheme: string, public fsPath: string, public path: string, public query = '') {}
    static file(p: string) { return new Uri('file', p, p); }
    static from(o: { scheme: string; path: string; query?: string }) { return new Uri(o.scheme, o.path, o.path, o.query ?? ''); }
    static parse(s: string) { return new Uri('https', s, s); }
    static joinPath(u: Uri, ...p: string[]) { return Uri.file(path.join(u.fsPath, ...p)); }
    toString() { return `${this.scheme}:${this.path}?${this.query}`; }
  }
  class EventEmitter<T> {
    private ls: ((e: T) => void)[] = [];
    event = (l: (e: T) => void) => { this.ls.push(l); return { dispose: () => { this.ls = this.ls.filter(x => x !== l); } }; };
    fire(e: T) { for (const l of [...this.ls]) l(e); }
    dispose() { this.ls = []; }
  }
  class Range { constructor(public start: any, public end: any, ..._rest: any[]) {} }
  class WorkspaceEdit {
    edits: { uri: Uri; text: string }[] = [];
    replace(uri: Uri, _r: Range, text: string) { this.edits.push({ uri, text }); }
  }
  const doc = async (uri: Uri) => {
    const text = await fs.readFile(uri.fsPath, 'utf8');
    return { uri, isClosed: false, getText: (_r?: any) => text, positionAt: (n: number) => n, save: async () => true };
  };

  return {
    Uri, EventEmitter, Range, WorkspaceEdit,
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1 },
    env: { openExternal: async (u: Uri) => { env.opened.push(u.fsPath); return true; } },
    commands: {
      registerCommand: (id: string, fn: (...a: any[]) => any) => { env.commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (id: string, ...args: any[]) => { env.executed.push({ id, args }); },
    },
    workspace: {
      workspaceFolders: [{ uri: Uri.file(env.root), name: 'ws', index: 0 }],
      textDocuments: [] as any[],
      getConfiguration: (_s: string) => ({
        get: (k: string, d?: unknown) => (k in env.config ? env.config[k] : d),
        update: async (k: string, v: unknown) => { env.config[k] = v; },
      }),
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
      fs: {
        readFile: async (u: Uri) => fs.readFile(u.fsPath),
        stat: async (u: Uri) => fs.stat(u.fsPath),
        writeFile: async (u: Uri, b: Uint8Array) => fs.writeFile(u.fsPath, b),
        createDirectory: async (u: Uri) => { await fs.mkdir(u.fsPath, { recursive: true }); },
        delete: async (u: Uri) => fs.rm(u.fsPath, { force: true }),
      },
      openTextDocument: doc,
      applyEdit: async (e: WorkspaceEdit) => { for (const x of e.edits) await fs.writeFile(x.uri.fsPath, x.text); return true; },
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, dispose() {} }),
      registerWebviewViewProvider: (type: string, provider: any) => { env.views.push({ type, provider }); return { dispose() {} }; },
      showInformationMessage: async (m: string) => { env.infoMessages.push(m); },
      showWarningMessage: async (..._a: any[]) => undefined,
      showErrorMessage: async (m: string) => { env.errorMessages.push(m); },
      showInputBox: async () => env.inputBoxAnswer,
      activeTextEditor: undefined as any,
      withProgress: async (_o: any, task: (p: any, t: any) => Promise<any>) => {
        const ls: (() => void)[] = [];
        return task({ report() {} }, { onCancellationRequested: (l: () => void) => { ls.push(l); return { dispose() {} }; } });
      },
      createQuickPick: () => {
        const accept: (() => void)[] = []; const hide: (() => void)[] = []; const sel: ((s: any[]) => void)[] = [];
        const qp: any = {
          canSelectMany: true, items: [] as any[], selectedItems: [] as any[],
          onDidAccept: (l: () => void) => accept.push(l), onDidHide: (l: () => void) => hide.push(l), onDidChangeSelection: (l: (s: any[]) => void) => sel.push(l),
          show() {
            setImmediate(() => {
              const mode = env.quickPickMode;
              qp.selectedItems = mode === 'accept-all' ? qp.items : mode.rejectAll ? [] : qp.items.slice(0, 1);
              sel.forEach(l => l(qp.selectedItems));
              accept.forEach(l => l());
            });
          },
          dispose() {},
        };
        return qp;
      },
    },
  };
}

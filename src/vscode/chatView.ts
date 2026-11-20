import * as vscode from 'vscode';
import * as crypto from 'node:crypto';

export type ReviewMsg = { id: number; kind: 'preview' | 'openDiff' | 'decide'; accepted: number[] };

/** The sidebar chat panel. All rendering lives in media/chat.js; this class only moves messages. */
export class ChatView implements vscode.WebviewViewProvider {
  static readonly viewType = 'trueforgeCoder.chat';
  private view?: vscode.WebviewView;
  private backlog: unknown[] = [];
  private reviewEmitter = new vscode.EventEmitter<ReviewMsg>();
  onReview = (l: (m: ReviewMsg) => void) => this.reviewEmitter.event(l);
  onSend: (text: string) => void = () => {};
  onCancel: () => void = () => {};
  onUndo: () => void = () => {};
  onOpenSession: () => void = () => {};

  constructor(private extUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(m => {
      switch (m?.type) {
        case 'ready':
          for (const b of this.backlog) void view.webview.postMessage(b);
          return;
        case 'send':
          return this.onSend(String(m.text ?? ''));
        case 'cancel':
          return this.onCancel();
        case 'undo':
          return this.onUndo();
        case 'openSession':
          return this.onOpenSession();
        case 'review':
          return this.reviewEmitter.fire({ id: Number(m.id), kind: m.kind, accepted: Array.isArray(m.accepted) ? m.accepted.map(Number) : [] });
      }
    });
    view.onDidDispose(() => (this.view = undefined));
  }

  post(msg: unknown): void {
    this.backlog.push(msg);
    if (this.backlog.length > 800) this.backlog.splice(0, this.backlog.length - 800);
    void this.view?.webview.postMessage(msg);
  }

  reveal(): void {
    this.view?.show?.(true);
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand('trueforgeCoder.chat.focus');
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'chat.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'chat.css'));
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>TrueForge Coder</title></head>
<body>
<div id="top"><div id="status">Ready</div><div id="topbtns"><button id="session" title="Open this run in TrueForge" hidden>TrueForge session ↗</button><button id="undo" title="Revert every file the last run changed" disabled>↶ Undo last run</button></div></div>
<div id="log" aria-live="polite"></div>
<form id="composer">
<textarea id="input" rows="3" placeholder="Describe a change. Use @path/to/file to pin a file. Enter to send, Shift+Enter for newline."></textarea>
<div id="row"><button id="send" type="submit">Send</button><button id="stop" type="button" hidden>■ Stop</button></div>
</form>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }
}

import * as vscode from 'vscode';

export const DIFF_SCHEME = 'trueforge-diff';

/** In-memory documents for the native diff editor (original on the left, proposed-with-chosen-hunks on the right). */
export class DiffDocs implements vscode.TextDocumentContentProvider {
  private docs = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  uri(rel: string, side: 'original' | 'proposed', id: number): vscode.Uri {
    return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${rel}`, query: `${side}-${id}` });
  }

  set(uri: vscode.Uri, content: string): void {
    this.docs.set(uri.toString(), content);
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }

  async show(rel: string, id: number, original: string, proposed: string): Promise<void> {
    const left = this.uri(rel, 'original', id);
    const right = this.uri(rel, 'proposed', id);
    this.set(left, original);
    this.set(right, proposed);
    await vscode.commands.executeCommand('vscode.diff', left, right, `TrueForge: ${rel} (proposed changes)`, { preview: true, preserveFocus: true });
  }

  update(rel: string, id: number, proposed: string): void {
    this.set(this.uri(rel, 'proposed', id), proposed);
  }
}

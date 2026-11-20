import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Host } from '../core/host';
import { runShell } from '../core/exec';

const normalize = (s: string) => s.replace(/\r\n/g, '\n');

export interface VsHost extends Host {
  remove(abs: string): Promise<void>;
}

/** Host backed by VS Code: reads open (even unsaved) buffers, writes through WorkspaceEdit so Cmd/Ctrl+Z still works. */
export function vscodeHost(root: string, onWrite: Host['onWrite'], preamble: () => string = () => ''): VsHost {
  return {
    root,
    onWrite,
    async readText(abs) {
      const uri = vscode.Uri.file(abs);
      const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath && !d.isClosed);
      if (open) return normalize(open.getText());
      try {
        return normalize(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
      } catch {
        return undefined;
      }
    },
    async writeText(abs, content) {
      const uri = vscode.Uri.file(abs);
      let exists = true;
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        exists = false;
      }
      if (!exists) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(abs)));
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        return;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) throw new Error(`VS Code refused the edit to ${path.basename(abs)}`);
      await doc.save();
    },
    async remove(abs) {
      await vscode.workspace.fs.delete(vscode.Uri.file(abs), { useTrash: false });
    },
    exec: (command, cwd, timeoutMs) => runShell(preamble() ? `${preamble()} ${command}` : command, cwd, timeoutMs),
  };
}

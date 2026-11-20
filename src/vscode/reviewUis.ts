import * as vscode from 'vscode';
import { composeContent, renderHunk, type HunkSet } from '../core/hunks';
import type { ReviewUi } from '../core/review';
import type { DiffDocs } from './diffDocs';
import type { ChatView } from './chatView';

let reviewSeq = 0;

/** Review in the chat panel: one card per file, one checkbox per hunk, live-updating native diff beside it. */
export class ChatReviewUi implements ReviewUi {
  constructor(private chat: ChatView, private diffs: DiffDocs, private confirmBox: (command: string) => Promise<boolean>) {}

  async reviewChange(req: { rel: string; isNew: boolean; set: HunkSet }, signal: AbortSignal): Promise<{ accepted: ReadonlySet<number> }> {
    const id = ++reviewSeq;
    const all = new Set(req.set.hunks.map(h => h.id));
    await this.diffs.show(req.rel, id, req.set.original, req.set.proposed);
    return new Promise(resolve => {
      const finish = (accepted: ReadonlySet<number>, how: string) => {
        sub.dispose();
        signal.removeEventListener('abort', onAbort);
        this.chat.post({ type: 'reviewDone', id, how });
        resolve({ accepted });
      };
      const sub = this.chat.onReview(msg => {
        if (msg.id !== id) return;
        const accepted = new Set<number>(msg.accepted);
        if (msg.kind === 'preview') {
          this.diffs.update(req.rel, id, composeContent(req.set, accepted));
        } else if (msg.kind === 'openDiff') {
          void this.diffs.show(req.rel, id, req.set.original, composeContent(req.set, accepted));
        } else if (msg.kind === 'decide') {
          finish(accepted, accepted.size === 0 ? 'Rejected' : accepted.size === all.size ? 'Applied all hunks' : `Applied ${accepted.size} of ${all.size} hunks`);
        }
      });
      const onAbort = () => finish(new Set(), 'Cancelled');
      signal.addEventListener('abort', onAbort);
      this.chat.reveal();
      this.chat.post({
        type: 'review',
        id,
        rel: req.rel,
        isNew: req.isNew,
        hunks: req.set.hunks.map(h => ({ id: h.id, oldStart: h.oldStart, removed: h.removed, added: h.added })),
      });
    });
  }

  confirmCommand(command: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return this.confirmBox(command);
  }
}

/** Review for inline edits: native diff + a multi-select list of hunks (untick = reject). */
export class QuickPickReviewUi implements ReviewUi {
  constructor(private diffs: DiffDocs, private confirmBox: (command: string) => Promise<boolean>) {}

  async reviewChange(req: { rel: string; isNew: boolean; set: HunkSet }, signal: AbortSignal): Promise<{ accepted: ReadonlySet<number> }> {
    const id = ++reviewSeq;
    await this.diffs.show(req.rel, id, req.set.original, req.set.proposed);
    const items = req.set.hunks.map(h => {
      const preview = renderHunk(h).split('\n');
      return {
        label: `$(diff) Line ${h.oldStart}`,
        description: `−${h.removed.length} +${h.added.length}`,
        detail: preview.slice(0, 4).join('  ⏎  ').slice(0, 220),
        hunkId: h.id,
      };
    });
    const qp = vscode.window.createQuickPick<(typeof items)[number]>();
    qp.canSelectMany = true;
    qp.title = `TrueForge inline edit — ${req.rel}`;
    qp.placeholder = 'Untick hunks you want to reject, then press Enter to apply the rest (Esc rejects everything)';
    qp.ignoreFocusOut = true;
    qp.items = items;
    qp.selectedItems = items;
    return new Promise(resolve => {
      let settled = false;
      const done = (ids: number[]) => {
        if (settled) return;
        settled = true;
        qp.dispose();
        resolve({ accepted: new Set(ids) });
      };
      qp.onDidChangeSelection(sel => this.diffs.update(req.rel, id, composeContent(req.set, new Set(sel.map(s => s.hunkId)))));
      qp.onDidAccept(() => done(qp.selectedItems.map(s => s.hunkId)));
      qp.onDidHide(() => done([]));
      signal.addEventListener('abort', () => done([]));
      qp.show();
    });
  }

  confirmCommand(command: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return this.confirmBox(command);
  }
}

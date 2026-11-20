import path from 'node:path';
import type { Decision, ToolCallInfo } from './runner';
import type { EditorTools } from './editorTools';
import { composeContent, renderHunk, type HunkSet } from './hunks';

/** What the editor UI has to implement: show the change, collect the user's per-hunk decision. */
export interface ReviewUi {
  /** Show the proposed file change; resolve with the ids of hunks the user ACCEPTED (empty set = reject all). */
  reviewChange(req: { rel: string; isNew: boolean; set: HunkSet }, signal: AbortSignal): Promise<{ accepted: ReadonlySet<number> }>;
  /** Ask to run a shell command; resolve true if the user allows it. */
  confirmCommand(command: string, signal: AbortSignal): Promise<boolean>;
}

const base = (name: string) => name.split(/__|\.|\//).pop() ?? name;

/**
 * Turns a TrueForge `tool.approval_required` pause into an editor decision.
 * The user's per-hunk choice is written to the approval ledger BEFORE the allow is sent back to TrueForge,
 * so the MCP tool applies exactly what was approved (and nothing, if anything goes wrong).
 */
export async function decideApproval(tools: EditorTools, info: ToolCallInfo, ui: ReviewUi, signal: AbortSignal): Promise<Decision> {
  const tool = base(info.name);
  const args = info.args ?? {};
  if (tool === 'propose_edit' || tool === 'write_new_file') {
    const prepared = tool === 'propose_edit' ? await tools.prepareEdit(args) : await tools.prepareNewFile(args);
    if (!prepared.ok) return { allow: false, reason: prepared.error };
    const { accepted } = await ui.reviewChange({ rel: prepared.rel, isNew: prepared.isNew, set: prepared.set }, signal);
    if (signal.aborted) return { allow: false, reason: 'Cancelled by the user.' };
    const total = prepared.set.hunks.length;
    if (accepted.size === 0) {
      return { allow: false, reason: `The user rejected every hunk of this change to ${prepared.rel}. Nothing was written. Do not propose it again unchanged; ask what they would prefer if unsure.` };
    }
    const rejected = prepared.set.hunks.filter(h => !accepted.has(h.id)).map(h => `@@ line ${h.oldStart} @@\n${renderHunk(h)}`);
    tools.ledger.grant(tool, args, { kind: 'write', path: prepared.abs, content: composeContent(prepared.set, accepted), base: prepared.isNew ? undefined : prepared.set.original, accepted: accepted.size, total, rejected });
    return { allow: true };
  }
  if (tool === 'run_command') {
    const command = String(args.command ?? '');
    const ok = await ui.confirmCommand(command, signal);
    if (!ok) return { allow: false, reason: 'The user did not allow this command.' };
    tools.ledger.grant('run_command', args, { kind: 'command', command });
    return { allow: true };
  }
  // Any other gated tool (for example a built-in) is not something this editor can show a diff for.
  return { allow: false, reason: `The editor cannot review ${path.basename(info.name)}; it was not run.` };
}

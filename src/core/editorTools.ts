import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { composeContent, computeHunks, type HunkSet } from './hunks';
import { planEdits, type TextEdit } from './editPlanner';
import { ApprovalLedger } from './ledger';
import type { Host } from './host';
import { CodeIndex, estimateTokens, formatRetrieval } from './retrieval';

export type Prepared =
  | { ok: true; abs: string; rel: string; isNew: boolean; set: HunkSet }
  | { ok: false; error: string };

const MAX_READ_LINES = 400;
const MAX_OUTPUT_CHARS = 8000;

export function clip(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… [${text.length - max} characters omitted] …\n${text.slice(-half)}`;
}

/** The editor's capabilities. Each method backs one MCP tool; TrueForge's agent decides when to call them. */
export class EditorTools {
  constructor(
    private host: Host,
    public index: CodeIndex,
    public ledger: ApprovalLedger,
    private defaults: { budgetTokens: number } = { budgetTokens: 6000 },
  ) {}

  resolve(p: string): { abs: string; rel: string } {
    const abs = path.resolve(this.host.root, p || '.');
    const rel = path.relative(this.host.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path is outside the workspace: ${p}`);
    return { abs, rel: rel.split(path.sep).join('/') || '.' };
  }

  async readFile(args: { path: string; start_line?: number; end_line?: number }): Promise<string> {
    const { abs, rel } = this.resolve(args.path);
    const text = await this.host.readText(abs);
    if (text === undefined) throw new Error(`File not found: ${rel}`);
    const lines = text.split('\n');
    const start = Math.max(1, args.start_line ?? 1);
    const end = Math.min(lines.length, args.end_line ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
    const body = lines
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(5)}  ${l}`)
      .join('\n');
    const more = end < lines.length ? `\n[showing lines ${start}-${end} of ${lines.length}; pass start_line/end_line to read more]` : '';
    return `${rel} (${lines.length} lines)\n${body}${more}`;
  }

  async listDir(args: { path?: string }): Promise<string> {
    const { abs, rel } = this.resolve(args.path ?? '.');
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const rows = entries
      .filter(e => !['.git', 'node_modules', '__pycache__', '.venv'].includes(e.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name));
    return `${rel}/\n${rows.join('\n')}`;
  }

  async searchCode(args: { pattern: string; glob?: string; max_results?: number }): Promise<string> {
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, 'i');
    } catch {
      re = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    const globRe = args.glob ? new RegExp('^' + args.glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*') + '$') : undefined;
    const max = Math.min(args.max_results ?? 40, 100);
    const out: string[] = [];
    for (const rel of [...this.index.files].sort()) {
      if (globRe && !globRe.test(rel)) continue;
      const text = await this.host.readText(path.join(this.host.root, rel));
      if (text === undefined) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && out.length < max; i++) if (re.test(lines[i])) out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
      if (out.length >= max) break;
    }
    return out.length ? out.join('\n') : 'No matches.';
  }

  findRelevantCode(args: { query: string; budget_tokens?: number }): string {
    const r = this.index.search(args.query, Math.min(args.budget_tokens ?? this.defaults.budgetTokens, 20000));
    return formatRetrieval(r, true);
  }

  /** Validate an edit proposal and compute its hunks. Nothing is written. */
  async prepareEdit(args: { path: string; edits: TextEdit[] }): Promise<Prepared> {
    let target: { abs: string; rel: string };
    try {
      target = this.resolve(args.path);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (/(^|\/)\.git(\/|$)/.test(target.rel)) return { ok: false, error: 'Editing inside .git is not allowed.' };
    const original = await this.host.readText(target.abs);
    if (original === undefined) return { ok: false, error: `File not found: ${target.rel}. Use write_new_file to create a new file.` };
    const plan = planEdits(original, args.edits);
    if (!plan.ok) return { ok: false, error: plan.error };
    if (plan.proposed === original) return { ok: false, error: 'The edits do not change the file.' };
    return { ok: true, ...target, isNew: false, set: computeHunks(original, plan.proposed) };
  }

  async prepareNewFile(args: { path: string; content: string }): Promise<Prepared> {
    let target: { abs: string; rel: string };
    try {
      target = this.resolve(args.path);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (/(^|\/)\.git(\/|$)/.test(target.rel)) return { ok: false, error: 'Writing inside .git is not allowed.' };
    if ((await this.host.readText(target.abs)) !== undefined) return { ok: false, error: `${target.rel} already exists. Use propose_edit to change it.` };
    return { ok: true, ...target, isNew: true, set: computeHunks('', args.content) };
  }

  /** MCP tool body for propose_edit / write_new_file: applies ONLY what the user approved in the editor. */
  async applyApproved(tool: 'propose_edit' | 'write_new_file', args: { path: string }): Promise<string> {
    const grant = this.ledger.consume(tool, args);
    if (!grant || grant.kind !== 'write') {
      return 'REFUSED: no user approval is recorded for this edit, so nothing was written. Ask the user to review the change in the editor.';
    }
    const before = await this.host.readText(grant.path);
    if (before !== grant.base) {
      return 'REFUSED: the file changed after the user reviewed this edit (for example another edit to it landed first), so nothing was written. Read the file again and propose the edit again.';
    }
    await this.host.writeText(grant.path, grant.content);
    this.host.onWrite?.(grant.path, before, grant.content);
    const rel = path.relative(this.host.root, grant.path).split(path.sep).join('/');
    const partial = grant.accepted < grant.total ? ` The user REJECTED ${grant.total - grant.accepted} hunk(s), which were not applied:\n${grant.rejected.join('\n')}` : '';
    return `Applied ${grant.accepted}/${grant.total} hunk(s) to ${rel}.${partial}`;
  }

  async runApproved(args: { command: string }): Promise<string> {
    const grant = this.ledger.consume('run_command', args);
    if (!grant || grant.kind !== 'command') return 'REFUSED: the user did not approve this command, so it was not run.';
    const res = await this.host.exec(grant.command, this.host.root, 120_000);
    const status = res.timedOut ? 'TIMED OUT after 120s' : `exit code ${res.code}`;
    return clip(`$ ${grant.command}\n${status}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`);
  }

  approxTokens(s: string): number {
    return estimateTokens(s);
  }
}

export { composeContent };

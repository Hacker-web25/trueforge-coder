import * as path from 'node:path';
import type { Host } from './host';

/**
 * Undo support for agent runs. Every approved write records the file's content BEFORE the run first touched it,
 * so a whole run can be reverted exactly (files the run created are removed again).
 */
export interface RunCheckpoint {
  id: number;
  label: string;
  /** abs path -> content before the run first changed it (undefined = file did not exist) */
  before: Map<string, string | undefined>;
  /** abs path -> content as last written by the run */
  after: Map<string, string>;
}

export class Checkpoints {
  private runs: RunCheckpoint[] = [];
  private seq = 0;
  private current?: RunCheckpoint;

  constructor(private host: Pick<Host, 'readText' | 'writeText'> & { remove(abs: string): Promise<void> }) {}

  begin(label: string): RunCheckpoint {
    this.current = { id: ++this.seq, label, before: new Map(), after: new Map() };
    return this.current;
  }

  /** Called from Host.onWrite. */
  record(abs: string, before: string | undefined, after: string): void {
    const c = this.current;
    if (!c) return;
    if (!c.before.has(abs)) c.before.set(abs, before);
    c.after.set(abs, after);
  }

  /** Finish the current run; keep it for undo only if it changed something. */
  end(): RunCheckpoint | undefined {
    const c = this.current;
    this.current = undefined;
    if (c && c.before.size > 0) {
      this.runs.push(c);
      return c;
    }
    return undefined;
  }

  /** Revert the run that is currently in progress (used before a retry / model fallback). */
  async rollbackCurrent(): Promise<string[]> {
    const c = this.current;
    if (!c) return [];
    const files = await this.restore(c);
    c.before.clear();
    c.after.clear();
    return files;
  }

  get canUndo(): boolean {
    return this.runs.length > 0;
  }

  get lastLabel(): string | undefined {
    return this.runs[this.runs.length - 1]?.label;
  }

  /** Revert the most recent finished run. Returns the files that were restored. */
  async undoLast(): Promise<string[]> {
    const c = this.runs.pop();
    if (!c) return [];
    return this.restore(c);
  }

  private async restore(c: RunCheckpoint): Promise<string[]> {
    const restored: string[] = [];
    for (const [abs, before] of c.before) {
      if (before === undefined) await this.host.remove(abs);
      else await this.host.writeText(abs, before);
      restored.push(abs);
    }
    return restored;
  }

  relative(root: string, abs: string): string {
    return path.relative(root, abs).split(path.sep).join('/');
  }
}

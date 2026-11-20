export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Everything the editor tools need from the outside world. VS Code supplies one; tests supply another. */
export interface Host {
  /** Absolute workspace root. */
  root: string;
  /** Current text of a file (open editor buffer if there is one), or undefined if it does not exist. */
  readText(abs: string): Promise<string | undefined>;
  /** Write approved content to disk (through the editor so undo history stays intact). */
  writeText(abs: string, content: string): Promise<void>;
  exec(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecResult>;
  /** Called after an approved write lands, so the caller can keep a checkpoint for undo. */
  onWrite?(abs: string, before: string | undefined, after: string): void;
}

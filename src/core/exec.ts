import { exec } from 'node:child_process';
import type { ExecResult } from './host';

export function runShell(command: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise(resolve => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({ code: e ? ((e as unknown as { code?: number }).code ?? 1) : 0, stdout, stderr, timedOut: Boolean(e?.killed) });
    });
  });
}

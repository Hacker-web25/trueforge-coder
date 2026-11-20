import { promises as fs } from 'node:fs';
import { exec } from 'node:child_process';
import * as path from 'node:path';
import type { Host } from '../src/core/host';

/** A Host backed by the plain filesystem, for tests and the headless demo. */
export function fsHost(root: string, onWrite?: Host['onWrite']): Host {
  return {
    root,
    async readText(abs) {
      try {
        return await fs.readFile(abs, 'utf8');
      } catch {
        return undefined;
      }
    },
    async writeText(abs, content) {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
    },
    exec: (command, cwd, timeoutMs) =>
      new Promise(resolve => {
        exec(command, { cwd, timeout: timeoutMs, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
          resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr, timedOut: Boolean(err && (err as any).killed) });
        });
      }),
    onWrite,
  };
}

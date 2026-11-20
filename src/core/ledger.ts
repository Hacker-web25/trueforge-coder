import { createHash } from 'node:crypto';

/** Stable JSON: object keys sorted so the same arguments always hash the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export type Grant =
  | { kind: 'write'; path: string; content: string; /** file content the user reviewed against (undefined = file did not exist) */ base: string | undefined; accepted: number; total: number; rejected: string[] }
  | { kind: 'command'; command: string };

/**
 * Records what the USER approved in the editor. The MCP tools that change the workspace refuse to run
 * unless a matching grant exists, so even a tool call that slipped past TrueForge's approval gate
 * could not write to disk silently.
 */
export class ApprovalLedger {
  private grants = new Map<string, { tool: string; path?: string; grant: Grant }>();

  private key(tool: string, args: unknown): string {
    return createHash('sha256').update(`${tool}:${stableStringify(args)}`).digest('hex');
  }

  grant(tool: string, args: unknown, grant: Grant): void {
    const path = (args as { path?: string } | undefined)?.path;
    this.grants.set(this.key(tool, args), { tool, path, grant });
  }

  /** One-shot: returns the grant and removes it. Falls back to tool+path when the args were re-serialized. */
  consume(tool: string, args: unknown): Grant | undefined {
    const k = this.key(tool, args);
    const exact = this.grants.get(k);
    if (exact) {
      this.grants.delete(k);
      return exact.grant;
    }
    const path = (args as { path?: string } | undefined)?.path;
    if (path !== undefined) {
      const matches = [...this.grants.entries()].filter(([, v]) => v.tool === tool && v.path === path);
      if (matches.length === 1) {
        this.grants.delete(matches[0][0]);
        return matches[0][1].grant;
      }
    }
    return undefined;
  }

  revoke(tool: string, args: unknown): void {
    this.grants.delete(this.key(tool, args));
  }

  clear(): void {
    this.grants.clear();
  }
}

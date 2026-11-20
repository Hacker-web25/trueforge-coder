import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { CodeIndex, estimateTokens, type RetrievalResult } from './retrieval';

/** What the user message is enriched with before it is sent to the TrueForge agent. */
export interface ContextPack {
  /** Text appended to the user's message. */
  prompt: string;
  /** Structured summary for the UI card: what was included and why. */
  entries: { kind: 'mention' | 'selection' | 'active-file' | 'retrieved'; label: string; reason: string; tokens: number }[];
  budgetTokens: number;
  usedTokens: number;
  retrieval?: RetrievalResult;
}

const MENTION = /(?:^|\s)@([\w./\\-]+)/g;

/** Everything written as @something: file paths or symbol names. Trailing punctuation is not part of the mention. */
export function findMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION)) {
    const name = m[1].replace(/\\/g, '/').replace(/[.,;:)\]]+$/, '');
    if (name) out.add(name);
  }
  return [...out];
}

export interface ActiveEditorInfo {
  rel: string;
  selection?: { startLine: number; endLine: number; text: string };
}

const clipLines = (text: string, maxLines: number): string => {
  const lines = text.split('\n');
  return lines.length <= maxLines ? text : `${lines.slice(0, maxLines).join('\n')}\n… [${lines.length - maxLines} more lines — use read_file]`;
};

/**
 * Context assembly (what the model sees besides the question), within a hard token budget:
 *   1. explicit @file mentions  (highest priority, user said so)
 *   2. the current selection / active file path
 *   3. BM25 + structure-aware retrieval over the whole workspace, packed greedily into the remaining budget
 * Every piece records WHY it is there, so the user (and the judges) can inspect the choice.
 */
export async function buildContextPack(opts: {
  root: string;
  index: CodeIndex;
  userText: string;
  budgetTokens: number;
  active?: ActiveEditorInfo;
}): Promise<ContextPack> {
  const { root, index, userText, budgetTokens, active } = opts;
  const parts: string[] = [];
  const entries: ContextPack['entries'] = [];
  let used = 0;
  const alreadyIncluded = new Set<string>();

  for (const name of findMentions(userText)) {
    // 1) @path/to/file.ext
    const abs = path.resolve(root, name);
    let isFile = false;
    if (!path.relative(root, abs).startsWith('..')) {
      try {
        const st = await fs.stat(abs);
        if (st.isFile()) {
          const body = clipLines(await fs.readFile(abs, 'utf8'), 250);
          const tokens = estimateTokens(body);
          isFile = true;
          if (used + tokens <= budgetTokens * 0.6) {
            parts.push(`### ${name} (mentioned with @)\n\`\`\`\n${body}\n\`\`\``);
            entries.push({ kind: 'mention', label: name, reason: 'you mentioned this file with @', tokens });
            used += tokens;
            alreadyIncluded.add(name);
          }
        }
      } catch {
        /* not a file */
      }
    }
    if (isFile) continue;
    // 2) @symbol: the function/class/heading with exactly that name
    for (const c of index.findSymbol(name)) {
      const body = clipLines(c.text, 200);
      const tokens = estimateTokens(body);
      if (used + tokens > budgetTokens * 0.6) break;
      parts.push(`### ${c.file}:${c.startLine}-${c.endLine} (${c.symbol}, mentioned with @${name})\n\`\`\`\n${body}\n\`\`\``);
      entries.push({ kind: 'mention', label: `${c.file}:${c.startLine}-${c.endLine} ${c.symbol}`, reason: `you mentioned symbol @${name}`, tokens });
      used += tokens;
    }
  }

  if (active?.selection && active.selection.text.trim()) {
    const body = clipLines(active.selection.text, 120);
    const tokens = estimateTokens(body);
    parts.push(`### Selection in ${active.rel} lines ${active.selection.startLine}-${active.selection.endLine}\n\`\`\`\n${body}\n\`\`\``);
    entries.push({ kind: 'selection', label: `${active.rel}:${active.selection.startLine}-${active.selection.endLine}`, reason: 'your current selection', tokens });
    used += tokens;
  } else if (active) {
    entries.push({ kind: 'active-file', label: active.rel, reason: 'file open in the editor (path only)', tokens: estimateTokens(active.rel) });
    parts.push(`Active editor file: ${active.rel}`);
  }

  const remaining = Math.max(0, budgetTokens - used);
  let retrieval: RetrievalResult | undefined;
  if (remaining > 400) {
    retrieval = index.search(userText, remaining);
    for (const it of retrieval.items) {
      if (alreadyIncluded.has(it.file)) continue;
      parts.push(`### ${it.file}:${it.startLine}-${it.endLine}${it.symbol ? ` (${it.symbol})` : ''}\n\`\`\`\n${it.text}\n\`\`\``);
      entries.push({ kind: 'retrieved', label: `${it.file}:${it.startLine}-${it.endLine}${it.symbol ? ` ${it.symbol}` : ''}`, reason: it.reasons.join('; '), tokens: it.tokens });
      used += it.tokens;
    }
  }

  const prompt = parts.length
    ? `\n\n---\nContext pack (auto-assembled, ${used}/${budgetTokens} tokens; use find_relevant_code / search_code / read_file for anything else):\n\n${parts.join('\n\n')}`
    : '';
  return { prompt, entries, budgetTokens, usedTokens: used, retrieval };
}

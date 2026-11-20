import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Automatic context retrieval.
 *
 * Strategy (also described in the write-up):
 *  1. Walk the workspace once and cut files into function/class-sized chunks (headings for docs).
 *  2. Rank chunks with BM25 over: chunk text + symbol name (x3) + path tokens (x2). Identifiers are split
 *     on snake_case / camelCase so "debug flag" finds `get_debug_flag`.
 *  3. Add "co-change neighbours": the test file and the doc page that share a module name with a hit
 *     (src/flask/cli.py -> tests/test_cli.py, docs/cli.rst), because multi-file edits usually need them.
 *  4. Pack the best chunks into a hard TOKEN BUDGET (greedy, with a per-file diversity penalty) and keep
 *     the reasons so the UI and the agent can show WHY each snippet was chosen.
 */

export interface Chunk {
  id: number;
  file: string; // workspace-relative, posix separators
  startLine: number; // 1-based
  endLine: number;
  symbol?: string;
  text: string;
  tokens: string[];
}

export interface RetrievedItem {
  file: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  score: number;
  reasons: string[];
  tokens: number;
  text: string;
}

export interface RetrievalResult {
  query: string;
  items: RetrievedItem[];
  budgetTokens: number;
  usedTokens: number;
  indexedFiles: number;
  indexedChunks: number;
  strategy: string;
}

const IGNORE_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.tox', '.mypy_cache', '.pytest_cache', '.idea', '.vscode', '.next', 'out', 'coverage', '.eggs']);
const TEXT_EXT = new Set(['.py', '.rst', '.md', '.txt', '.toml', '.cfg', '.ini', '.yaml', '.yml', '.json', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.cs', '.rb', '.php', '.sh', '.html', '.css']);
const MAX_FILE_BYTES = 400_000;
const MAX_CHUNK_LINES = 70;
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'it', 'be', 'by', 'as', 'at', 'that', 'this', 'from', 'are', 'was', 'must', 'should', 'would', 'will', 'can', 'any', 'all', 'its', 'new', 'add', 'make', 'please', 'also', 'then', 'into', 'so', 'if', 'do', 'not', 'no', 'has', 'have', 'which', 'each', 'one', 'other', 'than', 'but', 'you', 'your', 'we', 'our', 'i']);

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const parts = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ');
    for (const p of parts) {
      const t = p.toLowerCase();
      if (t.length < 2 || STOP.has(t)) continue;
      out.push(t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);
    }
  }
  return out;
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      await walk(root, path.join(dir, e.name), out);
    } else if (e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(path.join(dir, e.name));
    }
  }
}

const DEF_RE = /^(\s*)(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/;
const JS_DEF_RE = /^\s*(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\()/;

function chunkFile(rel: string, content: string, startId: number): Chunk[] {
  const lines = content.split('\n');
  const ext = path.extname(rel).toLowerCase();
  const bounds: { line: number; symbol?: string }[] = [{ line: 0 }];
  for (let i = 0; i < lines.length; i++) {
    if (ext === '.py') {
      const m = DEF_RE.exec(lines[i]);
      if (m) bounds.push({ line: i, symbol: m[2] });
    } else if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      const m = JS_DEF_RE.exec(lines[i]);
      if (m) bounds.push({ line: i, symbol: m[1] ?? m[2] ?? m[3] });
    } else if (ext === '.rst' || ext === '.md') {
      const isHeading = ext === '.md' ? /^#{1,4}\s+\S/.test(lines[i]) : i > 0 && /^([=\-~^"`#*])\1{2,}\s*$/.test(lines[i]) && lines[i - 1].trim() !== '';
      if (isHeading) bounds.push({ line: ext === '.md' ? i : i - 1, symbol: (ext === '.md' ? lines[i] : lines[i - 1]).replace(/^#+\s*/, '').trim() });
    }
  }
  const uniq = bounds.filter((b, i) => i === 0 || b.line !== bounds[i - 1].line);
  const chunks: Chunk[] = [];
  let id = startId;
  const push = (start: number, end: number, symbol?: string) => {
    for (let s = start; s <= end; s += MAX_CHUNK_LINES) {
      const e = Math.min(end, s + MAX_CHUNK_LINES - 1);
      const text = lines.slice(s, e + 1).join('\n');
      if (text.trim() === '') continue;
      const pathToks = tokenize(rel.replace(/[\\/]/g, ' '));
      const symToks = symbol ? tokenize(symbol) : [];
      chunks.push({
        id: id++,
        file: rel,
        startLine: s + 1,
        endLine: e + 1,
        symbol,
        text,
        tokens: [...tokenize(text), ...symToks, ...symToks, ...symToks, ...pathToks, ...pathToks],
      });
    }
  };
  for (let i = 0; i < uniq.length; i++) {
    const start = uniq[i].line;
    const end = (i + 1 < uniq.length ? uniq[i + 1].line : lines.length) - 1;
    if (end >= start) push(start, end, uniq[i].symbol);
  }
  return chunks;
}

export class CodeIndex {
  get fileCount(): number {
    return this.files.size;
  }

  /** Chunks whose symbol name is exactly `name` (case-sensitive first, then case-insensitive). Used for @symbol mentions. */
  findSymbol(name: string, max = 3): Chunk[] {
    const exact = this.chunks.filter(c => c.symbol === name);
    const hits = exact.length ? exact : this.chunks.filter(c => c.symbol && c.symbol.toLowerCase() === name.toLowerCase());
    return hits.sort((a, b) => Number(/(^|\/)tests?\//.test(a.file)) - Number(/(^|\/)tests?\//.test(b.file))).slice(0, max);
  }

  chunks: Chunk[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  files = new Set<string>();
  built = false;

  constructor(public root: string) {}

  async build(): Promise<void> {
    const paths: string[] = [];
    await walk(this.root, this.root, paths);
    const chunks: Chunk[] = [];
    this.files = new Set();
    for (const abs of paths) {
      try {
        const st = await fs.stat(abs);
        if (st.size > MAX_FILE_BYTES) continue;
        const content = await fs.readFile(abs, 'utf8');
        if (content.includes('\u0000')) continue;
        const rel = path.relative(this.root, abs).split(path.sep).join('/');
        this.files.add(rel);
        chunks.push(...chunkFile(rel, content, chunks.length));
      } catch {
        /* unreadable file: skip */
      }
    }
    this.chunks = chunks;
    this.df = new Map();
    let total = 0;
    for (const c of chunks) {
      total += c.tokens.length;
      for (const t of new Set(c.tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = chunks.length ? total / chunks.length : 1;
    this.built = true;
  }

  /** BM25 score of one chunk for the query terms; also returns the matched terms (the "why"). */
  private score(c: Chunk, terms: string[], weights: Map<string, number>): { score: number; matched: string[]; all: string[] } {
    const N = this.chunks.length;
    const k1 = 1.2;
    const b = 0.75;
    const tf = new Map<string, number>();
    for (const t of c.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    const matched: { t: string; w: number }[] = [];
    for (const t of terms) {
      const f = tf.get(t);
      if (!f) continue;
      const n = this.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const w = (weights.get(t) ?? 1) * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.tokens.length) / this.avgLen)));
      s += w;
      matched.push({ t, w });
    }
    matched.sort((a, b2) => b2.w - a.w);
    return { score: s, matched: matched.slice(0, 5).map(m => m.t), all: matched.map(m => m.t) };
  }

  search(query: string, budgetTokens = 6000, opts: { maxItems?: number } = {}): RetrievalResult {
    const strategy =
      'BM25 over function/class-level chunks (+ symbol and path boosts), co-change neighbours (tests/docs of hit modules), packed greedily into a token budget with a per-file diversity penalty.';
    const base: RetrievalResult = { query, items: [], budgetTokens, usedTokens: 0, indexedFiles: this.files.size, indexedChunks: this.chunks.length, strategy };
    if (!this.built || this.chunks.length === 0) return base;
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return base;

    // Term weights: literal CONSTANTS in the request (SECRET, PASSWORD, ...) describe values, not the subject
    // of the change, so they count less; `backticked` or snake_case identifiers count more.
    const weights = new Map<string, number>();
    for (const w of query.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []) {
      const isConst = /^[A-Z][A-Z0-9_]{3,}$/.test(w);
      const isIdent = /_/.test(w) || /[a-z][A-Z]/.test(w);
      for (const t of tokenize(w)) weights.set(t, Math.max(weights.get(t) ?? 0, isConst ? 0.35 : isIdent ? 1.6 : 1));
    }
    for (const m of query.matchAll(/`([^`]+)`/g)) for (const t of tokenize(m[1])) weights.set(t, 1.8);

    const raw = this.chunks.map(c => ({ c, ...this.score(c, terms, weights) })).filter(x => x.score > 0);
    const idfOf = (t: string) => Math.log(1 + (this.chunks.length - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5)) * (weights.get(t) ?? 1);
    const totalIdf = terms.reduce((a, t) => a + idfOf(t), 0) || 1;

    // File-level coverage: how many distinct query terms the file's best chunks cover together.
    const byFile = new Map<string, typeof raw>();
    for (const x of raw) (byFile.get(x.c.file) ?? byFile.set(x.c.file, []).get(x.c.file)!).push(x);
    const fileCoverage = new Map<string, number>();
    const fileScore = new Map<string, number>();
    for (const [f, xs] of byFile) {
      const top = [...xs].sort((a, b) => b.score - a.score).slice(0, 3);
      const cov = new Set(top.flatMap(x => x.all));
      fileCoverage.set(f, [...cov].reduce((a, t) => a + idfOf(t), 0) / totalIdf);
      fileScore.set(f, top.reduce((a, x) => a + x.score, 0) * (0.5 + (fileCoverage.get(f) ?? 0)));
    }
    const scored = raw
      .map(x => ({ ...x, score: x.score * (0.5 + (fileCoverage.get(x.c.file) ?? 0)) }))
      .sort((a, b) => b.score - a.score);
    const rankedFiles = [...fileScore.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);

    // Co-change neighbours: tests/docs that share a module name with the strongest hits.
    const topFiles = rankedFiles.slice(0, 3);
    const neighbours = new Map<string, string>();
    for (const f of topFiles) {
      const stem = path.posix.basename(f).replace(/\.[^.]+$/, '');
      for (const cand of this.files) {
        if (cand === f) continue;
        const cs = path.posix.basename(cand).replace(/\.[^.]+$/, '');
        const isTest = /(^|\/)tests?\//.test(cand) && (cs === `test_${stem}` || cs === `${stem}_test` || cs === `test${stem}`);
        const isDoc = /(^|\/)docs?\//.test(cand) && cs === stem && /\.(rst|md)$/.test(cand);
        if (isTest) neighbours.set(cand, `test file for ${f}`);
        if (isDoc) neighbours.set(cand, `docs page for ${f}`);
      }
    }
    const neighbourScore = (scored[0]?.score ?? 1) * 0.55;
    const pool = scored.slice(0, 120).map(x => ({ c: x.c, score: x.score, reasons: x.matched.length ? [`matches: ${x.matched.join(', ')}`] : [] }));
    for (const [file, why] of neighbours) {
      const inFile = scored.filter(x => x.c.file === file).slice(0, 2);
      if (inFile.length) {
        for (const x of inFile) {
          const p = pool.find(q => q.c.id === x.c.id);
          if (p) {
            p.score += neighbourScore * 0.5;
            p.reasons.push(why);
          } else pool.push({ c: x.c, score: x.score + neighbourScore * 0.5, reasons: [`matches: ${x.matched.join(', ')}`, why] });
        }
      } else {
        const first = this.chunks.find(c => c.file === file);
        if (first) pool.push({ c: first, score: neighbourScore, reasons: [why] });
      }
    }
    pool.sort((a, b) => b.score - a.score);
    const bumped = new Set<number>();
    for (const f of topFiles) {
      const best = pool.find(p => p.c.file === f);
      if (best && !bumped.has(best.c.id)) {
        bumped.add(best.c.id);
        best.score = (pool[0]?.score ?? best.score) * 1.01;
        best.reasons.push(`top-ranked file (covers ${Math.round((fileCoverage.get(f) ?? 0) * 100)}% of the request's terms)`);
      }
    }
    pool.sort((a, b) => b.score - a.score);

    const perFile = new Map<string, number>();
    const items: RetrievedItem[] = [];
    let used = 0;
    const maxItems = opts.maxItems ?? 14;
    const remaining = [...pool];
    while (remaining.length && items.length < maxItems) {
      // pick best after diversity penalty (0.75^k for the k-th chunk of the same file)
      let bestIdx = 0;
      let bestAdj = -1;
      for (let i = 0; i < remaining.length; i++) {
        const adj = remaining[i].score * Math.pow(0.75, perFile.get(remaining[i].c.file) ?? 0);
        if (adj > bestAdj) {
          bestAdj = adj;
          bestIdx = i;
        }
      }
      const pick = remaining.splice(bestIdx, 1)[0];
      const tokens = estimateTokens(pick.c.text) + 12;
      if (used + tokens > budgetTokens) continue;
      used += tokens;
      perFile.set(pick.c.file, (perFile.get(pick.c.file) ?? 0) + 1);
      items.push({ file: pick.c.file, startLine: pick.c.startLine, endLine: pick.c.endLine, symbol: pick.c.symbol, score: Math.round(pick.score * 100) / 100, reasons: pick.reasons, tokens, text: pick.c.text });
    }
    items.sort((a, b) => (a.file === b.file ? a.startLine - b.startLine : 0));
    return { ...base, items, usedTokens: used };
  }
}

/** Human/agent-readable rendering of a retrieval result (line-numbered snippets with reasons). */
export function formatRetrieval(r: RetrievalResult, withText = true): string {
  const head = `Retrieved ${r.items.length} snippet(s) from ${new Set(r.items.map(i => i.file)).size} file(s) — ${r.usedTokens}/${r.budgetTokens} token budget used (${r.indexedFiles} files, ${r.indexedChunks} chunks indexed).`;
  const body = r.items
    .map(i => {
      const title = `### ${i.file}:${i.startLine}-${i.endLine}${i.symbol ? `  (${i.symbol})` : ''}  [score ${i.score}; ${i.reasons.join('; ')}]`;
      if (!withText) return title;
      const numbered = i.text
        .split('\n')
        .map((l, k) => `${String(i.startLine + k).padStart(5)}  ${l}`)
        .join('\n');
      return `${title}\n${numbered}`;
    })
    .join('\n\n');
  return `${head}\n\n${body}`;
}

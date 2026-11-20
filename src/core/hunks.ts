import { diffLines } from 'diff';

/** One reviewable change: a run of removed and/or added lines between two unchanged stretches. */
export interface Hunk {
  id: number;
  /** 1-based line number in the ORIGINAL file where this hunk starts. */
  oldStart: number;
  /** 1-based line number in the PROPOSED file where this hunk starts. */
  newStart: number;
  removed: string[];
  added: string[];
}

type Segment = { kind: 'same'; text: string } | { kind: 'change'; hunk: number; removedText: string; addedText: string };

export interface HunkSet {
  original: string;
  proposed: string;
  hunks: Hunk[];
  segments: Segment[];
}

const splitLines = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** Split the difference between two texts into independently reviewable hunks. */
export function computeHunks(original: string, proposed: string): HunkSet {
  const parts = diffLines(original, proposed);
  const segments: Segment[] = [];
  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      segments.push({ kind: 'same', text: part.value });
      const n = part.count ?? splitLines(part.value).length;
      oldLine += n;
      newLine += n;
      i++;
      continue;
    }
    let removedText = '';
    let addedText = '';
    const oldStart = oldLine;
    const newStart = newLine;
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      const p = parts[i];
      const n = p.count ?? splitLines(p.value).length;
      if (p.removed) {
        removedText += p.value;
        oldLine += n;
      } else {
        addedText += p.value;
        newLine += n;
      }
      i++;
    }
    const id = hunks.length;
    hunks.push({ id, oldStart, newStart, removed: splitLines(removedText), added: splitLines(addedText) });
    segments.push({ kind: 'change', hunk: id, removedText, addedText });
  }
  return { original, proposed, hunks, segments };
}

/** Rebuild the file content with only the accepted hunks applied. */
export function composeContent(set: HunkSet, accepted: ReadonlySet<number>): string {
  let out = '';
  for (const seg of set.segments) {
    if (seg.kind === 'same') out += seg.text;
    else out += accepted.has(seg.hunk) ? seg.addedText : seg.removedText;
  }
  return out;
}

/** Plain-text unified-style preview of one hunk (used in chat cards). */
export function renderHunk(h: Hunk): string {
  const head = `@@ -${h.oldStart},${h.removed.length} +${h.newStart},${h.added.length} @@`;
  return [head, ...h.removed.map(l => `- ${l}`), ...h.added.map(l => `+ ${l}`)].join('\n');
}

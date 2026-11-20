export interface TextEdit {
  old_text: string;
  new_text: string;
}

export type PlanResult = { ok: true; proposed: string } | { ok: false; error: string };

/**
 * Apply search/replace edits to `original` in memory. Every `old_text` must match exactly once
 * (so the agent never silently edits the wrong place). Nothing touches disk here.
 */
export function planEdits(original: string, edits: TextEdit[]): PlanResult {
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, error: 'No edits were provided.' };
  let text = original;
  for (let i = 0; i < edits.length; i++) {
    const { old_text, new_text } = edits[i] ?? ({} as TextEdit);
    if (typeof old_text !== 'string' || typeof new_text !== 'string' || old_text === '') {
      return { ok: false, error: `Edit #${i + 1}: old_text and new_text must be strings and old_text must not be empty.` };
    }
    const first = text.indexOf(old_text);
    if (first === -1) {
      return {
        ok: false,
        error: `Edit #${i + 1}: old_text was not found in the file. Re-read the file with read_file and copy the text exactly (including indentation).`,
      };
    }
    if (text.indexOf(old_text, first + 1) !== -1) {
      return {
        ok: false,
        error: `Edit #${i + 1}: old_text matches more than once. Include more surrounding lines so it matches exactly one place.`,
      };
    }
    text = text.slice(0, first) + new_text + text.slice(first + old_text.length);
  }
  return { ok: true, proposed: text };
}

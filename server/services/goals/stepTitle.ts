/**
 * The title a person reads for a reconstruction change in a plan's steps.
 *
 * A change's `label` is the reconstruction's own key ("focus:4",
 * "price×2.50@SMALL_TICKET", "deposit", "referral-partner>arr_…"): it
 * identifies the change across the sweep and the engine, and it was being
 * printed as the step's name (production plan reads, 2026-11-19, goal
 * wst_4f0c312400e1425dab2e). The key stays the identity; the title is read
 * from the change's own description, which already says what to do in words.
 */

/** The first clause of `text`: up to the first `:`, `;` or `, ` outside parentheses and double quotes. */
function firstClause(text: string): string {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ':' || ch === ';' || (ch === ',' && text[i + 1] === ' '))) return text.slice(0, i);
  }
  return text;
}

/** A readable step title for a change; falls back to the key with its punctuation spoken. */
export function changeTitle(change: { label: string; detail?: string | null }): string {
  const clause = firstClause((change.detail ?? '').trim()).trim();
  const words = clause.length >= 8
    ? clause
    : change.label.replace(/[>@:_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const titled = words.charAt(0).toUpperCase() + words.slice(1);
  return titled.length > 120 ? `${titled.slice(0, 117).trimEnd()}…` : titled;
}

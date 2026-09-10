/**
 * Where something is, read rather than guessed.
 *
 * ---------------------------------------------------------------------------
 * Why this is its own module
 * ---------------------------------------------------------------------------
 *
 * The compiler used to hold the state list privately and look for one in the
 * *question's prose*. That was the whole of Brain's idea of jurisdiction, and it
 * had two consequences that only showed up once real records arrived from a
 * connected site:
 *
 *   * a record whose own row says `state: "OH"` was read as naming no
 *     jurisdiction at all, because `OH` is not the word `ohio`; and
 *   * naming none fell back to the envelope's, so a compiled objective read
 *     *"Establish, from official Michigan public records, … Brightpath Family
 *     Dental … in Westbrook, OH"*. Brain asserted a jurisdiction the subject
 *     did not have, and research against it would have answered a different
 *     question correctly.
 *
 * So the vocabulary lives here, shared, and both readers use the same one: the
 * subject resolver that reads a row, and the compiler that reads prose. A
 * disagreement between the two is then a real disagreement rather than an
 * artifact of two different lists.
 *
 * ---------------------------------------------------------------------------
 * A field and a sentence are not read the same way
 * ---------------------------------------------------------------------------
 *
 * In a **structured field** a two-letter code is unambiguous: the column means
 * a state, so `OH` is Ohio. In **prose** it is not, and treating it as one
 * would be worse than the bug this fixes — `or`, `in`, `me`, `hi`, `de`, `pa`,
 * `ok`, `al`, `ms` and `mt` are all ordinary English. So prose matches full
 * names, plus the one form that is unambiguous by construction: a postal
 * abbreviation immediately after a comma, as in `Westbrook, OH`.
 *
 * Nothing here decides whether a jurisdiction is *allowed*. That is the
 * approval envelope's, and it stays there.
 */

/** The fifty states, plus the district, lowercase. */
export const US_STATES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
  'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan',
  'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina',
  'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island',
  'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'west virginia', 'wisconsin', 'wyoming', 'district of columbia',
] as const;

export type UsState = (typeof US_STATES)[number];

/** Postal code to state, for a field that means a state. */
const BY_CODE: Readonly<Record<string, UsState>> = Object.freeze({
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california',
  co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia',
  hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas',
  ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts',
  mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri', mt: 'montana',
  ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico',
  ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma',
  or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina',
  sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont',
  va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
  dc: 'district of columbia',
});

/** `ohio` -> `Ohio`, `new york` -> `New York`. The form every caller displays. */
export function properName(state: UsState): string {
  return state.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/**
 * Read a jurisdiction out of a field that means one.
 *
 * A code, a name, or a name with surrounding punctuation. Anything else is
 * `null` — a field this cannot read is not a jurisdiction Brain may assert, and
 * the honest answer is that it does not know.
 */
export function stateFromField(value: unknown): UsState | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase().replace(/[.]/g, '');
  if (!text) return null;
  if (text.length === 2) return BY_CODE[text] ?? null;
  const named = US_STATES.find((state) => state === text);
  return named ?? null;
}

/**
 * Read a jurisdiction out of a place, as a site writes one.
 *
 * `Westbrook, OH`, `Oakland County, Michigan`, `Detroit, MI 48226`. The state is
 * whatever follows the last comma, which is the one position a postal
 * abbreviation is unambiguous in. A string with no comma is read as a bare name
 * only, never as a code.
 */
export function stateFromPlace(value: unknown): UsState | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    // Trailing postcode is dropped: `MI 48226` is Michigan.
    const tail = parts[parts.length - 1]!.replace(/\s+\d{5}(-\d{4})?$/, '');
    const found = stateFromField(tail);
    if (found) return found;
  }
  /*
   * No comma, so no postal position — a full name only.
   *
   * A `location` is free text somebody typed, and a bare two-letter value in it
   * is not reliably a state. The column that *means* a state is
   * `stateFromField`, and that is where a code is authoritative.
   */
  const text = value.trim().toLowerCase().replace(/[.]/g, '');
  return US_STATES.find((state) => state === text) ?? null;
}

/**
 * Every jurisdiction a piece of prose names, in the order the list declares.
 *
 * Full names anywhere, and a postal abbreviation only in the `…, OH` form. Two
 * results mean the text genuinely names two, which is a decomposition decision
 * rather than something to pick between — the caller refuses rather than
 * choosing.
 */
export function statesNamedIn(text: string): UsState[] {
  const found = new Set<UsState>();
  for (const state of US_STATES) {
    if (new RegExp(`\\b${state}\\b`, 'i').test(text)) found.add(state);
  }
  /*
   * `, OH` — a comma, optional space, two **capital** letters, a word boundary.
   *
   * The capitals are load-bearing and the first version of this rule did not
   * have them. Without them `do we roof this, or not` reads as Oregon, `the
   * work is in progress` as Indiana, and `write to me, hi there` as Hawaii —
   * every one of them a comma followed by an ordinary English word. A postal
   * abbreviation is written in capitals; the words are not.
   *
   * This is a secondary signal in any case. The authoritative reading is the
   * structured field a row carries, which does not go through here.
   */
  for (const match of text.matchAll(/,\s*([A-Z]{2})\b/g)) {
    const state = stateFromField(match[1]);
    if (state) found.add(state);
  }
  return US_STATES.filter((state) => found.has(state));
}

/**
 * Is this phrase something Brain would *do*, or something the sources are
 * *about*?
 *
 * ---------------------------------------------------------------------------
 * Why the distinction has to exist
 * ---------------------------------------------------------------------------
 *
 * An approval envelope forbids Brain acting on the world: no spending, no
 * contact, no purchase, no commitment, no publication. `forbiddenActions` is
 * the planning-time screen for that, and it worked by testing a regular
 * expression against a fragment's question, definitions, population and
 * completion criteria.
 *
 * Every one of those fields says what to *look for* and what *counts*. None of
 * them says what Brain will do. So for a statutory subject the screen was
 * harmless — nothing about a licensing statute mentions buying anything — and
 * for a commercial one it was structurally mis-aimed. Production measured the
 * cost: a fragment asking which government surplus listings are open was
 * refused for "describes an action outside reading published sources", because
 * a surplus auction *is* a purchase and the word appears in any honest
 * description of one. Six of ten correctly-shaped discovery plans were refused
 * at the planning pass, on phrases and source types like these, before a single
 * source was read.
 *
 * ---------------------------------------------------------------------------
 * The rule, in two lines
 * ---------------------------------------------------------------------------
 *
 * A forbidden phrase is **Brain's own action** unless something between the
 * start of its clause and the phrase itself turns it into a described thing —
 * a governor: *about*, *whether*, *how to*, *available to*, *evidence of*,
 * *showing*, or a source saying, stating, permitting or requiring it. A clause
 * that **negates** the phrase does not instruct it either: *"Do not file
 * attention as purchase"* is a prohibition, and refusing a plan for carrying
 * one is exactly backwards. And it is Brain's own action regardless, whenever
 * the researcher is named as the subject immediately before it, because
 * *"…and we will then contact the seller"* is an instruction however the
 * sentence opened — so that check still runs first, and a plan cannot talk its
 * way past it by putting a negator earlier in the same clause.
 *
 * So *"Email the seller and ask their price"* is refused, and *"Record what the
 * listing says about how to place a bid"* is not, because the bidding is the
 * listing's rather than Brain's.
 *
 * The negation is `services/russell/negation.ts`, which is where this
 * repository already keeps "not this, scoped to the words it governs" — the
 * execution gate and the target resolver share it for the reason a third copy
 * here would fail: a rule applied by one of several readers is worse than none.
 *
 * ---------------------------------------------------------------------------
 * Why narrowing a screen is the safe direction here
 * ---------------------------------------------------------------------------
 *
 * Because **this was never the enforcement.** What actually stops Brain
 * spending or contacting anybody is that the standing grant unions
 * `ALWAYS_PROHIBITED` in and writes `max_external_spend = 0` as a literal, that
 * every commercial effect needs a separate grant a person makes deliberately,
 * and that no tool on the MCP surface performs one. This is a planning-time
 * screen standing in front of all three.
 *
 * The failure mode is therefore **admitting a plan whose effects are blocked
 * anyway**, never permitting an effect. The tests pin the refusals rather than
 * the admissions, for the reason §27 gives about a closed list: a miss costs a
 * sentence, an invention costs a person's trust in the control.
 *
 * ---------------------------------------------------------------------------
 * The second widening, and why the question was not reworded instead
 * ---------------------------------------------------------------------------
 *
 * The social commerce kernel's demand round is the one question in this
 * repository whose whole subject is the difference between what was watched
 * and what was *bought*, so it says the word in three separate places, and all
 * three were read as instructions: *"where a product has large attention and
 * no evidence of purchase, report that too"*, *"Do not file attention as
 * purchase"*, and *"A product with attention and nothing showing a purchase is
 * reported that way rather than omitted"*. None of them asks anybody to buy
 * anything and one of them is a prohibition. The plan parked at `NEEDS_HUMAN`
 * before a source was read.
 *
 * Rewording the question to dodge the list was available and is refused, for
 * the reason §24 and §27 record four times over about `EXECUTION_MARKERS` and
 * the capture verbs: **the sentence that found the gap is never reworded to
 * fit the list, because rewording is gaming the list — what changes is Brain.**
 * The widening is the two governors those strings actually needed and the
 * negation rule this repository already had, and no more.
 */

import { NEGATORS, clauseBefore } from '../russell/negation.ts';

/**
 * Where one clause ends and the next begins.
 *
 * Sentences, semicolons, newlines and dashes. Commas are deliberately **not**
 * boundaries: "what the terms say about rights, delivery and purchase" is one
 * clause, and splitting it at the comma would leave a fragment beginning
 * "delivery and purchase" with its governor stranded on the other side.
 */
const CLAUSE_BOUNDARY = /[.;\n—–]/;

/**
 * A subject that means Brain, followed by an optional modal and one adverb.
 *
 * Anchored to the end of the text before the match, so it is the *immediately*
 * preceding subject rather than one anywhere in the clause. "Record what the
 * buyer said we should purchase" is the buyer's sentence; "…and we should
 * purchase it" is Brain's. The difference is whose clause the verb sits in,
 * and the anchor is what keeps it.
 *
 * The adverb is a correction rather than a widening, and it came from this
 * module's own docblock: *"…and we will then contact the seller"* is given up
 * there as the example of an instruction that wins however the sentence
 * opened, and it was **admitted**, because `then` sat between the modal and
 * the verb and broke the anchor — leaving the `about` forty characters
 * upstream to govern it. A comment stating a rule the code does not apply is
 * the half-truth this repository keeps correcting, so the code was moved to
 * the comment. The list is closed and short for the reason every list here is.
 */
const RESEARCHER_SUBJECT =
  /\b(?:we|i|you|brain|the researcher|the worker|this fragment|this research)\s+(?:will|shall|must|should|may|can|are to|is to|would|could)?\s*(?:then|also|next|first|afterwards|subsequently|additionally)?\s*$/i;

/**
 * What turns the phrase into a thing being described rather than done.
 *
 * Deliberately short, and every entry earns its place against a real
 * production string. `for` and `of` are absent because they appear in almost
 * every sentence and would admit anything; `on` likewise.
 *
 * `evidence of|that` and `show(s|ing|n)` are the second widening, and they are
 * safe in the way the others are: neither can carry an instruction. There is
 * no sentence in which *"evidence of X"* or *"nothing showing X"* asks anybody
 * to do X — both name X as the thing a source would have to establish, which
 * is the definition of subject matter.
 */
const GOVERNOR =
  /\b(?:about|whether|how\s+to|where\s+to|when\s+to|regarding|concerning|available|eligible|offered|advertised|listed|for\s+sale|says?|said|states?|stating|explains?|describ(?:es?|ing)|evidence\s+(?:of|that)|shows?|showing|shown|permits?|allows?|requires?|prohibits?|invites?|solicits?|accepts?)\b/i;

/** Leading list markers and whitespace, which do not change who is acting. */
const LEADING_FILLER = /^(?:\s|[-*•]|\d+[.)])+/;

/**
 * How far back a governor can reach.
 *
 * A governor attaches locally — *about* X, *how to* X, *available to* X — so it
 * is looked for in the text immediately before the phrase rather than anywhere
 * in the clause. Without the window, one long sentence poisons its own end:
 * *"…how long after a deed is recorded it becomes available in the public
 * electronic index, and email the register of deeds to confirm"* has
 * `available` forty-odd characters upstream of an instruction to send an email,
 * and read as a governor it would admit exactly the thing the screen exists to
 * refuse.
 *
 * Forty characters is measured against the phrasings that have to work rather
 * than derived: the governors in the admitted cases sit 7 to 20 characters
 * before their phrase, and the one in the refused case sits at 47.
 */
const GOVERNOR_WINDOW = 40;

export interface OwnActionMatch {
  /** The exact phrase the pattern matched, so a refusal can quote it. */
  phrase: string;
  /** The clause it was found in, trimmed, so a reader can see the context. */
  clause: string;
}

/**
 * Every occurrence of `pattern` in `prose` that reads as Brain's own action.
 *
 * `pattern` is scanned with a global, case-insensitive copy of itself, so a
 * caller may pass the plain envelope regex without thinking about `lastIndex`.
 */
export function ownActionMatches(prose: string, pattern: RegExp): OwnActionMatch[] {
  const scanner = new RegExp(pattern.source, scanFlags(pattern.flags));
  const out: OwnActionMatch[] = [];
  for (const match of prose.matchAll(scanner)) {
    const at = match.index ?? 0;
    const clauseStart = clauseStartBefore(prose, at);
    const before = prose.slice(clauseStart, at);
    if (!isOwnAction(before)) continue;
    out.push({
      phrase: match[0],
      clause: prose.slice(clauseStart, clauseEndAfter(prose, at)).trim(),
    });
  }
  return out;
}

/** The convenience every caller of the screen actually wants. */
export function describesOwnAction(prose: string, pattern: RegExp): boolean {
  return ownActionMatches(prose, pattern).length > 0;
}

/** The pattern's own flags, plus the two this scan needs, without duplicates. */
function scanFlags(flags: string): string {
  return [...new Set([...flags.replace(/y/g, ''), 'g', 'i'])].join('');
}

function clauseStartBefore(prose: string, at: number): number {
  for (let index = at - 1; index >= 0; index -= 1) {
    if (CLAUSE_BOUNDARY.test(prose[index]!)) return index + 1;
  }
  return 0;
}

function clauseEndAfter(prose: string, at: number): number {
  for (let index = at; index < prose.length; index += 1) {
    if (CLAUSE_BOUNDARY.test(prose[index]!)) return index;
  }
  return prose.length;
}

/**
 * Does the text before the match leave the phrase as an instruction to Brain?
 *
 * The researcher named immediately before wins outright — deliberately ahead
 * of the negation, so *"we will not contact the seller"* stays refused. That
 * is the conservative direction and it costs nothing: a plan that promises not
 * to do a thing loses nothing by being asked to say so somewhere other than
 * the four fields this screen reads.
 *
 * Then a negator anywhere in the clause makes the phrase a prohibition rather
 * than an instruction; then a governor within `GOVERNOR_WINDOW` characters
 * makes it subject matter; otherwise it is an instruction, which includes the
 * clause-initial imperative and the second verb of "find the listing and
 * purchase it".
 */
function isOwnAction(before: string): boolean {
  const head = before.replace(LEADING_FILLER, '');
  if (RESEARCHER_SUBJECT.test(head)) return true;
  /*
   * Past the last contrast marker, which is the half of the rule that keeps a
   * negation from reaching a clause it does not govern: *"Do not contact the
   * seller, but record what the listing says"* negates the first and not the
   * second. `clauseBefore` is the shared implementation and the sentence split
   * it does first is a no-op here, because `clauseStartBefore` already made one.
   */
  if (NEGATORS.test(clauseBefore(head, head.length))) return false;
  return !GOVERNOR.test(head.slice(-GOVERNOR_WINDOW));
}

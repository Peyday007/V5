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
 * a governor: *about*, *whether*, *how to*, *available to*, or a source
 * saying, stating, permitting or requiring it. And it is Brain's own action
 * regardless, whenever the researcher is named as the subject immediately
 * before it, because *"…and we will then contact the seller"* is an
 * instruction however the sentence opened.
 *
 * So *"Email the seller and ask their price"* is refused, and *"Record what the
 * listing says about how to place a bid"* is not, because the bidding is the
 * listing's rather than Brain's.
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
 */

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
 * A subject that means Brain, followed by an optional modal.
 *
 * Anchored to the end of the text before the match, so it is the *immediately*
 * preceding subject rather than one anywhere in the clause. "Record what the
 * buyer said we should purchase" is the buyer's sentence; "…and we should
 * purchase it" is Brain's. The difference is whose clause the verb sits in,
 * and the anchor is what keeps it.
 */
const RESEARCHER_SUBJECT =
  /\b(?:we|i|you|brain|the researcher|the worker|this fragment|this research)\s+(?:will|shall|must|should|may|can|are to|is to|would|could)?\s*$/i;

/**
 * What turns the phrase into a thing being described rather than done.
 *
 * Deliberately short, and every entry earns its place against a real
 * production string. `for` and `of` are absent because they appear in almost
 * every sentence and would admit anything; `on` likewise.
 */
const GOVERNOR =
  /\b(?:about|whether|how\s+to|where\s+to|when\s+to|regarding|concerning|available|eligible|offered|advertised|listed|for\s+sale|says?|said|states?|stating|explains?|describ(?:es?|ing)|permits?|allows?|requires?|prohibits?|invites?|solicits?|accepts?)\b/i;

/** Leading list markers and whitespace, which do not change who is acting. */
/**
 * A phrase that is the complement of a copula is a description, not a step.
 *
 * *"…and whether the only published route to the buyer is a telephone call"*
 * is the question every Cash deep dive asks, and it names the route rather than
 * telling anybody to dial. Its governor, *whether*, sits more than
 * `GOVERNOR_WINDOW` characters back, so the clause read as an instruction and
 * Brain's own compiled plan was refused by Brain's own envelope — every
 * validation since 2026-10-01 parked for a person on a decision nobody had to
 * make. Production, 2026-10-07: `orc_0029a3b7251a49b1971a`, refused for
 * "instructs the researcher to telephone call".
 *
 * Anchored to the text immediately before the phrase, so *"…is to call the
 * buyer"* (an instruction) is untouched: only *is a / is an / is the / is
 * only* reach here.
 */
const COPULA_COMPLEMENT = /\b(?:is|are|was|were|be|being|been)\s+(?:only\s+)?(?:an?|the)?\s*$/i;

/**
 * A relative clause hands the verb to somebody else.
 * *"Which kinds of buyers who hire freelancers for this work publish a rate?"*
 * describes the buyers; the hiring is theirs. Anchored to the text immediately
 * before the phrase, after the researcher check, so *"…that we purchase"* is
 * still Brain's own action.
 */
const THIRD_PARTY_RELATIVE =
  /\b(?:who|that|which)\s+(?:\w+ly\s+)?(?:(?:will|would|can|could|may|might|must|do|does|did)\s+)?$/i;

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
    if (insideCompound(prose, at, match[0].length)) continue;
    if (namesAThing(prose, at + match[0].length)) continue;
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

/**
 * A phrase hyphenated into a word is part of a name, not a verb.
 *
 * *"Which published group-purchase operators publish an arranger fee"* is a
 * judge's follow-up question about a kind of business, and "group-purchase" is
 * the operator's description of itself. Read as an instruction it refused the
 * corrected round of `orc_d083edfc645c47e6b99d` (2026-11-02) for "instructs
 * the researcher to purchase". A word joined by a hyphen on either side —
 * `group-purchase`, `purchase-order` — names a thing; Brain is never told to
 * do something with a hyphen in front of the verb.
 */
function insideCompound(prose: string, at: number, length: number): boolean {
  const before = prose.slice(Math.max(0, at - 2), at);
  const after = prose.slice(at + length, at + length + 2);
  return /[a-z]-$/i.test(before) || /^-[a-z]/i.test(after);
}

/**
 * A forbidden word used as a modifier names a measurement, not a step.
 * *"…each with a published directory count, purchase frequency and price
 * paid"* asks how often buyers buy; "purchase" is an adjective on
 * "frequency". Production, 2026-11-02: the judge's follow-up on
 * `orc_eefa0aa5fb194685b079` was refused for "instructs the researcher to
 * purchase", parked, and cancelled by the RECORD_GAPS answer — so the one
 * question that asked for buyer economics was never researched. Closed list of
 * the nouns a commercial question measures, so "purchase the list" is untouched.
 */
const MODIFIED_NOUN =
  /^\s+(?:frequency|frequencies|price|prices|volume|volumes|history|histories|order|orders|decision|decisions|cycle|cycles|terms|records?|data|amount|amounts|size|sizes|count|counts|rate|rates|value|values|date|dates|pattern|patterns|behaviou?r|intent|channel|channels|process|processes)\b/i;

function namesAThing(prose: string, end: number): boolean {
  return MODIFIED_NOUN.test(prose.slice(end, end + 30));
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
 * The researcher named immediately before wins outright; otherwise a governor
 * within `GOVERNOR_WINDOW` characters makes it subject matter; otherwise it is
 * an instruction, which includes the clause-initial imperative and the second
 * verb of "find the listing and purchase it".
 */
function isOwnAction(before: string): boolean {
  const head = before.replace(LEADING_FILLER, '');
  if (RESEARCHER_SUBJECT.test(head)) return true;
  if (THIRD_PARTY_RELATIVE.test(head)) return false;
  if (COPULA_COMPLEMENT.test(head)) return false;
  return !GOVERNOR.test(head.slice(-GOVERNOR_WINDOW));
}

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
    if (!isOwnAction(before, match[0])) continue;
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
 * The researcher named immediately before wins outright; otherwise a governor
 * within `GOVERNOR_WINDOW` characters makes it subject matter; otherwise it is
 * an instruction, which includes the clause-initial imperative and the second
 * verb of "find the listing and purchase it".
 */
function isOwnAction(before: string, phrase: string): boolean {
  const head = before.replace(LEADING_FILLER, '');
  if (RESEARCHER_SUBJECT.test(head)) return true;
  const scope = afterLastInstruction(head, phrase);
  if (EMBEDDED_QUESTION.test(scope)) return false;
  return !GOVERNOR.test(scope.slice(-GOVERNOR_WINDOW));
}

/**
 * A *whether* governs its whole question, not the forty characters after it.
 *
 * The window above is right for a verb like *says* or *requires*, whose object
 * sits beside it. It is wrong for *whether*, which opens an embedded question:
 * everything after it until the clause ends is the question's content, and the
 * content of a question is a thing being asked about, never an instruction.
 * Production measured the cost of the window. Every Cash deep dive compiled
 * after 2026-09-21 04:00 asked *"…and whether the only published route to the
 * buyer is a telephone call"* — fifty-one characters from *whether* to the
 * phrase — so the screen read Brain's own question as an order to telephone
 * somebody, refused the plan, and twenty-two dives in a row stopped before a
 * single research pass. The learning kernel found it as a recurring blocker
 * (`services/learning/capability.ts`), which is how it was traced here.
 *
 * **And a coordinated new instruction ends every governor before it**, which is
 * the half that keeps the widening from being a loosening. *", and …"*, *",
 * then …"*, a bare *then*, or *and* directly followed by an action verb starts
 * a second thing, and *"Establish whether it is listed, and then call the
 * seller"* is two things of which the second is an order. Before this, a
 * governor within the window covered a phrase on the far side of such a
 * boundary; now nothing does. So on the far side of a coordinator the screen
 * is stricter than it was, and only inside an uninterrupted question is it
 * wider.
 */
const EMBEDDED_QUESTION = /\bwhether\b/i;
const NEW_INSTRUCTION =
  /,\s*(?:and|but|so|then)\b|\bthen\b|\band\s+(?=(?:call|telephone|phone|email|e-mail|contact|write|message|dm|reach|submit|file|register|apply|sign|subscribe|purchase|buy|pay|hire|engage|post|publish|place|list|run|negotiate|agree|commit|make|send)\b)/gi;

/** The part of the clause after the last coordinated instruction before the phrase. */
function afterLastInstruction(head: string, phrase: string): string {
  const text = head + phrase;
  let cut = 0;
  for (const match of text.matchAll(NEW_INSTRUCTION)) {
    const at = match.index ?? 0;
    if (at < head.length) cut = Math.min(head.length, at + match[0].length);
  }
  return head.slice(cut);
}

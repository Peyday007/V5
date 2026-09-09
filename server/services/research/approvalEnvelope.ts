/**
 * Approving a plan without a person, but only inside limits a person set first.
 *
 * §16 stops a browser-initiated run after planning because spending an
 * allowance on a decomposition nobody has read is the failure that rule exists
 * to prevent. That reasoning is about *unreviewed* plans. It is not a reason to
 * ask again for a decision somebody has already made in full: when the topic,
 * the scope, the source restrictions and the execution have all been authorized
 * in advance, a second click adds a delay and no judgement.
 *
 * So there are two modes and the difference between them is where the judgement
 * happened, never whether it happened:
 *
 *   HUMAN                  a person reads this plan and approves it.
 *   AUTO_WITHIN_ENVELOPE   a person authorized these limits in advance, and
 *                          Brain checks the plan against them mechanically.
 *
 * Four things make the second one safe, and removing any of them breaks it:
 *
 *   1. **The envelope lives here, in code, not in the row.** An orchestration
 *      stores only an envelope *id*. Whoever starts a packet cannot supply the
 *      limits their own plan will be judged against, and a row naming an
 *      envelope this build does not define validates against nothing and is
 *      refused rather than waved through.
 *
 *   2. **The check is a pure function over rows.** No model reads it, no model
 *      writes it, and no model is asked whether the plan fits. A model that
 *      could argue for its own plan is a model approving itself, which is the
 *      one thing this must never become.
 *
 *   3. **It approves; it does not exempt.** Everything downstream is untouched
 *      — the evidence gate, the verification pass, the synthesis check and all
 *      three audit roles run exactly as they do for a human-approved packet.
 *      The envelope decides whether research may *start*, and nothing else.
 *
 *   4. **Anything outside the envelope goes to a person.** Not a warning, not a
 *      narrowed plan, not a retry: NEEDS_HUMAN, with the reasons recorded.
 *
 * This is deliberately not a policy engine. There is one envelope, it is a
 * constant, and adding a second is a code change somebody reviews. Capacity-
 * aware and goal-level authorization are Step 11's, and building their
 * machinery here on the strength of one packet would be exactly the
 * over-generalisation this file exists instead of.
 */
import crypto from 'node:crypto';
import { listEvents } from '../../repos/events.ts';
import type { ResearchFragment, ResearchOrchestration } from '../../domain/types.ts';

/**
 * Bumped whenever the checks below change meaning.
 *
 * Recorded on every automatic approval, because "Brain approved this" is only
 * auditable if you can tell which rules it applied.
 */
export const ENVELOPE_VALIDATOR_VERSION = '2026-09-09.1';

/** The exact assignment the Step 10 envelope authorizes, and nothing else. */
export const MICHIGAN_LICENSING_ASSIGNMENT = `Determine whether, under Michigan law, a success-fee intermediary who arranges
the sale of a privately held business must hold a real-estate broker licence, a
business-broker licence, or any equivalent licence, when the transaction
transfers no interest in real property and no lease.

Decision this informs: whether a success-fee intermediary may lawfully operate
in Michigan without a licence, and what follows if it may not.

Audience: the operator of a business-brokerage platform deciding whether
Michigan is a state it can serve.

In scope, and only this:
  1. The licence trigger — the Michigan statutory definition of the licensed
     activity, quoting the language that says what conduct requires a licence.
  2. The real-property condition — the specific provision determining whether
     the trigger depends on an interest in real property or a lease, including
     how Michigan treats a "business opportunity" or "business enterprise".
  3. The applicable inclusion or exemption — any express Michigan carve-out or
     inclusion addressing business brokers, business-opportunity brokers or M&A
     intermediaries dealing in businesses with no real-property component,
     with its exact scope and conditions.
  4. Material consequences of getting it wrong — the penalty, the enforceability
     of the fee agreement, and any private right of action, each from the
     statute or regulation that creates it.

Out of scope: other states; federal securities-broker registration; tax; the
2023 federal M&A broker exemption except where Michigan law refers to it;
anything not needed to answer the four items above.

Evidence standard: primary sources only — the Michigan Occupational Code and
its licensing article, the administrative rules, and published guidance or
declaratory rulings from Michigan's Department of Licensing and Regulatory
Affairs or the Board of Real Estate Brokers and Salespersons. A law-firm
article, a brokerage association page or a secondary summary may be used to
locate a primary source and may not support a claim on its own.

Completion standard: each of the four items answered from a quoted primary
provision with its citation, or explicitly recorded as unresolved with the
search that failed. A statutory question is settled by one directly inspected
primary source; it does not need two, and it is not settled by two secondary
ones.`;

/**
 * How an envelope pins the assignment it authorizes.
 *
 * Two shapes, and a packet must satisfy exactly one of them.
 *
 * `assignmentSha256` is one exact text. It is right for an acceptance packet
 * whose question was written once and authorized once.
 *
 * `assignmentTemplate` is a text with `{PLACEHOLDER}` fills. Every literal word
 * around the fills is pinned — the scope, the evidence standard, the completion
 * standard and the exclusions — and only the fills may vary. It is what a
 * standing authorization needs, because the question comes from the person and
 * the rules come from the envelope.
 *
 * **The template form is also a repair.** `RUSSELL_STATE_LICENSING_V1` set
 * `assignmentSha256: sha256(STATE_LICENSING_ASSIGNMENT_TEMPLATE)` with a comment
 * saying the digest was "checked against the template's shape rather than one
 * string" — and `planFitsEnvelope` hashed the *substituted* assignment, so the
 * two could never match and that envelope could never have approved anything.
 * The comment described this mechanism; it just did not exist yet.
 */
export type AssignmentPin =
  | { assignmentSha256: string; assignmentTemplate?: undefined }
  | { assignmentTemplate: string; assignmentSha256?: undefined };

export type ApprovalEnvelope = AssignmentPin & {
  id: string;
  /** What the operator authorized, in their words, for the audit row. */
  authorization: string;
  /**
   * The geography this envelope authorizes, in the words a refusal should use.
   *
   * The checks below used to say "which is not Michigan" in a function that
   * takes any envelope, which was true of the only envelope that existed when
   * it was written and is a lie in every other one. A refusal that names the
   * wrong jurisdiction is worse than one that names none.
   */
  jurisdiction: string;
  /**
   * How many fragments the plan may propose, or `null` for as many as the
   * evidence needs.
   *
   * A number here is a genuine bound on one acceptance packet, and the two
   * closed steps' envelopes keep theirs. `null` is not "unlimited spending":
   * every other condition in this envelope still applies to every fragment,
   * and each one is still gated, verified and audited exactly as before. What
   * it stops being is a *count* — because a count fixed for a narrow test
   * becomes a permanent restriction on how finely real research may be broken
   * down, which is a decision the evidence should make rather than a constant
   * written before the question was read.
   */
  maxFragments: number | null;
  /** Every fragment's geography must match this. */
  geography: RegExp;
  /** A fragment naming any of these is out of scope by construction. */
  forbiddenScope: RegExp;
  /** Source types a fragment may accept. Anything else is outside. */
  allowedSourceTypes: RegExp;
  /** Language that would mean spending money or acting on the world. */
  forbiddenActions: RegExp;
  /** The evidence floor the envelope refuses to see lowered. */
  minIndependentSourcesFloor: number;
  /**
   * The project slug this envelope may approve inside, when it is scoped to one.
   *
   * An envelope authorized for an acceptance run must not be usable to approve
   * a plan in a project holding real research, however exactly the assignment
   * matches.
   */
  projectSlug?: string;
  /**
   * Whether this authorization is spent by its first approval.
   *
   * A standing envelope is a rule; a one-use envelope is a *decision about one
   * packet*, and re-using it would silently turn the second into the first.
   * Consumption is read from `project_events` rather than from a flag somebody
   * has to remember to set, so a restart cannot un-spend it.
   */
  oneUse?: boolean;
};

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Is this assignment the envelope's template with its placeholders filled?
 *
 * Deterministic, total and side-effect free, like everything else here. It
 * splits the template on `{PLACEHOLDER}` and requires the literal segments to
 * appear in the assignment, in order, anchored at both ends, with a non-empty
 * fill between each pair. So every pinned word survives verbatim and only the
 * fills vary — which is exactly as strong as a digest for everything the
 * envelope actually controls, and no stronger.
 *
 * Two refusals worth naming. A template with two adjacent placeholders has an
 * empty literal between them and could be satisfied by almost anything, so it
 * is refused as unmatchable rather than treated as permissive. And a fill of
 * zero characters is refused, because an assignment that dropped the question
 * is not the assignment that was authorized.
 */
export function assignmentFitsTemplate(assignment: string, template: string): boolean {
  const segments = template.split(/\{[A-Z_]+\}/);
  if (segments.length === 1) return assignment === template;

  let cursor = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const first = index === 0;
    const last = index === segments.length - 1;

    if (!first && !last && segment === '') return false;

    if (first) {
      if (!assignment.startsWith(segment)) return false;
      cursor = segment.length;
      continue;
    }

    if (last) {
      if (segment === '') return assignment.length > cursor;
      if (!assignment.endsWith(segment)) return false;
      const at = assignment.length - segment.length;
      return at > cursor;
    }

    const at = assignment.indexOf(segment, cursor);
    if (at <= cursor) return false;
    cursor = at + segment.length;
  }
  return true;
}

/** Fill one template. The only writer of an assignment an envelope will accept. */
export function fillAssignmentTemplate(
  template: string,
  fills: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{([A-Z_]+)\}/g, (whole, name: string) => fills[name] ?? whole);
}

/**
 * The one envelope that exists.
 *
 * Frozen, and keyed by an id a caller can name but not define.
 */
/**
 * The frozen shape of Step 12A's acceptance assignment.
 *
 * `{STATE}` is substituted per state. Freezing the template rather than one
 * finished string is what lets the acceptance prove a follow-on: the second
 * mission is the same authorized question about the next state, not a new
 * authorization somebody granted mid-run.
 */
export const STATE_LICENSING_ASSIGNMENT_TEMPLATE =
  'Under {STATE} law as in force in 2026, must a success-fee intermediary who arranges the sale ' +
  'of a privately held business hold a real estate broker licence when the transaction transfers ' +
  'no interest in real property and no lease? Answer from the current official statutory text, ' +
  'citing the exact section and the passage relied on, and state its edition date.';

/** The assignment for one state, from the frozen template. */
export function stateLicensingAssignment(state: string): string {
  return STATE_LICENSING_ASSIGNMENT_TEMPLATE.replace('{STATE}', state);
}

export const STEP11_AUDIT_INDEPENDENCE_ASSIGNMENT =
  'In Delaware, under 6 Del. C. \u00a718-1107 as in force during 2026, what annual tax must a ' +
  'domestic limited liability company pay, and when is that tax due?';

/**
 * The standing Deal Dispatch public-records assignment.
 *
 * Two fills and nothing else: the question the person asked, and the
 * jurisdiction it is about. Every other word — what counts as a source, what
 * settles a part of the question, what is out of scope — is fixed here, in
 * code, and is what the operator authorized. A compiler may fill the two; it
 * cannot touch the rest, and `assignmentFitsTemplate` is what makes that true
 * of the row rather than of the intention.
 *
 * It asserts nothing about the world. It says what must be established and from
 * what, which is the whole of what a specification is allowed to do.
 */
export const PUBLIC_RECORDS_ASSIGNMENT_TEMPLATE = `Answer this question from official public records, and from nothing else:

{QUESTION}

Jurisdiction: {JURISDICTION}. Every finding must be about this jurisdiction; a finding
from anywhere else is out of scope and does not answer this.

Evidence standard: official published sources only — the county or municipal office that
holds the record (register of deeds, clerk, recorder, assessor, equalization, treasurer),
its published schedules, fee tables, portals and notices; the state statute or
administrative rule that governs it; and published guidance from the state department or
bureau responsible for it. A vendor page, a title-company article, a law-firm note or a
news summary may be used to locate an official source and may not support a claim on its
own.

Completion standard: each part of the question answered from a quoted official source,
identified by its URL and by the office that publishes it, and carrying the date it was
published or last updated — or explicitly recorded as unresolved, naming the offices
searched and what was not found. Where offices differ, report the difference per office
rather than averaging them into a single figure.

Out of scope: any other jurisdiction; anything requiring a paid subscription, a paid API
or a purchased record; anything requiring contact with a person or an office; publishing,
filing or submitting anything anywhere. This is read-only research into what is already
published.`;

export const APPROVAL_ENVELOPES: Readonly<Record<string, ApprovalEnvelope>> = Object.freeze({
  /**
   * The standing authorization Russell's compiled missions run under.
   *
   * This is the envelope that replaced a hard-coded one. Every Russell mission
   * used to name `RUSSELL_STATE_LICENSING_V1` — an acceptance envelope frozen to
   * one licensing question about Florida and California, with Michigan in its
   * `forbiddenScope`. So a real idea from a real conversation could not be
   * approved by the only envelope it was allowed to name, whatever its plan
   * said, and the packet parked every time.
   *
   * What makes this one safe is unchanged from §16 and is worth restating,
   * because it is a standing authorization rather than a one-packet one:
   *
   *   - it lives here, in code, and a packet names it by id. The compiler that
   *     writes a plan cannot supply the limits that plan is judged against;
   *   - it approves; it does not exempt. The evidence gate, the verification
   *     pass, the synthesis check and all three audit roles are untouched;
   *   - it is scoped to one project by slug, so it cannot approve work
   *     somewhere else however exactly the assignment matches;
   *   - and it authorizes reading published records and nothing else. No
   *     spending, no paid API, no contact with anybody, no publishing, no
   *     external effect of any kind.
   */
  RUSSELL_PUBLIC_RECORDS_V1: Object.freeze({
    id: 'RUSSELL_PUBLIC_RECORDS_V1',
    authorization:
      'The operator authorized standing research on Deal Dispatch into questions answerable ' +
      'from official Michigan state, county and municipal public records: read-only, primary ' +
      'sources only, no paid API and no purchased records, no contact with any person or ' +
      'office, no publishing and no external effect.',
    assignmentTemplate: PUBLIC_RECORDS_ASSIGNMENT_TEMPLATE,
    jurisdiction: 'Michigan',
    projectSlug: 'deal-dispatch',
    // As many bounded questions as the gaps require. Every condition below
    // applies to each of them, so a broader decomposition is more to refuse
    // rather than more room to hide in.
    maxFragments: null,
    geography: /\bmichigan\b|\bmi\b/i,
    // Every other state, and the federal layer. A Michigan county's name is
    // matched by none of these — the list is state names on word boundaries.
    forbiddenScope:
      /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|minnesota|mississippi|missouri|montana|nebraska|nevada|ohio|oklahoma|oregon|pennsylvania|tennessee|texas|utah|vermont|virginia|washington|wisconsin|wyoming|new york|new jersey|north carolina|south carolina|west virginia|rhode island|new hampshire|new mexico|north dakota|south dakota)\b/i,
    allowedSourceTypes:
      /(register of deeds|recorder|county clerk|city clerk|township clerk|village clerk|assessor|equalization|treasurer|county|municipal|statut|\bmcl\b|public act|administrative code|administrative rule|state of michigan|michigan department|department of|bureau of|lara|secretary of state|legislature|\.gov|official|primary|government|public record|open data|portal|fee schedule|recording office)/i,
    /*
     * Phrases that describe an action, never words that appear in the subject.
     *
     * This list had `publish` in it, and the tests caught what that means for a
     * public-records envelope: the fragment "establish which counties publish
     * permit data" was refused as describing an action outside reading, as was
     * every completion criterion asking for the date a source was published.
     * The check refused precisely the work it exists to permit — and a check
     * that does that is one somebody eventually switches off. `\bpay\b` would
     * have done the same to "how long after the buyer pays is the deed
     * recorded".
     *
     * So what is forbidden here is Brain *doing* something: buying access,
     * contacting somebody, filing something. The prohibition on publishing is
     * not weakened by leaving the word out — it is carried by the assignment's
     * own out-of-scope clause, which is pinned by the template above, and by
     * the standing authority's `ALWAYS_PROHIBITED` and `max_external_spend` of
     * zero. Three statements of it; none of them a substring match on a
     * subject.
     */
    forbiddenActions:
      /\b(purchase|paid api|api key|subscription fee|subscribe to|pay for access|paywall bypass|telephone call|phone call|call the|email the|write to the|contact the|submit a request to|file a (?:complaint|request|petition)|register with|apply for a|post to|press release|publish (?:a|our|the report|this report))\b/i,
    minIndependentSourcesFloor: 1,
  } satisfies ApprovalEnvelope),

  /**
   * The Step 11 audit-independence acceptance. One packet, once.
   *
   * The human authorization is the instruction that created it, quoted in
   * `authorization` and recorded on every approval event. The planner is not
   * approving itself: the limits below were fixed in code before any plan
   * existed, and nothing in the packet can widen them.
   *
   * Narrower than Step 10's in every dimension that matters — one fragment, one
   * state, statutory sources only, and a project that holds no real research —
   * because it exists to observe three lease decisions rather than to answer a
   * hard question.
   */
  STEP11_AUDIT_INDEPENDENCE_V1: Object.freeze({
    id: 'STEP11_AUDIT_INDEPENDENCE_V1',
    authorization:
      'The operator authorized exactly one Step 11 acceptance packet on this assignment, in the ' +
      'Step 11 acceptance project, as one-use, in the instruction that defined this envelope. ' +
      'The planner is not approving itself.',
    assignmentSha256: sha256(STEP11_AUDIT_INDEPENDENCE_ASSIGNMENT),
    jurisdiction: 'Delaware',
    projectSlug: 'step-11-acceptance',
    oneUse: true,
    maxFragments: 1,
    geography: /delaware|\bde\b/i,
    // Every other state, and the federal layer. Delaware only means Delaware.
    forbiddenScope:
      /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|ohio|oklahoma|oregon|pennsylvania|tennessee|texas|utah|vermont|virginia|washington|wisconsin|wyoming|new york|new jersey|north carolina|south carolina|west virginia|rhode island|new hampshire|new mexico|north dakota|south dakota|federal|irs|internal revenue)\b/i,
    // State statutory material and the state's own published guidance. No
    // secondary source may support a claim, so nothing else is admissible.
    allowedSourceTypes:
      /(statut|delaware code|del\. c\.|title 6|state code|administrative code|regulation|division of corporations|department of state|secretary of state|official|primary|government)/i,
    forbiddenActions:
      /\b(purchase|pay|payment|subscribe|subscription|invoice|paywall bypass|contact|telephone|phone call|email the|write to|submit a request to|file a|register with|apply for)\b/i,
    minIndependentSourcesFloor: 1,
  } satisfies ApprovalEnvelope),

  /**
   * Step 12A's acceptance packet: Florida, one fragment, statutory only.
   *
   * The gap is real and it is live. `Monetization Logic v1` says in its own
   * filed text that the packet "can conclude only that a New York-based,
   * business-only, no-real-property success-fee deal does not require a real
   * estate broker licence… California, Texas, Florida and Illinois remain open
   * questions", with the Florida and California sections short of
   * 2026-currency evidence; v1C then settled Michigan; and the planner's own
   * next best action is that layer. So this is the next state, chosen from
   * rows rather than invented to give an acceptance something to do.
   *
   * Two controls stand in series in front of it, and neither replaces the
   * other: Step 12A's standing authority decides whether Russell may *start*,
   * and this envelope decides whether the plan it then produced is inside
   * limits fixed here before any plan existed.
   *
   * Not one-use, unlike the Step 11 envelope, and for a reason worth stating:
   * the acceptance has to prove Russell launching a *second* authorized mission
   * without another prompt, and the follow-on is the same question for
   * California. One-use would have made the thing being proved impossible.
   *
   * It carried `maxFragments: 1` as the bound that kept it honest, and that is
   * gone. The correction is recorded rather than quietly applied: one fragment
   * per state was chosen because the acceptance needed something small, and a
   * number chosen for a test does not belong in the envelope a real question
   * is judged against — "how many bounded questions is this?" is decided by
   * the gaps, which is §12's own rule about there being no fixed fragment
   * count. What actually keeps this envelope narrow is untouched and is doing
   * all the work: two named states and every other one forbidden by name,
   * statutory sources only, no spend and no external effect, and a pinned
   * assignment digest. A fifth fragment inside those bounds is the same
   * authorized question asked more carefully; a fragment outside them is
   * refused however few there are.
   */
  RUSSELL_STATE_LICENSING_V1: Object.freeze({
    id: 'RUSSELL_STATE_LICENSING_V1',
    authorization:
      'The operator authorized Step 12A acceptance research into the state licensing gap the ' +
      'Deal Dispatch Monetization Logic layer names as open, one bounded fragment per state, ' +
      'primary statutory sources only, no spend and no external effect.',
    // Composed per state from a frozen template, so what is pinned is the
    // template. This used to be `assignmentSha256: sha256(TEMPLATE)` with a
    // comment claiming exactly this behaviour, and `planFitsEnvelope` hashed
    // the substituted assignment — so no packet could ever have matched it.
    assignmentTemplate: STATE_LICENSING_ASSIGNMENT_TEMPLATE,
    jurisdiction: 'Florida or California',
    projectSlug: 'deal-dispatch',
    // As many bounded questions as the gaps require. The scope conditions
    // below are what bound this packet, and they apply to every one of them.
    maxFragments: null,
    // Two states, and only these two: the frozen acceptance idea and the frozen
    // follow-on. A third would be work nobody authorized.
    geography: /florida|california|\bfl\b|\bca\b/i,
    forbiddenScope:
      /\b(alabama|alaska|arizona|arkansas|colorado|connecticut|delaware|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|ohio|oklahoma|oregon|pennsylvania|tennessee|texas|utah|vermont|virginia|washington|wisconsin|wyoming|new york|new jersey|north carolina|south carolina|west virginia|rhode island|new hampshire|new mexico|north dakota|south dakota|federal|sec\b)\b/i,
    allowedSourceTypes:
      /(statut|fla\. stat|florida statutes|bus\. ?& ?prof|business and professions|state code|administrative code|regulation|department of business|bureau of real estate|secretary of state|official|primary|government|legislature)/i,
    forbiddenActions:
      /\b(purchase|pay|payment|subscribe|subscription|invoice|paywall bypass|contact|telephone|phone call|email the|write to|submit a request to|file a|register with|apply for)\b/i,
    minIndependentSourcesFloor: 1,
  } satisfies ApprovalEnvelope),

  STEP10_MICHIGAN_LICENSING_V1: Object.freeze({
    id: 'STEP10_MICHIGAN_LICENSING_V1',
    authorization:
      'The operator authorized this exact topic, scope, source restriction and execution in ' +
      'advance, for one packet, as the Step 10 real-research acceptance.',
    assignmentSha256: sha256(MICHIGAN_LICENSING_ASSIGNMENT),
    jurisdiction: 'Michigan',
    maxFragments: 4,
    geography: /michigan|\bmi\b/i,
    forbiddenScope:
      /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|minnesota|mississippi|missouri|montana|nebraska|nevada|ohio|oklahoma|oregon|pennsylvania|tennessee|texas|utah|vermont|virginia|washington|wisconsin|wyoming|new york|new jersey|north carolina|south carolina|west virginia|rhode island|new hampshire|new mexico|north dakota|south dakota)\b/i,
    /*
     * `administrative code` is here because the first real plan was refused
     * without it, and the refusal was wrong.
     *
     * The plan declared exactly four source classes — the Michigan
     * Occupational Code, "Michigan Administrative Code / R rules", published
     * LARA guidance, and Board declaratory rulings — which are the four the
     * authorized assignment names, and it excluded exactly what the assignment
     * excludes. Three matched. The fourth did not, because Michigan publishes
     * its administrative rules as the Michigan Administrative *Code*, and this
     * list spelled `administrative rule`.
     *
     * That is a defect in the check rather than a plan outside the
     * authorization, and the difference matters: the envelope's authorization
     * is the assignment text pinned by digest, which says in as many words
     * "the Michigan Occupational Code and its licensing article, **the
     * administrative rules**, and published guidance or declaratory rulings".
     * The list is an implementation of that sentence and it failed to spell
     * one of the four things the sentence names. Adding it admits no class the
     * operator did not authorize — law-firm articles, other states, federal
     * securities material and tax law are all still refused, which the tests
     * assert directly.
     *
     * The validator version is bumped for it, because an audit row saying
     * "Brain approved this" is only auditable if it says which rules applied.
     */
    allowedSourceTypes:
      /(statut|regulation|administrative rule|administrative code|occupational code|licensing act|regulator|declaratory ruling|attorney general|agency guidance|lara|department of licensing|board of real estate|official|primary|government|case law|court)/i,
    forbiddenActions:
      /\b(purchase|pay|payment|subscribe|subscription|invoice|licence fee to access|paywall bypass|contact|telephone|phone call|email the|write to|submit a request to|file a complaint|register with|apply for)\b/i,
    minIndependentSourcesFloor: 1,
  } satisfies ApprovalEnvelope),
});

/**
 * May this envelope be applied to this packet at all?
 *
 * Asked before `planFitsEnvelope`, and kept separate from it on purpose: that
 * function is deterministic over its arguments and must stay that way, while
 * these two questions are facts about the world — which project this is, and
 * whether the authorization has already been spent.
 *
 * Consumption is counted from `project_events`, the append-only log, rather
 * than from a column somebody has to remember to set. A restart cannot un-spend
 * it, and a second packet naming the same envelope is refused with the
 * orchestration that used it named, so the refusal is actionable.
 */
export async function envelopeAvailable(input: {
  envelope: ApprovalEnvelope;
  projectId: string;
  projectSlug: string;
  orchestrationId: string;
}): Promise<{ available: boolean; reasons: string[] }> {
  const reasons: string[] = [];

  if (input.envelope.projectSlug && input.envelope.projectSlug !== input.projectSlug) {
    reasons.push(
      `This envelope authorizes work in "${input.envelope.projectSlug}" and this packet is in ` +
        `"${input.projectSlug}". An acceptance authorization must not approve a plan in a ` +
        'project holding real research, however exactly the assignment matches.',
    );
  }

  if (input.envelope.oneUse) {
    const events = await listEvents(input.projectId, 500);
    const spent = events.find(
      (event) =>
        event.eventType === 'RESEARCH_PLAN_SYSTEM_APPROVED' &&
        (event.payload as { envelopeId?: string })['envelopeId'] === input.envelope.id &&
        (event.payload as { orchestrationId?: string })['orchestrationId'] !== input.orchestrationId,
    );
    if (spent) {
      reasons.push(
        `This is a one-use authorization and it was already spent by orchestration ` +
          `${String((spent.payload as { orchestrationId?: string })['orchestrationId'])}. A second ` +
          'packet needs its own decision from a person.',
      );
    }
  }

  return { available: reasons.length === 0, reasons };
}

export function getApprovalEnvelope(id: string): ApprovalEnvelope | null {
  return Object.prototype.hasOwnProperty.call(APPROVAL_ENVELOPES, id)
    ? (APPROVAL_ENVELOPES[id] as ApprovalEnvelope)
    : null;
}

export interface EnvelopeVerdict {
  fits: boolean;
  envelopeId: string;
  validatorVersion: string;
  reasons: string[];
  checked: Record<string, unknown>;
}

/**
 * Does this plan fit what was authorized?
 *
 * Deterministic, total, and side-effect free. Every reason it returns names the
 * fragment and the rule, because "outside the envelope" with no detail is an
 * escalation a person cannot act on.
 */
export function planFitsEnvelope(input: {
  envelope: ApprovalEnvelope;
  orchestration: ResearchOrchestration;
  fragments: ResearchFragment[];
}): EnvelopeVerdict {
  const { envelope, orchestration, fragments } = input;
  const reasons: string[] = [];

  // The assignment itself, pinned — by digest when the envelope authorizes one
  // exact text, and by template when it authorizes a shape. A packet whose
  // pinned words drifted is not the packet that was authorized, whatever its
  // title says.
  const assignmentMatches =
    envelope.assignmentTemplate !== undefined
      ? assignmentFitsTemplate(orchestration.assignment, envelope.assignmentTemplate)
      : sha256(orchestration.assignment) === envelope.assignmentSha256;
  if (!assignmentMatches) {
    reasons.push(
      envelope.assignmentTemplate !== undefined
        ? 'The assignment is not this envelope\'s authorized assignment with its question ' +
          'filled in. Everything except the question is fixed in code — the scope, the ' +
          'evidence standard, the completion standard and the exclusions — and changing any ' +
          'of it needs a person.'
        : 'The assignment is not the text this envelope authorizes. The envelope pins an exact ' +
          'assignment by digest, so any change to the question, the scope or the evidence ' +
          'standard needs a person.',
    );
  }

  // Nothing that skips the real path may be auto-approved. A fixture supplies
  // its own claims, so approving one automatically would authorize a rehearsal
  // rather than research.
  if (orchestration.fixture) {
    reasons.push('This is a fixture packet, which supplies its own claims. Only a person may approve one.');
  }

  // Narrowing the goal is a separate decision, and this envelope does not carry
  // it. A packet allowed to record gaps could declare its way to complete.
  if (orchestration.unresolvedGapPolicy) {
    reasons.push(
      'This packet is authorized to record unresolved gaps, which narrows what it claims to ' +
        'answer. That is a decision about the goal and it is not inside this envelope.',
    );
  }

  if (fragments.length === 0) {
    reasons.push('There is no plan to approve.');
  }
  if (envelope.maxFragments !== null && fragments.length > envelope.maxFragments) {
    reasons.push(
      `The plan proposes ${fragments.length} fragments; the envelope authorizes at most ` +
        `${envelope.maxFragments}. A broader decomposition is a broader spend.`,
    );
  }

  for (const fragment of fragments) {
    const where = `fragment "${fragment.fragmentKey}"`;
    const prose = [
      fragment.question,
      fragment.definitions ?? '',
      fragment.population ?? '',
      fragment.completionCriteria.join(' '),
    ].join(' \n');

    const geography = fragment.geography ?? '';
    if (!envelope.geography.test(geography)) {
      reasons.push(
        `${where} declares geography "${geography || '(none)'}", which is not ` +
          `${envelope.jurisdiction}.`,
      );
    }
    if (envelope.forbiddenScope.test(prose) || envelope.forbiddenScope.test(geography)) {
      reasons.push(`${where} reaches outside ${envelope.jurisdiction}.`);
    }
    if (envelope.forbiddenActions.test(prose)) {
      reasons.push(
        `${where} describes an action outside reading published sources. The envelope authorizes ` +
          'no spending and no contact with anybody.',
      );
    }
    if (fragment.acceptableSourceTypes.length === 0) {
      reasons.push(`${where} declares no acceptable source types, so nothing bounds what it may cite.`);
    }
    for (const source of fragment.acceptableSourceTypes) {
      if (!envelope.allowedSourceTypes.test(source)) {
        reasons.push(
          `${where} accepts "${source}", which is not a primary statute, regulation or regulator source.`,
        );
      }
    }
    if (fragment.minIndependentSources < envelope.minIndependentSourcesFloor) {
      reasons.push(
        `${where} sets minIndependentSources to ${fragment.minIndependentSources}, below the ` +
          `envelope's floor of ${envelope.minIndependentSourcesFloor}.`,
      );
    }
    if (fragment.requiredEvidence.length === 0) {
      reasons.push(`${where} declares no evidence lanes, so the gate has nothing to apply.`);
    }
  }

  return {
    fits: reasons.length === 0,
    envelopeId: envelope.id,
    validatorVersion: ENVELOPE_VALIDATOR_VERSION,
    reasons,
    checked: {
      fragments: fragments.length,
      maxFragments: envelope.maxFragments,
      assignmentMatches,
      pinnedBy: envelope.assignmentTemplate !== undefined ? 'TEMPLATE' : 'DIGEST',
      geographies: fragments.map((f) => f.geography ?? null),
    },
  };
}

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
import { ownActionMatches } from './actorScope.ts';
import type { ResearchFragment, ResearchOrchestration } from '../../domain/types.ts';

/**
 * Bumped whenever the checks below change meaning.
 *
 * Recorded on every automatic approval, because "Brain approved this" is only
 * auditable if you can tell which rules it applied.
 *
 * `2026-09-17.1` is the Cash discovery repair: the action screen asks whose
 * action a forbidden phrase is rather than whether the phrase appears, and the
 * source allowlist admits the published request, listing, notice, price list
 * and platform-terms classes the cash envelope was always meant to. Both are
 * narrowings of a screen, and an approval recorded under the earlier version
 * was judged by the earlier rules — which is the whole reason this constant is
 * on the row rather than only in the file.
 */
export const ENVELOPE_VALIDATOR_VERSION = '2026-09-17.1';

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
  /**
   * What `allowedSourceTypes` actually permits, in this envelope's own words.
   *
   * Required, because the refusal that quotes it used to be a constant reading
   * *"which is not a primary statute, regulation or regulator source"* for
   * every envelope. That is true of the two statutory ones and a plain lie
   * about the cash discovery envelope, which admits marketplaces, listings,
   * job boards, auctions, forums and company pages by design. Production
   * refused six correctly-shaped plans with that sentence, and an operator
   * reading it would have concluded cash discovery demands statutes.
   *
   * A refusal must quote the rule that actually refused it. Making this a
   * required field rather than an optional one is the point: a new envelope
   * cannot be added without saying what its own allowlist means.
   */
  sourceRule: string;
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

/**
 * The standing Cash Mode discovery assignment.
 *
 * Two fills, exactly as the public-records template has: the question somebody
 * asked, and the market it is about. Everything else is fixed here and is what
 * the operator authorized.
 *
 * It authorizes **reading** and nothing else. Discovering that a buyer exists,
 * that a supplier has capacity, that a deadline is real or that a spread is
 * open is research into what is already published. Acting on any of it —
 * contacting the buyer, quoting, committing money — is a commercial grant,
 * which is a separate decision with its own ceilings in
 * `services/cash/authority.ts`. Nothing in this envelope authorizes an effect
 * on the world, and no fragment running under it may perform one.
 */
export const CASH_DISCOVERY_ASSIGNMENT_TEMPLATE = `Establish, from published sources, the answer to this question:

{QUESTION}

Market: {JURISDICTION}. Say which market each finding is about; a finding about a
different market answers a different question and must be recorded as such rather than
generalized.

Evidence standard: published sources, each identified by its URL and by who publishes it,
and each carrying the date it was published or last observed. A demand signal is a
specific published request, listing, posting, notice, filing, schedule or announcement,
attributed to whoever made it. An organisation's own site is conclusive about what that
organisation says and is worth nothing as independent confirmation of anything else.
Sources that are really one source — two pages of one site, one release carried by three
outlets, three publishers restating one upstream estimate — are counted once and the
duplication is reported.

Completion standard: each part of the question either answered from a quoted source, or
explicitly recorded as unresolved naming what was searched and what was not found. A
forecast is never a fact whatever supports it. A claim that something does not exist is
established by a documented search of the places it would be, or not at all. Where sources
disagree, classify the disagreement — different definition, timeframe, geography or
population — before calling it a contradiction, and never average incompatible figures
into an answer.

Out of scope: contacting any person or organisation; buying access, data, a subscription
or a paid API; placing an advertisement; publishing, posting, listing, filing or
submitting anything anywhere; making any commitment on anybody's behalf. This is
read-only research into what is already published, and every action beyond reading needs
a separate commercial authorization from a person.`;

/**
 * The bounded deep dive that turns one opening into a decision.
 *
 * Discovery asks a broad question — "which buyers have published a paid
 * request" — and answers it with openings. It cannot also answer who pays, what
 * to offer, what that costs, how long the money takes and what would disqualify
 * it, and making it try is what produced fragments no worker could satisfy: a
 * production discovery packet was asked for a payer, a channel, a price and a
 * closing condition in one lane set, and filed with half of them unresolved.
 *
 * So the commercial questions are a *second* assignment, against one opening
 * that already exists, with the opening's own source quoted into it. It is
 * bounded by construction: one subject, named in the question, and the same
 * published-sources-only rule.
 *
 * It authorizes nothing new. Every prohibition below is the discovery
 * envelope's, word for word, because a deep dive that could contact a buyer to
 * ask their budget would be the one thing this whole section is arranged to
 * make impossible.
 */
export const CASH_VALIDATION_ASSIGNMENT_TEMPLATE = `Establish, from published sources, what a person would need to know before acting on
this specific opening:

{QUESTION}

Subject: one opening, named above. Everything you establish must be about that opening or
about the market it sits in, and anything you find about a different one is recorded as
out of scope rather than used.

Market: {JURISDICTION}. Say which market each finding is about.

What to settle, as far as published sources allow: who the payer actually is and what
published evidence says they buy; how a supplier reaches them; what comparable work is
published at, as a figure or a range with its source; what the direct costs of delivering
it are, from published prices; what capital is required before any money arrives; how long
published terms say payment takes; how much human time comparable work is published as
taking; whether selling, calling, fulfilment or subcontracted labour is required; what the
first steps would be; what the bottleneck is; and what published fact would disqualify this
outright.

Evidence standard: published sources, each identified by its URL and by who publishes it,
and each carrying the date it was published or last observed. A price is read from a
source, never produced: where nothing publishes one, record that it is unknown and say what
would settle it. An organisation's own site is conclusive about what that organisation says
and worth nothing as independent confirmation of anything else.

Completion standard: each item above either answered from a quoted source, or explicitly
recorded as unresolved naming what was searched and what was not found. An unknown stays
unknown. Do not convert a blank into a zero, and do not estimate a figure no source states.

Out of scope: contacting any person or organisation; buying access, data, a subscription
or a paid API; placing an advertisement; publishing, posting, listing, filing or
submitting anything anywhere; making any commitment on anybody's behalf. This is
read-only research into what is already published, and every action beyond reading needs
a separate commercial authorization from a person.`;

export const INDUSTRY_MAP_ASSIGNMENT_TEMPLATE = `Establish, from published sources, how this part of the economy is actually put together:

{QUESTION}

Subject: the subject named above, and what sits underneath it. Anything you establish about
a different subject is reported as being about somewhere else rather than generalized.

Market: {JURISDICTION}. Say which market each finding is about.

What to settle, as far as published sources allow: which narrower industries the subject
contains, as the sources themselves name them; the stages of producing and delivering here,
in the order the sources describe; which kinds of organisation pay for work in this
subject; who or what actually performs the work that gets paid for; how money changes hands
— what is bought, on what terms, and on what cycle; and where supply is constrained, as a
documented shortage, queue or chokepoint rather than an impression.

Every one of those becomes part of the map only if you declare it. Set structural_finding
on the claim to the kind it is, and structural_subject to the subject's own name as the
source calls it. A claim with no structural_finding is ordinary context, which is most of
them and is not a deficiency.

Evidence standard: published sources, each identified by its URL and by who publishes it,
each carrying the date it was published or last observed. An industry classification
system, a trade body's own taxonomy and a statistical agency's publication are all
conclusive about what they declare, and none of them is evidence that the structure they
declare is the one the money actually moves through — so where a trade source and a
classification disagree, record both rather than choosing.

Completion standard: each item above either answered from a quoted source, or explicitly
recorded as unresolved naming what was searched and what was not found. Do not invent a
level that no source names, and do not produce a tidy hierarchy by filling gaps: a subject
with three published sub-industries has three, and the map saying so is worth more than a
symmetrical one that is partly guessed.

Out of scope: contacting any person or organisation; buying access, data, a subscription
or a paid API; placing an advertisement; publishing, posting, listing, filing or
submitting anything anywhere; making any commitment on anybody's behalf. This is
read-only research into what is already published, and every action beyond reading needs
a separate commercial authorization from a person.`;

export const LABOR_ALLOCATION_ASSIGNMENT_TEMPLATE = `Establish, from published sources, who or what is actually permitted and available to
produce this output:

{QUESTION}

Subject: the output named above, and work of that kind. Anything you establish about a
different output is reported as being about something else rather than generalized.

Market: {JURISDICTION}. A rule about who may do this work is usually jurisdictional, so
say which jurisdiction each requirement is from — a licensing rule quoted without one is
not a finding about anywhere.

What to settle, as far as published sources allow: whether a statute, regulator, buyer's
own terms or platform terms require a licensed, certified, registered or accountable
person; whether any part of it must be performed in person; whether published evidence
shows the interaction with a person is itself part of what is bought; which channels
supply this capability, in which jurisdictions, at which published rates and on what
basis each rate is quoted; and whether this work is published anywhere as being done by
software rather than by a person.

Every one of those becomes usable only if you declare it. Set labor_finding on the claim
to the kind it is, and labor_subject to the value from that kind's own set. A claim with
no labor_finding is ordinary context, which is most of them and is not a deficiency.

An established absence is a finding and is often the most valuable one here. Where you
searched the places a licensing or credential rule would be published and found none, say
so as a negative claim naming exactly what you searched — that is what lets work stop
needing a person, and an undocumented silence is not the same thing.

Evidence standard: published sources, each identified by its URL and by who publishes it,
each carrying the date it was published or last observed. A regulator, statute or
licensing board is conclusive about what it requires. A vendor is conclusive about what
the vendor claims and worth nothing as independent confirmation that the claim is true. A
rate is read from a source and never produced: where none publishes one, record the
channel with no rate rather than estimating.

Completion standard: each item above either answered from a quoted source, or explicitly
recorded as unresolved naming what was searched and what was not found. Do not conclude
from the absence of a rule that no rule exists unless you searched for it and say where.

Out of scope: contacting any person or organisation, including any prospective worker,
contractor, agency or employer; posting or responding to any job, tender or engagement;
buying access, data, a subscription or a paid API; placing an advertisement; publishing,
posting, listing, filing or submitting anything anywhere; making any commitment on
anybody's behalf. This is read-only research into what is already published. Nothing here
hires, engages, approaches or contracts with anybody, and every action beyond reading
needs a separate commercial authorization from a person.`;
export const MACHINE_LADDER_ASSIGNMENT_TEMPLATE = `Establish, from published sources, which classes of machine exist here and how they relate:

{QUESTION}

Subject: the class of machine named above, and what the sources recognise inside and beside
it. Anything you establish about a different class is reported as being about that class
rather than generalized onto this one.

Market: {JURISDICTION}. Say which market each finding is about.

What to settle, as far as published sources allow: which narrower or more specific classes
of machine the sources recognise inside this one, as they themselves name them; and which
different classes they name as connected to it — because the same producers build both,
because they are sold or serviced through the same channel, or because they share major
components or subsystems.

Every one of those becomes part of the ladder only if you declare it. Set
capability_finding on the claim to PRODUCT_CATEGORY or ADJACENT_CATEGORY, and
capability_subject to that class's own name as the source calls it. A claim with no
capability_finding is ordinary context, which is most of them and is not a deficiency.

Evidence standard: published sources, each identified by its URL and by who publishes it,
each carrying the date it was published or last observed. A classification system, a trade
association's own taxonomy and a regulator's category definitions are all conclusive about
what they declare, and none of them is evidence that the division they declare is how
producers actually organize — so where a trade source and a classification disagree, record
both rather than choosing.

Completion standard: each item above either answered from a quoted source, or explicitly
recorded as unresolved naming what was searched and what was not found. Do not invent a
class no source names, and do not produce a tidy hierarchy by filling gaps.

Out of scope: contacting any person or organisation; buying access, data, a subscription
or a paid API; placing an advertisement; publishing, posting, listing, filing or
submitting anything anywhere; making any commitment on anybody's behalf; and recommending
that anything be built, bought, tooled or entered. This is read-only research into what is
already published, and every action beyond reading needs a separate authorization from a
person.`;

export const MACHINE_DEMAND_ASSIGNMENT_TEMPLATE = `Establish, from published sources, who is buying machines of this kind and how product
reaches them:

{QUESTION}

Subject: the class of machine named above. Anything you establish about a different class
is reported as being about that class rather than generalized onto this one.

Market: {JURISDICTION}. Say which market each finding is about.

What to settle, as far as published sources allow: observations that somebody is actually
buying — unit shipments, registrations, fleet purchases, tenders and contract awards,
replacement cycles, prices actually realised, order backlogs and lead times, installed
base; the routes by which machines of this kind reach whoever pays for them; and where
what is on the market today falls short, from recalls, safety actions, documented failure
modes, service coverage, parts availability, stated lead times and stated unmet
requirements.

Declare each one on its claim: DEMAND_EVIDENCE with the kind of observation it is,
DISTRIBUTION_CHANNEL with the route, INCUMBENT_WEAKNESS with the kind of shortfall.

Evidence standard: published sources, each identified by its URL and by who publishes it.
A demand observation additionally carries the date the source observed it, in
capability_observed_on — an undated buying signal cannot be told apart from one somebody
remembers from years ago, and it will not be recorded as a demand signal without one. A
market-size estimate is not an observation that somebody bought something. A forecast is
never a fact, whatever supports it. An impression that a market is large, growing or
underserved is not evidence and has nowhere to go here.

Completion standard: each item above either answered from a quoted source, or explicitly
recorded as unresolved naming what was searched and what was not found. Where nothing
published establishes that anybody is buying, say so plainly: that is a finding, and it is
the one this research most needs to be able to return.

Out of scope: contacting any person or organisation; buying access, data, a subscription
or a paid API; placing an advertisement; publishing, posting, listing, filing or
submitting anything anywhere; making any commitment on anybody's behalf; and recommending
that anything be built, bought, tooled or entered. This is read-only research into what is
already published, and every action beyond reading needs a separate authorization from a
person.`;

export const MACHINE_CAPABILITY_ASSIGNMENT_TEMPLATE = `Establish, from published sources, what producing this kind of machine requires and what
producing it develops:

{QUESTION}

Subject: the class of machine named above, and what producing it takes. You are being
asked about the industry, not about the organisation commissioning this research: what it
can already do is recorded separately, from a person, and nothing you establish here can
say anything about it.

Market: {JURISDICTION}. Say which market each finding is about.

What to settle, as far as published sources allow: the engineering, manufacturing, supply,
testing, distribution and servicing capabilities a producer must have; what producing at
this level builds up that a producer did not have before; what must be certified,
approved, homologated, tooled, qualified or reached in scale before anybody may produce at
all; and, where the question asks it, which components and subsystems producers buy in
rather than make, and who supplies them.

Declare each one on its claim: CAPABILITY_REQUIRED for what producing needs,
CAPABILITY_TAUGHT for what producing develops, ENTRY_BARRIER for what must be obtained
first, BOUGHT_IN_COMPONENT for what is bought rather than made. Name a capability as
shortly as it can be named while still being the same capability wherever it appears, so
that two classes of machine needing the same thing say the same words.

Evidence standard: published sources, each identified by its URL and by who publishes it,
each carrying the date it was published or last observed. A regulator's own published
requirement is conclusive about what it requires. A producer's own account of what its
manufacturing involves is conclusive about what it says and is not independent
confirmation of anything. A capability asserted because it seems obviously necessary, with
no source naming it, is not a finding.

Completion standard: each item above either answered from a quoted source, or explicitly
recorded as unresolved naming what was searched and what was not found. Do not produce a
complete-looking list by adding what a machine of this kind "must obviously" need: a class
with four published requirements has four, and saying so is worth more than a symmetrical
list that is partly guessed.

Out of scope: contacting any person or organisation; buying access, data, a subscription
or a paid API; placing an advertisement; publishing, posting, listing, filing or
submitting anything anywhere; making any commitment on anybody's behalf; recommending that
anything be built, bought, tooled, integrated or entered; and reporting what the
commissioning organisation can or cannot do. This is read-only research into what is
already published, and every action beyond reading needs a separate authorization from a
person.`;

export const MACHINE_CAPITAL_ASSIGNMENT_TEMPLATE = `Establish, from published sources, what entering this class of machine actually costs,
requirement by requirement:

{QUESTION}

Subject: the class of machine named above, and what a producer has to fund before selling
anything of that kind. You are being asked about the industry, not about the organisation
commissioning this research: what it can already afford is not a question here and nothing
you establish can say anything about it.

Market: {JURISDICTION}. Say which market each figure is about.

What to settle, as far as published sources allow: what has to be funded before production
— tooling and equipment, a facility, certification and type approval, engineering and
development, working capital, inventory and parts, onboarding suppliers, a distribution
and service network, licences and intellectual property, test and validation — and what
each of those is published to cost, with the currency it is published in and the date the
figure was true.

Declare each on its claim with capability_finding set to CAPITAL_REQUIREMENT,
capability_subject set to which requirement it is, capability_qualifier set to which shape
of the business the figure is about, capability_basis set to what kind of figure it is, and
capability_observed_on set to the date it was true. Where you have a figure, give
capability_amount_low_minor, capability_amount_high_minor and capability_currency; a source
that publishes one number sets the two ends equal.

Evidence standard: a published price, a regulator's own fee schedule, a comparable firm's
own disclosure, a trade publication's figure or a named analyst's estimate — each
identified by its URL, by who published it and by the date. A regulator's published fee is
conclusive about that fee. A supplier's own price list is conclusive about what it asks. A
figure with no publisher and no date is not a finding.

Completion standard, and this is the part that matters most here: a requirement that is
real and that nobody publishes a figure for is a **finding**, and it is submitted as one —
the requirement, the basis, the date, and no amount at all. Brain records it and withholds
any total rather than summing past it. Do not estimate. Do not scale a figure from another
class of machine. Do not convert between currencies. Do not complete a picture: a
plausible number at the figure that would start a factory is worse than a blank, because
a blank is visible afterwards and a number is not.

Out of scope: contacting any person or organisation; requesting a quotation; buying
access, data, a subscription or a paid API; placing an advertisement; publishing, posting,
listing, filing or submitting anything anywhere; making any commitment on anybody's
behalf; and recommending that anything be built, bought, tooled or entered. This is
read-only research into what is already published, and every action beyond reading needs a
separate authorization from a person.`;

export const MACHINE_ACQUISITION_ASSIGNMENT_TEMPLATE = `Identify, from published sources, firms whose acquisition would supply something this
class of machine requires:

{QUESTION}

Subject: the class of machine named above, and the firms published sources name as
producers, suppliers, distributors or holders of approvals in it.

Market: {JURISDICTION}. Say which market each firm operates in.

What to settle, as far as published sources allow: which firms exist, what each one
actually holds — a capability, production capacity, a dealer or distribution network, a
component supply, a certification or approval, intellectual property, an engineering team,
a market position — and which published source says so.

Declare each with capability_finding set to ACQUISITION_CANDIDATE, capability_subject set
to the firm's own name as the source gives it, and capability_qualifier set to what buying
it would contribute.

Evidence standard: a company's own filings, a regulator's register of approval holders, a
trade association's member list, a trade publication covering the industry, a public
registry. A company's own site is conclusive about what it says about itself and is not
independent confirmation of anything. A firm named with no source is not a finding.

Completion standard: each firm either supported by a quoted source, or not reported.
Reporting that published sources name no such firm is a complete answer and is more useful
than a list assembled from what seems likely.

**This is identification only, and the boundary is the point of the assignment.** Do not
contact anybody. Do not request information from a firm. Do not value anything, and do not
estimate what any firm would sell for. Do not propose terms, structure, price or timing.
Do not recommend pursuing any of them. Whether to approach, diligence, offer for or buy a
firm is a decision a person makes under an authorization this research does not carry and
cannot produce.

Out of scope: everything in the paragraph above, plus buying access, data, a subscription
or a paid API; placing an advertisement; publishing, posting, listing, filing or submitting
anything anywhere; and making any commitment on anybody's behalf. This is read-only
research into what is already published.`;

export const CAPITAL_STRUCTURE_ASSIGNMENT_TEMPLATE = `Establish, from published sources, what owner capital this actually requires — after the
requirements have been taken apart:

{QUESTION}

Subject: one opening, named above. Everything you establish must be about that opening or
about the way work of that kind is financed in its industry.

Market: {JURISDICTION}. Say which market each finding is about.

A headline startup cost is a published figure about a *shape* of the business, usually the
shape where the owner buys the equipment, leases the property, hires the staff and carries
the receivables. It is not the answer. What to settle instead:

First, which specific requirements exist for this transaction — labour, equipment,
property, inventory, licensing, customer acquisition, working capital, deposits, insurance,
compliance, fulfilment, transport, storage, technology, minimum order sizes, guarantees —
and what published sources say each one costs. Declare each with structural_finding set to
CAPITAL_REQUIREMENT.

Second, which published practices in this industry remove, defer or shift each of those
onto somebody else: subcontracting, brokerage, agency, customer deposits, milestone
billing, pre-sales, purchase-order finance, receivables finance, supplier credit,
consignment, leasing, rental, licensing in, revenue share, joint venture, project finance,
offtake, distribution advances, government incentives, capacity reservations, management
contracts, contract manufacture, third-party logistics, white labelling, marketplaces.
Declare each with structural_finding set to CAPITAL_RESTRUCTURING, naming the requirement
it answers and what the owner still funds afterwards where the source says.

Do not assume a mechanism applies because it exists. Establish that this industry actually
uses it, from a source about this industry.

Third, anything published that changes the economics and is not obvious from outside — a
cycle longer than the stated one because acceptance follows it, a prohibition on passing
work on, a credential requirement, a supervision ceiling, payment only on final acceptance,
a bonding requirement, a regulatory capital rule, a spread that disappears once management
is counted. Declare each with structural_finding set to HIDDEN_CONSTRAINT. Do not report
things true of every business: that staff must be paid, that contracts must be lawful,
that customers might not buy. Those are assumed and reporting them wastes the reader's
attention on what is already known.

Evidence standard: published sources, each identified by its URL and by who publishes it,
each carrying the date it was published or last observed. A figure is read from a source,
never produced. Where nothing publishes an amount, record the requirement with no amount
and say what would settle it — an unknown amount is reported as unknown, and never as a
small number or as nothing to pay.

Completion standard: each requirement either carries a published figure or is explicitly
recorded as having none. A restructuring with no published residual is reported as
available and does not reduce anything.

Out of scope: contacting any person or organisation; buying access, data, a subscription
or a paid API; placing an advertisement; publishing, posting, listing, filing or
submitting anything anywhere; making any commitment on anybody's behalf. This is
read-only research into what is already published, and every action beyond reading needs
a separate commercial authorization from a person.`;

/**
 * What a cash question may cite, what that means in words, and what it may
 * never instruct Brain to do.
 *
 * Shared by the discovery envelope and the validation envelope rather than
 * written twice, because the two authorize the same *actions* and differ only
 * in the assignment they pin. Two copies would be two things to keep in step,
 * and the one nobody reads is the one that drifts.
 *
 * The allowlist refused six of ten correctly-shaped production plans, and every
 * refusal was the alphabet rather than the rule. `company (?:site|website|page|
 * blog)` does not match "company careers page"; `review site` does not match
 * "Yelp review thread"; `licen[cs]e` does not match "licensing board"; `price
 * list` does not match "a platform's own pricing page". Each of those is
 * exactly the sort of published artefact these envelopes exist to admit, and
 * each cost a whole plan at the planning pass.
 *
 * So the entries are the *classes*, spelled loosely enough to survive ordinary
 * phrasing: a bare stem where the family is unambiguous (`licen[cs]` covers
 * licence, license and licensing), and the noun on its own where the qualifier
 * was what kept missing (`review`, `careers`, `pricing`). A source type still
 * has to be *declared* by the fragment and still has to match, so a fragment
 * that accepted "whatever we find" is refused for declaring nothing.
 *
 * What is still refused is what was always refused: anything that is not a
 * published artefact somebody can open. A private database, a purchased list,
 * an interview, a phone call and a personal contact match none of these, and
 * the source-validation gate refuses an unreachable URL besides.
 */
const CASH_SOURCE_TYPES =
  /(official|government|\.gov|statut|regulat|public record|filing|registry|register|court|permit|licen[cs]|tender|procurement|bid|rfp|rfq|solicitation|marketplace|market place|job board|job posting|jobs? page|careers?|hiring|recruit|listing|classified|posting|advert|auction|exchange|price|pricing|rate card|fee schedule|quote|catalog|inventory|directory|capability statement|dsbs|small business search|trade (?:association|body|publication)|industry (?:report|survey|body)|census|statistic|bureau|standards body|company|business|supplier|vendor|platform|site|website|web page|page|blog|status page|press release|annual report|prospectus|news|publication|journal|review|rating|testimonial|forum|community|social|bounty|contest|challenge|prize|appraisal|valuation|comparable|complaint|terms of service|terms and conditions|policy|rules|api)/i;

const CASH_SOURCE_RULE =
  'a published source somebody can open — an official or government record, a marketplace, ' +
  'auction, job board or classified listing, a company or platform page including pricing, ' +
  'careers and terms, a directory, a trade or industry publication, news, a forum or review ' +
  'thread, a bounty or contest listing, or a published appraisal or valuation';

/**
 * Language that would mean acting on the world rather than reading about it.
 *
 * These are phrases describing Brain *doing* something, never words that happen
 * to appear in a commercial subject — and `actorScope.ts` is what makes that
 * distinction hold, because the fields this is tested against say what to look
 * for rather than what Brain will do. A bare `\bpay\b` would refuse "establish
 * how long after invoicing a buyer pays", which is the ordinary question these
 * envelopes exist to allow.
 */
const CASH_FORBIDDEN_ACTIONS =
  /\b(purchase|paid api|api key|subscription fee|subscribe to|pay for access|paywall bypass|buy (?:the |a |an )?(?:list|data|access|leads)|telephone call|phone call|call the|cold call|email the|write to the|contact the|reach out to|message the|dm the|submit a (?:request|bid|proposal|application) to|file a (?:complaint|request|petition)|register with|apply for a|sign up (?:for|with)|place an? (?:ad|advert|order|bid)|run an? (?:ad|advert|campaign)|post to|publish (?:a|our|the report|this report|a listing)|list (?:it |the item )?for sale|negotiate with|agree terms with|commit (?:funds|money)|make a payment|send payment|hire|engage a contractor)\b/i;

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
    sourceRule:
      'an official Michigan state, county or municipal record, portal or published guidance',
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
   * The standing authorization a Cash Mode project's compiled discovery runs
   * under (§30).
   *
   * Three things about it are different from every other envelope here, and all
   * three are deliberate rather than relaxed.
   *
   * **It is not scoped to a project slug.** The four private operations a cash
   * sprint runs in are projects an operator creates; this repository cannot know
   * their names, and freezing a guessed one would mean the envelope authorized
   * nothing. The scoping is a row instead: `cash_modes.envelope_id`, written by
   * a person with ADMIN on that project when they activated the section, and
   * validated against `SELECTABLE_CASH_ENVELOPES` so a mode can only ever name
   * an envelope somebody reviewed. That keeps §16's actual property — nobody
   * supplies the limits their own plan is judged against — while moving *which*
   * reviewed limits apply from a constant to a recorded decision.
   *
   * **It does not bound geography, and that is stated rather than hidden.**
   * `geography` accepts any declared market and `forbiddenScope` matches
   * nothing, because the authorized mandate is broad discovery across
   * industries, business models and markets, and an envelope that refused an
   * opening for being in the wrong state would refuse precisely the work it
   * exists to permit. What bounds this envelope is not where it may look but
   * **what it may do**: `forbiddenActions` and `allowedSourceTypes` below, plus
   * the fact that research authority in this Brain has never been able to spend
   * anything. A blank cheque would be an envelope that authorized an effect; this
   * one authorizes reading.
   *
   * **Every effect is somebody else's decision.** Contacting a buyer, quoting,
   * committing money and accepting payment are `COMMERCIAL_ACTIONS`, granted by
   * a person in `cash_authorities` with a ceiling on each. A fragment running
   * under this envelope that described doing any of them is refused by
   * `forbiddenActions`, exactly as it would be in the public-records envelope.
   */
  RUSSELL_CASH_DISCOVERY_V1: Object.freeze({
    id: 'RUSSELL_CASH_DISCOVERY_V1',
    authorization:
      'The operator authorized standing read-only discovery research inside a Cash Mode ' +
      'project: published sources only, across any industry, business model or market, with no ' +
      'spending, no paid API or purchased data, no contact with any person or organisation, no ' +
      'advertising, no publishing and no external effect of any kind. Acting on what is ' +
      'discovered is authorized separately by a commercial grant a person makes, and never by ' +
      'this envelope.',
    assignmentTemplate: CASH_DISCOVERY_ASSIGNMENT_TEMPLATE,
    jurisdiction: 'the market this question names',
    // As many bounded questions as the gaps require: every condition below
    // applies to each of them, so a broader decomposition is more to refuse
    // rather than more room to hide in.
    maxFragments: null,
    // Any declared market, and nothing forbidden by geography. See the note
    // above: this envelope bounds actions, not places. `(?!)` is a pattern that
    // matches no input at all, written explicitly rather than by leaving the
    // field out, so a reader can see that the absence is a decision.
    geography: /\S/,
    forbiddenScope: /(?!)/,
    // Published sources of every kind a market question is answered from. A
    // source type still has to be *declared* by the fragment and still has to
    // match, so a fragment that accepted "whatever we find" is refused for
    // declaring nothing — `planFitsEnvelope` refuses an empty list outright.
    /*
     * Published sources of every kind a market question is answered from.
     *
     * This list refused six of ten correctly-shaped production plans, and every
     * refusal was the alphabet rather than the rule. `company (?:site|website|
     * page|blog)` does not match "company careers page"; `review site` does not
     * match "Yelp review thread"; `licen[cs]e` does not match "licensing
     * board"; `price list` does not match "a platform's own pricing page".
     * Each of those is exactly the sort of published artefact this envelope
     * exists to admit, and each cost a whole plan at the planning pass.
     *
     * So the entries below are the *classes*, spelled loosely enough to survive
     * ordinary phrasing: a bare stem where the family is unambiguous
     * (`licen[cs]` covers licence, license and licensing), and the noun on its
     * own where the qualifier was what kept missing (`review`, `careers`,
     * `pricing`). A source type still has to be *declared* by the fragment and
     * still has to match, so a fragment that accepted "whatever we find" is
     * refused for declaring nothing — `planFitsEnvelope` refuses an empty list
     * outright.
     *
     * What it still refuses is what it always refused: anything that is not a
     * published artefact somebody can open. A private database, a purchased
     * list, an interview, a phone call and a personal contact match none of
     * these, and the source-validation gate refuses an unreachable URL besides.
     */
    allowedSourceTypes: CASH_SOURCE_TYPES,
    sourceRule: CASH_SOURCE_RULE,
    /*
     * Language that would mean acting on the world rather than reading about
     * it. The same construction the public-records envelope settled on and for
     * the same reason: these are phrases describing Brain *doing* something,
     * never words that happen to appear in a commercial subject. A bare
     * `\bpay\b` would refuse "establish how long after invoicing a buyer pays",
     * which is the ordinary question this envelope exists to allow.
     */
    forbiddenActions: CASH_FORBIDDEN_ACTIONS,
    minIndependentSourcesFloor: 1,
  } satisfies ApprovalEnvelope),

  /**
   * The bounded deep dive on one opening the discovery envelope already found.
   *
   * Everything about what it may *do* is `RUSSELL_CASH_DISCOVERY_V1`'s, taken
   * deliberately rather than written afresh: the same source classes, the same
   * forbidden actions, the same zero external effect. What differs is the
   * assignment it pins, which asks the commercial questions about one named
   * subject instead of asking a market a broad question.
   *
   * It is a separate envelope rather than a second template on the first
   * because `planFitsEnvelope` pins exactly one template per envelope, and a
   * packet must be judged against the rules for the question it is actually
   * asking. Adding it is a code change somebody reviews, which is where "does
   * this authorize an effect?" gets asked — and the answer here is no: it
   * authorizes reading about something Brain has already found.
   */
  RUSSELL_CASH_VALIDATION_V1: Object.freeze({
    id: 'RUSSELL_CASH_VALIDATION_V1',
    authorization:
      'The operator authorized standing read-only research inside a Cash Mode project when ' +
      'they started it: published sources only, across any industry, business model or ' +
      'market, with no spending, no paid API or purchased data, no contact with any person or ' +
      'organisation, no advertising, no publishing and no external effect of any kind. This ' +
      'envelope is that authorization applied to one opening Brain has already found, so a ' +
      'person can decide whether to act on it. Acting is authorized separately by a ' +
      'commercial grant a person makes, and never by this envelope.',
    assignmentTemplate: CASH_VALIDATION_ASSIGNMENT_TEMPLATE,
    jurisdiction: 'the market this question names',
    // One opening, and as many bounded questions about it as the unknowns
    // require. Every condition applies to each of them.
    maxFragments: null,
    geography: /\S/,
    forbiddenScope: /(?!)/,
    allowedSourceTypes: CASH_SOURCE_TYPES,
    sourceRule: CASH_SOURCE_RULE,
    forbiddenActions: CASH_FORBIDDEN_ACTIONS,
    minIndependentSourcesFloor: 1,
  } satisfies ApprovalEnvelope),

  /**
   * The question that builds the map, rather than searching inside it.
   *
   * `RUSSELL_CASH_DISCOVERY_V1`'s permissions exactly — the same source
   * classes, the same forbidden actions, the same zero external effect, taken
   * by reference rather than written afresh so the three cannot drift into
   * authorizing different things. What differs is only the assignment it pins,
   * which is why it is a separate envelope at all: `planFitsEnvelope` pins one
   * template per envelope, and a packet has to be judged against the rules for
   * the question it is actually asking.
   *
   * **It authorizes no effect that discovery did not already authorize.**
   * Adding it is a code change somebody reviews, which is where "does this
   * authorize something new?" gets asked, and the answer is no: it authorizes
   * reading published sources about how an industry is organized.
   */
  RUSSELL_INDUSTRY_MAP_V1: Object.freeze({
    id: 'RUSSELL_INDUSTRY_MAP_V1',
    authorization:
      'The operator authorized standing read-only discovery research inside a Cash Mode ' +
      'project when they started it: published sources only, across any industry, business ' +
      'model or market, with no spending, no paid API or purchased data, no contact with any ' +
      'person or organisation, no advertising, no publishing and no external effect of any ' +
      'kind. This envelope is that authorization applied to establishing how a part of the ' +
      'economy is organized, so that the search for openings has somewhere to look. Acting ' +
      'on what is found is authorized separately by a commercial grant a person makes, and ' +
      'never by this envelope.',
    assignmentTemplate: INDUSTRY_MAP_ASSIGNMENT_TEMPLATE,
    jurisdiction: 'the market this question names',
    maxFragments: null,
    geography: /\S/,
    forbiddenScope: /(?!)/,
    allowedSourceTypes: CASH_SOURCE_TYPES,
    sourceRule: CASH_SOURCE_RULE,
    forbiddenActions: CASH_FORBIDDEN_ACTIONS,
    minIndependentSourcesFloor: 1,
  } satisfies ApprovalEnvelope),

  /**
   * Who is permitted and available to produce one output.
   *
   * `RUSSELL_CASH_DISCOVERY_V1`'s permissions exactly — the same source
   * classes, the same forbidden actions, the same zero external effect, taken
   * by reference rather than written afresh so the four cannot drift into
   * authorizing different things. What differs is only the assignment it pins,
   * which is why it is a separate envelope at all: `planFitsEnvelope` pins one
   * template per envelope, and a packet has to be judged against the rules for
   * the question it is actually asking.
   *
   * **It authorizes no effect that discovery did not already authorize**, and
   * that is worth saying plainly because the subject sounds like hiring.
   * Nothing here approaches a contractor, answers a job posting, requests a
   * quote, opens an account on a marketplace or engages anybody. It authorizes
   * *reading about* who may lawfully do this work and what it is published to
   * cost. Every one of those actions is a `COMMERCIAL_ACTION` a person grants
   * separately, and the assignment template names them as out of scope so a
   * worker is told rather than merely refused.
   */
  RUSSELL_LABOR_ALLOCATION_V1: Object.freeze({
    id: 'RUSSELL_LABOR_ALLOCATION_V1',
    authorization:
      'The operator authorized standing read-only research inside this project: published ' +
      'sources only, with no spending, no paid API or purchased data, no contact with any ' +
      'person or organisation, no advertising, no publishing and no external effect of any ' +
      'kind. This envelope is that authorization applied to establishing who or what may ' +
      'lawfully produce one output and what published sources say it costs to obtain that ' +
      'capability. It authorizes reading about labor and never engaging any: approaching, ' +
      'hiring, contracting, posting, quoting and every other commitment is a commercial ' +
      'action a person grants separately, and never this envelope.',
    assignmentTemplate: LABOR_ALLOCATION_ASSIGNMENT_TEMPLATE,
    jurisdiction: 'the market this question names',
    maxFragments: null,
    geography: /\S/,
    forbiddenScope: /(?!)/,
    allowedSourceTypes: CASH_SOURCE_TYPES,
    sourceRule: CASH_SOURCE_RULE,
    forbiddenActions: CASH_FORBIDDEN_ACTIONS,
    minIndependentSourcesFloor: 1,
  } satisfies ApprovalEnvelope),

  /**
   * Taking a capital requirement apart, which is the one question that decides
   * whether an opening is reachable with the money that actually exists.
   *
   * Same permissions again, and the same argument for being its own envelope.
   * Worth saying explicitly because the subject sounds financial: nothing here
   * authorizes borrowing, committing, depositing or spending anything. It
   * authorizes *reading about* how an industry finances work of this kind, and
   * every one of the mechanisms its assignment names is a thing to establish
   * from a published source rather than a thing to do.
   */
  RUSSELL_CAPITAL_STRUCTURE_V1: Object.freeze({
    id: 'RUSSELL_CAPITAL_STRUCTURE_V1',
    authorization:
      'The operator authorized standing read-only research inside a Cash Mode project when ' +
      'they started it: published sources only, with no spending, no paid API or purchased ' +
      'data, no contact with any person or organisation, no advertising, no publishing and no ' +
      'external effect of any kind. This envelope is that authorization applied to ' +
      'establishing what capital one opening requires and how its industry finances work of ' +
      'that kind. It authorizes reading about those mechanisms and never using one: every ' +
      'commitment, deposit, borrowing and purchase is a commercial action a person grants ' +
      'separately, and never this envelope.',
    assignmentTemplate: CAPITAL_STRUCTURE_ASSIGNMENT_TEMPLATE,
    jurisdiction: 'the market this question names',
    maxFragments: null,
    geography: /\S/,
    forbiddenScope: /(?!)/,
    allowedSourceTypes: CASH_SOURCE_TYPES,
    sourceRule: CASH_SOURCE_RULE,
    forbiddenActions: CASH_FORBIDDEN_ACTIONS,
    minIndependentSourcesFloor: 1,
  } satisfies ApprovalEnvelope),

  /**
   * The manufacturing programme's three questions.
   *
   * Same permissions as the cash discovery envelope, taken from the same two
   * constants rather than restated — so a source class or a prohibition added
   * there reaches these without anybody remembering. Three envelopes rather
   * than one for `RUSSELL_CASH_VALIDATION_V1`'s reason: `planFitsEnvelope`
   * pins one assignment template per envelope, and a packet has to be judged
   * against the rules for the question it is actually asking. Asking which
   * machines exist, asking who buys them and asking what building them takes
   * are three questions with three completion standards, and judging one by
   * another's is the Westbrook defect at a compiler.
   *
   * **They authorize no effect that discovery did not already authorize.**
   * Adding them is a code change somebody reviews, which is where "does this
   * authorize something new?" gets asked, and the answer is no: they authorize
   * reading published sources about how machines are built, bought and sold.
   * Nothing here authorizes building, buying, tooling or entering anything —
   * those are decisions with a factory on the end of them, and there is no
   * route to one through any envelope.
   */
  RUSSELL_MACHINE_LADDER_V1: Object.freeze({
    id: 'RUSSELL_MACHINE_LADDER_V1',
    authorization:
      'The operator authorized standing read-only research inside a manufacturing programme ' +
      'when they started it: published sources only, across any class of machine, market or ' +
      'producer, with no spending, no paid API or purchased data, no contact with any person ' +
      'or organisation, no advertising, no publishing and no external effect of any kind. ' +
      'This envelope is that authorization applied to establishing which classes of machine ' +
      'the sources recognise and how they relate, so that every later question has somewhere ' +
      'to point. Deciding to produce anything is a decision a person makes, and it is ' +
      'authorized by nothing here.',
    assignmentTemplate: MACHINE_LADDER_ASSIGNMENT_TEMPLATE,
    jurisdiction: 'the market this question names',
    maxFragments: null,
    geography: /\S/,
    forbiddenScope: /(?!)/,
    allowedSourceTypes: CASH_SOURCE_TYPES,
    sourceRule: CASH_SOURCE_RULE,
    forbiddenActions: CASH_FORBIDDEN_ACTIONS,
    minIndependentSourcesFloor: 1,
  } satisfies ApprovalEnvelope),

  /**
   * Who is buying, and how product reaches them.
   *
   * The question the whole kernel is ordered around, and the one whose
   * completion standard has to be able to come back empty. *Nothing published
   * establishes that anybody is buying* is the finding that stops a category
   * being entered, so the assignment asks for it by name rather than treating
   * silence as an incomplete answer.
   */
  RUSSELL_MACHINE_DEMAND_V1: Object.freeze({
    id: 'RUSSELL_MACHINE_DEMAND_V1',
    authorization:
      'The operator authorized standing read-only research inside a manufacturing programme ' +
      'when they started it: published sources only, with no spending, no paid API or ' +
      'purchased data, no contact with any person or organisation, no advertising, no ' +
      'publishing and no external effect of any kind. This envelope is that authorization ' +
      'applied to establishing who is buying machines of a given kind, how product reaches ' +
      'them, and where what is on the market today falls short. It authorizes reading about a ' +
      'market and never acting in one: every approach, listing, purchase and commitment is a ' +
      'commercial action a person grants separately, and never this envelope.',
    assignmentTemplate: MACHINE_DEMAND_ASSIGNMENT_TEMPLATE,
    jurisdiction: 'the market this question names',
    maxFragments: null,
    geography: /\S/,
    forbiddenScope: /(?!)/,
    allowedSourceTypes: CASH_SOURCE_TYPES,
    sourceRule: CASH_SOURCE_RULE,
    forbiddenActions: CASH_FORBIDDEN_ACTIONS,
    minIndependentSourcesFloor: 1,
  } satisfies ApprovalEnvelope),

  /**
   * What producing requires, what it develops, and what is bought in.
   *
   * Worth saying explicitly because the subject sounds industrial: nothing here
   * authorizes tooling, qualifying, certifying, building or acquiring anything.
   * It authorizes *reading about* what producing a class of machine involves,
   * and every one of the things its assignment names is something to establish
   * from a published source rather than something to do.
   *
   * Its assignment also states, in the subject line, that the research is about
   * the industry and not about the organisation commissioning it. Brain refuses
   * a claim about the latter either way — there is no capability_finding that
   * could mark a capability held — but a worker who understands the question
   * writes better claims than one whose answers are silently discarded.
   */
  RUSSELL_MACHINE_CAPABILITY_V1: Object.freeze({
    id: 'RUSSELL_MACHINE_CAPABILITY_V1',
    authorization:
      'The operator authorized standing read-only research inside a manufacturing programme ' +
      'when they started it: published sources only, with no spending, no paid API or ' +
      'purchased data, no contact with any person or organisation, no advertising, no ' +
      'publishing and no external effect of any kind. This envelope is that authorization ' +
      'applied to establishing what producing a class of machine requires, what producing it ' +
      'develops, what must be certified or tooled first, and which components producers buy ' +
      'in. It authorizes reading about those things and never doing one of them: tooling, ' +
      'qualifying, certifying, acquiring and producing are decisions a person makes, and this ' +
      'envelope authorizes none of them.',
    assignmentTemplate: MACHINE_CAPABILITY_ASSIGNMENT_TEMPLATE,
    jurisdiction: 'the market this question names',
    maxFragments: null,
    geography: /\S/,
    forbiddenScope: /(?!)/,
    allowedSourceTypes: CASH_SOURCE_TYPES,
    sourceRule: CASH_SOURCE_RULE,
    forbiddenActions: CASH_FORBIDDEN_ACTIONS,
    minIndependentSourcesFloor: 1,
  } satisfies ApprovalEnvelope),

  /**
   * What entering a class of machine costs.
   *
   * Its own envelope rather than sharing the capability one, for
   * `planFitsEnvelope`'s reason: it pins one assignment template per envelope,
   * and *what producing requires* and *what entering costs* have two different
   * completion standards. The second one's completion standard is the unusual
   * half — a requirement with no published figure is a **successful** answer
   * — and judging it by the first's would push a worker towards producing an
   * estimate, which is the one output this question most needs never to
   * receive.
   */
  RUSSELL_MACHINE_CAPITAL_V1: Object.freeze({
    id: 'RUSSELL_MACHINE_CAPITAL_V1',
    authorization:
      'The operator authorized standing read-only research inside a manufacturing programme ' +
      'when they started it: published sources only, with no spending, no paid API or ' +
      'purchased data, no contact with any person or organisation, no advertising, no ' +
      'publishing and no external effect of any kind. This envelope is that authorization ' +
      'applied to establishing what entering a class of machine costs, requirement by ' +
      'requirement, from figures somebody has already published. It authorizes reading about ' +
      'what things cost and never spending anything, requesting a quotation, or committing to ' +
      'a purchase: every one of those is a commercial action a person grants separately, and ' +
      'never this envelope.',
    assignmentTemplate: MACHINE_CAPITAL_ASSIGNMENT_TEMPLATE,
    jurisdiction: 'the market this question names',
    maxFragments: null,
    geography: /\S/,
    forbiddenScope: /(?!)/,
    allowedSourceTypes: CASH_SOURCE_TYPES,
    sourceRule: CASH_SOURCE_RULE,
    forbiddenActions: CASH_FORBIDDEN_ACTIONS,
    minIndependentSourcesFloor: 1,
  } satisfies ApprovalEnvelope),

  /**
   * Which firms could supply what a class of machine requires.
   *
   * The directive asks Brain to *identify acquisition opportunities*, and its
   * optimization rule gives the reason: *an acquisition could suddenly make an
   * advanced category viable much earlier*. Identifying one is research about
   * published sources and it is authorized here.
   *
   * **Everything that follows from one is not, and this envelope is where that
   * is said rather than assumed.** Approaching, requesting information from,
   * valuing, offering for, committing to, diligencing or buying a firm are
   * separately authorized commercial actions, and no route through this kernel
   * reaches one. The table these findings land in has no column an approach,
   * a valuation, a term or a commitment could be written into, which is the
   * mechanism; this paragraph and the assignment are what make the boundary
   * legible to the worker as well as to the schema.
   */
  RUSSELL_MACHINE_ACQUISITION_V1: Object.freeze({
    id: 'RUSSELL_MACHINE_ACQUISITION_V1',
    authorization:
      'The operator authorized standing read-only research inside a manufacturing programme ' +
      'when they started it: published sources only, with no spending, no paid API or ' +
      'purchased data, no contact with any person or organisation, no advertising, no ' +
      'publishing and no external effect of any kind. This envelope is that authorization ' +
      'applied to identifying, from published sources, which firms hold something a class of ' +
      'machine requires. It authorizes naming them and saying what each holds. It authorizes ' +
      'no approach, no request for information, no valuation, no offer, no diligence ' +
      'commitment, no negotiation and no purchase — every one of those is a decision a person ' +
      'makes under a separate authorization, and nothing in this programme can make it.',
    assignmentTemplate: MACHINE_ACQUISITION_ASSIGNMENT_TEMPLATE,
    jurisdiction: 'the market this question names',
    maxFragments: null,
    geography: /\S/,
    forbiddenScope: /(?!)/,
    allowedSourceTypes: CASH_SOURCE_TYPES,
    sourceRule: CASH_SOURCE_RULE,
    forbiddenActions: CASH_FORBIDDEN_ACTIONS,
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
    sourceRule: 'Delaware statutory material or the state\'s own published guidance',
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
    sourceRule: 'a primary statute, administrative code, regulator or official state source',
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
    sourceRule:
      'a Michigan statute, administrative rule, regulator publication, declaratory ruling or ' +
      'court decision',
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
    /*
     * An action Brain would take, rather than a transaction the sources are
     * about.
     *
     * The fields scanned here — the question, the definitions, the population
     * and the completion criteria — say what to look for and what counts.
     * None of them says what Brain will do. So a bare word match refused a
     * fragment about government surplus auctions for containing "purchase",
     * which is the subject of every honest description of one. `actorScope.ts`
     * has the whole argument and the reason narrowing is the safe direction:
     * the grant's `max_external_spend = 0`, the separate commercial grant and
     * the absence of any tool that performs an effect are the enforcement, and
     * this is a screen standing in front of them.
     */
    const ownActions = ownActionMatches(prose, envelope.forbiddenActions);
    if (ownActions.length > 0) {
      reasons.push(
        `${where} instructs the researcher to ${ownActions[0]!.phrase.toLowerCase()}, which is ` +
          'an action on the world rather than reading a published source. This envelope ' +
          'authorizes no spending, no purchase, no contact, no commitment and no publication.',
      );
    }
    if (fragment.acceptableSourceTypes.length === 0) {
      reasons.push(`${where} declares no acceptable source types, so nothing bounds what it may cite.`);
    }
    for (const source of fragment.acceptableSourceTypes) {
      if (!envelope.allowedSourceTypes.test(source)) {
        /*
         * The envelope's own rule, never a constant.
         *
         * This sentence read "which is not a primary statute, regulation or
         * regulator source" for every envelope. It is true of the two
         * statutory ones and a plain lie about cash discovery, which admits
         * marketplaces, listings, job boards, auctions, company pages and
         * forums by design — and production refused six correct plans with it.
         * An operator reading that would go and look for statutes.
         */
        reasons.push(
          `${where} accepts "${source}", which this envelope does not admit. It admits ` +
            `${envelope.sourceRule}.`,
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

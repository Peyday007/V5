/**
 * What a compiled mission looks like, per envelope.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * Adding the Cash Mode envelope widened what a fragment was *allowed* to cite
 * and changed nothing about what the compiler *wrote*. Every objective still
 * said "from official Michigan public records", every source class was a county
 * office or a state statute, every excluded source banned forums, blogs and
 * social media, and every completion standard asked for county variation. So a
 * marketplace request or a company's urgent paid request compiled into a
 * public-records research task, and a worker would have answered it correctly
 * and answered the wrong question.
 *
 * That is §25's Westbrook defect in a third place: **the wrong answer
 * confidently derived is worse than no answer**, and nothing below the compiler
 * could have caught it, because the gate judges evidence against the fragment's
 * declared scope and the scope was the thing that was wrong.
 *
 * ---------------------------------------------------------------------------
 * What a profile may and may not decide
 * ---------------------------------------------------------------------------
 *
 * A profile is **vocabulary and sentences**, never permission. It proposes
 * source classes; `compileMission` still filters every one of them through
 * `envelope.allowedSourceTypes`, so a profile that drifted out of alignment
 * with its envelope loses classes rather than smuggling them in. It writes no
 * claim, cites no source and reaches no conclusion — the same line the compiler
 * itself does not cross.
 *
 * The evidence floor stays the envelope's. A profile cannot lower
 * `minIndependentSources`, cannot add a source type the envelope refuses, and
 * cannot make a fragment approvable that `planFitsEnvelope` would decline.
 */
import type { EvidenceLane } from '../../domain/types.ts';

export type CompilerProfileId = 'PUBLIC_RECORDS' | 'MARKET_DISCOVERY' | 'COMMERCIAL_VALIDATION';

export interface CompilerProfile {
  id: CompilerProfileId;
  /** The fragment's key, which is how a worker's output is split back apart. */
  fragmentKey: string;
  /**
   * What a question naming several jurisdictions means here.
   *
   * `REFUSE` for public records, because "which county's rule applies" is a
   * decomposition decision and guessing would be the compiler inventing scope.
   * `DESCRIBE` for market discovery, because a market genuinely spans them: a
   * question about demand in Michigan and Ohio is one question about a
   * two-state market, and refusing it would refuse the work the envelope exists
   * to permit.
   */
  multipleJurisdictions: 'REFUSE' | 'DESCRIBE';
  /**
   * Where this kind of question sits in the launch queue, within its priority.
   *
   * `nextLaunchable` orders by priority, then `COALESCE(ordinal, 999)`, then
   * `created_at` — so with every candidate judged `WORTH_DOING` and every
   * ordinal null, a queue is pure arrival order. Production measured what that
   * costs: twenty openings found, both of their deep dives created *after* the
   * fifty-odd broad searches still waiting, and therefore behind every one of
   * them. A sprint could keep finding openings and never qualify one.
   *
   * **Finishing what has already been spent outranks starting the next
   * search.** That is an ordering statement rather than a permission, which is
   * why it belongs on the profile beside the rest of this envelope's
   * vocabulary: no bar moves, nothing is refused, and a broad search still
   * launches the moment nothing narrower is waiting.
   *
   * Lower goes first, and the numbers are spaced so a kind can be inserted
   * between two without renumbering the others.
   */
  launchOrdinal: number;
  /** Proposed classes. Every one is still filtered through the envelope. */
  proposedSources: string[];
  /** What may never carry a claim on its own. */
  excludedSources: string[];
  lanes: EvidenceLane[];
  expectedClaimTypes: string[];
  failureConditions: string[];
  /**
   * The objective, composed from the question and the scope.
   *
   * `from` says where the scope came from, because a sentence that asserted a
   * subject was *in* a jurisdiction nothing named is the defect §25 records.
   */
  objective(input: { question: string; scope: string; from: 'SUBJECT' | 'QUESTION' | 'ENVELOPE' }): string;
  completionCriteria(scope: string): string[];
}

/**
 * The profile Deal Dispatch's standing research has always had, unchanged.
 *
 * Extracted rather than rewritten: every string here is the one the compiler
 * produced before profiles existed, so the public-records path compiles byte
 * for byte what it did — which matters, because `launch()` treats one
 * specification as researchable once and a changed sentence would relaunch
 * every idea that has already been researched.
 */
const PUBLIC_RECORDS: CompilerProfile = {
  id: 'PUBLIC_RECORDS',
  fragmentKey: 'official-record',
  multipleJurisdictions: 'REFUSE',
  // The ordinary case: nothing about a public-records question makes it a
  // continuation of anything, so it takes its turn by arrival.
  launchOrdinal: 500,
  proposedSources: [
    'county register of deeds or recording office',
    'county clerk, assessor, equalization or treasurer office',
    'municipal or township clerk office',
    'state of michigan department or bureau guidance',
    'michigan statute or administrative rule',
    'official county or state open-data portal or fee schedule',
  ],
  excludedSources: [
    'vendor or software marketing pages',
    'title-company or law-firm articles as sole support',
    'news summaries as sole support',
    'forum posts, blogs and social media',
  ],
  lanes: [
    {
      id: 'official_source',
      description:
        'The official office, statute, rule or portal that states the answer, quoted, with ' +
        'its URL and the date it was published or last updated.',
      necessity: 'REQUIRED',
    },
    {
      id: 'office_variation',
      description:
        'Where the answer differs between offices or counties, the differing official ' +
        'sources named per office — and an explicit statement that it does not differ, if ' +
        'the sources show that.',
      necessity: 'CONDITIONAL',
    },
  ],
  expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION', 'NEGATIVE_EXISTENCE'],
  failureConditions: [
    'No official source can be located for a part of the question.',
    'The only sources found are secondary, so nothing primary supports the answer.',
  ],
  objective: ({ question, scope, from }) =>
    from === 'ENVELOPE'
      ? `Establish, from the official ${scope} public records this project is ` +
        `authorized to search — nothing about this names a jurisdiction of its own — ` +
        lowerFirst(question)
      : `Establish, from official ${scope} public records, ${lowerFirst(question)}`,
  completionCriteria: (scope) => [
    'Every part of the question is answered from a quoted official source, or recorded as ' +
      'unresolved naming the offices searched and what was not found.',
    'Every source carries its URL, the office or authority that publishes it, and the date ' +
      'it was published or last updated.',
    'Every claim carries the URL of the source it came from. A claim submitted without one ' +
      'is rejected, and a fragment whose claims are mostly rejected is blocked outright — ' +
      'which discards the well-sourced claims beside them. If you found the source but could ' +
      'not read it, submit the claim with that URL and its retrieval state, which is recorded ' +
      'as unresolved rather than rejected. If you have no source at all, it is not a claim: ' +
      'report it instead of submitting it.',
    `Every finding is about ${scope}; anything found about anywhere else is ` +
      'reported as out of scope rather than used.',
  ],
};

/**
 * Broad commercial discovery: what a Cash Mode question is actually asking.
 *
 * Three things are deliberately different from the public-records profile, and
 * each one is a thing the review found wrong rather than a preference.
 *
 * **A signal is not banned for coming from where signals come from.** A
 * marketplace posting, a job board, a forum thread and a company's own
 * announcement are exactly where a demand signal lives, and the old profile
 * excluded all of them. What is excluded here is a *figure whose upstream
 * source cannot be identified* and *a forecast presented as a current fact* —
 * §14's rule that sources which are really one source are counted as one, and
 * that a forecast is never a fact whatever supports it.
 *
 * **An opportunity signal and verified economics are different lanes.** "Somebody
 * asked for this" and "this is what it pays" are two claims with two standards,
 * and collapsing them is how "an industry has many missed calls" becomes
 * evidence that one owner will buy this week. The lanes say so.
 *
 * **A market can span jurisdictions.** Refusing a question that names two
 * states is right for a statutory question and wrong here, where two states are
 * one market.
 */
const MARKET_DISCOVERY: CompilerProfile = {
  id: 'MARKET_DISCOVERY',
  fragmentKey: 'market-signal',
  multipleJurisdictions: 'DESCRIBE',
  // A broad search that has not started. It is the thing a deep dive on an
  // opening already found is allowed to go ahead of.
  launchOrdinal: 500,
  proposedSources: [
    'a published request, posting, listing, notice or advertisement, attributed to whoever made it',
    'a marketplace, job board, classified or auction listing',
    'a tender, procurement notice, RFP, RFQ or public solicitation',
    'an organisation’s own website, press release or announcement',
    'a published price list, rate card or fee schedule',
    'an official registry, filing, permit or licence record',
    'a trade association, industry body or trade publication',
    'a census, statistical or government publication',
    'a review site, forum or community discussion, as a signal rather than as support',
  ],
  excludedSources: [
    'a figure whose upstream source cannot be identified',
    'an estimate restated by several publishers from one release, counted more than once',
    'a forecast or projection presented as a current fact',
    'a claim with no locatable source at all',
  ],
  lanes: [
    {
      id: 'demand_signal',
      // One published request proves its own existence. Demanding a second
      // publisher for "this posting exists" demands something that does not
      // exist, which is what `SPECIFIC_INSTANCE` says.
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'An opening that is **open**: the specific published request, posting, listing, notice, ' +
        'filing or announcement this rests on, attributed to whoever made it, with its URL and ' +
        'the date it was published or observed. A general statement that an industry has a ' +
        'problem is not this lane, and neither is a finding that nobody is asking or that a ' +
        'request has closed — those have lanes of their own, because everything filed here ' +
        'becomes a piece of work somebody may go and pursue.',
      necessity: 'REQUIRED',
    },
    {
      id: 'demand_absence',
      description:
        'A documented absence: the places a request would have been published were searched ' +
        'and nothing was found. Name where you looked and when, because a claim that something ' +
        'does not exist is established by a documented search of the places it would be, or not ' +
        'at all. This is a real finding and it is deliberately not the signal lane — it belongs ' +
        'here so that "nobody is asking" cannot be filed as something to go and sell.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'demand_closed',
      description:
        'A request that was published and is no longer open: a stated closing date that has ' +
        'passed, an award or an appointment announced, a listing withdrawn or marked filled. ' +
        'Worth recording because it says where the demand was, and separate from the signal ' +
        'lane because it is not something anybody can still win.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'economics',
      // What a *market* pays, rather than what one listing says it pays, is
      // the shape that turns out to be one vendor's number repeated.
      evidenceKind: 'GENERALIZED_ECONOMICS',
      description:
        'What it pays and what it costs, from a published price, rate, fee schedule or a ' +
        'stated figure in the request itself — kept separate from the signal, because ' +
        '"somebody asked" and "this is what it pays" are two claims with two standards.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'deliverability',
      description:
        'Anything published that decides whether this can actually be delivered: a licence ' +
        'or permit requirement, a platform or marketplace restriction, a stated capacity or ' +
        'a closing date. Recorded as unresolved where nothing published settles it.',
      necessity: 'CONDITIONAL',
    },
  ],
  expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION', 'NEGATIVE_EXISTENCE'],
  failureConditions: [
    'No specific published signal can be located — only general statements that a need exists.',
    'Every figure found traces back to one upstream source, so nothing independent supports it.',
    'What is published settles the signal but not whether it can be delivered, and that is ' +
      'recorded as unresolved rather than assumed.',
  ],
  objective: ({ question, scope, from }) =>
    from === 'ENVELOPE'
      ? `Establish, from published sources, ${lowerFirst(question)} Say which market each ` +
        'finding is about; nothing about this names one of its own.'
      : `Establish, from published sources about ${scope}, ${lowerFirst(question)}`,
  completionCriteria: (scope) => [
    'Every part of the question is answered from a quoted published source, or recorded as ' +
      'unresolved naming what was searched and what was not found.',
    'Every source carries its URL, who publishes it, and the date it was published or last ' +
      'observed.',
    'Every claim carries the URL of the source it came from. A claim submitted without one ' +
      'is rejected, and a fragment whose claims are mostly rejected is blocked outright — ' +
      'which discards the well-sourced claims beside them. If you found the source but could ' +
      'not read it, submit the claim with that URL and its retrieval state, which is recorded ' +
      'as unresolved rather than rejected. If you have no source at all, it is not a claim: ' +
      'report it instead of submitting it.',
    'A demand signal names who made the request and when. "An industry has this problem" is ' +
      'not evidence that one buyer will pay this week, and is reported as context rather than ' +
      'as a signal.',
    /*
     * The one instruction that decides whether anything is ever created.
     *
     * A claim becomes a piece of work because the person who read the source
     * said what kind of opening it is, and `opportunity_signal` is the only
     * field that says so. It was documented on the submission tool and nowhere
     * a worker reads *while researching*, which is the wrong end of the job:
     * by the time somebody is filling in a claim they have already decided
     * what they were looking for.
     */
    'Where a claim establishes a concrete opening somebody could act on, set its ' +
      'opportunity_signal to the kind it is — see brain_submit_claims for the list. Most ' +
      'claims are descriptive evidence and carry none, which is not a deficiency. It lowers ' +
      'no bar: a signalled claim passes exactly the same evidence gate as every other, and ' +
      'an unsignalled one is still evidence.',
    'Sources that are really one source are counted once, and the duplication is reported: ' +
      'two pages of one site, one release carried by three outlets, three publishers ' +
      'restating one upstream estimate.',
    `Every finding says which market it is about. Where that is not ${scope}, it is reported ` +
      'as being about somewhere else rather than generalized.',
  ],
};

/**
 * Which profile an envelope compiles under.
 *
 * By envelope id, in code. An envelope with no entry compiles nothing, which is
 * deny-by-default: a compiler that fell back to *some* profile would write the
 * wrong kind of question for an authorization nobody had matched it to, which
 * is precisely the defect this module exists to fix.
 */
/**
 * The bounded deep dive on one opening Brain has already found.
 *
 * Every lane here is a question a person has to have answered before they can
 * decide, and none of them is a question a *broad* discovery fragment could
 * honestly have answered: "who is publicly asking to pay for work right now"
 * has no single payer, price or delivery path, and a production discovery
 * packet asked to produce all of them filed with half of them unresolved.
 *
 * Only one lane is REQUIRED. That is deliberate and it is the difference
 * between a deep dive and a form: the payer is what makes an opening real, and
 * everything else is a thing a person is better off knowing is *unknown* than
 * having invented for them. §30's rule — a missing value stays unknown, a blank
 * is never a zero — is what the CONDITIONAL lanes encode.
 */
const COMMERCIAL_VALIDATION: CompilerProfile = {
  id: 'COMMERCIAL_VALIDATION',
  fragmentKey: 'opening-validation',
  multipleJurisdictions: 'DESCRIBE',
  /*
   * Ahead of a search that has not started.
   *
   * This question exists because a broad search already ran, cleared the gate
   * and filed an opening — so the work behind it is spent either way, and
   * qualifying it is what turns that spending into something a person can
   * decide on. Leaving it in arrival order put it behind every bucket in the
   * sprint, which is how twenty openings sat unqualified.
   */
  launchOrdinal: 100,
  proposedSources: [
    'the published request, listing or notice this opening rests on',
    'the buying organisation’s own website, careers page, press release or announcement',
    'a marketplace, job board, classified or auction listing for comparable work',
    'a published price list, rate card, fee schedule or quote for comparable work',
    'a supplier, platform or vendor pricing page for the inputs this would need',
    'a platform’s published terms, policy or rules deciding whether this is permitted',
    'an official registry, filing, permit or licence record',
    'a trade association, industry body or trade publication',
    'a review site, forum or community discussion, as a signal rather than as support',
  ],
  excludedSources: [
    'a figure whose upstream source cannot be identified',
    'an estimate restated by several publishers from one release, counted more than once',
    'a forecast or projection presented as a current fact',
    'a claim with no locatable source at all',
  ],
  lanes: [
    {
      id: 'payer',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'Who actually pays: the organisation or role named in a published source, and the ' +
        'published way a supplier reaches them. A named buyer in the request itself settles ' +
        'this; "an industry like this" does not.',
      necessity: 'REQUIRED',
    },
    {
      id: 'price_evidence',
      evidenceKind: 'GENERALIZED_ECONOMICS',
      description:
        'What comparable work is published at — a figure or a range, each with its own source ' +
        'and date. Read from sources, never produced: where nothing publishes one, say so.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'cost_evidence',
      evidenceKind: 'GENERALIZED_ECONOMICS',
      description:
        'What delivering it would cost, from published prices for the inputs it needs — tools, ' +
        'data, subcontracted labour, platform fees. A cost nobody publishes is unknown, and an ' +
        'unknown cost is not a zero.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'timing',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'When money would actually arrive: the published payment terms, payout schedule, ' +
        'closing date or decision date, quoted from whoever publishes them.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'effort',
      evidenceKind: 'MARKET_PATTERN',
      description:
        'How much human time comparable work is published as taking, across more than one ' +
        'published example, because one listing’s estimate is that listing’s estimate.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'delivery_requirements',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'What delivering it actually requires: whether selling or calling is involved, whether ' +
        'fulfilment can be subcontracted, and any licence, platform rule or eligibility ' +
        'condition published anywhere that decides whether this is permitted at all.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'disqualifier',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'Any published fact that would rule this out outright — a closed or awarded request, a ' +
        'restriction excluding a supplier like this one, a requirement nobody here could meet. ' +
        'A documented absence of one is a real finding and belongs here.',
      necessity: 'CONDITIONAL',
    },
  ],
  expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION', 'NEGATIVE_EXISTENCE'],
  failureConditions: [
    'No published source names who would actually pay, so the opening cannot be qualified.',
    'Every figure found traces back to one upstream source, so nothing independent supports it.',
    'What is published settles the demand but not whether it can be delivered, and that is ' +
      'recorded as unresolved rather than assumed.',
  ],
  objective: ({ question, scope, from }) =>
    from === 'ENVELOPE'
      ? `Establish, from published sources, ${lowerFirst(question)} Say which market each ` +
        'finding is about; nothing about this names one of its own.'
      : `Establish, from published sources about ${scope}, ${lowerFirst(question)}`,
  completionCriteria: (scope) => [
    'Each item is either answered from a quoted published source, or explicitly recorded as ' +
      'unresolved naming what was searched and what was not found.',
    'Every source carries its URL, who publishes it, and the date it was published or last ' +
      'observed.',
    'Every claim carries the URL of the source it came from. A claim submitted without one ' +
      'is rejected, and a fragment whose claims are mostly rejected is blocked outright — ' +
      'which discards the well-sourced claims beside them. If you found the source but could ' +
      'not read it, submit the claim with that URL and its retrieval state, which is recorded ' +
      'as unresolved rather than rejected. If you have no source at all, it is not a claim: ' +
      'report it instead of submitting it.',
    'A price, a cost or a duration is read from a source and never produced. Where nothing ' +
      'publishes one, record it as unknown; an unknown is not a zero and is not an estimate.',
    `Every finding is about ${scope} or about the opening named in the question; anything ` +
      'found about a different one is reported as out of scope rather than used.',
  ],
};

const BY_ENVELOPE: Readonly<Record<string, CompilerProfile>> = Object.freeze({
  RUSSELL_PUBLIC_RECORDS_V1: PUBLIC_RECORDS,
  RUSSELL_STATE_LICENSING_V1: PUBLIC_RECORDS,
  STEP10_MICHIGAN_LICENSING_V1: PUBLIC_RECORDS,
  STEP11_AUDIT_INDEPENDENCE_V1: PUBLIC_RECORDS,
  RUSSELL_CASH_DISCOVERY_V1: MARKET_DISCOVERY,
  RUSSELL_CASH_VALIDATION_V1: COMMERCIAL_VALIDATION,
});

export function profileFor(envelopeId: string): CompilerProfile | null {
  return Object.prototype.hasOwnProperty.call(BY_ENVELOPE, envelopeId)
    ? (BY_ENVELOPE[envelopeId] as CompilerProfile)
    : null;
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

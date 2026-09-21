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

export type CompilerProfileId =
  | 'PUBLIC_RECORDS'
  | 'MARKET_DISCOVERY'
  | 'COMMERCIAL_VALIDATION'
  | 'INDUSTRY_STRUCTURE'
  | 'CAPITAL_STRUCTURE'
  | 'LABOR_ALLOCATION'
  | 'MACHINE_LADDER'
  | 'MACHINE_DEMAND'
  | 'MACHINE_CAPABILITY'
  | 'PUZZLE_MARKET'
  | 'PUZZLE_RIGHTS'
  | 'PUZZLE_PRODUCTION';

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
    /*
     * The four the production audit found nothing was asking.
     *
     * Thirty-one openings had been filed and every one of them was market
     * evidence: a vendor's published selling price, a resale *asking* price, a
     * domain appraisal, a bounty programme, a marketplace page. Each of those
     * is a real finding and none of them says anybody would pay us. What
     * separates the two is not a better-worded broad question — it is these
     * four, asked about the specific thing: may we take it at all, can we get
     * at it now, does anything actually sell at the higher figure, and does the
     * only published route to the buyer require somebody to make phone calls.
     *
     * `CONDITIONAL`, like the rest: an opening where one genuinely does not
     * apply is answered by saying so, and a documented absence is a finding.
     */
    {
      id: 'eligibility',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'What published rule decides whether a supplier like this one may take this at all — a ' +
        'licence, a registration, a platform term, a procurement qualification, a residency, ' +
        'bonding or insurance condition — quoted from whoever publishes it.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'acquisition_access',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'What is published about obtaining the thing itself *now*: from whom, at what price, on ' +
        'what terms, and what registration, membership, broker or licence stands in the way. A ' +
        'spread nobody can buy into is a fact about a market rather than an opening.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'exit_evidence',
      evidenceKind: 'MARKET_PATTERN',
      description:
        'Published evidence that things like this actually sell at the higher figure — sold ' +
        'prices, settled auctions, sell-through rates — and what the platform fees leave ' +
        'behind. An asking price, a listing and an appraisal are none of those, so say plainly ' +
        'where only those exist.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'contact_mode',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'What the published route to the buyer actually is, and specifically whether it ' +
        'requires a telephone call — a portal, an email address, a form, a bid submission or a ' +
        'phone number. Where a call is the only published route, say so; that is a finding ' +
        'rather than a detail.',
      necessity: 'CONDITIONAL',
    },
  ],
  expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION', 'NEGATIVE_EXISTENCE'],
  failureConditions: [
    'No published source names who would actually pay, so the opening cannot be qualified.',
    'Every figure found traces back to one upstream source, so nothing independent supports it.',
    'What is published settles the demand but not whether it can be delivered, and that is ' +
      'recorded as unresolved rather than assumed.',
    'Everything found is a price somebody else charges, an asking price or an appraisal, and ' +
      'nothing published establishes that we could acquire it or that anything sells at the ' +
      'higher figure. That is the honest outcome and it is recorded rather than dressed up.',
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

/**
 * The question that builds the map rather than searching inside it.
 *
 * Its lanes are the thing to notice: not one of them is a demand signal.
 * `MARKET_DISCOVERY` asks where money is moving and this asks how the place is
 * organized, and giving them one set of lanes would make each question fail
 * the other's coverage — which is precisely what happened when one broad
 * discovery bucket was asked for a payer, a price and a delivery path and
 * filed with half of them unresolved.
 *
 * Two lanes are REQUIRED and they are the two that make a map rather than an
 * essay: the subject's own narrower parts, and how work actually reaches a
 * buyer here. Everything else is CONDITIONAL, because a source that settles
 * three of six levels has settled three, and forcing the other three produces
 * invented ones — the symmetry that looks like understanding.
 */
const INDUSTRY_STRUCTURE: CompilerProfile = {
  id: 'INDUSTRY_STRUCTURE',
  fragmentKey: 'industry-structure',
  multipleJurisdictions: 'DESCRIBE',
  /*
   * Ahead of a broad search and behind a deep dive on something already found.
   *
   * The map is what gives every later search a scope, so a subject with
   * nothing underneath it makes ten mechanism questions ask about the whole
   * economy again. It still yields to `COMMERCIAL_VALIDATION`, because
   * finishing what has already been spent outranks knowing more about where
   * to spend next.
   */
  launchOrdinal: 300,
  proposedSources: [
    'an industry classification system such as NAICS, ISIC, SIC or GICS, and its own ' +
      'published definitions',
    'a census, statistical or government publication',
    'a government economic or occupational classification',
    'a trade association, industry body or trade publication',
    'a procurement or supply-chain category listing',
    'an organisation’s own website, press release or announcement',
    'a published price list, rate card or fee schedule',
    'an official registry, filing, permit or licence record',
    'a marketplace, job board, classified or auction listing',
  ],
  excludedSources: [
    'a structure asserted with no source that names it',
    'a level inferred to make a hierarchy symmetrical',
    'a claim with no locatable source at all',
    'a forecast or projection presented as a current fact',
  ],
  lanes: [
    {
      id: 'sub_structure',
      // One classification naming a sub-industry proves that classification
      // names it. Demanding a second publisher for "NAICS 512110 exists"
      // demands something that does not exist.
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'What sits underneath the subject: the narrower industries and the stages of ' +
        'producing and delivering here, as the sources themselves name them. Each one must ' +
        'be declared on its claim with structural_finding set to SUB_INDUSTRY or ' +
        'VALUE_CHAIN_LAYER and structural_subject set to that subject’s own name — a claim ' +
        'that describes a level without declaring it adds nothing to the map.',
      necessity: 'REQUIRED',
    },
    {
      id: 'money_path',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'How work reaches a buyer and money comes back: which kinds of organisation pay ' +
        '(BUYER_TYPE), who actually performs the work (FULFILMENT_SOURCE), and what is ' +
        'bought on what terms (TRANSACTION_TYPE). Declared the same way. This is the lane ' +
        'that makes a map useful rather than decorative: a structure with no payer in it ' +
        'cannot be searched for cash.',
      necessity: 'REQUIRED',
    },
    {
      id: 'constraint',
      description:
        'Where supply is constrained, as a documented shortage, queue, chokepoint or ' +
        'capacity limit (BOTTLENECK) — and anything published that changes the economics ' +
        'and is not obvious from outside (HIDDEN_CONSTRAINT). Not a risk every business ' +
        'has; those are assumed and are not worth a claim.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'adjacency',
      description:
        'A different industry the sources name as connected to this one — a supplier of it, ' +
        'a customer of it, or one that uses the same capability. Declared as ' +
        'ADJACENT_INDUSTRY. This is how the map grows sideways rather than only downwards.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'economics',
      evidenceKind: 'GENERALIZED_ECONOMICS',
      description:
        'What this subject is worth and what work in it is published at, from a price list, ' +
        'a rate card, a statistical publication or a stated figure — kept separate from the ' +
        'structure, because "this layer exists" and "this is what it pays" are two claims ' +
        'with two standards.',
      necessity: 'CONDITIONAL',
    },
  ],
  expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION', 'NEGATIVE_EXISTENCE'],
  failureConditions: [
    'No published source names any structure underneath the subject — only descriptions of ' +
      'the subject as a whole.',
    'The classification systems and the trade sources describe incompatible structures, and ' +
      'that is recorded as unresolved rather than resolved by choosing one.',
    'Structure is found but nothing published says who pays for anything in it.',
  ],
  objective: ({ question, scope, from }) =>
    from === 'ENVELOPE'
      ? `Establish, from published sources, ${lowerFirst(question)} Say which market each ` +
        'finding is about; nothing about this names one of its own.'
      : `Establish, from published sources about ${scope}, ${lowerFirst(question)}`,
  completionCriteria: (scope) => [
    'Every level you establish is declared on its claim with structural_finding and, where ' +
      'the kind names a subject, structural_subject. A level described in prose and not ' +
      'declared is invisible to the map, however well sourced it is.',
    'Every source carries its URL, who publishes it, and the date it was published or last ' +
      'observed.',
    'Every claim carries the URL of the source it came from. A claim submitted without one ' +
      'is rejected, and a fragment whose claims are mostly rejected is blocked outright. If ' +
      'you found the source but could not read it, submit the claim with that URL and its ' +
      'retrieval state, which is recorded as unresolved rather than rejected.',
    'Nothing is added to make the structure tidy. A subject with three published ' +
      'sub-industries has three, and a map that says so is worth more than a symmetrical ' +
      'one that is partly guessed.',
    'Where a classification and a trade source disagree about the structure, both are ' +
      'recorded and the disagreement is named. They are not averaged and one is not ' +
      'silently preferred.',
    'Sources that are really one source are counted once, and the duplication is reported.',
    `Every finding says which market it is about. Where that is not ${scope}, it is reported ` +
      'as being about somewhere else rather than generalized.',
  ],
};

/**
 * Taking a capital requirement apart.
 *
 * The one profile whose completion standard is mostly about what *not* to
 * produce. Every temptation here fails in the same direction — towards a
 * smaller, tidier, more encouraging number — and every one of them is refused
 * by name: no summing past an unknown, no mechanism assumed to apply because
 * it exists, no residual invented for a structure whose source gives none, and
 * no platitude filed as a constraint.
 */
const CAPITAL_STRUCTURE: CompilerProfile = {
  id: 'CAPITAL_STRUCTURE',
  fragmentKey: 'capital-structure',
  multipleJurisdictions: 'DESCRIBE',
  // Beside the deep dive: both are finishing work already paid for on one
  // opening that already exists, and both outrank starting another search.
  launchOrdinal: 120,
  proposedSources: [
    'a trade association, industry body or trade publication',
    'an organisation’s own website, press release or announcement',
    'a published price list, rate card or fee schedule',
    'a supplier, lender or financier’s own published terms',
    'an official registry, filing, permit or licence record',
    'a government or regulator publication stating a capital, bonding or insurance rule',
    'a census, statistical or government publication',
    'a marketplace, job board, classified or auction listing',
    'a tender, procurement notice, RFP, RFQ or public solicitation',
  ],
  excludedSources: [
    'a headline startup-cost figure whose composition is not stated',
    'a financing mechanism asserted generally with no source about this industry',
    'a figure whose upstream source cannot be identified',
    'a forecast or projection presented as a current fact',
  ],
  lanes: [
    {
      id: 'requirement',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'One specific thing this transaction requires owner capital for, declared with ' +
        'structural_finding set to CAPITAL_REQUIREMENT, with what a published source says it ' +
        'costs. Where nothing publishes an amount, submit the requirement with no amount and ' +
        'say what would settle it — the minimum is then withheld rather than understated, ' +
        'which is the correct outcome.',
      necessity: 'REQUIRED',
    },
    {
      id: 'restructuring',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'A practice this industry actually uses that removes, defers or shifts one of those ' +
        'requirements, declared with structural_finding set to CAPITAL_RESTRUCTURING, naming ' +
        'which requirement it answers and what the owner still funds afterwards where the ' +
        'source states it. That a mechanism exists somewhere is not evidence it is used ' +
        'here.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'hidden_constraint',
      description:
        'Something published that changes the economics or the feasibility and is not ' +
        'obvious from outside, declared with structural_finding set to HIDDEN_CONSTRAINT. ' +
        'Not that staff must be paid, that contracts must be lawful or that customers might ' +
        'not buy — those are assumed, and reporting them spends the reader’s attention on ' +
        'what they already know.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'cycle',
      description:
        'What published terms say about when money actually arrives: deposits, milestones, ' +
        'net terms, retention, payment on final acceptance. Recorded as unresolved where ' +
        'nothing published settles it.',
      necessity: 'CONDITIONAL',
    },
  ],
  expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION', 'NEGATIVE_EXISTENCE'],
  failureConditions: [
    'Only a headline startup cost can be found, with nothing published about what it is ' +
      'composed of — which is recorded as the requirements being unestablished, never as ' +
      'the headline being the answer.',
    'Financing mechanisms can be described in general but nothing published shows this ' +
      'industry using any of them.',
    'Requirements are established but no source states an amount for one or more of them, ' +
      'so the minimum owner capital is withheld.',
  ],
  objective: ({ question, scope, from }) =>
    from === 'ENVELOPE'
      ? `Establish, from published sources, ${lowerFirst(question)} Say which market each ` +
        'finding is about; nothing about this names one of its own.'
      : `Establish, from published sources about ${scope}, ${lowerFirst(question)}`,
  completionCriteria: (scope) => [
    'Every requirement is declared on its claim with structural_finding set to ' +
      'CAPITAL_REQUIREMENT, and every restructuring with CAPITAL_RESTRUCTURING naming the ' +
      'requirement it answers. A financing structure described in prose and not declared ' +
      'changes no number.',
    'A figure is read from a source and never produced. Where nothing publishes an amount, ' +
      'the requirement is recorded with no amount. Do not estimate, do not interpolate, and ' +
      'do not treat a blank as nothing to pay.',
    'A mechanism is reported as available only where a source about this industry shows it ' +
      'being used. That a structure exists in general is not evidence about here.',
    'A restructuring states what the owner still funds afterwards, or states that no source ' +
      'says. One with no published residual is available and reduces nothing.',
    'Every source carries its URL, who publishes it, and the date it was published or last ' +
      'observed, and every claim carries the URL of the source it came from.',
    'Constraints reported are ones that change the economics and are not obvious from ' +
      'outside the industry. Obligations every business has are assumed and are not ' +
      'reported.',
    `Every finding says which market it is about. Where that is not ${scope}, it is reported ` +
      'as being about somewhere else rather than generalized.',
  ],
};

/**
 * Who may produce one output, and what obtaining that capability costs.
 *
 * The profile whose most valuable lane is the one that can come back empty.
 * `permission` asks what rule requires a person, and an established *absence*
 * of such a rule is what lets a role be compressed — so the lane's description
 * says so, and the completion standard asks for the search rather than for the
 * conclusion. §14's own standard for a negative, at the question that decides
 * whether somebody is employed.
 */
const LABOR_ALLOCATION: CompilerProfile = {
  id: 'LABOR_ALLOCATION',
  fragmentKey: 'labor-allocation',
  // A rule about who may do this work is jurisdictional, and a question about
  // two jurisdictions is a question about two rules rather than an
  // indecipherable one. Described rather than refused, for the reason market
  // discovery describes: refusing would refuse work the envelope exists to
  // permit.
  multipleJurisdictions: 'DESCRIBE',
  /*
   * Behind the industry map and ahead of a broad search.
   *
   * It is downstream of finding the work — there is nothing to allocate until
   * something is being delivered — and upstream of looking for more, because
   * every opening already found is being produced by somebody today.
   */
  launchOrdinal: 350,
  proposedSources: [
    'a statute, regulation or administrative rule stating who may perform work of this kind',
    'a licensing board, registrar or professional body’s own published requirements',
    'a government occupational classification or labour-statistics publication',
    'a trade association, industry body or trade publication',
    'a buyer’s own published terms, procurement rules or supplier requirements',
    'a platform’s or marketplace’s published terms of service',
    'a published rate card, price list, fee schedule or salary survey',
    'a marketplace, job board, agency or staffing listing stating a published rate',
    'a vendor’s or service’s own published pricing page',
  ],
  excludedSources: [
    'a requirement asserted with no source that states it',
    'a rule quoted without the jurisdiction it applies in',
    'a vendor claim about its own product used as evidence that the product works',
    'a rate with no stated basis, or one inferred from a total',
    'a forecast or projection presented as a current fact',
  ],
  lanes: [
    {
      id: 'permission',
      // One regulator stating a rule proves that regulator states it. Demanding
      // a second publisher for "this board requires a licence" demands
      // something that does not exist.
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'What published rules say about who may produce this: a licence, certification, ' +
        'registration, signature or accountable human review required by a statute, a ' +
        'regulator, a buyer’s own terms or a platform’s terms, and whether any part must be ' +
        'performed in person. Declare each with labor_finding set to HUMAN_REQUIREMENT and ' +
        'labor_subject set to which reason it is. An established absence — you searched the ' +
        'places such a rule would be published and found none — is a finding here and often ' +
        'the most valuable one, so name what you searched.',
      necessity: 'REQUIRED',
    },
    {
      id: 'sourcing',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'Where this capability is actually obtained and what a source says it costs: which ' +
        'channels supply it, in which jurisdictions, at which published rates and on what ' +
        'basis. Declare each with labor_finding set to SOURCING_CHANNEL, labor_subject set to ' +
        'the channel, and labor_rate_cents with labor_qualifier only where a source publishes ' +
        'a figure. A channel with no published rate is still worth recording.',
      necessity: 'REQUIRED',
    },
    {
      id: 'automation',
      description:
        'Whether this work is published anywhere as being done by software rather than by a ' +
        'person, and what those sources say about how the output was checked and what ' +
        'remained for a person. Declared as a SOURCING_CHANNEL of SOFTWARE_TOOL or ' +
        'MANAGED_SERVICE. A vendor’s claim about its own product is conclusive about what the ' +
        'vendor says and is not evidence that it works.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'total_cost',
      evidenceKind: 'GENERALIZED_ECONOMICS',
      description:
        'What published sources say about the things that decide total cost rather than ' +
        'headline rate: supervision burden, turnover, rework and revision rates, timezone and ' +
        'communication overhead, training time, and any regulatory or data-access restriction ' +
        'on who may do this work from where. Kept separate from the rate, because "this ' +
        'channel charges X" and "this is what it actually costs to use" are two claims with ' +
        'two standards.',
      necessity: 'CONDITIONAL',
    },
  ],
  expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION', 'NEGATIVE_EXISTENCE'],
  failureConditions: [
    'No published source states any rule about who may perform this work, and the places such ' +
      'a rule would be published were searched and named — which is recorded as an established ' +
      'absence rather than as a failure.',
    'Rules can be found but every one of them is quoted without the jurisdiction it applies ' +
      'in, so nothing establishes anything about anywhere.',
    'Channels can be described in general but nothing published states a rate for any of them.',
  ],
  objective: ({ question, scope, from }) =>
    from === 'ENVELOPE'
      ? `Establish, from published sources, ${lowerFirst(question)} Say which jurisdiction each ` +
        'requirement is from; nothing about this names one of its own.'
      : `Establish, from published sources about ${scope}, ${lowerFirst(question)}`,
  completionCriteria: (scope) => [
    'Every requirement is declared on its claim with labor_finding set to HUMAN_REQUIREMENT ' +
      'and labor_subject set to which of the six reasons it is, and every channel with ' +
      'SOURCING_CHANNEL naming which channel. A rule described in prose and not declared moves ' +
      'nothing.',
    'Every requirement says which jurisdiction it applies in. A licensing rule quoted without ' +
      'one is not a finding about anywhere.',
    'A rate is read from a source and never produced. Where nothing publishes one, the channel ' +
      'is recorded with no rate and no basis. Do not estimate, do not convert, and do not ' +
      'infer a basis from a total.',
    'An absence is established by a documented search rather than by silence: say which ' +
      'registers, boards, statutes or terms you looked in and what you did not find. Do not ' +
      'conclude that no rule exists because you did not encounter one.',
    'A vendor or platform is conclusive about what it says and is not independent confirmation ' +
      'that what it says is true. Say which it is for every claim resting on one.',
    'Every source carries its URL, who publishes it, and the date it was published or last ' +
      'observed, and every claim carries the URL of the source it came from.',
    `Every finding says which market or jurisdiction it is about. Where that is not ${scope}, ` +
      'it is reported as being about somewhere else rather than generalized.',
    'Nothing here contacts, approaches, quotes for or engages anybody. If answering a question ' +
      'would require doing any of that, it is recorded as unresolved with the reason.',
  ],
};

/**
 * Which classes of machine the sources recognise, and how they relate.
 *
 * The shortest of the three manufacturing profiles, because its job is narrow:
 * it grows the ladder and establishes nothing about whether any rung is worth
 * anything. Both of its lanes are structural for `INDUSTRY_STRUCTURE`'s reason
 * — a claim that describes a class without declaring it is invisible however
 * well sourced it is.
 */
const MACHINE_LADDER: CompilerProfile = {
  id: 'MACHINE_LADDER',
  fragmentKey: 'machine-ladder',
  multipleJurisdictions: 'DESCRIBE',
  /*
   * Behind the two questions that decide anything.
   *
   * A broader ladder with nothing established on it is a longer list of things
   * nobody has looked at, so widening yields to establishing who is buying and
   * to closing a capability gap on a category that already has buyers.
   */
  launchOrdinal: 350,
  proposedSources: [
    'an industry classification system such as NAICS, ISIC, SIC or GICS, and its own ' +
      'published definitions',
    'a trade association or industry body that publishes statistics for this kind of machine',
    'an equipment, vehicle, emissions or airworthiness regulator’s category definitions',
    'a census, statistical or government publication',
    'a trade publication covering producers of this kind of machine',
    'a manufacturer’s own published product range or specification sheet',
    'a standards body’s published scope or classification',
  ],
  excludedSources: [
    'a class of machine asserted with no source that names it',
    'a level inferred to make a hierarchy symmetrical',
    'a claim with no locatable source at all',
    'a forecast or projection presented as a current fact',
  ],
  lanes: [
    {
      id: 'inside',
      // One classification naming a class proves that classification names it.
      // Demanding a second publisher for "this regulator defines this category"
      // demands something that does not exist.
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'The narrower or more specific classes of machine the sources recognise inside the ' +
        'subject, as they themselves name them. Each one declared on its claim with ' +
        'capability_finding set to PRODUCT_CATEGORY and capability_subject set to that ' +
        'class’s own name — a claim that describes a class without declaring it adds nothing ' +
        'to the ladder.',
      necessity: 'REQUIRED',
    },
    {
      id: 'beside',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'Different classes of machine the sources name as connected to this one — built by ' +
        'the same producers, sold or serviced through the same channel, or sharing major ' +
        'components. Declared as ADJACENT_CATEGORY. This is how the ladder grows sideways ' +
        'rather than only downwards, which is what lets a capability built in one place be ' +
        'used in another.',
      necessity: 'CONDITIONAL',
    },
  ],
  expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION', 'NEGATIVE_EXISTENCE'],
  failureConditions: [
    'No published source recognises any narrower class inside the subject — only descriptions ' +
      'of the subject as a whole.',
    'The classification systems and the trade sources divide this kind of machine ' +
      'incompatibly, and that is recorded as unresolved rather than resolved by choosing one.',
  ],
  objective: ({ question, scope, from }) =>
    from === 'ENVELOPE'
      ? `Establish, from published sources, ${lowerFirst(question)} Say which market each ` +
        'finding is about; nothing about this names one of its own.'
      : `Establish, from published sources about ${scope}, ${lowerFirst(question)}`,
  completionCriteria: (scope) => [
    'Every class you establish is declared on its claim with capability_finding and ' +
      'capability_subject. A class described in prose and not declared is invisible to the ' +
      'ladder, however well sourced it is.',
    'Every source carries its URL, who publishes it, and the date it was published or last ' +
      'observed.',
    'Every claim carries the URL of the source it came from. A claim submitted without one ' +
      'is rejected, and a fragment whose claims are mostly rejected is blocked outright. If ' +
      'you found the source but could not read it, submit the claim with that URL and its ' +
      'retrieval state, which is recorded as unresolved rather than rejected.',
    'Nothing is added to make the ladder tidy. A class with three published sub-classes has ' +
      'three, and a ladder that says so is worth more than a symmetrical one that is partly ' +
      'guessed.',
    'Where a classification and a trade source disagree about the division, both are recorded ' +
      'and the disagreement is named. They are not averaged and one is not silently preferred.',
    `Every finding says which market it is about. Where that is not ${scope}, it is reported ` +
      'as being about somewhere else rather than generalized.',
  ],
};

/**
 * Who is buying, how product reaches them, and where incumbents fall short.
 *
 * The profile the whole kernel is ordered around, and the only one with two
 * REQUIRED lanes that are both about the *market* rather than about the
 * machine. That is the brief's core principle as a completion standard:
 * demand and a route to the buyer together are what pull manufacturing
 * forward, and a category with buyers and no route is as unenterable as one
 * with neither.
 *
 * Its failure conditions are the half that matters. *Nothing published
 * establishes that anybody is buying* has to be a returnable answer rather
 * than an incomplete one, because it is the finding that stops a category
 * being entered — and a profile that treated it as a gap would push a worker
 * towards producing an estimate instead.
 */
const MACHINE_DEMAND: CompilerProfile = {
  id: 'MACHINE_DEMAND',
  fragmentKey: 'machine-demand',
  multipleJurisdictions: 'DESCRIBE',
  // First among the manufacturing questions, deliberately. Establishing what a
  // machine takes to build, for a machine nobody has shown anybody is buying,
  // is the inversion the brief exists to forbid — and the expensive one.
  launchOrdinal: 200,
  proposedSources: [
    'a trade association or industry body that publishes shipment, registration or sales ' +
      'statistics',
    'a government registration, licensing or vehicle-registration dataset',
    'a census, statistical or government publication',
    'a public tender, contract award or procurement notice',
    'a fleet operator’s or public body’s published purchase or budget document',
    'a regulator’s recall, safety-action or defect database',
    'a manufacturer’s or dealer’s published price list, rate card or specification sheet',
    'a trade publication covering producers or buyers of this kind of machine',
    'a marketplace, auction or classified listing showing prices actually asked or realised',
  ],
  excludedSources: [
    'a market-size estimate presented as evidence that somebody bought something',
    'a forecast or projection presented as a current fact',
    'an assertion that a market is large, growing or underserved with no observation behind it',
    'an observation with no date the source states',
    'a claim with no locatable source at all',
  ],
  lanes: [
    {
      id: 'buying',
      // One published shipment figure proves that publisher observed it.
      // Demanding a second publisher for "this trade body reported 42,000
      // units" demands something that does not exist.
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'Published observations that somebody is actually buying machines of this kind: unit ' +
        'shipments, registrations, fleet purchases, tenders and contract awards, replacement ' +
        'cycles, prices actually realised, order backlogs and lead times, installed base. ' +
        'Each declared with capability_finding set to DEMAND_EVIDENCE, capability_subject set ' +
        'to the kind of observation it is, and capability_observed_on set to the date the ' +
        'source observed it. An undated observation is not recorded as a demand signal.',
      necessity: 'REQUIRED',
    },
    {
      id: 'route',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'How product of this kind actually reaches whoever pays for it — dealer networks, ' +
        'distributors, direct sale, fleet and contract sale, retail, marketplaces, rental ' +
        'fleets, OEM supply, aftermarket and parts, service networks. Declared as ' +
        'DISTRIBUTION_CHANNEL. This is the lane that makes demand actionable rather than ' +
        'interesting: buyers with no established route to them cannot be sold to.',
      necessity: 'REQUIRED',
    },
    {
      id: 'shortfall',
      description:
        'Where what is on the market today is documented to fall short: recalls and safety ' +
        'actions, failure modes, service coverage gaps, parts availability, lead times, price ' +
        'gaps, unmet requirements buyers have stated. Declared as INCUMBENT_WEAKNESS. Not an ' +
        'opinion that existing products are poor — a documented shortfall with a source.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'economics',
      evidenceKind: 'GENERALIZED_ECONOMICS',
      description:
        'What machines of this kind sell for and what the market is worth, from a price list, ' +
        'a statistical publication or a stated figure — kept separate from the observations, ' +
        'because "somebody bought one" and "the market is worth this" are two claims with two ' +
        'standards, and only the first is evidence that anybody is buying.',
      necessity: 'CONDITIONAL',
    },
  ],
  expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION', 'NEGATIVE_EXISTENCE'],
  failureConditions: [
    'No published source establishes that anybody is buying machines of this kind. This is a ' +
      'complete answer rather than a gap: it is what stops this category being pursued, and ' +
      'an estimate produced in its place would defeat the purpose of asking.',
    'Buyers are established and nothing published establishes how product reaches them.',
    'Every observation found is undated, so none of them can be told apart from an old one.',
  ],
  objective: ({ question, scope, from }) =>
    from === 'ENVELOPE'
      ? `Establish, from published sources, ${lowerFirst(question)} Say which market each ` +
        'finding is about; nothing about this names one of its own.'
      : `Establish, from published sources about ${scope}, ${lowerFirst(question)}`,
  completionCriteria: (scope) => [
    'Every demand observation carries the date the source observed it. One without a date is ' +
      'reported as undated rather than recorded as a demand signal — an undated buying signal ' +
      'cannot be told apart from one somebody remembers from years ago.',
    'A market-size estimate, a growth rate and a forecast are reported as what they are and ' +
      'never as evidence that somebody bought something.',
    'Every source carries its URL, who publishes it, and the date it was published or last ' +
      'observed, and every claim carries the URL of the source it came from.',
    'Where nothing published establishes that anybody is buying, that is stated plainly, with ' +
      'what was searched. It is the answer this question most needs to be able to return.',
    'Sources that are really one source are counted once, and the duplication is reported — ' +
      'a manufacturer’s release carried by three trade outlets is one observation.',
    `Every finding says which market it is about. Where that is not ${scope}, it is reported ` +
      'as being about somewhere else rather than generalized.',
  ],
};

/**
 * What producing takes, what it develops, and what is bought in.
 *
 * The one profile whose completion standard is mostly about what *not* to
 * produce, and every temptation here fails in the same direction — towards a
 * complete-looking list of what a machine "must obviously" need. A guessed
 * requirement is worse than a missing one twice over: it makes a category look
 * harder than it is, and it puts a capability in the ledger that no source
 * names, which then appears as a gap nothing on the ladder can close.
 *
 * It also states, in its own completion criteria, that the research is about
 * the industry rather than about the organisation commissioning it. Brain
 * refuses a claim about the latter either way, because no capability_finding
 * can mark a capability held — but a worker who understands the question writes
 * better claims than one whose answers are silently discarded.
 */
const MACHINE_CAPABILITY: CompilerProfile = {
  id: 'MACHINE_CAPABILITY',
  fragmentKey: 'machine-capability',
  multipleJurisdictions: 'DESCRIBE',
  // Behind demand and ahead of widening the ladder: it is the question that
  // closes the gap on a category already established to have buyers.
  launchOrdinal: 250,
  proposedSources: [
    'a regulator’s published approval, certification, homologation or emissions requirement',
    'a standards body’s published specification or qualification requirement',
    'a trade association or industry body’s published technical or training material',
    'a manufacturer’s own published account of how it produces, tests or services',
    'a supplier’s published component or subsystem specification',
    'a trade publication covering production, tooling or supply in this industry',
    'a government occupational or skills classification',
    'a published teardown, technical analysis or engineering paper',
  ],
  excludedSources: [
    'a capability asserted because it seems obviously necessary, with no source naming it',
    'a requirement inferred to make a list look complete',
    'a producer’s marketing claim about its own capability treated as independent confirmation',
    'a claim with no locatable source at all',
    'any statement about what the organisation commissioning this research can do',
  ],
  lanes: [
    {
      id: 'requires',
      // A regulator's own published requirement is conclusive about what it
      // requires. Demanding a second publisher for it demands something that
      // does not exist.
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'The engineering, manufacturing, supply, testing, distribution and servicing ' +
        'capabilities a producer of this kind of machine must have, as published sources name ' +
        'them. Each declared with capability_finding set to CAPABILITY_REQUIRED and ' +
        'capability_subject set to the capability, named as shortly as it can be while still ' +
        'being the same capability wherever it appears.',
      necessity: 'REQUIRED',
    },
    {
      id: 'develops',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'What producing at this level builds up that a producer did not have before. Declared ' +
        'as CAPABILITY_TAUGHT. This is the lane that makes one class of machine a route to ' +
        'another rather than an isolated product, so a capability named here should use the ' +
        'same words as the same capability named anywhere else.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'barrier',
      description:
        'What must be certified, approved, homologated, tooled, qualified or reached in scale ' +
        'before anybody may produce at all. Declared as ENTRY_BARRIER. Kept separate from a ' +
        'capability because a certification nobody can buy their way past is not a skill to ' +
        'be acquired, and filing it as one would make an unreachable category look merely ' +
        'expensive.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'bought_in',
      description:
        'Which components and subsystems producers of this kind of machine buy in rather than ' +
        'make, and who supplies them. Declared as BOUGHT_IN_COMPONENT. Establish what is ' +
        'bought in; do not recommend making any of it in-house, which is a decision this ' +
        'research does not make.',
      necessity: 'CONDITIONAL',
    },
  ],
  expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION', 'NEGATIVE_EXISTENCE'],
  failureConditions: [
    'No published source names what producing this kind of machine requires — only ' +
      'descriptions of the machine itself.',
    'The only available accounts of what production requires are producers’ own marketing ' +
      'material, which is conclusive about what it says and is not independent confirmation.',
    'What must be approved before producing differs by market and no source settles which ' +
      'applies here; that is recorded as unresolved rather than resolved by choosing one.',
  ],
  objective: ({ question, scope, from }) =>
    from === 'ENVELOPE'
      ? `Establish, from published sources, ${lowerFirst(question)} Say which market each ` +
        'finding is about; nothing about this names one of its own.'
      : `Establish, from published sources about ${scope}, ${lowerFirst(question)}`,
  completionCriteria: (scope) => [
    'Every capability, barrier and bought-in component you establish is declared on its claim. ' +
      'One described in prose and not declared is invisible to the ladder, however well ' +
      'sourced it is.',
    'Nothing is added to make the list look complete. A class of machine with four published ' +
      'requirements has four, and saying so is worth more than a symmetrical list that is ' +
      'partly guessed — a guessed requirement becomes a gap nothing can close.',
    'A capability is named the same way wherever it appears, so that two classes of machine ' +
      'needing the same thing say the same words. A synonym becomes a second capability and ' +
      'splits the evidence between them.',
    'A producer’s own account of its production is reported as what that producer says, and ' +
      'never as independent confirmation that production requires it.',
    'Every source carries its URL, who publishes it, and the date it was published or last ' +
      'observed, and every claim carries the URL of the source it came from.',
    'Nothing is reported about what the organisation commissioning this research can already ' +
      'do. That is recorded separately, from a person, and no claim here can establish it.',
    `Every finding says which market it is about. Where that is not ${scope}, it is reported ` +
      'as being about somewhere else rather than generalized.',
  ],
};


/* ---------------------------------------------------------------------------
 * The puzzle kernel's three profiles.
 *
 * Three rather than one because their completion standards genuinely differ,
 * and the rights one differs most: an *established absence* is the result it
 * usually exists to produce, so a profile that treated "nothing found" as a
 * failure would refuse exactly the finding that lets a generator be built.
 * ------------------------------------------------------------------------ */

const PUZZLE_MARKET: CompilerProfile = {
  id: 'PUZZLE_MARKET',
  fragmentKey: 'puzzle-market',
  // A puzzle sells in whatever market publishes it, and a question about two
  // is one question about a product with two markets rather than an
  // indecipherable one. Described rather than refused, for market discovery's
  // reason: refusing would refuse the breadth the brief asks for.
  multipleJurisdictions: 'DESCRIBE',
  /*
   * Behind the industry map and ahead of a broad search, beside labor.
   *
   * It is downstream of knowing the operation makes puzzles at all and
   * upstream of looking for more openings, because a format Brain can already
   * produce is work whose cost is already sunk.
   */
  launchOrdinal: 360,
  proposedSources: [
    'a publication’s own submissions, contributor or freelancer page stating what it pays',
    'a syndicate’s or feature service’s published terms',
    'a retailer’s or marketplace’s product listing with a stated price',
    'a publisher’s catalogue, rights page or trade listing',
    'a platform’s published revenue share, payout or royalty terms',
    'a distributor’s or wholesaler’s published discount schedule',
    'an institution’s procurement notice, tender or purchasing catalogue',
    'a trade association or trade publication covering puzzles, games or publishing',
    'a published rate card, price list or fee schedule',
  ],
  excludedSources: [
    'a market-size estimate used as evidence that a buyer exists',
    'a price quoted with no statement of what it is a price for',
    'a bestseller rank or review count presented as revenue',
    'a vendor claim about its own product used as evidence the product sells',
    'a forecast or projection presented as a current fact',
  ],
  lanes: [
    {
      id: 'buyer',
      // One publication's own submissions page proves that publication buys.
      // Demanding a second publisher for "this magazine states it pays $X"
      // demands something that does not exist.
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'A specific named buyer for work of this kind, established by a source that names ' +
        'them: a publication with an open submissions page, a syndicate, a retailer stocking ' +
        'a named product, an institution’s procurement notice, a platform. Declare each with ' +
        'puzzle_finding set to BUYER_DEMAND and puzzle_subject set to which class of buyer. A ' +
        'market-size figure is not a buyer.',
      necessity: 'REQUIRED',
    },
    {
      id: 'price',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'What a source publishes as the price or the rate, with what it is quoted on. Declare ' +
        'each with puzzle_finding set to PRICE_POINT, puzzle_subject set to the product class ' +
        'it prices, puzzle_price_cents in minor units and puzzle_qualifier set to the basis. A ' +
        'figure is read from a source and never produced, converted or averaged.',
      necessity: 'REQUIRED',
    },
    {
      id: 'route',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'A published route by which work of this kind reaches a buyer, and what the route ' +
        'takes: platform or retailer share, distributor discount, returns, payment timing, ' +
        'exclusivity, rights required, and any eligibility rule about who may list at all. ' +
        'Declare each with puzzle_finding set to DISTRIBUTION_CHANNEL. A route with no ' +
        'published price is still a real finding — record it without a figure.',
      necessity: 'REQUIRED',
    },
    {
      id: 'format',
      description:
        'A kind of puzzle, mechanic or puzzle product the sources name, including obscure, ' +
        'regional, non-English and audience-specific ones. Declare each with puzzle_finding ' +
        'set to PUZZLE_FORMAT and puzzle_subject set to that format’s own short name as its ' +
        'sources give it. Breadth and specificity are what is wanted here; a confirmation ' +
        'that crosswords exist is worth nothing.',
      necessity: 'CONDITIONAL',
    },
  ],
  expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION', 'NEGATIVE_EXISTENCE'],
  failureConditions: [
    'No published source names any buyer for work of this kind, and the places such a buyer ' +
      'would be published were searched and named — which is recorded as an established ' +
      'absence rather than as a failure.',
    'Buyers can be found but nothing published states what any of them pays, so every price ' +
      'would have to be estimated.',
    'Every figure found is quoted with no statement of what it is a price for, so none of them ' +
      'compares to anything.',
  ],
  objective: ({ question, scope, from }) =>
    from === 'ENVELOPE'
      ? `Establish, from published sources, ${lowerFirst(question)} Say which market each ` +
        'finding is about; nothing about this names one of its own.'
      : `Establish, from published sources about ${scope}, ${lowerFirst(question)}`,
  completionCriteria: (scope) => [
    'Every buyer is declared on its claim with puzzle_finding set to BUYER_DEMAND and ' +
      'puzzle_subject naming which class, every route with DISTRIBUTION_CHANNEL, and every ' +
      'figure with PRICE_POINT carrying its basis. A buyer described in prose and not declared ' +
      'moves nothing.',
    'A price is read from a source and never produced. Where nothing publishes one, the route ' +
      'is recorded with no price and no basis. Do not estimate, do not convert a currency, and ' +
      'do not infer a basis from a total.',
    'Every price says what it is a price for. A per-book figure recorded as a per-puzzle one ' +
      'is wrong by two orders of magnitude and nothing downstream could catch it.',
    'A named buyer is a source naming them. A market-size estimate, a category growth rate and ' +
      'a bestseller rank are none of them a buyer, and are reported as what they are.',
    'A publisher or platform is conclusive about its own stated terms and is not independent ' +
      'confirmation of anybody else’s. Say which it is for every claim resting on one.',
    'Every source carries its URL, who publishes it, and the date it was published or last ' +
      'observed, and every claim carries the URL of the source it came from.',
    `Every finding says which market it is about. Where that is not ${scope}, it is reported as ` +
      'being about somewhere else rather than generalized.',
    'Nothing here submits work, opens an account, contacts a buyer, lists anything for sale or ' +
      'commits to an order. If answering a question would require any of that, it is recorded ' +
      'as unresolved with the reason.',
  ],
};

const PUZZLE_RIGHTS: CompilerProfile = {
  id: 'PUZZLE_RIGHTS',
  fragmentKey: 'puzzle-rights',
  // A rights rule is jurisdictional, and a question about two jurisdictions is
  // a question about two rules rather than an indecipherable one.
  multipleJurisdictions: 'DESCRIBE',
  /*
   * Ahead of the market question, deliberately.
   *
   * A format whose corpus nobody may use cannot be sold however well it sells
   * for other people, and the rights answer is what decides whether a
   * generator is worth building at all. It is the cheapest question that can
   * stop the most expensive work.
   */
  launchOrdinal: 355,
  proposedSources: [
    'a trademark or copyright register’s own record',
    'a rights holder’s own published terms, licence or permissions page',
    'the licence a word list, lexicon, clue bank or database is released under',
    'a font or artwork licence as published by its author or foundry',
    'a platform’s or marketplace’s published content and intellectual-property policy',
    'a statute, regulation or regulator’s guidance on compilations or databases',
    'a product safety, age-grading or labelling standard as published by its body',
    'a court decision or official summary of one',
    'a trade association or industry body’s published guidance',
  ],
  excludedSources: [
    'an assertion that something is public domain with no source establishing it',
    'a forum post or blog summarising the law in place of the rule itself',
    'a rule quoted without the jurisdiction it applies in',
    'an absence of a rule inferred from not having encountered one',
    'a licence summary used in place of the licence it summarises',
  ],
  lanes: [
    {
      id: 'constraint',
      // One register or one rights holder's own terms is conclusive about what
      // it states. A second publisher restating it adds nothing.
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'A published constraint on producing or selling work of this kind: copyright in ' +
        'individual puzzles or in compilations, a trademarked name, a licensed mechanic, ' +
        'rights in a lexicon or database, a font or artwork licence, platform terms, or a ' +
        'safety or labelling rule. Declare each with puzzle_finding set to RIGHTS_CONSTRAINT ' +
        'and puzzle_subject set to which kind, and say which jurisdiction it applies in.',
      necessity: 'REQUIRED',
    },
    {
      id: 'absence',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'An established absence: you searched the places a constraint would be published — a ' +
        'register, the rights holder’s own terms, the licence a corpus is released under, a ' +
        'platform’s policy — and found none. Declare it as RIGHTS_CONSTRAINT with ' +
        'puzzle_subject set to NO_CONSTRAINT_FOUND and name exactly what you searched. This ' +
        'is the most valuable result this question returns and the easiest to get wrong: an ' +
        'undocumented silence is not an established absence, and something will be built on ' +
        'whichever one you record.',
      necessity: 'REQUIRED',
    },
    {
      id: 'corpus',
      description:
        'What a usable corpus for this format would actually be, and on what terms: which ' +
        'word lists, lexicons, clue banks, quotation collections or artwork sets exist, who ' +
        'publishes each, and what licence each is released under including whether commercial ' +
        'use is permitted. Kept separate from the constraint lane because "this is encumbered" ' +
        'and "here is one that is not" are two different findings.',
      necessity: 'CONDITIONAL',
    },
  ],
  expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION', 'NEGATIVE_EXISTENCE'],
  failureConditions: [
    'No published source states any constraint, and the registers, terms and licences where ' +
      'one would be published were searched and named — which is an established absence and is ' +
      'the successful outcome of this question rather than a failure.',
    'Constraints can be found but every one is quoted without the jurisdiction it applies in, ' +
      'so nothing establishes anything about anywhere.',
    'Every corpus that would serve this format is published under terms that do not state ' +
      'whether commercial use is permitted, so nothing can be built on any of them yet.',
  ],
  objective: ({ question, scope, from }) =>
    from === 'ENVELOPE'
      ? `Establish, from published sources, ${lowerFirst(question)} Say which jurisdiction each ` +
        'constraint is from; nothing about this names one of its own.'
      : `Establish, from published sources about ${scope}, ${lowerFirst(question)}`,
  completionCriteria: (scope) => [
    'Every constraint is declared on its claim with puzzle_finding set to RIGHTS_CONSTRAINT ' +
      'and puzzle_subject naming which kind. A constraint described in prose and not declared ' +
      'moves nothing.',
    'An absence is established by a documented search rather than by silence: say which ' +
      'registers, terms, licences and policies you looked in and what you did not find. Do not ' +
      'conclude that something is unencumbered because you did not encounter a rule saying so.',
    'Every constraint says which jurisdiction it applies in. A rule quoted without one is not ' +
      'a finding about anywhere.',
    'A licence is read as published rather than as summarised. Where a summary and the licence ' +
      'itself disagree, the licence is the finding and the disagreement is reported.',
    'A register or a rights holder’s own terms is conclusive about what it states. A forum ' +
      'post asserting something is free to use is not, and is reported as what it is.',
    'Every source carries its URL, who publishes it, and the date it was published or last ' +
      'observed, and every claim carries the URL of the source it came from.',
    `Every finding says which jurisdiction it is about. Where that is not ${scope}, it is ` +
      'reported as being about somewhere else rather than generalized.',
    'Nothing here applies for, claims or accepts any right, contacts any rights holder, or ' +
      'downloads any corpus. Nothing here is legal advice: it is sourced statements a person ' +
      'decides what to do about.',
  ],
};

const PUZZLE_PRODUCTION: CompilerProfile = {
  id: 'PUZZLE_PRODUCTION',
  fragmentKey: 'puzzle-production',
  multipleJurisdictions: 'DESCRIBE',
  /*
   * Last of the three, and after the market question.
   *
   * What a print run costs is the POSITION LATER question: asking it before
   * anything is established about who buys the thing is costing a run for a
   * book nobody has shown anybody wants.
   */
  launchOrdinal: 370,
  proposedSources: [
    'a printer’s, converter’s or manufacturer’s own published price list or quote calculator',
    'a print-on-demand service’s published per-unit and setup pricing',
    'a trade printer’s published minimum order quantities and volume breaks',
    'an equipment manufacturer’s published specification, throughput or price',
    'a used-equipment dealer’s or auction’s listing with a stated price',
    'a materials supplier’s published price list',
    'a freight or fulfilment provider’s published rate card',
    'a trade association or trade publication on print or game manufacturing',
    'a published industry survey of spoilage, defect, return or utilisation rates',
  ],
  excludedSources: [
    'a cost at one volume presented as the cost at another',
    'an advertised machine speed presented as what a staffed run produces',
    'a quote from one supplier presented as evidence about anybody else’s costs',
    'a total with no statement of what it includes',
    'a payback or return figure produced rather than published',
  ],
  lanes: [
    {
      id: 'method',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'How work of this kind is actually produced, as a published source describes it. ' +
        'Declare each with puzzle_finding set to PRODUCTION_METHOD and puzzle_subject set to ' +
        'which method. A book, a card deck, a jigsaw and a boxed mechanical puzzle are ' +
        'different production classes and a finding about one is not a finding about another.',
      necessity: 'REQUIRED',
    },
    {
      id: 'cost',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'What a published source says a step costs, at a stated volume: per-unit and setup ' +
        'cost, minimum order quantity, tooling, prepress and proofing, materials, freight and ' +
        'storage. Declare each as a PRICE_POINT with its basis. A figure at one volume says ' +
        'nothing about another unless the source gives both.',
      necessity: 'REQUIRED',
    },
    {
      id: 'ownership',
      evidenceKind: 'GENERALIZED_ECONOMICS',
      description:
        'What published sources say decides whether owning equipment beats outsourcing: ' +
        'throughput at the slowest step, changeover time, staffed productive utilisation ' +
        'rather than advertised machine speed, labour, maintenance and consumables, floor ' +
        'space, and resale value. Kept separate from the cost lane because "this run costs X" ' +
        'and "owning the machine that does it is worth it" are two claims with two standards.',
      necessity: 'CONDITIONAL',
    },
  ],
  expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION', 'CALCULATION', 'NEGATIVE_EXISTENCE'],
  failureConditions: [
    'No published source states any cost for producing work of this kind, and the printers, ' +
      'services and suppliers where such a figure would be published were searched and named.',
    'Costs are published only as "request a quote", so every figure would have to be obtained ' +
      'by contacting somebody — which this envelope does not permit, and which is recorded as ' +
      'unresolved rather than estimated around.',
    'Figures exist at one volume only, so nothing establishes what the same work costs at the ' +
      'quantity that would actually be produced.',
  ],
  objective: ({ question, scope, from }) =>
    from === 'ENVELOPE'
      ? `Establish, from published sources, ${lowerFirst(question)} Say which market each ` +
        'figure is from; nothing about this names one of its own.'
      : `Establish, from published sources about ${scope}, ${lowerFirst(question)}`,
  completionCriteria: (scope) => [
    'Every method is declared on its claim with puzzle_finding set to PRODUCTION_METHOD and ' +
      'puzzle_subject naming which one, and every published figure as a PRICE_POINT with its ' +
      'basis. A method described in prose and not declared moves nothing.',
    'Every figure says what quantity it is for. A per-unit cost with no volume beside it is ' +
      'not comparable to anything, and is reported as incomplete rather than used.',
    'A cost is read from a source and never produced. Where a supplier publishes only "request ' +
      'a quote", that is recorded as unresolved — this research contacts nobody.',
    'An advertised machine speed is what the manufacturer says it does. Where a source gives ' +
      'staffed or effective utilisation, both are reported and which is which is said.',
    'A printer or manufacturer is conclusive about what it charges and worth nothing as ' +
      'evidence about anybody else’s costs. Say which it is for every claim resting on one.',
    'Every source carries its URL, who publishes it, and the date it was published or last ' +
      'observed, and every claim carries the URL of the source it came from.',
    `Every finding says which market it is about. Where that is not ${scope}, it is reported as ` +
      'being about somewhere else rather than generalized.',
    'Nothing here requests a quote, contacts a supplier, places or reserves an order, or buys ' +
      'or leases equipment. If answering a question would require any of that, it is recorded ' +
      'as unresolved with the reason.',
  ],
};

const BY_ENVELOPE: Readonly<Record<string, CompilerProfile>> = Object.freeze({
  RUSSELL_PUBLIC_RECORDS_V1: PUBLIC_RECORDS,
  RUSSELL_STATE_LICENSING_V1: PUBLIC_RECORDS,
  STEP10_MICHIGAN_LICENSING_V1: PUBLIC_RECORDS,
  STEP11_AUDIT_INDEPENDENCE_V1: PUBLIC_RECORDS,
  RUSSELL_CASH_DISCOVERY_V1: MARKET_DISCOVERY,
  RUSSELL_CASH_VALIDATION_V1: COMMERCIAL_VALIDATION,
  RUSSELL_INDUSTRY_MAP_V1: INDUSTRY_STRUCTURE,
  RUSSELL_CAPITAL_STRUCTURE_V1: CAPITAL_STRUCTURE,
  RUSSELL_LABOR_ALLOCATION_V1: LABOR_ALLOCATION,
  RUSSELL_MACHINE_LADDER_V1: MACHINE_LADDER,
  RUSSELL_MACHINE_DEMAND_V1: MACHINE_DEMAND,
  RUSSELL_MACHINE_CAPABILITY_V1: MACHINE_CAPABILITY,
  RUSSELL_PUZZLE_MARKET_V1: PUZZLE_MARKET,
  RUSSELL_PUZZLE_RIGHTS_V1: PUZZLE_RIGHTS,
  RUSSELL_PUZZLE_PRODUCTION_V1: PUZZLE_PRODUCTION,
});

export function profileFor(envelopeId: string): CompilerProfile | null {
  return Object.prototype.hasOwnProperty.call(BY_ENVELOPE, envelopeId)
    ? (BY_ENVELOPE[envelopeId] as CompilerProfile)
    : null;
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

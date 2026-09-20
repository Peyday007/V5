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
  | 'DEALFLOW_PARTIES'
  | 'DEALFLOW_TERMS';

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
 * Who is on each side of a cross-border equipment transaction.
 *
 * The completion standard here is unusual and the profile exists to say so: a
 * named organisation with a published trigger is the whole deliverable, and a
 * well-reasoned description of *the kind of company that would want this*
 * answers nothing at all. This trade is full of plausible buyers who do not
 * exist, so `failureConditions` names finding none as a real and reportable
 * outcome rather than a failure to try harder.
 */
const DEALFLOW_PARTIES: CompilerProfile = {
  id: 'DEALFLOW_PARTIES',
  fragmentKey: 'dealflow-parties',
  // A cross-border market genuinely spans jurisdictions — a supplier in one
  // country and buyers in four — so refusing a question that names several
  // would refuse the work this envelope exists to permit.
  multipleJurisdictions: 'DESCRIBE',
  // Beside the industry map: both give later questions somewhere to point, and
  // both yield to anything finishing a deal that already exists.
  launchOrdinal: 310,
  proposedSources: [
    'an organisation’s own website, press release or announcement',
    'a procurement or tender notice, or a government contract award',
    'a trade association, industry body or trade publication',
    'an official registry, filing, permit or licence record',
    'a marketplace, job board, classified or auction listing',
    'a census, statistical or government publication',
    'a published price list, rate card or fee schedule',
    'a manufacturer’s published catalogue, specification or export record',
  ],
  excludedSources: [
    'an organisation named as a likely buyer with nothing published showing the need',
    'a manufacturer inferred from a directory listing that does not say what it builds',
    'a trigger inferred from an industry trend rather than from this organisation',
    'a forecast or projection presented as a current need',
  ],
  lanes: [
    {
      id: 'buyer_need',
      // One published tender proves one published tender. Requiring a second
      // publisher for "this mine advertised for tankers" requires somebody
      // else to have advertised the same thing.
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'A named organisation with something published showing it needs this class of ' +
        'equipment — an expansion, a commissioning, an awarded contract, an ageing fleet, a ' +
        'regulatory change forcing replacement, a tender or a procurement notice. Declared ' +
        'on its claim with deal_finding set to BUYER_NEED, deal_subject set to the ' +
        'organisation’s own name, deal_equipment set to the class, and deal_jurisdiction set ' +
        'to its country. An organisation described and not declared reaches nothing.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'supplier_capability',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'A named manufacturer publishing the capability to build this class for export: the ' +
        'models, the certifications it publishes, the export markets it says it serves, its ' +
        'stated minimum order and lead time. Declared with deal_finding set to ' +
        'SUPPLIER_CAPABILITY and the same three fields.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'decision_path',
      description:
        'How a purchase of this size is actually decided at the organisation: the ' +
        'procurement function, published vendor qualification requirements, whether it goes ' +
        'through tender, and any individual the organisation itself publishes in that role. ' +
        'Declared with deal_finding set to DECISION_MAKER and deal_subject set to the ' +
        'organisation’s name, with no deal_equipment. Never a name inferred from a job ' +
        'title held somewhere else.',
      necessity: 'CONDITIONAL',
    },
  ],
  expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION', 'NEGATIVE_EXISTENCE'],
  failureConditions: [
    'The class of equipment can be described but no organisation has published a need for ' +
      'it, which is recorded as no buyer established rather than as a likely buyer.',
    'Manufacturers can be found but nothing they publish says they export, which is ' +
      'recorded rather than assumed away.',
    'Organisations are named in directories with nothing published about what they need or ' +
      'build, so nothing is declared.',
  ],
  objective: ({ question, scope, from }) =>
    from === 'ENVELOPE'
      ? `Establish, from published sources, ${lowerFirst(question)} Say which country each ` +
        'organisation is in; nothing about this names one of its own.'
      : `Establish, from published sources about ${scope}, ${lowerFirst(question)}`,
  completionCriteria: (scope) => [
    'Every organisation is declared on its claim with deal_finding, deal_subject set to its ' +
      'own name, deal_equipment set to the class of equipment, and deal_jurisdiction set to ' +
      'its country. One described in prose and not declared changes nothing.',
    'Where the question names a class of equipment, that exact string is copied into ' +
      'deal_equipment. A different wording is a different class and pairs with nothing.',
    'A buyer rests on something published showing the need, not on the organisation being ' +
      'the kind that would have one. A plausible buyer is not a finding, and reporting that ' +
      'none was established is a better answer than naming one.',
    'Every source carries its URL, who publishes it, and the date it was published or last ' +
      'observed, and every claim carries the URL of the source it came from.',
    `Every finding says which country it is about. Where that is not ${scope}, it is ` +
      'reported as being about somewhere else rather than generalized.',
  ],
};

/**
 * What the transaction would actually involve.
 *
 * The one profile in this repository whose most valuable answer is a
 * *documented absence*. A compliance layer nobody has looked at and a layer
 * somebody searched properly and found empty are opposite facts with opposite
 * consequences, and the absence of claims says only the first — so
 * `REQUIREMENT_ABSENCE` has its own lane, and the completion criteria say in
 * as many words that an unreported empty search leaves the question open.
 */
const DEALFLOW_TERMS: CompilerProfile = {
  id: 'DEALFLOW_TERMS',
  fragmentKey: 'dealflow-terms',
  multipleJurisdictions: 'DESCRIBE',
  // Beside the deep dive and the capital question: all three are finishing
  // work already paid for on something that already exists, and all three
  // outrank starting another search.
  launchOrdinal: 130,
  proposedSources: [
    'a government regulation, statutory instrument or official standard',
    'a customs tariff schedule or published duty rate',
    'a transport, vehicle or roadworthiness authority’s own published rules',
    'a standards body’s published specification',
    'a freight, shipping or logistics operator’s published rate or tariff',
    'an inspection, certification or testing body’s published requirements or fees',
    'a trade association, industry body or trade publication',
    'an organisation’s own website, press release or announcement',
    'a published price list, rate card or fee schedule',
  ],
  excludedSources: [
    'a requirement in one market presented as applying in another',
    'a rule inferred from a neighbouring country or a regional bloc without a source ' +
      'saying this market adopts it',
    'a figure estimated, interpolated or converted between currencies',
    'a rate produced by turning a published range into a single number',
    'an absence asserted with no account of where it was searched for',
  ],
  lanes: [
    {
      id: 'compliance_layer',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'One thing the destination market or the buyer demands of these goods, declared with ' +
        'deal_finding set to COMPLIANCE_REQUIREMENT, deal_value set to its layer, and ' +
        'deal_jurisdiction set to the market. The layers are separate questions: a factory ' +
        'quality certificate is not a product approval, a product approval is not a market ' +
        'registration, and none of them is the buyer’s own acceptance standard.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'documented_absence',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'A layer you searched properly that demands nothing here, declared with deal_finding ' +
        'set to REQUIREMENT_ABSENCE, the layer in deal_value, and the places you searched ' +
        'listed in searched_repositories. This is a real finding and often the most useful ' +
        'one: a layer with no answer at all is treated as unresearched rather than as clear, ' +
        'so an empty search you do not report leaves the question open.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'landed_cost',
      evidenceKind: 'SPECIFIC_INSTANCE',
      description:
        'One published figure for one line of the cost of getting these goods there, or what ' +
        'the buyer pays today. Declared with deal_finding set to COST_COMPONENT, the line in ' +
        'deal_value, the amount in deal_amount_cents, the published currency in ' +
        'deal_currency, and what the figure is per in deal_subject. Report figures as ' +
        'published: Brain withholds the landed cost when they are on different bases or in ' +
        'different currencies and says why, which is correct, and a harmonised number would ' +
        'be one nobody can check.',
      necessity: 'CONDITIONAL',
    },
    {
      id: 'commercial_precedent',
      description:
        'Evidence that a named commercial structure is actually used in this trade, declared ' +
        'with deal_finding set to COMMERCIAL_PRECEDENT, the structure in deal_value, and ' +
        'what the source says it pays — in the source’s own words, including ranges — in ' +
        'deal_subject. That a structure exists somewhere is not evidence it is used here.',
      necessity: 'CONDITIONAL',
    },
  ],
  expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION', 'NEGATIVE_EXISTENCE'],
  failureConditions: [
    'A requirement can be found for a neighbouring market but nothing published says this ' +
      'market imposes it, which is recorded as unresolved rather than carried across.',
    'A layer cannot be searched because the authority publishes nothing reachable, which is ' +
      'recorded as unresolved naming what was searched — not as a documented absence.',
    'Figures are published on incompatible bases or in different currencies, so the landed ' +
      'cost is withheld and the figures are reported as published.',
    'Intermediary arrangements can be described in general but nothing published shows this ' +
      'trade using any of them.',
  ],
  objective: ({ question, scope, from }) =>
    from === 'ENVELOPE'
      ? `Establish, from published sources, ${lowerFirst(question)} Say which market each ` +
        'finding is about; nothing about this names one of its own.'
      : `Establish, from published sources about ${scope}, ${lowerFirst(question)}`,
  completionCriteria: (scope) => [
    'Every requirement is declared with deal_finding set to COMPLIANCE_REQUIREMENT and its ' +
      'layer in deal_value. Each layer is answered on its own evidence: one layer’s answer ' +
      'is never carried to another.',
    'A layer searched properly and found to demand nothing is declared with ' +
      'REQUIREMENT_ABSENCE and the places searched listed. An empty search that is not ' +
      'declared leaves the layer unresearched, which blocks the deal.',
    'A figure is read from a source and never produced. It is reported in the currency and ' +
      'on the basis the source published, with no conversion, no interpolation and no ' +
      'reconciliation of incompatible figures into one number.',
    'A published range stays a range. It is never turned into a single rate.',
    'A commercial structure is reported as used only where a source about this trade shows ' +
      'it being used. That one exists in general is not evidence about here.',
    'Every source carries its URL, who publishes it, and the date it took effect or was ' +
      'last observed, and every claim carries the URL of the source it came from.',
    `Every finding says which market it is about. Where that is not ${scope}, it is ` +
      'reported as being about somewhere else rather than generalized.',
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
  RUSSELL_DEALFLOW_PARTIES_V1: DEALFLOW_PARTIES,
  RUSSELL_DEALFLOW_TERMS_V1: DEALFLOW_TERMS,
});

export function profileFor(envelopeId: string): CompilerProfile | null {
  return Object.prototype.hasOwnProperty.call(BY_ENVELOPE, envelopeId)
    ? (BY_ENVELOPE[envelopeId] as CompilerProfile)
    : null;
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

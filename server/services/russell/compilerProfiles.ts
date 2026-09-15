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

export type CompilerProfileId = 'PUBLIC_RECORDS' | 'MARKET_DISCOVERY';

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
const BY_ENVELOPE: Readonly<Record<string, CompilerProfile>> = Object.freeze({
  RUSSELL_PUBLIC_RECORDS_V1: PUBLIC_RECORDS,
  RUSSELL_STATE_LICENSING_V1: PUBLIC_RECORDS,
  STEP10_MICHIGAN_LICENSING_V1: PUBLIC_RECORDS,
  STEP11_AUDIT_INDEPENDENCE_V1: PUBLIC_RECORDS,
  RUSSELL_CASH_DISCOVERY_V1: MARKET_DISCOVERY,
});

export function profileFor(envelopeId: string): CompilerProfile | null {
  return Object.prototype.hasOwnProperty.call(BY_ENVELOPE, envelopeId)
    ? (BY_ENVELOPE[envelopeId] as CompilerProfile)
    : null;
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

/**
 * The plan behind a second attempt.
 *
 * A repair that is the same prompt with a different adjective is not a repair.
 * It spends an attempt, a slice of the user's allowance and a few minutes of
 * their day to produce the same failure, and then the fragment is abandoned as
 * though the question were unanswerable — when what was actually unanswerable
 * was that one search.
 *
 * So a repair is planned rather than retried: what failed, which claims were
 * rejected and why, which source ecosystems have already been searched, what
 * else could be searched instead, and a named strategy that no earlier attempt
 * used. When the ladder runs out, the honest outcome is "unresolved", recorded
 * as such — not a fourth identical attempt.
 */
import type {
  RepairPlan,
  RepairStrategy,
  ResearchClaim,
  ResearchFragment,
} from '../../domain/types.ts';
import type { GateResult } from './gate.ts';
import { untaggedAccepted } from './lanes.ts';

/**
 * What to try, in the order it is worth trying.
 *
 * Cheap and likely first — the link that broke, the primary source behind the
 * secondary one — then progressively more specialised places to look, then the
 * responses that change the claim rather than the search: narrow it, express it
 * as a defensible range, or report it unresolved.
 */
const LADDER: Record<string, RepairStrategy[]> = {
  COVERAGE: [
    'FIND_PRIMARY_DATA',
    'TRY_DIFFERENT_REPOSITORIES',
    'USE_OFFICIAL_FILINGS',
    'USE_REGULATORY_RECORDS',
    'USE_PROCUREMENT_RECORDS',
    'USE_CLASSIFICATION_CODES',
    'CHANGE_TERMINOLOGY',
    'NARROW_THE_CLAIM',
    'REPLACE_ESTIMATE_WITH_RANGE',
  ],
  SCOPE_MATCH: [
    'USE_CLASSIFICATION_CODES',
    'FIND_METHODOLOGY_DOCUMENTATION',
    'CHANGE_TERMINOLOGY',
    'NARROW_THE_CLAIM',
  ],
  SOURCE_SUPPORTS: [
    'RESOLVE_CANONICAL_LINK',
    'INSPECT_ARCHIVED_SOURCES',
    'FIND_PRIMARY_DATA',
    'NARROW_THE_CLAIM',
  ],
  SOURCE_VALIDITY: ['RESOLVE_CANONICAL_LINK', 'INSPECT_ARCHIVED_SOURCES', 'FIND_PRIMARY_DATA'],
  DERIVATIONS: ['FIND_PRIMARY_DATA', 'FIND_METHODOLOGY_DOCUMENTATION', 'REPLACE_ESTIMATE_WITH_RANGE'],
  CONTRADICTIONS: [
    'FIND_PRIMARY_DATA',
    'FIND_METHODOLOGY_DOCUMENTATION',
    'INSPECT_ARCHIVED_SOURCES',
    'REPLACE_ESTIMATE_WITH_RANGE',
  ],
};

const DEFAULT_LADDER: RepairStrategy[] = [
  'FIND_PRIMARY_DATA',
  'TRY_DIFFERENT_REPOSITORIES',
  'CHANGE_TERMINOLOGY',
  'NARROW_THE_CLAIM',
  'MARK_UNRESOLVED',
];

/** What each strategy actually asks the worker to do. */
const INSTRUCTIONS: Record<RepairStrategy, string> = {
  RESOLVE_CANONICAL_LINK:
    'The pages cited did not support the claims. Find the canonical version of each source — the ' +
    'publisher\'s own permanent URL, DOI or document identifier — and quote from that.',
  FIND_PRIMARY_DATA:
    'Go to the body that produced the data rather than anyone writing about it: the statistical ' +
    'agency, the registry, the regulator, the court. Cite the dataset or document itself.',
  TRY_DIFFERENT_REPOSITORIES:
    'Search repositories that were not searched last time — national statistics portals, open data ' +
    'catalogues, standards bodies, academic repositories — and name the ones you searched.',
  USE_REGULATORY_RECORDS:
    'Look in regulatory records: licensing registers, enforcement actions, supervisory returns and ' +
    'published guidance.',
  USE_PROCUREMENT_RECORDS:
    'Look in public procurement records: tender notices, contract awards and their published values.',
  USE_OFFICIAL_FILINGS:
    'Look in official filings: annual reports, statutory accounts, prospectuses and disclosures.',
  INSPECT_ARCHIVED_SOURCES:
    'If a source has moved or gone, retrieve it from a web archive and cite the archived copy with ' +
    'its capture date.',
  FIND_METHODOLOGY_DOCUMENTATION:
    'Find the methodology behind the figures — how they were collected, what they count, and what ' +
    'they exclude — and use it to say which figure answers this fragment.',
  CHANGE_TERMINOLOGY:
    'The term this fragment uses may not be the term the sources use. Search the vocabulary the ' +
    'publishing bodies themselves use, and say which term you searched.',
  USE_CLASSIFICATION_CODES:
    'Search by official classification code rather than by name — industry, occupational or product ' +
    'classifications — so the definition is fixed by the code rather than by wording.',
  NARROW_THE_CLAIM:
    'Answer the narrower question that the evidence can actually support, and state plainly which ' +
    'part of the original question is not covered.',
  REPLACE_ESTIMATE_WITH_RANGE:
    'If no single defensible figure exists, give a sourced range with the sources at each end ' +
    'rather than a point estimate nobody published.',
  MARK_UNRESOLVED:
    'If the evidence does not exist, say so explicitly, list where you looked, and stop. An honest ' +
    '"not established" is worth more than a weak claim.',
};

/** The hosts a fragment has already been searched in, from what it returned. */
export function ecosystemsTried(claims: ResearchClaim[]): string[] {
  const hosts = new Set<string>();
  for (const claim of claims) {
    if (!claim.sourceUrl) continue;
    try {
      hosts.add(new URL(claim.sourceUrl).hostname.toLowerCase().replace(/^www\./, ''));
    } catch {
      // A URL that will not parse was already rejected by the gate.
    }
  }
  return [...hosts];
}

/**
 * Terms the sources used that this fragment did not.
 *
 * Taken from the evidence the last attempt actually retrieved rather than
 * invented: if a source calls it something else, that is the word to search.
 */
export function terminologyFromEvidence(
  fragment: ResearchFragment,
  claims: ResearchClaim[],
): string[] {
  const asked = new Set(words(fragment.question));
  const counts = new Map<string, number>();
  for (const claim of claims) {
    for (const word of words(`${claim.claim} ${claim.evidenceExcerpt ?? ''}`)) {
      if (asked.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([word]) => word);
}

const STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'was', 'were', 'are', 'has', 'have', 'had',
  'its', 'their', 'these', 'those', 'which', 'what', 'when', 'where', 'does', 'did', 'not', 'per',
  'about', 'into', 'than', 'then', 'they', 'them', 'been', 'also', 'more', 'most', 'such', 'each',
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 4 && !STOP.has(word));
}

/** Classification systems worth trying when a definition will not hold still. */
const CLASSIFICATIONS = [
  'NAICS / SIC industry codes',
  'ISIC / NACE industry codes',
  'SOC / ISCO occupational codes',
  'CPV procurement codes',
  'HS / CN product codes',
];

/** Source ecosystems distinct from the ones already searched. */
const ECOSYSTEMS = [
  'national statistical agencies',
  'sector regulators and supervisory bodies',
  'company and charity registries',
  'court and tribunal records',
  'public procurement portals',
  'standards bodies and classification authorities',
  'peer-reviewed literature and its underlying datasets',
  'web archives of sources that have moved',
];

export interface BuildRepairPlanInput {
  fragment: ResearchFragment;
  gate: GateResult;
  /** Every attempt at this fragment so far, oldest first. */
  history: ResearchFragment[];
  /** The claims the failed attempt produced. */
  claims: ResearchClaim[];
  /** True when the failure looks like two questions rather than one. */
  splitRequired: boolean;
  /** Attempts left after this one, including it. */
  remainingBudget: number;
}

/**
 * Build the plan for the next attempt.
 *
 * The strategy is chosen from what actually failed and then filtered against
 * what has already been tried, so consecutive attempts cannot be the same
 * search twice. When every rung has been used, the plan says to mark it
 * unresolved rather than to try again.
 */
export function buildRepairPlan(input: BuildRepairPlanInput): RepairPlan {
  const { fragment, gate } = input;
  const used = new Set<RepairStrategy>(
    input.history.flatMap((attempt) => attempt.repairPlan?.strategies ?? []),
  );

  const candidates = input.gate.failedConditions.flatMap(
    (condition) => LADDER[condition] ?? [],
  );
  const ordered = [...new Set([...candidates, ...DEFAULT_LADDER])];
  const fresh = ordered.filter((strategy) => !used.has(strategy));
  const strategies: RepairStrategy[] =
    input.remainingBudget <= 1 || fresh.length === 0
      ? ['MARK_UNRESOLVED']
      : fresh.slice(0, 2);

  const tried = ecosystemsTried(input.claims);
  const rejected = input.claims
    .filter((claim) => !claim.accepted)
    .map((claim) => ({ claim: claim.claim, why: claim.rejectionReason ?? 'rejected by the gate' }));

  const missingLanes = gate.coverage.filter((lane) => !lane.meetsThreshold).map((lane) => lane.lane);
  /**
   * Lanes empty because nothing was *tagged* are a different failure from
   * lanes empty because nothing was found, and the plan has to say which.
   *
   * The first fresh acceptance packet failed on the first and was told the
   * second: "No accepted evidence in: statute", when the statute had been
   * quoted, sourced, verified and accepted, and simply not labelled. So the
   * repair went looking for evidence the fragment already held, spent the
   * attempt, and produced the same result. A repair aimed at the wrong failure
   * is worse than no repair.
   *
   * `brain_submit_claims` now refuses an untagged claim outright, so this
   * cannot arise from a new run. It stays because a packet from before that
   * refusal can still be repaired, and because a plan that misdiagnoses is the
   * kind of thing that should be impossible rather than fixed once.
   */
  const untagged = untaggedAccepted(input.claims);
  const contested = input.claims.find(
    (claim) => claim.contradictionState === 'CONTESTED' || claim.contradictionState === 'REFUTED',
  );

  return {
    failedRequirement: fragment.missingEvidence ?? fragment.question,
    affectedClaims: rejected.slice(0, 20),
    missingEvidence:
      missingLanes.length > 0 && untagged > 0
        ? `${untagged} accepted claim(s) carry no evidence lane, so ${missingLanes.length} ` +
          `declared lane(s) read as empty: ${missingLanes.join(', ')}. The evidence is not ` +
          'missing — it is unlabelled. Resubmit the same claims with "evidence_lane" set to one ' +
          'of the fragment\'s declared lanes, and search further only for a lane that genuinely ' +
          'has nothing in it.'
        : missingLanes.length > 0
        ? `No accepted evidence in: ${missingLanes.join(', ')}.`
        : gate.independentSources < fragment.minIndependentSources
          ? `Corroboration is missing: the accepted evidence rests on ${gate.independentSources} ` +
            `independent source(s) and this fragment needs ${fragment.minIndependentSources}, so ` +
            `what is required is the same fact from different publishers rather than more pages ` +
            `from the same one.`
          : gate.reasons.join(' '),
    rejectedEvidence: [
      ...new Set(
        input.claims
          .filter((claim) => !claim.accepted && claim.sourceUrl)
          .map((claim) => claim.sourceUrl!),
      ),
    ].slice(0, 20),
    unresolvedContradiction: contested
      ? `${contested.claim} — ${contested.contradictionNote ?? 'challenged with no resolution recorded'}`
      : null,
    ecosystemsAttempted: tried,
    alternativeEcosystems: ECOSYSTEMS.filter(
      (ecosystem) => !tried.some((host) => ecosystem.toLowerCase().includes(host.split('.')[0] ?? '')),
    ).slice(0, 4),
    alternativeTerminology: terminologyFromEvidence(fragment, input.claims),
    alternativeClassifications: strategies.includes('USE_CLASSIFICATION_CODES') ? CLASSIFICATIONS : [],
    narrowerQuestion: strategies.includes('NARROW_THE_CLAIM') ? narrower(fragment) : null,
    splitRequired: input.splitRequired,
    remainingBudget: Math.max(0, input.remainingBudget),
    strategies,
  };
}

/** The same question with the part the evidence could not reach cut away. */
function narrower(fragment: ResearchFragment): string {
  const scope = [fragment.geography, fragment.timeframe]
    .filter((value): value is string => Boolean(value))
    .join(', ');
  return (
    `${fragment.question.replace(/\?$/, '')}${scope ? `, for ${scope} only` : ''}, ` +
    'answering only the part a published source states directly?'
  );
}

/**
 * The plan as the worker will read it.
 *
 * Written out rather than passed as data because the worker is a language
 * model reading a prompt: what it needs is the instruction, the list of places
 * already searched, and the claims it must not simply return again.
 */
export function describeRepairPlan(plan: RepairPlan): string {
  const parts: string[] = [];
  parts.push(plan.missingEvidence);
  for (const strategy of plan.strategies) parts.push(INSTRUCTIONS[strategy]);
  if (plan.ecosystemsAttempted.length > 0) {
    parts.push(
      `Already searched, and not where the answer is: ${plan.ecosystemsAttempted.join(', ')}.`,
    );
  }
  if (plan.alternativeEcosystems.length > 0) {
    parts.push(`Try instead: ${plan.alternativeEcosystems.join('; ')}.`);
  }
  if (plan.alternativeTerminology.length > 0) {
    parts.push(
      `The sources you found used these words rather than the fragment's: ` +
        `${plan.alternativeTerminology.join(', ')}. Search those.`,
    );
  }
  if (plan.alternativeClassifications.length > 0) {
    parts.push(`Fix the definition with a code: ${plan.alternativeClassifications.join('; ')}.`);
  }
  if (plan.narrowerQuestion) parts.push(`A narrower question worth answering: ${plan.narrowerQuestion}`);
  if (plan.unresolvedContradiction) {
    parts.push(`Unresolved contradiction to settle: ${plan.unresolvedContradiction}`);
  }
  parts.push(
    plan.remainingBudget <= 1
      ? 'This is the last attempt. If it cannot be established, say so explicitly and list where you looked.'
      : `${plan.remainingBudget} attempts remain for this fragment.`,
  );
  return parts.join(' ');
}

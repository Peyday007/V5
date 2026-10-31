/**
 * Deciding what the project already knows.
 *
 * This is the module that stops Brain researching things it has already
 * established, and — just as importantly — stops it accepting a polished old
 * report as an answer. Every requirement gets one status and the reasons behind
 * it, and only the requirements that come out genuinely missing are allowed to
 * become research.
 *
 * The distinctions are the point. A requirement is not covered because a
 * document mentions the subject; it is covered when a claim of the right kind,
 * about the right population in the right place at the right time, with a source
 * that can be checked, actually answers it. The failure modes each get their own
 * status because each one needs a different response:
 *
 *   PRESENT_BUT_UNVERIFIED  somebody wrote the answer down and nothing supports it
 *   DEFINITION_MISMATCH     a real figure about a subtly different thing
 *   STALE                   true once, outside the timeframe now
 *   CONTRADICTED            the archive disagrees with itself and nobody settled it
 *   SUPERSEDED              answered by a document a later version replaced
 *
 * None of those is "missing", and none of them is "fine".
 */
import type {
  BoundaryContract,
  CoverageStatus,
  ExistingClaim,
  GapType,
  Requirement,
  RequirementCoverage,
} from '../../domain/types.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { listExistingClaims, upsertCoverage } from '../../repos/reconciliation.ts';
import { ownCitableAsExisting } from '../../repos/research.ts';
import { sharedClaimsForProject } from '../knowledge/shared.ts';
import { getDb } from '../../db/database.ts';

/** Words too common to indicate that a claim is about a requirement. */
const STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'what', 'which', 'their', 'they',
  'have', 'has', 'are', 'was', 'were', 'been', 'its', 'how', 'why', 'when', 'who', 'must',
  'not', 'can', 'will', 'would', 'should', 'could', 'about', 'into', 'than', 'then', 'them',
  'establish', 'establishes', 'established', 'requirement', 'evidence', 'research', 'data',
  'across', 'within', 'each', 'every', 'used', 'using', 'does', 'whether',
]);

/*
 * `relevance` is asked for every claim against every requirement, and it
 * re-tokenized both each time: the requirement once per claim, and each claim
 * once per requirement and per reading. Over an archive of thousands of claims
 * that is the judging pass's CPU, on the event loop that also answers sign-in
 * (production, 2026-10-31: a 39 s stall with `russell:judge-unjudged` in
 * flight). Terms are a pure function of the text, so each text is tokenized
 * once per process; the memo is bounded and simply restarts when full.
 */
const termsMemo = new Map<string, Set<string>>();
const TERMS_MEMO_MAX = 50_000;

function terms(text: string): Set<string> {
  const hit = termsMemo.get(text);
  if (hit) return hit;
  const computed = new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3 && !STOP.has(word)),
  );
  if (termsMemo.size >= TERMS_MEMO_MAX) termsMemo.clear();
  termsMemo.set(text, computed);
  return computed;
}

/** How much of the requirement's vocabulary a claim actually uses. */
function relevance(requirement: Requirement, claim: ExistingClaim): number {
  // The lane *descriptions*: term matching works on the prose, and the ids are
  // deliberately terse, so joining those instead would throw the meaning away.
  const laneWords = requirement.requiredEvidence.map((lane) => lane.description).join(' ');
  const wanted = terms(`${requirement.statement} ${laneWords}`);
  if (wanted.size === 0) return 0;
  const found = terms(claim.claim);
  let hits = 0;
  for (const word of wanted) if (found.has(word)) hits += 1;
  return hits / wanted.size;
}

/** Only claims that are recognisably about this requirement are considered. */
const RELEVANCE_FLOOR = 0.3;

/** A year mentioned anywhere in a string, for the staleness check. */
function yearsIn(text: string | null): number[] {
  if (!text) return [];
  return [...text.matchAll(/\b(19|20)\d{2}\b/g)].map((match) => Number(match[0]));
}

/**
 * Does the claim sit inside the timeframe the contract asked for?
 *
 * Answered only when both sides state a year: guessing that undated evidence is
 * current is exactly how a stale figure survives into a new packet.
 */
function timeframeVerdict(
  claim: ExistingClaim,
  contract: BoundaryContract | null,
): 'MATCH' | 'STALE' | 'UNKNOWN' {
  const wanted = yearsIn(contract?.timeframe ?? null);
  if (wanted.length === 0) return 'UNKNOWN';
  const claimYears = [...yearsIn(claim.sourceDate), ...yearsIn(claim.timeframe), ...yearsIn(claim.claim)];
  if (claimYears.length === 0) return 'UNKNOWN';
  const newest = Math.max(...claimYears);
  const earliestWanted = Math.min(...wanted);
  return newest >= earliestWanted ? 'MATCH' : 'STALE';
}

/**
 * Places a claim might be about, matched as whole words.
 *
 * Substring matching is not good enough here and the failure is not obvious:
 * "census" contains "us ", so a naive check reads a US statistical agency as a
 * foreign source and throws away the country's own evidence. Every alias is
 * matched on word boundaries for that reason.
 */
const PLACES: { name: string; pattern: RegExp }[] = [
  { name: 'united states', pattern: /\b(?:united states|u\.?s\.?a?\.?|american?)\b/i },
  { name: 'united kingdom', pattern: /\b(?:united kingdom|u\.?k\.?|britain|british|england|wales|scotland)\b/i },
  { name: 'european union', pattern: /\b(?:european union|e\.?u\.?|eurozone)\b/i },
  { name: 'canada', pattern: /\bcanadian?\b/i },
  { name: 'australia', pattern: /\baustralian?\b/i },
  { name: 'germany', pattern: /\b(?:germany|german)\b/i },
  { name: 'france', pattern: /\b(?:france|french)\b/i },
  { name: 'india', pattern: /\bindian?\b/i },
  { name: 'china', pattern: /\b(?:china|chinese)\b/i },
  { name: 'japan', pattern: /\bjapan(?:ese)?\b/i },
  { name: 'brazil', pattern: /\bbrazil(?:ian)?\b/i },
];

/** Does the claim concern the geography the contract named? */
function geographyVerdict(
  claim: ExistingClaim,
  contract: BoundaryContract | null,
): 'MATCH' | 'MISMATCH' | 'UNKNOWN' {
  const wanted = (contract?.geography ?? '').trim().toLowerCase();
  if (wanted.length === 0) return 'UNKNOWN';
  const haystack = `${claim.claim} ${claim.geography ?? ''} ${claim.supportingPassage ?? ''}`;

  const target = PLACES.find((place) => wanted.includes(place.name));
  if (target?.pattern.test(haystack)) return 'MATCH';
  if (!target && haystack.toLowerCase().includes(wanted)) return 'MATCH';

  // A claim that names a different country is a mismatch; one that names none is
  // simply silent, and silence is not a mismatch.
  const namesAnother = PLACES.some(
    (place) => place.name !== target?.name && place.pattern.test(haystack),
  );
  return namesAnother ? 'MISMATCH' : 'UNKNOWN';
}

export interface CoverageInput {
  orchestrationId: string;
  requirements: Requirement[];
  claims: ExistingClaim[];
  contract: BoundaryContract | null;
}

export interface CoverageAssessment {
  requirement: Requirement;
  status: CoverageStatus;
  reasons: string[];
  claimIds: string[];
  documentIds: string[];
  confidence: number;
  gapType: GapType | null;
  gapDetail: string | null;
  needsResearch: boolean;
}

/**
 * Judge one requirement against the archive.
 *
 * The order of the checks is the order of the objections: what a requirement is
 * for comes first (research or not), then whether anything is even about it,
 * then whether what is about it can be believed.
 */
export function assessRequirement(
  requirement: Requirement,
  claims: ExistingClaim[],
  contract: BoundaryContract | null,
): CoverageAssessment {
  const base = {
    requirement,
    claimIds: [] as string[],
    documentIds: [] as string[],
    confidence: 0,
    gapType: null as GapType | null,
    gapDetail: null as string | null,
  };

  // Not everything in a goal is research. Saying so is what keeps the fragment
  // count honest.
  if (requirement.kind === 'OTHER_LAYER') {
    return {
      ...base,
      status: 'OWNED_ELSEWHERE',
      reasons: ['Another layer owns this question, so it is not researched here.'],
      gapType: 'OTHER_LAYER_OWNERSHIP',
      needsResearch: false,
    };
  }
  if (requirement.kind === 'IMPLEMENTATION' || requirement.kind === 'TUNING') {
    return {
      ...base,
      status: 'NOT_REQUIRED',
      reasons: [`This is ${requirement.kind === 'TUNING' ? 'tuning' : 'implementation'} work, not desk research.`],
      gapType: requirement.kind === 'TUNING' ? 'TUNING' : 'IMPLEMENTATION_DETAIL',
      needsResearch: false,
    };
  }
  if (requirement.kind === 'EMPIRICAL_VALIDATION') {
    return {
      ...base,
      status: 'NOT_REQUIRED',
      reasons: ['This has to be validated by running the thing, not by looking it up.'],
      gapType: 'EMPIRICAL_VALIDATION',
      needsResearch: false,
    };
  }
  if (requirement.kind === 'IRRELEVANT') {
    return {
      ...base,
      status: 'NOT_REQUIRED',
      reasons: ['This does not materially affect the goal.'],
      needsResearch: false,
    };
  }

  const relevant = claims
    .map((claim) => ({ claim, score: relevance(requirement, claim) }))
    .filter((entry) => entry.score >= RELEVANCE_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  if (relevant.length === 0) {
    return {
      ...base,
      status: 'MISSING',
      reasons: ['Nothing in the project addresses this.'],
      gapType:
        requirement.necessity === 'MANDATORY' ? 'MISSING_FOUNDATIONAL' : 'MISSING_SUPPORTING',
      gapDetail: requirement.statement,
      needsResearch: true,
    };
  }

  const claimIds = relevant.map((entry) => entry.claim.id);
  const documentIds = [...new Set(relevant.map((entry) => entry.claim.documentId))];
  const reasons: string[] = [];

  // Superseded documents answer nothing: the project already replaced them.
  const live = relevant.filter((entry) => !entry.claim.superseded);
  if (live.length === 0) {
    return {
      ...base,
      claimIds,
      documentIds,
      status: 'SUPERSEDED',
      reasons: [
        `The only evidence for this is in ${documentIds.length} superseded document(s), which a later version replaced.`,
      ],
      gapType: 'STALE_EVIDENCE',
      gapDetail: requirement.statement,
      needsResearch: true,
    };
  }

  // A contradiction nobody settled is not an answer, whichever side is right.
  const contradicted = live.filter(
    (entry) => entry.claim.contradictionState === 'CONTESTED' || entry.claim.contradictionState === 'REFUTED',
  );
  if (contradicted.length > 0) {
    return {
      ...base,
      claimIds,
      documentIds,
      status: 'CONTRADICTED',
      reasons: [
        `${contradicted.length} of the relevant claim(s) are contested or refuted and nothing resolved it.`,
      ],
      gapType: 'UNRESOLVED_CONTRADICTION',
      gapDetail: contradicted[0]!.claim.claim,
      needsResearch: true,
      confidence: 0.2,
    };
  }

  // Scope before quality: a perfectly sourced figure about the wrong country is
  // the failure that survives every other check.
  const mismatched = live.filter((entry) => geographyVerdict(entry.claim, contract) === 'MISMATCH');
  if (mismatched.length === live.length) {
    return {
      ...base,
      claimIds,
      documentIds,
      status: 'DEFINITION_MISMATCH',
      reasons: [
        `The evidence concerns a different geography from the "${contract?.geography}" this assignment asked for.`,
      ],
      gapType: 'MISSING_GEOGRAPHY',
      gapDetail: requirement.statement,
      needsResearch: true,
      confidence: 0.2,
    };
  }

  const inScope = live.filter((entry) => geographyVerdict(entry.claim, contract) !== 'MISMATCH');
  const stale = inScope.filter((entry) => timeframeVerdict(entry.claim, contract) === 'STALE');
  if (stale.length === inScope.length) {
    return {
      ...base,
      claimIds,
      documentIds,
      status: 'STALE',
      reasons: [
        `Every relevant claim predates the "${contract?.timeframe}" this assignment covers.`,
      ],
      gapType: 'STALE_EVIDENCE',
      gapDetail: requirement.statement,
      needsResearch: true,
      confidence: 0.3,
    };
  }

  const current = inScope.filter((entry) => timeframeVerdict(entry.claim, contract) !== 'STALE');

  // Now quality. A claim with no source, or one nobody could check, is an answer
  // written down rather than an answer established.
  const supported = current.filter(
    (entry) =>
      entry.claim.sourceUrl !== null &&
      entry.claim.claimType !== 'UNSUPPORTED_ASSERTION' &&
      entry.claim.verificationState !== 'UNVERIFIABLE' &&
      entry.claim.verificationState !== 'REJECTED',
  );

  if (supported.length === 0) {
    return {
      ...base,
      claimIds,
      documentIds,
      status: 'PRESENT_BUT_UNVERIFIED',
      reasons: [
        `${current.length} document claim(s) answer this, but none of them cites a source that can be checked.`,
      ],
      gapType: 'UNVERIFIABLE_CITATION',
      gapDetail: current[0]!.claim.claim,
      needsResearch: true,
      confidence: 0.25,
    };
  }

  const selfReportsOnly = supported.every((entry) => entry.claim.claimType === 'SELF_REPORT');
  if (selfReportsOnly) {
    return {
      ...base,
      claimIds,
      documentIds,
      status: 'PARTIALLY_SATISFIED',
      reasons: [
        'The only sourced evidence is what the organisations say about themselves, which ' +
          'establishes their claims rather than the fact.',
      ],
      gapType: 'SOURCE_QUALITY',
      gapDetail: requirement.statement,
      needsResearch: true,
      confidence: 0.4,
    };
  }

  const best = supported[0]!;
  const strength = Math.min(0.95, best.score * 0.5 + best.claim.evidenceConfidence * 0.5);
  const publishers = new Set(
    supported
      .map((entry) => {
        try {
          return new URL(entry.claim.sourceUrl!).hostname.replace(/^www\./, '');
        } catch {
          return null;
        }
      })
      .filter((host): host is string => host !== null),
  );

  reasons.push(
    `${supported.length} sourced claim(s) across ${publishers.size} publisher(s) answer this, ` +
      `the strongest from ${best.claim.sourcePublisher ?? best.claim.sourceUrl}.`,
  );

  // Satisfied is a high bar on purpose: it is the only status that stops
  // research happening, so it needs corroboration and a decent match.
  const satisfied = publishers.size >= 2 && strength >= 0.55 && best.score >= 0.5;
  if (satisfied) {
    return {
      ...base,
      claimIds,
      documentIds,
      status: 'SATISFIED',
      reasons,
      confidence: strength,
      needsResearch: false,
    };
  }

  reasons.push(
    publishers.size < 2
      ? 'It rests on a single publisher, so it is not yet corroborated.'
      : 'The match to what this requirement asks for is only partial.',
  );
  return {
    ...base,
    claimIds,
    documentIds,
    status: 'PARTIALLY_SATISFIED',
    reasons,
    gapType: publishers.size < 2 ? 'INSUFFICIENT_INDEPENDENCE' : 'MISSING_SUPPORTING',
    gapDetail: requirement.statement,
    confidence: strength,
    needsResearch: true,
  };
}

/** Judge every requirement, and persist the matrix. */
export async function buildCoverageMatrix(input: CoverageInput): Promise<{
  assessments: CoverageAssessment[];
  coverage: RequirementCoverage[];
}> {
  const assessments = input.requirements.map((requirement) =>
    assessRequirement(requirement, input.claims, input.contract),
  );
  const coverage = await Promise.all(
    assessments.map((assessment) =>
      upsertCoverage({
        orchestrationId: input.orchestrationId,
        requirementId: assessment.requirement.id,
        status: assessment.status,
        reasons: assessment.reasons,
        claimIds: assessment.claimIds,
        documentIds: assessment.documentIds,
        confidence: assessment.confidence,
        gapType: assessment.gapType,
        gapDetail: assessment.gapDetail,
        needsResearch: assessment.needsResearch,
      }),
    ),
  );
  return { assessments, coverage };
}

/**
 * Every claim the project has, for a coverage pass: what its documents say,
 * and what its own research gate accepted.
 *
 * The second half is `ownCitableAsExisting` — accepted claims in ACCEPTED or
 * BLOCKED fragments — and it is here because production held 944 accepted
 * claims inside BLOCKED fragments that this read could not see. A BLOCKED
 * fragment is not treated as complete: only its supported claims are offered,
 * and `assessRequirement`, unchanged, decides whether they answer a new
 * requirement. The cross-project pool is not touched (§31).
 */
export async function projectClaims(projectId: string): Promise<ExistingClaim[]> {
  const archive = await readArchive(projectId);
  return dedupeClaims([...archive.documentClaims, ...archive.gatedClaims]);
}

/** One claim per id, first occurrence kept — a claim counted twice would look like two. */
export function dedupeClaims(claims: ExistingClaim[]): ExistingClaim[] {
  const seen = new Set<string>();
  const out: ExistingClaim[] = [];
  for (const claim of claims) {
    if (seen.has(claim.id)) continue;
    seen.add(claim.id);
    out.push(claim);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The archive, read once per tick per project, under a content marker
// ---------------------------------------------------------------------------

/** What a coverage check reads about one project's archive. */
export interface ArchiveRead {
  /** Claims extracted from the project's own documents. */
  documentClaims: ExistingClaim[];
  /** The project's own gate-accepted research claims (ACCEPTED or BLOCKED fragments). */
  gatedClaims: ExistingClaim[];
  /** Findings the rest of the Brain validated, eligible for this project. */
  sharedClaims: ExistingClaim[];
  /**
   * A content marker over all three: it moves exactly when a claim appears,
   * disappears or changes its contradiction or verification state. "Searched
   * against an unchanged archive" means this string did not move.
   */
  marker: string;
}

const archiveScope = new AsyncLocalStorage<Map<string, Promise<ArchiveRead>>>();
let archiveReads = 0;

/** How many times the archive was actually read (not served from a memo). */
export function archiveReadCount(): number {
  return archiveReads;
}

/** For tests. */
export function resetArchiveReadCount(): void {
  archiveReads = 0;
}

/**
 * Hold archive reads for the life of `fn`: one read per project, however many
 * requirement checks the pass makes.
 *
 * The durable Russell tick is the scope. A check outside any scope reads the
 * archive afresh, which is the old behaviour and never less safe. Inside a
 * scope a write that lands mid-tick is seen on the next tick — the memo is a
 * tick long, and a tick is seconds.
 */
export function withArchiveMemo<T>(fn: () => Promise<T>): Promise<T> {
  if (archiveScope.getStore()) return fn();
  return archiveScope.run(new Map(), fn);
}

/** The marker a set of claims is judged under. Order-free, and moves with state. */
export function archiveMarkerFor(claims: ExistingClaim[]): string {
  const parts = claims
    .map((claim) => `${claim.id}:${claim.contradictionState}:${claim.verificationState}:${claim.superseded ? 1 : 0}`)
    .sort();
  return `a1:${claims.length}:${createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 24)}`;
}

/** The project's archive as a coverage check reads it, memoized inside `withArchiveMemo`. */
export async function readArchive(projectId: string): Promise<ArchiveRead> {
  const memo = archiveScope.getStore();
  const held = memo?.get(projectId);
  if (held) return held;
  const reading = (async (): Promise<ArchiveRead> => {
    archiveReads += 1;
    const [documentClaims, gatedClaims, sharedClaims] = await Promise.all([
      listExistingClaims(projectId),
      ownCitableAsExisting(projectId),
      sharedClaimsForProject(projectId),
    ]);
    return {
      documentClaims,
      gatedClaims,
      sharedClaims,
      marker: archiveMarkerFor(dedupeClaims([...documentClaims, ...gatedClaims, ...sharedClaims])),
    };
  })();
  if (memo) {
    memo.set(projectId, reading);
    // A failed read is not held: the next check in the tick asks again.
    reading.catch(() => memo.delete(projectId));
  }
  return reading;
}

/** The archive marker this project's archive is at now. */
export async function currentArchiveMarker(projectId: string): Promise<string> {
  return (await readArchive(projectId)).marker;
}

/** Block causes that mean the question *was* searched against the evidence, and the evidence did not settle it. */
const SEARCHED_AND_UNSETTLED = new Set([
  'NO_CLAIMS',
  'NOTHING_SURVIVED',
  'REQUIRED_LANE_EMPTY',
  'MOSTLY_REJECTED',
  'INDEPENDENT_SOURCES_SHORT',
  'VERIFIER_INSUFFICIENT',
]);

function normalizedQuestion(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** A finished search an identical question would only repeat. */
export interface RepeatedSearch {
  fragmentId: string;
  orchestrationId: string;
  fragmentKey: string;
  blockCause: string;
}

/**
 * Was this exact question already searched, to the end of its repair ladder,
 * against the archive as it stands now?
 *
 * Only a fragment whose search was actually run against the evidence counts —
 * a work fault, a dependency, an unreadable source or a refused host is not a
 * search that found nothing, and a question stopped by one of those is asked
 * again. Only the last attempt counts, because a fragment with repairs left is
 * still being searched. Only a fragment stamped with this exact marker
 * counts, because the marker moving is what "new facts appeared" means, and
 * then the question is searched again — incrementally, against what is new.
 */
export async function repeatOfUnchangedSearch(input: {
  projectId: string;
  question: string;
  marker: string;
}): Promise<RepeatedSearch | null> {
  const rows = await getDb().all<{
    id: string;
    orchestration_id: string;
    fragment_key: string;
    question: string;
    block_cause: string | null;
    attempt: number;
    max_repairs: number;
  }>(
    `SELECT id, orchestration_id, fragment_key, question, block_cause, attempt, max_repairs
       FROM research_fragments
      WHERE project_id = ? AND archive_marker = ? AND status = 'BLOCKED'
      ORDER BY created_at, id`,
    [input.projectId, input.marker],
  );
  const asked = normalizedQuestion(input.question);
  for (const row of rows) {
    if (normalizedQuestion(row.question) !== asked) continue;
    if (!row.block_cause || !SEARCHED_AND_UNSETTLED.has(row.block_cause)) continue;
    if (Number(row.attempt) < Number(row.max_repairs)) continue;
    return {
      fragmentId: row.id,
      orchestrationId: row.orchestration_id,
      fragmentKey: row.fragment_key,
      blockCause: row.block_cause,
    };
  }
  return null;
}

export type { RequirementCoverage };

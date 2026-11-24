/**
 * Brain improving itself: one loop from weakness to measured result (§87).
 *
 *   OBSERVE  the scoreboard and the failure records (`scoreboard.ts`)
 *   IDENTIFY a general weakness, keyed by what is weak, never by one job
 *   CAUSE    from the rows when they say it, else from method research
 *   METHOD   the archive first (invariant 13); otherwise a research goal in
 *            `brain-architecture`, whose bins are BRAIN_IMPROVEMENT, so Claude
 *            routines get genuine Brain work instead of NO_WORK (§84)
 *   ENGINEER a complete Factory objective on Brain's own repository, approved
 *            on the owner's standing order; Factory plans, implements, tests,
 *            reviews, merges, deploys and verifies it (§27, §58)
 *   MEASURE  the same metric after delivery against the baseline recorded
 *            before it, and the downstream metric beside it
 *   DECIDE   KEPT, KEPT_NO_EFFECT, REVERTED (one revert objective), HELD on a
 *            named dependency, REJECTED with the evidence, or COMBINED
 *   LEARN    every decision is an event, a later attempt reads the earlier
 *            ones (invariant 16), and the next weakness is chosen by rank
 *
 * It runs as one pass of the durable Russell tick, at most every ten minutes,
 * and is idempotent by rows: a weakness is one candidate, a candidate one
 * research goal and one change request per attempt, and a decided candidate is
 * never reopened — a weakness that persists becomes a new attempt, at most
 * `MAX_ATTEMPTS`, so a failing improvement cannot loop.
 */
import { getDb } from '../../db/database.ts';
import { toJson } from '../../repos/util.ts';
import {
  alertsDue,
  ARCHIVE_OVERLAP_SHARE,
  checkDependencies,
  claimRejectionWeaknesses,
  compare,
  decideAfterMeasurement,
  dependencyCheckFor,
  deriveStage,
  freeLaneWeaknesses,
  isRecordOnly,
  MAX_ATTEMPTS,
  BEFORE_WINDOW_HOURS,
  RECENT_WINDOW_HOURS,
  MEASURE_WINDOW_HOURS,
  MEASURE_MAX_HOURS,
  METRICS,
  packetWeaknesses,
  ownerInterventionWeaknesses,
  rankCandidates,
  riskForScope,
  type MetricKey,
  type MetricReading,
  type Stage,
  type Weakness,
} from '../../domain/improvement.ts';
import {
  decideCandidate,
  getCandidate,
  listCandidates,
  listImprovementEvents,
  patchCandidate,
  recordImprovementEvent,
  upsertCandidate,
  type ImprovementCandidate,
} from '../../repos/improvement.ts';
import { BRAIN_PROJECT_SLUG, BRAIN_REPOSITORY_ID } from '../../domain/binPurpose.ts';
import { RELEASE_EXCLUDED_PATHS } from '../../domain/factoryRelease.ts';
import { claimRejections, freeLaneFailures, ownerInterventions, packetOutcomes, readMetric } from './scoreboard.ts';
import { improvementPerson, improvementSwitch } from './authority.ts';
import { ROUTING_MARKER } from '../../domain/engineeringDirector.ts';
import type { ExistingMatch } from '../selfmodel/gapLoop.ts';
import type { ValueJudgment } from '../selfmodel/gapValue.ts';

export const IMPROVEMENT_TICK_MS = 10 * 60_000;
const HOUR = 3_600_000;
/** The baseline is the three days before a change was submitted. */
export const BASELINE_HOURS = 72;
/** A weakness decided this long ago and still present becomes a new attempt. */
export const RECUR_AFTER_HOURS = 72;
/** A Factory objective blocked this long with no movement is held on its blocker. */
export const BLOCKED_HOLD_HOURS = 72;
/** A method research goal's deadline. */
export const RESEARCH_DAYS = 4;

export const BRAIN_REPOSITORY_REMOTE = 'https://github.com/Peyday007/V5';

let lastTick = 0;

export interface ImprovementTickReport {
  ran: boolean;
  reason: string;
  detected: number;
  opened: string[];
  advanced: string[];
  decided: string[];
  alerts: string[];
  errors: string[];
  /** The free-lane research activation after this pass's evaluation (`activation.ts`). */
  activation?: string;
  /** Goals whose capability assessment changed this pass (§88). */
  objectives?: string[];
  /** Capability-gap loop steps recorded this pass, `KEY:STEP` (AUTO-20-2, `selfmodel/gapLoopSync.ts`). */
  gapSteps?: string[];
  /** Weaknesses Brain originated from goals, failures, idle capacity, openings and needs this pass (AUTO-20-1, `selfmodel/originate.ts`). */
  originated?: string[];
}

const OBJECTIVE_CHECK_MS = 60 * 60_000;
let lastObjectiveCheck = 0;

/** Capability work waits this long after the process starts, then runs at most hourly. */
export const CAPABILITY_BOOT_GRACE_MS = 15 * 60_000;
const CAPABILITY_EVERY_MS = 60 * 60_000;
let lastCapabilityAt = 0;
let lastCapabilityGaps: Weakness[] = [];
let lastOriginated: Weakness[] = [];
let processStartedAt = Date.now();

function capabilityDue(now: Date): boolean {
  if (now.getTime() - processStartedAt < CAPABILITY_BOOT_GRACE_MS) return false;
  return now.getTime() - lastCapabilityAt >= CAPABILITY_EVERY_MS;
}

/** The durable tick's call: at most every ten minutes. */
export async function improvementTickIfDue(nowMs = Date.now()): Promise<ImprovementTickReport | null> {
  if (nowMs - lastTick < IMPROVEMENT_TICK_MS) return null;
  lastTick = nowMs;
  return improvementTick(new Date(nowMs));
}

export function resetImprovementTick(): void {
  lastTick = 0;
  lastObjectiveCheck = 0;
  lastCapabilityAt = 0;
  lastCapabilityGaps = [];
  lastOriginated = [];
  processStartedAt = Date.now() - CAPABILITY_BOOT_GRACE_MS;
}

/* ------------------------------------------------------------------------- */
/* Observe and identify                                                       */
/* ------------------------------------------------------------------------- */

/** Every weakness the rows show now. Pure reads. */
export async function detectWeaknesses(now: Date): Promise<Weakness[]> {
  return (await detectAll(now)).weaknesses;
}

async function detectAll(now: Date): Promise<{ weaknesses: Weakness[]; originated: string[]; errors: string[] }> {
  const to = now.toISOString();
  const day = new Date(now.getTime() - 24 * HOUR).toISOString();
  const week = new Date(now.getTime() - 7 * 24 * HOUR).toISOString();
  const lane = await freeLaneFailures(day, to);
  const recentLane = await freeLaneFailures(new Date(now.getTime() - RECENT_WINDOW_HOURS * HOUR).toISOString(), to);
  const claims = await claimRejections(week, to);
  const packets = await packetOutcomes(week, to);
  const asks = await ownerInterventions(week, to);
  const detected = [
    ...ownerInterventionWeaknesses(asks.causes, asks.total),
    ...freeLaneWeaknesses(lane.failures, lane.attempts, recentLane),
    ...claimRejectionWeaknesses(claims.rejections, claims.claims),
    ...packetWeaknesses(packets.causes, packets.settled),
  ];
  // §88: a requirement the capability map reads BROKEN or MISSING, that no detector above
  // already raised and no open candidate already owns, is a weakness like any other.
  // At most hourly, and never in the first minutes after boot: the assessment is ~25
  // reads, and a restart is when the database is busiest (Deploy 41940346030 and
  // 41945448533 timed out verifying right after the restart).
  const cached = (): { weaknesses: Weakness[]; originated: string[]; errors: string[] } => ({
    weaknesses: [...detected, ...lastCapabilityGaps, ...lastOriginated.filter((w) => !detected.some((d) => d.key === w.key))],
    originated: lastOriginated.map((w) => w.key),
    errors: [],
  });
  if (!capabilityDue(now)) return cached();
  lastCapabilityAt = now.getTime();
  const open = (await listCandidates({ open: true })).map((c) => c.weaknessKey);
  const { capabilityWeaknesses } = await import('../selfmodel/capabilities.ts');
  // Judged on the running release where it has its own sample, so a failure the release already fixed raises no repair.
  lastCapabilityGaps = await capabilityWeaknesses(now, [...detected.map((w) => w.key), ...open], new Date(processStartedAt)).catch((error: unknown) => {
    console.warn(`capability assessment failed: ${String((error as Error)?.message ?? error)}`);
    return [];
  });
  // AUTO-20-1: the work nobody told Brain to look for — live goals held by the same gaps for days,
  // bins failing the same way, capacity idle beside waiting work, openings closing unpursued, and a
  // resource several opportunities wait on. Same unit, same loop, same hourly cadence as the maps.
  const { originatedWeaknesses } = await import('../selfmodel/originate.ts');
  const origination = await originatedWeaknesses(now, [...detected, ...lastCapabilityGaps].map((w) => w.key)).catch((error: unknown) => ({
    weaknesses: [],
    errors: [`origination: ${String((error as Error)?.message ?? error).slice(0, 200)}`],
  }));
  lastOriginated = origination.weaknesses;
  return { ...cached(), errors: origination.errors };
}

/**
 * Whether an attempt's decision says its method was tried and did not work (§87, invariant 16):
 * kept without effect, or reverted. HELD waited on a person or a Factory stop, REJECTED was
 * refused on evidence and COMBINED folded into another candidate — none of those ran the method to
 * an outcome, so none is evidence that the method was inadequate. The one predicate every
 * method-inadequacy judgment in this loop reads.
 */
export function isFailedMethod(decision: string | null | undefined): boolean {
  return decision === 'KEPT_NO_EFFECT' || decision === 'REVERTED';
}

/** The candidates of one weakness family (`KEY`, `KEY#2`, …), newest attempt last. */
async function family(baseKey: string): Promise<ImprovementCandidate[]> {
  return (await listCandidates()).filter((c) => c.weaknessKey === baseKey || c.weaknessKey.startsWith(`${baseKey}#`)).sort((a, b) => a.attempt - b.attempt);
}

/** Record what was seen: a new candidate, a refreshed one, a new attempt, or a combination. */
/**
 * How a caller may register outside the detector's defaults: an experiment (§111) writes its
 * marker with the row, and its members are never combined into another candidate — siblings of
 * one experiment share an owner on purpose.
 */
export interface RegisterOptions {
  evidence?: Record<string, unknown>;
  noCombine?: boolean;
}

async function register(weakness: Weakness, now: Date, report: ImprovementTickReport, options: RegisterOptions = {}): Promise<void> {
  const members = await family(weakness.key);
  const latest = members.at(-1);
  let attempt = 1;
  let parentId: string | null = null;
  if (latest) {
    if (!latest.decision) {
      const refreshed = toInput(weakness, latest.attempt, latest.parentId, latest.weaknessKey);
      await upsertCandidate({ ...refreshed, evidence: { ...refreshed.evidence, ...(options.evidence ?? {}) } });
      return;
    }
    // Decided: the weakness persisting is a new attempt only after the record has had time to show it —
    // except a weakness combined into another candidate, which is free the moment its host's change is
    // delivered: the host's objective may not have reached it (production, 2026-11-04: Factory fixed the
    // citation parser in #482 and nothing about unreadable sources), and the detector says whether it persists.
    if (latest.attempt >= MAX_ATTEMPTS) return;
    const since = now.getTime() - Date.parse(latest.updatedAt);
    const host = latest.decision === 'COMBINED' && latest.combinedIntoId ? await getCandidate(latest.combinedIntoId) : null;
    const hostDelivered = Boolean(host && (host.deliveredAt || host.decision));
    if (!hostDelivered && since < RECUR_AFTER_HOURS * HOUR) return;
    attempt = latest.attempt + 1;
    parentId = latest.id;
  }
  const key = attempt === 1 ? weakness.key : `${weakness.key}#${attempt}`;
  const input = toInput(weakness, attempt, parentId, key);
  const evidence: Record<string, unknown> = { ...input.evidence, ...(options.evidence ?? {}) };
  // §87 (AUTO-20-1): a weakness that persists after an attempt that was kept without effect, or reverted,
  // is evidence that the method was inadequate, not that it needs running again. The judgment is
  // made from the earlier attempts' own recorded decisions and stored on the candidate, so the
  // next objective asks for a different method and names what was tried.
  const inadequate = members.filter((m) => isFailedMethod(m.decision));
  let methodInadequacy: { judgment: string; failedAttempts: number[] } | null = null;
  // AUTO-20-1: work Brain originated carries the judgment that made an observation into work, and an
  // observation that says an earlier repair did not move the objective is a method judged inadequate.
  const { isOriginated } = await import('../selfmodel/originate.ts');
  if (isOriginated(weakness)) {
    evidence['origination'] = weakness.origination;
    if (weakness.origination.methodInadequate) methodInadequacy = { judgment: weakness.origination.methodInadequate, failedAttempts: [] };
  }
  if (attempt > 1 && inadequate.length > 0) {
    methodInadequacy = {
      judgment:
        `Attempt(s) ${inadequate.map((m) => m.attempt).join(', ')} ended ${inadequate.map((m) => m.decision).join(', ')} ` +
        'and the weakness still shows in the rows: the method used was inadequate for this cause. ' +
        'Change the method (the approach, the owner of the behaviour, or the measure), do not re-run it.',
      failedAttempts: inadequate.map((m) => m.attempt),
    };
    Object.assign(evidence, {
      methodInadequacy,
      researchQuestion: `${String(evidence['researchQuestion'] ?? weakness.title)} Earlier methods did not work (attempt ${methodInadequacy.failedAttempts.join(', ')}); find a different class of method.`,
    });
  }
  if (methodInadequacy && !evidence['methodInadequacy']) evidence['methodInadequacy'] = methodInadequacy;
  const { candidate, created } = await upsertCandidate({ ...input, evidence });
  if (!created) return;
  report.opened.push(candidate.weaknessKey);
  await recordImprovementEvent({
    candidateId: candidate.id,
    kind: 'WEAKNESS_DETECTED',
    detail: {
      key: candidate.weaknessKey,
      frequency: weakness.frequency,
      denominator: weakness.denominator,
      samples: weakness.samples,
      attempt,
      ...(methodInadequacy ? { methodInadequacy } : {}),
      ...(evidence['origination'] ? { origination: evidence['origination'] } : {}),
    },
  });
  // Combine: one owner, one objective. A weakness on a component whose candidate
  // has not yet been sent to Factory joins it rather than racing it.
  // A gap handed to a non-software owner carries its own rows (needs, openings) to that owner: folding it
  // into another candidate would leave those rows with nobody (S-0249).
  const open = executionRouteOf(candidate) || options.noCombine
    ? []
    : (await listCandidates({ open: true })).filter(
        (c) => c.id !== candidate.id && !isRecordOnly(c) && c.ownerComponent === candidate.ownerComponent && !c.changeRequestId && !executionRouteOf(c) && c.createdAt <= candidate.createdAt,
      );
  const host = open[0];
  if (host) {
    const joined = [...((host.evidence['combined'] as string[] | undefined) ?? []), candidate.weaknessKey];
    await patchCandidate(host.id, { evidence: { ...host.evidence, combined: joined, [`combined:${candidate.weaknessKey}`]: candidate.evidence } });
    await decideCandidate(candidate.id, 'COMBINED', `Combined into ${host.weaknessKey}: same owner (${host.ownerComponent}), not yet engineered.`, {
      combinedIntoId: host.id,
    });
    await recordImprovementEvent({ candidateId: candidate.id, kind: 'COMBINED', detail: { into: host.id } });
    report.decided.push(`${candidate.weaknessKey} COMBINED`);
  }
}

/** The origination an originated weakness carries, read without importing the originator. */
function originationOf(weakness: Weakness): Record<string, unknown> | null {
  const origination = (weakness as { origination?: unknown }).origination;
  return origination && typeof origination === 'object' ? (origination as Record<string, unknown>) : null;
}

/**
 * The non-software owner a candidate's gap belongs to (S-0249), from the route its originator
 * recorded: a connector, a commercial interaction, information, a watched fact or a person.
 * Null for every gap the Factory or method research may own.
 */
/** The experiment a register row belongs to (§111), if any: its parent row or one of its variants. */
export function experimentMemberOf(candidate: Pick<ImprovementCandidate, 'evidence'>): { experimentId: string; role: 'PARENT' | 'VARIANT'; variantId: string | null; adopted: boolean } | null {
  const value = candidate.evidence['experiment'] as { id?: unknown; role?: unknown; variantId?: unknown; adopted?: unknown } | undefined;
  if (!value || typeof value.id !== 'string' || (value.role !== 'PARENT' && value.role !== 'VARIANT')) return null;
  return { experimentId: value.id, role: value.role, variantId: typeof value.variantId === 'string' ? value.variantId : null, adopted: value.adopted === true };
}

export function executionRouteOf(candidate: Pick<ImprovementCandidate, 'evidence'>): {
  kind: 'INTEGRATION' | 'COMMERCIAL' | 'RESEARCH' | 'WATCH' | 'PERSON';
  owner: string;
  why: string;
  family: string;
  observed: string[];
} | null {
  const origination = candidate.evidence['origination'] as
    | { family?: unknown; observed?: unknown; handTo?: unknown; route?: { kind?: unknown; owner?: unknown; why?: unknown } }
    | undefined;
  const route = origination?.route;
  if (!route || typeof route.kind !== 'string' || typeof route.owner !== 'string') return null;
  if (!['INTEGRATION', 'COMMERCIAL', 'RESEARCH', 'WATCH', 'PERSON'].includes(route.kind)) return null;
  return {
    kind: route.kind as 'INTEGRATION' | 'COMMERCIAL' | 'RESEARCH' | 'WATCH' | 'PERSON',
    owner: route.owner,
    why: typeof route.why === 'string' ? route.why : '',
    family: typeof origination?.family === 'string' ? origination.family : '',
    // The rows the owner is handed: those the originator named for it, else those it observed.
    observed: (Array.isArray(origination?.handTo) ? origination.handTo : Array.isArray(origination?.observed) ? origination.observed : []).filter(
      (o): o is string => typeof o === 'string',
    ),
  };
}

/** The ref a hand-off to a non-software owner is recorded under (`deliveredRef`). */
export const OWNER_HANDOFF_PREFIX = 'OWNER:';

function toInput(weakness: Weakness, attempt: number, parentId: string | null, key: string) {
  return {
    weaknessKey: key,
    kind: weakness.kind,
    title: weakness.title,
    problem: weakness.problem,
    metric: weakness.metric,
    downstreamMetric: weakness.downstreamMetric,
    ownerComponent: weakness.ownerComponent,
    frequency: weakness.frequency,
    denominator: weakness.denominator,
    scope: weakness.scope,
    severity: weakness.severity,
    evidence: {
      samples: weakness.samples,
      mutationScope: weakness.mutationScope,
      researchQuestion: weakness.researchQuestion,
      knownCause: weakness.knownCause,
      observedAt: new Date().toISOString(),
      // The origination (and its execution route, S-0249) survives a re-registration of the same weakness.
      ...(originationOf(weakness) ? { origination: originationOf(weakness) } : {}),
    },
    attempt,
    parentId,
  };
}

/* ------------------------------------------------------------------------- */
/* The stage, from the linked rows                                            */
/* ------------------------------------------------------------------------- */

export interface Linked {
  research: { settled: boolean; acceptedClaims: number; status: string | null; claims: { claim: string; source: string | null }[] } | null;
  /**
   * `needsPerson` is the outcome's own word that the campaign stopped for a
   * person (its blocker names a person's action). It is carried onto the
   * FACTORY_BLOCKED event so the scoreboard can tell a gap a person had to
   * unblock from one Brain closed alone (AUTO-20-4).
   */
  factory: { state: string; detail: string; mergeSha: string | null; since: string; needsPerson: boolean; personAction: string | null } | null;
  archive: { claim: string; source: string | null; topic: string | null }[];
}

async function linked(candidate: ImprovementCandidate): Promise<Linked> {
  const db = getDb();
  let research: Linked['research'] = null;
  if (candidate.researchGoalId) {
    const packets = await db.all<{ id: string; status: string }>(
      'SELECT id, status FROM research_orchestrations WHERE goal_id = ? ORDER BY created_at',
      [candidate.researchGoalId],
    );
    const settled = packets.some((p) => ['COMPLETE', 'COMPLETE_WITH_GAPS', 'FAILED', 'NEEDS_HUMAN', 'CANCELLED'].includes(p.status));
    const goal = await db.get<{ state: string; expires_at: string }>('SELECT state, expires_at FROM russell_goals WHERE id = ?', [candidate.researchGoalId]);
    const expired = goal ? goal.state !== 'ACTIVE' || goal.expires_at <= new Date().toISOString() : true;
    const claims = packets.length
      ? await db.all<{ claim: string; source_url: string | null }>(
          `SELECT claim, source_url FROM research_claims
            WHERE accepted = 1 AND orchestration_id IN (${packets.map(() => '?').join(', ')}) ORDER BY created_at LIMIT 12`,
          packets.map((p) => p.id),
        )
      : [];
    research = {
      settled: settled || (expired && packets.every((p) => p.status !== 'RUNNING')),
      acceptedClaims: claims.length,
      status: packets.at(-1)?.status ?? (expired ? 'EXPIRED' : null),
      claims: claims.map((c) => ({ claim: c.claim, source: c.source_url })),
    };
  }
  let factory: Linked['factory'] = null;
  if (candidate.changeRequestId) {
    const { getCampaignByChangeRequest } = await import('../../repos/factory.ts');
    const campaign = await getCampaignByChangeRequest(candidate.changeRequestId);
    if (campaign) {
      const { objectiveOutcome } = await import('../factory/release/outcome.ts');
      const outcome = await objectiveOutcome(campaign);
      const { latestDelivery } = await import('../factory/delivery.ts');
      const delivery = campaign.state === 'COMPLETE' ? await latestDelivery(campaign.id) : null;
      factory = {
        state: outcome.status,
        detail: outcome.blocker ?? outcome.detail,
        mergeSha: outcome.release?.mergeSha ?? delivery?.mergeSha ?? null,
        since: campaign.updatedAt,
        needsPerson: outcome.needsPerson,
        personAction: outcome.personAction,
      };
    } else {
      factory = { state: 'BUILDING', detail: 'no campaign yet', mergeSha: null, since: candidate.updatedAt, needsPerson: false, personAction: null };
    }
  }
  const { methodClaimsAnswering } = await import('../research/methodRules.ts');
  const question = String(candidate.evidence['researchQuestion'] ?? candidate.title);
  const archive = await methodClaimsAnswering(question, ARCHIVE_OVERLAP_SHARE).catch(() => []);
  return { research, factory, archive };
}

export function stageOf(candidate: ImprovementCandidate, link: Linked, now: Date) {
  return deriveStage({
    decision: candidate.decision,
    researchGoalId: candidate.researchGoalId,
    research: link.research,
    archiveClaims: link.archive.length,
    knownCause: (candidate.evidence['knownCause'] as string | null | undefined) ?? null,
    changeRequestId: candidate.changeRequestId,
    factory: link.factory,
    deliveredAt: candidate.deliveredAt,
    windowClosed: candidate.deliveredAt !== null && now.getTime() - Date.parse(candidate.deliveredAt) >= MEASURE_WINDOW_HOURS * HOUR,
  });
}

/* ------------------------------------------------------------------------- */
/* Act                                                                        */
/* ------------------------------------------------------------------------- */

async function brainProject(): Promise<{ id: string; layerId: string | null } | null> {
  const { getProjectBySlug } = await import('../../repos/projects.ts');
  const project = await getProjectBySlug(BRAIN_PROJECT_SLUG);
  if (!project) return null;
  const { listLayers } = await import('../../repos/layers.ts');
  const layer = (await listLayers(project.id))[0];
  return { id: project.id, layerId: layer?.id ?? null };
}

/**
 * Open method research for a weakness: a research goal in brain-architecture, worked by Claude
 * routines and, once the activation gate is ACTIVE, by the free lane beside them (`activation.ts`).
 */
/**
 * Search existing capabilities before acquiring anything, and record it (AUTO-20-2 step 3).
 * The archive count is the one the stage decision read (`link.archive`). A search that cannot be
 * run or recorded throws, so the caller hands nothing to an owner this pass.
 */
async function searchFirst(candidate: ImprovementCandidate, link: Linked): Promise<{ archiveClaims: number; existing: ExistingMatch[] }> {
  const { searchBeforeAcquire } = await import('../selfmodel/gapLoopSync.ts');
  return searchBeforeAcquire(candidate, { archiveClaims: link.archive.length });
}

/** What the search found, as a sentence an assignment or objective carries. Pure. */
export function existingSentence(existing: readonly ExistingMatch[]): string {
  if (existing.length === 0) return 'A search of the system scan and the owner path found nothing that already does this. ';
  return `Already in Brain, found by searching before building (read these first and extend them rather than adding a second mechanism): ${existing
    .slice(0, 8)
    .map((e) => `${e.name} (${e.detail})`)
    .join('; ')}. `;
}

async function openResearch(candidate: ImprovementCandidate, now: Date, existing: readonly ExistingMatch[] = []): Promise<string> {
  const project = await brainProject();
  if (!project || !project.layerId) throw new Error('The brain-architecture project or its layer is missing.');
  const person = await improvementPerson();
  if (!person) throw new Error('No Brain administrator exists to own the research goal.');
  const { createResearchGoal } = await import('../../repos/russellAuthority.ts');
  const samples = ((candidate.evidence['samples'] as string[] | undefined) ?? []).map((s) => `- ${s}`).join('\n');
  const assignment =
    `Brain improvement research (not a commercial question). ${String(candidate.evidence['researchQuestion'] ?? candidate.title)}\n\n` +
    `The weakness, from Brain's own production rows: ${candidate.problem} It occurred ${candidate.frequency} time(s) ` +
    `out of ${candidate.denominator}. Recorded reasons:\n${samples}\n\n` +
    existingSentence(existing) +
    '\n\n' +
    'Find established, sourced methods (papers, standards, documented engineering practice) that would remove this ' +
    'class of failure for every future job, the evidence of how well each works, and the conditions under which it ' +
    'does not. Name what to measure to know it worked.';
  const goal = await createResearchGoal({
    projectId: project.id,
    ownerUserId: person.userId,
    createdByUserId: person.userId,
    name: `Improve: ${candidate.title}`.slice(0, 120),
    maxPackets: 1,
    maxFragments: 4,
    deadline: new Date(now.getTime() + RESEARCH_DAYS * 24 * HOUR).toISOString(),
    researchAssignment: assignment,
    researchLayerId: project.layerId,
  });
  return goal.id;
}

/** The engineering objective Factory receives: complete, evidenced, with acceptance conditions. */
export function composeObjective(
  candidate: ImprovementCandidate,
  link: Linked,
  history: ImprovementCandidate[],
  baseline: MetricReading,
  existing: readonly ExistingMatch[] | null = null,
) {
  const samples = ((candidate.evidence['samples'] as string[] | undefined) ?? []).slice(0, 5);
  const combined = (candidate.evidence['combined'] as string[] | undefined) ?? [];
  const methods = [...(link.research?.claims ?? []), ...link.archive].slice(0, 8);
  const earlier = history
    .filter((h) => h.id !== candidate.id && h.decision)
    .map((h) => `attempt ${h.attempt}: ${h.decision} — ${h.decisionReason ?? ''} (${h.proposal ?? 'no proposal recorded'})`.slice(0, 400));
  const metric = METRICS[candidate.metric];
  const downstream = candidate.downstreamMetric ? METRICS[candidate.downstreamMetric] : null;
  const scope = (candidate.evidence['mutationScope'] as string[] | undefined) ?? [`${candidate.ownerComponent}`, 'tests/**'];
  const objective =
    `BRAIN IMPROVEMENT (${candidate.weaknessKey}, attempt ${candidate.attempt}). ${candidate.problem} ` +
    `Measured in production: ${candidate.frequency} of ${candidate.denominator} (${metric.label} baseline ` +
    `${baseline.value === null ? 'not measured' : baseline.value} over ${baseline.numerator}/${baseline.denominator}). ` +
    (combined.length ? `It also covers ${combined.join(', ')} (same owner). ` : '') +
    `The owner of this behaviour is ${candidate.ownerComponent}; extend it, do not add a second mechanism. ` +
    (existing ? existingSentence(existing) : '') +
    (candidate.evidence['origination']
      ? `Brain originated this from its own observation of the rows (${String((candidate.evidence['origination'] as { family?: string }).family ?? '')}): ${String((candidate.evidence['origination'] as { judgment?: string }).judgment ?? '')} `
      : '') +
    (candidate.evidence['knownCause'] ? `Diagnosis from the rows: ${String(candidate.evidence['knownCause'])} ` : '') +
    directiveSentence(candidate) +
    `Recorded failure reasons, verbatim: ${samples.map((s) => JSON.stringify(s)).join('; ')}. ` +
    (methods.length
      ? `Accepted method research Brain holds that bears on it: ${methods.map((m) => `${m.claim} (${m.source ?? 'no source'})`).join(' | ')}. `
      : '') +
    (earlier.length ? `Earlier attempts on this weakness — do not repeat their strategy: ${earlier.join(' | ')}. ` : '') +
    (candidate.evidence['methodInadequacy']
      ? `Method judged inadequate by Brain: ${String((candidate.evidence['methodInadequacy'] as { judgment?: string }).judgment ?? '')} `
      : '') +
    'Make the smallest general change that removes the cause for every future job of this kind, with a test that ' +
    'reproduces the recorded failure class and passes after the change. Lower no evidence bar, gate or permission.';
  return {
    objective: objective.slice(0, 7900),
    expectedOutcome:
      `${metric.label} rises after deployment against the recorded baseline` +
      (downstream ? `, and ${downstream.label} does not fall` : '') +
      `; Brain's improvement loop measures both over the ${MEASURE_WINDOW_HOURS} h after deployment against the ` +
      'baseline and keeps, corrects or reverts the change. That measurement is Brain\'s, not a unit\'s: no unit should wait for it.' +
      directiveAfterReleaseSentence(candidate),
    nonGoals: [
      'Lowering, bypassing or reconfiguring the evidence gate, verification, audit or any permission.',
      'Any migration, dependency, secret, identity or deployment-configuration change.',
      'Fixing one job or one packet by hand; the change must apply to every future job of this kind.',
    ],
    acceptanceConditions: [
      {
        statement: `A test reproduces the recorded failure class (${candidate.weaknessKey.split('#')[0]}) and passes with the change.`,
        verification: 'npm test',
      },
      { statement: 'The repository typechecks and the impacted tests pass.', verification: 'npm run typecheck && npm run test:impacted' },
      ...directiveAcceptance(candidate),
      /*
       * No production-measurement condition here. Production, 2026-11-04: campaign
       * fcp_f648380f… blocked two units on "A03 is a post-deploy measurement and
       * cannot be satisfied by a commit" — a Factory unit can only satisfy what a
       * commit can. Brain measures after delivery itself (the expected outcome says so).
       */
    ],
    mutationScope: scope,
    // From the paths, not the prose: the prose says "production" (see riskForScope).
    riskClass: riskForScope(scope, RELEASE_EXCLUDED_PATHS),
  };
}

/**
 * The operator's directive on a candidate it commissioned (§109), as the objective states it:
 * the goal it serves, the benefit expected, the priority and why, and how the real effect is
 * judged. Empty for every candidate a detector raised.
 */
export interface Directive {
  origin: 'OPERATOR';
  runId: string | null;
  goalId: string | null;
  goalTitle: string | null;
  deficiency: string;
  intervention: string;
  expectedBenefit: string;
  acceptance: string;
  priority: number;
  urgency: string;
  priorityWhy: string;
  complexity: string;
  minimumModelClass: 'STRONGEST' | 'FAST';
  routeWhy: string;
  evaluation: string;
  /**
   * The operator asked a question (`commissionResearch` with no goal), not for a change. Its answer
   * is the method research itself, so it closes when that research settles and never becomes a
   * Factory objective (OPERATOR:MISSING_CAPABILITY:aed45eeb30f0ec42). Absent on older rows.
   */
  question?: boolean;
}

export function directiveOf(candidate: Pick<ImprovementCandidate, 'evidence'>): Directive | null {
  const value = candidate.evidence['directive'];
  return value && typeof value === 'object' && (value as { origin?: unknown }).origin === 'OPERATOR' ? (value as Directive) : null;
}

/**
 * Whether a candidate is a research question the operator asked rather than a defect to repair.
 * Explicit on new rows (`directive.question`); older rows are recognised by the exact shape
 * `commissionResearch` gives a goal-less question — an EVIDENCE directive, a `Research: ` title, no
 * owner path and no known cause — so a question already in the register is not engineered either.
 * Pure.
 */
export function isResearchQuestion(candidate: Pick<ImprovementCandidate, 'evidence' | 'title'>): boolean {
  const d = directiveOf(candidate);
  if (!d || d.intervention !== 'EVIDENCE') return false;
  if (d.question === true) return true;
  const paths = candidate.evidence['ownerPaths'];
  const noOwner = !Array.isArray(paths) || paths.length === 0;
  return noOwner && !candidate.evidence['knownCause'] && candidate.title.startsWith('Research: ');
}

/**
 * How a research question closes once its method research has settled, or null while it has not
 * (or when the candidate is not a question). The answer is the research: accepted claims answer
 * it; none means research found no supported answer, which engineering cannot supply either.
 * Either way no Factory objective is opened for it. Pure.
 */
export function questionClosure(candidate: Pick<ImprovementCandidate, 'evidence' | 'title' | 'researchGoalId'>, link: Pick<Linked, 'research' | 'archive'>): string | null {
  if (!isResearchQuestion(candidate) || !candidate.researchGoalId || !link.research?.settled) return null;
  const answered = link.research.acceptedClaims + link.archive.length;
  return answered > 0
    ? `Answered by method research ${candidate.researchGoalId} (${link.research.acceptedClaims} accepted claim(s), ${link.archive.length} from the archive): the operator asked a question, and its answer is the research, so there is nothing to engineer.`
    : `Method research ${candidate.researchGoalId} ended ${link.research.status ?? 'without a result'} with no accepted claim; the operator asked a question, and a code change cannot answer it, so no Factory objective is opened.`;
}

/**
 * The answer a settled research question closes with, as the operator reads and cites it: every
 * accepted claim the research produced and every archive claim that already answered it, each with
 * its source. Closing a question records this on the decision itself, so the answer is a row the
 * asker can read rather than something that existed only while the loop held it in memory
 * (OPERATOR:MISSING_CAPABILITY:aed45eeb30f0ec42). Pure; nothing is invented when there is none.
 */
export function questionAnswer(link: Pick<Linked, 'research' | 'archive'>): { claim: string; source: string | null }[] {
  const seen = new Set<string>();
  const out: { claim: string; source: string | null }[] = [];
  for (const one of [...(link.research?.claims ?? []), ...link.archive]) {
    const key = `${one.claim}\u0000${one.source ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ claim: one.claim, source: one.source });
  }
  return out;
}

/** The decision reason a closed question carries: the closure, then its answer claim by claim with each source. */
export function questionDecisionReason(closure: string, answer: { claim: string; source: string | null }[]): string {
  if (!answer.length) return closure.slice(0, 1000);
  const body = answer.map((one, i) => `(${i + 1}) ${one.claim}${one.source ? ` [${one.source}]` : ' [no source]'}`).join(' ');
  return `${closure} Answer: ${body}`.slice(0, 1000);
}

function directiveSentence(candidate: ImprovementCandidate): string {
  const d = directiveOf(candidate);
  if (!d) return '';
  return (
    `Commissioned by Brain's operator${d.runId ? ` (run ${d.runId})` : ''} as a ${d.deficiency} deficiency` +
    (d.goalId ? ` holding back goal ${d.goalId}${d.goalTitle ? ` ("${d.goalTitle.slice(0, 120)}")` : ''}` : '') +
    `. Expected benefit: ${d.expectedBenefit} Priority ${d.priority} (${d.urgency}): ${d.priorityWhy}. ` +
    `How its real effect is judged: ${d.evaluation} ` +
    (d.minimumModelClass === 'STRONGEST' ? `${ROUTING_MARKER} (${d.routeWhy}) ` : '')
  );
}

/**
 * A clause that only a reading taken after release can establish: "the next ENGINEERING_CYCLE
 * reading after release shows …", "production shows …", "the next attempt names …". A commit
 * cannot satisfy it and no test command can check it.
 */
const AFTER_RELEASE_CLAUSE =
  /\b(after (release|deploy(ment)?)|in production|production shows|on production|the next [\w .-]{0,60}?\b(reading|readings|rounds?|attempts?|runs?|plan reading)\b)/i;

/**
 * The operator's acceptance statement divided into what a commit can satisfy and what only Brain's
 * own post-release measurement can (repair-F3, campaign fcp_34a9e4b0…: an operator acceptance "The
 * next ENGINEERING_CYCLE reading after release shows DEVELOPMENT's median lower …" became condition
 * A03 "checked by: npm run test:impacted", which no commit can meet, so the review left it
 * unverified). Clauses are the statement's `;`-separated parts. A clause naming a test is always a
 * commit's, whatever it says about production; anything not recognised as post-release stays a
 * commit condition, so nothing is dropped from what a unit must meet. Pure.
 */
export function splitDirectiveAcceptance(statement: string): { commit: string | null; afterRelease: string[] } {
  const clauses = statement
    .split(/;\s+/)
    .map((c) => c.trim().replace(/[.;]+$/, ''))
    .filter(Boolean);
  const commit: string[] = [];
  const afterRelease: string[] = [];
  for (const clause of clauses) {
    const namesTest = /\b(a|the) test\b|\btests?\b (show|shows|reproduce|reproduces|feeds|prove|proves)/i.test(clause);
    (namesTest || !AFTER_RELEASE_CLAUSE.test(clause) ? commit : afterRelease).push(clause);
  }
  return { commit: commit.length ? `${commit.join('; ')}.` : null, afterRelease };
}

function directiveAcceptance(candidate: ImprovementCandidate): { statement: string; verification: string }[] {
  const d = directiveOf(candidate);
  const commit = d ? splitDirectiveAcceptance(d.acceptance).commit : null;
  return commit ? [{ statement: commit.slice(0, 600), verification: 'npm run test:impacted' }] : [];
}

/** The operator's post-release acceptance, as Brain's own measurement in the expected outcome; '' when none. */
function directiveAfterReleaseSentence(candidate: ImprovementCandidate): string {
  const d = directiveOf(candidate);
  const after = d ? splitDirectiveAcceptance(d.acceptance).afterRelease : [];
  return after.length ? ` Brain also reads after release, as its own measurement and not a unit's: ${after.join('; ')}.` : '';
}

/**
 * Register a weakness the operator diagnosed (§109) — the same register, the same family rules,
 * the same combination by owner as a detector's — and return its live candidate.
 */
export async function registerDirected(
  weakness: Weakness,
  now = new Date(),
  options: RegisterOptions = {},
): Promise<{ candidate: ImprovementCandidate; created: boolean; report: ImprovementTickReport }> {
  const report: ImprovementTickReport = { ran: true, reason: 'directed', detected: 1, opened: [], advanced: [], decided: [], alerts: [], errors: [] };
  await register(weakness, now, report, options);
  const members = await family(weakness.key);
  const latest = members.at(-1);
  if (!latest) throw new Error('The directed candidate was not registered.');
  return { candidate: latest, created: report.opened.length > 0, report };
}

/**
 * Advance one candidate now, outside the ten-minute tick: an authorized assignment is admitted
 * the moment it exists (§109). The same `advance` the tick runs, with the same one-objective-per-
 * owner rule, so a candidate whose owner is busy waits for the tick exactly as it would anyway.
 */
export async function advanceNow(candidateId: string, now = new Date()): Promise<{ did: string | null; report: ImprovementTickReport }> {
  const report: ImprovementTickReport = { ran: true, reason: 'directed', detected: 0, opened: [], advanced: [], decided: [], alerts: [], errors: [] };
  const state = await improvementSwitch();
  if (!state.enabled) return { did: 'not advanced: the improvement order is switched off', report };
  const candidate = await getCandidate(candidateId);
  if (!candidate || candidate.decision || isRecordOnly(candidate)) return { did: null, report };
  const open = await listCandidates({ open: true });
  const busyOwners = new Set(open.filter((c) => c.id !== candidate.id && c.changeRequestId && !c.deliveredAt).map((c) => c.ownerComponent));
  const did = await advance(candidate, busyOwners, now, report);
  if (did) report.advanced.push(`${candidate.weaknessKey}: ${did}`);
  return { did, report };
}

/**
 * The operator's re-attempt (§109, Surge B H2-5): the next attempt of a weakness family now,
 * rather than after `RECUR_AFTER_HOURS`, because the operator read that its campaign stalled or
 * failed. The same family rules as `register` — at most `MAX_ATTEMPTS`, keyed `KEY#n`, the parent
 * named, the earlier attempts' failure stated so the objective asks for a different method
 * (invariant 16) — and the latest attempt must already be decided. Returns the new row, or why not.
 */
export async function registerNextAttempt(
  latestId: string,
  input: { reason: string; evidence: Record<string, unknown> },
): Promise<{ ok: true; candidate: ImprovementCandidate } | { ok: false; reason: string }> {
  const latest = await getCandidate(latestId);
  if (!latest) return { ok: false, reason: 'no register row has that id' };
  const base = latest.weaknessKey.split('#')[0]!;
  const members = await family(base);
  const newest = members.at(-1)!;
  if (newest.id !== latest.id) return { ok: false, reason: `a later attempt already exists: ${newest.weaknessKey} (${newest.id})` };
  if (!latest.decision) return { ok: false, reason: 'the latest attempt is not decided; it must be closed before the next one starts' };
  if (latest.attempt >= MAX_ATTEMPTS) return { ok: false, reason: `attempt ${latest.attempt} of ${MAX_ATTEMPTS} was the last: a failing improvement cannot loop` };
  const attempt = latest.attempt + 1;
  // Only an attempt whose method ran to an outcome and did not work is named as a failed method; an
  // attempt HELD on a person or a Factory stop is stated as what it was, not as an inadequate method.
  const failed = members.filter((m) => isFailedMethod(m.decision));
  const reattempt = {
    reason: input.reason.slice(0, 400),
    priorDecisions: members.filter((m) => m.decision).map((m) => ({ attempt: m.attempt, decision: m.decision })),
  };
  const methodInadequacy =
    failed.length > 0
      ? {
          judgment:
            `Attempt(s) ${failed.map((m) => m.attempt).join(', ')} ended ${failed.map((m) => m.decision).join(', ')}; the operator started this attempt: ` +
            `${reattempt.reason} Change the method (the approach, the owner of the behaviour, or the measure), do not re-run it.`,
          failedAttempts: failed.map((m) => m.attempt),
        }
      : null;
  // The caller may pass an earlier attempt's whole evidence (the director does), which can carry
  // that attempt's own method judgment. A judgment belongs to the attempt it was made for: this
  // attempt's is the one just made from the family's decisions, or none, never an inherited one.
  const { methodInadequacy: _inherited, ...carried } = input.evidence;
  const { candidate, created } = await upsertCandidate({
    weaknessKey: `${base}#${attempt}`,
    kind: latest.kind,
    title: latest.title,
    problem: latest.problem,
    metric: latest.metric,
    downstreamMetric: latest.downstreamMetric,
    ownerComponent: latest.ownerComponent,
    frequency: latest.frequency,
    denominator: latest.denominator,
    scope: latest.scope,
    severity: latest.severity,
    evidence: { ...carried, reattempt, ...(methodInadequacy ? { methodInadequacy } : {}), observedAt: new Date().toISOString() },
    attempt,
    parentId: latest.id,
  });
  if (!created) return { ok: false, reason: `${candidate.weaknessKey} was registered by another caller first` };
  await recordImprovementEvent({
    candidateId: candidate.id,
    kind: 'WEAKNESS_DETECTED',
    detail: { key: candidate.weaknessKey, attempt, parentId: latest.id, reattempt, ...(methodInadequacy ? { methodInadequacy } : {}), by: 'operator re-attempt' },
  });
  return { ok: true, candidate };
}

export async function brainFactoryProject(): Promise<string | null> {
  const row = await getDb().get<{ project_id: string }>(
    "SELECT project_id FROM factory_project_repositories WHERE grant_id = 'brain' ORDER BY created_at LIMIT 1",
    [],
  );
  return row?.project_id ?? null;
}

/** Send the engineering to Factory: submit, approve on the standing order, start, and grant a LOW-risk release. */
async function engineer(candidate: ImprovementCandidate, link: Linked, now: Date, existing: readonly ExistingMatch[]): Promise<string> {
  return submitEngineering(candidate, link, now, existing, { release: true });
}

/**
 * One variant of an experiment (§111) to Factory: the same objective, baseline, dependency
 * check, approval on the standing order and campaign as `engineer` — and no release grant, so
 * the variant ends at a pull request and the evaluator decides which one is released.
 */
export async function submitExperimentVariant(
  candidateId: string,
  preamble: string,
  now = new Date(),
): Promise<{ ok: boolean; did: string; changeRequestId: string | null; campaignId: string | null }> {
  const candidate = await getCandidate(candidateId);
  if (!candidate || candidate.decision) return { ok: false, did: 'no live register row', changeRequestId: null, campaignId: null };
  if (candidate.changeRequestId) {
    return { ok: Boolean(candidate.campaignId), did: 'already submitted', changeRequestId: candidate.changeRequestId, campaignId: candidate.campaignId };
  }
  const state = await improvementSwitch();
  if (!state.enabled) return { ok: false, did: 'not submitted: the improvement order is switched off', changeRequestId: null, campaignId: null };
  const link: Linked = { research: null, factory: null, archive: [] };
  const did = await submitEngineering(candidate, link, now, [], { release: false, preamble });
  const fresh = (await getCandidate(candidateId))!;
  return { ok: Boolean(fresh.campaignId), did, changeRequestId: fresh.changeRequestId, campaignId: fresh.campaignId };
}

/**
 * The LOW-risk release grant on the owner's standing improvement order, exactly as the loop
 * gives it: only LOW risk, and only when a person last set the switch.
 */
export async function grantStandingRelease(changeRequestId: string, riskClass: string, executedByRef = 'improvement-loop'): Promise<{ granted: boolean; detail: string }> {
  const person = await improvementPerson();
  if (riskClass !== 'LOW' || !person?.setByPerson) return { granted: false, detail: `released by a person (risk ${riskClass})` };
  const { authorizeAutomaticRelease } = await import('../factory/release/grant.ts');
  await authorizeAutomaticRelease({
    changeRequestId,
    userId: person.userId,
    channel: 'SHELL',
    executedByRef,
    reason: `Owner's standing improvement order (set by ${person.email}): Factory merges, deploys and verifies LOW-risk Brain improvements.`,
    liveChecks: [{ kind: 'HTTP', path: '/healthz', expectStatus: 200 }],
  });
  return { granted: true, detail: 'automatic release granted (LOW risk)' };
}

/**
 * Whether a mutation scope can hold a change to behaviour: at least one entry is a repository path
 * that is not a test. A scope of nothing but `tests/**` (a diagnosis that named no owner path) or a
 * component label such as `operator:CAPABILITY_BELOW_TARGET` cannot — production, 2026-11-16:
 * fcp_351dce2b and fcp_344f15e6 were submitted with `["tests/**"]`, and every architect session
 * (twenty, ten per plan bin) correctly answered that no plan fits, until both plan bins were spent
 * and read as waiting for a person.
 */
export function scopeCarriesAChange(scope: readonly string[]): boolean {
  return scope.some((entry) => {
    const path = entry.trim();
    if (!path || path.includes(':') || path.startsWith('/') || path.includes('..')) return false;
    return !/(^|\/)(tests?|__tests__)\//.test(path) && !/\.(test|spec)\.[^/]*$/.test(path);
  });
}

async function submitEngineering(
  candidate: ImprovementCandidate,
  link: Linked,
  now: Date,
  existing: readonly ExistingMatch[],
  options: { release: boolean; preamble?: string },
): Promise<string> {
  const projectId = await brainFactoryProject();
  if (!projectId) throw new Error('No project holds the Brain repository grant for Factory.');
  const baseline = await readMetric(candidate.metric, new Date(now.getTime() - BASELINE_HOURS * HOUR).toISOString(), now.toISOString());
  const downstreamBaseline = candidate.downstreamMetric
    ? await readMetric(candidate.downstreamMetric, new Date(now.getTime() - BASELINE_HOURS * HOUR).toISOString(), now.toISOString())
    : null;
  const { laneCoverage } = await import('../freeLane/coverage.ts');
  const displaced = await laneCoverage(now).then((c) => c.displaced).catch(() => ({}));
  const dependency = dependencyCheckFor(
    { ownerComponent: candidate.ownerComponent, metric: candidate.metric, downstreamMetric: candidate.downstreamMetric, kind: candidate.kind },
    displaced,
  );
  const verdict = checkDependencies(dependency);
  if (!verdict.complete) throw new Error(`The dependency check is incomplete: ${verdict.missing.join(' ')}`);
  const history = await family(candidate.weaknessKey.split('#')[0]!);
  const composed = composeObjective(candidate, link, history, baseline, existing);
  const spec = options.preamble ? { ...composed, objective: `${options.preamble} ${composed.objective}`.slice(0, 7900) } : composed;
  if (!scopeCarriesAChange(spec.mutationScope)) {
    /*
     * Not sent to Factory: an objective whose only writable paths are tests cannot remove the cause
     * it describes, so its plan bin can only be spent on honest refusals. The owner of the behaviour
     * is named first (the operator commissions again with owner_paths, or a diagnosis that names
     * them), and then it is engineered.
     */
    const heldOn =
      `the owner of the behaviour is not named: the mutation scope ${JSON.stringify(spec.mutationScope)} holds no path ` +
      'outside tests, so no plan can change the behaviour. Commission it again with owner_paths naming the files that produce it.';
    await decideCandidate(candidate.id, 'HELD', `Not sent to Factory: ${heldOn}`, { heldOn: heldOn.slice(0, 300) });
    await recordImprovementEvent({
      candidateId: candidate.id,
      kind: 'DECIDED',
      detail: { decision: 'HELD', needsPerson: false, reason: 'SCOPE_HOLDS_NO_OWNER_PATH', mutationScope: spec.mutationScope },
    });
    return `held: ${heldOn}`;
  }
  const { submitObjective } = await import('../factory/contract.ts');
  const submitted = await submitObjective({
    projectId,
    ...spec,
    repositoryRemote: BRAIN_REPOSITORY_REMOTE,
    baseBranch: 'production',
    submissionKey: `improvement:${candidate.id}`,
  });
  await patchCandidate(candidate.id, {
    changeRequestId: submitted.changeRequest.id,
    proposal: spec.objective.slice(0, 2000),
    dependencyCheck: dependency as unknown as Record<string, unknown>,
    baseline: { primary: baseline, downstream: downstreamBaseline, at: now.toISOString() },
  });
  await recordImprovementEvent({
    candidateId: candidate.id,
    kind: 'BASELINE_RECORDED',
    detail: { primary: baseline, downstream: downstreamBaseline },
  });
  const { approveAndStartCampaign } = await import('../factory/start.ts');
  const started = await approveAndStartCampaign({ changeRequestId: submitted.changeRequest.id, improvementGrant: true });
  if (!started.ok) {
    await recordImprovementEvent({ candidateId: candidate.id, kind: 'FACTORY_NOT_STARTED', detail: { reason: started.reason } });
    return `submitted ${submitted.changeRequest.id}, not started: ${started.reason}`;
  }
  await patchCandidate(candidate.id, { campaignId: started.campaign.id });
  const release = options.release
    ? (await grantStandingRelease(started.changeRequest.id, started.changeRequest.riskClass)).detail
    : 'no release grant: an experiment variant ends at a pull request and the evaluator decides (§111)';
  await recordImprovementEvent({
    candidateId: candidate.id,
    kind: 'ENGINEERING_SUBMITTED',
    detail: { changeRequestId: submitted.changeRequest.id, campaignId: started.campaign.id, risk: started.changeRequest.riskClass, release },
  });
  return `${submitted.changeRequest.id} → ${started.campaign.id} (${release})`;
}

/** Measure after delivery, and decide. */
async function measureAndDecide(candidate: ImprovementCandidate, now: Date, report: ImprovementTickReport): Promise<void> {
  const delivered = Date.parse(candidate.deliveredAt!);
  const to = new Date(Math.min(now.getTime(), delivered + BASELINE_HOURS * HOUR)).toISOString();
  const after = await readMetric(candidate.metric, candidate.deliveredAt!, to);
  const afterDown = candidate.downstreamMetric ? await readMetric(candidate.downstreamMetric, candidate.deliveredAt!, to) : null;
  // The verdict compares with the period right before delivery: anything else that changed the
  // owner between submission and delivery is then already in the baseline. The submission-time
  // baseline stays on the row as the record of what the weakness was when it was chosen.
  const beforeFrom = new Date(delivered - BEFORE_WINDOW_HOURS * HOUR).toISOString();
  const before = await readMetric(candidate.metric, beforeFrom, candidate.deliveredAt!);
  const beforeDown = candidate.downstreamMetric ? await readMetric(candidate.downstreamMetric, beforeFrom, candidate.deliveredAt!) : null;
  const primary = compare(before, after);
  const downstream = beforeDown && afterDown ? compare(beforeDown, afterDown) : null;
  const hoursSinceDelivery = (now.getTime() - delivered) / HOUR;
  const measured = decideAfterMeasurement({ primary, downstream, hoursSinceDelivery });
  const handedOpenings = await readHandedOpenings(candidate, now);
  const decision = handedOpenings ? judgeHandedOpenings(measured, handedOpenings, hoursSinceDelivery) : measured;
  const result = { before, beforeDownstream: beforeDown, after, afterDownstream: afterDown, primary, downstream, handedOpenings, at: now.toISOString() };
  await patchCandidate(candidate.id, { result });
  if (!decision.decision) return;
  // A hand-off to a non-software owner merged nothing, so there is nothing to revert: the decision retires it.
  if (decision.revert && !candidate.deliveredRef?.startsWith(OWNER_HANDOFF_PREFIX)) {
    await submitRevert(candidate, decision.reason, now).catch(async (error: unknown) => {
      await recordImprovementEvent({ candidateId: candidate.id, kind: 'REVERT_NOT_SUBMITTED', detail: { error: String((error as Error).message ?? error).slice(0, 300) } });
    });
  }
  await decideCandidate(candidate.id, decision.decision, decision.reason, { result });
  await recordImprovementEvent({ candidateId: candidate.id, kind: 'DECIDED', detail: { decision: decision.decision, reason: decision.reason, primary, downstream } });
  report.decided.push(`${candidate.weaknessKey} ${decision.decision}`);
}

/**
 * The openings a MISSED_OPPORTUNITY hand-off gave the cash lifecycle, and what became of each, read from
 * production at measurement time (repair-F1). The hand-off's premise is that the lifecycle re-decides them
 * before their window closes; whether that happened is a reading of their states, not an assumption.
 * "Unpursued" is the origination's own definition (`selfmodel/originate.ts` UNPURSUED): a re-decision that
 * holds an opening (e.g. "buyer not yet named") leaves it unpursued, so a recomputed decision is not progress.
 */
export const UNPURSUED_OPENING_STATES: ReadonlySet<string> = new Set(['DISCOVERED', 'EVIDENCE_CARD', 'READY']);

export interface HandedOpening {
  id: string;
  stateAtHandOff: string;
  expiresAt: string | null;
}

export interface HandedOpeningsOutcome {
  handed: number;
  /** Left the unpursued states: the lifecycle moved it towards execution. */
  pursued: number;
  /** Still unpursued and its window is open: nothing is settled about it yet. */
  stillOpen: number;
  /** Its window ended while it was still unpursued: the failure class the gap names. */
  expiredUnpursued: number;
  /** The row is gone. */
  missing: number;
  basis: string;
}

/** What became of the handed openings, from their current rows. Pure. */
export function handedOpeningsOutcome(
  handed: readonly HandedOpening[],
  current: ReadonlyMap<string, { state: string; expiresAt: string | null } | null>,
  now: Date,
): HandedOpeningsOutcome {
  let pursued = 0;
  let stillOpen = 0;
  let expiredUnpursued = 0;
  let missing = 0;
  for (const one of handed) {
    const row = current.get(one.id);
    if (!row) {
      missing += 1;
      continue;
    }
    if (!UNPURSUED_OPENING_STATES.has(row.state)) {
      pursued += 1;
      continue;
    }
    const ends = row.expiresAt ?? one.expiresAt;
    if (ends && Date.parse(ends) <= now.getTime()) expiredUnpursued += 1;
    else stillOpen += 1;
  }
  const basis =
    `${pursued} of ${handed.length} handed opening(s) left ${[...UNPURSUED_OPENING_STATES].join('/')}; ` +
    `${expiredUnpursued} expired still unpursued, ${stillOpen} still open and unpursued, ${missing} missing`;
  return { handed: handed.length, pursued, stillOpen, expiredUnpursued, missing, basis };
}

/**
 * A MISSED_OPPORTUNITY hand-off is kept as effective only if at least one handed opening was actually
 * pursued. A rise in the loop's metric with every handed opening still unpursued is something else's
 * doing, so the hand-off had no effect; a regression or a pending reading is left as measured. Pure.
 *
 * While a handed opening is still open and unpursued the KEPT is withheld, but only for the same
 * MEASURE_MAX_HOURS any reading gets (review finding R2-F1). An undated opening never expires, so
 * "wait until every window has ended" alone would leave the candidate in DECIDE forever and its
 * weakness never released for a different strategy. Past that bound the hand-off has had its full
 * measurement window and moved nothing, which is KEPT_NO_EFFECT.
 */
export function judgeHandedOpenings(
  measured: ReturnType<typeof decideAfterMeasurement>,
  outcome: HandedOpeningsOutcome,
  hoursSinceDelivery: number,
): ReturnType<typeof decideAfterMeasurement> {
  if (outcome.handed === 0 || outcome.pursued > 0) {
    return measured.decision ? { ...measured, reason: `${measured.reason} Handed openings: ${outcome.basis}.` } : measured;
  }
  if (measured.decision !== 'KEPT') return measured;
  if (outcome.stillOpen > 0 && hoursSinceDelivery < MEASURE_MAX_HOURS) {
    return { decision: null, reason: `${measured.reason} Not yet kept: ${outcome.basis}.`, revert: false };
  }
  const waited = outcome.stillOpen > 0 ? ` after ${Math.round(hoursSinceDelivery)} h` : '';
  return {
    decision: 'KEPT_NO_EFFECT',
    reason:
      `${measured.reason} But ${outcome.basis}${waited}: the hand-off moved none of the openings it was made for, ` +
      'so the change in the metric is not its effect and the weakness stays eligible for a different strategy.',
    revert: false,
  };
}

/** The candidate's handed openings with their current production rows, or null when it handed none. */
async function readHandedOpenings(candidate: ImprovementCandidate, now: Date): Promise<HandedOpeningsOutcome | null> {
  const raw = candidate.evidence['handedOpenings'];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const handed = raw.filter(
    (h): h is HandedOpening => typeof h === 'object' && h !== null && typeof (h as HandedOpening).id === 'string',
  );
  if (handed.length === 0) return null;
  const { getOpportunity } = await import('../../repos/cashPortfolio.ts');
  const current = new Map<string, { state: string; expiresAt: string | null } | null>();
  for (const one of handed) {
    const row = await getOpportunity(one.id);
    current.set(one.id, row ? { state: row.state, expiresAt: row.expiresAt ?? null } : null);
  }
  return handedOpeningsOutcome(handed, current, now);
}

/** One revert objective per regressed change; it is never retried by the loop. */
async function submitRevert(candidate: ImprovementCandidate, why: string, now: Date): Promise<void> {
  const projectId = await brainFactoryProject();
  if (!projectId || !candidate.deliveredRef) throw new Error('Nothing to revert: no merge recorded.');
  const { submitObjective } = await import('../factory/contract.ts');
  const scope = (candidate.evidence['mutationScope'] as string[] | undefined) ?? [candidate.ownerComponent, 'tests/**'];
  const submitted = await submitObjective({
    projectId,
    objective: `Revert the Brain improvement merged as ${candidate.deliveredRef} (${candidate.weaknessKey}): ${why} Restore the previous behaviour of ${candidate.ownerComponent} exactly, keeping any test that still describes it.`,
    expectedOutcome: `${METRICS[candidate.metric].label} returns to its baseline; Brain records the result.`,
    nonGoals: ['Any other change.'],
    acceptanceConditions: [
      { statement: `The changes of ${candidate.deliveredRef} to ${candidate.ownerComponent} are reverted and the test suite passes.`, verification: 'npm run typecheck && npm run test:impacted' },
    ],
    mutationScope: scope,
    repositoryRemote: BRAIN_REPOSITORY_REMOTE,
    baseBranch: 'production',
    submissionKey: `improvement-revert:${candidate.id}`,
  });
  const { approveAndStartCampaign } = await import('../factory/start.ts');
  await approveAndStartCampaign({ changeRequestId: submitted.changeRequest.id, improvementGrant: true });
  await recordImprovementEvent({ candidateId: candidate.id, kind: 'REVERT_SUBMITTED', detail: { changeRequestId: submitted.changeRequest.id, at: now.toISOString() } });
}

/**
 * Value the next step for one candidate (AUTO-20-2 step 4, `selfmodel/gapValue.ts`): the options the
 * existing owners can carry out, each costed from the loop's own rows and this candidate's evidence.
 */
async function valueNextStep(
  candidate: ImprovementCandidate,
  link: Linked,
  stage: 'DIAGNOSE' | 'ENGINEER',
  found: { archiveClaims: number; existing: readonly ExistingMatch[] },
): Promise<ValueJudgment> {
  const { evaluateNextStep, readRouteHistory } = await import('../selfmodel/gapValue.ts');
  const { judgeCause } = await import('../selfmodel/gapLoopSync.ts');
  const earlier = (await family(candidate.weaknessKey.split('#')[0]!)).filter((m) => m.attempt < candidate.attempt);
  const knownCause = typeof candidate.evidence['knownCause'] === 'string' ? (candidate.evidence['knownCause'] as string) : null;
  return evaluateNextStep({
    stage,
    severity: candidate.severity,
    scope: candidate.scope,
    frequency: candidate.frequency,
    denominator: candidate.denominator,
    cause: judgeCause(candidate).cause,
    knownCause,
    archiveClaims: link.archive.length,
    existingOther: found.existing.filter((e) => !(e.kind === 'PATH' && e.name === candidate.ownerComponent)).length,
    research: candidate.researchGoalId ? { opened: true, settled: Boolean(link.research?.settled), acceptedClaims: link.research?.acceptedClaims ?? 0 } : null,
    // An attempt that was a hand-off to a non-software owner says nothing about how a Factory change or
    // research would fare; its failure is recorded as the route set aside (recordRouteSetAside).
    failedAttempts: earlier
      .filter((m) => isFailedMethod(m.decision) && !m.deliveredRef?.startsWith(OWNER_HANDOFF_PREFIX))
      .map((m) => ({ attempt: m.attempt, researched: Boolean(m.researchGoalId) })),
    history: await readRouteHistory(),
  });
}

/** Write the judgment as the gap's VALUE step, once per decision: a pass that reaches the same choice adds nothing. */
async function recordValue(candidate: ImprovementCandidate, judgment: ValueJudgment): Promise<void> {
  const { readGapLoop, recordGapStep } = await import('../selfmodel/gapLoop.ts');
  const { valueDetail } = await import('../selfmodel/gapValue.ts');
  const prior = (await readGapLoop(candidate.weaknessKey)).latest.VALUE?.detail;
  if (prior && prior['evaluated'] === true && prior['decision'] === judgment.chosen && prior['stage'] === judgment.stage) return;
  await recordGapStep({ gapKey: candidate.weaknessKey, step: 'VALUE', summary: `${judgment.chosen}: ${judgment.basis}`.slice(0, 400), detail: valueDetail(judgment) });
}

/**
 * Hand a gap to the non-software owner that acquires it (AUTO-20-2 step 5, S-0249).
 *
 * UNMET_NEED: the open needs go to the owner their typed cause names (`cash/needs.ts`
 * handNeedsToOwners): reconsideration reads the fact now and each blocked piece is re-decided.
 * MISSED_OPPORTUNITY: the openings still inside their window go back to the cash lifecycle,
 * which re-decides them. The hand-off is recorded as the delivery, so the loop measures the
 * candidate's metric before and after it like any other repair (step 6). A gap whose every
 * piece waits on a person is held for that person; a gap whose rows all settled closes.
 */
async function handToOwner(
  candidate: ImprovementCandidate,
  route: NonNullable<ReturnType<typeof executionRouteOf>>,
  now: Date,
  report: ImprovementTickReport,
): Promise<string | null> {
  const { recordGapStep } = await import('../selfmodel/gapLoop.ts');
  const at = now.toISOString();
  // A hand-off counts only where the owner was given work: an idea the research pipeline runs, a live
  // dive, or the standing watch (S-0249: allocate actual workers and time, not a routed event).
  let handed = 0;
  let personOnly = false;
  const refused: string[] = [];
  const work: Record<string, unknown>[] = [];
  const handedOpenings: HandedOpening[] = [];
  if (route.family === 'UNMET_NEED') {
    const { handNeedsToOwners, handoffAllocated } = await import('../cash/needs.ts');
    const result = await handNeedsToOwners({ needIds: route.observed, gapKey: candidate.weaknessKey, actorRef: 'improvement loop', now: at });
    handed = result.handed.filter(handoffAllocated).length;
    personOnly = result.handed.length > 0 && result.handed.every((h) => h.route === 'PERSON');
    for (const one of result.handed) {
      work.push({ needId: one.needId, route: one.route, owner: one.owner, ...one.work });
      if (one.work.kind === 'REFUSED') refused.push(`${one.needId}: ${one.work.reason}`);
    }
  } else {
    const { getOpportunity } = await import('../../repos/cashPortfolio.ts');
    const { requestDecisionRecompute } = await import('../../repos/cashDecisions.ts');
    const { raiseNeed } = await import('../cash/needs.ts');
    const { startNeedWork } = await import('../cash/operate.ts');
    const family = candidate.weaknessKey.split('#')[0]!;
    for (const id of new Set(route.observed)) {
      const opening = await getOpportunity(id);
      if (!opening || (opening.expiresAt && opening.expiresAt <= at)) continue;
      // The opening's missing facts become one need with a worker on it, so the lifecycle has something
      // to re-decide it on before its window closes, rather than only a recompute request.
      const by = opening.expiresAt ? ` before ${opening.expiresAt}` : '';
      const raised = await raiseNeed({
        projectId: opening.projectId,
        opportunityId: opening.id,
        actorRef: 'improvement loop',
        blockedAction: `Decide "${opening.title}"${by}`.slice(0, 300),
        whyItMatters: candidate.problem.slice(0, 600),
        recommendedPath: 'Research the facts its card still lacks from published sources, then let the cash lifecycle re-decide it.',
        setupEffort: 'one research mission',
        nextStep:
          `Establish from published sources, for this opening, who pays, what it pays, what it costs to deliver and what would rule it out${by}: ` +
          'the facts its card still lacks to be decided.',
        completionCondition: 'The opening is READY or later, or its window has ended.',
        requestKey: `gap:${family}:${opening.id}`,
      });
      if (!raised.ok) {
        refused.push(`${id}: ${raised.reason}`);
        continue;
      }
      const started = await startNeedWork(raised.value, 'RESEARCH');
      work.push({ opportunityId: id, ...started });
      if (started.kind === 'REFUSED') {
        refused.push(`${id}: ${started.reason}`);
        continue;
      }
      await requestDecisionRecompute(id, `GAP_ROUTED:${candidate.weaknessKey}`, at);
      handedOpenings.push({ id, stateAtHandOff: opening.state, expiresAt: opening.expiresAt ?? null });
      handed += 1;
    }
  }
  const basis = `${route.why}. Acquired by the existing owner ${route.owner} (${route.kind}), not by a Factory change or method research.`;
  await recordGapStep({
    gapKey: candidate.weaknessKey,
    step: 'VALUE',
    summary: `HAND_TO_OWNER: ${basis}`.slice(0, 400),
    detail: {
      evaluated: true,
      decision: 'HAND_TO_OWNER',
      chosen: `hand to ${route.owner} (${route.kind})`,
      alternatives:
        'a Factory change to the need or opening module and method research in brain-architecture: neither acquires a connector, a supplier, a payer, information or a watched fact, which is what the typed cause names',
      stage: 'ROUTE',
      route: route.kind,
      owner: route.owner,
      basis,
      handed,
    },
  });
  if (handed === 0 && refused.length > 0 && !personOnly) {
    // The owner could not be given work for any row: the route did not acquire anything, so it is set
    // aside (once) and the gap is valued like any other on the next pass, instead of being marked delivered.
    await recordRouteRefused(candidate, route, refused);
    return NOT_ALLOCATED;
  }
  if (handed === 0 && !personOnly) {
    const reason = `Every row this gap was noticed from (${route.observed.length}) has settled or its window has closed; there is nothing left for ${route.owner} to acquire.`;
    await decideCandidate(candidate.id, 'REJECTED', reason);
    await recordImprovementEvent({ candidateId: candidate.id, kind: 'DECIDED', detail: { decision: 'REJECTED', route: route.kind, owner: route.owner, reason } });
    report.decided.push(`${candidate.weaknessKey} REJECTED`);
    return 'rejected: the rows settled on their own';
  }
  if (personOnly) {
    const ask = `a person settles what ${route.owner} cannot grant itself: ${candidate.title}`;
    await decideCandidate(candidate.id, 'HELD', `${basis} Every piece waits on a person (${route.kind}).`.slice(0, 1000), { heldOn: ask.slice(0, 300) });
    await recordImprovementEvent({ candidateId: candidate.id, kind: 'DECIDED', detail: { decision: 'HELD', needsPerson: true, personAction: ask, route: route.kind, owner: route.owner } });
    report.decided.push(`${candidate.weaknessKey} HELD`);
    return 'held: only a person can settle it';
  }
  const ref = ownerHandoffRef(route);
  if (handedOpenings.length > 0) {
    // What was handed, so measureAndDecide reads what became of these openings rather than assuming it.
    const evidence = { ...candidate.evidence, handedOpenings: handedOpenings.slice(0, 50) };
    await patchCandidate(candidate.id, { evidence });
    candidate.evidence = evidence;
  }
  await patchCandidate(candidate.id, { deliveredAt: at, deliveredRef: ref });
  await recordImprovementEvent({
    candidateId: candidate.id,
    kind: 'DELIVERED',
    detail: { handedTo: route.owner, route: route.kind, handed, family: route.family, handedOpenings: handedOpenings.slice(0, 50), work: work.slice(0, 50), refused: refused.slice(0, 20) },
  });
  return `handed ${handed} row(s) to ${route.owner} (${route.kind})`;
}

/** handToOwner's answer when the owner could be given no work at all: the route is set aside and valuation runs. */
export const NOT_ALLOCATED = 'NOT_ALLOCATED' as const;

/** Record, once per candidate, that its execution route could allocate no work and was set aside. */
async function recordRouteRefused(
  candidate: ImprovementCandidate,
  route: NonNullable<ReturnType<typeof executionRouteOf>>,
  refused: readonly string[],
): Promise<void> {
  if (candidate.evidence['routeRefused']) return;
  const judgment =
    `Handing this gap to ${route.owner} (${route.kind}) could give no worker any of its rows (${refused.slice(0, 5).join('; ')}). ` +
    'A route that allocates nothing acquires nothing, so it is not recorded as delivered; the next step is valued among research, ' +
    'a Factory change to the owner of the behaviour, a credential or abandoning.';
  const routeRefused = { kind: route.kind, owner: route.owner, refused: refused.slice(0, 20), judgment };
  const evidence = { ...candidate.evidence, routeRefused };
  await patchCandidate(candidate.id, { evidence });
  candidate.evidence = evidence;
  await recordImprovementEvent({ candidateId: candidate.id, kind: 'ROUTE_SET_ASIDE', detail: routeRefused });
}

/** The ref a hand-off by one route is recorded under, so a later attempt can recognise the same route. */
export function ownerHandoffRef(route: Pick<NonNullable<ReturnType<typeof executionRouteOf>>, 'kind' | 'owner'>): string {
  return `${OWNER_HANDOFF_PREFIX}${route.kind}:${route.owner}`;
}

/**
 * The earlier attempts of this weakness that were handed to the same owner by the same route and were
 * then decided KEPT_NO_EFFECT or REVERTED: the record that this route was tried and did not work.
 */
export async function failedHandOffs(
  candidate: Pick<ImprovementCandidate, 'weaknessKey' | 'attempt'>,
  route: Pick<NonNullable<ReturnType<typeof executionRouteOf>>, 'kind' | 'owner'>,
): Promise<ImprovementCandidate[]> {
  const ref = ownerHandoffRef(route);
  return (await family(candidate.weaknessKey.split('#')[0]!)).filter(
    (m) => m.attempt < candidate.attempt && m.deliveredRef === ref && isFailedMethod(m.decision),
  );
}

/** Record, once per candidate, that its execution route was judged inadequate and set aside. */
async function recordRouteSetAside(
  candidate: ImprovementCandidate,
  route: NonNullable<ReturnType<typeof executionRouteOf>>,
  failed: readonly ImprovementCandidate[],
): Promise<void> {
  if (candidate.evidence['routeSetAside']) return;
  const judgment =
    `Handing this gap to ${route.owner} (${route.kind}) was already tried in attempt(s) ${failed.map((m) => m.attempt).join(', ')}, ` +
    `which ended ${failed.map((m) => m.decision).join(', ')}, and the weakness still shows: that route is inadequate for this cause. ` +
    'It is not re-run; the next step is valued among research, a Factory change to the owner of the behaviour (the routing included), a credential or abandoning.';
  const setAside = { kind: route.kind, owner: route.owner, ref: ownerHandoffRef(route), failedAttempts: failed.map((m) => m.attempt), judgment };
  const prior = candidate.evidence['methodInadequacy'] as { judgment?: string; failedAttempts?: number[] } | undefined;
  const methodInadequacy = {
    judgment: prior?.judgment ? `${prior.judgment} ${judgment}` : judgment,
    failedAttempts: [...new Set([...(prior?.failedAttempts ?? []), ...setAside.failedAttempts])].sort((a, b) => a - b),
  };
  const evidence = { ...candidate.evidence, routeSetAside: setAside, methodInadequacy };
  await patchCandidate(candidate.id, { evidence });
  candidate.evidence = evidence;
  await recordImprovementEvent({ candidateId: candidate.id, kind: 'ROUTE_SET_ASIDE', detail: setAside });
}

/** Advance one candidate by one step. Returns what it did, or null when it waited. */
async function advance(candidate: ImprovementCandidate, busyOwners: Set<string>, now: Date, report: ImprovementTickReport): Promise<string | null> {
  const link = await linked(candidate);
  const { stage } = stageOf(candidate, link, now);
  const last = (await listImprovementEvents({ candidateId: candidate.id, kinds: ['STAGE'], limit: 1 }))[0];
  if (!last || last.detail['stage'] !== stage) {
    await recordImprovementEvent({ candidateId: candidate.id, kind: 'STAGE', detail: { stage, from: last?.detail['stage'] ?? null } });
  }
  // An experiment's members are admitted and decided by the experiment (§111): its parent is never
  // engineered as one objective, and a variant is released only once the evaluator adopted it.
  const member = experimentMemberOf(candidate);
  if (member && !member.adopted && stage !== 'CLOSED') return null;
  switch (stage as Stage) {
    case 'DIAGNOSE':
    case 'ENGINEER': {
      // A question the operator asked is answered by its method research, never engineered: once that
      // research settles the row closes, so it does not come back to Factory as an engineering bin.
      const closure = questionClosure(candidate, link);
      if (closure) {
        // The answer is recorded with the decision, claim by claim with its source, so the operator whose
        // decision waited on the question reads and cites it from the register rather than from nowhere.
        const answer = questionAnswer(link);
        const d = directiveOf(candidate);
        await decideCandidate(candidate.id, 'REJECTED', questionDecisionReason(closure, answer));
        await recordImprovementEvent({
          candidateId: candidate.id,
          kind: 'DECIDED',
          detail: {
            decision: 'REJECTED',
            question: true,
            research: link.research?.status ?? null,
            researchGoalId: candidate.researchGoalId,
            acceptedClaims: link.research?.acceptedClaims ?? 0,
            askedIn: d?.runId ?? null,
            questionText: String(candidate.evidence['researchQuestion'] ?? candidate.title).slice(0, 600),
            answer,
          },
        });
        report.decided.push(`${candidate.weaknessKey} REJECTED`);
        return link.research && link.research.acceptedClaims + link.archive.length > 0 ? 'answered: research question closed' : 'closed: research found no answer';
      }
      // Reuse comes first (AUTO-20-2 step 3): what exists is searched and recorded before anything is valued or acquired.
      const found = await searchFirst(candidate, link);
      // A missing connector, supplier, payer, piece of information or watched fact is acquired by the owner
      // that already does that (S-0249), never turned into an engineering objective or method research.
      // Unless that very route already failed this weakness (S-0242): a hand-off that ended KEPT_NO_EFFECT or
      // REVERTED and is still showing is a method judged inadequate, and re-running it is what S-0242 forbids.
      // The route is set aside and the gap is valued like any other, so research or a Factory change to the
      // owner of the behaviour (the routing itself included) competes for it (step 4).
      const route = executionRouteOf(candidate);
      if (route && !candidate.evidence['routeRefused']) {
        const failed = await failedHandOffs(candidate, route);
        if (failed.length === 0) {
          const handedOff = await handToOwner(candidate, route, now, report);
          if (handedOff !== NOT_ALLOCATED) return handedOff;
        } else await recordRouteSetAside(candidate, route, failed);
      }
      // Then the next step is valued (step 4): every option the existing owners can carry out, compared on
      // expected value, cost, latency, opportunity cost and dependencies, and the best one is taken.
      const valued = await valueNextStep(candidate, link, stage as 'DIAGNOSE' | 'ENGINEER', found);
      // The operator's director already decided the intervention from the diagnosis (§109,
      // `decideIntervention`): engineering goes to Factory, evidence to method research. The
      // valuation is still recorded beside it, so a disagreement is visible in the gap loop.
      const directive = directiveOf(candidate);
      const directed =
        directive?.intervention === 'ENGINEERING' && stage === 'ENGINEER'
          ? 'FACTORY_CHANGE'
          : directive?.intervention === 'EVIDENCE' && !candidate.researchGoalId
            ? 'COMMISSION_RESEARCH'
            : null;
      const judgment: ValueJudgment = directed
        ? { ...valued, chosen: directed, basis: `Operator directive (${directive!.deficiency}, priority ${directive!.priority}): ${directed}. Brain's valuation chose ${valued.chosen}: ${valued.basis}`.slice(0, 1000) }
        : valued;
      const needsSlot = judgment.chosen === 'FACTORY_CHANGE' || judgment.chosen === 'REUSE_EXISTING';
      // One live engineering objective per owner component: a chosen change waits while another holds it.
      if (needsSlot && busyOwners.has(candidate.ownerComponent)) return null;
      await recordValue(candidate, judgment);
      switch (judgment.chosen) {
        case 'COMMISSION_RESEARCH': {
          const goalId = await openResearch(candidate, now, found.existing);
          await patchCandidate(candidate.id, { researchGoalId: goalId });
          await recordImprovementEvent({ candidateId: candidate.id, kind: 'RESEARCH_OPENED', detail: { goalId, archiveClaims: link.archive.length, value: judgment.basis } });
          return `research goal ${goalId} (Claude routines)`;
        }
        case 'FACTORY_CHANGE':
        case 'REUSE_EXISTING': {
          // Nothing is built before what exists has been searched; what it found goes into the objective.
          busyOwners.add(candidate.ownerComponent);
          return engineer(candidate, link, now, found.existing);
        }
        case 'ASK_CREDENTIAL': {
          const ask = `a person supplies the credential the rows say was refused: ${String(candidate.evidence['knownCause'] ?? '').slice(0, 200)}`;
          await decideCandidate(candidate.id, 'HELD', `Valued: ${judgment.basis} Held for one credential only a person holds (MISSING_AUTHORITY).`, { heldOn: ask.slice(0, 300) });
          await recordImprovementEvent({ candidateId: candidate.id, kind: 'DECIDED', detail: { decision: 'HELD', needsPerson: true, personAction: ask, value: judgment.basis } });
          report.decided.push(`${candidate.weaknessKey} HELD`);
          return 'held: one credential from a person';
        }
        case 'ABANDON': {
          // Research that settled with nothing supported and no diagnosis concludes honestly: no change.
          const reason =
            link.research && link.research.settled && link.research.acceptedClaims === 0 && link.archive.length === 0 && !candidate.evidence['knownCause']
              ? `Method research ended ${link.research.status ?? 'without a result'} with no accepted claim and the rows state no cause; no change is justified.`
              : `No option is expected to return more than it costs; no change is justified. ${judgment.basis}`;
          await decideCandidate(candidate.id, 'REJECTED', reason.slice(0, 1000));
          await recordImprovementEvent({ candidateId: candidate.id, kind: 'DECIDED', detail: { decision: 'REJECTED', research: link.research?.status ?? null, value: judgment.basis } });
          report.decided.push(`${candidate.weaknessKey} REJECTED`);
          return link.research?.settled ? 'rejected: research found nothing to build' : 'rejected: no option is worth its cost';
        }
      }
      return null;
    }
    case 'RESEARCHING':
      return null;
    case 'ENGINEERING': {
      const factory = link.factory!;
      if (factory.state === 'LIVE') {
        await patchCandidate(candidate.id, { deliveredAt: now.toISOString(), deliveredRef: factory.mergeSha ?? candidate.changeRequestId });
        await recordImprovementEvent({ candidateId: candidate.id, kind: 'DELIVERED', detail: { mergeSha: factory.mergeSha, detail: factory.detail } });
        // A delivered repair is re-checked on the next pass rather than at the hour (still after the boot grace).
        lastCapabilityAt = 0;
        lastObjectiveCheck = 0;
        return `delivered ${factory.mergeSha ?? ''}`.trim();
      }
      if (factory.state === 'CANCELLED') {
        await decideCandidate(candidate.id, 'HELD', `Factory ended without delivering: ${factory.detail}`, { heldOn: 'FACTORY_CANCELLED' });
        await recordImprovementEvent({ candidateId: candidate.id, kind: 'DECIDED', detail: { decision: 'HELD', factory } });
        report.decided.push(`${candidate.weaknessKey} HELD`);
        return 'held: Factory cancelled';
      }
      if (factory.state === 'BLOCKED') {
        const prior = (await listImprovementEvents({ candidateId: candidate.id, kinds: ['FACTORY_BLOCKED'], limit: 1 }))[0];
        if (!prior || prior.detail['detail'] !== factory.detail) {
          await recordImprovementEvent({ candidateId: candidate.id, kind: 'FACTORY_BLOCKED', detail: { detail: factory.detail, needsPerson: factory.needsPerson, personAction: factory.personAction } });
        } else if (now.getTime() - Date.parse(prior.at) >= BLOCKED_HOLD_HOURS * HOUR) {
          await decideCandidate(candidate.id, 'HELD', `Factory blocked for ${BLOCKED_HOLD_HOURS} h on: ${factory.detail}`, { heldOn: factory.detail.slice(0, 300) });
          await recordImprovementEvent({ candidateId: candidate.id, kind: 'DECIDED', detail: { decision: 'HELD', factory } });
          report.decided.push(`${candidate.weaknessKey} HELD`);
          return 'held on the Factory blocker';
        }
      }
      return null;
    }
    case 'MEASURING':
      return null;
    case 'DECIDE':
      await measureAndDecide(candidate, now, report);
      return 'measured';
    case 'CLOSED':
      return null;
  }
}

/* ------------------------------------------------------------------------- */
/* Quiet monitoring                                                           */
/* ------------------------------------------------------------------------- */

async function raiseAlerts(now: Date, open: ImprovementCandidate[], actionable: number, report: ImprovementTickReport): Promise<void> {
  const db = getDb();
  // A Brain-improvement bin a routine held or finished: its row moves when it is leased or completed.
  const work = await db.get<{ last: string | null }>(
    "SELECT MAX(updated_at) AS last FROM bins WHERE purpose = 'BRAIN_IMPROVEMENT' AND state IN ('LEASED', 'COMPLETE')",
    [],
  );
  const firstEvent = await db.get<{ first: string | null }>('SELECT MIN(at) AS first FROM improvement_events', []);
  const lastWork = work?.last ?? firstEvent?.first ?? null;
  const progress = await db.get<{ last: string | null }>(
    `SELECT MAX(at) AS last FROM improvement_events
      WHERE kind IN ('STAGE', 'RESEARCH_OPENED', 'ENGINEERING_SUBMITTED', 'DELIVERED', 'DECIDED', 'WEAKNESS_DETECTED')`,
    [],
  );
  const due = alertsDue({
    now: now.toISOString(),
    lastImprovementWorkAt: lastWork,
    actionableCandidates: actionable,
    lastProgressAt: progress?.last ?? null,
    openCandidates: open.length,
  });
  if (due.length === 0) return;
  const project = await brainProject();
  if (!project) return;
  const { askHuman } = await import('../../repos/russellMissions.ts');
  for (const alert of due) {
    // One request per episode: the resume key is the condition and when it began.
    const { created } = await askHuman({
      projectId: project.id,
      authorityNeeded: `Brain improvement ${alert.condition === 'IDLE_24H' ? 'workers idle' : 'process stalled'}`,
      whyNotRussell: alert.message,
      recommendation: 'Read `admin improvement show`; the loop keeps running and raises this once per episode.',
      choices: [{ key: 'ACKNOWLEDGE', label: 'Acknowledge', consequence: 'Closes this alert; a new episode raises a new one.' }],
      urgency: 'WHENEVER',
      resumeKey: `improvement-alert:${alert.condition}:${alert.episode}`,
    });
    if (created) {
      report.alerts.push(alert.condition);
      await recordImprovementEvent({ candidateId: null, kind: 'ALERT', detail: { condition: alert.condition, message: alert.message } });
    }
  }
}

/* ------------------------------------------------------------------------- */
/* The capability-gap record (AUTO-20-2)                                      */
/* ------------------------------------------------------------------------- */

/**
 * Write down, as capability-gap loop steps, what this pass and earlier ones did:
 * every candidate this pass ranked or opened, and every gap whose recorded loop
 * has not concluded — not integrated, not abandoned (`openGapLoops`) — so a pass after a restart or a lost
 * worker resumes the record from the rows rather than from anybody's memory.
 */
async function recordGapLoops(rankedIds: readonly string[], report: ImprovementTickReport): Promise<void> {
  try {
    const { syncCandidateGap } = await import('../selfmodel/gapLoopSync.ts');
    const { openGapLoops } = await import('../selfmodel/gapLoop.ts');
    const { getCandidateByKey } = await import('../../repos/improvement.ts');
    const { methodClaimsAnswering } = await import('../research/methodRules.ts');
    const seen = new Set<string>();
    const targets: ImprovementCandidate[] = [];
    const add = (c: ImprovementCandidate | null | undefined) => {
      if (c && !seen.has(c.id)) {
        seen.add(c.id);
        targets.push(c);
      }
    };
    for (const id of rankedIds) add(await getCandidate(id));
    for (const key of report.opened) add(await getCandidateByKey(key));
    for (const state of await openGapLoops(50)) add(await getCandidateByKey(state.gapKey));
    const written: string[] = [];
    for (const candidate of targets) {
      try {
        const question = String(candidate.evidence['researchQuestion'] ?? candidate.title);
        const steps = await syncCandidateGap(candidate, {
          archive: async () => (await methodClaimsAnswering(question, ARCHIVE_OVERLAP_SHARE).catch(() => [])).length,
        });
        written.push(...steps.map((step) => `${candidate.weaknessKey}:${step}`));
      } catch (error) {
        report.errors.push(`gap ${candidate.weaknessKey}: ${String((error as Error).message ?? error).slice(0, 200)}`);
      }
    }
    report.gapSteps = written;
  } catch (error) {
    report.errors.push(`gap loops: ${String((error as Error).message ?? error).slice(0, 200)}`);
  }
}

/* ------------------------------------------------------------------------- */
/* The tick                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Write a corrected method judgment onto the row it was read from. A live candidate is patched as
 * any refresh is. A decided one cannot be (`patchCandidate` refuses a decided row, so the record it
 * was decided on stays), yet a decided row is exactly where a mislabel is left standing when the
 * director decides an attempt HELD before re-attempting it (production, 2026-11-15: AUTO-20-1
 * episode 2). For it only the evidence is rewritten — never the decision, its reason or
 * `updated_at`, so the recurrence wait `register` reads from the decision is unchanged — guarded
 * on the decision it was read with. Returns whether a row changed, so an event is appended only
 * for a correction that happened and a second pass records nothing.
 */
async function writeCorrectedEvidence(candidate: ImprovementCandidate, evidence: Record<string, unknown>): Promise<boolean> {
  if (!candidate.decision && (await patchCandidate(candidate.id, { evidence }))) return true;
  const current = await getCandidate(candidate.id);
  if (!current?.decision) return false;
  const result = await getDb().run('UPDATE improvement_candidates SET evidence = ? WHERE id = ? AND decision = ?', [
    toJson(evidence),
    candidate.id,
    current.decision,
  ]);
  return Number(result.changes ?? 0) > 0;
}

/**
 * Correct a stored method-inadequacy judgment that names an attempt its own family did not decide as a
 * failed method (an operator re-attempt once counted HELD as failed). The current evidence is made
 * truthful — only the attempts decided KEPT_NO_EFFECT or REVERTED stay named, and a judgment left with
 * none moves to `reattempt` — while the original value is kept in an append-only event. Idempotent:
 * a corrected row names no such attempt, so a later pass changes nothing.
 */
export async function correctMisjudgedMethods(): Promise<string[]> {
  const all = await listCandidates();
  const corrected: string[] = [];
  for (const candidate of all) {
    const judged = candidate.evidence['methodInadequacy'] as { judgment?: unknown; failedAttempts?: unknown } | undefined;
    if (!judged || typeof judged !== 'object' || !Array.isArray(judged.failedAttempts) || judged.failedAttempts.length === 0) continue;
    const base = candidate.weaknessKey.split('#')[0]!;
    const members = all.filter((m) => m.weaknessKey === base || m.weaknessKey.startsWith(`${base}#`));
    const named = judged.failedAttempts.map(Number);
    const kept = named.filter((n) => isFailedMethod(members.find((m) => m.attempt === n)?.decision));
    if (kept.length === named.length) continue;
    const dropped = named.filter((n) => !kept.includes(n));
    const evidence: Record<string, unknown> = { ...candidate.evidence };
    const priorDecisions = members
      .filter((m) => m.attempt < candidate.attempt && m.decision)
      .map((m) => ({ attempt: m.attempt, decision: m.decision }));
    const prior = (evidence['reattempt'] as Record<string, unknown> | undefined) ?? {};
    evidence['reattempt'] = { ...prior, priorDecisions, judgment: typeof judged.judgment === 'string' ? judged.judgment : null };
    const origination = evidence['origination'] as { methodInadequate?: unknown } | undefined;
    if (kept.length > 0) {
      evidence['methodInadequacy'] = { ...judged, failedAttempts: kept };
    } else if (origination && typeof origination.methodInadequate === 'string' && origination.methodInadequate.trim()) {
      evidence['methodInadequacy'] = { judgment: origination.methodInadequate, failedAttempts: [] };
    } else {
      delete evidence['methodInadequacy'];
    }
    if (!(await writeCorrectedEvidence(candidate, evidence))) continue;
    await recordImprovementEvent({
      candidateId: candidate.id,
      kind: 'METHOD_JUDGMENT_CORRECTED',
      detail: {
        key: candidate.weaknessKey,
        original: judged,
        dropped: dropped.map((n) => ({ attempt: n, decision: members.find((m) => m.attempt === n)?.decision ?? null })),
        kept,
        reason: 'only an attempt decided KEPT_NO_EFFECT or REVERTED is a failed method',
      },
    });
    corrected.push(candidate.weaknessKey);
  }
  return corrected;
}

export async function improvementTick(now = new Date()): Promise<ImprovementTickReport> {
  const report: ImprovementTickReport = { ran: false, reason: '', detected: 0, opened: [], advanced: [], decided: [], alerts: [], errors: [] };
  // Whether the free lane may take this loop's research: evaluated on every pass, switch on or off,
  // so the state is current and a dependency that became ready activates it without anyone asking.
  try {
    const { evaluateActivation } = await import('./activation.ts');
    report.activation = (await evaluateActivation(now, 'TICK')).state;
  } catch (error) {
    report.errors.push(`activation: ${String((error as Error).message ?? error).slice(0, 200)}`);
  }
  // A stored judgment that misnames a HELD attempt as a failed method is a false record, not new
  // work: it is corrected on every pass, switch on or off, so the improvement order being off never
  // leaves a mislabel standing in the rows (AUTO-20-1 repair F3). It originates nothing, opens no
  // candidate and spends nothing; the correction keeps the original value in an append-only event.
  try {
    for (const key of await correctMisjudgedMethods()) report.advanced.push(`${key}: method judgment corrected`);
  } catch (error) {
    report.errors.push(`method judgments: ${String((error as Error).message ?? error).slice(0, 200)}`);
  }
  const state = await improvementSwitch();
  if (!state.enabled) {
    report.reason = 'switched off';
    return report;
  }
  report.ran = true;
  const detection = await detectAll(now);
  const weaknesses = detection.weaknesses;
  report.detected = weaknesses.length;
  report.originated = detection.originated;
  for (const error of detection.errors) report.errors.push(error);
  // §88: substantial live goals are checked against the capability maps, at most hourly.
  if (now.getTime() - processStartedAt >= CAPABILITY_BOOT_GRACE_MS && now.getTime() - lastObjectiveCheck >= OBJECTIVE_CHECK_MS) {
    lastObjectiveCheck = now.getTime();
    try {
      const { assessLiveObjectives } = await import('../selfmodel/objectives.ts');
      const checked = await assessLiveObjectives({ now, since: new Date(processStartedAt) });
      report.objectives = checked.filter((c) => c.recorded).map((c) => `${c.goalId}: ${c.assessment.ready ? 'ready' : c.assessment.blocking.map((g) => g.id).join(',')}`);
      // A gap that blocked a goal and no longer does is a repair that reached production:
      // the goal's plan is read and its search widened on the next goal pass, not in half an hour.
      const { requestGoalPlanPass } = await import('../goals/plan.ts');
      for (const one of checked.filter((c) => c.recorded && c.cleared.length > 0)) requestGoalPlanPass(one.goalId, one.cleared.join(','));
    } catch (error) {
      report.errors.push(`objectives: ${String((error as Error).message ?? error).slice(0, 200)}`);
    }
  }
  // SPRINT-18-5: the reasoning benchmark on held-out real openings, at most daily; a held-out loss
  // registers its weakness through `registerDirected`, the same path every weakness takes.
  try {
    const { sprintIfDue } = await import('./sprint.ts');
    const sprint = await sprintIfDue(now);
    if (sprint) {
      report.advanced.push(
        `reasoning sprint: ${sprint.sets.BENCHMARK}/${sprint.sets.HELD_OUT}/${sprint.sets.NEW_HELD_OUT} problems; ` +
          sprint.comparisons.map((c) => `${c.set} ${c.earned === null ? 'insufficient' : c.earned ? 'earned' : 'not earned'}`).join(', '),
      );
    }
  } catch (error) {
    report.errors.push(`sprint: ${String((error as Error).message ?? error).slice(0, 200)}`);
  }
  for (const weakness of weaknesses) {
    try {
      await register(weakness, now, report);
    } catch (error) {
      report.errors.push(`${weakness.key}: ${String((error as Error).message ?? error).slice(0, 200)}`);
    }
  }
  // A mission or an inventory finding is the operator's record, not the loop's work (RECORD_ONLY_KINDS).
  const open = (await listCandidates({ open: true })).filter((c) => !isRecordOnly(c));
  const decided = await listCandidates();
  const ranked = rankCandidates(
    open.map((c) => ({
      ...c,
      unlocks: c.downstreamMetric !== null,
      similarShipped: decided.some((d) => d.decision === 'KEPT' && d.kind === c.kind && d.id !== c.id),
    })),
  );
  // One live engineering objective per owner component: changes to one file do not race.
  const busyOwners = new Set(open.filter((c) => c.changeRequestId && !c.deliveredAt).map((c) => c.ownerComponent));
  let actionable = 0;
  for (const candidate of ranked) {
    try {
      const fresh = await getCandidate(candidate.id);
      if (!fresh || fresh.decision) continue;
      const did = await advance(fresh, busyOwners, now, report);
      if (did) report.advanced.push(`${fresh.weaknessKey}: ${did}`);
      const after = await getCandidate(candidate.id);
      if (after && !after.decision && !after.deliveredAt) actionable += 1;
    } catch (error) {
      const message = String((error as Error).message ?? error).slice(0, 300);
      report.errors.push(`${candidate.weaknessKey}: ${message}`);
      const prior = (await listImprovementEvents({ candidateId: candidate.id, kinds: ['ERROR'], limit: 1 }))[0];
      if (!prior || prior.detail['message'] !== message) {
        await recordImprovementEvent({ candidateId: candidate.id, kind: 'ERROR', detail: { message } });
      }
    }
  }
  await recordGapLoops(ranked.map((c) => c.id), report);
  try {
    await raiseAlerts(now, (await listCandidates({ open: true })).filter((c) => !isRecordOnly(c)), actionable, report);
  } catch (error) {
    report.errors.push(`alerts: ${String((error as Error).message ?? error).slice(0, 200)}`);
  }
  report.reason = `${report.detected} weakness(es), ${report.advanced.length} advanced, ${report.decided.length} decided`;
  return report;
}

/* ------------------------------------------------------------------------- */
/* The reading                                                                */
/* ------------------------------------------------------------------------- */

export interface ImprovementReading {
  switch: Awaited<ReturnType<typeof improvementSwitch>>;
  scoreboard: { window: string; metrics: MetricReading[] }[];
  failureClasses: { attempts: number; failures: { cls: string; n: number }[] };
  /** The other detectors' inputs (7 d), so a reader sees why each did or did not fire. */
  detectors: { claims: string; packets: string; owner: string; freeLaneRecent: string };
  candidates: Array<{
    key: string;
    title: string;
    stage: Stage;
    owner: string;
    next: string;
    decision: string | null;
    reason: string | null;
    baseline: number | null;
    after: number | null;
    verdict: string | null;
    links: string;
  }>;
  recent: string[];
  /** Open capability-gap loops (AUTO-20-2), as `formatGapLoop` prints them. */
  gapLoops: string[];
}

/** What `admin improvement show` prints: the scoreboard, the register and what happened. */
export async function improvementReading(now = new Date()): Promise<ImprovementReading> {
  const to = now.toISOString();
  const windows: [string, number][] = [['24h', 24], ['7d', 24 * 7]];
  const scoreboard = [];
  const { readScoreboard } = await import('./scoreboard.ts');
  for (const [label, hours] of windows) {
    const board = await readScoreboard(new Date(now.getTime() - hours * HOUR).toISOString(), to);
    scoreboard.push({ window: label, metrics: board.metrics });
  }
  const lane = await freeLaneFailures(new Date(now.getTime() - 24 * HOUR).toISOString(), to);
  const recentLane = await freeLaneFailures(new Date(now.getTime() - RECENT_WINDOW_HOURS * HOUR).toISOString(), to);
  const week = new Date(now.getTime() - 7 * 24 * HOUR).toISOString();
  const brief = (rows: { cls: string; n: number }[]) => rows.slice(0, 8).map((r) => `${r.cls}:${r.n}`).join(' ');
  const claims = await claimRejections(week, to);
  const packets = await packetOutcomes(week, to);
  const asks = await ownerInterventions(week, to);
  const detectors = {
    claims: `${claims.claims} claims; rejected ${brief(claims.rejections)}`,
    freeLaneRecent: `${recentLane.attempts} settled in ${RECENT_WINDOW_HOURS}h; ${brief(recentLane.failures)}`,
    packets: `${packets.settled} settled (cancelled excluded); ${brief(packets.causes)}`,
    owner: `${asks.total} requests; ${brief(asks.causes)}`,
  };
  const candidates = [];
  for (const c of await listCandidates()) {
    const link = await linked(c).catch(() => ({ research: null, factory: null, archive: [] }) as Linked);
    const stage = stageOf(c, link, now);
    const base = (c.baseline as { primary?: MetricReading } | null)?.primary ?? null;
    const result = c.result as { before?: MetricReading; after?: MetricReading; primary?: { verdict: string } } | null;
    candidates.push({
      key: c.weaknessKey,
      title: c.title,
      stage: stage.stage,
      owner: stage.owner,
      next: stage.next,
      decision: c.decision,
      reason: c.decisionReason,
      baseline: result?.before?.value ?? base?.value ?? null,
      after: result?.after?.value ?? null,
      verdict: result?.primary?.verdict ?? null,
      links: [c.researchGoalId, c.changeRequestId, c.campaignId, c.deliveredRef].filter(Boolean).join(' '),
    });
  }
  const recent = (await listImprovementEvents({ limit: 25 })).map((e) => `${e.at} ${e.kind} ${e.candidateId ?? ''} ${JSON.stringify(e.detail).slice(0, 240)}`);
  const { openGapLoops, formatGapLoop } = await import('../selfmodel/gapLoop.ts');
  const gapLoops = (await openGapLoops(10).catch(() => [])).flatMap(formatGapLoop);
  // The existing printer shows `recent`; the open gap loops ride there too, labelled.
  recent.push(...gapLoops.map((line) => `gap-loop ${line}`));
  return {
    switch: await improvementSwitch(),
    scoreboard,
    failureClasses: { attempts: lane.attempts, failures: lane.failures.map((f) => ({ cls: f.cls, n: f.n })) },
    detectors,
    candidates,
    recent,
    gapLoops,
  };
}

export { BRAIN_REPOSITORY_ID };
export type { MetricKey };

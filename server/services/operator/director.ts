/**
 * Hermes as Brain's engineering director (§109).
 *
 * The operator diagnoses a deficiency; this file turns the diagnosis into the
 * intervention it has earned and carries the result back. It owns no queue,
 * scheduler or worker:
 *
 *   DIAGNOSE   `readDeficiencies` — what the rows show is weak, already
 *              classified, so a small model chooses rather than discovers
 *   DECIDE     `decideIntervention` (pure) — engineering only when the cause is
 *              established, an owner is named and it recurred; otherwise a
 *              model, a strategy, evidence, capacity, a person, or a watch
 *   COMMISSION one `improvement_candidates` row (§87's register: one row per
 *              defect, so the same defect twice is one campaign) carrying the
 *              directive, advanced *now* — `submitObjective`,
 *              `approveAndStartCampaign` on the owner's standing order, the
 *              LOW-risk release grant — not at the next ten-minute tick
 *   PRIORITY   `engineeringPriority` (pure) from what the defect holds back,
 *              applied to the campaign's waiting bins only (`bins.priority`
 *              orders dispatch); a leased bin keeps what it has
 *   ROUTE      `routeEngineering` (pure): ARCHITECTURAL work is marked
 *              STRONGEST in the objective, which the planner holds every unit
 *              to and the scheduler refuses to give a FAST worker
 *   DELIVER    `engineeringOutcomes` — Factory's outcome, the code it changed,
 *              tests, merge, deploy, live verification, §87's measurement and
 *              decision, and the goal read again against the reading taken
 *              when the work was commissioned; `directorPass` records an
 *              `OPERATOR_ENGINEERING_OUTCOME` event on every change, which
 *              starts the next operator run early (`operatorTickIfDue`)
 *
 * Durable throughout: the candidate, its directive, the goal baseline and every
 * outcome are rows, so a restart, a failed worker, a model that stopped mid-run
 * or a deploy loses nothing — the next pass reads where it got to.
 */
import { createHash } from 'node:crypto';
import {
  compareGoal,
  decideIntervention,
  deficiencyKey,
  engineeringPriority,
  judgeEngineering,
  routeEngineering,
  verifiedCycle,
  improvementNotice,
  wakesOperator,
  type CycleFacts,
  DEFICIENCY_CLASSES,
  INTERVENTIONS,
  type DeficiencyClass,
  type Diagnosis,
  type EngineeringStatus,
  type GoalMark,
  type Intervention,
} from '../../domain/engineeringDirector.ts';
import { METRIC_KEYS, riskForScope, type MetricKey, type Weakness } from '../../domain/improvement.ts';
import { RELEASE_EXCLUDED_PATHS } from '../../domain/factoryRelease.ts';
import { getCandidate, listCandidates, listImprovementEvents, patchCandidate, recordImprovementEvent, type ImprovementCandidate } from '../../repos/improvement.ts';
import { recordEvent } from '../../repos/events.ts';
import { listProjects } from '../../repos/projects.ts';
import { getDb } from '../../db/database.ts';
import { recordOperatorLearning } from '../../repos/operator.ts';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

export const ENGINEERING_EVENTS = {
  commissioned: 'OPERATOR_ENGINEERING_COMMISSIONED',
  decided: 'OPERATOR_INTERVENTION_DECIDED',
  outcome: 'OPERATOR_ENGINEERING_OUTCOME',
  prioritized: 'OPERATOR_ENGINEERING_PRIORITIZED',
} as const;

/* ------------------------------------------------------------------------- */
/* Validation                                                                 */
/* ------------------------------------------------------------------------- */

const PATH = /^[A-Za-z0-9_./*-]{1,200}$/;

export interface DiagnosisRequest {
  goalId: string | null;
  deficiency: string;
  title: string;
  observed: string;
  evidence: string;
  cause: string | null;
  ownerPaths: string[];
  recurrence: number;
  expectedBenefit: string;
  acceptance: string;
  metric: string | null;
  blocksGoal: boolean;
  share: number | null;
  proposed: string | null;
  modelLimited?: boolean;
  personOnly?: boolean;
  capacityIdle?: boolean;
  runId: string | null;
  /** Brain's standing director commissioning in the operator's place (never Hermes identifying it). */
  standing?: boolean;
}

/** Why a diagnosis is too thin to act on, or null. The same bar `validateFix` set for a fix. */
export function validateDiagnosis(input: DiagnosisRequest): string | null {
  if (!(DEFICIENCY_CLASSES as readonly string[]).includes(input.deficiency)) return `deficiency must be one of ${DEFICIENCY_CLASSES.join(', ')}`;
  if (input.title.trim().length < 8) return 'title must say what is wrong in a few words';
  if (input.observed.trim().length < 40) return 'observed must describe the deficiency and its effect (40+ characters)';
  if (input.evidence.trim().length < 20) return 'evidence must cite rows (ids, verbatim reasons) from Brain';
  if (input.expectedBenefit.trim().length < 15) return 'expected_benefit must say what fixing it returns to the goal';
  if (input.acceptance.trim().length < 20) return 'acceptance must say what a test proves once it is fixed';
  if (input.ownerPaths.length > 8) return 'owner_paths names at most 8 files or globs';
  const bad = input.ownerPaths.find((one) => !PATH.test(one) || one.includes('..') || one.startsWith('/'));
  if (bad) return `owner path "${bad}" is not a repository-relative path`;
  if (input.metric !== null && !(METRIC_KEYS as readonly string[]).includes(input.metric)) return `metric must be one of ${METRIC_KEYS.join(', ')}`;
  if (input.proposed !== null && !(INTERVENTIONS as readonly string[]).includes(input.proposed)) return `intervention must be one of ${INTERVENTIONS.join(', ')}`;
  return null;
}

/** The metric a deficiency's real effect is measured on when the diagnosis names none. */
export function defaultMetric(deficiency: DeficiencyClass): MetricKey {
  switch (deficiency) {
    case 'ECONOMIC_REASONING':
    case 'PLANNING_ASSUMPTION':
    case 'REPEATED_STRATEGIC_MISTAKE':
      return 'READY_OPPORTUNITIES_PER_DAY';
    case 'RESOURCE_ALLOCATION':
    case 'INEFFICIENT_ALGORITHM':
      return 'OBJECTIVE_HOURS_MEDIAN';
    case 'BROKEN_INTEGRATION':
      return 'AUTO_RECOVERY_RATE';
    case 'MISSING_CAPABILITY':
      return 'RESEARCH_JOB_SUCCESS_RATE';
    case 'RECURRING_OPERATIONAL_FAILURE':
      return 'OWNER_INTERVENTIONS_PER_DAY';
  }
}

/* ------------------------------------------------------------------------- */
/* Reading a goal                                                             */
/* ------------------------------------------------------------------------- */

/** One reading of a goal from the operator's snapshot and the planner's stored reading. */
export async function goalMark(goalId: string | null): Promise<{ mark: GoalMark | null; title: string | null; projectId: string | null; remainingCents: number | null; daysLeft: number | null }> {
  if (!goalId) return { mark: null, title: null, projectId: null, remainingCents: null, daysLeft: null };
  const { operatorSnapshot } = await import('./snapshot.ts');
  const projectIds = (await listProjects()).map((p) => p.id);
  const snapshot = await operatorSnapshot(projectIds);
  const summary = snapshot.summaries.find((one) => one.id === goalId) ?? null;
  const view = snapshot.goals.find((one) => one.id === goalId) ?? null;
  if (!summary && !view) return { mark: null, title: null, projectId: null, remainingCents: null, daysLeft: null };
  const { readGoalPlanSummary } = await import('./actions.ts');
  const plan = await readGoalPlanSummary(goalId).catch(() => null);
  const forecast = (plan?.['forecast'] ?? null) as Record<string, unknown> | null;
  const ladder = (forecast?.['ladder'] ?? null) as Record<string, number> | null;
  const bestReach = typeof forecast?.['bestReach'] === 'number' ? (forecast['bestReach'] as number) : null;
  const requests = summary?.projectId ? (snapshot.requests.get(summary.projectId) ?? []) : [];
  const target = view?.target ?? null;
  // A light reading (Brain too busy to derive goals) still knows the money target and the deadline
  // from the register: read them there, so the priority is not computed as if nothing were at stake
  // (production 2026-11-12: imp_02321af4 got priority 3 on the $10K goal from a light reading).
  // What a light reading does not know — the derived state, blockers, what it waits on, settled
  // cash — is recorded as unknown, never as 0 or NOT_DERIVED, so a later full reading is not
  // compared against a placeholder.
  let registerRemaining: number | null = null;
  let registerDays: number | null = null;
  if (!view) {
    const { getWorkstream } = await import('../../repos/register.ts');
    const row = await getWorkstream(goalId).catch(() => null);
    const amount = (row?.target as { amountCents?: number } | null | undefined)?.amountCents ?? null;
    registerRemaining = typeof amount === 'number' && amount > 0 ? amount : null;
    registerDays = row?.dueAt ? Math.max(0, Math.ceil((Date.parse(row.dueAt) - Date.now()) / 86_400_000)) : null;
  }
  return {
    title: (view?.title ?? summary?.title ?? null)?.slice(0, 200) ?? null,
    projectId: view?.projectId ?? summary?.projectId ?? null,
    remainingCents: target ? target.remainingCents : registerRemaining,
    daysLeft: target ? target.daysLeft : registerDays,
    mark: {
      at: new Date().toISOString(),
      state: view?.state ?? null,
      waitingOn: view ? `${view.waiting.kind}: ${view.waiting.detail}`.slice(0, 200) : null,
      settledCents: target ? target.achievedCents : null,
      blockers: view ? view.blockers.length : null,
      verdict: typeof plan?.['verdict'] === 'string' ? (plan['verdict'] as string) : null,
      bestReachCents: bestReach === null ? null : Math.round(bestReach * 100),
      ladderAdvanced: ladder
        ? (ladder['C_MARKET_TEST_READY'] ?? 0) + (ladder['D_BUYER_VALIDATED'] ?? 0) + (ladder['E_COMMITTED'] ?? 0) + (ladder['F_COLLECTED'] ?? 0)
        : null,
      mootRequests: requests.filter((one) => one.moot).length,
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Commissioning                                                              */
/* ------------------------------------------------------------------------- */

export interface CommissionResult {
  ok: boolean;
  /** Brain's acknowledgement, in one sentence. */
  reason: string;
  intervention: Intervention;
  why: string;
  overruled: string | null;
  candidateId?: string;
  weaknessKey?: string;
  /** True when this defect was already commissioned: the same campaign is reported, not a second. */
  duplicate?: boolean;
  changeRequestId?: string | null;
  campaignId?: string | null;
  priority?: number;
  urgency?: string;
  route?: { complexity: string; minimumModelClass: string; why: string };
  /** What was done instead, for an intervention that is not engineering. */
  action?: string;
}

async function anchorProject(goalProjectId: string | null): Promise<string | null> {
  if (goalProjectId) return goalProjectId;
  return (await listProjects())[0]?.id ?? null;
}

/**
 * Commission the intervention a diagnosis has earned, and acknowledge it in the same call.
 *
 * Engineering is admitted immediately: the candidate is registered and advanced now, so
 * Factory has the objective, the campaign and the priority before this returns — or, when
 * the owner component already has a live objective (one per owner, §87), it is queued in
 * the register with that reason and the next tick admits it the moment the owner frees.
 */
export async function commission(input: DiagnosisRequest, now = new Date()): Promise<CommissionResult> {
  const invalid = validateDiagnosis(input);
  if (invalid) return { ok: false, reason: invalid, intervention: 'WATCH', why: invalid, overruled: null };
  const deficiency = input.deficiency as DeficiencyClass;
  const goal = await goalMark(input.goalId);
  const diagnosis: Diagnosis = {
    goalId: input.goalId,
    deficiency,
    title: input.title.trim().slice(0, 200),
    observed: input.observed.trim().slice(0, 2000),
    evidence: input.evidence.trim().slice(0, 2000),
    cause: input.cause?.trim() || null,
    ownerPaths: [...new Set(input.ownerPaths.map((p) => p.trim()).filter(Boolean))],
    recurrence: Math.max(1, Math.trunc(input.recurrence || 1)),
    expectedBenefit: input.expectedBenefit.trim().slice(0, 600),
    acceptance: input.acceptance.trim().slice(0, 600),
    metric: (input.metric as MetricKey | null) ?? defaultMetric(deficiency),
    blocksGoal: input.blocksGoal,
    share: input.share ?? (input.blocksGoal ? 0.5 : 0.05),
    proposed: (input.proposed as Intervention | null) ?? null,
    modelLimited: input.modelLimited === true,
    personOnly: input.personOnly === true,
    capacityIdle: input.capacityIdle === true,
    capacityTried: input.capacityIdle === true ? await capacityAlreadyTried(input.goalId) : false,
  };
  const decision = decideIntervention(diagnosis);
  const projectId = await anchorProject(await goalProject(input.goalId));
  if (projectId) {
    await recordEvent({
      projectId,
      entityType: 'PROJECT',
      entityId: projectId,
      eventType: ENGINEERING_EVENTS.decided,
      payload: { runId: input.runId, goalId: input.goalId, deficiency, title: diagnosis.title, intervention: decision.intervention, why: decision.why, overruled: decision.overruled },
    });
  }
  const base = { intervention: decision.intervention, why: decision.why, overruled: decision.overruled };
  switch (decision.intervention) {
    case 'ENGINEERING':
    case 'EVIDENCE':
      return engineerOrResearch(diagnosis, decision.intervention, input.runId, goal, base, now, input.standing === true);
    case 'CAPACITY': {
      const { continueIdleCapacity } = await import('./actions.ts');
      const moved = await continueIdleCapacity(input.runId);
      await learn(diagnosis, input.runId, `CAPACITY: continued idle pools (${JSON.stringify(moved['continued'] ?? []).slice(0, 200)}); engineering follows only if the work still waits.`);
      return { ok: true, reason: 'Continued idle capacity through its own scheduler; engineering is next if the work still waits.', ...base, action: 'continued idle capacity' };
    }
    case 'MODEL':
    case 'STRATEGY':
    case 'PERSON':
    case 'WATCH': {
      const what =
        decision.intervention === 'MODEL'
          ? "a better model or recipe on capacity Brain already has (the free switchboard, the RunPod GPU's recipes)"
          : decision.intervention === 'STRATEGY'
            ? 'a change of strategy, recorded so the next run pursues a different lever'
            : decision.intervention === 'PERSON'
              ? 'the person who holds it (reported in the run summary, rule 11)'
              : 'a watch: recorded, and engineered if it recurs';
      const learning = await learn(diagnosis, input.runId, `${decision.intervention}: ${decision.why}. Remedy: ${what}.`);
      return { ok: true, reason: `Not a coding assignment — ${decision.why}. Recorded for ${what}.`, ...base, action: `lesson ${learning}` };
    }
  }
}

async function goalProject(goalId: string | null): Promise<string | null> {
  if (!goalId) return null;
  const { operatorSnapshot } = await import('./snapshot.ts');
  const snapshot = await operatorSnapshot((await listProjects()).map((p) => p.id)).catch(() => null);
  return snapshot?.summaries.find((one) => one.id === goalId)?.projectId ?? null;
}

/**
 * Rows of one event type since a time, read project by project through
 * `idx_events_project_type (project_id, event_type, created_at)`. `project_events`
 * has no index that leads with `event_type`, so `WHERE event_type = ?` alone is a
 * scan of the whole table — and the operator tick asks on every Russell pass.
 */
async function eventsOfType(eventType: string, sinceIso: string, limitPerProject = 200): Promise<{ projectId: string; payload: string; createdAt: string }[]> {
  const out: { projectId: string; payload: string; createdAt: string }[] = [];
  for (const project of await listProjects()) {
    const rows = await getDb().all<{ payload: string; created_at: string }>(
      `SELECT payload, created_at FROM project_events
        WHERE project_id = ? AND event_type = ? AND created_at > ?
        ORDER BY created_at DESC LIMIT ?`,
      [project.id, eventType, sinceIso, limitPerProject],
    );
    for (const row of rows) out.push({ projectId: project.id, payload: row.payload, createdAt: row.created_at });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** Whether the operator already continued idle capacity for this goal's work in the last six hours. */
async function capacityAlreadyTried(goalId: string | null): Promise<boolean> {
  const since = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const rows = (await eventsOfType(ENGINEERING_EVENTS.decided, since, 20)).slice(0, 20);
  return rows.some((row) => {
    try {
      const p = JSON.parse(row.payload) as { intervention?: string; goalId?: string | null };
      return p.intervention === 'CAPACITY' && (p.goalId ?? null) === goalId;
    } catch {
      return false;
    }
  });
}

async function learn(d: Diagnosis, runId: string | null, lesson: string): Promise<string> {
  const row = await recordOperatorLearning({ goalId: d.goalId, runId, lesson: `${d.deficiency} — ${d.title}: ${lesson}`.slice(0, 1000), evidence: d.evidence.slice(0, 1000) });
  return row.id;
}

async function engineerOrResearch(
  d: Diagnosis,
  intervention: 'ENGINEERING' | 'EVIDENCE',
  runId: string | null,
  goal: Awaited<ReturnType<typeof goalMark>>,
  base: { intervention: Intervention; why: string; overruled: string | null },
  now: Date,
  standing = false,
): Promise<CommissionResult> {
  const scope = d.ownerPaths.length ? [...d.ownerPaths, 'tests/**'] : ['tests/**'];
  const risk = riskForScope(scope, RELEASE_EXCLUDED_PATHS);
  const { listCandidates: list } = await import('../../repos/improvement.ts');
  const everything = await list();
  // The same deficiency in the same owner files, registered earlier under any key (an older keying,
  // another goal), is this defect: it keeps that row's key, so it is never a second campaign.
  const owners = [...d.ownerPaths].sort().join(',');
  const earlier = owners
    ? everything.find((c) => {
        const directive = c.evidence['directive'] as { deficiency?: string } | undefined;
        const paths = c.evidence['ownerPaths'];
        return directive?.deficiency === d.deficiency && Array.isArray(paths) && [...(paths as string[])].sort().join(',') === owners;
      })
    : undefined;
  const key = earlier ? earlier.weaknessKey.split('#')[0]! : deficiencyKey(d, sha);
  const family = everything.filter((c) => c.weaknessKey === key || c.weaknessKey.startsWith(`${key}#`));
  const failedAttempts = family.filter((c) => c.decision === 'KEPT_NO_EFFECT' || c.decision === 'REVERTED').length;
  const priority = engineeringPriority({
    blocksGoal: d.blocksGoal,
    remainingCents: goal.remainingCents,
    daysLeft: goal.daysLeft,
    share: d.share,
    recurrence: d.recurrence,
    deficiency: d.deficiency,
  });
  const route = routeEngineering({ deficiency: d.deficiency, ownerPaths: d.ownerPaths, risk, failedAttempts, urgency: priority.urgency });
  const evaluation =
    `Brain's improvement loop measures ${d.metric} over the ${12} h after deployment against the 12 h before it and keeps, ` +
    `corrects or reverts the change; the operator then reads goal ${d.goalId ?? '(none)'} again against the reading taken now ` +
    `(${goal.mark ? `state ${goal.mark.state}, waiting ${goal.mark.waitingOn}, settled ${goal.mark.settledCents}c, best reach ${goal.mark.bestReachCents}c, ${goal.mark.mootRequests} moot request(s)` : 'no goal reading'}). ` +
    'A merged pull request is not counted as the improvement.';
  const weakness: Weakness = {
    key,
    kind: `OPERATOR:${d.deficiency}`,
    title: d.title,
    problem: `${d.observed} Expected benefit: ${d.expectedBenefit}`.slice(0, 2000),
    metric: d.metric,
    downstreamMetric: d.metric === 'READY_OPPORTUNITIES_PER_DAY' ? null : 'READY_OPPORTUNITIES_PER_DAY',
    ownerComponent: d.ownerPaths[0] ?? `operator:${d.deficiency}`,
    mutationScope: scope,
    frequency: d.recurrence,
    denominator: Math.max(d.recurrence, 1),
    scope: 'GENERAL',
    severity: priority.priority >= 7 ? 'HIGH' : priority.priority >= 4 ? 'MEDIUM' : 'LOW',
    researchQuestion: `${d.title}: ${d.observed}`.slice(0, 400),
    samples: d.evidence.split(/\n|;\s/).map((s) => s.trim()).filter(Boolean).slice(0, 8),
    knownCause: intervention === 'ENGINEERING' ? d.cause : null,
  };
  const { registerDirected, advanceNow } = await import('../improvement/loop.ts');
  const registered = await registerDirected(weakness, now);
  let candidate = registered.candidate;
  const duplicate = !registered.created && family.some((c) => c.id === candidate.id);
  const directive = {
    origin: standing ? ('STANDING_DIRECTOR' as const) : ('OPERATOR' as const),
    runId,
    goalId: d.goalId,
    goalTitle: goal.title,
    deficiency: d.deficiency,
    intervention,
    expectedBenefit: d.expectedBenefit,
    acceptance: d.acceptance,
    priority: priority.priority,
    urgency: priority.urgency,
    priorityWhy: priority.why,
    complexity: route.complexity,
    minimumModelClass: route.minimumModelClass,
    routeWhy: route.why,
    evaluation,
    // The inputs the priority is recomputed from on every director pass, as the goal moves.
    blocksGoal: d.blocksGoal,
    share: d.share,
    recurrence: d.recurrence,
  };
  if (candidate.decision === 'COMBINED' && candidate.combinedIntoId) {
    // Same owner, not yet engineered: the host carries it, and the host gets the directive.
    const host = await getCandidate(candidate.combinedIntoId);
    if (host) candidate = host;
  }
  if (!duplicate || !candidate.evidence['directive']) {
    await patchCandidate(candidate.id, {
      evidence: { ...candidate.evidence, directive, goalBaseline: goal.mark, ownerPaths: d.ownerPaths },
    });
  }
  const { did } = candidate.decision ? { did: null } : await advanceNow(candidate.id, now);
  const fresh = (await getCandidate(candidate.id))!;
  let applied = 0;
  if (fresh.campaignId) applied = await applyPriority(fresh.campaignId, priority.priority);
  const projectId = await anchorProject(await goalProject(d.goalId));
  if (projectId) {
    await recordEvent({
      projectId,
      entityType: 'PROJECT',
      entityId: projectId,
      eventType: ENGINEERING_EVENTS.commissioned,
      payload: {
        runId,
        goalId: d.goalId,
        candidateId: fresh.id,
        weaknessKey: fresh.weaknessKey,
        intervention,
        duplicate,
        changeRequestId: fresh.changeRequestId,
        campaignId: fresh.campaignId,
        researchGoalId: fresh.researchGoalId,
        priority: priority.priority,
        urgency: priority.urgency,
        route,
        advanced: did,
        binsReprioritized: applied,
      },
    });
  }
  await recordImprovementEvent({ candidateId: fresh.id, kind: 'OPERATOR_COMMISSIONED', detail: { runId, intervention, priority: priority.priority, route: route.complexity, advanced: did, duplicate } });
  const where = fresh.campaignId
    ? `Factory campaign ${fresh.campaignId} (change request ${fresh.changeRequestId})`
    : fresh.researchGoalId
      ? `method research goal ${fresh.researchGoalId}`
      : fresh.decision
        ? `decided ${fresh.decision}: ${fresh.decisionReason ?? ''}`
        : `registered as ${fresh.weaknessKey}; ${did ?? 'waits for its owner component to free (one live objective per owner)'}`;
  return {
    ok: true,
    reason: `${duplicate ? 'Already commissioned — the same campaign, not a second: ' : 'Acknowledged: '}${where}. Priority ${priority.priority} (${priority.urgency}); ${route.complexity} → ${route.minimumModelClass} workers.`,
    ...base,
    candidateId: fresh.id,
    weaknessKey: fresh.weaknessKey,
    duplicate,
    changeRequestId: fresh.changeRequestId,
    campaignId: fresh.campaignId,
    priority: priority.priority,
    urgency: priority.urgency,
    route,
  };
}

/**
 * Put a campaign's waiting work at the priority its defect earned. Waiting bins only: a
 * leased bin is in progress, and interrupting it would waste more than the reorder saves.
 */
export async function applyPriority(campaignId: string, priority: number): Promise<number> {
  const { reprioritizeWaitingCampaignBins } = await import('../../repos/bins.ts');
  return reprioritizeWaitingCampaignBins(campaignId, priority);
}

/**
 * Re-prioritize a commissioned defect (the operator changed its mind about what matters).
 * Recorded on the directive so every later bin the campaign creates inherits it.
 */
export async function reprioritize(input: { candidateId: string; priority: number; reason: string; runId: string | null }): Promise<{ ok: boolean; reason: string; binsReprioritized?: number }> {
  const candidate = await getCandidate(input.candidateId);
  if (!candidate || !candidate.evidence['directive']) return { ok: false, reason: 'no engineering the operator commissioned has that id' };
  if (candidate.decision) return { ok: false, reason: `already decided ${candidate.decision}` };
  if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 9) return { ok: false, reason: 'priority is a whole number 1..9' };
  if (input.reason.trim().length < 15) return { ok: false, reason: 'reason must say what changed (15+ characters)' };
  const directive: Record<string, unknown> = { ...(candidate.evidence['directive'] as Record<string, unknown>), priority: input.priority, priorityWhy: `re-prioritized: ${input.reason.trim().slice(0, 300)}` };
  await patchCandidate(candidate.id, { evidence: { ...candidate.evidence, directive } });
  const applied = candidate.campaignId ? await applyPriority(candidate.campaignId, input.priority) : 0;
  await recordImprovementEvent({ candidateId: candidate.id, kind: 'OPERATOR_REPRIORITIZED', detail: { priority: input.priority, reason: input.reason, runId: input.runId, bins: applied } });
  const projectId = await anchorProject(await goalProject((directive['goalId'] as string | null) ?? null));
  if (projectId) {
    await recordEvent({ projectId, entityType: 'PROJECT', entityId: projectId, eventType: ENGINEERING_EVENTS.prioritized, payload: { candidateId: candidate.id, priority: input.priority, reason: input.reason, runId: input.runId, bins: applied } });
  }
  return { ok: true, reason: `priority ${input.priority}; ${applied} waiting bin(s) reordered, leased work untouched`, binsReprioritized: applied };
}

/* ------------------------------------------------------------------------- */
/* The result, delivered back                                                 */
/* ------------------------------------------------------------------------- */

export interface EngineeringOutcome {
  candidateId: string;
  weaknessKey: string;
  title: string;
  goalId: string | null;
  deficiency: string;
  intervention: string;
  priority: number | null;
  stage: string;
  factory: {
    status: string | null;
    detail: string | null;
    prUrl: string | null;
    mergeSha: string | null;
    deployed: boolean;
    verified: boolean;
    /** The paths the delivered units own: which code was modified. */
    changedPaths: string[];
    /** Verification and review units: whether the tests and review passed. */
    tests: string;
  } | null;
  measurement: { metric: string; before: number | null; after: number | null; verdict: string | null } | null;
  decision: string | null;
  decisionReason: string | null;
  goal: { before: GoalMark | null; after: GoalMark | null; effect: string; reasons: string[] };
  status: EngineeringStatus;
  next: string;
  sentence: string;
}

async function factoryFacts(candidate: ImprovementCandidate): Promise<EngineeringOutcome['factory']> {
  if (!candidate.changeRequestId) return null;
  const { getCampaignByChangeRequest, listUnits } = await import('../../repos/factory.ts');
  const campaign = await getCampaignByChangeRequest(candidate.changeRequestId);
  if (!campaign) return { status: 'NOT_STARTED', detail: 'no campaign yet', prUrl: null, mergeSha: null, deployed: false, verified: false, changedPaths: [], tests: 'not run' };
  const { objectiveOutcome } = await import('../factory/release/outcome.ts');
  const outcome = await objectiveOutcome(campaign);
  const { latestDelivery } = await import('../factory/delivery.ts');
  const delivery = await latestDelivery(campaign.id).catch(() => null);
  const units = await listUnits(campaign.id);
  const delivered = units.filter((u) => ['MERGED', 'INTEGRATED', 'ACCEPTED', 'COMPLETE', 'DONE'].includes(String(u.state)));
  const checks = units.filter((u) => u.kind === 'VERIFICATION' || u.kind === 'REVIEW' || u.kind === 'TEST');
  const tests = checks.length
    ? checks.map((u) => `${u.unitKey}:${u.state}`).join(', ').slice(0, 300)
    : outcome.status === 'LIVE' || delivery?.state === 'MERGED'
      ? 'passed the release gate (merged by Factory after its gate)'
      : 'not yet run';
  return {
    status: outcome.status,
    detail: (outcome.blocker ?? outcome.detail).slice(0, 400),
    prUrl: outcome.prUrl,
    mergeSha: outcome.release?.mergeSha ?? delivery?.mergeSha ?? null,
    deployed: delivery?.deployed === true || outcome.status === 'LIVE',
    verified: outcome.status === 'LIVE',
    changedPaths: [...new Set((delivered.length ? delivered : units).flatMap((u) => u.ownedPaths))].slice(0, 20),
    tests,
  };
}

/** Every engineering the operator commissioned, with what happened to it. Newest first. */
export async function engineeringOutcomes(options: { limit?: number; includeClosed?: boolean; candidateIds?: string[] } = {}): Promise<EngineeringOutcome[]> {
  const all = (await listCandidates()).filter((c) => c.evidence['directive']);
  const chosen = all
    .filter((c) => options.includeClosed !== false || !c.decision)
    .filter((c) => !options.candidateIds || options.candidateIds.includes(c.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, options.limit ?? 10);
  const out: EngineeringOutcome[] = [];
  const marks = new Map<string, GoalMark | null>();
  for (const c of chosen) {
    const directive = c.evidence['directive'] as Record<string, unknown>;
    const goalId = (directive['goalId'] as string | null) ?? null;
    const factory = await factoryFacts(c).catch(() => null);
    const result = c.result as { before?: { value: number | null }; after?: { value: number | null }; primary?: { verdict: string } } | null;
    const measurement = result ? { metric: c.metric, before: result.before?.value ?? null, after: result.after?.value ?? null, verdict: result.primary?.verdict ?? null } : null;
    if (goalId && !marks.has(goalId)) marks.set(goalId, (await goalMark(goalId).catch(() => ({ mark: null }))).mark);
    const before = (c.evidence['goalBaseline'] as GoalMark | null | undefined) ?? null;
    const after = goalId ? (marks.get(goalId) ?? null) : null;
    const goal = compareGoal(before, after);
    const judged = judgeEngineering({
      started: Boolean(c.campaignId || c.researchGoalId || c.decision),
      factoryStatus: factory?.status ?? null,
      merged: Boolean(factory?.mergeSha) || Boolean(c.deliveredAt),
      deployed: factory?.deployed === true,
      verified: factory?.verified === true,
      measurement: measurement?.verdict ?? null,
      decision: c.decision,
      goal,
    });
    out.push({
      candidateId: c.id,
      weaknessKey: c.weaknessKey,
      title: c.title,
      goalId,
      deficiency: String(directive['deficiency'] ?? c.kind),
      intervention: String(directive['intervention'] ?? 'ENGINEERING'),
      priority: typeof directive['priority'] === 'number' ? (directive['priority'] as number) : null,
      stage: c.decision ? 'CLOSED' : c.deliveredAt ? 'MEASURING' : c.campaignId ? 'ENGINEERING' : c.researchGoalId ? 'RESEARCHING' : 'ENGINEER',
      factory,
      measurement,
      decision: c.decision,
      decisionReason: c.decisionReason,
      goal: { before, after, effect: goal.effect, reasons: goal.reasons },
      status: c.researchGoalId && !c.campaignId && !c.decision ? 'BUILDING' : judged.status,
      next: judged.next,
      sentence: c.researchGoalId && !c.campaignId && !c.decision ? `Method research ${c.researchGoalId} establishes the cause first.` : judged.sentence,
    });
  }
  return out;
}

/**
 * One pass, from the operator tick: record every commissioned engineering's outcome that
 * changed since it was last recorded, as an `OPERATOR_ENGINEERING_OUTCOME` event the next run
 * reads. Returns how many changed in a way that should wake the operator now.
 */
export async function directorPass(): Promise<{ recorded: number; wake: number }> {
  let recorded = 0;
  let wake = 0;
  for (const outcome of await engineeringOutcomes({ limit: 25 })) {
    if (!outcome.decision) await refreshPriority(outcome.candidateId).catch(() => undefined);
    const prior = (await listImprovementEvents({ candidateId: outcome.candidateId, kinds: ['OPERATOR_OUTCOME'], limit: 1 }))[0];
    const signature = `${outcome.status}|${outcome.factory?.status ?? '-'}|${outcome.decision ?? '-'}|${outcome.goal.effect}`;
    if (prior && prior.detail['signature'] === signature) continue;
    await recordImprovementEvent({ candidateId: outcome.candidateId, kind: 'OPERATOR_OUTCOME', detail: { signature, status: outcome.status, sentence: outcome.sentence } });
    const projectId = await anchorProject(await goalProject(outcome.goalId));
    if (projectId) {
      await recordEvent({
        projectId,
        entityType: 'PROJECT',
        entityId: projectId,
        eventType: ENGINEERING_EVENTS.outcome,
        payload: {
          candidateId: outcome.candidateId,
          goalId: outcome.goalId,
          status: outcome.status,
          next: outcome.next,
          factory: outcome.factory,
          measurement: outcome.measurement,
          decision: outcome.decision,
          goalEffect: outcome.goal.effect,
          goalReasons: outcome.goal.reasons,
          sentence: outcome.sentence,
        },
      });
    }
    recorded += 1;
    if (prior && wakesOperator(outcome.status)) wake += 1;
  }
  await notifyVerifiedImprovements().catch((error: unknown) => console.warn(`owner improvement notice: ${String((error as Error)?.message ?? error)}`));
  return { recorded, wake };
}

/**
 * Priorities are not fixed at commissioning: each pass recomputes a live commission's priority
 * from the goal as it reads now (money left, days left) and the diagnosis it was given, and
 * reorders its waiting work when that changed. Leased work keeps its place.
 */
export async function refreshPriority(candidateId: string): Promise<number | null> {
  const candidate = await getCandidate(candidateId);
  const directive = candidate?.evidence['directive'] as Record<string, unknown> | undefined;
  if (!candidate || !directive || candidate.decision) return null;
  const goal = await goalMark((directive['goalId'] as string | null) ?? null);
  const next = engineeringPriority({
    blocksGoal: directive['blocksGoal'] === undefined ? true : directive['blocksGoal'] === true,
    remainingCents: goal.remainingCents,
    daysLeft: goal.daysLeft,
    share: typeof directive['share'] === 'number' ? (directive['share'] as number) : 0.3,
    recurrence: typeof directive['recurrence'] === 'number' ? (directive['recurrence'] as number) : candidate.frequency,
    deficiency: String(directive['deficiency'] ?? 'RECURRING_OPERATIONAL_FAILURE') as DeficiencyClass,
  });
  if (next.priority === directive['priority']) return null;
  await patchCandidate(candidate.id, {
    evidence: { ...candidate.evidence, directive: { ...directive, priority: next.priority, urgency: next.urgency, priorityWhy: `recomputed: ${next.why}` } },
  });
  const applied = candidate.campaignId ? await applyPriority(candidate.campaignId, next.priority) : 0;
  await recordImprovementEvent({ candidateId: candidate.id, kind: 'OPERATOR_REPRIORITIZED', detail: { from: directive['priority'], to: next.priority, why: next.why, bins: applied } });
  return next.priority;
}

/** Whether an engineering outcome the operator has not yet seen arrived after its last run started. */
export async function unseenOutcomeSince(lastStartedAt: string | null): Promise<boolean> {
  if (!lastStartedAt) return false;
  const rows = await eventsOfType(ENGINEERING_EVENTS.outcome, lastStartedAt, 20);
  return rows.some((row) => !row.payload.includes('"status":"BUILDING"'));
}

/* ------------------------------------------------------------------------- */
/* What the rows show is weak                                                 */
/* ------------------------------------------------------------------------- */

export interface DeficiencyReading {
  /** A ready-made diagnosis: the operator may pass it to brain_operator_commission as it stands. */
  diagnosis: Omit<DiagnosisRequest, 'runId'>;
  intervention: Intervention;
  why: string;
}

/**
 * Deficiencies Brain can already name from its rows, each with the intervention the rules
 * give it. A free model reads and chooses; it does not have to discover them.
 *
 * Bounded reads only: the goals snapshot the run already took, the operator's own runs,
 * and the improvement register.
 */
export async function readDeficiencies(): Promise<DeficiencyReading[]> {
  const out: DeficiencyReading[] = [];
  const { operatorSnapshot, briefOrder } = await import('./snapshot.ts');
  const projectIds = (await listProjects()).map((p) => p.id);
  const snapshot = await operatorSnapshot(projectIds);
  const goals = briefOrder(snapshot).slice(0, 6);
  // 1. A goal held on a person by cards nobody can answer, and cards that keep coming back. Counted
  //    per project from the withdrawals already made, so withdrawing today's card does not hide the
  //    recurrence that makes it an engineering defect rather than a chore.
  const weekAgo = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  const withdrawn = await eventsOfType('OPERATOR_WITHDREW_MOOT_REQUEST', weekAgo, 1000)
    .then((rows) => {
      const counts = new Map<string, number>();
      for (const row of rows) counts.set(row.projectId, (counts.get(row.projectId) ?? 0) + 1);
      return counts;
    })
    .catch(() => new Map<string, number>());
  // One reading per project: the defect is in the code, and every goal of the project shows it.
  // Attributed to the project's most urgent goal (briefOrder), which is the one it holds back most.
  const seenProjects = new Set<string>();
  for (const goal of goals) {
    if (goal.projectId) {
      if (seenProjects.has(goal.projectId)) continue;
      seenProjects.add(goal.projectId);
    }
    const requests = goal.projectId ? (snapshot.requests.get(goal.projectId) ?? []) : [];
    const moot = requests.filter((one) => one.moot);
    const reopened = goal.projectId ? (withdrawn.get(goal.projectId) ?? 0) : 0;
    const held = moot.length > 0 && goal.waiting.startsWith('PERSON');
    if (!held && reopened < 2) continue;
    const recurrence = moot.length + reopened;
    out.push(
      reading({
        goalId: goal.id,
        deficiency: 'RECURRING_OPERATIONAL_FAILURE',
        title: 'Answered research cards come back as moot person-requests and hold the goal on a person',
        observed:
          `Goal ${goal.id} reads ${goal.state}, waiting on "${goal.waiting.slice(0, 160)}"; ${moot.length} open request(s) are moot — ` +
          `their missions already left NEEDS_HUMAN, so no answer can apply — and ${reopened} moot card(s) were withdrawn in 7 days while new ones keep arriving.`,
        evidence: [
          ...moot.slice(0, 5).map((m) => `${m.requestId}: mission ${m.missionId} ${m.missionState}, packet ${m.packetStatus}; recommendation "${m.recommendation ?? ''}"`),
          `${reopened} OPERATOR_WITHDREW_MOOT_REQUEST event(s) in this project since ${weekAgo}`,
        ].join('; '),
        cause:
          "russell/loop.ts 'answered-requests' passes every failed resume to reopenAnswered (needsHuman.ts), including 'the mission moved out of Needs You before the answer could be applied' — " +
          'a failure that can never succeed, so the card is put back in front of the person for a decision nobody can make.',
        ownerPaths: ['server/services/russell/needsHuman.ts', 'server/services/russell/loop.ts'],
        recurrence,
        expectedBenefit: "The goal stops reading BLOCKED on a person for nothing; Brain's own next action (research, construction) leads instead, and the owner's Needs You holds only real decisions.",
        acceptance: 'A test answers a request whose mission already left NEEDS_HUMAN and shows the card is withdrawn with the reason, not reopened, and a request whose mission still waits is reopened as before.',
        metric: 'OWNER_INTERVENTIONS_PER_DAY',
        blocksGoal: true,
        share: held ? 0.3 : 0.15,
        proposed: null,
      }),
    );
  }
  // 2. The operator itself: runs that failed on the model, not on Brain.
  const { recentOperatorRuns } = await import('../../repos/operator.ts');
  const runs = await recentOperatorRuns(8);
  const modelFailures = runs.filter((r) => r.state === 'FAILED' && /HTTP 4(00|29)|too large|rate-limit|cooling down|tool choice/i.test(r.error ?? r.summary ?? ''));
  if (modelFailures.length >= 3) {
    out.push(
      reading({
        goalId: null,
        deficiency: 'MISSING_CAPABILITY',
        title: "The operator's model fails runs before Brain is reached",
        observed: `${modelFailures.length} of the last ${runs.length} operator runs failed on the model (rate limits, context size, tool-call parser), so no goal was directed in them.`,
        evidence: modelFailures.slice(0, 4).map((r) => `${r.id}: ${(r.error ?? '').slice(0, 160)}`).join('; '),
        cause: 'the free switchboard rate-limits and the GPU recipe lacks a tool-call parser at 64K',
        ownerPaths: [],
        recurrence: modelFailures.length,
        expectedBenefit: 'Every hourly run directs the goals instead of failing on the model.',
        acceptance: 'Operator runs reach Brain and call at least one brain_operator_ tool successfully in most runs.',
        metric: 'AUTO_RECOVERY_RATE',
        blocksGoal: false,
        share: 0.1,
        proposed: 'MODEL',
        modelLimited: true,
      }),
    );
  }
  // 3. A strategy the loop already tried that did not work: a repeated mistake.
  const repeated = (await listCandidates()).filter((c) => c.decision === 'KEPT_NO_EFFECT' || c.decision === 'REVERTED');
  const byKind = new Map<string, number>();
  for (const c of repeated) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
  for (const [kind, n] of byKind) {
    if (n < 2) continue;
    out.push(
      reading({
        goalId: goals[0]?.id ?? null,
        deficiency: 'REPEATED_STRATEGIC_MISTAKE',
        title: `Repairs of ${kind} keep ending without effect`,
        observed: `${n} improvement attempts of kind ${kind} ended KEPT_NO_EFFECT or REVERTED: the method keeps being re-run without changing the outcome.`,
        evidence: repeated.filter((c) => c.kind === kind).slice(0, 4).map((c) => `${c.weaknessKey}: ${c.decision} — ${(c.decisionReason ?? '').slice(0, 120)}`).join('; '),
        cause: null,
        ownerPaths: [],
        recurrence: n,
        expectedBenefit: 'Engineering capacity stops going to a method that does not move the metric.',
        acceptance: 'The next attempt names a different method than every earlier one.',
        metric: 'READY_OPPORTUNITIES_PER_DAY',
        blocksGoal: false,
        share: 0.05,
        proposed: 'STRATEGY',
      }),
    );
  }
  return out.slice(0, 6);
}

function reading(diagnosis: Omit<DiagnosisRequest, 'runId'>): DeficiencyReading {
  const decision = decideIntervention({
    goalId: diagnosis.goalId,
    deficiency: diagnosis.deficiency as DeficiencyClass,
    title: diagnosis.title,
    observed: diagnosis.observed,
    evidence: diagnosis.evidence,
    cause: diagnosis.cause,
    ownerPaths: diagnosis.ownerPaths,
    recurrence: diagnosis.recurrence,
    expectedBenefit: diagnosis.expectedBenefit,
    acceptance: diagnosis.acceptance,
    metric: (diagnosis.metric as MetricKey) ?? 'OWNER_INTERVENTIONS_PER_DAY',
    blocksGoal: diagnosis.blocksGoal,
    share: diagnosis.share ?? 0,
    proposed: (diagnosis.proposed as Intervention | null) ?? null,
    modelLimited: diagnosis.modelLimited === true,
    personOnly: diagnosis.personOnly === true,
    capacityIdle: diagnosis.capacityIdle === true,
  });
  return { diagnosis, intervention: decision.intervention, why: decision.why };
}

/** The stable id the brief and the tool use for a ready-made diagnosis. */
export function readingId(one: DeficiencyReading): string {
  return `dfx_${sha(`${one.diagnosis.deficiency}|${one.diagnosis.goalId ?? '-'}|${one.diagnosis.title}`).slice(0, 12)}`;
}

/* ------------------------------------------------------------------------- */
/* The brief, and the standing director                                       */
/* ------------------------------------------------------------------------- */

/**
 * The engineering section of a run's brief: what came back from Factory since the operator
 * commissioned it, and the deficiencies the rows show with their ids. Bounded, so a small
 * model's window holds it beside the goals.
 */
export async function engineeringBrief(): Promise<string> {
  const lines: string[] = [];
  const outcomes = await engineeringOutcomes({ limit: 5 }).catch(() => []);
  if (outcomes.length) {
    lines.push('ENGINEERING YOU COMMISSIONED (brain_operator_engineering for detail):');
    for (const one of outcomes) {
      lines.push(`- ${one.candidateId} [${one.status} → ${one.next}] ${one.title.slice(0, 90)}: ${one.sentence.slice(0, 220)}`);
    }
    if (outcomes.some((one) => one.status === 'RESOLVED')) {
      lines.push(
        'For each RESOLVED one you have not evaluated: judge what the measured change did to its goal and record it with ' +
          'brain_operator_record_learning {candidate_id, goal_id, lesson, evidence}.',
      );
    }
  }
  const found = await readDeficiencies().catch(() => []);
  if (found.length) {
    lines.push('DEFICIENCIES THE ROWS SHOW (brain_operator_commission {deficiency_id} acts on one):');
    for (const one of found) lines.push(`- ${readingId(one)} ${one.diagnosis.deficiency} → ${one.intervention}: ${one.diagnosis.title.slice(0, 120)}`);
  }
  return lines.join('\n').slice(0, 2500);
}

/** Runs that must pass without the operator acting before Brain's standing director acts itself. */
export const STANDING_AFTER_RUNS = 2;

/**
 * The standing director: an ENGINEERING deficiency that blocks a goal, presented to the
 * operator in its last `STANDING_AFTER_RUNS` runs and acted on in none of them — because
 * the model failed, was rate-limited, or chose nothing — is commissioned by Brain itself,
 * recorded as such. The owner's standing order is that Brain decides; a run that cannot
 * reach a model is not a reason for a goal to stay blocked. Never anything but ENGINEERING
 * that blocks a goal, and never a second campaign (the register's key decides).
 */
export async function standingCommission(now = new Date()): Promise<string[]> {
  const { recentOperatorRuns } = await import('../../repos/operator.ts');
  const runs = (await recentOperatorRuns(STANDING_AFTER_RUNS)).filter((r) => r.state !== 'RUNNING');
  if (runs.length < STANDING_AFTER_RUNS) return [];
  const acted = runs.some((r) => r.toolCalls.some((c) => c.ok && /brain_operator_(commission|submit_fix)/.test(c.tool)));
  if (acted) return [];
  const done: string[] = [];
  for (const one of await readDeficiencies()) {
    if (one.intervention !== 'ENGINEERING' || !one.diagnosis.blocksGoal) continue;
    const key = deficiencyKey(
      { deficiency: one.diagnosis.deficiency as DeficiencyClass, ownerPaths: one.diagnosis.ownerPaths, title: one.diagnosis.title, goalId: one.diagnosis.goalId },
      sha,
    );
    const owners = [...one.diagnosis.ownerPaths].sort().join(',');
    const existing = (await listCandidates()).find(
      (c) =>
        c.weaknessKey === key ||
        c.weaknessKey.startsWith(`${key}#`) ||
        ((c.evidence['directive'] as { deficiency?: string } | undefined)?.deficiency === one.diagnosis.deficiency &&
          Array.isArray(c.evidence['ownerPaths']) &&
          [...(c.evidence['ownerPaths'] as string[])].sort().join(',') === owners),
    );
    if (existing) continue;
    const result = await commission({ ...one.diagnosis, runId: runs[0]?.id ?? null, standing: true }, now);
    done.push(`${readingId(one)}: ${result.reason}`);
    if (runs[0]) {
      await recordOperatorLearning({
        goalId: one.diagnosis.goalId,
        runId: runs[0].id,
        lesson: `Brain's standing director commissioned ${readingId(one)} after ${STANDING_AFTER_RUNS} operator runs did not: ${result.reason}`.slice(0, 1000),
        evidence: runs.map((r) => `${r.id} ${r.state}${r.error ? `: ${r.error.slice(0, 120)}` : ''}`).join('; '),
      });
    }
  }
  return done;
}

/* ------------------------------------------------------------------------- */
/* Telling the owner: a verified autonomous self-improvement cycle            */
/* ------------------------------------------------------------------------- */

/** The marker a lesson carries when the operator evaluates engineering it commissioned. */
export function evaluatesMarker(candidateId: string): string {
  return `[evaluates ${candidateId}]`;
}

/** Everything `verifiedCycle` needs about one outcome, read from the rows §87 and §109 keep. */
export async function cycleFacts(outcome: EngineeringOutcome): Promise<CycleFacts | null> {
  const candidate = await getCandidate(outcome.candidateId);
  if (!candidate) return null;
  const directive = (candidate.evidence['directive'] ?? {}) as Record<string, unknown>;
  const origin = directive['origin'] === 'OPERATOR' ? 'OPERATOR' : directive['origin'] === 'STANDING_DIRECTOR' ? 'STANDING_DIRECTOR' : 'UNKNOWN';
  const runId = typeof directive['runId'] === 'string' ? (directive['runId'] as string) : null;
  let commissionedByRun: string | null = null;
  if (runId) {
    const { getOperatorRun } = await import('../../repos/operator.ts');
    const run = await getOperatorRun(runId);
    if (run?.toolCalls.some((c) => c.ok && /brain_operator_(commission|submit_fix)$/.test(c.tool))) commissionedByRun = run.id;
  }
  const kept = (await listImprovementEvents({ candidateId: candidate.id, kinds: ['DECIDED'], limit: 20 })).find((e) => e.detail['decision'] === 'KEPT');
  const decidedAt = kept?.at ?? null;
  const evaluation = await getDb().get<{ run_id: string; recorded_at: string; lesson: string }>(
    `SELECT l.run_id, l.recorded_at, l.lesson FROM operator_learnings l JOIN operator_runs r ON r.id = l.run_id
      WHERE l.evidence LIKE ? AND l.recorded_at >= ? ORDER BY l.recorded_at, l.id LIMIT 1`,
    [`%${evaluatesMarker(candidate.id)}%`, decidedAt ?? candidate.deliveredAt ?? candidate.createdAt],
  );
  return {
    candidateId: candidate.id,
    title: candidate.title,
    deficiency: outcome.deficiency,
    problem: candidate.problem,
    goalId: outcome.goalId,
    goalTitle: typeof directive['goalTitle'] === 'string' ? (directive['goalTitle'] as string) : null,
    origin,
    commissionedByRun,
    intervention: outcome.intervention,
    campaignId: candidate.campaignId,
    factory: outcome.factory
      ? {
          status: outcome.factory.status,
          prUrl: outcome.factory.prUrl,
          mergeSha: outcome.factory.mergeSha,
          deployed: outcome.factory.deployed,
          verified: outcome.factory.verified,
          changedPaths: outcome.factory.changedPaths,
          tests: outcome.factory.tests,
        }
      : null,
    measurement: outcome.measurement,
    decision: outcome.decision,
    decisionReason: outcome.decisionReason,
    decidedAt,
    status: outcome.status,
    goal: { effect: outcome.goal.effect as CycleFacts['goal']['effect'], reasons: outcome.goal.reasons },
    evaluation: evaluation ? { runId: evaluation.run_id, recordedAt: evaluation.recorded_at, lesson: evaluation.lesson } : null,
  };
}

const noticeInFlight = new Set<string>();

export interface OwnerNoticeResult {
  candidateId: string;
  status: 'RECORDED' | 'ALREADY_RECORDED' | 'NOT_VERIFIED' | 'BUSY' | 'FAILED';
  detail: string;
}

/** The owner-notice key of one improvement: the candidate, for ever. */
export function improvementNoticeId(candidateId: string): string {
  return `owner-improvement.${candidateId}`;
}

/**
 * Record one owner notice for every verified autonomous self-improvement cycle: Hermes found a
 * real deficiency, commissioned Factory, Factory merged, deployed and verified it, §87 measured
 * an improvement and kept it, and Hermes evaluated the result against the goal. Once per
 * improvement (`ownerNotices.ts`, keyed by the candidate). Nothing is sent outward: the owner's
 * Claude Code conversation reads it (owner, 2026-11-13). Called from the director pass and, the
 * moment Hermes records its evaluation, from the operator's lesson tool.
 */
export async function notifyVerifiedImprovements(options: { candidateId?: string } = {}): Promise<OwnerNoticeResult[]> {
  const out: OwnerNoticeResult[] = [];
  const { readOwnerNotice, recordOwnerNotice, OWNER_NOTICE_EVENTS } = await import('../ownerNotices.ts');
  // Only a change §87 kept can be RESOLVED, and one already recorded is done: both are read off
  // the register before any Factory or goal read, so the pass every five minutes costs one query.
  const kept = (await listCandidates()).filter(
    (c) => c.decision === 'KEPT' && c.evidence['directive'] && (!options.candidateId || c.id === options.candidateId),
  );
  const pending: string[] = [];
  for (const c of kept) {
    const told = await readOwnerNotice(improvementNoticeId(c.id));
    if (told) out.push({ candidateId: c.id, status: 'ALREADY_RECORDED', detail: `READY at ${told.readyAt}` });
    else pending.push(c.id);
  }
  const outcomes = pending.length
    ? (await engineeringOutcomes({ candidateIds: pending, limit: pending.length })).filter((o) => o.status === 'RESOLVED')
    : [];
  for (const outcome of outcomes) {
    const id = outcome.candidateId;
    const facts = await cycleFacts(outcome);
    if (!facts) continue;
    const cycle = verifiedCycle(facts);
    if (!cycle.verified) {
      out.push({ candidateId: id, status: 'NOT_VERIFIED', detail: Object.entries(cycle.steps).filter(([, why]) => why).map(([step, why]) => `${step}: ${why}`).join('; ') });
      continue;
    }
    if (noticeInFlight.has(id)) {
      out.push({ candidateId: id, status: 'BUSY', detail: 'this improvement is being recorded' });
      continue;
    }
    noticeInFlight.add(id);
    try {
      const projectId = await anchorProject(await goalProject(facts.goalId));
      if (!projectId) {
        out.push({ candidateId: id, status: 'FAILED', detail: 'no project to record the notice under' });
        continue;
      }
      const ordinal = (await getDb().get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM project_events WHERE event_type = ? AND payload LIKE ?`,
        [OWNER_NOTICE_EVENTS.IMPROVEMENT, '%"status":"READY"%'],
      ))?.n ?? 0;
      const notice = improvementNotice(facts, Number(ordinal) + 1);
      const recorded = await recordOwnerNotice({
        kind: 'IMPROVEMENT',
        projectId,
        noticeId: improvementNoticeId(id),
        subject: notice.subject,
        text: notice.text,
        detail: {
          candidateId: id,
          // The release and the improvement, kept apart as the message keeps them.
          release: { campaignId: facts.campaignId, prUrl: facts.factory?.prUrl ?? null, mergeSha: facts.factory?.mergeSha ?? null, deployed: facts.factory?.deployed ?? false, verifiedLive: facts.factory?.verified ?? false },
          improvement: { measurement: facts.measurement, decision: facts.decision, goalEffect: facts.goal.effect, goalReasons: facts.goal.reasons },
          evaluationRunId: facts.evaluation?.runId ?? null,
          steps: cycle.steps,
        },
      });
      out.push({ candidateId: id, status: recorded.created ? 'RECORDED' : 'ALREADY_RECORDED', detail: recorded.notice.subject });
    } finally {
      noticeInFlight.delete(id);
    }
  }
  return out;
}

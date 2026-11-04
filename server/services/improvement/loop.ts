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
  MAX_ATTEMPTS,
  BEFORE_WINDOW_HOURS,
  RECENT_WINDOW_HOURS,
  MEASURE_WINDOW_HOURS,
  METRICS,
  packetWeaknesses,
  ownerInterventionWeaknesses,
  rankCandidates,
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
import { claimRejections, freeLaneFailures, ownerInterventions, packetOutcomes, readMetric } from './scoreboard.ts';
import { improvementPerson, improvementSwitch } from './authority.ts';

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
}

/** The durable tick's call: at most every ten minutes. */
export async function improvementTickIfDue(nowMs = Date.now()): Promise<ImprovementTickReport | null> {
  if (nowMs - lastTick < IMPROVEMENT_TICK_MS) return null;
  lastTick = nowMs;
  return improvementTick(new Date(nowMs));
}

export function resetImprovementTick(): void {
  lastTick = 0;
}

/* ------------------------------------------------------------------------- */
/* Observe and identify                                                       */
/* ------------------------------------------------------------------------- */

/** Every weakness the rows show now. Pure reads. */
export async function detectWeaknesses(now: Date): Promise<Weakness[]> {
  const to = now.toISOString();
  const day = new Date(now.getTime() - 24 * HOUR).toISOString();
  const week = new Date(now.getTime() - 7 * 24 * HOUR).toISOString();
  const lane = await freeLaneFailures(day, to);
  const recentLane = await freeLaneFailures(new Date(now.getTime() - RECENT_WINDOW_HOURS * HOUR).toISOString(), to);
  const claims = await claimRejections(week, to);
  const packets = await packetOutcomes(week, to);
  const asks = await ownerInterventions(week, to);
  return [
    ...ownerInterventionWeaknesses(asks.causes, asks.total),
    ...freeLaneWeaknesses(lane.failures, lane.attempts, recentLane),
    ...claimRejectionWeaknesses(claims.rejections, claims.claims),
    ...packetWeaknesses(packets.causes, packets.settled),
  ];
}

/** The candidates of one weakness family (`KEY`, `KEY#2`, …), newest attempt last. */
async function family(baseKey: string): Promise<ImprovementCandidate[]> {
  return (await listCandidates()).filter((c) => c.weaknessKey === baseKey || c.weaknessKey.startsWith(`${baseKey}#`)).sort((a, b) => a.attempt - b.attempt);
}

/** Record what was seen: a new candidate, a refreshed one, a new attempt, or a combination. */
async function register(weakness: Weakness, now: Date, report: ImprovementTickReport): Promise<void> {
  const members = await family(weakness.key);
  const latest = members.at(-1);
  let attempt = 1;
  let parentId: string | null = null;
  if (latest) {
    if (!latest.decision) {
      await upsertCandidate(toInput(weakness, latest.attempt, latest.parentId, latest.weaknessKey));
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
  const { candidate, created } = await upsertCandidate(toInput(weakness, attempt, parentId, key));
  if (!created) return;
  report.opened.push(candidate.weaknessKey);
  await recordImprovementEvent({
    candidateId: candidate.id,
    kind: 'WEAKNESS_DETECTED',
    detail: { key: candidate.weaknessKey, frequency: weakness.frequency, denominator: weakness.denominator, samples: weakness.samples, attempt },
  });
  // Combine: one owner, one objective. A weakness on a component whose candidate
  // has not yet been sent to Factory joins it rather than racing it.
  const open = (await listCandidates({ open: true })).filter(
    (c) => c.id !== candidate.id && c.ownerComponent === candidate.ownerComponent && !c.changeRequestId && c.createdAt <= candidate.createdAt,
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
  factory: { state: string; detail: string; mergeSha: string | null; since: string } | null;
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
      };
    } else {
      factory = { state: 'BUILDING', detail: 'no campaign yet', mergeSha: null, since: candidate.updatedAt };
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
async function openResearch(candidate: ImprovementCandidate, now: Date): Promise<string> {
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
export function composeObjective(candidate: ImprovementCandidate, link: Linked, history: ImprovementCandidate[], baseline: MetricReading) {
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
    (candidate.evidence['knownCause'] ? `Diagnosis from the rows: ${String(candidate.evidence['knownCause'])} ` : '') +
    `Recorded failure reasons, verbatim: ${samples.map((s) => JSON.stringify(s)).join('; ')}. ` +
    (methods.length
      ? `Accepted method research Brain holds that bears on it: ${methods.map((m) => `${m.claim} (${m.source ?? 'no source'})`).join(' | ')}. `
      : '') +
    (earlier.length ? `Earlier attempts on this weakness — do not repeat their strategy: ${earlier.join(' | ')}. ` : '') +
    'Make the smallest general change that removes the cause for every future job of this kind, with a test that ' +
    'reproduces the recorded failure class and passes after the change. Lower no evidence bar, gate or permission.';
  return {
    objective: objective.slice(0, 7900),
    expectedOutcome:
      `${metric.label} rises after deployment against the recorded baseline` +
      (downstream ? `, and ${downstream.label} does not fall` : '') +
      `; Brain's improvement loop measures both over the ${MEASURE_WINDOW_HOURS} h after deployment against the ` +
      'baseline and keeps, corrects or reverts the change. That measurement is Brain\'s, not a unit\'s: no unit should wait for it.',
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
      /*
       * No production-measurement condition here. Production, 2026-11-04: campaign
       * fcp_f648380f… blocked two units on "A03 is a post-deploy measurement and
       * cannot be satisfied by a commit" — a Factory unit can only satisfy what a
       * commit can. Brain measures after delivery itself (the expected outcome says so).
       */
    ],
    mutationScope: scope,
  };
}

async function brainFactoryProject(): Promise<string | null> {
  const row = await getDb().get<{ project_id: string }>(
    "SELECT project_id FROM factory_project_repositories WHERE grant_id = 'brain' ORDER BY created_at LIMIT 1",
    [],
  );
  return row?.project_id ?? null;
}

/** Send the engineering to Factory: submit, approve on the standing order, start, and grant a LOW-risk release. */
async function engineer(candidate: ImprovementCandidate, link: Linked, now: Date): Promise<string> {
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
  const spec = composeObjective(candidate, link, history, baseline);
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
  let release = 'released by a person (risk ' + started.changeRequest.riskClass + ')';
  const person = await improvementPerson();
  if (started.changeRequest.riskClass === 'LOW' && person?.setByPerson) {
    const { authorizeAutomaticRelease } = await import('../factory/release/grant.ts');
    await authorizeAutomaticRelease({
      changeRequestId: started.changeRequest.id,
      userId: person.userId,
      channel: 'SHELL',
      executedByRef: 'improvement-loop',
      reason: `Owner's standing improvement order (set by ${person.email}): Factory merges, deploys and verifies LOW-risk Brain improvements.`,
      liveChecks: [{ kind: 'HTTP', path: '/healthz', expectStatus: 200 }],
    });
    release = 'automatic release granted (LOW risk)';
  }
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
  const decision = decideAfterMeasurement({ primary, downstream, hoursSinceDelivery: (now.getTime() - delivered) / HOUR });
  const result = { before, beforeDownstream: beforeDown, after, afterDownstream: afterDown, primary, downstream, at: now.toISOString() };
  await patchCandidate(candidate.id, { result });
  if (!decision.decision) return;
  if (decision.revert) {
    await submitRevert(candidate, decision.reason, now).catch(async (error: unknown) => {
      await recordImprovementEvent({ candidateId: candidate.id, kind: 'REVERT_NOT_SUBMITTED', detail: { error: String((error as Error).message ?? error).slice(0, 300) } });
    });
  }
  await decideCandidate(candidate.id, decision.decision, decision.reason, { result });
  await recordImprovementEvent({ candidateId: candidate.id, kind: 'DECIDED', detail: { decision: decision.decision, reason: decision.reason, primary, downstream } });
  report.decided.push(`${candidate.weaknessKey} ${decision.decision}`);
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

/** Advance one candidate by one step. Returns what it did, or null when it waited. */
async function advance(candidate: ImprovementCandidate, busyOwners: Set<string>, now: Date, report: ImprovementTickReport): Promise<string | null> {
  const link = await linked(candidate);
  const { stage } = stageOf(candidate, link, now);
  const last = (await listImprovementEvents({ candidateId: candidate.id, kinds: ['STAGE'], limit: 1 }))[0];
  if (!last || last.detail['stage'] !== stage) {
    await recordImprovementEvent({ candidateId: candidate.id, kind: 'STAGE', detail: { stage, from: last?.detail['stage'] ?? null } });
  }
  switch (stage as Stage) {
    case 'DIAGNOSE': {
      const goalId = await openResearch(candidate, now);
      await patchCandidate(candidate.id, { researchGoalId: goalId });
      await recordImprovementEvent({ candidateId: candidate.id, kind: 'RESEARCH_OPENED', detail: { goalId, archiveClaims: link.archive.length } });
      return `research goal ${goalId} (Claude routines)`;
    }
    case 'RESEARCHING':
      return null;
    case 'ENGINEER': {
      // Research that settled with nothing supported and no diagnosis concludes honestly: no change.
      if (link.research && link.research.settled && link.research.acceptedClaims === 0 && link.archive.length === 0 && !candidate.evidence['knownCause']) {
        await decideCandidate(candidate.id, 'REJECTED', `Method research ended ${link.research.status ?? 'without a result'} with no accepted claim and the rows state no cause; no change is justified.`);
        await recordImprovementEvent({ candidateId: candidate.id, kind: 'DECIDED', detail: { decision: 'REJECTED', research: link.research.status } });
        report.decided.push(`${candidate.weaknessKey} REJECTED`);
        return 'rejected: research found nothing to build';
      }
      if (busyOwners.has(candidate.ownerComponent)) return null;
      busyOwners.add(candidate.ownerComponent);
      return engineer(candidate, link, now);
    }
    case 'ENGINEERING': {
      const factory = link.factory!;
      if (factory.state === 'LIVE') {
        await patchCandidate(candidate.id, { deliveredAt: now.toISOString(), deliveredRef: factory.mergeSha ?? candidate.changeRequestId });
        await recordImprovementEvent({ candidateId: candidate.id, kind: 'DELIVERED', detail: { mergeSha: factory.mergeSha, detail: factory.detail } });
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
          await recordImprovementEvent({ candidateId: candidate.id, kind: 'FACTORY_BLOCKED', detail: { detail: factory.detail } });
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
/* The tick                                                                   */
/* ------------------------------------------------------------------------- */

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
  const state = await improvementSwitch();
  if (!state.enabled) {
    report.reason = 'switched off';
    return report;
  }
  report.ran = true;
  const weaknesses = await detectWeaknesses(now);
  report.detected = weaknesses.length;
  for (const weakness of weaknesses) {
    try {
      await register(weakness, now, report);
    } catch (error) {
      report.errors.push(`${weakness.key}: ${String((error as Error).message ?? error).slice(0, 200)}`);
    }
  }
  const open = await listCandidates({ open: true });
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
  try {
    await raiseAlerts(now, await listCandidates({ open: true }), actionable, report);
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
  return {
    switch: await improvementSwitch(),
    scoreboard,
    failureClasses: { attempts: lane.attempts, failures: lane.failures.map((f) => ({ cls: f.cls, n: f.n })) },
    detectors,
    candidates,
    recent,
  };
}

export { BRAIN_REPOSITORY_ID };
export type { MetricKey };

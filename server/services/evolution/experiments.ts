/**
 * Experiments: one deficiency built several materially different ways, judged by an
 * evaluator the implementing agents cannot see, and only the winner released (§111).
 *
 * Nothing here is a second register, Factory, scheduler or release path:
 *
 *   OPEN      the deficiency is one row in §87's register (`registerDirected`, keyed by
 *             `deficiencyKey`), marked as an experiment's parent so the loop never builds it
 *             as one objective; each approach is its own register row `<key>~v<n>` (so the
 *             UNIQUE key holds) and its own Factory objective, submitted through the loop's
 *             own `submitExperimentVariant` — the same objective, baseline and approval on
 *             the standing order, and no release grant, so each ends at a pull request
 *   EVALUATE  `pendingEvaluations` reads each variant's campaign; once every variant has a
 *             pull request (or the build window closed with at least two), the experiment
 *             waits for the evaluator (`evolution-eval.yml`), which records scores here
 *   DECIDE    `decide` runs `selectVariant` on the recorded scores, grants the existing LOW-risk
 *             release to the winner's campaign (`grantStandingRelease`, the loop's own rule),
 *             rejects the others with their scores, credits the approach types, and closes the
 *             parent into the winner — §87 then measures the winner after release as always
 *
 * Restart-safe: every step is a row, every state change is compare-and-set, and a pass that
 * stopped half-way is completed by the next (`ensureVariantsSubmitted`).
 */
import { createHash } from 'node:crypto';
import {
  experimentYield,
  rankApproachTypes,
  selectVariant,
  shouldRetire,
  validateApproaches,
  type Approach,
  type BenchResult,
  type Selection,
} from '../../domain/evolution.ts';
import { EVOLUTION_SUITES, findSuite } from '../../domain/evolutionSuites.ts';
import { deficiencyKey, engineeringPriority, routeEngineering, type Diagnosis } from '../../domain/engineeringDirector.ts';
import { MAX_ATTEMPTS, riskForScope, type Weakness } from '../../domain/improvement.ts';
import { RELEASE_EXCLUDED_PATHS } from '../../domain/factoryRelease.ts';
import {
  decideCandidate,
  getCandidate,
  listCandidates,
  patchCandidate,
  recordImprovementEvent,
  type ImprovementCandidate,
} from '../../repos/improvement.ts';
import {
  creditApproach,
  countHiddenCases,
  getExperiment,
  getVariant,
  insertExperiment,
  insertResult,
  insertVariant,
  linkVariant,
  listApproachStats,
  listExperiments,
  listResults,
  listVariants,
  newExperimentId,
  retireApproach,
  transitionExperiment,
  transitionVariant,
  type EvolutionResult,
  type Experiment,
  type Variant,
} from '../../repos/evolution.ts';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const HOUR = 3_600_000;

/** Variants still without a pull request this long after the experiment opened are timed out. */
export const BUILD_HOURS = 72;
/** An experiment the evaluator has not been able to decide in this long after building is HELD. */
export const EVALUATE_HOURS = 72;

export const EXPERIMENT_EVENTS = {
  opened: 'EXPERIMENT_OPENED',
  variantSubmitted: 'EXPERIMENT_VARIANT_SUBMITTED',
  evaluating: 'EXPERIMENT_EVALUATING',
  result: 'EXPERIMENT_RESULT_RECORDED',
  decided: 'EXPERIMENT_DECIDED',
  held: 'EXPERIMENT_HELD',
} as const;

/* ------------------------------------------------------------------------- */
/* Opening                                                                    */
/* ------------------------------------------------------------------------- */

/** Why these approaches cannot open an experiment on this suite, or null. Reads the approach statistics. */
export async function experimentInputProblem(approaches: readonly Approach[], suiteName: string | null, _deficiency?: string): Promise<string | null> {
  if (!suiteName) return `approaches need a registered suite to be judged on: one of ${EVOLUTION_SUITES.map((s) => s.name).join(', ')}`;
  const suite = findSuite(suiteName);
  if (!suite) return `suite "${suiteName}" is not registered: one of ${EVOLUTION_SUITES.map((s) => s.name).join(', ')}`;
  const valid = validateApproaches(approaches);
  if (!valid.ok) return valid.reason;
  const stats = await listApproachStats();
  const retired = valid.approaches.filter((a) => {
    const s = stats.find((x) => x.approachType === a.approachType && x.capabilityClass === suite.capabilityClass);
    return Boolean(s && (s.retiredAt || shouldRetire(s)));
  });
  if (retired.length) {
    const open = rankApproachTypes(stats, suite.capabilityClass).filter((r) => !r.retired).slice(0, 4).map((r) => r.approachType);
    return (
      `approach type(s) ${[...new Set(retired.map((a) => a.approachType))].join(', ')} are retired for ${suite.capabilityClass} ` +
      `(won too rarely in enough trials); choose among ${open.join(', ')}`
    );
  }
  return null;
}

export interface OpenExperimentInput {
  diagnosis: Diagnosis;
  /** The goal reading taken when it was commissioned (the director's `goalMark`). */
  goal: { mark: unknown; title: string | null; remainingCents: number | null; daysLeft: number | null };
  suite: string;
  approaches: Approach[];
  origin: 'OPERATOR' | 'STANDING_DIRECTOR' | 'DETECTOR';
  runId: string | null;
}

export interface OpenedVariant {
  variantId: string;
  label: string;
  candidateId: string | null;
  campaignId: string | null;
  did: string;
}

export type OpenExperimentResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      duplicate: boolean;
      experimentId: string;
      candidateId: string;
      weaknessKey: string;
      priority: number | null;
      variants: OpenedVariant[];
    };

/** The text every variant's Factory objective opens with: its one approach, and what judges it. */
export function variantPreamble(input: { experimentId: string; label: string; approachType: string; approach: string; siblings: number; suite: string }): string {
  const suite = findSuite(input.suite)!;
  const target = typeof suite.target === 'number' ? `${suite.target}` : `${suite.target.baselineFactor}× the first production baseline`;
  return (
    `EXPERIMENT ${input.experimentId}, VARIANT "${input.label}" (${input.approachType}) — one of ${input.siblings} materially different ` +
    `approaches built in parallel for the same deficiency. Build approach "${input.label}" ONLY: ${input.approach} ` +
    'Do not implement the other approaches, and do not merge: this objective ends at a pull request. An independent ' +
    `evaluator scores every variant and the production baseline on the benchmark suite "${suite.name}" (primary metric ` +
    `${suite.primaryMetric}, ${suite.direction === 'HIGHER' ? 'higher' : 'lower'} is better, target ${target}` +
    (suite.guards.length ? `; guards: ${suite.guards.map((g) => `${g.metric} may not regress more than ${g.tolerance}`).join(', ')}` : '') +
    `), and only the variant that beats the baseline beyond noise is released. The suite's public cases are in bench/ and run ` +
    `with \`npm run bench -- --suite ${suite.name}\`. Hidden cases exist in Brain's database and are not available to you: ` +
    'improve the capability itself, never the public cases.'
  );
}

/**
 * Open an experiment for a deficiency the director has decided is ENGINEERING. The same
 * deficiency named again while its experiment runs is the same experiment, not a second.
 */
export async function openExperiment(input: OpenExperimentInput, now = new Date()): Promise<OpenExperimentResult> {
  const problem = await experimentInputProblem(input.approaches, input.suite, input.diagnosis.deficiency);
  if (problem) return { ok: false, reason: problem };
  const suite = findSuite(input.suite)!;
  const valid = validateApproaches(input.approaches);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  const d = input.diagnosis;
  const scope = d.ownerPaths.length ? [...d.ownerPaths, 'tests/**'] : ['tests/**'];
  const risk = riskForScope(scope, RELEASE_EXCLUDED_PATHS);
  const priority = engineeringPriority({
    blocksGoal: d.blocksGoal,
    remainingCents: input.goal.remainingCents,
    daysLeft: input.goal.daysLeft,
    share: d.share,
    recurrence: d.recurrence,
    deficiency: d.deficiency,
  });
  const key = deficiencyKey(d, sha);
  const family = (await listCandidates())
    .filter((c) => c.weaknessKey === key || c.weaknessKey.startsWith(`${key}#`))
    .sort((a, b) => a.attempt - b.attempt);
  const latest = family.at(-1);
  const route = routeEngineering({ deficiency: d.deficiency, ownerPaths: d.ownerPaths, risk, failedAttempts: family.filter((c) => c.decision && c.decision !== 'COMBINED').length, urgency: priority.urgency });
  const directive = {
    origin: input.origin,
    runId: input.runId,
    goalId: d.goalId,
    goalTitle: input.goal.title,
    deficiency: d.deficiency,
    intervention: 'ENGINEERING',
    expectedBenefit: d.expectedBenefit,
    acceptance: d.acceptance,
    priority: priority.priority,
    urgency: priority.urgency,
    priorityWhy: priority.why,
    complexity: route.complexity,
    minimumModelClass: route.minimumModelClass,
    routeWhy: route.why,
    evaluation:
      `Before adoption, an independent evaluator scores every variant and the production baseline on suite ${suite.name}; only ` +
      `the variant that beats the baseline beyond noise with no guard regressed is released. After release Brain's improvement ` +
      `loop measures ${d.metric} as for every change. A merged pull request is not counted as the improvement.`,
    blocksGoal: d.blocksGoal,
    share: d.share,
    recurrence: d.recurrence,
  };

  // The parent: the deficiency's one row in §87's register.
  let parent: ImprovementCandidate;
  let experimentId = newExperimentId();
  if (latest && !latest.decision) {
    const marker = latest.evidence['experiment'] as { id?: string; role?: string } | undefined;
    if (marker?.role === 'PARENT' && marker.id) {
      const running = await getExperiment(marker.id);
      if (running && (running.state === 'BUILDING' || running.state === 'EVALUATING')) {
        const variants = await ensureVariantsSubmitted(running.id, now);
        return { ok: true, duplicate: true, experimentId: running.id, candidateId: latest.id, weaknessKey: latest.weaknessKey, priority: priority.priority, variants };
      }
      if (running) return { ok: false, reason: `experiment ${running.id} on ${latest.weaknessKey} is ${running.state}; its register row closes with it` };
      experimentId = marker.id; // the row was marked and the experiment never written: finish what was started
    } else if (latest.changeRequestId) {
      return {
        ok: false,
        reason: `${latest.weaknessKey} is already being engineered as one objective (change request ${latest.changeRequestId}); alternatives are compared before one is built — re-attempt it, then compare`,
      };
    }
    parent = latest;
    await patchCandidate(parent.id, {
      evidence: { ...parent.evidence, directive, ownerPaths: d.ownerPaths, goalBaseline: input.goal.mark, experiment: { id: experimentId, role: 'PARENT' } },
    });
  } else {
    const marker = { directive, ownerPaths: d.ownerPaths, goalBaseline: input.goal.mark, experiment: { id: experimentId, role: 'PARENT' } };
    if (latest) {
      if (latest.attempt >= MAX_ATTEMPTS) return { ok: false, reason: `attempt ${latest.attempt} of ${MAX_ATTEMPTS} on ${key} was the last: a failing improvement cannot loop` };
      const { registerNextAttempt } = await import('../improvement/loop.ts');
      const next = await registerNextAttempt(latest.id, { reason: `a new experiment compares ${input.approaches.length} alternatives`, evidence: { ...latest.evidence, ...marker } });
      if (!next.ok) return { ok: false, reason: next.reason };
      parent = next.candidate;
    } else {
      const { registerDirected } = await import('../improvement/loop.ts');
      parent = (await registerDirected(weaknessOf(d, key, scope, priority.priority), now, { evidence: marker, noCombine: true })).candidate;
    }
  }

  const experiment = await insertExperiment({
    id: experimentId,
    candidateId: parent.id,
    deficiency: d.deficiency,
    capabilityClass: suite.capabilityClass,
    suite: suite.name,
    baselineSha: (await import('../../env.ts')).BRAIN_REVISION ?? 'production',
    origin: input.origin,
    runId: input.runId,
    cause: d.cause,
  });
  for (const a of valid.approaches) {
    await insertVariant({ experimentId: experiment.id, label: a.label, approachType: a.approachType, approachText: a.approach, signature: a.signature, ownerPaths: a.ownerPaths });
  }
  await recordImprovementEvent({
    candidateId: parent.id,
    kind: EXPERIMENT_EVENTS.opened,
    detail: { experimentId: experiment.id, suite: suite.name, runId: input.runId, approaches: valid.approaches.map((a) => ({ label: a.label, type: a.approachType, signature: a.signature })) },
  });
  const variants = await ensureVariantsSubmitted(experiment.id, now);
  return { ok: true, duplicate: false, experimentId: experiment.id, candidateId: parent.id, weaknessKey: parent.weaknessKey, priority: priority.priority, variants };
}

function weaknessOf(d: Diagnosis, key: string, scope: string[], priority: number): Weakness {
  return {
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
    severity: priority >= 7 ? 'HIGH' : priority >= 4 ? 'MEDIUM' : 'LOW',
    researchQuestion: `${d.title}: ${d.observed}`.slice(0, 400),
    samples: d.evidence.split(/\n|;\s/).map((s) => s.trim()).filter(Boolean).slice(0, 8),
    knownCause: d.cause,
  };
}

/**
 * Every variant of a building experiment has its register row and its Factory objective. Idempotent:
 * a variant already linked is left as it is, so a pass that stopped half-way is completed here.
 */
export async function ensureVariantsSubmitted(experimentId: string, now = new Date()): Promise<OpenedVariant[]> {
  const experiment = await getExperiment(experimentId);
  if (!experiment) return [];
  const parent = await getCandidate(experiment.candidateId);
  const variants = await listVariants(experimentId);
  const out: OpenedVariant[] = [];
  for (const [i, v] of variants.entries()) {
    if (experiment.state !== 'BUILDING' || v.state !== 'BUILDING' || !parent) {
      out.push({ variantId: v.id, label: v.label, candidateId: v.candidateId, campaignId: v.campaignId, did: v.state.toLowerCase() });
      continue;
    }
    let candidateId = v.candidateId;
    if (!candidateId) {
      const scope = v.ownerPaths.length ? [...v.ownerPaths, 'tests/**'] : ((parent.evidence['mutationScope'] as string[] | undefined) ?? [parent.ownerComponent, 'tests/**']);
      const weakness: Weakness = {
        key: `${parent.weaknessKey}~v${i + 1}`,
        kind: parent.kind,
        title: `${parent.title} — variant ${v.label} (${v.approachType})`.slice(0, 200),
        problem: parent.problem,
        metric: parent.metric,
        downstreamMetric: parent.downstreamMetric,
        ownerComponent: parent.ownerComponent,
        mutationScope: scope,
        frequency: parent.frequency,
        denominator: parent.denominator,
        scope: parent.scope,
        severity: parent.severity,
        researchQuestion: String(parent.evidence['researchQuestion'] ?? parent.title),
        samples: (parent.evidence['samples'] as string[] | undefined) ?? [],
        knownCause: (parent.evidence['knownCause'] as string | null | undefined) ?? experiment.cause,
      };
      const { registerDirected } = await import('../improvement/loop.ts');
      const registered = await registerDirected(weakness, now, {
        noCombine: true,
        evidence: {
          directive: { ...((parent.evidence['directive'] as Record<string, unknown> | undefined) ?? {}), variant: v.label },
          ownerPaths: v.ownerPaths.length ? v.ownerPaths : parent.evidence['ownerPaths'],
          goalBaseline: parent.evidence['goalBaseline'] ?? null,
          experiment: { id: experiment.id, role: 'VARIANT', variantId: v.id },
          approach: { label: v.label, type: v.approachType, text: v.approachText, signature: v.signature },
        },
      });
      candidateId = registered.candidate.id;
      await linkVariant(v.id, { candidateId });
    }
    let did = 'submitted';
    let campaignId = v.campaignId;
    if (!campaignId) {
      try {
        const { submitExperimentVariant } = await import('../improvement/loop.ts');
        const preamble = variantPreamble({ experimentId: experiment.id, label: v.label, approachType: v.approachType, approach: v.approachText, siblings: variants.length, suite: experiment.suite });
        const submitted = await submitExperimentVariant(candidateId, preamble, now);
        did = submitted.did;
        campaignId = submitted.campaignId;
        if (campaignId) await linkVariant(v.id, { campaignId });
        await recordImprovementEvent({ candidateId, kind: EXPERIMENT_EVENTS.variantSubmitted, detail: { experimentId: experiment.id, variantId: v.id, label: v.label, changeRequestId: submitted.changeRequestId, campaignId, did } });
      } catch (error) {
        did = `not submitted: ${String((error as Error).message ?? error).slice(0, 300)}`;
        await recordImprovementEvent({ candidateId, kind: 'ERROR', detail: { experimentId: experiment.id, variantId: v.id, message: did } });
      }
    }
    out.push({ variantId: v.id, label: v.label, candidateId, campaignId, did });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Waiting for the evaluator                                                  */
/* ------------------------------------------------------------------------- */

export interface PendingEvaluation {
  id: string;
  suite: string;
  baseline_sha: string;
  variants: { id: string; label: string; approach_type: string; head_sha: string; branch: string | null; pr_number: number | null; pr_url: string | null }[];
}

function prNumber(url: string | null): number | null {
  const m = url ? /\/pull\/(\d+)/.exec(url) : null;
  return m ? Number(m[1]) : null;
}

/** Read each building variant's campaign, and move the experiment when its variants have finished building. */
export async function refreshExperiment(experimentId: string, now = new Date()): Promise<Experiment | null> {
  let experiment = await getExperiment(experimentId);
  if (!experiment) return null;
  if (experiment.state === 'BUILDING') {
    await ensureVariantsSubmitted(experiment.id, now);
    const { getCampaign } = await import('../../repos/factory.ts');
    for (const v of await listVariants(experiment.id)) {
      if (v.state !== 'BUILDING' || !v.campaignId) continue;
      const campaign = await getCampaign(v.campaignId);
      if (!campaign) continue;
      if ((campaign.state === 'COMPLETE' || campaign.state === 'AWAITING_RELEASE') && campaign.prUrl && campaign.integrationSha) {
        await linkVariant(v.id, { prUrl: campaign.prUrl, headSha: campaign.integrationSha, branch: campaign.integrationBranch });
        await transitionVariant(v.id, ['BUILDING'], 'PR_READY');
      } else if (campaign.state === 'CANCELLED') {
        await transitionVariant(v.id, ['BUILDING'], 'FAILED', { reason: 'Factory cancelled the campaign' });
      }
    }
    const variants = await listVariants(experiment.id);
    const timedOut = now.getTime() - Date.parse(experiment.createdAt) >= BUILD_HOURS * HOUR;
    const finished = variants.every((v) => v.state !== 'BUILDING');
    if (finished || timedOut) {
      const ready = variants.filter((v) => v.state === 'PR_READY');
      for (const v of variants.filter((x) => x.state === 'BUILDING')) {
        await transitionVariant(v.id, ['BUILDING'], 'FAILED', { reason: `no pull request within ${BUILD_HOURS} h` });
      }
      if (ready.length >= 2) {
        if (await transitionExperiment(experiment.id, 'BUILDING', 'EVALUATING')) {
          await recordImprovementEvent({ candidateId: experiment.candidateId, kind: EXPERIMENT_EVENTS.evaluating, detail: { experimentId: experiment.id, ready: ready.map((v) => v.id), timedOut } });
        }
      } else {
        await hold(experiment, `${ready.length} variant(s) reached a pull request${timedOut ? ` within ${BUILD_HOURS} h` : ''}; a comparison needs at least two`, now);
      }
    }
  } else if (experiment.state === 'EVALUATING' && now.getTime() - Date.parse(experiment.createdAt) >= (BUILD_HOURS + EVALUATE_HOURS) * HOUR) {
    await hold(experiment, `the evaluator recorded no decidable comparison within ${EVALUATE_HOURS} h of the build window`, now);
  }
  experiment = await getExperiment(experimentId);
  return experiment;
}

async function hold(experiment: Experiment, why: string, now: Date): Promise<void> {
  if (!(await transitionExperiment(experiment.id, experiment.state, 'HELD', { rationale: why, decidedAt: now.toISOString() }))) return;
  for (const v of await listVariants(experiment.id)) {
    if (v.candidateId) await decideCandidate(v.candidateId, 'HELD', `Experiment ${experiment.id} held: ${why}`, { heldOn: why.slice(0, 300) });
  }
  await decideCandidate(experiment.candidateId, 'HELD', `Experiment ${experiment.id} held: ${why}`, { heldOn: why.slice(0, 300) });
  await recordImprovementEvent({ candidateId: experiment.candidateId, kind: EXPERIMENT_EVENTS.held, detail: { experimentId: experiment.id, why } });
}

/** Experiments the evaluator should score now, each with its baseline and every variant's pull-request head. */
export async function pendingEvaluations(now = new Date()): Promise<PendingEvaluation[]> {
  for (const e of await listExperiments({ states: ['BUILDING', 'EVALUATING'] })) {
    await refreshExperiment(e.id, now);
  }
  const out: PendingEvaluation[] = [];
  for (const e of await listExperiments({ states: ['EVALUATING'] })) {
    const ready = (await listVariants(e.id)).filter((v) => v.state === 'PR_READY' && v.headSha);
    out.push({
      id: e.id,
      suite: e.suite,
      baseline_sha: e.baselineSha,
      variants: ready.map((v) => ({ id: v.id, label: v.label, approach_type: v.approachType, head_sha: v.headSha!, branch: v.branch, pr_number: prNumber(v.prUrl), pr_url: v.prUrl })),
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Recording and deciding                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Record one evaluator result. With an experiment, it must be evaluating, the suite must be the
 * experiment's, and a variant must be one of its own; without a variant it is the baseline.
 * Without an experiment it is a standalone production baseline (what the deficiency detector reads).
 */
export async function recordResult(input: {
  experimentId: string | null;
  variantId: string | null;
  result: BenchResult;
  hidden?: boolean;
  linesChanged?: number | null;
}): Promise<{ ok: true; resultId: string } | { ok: false; reason: string }> {
  const suite = findSuite(input.result.suite);
  if (!suite) return { ok: false, reason: `suite "${input.result.suite}" is not registered` };
  if (input.experimentId) {
    const experiment = await getExperiment(input.experimentId);
    if (!experiment) return { ok: false, reason: `no experiment ${input.experimentId}` };
    if (experiment.state !== 'EVALUATING') return { ok: false, reason: `experiment ${experiment.id} is ${experiment.state}, not EVALUATING` };
    if (experiment.suite !== suite.name) return { ok: false, reason: `experiment ${experiment.id} is judged on ${experiment.suite}, not ${suite.name}` };
    if (input.variantId) {
      const variant = await getVariant(input.variantId);
      if (!variant || variant.experimentId !== experiment.id) return { ok: false, reason: `variant ${input.variantId} is not one of experiment ${experiment.id}'s` };
      if (variant.state !== 'PR_READY') return { ok: false, reason: `variant ${variant.id} is ${variant.state}` };
      if (typeof input.linesChanged === 'number' && Number.isFinite(input.linesChanged) && input.linesChanged >= 0) {
        await linkVariant(variant.id, { linesChanged: Math.round(input.linesChanged) });
      }
    }
  } else if (input.variantId) {
    return { ok: false, reason: 'a variant result belongs to an experiment' };
  }
  const row = await insertResult({
    experimentId: input.experimentId,
    variantId: input.variantId,
    sha: input.result.sha,
    ref: input.result.ref,
    suite: suite.name,
    metrics: input.result.metrics,
    cases: input.result.cases,
    hidden: input.hidden ?? input.result.hidden === true,
    cause: input.result.cause ?? null,
    ownerPaths: input.result.ownerPaths ?? [],
    ranAt: input.result.ranAt,
  });
  if (input.experimentId) {
    const experiment = (await getExperiment(input.experimentId))!;
    await recordImprovementEvent({ candidateId: experiment.candidateId, kind: EXPERIMENT_EVENTS.result, detail: { experimentId: experiment.id, variantId: input.variantId, resultId: row.id, sha: row.sha, hidden: row.hidden, metrics: row.metrics } });
  }
  return { ok: true, resultId: row.id };
}

/**
 * The scores selection reads: the latest result of each subject. Hidden-case results are used
 * when the baseline and every scored variant have one (so all are judged on the same cases);
 * otherwise the public ones.
 */
export function scoresFor(results: readonly EvolutionResult[], variantIds: readonly string[]): { baseline: Record<string, number> | null; variants: Map<string, Record<string, number>>; hidden: boolean } {
  const latest = (subject: string | null, hidden: boolean): EvolutionResult | null =>
    results.filter((r) => r.variantId === subject && r.hidden === hidden).sort((a, b) => (a.ranAt < b.ranAt ? -1 : a.ranAt > b.ranAt ? 1 : a.recordedAt < b.recordedAt ? -1 : 1)).at(-1) ?? null;
  const scoredVariants = variantIds.filter((id) => results.some((r) => r.variantId === id));
  const hidden = latest(null, true) !== null && scoredVariants.length > 0 && scoredVariants.every((id) => latest(id, true) !== null);
  const variants = new Map<string, Record<string, number>>();
  for (const id of scoredVariants) {
    const r = latest(id, hidden);
    if (r) variants.set(id, r.metrics);
  }
  return { baseline: latest(null, hidden)?.metrics ?? null, variants, hidden };
}

export type DecideResult =
  | { ok: false; reason: string; verdict?: 'INSUFFICIENT'; selection?: Selection }
  | {
      ok: true;
      experimentId: string;
      verdict: 'ADOPT' | 'REJECTED_ALL';
      winner: { variantId: string; label: string; candidateId: string | null; campaignId: string | null; prNumber: number | null; release: string } | null;
      /** Pull requests the evaluator closes: every variant not adopted. */
      closePullRequests: number[];
      selection: Selection;
      retired: string[];
    };

/** Decide an evaluating experiment from its recorded scores, once. */
export async function decide(experimentId: string, now = new Date()): Promise<DecideResult> {
  const experiment = await getExperiment(experimentId);
  if (!experiment) return { ok: false, reason: `no experiment ${experimentId}` };
  if (experiment.state !== 'EVALUATING') return { ok: false, reason: `experiment ${experiment.id} is ${experiment.state}${experiment.verdict ? ` (${experiment.verdict})` : ''}, not EVALUATING` };
  const suite = findSuite(experiment.suite);
  if (!suite) return { ok: false, reason: `suite ${experiment.suite} is no longer registered` };
  const variants = await listVariants(experiment.id);
  const ready = variants.filter((v) => v.state === 'PR_READY');
  const scores = scoresFor(await listResults(experiment.id), ready.map((v) => v.id));
  const selection = selectVariant(
    scores.baseline,
    ready.filter((v) => scores.variants.has(v.id)).map((v) => ({ id: v.id, metrics: scores.variants.get(v.id) ?? null, linesChanged: v.linesChanged })),
    suite,
  );
  if (selection.verdict === 'INSUFFICIENT') return { ok: false, verdict: 'INSUFFICIENT', reason: selection.rationale, selection };
  const rationale = `${selection.verdict}${scores.hidden ? ' (hidden cases)' : ' (public cases)'}: ${selection.rationale}`.slice(0, 2000);
  if (!(await transitionExperiment(experiment.id, 'EVALUATING', 'DECIDED', { verdict: selection.verdict, winnerVariantId: selection.winner, rationale, decidedAt: now.toISOString() }))) {
    return { ok: false, reason: `experiment ${experiment.id} was decided by another caller` };
  }
  const byId = new Map(selection.ranking.map((r) => [r.id, r]));
  let winner: Extract<DecideResult, { ok: true }>['winner'] = null;
  const close: number[] = [];
  for (const v of variants) {
    const rank = byId.get(v.id) ?? null;
    const score = rank ? { ...rank } : { reason: v.state === 'FAILED' ? 'did not reach a pull request' : 'not scored by the evaluator' };
    if (v.id === selection.winner) {
      await transitionVariant(v.id, ['PR_READY'], 'ADOPTED', score);
      let release = 'no campaign to release';
      if (v.candidateId) {
        const candidate = await getCandidate(v.candidateId);
        if (candidate) {
          await patchCandidate(candidate.id, { evidence: { ...candidate.evidence, experiment: { id: experiment.id, role: 'VARIANT', variantId: v.id, adopted: true } } });
          if (candidate.changeRequestId) {
            const { getChangeRequest } = await import('../../repos/factory.ts');
            const cr = await getChangeRequest(candidate.changeRequestId);
            const { grantStandingRelease } = await import('../improvement/loop.ts');
            release = cr ? (await grantStandingRelease(cr.id, cr.riskClass, 'evolution-evaluator')).detail : 'the change request is gone';
          }
          await recordImprovementEvent({ candidateId: candidate.id, kind: 'EXPERIMENT_ADOPTED', detail: { experimentId: experiment.id, score, release } });
        }
      }
      winner = { variantId: v.id, label: v.label, candidateId: v.candidateId, campaignId: v.campaignId, prNumber: prNumber(v.prUrl), release };
    } else {
      await transitionVariant(v.id, ['PR_READY', 'BUILDING', 'FAILED'], 'REJECTED', score);
      const n = prNumber(v.prUrl);
      if (n !== null) close.push(n);
      if (v.candidateId) {
        const why = `Experiment ${experiment.id} ${selection.verdict}: variant ${v.label} (${v.approachType}) not adopted — ${String((score as { reason?: string }).reason ?? '')}`.slice(0, 1000);
        await decideCandidate(v.candidateId, 'REJECTED', why, { result: { experiment: experiment.id, score } });
        await recordImprovementEvent({ candidateId: v.candidateId, kind: 'DECIDED', detail: { decision: 'REJECTED', experimentId: experiment.id, score } });
      }
    }
  }
  // The parent closes into the winner, whose campaign §87 measures after release; or, when none
  // qualified, it is rejected and the next attempt must change method (invariant 16).
  if (selection.verdict === 'ADOPT' && winner?.candidateId) {
    await decideCandidate(experiment.candidateId, 'COMBINED', `Experiment ${experiment.id} adopted variant ${winner.label}: ${selection.rationale}`.slice(0, 1000), { combinedIntoId: winner.candidateId });
  } else {
    await decideCandidate(experiment.candidateId, 'REJECTED', `Experiment ${experiment.id}: ${rationale}`.slice(0, 1000), {
      result: { experiment: experiment.id, ranking: selection.ranking },
    });
  }
  // Learn which approach types work for this class of capability.
  const retired: string[] = [];
  for (const v of variants) {
    const rank = byId.get(v.id);
    if (!rank || rank.primary === null) continue;
    const stat = await creditApproach({ approachType: v.approachType, capabilityClass: experiment.capabilityClass, won: v.id === selection.winner, lift: rank.lift ?? 0 });
    if (shouldRetire(stat) && (await retireApproach(stat.approachType, stat.capabilityClass))) retired.push(`${stat.approachType}@${stat.capabilityClass}`);
  }
  await recordImprovementEvent({
    candidateId: experiment.candidateId,
    kind: EXPERIMENT_EVENTS.decided,
    detail: { experimentId: experiment.id, verdict: selection.verdict, winner: selection.winner, hidden: scores.hidden, rationale, ranking: selection.ranking, retired, closePullRequests: close },
  });
  return { ok: true, experimentId: experiment.id, verdict: selection.verdict, winner, closePullRequests: close, selection, retired };
}

/* ------------------------------------------------------------------------- */
/* Reading                                                                    */
/* ------------------------------------------------------------------------- */

/** Every experiment with its variants, scores (never a hidden case), verdict, and what the approach types have won. */
export async function readExperiments(options: { limit?: number } = {}): Promise<{
  experiments: Record<string, unknown>[];
  approachTypes: Record<string, ReturnType<typeof rankApproachTypes>>;
  yield: ReturnType<typeof experimentYield>;
  hiddenCases: Record<string, number>;
  suites: { name: string; capabilityClass: string; primaryMetric: string; direction: string; target: unknown; guards: unknown }[];
}> {
  const experiments = await listExperiments({ limit: options.limit ?? 20 });
  const out: Record<string, unknown>[] = [];
  const summaries = [];
  for (const e of experiments) {
    const parent = await getCandidate(e.candidateId);
    const variants = await listVariants(e.id);
    const results = await listResults(e.id);
    summaries.push({ createdAt: e.createdAt, identifiedAt: parent?.createdAt ?? null, decidedAt: e.decidedAt, verdict: e.verdict });
    out.push({
      ...e,
      weaknessKey: parent?.weaknessKey ?? null,
      title: parent?.title ?? null,
      variants: variants.map((v: Variant) => ({
        id: v.id,
        label: v.label,
        approachType: v.approachType,
        approach: v.approachText.slice(0, 400),
        state: v.state,
        candidateId: v.candidateId,
        campaignId: v.campaignId,
        prUrl: v.prUrl,
        headSha: v.headSha,
        linesChanged: v.linesChanged,
        score: v.score,
      })),
      results: results.map((r) => ({ id: r.id, variantId: r.variantId, sha: r.sha, hidden: r.hidden, metrics: r.metrics, cases: r.cases.length, passed: r.cases.filter((c) => c.pass).length, ranAt: r.ranAt })),
    });
  }
  const stats = await listApproachStats();
  const classes = [...new Set([...EVOLUTION_SUITES.map((s) => s.capabilityClass), ...stats.map((s) => s.capabilityClass)])];
  return {
    experiments: out,
    approachTypes: Object.fromEntries(classes.map((c) => [c, rankApproachTypes(stats, c)])),
    yield: experimentYield(summaries),
    hiddenCases: await countHiddenCases(),
    suites: EVOLUTION_SUITES.map((s) => ({ name: s.name, capabilityClass: s.capabilityClass, primaryMetric: s.primaryMetric, direction: s.direction, target: s.target, guards: s.guards })),
  };
}

/* ------------------------------------------------------------------------- */
/* Hidden cases                                                               */
/* ------------------------------------------------------------------------- */

/** The largest hidden case accepted, serialized. */
export const HIDDEN_CASE_MAX_BYTES = 20_000;

/**
 * Add a case only the evaluator reads (§111). Stored in the database alone — never written to
 * the repository, never returned by any read an implementing agent can reach — so a variant
 * cannot be fitted to it.
 */
export async function addHiddenCase(input: { suite: string; testCase: Record<string, unknown>; reason: string | null; createdBy: string }): Promise<{ ok: boolean; reason: string; id?: string }> {
  const suite = findSuite(input.suite);
  if (!suite) return { ok: false, reason: `suite "${input.suite}" is not registered: one of ${EVOLUTION_SUITES.map((s) => s.name).join(', ')}` };
  const id = input.testCase['id'];
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(id)) return { ok: false, reason: 'case.id must be a short identifier (letters, digits, _ . : -)' };
  const serialized = JSON.stringify(input.testCase);
  if (serialized.length > HIDDEN_CASE_MAX_BYTES) return { ok: false, reason: `the case is ${serialized.length} bytes; at most ${HIDDEN_CASE_MAX_BYTES}` };
  const { listHiddenCases, insertHiddenCase } = await import('../../repos/evolution.ts');
  if ((await listHiddenCases(suite.name)).some((c) => (c.case as { id?: unknown } | null)?.id === id)) return { ok: false, reason: `suite ${suite.name} already holds a hidden case ${id}` };
  const row = await insertHiddenCase({
    suite: suite.name,
    caseJson: { ...input.testCase, ...(input.reason ? { _reason: input.reason.slice(0, 500) } : {}) },
    createdBy: input.createdBy.slice(0, 120),
  });
  return { ok: true, reason: `hidden case ${id} added to ${suite.name}; only the evaluator reads it`, id: row.id };
}


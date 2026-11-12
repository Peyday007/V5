/**
 * The operator's decisions: reviewed, challenged, predicted, then judged (§108).
 *
 * Built on owners Brain already has, not beside them:
 *   - the prediction ledger (`quant/ledger.ts`): every committed decision is a
 *     PREDICTION with a probability, a horizon and a comparable key
 *     (`operator:<kind>`), and its verification is an OUTCOME with the causes
 *     the measured signals support — so `forecast.ts`'s calibration judges the
 *     operator over repeated comparable outcomes, never over one miss;
 *   - the goal decisions (`goals/decide.ts`): pausing and resuming are the
 *     same writers a person's decision uses;
 *   - the models Brain already has (the GPU, the free switchboard) for the
 *     challenge — a second model, never a paid frontier API.
 *
 * A decision is an event (`OPERATOR_DECISION`) carrying the whole record; the
 * ledger rows carry the claim. Nothing is edited after it is written.
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import { recordEvent } from '../../repos/events.ts';
import { getWorkstream } from '../../repos/register.ts';
import { challengePrompt, parseChallenge, reviewDecision, type Challenge, type DecisionInput, type DecisionReview } from '../../domain/decision.ts';
import { chatFor, firstJson } from '../cheap/modelBench.ts';
import type { OperatorModel } from '../../domain/operator.ts';

export interface DecisionRecord {
  id: string;
  input: DecisionInput;
  review: DecisionReview;
  challenge: Challenge | null;
  predictionId: string;
  projectId: string;
  committedAt: string;
}

export interface DecideResult {
  committed: boolean;
  decisionId: string | null;
  verdict: 'COMMITTED' | 'REVISE' | 'REFUSED';
  problems: string[];
  review: DecisionReview;
  challenge: Challenge | null;
  next: string;
}

/** Ask a second model to attack the decision. Null when no model answered in time. */
export async function challengeDecision(input: DecisionInput, review: DecisionReview, models: OperatorModel[], fetchImpl: typeof fetch = fetch): Promise<Challenge | null> {
  const prompt = challengePrompt(input, review);
  for (const model of models) {
    const chat = chatFor({ label: model.label, url: model.baseUrl, key: model.apiKey, model: model.model, usdPerHour: null }, fetchImpl, 120_000);
    const r = await chat(
      [
        { role: 'system', content: 'You are a rigorous challenger. Answer with exactly one JSON object.' },
        { role: 'user', content: prompt },
      ],
      undefined,
      3000,
    );
    if (r.error) continue;
    const parsed = parseChallenge(firstJson(r.content), model.label);
    if (parsed) return parsed;
  }
  return null;
}

async function projectFor(goalId: string | null, fallback: string): Promise<string> {
  if (!goalId) return fallback;
  const goal = await getWorkstream(goalId);
  return goal?.projectId ?? fallback;
}

/**
 * Review, challenge when it matters, then commit: the event and the ledger
 * prediction. A REVISE from the challenger is returned without committing,
 * unless the operator already answered it (`answeredChallenge`).
 */
export async function decide(
  input: DecisionInput & { answeredChallenge?: string | null },
  ctx: { runId: string | null; projectIds: string[]; models: OperatorModel[]; fetchImpl?: typeof fetch },
): Promise<DecideResult> {
  const review = reviewDecision(input);
  if (!review.ok) return { committed: false, decisionId: null, verdict: 'REFUSED', problems: review.problems, review, challenge: null, next: 'Fix the problems and call again.' };
  if (input.goalId) {
    const goal = await getWorkstream(input.goalId);
    if (!goal || !goal.projectId || !ctx.projectIds.includes(goal.projectId)) {
      return { committed: false, decisionId: null, verdict: 'REFUSED', problems: ['no such goal in a project the operator directs'], review, challenge: null, next: 'Use a goal id from brain_operator_goals.' };
    }
  }
  let challenge: Challenge | null = null;
  if (review.highImpact) {
    challenge = await challengeDecision(input, review, ctx.models, ctx.fetchImpl);
    if (challenge?.verdict === 'REVISE' && !(input.answeredChallenge ?? '').trim()) {
      return {
        committed: false,
        decisionId: null,
        verdict: 'REVISE',
        problems: [],
        review,
        challenge,
        next: 'The challenger found a flaw that could change the choice. Revise the options, or call again with answered_challenge saying why the choice stands.',
      };
    }
  }
  const id = `opd_${randomBytes(8).toString('hex')}`;
  const projectId = await projectFor(input.goalId, ctx.projectIds[0] ?? '');
  const { recordPrediction } = await import('../quant/ledger.ts');
  const prediction = await recordPrediction(
    {
      claimId: `operator:${id}`,
      outcome: input.prediction.outcome.slice(0, 400),
      horizonDays: input.prediction.horizonDays,
      population: `operator decisions of kind ${input.kind}`,
      data: (review.options[input.chosen]?.evidence ?? []).slice(0, 10),
      assumptions: input.assumptions.slice(0, 10),
      probability: input.prediction.probability,
      comparableKey: `operator:${input.kind}`,
    },
    { projectId, caller: 'operator-decision' },
  );
  const committedAt = new Date().toISOString();
  await recordEvent({
    projectId,
    entityType: 'PROJECT',
    entityId: id,
    eventType: 'OPERATOR_DECISION',
    payload: { id, runId: ctx.runId, input, review, challenge: challenge ?? (review.highImpact ? 'no challenger model answered' : 'not high impact'), predictionId: prediction.id, committedAt },
  });
  return {
    committed: true,
    decisionId: id,
    verdict: 'COMMITTED',
    problems: [],
    review,
    challenge,
    next: `Act on it now, then verify it with brain_operator_verify {decision_id: "${id}"} once ${input.prediction.horizonDays} day(s) have passed or the outcome is observable.`,
  };
}

export async function readDecision(id: string): Promise<DecisionRecord | null> {
  const row = await getDb().get<{ project_id: string; payload: string }>(
    `SELECT project_id, payload FROM project_events WHERE event_type = 'OPERATOR_DECISION' AND entity_id = ? ORDER BY created_at ASC LIMIT 1`,
    [id],
  );
  if (!row) return null;
  const p = JSON.parse(row.payload) as Record<string, unknown>;
  return {
    id,
    input: p['input'] as DecisionInput,
    review: p['review'] as DecisionReview,
    challenge: typeof p['challenge'] === 'object' ? (p['challenge'] as Challenge) : null,
    predictionId: String(p['predictionId']),
    projectId: row.project_id,
    committedAt: String(p['committedAt']),
  };
}

/** Decisions with no outcome yet, oldest first: what the operator owes a verification. */
export async function openDecisions(limit = 10): Promise<{ id: string; kind: string; goalId: string | null; outcome: string; probability: number; dueAt: string; overdue: boolean }[]> {
  const rows = await getDb().all<{ entity_id: string; payload: string }>(
    `SELECT entity_id, payload FROM project_events WHERE event_type = 'OPERATOR_DECISION'
       AND entity_id NOT IN (SELECT entity_id FROM project_events WHERE event_type = 'OPERATOR_DECISION_VERIFIED' AND entity_id IS NOT NULL)
     ORDER BY created_at ASC LIMIT ?`,
    [limit],
  );
  const now = Date.now();
  return rows.map((r) => {
    const p = JSON.parse(r.payload) as { input: DecisionInput; committedAt: string };
    const due = Date.parse(p.committedAt) + p.input.prediction.horizonDays * 86_400_000;
    return { id: r.entity_id, kind: p.input.kind, goalId: p.input.goalId, outcome: p.input.prediction.outcome, probability: p.input.prediction.probability, dueAt: new Date(due).toISOString(), overdue: due < now };
  });
}

export interface VerifyInput {
  decisionId: string;
  occurred: boolean;
  evidence: string;
  /** What the measurement showed about why, when it missed. */
  signals?: {
    assumptionBroke?: boolean;
    executionDeviated?: boolean;
    mechanismMissing?: boolean;
    capacityShortfall?: boolean;
    arrivedLate?: boolean;
  };
  brokenAssumption?: string | null;
}

/**
 * Record what happened, once, and return what the ledger now says about the
 * operator's decisions of this kind. One miss names a cause from its signals;
 * calibration is only judged over enough comparable outcomes.
 */
export async function verify(input: VerifyInput, ctx: { runId: string | null; projectIds: string[] }): Promise<Record<string, unknown>> {
  const decision = await readDecision(input.decisionId);
  if (!decision || !ctx.projectIds.includes(decision.projectId)) return { ok: false, reason: 'no such decision in a project the operator directs' };
  if (!input.evidence.trim()) return { ok: false, reason: 'state the evidence: the rows or readings the outcome was observed in' };
  const judged = await getDb().get<{ id: string }>(`SELECT id FROM project_events WHERE event_type = 'OPERATOR_DECISION_VERIFIED' AND entity_id = ? LIMIT 1`, [decision.id]);
  if (judged) return { ok: false, reason: 'this decision was already judged; an outcome is never overwritten' };
  const { recordOutcome, readLedger } = await import('../quant/ledger.ts');
  try {
    await recordOutcome(decision.predictionId, input.occurred, input.signals ?? {}, { projectId: decision.projectId, evidence: input.evidence.slice(0, 300), caller: 'operator-decision' });
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  await recordEvent({
    projectId: decision.projectId,
    entityType: 'PROJECT',
    entityId: decision.id,
    eventType: 'OPERATOR_DECISION_VERIFIED',
    payload: { decisionId: decision.id, runId: ctx.runId, occurred: input.occurred, evidence: input.evidence.slice(0, 600), signals: input.signals ?? {}, brokenAssumption: input.brokenAssumption ?? null },
  });
  const ledger = await readLedger(decision.projectId);
  return { ok: true, decisionId: decision.id, ...operatorCalibration(ledger, `operator:${decision.input.kind}`) };
}

/** The operator's own record on the ledger for one comparable key: forecasts against what happened. */
export function operatorCalibration(
  ledger: { predictions: { id: string; comparableKey: string; probability: number | null }[]; outcomes: { predictionId: string; occurred: boolean; observedCauses?: readonly string[] }[] },
  comparableKey: string,
): Record<string, unknown> {
  const predictions = ledger.predictions.filter((p) => p.comparableKey === comparableKey && p.probability !== null);
  const judged = predictions
    .map((p) => ({ p, o: ledger.outcomes.find((o) => o.predictionId === p.id) }))
    .filter((x): x is { p: (typeof predictions)[number]; o: (typeof ledger.outcomes)[number] } => !!x.o);
  const n = judged.length;
  const meanForecast = n ? judged.reduce((s, x) => s + (x.p.probability ?? 0), 0) / n : null;
  const hitRate = n ? judged.filter((x) => x.o.occurred).length / n : null;
  const brier = n ? judged.reduce((s, x) => s + ((x.p.probability ?? 0) - (x.o.occurred ? 1 : 0)) ** 2, 0) / n : null;
  const causes = new Map<string, number>();
  for (const x of judged) if (!x.o.occurred) for (const c of x.o.observedCauses ?? []) causes.set(c, (causes.get(c) ?? 0) + 1);
  const enough = n >= 10;
  return {
    comparableKey,
    judged: n,
    meanForecast,
    hitRate,
    brier,
    missCauses: Object.fromEntries(causes),
    reading: !enough
      ? `${n} judged decision(s) of this kind — too few to call the operator's probabilities calibrated or not; investigate each miss by its cause instead`
      : Math.abs((meanForecast ?? 0) - (hitRate ?? 0)) > 0.15
        ? `over ${n} comparable decisions the forecasts averaged ${(meanForecast! * 100).toFixed(0)}% and ${(hitRate! * 100).toFixed(0)}% happened: ${meanForecast! > hitRate! ? 'overconfident — lower probabilities of this kind, and fix the most frequent miss cause' : 'underconfident'}`
        : `over ${n} comparable decisions forecasts and outcomes agree within 15 points (Brier ${brier!.toFixed(3)})`,
  };
}

/**
 * Move capacity between goals by pausing or resuming one, under a committed
 * decision of that kind. Never a goal owed to a customer or committed to
 * somebody (those are the person's to pause), and never without the decision.
 */
export async function setGoalFocus(
  input: { goalId: string; action: 'PAUSE' | 'RESUME'; decisionId: string; reason: string },
  ctx: { runId: string | null; projectIds: string[] },
): Promise<{ ok: boolean; reason: string; consequence?: string }> {
  const decision = await readDecision(input.decisionId);
  const kind = input.action === 'PAUSE' ? 'PAUSE_GOAL' : 'RESUME_GOAL';
  if (!decision || decision.input.kind !== kind || decision.input.goalId !== input.goalId) {
    return { ok: false, reason: `commit a ${kind} decision for this goal first (brain_operator_decide), then pass its id` };
  }
  const goal = await getWorkstream(input.goalId);
  if (!goal || !goal.projectId || !ctx.projectIds.includes(goal.projectId)) return { ok: false, reason: 'no such goal in a project the operator directs' };
  if (input.action === 'PAUSE' && goal.commitment !== 'NONE') {
    return { ok: false, reason: `the goal is committed (${goal.commitment}); only a person pauses a commitment` };
  }
  const { pause, resume } = await import('../goals/decide.ts');
  const actor = `operator:${ctx.runId ?? 'run'}`;
  const result = input.action === 'PAUSE' ? await pause(input.goalId, `${input.reason} (decision ${decision.id})`.slice(0, 500), actor) : await resume(input.goalId, actor);
  if (result.ok) {
    await recordEvent({
      projectId: goal.projectId,
      entityType: 'PROJECT',
      entityId: input.goalId,
      eventType: 'OPERATOR_GOAL_FOCUS',
      payload: { goalId: input.goalId, action: input.action, decisionId: decision.id, runId: ctx.runId, reason: input.reason.slice(0, 500), consequence: result.consequence },
    });
  }
  return { ok: result.ok, reason: result.reason ?? 'done', consequence: result.consequence };
}

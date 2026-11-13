/**
 * Telling the owner the moment a cash goal has a viable, actionable plan (owner, 2026-11-13).
 *
 * Nothing here plans, scores or tracks anything of its own. It reads what Brain already
 * keeps — the goal's plan reading and §95's acceptance (`plan.ts`), the quant portfolio, the
 * stored readings in `goal_plan_readings`, and the operator's committed ADOPT_PLAN decision
 * with its challenge (`operator/decisions.ts`, §108) — asks `planReady` whether the plan
 * qualifies, and sends one email through the owner-notice channel the self-improvement notice
 * already uses (`deliverOwnerEmail`). Once per accepted plan: the key is the goal and the set of
 * openings the plan stands on, and the composed text is stored before the first attempt.
 *
 * It stops nothing: an accepted plan's openings stay linked PURSUES, a SQUEEZE goal keeps
 * widening its search until the target is collected, and Hermes keeps directing it.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import { recordEvent } from '../../repos/events.ts';
import { getWorkstream, recordWorkstreamEvent } from '../../repos/register.ts';
import { planReady, planReadyNotice, type PlanReadyFacts, type PlanReadyCondition } from '../../domain/planReady.ts';
import type { PlanReading } from './plan.ts';

export const PLAN_READY_EVENT = 'OWNER_PLAN_READY_NOTIFIED' as const;

export interface PlanReadyResult {
  goalId: string;
  status: 'SENT' | 'ALREADY_SENT' | 'NOT_READY' | 'NO_READING' | 'NO_CHANNEL' | 'NO_RECIPIENT' | 'UNCERTAIN' | 'FAILED' | 'BUSY';
  detail: string;
  conditions?: Record<PlanReadyCondition, string | null>;
}

const inFlight = new Set<string>();

function setKey(ids: string[]): string {
  return [...ids].sort().join(',');
}

export function planReadyKey(goalId: string, opportunityIds: string[]): string {
  return `plan-ready.${goalId}.${createHash('sha256').update(setKey(opportunityIds)).digest('hex').slice(0, 16)}`;
}

/** The notice rows for one key, newest first: INTENT, then SENT, UNCERTAIN or FAILED. */
async function noticeRows(key: string): Promise<{ status: string; payload: Record<string, unknown>; projectId: string; at: string }[]> {
  const rows = await getDb().all<{ payload: string; project_id: string; created_at: string }>(
    `SELECT payload, project_id, created_at FROM project_events WHERE event_type = ? AND entity_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`,
    [PLAN_READY_EVENT, key],
  );
  return rows.map((r) => {
    const payload = JSON.parse(r.payload) as Record<string, unknown>;
    return { status: String(payload['status'] ?? ''), payload, projectId: r.project_id, at: r.created_at };
  });
}

/** When this accepted plan (the same openings) was first read as ACCEPTED, from the stored readings. */
async function acceptedSince(goalId: string, opportunityIds: string[]): Promise<string | null> {
  const want = setKey(opportunityIds);
  const rows = await getDb().all<{ forecast: string | null; created_at: string }>(
    `SELECT forecast, created_at FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at ASC, id ASC`,
    [goalId],
  );
  for (const row of rows) {
    try {
      const a = (JSON.parse(row.forecast ?? '{}') as { acceptance?: { status?: string; accepted?: { opportunityIds?: string[] } | null } }).acceptance;
      if (a?.status === 'ACCEPTED' && setKey(a.accepted?.opportunityIds ?? []) === want) return row.created_at;
    } catch {
      /* an unreadable row is not an acceptance */
    }
  }
  return null;
}

/** The operator's latest committed ADOPT_PLAN decision on this goal (§108's record, never edited). */
async function adoption(goalId: string): Promise<PlanReadyFacts['hermes']> {
  const rows = await getDb().all<{ entity_id: string; payload: string }>(
    `SELECT entity_id, payload FROM project_events WHERE event_type = 'OPERATOR_DECISION' AND payload LIKE ? ORDER BY created_at DESC LIMIT 20`,
    ['%"ADOPT_PLAN"%'],
  );
  for (const row of rows) {
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    const input = (p['input'] ?? {}) as Record<string, unknown>;
    if (input['kind'] !== 'ADOPT_PLAN' || input['goalId'] !== goalId) continue;
    const options = Array.isArray(input['options']) ? (input['options'] as { action?: string }[]) : [];
    const chosen = Number(input['chosen']);
    const challenge = typeof p['challenge'] === 'object' && p['challenge'] !== null ? (p['challenge'] as Record<string, unknown>) : null;
    const prediction = (input['prediction'] ?? {}) as Record<string, unknown>;
    return {
      decisionId: row.entity_id,
      committedAt: String(p['committedAt'] ?? ''),
      chosenAction: String(options[chosen]?.action ?? ''),
      // By the brief's convention option 0 is "execute the accepted plan as it stands".
      adopted: chosen === 0,
      challenge: challenge
        ? {
            verdict: String(challenge['verdict'] ?? ''),
            model: String(challenge['model'] ?? ''),
            reasons: String(challenge['reasons'] ?? ''),
            hiddenAssumptions: Array.isArray(challenge['hiddenAssumptions']) ? (challenge['hiddenAssumptions'] as unknown[]).map(String) : [],
            missingVariables: Array.isArray(challenge['missingVariables']) ? (challenge['missingVariables'] as unknown[]).map(String) : [],
            strongerAlternative: typeof challenge['strongerAlternative'] === 'string' ? (challenge['strongerAlternative'] as string) : null,
          }
        : null,
      answeredChallenge: typeof input['answeredChallenge'] === 'string' ? (input['answeredChallenge'] as string) : null,
      prediction: { outcome: String(prediction['outcome'] ?? ''), probability: Number(prediction['probability'] ?? 0), horizonDays: Number(prediction['horizonDays'] ?? 0) },
    };
  }
  return null;
}

/** Everything `planReady` judges, from one plan reading and the rows beside it. */
export async function planReadyFacts(goalId: string, reading: PlanReading): Promise<PlanReadyFacts> {
  const goal = await getWorkstream(goalId);
  const accepted = reading.acceptance.accepted;
  const pf = reading.portfolio;
  const best = pf?.best ?? null;
  const demand = new Map((pf?.demand ?? []).map((d) => [d.opportunityId, d]));
  const members = (best?.members ?? []).map((m) => {
    const d = demand.get(m.opportunityId);
    return {
      opportunityId: m.opportunityId,
      title: m.title,
      revenue: d ? { p10: d.revenue.p10, p50: d.revenue.p50, p90: d.revenue.p90 } : null,
      price: d ? { p50: d.price.p50 } : null,
      deals: d ? { p50: d.deals.p50 } : null,
      spend: d ? { p50: d.spend.p50 } : null,
      days: d ? { p50: d.days.p50, p90: d.days.p90 } : null,
      capitalAtStart: d ? d.capitalAtStart : null,
      justified: d?.justified === true,
      unestablished: d?.unestablished ?? ['no demand estimate'],
    };
  });
  const steps = [
    ...reading.sales.map((s) => ({ title: s.title, step: s.test.test, by: s.test.by, blocker: s.test.blocker })),
    ...(reading.nextTest ? [{ title: 'Next test', step: reading.nextTest.test, by: reading.nextTest.by, blocker: reading.nextTest.blocker }] : []),
  ];
  return {
    goalId,
    goalTitle: goal?.title ?? goalId,
    targetAmount: reading.target.targetCents / 100,
    remainingAmount: reading.target.remainingCents / 100,
    currency: reading.target.currency,
    daysLeft: reading.target.daysLeft,
    achieved: reading.target.achieved,
    verdict: reading.verdict,
    acceptance: {
      status: reading.acceptance.status,
      required: reading.acceptance.required,
      probability: reading.acceptance.probability,
      accepted,
      sentence: reading.acceptance.sentence,
    },
    summary: reading.summary,
    portfolio:
      pf && best
        ? { basis: pf.basis, worlds: pf.worlds, reach: best.reach, settledP10: best.settledP10, settledP50: best.settledP50, settledP90: best.settledP90, correlation: pf.limits.correlation, missing: pf.missing }
        : null,
    members,
    steps,
    hermes: await adoption(goalId),
    acceptedSince: accepted ? await acceptedSince(goalId, accepted.opportunityIds) : null,
  };
}

/**
 * Tell the owner once a goal's plan qualifies. Called with the reading just taken by the goal
 * tick, and — without one — the moment the operator commits its ADOPT_PLAN decision, when the
 * reading the tick holds (or a fresh, unpersisted one) is judged.
 */
export async function notifyPlanReady(goalId: string, given?: PlanReading | null, env?: NodeJS.ProcessEnv): Promise<PlanReadyResult> {
  let reading = given ?? null;
  if (!reading) {
    const { heldReading, readGoalPlan } = await import('./plan.ts');
    reading = heldReading(goalId);
    if (!reading) {
      try {
        reading = await readGoalPlan({ goalId, persist: false });
      } catch (error) {
        return { goalId, status: 'BUSY', detail: String((error as Error)?.message ?? error).slice(0, 200) };
      }
    }
  }
  if (!reading) return { goalId, status: 'NO_READING', detail: 'no plan reading for this goal' };
  // The cheap refusal first: nothing short of §95's acceptance is a plan to tell anyone about.
  if (reading.acceptance.status !== 'ACCEPTED' || !reading.acceptance.accepted) {
    return { goalId, status: 'NOT_READY', detail: `the plan is ${reading.acceptance.status}: ${reading.acceptance.sentence.slice(0, 200)}` };
  }
  const key = planReadyKey(goalId, reading.acceptance.accepted.opportunityIds);
  const rows = await noticeRows(key);
  const done = rows.find((r) => r.status === 'SENT' || r.status === 'UNCERTAIN');
  if (done) return { goalId, status: 'ALREADY_SENT', detail: `${done.status} at ${done.at}` };
  const facts = await planReadyFacts(goalId, reading);
  const judged = planReady(facts);
  if (!judged.ready) {
    return {
      goalId,
      status: 'NOT_READY',
      detail: Object.entries(judged.conditions).filter(([, why]) => why).map(([c, why]) => `${c}: ${why}`).join('; ').slice(0, 800),
      conditions: judged.conditions,
    };
  }
  if (inFlight.has(key)) return { goalId, status: 'BUSY', detail: 'a send for this plan is in progress' };
  inFlight.add(key);
  try {
    // The message is composed once and stored, so every attempt is the identical request (invariant 27).
    let intent = rows.find((r) => r.status === 'INTENT');
    if (!intent) {
      const projectId = reading.target.projectId;
      const notice = planReadyNotice(facts);
      await recordEvent({
        projectId,
        entityType: 'PROJECT',
        entityId: key,
        eventType: PLAN_READY_EVENT,
        payload: { status: 'INTENT', key, goalId, subject: notice.subject, text: notice.text, decisionId: facts.hermes?.decisionId ?? null, probability: facts.acceptance.probability },
      });
      intent = { status: 'INTENT', payload: { subject: notice.subject, text: notice.text }, projectId, at: new Date().toISOString() };
    }
    const { deliverOwnerEmail } = await import('../operator/director.ts');
    const sent = await deliverOwnerEmail({
      key,
      projectId: intent.projectId,
      businessId: key,
      subject: String(intent.payload['subject']),
      text: String(intent.payload['text']),
      principalId: 'brain-goal-planner',
      env,
    });
    if (sent.status === 'NO_CHANNEL' || sent.status === 'NO_RECIPIENT') return { goalId, status: sent.status, detail: sent.detail };
    const last = rows.find((r) => r.status === 'FAILED');
    if (sent.status !== 'FAILED' || last?.payload['detail'] !== sent.detail.slice(0, 400)) {
      await recordEvent({
        projectId: intent.projectId,
        entityType: 'PROJECT',
        entityId: key,
        eventType: PLAN_READY_EVENT,
        payload: { status: sent.status, key, goalId, channel: sent.channel, receipt: sent.receipt, detail: sent.detail.slice(0, 400) },
      });
    }
    if (sent.status === 'SENT') {
      await recordWorkstreamEvent({
        workstreamId: goalId,
        kind: 'OWNER_NOTIFIED_PLAN_READY',
        summary: `The owner was told the plan is ready: ${String(intent.payload['subject']).slice(0, 300)}`,
        detail: { key, channel: sent.channel, receipt: sent.receipt },
        actorRef: 'BRAIN',
      });
    }
    return { goalId, status: sent.status, detail: sent.detail };
  } finally {
    inFlight.delete(key);
  }
}

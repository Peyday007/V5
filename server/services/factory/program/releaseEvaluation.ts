/**
 * Post-deploy evaluation (GOV-17-3, Release 01 §17.3.4): after every deploy,
 * record whether the release increased useful commercial output or unlocked
 * the next causal link, read from cash and goal rows.
 *
 * It runs inside the program tick, which already runs on its own after every
 * boot, so a revision is evaluated once by the first tick that sees it — no
 * second scheduler and no hook in the deploy workflow. What it reads:
 *
 *   - settled cash: settlements less refunds in `cash_money_entries`;
 *   - buyer measurements: contact results and accepted prices in `cash_outcomes`;
 *   - the goals' plans: the newest reach each goal's plan reading recorded;
 *   - the causal links: the program's requirements verified on production.
 *
 * Each evaluation is compared with the one before it, so the record says what
 * this release changed, not what the business has done in total. Nothing here
 * decides anything; a release that moved nothing is recorded as exactly that.
 */
import { getDb } from '../../../db/database.ts';
import { listFactoryEvents, recordFactoryEvent } from '../../../repos/factoryFleet.ts';

export const RELEASE_EVALUATED = 'PROGRAM_RELEASE_EVALUATED';

export interface CommercialSnapshot {
  settledCents: number;
  contactResults: number;
  acceptedPrices: number;
  /** The best reach any goal's newest plan reading holds, 0..1; null when no goal has a reading. */
  bestGoalReach: number | null;
  verifiedRequirements: string[];
}

export interface ReleaseEvaluation {
  programId: string;
  revision: string;
  previousRevision: string | null;
  snapshot: CommercialSnapshot;
  deltas: { settledCents: number; contactResults: number; acceptedPrices: number; bestGoalReach: number | null };
  newlyVerified: string[];
  commercialOutputIncreased: boolean;
  causalLinkUnlocked: boolean;
}

export async function commercialSnapshot(verifiedRequirements: string[]): Promise<CommercialSnapshot> {
  const db = getDb();
  const money = await db.all<{ kind: string; total: number }>(
    `SELECT kind, COALESCE(SUM(amount_cents), 0) AS total FROM cash_money_entries
      WHERE kind IN ('SETTLEMENT', 'REFUND') GROUP BY kind ORDER BY kind`,
    [],
  );
  const total = (kind: string) => Number(money.find((row) => row.kind === kind)?.total ?? 0);
  const outcomes = await db.all<{ kind: string; n: number }>(
    `SELECT kind, COUNT(*) AS n FROM cash_outcomes
      WHERE kind IN ('CONTACT_RESULT', 'ACCEPTED_PRICE') GROUP BY kind ORDER BY kind`,
    [],
  );
  const count = (kind: string) => Number(outcomes.find((row) => row.kind === kind)?.n ?? 0);
  const readings = await db.all<{ workstream_id: string; forecast: string | null; created_at: string }>(
    `SELECT workstream_id, forecast, created_at FROM goal_plan_readings ORDER BY workstream_id, created_at, id`,
    [],
  );
  const newest = new Map<string, number | null>();
  for (const row of readings) {
    let reach: number | null = null;
    try {
      const parsed = row.forecast ? (JSON.parse(row.forecast) as { reach?: unknown }) : null;
      reach = typeof parsed?.reach === 'number' ? parsed.reach : null;
    } catch {
      reach = null;
    }
    newest.set(row.workstream_id, reach);
  }
  const reaches = [...newest.values()].filter((value): value is number => value !== null);
  return {
    settledCents: total('SETTLEMENT') - total('REFUND'),
    contactResults: count('CONTACT_RESULT'),
    acceptedPrices: count('ACCEPTED_PRICE'),
    bestGoalReach: reaches.length > 0 ? Math.max(...reaches) : null,
    verifiedRequirements: [...verifiedRequirements].sort(),
  };
}

/** The evaluations recorded for one program, oldest first. */
export async function releaseEvaluations(programId: string): Promise<ReleaseEvaluation[]> {
  const events = await listFactoryEvents(null, { kinds: [RELEASE_EVALUATED], limit: 1000 });
  return events
    .map((event) => event.detail as unknown as ReleaseEvaluation)
    .filter((detail) => detail.programId === programId);
}

/**
 * Evaluate the running revision once. Returns the evaluation recorded, or null
 * when this revision was already evaluated or the process carries no revision.
 */
export async function evaluateRelease(input: {
  programId: string;
  revision: string | null;
  verifiedRequirements: string[];
}): Promise<ReleaseEvaluation | null> {
  if (input.revision === null) return null;
  const earlier = await releaseEvaluations(input.programId);
  if (earlier.some((one) => one.revision === input.revision)) return null;
  const previous = earlier.at(-1) ?? null;
  const snapshot = await commercialSnapshot(input.verifiedRequirements);
  const before = previous?.snapshot ?? null;
  const deltas = {
    settledCents: snapshot.settledCents - (before?.settledCents ?? 0),
    contactResults: snapshot.contactResults - (before?.contactResults ?? 0),
    acceptedPrices: snapshot.acceptedPrices - (before?.acceptedPrices ?? 0),
    bestGoalReach:
      snapshot.bestGoalReach === null ? null : Math.round((snapshot.bestGoalReach - (before?.bestGoalReach ?? 0)) * 1000) / 1000,
  };
  const known = new Set(before?.verifiedRequirements ?? []);
  const newlyVerified = previous ? snapshot.verifiedRequirements.filter((key) => !known.has(key)) : [];
  const evaluation: ReleaseEvaluation = {
    programId: input.programId,
    revision: input.revision,
    previousRevision: previous?.revision ?? null,
    snapshot,
    deltas,
    newlyVerified,
    // Against nothing earlier there is no "increase": the first evaluation is the baseline.
    commercialOutputIncreased:
      previous !== null &&
      (deltas.settledCents > 0 || deltas.acceptedPrices > 0 || deltas.contactResults > 0 || (deltas.bestGoalReach ?? 0) > 0),
    causalLinkUnlocked: newlyVerified.length > 0,
  };
  await recordFactoryEvent({ kind: RELEASE_EVALUATED, evidenceClass: 'MEASURED', detail: evaluation as unknown as Record<string, unknown> });
  return evaluation;
}

/**
 * The r01.gov-17-3 probe: the running revision was evaluated, against an
 * earlier release, with both answers stated. Fails on a process with no
 * revision or an evaluation missing its answers. A revision not evaluated yet,
 * or the first one evaluated, is UNKNOWN: the evaluation is written at the end
 * of the tick after a release, so every deploy would otherwise read as a
 * regression and reopen the requirement until the next tick asked again.
 */
export async function releaseEvaluationHoldsOnRows(revision: string | null): Promise<{ ok: boolean | null; detail: string }> {
  if (revision === null) return { ok: false, detail: 'this process carries no BRAIN_REVISION, so no release can be named' };
  const events = await listFactoryEvents(null, { kinds: [RELEASE_EVALUATED], limit: 1000 });
  const all = events.map((event) => event.detail as unknown as ReleaseEvaluation);
  const current = all.filter((one) => one.revision === revision);
  if (current.length === 0) return { ok: null, detail: `revision ${revision.slice(0, 12)} has no post-deploy evaluation yet` };
  const compared = current.filter((one) => one.previousRevision !== null);
  if (compared.length === 0) return { ok: null, detail: `revision ${revision.slice(0, 12)} is the first evaluated release: there is no earlier one to compare with` };
  for (const one of compared) {
    if (typeof one.commercialOutputIncreased !== 'boolean' || typeof one.causalLinkUnlocked !== 'boolean') {
      return { ok: false, detail: `the evaluation of ${revision.slice(0, 12)} does not state both answers` };
    }
    if (!Number.isFinite(one.snapshot?.settledCents) || !Array.isArray(one.snapshot?.verifiedRequirements)) {
      return { ok: false, detail: `the evaluation of ${revision.slice(0, 12)} is not read from cash and program rows` };
    }
  }
  const one = compared[0]!;
  return {
    ok: true,
    detail:
      `${all.length} release(s) evaluated; ${revision.slice(0, 12)} against ${String(one.previousRevision).slice(0, 12)}: ` +
      `commercial output ${one.commercialOutputIncreased ? 'increased' : 'did not increase'} ` +
      `(settled ${one.deltas.settledCents}¢, accepted prices ${one.deltas.acceptedPrices}, contact results ${one.deltas.contactResults}), ` +
      `${one.causalLinkUnlocked ? `unlocked ${one.newlyVerified.join(', ')}` : 'no causal link unlocked'}`,
  };
}

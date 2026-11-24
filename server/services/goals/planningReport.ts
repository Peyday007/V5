/**
 * The planning report every financial objective is read through (owner's
 * permanent standard, 2026-11-23):
 *
 *   1. the financial goal and its deadline;
 *   2. the estimated real-world probability of reaching it;
 *   3. the evidence behind that probability;
 *   4. whether the plan is commercially validated;
 *   5. the most important remaining blocker.
 *
 * A real-world probability is one measured against real outcomes: the target
 * already met on the ledger, or this Brain's own record of how plans like this
 * one turned out (`MEASURED_RECORD`). Nothing else is one. Simulation coverage,
 * a Monte Carlo over evidenced inputs, a benchmark score and a scenario success
 * rate are statements about a model, so the report says UNKNOWN and names why
 * (audit of the $10K plan, 2026-11-23: "reach 0.98 (COVERAGE)" read as a 98%
 * chance of success).
 *
 * The planning stage reports no revenue earned: commercial execution is a
 * separate stage, and money already on the ledger appears only as how far
 * the goal has to go. Pure.
 */
import type { PlanReading } from './plan.ts';
import { LEG_LABEL } from './pathways.ts';
import type { CommitteeReading } from './committee.ts';
import { deadlineText } from '../../domain/executionWindow.ts';

export interface PlanningReport {
  goal: string;
  /** The calendar deadline, or null while a commercial execution window has not started (§119). */
  deadline: string | null;
  /** The deadline as the report states it: relative before commercial execution starts (§119). */
  deadlineText: string | null;
  probability: { value: number; lowerBound: number } | 'UNKNOWN';
  evidence: string;
  commerciallyValidated: boolean;
  /** Why the plan is or is not commercially validated, in one sentence. */
  validation: string;
  blocker: string | null;
}

const money = (cents: number, currency: string) => `${currency === 'USD' ? '$' : `${currency} `}${Math.round(cents / 100).toLocaleString('en-US')}`;

/** The five lines of the standard, from a plan reading. Pure. */
export function planningReport(
  reading: Pick<PlanReading, 'target' | 'acceptance' | 'measuredChance' | 'verdict' | 'summary'> & { commercialReality?: { validated: boolean; failing: readonly string[] } | null; committee?: Pick<CommitteeReading, 'verdict' | 'blocker'> | null },
  dueAt: string | null,
): PlanningReport {
  const t = reading.target;
  const goal = `${t.metricLabel} of ${money(t.targetCents, t.currency)}`;
  const a = reading.acceptance;
  const p = a.probability;
  const realWorld = p && (p.basis === 'TARGET_MET' || p.basis === 'MEASURED_RECORD');
  const probability = realWorld ? { value: p!.value, lowerBound: p!.lowerBound } : ('UNKNOWN' as const);
  const evidence = realWorld
    ? p!.basis === 'TARGET_MET'
      ? 'the target is already met on the ledger'
      : `this Brain's own record of comparable plans: ${p!.sample} finished, ${p!.note}`
    : p
      ? `UNKNOWN: the only figure is a model over evidenced inputs (${p.note}), never checked against real outcomes`
      : a.candidate?.reach !== null && a.candidate?.reach !== undefined
        ? `UNKNOWN: the ${Math.round(a.candidate.reach * 1000) / 10}% figure is the share of simulated scenarios covered, not a probability, and fewer than ten finished plans exist to calibrate one`
        : 'UNKNOWN: no plan has been measured against real outcomes';
  // The commercial reality check, as acceptance recorded it for every counted leg (`legFeasibility`, §116).
  const legs = (a as { legs?: ReadonlyArray<{ opportunityId: string; lacks: readonly string[]; supported: boolean }> | null }).legs ?? null;
  const fromLegs = legs && legs.length > 0 ? { validated: legs.every((l) => l.supported), failing: legs.filter((l) => !l.supported).map((l) => `${l.opportunityId} lacks ${l.lacks.map((k) => LEG_LABEL[k as keyof typeof LEG_LABEL] ?? k).join('; ')}`) } : null;
  const gate = reading.commercialReality ?? fromLegs;
  const accepted = a.status === 'ACCEPTED';
  // Commercial validation also requires the investment committee's pass (§117): agreement is not evidence, a pass of every role is.
  const committee = reading.committee ?? null;
  const committeePassed = committee !== null && committee.verdict === 'PASS';
  const commerciallyValidated = accepted && (gate === null ? false : gate.validated) && committeePassed;
  const validation = commerciallyValidated
    ? 'accepted, every counted strategy passed the commercial reality check, and every committee role passed'
    : gate && !gate.validated
      ? `not validated: ${gate.failing[0] ?? 'a counted strategy failed the commercial reality check'}`
      : committee && committee.verdict !== 'PASS'
        ? `not validated: the investment committee ${committee.verdict === 'FAIL' ? 'failed' : 'has not settled'} it — ${committee.blocker ?? 'a role is unsettled'}`
        : accepted
          ? committee === null
            ? 'not validated: the investment committee did not review this reading'
            : 'not validated: the commercial reality check did not run on this reading'
          : `not validated: the plan is ${a.status.replace('_', ' ').toLowerCase()}`;
  const blocker = commerciallyValidated ? null : (gate && !gate.validated ? gate.failing[0] : null) ?? (committee && committee.verdict !== 'PASS' ? committee.blocker : null) ?? a.shortfalls?.[0] ?? reading.summary ?? null;
  // Before commercial execution starts the deadline is relative and the full window remains (§119): no calendar date is reported.
  const execution = t.execution ?? null;
  const window = execution ? { dueAt, executionWindowDays: execution.windowDays, executionStartedAt: execution.startedAt } : { dueAt, executionWindowDays: null, executionStartedAt: null };
  const deadline = execution && !execution.startedAt ? null : dueAt;
  return { goal, deadline, deadlineText: deadlineText(window), probability, evidence, commerciallyValidated, validation, blocker };
}

/** The report as the lines a terminal or a message prints. Pure. */
export function planningReportLines(r: PlanningReport): string[] {
  return [
    `  report      1. goal: ${r.goal}${r.deadlineText ? ` ${r.deadlineText}` : r.deadline ? ` by ${r.deadline.slice(0, 10)}` : ''}`,
    `  report      2. real-world probability: ${r.probability === 'UNKNOWN' ? 'UNKNOWN' : `${Math.round(r.probability.value * 100)}% (lower bound ${Math.round(r.probability.lowerBound * 100)}%)`}`,
    `  report      3. evidence: ${r.evidence}`,
    `  report      4. commercially validated: ${r.commerciallyValidated ? 'YES' : 'NO'} — ${r.validation}`,
    `  report      5. blocker: ${r.blocker ?? 'none'}`,
  ];
}

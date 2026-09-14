/**
 * The one bounded measurement of what a real Cowork surface holds, declared in
 * code before anybody asks for it.
 *
 * ---------------------------------------------------------------------------
 * Why this is a constant rather than a form
 * ---------------------------------------------------------------------------
 *
 * Every Capability Lab result carries `PROVIDER_UNTESTED` because nothing has
 * ever put real pressure on a real surface. Taking that measurement is the one
 * thing in §29's Lab that spends something a person paid for, so §24's rule
 * applies exactly: **nobody supplies the limits their own work is judged
 * against.** `probeEnvelope.ts` fixes where a probe may look,
 * `approvalEnvelope.ts` fixes what a plan may start, `repositoryEnvelope.ts`
 * fixes which repositories exist — and this fixes how much pressure the one
 * measurement this product wants may apply, and for how long.
 *
 * It is **not** an authorization and does not grant one. The authorization
 * already exists and is unchanged: `POST /projects/:id/lab/:experimentId/run`
 * requires a person at `OPERATOR` depth sending `authorizePressure: true`, read
 * from the route rather than from the experiment's own row. What was missing
 * was never a permission — it was a bounded thing to permit.
 *
 * ---------------------------------------------------------------------------
 * The bounds, and why each number is the number
 * ---------------------------------------------------------------------------
 *
 * **Capacity: 10 concurrent bins.** Step 10's ramp ran six rungs — 1, 2, 5, 10,
 * 20, 30 — and CLAUDE.md §22 records the outcome: rungs 1 to 20 completed every
 * bin with zero duplicate activations, rung 30 had every dispatch refused, and
 * *"the recommended operating ceiling is 10 concurrent bins on one routine."*
 * Measuring at the recommended ceiling answers the question the product
 * actually has; measuring above it re-derives a refusal already recorded.
 *
 * **Activations: 40.** Four per bin at the ceiling, which is the most a bin has
 * ever needed across every recorded ramp, so the run cannot quietly become an
 * endurance test. It is a *hard* ceiling: reaching it is a stop condition
 * rather than a reason to raise it.
 *
 * **Duration: 30 minutes.** Long enough to cross a token lifetime — the
 * connector's OAuth access token is an hour (§23), so half of one is enough to
 * see a second session appear — and short enough that a run nobody is watching
 * cannot still be going at the end of a working day.
 *
 * **Paid spend: 0, and it is not a number this file chooses.** The deployed
 * Brain has no `ANTHROPIC_API_KEY` and no `BRAIN_PROVIDER` (§24), and the
 * standing authority's prohibitions already forbid turning paid usage on. This
 * records the ceiling so a reader can see it was considered, and a run that
 * needed a paid path would be refused by the absence of one rather than by this
 * constant.
 *
 * **Work: synthetic.** `checkEnvelope` already refuses `REAL_CANARY` as a first
 * pressure test, and real research is what this Brain holds. A capacity
 * measurement does not need real questions to answer — it needs real
 * activations to count.
 */
import type { TestEnvelope } from './lab.ts';

/** The id a recorded measurement names, so a reader can tell which rules applied. */
export const PROVIDER_CAPACITY_ENVELOPE_ID = 'FLEET_PROVIDER_CAPACITY_V1';

/** What this measurement is of, so a result is never read about another workload. */
export const PROVIDER_CAPACITY_WORKLOAD = 'RUSSELL_TURN';

/** The highest number of paid-API dollars this measurement may spend. */
export const PROVIDER_CAPACITY_MAX_PAID_SPEND = 0;

/** The most activations it may consume before it must stop. */
export const PROVIDER_CAPACITY_MAX_ACTIVATIONS = 40;

export const PROVIDER_CAPACITY_ENVELOPE: TestEnvelope = {
  ceiling: 10,
  durationMinutes: 30,
  stopConditions: [
    `${PROVIDER_CAPACITY_MAX_ACTIVATIONS} activations consumed, whatever the clock says`,
    'any dispatch refused by the provider for a reason that is not capacity',
    'any bin reaching NEEDS_HUMAN',
    'any surface quarantined',
    '30 minutes elapsed',
  ],
  cleanup:
    'Every bin this run created is cancelled and its fencing generation advanced, so a late ' +
    'completion matches nothing. The isolated TECHNICAL scope keeps its rows: they are the ' +
    'measurement, and deleting them would destroy the thing that was measured.',
  rollback:
    'No fleet policy is applied by this run at all, so there is nothing to undo. If one is ' +
    'applied afterwards from what it found, that is a separate decision through `applyFinding`, ' +
    'which records what it displaced and restores it by name.',
  workloadClass: PROVIDER_CAPACITY_WORKLOAD,
  workKind: 'SYNTHETIC',
};

/**
 * Is a recorded experiment's envelope the declared one, or something else
 * wearing its name?
 *
 * Pure over the row, so "was this measurement taken inside the bounds" is
 * answerable afterwards from what was stored rather than from re-running it.
 * Every field is compared: a run that quietly raised the ceiling, shortened the
 * stop conditions or switched to real work is not this measurement.
 */
export function withinProviderCapacityEnvelope(
  envelope: TestEnvelope,
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const declared = PROVIDER_CAPACITY_ENVELOPE;
  if (envelope.ceiling > declared.ceiling) {
    reasons.push(`ceiling ${envelope.ceiling} is above the declared ${declared.ceiling}`);
  }
  if (envelope.durationMinutes > declared.durationMinutes) {
    reasons.push(
      `duration ${envelope.durationMinutes}m is above the declared ${declared.durationMinutes}m`,
    );
  }
  if (envelope.workKind !== declared.workKind) {
    reasons.push(`work kind ${envelope.workKind} is not ${declared.workKind}`);
  }
  if (envelope.workloadClass !== declared.workloadClass) {
    reasons.push(`workload ${envelope.workloadClass} is not ${declared.workloadClass}`);
  }
  for (const condition of declared.stopConditions) {
    if (!envelope.stopConditions.includes(condition)) {
      reasons.push(`stop condition missing: ${condition}`);
    }
  }
  if (envelope.cleanup.trim().length === 0) reasons.push('no cleanup declared');
  if (envelope.rollback.trim().length === 0) reasons.push('no rollback declared');
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

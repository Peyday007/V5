/**
 * Which stage each deep dive was, read from the event that started it.
 *
 * A deep dive is asked in up to two stages (OPPORTUNITY-INTELLIGENCE §3.3(a)):
 * a `SCREEN` that asks only the kill questions — is the opening still open,
 * who pays, does anything published rule it out — and a `FULL` dive that asks
 * the rest. Which one a given dive was is decided once, when it is started,
 * and written on its own `CASH_VALIDATION_STARTED` event in the same
 * transaction that names its idea on the opportunity. So the compiler, the
 * refusal and the report all read one recorded fact rather than each deciding
 * the stage again from whatever the card says by the time they look — a stage
 * re-derived later would change the compiled specification under a running
 * mission.
 *
 * An event with no `stage` is a dive started before stages existed, and every
 * such dive asked everything: it reads as `FULL`, which is also what a dive
 * whose started event is missing reads as. That is the conservative direction —
 * a full dive asks more and moves no bar — so an unreadable history can cost
 * research and can never skip it.
 */
import { cashEventsOfKind } from '../../repos/cashMode.ts';
import type { CashOpportunity } from '../../domain/types.ts';

export type DiveStage = 'SCREEN' | 'FULL';

export const DIVE_STARTED_EVENT = 'CASH_VALIDATION_STARTED';

export interface DiveStart {
  candidateId: string;
  stage: DiveStage;
  /** The dive's round within its own epoch, as recorded. */
  round: number | null;
  /** When the epoch this dive belongs to began; null is the epoch that began at creation. */
  epochStartedAt: string | null;
  at: string;
}

function stageOf(detail: Record<string, unknown>): DiveStage {
  return detail['stage'] === 'SCREEN' ? 'SCREEN' : 'FULL';
}

/** Every dive this opening has had, oldest first. */
export async function diveStarts(opportunityId: string): Promise<DiveStart[]> {
  const out: DiveStart[] = [];
  for (const event of await cashEventsOfKind(opportunityId, DIVE_STARTED_EVENT)) {
    const candidateId = event.detail['candidateId'];
    if (typeof candidateId !== 'string') continue;
    const round = event.detail['round'];
    const epoch = event.detail['epochStartedAt'];
    out.push({
      candidateId,
      stage: stageOf(event.detail),
      round: typeof round === 'number' ? round : null,
      epochStartedAt: typeof epoch === 'string' ? epoch : null,
      at: event.createdAt,
    });
  }
  return out;
}

/** The stage the dive owned by this idea was started as; `FULL` when nothing says. */
export async function diveStageForCandidate(
  opportunityId: string,
  candidateId: string,
): Promise<DiveStage> {
  const starts = await diveStarts(opportunityId);
  const mine = starts.filter((one) => one.candidateId === candidateId);
  return mine.length > 0 ? mine[mine.length - 1]!.stage : 'FULL';
}

/**
 * When the opening's current dive epoch began: the later of the epoch column a
 * person's reconsideration writes and the request a live change writes. Null is
 * the epoch that began at creation. ISO strings compare as time.
 */
export function diveEpochStart(opportunity: CashOpportunity): string | null {
  const a = opportunity.diveEpochStartedAt ?? null;
  const b = opportunity.reconsiderRequestedAt ?? null;
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

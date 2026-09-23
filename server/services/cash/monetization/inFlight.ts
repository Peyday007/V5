/**
 * What Brain is researching about the possibility space, for a person to read.
 *
 * Requirement, in the operator's own words: *expose enough for me to see what
 * is being researched, which path and attribute it serves, why it was
 * selected, its current work state, what result changed, whether and why rank
 * moved* — and, the clause that decides the shape of this module, **do not
 * create a second research dashboard.**
 *
 * So this composes onto the Cash section's existing monetization block rather
 * than beside it. There is no route of its own, no page of its own and no
 * second place to look: it travels with the ledger, which is what stops the
 * two ever disagreeing about what is happening.
 *
 * ---------------------------------------------------------------------------
 * The work state is read, never stored
 * ---------------------------------------------------------------------------
 *
 * A commission row says a question was asked and, once settled, what came of
 * it. Where the work has got to in between is the *mission's* own state, and
 * copying it onto the commission would be a second master for a fact one table
 * already owns — §25's rule, and the column that drifts is always the one
 * nobody reads. So the state a person sees is derived on the read path from the
 * mission the candidate launched, exactly as `pending.ts` derives what a
 * Russell turn is waiting for.
 *
 * The case that matters is the one that must never read as patience: a
 * commission whose candidate produced no mission at all. That is not "running",
 * and `WAITING_TO_START` says so with the reason — the archive may have
 * answered it, a probe may be settling it first, or it may simply be behind
 * other work in the launch queue.
 */
import { listCommissions } from '../../../repos/monetization.ts';
import { getCandidate } from '../../../repos/russellCandidates.ts';
import { latestMissionForCandidate } from '../../../repos/russellMissions.ts';
import { ATTRIBUTE } from '../../../domain/monetization.ts';
import type { Ledger } from './ledger.ts';
import type { MonetizationAttribute, MonetizationCommission } from '../../../domain/types.ts';

/**
 * Where one asking has got to, from a closed set.
 *
 * Five values, and each has a different remedy — which is the whole reason it
 * is not a boolean or a free sentence. `WAITING_TO_START` is a person's cue to
 * look at the launch queue; `PARKED` is a decision waiting; `RESEARCHING` is
 * nothing to do; the two settled ones are history.
 */
export type CommissionWorkState =
  | 'WAITING_TO_START'
  | 'RESEARCHING'
  | 'PARKED'
  | 'SETTLED'
  | 'STOPPED';

export interface InFlightQuestion {
  commissionId: string;
  /** The possibility it serves, and where that sits right now. */
  pathId: string;
  pathTitle: string;
  rank: number | null;
  /** The exact attribute being investigated. */
  attribute: MonetizationAttribute;
  attributeLabel: string;
  round: number;
  /** Why Brain selected it, recorded when it was selected. */
  why: string;
  /**
   * Which selection rule admitted it. Lower is stronger.
   *
   * Carried because the shared projection keys a figure-free sentence off it
   * (§34): a member is told which *rule* chose the question rather than the
   * owner's recorded reason, which quotes the ledger.
   */
  ruleRank: number;
  state: CommissionWorkState;
  /** What the state means, in words, and what would change it. */
  stateBecause: string;
  askedAt: string;
  /** Null until it settles. */
  settledAt: string | null;
  /** What came of it. Null while it is still being asked. */
  outcome: string | null;
  /** How many ledger answers it produced. Null while open — never 0. */
  answered: number | null;
}

export interface CommissionView {
  /** Everything still being asked, oldest first. */
  open: InFlightQuestion[];
  /** What settled recently, newest first, however it settled. */
  recentlySettled: InFlightQuestion[];
  /** How many may be open at once, so the count beside it means something. */
  capacity: number;
}

/** How many settled questions are worth showing. The rest are on the path. */
const RECENT_SHOWN = 8;

export async function commissionView(input: {
  projectId: string;
  ledger: Ledger;
  capacity: number;
}): Promise<CommissionView> {
  const commissions = await listCommissions({ projectId: input.projectId });
  const byPath = new Map(input.ledger.entries.map((one) => [one.path.id, one]));

  const open: InFlightQuestion[] = [];
  const settled: InFlightQuestion[] = [];

  for (const one of commissions) {
    const entry = byPath.get(one.pathId);
    const described = await describe({
      commission: one,
      pathTitle: entry?.path.title ?? one.pathId,
      rank: entry?.rank ?? null,
    });
    if (one.state === 'OPEN') open.push(described);
    else settled.push(described);
  }

  settled.sort((a, b) => (b.settledAt ?? '').localeCompare(a.settledAt ?? ''));
  return {
    open,
    recentlySettled: settled.slice(0, RECENT_SHOWN),
    capacity: input.capacity,
  };
}

async function describe(input: {
  commission: MonetizationCommission;
  pathTitle: string;
  rank: number | null;
}): Promise<InFlightQuestion> {
  const { commission } = input;
  const reading = commission.state === 'OPEN' ? await liveState(commission) : settledState(commission);
  return {
    commissionId: commission.id,
    pathId: commission.pathId,
    pathTitle: input.pathTitle,
    rank: input.rank,
    attribute: commission.attribute,
    attributeLabel: ATTRIBUTE[commission.attribute].label,
    round: commission.round,
    why: commission.reason,
    ruleRank: commission.ruleRank,
    state: reading.state,
    stateBecause: reading.because,
    askedAt: commission.openedAt,
    settledAt: commission.settledAt,
    outcome: commission.outcome,
    answered: commission.answered,
  };
}

function settledState(commission: MonetizationCommission): {
  state: CommissionWorkState;
  because: string;
} {
  if (commission.state === 'ANSWERED') {
    return { state: 'SETTLED', because: 'The answer is on the possibility, with its source.' };
  }
  if (commission.state === 'ABANDONED') {
    return {
      state: 'STOPPED',
      because:
        'The possibility this was about was put away while the question was still being asked, ' +
        'so the answer stopped being worth having.',
    };
  }
  return {
    state: 'SETTLED',
    because:
      'The research ran and the published sources did not settle it. The question stays open ' +
      'on the possibility and is not a no.',
  };
}

/**
 * Where a live commission actually is, from the mission its candidate launched.
 *
 * A derivation rather than a column, and it writes nothing. What it exists for
 * is the branch that must never read as patience: no mission at all means
 * nothing is researching this, and a screen that said "researching" would be
 * §29's status contradicting the thing beside it.
 */
async function liveState(
  commission: MonetizationCommission,
): Promise<{ state: CommissionWorkState; because: string }> {
  const mission = await latestMissionForCandidate(commission.candidateId);
  if (!mission) {
    const candidate = await getCandidate(commission.candidateId);
    if (candidate?.state === 'PARKED' || candidate?.state === 'REJECTED') {
      return {
        state: 'PARKED',
        because:
          candidate.reason ??
          'Brain decided against researching this and recorded why on the idea.',
      };
    }
    if (candidate?.priority === 'EXPLORE') {
      return {
        state: 'WAITING_TO_START',
        because:
          'The archive holds something on this that nothing has verified, so Brain is taking a ' +
          'cheap look first rather than spending a research packet on it.',
      };
    }
    return {
      state: 'WAITING_TO_START',
      because:
        'The question is queued and nothing has started it yet. It launches when the work ' +
        'already running finishes — questions about an opening already found go ahead of new ' +
        'searches, and behind anything already under way.',
    };
  }
  if (mission.state === 'NEEDS_HUMAN') {
    return {
      state: 'PARKED',
      because: 'The research stopped at a decision somebody has to make. It is on Needs You.',
    };
  }
  if (mission.state === 'FAILED' || mission.state === 'CANCELLED') {
    return {
      state: 'STOPPED',
      because:
        'The research did not finish. The attribute is unknown, exactly as it was before — ' +
        'nothing about the possibility was changed by this.',
    };
  }
  if (mission.state === 'DONE') {
    return {
      state: 'RESEARCHING',
      because:
        'The research has finished and Brain is filing what it established on the next pass.',
    };
  }
  return {
    state: 'RESEARCHING',
    because: 'A worker is reading published sources for this now.',
  };
}

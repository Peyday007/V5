/**
 * What it means for Brain to own a goal over time.
 *
 * A goal is a workstream (§43) with four more things a person said about it —
 * what counts as finished, whose it is, by when, and whether it is owed to
 * somebody — and three decisions a person can make about it: pause, resume and
 * cancel. Everything else in `services/goals/` is derived from rows on every
 * read, exactly as the register's state is, and nothing here is a stored
 * verdict about where the work has got to.
 *
 * The closed sets are closed for the reason this codebase keeps giving: a value
 * nobody declared is a value some reader will interpret.
 */

/**
 * Who the goal is owed to.
 *
 * `CUSTOMER` is an obligation to somebody outside this Brain — the one kind of
 * goal whose cancellation cannot end the obligation, only Brain's pursuit of
 * it. `INTERNAL` is a commitment somebody here made to somebody else here.
 * `NONE` is the ordinary case, and it is the default because a commitment
 * nobody stated is not one.
 */
export const GOAL_COMMITMENTS = ['NONE', 'INTERNAL', 'CUSTOMER'] as const;
export type GoalCommitment = (typeof GOAL_COMMITMENTS)[number];

export const COMMITMENT_LABELS: Record<GoalCommitment, string> = {
  NONE: 'No outside commitment',
  INTERNAL: 'Committed to somebody on this Brain',
  CUSTOMER: 'Owed to a customer',
};

/**
 * Where a goal stands as a matter of somebody's decision, derived from the
 * decision columns and the derived register state.
 *
 * `COMPLETE` is derived rather than declared: a goal is complete when the rows
 * it points at say the outcome was reached (a `DONE` or `VERIFIED_LIVE`
 * reading), never because somebody said so — and a person who disagrees
 * supersedes the link that says so, which the register already supports.
 */
export const GOAL_LIFECYCLES = ['ACTIVE', 'PAUSED', 'CANCELLED', 'ARCHIVED', 'COMPLETE'] as const;
export type GoalLifecycle = (typeof GOAL_LIFECYCLES)[number];

/**
 * What a goal is waiting for right now, in one word a person can act on.
 *
 * Every value has a different remedy, which is the whole reason they are not
 * folded together: *waiting on you* sends somebody to Needs You, *waiting on a
 * dependency* sends them to another goal, *waiting on capacity* is Brain's own
 * business, and *nothing linked* means nobody has pointed this goal at any
 * work — which is not the same fact as the work being finished.
 */
export const WAITING_KINDS = [
  'NOTHING',
  'PERSON',
  'DEPENDENCY',
  'CAPACITY',
  'WORKER',
  'OPERATOR',
  'NOTHING_LINKED',
  'PAUSED',
  'CANCELLED',
] as const;
export type WaitingKind = (typeof WAITING_KINDS)[number];

/** Who performs the next action. */
export type NextActor = 'BRAIN' | 'PERSON' | 'OPERATOR' | 'NOBODY';

/**
 * Why a bin is held by a goal. Recorded on the bin so a reader of the bin can
 * see why it is not being worked without joining back to the goal.
 */
export const HOLD_REASONS = ['GOAL_PAUSED', 'GOAL_CANCELLED', 'WAITING_ON_DEPENDENCY'] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/**
 * The criteria priority is decided on, in order. Lexicographic, never a
 * weighted score — the same argument §38 and §49 make: a score needs weights,
 * the weights are a judgement nobody made, and the first criterion two goals
 * differ on is then the whole reason one is above the other.
 */
export const PRIORITY_CRITERIA = [
  'WORKABLE',
  'COMMITMENT',
  'DEADLINE',
  'PURPOSE',
  'UNBLOCKS',
  'AGE',
] as const;
export type PriorityCriterion = (typeof PRIORITY_CRITERIA)[number] | 'TIE';

/**
 * The bin priority a goal's position within its owner's goals maps to.
 *
 * Capped at 8 so a conversation turn — created at 9 — is always answered
 * before any goal's background work: a person talking to Russell now outranks
 * everything Russell was doing while they were away. Ranks below the third
 * share the ordinary 5, because a ladder that kept descending would starve the
 * fourth goal permanently rather than order it.
 */
export function binPriorityForRank(rank: number): number {
  if (rank <= 0) return 8;
  if (rank === 1) return 7;
  if (rank === 2) return 6;
  return 5;
}

export function isGoalCommitment(value: unknown): value is GoalCommitment {
  return typeof value === 'string' && (GOAL_COMMITMENTS as readonly string[]).includes(value);
}

/** One recorded move of a goal's position, append-only. */
export interface GoalPrioritySnapshot {
  id: string;
  workstreamId: string;
  ownerKey: string;
  rank: number;
  previousRank: number | null;
  criterion: string;
  reason: string;
  createdAt: string;
}

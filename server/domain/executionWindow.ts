/**
 * A goal's commercial execution window (§119; owner, 2026-11-19 and 2026-11-24).
 *
 * "The $10K objective has a 30-day COMMERCIAL EXECUTION period, beginning when
 * actual commercial execution starts." Planning, engineering and research before
 * execution do not consume it. Until execution is authorized the deadline is
 * relative ("30 days from the start of commercial execution"), not a calendar
 * date, and every reader sees the full window. Once a grant authorizes
 * outward commercial work for the goal's project, the window is anchored: the
 * start is recorded once on the goal's row, and `due_at` becomes start + window.
 *
 * This is the one rule every subsystem reads: the workstream mapper derives
 * `dueAt` through `effectiveDueAt`, and readers that select the row in raw
 * SQL derive it through the same function, so planning, quant, research,
 * Hermes, simulations, acceptance and reporting cannot disagree. Pure.
 */

const DAY = 86_400_000;

/**
 * Commercial actions whose grant is the start of execution: work that faces a
 * buyer or takes their money. Spending on a test or building one is
 * preparation, not execution.
 */
export const EXECUTION_ACTIONS = ['CONTACT_BUYER', 'QUOTE_AND_INVOICE', 'ACCEPT_PAYMENT'] as const;

export interface ExecutionWindowFields {
  /** The stored calendar deadline: set by a person, or start + window once execution has started. */
  dueAt: string | null;
  /** The window's length in days, or null for a goal with a fixed calendar deadline. */
  executionWindowDays: number | null;
  /** When authorized commercial execution started, or null while it has not. */
  executionStartedAt: string | null;
}

/** Whether a grant's actions start commercial execution. Pure. */
export function startsExecution(actions: readonly string[]): boolean {
  return actions.some((a) => (EXECUTION_ACTIONS as readonly string[]).includes(a));
}

/** The window's anchored deadline from its start. Pure. */
export function anchoredDueAt(startedAt: string, windowDays: number): string {
  return new Date(Date.parse(startedAt) + windowDays * DAY).toISOString();
}

/**
 * The deadline every reader uses. A goal with a window that has not started is
 * due a full window from now, whatever the date: planning time is not
 * execution time. Pure.
 */
export function effectiveDueAt(goal: ExecutionWindowFields, now: Date = new Date()): string | null {
  const days = goal.executionWindowDays;
  if (days === null || days === undefined || !(days > 0)) return goal.dueAt;
  if (goal.executionStartedAt) return anchoredDueAt(goal.executionStartedAt, days);
  return new Date(now.getTime() + days * DAY).toISOString();
}

/** Days left on the goal: the full window before execution starts. Pure. */
export function daysLeftOf(goal: ExecutionWindowFields, now: Date = new Date()): number | null {
  const days = goal.executionWindowDays;
  if (days !== null && days !== undefined && days > 0 && !goal.executionStartedAt) return days;
  const due = effectiveDueAt(goal, now);
  return due ? Math.ceil((Date.parse(due) - now.getTime()) / DAY) : null;
}

/** The deadline as a person reads it: relative before execution, a date after. Pure. */
export function deadlineText(goal: ExecutionWindowFields, now: Date = new Date()): string | null {
  const days = goal.executionWindowDays;
  if (days !== null && days !== undefined && days > 0) {
    if (!goal.executionStartedAt) return `within ${days} days of the start of commercial execution (not started; the full ${days} days remain)`;
    return `by ${anchoredDueAt(goal.executionStartedAt, days).slice(0, 10)} (${days}-day execution window from ${goal.executionStartedAt.slice(0, 10)})`;
  }
  const due = effectiveDueAt(goal, now);
  return due ? `by ${due.slice(0, 10)}` : null;
}

/** Raw-row form, for readers that select `workstreams` columns directly. Pure. */
export function effectiveDueAtOfRow(
  row: { due_at?: string | null; execution_window_days?: number | string | null; execution_started_at?: string | null },
  now: Date = new Date(),
): string | null {
  return effectiveDueAt(windowOfRow(row), now);
}

export function windowOfRow(row: { due_at?: string | null; execution_window_days?: number | string | null; execution_started_at?: string | null }): ExecutionWindowFields {
  return {
    dueAt: row.due_at ?? null,
    executionWindowDays: row.execution_window_days === null || row.execution_window_days === undefined ? null : Number(row.execution_window_days),
    executionStartedAt: row.execution_started_at ?? null,
  };
}

/**
 * The SQL condition "this goal still has time": an unstarted window always
 * does, otherwise the stored deadline is after `?`. One placeholder. Written
 * plainly so both dialects say it.
 */
export const OPEN_DEADLINE_SQL = `((execution_window_days IS NOT NULL AND execution_started_at IS NULL) OR (due_at IS NOT NULL AND due_at > ?))`;

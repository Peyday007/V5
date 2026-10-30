/**
 * The line between software work and research, drawn at routing time.
 *
 * A unit of software change goes to the Software Factory and nowhere else; an
 * ordinary research question goes to the research queue and nowhere else. The
 * kind is a declaration the caller holds (a change request, a research goal),
 * never read out of the words of the work, and the destination follows from it
 * alone — so no amount of cost pressure, free capacity or phrasing moves a
 * unit across the line.
 */

export const WORK_KINDS = ['SOFTWARE_CHANGE', 'RESEARCH_QUESTION'] as const;
export type BoundaryWorkKind = (typeof WORK_KINDS)[number];

export const WORK_DESTINATIONS = ['FACTORY', 'RESEARCH_QUEUE'] as const;
export type WorkDestination = (typeof WORK_DESTINATIONS)[number];

const DESTINATION: Record<BoundaryWorkKind, WorkDestination> = {
  SOFTWARE_CHANGE: 'FACTORY',
  RESEARCH_QUESTION: 'RESEARCH_QUEUE',
};

/** The only destination a kind may route to. */
export function destinationFor(kind: BoundaryWorkKind): WorkDestination {
  return DESTINATION[kind];
}

export interface BoundaryCheck {
  ok: boolean;
  /** Present exactly when `ok` is false. */
  reason: string | null;
}

/** Whether routing `kind` to `destination` respects the boundary. */
export function checkBoundary(kind: BoundaryWorkKind, destination: WorkDestination): BoundaryCheck {
  const allowed = destinationFor(kind);
  if (destination === allowed) return { ok: true, reason: null };
  return {
    ok: false,
    reason: kind === 'SOFTWARE_CHANGE'
      ? `A software change routes only to the Factory, not to ${destination}.`
      : `A research question routes only to the research queue, not to ${destination}.`,
  };
}

/** Throws when the boundary is crossed; for callers that must not continue. */
export function assertBoundary(kind: BoundaryWorkKind, destination: WorkDestination): void {
  const check = checkBoundary(kind, destination);
  if (!check.ok) throw new Error(check.reason ?? 'Routing boundary crossed.');
}

/**
 * The boundary between software change and research, at routing time.
 *
 * A unit of software change is worked by the Factory and nowhere else; a
 * research question is worked by the research queue and nowhere else. The
 * domain is declared by whoever created the unit (a row), never read out of
 * its words, so a research question that mentions "build" stays research.
 */

export const WORK_DOMAINS = ['SOFTWARE_CHANGE', 'RESEARCH'] as const;
export type WorkDomain = (typeof WORK_DOMAINS)[number];

export const DESTINATIONS = ['FACTORY', 'RESEARCH_QUEUE'] as const;
export type Destination = (typeof DESTINATIONS)[number];

/** The only destination each domain may reach. */
export const DESTINATION_FOR: Record<WorkDomain, Destination> = {
  SOFTWARE_CHANGE: 'FACTORY',
  RESEARCH: 'RESEARCH_QUEUE',
};

export interface BoundaryVerdict {
  ok: boolean;
  domain: WorkDomain;
  destination: Destination;
  /** Why it was refused; null when allowed. */
  reason: string | null;
}

/** The destination a domain is routed to. */
export function destinationFor(domain: WorkDomain): Destination {
  return DESTINATION_FOR[domain];
}

/** Whether a unit of this domain may run at this destination. */
export function checkBoundary(domain: WorkDomain, destination: Destination): BoundaryVerdict {
  const required = DESTINATION_FOR[domain];
  if (required === destination) return { ok: true, domain, destination, reason: null };
  return {
    ok: false,
    domain,
    destination,
    reason:
      domain === 'SOFTWARE_CHANGE'
        ? 'A software change is worked by the Factory only; it is not a research question.'
        : 'A research question is worked by the research queue only; it is not a software change.',
  };
}

/** Throws when a unit would cross the boundary. */
export function assertBoundary(domain: WorkDomain, destination: Destination): void {
  const verdict = checkBoundary(domain, destination);
  if (!verdict.ok) throw new Error(verdict.reason ?? 'Boundary refused.');
}

/**
 * What work routing talks in: the resources a unit of work can run on, what a
 * unit requires, and what has been measured about each resource.
 *
 * Nothing here reads a word of the work. A unit says what it needs; the router
 * answers from those declarations and from recorded success rates.
 */
import type { RoutingResource } from '../../repos/workRouting.ts';

export type { RoutingResource };

/** How a unit's result can be checked, which decides how much trust a resource needs. */
export const VERIFICATION_NEEDS = ['NONE', 'CODE_CHECKABLE', 'EVIDENCE_GATE'] as const;
export type VerificationNeed = (typeof VERIFICATION_NEEDS)[number];

export interface WorkRequirements {
  /** An existing deterministic algorithm does this work (parse, filter, dedupe, date arithmetic). */
  algorithmAvailable: boolean;
  /** The id of an ACTIVE detector that covers this unit; a SHADOW detector must not be passed. */
  activeDetectorId: string | null;
  /** The input is structured data rather than prose. */
  structuredInput: boolean;
  needsTools: boolean;
  needsInternet: boolean;
  /** The answer is one of a closed set (a classification), so it can be validated exactly. */
  closedAnswerSet: boolean;
  verification: VerificationNeed;
}

/** What has been measured about one resource for one kind of work. Absent means unmeasured. */
export interface ResourceMeasure {
  attempts: number;
  successes: number;
  /** Failures since the last success. */
  consecutiveFailures: number;
}

export interface ClassifyInput {
  /** The project whose work this is; the ledger row is scoped to it. */
  projectId: string;
  /** Marks the decision as a general method, readable across projects. */
  general?: boolean;
  workKind: string;
  workRef?: string | null;
  requirements: WorkRequirements;
  /** The free model's measured record for this kind of work, or null when none exists. */
  cheapMeasure: ResourceMeasure | null;
  /** The stored reliability a free model must clear, 0..1. */
  cheapThreshold: number;
}

export interface RoutingChoice {
  resource: RoutingResource;
  reasons: string[];
  alternatives: string[];
}

/** Fewer measured attempts than this is not a measurement. */
export const MIN_MEASURED_ATTEMPTS = 10;
/** A free model that failed this many times in a row is not tried again until it succeeds elsewhere. */
export const MAX_CONSECUTIVE_FAILURES = 3;

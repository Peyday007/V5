/**
 * Seven kinds of evidence about one component, and three answers each.
 *
 * ---------------------------------------------------------------------------
 * Why they are not one ladder
 * ---------------------------------------------------------------------------
 *
 * It is tempting to collapse these into a single position — "this component has
 * reached DEPLOYED" — and it is wrong for the same reason a single `status` on
 * a faculty is wrong. A component can be deployed and never evaluated,
 * evaluated and never run in production, documented at length and never
 * written. Collapsing them picks one of those facts to stand for the rest, and
 * which one it picks is whichever the last reader happened to care about.
 *
 * ---------------------------------------------------------------------------
 * Why there are three answers and not two
 * ---------------------------------------------------------------------------
 *
 * `NO` is a reading. `UNKNOWN` is the absence of one, and the difference is
 * §30's: *we could not tell* must never read the same as *we checked*.
 *
 * The live instance is evaluation coverage. `tests/` is not in the deployment
 * image — the Dockerfile copies `server` and `client` and nothing else — so a
 * deployed Brain genuinely cannot see whether a component is tested. Answering
 * `NO` there would turn "we cannot see from here" into "it is untested", which
 * is a false statement about the repository, in the direction that causes work
 * nobody needed.
 */

export const EVIDENCE_LEVELS = [
  /** Named in a document Brain can read. */
  'DOCUMENTED',
  /** A module implementing it exists on disk. */
  'IN_SOURCE',
  /** Something in the running process reaches it: a registry entry, a mount. */
  'CONNECTED',
  /** The running image carries it, and the database it is talking to has it. */
  'DEPLOYED',
  /** Rows show it has actually run at least once. */
  'OBSERVED_ACTIVE',
  /** A suite covers it. Repository-only: see the header. */
  'EVALUATED',
  /** Rows show it ran in production and produced a terminal result. */
  'PRODUCTION_PROVEN',
] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const ANSWERS = ['YES', 'NO', 'UNKNOWN'] as const;
export type Answer = (typeof ANSWERS)[number];

export const COMPONENT_KINDS = [
  'MIGRATION',
  'WORK_TYPE',
  'BIN_CONTRACT',
  'MCP_TOOL',
  'HTTP_ROUTE',
  'SERVICE_MODULE',
  'REPOSITORY_MODULE',
  'STORAGE_PROVIDER',
  'FLEET_ACCOUNT',
  'FLEET_ROUTINE',
  'WORKER_IDENTITY',
  'EVALUATION_SUITE',
  'PROVIDER',
  'SURFACE',
  'KNOWLEDGE_SCOPE',
] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/** One level's answer and what read it. */
export interface Reading {
  answer: Answer;
  /** What produced this answer: a file, a registry, a query. Never a guess. */
  evidence: string;
}

export function yes(evidence: string): Reading {
  return { answer: 'YES', evidence };
}
export function no(evidence: string): Reading {
  return { answer: 'NO', evidence };
}
/**
 * Not readable from here, and the reason why.
 *
 * The reason is required rather than optional. An `UNKNOWN` with no stated
 * cause is indistinguishable from a level nobody implemented, and the whole
 * point of having a third answer is that somebody can act on it.
 */
export function unknown(why: string): Reading {
  return { answer: 'UNKNOWN', evidence: why };
}

export interface ComponentObservation {
  kind: ComponentKind;
  name: string;
  detail: string | null;
  readings: Partial<Record<EvidenceLevel, Reading>>;
}

/** The stable key. Derived from kind and name, never supplied by a caller. */
export function componentKey(kind: ComponentKind, name: string): string {
  return `${kind}:${name}`;
}

/**
 * A component's readings as one sentence, composed rather than aggregated.
 *
 * What exists instead of a completion score, for `describeFaculty`'s reason:
 * the honest answer has seven parts and any single number picks one of them.
 * Levels that read `UNKNOWN` are named as unknown rather than omitted, because
 * omitting them is how an unread level becomes an assumed one.
 */
export function describeComponent(observation: {
  name: string;
  readings: Partial<Record<EvidenceLevel, Reading>>;
}): string {
  const has: string[] = [];
  const lacks: string[] = [];
  const unread: string[] = [];
  for (const level of EVIDENCE_LEVELS) {
    const reading = observation.readings[level];
    if (!reading) {
      unread.push(level);
      continue;
    }
    if (reading.answer === 'YES') has.push(level);
    else if (reading.answer === 'NO') lacks.push(level);
    else unread.push(level);
  }
  const parts: string[] = [];
  parts.push(has.length > 0 ? `${observation.name} is ${has.join(', ')}` : `${observation.name} is none of the seven levels`);
  if (lacks.length > 0) parts.push(`it is not ${lacks.join(', ')}`);
  if (unread.length > 0) parts.push(`and ${unread.join(', ')} could not be read from here`);
  return `${parts.join('; ')}.`;
}

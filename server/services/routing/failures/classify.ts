// A failure is classified before anything is tried again, so a source outage, a
// malformed free-model answer, missing input and a genuine reasoning gap do not
// all end up on the strongest resource. Pure: it reads a record of what failed
// and answers what to do, deciding nothing about spend, model or authorization.

export const FAILURE_CLASSES = [
  'TRANSIENT_PROVIDER',
  'RATE_LIMITED',
  'PROVIDER_DOWN',
  'SOURCE_UNAVAILABLE',
  'MALFORMED_OUTPUT',
  'MISSING_INPUT',
  'CAPABILITY_GAP',
  'UNSOLVABLE',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const RESPONSES = [
  'BACKOFF_RETRY_SAME',
  'OTHER_SOURCE',
  'KNOWN_REPAIR',
  'OTHER_CAPABLE_WORKER',
  'ESCALATE',
  'ASK_FOR_INPUT',
  'STOP',
] as const;
export type FailureResponse = (typeof RESPONSES)[number];

export type ResourceLane = 'CODE' | 'CHEAP' | 'STRONG';

/** What an attempt left behind. Declared facts win over message text. */
export interface FailureEvidence {
  /** Declared by the caller when it knows; never inferred from a message if set. */
  declared?: FailureClass;
  httpStatus?: number | null;
  /** The provider answered, but not in the shape the task demands. */
  outputInvalid?: boolean;
  /** The task named an input that was not supplied. */
  missingInputs?: string[];
  /** A source the work reads did not answer or refused. */
  sourceFailed?: boolean;
  /** The resource answered validly and could not do the work. */
  reasoningInsufficient?: boolean;
  /** Nothing any resource can do changes the outcome. */
  unsolvable?: boolean;
  /** Transport-level error code or message, used only when nothing above decides. */
  error?: string | null;
  /** The model-health reading says this provider is down right now. */
  providerDown?: boolean;
}

const TRANSPORT = /\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|timed out|timeout|fetch failed)\b/i;

export function classifyFailure(e: FailureEvidence): FailureClass {
  if (e.declared) return e.declared;
  if (e.unsolvable) return 'UNSOLVABLE';
  if (e.missingInputs && e.missingInputs.length > 0) return 'MISSING_INPUT';
  if (e.sourceFailed) return 'SOURCE_UNAVAILABLE';
  if (e.providerDown) return 'PROVIDER_DOWN';
  if (e.httpStatus === 429) return 'RATE_LIMITED';
  if (e.httpStatus != null && e.httpStatus >= 500) return 'TRANSIENT_PROVIDER';
  if (e.error && TRANSPORT.test(e.error)) return 'TRANSIENT_PROVIDER';
  if (e.outputInvalid) return 'MALFORMED_OUTPUT';
  if (e.reasoningInsufficient) return 'CAPABILITY_GAP';
  // An unrecognised failure is not evidence the work is beyond the resource, so it
  // is never read as a capability gap: unknown must not buy a stronger model.
  return 'TRANSIENT_PROVIDER';
}

export const MAX_ATTEMPTS: Record<FailureClass, number> = {
  TRANSIENT_PROVIDER: 3,
  RATE_LIMITED: 4,
  PROVIDER_DOWN: 2,
  SOURCE_UNAVAILABLE: 2,
  MALFORMED_OUTPUT: 2,
  MISSING_INPUT: 1,
  CAPABILITY_GAP: 1,
  UNSOLVABLE: 1,
};

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 15 * 60_000;

/** attempt is the number of attempts already failed (1 = the first failure). */
export function backoffMs(attempt: number, retryAfterMs?: number | null): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  if (retryAfterMs != null && retryAfterMs > 0) return Math.min(BACKOFF_CAP_MS, Math.max(exp, retryAfterMs));
  return exp;
}

export interface FailureDecision {
  failureClass: FailureClass;
  response: FailureResponse;
  /** The lane the next attempt runs on; null when there is no next attempt. */
  nextLane: ResourceLane | null;
  retryAfterMs: number | null;
  /** True when the unit gives up its lease and its slot rather than holding it. */
  releaseCapacity: boolean;
  reason: string;
}

export interface DecideInput {
  evidence: FailureEvidence;
  lane: ResourceLane;
  /** Failures already recorded for this unit on this resource, including this one. */
  attempts: number;
  retryAfterMs?: number | null;
  /** A repair for malformed output exists (e.g. strip fences, re-ask with the schema). */
  repairAvailable?: boolean;
  /** Another source / another capable worker is known to exist. */
  alternativeSource?: boolean;
  alternativeWorker?: boolean;
}

const STRONGER: Record<ResourceLane, ResourceLane | null> = { CODE: 'CHEAP', CHEAP: 'STRONG', STRONG: null };

function stop(c: FailureClass, reason: string): FailureDecision {
  return { failureClass: c, response: 'STOP', nextLane: null, retryAfterMs: null, releaseCapacity: true, reason };
}

export function decideFailure(i: DecideInput): FailureDecision {
  const c = classifyFailure(i.evidence);
  const exhausted = i.attempts >= MAX_ATTEMPTS[c];

  switch (c) {
    case 'UNSOLVABLE':
      return stop(c, 'No resource changes the outcome; stopped and the capacity released.');
    case 'MISSING_INPUT':
      return {
        failureClass: c, response: 'ASK_FOR_INPUT', nextLane: null, retryAfterMs: null, releaseCapacity: true,
        reason: `Missing ${(i.evidence.missingInputs ?? []).join(', ') || 'input'}; a stronger model cannot supply it, so a person is asked.`,
      };
    case 'SOURCE_UNAVAILABLE':
      if (i.alternativeSource && !exhausted) {
        return { failureClass: c, response: 'OTHER_SOURCE', nextLane: i.lane, retryAfterMs: null, releaseCapacity: false, reason: 'The source did not answer; another source is tried on the same resource.' };
      }
      return stop(c, 'The source is unavailable and no other is known; a stronger model cannot read it either.');
    case 'MALFORMED_OUTPUT': {
      if (exhausted) {
        // A free model that cannot produce the shape twice is a capability question
        // only for the lane above it; the evidence of that is the repeated failure.
        const next = i.lane === 'CHEAP' ? STRONGER[i.lane] : null;
        if (next) return { failureClass: c, response: 'ESCALATE', nextLane: next, retryAfterMs: null, releaseCapacity: false, reason: 'The cheap lane failed to produce the required shape within its attempts; escalated once.' };
        return stop(c, 'Output stayed malformed within the attempt cap.');
      }
      return {
        failureClass: c, response: i.repairAvailable ? 'KNOWN_REPAIR' : 'BACKOFF_RETRY_SAME', nextLane: i.lane,
        retryAfterMs: i.repairAvailable ? 0 : backoffMs(i.attempts), releaseCapacity: false,
        reason: i.repairAvailable ? 'Malformed output repaired or re-asked on the same lane.' : 'Malformed output retried on the same lane before any escalation.',
      };
    }
    case 'PROVIDER_DOWN':
    case 'RATE_LIMITED':
    case 'TRANSIENT_PROVIDER': {
      if (c === 'PROVIDER_DOWN' && i.alternativeWorker) {
        return { failureClass: c, response: 'OTHER_CAPABLE_WORKER', nextLane: i.lane, retryAfterMs: null, releaseCapacity: true, reason: 'The provider is down; another capable worker on the same lane takes it.' };
      }
      if (exhausted) return stop(c, 'Attempt cap reached; stopped rather than holding capacity. A provider fault is not a capability gap, so it is not escalated.');
      return {
        failureClass: c, response: 'BACKOFF_RETRY_SAME', nextLane: i.lane, retryAfterMs: backoffMs(i.attempts, i.retryAfterMs),
        releaseCapacity: true, reason: 'Provider-side failure; retried on the same resource after exponential backoff, capacity released meanwhile.',
      };
    }
    case 'CAPABILITY_GAP': {
      const next = STRONGER[i.lane];
      if (!next) return stop(c, 'Already on the strongest lane; nothing above it.');
      return { failureClass: c, response: 'ESCALATE', nextLane: next, retryAfterMs: null, releaseCapacity: false, reason: 'The resource answered validly and could not do the work; the only class that escalates.' };
    }
  }
}

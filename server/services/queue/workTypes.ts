/**
 * What kinds of work this queue is allowed to carry.
 *
 * A queue item describes Brain-authorized work. It is never a command to
 * execute, and there is deliberately no work type meaning "run this". A worker
 * that receives an item looks up what that type means in its own code; the
 * payload only parameterises it. Without that rule, an authenticated worker
 * credential plus an enqueue permission would add up to remote shell access,
 * which is not a queue, it is a backdoor.
 *
 * ---------------------------------------------------------------------------
 * Why there is exactly one type in Step 5
 * ---------------------------------------------------------------------------
 *
 * Because of the at-least-once boundary, and not because the list is
 * unfinished.
 *
 * A lease can expire after a worker performed an effect and before it recorded
 * the completion, so the item is redelivered and the effect happens again.
 * Until Step 6 provides idempotency keys and an effect ledger, the only work
 * this queue may carry is work that is safe to perform more than once.
 * `SYNTHETIC_ECHO` is exactly that: it proves claiming, leasing, heartbeating,
 * expiry, fencing and completion end to end against the real deployment, and
 * doing it twice costs nothing and changes nothing.
 *
 * Registering a research or extraction type here before Step 6 exists would
 * mean a redelivered item spending the user's quota a second time. That is the
 * bug this boundary exists to prevent, so the registry stays honest about it.
 */
import type { WorkerScope } from '../../domain/types.ts';

export interface WorkTypeDefinition {
  /** The stable identifier stored in `work_items.work_type`. */
  type: string;
  description: string;
  /** What a worker must hold in the project to be handed one of these. */
  requiredScopes: WorkerScope[];
  defaultMaxAttempts: number;
  /**
   * Validate and normalise the payload. Throwing rejects the enqueue; the
   * returned value is what gets stored, so a type can drop anything it did not
   * ask for rather than storing whatever arrived.
   */
  validate(payload: unknown): Record<string, unknown>;
  /**
   * True when performing this work twice is harmless. Every type registered
   * before Step 6 must be safe to repeat — see the header.
   */
  safeToRepeat: true;
}

export class InvalidWorkPayload extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkPayload';
  }
}

export class UnknownWorkType extends Error {
  constructor(type: string) {
    super(`"${type}" is not a registered work type.`);
    this.name = 'UnknownWorkType';
  }
}

const MAX_NOTE_CHARS = 500;

function asRecord(payload: unknown): Record<string, unknown> {
  if (payload === null || payload === undefined) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new InvalidWorkPayload('A work payload must be an object.');
  }
  return payload as Record<string, unknown>;
}

const REGISTRY = new Map<string, WorkTypeDefinition>();

function register(definition: WorkTypeDefinition): void {
  REGISTRY.set(definition.type, definition);
}

register({
  type: 'SYNTHETIC_ECHO',
  description:
    'Carries a short note and asks a worker to hand it back. Exists to prove the ' +
    'queue contract against the real deployment without spending anything or ' +
    'touching a document. Performing it twice is indistinguishable from once.',
  requiredScopes: ['queue:claim'],
  defaultMaxAttempts: 3,
  safeToRepeat: true,
  validate(payload: unknown): Record<string, unknown> {
    const record = asRecord(payload);
    const note = record['note'];
    if (note !== undefined && typeof note !== 'string') {
      throw new InvalidWorkPayload('"note" must be a string when present.');
    }
    if (typeof note === 'string' && note.length > MAX_NOTE_CHARS) {
      throw new InvalidWorkPayload(`"note" may be at most ${MAX_NOTE_CHARS} characters.`);
    }
    // Only the field this type declares is kept. Anything else a caller sent is
    // dropped rather than stored, so the payload cannot become a place to smuggle
    // data past the size bound or the schema.
    return note === undefined ? {} : { note };
  },
});

export function workType(type: string): WorkTypeDefinition {
  const found = REGISTRY.get(type);
  if (!found) throw new UnknownWorkType(type);
  return found;
}

export function listWorkTypes(): WorkTypeDefinition[] {
  return [...REGISTRY.values()];
}

export function isRegisteredWorkType(type: string): boolean {
  return REGISTRY.has(type);
}

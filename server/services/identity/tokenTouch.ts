/**
 * A token's use, recorded even when the database was busy at the moment of use.
 *
 * `touchToken` used to be fire-and-forget from the authentication path: one
 * attempt, no catch, and a rejection that escaped to the process backstop. Under
 * database pressure it was the first write to be lost — and it is not cosmetic.
 * `first_used_at` on a rotated successor is how `connectorHealth` learns that a
 * refresh reply *was* picked up; without it a connector whose client refreshed
 * perfectly well reads `REPLY_NOT_PICKED_UP`, its next unanswered fire is
 * charged to auth, and three of those read `CLIENT_STOPPED_RETRYING` — a human
 * reconnect demanded because a write was dropped while the database was busy.
 *
 * So a touch is held in memory under the instant it was observed and written
 * with retries on a doubling wait, coalesced per token (the earliest first use
 * and the latest use are kept, which is exactly what the two columns mean). A
 * process that dies holding unwritten touches loses them, and that is the
 * honest bound: the next use writes again.
 */
import { touchToken } from '../../repos/oauth.ts';
import { asWorkload } from '../../db/infra.ts';
import { outsideTransaction } from '../../db/database.ts';

interface Pending {
  first: string;
  last: string;
  attempts: number;
  heldAt: number;
}

const pending = new Map<string, Pending>();
/** Taken by a flush and not yet written; still a use `connectorHealth` must see. */
const inflight = new Map<string, Pending>();
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;
/**
 * Far longer than any outage this repository has recorded. A touch given up is
 * a use `connectorHealth` can no longer see, which reads a picked-up reply as
 * never picked up — the first step to a reconnect nobody needs — so the bound is
 * a day rather than an hour; memory is bounded by `MAX_PENDING` either way.
 */
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
/** Bound on held touches. One per live token; a fleet holds tens. */
const MAX_PENDING = 10_000;
let nextDelay = 0;

/** Record a use now and write it as soon as the database will take it. */
export function recordTokenUse(tokenId: string, at: string = new Date().toISOString()): void {
  const held = pending.get(tokenId);
  if (held) {
    if (at < held.first) held.first = at;
    if (at > held.last) held.last = at;
  } else {
    if (pending.size >= MAX_PENDING) return;
    pending.set(tokenId, { first: at, last: at, attempts: 0, heldAt: Date.now() });
  }
  schedule(0);
}

/** One flush at a time; a flush that ends with work left reschedules itself. */
function schedule(delayMs: number): void {
  if (timer || flushing) return;
  timer = setTimeout(() => {
    timer = null;
    flushing = flush().finally(() => {
      flushing = null;
      if (pending.size > 0) schedule(nextDelay);
    });
  }, delayMs);
  timer.unref?.();
}

async function flush(): Promise<void> {
  const batch = [...pending.entries()];
  pending.clear();
  for (const [tokenId, held] of batch) inflight.set(tokenId, held);
  let worstAttempt = 0;
  for (const [tokenId, held] of batch) {
    try {
      // Outside any transaction the authentication context carried, and on the
      // workload pool: a touch is not latency-critical and must never take a
      // control-plane connection from an authentication.
      await outsideTransaction(() => asWorkload(async () => {
        // The earliest use first, so `first_used_at` takes it; then the latest.
        await touchToken(tokenId, held.first);
        if (held.last !== held.first) await touchToken(tokenId, held.last);
      }));
      inflight.delete(tokenId);
    } catch {
      inflight.delete(tokenId);
      held.attempts += 1;
      if (Date.now() - held.heldAt > GIVE_UP_AFTER_MS) continue;
      const again = pending.get(tokenId);
      if (again) {
        if (held.first < again.first) again.first = held.first;
        if (held.last > again.last) again.last = held.last;
        again.attempts = Math.max(again.attempts, held.attempts);
        again.heldAt = Math.min(again.heldAt, held.heldAt);
      } else {
        pending.set(tokenId, held);
      }
      worstAttempt = Math.max(worstAttempt, held.attempts);
    }
  }
  nextDelay = worstAttempt === 0 ? 0 : Math.min(60_000, 500 * 2 ** Math.min(worstAttempt, 7));
}

/** Tests and shutdown: wait until every held touch is written or given up. */
export async function settleTokenTouches(): Promise<void> {
  for (let i = 0; i < 50 && (pending.size > 0 || flushing || timer); i += 1) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!flushing && pending.size > 0) {
      flushing = flush().finally(() => {
        flushing = null;
      });
    }
    if (flushing) await flushing;
  }
}

/** Whether a use of this token is held in memory and not yet written. */
export function tokenUseHeld(tokenId: string): boolean {
  return pending.has(tokenId) || inflight.has(tokenId);
}

/**
 * The newest held use of each token not yet written, for a reader that must
 * count a use it cannot see in the table yet (`connectorHealth`).
 */
export function heldTokenUses(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, held] of [...inflight.entries(), ...pending.entries()]) {
    const seen = out.get(id);
    if (!seen || held.last > seen) out.set(id, held.last);
  }
  return out;
}

export function pendingTokenTouches(): number {
  return pending.size;
}

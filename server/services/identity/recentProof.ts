/**
 * A machine bearer this process proved recently, so the MCP handshake can be
 * completed while the database is not answering.
 *
 * Why it exists. A Claude Code session opens its Brain connector once, when the
 * session starts: `initialize`, then `tools/list`, inside a connect timeout of
 * about thirty seconds and a few quick retries, after which the server is marked
 * failed for the life of that session (code.claude.com/docs/en/mcp). Every one
 * of those requests authenticates against the database first, so a pooler stall
 * at that instant — measured at fifteen seconds and more at p95 on bad days
 * (§61) — produced a session that started, never had Brain's tools, ended, and
 * was recorded as a fired session that never checked in. Reproduced from this
 * repository's own Claude session on 2026-10-15: `Factory_Brain` failed to
 * connect after 30 000 ms, and its first call answered 503 Service Unavailable,
 * while the next call a moment later authenticated normally.
 *
 * What it allows, exactly. Only the handshake — methods that read nothing, write
 * nothing and return the same answer to every caller (§21: the tool list is not
 * an access control) — and only when the authoritative check failed for want of
 * a database or did not answer within its budget. A credential the database
 * *refused* is forgotten here at once, so a revocation is honoured the next time
 * the database answers; a credential never proved by this process is not in
 * here at all. Every tool call still authenticates against current rows.
 *
 * What it holds. A sha-256 of the presented bearer (never the bearer), the
 * principal it resolved to, when, and when the credential expires. In memory,
 * per process, bounded, and gone on restart — which is the safe direction.
 */
import crypto from 'node:crypto';
import type { Principal } from '../../domain/types.ts';

/** How long a proof stands in for the database, for the handshake only. */
export const RECENT_PROOF_MS = 15 * 60_000;
const MAX_ENTRIES = 2_000;

interface Proof {
  principal: Principal;
  provedAt: number;
  /** The credential's own expiry, when it has one. A proof never outlives it. */
  expiresAt: number | null;
}

const proofs = new Map<string, Proof>();

function keyOf(bearer: string): string {
  return crypto.createHash('sha256').update(bearer).digest('hex');
}

/** Record that the database just authenticated this bearer as this principal. */
export function rememberProof(bearer: string, principal: Principal, expiresAt: string | null, now = Date.now()): void {
  const key = keyOf(bearer);
  proofs.delete(key);
  proofs.set(key, { principal, provedAt: now, expiresAt: expiresAt ? Date.parse(expiresAt) : null });
  while (proofs.size > MAX_ENTRIES) {
    const oldest = proofs.keys().next().value;
    if (oldest === undefined) break;
    proofs.delete(oldest);
  }
}

/** The database refused this bearer: no proof of it may stand in for anything. */
export function forgetProof(bearer: string): void {
  proofs.delete(keyOf(bearer));
}

/** A principal this bearer was proved as within `RECENT_PROOF_MS`, and before it expired. */
export function recentProof(bearer: string, now = Date.now()): Principal | null {
  const proof = proofs.get(keyOf(bearer));
  if (!proof) return null;
  if (now - proof.provedAt > RECENT_PROOF_MS || (proof.expiresAt !== null && now >= proof.expiresAt)) {
    proofs.delete(keyOf(bearer));
    return null;
  }
  return proof.principal;
}

/** For tests. */
export function resetRecentProofs(): void {
  proofs.clear();
}

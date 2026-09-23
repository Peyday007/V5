/**
 * "Could not reach the database" is wrong about a database that is answering.
 *
 * ---------------------------------------------------------------------------
 * What was observed
 * ---------------------------------------------------------------------------
 *
 * Production, 2026-09-23. Two operator reads dispatched in the same second —
 * `Factory campaigns` and `Admin workers list`, different workflows, different
 * scripts — both died at 09:38:59Z with:
 *
 *     DatabaseConfigurationError: Brain is configured for Postgres but could
 *     not reach aws-0-us-east-2.pooler.supabase.com:5432/postgres.
 *       detail: 'Connection terminated due to connection timeout Nothing was
 *       written locally: cloud mode does not fall back, …'
 *
 * The host was reachable throughout. The same Brain answered `/healthz` in
 * 0.38s either side of it and `/api/auth/login` from Postgres in 5.2s. What
 * had run out was connections: a managed session-mode pooler shares its limit
 * with every client of it, the running app holds its own, and each
 * `flyctl ssh console` script opens a pool beside them.
 *
 * Every word of that message points somewhere else. `could not reach` and
 * `connection timeout` together read as a wrong address or a dead host, and
 * `hintFor` — which exists to turn the driver's wording into the change that
 * would fix it — had no branch for a timeout, so it added nothing.
 *
 * ---------------------------------------------------------------------------
 * Why this is not the widening one file along
 * ---------------------------------------------------------------------------
 *
 * `describePoolerRefusal` was widened the same morning to name
 * `ECHECKOUTTIMEOUT`, which is what failed deploy 323's post-restart
 * verification *mid-run*. It would not have helped these two reads at all:
 * they failed in `openCloud`'s verification query, before any statement, and
 * their message carries no pooler marker to match on. Two paths, two
 * diagnoses — and fixing only the first would have left the condition that
 * was actually observed on the console still unexplained.
 *
 * ---------------------------------------------------------------------------
 * What this pins
 * ---------------------------------------------------------------------------
 *
 * That the branch fires on the wording production produced; that it names the
 * one knob that makes it worse; that it does **not** assert the pooler, since
 * a host which accepts a connection and then stalls looks identical from
 * here; and that it is last, so every more specific condition still wins.
 */
import { describe, it, expect } from 'vitest';
import { hintFor } from '../server/db/database.ts';

/** The reason string exactly as production produced it. */
const PRODUCTION_TIMEOUT = 'Connection terminated due to connection timeout';

describe('a connection that was never handed over is not an unreachable host', () => {
  it('recognises the wording production actually produced', () => {
    const hint = hintFor(PRODUCTION_TIMEOUT);
    expect(hint).not.toBe('');
    expect(hint).toContain('what did not happen in time is getting a connection');
  });

  it('also recognises the pool’s own phrasing for the same condition', () => {
    expect(hintFor('timeout exceeded when trying to connect')).not.toBe('');
    expect(hintFor('timeout expired')).not.toBe('');
    expect(hintFor('connect ETIMEDOUT 1.2.3.4:5432')).not.toBe('');
  });

  /*
   * The half that matters. Somebody reading "could not reach" reaches for the
   * address and the network, and then for the one knob they know about — and
   * that knob is the wrong way round, exactly as it is for the two pooler
   * conditions in the adapter.
   */
  it('contradicts the sentence it attaches to, and names the wrong remedy as wrong', () => {
    const hint = hintFor(PRODUCTION_TIMEOUT);
    expect(hint).toContain('The address resolved and nothing refused it');
    expect(hint).toMatch(/BRAIN_DATABASE_POOL_SIZE makes that worse/);
    expect(hint).toMatch(/fewer\s+concurrent clients/);
  });

  /*
   * And it stops short of asserting the pooler, because a host that accepts a
   * connection and then stalls produces the identical message. A hint that
   * ruled that out would send somebody to count clients while the database is
   * the thing that is unwell — §29's warning that cries wolf, one condition
   * along.
   */
  it('says the pooler is the usual cause without claiming it is this one', () => {
    const hint = hintFor(PRODUCTION_TIMEOUT);
    expect(hint).toContain('usually means');
    expect(hint).toMatch(/accepts a connection and then stalls looks\s+the same/);
  });

  /*
   * Last, and that is load-bearing: a refused connection, a name that does
   * not resolve, an untrusted certificate and a rejected password all say
   * more than "it timed out", and several of them can carry the word timeout
   * in the driver's own text.
   */
  it('never takes a condition an earlier branch owns', () => {
    expect(hintFor('connect ECONNREFUSED 127.0.0.1:5432')).toContain('Check the host and port');
    expect(hintFor('getaddrinfo ENOTFOUND db.example')).toContain('Check the host and port');
    expect(hintFor('connect EHOSTUNREACH 1.2.3.4:5432')).toContain('nothing could be reached');
    expect(hintFor('The server does not support SSL connections')).toContain('Brain requires TLS');
    expect(hintFor('self signed certificate in certificate chain')).toContain('not trusted');
    expect(hintFor('password authentication failed for user "brain"')).toContain(
      'the credentials are not',
    );
  });

  it('is silent about anything it does not recognise', () => {
    expect(hintFor('relation "labor_tasks" does not exist')).toBe('');
    expect(hintFor('')).toBe('');
  });
});

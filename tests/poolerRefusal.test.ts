/**
 * A pooler refusing a new client is a third condition, and it had no sentence.
 *
 * ---------------------------------------------------------------------------
 * What was observed, and why a driver object is not a diagnosis
 * ---------------------------------------------------------------------------
 *
 * Production, 2026-09-20. `release: success` on `41f8741`, the app perfectly
 * healthy — `/api/auth/login` answered 401 in 1.1s after a real lookup — and
 * four consecutive operator reads in a row died like this:
 *
 *     LABOR-REPORT: FAILED error: (EMAXCONNSESSION) max clients reached in
 *     session mode - max clients are limited to pool_size: 15
 *       length: 117, severity: 'FATAL', code: 'XX000', detail: undefined,
 *       hint: undefined, position: undefined, internalPosition: undefined,
 *       … eighteen more undefined fields …
 *
 * Another workstream's `Manufacturing programme` read failed identically in
 * the same minutes, which is the tell: it is not about the caller.
 *
 * §27 built `describePoolExhaustion` for the two conditions `pg-pool`
 * collapses — every connection checked out, against a server that would not
 * hand one over — *because their remedies are opposite*. This is neither. The
 * pooler refused the connection **before any pool of this process's own
 * existed to be exhausted**, so no reading of `total`, `idle` or `waiting`
 * describes it, and `describePoolExhaustion` is never reached.
 *
 * The remedy is opposite again, which is the whole reason it needs its own
 * sentence: raising `BRAIN_DATABASE_POOL_SIZE` makes this *worse*, because the
 * binding number is the pooler's and it is shared.
 *
 * ---------------------------------------------------------------------------
 * What this pins
 * ---------------------------------------------------------------------------
 *
 * The matcher is narrow on purpose — the code **and** the marker — because the
 * failure mode that matters is naming a condition that is not this one. A
 * diagnosis that fires on an unrelated `XX000` would be §29's warning that
 * cries wolf, at a connection string.
 */
import { describe, it, expect } from 'vitest';
import { describePoolerRefusal } from '../server/db/adapters/postgres.ts';

/**
 * The checkout timeout exactly as production printed it, and nothing more.
 *
 * Deploy 323's post-restart hosted verification, 2026-09-23 09:13:17Z, after
 * reading 434 documents and handing a worker its assignment. **No `code` is
 * set on this fixture on purpose**: the harness printed the message and no
 * fields, so the code is not established, and a fixture that invented one
 * would be pinning a guess.
 *
 * The two console reads that failed twenty-five minutes later are *not* this
 * condition, and an earlier version of this comment said they were. They died
 * on the boot path with `Connection terminated due to connection timeout` and
 * no pooler marker, which is `tests/bootHint.test.ts`'s subject. Same
 * scarcity underneath; different error, different diagnosis.
 */
function productionCheckoutTimeout(): Error {
  return new Error(
    '(ECHECKOUTTIMEOUT) unable to check out connection from the pool after 15000ms in Session mode',
  );
}

/** The error exactly as `pg` raised it in production. */
function productionRefusal(): Error & { code: string } {
  const error = new Error(
    '(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15',
  ) as Error & { code: string };
  error.code = 'XX000';
  return error;
}

describe('a pooler refusing a new client says so, and says whose limit it is', () => {
  it('recognises the refusal production actually raised', () => {
    const said = describePoolerRefusal(productionRefusal());
    expect(said).not.toBeNull();
    expect(said).toContain('refused a new client');
  });

  it('carries the pooler’s own words, including the number that was binding', () => {
    const said = describePoolerRefusal(productionRefusal()) ?? '';
    expect(said).toContain('EMAXCONNSESSION');
    expect(said).toContain('pool_size: 15');
  });

  /*
   * The half that matters most. Somebody reading this while the app is
   * healthy will reach for the one knob they know about, and it is the wrong
   * way round: the binding limit is not this application's.
   */
  it('says the limit is the pooler’s and not this application’s', () => {
    const said = describePoolerRefusal(productionRefusal()) ?? '';
    expect(said).toMatch(/pooler's rather than this application's/);
    expect(said).toMatch(/shared with every other client/);
  });

  it('names the remedy, and names raising the ceiling as the wrong one', () => {
    const said = describePoolerRefusal(productionRefusal()) ?? '';
    expect(said).toMatch(/BRAIN_DATABASE_POOL_SIZE would make this worse/);
    expect(said).toMatch(/fewer concurrent clients/);
  });

  it('is silent about anything that is not this condition', () => {
    const wrongCode = new Error('(EMAXCONNSESSION) max clients reached') as Error & {
      code: string;
    };
    wrongCode.code = '53300';
    expect(describePoolerRefusal(wrongCode)).toBeNull();

    const wrongMessage = new Error('relation "labor_tasks" does not exist') as Error & {
      code: string;
    };
    wrongMessage.code = 'XX000';
    expect(describePoolerRefusal(wrongMessage)).toBeNull();

    expect(describePoolerRefusal(null)).toBeNull();
    expect(describePoolerRefusal(undefined)).toBeNull();
    expect(describePoolerRefusal('a string')).toBeNull();
    expect(describePoolerRefusal({ code: 'XX000' })).toBeNull();
  });

  /*
   * And it stays apart from its neighbour. The two answer different questions
   * and prescribe opposite remedies, so a reader must never see one while the
   * other is what happened.
   */
  it('does not repeat the checkout-timeout diagnosis, which has the opposite remedy', () => {
    const said = describePoolerRefusal(productionRefusal()) ?? '';
    expect(said).not.toContain('had no free connection within');
    expect(said).not.toContain('caller(s) waiting');
  });
});

/*
 * The fourth condition, and the one that had no sentence until it had already
 * failed a release gate.
 *
 * Deploy 323 released `901a42db`, passed its pre-restart verification
 * 229/229, and then died after the restart on a checkout timeout — with
 * neither diagnosis firing. Brain's own pool had not timed out, so
 * `describePoolExhaustion` was never reached; the marker is not
 * `EMAXCONNSESSION`, so `describePoolerRefusal` returned null. What a reader
 * got was the driver's bare string, which is what these sentences exist to
 * replace.
 *
 * Each assertion below was run against the unwidened function first and fails
 * there, because a regression nobody has seen fail is a claim rather than a
 * reading.
 */
describe('a pooler that cannot get this client a connection says so too', () => {
  it('recognises the checkout timeout production actually raised', () => {
    const said = describePoolerRefusal(productionCheckoutTimeout());
    expect(said).not.toBeNull();
    expect(said).toContain('could not get it a database connection in time');
  });

  it('carries the pooler’s own words, including the timeout that was binding', () => {
    const said = describePoolerRefusal(productionCheckoutTimeout()) ?? '';
    expect(said).toContain('ECHECKOUTTIMEOUT');
    expect(said).toContain('15000ms');
  });

  /*
   * The half that matters most, and it is the same half for both pooler
   * conditions: somebody reading this reaches for the one knob they know
   * about, and it is the wrong way round.
   */
  it('names raising the ceiling as the wrong remedy, exactly as its neighbour does', () => {
    const said = describePoolerRefusal(productionCheckoutTimeout()) ?? '';
    expect(said).toMatch(/BRAIN_DATABASE_POOL_SIZE would make this worse/);
    expect(said).toMatch(/fewer concurrent clients/);
  });

  /*
   * Named apart from `EMAXCONNSESSION` rather than folded into it. One is the
   * pooler refusing a client outright; this is the pooler accepting one and
   * then failing upstream, which can equally be a database that has gone
   * slow. Telling a reader the wrong one sends them to count clients when the
   * database is the thing that is unwell.
   */
  it('does not claim the client was refused, because it was not', () => {
    const said = describePoolerRefusal(productionCheckoutTimeout()) ?? '';
    expect(said).not.toContain('refused a new client');
    expect(said).toContain('accepted this client');
    expect(said).toMatch(/database itself|gone slow/);
  });

  it('does not borrow the pool reading, which does not describe this', () => {
    const said = describePoolerRefusal(productionCheckoutTimeout());
    /*
     * Asserted non-null first, and that is not ceremony. With `?? ''` every
     * `not.toContain` below passes against a function that recognises
     * nothing — which is exactly how this assertion behaved against the
     * unwidened version while its five neighbours failed. §41: a vacuous
     * guard is worse than none, because it reads as coverage.
     */
    expect(said).not.toBeNull();
    expect(said ?? '').not.toContain('had no free connection within');
    expect(said ?? '').not.toContain('caller(s) waiting');
  });

  /*
   * The code is not required, and that is a statement about the evidence
   * rather than a loosening. The marker is what carries the specificity —
   * nothing else in this system emits the literal `(ECHECKOUTTIMEOUT)` — so
   * keying on it alone is as narrow as the code-and-marker pair beside it.
   */
  it('recognises it whatever the driver put in `code`, and still refuses everything else', () => {
    const withCode = productionCheckoutTimeout() as Error & { code: string };
    withCode.code = 'XX000';
    expect(describePoolerRefusal(withCode)).not.toBeNull();

    const unrelated = new Error('could not check out a book from the library');
    expect(describePoolerRefusal(unrelated)).toBeNull();
    expect(describePoolerRefusal({ message: 42 })).toBeNull();
  });
});

/**
 * The third thing the pooler says, and the only one that is about the
 * database rather than about clients.
 *
 * Production, 2026-09-23 22:17:51Z, a one-client goals read against a Brain
 * serving `/healthz` in 0.2s: `(EAUTHQUERY) auth_query secret check timed
 * out`. The pooler verifies a credential by querying the database, and that
 * query did not come back in time — so the database behind it was slow, and
 * the read printed no diagnosis at all because neither branch above matched.
 */
describe('a pooler that could not check a credential says the database is slow', () => {
  const production = () => new Error('(EAUTHQUERY) auth_query secret check timed out\n');

  it('recognises it, carries its words, and names the database rather than the password', () => {
    const said = describePoolerRefusal(production()) ?? '';
    expect(said).toContain('EAUTHQUERY');
    expect(said).toMatch(/database itself/);
    expect(said).toMatch(/not a wrong password/);
  });

  it('does not send a reader to count clients or raise the ceiling', () => {
    const said = describePoolerRefusal(production()) ?? '';
    expect(said).not.toMatch(/fewer concurrent clients/);
    expect(said).toMatch(/BRAIN_DATABASE_POOL_SIZE changes nothing/);
  });
});

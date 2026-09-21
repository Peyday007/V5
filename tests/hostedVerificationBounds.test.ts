/**
 * The two bounds the hosted verification actually runs inside, and what each
 * of them was measured against.
 *
 * Deploy 277 is the first run in this repository's history where the release
 * gate's own request bound was applied rather than pre-empted, and what it
 * revealed is two separate conditions that had been arriving as one
 * unattributable `fetch failed` for nine runs. Both are pinned here, and both
 * assertions were run against the tree that had neither, to watch them fail
 * before they were trusted to pass.
 *
 * Neither bound is a fix for the slowness behind it, and neither is claimed to
 * be. A lease that is beaten is not a judge pass that got faster, and a
 * checkout that is waited for is not a fan-out that got smaller.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createProject } from '../server/repos/projects.ts';
import { createWorker } from '../server/repos/identity.ts';
import { freshProject, teardown } from './helpers.ts';
import { databaseConfig } from '../server/config.ts';
import {
  claimWork,
  completeWork,
  enqueueWork,
  getWorkItem,
  heartbeatWork,
  DEFAULT_LEASE_MS,
  MIN_LEASE_MS,
  proveLeaseOwnership,
  type ClaimScope,
  type OwnershipProof,
} from '../server/repos/workQueue.ts';
import { getDb } from '../server/db/database.ts';
import type { ClaimedWork, WorkerScope } from '../server/domain/types.ts';

const SCOPES: WorkerScope[] = ['queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'];

/** Source with comments removed: the prose below quotes the names it asserts. */
function code(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

describe('a lease held across work that outlasts it', () => {
  let projectId = '';
  let workerId = '';
  let scopes: ClaimScope[] = [];

  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    workerId = (
      await createWorker({ name: 'slow-worker', createdByType: 'SYSTEM', createdById: 'test' })
    ).id;
    scopes = [{ projectId, scopes: SCOPES }];
  });
  afterEach(teardown);

  async function claimOne(leaseMs: number): Promise<ClaimedWork> {
    await enqueueWork({
      projectId,
      workType: 'SYNTHETIC_ECHO',
      payload: { note: 'slow' },
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
    });
    const [claim] = await claimWork({ workerId, scopes, leaseMs });
    if (!claim) throw new Error('nothing was claimed');
    return claim;
  }

  function proofOf(claim: ClaimedWork): OwnershipProof {
    return {
      workItemId: claim.workItemId,
      workerId,
      leaseId: claim.leaseId,
      leaseGeneration: claim.leaseGeneration,
    };
  }

  /**
   * The failure deploy 277 measured, reproduced at a scale a test can wait for.
   *
   * There the numbers were a judge pass of 9m44s against a five-minute lease;
   * here they are five seconds against a claim that sits for six. The shape is
   * the same: the submission is not the thing that fails, the completion after
   * it is.
   *
   * The *word* differs, and writing this test is what established why. In
   * isolation an unbeaten lease simply runs out and the completion is refused
   * `LEASE_EXPIRED`; production said `FENCE_LOST`, which is the stronger fact —
   * the expired item had already been re-offered and retaken, so the generation
   * had moved on. Both are the same refusal for the same reason, and asserting
   * one of them would have made this test a claim about how busy the live queue
   * happened to be.
   */
  it('lapses, and refuses the completion after it, when nothing says the worker is alive', async () => {
    const claim = await claimOne(MIN_LEASE_MS);
    await new Promise((resolve) => setTimeout(resolve, MIN_LEASE_MS + 1_000));
    const done = await completeWork(proofOf(claim), { summary: 'too late' });
    expect(done.ok).toBe(false);
    expect(['LEASE_EXPIRED', 'FENCE_LOST']).toContain(done.ok === false && done.rejection);
  }, 20_000);

  it('survives the same wait when the worker beats, and the completion is accepted', async () => {
    const claim = await claimOne(MIN_LEASE_MS);
    const before = (await getWorkItem(claim.workItemId))?.leaseExpiresAt ?? '';
    const beat = await heartbeatWork(proofOf(claim));
    expect(beat.ok).toBe(true);
    const after = (await getWorkItem(claim.workItemId))?.leaseExpiresAt ?? '';
    expect(after > before).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, MIN_LEASE_MS + 1_000));
    const done = await completeWork(proofOf(claim), { summary: 'in time' });
    expect(done.ok).toBe(true);
  }, 20_000);

  it('does not let a beat decide how long Brain will wait', async () => {
    const claim = await claimOne(MIN_LEASE_MS);
    await heartbeatWork(proofOf(claim), { leaseMs: 7 * 24 * 60 * 60 * 1000 });
    const item = await getWorkItem(claim.workItemId);
    const held = Date.parse(item?.leaseExpiresAt ?? '') - Date.now();
    expect(held).toBeLessThanOrEqual(60 * 60 * 1000 + 5_000);
  });

  it('refuses a beat from a worker that does not hold the lease', async () => {
    const claim = await claimOne(MIN_LEASE_MS);
    const other = (
      await createWorker({ name: 'other-worker', createdByType: 'SYSTEM', createdById: 'test' })
    ).id;
    const beat = await heartbeatWork({ ...proofOf(claim), workerId: other });
    expect(beat.ok).toBe(false);
  });
});

describe('the release gate leases its research work for longer than it takes', () => {
  const source = code('scripts/verify-hosted.ts');

  it('takes a lease at claim time rather than trying to beat a fenced effect', () => {
    expect(source).toMatch(/claimWork\(\{[\s\S]{0,400}leaseMs: RESEARCH_LEASE_MS/);
  });

  it('leases for comfortably longer than the longest judge pass measured', () => {
    const ms = /RESEARCH_LEASE_MS = ([0-9 *_]+);/.exec(source)?.[1];
    expect(ms).toBeDefined();
    // eslint-disable-next-line no-eval
    const value = Number(eval(ms!.replace(/_/g, '')));
    expect(value).toBeGreaterThan(10 * 60 * 1000);
  });

  it('no longer carries the heartbeat that a fenced effect defeats', () => {
    expect(source).not.toContain('holdingLease');
  });
});

describe('how long a checkout may wait', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
  });

  function asCloud(): void {
    process.env['BRAIN_DATABASE_PROVIDER'] = 'postgres';
    process.env['BRAIN_DATABASE_URL'] = 'postgresql://someone@example.invalid:5432/brain';
  }

  it('is ten seconds unless something says otherwise', () => {
    asCloud();
    delete process.env['BRAIN_DATABASE_CONNECT_TIMEOUT_MS'];
    expect(databaseConfig().connectTimeoutMs).toBe(10_000);
  });

  it('is read from the environment, so a process that chose a small pool may be patient', () => {
    asCloud();
    process.env['BRAIN_DATABASE_CONNECT_TIMEOUT_MS'] = '120000';
    expect(databaseConfig().connectTimeoutMs).toBe(120_000);
  });

  it('refuses a value that is not a whole number of milliseconds in range', () => {
    asCloud();
    for (const bad of ['0', '900', 'soon', '1.5', '600001']) {
      process.env['BRAIN_DATABASE_CONNECT_TIMEOUT_MS'] = bad;
      expect(() => databaseConfig()).toThrow(/BRAIN_DATABASE_CONNECT_TIMEOUT_MS/);
    }
  });

  /**
   * A config value nothing reads is not a bound. `describeConnectionHeadroom`
   * had exactly this shape once, and §29's rule about a column nothing reads
   * is why this is asserted against the source rather than assumed.
   */
  it('reaches the pool rather than stopping at the config', () => {
    expect(code('server/db/database.ts')).toContain('connectionTimeoutMillis: config.connectTimeoutMs');
  });

  it('is set by the release gate, beside the small pool that made it necessary', () => {
    expect(code('scripts/verify-hosted.ts')).toMatch(
      /BRAIN_DATABASE_CONNECT_TIMEOUT_MS'\]\s*=\s*'\d+'/,
    );
  });
});


/**
 * Why the release gate takes its lease at claim time, measured rather than
 * argued — and the hypothesis this replaces, which was wrong.
 *
 * Two production deploys were spent on a heartbeat that did not hold the
 * lease. The first explanation was that a beat is *defeated* by the effect's
 * fence: every mutation is fenced by `proveLeaseOwnership`, an `UPDATE` of the
 * work item row inside the effect's own transaction (§20), so a nine-minute
 * submission holds that row's lock for nine minutes and a concurrent beat
 * blocks on it. Half of that is true and the conclusion was not.
 *
 * What this measures: the beat **does** block for the whole transaction, and
 * it then **succeeds** — because `heartbeatWork` captures `queueNow()` in
 * JavaScript before the statement runs, so both the `lease_expires_at > ?`
 * comparison and the new expiry are computed from the pre-block clock. A
 * blocked beat is therefore not refused; it extends the lease to *its own
 * capture time* plus a lease, which is already in the past by the time it
 * lands.
 *
 * That is the real ceiling, and it is arithmetic rather than a refusal: beats
 * cannot push the lease past the last beat that got a connection. It is why
 * the remedy is a lease taken at claim time, which needs no extending at all.
 *
 * Postgres only: SQLite serialises writers, so the two statements can never
 * overlap there and the test would be asserting against the absence of the
 * condition it exists to demonstrate. §34 records the same restriction.
 */
const POSTGRES = process.env['BRAIN_TEST_DATABASE_URL'];

describe.skipIf(!POSTGRES)('a beat issued against a fenced effect', () => {
  let projectId = '';
  let workerId = '';

  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    workerId = (
      await createWorker({ name: 'fenced-worker', createdByType: 'SYSTEM', createdById: 'test' })
    ).id;
  });
  afterEach(teardown);

  it('blocks for the whole effect, then lands with the clock it captured before blocking', async () => {
    await enqueueWork({
      projectId,
      workType: 'SYNTHETIC_ECHO',
      payload: { note: 'fenced' },
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
    });
    const [claim] = await claimWork({
      workerId,
      scopes: [{ projectId, scopes: SCOPES }],
      leaseMs: MIN_LEASE_MS,
    });
    if (!claim) throw new Error('nothing was claimed');
    const proof: OwnershipProof = {
      workItemId: claim.workItemId,
      workerId,
      leaseId: claim.leaseId,
      leaseGeneration: claim.leaseGeneration,
    };

    const HELD_MS = MIN_LEASE_MS + 2_000;
    let blockedForMs: number | null = null;
    let beatOk: boolean | null = null;
    const started = Date.now();

    const effect = getDb().transaction(async () => {
      expect(await proveLeaseOwnership(proof)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, HELD_MS));
    });

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const beatIssuedAt = Date.now() - started;
    const beat = heartbeatWork(proof).then((result) => {
      blockedForMs = Date.now() - started;
      beatOk = result.ok;
    });

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(blockedForMs).toBeNull(); // still waiting on the fence's row lock

    await effect;
    await beat;

    // It waited for the effect to commit rather than skipping the row.
    expect(blockedForMs!).toBeGreaterThanOrEqual(HELD_MS);
    // And it was accepted, on the clock it captured before it blocked.
    expect(beatOk).toBe(true);

    /*
     * And here is the ceiling, which is the whole reason a beat cannot rescue
     * a long submission: the lease now ends `DEFAULT_LEASE_MS` after the beat
     * was **issued**, not after it landed. Nine minutes of blocking buys
     * nothing beyond that, and with the harness's two-connection pool only two
     * beats are ever in flight — so the lease tops out near the second beat's
     * issue time plus five minutes, which a nine-minute submission outruns.
     */
    const item = await getWorkItem(claim.workItemId);
    const extendedTo = Date.parse(item!.leaseExpiresAt!) - started;
    expect(extendedTo).toBeGreaterThanOrEqual(beatIssuedAt + DEFAULT_LEASE_MS - 500);
    expect(extendedTo).toBeLessThan(beatIssuedAt + DEFAULT_LEASE_MS + 2_000);
  }, 40_000);
});

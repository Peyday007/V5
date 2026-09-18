/**
 * One Cash Mode, one frontier, one objective — and privacy that starts later.
 *
 * The four properties this correction is made of, each pinned where it could
 * actually regress.
 */
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_CASH_OBJECTIVE,
  CANONICAL_CASH_SUMMARY,
  objectiveWith,
} from '../server/services/cash/root.ts';
import { jobCeilingCents, mayReadJob, redactJob } from '../server/services/cash/jobs.ts';
import type { CashJob } from '../server/domain/types.ts';
import { findCashRoot, resolveOrCreateCashRoot } from '../server/services/cash/root.ts';
import { CASH_LAYER_NAME } from '../server/services/cash/lifecycle.ts';
import { createLayer } from '../server/repos/layers.ts';
import { listProjects } from '../server/repos/projects.ts';
import { freshProject } from './helpers.ts';

function job(over: Partial<CashJob> = {}): CashJob {
  return {
    id: 'cjb_1',
    opportunityId: 'cop_1',
    projectId: 'prj_root',
    state: 'ASSIGNED',
    ownerUserId: 'usr_owner',
    visibility: 'PRIVATE',
    budgetCents: 50_000,
    currency: 'USD',
    note: 'a private note',
    assignedAt: '2026-09-17T00:00:00.000Z',
    releasedAt: null,
    releaseReason: null,
    createdBy: 'usr_owner',
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    ...over,
  };
}

describe('the canonical objective', () => {
  it('is the mandate itself when nobody added anything', () => {
    expect(objectiveWith(null)).toBe(CANONICAL_CASH_OBJECTIVE);
    expect(objectiveWith('')).toBe(CANONICAL_CASH_OBJECTIVE);
    expect(objectiveWith('   ')).toBe(CANONICAL_CASH_OBJECTIVE);
  });

  it('adds a person’s constraints without replacing any of it', () => {
    const composed = objectiveWith('Avoid anything requiring a vehicle. Deadline: Friday.');
    // The whole mandate survives, verbatim. This is the property the correction
    // exists for: a person's wording may narrow priorities and may never become
    // the boundary of what Brain will search.
    expect(composed).toContain(CANONICAL_CASH_OBJECTIVE);
    expect(composed).toContain('Avoid anything requiring a vehicle');
    // And the two halves stay tellable apart, so a worker reading the mission
    // knows which is standing and which is this week's steer.
    expect(composed).toContain('they do not replace the mandate above');
  });

  it('says the broad things a narrow objective would have silently dropped', () => {
    for (const phrase of [
      'full opportunity universe',
      'not named by the user',
      'longer-cycle opportunities',
      'never as an exhaustive boundary',
    ]) {
      expect(CANONICAL_CASH_OBJECTIVE).toContain(phrase);
    }
    expect(CANONICAL_CASH_SUMMARY.length).toBeGreaterThan(80);
  });
});

describe('privacy begins at the job, not at discovery', () => {
  it('lets the owner read their own job', () => {
    expect(mayReadJob(job(), 'usr_owner', [])).toBe(true);
  });

  it('refuses somebody else, and refuses an anonymous reader', () => {
    expect(mayReadJob(job(), 'usr_other', [])).toBe(false);
    expect(mayReadJob(job(), null, [])).toBe(false);
  });

  it('lets a named participant read it, and only a named one', () => {
    expect(mayReadJob(job(), 'usr_mate', ['usr_mate'])).toBe(true);
    expect(mayReadJob(job(), 'usr_stranger', ['usr_mate'])).toBe(false);
  });

  it('opens a job its owner deliberately shared', () => {
    expect(mayReadJob(job({ visibility: 'SHARED' }), 'usr_other', [])).toBe(true);
  });

  it('shows that a job exists without leaking whose it is or what it may spend', () => {
    const seen = redactJob(job(), 'usr_other', []);
    expect(seen.mine).toBe(false);
    // Existence and state are shared, because the opportunity is — hiding it
    // would have two people start the same work.
    expect(seen.state).toBe('ASSIGNED');
    expect(seen.opportunityId).toBe('cop_1');
    // The private half is absent rather than nulled.
    expect(seen.ownerUserId).toBeUndefined();
    expect(seen.budgetCents).toBeUndefined();
    expect(seen.note).toBeUndefined();
  });

  it('gives the owner the whole thing', () => {
    const seen = redactJob(job(), 'usr_owner', []);
    expect(seen.mine).toBe(true);
    expect(seen.budgetCents).toBe(50_000);
    expect(seen.note).toBe('a private note');
  });
});

describe('a job budget can only ever narrow the grant', () => {
  it('is bounded by the grant when the job asks for more', () => {
    expect(jobCeilingCents(job({ budgetCents: 900_000 }), 300_000)).toBe(300_000);
  });

  it('is the job’s own when it is the smaller', () => {
    expect(jobCeilingCents(job({ budgetCents: 50_000 }), 300_000)).toBe(50_000);
  });

  it('falls back to the grant when the job set none', () => {
    expect(jobCeilingCents(job({ budgetCents: null }), 300_000)).toBe(300_000);
  });

  it('is null only when neither exists, so nothing is invented', () => {
    expect(jobCeilingCents(job({ budgetCents: null }), null)).toBeNull();
  });
});


describe('the one shared root', () => {
  /*
   * The consolidation property, and the reason it is resolution rather than
   * migration: a frontier started before any sprint existed has a layer and
   * packets and no `cash_modes` row, and it must be *adopted* — found where it
   * already is — rather than copied somewhere new. Copying would duplicate
   * evidence, and moving would break a worker mid-packet.
   */
  it('adopts the project already holding the research, creating nothing', async () => {
    const fixture = await freshProject();
    await createLayer({
      projectId: fixture.project.id,
      name: CASH_LAYER_NAME,
      orderIndex: 0,
    });

    const before = (await listProjects()).length;
    const root = await findCashRoot();
    expect(root?.id).toBe(fixture.project.id);

    // Resolving it again returns the same project and makes no second one.
    const resolved = await resolveOrCreateCashRoot();
    expect(resolved.id).toBe(fixture.project.id);
    expect((await listProjects()).length).toBe(before);
  });

  it('reads as not-started rather than bringing a root into existence', async () => {
    // A person looking at an inactive page must not create anything by looking.
    const before = (await listProjects()).length;
    await findCashRoot();
    expect((await listProjects()).length).toBe(before);
  });
});

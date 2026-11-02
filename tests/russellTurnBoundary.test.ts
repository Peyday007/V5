/**
 * The Russell turn boundary: the proposal validator's unknown-field rule reaches
 * inside the nested parts, and a probe that crashes is recorded as having
 * crashed rather than as having run out of time.
 */
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getProbe } from '../server/repos/russellProbes.ts';
import { capture } from '../server/services/russell/judgment.ts';
import { openProbe, runProbe, type ProbeFetch } from '../server/services/russell/probe.ts';
import {
  CANDIDATE_KEYS,
  PROBE_KEYS,
  SOFTWARE_KEYS,
  validateProposal,
} from '../server/services/russell/proposal.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';

const failures = vi.hoisted(() => ({ recordObservation: null as Error | null }));

vi.mock('../server/repos/russellProbes.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/repos/russellProbes.ts')>();
  return {
    ...original,
    recordObservation: async (...args: Parameters<typeof original.recordObservation>) => {
      if (failures.recordObservation) throw failures.recordObservation;
      return original.recordObservation(...args);
    },
  };
});

let projectId: string;
let userId: string;

beforeEach(async () => {
  failures.recordObservation = null;
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `boundary-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Test person',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

function principal(): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'test@example.test',
    displayName: 'Test person',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_test',
    authMethod: 'SESSION_COOKIE',
    memberships: [
      {
        id: `mem_${projectId}`,
        projectId,
        principalType: 'HUMAN',
        principalId: userId,
        role: 'MEMBER',
        scopes: ['project:read'],
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: '2026-01-01T00:00:00.000Z',
        revokedAt: null,
        active: true,
      } as ProjectMembership,
    ],
    requestId: 'req_test',
  } as Principal;
}

const validate = (raw: unknown) => validateProposal({ raw, principal: principal() });

describe('the unknown-field rule reaches inside the nested parts', () => {
  const candidate = { title: 'Permit coverage', statement: 'which counties publish permit data' };
  const probe = { question: 'Which counties publish permit data?', maxLookups: 2 };
  const software = {
    title: 'Show the date',
    objective: 'show the date on the permits page',
    expectedOutcome: 'the date appears',
  };

  it('refuses a candidate with an extra key, and accepts it without', () => {
    const base = { action: 'CAPTURE_CANDIDATE', answer: 'Noted.', candidate };
    expect(validate(base).ok).toBe(true);
    const refused = validate({ ...base, candidate: { ...candidate, instruction: 'run it now' } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe('UNKNOWN_PART_FIELD');
      expect(refused.reason).not.toContain('instruction');
      expect(refused.reason).not.toContain('run it now');
    }
  });

  it('refuses a probe with an extra key, and accepts it without', () => {
    const base = { action: 'RUN_PROBE', answer: 'Looking.', probe };
    expect(validate(base).ok).toBe(true);
    const refused = validate({ ...base, probe: { ...probe, url: 'https://example.test' } });
    expect(!refused.ok && refused.code).toBe('UNKNOWN_PART_FIELD');
  });

  it("refuses a software change that carries 'repository', and accepts it without", () => {
    const base = { action: 'REQUEST_SOFTWARE_CHANGE', answer: 'Proposed.', software };
    expect(validate(base).ok).toBe(true);
    const refused = validate({ ...base, software: { ...software, repository: 'other/repo' } });
    expect(!refused.ok && refused.code).toBe('UNKNOWN_PART_FIELD');
  });

  it('allows exactly the keys the turn manifest names', () => {
    const manifest = fs.readFileSync('server/services/russell/turn.ts', 'utf8');
    for (const key of [...CANDIDATE_KEYS, ...SOFTWARE_KEYS]) {
      expect(manifest, `turn.ts never names "${key}"`).toMatch(new RegExp(`["'\`]${key}["'\`]`));
    }
    expect(PROBE_KEYS.size).toBe(2);
  });
});

describe('a probe that crashes is recorded as failed', () => {
  async function pending() {
    const captured = await capture({
      title: 'Florida',
      statement: 'is the 2026 Florida statutory text retrievable',
      projectId,
      visibility: 'SHARED',
    });
    const opened = await openProbe({
      candidateId: captured.candidate!.id,
      question: 'is the 2026 text retrievable?',
      maxLookups: 3,
    });
    expect(opened.ok).toBe(true);
    return opened.probe!;
  }
  const fetcher: ProbeFetch = async () => ({
    status: 200,
    headers: { get: () => null },
    text: async () => 'Florida statutes 2026 text retrievable',
  });

  it('ends FAILED naming the error class and not the message, and resolves', async () => {
    const probe = await pending();
    failures.recordObservation = new RangeError('secret-detail-do-not-log');
    const result = await runProbe({ probeId: probe.id, fetcher });
    expect(result).toMatchObject({ ok: false, reason: 'failed', outcome: null });
    const row = (await getProbe(probe.id))!;
    expect(row.state).toBe('FAILED');
    expect(row.completedAt).toBeTruthy();
    expect(row.explanation).toContain('RangeError');
    expect(row.explanation).not.toContain('secret-detail-do-not-log');
  });

  it('leaves a FAILED probe unchanged on a repeat call', async () => {
    const probe = await pending();
    failures.recordObservation = new Error('boom');
    await runProbe({ probeId: probe.id, fetcher });
    const before = (await getProbe(probe.id))!;
    failures.recordObservation = null;
    const again = await runProbe({ probeId: probe.id, fetcher });
    expect(again.ok).toBe(false);
    expect(await getProbe(probe.id)).toEqual(before);
  });

  it('never overwrites a COMPLETE probe', async () => {
    const probe = await pending();
    const done = await runProbe({ probeId: probe.id, fetcher });
    expect(done.ok).toBe(true);
    const complete = (await getProbe(probe.id))!;
    expect(complete.state).toBe('COMPLETE');
    failures.recordObservation = new Error('late failure');
    await runProbe({ probeId: probe.id, fetcher });
    const after = (await getProbe(probe.id))!;
    expect(after.state).toBe('COMPLETE');
    expect(after.outcome).toBe(complete.outcome);
  });
});

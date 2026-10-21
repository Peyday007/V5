/**
 * Two gaps `docs/STEP-12B-BACKLOG.md` recorded during the connected
 * integration pass, deferred only because an acceptance run was live.
 *
 * (1) `validateProposal`'s unknown-field rule stopped at the top level: a key
 * inside `candidate`, `probe` or `software` that this version does not
 * recognise was silently dropped rather than refusing the whole proposal, so
 * §24's own claim ("an unknown field ... fails the whole proposal rather than
 * being dropped") was broader than the code. A compliant worker — one that
 * sends only what `turn.ts`'s manifest instructions actually name — is
 * unaffected either way, which is what the second half of each test below
 * checks.
 *
 * (2) `failProbe` had no caller. `runProbe` already classifies every network
 * failure inside `fetchOnce` as `UNREACHABLE` and never lets one escape, but
 * anything Brain's own code threw after `startProbe` — a rejected
 * `permitLookup` or `recordObservation` call, most often — escaped `runProbe`
 * uncaught and left the probe `RUNNING` until `listExpiredProbes` ended it at
 * `UNKNOWN` on a later tick. "The probe crashed" and "the probe ran out of
 * time" were recorded identically.
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';
import type { ProbeFetch } from '../server/services/russell/probe.ts';
import {
  CANDIDATE_PART_FIELDS,
  PROBE_PART_FIELDS,
  SOFTWARE_PART_FIELDS,
  validateProposal,
} from '../server/services/russell/proposal.ts';
import { capture } from '../server/services/russell/judgment.ts';
import { allowlistFor, GENERAL_LIGHT_PROBE_V1 } from '../server/services/russell/probeEnvelope.ts';

/*
 * `recordObservation` is the write `runProbe` performs once per lookup, and
 * it is the one the backlog entry names as the realistic way for Brain's own
 * code to fail mid-probe (a database error, rather than the network failure
 * `fetchOnce` already classifies as `UNREACHABLE` on its own). Toggled per
 * test rather than mocked once for the whole file, so every other test in
 * this suite — including the ordinary-completion ones below — exercises the
 * real repository.
 */
let forceObservationFailure = false;

vi.mock('../server/repos/russellProbes.ts', async (original) => {
  const real = await original<typeof import('../server/repos/russellProbes.ts')>();
  return {
    ...real,
    recordObservation: async (input: Parameters<typeof real.recordObservation>[0]) => {
      if (forceObservationFailure) {
        throw new Error('simulated database failure while recording an observation');
      }
      return real.recordObservation(input);
    },
  };
});

const { createProbe, getProbe } = await import('../server/repos/russellProbes.ts');
const { runProbe } = await import('../server/services/russell/probe.ts');

const REPO = fileURLToPath(new URL('..', import.meta.url));
const turnManifestSource = fs.readFileSync(path.join(REPO, 'server/services/russell/turn.ts'), 'utf8');

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `turn-boundary-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Test person',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  forceObservationFailure = false;
});

function principal(memberships: ProjectMembership[]): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'test@example.test',
    displayName: 'Test person',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_test',
    authMethod: 'SESSION_COOKIE',
    memberships,
    requestId: 'req_test',
  } as Principal;
}

function membership(id: string): ProjectMembership {
  return {
    id: `mem_${id}`,
    projectId: id,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'MEMBER',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
    grantedAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
    active: true,
  } as ProjectMembership;
}

function propose(raw: unknown) {
  return validateProposal({ raw, principal: principal([membership(projectId)]) });
}

describe('an unknown field inside a proposed part refuses the whole proposal', () => {
  it('refuses a CAPTURE_CANDIDATE whose candidate carries an extra key', () => {
    const withExtra = propose({
      action: 'CAPTURE_CANDIDATE',
      answer: 'Noted.',
      candidate: {
        title: 'A worthwhile idea',
        statement: 'This is worth capturing.',
        // Neither the validator nor the worker manifest knows this key. A
        // worker that believed it would take effect has it silently dropped
        // under the old behaviour, with the rest of the proposal acted on.
        projectId,
      },
    });
    expect(withExtra.ok).toBe(false);
    if (withExtra.ok) throw new Error('unreachable');
    expect(withExtra.code).toBe('UNKNOWN_PART_FIELD');
    // Safe to show and safe to log: the sentence names the part, never the
    // offending key or its value.
    expect(withExtra.reason).not.toMatch(/projectId/);

    // The otherwise-identical proposal, with the extra key removed, validates
    // exactly as it always has — a compliant worker is unaffected.
    const withoutExtra = propose({
      action: 'CAPTURE_CANDIDATE',
      answer: 'Noted.',
      candidate: { title: 'A worthwhile idea', statement: 'This is worth capturing.' },
    });
    expect(withoutExtra.ok).toBe(true);
    if (!withoutExtra.ok) throw new Error('unreachable');
    expect(withoutExtra.proposal.candidate).toEqual({
      title: 'A worthwhile idea',
      statement: 'This is worth capturing.',
      duplicateOf: null,
    });
  });

  it('refuses a RUN_PROBE whose probe carries an extra key', () => {
    const withExtra = propose({
      action: 'RUN_PROBE',
      answer: 'Looking into it.',
      probe: { question: 'Is this documented anywhere official?', maxLookups: 2, priority: 'MUST_DO' },
    });
    expect(withExtra.ok).toBe(false);
    if (withExtra.ok) throw new Error('unreachable');
    expect(withExtra.code).toBe('UNKNOWN_PART_FIELD');

    const withoutExtra = propose({
      action: 'RUN_PROBE',
      answer: 'Looking into it.',
      probe: { question: 'Is this documented anywhere official?', maxLookups: 2 },
    });
    expect(withoutExtra.ok).toBe(true);
    if (!withoutExtra.ok) throw new Error('unreachable');
    expect(withoutExtra.proposal.probe).toEqual({
      question: 'Is this documented anywhere official?',
      maxLookups: 2,
    });
  });

  it('refuses a REQUEST_SOFTWARE_CHANGE whose software names a repository', () => {
    const withExtra = propose({
      action: 'REQUEST_SOFTWARE_CHANGE',
      answer: 'I have written that down for you to authorize.',
      software: {
        title: 'Fix the checkout total',
        objective: 'The total should update without a page reload.',
        expectedOutcome: 'The total updates live as items change.',
        // Which repository a project may change is a person's authorization,
        // never a model's guess — `software` deliberately carries no
        // repository field at all, so a worker naming one is refused rather
        // than having the field quietly dropped and the rest of the request
        // acted on.
        repository: 'owner/name',
      },
    });
    expect(withExtra.ok).toBe(false);
    if (withExtra.ok) throw new Error('unreachable');
    expect(withExtra.code).toBe('UNKNOWN_PART_FIELD');
    expect(withExtra.reason).not.toMatch(/owner\/name|repository/i);

    const withoutExtra = propose({
      action: 'REQUEST_SOFTWARE_CHANGE',
      answer: 'I have written that down for you to authorize.',
      software: {
        title: 'Fix the checkout total',
        objective: 'The total should update without a page reload.',
        expectedOutcome: 'The total updates live as items change.',
      },
    });
    expect(withoutExtra.ok).toBe(true);
    if (!withoutExtra.ok) throw new Error('unreachable');
    expect(withoutExtra.proposal.software).toEqual({
      title: 'Fix the checkout total',
      objective: 'The total should update without a page reload.',
      expectedOutcome: 'The total updates live as items change.',
    });
  });

  it('never refuses a duplicateOf reference on its own — that is a shape check only', () => {
    const result = propose({
      action: 'CAPTURE_CANDIDATE',
      answer: 'Noted, and it repeats an idea already open.',
      candidate: {
        title: 'A worthwhile idea',
        statement: 'This is worth capturing.',
        duplicateOf: 'rcn_00000000000000000000',
      },
    });
    expect(result.ok).toBe(true);
  });

  /*
   * §24's own rule, applied to this gap: the contract a worker is judged
   * against and the contract it is handed have to be the same object. Every
   * key this validator accepts for `candidate` and `software` must be
   * something `turn.ts`'s manifest instructions actually name to a worker —
   * checked against the file's own source rather than a second, hand-kept
   * copy of the list, so the two cannot drift apart.
   *
   * `turn.ts` names `title` and `statement` in quotes and `duplicateOf` by
   * property access (`candidate.duplicateOf`) rather than in quotes, so the
   * check here is "this exact identifier appears in the manifest text",
   * which is what actually matters — a worker reading either form learns the
   * key exists — rather than requiring one specific punctuation style.
   */
  it('names every candidate and software key in the manifest a worker is told about', () => {
    for (const key of CANDIDATE_PART_FIELDS) {
      expect(
        new RegExp(`\\b${key}\\b`).test(turnManifestSource),
        `turn.ts's manifest never mentions the candidate field "${key}" to a worker`,
      ).toBe(true);
    }
    for (const key of SOFTWARE_PART_FIELDS) {
      expect(
        new RegExp(`\\b${key}\\b`).test(turnManifestSource),
        `turn.ts's manifest never mentions the software field "${key}" to a worker`,
      ).toBe(true);
    }
  });

  // `probe` is deliberately not offered to a worker at all — `RUN_PROBE` has
  // no consumer, so the manifest never invites it (see `EXECUTABLE_ACTIONS`'s
  // own comment) — so `PROBE_PART_FIELDS` has nothing to be checked against
  // turn.ts for, and this suite does not invent a requirement the contract
  // never asked for.
  it('exports PROBE_PART_FIELDS for the validator alone, with no manifest counterpart to check', () => {
    expect(PROBE_PART_FIELDS.has('question')).toBe(true);
    expect(PROBE_PART_FIELDS.has('maxLookups')).toBe(true);
  });
});

describe('a probe that crashes after it starts is recorded honestly, not left running', () => {
  async function openTestProbe(question: string) {
    const captured = await capture({
      title: 'Turn boundary probe',
      statement: question,
      projectId,
      visibility: 'SHARED',
    });
    return createProbe({
      candidateId: captured.candidate!.id,
      projectId,
      visibility: 'SHARED',
      question,
      // Matches what `openProbe` derives from the same envelope, so
      // `permitLookup`'s allowlist check passes and the mocked fetcher is
      // actually reached — a probe judged by an allowlist it was not
      // actually opened under would not exercise the path this test is for.
      allowedSources: allowlistFor(GENERAL_LIGHT_PROBE_V1),
      maxLookups: 1,
      deadlineMinutes: 5,
      idempotencyKey: `turn-boundary-${captured.candidate!.id}-${question}`,
    });
  }

  // Echoes the question back in the body, exactly as read off the fetched
  // URL — `destinationFor` carries it as a query value — so `mentions()`
  // finds it and the ordinary path below reaches SUPPORTED rather than
  // WEAKENED, whatever question a given test asks.
  const okFetcher: ProbeFetch = async (url) => {
    const question = Array.from(new URL(url).searchParams.values()).join(' ');
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => `This page discusses the following directly: ${question}`,
    };
  };

  it('ends FAILED with a class-only explanation when a step after startProbe throws', async () => {
    const probe = await openTestProbe('does a write failure end the probe honestly?');

    forceObservationFailure = true;
    const result = await runProbe({ probeId: probe.id, fetcher: okFetcher });
    forceObservationFailure = false;

    // `runProbe` resolves with a result rather than rejecting the caller.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('failed');
    expect(result.outcome).toBeNull();

    const ended = await getProbe(probe.id);
    expect(ended!.state).toBe('FAILED');
    expect(ended!.completedAt).toBeTruthy();
    expect(ended!.outcome).toBeNull();
    // The class, and nothing about the row or the query that failed.
    expect(ended!.explanation).toMatch(/Error/);
    expect(ended!.explanation).not.toMatch(/simulated database failure|observation/);
  });

  it('leaves an ordinary completion exactly as it was before this change', async () => {
    const probe = await openTestProbe('does normal completion still work exactly as before?');

    const result = await runProbe({ probeId: probe.id, fetcher: okFetcher });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('ran');
    expect(result.outcome).toBe('SUPPORTED');

    const ended = await getProbe(probe.id);
    expect(ended!.state).toBe('COMPLETE');
    expect(ended!.outcome).toBe('SUPPORTED');
  });

  it('does not change a probe already FAILED when runProbe is called again', async () => {
    const probe = await openTestProbe('does a second run leave a failed probe alone?');

    forceObservationFailure = true;
    await runProbe({ probeId: probe.id, fetcher: okFetcher });
    forceObservationFailure = false;

    const failed = await getProbe(probe.id);
    expect(failed!.state).toBe('FAILED');
    const explanationAfterFirstRun = failed!.explanation;
    const completedAtAfterFirstRun = failed!.completedAt;

    // failProbe is guarded to PENDING/RUNNING exactly as completeProbe is, so
    // a second run against a terminal probe changes nothing on the row —
    // whatever this second run itself reports.
    await runProbe({ probeId: probe.id, fetcher: okFetcher });

    const stillFailed = await getProbe(probe.id);
    expect(stillFailed!.state).toBe('FAILED');
    expect(stillFailed!.explanation).toBe(explanationAfterFirstRun);
    expect(stillFailed!.completedAt).toBe(completedAtAfterFirstRun);
  });
});

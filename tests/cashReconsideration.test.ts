/**
 * Reconsideration: one change, everyone waiting on it, once each
 * (OPPORTUNITY-INTELLIGENCE §3.2(c)–(f), assignment B).
 *
 * The acceptance case is the plan's §5 row C: a hundred opportunities share
 * `CAPABILITY:SEND_A_MESSAGE`, the capability arrives, and one tick
 * reconsiders all hundred — with the eight capability readers asked once, not
 * a hundred times, and a statement count that grows with what changed rather
 * than with the portfolio. Around it, the rules that make that safe: a change
 * reconsiders a piece once and a different change does again (no lifetime
 * cap); a person's archive is asked about and never moved; a trigger is never
 * readiness; a crash mid-pass replays without doubling anything.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import {
  createOpportunity,
  getOpportunity,
  listNeeds,
} from '../server/repos/cashPortfolio.ts';
import {
  recordReopenCondition,
  reopenConditionsFor,
} from '../server/repos/cashReconsideration.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import {
  answerHumanRequest,
  getHumanRequest,
  listOpenRequests,
} from '../server/repos/russellMissions.ts';
import { createProgram, declareCapabilityHeld, ensureCapability } from '../server/repos/manufacturing.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  insertClaims,
  resetHostReachabilityCache,
  updateFragment,
} from '../server/repos/research.ts';
import { activate, setLifecycle } from '../server/services/cash/lifecycle.ts';
import { archiveOpportunity } from '../server/services/cash/opportunities.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { CAPABILITIES } from '../server/services/cash/capabilities.ts';
import { CONTACT_BUYER_NAMESPACE } from '../server/services/cash/effects.ts';
import { operate, reconcileCapabilityNeeds } from '../server/services/cash/operate.ts';
import {
  CAPABILITY_CHANGED_EVENT,
  RECONSIDER_REQUEST_PREFIX,
  RECONSIDERATION_TRIGGERED_EVENT,
  commitDetection,
  detectChanges,
  fanOut,
  readSourceHostChanges,
  reconsiderAffected,
  recordDerivedReopenConditions,
} from '../server/services/cash/reconsider.ts';
import { projectStandings } from '../server/services/cash/standing.ts';
import { resumeAnsweredRequest } from '../server/services/russell/needsHuman.ts';
import {
  clearAdapters,
  registerAdapter,
  type EffectAdapter,
} from '../server/services/effects/adapter.ts';
import type { BlockerKey } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let modeId = '';
let layerId = '';

const SEND: BlockerKey = 'CAPABILITY:SEND_A_MESSAGE';

beforeEach(async () => {
  clearAdapters();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await fixture.layerByName('Discovery Logic')).id;
  const user = await createUser({
    email: `reconsider-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const outcome = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
  modeId = (await getCashMode(projectId))!.id;
});

afterEach(() => {
  clearAdapters();
});

function messagingAdapter(): EffectAdapter {
  return {
    name: 'test.messaging',
    effectClass: 'EXTERNAL_OPAQUE',
    namespace: CONTACT_BUYER_NAMESPACE.name,
    validate: (payload) => payload as Record<string, unknown>,
    fingerprintInputs: (payload) => payload,
    send: async (request) => ({ kind: 'CONFIRMED', receiptRef: `rcpt_${request.businessId}` }),
  };
}

async function piece(title: string, requiredCapabilities: string[] = []): Promise<string> {
  const created = await createOpportunity({
    projectId,
    cashModeId: modeId,
    ownerUserId: userId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    requiredCapabilities,
  });
  return created.id;
}

/** One reconsideration tick, as `operate` runs it: detect and fan out, then the capability path. */
async function tick() {
  const pass = await reconsiderAffected(projectId);
  const needs = await reconcileCapabilityNeeds(projectId, { readings: pass.readings });
  return { pass, needs };
}

/** How many times any capability reader actually ran while `work` ran. */
async function readsDuring<T>(work: () => Promise<T>): Promise<{ value: T; reads: number }> {
  let reads = 0;
  const originals = CAPABILITIES.map((one) => one.read);
  for (const definition of CAPABILITIES) {
    const read = definition.read;
    if (!read) continue;
    (definition as { read: typeof read }).read = async () => {
      reads += 1;
      return read();
    };
  }
  try {
    return { value: await work(), reads };
  } finally {
    CAPABILITIES.forEach((definition, index) => {
      (definition as { read: unknown }).read = originals[index];
    });
  }
}

/** Every statement the adapter runs while `work` runs. */
async function statementsDuring<T>(work: () => Promise<T>): Promise<{ value: T; statements: number }> {
  const db = getDb() as unknown as Record<'all' | 'get' | 'run', (...args: unknown[]) => unknown>;
  const originals = { all: db.all, get: db.get, run: db.run };
  let statements = 0;
  for (const method of ['all', 'get', 'run'] as const) {
    const original = originals[method];
    db[method] = (...args: unknown[]) => {
      statements += 1;
      return original.apply(db, args);
    };
  }
  try {
    return { value: await work(), statements };
  } finally {
    db.all = originals.all;
    db.get = originals.get;
    db.run = originals.run;
  }
}

async function eventsOf(kind: string): Promise<{ id: string; opportunity_id: string | null }[]> {
  return getDb().all(
    'SELECT id, opportunity_id FROM cash_events WHERE project_id = ? AND kind = ?',
    [projectId, kind],
  );
}

/** Make every piece look untouched for a while, so the next pass reads only what changed. */
async function ageAllPieces(): Promise<void> {
  await getDb().run(`UPDATE cash_opportunities SET updated_at = ? WHERE project_id = ?`, [
    '2020-01-01T00:00:00.000Z',
    projectId,
  ]);
}


/** One accepted claim in one lane, from a fresh orchestration in this project. */
async function acceptedClaim(lane: string, text: string): Promise<string> {
  const run = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: text,
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: text,
    assignment: text,
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId,
      geography: 'anywhere',
      requiredEvidence: [{ id: lane, description: 'a published source', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['an organisation’s own published pages'],
      excludedSourceTypes: ['a forecast presented as a current fact'],
      completionCriteria: ['a located passage'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'q',
      question: text,
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const [claim] = await insertClaims([
    {
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: text,
      sourceUrl: 'https://example.test/page',
      sourceTitle: 'A page',
      sourcePublisher: 'The organisation',
      sourceDate: '2026-09-11',
      evidenceExcerpt: text,
      evidenceLocator: 'the page body',
      evidenceLane: lane,
      retrievedAt: '2026-09-12',
      confidence: 0.9,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: `${text}|${lane}`,
    },
  ]);
  await decideClaim(claim!.id, { accepted: true });
  return orchestration.id;
}

describe('a hundred pieces share one blocker, and it changes', () => {
  it('reconsiders all hundred in one tick, reading each capability once', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 100; index += 1) ids.push(await piece(`Opening ${index}`, ['SEND_A_MESSAGE']));

    // The first tick names what is missing: one need each, all under one shared key.
    const first = await tick();
    expect(first.needs.raised).toHaveLength(100);
    const needs = await listNeeds({ projectId, states: ['OPEN'] });
    expect(needs).toHaveLength(100);
    expect(new Set(needs.map((one) => one.blockerKey))).toEqual(new Set([SEND]));

    // An unchanged tick over an untouched portfolio does a constant amount of work.
    await ageAllPieces();
    const idle = await readsDuring(() => statementsDuring(() => tick()));
    expect(idle.value.value.pass.triggered).toEqual([]);
    expect(idle.value.value.needs.examined).toBe(0);
    expect(idle.reads).toBeLessThanOrEqual(CAPABILITIES.length);
    expect(idle.value.statements).toBeLessThan(40);

    // The capability arrives.
    registerAdapter(messagingAdapter());
    const flipped = await readsDuring(() => statementsDuring(() => tick()));
    const { pass, needs: settled } = flipped.value.value;

    // All hundred become eligible — no count anywhere bounds that.
    expect(new Set(pass.triggered.map((one) => one.opportunityId))).toEqual(new Set(ids));
    expect(pass.triggered.every((one) => one.via === 'NEED' && one.key === SEND)).toBe(true);
    expect(settled.settled).toHaveLength(100);

    // The eight readers, once each: no per-opportunity readCapability.
    expect(flipped.reads).toBeLessThanOrEqual(CAPABILITIES.length);
    // Statements grow with the affected rows, never with portfolio × capabilities.
    expect(flipped.value.statements).toBeLessThan(100 * 12 + 60);

    expect(await eventsOf(CAPABILITY_CHANGED_EVENT)).toHaveLength(1);
    expect(await eventsOf(RECONSIDERATION_TRIGGERED_EVENT)).toHaveLength(100);

    // Reconsideration is not readiness: every piece is exactly where it was, flagged.
    for (const id of ids) {
      const after = (await getOpportunity(id))!;
      expect(after.state).toBe('DISCOVERED');
      expect(after.reconsiderRequestedAt).not.toBeNull();
    }

    // A replay triggers nothing twice.
    const replay = await tick();
    expect(replay.pass.triggered).toEqual([]);
    expect(await eventsOf(RECONSIDERATION_TRIGGERED_EVENT)).toHaveLength(100);
    expect(await eventsOf(CAPABILITY_CHANGED_EVENT)).toHaveLength(1);
  });

  it('a second, distinct change reconsiders them again: there is no lifetime cap', async () => {
    const ids = [await piece('One', ['SEND_A_MESSAGE']), await piece('Two', ['SEND_A_MESSAGE'])];
    await tick();
    registerAdapter(messagingAdapter());
    const arrived = await tick();
    expect(arrived.pass.triggered).toHaveLength(2);

    // It goes away: new needs, nothing reconsidered (a loss unblocks nobody).
    clearAdapters();
    const lost = await tick();
    expect(lost.pass.triggered).toEqual([]);
    expect(lost.needs.raised).toHaveLength(2);

    // It comes back: a different change, so both are eligible again.
    registerAdapter(messagingAdapter());
    const back = await tick();
    expect(new Set(back.pass.triggered.map((one) => one.opportunityId))).toEqual(new Set(ids));
    expect(back.pass.triggered[0]!.changeRef).not.toBe(arrived.pass.triggered[0]!.changeRef);
    expect(await eventsOf(RECONSIDERATION_TRIGGERED_EVENT)).toHaveLength(4);
    expect(await eventsOf(CAPABILITY_CHANGED_EVENT)).toHaveLength(3);
  });
});

describe('a piece a person stopped is asked about, never moved', () => {
  it('raises exactly one Needs-You request and leaves it archived', async () => {
    const id = await piece('An archived opening', ['SEND_A_MESSAGE']);
    const archived = await archiveOpportunity({
      opportunityId: id,
      actorRef: userId,
      reason: 'No way to reach buyers yet.',
      reopenWhen: [SEND],
    });
    expect(archived.ok).toBe(true);
    await tick();

    registerAdapter(messagingAdapter());
    const flipped = await tick();
    expect(flipped.pass.triggered).toEqual([
      expect.objectContaining({ opportunityId: id, via: 'PERSON', key: SEND }),
    ]);
    expect((await getOpportunity(id))!.state).toBe('ARCHIVED');

    const asking = (await listOpenRequests(projectId)).filter((one) =>
      one.resumeKey.startsWith(RECONSIDER_REQUEST_PREFIX),
    );
    expect(asking).toHaveLength(1);
    expect(asking[0]!.choices.map((one) => one.key).sort()).toEqual(['KEEP', 'RECONSIDER']);

    // Replays ask nothing more.
    await tick();
    await tick();
    expect(
      (await listOpenRequests(projectId)).filter((one) => one.resumeKey.startsWith(RECONSIDER_REQUEST_PREFIX)),
    ).toHaveLength(1);
    expect((await getOpportunity(id))!.state).toBe('ARCHIVED');

    // The person answers, and A's guarded transition is what moves it — to evaluation, never ready.
    const answered = await answerHumanRequest({
      requestId: asking[0]!.id,
      actorUserId: userId,
      choice: 'RECONSIDER',
      reason: 'Messaging exists now.',
    });
    expect(answered.ok).toBe(true);
    const resumed = await resumeAnsweredRequest((await getHumanRequest(asking[0]!.id))!);
    expect(resumed.settled).toBe(true);
    expect(resumed.ok).toBe(true);
    const after = (await getOpportunity(id))!;
    expect(after.state).toBe('DISCOVERED');
    expect(after.archivedReason).toBe('No way to reach buyers yet.');
  });

  it('keeps it stopped when the person says so', async () => {
    const id = await piece('A declined-then-archived opening', ['SEND_A_MESSAGE']);
    await archiveOpportunity({ opportunityId: id, actorRef: userId, reason: 'Not now.', reopenWhen: [SEND] });
    await tick();
    registerAdapter(messagingAdapter());
    await tick();
    const request = (await listOpenRequests(projectId)).find((one) =>
      one.resumeKey.startsWith(RECONSIDER_REQUEST_PREFIX),
    )!;
    await answerHumanRequest({ requestId: request.id, actorUserId: userId, choice: 'KEEP' });
    const resumed = await resumeAnsweredRequest((await getHumanRequest(request.id))!);
    expect(resumed.settled).toBe(true);
    expect((await getOpportunity(id))!.state).toBe('ARCHIVED');
  });
});

describe('every source that can change, fanned out', () => {
  it('a commercial grant reconsiders the pieces watching AUTHORITY:', async () => {
    const id = await piece('Waiting on a grant');
    await recordReopenCondition({
      projectId,
      opportunityId: id,
      blockerKey: 'AUTHORITY:CONTACT_BUYER',
      recordedFrom: 'WEAK_ECONOMICS',
      actorRef: 'BRAIN',
    });
    expect((await tick()).pass.triggered).toEqual([]);
    await createAuthority({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'Grant',
      allowedActions: [...COMMERCIAL_ACTIONS],
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 10_000,
      maxPerActionCents: 5_000,
      maxConcurrent: 2,
      currency: 'USD',
    });
    const granted = await tick();
    expect(granted.pass.triggered).toEqual([
      expect.objectContaining({ opportunityId: id, key: 'AUTHORITY:CONTACT_BUYER', via: 'DERIVED' }),
    ]);
    expect((await getOpportunity(id))!.state).toBe('DISCOVERED');
    expect((await tick()).pass.triggered).toEqual([]);
  });

  it('a manufacturing holding reconsiders the pieces watching MANUFACTURING:', async () => {
    const id = await piece('Needs small-engine integration');
    const { program } = await createProgram({
      projectId,
      objective: 'Build a ladder of machines this company can actually make and sell.',
      ownerUserId: userId,
      createdByUserId: userId,
    });
    const { capability } = await ensureCapability({
      programId: program.id,
      projectId,
      name: 'Small engine integration',
      origin: 'SEED',
    });
    await recordReopenCondition({
      projectId,
      opportunityId: id,
      blockerKey: `MANUFACTURING:${capability.slug}` as BlockerKey,
      recordedFrom: 'WEAK_ECONOMICS',
      actorRef: 'BRAIN',
    });
    expect((await tick()).pass.triggered).toEqual([]);
    await declareCapabilityHeld({ capabilityId: capability.id, evidence: 'DECLARED', heldBy: userId });
    const held = await tick();
    expect(held.pass.triggered).toEqual([
      expect.objectContaining({ opportunityId: id, via: 'DERIVED' }),
    ]);
  });

  it('a card fact touches only its own opportunity', async () => {
    const mine = await piece('Mine');
    const theirs = await piece('Theirs');
    for (const id of [mine, theirs]) {
      await recordReopenCondition({
        projectId,
        opportunityId: id,
        blockerKey: 'FIELD:disqualifiers',
        recordedFrom: 'DISQUALIFY',
        actorRef: 'BRAIN',
      });
    }
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordCardFact({
      projectId,
      opportunityId: mine,
      field: 'disqualifiers',
      kind: 'PERSON',
      value: 'The deadline was extended; nothing rules it out now.',
      decidedBy: userId,
    });
    const after = await tick();
    expect(after.pass.triggered.map((one) => one.opportunityId)).toEqual([mine]);
    expect((await getOpportunity(theirs))!.reconsiderRequestedAt).toBeNull();
    const conditions = await reopenConditionsFor(theirs);
    expect(conditions.every((one) => one.triggeredAt === null)).toBe(true);
  });

  it('a date that passed reconsiders the piece watching it, once', async () => {
    const id = await piece('Opens again on a date');
    await recordReopenCondition({
      projectId,
      opportunityId: id,
      blockerKey: 'DATE:2020-01-01',
      recordedFrom: 'EXPIRY',
      actorRef: 'BRAIN',
    });
    expect((await tick()).pass.triggered).toEqual([
      expect.objectContaining({ opportunityId: id, key: 'DATE:2020-01-01' }),
    ]);
    expect((await tick()).pass.triggered).toEqual([]);
  });

  it('a host a surface read again reconsiders the pieces watching SOURCE_HOST:', async () => {
    resetHostReachabilityCache();
    const id = await piece('Blocked on an unreachable registry');
    await recordReopenCondition({
      projectId,
      opportunityId: id,
      blockerKey: 'SOURCE_HOST:example.test',
      recordedFrom: 'ROUNDS_SPENT',
      actorRef: 'BRAIN',
    });
    expect((await tick()).pass.triggered).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await acceptedClaim('payer', 'The registry answered and published its fee table.');
    resetHostReachabilityCache();
    expect((await tick()).pass.triggered).toEqual([
      expect.objectContaining({ opportunityId: id, key: 'SOURCE_HOST:example.test', via: 'DERIVED' }),
    ]);
    resetHostReachabilityCache();
    expect((await tick()).pass.triggered).toEqual([]);
    expect(await readSourceHostChanges(projectId, '2999-01-01T00:00:00.000Z')).toEqual([]);
  });
});

describe('derived dead ends record what would reopen them', () => {
  it('a disqualified piece gets FIELD:disqualifiers, once, and a new answer reconsiders it', async () => {
    const id = await piece('Ruled out');
    await getDb().run(
      `UPDATE cash_opportunities SET validation_state = 'COMPLETE', validation_rounds = 1 WHERE id = ?`,
      [id],
    );
    await recordCardFact({
      projectId,
      opportunityId: id,
      field: 'disqualifiedBy',
      kind: 'PERSON',
      value: 'The RFP closed.',
      decidedBy: userId,
    });
    const standings = await projectStandings(projectId);
    // With nothing that could reopen it, it reads not worth pursuing…
    expect(standings.get(id)!.standing).toMatchObject({ kind: 'NOT_WORTH_PURSUING', cause: 'DISQUALIFIED' });
    const recorded = await recordDerivedReopenConditions(projectId, standings);
    expect(recorded).toEqual([
      { opportunityId: id, recordedFrom: 'DISQUALIFY', keys: ['FIELD:disqualifiers'] },
    ]);
    // …and once the watch is recorded, dormant until that field changes.
    expect((await projectStandings(projectId)).get(id)!.standing).toMatchObject({
      kind: 'DORMANT',
      cause: 'DISQUALIFIED',
      reopenWhen: ['FIELD:disqualifiers'],
    });
    // Idempotent.
    expect(await recordDerivedReopenConditions(projectId, await projectStandings(projectId))).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordCardFact({
      projectId,
      opportunityId: id,
      field: 'disqualifiers',
      kind: 'PERSON',
      value: 'It was reissued.',
      decidedBy: userId,
    });
    const after = await tick();
    expect(after.pass.triggered).toEqual([
      expect.objectContaining({ opportunityId: id, via: 'DERIVED', key: 'FIELD:disqualifiers' }),
    ]);
    const reread = (await getOpportunity(id))!;
    expect(reread.reconsiderRequestedAt).not.toBeNull();
    expect(reread.state).toBe('DISCOVERED');
  });
  it('a spent piece watches its unanswered lanes, and new evidence reconsiders it — but not another dive', async () => {
    const id = await piece('Both dives spent');
    await getDb().run(
      `UPDATE cash_opportunities SET validation_state = 'COMPLETE', validation_rounds = 2 WHERE id = ?`,
      [id],
    );
    const standings = await projectStandings(projectId);
    expect(standings.get(id)!.standing).toMatchObject({ cause: 'ROUNDS_SPENT' });
    const [recorded] = await recordDerivedReopenConditions(projectId, standings);
    expect(recorded!.recordedFrom).toBe('ROUNDS_SPENT');
    expect(recorded!.keys).toContain('EVIDENCE:payer');
    await tick();

    // Another opening's own deep dive finding a payer says nothing about this one.
    const other = await piece('Somebody else');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const dive = await acceptedClaim('payer', 'The county clerk pays for this other opening.');
    await getDb().run(`UPDATE cash_opportunities SET validation_orchestration_id = ? WHERE id = ?`, [dive, other]);
    expect((await tick()).pass.triggered).toEqual([]);

    // Evidence that is not one opening's dive does.
    await acceptedClaim('payer', 'Facilities managers publish paid requests for this work.');
    const after = await tick();
    expect(after.pass.triggered).toEqual([
      expect.objectContaining({ opportunityId: id, key: 'EVIDENCE:payer', via: 'DERIVED' }),
    ]);
    expect((await getOpportunity(id))!.state).toBe('DISCOVERED');
    expect((await tick()).pass.triggered).toEqual([]);
  });
});

describe('a crash mid-pass resumes without doubling anything', () => {
  it('replays a detection whose commit never ran', async () => {
    const ids = [await piece('A', ['SEND_A_MESSAGE']), await piece('B', ['SEND_A_MESSAGE'])];
    await tick();
    registerAdapter(messagingAdapter());

    // The pass dies after the fan-out and before the watermark moved.
    const detection = await detectChanges(projectId);
    const half = await fanOut(projectId, { changes: detection.changes });
    expect(half).toHaveLength(2);

    // The next pass reads the same change, consumes nothing twice, and commits once.
    const replay = await reconsiderAffected(projectId);
    expect(replay.triggered).toEqual([]);
    expect(await eventsOf(RECONSIDERATION_TRIGGERED_EVENT)).toHaveLength(2);
    expect(await eventsOf(CAPABILITY_CHANGED_EVENT)).toHaveLength(1);

    // And a stale commit of the dead pass is refused by the watermark's swap.
    expect(await commitDetection(projectId, detection)).toEqual([]);
    expect(await eventsOf(CAPABILITY_CHANGED_EVENT)).toHaveLength(1);
    expect(ids).toHaveLength(2);
  });
});

describe('a wound-down sprint records what changed and starts nothing', () => {
  it('flags the pieces and starts no re-dive', async () => {
    const id = await piece('Waiting', ['SEND_A_MESSAGE']);
    await operate(projectId);
    const wound = await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: 'Ending the sprint.',
    });
    expect(wound.ok).toBe(true);
    registerAdapter(messagingAdapter());
    const result = await operate(projectId);
    expect(result.reconsideration && 'triggered' in result.reconsideration
      ? result.reconsideration.triggered.map((one) => one.opportunityId)
      : []).toEqual([id]);
    expect((await getOpportunity(id))!.reconsiderRequestedAt).not.toBeNull();
    expect(await eventsOf('CASH_VALIDATION_STARTED')).toEqual([]);
    expect((await getOpportunity(id))!.validationState).toBeNull();
  });
});

/**
 * The continuation pass reads the archive for a goal it already found answered
 * only when something the answer depends on has moved, and considers every
 * active goal in a rotation that lives in rows.
 *
 * What is real here: the goal rows, the pass, the marker, the shared findings
 * (promoted by `promoteEligibleClaims` from an accepted claim) and the packet
 * rows. What is counted: calls to `inventoryProject`, the archive-wide read the
 * marker exists to avoid. Nothing is simulated except Brain's clock, which is
 * `Date` — the only clock the pass reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/services/reconcile/plan.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/services/reconcile/plan.ts')>();
  return { ...original, inventoryProject: vi.fn(original.inventoryProject) };
});

import { freshProject, teardown, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { importFile } from '../server/services/importer.ts';
import { whenExtractionIdle } from '../server/services/documents/queue.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordEvent } from '../server/repos/events.ts';
import { createRun } from '../server/repos/runs.ts';
import { createResearchGoal } from '../server/repos/russellAuthority.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  insertClaims,
  markContradiction,
  updateFragment,
} from '../server/repos/research.ts';
import {
  promoteEligibleClaims,
  revokeFinding,
  setFindingHorizon,
  listFindings,
} from '../server/repos/sharedFindings.ts';
import { inventoryProject } from '../server/services/reconcile/plan.ts';
import { MAX_GOALS_PER_PASS, advanceResearchGoals } from '../server/services/research/goalContinuation.ts';
import type { Layer } from '../server/domain/types.ts';

const DAY = 86_400_000;
const QUESTION = 'Employment in the outsourced telemarketing occupation';
const OTHER = 'Municipal bond issuance volume for small coastal harbours';
const ANSWERED = [
  'Recognition of custody transfer in the United States',
  '',
  'Employment in the outsourced telemarketing occupation was 81,580 in 2024 according to the',
  'Bureau of Labor Statistics. https://www.bls.gov/oes/current/oes419041.htm',
  '',
  'Census Bureau statistics put employment in the same outsourced telemarketing occupation at a',
  'comparable level for 2024. https://www.census.gov/programs-surveys/susb.html',
].join('\n');

let fixture: TestProject;
let layer: Layer;
let userId = '';
const calls = () => vi.mocked(inventoryProject).mock.calls.length;

beforeEach(async () => {
  vi.mocked(inventoryProject).mockClear();
  fixture = await freshProject();
  layer = await fixture.layerByName('Monetization Logic');
  userId = (
    await createUser({
      email: `gl-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
  await importFile({
    projectId: fixture.project.id,
    originalFilename: 'World Model v1.txt',
    contents: Buffer.from(ANSWERED),
    layerId: (await fixture.layerByName('World Model')).id,
    version: 'v1',
    documentType: 'FOUNDATION',
  });
  await whenExtractionIdle();
});
afterEach(async () => {
  vi.useRealTimers();
  await teardown();
});

async function newGoal(assignment = QUESTION, createdAt?: string) {
  const goal = await createResearchGoal({
    projectId: fixture.project.id,
    ownerUserId: userId,
    createdByUserId: userId,
    name: `Goal ${assignment.slice(0, 12)}`,
    maxPackets: 2,
    maxFragments: 10,
    deadline: new Date(Date.now() + 400 * DAY).toISOString(),
    researchAssignment: assignment,
    researchLayerId: layer.id,
  });
  if (createdAt) await getDb().run('UPDATE russell_goals SET created_at = ? WHERE id = ?', [createdAt, goal.id]);
  return goal;
}

async function pause(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

/** An accepted, sourced claim in an accepted fragment, promoted to the shared pool. */
async function sharedFinding(suffix: string): Promise<{ claimId: string; findingId: string }> {
  const projectId = fixture.project.id;
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a finding',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: `finding ${suffix}`,
    assignment: 'where to look',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'anywhere',
      requiredEvidence: [{ id: 'lane', description: 'a source', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['an agency page'],
      excludedSourceTypes: [],
      completionCriteria: ['one dated source'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: `frag-${suffix}`,
      question: 'What is published?',
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString() });
  const [claim] = await insertClaims([
    {
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: `A published figure ${suffix}`,
      sourceUrl: `https://example.gov/${suffix}`,
      sourceTitle: 'A page',
      sourcePublisher: 'An agency',
      sourceDate: '2026-09-10',
      evidenceExcerpt: 'a figure',
      evidenceLocator: 'the table',
      evidenceLane: 'lane',
      retrievedAt: '2026-09-12',
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: `h-${suffix}`,
    },
  ]);
  await decideClaim(claim!.id, { accepted: true });
  await promoteEligibleClaims();
  const findings = await listFindings({ limit: 500 });
  const found = findings.find((one) => one.claimId === claim!.id);
  if (!found) throw new Error('the claim was not promoted');
  return { claimId: claim!.id, findingId: found.findingId };
}

describe('the archive is read again only when something it reads moved', () => {
  it('reads once while nothing changes, including after the clock moves on', async () => {
    const goal = await newGoal();
    const first = await advanceResearchGoals();
    expect(first.answeredByArchive).toEqual([goal.id]);
    expect(calls()).toBe(1);

    for (let pass = 0; pass < 4; pass += 1) {
      const report = await advanceResearchGoals();
      expect(report.answeredByArchive).toEqual([goal.id]);
      expect(report.skipped[0]?.reason).toMatch(/^answered by the archive; unchanged since /);
    }
    expect(calls()).toBe(1);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 3 * DAY));
    await advanceResearchGoals();
    expect(calls()).toBe(1);
  });

  it('is asked again by a new event in the goal\'s project, and not by one elsewhere', async () => {
    await newGoal();
    await advanceResearchGoals();
    expect(calls()).toBe(1);

    const other = { project: await createProject({ name: 'Another operation', slug: 'another-operation' }) };
    await recordEvent({
      projectId: other.project.id,
      entityType: 'project',
      entityId: other.project.id,
      eventType: 'DOCUMENT_IMPORTED' as never,
    });
    await advanceResearchGoals();
    expect(calls()).toBe(1);

    await pause();
    await recordEvent({
      projectId: fixture.project.id,
      entityType: 'project',
      entityId: fixture.project.id,
      eventType: 'DOCUMENT_IMPORTED' as never,
    });
    await advanceResearchGoals();
    expect(calls()).toBe(2);
    await advanceResearchGoals();
    expect(calls()).toBe(2);
  });

  it('is asked again by a new shared finding, a revoked one, a contested claim and an expiry', async () => {
    await newGoal();
    await advanceResearchGoals();
    expect(calls()).toBe(1);

    await pause();
    const one = await sharedFinding('one');
    await advanceResearchGoals();
    expect(calls()).toBe(2);

    // Contesting the claim behind an active finding moves the marker.
    await pause();
    await markContradiction(one.claimId, 'CONTRADICTED' as never, 'another source disagrees');
    await advanceResearchGoals();
    expect(calls()).toBe(3);

    await pause();
    const two = await sharedFinding('two');
    await advanceResearchGoals();
    expect(calls()).toBe(4);

    await pause();
    await revokeFinding({ id: two.findingId, userId, reason: 'withdrawn' });
    await advanceResearchGoals();
    expect(calls()).toBe(5);

    // An expiry still ahead changes the marker when it is set, and again when
    // Brain's clock passes it; nothing else moves in between.
    await pause();
    const three = await sharedFinding('three');
    await advanceResearchGoals();
    expect(calls()).toBe(6);
    await pause();
    await setFindingHorizon({ id: three.findingId, validUntil: new Date(Date.now() + DAY).toISOString() });
    await advanceResearchGoals();
    expect(calls()).toBe(7);
    await advanceResearchGoals();
    expect(calls()).toBe(7);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 2 * DAY));
    await advanceResearchGoals();
    expect(calls()).toBe(8);
    await advanceResearchGoals();
    expect(calls()).toBe(8);
  });
});

describe('every active goal is reached, and the rotation survives a restart', () => {
  it('considers the newest goals within two passes when the oldest are answered', async () => {
    const answered: string[] = [];
    for (let index = 0; index < MAX_GOALS_PER_PASS; index += 1) {
      answered.push(
        (await newGoal(QUESTION, `2026-01-0${index + 1}T00:00:00.000Z`)).id,
      );
    }
    const late = [
      (await newGoal(OTHER, '2026-02-01T00:00:00.000Z')).id,
      (await newGoal(`${OTHER} again`, '2026-02-02T00:00:00.000Z')).id,
    ];
    const packets = async (id: string) =>
      (await getDb().all('SELECT id FROM research_orchestrations WHERE goal_id = ?', [id])).length;

    const first = await advanceResearchGoals();
    expect(first.considered).toBe(MAX_GOALS_PER_PASS);
    expect(first.answeredByArchive.sort()).toEqual([...answered].sort());
    for (const id of late) expect(await packets(id)).toBe(0);

    await pause();
    const second = await advanceResearchGoals();
    expect(second.started.map((one) => one.goalId).sort()).toEqual([...late].sort());
    for (const id of late) expect(await packets(id)).toBe(1);

    // A restart is a fresh pass over the same persisted rows. Two of the
    // answered goals were not reached in the second pass; the stamps say which,
    // and the third pass takes them first rather than returning to the oldest.
    const stamp = async (id: string) =>
      (await getDb().get<{ at: string | null }>('SELECT research_considered_at AS at FROM russell_goals WHERE id = ?', [id]))?.at ?? '';
    const stamps = await Promise.all(answered.map(async (id) => ({ id, at: await stamp(id) })));
    stamps.sort((a, b) => a.at.localeCompare(b.at));
    const neglected = stamps.slice(0, 2).map((one) => one.id);
    for (const id of [...answered, ...late]) expect(await stamp(id)).not.toBe('');
    await pause();
    const third = await advanceResearchGoals();
    expect(third.considered).toBe(MAX_GOALS_PER_PASS);
    for (const id of neglected) expect(third.answeredByArchive).toContain(id);
  });
});

describe('one packet however the passes overlap', () => {
  it('two concurrent passes over one actionable goal create exactly one round-1 packet', async () => {
    const goal = await newGoal(OTHER);
    await Promise.all([advanceResearchGoals(), advanceResearchGoals()]);
    const rows = await getDb().all<{ goal_packet_key: string }>(
      'SELECT goal_packet_key FROM research_orchestrations WHERE goal_id = ?',
      [goal.id],
    );
    expect(rows.map((row) => row.goal_packet_key)).toEqual(['round-1']);
  });
});

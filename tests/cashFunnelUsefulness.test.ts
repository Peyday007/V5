/**
 * The FUNNEL and RESEARCH USEFULNESS readings (OPPORTUNITY-INTELLIGENCE §3.6,
 * §5 H; workstream E).
 *
 * Two properties are what make them honest rather than decorative:
 *
 *   * an unknown prints `unknown` and never 0 — a tier crossing nobody recorded,
 *     a stage nobody tagged, money nobody settled and a ratio over nothing are
 *     absences of rows, not findings;
 *   * the usefulness lessons are read off rows and change nothing: they are not
 *     stored, and no module that decides a gate, a bar, a depth, a repair or an
 *     order imports them. They are context a prompt may carry.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createUser } from '../server/repos/identity.ts';
import { createFragments, createOrchestration, insertClaims } from '../server/repos/research.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { recordCashEvent } from '../server/repos/cashMode.ts';
import { cashFunnel, formatFunnel, median, weekOf } from '../server/services/cash/funnel.ts';
import {
  formatUsefulness,
  researchUsefulness,
  USEFULNESS_MIN_SAMPLE,
} from '../server/services/research/intelligence/retrospective.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let projectId = '';
let layerId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await listLayers(projectId))[0]!.id;
  userId = (
    await createUser({
      email: `funnel-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'The owner',
      password: 'correct horse battery staple',
    })
  ).id;
  expect(
    (
      await activate({
        projectId,
        ownerUserId: userId,
        actorUserId: userId,
        objective: 'Maximize additional usable cash over the next few weeks.',
      })
    ).ok,
  ).toBe(true);
});

describe('the funnel', () => {
  it('prints unknown, never 0, for every figure no row establishes', async () => {
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'An opening found this week',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    expect(captured.ok).toBe(true);

    const reading = await cashFunnel({ projectId });
    const text = formatFunnel(reading).join('\n');

    expect(reading.medianDaysToQualified.days).toBeNull();
    expect(text).toMatch(/median days discovery→qualified unknown/);
    expect(reading.dives.perQualified).toBeNull();
    expect(text).toMatch(/dives-per-qualified=unknown/);
    expect(reading.dives.stageOneOnly).toBeNull();
    expect(text).toMatch(/stage-1-only=unknown/);
    expect(reading.archive.share).toBeNull();
    expect(text).toMatch(/share=unknown/);
    expect(reading.sessions.perSession).toBeNull();
    expect(text).toMatch(/per-session=unknown/);
    expect(reading.outcomes.commercialTests).toBeNull();
    expect(reading.outcomes.settledByCurrency).toBeNull();
    expect(text).toMatch(/commercial-tests=unknown settled=unknown/);
    for (const week of reading.weeks) expect(week.qualifiedCrossings).toBeNull();
    // Not one of the unknowable figures is ever printed as a zero.
    for (const key of ['dives-per-qualified', 'stage-1-only', 'share', 'per-session', 'commercial-tests', 'settled']) {
      expect(text, key).not.toMatch(new RegExp(`${key}=0(\\b|\\.)`));
    }
    // What is counted is counted: the opening appears in this week's cohort.
    const thisWeek = reading.weeks.find((one) => one.week === weekOf(new Date().toISOString()));
    expect(thisWeek?.discovered).toBe(1);
    expect(thisWeek?.cohortNow.SIGNAL).toBe(1);
  });

  it('counts stage-1-only dives once the dives carry a stage', async () => {
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'An opening screened and killed',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    if (!captured.ok) throw new Error(captured.reason);
    await recordCashEvent({
      projectId,
      opportunityId: captured.value.id,
      kind: 'CASH_VALIDATION_STARTED',
      actorRef: 'BRAIN',
      summary: 'Brain is screening this opening.',
      detail: { round: 1, stage: 'SCREEN' },
    });
    const reading = await cashFunnel({ projectId });
    expect(reading.dives.started).toBe(1);
    expect(reading.dives.stageOneOnly).toBe(1);
    expect(formatFunnel(reading).join('\n')).toMatch(/stage-1-only=1/);
  });

  it('takes a median without inventing one', () => {
    expect(median([])).toBeNull();
    expect(median([3])).toBe(3);
    expect(median([1, 9, 2, 4])).toBe(3);
  });
});

describe('research usefulness', () => {
  async function packet(envelope: string): Promise<string> {
    const run = await createRun({
      projectId,
      layerId,
      runType: 'FOUNDATION',
      status: 'PLANNED',
      provider: 'WORKER',
      prompt: 'a usefulness fixture',
    });
    const orchestration = await createOrchestration({
      projectId,
      layerId,
      runId: run.id,
      title: 'a usefulness fixture',
      assignment: 'questions with different yields',
      provider: 'WORKER',
      autoApprove: false,
    });
    await getDb().run('UPDATE research_orchestrations SET approval_envelope_id = ? WHERE id = ?', [
      envelope,
      orchestration.id,
    ]);
    return orchestration.id;
  }

  async function fragments(
    orchestrationId: string,
    lane: string,
    statuses: string[],
    question: (index: number) => string,
  ): Promise<string[]> {
    const created = await createFragments(
      statuses.map((status, index) => ({
        orchestrationId,
        projectId,
        layerId,
        fragmentIndex: index,
        fragmentKey: `${lane}-${index}`,
        question: question(index),
        requiredEvidence: [{ id: lane, description: lane, necessity: 'REQUIRED' }],
        acceptableSourceTypes: ['published'],
        excludedSourceTypes: [],
        completionCriteria: ['a quoted passage'],
        dependsOn: [],
        minIndependentSources: 1,
        evidenceLane: lane,
        status,
      })) as unknown as Parameters<typeof createFragments>[0],
    );
    return created.map((one) => one.id);
  }

  async function rowCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of [
      'research_retrospectives',
      'research_fragments',
      'research_claims',
      'cash_events',
      'cash_opportunities',
      'cash_card_facts',
    ]) {
      out[table] = Number((await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0);
    }
    return out;
  }

  it('reads per-approach yield and DOMAIN lessons from rows, and writes nothing', async () => {
    const validation = await packet('RUSSELL_CASH_VALIDATION_V1');
    const discovery = await packet('RUSSELL_CASH_DISCOVERY_V1');
    await fragments(validation, 'payer', ['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'BLOCKED'], (i) => `Who pays for job ${i}?`);
    const blocked = await fragments(
      discovery,
      'competition',
      ['ACCEPTED', 'BLOCKED', 'BLOCKED', 'BLOCKED', 'BLOCKED', 'CANCELLED'],
      () => 'Who else supplies this?',
    );

    // An earlier fragment had already answered "Who else supplies this?".
    const earlier = await fragments(await packet('RUSSELL_CASH_DISCOVERY_V1'), 'competition', ['ACCEPTED'], () => 'Who else supplies this?');
    await getDb().run(
      `UPDATE research_fragments SET created_at = ?, accepted_at = ? WHERE id = ?`,
      ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', earlier[0]],
    );

    // One surface could never read one host.
    for (const fragmentId of blocked) {
      await getDb().run(
        `INSERT INTO research_passes (id, orchestration_id, fragment_id, pass_key, ordinal, attempt, status,
           provider, prompt, prompt_sha256, started_at, executor_routine_id, executor_session_ref)
         VALUES (?, ?, ?, 'FRAGMENT', 1, 1, 'COMPLETE', 'WORKER', 'p', 'h', ?, 'rtn_blind', ?)`,
        [`pas_${fragmentId}`, discovery, fragmentId, new Date().toISOString(), `ses_${fragmentId}`],
      );
    }
    await insertClaims(
      blocked.map((fragmentId) => ({
        orchestrationId: discovery,
        fragmentId,
        passId: null,
        passKey: 'FRAGMENT',
        claim: 'A competitor exists.',
        sourceUrl: 'https://www.unreachable.example/list',
        sourceTitle: null,
        sourcePublisher: null,
        sourceDate: null,
        evidenceExcerpt: null,
        evidenceLocator: null,
        evidenceLane: 'competition',
        retrievalState: 'NOT_REACHABLE',
        retrievedAt: null,
        confidence: 0,
        validationState: 'NO_URL',
        validationDetail: null,
        sourced: false,
        contentHash: `hash-${fragmentId}`,
      })) as unknown as Parameters<typeof insertClaims>[0],
    );

    // Workstream D's stored block cause is read, not re-derived.
    await getDb().run(`UPDATE research_fragments SET block_cause = 'SOURCE_ACCESS' WHERE id = ?`, [blocked[1]]);

    const before = await rowCounts();
    const reading = await researchUsefulness({ projectId });
    expect(await rowCounts()).toEqual(before);

    const payer = reading.approaches.find((one) => one.dimension === 'LANE' && one.approach === 'payer')!;
    const competition = reading.approaches.find(
      (one) => one.dimension === 'LANE' && one.approach === 'competition',
    )!;
    expect(payer.fragments).toBe(6);
    expect(payer.fragmentsAccepted).toBe(5);
    expect(competition.fragmentsAccepted).toBe(1);
    expect(competition.abandoned).toBe(1);
    expect(competition.blockCauses).toEqual({ SOURCE_ACCESS: 1 });
    expect(competition.repeatedWork).toBe(6);
    expect(competition.failedRetrievals).toBe(6);
    expect(competition.sessions).toBe(6);
    expect(payer.sessions).toBeNull();
    // No outcome and no settlement exist in this project: unknown, not zero.
    expect(payer.commercialTests).toBeNull();
    expect(payer.settledMinor).toBeNull();
    const surface = reading.approaches.find((one) => one.dimension === 'SURFACE' && one.approach === 'rtn_blind');
    expect(surface?.fragments).toBe(6);

    const keys = reading.lessons.map((one) => one.lessonKey);
    expect(keys).toContain('acceptance-by-lane');
    expect(keys).toContain('unreadable-unreachable.example-from-rtn_blind');
    expect(keys).toContain('repeated-after-answered');
    for (const lesson of reading.lessons) {
      expect(lesson.abstraction).toBe('DOMAIN');
      expect(lesson.informational).toBe(true);
    }
    const printed = formatUsefulness(reading).join('\n');
    expect(printed).toMatch(/tests=unknown settled=unknown/);
    expect(printed).toMatch(/sessions=unknown/);
  });

  it('writes no lesson below the minimum sample', async () => {
    const orchestration = await packet('RUSSELL_CASH_VALIDATION_V1');
    await fragments(orchestration, 'payer', ['ACCEPTED'], () => 'One question.');
    await fragments(orchestration, 'competition', ['BLOCKED'], () => 'Another question.');
    expect(USEFULNESS_MIN_SAMPLE).toBeGreaterThan(1);
    expect((await researchUsefulness({ projectId })).lessons).toEqual([]);
  });

  it('is imported by nothing that decides a gate, a bar, a depth, a repair or an order', () => {
    const deciders = [
      'server/services/research/gate.ts',
      'server/services/research/standards.ts',
      'server/services/research/repair.ts',
      'server/services/research/quota.ts',
      'server/services/research/approvalEnvelope.ts',
      'server/services/research/packetRunner.ts',
      'server/services/research/intelligence/depth.ts',
      'server/services/research/intelligence/director.ts',
      'server/services/research/intelligence/sufficiency.ts',
      'server/services/cash/validation.ts',
      'server/services/cash/portfolio.ts',
      'server/services/cash/tier.ts',
      'server/services/cash/monetization/commission.ts',
      'server/services/dispatch/router.ts',
    ];
    for (const file of deciders) {
      const full = path.join(ROOT, file);
      if (!fs.existsSync(full)) continue;
      const source = fs.readFileSync(full, 'utf8');
      expect(source, file).not.toMatch(/from ['"][^'"]*retrospective\.ts['"]/);
      expect(source, file).not.toMatch(/researchUsefulness|usefulnessLessons|lessonsForPrompt/);
    }
    // And the reading itself stores nothing: no write statement in its half of the file.
    const retrospective = fs.readFileSync(
      path.join(ROOT, 'server/services/research/intelligence/retrospective.ts'),
      'utf8',
    );
    const usefulness = retrospective.slice(retrospective.indexOf('Research usefulness: which approaches yield'));
    expect(usefulness.length).toBeGreaterThan(1000);
    expect(usefulness).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(usefulness).not.toMatch(/recordLesson\(/);
  });
});

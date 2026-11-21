/**
 * CAPABILITY:GOAL_PLAN.CONSTRUCTION.ROUNDS_FILE (2026-11-17, attempt 1).
 *
 * Production read 0 of 15 settled constructed rounds (`goal-…-mx-…`) filing an
 * opening, recorded as "pattern claims with no payer" and "round abandoned".
 * A constructed round's gated demand_pattern claim is filed only when the claim
 * itself says buyers pay (`patternStatesBuying`), and the constructed question
 * never asked for that, so workers listed the dated examples and named no
 * payer: every pattern stayed evidence and the round settled found 0.
 *
 * Each case drives the real path: `constructArrangements` composes the
 * question, `openConstructedRound` opens the round with it, a real mission and
 * packet answer it, and `harvest` files, settles and counts. The question
 * assertions fail on 246aa613; the harvest cases pin that the payer-stating
 * answer the question now asks for is filed and counted — also on a round that
 * closed ABANDONED first — and that a payer-less pattern still files nothing.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  insertClaims,
  patternStatesBuying,
  PATTERN_LANE,
  updateFragment,
} from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { listOpportunities } from '../server/repos/cashPortfolio.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { forgetGoalReadings } from '../server/services/goals/plan.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { constructArrangements, OPENING_SENTENCE, PATTERN_PAYER_SENTENCE } from '../server/services/cash/construct.ts';
import { harvest, openConstructedRound } from '../server/services/cash/discovery.ts';
import type { Layer } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let layer: Layer;
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

/** What the constructed question now asks of a repeating-buyer pattern. */
const ASKS_FOR_PAYER = /must itself say who pays, what they pay for and what they pay/;

beforeEach(async () => {
  forgetKnowledge();
  forgetGoalReadings();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  userId = (await createUser({ email: `crf-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
});

async function goal() {
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(25), ownerUserId: userId }, `person:${userId}`);
  expect(
    (await setTarget({
      goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId,
      capitalCeilingCents: 300_000, capitalBeforeProofCents: 37_500, hoursCeiling: 200, now: new Date(now.getTime() - 60_000),
    } as Parameters<typeof setTarget>[0])).ok,
  ).toBe(true);
  return (await getWorkstream(g.id))!;
}

/** The question construction composes for this project now — never a hand-written one. */
async function constructedQuestion(): Promise<{ key: string; label: string; question: string }> {
  const limits = { daysLeft: 25, remainingCents: 1_000_000, capitalCeilingCents: 300_000, capitalBeforeProofCents: 37_500, bestReachCents: 0 };
  const built = await constructArrangements({ projectId, currency: 'USD', delivers: ['spreadsheets'], capitalCeilingCents: 300_000, daysLeft: 25, limits, now });
  expect(built.length).toBeGreaterThan(0);
  const one = built[0]!;
  return { key: one.key, label: one.label, question: one.question };
}

/** A packet behind a constructed round's idea, its mission running. */
async function packet(candidateId: string) {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'constructed' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'constructed', assignment: 'constructed', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: 'any market',
      requiredEvidence: [{ id: PATTERN_LANE, description: 'buyers repeatedly paying', necessity: 'CONDITIONAL' }],
      acceptableSourceTypes: ['a price page'], excludedSourceTypes: ['a forecast'], completionCriteria: ['two dated examples'],
      minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'market-signal', question: 'q', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  const { mission } = await launchMission({
    projectId, layerId: layer.id, visibility: 'SHARED', objective: 'constructed', whyNow: 'the goal is live',
    idempotencyKey: `mission:${orchestration.id}`, candidateId,
  } as Parameters<typeof launchMission>[0]);
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  const gate = async (text: string) => {
    await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString() });
    const [claim] = await insertClaims([{
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
      claim: text, sourceUrl: `https://example.test/${encodeURIComponent(text.slice(0, 24))}`, sourceTitle: 'A case study', sourcePublisher: 'A publisher',
      sourceDate: inDays(-3).slice(0, 10), evidenceExcerpt: text, evidenceLocator: 'the page', evidenceLane: PATTERN_LANE, opportunitySignal: null,
      closesOn: null, retrievedAt: inDays(-1).slice(0, 10), confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
      claimType: 'SOURCED_FACT' as const, contentHash: `${candidateId}|${text}`,
    }]);
    await decideClaim(claim!.id, { accepted: true });
  };
  const end = async (to: 'DONE' | 'NEEDS_HUMAN', from: 'RUNNING' | 'NEEDS_HUMAN' = 'RUNNING') =>
    transitionMission({ missionId: mission.id, from, to, terminalReason: to === 'DONE' ? null : 'parked', waitingOn: to === 'NEEDS_HUMAN' ? 'a person' : null });
  return { gate, end };
}

async function openRound() {
  const w = await goal();
  const asked = await constructedQuestion();
  const round = await openConstructedRound({ goal: w, projectId, key: asked.key, title: `Constructed: ${asked.label}`, question: asked.question });
  expect(round).not.toBeNull();
  expect(round!.bucketId).toContain('-mx-');
  return { round: round!, question: asked.question };
}

const settled = async (bucketId: string) => (await listRounds(projectId)).filter((one) => one.bucketId === bucketId).map((one) => [one.state, one.found]);

/** The production class: two dated examples, and no buyer said to pay. */
const PAYERLESS = 'Two regional HVAC groups posted AI receptionist setup projects in March 2026 and May 2026.';
/** What the question now asks for: who pays, for what, and what. */
const WITH_PAYER = 'Regional HVAC groups repeatedly pay agencies USD 1,500 to set up an AI receptionist (examples March 2026 and May 2026).';

describe('a constructed round asks a repeating-buyer pattern to say who pays (CONSTRUCTION.ROUNDS_FILE)', () => {
  it("asks for the payer in every constructed question, and the round's own statement carries it", async () => {
    expect(OPENING_SENTENCE).toMatch(ASKS_FOR_PAYER);
    // The example the question gives is itself a claim the harvest would read as buyers paying.
    const example = /\(for example "([^"]+)"\)/.exec(PATTERN_PAYER_SENTENCE)?.[1] ?? '';
    expect(patternStatesBuying(example)).toBe(true);
    const { round, question } = await openRound();
    expect(question).toMatch(ASKS_FOR_PAYER);
    const candidate = await getCandidate(round.candidateId);
    expect(candidate?.statement ?? '').toMatch(ASKS_FOR_PAYER);
  });

  it('fabricates nothing: a pattern that names no payer still files nothing, and the round settles found 0', async () => {
    expect(patternStatesBuying(PAYERLESS)).toBe(false);
    const { round } = await openRound();
    const p = await packet(round.candidateId);
    await p.gate(PAYERLESS);
    await p.end('DONE');
    await harvest({ projectId });
    expect(await settled(round.bucketId)).toEqual([['HARVESTED', 0]]);
    expect(await listOpportunities({ projectId })).toHaveLength(0);
  });

  it('files the payer-stating pattern the question asks for and counts it on the round', async () => {
    const { round } = await openRound();
    const p = await packet(round.candidateId);
    await p.gate(WITH_PAYER);
    await p.end('DONE');
    await harvest({ projectId });
    expect(await settled(round.bucketId)).toEqual([['HARVESTED', 1]]);
    const filed = (await listOpportunities({ projectId })).filter((one) => one.discoveryRoundId !== null);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.opportunitySignal).toBe('RECURRING_OUTSOURCED_WORK');
  });

  it('counts it on a constructed round that closed ABANDONED at a park before the claim was gated', async () => {
    const { round } = await openRound();
    const p = await packet(round.candidateId);
    await p.end('NEEDS_HUMAN');
    await harvest({ projectId });
    expect(await settled(round.bucketId)).toEqual([['ABANDONED', 0]]);
    await p.gate(WITH_PAYER);
    await p.end('DONE', 'NEEDS_HUMAN');
    await harvest({ projectId });
    expect(await settled(round.bucketId)).toEqual([['ABANDONED', 1]]);
  });
});

describe('each question sentence keeps its own documentation (R1-F1)', () => {
  /** The doc comment immediately above `export const NAME`, or null when none is directly attached. */
  const docOf = (source: string, name: string): string | null => {
    const at = source.indexOf(`export const ${name} =`);
    const before = source.slice(0, at).trimEnd();
    if (at < 0 || !before.endsWith('*/')) return null;
    return before.slice(before.lastIndexOf('/**'));
  };
  it('OPENING_SENTENCE and PATTERN_PAYER_SENTENCE are each documented by their own comment, and no comment is left detached', () => {
    const source = readFileSync(new URL('../server/services/cash/construct.ts', import.meta.url), 'utf8');
    expect(docOf(source, 'OPENING_SENTENCE')).toMatch(/How a constructed round's answer becomes an opening/);
    expect(docOf(source, 'PATTERN_PAYER_SENTENCE')).toMatch(/A repeating-buyer pattern says who pays/);
    // Neither comment has another doc block stacked directly above it, which would document nothing.
    for (const name of ['OPENING_SENTENCE', 'PATTERN_PAYER_SENTENCE']) {
      const doc = docOf(source, name)!;
      expect(source.slice(0, source.indexOf(doc)).trimEnd().endsWith('*/')).toBe(false);
    }
  });
});

/**
 * ORIGINATED:UNMET_NEED:access-for-v — a signal is not asked for a channel to a
 * party its own fact says does not exist, and a channel its source states is
 * read rather than researched again.
 *
 * Production held five open "Access for …" needs, grouped by the self-model as
 * one missing resource. Three (a TCGPlayer and a StubHub resale quote, a
 * broker's registration fee) are the classes `payerQuestionUnanswerable`
 * already rules out: nobody in them would pay Brain, so there is nobody to
 * establish a channel to. The GitHub bounty's own accepted claim names its
 * channel ("run through HackerOne (hackerone.com/github)"). The Safe Music
 * contract opening names a buyer and keeps its question.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { getDb } from '../server/db/database.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { cardFact } from '../server/repos/cashCardFacts.ts';
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { raiseNeed } from '../server/services/cash/needs.ts';
import { questionKey } from '../server/services/cash/conditions.ts';
import { parseBlockerKey } from '../server/domain/types.ts';
import {
  reconcileDiscoverableGaps,
  signalQuestionsUnanswerable,
  startNeedWork,
  statedChannel,
} from '../server/services/cash/operate.ts';
import { QUESTION_SKIPPED_EVENT } from '../server/services/cash/screenMetrics.ts';

const TCG =
  'As of the most recent tracked sale on September 17, 2026 (via TCGPlayer), the Prismatic Evolutions Elite Trainer Box traded at $145 (current market)';
const COPART =
  "Preferred Auto Brokers (PAB), whose registration terms are published on Copart's own site, charges buyers who register through it a $195.00 annual registration fee";
const STUBHUB =
  'As of April 9, 2026 at 4pm PT, StubHub listed Coachella 2026 Weekend 1 resale tickets at $2,905 for general admission and $5,061 for VIP — a specific listing';
const SAFE_MUSIC =
  'Market: general animation/VFX production industry (not anime-specific). Safe Music Inc published a paid, open contract opening for a Storyboard Artist';
const GITHUB =
  "GitHub is the payer; its bug bounty is run through HackerOne (hackerone.com/github). The program's own site says 'If you have found a vulnerability, submit it'";

let projectId = '';
let userId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (
    await createUser({
      email: `access-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
  expect(
    (await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' })).ok,
  ).toBe(true);
});

async function signal(title: string) {
  const captured = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
  });
  if (!captured.ok) throw new Error(captured.reason);
  return captured.value;
}

async function openAccessNeed(opportunityId: string, title: string) {
  const key = questionKey(opportunityId, 'access');
  const raised = await raiseNeed({
    projectId,
    opportunityId,
    actorRef: 'BRAIN',
    blockedAction: `Access for "${title}"`,
    whyItMatters: 'Raised before the change.',
    recommendedPath: 'Establish a channel that actually reaches them. This is an access task, not a price.',
    setupEffort: 'One bounded look.',
    nextStep: 'Establish a channel that actually reaches them. This is an access task, not a price.',
    completionCondition: 'The access is recorded on this card.',
    blocksState: 'EXECUTING',
    requestKey: key,
    blockerKey: parseBlockerKey('FIELD:access'),
  });
  if (!raised.ok) throw new Error('raise failed');
  return { key, need: raised.value };
}

/** Give an opening the research claim it was harvested from, as discovery does. */
async function harvestedFrom(opportunityId: string, text: string, opts: { accepted?: boolean; sourceUrl?: string | null } = {}) {
  const layer = await getDb().all<{ id: string }>('SELECT id FROM layers WHERE project_id = ? LIMIT 1', [projectId]);
  const run = await createRun({ projectId, layerId: layer[0]!.id, runType: 'FOUNDATION', provider: 'WORKER' });
  const orchestration = await createOrchestration({ projectId, layerId: layer[0]!.id, runId: run.id, title: 'access fixture', assignment: 'access', provider: 'WORKER' });
  const claimId = `clm_access_${Math.random().toString(36).slice(2, 10)}`;
  await getDb().run(
    `INSERT INTO research_claims
       (id, orchestration_id, fragment_id, pass_id, pass_key, claim, source_url, source_title,
        source_publisher, source_date, evidence_excerpt, evidence_locator, evidence_lane,
        retrieved_at, confidence, contradiction_state, contradiction_note, validation_state,
        validation_detail, sourced, derived, derived_from, accepted, content_hash, created_at)
     VALUES (?, ?, NULL, NULL, 'RESEARCH', ?, ?, NULL, NULL, NULL, NULL, NULL, 'lane-1',
             ?, 0.9, 'UNCHALLENGED', NULL, 'VALID', NULL, 1, 0, '[]', ?, ?, ?)`,
    [
      claimId,
      orchestration.id,
      text,
      opts.sourceUrl === undefined ? 'https://bounty.github.com/' : opts.sourceUrl,
      '2026-11-01T00:00:00.000Z',
      opts.accepted === false ? 0 : 1,
      `hash-${claimId}`,
      '2026-11-01T00:00:00.000Z',
    ] as never[],
  );
  await getDb().run('UPDATE cash_opportunities SET source_claim_id = ? WHERE id = ?', [claimId, opportunityId] as never[]);
  return claimId;
}

describe('the recorded failure class: access asked of a signal with nobody to reach', () => {
  it('raises no access need on the resale quotes and the registration fee, and records the skip with why', async () => {
    const ids = [(await signal(TCG)).id, (await signal(STUBHUB)).id, (await signal(COPART)).id];
    const gaps = await reconcileDiscoverableGaps(projectId);
    for (const id of ids) {
      expect(gaps.filter((one) => one.opportunityId === id && one.field === 'access')).toEqual([]);
      expect((await listNeeds({ projectId, states: ['OPEN'] })).some((one) => one.requestKey === questionKey(id, 'access'))).toBe(false);
    }
    const skipped = await cashEventsOfKindInProject(projectId, QUESTION_SKIPPED_EVENT);
    for (const id of ids) {
      const access = skipped.filter((event) => event.opportunityId === id && (event.detail as { field: string }).field === 'access');
      expect(access).toHaveLength(1);
      expect((access[0]!.detail as { why: string }).why).toMatch(/names no party that would pay Brain/);
    }
  });

  it('withdraws an access need already open on one, resolves nothing, and refuses to launch it', async () => {
    const tcg = await signal(TCG);
    const { key, need } = await openAccessNeed(tcg.id, tcg.title);

    const refused = await startNeedWork(need, 'RESEARCH');
    expect(refused.kind).toBe('REFUSED');

    await reconcileDiscoverableGaps(projectId);
    const withdrawn = await listNeeds({ projectId, states: ['WITHDRAWN'] });
    expect(withdrawn.map((one) => one.requestKey)).toEqual([key]);
    expect(withdrawn[0]!.resolution).toContain('Nothing was established');
    expect(await listNeeds({ projectId, states: ['RESOLVED'] })).toEqual([]);
  });
});

describe('openings that name a payer or a buyer keep their access question', () => {
  it('still asks the Safe Music contract opening and the bounty (without a source claim) for access', async () => {
    const safe = await signal(SAFE_MUSIC);
    const github = await signal(GITHUB);
    expect(signalQuestionsUnanswerable({ title: SAFE_MUSIC, payer: null })).toBeNull();
    const gaps = await reconcileDiscoverableGaps(projectId);
    expect(gaps.filter((one) => one.field === 'access').map((one) => one.opportunityId).sort()).toEqual([safe.id, github.id].sort());
    const skipped = await cashEventsOfKindInProject(projectId, QUESTION_SKIPPED_EVENT);
    expect(skipped.filter((event) => event.opportunityId === safe.id)).toEqual([]);
  });
});

describe('statedChannel', () => {
  it('reads only a channel the sentence names with its address', () => {
    expect(statedChannel(GITHUB)).toBe('HackerOne (hackerone.com/github)');
    expect(statedChannel('Reports are submitted via Bugcrowd (bugcrowd.com/acme).')).toBe('Bugcrowd (bugcrowd.com/acme)');
    expect(statedChannel('Vulnerabilities are reported through Intigriti at app.intigriti.com/programs/acme.')).toBe(
      'Intigriti (app.intigriti.com/programs/acme)',
    );
    expect(statedChannel('The bounty is run through HackerOne.')).toBeNull();
    // Review round 1 (F1): a lowercase phrase or a date is not a party to reach.
    expect(statedChannel('The spring promotion is run through December (example.com/promo).')).toBeNull();
    expect(statedChannel('orders are submitted via the web form at example.com/form.')).toBeNull();
    expect(statedChannel('Tickets are reported through some random forum at reddit.com/r/x.')).toBeNull();
    expect(statedChannel('Entries are submitted via The Form (example.com/form).')).toBeNull();
    expect(statedChannel('Submitted through HackerOne (HackerOne.com/acme).')).toBe('HackerOne (HackerOne.com/acme)');
    for (const title of [TCG, COPART, STUBHUB, SAFE_MUSIC]) expect(statedChannel(title)).toBeNull();
  });
});

describe('a channel the source states', () => {
  it('is written onto the card from the accepted sourced claim, and no access need is raised', async () => {
    const github = await signal(GITHUB);
    const claimId = await harvestedFrom(github.id, GITHUB);
    const gaps = await reconcileDiscoverableGaps(projectId);
    expect(gaps.filter((one) => one.opportunityId === github.id && one.field === 'access')).toEqual([]);
    expect((await getOpportunity(github.id))!.reachableChannel).toBe('HackerOne (hackerone.com/github)');
    expect(await cardFact(github.id, 'access')).toMatchObject({ kind: 'EVIDENCE', value: 'HackerOne (hackerone.com/github)', claimId });
  });

  it('settles an access need already open on it as RESOLVED', async () => {
    const github = await signal(GITHUB);
    const { key } = await openAccessNeed(github.id, github.title);
    await harvestedFrom(github.id, GITHUB);
    await reconcileDiscoverableGaps(projectId);
    expect((await listNeeds({ projectId, states: ['RESOLVED'] })).map((one) => one.requestKey)).toContain(key);
  });

  it('writes nothing from an unaccepted claim', async () => {
    const github = await signal(GITHUB);
    await harvestedFrom(github.id, GITHUB, { accepted: false });
    const gaps = await reconcileDiscoverableGaps(projectId);
    expect((await getOpportunity(github.id))!.reachableChannel).toBeNull();
    expect(gaps.filter((one) => one.opportunityId === github.id).map((one) => one.field)).toContain('access');
  });

  it('writes nothing from an unsourced claim', async () => {
    const github = await signal(GITHUB);
    await harvestedFrom(github.id, GITHUB, { sourceUrl: null });
    await reconcileDiscoverableGaps(projectId);
    expect((await getOpportunity(github.id))!.reachableChannel).toBeNull();
  });
});

/**
 * ORIGINATED:UNMET_NEED:payer-for-v — a signal is not asked for a payer its own
 * fact rules out.
 *
 * Production held five open "Payer for …" needs, grouped by the self-model as
 * one missing resource. Four were unanswerable: a stock-image subscription
 * price and a broker's registration fee are what a supplier charges its own
 * customers, and a TCGPlayer or StubHub quote is a resale market's price.
 * None names anybody who would approve paying Brain. The fifth — a bug bounty
 * whose source names GitHub as the payer — is a real question and is still
 * asked.
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
import { payerQuestionUnanswerable, reconcileDiscoverableGaps, statedPayer } from '../server/services/cash/operate.ts';
import { QUESTION_SKIPPED_EVENT } from '../server/services/cash/screenMetrics.ts';

const ADOBE =
  'Adobe Stock publishes a standard-license image subscription price of $29.99/month for 10 Stock credits (images, vectors, music, templates use one credit each)';
const TCG =
  'As of the most recent tracked sale on September 17, 2026 (via TCGPlayer), the Prismatic Evolutions Elite Trainer Box traded at $145 (current market)';
const COPART =
  "Preferred Auto Brokers (PAB), whose registration terms are published on Copart's own site, charges buyers who register through it a $195.00 annual registration fee";
const STUBHUB =
  'As of April 9, 2026 at 4pm PT, StubHub listed Coachella 2026 Weekend 1 resale tickets at $2,905 for general admission and $5,061 for VIP — a specific listing';
// Review round 1 (F1): buyer-side spend facts that merely carry a billing cadence.
const BUYER_SPEND_FACTS = [
  'Acme Dental pays $4,000 per month to an outside agency for appointment-reminder calls',
  'Shopify merchants spend $500/month on product photography retouching',
  'The City of Austin budgets $12,000 per month for translation services',
  'Regional law firms outsource document review at $3,000/mo per matter',
];
const GITHUB =
  "GitHub is the payer; its bug bounty is run through HackerOne (hackerone.com/github). The program's own site says 'If you have found a vulnerability, submit it'";

let projectId = '';
let userId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (
    await createUser({
      email: `payer-${Math.random().toString(36).slice(2, 10)}@example.test`,
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

describe('payerQuestionUnanswerable', () => {
  it('rules out the four recorded supplier-price and resale-quote facts, and keeps a named payer', () => {
    for (const title of [ADOBE, TCG, COPART, STUBHUB]) {
      expect(payerQuestionUnanswerable({ title, payer: null })).not.toBeNull();
    }
    expect(payerQuestionUnanswerable({ title: GITHUB, payer: null })).toBeNull();
    expect(payerQuestionUnanswerable({ title: 'A bare opening', payer: null })).toBeNull();
    expect(payerQuestionUnanswerable({ title: ADOBE, payer: 'Somebody' })).toBeNull();
  });

  it('keeps the payer question on a buyer-side spend fact, however it is billed', () => {
    for (const title of BUYER_SPEND_FACTS) {
      expect(payerQuestionUnanswerable({ title, payer: null }), title).toBeNull();
    }
  });
});

describe('the signal gap pass', () => {
  it('asks the GitHub bounty its payer and does not ask the supplier and resale facts', async () => {
    const ids = {
      adobe: (await signal(ADOBE)).id,
      tcg: (await signal(TCG)).id,
      copart: (await signal(COPART)).id,
      stubhub: (await signal(STUBHUB)).id,
      github: (await signal(GITHUB)).id,
    };
    const gaps = await reconcileDiscoverableGaps(projectId);
    const payerAsked = gaps.filter((one) => one.field === 'payer').map((one) => one.opportunityId);
    expect(payerAsked).toEqual([ids.github]);

    // The other capture questions are still asked of every one of them.
    for (const id of Object.values(ids)) {
      expect(gaps.filter((one) => one.opportunityId === id).map((one) => one.field)).toEqual(
        expect.arrayContaining(['access', 'buyingEvidence']),
      );
    }

    // Each payer question not asked is recorded once, with why.
    const skipped = await cashEventsOfKindInProject(projectId, QUESTION_SKIPPED_EVENT);
    for (const id of [ids.adobe, ids.tcg, ids.copart, ids.stubhub]) {
      const mine = skipped.filter((event) => event.opportunityId === id);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.summary).toContain('No payer to look up');
    }
    expect(skipped.filter((event) => event.opportunityId === ids.github)).toEqual([]);

    await reconcileDiscoverableGaps(projectId);
    expect(await cashEventsOfKindInProject(projectId, QUESTION_SKIPPED_EVENT)).toHaveLength(4);
  });

  it('withdraws a payer question already open on a supplier-price signal, and resolves nothing', async () => {
    const adobe = await signal(ADOBE);
    const key = questionKey(adobe.id, 'payer');
    const raised = await raiseNeed({
      projectId,
      opportunityId: adobe.id,
      actorRef: 'BRAIN',
      blockedAction: `Payer for "${adobe.title}"`,
      whyItMatters: 'Raised before the change.',
      recommendedPath: 'Name the person or role who can approve payment.',
      setupEffort: 'One bounded look.',
      nextStep: 'Name the person or role who can approve payment.',
      completionCondition: 'The payer is recorded on this card.',
      blocksState: 'EXECUTING',
      requestKey: key,
      blockerKey: parseBlockerKey('FIELD:payer'),
    });
    expect(raised.ok).toBe(true);

    const gaps = await reconcileDiscoverableGaps(projectId);
    expect(gaps.filter((one) => one.field === 'payer')).toEqual([]);

    const withdrawn = await listNeeds({ projectId, states: ['WITHDRAWN'] });
    expect(withdrawn.map((one) => one.requestKey)).toEqual([key]);
    expect(withdrawn[0]!.resolution).toContain('Nothing was established');
    expect(await listNeeds({ projectId, states: ['RESOLVED'] })).toEqual([]);
    expect((await listNeeds({ projectId, states: ['OPEN'] })).some((one) => one.requestKey === key)).toBe(false);
  });

  it('asks a buyer-spend signal its payer and leaves its open payer question open', async () => {
    const spend = await signal(BUYER_SPEND_FACTS[0]!);
    const key = questionKey(spend.id, 'payer');
    const fresh = await reconcileDiscoverableGaps(projectId);
    expect(fresh.filter((one) => one.field === 'payer').map((one) => one.opportunityId)).toEqual([spend.id]);

    await reconcileDiscoverableGaps(projectId);
    expect((await listNeeds({ projectId, states: ['OPEN'] })).some((one) => one.requestKey === key)).toBe(true);
    expect(await listNeeds({ projectId, states: ['WITHDRAWN'] })).toEqual([]);
    const skipped = await cashEventsOfKindInProject(projectId, QUESTION_SKIPPED_EVENT);
    expect(skipped.filter((event) => event.opportunityId === spend.id)).toEqual([]);
  });
});

/** Give an opening the accepted research claim it was harvested from, as discovery does. */
async function harvestedFrom(opportunityId: string, text: string): Promise<string> {
  const layer = await getDb().all<{ id: string }>('SELECT id FROM layers WHERE project_id = ? LIMIT 1', [projectId]);
  const run = await createRun({ projectId, layerId: layer[0]!.id, runType: 'FOUNDATION', provider: 'WORKER' });
  const orchestration = await createOrchestration({ projectId, layerId: layer[0]!.id, runId: run.id, title: 'payer fixture', assignment: 'payer', provider: 'WORKER' });
  const claimId = `clm_payer_${Math.random().toString(36).slice(2, 10)}`;
  await getDb().run(
    `INSERT INTO research_claims
       (id, orchestration_id, fragment_id, pass_id, pass_key, claim, source_url, source_title,
        source_publisher, source_date, evidence_excerpt, evidence_locator, evidence_lane,
        retrieved_at, confidence, contradiction_state, contradiction_note, validation_state,
        validation_detail, sourced, derived, derived_from, accepted, content_hash, created_at)
     VALUES (?, ?, NULL, NULL, 'RESEARCH', ?, ?, NULL, NULL, NULL, NULL, NULL, 'lane-1',
             ?, 0.9, 'UNCHALLENGED', NULL, 'VALID', NULL, 1, 0, '[]', 1, ?, ?)`,
    [claimId, orchestration.id, text, 'https://hackerone.com/github', '2026-11-01T00:00:00.000Z', `hash-${claimId}`, '2026-11-01T00:00:00.000Z'] as never[],
  );
  await getDb().run('UPDATE cash_opportunities SET source_claim_id = ? WHERE id = ?', [claimId, opportunityId] as never[]);
  return claimId;
}

describe('statedPayer', () => {
  it('reads only a payer the sentence names outright', () => {
    expect(statedPayer(GITHUB)).toBe('GitHub');
    expect(statedPayer('Bounties are triaged weekly. The payer is Shopify Inc.')).toBe('Shopify Inc');
    expect(statedPayer('Who is the payer is not stated on the page.')).toBeNull();
    for (const title of [ADOBE, TCG, COPART, STUBHUB, ...BUYER_SPEND_FACTS]) expect(statedPayer(title)).toBeNull();
  });
});

describe('a payer the source states', () => {
  it('is written onto the card from the accepted claim, and no payer question is raised', async () => {
    const github = await signal(GITHUB);
    const claimId = await harvestedFrom(github.id, GITHUB);

    const gaps = await reconcileDiscoverableGaps(projectId);
    expect(gaps.filter((one) => one.opportunityId === github.id && one.field === 'payer')).toEqual([]);
    expect((await getOpportunity(github.id))!.payer).toBe('GitHub');
    expect(await cardFact(github.id, 'payer')).toMatchObject({ kind: 'EVIDENCE', value: 'GitHub', claimId });
    expect((await listNeeds({ projectId, states: ['OPEN'] })).some((one) => one.requestKey === questionKey(github.id, 'payer'))).toBe(false);
  });

  it('settles a payer question already open on it as RESOLVED, because the payer was established', async () => {
    const github = await signal(GITHUB);
    const key = questionKey(github.id, 'payer');
    expect(
      (
        await raiseNeed({
          projectId,
          opportunityId: github.id,
          actorRef: 'BRAIN',
          blockedAction: `Payer for "${github.title}"`,
          whyItMatters: 'Raised before the change.',
          recommendedPath: 'Name the person or role who can approve payment.',
          setupEffort: 'One bounded look.',
          nextStep: 'Name the person or role who can approve payment.',
          completionCondition: 'The payer is recorded on this card.',
          blocksState: 'EXECUTING',
          requestKey: key,
          blockerKey: parseBlockerKey('FIELD:payer'),
        })
      ).ok,
    ).toBe(true);
    await harvestedFrom(github.id, GITHUB);

    await reconcileDiscoverableGaps(projectId);
    expect((await listNeeds({ projectId, states: ['RESOLVED'] })).map((one) => one.requestKey)).toEqual([key]);
    expect(await listNeeds({ projectId, states: ['WITHDRAWN'] })).toEqual([]);
  });

  it('is never read from an opening with no accepted source claim', async () => {
    const github = await signal(GITHUB);
    await reconcileDiscoverableGaps(projectId);
    expect((await getOpportunity(github.id))!.payer).toBeNull();
  });
});

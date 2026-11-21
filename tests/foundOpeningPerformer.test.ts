/**
 * A found opening asking for a deliverable Brain has proved carries Brain as
 * its performer — 0 owner hours — exactly as a constructed design over the
 * same proved deliverable does (`ownerHoursOf`), and an opening no proved
 * deliverable matches keeps the conservative 1–40 owner-hour sweep.
 *
 * Production 2026-11-21 (plan read 44860552332, goal wst_7b4fcbb5f2384f31b6c3,
 * "Collect $10K within 30 days", hours 0): cop_c46683c4a7ba4d6b80ad's pathway
 * read "fulfilled by Brain produces it: website", yet the model swept its
 * owner hours 1–40 a deal, so the quant portfolio and every gate strategy
 * refused it as "no performer is established"; 10 of 13 found openings failed
 * "REPEATED_GAP: nobody named to fulfil it".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { readGoalPlan } from '../server/services/goals/plan.ts';
import { foundOwnerHours, modelOpportunity } from '../server/services/cash/goalScenario.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

const card = (over: Partial<CashOpportunity>): Pick<CashOpportunity, 'id' | 'offerScope' | 'title' | 'payer' | 'fulfillmentOwner' | 'humanHours'> => ({
  id: 'cop_x',
  offerScope: null,
  title: 'An opening',
  payer: null,
  fulfillmentOwner: null,
  humanHours: null,
  ...over,
});

describe('foundOwnerHours reads the evidence provedDeliverable reads', () => {
  const delivers = ['website', 'business document'];

  it('gives 0 owner hours when the opening asks for a deliverable Brain has proved', () => {
    const hours = foundOwnerHours(card({ offerScope: 'Build one landing page for the clinic' }), delivers);
    expect(hours?.value).toBe(0);
    expect(hours?.provenance).toBe('ASSUMPTION');
    expect(hours?.note).toMatch(/Brain performs the work \(website for "Build one landing page/);
  });

  it('establishes nothing without a proved match, without a proof, with a named fulfiller, or with hours on the card', () => {
    expect(foundOwnerHours(card({ offerScope: 'Answer one request' }), delivers)).toBeNull();
    expect(foundOwnerHours(card({ offerScope: 'Build one landing page' }), [])).toBeNull();
    expect(foundOwnerHours(card({ offerScope: 'Build one landing page' }), ['business document'])).toBeNull();
    expect(foundOwnerHours(card({ offerScope: 'Build one landing page', fulfillmentOwner: 'A named agency' }), delivers)).toBeNull();
    expect(foundOwnerHours(card({ offerScope: 'Build one landing page', humanHours: 3 }), delivers)).toBeNull();
    // Transcription and video are never Brain's, whatever else the text names.
    expect(foundOwnerHours(card({ offerScope: 'Transcribe the video for the website' }), delivers)).toBeNull();
  });
});

describe('the production journey: a found opening Brain can make, against 0 owner hours', () => {
  let projectId = '';
  let userId = '';
  let cashModeId = '';
  const now = new Date();
  const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `fp-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    cashModeId = (await getCashMode(projectId))!.id;
  });

  async function opening(title: string, offer: string): Promise<CashOpportunity> {
    const o = await createOpportunity({
      projectId,
      cashModeId,
      ownerUserId: userId,
      title,
      mechanism: 'SUPPLY_DEMAND_MISMATCH',
      currency: 'USD',
      sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`,
      opportunitySignal: 'PAID_TASK_OR_CONTRACT',
      source: 'A publisher',
      requiredCapabilities: [],
    });
    const fact = (field: string, value: string) => recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
    await fact(CAPTURE_KEY, `${offer} for a fee.`);
    await fact('payer', 'The district');
    await updateOpportunity(o.id, {
      payer: 'The district',
      price_cents: 1_500,
      offer_scope: offer,
      reachable_channel: 'The posted contact',
      buying_signal: 'Posted this week',
      signal_observed_at: inDays(-2),
      peak_funding_cents: 1_498,
      human_hours: null,
      fulfillment_owner: null,
    });
    await fact('price', '$15');
    await fact('timeToFirstCash', '3 days');
    await fact('directCosts', '$3');
    await fact('exposure', '$14.98');
    return (await getOpportunity(o.id))!;
  }

  it('reads Brain as the performer of the opening it can make, and keeps refusing the one nobody performs', async () => {
    const made = await opening('Landing page request', 'Build one landing page');
    const nobody = await opening('Brokerage request for information', 'Answer one request');

    const g = await createWorkstream({ projectId, title: 'Collect $10K within 30 days', intent: 'Collect settled cash within the window.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: inDays(18), ownerUserId: userId }, `person:${userId}`);
    const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId, capitalCeilingCents: 300_000, hoursCeiling: 0, now: new Date(now.getTime() - 60_000) });
    expect(set.ok).toBe(true);

    const reading = (await readGoalPlan({ goalId: g.id, evaluations: 2_000 }))!;
    const demandOf = (id: string) => reading.portfolio?.demand.find((one) => one.opportunityId === id);
    // The pathway already named Brain; the hours the portfolio and the gate read now agree with it.
    const pathway = reading.pathways?.pathways.find((one) => one.opportunityId === made.id);
    expect(pathway?.fulfiller.value).toMatch(/^Brain produces it: website/);
    expect(demandOf(made.id)?.refused ?? null).toBeNull();
    const madeStrategy = reading.strategies.find((one) => one.opportunityIds.length === 1 && one.opportunityIds[0] === made.id);
    expect(madeStrategy?.constraintsFailed.join(' ') ?? '').not.toMatch(/no performer is established/);
    // No proved match: unchanged — the conservative sweep, refused for the missing performer.
    expect(demandOf(nobody.id)?.refused).toMatch(/no performer is established/);
    const nobodyStrategy = reading.strategies.find((one) => one.opportunityIds.length === 1 && one.opportunityIds[0] === nobody.id);
    expect(nobodyStrategy?.constraintsFailed.join(' ')).toMatch(/no performer is established for "Brokerage request for information"/);

    // The model input itself, through the real card read: 0 owner hours with the proof, the sweep without it.
    const modelled = await modelOpportunity(made, 0, 'QUALIFIED', 'USD', [], null, now, 18, ['website']);
    expect('reason' in modelled ? null : modelled.hours.value).toBe(0);
    const unproved = await modelOpportunity(made, 0, 'QUALIFIED', 'USD', [], null, now, 18);
    expect('reason' in unproved ? null : [unproved.hours.low, unproved.hours.high]).toEqual([1, 40]);
  }, 180_000);
});

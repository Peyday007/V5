/**
 * A money figure written with one decimal is tenths, not a stray decimal
 * (planningReliability round 2, 2026-11-21).
 *
 * `amountOf` read two decimals as cents and three as a thousands group, and
 * refused everything else, so a card's direct cost written as a number prints
 * it — `$963.6` — was no figure at all. The cost was then swept as unknown, and
 * a priced, costed, capital-stated opening failed ECONOMICS on "costs or money
 * tied up are not established" with every figure on its card. A separator of
 * the same kind earlier (`1.2.3`) is still a version number, and a scale word
 * or shorthand after the figure is still refused.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { readMoneyFigures } from '../server/services/cash/figures.ts';
import { modelOpportunity } from '../server/services/cash/goalScenario.ts';
import { economicsState } from '../server/services/goals/plan.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';

const cents = (text: string, currency = 'USD') => readMoneyFigures(text, currency).map((f) => f.cents);

describe('one decimal is tenths', () => {
  it('reads a tenths figure in either convention, alone or grouped', () => {
    expect(cents('$612.5')).toEqual([61250]);
    expect(cents('$0.5')).toEqual([50]);
    expect(cents('$4,612.5')).toEqual([461250]);
    expect(cents('€4.612,5', 'EUR')).toEqual([461250]);
    expect(cents('$612.5 per word')).toEqual([61250]);
    expect(readMoneyFigures('$612.5 per word', 'USD')[0]!.perUnit).toBe(true);
  });

  it('still refuses a version number, shorthand and a scale word', () => {
    expect(cents('$1.2.3')).toEqual([]);
    expect(cents('$3.5k')).toEqual([]);
    expect(cents('$1.5 million')).toEqual([]);
    expect(cents('$1,234,5')).toEqual([]);
  });

  it('a card whose direct cost is written in tenths reads that cost, and its economics hold', async () => {
    const projectId = (await freshProject()).project.id;
    const userId = (await createUser({ email: `tenths-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    const cashModeId = (await getCashMode(projectId))!.id;
    // A wholesale lot of 30 brass lanterns: $1,140 a lot, landed at $20.42 a unit = $612.6.
    const o = await createOpportunity({
      projectId, cashModeId, ownerUserId: userId, title: 'Brass lanterns wholesaled to gift shops (30-unit lot)', mechanism: 'RESALE_OR_ASSET', currency: 'USD',
      sourceClaimId: 'clm_tenths_src', opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher', requiredCapabilities: [],
    });
    await recordCardFact({ projectId, opportunityId: o.id, field: CAPTURE_KEY, kind: 'EVIDENCE', value: 'Sell a 30-unit lot to each shop.', claimId: `clm_c_${o.id}`, decidedBy: 'BRAIN' });
    await updateOpportunity(o.id, { price_cents: 114_000, offer_scope: 'One 30-unit lot', payer: 'Gift shops', peak_funding_cents: 61_260 });
    await recordCardFact({ projectId, opportunityId: o.id, field: 'price', kind: 'EVIDENCE', value: '$1140', claimId: `clm_p_${o.id}`, decidedBy: 'BRAIN' });
    await recordCardFact({ projectId, opportunityId: o.id, field: 'directCosts', kind: 'EVIDENCE', value: '$612.6', claimId: `clm_d_${o.id}`, decidedBy: 'BRAIN' });
    await recordCardFact({ projectId, opportunityId: o.id, field: 'exposure', kind: 'EVIDENCE', value: '$612.6', claimId: `clm_e_${o.id}`, decidedBy: 'BRAIN' });
    const modelled = await modelOpportunity((await getOpportunity(o.id))!, 0, 'QUALIFIED', 'USD', [], null, new Date(), 60);
    if ('reason' in modelled) throw new Error(modelled.reason);
    expect(modelled.directCost.value).toBe(612.6);
    expect(modelled.directCost.provenance).toBe('EVIDENCE');
    const economics = economicsState(modelled, { capitalBeforeProofCents: null });
    expect(economics.ok).toBe(true);
    expect(economics.basis).toBe('cost 612.6, tied up 612.6');
  });
});

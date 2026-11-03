/**
 * The standing operating rule (owner, 2026-11-02): the owner does no physical
 * work; physical work is in scope only when an independent party performs it
 * and this operation coordinates it online; geography is a business variable.
 */
import { describe, expect, it } from 'vitest';
import { breaksOperatingModel, OPERATING_MODEL_SENTENCE, operatingFit } from '../server/domain/operatingModel.ts';
import { executionFrameSentence } from '../server/services/cash/discovery.ts';
import { notWorthResearching } from '../server/services/cash/worthResearching.ts';
import { APPROVAL_ENVELOPES } from '../server/services/research/approvalEnvelope.ts';
import { describesOwnAction } from '../server/services/research/actorScope.ts';

describe('what the owner would have to do physically', () => {
  it('rules out openings that need the owner on site, from the plans production actually built', () => {
    for (const title of [
      'Holiday light installation on single-story homes, Nov 14–Dec 6',
      'Fresh tree delivered, set up and removed in January',
      'Leaf and single-story gutter cleanup',
      'Hand out 3,000 door hangers in two neighbourhoods',
      'Texas surplus jewelry lots — needs someone in Austin for preview and pickup',
      'Junk removal jobs in Phoenix',
      // Production's own openings, 2026-11-03, that the first patterns missed.
      "As of the June 25, 2026 article, the Air Jordan 6 'Bin 23' had a current average resale price above retail",
      'theshitbot.com, citing current StockX resale-market data as of March 2026',
      'DropCurb engages drivers per completed pickup rather than as employees',
      // Its own drivers are the independent contractors: the operator would be one of them.
      'DropCurb engages drivers per completed pickup rather than as employees; drivers are independent contractors',
    ]) {
      const fit = operatingFit({ title });
      expect(fit.kind, title).toBe('OWNER_PHYSICAL');
      expect(breaksOperatingModel(fit)).toBe(true);
    }
  });

  it('keeps physical work an independent party performs and this operation brokers online', () => {
    for (const facts of [
      { title: 'Exclusive junk removal leads sold to local haulers, charged per lead' },
      { title: 'Broker holiday light installation to independent installers for a 10% commission' },
      { title: 'Corporate food gifts drop-shipped by the supplier to each recipient' },
      { title: 'Holiday light installation for homeowners', fulfillmentOwner: 'A licensed local installer crew (subcontractor)' },
    ]) {
      const fit = operatingFit(facts);
      expect(fit.kind, facts.title).toBe('BROKERED_PHYSICAL');
      expect(breaksOperatingModel(fit)).toBe(false);
    }
  });

  it('does not read digital work as physical', () => {
    for (const title of [
      'Done-for-you AI holiday marketing pack for small businesses',
      'Data cleaning and CRM cleanup for B2B sales teams',
      'App install campaign management',
      'Warehouse management software comparison report',
      'Large-print puzzle licence packs for senior-living activity directors',
      // Tickets transfer electronically: reselling them needs nobody on site.
      "On FIFA's Official Resale Marketplace, a Category 3 seat for the World Cup 2026 final",
      'Driver scheduling software for logistics firms',
    ]) {
      expect(operatingFit({ title }).kind, title).toBe('REMOTE');
    }
    expect(operatingFit({ title: '' }).kind).toBe('UNKNOWN');
  });

  it('never lets the owner be named as the one doing the physical part', () => {
    expect(operatingFit({ title: 'Holiday light installation', fulfillmentOwner: 'the owner and two friends' }).kind).toBe('OWNER_PHYSICAL');
  });
});

describe('the rule is applied where Brain finds and screens openings', () => {
  it('is stated in every discovery question, with geography as a business choice', () => {
    const sentence = executionFrameSentence({ delivers: ['research reports'], deployableCents: 0, currency: 'USD' });
    expect(sentence).toContain(OPERATING_MODEL_SENTENCE);
    expect(sentence).toMatch(/does no physical work/);
    expect(sentence).toMatch(/every country and region/);
    // Its words never read as an action Brain may not take.
    for (const envelope of Object.values(APPROVAL_ENVELOPES)) expect(describesOwnAction(OPERATING_MODEL_SENTENCE, envelope.forbiddenActions)).toBe(false);
  });

  it('screens an owner-physical opening out before any research is spent, and keeps a brokered one', async () => {
    const now = new Date().toISOString();
    const base = { projectId: '', sourceClaimId: null, expiresAt: null, offerScope: null, fulfillmentOwner: null };
    const physical = await notWorthResearching({ ...base, id: 'cop_a', title: 'Fresh tree delivered, set up and removed in January' } as never, { now });
    expect(physical).toMatchObject({ kind: 'SCREENED_OUT', reason: 'OWNER_PHYSICAL_WORK' });
    const brokered = await notWorthResearching({ ...base, id: 'cop_b', title: 'Exclusive junk removal leads sold to local haulers' } as never, { now });
    expect(brokered).toBeNull();
  });
});

describe('every kernel states the rule in its research questions', () => {
  it('has one place that writes the sprint goal, and it carries the rule', async () => {
    const { readFileSync } = await import('node:fs');
    const { sprintGoalLine } = await import('../server/domain/operatingModel.ts');
    expect(sprintGoalLine('Collect cash.')).toContain(OPERATING_MODEL_SENTENCE);
    // No builder may write the sprint goal by hand, which is how the dealflow kernel asked
    // about landing mining trucks in Russia without the rule (production, 2026-11-03).
    for (const path of ['server/services/industry/questions.ts', 'server/services/puzzle/questions.ts', 'server/services/dealflow/questions.ts', 'server/services/feeds/run.ts']) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      expect(source, path).not.toMatch(/short cash sprint whose goal is: \$\{/);
      expect(source, path).toContain('sprintGoalLine(');
    }
  });
});

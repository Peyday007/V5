/**
 * The commerce kernel (§73): what is selling now, who ships it, what it sells
 * for, what one order costs to sell, and which audience wants it.
 *
 * ---------------------------------------------------------------------------
 * What this pins, and why each one is a property rather than an example
 * ---------------------------------------------------------------------------
 *
 * **A finding is declared, never read out of prose.** One validator, called at
 * both submission doors, so the tests that matter are the refusals.
 *
 * **A margin past an unknown is withheld.** A contribution that silently skips
 * the shipping or the card fee is wrong in the direction that makes a product
 * look worth advertising, which is the shape of error nobody checks.
 *
 * **"Selling now" is a claim about a date.** An undated demand signal is
 * refused at filing, and an old one reads STALE rather than as demand.
 *
 * **Finishing a product outranks finding a new one**, and discovery always
 * waits behind follow-ups whose research has already been paid for.
 *
 * **Every question Brain asks passes the envelope it is judged by.** The
 * questions are compiled through the real compiler, so a sentence that reads
 * as Brain's own action ("publish a", "place an order") fails here rather than
 * in production.
 *
 * **Nothing here sells anything.** The view names what is not connected, and
 * no module in the kernel imports a provider or records a commercial action.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { getProject } from '../server/repos/projects.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import {
  createCommerceProduct,
  listCommerceFacts,
  listCommerceProducts,
  listCommerceRounds,
  recordCommerceFact,
} from '../server/repos/commerce.ts';
import { productKey, validateCommerceFinding } from '../server/domain/commerce.ts';
import { readEconomics } from '../server/services/commerce/economics.ts';
import { readStanding, MIN_DEMAND_SOURCES } from '../server/services/commerce/standing.ts';
import { commerceSnapshot } from '../server/services/commerce/graph.ts';
import { planFrom, runCommerceKernel } from '../server/services/commerce/kernel.ts';
import {
  moveCommerceProgramme,
  seedCommerceProduct,
  startCommerceProgramme,
} from '../server/services/commerce/programme.ts';
import { commerceView, NOT_CONNECTED } from '../server/services/commerce/view.ts';
import {
  costsQuestion,
  discoverQuestion,
  nicheQuestion,
  priceQuestion,
  sourceQuestion,
} from '../server/services/commerce/questions.ts';
import { compileMission } from '../server/services/russell/compiler.ts';
import { profileFor } from '../server/services/russell/compilerProfiles.ts';
import { APPROVAL_ENVELOPES, getApprovalEnvelope } from '../server/services/research/approvalEnvelope.ts';
import { ownActionMatches } from '../server/services/research/actorScope.ts';
import type {
  CommerceFact,
  CommerceFinding,
  CommerceProduct,
  Layer,
} from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let layer: Layer;

const OBJECTIVE = 'Find generic products selling now that one order can pay to advertise.';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `commerce-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function activated(): Promise<void> {
  const outcome = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
}

async function started(): Promise<void> {
  await activated();
  const outcome = await startCommerceProgramme({ projectId, actorUserId: userId, objective: OBJECTIVE });
  expect(outcome.ok).toBe(true);
}

// ---------------------------------------------------------------------------
// Pure fixtures for the arithmetic
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-10-20T00:00:00Z');
const RECENT = '2026-10-10';

function product(name = 'Posture corrector brace'): CommerceProduct {
  return {
    id: `cpr_${productKey(name).replace(/\W/g, '')}`,
    projectId: 'prj_x',
    name,
    productKey: productKey(name),
    note: null,
    origin: 'DISCOVERED',
    sourceClaimId: 'clm_x',
    retiredAt: null,
    retiredReason: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

let factSeq = 0;
function fact(
  of: CommerceProduct,
  finding: CommerceFinding,
  input: Partial<Pick<CommerceFact, 'subject' | 'value' | 'amountCents' | 'rateBps' | 'currency' | 'days' | 'publisher' | 'observedOn'>> = {},
): CommerceFact {
  factSeq += 1;
  return {
    id: `cfa_${factSeq}`,
    projectId: of.projectId,
    productId: of.id,
    finding,
    subject: input.subject ?? 'A source',
    value: input.value ?? null,
    amountCents: input.amountCents ?? null,
    rateBps: input.rateBps ?? null,
    currency: input.currency ?? (input.amountCents !== undefined ? 'USD' : null),
    days: input.days ?? null,
    statement: 'a published statement',
    publisher: input.publisher ?? null,
    observedOn: input.observedOn ?? null,
    sourceClaimId: `clm_${factSeq}`,
    createdAt: '2026-10-11T00:00:00Z',
  };
}

/** A product with every line published: $39.99 retail, $8 landed, 2.9% card fee, $4 shipping. */
function costedFacts(of: CommerceProduct, overrides: { days?: number | null } = {}): CommerceFact[] {
  return [
    fact(of, 'PRODUCT_DEMAND', { subject: 'Amazon Best Sellers', value: 'BESTSELLER_RANK', publisher: 'Amazon', observedOn: RECENT }),
    fact(of, 'PRODUCT_DEMAND', { subject: 'TikTok Shop', value: 'ORDER_COUNT', publisher: 'TikTok', observedOn: RECENT }),
    fact(of, 'SUPPLIER_OFFER', { subject: 'CJ Dropshipping', amountCents: 800, days: overrides.days === undefined ? 9 : overrides.days }),
    fact(of, 'RETAIL_PRICE', { subject: 'A storefront', amountCents: 3999 }),
    fact(of, 'COST_LINE', { subject: 'Stripe', value: 'PAYMENT_PROCESSING', rateBps: 290 }),
    fact(of, 'COST_LINE', { subject: 'CJ Dropshipping', value: 'SHIPPING_TO_CUSTOMER', amountCents: 400 }),
  ];
}

function stand(of: CommerceProduct, facts: CommerceFact[]) {
  const economics = readEconomics({ products: [of], facts });
  return readStanding({ products: [of], facts, economics, now: NOW })[0]!;
}

// ---------------------------------------------------------------------------

describe('a finding is declared, never read out of prose', () => {
  const base = {
    where: 'claims[0]',
    finding: undefined as unknown,
    product: undefined as unknown,
    subject: undefined as unknown,
    value: undefined as unknown,
    amountCents: undefined as unknown,
    rateBps: undefined as unknown,
    currency: undefined as unknown,
    days: undefined as unknown,
  };

  it('accepts a claim that declares nothing, which is most claims', () => {
    expect(validateCommerceFinding(base).ok).toBe(true);
  });

  it('refuses a companion field with no finding', () => {
    expect(validateCommerceFinding({ ...base, product: 'Posture corrector' }).ok).toBe(false);
    expect(validateCommerceFinding({ ...base, amountCents: 100 }).ok).toBe(false);
  });

  it('refuses a finding outside the closed set', () => {
    expect(validateCommerceFinding({ ...base, finding: 'WINNING_PRODUCT', product: 'x', subject: 'y' }).ok).toBe(false);
  });

  it('refuses a finding that names no product or no subject', () => {
    expect(validateCommerceFinding({ ...base, finding: 'NICHE_SIGNAL', subject: 'runners' }).ok).toBe(false);
    expect(validateCommerceFinding({ ...base, finding: 'NICHE_SIGNAL', product: 'Posture corrector' }).ok).toBe(false);
  });

  it('refuses a demand signal that names no kind of signal', () => {
    const check = validateCommerceFinding({
      ...base,
      finding: 'PRODUCT_DEMAND',
      product: 'Posture corrector',
      subject: 'TikTok Shop',
    });
    expect(check.ok).toBe(false);
  });

  it('refuses a price with no figure, and a figure with no currency', () => {
    const priced = { ...base, finding: 'RETAIL_PRICE', product: 'Posture corrector', subject: 'A storefront' };
    expect(validateCommerceFinding(priced).ok).toBe(false);
    expect(validateCommerceFinding({ ...priced, amountCents: 3999 }).ok).toBe(false);
    expect(validateCommerceFinding({ ...priced, amountCents: 3999, currency: 'usd' }).ok).toBe(true);
  });

  it('refuses a cost line carrying both an amount and a rate', () => {
    const check = validateCommerceFinding({
      ...base,
      finding: 'COST_LINE',
      product: 'Posture corrector',
      subject: 'Stripe',
      value: 'PAYMENT_PROCESSING',
      amountCents: 30,
      rateBps: 290,
      currency: 'USD',
    });
    expect(check.ok).toBe(false);
  });

  it('refuses delivery days on anything but a supplier offer', () => {
    const check = validateCommerceFinding({
      ...base,
      finding: 'RETAIL_PRICE',
      product: 'Posture corrector',
      subject: 'A storefront',
      amountCents: 3999,
      currency: 'USD',
      days: 7,
    });
    expect(check.ok).toBe(false);
  });

  it('is the same validator on both submission doors', () => {
    const schema = readFileSync(new URL('../server/services/research/schema.ts', import.meta.url), 'utf8');
    const tool = readFileSync(new URL('../server/mcp/researchTools.ts', import.meta.url), 'utf8');
    expect(schema).toContain('validateCommerceFinding');
    expect(tool).toContain('validateCommerceFinding');
  });

  it('declares every commerce field in the tool schema rather than only describing it', () => {
    const tool = readFileSync(new URL('../server/mcp/researchTools.ts', import.meta.url), 'utf8');
    for (const field of [
      'commerce_finding',
      'commerce_product',
      'commerce_subject',
      'commerce_value',
      'commerce_amount_cents',
      'commerce_rate_bps',
      'commerce_currency',
      'commerce_days',
    ]) {
      expect(tool.includes(`${field}:`), field).toBe(true);
    }
  });

  it('carries every field through the submission mapper', () => {
    const mapper = readFileSync(new URL('../server/services/research/submission.ts', import.meta.url), 'utf8');
    for (const field of ['commerceFinding', 'commerceProduct', 'commerceSubject', 'commerceValue', 'commerceAmountCents', 'commerceRateBps', 'commerceCurrency', 'commerceDays']) {
      expect(mapper.includes(field), field).toBe(true);
    }
  });
});

describe('a margin past an unknown is withheld', () => {
  it('computes the acquisition budget when every load-bearing line is published', () => {
    const one = product();
    const [economics] = readEconomics({ products: [one], facts: costedFacts(one) });
    // 3999 - 800 - 400 - ceil(3999 * 0.029 = 115.97 -> 116) = 2683
    expect(economics!.contributionBeforeAdsCents).toBe(2683);
    expect(economics!.withheld).toBe(null);
  });

  it('withholds it when the card fee is missing, naming the line', () => {
    const one = product();
    const facts = costedFacts(one).filter((f) => f.value !== 'PAYMENT_PROCESSING');
    const [economics] = readEconomics({ products: [one], facts });
    expect(economics!.contributionBeforeAdsCents).toBe(null);
    expect(economics!.missing).toContain('PAYMENT_PROCESSING');
  });

  it('treats a published free-shipping offer as a figure, not a missing line', () => {
    const one = product();
    const facts = costedFacts(one).map((f) =>
      f.value === 'SHIPPING_TO_CUSTOMER' ? { ...f, amountCents: 0 } : f,
    );
    const [economics] = readEconomics({ products: [one], facts });
    expect(economics!.missing).not.toContain('SHIPPING_TO_CUSTOMER');
    expect(economics!.contributionBeforeAdsCents).toBe(3083);
  });

  it('withholds it when the figures are in two currencies, rather than converting', () => {
    const one = product();
    const facts = costedFacts(one).map((f) => (f.finding === 'RETAIL_PRICE' ? { ...f, currency: 'GBP' } : f));
    const [economics] = readEconomics({ products: [one], facts });
    expect(economics!.contributionBeforeAdsCents).toBe(null);
  });

  it('takes the highest published figure for a line, never an average', () => {
    const one = product();
    const facts = [
      ...costedFacts(one),
      fact(one, 'COST_LINE', { subject: 'Another carrier', value: 'SHIPPING_TO_CUSTOMER', amountCents: 900 }),
    ];
    const [economics] = readEconomics({ products: [one], facts });
    expect(economics!.contributionBeforeAdsCents).toBe(2183);
  });

  it('does not count advertising in the budget, because the budget is what advertising may spend', () => {
    const one = product();
    const facts = [
      ...costedFacts(one),
      fact(one, 'COST_LINE', { subject: 'An ads benchmark', value: 'AD_COST_PER_ORDER', amountCents: 1500 }),
    ];
    const [economics] = readEconomics({ products: [one], facts });
    expect(economics!.contributionBeforeAdsCents).toBe(2683);
    expect(economics!.contributionAfterAdsCents).toBe(1183);
  });
});

describe('where a product stands is derived from its rows', () => {
  it('reads a product with no dated signal as on the map, not as demand', () => {
    const one = product();
    expect(stand(one, []).stage).toBe('ON_MAP');
  });

  it('reads an old signal as stale rather than as selling now', () => {
    const one = product();
    const facts = [fact(one, 'PRODUCT_DEMAND', { value: 'BESTSELLER_RANK', observedOn: '2025-01-01' })];
    expect(stand(one, facts).stage).toBe('STALE');
  });

  it('qualifies a product only with independent demand, a full margin and fast delivery', () => {
    const one = product();
    expect(stand(one, costedFacts(one)).stage).toBe('QUALIFIED');
  });

  it(`holds it at COSTED with fewer than ${MIN_DEMAND_SOURCES} independent demand sources`, () => {
    const one = product();
    const facts = costedFacts(one).filter((f) => f.subject !== 'TikTok Shop');
    expect(stand(one, facts).stage).toBe('COSTED');
  });

  it('holds it at COSTED when nobody published how long delivery takes', () => {
    const one = product();
    expect(stand(one, costedFacts(one, { days: null })).stage).toBe('COSTED');
  });

  it('reads a margin under the floor as thin rather than as qualified', () => {
    const one = product();
    const facts = costedFacts(one).map((f) => (f.finding === 'SUPPLIER_OFFER' ? { ...f, amountCents: 3000 } : f));
    expect(stand(one, facts).stage).toBe('THIN_MARGIN');
  });

  it('blocks a product a published rule prohibits, whatever else is answered', () => {
    const one = product();
    const facts = [
      ...costedFacts(one),
      fact(one, 'RESTRICTION', { subject: 'A marketplace prohibited list', value: 'PROHIBITED_ITEM' }),
    ];
    expect(stand(one, facts).stage).toBe('BLOCKED');
  });

  it('keeps an ad policy as a condition to read rather than a block', () => {
    const one = product();
    const facts = [
      ...costedFacts(one),
      fact(one, 'RESTRICTION', { subject: 'Meta health claims policy', value: 'AD_POLICY' }),
    ];
    const standing = stand(one, facts);
    expect(standing.stage).toBe('QUALIFIED');
    expect(standing.conditions.join(' ')).toContain('AD_POLICY');
  });
});

describe('the operation stays read-only', () => {
  it('starts nothing without a person and a cash sprint', async () => {
    const without = await startCommerceProgramme({ projectId, actorUserId: userId, objective: OBJECTIVE });
    expect(without.ok).toBe(false);
    await activated();
    const brain = await startCommerceProgramme({ projectId, actorUserId: 'BRAIN', objective: OBJECTIVE });
    expect(brain.ok).toBe(false);
    const short = await startCommerceProgramme({ projectId, actorUserId: userId, objective: 'sell stuff' });
    expect(short.ok).toBe(false);
  });

  it('names what is not connected rather than implying a store exists', async () => {
    await started();
    const view = await commerceView(projectId);
    expect(view.notConnected.map((one) => one.capability)).toEqual(NOT_CONNECTED.map((one) => one.capability));
    expect(view.notConnected.some((one) => /advertis/i.test(one.capability))).toBe(true);
  });

  it('imports no provider and records no commercial action anywhere in the kernel', () => {
    const dir = new URL('../server/services/commerce/', import.meta.url);
    const files = readdirSync(dir).filter((one) => one.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(new URL(file, dir), 'utf8');
      for (const forbidden of ['cash/providers', 'recordAction', 'beginExecution', 'perform.ts', 'cashLedger']) {
        expect(`${file}:${text.includes(forbidden)}`).toBe(`${file}:false`);
      }
    }
  });
});

describe('every question Brain asks passes the envelope it is judged by', () => {
  it('has an envelope and a compiler profile for each, with the discovery envelope’s permissions', () => {
    const discovery = getApprovalEnvelope('RUSSELL_CASH_DISCOVERY_V1')!;
    for (const id of ['RUSSELL_COMMERCE_DISCOVERY_V1', 'RUSSELL_COMMERCE_TERMS_V1']) {
      const mine = getApprovalEnvelope(id)!;
      expect(mine).toBeTruthy();
      expect(profileFor(id)).not.toBe(null);
      expect(mine.allowedSourceTypes).toBe(discovery.allowedSourceTypes);
      expect(mine.forbiddenActions).toBe(discovery.forbiddenActions);
      for (const phrase of ['contacting any person', 'quoting', 'making any commitment']) {
        expect(`${id}:${(mine.assignmentTemplate ?? '').includes(phrase)}`).toBe(`${id}:true`);
      }
    }
  });

  it('writes no sentence that reads as Brain’s own action', () => {
    const one = product();
    const standing = stand(one, costedFacts(one).filter((f) => f.finding !== 'COST_LINE'));
    const questions: [string, string][] = [
      ['discover', discoverQuestion({ objective: OBJECTIVE, round: 2, known: ['Posture corrector brace'] })],
      ['source', sourceQuestion({ product: one.name, objective: OBJECTIVE })],
      ['price', priceQuestion({ product: one.name, objective: OBJECTIVE })],
      ['costs', costsQuestion({ product: one.name, objective: OBJECTIVE, standing })],
      ['niche', nicheQuestion({ product: one.name, objective: OBJECTIVE })],
    ];
    for (const id of ['RUSSELL_COMMERCE_DISCOVERY_V1', 'RUSSELL_COMMERCE_TERMS_V1']) {
      const envelope = APPROVAL_ENVELOPES[id]!;
      for (const [name, text] of questions) {
        const matches = ownActionMatches(text, envelope.forbiddenActions);
        expect(
          matches.length,
          matches.length === 0 ? '' : `${name} reads as Brain's own action: "${matches[0]!.phrase}"`,
        ).toBe(0);
      }
    }
  });

  it('compiles the opening discovery round through the real compiler', async () => {
    await started();
    const pass = await runCommerceKernel(projectId);
    const discover = pass.opened.find((one) => one.purpose === 'DISCOVER');
    expect(discover).toBeTruthy();
    const compiled = await compileMission({
      candidate: (await getCandidate(discover!.candidateId))!,
      project: (await getProject(projectId))!,
      archive: { claimsConsidered: 0, contradicting: [] },
    });
    expect(compiled.ok, compiled.ok ? '' : compiled.reason).toBe(true);
    if (compiled.ok) expect(compiled.mission.envelopeId).toBe('RUSSELL_COMMERCE_DISCOVERY_V1');
  });

  it('compiles a follow-up round under the terms envelope', async () => {
    await started();
    const one = await createCommerceProduct({
      projectId,
      name: 'Posture corrector brace',
      note: 'test',
      origin: 'SEED',
    });
    for (const [subject, publisher] of [['Amazon Best Sellers', 'Amazon'], ['TikTok Shop', 'TikTok']]) {
      await recordCommerceFact({
        projectId,
        productId: one.product.id,
        finding: 'PRODUCT_DEMAND',
        subject: subject!,
        value: 'BESTSELLER_RANK',
        amountCents: null,
        rateBps: null,
        currency: null,
        days: null,
        statement: 'It ranks.',
        publisher: publisher!,
        observedOn: new Date().toISOString().slice(0, 10),
        sourceClaimId: `clm_${subject}`,
      });
    }
    const pass = await runCommerceKernel(projectId);
    const follow = pass.opened.find((one) => one.purpose !== 'DISCOVER');
    expect(follow, JSON.stringify(pass.declined)).toBeTruthy();
    const compiled = await compileMission({
      candidate: (await getCandidate(follow!.candidateId))!,
      project: (await getProject(projectId))!,
      archive: { claimsConsidered: 0, contradicting: [] },
    });
    expect(compiled.ok, compiled.ok ? '' : compiled.reason).toBe(true);
    if (compiled.ok) expect(compiled.mission.envelopeId).toBe('RUSSELL_COMMERCE_TERMS_V1');
  });
});

describe('finishing a product outranks finding a new one', () => {
  it('asks the follow-up before discovery, and never more than the free slots', async () => {
    await started();
    const one = await createCommerceProduct({ projectId, name: 'Posture corrector brace', note: 't', origin: 'SEED' });
    await recordCommerceFact({
      projectId,
      productId: one.product.id,
      finding: 'PRODUCT_DEMAND',
      subject: 'TikTok Shop',
      value: 'ORDER_COUNT',
      amountCents: null,
      rateBps: null,
      currency: null,
      days: null,
      statement: 'Ten thousand sold.',
      publisher: 'TikTok',
      observedOn: new Date().toISOString().slice(0, 10),
      sourceClaimId: 'clm_seen',
    });
    const plan = planFrom(await commerceSnapshot(projectId));
    expect(plan.asks.length).toBeGreaterThan(1);
    expect(plan.asks[0]!.purpose).not.toBe('DISCOVER');
    expect(plan.asks[plan.asks.length - 1]!.purpose).toBe('DISCOVER');
  });

  it('does not ask a question already being asked', async () => {
    await started();
    const first = await runCommerceKernel(projectId);
    expect(first.opened.length).toBeGreaterThan(0);
    const second = await runCommerceKernel(projectId);
    expect(second.opened.length).toBe(0);
    const rounds = await listCommerceRounds(projectId);
    expect(rounds.filter((one) => one.purpose === 'DISCOVER').length).toBe(1);
  });

  it('opens nothing while paused, and seeding never creates research by itself', async () => {
    await started();
    const paused = await moveCommerceProgramme({ projectId, actorUserId: userId, to: 'PAUSED' });
    expect(paused.ok).toBe(true);
    const seeded = await seedCommerceProduct({ projectId, actorUserId: userId, name: 'Pet hair remover roller' });
    expect(seeded.ok).toBe(true);
    const pass = await runCommerceKernel(projectId);
    expect(pass.opened.length).toBe(0);
    expect((await listCommerceRounds(projectId)).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Filing: the real path from a gated claim to a fact
// ---------------------------------------------------------------------------

interface DeclaredClaim {
  claim: string;
  finding: CommerceFinding;
  product: string;
  subject: string;
  value?: string | null;
  amountCents?: number | null;
  currency?: string | null;
  days?: number | null;
  date?: string | null;
}

async function answer(candidateId: string, claims: DeclaredClaim[]): Promise<void> {
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a commerce round',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'a commerce round',
    assignment: 'what is selling now',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'the United States',
      requiredEvidence: [{ id: 'product_demand', description: 'selling now', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a best-seller list'],
      excludedSourceTypes: [],
      completionCriteria: ['every product declared on its claim'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'commerce-discover',
      question: 'What is selling?',
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const inserted = await insertClaims(
    claims.map((one) => ({
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: one.claim,
      sourceUrl: 'https://example.test/source',
      sourceTitle: 'A published source',
      sourcePublisher: 'A publisher',
      sourceDate: one.date === undefined ? '2026-10-15' : one.date,
      evidenceExcerpt: one.claim,
      evidenceLocator: 'the page body',
      evidenceLane: 'product_demand',
      commerceFinding: one.finding,
      commerceProduct: one.product,
      commerceSubject: one.subject,
      commerceValue: one.value ?? null,
      commerceAmountCents: one.amountCents ?? null,
      commerceRateBps: null,
      commerceCurrency: one.currency ?? null,
      commerceDays: one.days ?? null,
      retrievedAt: '2026-10-15',
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: `${one.claim}|${one.subject}`,
    })) as unknown as Parameters<typeof insertClaims>[0],
  );
  for (const claim of inserted) await decideClaim(claim.id, { accepted: true });
  const { mission } = await launchMission({
    projectId,
    layerId: layer.id,
    visibility: 'SHARED',
    objective: 'a commerce round',
    whyNow: 'the programme is active',
    idempotencyKey: `mission:${orchestration.id}`,
    candidateId,
  });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE' });
}

describe('a gated claim becomes a product and a fact, and an undated one does not', () => {
  it('files dated demand, refuses undated demand, and settles the round with what it found', async () => {
    await started();
    const first = await runCommerceKernel(projectId);
    const discover = first.opened.find((one) => one.purpose === 'DISCOVER')!;
    await answer(discover.candidateId, [
      { claim: 'It ranks #3 in Health.', finding: 'PRODUCT_DEMAND', product: 'Posture Corrector Brace', subject: 'Amazon Best Sellers', value: 'BESTSELLER_RANK' },
      { claim: 'Over 10k sold.', finding: 'PRODUCT_DEMAND', product: 'posture corrector  brace', subject: 'TikTok Shop', value: 'ORDER_COUNT' },
      { claim: 'Selling well (no date).', finding: 'PRODUCT_DEMAND', product: 'Magnetic phone mount', subject: 'A blog', value: 'SOCIAL_TRACTION', date: null },
    ]);
    const pass = await runCommerceKernel(projectId);
    expect(pass.filed.refused.length).toBe(1);
    expect(pass.filed.refused[0]!.why).toContain('date');

    // Two spellings of one product converge on one row, because the key is case and whitespace.
    const products = await listCommerceProducts(projectId);
    expect(products.map((one) => one.productKey)).toEqual(['posture corrector brace']);
    expect((await listCommerceFacts(projectId)).length).toBe(2);

    const settled = (await listCommerceRounds(projectId)).find((one) => one.id === discover.roundId)!;
    expect(settled.state).toBe('SETTLED');
    expect(settled.found).toBe(2);

    // A replay files nothing twice.
    const again = await runCommerceKernel(projectId);
    expect(again.filed.facts.length).toBe(0);
    expect((await listCommerceFacts(projectId)).length).toBe(2);
  });
});

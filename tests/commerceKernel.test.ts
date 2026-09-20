/**
 * The social commerce kernel: the loop from a demand signal to a bounded test,
 * and the four places it refuses to guess.
 *
 * ---------------------------------------------------------------------------
 * What this pins, and why each one is a property rather than an example
 * ---------------------------------------------------------------------------
 *
 * **The channels are discovered.** There is no list of platforms in the
 * repository, and the first assertion here reads the source to prove it.
 * TikTok is a seed — the one origin Brain may not write — which is the whole
 * of how "start with TikTok" becomes a row instead of a constant.
 *
 * **Attention is never demand.** The distinction this kernel exists for, and
 * the tests that matter are the ones where a proposition with nine attention
 * readings does *not* advance, does not rank above one with a purchase, and
 * does not satisfy a bounded test's readiness.
 *
 * **An unknown withholds the margin.** Thirteen inputs, and twelve of them
 * plus one blank derives nothing. The failure direction is what is pinned: a
 * margin computed past a blank is wrong in the encouraging direction, which is
 * the one direction nobody checks.
 *
 * **Deny by default, in the order deny-by-default asks.** A bounded test asks
 * *may this happen* before *could this happen*, and this suite exercises the
 * refusal at every gate rather than only the happy path — because on this
 * Brain every path ends in a refusal, and the refusal is the product.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { listCashEvents } from '../server/repos/cashMode.ts';
import { listCandidates } from '../server/repos/russellCandidates.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { activate, setLifecycle, launchableUnderCashMode } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import {
  listChannels,
  listCommerceRounds,
  listEvidenceForProject,
  listPropositions,
  listTests,
  recordEvidence,
} from '../server/repos/commerce.ts';
import { validateCommerce, basisOf, commerceSpec } from '../server/domain/commerce.ts';
import { COMMERCE_FINDINGS, COMMERCE_ROUND_PURPOSES } from '../server/domain/types.ts';
import { readEconomics, REQUIRED_FOR_MARGIN } from '../server/services/commerce/economics.ts';
import { runCommerceKernel, snapshot, planFrom } from '../server/services/commerce/kernel.ts';
import { seedChannel, seedProposition, retireChannelSubject } from '../server/services/commerce/seed.ts';
import { commerceView } from '../server/services/commerce/view.ts';
import { profileFor } from '../server/services/russell/compilerProfiles.ts';
import { getApprovalEnvelope } from '../server/services/research/approvalEnvelope.ts';
import type { CommerceFinding, Layer } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let layer: Layer;

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

interface CommerceClaim {
  claim: string;
  finding: CommerceFinding;
  subject: string;
  qualifier?: string;
  amountMinor?: number;
  ratePpm?: number;
  days?: number;
  count?: number;
  sourceDate?: string | null;
  accepted?: boolean;
}

/**
 * A finished mission for one kernel round, carrying declared findings.
 *
 * Built from the real repositories rather than from a stub, because the thing
 * under test is which rows the absorption reads: a fixture that handed it
 * findings directly would pass against an absorption that read prose.
 */
async function finishedRound(input: {
  candidateId: string;
  claims: CommerceClaim[];
}): Promise<string> {
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
    assignment: 'what is bought here',
    provider: 'WORKER',
    autoApprove: false,
  });

  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'the markets the sprint may look at',
      requiredEvidence: [
        { id: 'purchase', description: 'evidence somebody bought', necessity: 'REQUIRED' },
      ],
      acceptableSourceTypes: ['a marketplace listing'],
      excludedSourceTypes: ['a view count offered as evidence of buying'],
      completionCriteria: ['every figure declared on its claim'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'commerce-demand',
      question: 'What is actually bought here?',
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);

  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, {
    status: 'ACCEPTED',
    completedAt: new Date().toISOString(),
    blockedReason: null,
  });

  const inserted = await insertClaims(
    input.claims.map((one) => ({
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: one.claim,
      sourceUrl: 'https://example.test/listing/1',
      sourceTitle: 'A listing',
      sourcePublisher: 'A marketplace',
      sourceDate: one.sourceDate === undefined ? '2026-09-10' : one.sourceDate,
      evidenceExcerpt: one.claim,
      evidenceLocator: 'the listing body',
      evidenceLane: 'purchase',
      commerceFinding: one.finding,
      commerceSubject: one.subject,
      commerceQualifier: one.qualifier ?? null,
      commerceAmountMinor: one.amountMinor ?? null,
      commerceRatePpm: one.ratePpm ?? null,
      commerceDays: one.days ?? null,
      commerceCount: one.count ?? null,
      retrievedAt: '2026-09-12',
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: `${one.claim}|${one.subject}|${Math.random()}`,
    })),
  );
  for (const [index, claim] of inserted.entries()) {
    await decideClaim(claim.id, { accepted: input.claims[index]!.accepted ?? true });
  }

  const { mission } = await launchMission({
    projectId,
    layerId: layer.id,
    visibility: 'SHARED',
    objective: 'a commerce round',
    whyNow: 'the sprint is active',
    idempotencyKey: `mission:${orchestration.id}`,
    candidateId: input.candidateId,
  });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE' });
  return orchestration.id;
}

/** The candidate a commerce round of this purpose is asking, if one is open. */
async function candidateFor(purpose: string): Promise<string | null> {
  const rounds = await listCommerceRounds(projectId);
  const round = rounds.find((one) => one.purpose === purpose && one.state === 'OPEN');
  return round?.candidateId ?? null;
}

/**
 * A figure in the column its kind owns.
 *
 * Written once rather than per fixture, because getting it wrong is exactly
 * the defect `figureOf` was changed to refuse: a rate in the money column is
 * silently a very small amount of money, and the result is still a number.
 */
function figureFor(kind: CommerceFinding, value: number): {
  amountMinor: number | null;
  ratePpm: number | null;
  days: number | null;
  countUnits: number | null;
} {
  const shape = commerceSpec(kind).figure;
  return {
    amountMinor: shape === 'MONEY' ? value : null,
    ratePpm: shape === 'RATE' ? value : null,
    days: shape === 'DAYS' ? value : null,
    countUnits: shape === 'COUNT' ? value : null,
  };
}

/** Every figure a margin needs, so a test can take exactly one away. */
function fullEconomics(product: string, channel: string): CommerceClaim[] {
  return [
    { claim: 'it sells for 2499', finding: 'SELLING_PRICE', subject: product, amountMinor: 2499 },
    { claim: 'landed at 600', finding: 'LANDED_UNIT_COST', subject: product, amountMinor: 600 },
    { claim: 'shipping 300', finding: 'SHIPPING_COST', subject: product, amountMinor: 300 },
    { claim: 'the platform takes 8%', finding: 'PLATFORM_FEE', subject: channel, ratePpm: 80_000 },
    { claim: 'processing 2.9%', finding: 'PAYMENT_FEE', subject: channel, ratePpm: 29_000 },
    { claim: 'creators take 15%', finding: 'CREATOR_COMMISSION', subject: product, ratePpm: 150_000 },
    { claim: '6% returned', finding: 'RETURN_RATE', subject: product, ratePpm: 60_000 },
    { claim: '2% refunded', finding: 'REFUND_RATE', subject: product, ratePpm: 20_000 },
    { claim: '0.4% charged back', finding: 'CHARGEBACK_RATE', subject: product, ratePpm: 4_000 },
  ];
}

// ---------------------------------------------------------------------------

describe('the channels are discovered, never declared', () => {
  /**
   * The assertion the whole kernel rests on, and it reads the repository
   * rather than behaviour.
   *
   * `tests/operatorConsoleRemoved.test.ts` reads the source for the same
   * reason: what must not exist is not something a behavioural test can see.
   * A list of platforms anywhere in the kernel would answer the question the
   * kernel exists to ask — and on this subject it would be wrong within
   * months, because the platforms change their commission, their eligibility
   * and their fulfilment terms faster than anything else this Brain researches.
   */
  it('holds no list of platforms anywhere in the kernel', () => {
    const suspects = [
      'server/services/commerce/allocate.ts',
      'server/services/commerce/audit.ts',
      'server/services/commerce/economics.ts',
      'server/services/commerce/expand.ts',
      'server/services/commerce/kernel.ts',
      'server/services/commerce/questions.ts',
      'server/services/commerce/reading.ts',
      'server/services/commerce/seed.ts',
      'server/services/commerce/test.ts',
      'server/services/commerce/view.ts',
      'server/domain/commerce.ts',
      'server/repos/commerce.ts',
    ];
    /*
     * Named platforms, in the form they would actually be typed. The list is
     * deliberately the obvious ones rather than exhaustive: what it defends
     * against is somebody reaching for a convenient constant, and that reach
     * always lands on one of these.
     */
    const platforms = /\b(tiktok|instagram|facebook|youtube|pinterest|snapchat|shopify|amazon|etsy|ebay|temu|shein|aliexpress|alibaba|meta)\b/i;
    for (const file of suspects) {
      /*
       * Comments are stripped first, and that is a decision rather than a
       * convenience.
       *
       * `tests/operatorConsoleRemoved.test.ts` draws the same line for the
       * same reason: it classifies rather than bans, because a sentence
       * explaining *why* something must not exist is history worth keeping.
       * The allocator's bootstrap rule says in words that a seeded channel is
       * how "start with TikTok" becomes a row instead of a constant — deleting
       * that sentence to satisfy a grep would remove the only place the rule
       * is explained and change nothing about the code.
       *
       * What must not exist is a **platform name the code can reach**: a
       * constant, a literal in a comparison, a default. That is what survives
       * the strip.
       */
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(platforms.test(code), `${file} names a platform in its code`).toBe(false);
    }
  });

  it('lets a person seed TikTok, which is the only way it gets on the map', async () => {
    await activated();
    const seeded = await seedChannel({
      projectId,
      name: 'TikTok Shop',
      description: 'The initial discovery and distribution channel the owner named.',
      actorRef: userId,
      reason: 'start here, and let evidence name a stronger one',
    });
    expect(seeded.created).toBe(true);
    expect(seeded.channel.origin).toBe('SEED');
    expect(seeded.channel.sourceClaimId).toBeNull();

    const events = await listCashEvents(projectId, 50);
    const event = events.find((one) => one.kind === 'COMMERCE_SEEDED');
    expect(event).toBeTruthy();
    // Seeding spends nothing and starts nothing — said on the history rather
    // than only in a reply, because the reply is read once.
    expect(JSON.stringify(event?.detail)).toContain('starts no research');
  });

  it('refuses to write a discovered channel with no claim behind it', async () => {
    await activated();
    const { createChannel } = await import('../server/repos/commerce.ts');
    await expect(
      createChannel({ projectId, name: 'Somewhere', origin: 'DISCOVERED' }),
    ).rejects.toThrow(/without the claim/i);
  });

  it('retires rather than deletes, so the same channel cannot arrive as new', async () => {
    await activated();
    const seeded = await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    const retired = await retireChannelSubject({
      projectId,
      channelId: seeded.channel.id,
      reason: 'not worth following',
      actorRef: userId,
    });
    expect(retired?.retiredAt).toBeTruthy();
    expect(retired?.retiredReason).toBe('not worth following');
    // Still on the map, which is what stops it being rediscovered.
    expect((await listChannels(projectId)).length).toBe(1);
  });
});

describe('a commerce finding is declared, never read out of prose', () => {
  it('refuses a figure in the wrong field rather than converting it', () => {
    const wrong = validateCommerce({
      where: 'claims[0]',
      finding: 'PLATFORM_FEE',
      subject: 'A channel',
      qualifier: null,
      amountMinor: 800,
      ratePpm: null,
      days: null,
      count: null,
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.error).toMatch(/commerce_rate_ppm/);
      // The reason matters as much as the refusal: converting would be Brain
      // deciding what somebody meant.
      expect(wrong.error).toMatch(/will not convert/i);
    }
  });

  it('refuses a rate above one hundred per cent, because it is probably a percentage', () => {
    const wrong = validateCommerce({
      where: 'claims[0]',
      finding: 'PLATFORM_FEE',
      subject: 'A channel',
      qualifier: null,
      amountMinor: null,
      ratePpm: 8_000_000,
      days: null,
      count: null,
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toMatch(/percentage/i);
  });

  it('requires a product candidate to name its channel', () => {
    const wrong = validateCommerce({
      where: 'claims[0]',
      finding: 'PRODUCT_CANDIDATE',
      subject: 'A gadget',
      qualifier: null,
      amountMinor: null,
      ratePpm: null,
      days: null,
      count: null,
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toMatch(/commerce_qualifier/);
  });

  it('refuses a qualifier on a finding that is about itself', () => {
    const wrong = validateCommerce({
      where: 'claims[0]',
      finding: 'SELLING_PRICE',
      subject: 'A gadget',
      qualifier: 'A channel',
      amountMinor: 1999,
      ratePpm: null,
      days: null,
      count: null,
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toMatch(/about itself/);
  });

  it('refuses a companion field with no finding, so nothing is stored unread', () => {
    for (const field of ['subject', 'amountMinor'] as const) {
      const wrong = validateCommerce({
        where: 'claims[0]',
        finding: null,
        subject: field === 'subject' ? 'A gadget' : null,
        qualifier: null,
        amountMinor: field === 'amountMinor' ? 100 : null,
        ratePpm: null,
        days: null,
        count: null,
      });
      expect(wrong.ok).toBe(false);
    }
  });

  it('accepts a claim that declares nothing, which is most claims', () => {
    const fine = validateCommerce({
      where: 'claims[0]',
      finding: null,
      subject: null,
      qualifier: null,
      amountMinor: null,
      ratePpm: null,
      days: null,
      count: null,
    });
    expect(fine.ok).toBe(true);
  });

  /**
   * Both doors call the one validator, and this reads the source to prove it.
   *
   * A second copy of the rule is how two doors come to disagree about what a
   * valid declaration is, which this repository has had to record five times.
   */
  it('is validated by one function that both claim doors call', () => {
    for (const file of ['server/services/research/schema.ts', 'server/mcp/researchTools.ts']) {
      expect(readFileSync(file, 'utf8')).toContain('validateCommerce');
    }
  });

  /**
   * Every kind is declared in the submission schema, not only described.
   *
   * §33's defect exactly: `opportunity_signal` was named in a tool's prose and
   * left out of its schema beside `additionalProperties: false`, so a client
   * honouring the schema dropped the one field that decided whether anything
   * was ever created — and the failure read exactly like a worker honestly
   * finding nothing.
   */
  it('declares every commerce field in the submission schema', () => {
    const source = readFileSync('server/mcp/researchTools.ts', 'utf8');
    for (const field of [
      'commerce_finding',
      'commerce_subject',
      'commerce_qualifier',
      'commerce_amount_minor',
      'commerce_rate_ppm',
      'commerce_days',
      'commerce_count',
    ]) {
      expect(source, `${field} is described but not declared`).toContain(`${field}: {`);
    }
  });

  it('gives every finding a spec, so a kind added later is a compile error', () => {
    for (const finding of COMMERCE_FINDINGS) {
      const spec = commerceSpec(finding);
      expect(spec.guide.length).toBeGreaterThan(20);
      expect(['MONEY', 'RATE', 'DAYS', 'COUNT', 'NONE']).toContain(spec.figure);
    }
  });
});

describe('attention is never demand', () => {
  it('keeps them as different kinds with different figures', () => {
    expect(commerceSpec('PURCHASE_EVIDENCE').creates).toBeNull();
    expect(commerceSpec('ATTENTION_EVIDENCE').creates).toBeNull();
    // Two kinds is the mechanism. A single "DEMAND" kind with a flag would be
    // one column two readers could disagree about.
    expect(COMMERCE_FINDINGS).toContain('ATTENTION_EVIDENCE');
    expect(COMMERCE_FINDINGS).toContain('PURCHASE_EVIDENCE');
  });

  it('does not advance a proposition on attention alone', async () => {
    await activated();
    const channel = await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    const seeded = await seedProposition({
      projectId,
      channelId: channel.channel.id,
      product: 'A watched gadget',
      actorRef: userId,
    });
    expect(seeded?.created).toBe(true);

    for (let index = 0; index < 9; index += 1) {
      await recordEvidence({
        projectId,
        propositionId: seeded!.proposition.id,
        kind: 'ATTENTION_EVIDENCE',
        statement: `${index + 1}m views`,
        origin: 'CLAIM',
        sourceClaimId: null,
        countUnits: 1_000_000 * (index + 1),
        observedAt: '2026-09-10',
      }).catch(() => null);
    }
    // The CHECK refuses a CLAIM row with no claim id, which is itself the
    // point: a reading cannot pretend to a provenance it does not have. Write
    // them as a person's instead, which is what an operator entering a figure
    // by hand actually is.
    for (let index = 0; index < 9; index += 1) {
      await recordEvidence({
        projectId,
        propositionId: seeded!.proposition.id,
        kind: 'ATTENTION_EVIDENCE',
        statement: `${index + 1}m views`,
        origin: 'PERSON',
        actorRef: userId,
        countUnits: 1_000_000 * (index + 1),
        observedAt: '2026-09-10',
      });
    }

    const state = await snapshot(projectId);
    const reading = state.readings.find((one) => one.proposition.id === seeded!.proposition.id);
    expect(reading?.attention.length).toBe(9);
    expect(reading?.purchases.length).toBe(0);
    expect(reading?.stage).toBe('DEMAND_SIGNAL');
    expect(reading?.next.what).toMatch(/attention is not demand/i);
  });

  it('ranks a piece with one purchase above one with nine attention readings', async () => {
    await activated();
    const channel = await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    const watched = await seedProposition({
      projectId,
      channelId: channel.channel.id,
      product: 'A watched gadget',
      actorRef: userId,
    });
    const bought = await seedProposition({
      projectId,
      channelId: channel.channel.id,
      product: 'A bought gadget',
      actorRef: userId,
    });

    for (let index = 0; index < 9; index += 1) {
      await recordEvidence({
        projectId,
        propositionId: watched!.proposition.id,
        kind: 'ATTENTION_EVIDENCE',
        statement: 'views',
        origin: 'PERSON',
        actorRef: userId,
        countUnits: 9_000_000,
        observedAt: '2026-09-10',
      });
    }
    await recordEvidence({
      projectId,
      propositionId: bought!.proposition.id,
      kind: 'PURCHASE_EVIDENCE',
      statement: '40 units sold',
      origin: 'PERSON',
      actorRef: userId,
      countUnits: 40,
      observedAt: '2026-09-10',
    });

    const state = await snapshot(projectId);
    expect(state.readings[0]?.proposition.id).toBe(bought!.proposition.id);
  });
});

describe('an unknown is never a favourable assumption', () => {
  it('derives a contribution when every input is established', () => {
    const rows = REQUIRED_FOR_MARGIN.map((kind, index) => ({
      id: `cev_${index}`,
      projectId,
      propositionId: 'cpr_1',
      channelId: null,
      kind,
      statement: 'a figure',
      origin: 'CLAIM' as const,
      sourceClaimId: `clm_${index}`,
      testId: null,
      actorRef: null,
      ...figureFor(kind, kind === 'SELLING_PRICE' ? 2000 : 10_000),
      observedAt: '2026-09-10',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    }));
    const economics = readEconomics(rows);
    expect(economics.contributionPerUnit.known).toBe(true);
    if (economics.contributionPerUnit.known) {
      // A gated claim is an ESTIMATE, never a MEASURED result: a published
      // platform fee is a fact about the platform and nothing has charged us
      // one yet.
      expect(economics.contributionPerUnit.basis).toBe('ESTIMATE');
    }
  });

  /**
   * The direction that matters.
   *
   * Twelve of thirteen inputs and one blank derives *nothing*. §30 records the
   * correction at the opportunity card: a margin computed against an unknown
   * cost fails in the direction that makes a piece look worth doing, which is
   * the shape of error nobody notices because it looks like ambition.
   */
  it('withholds the contribution entirely when one input is unknown', () => {
    for (const missing of REQUIRED_FOR_MARGIN) {
      const rows = REQUIRED_FOR_MARGIN.filter((kind) => kind !== missing).map((kind, index) => ({
        id: `cev_${index}`,
        projectId,
        propositionId: 'cpr_1',
        channelId: null,
        kind,
        statement: 'a figure',
        origin: 'CLAIM' as const,
        sourceClaimId: `clm_${missing}_${index}`,
        testId: null,
        actorRef: null,
        ...figureFor(kind, kind === 'SELLING_PRICE' ? 2000 : 10_000),
        observedAt: '2026-09-10',
        createdAt: '2026-09-10T00:00:00.000Z',
        updatedAt: '2026-09-10T00:00:00.000Z',
      }));
      const economics = readEconomics(rows);
      expect(economics.contributionPerUnit.known, `${missing} was treated as zero`).toBe(false);
      if (!economics.contributionPerUnit.known) {
        expect(economics.contributionPerUnit.missing).toContain(missing);
      }
    }
  });

  it('refuses to clamp contradictory rates into a very thin margin', () => {
    const rows = REQUIRED_FOR_MARGIN.map((kind, index) => ({
      id: `cev_${index}`,
      projectId,
      propositionId: 'cpr_1',
      channelId: null,
      kind,
      statement: 'a figure',
      origin: 'CLAIM' as const,
      sourceClaimId: `clm_${index}`,
      testId: null,
      actorRef: null,
      // Three loss rates of 40% each sum past the whole price.
      ...figureFor(
        kind,
        kind === 'SELLING_PRICE'
          ? 2000
          : (['RETURN_RATE', 'REFUND_RATE', 'CHARGEBACK_RATE'] as string[]).includes(kind)
            ? 400_000
            : 10_000,
      ),
      observedAt: '2026-09-10',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    }));
    const economics = readEconomics(rows);
    expect(economics.contributionPerUnit.known).toBe(false);
    if (!economics.contributionPerUnit.known) {
      expect(economics.contributionPerUnit.why).toMatch(/contradiction/i);
    }
  });

  it('states every assumption the arithmetic rests on', () => {
    const economics = readEconomics([]);
    expect(economics.assumptions.length).toBeGreaterThanOrEqual(3);
    expect(economics.assumptions.join(' ')).toMatch(/returned, refunded or charged-back/i);
  });

  it('reports a measurement as measured and a published figure as an estimate', () => {
    expect(basisOf('TEST')).toBe('MEASURED');
    expect(basisOf('CLAIM')).toBe('ESTIMATE');
    expect(basisOf('PERSON')).toBe('ASSUMPTION');
  });

  it('takes the weakest basis, so one assumption makes the whole margin one', () => {
    const rows = REQUIRED_FOR_MARGIN.map((kind, index) => ({
      id: `cev_${index}`,
      projectId,
      propositionId: 'cpr_1',
      channelId: null,
      kind,
      statement: 'a figure',
      origin: kind === 'SELLING_PRICE' ? ('PERSON' as const) : ('CLAIM' as const),
      sourceClaimId: kind === 'SELLING_PRICE' ? null : `clm_${index}`,
      testId: null,
      actorRef: kind === 'SELLING_PRICE' ? userId : null,
      ...figureFor(kind, kind === 'SELLING_PRICE' ? 2000 : 10_000),
      observedAt: '2026-09-10',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    }));
    const economics = readEconomics(rows);
    expect(economics.contributionPerUnit.known).toBe(true);
    if (economics.contributionPerUnit.known) {
      expect(economics.contributionPerUnit.basis).toBe('ASSUMPTION');
    }
  });

  it('never lets an undated reading displace a dated one', () => {
    const base = {
      projectId,
      propositionId: 'cpr_1',
      channelId: null,
      kind: 'SELLING_PRICE' as const,
      statement: 'a price',
      origin: 'CLAIM' as const,
      testId: null,
      actorRef: null,
      ratePpm: null,
      days: null,
      countUnits: null,
      updatedAt: '2026-09-10T00:00:00.000Z',
    };
    const economics = readEconomics([
      { ...base, id: 'cev_1', sourceClaimId: 'a', amountMinor: 2000, observedAt: '2026-09-10', createdAt: '2026-09-10T00:00:00.000Z' },
      { ...base, id: 'cev_2', sourceClaimId: 'b', amountMinor: 9999, observedAt: null, createdAt: '2026-09-20T00:00:00.000Z' },
    ]);
    expect(economics.inputs.SELLING_PRICE?.value).toBe(2000);
  });
});

describe('the loop runs, and every round is an ordinary Russell candidate', () => {
  it('asks for the channels when there are none, and nothing else', async () => {
    await activated();
    const pass = await runCommerceKernel(projectId);
    expect(pass.opened.map((one) => one.purpose)).toEqual(['CHANNELS']);

    // It is a candidate, so it goes through the archive check, the compiler,
    // the envelope, the gate and all three audit roles like anything else.
    const candidates = await listCandidates({ projectId });
    expect(candidates.some((one) => one.id === pass.opened[0]!.candidateId)).toBe(true);
  });

  it('does not ask for the channels once a person has seeded one', async () => {
    await activated();
    await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    const pass = await runCommerceKernel(projectId);
    expect(pass.opened.map((one) => one.purpose)).not.toContain('CHANNELS');
    // It asks what the channel requires before it asks what sells on it: one
    // round settles every proposition on the channel at once.
    expect(pass.opened.map((one) => one.purpose)).toContain('ELIGIBILITY');
  });

  it('absorbs declared findings into rows, and settles the round with a count', async () => {
    await activated();
    await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    await runCommerceKernel(projectId);

    const candidate = await candidateFor('PRODUCTS');
    expect(candidate).toBeTruthy();
    await finishedRound({
      candidateId: candidate!,
      claims: [
        {
          claim: 'A gadget sells there',
          finding: 'PRODUCT_CANDIDATE',
          subject: 'A gadget',
          qualifier: 'A channel',
        },
        {
          claim: 'views only',
          finding: 'ATTENTION_EVIDENCE',
          subject: 'A gadget',
          count: 4_000_000,
        },
      ],
    });

    const pass = await runCommerceKernel(projectId);
    expect(pass.absorbed.propositions.length).toBe(1);
    expect(pass.absorbed.propositions[0]?.origin).toBe('DISCOVERED');
    expect(pass.absorbed.propositions[0]?.sourceClaimId).toBeTruthy();
    expect(pass.absorbed.settled.length).toBe(1);
    expect(pass.absorbed.settled[0]?.found).toBe(2);
  });

  it('refuses a product whose named channel is not on the map, rather than creating one', async () => {
    await activated();
    await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    await runCommerceKernel(projectId);
    const candidate = await candidateFor('ELIGIBILITY');
    expect(candidate).toBeTruthy();

    await finishedRound({
      candidateId: candidate!,
      claims: [
        {
          claim: 'A gadget sells somewhere else',
          finding: 'PRODUCT_CANDIDATE',
          subject: 'A gadget',
          qualifier: 'A channel that is not on the map',
        },
      ],
    });
    const pass = await runCommerceKernel(projectId);
    /*
     * The ELIGIBILITY round names a channel, so the round's own channel is the
     * fallback and the proposition is created against it. What must never
     * happen is a *channel* arriving as a side effect of a product — a channel
     * with nothing establishing that it is one.
     */
    expect(pass.absorbed.channels.length).toBe(0);
    expect((await listChannels(projectId)).length).toBe(1);
  });

  it('carries the allocator’s reason onto the event it produced', async () => {
    await activated();
    const pass = await runCommerceKernel(projectId);
    const events = await listCashEvents(projectId, 50);
    const opened = events.find((one) => one.kind === 'COMMERCE_ROUND_OPENED');
    expect(JSON.stringify(opened?.detail)).toContain(pass.opened[0]!.why);
  });

  it('is bounded by how many questions may be open at once, not by a quota', async () => {
    await activated();
    for (const name of ['One', 'Two', 'Three', 'Four', 'Five']) {
      await seedChannel({ projectId, name, actorRef: userId });
    }
    await runCommerceKernel(projectId);
    const open = (await listCommerceRounds(projectId)).filter((one) => one.state === 'OPEN');
    expect(open.length).toBeLessThanOrEqual(3);
    const state = await snapshot(projectId);
    // What it did not ask is reported with a reason a person can read, rather
    // than silently dropped.
    expect(planFrom(state).declined.some((one) => one.why.includes('no free slot'))).toBe(true);
  });

  it('opens nothing once the sprint is wound down, and still absorbs what ran', async () => {
    await activated();
    await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    await runCommerceKernel(projectId);
    const candidate = await candidateFor('PRODUCTS');

    const mode = await getCashMode(projectId);
    await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: 'the sprint is ending',
    });
    expect(mode).toBeTruthy();

    await finishedRound({
      candidateId: candidate!,
      claims: [
        {
          claim: 'A gadget sells there',
          finding: 'PRODUCT_CANDIDATE',
          subject: 'A gadget',
          qualifier: 'A channel',
        },
      ],
    });
    const pass = await runCommerceKernel(projectId);
    // Filing what research already found is not new discovery: the spending
    // happened when it ran.
    expect(pass.absorbed.propositions.length).toBe(1);
    expect(pass.opened.length).toBe(0);
    expect(pass.declined[0]?.why).toBeTruthy();
  });

  it('classifies a commerce round as discovery work the wind-down guard stops', async () => {
    await activated();
    const pass = await runCommerceKernel(projectId);
    const candidateId = pass.opened[0]!.candidateId;
    const active = await getCashMode(projectId);
    expect(await launchableUnderCashMode({ candidateId, mode: active })).toBe(true);

    await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: 'the sprint is ending',
    });
    const wound = await getCashMode(projectId);
    expect(await launchableUnderCashMode({ candidateId, mode: wound })).toBe(false);
  });
});

describe('the bounded test prepares, and names exactly what is missing', () => {
  async function qualified(): Promise<string> {
    await activated();
    const channel = await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    const seeded = await seedProposition({
      projectId,
      channelId: channel.channel.id,
      product: 'A gadget',
      supplier: 'A supplier',
      actorRef: userId,
    });
    const propositionId = seeded!.proposition.id;
    await recordEvidence({
      projectId,
      propositionId,
      kind: 'PURCHASE_EVIDENCE',
      statement: '40 units sold',
      origin: 'PERSON',
      actorRef: userId,
      countUnits: 40,
      observedAt: '2026-09-10',
    });
    for (const one of fullEconomics('A gadget', 'A channel')) {
      await recordEvidence({
        projectId,
        propositionId,
        kind: one.finding,
        statement: one.claim,
        origin: 'PERSON',
        actorRef: userId,
        amountMinor: one.amountMinor ?? null,
        ratePpm: one.ratePpm ?? null,
        observedAt: '2026-09-10',
      });
    }
    return propositionId;
  }

  it('blocks on the commercial grant before it looks at capability', async () => {
    const propositionId = await qualified();
    await runCommerceKernel(projectId);

    const tests = await listTests(projectId);
    expect(tests.length).toBe(1);
    expect(tests[0]?.propositionId).toBe(propositionId);
    expect(tests[0]?.state).toBe('BLOCKED');
    /*
     * Deny-by-default asks *may this happen* before *could this happen*.
     * Asking the capability first would mean discovering that Brain could list
     * something it was never authorized to sell, which is a fact nobody should
     * learn by nearly doing it.
     */
    expect(tests[0]?.blockerKind).toBe('NO_COMMERCIAL_AUTHORITY');
    expect(tests[0]?.blockerDetail).toMatch(/commercial action/i);
  });

  it('states a stopping rule derived from the piece’s own break-even', async () => {
    await qualified();
    await runCommerceKernel(projectId);
    const tests = await listTests(projectId);
    expect(tests[0]?.stopRule).toMatch(/ceiling/);
    expect(tests[0]?.stopRule).toMatch(/per order/);
  });

  it('does not prepare a test for a piece with attention and no purchase', async () => {
    await activated();
    const channel = await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    const seeded = await seedProposition({
      projectId,
      channelId: channel.channel.id,
      product: 'A watched gadget',
      actorRef: userId,
    });
    await recordEvidence({
      projectId,
      propositionId: seeded!.proposition.id,
      kind: 'ATTENTION_EVIDENCE',
      statement: 'views',
      origin: 'PERSON',
      actorRef: userId,
      countUnits: 9_000_000,
      observedAt: '2026-09-10',
    });
    await runCommerceKernel(projectId);
    expect((await listTests(projectId)).length).toBe(0);
  });

  it('is idempotent: a blocker that has not changed writes no second row', async () => {
    await qualified();
    await runCommerceKernel(projectId);
    await runCommerceKernel(projectId);
    await runCommerceKernel(projectId);
    expect((await listTests(projectId)).length).toBe(1);
    const events = await listCashEvents(projectId, 200);
    expect(events.filter((one) => one.kind === 'COMMERCE_TEST_PREPARED').length).toBe(1);
  });

  it('refuses to write an authorized test with no grant and no person behind it', async () => {
    const propositionId = await qualified();
    const { openTest } = await import('../server/repos/commerce.ts');
    /*
     * The CHECK is the mechanism rather than the calling code's discipline: a
     * future caller that forgot to pass a grant fails the insert rather than
     * silently creating an authorized spend nobody made.
     */
    await expect(
      openTest({
        projectId,
        propositionId,
        state: 'AUTHORIZED',
        ceilingMinor: 50_000,
        stopRule: 'the ceiling',
      }),
    ).rejects.toThrow();
  });
});

describe('the self-expansion pass raises what is missing before it is needed', () => {
  it('raises a need for the integration a bounded test would require', async () => {
    await activated();
    const channel = await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    const seeded = await seedProposition({
      projectId,
      channelId: channel.channel.id,
      product: 'A gadget',
      supplier: 'A supplier',
      actorRef: userId,
    });
    await recordEvidence({
      projectId,
      propositionId: seeded!.proposition.id,
      kind: 'PURCHASE_EVIDENCE',
      statement: '40 units sold',
      origin: 'PERSON',
      actorRef: userId,
      countUnits: 40,
      observedAt: '2026-09-10',
    });
    for (const one of fullEconomics('A gadget', 'A channel')) {
      await recordEvidence({
        projectId,
        propositionId: seeded!.proposition.id,
        kind: one.finding,
        statement: one.claim,
        origin: 'PERSON',
        actorRef: userId,
        amountMinor: one.amountMinor ?? null,
        ratePpm: one.ratePpm ?? null,
        observedAt: '2026-09-10',
      });
    }

    const pass = await runCommerceKernel(projectId);
    const raised = pass.capabilities.raised.map((one) => one.capability);
    expect(raised).toContain('PUBLISH_A_LISTING');
    expect(raised).toContain('TAKE_A_PAYMENT');
    // Every need names a remedy: a need with no way forward is an escalation
    // with no answering transition.
    for (const entry of pass.capabilities.raised) expect(entry.needId).toBeTruthy();
  });

  it('adds one need per capability however many ticks run', async () => {
    await activated();
    const channel = await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    const seeded = await seedProposition({
      projectId,
      channelId: channel.channel.id,
      product: 'A gadget',
      supplier: 'A supplier',
      actorRef: userId,
    });
    await recordEvidence({
      projectId,
      propositionId: seeded!.proposition.id,
      kind: 'PURCHASE_EVIDENCE',
      statement: 'sold',
      origin: 'PERSON',
      actorRef: userId,
      countUnits: 40,
      observedAt: '2026-09-10',
    });
    for (const one of fullEconomics('A gadget', 'A channel')) {
      await recordEvidence({
        projectId,
        propositionId: seeded!.proposition.id,
        kind: one.finding,
        statement: one.claim,
        origin: 'PERSON',
        actorRef: userId,
        amountMinor: one.amountMinor ?? null,
        ratePpm: one.ratePpm ?? null,
        observedAt: '2026-09-10',
      });
    }
    const first = await runCommerceKernel(projectId);
    const second = await runCommerceKernel(projectId);
    /*
     * The property is idempotency, not the count.
     *
     * Three capabilities are due here — listing, taking payment, and reaching
     * a supplier — and what matters is that a second pass adds no row. A loop
     * that derives a need every tick must add one entry to the review, not one
     * per tick, which is the card §33 deleted arriving at a different table.
     */
    expect(first.capabilities.raised.length).toBeGreaterThan(0);
    const ids = new Set([
      ...first.capabilities.raised.map((one) => one.needId),
      ...second.capabilities.raised.map((one) => one.needId),
    ]);
    expect(ids.size).toBe(first.capabilities.raised.length);
    expect(second.capabilities.raised.map((one) => one.needId).sort()).toEqual(
      first.capabilities.raised.map((one) => one.needId).sort(),
    );
  });

  it('raises nothing on a sprint that has found nothing', async () => {
    await activated();
    const pass = await runCommerceKernel(projectId);
    expect(pass.capabilities.raised.length).toBe(0);
    // Reported as missing rather than silently skipped: "we have not got this"
    // and "nobody has asked" are different facts.
    expect(pass.capabilities.missing.length).toBeGreaterThan(0);
  });
});

describe('what the view says, and what it refuses to say', () => {
  it('reports no aggregate maturity score anywhere', async () => {
    await activated();
    const view = await commerceView(projectId);
    const keys = Object.keys(view.maturity);
    for (const forbidden of ['percent', 'score', 'progress', 'completion', 'readiness']) {
      expect(keys.some((key) => key.toLowerCase().includes(forbidden))).toBe(false);
    }
  });

  it('says plainly that nothing has been measured, while nothing has', async () => {
    await activated();
    const view = await commerceView(projectId);
    expect(view.maturity.measurement).toMatch(/Nothing here has been measured/);
    expect(view.maturity.measurement).toMatch(/estimate about our economics/);
  });

  it('reports a withheld contribution as withheld rather than as zero', async () => {
    await activated();
    const channel = await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    await seedProposition({
      projectId,
      channelId: channel.channel.id,
      product: 'A gadget',
      actorRef: userId,
    });
    const view = await commerceView(projectId);
    const piece = view.all[0]!;
    expect(piece.contribution).toBeNull();
    expect(piece.contributionWithheld).toMatch(/withheld/);
    expect(piece.breakEvenAcquisition).toBeNull();
    expect(piece.unknown.length).toBe(REQUIRED_FOR_MARGIN.length);
  });

  it('says what would change a ranking, which is the half that is useful', async () => {
    await activated();
    const channel = await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    await seedProposition({
      projectId,
      channelId: channel.channel.id,
      product: 'A gadget',
      actorRef: userId,
    });
    const view = await commerceView(projectId);
    expect(view.all[0]!.wouldChange.length).toBeGreaterThan(0);
    expect(view.all[0]!.wouldChange.join(' ')).toMatch(/published purchase/i);
  });

  it('shows at most five best and keeps every one of them in the full list', async () => {
    await activated();
    const channel = await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    for (const product of ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven']) {
      await seedProposition({
        projectId,
        channelId: channel.channel.id,
        product,
        actorRef: userId,
      });
    }
    const view = await commerceView(projectId);
    expect(view.best.length).toBe(5);
    expect(view.all.length).toBe(7);
    // The cut is on the display, not on the derivation.
    expect(view.all.slice(0, 5).map((one) => one.id)).toEqual(view.best.map((one) => one.id));
  });

  it('names a seeded channel as seeded, so the one person-made row is visible', async () => {
    await activated();
    await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    const view = await commerceView(projectId);
    expect(view.channels[0]?.seeded).toBe(true);
  });
});

describe('the envelopes and profiles authorize reading and nothing else', () => {
  it('registers a compiler profile for each commerce envelope', () => {
    for (const id of ['RUSSELL_COMMERCE_DEMAND_V1', 'RUSSELL_COMMERCE_ECONOMICS_V1']) {
      expect(getApprovalEnvelope(id), `${id} is not defined`).toBeTruthy();
      expect(profileFor(id), `${id} has no profile`).toBeTruthy();
    }
  });

  /**
   * The envelopes take their permissions from the discovery envelope verbatim.
   *
   * That is what makes "it authorizes no effect discovery did not already
   * authorize" a property rather than a claim in a comment: the same source
   * classes, the same forbidden actions, the same floor. Only the assignment
   * differs, which is why they are separate envelopes at all.
   */
  it('authorizes exactly what the discovery envelope authorizes', () => {
    const discovery = getApprovalEnvelope('RUSSELL_CASH_DISCOVERY_V1')!;
    for (const id of ['RUSSELL_COMMERCE_DEMAND_V1', 'RUSSELL_COMMERCE_ECONOMICS_V1']) {
      const envelope = getApprovalEnvelope(id)!;
      expect(envelope.forbiddenActions.source).toBe(discovery.forbiddenActions.source);
      expect(envelope.allowedSourceTypes.source).toBe(discovery.allowedSourceTypes.source);
      expect(envelope.minIndependentSourcesFloor).toBe(discovery.minIndependentSourcesFloor);
      expect(envelope.assignmentTemplate).not.toBe(discovery.assignmentTemplate);
    }
  });

  /**
   * The separation lives in the lanes, not only in a column.
   *
   * The gate applies the bar per lane, so a demand lane that attention could
   * satisfy would let a fragment clear its bar on view counts and be reported
   * as having established demand.
   */
  it('keeps purchase and attention as two lanes with purchase required', () => {
    const profile = profileFor('RUSSELL_COMMERCE_DEMAND_V1')!;
    const purchase = profile.lanes.find((one) => one.id === 'purchase');
    const attention = profile.lanes.find((one) => one.id === 'attention');
    expect(purchase?.necessity).toBe('REQUIRED');
    expect(attention?.necessity).toBe('CONDITIONAL');
    expect(purchase?.description).toMatch(/view count is not this/i);
  });

  it('requires two independent publishers for the rates that decide a margin', () => {
    const profile = profileFor('RUSSELL_COMMERCE_ECONOMICS_V1')!;
    const leakage = profile.lanes.find((one) => one.id === 'leakage');
    expect(leakage?.necessity).toBe('REQUIRED');
    // §14: the standard depends on what is being claimed. A category-level
    // rate is not a fact about one transaction, and it is the line most likely
    // to turn a positive margin negative.
    expect(leakage?.evidenceKind).toBe('GENERALIZED_ECONOMICS');
  });

  /**
   * Every round's required lane is one its own question can satisfy.
   *
   * The defect this pins was found by running the kernel rather than by
   * reading it: every non-economics round compiled under the demand envelope,
   * whose required lane is `purchase` — so an eligibility question about what
   * a platform requires of a seller carried a required lane a terms page can
   * never satisfy. A worker would have answered correctly and the fragment
   * would have been blocked, which is §25's *wrong answer confidently derived*
   * arriving through a lane rather than through a scope.
   *
   * Asserted as a pairing rather than as five examples, so a purpose added
   * later without an envelope is a visible absence rather than a silent
   * fall-through to whichever envelope is listed last.
   */
  it('gives every round purpose a required lane its own question produces', () => {
    const expected: Record<string, { envelope: string; lane: string }> = {
      CHANNELS: { envelope: 'RUSSELL_COMMERCE_TERMS_V1', lane: 'channel_terms' },
      ELIGIBILITY: { envelope: 'RUSSELL_COMMERCE_TERMS_V1', lane: 'channel_terms' },
      PRODUCTS: { envelope: 'RUSSELL_COMMERCE_DEMAND_V1', lane: 'purchase' },
      SUPPLY: { envelope: 'RUSSELL_COMMERCE_SUPPLY_V1', lane: 'supply' },
      ECONOMICS: { envelope: 'RUSSELL_COMMERCE_ECONOMICS_V1', lane: 'cost' },
    };
    for (const purpose of COMMERCE_ROUND_PURPOSES) {
      const pairing = expected[purpose];
      expect(pairing, `${purpose} names no envelope`).toBeTruthy();
      const profile = profileFor(pairing!.envelope);
      expect(profile, `${pairing!.envelope} has no profile`).toBeTruthy();
      const lane = profile!.lanes.find((one) => one.id === pairing!.lane);
      expect(lane?.necessity, `${purpose} requires a lane it cannot fill`).toBe('REQUIRED');
    }
  });

  /**
   * The four demand-side envelopes differ in their completion standard and in
   * nothing else.
   *
   * That is what makes "none of them authorizes anything another does not" a
   * property rather than a sentence in a comment: the permissions and the
   * template are shared by reference, so they cannot drift apart.
   */
  it('shares one template and one set of permissions across the reading envelopes', () => {
    const demand = getApprovalEnvelope('RUSSELL_COMMERCE_DEMAND_V1')!;
    for (const id of ['RUSSELL_COMMERCE_TERMS_V1', 'RUSSELL_COMMERCE_SUPPLY_V1']) {
      const envelope = getApprovalEnvelope(id)!;
      expect(envelope.assignmentTemplate).toBe(demand.assignmentTemplate);
      expect(envelope.forbiddenActions.source).toBe(demand.forbiddenActions.source);
      expect(envelope.allowedSourceTypes.source).toBe(demand.allowedSourceTypes.source);
      // And the profiles genuinely differ, or there was no reason to split.
      expect(profileFor(id)!.completionCriteria('a market')).not.toEqual(
        profileFor('RUSSELL_COMMERCE_DEMAND_V1')!.completionCriteria('a market'),
      );
    }
  });

  it('forbids every acting verb in both assignment templates', () => {
    for (const id of ['RUSSELL_COMMERCE_DEMAND_V1', 'RUSSELL_COMMERCE_ECONOMICS_V1']) {
      const template = getApprovalEnvelope(id)!.assignmentTemplate!;
      expect(template).toMatch(/Out of scope/);
      expect(template).toMatch(/read-only|reading/i);
      for (const verb of ['advertis', 'listing', 'contact']) {
        expect(template.toLowerCase(), `${id} does not forbid ${verb}`).toContain(verb);
      }
    }
  });
});

describe('rows, not prose', () => {
  it('stores no stage, no margin and no rank', () => {
    const migration = readFileSync('server/db/migrations/074_commerce_kernel.sql', 'utf8');
    for (const column of ['stage', 'margin', 'contribution', 'rank', 'score', 'basis']) {
      expect(
        new RegExp(`^\\s+${column}\\s+(TEXT|INTEGER|REAL)`, 'im').test(migration),
        `${column} is stored and should be derived`,
      ).toBe(false);
    }
  });

  it('carries seq on every table in the Postgres half', () => {
    const pg = readFileSync('server/db/pg-migrations/065_commerce_kernel.sql', 'utf8');
    const tables = pg.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) ?? [];
    expect(tables.length).toBe(5);
    // §25 and §27 both record what its absence costs: a tiebreak on a column
    // only one dialect has passes the whole SQLite suite and throws in
    // production.
    expect((pg.match(/^\s+seq\s+BIGSERIAL/gm) ?? []).length).toBe(tables.length);
  });

  it('keeps every reading with its own provenance and nobody else’s', async () => {
    await activated();
    const channel = await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    const seeded = await seedProposition({
      projectId,
      channelId: channel.channel.id,
      product: 'A gadget',
      actorRef: userId,
    });
    await expect(
      recordEvidence({
        projectId,
        propositionId: seeded!.proposition.id,
        kind: 'SELLING_PRICE',
        statement: 'a price',
        // A claim row carrying a test id would be a measurement wearing a
        // citation. The schema refuses it.
        origin: 'CLAIM',
        testId: 'cts_invented',
        amountMinor: 1999,
      }),
    ).rejects.toThrow();
  });

  it('attaches a reading to exactly one of a proposition and a channel', async () => {
    await activated();
    const channel = await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    const seeded = await seedProposition({
      projectId,
      channelId: channel.channel.id,
      product: 'A gadget',
      actorRef: userId,
    });
    await expect(
      recordEvidence({
        projectId,
        propositionId: seeded!.proposition.id,
        channelId: channel.channel.id,
        kind: 'SELLING_PRICE',
        statement: 'a price',
        origin: 'PERSON',
        actorRef: userId,
        amountMinor: 1999,
      }),
    ).rejects.toThrow();
  });

  it('reads a channel’s terms for every proposition on it', async () => {
    await activated();
    const channel = await seedChannel({ projectId, name: 'A channel', actorRef: userId });
    const seeded = await seedProposition({
      projectId,
      channelId: channel.channel.id,
      product: 'A gadget',
      actorRef: userId,
    });
    await recordEvidence({
      projectId,
      channelId: channel.channel.id,
      kind: 'PLATFORM_FEE',
      statement: 'the platform takes 8%',
      origin: 'PERSON',
      actorRef: userId,
      ratePpm: 80_000,
    });
    const state = await snapshot(projectId);
    const reading = state.readings.find((one) => one.proposition.id === seeded!.proposition.id);
    // A platform's commission is a fact about the channel rather than about
    // any one product sold on it, established once and read by every product.
    expect(reading?.economics.inputs.PLATFORM_FEE?.value).toBe(80_000);
    expect((await listEvidenceForProject(projectId)).length).toBe(1);
  });
});

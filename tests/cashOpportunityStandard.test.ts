/**
 * What is an opportunity, and what is a question for a person.
 *
 * ---------------------------------------------------------------------------
 * The two defects this file is written from
 * ---------------------------------------------------------------------------
 *
 * Production reached thirty-one "openings", two being qualified, none complete
 * and none ready — and every one of the thirty-one was market evidence. Rev
 * and GoTranscript's published per-minute prices. WriterAccess and Verblio's
 * published per-word rates. Adobe Stock and Depositphotos subscription tiers.
 * FIFA and Coachella resale *asking* prices. Sneaker and trading-card spreads
 * from tracked historical sales. Two domain appraisals above their asking
 * price. GitHub's open bug-bounty programme. Copart and IAA broker access.
 * Freelancer.com's listing page. Three government procurement notices.
 *
 * Each is a real, gated, well-sourced finding, and none of them says anybody
 * would pay *us*. The bridge promoted an accepted claim to a user-facing
 * opportunity because it carried an `opportunity_signal`, and that is the
 * defect: a signal says what a source established, not that there is work.
 *
 * Beside it, the same page offered five "decisions" standing for ninety-eight
 * underlying items — a payer here, a price there, an exposure on a third —
 * with a *mark all thirty done* control over facts Brain had not established
 * and was at that moment out researching.
 *
 * ---------------------------------------------------------------------------
 * The examples are regression cases and are not the boundary
 * ---------------------------------------------------------------------------
 *
 * A list of forbidden phrases would catch these ten and nothing else. §27
 * records what happens to a closed list that has to be complete over ordinary
 * English: four widenings, each adding the one word the last production
 * message was declined for. So the rule here is keyed on `opportunity_signal`,
 * a closed vocabulary chosen by a worker that read the source, and the cases
 * below are *instances* of it rather than entries in it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getDb } from '../server/db/database.ts';
import {
  createOpportunity,
  getOpportunity,
  listOpportunities,
  updateOpportunity,
} from '../server/repos/cashPortfolio.ts';
import { cardFact, recordCardFact } from '../server/repos/cashCardFacts.ts';
import { cashEngineCard } from '../server/services/cash/engineCard.ts';
import { evidenceCard, fieldOwner, readyToTest } from '../server/services/cash/card.ts';
import {
  CAPTURE_KEY,
  cashTier,
  qualificationKeys,
  SIGNAL_MEANING,
  UNIVERSAL_QUALIFICATION,
} from '../server/services/cash/tier.ts';
import { assemble, rank } from '../server/services/cash/portfolio.ts';
import { compressedReview, RESEARCHED_FIELDS } from '../server/services/cash/review.ts';
import { cashView } from '../server/services/cash/view.ts';
import { fillCard, markReady } from '../server/services/cash/opportunities.ts';
import { reconcileOpportunitySignals } from '../server/services/cash/discovery.ts';
import {
  createFragments,
  createOrchestration,
  insertClaims,
} from '../server/repos/research.ts';
import { createRun } from '../server/repos/runs.ts';
import { listLayers } from '../server/repos/layers.ts';
import { cashPosition } from '../server/services/cash/money.ts';
import { FIELD_BY_LANE } from '../server/services/cash/validation.ts';
import { COLUMN } from '../server/services/cash/answers.ts';
import { profileFor } from '../server/services/russell/compilerProfiles.ts';
import { cashReadiness } from '../server/services/cash/readiness.ts';
import { createAccount, createRoutine } from '../server/repos/fleet.ts';
import { createWorker } from '../server/repos/identity.ts';
import type { CashOpportunity, OpportunitySignal } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `standard-${Date.now()}@example.com`,
    displayName: 'The owner',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  });
  userId = user.id;
  const started = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(started.ok).toBe(true);
  cashModeId = started.ok ? started.mode.id : '';
});

/**
 * One harvested piece, exactly as `harvest` writes one.
 *
 * Signal, source and observation date, and **nothing else** — no payer, no
 * offer, no price, no delivery path. That is what a promotion from an accepted
 * claim actually produces, and building the fixture any other way would test a
 * shape production never has.
 */
async function harvested(
  signal: OpportunitySignal,
  title: string,
): Promise<CashOpportunity> {
  const created = await createOpportunity({
    projectId,
    cashModeId,
    ownerUserId: userId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`,
    opportunitySignal: signal,
    source: 'A publisher',
  });
  const withSignal = await updateOpportunity(created.id, {
    buying_signal: title,
    signal_observed_at: '2026-09-15',
  });
  return withSignal ?? created;
}

async function answer(
  opportunity: CashOpportunity,
  field: string,
  value = `An answer to ${field}.`,
): Promise<void> {
  await recordCardFact({
    projectId,
    opportunityId: opportunity.id,
    field,
    kind: 'EVIDENCE',
    value,
    claimId: `clm_${field}`,
    decidedBy: 'BRAIN',
  });
}

async function tierOf(id: string) {
  const opportunity = (await getOpportunity(id))!;
  const facts = await (
    await import('../server/repos/cashCardFacts.ts')
  ).cardFactsFor(opportunity.id);
  return cashTier({
    opportunity,
    card: cashEngineCard({ opportunity, facts }),
    readiness: evidenceCard(opportunity).readiness,
  });
}

// ---------------------------------------------------------------------------
// 1-5 — the five shapes of market evidence that were being sold as openings
// ---------------------------------------------------------------------------

describe('market evidence stays a signal', () => {
  /**
   * Each case is a real production record, reduced to the fact that made it
   * one: a signal with a source and a date, and nothing establishing that
   * anybody would pay us. None of these asserts on a word in the title.
   */
  const cases: { signal: OpportunitySignal; title: string; why: string }[] = [
    {
      signal: 'PRICING_OR_INFORMATION_ASYMMETRY',
      title:
        'Rev.com publishes a per-minute price of $1.99 for its human transcription service.',
      why: 'a vendor’s published selling price is what that vendor charges',
    },
    {
      signal: 'RESALABLE_ASSET_OPENING',
      title:
        'On FIFA’s Official Resale Marketplace a Category 3 final seat was listed at $6,730.',
      why: 'an asking price is not a completed sale',
    },
    {
      signal: 'RESALABLE_ASSET_OPENING',
      title: 'Appraise.net’s retail appraisal for VJN.com was $55,000-$85,000, above its $39,000 asking price.',
      why: 'an appraisal is not liquidity and is not an identified buyer',
    },
    {
      signal: 'PAID_TASK_OR_CONTRACT',
      title: 'GitHub operates an open, continuously-accepting public bug-bounty programme.',
      why: 'a general bounty programme is not a specific solvable bounty',
    },
    {
      signal: 'PAID_TASK_OR_CONTRACT',
      title: 'Freelancer.com’s software-development listing page showed 95 open projects.',
      why: 'a generic marketplace page is not a specific paid opening',
    },
  ];

  for (const one of cases) {
    it(`stays a signal: ${one.why}`, async () => {
      const piece = await harvested(one.signal, one.title);
      const reading = await tierOf(piece.id);
      expect(reading.tier).toBe('SIGNAL');
      // And it says what its evidence does establish, so nothing is thrown away.
      expect(reading.establishes).toBe(SIGNAL_MEANING[one.signal].establishes);
      expect(reading.doesNotEstablish).toBe(SIGNAL_MEANING[one.signal].doesNotEstablish);
      // The one thing that would move it is named, and it is Brain's to answer.
      expect(reading.toAdvance.map((r) => r.key)).toEqual([CAPTURE_KEY]);
      expect(reading.toAdvance[0]!.owner).not.toBe('PERSON_ONLY');
    });
  }

  it('is not a keyword filter: the identical sentence qualifies once somebody would pay for it', async () => {
    /*
     * The same title, the same signal, the same source. What changes is that
     * research established a payer and something to supply them, which is the
     * only thing that ever separates the two. A rule that read the sentence
     * could not tell these apart; this one never reads it.
     */
    const piece = await harvested(
      'PRICING_OR_INFORMATION_ASYMMETRY',
      'Rev.com publishes a per-minute price of $1.99 for its human transcription service.',
    );
    expect((await tierOf(piece.id)).tier).toBe('SIGNAL');

    await answer(piece, CAPTURE_KEY);
    const after = await tierOf(piece.id);
    expect(after.tier).toBe('CANDIDATE');
    // And it says what is still open, which is what a candidate owes.
    expect(after.toAdvance.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6-7 — what a job needs before it is a business, and what actually qualifies
// ---------------------------------------------------------------------------

describe('a job that pays is not yet an opportunity', () => {
  it('will not qualify a specific paid task without a fulfilment and economic thesis', async () => {
    const piece = await harvested(
      'PAID_TASK_OR_CONTRACT',
      'A Freelancer.com client posted a fixed-price request for a corporate five-page WordPress build.',
    );
    // Everything except how the work gets done, whether calling is required,
    // and whether the machinery would serve a second customer.
    const held = new Set(['fulfilmentModel', 'phoneDependency', 'scalingLever']);
    for (const key of [CAPTURE_KEY, ...qualificationKeys('PAID_TASK_OR_CONTRACT')]) {
      if (!held.has(key)) await answer(piece, key);
    }
    const reading = await tierOf(piece.id);
    expect(reading.tier).toBe('CANDIDATE');
    expect(reading.toAdvance.map((r) => r.key).sort()).toEqual([...held].sort());
    // Repetition is a required question for this kind of evidence, and only
    // for the kinds where it decides something.
    expect(SIGNAL_MEANING.PAID_TASK_OR_CONTRACT.alsoRequires).toContain('scalingLever');
    expect(SIGNAL_MEANING.ACTIVE_BUYER_DEMAND.alsoRequires).toHaveLength(0);
  });

  it('advances when the buyer, the access, the fulfilment, the economics, the timing and the constraints are all supported', async () => {
    const piece = await harvested(
      'ACTIVE_BUYER_DEMAND',
      'A named buyer published that they want a two-week data migration, closing 2026-10-01.',
    );
    for (const key of [CAPTURE_KEY, ...qualificationKeys('ACTIVE_BUYER_DEMAND')]) {
      await answer(piece, key);
    }
    expect((await tierOf(piece.id)).tier).toBe('QUALIFIED');
  });

  it('refuses ready to test until the execution thesis is supported, not merely the short card', async () => {
    /*
     * The short card asks what a bounded *test* turns on. A piece can answer
     * all four of those while nothing says whether we are eligible, whether we
     * could acquire it, or whether the only route to the buyer is a telephone
     * call — and marking that ready is the favourable assumption arriving at
     * the last transition before somebody spends money.
     */
    const piece = await harvested('ACTIVE_BUYER_DEMAND', 'A named buyer published a request.');
    await updateOpportunity(piece.id, {
      payer: 'A named buyer',
      reachable_channel: 'Their published procurement portal',
      offer_scope: 'One migration, one scope',
      acceptance_condition: 'The data reconciles',
      price_cents: 400_000,
      delivery_method: 'Remote, through their portal',
      fulfillment_owner: 'Us, with a subcontractor for the extract',
      peak_funding_cents: 20_000,
    });
    expect(readyToTest((await getOpportunity(piece.id))!)).toBe(true);

    const refused = await markReady({ opportunityId: piece.id, actorRef: userId });
    expect(refused.ok).toBe(false);
    expect((await getOpportunity(piece.id))!.state).toBe('DISCOVERED');

    for (const key of [CAPTURE_KEY, ...qualificationKeys('ACTIVE_BUYER_DEMAND')]) {
      await answer(piece, key);
    }
    const allowed = await markReady({ opportunityId: piece.id, actorRef: userId });
    expect(allowed.ok).toBe(true);
    expect((await getOpportunity(piece.id))!.state).toBe('READY');
  });

  it('ranks the qualified piece that eats human hours below the one that does not', async () => {
    /*
     * §30 asks for manual gig work not to rank among the best merely because
     * it pays, and refuses a hard-coded automation percentage. This is the
     * honest form: contribution per published hour. Nothing is read from
     * anybody's prose and no automation is scored.
     */
    const byHand = await harvested('RECURRING_OUTSOURCED_WORK', 'Forty hours of it, by hand.');
    const machinery = await harvested('RECURRING_OUTSOURCED_WORK', 'Two hours of it, once set up.');
    await updateOpportunity(byHand.id, { price_cents: 100_000, peak_funding_cents: 0, human_hours: 40 });
    await updateOpportunity(machinery.id, { price_cents: 100_000, peak_funding_cents: 0, human_hours: 2 });
    for (const piece of [byHand, machinery]) {
      for (const key of [CAPTURE_KEY, ...qualificationKeys('RECURRING_OUTSOURCED_WORK')]) {
        await answer(piece, key);
      }
    }
    const pieces = await listOpportunities({ projectId });
    const tiers: Record<string, Awaited<ReturnType<typeof tierOf>>> = {};
    for (const one of pieces) tiers[one.id] = await tierOf(one.id);
    const order = rank(pieces, tiers).map((one) => one.id);
    expect(order.indexOf(machinery.id)).toBeLessThan(order.indexOf(byHand.id));
  });
});

// ---------------------------------------------------------------------------
// A bar has to have a way over it
// ---------------------------------------------------------------------------

describe('every question the tier asks has something that can answer it', () => {
  it('leaves no qualification question that nothing in the product can fill', async () => {
    /*
     * The defect this exists for: `recommendation` was required for
     * `QUALIFIED` and written by nothing — no lane mapped to it and
     * `proposeEngineTerms` did not propose it — so no piece could ever reach
     * the tier, whatever research found. A bar with no way over it is a park
     * rather than a standard, which this repository records at four other
     * altitudes, and the end-to-end deployment suite is what found it by
     * timing out waiting for a piece to become ready.
     *
     * So every key is held against the three things that can write one: a
     * validation lane, an opportunity column, or one of Brain's own proposals.
     * A key answered by none of those is unreachable by construction.
     */
    const byLane = new Set(Object.values(FIELD_BY_LANE));
    const byColumn = new Set(Object.keys(COLUMN));
    const proposed = new Set([
      'captureMechanism',
      'fulfilmentModel',
      'requiredCapital',
      'firstSteps',
      'bottleneck',
      'scalingLever',
      'confidence',
      'recommendation',
    ]);
    const unreachable = [CAPTURE_KEY, ...qualificationKeys(null)].filter(
      (key) => !byLane.has(key) && !byColumn.has(key) && !proposed.has(key),
    );
    expect(unreachable).toEqual([]);

    // And the list of proposals is the real one rather than a second copy: a
    // key named here that `proposeEngineTerms` never writes would make this
    // assertion true and the product still stuck.
    const source = await readFile('server/services/cash/validation.ts', 'utf8');
    for (const key of proposed) {
      expect(source).toContain(`field: '${key}'`);
    }
  });

  it('lets a person answer a question that has no column, and moves the tier', async () => {
    /*
     * `ENGINE_FIELDS` are `cash_card_facts` rows and nothing else, so before
     * the tier required them the bounded deep dive was the only writer — which
     * was fine while they were commentary and a dead end the moment they
     * became a gate. A person who knows what a job pays could not say so.
     */
    const piece = await harvested('ACTIVE_BUYER_DEMAND', 'A named buyer published a request.');
    expect((await tierOf(piece.id)).tier).toBe('SIGNAL');

    const filled = await fillCard({
      opportunityId: piece.id,
      actorRef: userId,
      patch: { captureMechanism: 'Supply the repair to the buyer who asked, and be paid.' },
    });
    expect(filled.ok).toBe(true);
    expect((await tierOf(piece.id)).tier).toBe('CANDIDATE');

    // A person's answer is a PERSON fact, so nothing automatic writes over it.
    const recorded = await cardFact(piece.id, CAPTURE_KEY);
    expect(recorded!.kind).toBe('PERSON');
    expect(recorded!.decidedBy).toBe(userId);

    // A blank is refused rather than recorded as an answer, because an empty
    // string would satisfy the tier while saying nothing.
    const blank = await fillCard({
      opportunityId: piece.id,
      actorRef: userId,
      patch: { eligibility: '   ' },
    });
    expect(blank.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8 — the records that already exist
// ---------------------------------------------------------------------------

describe('the records already written are re-evaluated, not rewritten', () => {
  it('reclassifies without deleting, duplicating or inventing an answer', async () => {
    const before: string[] = [];
    for (const one of [
      'Rev.com publishes a per-minute price of $1.99.',
      'Adobe Stock publishes a standard-license subscription at $29.99 a month.',
      'A Coachella weekend-one ticket was listed at $1,200.',
    ]) {
      before.push((await harvested('PRICING_OR_INFORMATION_ASYMMETRY', one)).id);
    }
    const db = getDb();
    const countBefore = Number(
      (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cash_opportunities'))?.n ?? 0,
    );

    const view = await cashView({ projectId });
    expect(view.myCurrentWork.byTier.SIGNAL).toBe(3);
    expect(view.myCurrentWork.byTier.CANDIDATE).toBe(0);
    expect(view.myCurrentWork.byTier.QUALIFIED).toBe(0);
    expect(view.myCurrentWork.byTier.READY_TO_TEST).toBe(0);

    // Nothing was added, nothing was removed, and every id is still there with
    // its own claim on it.
    const countAfter = Number(
      (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cash_opportunities'))?.n ?? 0,
    );
    expect(countAfter).toBe(countBefore);
    for (const id of before) {
      const row = await getOpportunity(id);
      expect(row).not.toBeNull();
      expect(row!.sourceClaimId).toBeTruthy();
      expect(row!.state).toBe('DISCOVERED');
    }
    // And no blank became an answer on the way through.
    for (const placement of view.myCurrentWork.placements) {
      expect(placement.opportunity.payer).toBeNull();
      expect(placement.opportunity.priceCents).toBeNull();
    }
  });

  it('reads the signal back from the source claim for a piece promoted before the column existed', async () => {
    /*
     * The thirty-one production records were promoted by a `harvest` that
     * mapped the signal to a mechanism and threw the signal away. The recovery
     * is guarded on the column still being null, so a recorded value is never
     * replaced by one read back afterwards.
     */
    const db = getDb();
    /*
     * A real orchestration, a real fragment and a claim written through the
     * repository, because the recovery reads a row `insertClaims` wrote and a
     * hand-built one would be testing the fixture.
     */
    const layer = (await listLayers(projectId))[0]!;
    const run = await createRun({
      projectId,
      layerId: layer.id,
      runType: 'FOUNDATION',
      status: 'PLANNED',
      provider: 'WORKER',
      prompt: 'where an asset with an asking price is published',
    });
    const orchestration = await createOrchestration({
      projectId,
      layerId: layer.id,
      runId: run.id,
      title: 'Which assets have published demand and a favourable spread',
      assignment: 'the published listings that answer it',
      provider: 'WORKER',
      autoApprove: false,
    });
    const [fragment] = await createFragments([
      {
        orchestrationId: orchestration.id,
        projectId,
        layerId: layer.id,
        fragmentIndex: 0,
        fragmentKey: 'market-opening',
        question: 'Which assets have a published asking price and published demand above it?',
        geography: 'United States',
        requiredEvidence: [
          { id: 'demand_signal', description: 'the published listing', necessity: 'REQUIRED' },
        ],
        acceptableSourceTypes: ['a marketplace, job board, classified or auction listing'],
        excludedSourceTypes: ['a claim with no locatable source at all'],
        completionCriteria: ['a quoted published listing with its date'],
        minIndependentSources: 1,
        maxRepairs: 2,
        dependsOn: [],
        attempt: 1,
      },
    ] as unknown as Parameters<typeof createFragments>[0]);
    const [claim] = await insertClaims([
      {
        orchestrationId: orchestration.id,
        fragmentId: fragment!.id,
        passId: null,
        passKey: 'TARGETED',
        claim: 'An asset with an asking price.',
        sourceUrl: 'https://example.com/a',
        sourceTitle: 'A listing',
        sourcePublisher: 'A marketplace',
        sourceDate: '2026-09-15',
        evidenceExcerpt: 'listed at $6,730',
        evidenceLocator: 'the listing page',
        evidenceLane: 'demand_signal',
        opportunitySignal: 'RESALABLE_ASSET_OPENING',
        retrievedAt: '2026-09-15T00:00:00.000Z',
        confidence: 0.9,
        validationState: 'SOURCED',
        validationDetail: null,
        sourced: true,
        accepted: true,
        contentHash: 'a'.repeat(64),
      },
    ]);
    const piece = await harvested('RESALABLE_ASSET_OPENING', 'An asset with an asking price.');
    await db.run('UPDATE cash_opportunities SET source_claim_id = ? WHERE id = ?', [
      claim!.id,
      piece.id,
    ]);
    await db.run('UPDATE cash_opportunities SET opportunity_signal = NULL WHERE id = ?', [piece.id]);
    expect((await getOpportunity(piece.id))!.opportunitySignal).toBeNull();

    const filled = await reconcileOpportunitySignals(projectId);
    expect(filled).toContain(piece.id);
    expect((await getOpportunity(piece.id))!.opportunitySignal).toBe('RESALABLE_ASSET_OPENING');

    // Run twice: it fills a blank and never replaces a recorded value.
    await db.run('UPDATE cash_opportunities SET opportunity_signal = ? WHERE id = ?', [
      'ACTIVE_BUYER_DEMAND',
      piece.id,
    ]);
    expect(await reconcileOpportunitySignals(projectId)).not.toContain(piece.id);
    expect((await getOpportunity(piece.id))!.opportunitySignal).toBe('ACTIVE_BUYER_DEMAND');
  });
});

// ---------------------------------------------------------------------------
// 9-10 — whose question is whose
// ---------------------------------------------------------------------------

describe('Brain researches facts and a person decides person-only things', () => {
  it('never turns a researchable blank into a decision for a person', async () => {
    const pieces = [];
    for (let i = 0; i < 30; i += 1) {
      pieces.push(await harvested('ACTIVE_BUYER_DEMAND', `An opening number ${i}.`));
    }
    const view = await cashView({ projectId });
    for (const item of view.decisionsForMe.items) {
      expect(item.key.startsWith('MISSING_')).toBe(false);
      expect(item.answer.kind).not.toBe('FILL_CARD_FIELD');
      expect(item.answer.label).not.toMatch(/Mark all \d+ done/);
    }
    expect(pieces).toHaveLength(30);
    // Thirty signals produce no decisions at all beyond the one grant.
    expect(view.decisionsForMe.items.map((one) => one.key)).toEqual(['AUTHORITY']);
  });

  it('keeps a genuine person-only authorization as a decision', async () => {
    const view = await cashView({ projectId });
    const authority = view.decisionsForMe.items.find((one) => one.key === 'AUTHORITY');
    expect(authority).toBeTruthy();
    expect(authority!.answer.kind).toBe('GRANT_AUTHORITY');
    expect(authority!.urgency).toBe('BLOCKING');
  });

  it('agrees with the card about whose question each one is, and claims none for a person', () => {
    const fields = evidenceCard({} as unknown as CashOpportunity).fields;
    const researched = fields
      .filter((one) => one.owner === 'BRAIN_RESEARCH')
      .map((one) => one.key)
      .sort();
    expect([...RESEARCHED_FIELDS].sort()).toEqual(researched);
    for (const field of fields) expect(field.owner).not.toBe('PERSON_ONLY');
    // Every qualification question is Brain's too — to research or to propose.
    for (const key of UNIVERSAL_QUALIFICATION) {
      expect(fieldOwner(key)).not.toBe('PERSON_ONLY');
    }
  });

  it('deduplicates the sentences inside one grouped card', () => {
    /*
     * Needs grouped by an identical recommended path routinely carry an
     * identical explanation, and the card printed one copy per row — thirty
     * times, in production. A card that repeats itself is one nobody finishes.
     */
    const need = (id: string) => ({
      id,
      projectId,
      opportunityId: null,
      blockedAction: 'Reach the buyer',
      whyItMatters: 'Reaching a buyer needs a way to send a message.',
      recommendedPath: 'Connect a way to send messages.',
      requiredCapability: 'SEND_A_MESSAGE',
      expectedCostCents: null,
      setupEffort: 'An afternoon',
      nextStep: 'Pick one and connect it.',
      completionCondition: 'A way to send a message is connected.',
      blocksState: 'EXECUTING' as const,
      requestKey: null,
      occurrence: 1,
      candidateId: null,
      continuedAt: null,
      claimedAt: null,
      state: 'OPEN' as const,
      verifiedBy: null,
      resolution: null,
      resolvedAt: null,
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
    });
    const review = compressedReview({
      mode: null,
      stalled: [],
      authority: null,
      position: {
        currency: 'USD',
        pipelineCents: 0,
        customerPaymentsCents: 0,
        availableFundsCents: 0,
        unpaidCommitmentsCents: 0,
        heldCommitmentsCents: 0,
        reservesCents: 0,
        deployableCents: 0,
        completedContributionCents: 0,
        shortfall: false,
      } as never,
      placements: [],
      needs: [need('cnd_1'), need('cnd_2'), need('cnd_3')] as never,
      now: '2026-09-15T12:00:00.000Z',
    });
    const item = review.items.find((one) => one.key.startsWith('NEED_'))!;
    const sentence = 'Reaching a buyer needs a way to send a message.';
    expect(item.why).toBe(sentence);
    expect(item.why.split(sentence).length - 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11-14 — the page
// ---------------------------------------------------------------------------

describe('the page is a dashboard, and reading it changes nothing', () => {
  it('writes nothing when the view is read, however many times', async () => {
    for (let i = 0; i < 5; i += 1) {
      await harvested('ACTIVE_BUYER_DEMAND', `An opening number ${i}.`);
    }
    const db = getDb();
    const before = await snapshot();
    await cashView({ projectId });
    await cashView({ projectId });
    await cashView({ projectId });
    expect(await snapshot()).toEqual(before);

    async function snapshot(): Promise<Record<string, unknown>> {
      const out: Record<string, unknown> = {};
      for (const table of [
        'cash_opportunities',
        'cash_events',
        'cash_needs',
        'cash_card_facts',
        'work_items',
        'russell_candidates',
        'russell_missions',
        'research_orchestrations',
      ]) {
        const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
        out[table] = Number(row?.n ?? 0);
      }
      // And nothing moved: the whole opportunity table, byte for byte.
      out['rows'] = (await listOpportunities({ projectId })).map((one) => ({
        id: one.id,
        state: one.state,
        updatedAt: one.updatedAt,
        validationState: one.validationState,
      }));
      return out;
    }
  });

  it('shows at most five best openings, and none of them a signal', async () => {
    for (let i = 0; i < 12; i += 1) {
      const piece = await harvested('ACTIVE_BUYER_DEMAND', `A qualified opening ${i}.`);
      for (const key of [CAPTURE_KEY, ...qualificationKeys('ACTIVE_BUYER_DEMAND')]) {
        await answer(piece, key);
      }
    }
    for (let i = 0; i < 20; i += 1) {
      await harvested('PRICING_OR_INFORMATION_ASYMMETRY', `A published price ${i}.`);
    }
    const view = await cashView({ projectId });
    expect(view.myCurrentWork.best).toHaveLength(5);
    for (const placement of view.myCurrentWork.best) {
      expect(['QUALIFIED', 'READY_TO_TEST']).toContain(placement.tier.tier);
    }
    expect(view.myCurrentWork.bestAreNearlyQualified).toBe(false);
    // The signals are still there in full, with their provenance.
    expect(view.myCurrentWork.byTier.SIGNAL).toBe(20);
    expect(view.myCurrentWork.placements).toHaveLength(32);
  });

  it('says so plainly rather than padding the space with signals', async () => {
    for (let i = 0; i < 31; i += 1) {
      await harvested('PRICING_OR_INFORMATION_ASYMMETRY', `A published price ${i}.`);
    }
    const view = await cashView({ projectId });
    expect(view.myCurrentWork.best).toHaveLength(0);
    expect(view.myCurrentWork.bestAreNearlyQualified).toBe(false);
    expect(view.myCurrentWork.byTier.SIGNAL).toBe(31);
  });

  it('offers the nearly-qualified ones, labelled as such, when nothing is qualified', async () => {
    for (let i = 0; i < 3; i += 1) {
      const piece = await harvested('ACTIVE_BUYER_DEMAND', `A candidate ${i}.`);
      await answer(piece, CAPTURE_KEY);
      // Progressively closer, so the ordering is a count rather than a feeling.
      for (const key of qualificationKeys('ACTIVE_BUYER_DEMAND').slice(0, i * 4)) {
        await answer(piece, key);
      }
    }
    const view = await cashView({ projectId });
    expect(view.myCurrentWork.bestAreNearlyQualified).toBe(true);
    expect(view.myCurrentWork.best.length).toBe(3);
    const open = view.myCurrentWork.best.map((one) => one.tier.toAdvance.length);
    expect([...open].sort((a, b) => a - b)).toEqual(open);
  });

  it('keeps every claim, source and packet reachable in the full record', async () => {
    const piece = await harvested('RESALABLE_ASSET_OPENING', 'An asset with an asking price.');
    await getDb().run(
      `UPDATE cash_opportunities
          SET orchestration_id = ?, fragment_id = ?, discovery_round_id = ?
        WHERE id = ?`,
      ['orc_1', 'frg_1', 'cdr_1', piece.id],
    );
    const view = await cashView({ projectId });
    const found = view.myCurrentWork.placements.find((one) => one.opportunity.id === piece.id)!;
    expect(found.opportunity.sourceClaimId).toBeTruthy();
    expect(found.opportunity.orchestrationId).toBe('orc_1');
    expect(found.opportunity.fragmentId).toBe('frg_1');
    expect(found.opportunity.discoveryRoundId).toBe('cdr_1');
    expect(found.opportunity.buyingSignal).toBeTruthy();
    expect(found.opportunity.signalObservedAt).toBe('2026-09-15');
  });
});

// ---------------------------------------------------------------------------
// 15-17 — what must not have moved
// ---------------------------------------------------------------------------

describe('what this change was not allowed to touch', () => {
  it('leaves the commercial guard exactly where it was', async () => {
    const view = await cashView({ projectId });
    expect(view.authority.exists).toBe(false);
    expect(view.authority.allowedActions).toEqual([]);
    expect(view.authority.maxCommittedCents).toBe(0);
    const position = await cashPosition({ projectId, currency: 'USD' });
    expect(position.deployableCents).toBe(0);
  });

  it('keeps the lanes a running deep dive submits against, and adds the new ones beside them', () => {
    /*
     * A mission compiled before the new lanes existed is still in flight, and
     * a key that changed underneath it would invalidate its submission. The
     * original seven are untouched.
     */
    for (const lane of [
      'payer',
      'price_evidence',
      'cost_evidence',
      'timing',
      'effort',
      'delivery_requirements',
      'disqualifier',
    ]) {
      expect(FIELD_BY_LANE[lane]).toBeTruthy();
    }
    expect(FIELD_BY_LANE['eligibility']).toBe('eligibility');
    expect(FIELD_BY_LANE['acquisition_access']).toBe('acquisitionAccess');
    expect(FIELD_BY_LANE['exit_evidence']).toBe('exitEvidence');
    expect(FIELD_BY_LANE['contact_mode']).toBe('phoneDependency');

    // And every lane the validation profile declares resolves to a card field,
    // or a worker's accepted claim would land nowhere.
    const profile = profileFor('RUSSELL_CASH_VALIDATION_V1')!;
    for (const lane of profile.lanes) expect(FIELD_BY_LANE[lane.id]).toBeTruthy();
  });

  it('counts accounts and execution surfaces as two different numbers', async () => {
    /*
     * The production shape: one account carrying four Routines, which is how
     * the page came to read `1 / 4 HEALTHY` beside a fleet reporting four
     * eligible surfaces. Both readings were right and neither said which it
     * was counting.
     */
    const worker = await createWorker({
      name: 'a-research-worker',
      createdByType: 'HUMAN',
      createdById: userId,
    });
    const account = await createAccount({ name: 'Brain Research A', declaredPlanPower: 'Max' });
    for (const name of ['A', '1-B', '1-C', '1-D']) {
      await createRoutine({
        accountId: account.id,
        name: `Brain Research ${name}`,
        routineRef: `trig_${name}`,
        tokenSecretName: 'BRAIN_ROUTINE_TOKEN',
        tokenDigest: 'a'.repeat(64),
        workerId: worker.id,
      });
    }
    process.env['BRAIN_ROUTINE_TOKEN'] = 'a-bearer-that-is-present';
    try {
      const reading = await cashReadiness();
      const mine = reading.capacity.surfaces.filter(
        (one) => one.accountName === 'Brain Research A',
      );
      const accounts = new Set(reading.capacity.surfaces.map((one) => one.accountId));

      expect(mine).toHaveLength(4);
      expect(reading.capacity.eligibleNow).toBe(4);
      // One account, four surfaces. The two numbers are not meant to agree.
      expect(accounts.size).toBe(1);
      expect(reading.capacity.eligibleNow).not.toBe(accounts.size);
      /*
       * And eligibility is the dispatcher's own, rather than a second reading of
       * two columns: a Routine whose deployment secret is absent is skipped by
       * `fleetSnapshot` and so is not counted here either.
       */
      delete process.env['BRAIN_ROUTINE_TOKEN'];
      expect((await cashReadiness()).capacity.eligibleNow).toBe(0);
    } finally {
      delete process.env['BRAIN_ROUTINE_TOKEN'];
    }
  });

  it('is derived, so the deployed version alone reclassifies what is already written', async () => {
    /*
     * No migration writes a tier, nothing stores one, and no reconciliation
     * has to run before the page is right. `cash_opportunities` has no tier
     * column at all — the reading comes from the row and the card every time
     * it is asked.
     */
    for (const file of [
      'server/db/migrations/065_opportunity_tier.sql',
      'server/db/pg-migrations/056_opportunity_tier.sql',
    ]) {
      const source = await readFile(file, 'utf8');
      expect(source).not.toMatch(/\btier\b/i);
      expect(source).not.toMatch(/^\s*UPDATE /im);
    }

    /*
     * And no row carries one either, asked in a way both backends can answer.
     *
     * This read `PRAGMA table_info`, which is SQLite's and throws on Postgres
     * — the repository's own recurring lesson arriving in a test written to
     * hold it. A row read back through the repository is the dialect-neutral
     * form of the same question, and it is the stronger one: what matters is
     * that nothing reading an opportunity finds a stored tier on it.
     */
    const piece = await harvested('ACTIVE_BUYER_DEMAND', 'A named buyer published a request.');
    const row = (await getOpportunity(piece.id))!;
    expect(Object.keys(row)).not.toContain('tier');
    expect((row as unknown as Record<string, unknown>)['tier']).toBeUndefined();
  });

  it('assembles the same answer from the same rows, twice', async () => {
    for (let i = 0; i < 4; i += 1) {
      await harvested('ACTIVE_BUYER_DEMAND', `An opening ${i}.`);
    }
    const pieces = await listOpportunities({ projectId });
    const tiers: Record<string, Awaited<ReturnType<typeof tierOf>>> = {};
    for (const one of pieces) tiers[one.id] = await tierOf(one.id);
    const input = { opportunities: pieces, tiers, deployableCents: 0, maxConcurrent: 0, discoveryOpen: true };
    expect(JSON.stringify(assemble(input))).toBe(JSON.stringify(assemble(input)));
  });
});

/**
 * The monetization possibility ledger, walked rather than inspected.
 *
 * ---------------------------------------------------------------------------
 * What it is written from
 * ---------------------------------------------------------------------------
 *
 * A discovery arrives and Brain records **one** way of making money from it:
 * `cash_opportunities.mechanism`, chosen at promotion from the claim's declared
 * signal, before anybody has established a payer, a price or a route.
 * Production's thirty-one records are thirty-one single answers to a question
 * that has dozens, and the other answers were never written down — so the
 * alternatives were destroyed before the evidence that would have chosen
 * between them existed.
 *
 * The assertions below are about the **properties** that stop that happening
 * again, not about the vocabulary's current contents. A method added next month
 * must not fail this file; a possibility silently disappearing must.
 *
 *   * the space is enumerated from a closed table and is deterministic;
 *   * nothing in it is ever deleted, by merge, judgement or anything else;
 *   * every derived answer — status, rank, margin, unknowns — comes back from
 *     rows and is stale for nobody;
 *   * an unknown never helps, in the ranking or in a bounded query;
 *   * Brain never produces a probability;
 *   * a rank that moved leaves the position it moved from behind it;
 *   * the shared projection carries names and counts and not one figure.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import {
  createOpportunity,
  transitionOpportunity,
  updateOpportunity,
} from '../server/repos/cashPortfolio.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  insertClaims,
} from '../server/repos/research.ts';
import {
  getPath,
  listPaths,
  pathFactsFor,
  recordPathFact,
  snapshotsFor,
} from '../server/repos/monetization.ts';
import {
  applicableMethods,
  enumeratePossibilities,
} from '../server/services/cash/monetization/enumerate.ts';
import { composeLedger, rankableOf } from '../server/services/cash/monetization/ledger.ts';
import {
  composeSurface,
  conditionsToEnterTop,
  filterLedger,
  reconsiderable,
  TOP_SHOWN,
} from '../server/services/cash/monetization/surface.ts';
import { explainRanking } from '../server/services/cash/monetization/rank.ts';
import { recordMovements } from '../server/services/cash/monetization/movement.ts';
import { subjectGraph, sequences } from '../server/services/cash/monetization/graph.ts';
import {
  judgePath,
  linkPaths,
  mergePaths,
  seedPath,
  splitPath,
  unmergePath,
} from '../server/services/cash/monetization/decisions.ts';
import { sharedFrontier } from '../server/services/cash/shared.ts';
import {
  ATTRIBUTE,
  METHOD,
  derivedRelations,
  mayAnswer,
} from '../server/domain/monetization.ts';
import {
  MONETIZATION_ATTRIBUTES,
  MONETIZATION_METHODS,
  type CashOpportunity,
  type MonetizationAttribute,
  type MonetizationMethod,
  type OpportunitySignal,
} from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `ledger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
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
 * One harvested discovery, exactly as `harvest` writes one.
 *
 * A signal, a source and an observation date, and nothing else — no payer, no
 * offer, no price. That is what a promotion from an accepted claim actually
 * produces, and building it any other way would test a shape production never
 * has.
 */
async function discovery(
  signal: OpportunitySignal | null,
  title: string,
  over: Record<string, unknown> = {},
): Promise<CashOpportunity> {
  const created = await createOpportunity({
    projectId,
    cashModeId,
    ownerUserId: userId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    opportunitySignal: signal,
    source: 'A publisher',
    ...over,
  });
  const withSignal = await updateOpportunity(created.id, {
    buying_signal: title,
    signal_observed_at: '2026-09-15',
  });
  return withSignal ?? created;
}

/** A real accepted claim, so an EVIDENCE answer resolves to a passage. */
async function acceptedClaim(text: string): Promise<string> {
  const layers = await listLayers(projectId);
  const layer = layers[0]!;
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'what the published sources say',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'What the published sources say',
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
      question: 'What do the published sources say?',
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
      claim: text,
      sourceUrl: 'https://example.com/a',
      sourceTitle: 'A listing',
      sourcePublisher: 'A marketplace',
      sourceDate: '2026-09-15',
      evidenceExcerpt: text,
      evidenceLocator: 'the listing page',
      evidenceLane: 'demand_signal',
      retrievedAt: '2026-09-15T00:00:00.000Z',
      confidence: 0.9,
      validationState: 'SOURCED',
      validationDetail: null,
      sourced: true,
      accepted: true,
      contentHash: 'a'.repeat(64),
    },
  ]);
  /*
   * `claimedMethods` and `signalledClaims` both read *citable* claims, which
   * means the fragment reached ACCEPTED or BLOCKED. A fixture that left it
   * planned would be testing a shape production never reads.
   */
  await getDb().run("UPDATE research_fragments SET status = 'ACCEPTED' WHERE id = ?", [
    fragment!.id,
  ]);
  return claim!.id;
}

/** Answer one attribute on one path, the way research or a person would. */
async function answer(
  pathId: string,
  attribute: MonetizationAttribute,
  over: {
    value?: string;
    amountCents?: number | null;
    days?: number | null;
    claimId?: string | null;
    kind?: 'EVIDENCE' | 'RECOMMENDATION' | 'PERSON';
  } = {},
): Promise<void> {
  const kind = over.kind ?? 'PERSON';
  await recordPathFact({
    projectId,
    pathId,
    attribute,
    kind,
    value: over.value ?? defaultValue(attribute),
    amountCents: over.amountCents ?? null,
    days: over.days ?? null,
    claimId: over.claimId ?? null,
    basis: kind === 'RECOMMENDATION' ? 'what the rows already say' : null,
    assumptions: kind === 'RECOMMENDATION' ? 'that the rows are about this path' : null,
    uncertainty: kind === 'RECOMMENDATION' ? 'nothing has researched this in particular' : null,
    decidedBy: kind === 'PERSON' ? userId : 'BRAIN',
  });
}

/** A value the attribute actually admits, so a CHOICE is never free text. */
function defaultValue(attribute: MonetizationAttribute): string {
  const choices = ATTRIBUTE[attribute].choices;
  return choices ? choices[choices.length - 1]! : `An answer to ${attribute}.`;
}

/** Every load-bearing question answered, which is what ACTIVE requires. */
/**
 * Answer every load-bearing question on a path, as a person.
 *
 * `except` is there because a person's answer outranks a gated claim, so a test
 * that wants evidence on one attribute must not have already put a decision
 * there — `recordPathFact` refuses it, which is the guard doing its job rather
 * than an inconvenience. Leaving the attribute alone is the honest fixture.
 */
async function answerEverything(
  pathId: string,
  except: readonly MonetizationAttribute[] = [],
): Promise<void> {
  for (const attribute of MONETIZATION_ATTRIBUTES) {
    if (!ATTRIBUTE[attribute].loadBearing) continue;
    if (except.includes(attribute)) continue;
    if (attribute === 'expectedRevenue') {
      await answer(pathId, attribute, { value: 'USD 900.00', amountCents: 90_000 });
    } else if (attribute === 'directCosts') {
      await answer(pathId, attribute, { value: 'USD 100.00', amountCents: 10_000 });
    } else if (attribute === 'requiredCapital') {
      await answer(pathId, attribute, { value: 'USD 50.00', amountCents: 5_000 });
    } else if (attribute === 'timeToCash') {
      await answer(pathId, attribute, { value: '10 days', days: 10 });
    } else {
      await answer(pathId, attribute);
    }
  }
}

async function pathOf(method: MonetizationMethod): Promise<string> {
  const paths = await listPaths({ projectId });
  const found = paths.find((one) => one.method === method);
  expect(found, `no path for ${method}`).toBeTruthy();
  return found!.id;
}

/* --------------------------------------------------------------------------
 * The collapse this exists to undo
 * ------------------------------------------------------------------------ */

describe('one discovery, every way it could be monetized', () => {
  it('enumerates more than one possibility, including the one its mechanism stood for', async () => {
    const piece = await discovery('PAID_TASK_OR_CONTRACT', 'Somebody published a paid brief.');
    const report = await enumeratePossibilities(projectId);

    const paths = await listPaths({ projectId });
    expect(paths.length).toBeGreaterThan(1);
    expect(report.added[0]?.opportunityId).toBe(piece.id);

    // The single answer the old column stood for is one of them, and not the
    // only one: what changed is that the alternatives are written down too.
    expect(paths.map((one) => one.method)).toContain('DIRECT_SALE');
    expect(new Set(paths.map((one) => one.method)).size).toBe(paths.length);
    for (const path of paths) expect(path.origin).toBe('ENUMERATED');
  });

  it('enumerates only the methods the recorded signal actually admits', async () => {
    await discovery('RESALABLE_ASSET_OPENING', 'An asset with a published asking price.');
    await enumeratePossibilities(projectId);
    const methods = (await listPaths({ projectId })).map((one) => one.method);

    // A method declaring this signal is in; one declaring only others is out.
    expect(methods).toContain('RESALE');
    expect(methods).not.toContain('PROCUREMENT_CONTRACT');
    expect(methods.sort()).toEqual(applicableMethods('RESALABLE_ASSET_OPENING').sort());
  });

  it('claims less where less is known: an unsignalled discovery gets only the universal methods', async () => {
    await discovery(null, 'Something worth looking at, with nothing recorded about its kind.');
    await enumeratePossibilities(projectId);
    const methods = (await listPaths({ projectId })).map((one) => one.method);

    expect(methods.length).toBeGreaterThan(0);
    expect(methods.length).toBeLessThan(MONETIZATION_METHODS.length);
    for (const method of methods) expect(METHOD[method].appliesTo).toHaveLength(0);
  });

  it('is idempotent: a second pass over an unchanged project adds nothing', async () => {
    await discovery('ACTIVE_BUYER_DEMAND', 'A named buyer published that they want something.');
    const first = await enumeratePossibilities(projectId);
    const after = (await listPaths({ projectId })).length;

    const second = await enumeratePossibilities(projectId);
    expect(second.added).toHaveLength(0);
    expect((await listPaths({ projectId })).length).toBe(after);
    expect(first.added[0]!.pathIds.length).toBe(after);
  });

  it('adds nothing to a discovery that is over, and removes nothing already there', async () => {
    const piece = await discovery('ACTIVE_BUYER_DEMAND', 'A buyer who has since gone away.');
    await enumeratePossibilities(projectId);
    const before = (await listPaths({ projectId })).length;

    await transitionOpportunity({
      id: piece.id,
      from: ['DISCOVERED'],
      to: 'ARCHIVED',
      archivedReason: 'They withdrew.',
    });
    await enumeratePossibilities(projectId);

    expect((await listPaths({ projectId })).length).toBe(before);
    const ledger = await composeLedger({ projectId });
    expect(ledger.entries.every((one) => one.status === 'ARCHIVED')).toBe(true);
  });

  it('carries the discovery’s own figures onto one path, as a proposal and never as a fact', async () => {
    const piece = await discovery('ACTIVE_BUYER_DEMAND', 'A buyer with a published budget.');
    await updateOpportunity(piece.id, { price_cents: 120_000, peak_funding_cents: 20_000 });
    await enumeratePossibilities(projectId);

    const primary = await pathOf('DIRECT_SALE');
    const carried = await pathFactsFor(primary);
    expect(carried.map((one) => one.attribute).sort()).toEqual([
      'expectedRevenue',
      'requiredCapital',
    ]);
    for (const fact of carried) {
      expect(fact.kind).toBe('RECOMMENDATION');
      expect(fact.basis).toBeTruthy();
      expect(fact.assumptions).toBeTruthy();
      expect(fact.uncertainty).toBeTruthy();
      expect(fact.claimId).toBeNull();
    }

    // And onto nothing else: a published price for a job is not what a referral
    // fee on it pays, and writing it everywhere would be the collapse wearing a
    // number.
    const referral = await pathOf('REFERRAL_FEE');
    expect(await pathFactsFor(referral)).toHaveLength(0);
  });
});

describe('a possibility the table could not produce', () => {
  it('admits one a source named, anchored to the opening that claim established', async () => {
    /*
     * §20's *are there paths I could not see before*, as a declaration. The
     * worker that read the source names one method from the closed set, on a
     * claim that also establishes an opening — and the opening is what says
     * what the method is a way of monetizing, rather than a reading of the
     * claim's prose.
     */
    const claimId = await acceptedClaim('The county pays a franchisee to run the whole intake.');
    await getDb().run(
      "UPDATE research_claims SET monetization_method = 'FRANCHISE' WHERE id = ?",
      [claimId],
    );
    const piece = await discovery('ACTIVE_BUYER_DEMAND', 'A county published a request.');
    await getDb().run('UPDATE cash_opportunities SET source_claim_id = ? WHERE id = ?', [
      claimId,
      piece.id,
    ]);

    const report = await enumeratePossibilities(projectId);
    expect(report.evidenced).toHaveLength(1);

    const paths = await listPaths({ projectId });
    const evidenced = paths.find((one) => one.origin === 'EVIDENCED')!;
    expect(evidenced.method).toBe('FRANCHISE');
    expect(evidenced.sourceClaimId).toBe(claimId);
    // The thesis resolves to a passage, because the claim carries the source.
    expect(evidenced.thesis).toContain('franchisee');

    // And the table would not have produced it for this signal, which is the
    // whole reason the declaration exists.
    expect(applicableMethods('ACTIVE_BUYER_DEMAND')).not.toContain('FRANCHISE');
  });

  it('does not promote one twice, or fork a method the table already produced', async () => {
    const claimId = await acceptedClaim('They would pay a broker to connect the two sides.');
    await getDb().run(
      "UPDATE research_claims SET monetization_method = 'BROKERAGE' WHERE id = ?",
      [claimId],
    );
    const piece = await discovery('SUPPLY_DEMAND_MISMATCH', 'A published demand nobody connected.');
    await getDb().run('UPDATE cash_opportunities SET source_claim_id = ? WHERE id = ?', [
      claimId,
      piece.id,
    ]);

    await enumeratePossibilities(projectId);
    const first = (await listPaths({ projectId })).filter((one) => one.method === 'BROKERAGE');
    expect(first).toHaveLength(1);
    /*
     * The table already enumerates brokerage for a supply-and-demand mismatch,
     * so the declaration finds that row rather than forking the ledger — and
     * what it adds is the passage, recorded on the row that was already there.
     * Its origin stays ENUMERATED, because that is how it came to exist.
     */
    expect(first[0]!.origin).toBe('ENUMERATED');
    expect(first[0]!.sourceClaimId).toBe(claimId);

    const again = await enumeratePossibilities(projectId);
    expect(again.evidenced).toHaveLength(0);
    expect((await listPaths({ projectId })).filter((one) => one.method === 'BROKERAGE')).toHaveLength(1);
  });

  it('leaves a declaration alone until its claim has produced an opening', async () => {
    const claimId = await acceptedClaim('Somebody would licence the whole method.');
    await getDb().run(
      "UPDATE research_claims SET monetization_method = 'LICENSING' WHERE id = ?",
      [claimId],
    );
    // No opportunity carries this claim, so there is nothing for it to be a way
    // of monetizing — and guessing one is the defect §25 records.
    const report = await enumeratePossibilities(projectId);
    expect(report.evidenced).toHaveLength(0);
    expect(await listPaths({ projectId })).toHaveLength(0);
  });
});

/* --------------------------------------------------------------------------
 * Where a possibility stands
 * ------------------------------------------------------------------------ */

describe('status is derived, and says what decided it', () => {
  beforeEach(async () => {
    await discovery('ACTIVE_BUYER_DEMAND', 'A named buyer published that they want something.');
    await enumeratePossibilities(projectId);
  });

  it('reads unproven with nothing established, and says so rather than implying a verdict', async () => {
    const ledger = await composeLedger({ projectId });
    expect(ledger.entries.every((one) => one.status === 'UNPROVEN')).toBe(true);
    expect(ledger.entries[0]!.statusBecause).toMatch(/Nothing has been established/i);
  });

  it('reads active once every load-bearing question is answered', async () => {
    const path = await pathOf('DIRECT_SALE');
    await answerEverything(path);

    const entry = (await composeLedger({ projectId })).entries.find(
      (one) => one.path.id === path,
    )!;
    expect(entry.status).toBe('ACTIVE');
    expect(entry.unknowns.length).toBeLessThan(MONETIZATION_ATTRIBUTES.length);
  });

  it('reads weak when the established revenue does not cover the established costs', async () => {
    const path = await pathOf('DIRECT_SALE');
    await answerEverything(path);
    await answer(path, 'directCosts', { value: 'USD 2,000.00', amountCents: 200_000 });

    const entry = (await composeLedger({ projectId })).entries.find(
      (one) => one.path.id === path,
    )!;
    expect(entry.status).toBe('WEAK');
    expect(entry.margin.value).toBeLessThan(0);
  });

  it('withholds the margin rather than computing one against an unknown cost', async () => {
    const path = await pathOf('DIRECT_SALE');
    await answer(path, 'expectedRevenue', { value: 'USD 900.00', amountCents: 90_000 });

    const entry = (await composeLedger({ projectId })).entries.find(
      (one) => one.path.id === path,
    )!;
    expect(entry.margin.value).toBeNull();
    expect(entry.margin.withheld).toMatch(/direct costs are unknown/i);
  });

  it('takes a person’s judgement, and the answer out of one', async () => {
    const path = await pathOf('DIRECT_SALE');

    await judgePath({
      projectId,
      pathId: path,
      judgment: 'INVALIDATE',
      reason: 'The platform forbids it outright.',
      decidedByUserId: userId,
    });
    let entry = (await composeLedger({ projectId })).entries.find((one) => one.path.id === path)!;
    expect(entry.status).toBe('INVALIDATED');
    expect(entry.statusBecause).toContain('The platform forbids it outright.');

    await judgePath({
      projectId,
      pathId: path,
      judgment: 'REVIVE',
      reason: 'They changed the terms.',
      decidedByUserId: userId,
    });
    entry = (await composeLedger({ projectId })).entries.find((one) => one.path.id === path)!;
    expect(entry.status).not.toBe('INVALIDATED');

    // And the doubt is still on the record. Deleting it would make the ledger
    // claim nobody ever had any.
    expect(entry.judgments.map((one) => one.judgment)).toEqual(['INVALIDATE', 'REVIVE']);
  });

  it('refuses a judgement with no reason, because nobody could reconsider it later', async () => {
    const outcome = await judgePath({
      projectId,
      pathId: await pathOf('DIRECT_SALE'),
      judgment: 'ARCHIVE',
      reason: '   ',
      decidedByUserId: userId,
    });
    expect(outcome.ok).toBe(false);
  });
});

/* --------------------------------------------------------------------------
 * The one number Brain will not produce
 * ------------------------------------------------------------------------ */

describe('a probability of success is read or it is unknown', () => {
  it('declares that Brain may not propose one', () => {
    expect(mayAnswer('probabilityOfSuccess', 'EVIDENCE')).toBe(true);
    expect(mayAnswer('probabilityOfSuccess', 'PERSON')).toBe(true);
    expect(mayAnswer('probabilityOfSuccess', 'RECOMMENDATION')).toBe(false);

    // And it is the only narrowing, so the rule is visible rather than buried
    // among a dozen special cases.
    const narrowed = MONETIZATION_ATTRIBUTES.filter(
      (one) => !mayAnswer(one, 'RECOMMENDATION'),
    );
    expect(narrowed).toEqual(['probabilityOfSuccess']);
  });

  it('refuses the write rather than describing the rule in a comment', async () => {
    await discovery('ACTIVE_BUYER_DEMAND', 'A named buyer.');
    await enumeratePossibilities(projectId);
    const path = await pathOf('DIRECT_SALE');

    await expect(
      recordPathFact({
        projectId,
        pathId: path,
        attribute: 'probabilityOfSuccess',
        kind: 'RECOMMENDATION',
        value: 'about 40%',
        basis: 'a feeling',
        assumptions: 'that it is like the others',
        uncertainty: 'considerable',
        decidedBy: 'BRAIN',
      }),
    ).rejects.toThrow(/probabilityOfSuccess/);
  });

  it('carries no score, no weight and no percentage on any entry', async () => {
    await discovery('ACTIVE_BUYER_DEMAND', 'A named buyer.');
    await enumeratePossibilities(projectId);
    const ledger = await composeLedger({ projectId });
    const serialized = JSON.stringify(ledger.entries[0]);
    for (const forbidden of ['"score"', '"weight"', '"probability":', '"confidence":']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

/* --------------------------------------------------------------------------
 * The ranking, and the questions it has to answer
 * ------------------------------------------------------------------------ */

describe('ranking is lexicographic, so it can say exactly why', () => {
  beforeEach(async () => {
    await discovery('ACTIVE_BUYER_DEMAND', 'A named buyer published that they want something.');
    await enumeratePossibilities(projectId);
  });

  it('names the first criterion two possibilities differ on, and nothing below it', async () => {
    const answered = await pathOf('DIRECT_SALE');
    await answerEverything(answered);

    const ledger = await composeLedger({ projectId });
    const best = ledger.entries[0]!;
    const worst = ledger.entries[ledger.entries.length - 1]!;
    expect(best.path.id).toBe(answered);

    const explained = explainRanking(rankableOf(best), rankableOf(worst));
    expect(explained.criterion).toBe('STATUS');
    expect(explained.higher?.pathId).toBe(best.path.id);
    expect(explained.sentence).toContain('Nothing below that was consulted');
  });

  it('never lets a blank be the reason something rises', async () => {
    const costed = await pathOf('DIRECT_SALE');
    const uncosted = await pathOf('REFERRAL_FEE');
    // Identical but for the capital: one knows what it needs up front, the
    // other does not. The unknown must not read as free.
    for (const path of [costed, uncosted]) {
      await answer(path, 'expectedRevenue', { value: 'USD 900.00', amountCents: 90_000 });
      await answer(path, 'directCosts', { value: 'USD 100.00', amountCents: 10_000 });
    }
    await answer(costed, 'requiredCapital', { value: 'USD 800.00', amountCents: 80_000 });

    const ledger = await composeLedger({ projectId });
    const costedRank = ledger.entries.find((one) => one.path.id === costed)!.rank;
    const uncostedRank = ledger.entries.find((one) => one.path.id === uncosted)!.rank;
    expect(costedRank).toBeLessThan(uncostedRank);
  });

  it('answers what would have to become true to enter the top five', async () => {
    // Enough answered on five of them that a sixth is genuinely behind.
    const paths = await listPaths({ projectId });
    expect(paths.length).toBeGreaterThan(TOP_SHOWN);
    for (const path of paths.slice(0, TOP_SHOWN)) await answerEverything(path.id);

    const ledger = await composeLedger({ projectId });
    const outside = ledger.entries[TOP_SHOWN]!;
    const answered = conditionsToEnterTop(ledger, outside.path.id);

    expect(answered.against).toBe(ledger.entries[TOP_SHOWN - 1]!.path.id);
    expect(answered.conditions.length).toBeGreaterThan(0);
    expect(answered.conditions[0]!.sentence).toBeTruthy();
    // Every condition names a criterion the order is actually decided on.
    for (const condition of answered.conditions) expect(condition.criterion).toBeTruthy();
  });

  it('says nothing is keeping a path out when it is already in', async () => {
    const ledger = await composeLedger({ projectId });
    const answered = conditionsToEnterTop(ledger, ledger.entries[0]!.path.id);
    expect(answered.conditions).toHaveLength(0);
    expect(answered.note).toMatch(/already in the top five/i);
  });

  it('is stable: two reads of an unchanged ledger produce the same order', async () => {
    const first = (await composeLedger({ projectId })).entries.map((one) => one.path.id);
    const second = (await composeLedger({ projectId })).entries.map((one) => one.path.id);
    expect(second).toEqual(first);
  });
});

/* --------------------------------------------------------------------------
 * That a position moved
 * ------------------------------------------------------------------------ */

describe('movement is recorded because no derivation could recover it', () => {
  beforeEach(async () => {
    await discovery('ACTIVE_BUYER_DEMAND', 'A named buyer published that they want something.');
    await enumeratePossibilities(projectId);
  });

  it('records every path entering the ledger, once', async () => {
    const first = await recordMovements({ projectId });
    expect(first.movements.length).toBe(first.evaluated);
    for (const movement of first.movements) {
      expect(movement.reason).toBe('ENTERED_THE_LEDGER');
      expect(movement.previousRank).toBeNull();
    }

    // And writes nothing at all over an unchanged ledger, which is what keeps
    // the table a history rather than a log of ticks.
    const second = await recordMovements({ projectId });
    expect(second.movements).toHaveLength(0);
    expect(second.evaluated).toBeGreaterThan(0);
  });

  it('records where a path came from and why, when its own evidence changes', async () => {
    await recordMovements({ projectId });
    const promoted = (await listPaths({ projectId })).at(-1)!.id;
    await answerEverything(promoted);

    const report = await recordMovements({ projectId });
    const mine = report.movements.find((one) => one.pathId === promoted);
    expect(mine).toBeTruthy();
    expect(mine!.previousRank).toBeGreaterThan(mine!.rank);
    expect(mine!.reason).toBe('ITS_STATUS_CHANGED');

    const history = await snapshotsFor(promoted);
    expect(history).toHaveLength(2);
    expect(history[0]!.reason).toBe('ENTERED_THE_LEDGER');
    expect(history[1]!.previousRank).toBe(history[0]!.rank);
  });

  it('stamps every path it looked at, so a stale reading is visible', async () => {
    await recordMovements({ projectId });
    for (const path of await listPaths({ projectId })) {
      expect(path.lastEvaluatedAt).toBeTruthy();
    }
  });
});

/* --------------------------------------------------------------------------
 * The graph
 * ------------------------------------------------------------------------ */

describe('the possibility graph is derived from the method table', () => {
  it('draws enables where one method produces what another requires', () => {
    // Lead generation produces relationships; referral needs them.
    expect(derivedRelations('LEAD_GENERATION', 'REFERRAL_FEE')).toContain('ENABLES');
    expect(derivedRelations('LEAD_GENERATION', 'REFERRAL_FEE')).toContain(
      'PRODUCES_RELATIONSHIPS_FOR',
    );
  });

  it('draws competes-with only between two ways of being the same party', () => {
    const sameRole = MONETIZATION_METHODS.find(
      (one) => one !== 'DIRECT_SALE' && METHOD[one].role === METHOD.DIRECT_SALE.role,
    )!;
    expect(derivedRelations('DIRECT_SALE', sameRole)).toContain('COMPETES_WITH');

    const otherRole = MONETIZATION_METHODS.find(
      (one) => METHOD[one].role !== METHOD.DIRECT_SALE.role,
    )!;
    expect(derivedRelations('DIRECT_SALE', otherRole)).not.toContain('COMPETES_WITH');
  });

  it('refuses to decide requires from a pair, and decides it from the subject', async () => {
    await discovery('ACTIVE_BUYER_DEMAND', 'A named buyer published that they want something.');
    await enumeratePossibilities(projectId);
    const paths = await listPaths({ projectId });

    // Nothing pairwise ever says REQUIRES: it is a fact about every path on a
    // subject, and a pairwise view guessing it would state a hard dependency it
    // cannot know.
    for (const from of paths) {
      for (const to of paths) {
        expect(derivedRelations(from.method, to.method)).not.toContain('REQUIRES');
      }
    }

    const edges = subjectGraph(paths);
    for (const edge of edges.filter((one) => one.kind === 'REQUIRES')) {
      // Every one names the endowment and the single producer of it.
      expect(edge.rationale).toMatch(/only possibility recorded/);
    }
  });

  it('blocks on a relation somebody recorded, and never on one it drew itself', async () => {
    await discovery('ACTIVE_BUYER_DEMAND', 'A named buyer published that they want something.');
    await enumeratePossibilities(projectId);

    /*
     * A fresh ledger is full of derived requirements — one exists wherever
     * exactly one possibility on a discovery produces something another needs —
     * and not one of them is a blocker. Reading them as blockers is the defect
     * running this found: every possibility read BLOCKED on day one, on a
     * condition nobody had established and nobody could act on.
     */
    let ledger = await composeLedger({ projectId });
    const derived = ledger.entries.flatMap((one) =>
      one.edges.filter((edge) => edge.kind === 'REQUIRES' && edge.source === 'DERIVED'),
    );
    expect(derived.length).toBeGreaterThan(0);
    expect(ledger.entries.some((one) => one.status === 'BLOCKED')).toBe(false);

    // What a person records does block, and names what it waits on.
    const waiting = await pathOf('DIRECT_SALE');
    const first = await pathOf('LEAD_GENERATION');
    const linked = await linkPaths({
      projectId,
      fromPathId: first,
      toPathId: waiting,
      kind: 'REQUIRES',
      rationale: 'This buyer will not talk to anybody who has not been introduced.',
      decidedByUserId: userId,
    });
    expect(linked.ok).toBe(true);

    ledger = await composeLedger({ projectId });
    const blocked = ledger.entries.find((one) => one.path.id === waiting)!;
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.statusBecause).toContain('cannot start until');
  });

  it('produces chains, and claims only what the edges claim', async () => {
    await discovery('SUPPLY_DEMAND_MISMATCH', 'A published demand nobody has connected.');
    await enumeratePossibilities(projectId);
    const paths = await listPaths({ projectId });
    const chains = sequences(paths, subjectGraph(paths));

    for (const chain of chains) {
      expect(chain.pathIds.length).toBeGreaterThan(1);
      expect(chain.titles).toHaveLength(chain.pathIds.length);
      expect(chain.hops).toHaveLength(chain.pathIds.length - 1);
    }
  });
});

/* --------------------------------------------------------------------------
 * Nothing is ever deleted
 * ------------------------------------------------------------------------ */

describe('a low rank is never a reason to lose a row', () => {
  beforeEach(async () => {
    await discovery('ACTIVE_BUYER_DEMAND', 'A named buyer published that they want something.');
    await enumeratePossibilities(projectId);
  });

  it('merges by pointing, keeps everything, and un-merges by clearing one field', async () => {
    const absorbed = await pathOf('REFERRAL_FEE');
    const survivor = await pathOf('DIRECT_SALE');
    await answer(absorbed, 'competition', { value: 'FEW' });
    await judgePath({
      projectId,
      pathId: absorbed,
      judgment: 'WATCH',
      reason: 'Worth an eye.',
      decidedByUserId: userId,
    });

    const merged = await mergePaths({
      projectId,
      absorbedId: absorbed,
      survivorId: survivor,
      reason: 'They are one transaction.',
      decidedByUserId: userId,
    });
    expect(merged.ok).toBe(true);

    // The row, its answers and its judgements are all still there.
    expect(await getPath(absorbed)).toBeTruthy();
    expect(await pathFactsFor(absorbed)).toHaveLength(1);
    const entry = (await composeLedger({ projectId })).entries.find(
      (one) => one.path.id === absorbed,
    )!;
    expect(entry.status).toBe('ARCHIVED');
    expect(entry.statusBecause).toContain('merged into');
    expect(entry.judgments).toHaveLength(1);

    const back = await unmergePath({ projectId, pathId: absorbed, decidedByUserId: userId });
    expect(back.ok).toBe(true);
    const after = (await composeLedger({ projectId })).entries.find(
      (one) => one.path.id === absorbed,
    )!;
    expect(after.status).not.toBe('ARCHIVED');
  });

  it('refuses a merge across two discoveries rather than producing a nonsense graph', async () => {
    const other = await discovery('ACTIVE_BUYER_DEMAND', 'A different buyer entirely.');
    await enumeratePossibilities(projectId);
    const mine = (await listPaths({ projectId })).filter(
      (one) => one.opportunityId === other.id,
    )[0]!;
    const theirs = (await listPaths({ projectId })).filter(
      (one) => one.opportunityId !== other.id,
    )[0]!;

    const outcome = await mergePaths({
      projectId,
      absorbedId: mine.id,
      survivorId: theirs.id,
      reason: 'Trying it on.',
      decidedByUserId: userId,
    });
    expect(outcome.ok).toBe(false);
    expect((await getPath(mine.id))!.mergedIntoId).toBeNull();
  });

  it('splits into children that name their parent, and leaves the parent alone', async () => {
    const parent = await pathOf('DIRECT_SALE');
    const outcome = await splitPath({
      projectId,
      pathId: parent,
      into: [{ method: 'CONSULTING' }, { method: 'TRAINING' }],
      reason: 'This is two businesses.',
      decidedByUserId: userId,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    for (const child of outcome.value) expect(child.splitFromId).toBe(parent);
    const after = await getPath(parent);
    expect(after!.mergedIntoId).toBeNull();
    expect(after!.origin).toBe('ENUMERATED');
  });

  it('has no way to delete anything at all', async () => {
    /*
     * Matched as a *statement* rather than as a word, which is the same
     * discipline `operatorConsoleRemoved` applies for its own reason: this
     * repository writes down why it refuses things, so the sentence "there is
     * no DELETE statement here" is history worth keeping and must not fail the
     * check it describes. What must not exist is somewhere to go.
     */
    const source = await readFile('server/repos/monetization.ts', 'utf8');
    expect(source).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(source).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(source).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('keeps a possibility a person seeded, and never writes SEED itself', async () => {
    const piece = (await listPaths({ projectId }))[0]!;
    const seeded = await seedPath({
      projectId,
      method: 'FRANCHISE',
      opportunityId: piece.opportunityId,
      thesis: 'Somebody would buy the whole method.',
      seededByUserId: userId,
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.value.path.origin).toBe('SEED');

    // The enumeration never produces one, however many times it runs.
    await enumeratePossibilities(projectId);
    const enumerated = (await listPaths({ projectId })).filter((one) => one.origin === 'SEED');
    expect(enumerated).toHaveLength(1);
  });
});

/* --------------------------------------------------------------------------
 * The operator surface
 * ------------------------------------------------------------------------ */

describe('the five are a view, and the space is the space', () => {
  beforeEach(async () => {
    await discovery('ACTIVE_BUYER_DEMAND', 'A named buyer published that they want something.');
    await enumeratePossibilities(projectId);
  });

  it('shows five at most and reports how many there actually are', async () => {
    const surface = composeSurface({ ledger: await composeLedger({ projectId }) });
    expect(surface.top.length).toBeLessThanOrEqual(TOP_SHOWN);
    expect(surface.total).toBe(surface.entries.length);
    expect(surface.total).toBeGreaterThan(surface.top.length);
  });

  it('answers all nine questions for each of the five', async () => {
    await answerEverything(await pathOf('DIRECT_SALE'));
    const surface = composeSurface({ ledger: await composeLedger({ projectId }) });
    for (const top of surface.top) {
      expect(top.what).toBeTruthy();
      expect(top.whyItRanksHighly).toBeTruthy();
      expect(top.timeToCash).toBeTruthy();
      expect(top.requiredAction).toBeTruthy();
      expect(top.whatChanged).toBeTruthy();
      expect(top.whyItOutranksTheNext).toBeTruthy();
      expect(top.economics).toBeTruthy();
      expect(Array.isArray(top.risks)).toBe(true);
      expect(top.confidence.fromASource + top.confidence.brainsOwnProposal).toBeGreaterThanOrEqual(
        0,
      );
    }
  });

  it('gives the five their ledger rank rather than their place in the list', async () => {
    /*
     * The five are the best *live* possibilities, so an invalidated one at rank
     * two makes the list positions and the ranks differ. A page that numbered
     * them 1..5 would show a rank a path does not have, and would disagree with
     * the movement history that says where it came from.
     */
    const put = await pathOf('DIRECT_SALE');
    await answerEverything(put);
    await judgePath({
      projectId,
      pathId: put,
      judgment: 'ARCHIVE',
      reason: 'Not now.',
      decidedByUserId: userId,
    });

    const ledger = await composeLedger({ projectId });
    const surface = composeSurface({ ledger });
    const archivedRank = ledger.entries.find((one) => one.path.id === put)!.rank;
    const ranks = surface.top.map((one) => one.rank);

    expect(ranks).not.toContain(archivedRank);
    // Each entry carries its own rank, which is what the page renders.
    for (const top of surface.top) {
      expect(ledger.entries.find((one) => one.path.id === top.pathId)!.rank).toBe(top.rank);
    }
  });

  it('reaches every possibility through a group, with nothing dropped', async () => {
    await judgePath({
      projectId,
      pathId: await pathOf('REFERRAL_FEE'),
      judgment: 'ARCHIVE',
      reason: 'Not now.',
      decidedByUserId: userId,
    });
    const surface = composeSurface({ ledger: await composeLedger({ projectId }) });
    const reachable = new Set(surface.groups.flatMap((one) => one.pathIds));
    for (const entry of surface.entries) expect(reachable.has(entry.path.id)).toBe(true);
  });

  it('never lets an unknown pass a bounded query', async () => {
    const costed = await pathOf('DIRECT_SALE');
    await answer(costed, 'requiredCapital', { value: 'USD 10.00', amountCents: 1_000 });

    const ledger = await composeLedger({ projectId });
    const cheap = filterLedger(ledger.entries, { maxCapitalCents: 500_000 });
    expect(cheap.map((one) => one.path.id)).toEqual([costed]);

    const quick = filterLedger(ledger.entries, { maxDaysToCash: 7 });
    expect(quick).toHaveLength(0);
  });

  it('derives what is worth reconsidering from two timestamps', async () => {
    const path = await pathOf('DIRECT_SALE');
    await judgePath({
      projectId,
      pathId: path,
      judgment: 'ARCHIVE',
      reason: 'Nothing supported it.',
      decidedByUserId: userId,
    });
    expect(reconsiderable(await composeLedger({ projectId }))).toHaveLength(0);

    await answer(path, 'expectedRevenue', { value: 'USD 900.00', amountCents: 90_000 });
    const found = reconsiderable(await composeLedger({ projectId }));
    expect(found.map((one) => one.path.id)).toEqual([path]);
  });
});

/* --------------------------------------------------------------------------
 * The shared boundary
 * ------------------------------------------------------------------------ */

describe('a member reads the space in names and counts, and no figure of it', () => {
  it('carries the possibilities, their statuses, their ranks and their open questions', async () => {
    await discovery('ACTIVE_BUYER_DEMAND', 'A named buyer published that they want something.');
    await enumeratePossibilities(projectId);
    const claimId = await acceptedClaim('A published rate for this work.');
    const path = await pathOf('DIRECT_SALE');
    await answerEverything(path, ['legalRequirements']);
    await answer(path, 'legalRequirements', {
      kind: 'EVIDENCE',
      claimId,
      value: 'No licence is required, per the published terms.',
    });

    const frontier = await sharedFrontier({ projectId });
    const shared = frontier.monetization;

    expect(shared.total).toBeGreaterThan(1);
    expect(shared.topPathIds.length).toBeGreaterThan(0);
    const mine = shared.paths.find((one) => one.id === path)!;
    expect(mine.status).toBe('ACTIVE');
    expect(mine.answered.fromASource).toBe(1);
    expect(mine.openQuestions.every((one) => typeof one.label === 'string')).toBe(true);

    /*
     * And not one value crosses. Matched as a JSON key at any depth, which is
     * the same discipline `sharedCashBoundary` applies in the release gate and
     * for the same reason: a figure nested inside a possibility is the same
     * disclosure as one at the top level.
     */
    const raw = JSON.stringify(shared);
    for (const forbidden of [
      'amountCents',
      'days',
      'margin',
      'economics',
      'risks',
      'basis',
      'assumptions',
      'uncertainty',
      'claimId',
      'value',
    ]) {
      expect(raw, `${forbidden} crossed the boundary`).not.toContain(`"${forbidden}":`);
    }
    expect(raw).not.toContain('USD 900.00');
  });
});

/* --------------------------------------------------------------------------
 * The reading writes nothing
 * ------------------------------------------------------------------------ */

describe('composing the ledger is a projection', () => {
  it('writes no row of any kind', async () => {
    await discovery('ACTIVE_BUYER_DEMAND', 'A named buyer published that they want something.');
    await enumeratePossibilities(projectId);
    await recordMovements({ projectId });

    const db = getDb();
    const count = async (table: string): Promise<number> => {
      const rows = await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      return Number(rows[0]?.n ?? 0);
    };
    const before = {
      paths: await count('monetization_paths'),
      facts: await count('monetization_path_facts'),
      judgments: await count('monetization_path_judgments'),
      snapshots: await count('monetization_rank_snapshots'),
      events: await count('cash_events'),
    };

    await composeLedger({ projectId });
    await sharedFrontier({ projectId });
    composeSurface({ ledger: await composeLedger({ projectId }) });

    expect({
      paths: await count('monetization_paths'),
      facts: await count('monetization_path_facts'),
      judgments: await count('monetization_path_judgments'),
      snapshots: await count('monetization_rank_snapshots'),
      events: await count('cash_events'),
    }).toEqual(before);
  });
});

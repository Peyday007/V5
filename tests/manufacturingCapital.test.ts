/**
 * Required capital, from the claim a worker submitted to the figure a person
 * reads — and every place it must refuse.
 *
 * ---------------------------------------------------------------------------
 * The one rule, and why it has to be tested at every layer
 * ---------------------------------------------------------------------------
 *
 * **A total is withheld whenever any established requirement carries no
 * published figure.** The error this prevents is directional rather than
 * merely inaccurate: a sum that steps over an unpriced requirement is
 * *smaller* than anything published says, so it makes a category look cheaper
 * to enter than it is — and too low at the number that would start a factory
 * reads as a bargain rather than as a mistake. §30 records
 * `conservativeContribution` making exactly this error one section along: an
 * unknown exposure read as zero, so a piece nobody had costed ranked above one
 * somebody had.
 *
 * That rule is only real if it holds everywhere a figure can be produced, so
 * this suite walks it through each: the wire door that validates a submission,
 * the repository that stores it, the reading that derives a total, the entry
 * condition that consumes the reading, the ranking that orders on it, and the
 * projection a browser receives.
 *
 * ---------------------------------------------------------------------------
 * Both backends
 * ---------------------------------------------------------------------------
 *
 * Everything here runs against whichever database the suite is configured for,
 * so the Postgres run exercises the same assertions. §25's argument in one
 * line: a repository layer over two databases is true or merely compiling, and
 * only one of the two can tell you which.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  listCategoryCapital,
  recordCategoryCapital,
  createCategory,
  getProgram,
} from '../server/repos/manufacturing.ts';
import { startProgramme } from '../server/services/manufacturing/program.ts';
import { seedCategory } from '../server/services/manufacturing/declare.ts';
import { readCapital } from '../server/services/manufacturing/capital.ts';
import { validateCapabilityFinding } from '../server/domain/manufacturing.ts';
import { rankCategories } from '../server/services/manufacturing/priority.ts';
import { readLadder } from '../server/services/manufacturing/readiness.ts';
import { ladderSnapshot } from '../server/services/manufacturing/ladder.ts';
import { programmeView } from '../server/services/manufacturing/view.ts';
import { insertClaims, decideClaim } from '../server/repos/research.ts';
import { createOrchestration, createFragments, currentFragments, updateFragment } from '../server/repos/research.ts';
import { createRun } from '../server/repos/runs.ts';
import type { CategoryCapitalEntry } from '../server/domain/types.ts';

const OBJECTIVE =
  'Build a general-purpose machinery company, starting from powered equipment and working ' +
  'toward whatever the evidence says is reachable next.';

let fixture: TestProject;
let projectId: string;
let userId: string;
let layerId: string;

beforeEach(async () => {
  fixture = await freshProject();
  projectId = fixture.project.id;
  const layer = await fixture.layerByName('Discovery Logic');
  layerId = layer.id;
  const user = await createUser({
    email: `capital-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
    isBrainAdmin: true,
  });
  userId = user.id;
});

async function programme(): Promise<{ programId: string; categoryId: string }> {
  const started = await startProgramme({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: OBJECTIVE,
  });
  expect(started.ok).toBe(true);
  const seeded = await seedCategory({
    projectId,
    name: 'Commercial pressure washers',
    actorRef: userId,
  });
  const program = await getProgram(projectId);
  return {
    programId: program!.id,
    categoryId: (seeded as { category: { id: string } }).category.id,
  };
}

/**
 * A stored claim to hang a capital row off.
 *
 * The rows are foreign-keyed to `research_claims`, and that is the point of
 * the column rather than a formality: a figure with no claim behind it is one
 * nobody can trace to a source, which is the thing every reading of it
 * assumes. So the fixture writes a real claim through the real repository
 * rather than inventing an id.
 */
async function claimId(text: string): Promise<string> {
  const run = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a capital round',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: 'a capital round',
    assignment: 'what entering costs',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId,
      geography: 'the markets the programme may look at',
      requiredEvidence: [
        { id: 'requirement', description: 'what entering costs', necessity: 'REQUIRED' },
      ],
      acceptableSourceTypes: ['a supplier’s published price list'],
      excludedSourceTypes: ['a figure the researcher calculated'],
      completionCriteria: ['every figure carries its currency and date'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'machine-capital',
      question: 'What does entering cost?',
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
  const [claim] = await insertClaims([
    {
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'BROAD_SCAN',
      claim: text,
      sourceUrl: 'https://example.test/supplier/price-list',
      sourceTitle: 'A supplier price list',
      sourcePublisher: 'A machine-tool supplier',
      sourceDate: '2026-05-01',
      evidenceExcerpt: text,
      evidenceLocator: 'the price table',
      evidenceLane: 'requirement',
      retrievedAt: '2026-05-02',
      confidence: 0.9,
      validationState: 'SOURCED',
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT',
      contentHash: `${text}|capital`,
    },
  ]);
  await decideClaim(claim!.id, { accepted: true });
  return claim!.id;
}

async function file(input: {
  programId: string;
  categoryId: string;
  requirement: CategoryCapitalEntry['requirement'];
  scenario?: CategoryCapitalEntry['scenario'];
  lowMinor?: number;
  highMinor?: number;
  currency?: string;
  basis?: CategoryCapitalEntry['basis'];
  statement?: string;
}): Promise<CategoryCapitalEntry | null> {
  const statement = input.statement ?? `A published figure for ${input.requirement}.`;
  return recordCategoryCapital({
    programId: input.programId,
    categoryId: input.categoryId,
    requirement: input.requirement,
    scenario: input.scenario ?? 'SMALLEST_CREDIBLE_ENTRY',
    amountLowMinor: input.lowMinor ?? null,
    amountHighMinor: input.highMinor ?? null,
    currency: input.currency ?? null,
    basis: input.basis ?? 'PUBLISHED_PRICE_OR_SCHEDULE',
    asOf: '2026-05-01',
    statement,
    sourceClaimId: await claimId(statement),
  });
}

// ---------------------------------------------------------------------------

describe('the wire door decides what a capital declaration is', () => {
  const base = { where: 'claims[0]', finding: 'CAPITAL_REQUIREMENT', subject: 'TOOLING_AND_EQUIPMENT' };

  it('accepts a requirement with a published range', () => {
    const check = validateCapabilityFinding({
      ...base,
      observedOn: '2026-05-01',
      qualifier: 'SMALLEST_CREDIBLE_ENTRY',
      basis: 'PUBLISHED_PRICE_OR_SCHEDULE',
      amountLowMinor: 40_000_000,
      amountHighMinor: 52_000_000,
      currency: 'usd',
    });
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.value.amountLowMinor).toBe(40_000_000);
      // Normalized, so two workers writing "usd" and "USD" store one value.
      expect(check.value.currency).toBe('USD');
      expect(check.value.qualifier).toBe('SMALLEST_CREDIBLE_ENTRY');
    }
  });

  /**
   * The acceptance that matters most, and the one a worker would assume is
   * wrong.
   *
   * *The requirement is real and nobody publishes what it costs* has to be a
   * submittable answer. Refusing it would leave a worker with nothing to send
   * but an estimate of their own — which is the single output this question
   * most needs never to receive.
   */
  it('accepts a requirement with no figure at all, which is the finding', () => {
    const check = validateCapabilityFinding({
      ...base,
      subject: 'CERTIFICATION_AND_APPROVAL',
      observedOn: '2026-05-01',
      qualifier: 'SMALLEST_CREDIBLE_ENTRY',
      basis: 'REGULATORY_FEE_SCHEDULE',
    });
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.value.amountLowMinor).toBeNull();
      expect(check.value.currency).toBeNull();
      // The basis still travels: what *kind* of figure is missing is known.
      expect(check.value.basis).toBe('REGULATORY_FEE_SCHEDULE');
    }
  });

  it('refuses a bare number with no currency', () => {
    const check = validateCapabilityFinding({
      ...base,
      observedOn: '2026-05-01',
      qualifier: 'TYPICAL_ENTRY',
      basis: 'PUBLISHED_PRICE_OR_SCHEDULE',
      amountLowMinor: 40_000_000,
      amountHighMinor: 40_000_000,
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toContain('ISO 4217');
  });

  it('refuses half a range, an inverted one, and a non-integer', () => {
    const shared = {
      ...base,
      observedOn: '2026-05-01',
      qualifier: 'TYPICAL_ENTRY',
      basis: 'PUBLISHED_PRICE_OR_SCHEDULE',
      currency: 'USD',
    };
    expect(validateCapabilityFinding({ ...shared, amountLowMinor: 100 }).ok).toBe(false);
    expect(
      validateCapabilityFinding({ ...shared, amountLowMinor: 500, amountHighMinor: 100 }).ok,
    ).toBe(false);
    expect(
      validateCapabilityFinding({ ...shared, amountLowMinor: 10.5, amountHighMinor: 10.5 }).ok,
    ).toBe(false);
    expect(
      validateCapabilityFinding({ ...shared, amountLowMinor: '12,500', amountHighMinor: '12,500' })
        .ok,
    ).toBe(false);
  });

  it('refuses a requirement with no scenario, no basis, or no date', () => {
    const full = {
      ...base,
      observedOn: '2026-05-01',
      qualifier: 'TYPICAL_ENTRY',
      basis: 'PUBLISHED_PRICE_OR_SCHEDULE',
    };
    expect(validateCapabilityFinding({ ...full, qualifier: undefined }).ok).toBe(false);
    expect(validateCapabilityFinding({ ...full, basis: undefined }).ok).toBe(false);
    expect(validateCapabilityFinding({ ...full, observedOn: undefined }).ok).toBe(false);
    // And a value outside the closed set, rather than near it.
    expect(validateCapabilityFinding({ ...full, qualifier: 'CHEAP' }).ok).toBe(false);
    expect(validateCapabilityFinding({ ...full, subject: 'A NEW FACTORY' }).ok).toBe(false);
  });

  it('refuses money on a finding that carries none', () => {
    const check = validateCapabilityFinding({
      where: 'claims[0]',
      finding: 'DEMAND_EVIDENCE',
      subject: 'UNIT_SHIPMENTS',
      observedOn: '2026-05-01',
      amountLowMinor: 100,
      amountHighMinor: 100,
      currency: 'USD',
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toContain('Only CAPITAL_REQUIREMENT');
  });
});

describe('the reading withholds a total rather than summing past a blank', () => {
  it('reports nothing at all when nothing has been asked', () => {
    const reading = readCapital([]);
    expect(reading.state).toBe('UNEXAMINED');
    expect(reading.scenarios).toEqual([]);
    expect(reading.cheapestFullyPriced).toBeNull();
  });

  it('totals a scenario whose every requirement carries a figure', async () => {
    const { programId, categoryId } = await programme();
    await file({ programId, categoryId, requirement: 'TOOLING_AND_EQUIPMENT', lowMinor: 48_000_000, highMinor: 48_000_000, currency: 'USD' });
    await file({ programId, categoryId, requirement: 'FACILITY', lowMinor: 12_000_000, highMinor: 20_000_000, currency: 'USD' });

    const reading = readCapital(await listCategoryCapital(programId));
    expect(reading.state).toBe('ESTABLISHED');
    const scenario = reading.scenarios[0]!;
    expect(scenario.totals).toEqual([
      { currency: 'USD', lowMinor: 60_000_000, highMinor: 68_000_000 },
    ]);
    expect(reading.cheapestFullyPriced?.scenario).toBe('SMALLEST_CREDIBLE_ENTRY');
  }, 60000);

  it('withholds the total and names what is missing', async () => {
    const { programId, categoryId } = await programme();
    await file({ programId, categoryId, requirement: 'TOOLING_AND_EQUIPMENT', lowMinor: 48_000_000, highMinor: 48_000_000, currency: 'USD' });
    await file({ programId, categoryId, requirement: 'CERTIFICATION_AND_APPROVAL', basis: 'REGULATORY_FEE_SCHEDULE' });

    const reading = readCapital(await listCategoryCapital(programId));
    expect(reading.state).toBe('PARTIAL');
    expect(reading.unpricedRequirements).toEqual(['CERTIFICATION_AND_APPROVAL']);
    expect(reading.cheapestFullyPriced).toBeNull();
    const scenario = reading.scenarios[0]!;
    // Null, and never the 48,000,000 that happens to be priced.
    expect(scenario.totals).toBeNull();
    expect(scenario.because).toContain('certification and approval');
    expect(reading.because).toContain('too low is the direction nobody checks');
  }, 60000);

  /**
   * A later published figure clears an earlier blank, and both rows stay.
   *
   * Rows are append-only (§5), so a requirement established with no figure and
   * priced in a later round has two rows. Reading them row-wise made the blank
   * **permanent** — no later evidence could ever clear it and the category
   * could never leave `COST_UNKNOWN`, which is a park rather than a bar. This
   * is the regression for that.
   */
  it('lets a later figure clear an earlier blank, keeping both rows', async () => {
    const { programId, categoryId } = await programme();
    await file({ programId, categoryId, requirement: 'CERTIFICATION_AND_APPROVAL', basis: 'REGULATORY_FEE_SCHEDULE', statement: 'No fee is published.' });
    expect(readCapital(await listCategoryCapital(programId)).state).toBe('PARTIAL');

    await file({ programId, categoryId, requirement: 'CERTIFICATION_AND_APPROVAL', basis: 'REGULATORY_FEE_SCHEDULE', lowMinor: 3_600_000, highMinor: 3_600_000, currency: 'USD', statement: 'The regulator has since published a fee of $36,000.' });

    const rows = await listCategoryCapital(programId);
    // Both, because evidence is never overwritten.
    expect(rows).toHaveLength(2);
    const reading = readCapital(rows);
    expect(reading.state).toBe('ESTABLISHED');
    expect(reading.scenarios[0]!.totals).toEqual([
      { currency: 'USD', lowMinor: 3_600_000, highMinor: 3_600_000 },
    ]);
  }, 60000);

  /**
   * Two published figures for one requirement widen the range; they are never
   * added and never averaged.
   *
   * Summing them would count a requirement once per source that priced it, so
   * a well-researched requirement would inflate the total in proportion to how
   * much evidence stood behind it — an error that gets *worse* the better the
   * research is. §14 already refuses averaging incompatible figures.
   */
  it('spans two published figures for one requirement rather than adding them', async () => {
    const { programId, categoryId } = await programme();
    await file({ programId, categoryId, requirement: 'TOOLING_AND_EQUIPMENT', lowMinor: 40_000_000, highMinor: 40_000_000, currency: 'USD', statement: 'One supplier lists $400,000.' });
    await file({ programId, categoryId, requirement: 'TOOLING_AND_EQUIPMENT', lowMinor: 55_000_000, highMinor: 60_000_000, currency: 'USD', basis: 'TRADE_PUBLICATION_ESTIMATE', statement: 'A trade publication reports $550,000 to $600,000.' });

    const reading = readCapital(await listCategoryCapital(programId));
    const total = reading.scenarios[0]!.totals![0]!;
    expect(total.lowMinor).toBe(40_000_000);
    expect(total.highMinor).toBe(60_000_000);
    // Not 95,000,000, which is what summing the rows would have produced.
    expect(total.lowMinor + total.highMinor).not.toBe(95_000_000 * 2);
  }, 60000);

  it('keeps two currencies apart rather than converting between them', async () => {
    const { programId, categoryId } = await programme();
    await file({ programId, categoryId, requirement: 'TOOLING_AND_EQUIPMENT', lowMinor: 48_000_000, highMinor: 48_000_000, currency: 'USD' });
    await file({ programId, categoryId, requirement: 'FACILITY', lowMinor: 9_000_000, highMinor: 9_000_000, currency: 'EUR' });

    const reading = readCapital(await listCategoryCapital(programId));
    expect(reading.scenarios[0]!.totals).toEqual([
      { currency: 'EUR', lowMinor: 9_000_000, highMinor: 9_000_000 },
      { currency: 'USD', lowMinor: 48_000_000, highMinor: 48_000_000 },
    ]);
    expect(reading.scenarios[0]!.because).toContain('needs a rate nobody recorded');
  }, 60000);

  it('never mixes two shapes of the business into one figure', async () => {
    const { programId, categoryId } = await programme();
    await file({ programId, categoryId, requirement: 'TOOLING_AND_EQUIPMENT', scenario: 'SMALLEST_CREDIBLE_ENTRY', lowMinor: 48_000_000, highMinor: 48_000_000, currency: 'USD' });
    await file({ programId, categoryId, requirement: 'TOOLING_AND_EQUIPMENT', scenario: 'AT_PRODUCTION_SCALE', lowMinor: 900_000_000, highMinor: 900_000_000, currency: 'USD' });

    const reading = readCapital(await listCategoryCapital(programId));
    expect(reading.scenarios.map((one) => one.scenario)).toEqual([
      'SMALLEST_CREDIBLE_ENTRY',
      'AT_PRODUCTION_SCALE',
    ]);
    // Smallest first in the vocabulary's own order, which is what "cheapest"
    // means here — a fact about the vocabulary rather than an arithmetic claim
    // comparing two different businesses.
    expect(reading.cheapestFullyPriced?.scenario).toBe('SMALLEST_CREDIBLE_ENTRY');
  }, 60000);
});

describe('a blank never makes anything look better', () => {
  /**
   * Invariant 39 at the number that would start a factory.
   *
   * An identical pair of categories where one is fully priced and the other
   * has a blank: the priced one must rank first. This is the exact shape §30
   * records `conservativeContribution` getting wrong in the other direction —
   * the card refused the blank and the ranking rewarded it.
   */
  it('ranks a fully-priced category above an identical one with a blank', async () => {
    const { programId, categoryId } = await programme();
    const other = await createCategory({
      programId,
      projectId,
      parentId: null,
      kind: 'PRODUCT_CATEGORY',
      name: 'Portable generators',
      description: null,
      origin: 'SEED',
      sourceClaimId: null,
    });
    const otherId = other.category.id;

    await file({ programId, categoryId, requirement: 'TOOLING_AND_EQUIPMENT', lowMinor: 48_000_000, highMinor: 48_000_000, currency: 'USD' });
    await file({ programId, categoryId: otherId, requirement: 'TOOLING_AND_EQUIPMENT', basis: 'PUBLISHED_PRICE_OR_SCHEDULE' });

    const snapshot = await ladderSnapshot(projectId);
    const ranked = rankCategories(readLadder(snapshot!));
    const priced = ranked.find((one) => one.categoryId === categoryId)!;
    const blank = ranked.find((one) => one.categoryId === otherId)!;

    expect(priced.position).toBeLessThan(blank.position);
    const cost = (entry: typeof priced) =>
      entry.factors.find((one) => one.factor === 'ENTRY_COST_KNOWN')!.value;
    expect(cost(priced)).toBeLessThan(cost(blank));
  }, 60000);

  it('never reads a partial capital reading as established', async () => {
    const { programId, categoryId } = await programme();
    await file({ programId, categoryId, requirement: 'TOOLING_AND_EQUIPMENT', lowMinor: 1, highMinor: 1, currency: 'USD' });
    await file({ programId, categoryId, requirement: 'FACILITY' });

    const snapshot = await ladderSnapshot(projectId);
    const reading = readLadder(snapshot!).find((one) => one.categoryId === categoryId)!;
    const cost = reading.conditions.find((one) => one.condition === 'ENTRY_COST_ESTABLISHED')!;
    expect(cost.answer).toBe('UNKNOWN');
    expect(cost.answer).not.toBe('MET');
  }, 60000);
});

describe('the projection a browser receives carries it', () => {
  it('sends the reading, the counts and the null total', async () => {
    const { programId, categoryId } = await programme();
    await file({ programId, categoryId, requirement: 'TOOLING_AND_EQUIPMENT', lowMinor: 48_000_000, highMinor: 48_000_000, currency: 'USD' });
    await file({ programId, categoryId, requirement: 'CERTIFICATION_AND_APPROVAL', basis: 'REGULATORY_FEE_SCHEDULE' });

    const view = await programmeView(projectId);
    expect(view).toBeTruthy();
    expect(view!.counts.capitalRequirements).toBe(2);
    expect(view!.counts.capitalRequirementsPriced).toBe(1);

    const reading = view!.ladder.find((one) => one.categoryId === categoryId)!;
    expect(reading.capital.state).toBe('PARTIAL');
    // Null crosses the wire as null. A projection that defaulted it to zero
    // would put back the exact defect the server refuses, one layer out.
    expect(reading.capital.scenarios[0]!.totals).toBeNull();
    expect(JSON.stringify(view)).not.toContain('"totals":[]');

    // And the frontier's own factor says the same thing in its own words.
    const entry = view!.frontier.find((one) => one.categoryId === categoryId)!;
    const cost = entry.factors.find((one) => one.factor === 'ENTRY_COST_KNOWN')!;
    expect(cost.because).toContain('certification and approval');
  }, 60000);
});

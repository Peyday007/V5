import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MECHANISM_PROMPTS,
  claimsFromCategoryRows,
  reconstructCompetitiveSystem,
  type CategoryRows,
  type CompetitiveClaim,
} from '../server/services/manufacturing/competitiveSystem.ts';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { ensureCapability, getProgram, recordCategoryCapital, recordCategoryEvidence, recordEdge } from '../server/repos/manufacturing.ts';
import { startProgramme } from '../server/services/manufacturing/program.ts';
import { seedCategory } from '../server/services/manufacturing/declare.ts';
import { runManufacturingKernel } from '../server/services/manufacturing/kernel.ts';
import type { Layer } from '../server/domain/types.ts';

/*
 * VENT-24-1 on two industries that share nothing: commercial pressure washers
 * (hardware, dealer channel) and a B2B payroll API (software, regulated data).
 * Nothing in the module names either, and the maps they produce must differ.
 */

const src = (n: number) => `https://example.org/source/${n}`;
let seq = 0;
function claim(part: Partial<CompetitiveClaim> & Pick<CompetitiveClaim, 'mechanism'>): CompetitiveClaim {
  seq += 1;
  return { id: `clm_${seq}`, accepted: true, sourceUrl: src(seq), statement: `${part.mechanism} statement ${seq}`, ...part };
}

const washers: CompetitiveClaim[] = [
  claim({ mechanism: 'Dealer distribution', activity: { name: 'regional distribution', mode: 'PARTNER', reason: 'dealers own the service relationship' } }),
  claim({ mechanism: 'Pump sourcing', activity: { name: 'pump supply', mode: 'CONTRACT', reason: 'two OEM pump makers sell to all assemblers' } }),
  claim({ mechanism: 'Replacement parts aftermarket', profitPool: { name: 'replacement parts', marginShare: 0.45 } }),
  claim({ mechanism: 'Dealer distribution', profitPool: { name: 'dealer margin', marginShare: 0.25 } }),
  claim({ mechanism: 'Installed service network', advantage: { resource: 'service-dealer footprint' } }),
  claim({ mechanism: 'Pressure rating certification', condition: { level: 'PRODUCT', requirement: 'UL listing for the motor', met: true } }),
  claim({ mechanism: 'Dealer distribution', condition: { level: 'SELLING_COMPANY', requirement: 'signed dealer agreements', met: false } }),
  claim({ mechanism: 'Installed service network', condition: { level: 'DURABLE_POSITION', requirement: 'parts availability within 48h', met: null } }),
];

const payroll: CompetitiveClaim[] = [
  claim({ mechanism: 'Data-security compliance (SOC 2)', condition: { level: 'SELLING_COMPANY', requirement: 'SOC 2 Type II report', met: true } }),
  claim({ mechanism: 'Integration switching costs', advantage: { resource: 'embedded HRIS integrations' } }),
  claim({ mechanism: 'Float on held funds', profitPool: { name: 'interest on payroll float', marginShare: 0.3 } }),
  claim({ mechanism: 'Money transmission licensing', activity: { name: 'moving client funds', mode: 'PARTNER', reason: 'a licensed bank partner holds the licence' } }),
  claim({ mechanism: 'Money transmission licensing', activity: { name: 'moving client funds', mode: 'OWN_OR_DEVELOP', reason: 'scale players hold their own licences' } }),
  claim({ mechanism: 'Tax-table maintenance', condition: { level: 'PRODUCT', requirement: 'current tax tables in every state served', met: true } }),
  claim({ mechanism: 'Integration switching costs', condition: { level: 'DURABLE_POSITION', requirement: 'integration count above competitors', met: true } }),
];

describe('VENT-24-1: the mechanism map comes from the evidence', () => {
  const a = reconstructCompetitiveSystem({ subjectPath: ['powered cleaning equipment', 'commercial pressure washers'], claims: washers });
  const b = reconstructCompetitiveSystem({ subjectPath: ['business software', 'payroll APIs'], claims: payroll });

  it('lists exactly the mechanisms accepted claims name, each with its claim ids', () => {
    expect(a.mechanisms.map((m) => m.name).sort()).toEqual(
      ['Dealer distribution', 'Installed service network', 'Pressure rating certification', 'Pump sourcing', 'Replacement parts aftermarket'].sort(),
    );
    const dealer = a.mechanisms.find((m) => m.name === 'Dealer distribution')!;
    expect(dealer.claimIds).toHaveLength(3);
    for (const m of [...a.mechanisms, ...b.mechanisms]) expect(m.claimIds.length).toBeGreaterThan(0);
  });

  it('two unrelated industries produce different mechanism sets, and the count follows the evidence', () => {
    const names = (s: typeof a) => new Set(s.mechanisms.map((m) => m.key));
    const shared = [...names(a)].filter((k) => names(b).has(k));
    expect(shared).toEqual([]);
    const more = reconstructCompetitiveSystem({
      subjectPath: ['business software', 'payroll APIs'],
      claims: [...payroll, claim({ mechanism: 'Year-end filing deadlines', statement: 'W-2 deadline concentrates demand' })],
    });
    expect(more.mechanisms.length).toBe(b.mechanisms.length + 1);
  });

  it('keeps a mechanism no prompt anticipated', () => {
    const float = b.mechanisms.find((m) => m.name === 'Float on held funds');
    expect(float).toBeDefined();
    expect(MECHANISM_PROMPTS.some((p) => p.matches.test(float!.key))).toBe(false);
  });

  it('puts no prompt on the map: with no evidence the map is empty and every prompt is an open question', () => {
    const empty = reconstructCompetitiveSystem({ subjectPath: ['anything'], claims: [] });
    expect(empty.mechanisms).toEqual([]);
    expect(empty.openQuestions.map((q) => q.prompt)).toEqual(MECHANISM_PROMPTS.map((p) => p.prompt));
    expect(empty.openQuestions[0]!.question).toContain('anything');
  });

  it('turns a specification mechanism with no evidence into an open question, not a fact', () => {
    const prompts = a.openQuestions.map((q) => q.prompt);
    expect(prompts).toContain('sales cycles, cash conversion and working capital');
    expect(prompts).not.toContain('distribution and marketing');
    expect(a.mechanisms.some((m) => /working capital/.test(m.key))).toBe(false);
    expect(a.openQuestions[0]!.question).toContain('powered cleaning equipment → commercial pressure washers');
  });

  it('ignores claims that did not clear the gate or carry no source, and says why', () => {
    const s = reconstructCompetitiveSystem({
      subjectPath: ['x'],
      claims: [
        { id: 'c1', accepted: false, sourceUrl: src(1), mechanism: 'Rumoured moat', statement: 's' },
        { id: 'c2', accepted: true, sourceUrl: null, mechanism: 'Unsourced moat', statement: 's' },
      ],
    });
    expect(s.mechanisms).toEqual([]);
    expect(s.ignored).toEqual([
      { claimId: 'c1', why: 'not accepted by the evidence gate' },
      { claimId: 'c2', why: 'carries no source' },
    ]);
  });
});

describe('VENT-24-1: profit pools, advantage and rent-versus-own, each with evidence', () => {
  const a = reconstructCompetitiveSystem({ subjectPath: ['pressure washers'], claims: washers });
  const b = reconstructCompetitiveSystem({ subjectPath: ['payroll APIs'], claims: payroll });

  it('ranks profit pools by stated margin, each citing its claims', () => {
    expect(a.profitPools.map((p) => p.name)).toEqual(['replacement parts', 'dealer margin']);
    expect(a.profitPools[0]!.claimIds).toHaveLength(1);
    expect(b.profitPools.map((p) => p.name)).toEqual(['interest on payroll float']);
  });

  it('names the resources that confer advantage', () => {
    expect(a.advantages.map((x) => x.resource)).toEqual(['service-dealer footprint']);
    expect(b.advantages.map((x) => x.resource)).toEqual(['embedded HRIS integrations']);
  });

  it('classifies each activity with its reason, and flags a contested one at the most committed mode', () => {
    expect(a.activities.map((x) => [x.activity, x.mode])).toEqual([
      ['regional distribution', 'PARTNER'],
      ['pump supply', 'CONTRACT'],
    ]);
    const funds = b.activities.find((x) => x.activity === 'moving client funds')!;
    expect(funds.contested).toBe(true);
    expect(funds.mode).toBe('OWN_OR_DEVELOP');
    expect(funds.reasons).toHaveLength(2);
    expect(funds.claimIds).toHaveLength(2);
  });
});

describe('VENT-24-1: product, selling company and durable position are separate readings', () => {
  const a = reconstructCompetitiveSystem({ subjectPath: ['pressure washers'], claims: washers });
  const b = reconstructCompetitiveSystem({ subjectPath: ['payroll APIs'], claims: payroll });

  it('reads each level from its own conditions', () => {
    expect(a.readings.PRODUCT.verdict).toBe('ESTABLISHED');
    expect(a.readings.SELLING_COMPANY.verdict).toBe('NOT_MET');
    expect(a.readings.SELLING_COMPANY.unmet.map((u) => u.requirement)).toEqual(['signed dealer agreements']);
    expect(a.readings.DURABLE_POSITION.verdict).toBe('UNKNOWN');
    expect(a.readings.DURABLE_POSITION.unknown.map((u) => u.requirement)).toEqual(['parts availability within 48h']);
    expect(b.readings.PRODUCT.verdict).toBe('ESTABLISHED');
    expect(b.readings.SELLING_COMPANY.verdict).toBe('ESTABLISHED');
    expect(b.readings.DURABLE_POSITION.verdict).toBe('ESTABLISHED');
  });

  it('never establishes a level on an unknown or on no conditions at all', () => {
    const s = reconstructCompetitiveSystem({
      subjectPath: ['x'],
      claims: [
        claim({ mechanism: 'Tooling', condition: { level: 'PRODUCT', requirement: 'tooling', met: true } }),
        claim({ mechanism: 'Tooling', condition: { level: 'PRODUCT', requirement: 'tooling', met: null } }),
      ],
    });
    expect(s.readings.PRODUCT.verdict).toBe('UNKNOWN');
    expect(s.readings.SELLING_COMPANY.verdict).toBe('UNKNOWN');
    expect(s.readings.SELLING_COMPANY.because).toContain('no claim states');
  });

  it('lets a single "not met" outweigh agreeing claims', () => {
    const s = reconstructCompetitiveSystem({
      subjectPath: ['x'],
      claims: [
        claim({ mechanism: 'Channel', condition: { level: 'SELLING_COMPANY', requirement: 'channel access', met: true } }),
        claim({ mechanism: 'Channel', condition: { level: 'SELLING_COMPANY', requirement: 'Channel  access', met: false } }),
      ],
    });
    expect(s.readings.SELLING_COMPANY.verdict).toBe('NOT_MET');
    expect(s.readings.SELLING_COMPANY.unmet[0]!.claimIds).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------- */
/* Fed from the ladder's rows and the claims store, on the kernel tick         */
/* ------------------------------------------------------------------------- */

describe('VENT-24-1: the ladder rows become competitive claims without a blueprint', () => {
  const rows: CategoryRows = {
    categoryId: 'mca_1',
    path: ['Cleaning equipment', 'Commercial pressure washers'],
    evidence: [
      { kind: 'DISTRIBUTION_CHANNEL', subject: 'Equipment dealers', statement: 'Most units sell through dealers', sourceClaimId: 'clm_a' },
      { kind: 'ENTRY_BARRIER', subject: 'UL certification', statement: 'Motors need UL listing', sourceClaimId: 'clm_b' },
      { kind: 'BOUGHT_IN_COMPONENT', subject: 'Triplex pumps', statement: 'Assemblers buy pumps from OEMs', sourceClaimId: 'clm_c' },
      { kind: 'DEMAND_EVIDENCE', subject: 'Fleet washing', statement: 'Unsourced', sourceClaimId: 'clm_unsourced' },
    ],
    capital: [{ requirement: 'TOOLING_AND_EQUIPMENT', statement: 'Rigs cost $40k', sourceClaimId: 'clm_d' }],
    candidates: [{ name: 'Set-aside Co', statement: 'x', sourceClaimId: 'clm_e', setAsideAt: '2026-10-01T00:00:00.000Z' }],
    requires: [{ name: 'Pump assembly', heldAt: null, sourceClaimId: 'clm_f' }],
  };
  const gate = new Map([
    ['clm_a', { accepted: true, sourceUrl: 'https://example.test/a' }],
    ['clm_b', { accepted: true, sourceUrl: 'https://example.test/b' }],
    ['clm_c', { accepted: true, sourceUrl: 'https://example.test/c' }],
    ['clm_unsourced', { accepted: true, sourceUrl: null }],
    ['clm_d', { accepted: true, sourceUrl: 'https://example.test/d' }],
    ['clm_f', { accepted: true, sourceUrl: 'https://example.test/f' }],
  ]);

  it('names every mechanism from its row, takes gate state from the store, and drops set-aside candidates', () => {
    const s = reconstructCompetitiveSystem({ subjectPath: rows.path, claims: claimsFromCategoryRows(rows, gate) });
    expect(s.mechanisms.map((m) => m.name)).toEqual([
      'distribution channel: Equipment dealers',
      'entry barrier: UL certification',
      'sourcing of bought-in components: Triplex pumps',
      'capital requirement: tooling and equipment',
      'production capability: Pump assembly',
    ]);
    expect(s.ignored).toEqual([{ claimId: 'clm_unsourced', why: 'carries no source' }]);
    expect(s.activities).toEqual([
      expect.objectContaining({ activity: 'Triplex pumps', mode: 'CONTRACT', contested: false }),
    ]);
    expect(s.readings.SELLING_COMPANY.verdict).toBe('UNKNOWN');
    expect(s.readings.PRODUCT.verdict).toBe('NOT_MET');
    expect(s.openQuestions.map((q) => q.prompt)).toContain('customer segments');
  });

  it('reads a claim the store does not return as not evidence', () => {
    const s = reconstructCompetitiveSystem({ subjectPath: rows.path, claims: claimsFromCategoryRows(rows, new Map()) });
    expect(s.mechanisms).toEqual([]);
    expect(s.ignored.every((i) => i.why === 'not accepted by the evidence gate')).toBe(true);
  });

  it('has a production caller: the manufacturing kernel calls it on the tick', () => {
    const kernel = readFileSync(new URL('../server/services/manufacturing/kernel.ts', import.meta.url), 'utf8');
    expect(kernel).toMatch(/from '\.\/competitiveSystem\.ts'/);
    expect(kernel).toMatch(/competitiveSystemsFor\(/);
  });
});

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `competitive-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
    isBrainAdmin: true,
  });
  userId = user.id;
});

/** One gated, sourced research claim in the claims store; `accepted` decides its gate state. */
async function storedClaim(text: string, accepted = true): Promise<string> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a programme round' });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'a programme round',
    assignment: 'how this market works',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'the markets the programme may look at',
      requiredEvidence: [{ id: 'market', description: 'how the market works', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a published source'],
      excludedSourceTypes: ['an unsourced assertion'],
      completionCriteria: ['every finding declared'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'competitive',
      question: 'How does this market work?',
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const [claim] = await insertClaims([
    {
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: text,
      sourceUrl: `https://example.test/${encodeURIComponent(text)}`,
      sourceTitle: 'A source',
      sourcePublisher: 'A publisher',
      sourceDate: '2026-09-10',
      evidenceExcerpt: text,
      evidenceLocator: 'p. 1',
      evidenceLane: 'market',
      retrievedAt: '2026-09-12',
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: text,
    },
  ] as unknown as Parameters<typeof insertClaims>[0]);
  await decideClaim(claim!.id, { accepted });
  return claim!.id;
}

describe('VENT-24-1: the kernel reconstructs each category from the claims its rows were filed from', () => {
  it('produces the competitive system on the tick from production rows, and drops a claim the gate since rejected', async () => {
    const started = await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Build machines only where demand and capability allow.' });
    expect(started.ok).toBe(true);
    const program = (await getProgram(projectId))!;
    const seeded = await seedCategory({ projectId, name: 'Commercial pressure washers', actorRef: userId, reason: 'test' });
    if ('error' in seeded) throw new Error(seeded.error);
    const category = seeded.category;

    const dealers = await storedClaim('Most commercial units sell through equipment dealers');
    await recordCategoryEvidence({ programId: program.id, categoryId: category.id, kind: 'DISTRIBUTION_CHANNEL', subject: 'Equipment dealers', statement: 'Most commercial units sell through equipment dealers', sourceClaimId: dealers });
    const pumps = await storedClaim('Assemblers buy triplex pumps from two OEMs');
    await recordCategoryEvidence({ programId: program.id, categoryId: category.id, kind: 'BOUGHT_IN_COMPONENT', subject: 'Triplex pumps', statement: 'Assemblers buy triplex pumps from two OEMs', sourceClaimId: pumps });
    const rejected = await storedClaim('Demand is booming everywhere', false);
    await recordCategoryEvidence({ programId: program.id, categoryId: category.id, kind: 'DEMAND_EVIDENCE', subject: 'Everywhere', statement: 'Demand is booming everywhere', observedOn: '2026-09-01', sourceClaimId: rejected });
    const { capability } = await ensureCapability({ programId: program.id, projectId, name: 'High-pressure pump assembly', origin: 'SEED' });
    await recordEdge({ programId: program.id, categoryId: category.id, capabilityId: capability.id, relation: 'REQUIRES', statement: 'Assembly requires a pressure-tested line', sourceClaimId: await storedClaim('Assembly requires a pressure-tested line') });
    await recordCategoryCapital({
      programId: program.id,
      categoryId: category.id,
      requirement: 'TOOLING_AND_EQUIPMENT',
      scenario: 'SMALLEST_CREDIBLE_ENTRY',
      amountLowMinor: 40_000_00,
      amountHighMinor: 60_000_00,
      currency: 'USD',
      basis: 'PUBLISHED_PRICE_OR_SCHEDULE',
      asOf: '2026-09-01',
      statement: 'A test rig and fixtures cost $40,000–$60,000',
      sourceClaimId: await storedClaim('A test rig and fixtures cost $40,000–$60,000'),
    });

    const pass = await runManufacturingKernel(projectId);
    const system = pass.competitive.find((s) => s.categoryId === category.id);
    expect(system).toBeDefined();
    expect(system!.subject).toContain('Commercial pressure washers');
    expect(system!.mechanisms.map((m) => m.name).sort()).toEqual([
      'capital requirement: tooling and equipment',
      'distribution channel: Equipment dealers',
      'production capability: High-pressure pump assembly',
      'sourcing of bought-in components: Triplex pumps',
    ]);
    expect(system!.mechanisms.find((m) => m.name.startsWith('distribution'))!.claimIds).toEqual([dealers]);
    expect(system!.ignored).toEqual([{ claimId: rejected, why: 'not accepted by the evidence gate' }]);
    expect(system!.activities).toEqual([expect.objectContaining({ activity: 'Triplex pumps', mode: 'CONTRACT', claimIds: [pumps] })]);
    expect(system!.readings.PRODUCT.verdict).toBe('NOT_MET');
    expect(system!.openQuestions.map((q) => q.prompt)).toContain('customer segments');
  });
});

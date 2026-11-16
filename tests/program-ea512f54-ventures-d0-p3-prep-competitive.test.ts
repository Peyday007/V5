import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { getProgram, recordCategoryEvidence } from '../server/repos/manufacturing.ts';
import { startProgramme } from '../server/services/manufacturing/program.ts';
import { seedCategory } from '../server/services/manufacturing/declare.ts';
import { runManufacturingKernel } from '../server/services/manufacturing/kernel.ts';
import type { Layer } from '../server/domain/types.ts';
import {
  MECHANISM_PROMPTS,
  reconstructCompetitiveSystem,
  type CompetitiveClaim,
} from '../server/services/manufacturing/competitiveSystem.ts';

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

/** One accepted, sourced claim, so the capital and requirement rows have the evidence the schema demands. */
async function acceptedClaim(projectId: string, layer: Layer, text: string, sourceUrl: string | null = 'https://example.test/source'): Promise<string> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a programme round' });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'a programme round',
    assignment: 'what building this takes',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'the markets the programme may look at',
      requiredEvidence: [{ id: 'requires', description: 'what producing needs', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a published requirement'],
      excludedSourceTypes: ['an unsourced assertion'],
      completionCriteria: ['every finding declared'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'venture-path',
      question: 'What does producing this require?',
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
      sourceUrl,
      sourceTitle: 'A source',
      sourcePublisher: 'A publisher',
      sourceDate: '2026-09-10',
      evidenceExcerpt: text,
      evidenceLocator: 'p. 1',
      evidenceLane: 'requires',
      retrievedAt: '2026-09-12',
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: text,
    },
  ] as unknown as Parameters<typeof insertClaims>[0]);
  await decideClaim(claim!.id, { accepted: true });
  return claim!.id;
}

describe('VENT-24-1: the reconstruction runs on production records', () => {
  it('the manufacturing kernel reconstructs each category from the evidence its research filed, ignoring an unsourced claim', async () => {
    const fixture = await freshProject();
    const projectId = fixture.project.id;
    const layer = await fixture.layerByName('Discovery Logic');
    const user = await createUser({ email: `competitive-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple', isBrainAdmin: true });
    expect((await startProgramme({ projectId, ownerUserId: user.id, actorUserId: user.id, objective: 'Build machines only where demand and capability allow.' })).ok).toBe(true);
    const program = (await getProgram(projectId))!;
    const seeded = await seedCategory({ projectId, name: 'Commercial pressure washers', actorRef: user.id, reason: 'test' });
    if ('error' in seeded) throw new Error(seeded.error);
    const category = seeded.category;

    const demand = await acceptedClaim(projectId, layer, 'Fleet operators publish tenders for pressure washers every quarter');
    await recordCategoryEvidence({ programId: program.id, categoryId: category.id, kind: 'DEMAND_EVIDENCE', subject: 'fleet washing tenders', statement: 'Fleet operators publish tenders every quarter', observedOn: '2026-09-01', sourceClaimId: demand });
    const pump = await acceptedClaim(projectId, layer, 'High-pressure pumps are bought in from two suppliers');
    await recordCategoryEvidence({ programId: program.id, categoryId: category.id, kind: 'BOUGHT_IN_COMPONENT', subject: 'high-pressure pump', statement: 'Pumps are bought in from two suppliers', sourceClaimId: pump });
    const unsourced = await acceptedClaim(projectId, layer, 'Dealers dominate distribution', null);
    await recordCategoryEvidence({ programId: program.id, categoryId: category.id, kind: 'DISTRIBUTION_CHANNEL', subject: 'dealer network', statement: 'Dealers dominate distribution', sourceClaimId: unsourced });

    const pass = await runManufacturingKernel(projectId);
    const system = pass.competitive.find((one) => one.subject === 'Commercial pressure washers')!;
    expect(system, 'the pass carries the category reconstruction').toBeDefined();
    expect(system.mechanisms.map((m) => m.name).sort()).toEqual(['fleet washing tenders', 'high-pressure pump']);
    expect(system.activities).toEqual([expect.objectContaining({ activity: 'high-pressure pump', mode: 'CONTRACT' })]);
    expect(system.readings.SELLING_COMPANY.met.map((m) => m.requirement)).toContain('published demand: fleet washing tenders');
    // A claim with no source is not evidence and never reaches the map.
    expect(system.ignored.map((one) => one.claimId)).toEqual([unsourced]);
    expect(system.openQuestions.length).toBeGreaterThan(0);
  });

  it('a project with no programme reconstructs nothing', async () => {
    const fixture = await freshProject();
    expect((await runManufacturingKernel(fixture.project.id)).competitive).toEqual([]);
  });
});

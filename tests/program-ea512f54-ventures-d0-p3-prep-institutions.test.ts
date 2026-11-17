/**
 * INST-30 — institutional machinery is derived from a venture's facts, costed
 * or withheld, read four ways, and never created.
 *
 * Two unrelated ventures drive every statement, and the module names neither:
 * what triggers an element is the shape of a fact (a party, a flow, a risk, a
 * claim), never what the venture sells.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { getProgram, recordCategoryCapital, recordCategoryEvidence } from '../server/repos/manufacturing.ts';
import { startProgramme } from '../server/services/manufacturing/program.ts';
import { seedCategory } from '../server/services/manufacturing/declare.ts';
import { runManufacturingKernel } from '../server/services/manufacturing/kernel.ts';
import type { Layer } from '../server/domain/types.ts';
import {
  deriveInstitutions,
  readEconomics,
  type EvidenceClaim,
  type StructureReading,
  type VentureFacts,
} from '../server/services/manufacturing/institutions.ts';

const base = (over: Partial<VentureFacts>): VentureFacts => ({
  ventureId: 'v',
  activities: [],
  jurisdictions: ['XA'],
  parties: [{ id: 'own-1', role: 'OWNER', jurisdiction: 'XA' }],
  flows: [],
  risks: [],
  ipAssets: [],
  claims: [],
  held: [],
  approvals: [],
  economics: null,
  asOf: '2026-11-16T00:00:00.000Z',
  ...over,
});

const cost = (id: string, subject: string, low: number, high: number, recurrence: EvidenceClaim['recurrence'] = 'ONE_TIME', currency = 'USD'): EvidenceClaim => ({
  id, sourceId: `src-${id}`, kind: 'COST', subject, jurisdiction: 'XA', amountLowMinor: low, amountHighMinor: high, currency, recurrence,
});

/** Venture A: a solo service sold to two customers, delivered with one subcontractor, one liability risk. */
const ventureA = (): VentureFacts =>
  base({
    ventureId: 'venture-a',
    activities: ['deliver a recurring service to businesses'],
    parties: [
      { id: 'own-1', role: 'OWNER', jurisdiction: 'XA' },
      { id: 'cust-1', role: 'CUSTOMER', jurisdiction: 'XA' },
      { id: 'sub-1', role: 'CONTRACTOR', jurisdiction: 'XA', createsIp: true },
    ],
    flows: [{ kind: 'SALE', partyId: 'cust-1' }, { kind: 'PURCHASE', partyId: 'sub-1' }],
    risks: [{ kind: 'PROFESSIONAL_LIABILITY' }],
    claims: [{ id: 'c-tax', sourceId: 'src-tax', kind: 'TAX_OBLIGATION', subject: 'sales tax on services', jurisdiction: 'XA' }],
    economics: { capitalMinor: 100_000, monthlyRunningMinor: 50_000, monthlyRevenueMinor: 400_000, currency: 'USD' },
  });

/** Venture B: two owners make a physical product abroad, borrow, and one activity is restricted. */
const ventureB = (): VentureFacts =>
  base({
    ventureId: 'venture-b',
    activities: ['make and import a physical product', 'arrange consumer financing for buyers'],
    jurisdictions: ['XA', 'XB'],
    parties: [
      { id: 'own-1', role: 'OWNER', jurisdiction: 'XA' },
      { id: 'own-2', role: 'OWNER', jurisdiction: 'XA' },
      { id: 'mfr-1', role: 'MANUFACTURER', jurisdiction: 'XB' },
      { id: 'dist-1', role: 'DISTRIBUTOR', jurisdiction: 'XA' },
      { id: 'bank-1', role: 'LENDER', jurisdiction: 'XA' },
    ],
    flows: [{ kind: 'SALE', partyId: 'dist-1' }, { kind: 'PURCHASE', partyId: 'mfr-1' }, { kind: 'BORROWING', partyId: 'bank-1' }],
    risks: [{ kind: 'PRODUCT_LIABILITY' }],
    ipAssets: ['product design'],
    claims: [
      { id: 'c-permit', sourceId: 'src-p', kind: 'PERMIT_REQUIRED', subject: 'import of the product', jurisdiction: 'XA' },
      { id: 'c-limit', sourceId: 'src-l', kind: 'REGULATORY_LIMITATION', subject: 'consumer credit arrangement', jurisdiction: 'XA' },
      { id: 'c-renew', sourceId: 'src-r', kind: 'RENEWAL', subject: 'PERMIT:import of the product', jurisdiction: 'XA', intervalMonths: 12 },
      cost('c-cost-permit', 'PERMIT:import of the product', 30_000, 50_000),
    ],
  });

const byKind = (structures: StructureReading[], kind: StructureReading['kind']) => structures.find((one) => one.kind === kind)!;

describe('INST-30 — only what the facts trigger', () => {
  it('a venture whose facts trigger nothing gets an empty set, not a default checklist', () => {
    const out = deriveInstitutions(base({ ventureId: 'idle', parties: [] }));
    expect(out.structures[0]!.kind).toBe('DIRECT');
    expect(out.structures[0]!.elements).toEqual([]);
    expect(out.structures[0]!.readiness).toBe('MET');
    expect(out.openQuestions).toEqual([]);
  });

  it('venture A: elements come from its own parties, flows, risks and claims, each traced to its trigger', () => {
    const out = deriveInstitutions(ventureA());
    const direct = byKind(out.structures, 'DIRECT');
    const kinds = new Set(direct.elements.map((one) => one.kind));
    for (const kind of ['CONTRACT', 'SIGNING_AUTHORITY', 'IP_OWNERSHIP', 'PAYMENT_ACCOUNT', 'ACCOUNTING_BOOKS', 'INSURANCE', 'TAX_REGISTRATION', 'EXTERNAL_PROVIDER'] as const) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    // Nothing in A's facts calls for an entity, a permit, a licence, borrowing or intercompany dealings.
    for (const kind of ['LEGAL_ENTITY', 'PERMIT', 'LICENSE', 'FINANCING_COVENANT', 'INTERCOMPANY'] as const) {
      expect(kinds.has(kind), kind).toBe(false);
    }
    expect(out.structures.some((one) => one.kind === 'MULTI_ENTITY')).toBe(false);
    for (const element of direct.elements) {
      expect(element.triggeredBy.length, element.key).toBeGreaterThan(0);
      expect(element.enables.length, element.key).toBeGreaterThan(0);
      expect(Array.isArray(element.prerequisites) && Array.isArray(element.obligations)).toBe(true);
    }
  });

  it('venture B: two owners require an entity, two jurisdictions admit subsidiaries, a renewal claim dates the permit', () => {
    const out = deriveInstitutions(ventureB());
    const direct = byKind(out.structures, 'DIRECT');
    expect(direct.legalFeasibility).toBe('NOT_MET');
    expect(direct.because.join(' ')).toMatch(/2 owners share the venture/);
    const multi = byKind(out.structures, 'MULTI_ENTITY');
    expect(multi.elements.some((one) => one.kind === 'INTERCOMPANY')).toBe(true);
    const single = byKind(out.structures, 'SINGLE_ENTITY');
    const entity = single.elements.find((one) => one.kind === 'LEGAL_ENTITY')!;
    expect(entity.necessity).toBe('REQUIRED');
    expect(single.elements.filter((one) => one.kind === 'OWNERSHIP')).toHaveLength(2);
    expect(single.elements.some((one) => one.kind === 'BENEFICIAL_INTEREST')).toBe(true);
    expect(single.elements.some((one) => one.kind === 'FINANCING_COVENANT')).toBe(true);
    const permit = single.elements.find((one) => one.kind === 'PERMIT')!;
    expect(permit.renewalDate).toBe('2027-11-16');
    expect(permit.cost?.oneTime).toEqual({ currency: 'USD', lowMinor: 30_000, highMinor: 50_000 });
  });
});

describe('INST-30 — four readings, and an unknown never helps', () => {
  it('every structure carries desirability, legal feasibility, readiness and authorisation separately', () => {
    for (const facts of [ventureA(), ventureB()]) {
      for (const structure of deriveInstitutions(facts).structures) {
        for (const field of ['desirability', 'legalFeasibility', 'readiness', 'authorization'] as const) {
          expect(['MET', 'NOT_MET', 'UNKNOWN']).toContain(structure[field]);
        }
      }
    }
  });

  it('an unstated jurisdiction is an open question that keeps feasibility and readiness from MET', () => {
    const facts = ventureA();
    facts.jurisdictions = [];
    facts.parties = facts.parties.map((one) => ({ ...one, jurisdiction: null }));
    const out = deriveInstitutions(facts);
    expect(out.openQuestions).toContain('no jurisdiction is stated in the record');
    for (const structure of out.structures) {
      expect(structure.legalFeasibility, structure.kind).toBe('UNKNOWN');
      expect(structure.readiness, structure.kind).not.toBe('MET');
    }
    // Even with every element held, the open question keeps it from being ready.
    const held = deriveInstitutions({ ...facts, held: byKind(out.structures, 'DIRECT').elements.map((one) => one.key) });
    expect(byKind(held.structures, 'DIRECT').readiness).toBe('UNKNOWN');
  });

  it('UNKNOWN ranks like NOT_MET: a structure is never ranked higher for what nobody knows', () => {
    const out = deriveInstitutions(ventureB());
    const first = out.structures[0]!;
    // DIRECT is infeasible; nothing infeasible may lead while a feasible structure exists.
    expect(first.legalFeasibility).toBe('MET');
    expect(out.structures.at(-1)!.kind === 'DIRECT' || out.structures.findIndex((one) => one.kind === 'DIRECT') > 0).toBe(true);
  });
});

describe('INST-30 — approval is required, and nothing is created', () => {
  it('formation, regulated services, borrowing, legal commitments and account opening are REQUIRES_APPROVAL with a professional role', () => {
    const classes = new Set<string>();
    for (const facts of [ventureA(), ventureB()]) {
      for (const structure of deriveInstitutions(facts).structures) {
        for (const element of structure.elements) {
          const expected = ({ LEGAL_ENTITY: 'FORMATION', PAYMENT_ACCOUNT: 'ACCOUNT_OPENING', FINANCING_COVENANT: 'MATERIAL_BORROWING', CONTRACT: 'LEGAL_COMMITMENT', LICENSE: 'REGULATED_SERVICE', PERMIT: 'REGULATED_SERVICE' } as Record<string, string>)[element.kind];
          if (!expected) continue;
          expect(element.approval?.status, element.key).toBe('REQUIRES_APPROVAL');
          expect(element.approval?.class, element.key).toBe(expected);
          expect(element.approval?.professionalRole.length, element.key).toBeGreaterThan(0);
          classes.add(element.approval!.class);
        }
        if (structure.elements.some((one) => one.approval)) expect(structure.authorization).toBe('NOT_MET');
      }
    }
    expect([...classes].sort()).toEqual(['ACCOUNT_OPENING', 'FORMATION', 'LEGAL_COMMITMENT', 'MATERIAL_BORROWING', 'REGULATED_SERVICE']);
  });

  it('a recorded approval for every step is what authorises acting, and nothing else does', () => {
    const facts = ventureA();
    const direct = byKind(deriveInstitutions(facts).structures, 'DIRECT');
    const approvals = direct.elements.filter((one) => one.approval).map((one) => one.key);
    expect(byKind(deriveInstitutions({ ...facts, approvals }).structures, 'DIRECT').authorization).toBe('MET');
  });

  it('the module writes nothing: it imports no database, repository or effect path', () => {
    const source = readFileSync(new URL('../server/services/manufacturing/institutions.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import[^;]+from '([^']+)'/gm)].map((one) => one[1]);
    expect(imports.every((one) => one === './capital.ts' || one === './readiness.ts')).toBe(true);
    expect(source.match(/^import (?!type)/gm)).toBeNull();
  });
});

describe('INST-30 — a regulatory limitation yields compliant alternatives', () => {
  it('venture B: the restricted activity produces a licensed partner, an agent referral and an own-authorisation route', () => {
    const out = deriveInstitutions(ventureB());
    // The restricted activity, and the permit nobody holds yet, each yield the compliant alternatives.
    expect(out.limitations).toEqual([
      { claimId: 'c-limit', activity: 'consumer credit arrangement', alternatives: ['LICENSED_PARTNER', 'AGENT_REFERRAL', 'OWN_AUTHORISATION'] },
      { claimId: 'c-permit', activity: 'import of the product', alternatives: ['LICENSED_PARTNER', 'AGENT_REFERRAL', 'OWN_AUTHORISATION'] },
    ]);
    const partner = byKind(out.structures, 'LICENSED_PARTNER');
    expect(partner.legalFeasibility).toBe('MET');
    expect(partner.elements.some((one) => one.kind === 'CONTRACT' && one.subject.includes('licensed partner'))).toBe(true);
    const own = byKind(out.structures, 'OWN_AUTHORISATION');
    expect(own.elements.find((one) => one.kind === 'LICENSE')?.approval?.class).toBe('REGULATED_SERVICE');
    // The structures that would perform the activity themselves are what the limitation rules out — never the market.
    expect(byKind(out.structures, 'SINGLE_ENTITY').legalFeasibility).toBe('NOT_MET');
    expect(out.structures.some((one) => one.legalFeasibility === 'MET')).toBe(true);
  });
});

describe('INST-30 — a permit, a sale and a jurisdiction are enough to derive limitation, cover and tax', () => {
  /** Exactly the shape the manufacturing feeder builds from rows: parties, flows, a jurisdiction and a permit claim. */
  const rowShaped = (over: Partial<VentureFacts> = {}): VentureFacts =>
    base({
      ventureId: 'row-shaped',
      parties: [
        { id: 'owner:u', role: 'OWNER', jurisdiction: null },
        { id: 'customer:tenders', role: 'CUSTOMER', jurisdiction: 'XA' },
      ],
      flows: [{ kind: 'SALE', partyId: 'customer:tenders' }],
      claims: [{ id: 'barrier:1', sourceId: 'src-b', kind: 'PERMIT_REQUIRED', subject: 'a state certification', jurisdiction: 'XA' }],
      ...over,
    });

  it('a permit nobody holds yields a licensed partner, an agent referral and the own-permit route — never a closed market', () => {
    const out = deriveInstitutions(rowShaped());
    expect(out.limitations).toEqual([{ claimId: 'barrier:1', activity: 'a state certification', alternatives: ['LICENSED_PARTNER', 'AGENT_REFERRAL', 'OWN_AUTHORISATION'] }]);
    const partner = byKind(out.structures, 'LICENSED_PARTNER');
    expect(partner.legalFeasibility).toBe('MET');
    // A holder performs the activity, so this route does not obtain the permit itself.
    expect(partner.elements.some((one) => one.kind === 'PERMIT')).toBe(false);
    expect(partner.elements.some((one) => one.kind === 'CONTRACT' && one.subject === 'licensed partner performing a state certification')).toBe(true);
    expect(byKind(out.structures, 'AGENT_REFERRAL').elements.some((one) => one.kind === 'CONTRACT' && one.subject.startsWith('agent referral of a state certification'))).toBe(true);
    // Obtaining it is the own route, and it stays feasible: a permit limits who acts, not whether anyone may.
    const own = byKind(out.structures, 'OWN_AUTHORISATION');
    expect(own.elements.find((one) => one.kind === 'PERMIT')?.approval?.class).toBe('REGULATED_SERVICE');
    expect(own.elements.some((one) => one.kind === 'LICENSE')).toBe(false);
    expect(byKind(out.structures, 'DIRECT').legalFeasibility).toBe('MET');
  });

  it('a held permit is no limitation, and a held and approved element moves readiness and authorisation', () => {
    const out = deriveInstitutions(rowShaped({ held: ['PERMIT:a state certification'], approvals: ['PERMIT:a state certification'] }));
    expect(out.limitations).toEqual([]);
    const direct = byKind(out.structures, 'DIRECT');
    const permit = direct.elements.find((one) => one.kind === 'PERMIT')!;
    expect(permit.held).toBe(true);
    expect(permit.approval?.approved).toBe(true);
    expect(direct.because.join(' ')).not.toMatch(/PERMIT:a state certification require/);
  });

  it('selling where the record places the venture derives a tax position and liability cover, both advisable and traced', () => {
    const direct = byKind(deriveInstitutions(rowShaped()).structures, 'DIRECT');
    const tax = direct.elements.find((one) => one.kind === 'TAX_REGISTRATION')!;
    expect(tax.subject).toBe('revenue earned in XA');
    expect(tax.necessity).toBe('ADVISABLE');
    expect(tax.triggeredBy).toEqual(['flow SALE', 'jurisdiction XA stated in the record']);
    const cover = direct.elements.find((one) => one.kind === 'INSURANCE')!;
    expect(cover.subject).toBe('liability to customer customer:tenders');
    expect(cover.necessity).toBe('ADVISABLE');
    // Unpriced, so the institutional total is withheld rather than read as free.
    expect(direct.economics.unpriced).toEqual(expect.arrayContaining([tax.key, cover.key]));
  });

  it('with no jurisdiction stated, no tax position is invented: it stays an open question', () => {
    const out = deriveInstitutions(rowShaped({ jurisdictions: [], claims: [] }));
    expect(out.openQuestions).toContain('which tax obligations apply to the venture\'s revenue');
    expect(byKind(out.structures, 'DIRECT').elements.some((one) => one.kind === 'TAX_REGISTRATION')).toBe(false);
  });
});

describe('INST-30 — the economics the plan consumes', () => {
  it('withholds the institutional total and the adjusted economics while any element is unpriced, naming it', () => {
    const direct = byKind(deriveInstitutions(ventureA()).structures, 'DIRECT');
    expect(direct.economics.setupTotals).toBeNull();
    expect(direct.economics.adjusted).toBeNull();
    expect(direct.economics.unpriced.length).toBe(direct.elements.length);
    expect(direct.desirability).toBe('UNKNOWN');
  });

  it('adds setup to capital and recurring cost to running cost once every element is priced', () => {
    const facts = ventureA();
    const keys = byKind(deriveInstitutions(facts).structures, 'DIRECT').elements.map((one) => one.key);
    facts.claims.push(...keys.map((key, i) => cost(`k${i}`, key, 1_000, 2_000)));
    facts.claims.push(cost('ins-annual', 'INSURANCE:PROFESSIONAL_LIABILITY', 12_000, 24_000, 'ANNUAL'));
    const direct = byKind(deriveInstitutions(facts).structures, 'DIRECT');
    expect(direct.economics.unpriced).toEqual([]);
    expect(direct.economics.setupTotals).toEqual([{ currency: 'USD', lowMinor: 1_000 * keys.length, highMinor: 2_000 * keys.length }]);
    expect(direct.economics.adjusted).toEqual({
      capitalLowMinor: 100_000 + 1_000 * keys.length,
      capitalHighMinor: 100_000 + 2_000 * keys.length,
      monthlyRunningLowMinor: 50_000 + 1_000,
      monthlyRunningHighMinor: 50_000 + 2_000,
      currency: 'USD',
    });
    expect(direct.desirability).toBe('MET');
  });

  it('never converts a currency', () => {
    const reading = readEconomics(
      [{ key: 'CONTRACT:x', kind: 'CONTRACT', subject: 'x', necessity: 'ADVISABLE', triggeredBy: ['t'], cost: { oneTime: { currency: 'EUR', lowMinor: 1, highMinor: 2 }, annual: null, claimIds: ['c'] }, prerequisites: [], obligations: [], renewalDate: null, enables: 'e', approval: null, held: false }],
      { capitalMinor: 10, monthlyRunningMinor: 1, monthlyRevenueMinor: 5, currency: 'USD' },
    );
    expect(reading.setupTotals).toEqual([{ currency: 'EUR', lowMinor: 1, highMinor: 2 }]);
    expect(reading.adjusted).toBeNull();
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

describe('INST-30 — the derivation runs on production records', () => {
  it('the manufacturing kernel derives each category\'s institutions from the parties its filed evidence names, and creates nothing', async () => {
    const fixture = await freshProject();
    const projectId = fixture.project.id;
    const layer = await fixture.layerByName('Discovery Logic');
    const user = await createUser({ email: `inst-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple', isBrainAdmin: true });
    expect((await startProgramme({ projectId, ownerUserId: user.id, actorUserId: user.id, objective: 'Build machines only where demand and capability allow.' })).ok).toBe(true);
    const program = (await getProgram(projectId))!;
    const seeded = await seedCategory({ projectId, name: 'Commercial pressure washers', actorRef: user.id, reason: 'test' });
    if ('error' in seeded) throw new Error(seeded.error);
    const category = seeded.category;
    const demand = await acceptedClaim(projectId, layer, 'Fleet operators publish tenders for pressure washers every quarter');
    await recordCategoryEvidence({ programId: program.id, categoryId: category.id, kind: 'DEMAND_EVIDENCE', subject: 'fleet washing tenders', statement: 'Fleet operators publish tenders every quarter', observedOn: '2026-09-01', sourceClaimId: demand });
    const pump = await acceptedClaim(projectId, layer, 'High-pressure pumps are bought in from two suppliers');
    await recordCategoryEvidence({ programId: program.id, categoryId: category.id, kind: 'BOUGHT_IN_COMPONENT', subject: 'high-pressure pump', statement: 'Pumps are bought in', sourceClaimId: pump });

    const { getDb } = await import('../server/db/database.ts');
    const rows = async () => (await getDb().get<{ n: number }>('SELECT (SELECT COUNT(*) FROM cash_events) + (SELECT COUNT(*) FROM cash_actions) AS n'))!.n;
    const before = await rows();
    const pass = await runManufacturingKernel(projectId);
    const reading = pass.institutions.find((one) => one.categoryId === category.id)!;
    expect(reading, 'the pass carries the category derivation').toBeDefined();
    const direct = reading.derivation.structures.find((one) => one.kind === 'DIRECT')!;
    const contracts = direct.elements.filter((one) => one.kind === 'CONTRACT').map((one) => one.subject).sort();
    expect(contracts).toEqual(['customer customer:fleet washing tenders', 'supplier supplier:high-pressure pump']);
    expect(direct.elements.some((one) => one.kind === 'PAYMENT_ACCOUNT' && one.approval?.class === 'ACCOUNT_OPENING')).toBe(true);
    // No jurisdiction is on these rows, so none is assumed: it is an open question and nothing reads as feasible or ready.
    expect(reading.derivation.openQuestions).toContain('no jurisdiction is stated in the record');
    expect(reading.derivation.structures.every((one) => one.legalFeasibility === 'UNKNOWN' && one.readiness !== 'MET')).toBe(true);
    // Unpriced elements withhold the institutional total rather than reading as free.
    expect(direct.economics.setupTotals).toBeNull();
    // A read: no event, action or entity was written by deriving it.
    expect(await rows()).toBe(before);
  });

  it('filed barrier, capital and jurisdiction rows cost the prerequisites and adjust the venture path\'s capital', async () => {
    const fixture = await freshProject();
    const projectId = fixture.project.id;
    const layer = await fixture.layerByName('Discovery Logic');
    const user = await createUser({ email: `inst-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple', isBrainAdmin: true });
    expect((await startProgramme({ projectId, ownerUserId: user.id, actorUserId: user.id, objective: 'Build machines only where demand and capability allow.' })).ok).toBe(true);
    const program = (await getProgram(projectId))!;
    const seeded = await seedCategory({ projectId, name: 'Industrial boilers', actorRef: user.id, reason: 'test' });
    if ('error' in seeded) throw new Error(seeded.error);
    const category = seeded.category;
    const barrierClaim = await acceptedClaim(projectId, layer, 'Boilers sold in Ohio need a state pressure-vessel certification');
    await recordCategoryEvidence({ programId: program.id, categoryId: category.id, kind: 'ENTRY_BARRIER', subject: 'pressure-vessel certification', statement: 'Boilers sold in Ohio need a state pressure-vessel certification', sourceClaimId: barrierClaim });
    const feeClaim = await acceptedClaim(projectId, layer, 'The certification fee schedule is $1,200 to $2,000');
    await recordCategoryCapital({ programId: program.id, categoryId: category.id, requirement: 'CERTIFICATION_AND_APPROVAL', scenario: 'SMALLEST_CREDIBLE_ENTRY', amountLowMinor: 120_000, amountHighMinor: 200_000, currency: 'USD', basis: 'REGULATORY_FEE_SCHEDULE', asOf: '2026-09-01', statement: 'Certification fees are $1,200 to $2,000', sourceClaimId: feeClaim });
    const toolClaim = await acceptedClaim(projectId, layer, 'A welding cell costs $40,000 to $60,000');
    await recordCategoryCapital({ programId: program.id, categoryId: category.id, requirement: 'TOOLING_AND_EQUIPMENT', scenario: 'SMALLEST_CREDIBLE_ENTRY', amountLowMinor: 4_000_000, amountHighMinor: 6_000_000, currency: 'USD', basis: 'PUBLISHED_PRICE_OR_SCHEDULE', asOf: '2026-09-01', statement: 'A welding cell costs $40,000 to $60,000', sourceClaimId: toolClaim });

    const pass = await runManufacturingKernel(projectId);
    const reading = pass.institutions.find((one) => one.categoryId === category.id)!;
    // The jurisdiction is the one the filed statement names, so it is no longer an open question.
    expect(reading.derivation.openQuestions).not.toContain('no jurisdiction is stated in the record');
    const direct = reading.derivation.structures.find((one) => one.kind === 'DIRECT')!;
    const permit = direct.elements.find((one) => one.kind === 'PERMIT')!;
    expect(permit.subject).toBe('pressure-vessel certification');
    expect(permit.approval?.professionalRole).toBe('the permitting authority in ohio');
    // The permit is priced by the filed fee, traced to the row that states it.
    expect(permit.cost?.oneTime).toEqual({ currency: 'USD', lowMinor: 120_000, highMinor: 200_000 });
    expect(permit.cost?.claimIds).toHaveLength(1);
    expect(direct.economics.unpriced).toEqual([]);
    expect(direct.economics.setupTotals).toEqual([{ currency: 'USD', lowMinor: 120_000, highMinor: 200_000 }]);
    // The venture path's capital (the welding cell's high figure, as the path budgets it) is adjusted by the institutional setup.
    expect(direct.economics.adjusted).toEqual({ capitalLowMinor: 6_000_000 + 120_000, capitalHighMinor: 6_000_000 + 200_000, monthlyRunningLowMinor: null, monthlyRunningHighMinor: null, currency: 'USD' });
    const path = pass.ventures.find((one) => one.categoryId === category.id)?.venture.path;
    expect(path?.ok).toBe(true);
    if (path?.ok) expect(path.nodes.map((node) => node.key)).toContain('capital:TOOLING_AND_EQUIPMENT');
    // No row states revenue, so desirability is not assumed.
    expect(direct.desirability).toBe('UNKNOWN');
    // The filed barrier is a limitation on whoever lacks the certification, so the rows yield compliant alternatives.
    expect(reading.derivation.limitations).toEqual([{ claimId: expect.stringMatching(/^barrier:/), activity: 'pressure-vessel certification', alternatives: ['LICENSED_PARTNER', 'AGENT_REFERRAL', 'OWN_AUTHORISATION'] }]);
    const partner = reading.derivation.structures.find((one) => one.kind === 'LICENSED_PARTNER')!;
    expect(partner.legalFeasibility).toBe('MET');
    expect(partner.elements.some((one) => one.kind === 'PERMIT')).toBe(false);
    expect(partner.elements.some((one) => one.kind === 'CONTRACT' && one.subject === 'licensed partner performing pressure-vessel certification')).toBe(true);
    // An entity no row prices stays unpriced, and withholds that structure's total.
    const single = reading.derivation.structures.find((one) => one.kind === 'SINGLE_ENTITY')!;
    expect(single.economics.unpriced).toContain('LEGAL_ENTITY:venture entity');
    expect(single.economics.adjusted).toBeNull();
  });

  it('a filed demand row that names its state derives the tax position and liability cover from rows', async () => {
    const fixture = await freshProject();
    const projectId = fixture.project.id;
    const layer = await fixture.layerByName('Discovery Logic');
    const user = await createUser({ email: `inst-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple', isBrainAdmin: true });
    expect((await startProgramme({ projectId, ownerUserId: user.id, actorUserId: user.id, objective: 'Build machines only where demand and capability allow.' })).ok).toBe(true);
    const program = (await getProgram(projectId))!;
    const seeded = await seedCategory({ projectId, name: 'Grain dryers', actorRef: user.id, reason: 'test' });
    if ('error' in seeded) throw new Error(seeded.error);
    const category = seeded.category;
    const demand = await acceptedClaim(projectId, layer, 'Cooperatives in Iowa tender for grain dryers each season');
    await recordCategoryEvidence({ programId: program.id, categoryId: category.id, kind: 'DEMAND_EVIDENCE', subject: 'cooperative tenders', statement: 'Cooperatives in Iowa tender for grain dryers each season', observedOn: '2026-09-01', sourceClaimId: demand });

    const pass = await runManufacturingKernel(projectId);
    const reading = pass.institutions.find((one) => one.categoryId === category.id)!;
    const direct = reading.derivation.structures.find((one) => one.kind === 'DIRECT')!;
    const tax = direct.elements.find((one) => one.kind === 'TAX_REGISTRATION')!;
    expect(tax.subject).toBe('revenue earned in iowa');
    expect(tax.triggeredBy).toContain('flow SALE');
    expect(direct.elements.find((one) => one.kind === 'INSURANCE')?.subject).toBe('liability to customer customer:cooperative tenders');
    expect(reading.derivation.openQuestions).not.toContain('which tax obligations apply to the venture\'s revenue');
  });

  it('a project with no programme derives nothing', async () => {
    const fixture = await freshProject();
    expect((await runManufacturingKernel(fixture.project.id)).institutions).toEqual([]);
  });
});

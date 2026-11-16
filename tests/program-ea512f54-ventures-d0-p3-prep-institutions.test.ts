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
import { getProgram, recordCategoryEvidence } from '../server/repos/manufacturing.ts';
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
    expect(out.limitations).toEqual([{ claimId: 'c-limit', activity: 'consumer credit arrangement', alternatives: ['LICENSED_PARTNER', 'AGENT_REFERRAL', 'OWN_AUTHORISATION'] }]);
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

  it('a project with no programme derives nothing', async () => {
    const fixture = await freshProject();
    expect((await runManufacturingKernel(fixture.project.id)).institutions).toEqual([]);
  });
});

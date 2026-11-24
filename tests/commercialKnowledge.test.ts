/**
 * Commercial knowledge (§122): public datasets acquired, understood and
 * applied without a person. No network: the publisher's listings and files
 * are served by injected transports in the publishers' own formats.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createNode, listNodes } from '../server/repos/industry.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { openUncertainty } from '../server/repos/researchIntelligence.ts';
import { listCurrentClaimFacts, listProjectConstructionFacts, recordConstructionFact } from '../server/repos/construction.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { getDb } from '../server/db/database.ts';
import { SIGNAL_LANE } from '../server/services/cash/discovery.ts';
import { clearConstructionMemo, constructArrangements, nextInputQuestion } from '../server/services/cash/construct.ts';
import {
  chooseIndustries,
  deriveEconomics,
  judgeBuyerCount,
  normaliseNaics,
  resolveProgramGap,
  sizeClassOf,
  stateNamedIn,
  type FactLike,
} from '../server/domain/commercialKnowledge.ts';
import { conditionalBytes, csvFields, nextDueAfter, parseCbp, parseNonemployer, parseSusb, type BytesTransport } from '../server/services/knowledge/acquire.ts';
import { readSecYear, sectorOfSic } from '../server/services/knowledge/sec.ts';
import { discoverSources, runKnowledgePass, type KnowledgeDeps } from '../server/services/knowledge/pipeline.ts';
import { buyerCountClaimId, notePlanEffects } from '../server/services/knowledge/apply.ts';
import { knowledgeView } from '../server/services/knowledge/view.ts';
import { finishPassRow, listApplications, listLinks, listSources, recentPasses, startPassRow } from '../server/repos/commercialKnowledge.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { Layer } from '../server/domain/types.ts';

/* ------------------------------------------------------------ publisher data */

const CENSUS = 'https://www2.census.gov/programs-surveys';
const SUSB_HEADER = 'STATE,NAICS,ENTRSIZE,FIRM,ESTB,EMPL,EMPLFL_R,EMPLFL_N,PAYR,PAYRFL_N,RCPT,RCPTFL_N,STATEDSCR,NAICSDSCR,ENTRSIZEDSCR';
const SUSB_2017 = [
  SUSB_HEADER,
  '00,--,01,5996900,7860674,128591812,,G,6725346754,G,37370079416,G,United States,Total,01: Total',
  '00,23,01,700000,710000,6000000,,G,400000000,G,1900000000,G,United States,Construction,01: Total',
  '00,2382,01,190000,195000,2200000,,G,130000000,G,400000000,G,United States,Building Equipment Contractors,01: Total',
  '00,238220,01,90000,93000,1100000,,G,62000000,G,200000000,G,United States,"Plumbing, Heating, and Air-Conditioning Contractors",01: Total',
  '00,238220,05,80000,80500,400000,,G,18000000,G,60000000,G,United States,"Plumbing, Heating, and Air-Conditioning Contractors",05: <20',
  '00,5412,01,110000,120000,1300000,,G,60000000,G,140000000,G,United States,"Accounting, Tax Preparation, Bookkeeping, and Payroll Services",01: Total',
  '00,541219,01,60000,62000,500000,,G,15000000,G,40000000,G,United States,Other Accounting Services,01: Total',
  '00,541219,02,50000,50000,0,c,G,0,D,0,D,United States,Other Accounting Services,02: <5',
  '26,238220,01,3000,3100,30000,,G,1500000,G,5000000,G,Michigan,"Plumbing, Heating, and Air-Conditioning Contractors",01: Total',
].join('\n');
const SUSB_2021 = SUSB_2017.replace(/,RCPT,RCPTFL_N/, '').split('\n').map((line, i) => (i === 0 ? 'STATE,NAICS,ENTRSIZE,FIRM,ESTB,EMPL,EMPLFL_R,EMPLFL_N,PAYR,PAYRFL_N,STATEDSCR,NAICSDSCR,ENTRSIZEDSCR' : line.replace(/^(([^,]*,){10})[^,]*,[^,]*,/, '$1'))).join('\n');
const CBP_US_HEADER = '"uscode","naics","lfo","emp_nf","emp","qp1_nf","qp1","ap_nf","ap","est","n<5","n5_9","n10_19"';
const cbpUs = (est: number) =>
  [
    CBP_US_HEADER,
    `"98","238220","-","G",1200000,"G",1,"G",70000000,${est},${Math.round(est * 0.6)},20000,10000`,
    `"98","238220","C","G",1,"G",1,"G",1,5,1,1,1`,
    `"98","5412--","-","G",1400000,"G",1,"G",65000000,125000,90000,20000,8000`,
    `"98","541219","-","G",520000,"G",1,"G",15500000,64000,50000,8000,3000`,
  ].join('\n');
const CBP_ST = [
  '"fipstate","naics","lfo","emp_nf","emp","qp1_nf","qp1","ap_nf","ap","est","n<5","n5_9","n10_19"',
  '"26","238220","-","G",40000,"G",1,"G",2000000,3300,2000,700,300',
].join('\n');
const NES = ['"ST","NAICS","LFO","RCPTOT_SIZE","ESTAB_F","ESTAB","RCPTOT_N_F","RCPTOT_F","RCPTOT"', '"00","238220","-","001",,190000,"G",,9000000', '"00","5412","-","001",,400000,"G",,12000000'].join('\n');

async function zip(name: string, text: string): Promise<Uint8Array> {
  const z = new JSZip();
  z.file(name, text);
  return z.generateAsync({ type: 'uint8array' });
}

const listing = (links: string[]) => `<html><body>${links.map((l) => `<a href="${l}">${l}</a>`).join('')}<a href="/programs-surveys/">up</a></body></html>`;

function world(cbpEstablishments = 100000) {
  const pages: Record<string, string> = {
    [`${CENSUS}/`]: listing(['cbp/', 'susb/', 'nonemployer-statistics/', 'abs/']),
    [`${CENSUS}/susb/datasets/`]: listing(['2017/', '2021/']),
    [`${CENSUS}/susb/datasets/2017/`]: listing(['us_state_6digitnaics_2017.txt']),
    [`${CENSUS}/susb/datasets/2021/`]: listing(['us_state_6digitnaics_2021.txt']),
    [`${CENSUS}/cbp/datasets/`]: listing(['2021/', '2023/']),
    [`${CENSUS}/cbp/datasets/2023/`]: listing(['cbp23us.zip', 'cbp23st.zip']),
    [`${CENSUS}/cbp/datasets/2021/`]: listing(['cbp21us.zip']),
    [`${CENSUS}/nonemployer-statistics/datasets/`]: listing(['2024/']),
    [`${CENSUS}/nonemployer-statistics/datasets/2024/historical-datasets/`]: listing(['nonemp24us.zip']),
    [`${CENSUS}/abs/datasets/`]: listing(['2023/']),
    [`${CENSUS}/abs/datasets/2023/`]: listing(['abscs2023_naics.zip']),
  };
  const files: Record<string, () => Promise<Uint8Array>> = {
    [`${CENSUS}/susb/datasets/2017/us_state_6digitnaics_2017.txt`]: async () => new TextEncoder().encode(SUSB_2017),
    [`${CENSUS}/susb/datasets/2021/us_state_6digitnaics_2021.txt`]: async () => new TextEncoder().encode(SUSB_2021),
    [`${CENSUS}/cbp/datasets/2023/cbp23us.zip`]: () => zip('cbp23us.txt', cbpUs(cbpEstablishments)),
    [`${CENSUS}/cbp/datasets/2023/cbp23st.zip`]: () => zip('cbp23st.txt', CBP_ST),
    [`${CENSUS}/cbp/datasets/2021/cbp21us.zip`]: () => zip('cbp21us.txt', cbpUs(95000)),
    [`${CENSUS}/nonemployer-statistics/datasets/2024/historical-datasets/nonemp24us.zip`]: () => zip('nonemp24us.txt', NES),
  };
  const state = { calls: 0, fail: new Set<string>() };
  const transport: BytesTransport = async (url, headers) => {
    state.calls++;
    if (state.fail.has(url)) return { status: 503, headers: {}, body: new Uint8Array() };
    const make = files[url];
    if (!make) return { status: 404, headers: {}, body: new Uint8Array() };
    const etag = `"${url.length}-${cbpEstablishments}"`;
    if (headers['If-None-Match'] === etag) return { status: 304, headers: { etag }, body: new Uint8Array() };
    return { status: 200, headers: { etag }, body: await make() };
  };
  const getText = async (url: string) => {
    const page = pages[url];
    if (page === undefined) throw new Error(`HTTP 404 for ${url}`);
    return page;
  };
  // No SEC in the fixture world: its frames answer 404 (no year is substantially filed).
  const getJson = async () => null;
  return { transport, getText, getJson, state };
}

/* --------------------------------------------------------------------- setup */

let projectId = '';
let layer: Layer;
let owner = '';

async function gatedClaims(claims: string[]): Promise<{ ids: string[]; orchestrationId: string }> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'q', assignment: 'where to look', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: 'any market',
      requiredEvidence: [{ id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a directory'], excludedSourceTypes: ['a forecast'], completionCriteria: ['a dated source'],
      minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'q', question: 'q', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const inserted = await insertClaims(
    claims.map((claim) => ({
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
      claim, sourceUrl: `https://example.test/${encodeURIComponent(claim)}`, sourceTitle: 'A directory', sourcePublisher: 'A publisher', sourceDate: '2026-11-20',
      evidenceExcerpt: claim, evidenceLocator: 'the page', evidenceLane: 'structure', opportunitySignal: null, closesOn: null,
      retrievedAt: '2026-11-21', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
      claimType: 'SOURCED_FACT' as const, contentHash: `${claim}`,
    })),
  );
  for (const claim of inserted) await decideClaim(claim.id, { accepted: true });
  return { ids: inserted.map((one) => one.id), orchestrationId: orchestration.id };
}

async function sector(name: string, buyer: string, bottleneck: string, supply: string): Promise<{ buyerId: string; orchestrationId: string }> {
  const { ids, orchestrationId } = await gatedClaims([`${name} is a sector.`, `${buyer} buy in ${name}.`, `${bottleneck} is a recurring problem.`, `${supply} serve this.`]);
  const root = await createNode({ projectId, parentId: null, kind: 'SECTOR', name, origin: 'SEED' });
  const b = await createNode({ projectId, parentId: root.node.id, kind: 'BUYER_TYPE', name: buyer, origin: 'DISCOVERED', sourceClaimId: ids[1] ?? null });
  await createNode({ projectId, parentId: root.node.id, kind: 'BOTTLENECK', name: bottleneck, origin: 'DISCOVERED', sourceClaimId: ids[2] ?? null });
  await createNode({ projectId, parentId: root.node.id, kind: 'FULFILMENT_SOURCE', name: supply, origin: 'DISCOVERED', sourceClaimId: ids[3] ?? null });
  return { buyerId: b.node.id, orchestrationId };
}

beforeEach(async () => {
  clearConstructionMemo();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  owner = (await createUser({ email: `ck-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: owner, actorUserId: owner, objective: 'Maximize usable cash.' })).ok).toBe(true);
});

const deps = (w: ReturnType<typeof world>, extra: Partial<KnowledgeDeps> = {}): KnowledgeDeps => ({ transport: w.transport, getText: w.getText, getJson: w.getJson, config: null, ...extra });

/* ---------------------------------------------------------------- the rules */

describe('reading the publishers’ formats deterministically', () => {
  const ctx = { sourceId: 'ksr_x', acquisitionId: null, sourceTitle: 'SUSB 2017', sourceUrl: 'u', family: 'SUSB_RECEIPTS', period: '2017', acquiredAt: '2026-11-24T00:00:00.000Z' };

  it('normalises every NAICS spelling the datasets use', () => {
    expect(normaliseNaics('------')).toBe('00');
    expect(normaliseNaics('--')).toBe('00');
    expect(normaliseNaics('11----')).toBe('11');
    expect(normaliseNaics('113///')).toBe('113');
    expect(normaliseNaics('31-33')).toBe('31');
    expect(normaliseNaics('238220')).toBe('238220');
    expect(normaliseNaics('abc')).toBeNull();
    expect(csvFields('00,"Plumbing, Heating",x')).toEqual(['00', 'Plumbing, Heating', 'x']);
  });

  it('SUSB: national figures per size class in dollars and titles (state counts come from CBP) — and a withheld cell is UNKNOWN, never zero', () => {
    const parsed = parseSusb(SUSB_2017, ctx);
    const one = (metric: string, naics: string, size = 'ALL', geo = 'US') => parsed.facts.find((f) => f.metric === metric && f.naics === naics && f.size_class === size && f.geo_code === geo);
    expect(one('RECEIPTS', '238220')!.value).toBe(200_000_000_000);
    expect(one('ANNUAL_PAYROLL', '238220')!.value).toBe(62_000_000_000);
    expect(one('FIRMS', '238220', 'SMALL')!.value).toBe(80000);
    expect(one('FIRMS', '238220', 'ALL', 'US-26')).toBeUndefined();
    expect(one('RECEIPTS', '238220')!.epistemic).toBe('FACT');
    expect(parsed.titles.find((t) => t.naics === '238220')!.label).toBe('Plumbing, Heating, and Air-Conditioning Contractors');
    // ENTRSIZE 02 is not a class Brain keeps; the withheld <5 row is not read as a zero anywhere.
    expect(parsed.facts.some((f) => f.value === 0 && f.epistemic === 'FACT')).toBe(false);
  });

  it('CBP: only all legal forms, small establishments summed; nonemployers by receipts size total', () => {
    const cbp = parseCbp(cbpUs(100000), { ...ctx, family: 'CBP', period: '2023' });
    expect(cbp.facts.filter((f) => f.naics === '238220' && f.metric === 'ESTABLISHMENTS')).toHaveLength(1);
    expect(cbp.facts.find((f) => f.naics === '238220' && f.metric === 'SMALL_ESTABLISHMENTS')!.value).toBe(90000);
    expect(cbp.facts.find((f) => f.naics === '238220' && f.metric === 'ANNUAL_PAYROLL')!.value).toBe(70_000_000_000);
    const st = parseCbp(CBP_ST, { ...ctx, family: 'CBP_STATE', period: '2023' });
    expect(st.facts.find((f) => f.metric === 'ESTABLISHMENTS')!.geo_code).toBe('US-26');
    const nes = parseNonemployer(NES, { ...ctx, family: 'NES', period: '2024' });
    expect(nes.facts.find((f) => f.metric === 'NONEMPLOYER_RECEIPTS' && f.naics === '238220')!.value).toBe(9_000_000_000);
  });

  it('derives reusable economics as estimates naming their inputs, and carries receipts forward by payroll', () => {
    const f = (id: string, metric: FactLike['metric'], value: number, period: string, sizeClass = 'ALL'): FactLike => ({ id, metric, value, period, epistemic: 'FACT', sizeClass });
    const derived = deriveEconomics([
      f('r', 'RECEIPTS', 200e9, '2017'), f('fi', 'FIRMS', 90000, '2017'), f('p17', 'ANNUAL_PAYROLL', 62e9, '2017'), f('e', 'EMPLOYMENT', 1.1e6, '2017'),
      f('p23', 'ANNUAL_PAYROLL', 70e9, '2023'), f('es23', 'ESTABLISHMENTS', 100000, '2023'), f('es21', 'ESTABLISHMENTS', 95000, '2021'), f('ne', 'NONEMPLOYER_ESTABLISHMENTS', 190000, '2024'),
    ]);
    const get = (m: string) => derived.find((d) => d.metric === m)!;
    expect(get('PAYROLL_SHARE_OF_RECEIPTS').value).toBeCloseTo(0.31, 3);
    expect(get('REVENUE_AFTER_PAYROLL_SHARE').value).toBeCloseTo(0.69, 3);
    expect(get('RECEIPTS_PER_FIRM').inputs).toEqual(['r', 'fi']);
    expect(get('RECEIPTS_CURRENT_ESTIMATE').value).toBe(Math.round(200e9 * (70 / 62)));
    expect(get('ESTABLISHMENT_GROWTH').value).toBeCloseTo(100000 / 95000 - 1, 3);
    expect(get('NONEMPLOYER_SHARE').value).toBeCloseTo(190000 / 290000, 3);
  });

  it('classifies buyer words into industries, covering every word and keeping the broadest of a nest', () => {
    const titles = [
      { naics: '5412', label: 'Accounting, Tax Preparation, Bookkeeping, and Payroll Services' },
      { naics: '541219', label: 'Other Accounting Services' },
      { naics: '238220', label: 'Plumbing, Heating, and Air-Conditioning Contractors' },
      { naics: '722511', label: 'Full-Service Restaurants' },
    ];
    expect(chooseIndustries('Small accounting and bookkeeping firms', titles)!.codes).toEqual(['5412']);
    expect(chooseIndustries('Owner-operated HVAC contractors', titles)!.codes).toEqual(['238220']);
    expect(chooseIndustries('Households planning a wedding', titles)).toBeNull();
    expect(sizeClassOf('Owner-operated HVAC contractors')).toBe('SMALL');
    expect(stateNamedIn('Dental practices in Metro Detroit')).toBe('26');
    expect(stateNamedIn('Dental practices in Ohio and Texas')).toBeNull();
  });

  it('resolves disagreements by evidence strength and scope', () => {
    expect(resolveProgramGap({ value: 100, primaryFor: true }, { value: 100, primaryFor: false })).toBeNull();
    expect(resolveProgramGap({ value: 100, primaryFor: true }, { value: 95, primaryFor: false })!.resolution).toBe('RECONCILED');
    expect(resolveProgramGap({ value: 100, primaryFor: true }, { value: 70, primaryFor: false })!.resolution).toBe('PREFER_A');
    expect(judgeBuyerCount({ low: 500, high: 5000, status: 'ASSUMPTION' }, 98000)).toMatchObject({ contradicts: true, resolution: 'PREFER_B' });
    expect(judgeBuyerCount({ low: 20, high: 80, status: 'OBSERVED' }, 98000)).toMatchObject({ contradicts: true, resolution: 'UNRESOLVED' });
    expect(judgeBuyerCount({ low: 90000, high: 120000, status: 'ASSUMPTION' }, 98000).contradicts).toBe(false);
  });

  it('a conditional read: 304 and an unchanged hash are NOT_MODIFIED; a redirect to a key page is a failure, never "unchanged"', async () => {
    const body = new TextEncoder().encode('a,b\n1,2');
    const first = await conditionalBytes(async () => ({ status: 200, headers: { etag: '"1"' }, body }), 'u', null);
    expect(first.status).toBe('MODIFIED');
    const again = await conditionalBytes(async (_u, h) => (h['If-None-Match'] === '"1"' ? { status: 304, headers: {}, body: new Uint8Array() } : { status: 200, headers: {}, body }), 'u', first.validators);
    expect(again.status).toBe('NOT_MODIFIED');
    const sameHash = await conditionalBytes(async () => ({ status: 200, headers: {}, body }), 'u', { contentHash: first.status === 'MODIFIED' ? first.contentHash : null });
    expect(sameHash.status).toBe('NOT_MODIFIED');
    await expect(conditionalBytes(async () => ({ status: 302, headers: { location: 'missing_key.html' }, body: new Uint8Array() }), 'u', null)).rejects.toThrow('HTTP 302');
    const now = new Date('2026-11-24T00:00:00Z');
    expect(Date.parse(nextDueAfter(now, false, 0)) - now.getTime()).toBe(20 * 60_000);
    expect(Date.parse(nextDueAfter(now, false, 3)) - now.getTime()).toBe(160 * 60_000);
    expect(Date.parse(nextDueAfter(now, false, 30)) - now.getTime()).toBe(7 * 86_400_000);
  });

  it('SEC frames become sector medians of margin, cash cycle and capital, with the SIC division folded onto NAICS', async () => {
    expect(sectorOfSic('1711')).toBe('23');
    expect(sectorOfSic('7372')).toBe('51');
    expect(sectorOfSic('5812')).toBe('72');
    expect(sectorOfSic('8721')).toBe('54');
    const companies = Array.from({ length: 6 }, (_, i) => i + 1);
    const frame = (val: (cik: number) => number) => ({ data: companies.map((cik) => ({ cik, val: val(cik) })) });
    const answers: Record<string, unknown> = {
      Revenues: frame(() => 10_000_000),
      GrossProfit: frame((c) => 2_000_000 + c * 100_000),
      OperatingIncomeLoss: frame(() => 500_000),
      AccountsReceivableNetCurrent: frame(() => 1_500_000),
      PropertyPlantAndEquipmentNet: frame(() => 3_000_000),
    };
    const getJson = async (url: string) => {
      if (url.includes('efts.sec.gov')) return { hits: { total: { value: 6 }, hits: companies.map((cik) => ({ _source: { ciks: [String(cik).padStart(10, '0')], sics: ['1711'] } })) } };
      const concept = /us-gaap\/([^/]+)\//.exec(url)![1]!;
      return answers[concept] ?? null;
    };
    const read = await readSecYear(getJson, { sourceId: 's', sourceTitle: 'SEC', sourceUrl: 'u', year: 2025, acquiredAt: '2026-11-24T00:00:00.000Z' });
    const get = (m: string) => read.facts.find((f) => f.metric === m && f.naics === '23')!;
    expect(get('PUBLIC_COMPANIES').value).toBe(6);
    expect(get('GROSS_MARGIN').value).toBeCloseTo(0.235, 3);
    expect(get('RECEIVABLE_DAYS').value).toBeCloseTo(54.75, 2);
    expect(get('FIXED_ASSETS_PER_REVENUE').value).toBe(0.3);
    expect(get('GROSS_MARGIN').epistemic).toBe('ESTIMATE');
    expect(read.facts.find((f) => f.metric === 'INVENTORY_DAYS')).toBeUndefined();
  });
});

/* ------------------------------------------------------------- the pipeline */

describe('the pass: acquire, understand, apply — with no person in it', () => {
  it('discovers the newest vintages, reads them, files buyer counts the plan reads, replaces an assumption and answers a research question', async () => {
    const hvac = await sector('Home services', 'Owner-operated HVAC and plumbing contractors', 'Missed calls after hours', 'Virtual receptionist services');
    const acct = await sector('Professional services', 'Small accounting and bookkeeping firms', 'Year-end client letters', 'Freelance writers');
    // What the map held before: a planning assumption the census contradicts, and an open question it answers.
    await getDb().run(
      `INSERT INTO construction_facts (id, project_id, workstream_id, fact_key, segment, low, high, status, measures, source_title, source_url, recorded_by, created_at, node_id, source_claim_id, source_kind, observed_at, valid_until)
       VALUES ('cfa_assumed', ?, NULL, 'accounts_reachable', ?, 500, 5000, 'ASSUMPTION', 'a guess', 'Brain planning assumption', NULL, 'BRAIN', ?, ?, 'clm_guess', 'SECONDARY', ?, ?)`,
      [projectId, `map_${acct.buyerId}`, '2026-11-01T00:00:00.000Z', acct.buyerId, '2026-11-01T00:00:00.000Z', '2027-11-01T00:00:00.000Z'],
    );
    await openUncertainty({ orchestrationId: hvac.orchestrationId, projectId, uncertaintyKey: 'buyers-hvac', question: 'How many Owner-operated HVAC and plumbing contractors exist in the United States?', whyItMatters: 'sizes the market', consumerKind: 'CALCULATION', stoppingCondition: 'a sourced count' });
    const goal = await createGoal({ projectId, objective: 'Collect 10000 dollars of settled cash within 30 days', actorRef: 'test', userId: owner });
    expect(goal.ok).toBe(true);
    const goalId = (goal as { goal: { id: string } }).goal.id;

    const now = new Date();
    const before = await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30, now });
    expect(before.filter((a) => a.origin !== 'REVERSE').every((a) => a.unknownParts.includes('buyers'))).toBe(true);

    const w = world();
    const report = await runKnowledgePass({ maxReads: 10, gpuCalls: 0, forceDiscovery: true }, deps(w));
    expect(report.errors).toEqual([]);
    expect(report.discovered.sort()).toEqual(['cbp-2023', 'cbp_census_year-2021', 'cbp_state-2023', 'nes-2024', 'susb-2021', 'susb_receipts-2017'].sort());
    // A program no reader covers is recorded as a candidate, not ignored.
    expect(report.candidates).toEqual(['candidate-abs-2023']);
    expect(report.reads.every((r) => r.outcome === 'MODIFIED')).toBe(true);
    expect(report.derived!.written).toBeGreaterThan(0);

    const links = await listLinks(projectId);
    expect(links.find((l) => l.node_id === acct.buyerId)!.naics).toBe('["5412"]');
    expect(links.find((l) => l.node_id === hvac.buyerId)!.naics).toBe('["238220"]');

    // The plan's input: an OBSERVED, PRIMARY count on the buyer's map node — small employer establishments up to all businesses.
    const filed = (await listCurrentClaimFacts(buyerCountClaimId(hvac.buyerId)))[0]!;
    expect(filed).toMatchObject({ key: 'accounts_reachable', segment: `map_${hvac.buyerId}`, status: 'OBSERVED', low: 90000, high: 280000 });
    expect(filed.source.kind).toBe('PRIMARY');

    const applications = await listApplications(50, projectId);
    expect(applications.filter((a) => a.kind === 'CONSTRUCTION_FACT')).toHaveLength(2);
    expect(applications.find((a) => a.kind === 'ASSUMPTION_REPLACED')!.target_ref).toBe('construction_fact:cfa_assumed');
    expect(applications.find((a) => a.kind === 'UNCERTAINTY_RESOLVED')).toBeDefined();
    const question = await getDb().get<{ disposition: string; belief_basis: string }>(`SELECT disposition, belief_basis FROM research_uncertainties WHERE uncertainty_key = 'buyers-hvac'`);
    expect(question).toEqual({ disposition: 'RESOLVED', belief_basis: 'EVIDENCE' });
    const contradiction = await getDb().get<{ resolution: string }>(`SELECT resolution FROM knowledge_contradictions WHERE fact_a_ref = 'construction_fact:cfa_assumed'`);
    expect(contradiction!.resolution).toBe('PREFER_B');

    // The plan now reads the count: buyers is established on every arrangement over these populations.
    clearConstructionMemo();
    const after = await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30, now });
    const forward = after.filter((a) => a.origin !== 'REVERSE');
    expect(forward.length).toBeGreaterThan(0);
    expect(forward.every((a) => !a.unknownParts.includes('buyers'))).toBe(true);
    expect(await notePlanEffects(goalId, projectId, forward, (one) => nextInputQuestion(one as never, 'USD'))).toBe(2);
    expect(await notePlanEffects(goalId, projectId, forward, (one) => nextInputQuestion(one as never, 'USD'))).toBe(0);

    // A second pass with nothing changed reads 304s and writes nothing.
    const factCount = (await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM knowledge_facts'))!.n;
    await getDb().run(`UPDATE knowledge_sources SET next_due_at = ?`, ['2000-01-01T00:00:00.000Z']);
    const second = await runKnowledgePass({ maxReads: 10, gpuCalls: 0 }, deps(w));
    expect(second.reads.every((r) => r.outcome === 'NOT_MODIFIED')).toBe(true);
    expect((await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM knowledge_facts'))!.n).toBe(factCount);
    expect(await listCurrentClaimFacts(buyerCountClaimId(hvac.buyerId))).toHaveLength(1);

    // The publisher revises the count: the fact is superseded by a new row, and the old one stays as history.
    const revised = world(110000);
    await getDb().run(`UPDATE knowledge_sources SET next_due_at = ?`, ['2000-01-01T00:00:00.000Z']);
    await runKnowledgePass({ maxReads: 10, gpuCalls: 0 }, deps(revised));
    const current = (await listCurrentClaimFacts(buyerCountClaimId(hvac.buyerId)))[0]!;
    expect(current.high).toBeGreaterThan(filed.high);
    expect(current.supersedesFactId).toBe(filed.id);
    expect((await listProjectConstructionFacts(projectId)).some((f) => f.id === filed.id)).toBe(false);
    expect((await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM construction_facts WHERE id = ?`, [filed.id]))!.n).toBe(1);

    // The view: Brain-level learning for anyone who may read a project, project applications only for their project.
    const view = await knowledgeView([projectId]);
    expect((view['plans'] as { applied: Record<string, number> }).applied['CONSTRUCTION_FACT']).toBeGreaterThanOrEqual(2);
    expect(((await knowledgeView(['prj_someone_else']))['plans'] as { recent: unknown[] }).recent).toEqual([]);
  }, 120_000);

  it('a failing source backs off and is retried later; the others are still read', async () => {
    const w = world();
    w.state.fail.add(`${CENSUS}/cbp/datasets/2023/cbp23us.zip`);
    const report = await runKnowledgePass({ maxReads: 10, gpuCalls: 0, forceDiscovery: true }, deps(w));
    expect(report.reads.find((r) => r.source === 'cbp-2023')).toMatchObject({ outcome: 'FAILED', error: 'HTTP 503' });
    expect(report.reads.filter((r) => r.outcome === 'MODIFIED').length).toBeGreaterThan(3);
    const failing = (await listSources()).find((s) => s.source_key === 'cbp-2023')!;
    expect(failing).toMatchObject({ status: 'FAILING', consecutive_failures: 1 });
    expect(Date.parse(failing.next_due_at)).toBeGreaterThan(Date.now() + 15 * 60_000);
    w.state.fail.clear();
    await getDb().run(`UPDATE knowledge_sources SET next_due_at = ? WHERE source_key = 'cbp-2023'`, ['2000-01-01T00:00:00.000Z']);
    const retried = await runKnowledgePass({ maxReads: 10, gpuCalls: 0 }, deps(w));
    expect(retried.reads.find((r) => r.source === 'cbp-2023')!.outcome).toBe('MODIFIED');
    expect((await listSources()).find((s) => s.source_key === 'cbp-2023')).toMatchObject({ status: 'ACTIVE', consecutive_failures: 0 });
  }, 60_000);

  it('a newer vintage supersedes the older source, whose facts stay', async () => {
    const w = world();
    await discoverSources(deps(w), true);
    expect((await listSources()).find((s) => s.source_key === 'cbp-2023')!.status).toBe('ACTIVE');
    // The 2023 CBP listing is replaced by a 2024 one.
    const newer = { ...w, getText: async (url: string) => (url.endsWith('/cbp/datasets/') ? listing(['2021/', '2023/', '2024/']) : url.endsWith('/cbp/datasets/2024/') ? listing(['cbp24us.zip']) : w.getText(url)) };
    const found = await discoverSources(deps(newer), true);
    expect(found.discovered).toContain('cbp-2024');
    expect((await listSources()).find((s) => s.source_key === 'cbp-2023')!.status).toBe('SUPERSEDED');
  });

  it('the GPU classifies the buyer words match nothing, and interprets industries as inference — every answer checked', async () => {
    const odd = await sector('Events', 'Couples planning a destination wedding', 'Guest travel logistics', 'Travel agents');
    await createGoal({ projectId, objective: 'Collect 3000 dollars of settled cash within 30 days', actorRef: 'test', userId: owner });
    const calls: string[] = [];
    const completer: Completer = async (_config, model, system, prompt, options) => {
      calls.push(system.slice(0, 30));
      options?.onServed?.('runpod/qwen3-8b');
      if (system.startsWith('You classify')) return JSON.stringify({ codes: ['999999', '5412'], why: 'invented code dropped' });
      return JSON.stringify({ customer: 'BUSINESS', revenue: ['SERVICE', 'NOT_A_BASIS'], mechanisms: ['SUBCONTRACTING', 'MADE_UP'], interpretation: `Payroll takes about a third of receipts (${model}).`, principles: ['Labour-heavy: margin is set by utilisation.'], requirements: ['Licensed technicians'], unknowns: ['What one service call is priced at'] });
    };
    const config = { url: 'http://gpu', key: null, models: ['runpod/qwen3-8b'], dailyBudget: 1000, timeoutMs: 1000, runpod: null } as unknown as LaneConfig;
    const w = world();
    const report = await runKnowledgePass({ maxReads: 10, gpuCalls: 6, forceDiscovery: true }, deps(w, { config, completer }));
    const link = (await listLinks(projectId)).find((l) => l.node_id === odd.buyerId)!;
    expect(link).toMatchObject({ method: 'MODEL', naics: '["5412"]', served_by: 'runpod/qwen3-8b' });
    expect(report.interpreted.length).toBeGreaterThan(0);
    const industry = await getDb().get<{ classified_by: string; mechanisms: string; interpreted_served_by: string; interpretation: string }>(
      'SELECT classified_by, mechanisms, interpreted_served_by, interpretation FROM knowledge_industries WHERE naics = ?',
      [report.interpreted[0]!],
    );
    expect(industry!.classified_by).toBe('MODEL');
    expect(JSON.parse(industry!.mechanisms)).toEqual({ revenue: ['SERVICE'], mechanisms: ['SUBCONTRACTING'] });
    expect(industry!.interpreted_served_by).toBe('runpod/qwen3-8b');
    expect(calls.filter((c) => c.startsWith('You classify'))).toHaveLength(1);
    // Nothing the model said became a figure.
    expect((await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM knowledge_facts WHERE quality = 'MODEL'`))!.n).toBe(0);
    expect((await listNodes(projectId)).length).toBeGreaterThan(0);
  }, 60_000);

  it('every pass is a row: running, then done with its report — so a pass that never started is told apart from one that failed', async () => {
    const id = await startPassRow();
    expect((await recentPasses())[0]).toMatchObject({ id, status: 'RUNNING' });
    await finishPassRow(id, 'DONE', { reads: [{ source: 'cbp-2023', outcome: 'MODIFIED', facts: 7985 }], errors: [] });
    await finishPassRow(id, 'FAILED', { error: 'late' });
    expect((await recentPasses())[0]).toMatchObject({ id, status: 'DONE' });
    const view = await knowledgeView([projectId]);
    expect((view['learning'] as { lastPass: { status: string; reads: unknown[] } }).lastPass).toMatchObject({ status: 'DONE', reads: [{ source: 'cbp-2023' }] });
  });
});

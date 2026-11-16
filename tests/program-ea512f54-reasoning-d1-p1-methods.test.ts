import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  SEED_METHODS,
  compareMethods,
  declareMethod,
  detectWeakInferences,
  diagnoseCapabilityGap,
  judgeMethod,
  learnProcedures,
  readCatalogue,
  readMethodOutcomes,
  recordDeclaredMethod,
  recordMethodOutcome,
  recordMethodSelection,
  selectMethods,
  verifyMethod,
  type MethodOutcome,
  type ProblemProfile,
} from '../server/services/research/methodLibrary.ts';
import { getDb } from '../server/db/database.ts';

const problem = (over: Partial<ProblemProfile> = {}): ProblemProfile => ({
  id: 'p1',
  domain: 'equipment-resale',
  question: 'how long until cash arrives from a resale',
  features: [
    { feature: 'uncertain-quantity', source: 'https://example.test/terms' },
    { feature: 'has-observations', source: 'https://example.test/ledger' },
    { feature: 'prior-available', source: null },
  ],
  available: ['observations'],
  ...over,
});

const outcome = (over: Partial<MethodOutcome> = {}): MethodOutcome => ({
  methodId: 'bayesian-update',
  problemId: 'x',
  domain: 'd1',
  features: ['uncertain-quantity', 'has-observations'],
  succeeded: true,
  errorClass: null,
  at: '2026-11-01T00:00:00.000Z',
  ...over,
});

describe('fitness is judged per case from evidence, and the judgment is recorded', () => {
  it('weighs evidenced features above asserted ones and keeps its reasons', () => {
    const method = SEED_METHODS.find((m) => m.id === 'bayesian-update')!;
    const evidenced = judgeMethod(method, problem());
    const asserted = judgeMethod(method, problem({ features: problem().features.map((f) => ({ ...f, source: null })) }));
    expect(evidenced.fit).toBe('FIT');
    expect(evidenced.score).toBeGreaterThan(asserted.score);
    expect(evidenced.evidence).toContain('https://example.test/terms');
    expect(evidenced.reasons.some((r) => r.includes('asserted without a source'))).toBe(true);
  });

  it('lets the track record on comparable problems move the judgment', () => {
    const method = SEED_METHODS.find((m) => m.id === 'bayesian-update')!;
    const failing = Array.from({ length: 4 }, (_, i) => outcome({ problemId: `f${i}`, succeeded: false, errorClass: 'overconfident' }));
    const judged = judgeMethod(method, problem(), failing);
    expect(judged.trackRecord).toEqual({ successes: 0, applications: 4 });
    expect(judged.fit).toBe('UNFIT');
  });

  it('compares competing methods, best first, and says what separates them', () => {
    const cmp = compareMethods(SEED_METHODS, problem());
    expect(cmp.chosen?.methodId).toBe('bayesian-update');
    expect(cmp.margin).toBeTruthy();
    expect(cmp.ranked.length).toBe(SEED_METHODS.length);
  });

  it('writes the selection with every judgment through the existing append-only writer', async () => {
    await freshProject();
    const selection = selectMethods(SEED_METHODS, problem());
    await recordMethodSelection(problem(), selection, { projectId: null });
    const rows = await getDb().all<{ outcome: string; measures: string }>(`SELECT outcome, measures FROM bin_events WHERE event_type = 'METHOD_JUDGMENT'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('SELECTED');
    expect(JSON.parse(rows[0]!.measures).selection.chosen[0].reasons.length).toBeGreaterThan(0);
  });
});

describe('no fixed category list gates selection', () => {
  it('declares a method outside the seed catalogue with a reason and selects it', () => {
    const refused = declareMethod(SEED_METHODS, { id: 'x', name: 'x', kind: 'QUEUEING', purpose: 'p', fitsWhen: ['waiting-line'], misleadsWhen: [], requires: [] }, '  ');
    expect(refused.ok).toBe(false);
    const declared = declareMethod(
      SEED_METHODS,
      { id: 'queue-model', name: 'Queueing model', kind: 'QUEUEING', purpose: 'how long a job waits for capacity', fitsWhen: ['waiting-line', 'scarce-capacity'], misleadsWhen: [], requires: [] },
      'dispatch delays are a queue, which no seed method models',
    );
    expect(declared.ok).toBe(true);
    expect(declared.method?.status).toBe('UNVERIFIED');
    const sel = selectMethods(declared.catalogue, problem({ features: [{ feature: 'waiting-line', source: 's' }, { feature: 'scarce-capacity', source: 's' }], available: [] }), [], 1);
    expect(sel.chosen[0]?.methodId).toBe('queue-model');
  });

  it('reads declared methods back into the working catalogue', async () => {
    await freshProject();
    const declared = declareMethod(SEED_METHODS, { id: 'novel-m', name: 'n', kind: 'NEW-KIND', purpose: 'p', fitsWhen: ['f'], misleadsWhen: [], requires: [] }, 'needed');
    await recordDeclaredMethod(declared.method!);
    const catalogue = await readCatalogue();
    expect(catalogue.find((m) => m.id === 'novel-m')?.status).toBe('UNVERIFIED');
    expect(catalogue.length).toBe(SEED_METHODS.length + 1);
  });
});

describe('a reasoning failure names the absent capability, not more domain facts', () => {
  const subcontracting = problem({
    id: 'sub-1',
    domain: 'subcontracting',
    question: 'who carries the performance risk when work is passed down',
    features: [
      { feature: 'risk-transfer-chain', source: 'https://example.test/contract' },
      { feature: 'multi-party', source: 'https://example.test/contract' },
    ],
    available: [],
  });

  it('derives an unverified method for the uncovered features and names where else it applies', () => {
    const history = [outcome({ domain: 'freight-brokerage', features: ['risk-transfer-chain', 'time-to-cash'], succeeded: false, errorClass: 'misattributed-risk' })];
    const gap = diagnoseCapabilityGap({ problem: subcontracting, methodsTried: ['reference-class'], errorClasses: ['misattributed-risk'] }, SEED_METHODS, history);
    expect(gap.uncoveredFeatures).toContain('risk-transfer-chain');
    expect(gap.absentCapability).toContain('risk-transfer-chain');
    expect(gap.requestsDomainFacts).toBe(false);
    expect(gap.remedy).toBe('DERIVE');
    expect(gap.proposedMethod.status).toBe('UNVERIFIED');
    expect(gap.proposedMethod.derivedFor).toBe('subcontracting');
    expect(gap.applyTo).toEqual(['freight-brokerage']);
  });

  it('verifies a derived method only from results outside the domain it was derived for', () => {
    const gap = diagnoseCapabilityGap({ problem: subcontracting, methodsTried: [], errorClasses: [] }, SEED_METHODS);
    const m = gap.proposedMethod;
    const home = [outcome({ methodId: m.id, domain: 'subcontracting' }), outcome({ methodId: m.id, domain: 'subcontracting' })];
    expect(verifyMethod(m, home).status).toBe('UNVERIFIED');
    const away = [...home, outcome({ methodId: m.id, domain: 'staffing' }), outcome({ methodId: m.id, domain: 'freight' })];
    expect(verifyMethod(m, away).status).toBe('VERIFIED');
    const failing = [outcome({ methodId: m.id, domain: 'a', succeeded: false }), outcome({ methodId: m.id, domain: 'b', succeeded: false })];
    expect(verifyMethod(m, failing).status).toBe('RETIRED');
  });

  it('obtains an unverified method that already covers the gap instead of deriving another', () => {
    const declared = declareMethod(SEED_METHODS, { id: 'risk-chain', name: 'r', kind: 'ANALYTICAL', purpose: 'p', fitsWhen: ['risk-transfer-chain'], misleadsWhen: [], requires: [] }, 'r');
    const gap = diagnoseCapabilityGap({ problem: subcontracting, methodsTried: ['risk-chain'], errorClasses: [] }, declared.catalogue);
    expect(gap.remedy).toBe('DERIVE');
    const gap2 = diagnoseCapabilityGap({ problem: { ...subcontracting, features: [{ feature: 'risk-transfer-chain', source: null }] }, methodsTried: [], errorClasses: [] }, declared.catalogue.map((m) => (m.id === 'risk-chain' ? { ...m, fitsWhen: ['risk-transfer-chain', 'x', 'y'] } : m)));
    expect(gap2.remedy).toBe('OBTAIN');
    expect(gap2.proposedMethod.id).toBe('risk-chain');
  });
});

describe('weak inferences are typed findings', () => {
  it('finds unsourced premises, thin generalizations, correlation-as-cause, anchoring, thin analogy, dangling and circular steps', () => {
    const findings = detectWeakInferences([
      { id: 'a', claim: 'buyers pay in 30 days', kind: 'ESTIMATE', premises: [], sources: [], observations: 1, independentFigures: 1 },
      { id: 'b', claim: 'sales rise with ads', kind: 'CORRELATION', premises: [], sources: ['s'] },
      { id: 'c', claim: 'ads cause sales', kind: 'CAUSAL', premises: ['b'], sources: [] },
      { id: 'd', claim: 'like freight', kind: 'ANALOGY', premises: ['zz'], sources: ['s'], sharedFeatures: 1 },
      { id: 'e', claim: 'loop', kind: 'DEDUCTION', premises: ['f'], sources: [] },
      { id: 'f', claim: 'loop2', kind: 'DEDUCTION', premises: ['e'], sources: [] },
      { id: 'g', claim: 'fine', kind: 'CAUSAL', premises: ['b'], sources: ['s'], causalSupport: 'EXPERIMENT' },
    ]);
    const types = new Set(findings.map((f) => `${f.stepId}:${f.type}`));
    expect(types).toEqual(
      new Set(['a:UNSOURCED_PREMISE', 'a:SINGLE_OBSERVATION_GENERALIZED', 'a:ANCHORED_ON_ONE_FIGURE', 'c:CORRELATION_AS_CAUSE', 'd:DANGLING_PREMISE', 'd:THIN_ANALOGY', 'e:CIRCULAR']),
    );
  });
});

describe('reusable procedures are learned from successes and errors', () => {
  it('learns USE from repeated success and AVOID from a recurring error, reusable only across domains', () => {
    const rows = [
      outcome({ domain: 'a' }),
      outcome({ domain: 'b' }),
      outcome({ methodId: 'reference-class', domain: 'a', succeeded: false, errorClass: 'novel-domain-mismatch' }),
      outcome({ methodId: 'reference-class', domain: 'a', succeeded: false, errorClass: 'novel-domain-mismatch' }),
    ];
    const procs = learnProcedures(rows);
    const use = procs.find((p) => p.rule === 'USE')!;
    const avoid = procs.find((p) => p.rule === 'AVOID')!;
    expect(use.methodId).toBe('bayesian-update');
    expect(use.reusable).toBe(true);
    expect(avoid.errorClass).toBe('novel-domain-mismatch');
    expect(avoid.reusable).toBe(false);
  });

  it('reads recorded outcomes back from the rows it wrote', async () => {
    await freshProject();
    await recordMethodOutcome(outcome({ problemId: 'r1' }));
    await recordMethodOutcome(outcome({ problemId: 'r2', succeeded: false, errorClass: 'e' }));
    const read = await readMethodOutcomes();
    expect(read.map((o) => o.problemId).sort()).toEqual(['r1', 'r2']);
  });
});

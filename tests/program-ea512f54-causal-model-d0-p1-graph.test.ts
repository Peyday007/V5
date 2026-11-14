/**
 * The causal graph model (CAUSAL-14-1..3): lineage refusal, reconciliation that
 * exposes a discrepancy instead of plugging it, volume through bottlenecks with
 * saturation, and streams that fail together.
 */
import { describe, expect, it } from 'vitest';
import {
  addAction,
  addMoneyRoute,
  addNode,
  addRelation,
  claimHistory,
  createGraph,
  currentClaim,
  declareType,
  derive,
  evaluatePortfolio,
  fullAccount,
  makeFigure,
  passVolume,
  readMoneyRoute,
  readyActions,
  recordClaim,
  reconcile,
  thresholdFor,
  trace,
  unknownFigure,
  type Figure,
  type FigureInput,
  type MoneyRoute,
  type OperationalAction,
} from '../server/services/quant/graph.ts';

function figure(input: FigureInput): Figure {
  const made = makeFigure(input);
  if (!made.ok) throw new Error(made.reason);
  return made.figure;
}

const observed = (value: number, extra: Partial<FigureInput> = {}): Figure =>
  figure({ meaning: 'm', unit: 'cents', value, status: 'OBSERVED', source: 'ledger', ...extra });

describe('makeFigure refuses a number without lineage', () => {
  it('needs a meaning and a unit', () => {
    expect(makeFigure({ meaning: ' ', unit: 'cents', value: 1, status: 'OBSERVED', source: 's' }).ok).toBe(false);
    expect(makeFigure({ meaning: 'x', unit: '', value: 1, status: 'OBSERVED', source: 's' }).ok).toBe(false);
  });

  it('needs a known status', () => {
    const r = makeFigure({ meaning: 'x', unit: 'u', value: 1, status: 'GUESSED' as never, source: 's' });
    expect(r.ok).toBe(false);
  });

  it('an unknown figure has no value; a known one has a finite value', () => {
    expect(makeFigure({ meaning: 'x', unit: 'u', value: 3, status: 'UNKNOWN' }).ok).toBe(false);
    expect(makeFigure({ meaning: 'x', unit: 'u', value: null, status: 'UNKNOWN' }).ok).toBe(true);
    expect(makeFigure({ meaning: 'x', unit: 'u', value: null, status: 'OBSERVED', source: 's' }).ok).toBe(false);
    expect(makeFigure({ meaning: 'x', unit: 'u', value: Number.NaN, status: 'OBSERVED', source: 's' }).ok).toBe(false);
    expect(makeFigure({ meaning: 'x', unit: 'u', value: Infinity, status: 'MODELED', source: 's' }).ok).toBe(false);
  });

  it('names its source or the inputs it derives from', () => {
    const r = makeFigure({ meaning: 'x', unit: 'u', value: 1, status: 'MODELED' });
    expect(r.ok).toBe(false);
    expect(makeFigure({ meaning: 'x', unit: 'u', value: 1, status: 'MODELED', source: '  ' }).ok).toBe(false);
    expect(makeFigure({ meaning: 'x', unit: 'u', value: 1, status: 'MODELED', derivedFrom: [observed(1)] }).ok).toBe(true);
  });

  it('refuses bounds on a status nothing supports, reversed bounds and a value outside its bounds', () => {
    const base = { meaning: 'x', unit: 'u', value: 5, source: 's' };
    for (const status of ['ASSUMED', 'CONTRACTED'] as const) {
      const r = makeFigure({ ...base, status, bounds: { low: 1, high: 9 } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('cannot carry bounds');
    }
    expect(makeFigure({ ...base, status: 'MODELED', bounds: { low: 9, high: 1 } }).ok).toBe(false);
    expect(makeFigure({ ...base, status: 'MODELED', bounds: { low: 6, high: 9 } }).ok).toBe(false);
    expect(makeFigure({ ...base, status: 'MODELED', bounds: { low: 1, high: 9 } }).ok).toBe(true);
  });

  it('keeps window, geography, scope and invalidating dependencies', () => {
    const f = figure({ meaning: 'x', unit: 'u', value: 1, status: 'OBSERVED', source: 's', window: 'Q4', geography: 'US', scope: 'cohort A', invalidatedBy: ['price change'] });
    expect([f.window, f.geography, f.scope, f.invalidatedBy]).toEqual(['Q4', 'US', 'cohort A', ['price change']]);
  });
});

describe('derive points at its inputs and never claims more than they do', () => {
  it('is unknown when any input is unknown, and still points at the inputs', () => {
    const gap = unknownFigure('conversion', 'share', ['platform terms']);
    const known = observed(10, { invalidatedBy: ['other'] });
    const out = derive('revenue', 'cents', [known, gap], ([a, b]) => a! * b!);
    expect(out.status).toBe('UNKNOWN');
    expect(out.value).toBeNull();
    expect(out.derivedFrom).toEqual([known, gap]);
    expect(out.invalidatedBy.sort()).toEqual(['other', 'platform terms']);
  });

  it('takes the weakest input status, and a computation over observed inputs is evidenced, not observed', () => {
    const a = observed(2);
    const b = figure({ meaning: 'm', unit: 'u', value: 3, status: 'ASSUMED', source: 'owner' });
    expect(derive('x', 'u', [a, b], ([x, y]) => x! * y!).status).toBe('ASSUMED');
    expect(derive('x', 'u', [a, observed(3)], ([x, y]) => x! * y!).status).toBe('EVIDENCED');
    const c = figure({ meaning: 'm', unit: 'u', value: 3, status: 'CONTRACTED', source: 'c' });
    expect(derive('x', 'u', [a, c], ([x, y]) => x! + y!).status).toBe('EVIDENCED');
  });

  it('carries bounds only when every input has them, evaluating at the corners', () => {
    const a = figure({ meaning: 'm', unit: 'u', value: 2, status: 'MODELED', source: 's', bounds: { low: 1, high: 3 } });
    const b = figure({ meaning: 'm', unit: 'u', value: 10, status: 'MODELED', source: 's', bounds: { low: 5, high: 20 } });
    const out = derive('product', 'u', [a, b], ([x, y]) => x! * y!);
    expect(out.value).toBe(20);
    expect(out.bounds).toEqual({ low: 5, high: 60 });
    const noBounds = figure({ meaning: 'm', unit: 'u', value: 10, status: 'MODELED', source: 's' });
    expect(derive('product', 'u', [a, noBounds], ([x, y]) => x! * y!).bounds).toBeNull();
  });

  it('keeps a window or scope only when the inputs agree on it', () => {
    const q4 = observed(1, { window: 'Q4', scope: 's1' });
    expect(derive('x', 'u', [q4, observed(2, { window: 'Q4', scope: 's2' })], ([a, b]) => a! + b!).window).toBe('Q4');
    expect(derive('x', 'u', [q4, observed(2, { window: 'Q1', scope: 's2' })], ([a, b]) => a! + b!).window).toBeNull();
    expect(derive('x', 'u', [q4, observed(2, { window: 'Q4', scope: 's2' })], ([a, b]) => a! + b!).scope).toBeNull();
  });
});

describe('thresholdFor finds what an unknown must be for the plan to work', () => {
  it('bisects to the lowest input that reaches the target', () => {
    const t = thresholdFor(100, 1000, (x) => x * 2);
    expect(t).toBeCloseTo(50, 5);
  });
  it('is null when even the ceiling falls short, or the ceiling is not positive', () => {
    expect(thresholdFor(100, 10, (x) => x * 2)).toBeNull();
    expect(thresholdFor(1, 0, (x) => x)).toBeNull();
  });
});

describe('the vocabulary is open but not silent', () => {
  it('refuses a node of an undeclared type until it is declared with a reason', () => {
    const g = createGraph('s');
    expect(addNode(g, { id: 'n', type: 'escrow_hold', label: 'x' }).ok).toBe(false);
    expect(declareType(g, 'node', 'Escrow Hold', '').ok).toBe(false);
    expect(declareType(g, 'node', '!!', 'why').ok).toBe(false);
    expect(declareType(g, 'node', 'Escrow Hold', 'funds held by a third party').ok).toBe(true);
    expect(g.nodeTypes.get('escrow_hold')?.reason).toBe('funds held by a third party');
    expect(addNode(g, { id: 'n', type: 'escrow_hold', label: 'x' }).ok).toBe(true);
    expect(addNode(g, { id: 'n', type: 'payer', label: 'dup' }).ok).toBe(false);
  });

  it('keeps the first reason for a type declared twice', () => {
    const g = createGraph('s');
    declareType(g, 'relation', 'underwrites', 'first');
    declareType(g, 'relation', 'underwrites', 'second');
    expect(g.relationTypes.get('underwrites')?.reason).toBe('first');
  });

  it('refuses relations over missing nodes or undeclared types, and duplicates', () => {
    const g = createGraph('s');
    addNode(g, { id: 'a', type: 'payer', label: 'a' });
    addNode(g, { id: 'b', type: 'offer', label: 'b' });
    expect(addRelation(g, { id: 'r', type: 'pays', from: 'a', to: 'zzz' }).ok).toBe(false);
    expect(addRelation(g, { id: 'r', type: 'bribes', from: 'a', to: 'b' }).ok).toBe(false);
    expect(addRelation(g, { id: 'r', type: 'pays', from: 'a', to: 'b' }).ok).toBe(true);
    expect(addRelation(g, { id: 'r', type: 'pays', from: 'a', to: 'b' }).ok).toBe(false);
  });
});

describe('operational actions are complete or refused', () => {
  const action = (over: Partial<OperationalAction> = {}): OperationalAction => ({
    id: 'a1', label: 'Send invoice', prerequisites: [], actor: 'owner', permissions: ['billing'], effect: 'invoice issued',
    timing: 'within 2 days', externalDependencies: [], evidence: ['signed order'], completionCondition: 'invoice delivered', ...over,
  });

  it('refuses a missing text field, permissions, evidence or an unknown prerequisite', () => {
    const g = createGraph('s');
    for (const key of ['label', 'actor', 'effect', 'timing', 'completionCondition'] as const) {
      expect(addAction(g, action({ [key]: ' ' })).ok, key).toBe(false);
    }
    expect(addAction(g, action({ permissions: [] })).ok).toBe(false);
    expect(addAction(g, action({ evidence: [] })).ok).toBe(false);
    expect(addAction(g, action({ prerequisites: ['nope'] })).ok).toBe(false);
    expect(g.actions.size).toBe(0);
  });

  it('knows which actions are ready once prerequisites are complete', () => {
    const g = createGraph('s');
    expect(addAction(g, action()).ok).toBe(true);
    expect(addAction(g, action({ id: 'a2', prerequisites: ['a1'] })).ok).toBe(true);
    expect(addAction(g, action()).ok).toBe(false);
    expect(readyActions(g, new Set()).map((a) => a.id)).toEqual(['a1']);
    expect(readyActions(g, new Set(['a1'])).map((a) => a.id)).toEqual(['a2']);
    expect(readyActions(g, new Set(['a1', 'a2']))).toEqual([]);
  });
});

describe('the money route says what is genuinely free', () => {
  const route = (over: Partial<MoneyRoute> = {}): MoneyRoute => ({
    id: 'rt', payer: 'Acme', for: 'service', terms: 'net 30', channel: 'direct', invoicedAt: '2026-11-01', collectedAt: '2026-12-01',
    collectedCents: observed(100_000), heldAgainstCents: figure({ meaning: 'held', unit: 'cents', value: 20_000, status: 'CONTRACTED', source: 'contract' }),
    outflows: [{ to: 'supplier', reason: 'cost', amountCents: 30_000, at: '2026-11-15' }, { to: 'tax', reason: 'tax', amountCents: 5_000, at: null }],
    ...over,
  });

  it('subtracts the hold and the outflows from what was collected', () => {
    const reading = readMoneyRoute(route());
    expect(reading.freeCents.value).toBe(45_000);
    expect(reading.outflowCents).toBe(35_000);
    expect(reading.gaps).toEqual(['when tax is paid']);
    expect(reading.freeCents.derivedFrom).toHaveLength(3);
  });

  it('an under-water route reports its shortfall instead of plugging it to zero', () => {
    const r = readMoneyRoute(route({ collectedCents: observed(1_000), heldAgainstCents: observed(0), outflows: [{ to: 'supplier', reason: 'cost', amountCents: 5_000, at: '2026-11-15' }] }));
    expect(r.freeCents.value).toBe(-4_000);
    expect(r.shortfallCents).toBe(4_000);
    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]).toContain('4000 cents');
    expect(r.gaps).toEqual([]);
  });

  it('a route that covers its outflows has no shortfall and no discrepancy', () => {
    const r = readMoneyRoute(route());
    expect(r.shortfallCents).toBe(0);
    expect(r.discrepancies).toEqual([]);
  });

  it('the free amount moves across the zero line without being clamped', () => {
    const before = readMoneyRoute(route({ collectedCents: observed(10_000) }));
    const after = readMoneyRoute(route({ collectedCents: observed(60_000) }));
    expect(before.freeCents.value).toBe(-45_000);
    expect(after.freeCents.value).toBe(5_000);
    expect((after.freeCents.value as number) - (before.freeCents.value as number)).toBe(50_000);
  });

  it('collected money still held is not free', () => {
    const r = readMoneyRoute(route({ heldAgainstCents: observed(100_000), outflows: [] }));
    expect(r.freeCents.value).toBe(0);
    expect(r.shortfallCents).toBe(0);
  });

  it('an unknown collection leaves the shortfall unknown rather than zero', () => {
    expect(readMoneyRoute(route({ collectedCents: unknownFigure('c', 'cents') })).shortfallCents).toBeNull();
  });

  it('an unknown collection or hold makes free cash unknown and names the gap', () => {
    const noCollect = readMoneyRoute(route({ collectedCents: unknownFigure('c', 'cents') }));
    expect(noCollect.freeCents.value).toBeNull();
    expect(noCollect.gaps).toContain('collected amount');
    const noHold = readMoneyRoute(route({ heldAgainstCents: unknownFigure('h', 'cents') }));
    expect(noHold.freeCents.value).toBeNull();
    expect(noHold.gaps).toContain('amount held against refund or fulfilment');
  });

  it('names every unstated part of the route', () => {
    const r = readMoneyRoute(route({ payer: '', terms: ' ', invoicedAt: null, collectedAt: null }));
    expect(r.gaps).toEqual(expect.arrayContaining(['payer', 'terms', 'invoice date', 'collection date']));
  });
});

describe('double-entry reconciliation exposes a discrepancy', () => {
  const entries = [
    { id: '1', debit: 'cash', credit: 'revenue', amountCents: 1000, evidence: 'invoice 1' },
    { id: '2', debit: 'cost', credit: 'cash', amountCents: 300, evidence: 'bill 1' },
  ];

  it('reproduces each account from its entries and balances', () => {
    const r = reconcile(entries);
    expect(r.balances).toEqual({ cash: 700, revenue: -1000, cost: 300 });
    expect(r.balanced).toBe(true);
    expect(r.discrepancies).toEqual([]);
  });

  it('reports a wrong claim with its difference and does not adjust the balance', () => {
    const r = reconcile(entries, { cash: 900, revenue: -1000 });
    expect(r.discrepancies).toEqual([{ account: 'cash', claimedCents: 900, entriesCents: 700, differenceCents: 200 }]);
    expect(r.balances.cash).toBe(700);
  });

  it('a claimed account with no entries is unsupported, not zero', () => {
    const r = reconcile(entries, { deposits: 500 });
    expect(r.unsupported).toEqual(['deposits']);
    expect(r.discrepancies).toEqual([]);
  });

  it('a malformed entry is skipped and the books are reported as not balanced', () => {
    for (const bad of [{ id: 'x', debit: 'a', credit: 'a', amountCents: 5, evidence: '' }, { id: 'y', debit: 'a', credit: 'b', amountCents: -5, evidence: '' }, { id: 'z', debit: 'a', credit: 'b', amountCents: Number.NaN, evidence: '' }]) {
      const r = reconcile([...entries, bad]);
      expect(r.balanced).toBe(false);
      expect(r.balances).toEqual({ cash: 700, revenue: -1000, cost: 300 });
    }
  });
});

describe('passVolume: volume is revenue only after every bottleneck', () => {
  const stage = (name: string, y: number, extra: Record<string, unknown> = {}) => ({
    name,
    yield: figure({ meaning: name, unit: 'share', value: y, status: 'OBSERVED', source: 's' }),
    ...extra,
  });

  it('multiplies yields stage by stage', () => {
    const r = passVolume(1000, [stage('reach', 0.5), stage('buy', 0.2)]);
    expect(r.outputUnits).toBeCloseTo(100);
    expect(r.stages.map((s) => s.passed)).toEqual([500, 100]);
    expect(r.bindingConstraint).toBe('buy');
    expect(r.firstUnknown).toBeNull();
  });

  it('a capacity caps the volume, and the cap is the binding constraint over a lower yield', () => {
    const cap = figure({ meaning: 'cap', unit: 'units', value: 50, status: 'OBSERVED', source: 's' });
    const r = passVolume(1000, [stage('reach', 0.1), stage('deliver', 0.9, { capacity: cap }), stage('pay', 0.95)]);
    expect(r.stages[1]).toMatchObject({ passed: 50, capped: true });
    expect(r.outputUnits).toBeCloseTo(47.5);
    expect(r.bindingConstraint).toBe('deliver');
  });

  it('upstream volume cannot be assumed to keep its yield: saturation halves it at the half point', () => {
    const lowVolume = passVolume(100, [stage('ads', 0.5, { saturationHalfAt: 1000 })]);
    const highVolume = passVolume(1000, [stage('ads', 0.5, { saturationHalfAt: 1000 })]);
    expect(lowVolume.stages[0]?.effectiveYield).toBeCloseTo(0.5 / 1.1);
    expect(highVolume.stages[0]?.effectiveYield).toBeCloseTo(0.25);
    expect(highVolume.stages[0]?.saturated).toBe(true);
    // Ten times the spend buys far less than ten times the output.
    expect((highVolume.outputUnits as number) / (lowVolume.outputUnits as number)).toBeLessThan(6);
    const none = passVolume(1000, [stage('ads', 0.5)]);
    expect(none.stages[0]).toMatchObject({ saturated: false, effectiveYield: 0.5 });
  });

  it('an unknown yield makes everything downstream unknown, never a favourable number', () => {
    const r = passVolume(1000, [stage('reach', 0.5), { name: 'buy', yield: unknownFigure('buy', 'share') }, stage('pay', 0.9)]);
    expect(r.outputUnits).toBeNull();
    expect(r.firstUnknown).toBe('buy');
    expect(r.stages[1]?.unknown).toContain('buy');
    expect(r.stages[2]?.passed).toBeNull();
    expect(r.stages[2]?.incoming).toBeNull();
  });

  it('an unknown capacity is unknown, not unlimited', () => {
    const r = passVolume(1000, [stage('deliver', 0.9, { capacity: unknownFigure('cap', 'units') })]);
    expect(r.outputUnits).toBeNull();
    expect(r.stages[0]?.unknown).toContain('capacity is unknown');
  });
});

describe('evaluatePortfolio: shared resources fail together', () => {
  const streams = [
    { id: 's1', bestCaseCents: 100, resources: ['platform'] },
    { id: 's2', bestCaseCents: 100, resources: ['platform'] },
  ];

  it('refuses a resource with no stated failure probability, or an impossible one', () => {
    expect(evaluatePortfolio(streams, {}, 1)).toEqual({ missing: ['platform'] });
    expect(evaluatePortfolio(streams, { platform: 1.5 }, 1)).toEqual({ missing: ['platform'] });
    expect(evaluatePortfolio(streams, { platform: -0.1 }, 1)).toEqual({ missing: ['platform'] });
  });

  it('does not sum the independent best cases and names the shared resource', () => {
    const r = evaluatePortfolio(streams, { platform: 0.5 }, 7, 4000);
    if ('missing' in r) throw new Error('unexpected');
    expect(r.naiveSumCents).toBe(200);
    expect(r.expectedCents).toBeGreaterThan(80);
    expect(r.expectedCents).toBeLessThan(120);
    expect(r.shared).toEqual(['platform']);
    // One shared resource: both streams are up together half the time, not a quarter.
    expect(r.allUpProbability).toBeGreaterThan(0.45);
    expect(r.allUpProbability).toBeLessThan(0.55);
    expect(r.halfLossProbability).toBeGreaterThan(0.45);
  });

  it('independent resources are not reported as shared and fail less together', () => {
    const r = evaluatePortfolio(
      [{ id: 's1', bestCaseCents: 100, resources: ['a'] }, { id: 's2', bestCaseCents: 100, resources: ['b'] }],
      { a: 0.5, b: 0.5 },
      7,
      4000,
    );
    if ('missing' in r) throw new Error('unexpected');
    expect(r.shared).toEqual([]);
    expect(r.allUpProbability).toBeLessThan(0.32);
  });

  it('is reproducible from its seed', () => {
    const a = evaluatePortfolio(streams, { platform: 0.3 }, 99, 500);
    const b = evaluatePortfolio(streams, { platform: 0.3 }, 99, 500);
    expect(a).toEqual(b);
  });
});

describe('claims keep their history', () => {
  it('a replaced claim keeps every earlier version and the reason', () => {
    const g = createGraph('s');
    expect(currentClaim(g, 'price')).toBeNull();
    const first = recordClaim(g, 'price', observed(10));
    expect(first).toMatchObject({ version: 1, reason: '' });
    const second = recordClaim(g, 'price', observed(12), 'new quote');
    expect(second).toMatchObject({ version: 2, reason: 'new quote' });
    expect(recordClaim(g, 'price', observed(13)).reason).toBe('replaced without a stated reason');
    expect(currentClaim(g, 'price')?.value).toBe(13);
    expect(claimHistory(g, 'price').map((v) => v.figure.value)).toEqual([10, 12, 13]);
    expect(claimHistory(g, 'absent')).toEqual([]);
  });
});

describe('trace and the full account', () => {
  function chainGraph() {
    const g = createGraph('s');
    for (const [id, type] of [['p', 'payer'], ['o', 'offer'], ['c', 'channel'], ['x', 'supplier']] as const) addNode(g, { id, type, label: id });
    addRelation(g, { id: 'r1', type: 'pays', from: 'p', to: 'o' });
    addRelation(g, { id: 'r2', type: 'delivers', from: 'o', to: 'c' });
    addRelation(g, { id: 'r3', type: 'requires', from: 'o', to: 'x' });
    addRelation(g, { id: 'r4', type: 'causes', from: 'c', to: 'p' });
    return g;
  }

  it('follows effects forward and causes backward, nearest first, without looping', () => {
    const g = chainGraph();
    const forward = trace(g, 'p', 'forward');
    expect(forward?.reached.map((r) => [r.node.id, r.depth])).toEqual([['o', 1], ['c', 2], ['x', 2]]);
    const backward = trace(g, 'o', 'backward');
    expect(backward?.reached.map((r) => r.node.id)).toEqual(['p', 'c']);
    expect(trace(g, 'p', 'forward', 1)?.reached.map((r) => r.node.id)).toEqual(['o']);
  });

  it('is null for a node that is not there', () => {
    expect(trace(chainGraph(), 'zzz', 'forward')).toBeNull();
  });

  it('presents everything, unsummarised, with route readings and claim history', () => {
    const g = chainGraph();
    addMoneyRoute(g, {
      id: 'rt', payer: 'p', for: 'f', terms: 't', channel: 'c', invoicedAt: null, collectedAt: null,
      collectedCents: unknownFigure('c', 'cents'), heldAgainstCents: unknownFigure('h', 'cents'), outflows: [],
    });
    expect(addMoneyRoute(g, g.routes.get('rt') as MoneyRoute).ok).toBe(false);
    recordClaim(g, 'k', observed(1));
    recordClaim(g, 'k', observed(2), 'r');
    const account = fullAccount(g);
    expect(account.nodes).toHaveLength(4);
    expect(account.relations).toHaveLength(4);
    expect(account.nodeTypes.length).toBeGreaterThan(20);
    expect(account.routes[0]?.freeCents.value).toBeNull();
    expect(account.claims.k).toHaveLength(2);
  });
});

import { describe, expect, it } from 'vitest';
import {
  AMOUNT_BASES,
  BASIS,
  REALISED_LABELS,
  STATE_DISPLAY,
  basisOfMoneyLine,
  displayAmount,
  displayFact,
  displayMoneyClass,
  displayMoneyLine,
  displayState,
  workingCountDisplay,
  type AmountBasis,
  type TruthContext,
} from '../client/src/world/truth.ts';
import {
  DEFAULT_THEME_REGISTRY,
  DRAGON_THEME,
  PLAIN_THEME,
  THEME_REGISTRY_VERSION,
  createThemeRegistry,
  getTheme,
  present,
  registerTheme,
  type ThemeDefinition,
} from '../client/src/world/theme.ts';
import type { MoneyClass, WorldFact, WorldMoney, WorldState } from '../server/routes/world.ts';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const fresh: TruthContext = { world: { generatedAt: '2026-11-14T11:59:00.000Z', projectId: 'prj_1' }, nowMs: NOW };
const old: TruthContext = { world: { generatedAt: '2026-11-13T00:00:00.000Z', projectId: 'prj_1' }, nowMs: NOW };

const STATES: WorldState[] = ['WORKING', 'WAITING', 'BLOCKED', 'NEEDS_APPROVAL', 'SUCCEEDED', 'FAILED', 'IDLE', 'UNKNOWN'];
const MODELLED: AmountBasis[] = ['PROJECTED', 'SIMULATED', 'OFFERED', 'ESTIMATED', 'MODELLED'];

function fact(over: Partial<WorldFact> = {}): WorldFact {
  return {
    kind: 'WORK_UNIT',
    recordId: 'wi_1',
    href: '/api/work/wi_1',
    title: 'A unit',
    owner: 'prs_1',
    state: 'WAITING',
    recordState: 'QUEUED',
    startedAt: '2026-11-14T10:00:00.000Z',
    lastChangedAt: '2026-11-14T11:00:00.000Z',
    blocker: null,
    nextAction: null,
    source: { table: 'work_items', id: 'wi_1' },
    freshness: 'FRESH',
    missing: [],
    district: 'ROADS',
    ...over,
  };
}

describe('truth: money labels', () => {
  it('never labels a simulated, projected, offered, estimated or modelled amount as received, sold, contracted or measured', () => {
    for (const basis of MODELLED) {
      const v = displayAmount({ basis, amountCents: 12345, currency: 'USD', asOf: '2026-11-14T11:00:00.000Z', owner: 'prj_1', source: 'x#1', ctx: fresh });
      expect(REALISED_LABELS).not.toContain(v.basisLabel);
      expect(v.basisLabel.toLowerCase()).toMatch(/not /);
      expect(v.confidence).toBe('MODELLED');
    }
    for (const basis of AMOUNT_BASES) {
      if (BASIS[basis].confidence === 'MODELLED') expect(REALISED_LABELS).not.toContain(BASIS[basis].label);
    }
  });

  it('labels each money class distinctly, and only a customer payment is cash collected', () => {
    const classes: Array<[MoneyClass, string]> = [
      ['received', 'CUSTOMER_PAYMENT'],
      ['due', 'INVOICE_ISSUED'],
      ['due', 'UNPAID_COMMITMENT'],
      ['projected', 'PIPELINE_AGREED'],
      ['simulated', 'SCENARIO'],
    ];
    const labels = classes.map(([cls, kind]) => BASIS[basisOfMoneyLine(cls, { kind })!].label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(basisOfMoneyLine('received', { kind: 'CUSTOMER_PAYMENT' })).toBe('COLLECTED');
    expect(basisOfMoneyLine('received', { kind: 'SOMETHING_NEW' })).toBeNull();
    expect(basisOfMoneyLine('projected', { kind: 'PIPELINE_AGREED' })).toBe('PROJECTED');
    expect(basisOfMoneyLine('due', { kind: 'INVOICE_ISSUED' })).toBe('INVOICED');
    expect(basisOfMoneyLine('due', { kind: 'UNPAID_COMMITMENT' })).toBe('SIGNED_UNSETTLED');
  });

  it('carries unit, time range, owner, source, confidence and freshness on every line', () => {
    const money: WorldMoney = {
      class: 'received',
      meaning: 'Cash a customer actually paid',
      lines: [
        {
          kind: 'CUSTOMER_PAYMENT',
          direction: 'IN',
          currency: 'USD',
          amountCents: 5000,
          source: { table: 'cash_money_entries', filter: 'kind = CUSTOMER_PAYMENT AND currency = USD' },
          lastChangedAt: '2026-11-14T09:00:00.000Z',
        },
      ],
      missing: null,
    };
    const [v] = displayMoneyClass(money, fresh);
    expect(v).toMatchObject({
      text: '$50.00',
      value: 5000,
      unit: 'USD (cents)',
      basis: 'COLLECTED',
      basisLabel: 'Cash collected',
      confidence: 'MEASURED',
      freshness: 'CURRENT',
      asOf: '2026-11-14T09:00:00.000Z',
      owner: 'project prj_1',
      source: 'cash_money_entries where kind = CUSTOMER_PAYMENT AND currency = USD',
    });
    expect(v!.timeRange.to).toBe(fresh.world.generatedAt);
  });
});

describe('truth: missing and stale', () => {
  it('renders an empty class as missing with its reason, never as zero', () => {
    const money: WorldMoney = { class: 'received', meaning: 'm', lines: [], missing: 'No entry of this class is recorded for this project.' };
    const [v] = displayMoneyClass(money, fresh);
    expect(v!.value).toBeNull();
    expect(v!.text).toBe('Not recorded');
    expect(v!.text).not.toMatch(/0/);
    expect(v!.freshness).toBe('MISSING');
    expect(v!.note).toBe(money.missing);
  });

  it('renders a missing amount as missing, never as zero', () => {
    const v = displayAmount({ basis: 'OFFERED', amountCents: null, currency: 'USD', asOf: null, owner: null, source: null, ctx: fresh });
    expect(v.text).toBe('Not recorded');
    expect(v.freshness).toBe('MISSING');
    expect(v.confidence).toBe('UNKNOWN');
    expect(v.missing).toEqual(['amount', 'asOf', 'owner', 'source']);
  });

  it('renders a stale snapshot as stale with its timestamp, never as current', () => {
    const line = { kind: 'CUSTOMER_PAYMENT', direction: 'IN' as const, currency: 'USD', amountCents: 1, source: { table: 't', filter: 'f' }, lastChangedAt: null };
    const v = displayMoneyLine({ class: 'received' }, line, old);
    expect(v.freshness).toBe('STALE');
    expect(v.note).toContain(old.world.generatedAt);
    expect(v.missing).toContain('lastChangedAt');
  });

  it('shows a stale or missing fact with its timestamp in words', () => {
    const stale = displayFact(fact({ freshness: 'STALE', lastChangedAt: '2026-11-01T00:00:00.000Z' }), fresh);
    expect(stale.freshness).toBe('STALE');
    expect(stale.note).toContain('2026-11-01T00:00:00.000Z');
    const missing = displayFact(fact({ freshness: 'MISSING', lastChangedAt: null, owner: null }), fresh);
    expect(missing.freshness).toBe('MISSING');
    expect(missing.lastChangedAt).toBe('Not recorded');
    expect(missing.owner).toBe('Owner not recorded');
    expect(displayFact(fact(), old).freshness).toBe('STALE');
  });
});

describe('truth: work state', () => {
  it('only WORKING is active; every state has a word', () => {
    for (const s of STATES) {
      expect(STATE_DISPLAY[s].active).toBe(s === 'WORKING');
      expect(STATE_DISPLAY[s].label.length).toBeGreaterThan(0);
    }
    expect(displayState('SOMETHING_NEW')).toMatchObject({ state: 'UNKNOWN', active: false });
  });

  it('the worker count is the live-lease count, not the drawn characters', () => {
    expect(workingCountDisplay({ workingCount: 1, workers: [] }).value).toBe(1);
    expect(workingCountDisplay({ workingCount: 0, workers: [{ workerId: 'w', state: 'UNKNOWN', holding: [] }] }).value).toBe(0);
  });
});

describe('theme registry', () => {
  it('is versioned and ships the dragon and plain themes', () => {
    expect(DEFAULT_THEME_REGISTRY.version).toBe(THEME_REGISTRY_VERSION);
    expect(getTheme(DEFAULT_THEME_REGISTRY, 'dragon')).toBe(DRAGON_THEME);
    expect(getTheme(DEFAULT_THEME_REGISTRY, 'plain')).toBe(PLAIN_THEME);
    const keys = new Set(Object.values(DRAGON_THEME.byKind).flat().map((o) => o.key));
    for (const k of ['citadel', 'library', 'observatory', 'forge', 'market', 'treasury', 'roads', 'caravan', 'laboratory']) expect(keys).toContain(k);
  });

  it('maps an unknown or cross-cutting kind to the neutral representation, not a district', () => {
    const p = present({ kind: 'BRAND_NEW_CAPABILITY', recordId: 'x', href: null, state: 'IDLE' }, DRAGON_THEME);
    expect(p.neutral).toBe(true);
    expect(p.objects).toEqual(DRAGON_THEME.neutral);
    expect(p.objects.some((o) => o.kind === 'district')).toBe(false);
    const prototypeKey = present({ kind: 'toString', recordId: 'y', href: null, state: 'IDLE' }, DRAGON_THEME);
    expect(prototypeKey.neutral).toBe(true);
  });

  it('both themes map the same fact to the same state and record', () => {
    for (const s of STATES) {
      const f = fact({ state: s });
      const a = present(f, DRAGON_THEME);
      const b = present(f, PLAIN_THEME);
      for (const p of [a, b]) {
        expect(p.state).toBe(s);
        expect(p.recordId).toBe(f.recordId);
        expect(p.href).toBe(f.href);
        expect(p.animate).toBe(s === 'WORKING');
      }
      expect(a.stateLabel).toBe(b.stateLabel);
    }
  });

  it('one fact can have several representations while its meaning is unchanged', () => {
    const p = present(fact({ kind: 'WORKER', state: 'UNKNOWN' }), DRAGON_THEME);
    expect(p.objects.length).toBeGreaterThan(1);
    expect(p.state).toBe('UNKNOWN');
    expect(p.animate).toBe(false);
  });

  it('is extendable by data: a new theme or version is registered, an incomplete one is refused', () => {
    const night: ThemeDefinition = { ...PLAIN_THEME, id: 'night', name: 'Night', byKind: { ...PLAIN_THEME.byKind, SUPPLIER: [{ kind: 'building', key: 'warehouse', label: 'Warehouse' }] } };
    const reg = registerTheme(DEFAULT_THEME_REGISTRY, night);
    expect(getTheme(reg, 'night')?.byKind.SUPPLIER?.[0]?.key).toBe('warehouse');
    expect(getTheme(DEFAULT_THEME_REGISTRY, 'night')).toBeNull();
    const v2 = registerTheme(reg, { ...night, version: 2, name: 'Night v2' });
    expect(getTheme(v2, 'night')?.version).toBe(2);
    expect(getTheme(v2, 'night', 1)?.version).toBe(1);
    expect(() => registerTheme(reg, night)).toThrow(/already registered/);
    const { UNKNOWN: _drop, ...partialArt } = PLAIN_THEME.stateArt;
    expect(() => createThemeRegistry([{ ...night, id: 'broken', stateArt: partialArt as ThemeDefinition['stateArt'] }])).toThrow(/UNKNOWN/);
  });
});

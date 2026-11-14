/**
 * UI-27-3: World, Operations and Goal are lenses over one state. A mode switch
 * keeps the selection, timeframe and goal; a URL restores the same state; the
 * conversation is grounded in the selected real record and nothing else.
 */
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_TURN_ROUTE,
  LENS_MODES,
  conversationGrounding,
  groundingPreface,
  initialLensState,
  lensQuery,
  lensReducer,
  parseLensQuery,
  type LensState,
} from '../client/src/world/lens.ts';
import type { WorldFact } from '../server/routes/world.ts';

function fact(over: Partial<WorldFact> = {}): WorldFact {
  return {
    kind: 'CAMPAIGN',
    recordId: 'fcp_1',
    href: '/api/factory/campaigns/fcp_1',
    title: 'Campaign one',
    owner: null,
    state: 'BLOCKED',
    recordState: 'BLOCKED',
    startedAt: '2026-11-01T00:00:00.000Z',
    lastChangedAt: '2026-11-14T00:00:00.000Z',
    blocker: 'waiting for integration',
    nextAction: null,
    source: { table: 'factory_campaigns', id: 'fcp_1' },
    freshness: 'FRESH',
    missing: [],
    district: 'FORGE',
    ...over,
  };
}

function chosen(): LensState {
  let s = initialLensState();
  s = lensReducer(s, { type: 'SELECT', selection: { kind: 'CAMPAIGN', id: 'fcp_1' } });
  s = lensReducer(s, { type: 'SET_TIMEFRAME', timeframe: { from: '2026-11-01T00:00:00Z', to: '2026-11-14T00:00:00Z' } });
  s = lensReducer(s, { type: 'SET_GOAL', goalId: 'goal_9' });
  s = lensReducer(s, { type: 'SET_FILTER', key: 'district', value: 'FORGE' });
  return s;
}

describe('lens state (UI-27-3)', () => {
  it('switching between the three modes preserves selection, timeframe and goal', () => {
    let s = chosen();
    for (const mode of [...LENS_MODES, ...[...LENS_MODES].reverse()]) {
      const before = s;
      s = lensReducer(s, { type: 'SET_MODE', mode });
      expect(s.mode).toBe(mode);
      expect(s.selected).toEqual(before.selected);
      expect(s.timeframe).toEqual(before.timeframe);
      expect(s.goalId).toBe(before.goalId);
      expect(s.filters).toEqual(before.filters);
    }
    expect(s.selected).toEqual({ kind: 'CAMPAIGN', id: 'fcp_1' });
    expect(s.goalId).toBe('goal_9');
  });

  it('selecting a goal record focuses that goal; an invalid selection is not kept', () => {
    let s = lensReducer(initialLensState(), { type: 'SELECT', selection: { kind: 'GOAL', id: 'goal_3' } });
    expect(s.goalId).toBe('goal_3');
    s = lensReducer(s, { type: 'SELECT', selection: { kind: 'NOT_A_KIND' as never, id: 'x' } });
    expect(s.selected).toBeNull();
    expect(s.goalId).toBe('goal_3');
  });

  it('a URL produced from a state parses back to the identical state', () => {
    const states: LensState[] = [initialLensState(), chosen(), lensReducer(chosen(), { type: 'SET_MODE', mode: 'GOAL' })];
    states.push(lensReducer(lensReducer(initialLensState(), { type: 'SET_TIMEFRAME', timeframe: { preset: '30d' } }), { type: 'SET_MODE', mode: 'OPERATIONS' }));
    states.push(lensReducer(initialLensState(), { type: 'SELECT', selection: { kind: 'WORK_UNIT', id: 'wi:with:colons & spaces' } }));
    for (const s of states) {
      expect(parseLensQuery(lensQuery(s))).toEqual(s);
      expect(parseLensQuery(`?${lensQuery(s)}`)).toEqual(s);
    }
  });

  it('an unknown parameter is ignored and an unusable value falls back to its default', () => {
    const s = chosen();
    expect(parseLensQuery(`${lensQuery(s)}&utm_source=mail&zoom=3`)).toEqual(s);
    const bad = parseLensQuery('lens=space&sel=DRAGON:1&tf=forever&from=yesterday&to=today');
    expect(bad).toEqual(initialLensState());
  });

  it('the conversation grounding names the selected record and its href', () => {
    const g = conversationGrounding(chosen(), [fact({ recordId: 'other', href: '/api/factory/campaigns/other' }), fact()]);
    expect(g).not.toBeNull();
    expect(g!.kind).toBe('CAMPAIGN');
    expect(g!.recordId).toBe('fcp_1');
    expect(g!.href).toBe('/api/factory/campaigns/fcp_1');
    expect(g!.state).toBe('BLOCKED');
    expect(g!.found).toBe(true);
    expect(g!.route).toBe(CONVERSATION_TURN_ROUTE);
    expect(groundingPreface(g)).toContain('/api/factory/campaigns/fcp_1');
  });

  it('a selection the world read does not contain is grounded as UNKNOWN with no address, never a guess', () => {
    const g = conversationGrounding(chosen(), [fact({ recordId: 'other' })]);
    expect(g!.found).toBe(false);
    expect(g!.href).toBeNull();
    expect(g!.state).toBe('UNKNOWN');
    expect(groundingPreface(g)).toContain('not found');
  });

  it('the grounding is empty when nothing is selected', () => {
    const s = lensReducer(chosen(), { type: 'SELECT', selection: null });
    expect(conversationGrounding(s, [fact()])).toBeNull();
    expect(groundingPreface(null)).toBe('');
  });
});

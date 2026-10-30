import { describe, expect, it } from 'vitest';
import { goalBudgetFrom, orderQuestions, selectWithinBudget } from '../server/services/routing/priority/index.ts';
import type { OpenQuestion } from '../server/services/routing/priority/index.ts';
import { executionOrder } from '../server/services/research/quota.ts';
import type { ResearchFragment } from '../server/domain/types.ts';

const q = (key: string, o: Partial<OpenQuestion> = {}): OpenQuestion => ({
  key, impact: 'CONTEXT', valueCents: null, costUnits: 1, blocks: 0, reuse: 0, staleDays: null, ...o,
});

describe('question priority', () => {
  it('a few critical questions outrank many low-value ones within the goal budget', () => {
    const low = Array.from({ length: 50 }, (_, i) => q(`low-${String(i).padStart(2, '0')}`, { costUnits: 1, reuse: 5 }));
    const critical = [q('crit-a', { impact: 'CHANGES_DECISION', costUnits: 3 }), q('crit-b', { impact: 'CHANGES_DECISION', costUnits: 4, blocks: 2 })];
    const sel = selectWithinBudget([...low, ...critical], { units: 10, basis: 'test' });
    expect(sel.chosen.slice(0, 2).map((r) => r.question.key)).toEqual(['crit-b', 'crit-a']);
    expect(sel.chosen).toHaveLength(2 + 3);
    expect(sel.spentUnits).toBe(10);
    expect(sel.deferred).toHaveLength(47);
  });

  it('says what decided each place, and never ranks an unknown value above a stated one', () => {
    const r = orderQuestions([q('a'), q('b', { valueCents: 100 }), q('c', { impact: 'INFORMS' })]);
    expect(r.map((x) => x.question.key)).toEqual(['c', 'b', 'a']);
    expect(r[1]!.because).toBe('its stated value is higher');
  });

  it('states no budget as no ceiling, and derives units only from the goal hours', () => {
    expect(goalBudgetFrom(null, 2).units).toBeNull();
    expect(goalBudgetFrom({ hoursCeiling: 5 }, 2).units).toBe(10);
    expect(selectWithinBudget([q('x')], goalBudgetFrom(null, 2)).deferred).toHaveLength(0);
  });
});

describe('quota hook', () => {
  const frag = (key: string, index: number) => ({ fragmentKey: key, fragmentIndex: index, attempt: 0, estimatedEffort: 'MEDIUM', requirementIds: ['r'], priority: 5 }) as unknown as ResearchFragment;
  it('is unchanged without a value reader and reorders within a tier with one', () => {
    const f = [frag('a', 0), frag('b', 1)];
    expect(executionOrder(f, f).map((x) => x.fragmentKey)).toEqual(['a', 'b']);
    expect(executionOrder(f, f, (x) => (x.fragmentKey === 'b' ? 9 : 0)).map((x) => x.fragmentKey)).toEqual(['b', 'a']);
  });
});

/**
 * A goal with hundreds of held openings, generated deterministically from the
 * $10K fixture's repeatable cards (lens P, 2026-11-14: production held about
 * 500 qualified, repeatable openings and a cold plan read took 26 min 41 s).
 * Each generated opening is one of those cards with its price, close and
 * volume scaled by a seeded factor, so the field is varied but every opening
 * is of a shape the engine already reads.
 */
import type { ModelInput, ModelledOpportunity } from '../../server/services/cash/goalScenario.ts';
import { GOAL_10K_OPENINGS } from './goal10k.ts';

const scaled = (input: ModelInput, k: number, cap = Infinity): ModelInput => {
  const f = (x: number | null) => (x === null ? null : Math.min(cap, x * k));
  return { ...input, value: f(input.value), low: f(input.low), high: f(input.high) };
};

export function manyOpenings(n: number, seed = 1): ModelledOpportunity[] {
  const cards = GOAL_10K_OPENINGS.filter((o) => o.repeatable && o.agreedValue === 0);
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const out: ModelledOpportunity[] = [];
  for (let i = 0; i < n; i++) {
    const card = cards[i % cards.length]!;
    const price = 0.3 + 1.2 * rnd();
    const close = 0.4 + 1.2 * rnd();
    const volume = 0.3 + 1.5 * rnd();
    out.push({
      ...card,
      opportunity: { ...card.opportunity, id: `gen_${i}`, title: `${card.opportunity.title} (variant ${i})` } as ModelledOpportunity['opportunity'],
      index: i + 1,
      price: scaled(card.price, price),
      directCost: scaled(card.directCost, price),
      close: scaled(card.close, close, 1),
      volume: scaled(card.volume, volume),
    });
  }
  return out;
}

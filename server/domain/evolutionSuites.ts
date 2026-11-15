/**
 * The registered benchmark suites (§111). A declaration only: the runners live under
 * `bench/` (`npm run bench`), owned by the evaluator, and score by code, offline and
 * deterministically. A suite is added by declaring it here — name, primary metric,
 * direction, target, noise bound and guards — and nothing else in Brain names one.
 */
import type { BenchSuite } from './evolution.ts';

export const EVOLUTION_SUITES: readonly BenchSuite[] = [
  {
    name: 'feasibility',
    capabilityClass: 'REASONING',
    description:
      'Plans and pathways must not treat a hypothetical answer to a constraint as available (unfunded deals, ' +
      'unevidenced prepayment, unestablished capabilities, unknown conditions). Share of cases judged correctly.',
    primaryMetric: 'accuracy',
    direction: 'HIGHER',
    target: 0.95,
    noise: { absolute: 0.02 },
    guards: [],
  },
  {
    name: 'planSpeed',
    capabilityClass: 'ALGORITHM',
    description:
      'Wall time of the full plan reconstruction on frozen production plan inputs, with the reach of the plan ' +
      'held within tolerance of the baseline.',
    primaryMetric: 'p50ms',
    direction: 'LOWER',
    target: { baselineFactor: 0.6 },
    noise: { relative: 0.05 },
    guards: [{ metric: 'reachDelta', direction: 'HIGHER', tolerance: 0.01 }],
  },
];

export function findSuite(name: string): BenchSuite | null {
  return EVOLUTION_SUITES.find((s) => s.name === name) ?? null;
}

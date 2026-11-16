/**
 * The registered benchmark suites (§111). A declaration only: the runners live under
 * `bench/` (`npm run bench`), owned by the evaluator, and score by code, offline and
 * deterministically. A suite is added by declaring it here — name, primary metric,
 * direction, target, noise bound, guards and what it measures — and nothing else in Brain
 * names one.
 *
 * `measures` is what makes an experiment's measurement fit its deficiency: a commission
 * whose suite does not measure the deficiency is refused, naming the suites that do, and an
 * undecided experiment judged on an unfit suite is moved onto the one that fits
 * (`services/evolution/experiments.ts`). Two kinds of suite exist:
 *
 *   judgement  cases are inputs to one pure judgement of the code under test (`feasibility`,
 *              `planSpeed`)
 *   scenario   cases are behavioural scripts the harness runs against the code under test's
 *              own repositories and loop, on a database of its own, reading the end state from
 *              the rows (`mootRequests`)
 *
 * Both are harness code under `bench/`, which the evaluator copies over every tree it scores,
 * so a variant cannot change the cases it is judged on; hidden cases of either kind live only
 * in Brain's database.
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
    measures: { deficiencies: ['ECONOMIC_REASONING', 'PLANNING_ASSUMPTION', 'REPEATED_STRATEGIC_MISTAKE', 'CAPABILITY_BELOW_TARGET'], paths: [] },
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
    measures: { deficiencies: ['INEFFICIENT_ALGORITHM', 'CAPABILITY_BELOW_TARGET'], paths: [] },
  },
  {
    name: 'mootRequests',
    capabilityClass: 'OPERATIONS',
    description:
      'Scenarios driven through the real Russell loop and repositories: a mission leaves NEEDS_HUMAN around a ' +
      "person's answer (before the resume, while it waits for a slot, while the card is open, after a re-ask). " +
      'Share of scenarios whose every person-request ends as required — a moot card withdrawn, a live one kept ' +
      'in front of the person, an applicable answer carried out.',
    primaryMetric: 'accuracy',
    direction: 'HIGHER',
    target: 1,
    noise: { absolute: 0.01 },
    guards: [
      { metric: 'falseWithdraw', direction: 'LOWER', tolerance: 0 },
      { metric: 'historyLost', direction: 'LOWER', tolerance: 0 },
    ],
    measures: {
      deficiencies: ['RECURRING_OPERATIONAL_FAILURE', 'CAPABILITY_BELOW_TARGET'],
      paths: ['server/services/russell/', 'server/repos/russellMissions.ts', 'server/domain/operator.ts'],
    },
  },
];

export function findSuite(name: string): BenchSuite | null {
  return EVOLUTION_SUITES.find((s) => s.name === name) ?? null;
}

/** The literal directory or file a path or glob names (`server/x/**` → `server/x/`). */
function stem(path: string): string {
  const at = path.search(/[*?[{]/);
  return (at === -1 ? path : path.slice(0, at)).replace(/^\.\//, '');
}

/** Two repository paths overlap when either one lies under the other. */
function overlaps(a: string, b: string): boolean {
  const x = stem(a);
  const y = stem(b);
  if (!x || !y) return false;
  return x.startsWith(y) || y.startsWith(x);
}

export type SuiteFit = { fits: true; why: string } | { fits: false; why: string };

/** Does this suite measure this deficiency, on the code its owner paths name? */
export function suiteFit(suite: BenchSuite, deficiency: string, ownerPaths: readonly string[]): SuiteFit {
  const measured = `${suite.name} measures ${suite.measures.deficiencies.join(', ')}${suite.measures.paths.length ? ` on ${suite.measures.paths.join(', ')}` : ''}`;
  if (!suite.measures.deficiencies.includes(deficiency)) return { fits: false, why: `${measured} — not ${deficiency}` };
  // A capability deficiency is a suite missing its own target: the suite it names is its measurement.
  if (!suite.measures.paths.length || deficiency === 'CAPABILITY_BELOW_TARGET') return { fits: true, why: measured };
  if (!ownerPaths.length) return { fits: false, why: `${measured}, and the diagnosis names no owner path to place it there` };
  const hit = ownerPaths.find((p) => suite.measures.paths.some((s) => overlaps(p, s)));
  return hit ? { fits: true, why: `${measured} (${hit})` } : { fits: false, why: `${measured} — not ${ownerPaths.slice(0, 4).join(', ')}` };
}

/**
 * The suites that measure this deficiency, the most specific first: a suite whose declared paths
 * reach the owner paths measures that code, ahead of one that matches the class alone.
 */
export function suitesFitting(deficiency: string, ownerPaths: readonly string[]): BenchSuite[] {
  return EVOLUTION_SUITES.filter((s) => suiteFit(s, deficiency, ownerPaths).fits).sort((a, b) => b.measures.paths.length - a.measures.paths.length);
}

/** Hermes's next step when no registered suite measures a deficiency: no experiment, one objective. */
export function noSuiteMeasures(deficiency: string, ownerPaths: readonly string[]): string {
  return (
    `no registered suite measures ${deficiency}${ownerPaths.length ? ` on ${ownerPaths.slice(0, 4).join(', ')}` : ''} ` +
    `(${EVOLUTION_SUITES.map((s) => `${s.name}: ${s.measures.deficiencies.join('/')}${s.measures.paths.length ? ` on ${s.measures.paths.join(', ')}` : ''}`).join('; ')}). ` +
    'An experiment scored on a suite that cannot see the defect selects on nothing: commission it without approaches and suite ' +
    "(one objective, measured after release by the improvement loop), or a suite that measures it is declared first (bench/<name>/ and server/domain/evolutionSuites.ts)."
  );
}

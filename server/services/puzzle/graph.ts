/**
 * Everything the puzzle kernel knows, read once per pass.
 *
 * ---------------------------------------------------------------------------
 * One read, then a pure decision over it
 * ---------------------------------------------------------------------------
 *
 * `services/dispatch/candidates.ts`, `services/industry/graph.ts` and
 * `services/dealflow/graph.ts` all draw this line for the same reason: the
 * allocator has to be a pure function over a recorded input, so *why did Brain
 * research that* is answerable afterwards from a snapshot rather than from a
 * re-run against a database that has since moved.
 *
 * Being pure also makes the allocator useless as a safety mechanism, which is
 * correct — the exclusion is the unique index on `puzzle_rounds`, and two
 * ticks both deciding correctly produce one round with an ordinary loser.
 */
import {
  listPuzzleConstraints,
  listPuzzleDemand,
  listPuzzleEconomics,
  listPuzzleFormats,
  listPuzzleInstances,
  listPuzzleMasters,
  listPuzzleObservations,
  listPuzzleProducts,
  listPuzzleRounds,
  listPuzzleRoutes,
  productMembership,
} from '../../repos/puzzle.ts';
import { formatFor } from './formats/index.ts';
import { qualify, type Qualification } from './products.ts';
import type {
  PuzzleConstraint,
  PuzzleDemand,
  PuzzleEconomic,
  PuzzleFormatEntry,
  PuzzleInstance,
  PuzzleMaster,
  PuzzleObservation,
  PuzzleProduct,
  PuzzleRound,
  PuzzleRoute,
} from '../../domain/types.ts';

/** One format, with everything the kernel holds about it gathered. */
export interface FormatView {
  key: string;
  /** As the sources write it. The first spelling seen wins, and it is shown. */
  name: string;
  entry: PuzzleFormatEntry;
  /** Whether this repository can generate it, check it, or neither. */
  generates: boolean;
  validates: boolean;
  masters: PuzzleMaster[];
  validInstances: PuzzleInstance[];
  products: PuzzleProduct[];
  demand: PuzzleDemand[];
  channels: PuzzleRoute[];
  production: PuzzleRoute[];
  economics: PuzzleEconomic[];
  rounds: PuzzleRound[];
  liveRounds: number;
}

export interface PuzzleSnapshot {
  projectId: string;
  formats: FormatView[];
  masters: PuzzleMaster[];
  instances: PuzzleInstance[];
  products: PuzzleProduct[];
  membership: Map<string, string[]>;
  qualifications: Qualification[];
  demand: PuzzleDemand[];
  routes: PuzzleRoute[];
  economics: PuzzleEconomic[];
  constraints: PuzzleConstraint[];
  rounds: PuzzleRound[];
  observations: PuzzleObservation[];
  /** Live rounds across the whole kernel, which is what the concurrency bound counts. */
  openRounds: number;
  takenAt: string;
}

export async function puzzleSnapshot(projectId: string): Promise<PuzzleSnapshot> {
  const [
    formats,
    masters,
    instances,
    products,
    membership,
    demand,
    routes,
    economics,
    constraints,
    rounds,
    observations,
  ] = await Promise.all([
    listPuzzleFormats(projectId),
    listPuzzleMasters(projectId),
    listPuzzleInstances({ projectId }),
    listPuzzleProducts(projectId),
    productMembership(projectId),
    listPuzzleDemand(projectId),
    listPuzzleRoutes(projectId),
    listPuzzleEconomics(projectId),
    listPuzzleConstraints(projectId),
    listPuzzleRounds(projectId),
    listPuzzleObservations(projectId),
  ]);

  const qualifications = qualify({ products, membership });

  const views: FormatView[] = formats
    .filter((one) => one.retiredAt === null)
    .map((entry) => {
      const key = entry.formatKey;
      const implementation = formatFor(key);
      const mine = masters.filter((one) => one.formatKey === key);
      const masterIds = new Set(mine.map((one) => one.id));
      const roundsHere = rounds.filter((one) => one.formatKey === key);
      return {
        key,
        name: entry.name,
        entry,
        generates: implementation?.render != null,
        validates: implementation != null,
        masters: mine,
        validInstances: instances.filter(
          (one) => masterIds.has(one.masterId) && one.validationState === 'VALID',
        ),
        products: products.filter(
          (one) => masterIds.has(one.masterId) && one.retiredAt === null,
        ),
        demand: demand.filter((one) => one.formatKey === key),
        channels: routes.filter((one) => one.formatKey === key && one.kind === 'CHANNEL'),
        production: routes.filter((one) => one.formatKey === key && one.kind === 'PRODUCTION'),
        economics: economics.filter((one) => one.formatKey === key),
        rounds: roundsHere,
        liveRounds: roundsHere.filter((one) => one.state === 'OPEN').length,
      };
    });

  return {
    projectId,
    formats: views,
    masters,
    instances,
    products,
    membership,
    qualifications,
    demand,
    routes,
    economics,
    constraints,
    rounds,
    observations,
    openRounds: rounds.filter((one) => one.state === 'OPEN').length,
    takenAt: new Date().toISOString(),
  };
}

export function formatIn(snapshot: PuzzleSnapshot, key: string): FormatView | null {
  return snapshot.formats.find((one) => one.key === key) ?? null;
}

/**
 * The puzzle kernel over HTTP.
 *
 * Thin by design, for the reason `cashApi.ts` states about the section it
 * lives inside: every decision is the server's, and this file's whole job is
 * to name the six existing routes and the shapes they already return. Nothing
 * here derives a figure, composes a sentence, or decides what state a format,
 * a system or a puzzle is in — a client that did any of those would be a
 * second opinion about one kernel, which is the defect §29 records.
 *
 * Every response and request shape below is imported type-only from the
 * server that already defines it, never restated: a client holding its own
 * copy of a contract is a second contract, and the copy is the one that
 * drifts.
 */
import { api } from './api.ts';
import type { PuzzleView } from '../../../server/services/puzzle/view.ts';
import type { PuzzleArtifact } from '../../../server/services/puzzle/formats/engine.ts';
import type {
  PuzzleDifficulty,
  PuzzleFormatEntry,
  PuzzleInstance,
  PuzzleMaster,
  PuzzleObservation,
  PuzzleObservationKind,
} from '../../../server/domain/types.ts';

export type {
  PuzzleView,
  PuzzleArtifact,
  PuzzleFormatEntry,
  PuzzleInstance,
  PuzzleMaster,
  PuzzleObservation,
};

const p = (value: string): string => encodeURIComponent(value);

/** What GET .../cash/puzzles/instances/:instanceId answers. */
export interface PuzzleInstanceReading {
  instance: PuzzleInstance;
  /** Null when the specification could not be re-rendered at all. */
  artifact: PuzzleArtifact | null;
  /** Whether the re-render hashes to what was recorded when it was validated. */
  reproduced: boolean;
  message: string;
}

/** What POST .../cash/puzzles/formats answers. */
export interface SeededPuzzleFormat {
  format: PuzzleFormatEntry;
  created: boolean;
  /** Whether this repository can actually generate one. */
  generates: boolean;
  /** Whether this repository can at least check one somebody else wrote. */
  validates: boolean;
  message: string;
}

/** What PATCH .../cash/puzzles/formats/:formatId answers. */
export interface RetiredPuzzleFormat {
  format: PuzzleFormatEntry;
  message: string;
}

/** What POST .../cash/puzzles/systems answers. */
export interface DefinedPuzzleSystem {
  master: PuzzleMaster;
  message: string;
}

/** What POST .../cash/puzzles/observations answers. */
export interface RecordedPuzzleObservation {
  observation: PuzzleObservation;
  message: string;
}

/**
 * Everything the operator surface shows: right now, the top five, the whole
 * ledger, what is being made, leverage, quality, economics, the dollar-book
 * reading, physical production, maturity, lessons, recent observations, what
 * needs a person, the next action and what this repository can and cannot
 * do.
 *
 * Reading it creates nothing.
 */
export const getPuzzleView = (projectId: string): Promise<PuzzleView> =>
  api(`/api/projects/${p(projectId)}/cash/puzzles`);

/**
 * Re-render one puzzle from its own specification, and say whether it still
 * hashes to what was recorded when it was validated. There is no grid stored
 * anywhere for this to read back — it is rendered fresh every time, which is
 * the whole of "the specification is the storage".
 */
export const getPuzzleInstance = (
  projectId: string,
  instanceId: string,
): Promise<PuzzleInstanceReading> =>
  api(`/api/projects/${p(projectId)}/cash/puzzles/instances/${p(instanceId)}`);

/**
 * Name a format. Seeding spends nothing and starts nothing — it creates a
 * row, and the allocator, the discovery grant and the evidence gate decide
 * everything that happens to it afterwards.
 */
export const seedPuzzleFormat = (
  projectId: string,
  body: { name: string; note?: string },
): Promise<SeededPuzzleFormat> =>
  api(`/api/projects/${p(projectId)}/cash/puzzles/formats`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

/**
 * Stop asking about a format. Never a delete: its masters, its puzzles and
 * every product compiled from them keep their rows, which is what stops it
 * arriving again as a fresh discovery.
 */
export const retirePuzzleFormat = (
  projectId: string,
  formatId: string,
  body: { reason: string },
): Promise<RetiredPuzzleFormat> =>
  api(`/api/projects/${p(projectId)}/cash/puzzles/formats/${p(formatId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

/**
 * Set up a system: one format, one corpus, one difficulty band, and whatever
 * parameters that format's own generator accepts. Puzzles are made from it on
 * the tick, each checked from its printed form before it is recorded.
 *
 * Typed even though no control calls it yet — the route already exists and
 * already refuses everything a system must not be defined against.
 */
export const definePuzzleSystem = (
  projectId: string,
  body: {
    title: string;
    format: string;
    corpusId: string;
    difficulty?: PuzzleDifficulty;
    parameters?: Record<string, string | number>;
  },
): Promise<DefinedPuzzleSystem> =>
  api(`/api/projects/${p(projectId)}/cash/puzzles/systems`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

/**
 * Record what actually happened: a submission's fate, a sale or its absence,
 * a defect, a playtest, or the one reading that can move a format to
 * SELLABLE — that a person read what the machine made and it passed.
 *
 * Whether several of these amount to a rule is derived when somebody reads
 * them; nothing here gates a product or skips a question.
 */
export const recordPuzzleObservation = (
  projectId: string,
  body: {
    kind: PuzzleObservationKind;
    statement: string;
    format?: string;
    productId?: string;
    route?: string;
  },
): Promise<RecordedPuzzleObservation> =>
  api(`/api/projects/${p(projectId)}/cash/puzzles/observations`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

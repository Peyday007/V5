/**
 * The world's theme registry (UI-27-2; S-0408 – S-0418).
 *
 * "Provide a typed, versioned adapter between real entities … and
 * presentation objects (characters, districts, buildings, queues, signals and
 * scenes). One real fact can have many themed representations; the data
 * meaning remains invariant." "The initial dragon mapping is an art direction,
 * not a fixed architecture." "Themes must not force unfamiliar, new or
 * cross-cutting Brain capabilities into the wrong district."
 *
 * A theme is data: a table from an entity kind to zero or more presentation
 * objects, plus cosmetic per-state art. It has no say over meaning. `present`
 * copies the fact's state, record id and link through untouched, and whether
 * a thing may animate as busy is decided by the state (only a live-lease
 * WORKING), never by the theme. A kind the theme does not name gets the
 * theme's neutral representation — which may be nothing — rather than being
 * guessed into a district.
 *
 * Adding a theme, a kind or an object is a new data entry passed to
 * `registerTheme`; no code here branches on a theme id or a kind.
 */
import type { WorldFact, WorldState } from '../../../server/routes/world.ts';
import { displayState } from './truth.ts';

export const THEME_REGISTRY_VERSION = 1 as const;

/** The world contract version these themes were written against. */
export const THEME_WORLD_CONTRACT = 1 as const;

export type PresentationKind = 'district' | 'building' | 'character' | 'queue' | 'signal' | 'scene';

export interface PresentationObject {
  kind: PresentationKind;
  /** Stable within a theme; a renderer keys its sprites and positions on it. */
  key: string;
  label: string;
}

export interface StateArt {
  /** A glyph or short word shown beside the state label; never the only signal. */
  glyph: string;
}

export interface ThemeDefinition {
  id: string;
  version: number;
  name: string;
  worldContract: typeof THEME_WORLD_CONTRACT;
  /** Entity kind → the objects that represent it. An empty list means "draw nothing". */
  byKind: Readonly<Record<string, readonly PresentationObject[]>>;
  /** What a kind the theme does not name becomes. May be empty. */
  neutral: readonly PresentationObject[];
  /** Cosmetic art per state. Every state must have an entry. */
  stateArt: Readonly<Record<WorldState, StateArt>>;
}

export interface ThemeRegistry {
  version: typeof THEME_REGISTRY_VERSION;
  themes: readonly ThemeDefinition[];
}

const ALL_STATES: readonly WorldState[] = ['WORKING', 'WAITING', 'BLOCKED', 'NEEDS_APPROVAL', 'SUCCEEDED', 'FAILED', 'IDLE', 'UNKNOWN'];

/** Refuses a theme that is not complete, so a renderer never meets a hole. */
export function validateTheme(theme: ThemeDefinition): string[] {
  const problems: string[] = [];
  if (!theme.id) problems.push('theme id is empty');
  if (!Number.isInteger(theme.version) || theme.version < 1) problems.push(`${theme.id}: version must be a positive integer`);
  if (theme.worldContract !== THEME_WORLD_CONTRACT) problems.push(`${theme.id}: written for world contract ${String(theme.worldContract)}`);
  for (const state of ALL_STATES) if (!theme.stateArt[state]) problems.push(`${theme.id}: no art for state ${state}`);
  for (const [kind, objects] of Object.entries(theme.byKind)) {
    const keys = new Set<string>();
    for (const o of objects) {
      if (keys.has(o.key)) problems.push(`${theme.id}: ${kind} repeats object ${o.key}`);
      keys.add(o.key);
    }
  }
  return problems;
}

export function createThemeRegistry(themes: readonly ThemeDefinition[] = []): ThemeRegistry {
  return themes.reduce<ThemeRegistry>((reg, t) => registerTheme(reg, t), { version: THEME_REGISTRY_VERSION, themes: [] });
}

/** Adds a theme (or a newer version of one). Returns a new registry; the old one is untouched. */
export function registerTheme(registry: ThemeRegistry, theme: ThemeDefinition): ThemeRegistry {
  const problems = validateTheme(theme);
  if (problems.length > 0) throw new Error(`Theme refused: ${problems.join('; ')}`);
  if (registry.themes.some((t) => t.id === theme.id && t.version === theme.version)) {
    throw new Error(`Theme refused: ${theme.id} v${theme.version} is already registered`);
  }
  return { version: registry.version, themes: [...registry.themes, theme] };
}

/** The newest version of a theme, or null. */
export function getTheme(registry: ThemeRegistry, id: string, version?: number): ThemeDefinition | null {
  const matching = registry.themes.filter((t) => t.id === id && (version === undefined || t.version === version));
  if (matching.length === 0) return null;
  return matching.reduce((a, b) => (b.version > a.version ? b : a));
}

export interface PresentedFact {
  themeId: string;
  themeVersion: number;
  /** The meaning, copied from the fact unchanged. */
  recordId: string;
  entityKind: string;
  href: string | null;
  state: WorldState;
  stateLabel: string;
  /** Only WORKING may animate as busy, whatever the theme. */
  animate: boolean;
  glyph: string;
  objects: readonly PresentationObject[];
  /** True when the kind was not in the theme and the neutral representation was used. */
  neutral: boolean;
}

/** One fact in one theme. The theme picks the objects; the fact keeps its meaning. */
export function present(
  fact: Pick<WorldFact, 'recordId' | 'href'> & { kind: WorldFact['kind'] | (string & {}); state: WorldFact['state'] | (string & {}) },
  theme: ThemeDefinition,
): PresentedFact {
  const state = displayState(fact.state);
  const own = Object.prototype.hasOwnProperty.call(theme.byKind, fact.kind) ? theme.byKind[fact.kind] : undefined;
  return {
    themeId: theme.id,
    themeVersion: theme.version,
    recordId: fact.recordId,
    entityKind: fact.kind,
    href: fact.href,
    state: state.state,
    stateLabel: state.label,
    animate: state.active,
    glyph: theme.stateArt[state.state].glyph,
    objects: own ?? theme.neutral,
    neutral: own === undefined,
  };
}

// ---------------------------------------------------------------------------
// Built-in themes: data, not code.
// ---------------------------------------------------------------------------

const d = (key: string, label: string): PresentationObject => ({ kind: 'district', key, label });
const b = (key: string, label: string): PresentationObject => ({ kind: 'building', key, label });
const c = (key: string, label: string): PresentationObject => ({ kind: 'character', key, label });
const q = (key: string, label: string): PresentationObject => ({ kind: 'queue', key, label });
const s = (key: string, label: string): PresentationObject => ({ kind: 'signal', key, label });

/** The initial dragon art direction (S-0409 – S-0415). An art direction, not an architecture. */
export const DRAGON_THEME: ThemeDefinition = {
  id: 'dragon',
  version: 1,
  name: 'Dragon citadel',
  worldContract: THEME_WORLD_CONTRACT,
  byKind: {
    GOAL: [d('citadel', 'Citadel'), b('citadel-throne', "Dragon's throne")],
    PERMISSION: [d('citadel', 'Citadel'), s('citadel-seal', 'Seal of the gate')],
    RESEARCH_JOB: [d('library', 'Arcane library'), b('observatory', 'Observatory')],
    CAMPAIGN: [d('forge', 'Enchanted forge'), b('smithy', 'Smithy')],
    OPPORTUNITY: [d('market', 'Merchant quarter'), b('stall', 'Market stall')],
    INVOICE: [d('treasury', 'Treasury'), b('ledger-vault', 'Ledger vault')],
    WORK_UNIT: [d('roads', 'Roads'), q('caravan', 'Caravan')],
    BIN: [d('roads', 'Roads'), q('courier', 'Courier pouch')],
    WORKER: [c('courier', 'Courier'), d('roads', 'Roads')],
    SCENARIO: [d('laboratory', 'Laboratory'), b('alembic', 'Alembic')],
    INFRASTRUCTURE: [b('citadel-foundations', 'Citadel foundations')],
  },
  neutral: [s('wayside-marker', 'Unplaced record')],
  stateArt: {
    WORKING: { glyph: '⚒' },
    WAITING: { glyph: '⏳' },
    BLOCKED: { glyph: '⛔' },
    NEEDS_APPROVAL: { glyph: '✋' },
    SUCCEEDED: { glyph: '✔' },
    FAILED: { glyph: '✖' },
    IDLE: { glyph: '·' },
    UNKNOWN: { glyph: '?' },
  },
};

/** A plain theme: the same facts as labelled panels, for the numbers-first view. */
export const PLAIN_THEME: ThemeDefinition = {
  id: 'plain',
  version: 1,
  name: 'Plain',
  worldContract: THEME_WORLD_CONTRACT,
  byKind: {
    GOAL: [d('goals', 'Goals')],
    PERMISSION: [d('access', 'Access')],
    RESEARCH_JOB: [d('research', 'Research')],
    CAMPAIGN: [d('engineering', 'Engineering')],
    OPPORTUNITY: [d('commercial', 'Commercial')],
    INVOICE: [d('money', 'Money')],
    WORK_UNIT: [q('queue', 'Work queue')],
    BIN: [q('queue', 'Work queue')],
    WORKER: [c('worker', 'Worker')],
    SCENARIO: [d('models', 'Models')],
    INFRASTRUCTURE: [d('infrastructure', 'Infrastructure')],
  },
  neutral: [d('other', 'Other')],
  stateArt: {
    WORKING: { glyph: 'working' },
    WAITING: { glyph: 'waiting' },
    BLOCKED: { glyph: 'blocked' },
    NEEDS_APPROVAL: { glyph: 'approval' },
    SUCCEEDED: { glyph: 'done' },
    FAILED: { glyph: 'failed' },
    IDLE: { glyph: 'idle' },
    UNKNOWN: { glyph: 'unknown' },
  },
};

export const DEFAULT_THEME_REGISTRY: ThemeRegistry = createThemeRegistry([DRAGON_THEME, PLAIN_THEME]);

/**
 * One context across Brain's three lenses (UI-27-3, S-0419 – S-0422).
 *
 * "These are interface lenses, not separate products or data stores. Allow
 * fluid movement between them. A selected entity, timeframe, goal and active
 * context should remain coherent across modes. The existing
 * conversation/mouthpiece should be accessible from all modes, grounded in the
 * selected real object, and use the existing permission-aware action route."
 *
 * So there is exactly one state here — the mode is a field of it, not a page
 * — and the only thing a mode switch changes is that field. The URL is the
 * same state written down, so a deep link restores the context a person was
 * looking at. Grounding for the conversation is read from the world contract's
 * own facts (`GET /api/world`, `server/routes/world.ts`); it never invents a
 * record, a state or an address, and the turn it accompanies is still sent to
 * the existing Russell conversation route, which authorizes it as before.
 *
 * Pure functions only, so every rule is testable without a browser.
 */
import type { WorldEntityKind, WorldFact, WorldState } from '../../../server/routes/world.ts';

/** Bumped whenever a field's meaning or a URL parameter changes. */
export const LENS_STATE_VERSION = 1 as const;

export const LENS_MODES = ['WORLD', 'OPERATIONS', 'GOAL'] as const;
export type LensMode = (typeof LENS_MODES)[number];

/**
 * The kinds the world contract serves. Kept as a client-side list (a value
 * import would pull the server route into the bundle); `satisfies` makes the
 * compiler refuse a kind the contract does not define.
 */
const SELECTABLE_KINDS = [
  'GOAL',
  'WORK_UNIT',
  'BIN',
  'WORKER',
  'RESEARCH_JOB',
  'CAMPAIGN',
  'OPPORTUNITY',
  'INVOICE',
  'PERMISSION',
  'INFRASTRUCTURE',
] as const satisfies readonly WorldEntityKind[];

/** Named windows, or an explicit ISO range. */
export const TIMEFRAME_PRESETS = ['24h', '7d', '30d', '90d', 'all'] as const;
export type TimeframePreset = (typeof TIMEFRAME_PRESETS)[number];
export type Timeframe = { preset: TimeframePreset } | { from: string; to: string };

export interface LensSelection {
  kind: WorldEntityKind;
  id: string;
}

export interface LensState {
  mode: LensMode;
  selected: LensSelection | null;
  timeframe: Timeframe;
  goalId: string | null;
  /** Free filters a lens may use (a district, a state word). Keys and values are kept verbatim. */
  filters: Record<string, string>;
}

export const DEFAULT_TIMEFRAME: Timeframe = { preset: '7d' };

export function initialLensState(): LensState {
  return { mode: 'WORLD', selected: null, timeframe: DEFAULT_TIMEFRAME, goalId: null, filters: {} };
}

export type LensAction =
  | { type: 'SET_MODE'; mode: LensMode }
  | { type: 'SELECT'; selection: LensSelection | null }
  | { type: 'SET_TIMEFRAME'; timeframe: Timeframe }
  | { type: 'SET_GOAL'; goalId: string | null }
  | { type: 'SET_FILTER'; key: string; value: string | null }
  | { type: 'CLEAR_FILTERS' };

/**
 * The single reducer. A mode switch touches only `mode`; everything else a
 * person chose stays exactly as it was. Selecting a goal record also makes it
 * the focused goal, so Goal mode opens on what was selected; focusing a
 * different goal does not clear an unrelated selection.
 */
export function lensReducer(state: LensState, action: LensAction): LensState {
  switch (action.type) {
    case 'SET_MODE':
      return state.mode === action.mode ? state : { ...state, mode: action.mode };
    case 'SELECT': {
      const selected = action.selection && isSelection(action.selection) ? { kind: action.selection.kind, id: action.selection.id } : null;
      const goalId = selected?.kind === 'GOAL' ? selected.id : state.goalId;
      return { ...state, selected, goalId };
    }
    case 'SET_TIMEFRAME':
      return isTimeframe(action.timeframe) ? { ...state, timeframe: action.timeframe } : state;
    case 'SET_GOAL':
      return { ...state, goalId: action.goalId && action.goalId.trim() !== '' ? action.goalId : null };
    case 'SET_FILTER': {
      const filters = { ...state.filters };
      if (action.value === null || action.value === '') delete filters[action.key];
      else filters[action.key] = action.value;
      return { ...state, filters };
    }
    case 'CLEAR_FILTERS':
      return { ...state, filters: {} };
  }
}

function isMode(value: unknown): value is LensMode {
  return typeof value === 'string' && (LENS_MODES as readonly string[]).includes(value);
}

function isKind(value: unknown): value is WorldEntityKind {
  return typeof value === 'string' && (SELECTABLE_KINDS as readonly string[]).includes(value);
}

function isSelection(value: LensSelection): boolean {
  return isKind(value.kind) && typeof value.id === 'string' && value.id.trim() !== '';
}

const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

function isTimeframe(value: Timeframe): boolean {
  if ('preset' in value) return (TIMEFRAME_PRESETS as readonly string[]).includes(value.preset);
  return ISO.test(value.from) && ISO.test(value.to) && Date.parse(value.from) <= Date.parse(value.to);
}

/* ------------------------------------------------------------------------- */
/* The URL is the same state written down                                     */
/* ------------------------------------------------------------------------- */

/** Filter parameters carry this prefix, so no filter can collide with a lens parameter. */
const FILTER_PREFIX = 'f.';

/**
 * The query string for a state. Defaults are left out so a link stays short;
 * parsing puts them back, so `parseLensQuery(lensQuery(s))` is `s`.
 */
export function lensQuery(state: LensState): string {
  const params = new URLSearchParams();
  params.set('lens', state.mode.toLowerCase());
  if (state.selected) params.set('sel', `${state.selected.kind}:${state.selected.id}`);
  if ('preset' in state.timeframe) {
    if (state.timeframe.preset !== (DEFAULT_TIMEFRAME as { preset: TimeframePreset }).preset) params.set('tf', state.timeframe.preset);
  } else {
    params.set('from', state.timeframe.from);
    params.set('to', state.timeframe.to);
  }
  if (state.goalId) params.set('goal', state.goalId);
  for (const key of Object.keys(state.filters).sort()) params.set(`${FILTER_PREFIX}${key}`, state.filters[key]!);
  return params.toString();
}

/**
 * The state a query string describes. A parameter it does not know is
 * ignored, and a known parameter with an unusable value falls back to its
 * default rather than to a guess.
 */
export function parseLensQuery(query: string): LensState {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const state = initialLensState();

  const mode = params.get('lens')?.toUpperCase();
  if (isMode(mode)) state.mode = mode;

  const sel = params.get('sel');
  if (sel) {
    const at = sel.indexOf(':');
    const kind = at > 0 ? sel.slice(0, at) : '';
    const id = at > 0 ? sel.slice(at + 1) : '';
    if (isKind(kind) && id.trim() !== '') state.selected = { kind, id };
  }

  const from = params.get('from');
  const to = params.get('to');
  const tf = params.get('tf');
  if (from && to && isTimeframe({ from, to })) state.timeframe = { from, to };
  else if (tf && (TIMEFRAME_PRESETS as readonly string[]).includes(tf)) state.timeframe = { preset: tf as TimeframePreset };

  const goal = params.get('goal');
  if (goal && goal.trim() !== '') state.goalId = goal;

  for (const [key, value] of params) {
    if (key.startsWith(FILTER_PREFIX) && key.length > FILTER_PREFIX.length && value !== '') state.filters[key.slice(FILTER_PREFIX.length)] = value;
  }
  return state;
}

/* ------------------------------------------------------------------------- */
/* Grounding the conversation in the selected real object                     */
/* ------------------------------------------------------------------------- */

/** The existing conversation route a grounded turn is sent to; it authorizes the turn as before. */
export const CONVERSATION_TURN_ROUTE = '/api/russell/conversations/:conversationId/turns';

export interface ConversationGrounding {
  version: typeof LENS_STATE_VERSION;
  kind: WorldEntityKind;
  recordId: string;
  /** The record's own API address from the world contract, or null when it served none or the record was not found. */
  href: string | null;
  title: string | null;
  /** The world contract's state word; UNKNOWN when the record is not among the facts read. */
  state: WorldState;
  recordState: string | null;
  blocker: string | null;
  nextAction: string | null;
  freshness: WorldFact['freshness'] | 'MISSING';
  /** False when the selection was not found among the facts: the conversation is told so rather than shown a guess. */
  found: boolean;
  mode: LensMode;
  goalId: string | null;
  timeframe: Timeframe;
  route: typeof CONVERSATION_TURN_ROUTE;
}

/**
 * What the conversation is told about the selected record, or null when
 * nothing is selected. Every field comes from the world contract's fact for
 * that record; a selection the facts do not contain is grounded as UNKNOWN
 * with no address, never as a state the lens assumed.
 */
export function conversationGrounding(state: LensState, facts: readonly WorldFact[]): ConversationGrounding | null {
  if (!state.selected) return null;
  const { kind, id } = state.selected;
  const fact = facts.find((f) => f.kind === kind && f.recordId === id);
  return {
    version: LENS_STATE_VERSION,
    kind,
    recordId: id,
    href: fact?.href ?? null,
    title: fact?.title ?? null,
    state: fact?.state ?? 'UNKNOWN',
    recordState: fact?.recordState ?? null,
    blocker: fact?.blocker ?? null,
    nextAction: fact?.nextAction ?? null,
    freshness: fact?.freshness ?? 'MISSING',
    found: fact !== undefined,
    mode: state.mode,
    goalId: state.goalId,
    timeframe: state.timeframe,
    route: CONVERSATION_TURN_ROUTE,
  };
}

/** The grounding as one plain line a turn can carry, or '' when nothing is selected. */
export function groundingPreface(grounding: ConversationGrounding | null): string {
  if (!grounding) return '';
  const parts = [
    `About ${grounding.kind} ${grounding.recordId}`,
    grounding.title ? `"${grounding.title}"` : null,
    `record ${grounding.href ?? '(no address)'}`,
    `state ${grounding.state}${grounding.recordState ? ` (${grounding.recordState})` : ''}`,
    grounding.found ? null : 'not found in the current world read',
    grounding.blocker ? `blocker: ${grounding.blocker}` : null,
  ];
  return `[${parts.filter((p): p is string => p !== null).join('; ')}]`;
}

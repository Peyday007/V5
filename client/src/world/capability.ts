/**
 * How the world may render on this device (UI-27-5, S-0429).
 *
 * "Provide graceful behavior when animations are disabled, WebGL is
 * unavailable, bandwidth is limited, or a user prefers reduced motion …
 * a clear numbers-first fallback … Avoid running heavyweight continuous
 * animation that starves Brain's actual research or backend execution."
 *
 * Every mode carries the same facts; a mode decides only how they are drawn.
 * The functions here are pure so the decision is testable without a browser;
 * `readCapabilitySignals` is the one place that reads the browser.
 */

export type WorldRenderMode = 'ANIMATED' | 'STATIC' | 'NUMBERS_ONLY';

export type RenderModeOverride = WorldRenderMode | 'AUTO';

/** The narrowest viewport the spatial world is drawn at; below it, numbers first. */
export const NARROW_VIEWPORT_PX = 640;

export interface CapabilitySignals {
  prefersReducedMotion: boolean;
  /** null when it was not possible to tell. */
  webglAvailable: boolean | null;
  /** The Save-Data client hint. */
  saveData: boolean;
  /** navigator.connection.effectiveType, when the browser reports it. */
  effectiveConnectionType: string | null;
  viewportWidth: number;
  override: RenderModeOverride;
}

export type RenderModeReason =
  | 'USER_OVERRIDE'
  | 'REDUCED_MOTION'
  | 'NO_WEBGL'
  | 'WEBGL_UNKNOWN'
  | 'SAVE_DATA'
  | 'SLOW_CONNECTION'
  | 'NARROW_VIEWPORT'
  | 'FULL_CAPABILITY';

export interface RenderModeDecision {
  mode: WorldRenderMode;
  reasons: RenderModeReason[];
  /** Ambient motion may run at all in this mode. */
  animate: boolean;
  /** The spatial scene is drawn (static or animated). */
  drawScene: boolean;
  /** Always true: no mode hides a fact the others show. */
  factsAvailable: true;
}

const SLOW_CONNECTIONS = new Set(['slow-2g', '2g', '3g']);

function decision(mode: WorldRenderMode, reasons: RenderModeReason[]): RenderModeDecision {
  return {
    mode,
    reasons,
    animate: mode === 'ANIMATED',
    drawScene: mode !== 'NUMBERS_ONLY',
    factsAvailable: true,
  };
}

/**
 * Decide the render mode. A user override always wins; otherwise the most
 * restrictive signal decides, and every signal that pushed the mode down is
 * named so the page can say why the world is still.
 */
export function decideRenderMode(signals: CapabilitySignals): RenderModeDecision {
  if (signals.override !== 'AUTO') return decision(signals.override, ['USER_OVERRIDE']);

  const numbersOnly: RenderModeReason[] = [];
  if (signals.viewportWidth > 0 && signals.viewportWidth < NARROW_VIEWPORT_PX) numbersOnly.push('NARROW_VIEWPORT');
  if (signals.saveData) numbersOnly.push('SAVE_DATA');
  if (signals.effectiveConnectionType !== null && SLOW_CONNECTIONS.has(signals.effectiveConnectionType)) {
    numbersOnly.push('SLOW_CONNECTION');
  }

  const still: RenderModeReason[] = [];
  if (signals.prefersReducedMotion) still.push('REDUCED_MOTION');
  if (signals.webglAvailable === false) still.push('NO_WEBGL');
  if (signals.webglAvailable === null) still.push('WEBGL_UNKNOWN');

  if (numbersOnly.length > 0) return decision('NUMBERS_ONLY', [...numbersOnly, ...still]);
  if (still.length > 0) return decision('STATIC', still);
  return decision('ANIMATED', ['FULL_CAPABILITY']);
}

/* ------------------------------------------------------------------ */
/* Frame budget: ambient animation never competes with real work.      */
/* ------------------------------------------------------------------ */

export interface FrameBudget {
  /** Frames per second ambient animation may use when it runs at all. */
  maxFps: number;
  /** Milliseconds of script per frame ambient animation may spend. */
  maxFrameMs: number;
}

export const AMBIENT_FRAME_BUDGET: FrameBudget = { maxFps: 30, maxFrameMs: 4 };

export interface AmbientState {
  mode: WorldRenderMode;
  documentHidden: boolean;
  /** Script time the last ambient frame took, in milliseconds. */
  lastFrameMs: number | null;
}

export type AmbientPauseReason = 'MODE_NOT_ANIMATED' | 'DOCUMENT_HIDDEN' | 'OVER_BUDGET';

export interface AmbientDecision {
  run: boolean;
  pausedBecause: AmbientPauseReason | null;
  /** Minimum milliseconds between ambient frames while running. */
  frameIntervalMs: number;
}

/**
 * Whether ambient animation may run this frame. It pauses when the mode is
 * not animated, when the tab is hidden, and when the last frame overran its
 * budget, so the world never starves the page or the machine it runs on.
 */
export function ambientAnimation(state: AmbientState, budget: FrameBudget = AMBIENT_FRAME_BUDGET): AmbientDecision {
  const frameIntervalMs = Math.ceil(1000 / budget.maxFps);
  if (state.mode !== 'ANIMATED') return { run: false, pausedBecause: 'MODE_NOT_ANIMATED', frameIntervalMs };
  if (state.documentHidden) return { run: false, pausedBecause: 'DOCUMENT_HIDDEN', frameIntervalMs };
  if (state.lastFrameMs !== null && state.lastFrameMs > budget.maxFrameMs) {
    return { run: false, pausedBecause: 'OVER_BUDGET', frameIntervalMs };
  }
  return { run: true, pausedBecause: null, frameIntervalMs };
}

/* ------------------------------------------------------------------ */
/* Browser reads. Every access is guarded: a missing API is "unknown". */
/* ------------------------------------------------------------------ */

interface ConnectionLike {
  saveData?: boolean;
  effectiveType?: string;
}

function detectWebGL(): boolean | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

export function readCapabilitySignals(override: RenderModeOverride = 'AUTO'): CapabilitySignals {
  const hasWindow = typeof window !== 'undefined';
  const connection: ConnectionLike | undefined =
    typeof navigator !== 'undefined' ? (navigator as Navigator & { connection?: ConnectionLike }).connection : undefined;
  let prefersReducedMotion = false;
  if (hasWindow && typeof window.matchMedia === 'function') {
    prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return {
    prefersReducedMotion,
    webglAvailable: detectWebGL(),
    saveData: connection?.saveData === true,
    effectiveConnectionType: connection?.effectiveType ?? null,
    viewportWidth: hasWindow ? window.innerWidth : 0,
    override,
  };
}

/**
 * UI-27-5 (S-0427, S-0429): the world's renderer evaluation is recorded with a
 * decision, and the render mode degrades to a still or numbers-first world on
 * reduced motion, no WebGL, Save-Data, a slow link or a narrow viewport — with
 * the same facts available — and ambient animation pauses when the tab is
 * hidden or overruns its frame budget.
 */
import { describe, expect, it } from 'vitest';
import {
  AMBIENT_FRAME_BUDGET,
  NARROW_VIEWPORT_PX,
  ambientAnimation,
  decideRenderMode,
  type CapabilitySignals,
} from '../client/src/world/capability.ts';
import { RENDERER_DECISION, RENDERER_EVALUATIONS, evaluationOf } from '../client/src/world/renderers.ts';

const capable: CapabilitySignals = {
  prefersReducedMotion: false,
  webglAvailable: true,
  saveData: false,
  effectiveConnectionType: '4g',
  viewportWidth: 1280,
  override: 'AUTO',
};

describe('renderer evaluation', () => {
  it('lists at least four engines, each with a verdict and a reason', () => {
    expect(RENDERER_EVALUATIONS.length).toBeGreaterThanOrEqual(4);
    const ids = RENDERER_EVALUATIONS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const engine of RENDERER_EVALUATIONS) {
      expect(engine.reason.length).toBeGreaterThan(0);
      expect(engine.strengths.length).toBeGreaterThan(0);
      expect(engine.weaknesses.length).toBeGreaterThan(0);
    }
  });

  it('records one adopted engine that needs no rewrite or WebGL, and a WebGL path for later', () => {
    const adopted = RENDERER_EVALUATIONS.filter((e) => e.verdict === 'ADOPTED_NOW');
    expect(adopted.map((e) => e.id)).toEqual([RENDERER_DECISION.adopted]);
    const chosen = evaluationOf(RENDERER_DECISION.adopted);
    expect(chosen?.requiresFrameworkRewrite).toBe(false);
    expect(chosen?.requiresWebGL).toBe(false);
    expect(chosen?.accessibleByDefault).toBe(true);
    const later = evaluationOf(RENDERER_DECISION.upgradePath);
    expect(later?.verdict).toBe('LATER_IF_JUSTIFIED');
    expect(later?.requiresWebGL).toBe(true);
    expect(RENDERER_DECISION.reason.length).toBeGreaterThan(0);
    expect(RENDERER_DECISION.upgradeTrigger.length).toBeGreaterThan(0);
    expect(RENDERER_DECISION.evaluated).toBe(RENDERER_EVALUATIONS);
  });
});

describe('render mode', () => {
  it('animates only with full capability', () => {
    const d = decideRenderMode(capable);
    expect(d).toMatchObject({ mode: 'ANIMATED', animate: true, drawScene: true, factsAvailable: true });
    expect(d.reasons).toEqual(['FULL_CAPABILITY']);
  });

  it.each([
    ['reduced motion', { prefersReducedMotion: true }, 'STATIC', 'REDUCED_MOTION'],
    ['no WebGL', { webglAvailable: false }, 'STATIC', 'NO_WEBGL'],
    ['unknown WebGL', { webglAvailable: null }, 'STATIC', 'WEBGL_UNKNOWN'],
    ['Save-Data', { saveData: true }, 'NUMBERS_ONLY', 'SAVE_DATA'],
    ['slow connection', { effectiveConnectionType: '2g' }, 'NUMBERS_ONLY', 'SLOW_CONNECTION'],
    ['narrow viewport', { viewportWidth: NARROW_VIEWPORT_PX - 1 }, 'NUMBERS_ONLY', 'NARROW_VIEWPORT'],
  ] as const)('%s selects a non-animated mode with the same facts', (_label, patch, mode, reason) => {
    const d = decideRenderMode({ ...capable, ...patch });
    expect(d.mode).toBe(mode);
    expect(d.animate).toBe(false);
    expect(d.factsAvailable).toBe(true);
    expect(d.reasons).toContain(reason);
  });

  it('names every signal that pushed the mode down', () => {
    const d = decideRenderMode({ ...capable, prefersReducedMotion: true, saveData: true, viewportWidth: 320 });
    expect(d.mode).toBe('NUMBERS_ONLY');
    expect(d.reasons).toEqual(expect.arrayContaining(['NARROW_VIEWPORT', 'SAVE_DATA', 'REDUCED_MOTION']));
  });

  it('honours a user override in either direction', () => {
    expect(decideRenderMode({ ...capable, override: 'NUMBERS_ONLY' })).toMatchObject({ mode: 'NUMBERS_ONLY', reasons: ['USER_OVERRIDE'] });
    expect(decideRenderMode({ ...capable, prefersReducedMotion: true, override: 'ANIMATED' })).toMatchObject({ mode: 'ANIMATED', animate: true });
  });
});

describe('ambient animation budget', () => {
  it('runs when animated, visible and within budget', () => {
    const d = ambientAnimation({ mode: 'ANIMATED', documentHidden: false, lastFrameMs: 1 });
    expect(d).toEqual({ run: true, pausedBecause: null, frameIntervalMs: Math.ceil(1000 / AMBIENT_FRAME_BUDGET.maxFps) });
  });

  it('pauses when the document is hidden', () => {
    expect(ambientAnimation({ mode: 'ANIMATED', documentHidden: true, lastFrameMs: null })).toMatchObject({ run: false, pausedBecause: 'DOCUMENT_HIDDEN' });
  });

  it('pauses when the last frame overran its budget', () => {
    expect(ambientAnimation({ mode: 'ANIMATED', documentHidden: false, lastFrameMs: AMBIENT_FRAME_BUDGET.maxFrameMs + 1 })).toMatchObject({ run: false, pausedBecause: 'OVER_BUDGET' });
  });

  it('never runs in a non-animated mode', () => {
    for (const mode of ['STATIC', 'NUMBERS_ONLY'] as const) {
      expect(ambientAnimation({ mode, documentHidden: false, lastFrameMs: 0 })).toMatchObject({ run: false, pausedBecause: 'MODE_NOT_ANIMATED' });
    }
  });
});

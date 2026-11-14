/**
 * The world's renderer evaluation (UI-27-5, S-0427).
 *
 * "Evaluate supported rendering engines for a performant interactive
 * 2D/isometric experience, with paths to richer graphics if later justified …
 * Do not tear out working backend services or force a full framework rewrite
 * merely to adopt a renderer."
 *
 * The evaluation is recorded as typed data rather than prose so the decision
 * can be read, tested and shown on the page that uses it. It is a record of a
 * judgement, not a whitelist: a later evaluation may add an engine or reverse
 * the decision, and must say why in `reason`.
 */

export const RENDERER_EVALUATION_VERSION = 1 as const;

export type RendererEngineId = 'DOM_SVG' | 'CANVAS_2D' | 'PIXIJS_WEBGL' | 'PHASER';

export type RendererVerdict = 'ADOPTED_NOW' | 'LATER_IF_JUSTIFIED' | 'NOT_ADOPTED';

export interface RendererEngineEvaluation {
  id: RendererEngineId;
  name: string;
  /** What adopting it costs the existing React/Vite application. */
  integration: string;
  /** Needs a WebGL context to render at all. */
  requiresWebGL: boolean;
  /** Each drawn object is a real DOM node a screen reader and keyboard can reach. */
  accessibleByDefault: boolean;
  /** Adds a runtime dependency to the client bundle. */
  addsDependency: boolean;
  /** Would replace React as the application's component model. */
  requiresFrameworkRewrite: boolean;
  strengths: readonly string[];
  weaknesses: readonly string[];
  verdict: RendererVerdict;
  reason: string;
}

export interface RendererDecision {
  version: typeof RENDERER_EVALUATION_VERSION;
  decidedOn: string;
  adopted: RendererEngineId;
  /** The engine the world moves to if a measured need justifies it. */
  upgradePath: RendererEngineId;
  reason: string;
  /** What must be measured before the upgrade path is taken. */
  upgradeTrigger: string;
  evaluated: readonly RendererEngineEvaluation[];
}

export const RENDERER_EVALUATIONS: readonly RendererEngineEvaluation[] = [
  {
    id: 'DOM_SVG',
    name: 'DOM + SVG inside React',
    integration: 'None: components render inside the existing React/Vite tree and reuse its styles and tokens.',
    requiresWebGL: false,
    accessibleByDefault: true,
    addsDependency: false,
    requiresFrameworkRewrite: false,
    strengths: [
      'every district, building and character is a focusable element with a label, so keyboard and screen-reader paths reach the same facts',
      'CSS transforms give pan and zoom; CSS animation honours prefers-reduced-motion and stops when nothing changes',
      'click targets resolve to records through ordinary links and the shared selection state',
      'works without WebGL and on low-end mobile',
    ],
    weaknesses: [
      'thousands of simultaneously animated sprites would cost layout and paint time',
      'no particle or shader effects',
    ],
    verdict: 'ADOPTED_NOW',
    reason: 'The world draws tens to low hundreds of real entities, not thousands; SVG/DOM meets that with no new dependency, no rewrite and accessibility by construction.',
  },
  {
    id: 'CANVAS_2D',
    name: 'Canvas 2D',
    integration: 'A single <canvas> component inside React; hit-testing and focus must be rebuilt by hand.',
    requiresWebGL: false,
    accessibleByDefault: false,
    addsDependency: false,
    requiresFrameworkRewrite: false,
    strengths: ['cheap per-frame drawing of many sprites', 'no WebGL requirement'],
    weaknesses: [
      'pixels are opaque to assistive technology: a parallel DOM tree is needed for every fact',
      'hit-testing, focus order and text layout are hand-written',
      'a continuous draw loop must be throttled by hand',
    ],
    verdict: 'NOT_ADOPTED',
    reason: 'Its one advantage over SVG (sprite count) is not a need the real entity count creates, and it gives up accessibility the DOM provides for free.',
  },
  {
    id: 'PIXIJS_WEBGL',
    name: 'PixiJS (WebGL, Canvas fallback)',
    integration: 'A mounted renderer inside one React component (or @pixi/react); the rest of the application is untouched.',
    requiresWebGL: true,
    accessibleByDefault: false,
    addsDependency: true,
    requiresFrameworkRewrite: false,
    strengths: [
      'GPU-batched sprites, filters and particles for a richer isometric world',
      'can be mounted inside the existing React tree without rewriting the application',
    ],
    weaknesses: [
      'needs WebGL; the numbers-first and static paths must still exist beside it',
      'accessibility layer is separate and partial',
      'adds a sizeable dependency to the bundle',
    ],
    verdict: 'LATER_IF_JUSTIFIED',
    reason: 'The path to richer graphics: it mounts inside React, so it can replace the SVG scene alone if measurement shows the scene is the bottleneck.',
  },
  {
    id: 'PHASER',
    name: 'Phaser',
    integration: 'A full game framework with its own scene graph, loop, input and asset loader beside React.',
    requiresWebGL: false,
    accessibleByDefault: false,
    addsDependency: true,
    requiresFrameworkRewrite: true,
    strengths: ['complete game tooling: tilemaps, cameras, physics, tweening'],
    weaknesses: [
      'owns its own loop and input, competing with React for the page',
      'a continuous game loop by default, the heavyweight animation S-0429 warns against',
      'operating controls (tables, dialogs, forms) would live in a second UI system',
    ],
    verdict: 'NOT_ADOPTED',
    reason: 'It brings a second application model the world does not need; adopting it is the framework rewrite S-0428 rules out.',
  },
];

export const RENDERER_DECISION: RendererDecision = {
  version: RENDERER_EVALUATION_VERSION,
  decidedOn: '2026-11-14',
  adopted: 'DOM_SVG',
  upgradePath: 'PIXIJS_WEBGL',
  reason:
    'SVG/DOM inside the existing React/Vite application now: no new dependency, no framework rewrite, accessible by construction and usable without WebGL. A WebGL path (PixiJS mounted in one component) is taken later only if justified.',
  upgradeTrigger:
    'A measured scene of real entities that cannot hold its frame budget in SVG on a mid-range device, with the static and numbers-only modes kept beside it.',
  evaluated: RENDERER_EVALUATIONS,
};

export function evaluationOf(id: RendererEngineId): RendererEngineEvaluation | undefined {
  return RENDERER_EVALUATIONS.find((engine) => engine.id === id);
}

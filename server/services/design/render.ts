/**
 * The render lane: getting a picture of the product to a Brain that has no browser.
 *
 * ---------------------------------------------------------------------------
 * The knot this exists to untie
 * ---------------------------------------------------------------------------
 *
 * Two halves of the design loop need two different machines, and until this
 * module there was no path between them:
 *
 *   - **A capture needs a browser.** The deployed Brain has none and must not
 *     acquire one — a tick that launched Chromium would fail on every pass, and
 *     the image would have to carry a browser it never otherwise uses.
 *   - **A judgement needs the fleet.** `services/design/judge.ts` opens a bin,
 *     and a bin is only answerable where the fleet fires, which is the deployed
 *     Brain.
 *
 * So a change landed, `requestDesignCycle` opened a cycle in production, and
 * that cycle sat `OPEN` for ever: the only thing that could render it was
 * `npm run design resume` on a laptop, which boots its *own* SQLite Brain
 * against a throwaway directory and cannot see a production cycle at all. §24's
 * sentence, at the top of a kernel rather than inside one — **a state that says
 * it is waiting for something nobody can supply is not waiting, it is stuck.**
 *
 * ---------------------------------------------------------------------------
 * The route is the one that already exists
 * ---------------------------------------------------------------------------
 *
 * A render is work Brain wants done by a machine with a capability Brain does
 * not have, reported back as structured rows and validated before it is
 * believed. That is a **bin**, and every property this needs — dispatch,
 * fencing, leases, attempts, the completion contract, the refusal that costs an
 * attempt — is Step 10's machinery, unchanged. No new route, no new credential,
 * no new transport, and nothing here that could authorize anything.
 *
 * What the worker actually does is run one command in a checkout it already
 * has: `npm run design render`. The browser work lives in `capture.ts` exactly
 * as it does locally, so a remote render and a local one are the *same* code
 * looking at the same product — and the difference is only where the rows land.
 *
 * ---------------------------------------------------------------------------
 * Nothing a worker says about the picture is believed on its word
 * ---------------------------------------------------------------------------
 *
 * The submission is capture *metadata*: the surface, the width, the engine, the
 * sha-256 of the bytes, and the readings taken in the live page. The bytes stay
 * with the renderer, which is the same split `capture.ts` already makes — *the
 * address is an address and the digest is the evidence*.
 *
 * Every field is validated exactly, the surface must be one the cycle asked
 * about, the width must be one that surface declares, the hash must be a
 * sha-256, and the readings go through `coerceReadings` rather than being
 * trusted as submitted. A submission naming a surface nobody asked about, or a
 * width nobody declared, refuses the **whole** submission: §24's rule that an
 * unknown field refuses the whole proposal, because a worker whose third capture
 * is silently dropped cannot tell a rejected one from one nobody noticed.
 *
 * What this cannot check is whether the picture is a picture of *this* product.
 * A worker could render something else and report it honestly. The revision on
 * every capture is what makes that answerable afterwards rather than
 * unanswerable, and the honest statement is that this lane trusts the worker to
 * have run the command it was given — exactly as the factory trusts a worker to
 * have run the verification command whose exit code it reports.
 */
import {
  createBin,
  listBinUnitResults,
  markBinReady,
  retireBin,
} from '../../repos/bins.ts';
import { openBinRequest, recordCapture } from '../../repos/design.ts';
import type { CaptureReadings, DesignCapture, DesignCycle, DesignSurface } from '../../domain/design.ts';
import type { BinRepository } from '../../domain/types.ts';
import { BRAIN_REPOSITORY_ID } from '../../domain/binPurpose.ts';
import { coerceReadings } from './observe.ts';
import { measurePass } from './operate.ts';
import { DEFAULT_VIEWPORTS } from './surfaces.ts';

export const DESIGN_RENDER_CONTRACT = 'DESIGN_RENDER_V1';
export const DESIGN_RENDER_KIND = 'DESIGN_RENDER';

/**
 * Its own workload class, and that is the point rather than a label.
 *
 * `GENERAL_DESIGN_REVIEW` is answerable by any worker that can read; this needs
 * one that can start the product and drive a browser. Two classes is what lets
 * `services/bins/routing.ts` send each to a surface that can actually do it,
 * instead of spending a fire discovering that a reviewer has no Chromium.
 */
export const DESIGN_RENDER_WORKLOAD_CLASS = 'GENERAL_DESIGN_RENDER';

/**
 * The repository a render is of, and therefore where it is routed.
 *
 * A render is "run this command in the checkout", so the bin has to say *which*
 * checkout — and until it did, nothing could route it to one. A bin with no
 * repository is GENERAL by `familyOf`; every surface with a checkout is a
 * Factory surface, which onboarding (`setWorkerRouting`) scopes to an explicit
 * `['FACTORY']` row naming its repository. So a render was refused by FAMILY at
 * every surface that could run it and fired at general surfaces that could not:
 * 7 of 11 render bins in a week used all three attempts and ended NEEDS_HUMAN
 * with "No render was submitted" (ORIGINATED:FAILURE_PATTERN:design-render).
 *
 * The product being rendered is Brain's own client, built from Brain's own
 * repository (`npm run design -- render`), so the manifest names that
 * repository at the canonical branch. That is the same signal every Factory bin
 * carries, read by the same functions: `familyOf` makes the bin FACTORY,
 * `repositoryIdOf` makes it Brain's repository, and the router hands it only to a
 * surface whose routing row serves that repository — a surface with the
 * checkout. Where no such surface is in scope the router refuses the bin at BIN
 * scope and fires nothing, so no attempt is spent on a surface that cannot run
 * it. And `classifyBinPurpose` reads it as `REPOSITORY:BRAIN`, which is true:
 * seeing what Brain built is Brain work.
 *
 * Nothing is pushed: the prohibited actions still forbid changing a file or
 * pushing anything, so `integrationBranch` is empty and no pull request exists.
 * `baseSha` is the cycle's revision when it is a full commit, which is the tree
 * the render is supposed to be a picture of.
 */
export const DESIGN_RENDER_REPOSITORY_REMOTE = `https://github.com/${BRAIN_REPOSITORY_ID}`;

/** The canonical branch, as `.github/CANONICAL_BRANCH` names it (§28). */
export const DESIGN_RENDER_REF = 'production';

export function renderRepository(cycle: Pick<DesignCycle, 'revision'>): BinRepository {
  const revision = cycle.revision ?? '';
  return {
    remote: DESIGN_RENDER_REPOSITORY_REMOTE,
    ref: DESIGN_RENDER_REF,
    baseSha: /^[0-9a-f]{40}$/.test(revision) ? revision : '',
    integrationBranch: '',
    pullRequest: null,
  };
}

/**
 * The capabilities a render bin declares: none beyond what its repository
 * already decides.
 *
 * Routing to a checkout is done by the repository block above, not by a
 * capability. A declared capability is only satisfiable by a surface that is
 * *also in scope* for the bin, and requiring `repository` (or `browser`) of a
 * bin no checkout surface was in scope for refused every surface, every fire —
 * §27's failure. A class-implied `repository` in the router was tried once and
 * withdrawn for the same reason (attempt 1). Now that the bin is in scope for
 * exactly the surfaces that serve Brain's repository, a capability would add
 * nothing but a second way to refuse them; `browser` belongs here only once
 * those surfaces declare it, and in that order.
 *
 * `evaluateDesignRender` (`services/bins/contracts.ts`) still records, for every
 * render bin that ends with no render, which surface each attempt was fired at
 * and whether it declared `repository` — so whether a surface with a checkout
 * lacks a browser is read from rows, not argued.
 */
export const DESIGN_RENDER_REQUIRED_CAPABILITIES: readonly string[] = [];

/** The one unit a render bin asks for. */
export const RENDER_UNIT_KEY = 'design_render';

/** Where the bytes of a submitted capture are expected to have been written. */
export const RENDER_ARTIFACT_DIR = 'design-renders';

/**
 * The `created_by_id` one cycle's render bin for one pass carries.
 *
 * One function for the writer and the reader, for `reviewCreator`'s reason: a
 * key computed in two places is a key the two eventually disagree about.
 */
export function renderCreator(cycle: Pick<DesignCycle, 'id'>, pass: number): string {
  return `design:render:${cycle.id}:${pass}`;
}

/* =========================================================================
 * Asking
 * ====================================================================== */

export interface OpenRenderInput {
  cycle: DesignCycle;
  pass: number;
  projectId: string;
  surfaces: readonly DesignSurface[];
}

/**
 * Open the bin that asks somebody with a browser to look.
 *
 * Idempotent by the round, in `openDesignReview`'s shape and for its reason: the
 * bin is a **draft** until this caller's request row wins the unique key, so a
 * loser retires something that was never dispatchable rather than something the
 * fleet may already have been fired at.
 */
export async function openDesignRender(input: OpenRenderInput): Promise<string> {
  const addresses = input.surfaces
    .map((surface) => {
      const widths = surface.viewports.map((one) => `${one.width}`).join(', ');
      return `  ${surface.surfaceKey} — GET ${surface.route} at ${widths}px wide (${surface.title})`;
    })
    .join('\n');

  const bin = await createBin({
    projectId: input.projectId,
    layerId: null,
    kind: DESIGN_RENDER_KIND,
    title: `Design render: ${input.surfaces.map((one) => one.surfaceKey).join(', ')}`,
    objective:
      'Start this product from the repository you have checked out, render the addresses below ' +
      'in a real browser at the widths given, and submit what was measured in the live page. ' +
      'Brain has no browser, so this is the only way it can see what it built.',
    rationale:
      'A component’s source is not the interface. What a person sees is the product of every ' +
      'stylesheet, every container width and every font that did or did not load, so a design ' +
      'finding has to be about a render rather than about code.',
    manifest: {
      objective: 'Render the registered surfaces below and report what was measured in the page.',
      why:
        'The deployed Brain cannot open a browser. Without a render taken somewhere that can, ' +
        'every statement about this interface would be a statement about its source.',
      lineage: {
        projectId: input.projectId,
        layerId: null,
        goal: 'An interface that does not have to be corrected by hand on every screen.',
        orchestrationId: null,
      },
      repository: renderRepository(input.cycle),
      units: [
        {
          key: RENDER_UNIT_KEY,
          establishes: 'what these surfaces actually render as, at each declared width',
          input:
            'Run this in the checkout, which does the whole job and prints the submission:\n\n' +
            `    npm run design -- render --pass ${input.pass} --surfaces ` +
            `${input.surfaces.map((one) => one.surfaceKey).join(',')}\n\n` +
            'It builds the client, starts a Brain of its own, signs in, drives the browser ' +
            'already present at PLAYWRIGHT_BROWSERS_PATH, writes the images beside itself and ' +
            'prints one JSON object on stdout between BEGIN and END markers. Submit that object ' +
            'verbatim as this unit’s value.\n\n' +
            'It renders against a throwaway Brain rather than this one, deliberately: a capture ' +
            'is supposed to be a fact about the product, and pointing a harness at live data ' +
            'would photograph somebody’s real project rows.\n\n' +
            `This is pass ${input.pass} of cycle ${input.cycle.id}. The addresses, for a reader:\n` +
            addresses,
          transform: 'NONE',
          dependsOn: [],
        },
      ],
      acceptableSources: [
        `The product, started from a checkout of ${DESIGN_RENDER_REPOSITORY_REMOTE} at ` +
          `${DESIGN_RENDER_REF} — the repository this bin names, which is why it was routed to you.`,
        'A real browser. The one at PLAYWRIGHT_BROWSERS_PATH is already installed; do not ' +
          'download another and do not install a paid service.',
      ],
      excludedSources: [
        'The source code. A reading of a stylesheet is not a measurement of a rendered page, and ' +
          'this lane exists precisely because the two come apart.',
        'A previous run’s images. Every capture carries the revision it was taken at, and ' +
          'submitting an older one would bind a finding to a tree it is not about.',
      ],
      evidence: [
        'Every capture carries the sha-256 of the exact bytes written, the engine that drew it ' +
          'and its version, and the revision the tree was at.',
        'The readings are taken in the live document — a bounding rectangle, elementFromPoint at ' +
          'a control’s own centre, a computed contrast ratio — because the image has thrown all ' +
          'of them away.',
      ],
      outputs: [
        `One unit result under the key "${RENDER_UNIT_KEY}", whose value is the JSON object the ` +
          'command printed.',
        'It has "revision", "treeDirty" and "captures". Do not edit any of it: the hashes are ' +
          'what make it evidence rather than a report.',
      ],
      authorizedActions: [
        'starting this product locally',
        'driving a browser against it',
        'submitting one unit result',
      ],
      prohibitedActions: [
        'changing any file in the repository',
        'pushing anything anywhere',
        'installing a paid service or a new credential',
        'editing the printed submission by hand',
      ],
      budgetUnits: 1,
      retry: { maxAttempts: 2, backoffSeconds: 120 },
      stoppingConditions: [
        'the submission has been made',
        'or the product could not be started or the browser could not be found, which is reported ' +
          'as a blocker naming which — never as an empty render',
      ],
    },
    completionContract: DESIGN_RENDER_CONTRACT,
    createdByType: 'SYSTEM',
    requiredCapabilities: [...DESIGN_RENDER_REQUIRED_CAPABILITIES],
    createdById: renderCreator(input.cycle, input.pass),
    ready: false,
    priority: 5,
    maxAttempts: 3,
    workloadClass: DESIGN_RENDER_WORKLOAD_CLASS,
  });

  const { request, created } = await openBinRequest({
    binId: bin.id,
    cycleId: input.cycle.id,
    pass: input.pass,
    kind: 'RENDER',
    surfaceKeys: input.surfaces.map((one) => one.surfaceKey),
    revision: input.cycle.revision,
    captureDigest: null,
    captureCount: 0,
  });

  if (!created) {
    await retireBin({
      binId: bin.id,
      leaseGeneration: bin.leaseGeneration,
      operator: 'design-kernel',
      reason:
        `A render of pass ${input.pass} of ${input.cycle.id} was already open as ${request.binId}. ` +
        'This draft was never dispatchable and is retired rather than deleted.',
    });
    return request.binId;
  }

  await markBinReady(bin.id);
  return bin.id;
}

/* =========================================================================
 * Validating what came back
 * ====================================================================== */

export interface SubmittedCapture {
  surfaceKey: string;
  viewportName: string;
  width: number;
  height: number;
  contentHash: string;
  byteSize: number;
  artifactRef: string;
  engine: string;
  engineVersion: string | null;
  capturedAt: string;
  readings: CaptureReadings;
}

export type RenderSubmission =
  | { ok: true; revision: string | null; treeDirty: boolean; captures: SubmittedCapture[] }
  | { ok: false; problems: string[] };

const CAPTURE_KEYS = [
  'surfaceKey',
  'viewportName',
  'width',
  'height',
  'contentHash',
  'byteSize',
  'artifactRef',
  'engine',
  'engineVersion',
  'capturedAt',
  'readings',
] as const;

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Validate one submitted render, exactly.
 *
 * Whole-submission refusal, like every other zero-trust reader in this
 * repository. The widths are held against what the surface itself declares
 * rather than against a range, because a capture at a width nobody registered
 * is a measurement of a layout nobody asked about — and it would then be
 * compared, pass to pass, against nothing.
 */
export function validateRenderSubmission(
  raw: string,
  surfaces: readonly DesignSurface[],
): RenderSubmission {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, problems: ['The submission was not valid JSON.'] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problems: ['The submission was not a structured object.'] };
  }
  const body = parsed as Record<string, unknown>;
  const problems: string[] = [];

  const revisionRaw = body['revision'];
  if (revisionRaw !== null && typeof revisionRaw !== 'string') {
    problems.push('"revision" must be a commit string, or null on an unstamped tree.');
  }
  if (typeof body['treeDirty'] !== 'boolean') {
    problems.push('"treeDirty" must be true or false: whether the tree had uncommitted changes.');
  }

  const rawCaptures = body['captures'];
  if (!Array.isArray(rawCaptures)) {
    return { ok: false, problems: [...problems, '"captures" must be an array.'] };
  }
  if (rawCaptures.length === 0) {
    return {
      ok: false,
      problems: [
        ...problems,
        'No capture was submitted. A render that produced nothing is a blocker naming what ' +
          'stopped it, never an empty result — an empty one reads as a screen with nothing wrong.',
      ],
    };
  }

  const bySurface = new Map(surfaces.map((one) => [one.surfaceKey, one]));
  const captures: SubmittedCapture[] = [];
  const seen = new Set<string>();

  rawCaptures.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`captures[${index}] is not an object.`);
      return;
    }
    const row = entry as Record<string, unknown>;

    const extra = Object.keys(row).filter((key) => !(CAPTURE_KEYS as readonly string[]).includes(key));
    if (extra.length > 0) {
      problems.push(
        `captures[${index}] carries field(s) this contract does not define: ${extra.join(', ')}.`,
      );
    }

    const surfaceKey = String(row['surfaceKey'] ?? '');
    const surface = bySurface.get(surfaceKey);
    if (!surface) {
      problems.push(
        `captures[${index}].surfaceKey is ${JSON.stringify(row['surfaceKey'])}, which is not one ` +
          `of the surfaces this render was about (${[...bySurface.keys()].join(', ')}).`,
      );
      return;
    }

    const width = Number(row['width']);
    const declared = surface.viewports.find((one) => one.width === width);
    if (!declared) {
      problems.push(
        `captures[${index}].width is ${JSON.stringify(row['width'])}, which ${surfaceKey} does ` +
          `not declare (${surface.viewports.map((one) => one.width).join(', ')}).`,
      );
    }

    const height = Number(row['height']);
    if (!Number.isInteger(height) || height <= 0) {
      problems.push(`captures[${index}].height must be a positive whole number of pixels.`);
    }

    const contentHash = String(row['contentHash'] ?? '');
    if (!SHA256.test(contentHash)) {
      problems.push(
        `captures[${index}].contentHash must be a sha-256 of the bytes written, in lower-case hex.`,
      );
    }

    const byteSize = Number(row['byteSize']);
    if (!Number.isInteger(byteSize) || byteSize < 0) {
      problems.push(`captures[${index}].byteSize must be a whole number of bytes.`);
    }

    for (const key of ['viewportName', 'artifactRef', 'engine', 'capturedAt'] as const) {
      const value = row[key];
      if (typeof value !== 'string' || value.trim().length === 0) {
        problems.push(`captures[${index}].${key} must be a non-empty string.`);
      }
    }

    const engineVersion = row['engineVersion'];
    if (engineVersion !== null && typeof engineVersion !== 'string') {
      problems.push(`captures[${index}].engineVersion must be a string, or null if unknown.`);
    }

    const at = String(row['capturedAt'] ?? '');
    if (Number.isNaN(Date.parse(at))) {
      problems.push(`captures[${index}].capturedAt must be an ISO-8601 timestamp.`);
    }

    const pair = `${surfaceKey}|${width}`;
    if (seen.has(pair)) {
      problems.push(
        `captures[${index}] is a second picture of ${surfaceKey} at ${width}px in one ` +
          'submission. Two pictures of one thing make the set’s digest depend on which arrived.',
      );
    }
    seen.add(pair);

    if (problems.length === 0) {
      captures.push({
        surfaceKey,
        viewportName: String(row['viewportName']),
        width,
        height,
        contentHash,
        byteSize,
        artifactRef: String(row['artifactRef']).slice(0, 200),
        engine: String(row['engine']).slice(0, 80),
        engineVersion: typeof engineVersion === 'string' ? engineVersion.slice(0, 80) : null,
        capturedAt: new Date(at).toISOString(),
        readings: coerceReadings(row['readings']),
      });
    }
  });

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    revision: typeof revisionRaw === 'string' ? revisionRaw : null,
    treeDirty: body['treeDirty'] === true,
    captures,
  };
}

/* =========================================================================
 * Ingesting
 * ====================================================================== */

export interface RenderIngestOutcome {
  captures: DesignCapture[];
  refused: string | null;
  /** What the measured lane concluded, when there was anything to conclude. */
  measured: Awaited<ReturnType<typeof measurePass>> | null;
}

/**
 * Read a finished render bin, store the captures, and measure them.
 *
 * Nothing is stored unless the whole submission validates, and the measurement
 * that follows is `measurePass` — the same function a local run uses, so a
 * remotely-rendered pass and a locally-rendered one produce the same findings,
 * the same capability observations and the same measured review row.
 *
 * Idempotent by the captures already present: a pass that already holds
 * captures is not re-ingested, because the second copy would change the set's
 * digest and every finding on it would be a duplicate under a new capture id.
 */
export async function ingestDesignRender(input: {
  binId: string;
  cycle: DesignCycle;
  pass: number;
  surfaces: readonly DesignSurface[];
  existing: readonly DesignCapture[];
}): Promise<RenderIngestOutcome> {
  if (input.existing.length > 0) {
    return {
      captures: [...input.existing],
      refused: null,
      measured: null,
    };
  }

  const results = await listBinUnitResults(input.binId);
  const submitted = results.find((row) => row.unitKey === RENDER_UNIT_KEY);
  if (!submitted) {
    return {
      captures: [],
      refused: 'The render bin finished with no submission, so nothing was rendered.',
      measured: null,
    };
  }

  const validated = validateRenderSubmission(submitted.value, input.surfaces);
  if (!validated.ok) {
    return {
      captures: [],
      refused: `The render did not validate: ${validated.problems.join(' ')}`,
      measured: null,
    };
  }

  const byKey = new Map(input.surfaces.map((one) => [one.surfaceKey, one]));
  const stored: DesignCapture[] = [];
  for (const capture of validated.captures) {
    const surface = byKey.get(capture.surfaceKey)!;
    stored.push(
      await recordCapture({
        cycleId: input.cycle.id,
        pass: input.pass,
        surfaceKey: capture.surfaceKey,
        screen: surface.screen,
        stateKey: surface.stateKey,
        viewportName: capture.viewportName,
        width: capture.width,
        height: capture.height,
        revision: validated.revision,
        treeDirty: validated.treeDirty,
        contentHash: capture.contentHash,
        byteSize: capture.byteSize,
        artifactRef: capture.artifactRef,
        engine: capture.engine,
        engineVersion: capture.engineVersion,
        readings: capture.readings,
        capturedAt: capture.capturedAt,
      }),
    );
  }

  const measured = await measurePass({ cycle: input.cycle, pass: input.pass, captures: stored });
  return { captures: stored, refused: null, measured };
}

/**
 * The widths a surface is rendered at when it declares none.
 *
 * Exported so the worker-side helper and the bin's own brief cannot disagree
 * about what "every declared width" means for a surface registered without any.
 */
export const FALLBACK_VIEWPORTS = DEFAULT_VIEWPORTS;

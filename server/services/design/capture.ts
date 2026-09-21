/**
 * Rendering a registered surface, and binding the result to the bytes.
 *
 * ---------------------------------------------------------------------------
 * What a capture is, and what it is not
 * ---------------------------------------------------------------------------
 *
 * A capture is **a picture of one surface at one width, with the readings taken
 * while it was on the screen, the engine that drew it, and the revision the tree
 * was at**. Every one of those is load-bearing:
 *
 *   - the picture, because a person's approval and a person's correction are
 *     both about something they looked at;
 *   - the readings, because the picture has thrown away everything a measured
 *     finding is made of;
 *   - the engine, because two browsers lay a page out differently, so a
 *     measurement whose engine is unknown is not a measurement about anything;
 *   - the revision, because `design_approvals` already refuses to treat an
 *     approval as current unless the tree still matches, and a finding that
 *     outlived the code it was about is worse than no finding.
 *
 * The bytes are written to a directory and the **hash** goes on the row. That is
 * the same split `design-manifest.ts` already argues for: a directory is
 * mutable and the next run replaces every file in it, so the address is an
 * address and the digest is the evidence.
 *
 * ---------------------------------------------------------------------------
 * It never invents a state
 * ---------------------------------------------------------------------------
 *
 * A surface declares `preconditions`, and this module's job is to *check* them
 * and refuse when they do not hold — never to satisfy them by writing rows. A
 * capture of a state the product cannot actually be in is a screenshot of a
 * fixture, and a design finding about a fixture is a finding about something
 * nobody uses. Satisfying a precondition is a caller's decision, made where
 * there is authority to make it.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CaptureReadings, DesignCapture, DesignSurface } from '../../domain/design.ts';
import { recordCapture } from '../../repos/design.ts';
import { withPage, type PageSession } from './browser.ts';
import {
  coerceReadings,
  readingsExpression,
  revealExpression,
  unreadableReadings,
} from './observe.ts';
import { probeRenderRuntime, type RenderRuntime } from './renderRuntime.ts';

/** The font hosts the product links, answered from Node. See `browser.ts`. */
export const FONT_HOSTS = ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'];

export interface CaptureRequest {
  /** Where the product is served. The caller runs it; this module never does. */
  baseUrl: string;
  /** The session cookie a signed-in render needs, already obtained by the caller. */
  cookie?: { name: string; value: string } | null;
  surfaces: readonly DesignSurface[];
  cycleId: string | null;
  pass: number;
  /** Where the bytes go. Created if it is not there. */
  outputDir: string;
  /** Preconditions the caller has established, so a surface can be refused. */
  satisfied?: readonly string[];
  /** Overridden in tests; discovered otherwise. */
  runtime?: RenderRuntime;
}

export interface CaptureOutcome {
  captures: DesignCapture[];
  /** A surface that was not captured, and why. Never silently dropped. */
  skipped: { surfaceKey: string; reason: string }[];
  runtime: RenderRuntime;
}

/** The revision and whether the tree was dirty when the picture was taken. */
export function treeRevision(repoRoot: string): { revision: string | null; dirty: boolean } {
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { revision, dirty: status.length > 0 };
  } catch {
    /*
     * Null rather than a guess. §27's rule about a deployment attesting its own
     * commit, applied to a picture: a capture that claimed a revision it could
     * not read would let an approval bind to the wrong tree, which is the one
     * thing the binding exists to prevent.
     */
    return { revision: null, dirty: true };
  }
}

/**
 * The digest of a set of captures, in `design_approvals`' own shape.
 *
 * Deliberately the *same* function's semantics rather than a second one: a
 * review of a capture set and an approval of a render set have to be comparable,
 * and two digests computed differently over the same pictures would make that
 * impossible to check.
 */
export function digestCaptures(
  captures: ReadonlyArray<Pick<DesignCapture, 'surfaceKey' | 'width' | 'artifactRef' | 'contentHash'>>,
): { digest: string; count: number } {
  const hash = createHash('sha256');
  const ordered = [...captures].sort((a, b) =>
    `${a.surfaceKey}|${a.width}|${a.artifactRef}`.localeCompare(`${b.surfaceKey}|${b.width}|${b.artifactRef}`),
  );
  for (const capture of ordered) {
    hash.update(`${capture.surfaceKey}|${capture.width}|${capture.artifactRef}|`);
    hash.update(capture.contentHash);
    hash.update('\n');
  }
  return { digest: hash.digest('hex'), count: ordered.length };
}

/** A file name that says what it is a picture of, without needing an index. */
export function captureFileName(surfaceKey: string, width: number, pass: number): string {
  const slug = surfaceKey.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug}-${width}w-p${pass}.png`;
}

/**
 * Render every requested surface at every width it declares.
 *
 * One browser for the whole set rather than one per capture: a browser launch is
 * a second and a half, and the profile is fresh for the run rather than for each
 * page, which is the right unit — a render must not be a fact about the previous
 * *run*, and it is allowed to be a fact about the previous *page* in the same
 * sense a person navigating is.
 */
export async function captureSurfaces(request: CaptureRequest): Promise<CaptureOutcome> {
  const runtime = request.runtime ?? probeRenderRuntime();
  if (!runtime.available || !runtime.browser.command) {
    return {
      captures: [],
      skipped: request.surfaces.map((surface) => ({
        surfaceKey: surface.surfaceKey,
        reason: runtime.reason,
      })),
      runtime,
    };
  }

  fs.mkdirSync(request.outputDir, { recursive: true });
  const satisfied = new Set(request.satisfied ?? []);
  const captures: DesignCapture[] = [];
  const skipped: { surfaceKey: string; reason: string }[] = [];

  const { revision, dirty } = treeRevision(process.cwd());
  const command = runtime.browser.command;

  await withPage({ command, interceptHosts: FONT_HOSTS }, async (page) => {
    if (request.cookie) {
      await page.setCookie({
        name: request.cookie.name,
        value: request.cookie.value,
        url: request.baseUrl,
      });
    }

    for (const surface of request.surfaces) {
      const unmet = surface.preconditions.filter((one) => !satisfied.has(one));
      if (unmet.length > 0) {
        skipped.push({
          surfaceKey: surface.surfaceKey,
          reason:
            `this surface needs ${unmet.join(', ')}, which the caller has not established — ` +
            'nothing is rendered rather than a state being invented for the picture',
        });
        continue;
      }

      for (const viewport of surface.viewports) {
        try {
          const capture = await captureOne({
            page,
            surface,
            viewport,
            request,
            revision,
            dirty,
            engine: runtime.engine,
            engineVersion: runtime.version,
          });
          captures.push(capture);
        } catch (error) {
          /*
           * A capture that threw is recorded as skipped with the reason rather
           * than aborting the set. The other nineteen pictures are still worth
           * having, and a surface that could not be rendered is a fact the cycle
           * has to be able to report — §9's *one unreadable member blocks a
           * packet audit* is about a verdict, and this is about not losing the
           * evidence on the way to one.
           */
          skipped.push({
            surfaceKey: `${surface.surfaceKey}@${viewport.width}`,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  });

  return { captures, skipped, runtime };
}

async function captureOne(input: {
  page: PageSession;
  surface: DesignSurface;
  viewport: { name: string; width: number; height: number };
  request: CaptureRequest;
  revision: string | null;
  dirty: boolean;
  engine: string;
  engineVersion: string | null;
}): Promise<DesignCapture> {
  const { page, surface, viewport, request } = input;

  await page.setViewport(viewport.width, viewport.height);
  await page.goto(`${request.baseUrl}${surface.route}`);

  /*
   * Wait for the product to have painted something rather than for a fixed
   * time. The condition is deliberately weak — a body with any element in it —
   * because a stronger one would be a claim about how this particular screen
   * renders, and the registry is supposed to be able to hold a screen this
   * module has never seen.
   */
  const painted = await page.waitFor('document.body && document.body.children.length > 0', 12_000);

  let readings: CaptureReadings;
  // `let` rather than `const` because the reveal pass below unions into it.
  if (!painted) {
    readings = unreadableReadings(
      'the page never painted anything within twelve seconds, so nothing about its layout was read',
    );
  } else {
    try {
      readings = coerceReadings(await page.evaluate(readingsExpression()));
    } catch (error) {
      readings = unreadableReadings(
        `the readings expression threw in the page: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const bytes = await page.screenshot();
  const fileName = captureFileName(surface.surfaceKey, viewport.width, request.pass);
  fs.writeFileSync(path.join(request.outputDir, fileName), bytes);

  /*
   * What is reachable in two presses, read after the picture is taken.
   *
   * **The order is the whole of it.** The screenshot is of the resting state,
   * because that is what a person opens the screen to; the reachable *set* is a
   * question about what they can get to, and §29 settles that as "in one press
   * or in two — through More is still reached". Reading it from the resting page
   * alone reported Search, Build, Connected sites, Cash and Sign out as lost at
   * phone width, which is false and is the most expensive kind of false finding
   * this kernel can produce: it names a feature as gone.
   *
   * Recorded as a correction rather than quietly applied, because the first
   * version of this module did exactly that and the run that found it is the
   * first thing this kernel ever did.
   *
   * It runs last, so nothing it opens can affect the image or any other reading,
   * and a failure to reveal leaves the resting set rather than losing it.
   */
  if (painted) {
    try {
      const opened = await page.evaluate(revealExpression());
      if (Array.isArray(opened) && opened.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        const revealed = coerceReadings(await page.evaluate(readingsExpression()));
        readings.reachableControls = [
          ...new Set([...readings.reachableControls, ...revealed.reachableControls]),
        ];
      }
    } catch {
      /*
       * A page that would not open its disclosures keeps the resting set. That
       * under-reports reachability, which is the safe direction here only
       * because the consequence is a finding somebody can check against the
       * picture — never the other way round.
       */
    }
  }

  return recordCapture({
    cycleId: request.cycleId,
    pass: request.pass,
    surfaceKey: surface.surfaceKey,
    screen: surface.screen,
    stateKey: surface.stateKey,
    viewportName: viewport.name,
    width: viewport.width,
    height: viewport.height,
    revision: input.revision,
    treeDirty: input.dirty,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.length,
    artifactRef: fileName,
    engine: input.engine,
    engineVersion: input.engineVersion,
    readings,
    capturedAt: new Date().toISOString(),
  });
}

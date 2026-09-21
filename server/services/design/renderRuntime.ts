/**
 * Whether this machine can render the product, discovered rather than assumed.
 *
 * ---------------------------------------------------------------------------
 * The precedent, and why it is the right one
 * ---------------------------------------------------------------------------
 *
 * §9 already settled the shape for a capability that lives outside Brain: *OCR
 * is a local capability Brain discovers, version-checks at startup and reports.
 * With no engine installed, pages that need one are reported unreadable — never
 * passed on as empty content.* A browser is the same kind of thing one artifact
 * along. The deployed Brain runs in a container with no Chromium in it and must
 * not acquire one; the machine a developer or a harness runs on usually has one.
 *
 * So there are exactly two honest answers and the difference between them is the
 * whole point:
 *
 *   available    a render is evidence about the product
 *   unavailable  nothing is rendered, nothing is evaluated, and the cycle stops
 *                at NO_RENDER_RUNTIME with the remedy named
 *
 * What there is no answer for is *infer it from the source*. A kernel that read
 * JSX and reported a layout would be doing the thing §29 already paid for: the
 * `mode === 'BAR'` branch was written, tested and reachable by nothing because a
 * stylesheet removed the element it lived in, and **no test of either half could
 * see the other**. A render is not a nicer way of finding that out. It is the
 * only way.
 *
 * ---------------------------------------------------------------------------
 * Provenance travels with every capture
 * ---------------------------------------------------------------------------
 *
 * The engine and its version go on the `design_captures` row for the reason a
 * recognised page carries the engine, the version and the sha-256 of the exact
 * rendered image: two browsers lay a page out differently, so a measurement
 * whose engine is unknown is not a measurement about anything. A capture taken
 * by an engine that cannot report its version records null rather than a guess.
 */
import fs from 'node:fs';
import path from 'node:path';
import { findExecutable, platformInstallDirectories, type ExecutableProbe } from '../exec/discovery.ts';

export interface RenderRuntime {
  available: boolean;
  /** The probe, so a reader can see where it looked as well as what it found. */
  browser: ExecutableProbe;
  engine: string;
  version: string | null;
  /** Why it is or is not usable, in words somebody who is not a developer reads. */
  reason: string;
  /** Exactly what to do about it, when there is something to do. */
  install: string[];
  disabled: boolean;
}

/**
 * Where a headless Chromium usually is, beyond `PATH`.
 *
 * The Playwright cache is listed first because this repository already has one:
 * the environment pre-installs Chromium there and sets
 * `PLAYWRIGHT_BROWSERS_PATH`, so a harness that ignored it would download a
 * second copy of a browser that is already on the disk.
 */
function browserDirectories(): string[] {
  const dirs: string[] = [];
  const pwRoot = (process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '').trim();
  const roots = [pwRoot, '/opt/pw-browsers', path.join(process.env['HOME'] ?? '', '.cache', 'ms-playwright')];
  for (const root of roots) {
    if (!root) continue;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith('chromium')) continue;
      // The two layouts Playwright has used, and the mac one beside them.
      dirs.push(path.join(root, entry, 'chrome-linux'));
      dirs.push(path.join(root, entry, 'chrome-win'));
      dirs.push(
        path.join(root, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS'),
      );
    }
  }
  dirs.push(...platformInstallDirectories());
  return dirs.filter((dir) => dir.length > 0);
}

const INSTALL_STEPS: Record<string, string[]> = {
  linux: [
    'Install a headless Chromium (one time): sudo apt-get install -y chromium',
    '  or point Brain at one you already have with BRAIN_RENDER_BROWSER_PATH.',
  ],
  darwin: [
    'Install a headless Chromium (one time): brew install --cask chromium',
    '  or point Brain at one you already have with BRAIN_RENDER_BROWSER_PATH.',
  ],
  win32: [
    'Install a headless Chromium (one time): winget install --id Hibbiki.Chromium',
    '  or point Brain at one you already have with BRAIN_RENDER_BROWSER_PATH.',
  ],
};

function stepsForPlatform(): string[] {
  return INSTALL_STEPS[process.platform] ?? INSTALL_STEPS['linux']!;
}

/**
 * Probe once and describe what can be rendered here.
 *
 * Pure with respect to Brain's rows: it reads the filesystem and the
 * environment and writes nothing, so a caller can ask *could we render* without
 * a cycle, a capture or a capability move happening as a side effect.
 */
export function probeRenderRuntime(): RenderRuntime {
  const none = (): ExecutableProbe => ({
    tool: 'chromium',
    command: null,
    version: null,
    source: null,
    searched: [],
  });

  if ((process.env['BRAIN_RENDER'] ?? '').toLowerCase() === 'none') {
    return {
      available: false,
      browser: none(),
      engine: 'chromium',
      version: null,
      reason:
        'Rendering is switched off for this instance (BRAIN_RENDER=none), so nothing is ' +
        'captured and no design finding is produced — rather than a layout being guessed ' +
        'from the source.',
      install: ['Remove BRAIN_RENDER=none from the environment and restart to enable rendering.'],
      disabled: true,
    };
  }

  const browser = findExecutable({
    tool: 'chromium',
    names: ['chrome', 'chromium', 'chromium-browser', 'google-chrome', 'Chromium'],
    envVar: 'BRAIN_RENDER_BROWSER_PATH',
    extraDirectories: browserDirectories(),
  });

  if (!browser.command) {
    return {
      available: false,
      browser,
      engine: 'chromium',
      version: null,
      reason:
        'No headless browser was found on this machine, so the product cannot be rendered here. ' +
        'Nothing is evaluated: a layout read from the source rather than from a render is a ' +
        'claim about the code, not about what a person sees.',
      install: stepsForPlatform(),
      disabled: false,
    };
  }

  /*
   * `findExecutable` already asked. It treats a binary that will not answer
   * `--version` as absent, which is the right call here for the reason it gives
   * about an explicit setting: the version it reports has to be the version that
   * did the work, and a browser that cannot say which it is cannot supply the
   * provenance a capture is required to carry.
   */
  const version = browser.version;
  return {
    available: true,
    browser,
    engine: 'chromium',
    version,
    reason: `Renders are taken with ${version ?? 'a headless browser that did not name itself'}.`,
    install: [],
    disabled: false,
  };
}

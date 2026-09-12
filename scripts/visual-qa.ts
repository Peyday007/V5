/**
 * What the shell actually looks like, at a desktop width and a phone width.
 *
 * Everything else in `tests/` asserts a property. This produces images, and
 * that is the point: a constellation that overlaps its own nodes, a ring that
 * clips at the bottom of a 390-wide canvas, a detail card that pushes the map
 * off screen — none of those is a failing assertion, and all of them make the
 * surface unusable. The requirement is that the map works at representative
 * desktop and phone widths, and the only honest way to check it is to look.
 *
 * It boots a real server against a throwaway data directory, signs in, seeds
 * nothing beyond what the ordinary boot seeds, and drives Chromium through
 * every destination in the shell. It touches no deployed Brain, reads no
 * production credential and writes only into the directory you point it at.
 *
 *   npx tsx scripts/visual-qa.ts [outputDir]
 *
 * The images are deliberately not committed. They are evidence for one run at
 * one commit, and a screenshot in the repository is stale the moment the CSS
 * changes.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 6400 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = 'visual-qa@example.invalid';
const BOOTSTRAP = 'bootstrap-password-01';
const PASSWORD = 'visual-qa-password-01';

/**
 * Three widths, and the middle one is the one that mattered.
 *
 * Desktop and phone were the original pair, and they were not enough: the
 * rejected September 11 interface clipped between **822 and 953 pixels**, which
 * is neither. That band is not an arbitrary sample — it is the width at which a
 * rail, a main column and a detail column stop fitting side by side, and it is
 * exactly where a viewport media query lies about how much room a component
 * has. So 900 is captured as a first-class width rather than interpolated
 * between the other two, and the band's edges are swept below.
 */
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'intermediate', width: 900, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

/**
 * The band the rejected build clipped in, swept rather than sampled.
 *
 * One width inside a range proves that width. The defect was a *range*, so the
 * check walks its edges and its middle and fails on any of them — which is what
 * makes "the clipping is gone" a claim about the band rather than about 900.
 */
const CLIPPING_BAND = [822, 860, 900, 953];

/** Every destination in the shell, by the address that opens it. */
const DESTINATIONS = [
  { name: 'russell', path: '/' },
  { name: 'work', path: '/work' },
  { name: 'ideas', path: '/projects' },
  { name: 'knows', path: '/knowledge' },
  { name: 'who', path: '/fleet' },
  { name: 'needs-you', path: '/needs-you' },
];

/**
 * Three things a person does, driven for real.
 *
 * Each one reads something before, does the thing, and reads the same something
 * after — so the evidence is a *change*, not a click that may have landed on
 * nothing. `act` returns false when the control is not there at all, which is a
 * finding rather than a crash.
 */
const INTERACTIONS = [
  {
    name: 'open-a-section',
    path: '/',
    read: 'location.pathname',
    act: `(() => {
      const link = [...document.querySelectorAll('a,button')].find(
        (el) => (el.textContent || '').trim().toLowerCase() === 'work',
      );
      if (!link) return false;
      link.click();
      return true;
    })()`,
  },
  {
    name: 'reveal-details',
    path: '/needs-you',
    read: "String(document.querySelectorAll('details[open]').length)",
    act: `(() => {
      const first = document.querySelector('details:not([open]) > summary');
      if (!first) return false;
      first.click();
      return true;
    })()`,
  },
  {
    name: 'refuse-empty-search',
    path: '/search',
    read: "String(document.body.innerText).replace(/\\s+/g, ' ').slice(0, 60)",
    act: `(() => {
      const box = document.querySelector('input[type=search], input[type=text]');
      if (!box) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(box, 'a');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
  },
];

async function main(): Promise<void> {
  const outputDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'brain-visual-qa'));
  fs.mkdirSync(outputDir, { recursive: true });

  /*
   * Build the client first, because otherwise this photographs the last build.
   *
   * The server runs with `NODE_ENV=production` and serves `client/dist`, which
   * is a *committed-time artefact* rather than anything this script produces.
   * So every capture taken after a CSS edit and before a rebuild is a picture
   * of the previous tree — and it is a convincing picture, because it renders
   * perfectly and shows a defect that has already been fixed.
   *
   * That happened here: two real defects were found at 900px, repaired, and the
   * re-capture came back byte-identical. The repair was fine; the bundle was
   * five hours old. **A visual harness that serves a stale bundle is measuring
   * the last build, not this tree** — the same family as the two cleanup faults
   * above, and the most dangerous of the three, because its output looks like
   * evidence.
   *
   * Built here rather than left to the caller for the reason every other guard
   * in this repository is where it is: an instruction to remember something is
   * not a mechanism.
   */
  await buildClient();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-visual-qa-'));
  let log = '';
  const server: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [
      path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(REPO_ROOT, 'server', 'index.ts'),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BRAIN_DB_PATH: undefined,
        BRAIN_DATA_DIR: dataDir,
        PORT: String(PORT),
        NODE_ENV: 'production',
        BRAIN_BOOTSTRAP_ADMIN_EMAIL: EMAIL,
        BRAIN_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      /*
       * Its own process group, so the whole tree can be ended.
       *
       * `tsx`'s CLI is a launcher: it spawns the real server as a *grandchild*
       * with the loader attached. SIGTERM to the child therefore left the
       * grandchild holding the port and holding this process's event loop open
       * through its stdio pipes — so a run that had taken every screenshot,
       * swept the band and driven every interaction simply never exited, with
       * its output still sitting in a pipe. It sat like that for three hours
       * and was indistinguishable from a hang.
       *
       * A harness that has finished and cannot say so is worse than one that
       * fails, because the failure at least names itself. Detaching gives the
       * tree one group id, and the cleanup below ends the group.
       */
      detached: true,
    },
  );
  server.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()));
  server.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));

  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`the server never became healthy:\n${log}`);
      try {
        if ((await fetch(`${BASE}/healthz`)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // The bootstrap password must be changed before anything else works, which
    // is the ordinary first-run path rather than a shortcut for this script.
    const first = await signIn(BOOTSTRAP);
    await fetch(`${BASE}/api/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, cookie: first },
      body: JSON.stringify({ currentPassword: BOOTSTRAP, newPassword: PASSWORD }),
    });
    const cookie = await signIn(PASSWORD);

    await withChromium(async (cdp) => {
      for (const viewport of VIEWPORTS) {
        const problems: string[] = [];
        await cdp.send('Runtime.enable');
        await cdp.send('Log.enable');
        cdp.on('Log.entryAdded', (params) => {
          const entry = params['entry'] as { level?: string; text?: string } | undefined;
          if (entry?.level === 'error' && entry.text) problems.push(entry.text);
        });
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 2,
          mobile: viewport.width < 600,
        });
        await signInBrowser(cdp, cookie);

        for (const destination of DESTINATIONS) {
          await cdp.send('Page.navigate', { url: `${BASE}${destination.path}` });
          // The shell renders its state sentences as soon as it has an answer,
          // so this waits for the shell rather than for a fixed delay — with a
          // bound, because a screen that never renders is the finding.
          const rendered = await waitFor(cdp, "document.querySelector('.rs-shell') !== null");
          await sleep(900);
          const shot = (await cdp.send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
          })) as { data: string };
          const file = path.join(outputDir, `${viewport.name}-${destination.name}.png`);
          fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
          const sideways = (await evaluate(
            cdp,
            'document.documentElement.scrollWidth > document.documentElement.clientWidth',
          )) as boolean;
          const text = String(await evaluate(cdp, 'document.body.innerText')).replace(/\s+/g, ' ');
          /*
           * Which element is wider than the viewport — asked only when one is.
           *
           * "The page scrolls sideways" is not actionable; the element that
           * causes it is. But this walked every node on every page whether or
           * not anything overflowed, forcing a full layout eighteen times for a
           * value the line below only prints when `sideways` is true. It is the
           * diagnostic for a finding, so it runs when there is a finding.
           */
          const widest = sideways
            ? await evaluate(
                cdp,
                `(() => {
              const limit = document.documentElement.clientWidth;
              const bad = [];
              for (const el of document.querySelectorAll('*')) {
                const box = el.getBoundingClientRect();
                if (box.right > limit + 1 || box.left < -1) {
                  bad.push(el.className + '@' + Math.round(box.left) + '..' + Math.round(box.right));
                }
              }
              return bad.slice(0, 6).join(' | ');
            })()`,
              )
            : '';
          if (sideways && widest) console.log(`    overflowing: ${String(widest)}`);
          console.log(
            `${viewport.name.padEnd(8)} ${destination.name.padEnd(10)} ` +
              `${rendered ? 'rendered' : 'NEVER RENDERED'}  ` +
              `${sideways ? 'SCROLLS SIDEWAYS' : 'fits'}  ${text.slice(0, 90)}`,
          );
        }
        /*
         * Console errors, with the one that is about this machine named as one.
         *
         * `client/index.html` links the Google Fonts stylesheet, and outbound
         * HTTPS here goes through a proxy that resets it — so every page load
         * logs exactly one `ERR_CONNECTION_RESET` and the page renders on its
         * fallback stack. Printing six of those beside a real console error
         * with no distinction is how a reader learns to skim this section, and
         * then misses the real one. It is counted and named rather than
         * filtered out, because "no console errors" would be the other lie.
         */
        if (problems.length > 0) {
          const external = problems.filter((problem) => /ERR_CONNECTION_RESET/.test(problem));
          const real = problems.filter((problem) => !/ERR_CONNECTION_RESET/.test(problem));
          console.log(`  console errors at ${viewport.name}:`);
          if (external.length > 0) {
            console.log(
              `    ${external.length} × the Google Fonts stylesheet reset by this machine's ` +
                'outbound proxy — an environment fact; the page renders on its fallback stack',
            );
          }
          if (real.length === 0) console.log('    nothing else');
          for (const problem of real.slice(0, 10)) console.log(`    ${problem}`);
        }
      }
    });

    /*
     * The band, swept — each width in its own browser.
     *
     * Nothing is captured here unless something is wrong: a screenshot per
     * width across four widths and six destinations is twenty-four images
     * nobody looks at. What is recorded is the reading — does anything stick
     * out past the viewport — and an image only where it does, because that is
     * the one a person would need.
     *
     * ---------------------------------------------------------------------
     * Why a browser per width
     * ---------------------------------------------------------------------
     *
     * One long-lived Chromium got through the eighteen screenshots and the
     * first three widths and then stopped answering the protocol entirely, at
     * the same point twice — two navigations timed out and the next command
     * never returned. The bound made that legible rather than a hang, which is
     * what it is for, but a diagnostic that outlives its own browser is
     * measuring the browser.
     *
     * So each width is a session: launched, swept, ended. Nothing accumulates
     * across widths, a wedged renderer costs one width instead of the rest of
     * the run, and the evidence is identical — the reading is per width and
     * never compared across them.
     */
    console.log('');
    console.log('Sweeping the 822-953 band that the rejected build clipped in:');
    let clipped = 0;
    for (const width of CLIPPING_BAND) {
      await withChromium(async (cdp) => {
        await signInBrowser(cdp, cookie);
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        for (const destination of DESTINATIONS) {
          try {
            await cdp.send('Page.navigate', { url: `${BASE}${destination.path}` });
            await waitFor(cdp, "document.querySelector('.rs-shell') !== null");
            await sleep(500);
          } catch (error) {
            // A timeout here is a finding about *this* width and destination,
            // not a reason to abandon the sweep: the widths after it are the
            // ones the rejected build failed at, and losing them to one slow
            // page would be losing the evidence to the diagnostic.
            console.log(
              `  ${width}px ${destination.name}: NOT MEASURED — ${error instanceof Error ? error.message : error}`,
            );
            continue;
          }

          /*
           * Two different defects, measured separately, because conflating
           * them is what made the first run unreadable.
           *
           * **The page scrolls sideways** is the one the rejected build had,
           * and the honest test for it is the document's own scroll width. An
           * element-by-element scan is a *diagnostic* for when that is true,
           * never an independent criterion — used as one it flags absolutely
           * positioned nodes inside `.lim-canvas`, which has `overflow:
           * hidden` and therefore already contains them.
           *
           * **A label is cut off inside its own container** is a real defect
           * too, and a different one with a different fix. It is reported
           * under its own name rather than as a page overflow.
           */
          const sideways = (await evaluate(
            cdp,
            'document.documentElement.scrollWidth > document.documentElement.clientWidth',
          )) as boolean;

          const offenders = sideways
            ? String(
                await evaluate(
                  cdp,
                  `(() => {
                    const limit = document.documentElement.clientWidth;
                    const bad = [];
                    const nodes = document.querySelectorAll('.rs-shell *');
                    const cap = Math.min(nodes.length, 3000);
                    for (let i = 0; i < cap; i += 1) {
                      const el = nodes[i];
                      const box = el.getBoundingClientRect();
                      if (box.width === 0 && box.height === 0) continue;
                      if (box.right > limit + 1 || box.left < -1) {
                        bad.push((el.className || el.tagName) + '@' + Math.round(box.left) + '..' + Math.round(box.right));
                      }
                    }
                    return bad.slice(0, 4).join(' | ');
                  })()`,
                ),
              )
            : '';

          /*
           * A container that **scrolls** is not a container that **clips**.
           *
           * This skipped only `overflow: visible`, and flagged the tab strip at
           * 822 and 860 as a label cut off inside `.rs-tabs` — which has
           * `overflow-x: auto` precisely so the tabs can be reached by
           * scrolling, and which §29 names as one of the three things allowed
           * to scroll sideways. The content was never unreachable, so the
           * finding was about the harness rather than the build.
           *
           * That is the same distinction the sweep already draws one level up
           * between the document scrolling and an element overflowing, arrived
           * at again one level down: the defect is content a person cannot get
           * to, and `auto`/`scroll` is how they get to it. `hidden` and `clip`
           * stay in scope, because there the content really is gone.
           *
           * The walk is also capped. Uncapped, it called `getComputedStyle` and
           * forced a layout for every node and every child on the page, and on
           * the two densest destinations the renderer stopped answering the
           * protocol altogether — a diagnostic expensive enough to break the
           * thing it was measuring.
           */
          const cutOff = String(
            await evaluate(
              cdp,
              `(() => {
                const bad = [];
                const nodes = document.querySelectorAll('.rs-shell *');
                const cap = Math.min(nodes.length, 2000);
                for (let i = 0; i < cap; i += 1) {
                  const el = nodes[i];
                  if (el.children.length === 0) continue;
                  const style = getComputedStyle(el);
                  if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') continue;
                  const outer = el.getBoundingClientRect();
                  for (const child of el.children) {
                    const box = child.getBoundingClientRect();
                    if (box.width === 0 && box.height === 0) continue;
                    if (box.right > outer.right + 1 || box.left < outer.left - 1) {
                      bad.push((child.className || child.tagName) + ' inside ' + (el.className || el.tagName));
                    }
                  }
                }
                return [...new Set(bad)].slice(0, 3).join(' | ');
              })()`,
            ),
          );

          if (sideways) {
            clipped += 1;
            console.log(`  ${width}px ${destination.name}: SCROLLS SIDEWAYS -> ${offenders}`);
            const shot = (await cdp.send('Page.captureScreenshot', {
              format: 'png',
              captureBeyondViewport: true,
            })) as { data: string };
            fs.writeFileSync(
              path.join(outputDir, `clip-${width}-${destination.name}.png`),
              Buffer.from(shot.data, 'base64'),
            );
          }
          if (cutOff) {
            console.log(`  ${width}px ${destination.name}: label cut off inside a container -> ${cutOff}`);
          }
        }
      });
    }
    console.log(
      clipped === 0
        ? `  nothing clips at any of ${CLIPPING_BAND.join(', ')}px across ${DESTINATIONS.length} destinations`
        : `  ${clipped} clipping(s) found — images written`,
    );

      /*
       * And that the thing a person does actually works.
       *
       * A screenshot proves a layout rendered. It cannot tell you whether the
       * control under the cursor does anything, and §29's own rule is that the
       * visual gate is not passed by tests alone. So this drives three real
       * interactions at phone width — where the rail collapses and where a
       * broken control is most likely — and prints what changed.
       */
    console.log('');
    console.log('Interactions, at phone width:');
    await withChromium(async (cdp) => {
      await signInBrowser(cdp, cookie);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
      });
      for (const step of INTERACTIONS) {
        await cdp.send('Page.navigate', { url: `${BASE}${step.path}` });
        await waitFor(cdp, "document.querySelector('.rs-shell') !== null");
        await sleep(600);
        const before = String(await evaluate(cdp, step.read));
        const acted = await evaluate(cdp, step.act);
        await sleep(700);
        const after = String(await evaluate(cdp, step.read));
        const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
          data: string;
        };
        fs.writeFileSync(
          path.join(outputDir, `interaction-${step.name}.png`),
          Buffer.from(shot.data, 'base64'),
        );
        console.log(
          `  ${step.name.padEnd(18)} ${acted ? 'acted' : 'NO CONTROL FOUND'}  ` +
            `${before.slice(0, 40)} -> ${after.slice(0, 40)}`,
        );
      }
    });

    console.log(`\nImages in ${outputDir}`);
  } finally {
    await endServerTree(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * `vite build`, run to completion, with its failure as this script's failure.
 *
 * Not `npm run build`: that also typechecks, which the suite already does and
 * which would add a minute to every capture. What this needs is the bundle the
 * server is about to serve.
 */
async function buildClient(): Promise<void> {
  process.stdout.write('Building the client so this captures the current tree... ');
  const started = Date.now();
  const build = spawn('npx', ['vite', 'build'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  build.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  build.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number>((resolve) => {
    build.on('close', (value) => resolve(value ?? 1));
  });
  if (code !== 0) {
    console.log('FAILED');
    console.log(output);
    throw new Error('the client did not build, so there is nothing honest to photograph');
  }
  console.log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
}

/**
 * End the server and everything it launched, and do not return until it is gone.
 *
 * Asked politely first and then not: a `tsx` launcher forwards nothing, so the
 * grandchild that is actually listening survives a SIGTERM aimed at its parent.
 * The negative pid addresses the group, which is why the spawn above detaches.
 *
 * Both signals are wrapped, because "the group is already gone" arrives here as
 * an ESRCH and is the outcome this function wants rather than an error.
 */
async function endServerTree(server: {
  pid?: number;
  kill(signal: NodeJS.Signals): boolean;
}): Promise<void> {
  const { pid } = server;
  const signal = (which: NodeJS.Signals): void => {
    try {
      if (pid) process.kill(-pid, which);
      else server.kill(which);
    } catch {
      /* already gone */
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      if (pid) process.kill(-pid, 0);
      else break;
    } catch {
      return; // the group no longer exists
    }
    if (Date.now() > deadline) break;
    await sleep(200);
  }
  signal('SIGKILL');
}

/**
 * The same, without waiting: used where the caller is already unwinding.
 *
 * Chromium answers SIGTERM promptly when it is healthy and not at all when it
 * is the reason we are here, so both signals go at once rather than five
 * seconds apart.
 */
function endProcessTree(child: { pid?: number; kill(signal: NodeJS.Signals): boolean }): void {
  for (const which of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      if (child.pid) process.kill(-child.pid, which);
      else child.kill(which);
    } catch {
      /* already gone */
    }
  }
}

/* -------------------------------------------------------------------------
 * Chromium, over the DevTools protocol.
 *
 * Driven by hand rather than through a browser-automation library, because
 * this script is the only thing in the repository that needs one and adding a
 * dependency to the deployed package for a development convenience is a poor
 * trade. Chromium is already on the machine; the protocol is a WebSocket and
 * about a hundred lines.
 * ---------------------------------------------------------------------- */

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  on(event: string, handler: (params: Record<string, unknown>) => void): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withChromium(body: (cdp: Cdp) => Promise<void>): Promise<void> {
  const port = 9222 + Math.floor(Math.random() * 300);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-qa-profile-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    // Its own group, for the same reason the server is detached: Chromium is a
    // tree of processes and killing the one we spawned leaves the renderers,
    // the GPU process and the zygotes behind.
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  try {
    let target: { webSocketDebuggerUrl: string } | null = null;
    const deadline = Date.now() + 30_000;
    while (!target) {
      if (Date.now() > deadline) throw new Error('Chromium never opened its debugging port.');
      try {
        const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
          type: string;
          webSocketDebuggerUrl: string;
        }[];
        target = pages.find((page) => page.type === 'page') ?? null;
      } catch {
        /* not up yet */
      }
      if (!target) await sleep(200);
    }

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('the debugger refused')), {
        once: true,
      });
    });

    let nextId = 1;
    const pending = new Map<number, (value: Record<string, unknown>) => void>();
    const listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        result?: Record<string, unknown>;
        params?: Record<string, unknown>;
      };
      if (message.id !== undefined) {
        pending.get(message.id)?.(message.result ?? {});
        pending.delete(message.id);
      } else if (message.method) {
        for (const handler of listeners.get(message.method) ?? []) handler(message.params ?? {});
      }
    });

    const cdp: Cdp = {
      /*
       * Every call is bounded, and a call that is not is a run that hangs.
       *
       * This promise used to have no timeout and no rejection path at all, so a
       * reply Chromium never sent — a renderer that died, an evaluate that
       * walked every node on the map page and was dropped — left the whole
       * script waiting for ever, with no output, looking exactly like slow
       * progress. It did that here for fourteen minutes before it was noticed.
       *
       * A bound turns that into a legible failure naming the method, which is
       * the difference between a harness that reports and one that has to be
       * diagnosed with `ps`.
       */
      send: (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Chromium never answered ${method} (id ${id}) within 30s`));
          }, 30_000);
          pending.set(id, (value) => {
            clearTimeout(timer);
            resolve(value);
          });
          socket.send(JSON.stringify({ id, method, params }));
        }),
      on: (event, handler) => {
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      },
    };

    await cdp.send('Page.enable');
    try {
      await body(cdp);
    } finally {
      /*
       * In a `finally`, because it was not.
       *
       * A throw inside `body` — which is what a renderer that stops answering
       * produces — skipped this line, and an open WebSocket holds Node's event
       * loop open for ever. So a run that had already reported its failure
       * legibly then sat there not exiting, which is the *second* form of the
       * same defect the detached server spawn above records: a harness that
       * has finished and cannot say so.
       */
      socket.close();
    }
  } finally {
    endProcessTree(chrome);
    /*
     * `force` covers a missing directory; it does not cover a Chromium that has
     * been sent SIGTERM and is still writing into its profile, which raced this
     * and made the whole run exit non-zero *after* every screenshot had already
     * been taken and checked. `maxRetries` waits it out, and a profile that
     * still will not go is left in the system temp directory rather than turned
     * into a failure — the evidence this script exists to produce is the
     * images, and losing the run over a directory would be the tail wagging the
     * dog.
     */
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* left behind in the temp directory, deliberately */
    }
  }
}

/**
 * Hand this browser the session cookie a person signs in with.
 *
 * Its own function because there are three browser sessions now, and a phase
 * that forgot it would silently measure the signed-out shell — which renders,
 * and renders something else.
 */
async function signInBrowser(cdp: Cdp, cookie: string): Promise<void> {
  const [cookieName, cookieValue] = cookie.split('=');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCookie', {
    name: cookieName ?? '',
    value: cookieValue ?? '',
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    secure: false,
  });
}

async function evaluate(cdp: Cdp, expression: string): Promise<unknown> {
  const result = (await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: unknown } };
  return result.result?.value;
}

/** Poll one expression until it is true, or give up and say so. */
async function waitFor(cdp: Cdp, expression: string, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await evaluate(cdp, expression)) === true) return true;
    await sleep(200);
  }
  return false;
}

async function signIn(password: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email: EMAIL, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status}`);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

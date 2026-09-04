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

/** The two widths the requirement names. Nothing in between is claimed. */
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

/** Every destination in the shell, by the address that opens it. */
const DESTINATIONS = [
  { name: 'russell', path: '/' },
  { name: 'work', path: '/work' },
  { name: 'ideas', path: '/projects' },
  { name: 'knows', path: '/knowledge' },
  { name: 'who', path: '/fleet' },
  { name: 'needs-you', path: '/needs-you' },
];

async function main(): Promise<void> {
  const outputDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'brain-visual-qa'));
  fs.mkdirSync(outputDir, { recursive: true });

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
          // Which element is wider than the viewport, if any. "The page scrolls
          // sideways" is not actionable; the element that causes it is.
          const widest = await evaluate(
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
          );
          if (sideways && widest) console.log(`    overflowing: ${String(widest)}`);
          console.log(
            `${viewport.name.padEnd(8)} ${destination.name.padEnd(10)} ` +
              `${rendered ? 'rendered' : 'NEVER RENDERED'}  ` +
              `${sideways ? 'SCROLLS SIDEWAYS' : 'fits'}  ${text.slice(0, 90)}`,
          );
        }
        if (problems.length > 0) {
          console.log(`  console errors at ${viewport.name}:`);
          for (const problem of problems.slice(0, 10)) console.log(`    ${problem}`);
        }
      }
    });

    console.log(`\nImages in ${outputDir}`);
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
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
    { stdio: ['ignore', 'pipe', 'pipe'] },
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
      send: (method, params = {}) =>
        new Promise((resolve) => {
          const id = nextId++;
          pending.set(id, resolve);
          socket.send(JSON.stringify({ id, method, params }));
        }),
      on: (event, handler) => {
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      },
    };

    await cdp.send('Page.enable');
    await body(cdp);
    socket.close();
  } finally {
    chrome.kill('SIGTERM');
    fs.rmSync(profile, { recursive: true, force: true });
  }
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

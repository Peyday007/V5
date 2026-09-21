/**
 * A headless browser, driven over the debugging protocol, bounded everywhere.
 *
 * ---------------------------------------------------------------------------
 * Why this is not a dependency
 * ---------------------------------------------------------------------------
 *
 * The obvious move is Playwright. It is not taken, for two reasons that are
 * both about this repository rather than about Playwright: `scripts/visual-qa.ts`
 * already drives Chromium over raw CDP and has paid for every bound in this
 * file, and adding a browser automation framework to `dependencies` would put a
 * hundred megabytes of it into an image whose whole point is that it does not
 * render anything. What is here is the driver that harness earned, lifted out of
 * it so that the kernel and the harness cannot disagree about how a page is
 * opened.
 *
 * ---------------------------------------------------------------------------
 * Three bounds, each of which was a real failure first
 * ---------------------------------------------------------------------------
 *
 * **Every call has a timeout.** A reply Chromium never sends — a renderer that
 * died, an evaluate that walked a large document and was dropped — otherwise
 * leaves the caller waiting for ever with no output, which looks exactly like
 * slow progress. `visual-qa.ts` records fourteen minutes of that. A bound turns
 * it into a legible failure naming the method.
 *
 * **The socket closes in a `finally`.** A throw inside the body skipped it, and
 * an open WebSocket holds Node's event loop open — so a run that had already
 * reported its failure correctly then sat there not exiting. A harness that has
 * finished and cannot say so is the second form of the same defect.
 *
 * **The browser is killed as a process tree.** Chromium is a tree — renderers, a
 * GPU process, zygotes — and killing the one that was spawned leaves the rest.
 * Hence its own process group and a group signal.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PageSession {
  /** Send one protocol method. Bounded; rejects by name on a timeout. */
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Open an address and wait for the load event to have gone past. */
  goto(url: string, options?: { waitMs?: number }): Promise<void>;
  /** Evaluate an expression in the page and return whatever it produced. */
  evaluate(expression: string): Promise<unknown>;
  /** Poll an expression until it is truthy, or give up and say so. */
  waitFor(expression: string, timeoutMs?: number): Promise<boolean>;
  /** Set the viewport, as a device metrics override rather than a window resize. */
  setViewport(width: number, height: number): Promise<void>;
  /** A full-page PNG. */
  screenshot(): Promise<Buffer>;
  /** Put a cookie in, so a render can be of a signed-in product. */
  setCookie(input: { name: string; value: string; url: string }): Promise<void>;
}

export interface BrowserOptions {
  /** The executable, from `probeRenderRuntime`. Never guessed here. */
  command: string;
  /** Per-call bound. */
  timeoutMs?: number;
  /**
   * Hosts to answer from Node rather than from the browser.
   *
   * The product links Google Fonts, and a browser launched with no proxy resets
   * that request — so every render lands on the fallback stack. §29 is explicit
   * about what that costs: **a render in the wrong typefaces is a picture of a
   * different product**, because type sets every label width and a label width
   * is what an overlap is made of. Answering from Node, which does have the
   * proxy, changes nothing about the page and nothing about the browser's trust.
   * Disabling certificate checking to get a picture is the pattern somebody
   * copies somewhere it matters.
   */
  interceptHosts?: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One process-wide cache: the same handful of files on every page and width. */
const interceptCache = new Map<string, { type: string; body: string } | null>();

async function fetchIntercepted(url: string): Promise<{ type: string; body: string } | null> {
  if (interceptCache.has(url)) return interceptCache.get(url) ?? null;
  try {
    const response = await fetch(url, {
      headers: {
        // The page's own UA, so a font host serves the format this engine wants.
        'user-agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      },
    });
    if (!response.ok) {
      interceptCache.set(url, null);
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const entry = {
      type: response.headers.get('content-type') ?? 'application/octet-stream',
      body: buffer.toString('base64'),
    };
    interceptCache.set(url, entry);
    return entry;
  } catch {
    interceptCache.set(url, null);
    return null;
  }
}

function endProcessTree(child: { pid?: number; kill(signal: NodeJS.Signals): boolean }): void {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run `body` against a fresh browser with a throwaway profile.
 *
 * A fresh profile per run rather than a shared one, because a render is supposed
 * to be a fact about the product and a cached stylesheet or a leftover cookie
 * from the previous surface would make it a fact about the previous run as well.
 */
export async function withPage<T>(
  options: BrowserOptions,
  body: (page: PageSession) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const port = 9300 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-design-profile-'));
  const browser = spawn(
    options.command,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );

  try {
    let target: { webSocketDebuggerUrl: string } | null = null;
    const deadline = Date.now() + timeoutMs;
    while (!target) {
      if (Date.now() > deadline) {
        throw new Error('the browser never opened its debugging port');
      }
      try {
        const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
          type: string;
          webSocketDebuggerUrl: string;
        }[];
        target = pages.find((page) => page.type === 'page') ?? null;
      } catch {
        /* not up yet */
      }
      if (!target) await sleep(150);
    }

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the debugger never accepted a connection')), timeoutMs);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('the debugger refused the connection'));
        },
        { once: true },
      );
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

    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`the browser never answered ${method} within ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        socket.send(JSON.stringify({ id, method, params }));
      });

    const on = (event: string, handler: (params: Record<string, unknown>) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    };

    await send('Page.enable');
    await send('Runtime.enable');
    if (options.interceptHosts && options.interceptHosts.length > 0) {
      await enableIntercept(send, on, options.interceptHosts);
    }

    const page: PageSession = {
      send,
      async goto(url, gotoOptions = {}) {
        let loaded = false;
        on('Page.loadEventFired', () => {
          loaded = true;
        });
        await send('Page.navigate', { url });
        const until = Date.now() + timeoutMs;
        while (!loaded && Date.now() < until) await sleep(60);
        // A settle after load, because the product paints from data it fetches
        // once mounted and a screenshot taken at `load` is a picture of a
        // skeleton. A fixed wait rather than a heuristic: a heuristic about
        // "network idle" is exactly the kind of thing that is right until the
        // first surface that polls.
        await sleep(gotoOptions.waitMs ?? 900);
      },
      async evaluate(expression) {
        const result = (await send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        })) as {
          result?: { value?: unknown };
          exceptionDetails?: { text?: string; exception?: { description?: string } };
        };
        if (result.exceptionDetails) {
          const detail =
            result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown';
          throw new Error(`the page threw while evaluating: ${detail}`);
        }
        return result.result?.value;
      },
      async waitFor(expression, waitMs = 10_000) {
        const until = Date.now() + waitMs;
        while (Date.now() < until) {
          try {
            if (await page.evaluate(expression)) return true;
          } catch {
            /* the page may not be ready to answer yet */
          }
          await sleep(120);
        }
        return false;
      },
      async setViewport(width, height) {
        /*
         * A device metrics override rather than a window resize, because the
         * window is the thing a headless browser is least honest about: a resize
         * is asynchronous, can be clamped by the host, and leaves the layout
         * viewport disagreeing with the visual one. The override is exact, and
         * `mobile: false` because Brain is a desktop-class product served to a
         * phone rather than a mobile site.
         */
        await send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
      },
      async screenshot() {
        const shot = (await send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
        })) as { data?: string };
        if (typeof shot.data !== 'string') {
          throw new Error('the browser produced no image');
        }
        return Buffer.from(shot.data, 'base64');
      },
      async setCookie(input) {
        await send('Network.enable');
        await send('Network.setCookie', { name: input.name, value: input.value, url: input.url });
      },
    };

    try {
      return await body(page);
    } finally {
      // In a `finally`, because it was not: an open socket holds the event loop
      // and a run that has already reported its failure then cannot exit.
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
  } finally {
    endProcessTree(browser);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* left in the temp directory deliberately — losing a run over a
         directory would be the tail wagging the dog */
    }
  }
}

/**
 * Answer the declared hosts from Node instead of from the browser.
 *
 * `Fetch.enable` with a pattern, and every other request continues untouched.
 * A request that cannot be answered is *continued* rather than failed, so a font
 * that genuinely cannot be fetched still falls back exactly as it would in a
 * browser with no network — pretending otherwise would be the same lie one step
 * along.
 */
async function enableIntercept(
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  on: (event: string, handler: (params: Record<string, unknown>) => void) => void,
  hosts: string[],
): Promise<void> {
  on('Fetch.requestPaused', (params) => {
    const requestId = String(params['requestId'] ?? '');
    const request = params['request'] as { url?: string } | undefined;
    const url = request?.url ?? '';
    void (async () => {
      const entry = url ? await fetchIntercepted(url) : null;
      try {
        if (entry) {
          await send('Fetch.fulfillRequest', {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: entry.type }],
            body: entry.body,
          });
        } else {
          await send('Fetch.continueRequest', { requestId });
        }
      } catch {
        /* the page moved on; the request is moot */
      }
    })();
  });
  await send('Fetch.enable', {
    patterns: hosts.map((host) => ({ urlPattern: host, requestStage: 'Request' })),
  });
}

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
 * It writes to a throwaway directory by default, and that default is the rule:
 * a screenshot in the repository is stale the moment the CSS changes, and a
 * stale one that still looks like evidence is worse than none.
 *
 * **One named set is committed anyway, and the reason is recorded rather than
 * left as a contradiction.** §29's acceptance asks a person to approve what the
 * product actually looks like, and a decision somebody has to re-run a
 * twelve-minute harness to see is a decision nobody makes.
 * `docs/evidence/step12b-visual.md` is that set: it names the commit and the
 * date the images were taken at, and it says in its own first paragraph that it
 * is the record of one run and not a baseline anything is compared against.
 * Nothing reads those files; deleting them breaks no test.
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
  { name: 'desktop', width: 1180, height: 900 },
  { name: 'intermediate', width: 953, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

/**
 * The four screens the approved preview covered, and why they are named here.
 *
 * §24's design gate is a decision a person makes by **looking**, and the preview
 * they approved the direction from showed exactly these four at exactly the
 * three widths above. A handoff that showed different screens, or the same
 * screens at different widths, would not be comparable with the thing it is
 * asking to be judged against — so the set is declared rather than assembled
 * from whatever the run happened to capture.
 *
 * `needs-you-populated` and `needs-you-empty` are one address in its two real
 * states. Nothing is faked to produce either: a Brain with no standing grant has
 * exactly one decision outstanding — the approval nothing can proceed without —
 * and pressing that page's own Approve button is what settles it. No request row
 * is invented, and the grant lands in the throwaway database this run deletes
 * afterwards.
 */
const HANDOFF_SCREENS: Record<string, string> = {
  russell: 'russell-home',
  ideas: 'project-constellation',
  'needs-you': 'needs-you-populated',
};

/** Where the approval set is written, and the declaration written beside it. */
const RENDERS_DEFAULT = path.join('docs', 'evidence', 'step12b-renders');

interface Render {
  screen: string;
  width: number;
  file: string;
}

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

/* -------------------------------------------------------------------------
 * The readings every capture takes, in one place.
 *
 * The band sweep and the phone journey ask the same questions of the page, and
 * two copies of a predicate is two predicates: the sweep's rule that a
 * **scrollable** container is not a **clipping** one was arrived at once, from a
 * real false finding, and a second copy would have had to arrive at it again. So
 * the rule lives here and both readers use it — `hidden` and `clip` stay in
 * scope because there the content really is gone, `auto` and `scroll` stay out
 * because that is how a person reaches it.
 * ---------------------------------------------------------------------- */

/**
 * §29's "the page body must never scroll horizontally", asked of the document.
 *
 * Of the document rather than of an element, because an element sticking out of
 * a container that already contains it is a different defect with a different
 * fix, and `CUT_OFF` is what reports that one. `window.innerWidth` and
 * `documentElement.clientWidth` are the same number here because Chromium is
 * launched with `--hide-scrollbars`; the window is named because that is the
 * screen a person is holding.
 */
const SIDEWAYS = 'document.documentElement.scrollWidth > window.innerWidth';

/** Content cut off inside a container that clips rather than scrolls. */
const CUT_OFF = `(() => {
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
})()`;

/** Which element sticks out past the viewport — the diagnostic for a finding. */
const OFFENDERS = `(() => {
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
})()`;

/**
 * A control a thumb cannot land on, asked the way a thumb asks.
 *
 * A box of the right size in the right place is still not a control if
 * something else is painted over it, and nothing about a bounding rectangle can
 * say so. `elementFromPoint` is what actually decides which element receives a
 * tap, so it is what this asks — at the control's own centre, which is where a
 * person aims.
 *
 * A control scrolled off the bottom of a long page is not a finding; that is
 * what scrolling is for. One that is off to the *side*, or covered where it
 * sits, is.
 *
 * **An element with no box at all is not this question, and its first version
 * of this said it was.** That flagged `Build`, `Connected sites` and `Search`
 * on every one of seventeen steps — which was pointing at something real, and
 * pointing at it with a predicate that cannot tell a control that was silently
 * dropped from one the shell deliberately renders somewhere else. A `display:
 * none` node is not on the screen; whether a person can still get to what it
 * does is a question about the *set* of reachable controls, and `REACHABLE`
 * below is where that is asked.
 */
function unreachable(selector: string): string {
  return `(() => {
    const bad = [];
    for (const el of document.querySelectorAll(${JSON.stringify(selector)})) {
      const box = el.getBoundingClientRect();
      const name = ((el.textContent || el.className || el.tagName).trim() || el.tagName).slice(0, 28);
      if (box.width < 1 || box.height < 1) continue;
      if (box.top > innerHeight || box.bottom < 0) continue;
      if (box.left < -1 || box.right > innerWidth + 1) {
        bad.push(name + ': off the side of the screen');
        continue;
      }
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (!hit) { bad.push(name + ': nothing at its own centre'); continue; }
      if (el.contains(hit) || hit.contains(el)) continue;
      const over = ((hit.textContent || hit.className || hit.tagName).trim() || hit.tagName).slice(0, 28);
      bad.push(name + ': covered by ' + over);
    }
    return bad.slice(0, 6).join(' | ');
  })()`;
}

/**
 * Every name in the shell's chrome a person can actually press right now.
 *
 * Pressable rather than present: it has a box, it is on the screen sideways,
 * and its own centre belongs to it. A badge is stripped off the end of a label
 * and the More button is reduced to `More`, because a set that distinguished
 * "Needs you" from "Needs you1" would be a set about rendering rather than
 * about destinations.
 */
const REACHABLE = `(() => {
  const names = new Set();
  for (const el of document.querySelectorAll('.rs-rail button, .rs-rail a')) {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    if (box.left < -1 || box.right > innerWidth + 1) continue;
    if (box.top > innerHeight || box.bottom < 0) continue;
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (!hit) continue;
    if (!(el.contains(hit) || hit.contains(el))) continue;
    let name = (el.textContent || '').trim().replace(/\\s*\\d+$/, '').trim();
    if (name.startsWith('More')) name = 'More';
    if (name) names.add(name);
  }
  return [...names];
})()`;

/**
 * What a person must be able to get to from the shell, at any width.
 *
 * Not a style rule and not a layout rule: this is the product's own list of
 * where a person can go and what they can do to their own session, and a width
 * at which one of them is absent is a width at which the product is missing a
 * feature. §29's rule that a phone and a desktop are one product rather than
 * two, written as something a run can check.
 *
 * The six destinations, the two capabilities, the reader's depth, the old
 * console and the way out. Reached in one press or in two — through More is
 * still reached — which is why the probe opens the sheet before it answers.
 */
const MUST_REACH = [
  'Russell',
  'Work',
  'Ideas',
  'Knows',
  'Who',
  'Needs you',
  'Search',
  'Build',
  'Connected sites',
  'Normal',
  'Interested',
  'Technical',
  'Full console',
  'Sign out',
];

/**
 * Two constellation nodes painted on top of each other.
 *
 * `Constellation.tsx` places its nodes absolutely, so two that overlap are two
 * buttons where a person can press only one — and the covered label is not hard
 * to read, it is gone. This is the defect the header of this file names first,
 * and a rectangle intersection is the whole of it: these are siblings in one
 * stacking context, so an intersection *is* one covering the other.
 *
 * Measured rather than eyeballed, and reported as a count with the worst pairs,
 * because "the ring seats its labels" has to be a number before it is a claim.
 */
const CONSTELLATION = `(() => {
  const canvas = document.querySelector('.lim-canvas');
  const box = canvas ? canvas.getBoundingClientRect() : null;
  const nodes = [...document.querySelectorAll('.lim-node')];
  const pairs = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i].getBoundingClientRect();
      const b = nodes[j].getBoundingClientRect();
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > 1 && y > 1) {
        pairs.push({
          area: Math.round(x * y),
          what:
            (nodes[i].textContent || '').trim().slice(0, 22) +
            ' × ' +
            (nodes[j].textContent || '').trim().slice(0, 22),
        });
      }
    }
  }
  pairs.sort((left, right) => right.area - left.area);
  /*
   * The outline beside the picture, counted from the same screen.
   *
   * §29: every map carries a synchronized outline built in the same pass, and
   * the screen-reader path and the picture may never describe different graphs.
   * The diagram draws the nucleus and its children; the list beside it is the
   * children — so the two agree when there is exactly one more node than row,
   * and a layout change that dropped a node would show up here as a number
   * rather than as something somebody eventually noticed.
   */
  const lim = document.querySelector('.lim');
  const list = lim && lim.parentElement ? lim.parentElement.querySelector('ul.rs-list') : null;
  return {
    layout: canvas ? canvas.getAttribute('data-layout') || 'unmarked' : 'none',
    nodes: nodes.length,
    listed: list ? list.querySelectorAll(':scope > li').length : 0,
    overlaps: pairs.length,
    canvas: box ? Math.round(box.width) + '×' + Math.round(box.height) : 'none',
    worst: pairs.slice(0, 3).map((pair) => pair.what + ' (' + pair.area + 'px²)').join(' | '),
  };
})()`;

/* -------------------------------------------------------------------------
 * One phone, one person, one continuous journey.
 *
 * The three isolated interactions this replaced each opened their own address,
 * did one thing and stopped — which proves three controls and nothing about the
 * path between them. A person on a phone does not do that. They land on home,
 * open a thread, say something, go and look at the work, open the project, check
 * what needs them and come back, and every one of those transitions is a chance
 * for the shell to lose its layout, strand a control off the side, or leave
 * somebody somewhere with no way back.
 *
 * So this is one browser, one session and one scroll history. After the first
 * address nothing navigates: every move is a real press on a real control, and a
 * step whose control is not there returns false and is reported as a finding
 * rather than crashing the run.
 *
 * **The pending turn is the correct outcome, not a failure.** §24: no inference
 * is bought, so a Russell turn persists as `PENDING` carrying the server's own
 * reason and a worker answers it later. The journey reads that reason and moves
 * on; waiting for an answer would be waiting for a fleet this harness
 * deliberately does not have.
 * ---------------------------------------------------------------------- */

const PHONE = { width: 390, height: 844 } as const;

/**
 * The narrower phone §24 also names, re-read at the end.
 *
 * Only the thumb bar is asked about at 360: the bar is the one part of the
 * shell with a fixed number of cells and `overflow-x: hidden`, so it is the one
 * part where six labels either fit or are silently gone. Everything else
 * reflows.
 */
const NARROW_PHONE = 360;

/** What a person types. */
const SAID = 'Please check something for me, and tell me what you find.';

interface JourneyStep {
  /** Numbered, because the file names are the order somebody walked it. */
  name: string;
  /** What the image shows. Copied into the evidence index verbatim. */
  what: string;
  /**
   * What the person does, as an expression evaluated in the page. Returning
   * false means the control is not there at all — a finding about the product
   * rather than a crash in the harness.
   */
  act: string;
  /** Polled afterwards. False means the press landed on nothing. */
  until?: string;
  /** Read back after, so the evidence is a change rather than a press. */
  read?: string;
}

/** Press a thumb-bar cell by the label a person reads on it. */
function railPress(label: string): string {
  return `(() => {
    const item = [...document.querySelectorAll('.rs-rail-item')].find(
      (button) => (button.textContent || '').trim().startsWith(${JSON.stringify(label)}),
    );
    if (!item) return false;
    item.click();
    return true;
  })()`;
}

/** Everything up to the project, where the maps pass takes over. */
const JOURNEY_IN: JourneyStep[] = [
  {
    name: '01-home',
    what: 'Landing on Brain: the state sentence, the foundations strip, the docked command bar and the six-destination thumb bar.',
    act: 'true',
    until: "document.querySelector('.rs-shell') !== null",
    read: "document.querySelector('.rs-shell').getAttribute('data-nav')",
  },
  {
    name: '02-conversation',
    what: 'A conversation, opened by pressing it in the list on home rather than by navigating to its address.',
    act: `(() => {
      const thread = document.querySelector('.rs-thread');
      if (thread) { thread.click(); return 'opened the thread already there'; }
      const start = [...document.querySelectorAll('button')].find(
        (button) => /start a new one/i.test(button.textContent || ''),
      );
      if (!start) return false;
      start.click();
      return 'started a new thread';
    })()`,
    until: "location.pathname.startsWith('/conversation/')",
    read: 'location.pathname',
  },
  {
    name: '03-said-something',
    what: 'A message sent from the docked command bar, and the turn the server stored for it. Russell’s reply is PENDING with its own reason, which is §24 holding rather than a failure.',
    act: `(async () => {
      const box = document.getElementById('rs-command-input');
      if (!box) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(box, ${JSON.stringify(SAID)});
      box.dispatchEvent(new Event('input', { bubbles: true }));
      // React re-renders before the button stops being disabled, and pressing a
      // disabled button is a press that silently does nothing.
      await new Promise((resolve) => setTimeout(resolve, 600));
      const send = document.querySelector('.rs-command button[type=submit]');
      if (!send) return false;
      if (send.disabled) return 'the send button never enabled';
      send.click();
      return true;
    })()`,
    until: "document.querySelectorAll('.rs-turn').length >= 1",
    read: `(() => {
      const turns = [...document.querySelectorAll('.rs-turn')];
      const status = document.querySelector('.rs-turn-status');
      return turns.length + ' turn(s), Russell says: ' +
        (status ? status.textContent.trim().slice(0, 60) : 'nothing about its state');
    })()`,
  },
  {
    name: '04-work',
    what: 'Work, reached by pressing its cell in the thumb bar.',
    act: railPress('Work'),
    until: "location.pathname === '/work'",
    read: 'location.pathname',
  },
  {
    name: '05-project-map',
    what: 'The project on its Map tab: the constellation at 390px, which is where its nodes have room for their labels or do not.',
    act: railPress('Ideas'),
    until:
      "location.pathname === '/projects' && document.querySelector('.lim-canvas') !== null",
    read: `(() => {
      const canvas = document.querySelector('.lim-canvas');
      if (!canvas) return 'no constellation rendered';
      const box = canvas.getBoundingClientRect();
      return document.querySelectorAll('.lim-node').length + ' nodes on a ' +
        Math.round(box.width) + '×' + Math.round(box.height) + ' canvas';
    })()`,
  },
  {
    name: '06-project-maps',
    what: 'The Other maps tab, reached from the project’s own tab strip.',
    act: `(() => {
      const tab = [...document.querySelectorAll('ul[aria-label="This project"] button')].find(
        (button) => (button.textContent || '').trim() === 'Other maps',
      );
      if (!tab) return false;
      tab.click();
      return true;
    })()`,
    until: 'document.querySelector(\'ul[aria-label="Kind of map"]\') !== null',
    read: `String(document.querySelectorAll('ul[aria-label="Kind of map"] button').length) + ' kinds of map offered'`,
  },
];

/** The rest of the journey, after the maps pass has run inside the project. */
const JOURNEY_OUT: JourneyStep[] = [
  {
    name: '13-needs-you',
    what: 'Needs you, from the thumb bar: the decision surface §29 says must never be folded away.',
    act: railPress('Needs you'),
    until: "location.pathname === '/needs-you'",
    read: "document.body.innerText.replace(/\\s+/g, ' ').slice(0, 90)",
  },
  {
    name: '14-back-home',
    what: 'Back where the journey started, by pressing Russell in the thumb bar.',
    act: railPress('Russell'),
    until: "location.pathname === '/'",
    read: 'location.pathname',
  },
];

/** The six maps, by the label on their tab. */
const MAP_TABS = ['System', 'Workflow', 'Knowledge', 'Decisions', 'Timeline', 'Money flow'];

/* -------------------------------------------------------------------------
 * What this invocation was asked for.
 *
 * Two flags and a positional directory. `--renders` is where the **approval
 * set** goes — the four screens at the three widths, plus the declaration that
 * says what the set is — and it is separate from the throwaway output directory
 * because those images are the thing a person is asked to decide on rather than
 * a diagnostic. `--only=constellation` skips everything except the one
 * measurement, which is what makes a geometry change something you can iterate
 * on in ninety seconds rather than twenty minutes.
 * ---------------------------------------------------------------------- */

interface Options {
  outputDir: string;
  rendersDir: string | null;
  only: 'constellation' | null;
}

function parseOptions(argv: string[]): Options {
  let positional: string | null = null;
  let rendersDir: string | null = null;
  let only: 'constellation' | null = null;
  for (const argument of argv) {
    if (argument.startsWith('--renders=')) rendersDir = argument.slice('--renders='.length);
    else if (argument === '--renders') rendersDir = RENDERS_DEFAULT;
    else if (argument === '--only=constellation') only = 'constellation';
    else if (argument.startsWith('--')) throw new Error(`unknown option ${argument}`);
    else if (positional === null) positional = argument;
  }
  return {
    outputDir: path.resolve(positional ?? path.join(os.tmpdir(), 'brain-visual-qa')),
    rendersDir: rendersDir === null ? null : path.resolve(REPO_ROOT, rendersDir),
    only,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const { outputDir } = options;
  fs.mkdirSync(outputDir, { recursive: true });
  /*
   * The approval directory is emptied of images before it is refilled.
   *
   * `scripts/design-manifest.ts` refuses a `.png` that the declaration does not
   * name, and it is right to: an undeclared image would make the digest an
   * approval of a subset wearing the name of the whole set. A previous run's
   * leftover is exactly that, so it is removed here rather than discovered
   * there.
   */
  if (options.rendersDir) {
    fs.mkdirSync(options.rendersDir, { recursive: true });
    for (const entry of fs.readdirSync(options.rendersDir)) {
      if (entry.endsWith('.png') || entry === 'index.json') {
        fs.rmSync(path.join(options.rendersDir, entry));
      }
    }
  }
  const declared: Render[] = [];
  const captureFindings: string[] = [];
  const constellation: ({ width: number } & ConstellationReading)[] = [];

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

    /*
     * The one measurement, on its own, for when that is the whole question.
     *
     * A geometry change is iterated on by looking at a number, and the number
     * costs ninety seconds here against twenty minutes for the full walk. It
     * shares every line of the harness above it — the same build, the same real
     * server, the same real rows, the same predicate — because a second harness
     * that measured the same thing slightly differently is how two readings of
     * one canvas come to disagree.
     */
    if (options.only === 'constellation') {
      await withChromium(async (cdp) => {
        await signInBrowser(cdp, cookie);
        for (const width of CONSTELLATION_WIDTHS) {
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width,
            height: width < 600 ? 844 : 900,
            deviceScaleFactor: 1,
            mobile: width < 600,
          });
          await cdp.send('Page.navigate', { url: `${BASE}/projects` });
          await waitFor(cdp, "document.querySelector('.lim-canvas') !== null", 20_000);
          await sleep(1200);
          const reading = await constellationReading(cdp);
          console.log(describeConstellation(width, reading));
          constellation.push({ width, ...reading });
          if (reading.overlaps > 0) {
            captureFindings.push(
              `${reading.overlaps} constellation node pair(s) painted over each other at ` +
                `${width}px — ${reading.worst}`,
            );
          }
          const shot = (await cdp.send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
          })) as { data: string };
          fs.writeFileSync(
            path.join(outputDir, `constellation-${width}.png`),
            Buffer.from(shot.data, 'base64'),
          );
        }
      });
      reportConstellation(constellation);
      console.log(`\nImages in ${outputDir}`);
      if (captureFindings.length > 0) {
        console.log('');
        for (const finding of captureFindings) console.log(`  ${finding}`);
        process.exitCode = 1;
      }
      return;
    }

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
          const screen = HANDOFF_SCREENS[destination.name];
          if (screen && options.rendersDir) {
            declared.push(
              writeRender(options.rendersDir, screen, viewport.width, Buffer.from(shot.data, 'base64')),
            );
          }
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
          /*
           * The constellation, measured at every width rather than only on a
           * phone.
           *
           * It used to be asked once, at 390px, inside the journey — which is
           * where the pile-up was, and which is also why nobody knew whether the
           * ring seated its labels at 953px or only looked as though it did. A
           * reading taken at one width is a claim about that width.
           */
          if (destination.name === 'ideas') {
            const reading = await constellationReading(cdp);
            console.log(`    ${describeConstellation(viewport.width, reading)}`);
            constellation.push({ width: viewport.width, ...reading });
            if (reading.overlaps > 0) {
              captureFindings.push(
                `${viewport.name}: ${reading.overlaps} constellation node pair(s) painted over ` +
                  `each other at ${viewport.width}px — ${reading.worst}`,
              );
            }
          }
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

      /*
       * The second state of Needs You, produced rather than mocked.
       *
       * Everything above ran against a Brain with no standing grant, which is
       * why `/needs-you` above is the **populated** screen: an ungranted project
       * has exactly one decision outstanding and the page refuses to fold it.
       * Pressing that page's own Approve button settles it, and the same address
       * then becomes the settled, empty inbox. Two real states of one screen,
       * separated by one press on a real control — no request row is invented
       * and nothing is stubbed.
       *
       * It happens **after** every width has been captured, because there is one
       * database behind all three: granting between widths would leave the first
       * two showing a decision the third no longer had.
       */
      if (options.rendersDir) {
        const granted = await grantStandingAuthority(cdp);
        console.log(
          granted
            ? '  standing authority approved through the page’s own control'
            : '  COULD NOT APPROVE the standing authority — the empty inbox is not reachable',
        );
        if (!granted) {
          captureFindings.push(
            'needs-you-empty: the standing authority could not be approved, so the settled ' +
              'state of Needs You was never rendered',
          );
        }
        for (const viewport of VIEWPORTS) {
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: viewport.width,
            height: viewport.height,
            deviceScaleFactor: 2,
            mobile: viewport.width < 600,
          });
          await cdp.send('Page.navigate', { url: `${BASE}/needs-you` });
          await waitFor(cdp, "document.querySelector('.rs-shell') !== null");
          await waitFor(cdp, "document.querySelector('.rs-nothing') !== null", 15_000);
          await sleep(900);
          const shot = (await cdp.send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
          })) as { data: string };
          const bytes = Buffer.from(shot.data, 'base64');
          fs.writeFileSync(
            path.join(outputDir, `${viewport.name}-needs-you-settled.png`),
            bytes,
          );
          declared.push(
            writeRender(options.rendersDir, 'needs-you-empty', viewport.width, bytes),
          );
          const settled = await evaluate(
            cdp,
            "document.querySelector('.rs-nothing') !== null",
          );
          console.log(
            `${viewport.name.padEnd(8)} ${'needs-you-empty'.padEnd(10)} ` +
              `${settled === true ? 'settled' : 'STILL SHOWS A DECISION'}`,
          );
        }
      }
    });

    if (options.rendersDir) {
      writeDeclaration(options.rendersDir, declared);
      console.log(
        `\n${declared.length} render(s) declared in ${path.join(options.rendersDir, 'index.json')}`,
      );
    }

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

          const offenders = sideways ? String(await evaluate(cdp, OFFENDERS)) : '';

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
          const cutOff = String(await evaluate(cdp, CUT_OFF));

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
     * And that the path a person walks actually works.
     *
     * A screenshot proves a layout rendered. It cannot tell you whether the
     * control under the thumb does anything, and §29's own rule is that the
     * visual gate is not passed by tests alone. So this walks one continuous
     * journey at phone width — where the rail collapses and where a broken
     * control is most likely — and prints what changed at every step.
     */
    const findings = [...captureFindings, ...(await driveJourney(cookie, outputDir, constellation))];

    reportConstellation(constellation);

    console.log(`\nImages in ${outputDir}`);
    if (findings.length > 0) {
      console.log('');
      console.log(`${findings.length} finding(s):`);
      for (const finding of findings) console.log(`  ${finding}`);
      process.exitCode = 1;
    }
  } finally {
    await endServerTree(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------
 * The approval set: the images, and the declaration that says what they are.
 * ---------------------------------------------------------------------- */

/** One render, written under the name the declaration will give it. */
function writeRender(dir: string, screen: string, width: number, bytes: Buffer): Render {
  const file = `${screen}-${width}.png`;
  fs.writeFileSync(path.join(dir, file), bytes);
  return { screen, width, file };
}

/**
 * `index.json`, and why the set is declared rather than inferred.
 *
 * `scripts/design-manifest.ts` digests **what this file names**, so an approval
 * is bound to a set somebody stated rather than to whatever happened to be in a
 * directory when the digest ran. That cuts both ways, which is the point: a
 * declared file that is missing and an undeclared file that is present are both
 * refusals there, so this writes the declaration from the captures it actually
 * took and then refuses anything else in the directory itself — the same fact
 * found at the cheaper end.
 */
function writeDeclaration(dir: string, renders: Render[]): void {
  const named = new Set(renders.map((render) => render.file));
  const strays = fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith('.png') && !named.has(entry));
  if (strays.length > 0) {
    throw new Error(
      `${strays.length} image(s) in ${dir} that this run did not take: ${strays.join(', ')}. ` +
        'An undeclared image would make the digest an approval of a subset wearing the name ' +
        'of the whole set.',
    );
  }
  const ordered = [...renders].sort(
    (left, right) =>
      left.screen.localeCompare(right.screen) || right.width - left.width,
  );
  fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(ordered, null, 2)}\n`);
}

/* -------------------------------------------------------------------------
 * The constellation, measured.
 * ---------------------------------------------------------------------- */

/** The widths the constellation is asked about when it is the whole question. */
const CONSTELLATION_WIDTHS = [1180, 953, 390, 360];

interface ConstellationReading {
  layout: string;
  nodes: number;
  listed: number;
  overlaps: number;
  worst: string;
  canvas: string;
}

/** Read the canvas: which arrangement, how many nodes, how much overlap. */
async function constellationReading(cdp: Cdp): Promise<ConstellationReading> {
  return (await evaluate(cdp, CONSTELLATION)) as ConstellationReading;
}

/** One line about one canvas, in the words the report uses. */
function describeConstellation(width: number, reading: ConstellationReading): string {
  return (
    `constellation at ${width}px: ${reading.layout} — ${reading.nodes} node(s) on a ` +
    `${reading.canvas} canvas, ${reading.listed} listed beside it, ` +
    `${reading.overlaps} overlapping pair(s)` +
    (reading.worst ? ` — ${reading.worst}` : '')
  );
}

/**
 * Every reading together, because the claim being made is about a range.
 *
 * "It does not overlap on a phone" is four separate facts about four widths,
 * and printing them one at a time inside three different phases is how a run
 * ends with the evidence scattered through six hundred lines of log.
 */
function reportConstellation(readings: ({ width: number } & ConstellationReading)[]): void {
  if (readings.length === 0) return;
  console.log('');
  console.log('The constellation, at every width this run looked at:');
  for (const reading of [...readings].sort((left, right) => right.width - left.width)) {
    console.log(
      `  ${String(reading.width).padStart(4)}px  ${reading.layout.padEnd(6)}  ` +
        `${String(reading.nodes).padStart(2)} drawn / ${String(reading.listed).padStart(2)} listed  ` +
        `${reading.canvas.padEnd(9)}  ` +
        (reading.overlaps === 0
          ? 'no overlap'
          : `${reading.overlaps} OVERLAPPING PAIR(S) — ${reading.worst}`),
    );
  }
}

/**
 * Approve the standing authority, by pressing the page's own Approve button.
 *
 * Not a POST to the route: the question this answers is whether the settled
 * state of Needs You is *reachable from the screen*, and a request sent behind
 * the interface's back would render the settled page while proving nothing
 * about the control that is supposed to produce it. It presses what a person
 * presses, and reports false if that control is not there.
 */
async function grantStandingAuthority(cdp: Cdp): Promise<boolean> {
  await cdp.send('Page.navigate', { url: `${BASE}/needs-you` });
  await waitFor(cdp, "document.querySelector('.rs-authority') !== null", 20_000);
  await sleep(900);
  const pressed = await evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll('.rs-authority button')].find(
        (candidate) => (candidate.textContent || '').trim() === 'Approve',
      );
      if (!button) return false;
      if (button.disabled) return 'disabled';
      button.click();
      return true;
    })()`,
  );
  if (pressed !== true) return false;
  /*
   * Wait for the card to hold a grant, not for the page around it to say so.
   *
   * Its first version waited for `.rs-nothing` — the settled sentence — and
   * reported that the standing authority could not be approved while all three
   * later captures showed it plainly granted. **The press had worked and the
   * check was wrong**, which is the one kind of harness failure that costs more
   * than the defect it was looking for: a false finding is a finding somebody
   * spends an hour on.
   *
   * It was, though, pointing at something real — the page around the card did
   * not re-read, so answering the one decision on it changed nothing visible
   * until you navigated away and back. That is fixed in `Views.tsx`, and this
   * deliberately does **not** depend on the fix: it waits for the control the
   * card itself swaps in, so it would still pass against the build that had the
   * staleness and still fail if the grant genuinely did not land.
   */
  return waitFor(
    cdp,
    `[...document.querySelectorAll('.rs-authority button')].some(
      (button) => (button.textContent || '').trim() === 'Withdraw this',
    )`,
    20_000,
  );
}

/* -------------------------------------------------------------------------
 * The phone journey, and the maps inside it.
 * ---------------------------------------------------------------------- */

interface Reading {
  sideways: boolean;
  cutOff: string;
  offenders: string;
  unreachable: string;
}

/**
 * One capture and the readings that go with it, at whatever the screen now is.
 *
 * Every step takes exactly the same set, so a regression at step nine is never
 * something the harness happened not to look for there. The thumb bar and the
 * send button are asked about at *every* step rather than once, because they are
 * on every screen and a layout that strands them does it on one screen at a
 * time.
 */
async function capture(cdp: Cdp, outputDir: string, file: string): Promise<Reading> {
  const shot = (await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  })) as { data: string };
  fs.writeFileSync(path.join(outputDir, file), Buffer.from(shot.data, 'base64'));
  const sideways = (await evaluate(cdp, SIDEWAYS)) as boolean;
  return {
    sideways,
    cutOff: String(await evaluate(cdp, CUT_OFF)),
    offenders: sideways ? String(await evaluate(cdp, OFFENDERS)) : '',
    unreachable: String(
      await evaluate(cdp, unreachable('.rs-rail-item, .rs-command button[type=submit]')),
    ),
  };
}

/** Turn a reading into findings, in the words a person would use about them. */
function judge(step: string, reading: Reading): string[] {
  const found: string[] = [];
  if (reading.sideways) {
    found.push(`${step}: the page scrolls sideways at ${PHONE.width}px — ${reading.offenders}`);
  }
  if (reading.cutOff) {
    found.push(`${step}: cut off inside a container that clips — ${reading.cutOff}`);
  }
  if (reading.unreachable) {
    found.push(`${step}: a control a thumb cannot land on — ${reading.unreachable}`);
  }
  return found;
}

/**
 * Walk a list of steps, pressing rather than navigating.
 *
 * A step whose control is missing is recorded and the walk continues: the steps
 * after it are the ones nobody has looked at, and losing them to the first
 * finding would be losing the evidence to the diagnostic — the same reasoning
 * the band sweep already applies to a timed-out width.
 */
async function walk(
  cdp: Cdp,
  outputDir: string,
  steps: JourneyStep[],
  probes: Record<string, (cdp: Cdp) => Promise<string[]>> = {},
): Promise<string[]> {
  const findings: string[] = [];
  for (const step of steps) {
    const acted = await evaluate(cdp, step.act);
    if (acted === false) {
      findings.push(`${step.name}: the control a person would press is not on the screen`);
      console.log(`  ${step.name.padEnd(18)} NO CONTROL FOUND`);
      continue;
    }
    const landed = step.until ? await waitFor(cdp, step.until) : true;
    if (!landed) {
      findings.push(`${step.name}: pressed, and the screen never arrived — ${String(step.until)}`);
    }
    // The shell renders its own state as soon as it has an answer; this is for
    // what comes after that — a measured canvas, a re-read thread, a fetch.
    await sleep(1200);

    const reading = await capture(cdp, outputDir, `journey-${step.name}.png`);
    findings.push(...judge(step.name, reading));
    const read = step.read ? String(await evaluate(cdp, step.read)) : '';
    console.log(
      `  ${step.name.padEnd(18)} ${landed ? 'arrived' : 'NEVER ARRIVED'}  ` +
        `${reading.sideways ? 'SCROLLS SIDEWAYS' : 'fits'}  ` +
        `${typeof acted === 'string' ? `[${acted}] ` : ''}${read.slice(0, 80)}`,
    );

    const probe = probes[step.name];
    if (probe) findings.push(...(await probe(cdp)));
  }
  return findings;
}

/** The constellation, measured for nodes painted over each other. */
function constellationProbe(
  collected: ({ width: number } & ConstellationReading)[],
): (cdp: Cdp) => Promise<string[]> {
  return async (cdp) => {
    const reading = await constellationReading(cdp);
    console.log(`    ${describeConstellation(PHONE.width, reading)}`);
    collected.push({ width: PHONE.width, ...reading });
    const found: string[] = [];
    if (reading.overlaps > 0) {
      found.push(
        `05-project-map: ${reading.overlaps} constellation node pair(s) painted over each other ` +
          `at ${PHONE.width}px — ${reading.worst}`,
      );
    }
    /*
     * The picture and the outline, held against each other rather than each
     * checked against nothing. `mapsPass` already does this for the six
     * specialized maps; the constellation had no such reading at all, so a
     * change that lost a node would have been invisible to everything except a
     * person counting circles in a screenshot.
     */
    if (reading.nodes > 0 && reading.nodes - 1 !== reading.listed) {
      found.push(
        `05-project-map: the constellation and its list are different graphs — ` +
          `${reading.nodes - 1} node(s) around the nucleus against ${reading.listed} listed`,
      );
    }
    return found;
  };
}

/**
 * The same canvas at the narrower phone §24 names, reached by pressing.
 *
 * 390 is not a proof about 360: the canvas is thirty pixels narrower there, and
 * thirty pixels is the difference between a label wrapping to two lines and to
 * three. It is a press on the thumb bar rather than a navigation, because that
 * is the rule the whole journey runs under.
 */
async function narrowConstellation(
  cdp: Cdp,
  outputDir: string,
  collected: ({ width: number } & ConstellationReading)[],
): Promise<string[]> {
  const pressed = await evaluate(cdp, railPress('Ideas'));
  if (pressed !== true) {
    return [`18-constellation-${NARROW_PHONE}: there is no Ideas cell to press at this width`];
  }
  const arrived = await waitFor(cdp, "document.querySelector('.lim-canvas') !== null", 20_000);
  await sleep(1200);
  const capture0 = await capture(
    cdp,
    outputDir,
    `journey-18-constellation-${NARROW_PHONE}.png`,
  );
  const found = judge(`18-constellation-${NARROW_PHONE}`, capture0);
  if (!arrived) {
    found.push(`18-constellation-${NARROW_PHONE}: the map never rendered at this width`);
    return found;
  }
  const reading = await constellationReading(cdp);
  console.log(`  ${describeConstellation(NARROW_PHONE, reading)}`);
  collected.push({ width: NARROW_PHONE, ...reading });
  if (reading.overlaps > 0) {
    found.push(
      `18-constellation-${NARROW_PHONE}: ${reading.overlaps} constellation node pair(s) ` +
        `painted over each other at ${NARROW_PHONE}px — ${reading.worst}`,
    );
  }
  if (reading.nodes > 0 && reading.nodes - 1 !== reading.listed) {
    found.push(
      `18-constellation-${NARROW_PHONE}: the constellation and its list are different graphs — ` +
        `${reading.nodes - 1} node(s) around the nucleus against ${reading.listed} listed`,
    );
  }
  return found;
}

/**
 * The six maps, at phone width, each with the outline §29 requires beside it.
 *
 * Two things are asked of every one of them and they are different questions.
 * **The picture and the list must be the same graph** — the outline comes from
 * the server in the same pass as the nodes, so a diagram with more or fewer
 * things in it than its own list is two derivations that can disagree, which is
 * exactly what the one-pass rule exists to prevent. And **an empty map must say
 * why**, because a blank canvas with no sentence cannot be told from one that
 * failed to load.
 *
 * The money-flow map is the one that is usually empty here, and the assertion on
 * it is the strong one: nothing drawn, no connections claimed, and a reason in
 * words. Inventing edges to finish a diagram is an invented citation one
 * altitude down.
 */
async function mapsPass(cdp: Cdp, outputDir: string): Promise<string[]> {
  const findings: string[] = [];
  console.log('  the six maps, at phone width:');
  let ordinal = 7;
  for (const label of MAP_TABS) {
    const file =
      `journey-${String(ordinal).padStart(2, '0')}-map-` +
      `${label.toLowerCase().replace(/\s+/g, '-')}.png`;
    ordinal += 1;

    const pressed = await evaluate(
      cdp,
      `(() => {
        const tab = [...document.querySelectorAll('ul[aria-label="Kind of map"] button')].find(
          (button) => (button.textContent || '').trim() === ${JSON.stringify(label)},
        );
        if (!tab) return false;
        tab.click();
        return true;
      })()`,
    );
    if (pressed !== true) {
      findings.push(`maps: there is no tab for the "${label}" map to press`);
      console.log(`    ${label.padEnd(11)} NO TAB`);
      continue;
    }

    const selected = await waitFor(
      cdp,
      `(() => {
        const on = document.querySelector('ul[aria-label="Kind of map"] button[aria-selected=true]');
        return !!on && (on.textContent || '').trim() === ${JSON.stringify(label)};
      })()`,
    );
    if (!selected) findings.push(`maps: pressing "${label}" did not select it`);
    // Each type is its own request, so this waits for the reading to stop being
    // a loading sentence rather than for a fixed delay.
    await waitFor(cdp, "document.querySelector('.rs-state-loading') === null", 20_000);
    await sleep(600);

    const reading = (await evaluate(
      cdp,
      `(() => {
        const tabs = document.querySelector('ul[aria-label="Kind of map"]');
        const root = tabs ? tabs.closest('.rs-column') : null;
        if (!root) return null;
        const list = root.querySelector('ul[aria-label="The same map as a list"]');
        const counts = root.querySelector('.rs-row .rs-hint');
        const empty = root.querySelector('.rs-state-empty');
        const lede = root.querySelector('.rs-lede');
        return {
          question: lede ? lede.textContent.trim() : '',
          counts: counts ? counts.textContent.trim() : '',
          drawn: root.querySelectorAll('.rs-map-node').length,
          outline: list ? list.querySelectorAll(':scope > li').length : 0,
          outlineInDocument: list !== null,
          emptyReason: empty ? empty.textContent.trim() : '',
        };
      })()`,
    )) as {
      question: string;
      counts: string;
      drawn: number;
      outline: number;
      outlineInDocument: boolean;
      emptyReason: string;
    } | null;

    const capture0 = await capture(cdp, outputDir, file);
    findings.push(...judge(`map:${label}`, capture0));

    if (!reading) {
      findings.push(`maps: the "${label}" map rendered nothing this could read`);
      console.log(`    ${label.padEnd(11)} NOTHING RENDERED`);
      continue;
    }

    if (reading.drawn > 0 && !reading.outlineInDocument) {
      findings.push(`maps: the "${label}" map draws ${reading.drawn} things and carries no outline`);
    }
    if (reading.drawn > 0 && reading.outline !== reading.drawn) {
      findings.push(
        `maps: the "${label}" diagram and its outline are different graphs — ` +
          `${reading.drawn} drawn against ${reading.outline} listed`,
      );
    }
    if (reading.drawn === 0 && !reading.emptyReason) {
      findings.push(`maps: the "${label}" map is empty and does not say why`);
    }
    if (label === 'Money flow' && reading.drawn === 0) {
      if (!/0 connections/.test(reading.counts)) {
        findings.push(
          `maps: the empty money-flow map claims connections it cannot have — ${reading.counts}`,
        );
      }
      if (!reading.emptyReason) {
        findings.push('maps: the money-flow map is empty and states no reason');
      }
    }

    console.log(
      `    ${label.padEnd(11)} ${String(reading.drawn).padStart(2)} drawn / ` +
        `${String(reading.outline).padStart(2)} listed  ` +
        `${capture0.sideways ? 'SCROLLS SIDEWAYS' : 'fits'}  ` +
        `${reading.emptyReason ? `empty: ${reading.emptyReason.slice(0, 64)}` : reading.question.slice(0, 64)}`,
    );
  }

  /*
   * And that the outline is a control a person can actually reach, not only a
   * node in the document. The toggle is the whole accessible path: if it does
   * not switch, the list §29 calls an equal is unreachable at phone width.
   *
   * Asked of a map that has something to list. The first version asked it of
   * whichever map the loop above happened to leave selected, which was the
   * money-flow one — empty by design here — so the outline was correctly absent
   * and the harness reported a defect in itself. A probe whose subject is
   * whatever is left over is a probe that will eventually say something untrue.
   */
  await evaluate(
    cdp,
    `(() => {
      const tab = [...document.querySelectorAll('ul[aria-label="Kind of map"] button')].find(
        (button) => (button.textContent || '').trim() === 'System',
      );
      if (tab) tab.click();
      return true;
    })()`,
  );
  await waitFor(cdp, "document.querySelectorAll('.rs-map-node').length > 0", 20_000);
  await sleep(500);

  const toggled = await evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll('button')].find(
        (candidate) => /show it as a list/i.test(candidate.textContent || ''),
      );
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  if (toggled !== true) {
    findings.push('maps: there is no control to show a map as its list');
  } else {
    await sleep(700);
    const shown = await evaluate(
      cdp,
      `(() => {
        const list = document.querySelector('ul[aria-label="The same map as a list"]');
        if (!list) return 'no outline in the document';
        const holder = list.parentElement;
        return holder && !holder.hasAttribute('hidden') ? true : 'the outline stayed hidden';
      })()`,
    );
    if (shown !== true) findings.push(`maps: pressing the list control left ${String(shown)}`);
    const reading = await capture(cdp, outputDir, 'journey-12b-map-as-a-list.png');
    findings.push(...judge('map:outline', reading));
    console.log(`    outline      ${shown === true ? 'shown' : String(shown)}`);
  }
  return findings;
}

/**
 * Everywhere a person can go from here, counted rather than assumed.
 *
 * The sheet is opened, because "reached in two presses through More" is still
 * reached — that is what More is for. What is *not* reached is a control that is
 * in the markup at a width where nothing renders it and nothing else offers what
 * it does, and at 390px that was Search, the depth control, Build, Connected
 * sites, the full console and Sign out: six things, including the way out of
 * your own session, with no path to them on a phone at all.
 *
 * It captures the open sheet, because a list of names is a reading and the
 * picture is what a person approves.
 */
async function reachabilityProbe(
  cdp: Cdp,
  outputDir: string,
  file: string,
  width: number,
): Promise<string[]> {
  const closed = (await evaluate(cdp, REACHABLE)) as string[];
  const opened = await evaluate(
    cdp,
    `(() => {
      const more = document.querySelector('.rs-more > button');
      if (!more) return false;
      if (more.getAttribute('aria-expanded') === 'true') return true;
      more.click();
      return true;
    })()`,
  );
  if (opened === true) await sleep(500);
  const withSheet = opened === true ? ((await evaluate(cdp, REACHABLE)) as string[]) : [];
  const reachable = new Set([...closed, ...withSheet]);
  const reading = await capture(cdp, outputDir, file);

  const missing = MUST_REACH.filter((name) => !reachable.has(name));
  console.log(
    `  reachable at ${width}px (${opened === true ? 'sheet opened' : 'NO MORE CONTROL'}): ` +
      `${[...reachable].join(' · ')}`,
  );
  /*
   * The sheet is open in this capture, so the covered-control clause is not
   * asked of it.
   *
   * It flagged `Send: covered by Sign out`, which is a popup doing exactly what
   * a popup does — and a harness that calls that a defect teaches a reader to
   * skim its findings, which is the one thing a findings list must not do. The
   * question this capture exists for is whether the *sheet's own* items can be
   * pressed, and `REACHABLE` is what answers it. Every other step of the
   * journey takes the covered-control reading with nothing open, so nothing is
   * lost.
   */
  const findings = judge(`reachable-${width}`, {
    ...reading,
    unreachable: '',
  });
  if (opened !== true) {
    findings.push(`reachable-${width}: there is no More control to open at this width`);
  }
  if (missing.length > 0) {
    findings.push(
      `reachable-${width}: a person cannot get to ${missing.join(', ')} at ${width}px — ` +
        'not in the bar, and not in the More sheet',
    );
  }
  // Put it back, so the step after this is photographed as a person left it.
  if (opened === true) {
    await evaluate(
      cdp,
      `(() => {
        const more = document.querySelector('.rs-more > button');
        if (more && more.getAttribute('aria-expanded') === 'true') more.click();
        return true;
      })()`,
    );
    await sleep(300);
  }
  return findings;
}

/**
 * The thumb bar at the narrower phone §24 names.
 *
 * Asked separately and asked only of the bar, because the bar is the one part of
 * this shell with a fixed number of cells and `overflow-x: hidden` — so it is
 * the one part where a label that no longer fits is not smaller, it is gone.
 * Everything else on the screen reflows and is covered by the journey above.
 */
async function narrowPhoneBar(cdp: Cdp, outputDir: string): Promise<string[]> {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: NARROW_PHONE,
    height: PHONE.height,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await sleep(900);
  const reading = await capture(cdp, outputDir, `journey-16-thumb-bar-${NARROW_PHONE}.png`);
  /*
   * The cells that are actually on the bar, not every rail item in the markup.
   *
   * Its first version printed `.rs-rail-item` outright, which includes the two
   * secondary destinations the phone deliberately moves into the sheet — so the
   * log read as though Build and Connected sites were cells of a 360px thumb
   * bar. A line of evidence that names something not on the screen is a line
   * somebody will quote.
   */
  const labels = String(
    await evaluate(
      cdp,
      `[...document.querySelectorAll('.rs-rail-item, .rs-more > button')]
        .filter((item) => {
          const box = item.getBoundingClientRect();
          return box.width >= 1 && box.height >= 1;
        })
        .map((item) => (item.textContent || '').trim())
        .join(' · ')`,
    ),
  );
  console.log(`  thumb bar at ${NARROW_PHONE}px: ${labels}`);
  return judge(`16-thumb-bar-${NARROW_PHONE}`, reading);
}

/** One browser, one signed-in person, one path through the product. */
async function driveJourney(
  cookie: string,
  outputDir: string,
  constellation: ({ width: number } & ConstellationReading)[],
): Promise<string[]> {
  const findings: string[] = [];
  console.log('');
  console.log(
    `One journey on a ${PHONE.width}×${PHONE.height} phone, pressing real controls:`,
  );
  await withChromium(async (cdp) => {
    await signInBrowser(cdp, cookie);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: PHONE.width,
      height: PHONE.height,
      deviceScaleFactor: 1,
      mobile: true,
    });
    // The only navigation in the whole journey. Everything after this is a press.
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    findings.push(
      ...(await walk(cdp, outputDir, JOURNEY_IN, {
        '05-project-map': constellationProbe(constellation),
      })),
    );
    findings.push(...(await mapsPass(cdp, outputDir)));
    findings.push(...(await walk(cdp, outputDir, JOURNEY_OUT)));
    findings.push(
      ...(await reachabilityProbe(
        cdp,
        outputDir,
        `journey-15-everywhere-from-${PHONE.width}.png`,
        PHONE.width,
      )),
    );
    findings.push(...(await narrowPhoneBar(cdp, outputDir)));
    findings.push(
      ...(await reachabilityProbe(
        cdp,
        outputDir,
        `journey-17-everywhere-from-${NARROW_PHONE}.png`,
        NARROW_PHONE,
      )),
    );
    findings.push(...(await narrowConstellation(cdp, outputDir, constellation)));
  });
  return findings;
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
    await serveWebFonts(cdp);
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

/* -------------------------------------------------------------------------
 * The product's own typefaces, fetched the way this machine can fetch them.
 *
 * `client/index.html` links the Google Fonts stylesheet, and Chromium here is
 * launched with no proxy, so every page load reset that request and the whole
 * product rendered on its fallback stack: Georgia where Fraunces should be,
 * system-ui where Public Sans should be. The harness reported it correctly as
 * an environment fact and carried on — which is right for a layout check and
 * wrong for the thing these captures are now for.
 *
 * **A render in the wrong typefaces is a picture of a different product**, and
 * a person asked to approve a visual direction from one is being asked about
 * something that does not exist. Type is not a detail here: it sets every line
 * height, every label width and therefore where a name wraps, which is the
 * measurement this run exists to take.
 *
 * So the two font hosts are intercepted and answered from Node, whose fetch
 * goes through this machine's outbound proxy. Nothing about the page changes —
 * the same URLs, the same bytes, the same stylesheet — and nothing about the
 * browser's trust is loosened, which is the reason this is interception rather
 * than `--ignore-certificate-errors`: a harness that disables certificate
 * checking to get a picture is a pattern somebody copies into something that
 * matters. A font that genuinely cannot be fetched still fails, and the page
 * still falls back, because pretending otherwise would be the same lie one step
 * along.
 * ---------------------------------------------------------------------- */

const FONT_HOSTS = ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'];

/** One process-wide cache: the same six files on every page of every width. */
const fontCache = new Map<string, { type: string; body: string } | null>();

async function fetchFont(url: string): Promise<{ type: string; body: string } | null> {
  const cached = fontCache.get(url);
  if (cached !== undefined) return cached;
  let answer: { type: string; body: string } | null = null;
  try {
    const response = await fetch(url, {
      // Google serves woff2 to a browser and truetype to something it does not
      // recognise, so the stylesheet this returns has to be the one Chromium
      // would have been given.
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0.0.0 Safari/537.36' },
    });
    if (response.ok) {
      answer = {
        type: response.headers.get('content-type') ?? 'application/octet-stream',
        body: Buffer.from(await response.arrayBuffer()).toString('base64'),
      };
    }
  } catch {
    answer = null;
  }
  fontCache.set(url, answer);
  return answer;
}

async function serveWebFonts(cdp: Cdp): Promise<void> {
  cdp.on('Fetch.requestPaused', (params) => {
    const requestId = String(params['requestId']);
    const request = params['request'] as { url?: string } | undefined;
    void (async (): Promise<void> => {
      const answer = request?.url ? await fetchFont(request.url) : null;
      try {
        if (answer) {
          await cdp.send('Fetch.fulfillRequest', {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: 'content-type', value: answer.type },
              { name: 'access-control-allow-origin', value: '*' },
            ],
            body: answer.body,
          });
        } else {
          await cdp.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' });
        }
      } catch {
        /* the page navigated away from the request; nothing to answer */
      }
    })();
  });
  await cdp.send('Fetch.enable', {
    patterns: FONT_HOSTS.map((urlPattern) => ({ urlPattern })),
  });
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

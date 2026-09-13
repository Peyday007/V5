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
/**
 * One software change waiting for a person, so Needs You has a card to show.
 *
 * **A seeded row, and it says so.** Everything else this harness photographs is
 * whatever an ordinary boot produces, which is the right default — a screenshot
 * of a fixture is a screenshot of a fixture. This one row is the exception,
 * because the card it renders is the one control in the new path a person
 * actually presses, and the only other way to produce it is a worker turn
 * against a fleet this harness deliberately does not have.
 *
 * It is written the way the product writes it, through `captureSoftwareChange`,
 * so the row is a real one rather than a hand-built shape that might not be
 * reachable. Nothing here authorizes anything: the request is `PROPOSED`, which
 * is the only state a capture can produce, and it stays that way unless somebody
 * presses the button in the image.
 *
 * A second writer against the same SQLite file is safe because the adapter opens
 * it in WAL. It writes into the throwaway data directory this run created and
 * touches nothing else.
 */
async function seedSoftwareDecision(dataDir: string): Promise<void> {
  const script = `
    process.env.BRAIN_DATA_DIR = ${JSON.stringify(dataDir)};
    const { initDatabase, closeDatabase } = await import('./server/db/database.ts');
    const { listProjects } = await import('./server/repos/projects.ts');
    const { createConversation } = await import('./server/repos/russellConversations.ts');
    const { captureSoftwareChange } = await import('./server/services/russell/software.ts');
    const { listUsers } = await import('./server/repos/identity.ts');
    const { onboardRepository } = await import('./server/services/factory/onboard.ts');
    const { listRepositoryGrants } = await import('./server/services/factory/repositoryEnvelope.ts');
    await initDatabase();
    const project = (await listProjects())[0];
    const person = (await listUsers())[0];
    if (project && person) {
      /*
       * The repository the project may change, with a directory boundary on it.
       *
       * Without this the card is correct and shows the *other* branch — "this
       * project has not been given a repository yet" — which is worth having and
       * is not the control. Onboarding one photographs the reach sentence and the
       * Authorize button, which are the two things a person actually reads before
       * saying yes. It is the envelope's own grant, so nothing is widened.
       */
      const grant = listRepositoryGrants()[0];
      if (grant) {
        await onboardRepository({
          projectId: project.id,
          grantId: grant.id,
          scope: { kind: 'DIRECTORIES', directories: ['docs'] },
          actor: person,
          origin: 'https://brain.example',
        });
      }
      const conversation = await createConversation({
        ownerUserId: person.id,
        title: 'The checkout total',
        visibility: 'SHARED',
        projectId: project.id,
      });
      await captureSoftwareChange({
        projectId: project.id,
        conversationId: conversation.id,
        messageId: null,
        askedText: 'Please change the checkout page so the total updates without a reload.',
        title: 'Live total on checkout',
        objective: 'Change the checkout page so the total updates without a reload.',
        expectedOutcome: 'Changing the quantity updates the total in place.',
      });
    }
    await closeDatabase();
  `;
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, BRAIN_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let noise = '';
    child.stdout.on('data', (chunk: Buffer) => (noise += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (noise += chunk.toString()));
    child.on('exit', (code) => {
      // A seed that did not land is a finding about this harness rather than
      // about the product, so it is said and the run continues: the other
      // eighteen captures are still worth having.
      if (code !== 0) process.stdout.write(`  seed did not land (exit ${code}): ${noise.slice(-400)}\n`);
      resolve();
    });
  });
}

const DESTINATIONS = [
  { name: 'russell', path: '/' },
  { name: 'work', path: '/work' },
  { name: 'ideas', path: '/projects' },
  { name: 'knows', path: '/knowledge' },
  { name: 'who', path: '/fleet' },
  { name: 'needs-you', path: '/needs-you' },
  /*
   * Build was never captured, and it is where two decisions a person makes now
   * live: the repository boundary — a question with no default, so the card is
   * wrong if either radio starts selected or the button is not disabled — and
   * the objective form. It sits behind the More menu rather than on the rail,
   * which is exactly the kind of place a layout defect survives, and §29
   * records one that did.
   */
  { name: 'build', path: '/build' },
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
const OVERLAPPING_NODES = `(() => {
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
  return {
    nodes: nodes.length,
    overlaps: pairs.length,
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
    await seedSoftwareDecision(dataDir);

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
          /*
           * A capture that came back empty is a finding, not a crash.
           *
           * `captureBeyondViewport` renders the whole scroll height, and
           * Chromium occasionally answers a tall page with no `data` at all.
           * Passing that straight to `Buffer.from` threw `ERR_INVALID_ARG_TYPE`
           * from inside the loop and ended the run — after fifteen captures had
           * already been taken and before any of them was reported. **A harness
           * that discards fifteen good readings because the sixteenth hiccuped
           * is worse than one that says which one it missed**, and it is the
           * same rule the journey already follows for a control that is not
           * there. One retry, because the failure is transient; then it is
           * named and the sweep carries on.
           */
          const file = path.join(outputDir, `${viewport.name}-${destination.name}.png`);
          let captured = false;
          for (let attempt = 0; attempt < 2 && !captured; attempt += 1) {
            if (attempt > 0) await sleep(600);
            const shot = (await cdp.send('Page.captureScreenshot', {
              format: 'png',
              captureBeyondViewport: true,
            })) as { data?: string };
            if (typeof shot.data === 'string' && shot.data.length > 0) {
              fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
              captured = true;
            }
          }
          if (!captured) problems.push(`no image came back for ${destination.name}`);
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
    const findings = await driveJourney(cookie, outputDir);

    console.log(`\nImages in ${outputDir}`);
    if (findings.length > 0) {
      console.log('');
      console.log(`${findings.length} finding(s) from the phone journey:`);
      for (const finding of findings) console.log(`  ${finding}`);
      process.exitCode = 1;
    }
  } finally {
    await endServerTree(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
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
async function constellationProbe(cdp: Cdp): Promise<string[]> {
  const reading = (await evaluate(cdp, OVERLAPPING_NODES)) as {
    nodes: number;
    overlaps: number;
    worst: string;
  };
  console.log(
    `    constellation: ${reading.nodes} nodes, ${reading.overlaps} overlapping pair(s)` +
      (reading.worst ? ` — ${reading.worst}` : ''),
  );
  return reading.overlaps > 0
    ? [
        `05-project-map: ${reading.overlaps} constellation node pair(s) painted over each other ` +
          `at ${PHONE.width}px — ${reading.worst}`,
      ]
    : [];
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
async function driveJourney(cookie: string, outputDir: string): Promise<string[]> {
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
      ...(await walk(cdp, outputDir, JOURNEY_IN, { '05-project-map': constellationProbe })),
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

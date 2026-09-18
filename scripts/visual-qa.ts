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
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pickPort } from '../tests/helpers/ports.ts';
import type { DeployedPhoneRecord } from './phoneRecord.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/*
 * Through the same helper every suite uses, and for the same reason.
 *
 * `6400 + random(200)` reaches 6566, which is on the WHATWG bad-port list —
 * Node's `fetch` refuses it before it opens a socket, so the server would boot,
 * answer nothing this harness could see, and the run would report the product
 * broken. That is the defect the test suites were just corrected for; a second
 * copy of it in the harness that photographs the product would be the "a rule
 * applied by one of two readers is worse than none" this file keeps recording.
 */
const PORT = pickPort(6400, 200);

/**
 * The Brain this harness is driving.
 *
 * A local one it spawned, almost always — and in `--deployed` mode, the one
 * that is actually running. It is a `let` for exactly that one case and is
 * assigned once, before anything opens a browser or a socket. Every helper
 * below reads it rather than rebuilding a URL, so there is one answer to
 * "which Brain is this" rather than two that can disagree.
 */
let BASE = `http://127.0.0.1:${PORT}`;
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
  /**
   * How long to poll `until`, when the default is not enough.
   *
   * Fifteen seconds is right for a press that renders. It is wrong for a step
   * whose answer is a re-read after a write, where the shell has to go back to
   * the server — so the few steps that wait on a row rather than on a paint say
   * so here rather than making every step slow.
   */
  patience?: number;
  /** Read back after, so the evidence is a change rather than a press. */
  read?: string;
}

/**
 * One whitespace rule, applied to both sides of every on-screen comparison.
 *
 * A stored statement and the paragraph rendering it are the *same words* and
 * routinely not the same bytes: a newline becomes a space, two spaces become
 * one, and the browser's own `innerText` introduces non-breaking spaces and
 * narrow no-break spaces around punctuation. The first version collapsed only
 * the page and compared it against a raw needle, so any statement carrying a
 * line break could never be found however plainly it was displayed — and the
 * reading said "not on screen" about something on the screen, which sends
 * somebody looking for a defect that is not there.
 *
 * Kept as one expression and one function so the two can never drift: the
 * string below is what runs in the page, and `normalizeText` is the identical
 * rule applied here to the needle.
 */
const NORMALIZED_PAGE_TEXT =
  "document.body.innerText.replace(/[\\u00a0\\u202f\\u2007]/g, ' ').replace(/\\s+/g, ' ').trim()";

function normalizeText(value: string): string {
  return value.replace(/[\u00a0\u202f\u2007]/g, ' ').replace(/\s+/g, ' ').trim();
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

/**
 * The half of the journey where a person changes something.
 *
 * Everything before this demonstrates that the product can be *reached* on a
 * phone — every screen arrived at by pressing, nothing clipped, no control a
 * thumb cannot land on. That is necessary and it is not J: a person does not
 * use Brain to look at Brain. These steps do the work, and each one's effect is
 * read back out of the database afterwards, because a screen that says
 * something changed and a row that changed are different facts.
 *
 * The idea they act on was put there by a connected site asking for research
 * through §25's own command — not written into a table, and not typed by the
 * harness pretending to be a worker.
 */
const JOURNEY_WORK: JourneyStep[] = [
  {
    name: '15-ideas',
    what: 'Ideas, reached from the thumb bar: the backlog with the site’s request in it, carrying the priority Russell formed and the reason it will be asked for.',
    act: railPress('Ideas'),
    until: "location.pathname === '/projects'",
    read: `(() => {
      const nodes = [...document.querySelectorAll('.lim-node')];
      const named = nodes.map((n) => (n.textContent || '').trim()).filter(Boolean);
      return nodes.length + ' node(s): ' + named.slice(0, 4).join(' · ');
    })()`,
  },
  {
    name: '16-open-the-idea',
    what: 'The idea a site asked about, opened. Russell’s own judgment is on it — the priority, and the sentence behind it.',
    /*
     * The **list** entry, not the constellation node.
     *
     * `IdeaDecision` renders from `focused`, which `select(node.id)` sets from
     * a `.rs-node` button in the list beneath the map. Pressing the matching
     * `.lim-node` on the map opened nothing, and the step reported "pressed,
     * and the screen never arrived" — accurate about the screen and wrong
     * about which control produces it. The map is the front door; the list is
     * where an idea is chosen.
     */
    act: `(() => {
      const node = [...document.querySelectorAll('.rs-node')]
        .find((el) => (el.textContent || '').includes('recording takes'));
      if (!node) return false;
      node.scrollIntoView({ block: 'center' });
      node.click();
      return 'opened ' + (node.textContent || '').trim().slice(0, 40);
    })()`,
    until: "document.querySelector('.rs-choices') !== null",
    read: `(() => {
      const pressed = [...document.querySelectorAll('.rs-choices button[aria-pressed=true]')];
      return pressed.length > 0
        ? 'Russell says ' + pressed.map((b) => (b.textContent || '').trim()).join(', ')
        : 'no priority is shown';
    })()`,
  },
  {
    name: '17-changed-the-priority',
    what: 'A person disagreeing with Russell: a different priority chosen, a reason typed, and the decision saved. §24’s override — the thing that makes Russell’s judgment a proposal rather than a verdict.',
    act: `(async () => {
      const choices = [...document.querySelectorAll('.rs-choices button')];
      const mustDo = choices.find((b) => /must do/i.test(b.textContent || ''));
      if (!mustDo) return false;
      mustDo.click();
      // The reason field is an <input>, and it is the one the label points at.
      // Querying for a textarea found nothing, so nothing was typed, so the
      // save button stayed correctly disabled and the step reported "the save
      // button never enabled" — accurate about the button and wrong about why.
      const reason = document.querySelector('#rs-decision-reason');
      if (!reason) return false;
      // React reads the value through its own descriptor, so assigning .value
      // directly changes the DOM and not the component. The native setter plus
      // a bubbling input event is what a keystroke actually looks like.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(reason, 'The site is waiting on this one, so it goes first.');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const save = [...document.querySelectorAll('button')].find(
        (b) => /set this priority/i.test(b.textContent || ''),
      );
      if (!save) return false;
      if (save.disabled) return 'the save button never enabled';
      save.click();
      return true;
    })()`,
    /*
     * The *server's* answer, not the local one. `aria-pressed` is component
     * state the click already set, so waiting on it would pass whether or not
     * the save reached the server. `overriddenReason` comes back from the row.
     */
    until: "document.body.innerText.includes('You already overruled Russell here')",
    read: `(() => {
      const line = [...document.querySelectorAll('.rs-item-meta')]
        .map((el) => (el.textContent || '').trim())
        .find((text) => text.startsWith('You already overruled Russell here'));
      return line || document.body.innerText.replace(/\\s+/g, ' ').slice(0, 80);
    })()`,
  },
];

/**
 * The decision the journey exists to reach, and what answering it does.
 *
 * Separate from the work pass because there is a **wait** between them that is
 * not a control: Russell's tick is thirty seconds, and launching the idea a
 * person just promoted and then parking its packet takes more than one of them.
 * A person checks back; the harness waits in Node and then presses once, which
 * is the same thing without pretending a poll is a gesture.
 *
 * Nothing here is seeded. The request is written by `parkStoppedMissions` from
 * the packet's own recorded status, the choices are the ones `choicesFor`
 * decides this packet can actually take, and the answer goes through
 * `answerHumanRequest` — the same transition the acceptance chain drives
 * in-process. What this adds is that a person can reach all of it with a thumb.
 */
const JOURNEY_DECISION: JourneyStep[] = [
  {
    name: '18-the-parked-decision',
    what:
      'The decision Russell could not take: its packet stopped outside what was preauthorized, ' +
      'and the card carries the packet’s own recorded reason and the answers that can act on it.',
    act: railPress('Needs you'),
    until: "document.querySelector('.rs-decision-what') !== null",
    patience: 30_000,
    read: `(() => {
      const what = document.querySelector('.rs-decision-what');
      const choices = [...document.querySelectorAll('.rs-choice strong')]
        .map((el) => (el.textContent || '').trim());
      return (what ? (what.textContent || '').trim().slice(0, 60) : 'no decision on the page') +
        ' — offers: ' + (choices.join(' / ') || 'none');
    })()`,
  },
  {
    name: '19-authorized-the-plan',
    what:
      'A person authorizing the plan, on a phone. §16’s other way a start gets authorized: the ' +
      'same `approvePlan` the envelope calls, recorded as this person’s decision.',
    act: `(() => {
      const choice = [...document.querySelectorAll('.rs-choice')].find(
        (el) => /authorize this plan/i.test(el.textContent || ''),
      );
      if (!choice) return false;
      const button = choice.querySelector('button');
      if (!button) return false;
      choice.scrollIntoView({ block: 'center' });
      button.click();
      return 'chose ' + (choice.querySelector('strong').textContent || '').trim();
    })()`,
    /*
     * The *answered* offer is gone — not "no decision is on the page".
     *
     * The card goes because the list re-read from the server, not because
     * anything here hid it: `NeedsYouView` takes no optimistic update. What
     * changed is what else is allowed to be beside it. This used to wait for
     * `.rs-decision-what === null`, which was true while this branch was the
     * only thing seeding Needs You and became false the moment the Software
     * Factory's conversational entrance merged and seeded a software decision
     * of its own. **Neither branch was wrong; the merged tree was**, and a
     * predicate about "no decision anywhere" is a predicate about what every
     * other workstream happens to be doing. `deploymentOwnership` refuses a
     * migration collision and a port collision and can never see this one.
     */
    until:
      "![...document.querySelectorAll('.rs-choice')].some((el) => " +
      "/authorize this plan/i.test(el.textContent || ''))",
    patience: 30_000,
    read: "document.body.innerText.replace(/\\s+/g, ' ').slice(0, 90)",
  },
  {
    name: '20-the-mission-resumed',
    what:
      'The same mission, carrying on. It was the one parked a moment ago; the answer moved it ' +
      'rather than starting a replacement, and Work is where a person reads that.',
    act: railPress('Work'),
    until: "location.pathname === '/work'",
    patience: 30_000,
    /*
     * The mission's own card, by the objective on it — not the first 110
     * characters of the page.
     *
     * The owner's objection to the previous version of this leg was that it
     * only checked arrival. A screen at `/work` is routing; a card carrying the
     * objective of the mission this journey caused is the work.
     */
    read: `(() => {
      const cards = [...document.querySelectorAll('.rs-mission')];
      const mine = cards.find((card) => /recording|deed|Parcel 118/i.test(card.textContent || ''));
      if (!mine) return cards.length + ' mission card(s), none matching the journey’s idea';
      const objective = mine.querySelector('.rs-mission-objective');
      const next = mine.querySelector('.rs-mission-next');
      return (objective ? (objective.textContent || '').trim().slice(0, 50) : 'no objective') +
        ' — ' + (next ? (next.textContent || '').trim().slice(0, 50) : 'no state');
    })()`,
  },
];

/** Where a result is read, once the decision above has let the work carry on. */
const JOURNEY_AFTER: JourneyStep[] = [
  {
    name: '21-what-the-work-actually-is',
    what:
      'The work identified rather than merely visible: the reader turns the depth up to ' +
      'Technical from the More sheet, opens “How it is being done” on that mission, and reads ' +
      'the ids Brain is working under — the mission, its packet, its bin, and the document it ' +
      'has filed once there is one.',
    /*
     * Three presses in one step, because they are one gesture from a person's
     * side: open More, choose Technical, expand the mission's detail. The
     * `details` element is `rs-at-technical`, so it is not in the document at
     * all until the depth changes — which is what makes this a real depth
     * control rather than a class toggle.
     */
    act: `(async () => {
      const more = [...document.querySelectorAll('.rs-more button')].find(
        (b) => /more/i.test(b.textContent || ''),
      );
      if (!more) return false;
      more.click();
      await new Promise((r) => setTimeout(r, 400));
      const technical = [...document.querySelectorAll('button')].find(
        (b) => (b.textContent || '').trim() === 'Technical',
      );
      if (!technical) return 'the depth control is not on the screen';
      technical.click();
      await new Promise((r) => setTimeout(r, 900));
      const card = [...document.querySelectorAll('.rs-mission')].find(
        (el) => /recording|deed|Parcel 118/i.test(el.textContent || ''),
      );
      if (!card) return 'no mission card for the journey’s idea';
      const how = card.querySelector('.rs-mission-how');
      if (!how) return 'the technical detail is not on the card';
      how.open = true;
      how.scrollIntoView({ block: 'center' });
      /*
       * Close the sheet, because a person who has chosen goes back to reading.
       *
       * Leaving it open is what a person would see if they walked away
       * mid-gesture, and it made every step from here on report *"Send: covered
       * by Sign out"* — five findings from one unclosed menu, none of them
       * about the product. A sheet covering the composer is a sheet doing its
       * job; measuring reachability underneath one is measuring nothing.
       */
      more.click();
      await new Promise((r) => setTimeout(r, 300));
      return 'turned the depth up and opened the mission’s detail';
    })()`,
    until: "document.querySelector('.rs-mission-how[open]') !== null",
    patience: 30_000,
    read: `(() => {
      const how = document.querySelector('.rs-mission-how[open]');
      if (!how) return 'nothing opened';
      const pairs = [];
      const terms = [...how.querySelectorAll('dt')];
      const values = [...how.querySelectorAll('dd')];
      for (let i = 0; i < terms.length; i += 1) {
        pairs.push((terms[i].textContent || '').trim() + '=' + ((values[i] || {}).textContent || '').trim());
      }
      return pairs.join(' ');
    })()`,
  },
  {
    name: '22-knows',
    what:
      'Knows: what this project actually believes, read rather than arrived at. Either it names ' +
      'a conclusion and what it rests on, or it says in its own words that nothing has been ' +
      'concluded here yet — and which of those it is, is the evidence.',
    act: railPress('Knows'),
    until: "location.pathname === '/knowledge'",
    /*
     * What the page *holds*, not its first ninety characters. A count of real
     * knowledge rows, grouped as the server classified them, or the server's
     * own sentence for why there are none.
     */
    read: `(() => {
      const groups = [...document.querySelectorAll('.rs-group')].map((g) => {
        const title = g.querySelector('.rs-group-title');
        const count = g.querySelector('.rs-count');
        return (title ? (title.textContent || '').replace(/\\s+/g, ' ').trim() : '?') +
          (count ? '' : '');
      });
      const cards = document.querySelectorAll('.rs-card .rs-item-title');
      if (cards.length === 0) {
        // One element, not three. Querying a list of selectors and taking the
        // first match concatenated the panel's own empty state with the
        // shell's, and read back "There is no There is nothing here yet. yet."
        const panel = document.querySelector('.rs-panel .rs-state') ||
          document.querySelector('.rs-state');
        return 'nothing concluded yet — ' +
          (panel ? (panel.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) : 'no reason given');
      }
      return cards.length + ' conclusion(s): ' + groups.join(' | ') + ' — ' +
        [...cards].slice(0, 2).map((c) => (c.textContent || '').trim().slice(0, 40)).join(' · ');
    })()`,
  },
  {
    name: '23-who-and-fleet',
    what: 'Who, from the thumb bar: the people on the project and the fleet behind it — three capacity numbers that are not each other.',
    act: railPress('Who'),
    // `/fleet`, not `/who`. The rail's label and the address are different
    // things, and a predicate written from the label reported a screen that had
    // plainly arrived as never arriving.
    until: "location.pathname === '/fleet'",
    read: "document.body.innerText.replace(/\\s+/g, ' ').slice(0, 110)",
  },
];

/** The rest of the journey, after the work pass has run. */
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
  /** An https origin to inspect read-only instead of spawning a Brain. */
  deployed: string | null;
  /** Where the deployed inspection's record goes — outside the worktree. */
  emitPhone: string | null;
  /** Open a window and let a person sign in, instead of reading a session. */
  signIn: boolean;
  /** The deployment this reading is meant to be about, so a mismatch is visible. */
  expectRevision: string | null;
}

function parseOptions(argv: string[]): Options {
  let positional: string | null = null;
  let rendersDir: string | null = null;
  let only: 'constellation' | null = null;
  let deployed: string | null = null;
  let emitPhone: string | null = null;
  let signIn = false;
  let expectRevision: string | null = null;
  for (const argument of argv) {
    if (argument.startsWith('--renders=')) rendersDir = argument.slice('--renders='.length);
    else if (argument === '--renders') rendersDir = RENDERS_DEFAULT;
    else if (argument === '--only=constellation') only = 'constellation';
    else if (argument.startsWith('--deployed=')) deployed = argument.slice('--deployed='.length);
    else if (argument.startsWith('--emit-phone='))
      emitPhone = argument.slice('--emit-phone='.length);
    else if (argument === '--sign-in') signIn = true;
    else if (argument.startsWith('--expect-revision='))
      expectRevision = argument.slice('--expect-revision='.length);
    else if (argument.startsWith('--')) throw new Error(`unknown option ${argument}`);
    else if (positional === null) positional = argument;
  }
  if (deployed !== null && !validDeployedOrigin(deployed)) {
    throw new Error(
      '--deployed must be an https origin with no path, e.g. https://brain.example (http is ' +
        `allowed only on 127.0.0.1, which the integration test drives) — got ${deployed}`,
    );
  }
  if (deployed !== null && rendersDir !== null) {
    throw new Error(
      '--deployed is a read-only inspection of somebody else\'s Brain and must not produce the ' +
        'approval render set: those images are of this tree, built here, and a deployed Brain is ' +
        'running whatever was last released.',
    );
  }
  return {
    outputDir: path.resolve(positional ?? path.join(os.tmpdir(), 'brain-visual-qa')),
    rendersDir: rendersDir === null ? null : path.resolve(REPO_ROOT, rendersDir),
    only,
    deployed,
    emitPhone,
    signIn,
    expectRevision,
  };
}

/* ==========================================================================
 * Reading the deployed Brain through the phone interface, and changing nothing
 *
 * ---------------------------------------------------------------------------
 * What this is for, and the two conditions it exists to answer
 * ---------------------------------------------------------------------------
 *
 * Gate J's sequence — a person overrules a priority, Russell launches, the
 * packet parks, a thumb answers it, the same mission carries on — is walked in
 * full against a Brain this harness spawns, and every step of it resolves to
 * ids. Two of J's conditions cannot be answered there and never will be:
 *
 *     the question a person typed was answered rather than left waiting
 *     and its result was inspected there — a conclusion under Knows citing
 *     that mission
 *
 * Both need a **worker that reached the sources**, and a spawned Brain fires
 * none: no inference is bought here (§24), so Russell's turn stays `PENDING`
 * and no packet ever files a report.
 *
 * ---------------------------------------------------------------------------
 * The first version of this was wrong in six ways, and every one of them would
 * have passed
 * ---------------------------------------------------------------------------
 *
 * It is recorded rather than quietly fixed, because the shape of the mistake is
 * the point: **a checker written against a remembered product rather than a
 * read one passes by not looking.**
 *
 *  1. It matched `role === 'PERSON'`. `RUSSELL_MESSAGE_ROLES` is
 *     `['USER', 'RUSSELL', 'SYSTEM']`, so it would have found no human turn in
 *     any conversation and reported the Brain holds none.
 *  2. It set the browser cookie on `127.0.0.1` while navigating to the deployed
 *     origin, so every page would have loaded **signed out** — and a signed-out
 *     Russell renders, so the screen check would have passed on a login screen.
 *  3. It navigated to `/c/:id` and `/knows`. The router knows `/conversation/:id`
 *     and `/knowledge`; both of those are `NOT_FOUND`.
 *  4. It accepted any reply that was not `PENDING`, so a **FAILED** answer
 *     counted as an answered question.
 *  5. It checked that *some* text was on the page rather than that **this
 *     answer** was, so a loading state, an error banner or an empty list would
 *     have satisfied it.
 *  6. It found an answered question in one conversation and a mission-linked
 *     conclusion anywhere else in the Brain and called that a chain. Those are
 *     two unrelated facts; J asks whether **this** question's work produced
 *     **that** result.
 *
 * So the chain is now followed through the rows Brain wrote: a conversation
 * with a `USER` turn and a `COMPLETE` Russell reply → the missions whose
 * `conversationId` is that conversation → a knowledge row whose `missionId` is
 * one of those missions. Each end is then read **on screen at 390px**, by its
 * own text, with every not-yet state refused by name.
 *
 * ---------------------------------------------------------------------------
 * Why it seeds nothing, grants nothing and writes nothing
 * ---------------------------------------------------------------------------
 *
 * The obvious way to close J's two is to do on the deployed Brain what the
 * local journey does on its own: capture an idea, grant a standing authority,
 * wait for a worker. **That is refused**, and the refusal is the design rather
 * than caution. The deployed Brain holds real research; a synthetic idea in it
 * is a row somebody has to recognise as fake later, a new standing grant is a
 * spending authorization created to make a report come out right, and waiting
 * for a worker to answer a question nobody asked spends the subscription on a
 * test. §29 already refuses the smaller version of this — a Capability Lab
 * health check reads rows rather than firing a worker to learn whether workers
 * fire.
 *
 * So this mode **only reads**. `visit` is the only way it talks to the Brain,
 * and it refuses any method but GET — not as a convention but as a thrown
 * error, because a convention is the thing that erodes. There is no sign-in
 * request either: see below.
 *
 * ---------------------------------------------------------------------------
 * How it is authenticated, and why it never sees a password
 * ---------------------------------------------------------------------------
 *
 * Every route it reads is behind `requirePerson`, and a worker principal is
 * refused at the conversation routes **by principal type** (§24). So it needs a
 * person's session — and there are exactly two honest ways to have one:
 *
 *   `--sign-in`       opens a **visible** browser at the origin and waits while
 *                     the person signs in themselves. The credential is typed
 *                     into the Brain's own login form, in their browser. This
 *                     process never sees it.
 *   `BRAIN_PHONE_SESSION`  a session cookie value from a browser that is
 *                     already signed in.
 *
 * There is deliberately **no password option**. A harness that took one would
 * mean somebody typing their Brain password into a terminal, a CI secret or a
 * chat window, and the session it would mint is the same session the two paths
 * above already produce.
 * ========================================================================== */

/** Where `--deployed` may point. */
function validDeployedOrigin(value: string): boolean {
  // https anywhere, and http only on loopback — which is not a network hop and
  // is what the integration test drives a real Brain over.
  return /^https:\/\/[^/]+$/.test(value) || /^http:\/\/127\.0\.0\.1:\d+$/.test(value);
}

/*
 * The record's shape lives in `phoneRecord.ts`, imported rather than restated.
 *
 * It was declared here and again in `step12b-acceptance.ts`, and the reader
 * validated none of it — so the two could disagree about what a reading is and
 * nothing would say so. One definition, one validator, both imported.
 */

/**
 * The only way this mode talks to the Brain, and it cannot be persuaded to
 * write. A `method` argument would be the thing somebody passes 'POST' to one
 * day; there is no argument.
 */
async function visit(cookie: string, route: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${BASE}${route}`, { method: 'GET', headers: { cookie } });
  if (!response.ok) return null;
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * A signed-in session for the deployed origin, obtained without this process
 * ever handling a password.
 *
 * `--sign-in` launches a visible Chromium at the origin and polls the page's
 * own `document.cookie`-bearing requests until `/api/projects` answers 200 from
 * inside it. The person signs in to the Brain's own form; what comes back here
 * is the cookie their browser now holds.
 */
async function sessionForDeployed(options: Options): Promise<string> {
  const supplied = (process.env['BRAIN_PHONE_SESSION'] ?? '').trim();
  if (supplied.length > 0) return supplied.includes('=') ? supplied : `brain_session=${supplied}`;
  if (!options.signIn) {
    throw new Error(
      'No session. Either set BRAIN_PHONE_SESSION to a session cookie from a browser that is ' +
        'already signed in to this Brain, or pass --sign-in to open a window and sign in there. ' +
        'There is no password option: every route this reads is behind requirePerson, and a ' +
        'harness that took a password would mean typing it into a terminal or a CI secret to ' +
        'mint the same session these two already produce.',
    );
  }
  return signInWithAPerson(options);
}

async function signInWithAPerson(options: Options): Promise<string> {
  const origin = options.deployed as string;
  const port = 9222 + Math.floor(Math.random() * 300);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-signin-profile-'));
  const chrome = spawn(
    CHROME,
    [
      // Deliberately **not** headless: a person has to be able to see and use
      // the sign-in form. This is the one place in this file that wants a
      // window.
      '--no-sandbox',
      '--disable-gpu',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      origin,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  console.log(`\nA browser is open at ${origin}. Sign in there; nothing is typed here.`);
  try {
    const deadline = Date.now() + SIGN_IN_WINDOW_MS;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`nobody signed in at ${origin} within ${SIGN_IN_WINDOW_MS / 1000}s`);
      }
      await sleep(2000);
      let cookies: { name: string; value: string; domain: string }[] = [];
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
          type: string;
          webSocketDebuggerUrl: string;
        }[];
        const page = targets.find((entry) => entry.type === 'page');
        if (!page) continue;
        cookies = await readCookies(page.webSocketDebuggerUrl);
      } catch {
        continue;
      }
      const host = new URL(origin).hostname;
      const session = cookies.find(
        (entry) => entry.name.startsWith('brain_') && entry.domain.replace(/^\./, '') === host,
      );
      if (!session) continue;
      const candidate = `${session.name}=${session.value}`;
      // A cookie is not a session until the Brain agrees. Asked before the
      // window closes, so a half-finished sign-in says so here rather than
      // three screens later.
      const probe = await fetch(`${origin}/api/projects`, { headers: { cookie: candidate } });
      if (probe.ok) {
        console.log('  signed in. Closing the window.');
        return candidate;
      }
    }
  } finally {
    try {
      process.kill(-chrome.pid!, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** How long `--sign-in` waits for a person. Long, because a person is involved. */
const SIGN_IN_WINDOW_MS = 300_000;

/** One CDP round trip, for the sign-in window only. */
async function readCookies(
  wsUrl: string,
): Promise<{ name: string; value: string; domain: string }[]> {
  const socket = new WebSocket(wsUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('no debugger')), { once: true });
    });
    const answer = await new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
        if (message.id === 1) resolve((message.result ?? {}) as Record<string, unknown>);
      });
      socket.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
    });
    return (answer['cookies'] ?? []) as { name: string; value: string; domain: string }[];
  } finally {
    socket.close();
  }
}

/**
 * The cookie, on the host actually being inspected.
 *
 * The first version of this hard-coded `127.0.0.1` while navigating to a
 * deployed origin, so every page loaded signed out — and a signed-out Russell
 * renders perfectly well, which is why that would have passed rather than
 * failed. `secure` follows the scheme for the same reason: a `secure` cookie is
 * not sent over http, and an http loopback Brain would have seen nothing.
 */
async function signInBrowserAt(cdp: Cdp, cookie: string, origin: string): Promise<void> {
  const [name, value] = cookie.split('=');
  const url = new URL(origin);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCookie', {
    name: name ?? '',
    value: value ?? '',
    domain: url.hostname,
    path: '/',
    httpOnly: true,
    secure: url.protocol === 'https:',
  });
}

/**
 * Is this screen the thing it claims to be, or one of the four states that are
 * not?
 *
 * Signed out, loading, refused and errored all render, and all of them render
 * *something* — which is exactly how a check for "some text is present" passes
 * on every one of them. Each is named here so the record says which.
 */
const SCREEN_STATE = `(() => {
  const has = (selector) => document.querySelector(selector) !== null;
  if (has('.rs-signin') || has('input[type="password"]')) return 'SIGNED_OUT';
  if (has('.rs-state-loading')) return 'LOADING';
  if (has('.rs-state-forbidden')) return 'FORBIDDEN';
  if (has('.rs-state-error')) return 'ERROR';
  if (has('.rs-state-empty')) return 'EMPTY';
  if (!has('.rs-shell')) return 'NOT_RUSSELL';
  return 'READY';
})()`;

async function inspectDeployed(options: Options): Promise<void> {
  const origin = options.deployed as string;
  if (options.emitPhone === null) {
    throw new Error('--emit-phone=<path> is required: the reading has to go somewhere.');
  }
  const target = path.resolve(options.emitPhone);
  const inside = path.relative(REPO_ROOT, target);
  if (inside.length > 0 && !inside.startsWith('..') && !path.isAbsolute(inside)) {
    throw new Error(
      `--emit-phone must be outside the repository (got ${inside}). A reading of somebody else's ` +
        'running Brain committed into this tree would need a commit per reading and would be ' +
        'stale the moment it landed — the same defect the hosted verification record had.',
    );
  }

  BASE = origin;
  fs.mkdirSync(options.outputDir, { recursive: true });
  const findings: string[] = [];
  const screenshots: string[] = [];
  const cookie = await sessionForDeployed(options);

  /*
   * Which revision is running there, from the authenticated endpoint.
   *
   * `/healthz` is liveness and says nothing else on purpose; `/api/health`
   * carries `revision` and only for a Brain administrator, because it sits with
   * the rest of the operator's facts. A person who is not one gets `null`, and
   * `null` is reported rather than filled in — an acceptance reading that
   * cannot name its revision must be refused rather than trusted.
   */
  const health = await visit(cookie, '/api/health');
  /*
   * Whose commit, beside which commit.
   *
   * Reported by the deployed Brain itself rather than read from whatever
   * checkout this harness happens to be running in — the harness's own remote
   * says which repository *it* came from and nothing about the image it is
   * inspecting, which is the wrong end of the binding.
   */
  const deployedRepository =
    typeof health?.['repository'] === 'string' ? (health['repository'] as string) : null;
  const deployedRevision =
    typeof health?.['revision'] === 'string' ? (health['revision'] as string) : null;
  const expectedRevision = options.expectRevision;
  const revisionMatches =
    expectedRevision === null || deployedRevision === null
      ? null
      : deployedRevision === expectedRevision;
  if (revisionMatches === false && deployedRevision !== null && expectedRevision !== null) {
    findings.push(
      `this reading is of ${deployedRevision.slice(0, 8)} and was asked for about ` +
        `${expectedRevision.slice(0, 8)} — so it is evidence about a different deployment`,
    );
  }
  if (expectedRevision !== null && deployedRevision === null) {
    findings.push(
      'the deployed Brain did not report a revision, so this reading cannot be bound to the ' +
        'deployment being evaluated. /api/health returns it only to a Brain administrator.',
    );
  }

  const answered: DeployedPhoneRecord['answeredQuestion'] = {
    found: false,
    status: null,
    conversationId: null,
    excerpt: null,
    readOnScreen: false,
    screenSaw: null,
  };
  const result: DeployedPhoneRecord['missionLinkedResult'] = {
    found: false,
    missionId: null,
    missionFromConversation: false,
    knowledgeId: null,
    statement: null,
    citesDocument: false,
    citesAudit: false,
    readOnScreen: false,
    screenSaw: null,
  };

  /*
   * One chain, followed forwards. A conversation is only a candidate if the
   * work it caused produced a conclusion — otherwise this would report an
   * answered question from one thread and a result from another and call the
   * pair a sequence, which is the sixth defect above.
   */
  const conversations = await visit(cookie, '/api/russell/conversations');
  const threads = Array.isArray(conversations?.['conversations'])
    ? (conversations['conversations'] as Record<string, unknown>[])
    : [];
  for (const thread of threads) {
    const id = thread['id'];
    if (typeof id !== 'string') continue;
    const detail = await visit(cookie, `/api/russell/conversations/${id}`);
    const turns = Array.isArray(detail?.['turns'])
      ? (detail['turns'] as Record<string, unknown>[])
      : [];
    const askedAt = turns.findIndex((turn) => turn['role'] === 'USER');
    if (askedAt < 0) continue;
    // COMPLETE and nothing else. PENDING is a question still waiting, which is
    // the thing this condition exists to distinguish; FAILED is an answer that
    // did not happen.
    const reply = turns
      .slice(askedAt + 1)
      .find((turn) => turn['role'] === 'RUSSELL' && turn['status'] === 'COMPLETE');
    if (!reply) continue;
    const body = typeof reply['content'] === 'string' ? (reply['content'] as string) : '';
    if (body.trim().length === 0) continue;

    const projectId = typeof thread['projectId'] === 'string' ? (thread['projectId'] as string) : null;
    if (projectId === null) continue;

    // The missions this conversation produced, by Brain's own foreign key.
    const work = await visit(cookie, `/api/russell/projects/${projectId}/work`);
    const missions = Array.isArray(work?.['missions'])
      ? (work['missions'] as Record<string, unknown>[])
      : [];
    const mine = new Set(
      missions
        .filter((mission) => mission['conversationId'] === id)
        .map((mission) => mission['id'])
        .filter((value): value is string => typeof value === 'string'),
    );
    if (mine.size === 0) continue;

    const knowledge = await visit(cookie, `/api/russell/projects/${projectId}/knowledge`);
    const conclusions = Array.isArray(knowledge?.['knowledge'])
      ? (knowledge['knowledge'] as Record<string, unknown>[])
      : [];
    const cited = conclusions.find(
      (row) => typeof row['missionId'] === 'string' && mine.has(row['missionId'] as string),
    );
    if (!cited) continue;

    answered.found = true;
    answered.status = 'COMPLETE';
    answered.conversationId = id;
    answered.excerpt = body.trim().slice(0, 80);

    const provenance = (cited['provenance'] ?? {}) as Record<string, unknown>;
    result.found = true;
    result.missionId = cited['missionId'] as string;
    result.missionFromConversation = true;
    result.knowledgeId = typeof cited['id'] === 'string' ? (cited['id'] as string) : null;
    result.statement = typeof cited['statement'] === 'string' ? (cited['statement'] as string) : null;
    result.citesDocument = typeof provenance['documentId'] === 'string';
    result.citesAudit = typeof provenance['auditId'] === 'string';
    break;
  }
  if (!answered.found) {
    findings.push(
      'no conversation on this Brain holds a question a person typed, a COMPLETE reply to it, ' +
        'and a conclusion citing a mission that conversation produced. That is a fact about the ' +
        'Brain, not a defect in the product — and the three are required together on purpose: ' +
        'an answer in one thread and a result from another are not a chain.',
    );
  }

  /*
   * And then read both ends on the phone, which is the half the API cannot
   * establish. A row that exists and a row a person can read are different
   * claims, and J is about the second.
   */
  await withChromium(async (cdp) => {
    await signInBrowserAt(cdp, cookie, origin);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: PHONE.width,
      height: PHONE.height,
      deviceScaleFactor: 1,
      mobile: true,
    });

    /*
     * Read a screen, and say whether the words that should be on it are.
     *
     * `arrive` is how the screen is reached, because **how** matters here. A
     * full page load is right for the first address and wrong for the second:
     * the shell decides which project Knows is about from the thread it is
     * currently in, so reloading `/knowledge` directly lands on whichever
     * thread a fresh shell opens — which is not the one this reading followed
     * to a mission. Pressing the rail is the same move a person makes, and it
     * keeps the thread.
     */
    const look = async (
      arrive: () => Promise<void>,
      needle: string,
      file: string,
    ): Promise<{ state: string; sawIt: boolean; saw: string }> => {
      await arrive();
      await waitFor(cdp, `${SCREEN_STATE} !== 'LOADING'`, 20_000);
      await sleep(1200);
      const state = (await evaluate(cdp, SCREEN_STATE)) as string;
      /*
       * Whitespace normalized on **both** sides.
       *
       * The page's own text was collapsed and the needle was not, so a
       * statement carrying a newline, a double space or a non-breaking space —
       * which a stored statement and a rendered paragraph both routinely do —
       * could never be found however plainly it was on the screen. A reading
       * that says "not on screen" about text that is on the screen is the
       * expensive direction of wrong: somebody goes looking for a defect that
       * is not there.
       */
      const sawIt = (await evaluate(
        cdp,
        `${NORMALIZED_PAGE_TEXT}.includes(${JSON.stringify(normalizeText(needle))})`,
      )) as boolean;
      const shot = (await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
      })) as { data: string };
      fs.writeFileSync(path.join(options.outputDir, file), Buffer.from(shot.data, 'base64'));
      screenshots.push(file);
      const saw = (await evaluate(cdp, `${NORMALIZED_PAGE_TEXT}.slice(0, 120)`)) as string;
      return { state, sawIt, saw };
    };

    if (answered.conversationId && answered.excerpt) {
      const thread = answered.conversationId;
      const seen = await look(
        () => cdp.send('Page.navigate', { url: `${BASE}/conversation/${thread}` }).then(() => undefined),
        answered.excerpt,
        'deployed-01-the-answer.png',
      );
      answered.readOnScreen = seen.state === 'READY' && seen.sawIt;
      answered.screenSaw = `${seen.state}: ${seen.saw}`;
      if (!answered.readOnScreen) {
        findings.push(
          `the answer is in the rows and not on the screen at /conversation/${answered.conversationId}` +
            ` — the page was ${seen.state} and ${seen.sawIt ? 'did' : 'did not'} carry the answer's own words`,
        );
      }
    }

    if (result.statement) {
      /*
       * Reached by pressing Knows from the thread, not by loading /knowledge.
       *
       * The shell shows the project the open conversation is attached to, so
       * arriving from this thread is what makes the conclusion the one this
       * reading followed. A direct load would show a fresh shell's project,
       * and a conclusion missing from *that* project's list would be reported
       * as a conclusion missing from the screen.
       */
      const seen = await look(async () => {
        const pressed = (await evaluate(cdp, railPress('Knows'))) as boolean;
        if (!pressed) {
          findings.push('the Knows control was not on the screen to press from the thread');
          await cdp.send('Page.navigate', { url: `${BASE}/knowledge` });
        }
      }, result.statement.slice(0, 60), 'deployed-02-the-result.png');
      result.readOnScreen = seen.state === 'READY' && seen.sawIt;
      result.screenSaw = `${seen.state}: ${seen.saw}`;
      if (!result.readOnScreen) {
        findings.push(
          'the conclusion is in the rows and not on the screen at /knowledge — the page was ' +
            `${seen.state} and ${seen.sawIt ? 'did' : 'did not'} carry the conclusion's own statement`,
        );
      }
    }
  });

  const record: DeployedPhoneRecord = {
    brain: origin,
    repository: deployedRepository,
    inspectedAt: new Date().toISOString(),
    deployedRevision,
    expectedRevision,
    revisionMatches,
    answeredQuestion: answered,
    missionLinkedResult: result,
    screenshots,
    findings,
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nDeployed phone reading written to ${target}`);
  console.log(`  revision             ${deployedRevision ?? 'not reported to this person'}`);
  console.log(
    `  answered question    ${answered.found ? `${answered.status} in ${answered.conversationId}, on screen: ${answered.readOnScreen}` : 'no chain on this Brain'}`,
  );
  console.log(
    `  mission result       ${result.found ? `${result.knowledgeId} citing ${result.missionId}, on screen: ${result.readOnScreen}` : 'no chain on this Brain'}`,
  );
  for (const finding of findings) console.log(`  - ${finding}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  /*
   * Before the build and before the spawn, because this mode does neither. A
   * deployed Brain is running whatever was last released, and building a client
   * or starting a second server to look at it would produce nothing but noise.
   */
  if (options.deployed !== null) {
    await inspectDeployed(options);
    return;
  }
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
    await seedSoftwareDecision(dataDir);

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
              const bytes = Buffer.from(shot.data, 'base64');
              fs.writeFileSync(file, bytes);
              /*
               * The declared handoff render, written from the same bytes.
               *
               * Inside the retry rather than beside it: a render written from a
               * capture that came back empty would be a declared screen with no
               * image in it, which is worse than the missing one the finding
               * already names.
               */
              const screen = HANDOFF_SCREENS[destination.name];
              if (screen && options.rendersDir) {
                declared.push(writeRender(options.rendersDir, screen, viewport.width, bytes));
              }
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
       * The settled state of Needs You is captured **after the journey**, and
       * the ordering is the whole correctness of this harness.
       *
       * Everything above runs against a Brain with no standing grant, which is
       * why `/needs-you` here is the **populated** screen: an ungranted project
       * has exactly one decision outstanding and the page refuses to fold it.
       * Getting the settled screen means answering that decision — and the
       * journey is what answers it, on a phone, with a thumb.
       *
       * This used to happen right here, before the journey, and it quietly
       * rewrote the journey's own starting conditions: with the authority
       * already granted, an idea Brain captures is judged and launched within a
       * tick or two, so by the time a person opened Ideas there was no backlog
       * row to press. The run reported three missing controls, every one of
       * them the harness racing the product it was measuring. See
       * `captureSettledNeedsYou`.
       */
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
    const findings = [...captureFindings, ...(await driveJourney(cookie, outputDir, constellation))];

    /*
     * The settled Needs You, photographed once the journey has settled it.
     *
     * The journey approves the standing authority on a phone; this captures the
     * same address afterwards at all three widths, so the approval set holds
     * two real states of one screen separated by one press on a real control.
     * Nothing is invented and nothing is stubbed — and, unlike the version that
     * did this before the journey, nothing about the journey's own starting
     * state is rewritten to get the picture.
     */
    if (options.rendersDir) {
      findings.push(
        ...(await captureSettledNeedsYou(cookie, options.rendersDir, outputDir, declared)),
      );
      writeDeclaration(options.rendersDir, declared);
      console.log(
        `\n${declared.length} render(s) declared in ${path.join(options.rendersDir, 'index.json')}`,
      );
    }

    reportConstellation(constellation);
    writeJourneyRecord(outputDir, constellation, findings);

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

/**
 * The journey, written down so something other than a person can read it.
 *
 * Stamped with the revision it was taken at, for the same reason the render
 * manifest is: an image set that outlives the tree it was taken from is a
 * picture of a different product, and a reading of it is a claim about a
 * different product. The reporter refuses a record whose revision does not
 * match the tree it is running in.
 *
 * It records what was *read*, not a verdict. `findings` is the harness's own
 * list; whether a run with findings is acceptable is not the harness's to say.
 */
function writeJourneyRecord(
  dir: string,
  constellation: ({ width: number } & ConstellationReading)[],
  findings: string[],
): void {
  let revision: string | null = null;
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    revision = null;
  }
  const controls = new Set<string>();
  for (const entry of JOURNEY_RECORD) {
    for (const name of entry.unreachable.split(',')) {
      const trimmed = name.trim();
      if (trimmed) controls.add(trimmed);
    }
  }
  const record = {
    takenAt: new Date().toISOString(),
    revision,
    phoneWidth: PHONE.width,
    steps: JOURNEY_RECORD,
    /*
     * What the journey *changed*, beside what it walked past.
     *
     * A list of steps that arrived is a claim about navigation. These are the
     * rows the presses wrote, read back through the product's own routes by
     * `persistedEffects` inside the same journey — so a reader can tell a
     * sequence that happened from a sequence that rendered.
     */
    effects: JOURNEY_EFFECTS,
    stepsWalked: JOURNEY_RECORD.length,
    stepsThatArrived: JOURNEY_RECORD.filter((entry) => entry.arrived).length,
    stepsThatFit: JOURNEY_RECORD.filter((entry) => entry.fits).length,
    stepsWithNothingClipped: JOURNEY_RECORD.filter((entry) => !entry.clipped).length,
    unreachableControls: [...controls],
    constellation: constellation.map((reading) => ({
      width: reading.width,
      layout: reading.layout,
      nodes: reading.nodes,
      listed: reading.listed,
      overlaps: reading.overlaps,
      canvas: reading.canvas,
    })),
    findings,
  };
  fs.writeFileSync(path.join(dir, 'journey.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nJourney record written to ${path.join(dir, 'journey.json')}`);
}

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
 * What the journey needs to act on, put there through the product's own doors.
 *
 * The fourteen steps before this one demonstrated navigation and layout: every
 * screen reached, nothing clipped, every control a thumb can land on. That is a
 * necessary condition for J and it is not J — a person does not use Brain to
 * look at Brain. The journey has to change something and the change has to
 * still be there afterwards.
 *
 * So this seeds an idea, and it does it the way the product does rather than by
 * writing rows: a connected site registers a record and asks for research, which
 * is §25's `RESEARCH_FURTHER` — an idea, spending nothing, with a person in
 * Russell the only one who may authorize the spending. Every call is a real
 * route with a real credential, and the site's credential is issued by the same
 * **Connected sites** action a person uses.
 *
 * Returns what the journey needs to press things: the project it seeded into,
 * and the id of the idea, so the steps that follow can read the row back rather
 * than trust the screen.
 */
interface Seeded {
  projectId: string | null;
  projectName: string | null;
  candidateId: string | null;
  note: string;
}

async function seedSomethingToDecide(cookie: string): Promise<Seeded> {
  const json = async (path: string, body?: unknown): Promise<Record<string, unknown> | null> => {
    const response = await fetch(`${BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE,
        cookie,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) return null;
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const projects = (await json('/api/projects')) as { projects?: { id: string; name: string }[] } | null;
  const project = projects?.projects?.[0] ?? null;
  if (!project) return { projectId: null, projectName: null, candidateId: null, note: 'no project exists to seed into' };

  /*
   * A connected site, made through the action a person uses. `connectSite`
   * writes the identity, the membership and the fixed scope set from constants
   * and issues one secret, shown once — so this is the same rotation an
   * operator performs, not a back door built for the harness.
   */
  const connected = await json(`/api/russell/projects/${project.id}/sites/DEAL_DISPATCH/connect`, {});
  const secret = typeof connected?.['secret'] === 'string' ? (connected['secret'] as string) : null;
  if (!secret) {
    return {
      projectId: project.id,
      projectName: project.name,
      candidateId: null,
      note: 'the site connector issued no credential, so nothing could be seeded',
    };
  }

  const asSite = async (path: string, body: unknown): Promise<Record<string, unknown> | null> => {
    const response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE,
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const recordId = `opp-visual-${Date.now().toString(36)}`;
  const delivered = await asSite(`/api/projects/${project.id}/connect/DEAL_DISPATCH/records`, {
    records: [
      {
        sourceRecordId: recordId,
        sourceRecordType: 'OPPORTUNITY',
        sourceVersion: new Date().toISOString(),
        title: 'Parcel 118 — how long recording takes in this county',
        /*
         * A question whose compiled plan the standing envelope will not
         * auto-approve, and that is the point of the seed rather than a
         * flourish.
         *
         * `RUSSELL_PUBLIC_RECORDS_V1` authorizes reading published Michigan
         * records and nothing else, so its `forbiddenActions` matches
         * "email the …". The compiler does not check that list — it checks the
         * jurisdiction and the source classes — so this idea judges, compiles,
         * launches, and is refused by `planFitsEnvelope` at the approval gate.
         * That is §16's escalation, and it is the only way this journey can
         * reach a **real** parked decision to answer: one Brain derived from a
         * packet's own rows, with a request nobody wrote by hand.
         *
         * The jurisdiction is in the record's own column as well as its prose,
         * so `jurisdictionFor` reads it from the row (§25) rather than falling
         * back to the envelope's.
         */
        summary:
          'The site cannot settle how long a deed takes to become searchable after ' +
          'recording, and wants somebody to email the register of deeds to confirm the figure.',
        sourceRef: `https://deal-dispatch.example.invalid/opportunities/${recordId}`,
        attributes: {
          status: 'OPEN',
          state: 'MI',
          county: 'Washtenaw',
          location: 'Washtenaw County, Michigan',
          primaryBlocker:
            'nobody can say how far the electronic index lags a recording, and the site ' +
            'wants the register of deeds emailed to confirm it',
        },
      },
    ],
  });
  if (delivered === null) {
    return {
      projectId: project.id,
      projectName: project.name,
      candidateId: null,
      note: 'the site could not register a record',
    };
  }

  const commanded = await asSite(
    `/api/projects/${project.id}/connect/DEAL_DISPATCH/records/${recordId}/commands`,
    {
    command: 'RESEARCH_FURTHER',
    actor: 'someone at the site',
    },
  );
  if (commanded === null) {
    return {
      projectId: project.id,
      projectName: project.name,
      candidateId: null,
      note: 'the site could not issue its command',
    };
  }

  /*
   * The command answers with the **record's** projection, not with an idea —
   * which is right: what a site is told is what Brain will do about its record,
   * and the candidate is Brain's own business. So the idea is found where ideas
   * are, by the title the record carried into it.
   *
   * The first version read `candidateId` off the command's reply and got null
   * every time, then reported "the command was accepted and returned no idea"
   * — true of the field it looked at and wrong about what happened.
   */
  const ideas = (await json(`/api/russell/projects/${project.id}/candidates`)) as {
    candidates?: { id: string; title: string }[];
  } | null;
  const mine =
    ideas?.candidates?.find((candidate) => candidate.title.includes('recording takes')) ?? null;

  return {
    projectId: project.id,
    projectName: project.name,
    candidateId: mine?.id ?? null,
    note: mine
      ? `a site asked for research and Brain captured idea ${mine.id}`
      : `the command was accepted and no idea carries the record's title ` +
        `(${ideas?.candidates?.length ?? 0} idea(s) in the project)`,
  };
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
/**
 * Does this Brain already hold a standing authority, asked of the server?
 *
 * Read rather than remembered, because the two passes that can create one — the
 * render capture and the journey — do not share a variable, and a flag one of
 * them set would be exactly the second copy of a fact this file keeps being
 * bitten by.
 */
async function standingGrantExists(cookie: string): Promise<boolean> {
  try {
    const projects = (await (
      await fetch(`${BASE}/api/projects`, {
        headers: { origin: BASE, cookie },
        signal: AbortSignal.timeout(20_000),
      })
    ).json()) as { projects?: { id: string }[] };
    const project = projects.projects?.[0];
    if (!project) return false;
    const authority = (await (
      await fetch(`${BASE}/api/russell/projects/${project.id}/authority`, {
        headers: { origin: BASE, cookie },
        signal: AbortSignal.timeout(20_000),
      })
    ).json()) as { grant?: unknown };
    return authority.grant !== null && authority.grant !== undefined;
  } catch {
    return false;
  }
}

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
 * What the journey saw, per step, in a form something other than a person can
 * read.
 *
 * The images are the evidence a person looks at; this is the evidence the
 * acceptance reporter reads. Without it J's row had to quote its own findings
 * as literal prose — "all 15 chrome controls answer elementFromPoint" — which
 * stays true in the sentence after it stops being true of the product. A count
 * that is re-read from a file the harness wrote cannot do that.
 */
interface JourneyStepRecord {
  step: string;
  arrived: boolean;
  fits: boolean;
  clipped: boolean;
  unreachable: string;
}
const JOURNEY_RECORD: JourneyStepRecord[] = [];

/**
 * What each step read, kept by name.
 *
 * A check that needs a step's reading has to use *that step's*, taken while its
 * screen was on the display. The first version of the technical-detail check
 * re-read the DOM after the whole walk had finished — by which time the journey
 * had moved on to Knows and Who, `.rs-mission-how[open]` no longer existed, and
 * it reported the ids "NOT MATCHED" against an empty string. The screen was
 * right and the reader was late.
 */
const JOURNEY_READS: Record<string, string> = {};

/**
 * The persisted consequences of the journey, filled in as they are read back.
 *
 * Declared with every field null so an unwalked journey records "we did not
 * find out" rather than "it did not happen" — the distinction the whole
 * reporter is built on, at the smallest scale it appears in.
 */
const JOURNEY_EFFECTS: {
  standingAuthorityGranted: boolean | null;
  ideaOverriddenByAPerson: boolean | null;
  ideaPriority: string | null;
  russellsJudgmentKept: boolean | null;
  parkedMissionId: string | null;
  parkedRequestId: string | null;
  parkedOrchestrationId: string | null;
  missionStateBefore: string | null;
  missionStateAfter: string | null;
  requestSettled: boolean | null;
  /**
   * The result half, which navigation cannot supply.
   *
   * The owner named this exactly: *"'21-knows' only checks arrival at
   * /knowledge; no assertion identifies and inspects the resulting answer or
   * work output."* Both were true. Arriving at an address is routing. These
   * are what the reader can actually **read** about the work the journey
   * caused, and the last three are deliberately the ones a checkout cannot
   * settle — a filed document, a conclusion, an answered question all need a
   * worker that reached the sources.
   */
  workIdentifiedOnScreen: boolean | null;
  workIdsOnScreen: string | null;
  filedDocumentOnScreen: string | null;
  knowledgeRows: number | null;
  knowledgeCitingThisMission: number | null;
  askedTurnStatus: string | null;
  /**
   * Gate M's last condition, answered where a real one can be.
   *
   * M compares four readers of one progress projection — the briefing, the
   * conversation hat, the progress route and the constellation — and it made
   * that comparison **in process**, then said of the HTTP version: *"driven
   * through the services the routes call, which is where the derivation
   * lives."* True, and it is the substitution this repository refuses
   * everywhere else: the route layer adds `requirePerson` and
   * `decideProjectAccess`, a handler that resolved before it authorized would
   * be invisible from a service call, and §29's own rule is that a mechanism
   * nothing calls is not a mechanism.
   *
   * It is asked here rather than in the reporter because this harness already
   * has the two things the question needs and the reporter has neither: a real
   * server on a real socket, and a person signed into it. Adding a server spawn
   * to a read-only reporter to ask one question would be the more expensive way
   * to get a worse answer.
   */
  httpProgressMatchesBriefing: boolean | null;
  httpProgressSaw: string | null;
} = {
  standingAuthorityGranted: null,
  ideaOverriddenByAPerson: null,
  ideaPriority: null,
  russellsJudgmentKept: null,
  parkedMissionId: null,
  parkedRequestId: null,
  parkedOrchestrationId: null,
  missionStateBefore: null,
  missionStateAfter: null,
  requestSettled: null,
  workIdentifiedOnScreen: null,
  workIdsOnScreen: null,
  filedDocumentOnScreen: null,
  knowledgeRows: null,
  knowledgeCitingThisMission: null,
  askedTurnStatus: null,
  httpProgressMatchesBriefing: null,
  httpProgressSaw: null,
};

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
    const landed = step.until ? await waitFor(cdp, step.until, step.patience ?? 15_000) : true;
    if (!landed) {
      findings.push(`${step.name}: pressed, and the screen never arrived — ${String(step.until)}`);
    }
    // The shell renders its own state as soon as it has an answer; this is for
    // what comes after that — a measured canvas, a re-read thread, a fetch.
    await sleep(1200);

    const reading = await capture(cdp, outputDir, `journey-${step.name}.png`);
    JOURNEY_RECORD.push({
      step: step.name,
      arrived: landed,
      fits: !reading.sideways,
      clipped: reading.cutOff.length > 0,
      unreachable: reading.unreachable,
    });
    findings.push(...judge(step.name, reading));
    const read = step.read ? String(await evaluate(cdp, step.read)) : '';
    JOURNEY_READS[step.name] = read;
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
    `journey-26-constellation-${NARROW_PHONE}.png`,
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
    // Recorded like any other step: a map opened by pressing its own tab is a
    // step of the journey, and leaving six of them out of the record made the
    // walk look a third shorter than it is.
    JOURNEY_RECORD.push({
      step: `map:${label}`,
      arrived: selected,
      fits: !capture0.sideways,
      clipped: capture0.cutOff.length > 0,
      unreachable: capture0.unreachable,
    });
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
  const reading = await capture(cdp, outputDir, `journey-24-thumb-bar-${NARROW_PHONE}.png`);
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

/**
 * What the journey actually changed, asked of the product's read routes.
 *
 * The screen saying a priority changed and the row having changed are two
 * facts, and only the second one survives a reload. So every effect the working
 * half of the journey was supposed to produce is read back here, as the same
 * signed-in person, through the routes the product itself serves — inside the
 * same journey rather than in a separate pass, because an assertion made later
 * is an assertion about a different session.
 *
 * Each miss is a finding in the harness's own list, so a step that looked like
 * it worked and did not fails the run rather than going unnoticed.
 */
async function persistedEffects(
  cookie: string,
  seeded: Seeded,
  parked: Parked,
): Promise<string[]> {
  const found: string[] = [];
  const read = async (path: string): Promise<Record<string, unknown> | null> => {
    try {
      const response = await fetch(`${BASE}${path}`, {
        headers: { origin: BASE, cookie },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return null;
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  console.log('');
  console.log('What the journey changed, read back from the rows:');

  /* The standing authority, which the journey approved by pressing Approve. */
  if (seeded.projectId) {
    const authority = await read(`/api/russell/projects/${seeded.projectId}/authority`);
    const granted =
      authority !== null &&
      typeof authority['grant'] === 'object' &&
      authority['grant'] !== null;
    JOURNEY_EFFECTS.standingAuthorityGranted = granted;
    console.log(`  standing authority   ${granted ? 'granted, and still there' : 'NOT GRANTED'}`);
    if (!granted) {
      found.push('the standing authority was approved on screen and no grant is recorded');
    }
  }

  /* The priority a person set over Russell's, which is §24's override. */
  if (seeded.candidateId) {
    const idea = await read(`/api/russell/candidates/${seeded.candidateId}`);
    const node = (idea?.['candidate'] ?? idea) as Record<string, unknown> | undefined;
    const priority = typeof node?.['priority'] === 'string' ? (node['priority'] as string) : null;
    const overrideBy =
      typeof node?.['overrideUserId'] === 'string' ? (node['overrideUserId'] as string) : null;
    const superseded = node?.['supersededDecision'] ?? null;
    console.log(
      `  the idea             priority ${priority ?? 'unknown'}` +
        `${overrideBy ? `, overridden by a person` : ', no override recorded'}` +
        `${superseded ? ', and Russell’s own judgment kept beside it' : ''}`,
    );
    /*
     * One cause, one finding. The first version reported the priority, the
     * missing author and the missing superseded judgment as three separate
     * findings when the single fact was that the press never happened — three
     * lines for one defect is how a list of findings stops being read.
     */
    JOURNEY_EFFECTS.ideaOverriddenByAPerson = overrideBy !== null;
    JOURNEY_EFFECTS.ideaPriority = priority;
    JOURNEY_EFFECTS.russellsJudgmentKept = superseded !== null;
    if (overrideBy === null) {
      found.push(
        `no override is recorded on the idea, so the press did not reach the server ` +
          `(the row still says ${priority ?? 'nothing'})`,
      );
    } else {
      if (priority !== 'MUST_DO') {
        found.push(
          `the priority was set to Must do on screen and the row says ${priority ?? 'nothing'}`,
        );
      }
      if (superseded === null) {
        found.push("the override destroyed Russell's own judgment rather than superseding it");
      }
    }
  }

  /*
   * The decision the person answered, and the mission it was about.
   *
   * Three facts, and they have to be about **one** id or the sequence proves
   * nothing: the request the card carried is settled; the mission that was
   * parked is no longer parked; and it is the same mission, not a replacement
   * the tick started beside it. A journey that answered a decision and then
   * read a different mission's state would report a resumption that never
   * happened.
   */
  if (seeded.projectId && parked.missionId) {
    /*
     * Polled, because the transition is a tick rather than a response.
     *
     * `answerHumanRequest` records the decision and `approvePlan` moves the
     * fragments; the mission's own state follows on Russell's next cycle, which
     * is thirty seconds. Reading once, ten seconds after the press, recorded
     * `NEEDS_HUMAN → NEEDS_HUMAN` on a run where Work was already showing the
     * assignment — a finding about how fast this file reads, not about the
     * product. The acceptance chain settles three ticks for the same reason;
     * this waits for the same thing from outside.
     *
     * It is a wait, not a weakening: the state it is waiting for is the one
     * asserted, and a mission still parked at the deadline is still a finding.
     */
    let mission: Record<string, unknown> | null = null;
    let stateAfter: string | null = null;
    const resumeBy = Date.now() + 150_000;
    for (;;) {
      const work = await read(`/api/russell/projects/${seeded.projectId}/work`);
      const missions = Array.isArray(work?.['missions'])
        ? (work['missions'] as Record<string, unknown>[])
        : [];
      mission = missions.find((row) => row['id'] === parked.missionId) ?? null;
      stateAfter = typeof mission?.['state'] === 'string' ? (mission['state'] as string) : null;
      if (stateAfter !== 'NEEDS_HUMAN' || Date.now() >= resumeBy) break;
      await sleep(5_000);
    }
    const needsYou = await read(`/api/russell/projects/${seeded.projectId}/needs-you`);
    const stillOpen = Array.isArray(needsYou?.['requests'])
      ? (needsYou['requests'] as Record<string, unknown>[]).some(
          (request) => request['id'] === parked.requestId,
        )
      : false;
    JOURNEY_EFFECTS.parkedMissionId = parked.missionId;
    JOURNEY_EFFECTS.parkedRequestId = parked.requestId;
    JOURNEY_EFFECTS.parkedOrchestrationId = parked.orchestrationId;
    JOURNEY_EFFECTS.missionStateBefore = parked.stateBefore;
    JOURNEY_EFFECTS.missionStateAfter = stateAfter;
    JOURNEY_EFFECTS.requestSettled = !stillOpen;
    console.log(
      `  the parked mission   ${parked.missionId} ${parked.stateBefore ?? 'unknown'} → ` +
        `${stateAfter ?? 'gone'}, its request ${stillOpen ? 'STILL OPEN' : 'settled'}`,
    );
    if (mission === null) {
      found.push(
        `the mission the journey answered a decision about (${parked.missionId}) is no longer ` +
          'on the work surface at all',
      );
    } else if (stateAfter === 'NEEDS_HUMAN') {
      found.push(
        'the decision was answered on screen and the mission is still parked — the answer ' +
          'reached no transition',
      );
    }
    if (stillOpen) {
      found.push('the answered request is still open, so the answer did not settle it');
    }
  }

  /*
   * The result, and the honest absence of one.
   *
   * Knows is where the *answer* to work is read, and the journey's step 22
   * reads what the page holds rather than that it arrived. This is the same
   * question asked of the rows, so the reporter can tell three things apart:
   * a conclusion that cites this mission, a project that truthfully holds
   * none yet, and a read that failed.
   *
   * A checkout Brain fires no worker, so the expected answer here is **none**
   * — and that is recorded as an open condition needing production rather
   * than passed over. Inventing one would be inventing a research result.
   */
  if (seeded.projectId) {
    const knowledge = await read(`/api/russell/projects/${seeded.projectId}/knowledge`);
    const rows = Array.isArray(knowledge?.['knowledge'])
      ? (knowledge['knowledge'] as Record<string, unknown>[])
      : [];
    JOURNEY_EFFECTS.knowledgeRows = knowledge === null ? null : rows.length;
    JOURNEY_EFFECTS.knowledgeCitingThisMission =
      knowledge === null
        ? null
        : rows.filter((row) => row['missionId'] === parked.missionId).length;
    console.log(
      `  what Russell knows   ${
        knowledge === null
          ? 'could not be read'
          : `${rows.length} conclusion(s), ${JOURNEY_EFFECTS.knowledgeCitingThisMission} citing ` +
            `${parked.missionId ?? 'the journey’s mission'}`
      }` +
        (JOURNEY_EFFECTS.filedDocumentOnScreen
          ? `, filed document ${JOURNEY_EFFECTS.filedDocumentOnScreen}`
          : ', no filed document yet'),
    );
  }

  /*
   * And the question a person typed at step 03, which is the other half of the
   * same boundary: no inference is bought here, so Russell's answer is a bin a
   * worker has to take. A checkout leaves it PENDING, truthfully.
   */
  if (seeded.projectId) {
    const conversations = await read('/api/russell/conversations');
    const threads = Array.isArray(conversations?.['conversations'])
      ? (conversations['conversations'] as Record<string, unknown>[])
      : [];
    const thread = threads[0];
    if (thread && typeof thread['id'] === 'string') {
      const detail = await read(`/api/russell/conversations/${thread['id']}`);
      // `turns`, which is what the route returns — the same rows the
      // conversation screen renders, with their pending detail derived.
      const messages = Array.isArray(detail?.['turns'])
        ? (detail['turns'] as Record<string, unknown>[])
        : [];
      const reply = [...messages].reverse().find((message) => message['role'] === 'RUSSELL');
      JOURNEY_EFFECTS.askedTurnStatus =
        reply && typeof reply['status'] === 'string' ? (reply['status'] as string) : null;
      console.log(
        `  the question asked   Russell's turn is ${JOURNEY_EFFECTS.askedTurnStatus ?? 'not readable'}`,
      );
    }
  }

  /* And that the work surface now reflects it, rather than only the idea. */
  if (seeded.projectId) {
    const work = await read(`/api/russell/projects/${seeded.projectId}/work`);
    const groups = Array.isArray(work?.['groups']) ? (work['groups'] as unknown[]) : [];
    console.log(`  work                 ${groups.length} group(s) after the change`);
  }

  /*
   * M's four readers of one projection, over HTTP, as the signed-in person.
   *
   * Two routes, two independent derivations of the same thing: `/progress`
   * calls `projectProgress` and `/briefing` calls `briefing`, which carries its
   * own `progress`. They must agree field for field — and the three readings
   * the progress route returns must name three *different* denominators,
   * because one number pretending to be universal is the defect §29 records
   * ("0 of 8 settled" was accurate and read as failure). No headline may carry
   * a percentage, and the ratio must be whole or absent.
   *
   * Failing to read either route is a missing measurement rather than a
   * finding: `null`, with what happened written down.
   */
  if (seeded.projectId) {
    const progress = await read(`/api/russell/projects/${seeded.projectId}/progress`);
    const brief = await read(`/api/russell/projects/${seeded.projectId}/briefing`);
    const viaRoute = (progress?.['project'] ?? null) as Record<string, unknown> | null;
    const viaWork = (progress?.['work'] ?? null) as Record<string, unknown> | null;
    const viaBuild = (progress?.['build'] ?? null) as Record<string, unknown> | null;
    const viaBriefing = ((brief?.['briefing'] as Record<string, unknown> | undefined)?.[
      'progress'
    ] ?? null) as Record<string, unknown> | null;

    if (viaRoute === null || viaBriefing === null) {
      JOURNEY_EFFECTS.httpProgressSaw =
        `progress route ${progress === null ? 'unreadable' : 'read'}, ` +
        `briefing ${brief === null ? 'unreadable' : 'read'} — one of them carried no progress`;
    } else {
      const same = (['headline', 'stage', 'denominator'] as const).every(
        (field) => viaRoute[field] === viaBriefing[field],
      );
      const ratiosAgree =
        JSON.stringify(viaRoute['ratio']) === JSON.stringify(viaBriefing['ratio']);
      const milestonesAgree =
        JSON.stringify(viaRoute['milestones']) === JSON.stringify(viaBriefing['milestones']);
      const denominators = [viaRoute, viaWork, viaBuild]
        .map((reading) => String(reading?.['denominator'] ?? ''))
        .filter((value) => value.length > 0);
      const denominatorsDiffer = new Set(denominators).size === denominators.length;
      const named = String(viaRoute['denominator'] ?? '').trim().length > 0;
      const headlines = [viaRoute, viaWork, viaBuild, viaBriefing].map((reading) =>
        String(reading?.['headline'] ?? ''),
      );
      const noPercentage = headlines.every((headline) => !/\d+\s*%/.test(headline));
      const ratio = viaRoute['ratio'] as { done?: unknown; total?: unknown } | null;
      const ratioWhole =
        ratio === null ||
        ratio === undefined ||
        (Number.isInteger(ratio.done) && Number.isInteger(ratio.total));

      JOURNEY_EFFECTS.httpProgressMatchesBriefing =
        same && ratiosAgree && milestonesAgree && denominatorsDiffer && named && noPercentage && ratioWhole;
      JOURNEY_EFFECTS.httpProgressSaw =
        `two routes as a signed-in person: headline/stage/denominator ${same ? 'agree' : 'DIFFER'}` +
        `, ratio ${ratiosAgree ? 'agrees' : 'DIFFERS'}, milestones ${milestonesAgree ? 'agree' : 'DIFFER'}` +
        `; denominators [${denominators.join(' | ')}]${denominatorsDiffer ? '' : ' — NOT DISTINCT'}` +
        `; ${noPercentage ? 'no percentage in any of 4 headlines' : 'A HEADLINE CARRIES A PERCENTAGE'}` +
        `; ratio ${ratioWhole ? 'whole or absent' : 'IS A FRACTION OF A THING'}`;
    }
    console.log(
      `  progress over HTTP   ${JOURNEY_EFFECTS.httpProgressSaw ?? 'not measured'}`,
    );
    if (JOURNEY_EFFECTS.httpProgressMatchesBriefing === false) {
      found.push(
        `two routes disagree about one project's progress: ${JOURNEY_EFFECTS.httpProgressSaw}`,
      );
    }
  }

  return found;
}

/**
 * What the journey found parked, so the effects check can prove it *moved*.
 *
 * Captured before the answer rather than derived after it, because "a mission
 * is RUNNING" is not the claim — the claim is that **this** mission was parked,
 * a person answered its request, and that same mission carried on. Two readings
 * of one id, either side of one press.
 */
interface Parked {
  missionId: string | null;
  requestId: string | null;
  orchestrationId: string | null;
  stateBefore: string | null;
  packetBefore: string | null;
  note: string;
}

/**
 * Wait for Russell to reach a decision it cannot take, without taking it for it.
 *
 * Every row this waits for is written by the product: the tick judges the idea
 * a person has just promoted, compiles a specification, launches a mission,
 * `planFitsEnvelope` refuses the plan because it describes emailing somebody,
 * `advancePacket` stops the packet at NEEDS_HUMAN with that reason, and
 * `parkStoppedMissions` writes the request. Nothing here creates any of it, and
 * a run where none of it happens reports that rather than inventing a card.
 *
 * Bounded, because a wait with no end is indistinguishable from a hang — and
 * the bound is generous on purpose: the chain above is four tick-driven steps
 * at thirty seconds each.
 */
async function waitForParkedDecision(cookie: string, seeded: Seeded): Promise<Parked> {
  const empty: Parked = {
    missionId: null,
    requestId: null,
    orchestrationId: null,
    stateBefore: null,
    packetBefore: null,
    note: 'nothing parked',
  };
  if (!seeded.projectId) return { ...empty, note: 'no project to watch' };

  const read = async (path: string): Promise<Record<string, unknown> | null> => {
    try {
      const response = await fetch(`${BASE}${path}`, {
        headers: { origin: BASE, cookie },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return null;
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const deadline = Date.now() + 300_000;
  let lastSeen = 'no mission yet';
  while (Date.now() < deadline) {
    const needsYou = await read(`/api/russell/projects/${seeded.projectId}/needs-you`);
    const requests = Array.isArray(needsYou?.['requests'])
      ? (needsYou['requests'] as Record<string, unknown>[])
      : [];
    const missionRequest = requests.find((request) => typeof request['missionId'] === 'string');
    if (missionRequest) {
      const missionId = String(missionRequest['missionId']);
      const work = await read(`/api/russell/projects/${seeded.projectId}/work`);
      const missions = Array.isArray(work?.['missions'])
        ? (work['missions'] as Record<string, unknown>[])
        : [];
      const mission = missions.find((row) => row['id'] === missionId) ?? null;
      const orchestrationId =
        typeof mission?.['orchestrationId'] === 'string'
          ? (mission['orchestrationId'] as string)
          : null;
      return {
        missionId,
        requestId: String(missionRequest['id']),
        orchestrationId,
        stateBefore: typeof mission?.['state'] === 'string' ? (mission['state'] as string) : null,
        packetBefore: 'NEEDS_HUMAN',
        note:
          `mission ${missionId} parked at ${String(mission?.['state'] ?? 'unknown')}, ` +
          `request ${String(missionRequest['id'])}`,
      };
    }
    const work = await read(`/api/russell/projects/${seeded.projectId}/work`);
    const missions = Array.isArray(work?.['missions'])
      ? (work['missions'] as Record<string, unknown>[])
      : [];
    /*
     * When nothing has happened, say what the idea itself looks like.
     *
     * "No mission has launched yet" is a fact about the mission table and tells
     * nobody why. The idea's own state, priority and reason are what separate
     * "Brain has not got to it" from "Brain decided against it" from "a person
     * queued it and nothing can launch it" — which is the defect this journey
     * found, and which a bare mission count hid for a whole run.
     */
    const idea = seeded.candidateId
      ? await read(`/api/russell/candidates/${seeded.candidateId}`)
      : null;
    const node = (idea?.['candidate'] ?? idea) as Record<string, unknown> | undefined;
    lastSeen =
      missions.length === 0
        ? `no mission has launched yet; the idea is ${String(node?.['state'] ?? 'unknown')}/` +
          `${String(node?.['priority'] ?? 'none')} — "${String(node?.['reason'] ?? '').slice(0, 70)}"`
        : `${missions.length} mission(s): ${missions
            .map((row) => String(row['state']))
            .join(', ')}`;
    await sleep(5_000);
  }
  return { ...empty, note: `nothing parked within 240s — ${lastSeen}` };
}

/**
 * `/needs-you` in its settled state, at all three widths, after the journey.
 *
 * The grant it depends on is the journey's own — a person opening Needs You on
 * a phone and pressing Approve. This only photographs the consequence, and it
 * refuses to photograph one that is not there: a run where the page still shows
 * a decision is reported rather than captured as though it were settled.
 *
 * It is a separate browser session from the journey's on purpose. The journey
 * emulates a 390px phone throughout and this needs three widths at
 * `deviceScaleFactor: 2`; reusing its session would mean leaving the journey's
 * last screen in a state the next reader has to reason about.
 */
/** The project this harness seeded everything into. */
async function firstProjectId(cookie: string): Promise<string> {
  const response = await fetch(`${BASE}/api/projects`, { headers: { cookie } });
  if (!response.ok) return '';
  const body = (await response.json()) as Record<string, unknown>;
  const rows = Array.isArray(body['projects']) ? (body['projects'] as Record<string, unknown>[]) : [];
  const first = rows[0]?.['id'];
  return typeof first === 'string' ? first : '';
}

async function captureSettledNeedsYou(
  cookie: string,
  rendersDir: string,
  outputDir: string,
  declared: Render[],
): Promise<string[]> {
  const found: string[] = [];
  if (!(await standingGrantExists(cookie))) {
    found.push(
      'needs-you-empty: no standing authority is recorded after the journey, so the settled ' +
        'state of Needs You was never rendered',
    );
    return found;
  }

  /*
   * Settle the *other* workstream's card before photographing "settled".
   *
   * `NeedsYouView` reaches `.rs-nothing` only when the request list is empty
   * **and** `software.length === 0` **and** no grant is outstanding — which is
   * right: §29 records that a page holding a software card must not announce
   * "nothing needs your decision". `seedSoftwareDecision` puts one there so the
   * Software Factory's entrance can be photographed earlier in this same pass,
   * and it is still outstanding by the time this runs. So this address is
   * genuinely not settled, and waiting for `.rs-nothing` was waiting for a
   * state the merged tree cannot reach.
   *
   * It is **declined**, which is a real terminal answer that creates nothing —
   * no campaign, no branch, no worker. Authorizing it would settle the card by
   * starting work nobody asked for, which is the more expensive way to get the
   * same picture. The card was already photographed with its Authorize button
   * intact; what this removes is a decision that has been made.
   */
  const pending = await fetch(`${BASE}/api/russell/projects/${await firstProjectId(cookie)}/software`, {
    headers: { cookie },
  })
    .then(async (response) => (response.ok ? ((await response.json()) as Record<string, unknown>) : null))
    .catch(() => null);
  const requests = Array.isArray(pending?.['software'])
    ? (pending['software'] as Record<string, unknown>[])
    : [];
  for (const entry of requests) {
    const request = entry['request'] as Record<string, unknown> | undefined;
    const id = request?.['id'];
    if (typeof id !== 'string') continue;
    // The view's own derivation of "this is what a person has to answer next",
    // rather than a state string guessed from outside the module that owns it.
    if (entry['awaitingPerson'] !== true) continue;
    await fetch(`${BASE}/api/russell/software/${id}/decline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, cookie },
      body: JSON.stringify({ reason: 'Not part of this run — the card has already been captured.' }),
    }).catch(() => null);
  }
  console.log('');
  await withChromium(async (cdp) => {
    await signInBrowser(cdp, cookie);
    for (const viewport of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 2,
        mobile: viewport.width < 600,
      });
      await cdp.send('Page.navigate', { url: `${BASE}/needs-you` });
      await waitFor(cdp, "document.querySelector('.rs-shell') !== null");
      const settled = await waitFor(cdp, "document.querySelector('.rs-nothing') !== null", 15_000);
      await sleep(900);
      const shot = (await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
      })) as { data: string };
      const bytes = Buffer.from(shot.data, 'base64');
      fs.writeFileSync(path.join(outputDir, `${viewport.name}-needs-you-settled.png`), bytes);
      declared.push(writeRender(rendersDir, 'needs-you-empty', viewport.width, bytes));
      console.log(
        `${viewport.name.padEnd(8)} ${'needs-you-empty'.padEnd(10)} ` +
          `${settled ? 'settled' : 'STILL SHOWS A DECISION'}`,
      );
      if (!settled) {
        found.push(
          `needs-you-empty at ${viewport.width}px: the page still shows a decision after the ` +
            'journey answered the only one there was',
        );
      }
    }
  });
  return found;
}

/** One browser, one signed-in person, one path through the product. */
async function driveJourney(
  cookie: string,
  outputDir: string,
  constellation: ({ width: number } & ConstellationReading)[],
): Promise<string[]> {
  const findings: string[] = [];
  console.log('');
  console.log('Seeding something to decide, through the product’s own doors:');
  /*
   * Seeded first, and **before** the standing authority is granted, because
   * that ordering is the story this journey tells.
   *
   * An idea captured into a project with no standing grant is judged and
   * *parked* — Brain may not research here yet — so it stays in the backlog
   * where a person can find it. An idea captured after the grant is judged,
   * specified and launched within a tick or two, which is correct and leaves
   * nothing on the Ideas page to press.
   *
   * Both orderings have now been run. The second produced three findings that
   * all read as missing controls and were all the harness racing the product,
   * which is why this comment is longer than the line it explains.
   */
  const seeded = await seedSomethingToDecide(cookie);
  console.log(`  ${seeded.note}`);
  if (seeded.candidateId === null) {
    findings.push(`the journey had nothing to act on: ${seeded.note}`);
  }
  let parked: Parked = {
    missionId: null,
    requestId: null,
    orchestrationId: null,
    stateBefore: null,
    packetBefore: null,
    note: 'the journey did not get that far',
  };
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
    /*
     * The Needs You answer, pressed inside the journey rather than only in the
     * render pass.
     *
     * The standing authority is the one decision a project cannot proceed
     * without, and answering it is a **journey** step: a person opens Needs
     * You, reads what Russell may do, and approves. It used to happen only when
     * `--renders` was passed, so a journey run reached the effects check with
     * nothing pressed and reported "approved on screen and no grant is
     * recorded" — a finding about the harness, not the product.
     *
     * It is also what unblocks everything after it: no grant, no mission, and
     * Work has nothing to show.
     */
    /*
     * Already granted is a fact, not a failure — and reporting it as one cost a
     * whole run.
     *
     * With `--renders`, the capture pass answers this same decision before the
     * journey starts, because `needs-you-empty` is the settled state of one
     * address and pressing its own Approve is how you get there. The journey
     * then found no Approve control and called it "the one decision on Needs
     * You could not be answered from the screen" — which is false of a build
     * where it had just been answered twenty minutes earlier.
     */
    const alreadyGranted = await standingGrantExists(cookie);
    const answered = alreadyGranted ? true : await grantStandingAuthority(cdp);
    console.log(
      `  needs-you answer   ${
        alreadyGranted
          ? 'already granted earlier in this run — the render pass pressed the same control'
          : answered
            ? 'approved, and the card swapped its control'
            : 'COULD NOT APPROVE'
      }`,
    );
    if (!answered) {
      findings.push('the one decision on Needs You could not be answered from the screen');
    }

    findings.push(...(await walk(cdp, outputDir, JOURNEY_WORK)));
    /*
     * The wait between promoting an idea and being asked about it.
     *
     * Not a control, so not a step. Russell's tick is thirty seconds and the
     * chain is four of them — judge, compile, launch, park — so this is the
     * harness doing what a person does between opening the app twice.
     */
    console.log('  waiting for Russell to reach a decision it cannot take…');
    parked = await waitForParkedDecision(cookie, seeded);
    console.log(`  the parked decision  ${parked.note}`);
    if (parked.requestId === null) {
      findings.push(
        `the journey never reached a parked decision to answer: ${parked.note}`,
      );
    }
    findings.push(...(await walk(cdp, outputDir, JOURNEY_DECISION)));
    findings.push(...(await walk(cdp, outputDir, JOURNEY_AFTER)));
    /*
     * What the technical detail actually said, held against the ids Brain
     * wrote.
     *
     * Read off the screen after the walk rather than inside the step, because
     * the step's job is to press and this one's is to check — and what it
     * checks is that the pairs a person can see name **this** mission and
     * **this** packet, rather than merely being present and plausible.
     */
    const pairs = JOURNEY_READS['21-what-the-work-actually-is'] ?? '';
    JOURNEY_EFFECTS.workIdsOnScreen = pairs || null;
    JOURNEY_EFFECTS.workIdentifiedOnScreen =
      parked.missionId !== null &&
      pairs.includes(parked.missionId) &&
      (parked.orchestrationId === null || pairs.includes(parked.orchestrationId));
    const filed = /Filed document=(\S+)/.exec(pairs);
    JOURNEY_EFFECTS.filedDocumentOnScreen = filed ? (filed[1] ?? null) : null;
    console.log(
      `  the work, identified ${
        JOURNEY_EFFECTS.workIdentifiedOnScreen
          ? `on screen by its own ids — ${pairs.slice(0, 90)}`
          : `NOT MATCHED — read "${pairs.slice(0, 90)}"`
      }`,
    );
    if (parked.missionId !== null && JOURNEY_EFFECTS.workIdentifiedOnScreen === false) {
      findings.push(
        'the mission’s technical detail on the phone does not name the mission and packet the ' +
          'journey actually caused',
      );
    }
    /*
     * The effects, read out of the database rather than off the screen.
     *
     * A page that says a priority changed and a row that changed are different
     * facts, and only the second one survives a reload. This asks the product's
     * own read routes, as the same signed-in person, inside the same journey —
     * so a step that appeared to work and did not is a finding here rather than
     * something noticed weeks later.
     */
    findings.push(...(await persistedEffects(cookie, seeded, parked)));
    findings.push(...(await walk(cdp, outputDir, JOURNEY_OUT)));
    findings.push(
      ...(await reachabilityProbe(
        cdp,
        outputDir,
        `journey-23-everywhere-from-${PHONE.width}.png`,
        PHONE.width,
      )),
    );
    findings.push(...(await narrowPhoneBar(cdp, outputDir)));
    findings.push(
      ...(await reachabilityProbe(
        cdp,
        outputDir,
        `journey-25-everywhere-from-${NARROW_PHONE}.png`,
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

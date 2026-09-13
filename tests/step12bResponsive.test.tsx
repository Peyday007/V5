// @vitest-environment jsdom
/**
 * The widths the owner rejected, and the ones a phone actually is.
 *
 * §24 names the sizes to validate — 360 and 390 for phones, the problematic
 * 822 and 953 intermediates where the September 11 captures clipped, and a
 * normal desktop around 1440 — and is explicit that these are samples rather
 * than the only supported sizes.
 *
 * What can genuinely be asserted in jsdom is the part that was actually wrong:
 * the *decisions*. jsdom does not lay out, so a screenshot test here would
 * prove nothing; but the navigation mode, the container-query rules, the
 * gutters and the absence of anything wider than the screen are all decidable
 * from the code, and those are what produced the clipping.
 *
 * The one thing this file refuses to do is claim a passing assertion here is a
 * passing design. §24 says it directly: a screenshot test protects an approved
 * baseline and cannot approve a bad one.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { navigationMode, PHONE_MAX_WIDTH } from '../client/src/russell/present.ts';

const CSS = fs.readFileSync(
  path.join(process.cwd(), 'client/src/russell/design.css'),
  'utf8',
);

/** The sample widths §24 names. */
const WIDTHS = [360, 390, 720, 822, 953, 1440];

describe('the shell decides its layout from the width, testably', () => {
  it('uses a thumb bar on a phone and a rail on a desktop', () => {
    expect(navigationMode(360)).toBe('BAR');
    expect(navigationMode(390)).toBe('BAR');
    expect(navigationMode(PHONE_MAX_WIDTH)).toBe('BAR');
    expect(navigationMode(PHONE_MAX_WIDTH + 1)).toBe('RAIL');
    expect(navigationMode(822)).toBe('RAIL');
    expect(navigationMode(953)).toBe('RAIL');
    expect(navigationMode(1440)).toBe('RAIL');
  });

  it('answers for every width §24 names, with no gap in the middle', () => {
    for (const width of WIDTHS) {
      expect(['BAR', 'RAIL']).toContain(navigationMode(width));
    }
  });
});

describe('the stylesheet reflows on its own width, not the window’s', () => {
  /*
   * The actual cause of the rejected clipping.
   *
   * Content clipped at roughly 822-953px because a media query asked the
   * *viewport* how wide it was while the element doing the clipping was a
   * column inside a rail. A container query asks the container, so the same
   * component is right on a phone and in a drawer without a second rule.
   */
  it('establishes a container on the main reading area', () => {
    expect(CSS).toMatch(/\.rs-main\s*\{[^}]*container-type:\s*inline-size/);
    expect(CSS).toMatch(/container-name:\s*rs-main/);
  });

  it('has container queries at the widths that were clipping', () => {
    expect(CSS).toMatch(/@container rs-main \(max-width: 980px\)/);
    expect(CSS).toMatch(/@container rs-main \(max-width: 720px\)/);
  });

  it('collapses a multi-column grid to one column before a phone width', () => {
    const narrow = CSS.slice(CSS.indexOf('@container rs-main (max-width: 980px)'));
    expect(narrow).toMatch(/\.rs-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });
});

describe('nothing is wider than the screen it is on', () => {
  it('lets every shell child shrink below its content', () => {
    // A grid item's default `min-width: auto` refuses to shrink below its
    // content's minimum, which is how one long sentence made every screen
    // scroll sideways.
    expect(CSS).toMatch(/\.rs-shell\s*>\s*\*\s*\{\s*min-width:\s*0/);
  });

  it('keeps a side gutter at every width, set once', () => {
    expect(CSS).toMatch(/\.rs-main\s*\{[^}]*padding:\s*var\(--gap-5\)/);
    const phone = CSS.slice(CSS.indexOf('@container rs-main (max-width: 720px)'));
    expect(phone).toMatch(/\.rs-main\s*\{\s*padding:\s*var\(--gap-4\)/);
  });

  it('gives a table, a map and a code block their own scroller rather than the page', () => {
    // Only these may exceed the measure, and each inside its own container —
    // the page body must never scroll horizontally.
    expect(CSS).toMatch(/\.rs-table-wrap\s*\{\s*overflow-x:\s*auto/);
    expect(CSS).toMatch(/\.rs-map\s*\{[^}]*overflow-x:\s*auto/);
    expect(CSS).toMatch(/\.rs-tabs\s*\{[^}]*overflow-x:\s*auto/);
  });

  it('declares no min-width wider than a phone anywhere', () => {
    const widths = [...CSS.matchAll(/min-width:\s*(\d+)px/g)].map((match) => Number(match[1]));
    for (const width of widths) expect(width).toBeLessThanOrEqual(360);
  });
});

describe('touch, keyboard, motion and both themes', () => {
  it('gives every tappable control a comfortable target', () => {
    // 44px is the smallest target a thumb reliably hits, and the rail, the
    // buttons and the command bar all declare it rather than inheriting one.
    expect(CSS).toMatch(/\.rs-rail-item\s*\{[^}]*min-height:\s*44px/);
    expect(CSS).toMatch(/min-height:\s*44px/);
    const phoneRail = CSS.slice(CSS.indexOf('.rs-shell-bar .rs-rail-item'));
    expect(phoneRail).toMatch(/min-height:\s*56px/);
  });

  it('gives keyboard focus a visible state on every interactive element', () => {
    expect(CSS).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--verdigris\)/);
  });

  it('honours reduced motion', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it('defines the complete light palette on bare :root, and redefines it for dark', () => {
    /*
     * The three-state rule.
     *
     * An explicit choice stamps `data-theme`; the default "system" setting
     * stamps nothing, so only `prefers-color-scheme` separates light from dark
     * for most viewers. A colour whose only definition sits behind
     * `[data-theme]` never applies in the un-stamped state, and the page
     * renders one theme's text on the other theme's ground.
     */
    const light = CSS.slice(CSS.indexOf('.rs-shell,'), CSS.indexOf('@media (prefers-color-scheme: dark)'));
    expect(light).toMatch(/--paper:/);
    expect(light).toMatch(/--ink:/);
    expect(light).toMatch(/--verdigris:/);
    expect(CSS).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(CSS).toMatch(/:root:not\(\[data-theme='light'\]\)|\.rs-shell:not\(\[data-theme='light'\]\)/);
    expect(CSS).toMatch(/\[data-theme='dark'\]/);
  });

  it('paints the shell’s own background rather than borrowing the host’s', () => {
    expect(CSS).toMatch(/\.rs-shell\s*\{[^}]*background:\s*var\(--paper\)/);
  });

  it('names no literal colour outside the token blocks', () => {
    /*
     * Tokens, and only tokens, carry colour.
     *
     * A component rule that named a hex value would be correct in one theme
     * and wrong in the other, which is how a page ends up half-finished. The
     * exceptions are the two literals that are genuinely theme-independent:
     * white on the accent, and the near-black on the ochre badge.
     */
    const afterTokens = CSS.slice(CSS.indexOf('/* ------------------------------------------------------------------ boot -- */'));
    const literals = [...afterTokens.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0]);
    const allowed = new Set(['#ffffff', '#1a1408']);
    for (const literal of literals) {
      expect(allowed.has(literal.toLowerCase())).toBe(true);
    }
  });
});

/**
 * The two defects a screenshot found and an assertion could not.
 *
 * Everything above is decidable in jsdom because it is a *decision*: a
 * breakpoint, a query type, a gutter, a minimum size. These two are not. They
 * are a name that is wider than the box holding it and three labels that touch,
 * and both need a layout engine and a font to exist at all — which is exactly
 * why §24 says a passing assertion is not a passing design and keeps the visual
 * confirmation with the owner.
 *
 * So these tests do not claim to detect the defect. They pin the *rule that
 * fixes it*, so a later edit that removes it fails here instead of being found
 * again by looking at a picture.
 */
describe('what the 900px capture found', () => {
  it('lets a foundation name break inside a word rather than outside its cell', () => {
    // `Which opportunities are worth it` lost its last letter at 900px: the
    // longest token in the name was wider than a 96px track, and there is no
    // space inside a word to break at.
    const block = CSS.slice(CSS.indexOf('.rs-foundation-name'), CSS.indexOf('.rs-foundation-state'));
    expect(block).toMatch(/overflow-wrap:\s*anywhere/);

    const strip = CSS.slice(CSS.indexOf('.rs-foundations'), CSS.indexOf('.rs-foundation::before'));
    // Wide enough for the longest token these names actually contain, and the
    // grid item allowed to shrink to its track rather than to its content.
    expect(strip).toMatch(/minmax\(120px, 1fr\)/);
    expect(strip).toMatch(/min-width:\s*0/);
  });

  it('keeps the three depth labels apart, and truncates rather than overruns', () => {
    // The capture read "Normal InterestedTechnical" — two of three controls
    // with nothing between them. A gap separates them; the ellipsis is what a
    // shrunk button does instead of painting over its neighbour.
    const block = CSS.slice(CSS.indexOf('.rs-depth {'), CSS.indexOf(".rs-depth button[aria-pressed='true']"));
    expect(block).toMatch(/gap:\s*2px/);
    expect(block).toMatch(/text-overflow:\s*ellipsis/);
    expect(block).toMatch(/overflow:\s*hidden/);
  });
});

/**
 * What walking the journey on a phone found, which reading could not.
 *
 * `.rs-shell-bar .rs-rail-foot` was `display: none`. That one declaration took
 * **Search, the depth control and the whole More menu** off a phone — and with
 * More went Build, Connected sites, the full console and **Sign out**. Every
 * assertion above passed the entire time, because none of them asks whether a
 * control a person needs is anywhere they can press it: the markup was correct,
 * the routes were correct, the deep links worked, and the shell even carried a
 * `mode === 'BAR'` branch inside that menu written specifically for phone width,
 * which nothing could ever reach.
 *
 * That is §29's own rule about the visual gate, arriving from the other
 * direction: a screenshot cannot approve a design, and an assertion cannot see
 * a control that is not on the screen. `scripts/visual-qa.ts` presses every
 * thumb-bar cell and the send button at every step of a real journey and asks
 * `elementFromPoint` whether the press would land — which is how this was found.
 *
 * These tests do not reproduce that. They pin the rules that fix it, so an edit
 * that removes one fails here instead of being found again by a person on a
 * phone who cannot sign out.
 */
describe('what the phone journey found', () => {
  const SHELL = fs.readFileSync(
    path.join(process.cwd(), 'client/src/russell/RussellShell.tsx'),
    'utf8',
  );

  const rule = (selector: string): string => {
    const at = CSS.indexOf(selector);
    expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
    return CSS.slice(at, CSS.indexOf('}', at));
  };

  it('keeps the rail’s foot on a phone rather than deleting it', () => {
    const foot = rule('.rs-shell-bar .rs-rail-foot {');
    expect(foot).not.toMatch(/display:\s*none/);
    // A row, because at this width it is one cell of the thumb bar.
    expect(foot).toMatch(/flex-direction:\s*row/);
  });

  it('sizes the More cell like the six beside it, from one number', () => {
    // The sheet has to clear the bar exactly, so the bar's height is a token
    // rather than a literal repeated in three rules. `.rs-shell-bar
    // .rs-rail-item` keeps its own literal — the assertion above is about that
    // rule and must stay about that rule — so this is what stops the two
    // drifting apart, which is the failure a sheet sitting over its own nav is.
    const token = /--bar-cell:\s*(\d+)px/.exec(CSS);
    expect(token).not.toBeNull();
    const phoneRail = CSS.slice(CSS.indexOf('.rs-shell-bar .rs-rail-item'));
    const cell = /min-height:\s*(\d+)px/.exec(phoneRail);
    expect(cell).not.toBeNull();
    expect(cell?.[1]).toBe(token?.[1]);
    expect(rule('.rs-shell-bar .rs-more > button {')).toMatch(/min-height:\s*var\(--bar-cell\)/);
  });

  it('opens the phone sheet outside the bar that clips it', () => {
    /*
     * The bar sets `overflow-x: hidden` deliberately, and CSS computes the other
     * axis to `auto` the moment one axis is not `visible` — so an absolutely
     * positioned sheet inside it is clipped on both axes and opens into nothing.
     * The sheet escapes the clip; the clip is not opened up for the sheet.
     */
    const sheet = rule('.rs-shell-bar .rs-menu {');
    expect(sheet).toMatch(/position:\s*fixed/);
    expect(sheet).toMatch(/bottom:\s*calc\(var\(--bar-cell\)/);
    expect(rule('.rs-shell-bar .rs-rail {')).toMatch(/overflow-x:\s*hidden/);
  });

  it('keeps the composer’s hint on one line rather than half of a second', () => {
    /*
     * The box is one row tall. At 360px the hint wrapped and the thumb bar
     * sliced its second line in half — at 390px it fits, which is why a sample
     * at one phone width would have missed it and why §24 names two.
     *
     * Truncating rather than growing the box is the same answer `.rs-depth`
     * already gives. `nowrap` is the half that does the work; Chromium renders
     * no ellipsis on a textarea placeholder, and the declaration is kept
     * because the intent is right — which the stylesheet says in those words
     * rather than letting a reader assume the character appears.
     */
    const hint = rule('.rs-command textarea::placeholder {');
    expect(hint).toMatch(/white-space:\s*nowrap/);
    expect(hint).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('leaves every rail-foot control somewhere a phone can reach', () => {
    /*
     * Source text rather than a render, for the reason the head of this file
     * gives: what is decidable here is the *decision*. The decision is that
     * nothing in the foot is dropped at thumb-bar width — Search and the depth
     * control move into the sheet, and the two secondary destinations were
     * already written to. The proof that they are pressable is the journey's
     * capture, not this.
     */
    const opens = SHELL.indexOf('<ul className="rs-menu"');
    expect(opens).toBeGreaterThan(-1);
    const sheet = SHELL.slice(opens, SHELL.indexOf('</ul>', opens));

    expect(sheet).toMatch(/go\(\{ name: 'SEARCH' \}\)/);
    expect(sheet).toMatch(/<DepthChoice/);
    expect(sheet).toMatch(/section\.label/);
    expect(sheet).toMatch(/Full console/);
    expect(sheet).toMatch(/Sign out/);

    // And the rail keeps them beside it at rail width rather than in a menu.
    expect(SHELL).toMatch(/mode === 'RAIL' \? \(/);
    // One definition of the three depth controls, used by both placements: two
    // copies is two sets of choices waiting to disagree.
    expect(SHELL.match(/<DepthChoice/g)).toHaveLength(2);
    expect(SHELL.match(/function DepthChoice/g)).toHaveLength(1);
  });
});

/**
 * What measuring the constellation found, which every assertion above passed.
 *
 * The owner's rejection named an obstructed diagram, and the number behind it
 * was taken by `scripts/visual-qa.ts --only=constellation` against a real
 * server: at a 390px viewport the project constellation drew **nine nodes with
 * nine overlapping pairs on a 316×316 canvas, worst pair 2385px²**, and at 360px
 * thirteen pairs. The 953px intermediate — which nothing had ever measured —
 * overlapped too, by one pair.
 *
 * Two rules in this stylesheet were making it worse rather than better, and both
 * are gone: a container query turned the canvas into a **square** below 520px,
 * which is shorter than a 16/10 box at the same width and took away the one axis
 * the ring had room on; and it widened a node to `46cqw`, which is a bigger box
 * in a smaller space.
 *
 * What replaced them is a different arrangement rather than the same one
 * squeezed — a grid, where two nodes in different cells are disjoint whatever
 * the label does. These pin the rules that make that true, in the spirit of the
 * two blocks above: the assertion cannot see the overlap, so it holds the
 * decision that removed it.
 */
describe('what measuring the constellation found', () => {
  const rule = (selector: string): string => {
    const at = CSS.indexOf(selector);
    expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
    return CSS.slice(at, CSS.indexOf('}', at));
  };

  it('never squeezes the canvas into a square on a narrow screen', () => {
    // The square was a container query, and it is the thing that has to stay
    // absent: it is invisible to every other test here and it made the pile-up
    // worse at exactly the width it was written for.
    expect(CSS).not.toMatch(/aspect-ratio:\s*1\s*\/\s*1/);
    expect(CSS).not.toMatch(/max-width:\s*46cqw/);
  });

  it('takes the canvas’s proportions from the component, in one place', () => {
    /*
     * The layout decision needs the canvas's height to know how much room the
     * ellipse has, and the stylesheet needs it to size the box. One of them owns
     * it — `Constellation.tsx` — and this reads it, so the two cannot drift into
     * describing different canvases.
     */
    expect(rule('.lim-canvas {')).toMatch(/aspect-ratio:\s*var\(--lim-aspect/);
  });

  it('places the narrow arrangement with a grid rather than with arithmetic', () => {
    /*
     * The whole of the fix, as a property rather than a tuning. Two nodes in two
     * cells cannot be painted over each other however long their labels are,
     * which is what "no overlap" now means here — where the ring's own record is
     * only that it was measured not to overlap.
     */
    const nodes = rule(".lim-canvas[data-layout='spine'] .lim-nodes {");
    expect(nodes).toMatch(/display:\s*grid/);
    expect(nodes).toMatch(/grid-template-columns:\s*1fr 1fr/);
    // The column gap is the trunk's gutter: every connector runs down the middle
    // of the canvas, so a route to the last row cannot cross the rows above it.
    expect(nodes).toMatch(/gap:\s*var\(--gap-4\) var\(--gap-5\)/);

    const node = rule(".lim-canvas[data-layout='spine'] .lim-node {");
    expect(node).toMatch(/position:\s*static/);
    expect(node).toMatch(/transform:\s*none/);

    const hub = rule(".lim-canvas[data-layout='spine'] .lim-node.is-centre {");
    expect(hub).toMatch(/grid-column:\s*1 \/ -1/);
  });

  it('keeps a long name inside its own node instead of over its neighbour', () => {
    // `Decision Routing Rules · 2` at a 119px column has no space to break at in
    // its longest token, which is the same defect `.rs-foundation-name` already
    // carries this declaration for.
    expect(rule('.lim-node {')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

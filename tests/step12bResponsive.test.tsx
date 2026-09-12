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

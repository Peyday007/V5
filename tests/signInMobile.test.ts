/**
 * The login journey on a phone, asserted where the defect actually lived.
 *
 * ---------------------------------------------------------------------------
 * Why a stylesheet is read rather than a screen rendered
 * ---------------------------------------------------------------------------
 *
 * Safari on iOS zooms the page to fit whenever a **focused input's font is
 * smaller than 16px**, and it does not zoom back out afterwards. It is a rule
 * of the platform rather than a rendering detail, which is what makes it
 * assertable from here: the condition is a number in a stylesheet, and a
 * violation is a number below sixteen.
 *
 * It is also why nothing else caught it. jsdom does not lay out and never
 * zooms; a desktop browser does not either; and the two screens it was wrong
 * on are exactly the two nobody opens on a desktop by choice — the sign-in
 * screen and the enrolment link a new member taps on their phone. So the
 * whole first visit jumped under somebody's thumb while they were choosing
 * the credential this Brain now runs on, and every test of that journey
 * passed.
 *
 * The identity box was 14px; the enrolment boxes inherited the 15px body step.
 * The PIN box on the sign-in screen was already 20px and always behaved, which
 * is how the two fields beside each other came to behave differently.
 *
 * ---------------------------------------------------------------------------
 *
 * This asserts the property and not the picture. It cannot say the screen
 * looks right, and it does not try to: what it says is that no field in the
 * journey can silently go back under the threshold.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** Below this, iOS zooms a focused field. It is Safari's number, not ours. */
const NO_ZOOM_MINIMUM_PX = 16;

const SHEETS = {
  'client/src/styles.css': fs.readFileSync(
    path.join(process.cwd(), 'client/src/styles.css'),
    'utf8',
  ),
  'client/src/russell/design.css': fs.readFileSync(
    path.join(process.cwd(), 'client/src/russell/design.css'),
    'utf8',
  ),
};

/** The declarations of one rule, by selector, flattened. */
function ruleFor(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|[},/*\\s])${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return match ? (match[2] ?? null) : null;
}

function fontSizePx(declarations: string): number | null {
  const px = /font-size:\s*([0-9.]+)px/.exec(declarations);
  if (px) return Number(px[1]);
  const rem = /font-size:\s*([0-9.]+)rem/.exec(declarations);
  if (rem) return Number(rem[1]) * 16;
  return null;
}

/**
 * Every field somebody types into between opening Brain and being inside it.
 *
 * Named one at a time rather than matched by a pattern, because the thing that
 * went wrong was a field nobody had thought about — so the list has to be the
 * journey rather than a shape that happens to catch today's classes.
 */
const LOGIN_FIELDS = [
  { sheet: 'client/src/styles.css', selector: '.signin__input', what: 'the name or email box' },
  {
    sheet: 'client/src/styles.css',
    selector: '.signin__input--pin',
    what: 'the six-digit PIN box',
  },
  {
    sheet: 'client/src/russell/design.css',
    selector: '.rs-enrol-input',
    what: "the PIN boxes on an enrolment link",
  },
] as const;

describe('the login journey on a phone', () => {
  it('never focuses a field small enough for iOS to zoom the page', () => {
    for (const field of LOGIN_FIELDS) {
      const rule = ruleFor(SHEETS[field.sheet], field.selector);
      expect(rule, `${field.selector} (${field.what}) has no rule in ${field.sheet}`).not.toBeNull();
      const size = fontSizePx(rule as string);
      expect(
        size,
        `${field.selector} (${field.what}) states no font-size, so it inherits one — and the ` +
          'body step is below the threshold, which is exactly how this went wrong',
      ).not.toBeNull();
      expect(
        size as number,
        `${field.selector} (${field.what}) is ${String(size)}px; iOS zooms anything under ` +
          `${NO_ZOOM_MINIMUM_PX}px when it is focused`,
      ).toBeGreaterThanOrEqual(NO_ZOOM_MINIMUM_PX);
    }
  });

  it('keeps the sign-in card inside a phone, with no width it cannot fit', () => {
    const card = ruleFor(SHEETS['client/src/styles.css'], '.signin__card');
    expect(card).not.toBeNull();
    // `max-width` is a ceiling and fits anything narrower; a `min-width` or a
    // fixed `width` in pixels is what puts a card off the side of a phone.
    expect(card as string).toMatch(/width:\s*100%/);
    expect(card as string).not.toMatch(/min-width/);
    const fixed = /(^|[^-])width:\s*([0-9.]+)px/.exec(card as string);
    expect(fixed, 'the card states a fixed pixel width').toBeNull();
  });

  it('asks for a digit keypad rather than a full keyboard, on both screens', () => {
    for (const file of ['client/src/components/SignIn.tsx', 'client/src/components/Enrol.tsx']) {
      const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      /*
       * Comments stripped first, because both of these files *explain* why
       * `type="number"` is wrong — and the first version of this assertion
       * failed on the explanation. This repository has made that mistake twice
       * already in tests that read source, and prose is not code.
       */
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      expect(code, `${file} does not ask for a numeric keypad`).toMatch(/inputMode="numeric"/);
      /*
       * Never `type="number"`, which on a phone offers a spinner, strips a
       * leading zero and lets an arrow key change a credential. A PIN of
       * `012345` has to survive being typed.
       */
      expect(code, `${file} uses type="number" for a PIN`).not.toMatch(/type="number"/);
    }
  });
});

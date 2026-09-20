/**
 * What is read in the page while it is on the screen.
 *
 * ---------------------------------------------------------------------------
 * Perception, and why it cannot happen later
 * ---------------------------------------------------------------------------
 *
 * A PNG has thrown away almost everything that decides whether an interface
 * works. It does not know that a button's own centre belongs to something else,
 * that a container clips rather than scrolls, that a heading outline goes from
 * `h1` to `h4`, or what the computed contrast between two colours is. All of
 * those are facts about a *live document*, and the only moment they can be taken
 * is while it is rendered.
 *
 * So the readings are taken in the page and stored on the capture beside the
 * bytes. That is what makes a measured finding reproducible: anybody can hold
 * the reading against the image and the revision, and disagreeing with it is a
 * bug report rather than a matter of taste.
 *
 * ---------------------------------------------------------------------------
 * Every reader is bounded and every reader can fail alone
 * ---------------------------------------------------------------------------
 *
 * One expression runs the lot, because eleven round trips to a debugger is
 * eleven chances to hang and `visual-qa.ts` records what an unbounded one cost:
 * fourteen minutes of a run that looked like slow progress. But a single
 * `try` around all of it would mean one reader throwing on an exotic page
 * discards the other ten, so each is wrapped and each failure goes into
 * `unreadable` by name.
 *
 * `unreadable` is not decoration. §9's rule is that a document Brain could not
 * read is something the auditor **does not have**, never an empty one — and the
 * same applies here: a reading that failed must not arrive as *nothing was
 * wrong*. `evaluate.ts` refuses to conclude a surface is clean while a reader is
 * on that list.
 *
 * ---------------------------------------------------------------------------
 * Two rules that were arrived at from real false findings
 * ---------------------------------------------------------------------------
 *
 * **A scrollable container is not a clipping one.** `overflow: auto` and
 * `scroll` are how a person reaches the rest; only `hidden` and `clip` mean the
 * content is gone. `visual-qa.ts` learned this from a finding that was wrong,
 * and the rule is copied here rather than re-derived, because arriving at it
 * twice is how two readers come to disagree.
 *
 * **An element with no box is not an unreachable control.** A `display: none`
 * node is not on the screen at all, and flagging it confuses a control that was
 * silently dropped with one the shell deliberately renders elsewhere. Whether a
 * person can still get to what it does is a question about the *set* of
 * reachable controls, which `reachableControls` answers.
 */
import type { CaptureReadings } from '../../domain/design.ts';

/**
 * The smallest interactive box that is not a finding, in CSS pixels.
 *
 * WCAG 2.2's Target Size (Minimum) is 24 by 24, and that is the number used
 * rather than the more comfortable 44, because this is a *floor* and a floor
 * somebody disagrees with is a floor they turn off. A 30-pixel control is a
 * judgement about comfort; a 16-pixel one is a control some people cannot hit.
 */
export const TOUCH_TARGET_FLOOR = 24;

/**
 * The contrast ratio below which text is reported.
 *
 * WCAG 2.1 AA for body text. Large text is allowed 3:1 and the reader applies
 * that, because reporting a 24-pixel heading at 3.5:1 as a defect is a false
 * finding — and §29 is explicit that a false finding costs more than the defect
 * it was looking for, because somebody spends an hour on it.
 */
export const CONTRAST_FLOOR = 4.5;
export const LARGE_TEXT_CONTRAST_FLOOR = 3;

/** Where the product's shell lives, so the readers do not walk the whole DOM. */
export const SHELL_ROOT = '.rs-shell';

/**
 * The one expression, evaluated in the page.
 *
 * Returns a `CaptureReadings`. Built as a string rather than a function passed
 * through a bundler because it runs in Chromium over CDP, where the only thing
 * that crosses is source text — so this is deliberately plain ES5-ish code with
 * no imports, no optional chaining on hot paths and no reliance on anything the
 * product happens to have loaded.
 */
export function readingsExpression(
  options: { shellRoot?: string; touchFloor?: number } = {},
): string {
  const root = JSON.stringify(options.shellRoot ?? SHELL_ROOT);
  const floor = options.touchFloor ?? TOUCH_TARGET_FLOOR;
  return `(() => {
  const unreadable = [];
  const partial = [];
  const take = (name, fn, fallback) => {
    try { return fn(); } catch (error) {
      unreadable.push(name + ': ' + (error && error.message ? error.message : String(error)));
      return fallback;
    }
  };

  const scope = document.querySelector(${root}) || document.body;
  const label = (el) => {
    if (!el) return 'unknown';
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
    const id = el.id ? '#' + el.id : '';
    return (el.tagName.toLowerCase() + id + cls).slice(0, 120);
  };
  const INTERACTIVE = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [tabindex]:not([tabindex="-1"])';

  /* The document scrolled sideways. Of the document, because an element
     sticking out of a container that already contains it is a different defect
     with a different fix, and \`offenders\` is what reports that one. */
  const horizontalOverflow = take('horizontalOverflow',
    () => document.documentElement.scrollWidth > window.innerWidth + 1, false);

  /* Content outside a parent that clips rather than scrolls. */
  const clipped = take('clipped', () => {
    const bad = [];
    const nodes = scope.querySelectorAll('*');
    const cap = Math.min(nodes.length, 2500);
    for (let i = 0; i < cap; i += 1) {
      const el = nodes[i];
      if (el.children.length === 0) continue;
      const style = getComputedStyle(el);
      if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') continue;
      const outer = el.getBoundingClientRect();
      if (outer.width === 0) continue;
      for (const child of el.children) {
        const box = child.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        if (box.right > outer.right + 1 || box.left < outer.left - 1) {
          bad.push(label(child) + ' inside ' + label(el));
        }
      }
    }
    return [...new Set(bad)].slice(0, 12);
  }, []);

  /* What sticks out past the viewport, and by how much. */
  const offenders = take('offenders', () => {
    const limit = document.documentElement.clientWidth;
    const bad = [];
    const nodes = scope.querySelectorAll('*');
    const cap = Math.min(nodes.length, 3000);
    for (let i = 0; i < cap; i += 1) {
      const el = nodes[i];
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.right > limit + 1 || box.left < -1) {
        bad.push(label(el) + '@' + Math.round(box.left) + '..' + Math.round(box.right) + ' of ' + limit);
      }
    }
    return bad.slice(0, 12);
  }, []);

  /* A control a thumb cannot land on, asked the way a thumb asks.
     An element with no box is not this question — see the module header.

     **A control that scrolling would bring into view is not this question
     either, and the first version of this said it was.** Driving the product
     found it on the first run: Brain's shell is a grid whose reading column
     scrolls internally, so a control below the fold of that column has a
     rectangle inside the viewport, is painted over by the command bar in the
     row beneath, and reported as covered — while scrolling reaches every one of
     them. That is the false finding §29 warns costs more than the defect it was
     looking for, and a responsive or reachability finding is the worst place to
     produce one, because it names a control as lost.

     So the condition is scroll *room* rather than the coverer's position: a
     control is unreachable only when nothing containing it can scroll it clear.
     That subsumes the sticky-overlay case, which was the first attempt at this
     rule and was right about a narrower thing. */
  const unreachable = take('unreachable', () => {
    const bad = [];
    const canBeScrolledTo = (el) => {
      let node = el.parentElement;
      while (node && node !== document.documentElement) {
        const style = getComputedStyle(node);
        const scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll';
        if (scrolls && node.scrollHeight > node.clientHeight + 1) return true;
        node = node.parentElement;
      }
      return document.documentElement.scrollHeight > window.innerHeight + 1;
    };
    for (const el of scope.querySelectorAll(INTERACTIVE)) {
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      if (box.top > innerHeight || box.bottom < 0) continue;
      if (box.left < -1 || box.right > innerWidth + 1) {
        bad.push(label(el) + ': off the side of the screen');
        continue;
      }
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (!hit) { bad.push(label(el) + ': nothing at its own centre'); continue; }
      if (el.contains(hit) || hit.contains(el)) continue;
      if (canBeScrolledTo(el)) continue;
      bad.push(label(el) + ': covered by ' + label(hit));
    }
    return bad.slice(0, 12);
  }, []);

  /* Absolutely-placed siblings painted over each other. These are in one
     stacking context, so an intersection *is* one covering the other. */
  const overlaps = take('overlaps', () => {
    const placed = [];
    const nodes = scope.querySelectorAll('*');
    const cap = Math.min(nodes.length, 1500);
    for (let i = 0; i < cap; i += 1) {
      const el = nodes[i];
      const style = getComputedStyle(el);
      if (style.position !== 'absolute') continue;
      const box = el.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) continue;
      placed.push({ el, box, parent: el.parentElement });
    }
    const bad = [];
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i], b = placed[j];
        if (a.parent !== b.parent) continue;
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        if (a.box.right <= b.box.left || b.box.right <= a.box.left) continue;
        if (a.box.bottom <= b.box.top || b.box.bottom <= a.box.top) continue;
        bad.push(label(a.el) + ' over ' + label(b.el));
      }
    }
    return bad.slice(0, 12);
  }, []);

  /* Interactive boxes under the floor. A zero box is not a small target: it is
     not on the screen, which is a different question again. */
  const smallTargets = take('smallTargets', () => {
    const bad = [];
    for (const el of scope.querySelectorAll(INTERACTIVE)) {
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      if (box.width >= ${floor} && box.height >= ${floor}) continue;
      bad.push(label(el) + ': ' + Math.round(box.width) + 'x' + Math.round(box.height));
    }
    return bad.slice(0, 12);
  }, []);

  /* Text whose computed contrast is under the floor.
     The background is resolved by walking up until something is not
     transparent, because \`getComputedStyle\` reports what the element declares
     rather than what is behind it — and reading rgba(0,0,0,0) as black is how a
     contrast checker produces confident nonsense. An element with no opaque
     ancestor is reported as unmeasurable rather than assumed white. */
  const lowContrast = take('lowContrast', () => {
    const parse = (value) => {
      const m = /rgba?\\(([^)]+)\\)/.exec(value || '');
      if (!m) return null;
      const parts = m[1].split(',').map((one) => parseFloat(one.trim()));
      if (parts.length < 3 || parts.some((one) => !isFinite(one))) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const lum = (c) => {
      const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const backdrop = (el) => {
      let node = el;
      while (node && node !== document.documentElement) {
        const c = parse(getComputedStyle(node).backgroundColor);
        if (c && c.a >= 0.95) return c;
        node = node.parentElement;
      }
      const body = parse(getComputedStyle(document.body).backgroundColor);
      return body && body.a >= 0.95 ? body : null;
    };
    const bad = [];
    let unmeasured = 0;
    const nodes = scope.querySelectorAll('p, span, a, button, li, td, th, h1, h2, h3, h4, h5, h6, label, small, div');
    const cap = Math.min(nodes.length, 1200);
    for (let i = 0; i < cap; i += 1) {
      const el = nodes[i];
      let own = '';
      for (const child of el.childNodes) if (child.nodeType === 3) own += child.textContent;
      if (own.trim().length < 2) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.opacity === '0') continue;
      const fg = parse(style.color);
      const bg = backdrop(el);
      if (!fg || !bg) { unmeasured += 1; continue; }
      if (fg.a < 0.95) { unmeasured += 1; continue; }
      const L1 = lum(fg), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(style.fontSize) || 16;
      const weight = parseInt(style.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const floor = large ? ${LARGE_TEXT_CONTRAST_FLOOR} : ${CONTRAST_FLOOR};
      if (ratio + 0.01 < floor) {
        bad.push(label(el) + ': ' + ratio.toFixed(2) + ':1 against ' + floor + ':1 (' + Math.round(size) + 'px)');
      }
    }
    if (unmeasured > 0) partial.push('lowContrast: ' + unmeasured + ' element(s) had no opaque backdrop to measure against, so their contrast is unknown rather than acceptable');
    return bad.slice(0, 12);
  }, []);

  /* Every chrome destination pressable right now, in the resting state.
     Pressable rather than present: it has a box, it is on the screen, and its
     own centre belongs to it. A trailing badge count is stripped, because a set
     that told "Needs you" from "Needs you1" would be a set about rendering.

     This is only half the answer at narrow widths, where the rest live behind a
     disclosure and are not in the DOM until it opens. \`revealExpression\` below
     is the other half and \`capture.ts\` unions the two — see the correction
     recorded there. */
  const reachableControls = take('reachableControls', () => {
    const names = new Set();
    for (const el of document.querySelectorAll(
      '.rs-rail button, .rs-rail a, .rs-shell-bar button, .rs-shell-bar a, ' +
        '.rs-sheet button, .rs-sheet a, nav button, nav a',
    )) {
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      if (box.left < -1 || box.right > innerWidth + 1) continue;
      if (box.top > innerHeight || box.bottom < 0) continue;
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (!hit) continue;
      if (!(el.contains(hit) || hit.contains(el))) continue;
      let name = (el.textContent || '').trim().replace(/\\s*\\d+$/, '').trim();
      if (name.startsWith('More')) name = 'More';
      if (name) names.add(name.slice(0, 40));
    }
    return [...names];
  }, []);

  /* How deep the boxes go. A judged input rather than a verdict: nesting is not
     wrong at any particular number, and what a reviewer needs is the number and
     where it is. */
  const deepestNesting = take('deepestNesting', () => {
    let best = null;
    const walk = (el, depth) => {
      const style = getComputedStyle(el);
      const boxy = style.borderWidth !== '0px' || style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.boxShadow !== 'none';
      const next = boxy ? depth + 1 : depth;
      if (!best || next > best.depth) best = { depth: next, where: label(el) };
      for (const child of el.children) walk(child, next);
    };
    walk(scope, 0);
    return best;
  }, null);

  const counts = take('counts', () => ({
    interactive: scope.querySelectorAll(INTERACTIVE).length,
    headings: scope.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
    landmarks: scope.querySelectorAll('main, nav, aside, header, footer, section[aria-label], [role="main"], [role="navigation"]').length,
    textNodes: scope.querySelectorAll('p, li, td, span').length,
  }), { interactive: 0, headings: 0, landmarks: 0, textNodes: 0 });

  /* The page's own heading outline, in document order. This is the hierarchy as
     the DOM has it, which is exactly what a judged reviewer needs and cannot get
     from an image — and what a screen reader gets instead of the picture. */
  const outline = take('outline', () => {
    const out = [];
    for (const el of scope.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      out.push({ level: Number(el.tagName.slice(1)), text: (el.textContent || '').trim().slice(0, 120) });
      if (out.length >= 60) break;
    }
    return out;
  }, []);

  return {
    horizontalOverflow, clipped, offenders, unreachable, overlaps, smallTargets,
    lowContrast, reachableControls, deepestNesting, counts, outline, unreadable, partial,
  };
})()`;
}

/**
 * Every chrome destination reachable **in one press or in two**.
 *
 * Evaluated after the screenshot, and it is the second half of
 * `reachableControls` rather than a replacement for it. The resting page cannot
 * answer this question: at phone width Brain's rail is gone and its
 * destinations live inside a sheet that is not in the DOM until something opens
 * it, so a reader of the resting state reports Search, Build, Connected sites,
 * Cash and Sign out as unreachable — which is **wrong**, and driving the
 * product is what showed it. §29 settles the rule: *reached in one press or in
 * two — through More is still reached — which is why the probe opens the sheet
 * before it answers.*
 *
 * The correction matters more than the reader. A responsive-regression finding
 * is the most expensive kind this kernel produces — it names a feature as lost
 * — so producing one falsely would teach a reader to stop believing the one
 * check that catches a real one. §29 records exactly that damage from a warning
 * that cried wolf.
 *
 * It opens rather than toggles: every disclosure it presses stays open, and the
 * screenshot has already been taken, so the picture is still of the resting
 * state and only the *set* is affected. Bounded to a handful of presses,
 * because an unbounded walk of a page's controls is a click storm.
 */
export function revealExpression(limit = 4): string {
  return `(() => {
  const opened = [];
  const toggles = [...document.querySelectorAll('button')].filter((el) => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const label = (el.textContent || '').trim();
    return el.getAttribute('aria-expanded') === 'false' || /^more\\b/i.test(label);
  });
  for (const toggle of toggles.slice(0, ${limit})) {
    try { toggle.click(); opened.push((toggle.textContent || '').trim().slice(0, 24) || 'a disclosure'); }
    catch { /* a toggle that will not open is not a reading */ }
  }
  return opened;
})()`;
}

/**
 * What a reading looks like when nothing could be read at all.
 *
 * Used where a capture exists and the page never answered. Deliberately not
 * "everything is fine with empty lists": `unreadable` carries the reason, and
 * `evaluate.ts` will not call a surface clean while it is non-empty.
 */
export function unreadableReadings(reason: string): CaptureReadings {
  return {
    horizontalOverflow: false,
    clipped: [],
    offenders: [],
    unreachable: [],
    overlaps: [],
    smallTargets: [],
    lowContrast: [],
    reachableControls: [],
    deepestNesting: null,
    counts: { interactive: 0, headings: 0, landmarks: 0, textNodes: 0 },
    outline: [],
    unreadable: [reason],
    partial: [],
  };
}

/**
 * Coerce whatever the page returned into the readings shape.
 *
 * A page can return anything, including nothing, and a reader that trusted the
 * shape would put `undefined` on a row that the rest of the kernel then treats
 * as an empty list. Everything missing becomes an entry in `unreadable` rather
 * than a default that reads as *we checked and it was fine*.
 */
export function coerceReadings(value: unknown): CaptureReadings {
  if (typeof value !== 'object' || value === null) {
    return unreadableReadings('the page returned nothing that could be read as a set of readings');
  }
  const raw = value as Record<string, unknown>;
  const missing: string[] = [];
  const strings = (key: string): string[] => {
    const list = raw[key];
    if (!Array.isArray(list)) {
      missing.push(`${key} was not read`);
      return [];
    }
    return list.filter((one): one is string => typeof one === 'string');
  };
  const counts = raw['counts'];
  const countOf = (key: string): number => {
    if (typeof counts !== 'object' || counts === null) return 0;
    const found = (counts as Record<string, unknown>)[key];
    return typeof found === 'number' && Number.isFinite(found) ? found : 0;
  };
  const nesting = raw['deepestNesting'];
  const outline = Array.isArray(raw['outline'])
    ? (raw['outline'] as unknown[]).flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const row = entry as Record<string, unknown>;
        const level = typeof row['level'] === 'number' ? row['level'] : null;
        const text = typeof row['text'] === 'string' ? row['text'] : null;
        return level !== null && text !== null ? [{ level, text }] : [];
      })
    : [];

  const readings: CaptureReadings = {
    horizontalOverflow: raw['horizontalOverflow'] === true,
    clipped: strings('clipped'),
    offenders: strings('offenders'),
    unreachable: strings('unreachable'),
    overlaps: strings('overlaps'),
    smallTargets: strings('smallTargets'),
    lowContrast: strings('lowContrast'),
    reachableControls: strings('reachableControls'),
    deepestNesting:
      typeof nesting === 'object' && nesting !== null
        ? {
            depth: Number((nesting as Record<string, unknown>)['depth']) || 0,
            where: String((nesting as Record<string, unknown>)['where'] ?? 'unknown'),
          }
        : null,
    counts: {
      interactive: countOf('interactive'),
      headings: countOf('headings'),
      landmarks: countOf('landmarks'),
      textNodes: countOf('textNodes'),
    },
    outline,
    unreadable: [...strings('unreadable'), ...missing],
    partial: Array.isArray(raw['partial'])
      ? (raw['partial'] as unknown[]).filter((one): one is string => typeof one === 'string')
      : [],
  };
  if (typeof counts !== 'object' || counts === null) {
    readings.unreadable.push('counts were not read');
  }
  return readings;
}

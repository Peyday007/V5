// Turn raw page scans into deduplicated findings, totals and a teaser line.
import { RULES, CUSTOM, WCAG_NAMES, criteriaFromTags, levelFromTags } from './rules.mjs';

export const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'];

function contrastDetail(d) {
  if (!d || d.contrastRatio == null) return '';
  return `text ${d.fgColor} on ${d.bgColor}, ratio ${d.contrastRatio}:1 (needs ${d.expectedContrastRatio}), font ${d.fontSize} ${d.fontWeight === 'bold' || +d.fontWeight >= 700 ? 'bold' : ''}`.trim();
}

/** scans: [{url, viewport, ok, axe, keyboard, reflow, facts}] -> findings[] */
export function buildFindings(scans) {
  const map = new Map();
  const get = (rule, base) => {
    if (!map.has(rule)) map.set(rule, { rule, ...base, pages: {}, viewports: new Set(), keys: new Set(), examples: [] });
    return map.get(rule);
  };
  // Identity of an instance across the desktop and mobile scans of a page. Page builders
  // (Squarespace, Wix) regenerate ids on every load, so a selector is not stable; the element's
  // own HTML plus its occurrence number within that scan is.
  let occ = new Map();
  const add = (f, url, viewport, target, html, detail) => {
    f.viewports.add(viewport);
    const base = `${url}::${f.rule}::${html ? html.replace(/\b(id|data-[\w-]*id)="[^"]*"/g, '').replace(/\s+/g, ' ').slice(0, 300) : target}`;
    const nth = (occ.get(base) || 0) + 1;
    occ.set(base, nth);
    const k = `${base}::${nth}`;
    if (f.keys.has(k)) return;
    f.keys.add(k);
    f.pages[url] = (f.pages[url] || 0) + 1;
    if (f.examples.length < 12) f.examples.push({ url, viewport, target, html, detail });
  };
  for (const s of scans) {
    if (!s.ok) continue;
    occ = new Map();
    for (const v of s.axe.violations) {
      const meta = RULES[v.id] || {};
      const wcag = criteriaFromTags(v.tags);
      const level = levelFromTags(v.tags);
      const f = get(v.id, {
        source: 'axe', impact: v.impact, wcag, level, bestPractice: level === 'best practice', title: v.help,
        plain: meta.plain || v.description, fix: meta.fix || `See ${v.helpUrl}`, helpUrl: v.helpUrl,
      });
      if (IMPACT_ORDER.indexOf(v.impact) < IMPACT_ORDER.indexOf(f.impact)) f.impact = v.impact;
      for (const n of v.nodes) add(f, s.url, s.viewport, n.target, n.html, v.id === 'color-contrast' ? contrastDetail(n.data) : n.summary.split('\n').map((x) => x.trim()).filter((x) => x && !/^Fix (any|all) of the following:?$/i.test(x)).slice(0, 2).join('; '));
    }
    const kb = s.keyboard;
    if (kb && !kb.error) {
      if (kb.noVisibleFocus.length) {
        const f = get('focus-not-visible', { source: 'tab-traversal', ...CUSTOM['focus-not-visible'], title: 'Keyboard focus is not visible' });
        for (const d of kb.noVisibleFocus) add(f, s.url, s.viewport, d, '', 'No change in outline, shadow, border, colour or underline when focused by Tab');
      }
      if (kb.trap) {
        const f = get('keyboard-trap', { source: 'tab-traversal', ...CUSTOM['keyboard-trap'], title: 'Keyboard focus gets stuck' });
        add(f, s.url, s.viewport, kb.order.slice(0, 4).join(' → '), '', `Tab cycled among ${kb.uniqueStops} elements`);
      }
      if (!kb.firstIsSkipLink && kb.tabStops > 8) {
        const f = get('no-skip-link', { source: 'tab-traversal', ...CUSTOM['no-skip-link'], level: 'best practice', bestPractice: true, title: 'No "skip to content" link' });
        add(f, s.url, s.viewport, 'first Tab stop', '', `First Tab stop is ${kb.firstStop}`);
      }
    }
    if (s.reflow && s.reflow.overflow > 2) {
      const f = get('reflow-horizontal-scroll', { source: 'reflow-320px', ...CUSTOM['reflow-horizontal-scroll'], title: 'Page scrolls sideways at 320px width' });
      add(f, s.url, 'mobile 320px', s.reflow.culprits[0] || 'page', '', `Content is ${s.reflow.overflow}px wider than the screen; widest elements: ${s.reflow.culprits.join(', ')}`);
    }
  }
  const out = [...map.values()].map((f) => ({
    ...f, viewports: [...f.viewports], instances: f.keys.size, keys: undefined,
    wcagNamed: (f.wcag || []).map((c) => `${c} ${WCAG_NAMES[c] || ''}`.trim()),
  }));
  out.sort((a, b) => (a.bestPractice - b.bestPractice) || (IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact)) || (b.instances - a.instances));
  return out;
}

export function totals(findings) {
  const wc = findings.filter((f) => !f.bestPractice);
  const by = Object.fromEntries(IMPACT_ORDER.map((i) => [i, wc.filter((f) => f.impact === i).reduce((n, f) => n + f.instances, 0)]));
  return {
    issuesTotal: wc.reduce((n, f) => n + f.instances, 0),
    criticalSerious: by.critical + by.serious,
    byImpact: by,
    rulesFailed: wc.length,
    bestPracticeInstances: findings.filter((f) => f.bestPractice).reduce((n, f) => n + f.instances, 0),
    // axe-core alone (no heuristics): what prospect qualification and the teaser rest on
    axeIssues: wc.filter((f) => f.source === 'axe').reduce((n, f) => n + f.instances, 0),
    axeCriticalSerious: wc.filter((f) => f.source === 'axe' && ['critical', 'serious'].includes(f.impact)).reduce((n, f) => n + f.instances, 0),
  };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One sentence of exact numbers from a homepage scan, for the outreach email. axe-core results only,
 *  so every number is reproducible with any axe-based tool (the focus heuristic stays in the report). */
export function teaser(findings) {
  const n = (ids) => findings.filter((f) => ids.includes(f.rule)).reduce((s, f) => s + f.instances, 0);
  const parts = [
    [n(['image-alt', 'role-img-alt', 'svg-img-alt', 'input-image-alt']), (k) => `${plural(k, 'image', 'images')} without alt text`],
    [n(['label', 'select-name', 'aria-input-field-name', 'label-title-only']), (k) => `${plural(k, 'form field', 'form fields')} without a label`],
    [n(['link-name']), (k) => `${plural(k, 'link', 'links')} with no readable name`],
    [n(['button-name', 'aria-command-name']), (k) => `${plural(k, 'button', 'buttons')} with no readable name`],
    [n(['color-contrast']), (k) => `${plural(k, 'text element', 'text elements')} below the minimum contrast ratio`],
    [n(['meta-viewport']), () => 'pinch-zoom disabled on phones'],
    [n(['html-has-lang']), () => 'no page language declared'],
  ].filter(([k]) => k > 0);
  // Lead with the most concrete, least arguable items (alt/labels/names) before contrast.
  const chosen = parts.slice(0, 3).map(([k, f]) => f(k));
  if (!chosen.length) return '';
  const list = chosen.length === 1 ? chosen[0] : `${chosen.slice(0, -1).join(', ')} and ${chosen.at(-1)}`;
  return `your homepage has ${list}`;
}

export function topIssue(findings) {
  const f = findings.find((x) => !x.bestPractice);
  return f ? `${f.title} (${f.instances}x, ${f.impact}, WCAG ${f.wcag.join('/') || '-'})` : '';
}

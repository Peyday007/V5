// Page scanning: load a page in Chromium, run axe-core plus the checks
// automation does well (keyboard Tab traversal, focus visibility, reflow at
// 320px, headings, images, form labels). Anything that prevents an honest scan
// (timeout, bot wall, error page) is returned as { ok:false, reason } — the
// report then says "could not scan"; nothing is ever invented.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const AXE_PATH = path.join(HERE, 'vendor', 'axe.min.js');
if (!fs.existsSync(AXE_PATH)) throw new Error(`axe-core missing at ${AXE_PATH}; see build/README note in ../README.md`);
export const AXE_VERSION = /axe v([\d.]+)/.exec(fs.readFileSync(AXE_PATH, 'utf8').slice(0, 200))?.[1] ?? 'unknown';

export const VIEWPORTS = {
  desktop: { viewport: { width: 1366, height: 900 } },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const BLOCK_TITLE = /just a moment|one moment, please|please wait|attention required|access denied|are you a robot|captcha|security check|request blocked|forbidden|not acceptable|ddos protection|checking your browser/i;
const ERROR_TITLE = /^(404|page not found|not found|error|500|503|site not found|domain (is )?for sale|account suspended|website expired)\b/i;

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms); })])
    .finally(() => clearTimeout(t));
}

export async function newContext(browser, kind) {
  return browser.newContext({ ...VIEWPORTS[kind], bypassCSP: true, locale: 'en-US', javaScriptEnabled: true });
}

/** Load a URL and decide whether what came back is the real page. */
export async function load(page, url, { timeout = 35000 } = {}) {
  let resp;
  try {
    resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (e) {
    return { ok: false, reason: `could not load: ${String(e.message).split('\n')[0].slice(0, 160)}` };
  }
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const status = resp ? resp.status() : 0;
  const title = (await page.title().catch(() => '')) || '';
  const bodyLen = await page.evaluate(() => (document.body?.innerText || '').trim().length).catch(() => 0);
  if ([401, 403, 406, 429, 503].includes(status) || BLOCK_TITLE.test(title)) {
    return { ok: false, reason: `blocked automated access (HTTP ${status}${title ? `, "${title.slice(0, 60)}"` : ''})`, status };
  }
  if (status >= 400 || ERROR_TITLE.test(title.trim())) return { ok: false, reason: `error page (HTTP ${status}, "${title.slice(0, 60)}")`, status };
  if (bodyLen < 40) return { ok: false, reason: `page rendered no readable content (HTTP ${status})`, status };
  return { ok: true, status, title, finalUrl: page.url() };
}

/** Dismiss common cookie/consent banners and newsletter pop-ups so the scan sees the page a visitor sees after one click. */
export async function dismissOverlays(page) {
  const clicked = await page.evaluate(() => {
    const words = /^(accept( all)?( cookies)?|i accept|agree|i agree|allow( all)?( cookies)?|got it|ok(ay)?|continue|close|dismiss|no,? thanks|×|x)$/i;
    const scope = /cookie|consent|gdpr|privacy|cc-|onetrust|cky|termly|popup|modal|newsletter|klaviyo|privy|banner/i;
    const out = [];
    for (const el of document.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"], a')) {
      const txt = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
      if (!words.test(txt)) continue;
      let n = el, inScope = false;
      for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
        if (scope.test(`${n.id} ${typeof n.className === 'string' ? n.className : ''} ${n.getAttribute?.('aria-label') || ''}`)) { inScope = true; break; }
      }
      const r = el.getBoundingClientRect();
      if (inScope && r.width > 0 && r.height > 0) { el.click(); out.push(txt); if (out.length >= 2) break; }
    }
    return out;
  }).catch(() => []);
  if (clicked.length) await page.waitForTimeout(800);
  return clicked;
}

export async function runAxe(page) {
  await page.addScriptTag({ path: AXE_PATH });
  return withTimeout(page.evaluate(async (tags) => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations', 'incomplete'] });
    const node = (n) => ({
      target: n.target.map((t) => (Array.isArray(t) ? t.join(' >>> ') : t)).join(' '),
      html: n.html.length > 400 ? n.html.slice(0, 400) + '…' : n.html,
      summary: n.failureSummary || '',
      impact: n.impact,
      data: (n.any.find((c) => c.data && typeof c.data === 'object') || {}).data || null,
    });
    const pack = (v) => ({ id: v.id, impact: v.impact, tags: v.tags, help: v.help, helpUrl: v.helpUrl, description: v.description, nodes: v.nodes.map(node) });
    return { violations: r.violations.map(pack), incomplete: r.incomplete.map((v) => ({ id: v.id, help: v.help, count: v.nodes.length })) };
  }, AXE_TAGS), 90000, 'axe-core');
}

/** Facts about the page that the report shows alongside axe results. */
export async function pageFacts(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(vis).map((h) => ({ level: +h.tagName[1], text: (h.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 90) }));
    const imgs = [...document.querySelectorAll('img')].filter(vis);
    const fields = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]), select, textarea')].filter(vis);
    return {
      lang: document.documentElement.getAttribute('lang') || '',
      title: document.title,
      headings,
      h1Count: headings.filter((h) => h.level === 1).length,
      images: imgs.length,
      imagesNoAlt: imgs.filter((i) => !i.hasAttribute('alt')).length,
      formFields: fields.length,
      landmarks: { main: !!document.querySelector('main,[role=main]'), nav: !!document.querySelector('nav,[role=navigation]'), header: !!document.querySelector('header,[role=banner]'), footer: !!document.querySelector('footer,[role=contentinfo]') },
      positiveTabindex: document.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex^="-"])').length,
    };
  });
}

/** Scripted Tab traversal: order, skip link, visible focus indicator, traps. */
export async function keyboardCheck(page, maxTabs = 70) {
  await page.mouse.move(0, 0).catch(() => {});
  await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
  const stops = [];
  let stoppedAt = null;
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(60);
    const s = await page.evaluate((i) => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return { body: true };
      if (el.tagName === 'IFRAME') return { iframe: true, desc: `iframe ${el.title || el.src || ''}`.slice(0, 80) };
      if (!el.dataset.a11yTab) el.dataset.a11yTab = String(i);
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      return {
        key: el.dataset.a11yTab,
        desc: `<${el.tagName.toLowerCase()}${el.id ? ` id="${el.id}"` : ''}> ${name}`.trim(),
        href: el.getAttribute('href') || '',
        visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0',
        style: [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.borderColor, cs.backgroundColor, cs.color, cs.textDecorationLine, cs.borderBottomWidth].join('|'),
      };
    }, i).catch(() => ({ body: true }));
    if (s.iframe) { stoppedAt = s.desc; break; } // focus moved into an embed (map, video, booking widget); stop rather than wander inside it
    if (s.body) { if (stops.length) break; else continue; }
    if (stops.length && s.key === stops[0].key) break; // wrapped around
    stops.push(s);
  }
  // Compare each element's focused style with its unfocused style.
  await page.evaluate(() => document.activeElement?.blur?.());
  const unfocused = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-a11y-tab]')].map((el) => {
    const cs = getComputedStyle(el);
    return [el.dataset.a11yTab, [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.borderColor, cs.backgroundColor, cs.color, cs.textDecorationLine, cs.borderBottomWidth].join('|')];
  })));
  const real = stops.filter((s) => s.key);
  const noFocusStyle = real.filter((s) => s.visible && unfocused[s.key] === s.style);
  const hiddenFocus = real.filter((s) => !s.visible);
  const uniq = new Set(real.map((s) => s.key));
  const first = real[0];
  const firstIsSkip = !!first && /skip|jump to|main content/i.test(first.desc) && first.href.startsWith('#');
  // A trap: the visited set stops growing while Tab keeps being pressed.
  const trap = real.length >= maxTabs - 1 && uniq.size <= 4;
  return {
    tabStops: real.length, uniqueStops: uniq.size, reachedEnd: real.length < maxTabs && !stoppedAt, stoppedAt,
    firstStop: first?.desc || null, firstIsSkipLink: firstIsSkip,
    noVisibleFocus: noFocusStyle.map((s) => s.desc), focusOnHidden: hiddenFocus.map((s) => s.desc), trap,
    order: real.slice(0, 25).map((s) => s.desc),
  };
}

/** WCAG 1.4.10: does the page scroll horizontally at 320 CSS px? */
export async function reflowCheck(page) {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.waitForTimeout(700);
  const r = await page.evaluate(() => {
    const de = document.documentElement;
    const overflow = Math.max(de.scrollWidth, document.body?.scrollWidth || 0) - de.clientWidth;
    if (overflow <= 2) return { overflow: 0, culprits: [] };
    const culprits = [];
    for (const el of document.querySelectorAll('body *')) {
      const b = el.getBoundingClientRect();
      if (b.right > de.clientWidth + 2 && b.width > 0 && b.height > 0 && getComputedStyle(el).position !== 'fixed') {
        if ([...el.children].some((c) => c.getBoundingClientRect().right > de.clientWidth + 2)) continue; // keep innermost
        culprits.push(`<${el.tagName.toLowerCase()}${el.id ? ` id="${el.id}"` : ''}${typeof el.className === 'string' && el.className ? ` class="${el.className.slice(0, 50)}"` : ''}> width ${Math.round(b.width)}px`);
        if (culprits.length >= 5) break;
      }
    }
    return { overflow, culprits };
  });
  return r;
}

/** Same-site links from the homepage, ranked toward the pages a customer actually uses. */
export async function discoverPages(page, homeUrl, max = 10) {
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => ({
    href: a.href, text: (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60),
    inNav: !!a.closest('nav,header,[role=navigation],[class*=menu],[class*=nav]'),
  })));
  const host = (u) => new URL(u).hostname.replace(/^www\./, '');
  const home = new URL(homeUrl);
  const seen = new Set([home.origin + home.pathname.replace(/\/$/, '')]);
  const cats = [
    ['contact', /contact|get in touch|reach us/i], ['booking', /book|appointment|schedule|reserv|request/i],
    ['product', /shop|store|product|collection|catalog|buy/i], ['service', /service|treatment|practice area|what we do|menu|rooms|suites/i],
    ['cart', /cart|basket|checkout/i], ['about', /about|team|our story|meet/i], ['location', /location|visit|direction|hours/i],
    ['pricing', /pric|rates|fees|insurance/i], ['other', /./],
  ];
  const cands = [];
  for (const l of links) {
    let u;
    try { u = new URL(l.href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || host(u.href) !== host(homeUrl)) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|mp3)$/i.test(u.pathname)) continue;
    if (/\/(wp-admin|wp-login|login|account|cdn-cgi|feed|tag|author)\b/i.test(u.pathname)) continue;
    const key = u.origin + u.pathname.replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const hay = `${l.text} ${u.pathname}`;
    const cat = cats.findIndex(([, re]) => re.test(hay));
    cands.push({ url: u.origin + u.pathname, text: l.text, cat: cats[cat][0], rank: cat * 2 + (l.inNav ? 0 : 1) });
  }
  cands.sort((a, b) => a.rank - b.rank);
  const chosen = [], usedCat = new Set();
  for (const c of cands) if (c.cat !== 'other' && !usedCat.has(c.cat) && chosen.length < max - 1) { chosen.push(c); usedCat.add(c.cat); }
  for (const c of cands) if (chosen.length < max - 1 && !chosen.includes(c) && (c.rank % 2 === 0)) chosen.push(c);
  return chosen.map((c) => c.url);
}

/** Full scan of one URL at one viewport. */
export async function scanPage(browser, url, kind, { keyboard = true, reflow = false } = {}) {
  const ctx = await newContext(browser, kind);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  try {
    const l = await load(page, url);
    if (!l.ok) return { url, viewport: kind, ok: false, reason: l.reason };
    const dismissed = await dismissOverlays(page);
    const axe = await runAxe(page);
    const facts = await pageFacts(page);
    const kb = keyboard ? await keyboardCheck(page).catch((e) => ({ error: String(e.message).slice(0, 120) })) : null;
    const rf = reflow ? await reflowCheck(page).catch(() => null) : null;
    return { url, finalUrl: l.finalUrl, viewport: kind, ok: true, title: l.title, dismissed, axe, facts, keyboard: kb, reflow: rf };
  } catch (e) {
    return { url, viewport: kind, ok: false, reason: `scan failed: ${String(e.message).split('\n')[0].slice(0, 160)}` };
  } finally {
    await ctx.close().catch(() => {});
  }
}

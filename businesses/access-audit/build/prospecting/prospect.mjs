#!/usr/bin/env node
// Scan each candidate's homepage (desktop, axe-core + Tab traversal) and find a
// business email address published on the business's own site.
//
//   node build/prospecting/prospect.mjs out/candidates.jsonl out/scanned.jsonl [--target 110] [--workers 4]
//
// Appends one JSON line per candidate (resumable: already-scanned websites are skipped).
// The email is accepted only if it literally appears in the rendered text, a
// mailto: link or the HTML of the page recorded as source_url.
import fs from 'node:fs';
import { chromium, newContext, load, dismissOverlays, runAxe, pageFacts, keyboardCheck } from '../scan.mjs';
import { buildFindings, totals, teaser, topIssue } from '../findings.mjs';

const [inPath, outPath] = process.argv.slice(2);
const opt = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? +process.argv[i + 1] : d; };
const TARGET = opt('--target', 110), WORKERS = opt('--workers', 4);

const FREE = /^(gmail|yahoo|outlook|hotmail|aol|icloud|me|comcast|att|sbcglobal|msn|live|protonmail|bellsouth|verizon|charter|cox|frontier)\.(com|net)$/i;
const ROLE = /^(info|contact|hello|office|frontdesk|front\.desk|reception|admin|appointments?|reservations?|bookings?|inquir(y|ies)|enquir(y|ies)|sales|team|mail|help|support|customerservice|service|orders|shop|store|stay|events|catering|intake|clientservices|staff|general|manager|smile|care|dental|law|legal)\b/i;
const EMAIL_RX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BAD = /(\.(png|jpe?g|gif|webp|svg)$)|example\.|sentry|wixpress|domain\.com|email\.com|yourdomain|godaddy|@2x|squarespace|wordpress|cloudflare|schema\.org|privacy@|abuse@|webmaster@|noreply|no-reply/i;

const host = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

async function emailsOn(page, siteHost) {
  const { text, mailtos, html } = await page.evaluate(() => ({
    text: document.body?.innerText || '',
    mailtos: [...document.querySelectorAll('a[href^="mailto:" i]')].map((a) => decodeURIComponent(a.getAttribute('href').slice(7).split('?')[0]).trim()),
    html: document.documentElement.outerHTML,
  }));
  const found = new Set([...mailtos, ...(text.match(EMAIL_RX) || []), ...(html.match(EMAIL_RX) || [])].map((e) => e.toLowerCase().replace(/^mailto:/, '').replace(/[.,;:]+$/, '')));
  const ok = [];
  for (const e of found) {
    if (BAD.test(e) || e.length > 60) continue;
    const d = e.split('@')[1];
    const sameSite = d === siteHost || d.endsWith('.' + siteHost) || siteHost.endsWith('.' + d);
    if (!sameSite && !FREE.test(d)) continue;
    // literal presence check on what the visitor can see or the page source
    if (!(text.toLowerCase().includes(e) || html.toLowerCase().includes(e) || mailtos.map((m) => m.toLowerCase()).includes(e))) continue;
    ok.push({ email: e, role: ROLE.test(e.split('@')[0]), sameSite });
  }
  ok.sort((a, b) => (b.sameSite - a.sameSite) || (b.role - a.role));
  return ok;
}

async function contactLinks(page, siteHost) {
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: (a.innerText || '').trim().slice(0, 40) })));
  const out = [];
  for (const l of links) {
    if (host(l.href) !== siteHost) continue;
    if (/contact|about|location|visit|connect|reach/i.test(l.text + ' ' + new URL(l.href).pathname)) out.push(l.href.split('#')[0]);
  }
  return [...new Set(out)].sort((a, b) => /contact/i.test(b) - /contact/i.test(a)).slice(0, 2);
}

async function prospect(browser, c) {
  const ctx = await newContext(browser, 'desktop');
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const rec = { ...c, scanned_at: new Date().toISOString() };
  try {
    // Directory listings sometimes link a sub-page; the teaser is about the homepage, so scan the site root.
    const home = (() => { try { return new URL(/^https?:/i.test(c.website) ? c.website : 'http://' + c.website).origin + '/'; } catch { return c.website; } })();
    const l = await load(page, home);
    if (!l.ok) return { ...rec, status: 'could_not_scan', reason: l.reason };
    rec.final_url = l.finalUrl;
    const siteHost = host(l.finalUrl);
    await dismissOverlays(page);
    let emails = await emailsOn(page, siteHost);
    let source = l.finalUrl;
    const axe = await runAxe(page);
    const facts = await pageFacts(page);
    const kb = await keyboardCheck(page).catch(() => null);
    const scan = { url: l.finalUrl, viewport: 'desktop', ok: true, axe, facts, keyboard: kb };
    const findings = buildFindings([scan]);
    Object.assign(rec, { totals: totals(findings), teaser: teaser(findings), top_issue: topIssue(findings),
      rules: findings.map((f) => [f.rule, f.impact, f.instances, f.bestPractice ? 1 : 0]), title: l.title });
    if (!emails.length) {
      for (const u of await contactLinks(page, siteHost)) {
        const l2 = await load(page, u, { timeout: 25000 });
        if (!l2.ok) continue;
        emails = await emailsOn(page, siteHost);
        if (emails.length) { source = l2.finalUrl; break; }
      }
    }
    if (!emails.length) return { ...rec, status: 'no_email' };
    return { ...rec, status: 'ok', email: emails[0].email, email_role: emails[0].role, email_same_site: emails[0].sameSite, source_url: source, other_emails: emails.slice(1, 4).map((e) => e.email) };
  } catch (e) {
    return { ...rec, status: 'could_not_scan', reason: `scan failed: ${String(e.message).split('\n')[0].slice(0, 140)}` };
  } finally {
    await ctx.close().catch(() => {});
  }
}

const cands = fs.readFileSync(inPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const done = new Set(fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).website) : []);
let qualified = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === 'ok' && r.totals?.criticalSerious >= 3).length : 0;
// Interleave industries and states so an early stop is still a spread.
const groups = {};
for (const c of cands) if (!done.has(c.website)) (groups[`${c.industry}`] ||= []).push(c);
const h = (s) => [...s].reduce((x, ch) => (x * 31 + ch.charCodeAt(0)) >>> 0, 7);
for (const g of Object.values(groups)) g.sort((a, b) => h(a.name) - h(b.name)); // deterministic shuffle: mixes states
const queue = [];
for (let i = 0; Object.values(groups).some((g) => g.length > i); i++) for (const g of Object.values(groups)) if (g[i]) queue.push(g[i]);
console.error(`${queue.length} to scan, ${qualified} already qualified, target ${TARGET}`);

let browser = await chromium.launch();
let n = 0;
async function worker() {
  while (queue.length && qualified < TARGET) {
    const c = queue.shift();
    let r;
    try {
      r = await prospect(browser, c);
    } catch (e) {
      r = { ...c, status: 'could_not_scan', reason: String(e.message).slice(0, 140) };
      if (!browser.isConnected()) browser = await chromium.launch();
    }
    fs.appendFileSync(outPath, JSON.stringify(r) + '\n');
    n++;
    if (r.status === 'ok' && r.totals?.criticalSerious >= 3) qualified++;
    console.error(`[${n}] ${r.status.padEnd(14)} q=${qualified} ${c.industry} ${c.state} ${c.name} ${r.email || r.reason || ''} ${r.totals ? r.totals.criticalSerious + 'cs' : ''}`);
  }
}
await Promise.all(Array.from({ length: WORKERS }, worker));
await browser.close();

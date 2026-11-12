#!/usr/bin/env node
// Accessibility audit generator.
//
//   node build/audit.mjs <url> [--pages url1,url2,...] [--max 10] [--out dir] [--no-pdf] [--quick]
//
// Without --pages, key pages are discovered from the homepage's own links
// (contact, booking, products, services, cart, about...). Each page is scanned
// at desktop and mobile widths. Writes <out>/report.html, report.pdf and
// summary.json (summary.json carries every instance, not only the examples).
// --quick: homepage only, desktop only, summary layout — the free homepage summary.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, scanPage, newContext, load, dismissOverlays, discoverPages, AXE_VERSION } from './scan.mjs';
import { buildFindings, totals, teaser, topIssue } from './findings.mjs';
import { renderReport } from './report.mjs';

function normalize(u) {
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return new URL(u).href;
}

export async function runAudit(url, { pages = null, max = 10, quick = false, browser: given = null, log = () => {} } = {}) {
  const site = normalize(url);
  const browser = given || (await chromium.launch());
  const date = new Date().toISOString().slice(0, 10);
  try {
    let list = pages ? pages.map(normalize) : null;
    let homeFinal = site;
    if (!list) {
      list = [site];
      if (!quick) {
        const ctx = await newContext(browser, 'desktop');
        const p = await ctx.newPage();
        const l = await load(p, site);
        if (l.ok) {
          homeFinal = l.finalUrl;
          await dismissOverlays(p);
          list = [l.finalUrl, ...(await discoverPages(p, l.finalUrl, max))].slice(0, max);
        }
        await ctx.close();
      }
    }
    const scans = [];
    for (const u of list) {
      log(`scan ${u}`);
      scans.push(await scanPage(browser, u, 'desktop', { keyboard: true }));
      if (!quick) scans.push(await scanPage(browser, u, 'mobile', { keyboard: false, reflow: true }));
    }
    const findings = buildFindings(scans);
    const homeFindings = buildFindings(scans.filter((s) => s.url === list[0] && s.viewport === 'desktop'));
    return {
      site: homeFinal, date, axeVersion: AXE_VERSION, pages: list, scans, findings, totals: totals(findings),
      scannedOk: scans.filter((s) => s.ok).length, couldNotScan: scans.filter((s) => !s.ok).map((s) => ({ url: s.url, viewport: s.viewport, reason: s.reason })),
      teaser: teaser(homeFindings), topIssue: topIssue(findings),
    };
  } finally {
    if (!given) await browser.close();
  }
}

export async function writeOutputs(r, outDir, { pdf = true, browser: given = null } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const html = renderReport(r);
  fs.writeFileSync(path.join(outDir, 'report.html'), html);
  const summary = {
    site: r.site, date: r.date, axeVersion: r.axeVersion, pages: r.pages, totals: r.totals, teaser: r.teaser, topIssue: r.topIssue,
    couldNotScan: r.couldNotScan,
    findings: r.findings.map((f) => ({ rule: f.rule, title: f.title, impact: f.impact, bestPractice: !!f.bestPractice, wcag: f.wcag, level: f.level, instances: f.instances, pages: f.pages, viewports: f.viewports, fix: f.fix, examples: f.examples })),
    keyboard: r.scans.filter((s) => s.ok && s.keyboard).map((s) => ({ url: s.url, ...s.keyboard })),
    reflow: r.scans.filter((s) => s.ok && s.reflow).map((s) => ({ url: s.url, ...s.reflow })),
    // Every failing element, for the client's developer.
    instances: r.scans.filter((s) => s.ok).flatMap((s) => s.axe.violations.flatMap((v) => v.nodes.map((n) => ({ url: s.url, viewport: s.viewport, rule: v.id, impact: v.impact, target: n.target, html: n.html })))),
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
  if (pdf) {
    const browser = given || (await chromium.launch());
    try {
      const p = await browser.newPage();
      await p.setContent(html, { waitUntil: 'load' });
      await p.pdf({ path: path.join(outDir, 'report.pdf'), format: 'Letter', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
      await p.close();
    } finally {
      if (!given) await browser.close();
    }
  }
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a) && !args[args.indexOf(a) - 1]?.match(/^--(pages|max|out)$/));
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  if (!url) { console.error('usage: node build/audit.mjs <url> [--pages a,b] [--max 10] [--out dir] [--no-pdf] [--quick]'); process.exit(2); }
  const quick = args.includes('--quick');
  const host = new URL(normalize(url)).hostname.replace(/^www\./, '');
  const out = opt('--out') || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'out', host);
  const r = await runAudit(url, { pages: opt('--pages')?.split(',').filter(Boolean), max: +(opt('--max') || 10), quick, log: (m) => console.error(m) });
  if (quick) r.summaryOnly = true;
  const s = await writeOutputs(r, out, { pdf: !args.includes('--no-pdf') });
  console.log(JSON.stringify({ out, site: s.site, pages: s.pages.length, totals: s.totals, teaser: s.teaser, topIssue: s.topIssue, couldNotScan: s.couldNotScan }, null, 1));
}

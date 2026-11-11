// Report HTML. Self-contained (inline CSS), printable to PDF by Chromium.
import { IMPACT_ORDER } from './findings.mjs';

export const BRAND = 'Tabstop Accessibility Reports';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (u) => { try { const x = new URL(u); return (x.pathname === '/' ? x.hostname : x.pathname).slice(0, 70); } catch { return u; } };

const CSS = `
:root{--ink:#16202b;--muted:#5a6672;--line:#d9dee3;--bg:#fff;--soft:#f4f6f8;--crit:#9b1c1c;--ser:#b4470a;--mod:#7a5d00;--min:#3d5a80;--accent:#1a5fb4}
*{box-sizing:border-box}body{font:14px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg);margin:0}
main{max-width:900px;margin:0 auto;padding:32px 28px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:32px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--ink)}
h3{font-size:15px;margin:0}p{margin:6px 0}.muted{color:var(--muted)}
.cover{border-left:6px solid var(--accent);padding:6px 0 6px 16px;margin-bottom:22px}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:16px 0}
.kpi{background:var(--soft);border-radius:6px;padding:10px 12px}.kpi b{display:block;font-size:24px}.kpi span{font-size:12px;color:var(--muted)}
table{width:100%;border-collapse:collapse;margin:8px 0;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{background:var(--soft)}
.badge{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:2px 7px;border-radius:10px;color:#fff}
.critical{background:var(--crit)}.serious{background:var(--ser)}.moderate{background:var(--mod)}.minor{background:var(--min)}.bp{background:#6b7280}
.issue{border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:14px 0;page-break-inside:avoid}
.issue .head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px}
.fix{background:#eef5ee;border-left:4px solid #2f7d32;padding:8px 10px;margin:8px 0;border-radius:0 4px 4px 0}
code,.code{font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;background:var(--soft);padding:1px 4px;border-radius:3px;word-break:break-all}
.ex{font-size:12px;margin:6px 0 0;padding-left:0;list-style:none}.ex li{padding:6px 0;border-top:1px dashed var(--line)}
.note{background:#fff8e6;border:1px solid #f0d58a;border-radius:6px;padding:10px 14px}
footer{margin-top:36px;font-size:12px;color:var(--muted);border-top:1px solid var(--line);padding-top:10px}
@media print{main{padding:0}h2{page-break-after:avoid}}
`;

function badge(f) {
  return f.bestPractice ? '<span class="badge bp">best practice</span>' : `<span class="badge ${esc(f.impact)}">${esc(f.impact)}</span>`;
}

function issueBlock(f, i) {
  const pages = Object.entries(f.pages).map(([u, n]) => `${esc(short(u))} (${n})`).join(', ');
  const ex = f.examples.slice(0, 6).map((e) => `<li><b>${esc(short(e.url))}</b> · ${esc(e.viewport)}<br><span class="code">${esc(e.target)}</span>${e.html ? `<br><span class="code">${esc(e.html.slice(0, 260))}</span>` : ''}${e.detail ? `<br><span class="muted">${esc(e.detail)}</span>` : ''}</li>`).join('');
  const more = f.instances > 6 ? `<p class="muted">…and ${f.instances - 6} more instance(s); the full list is in the JSON file delivered with this report.</p>` : '';
  return `<div class="issue"><div class="head">${badge(f)}<h3>${i}. ${esc(f.title)}</h3><span class="muted">${f.instances} instance(s) · ${f.wcagNamed.length ? 'WCAG ' + esc(f.wcagNamed.join(', ')) + (f.level && !f.bestPractice ? ` (Level ${esc(f.level)})` : '') : 'not a WCAG success criterion'}</span></div>
<p>${esc(f.plain)}</p><div class="fix"><b>How to fix:</b> ${esc(f.fix)}</div>
<p class="muted">Pages: ${pages} · found at ${esc(f.viewports.join(', '))} width · detected by ${esc(f.source === 'axe' ? 'axe-core rule ' + f.rule : f.source)}</p><ul class="ex">${ex}</ul>${more}</div>`;
}

export function renderReport(r) {
  const t = r.totals;
  const wcag = r.findings.filter((f) => !f.bestPractice);
  const bp = r.findings.filter((f) => f.bestPractice);
  const desktop = r.scans.filter((s) => s.viewport === 'desktop');
  const pageRows = r.pages.map((u) => {
    const d = r.scans.find((s) => s.url === u && s.viewport === 'desktop');
    const m = r.scans.find((s) => s.url === u && s.viewport === 'mobile');
    const cnt = (s) => (s && s.ok ? s.axe.violations.filter((v) => v.tags.some((t) => /^wcag\d/.test(t))).reduce((n, v) => n + v.nodes.length, 0) : '—');
    const status = [d, m].map((s) => (s ? (s.ok ? 'scanned' : `could not scan: ${s.reason}`) : 'not run'));
    return `<tr><td><span class="code">${esc(u)}</span></td><td>${esc(status[0])}</td><td>${esc(status[1])}</td><td>${cnt(d)} / ${cnt(m)}</td></tr>`;
  }).join('');
  const kbRows = desktop.filter((s) => s.ok && s.keyboard && !s.keyboard.error).map((s) => {
    const k = s.keyboard;
    return `<tr><td>${esc(short(s.url))}</td><td>${k.tabStops}${k.stoppedAt ? ` (stopped at ${esc(k.stoppedAt)})` : k.reachedEnd ? '' : '+'}</td><td>${k.firstIsSkipLink ? 'yes' : 'no'}</td><td>${k.noVisibleFocus.length}</td><td>${k.trap ? 'yes' : 'no'}</td><td>${s.reflow ? (s.reflow.overflow > 2 ? `scrolls ${s.reflow.overflow}px` : 'ok') : (r.scans.find((x) => x.url === s.url && x.viewport === 'mobile' && x.reflow)?.reflow?.overflow > 2 ? 'scrolls sideways' : 'ok')}</td></tr>`;
  }).join('');
  const home = desktop.find((s) => s.ok);
  const outline = home ? home.facts.headings.slice(0, 30).map((h) => `<div style="padding-left:${(h.level - 1) * 16}px"><span class="code">H${h.level}</span> ${esc(h.text) || '<i>(empty)</i>'}</div>`).join('') : '';
  const failed = r.scans.filter((s) => !s.ok);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Accessibility Audit – ${esc(r.site)}</title><style>${CSS}</style></head><body><main>
<div class="cover"><p class="muted">${BRAND}</p><h1>${r.summaryOnly ? 'Homepage Accessibility Summary' : 'Website Accessibility Audit Report'}</h1><p><b>${esc(r.site)}</b> · scanned ${esc(r.date)} · ${r.pages.length} page(s) at ${r.scans.some((x) => x.viewport === 'mobile') ? 'desktop (1366px) and mobile (390px) widths' : 'desktop (1366px) width'} · standard: WCAG 2.1/2.2 Level AA</p></div>

<h2>Summary</h2>
<div class="kpis"><div class="kpi"><b>${t.issuesTotal}</b><span>WCAG issue instances</span></div><div class="kpi"><b>${t.byImpact.critical}</b><span>critical</span></div><div class="kpi"><b>${t.byImpact.serious}</b><span>serious</span></div><div class="kpi"><b>${t.byImpact.moderate + t.byImpact.minor}</b><span>moderate / minor</span></div><div class="kpi"><b>${t.rulesFailed}</b><span>distinct problems</span></div></div>
<p>${wcag.length ? `The most important problems to fix first are: ${wcag.slice(0, 3).map((f) => `<b>${esc(f.title.toLowerCase())}</b> (${f.instances})`).join('; ')}. Fixing a shared template (header, footer, product card) usually fixes the same issue on every page at once.` : 'No WCAG failures were detected by the automated checks on the pages scanned. That is a good sign, but it is not proof of conformance — see “What this report cannot tell you”.'}</p>
<p class="muted">An “instance” is one element on one page; the same element found at both screen widths is counted once. Severity follows axe-core’s impact rating: <b>critical</b> blocks some users entirely, <b>serious</b> causes significant difficulty, <b>moderate</b>/<b>minor</b> cause friction.</p>
${failed.length ? `<div class="note"><b>Could not scan:</b> ${failed.map((s) => `${esc(short(s.url))} (${esc(s.viewport)}): ${esc(s.reason)}`).join('; ')}. These pages are not counted in any total above; nothing was assumed about them.</div>` : ''}

<h2>Pages scanned</h2>
<table><tr><th>Page</th><th>Desktop</th><th>Mobile</th><th>WCAG failures found (desktop / mobile)</th></tr>${pageRows}</table>

${r.summaryOnly ? `<h2>Top problems on your homepage</h2>
${wcag.slice(0, 3).map((f, i) => issueBlock({ ...f, examples: f.examples.slice(0, 2) }, i + 1)).join('') || '<p>None detected by automated checks.</p>'}
${wcag.length > 3 ? `<h3>Also found</h3><table><tr><th>Problem</th><th>Severity</th><th>Instances</th><th>WCAG</th></tr>${wcag.slice(3).map((f) => `<tr><td>${esc(f.title)}</td><td>${esc(f.impact)}</td><td>${f.instances}</td><td>${esc(f.wcag.join(', '))}</td></tr>`).join('')}</table>` : ''}
<div class="note"><b>This is the free homepage summary.</b> The full Accessibility Audit Report ($149) covers up to 10 key pages (contact, booking, products, cart…) at desktop and phone widths, with every instance, its exact element and the code fix for each.</div>` : `<h2>Findings — WCAG failures, most severe first</h2>
${wcag.map((f, i) => issueBlock(f, i + 1)).join('') || '<p>None detected by automated checks.</p>'}`}

${bp.length && !r.summaryOnly ? `<h2>Best-practice recommendations</h2><p class="muted">These are not WCAG failures on their own, but fixing them makes the site noticeably easier to use with a keyboard or screen reader.</p>${bp.map((f, i) => issueBlock(f, wcag.length + i + 1)).join('')}` : ''}

<h2>Keyboard and zoom checks</h2>
<p>We pressed Tab through each page (up to 70 stops) and recorded where focus went, whether it was visible, and whether it got stuck. We also narrowed the window to 320px (equivalent to 400% zoom) to test reflow.</p>
<table><tr><th>Page</th><th>Tab stops</th><th>Skip link first</th><th>Stops with no visible focus</th><th>Focus trap</th><th>Reflow at 320px</th></tr>${kbRows}</table>
${home ? `<h3 style="margin-top:16px">Heading outline of the homepage</h3><p class="muted">Screen-reader users often navigate by headings; this is the outline they hear.</p><div style="font-size:13px">${outline || '<i>No headings found.</i>'}</div>` : ''}

<h2>What this report cannot tell you</h2>
<p>Automated testing reliably catches a large share of common, objectively testable problems (missing alt text, missing labels, contrast, missing names, language, some structure) — industry data puts it at roughly half of real-world issues by volume — but it <b>cannot</b> judge:</p>
<ul><li>whether alt text and link text are <i>meaningful</i> (only whether they exist);</li><li>whether the reading and focus order make sense, or whether every task can be completed by keyboard (we test Tab movement, not every interaction);</li><li>how the site behaves with real screen readers (JAWS, NVDA, VoiceOver) and voice control;</li><li>captions and transcripts for video/audio content, or the accessibility of PDFs and third-party widgets inside iframes (booking, chat, payments);</li><li>error handling and instructions in multi-step forms and checkout;</li><li>pages behind a login, or states that only appear after interaction (menus, modals, validation messages).</li></ul>
<p>A clean automated result is therefore <b>not</b> evidence of WCAG conformance. For a full conformance assessment, combine these fixes with manual testing by a person using assistive technology.</p>

<footer><p>${BRAND} · Report generated with axe-core ${esc(r.axeVersion)} (Deque Systems, MPL-2.0) and scripted Chromium checks on ${esc(r.date)}. Results reflect the pages as they loaded at scan time.</p><p>This report is a technical assessment, not legal advice. It does not certify compliance with the ADA, the European Accessibility Act or any other law, and it does not guarantee protection from legal claims.</p></footer>
</main></body></html>`;
}

// node build/verify_emails.cjs — renders each prospect's source_url in Chromium and records whether the
// email is visible on the page (innerText), present as a mailto: link, only in page source, or absent.
// Writes build/cache/email_check.json; finalize_prospects.py keeps only visible/mailto rows.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const csv = fs.readFileSync(path.join(__dirname, '..', 'prospects.csv'), 'utf8').trim().split('\n');
const head = csv[0].split(',');
const parse = line => { const out = []; let cur = '', q = false;
  for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur); return Object.fromEntries(head.map((h, i) => [h, out[i]])); };
const rows = csv.slice(1).map(parse);
(async () => {
  const b = await chromium.launch(), res = {};
  for (const r of rows) {
    const p = await b.newPage(), em = r.email.toLowerCase();
    try {
      await p.goto(r.source_url, { waitUntil: 'domcontentloaded', timeout: 30000 }); await p.waitForTimeout(2000);
      const t = (await p.evaluate(() => document.body.innerText)).toLowerCase(), h = (await p.content()).toLowerCase();
      res[r.id] = { email: em, url: r.source_url, seen: t.includes(em) ? 'visible' : h.includes('mailto:' + em) ? 'mailto' : h.includes(em) ? 'source-only' : 'absent', checked: new Date().toISOString() };
    } catch (e) { res[r.id] = { email: em, url: r.source_url, seen: 'error', error: String(e).slice(0, 120) }; }
    await p.close(); console.log(r.id, res[r.id].seen);
  }
  await b.close();
  fs.writeFileSync(path.join(__dirname, 'cache', 'email_check.json'), JSON.stringify(res, null, 1));
})();

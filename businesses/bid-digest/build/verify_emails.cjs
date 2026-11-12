// For each {id, url, email}: load url in Chromium and report whether the address appears in the rendered
// page text or a mailto: link. Reads JSON from argv[2], writes JSON to argv[3].
const { chromium } = require('playwright');
const fs = require('node:fs');
const items = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: false });
  const out = [];
  const queue = [...items];
  async function worker() {
    for (let it = queue.shift(); it; it = queue.shift()) {
      const page = await ctx.newPage();
      let found = false, how = '', err = '';
      try {
        await page.goto(it.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);
        const text = (await page.evaluate(() => document.body ? document.body.innerText : '')).toLowerCase();
        const mailto = (await page.evaluate(() => [...document.querySelectorAll('a[href^="mailto:"]')].map(a => a.href))).join(' ').toLowerCase();
        const raw = (await page.content()).toLowerCase();
        const e = it.email.toLowerCase();
        if (text.includes(e)) { found = true; how = 'visible text'; }
        else if (mailto.includes(e)) { found = true; how = 'mailto link'; }
        else if (raw.includes(e)) { found = true; how = 'page source'; }
      } catch (x) { err = String(x).slice(0, 120); }
      out.push({ ...it, found, how, err });
      await page.close();
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  await browser.close();
  fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });

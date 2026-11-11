// Render build/html/*.html to mockup/ (PNG at 300 dpi + PDF). Playwright is global:
//   NODE_PATH=$(npm root -g) node build/render.cjs   (from the mailer directory)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = (f) => 'file://' + path.join(root, 'build', 'html', f);
const out = (f) => path.join(root, 'mockup', f);
fs.mkdirSync(path.join(root, 'mockup'), { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const dpi = 300 / 96;
  // 1. route map first (the rate card embeds it)
  const sizes = JSON.parse(fs.readFileSync(path.join(root, 'build', 'html', 'sizes.json')));
  let p = await browser.newPage({ viewport: { width: sizes.map_w, height: sizes.map_h }, deviceScaleFactor: 1.5 });
  await p.goto(html('route-map.html'));
  await p.screenshot({ path: out('route-map.png'), fullPage: true });
  await p.close();
  // 2. card sides: 12.25 x 9.25 in incl. 0.125 in bleed, 300 dpi
  const W = Math.round(12.25 * 96), H = Math.round(9.25 * 96);
  for (const side of ['front', 'back']) {
    p = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: dpi });
    await p.goto(html(`card-${side}.html`));
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: out(`card-${side}.png`) });
    await p.pdf({ path: out(`card-${side}.pdf`), width: '12.25in', height: '9.25in', printBackground: true, pageRanges: '1' });
    await p.close();
  }
  console.log('card + map rendered');
  // 3. rate card (needs the JPG previews build/previews.py makes from step 2)
  if (fs.existsSync(out('card-front-preview.jpg'))) {
    p = await browser.newPage({ viewport: { width: 816, height: 1056 }, deviceScaleFactor: 2 });
    await p.goto(html('rate-card.html'));
    await p.waitForLoadState('networkidle');
    await p.pdf({ path: out('rate-card.pdf'), format: 'Letter', printBackground: true, preferCSSPageSize: true });
    await p.emulateMedia({ media: 'print' });
    await p.screenshot({ path: out('rate-card.png'), fullPage: true });
    await p.close();
    console.log('rate card rendered');
  }
  await browser.close();
})();

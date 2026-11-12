// Render a digest HTML file to a Letter-size PDF with headless Chromium.
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const [src, out] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(pathToFileURL(src).href, { waitUntil: 'load' });
  await page.pdf({ path: out, format: 'Letter', printBackground: true,
    margin: { top: '0.4in', bottom: '0.5in', left: '0.3in', right: '0.3in' }, displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#888">page <span class="pageNumber"></span> of <span class="totalPages"></span></div>' });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

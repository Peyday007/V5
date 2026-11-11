// node render_pdf.cjs in.html out.pdf — prints an HTML report to Letter PDF with headless Chromium.
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const [src, dst] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve(src), { waitUntil: 'load' });
  await page.pdf({ path: dst, format: 'Letter', printBackground: true,
    margin: { top: '0.55in', bottom: '0.6in', left: '0.55in', right: '0.55in' },
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#888"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });

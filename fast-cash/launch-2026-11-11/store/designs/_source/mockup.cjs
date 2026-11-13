const { chromium } = require('/opt/node-tools/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const OUT = '/home/user/V5/fast-cash/launch-2026-11-11/store/designs';
const uri = (rel) => 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, rel)).toString('base64');
const W = 1200, H = 1200;
const tee = (col, long = false) => `<path d="M420 170 Q600 250 780 170 L1010 270 L${long ? '1120 900 L1010 930 L930 470' : '1100 470 L960 540 L930 470'} L930 1080 L270 1080 L270 470 ${long ? 'L190 930 L80 900' : 'L240 540 L100 470'} L190 270 Z" fill="${col}" stroke="rgba(0,0,0,.15)" stroke-width="4"/><path d="M420 170 Q600 300 780 170" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="10"/>`;
const label = (t, sub) => `<text x="600" y="1140" text-anchor="middle" font-family="Inter" font-weight="700" font-size="34" fill="#1d2a44">${t}</text><text x="600" y="1180" text-anchor="middle" font-family="Inter" font-weight="400" font-size="22" fill="#666">${sub}</text>`;
const M = [
  ['01-coffee-then-sudoku-mug', 'print-11oz-2700x1050.png', 'mug', '#ffffff', 'Coffee First mug · 11 oz', 'preview only — not the supplier mockup'],
  ['02-solve-responsibly-tee', 'front-4500x5400-for-light-shirts.png', 'tee', '#d9d9d6', 'Solve Responsibly tee · light', 'preview only'],
  ['02-solve-responsibly-tee', 'front-4500x5400-for-dark-shirts.png', 'tee', '#22252b', 'Solve Responsibly tee · dark', 'preview only'],
  ['03-certified-pretty-good-tee', 'front-4500x5400-for-light-shirts.png', 'tee', '#ffffff', 'Certified Pretty Good tee', 'preview only'],
  ['03-certified-pretty-good-tee', 'front-4500x5400-for-dark-shirts.png', 'tee', '#2b3a55', 'Certified Pretty Good tee · navy', 'preview only'],
  ['04-merry-and-bright-holiday-sweatshirt', 'front-4500x5400-for-dark-shirts.png', 'sweat', '#24533f', 'Merry & Bright crewneck · Forest Green', 'preview only'],
  ['05-puzzle-supplies-tote', 'front-4200x4200-for-natural-tote.png', 'tote', '#efe6d2', 'Puzzle Supplies tote · Oyster', 'preview only'],
  ['06-one-solution-poster', 'print-18x24in-5400x7200.png', 'poster', '#ffffff', 'Exactly One Solution poster · 18×24', 'preview only'],
  ['07-large-print-morning-puzzle-mug', 'print-15oz-4500x2100.png', 'mug', '#ffffff', 'Large Print mug · 15 oz', 'preview only'],
  ['08-focus-mode-mug', 'print-11oz-2700x1050.png', 'mug', '#ffffff', 'Focus Mode mug · colour inside', 'preview only'],
  ['09-sudoku-coaster', 'print-1200x1200.png', 'coaster', '#ffffff', 'Sudoku cork coaster', 'preview only'],
  ['10-puzzle-notes-journal', 'wrap-3300x2250.png', 'journal', '#ffffff', 'Puzzle Notes hardcover journal', 'preview only'],
];
function scene(kind, col, img, file) {
  let s = `<rect width="${W}" height="${H}" fill="#f3f1ec"/>`;
  if (kind === 'tee' || kind === 'sweat') { s += tee(col, kind === 'sweat'); s += `<image href="${img}" x="420" y="300" width="360" height="432"/>`; }
  if (kind === 'mug') {
    const wide = file.includes('4500') ? 4500 / 2100 : 2700 / 1050; const mh = 620, mw = 520; // show the centre 'front' third
    const fullW = mh * wide;
    s += `<defs><clipPath id="c"><rect x="300" y="260" width="${mw}" height="${mh}" rx="30"/></clipPath><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".18"/><stop offset=".25" stop-color="#000" stop-opacity="0"/><stop offset=".8" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></linearGradient></defs>`;
    s += `<path d="M815 380 C 1010 380 1010 760 815 760" fill="none" stroke="#e4e4e4" stroke-width="58"/><path d="M815 380 C 1010 380 1010 760 815 760" fill="none" stroke="rgba(0,0,0,.1)" stroke-width="58" stroke-dasharray="1 0"/>`;
    s += `<rect x="300" y="260" width="${mw}" height="${mh}" rx="30" fill="#fff"/>`;
    s += `<g clip-path="url(#c)"><image href="${img}" x="${300 + mw / 2 - fullW / 2 + (file.includes('4500') ? 0 : fullW * 0.0)}" y="${260 + (mh - mh) / 2}" width="${fullW}" height="${mh}" preserveAspectRatio="none"/></g>`;
    s += `<rect x="300" y="260" width="${mw}" height="${mh}" rx="30" fill="url(#g)"/>`;
  }
  if (kind === 'tote') { s += `<path d="M430 360 C 430 120 770 120 770 360" fill="none" stroke="${col}" stroke-width="40"/><path d="M430 360 C 430 120 770 120 770 360" fill="none" stroke="rgba(0,0,0,.12)" stroke-width="40"/><rect x="260" y="340" width="680" height="740" fill="${col}" stroke="rgba(0,0,0,.15)" stroke-width="4"/><image href="${img}" x="370" y="470" width="460" height="460"/>`; }
  if (kind === 'poster') { s += `<rect x="330" y="120" width="540" height="720" fill="#222"/><image href="${img}" x="345" y="135" width="510" height="680"/><rect x="250" y="900" width="700" height="200" fill="#e7e1d6"/>`; }
  if (kind === 'coaster') { s += `<rect x="290" y="290" width="620" height="620" rx="40" fill="#b88b5a"/><image href="${img}" x="310" y="310" width="580" height="580"/>`; }
  if (kind === 'journal') { s += `<defs><clipPath id="j"><rect x="380" y="200" width="480" height="700" rx="12"/></clipPath></defs><rect x="370" y="195" width="500" height="715" rx="14" fill="#111"/><g clip-path="url(#j)"><image href="${img}" x="${380 - 480 * 1.09}" y="${200 - 700 * 0.0333}" width="${700 * 3300 / 2250 * 1.0}" height="${700 * 1.0667}" preserveAspectRatio="none"/></g>`; }
  return s;
}
(async () => {
  const b = await chromium.launch({ args: ['--disable-gpu'] });
  for (const [dir, file, kind, col, t, sub] of M) {
    const img = uri(path.join(dir, file));
    const pg = await b.newPage({ viewport: { width: W, height: H } });
    await pg.setContent(`<html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${scene(kind, col, img, file)}${label(t, sub)}</svg></body></html>`);
    await pg.waitForTimeout(150);
    const name = 'mockup-preview' + (file.includes('dark') && dir.match(/0[23]-/) ? '-dark' : file.includes('light') ? '-light' : '') + '.png';
    await pg.screenshot({ path: path.join(OUT, dir, name) }); await pg.close(); console.log(dir, name);
  }
  await b.close();
})();

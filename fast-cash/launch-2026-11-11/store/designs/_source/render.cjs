const { chromium } = require('/opt/node-tools/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const P = JSON.parse(fs.readFileSync(path.join(__dirname, 'puzzles.json'), 'utf8'));
const OUT = '/home/user/V5/fast-cash/launch-2026-11-11/store/designs';
const only = process.argv[2] || null;

// ---------- primitives ----------
function grid(p, { x = 0, y = 0, size, ink = '#1d2a44', thin = null, thick = null, font = 'Inter', weight = 600, fill = null, digits = 'grid', digitInk = null, rotate = 0 }) {
  const rows = digits === 'grid' ? p.grid : p.solution;
  const c = size / 9; thin = thin ?? Math.max(1, size / 500); thick = thick ?? Math.max(3, size / 110);
  let s = `<g transform="translate(${x},${y}) rotate(${rotate} ${size / 2} ${size / 2})">`;
  if (fill) s += `<rect x="0" y="0" width="${size}" height="${size}" fill="${fill}"/>`;
  for (let i = 1; i < 9; i++) if (i % 3) {
    s += `<line x1="${i * c}" y1="0" x2="${i * c}" y2="${size}" stroke="${ink}" stroke-width="${thin}"/>`;
    s += `<line x1="0" y1="${i * c}" x2="${size}" y2="${i * c}" stroke="${ink}" stroke-width="${thin}"/>`;
  }
  for (let i = 1; i < 3; i++) {
    s += `<line x1="${i * 3 * c}" y1="0" x2="${i * 3 * c}" y2="${size}" stroke="${ink}" stroke-width="${thick}"/>`;
    s += `<line x1="0" y1="${i * 3 * c}" x2="${size}" y2="${i * 3 * c}" stroke="${ink}" stroke-width="${thick}"/>`;
  }
  s += `<rect x="${thick / 2}" y="${thick / 2}" width="${size - thick}" height="${size - thick}" fill="none" stroke="${ink}" stroke-width="${thick}"/>`;
  rows.forEach((row, r) => [...row].forEach((ch, k) => {
    if (ch === '.' ) return;
    s += `<text x="${k * c + c / 2}" y="${r * c + c / 2}" dy="0.36em" text-anchor="middle" font-family="${font}" font-weight="${weight}" font-size="${c * 0.62}" fill="${digitInk || ink}">${ch}</text>`;
  }));
  return s + '</g>';
}
const T = (x, y, txt, o = {}) => `<text x="${x}" y="${y}" text-anchor="${o.anchor || 'middle'}" font-family="${o.font || 'Inter Display'}" font-weight="${o.weight || 900}" font-size="${o.size}" fill="${o.fill || '#1d2a44'}" letter-spacing="${o.ls || 0}" ${o.extra || ''}>${txt}</text>`;
const svg = (w, h, body, bg = null) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ''}${body}</svg>`;
function snow(cx, cy, r, col, sw) { let s = ''; for (let a = 0; a < 6; a++) { const t = a * Math.PI / 3; const x2 = cx + r * Math.cos(t), y2 = cy + r * Math.sin(t); s += `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>`; for (const f of [0.55]) { const bx = cx + r * f * Math.cos(t), by = cy + r * f * Math.sin(t); for (const d of [-1, 1]) { const tt = t + d * 0.6; s += `<line x1="${bx}" y1="${by}" x2="${bx + r * 0.3 * Math.cos(tt)}" y2="${by + r * 0.3 * Math.sin(tt)}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>`; } } } return s; }
function pencil(x, y, len, rot, col) { const h = len / 7; return `<g transform="translate(${x},${y}) rotate(${rot})"><rect x="0" y="${-h / 2}" width="${len * 0.78}" height="${h}" rx="${h * 0.12}" fill="${col.body}"/><rect x="${-h * 0.9}" y="${-h / 2}" width="${h}" height="${h}" rx="${h * 0.2}" fill="${col.eraser}"/><polygon points="${len * 0.78},${-h / 2} ${len},0 ${len * 0.78},${h / 2}" fill="${col.wood}"/><polygon points="${len * 0.93},${-h * 0.15} ${len},0 ${len * 0.93},${h * 0.15}" fill="${col.lead}"/></g>`; }

const NAVY = '#1d2a44', RED = '#d6453d', CREAM = '#fbf6ec', GOLD = '#e0b04b', GREEN = '#2e6b4f';

// ---------- designs ----------
const D = [];
// 1 Coffee & Sudoku mug 11oz (2700x1050)
D.push({ dir: '01-coffee-then-sudoku-mug', file: 'print-11oz-2700x1050.png', w: 2700, h: 1050, transparent: false, bg: '#ffffff', body: () => {
  const p = P.mug; let s = '';
  s += grid(p, { x: 120, y: 105, size: 840, ink: NAVY });
  s += T(1400, 400, 'COFFEE', { size: 165, fill: NAVY, ls: 8 });
  s += T(1400, 560, 'FIRST.', { size: 165, fill: RED, ls: 8 });
  s += T(1400, 700, 'then the 9×9', { size: 86, font: 'Caladea', weight: 700, fill: NAVY, extra: 'font-style="italic"' });
  s += T(1400, 830, 'exactly one solution · answer on the back', { size: 32, font: 'Inter', weight: 500, fill: NAVY, ls: 2 });
  s += grid(p, { x: 1950, y: 285, size: 480, ink: '#7d869a', digits: 'solution', rotate: 180, weight: 500 });
  s += T(2190, 845, 'ANSWER · NO PEEKING', { size: 30, font: 'Inter', weight: 700, fill: '#7d869a', ls: 4 });
  return s; } });
// 2 Solve Responsibly tee (dark ink, for light shirts) + white-ink variant
for (const [suffix, ink, accent] of [['for-light-shirts', NAVY, RED], ['for-dark-shirts', '#ffffff', '#ff7a6b']]) {
  D.push({ dir: '02-solve-responsibly-tee', file: `front-4500x5400-${suffix}.png`, w: 4500, h: 5400, transparent: true, body: () => {
    const p = P.tee; let s = '';
    s += T(2250, 900, 'SOLVE', { size: 760, fill: ink, ls: 30 });
    s += T(2250, 1560, 'RESPONSIBLY', { size: 520, fill: accent, ls: 18 });
    s += grid(p, { x: 750, y: 1900, size: 3000, ink, weight: 700, thick: 34, thin: 9 });
    s += T(2250, 5250, 'USE A PENCIL · THERE IS EXACTLY ONE ANSWER', { size: 150, font: 'Inter', weight: 700, fill: ink, ls: 12 });
    return s; } });
}
// 3 Certified Pretty Good tee (Bella 3001) light/dark
for (const [suffix, ink, accent] of [['for-light-shirts', NAVY, RED], ['for-dark-shirts', '#ffffff', GOLD]]) {
  D.push({ dir: '03-certified-pretty-good-tee', file: `front-4500x5400-${suffix}.png`, w: 4500, h: 5400, transparent: true, body: () => {
    const p = P.okayest; let s = '';
    const cx = 2250, cy = 1900;
    s += `<circle cx="${cx}" cy="${cy}" r="1700" fill="none" stroke="${ink}" stroke-width="60"/><circle cx="${cx}" cy="${cy}" r="1250" fill="none" stroke="${ink}" stroke-width="24"/>`;
    s += `<defs><path id="arcT${suffix}" d="M ${cx - 1390} ${cy} A 1390 1390 0 0 1 ${cx + 1390} ${cy}"/><path id="arcB${suffix}" d="M ${cx - 1570} ${cy} A 1570 1570 0 0 0 ${cx + 1570} ${cy}"/></defs>`;
    s += `<text font-family="Inter Display" font-weight="900" font-size="270" fill="${ink}" letter-spacing="40" text-anchor="middle"><textPath href="#arcT${suffix}" startOffset="50%">CERTIFIED</textPath></text>`;
    s += `<text font-family="Inter Display" font-weight="900" font-size="230" fill="${ink}" letter-spacing="30" text-anchor="middle"><textPath href="#arcB${suffix}" startOffset="50%">SUDOKU SOLVER</textPath></text>`;
    for (const sx of [-1475, 1475]) s += `<circle cx="${cx + sx}" cy="${cy}" r="55" fill="${accent}"/>`;
    s += grid(p, { x: cx - 800, y: cy - 800, size: 1600, ink, weight: 700, thick: 22, thin: 6 });
    s += T(2250, 4250, 'PRETTY GOOD', { size: 470, fill: accent, ls: 12 });
    s += T(2250, 4750, 'not the best · not the worst · finishes eventually', { size: 150, font: 'Caladea', weight: 700, fill: ink, extra: 'font-style="italic"' });
    return s; } });
}
// 4 Holiday sweatshirt (white+gold ink for dark colours)
D.push({ dir: '04-merry-and-bright-holiday-sweatshirt', file: 'front-4500x5400-for-dark-shirts.png', w: 4500, h: 5400, transparent: true, body: () => {
  const p = P.sweatshirt; let s = '';
  s += T(2250, 820, 'MERRY &amp; BRIGHT', { size: 520, fill: '#ffffff', ls: 20 });
  s += T(2250, 1250, 'and nine by nine', { size: 300, font: 'Caladea', weight: 700, fill: GOLD, extra: 'font-style="italic"' });
  s += grid(p, { x: 900, y: 1550, size: 2700, ink: '#ffffff', weight: 700, thick: 30, thin: 8 });
  for (const [x, y, r] of [[480, 1900, 260], [4020, 1900, 260], [420, 3500, 200], [4080, 3500, 200]]) if (r) s += snow(x, y, r, GOLD, 40);
  s += T(2250, 4800, 'HAPPY HOLIDAYS · PENCIL INCLUDED IN SPIRIT', { size: 140, font: 'Inter', weight: 700, fill: '#ffffff', ls: 10 });
  return s; } });
// 5 Tote (dark ink for Oyster/natural)
D.push({ dir: '05-puzzle-supplies-tote', file: 'front-4200x4200-for-natural-tote.png', w: 4200, h: 4200, transparent: true, body: () => {
  const p = P.tote; let s = '';
  s += T(2100, 560, 'PUZZLE SUPPLIES', { size: 400, fill: NAVY, ls: 16 });
  s += grid(p, { x: 750, y: 820, size: 2700, ink: NAVY, weight: 700, thick: 30, thin: 8 });
  s += pencil(850, 3880, 1500, -8, { body: '#f2b632', eraser: '#e98a8a', wood: '#e8c79a', lead: NAVY });
  s += T(3200, 3900, 'carry one · solve one', { size: 170, font: 'Caladea', weight: 700, fill: RED, extra: 'font-style="italic"' });
  return s; } });
// 6 Poster 18x24 (5400x7200)
D.push({ dir: '06-one-solution-poster', file: 'print-18x24in-5400x7200.png', w: 5400, h: 7200, transparent: false, bg: CREAM, body: () => {
  const p = P.poster; let s = '';
  s += `<rect x="180" y="180" width="5040" height="6840" fill="none" stroke="${NAVY}" stroke-width="18"/>`;
  s += T(2700, 900, 'ONE GRID · ONE ANSWER', { size: 170, font: 'Inter', weight: 700, fill: RED, ls: 40 });
  s += T(2700, 1400, 'Exactly One Solution', { size: 400, font: 'Caladea', weight: 700, fill: NAVY });
  s += grid(p, { x: 600, y: 1800, size: 4200, ink: NAVY, weight: 600, thick: 40, thin: 9, font: 'Caladea' });
  s += T(2700, 6380, `28 givens · proved unique by an independent solver`, { size: 120, font: 'Inter', weight: 500, fill: NAVY, ls: 6 });
  s += T(2700, 6620, `puzzle id ${p.hash.slice(0, 12)}`, { size: 100, font: 'JetBrains Mono', weight: 500, fill: '#7d869a', ls: 4 });
  s += grid(p, { x: 4560, y: 6340, size: 420, ink: '#9aa1b2', digits: 'solution', rotate: 180, thick: 6, thin: 1.5, weight: 500 });
  return s; } });
// 7 Large print mug 15oz (Fourthwall canvas 4500x2100)
D.push({ dir: '07-large-print-morning-puzzle-mug', file: 'print-15oz-4500x2100.png', w: 4500, h: 2100, transparent: false, bg: '#ffffff', body: () => {
  const p = P.largeprint; let s = '';
  s += grid(p, { x: 1500, y: 150, size: 1800, ink: '#111111', weight: 800, thick: 22, thin: 6 });
  s += T(750, 760, 'LARGE', { size: 260, fill: NAVY, ls: 10 });
  s += T(750, 1040, 'PRINT', { size: 260, fill: RED, ls: 10 });
  s += T(750, 1300, 'morning puzzle', { size: 130, font: 'Caladea', weight: 700, fill: NAVY, extra: 'font-style="italic"' });
  s += T(750, 1500, 'one solution · easy', { size: 70, font: 'Inter', weight: 600, fill: NAVY, ls: 4 });
  s += grid(p, { x: 3780, y: 650, size: 560, ink: '#7d869a', digits: 'solution', rotate: 180, weight: 500 });
  s += T(4060, 1330, 'ANSWER', { size: 50, font: 'Inter', weight: 700, fill: '#7d869a', ls: 6 });
  return s; } });
// 8 Expert mode mug (color inside) 11oz
D.push({ dir: '08-focus-mode-mug', file: 'print-11oz-2700x1050.png', w: 2700, h: 1050, transparent: false, bg: '#ffffff', body: () => {
  const p = P.blackmug; let s = '';
  s += grid(p, { x: 120, y: 105, size: 840, ink: NAVY });
  s += T(1400, 430, 'FOCUS', { size: 190, fill: NAVY, ls: 10 });
  s += T(1400, 630, 'MODE', { size: 190, fill: RED, ls: 10 });
  s += T(1400, 780, '28 givens. one answer. no hints.', { size: 54, font: 'Caladea', weight: 700, fill: NAVY, extra: 'font-style="italic"' });
  s += grid(p, { x: 1950, y: 285, size: 480, ink: '#7d869a', digits: 'solution', rotate: 180, weight: 500 });
  s += T(2190, 845, 'ANSWER · NO PEEKING', { size: 30, font: 'Inter', weight: 700, fill: '#7d869a', ls: 4 });
  return s; } });
// 9 Coaster 1200x1200
D.push({ dir: '09-sudoku-coaster', file: 'print-1200x1200.png', w: 1200, h: 1200, transparent: false, bg: CREAM, body: () => {
  const p = P.coaster; let s = '';
  s += T(600, 150, 'SET YOUR MUG HERE', { size: 62, font: 'Inter', weight: 800, fill: RED, ls: 6 });
  s += grid(p, { x: 150, y: 210, size: 900, ink: NAVY, weight: 700, thick: 10, thin: 3 });
  s += T(600, 1165, 'after you solve it', { size: 50, font: 'Caladea', weight: 700, fill: NAVY, extra: 'font-style="italic"' });
  return s; } });
// 10 Journal wrap (approx 11 x 7.5 in) + front only
D.push({ dir: '10-puzzle-notes-journal', file: 'wrap-3300x2250.png', w: 3300, h: 2250, transparent: false, bg: NAVY, body: () => {
  const p = P.journal; let s = '';
  // right half = front cover
  s += T(2475, 420, 'PUZZLE NOTES', { size: 190, fill: '#ffffff', ls: 10 });
  s += grid(p, { x: 1950, y: 600, size: 1050, ink: '#ffffff', weight: 700, thick: 12, thin: 3 });
  s += T(2475, 1880, 'scratch work · strategies · streaks', { size: 64, font: 'Caladea', weight: 700, fill: GOLD, extra: 'font-style="italic"' });
  // left half = back cover with solution
  s += T(825, 420, 'THE ANSWER', { size: 110, fill: GOLD, ls: 10 });
  s += grid(p, { x: 450, y: 560, size: 750, ink: '#c7cede', digits: 'solution', weight: 500, thick: 9, thin: 2 });
  s += T(825, 1480, 'to the puzzle on the front.', { size: 54, font: 'Caladea', weight: 700, fill: '#c7cede', extra: 'font-style="italic"' });
  s += `<line x1="1650" y1="0" x2="1650" y2="2250" stroke="#ffffff" stroke-opacity="0.12" stroke-width="4" stroke-dasharray="20 20"/>`;
  return s; } });

(async () => {
  for (const d of D) {
    if (only && !d.dir.startsWith(only)) continue;
    const dir = path.join(OUT, d.dir); fs.mkdirSync(dir, { recursive: true });
    for (let attempt = 1; attempt <= 4; attempt++) {
      const b = await chromium.launch({ args: ['--disable-gpu', '--force-device-scale-factor=1'] });
      try {
        const sc = 2; // render at half-size viewport, 2x DPR -> full pixel size
        const pg = await b.newPage({ viewport: { width: Math.ceil(d.w / sc), height: Math.ceil(d.h / sc) }, deviceScaleFactor: sc });
        const html = svg(d.w, d.h, d.body(), d.transparent ? null : d.bg).replace(`width="${d.w}" height="${d.h}"`, `width="${d.w / sc}" height="${d.h / sc}"`);
        await pg.setContent(`<html><body style="margin:0;${d.transparent ? 'background:transparent' : ''}">${html}</body></html>`);
        await pg.evaluate(() => document.fonts.ready);
        await pg.screenshot({ path: path.join(dir, d.file), omitBackground: !!d.transparent });
        console.log('wrote', d.dir, d.file); await b.close(); break;
      } catch (e) { console.log('retry', d.file, attempt, e.message.split('\n')[0]); await b.close(); }
    }
  }
})();

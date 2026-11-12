// Renders the Etsy listing images (2700 × 2025 PNG, 4:3) from HTML with Playwright,
// using real pages of the real PDFs (rasterised with pdftoppm).
//
//   node fast-cash/launch-2026-11-11/etsy/tools/build-images.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PRODUCTS } from './catalog.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TMP = fs.mkdtempSync(path.join(process.env.SCRATCH ?? os.tmpdir(), 'etsy-img-'));
const W = 2700;
const H = 2025;

const PAL = {
  holiday: { bg: '#F7F1E3', deep: '#1F4D3A', accent: '#B3263E', gold: '#C9A227', soft: '#E7DFC9' },
  classic: { bg: '#F4F1EA', deep: '#1E3A5F', accent: '#2E7D6B', gold: '#E0A526', soft: '#E2DDD0' },
  kids: { bg: '#FFF6E8', deep: '#B3263E', accent: '#1F6F43', gold: '#F2B544', soft: '#F4E3C8' },
};

function pdfOf(slug) {
  const dir = path.join(ROOT, 'products', slug);
  return path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.pdf')));
}
function manifestOf(slug) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'products', slug, 'manifest.json'), 'utf8'));
}
/** Rasterise one PDF page; returns a file:// URL. */
function pageImg(slug, n, dpi = 150) {
  const out = path.join(TMP, `${slug}-p${n}-${dpi}`);
  if (!fs.existsSync(`${out}.png`)) execFileSync('pdftoppm', ['-r', String(dpi), '-png', '-singlefile', '-f', String(n), '-l', String(n), pdfOf(slug), out]);
  return `file://${out}.png`;
}

const BASE = (pal) => `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
body { font-family: Inter, sans-serif; background: ${pal.bg}; color: #1d1d1d; position: relative; }
.serif { font-family: Caladea, 'DejaVu Serif', serif; }
.sheet { position: absolute; background: #fff; box-shadow: 0 30px 70px rgba(0,0,0,.28), 0 4px 12px rgba(0,0,0,.12); border-radius: 6px; overflow: hidden; }
.sheet img { width: 100%; height: 100%; display: block; object-fit: cover; }
.pill { display: inline-block; background: ${pal.accent}; color: #fff; font-weight: 800; border-radius: 999px; padding: 26px 56px; font-size: 64px; letter-spacing: .02em; }
.bar { position: absolute; left: 0; right: 0; bottom: 0; height: 170px; background: ${pal.deep}; color: #fff; display: flex; align-items: center; justify-content: center; gap: 70px; font-size: 62px; font-weight: 700; letter-spacing: .02em; }
.bar span.dot { color: ${pal.gold}; }
h1 { font-family: Caladea, 'DejaVu Serif', serif; color: ${pal.deep}; line-height: 1.02; }
`;

function hero(p, m) {
  const pal = PAL[p.theme];
  const cover = p.bundle ? null : pageImg(p.slug, 1, 110);
  const sheets = p.bundle
    ? p.bundle.map((s, i) => `<div class="sheet" style="width:500px;height:647px;left:${50 + i * 140}px;top:${330 + (i % 2) * 70}px;transform:rotate(${-10 + i * 5}deg);z-index:${i}"><img src="${pageImg(s, 1, 90)}"></div>`).join('')
    : `<div class="sheet" style="width:640px;height:828px;left:330px;top:470px;transform:rotate(7deg)"><img src="${pageImg(p.slug, 5, 90)}"></div>
       <div class="sheet" style="width:900px;height:1165px;left:150px;top:260px;transform:rotate(-4deg)"><img src="${cover}"></div>`;
  return `<style>${BASE(pal)}</style>
  <div style="position:absolute;left:1300px;top:250px;width:1290px">
    <div style="font-size:66px;font-weight:800;letter-spacing:.3em;color:${pal.accent};text-transform:uppercase">Printable PDF</div>
    <h1 style="font-size:${p.name.length > 26 ? 168 : 190}px;margin:34px 0 40px">${p.name}</h1>
    <div style="font-size:84px;font-weight:700;color:#333">${p.count[0].toUpperCase() + p.count.slice(1)}${p.bundle ? ' in 5 books' : ' · one per page'}</div>
    <div style="margin-top:70px"><span class="pill">Instant Download</span></div>
  </div>
  ${sheets}
  <div class="bar"><span>Instant Download</span><span class="dot">●</span><span>Large Print</span><span class="dot">●</span><span>Solutions Included</span></div>`;
}

function inside(p, m) {
  const pal = PAL[p.theme];
  let pages;
  if (p.bundle) pages = [pageImg(p.bundle[0], 6, 110), pageImg(p.bundle[4], 6, 110), pageImg(p.bundle[3], 6, 110)];
  else {
    const n = p.slug === 'christmas-activity-pack' ? [4, 18, 30] : [4, 4 + Math.floor(m.puzzles / 2), 3 + m.puzzles];
    pages = n.map((k) => pageImg(p.slug, k, 110));
  }
  return `<style>${BASE(pal)}</style>
  <h1 style="position:absolute;top:110px;left:0;right:0;text-align:center;font-size:150px">A look inside</h1>
  <div style="position:absolute;top:290px;left:0;right:0;text-align:center;font-size:64px;color:#444;font-weight:600">${p.bundle ? 'Real pages from three of the five books' : 'Real pages from the PDF you download'}</div>
  ${pages.map((src, i) => `<div class="sheet" style="width:780px;height:1010px;left:${150 + i * 820}px;top:${470 + (i === 1 ? -20 : 20)}px;transform:rotate(${(i - 1) * 2.5}deg)"><img src="${src}"></div>`).join('')}`;
}

function bigPrint(p, m) {
  const pal = PAL[p.theme];
  const slug = p.bundle ? p.bundle[0] : p.slug;
  const src = pageImg(slug, 5, 220);
  const kind = /maze/i.test(p.slug) ? 'Thick, dark lines' : /word/i.test(p.slug) ? 'Big, bold letters' : 'Big, clear numbers';
  const points = /maze/i.test(p.slug)
    ? ['One maze per page', 'Exactly one way through', 'Prints crisp on any printer']
    : /word/i.test(p.slug)
      ? ['One puzzle per page', 'Tick-box word list', 'Every word appears exactly once']
      : p.slug === 'christmas-activity-pack'
        ? ['Easy to read for kids', 'Answers at the back', 'Print again and again']
        : ['One puzzle per page', 'Room to pencil in notes', 'Exactly one solution each'];
  return `<style>${BASE(pal)}</style>
  <div class="sheet" style="width:1300px;height:1682px;left:140px;top:170px"><img src="${src}"></div>
  <div style="position:absolute;left:1560px;top:330px;width:1040px">
    <h1 style="font-size:150px;margin-bottom:60px">${kind}</h1>
    ${points.map((t) => `<div style="display:flex;align-items:center;gap:36px;font-size:76px;font-weight:700;margin:52px 0"><span style="width:96px;height:96px;border-radius:50%;background:${pal.accent};color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:62px">✓</span>${t}</div>`).join('')}
    <div style="margin-top:80px;font-size:58px;color:#555;font-weight:600">US Letter · 8.5" × 11"</div>
  </div>`;
}

function whatYouGet(p, m) {
  const pal = PAL[p.theme];
  const rows = p.bullets.slice(0, 6);
  const covers = p.bundle ?? [p.slug];
  return `<style>${BASE(pal)}</style>
  <h1 style="position:absolute;top:120px;left:0;right:0;text-align:center;font-size:160px">What you get</h1>
  <div style="position:absolute;left:150px;top:400px;width:${p.bundle ? 1500 : 1500}px">
    ${rows.map((t) => `<div style="display:flex;gap:34px;align-items:flex-start;font-size:${p.bundle ? 64 : 66}px;font-weight:600;line-height:1.25;margin:0 0 46px"><span style="flex:none;width:30px;height:30px;margin-top:26px;border-radius:50%;background:${pal.accent}"></span><span>${t.replace(/—/g, '–')}</span></div>`).join('')}
  </div>
  ${covers.length === 1
    ? `<div class="sheet" style="width:880px;height:1139px;left:1720px;top:480px;transform:rotate(3deg)"><img src="${pageImg(p.slug, 1, 110)}"></div>`
    : covers.map((s, i) => `<div class="sheet" style="width:470px;height:608px;left:${1700 + (i % 2) * 420}px;top:${380 + Math.floor(i / 2) * 470}px;transform:rotate(${(i % 2 ? 4 : -4)}deg);z-index:${i}"><img src="${pageImg(s, 1, 80)}"></div>`).join('')}`;
}

function solutions(p, m) {
  const pal = PAL[p.theme];
  let solPage = 4 + m.puzzles;
  if (/sudoku/.test(p.slug) && !p.bundle) solPage = 3 + m.puzzles + 1; // cover, rights, how-to, puzzles…
  return `<style>${BASE(pal)}</style>
  <div class="sheet" style="width:1250px;height:1618px;left:180px;top:200px;transform:rotate(-2deg)"><img src="${pageImg(p.slug, solPage, 200)}"></div>
  <div style="position:absolute;left:1600px;top:520px;width:960px">
    <h1 style="font-size:160px">Solutions included</h1>
    <div style="font-size:74px;font-weight:600;color:#333;margin-top:60px;line-height:1.35">Every answer is at the back of the book, so you can check your work any time.</div>
  </div>`;
}

function howItWorks(p) {
  const pal = PAL[p.theme];
  const steps = [
    ['1', 'Buy', 'Check out on Etsy as usual.'],
    ['2', 'Download', 'Open You › Purchases and tap Download Files. A link also arrives by email.'],
    ['3', 'Print', 'At home or at a print shop — as many copies as you need for personal use.'],
  ];
  return `<style>${BASE(pal)}</style>
  <h1 style="position:absolute;top:150px;left:0;right:0;text-align:center;font-size:150px">How instant download works</h1>
  <div style="position:absolute;top:520px;left:150px;right:150px;display:flex;gap:90px">
    ${steps.map(([n, t, d]) => `<div style="flex:1;background:#fff;border-radius:40px;padding:90px 70px;box-shadow:0 18px 50px rgba(0,0,0,.12);text-align:center;min-height:900px">
      <div style="width:210px;height:210px;border-radius:50%;background:${pal.deep};color:#fff;font-size:120px;font-weight:800;display:flex;align-items:center;justify-content:center;margin:0 auto 60px">${n}</div>
      <div class="serif" style="font-size:118px;font-weight:700;color:${pal.deep}">${t}</div>
      <div style="font-size:64px;line-height:1.35;color:#333;margin-top:40px;font-weight:500">${d}</div></div>`).join('')}
  </div>
  <div class="bar" style="font-size:58px">This is a digital file · nothing is shipped · US Letter, also prints on A4</div>`;
}

const RENDER = { '01-hero': hero, '02-inside': inside, '03-big-print': bigPrint, '04-what-you-get': whatYouGet, '05-solutions': solutions, '06-instant-download': howItWorks };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
let total = 0;
for (const p of PRODUCTS) {
  const m = p.bundle ? null : manifestOf(p.slug);
  const dir = path.join(ROOT, 'images', p.slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
  for (const [i, key] of p.images.entries()) {
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${RENDER[key](p, m)}</body></html>`;
    const file = path.join(TMP, `${p.slug}-${key}.html`);
    fs.writeFileSync(file, html);
    await page.goto(`file://${file}`, { waitUntil: 'load' });
    const out = path.join(dir, `${String(i + 1).padStart(2, '0')}-${key.slice(3)}.png`);
    await page.screenshot({ path: out, type: 'png' });
    total += fs.statSync(out).size;
  }
  console.log(`images ${p.slug}: ${p.images.length}`);
}
await browser.close();
console.log(`TOTAL ${(total / 1048576).toFixed(1)} MB`);

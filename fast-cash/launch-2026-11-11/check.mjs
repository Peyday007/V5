// Verifies the three launch kits are complete: every sellable file is present,
// and README.md answers the owner's four questions for each business.
// Usage: node fast-cash/launch-2026-11-11/check.mjs [ready|missing|cost|actions|all]
import fs from 'node:fs';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname);
const want = process.argv[2] ?? 'all';
const fails = [];
const need = (cond, msg) => { if (!cond) fails.push(msg); };
const exists = (p) => fs.existsSync(path.join(dir, p));
const files = (p, re) => {
  const root = path.join(dir, p);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const e of fs.readdirSync(root, { recursive: true })) if (re.test(String(e))) out.push(String(e));
  return out;
};

// What is ready: the actual selling assets.
const etsyPdfs = files('etsy/products', /\.pdf$/);
const etsyImgs = files('etsy/images', /\.png$/);
const storePrints = files('store/designs', /^(?!.*mockup).*\.png$/).filter((f) => !f.startsWith('_'));
const mailerArt = files('mailer', /\.(pdf|png)$/);
if (want === 'ready' || want === 'all') {
  need(etsyPdfs.length >= 6, `etsy: ${etsyPdfs.length} product PDFs (need >= 6)`);
  need(etsyImgs.length >= 30, `etsy: ${etsyImgs.length} listing images (need >= 30)`);
  need(exists('etsy/listings.csv') && exists('etsy/LISTINGS.md'), 'etsy: listing copy missing');
  need(storePrints.length >= 10, `store: ${storePrints.length} print files (need >= 10)`);
  need(exists('store/catalog.csv') && exists('store/STORE-SETUP.md'), 'store: catalog or setup missing');
  need(mailerArt.length >= 3, `mailer: ${mailerArt.length} mock-up/rate-card files (need >= 3)`);
  need(exists('mailer/prospects.csv'), 'mailer: prospects.csv missing');
  const prospects = exists('mailer/prospects.csv') ? fs.readFileSync(path.join(dir, 'mailer/prospects.csv'), 'utf8').trim().split('\n').length - 1 : 0;
  need(prospects >= 60, `mailer: ${prospects} prospects (need >= 60)`);
}

// The report: each business answers all four questions.
const readme = exists('README.md') ? fs.readFileSync(path.join(dir, 'README.md'), 'utf8') : '';
const sections = { ready: /What is ready/i, missing: /Missing before customers can buy/i, cost: /Exact cost to activate/i, actions: /Action required from you/i };
for (const biz of ['Local co-op mailer', 'Etsy shop', 'Dropshipping store']) {
  const at = readme.indexOf(`## ${biz}`);
  need(at >= 0, `README: no "## ${biz}" section`);
  if (at < 0) continue;
  const next = readme.indexOf('\n## ', at + 4);
  const body = readme.slice(at, next < 0 ? undefined : next);
  for (const [k, re] of Object.entries(sections)) if (want === 'all' || want === k) need(re.test(body), `README ${biz}: no "${re.source}"`);
  if (want === 'all' || want === 'cost') need(/\$\d/.test(body), `README ${biz}: no dollar figure`);
}

if (fails.length) { console.error('FAIL\n' + fails.join('\n')); process.exit(1); }
console.log(`OK (${want}): etsy ${etsyPdfs.length} PDFs/${etsyImgs.length} images, store ${storePrints.length} print files, mailer ${mailerArt.length} art files`);

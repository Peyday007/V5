/**
 * Renders a decklist as a screenshot (the way a phone screenshot of a deck app looks), sends it to
 * /api/recognize and prints what was read. Needs the server running; does not need Forge.
 *
 *   npx tsx scripts/recognize-demo.ts
 */
import { chromium } from 'playwright-core';

const BASE = process.env.TUTOR_URL ?? 'http://127.0.0.1:8790';
const lines = ["1 Caesar, Legion's Emperor", '1 Mr. House, President and CEO', '1 Sol Ring', '1 Arcane Signet', '1 Lightnig Bolt', '5 Plains', '4 Swamp'];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 420, height: 360 }, deviceScaleFactor: 2 });
await page.setContent(`<body style="font:18px -apple-system,Helvetica,sans-serif;background:#fff;padding:16px">${lines.map((l) => `<div style="padding:6px 0;border-bottom:1px solid #ddd">${l}</div>`).join('')}</body>`);
const png = await page.screenshot();
await browser.close();

const res = await fetch(`${BASE}/api/recognize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: `data:image/png;base64,${png.toString('base64')}`, kind: 'decklist' }) });
const out = await res.json() as any;
for (const l of out.lines) console.log(`${l.status.padEnd(10)} ${String(l.quantity).padStart(2)}  ${l.name}${l.candidates?.length ? `   (candidates: ${l.candidates.join(', ')})` : ''}   <- "${l.text}"`);
console.log(out.note);

// `node scripts/fast-cash-watch.mjs`: read-only status of every Fast Cash lead
// an offer is prepared for, from each channel's own public reading.
//
// It reads fast-cash/watch.json and prints one line per lead plus a digest of
// the facts that matter (open or not), so a scheduled check-in can tell a
// changed situation from an unchanged one and alert only on the first. It
// writes nothing, contacts nobody and needs no credential: a Gumroad product
// page is public.
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const watch = JSON.parse(fs.readFileSync(new URL('../fast-cash/watch.json', import.meta.url), 'utf8'));
const facts = [];

for (const product of watch.gumroad ?? []) {
  try {
    const response = await fetch(product.url, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
    facts.push(`${product.url}:${response.status}`);
    console.log(`GUMROAD ${product.url} HTTP ${response.status}`);
  } catch (error) {
    facts.push(`${product.url}:UNKNOWN`);
    console.log(`GUMROAD ${product.url} UNKNOWN ${error.message}`);
  }
}

const digest = createHash('sha256').update(facts.sort().join('\n')).digest('hex').slice(0, 16);
console.log(`FAST-CASH-WATCH: OK leads=${facts.length} digest=${digest}`);

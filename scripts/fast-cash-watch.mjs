// `node scripts/fast-cash-watch.mjs`: read-only status of every Fast Cash lead
// an offer is prepared for, from each marketplace's own public reading.
//
// It reads fast-cash/watch.json and prints one line per lead plus a digest of
// the facts that matter (open or not), so a scheduled check-in can tell a
// changed situation from an unchanged one and alert only on the first. It
// writes nothing, contacts nobody and needs no credential: Freelancer's
// projects API and a Gumroad product page are both public.
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const watch = JSON.parse(fs.readFileSync(new URL('../fast-cash/watch.json', import.meta.url), 'utf8'));
const facts = [];

for (const lead of watch.freelancer ?? []) {
  const url = `https://www.freelancer.com/api/projects/0.1/projects/${lead.projectId}/`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const body = await response.json();
    const p = body.result;
    const open = p.status === 'active' && p.frontend_project_status === 'open';
    facts.push(`${lead.opportunityId}:${open ? 'OPEN' : `${p.status}/${p.frontend_project_status}`}`);
    console.log(
      `FREELANCER ${lead.projectId} ${open ? 'OPEN' : 'NOT-OPEN'} status=${p.status}/${p.frontend_project_status} ` +
        `bids=${p.bid_stats?.bid_count} avg=${Math.round(p.bid_stats?.bid_avg ?? 0)} ${p.currency?.code} ` +
        `budget=${p.budget?.minimum}-${p.budget?.maximum} "${p.title}" opp=${lead.opportunityId}`,
    );
  } catch (error) {
    // Unknown is not closed: an unreadable answer is reported and changes no fact.
    facts.push(`${lead.opportunityId}:UNKNOWN`);
    console.log(`FREELANCER ${lead.projectId} UNKNOWN could not be read: ${error.message}`);
  }
}

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

/**
 * The sales desk (§107) from a terminal on the deployed machine.
 *
 *   node --import tsx scripts/sales-desk.ts [--replies N]
 *       One pass: every new reply on every business's campaigns analysed and
 *       acted on, learning, deliverability and knowledge when due.
 *       Prints `SALES-DESK: OK` or `SALES-DESK: ATTENTION`.
 *   node --import tsx scripts/sales-desk.ts --prove [--sites N] [--replies N]
 *       Sellbird's capabilities on real data without acting on anyone:
 *       research, fit and a written first email for N businesses the Neighbor
 *       Card would contact (nothing added), and its reading of the replies on
 *       the owner's finished campaigns (nothing sent, nothing recorded).
 *       Prints `SALES-PROVE: OK` when research, writing and reply analysis
 *       each answered on real input.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { maskEmail } from '../server/services/agents/client.ts';
import { sellbirdReply, sellbirdResearch, sellbirdWrite } from '../server/services/agents/sellbird.ts';
import { OSM_TILES, defaultDeps, discoverOsm, findPublishedEmail, instantly, itemsOf } from '../server/services/cash/neighborCard.ts';
import { SALES_BUSINESSES } from '../server/services/sales/businesses.ts';
import { automatedNotOptOut, promisesDeliverable, runSalesDesk, ungroundedFigures } from '../server/services/sales/desk.ts';

const argv = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};
process.env.BRAIN_DATABASE_POOL_SIZE ??= '1';
await initDatabase();
const deps = defaultDeps();
deps.log = () => undefined;

if (!argv.includes('--prove')) {
  const result = await runSalesDesk(deps, { replies: flag('--replies', 25) });
  for (const line of result.lines) console.log(`  ${line}`);
  await closeDatabase();
  console.log(result.ok ? 'SALES-DESK: OK' : 'SALES-DESK: ATTENTION');
  process.exit(0);
}

const card = SALES_BUSINESSES.find((b) => b.id === 'neighbor-card')!;
let researched = 0;
let written = 0;
const want = flag('--sites', 2);
// A proof runs over one SSH session inside a 75-minute job: each stage gets a
// share of the clock and stops at it, so one slow site or model call can never
// cost the whole proof its output.
const started = Date.now();
const until = (minutes: number) => Date.now() - started < minutes * 60_000;
for (let t = 0; t < OSM_TILES.length && written < want && until(30); t += 1) {
  for (const c of await discoverOsm(deps, OSM_TILES[(t * 7) % OSM_TILES.length]!)) {
    if (written >= want || !until(30)) break;
    const hit = await findPublishedEmail(deps, c.website);
    if (!hit) continue;
    const r = await sellbirdResearch(c.website, card.offer, { industry: c.category, source: 'sales prove' });
    if (!r || r.error) continue;
    researched += 1;
    console.log(`RESEARCH ${c.name} (${r.domain}): ${r.pagesRead} page(s); fit ${r.fit?.score ?? '-'} (${r.fit?.reasons.join('; ') ?? ''}); tools ${r.techStack.join(', ') || 'none'}; ${r.observations.length} signal(s); facts: ${r.facts.slice(1).join(' | ') || 'none'}`);
    const draft = await sellbirdWrite(card.offer, {
      email: hit.email, company: c.name, website: c.website, industry: c.category, location: `${c.town}, PA`,
      description: r.description, techStack: r.techStack, observations: r.observations, published: true,
    }, { source: 'sales prove' });
    if (draft?.ok) {
      written += 1;
      const loose = ungroundedFigures(`${draft.subject} ${draft.body}`, [card.offer.knowledge ?? '', card.offer.product.description, card.offer.product.pricing ?? '', ...r.facts, r.description]);
      console.log(`WRITE for ${maskEmail(hit.email)}: "${draft.subject}"\n  ${draft.body!.replace(/\n+/g, '\n  ')}\n  ${loose.length ? `HELD: quotes ${loose.join(', ')}` : 'every figure is in the facts'}`);
    } else console.log(`WRITE for ${maskEmail(hit.email)}: none (${draft?.reason ?? 'no answer'})`);
  }
}

// The owner's finished campaigns: real replies, read only.
let analysed = 0;
const finished = itemsOf(await instantly(deps, 'GET', '/campaigns?limit=100')).filter((c) => Number(c.status) === 3);
for (const c of finished) {
  const replies = itemsOf(await instantly(deps, 'GET', `/emails?campaign_id=${String(c.id)}&email_type=received&limit=100`)).slice(0, flag('--replies', 3));
  for (const m of replies) {
    if (!until(55)) break;
    const body = (m.body ?? {}) as { text?: string; html?: string };
    const text = body.text?.trim() || String(m.content_preview ?? '');
    const lead = String(m.lead ?? m.from_address_email ?? '').toLowerCase();
    if (!text || !lead.includes('@')) continue;
    const d = await sellbirdReply({ ...card.offer, brand: String(c.name), product: { name: String(c.name), description: 'the owner\'s earlier offer in this campaign' } },
      { email: lead, company: lead.split('@')[1] ?? '' }, { id: String(m.id), text }, [], { source: 'sales prove' });
    if (!d || d.error) continue;
    analysed += 1;
    console.log(`REPLY ${String(c.name)} ${maskEmail(lead)}: "${text.split('\n')[0]!.slice(0, 90)}" -> ${d.intent}, stage ${d.stage}${d.intent === 'unsubscribe' ? (automatedNotOptOut(text, d.optOut?.rule) ? ', read as an opt-out by the model alone on automated wording: desk keeps it off the block list' : `, opt-out by ${d.optOut?.rule ?? 'model'}: desk block-lists it`) : ''}${d.escalations.length ? ', to a person' : ''}${d.answer ? `; would answer${promisesDeliverable(d.answer) ? ' (held: promises a deliverable)' : ''}: "${d.answer.slice(0, 160).replace(/\n+/g, ' ')}"` : ''}`);
  }
}
await closeDatabase();
const ok = researched > 0 && written > 0 && analysed > 0;
console.log(`SALES-PROVE: ${ok ? 'OK' : 'ATTENTION'} (researched ${researched}, wrote ${written}, analysed ${analysed} real replies)`);
process.exit(ok ? 0 : 1);

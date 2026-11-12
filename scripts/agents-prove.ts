/**
 * One real workflow through each open-source agent (§104), from the deployed
 * Brain over the private network, recorded as Brain's own rows.
 *
 *   node --import tsx scripts/agents-prove.ts [--tile N] [--sellbird N]
 *   node --import tsx scripts/agents-prove.ts --probe   (the health probe only)
 *
 * 1. Discovers real West Shore businesses the way the Neighbor Card does
 *    (OpenStreetMap tile N), skips any whose site the plain reader already
 *    answers, and asks Sellbird about up to N of the rest: who decides and
 *    which address the business publishes.
 * 2. Gives Browser Use one of those sites (a one-page or challenged one when
 *    there is one) with the RunPod model, read-only, and reports whether the
 *    address it claims is on the page it cites.
 *
 * It sends nothing and adds no lead: the hourly Neighbor Card pass is the one
 * that loads what the agents find into the campaign, under the same rules as
 * every other address. Prints `AGENTS-PROVE: OK` when both agents answered
 * over the deployed path, and each finding with its source.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { agentsConfig, probeAgents, browserContact, browserModel, maskEmail, pickBrowser, pickSellbird, sellbirdContacts, type SellbirdContacts } from '../server/services/agents/client.ts';
import { OSM_TILES, defaultDeps, discoverOsm, findPublishedEmail } from '../server/services/cash/neighborCard.ts';

const argv = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};

process.env.BRAIN_DATABASE_POOL_SIZE ??= '1';

if (!agentsConfig()) {
  console.log('BRAIN_AGENTS_URL / BRAIN_AGENTS_KEY are not set on this machine: run the Agents workflow with "deploy".');
  console.log('AGENTS-PROVE: NOT CONNECTED');
  process.exit(1);
}
if (argv.includes('--probe')) {
  const probe = await probeAgents();
  console.log(`PROBE ${probe.ok === true ? 'CONNECTED' : probe.ok === null ? 'UNREACHABLE' : 'REPAIRING'}: ${probe.detail}`);
  process.exit(probe.ok === true ? 0 : 1);
}
await initDatabase();
const deps = defaultDeps();
deps.log = () => undefined;
const source = 'agents-prove';
const wantSellbird = flag('--sellbird', 6);

let sellbirdAnswered = 0;
let browserAnswered = false;
const misses: { website: string; name: string; read: SellbirdContacts | null }[] = [];
for (let offset = 0; offset < 4 && misses.length < wantSellbird; offset += 1) {
  const tile = OSM_TILES[(flag('--tile', 0) + offset) % OSM_TILES.length]!;
  const found = await discoverOsm(deps, tile);
  console.log(`tile ${tile}: ${found.length} businesses with a website on the map`);
  for (const c of found) {
    if (misses.length >= wantSellbird) break;
    if (await findPublishedEmail(deps, c.website)) continue;
    misses.push({ website: c.website, name: c.name, read: null });
  }
}
console.log(`${misses.length} site(s) where the plain reader found no published address`);

for (const m of misses) {
  m.read = await sellbirdContacts(m.website, { source });
  if (!m.read) { console.log(`SELLBIRD ${m.name} (${m.website}): no answer`); continue; }
  sellbirdAnswered += 1;
  const pick = pickSellbird(m.read);
  const people = m.read.people.map((p) => `${p.firstName} ${p.lastName} (${p.title || 'named'}${p.email ? `, ${maskEmail(p.email)} ${p.published ? 'published' : p.status}` : ''})`).join('; ') || 'nobody named';
  console.log(`SELLBIRD ${m.name} (${m.read.domain}): ${m.read.pagesRead} page(s); ${people}; inbox ${m.read.inbox ? maskEmail(m.read.inbox.email) : 'none'} → ${pick ? `TAKES ${maskEmail(pick.email)}${pick.firstName ? ` for ${pick.firstName}` : ''} from ${pick.sourceUrl}` : 'nothing Brain may send to'}`);
}

const llm = browserModel();
if (!llm) {
  console.log('BROWSER no model: neither the RunPod GPU nor a named cheap-lane model is configured on this machine');
} else {
  const target = misses.find((m) => m.read && (m.read.challenged || m.read.pagesRead <= 1) && m.read.reachable)
    ?? misses.find((m) => m.read && !pickSellbird(m.read) && m.read.reachable)
    ?? misses.find((m) => m.read?.reachable)
    ?? misses[0];
  if (target) {
    const out = await browserContact(target.website, { source, maxSteps: 8 });
    if (out) {
      browserAnswered = out.status !== 'ERROR' && out.status !== 'TIMEOUT';
      const pick = pickBrowser(out);
      console.log(`BROWSER ${target.name} (${out.domain}) on ${llm.model}: ${out.status} in ${out.steps} step(s), ${out.seconds}s${out.email ? `; claimed ${maskEmail(out.email)} on ${out.sourceUrl ?? '?'}` : ''}${pick ? ' → verified on the page' : ''}${out.error ? `; ${out.error}` : ''}`);
    } else {
      console.log(`BROWSER ${target.name}: no answer from the agents service`);
    }
  }
}

await closeDatabase();
const ok = sellbirdAnswered > 0 && browserAnswered;
console.log(`AGENTS-PROVE: ${ok ? 'OK' : 'ATTENTION'} (Sellbird answered ${sellbirdAnswered}/${misses.length}; Browser Use ${browserAnswered ? 'completed a task' : 'did not complete a task'})`);
process.exit(ok ? 0 : 1);

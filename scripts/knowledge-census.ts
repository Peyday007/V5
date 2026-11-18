/** Throwaway read-only probe (claude/ga-probe): the Oppizi postcard claim's arrangement, round and facts. */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { arrangementForLegacyKey } from '../server/repos/monetization.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { claimsByIds } from '../server/repos/research.ts';
import { listProjectFacts } from '../server/repos/construction.ts';
import { getDb } from '../server/db/database.ts';
const P = 'prj_22fb4fec295f403a8a22';
async function main() {
  await initDatabase();
  try {
    const a = await arrangementForLegacyKey(P, '2821cce3c372');
    console.log('ARR', JSON.stringify(a));
    const rounds = (await listRounds(P)).filter((r) => r.bucketId.endsWith('mx-2821cce3c372'));
    for (const r of rounds) {
      console.log('ROUND', JSON.stringify(r));
      const c = await getCandidate(r.candidateId);
      console.log('QUESTION', c?.title, '||', c?.statement);
    }
    const [claim] = await claimsByIds(['clm_9cf1f15cc99846198399']);
    console.log('CLAIM', JSON.stringify(claim));
    const ids = ['clm_9cf1f15cc99846198399','clm_26c1d49cfec840f697fc','clm_ba4513db8d0f49e195ce','clm_d534af431d4f4f28adfa'];
    for (const c of await claimsByIds(ids)) {
      for (const r of c.requirementIds ?? []) {
        const row = await getDb().get<{ statement: string; requirement_key: string }>('SELECT statement, requirement_key FROM requirements WHERE id = ?', [r]);
        console.log('REQ', c.id, r, row?.requirement_key, '::', row?.statement);
      }
    }
    const other = await getDb().all<{ id: string; claim: string }>("SELECT c.id, c.claim FROM research_claims c WHERE c.orchestration_id = ? AND c.accepted = 1", [claim!.orchestrationId]);
    for (const o of other) console.log('SIBLING', o.id, '::', o.claim);
    const facts = (await listProjectFacts(P)).filter((f) => f.sourceClaimId === 'clm_9cf1f15cc99846198399' || /ostcard|EDDM|direct.mail/i.test(f.measures ?? ''));
    console.log('FACTS', JSON.stringify(facts));
  } finally {
    await closeDatabase();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

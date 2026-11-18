/** Throwaway read-only probe (claude/ga-probe): the Oppizi postcard claim's arrangement, round and facts. */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { arrangementForLegacyKey } from '../server/repos/monetization.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { claimsByIds } from '../server/repos/research.ts';
import { listProjectFacts } from '../server/repos/construction.ts';
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
    const facts = (await listProjectFacts(P)).filter((f) => f.sourceClaimId === 'clm_9cf1f15cc99846198399' || /ostcard|EDDM|direct.mail/i.test(f.measures ?? ''));
    console.log('FACTS', JSON.stringify(facts));
  } finally {
    await closeDatabase();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

// Read-only: what the Fast Cash goal has done, and what the continuation pass
// would decide about it now. Run on the machine by fast-cash-goal.yml (explain),
// as `node --import tsx` from /app. It writes nothing — `inventoryProject` is
// the pass's own first step and is idempotent, and the verdict writes nothing.
import { closeDatabase, getDb, initDatabase } from '/app/server/db/database.ts';
import { inventoryProject } from '/app/server/services/reconcile/plan.ts';
import { coverBeforeWork } from '/app/server/services/russell/coverage.ts';

await initDatabase();
const db = getDb();
const goal = await db.get(
  `SELECT id, project_id, name, state, research_layer_id, research_assignment, research_considered_at,
          research_archive_marker, created_at, expires_at
     FROM russell_goals WHERE name = 'Fast Cash: actionable deals' ORDER BY created_at DESC LIMIT 1`,
);
if (!goal) {
  console.log('No Fast Cash goal.');
} else {
  console.log(`goal ${goal.id} ${goal.state} created ${goal.created_at} considered ${goal.research_considered_at ?? 'never'} archive-marker ${goal.research_archive_marker ? 'set' : 'none'} layer ${goal.research_layer_id}`);
  const packets = await db.all(
    'SELECT id, goal_packet_key, status, created_at FROM research_orchestrations WHERE goal_id = ? ORDER BY created_at, id',
    [goal.id],
  );
  for (const p of packets) {
    console.log(`  packet ${p.goal_packet_key} ${p.id} ${p.status} ${p.created_at}`);
    const frags = await db.all('SELECT fragment_key AS key, status, attempt FROM research_fragments WHERE orchestration_id = ? ORDER BY fragment_index', [p.id]);
    for (const f of frags) console.log(`    fragment ${f.key} ${f.status} attempt ${f.attempt}`);
    const bins = await db.all('SELECT id, state, attempt_count, max_attempts FROM bins WHERE orchestration_id = ? ORDER BY created_at', [p.id]);
    for (const b of bins) console.log(`    bin ${b.id} ${b.state} ${b.attempt_count}/${b.max_attempts}`);
    const items = await db.all('SELECT id, work_type, state, attempt_count, worker_id, updated_at FROM work_items WHERE payload LIKE ? ORDER BY created_at', [`%${p.id}%`]).catch(() => []);
    for (const i of items) console.log(`    item ${i.id} ${i.work_type} ${i.state} att=${i.attempt_count} worker=${i.worker_id ?? '-'} ${i.updated_at}`);
  }
  const inventory = await inventoryProject(goal.project_id);
  console.log(`  archive: documentsPending=${inventory.documentsPending} claims=${inventory.claims.length}`);
  const verdict = await coverBeforeWork({
    projectId: goal.project_id,
    layerId: goal.research_layer_id,
    claims: inventory.claims,
    requirements: [{ key: 'goal-assignment', statement: goal.research_assignment, necessity: 'MANDATORY' }],
  });
  console.log(`  coverage fullyAnswered=${verdict.fullyAnswered} status=${verdict.verdicts[0]?.status}`);
  const opps = await db.all(
    `SELECT o.id, o.state, o.opportunity_signal, o.title, o.source, o.expires_at, o.created_at, o.orchestration_id
       FROM cash_opportunities o JOIN research_orchestrations r ON r.id = o.orchestration_id
      WHERE r.goal_id = ? ORDER BY o.created_at`,
    [goal.id],
  );
  console.log(`  opportunities from this goal: ${opps.length}`);
  for (const o of opps) {
    console.log(`    ${o.id} ${o.state} ${o.opportunity_signal} closes=${o.expires_at ?? '-'} ${o.created_at} :: ${String(o.title).slice(0, 140)} <- ${o.source}`);
  }
  // Every opening filed in this project in the last 24 hours, by whichever
  // packet filed it, so continuation can be read from rows.
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const recent = await db.all(
    `SELECT o.id, o.state, o.opportunity_signal, o.title, o.created_at, o.orchestration_id, o.duplicate_of_id,
            c.source_url, w.id AS worker_id
       FROM cash_opportunities o
       LEFT JOIN research_claims c ON c.id = o.source_claim_id
       LEFT JOIN research_passes p ON p.id = c.pass_id
       LEFT JOIN workers w ON w.id = p.executor_worker_id
      WHERE o.project_id = ? AND o.created_at >= ? ORDER BY o.created_at`,
    [goal.project_id, since],
  ).catch((error) => { console.log(`  recent read failed: ${error.message}`); return []; });
  console.log(`  opportunities filed in the last 24h: ${recent.length}`);
  for (const o of recent) {
    console.log(`    ${o.created_at} ${o.id} ${o.opportunity_signal}${o.duplicate_of_id ? ' dup' : ''} orc=${o.orchestration_id} worker=${o.worker_id ?? '-'} :: ${String(o.title).slice(0, 110)} <- ${o.source_url ?? '-'}`);
  }
}
await closeDatabase();
console.log('ADMIN: OK');

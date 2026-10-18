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
    const orc = await db.get('SELECT failure_reason FROM research_orchestrations WHERE id = ?', [p.id]).catch(() => null);
    if (orc?.failure_reason) console.log(`    reason: ${String(orc.failure_reason).slice(0, 400)}`);
    const frags = await db.all('SELECT id, fragment_key AS key, status, attempt, max_repairs, blocked_reason FROM research_fragments WHERE orchestration_id = ? ORDER BY fragment_index', [p.id]);
    for (const f of frags) console.log(`    fragment ${f.key} ${f.id} ${f.status} attempt ${f.attempt}/${Number(f.max_repairs) + 1} :: ${String(f.blocked_reason ?? '').slice(0, 260)}`);
    const asks = await db.all(
      `SELECT id, state, authority_needed, choices, resume_key, created_at FROM russell_human_requests
        WHERE project_id = ? AND (resume_key LIKE ? OR resume_key LIKE ? OR why_not_russell LIKE ?) ORDER BY created_at`,
      [goal.project_id, `%${p.id}%`, `%${goal.id}%`, `%${p.id}%`],
    ).catch(() => []);
    for (const a of asks) console.log(`    ask ${a.id} ${a.state} ${a.created_at} key=${a.resume_key} :: ${String(a.authority_needed).slice(0, 200)} choices=${String(a.choices).slice(0, 300)}`);
    const bins = await db.all('SELECT id, state, attempt_count, max_attempts FROM bins WHERE orchestration_id = ? ORDER BY created_at', [p.id]);
    for (const b of bins) console.log(`    bin ${b.id} ${b.state} ${b.attempt_count}/${b.max_attempts}`);
    const items = await db.all('SELECT id, work_type, state, attempt_count, max_attempts, worker_id, lease_expires_at, created_at FROM work_items WHERE payload LIKE ? ORDER BY created_at', [`%${p.id}%`]).catch((error) => { console.log(`    item read failed: ${error.message}`); return []; });
    for (const i of items.slice(-12)) console.log(`    item ${i.id} ${i.work_type} ${i.state} att=${i.attempt_count}/${i.max_attempts} worker=${i.worker_id ?? '-'} lease=${i.lease_expires_at ?? '-'} created=${i.created_at}`);
    for (const e of await db.all(`SELECT at, event_type, worker_id, routine_id, outcome, reason FROM bin_events WHERE orchestration_id = ? ORDER BY at DESC LIMIT 12`, [p.id]).catch(() => [])) console.log(`    event ${e.at} ${e.event_type} ${e.outcome ?? ''} worker=${e.worker_id ?? '-'} routine=${e.routine_id ?? '-'} ${String(e.reason ?? '').slice(0, 140)}`);
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
  // Any claim beside a goal opening that states an estimate (melt, spot,
  // ceiling) rather than what the source published, since the page shows them.
  const estimateRows = await db.all(
    `SELECT c.id, c.accepted, c.evidence_lane, c.claim FROM research_claims c
      WHERE c.fragment_id IN (SELECT fragment_id FROM cash_opportunities o JOIN research_orchestrations r ON r.id = o.orchestration_id WHERE r.goal_id = ?)
        AND (LOWER(c.claim) LIKE '%melt%' OR LOWER(c.claim) LIKE '%spot%' OR LOWER(c.claim) LIKE '%ceiling%' OR LOWER(c.claim) LIKE '%estimat%')`,
    [goal.id],
  ).catch((error) => { console.log(`  estimate read failed: ${error.message}`); return []; });
  console.log(`  claims beside goal openings that mention melt/spot/ceiling/estimate: ${estimateRows.length}`);
  for (const r of estimateRows) console.log(`    ${r.id} accepted=${r.accepted} lane=${r.evidence_lane} :: ${String(r.claim).slice(0, 220)}`);
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
  // Where each recent non-duplicate opening came from: which question asked
  // it, who asked that question, and which surface ran the pass. Read-only.
  console.log('  lineage of non-duplicate openings filed in the last 48h:');
  const lineageRows = await db.all(
    `SELECT o.id, o.created_at, o.orchestration_id, o.title, c.id AS claim_id, p.executor_routine_id, p.executor_session_ref, r.name AS routine_name
       FROM cash_opportunities o
       LEFT JOIN research_claims c ON c.id = o.source_claim_id
       LEFT JOIN research_passes p ON p.id = c.pass_id
       LEFT JOIN fleet_routines r ON r.id = p.executor_routine_id
      WHERE o.project_id = ? AND o.created_at >= ? AND o.duplicate_of_id IS NULL ORDER BY o.created_at`,
    [goal.project_id, new Date(Date.now() - 48 * 3600_000).toISOString()],
  ).catch((error) => { console.log(`  lineage read failed: ${error.message}`); return []; });
  const origins = [
    ['cash_discovery_rounds', 'candidate_id'], ['monetization_commissions', 'candidate_id'], ['industry_rounds', 'candidate_id'],
    ['labor_rounds', 'candidate_id'], ['manufacturing_rounds', 'candidate_id'], ['deal_rounds', 'candidate_id'], ['puzzle_rounds', 'candidate_id'],
  ];
  for (const o of lineageRows) {
    const orc = await db.get('SELECT id, goal_id, goal_packet_key, status, created_at FROM research_orchestrations WHERE id = ?', [o.orchestration_id]).catch(() => null);
    const mission = await db.get('SELECT id, state, candidate_id, created_at FROM russell_missions WHERE orchestration_id = ?', [o.orchestration_id]).catch(() => null);
    const cand = mission?.candidate_id
      ? await db.get('SELECT id, title, state, conversation_id, follow_on_of_mission_id, created_at FROM russell_candidates WHERE id = ?', [mission.candidate_id]).catch(() => null)
      : null;
    const found = [];
    if (cand) {
      for (const [table, column] of origins) {
        const row = await db.get(`SELECT * FROM ${table} WHERE ${column} = ?`, [cand.id]).catch(() => null);
        if (row) found.push(`${table}:${row.id} created=${row.created_at ?? '-'} purpose=${row.purpose ?? row.attribute ?? row.bucket_key ?? row.bucket ?? '-'} round=${row.round ?? '-'}`);
      }
    }
    const validation = await db.get('SELECT id FROM cash_opportunities WHERE validation_orchestration_id = ?', [o.orchestration_id]).catch(() => null);
    console.log(`    ${o.created_at} ${o.id} claim=${o.claim_id ?? '-'} routine=${o.routine_name ?? o.executor_routine_id ?? '-'} session=${String(o.executor_session_ref ?? '-').slice(0, 18)}`);
    console.log(`      orc ${orc?.id ?? o.orchestration_id} created=${orc?.created_at ?? '?'} goal=${orc?.goal_id ?? '-'} status=${orc?.status ?? '?'} mission=${mission?.id ?? '-'} candidate=${cand?.id ?? '-'} cand-created=${cand?.created_at ?? '-'} conversation=${cand?.conversation_id ?? '-'} follow-on-of=${cand?.follow_on_of_mission_id ?? '-'} validation-of=${validation?.id ?? '-'}`);
    console.log(`      asked: ${String(cand?.title ?? '-').slice(0, 160)} | origin: ${found.join('; ') || 'none of the round tables'}`);
    console.log(`      title: ${String(o.title).slice(0, 200)}`);
  }
  // Who abandons work: identity, binding and how each lease ended, read-only.
  const since48 = new Date(Date.now() - 48 * 3600_000).toISOString();
  const who = (sql, params) => db.all(sql, params).catch((error) => { console.log(`  read failed: ${error.message}`); return []; });
  const byWorker = await who(
    `SELECT l.worker_id, l.outcome, COUNT(*) AS n, AVG(l.heartbeat_count) AS hb
       FROM work_leases l WHERE l.project_id = ? AND l.claimed_at >= ? GROUP BY l.worker_id, l.outcome ORDER BY l.worker_id`,
    [goal.project_id, since48],
  );
  console.log('  leases in this project, last 48h, by worker and outcome:');
  for (const r of byWorker) console.log(`    ${r.worker_id} ${r.outcome ?? 'OPEN'} n=${r.n} avg-heartbeats=${Number(r.hb).toFixed(1)}`);
  const ids = [...new Set(byWorker.map((r) => r.worker_id))];
  for (const id of ids) {
    const w = await db.get('SELECT id, name, display_name, worker_type, status, created_at FROM workers WHERE id = ?', [id]).catch(() => null);
    console.log(`  worker ${id} name=${w?.name ?? '?'} display=${w?.display_name ?? '?'} type=${w?.worker_type ?? '?'} status=${w?.status ?? '?'} created=${w?.created_at ?? '?'}`);
    const routing = await db.get('SELECT families, repositories, capabilities FROM worker_routing WHERE worker_id = ?', [id]).catch(() => null);
    console.log(`    routing ${routing ? `${routing.families} repos=${routing.repositories} caps=${routing.capabilities}` : 'none (scopes imply)'}`);
    for (const r of await who(
      `SELECT r.id, r.name, r.state, r.state_reason, r.routine_ref, a.name AS account FROM fleet_routines r
         LEFT JOIN fleet_accounts a ON a.id = r.account_id WHERE r.worker_id = ? ORDER BY r.name`, [id])) {
      console.log(`    routine ${r.name} ${r.state} account=${r.account} ref=${String(r.routine_ref).slice(0, 14)} reason=${String(r.state_reason ?? '-').slice(0, 120)}`);
    }
    for (const c of await who('SELECT id, account_id, resource, label FROM connectors WHERE worker_id = ?', [id])) {
      console.log(`    connector ${c.id} account=${c.account_id} resource=${c.resource} label=${c.label ?? '-'}`);
    }
    const sessions = await who(
      `SELECT s.routine_id, r.name, COUNT(*) AS n, MAX(s.observed_at) AS last FROM worker_sessions s
         LEFT JOIN fleet_routines r ON r.id = s.routine_id WHERE s.worker_id = ? AND s.observed_at >= ? GROUP BY s.routine_id, r.name`, [id, since48]);
    for (const s of sessions) console.log(`    sessions via ${s.name ?? s.routine_id} n=${s.n} last=${s.last}`);
  }
  const target = 'wkr_9826789954a34b338620';
  console.log(`  last 25 leases of ${target} (any project):`);
  for (const l of await who(
    `SELECT l.work_item_id, i.work_type, l.claimed_at, l.last_heartbeat_at, l.heartbeat_count, l.expires_at, l.ended_at, l.outcome, l.detail, l.credential_id
       FROM work_leases l LEFT JOIN work_items i ON i.id = l.work_item_id
      WHERE l.worker_id = ? ORDER BY l.claimed_at DESC LIMIT 25`, [target])) {
    console.log(`    ${l.claimed_at} ${l.work_item_id} ${l.work_type} hb=${l.heartbeat_count} lastHb=${l.last_heartbeat_at ?? '-'} ended=${l.ended_at ?? '-'} ${l.outcome ?? 'OPEN'} cred=${String(l.credential_id ?? '-').slice(0, 12)} ${String(l.detail ?? '').slice(0, 100)}`);
  }
  console.log(`  bin events of ${target}, last 48h, by type:`);
  for (const e of await who(
    `SELECT event_type, outcome, COUNT(*) AS n, MAX(at) AS last FROM bin_events WHERE worker_id = ? AND at >= ? GROUP BY event_type, outcome ORDER BY n DESC`, [target, since48])) {
    console.log(`    ${e.event_type} ${e.outcome ?? '-'} n=${e.n} last=${e.last}`);
  }
  console.log(`  last 20 bin events of ${target}:`);
  for (const e of await who(
    `SELECT at, event_type, bin_id, routine_id, session_ref, outcome, reason FROM bin_events WHERE worker_id = ? ORDER BY at DESC LIMIT 20`, [target])) {
    console.log(`    ${e.at} ${e.event_type} ${e.bin_id ?? '-'} routine=${e.routine_id ?? '-'} session=${String(e.session_ref ?? '-').slice(0, 16)} ${e.outcome ?? ''} ${String(e.reason ?? '').slice(0, 140)}`);
  }
}

// Discovery rounds of the last 24 hours, so a cycle after a change can be read
// as a cycle: the question, its mission, its packet, what it found, and how many
// of the openings it filed were duplicates.
{
  const since24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  console.log('discovery rounds opened in the last 24h:');
  const rounds = await db.all(
    `SELECT r.id, r.bucket_id, r.round, r.state, r.opened_at, r.harvested_at, r.found, r.candidate_id,
            c.state AS cand_state, m.id AS mission_id, m.state AS mission_state, m.orchestration_id
       FROM cash_discovery_rounds r
       LEFT JOIN russell_candidates c ON c.id = r.candidate_id
       LEFT JOIN russell_missions m ON m.candidate_id = r.candidate_id
      WHERE r.project_id = ? AND r.opened_at >= ?
      ORDER BY r.opened_at`, [goal.project_id, since24],
  ).catch((error) => { console.log(`  rounds read failed: ${error.message}`); return []; });
  for (const r of rounds) {
    let packet = '-';
    let claims = '-';
    let opps = '-';
    if (r.orchestration_id) {
      const o = await db.get(`SELECT status, created_at FROM research_orchestrations WHERE id = ?`, [r.orchestration_id]);
      packet = `${r.orchestration_id} ${o?.status ?? '?'}`;
      const c = await db.get(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) AS accepted,
                SUM(CASE WHEN accepted = 1 AND opportunity_signal IS NOT NULL THEN 1 ELSE 0 END) AS signalled
           FROM research_claims WHERE orchestration_id = ?`, [r.orchestration_id]);
      claims = `${c?.n ?? 0} claims, ${c?.accepted ?? 0} accepted, ${c?.signalled ?? 0} signalled`;
      const q = await db.get(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN state = 'DUPLICATE' OR duplicate_of_id IS NOT NULL THEN 1 ELSE 0 END) AS dup
           FROM cash_opportunities WHERE orchestration_id = ?`, [r.orchestration_id]).catch(() => null);
      opps = q ? `${q.n} openings (${q.dup ?? 0} dup)` : 'openings unreadable';
    }
    console.log(`  ${r.opened_at} ${r.id} ${r.bucket_id} r${r.round} ${r.state} found=${r.found} harvested=${r.harvested_at ?? '-'} cand=${r.cand_state ?? '-'} mission=${r.mission_id ?? '-'} ${r.mission_state ?? ''} packet=${packet} :: ${claims} :: ${opps}`);
  }
  // When each bucket may next be asked, by discovery.ts's own rule: no live
  // round, 24h after the last settled, and not after three barren rounds.
  console.log('discovery buckets: when each may next be asked (nextRoundFor):');
  const { nextRoundFor, ROUND_COOL_OFF_MS } = await import('/app/server/services/cash/discovery.ts');
  const { listRounds } = await import('/app/server/repos/cashDiscovery.ts');
  const all = await listRounds(goal.project_id).catch((error) => { console.log(`  read failed: ${error.message}`); return []; });
  const byBucket = new Map();
  for (const r of all) { const list = byBucket.get(r.bucketId) ?? []; list.push(r); byBucket.set(r.bucketId, list); }
  const nowIso = new Date().toISOString();
  for (const [bucket, history] of byBucket) {
    const ordered = [...history].sort((a, b) => a.round - b.round);
    const last = ordered[ordered.length - 1];
    const settled = last.harvestedAt ?? last.openedAt;
    const next = nextRoundFor(history, nowIso);
    const barren = ordered.slice(-3).length >= 3 && ordered.slice(-3).every((one) => one.state === 'HARVESTED' && one.found === 0);
    const eligibleAt = new Date(Date.parse(settled) + ROUND_COOL_OFF_MS).toISOString();
    const why = history.some((one) => one.state === 'OPEN') ? 'a round is live'
      : next !== null ? `eligible now (round ${next})`
      : barren ? 'stopped: last 3 finished rounds found nothing'
      : `cool-off until ${eligibleAt}`;
    console.log(`  ${bucket.padEnd(28)} last r${last.round} ${last.state} found=${ordered.map((o) => o.found).join(',')} settled=${settled} :: ${why}`);
  }
  // Mission slots: what a queued discovery idea is waiting on, from the grant
  // `launch()` resolves and the reservations it counts (spendTotals' own SQL).
  console.log('research mission slots:');
  const { checkAuthority } = await import('/app/server/services/russell/authority.ts');
  const auth = await checkAuthority({ projectId: goal.project_id, workClass: 'RESEARCH' }).catch((error) => ({ ok: false, reason: error.message }));
  if (!auth.ok || !auth.goal) {
    console.log(`  no research grant governs: ${auth.reason ?? JSON.stringify(auth).slice(0, 200)}`);
  } else {
    const nowR = new Date().toISOString();
    const held = await db.all(
      `SELECT r.idempotency_key, r.created_at, r.expires_at, m.id AS mission_id, m.state AS mission_state, m.orchestration_id
         FROM russell_budget_reservations r
         LEFT JOIN russell_missions m ON r.idempotency_key LIKE '%' || m.candidate_id || '%'
        WHERE r.goal_id = ? AND r.kind = 'MISSION' AND r.state = 'HELD' AND r.expires_at > ?
        ORDER BY r.created_at`, [auth.goal.id, nowR]);
    console.log(`  grant ${auth.goal.id} maxConcurrent=${auth.goal.maxConcurrent} held=${held.length}`);
    for (const h of held) {
      const o = h.orchestration_id ? await db.get('SELECT status FROM research_orchestrations WHERE id = ?', [h.orchestration_id]) : null;
      console.log(`    ${h.created_at} key=${String(h.idempotency_key).slice(0, 60)} mission=${h.mission_id ?? '-'} ${h.mission_state ?? ''} packet=${h.orchestration_id ?? '-'} ${o?.status ?? ''} expires=${h.expires_at}`);
    }
  }
  console.log('prepared decisions (Brain drafts, not sent):');
  const prepared = await db.all(
    `SELECT opportunity_id, version, id, observed_at, observed_status, created_at FROM cash_prepared_decisions
      WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`, [goal.project_id],
  ).catch((error) => { console.log(`  prepared read failed: ${error.message}`); return []; });
  for (const p of prepared) console.log(`  ${p.opportunity_id} v${p.version} ${p.id} observed=${p.observed_at} ${p.observed_status} recorded=${p.created_at}`);
}
await closeDatabase();
console.log('ADMIN: OK');

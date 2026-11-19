/**
 * PROBE (claude/probe-idle-dispatch, never merged): why the one executable
 * Factory bin and the one executable routine bin are not dispatched.
 * SELECT-only, plus the read-only readers the capacity tool itself calls.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';

function show(label: string, value: unknown): void {
  console.log(`== ${label}`);
  console.log(JSON.stringify(value, null, 0)?.slice(0, 12_000));
}

async function q(label: string, sql: string, params: unknown[] = []): Promise<unknown[]> {
  try {
    const rows = await getDb().all<Record<string, unknown>>(sql, params as never);
    show(`${label} (${rows.length})`, rows);
    return rows;
  } catch (error) {
    console.log(`== ${label} UNMEASURED: ${(error as Error).message}`);
    return [];
  }
}

async function main(): Promise<void> {
  await initDatabase();
  const now = new Date();
  const iso = now.toISOString();
  console.log(`NOW ${iso}`);

  try {
    const { DISPATCHABLE_SQL, FIREABLE_SQL, workReadySql } = await import('../server/repos/bins.ts');
    await q(
      'executable bins (watchdog predicate, before unrouted/pin filters)',
      `SELECT id, kind, state, project_id, workload_class, priority, factory_campaign_id, orchestration_id, completion_contract,
              attempt_count, max_attempts, dispatch_not_before, lease_expires_at, lease_generation, pinned_routine_id, ready_at, created_at, updated_at
         FROM bins WHERE ${DISPATCHABLE_SQL} AND ${FIREABLE_SQL} AND ${workReadySql('bins.')}`,
      [iso, iso, iso, iso],
    );
  } catch (error) {
    console.log(`executable bins failed: ${(error as Error).message}`);
  }

  const binRows = (await q(
    'READY/LEASED bins',
    `SELECT id, kind, state, project_id, workload_class, priority, factory_campaign_id, orchestration_id, completion_contract,
            attempt_count, max_attempts, dispatch_not_before, lease_expires_at, lease_generation, pinned_routine_id, ready_at, leased_at, updated_at
       FROM bins WHERE state IN ('READY','LEASED') ORDER BY updated_at DESC LIMIT 40`,
  )) as Array<{ id: string }>;

  for (const bin of binRows.slice(0, 12)) {
    await q(`dispatch rows for ${bin.id}`, `SELECT * FROM bin_dispatch WHERE bin_id = ? ORDER BY created_at DESC LIMIT 6`, [bin.id]);
    await q(
      `events for ${bin.id}`,
      `SELECT event_type, at, outcome, reason, routine_ref, lease_generation FROM bin_events WHERE bin_id = ? ORDER BY at DESC LIMIT 12`,
      [bin.id],
    );
  }

  await q('dispatch rows by state', `SELECT state, COUNT(*) AS n, MIN(next_attempt_at) AS min_next, MAX(updated_at) AS last_upd FROM bin_dispatch GROUP BY state`);
  await q('pending/sending intents', `SELECT * FROM bin_dispatch WHERE state IN ('PENDING','SENDING') ORDER BY next_attempt_at LIMIT 20`);
  await q('last sent dispatches', `SELECT id, bin_id, sent_at, routine_ref, session_ref FROM bin_dispatch WHERE sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 8`);
  await q(
    'recent dispatch-level events',
    `SELECT event_type, COUNT(*) AS n, MAX(at) AS last FROM bin_events WHERE at > ? GROUP BY event_type ORDER BY last DESC LIMIT 40`,
    [new Date(now.getTime() - 6 * 3600_000).toISOString()],
  );
  await q(
    'recent tick failures / boot',
    `SELECT event_type, at, outcome, reason FROM bin_events WHERE event_type IN ('DISPATCH_TICK_FAILED','DISPATCH_BOOT_RECOVERY') ORDER BY at DESC LIMIT 10`,
  );
  await q(
    'recent unrouted',
    `SELECT bin_id, at, outcome, reason FROM bin_events WHERE event_type = 'DISPATCH_UNROUTED' ORDER BY at DESC LIMIT 10`,
  );
  await q(
    'fleet routines',
    `SELECT r.id, r.name, r.state, r.state_reason, r.capabilities, r.account_id, a.state AS account_state, r.updated_at
       FROM fleet_routines r LEFT JOIN fleet_accounts a ON a.id = r.account_id ORDER BY r.name`,
  );
  await q('fleet accounts', `SELECT * FROM fleet_accounts`);
  await q('factory queue', `SELECT * FROM factory_queue_entries WHERE state = 'QUEUED'`);
  await q(
    'live campaigns',
    `SELECT id, state, blocker_kind, blocker_detail, change_request_id, updated_at FROM factory_campaigns WHERE state NOT IN ('COMPLETE','CANCELLED','FAILED','DONE') ORDER BY updated_at DESC LIMIT 15`,
  );
  await q(
    'interventions',
    `SELECT kind, attempted_action, replacement_action, created_at FROM engineering_interventions WHERE kind = 'IDLE_WITH_EXECUTABLE_WORK' ORDER BY created_at DESC LIMIT 10`,
  );
  await q('factory idle events', `SELECT kind, at, detail FROM factory_events WHERE kind LIKE '%IDLE%' ORDER BY at DESC LIMIT 6`);

  try {
    const { idleCounts } = await import('../server/services/engineering/watchdog.ts');
    show('idleCounts', await idleCounts(now));
  } catch (error) {
    console.log(`idleCounts failed: ${(error as Error).message}`);
  }
  try {
    const { readLine } = await import('../server/services/factory/line.ts');
    const line = await readLine(now);
    show('line.summary', {
      executable: line.executable,
      active: line.active,
      freeSurfaces: line.capacity.freeSurfaces,
      because: line.because,
      surfaces: line.capacity.surfaces,
      queue: line.queue.map((one) => ({ id: one.entry.id, why: one.why, executableNow: one.executableNow })),
      campaigns: line.campaigns.map((one) => ({ id: one.campaign.id, state: one.campaign.state, working: one.working, blocked: one.blocked, next: one.next, bins: one.bins })),
    });
  } catch (error) {
    console.log(`readLine failed: ${(error as Error).message}`);
  }
  try {
    const { fleetSnapshot } = await import('../server/services/dispatch/candidates.ts');
    const snap = await fleetSnapshot(now);
    show('snapshot', {
      fleetPolicy: snap.fleetPolicy,
      fleetInFlight: snap.fleetInFlight,
      factoryInFlight: snap.factoryInFlight,
      missingSecrets: snap.missingSecrets,
      candidates: snap.candidates.map((c) => ({
        routine: c.routine.name,
        id: c.routine.id,
        caps: c.routine.capabilities,
        state: c.routine.state,
        rIn: c.routineInFlight,
        rT: c.routineTarget,
        aIn: c.accountInFlight,
        aT: c.accountTarget,
        webBlocked: c.webBlocked,
      })),
    });
  } catch (error) {
    console.log(`snapshot failed: ${(error as Error).message}`);
  }
}

main()
  .then(() => console.log('GOALS: OK'))
  .catch((error) => console.log(`PROBE FAILED: ${(error as Error).stack}`))
  .finally(() => closeDatabase());

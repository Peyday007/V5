/**
 * `npm run report:connections` — the connection system's truth, in one read.
 *
 * Read-only by construction: it opens the database, prints what the rows say,
 * and closes it. It changes no connector, Routine, token or quarantine.
 *
 * Every number is a row or a process's own reading of itself:
 *
 *   PROCESSES      each running Brain's last liveness and the readings it wrote
 *                  beside it — both pools, the infrastructure failures it has
 *                  felt, control-plane latency (authenticate, oauth_token,
 *                  brain_whoami, brain_check_in) as p50/p95/max.
 *   INCIDENTS      `infra_incidents` in the window, by kind and surface, and
 *                  whether each was on the arrival path.
 *   AUTH           refusals the token endpoint and the MCP door recorded, by
 *                  category — the real auth failures, kept apart from the
 *                  infrastructure ones above.
 *   MISSES         unanswered fires by Routine: real no-shows, auth no-shows and
 *                  infrastructure-attributed misses, separately.
 *   CONNECTORS     every logical connector: account, endpoint, worker, current
 *                  client, health, last auth, last refresh, last check-in,
 *                  no-shows, infra misses, quarantine, and whether a person must
 *                  act — with the row-level reason when one must.
 *
 * No secret is read or printed: ids, categories and timestamps only.
 *
 *   npm run report:connections                 (last 24 hours)
 *   npm run report:connections -- --hours 6
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { describePoolerRefusal } from '../server/db/adapters/postgres.ts';
import { allConnectorHealth } from '../server/services/fleet/connectorHealth.ts';
import { listIncidentsSince } from '../server/services/infra/incidents.ts';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function safeJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  await initDatabase();
  const hours = Number(arg('hours') ?? '24');
  const since = new Date(Date.now() - (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000).toISOString();
  const db = getDb();
  console.log(`window: since ${since}`);

  console.log('\nPROCESSES');
  const procs = await db.all<{ instance_id: string; started_at: string; alive_at: string; readings: string | null }>(
    'SELECT instance_id, started_at, alive_at, readings FROM runtime_liveness ORDER BY alive_at DESC LIMIT 5',
  );
  if (procs.length === 0) console.log('  (no liveness recorded yet)');
  for (const proc of procs) {
    const r = safeJson(proc.readings);
    console.log(`  ${proc.instance_id}  started ${proc.started_at}  alive ${proc.alive_at}  revision ${String(r['revision'] ?? '?')}`);
    console.log(`    pools        ${JSON.stringify(r['pools'] ?? null)}`);
    console.log(`    infra felt   ${JSON.stringify(r['infraFailures'] ?? {})}`);
    const latency = (r['latency'] ?? {}) as Record<string, { count: number; p50: number; p95: number; max: number }>;
    for (const [op, l] of Object.entries(latency)) {
      console.log(`    latency      ${op.padEnd(16)} n=${l.count} p50=${l.p50}ms p95=${l.p95}ms max=${l.max}ms`);
    }
  }

  console.log('\nINCIDENTS (Brain infrastructure, never charged to a worker)');
  const incidents = await listIncidentsSince(since, 500);
  const byKind = new Map<string, { rows: number; occurrences: number; arrival: number }>();
  for (const incident of incidents) {
    const key = `${incident.kind} @ ${incident.surface}`;
    const agg = byKind.get(key) ?? { rows: 0, occurrences: 0, arrival: 0 };
    agg.rows += 1;
    agg.occurrences += incident.occurrences;
    if (incident.affectsArrival) agg.arrival += 1;
    byKind.set(key, agg);
  }
  if (byKind.size === 0) console.log('  none');
  for (const [key, agg] of [...byKind.entries()].sort()) {
    console.log(`  ${key}  rows=${agg.rows} occurrences=${agg.occurrences} on-arrival-path=${agg.arrival}`);
  }
  for (const incident of incidents.filter((i) => i.kind === 'PROCESS_RESTART' || i.kind === 'UNSERVED_ARRIVAL').slice(0, 20)) {
    console.log(`    ${incident.id} ${incident.kind} ${incident.startedAt} → ${incident.endedAt} ${incident.sessionRef ?? ''} ${incident.detail ?? ''}`);
  }

  console.log('\nAUTH (actual credential refusals, by category)');
  const denials = await db.all<{ action: string; reason: string | null; n: number }>(
    `SELECT action, reason, COUNT(*) AS n FROM identity_events
      WHERE result = 'DENIED' AND action IN ('OAUTH_TOKEN', 'MCP_AUTHENTICATE') AND created_at >= ?
      GROUP BY action, reason ORDER BY action, reason`,
    [since],
  );
  const tokenDenials = await db.all<{ metadata: string | null }>(
    `SELECT metadata FROM identity_events
      WHERE result = 'DENIED' AND action = 'OAUTH_TOKEN' AND created_at >= ?`,
    [since],
  );
  const byRefusal = new Map<string, number>();
  for (const row of tokenDenials) {
    const reason = String(safeJson(row.metadata)['reason'] ?? 'UNKNOWN');
    byRefusal.set(reason, (byRefusal.get(reason) ?? 0) + 1);
  }
  if (denials.length === 0) console.log('  none');
  for (const d of denials) console.log(`  ${d.action} ${d.reason ?? ''} ${Number(d.n)}`);
  for (const [reason, n] of byRefusal) console.log(`    OAUTH_TOKEN refusal ${reason}: ${n}`);
  const infraCalls = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM identity_events
      WHERE action = 'MCP_TOOL_CALL' AND result = 'FAILED' AND created_at >= ? AND metadata LIKE '%INFRA_RETRYABLE%'`,
    [since],
  );
  console.log(`  MCP tool calls answered INFRA_RETRYABLE (not auth): ${Number(infraCalls?.n ?? 0)}`);

  console.log('\nMISSES (unanswered fires, by cause)');
  const misses = await db.all<{ routine_id: string | null; event_type: string; n: number }>(
    `SELECT routine_id, event_type, COUNT(*) AS n FROM bin_events
      WHERE event_type IN ('DISPATCH_NO_SHOW', 'DISPATCH_AUTH_NO_SHOW', 'DISPATCH_INFRA_NO_SHOW') AND at >= ?
      GROUP BY routine_id, event_type`,
    [since],
  );
  const missByRoutine = new Map<string, Record<string, number>>();
  for (const m of misses) {
    const entry = missByRoutine.get(m.routine_id ?? '?') ?? {};
    entry[m.event_type] = Number(m.n);
    missByRoutine.set(m.routine_id ?? '?', entry);
  }
  if (missByRoutine.size === 0) console.log('  none');

  const routines = await db.all<{
    id: string;
    name: string;
    routine_ref: string;
    state: string;
    state_reason: string | null;
    connector_id: string | null;
    worker_id: string | null;
    last_check_in_at: string | null;
  }>('SELECT id, name, routine_ref, state, state_reason, connector_id, worker_id, last_check_in_at FROM fleet_routines ORDER BY name');
  const routineName = new Map(routines.map((r) => [r.id, r.name]));
  for (const [routineId, entry] of missByRoutine) {
    console.log(
      `  ${routineName.get(routineId) ?? routineId}  no-show=${entry['DISPATCH_NO_SHOW'] ?? 0} auth=${entry['DISPATCH_AUTH_NO_SHOW'] ?? 0} infra=${entry['DISPATCH_INFRA_NO_SHOW'] ?? 0}`,
    );
  }

  console.log('\nROUTINES');
  for (const r of routines) {
    console.log(`  ${r.name.padEnd(28)} ${r.state.padEnd(12)} connector=${r.connector_id ?? '-'} worker=${r.worker_id ?? '-'} last-check-in=${r.last_check_in_at ?? '-'}`);
    if (r.state !== 'ENABLED' && r.state_reason) console.log(`    cause: ${r.state_reason}`);
  }

  console.log('\nCONNECTORS');
  const accounts = new Map(
    (await db.all<{ id: string; name: string }>('SELECT id, name FROM fleet_accounts')).map((a) => [a.id, a.name]),
  );
  let humanRequired = 0;
  for (const health of await allConnectorHealth()) {
    const mine = routines.filter((r) => r.connector_id === health.connectorId);
    const lastCheckIn = mine.map((r) => r.last_check_in_at).filter((x): x is string => !!x).sort().at(-1) ?? '-';
    const counts = mine.reduce(
      (acc, r) => {
        const e = missByRoutine.get(r.id) ?? {};
        acc.noShow += e['DISPATCH_NO_SHOW'] ?? 0;
        acc.auth += e['DISPATCH_AUTH_NO_SHOW'] ?? 0;
        acc.infra += e['DISPATCH_INFRA_NO_SHOW'] ?? 0;
        return acc;
      },
      { noShow: 0, auth: 0, infra: 0 },
    );
    const quarantined = mine.filter((r) => r.state === 'QUARANTINED').map((r) => r.name);
    if (health.humanActionRequired) humanRequired += 1;
    console.log(
      `  ${health.connectorId}  account=${accounts.get(health.accountId) ?? health.accountId}  endpoint=${health.resource}`,
    );
    console.log(
      `    worker=${health.workerId ?? '-'} client=${health.currentClientId ?? '-'} health=${health.state}/${health.reason}`,
    );
    console.log(
      `    last-auth=${health.lastAccessUseAt ?? '-'} last-refresh=${health.lastRefreshAt ?? '-'} last-check-in=${lastCheckIn}`,
    );
    console.log(
      `    no-shows=${counts.noShow} auth-no-shows=${counts.auth} infra-misses=${counts.infra} quarantined=${quarantined.length ? quarantined.join(',') : 'no'}`,
    );
    console.log(`    human action required: ${health.humanActionRequired ? `YES — ${health.detail}` : 'NO'}`);
  }
  console.log(`\nconnectors needing a person: ${humanRequired}`);
  console.log('CONNECTION-REPORT: OK');
}

main()
  .catch((error: unknown) => {
    console.error(`CONNECTION-REPORT: FAILED ${describePoolerRefusal(error) ?? (error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase().catch(() => undefined));

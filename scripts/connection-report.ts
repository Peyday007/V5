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
import { unansweredFiresByRoutine } from '../server/repos/fleet.ts';

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

/**
 * One part of the report. A part that cannot be read is said to be unreadable
 * and the rest is still printed: the report is most needed exactly when the
 * database is slow, and one timed-out section used to take every later one
 * with it.
 */
async function section(title: string | null, body: () => Promise<void>): Promise<void> {
  if (title) console.log(`\n${title}`);
  try {
    await body();
  } catch (error) {
    console.log(`  (could not be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`);
  }
}

/** The schema `pg_stat_statements` lives in, or null when it is not installed. */
async function statementsSchema(): Promise<string | null> {
  const where = await getDb().get<{ schema: string | null }>(
    `SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_stat_statements'`,
  );
  return where?.schema ?? null;
}

/**
 * The database server's own view, Postgres only, one section per question so
 * an unreadable one never takes the rest with it (INF-2).
 *
 * Statement text only: `pg_stat_activity` shows parameters as `$n`, never their
 * values, for statements issued with parameters, which is how Brain issues all
 * of them. A role that is not a superuser sees other roles' rows with the query
 * withheld, so a count here is server-wide while the text is ours.
 *
 * What these readings separate, and what they cannot:
 *
 *   * `wait` — a backend `active` with no wait event is executing (CPU); one in
 *     `IO:*` is waiting on disk, `Lock:*` on another session, `Client:*` on the
 *     client. A statement Brain measured as slow while the server shows nothing
 *     active was not slow *on the server*: look at the pool wait, the event
 *     loop, and the pooler.
 *   * The pooler's own queue (Supavisor) is not visible from a database
 *     session at all, and neither is the compute's CPU or disk-IO budget. A
 *     server showing few active backends while Brain's response times are long
 *     and its event loop is healthy points at those — the Supabase dashboard is
 *     where they are read.
 */
async function databaseActivity(): Promise<void> {
  const db = getDb();
  if (db.dialect !== 'postgres') {
    console.log('  (SQLite: no server to ask)');
    return;
  }

  await section('  sessions by client, state and wait event (server-wide)', async () => {
    const groups = await db.all<{ app: string | null; state: string | null; wait: string | null; n: number; oldest: number | null }>(
      `SELECT COALESCE(NULLIF(application_name, ''), '(none)') AS app, COALESCE(state, '(hidden)') AS state,
              COALESCE(wait_event_type || ':' || wait_event, '') AS wait, COUNT(*) AS n,
              MAX(EXTRACT(EPOCH FROM (now() - COALESCE(state_change, backend_start))))::int AS oldest
         FROM pg_stat_activity
        WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
        GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 30`,
    );
    for (const g of groups) {
      console.log(`    ${String(Number(g.n)).padStart(3)}  ${(g.app ?? '').padEnd(22)} ${(g.state ?? '').padEnd(22)} ${(g.wait ?? '').padEnd(28)} longest-in-state=${g.oldest ?? '?'}s`);
    }
  });

  await section('  statements running now (this database)', async () => {
    const running = await db.all<{ pid: number; state: string | null; wait: string | null; secs: number; query: string | null }>(
      `SELECT pid, state, COALESCE(wait_event_type || ':' || wait_event, '') AS wait,
              EXTRACT(EPOCH FROM (now() - COALESCE(query_start, backend_start)))::int AS secs,
              LEFT(regexp_replace(query, '\\s+', ' ', 'g'), 180) AS query
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
        ORDER BY (state = 'idle') ASC, secs DESC
        LIMIT 25`,
    );
    const byState = new Map<string, number>();
    for (const row of running) byState.set(row.state ?? '?', (byState.get(row.state ?? '?') ?? 0) + 1);
    console.log(`    connections ${JSON.stringify(Object.fromEntries(byState))}`);
    for (const row of running.filter((r) => r.state !== 'idle')) {
      console.log(`    ${String(row.secs).padStart(6)}s ${(row.state ?? '?').padEnd(20)} ${row.wait ?? ''}  ${row.query ?? ''}`);
    }
  });

  await section('  lock waits: who is blocked, and by whom', async () => {
    const blocked = await db.all<{ pid: number; blockers: string; secs: number | null; wait: string | null; query: string | null }>(
      `SELECT pid, array_to_string(pg_blocking_pids(pid), ',') AS blockers,
              EXTRACT(EPOCH FROM (now() - query_start))::int AS secs,
              COALESCE(wait_event_type || ':' || wait_event, '') AS wait,
              LEFT(regexp_replace(query, '\\s+', ' ', 'g'), 140) AS query
         FROM pg_stat_activity
        WHERE cardinality(pg_blocking_pids(pid)) > 0
        ORDER BY query_start ASC NULLS LAST LIMIT 20`,
    );
    if (blocked.length === 0) {
      console.log('    none: no session is waiting on another session\'s lock right now');
      return;
    }
    for (const b of blocked) {
      console.log(`    pid ${b.pid} blocked ${b.secs ?? '?'}s by [${b.blockers}] ${b.wait ?? ''}  ${b.query ?? ''}`);
    }
    const ungranted = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pg_locks WHERE NOT granted');
    console.log(`    ungranted lock requests: ${Number(ungranted?.n ?? 0)}`);
  });

  await section('  tables by rows read sequentially (since the statistics were last reset)', async () => {
    const reset = await db.get<{ stats_reset: string | null }>(
      'SELECT stats_reset::text AS stats_reset FROM pg_stat_database WHERE datname = current_database()',
    );
    console.log(`    pg_stat_database stats_reset: ${reset?.stats_reset ?? 'never'}`);
    const scans = await db.all<{ relname: string; seq_scan: number; seq_tup_read: number; idx_scan: number | null; n_live_tup: number }>(
      `SELECT relname, seq_scan, seq_tup_read, idx_scan, n_live_tup FROM pg_stat_user_tables
        ORDER BY seq_tup_read DESC LIMIT 12`,
    );
    for (const t of scans) {
      console.log(`    ${t.relname.padEnd(32)} rows=${t.n_live_tup} seq_scans=${t.seq_scan} seq_rows_read=${t.seq_tup_read} idx_scans=${t.idx_scan ?? 0}`);
    }
  });

  await section('  capacity: the server\'s own configuration and what it has done since its statistics began', async () => {
    const settings = await db.all<{ name: string; setting: string; unit: string | null }>(
      `SELECT name, setting, unit FROM pg_settings
        WHERE name IN ('max_connections','superuser_reserved_connections','shared_buffers','synchronous_commit',
                       'wal_buffers','max_wal_size','checkpoint_timeout','effective_io_concurrency','statement_timeout',
                       'autovacuum','track_io_timing','work_mem')
        ORDER BY name`,
    );
    console.log(`    settings ${settings.map((s) => `${s.name}=${s.setting}${s.unit ?? ''}`).join(' ')}`);
    const d = await db.get<Record<string, string | number | null>>(
      `SELECT pg_database_size(current_database()) AS size_bytes, numbackends, xact_commit, xact_rollback,
              blks_read, blks_hit, temp_files, temp_bytes, deadlocks, blk_read_time, blk_write_time,
              stats_reset::text AS stats_reset
         FROM pg_stat_database WHERE datname = current_database()`,
    );
    if (d) {
      const read = Number(d['blks_read']);
      const hit = Number(d['blks_hit']);
      const ratio = read + hit > 0 ? ((100 * hit) / (read + hit)).toFixed(2) : '?';
      console.log(`    database size=${Math.round(Number(d['size_bytes']) / 1048576)}MB backends=${d['numbackends']} commits=${d['xact_commit']} rollbacks=${d['xact_rollback']} cache_hit=${ratio}% blocks_read=${read} temp_files=${d['temp_files']} temp_bytes=${d['temp_bytes']} read_time=${d['blk_read_time']}ms write_time=${d['blk_write_time']}ms since ${d['stats_reset'] ?? 'never'}`);
    }
  });

  await section('  write-ahead log (pg_stat_wal; Postgres 14+)', async () => {
    const w = await db.get<Record<string, string | number | null>>(
      `SELECT wal_records, wal_fpi, wal_bytes::bigint AS wal_bytes, wal_buffers_full, stats_reset::text AS stats_reset FROM pg_stat_wal`,
    );
    if (w) console.log(`    records=${w['wal_records']} full_page_images=${w['wal_fpi']} bytes=${Math.round(Number(w['wal_bytes']) / 1048576)}MB buffers_full=${w['wal_buffers_full']} since ${w['stats_reset'] ?? 'never'}`);
  });

  await section('  tables by rows written (updates rewrite a row; HOT updates are the cheap kind)', async () => {
    const t = await db.all<{ relname: string; ins: number; upd: number; hot: number; del: number; dead: number; live: number; total_bytes: number }>(
      `SELECT relname, n_tup_ins AS ins, n_tup_upd AS upd, n_tup_hot_upd AS hot, n_tup_del AS del,
              n_dead_tup AS dead, n_live_tup AS live, pg_total_relation_size(relid) AS total_bytes
         FROM pg_stat_user_tables ORDER BY (n_tup_ins + n_tup_upd + n_tup_del) DESC LIMIT 12`,
    );
    for (const r of t) {
      console.log(`    ${r.relname.padEnd(32)} ins=${r.ins} upd=${r.upd} hot=${r.hot} del=${r.del} dead=${r.dead} live=${r.live} size=${Math.round(Number(r.total_bytes) / 1048576)}MB`);
    }
  });

  const schema = await statementsSchema().catch(() => null);
  if (!schema) {
    console.log('  pg_stat_statements is not installed or not readable; the per-process statement costs above are the reading');
    return;
  }

  await section('  pg_stat_statements window', async () => {
    // pg_stat_statements_info exists from Postgres 14; without it the window is unknown.
    const info = await db.get<{ stats_reset: string | null; dealloc: number | null }>(
      `SELECT stats_reset::text AS stats_reset, dealloc FROM ${schema}.pg_stat_statements_info`,
    );
    console.log(`    stats_reset: ${info?.stats_reset ?? 'unknown'}  dealloc=${info?.dealloc ?? '?'}  read_at: ${new Date().toISOString()}`);
  });

  await section('  connection churn, server-wide (every client of the pooler, not only Brain)', async () => {
    // Cumulative since stats_reset above. A rate is the difference between two
    // reports divided by the time between them, and only while stats_reset is
    // the same in both. Compare with each process's own `churn` line.
    const churn = await db.all<{ query: string; calls: number; total: number }>(
      `SELECT LEFT(regexp_replace(query, '\\s+', ' ', 'g'), 80) AS query, SUM(calls) AS calls, SUM(total_exec_time)::bigint AS total
         FROM ${schema}.pg_stat_statements
        WHERE query ILIKE 'DISCARD ALL%' OR query ILIKE '%get_auth%'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
    );
    if (churn.length === 0) console.log('    no DISCARD ALL or get_auth rows');
    for (const c of churn) console.log(`    calls=${Number(c.calls)} total=${Number(c.total)}ms  ${c.query}`);
  });

  await section('  statements by total server time (pg_stat_statements)', async () => {
    const costly = await db.all<{ calls: number; total: number; mean: number; query: string }>(
      `SELECT calls, total_exec_time::bigint AS total, mean_exec_time::numeric(12,1) AS mean,
              LEFT(regexp_replace(query, '\\s+', ' ', 'g'), 180) AS query
         FROM ${schema}.pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
        ORDER BY total_exec_time DESC LIMIT 15`,
    );
    for (const q of costly) {
      console.log(`    total=${Number(q.total)}ms calls=${Number(q.calls)} mean=${Number(q.mean)}ms  ${q.query}`);
    }
  });

  // What a statement costs the disk rather than the clock: blocks it had to
  // read from storage, and write-ahead log it generated. Under an I/O budget
  // these are the two numbers that spend it; time alone cannot tell a slow
  // statement from one that waited behind somebody else's write.
  for (const [title, order] of [
    ['  statements by blocks read from disk (pg_stat_statements)', 'shared_blks_read'],
    ['  statements by write-ahead log generated (pg_stat_statements)', 'wal_bytes'],
  ] as const) {
    await section(title, async () => {
      const rows = await db.all<{ calls: number; read: number; dirtied: number; wal: number; query: string }>(
        `SELECT calls, shared_blks_read AS read, shared_blks_dirtied AS dirtied, wal_bytes::bigint AS wal,
                LEFT(regexp_replace(query, '\\s+', ' ', 'g'), 160) AS query
           FROM ${schema}.pg_stat_statements
          WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          ORDER BY ${order} DESC LIMIT 12`,
      );
      for (const q of rows) {
        console.log(`    calls=${Number(q.calls)} blks_read=${Number(q.read)} dirtied=${Number(q.dirtied)} wal=${Math.round(Number(q.wal) / 1048576)}MB  ${q.query}`);
      }
    });
  }
}

/**
 * RES-12c: how many of the alerts printed below need a person, counted from
 * those same alerts.
 *
 * The report used to print "connectors needing a person: 0" from
 * `connectorHealth.humanActionRequired` — a narrower question (is a connector's
 * *consent* gone) — directly above alerts naming an account owner or an
 * operator who had to act: a wrong worker, a recovery that ran out, an
 * out-of-scope account. Who acts is `connectionAlerts`' decision, and this only
 * counts it; the connector line above is relabelled as what it is.
 */
export function countAlertsNeedingAPerson(alerts: readonly { who: string }[]): {
  total: number;
  accountOwner: number;
  operator: number;
  nobody: number;
} {
  const accountOwner = alerts.filter((a) => a.who === 'ACCOUNT_OWNER').length;
  const operator = alerts.filter((a) => a.who === 'OPERATOR').length;
  return { total: accountOwner + operator, accountOwner, operator, nobody: alerts.length - accountOwner - operator };
}

export interface WarningInput {
  name: string;
  /** Real no-shows since the Routine's last recorded arrival (or lifted quarantine). */
  unansweredSinceArrival: number;
  fires24h: number;
  arrivals24h: number;
  /** Other live Routines on the same connector that are quarantined now. */
  quarantinedSiblings: string[];
}

/**
 * The warning signs measured against production history, 2026-09-16 to
 * 2026-10-15 (docs/CONNECTION-PREDICTION-2026-10-15.md). Each fires on rows
 * alone and says which reading it is; none of them predicts more than about
 * two hours ahead, and the report says so rather than implying more.
 *
 *   FIRST_NO_SHOW  a real no-show since the last arrival: precedes every
 *                  no-show quarantine (median ~1.6h ahead), but 25 of 39 such
 *                  first no-shows were not followed by one within 24h.
 *   SIBLING_DOWN   another Routine on the same connector is quarantined: in
 *                  10 of 14 cases a live sibling followed within 24h, almost
 *                  all within 40 minutes, because a connector fails as a unit.
 *   FEW_ARRIVALS   at least 4 fires and under half arriving in 24h: measured
 *                  only since arrivals were recorded (2026-10-11); about half
 *                  of the hours it fired were followed by a quarantine.
 */
export function warningsFor(input: WarningInput): string[] {
  const out: string[] = [];
  if (input.unansweredSinceArrival >= 1) {
    out.push(`FIRST_NO_SHOW ${input.unansweredSinceArrival} unanswered fire(s) since its last arrival; three quarantine it`);
  }
  if (input.quarantinedSiblings.length > 0) {
    out.push(`SIBLING_DOWN ${input.quarantinedSiblings.join(', ')} on the same connector is quarantined`);
  }
  if (input.fires24h >= 4 && input.arrivals24h * 2 < input.fires24h) {
    out.push(`FEW_ARRIVALS ${input.arrivals24h} of ${input.fires24h} fires in 24h arrived`);
  }
  return out;
}

async function earlyWarning(): Promise<void> {
  const db = getDb();
  const routines = await db.all<{ id: string; name: string; state: string; connector_id: string | null }>(
    `SELECT id, name, state, connector_id FROM fleet_routines WHERE state <> 'RETIRED' ORDER BY name`,
  );
  const unanswered = await unansweredFiresByRoutine();
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  let any = false;
  for (const r of routines) {
    if (r.state !== 'ENABLED') continue;
    const counts = await db.all<{ event_type: string; n: number }>(
      `SELECT event_type, COUNT(*) AS n FROM bin_events
        WHERE routine_id = ? AND at >= ? AND event_type IN ('DISPATCH_SENT', 'DISPATCH_SESSION_ARRIVED')
        GROUP BY event_type`,
      [r.id, since],
    );
    const n = (t: string) => Number(counts.find((c) => c.event_type === t)?.n ?? 0);
    const warnings = warningsFor({
      name: r.name,
      unansweredSinceArrival: unanswered.get(r.id) ?? 0,
      fires24h: n('DISPATCH_SENT'),
      arrivals24h: n('DISPATCH_SESSION_ARRIVED'),
      quarantinedSiblings: routines
        .filter((s) => s.id !== r.id && s.connector_id && s.connector_id === r.connector_id && s.state === 'QUARANTINED')
        .map((s) => s.name),
    });
    if (warnings.length === 0) continue;
    any = true;
    console.log(`  ${r.name}`);
    for (const w of warnings) console.log(`    ${w}`);
  }
  if (!any) console.log('  none');
}

/** The dispatch events that say what happened to a fire, in the order they can happen. */
export const HISTORY_EVENT_TYPES = [
  'DISPATCH_SENT',
  'DISPATCH_SESSION_ARRIVED',
  'DISPATCH_WRONG_WORKER',
  'DISPATCH_NO_SHOW',
  'DISPATCH_AUTH_NO_SHOW',
  'DISPATCH_INFRA_NO_SHOW',
  'DISPATCH_RETRY',
  'DISPATCH_ABANDONED',
  'DISPATCH_REVIVED',
  'DISPATCH_EXHAUSTED',
  'RECOVERY_PROBE_FIRED',
] as const;

/**
 * `--history`: the connection system's past as one row per fact, for
 * reconstructing what preceded each disconnection, quarantine and exhausted
 * recovery. One line per row, `|`-separated, prefixed by what the row is:
 *
 *   R  a Routine as it stands now, with the last instant a quarantine was lifted
 *   E  a dispatch event for a Routine (indexed by routine and time)
 *   P  a recovery probe and what it established
 *   I  an infrastructure incident Brain recorded about itself
 *   T  a token refusal, or a refresh recovered after a lost reply
 *   S  OAuth token successes per target per hour, so a client that stopped
 *      refreshing is visible as a gap
 *
 * Ids, categories and timestamps only; no secret, token, prompt or reason text
 * a worker wrote. Every part is read separately, so one that times out is said
 * to have failed and the rest still prints.
 */
async function history(since: string): Promise<void> {
  const db = getDb();
  const routines = await db.all<{
    id: string; name: string; state: string; state_reason: string | null; updated_at: string;
    no_shows_forgiven_at: string | null; worker_id: string | null; connector_id: string | null;
  }>('SELECT id, name, state, state_reason, updated_at, no_shows_forgiven_at, worker_id, connector_id FROM fleet_routines ORDER BY name');
  const names = new Map(routines.map((r) => [r.id, r.name]));
  for (const r of routines) {
    const reason = (r.state_reason ?? '').replace(/[|\n]/g, ' ').slice(0, 60);
    console.log(`R|${r.id}|${r.name}|${r.state}|${r.updated_at}|${r.no_shows_forgiven_at ?? '-'}|${r.worker_id ?? '-'}|${r.connector_id ?? '-'}|${reason}`);
  }
  const types = HISTORY_EVENT_TYPES.map((t) => `'${t}'`).join(',');
  for (const r of routines) {
    if (r.state === 'RETIRED') continue;
    await section(null, async () => {
      const rows = await db.all<{ event_type: string; at: string; worker_id: string | null; outcome: string | null; session_ref: string | null }>(
        `SELECT event_type, at, worker_id, outcome, session_ref FROM bin_events
          WHERE routine_id = ? AND at >= ? AND event_type IN (${types}) ORDER BY at`,
        [r.id, since],
      );
      for (const e of rows) {
        console.log(`E|${r.name}|${e.event_type}|${e.at}|${e.worker_id ?? '-'}|${e.outcome ?? '-'}|${e.session_ref ? 'session' : '-'}`);
      }
    });
  }
  await section(null, async () => {
    const probes = await db.all<{ routine_id: string; state: string; created_at: string; fired_at: string | null; arrived_at: string | null; settled_at: string | null; health: string | null }>(
      'SELECT routine_id, state, created_at, fired_at, arrived_at, settled_at, health FROM connector_recovery_probes WHERE created_at >= ? ORDER BY created_at',
      [since],
    );
    for (const p of probes) {
      console.log(`P|${names.get(p.routine_id) ?? p.routine_id}|${p.state}|${p.created_at}|${p.fired_at ?? '-'}|${p.arrived_at ?? '-'}|${p.settled_at ?? '-'}|${p.health ?? '-'}`);
    }
  });
  await section(null, async () => {
    const incidents = await listIncidentsSince(since, 5000);
    for (const i of incidents) {
      console.log(`I|${i.kind}|${i.surface}|${i.startedAt}|${i.endedAt}|${i.occurrences}|${i.affectsArrival ? 1 : 0}|${i.workerId ?? '-'}`);
    }
  });
  await section(null, async () => {
    const refusals = await db.all<{ action: string; result: string; reason: string | null; target_id: string | null; created_at: string; metadata: string | null }>(
      `SELECT action, result, reason, target_id, created_at, metadata FROM identity_events
        WHERE action IN ('OAUTH_TOKEN', 'MCP_AUTHENTICATE') AND created_at >= ?
          AND (result = 'DENIED' OR (result = 'SUCCESS' AND metadata LIKE '%"recovered"%'))
        ORDER BY created_at`,
      [since],
    );
    for (const t of refusals) {
      const recovered = safeJson(t.metadata)['recovered'];
      console.log(`T|${t.action}|${t.result}|${t.reason ?? '-'}|${t.target_id ?? '-'}|${t.created_at}|${typeof recovered === 'string' ? recovered : '-'}`);
    }
  });
  await section(null, async () => {
    const hourly = await db.all<{ hour: string; target_id: string | null; n: number }>(
      `SELECT SUBSTR(created_at, 1, 13) AS hour, target_id, COUNT(*) AS n FROM identity_events
        WHERE action = 'OAUTH_TOKEN' AND result = 'SUCCESS' AND created_at >= ?
        GROUP BY SUBSTR(created_at, 1, 13), target_id ORDER BY hour`,
      [since],
    );
    for (const h of hourly) console.log(`S|${h.hour}|${h.target_id ?? '-'}|${Number(h.n)}`);
  });
  console.log('CONNECTION-REPORT: OK');
}

async function main(): Promise<void> {
  await initDatabase();
  const hours = Number(arg('hours') ?? '24');
  const since = new Date(Date.now() - (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000).toISOString();
  const db = getDb();
  console.log(`window: since ${since}`);
  if (process.argv.includes('--history')) {
    await history(since);
    return;
  }

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
    // Pool wait and event-loop delay first: they are what separate "the
    // database answered slowly" from "Brain was not ready to ask, or to hear".
    const checkouts = (r['checkouts'] ?? {}) as Record<string, { count: number; p50: number; p95: number; max: number }>;
    for (const [pool, l] of Object.entries(checkouts)) {
      console.log(`    pool wait    ${pool.padEnd(16)} n=${l.count} p50=${l.p50}ms p95=${l.p95}ms max=${l.max}ms`);
    }
    const churn = r['churn'] as { since?: string; counts?: Record<string, number> } | undefined;
    if (churn?.counts) console.log(`    churn        ${JSON.stringify(churn.counts)} since ${churn.since ?? '?'}`);
    const loop = r['eventLoop'] as { windowMs: number; p50: number; p99: number; max: number; worstMs: number; worstAt: string | null } | null | undefined;
    if (loop) {
      console.log(
        `    event loop   last ${Math.round(loop.windowMs / 1000)}s: p50=${loop.p50}ms p99=${loop.p99}ms max=${loop.max}ms; worst since start ${loop.worstMs}ms at ${loop.worstAt ?? '-'}`,
      );
    } else {
      console.log('    event loop   (not measured by this revision)');
    }
    const pressure = r['pressure'] as { state: string; reason: string; p90Ms: number | null; samples: number; failures: number; byKind?: Record<string, number>; since: string } | undefined;
    if (pressure) {
      console.log(`    pressure     ${pressure.state} since ${pressure.since}: ${pressure.reason} (now p90=${pressure.p90Ms ?? '-'}ms over ${pressure.samples} statements, ${pressure.failures} overload failure(s) in 120s, felt ${JSON.stringify(pressure.byKind ?? {})})`);
    }
    // What the adapter felt since start, by pool and kind, whether or not a
    // caller turned it into an incident.
    if (r['databaseFailures'] && Object.keys(r['databaseFailures'] as object).length > 0) {
      console.log(`    db felt      ${JSON.stringify(r['databaseFailures'])}`);
    }
    // `total`/`max` are the time awaiting the response with a client in hand;
    // `wait` is the time spent obtaining that client first. Neither is pure
    // server execution — see `server/db/infra.ts`.
    type Cost = { key: string; count: number; totalMs: number; maxMs: number; waitTotalMs?: number; waitMaxMs?: number };
    const waits = (c: Cost): string =>
      c.waitTotalMs === undefined ? '' : ` wait=${c.waitTotalMs}ms wait-max=${c.waitMaxMs ?? 0}ms`;
    for (const c of ((r['holds'] ?? []) as Cost[]).slice(0, 8)) {
      console.log(`    held         total=${c.totalMs}ms n=${c.count} max=${c.maxMs}ms${waits(c)}  ${c.key}`);
    }
    for (const c of ((r['statements'] ?? []) as Cost[]).slice(0, 10)) {
      console.log(`    statement    response=${c.totalMs}ms n=${c.count} max=${c.maxMs}ms${waits(c)}  ${c.key}`);
    }
  }

  await section('DATABASE (what the server itself is doing now)', () => databaseActivity());

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
  await section(null, async () => {
    const infraCalls = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM identity_events
        WHERE action = 'MCP_TOOL_CALL' AND result = 'FAILED' AND created_at >= ? AND metadata LIKE '%INFRA_RETRYABLE%'`,
      [since],
    );
    console.log(`  MCP tool calls answered INFRA_RETRYABLE (not auth): ${Number(infraCalls?.n ?? 0)}`);
  });

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
  let connectorsHuman = 0;
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
    if (health.humanActionRequired) connectorsHuman += 1;
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
  console.log(`\nconnectors whose own health needs a person: ${connectorsHuman}`);

  /*
   * Who actually arrived when a Routine was fired. A wrong-worker arrival is a
   * Claude Routine choosing another Brain connector: the connector works, the
   * selection is wrong, and no reconnect fixes it.
   */
  // Before the three window-wide aggregates below, which are the reads most
  // likely to time out exactly when the database is slow — and each is now its
  // own part, so a timeout in one no longer ends the report.
  await section('\nEARLY WARNING (enabled Routines showing what preceded past quarantines)', () => earlyWarning());

  await section('\nARRIVALS (fired sessions that checked in, by Routine)', async () => {
  const arrivals = await db.all<{ routine_id: string | null; event_type: string; n: number; last: string; worker: string | null }>(
    `SELECT routine_id, event_type, COUNT(*) AS n, MAX(at) AS last, MAX(worker_id) AS worker FROM bin_events
      WHERE event_type IN ('DISPATCH_SESSION_ARRIVED', 'DISPATCH_WRONG_WORKER') AND at >= ?
      GROUP BY routine_id, event_type ORDER BY last DESC`,
    [since],
  );
  if (arrivals.length === 0) console.log('  none recorded in the window');
  for (const a of arrivals) {
    console.log(
      `  ${routineName.get(a.routine_id ?? '') ?? a.routine_id}  ${a.event_type === 'DISPATCH_WRONG_WORKER' ? 'WRONG WORKER' : 'arrived'} ` +
        `n=${Number(a.n)} last=${a.last} as=${a.worker ?? '-'}`,
    );
  }
  });

  /*
   * What each worker's sessions actually called, from the audit row every MCP
   * tool call writes. The question this answers is the one a probe that read
   * "nothing reached Brain" cannot: did a session arrive and call something
   * other than check-in, or call nothing at all.
   */
  await section('\nMCP CALLS (by worker and tool)', async () => {
  const calls = await db.all<{ actor_id: string | null; target_id: string | null; result: string; n: number; last: string }>(
    `SELECT actor_id, target_id, result, COUNT(*) AS n, MAX(created_at) AS last FROM identity_events
      WHERE action = 'MCP_TOOL_CALL' AND actor_type = 'WORKER' AND created_at >= ?
      GROUP BY actor_id, target_id, result ORDER BY actor_id, last DESC`,
    [since],
  );
  if (calls.length === 0) console.log('  none in the window');
  for (const c of calls) {
    console.log(`  ${c.actor_id ?? '-'}  ${c.target_id ?? '-'}  ${c.result}  n=${Number(c.n)} last=${c.last}`);
  }
  });

  /*
   * Work, by worker and project, from the bin ledger.
   *
   * An arrival says a session checked in; it does not say it did anything.
   * "Verify real work completes" was answerable only by inference — a check-in
   * count beside a quarantine — so this counts what a session did once it was
   * in: bins it took, work items it claimed, units it submitted, completions
   * Brain accepted and refused. Every figure is a `bin_events` row Brain wrote
   * with the authenticated worker on it; nothing a worker said contributes.
   */
  await section('\nWORK (what sessions did once in, by worker and project)', async () => {
  const work = await db.all<{ worker_id: string; project_id: string | null; event_type: string; n: number; last: string }>(
    `SELECT worker_id, project_id, event_type, COUNT(*) AS n, MAX(at) AS last FROM bin_events
      WHERE worker_id IS NOT NULL AND at >= ?
        AND event_type IN ('BIN_ASSIGNED', 'BIN_TAKEOVER', 'BIN_ITEM_CLAIMED', 'BIN_UNIT_SUBMITTED',
                           'BIN_COMPLETION_ACCEPTED', 'BIN_COMPLETION_REFUSED', 'BIN_RELEASED')
      GROUP BY worker_id, project_id, event_type ORDER BY worker_id, project_id, event_type`,
    [since],
  );
  if (work.length === 0) console.log('  none in the window');
  const grouped = new Map<string, string[]>();
  const lastAt = new Map<string, string>();
  for (const row of work) {
    const key = `${row.worker_id}  ${row.project_id ?? '-'}`;
    grouped.set(key, [...(grouped.get(key) ?? []), `${row.event_type.replace(/^BIN_/, '').toLowerCase()}=${Number(row.n)}`]);
    if ((lastAt.get(key) ?? '') < row.last) lastAt.set(key, row.last);
  }
  for (const [key, counts] of grouped) console.log(`  ${key}  ${counts.join(' ')}  last=${lastAt.get(key)}`);
  });

  console.log('\nALERTS (who has to act, and what)');
  const { connectionAlerts } = await import('../server/services/fleet/connectionAlerts.ts');
  const alerts = await connectionAlerts();
  const actionable = countAlertsNeedingAPerson(alerts.alerts);
  console.log(
    `  need a person: ${actionable.total} (account owner ${actionable.accountOwner}, operator ${actionable.operator}); ` +
      `Brain is handling ${actionable.nobody} itself`,
  );
  if (alerts.alerts.length === 0) console.log('  none');
  for (const alert of alerts.alerts) {
    console.log(`  ${alert.routineName} (${alert.accountName})  ${alert.problem}  who=${alert.who}`);
    console.log(`    ${alert.detail}`);
    if (alert.projects) console.log(`    serves: ${alert.projects.served.join(', ') || 'no project'} · waiting in: ${alert.projects.waiting.join(', ')}`);
    console.log(`    action: ${alert.action}`);
  }
  for (const account of alerts.stalled) {
    console.log(`  STALLED ACCOUNT ${account.accountName}: every live Routine needs a person`);
  }
  console.log('CONNECTION-REPORT: OK');
}

// Run only when executed, so the counting rule above can be imported by a test.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  main()
    .catch((error: unknown) => {
      console.error(`CONNECTION-REPORT: FAILED ${describePoolerRefusal(error) ?? (error instanceof Error ? error.message : String(error))}`);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase().catch(() => undefined));
}

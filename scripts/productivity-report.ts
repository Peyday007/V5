/**
 * `npm run report:productivity` — what the research fleet actually finished,
 * by account, before and after a moment, and why the rest did not finish.
 *
 * Read-only by construction: it opens the database, reads, prints and closes.
 * No INSERT, UPDATE or DELETE, nothing enqueued, nothing fired.
 *
 *   npm run report:productivity -- [--hours 6] [--split 2026-10-20T16:00:00Z] [--project prj_x]
 *
 * "Productive" is a fact about rows, never about a worker's report. A lease
 * ends SUCCEEDED only when `brain_complete_work` accepted it, and that tool
 * refuses to complete a research item that recorded nothing — so a SUCCEEDED
 * lease on a research item is work that moved its packet. A session that was
 * fired is not a completion; a lease that expired, was released or failed is
 * not either, and each is counted on its own line.
 *
 * Before and after are the same length, either side of `--split`, so a reader
 * compares like with like. Without `--split` it reports the last `--hours`.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { describePoolerRefusal } from '../server/db/adapters/postgres.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

const OUTCOMES = ['SUCCEEDED', 'FAILED', 'EXPIRED', 'RELEASED', 'CANCELLED'] as const;

/** The tool calls that say whether a worker finished, handed back or was refused. */
const TOOLS = [
  'brain_complete_work',
  'brain_release_work',
  'brain_fail_work',
  'brain_bin_complete',
  'brain_bin_release',
  'brain_submit_claims',
  'brain_submit_verification',
  'brain_submit_synthesis',
  'brain_submit_audit',
] as const;

interface Window {
  label: string;
  from: string;
  to: string;
}

async function workerLabels(): Promise<Map<string, string>> {
  const rows = await getDb().all<{ worker_id: string; account: string; routine: string }>(
    `SELECT r.worker_id AS worker_id, a.name AS account, r.name AS routine
       FROM fleet_routines r JOIN fleet_accounts a ON a.id = r.account_id
      WHERE r.worker_id IS NOT NULL AND r.state <> 'RETIRED'`,
  );
  const byWorker = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = byWorker.get(row.worker_id) ?? new Set<string>();
    set.add(row.account);
    byWorker.set(row.worker_id, set);
  }
  return new Map([...byWorker].map(([id, set]) => [id, [...set].sort().join(', ')]));
}

async function leases(window: Window, projectId: string | null): Promise<void> {
  const labels = await workerLabels();
  const rows = await getDb().all<{ worker_id: string; outcome: string | null; work_type: string; n: number }>(
    `SELECT l.worker_id AS worker_id, l.outcome AS outcome, w.work_type AS work_type, COUNT(*) AS n
       FROM work_leases l JOIN work_items w ON w.id = l.work_item_id
      WHERE l.claimed_at >= ? AND l.claimed_at < ?
        AND (CAST(? AS TEXT) IS NULL OR l.project_id = ?)
      GROUP BY l.worker_id, l.outcome, w.work_type`,
    [window.from, window.to, projectId, projectId],
  );
  const perWorker = new Map<string, Record<string, number>>();
  const perType = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const outcome = row.outcome ?? 'OPEN';
    const worker = perWorker.get(row.worker_id) ?? {};
    worker[outcome] = (worker[outcome] ?? 0) + Number(row.n);
    perWorker.set(row.worker_id, worker);
    const type = perType.get(row.work_type) ?? {};
    type[outcome] = (type[outcome] ?? 0) + Number(row.n);
    perType.set(row.work_type, type);
  }
  console.log(`  LEASES ${window.label}  ${window.from} → ${window.to}`);
  const line = (counts: Record<string, number>): string => {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const done = counts['SUCCEEDED'] ?? 0;
    const parts = [...OUTCOMES, 'OPEN'].map((o) => `${o.toLowerCase()}=${counts[o] ?? 0}`).join(' ');
    return `claimed=${total} ${parts} productive-share=${total > 0 ? (done / total).toFixed(2) : '—'}`;
  };
  if (perWorker.size === 0) console.log('    no leases');
  for (const [worker, counts] of [...perWorker].sort()) {
    console.log(`    ${worker} [${labels.get(worker) ?? 'no live Routine'}]  ${line(counts)}`);
  }
  for (const [type, counts] of [...perType].sort()) {
    console.log(`    type ${type.padEnd(22)} ${line(counts)}`);
  }
}

async function tools(window: Window, projectId: string | null): Promise<void> {
  const rows = await getDb().all<{ target_id: string; result: string; n: number }>(
    `SELECT target_id, result, COUNT(*) AS n FROM identity_events
      WHERE action = 'MCP_TOOL_CALL'
        AND target_id IN (${TOOLS.map(() => '?').join(', ')})
        AND created_at >= ? AND created_at < ?
        AND (CAST(? AS TEXT) IS NULL OR project_id = ?)
      GROUP BY target_id, result`,
    [...TOOLS, window.from, window.to, projectId, projectId],
  );
  const byTool = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const entry = byTool.get(row.target_id) ?? {};
    entry[row.result] = (entry[row.result] ?? 0) + Number(row.n);
    byTool.set(row.target_id, entry);
  }
  console.log(`  TOOL CALLS ${window.label} (a FAILED complete is a refused completion; a release is a handback)`);
  for (const tool of TOOLS) {
    const entry = byTool.get(tool) ?? {};
    console.log(
      `    ${tool.padEnd(26)} success=${entry['SUCCESS'] ?? 0} failed=${entry['FAILED'] ?? 0} denied=${entry['DENIED'] ?? 0}`,
    );
  }
}

async function hourly(from: string, to: string, projectId: string | null): Promise<void> {
  const rows = await getDb().all<{ hour: string; outcome: string | null; n: number }>(
    `SELECT substr(claimed_at, 1, 13) AS hour, outcome, COUNT(*) AS n FROM work_leases
      WHERE claimed_at >= ? AND claimed_at < ? AND (CAST(? AS TEXT) IS NULL OR project_id = ?)
      GROUP BY substr(claimed_at, 1, 13), outcome`,
    [from, to, projectId, projectId],
  );
  const byHour = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const entry = byHour.get(row.hour) ?? {};
    entry[row.outcome ?? 'OPEN'] = (entry[row.outcome ?? 'OPEN'] ?? 0) + Number(row.n);
    byHour.set(row.hour, entry);
  }
  console.log('  HOURLY (by the hour a lease was claimed)');
  for (const [hour, e] of [...byHour].sort()) {
    console.log(
      `    ${hour}  succeeded=${e['SUCCEEDED'] ?? 0} failed=${e['FAILED'] ?? 0} expired=${e['EXPIRED'] ?? 0} ` +
        `released=${e['RELEASED'] ?? 0} cancelled=${e['CANCELLED'] ?? 0} open=${e['OPEN'] ?? 0}`,
    );
  }
}

async function parked(projectId: string | null): Promise<void> {
  const rows = await getDb().all<{ reason: string | null; n: number; newest: string }>(
    `SELECT substr(failure_reason, 1, 96) AS reason, COUNT(*) AS n, MAX(updated_at) AS newest
       FROM research_orchestrations
      WHERE status = 'NEEDS_HUMAN' AND (CAST(? AS TEXT) IS NULL OR project_id = ?)
      GROUP BY substr(failure_reason, 1, 96)
      ORDER BY COUNT(*) DESC`,
    [projectId, projectId],
  );
  const total = rows.reduce((sum, row) => sum + Number(row.n), 0);
  console.log(`  PARKED PACKETS (NEEDS_HUMAN) ${total}`);
  for (const row of rows) {
    console.log(`    ${String(row.n).padStart(4)}  ${row.reason ?? '(no reason recorded)'}  newest ${row.newest}`);
  }

  /*
   * A judge that asked for more parks the packet with the reason no repair
   * could be attempted, in the repair planner's own words between the
   * parentheses. Counted per refusal, because which refusals dominate says
   * whether the park is a person's decision or a condition Brain could clear.
   */
  const verdicts = await getDb().all<{ failure_reason: string }>(
    `SELECT failure_reason FROM research_orchestrations
      WHERE status = 'NEEDS_HUMAN' AND failure_reason LIKE 'The judge''s verdict was %'
        AND (CAST(? AS TEXT) IS NULL OR project_id = ?)`,
    [projectId, projectId],
  );
  const refusals = new Map<string, number>();
  for (const { failure_reason: reason } of verdicts) {
    const inner = /on this packet \((.*)\)\. A person decides/s.exec(reason)?.[1] ?? '(unparsed)';
    for (const part of new Set(inner.split('; ').map((one) => one.replace(/frg_[0-9a-f]+/g, 'frg_…').slice(0, 110)))) {
      refusals.set(part, (refusals.get(part) ?? 0) + 1);
    }
  }
  console.log(`  WHY A JUDGE-PARKED PACKET COULD NOT BE REPAIRED (${verdicts.length} packets; one packet may name several)`);
  for (const [part, n] of [...refusals].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`    ${String(n).padStart(4)}  ${part}`);
  }
}

async function main(): Promise<void> {
  await initDatabase();
  const hours = Math.max(1, Number(flag('hours') ?? '6'));
  const projectId = flag('project');
  const span = hours * 60 * 60_000;
  const splitFlag = flag('split');
  const split = splitFlag ? new Date(splitFlag) : null;
  if (split && Number.isNaN(split.getTime())) throw new Error(`--split ${splitFlag} is not a time`);
  const now = Date.now();
  const windows: Window[] = split
    ? [
        { label: 'BEFORE', from: new Date(split.getTime() - span).toISOString(), to: split.toISOString() },
        {
          label: 'AFTER',
          from: split.toISOString(),
          to: new Date(Math.min(now, split.getTime() + span)).toISOString(),
        },
      ]
    : [{ label: 'LAST', from: new Date(now - span).toISOString(), to: new Date(now).toISOString() }];

  console.log(`PRODUCTIVITY project=${projectId ?? 'all'} hours=${hours} split=${split?.toISOString() ?? '—'}`);
  for (const window of windows) {
    await leases(window, projectId);
    await tools(window, projectId);
  }
  await hourly(windows[0]!.from, windows[windows.length - 1]!.to, projectId);
  await parked(projectId);
  console.log('PRODUCTIVITY-REPORT: OK');
}

main()
  .catch((error) => {
    const pooler = describePoolerRefusal(error);
    console.error(`PRODUCTIVITY-REPORT: FAILED ${pooler ?? ''}`, pooler ? '' : error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());

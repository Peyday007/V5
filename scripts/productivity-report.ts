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

/** Why leases ended without a completion, in the queue's own words. */
async function endings(window: Window, projectId: string | null): Promise<void> {
  const rows = await getDb().all<{ outcome: string; detail: string | null; n: number }>(
    `SELECT outcome, substr(detail, 1, 120) AS detail, COUNT(*) AS n FROM work_leases
      WHERE claimed_at >= ? AND claimed_at < ? AND outcome IN ('RELEASED', 'EXPIRED', 'CANCELLED', 'FAILED')
        AND (CAST(? AS TEXT) IS NULL OR project_id = ?)
      GROUP BY outcome, substr(detail, 1, 120)
      ORDER BY COUNT(*) DESC`,
    [window.from, window.to, projectId, projectId],
  );
  console.log(`  WHY LEASES ENDED WITHOUT A COMPLETION ${window.label}`);
  for (const row of rows.slice(0, 12)) {
    console.log(`    ${String(row.n).padStart(4)}  ${row.outcome.padEnd(9)} ${row.detail ?? '(no detail)'}`);
  }

  // How long a released lease was held, and whether anything was recorded under it.
  const released = await getDb().all<{ claimed_at: string; ended_at: string | null; work_item_id: string; worker_id: string }>(
    `SELECT claimed_at, ended_at, work_item_id, worker_id FROM work_leases
      WHERE claimed_at >= ? AND claimed_at < ? AND outcome = 'RELEASED'
        AND (CAST(? AS TEXT) IS NULL OR project_id = ?)`,
    [window.from, window.to, projectId, projectId],
  );
  const held = released
    .filter((row) => row.ended_at)
    .map((row) => (Date.parse(row.ended_at!) - Date.parse(row.claimed_at)) / 1000)
    .sort((a, b) => a - b);
  const at = (q: number) => (held.length ? held[Math.min(held.length - 1, Math.floor(q * held.length))]!.toFixed(0) : '—');
  let withEffect = 0;
  const byOp = new Map<string, number>();
  for (const row of released) {
    const ops = await getDb().all<{ namespace: string; state: string }>(
      `SELECT namespace, state FROM idempotency_operations WHERE work_item_id = ?`,
      [row.work_item_id],
    );
    if (ops.length > 0) withEffect += 1;
    // Which operations those were: an output that committed (the handback should
    // have completed it) reads differently from a blocker or a refused submit.
    const label = [...new Set(ops.map((op) => `${op.namespace}:${op.state}`))].sort().join('+') || 'none';
    byOp.set(label, (byOp.get(label) ?? 0) + 1);
  }
  console.log(
    `  RELEASED LEASES ${window.label}: ${released.length}, held p10=${at(0.1)}s p50=${at(0.5)}s p90=${at(0.9)}s, ` +
      `item carries a recorded effect: ${withEffect}`,
  );
  for (const [label, n] of [...byOp].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`      ${String(n).padStart(4)}  ${label}`);
  }

  const bins = await getDb().all<{ reason: string | null; n: number }>(
    `SELECT substr(reason, 1, 140) AS reason, COUNT(*) AS n FROM bin_events
      WHERE event_type = 'BIN_RELEASED' AND at >= ? AND at < ?
        AND (CAST(? AS TEXT) IS NULL OR project_id = ? OR project_id IS NULL)
      GROUP BY substr(reason, 1, 140) ORDER BY COUNT(*) DESC`,
    [window.from, window.to, projectId, projectId],
  );
  console.log(`  WHY BINS WERE HANDED BACK ${window.label}`);
  for (const row of bins.slice(0, 10)) console.log(`    ${String(row.n).padStart(4)}  ${row.reason ?? '(no reason)'}`);
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
    const samples = await getDb().all<{ id: string; created_at: string; approval_envelope_id: string | null; goal_id: string | null }>(
      `SELECT id, created_at, approval_envelope_id, goal_id FROM research_orchestrations
        WHERE status = 'NEEDS_HUMAN' AND substr(failure_reason, 1, 96) = ?
          AND (CAST(? AS TEXT) IS NULL OR project_id = ?)
        ORDER BY updated_at DESC LIMIT 3`,
      [row.reason ?? '', projectId, projectId],
    );
    for (const one of samples) {
      console.log(
        `          e.g. ${one.id} created ${one.created_at} envelope=${one.approval_envelope_id ?? '—'} goal=${one.goal_id ?? '—'}`,
      );
    }
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

/**
 * Which questions are asked again after an earlier fragment already answered
 * them — the `repeated` count in the cash report's usefulness block — grouped
 * by the normalized question, with how each repeat was made (its packet's
 * envelope, its fragment key, its attempt and status). Read-only.
 */
async function repeated(projectId: string | null): Promise<void> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const rows = await getDb().all<{
    id: string;
    question: string;
    status: string;
    created_at: string;
    accepted_at: string | null;
    fragment_key: string;
    attempt: number;
    envelope: string | null;
    orchestration_id: string;
  }>(
    `SELECT f.id, f.question, f.status, f.created_at, f.accepted_at, f.fragment_key, f.attempt,
            o.approval_envelope_id AS envelope, f.orchestration_id
       FROM research_fragments f JOIN research_orchestrations o ON o.id = f.orchestration_id
      WHERE f.created_at >= ? AND (CAST(? AS TEXT) IS NULL OR f.project_id = ?)
      ORDER BY f.created_at`,
    [since, projectId, projectId],
  );
  const norm = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const firstAccepted = new Map<string, string>();
  for (const row of rows) {
    if (row.status !== 'ACCEPTED') continue;
    const key = norm(row.question);
    const at = row.accepted_at ?? row.created_at;
    if (!firstAccepted.has(key) || at < firstAccepted.get(key)!) firstAccepted.set(key, at);
  }
  const groups = new Map<string, { n: number; last: string; day: number; statuses: Map<string, number>; keys: Set<string>; packets: Set<string>; envelopes: Set<string> }>();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  let total = 0;
  for (const row of rows) {
    const key = norm(row.question);
    const earlier = firstAccepted.get(key);
    if (!earlier || earlier >= row.created_at) continue;
    total += 1;
    const g = groups.get(key) ?? { n: 0, last: '', day: 0, statuses: new Map(), keys: new Set(), packets: new Set(), envelopes: new Set() };
    g.n += 1;
    if (row.created_at > g.last) g.last = row.created_at;
    if (row.created_at >= dayAgo) g.day += 1;
    g.statuses.set(row.status, (g.statuses.get(row.status) ?? 0) + 1);
    g.keys.add(row.fragment_key);
    g.packets.add(row.orchestration_id);
    g.envelopes.add(row.envelope ?? '—');
    groups.set(key, g);
  }
  console.log(`  REPEATED QUESTIONS (30 days): ${total} fragment(s) re-asked a question already accepted, ${groups.size} distinct`);
  for (const [question, g] of [...groups].sort((a, b) => b[1].n - a[1].n).slice(0, 15)) {
    const statuses = [...g.statuses].map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(
      `    ${String(g.n).padStart(4)}  last24h=${g.day} newest=${g.last.slice(0, 16)} packets=${g.packets.size} keys=${[...g.keys].slice(0, 3).join(',')} ` +
        `env=${[...g.envelopes].join(',')} ${statuses}  "${question.slice(0, 140)}"`,
    );
  }
}

/**
 * Packets, not items: what actually finished, and how long the audit stage took.
 *
 * A work item completing is a step; a packet reaching COMPLETE is the result.
 * Every figure here is a count of rows or a difference between two recorded
 * timestamps, and "accepted" is the packet's own status — a judge's verdict
 * that let it file — never a worker's account.
 */
async function packets(window: Window, projectId: string | null): Promise<void> {
  const db = getDb();
  const hours = (Date.parse(window.to) - Date.parse(window.from)) / 3_600_000;
  const rate = (n: number) => (hours > 0 ? (n / hours).toFixed(2) : '—');
  const done = await db.all<{ status: string; verdict: string | null; n: number }>(
    `SELECT status, verdict, COUNT(*) AS n FROM research_orchestrations
      WHERE completed_at >= ? AND completed_at < ? AND status IN ('COMPLETE', 'COMPLETE_WITH_GAPS')
        AND (CAST(? AS TEXT) IS NULL OR project_id = ?)
      GROUP BY status, verdict`,
    [window.from, window.to, projectId, projectId],
  );
  const completed = done.reduce((sum, row) => sum + Number(row.n), 0);
  const resumed = await db.all<{ payload: string; created_at: string }>(
    `SELECT payload, created_at FROM project_events
      WHERE event_type = 'RESEARCH_ROUND_RESUMED' AND created_at >= ? AND created_at < ?
        AND (CAST(? AS TEXT) IS NULL OR project_id = ?)`,
    [window.from, window.to, projectId, projectId],
  );
  // Parks are not evented consistently, so the packet's own last write is the reading:
  // a NEEDS_HUMAN packet last updated inside the window parked (or re-parked) in it.
  const parkedNow = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM research_orchestrations
      WHERE status = 'NEEDS_HUMAN' AND updated_at >= ? AND updated_at < ?
        AND (CAST(? AS TEXT) IS NULL OR project_id = ?)`,
    [window.from, window.to, projectId, projectId],
  );
  // Why they are parked, so a count of parks names its causes.
  const parkReasons = await db.all<{ reason: string; n: number }>(
    `SELECT SUBSTR(COALESCE(blocked_reason, '(no reason recorded)'), 1, 110) AS reason, COUNT(*) AS n
       FROM research_orchestrations
      WHERE status = 'NEEDS_HUMAN' AND updated_at >= ? AND updated_at < ?
        AND (CAST(? AS TEXT) IS NULL OR project_id = ?)
      GROUP BY SUBSTR(COALESCE(blocked_reason, '(no reason recorded)'), 1, 110)
      ORDER BY n DESC LIMIT 8`,
    [window.from, window.to, projectId, projectId],
  );
  const leases = await db.get<{ n: number; workers: number }>(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT worker_id) AS workers FROM work_leases
      WHERE claimed_at >= ? AND claimed_at < ? AND (CAST(? AS TEXT) IS NULL OR project_id = ?)`,
    [window.from, window.to, projectId, projectId],
  );
  const binAssignments = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bin_events
      WHERE event_type IN ('BIN_ASSIGNED', 'BIN_TAKEOVER') AND at >= ? AND at < ?
        AND (CAST(? AS TEXT) IS NULL OR project_id = ?)`,
    [window.from, window.to, projectId, projectId],
  );
  const fires = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bin_events
      WHERE event_type = 'DISPATCH_SENT' AND at >= ? AND at < ?
        AND (CAST(? AS TEXT) IS NULL OR project_id = ?)`,
    [window.from, window.to, projectId, projectId],
  );
  console.log(`  PACKETS ${window.label}  (${hours.toFixed(1)}h)`);
  console.log(
    `    completed=${completed} (${rate(completed)}/h)  ` +
      done.map((row) => `${row.status}/${row.verdict ?? '-'}=${row.n}`).join(' '),
  );
  console.log(
    `    resumed rounds=${resumed.length} (${rate(resumed.length)}/h)  parked-or-reparked (last write in window)=${Number(parkedNow?.n ?? 0)}`,
  );
  for (const row of parkReasons) console.log(`      park ${String(row.n).padStart(4)}  ${row.reason}`);
  const assignments = Number(binAssignments?.n ?? 0);
  console.log(
    `    bin assignments=${assignments} fires=${Number(fires?.n ?? 0)} item leases=${Number(leases?.n ?? 0)}  ` +
      `completed packets per bin assignment=${assignments > 0 ? (completed / assignments).toFixed(3) : '—'}`,
  );

  // The audit stage, measured from the passes: synthesis → primary → adversarial → judge.
  const passes = await db.all<{
    orchestration_id: string;
    pass_key: string;
    ordinal: number;
    completed_at: string | null;
    executor_session_ref: string | null;
  }>(
    `SELECT p.orchestration_id, p.pass_key, p.ordinal, p.completed_at, p.executor_session_ref
       FROM research_passes p JOIN research_orchestrations o ON o.id = p.orchestration_id
      WHERE p.status = 'COMPLETE' AND p.completed_at >= ? AND p.completed_at < ?
        AND p.pass_key IN ('SYNTHESIS', 'AUDIT')
        AND (CAST(? AS TEXT) IS NULL OR o.project_id = ?)
      ORDER BY p.completed_at`,
    [new Date(Date.parse(window.from) - 24 * 3_600_000).toISOString(), window.to, projectId, projectId],
  );
  const gaps: Record<string, number[]> = { 'synthesis→primary': [], 'primary→adversarial': [], 'adversarial→judge': [], 'synthesis→judge': [] };
  const byPacket = new Map<string, typeof passes>();
  for (const pass of passes) {
    const list = byPacket.get(pass.orchestration_id) ?? [];
    list.push(pass);
    byPacket.set(pass.orchestration_id, list);
  }
  for (const list of byPacket.values()) {
    for (const judge of list.filter((p) => p.ordinal === 7 && p.completed_at && p.completed_at >= window.from)) {
      const before = (ordinal: number, key: string, until: string) =>
        list.filter((p) => p.ordinal === ordinal && p.pass_key === key && p.completed_at! <= until).pop();
      const adversarial = before(6, 'AUDIT', judge.completed_at!);
      const primary = adversarial ? before(5, 'AUDIT', adversarial.completed_at!) : undefined;
      const synthesis = primary ? before(4, 'SYNTHESIS', primary.completed_at!) : undefined;
      const minutes = (a?: { completed_at: string | null }, b?: { completed_at: string | null }) =>
        a?.completed_at && b?.completed_at ? (Date.parse(b.completed_at) - Date.parse(a.completed_at)) / 60_000 : null;
      const push = (key: string, value: number | null) => {
        if (value !== null) gaps[key]!.push(value);
      };
      push('synthesis→primary', minutes(synthesis, primary));
      push('primary→adversarial', minutes(primary, adversarial));
      push('adversarial→judge', minutes(adversarial, judge));
      push('synthesis→judge', minutes(synthesis, judge));
    }
  }
  const median = (values: number[]) => {
    if (values.length === 0) return '—';
    const sorted = [...values].sort((a, b) => a - b);
    return `${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)}min`;
  };
  console.log(
    `    audit stage (judged in window, n=${gaps['synthesis→judge']!.length}): ` +
      Object.entries(gaps).map(([key, values]) => `${key} p50=${median(values)}`).join('  '),
  );
  const sessions = new Set(
    passes
      .filter((p) => p.completed_at && p.completed_at >= window.from && p.executor_session_ref)
      .map((p) => p.executor_session_ref!),
  );
  console.log(`    distinct sessions that recorded a synthesis or audit pass: ${sessions.size}`);

  const refusals = await db.all<{ reason: string | null; n: number; sessions: number }>(
    `SELECT substr(reason, 1, 110) AS reason, SUM(refusals) AS n, COUNT(*) AS sessions FROM bin_session_refusals
      WHERE last_at >= ? AND last_at < ?
      GROUP BY substr(reason, 1, 110) ORDER BY SUM(refusals) DESC`,
    [window.from, window.to],
  );
  console.log(`    session refusals at assignment (by reason)`);
  for (const row of refusals.slice(0, 6)) {
    console.log(`      ${String(row.n).padStart(4)} across ${row.sessions} session(s)  ${row.reason ?? '(no reason)'}`);
  }
  const deferred = await db.all<{ outcome: string | null; n: number }>(
    `SELECT outcome, COUNT(*) AS n FROM bin_events
      WHERE event_type IN ('DISPATCH_DEFERRED', 'DISPATCH_UNROUTED') AND at >= ? AND at < ?
        AND (CAST(? AS TEXT) IS NULL OR project_id = ?)
      GROUP BY outcome ORDER BY COUNT(*) DESC`,
    [window.from, window.to, projectId, projectId],
  );
  console.log(
    `    fires withheld: ${deferred.map((row) => `${row.outcome ?? '-'}=${row.n}`).join(' ') || 'none'}`,
  );
}

/** What is waiting, now: the recoverable backlog and where its packets are. */
async function backlog(projectId: string | null): Promise<void> {
  const rows = await getDb().all<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM research_orchestrations
      WHERE status NOT IN ('COMPLETE', 'COMPLETE_WITH_GAPS', 'FAILED', 'CANCELLED')
        AND (CAST(? AS TEXT) IS NULL OR project_id = ?)
      GROUP BY status ORDER BY status`,
    [projectId, projectId],
  );
  console.log(`  LIVE PACKETS NOW  ${rows.map((row) => `${row.status}=${row.n}`).join(' ')}`);
  try {
    const { judgeParkReadings } = await import('../server/services/research/judgeRound.ts');
    const readings = await judgeParkReadings();
    const counts = new Map<string, number>();
    for (const { orchestration, assessed } of readings) {
      if (projectId && orchestration.projectId !== projectId) continue;
      counts.set(assessed.kind, (counts.get(assessed.kind) ?? 0) + 1);
    }
    console.log(`  JUDGE-PARKED NOW  ${[...counts].map(([k, n]) => `${k}=${n}`).join(' ') || 'none'}`);
  } catch (error) {
    console.log(`  JUDGE-PARKED NOW  unreadable: ${(error as Error).message}`);
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
    await packets(window, projectId);
    await leases(window, projectId);
    await tools(window, projectId);
    await endings(window, projectId);
  }
  await hourly(windows[0]!.from, windows[windows.length - 1]!.to, projectId);
  await parked(projectId);
  await backlog(projectId);
  await repeated(projectId);
  console.log('PRODUCTIVITY-REPORT: OK');
}

main()
  .catch((error) => {
    const pooler = describePoolerRefusal(error);
    console.error(`PRODUCTIVITY-REPORT: FAILED ${pooler ?? ''}`, pooler ? '' : error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());

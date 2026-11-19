/**
 * A failed execution, as an AgentRx trajectory (microsoft/AgentRx).
 *
 * Read-only. It runs inside the Brain (sent over `flyctl ssh` by
 * .github/workflows/agentrx.yml, the way the census is) and reads only rows
 * Brain already writes, through the same `getDb()` every repository uses:
 *
 *   work_items   the assigned task, its attempts and how it ended
 *   work_leases  every claim: when, by whom, until when, heartbeats, outcome
 *   bin_events   what the worker did with each claim (the free lane's
 *                FREE_LANE_ITEM: outcome, reason, duration)
 *   project_events  what Brain recorded about the item (WORK_LEASE_EXHAUSTED …)
 *   research_orchestrations / research_fragments  the packet the task served
 *
 * No new trace store: a trajectory is these rows in time order, written as the
 * markdown conversation AgentRx parses without a model call (run.py's
 * markdown path). Each turn is one row, quoted with its id, so every step a
 * diagnosis names can be traced back to the row it came from.
 *
 *   node --import tsx scripts/agentrx/export.ts --work-item wki_…
 *   node --import tsx scripts/agentrx/export.ts --packet orc_…
 *   node --import tsx scripts/agentrx/export.ts --recent 24 [--limit 3]
 *
 * Prints one line `AGENTRX_EXPORT <base64 JSON>` (the output crosses an SSH
 * session whose banner and warnings are not ours), then `AGENTRX: OK`.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';

interface Turn {
  role: 'user' | 'assistant' | 'tool';
  at: string;
  text: string;
}

export interface ExportedTrajectory {
  /** The failed task's own id: the inventory finding is keyed by it. */
  workItemId: string;
  packetId: string | null;
  workType: string;
  failureCategory: string | null;
  failedAt: string | null;
  instruction: string;
  markdown: string;
  steps: number;
}

/** Turns beyond this are dropped from the middle, never the first or the last: a diagnosis needs the task and the end. */
const MAX_TURNS = 24;
const clip = (s: string | null | undefined, n = 600): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The queue's own contract, in the words its owners state it (CLAUDE.md
 * invariants 24–26, §19, §20, server/services/queue). It is the policy a
 * trajectory is judged against; it names no cause.
 */
const QUEUE_CONTRACT =
  'Brain work-queue contract: a worker claims an item and holds a lease with an expiry; while it is still working it must renew the lease (heartbeat) before the expiry; ' +
  'a completion or failure is accepted only under the lease that is current; a lease that expires is reclaimed and the attempt counts against the item\'s maximum attempts; ' +
  'an item whose attempts are exhausted fails, and the research packet it served continues without it.';

async function rows<T>(sql: string, args: unknown[]): Promise<T[]> {
  return getDb().all<T>(sql, args as never[]);
}

async function exportWorkItem(id: string): Promise<ExportedTrajectory | null> {
  const [item] = await rows<{
    id: string; work_type: string; state: string; attempt_count: number; max_attempts: number; failure_category: string | null;
    result_summary: string | null; orchestration_id: string | null; fragment_id: string | null; created_at: string; completed_at: string | null; updated_at: string;
  }>(
    `SELECT id, work_type, state, attempt_count, max_attempts, failure_category, result_summary, orchestration_id, fragment_id, created_at, completed_at, updated_at
       FROM work_items WHERE id = ?`,
    [id],
  );
  if (!item) return null;
  const [packet] = item.orchestration_id
    ? await rows<{ id: string; title: string; status: string; verdict: string | null; failure_reason: string | null; completed_at: string | null }>(
        'SELECT id, title, status, verdict, failure_reason, completed_at FROM research_orchestrations WHERE id = ?',
        [item.orchestration_id],
      )
    : [];
  const [fragment] = item.fragment_id
    ? await rows<{ id: string; question: string; status: string; blocked_reason: string | null }>(
        'SELECT id, question, status, blocked_reason FROM research_fragments WHERE id = ?',
        [item.fragment_id],
      )
    : [];
  const leases = await rows<{
    id: string; attempt_number: number; worker_id: string; claimed_at: string; expires_at: string; last_heartbeat_at: string | null;
    heartbeat_count: number; ended_at: string | null; outcome: string | null; detail: string | null;
  }>(
    `SELECT id, attempt_number, worker_id, claimed_at, expires_at, last_heartbeat_at, heartbeat_count, ended_at, outcome, detail
       FROM work_leases WHERE work_item_id = ? ORDER BY lease_generation`,
    [id],
  );
  const worked = await rows<{ id: string; at: string; event_type: string; worker_id: string | null; outcome: string | null; reason: string | null; duration_ms: number | null }>(
    `SELECT id, at, event_type, worker_id, outcome, reason, duration_ms FROM bin_events
      WHERE work_item_id = ? ORDER BY at LIMIT 40`,
    [id],
  );
  const recorded = await rows<{ id: string; event_type: string; created_at: string; payload: string }>(
    `SELECT id, event_type, created_at, payload FROM project_events WHERE entity_id = ? ORDER BY created_at LIMIT 20`,
    [id],
  );

  const instruction =
    `Brain assigned ${item.work_type} work item ${item.id}` +
    (packet ? ` for research packet ${packet.id} ("${clip(packet.title, 160)}")` : '') +
    (fragment ? `, fragment ${fragment.id}: "${clip(fragment.question, 300)}"` : '') +
    `. At most ${item.max_attempts} attempt(s). ${QUEUE_CONTRACT}`;

  const turns: Turn[] = [{ role: 'user', at: item.created_at, text: `TASK (work_items ${item.id}, created ${item.created_at}): ${instruction}` }];
  for (const l of leases) {
    const minutes = Math.round((Date.parse(l.expires_at) - Date.parse(l.claimed_at)) / 60_000);
    turns.push({
      role: 'assistant',
      at: l.claimed_at,
      text: `work_leases ${l.id}: worker ${l.worker_id} claims attempt ${l.attempt_number} of ${item.max_attempts} at ${l.claimed_at}; the lease expires at ${l.expires_at} (${minutes} min).`,
    });
    if (l.ended_at || l.outcome) {
      turns.push({
        role: 'tool',
        at: l.ended_at ?? l.expires_at,
        text:
          `work_leases ${l.id}: lease ended at ${l.ended_at ?? '(open)'} with outcome ${l.outcome ?? '(none)'}; heartbeats recorded during it: ${l.heartbeat_count}` +
          (l.last_heartbeat_at ? ` (last ${l.last_heartbeat_at})` : '') +
          `; detail: "${clip(l.detail, 300)}".`,
      });
    }
  }
  for (const e of worked) {
    turns.push({
      role: 'assistant',
      at: e.at,
      text: `bin_events ${e.id} (${e.event_type}): worker ${e.worker_id ?? '?'} reports outcome ${e.outcome ?? '?'} after ${e.duration_ms === null ? '?' : Math.round(e.duration_ms / 1000)} s; reason: "${clip(e.reason, 400)}".`,
    });
  }
  for (const e of recorded) {
    turns.push({ role: 'tool', at: e.created_at, text: `project_events ${e.id} ${e.event_type} at ${e.created_at}: ${clip(e.payload, 500)}` });
  }
  turns.sort((a, b) => a.at.localeCompare(b.at));
  const end =
    `work_items ${item.id} final state ${item.state}` +
    (item.failure_category ? `, failure_category ${item.failure_category}` : '') +
    ` after ${item.attempt_count} of ${item.max_attempts} attempt(s); result: "${clip(item.result_summary, 300)}"` +
    (packet ? `. Packet ${packet.id} ended ${packet.status}${packet.verdict ? ` with verdict ${packet.verdict}` : ''}${packet.failure_reason ? `: ${clip(packet.failure_reason, 200)}` : ''}.` : '.');
  turns.push({ role: 'tool', at: item.completed_at ?? item.updated_at, text: end });

  const kept = turns.length <= MAX_TURNS ? turns : [...turns.slice(0, 4), ...turns.slice(turns.length - (MAX_TURNS - 4))];
  const markdown = [
    '# User Properties',
    `- **scenario_name**: ${item.id}`,
    `- **first_turn_prompt**: ${instruction.replace(/\n/g, ' ')}`,
    '',
    '# Conversation',
    ...kept.flatMap((t, i) => [`## ***${t.role}*** #${i}`, t.text, '<hr style="border:5px solid">']),
    '',
  ].join('\n');
  return {
    workItemId: item.id,
    packetId: packet?.id ?? null,
    workType: item.work_type,
    failureCategory: item.failure_category,
    failedAt: item.completed_at ?? item.updated_at,
    instruction,
    markdown,
    steps: kept.length,
  };
}

async function main(): Promise<void> {
  const argv = ['--work-item', 'wki_4ccc60295fa04155b98d'];
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const ID = /^[A-Za-z0-9_-]{1,64}$/;
  await initDatabase();
  const out: ExportedTrajectory[] = [];
  try {
    const one = flag('--work-item');
    const packet = flag('--packet');
    const recent = flag('--recent');
    const limit = Math.max(1, Math.min(10, Number(flag('--limit') ?? 3) || 3));
    let ids: string[] = [];
    if (one && ID.test(one)) ids = [one];
    else if (packet && ID.test(packet)) {
      ids = (await rows<{ id: string }>(`SELECT id FROM work_items WHERE orchestration_id = ? AND state = 'FAILED' ORDER BY updated_at DESC`, [packet])).map((r) => r.id).slice(0, limit);
    } else if (recent) {
      const hours = Math.max(1, Math.min(168, Number(recent) || 24));
      const since = new Date(Date.now() - hours * 3_600_000).toISOString();
      // One failed item per packet, newest first: a packet's failures usually share a cause.
      const failed = await rows<{ id: string; orchestration_id: string | null }>(
        `SELECT id, orchestration_id FROM work_items WHERE state = 'FAILED' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 200`,
        [since],
      );
      const seen = new Set<string>();
      for (const f of failed) {
        const key = f.orchestration_id ?? f.id;
        if (seen.has(key)) continue;
        seen.add(key);
        ids.push(f.id);
        if (ids.length >= limit) break;
      }
    }
    for (const id of ids) {
      const t = await exportWorkItem(id);
      if (t) out.push(t);
    }
    console.log(`AGENTRX_EXPORT ${Buffer.from(JSON.stringify(out)).toString('base64')}`);
    console.log(`exported ${out.length} trajectory(ies): ${out.map((t) => `${t.workItemId} (${t.steps} steps)`).join(', ')}`);
  } finally {
    await closeDatabase();
    console.log('AGENTRX: OK'); console.log('GOALS: OK');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

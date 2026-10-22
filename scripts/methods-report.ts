/**
 * `methods-report` — what the methods research goal has established so far.
 *
 * Read-only. For every research goal in the Brain architecture project, prints
 * each question (fragment key), its latest status, and every accepted claim
 * with its source — the claims that reach every research worker as method
 * rules (`server/services/research/methodRules.ts`). Rejected claims are
 * counted, never printed as findings.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { ARCHITECTURE_SLUG } from '../server/services/capability/ingest.ts';

interface Row {
  goal_name: string;
  orchestration_id: string;
  orchestration_status: string;
  fragment_key: string | null;
  question: string | null;
  fragment_status: string | null;
  claim: string;
  source_url: string | null;
  accepted: number;
  rejection_reason: string | null;
  scope_match: string | null;
  blocked_reason: string | null;
  block_cause: string | null;
}

async function main(): Promise<void> {
  await initDatabase();
  try {
    const rows = await getDb().all<Row>(
      `SELECT g.name AS goal_name, o.id AS orchestration_id, o.status AS orchestration_status,
              f.fragment_key, f.question, f.status AS fragment_status,
              c.claim, c.source_url, c.accepted, c.rejection_reason, c.scope_match,
              f.blocked_reason, f.block_cause
         FROM russell_goals g
         JOIN projects p ON p.id = g.project_id
         JOIN research_orchestrations o ON o.goal_id = g.id
         JOIN research_claims c ON c.orchestration_id = o.id
         LEFT JOIN research_fragments f ON f.id = c.fragment_id
        WHERE p.slug = ? AND g.purpose = 'RESEARCH_GOAL'
        ORDER BY o.created_at, f.fragment_key, c.created_at`,
      [ARCHITECTURE_SLUG],
    );
    const byKey = new Map<string, { question: string; status: string; accepted: Row[]; rejected: number; reasons: Map<string, number>; blocked: string | null }>();
    const packets = new Map<string, string>();
    for (const row of rows) {
      packets.set(row.orchestration_id, `${row.goal_name} · ${row.orchestration_status}`);
      const key = row.fragment_key ?? '(packet-level)';
      const entry = byKey.get(key) ?? { question: row.question ?? '', status: row.fragment_status ?? '', accepted: [], rejected: 0, reasons: new Map<string, number>(), blocked: null };
      if (row.question) entry.question = row.question;
      if (row.fragment_status) entry.status = row.fragment_status;
      if (row.accepted) entry.accepted.push(row);
      else {
        entry.rejected += 1;
        const reason = `${row.rejection_reason ?? 'no reason recorded'}${row.scope_match ? ` | scope ${row.scope_match}` : ''}`.slice(0, 300);
        entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + 1);
      }
      if (row.blocked_reason) entry.blocked = `${row.block_cause ?? ''} ${row.blocked_reason}`.slice(0, 400);
      byKey.set(key, entry);
    }
    for (const [id, label] of packets) console.log(`PACKET ${id} ${label}`);
    let total = 0;
    for (const [key, entry] of byKey) {
      console.log('');
      console.log(`[${key}] ${entry.status} — ${entry.question}`);
      console.log(`  accepted ${entry.accepted.length}, rejected ${entry.rejected}`);
      if (entry.blocked) console.log(`  blocked: ${entry.blocked}`);
      for (const [reason, n] of entry.reasons) console.log(`  rejected x${n}: ${reason}`);
      for (const row of entry.accepted) {
        total += 1;
        console.log(`  - ${row.claim}${row.source_url ? ` (${row.source_url})` : ''}`);
      }
    }
    console.log('');
    console.log(`ACCEPTED CLAIMS ${total}`);
    console.log('METHODS-REPORT: OK');
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  console.error('METHODS-REPORT: FAILED', error instanceof Error ? error.message : error);
  process.exit(1);
});

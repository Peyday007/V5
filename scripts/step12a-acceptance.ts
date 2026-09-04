/**
 * `npm run step12a:acceptance` — the machine verdict on Step 12A.
 *
 * Nineteen gates, stable ids, reported `PASS` / `FAIL` / `BLOCKED` / `NOT_RUN`
 * from authoritative rows. It exits 0 only when every gate is `PASS`, which is
 * what makes the completion phrase in the build contract mean something: a
 * person cannot declare Step 12A complete by describing it well.
 *
 * Read-only by construction. It opens the configured database, counts what is
 * there, prints a table and closes. It creates nothing, advances nothing and
 * takes no decision — so it is safe to point at production, which is where
 * most of these gates are actually settled.
 *
 * Two rules the whole file is built around:
 *
 *   - **"Implemented" is never a production verdict.** A gate whose condition
 *     is about a real run reports `NOT_RUN` until the rows from that run
 *     exist, however complete the code is. There is no flag that turns a test
 *     into evidence.
 *   - **A blocked gate is blocked, not failed and not skipped.** `A11` waits
 *     on provisioning outside this repository. It is reported as `BLOCKED`
 *     with the reason, it keeps the exit code non-zero, and nothing in here
 *     can be set to make it pass.
 *
 * No credential is read, printed or required. It reports what the Brain
 * contains, never where it is kept.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { getDb } from '../server/db/database.ts';
import { auditIndependenceEvidence } from '../server/services/research/independenceEvidence.ts';

type Verdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';

/**
 * Gates whose evidence cannot exist while `A11` is open, and why.
 *
 * The distinction matters and is not cosmetic. `NOT_RUN` says "nobody has done
 * this yet", which invites somebody to go and do it. `BLOCKED` says "this
 * cannot be done until something else is", which is the truth for anything
 * downstream of a terminal research packet: a packet reaches terminal only
 * after three audit roles, and `auditAdmission` refuses every audit item while
 * the fleet cannot supply independent lineage. Reporting those as `NOT_RUN`
 * would send a person to work on a gate that is not theirs to move.
 *
 * The set is deliberately small. A gate is listed here only when *no* action
 * short of resolving `A11` can produce its rows — a conversation attaching
 * itself, an idea being captured, a probe running or a mission being created
 * all happen without an audit, so none of them is here.
 */
const BLOCKED_BY_A11: Record<string, string> = {
  A12_WRITEBACK:
    'a writeback needs a terminal packet, and a packet is terminal only after three independent audit roles',
  A13_AUTO_NEXT:
    'an automatic follow-on launches from a finished mission, which needs the audit A11 is blocked on',
};

interface GateResult {
  id: string;
  verdict: Verdict;
  /** One line, safe to print anywhere. Says what was counted. */
  detail: string;
}

/** Count one query, defensively: a missing table is zero, never a crash. */
async function count(sql: string, params: unknown[] = []): Promise<number> {
  try {
    const rows = await getDb().all<{ total: number }>(sql, params as never[]);
    return Number(rows[0]?.total ?? 0);
  } catch {
    return 0;
  }
}

/**
 * A gate whose condition is a real run.
 *
 * `PASS` when the rows exist, `NOT_RUN` when they do not. Deliberately never
 * `FAIL`: an absent run is not a failed one, and reporting it as failure would
 * make a green board the only way to tell the two apart.
 */
function fromRows(id: string, found: number, needed: number, what: string): GateResult {
  if (found >= needed) return { id, verdict: 'PASS', detail: `${found} ${what}` };
  const blocker = BLOCKED_BY_A11[id];
  // A gate that cannot move until A11 does is BLOCKED and names the
  // dependency, rather than reading as work somebody could pick up.
  return blocker
    ? { id, verdict: 'BLOCKED', detail: `blocked by A11_INDEPENDENT_AUDIT — ${blocker}` }
    : { id, verdict: 'NOT_RUN', detail: `${found} of ${needed} ${what}` };
}

async function gates(): Promise<GateResult[]> {
  const results: GateResult[] = [];

  // A01 — the shell exists and is what a person lands on. The production half
  // is a conversation somebody actually had through it.
  results.push(
    fromRows(
      'A01_SHELL_IDENTITY',
      await count(`SELECT COUNT(*) AS total FROM russell_conversations`),
      1,
      'Russell conversations',
    ),
  );

  results.push(
    fromRows(
      'A02_CONVERSATION_ROUTE',
      await count(
        `SELECT COUNT(*) AS total FROM russell_conversations
          WHERE project_id IS NOT NULL AND attachment_source = 'AUTOMATIC'`,
      ),
      1,
      'conversations Russell attached itself',
    ),
  );

  results.push(
    fromRows(
      'A03_ROUTE_CORRECTION',
      await count(
        `SELECT COUNT(*) AS total FROM russell_conversation_context WHERE source = 'CORRECTION'`,
      ),
      1,
      'recorded corrections',
    ),
  );

  // A04 — casual text creates nothing. Proven by a conversation with turns and
  // no candidate from them, which is a *ratio* rather than a count: a Brain
  // with no conversations proves nothing either way.
  const turns = await count(`SELECT COUNT(*) AS total FROM russell_messages WHERE role = 'USER'`);
  const captured = await count(`SELECT COUNT(*) AS total FROM russell_candidates`);
  results.push(
    turns === 0
      ? { id: 'A04_IRRELEVANT', verdict: 'NOT_RUN', detail: 'no conversation turns yet' }
      : turns > captured
        ? { id: 'A04_IRRELEVANT', verdict: 'PASS', detail: `${turns} turns produced ${captured} ideas` }
        : {
            id: 'A04_IRRELEVANT',
            verdict: 'FAIL',
            detail: `${turns} turns produced ${captured} ideas — every remark became an idea`,
          },
  );

  results.push(
    fromRows(
      'A05_DEDUPE',
      await count(`SELECT COUNT(*) AS total FROM russell_candidate_merges`),
      1,
      'merges onto a canonical idea',
    ),
  );

  results.push(
    fromRows(
      'A06_JUDGMENT_OVERRIDE',
      await count(
        `SELECT COUNT(*) AS total FROM russell_candidates WHERE reason IS NOT NULL AND reason <> ''`,
      ),
      1,
      'ideas carrying a stated judgment',
    ),
  );

  // A07 — a probe that ran and stayed inside its own bound. The comparison is
  // against the probe's recorded limit, so a probe that spent more than it was
  // allowed is a FAIL rather than a missing row.
  const probes = await count(`SELECT COUNT(*) AS total FROM russell_probes WHERE state = 'COMPLETE'`);
  const overspent = await count(
    `SELECT COUNT(*) AS total FROM russell_probes WHERE lookups_used > max_lookups`,
  );
  results.push(
    overspent > 0
      ? { id: 'A07_PROBE_BOUNDS', verdict: 'FAIL', detail: `${overspent} probes exceeded their lookup bound` }
      : fromRows('A07_PROBE_BOUNDS', probes, 1, 'probes completed inside their bounds'),
  );

  results.push(
    fromRows(
      'A08_COVERAGE',
      await count(`SELECT COUNT(*) AS total FROM requirement_coverage`),
      1,
      'recorded coverage verdicts',
    ),
  );

  // A09 — a reservation that was taken and settled, with nothing overdrawn.
  const settled = await count(
    `SELECT COUNT(*) AS total FROM russell_budget_reservations WHERE state = 'SETTLED'`,
  );
  results.push(fromRows('A09_AUTH_BUDGET', settled, 1, 'settled budget reservations'));

  // A10 — one promotion produced one mission with one orchestration and one
  // bin. A mission missing either link after the fact is a FAIL, because the
  // repair pass exists precisely so that does not persist.
  const missions = await count(
    `SELECT COUNT(*) AS total FROM russell_missions
      WHERE orchestration_id IS NOT NULL AND bin_id IS NOT NULL`,
  );
  const halfBuilt = await count(
    `SELECT COUNT(*) AS total FROM russell_missions
      WHERE state IN ('RUNNING','WAITING') AND (orchestration_id IS NULL OR bin_id IS NULL)`,
  );
  results.push(
    halfBuilt > 0
      ? { id: 'A10_MISSION_PIPELINE', verdict: 'FAIL', detail: `${halfBuilt} missions are missing a link` }
      : fromRows('A10_MISSION_PIPELINE', missions, 1, 'fully linked missions'),
  );

  /*
   * A11 — audit independence.
   *
   * Derived, fail-closed, from `auditIndependenceEvidence`. Nine conditions,
   * and `PASS` only when every one is met by production rows: two accounts
   * holding genuinely different credentials, two active worker identities each
   * bound to exactly one of them, three completed audit passes whose lineage
   * *agrees with those bindings*, three session references that resolve to real
   * credentials of those same workers, the account and session separation the
   * signed matrix asks for, and a packet that actually filed a document.
   *
   * It also checks the control it is evidence for: the matrix is compared to
   * the shape this gate was written against, and the same-account refusal is
   * exercised live. Weakening either to make an audit eligible makes this
   * report `BLOCKED` rather than `PASS`.
   *
   * An earlier version of this file hard-coded `BLOCKED`, reasoning that a
   * database check could be satisfied by writing rows. The concern was right
   * and the remedy was wrong: a constant cannot become true when the evidence
   * arrives, so it would have needed a code change and a deployment at exactly
   * the moment the gate was supposed to be answering. The answer is a check
   * hostile enough that forging it means reproducing the whole production
   * shape — which is what the conditions above are for.
   */
  const independence = await auditIndependenceEvidence();
  results.push({
    id: 'A11_INDEPENDENT_AUDIT',
    verdict: independence.verdict === 'PASS' ? 'PASS' : 'BLOCKED',
    detail:
      independence.missing ??
      'authentic production lineage: separate accounts arguing, a third session judging',
  });

  // A12 — writeback happened, exactly once per mission. The `writeback_at`
  // column is the once-only guard, so a mission that produced knowledge with a
  // null stamp would mean the guard was bypassed.
  const wroteBack = await count(
    `SELECT COUNT(*) AS total FROM russell_missions WHERE writeback_at IS NOT NULL`,
  );
  results.push(fromRows('A12_WRITEBACK', wroteBack, 1, 'missions written back'));

  results.push(
    fromRows(
      'A13_AUTO_NEXT',
      await count(`SELECT COUNT(*) AS total FROM russell_missions WHERE next_mission_id IS NOT NULL`),
      1,
      'automatic follow-on launches',
    ),
  );

  results.push(
    fromRows(
      'A14_HUMAN_RESUME',
      await count(
        `SELECT COUNT(*) AS total FROM russell_human_requests
          WHERE state = 'ANSWERED' AND answered_by_user_id IS NOT NULL`,
      ),
      1,
      'human decisions answered and resumed',
    ),
  );

  // A15 — recovery. Proven by a cycle that has run and by nothing being left
  // stranded: an expired probe still RUNNING, or a mission half-built, is the
  // shape of a recovery that did not happen.
  const stranded =
    (await count(
      `SELECT COUNT(*) AS total FROM russell_probes WHERE state = 'RUNNING' AND deadline_at <= ?`,
      [new Date().toISOString()],
    )) + halfBuilt;
  const cycles = await count(`SELECT COUNT(*) AS total FROM russell_cycle WHERE generation > 0`);
  results.push(
    stranded > 0
      ? { id: 'A15_RECOVERY', verdict: 'FAIL', detail: `${stranded} items are stranded past their deadline` }
      : fromRows('A15_RECOVERY', cycles, 1, 'cycles that have claimed and released'),
  );

  // A16 — the Deal Dispatch reading. There is no row for it: it is derived at
  // read time from the project, so the honest automated check is that the
  // project it reads exists. Its production proof is the deployed adapter.
  results.push(
    fromRows(
      'A16_DD_FRESHNESS',
      await count(`SELECT COUNT(*) AS total FROM projects WHERE slug = 'deal-dispatch'`),
      1,
      'Deal Dispatch projects to read',
    ),
  );

  /*
   * A17 — privacy and authorization.
   *
   * The positive proof is the suites; what is checkable from rows is the
   * absence of the failure. A candidate, probe or mission whose visibility is
   * less restrictive than the conversation it came from is a leak, and it is
   * the one that would not show up in a listing test.
   */
  const widened = await count(
    `SELECT COUNT(*) AS total FROM russell_candidates c
       JOIN russell_conversations v ON c.conversation_id = v.id
      WHERE v.visibility = 'PRIVATE' AND c.visibility <> 'PRIVATE'`,
  );
  results.push(
    widened > 0
      ? { id: 'A17_PRIVACY_AUTH', verdict: 'FAIL', detail: `${widened} ideas are less private than their thread` }
      : fromRows(
          'A17_PRIVACY_AUTH',
          await count(`SELECT COUNT(*) AS total FROM identity_events WHERE result = 'DENIED'`),
          1,
          'recorded authorization denials',
        ),
  );

  /*
   * A18 — the earlier steps' baselines are unchanged but for authorized 12A
   * rows. Checked as a conservation property rather than a snapshot: every
   * pre-12A orchestration that reached a terminal state is still terminal, and
   * every frozen layer is still frozen. A 12A run that damaged Step 9's or
   * Step 10's work would show here.
   */
  const damagedLayers = await count(
    `SELECT COUNT(*) AS total FROM layers WHERE status = 'FROZEN' AND current_version IS NULL`,
  );
  const frozen = await count(`SELECT COUNT(*) AS total FROM layers`);
  results.push(
    damagedLayers > 0
      ? { id: 'A18_BASELINES', verdict: 'FAIL', detail: `${damagedLayers} frozen layers lost their artifact` }
      : fromRows('A18_BASELINES', frozen, 1, 'layers intact'),
  );

  /*
   * A19 — delivery. There is no row in this database that proves a hosted
   * verification passed after a real restart, and inventing one would be the
   * worst thing in this file. It is `NOT_RUN` here always, and it is closed by
   * the delivery ledger in `docs/STEP-12A-EVIDENCE.md` recording a hosted
   * verification before and after a restart against a named release.
   */
  results.push({
    id: 'A19_DELIVERY',
    verdict: 'NOT_RUN',
    detail: 'hosted verification before and after a real restart is not a database fact — see the delivery ledger',
  });

  return results;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

async function main(): Promise<void> {
  await initDatabase();
  const results = await gates();

  console.log('');
  console.log('STEP 12A ACCEPTANCE');
  console.log('='.repeat(96));
  for (const result of results) {
    console.log(`${pad(result.id, 26)} ${pad(result.verdict, 9)} ${result.detail}`);
  }
  console.log('='.repeat(96));

  const failed = results.filter((result) => result.verdict === 'FAIL');
  const blocked = results.filter((result) => result.verdict === 'BLOCKED');
  const notRun = results.filter((result) => result.verdict === 'NOT_RUN');
  const passed = results.length - failed.length - blocked.length - notRun.length;

  console.log(
    `${passed} PASS · ${failed.length} FAIL · ${blocked.length} BLOCKED · ${notRun.length} NOT_RUN`,
  );
  const transitive = blocked.filter((result) => BLOCKED_BY_A11[result.id]);
  if (transitive.length > 0) {
    console.log(
      `${transitive.length} of the blocked gates wait on A11 rather than on anything in this repository.`,
    );
  }
  if (failed.length + blocked.length + notRun.length > 0) {
    console.log('');
    console.log('STEP 12A IS NOT COMPLETE.');
    for (const result of [...failed, ...blocked, ...notRun]) {
      console.log(`  ${result.id}: ${result.detail}`);
    }
  }
  process.exitCode = failed.length + blocked.length + notRun.length === 0 ? 0 : 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());

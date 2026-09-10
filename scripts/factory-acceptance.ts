/**
 * `npm run factory:acceptance` — the machine verdict on Software Factory 0.
 *
 * Twenty-four gates, stable ids, read from authoritative rows and reported
 * `PASS` / `FAIL` / `BLOCKED` / `NOT_RUN`. It exits 0 only when every gate is
 * `PASS`, which is what stops "the factory is complete" from being a sentence
 * somebody wrote well.
 *
 * Read-only by construction: it opens the configured database, counts what is
 * there, prints a table and closes. It creates nothing and decides nothing, so
 * it is safe to point at production — which is where most of these are settled.
 *
 * Two rules the whole file is built on, both inherited from
 * `step12a-acceptance.ts` because they were right there:
 *
 *   - **"Implemented" is never a production verdict.** A gate whose condition is
 *     about a real run reports `NOT_RUN` until the rows from that run exist,
 *     however complete the code is. There is no flag that turns a test into
 *     evidence.
 *   - **A blocked gate is blocked, not failed and not skipped.** A condition that
 *     could not be met because a capability was absent says which capability, so
 *     a reader is not sent to work on a gate that is not theirs to move.
 *
 * No credential is read or printed. It reports what the Brain contains, never
 * where it is kept.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { campaignMetrics } from '../server/services/factory/metrics.ts';
import { pathsOverlap } from '../server/repos/factory.ts';

type Verdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';

interface GateResult {
  id: string;
  verdict: Verdict;
  detail: string;
}

/** Count one query defensively: a missing table is zero, never a crash. */
async function count(sql: string, params: unknown[] = []): Promise<number> {
  try {
    const found = await getDb().all<{ total: number }>(sql, params as never[]);
    return Number(found[0]?.total ?? 0);
  } catch {
    return 0;
  }
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  try {
    return await getDb().all<T>(sql, params as never[]);
  } catch {
    return [];
  }
}

function fromRows(id: string, found: number, needed: number, what: string): GateResult {
  if (found >= needed) return { id, verdict: 'PASS', detail: `${found} ${what}` };
  return { id, verdict: 'NOT_RUN', detail: `${found} of ${needed} ${what}` };
}

/**
 * The campaign these gates are about.
 *
 * The newest campaign in the Brain, because that is the one somebody just ran.
 * Named in the output so a reader knows which rows were counted rather than
 * assuming the script found the one they meant.
 */
async function subjectCampaign(): Promise<{ id: string; changeRequestId: string } | null> {
  /*
   * Named, or the newest.
   *
   * The default was "newest" alone, and it was wrong the first time a second
   * campaign existed: a one-unit recovery drill became the subject and every
   * gate about review, repair and the artifact read NOT_RUN — a true statement
   * about the drill and a misleading one about the factory. A reporter that can
   * silently change what it is reporting on has to be told.
   */
  const flagIndex = process.argv.indexOf('--campaign');
  const named = flagIndex === -1 ? undefined : process.argv[flagIndex + 1];
  const found = named
    ? await rows<{ id: string; change_request_id: string }>(
        `SELECT id, change_request_id FROM factory_campaigns WHERE id = ?`,
        [named],
      )
    : await rows<{ id: string; change_request_id: string }>(
        `SELECT id, change_request_id FROM factory_campaigns ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      );
  const first = found[0];
  return first ? { id: first.id, changeRequestId: first.change_request_id } : null;
}

export async function gates(): Promise<GateResult[]> {
  const results: GateResult[] = [];
  const campaign = await subjectCampaign();

  if (!campaign) {
    return [
      {
        id: 'F01_ONE_CAMPAIGN',
        verdict: 'NOT_RUN',
        detail: 'No campaign exists in this Brain, so nothing downstream can be judged.',
      },
    ];
  }
  const c = campaign.id;
  const metrics = await campaignMetrics(c);

  /* --------------------------------------------------------------------- */
  /* The contract                                                          */
  /* --------------------------------------------------------------------- */

  // 1. One approved ChangeRequest creates one campaign.
  const approvedWithCampaigns = await rows<{ change_request_id: string; campaigns: number }>(
    `SELECT cr.id AS change_request_id, COUNT(cp.id) AS campaigns
       FROM factory_change_requests cr
       LEFT JOIN factory_campaigns cp ON cp.change_request_id = cr.id
      WHERE cr.state = 'APPROVED'
      GROUP BY cr.id`,
  );
  const forked = approvedWithCampaigns.filter((row) => Number(row.campaigns) > 1);
  results.push(
    forked.length > 0
      ? {
          id: 'F01_ONE_CAMPAIGN',
          verdict: 'FAIL',
          detail: `${forked.length} approved change request(s) have more than one campaign`,
        }
      : fromRows(
          'F01_ONE_CAMPAIGN',
          approvedWithCampaigns.filter((row) => Number(row.campaigns) === 1).length,
          1,
          'approved change request(s) with exactly one campaign',
        ),
  );

  // 2. A duplicate submission creates no second logical campaign.
  const deduped = await count(
    `SELECT COUNT(*) AS total FROM factory_events WHERE kind = 'CHANGE_REQUEST_DEDUPED'`,
  );
  const byKey = await rows<{ submission_key: string; total: number }>(
    `SELECT submission_key, COUNT(*) AS total FROM factory_change_requests
      GROUP BY project_id, submission_key`,
  );
  const duplicatedKeys = byKey.filter((row) => Number(row.total) > 1);
  results.push(
    duplicatedKeys.length > 0
      ? {
          id: 'F02_DEDUPED',
          verdict: 'FAIL',
          detail: `${duplicatedKeys.length} submission key(s) produced more than one change request`,
        }
      : fromRows('F02_DEDUPED', deduped, 1, 'duplicate submission(s) collided on the existing row'),
  );

  // 3. The repository base SHA is pinned.
  const pinned = await rows<{ base_sha: string; cr_base: string }>(
    `SELECT cp.base_sha AS base_sha, cr.base_sha AS cr_base
       FROM factory_campaigns cp JOIN factory_change_requests cr ON cr.id = cp.change_request_id
      WHERE cp.id = ?`,
    [c],
  );
  const pin = pinned[0];
  results.push(
    pin && /^[0-9a-f]{40}$/.test(pin.base_sha) && pin.base_sha === pin.cr_base
      ? { id: 'F03_BASE_PINNED', verdict: 'PASS', detail: `pinned at ${pin.base_sha.slice(0, 12)}` }
      : {
          id: 'F03_BASE_PINNED',
          verdict: 'FAIL',
          detail: `campaign base ${pin?.base_sha ?? '(none)'} does not match the contract's pin`,
        },
  );

  // 4. Acceptance conditions exist before implementation begins.
  const contract = await rows<{ approved_at: string | null; acceptance_conditions: string }>(
    `SELECT approved_at, acceptance_conditions FROM factory_change_requests WHERE id = ?`,
    [campaign.changeRequestId],
  );
  let conditions: unknown[] = [];
  try {
    conditions = JSON.parse(contract[0]?.acceptance_conditions ?? '[]') as unknown[];
  } catch {
    conditions = [];
  }
  const firstPlan = await rows<{ at: string }>(
    `SELECT at FROM factory_events WHERE campaign_id = ? AND kind = 'UNIT_PLANNED' ORDER BY at LIMIT 1`,
    [c],
  );
  const approvedAt = contract[0]?.approved_at;
  results.push(
    conditions.length > 0 && approvedAt && (!firstPlan[0] || approvedAt <= firstPlan[0].at)
      ? {
          id: 'F04_CONDITIONS_FIRST',
          verdict: 'PASS',
          detail: `${conditions.length} condition(s) approved at ${approvedAt}, before the first unit was planned`,
        }
      : {
          id: 'F04_CONDITIONS_FIRST',
          verdict: conditions.length === 0 ? 'FAIL' : 'NOT_RUN',
          detail:
            conditions.length === 0
              ? 'the contract has no acceptance conditions'
              : 'no unit has been planned yet',
        },
  );

  /* --------------------------------------------------------------------- */
  /* Planning and parallelism                                              */
  /* --------------------------------------------------------------------- */

  // 5. The planner creates a real dependency graph.
  const unitCount = await count(
    `SELECT COUNT(*) AS total FROM factory_work_units WHERE campaign_id = ?`,
    [c],
  );
  const edgeCount = await count(
    `SELECT COUNT(*) AS total FROM factory_unit_dependencies WHERE campaign_id = ?`,
    [c],
  );
  results.push(
    unitCount >= 2 && edgeCount >= 1
      ? {
          id: 'F05_DEPENDENCY_GRAPH',
          verdict: 'PASS',
          detail: `${unitCount} unit(s), ${edgeCount} declared dependency edge(s)`,
        }
      : fromRows(
          'F05_DEPENDENCY_GRAPH',
          edgeCount,
          1,
          `dependency edge(s) across ${unitCount} unit(s)`,
        ),
  );

  // 6. At least three genuinely independent units execute concurrently when
  //    capacity permits. Concurrency is the measured overlap, never the declared
  //    sum — so a fleet that could not supply three slots is reported as a
  //    capacity fact rather than as a factory failure.
  const slots = await count(
    `SELECT COALESCE(SUM(max_concurrency), 0) AS total FROM factory_workers
      WHERE availability = 'AVAILABLE'`,
  );
  if (metrics.maxObservedConcurrency >= 3) {
    results.push({
      id: 'F06_THREE_CONCURRENT',
      verdict: 'PASS',
      detail: `${metrics.maxObservedConcurrency} sessions overlapped (${metrics.concurrencyEvidence})`,
    });
  } else if (slots < 3) {
    results.push({
      id: 'F06_THREE_CONCURRENT',
      verdict: 'BLOCKED',
      detail:
        `only ${slots} slot(s) are registered and available, so three lanes were never possible; ` +
        `the measured maximum was ${metrics.maxObservedConcurrency}`,
    });
  } else {
    results.push({
      id: 'F06_THREE_CONCURRENT',
      verdict: 'NOT_RUN',
      detail: `${slots} slot(s) available; measured maximum overlap was ${metrics.maxObservedConcurrency}`,
    });
  }

  // 7. Conflicting work is serialised or given explicit ownership.
  const overlapRefusals = await count(
    `SELECT COUNT(*) AS total FROM factory_events
      WHERE campaign_id = ? AND kind = 'UNIT_REFUSED' AND detail LIKE '%overlap%'`,
    [c],
  );
  const leasedUnits = await rows<{ id: string; owned_paths: string }>(
    `SELECT id, owned_paths FROM factory_work_units WHERE campaign_id = ? AND state = 'LEASED'`,
    [c],
  );
  let liveOverlap = false;
  for (let i = 0; i < leasedUnits.length; i += 1) {
    for (let j = i + 1; j < leasedUnits.length; j += 1) {
      let left: string[] = [];
      let right: string[] = [];
      try {
        left = JSON.parse(leasedUnits[i]?.owned_paths ?? '[]') as string[];
        right = JSON.parse(leasedUnits[j]?.owned_paths ?? '[]') as string[];
      } catch {
        continue;
      }
      if (pathsOverlap(left, right)) liveOverlap = true;
    }
  }
  results.push(
    liveOverlap
      ? {
          id: 'F07_NO_OVERLAP',
          verdict: 'FAIL',
          detail: 'two units hold live leases on overlapping mutation surfaces',
        }
      : {
          id: 'F07_NO_OVERLAP',
          verdict: 'PASS',
          detail:
            `no two live leases overlap; ${overlapRefusals} assignment(s) were refused for ` +
            'overlapping ownership and serialised instead',
        },
  );

  // 8. Every worker operates in its own worktree.
  const worktrees = await rows<{ worktree_path: string | null; total: number }>(
    `SELECT worktree_path, COUNT(*) AS total FROM factory_work_units
      WHERE campaign_id = ? AND worktree_path IS NOT NULL GROUP BY worktree_path`,
    [c],
  );
  const shared = worktrees.filter((row) => Number(row.total) > 1);
  results.push(
    shared.length > 0
      ? {
          id: 'F08_OWN_WORKTREE',
          verdict: 'FAIL',
          detail: `${shared.length} worktree path(s) are shared by more than one unit`,
        }
      : fromRows('F08_OWN_WORKTREE', worktrees.length, 1, 'unit(s) ran in a worktree of their own'),
  );

  /* --------------------------------------------------------------------- */
  /* Recovery and backpressure                                             */
  /* --------------------------------------------------------------------- */

  /*
   * 9. Worker death allows another worker to resume from the durable checkpoint.
   *
   * Two facts, counted across the Brain rather than conjoined on a single unit.
   * A worker killed mid-attempt writes no report, so it leaves no checkpoint —
   * which means "a checkpoint written before a takeover *of the same unit*" can
   * only happen when a completed attempt is later rejected and the retry is then
   * interrupted, and requiring that coincidence would report a capability the
   * factory has as one it lacks. So:
   *
   *   * a takeover exists — a lease outlived its dispatcher and a different
   *     worker claimed the work rather than it being stranded; and
   *   * a checkpoint was handed to a resumed attempt — a unit was re-attempted
   *     while a checkpoint of an earlier attempt existed, which is what
   *     `compileImplementationAssignment` carries forward.
   *
   * Both are read from rows; neither is inferred from the other.
   */
  const takeovers = await rows<{ campaign_id: string | null }>(
    `SELECT campaign_id FROM factory_events WHERE kind = 'UNIT_TAKEOVER'`,
  );
  const resumedWithCheckpoint = await count(
    `SELECT COUNT(*) AS total FROM factory_checkpoints ck
      WHERE EXISTS (SELECT 1 FROM factory_work_units u
                     WHERE u.id = ck.unit_id AND u.attempt > ck.attempt)`,
  );
  results.push(
    takeovers.length > 0 && resumedWithCheckpoint > 0
      ? {
          id: 'F09_RESUME_FROM_CHECKPOINT',
          verdict: 'PASS',
          detail:
            `${takeovers.length} takeover(s) of an expired lease, and ${resumedWithCheckpoint} ` +
            'checkpoint(s) carried into a later attempt of the same unit',
        }
      : {
          id: 'F09_RESUME_FROM_CHECKPOINT',
          verdict: 'NOT_RUN',
          detail:
            `${takeovers.length} takeover(s); ${resumedWithCheckpoint} checkpoint(s) carried into ` +
            'a later attempt',
        },
  );

  /*
   * 10. Rate limiting defers work without consuming a false failure.
   *
   * Counted across the Brain rather than one campaign, because a refusal lands
   * wherever the provider happens to refuse — and what has to be true of it is
   * the same everywhere: the session says RATE_LIMITED, no unit attempt was
   * charged for it, and no worker was walked toward quarantine by it. The
   * failure streak is the strict half: a refusal recorded as a failure is
   * exactly the "false failure" this condition is about.
   */
  const refusedSessions = await rows<{ id: string; unit_id: string | null; worker_id: string }>(
    `SELECT id, unit_id, worker_id FROM factory_sessions WHERE state = 'RATE_LIMITED'`,
  );
  const chargedAttempts = await count(
    `SELECT COUNT(*) AS total FROM factory_events
      WHERE kind = 'SESSION_RATE_LIMITED' AND detail LIKE '%"attemptCharged":true%'`,
  );
  const quarantinedByRefusal = await count(
    `SELECT COUNT(*) AS total FROM factory_workers w
      WHERE w.availability = 'QUARANTINED'
        AND EXISTS (SELECT 1 FROM factory_sessions s
                     WHERE s.worker_id = w.id AND s.state = 'RATE_LIMITED')
        AND NOT EXISTS (SELECT 1 FROM factory_sessions s
                         WHERE s.worker_id = w.id AND s.state = 'FAILED')`,
  );
  results.push(
    refusedSessions.length === 0
      ? {
          id: 'F10_RATE_LIMIT_DEFERS',
          verdict: 'NOT_RUN',
          detail: 'no provider refusal has occurred, so nothing has been deferred',
        }
      : chargedAttempts === 0 && quarantinedByRefusal === 0
        ? {
            id: 'F10_RATE_LIMIT_DEFERS',
            verdict: 'PASS',
            detail:
              `${refusedSessions.length} provider refusal(s) recorded; no unit attempt charged ` +
              'and no worker quarantined for being refused',
          }
        : {
            id: 'F10_RATE_LIMIT_DEFERS',
            verdict: 'FAIL',
            detail:
              `${chargedAttempts} refusal(s) charged an attempt and ${quarantinedByRefusal} ` +
              'worker(s) were quarantined for being refused',
          },
  );

  /* --------------------------------------------------------------------- */
  /* Integration                                                           */
  /* --------------------------------------------------------------------- */

  // 11. Completed work is integrated continuously, not in one batch at the end.
  const firstMerge = await rows<{ at: string }>(
    `SELECT at FROM factory_events WHERE campaign_id = ? AND kind = 'INTEGRATION_MERGED'
      ORDER BY at LIMIT 1`,
    [c],
  );
  const lastImplemented = await rows<{ at: string }>(
    `SELECT at FROM factory_events WHERE campaign_id = ? AND kind = 'UNIT_IMPLEMENTED'
      ORDER BY at DESC LIMIT 1`,
    [c],
  );
  const merges = metrics.integration.merged;
  results.push(
    merges >= 2 && firstMerge[0] && lastImplemented[0] && firstMerge[0].at < lastImplemented[0].at
      ? {
          id: 'F11_CONTINUOUS_INTEGRATION',
          verdict: 'PASS',
          detail: `${merges} merges; the first landed before the last unit finished implementing`,
        }
      : fromRows(
          'F11_CONTINUOUS_INTEGRATION',
          merges,
          2,
          'merge(s) interleaved with implementation',
        ),
  );

  // 12. The integrator rejects an unrelated or contract-breaking change.
  const rejections = await rows<{ outcome: string }>(
    `SELECT outcome FROM factory_integrations WHERE campaign_id = ? AND outcome <> 'MERGED'`,
    [c],
  );
  results.push(
    fromRows(
      'F12_INTEGRATOR_REJECTS',
      rejections.length,
      1,
      'integration(s) refused on the evidence (scope, conflict or verification)',
    ),
  );

  /* --------------------------------------------------------------------- */
  /* Review and repair                                                     */
  /* --------------------------------------------------------------------- */

  // 13. Independent review runs against the original contract.
  const reviews = await rows<{ independence: string; verdict: string; round: number }>(
    `SELECT independence, verdict, round FROM factory_reviews WHERE campaign_id = ? ORDER BY round`,
    [c],
  );
  const independent = reviews.filter((review) => review.independence !== 'UNKNOWN');
  const notByAReviewer = await count(
    `SELECT COUNT(*) AS total FROM factory_reviews r
      JOIN factory_sessions s ON s.id = r.reviewer_session_id
     WHERE r.campaign_id = ? AND s.role <> 'REVIEWER'`,
    [c],
  );
  results.push(
    notByAReviewer > 0
      ? {
          id: 'F13_INDEPENDENT_REVIEW',
          verdict: 'FAIL',
          detail: `${notByAReviewer} review(s) were recorded against a session that was not a reviewer`,
        }
      : fromRows(
          'F13_INDEPENDENT_REVIEW',
          independent.length,
          1,
          'review(s) with established separation ' +
            `(${[...new Set(independent.map((r) => r.independence))].join(', ') || 'none'})`,
        ),
  );

  // 14. Review findings create repair WorkUnits automatically.
  const findings = await rows<{ state: string; severity: string; repair_unit_id: string | null }>(
    `SELECT state, severity, repair_unit_id FROM factory_findings WHERE campaign_id = ?`,
    [c],
  );
  const withRepairs = findings.filter((finding) => finding.repair_unit_id !== null);
  results.push(
    findings.length === 0
      ? {
          id: 'F14_FINDINGS_BECOME_WORK',
          verdict: 'NOT_RUN',
          detail: 'no review finding was recorded, so none could become work',
        }
      : fromRows(
          'F14_FINDINGS_BECOME_WORK',
          withRepairs.length,
          1,
          `finding(s) of ${findings.length} with a repair unit attached`,
        ),
  );

  // 15. Repairs are implemented and re-reviewed without a person carrying them.
  const repaired = findings.filter((finding) => finding.state === 'REPAIRED');
  const reviewsAfterRepair = await count(
    `SELECT COUNT(*) AS total FROM factory_reviews r
      WHERE r.campaign_id = ?
        AND EXISTS (SELECT 1 FROM factory_work_units u
                     WHERE u.campaign_id = r.campaign_id AND u.kind = 'REPAIR'
                       AND u.state = 'INTEGRATED' AND u.updated_at < r.created_at)`,
    [c],
  );
  results.push(
    repaired.length > 0 && reviewsAfterRepair > 0
      ? {
          id: 'F15_REPAIR_AND_REREVIEW',
          verdict: 'PASS',
          detail: `${repaired.length} finding(s) repaired and re-reviewed in ${reviewsAfterRepair} later round(s)`,
        }
      : {
          id: 'F15_REPAIR_AND_REREVIEW',
          verdict: 'NOT_RUN',
          detail: `${repaired.length} repaired finding(s), ${reviewsAfterRepair} review(s) after a repair integrated`,
        },
  );

  /* --------------------------------------------------------------------- */
  /* Verification                                                          */
  /* --------------------------------------------------------------------- */

  // 16. Both production persistence paths remain valid.
  const suiteRuns = await rows<{ detail: string }>(
    `SELECT detail FROM factory_events WHERE kind = 'SUITE_VERIFIED' ORDER BY at DESC`,
  );
  const dialects = new Set<string>();
  for (const suite of suiteRuns) {
    try {
      const parsed = JSON.parse(suite.detail) as { dialect?: string; exitCode?: number };
      if (parsed.exitCode === 0 && parsed.dialect) dialects.add(parsed.dialect);
    } catch {
      // An unreadable row is not evidence.
    }
  }
  results.push(
    dialects.has('sqlite') && dialects.has('postgres')
      ? {
          id: 'F16_BOTH_BACKENDS',
          verdict: 'PASS',
          detail: `the suite passed on ${[...dialects].sort().join(' and ')}`,
        }
      : {
          id: 'F16_BOTH_BACKENDS',
          verdict: 'NOT_RUN',
          detail: `the suite is recorded green on: ${[...dialects].sort().join(', ') || 'neither backend'}`,
        },
  );

  // 17. Migrations apply to a populated database and survive a restart.
  const migrationChecks = await rows<{ detail: string }>(
    `SELECT detail FROM factory_events WHERE kind = 'MIGRATION_VERIFIED' ORDER BY at DESC LIMIT 1`,
  );
  const schemaVersion = await count(`SELECT MAX(version) AS total FROM schema_migrations`);
  let populatedOk = false;
  let migrationDetail = 'no populated-database migration check is recorded';
  if (migrationChecks[0]) {
    try {
      const parsed = JSON.parse(migrationChecks[0].detail) as {
        populatedRowsBefore?: number;
        versionBefore?: number;
        versionAfter?: number;
        restarted?: boolean;
      };
      populatedOk =
        (parsed.populatedRowsBefore ?? 0) > 0 &&
        parsed.versionBefore === parsed.versionAfter &&
        parsed.restarted === true;
      migrationDetail =
        `schema ${parsed.versionBefore} to ${parsed.versionAfter} over ` +
        `${parsed.populatedRowsBefore} pre-existing row(s), reopened`;
    } catch {
      migrationDetail = 'the recorded migration check could not be read';
    }
  }
  results.push(
    populatedOk
      ? { id: 'F17_MIGRATIONS_POPULATED', verdict: 'PASS', detail: migrationDetail }
      : {
          id: 'F17_MIGRATIONS_POPULATED',
          verdict: 'NOT_RUN',
          detail: `${migrationDetail} (schema at ${schemaVersion})`,
        },
  );

  // 18. The client builds.
  const builds = await rows<{ detail: string }>(
    `SELECT detail FROM factory_events
      WHERE kind = 'VERIFICATION_RAN' AND detail LIKE '%npm run build%' ORDER BY at DESC`,
  );
  const greenBuild = builds.find((row) => row.detail.includes('"exitCode":0'));
  results.push(
    greenBuild
      ? {
          id: 'F18_CLIENT_BUILDS',
          verdict: 'PASS',
          detail: 'npm run build exited 0 on the merged tree',
        }
      : {
          id: 'F18_CLIENT_BUILDS',
          verdict: 'NOT_RUN',
          detail: `${builds.length} build run(s) recorded, none green`,
        },
  );

  /* --------------------------------------------------------------------- */
  /* The deliverable                                                       */
  /* --------------------------------------------------------------------- */

  // 19. The campaign produces a reviewable diff.
  const prBodies = await count(
    `SELECT COUNT(*) AS total FROM factory_artifacts WHERE campaign_id = ? AND kind = 'PR_BODY'`,
    [c],
  );
  const patches = await rows<{ byte_size: number }>(
    `SELECT byte_size FROM factory_artifacts WHERE campaign_id = ? AND kind = 'PATCH'`,
    [c],
  );
  const patchBytes = patches.reduce((sum, row) => sum + Number(row.byte_size), 0);
  results.push(
    prBodies >= 1 && patchBytes > 0
      ? {
          id: 'F19_REVIEWABLE_ARTIFACT',
          verdict: 'PASS',
          detail: `${prBodies} pull-request body and ${patchBytes} bytes of patch`,
        }
      : {
          id: 'F19_REVIEWABLE_ARTIFACT',
          verdict: 'NOT_RUN',
          detail: `${prBodies} body, ${patchBytes} bytes of patch — a record with no diff is not an artifact`,
        },
  );

  // 20. Brain receives the final outcome and evidence.
  const writebacks = await count(`SELECT COUNT(*) AS total FROM project_events WHERE payload LIKE ?`, [
    `%${c}%`,
  ]);
  results.push(
    fromRows('F20_BRAIN_WRITEBACK', writebacks, 1, "project event(s) carrying the campaign's outcome"),
  );

  // 21. Repeated ticks, callbacks and restarts create no duplicates.
  const duplicateUnits = await count(
    `SELECT COUNT(*) AS total FROM (
       SELECT campaign_id, unit_key, COUNT(*) AS n FROM factory_work_units
        GROUP BY campaign_id, unit_key HAVING COUNT(*) > 1) dup`,
  );
  const duplicateMerges = await count(
    `SELECT COUNT(*) AS total FROM (
       SELECT unit_id, attempt, COUNT(*) AS n FROM factory_integrations
        WHERE outcome = 'MERGED' GROUP BY unit_id, attempt HAVING COUNT(*) > 1) dup`,
  );
  const duplicateReviews = await count(
    `SELECT COUNT(*) AS total FROM (
       SELECT campaign_id, reviewed_sha, COUNT(*) AS n FROM factory_reviews
        GROUP BY campaign_id, reviewed_sha HAVING COUNT(*) > 1) dup`,
  );
  const duplicateRepairs = await count(
    `SELECT COUNT(*) AS total FROM (
       SELECT repair_unit_id, COUNT(*) AS n FROM factory_findings
        WHERE repair_unit_id IS NOT NULL GROUP BY repair_unit_id HAVING COUNT(*) > 1) dup`,
  );
  const totalDuplicates = duplicateUnits + duplicateMerges + duplicateReviews + duplicateRepairs;
  results.push(
    totalDuplicates === 0
      ? {
          id: 'F21_NO_DUPLICATES',
          verdict: 'PASS',
          detail:
            'no duplicate unit key, no duplicate merge, no commit reviewed twice, no second ' +
            'repair for one finding',
        }
      : {
          id: 'F21_NO_DUPLICATES',
          verdict: 'FAIL',
          detail:
            `${duplicateUnits} duplicate unit key(s), ${duplicateMerges} duplicate merge(s), ` +
            `${duplicateReviews} re-reviewed commit(s), ${duplicateRepairs} duplicated repair(s)`,
        },
  );

  // 22. No paid model API is activated.
  const paid = await count(
    `SELECT COUNT(*) AS total FROM factory_events
      WHERE kind = 'SESSION_FINISHED' AND detail LIKE '%"paidApi":true%'`,
  );
  const finished = await count(
    `SELECT COUNT(*) AS total FROM factory_events WHERE kind = 'SESSION_FINISHED'`,
  );
  results.push(
    finished === 0
      ? {
          id: 'F22_NO_PAID_API',
          verdict: 'NOT_RUN',
          detail: 'no worker session has finished, so nothing has been recorded either way',
        }
      : paid === 0
        ? {
            id: 'F22_NO_PAID_API',
            verdict: 'PASS',
            detail: `${finished} session(s) finished, 0 recorded a paid model API`,
          }
        : {
            id: 'F22_NO_PAID_API',
            verdict: 'FAIL',
            detail: `${paid} session(s) used a paid model API`,
          },
  );

  // 23. Adding another worker is registration rather than a factory change.
  const registrations = await count(
    `SELECT COUNT(*) AS total FROM factory_events WHERE kind = 'WORKER_REGISTERED'`,
  );
  const distinctWorkers = await count(
    `SELECT COUNT(DISTINCT worker_id) AS total FROM factory_sessions WHERE campaign_id = ?`,
    [c],
  );
  results.push(
    registrations >= 2 && distinctWorkers >= 2
      ? {
          id: 'F23_REGISTRATION_SCALES',
          verdict: 'PASS',
          detail: `${registrations} worker(s) registered, ${distinctWorkers} of them ran work in this campaign`,
        }
      : fromRows(
          'F23_REGISTRATION_SCALES',
          Math.min(registrations, distinctWorkers),
          2,
          `registered worker(s) that actually ran work (${registrations} registered, ` +
            `${distinctWorkers} used)`,
        ),
  );

  // 24. Throughput and concurrency are reported as measured, never theoretical.
  results.push(
    metrics.concurrencyEvidence === 'MEASURED' && metrics.maxObservedConcurrency > 0
      ? {
          id: 'F24_MEASURED_THROUGHPUT',
          verdict: 'PASS',
          detail:
            `maximum overlap ${metrics.maxObservedConcurrency} MEASURED against ${slots} declared ` +
            `slot(s); ${metrics.sessions.total} session(s), ${metrics.integration.merged} merge(s)`,
        }
      : {
          id: 'F24_MEASURED_THROUGHPUT',
          verdict: 'NOT_RUN',
          detail: `concurrency evidence is ${metrics.concurrencyEvidence}`,
        },
  );

  return results;
}

async function main(): Promise<void> {
  await initDatabase();
  const campaign = await subjectCampaign();
  const results = await gates();

  console.log('='.repeat(96));
  console.log(`SOFTWARE FACTORY 0 — ACCEPTANCE${campaign ? ` · campaign ${campaign.id}` : ''}`);
  console.log('='.repeat(96));
  for (const result of results) {
    console.log(`${result.verdict.padEnd(8)} ${result.id.padEnd(30)} ${result.detail}`);
  }
  console.log('='.repeat(96));

  const failed = results.filter((result) => result.verdict === 'FAIL');
  const blocked = results.filter((result) => result.verdict === 'BLOCKED');
  const notRun = results.filter((result) => result.verdict === 'NOT_RUN');
  const passed = results.length - failed.length - blocked.length - notRun.length;
  console.log(
    `${passed}/${results.length} PASS · ${failed.length} FAIL · ${blocked.length} BLOCKED · ` +
      `${notRun.length} NOT_RUN`,
  );
  if (failed.length + blocked.length + notRun.length > 0) {
    console.log('');
    console.log('SOFTWARE FACTORY 0 IS NOT COMPLETE.');
    for (const result of [...failed, ...blocked, ...notRun]) {
      console.log(`  ${result.id}: ${result.detail}`);
    }
  }
  process.exitCode = failed.length + blocked.length + notRun.length === 0 ? 0 : 1;
  await closeDatabase();
}

/*
 * Run only when this file is the entry point: it is imported by its own test,
 * and a reporter that reports the moment it is imported cannot be tested.
 */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? 'x')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

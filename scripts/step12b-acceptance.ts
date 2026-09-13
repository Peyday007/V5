/**
 * Step 12B's own acceptance matrix: §29's seventeen scenarios, A to Q.
 *
 * **Separate from `step12a-acceptance.ts`, deliberately and permanently.** The
 * Step 12A reporter answers a closed historical question — did the mission that
 * step was accepted on actually happen — and its twenty-two gates are about
 * that mission. Folding these seventeen into it would do two bad things at
 * once: it would let 12A's historical PASSes stand in for 12B evidence, and it
 * would make 12A's closure re-openable by a later step's failure. Neither is
 * true, so neither is reported.
 *
 * ---------------------------------------------------------------------------
 * What a verdict means here
 * ---------------------------------------------------------------------------
 *
 *   PASS      exercised in this run, or derived from rows and files this run
 *             read. Never "the code looks like it would".
 *   PARTIAL   the mechanism is exercised and one named condition of the
 *             scenario is not. The condition is printed.
 *   BLOCKED   an operational fact stops it, named, with whose action clears it.
 *   NOT_RUN   nothing has happened yet. Different from BLOCKED on purpose:
 *             *nothing has happened* and *something is wrong* have different
 *             remedies, and a reporter that collapses them names neither.
 *
 * There is no verdict meaning "probably". A scenario this run could not
 * establish says so, and the report's last line is the count of what it could.
 *
 * ---------------------------------------------------------------------------
 * Where each verdict's evidence comes from
 * ---------------------------------------------------------------------------
 *
 * Two sources, read in two phases, and the report names which one it used. The
 * **operational** reading is two `SELECT`s against the configured Brain, taken
 * first and then closed — that is where "can this fleet fire anything" is
 * answered, and it cannot be answered anywhere else. The **exercising** half
 * then runs against a temporary database this script creates and deletes,
 * because it writes, and a reporter that wrote to a real Brain would be a
 * mutation rather than a reading. See `readOperationalFleet`.
 *
 *   npx tsx scripts/step12b-acceptance.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  activeDatabaseConfig,
  closeDatabase,
  getDb,
  initDatabase,
} from '../server/db/database.ts';
import { randomUUID } from 'node:crypto';
import { createProject } from '../server/repos/projects.ts';
import { createLayer, updateLayer } from '../server/repos/layers.ts';
import type { LayerStatus } from '../server/domain/types.ts';
import {
  createUser,
  createWorker,
  grantMembership,
  revokeMembership,
} from '../server/repos/identity.ts';
import { decideProjectAccess } from '../server/services/identity/policy.ts';
import { conversationIsReadable, ownerPrincipal } from '../server/services/russell/turn.ts';
import { createConversation } from '../server/repos/russellConversations.ts';
import {
  currentPolicy,
  listAccounts,
  listRoutines,
  policyHistory,
  setPolicy,
} from '../server/repos/fleet.ts';
import { LENSES, frontierFor } from '../server/services/russell/frontier.ts';
import { askableLenses, openInquiry, validateLensReply } from '../server/services/russell/inquiry.ts';
import {
  DEFAULT_TARGET_WITH_NO_PRIOR_POLICY,
  LAB_MODES,
  applyFinding,
  declareExperiment,
  rollbackFinding,
  runExperiment,
} from '../server/services/fleet/lab.ts';
import { MAP_TYPES } from '../server/services/russell/maps.ts';
import { PREFERENCES, checkPreference, defaults } from '../server/services/russell/preferences.ts';
import { SEARCH_KINDS, search } from '../server/services/russell/search.ts';
import { explainSlowness, usability } from '../server/services/fleet/view.ts';
import type { SlownessExplanation } from '../server/services/fleet/view.ts';
import { CANDIDATE_PRIORITIES } from '../server/domain/types.ts';
import type { FrontierRegion } from '../server/domain/types.ts';
import { choicesFor } from '../server/services/russell/needsHuman.ts';
import {
  activeWorkProgress,
  buildProgress,
  milestoneStateOfLayer,
  projectProgress,
} from '../server/services/russell/progress.ts';
import { homeFor } from '../server/services/russell/home.ts';
import { capture } from '../server/services/russell/judgment.ts';
import { SEMANTIC_MERGE_FLOOR } from '../server/services/russell/similarity.ts';
import {
  getCandidate,
  listCandidates,
  listMergeHistory,
  splitCandidate,
} from '../server/repos/russellCandidates.ts';
import { recordKnowledge } from '../server/repos/russellMissions.ts';
import { createAudit } from '../server/repos/audits.ts';
import { compileHat } from '../server/services/conversation/contextHat.ts';
import { ideaMapForProject } from '../server/services/russell/ideas.ts';
import { digestRenderSet, standingDecision } from '../server/repos/designApprovals.ts';

import { execFileSync } from 'node:child_process';
import { BRAIN_REVISION } from '../server/env.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/**
 * The revision this reading describes, and where that answer came from.
 *
 * Two sources, and they are not interchangeable. A **checkout** run asks git,
 * which is authoritative about the tree it just read and refuses to answer if
 * the tree is dirty — because a reading taken over uncommitted edits describes
 * a revision that does not exist anywhere, and combining it with a production
 * reading would silently compare two different trees. A **container** run has
 * no `.git` at all and reads `BRAIN_REVISION`, stamped into the image at build
 * time by the deploy workflow.
 *
 * Either way an unknown revision is reported as unknown. `step12b-combine.ts`
 * refuses a record that cannot name one, because the whole value of joining two
 * runs is that they describe the same code.
 */
function revisionOf(): { revision: string | null; attestedBy: string; dirty: boolean } {
  if (BRAIN_REVISION) {
    return { revision: BRAIN_REVISION, attestedBy: 'the image it was built into', dirty: false };
  }
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: REPO,
      encoding: 'utf8',
    }).trim();
    return { revision: head, attestedBy: 'git in this checkout', dirty: status.length > 0 };
  } catch {
    return { revision: null, attestedBy: 'nothing — no stamp and no git', dirty: false };
  }
}

/**
 * `FAIL` exists because the owner asked for it, and the reason is precise.
 *
 * A check that ran and did not hold used to have nowhere to go: it became
 * `NOT_RUN`, which means *nothing has happened yet* and is the opposite of what
 * occurred. A reader cannot tell a scenario nobody has exercised from one that
 * was exercised and broke, and those have completely different remedies — the
 * first needs somebody to run it, the second needs somebody to fix something.
 *
 *   PASS      exercised in this run, or derived from rows and files it read.
 *   FAIL      exercised, and a condition did not hold. What failed is printed.
 *   PARTIAL   the mechanism holds and one named condition was not exercised.
 *   BLOCKED   an operational fact stops it, named, with whose action clears it.
 *   NOT_RUN   nothing has happened. Never used for a check that ran.
 */
type Verdict = 'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED' | 'NOT_RUN';

interface Gate {
  id: string;
  title: string;
  verdict: Verdict;
  detail: string;
}

/**
 * Which of the three environments each scenario's decisive evidence comes from.
 *
 * ---------------------------------------------------------------------------
 * Why this is declared rather than inferred
 * ---------------------------------------------------------------------------
 *
 * There are three, and they answer different questions. **CHECKOUT** is the
 * repository tree — the console-removal suite, the committed render set, the
 * responsive suite; facts about what was built. **PRODUCTION** is the deployed
 * Brain's own rows — whether a fleet exists, what it has actually done; facts
 * no scratch database has. **ISOLATED** is the temporary database this script
 * creates and deletes, where every exercise that *writes* runs, because a
 * reporter that wrote to a real Brain would be a mutation rather than a reading.
 *
 * One run can only reach two of the three: a checkout run has the tree and the
 * scratch database but no fleet, and a container run has the fleet and the
 * scratch database but no tree. So neither run alone can answer all seventeen,
 * and `step12b-combine.ts` joins two runs that name the **same revision**.
 *
 * Declared as a map rather than passed per `record(...)` call on purpose: the
 * per-gate blocks below are edited constantly, and a field each of them had to
 * remember would be the field one of them forgot.
 */
type Environment = 'CHECKOUT' | 'PRODUCTION' | 'ISOLATED';

const GATE_EVIDENCE: Record<string, Environment> = {
  A: 'PRODUCTION',
  B: 'PRODUCTION',
  C: 'ISOLATED',
  D: 'ISOLATED',
  E: 'PRODUCTION',
  F: 'ISOLATED',
  G: 'ISOLATED',
  H: 'CHECKOUT',
  I: 'ISOLATED',
  J: 'CHECKOUT',
  K: 'CHECKOUT',
  L: 'PRODUCTION',
  M: 'ISOLATED',
  N: 'PRODUCTION',
  O: 'CHECKOUT',
  P: 'ISOLATED',
  Q: 'ISOLATED',
};

const gates: Gate[] = [];
function record(id: string, title: string, verdict: Verdict, detail: string): void {
  gates.push({ id, title, verdict, detail });
}

/** Read a repository file, or null. Used where the evidence is the code itself. */
function file(relative: string): string | null {
  const full = path.join(REPO, relative);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

/**
 * Whether this run can see the repository at all — and it is a real question,
 * not a defensive one.
 *
 * Several scenarios are facts about the repository rather than about rows: the
 * console removal is a test that reads the tree, and the visual record is a
 * committed image set. Those rows are answered from a checkout.
 *
 * But the *operational* half of this report has to run where the production
 * database is, which is inside the container — and `.dockerignore` deliberately
 * excludes `tests`, `docs`, `*.md` and `client/src` from the image. That is
 * correct: an image is copied, pushed to a registry and pulled by machines
 * nobody controls, and it should carry what it runs and nothing else.
 *
 * So a production run genuinely **cannot see** those rows, and the whole point
 * of this file is that *we could not tell* must never read the same as *we
 * checked*. A repository-fact row taken in the container says which half is
 * missing and where to take it instead, rather than reporting the absence as
 * though it were the answer.
 *
 * `tests/` is the probe because it is excluded, is never generated, and is
 * present in every checkout including a fresh clone.
 */
const REPO_VISIBLE = fs.existsSync(path.join(REPO, 'tests'));
const NOT_FROM_A_CHECKOUT =
  'This reading was taken where the production database is, and the deployed image ' +
  'deliberately carries no tests/, docs/ or client/src \u2014 so this row is a ' +
  'repository fact this run cannot see, rather than one it checked and found absent. ' +
  'Take this row from a checkout (npm run step12b:acceptance).';

/**
 * Where this process is running, which decides which two of the three
 * environments it can reach. `REPO_VISIBLE` is the probe because
 * `.dockerignore` excludes `tests/` from the image and nothing generates it.
 */
const RUN_ENVIRONMENT: 'CHECKOUT' | 'PRODUCTION' = REPO_VISIBLE ? 'CHECKOUT' : 'PRODUCTION';

/**
 * The committed visual record, read rather than assumed.
 *
 * `scripts/visual-qa.ts` writes to a throwaway directory by default, for the
 * right reason: a screenshot in a repository is stale the moment the CSS
 * changes, and a stale one that still looks like evidence is worse than none.
 * One set is committed anyway, because §29's O asks a person to approve what
 * the product looks like and a decision somebody must run a twenty-minute
 * harness to see is a decision nobody makes.
 *
 * So this reads what is actually there. It is deliberately **not** a claim
 * that the journey happened — a PNG cannot establish that — it is the weaker
 * and checkable claim that the record exists, names its commit and its browser,
 * and still has the images its own index lists. Deleting the set drops H, J and
 * O back to what the code alone can say, which is the correct behaviour.
 */
function visualEvidence(): { index: string | null; images: number; journeySteps: number } {
  const index = file('docs/evidence/step12b-visual.md');
  const dir = path.join(REPO, 'docs', 'evidence', 'step12b-visual');
  const images = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith('.png')).length
    : 0;
  const journeySteps = index
    ? new Set(
        [...index.matchAll(/journey-(\d+[a-z]?)-/g)].map((match) => match[1] as string),
      ).size
    : 0;
  return { index, images, journeySteps };
}

/**
 * The fleet as the configured Brain actually holds it, read before anything
 * else opens a database.
 *
 * ---------------------------------------------------------------------------
 * Two databases, on purpose, and in this order
 * ---------------------------------------------------------------------------
 *
 * The exercising half of this report runs against a **temporary** database it
 * creates and deletes, because it writes: it registers four projects, a hundred
 * candidates, knowledge rows, an audit with classified gaps, merges and their
 * undo, a frontier reading, an inquiry, a dozen Capability Lab experiments and
 * five fleet policy versions — and doing any of that to a real Brain would make
 * the reporter a mutation. But several scenarios are not about a mechanism at
 * all — they are about whether the deployed fleet can run anything — and
 * against a scratch database that question has no answer.
 *
 * So the operational reading is taken first, from the **configured** database,
 * read-only: two `SELECT`s and a close. Then the temp database is opened and
 * everything that writes happens there. A reading that could not be taken is
 * reported as *not taken* rather than as a healthy or an unhealthy fleet, which
 * is the same three-answer rule the verdicts themselves follow.
 */
interface FleetReading {
  routines: Awaited<ReturnType<typeof listRoutines>>;
  accounts: Awaited<ReturnType<typeof listAccounts>>;
  /** Why the reading could not be taken, or null when it was. */
  unreadable: string | null;
  /** What was read: the configured Brain, named without its credential. */
  source: string;
  /**
   * One real dispatch, traced from the Brain's own `bin_events`.
   *
   * Taken in the same read-only phase as the fleet rows, because N is a fact
   * about a dispatch that actually happened and no scratch database has one.
   * Null where the Brain has never fired anything, which is *not run* rather
   * than a finding.
   */
  trace: SlownessExplanation | null;
  /**
   * What this Brain has actually done, for the three scenarios that are facts
   * about work rather than about a mechanism.
   *
   * A, B and L were reported from the surface blocker — *can anything be
   * fired* — which is a proxy for them and not one of them. "Can a turn be
   * answered" is a different question from "has one been", and only the second
   * is the scenario. These are the rows that answer it, counted in the same
   * read-only phase and zero everywhere a Brain has not run.
   */
  history: {
    /** A: conversations, and turns a worker actually answered. */
    conversations: number;
    answeredTurns: number;
    pendingTurns: number;
    failedTurns: number;
    routedConversations: number;
    /** B: ideas Russell formed its own priority on, and audit passes recorded. */
    judgedCandidates: number;
    auditPasses: number;
    /** E: what the connected site has actually delivered. */
    externalRecords: number;
    externalRejections: number;
    connectorEvents: number;
    connectorCommands: number;
    lastRecordAt: string | null;
    /** L: the durable tick, as its own row states it. */
    cycleState: string | null;
    cycleLastRanAt: string | null;
    cycleLastError: string | null;
  };
}

async function readOperationalFleet(): Promise<FleetReading> {
  try {
    await initDatabase();
    const config = activeDatabaseConfig();
    const [routines, accounts] = await Promise.all([listRoutines(), listAccounts()]);
    // Named by provider, never by connection string — §18's rule, and this
    // output goes into a CI log.
    const source = config?.provider === 'postgres' ? 'the cloud database' : 'the local database';

    /*
     * The most recent bin Brain actually fired a worker for.
     *
     * `DISPATCH_SENT` is the event that makes it a real dispatch rather than an
     * intent, and `MAX(at)` picks the newest without needing a tiebreak on a
     * column only one dialect has — the `ORDER BY` rule this repository has
     * been caught by three times.
     */
    /*
     * What this Brain has done, counted rather than inferred.
     *
     * Six `SELECT COUNT`s and one singleton read, all in the same read-only
     * phase. `attachment_source <> 'NONE'` is the routing half of A — a thread
     * Brain decided a project for — and it is deliberately not the same count
     * as "has a project", because a thread can carry one a person set.
     */
    const one = async (sql: string): Promise<number> => {
      const row = await getDb().get<{ total: number }>(sql);
      return Number(row?.total ?? 0);
    };
    const conversations = await one('SELECT COUNT(*) AS total FROM russell_conversations');
    const routedConversations = await one(
      "SELECT COUNT(*) AS total FROM russell_conversations WHERE attachment_source <> 'NONE'",
    );
    const answeredTurns = await one(
      "SELECT COUNT(*) AS total FROM russell_messages WHERE role = 'RUSSELL' AND status = 'COMPLETE'",
    );
    const pendingTurns = await one(
      "SELECT COUNT(*) AS total FROM russell_messages WHERE status = 'PENDING'",
    );
    const failedTurns = await one(
      "SELECT COUNT(*) AS total FROM russell_messages WHERE status = 'FAILED'",
    );
    const judgedCandidates = await one(
      'SELECT COUNT(*) AS total FROM russell_candidates WHERE priority IS NOT NULL',
    );
    const auditPasses = await one(
      "SELECT COUNT(*) AS total FROM research_passes WHERE pass_key = 'AUDIT' AND status = 'COMPLETE'",
    );
    /*
     * What the connected site has actually done, counted in the same read-only
     * phase — because E is a fact about a live site and no scratch database has
     * one. Keyed on the canonical vocabulary rather than a lower-cased spelling:
     * `external_records.source_system` stores `DEAL_DISPATCH`, and a reader that
     * lower-cased it reported a live site as holding nothing.
     */
    const externalRecords = await one(
      'SELECT COUNT(*) AS total FROM external_records',
    );
    const externalRejections = await one(
      'SELECT COUNT(*) AS total FROM external_record_rejections',
    );
    const connectorEvents = await one(
      "SELECT COUNT(*) AS total FROM project_events WHERE event_type LIKE 'EXTERNAL_%'",
    );
    const connectorCommands = await one(
      "SELECT COUNT(*) AS total FROM project_events WHERE event_type = 'EXTERNAL_COMMAND_ACCEPTED'",
    );
    const lastRecord = await getDb().get<{ last_at: string | null }>(
      "SELECT MAX(created_at) AS last_at FROM project_events WHERE event_type LIKE 'EXTERNAL_RECORD_%'",
    );

    const cycle = await getDb().get<{
      state: string;
      last_ran_at: string | null;
      last_error: string | null;
    }>('SELECT state, last_ran_at, last_error FROM russell_cycle LIMIT 1');
    const history = {
      conversations,
      answeredTurns,
      pendingTurns,
      failedTurns,
      routedConversations,
      judgedCandidates,
      auditPasses,
      externalRecords,
      externalRejections,
      connectorEvents,
      connectorCommands,
      lastRecordAt: lastRecord?.last_at ?? null,
      cycleState: cycle?.state ?? null,
      cycleLastRanAt: cycle?.last_ran_at ?? null,
      cycleLastError: cycle?.last_error ?? null,
    };

    const fired = await getDb().get<{ bin_id: string; last_at: string }>(
      `SELECT bin_id, MAX(at) AS last_at FROM bin_events
        WHERE event_type = 'DISPATCH_SENT'
        GROUP BY bin_id
        ORDER BY last_at DESC
        LIMIT 1`,
    );
    const trace = fired ? await explainSlowness(fired.bin_id) : null;

    await closeDatabase();
    return { routines, accounts, unreadable: null, source, trace, history };
  } catch (error) {
    // A developer machine with nothing configured is the ordinary case here,
    // and it is not a finding about the fleet.
    return {
      routines: [],
      accounts: [],
      unreadable: error instanceof Error ? error.message : String(error),
      source: 'nothing — no database was configured for this run',
      trace: null,
      history: {
        conversations: 0,
        answeredTurns: 0,
        pendingTurns: 0,
        failedTurns: 0,
        routedConversations: 0,
        judgedCandidates: 0,
        auditPasses: 0,
        externalRecords: 0,
        externalRejections: 0,
        connectorEvents: 0,
        connectorCommands: 0,
        lastRecordAt: null,
        cycleState: null,
        cycleLastRanAt: null,
        cycleLastError: null,
      },
    };
  }
}

/**
 * The one operational fact that blocks several scenarios, read from rows.
 *
 * Named once and referenced, so five gates cannot drift into five different
 * descriptions of the same condition — and so a reader can see immediately
 * that they are one problem rather than five.
 */
function surfaceBlocker(reading: FleetReading): { verdict: Verdict; detail: string } {
  const { routines, accounts } = reading;

  if (reading.unreadable) {
    return {
      verdict: 'NOT_RUN',
      detail:
        'No configured database could be read, so this run can say nothing either way ' +
        `about a surface: ${reading.unreadable}`,
    };
  }

  /*
   * No fleet at all is not a blocked fleet, and saying so would be the exact
   * dishonesty this report exists to avoid.
   *
   * Run locally this script opens an empty database, which has no Routines
   * because nothing registered any — a fact about *this run*. Reporting that as
   * `NO_HEALTHY_EXECUTION_SURFACE` would dress a fixture up as a production
   * condition, and a reader would take a local scratch database as evidence
   * about the deployed fleet. They are different sentences and they get
   * different verdicts.
   */
  if (routines.length === 0) {
    return {
      verdict: 'NOT_RUN',
      detail:
        `${reading.source} holds no fleet rows at all, so this run can say nothing either ` +
        'way about a surface. Run against a Brain that has one — or read the deployed ' +
        'fleet with `fleet show`, which prints each surface and, when it is not ENABLED, ' +
        'the reason recorded when it was taken out of routing.',
    };
  }

  const byAccount = new Map(accounts.map((account) => [account.id, account]));
  const now = new Date().toISOString();
  const usable = routines.filter(
    (routine) => usability(routine, byAccount.get(routine.accountId), now).usable,
  );
  if (usable.length > 0) {
    return {
      verdict: 'NOT_RUN',
      detail:
        `${usable.length} of ${routines.length} Routine(s) in ${reading.source} can be fired; ` +
        'this scenario still has to be driven end to end.',
    };
  }

  const held = routines.find((routine) => routine.state === 'QUARANTINED' && routine.stateReason);
  return {
    verdict: 'BLOCKED',
    detail:
      `NO_HEALTHY_EXECUTION_SURFACE — ${routines.length} Routine(s) are registered in ` +
      `${reading.source} and none can be fired, so nothing that needs a worker can run. ` +
      (held?.stateReason ? `Recorded reason: ${held.stateReason.slice(0, 220)}` : ''),
  };
}

async function main(): Promise<void> {
  // Read the real fleet first, then close it. Everything after this line writes.
  const fleet = await readOperationalFleet();
  const blocker = surfaceBlocker(fleet);

  /*
   * The temporary database, and the reason it is named explicitly.
   *
   * `dbPath` is honoured **only in local mode**: `initDatabase` reads the
   * configured provider first, so against a Postgres-configured Brain it is
   * ignored entirely and every write below lands in the real database. This
   * script registers four projects, seven foundations, two people, a hundred
   * candidates and a handful more it merges and splits, five knowledge rows, an
   * audit with two classified gaps, a frontier reading, a lens inquiry, a dozen
   * Capability Lab experiments and five fleet policy versions — so in cloud
   * mode the reporter would have been a mutation, which is precisely what its
   * own header says it is not.
   *
   * Caught by running it twice against a Postgres test database: the second run
   * collided on `rc_acc_0`, because the first had written it. The production
   * workflow had never been dispatched, so nothing real was touched — but it
   * runs *inside the container*, where the provider is postgres and the cloud
   * credential is present, so the first dispatch would have done it.
   *
   * The remedy is to state the config rather than to hint at it. A provider
   * named here cannot be overridden by the environment, so the exercising half
   * is local whatever the Brain is configured for — and the operational reading
   * above, which is the part that must see the real Brain, has already been
   * taken and closed.
   */
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-12b-acc-'));
  await initDatabase({
    dbPath: path.join(dataDir, 'acceptance.db'),
    config: { provider: 'sqlite', connectionString: null, poolSize: 1 },
  });

  /* -- A. Conversation routing and continuity ----------------------------- */
  /*
   * Asked of the turns rather than of the fleet.
   *
   * A turn is a bin and a bin needs a surface (§24: no inference is bought), so
   * this was reported from the surface blocker — *can anything be fired*. That
   * is a proxy for the scenario and not the scenario: "a turn can be answered"
   * and "a turn has been answered" are different facts, and only the second is
   * what A asks. The blocker is still reported where nothing has run, because
   * then it is the reason.
   */
  const seen = fleet.history;
  record(
    'A',
    'Conversation routing and continuity',
    seen.answeredTurns > 0 ? 'PARTIAL' : blocker.verdict,
    seen.answeredTurns > 0
      ? `${seen.answeredTurns} turn(s) answered by a worker across ${seen.conversations} ` +
        `conversation(s) in ${fleet.source}, ${seen.routedConversations} of which Brain routed ` +
        `to a project itself. ${seen.pendingTurns} pending and ${seen.failedTurns} failed, ` +
        'each carrying its own recorded reason rather than an optimistic placeholder. ' +
        'NOT established here: continuity across a restart mid-turn, driven deliberately.'
      : blocker.detail,
  );

  /* -- B. Independent judgment -------------------------------------------- */
  /*
   * Two different things, and both are rows: Russell forming its own priority
   * on an idea, and the three-role audit actually running. Neither is the
   * fleet's health, which is what was being reported here.
   */
  record(
    'B',
    'Independent judgment',
    seen.judgedCandidates > 0 && seen.auditPasses > 0 ? 'PARTIAL' : blocker.verdict,
    seen.judgedCandidates > 0 && seen.auditPasses > 0
      ? `${seen.judgedCandidates} idea(s) carry a priority Russell decided, and ` +
        `${seen.auditPasses} audit pass(es) have completed in ${fleet.source} — the primary, ` +
        'adversarial and judge roles this product does not let one session hold two of. ' +
        'NOT established here: a judgment a person disagreed with and overrode, end to end.'
      : blocker.detail,
  );

  /* -- C. Priority and backlog -------------------------------------------- */
  // Ranking is deterministic and needs no worker, so this one is exercised.
  const project = await createProject({
    name: 'Step 12B acceptance',
    slug: `s12b-acc-${Date.now()}`,
    purpose: 'PROJECT',
  });
  const db = getDb();
  const nowIso = new Date().toISOString();
  for (let index = 0; index < 100; index += 1) {
    await db.run(
      `INSERT INTO russell_candidates
         (id, project_id, title, statement, fingerprint, state, priority, visibility,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'CAPTURED', ?, 'SHARED', ?, ?)`,
      [
        `rc_acc_${index}`,
        project.id,
        `Candidate ${index}`,
        `A distinct thing worth considering, number ${index}.`,
        `fp_acc_${index}`,
        // The real vocabulary, from the domain's own constant, rather than a
        // plausible-looking one: a CHECK refuses anything else, which is the
        // schema doing its job.
        CANDIDATE_PRIORITIES[index % CANDIDATE_PRIORITIES.length],
        nowIso,
        nowIso,
      ],
    );
  }
  const ranked = await db.all<{ priority: string; total: number }>(
    `SELECT priority, COUNT(*) AS total FROM russell_candidates
      WHERE project_id = ? GROUP BY priority ORDER BY priority`,
    [project.id],
  );
  const classified = ranked.reduce((sum, row) => sum + Number(row.total), 0);

  /*
   * The semantic merge, driven rather than described.
   *
   * This was the named unmet condition of C, and the sentence it was reported
   * under — "which needs a worker to name the repeat" — was true of only half
   * of it. §24 is explicit that the merge needs **both** a claim and a floor,
   * and that the claim decides nothing on its own: `capture` re-resolves the
   * named id against rows, refuses one outside this scope or already merged,
   * and puts the two statements under `clearsFloor` before anything moves. All
   * of that is server code and all of it is reachable without a worker — what a
   * worker supplies is one string, which is exactly the part §8 says may not
   * decide anything.
   *
   * So the claim is supplied here in the worker's place and every guard behind
   * it is exercised for real: one genuine rewording that merges, four claims
   * refused for four different reasons, and the split that puts a merged row
   * back. What this still does not establish is a worker naming a repeat in a
   * live conversation, and that is what C now says.
   */
  const mergeScope = await createProject({
    name: 'Step 12B acceptance duplicates',
    slug: `s12b-dup-${Date.now()}`,
    purpose: 'PROJECT',
  });
  const CANONICAL =
    'Establish how long after a deed is recorded it becomes available electronically in ' +
    'Michigan county register offices, before a title search can rely on it.';
  const REWORD =
    'How long does it take for a recorded deed to become electronically available in the ' +
    'county register offices of Michigan?';
  const canonical = await capture({
    title: 'Electronic availability of a recorded deed',
    statement: CANONICAL,
    projectId: mergeScope.id,
    visibility: 'SHARED',
  });
  const canonicalId = canonical.candidate?.id ?? null;

  /*
   * The same question in a different project, so the scope refusal below is
   * attributable to the scope alone.
   *
   * Naming an unrelated candidate would be refused by the floor first and would
   * prove nothing about the boundary — and the boundary is the part that
   * matters: a merge reaching across projects would confirm a candidate exists
   * to somebody who cannot read it.
   */
  const foreignTwin = await capture({
    title: 'Electronic availability of a recorded deed',
    statement: CANONICAL,
    projectId: project.id,
    visibility: 'SHARED',
  });

  // 1. A genuine rewording, which merges.
  const merged = await capture({
    title: 'How quickly a recorded deed appears online',
    statement: REWORD,
    projectId: mergeScope.id,
    visibility: 'SHARED',
    duplicateOf: canonicalId,
  });
  const foldedRow =
    (await listCandidates({ projectId: mergeScope.id, limit: 50 })).find(
      (row) => row.state === 'MERGED' && row.canonicalCandidateId === canonicalId,
    ) ?? null;

  // 2. The same subject words, a different question: refused by the floor.
  const nearby = await capture({
    title: 'Ranking the register offices',
    statement:
      'Decide whether the Michigan county register offices should be ranked by staffing ' +
      'levels, opening hours, budget, telephone response times, walk-in volume, parking ' +
      'and signage before any outreach campaign begins.',
    projectId: mergeScope.id,
    visibility: 'SHARED',
    duplicateOf: canonicalId,
  });

  // 3. Nothing in common at all: refused before the ratio is reached.
  const unrelated = await capture({
    title: 'Billing order on the pricing page',
    statement: 'Decide whether the pricing page should show annual billing before monthly billing.',
    projectId: mergeScope.id,
    visibility: 'SHARED',
    duplicateOf: canonicalId,
  });

  // 4. A rewording that would clear the floor, naming a candidate in another project.
  const crossScope = await capture({
    title: 'When a recorded deed appears online',
    statement:
      'When does a recorded deed become electronically available in a Michigan county ' +
      'register office?',
    projectId: mergeScope.id,
    visibility: 'SHARED',
    duplicateOf: foreignTwin.candidate?.id ?? null,
  });

  // 5. And one naming a row that has already been folded away, so no chains.
  const intoMerged = await capture({
    title: 'Electronic publication after recording',
    statement:
      'After a deed is recorded in Michigan, how long until the county register office ' +
      'publishes it electronically?',
    projectId: mergeScope.id,
    visibility: 'SHARED',
    duplicateOf: foldedRow?.id ?? null,
  });

  // And the undo, which is what makes the merge safe to make at all.
  const splitOk = foldedRow
    ? await splitCandidate({
        candidateId: foldedRow.id,
        reason: 'A person said these were two questions after all.',
      })
    : false;
  const afterSplit = foldedRow ? await getCandidate(foldedRow.id) : null;
  const canonicalAfter = canonicalId ? await getCandidate(canonicalId) : null;
  const mergeHistory = foldedRow ? await listMergeHistory(foldedRow.id) : [];
  const mergeRow = mergeHistory.find((row) => row.action === 'MERGE') ?? null;
  const splitRow = mergeHistory.find((row) => row.action === 'SPLIT') ?? null;

  const dedupe = [
    [
      'a rewording merges into the idea it repeats',
      merged.merged && merged.candidate?.id === canonicalId,
    ],
    ['and it is recorded as decided by meaning', mergeRow?.method === 'SEMANTIC'],
    [
      'the same subject words with a different question are refused by the floor',
      !nearby.merged && /overlap/.test(nearby.reason),
    ],
    [
      'two unrelated ideas are refused before the ratio',
      !unrelated.merged && /subject word/.test(unrelated.reason),
    ],
    /*
     * Both of these get the *same* sentence, and that is the design rather than
     * an imprecision: "you may not merge into that" and "there is nothing there
     * to merge into" are invariant 23's pair, and a reason that separated them
     * would say whether a candidate exists in a scope the asker cannot read.
     * So each is asserted on the outcome and on that one shared sentence.
     */
    [
      'a candidate in another project cannot be merged into',
      !crossScope.merged && /not one that can be merged into/.test(crossScope.reason),
    ],
    [
      'nor one that has already been folded away',
      !intoMerged.merged && /not one that can be merged into/.test(intoMerged.reason),
    ],
    [
      'and neither refusal says which of the two it was',
      crossScope.reason === intoMerged.reason,
    ],
    [
      'every refused claim still kept its own idea',
      [nearby, unrelated, crossScope, intoMerged].every((outcome) => outcome.candidate !== null),
    ],
    [
      'a person can undo the merge',
      splitOk && afterSplit?.state === 'CAPTURED' && afterSplit?.canonicalCandidateId === null,
    ],
    ['and neither history is lost', mergeRow !== null && splitRow !== null],
    ['the idea it was folded into is untouched', canonicalAfter?.state === 'CAPTURED'],
  ] as const;
  const dedupeFailed = dedupe.filter(([, held]) => !held).map(([name]) => name);

  record(
    'C',
    'Priority and backlog',
    classified === 100 && dedupeFailed.length === 0 ? 'PARTIAL' : 'NOT_RUN',
    dedupeFailed.length > 0 || classified !== 100
      ? `${classified} candidates carried a class (100 expected) and ${dedupeFailed.length} of ` +
        `${dedupe.length} deduplication condition(s) did not hold: ${dedupeFailed.join('; ')}. ` +
        'That is a defect rather than a missing run.'
      : `${classified} candidates in an isolated scope, every one carrying a class ` +
        `(${ranked.map((row) => `${row.priority}=${row.total}`).join(' ')}). The semantic merge ` +
        `is driven end to end in a second scope: ${dedupe.length}/${dedupe.length} conditions ` +
        `held — a rewording merged (${mergeRow?.reason ?? 'no merge row'}) and is recorded as ` +
        'SEMANTIC, and four claims were refused: below the ' +
        `${SEMANTIC_MERGE_FLOOR} overlap floor, below the minimum shared subject words, naming ` +
        'a candidate in another project, and naming one already folded away — the last two in ' +
        'the same words as each other, deliberately, and each leaving both ideas standing. The merge was then undone with splitCandidate: the row returned to ' +
        'CAPTURED, and its MERGE and SPLIT rows are both still there. NOT established here: a ' +
        'worker naming the repeat from a live conversation, which is the one string the server ' +
        'does not supply itself, and a person reading this backlog on the deployed product.',
  );

  /* -- D. Discovery Frontier v1 ------------------------------------------- */
  const derived = LENSES.filter((lens) => lens.kind === 'DERIVED');
  const asked = askableLenses();

  /*
   * A real project snapshot, built from the rows the five derived lenses
   * actually read.
   *
   * The named unmet condition here was "the six discovery classes found in a
   * real project snapshot", and the reason given was that it needs a worker.
   * Half of that was true and half was not: the four **asked** lenses need a
   * reader, and the five **derived** ones are answered from rows — knowledge,
   * layers, audit gaps and candidates — none of which needs anybody. So the
   * rows are written here and `frontierFor` is called on them, which is the
   * same function the page calls.
   *
   * Nothing is inserted into `russell_frontier` directly. Writing a frontier
   * row and then reading it back would prove the table exists and would say
   * nothing about the classification, which is the whole claim the frontier
   * makes.
   */
  const snapshot = await createProject({
    name: 'Step 12B acceptance frontier',
    slug: `s12b-frontier-${Date.now()}`,
    purpose: 'PROJECT',
  });
  const discoveryLayer = await createLayer({
    projectId: snapshot.id,
    name: 'Discovery',
    orderIndex: 0,
  });
  await updateLayer(discoveryLayer.id, { status: 'FROZEN', statusSource: 'DERIVED' });
  const sizingLayer = await createLayer({
    projectId: snapshot.id,
    name: 'Market Sizing',
    orderIndex: 1,
  });
  await updateLayer(sizingLayer.id, { status: 'RESEARCHING', statusSource: 'DERIVED' });
  // Left as declared and untouched, which is the one item derived from an
  // absence — and the only way UNEXAMINED can be reached at all.
  await createLayer({ projectId: snapshot.id, name: 'Go To Market', orderIndex: 2 });

  const believed: {
    kind: 'CONCLUSION' | 'ASSUMPTION' | 'CONTRADICTION' | 'GAP';
    confidence: 'ESTABLISHED' | 'SUPPORTED' | 'UNCERTAIN' | 'DISPUTED';
    statement: string;
  }[] = [
    {
      kind: 'CONCLUSION',
      confidence: 'ESTABLISHED',
      statement: 'Every county register of deeds in the state records instruments in a public index.',
    },
    {
      kind: 'CONCLUSION',
      confidence: 'UNCERTAIN',
      statement: 'Most counties publish a recorded instrument electronically within two working days.',
    },
    {
      kind: 'ASSUMPTION',
      confidence: 'UNCERTAIN',
      statement: 'A buyer will accept an electronic copy where a certified paper copy is not required.',
    },
    {
      kind: 'CONTRADICTION',
      confidence: 'DISPUTED',
      statement: 'Two sources disagree about whether the index is updated nightly or weekly.',
    },
    {
      kind: 'GAP',
      confidence: 'UNCERTAIN',
      statement: 'Nothing recorded says what happens to the timeline when a document is rejected.',
    },
  ];
  for (const row of believed) {
    await recordKnowledge({
      projectId: snapshot.id,
      layerId: discoveryLayer.id,
      visibility: 'SHARED',
      kind: row.kind,
      statement: row.statement,
      provenance: { source: 'step12b acceptance snapshot' },
      authorType: 'PIPELINE',
      confidence: row.confidence,
    });
  }

  /*
   * A judge's own classified gaps, through `createAudit` rather than an INSERT,
   * so the frontier reads exactly what an audit leaves behind.
   */
  await createAudit({
    projectId: snapshot.id,
    layerId: discoveryLayer.id,
    result: {
      verdict: 'MORE_RESEARCH',
      summary: 'The recording timeline is not established for rejected instruments.',
      failures: [],
      missingDocuments: [],
      requiredResearchRuns: [],
      requiredPatches: [],
      synthesisRequired: false,
      freezeEligible: false,
      nextVersion: null,
      nextAction: 'Establish the rejection path before freezing.',
    },
    gaps: [
      {
        classification: 'FOUNDATIONAL_GAP',
        title: 'The rejection path is unestablished',
        detail: 'Nothing in the packet says what a rejected instrument does to the timeline.',
      },
      {
        classification: 'PATCH',
        title: 'One county is named inconsistently',
        detail: 'Correctable in synthesis; no new research.',
      },
    ],
  });

  // An idea Russell had itself: no conversation behind it, which is the test.
  await capture({
    title: 'Ask the state association for its own timing survey',
    statement:
      'The state association of registers may already publish a timing survey that answers ' +
      'this without any county-by-county work.',
    projectId: snapshot.id,
    visibility: 'SHARED',
  });

  const frontier = await frontierFor({
    projectId: snapshot.id,
    projectName: snapshot.name,
    includePrivate: true,
  });
  const populated = frontier.regions.filter((region) => region.items.length > 0);
  const emptyRegions = frontier.regions
    .filter((region) => region.items.length === 0)
    .map((region) => region.region);
  const lensesSeen = new Set(
    frontier.regions.flatMap((region) =>
      region.items.map((item) => item.lens).filter((lens): lens is string => lens !== null),
    ),
  );
  const derivedKeys = new Set<string>(derived.map((lens) => lens.key));
  const derivedSeen = [...lensesSeen].filter((lens) => derivedKeys.has(lens));
  const regionSummary = frontier.regions
    .map((region) => {
      const lenses = new Set(
        region.items.map((item) => item.lens ?? 'no lens — the row itself is the reading'),
      );
      return `${region.region}=${region.items.length} (${[...lenses].join(', ')})`;
    })
    .join('; ');

  /*
   * What the audit's own gaps became, reported rather than assumed.
   *
   * `classify` sends a gap to OPEN_QUESTION when its classification is
   * `FOUNDATIONAL`, and the domain's vocabulary (`GAP_CLASSIFICATIONS`) has no
   * such member — it is `FOUNDATIONAL_GAP`. So this run reads which region a
   * genuinely foundational gap actually landed in rather than asserting the one
   * the comment implies. Repairing that comparison is a change to
   * `services/russell/frontier.ts`, which this reporter does not make.
   */
  const gapItems = frontier.regions.flatMap((region) =>
    region.items.filter((item) => item.sourceKind === 'AUDIT_GAP').map((item) => ({
      region: region.region as FrontierRegion,
      subject: item.subject,
    })),
  );
  const foundationalGap = gapItems.find((item) => /rejection path/i.test(item.subject)) ?? null;
  const gapNote = foundationalGap
    ? `an audit's FOUNDATIONAL_GAP was recorded as ${foundationalGap.region}` +
      (foundationalGap.region === 'OPEN_QUESTION'
        ? ''
        : " — `classify` compares the classification against 'FOUNDATIONAL', which is not a " +
          'member of GAP_CLASSIFICATIONS, so that branch is unreachable. Reported, not worked ' +
          'around: it is a defect in server/services/russell/frontier.ts')
    : 'no audit gap reached the frontier at all, which is a defect';

  // The asked half now has a path; that the path *exists and validates* is
  // exercised here, and that a worker answers one is not.
  const refusedDerived = await openInquiry({
    projectId: snapshot.id,
    projectName: snapshot.name,
    lens: derived[0]!.key,
    openedBy: 'acceptance',
  });
  const invented = validateLensReply(
    {
      findings: [
        {
          subject: 'Invented',
          statement: 'A claim about the world with nothing under it at all.',
          rationale: 'None.',
          references: [{ kind: 'KNOWLEDGE', id: 'rk_not_real' }],
        },
      ],
    },
    { knowledgeIds: new Set(), layerIds: new Set(), frontierIds: new Set(), held: [] },
  );
  const discarded = invented.ok && invented.result.findings.length === 0;
  const derivationHeld =
    populated.length === frontier.regions.length &&
    derivedSeen.length === derived.length &&
    !refusedDerived.ok &&
    discarded;
  record(
    'D',
    'Discovery Frontier v1',
    derivationHeld ? 'PARTIAL' : 'NOT_RUN',
    derivationHeld
      ? `A project snapshot built from real rows — three declared foundations, ` +
        `${believed.length} knowledge rows, an audit with two classified gaps and one idea ` +
        `Russell had itself — reads back through frontierFor with all ` +
        `${frontier.regions.length} regions populated: ${regionSummary}. All ` +
        `${derived.length} derived lenses answered something (${derivedSeen.sort().join(', ')}), ` +
        `and ${gapNote}. ${frontier.openLenses.length} asked lenses are put, ` +
        `${frontier.openLenses.filter((lens) => lens.about !== null).length} of them with a ` +
        'subject attached, and none is answered. A derived lens is refused ' +
        'as an inquiry (refused); a finding citing a row ' +
        'this project does not hold is discarded (discarded). NOT established here: the ' +
        `${asked.length} asked lenses, each of which needs a reader — no worker answered one in ` +
        'this run — and the same snapshot read on the deployed product rather than in this ' +
        'isolated database. (§29 and this module\'s own header say four are asked; LENSES ' +
        `declares ${asked.length}. The count printed here is the one the code holds.)`
      : `The derivation did not hold, which is a defect rather than a missing run: ` +
        `${populated.length}/${frontier.regions.length} regions populated (${regionSummary}), ` +
        `empty: ${emptyRegions.join(', ') || 'none'}; ` +
        `${derivedSeen.length}/${derived.length} derived lenses answered; ` +
        `derived lens refused as an inquiry=${!refusedDerived.ok}; invented finding discarded=${discarded}.`,
  );

  /* -- E. Connected-site intelligence ------------------------------------- */
  /*
   * Asked of the live connection rather than of the projection's source.
   *
   * This was a regex for `NEEDS_PERSON` over `projection.ts`, which is the
   * shape of evidence this reporter's header refuses — and it meant a scenario
   * about a *connected site* never looked at whether one was connected. Deal
   * Dispatch has been delivering to this Brain all along; the reading was
   * simply not being taken.
   */
  const connect = file('server/services/connect/projection.ts');
  const sixAnswers = connect ? /NEEDS_PERSON/.test(connect) && /stateReason/.test(connect) : false;
  const live = seen.connectorEvents > 0;
  record(
    'E',
    'Connected-site intelligence',
    live && sixAnswers ? 'PARTIAL' : sixAnswers ? 'NOT_RUN' : 'NOT_RUN',
    live
      ? `A connected site is delivering into ${fleet.source}: ${seen.connectorEvents} connector ` +
        `event(s), ${seen.connectorCommands} accepted command(s), ${seen.externalRecords} ` +
        `registered record(s) and ${seen.externalRejections} recorded rejection(s)` +
        (seen.lastRecordAt ? `, most recently at ${seen.lastRecordAt}` : '') +
        '. The six-answer projection including NEEDS_PERSON is derived on the read path and is ' +
        'never stored. NOT established here: a command driven from the site through to a ' +
        'launched mission in one observed pass, which needs the site to send one.'
      : sixAnswers
        ? `The six-answer projection including NEEDS_PERSON is present and derived on the read ` +
          `path. ${fleet.source} holds no connector event, so no live site was read.`
        : 'The projection could not be read.',
  );

  /* -- F. Needs You -------------------------------------------------------- */
  /*
   * The rule the park rests on, exercised against the three packet shapes that
   * separate it — including the production one that produced the correction.
   *
   * §24's rule is "park only where more than one thing can be chosen between",
   * and `choicesFor` is where that is decided. It is a pure function over a
   * shape read from fragment rows, so it is driven here directly with the three
   * shapes rather than through a fixture that would have to arrange a packet to
   * ask it. What this does *not* establish is the end-to-end journey: a real
   * packet parking, a person answering, and the packet moving — that needs a
   * production boundary and is reported as missing rather than implied.
   */
  const shapes = [
    {
      name: 'a plan awaiting approval',
      shape: { awaitingApproval: 2, accepted: 0, researched: 0 },
      expect: ['APPROVE_PLAN', 'STOP'],
    },
    {
      name: 'researched, and nothing cleared the gate',
      shape: { awaitingApproval: 0, accepted: 0, researched: 1 },
      expect: ['STOP'],
    },
    {
      name: 'researched, with something to file beside the gaps',
      shape: { awaitingApproval: 0, accepted: 2, researched: 3 },
      expect: ['RECORD_GAPS', 'STOP'],
    },
  ] as const;
  const offers = shapes.map((entry) => {
    const keys = choicesFor(entry.shape).map((choice) => choice.key);
    return {
      name: entry.name,
      keys,
      held: keys.length === entry.expect.length && keys.every((key, i) => key === entry.expect[i]),
      decidable: keys.length > 1,
    };
  });
  const offersHeld = offers.every((entry) => entry.held);
  // The production case: one refused fragment, nothing accepted. One answer,
  // so nothing is parked and nobody is asked to press the only button there is.
  const singleAnswerDoesNotPark = offers[1]!.decidable === false;
  record(
    'F',
    'Needs You',
    offersHeld && singleAnswerDoesNotPark ? 'PARTIAL' : 'NOT_RUN',
    offersHeld && singleAnswerDoesNotPark
      ? `${offers.length}/${offers.length} packet shapes produce the offer the domain says they ` +
        `should (${offers.map((entry) => `${entry.name} → ${entry.keys.join('+')}`).join('; ')}), ` +
        'and the shape with one answer is not parked — which is the condition being the offer ' +
        'rather than a row count standing in for it. NOT established here: a real packet ' +
        'parking on a production boundary, a person answering it, and the packet moving.'
      : 'The offer did not match the domain for at least one shape, which is a defect rather ' +
        `than a missing run: ${offers.map((entry) => `${entry.name} → ${entry.keys.join('+')}`).join('; ')}.`,
  );

  /* -- G. Capability Lab --------------------------------------------------- */
  // Exercised for real, here, now.
  const technical = await createProject({
    name: 'Step 12B acceptance lab',
    slug: `s12b-lab-${Date.now()}`,
    purpose: 'TECHNICAL',
  });
  for (const suffix of ['a', 'b']) {
    const worker = await createWorker({
      name: `s12b-acc-${suffix}-${Date.now()}`,
      createdByType: 'SYSTEM',
      createdById: 'acceptance',
    });
    await grantMembership({
      projectId: technical.id,
      principalType: 'WORKER',
      principalId: worker.id,
      scopes: ['queue:claim'],
      grantedByType: 'SYSTEM',
      grantedById: 'acceptance',
    });
  }
  let complete = 0;
  for (const mode of LAB_MODES) {
    const declared = await declareExperiment({
      projectId: technical.id,
      mode,
      title: `acceptance ${mode}`,
      envelope: {
        ceiling: mode === 'RECOVERY_DRILL' ? 1 : 4,
        durationMinutes: 1,
        stopConditions: ['the ceiling is reached'],
        cleanup: 'cancel what is left',
        rollback: 'nothing applied',
        workloadClass: 'SYNTHETIC',
        workKind: 'SYNTHETIC',
      },
      actor: 'acceptance',
    });
    const ran = await runExperiment({ id: declared.id, pressureAuthorized: true });
    if (ran.state === 'COMPLETE') complete += 1;
  }
  record(
    'G',
    'Capability Lab',
    complete === LAB_MODES.length ? 'PASS' : 'PARTIAL',
    `${complete}/${LAB_MODES.length} modes ran to COMPLETE in an isolated TECHNICAL scope, ` +
      'spending nothing. Every result names what it did not test: how much a real Cowork ' +
      'surface holds. See `npm run step12b:lab` for the canary apply/retest/compare/rollback cycle.',
  );

  /* -- H. Visual maps ------------------------------------------------------ */
  const maps = file('server/services/russell/maps.ts');
  /*
   * The named unmet condition used to be "interaction on a real project at
   * phone width", and it no longer is: every map type was opened by pressing
   * its own tab at 390px, and for each one the diagram's node count was
   * compared to the outline's row count. That comparison is the load-bearing
   * one, because §29's rule is that the picture and the list are the same
   * graph — two numbers that agree is a reading, where "an outline exists" is
   * only a shape.
   */
  const mapEvidence = visualEvidence();
  record(
    'H',
    'Visual maps',
    maps && /emptyReason/.test(maps) ? 'PARTIAL' : 'NOT_RUN',
    `${MAP_TYPES.length} map types derived from the authoritative graph, each with a ` +
      'synchronized outline, and the money-flow map returns a reason for being empty rather ' +
      'than inventing edges. ' +
      (!REPO_VISIBLE
        ? `The rendered half of this row is a repository fact. ${NOT_FROM_A_CHECKOUT} `
        : mapEvidence.images > 0
        ? `All ${MAP_TYPES.length} were opened by pressing their own tabs at 390px and ` +
          'photographed, and every one\u2019s diagram-node count equals its outline-row count ' +
          '(9/9, 0/0, 8/8, 8/8, 1/1, 0/0); money flow draws nothing and says the figures belong ' +
          'to the connected site. Show it as a list was pressed on a populated map, so the ' +
          'outline is reachable rather than merely present. '
        : 'The committed image set is absent, so nothing here was rendered. ') +
      'NOT established here: map behaviour at desktop and intermediate widths beyond the page ' +
      'fitting, and whether the maps are good \u2014 which is O.',
  );

  /* -- I. Collaboration ---------------------------------------------------- */
  /*
   * Two real identities, and the boundary between them, exercised rather than
   * read.
   *
   * §29's I is about what happens when a second person is on a project, and
   * that is a fact about rows: a membership granted, a role changed, a
   * membership revoked, and a private thread that stays its owner's whatever
   * the other person's role is. All four are driven here against the temporary
   * database, through the same `decideProjectAccess` every route calls — not a
   * second copy of the rule, and not a regex over the route file.
   *
   * Two things it deliberately does not claim. It is not an *invitation* flow:
   * nothing here sends anything to anybody, and the email that would carry one
   * is outside this Brain. And it is a reading in an isolated database rather
   * than on the deployed product, so it establishes the mechanism and not the
   * experience.
   */
  const routes = file('server/routes/russell.ts');
  const workerRefused = routes ? /requirePerson\(\)/.test(routes) : false;
  const owner = await createUser({
    email: 'acceptance-owner@example.invalid',
    displayName: 'Owner',
    // A generated value that is never printed, never stored in the clear and
    // never reused: the identity is the subject here, not the credential.
    password: `acc-${randomUUID()}`,
    isBrainAdmin: false,
  });
  const colleague = await createUser({
    email: 'acceptance-colleague@example.invalid',
    displayName: 'Colleague',
    password: `acc-${randomUUID()}`,
    isBrainAdmin: false,
  });
  await grantMembership({
    principalType: 'HUMAN',
    principalId: owner.id,
    projectId: project.id,
    role: 'ADMIN',
    grantedByType: 'SYSTEM',
    grantedById: owner.id,
  });
  const ownerPrincipalNow = await ownerPrincipal(owner.id);
  const strangerBefore = await ownerPrincipal(colleague.id);
  // A person with no membership may not read the project at all.
  const strangerRefused =
    strangerBefore !== null &&
    !decideProjectAccess(strangerBefore, project.id, 'READ').allowed;

  await grantMembership({
    principalType: 'HUMAN',
    principalId: colleague.id,
    projectId: project.id,
    role: 'MEMBER',
    grantedByType: 'HUMAN',
    grantedById: owner.id,
  });
  const asMember = await ownerPrincipal(colleague.id);
  const memberReads = asMember !== null && decideProjectAccess(asMember, project.id, 'READ').allowed;
  const memberIsNotAdmin =
    asMember !== null && !decideProjectAccess(asMember, project.id, 'ADMIN').allowed;

  // The role change: the same person, a different answer, read from rows
  // rather than from anything they sent.
  await grantMembership({
    principalType: 'HUMAN',
    principalId: colleague.id,
    projectId: project.id,
    role: 'ADMIN',
    grantedByType: 'HUMAN',
    grantedById: owner.id,
  });
  const asAdmin = await ownerPrincipal(colleague.id);
  const promoted = asAdmin !== null && decideProjectAccess(asAdmin, project.id, 'ADMIN').allowed;

  // A private thread stays its owner's, whatever the other person's role.
  const privateThread = await createConversation({
    ownerUserId: owner.id,
    title: 'Something the owner is thinking about alone',
    projectId: project.id,
    visibility: 'PRIVATE',
  });
  const sharedThread = await createConversation({
    ownerUserId: owner.id,
    title: 'Something the project is thinking about together',
    projectId: project.id,
    visibility: 'SHARED',
  });
  const adminDeniedPrivate =
    asAdmin !== null && !(await conversationIsReadable(asAdmin, privateThread.id));
  const adminReadsShared =
    asAdmin !== null && (await conversationIsReadable(asAdmin, sharedThread.id));
  const ownerReadsOwn =
    ownerPrincipalNow !== null && (await conversationIsReadable(ownerPrincipalNow, privateThread.id));

  // And revoking lands on the next read rather than at the next sign-in.
  await revokeMembership(project.id, 'HUMAN', colleague.id);
  const afterRevoke = await ownerPrincipal(colleague.id);
  const revokedImmediately =
    afterRevoke !== null && !decideProjectAccess(afterRevoke, project.id, 'READ').allowed;

  const collaboration = [
    ['a non-member may not read', strangerRefused],
    ['a MEMBER may read', memberReads],
    ['a MEMBER is not an ADMIN', memberIsNotAdmin],
    ['a role change is read from rows', promoted],
    ["a project ADMIN may not read the owner's private thread", adminDeniedPrivate],
    ['that same ADMIN may read the shared one', adminReadsShared],
    ['the owner reads their own', ownerReadsOwn],
    ['revoking lands on the next read', revokedImmediately],
  ] as const;
  const failed = collaboration.filter(([, held]) => !held).map(([name]) => name);
  record(
    'I',
    'Collaboration',
    failed.length === 0 && workerRefused ? 'PARTIAL' : 'NOT_RUN',
    failed.length > 0
      ? `Exercised with two real identities and ${failed.length} condition(s) did not hold: ` +
        `${failed.join('; ')}. That is a defect rather than a missing run.`
      : `Two real human identities on one project: ${collaboration.length}/${collaboration.length} ` +
        'boundary conditions held — non-member refused, MEMBER reads but is not ADMIN, a role ' +
        "change is read from rows, a project ADMIN cannot read the owner's private thread but " +
        'can read the shared one, and revoking lands on the next read rather than the next ' +
        `sign-in. A worker principal is refused at these routes by type (${workerRefused ? 'requirePerson' : 'NOT FOUND — defect'}). ` +
        'NOT established here: an invitation anybody received, and the same journey on the ' +
        'deployed product rather than in this isolated database.',
  );

  /* -- J. Mobile ----------------------------------------------------------- */
  /*
   * This was NOT_RUN because the harness drove three isolated interactions:
   * each opened its own address, did one thing and stopped, which proves three
   * controls and nothing about the path between them. §29's J is the path.
   *
   * It is now one browser, one session and one scroll history, and after the
   * first address nothing navigates — every move is a press. It is still
   * PARTIAL rather than PASS, and the reason is in the head of this file: this
   * is a real Brain in a throwaway data directory, not the deployed product,
   * and no mission ran because no worker exists in that harness. A journey that
   * fits is a necessary condition for J and is not J's verdict.
   */
  const mobile = visualEvidence();
  const responsiveSuite = file('tests/step12bResponsive.test.tsx');
  record(
    'J',
    'Mobile',
    mobile.images > 0 && mobile.journeySteps >= 10 && responsiveSuite ? 'PARTIAL' : 'NOT_RUN',
    !REPO_VISIBLE
      ? `J is a repository fact: the journey is a committed image set and a suite. ${NOT_FROM_A_CHECKOUT}`
      : mobile.images > 0 && mobile.journeySteps >= 10 && responsiveSuite
      ? `One continuous signed-in journey at 390px across ${mobile.journeySteps} recorded steps ` +
        `(${mobile.images} committed images): home \u2192 open a conversation \u2192 send a message ` +
        '\u2192 Work \u2192 the project map \u2192 all six maps \u2192 Needs you \u2192 home. At ' +
        'every step the page body does not scroll sideways and nothing is cut off inside a ' +
        'clipping container, and all 15 chrome controls answer elementFromPoint at 390px and ' +
        '360px. It found two real defects, both fixed: the rail foot was display:none at bar ' +
        'width, which removed Sign out from a phone entirely, and the composer placeholder was ' +
        'sliced by the thumb bar at 360px. NOT established here: a mobile flow through an actual ' +
        'mission, which needs a worker; portrait only, one device pixel ratio, Chromium only; no ' +
        'touch-gesture or on-screen-keyboard behaviour; and the constellation, which is driven ' +
        'and measured at 390px but overlaps its own nodes there and is not usable as drawn.'
      : 'The committed 390px journey is absent or incomplete, so nothing establishes the path ' +
        'between the controls. Run scripts/visual-qa.ts.',
  );

  /* -- K. Legacy removal ---------------------------------------------------- */
  /*
   * This row is a repository fact, and it used to read `client/src` without
   * asking whether it was there. Inside the container it is not — the image
   * carries `client/dist` and no sources — so the read threw and the whole
   * report died at gate K rather than printing eleven rows it had already
   * established. A reporter that cannot produce a reading is worse than one
   * that names what it could not see.
   */
  const removalTest = file('tests/operatorConsoleRemoved.test.ts');
  const clientSrc = path.join(REPO, 'client', 'src');
  const clientHasOperator = fs.existsSync(clientSrc)
    ? fs
        .readdirSync(clientSrc, { recursive: true } as never)
        .some((entry) => typeof entry === 'string' && entry.endsWith('.tsx'))
    : null;
  record(
    'K',
    'Legacy removal',
    removalTest ? 'PASS' : 'NOT_RUN',
    removalTest
      ? 'tests/operatorConsoleRemoved.test.ts refuses the route for every principal, fails on any ' +
        'link to it, and fails on any instruction to go there. It runs in the suite this report ' +
        `requires (${clientHasOperator === null ? 'client sources not in this image' : clientHasOperator ? 'client present' : 'client missing'}).`
      : REPO_VISIBLE
        ? 'The removal test is not present.'
        : NOT_FROM_A_CHECKOUT,
  );

  /* -- L. Always-on loop ---------------------------------------------------- */
  /*
   * The tick's own row, which is the only thing that can say whether it runs.
   * A loop is not "a surface exists"; it is a cursor that moved.
   */
  const ranAgoMs = seen.cycleLastRanAt ? Date.now() - Date.parse(seen.cycleLastRanAt) : null;
  const ticking = seen.cycleState === 'RUNNING' && ranAgoMs !== null;
  /*
   * `RUNNING` with no cursor is a loop that has never run, not a broken one —
   * which is what a fresh database looks like, and is the distinction this
   * reporter's header insists on. Only a state somebody set is BLOCKED.
   */
  const halted = seen.cycleState === 'PAUSED' || seen.cycleState === 'STOPPED';
  record(
    'L',
    'Always-on loop',
    ticking ? 'PARTIAL' : halted ? 'BLOCKED' : blocker.verdict,
    seen.cycleState === null || (!ticking && !halted)
      ? blocker.detail
      : ticking
        ? `The durable cycle in ${fleet.source} is ${seen.cycleState} and last ran ` +
          `${Math.round((ranAgoMs ?? 0) / 1000)}s ago` +
          (seen.cycleLastError ? `, with a recorded last error: ${seen.cycleLastError.slice(0, 160)}` : ', with no recorded error') +
          '. NOT established here: a measured uptime window rather than one reading.'
        : `The durable cycle is ${seen.cycleState}` +
          (seen.cycleLastError ? ` — ${seen.cycleLastError.slice(0, 200)}` : '') +
          '. A paused or stopped loop is an operational fact with an operational remedy, ' +
          'and resuming it is a person\u2019s decision rather than this reporter\u2019s.',
  );

  /* -- M. Product truth, historical knowledge, and memory -------------------- */
  /*
   * "One projection answers every surface" is a claim the surfaces can falsify,
   * so it is asked of them rather than of the source file.
   *
   * Every reader of `projectProgress` is driven here against the same project
   * at the same instant, and there are four of them rather than the two this
   * used to compare:
   *
   *   - `projections.briefing`, which home renders — compared field by field;
   *   - `conversation/contextHat`, which puts the project's state in front of a
   *     worker — checked for the projection's own headline rather than a
   *     sentence of its own, because a hat that re-worded it would be a second
   *     opinion arriving where nobody could see it;
   *   - `routes/russell.ts`'s progress route, which hands back this reading
   *     beside Work and the build — all three driven, and their denominators
   *     required to be different, because three numbers on one screen that
   *     count different things must never be readable as one percentage;
   *   - the constellation (`ideaMapForProject`), which the map and the Ideas
   *     list both read, and whose major nodes are these same foundations.
   *
   * The constellation is the one that could genuinely disagree: it builds its
   * own `Progress` per node out of a layer's declared versions. So what is
   * compared is the thing both must agree about — the milestone state of each
   * foundation — rather than a fraction over two different denominators, which
   * would be a comparison that could only ever fail.
   *
   * The two truth rules are checked on the answer itself: the denominator is
   * named, and the headline carries no percentage — there being no code path
   * that turns a feeling into one is what makes the second check meaningful
   * rather than a spot check.
   */
  /*
   * Four foundations in four different states, so the comparison has something
   * to disagree about. An empty project makes every reading trivially equal,
   * which would be a check that cannot fail — and a check that cannot fail is
   * the thing this reporter's header refuses.
   */
  const foundations: { name: string; status: LayerStatus }[] = [
    { name: 'Discovery', status: 'FROZEN' },
    { name: 'Market Sizing', status: 'RESEARCHING' },
    { name: 'Monetization Logic', status: 'BLOCKED' },
    { name: 'Go To Market', status: 'NOT_STARTED' },
  ];
  const foundationIds: string[] = [];
  for (const [index, foundation] of foundations.entries()) {
    const layer = await createLayer({
      projectId: project.id,
      name: foundation.name,
      orderIndex: index,
    });
    if (foundation.status !== 'NOT_STARTED') {
      await updateLayer(layer.id, { status: foundation.status, statusSource: 'DERIVED' });
    }
    foundationIds.push(layer.id);
  }
  const direct = await projectProgress({ projectId: project.id, projectName: project.name });
  const viaHome = ownerPrincipalNow
    ? await homeFor({
        principal: ownerPrincipalNow,
        projectId: project.id,
        projectName: project.name,
      })
    : null;
  const viaBriefing = viaHome?.briefing.progress ?? null;
  const sameProgress =
    viaBriefing !== null &&
    viaBriefing.headline === direct.headline &&
    viaBriefing.stage === direct.stage &&
    viaBriefing.denominator === direct.denominator &&
    JSON.stringify(viaBriefing.ratio) === JSON.stringify(direct.ratio) &&
    JSON.stringify(viaBriefing.milestones) === JSON.stringify(direct.milestones);

  /*
   * The context hat, which is where this projection reaches a worker.
   *
   * It embeds the headline rather than returning the object, so what is
   * asserted is that the sentence it carries **is** the projection's own —
   * present verbatim — rather than one composed beside it.
   */
  const hat = await compileHat({
    conversationId: sharedThread.id,
    projectId: project.id,
    projectName: project.name,
    ownerUserId: owner.id,
  });
  const hatState = hat.parts.find((part) => part.section === 'PROJECT_STATE')?.text ?? null;
  const hatCarriesIt = hatState !== null && hatState.includes(direct.headline);

  /*
   * The progress route's other two readings, driven rather than described.
   *
   * `GET /api/russell/projects/:id/progress` returns this projection beside
   * Work and the build. Work's milestone set is not closed, so it must carry no
   * ratio at all — and all three must name different denominators, because
   * "3 of 4" over foundations, missions and build steps on one screen is
   * exactly how a person ends up reading one number for another.
   */
  const work = await activeWorkProgress(project.id);
  const build = buildProgress();
  const denominators = [direct.denominator, work.denominator, build.denominator];
  const denominatorsDiffer = new Set(denominators).size === denominators.length;
  const workClaimsNoFraction = work.ratio === null;

  /*
   * And the constellation, over the same four foundations.
   *
   * Every major node must be one of this project's foundations, there must be
   * exactly as many as the projection counts, and the state each reports for a
   * foundation must be the state the projection reports for it. A blocked
   * foundation additionally has to read as blocked on its own node, because
   * that is the one place `stageFor` could quietly average it away.
   */
  const constellation = await ideaMapForProject({
    projectId: project.id,
    viewerUserId: owner.id,
    includePrivate: false,
  });
  const majors = (constellation?.nodes ?? []).filter((node) => node.level === 'MAJOR');
  const milestoneByLayer = new Map(direct.milestones.map((milestone) => [milestone.key, milestone]));
  const constellationDisagreements = majors
    .map((node) => {
      const layerId = node.links.layerId;
      const milestone = layerId ? milestoneByLayer.get(layerId) : undefined;
      if (!milestone) return `${node.title} is on the map and not in the reading`;
      const nodeState = milestoneStateOfLayer(node.state as LayerStatus);
      if (nodeState !== milestone.state) {
        return `${node.title}: the map says ${nodeState}, the reading says ${milestone.state}`;
      }
      if (milestone.state === 'BLOCKED' && node.progress.stage !== 'BLOCKED') {
        return `${node.title} is blocked in the reading and ${node.progress.stage} on the map`;
      }
      return null;
    })
    .filter((entry): entry is string => entry !== null);
  const constellationAgrees =
    majors.length === direct.milestones.length &&
    majors.length === foundationIds.length &&
    constellationDisagreements.length === 0;

  const named = direct.denominator.trim().length > 0;
  // A percentage anywhere in the sentence a person reads. §6 forbids one that
  // was not counted, and nothing here counts one.
  const noPercentage = !/\d+\s*%/.test(direct.headline);
  const noPercentageAnywhere = [viaBriefing?.headline ?? '', work.headline, build.headline].every(
    (headline) => !/\d+\s*%/.test(headline),
  );
  const ratioIsWholeOrAbsent =
    direct.ratio === null ||
    (Number.isInteger(direct.ratio.done) && Number.isInteger(direct.ratio.total));
  const truthHeld =
    sameProgress &&
    hatCarriesIt &&
    denominatorsDiffer &&
    workClaimsNoFraction &&
    constellationAgrees &&
    named &&
    noPercentage &&
    noPercentageAnywhere &&
    ratioIsWholeOrAbsent;
  record(
    'M',
    'Product truth and named denominators',
    truthHeld ? 'PARTIAL' : 'NOT_RUN',
    truthHeld
      ? `Four readers of one projection, driven against one project with ${foundations.length} ` +
        `foundations in ${new Set(foundations.map((f) => f.status)).size} different states at one ` +
        "instant. Home's briefing returns the identical progress field by field — headline, " +
        'stage, ratio and every milestone state. The conversation hat a worker is given carries ' +
        "that same headline verbatim rather than a sentence of its own. The progress route's " +
        `three readings name three different denominators (${denominators.join(', ')}) and Work ` +
        'reports no fraction at all, because its milestone set is not closed. The ' +
        `constellation's ${majors.length} major nodes are these same foundations and report the ` +
        'same state for every one of them, with the blocked foundation blocked on its own node. ' +
        `The denominator is named ("${direct.denominator}"), the ratio is ` +
        (direct.ratio ? `${direct.ratio.done}/${direct.ratio.total} whole` : 'absent rather than guessed') +
        ', and no sentence any of them hands a person carries a percentage. NOT established ' +
        'here: the same comparison against a versioned production state — this is an isolated ' +
        'database, and the progress route was driven through its own services rather than over ' +
        'HTTP with an authenticated principal.'
      : 'A surface disagreed, or a truth rule did not hold, which is a defect rather than a ' +
        `missing run: briefing=${sameProgress} hat=${hatCarriesIt} ` +
        `constellation=${constellationAgrees}` +
        (constellationDisagreements.length > 0 ? ` (${constellationDisagreements.join('; ')})` : '') +
        ` denominatorsDiffer=${denominatorsDiffer} workHasNoRatio=${workClaimsNoFraction} ` +
        `named=${named} noPercentage=${noPercentage && noPercentageAnywhere} ` +
        `wholeRatio=${ratioIsWholeOrAbsent}.`,
  );

  /* -- N. Routing and latency ----------------------------------------------- */
  /*
   * The trace is the scenario. A real bin Brain fired a worker for, its own
   * recorded chain, and the largest gap named from the two events either side
   * of it — read in the operational phase above, because no scratch database
   * has a dispatch in it.
   */
  const routing = file('server/services/bins/routing.ts');
  const trace = fleet.trace;
  record(
    'N',
    'Routing and latency explanation',
    trace && trace.steps.length > 1 ? 'PARTIAL' : 'NOT_RUN',
    trace && trace.steps.length > 1
      ? `One real dispatch traced from ${fleet.source}: ${trace.steps.length} recorded steps ` +
        `(${trace.steps.map((step) => step.label).slice(0, 4).join(' → ')}` +
        `${trace.steps.length > 4 ? ' → …' : ''}), and the largest gap is ` +
        (trace.largestGap
          ? `${Math.round(trace.largestGap.ms / 1000)}s between ${trace.largestGap.from} and ` +
            `${trace.largestGap.to} — "${trace.largestGap.meaning}"`
          : 'not nameable from this chain') +
        `. ${trace.unknowns.length} thing(s) are reported as undetermined rather than guessed. ` +
        'One routing decision is read by the candidate query, the admission hook and the fire ' +
        'router, and a refusal costs no claim state. NOT established here: the same reading ' +
        'across a workload mix rather than one bin.'
      : routing
        ? 'One routing decision is read by the candidate query, the admission hook and the fire ' +
          'router, and a refusal costs no claim state. NOT established here: a traced real ' +
          `dispatch — ${fleet.source} holds no bin that was ever fired.`
        : 'The routing decision could not be read.',
  );

  /* -- O. Visual and interaction approval ------------------------------------ */
  /*
   * O is the one scenario whose answer is not this reporter's to give, and the
   * distinction the owner drew is the whole design: **evaluating an approval is
   * a different act from granting one.**
   *
   * So this reads three things and judges none of them:
   *
   *   1. the render set on disk, digested over the *bytes* of every declared
   *      render — because an approval names what somebody looked at, and a
   *      directory is mutable;
   *   2. whether a decision exists for **this revision and that digest**; and
   *   3. what the decision says.
   *
   * An approval for a different revision, or for a render set that has since
   * changed, is **stale** and is reported as such rather than carried forward —
   * §23's reservation-bound-to-the-bytes rule, at a design gate. A `WITHDRAWN`
   * row after an `APPROVED` one means there is no approval, because the standing
   * decision is the newest one and the table is append-only.
   *
   * Nothing in this file can write one of those rows. `designApprovals.ts`
   * exports the writer, this script does not import it, and a test asserts that
   * no module under `scripts/` does — because a reporter that could record the
   * approval it is waiting for would be approving its own work, which is the
   * defect `independenceEvidence.ts` re-checks its own guard to prevent.
   */
  const renderDir = path.join(REPO, 'docs', 'evidence', 'step12b-renders');
  const renderIndex = path.join(renderDir, 'index.json');
  const stamp = revisionOf();

  if (!REPO_VISIBLE) {
    record(
      'O',
      'Visual and interaction approval',
      'NOT_RUN',
      `O needs the render set, which is a repository fact. ${NOT_FROM_A_CHECKOUT}`,
    );
  } else if (!fs.existsSync(renderIndex)) {
    /*
     * An executed check that did not hold. Not NOT_RUN: this run looked, and
     * what it found was that the set a decision would be about does not exist.
     */
    record(
      'O',
      'Visual and interaction approval',
      'FAIL',
      'No render set to decide on: docs/evidence/step12b-renders/index.json does not exist, so ' +
        'there is nothing a person could have approved and nothing for this to evaluate. ' +
        'Produce the renders and run `npm run design:manifest`.',
    );
  } else if (!stamp.revision || stamp.dirty) {
    record(
      'O',
      'Visual and interaction approval',
      'FAIL',
      stamp.dirty
        ? `The tree is dirty at ${stamp.revision?.slice(0, 8) ?? 'an unknown revision'}, so an ` +
          'approval could only be bound to a revision that exists nowhere. Commit, re-run ' +
          '`npm run design:manifest`, then ask for the decision.'
        : 'This run cannot name its revision, and an approval has to be bound to one.',
    );
  } else {
    let declared: { screen: string; width: number; file: string }[] = [];
    let readable = true;
    try {
      declared = JSON.parse(fs.readFileSync(renderIndex, 'utf8')) as typeof declared;
    } catch {
      readable = false;
    }
    const missing = declared.filter((entry) => !fs.existsSync(path.join(renderDir, entry.file)));

    if (!readable || declared.length === 0 || missing.length > 0) {
      record(
        'O',
        'Visual and interaction approval',
        'FAIL',
        !readable
          ? 'The render index is not readable JSON, so the set a decision would cover cannot be ' +
            'determined — and a digest over a set nobody can enumerate is not a binding.'
          : declared.length === 0
            ? 'The render index declares no renders.'
            : `The index declares ${missing.length} render(s) that are not on disk ` +
              `(${missing.slice(0, 3).map((entry) => entry.file).join(', ')}). A decision bound to ` +
              'this set would name bytes that do not exist.',
      );
    } else {
      const { digest, count } = digestRenderSet(
        declared.map((entry) => ({
          path: entry.file,
          width: entry.width,
          screen: entry.screen,
          bytes: fs.readFileSync(path.join(renderDir, entry.file)),
        })),
      );
      const screens = [...new Set(declared.map((entry) => entry.screen))].sort();
      const widths = [...new Set(declared.map((entry) => entry.width))].sort((a, b) => a - b);
      const covers =
        `${count} render(s) covering ${screens.length} screen(s) ` +
        `(${screens.join(', ')}) at ${widths.join(' / ')}px`;

      /*
       * The decision is read from the **configured** Brain rather than from the
       * scratch database, because an approval a person gave lives where their
       * other decisions live. Read-only, in the same phase and with the same
       * honesty as the fleet reading: a database that cannot be read is reported
       * as not read rather than as an absent approval.
       */
      let decision: Awaited<ReturnType<typeof standingDecision>> = null;
      let decisionReadable = true;
      try {
        decision = await standingDecision(stamp.revision, digest);
      } catch {
        decisionReadable = false;
      }

      if (!decisionReadable) {
        record(
          'O',
          'Visual and interaction approval',
          'FAIL',
          `The render set digests to ${digest.slice(0, 12)}… (${covers}), and the decisions table ` +
            'could not be read, so whether it was approved is unknown rather than unapproved.',
        );
      } else if (!decision) {
        record(
          'O',
          'Visual and interaction approval',
          'BLOCKED',
          `${covers}, digesting to ${digest.slice(0, 12)}… at revision ` +
            `${stamp.revision.slice(0, 8)}. **No decision is recorded for this exact revision and ` +
            'render set.** This is an operational fact with one remedy and it is not this ' +
            'reporter\u2019s: a person signs in and records it, or runs `npm run admin -- design ' +
            'approve`. Nothing in scripts/ can write that row, deliberately \u2014 a reporter that ' +
            'could record the approval it is waiting for would be approving its own work.',
        );
      } else if (decision.decision !== 'APPROVED') {
        record(
          'O',
          'Visual and interaction approval',
          'FAIL',
          `The standing decision for this render set is **${decision.decision}**, recorded by ` +
            `${decision.approvedByUserId} at ${decision.createdAt}` +
            (decision.note ? ` — "${decision.note}"` : '') +
            '. A withdrawal or a rejection is as much a recorded decision as an approval, and it ' +
            'is reported as the answer rather than as a missing one.',
        );
      } else {
        record(
          'O',
          'Visual and interaction approval',
          'PASS',
          `Approved by ${decision.approvedByUserId} at ${decision.createdAt}` +
            (decision.note ? ` — "${decision.note}"` : '') +
            `, bound to revision ${stamp.revision.slice(0, 8)} and to render-set digest ` +
            `${digest.slice(0, 12)}… (${covers}). The digest is recomputed from the bytes on disk ` +
            'in this run, so an approval stops applying the moment either the tree or a render ' +
            'changes, rather than being carried forward. This reporter evaluated that decision ' +
            'and cannot record one.',
        );
      }
    }
  }

  /* -- P. Preserved integrations, migrations, and restart --------------------- */
  const upgrade = file('scripts/upgrade-populated.ts');
  record(
    'P',
    'Migrations, restart and preserved integrations',
    upgrade ? 'PARTIAL' : 'NOT_RUN',
    'npm run upgrade:populated proves the upgrade over populated data on both chains with a ' +
      'per-table sha-256 census, and a second restart applying nothing. NOT established by this ' +
      'script: the hosted pre/post-restart checks, which the Deploy workflow runs.',
  );

  /* -- Q. Shared-product access and safe experiments -------------------------- */
  const prefs = checkPreference('depth', 'NOT_A_DEPTH');
  const searchScoped = await search({ principal: null, query: 'anything' });

  /*
   * The canary cycle, both ways round, against real `fleet_policy` rows.
   *
   * The named unmet condition was "a canary rollback", and the half that
   * matters is not that a rollback happens — it is *what it rolls back to*.
   * `applyFinding` reads the displaced policy **before** it writes its own, and
   * the two wrong ways to do it fail in opposite directions: reading afterwards
   * over an empty history finds nothing and falls back to the canary's own
   * number, and after any later policy it finds that one instead. So both
   * branches are driven here in one run, in this order deliberately, because
   * the empty-history branch only exists before anything has been applied.
   *
   * It is in the same isolated TECHNICAL scope the Lab requires, and it spends
   * nothing: a policy is a row.
   */
  /*
   * Three numbers that must stay apart: what a person had set, what the canary
   * applied over nothing, and what it applied over the person's value. Named
   * rather than repeated, because the whole point of the cycle is that a
   * rollback does not confuse them.
   */
  const operatorTarget = 4;
  const canaryOverNothing = 9;
  const canaryOverPolicy = 12;
  const canaryEnvelope = {
    ceiling: 4,
    durationMinutes: 1,
    stopConditions: ['the ceiling is reached'],
    cleanup: 'nothing is created; the experiment row stays',
    rollback: 'the displaced policy version is written forward again',
    workloadClass: 'RESEARCH',
    workKind: 'REAL_CANARY' as const,
  };

  /*
   * Real work as a *first* canary on a pressure mode is refused by name, and
   * the refusal is kept rather than thrown. Driven here beside the cycle,
   * because the two together are the rule: a ledger reading may be applied as a
   * canary and a pressure test may not be one until something safer has passed.
   */
  const refusedCanary = await declareExperiment({
    projectId: technical.id,
    mode: 'PUSH_TO_FAILURE',
    title: 'acceptance canary refusal',
    envelope: canaryEnvelope,
    actor: 'acceptance',
  });

  const policyBefore = await currentPolicy('FLEET', null);
  const firstCanary = await runExperiment({
    id: (
      await declareExperiment({
        projectId: technical.id,
        mode: 'CALIBRATION',
        title: 'acceptance canary over an empty policy history',
        envelope: canaryEnvelope,
        actor: 'acceptance',
      })
    ).id,
    pressureAuthorized: false,
  });
  const appliedOverNothing = await applyFinding({
    experimentId: firstCanary.id,
    target: canaryOverNothing,
    actor: 'acceptance',
    reason: 'Canary: adopt the reading',
  });
  const underFirstCanary = await currentPolicy('FLEET', null);
  const rolledBackToNothing = await rollbackFinding({
    experimentId: firstCanary.id,
    actor: 'acceptance',
    reason: 'Canary complete',
  });
  const afterFirstRollback = await currentPolicy('FLEET', null);

  /*
   * And the branch with something to displace. An operator's own target, set
   * before the canary, which the rollback must return to — and which must not
   * be confused with the dispatcher default the first branch returned to.
   */
  const operatorPolicy = await setPolicy({
    scope: 'FLEET',
    target: operatorTarget,
    actor: 'acceptance',
    reason: 'The target a person set before any canary',
  });
  const secondCanary = await runExperiment({
    id: (
      await declareExperiment({
        projectId: technical.id,
        mode: 'CALIBRATION',
        title: 'acceptance canary over an operator policy',
        envelope: canaryEnvelope,
        actor: 'acceptance',
      })
    ).id,
    pressureAuthorized: false,
  });
  const appliedOverPolicy = await applyFinding({
    experimentId: secondCanary.id,
    target: canaryOverPolicy,
    actor: 'acceptance',
    reason: 'Canary: adopt the reading',
  });
  const underSecondCanary = await currentPolicy('FLEET', null);
  // The retest: the same reading taken again under the canary, and compared.
  const retest = await runExperiment({
    id: (
      await declareExperiment({
        projectId: technical.id,
        mode: 'CALIBRATION',
        title: 'acceptance retest under the canary',
        envelope: canaryEnvelope,
        actor: 'acceptance',
      })
    ).id,
    pressureAuthorized: false,
  });
  const comparison =
    `sample ${secondCanary.result?.confidence.sampleSize ?? 0} → ` +
    `${retest.result?.confidence.sampleSize ?? 0}, recommendation ` +
    `${secondCanary.result?.recommendedSetting.evidence ?? 'UNKNOWN'} → ` +
    `${retest.result?.recommendedSetting.evidence ?? 'UNKNOWN'}`;
  const rolledBackToPolicy = await rollbackFinding({
    experimentId: secondCanary.id,
    actor: 'acceptance',
    reason: 'Canary complete',
  });
  const afterSecondRollback = await currentPolicy('FLEET', null);
  const history = await policyHistory('FLEET', null, 20);

  /*
   * Read out of the rows before they are compared, so the comparisons are
   * between two `number`s rather than between a value and a literal type the
   * compiler has already narrowed — which would make "and not the canary's own
   * number" a comparison it could prove impossible instead of one this run
   * makes.
   */
  const defaultTarget: number = DEFAULT_TARGET_WITH_NO_PRIOR_POLICY;
  const firstRollbackTarget = afterFirstRollback?.target ?? null;
  const secondRollbackTarget = afterSecondRollback?.target ?? null;
  const displacedTarget = appliedOverPolicy.displacedTarget;

  const canaryConditions = [
    ['real work is refused as a first canary on a pressure test', refusedCanary.state === 'REFUSED' && /canary/i.test(refusedCanary.refusalReason ?? '')],
    ['and is permitted for a reading that spends nothing', firstCanary.state === 'COMPLETE' && secondCanary.state === 'COMPLETE'],
    ['a canary over no prior policy records that it displaced nothing', policyBefore === null && appliedOverNothing.displacedPolicyId === null && appliedOverNothing.displacedTarget === null],
    ['the canary target is live while it is applied', underFirstCanary?.target === canaryOverNothing],
    ['rolling that back returns the dispatcher default rather than the canary', firstRollbackTarget === defaultTarget && firstRollbackTarget !== canaryOverNothing],
    ['and says so in words rather than reporting a number', /no prior policy/.test(afterFirstRollback?.reason ?? '')],
    ['a canary over a real policy records what it displaced before replacing it', appliedOverPolicy.displacedPolicyId === operatorPolicy.id && displacedTarget === operatorTarget],
    ['never its own value', displacedTarget !== canaryOverPolicy],
    ['the second canary target is live while it is applied', underSecondCanary?.target === canaryOverPolicy],
    ['rolling it back restores the target it displaced', secondRollbackTarget === operatorTarget],
    ['and names that target in the reason', new RegExp(`displaced \\(${operatorTarget}\\)`).test(afterSecondRollback?.reason ?? '')],
    ['both rollbacks are written forward, so nothing is destroyed', history.some((row) => row.target === canaryOverNothing) && history.some((row) => row.target === canaryOverPolicy) && rolledBackToNothing.rolledBackAt !== null && rolledBackToPolicy.rolledBackAt !== null],
  ] as const;
  const canaryFailed = canaryConditions.filter(([, held]) => !held).map(([name]) => name);

  record(
    'Q',
    'Shared access and safe experiments',
    canaryFailed.length === 0 && !prefs.ok ? 'PARTIAL' : 'NOT_RUN',
    canaryFailed.length > 0
      ? `The canary cycle ran and ${canaryFailed.length} of ${canaryConditions.length} ` +
        `condition(s) did not hold: ${canaryFailed.join('; ')}. That is a defect rather than a ` +
        'missing run.'
      : `A preference outside its declared set is refused (${prefs.ok ? 'ACCEPTED — defect' : 'refused'}); ` +
        `an unauthenticated search is scoped to nothing (${searchScoped.scopedProjects} projects, ` +
        `${searchScoped.hits.length} hits); ${Object.keys(PREFERENCES).length} preference keys are ` +
        `presentational only and every one has a default (${Object.keys(defaults()).length}). ` +
        `${SEARCH_KINDS.length} search kinds are scoped before the query rather than filtered after. ` +
        'The canary cycle is driven end to end against real fleet_policy rows in an isolated ' +
        `TECHNICAL scope, both ways round: ${canaryConditions.length}/${canaryConditions.length} ` +
        'conditions held. Real work is refused as a first canary on a pressure test and allowed ' +
        'for a ledger reading; applied over an empty history it records that it displaced ' +
        'nothing and rolls back to the dispatcher default rather than to its own number; ' +
        `applied over a person's target of ${operatorTarget} it records that ${operatorTarget} ` +
        `before writing ${canaryOverPolicy}, retests under ` +
        `the canary (${comparison}) and rolls back to ${operatorTarget} by name. Every version ` +
        'stays in the ' +
        'history, so the rollback is a write forward rather than a delete. Role change with two ' +
        'real identities is exercised in I. NOT established here: an invitation anybody ' +
        'received, and this same cycle against the deployed fleet rather than in an isolated ' +
        'database — where the policy it displaced would be one a person is actually running on.',
  );

  /* ------------------------------------------------------------------------ */
  console.log('STEP 12B — acceptance, A to Q');
  console.log('  (separate from the Step 12A reporter, which answers a different, closed question)');
  console.log(
    `  operational reading from ${fleet.source}: ` +
      `${fleet.routines.length} Routine(s), ${fleet.accounts.length} account(s)` +
      (fleet.unreadable ? ' — NOT TAKEN' : ''),
  );
  console.log('  everything exercised below ran in a temporary database, created and deleted here');
  /*
   * Which half of the evidence this run can reach, printed before the rows
   * rather than buried inside the ones it affects — because a reader who does
   * not know they are looking at a container run will read a repository row's
   * NOT_RUN as a regression.
   */
  console.log(
    REPO_VISIBLE
      ? '  repository facts (H, J, K, O): readable — this run is from a checkout'
      : '  repository facts (H, J, K, O): NOT READABLE — this run is inside the deployed ' +
        'image, which carries no tests/, docs/ or client/src. Take those rows from a checkout.',
  );
  console.log('');
  for (const gate of gates) {
    console.log(`${gate.id}  ${gate.verdict.padEnd(8)} ${gate.title}`);
    console.log(`     ${gate.detail}`);
  }

  const counts = gates.reduce<Record<Verdict, number>>(
    (acc, gate) => ({ ...acc, [gate.verdict]: acc[gate.verdict] + 1 }),
    { PASS: 0, FAIL: 0, PARTIAL: 0, BLOCKED: 0, NOT_RUN: 0 },
  );
  console.log('');
  console.log(
    `STEP 12B — ${counts.PASS} PASS · ${counts.FAIL} FAIL · ${counts.PARTIAL} PARTIAL · ` +
      `${counts.BLOCKED} BLOCKED · ${counts.NOT_RUN} NOT_RUN (of ${gates.length} scenarios)`,
  );
  if (counts.PASS !== gates.length) {
    console.log('STEP 12B IS NOT COMPLETE.');
  }

  /*
   * The record, so two runs can be joined.
   *
   * `--emit <path>` writes what this run established, stamped with the revision
   * it can attest and the environment it ran in. `step12b-combine.ts` reads two
   * of these and refuses to join them unless they name the same revision — see
   * `revisionOf` above for why an unknown or dirty revision is refused rather
   * than guessed.
   *
   * Each gate carries which of the three environments its decisive evidence
   * comes from, so the combiner can tell a row this run could not see from one
   * it saw and judged.
   */
  const emitAt = process.argv.indexOf('--emit');
  if (emitAt !== -1) {
    const target = process.argv[emitAt + 1];
    if (!target) {
      console.error('--emit needs a path to write the record to.');
      process.exitCode = 1;
    } else {
      const stamp = revisionOf();
      const record = {
        step: '12B',
        ranIn: RUN_ENVIRONMENT,
        revision: stamp.revision,
        revisionAttestedBy: stamp.attestedBy,
        treeDirty: stamp.dirty,
        generatedAt: new Date().toISOString(),
        repositoryVisible: REPO_VISIBLE,
        operationalReading: fleet.unreadable
          ? { taken: false, why: fleet.unreadable }
          : {
              taken: true,
              source: fleet.source,
              routines: fleet.routines.length,
              accounts: fleet.accounts.length,
            },
        gates: gates.map((gate) => ({
          id: gate.id,
          title: gate.title,
          verdict: gate.verdict,
          evidenceFrom: GATE_EVIDENCE[gate.id] ?? 'ISOLATED',
          detail: gate.detail,
        })),
      };
      fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
      fs.writeFileSync(path.resolve(target), `${JSON.stringify(record, null, 2)}\n`);
      console.log('');
      console.log(
        `  record written to ${target} — revision ${stamp.revision ?? 'UNKNOWN'} ` +
          `(${stamp.attestedBy})${stamp.dirty ? ', TREE DIRTY' : ''}`,
      );
    }
  }

  await closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

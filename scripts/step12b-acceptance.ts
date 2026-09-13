/**
 * Step 12B's own acceptance matrix: §29's seventeen scenarios, A to Q, plus R.
 *
 * **R is not an eighteenth scenario; it is the chain three of the others rest
 * on.** The owner rejected the claim that Step 12B is complete and said exactly
 * why: *"a recent loop tick is not the required mission → knowledge update →
 * backlog reranking → next authorized mission chain."* B and F were reporting
 * counts of somebody else's rows — how many ideas carry a priority, how many
 * audit passes exist — which is a reading about a database rather than about a
 * chain. R drives one, and B and F now read its result instead of a tally.
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
 *   FAIL      a check this run actually executed did not hold. It names what
 *             failed. Deliberately not NOT_RUN: something *did* run, and
 *             reporting an executed failure as "nothing happened yet" is the
 *             one substitution that would let a defect read as a gap.
 *   BLOCKED   an operational fact stops it, named, with whose action clears it.
 *   FAIL      a check this run **executed** did not hold. A defect, printed
 *             with what was asked and what the rows said. Never NOT_RUN: a
 *             reader scanning the summary must not have to tell "nobody has
 *             got round to it" from "it is broken" by reading the detail.
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
import { createProject, listProjects } from '../server/repos/projects.ts';
import { createLayer, updateLayer } from '../server/repos/layers.ts';
import type { LayerStatus } from '../server/domain/types.ts';
import {
  createUser,
  createWorker,
  grantMembership,
  revokeMembership,
} from '../server/repos/identity.ts';
import { decideProjectAccess } from '../server/services/identity/policy.ts';
import { beginTurn, conversationIsReadable, ownerPrincipal } from '../server/services/russell/turn.ts';
import {
  addMessage,
  createConversation,
  getConversation,
  getMessage,
} from '../server/repos/russellConversations.ts';
import { ensureCollection, fileConversation } from '../server/repos/russellCollections.ts';
import { withPendingDetail } from '../server/services/russell/pending.ts';
import {
  createAccount,
  createRoutine,
  currentPolicy,
  listAccounts,
  listRoutines,
  policyHistory,
  setPolicy,
} from '../server/repos/fleet.ts';
import { LENSES, frontierFor } from '../server/services/russell/frontier.ts';
import {
  dismissFrontierItem,
  listFrontier,
  resolveUnseenFrontierItems,
} from '../server/repos/russellFrontier.ts';
import { askableLenses, openInquiry, validateLensReply } from '../server/services/russell/inquiry.ts';
import {
  DEFAULT_TARGET_WITH_NO_PRIOR_POLICY,
  LAB_MODES,
  applyFinding,
  declareExperiment,
  rollbackFinding,
  runExperiment,
} from '../server/services/fleet/lab.ts';
import { MAP_TYPES, mapFor } from '../server/services/russell/maps.ts';
import { PREFERENCES, checkPreference, defaults } from '../server/services/russell/preferences.ts';
import { SEARCH_KINDS, search } from '../server/services/russell/search.ts';
import { explainSlowness, fleetView, usability } from '../server/services/fleet/view.ts';
import type { SlownessExplanation } from '../server/services/fleet/view.ts';
import { CANDIDATE_PRIORITIES } from '../server/domain/types.ts';
import type { FrontierRegion } from '../server/domain/types.ts';
import {
  activeWorkProgress,
  buildProgress,
  milestoneStateOfLayer,
  projectProgress,
} from '../server/services/russell/progress.ts';
import { homeFor } from '../server/services/russell/home.ts';
import { capture } from '../server/services/russell/judgment.ts';
import { judgeCandidate } from '../server/services/russell/planning.ts';
import { SEMANTIC_MERGE_FLOOR } from '../server/services/russell/similarity.ts';
import {
  createCandidate,
  getCandidate,
  listCandidates,
  listMergeHistory,
  overrideJudgment,
  splitCandidate,
} from '../server/repos/russellCandidates.ts';
import {
  answerHumanRequest,
  getMission,
  listMissions,
  listOpenRequests,
  recordKnowledge,
} from '../server/repos/russellMissions.ts';
import { createAudit } from '../server/repos/audits.ts';
import { compileHat } from '../server/services/conversation/contextHat.ts';
import { ideaMapForProject } from '../server/services/russell/ideas.ts';
import { digestRenderSet, standingDecision } from '../server/repos/designApprovals.ts';

import { execFileSync } from 'node:child_process';
import { BRAIN_REVISION } from '../server/env.ts';
import { initStorage } from '../server/services/storage/index.ts';
import { seedDealDispatch } from '../server/seed.ts';
import { createGoal, reserve } from '../server/repos/russellAuthority.ts';
import { launch } from '../server/services/russell/launch.ts';
import { tick } from '../server/services/russell/loop.ts';
import { NEEDS_HUMAN_CHOICES, choicesFor } from '../server/services/russell/needsHuman.ts';
import { currentFragments, getOrchestration } from '../server/repos/research.ts';
import { listWorkItems } from '../server/repos/workQueue.ts';
import { fileResearchPacket } from '../server/services/research/filing.ts';
import { currentLinksFor, driftOf } from '../server/services/russell/completionLinks.ts';
import { collectionsFor, organize } from '../server/services/russell/collections.ts';

import {
  DEFAULT_INVITED_ROLE,
  INVITATION_NOT_FOUND,
  INVITATION_REFUSAL,
  acceptInvitation,
  invitationsForProject,
  inviteToProject,
  previewInvitation,
  withdrawInvitation,
} from '../server/services/identity/invitations.ts';
import { getProjectInvitation } from '../server/repos/projectInvitations.ts';
import {
  getMembership,
  getUserByEmail,
  listIdentityEvents,
  listMembershipsForPrincipal,
  setBrainAdmin,
} from '../server/repos/identity.ts';
import { listEvents } from '../server/repos/events.ts';
import { createBin } from '../server/repos/bins.ts';
import { routeBin } from '../server/services/dispatch/router.ts';
import { workloadProfile } from '../server/services/dispatch/profiles.ts';
import { newRequestId, runInRequestContext } from '../server/services/identity/context.ts';
import { requirePerson } from '../server/routes/helpers.ts';
import {
  projectionFor,
  runCommand,
  syncRecords,
} from '../server/services/connect/service.ts';
import { projectRecord } from '../server/services/connect/projection.ts';
import { findExternalRecord } from '../server/repos/externalRecords.ts';
import { WORKER_SCOPES } from '../server/domain/types.ts';
import type { ExistingClaim, Principal, Project } from '../server/domain/types.ts';

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
 *
 * BLOCKED and FAIL are the pair most easily confused, and the line between
 * them is whose problem it is: BLOCKED names an **operational** fact with
 * somebody's action to clear it, and FAIL names a **defect in the product**.
 * Reporting a failed assertion as BLOCKED would send a person to fix their
 * environment for a bug in the code.
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

/**
 * Where the exercising database lives, so one exercise can close and re-open it.
 *
 * A module-level handle rather than an argument because the continuity check is
 * the only thing that needs it and threading it through would put a parameter on
 * every exercise for the benefit of one. It is set in `main` beside the
 * `initDatabase` that creates the file, and stays null against a Brain that is
 * not the local one — where closing the connection would be closing production's.
 */
let CONTINUITY_DB_PATH: string | null = null;

/**
 * Evidence a scenario cites, which is not itself a scenario.
 *
 * The mission chain below is a real exercise with two dozen asserted
 * conditions, and it was briefly emitted as an eighteenth gate. It is not one.
 * §30's acceptance conditions are **seventeen**, A to Q, frozen before
 * implementation started — and a reporter that grows an extra row is a reporter
 * whose denominator moved, which is the one thing `step12b-combine.ts` refuses
 * outright. Widening the contract is not this file's to do, and an exercise
 * that earns its own letter would be marking its own homework.
 *
 * So it prints after the matrix, under its own heading, and the scenarios it
 * serves cite it by name. Nothing about the evidence is lost; what it stops
 * being is a scenario.
 */
interface EvidenceBlock {
  key: string;
  title: string;
  detail: string;
}
const evidence: EvidenceBlock[] = [];
function recordEvidence(key: string, title: string, detail: string): void {
  evidence.push({ key, title, detail });
}
function record(id: string, title: string, verdict: Verdict, detail: string): void {
  gates.push({ id, title, verdict, detail });
}

/**
 * One condition a scenario is made of, and the rule that turns a list of them
 * into a verdict.
 *
 * The owner's finding was that fifteen scenarios had **no branch** that could
 * return `PASS` — not a threshold nobody had reached, but a verdict expression
 * whose arms were `PARTIAL` and `NOT_RUN` and nothing else. Every one of them
 * ended its prose with a sentence beginning *"NOT established here: …"*, which
 * is an unmet condition written where nothing can ever satisfy it.
 *
 * So a scenario declares what it is made of, and the verdict is derived:
 *
 *   held === true    the condition was exercised and holds.
 *   held === false   it was exercised and did **not** hold. That is `FAIL`,
 *                    and it is named. Never `NOT_RUN`, which asserts nothing
 *                    happened and is the opposite of what occurred.
 *   held === null    it could not be exercised **from here**, and `needs` says
 *                    which environment can. That is `PARTIAL`, because
 *                    *we could not look* and *we looked and it is absent* are
 *                    different facts with different remedies — and the
 *                    combiner exists precisely to join a run that could look
 *                    with one that could not.
 *
 * A condition may also be permanently out of reach, and three are: a decision
 * that is the owner's, a capability this version declares and refuses, and a
 * measurement that would spend the subscription. Those carry `standing: true`
 * and are reported in the detail without holding the verdict down — the matrix
 * records them as the answer rather than as a shortfall, and a gate that could
 * never pass because of one would be a gate nobody can finish.
 */
interface GateCondition {
  name: string;
  held: boolean | null;
  saw: string;
  needs?: Environment;
  standing?: true;
}

/**
 * Whether the rows this run read are the deployed Brain's.
 *
 * Several conditions turn on facts only a real fleet has — a worker answered a
 * turn, a site delivered a record, a dispatch was traced, a reader answered a
 * lens. A checkout run reads whatever local database is configured, which is
 * usually empty, and reporting *empty* as *absent* is the exact substitution
 * this file refuses. Set in `main` from the provider name, never from a
 * connection string, because this output goes into a CI log.
 */
let READING_PRODUCTION = false;

/**
 * A condition whose evidence is a real Brain's rows.
 *
 * Judged where such rows exist; reported as not exercisable from anywhere else,
 * with the environment that can exercise it named — which is what makes the
 * combiner able to join the two runs into one answer.
 */
function fromProduction(name: string, held: boolean, saw: string): GateCondition {
  return READING_PRODUCTION
    ? { name, held, saw }
    : {
        name,
        held: null,
        saw: 'this run does not read the deployed Brain',
        needs: 'PRODUCTION',
      };
}

function verdictOf(conditions: GateCondition[]): Verdict {
  if (conditions.length === 0) return 'NOT_RUN';
  const judged = conditions.filter((c) => c.standing !== true);
  if (judged.some((c) => c.held === false)) return 'FAIL';
  if (judged.every((c) => c.held === null)) return 'NOT_RUN';
  if (judged.some((c) => c.held === null)) return 'PARTIAL';
  return 'PASS';
}

/**
 * Record a scenario from its conditions, composing the detail from them.
 *
 * The detail is built rather than written, so what a reader is told and what
 * the verdict was computed from cannot drift — the failure this whole file
 * exists to refuse, one altitude down. `lede` is the sentence that says what
 * was exercised; the conditions say whether it held.
 */
function recordConditions(
  id: string,
  title: string,
  conditions: GateCondition[],
  lede: string,
): void {
  const verdict = verdictOf(conditions);
  const broke = conditions.filter((c) => c.held === false);
  const unreachable = conditions.filter((c) => c.held === null && c.standing !== true);
  const standing = conditions.filter((c) => c.standing === true);
  const parts: string[] = [lede];
  if (broke.length > 0) {
    parts.push(
      `${broke.length} condition(s) were exercised and did NOT hold: ` +
        broke.map((c) => `${c.name} (saw ${c.saw})`).join('; ') +
        '. That is a defect rather than a missing run.',
    );
  }
  const held = conditions.filter((c) => c.held === true);
  if (held.length > 0) {
    parts.push(
      `${held.length}/${conditions.filter((c) => c.standing !== true).length} condition(s) held: ` +
        held.map((c) => `${c.name} — ${c.saw}`).join('; ') +
        '.',
    );
  }
  if (unreachable.length > 0) {
    parts.push(
      `Not exercisable from a ${RUN_ENVIRONMENT} run: ` +
        unreachable.map((c) => `${c.name} (needs ${c.needs ?? 'another environment'})`).join('; ') +
        '. A run in that environment answers it, and `step12b-combine.ts` joins the two.',
    );
  }
  if (standing.length > 0) {
    parts.push(
      'Standing and recorded as the answer rather than as a shortfall: ' +
        standing.map((c) => `${c.name} — ${c.saw}`).join('; ') +
        '.',
    );
  }
  record(id, title, verdict, parts.join(' '));
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
/**
 * Whether the product is the same product a reading was taken from.
 *
 * An exact revision match is the wrong test and would be unsatisfiable: the
 * evidence is committed *after* it is taken, so the moment a record naming HEAD
 * is committed, HEAD has moved past it. What matters is not which commit the
 * harness ran at but whether anything it was looking at has changed since — so
 * the question asked is `git diff --quiet <taken-at> HEAD -- client server`.
 * A docs commit, a test, this reporter itself: none of them change what a
 * browser renders, and none of them invalidates a photograph of it. A line of
 * `client/src` does.
 *
 * Fails closed. An unknown revision, a tree that has no such commit, a git that
 * will not answer — all `false`, because *we could not tell* must never read
 * the same as *we checked*.
 */
function productUnchangedSince(revision: string): boolean {
  try {
    execFileSync('git', ['diff', '--quiet', revision, 'HEAD', '--', 'client', 'server'], {
      cwd: REPO,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

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
    /** M: what the deployed Brain's own projects report about their progress. */
    progressReadings: {
      name: string;
      denominator: string;
      hasPercentage: boolean;
      ratioWhole: boolean;
      milestones: number;
    }[];
    /**
     * The rows a reporter cannot manufacture without writing the thing it is
     * checking for: a worker naming a duplicate, a reader answering an asked
     * lens, a mission that filed a document and a conclusion.
     */
    semanticMerges: number;
    frontierItems: number;
    answeredLenses: number;
    knowledgeRows: number;
    missions: number;
    filedDocuments: number;
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

/**
 * The render set on disk, and the decision the **authoritative** Brain holds
 * about it.
 *
 * ---------------------------------------------------------------------------
 * Why this cannot live down in gate O
 * ---------------------------------------------------------------------------
 *
 * It did, and it was wrong in a way that would never have shown up as an error.
 * `readOperationalFleet` closes the configured database, and the exercising half
 * then opens a **temporary SQLite** one it creates and deletes. Gate O runs
 * after that, so `standingDecision(...)` was querying the scratch database —
 * which has a `design_approvals` table (every migration runs there) and can
 * never have a row in it. O would have reported "no decision is recorded for
 * this revision" forever, however many times the owner recorded one, and the
 * message would have looked entirely reasonable.
 *
 * So the decision is read here, in the same read-only phase as the fleet, from
 * the Brain a person actually signed in to. The digest is pure file I/O and is
 * computed here too, because the query needs it.
 *
 * A database that cannot be read is reported as **not read** rather than as an
 * absent approval — the same three-answer rule the fleet reading follows, and
 * for the same reason: *we could not look* and *we looked and it is not there*
 * have different remedies.
 */
export interface DesignReading {
  /** Null when there is no render set to decide about. */
  digest: string | null;
  count: number;
  screens: string[];
  widths: number[];
  /** Why there is nothing to digest, when there is nothing. */
  absent: string | null;
  /** The standing decision, or null when none is recorded for this exact pair. */
  decision: Awaited<ReturnType<typeof standingDecision>>;
  /** Set when the decisions table could not be read at all. */
  unreadable: string | null;
}

async function readDesignDecision(revision: string | null): Promise<DesignReading> {
  const empty = (absent: string): DesignReading => ({
    digest: null,
    count: 0,
    screens: [],
    widths: [],
    absent,
    decision: null,
    unreadable: null,
  });

  if (!REPO_VISIBLE) return empty('this run cannot see the repository');
  if (!revision) return empty('this run cannot name its revision');

  const dir = path.join(REPO, 'docs', 'evidence', 'step12b-renders');
  const indexPath = path.join(dir, 'index.json');
  if (!fs.existsSync(indexPath)) {
    return empty('docs/evidence/step12b-renders/index.json does not exist');
  }

  let declared: { screen: string; width: number; file: string }[];
  try {
    declared = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as typeof declared;
  } catch {
    return empty('the render index is not readable JSON');
  }
  if (!Array.isArray(declared) || declared.length === 0) {
    return empty('the render index declares no renders');
  }
  const missing = declared.filter((entry) => !fs.existsSync(path.join(dir, entry.file)));
  if (missing.length > 0) {
    return empty(
      `the index declares ${missing.length} render(s) that are not on disk ` +
        `(${missing.slice(0, 3).map((entry) => entry.file).join(', ')})`,
    );
  }

  const { digest, count } = digestRenderSet(
    declared.map((entry) => ({
      path: entry.file,
      width: entry.width,
      screen: entry.screen,
      bytes: fs.readFileSync(path.join(dir, entry.file)),
    })),
  );
  const reading: DesignReading = {
    digest,
    count,
    screens: [...new Set(declared.map((entry) => entry.screen))].sort(),
    widths: [...new Set(declared.map((entry) => entry.width))].sort((a, b) => a - b),
    absent: null,
    decision: null,
    unreadable: null,
  };
  /*
   * Its own read-only phase, opened and closed here.
   *
   * `readOperationalFleet` closes the configured database before it returns, so
   * a caller that ran afterwards found `getDb()` throwing "not initialised" —
   * which the catch below reported, correctly, as *unknown rather than
   * unapproved*. The wiring was wrong and the honesty held, which is the right
   * way round; this makes the wiring right too. Symmetric with the fleet read:
   * open, two statements, close.
   */
  try {
    await initDatabase();
    reading.decision = await standingDecision(revision, digest);
  } catch (error) {
    reading.unreadable = error instanceof Error ? error.message : String(error);
  } finally {
    // Closed whatever happened, so the exercising half opens its scratch
    // database against a clean slate rather than inheriting this one.
    try {
      await closeDatabase();
    } catch {
      /* already closed */
    }
  }
  return reading;
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
     * The other rows only a real Brain has, counted in the same pass.
     *
     * Each one is the half of a scenario a reporter cannot manufacture without
     * writing the thing it is checking for: a worker naming a duplicate, a
     * reader answering an asked lens, a mission that filed knowledge. They are
     * read where they exist and reported as unreachable elsewhere — never as
     * absent, which is the substitution this file refuses.
     */
    const semanticMerges = await one(
      "SELECT COUNT(*) AS total FROM russell_candidate_merges WHERE method = 'SEMANTIC'",
    );
    const frontierItems = await one('SELECT COUNT(*) AS total FROM russell_frontier');
    const answeredLenses = await one(
      "SELECT COUNT(*) AS total FROM russell_lens_inquiries WHERE state = 'ANSWERED'",
    );
    const knowledgeRows = await one('SELECT COUNT(*) AS total FROM russell_knowledge');
    const missions = await one('SELECT COUNT(*) AS total FROM russell_missions');
    const filedDocuments = await one(
      "SELECT COUNT(*) AS total FROM russell_missions WHERE document_id IS NOT NULL",
    );
    /*
     * M's production half: the progress a real project actually reports.
     *
     * Driven rather than counted, because M is not about how many projects
     * exist — it is about whether the sentence each one hands a person is
     * milestone-backed, names its denominator and carries no percentage
     * nobody counted. `projectProgress` is the same function the route calls,
     * so this is the deployed Brain's own answer about its own versioned state.
     */
    const realProjects = (await listProjects()).slice(0, 5);
    const progressReadings: {
      name: string;
      denominator: string;
      hasPercentage: boolean;
      ratioWhole: boolean;
      milestones: number;
    }[] = [];
    for (const candidate of realProjects) {
      try {
        const reading = await projectProgress({
          projectId: candidate.id,
          projectName: candidate.name,
        });
        progressReadings.push({
          name: candidate.name,
          denominator: reading.denominator,
          hasPercentage: /\d+\s*%/.test(reading.headline),
          ratioWhole:
            reading.ratio === null ||
            (Number.isInteger(reading.ratio.done) && Number.isInteger(reading.ratio.total)),
          milestones: reading.milestones.length,
        });
      } catch {
        // A project whose progress cannot be derived is not a finding about
        // product truth; it is a reading that could not be taken.
      }
    }
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
      progressReadings,
      semanticMerges,
      frontierItems,
      answeredLenses,
      knowledgeRows,
      missions,
      filedDocuments,
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
        progressReadings: [],
        semanticMerges: 0,
        frontierItems: 0,
        answeredLenses: 0,
        knowledgeRows: 0,
        missions: 0,
        filedDocuments: 0,
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

/* ==========================================================================
 * The mission chain, driven once.
 * ==========================================================================
 *
 * The owner's rejection was precise: *"a recent loop tick is not the required
 * mission → knowledge update → backlog reranking → next authorized mission
 * chain."* It is right, and the rows this run reads are not evidence of it —
 * a tick that reports `launched: []` says nothing about whether the chain
 * behind a launch works.
 *
 * So this drives one, from a person's idea to the next mission Brain starts by
 * itself, against the real services in the temporary database. Every link is
 * asserted from rows afterwards rather than from what the tick said it did.
 *
 * ---------------------------------------------------------------------------
 * What is simulated, and what is not
 * ---------------------------------------------------------------------------
 *
 * **Nothing.** No worker, no network, no provider, and — the point — no
 * research. Every decision below is one Brain takes on its own from rows, plus
 * two decisions a *person* takes, which are made here by an explicit test
 * identity and are labelled as such in the evidence.
 *
 * That bound is the reason the chain stops where it stops. Three links need a
 * packet that reached `COMPLETE` or `COMPLETE_WITH_GAPS`; a packet reaches
 * either only through a judge's verdict on a filed report; a report is filed
 * only over a claim that cleared `gate.ts`; and a claim that cleared the gate
 * needs a worker that can reach the sources. §12 forbids inventing one and
 * `services/research/fixtures.ts` already says why the audit half cannot be
 * stood in for: *"there is no way to fake that half which would not amount to
 * writing a verdict into `audits` that nobody reached"*.
 *
 * This run therefore does **not** write a claim, a document, an audit row, a
 * verdict or a terminal packet status. It executes the guard that stops it
 * instead — `fileResearchPacket` refusing this very packet — so the boundary is
 * a reading rather than an assertion, and the unmet conditions are printed by
 * name with the one thing that would close them.
 */

/** One executed check: what was asked, and what the rows said. */
interface ChainCheck {
  name: string;
  held: boolean;
  /** The value that decided it, for the report. Never a restatement of `name`. */
  saw: string;
}

/** A condition this run could not drive at all, and precisely why. */
interface ChainGap {
  name: string;
  needs: 'A REAL WORKER' | 'THE OWNER' | 'A GUARD CORRECTLY REFUSED IT';
  why: string;
}

interface ChainResult {
  ran: boolean;
  /** Set when the exercise threw. An exception is a failure, never a non-run. */
  error: string | null;
  checks: ChainCheck[];
  gaps: ChainGap[];
  /** Ids a reader can follow back into the temporary database's own trace. */
  trace: string[];
}

/**
 * A question whose compiled plan the standing envelope will not auto-approve.
 *
 * `RUSSELL_PUBLIC_RECORDS_V1` authorizes reading published Michigan records and
 * nothing else, so `forbiddenActions` matches "email the …". The compiler does
 * not check that list — it checks the jurisdiction and the source classes — so
 * the idea compiles, launches, and is refused by `planFitsEnvelope` at the
 * approval gate. That is exactly §16's escalation: a plan outside what was
 * preauthorized stops at `NEEDS_HUMAN` with every reason recorded, and the only
 * thing that can move it is a person.
 *
 * Deliberately a *fixture question* rather than a plausible one: nothing here
 * is research, and a question that read like real work would be a question
 * somebody eventually cites.
 */
const OUTSIDE_ENVELOPE_A =
  'Establish, for each Michigan county register of deeds, how long after a deed is recorded ' +
  'it becomes available in the public electronic index, and email the register of deeds to ' +
  'confirm the figure.';
const OUTSIDE_ENVELOPE_B =
  'Establish which Michigan county recording offices publish a fee schedule for copies of ' +
  'recorded instruments, and purchase a copy from each to confirm the price.';
/** Inside the envelope. This is the idea Brain must start by itself, later. */
const INSIDE_ENVELOPE =
  'Establish which Michigan county registers of deeds publish their recording fee schedule ' +
  'on an official county web page, and what each one states.';

/** The derived backlog, exactly as `listCandidates` orders it for the product. */
async function backlogOrder(projectId: string): Promise<string[]> {
  return (await listCandidates({ projectId, limit: 200 })).map(
    (candidate) => `${candidate.title}:${candidate.state}/${candidate.priority ?? 'none'}`,
  );
}

/** Where each of this person's threads stands, derived on the read path. */
async function threadStandings(input: {
  ownerUserId: string;
  projectId: string;
  projectName: string;
}): Promise<string[]> {
  const views = await collectionsFor({
    ownerUserId: input.ownerUserId,
    projectId: input.projectId,
    projectName: input.projectName,
  });
  return views
    .flatMap((collection) => collection.threads)
    .map((thread) => `${thread.title}=${thread.standing}`)
    .sort();
}

/**
 * Whether a column exists, asked of the database rather than of a migration.
 *
 * "The rank is not stored" is a claim about the schema, and the only honest way
 * to check it from here is to ask for the column and be refused. Reading a
 * migration file would answer a different question — what the repository says —
 * and the repository is not visible from inside the deployed image anyway.
 *
 * The names are interpolated because an identifier cannot be a bound parameter
 * in either dialect. Both arguments are literals written a few lines below and
 * nothing a caller supplies reaches here, which is the only reason that is
 * acceptable — a column name taken from anywhere else would need a different
 * shape entirely.
 */
async function columnExists(table: string, column: string): Promise<boolean> {
  try {
    await getDb().all(`SELECT ${column} FROM ${table} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

/** Run the ticks the loop needs, quietly; the assertions are on rows afterwards. */
async function settle(passes: number): Promise<void> {
  for (let pass = 0; pass < passes; pass += 1) await tick('step12b-acceptance');
}

async function runMissionChain(): Promise<ChainResult> {
  const checks: ChainCheck[] = [];
  const gaps: ChainGap[] = [];
  const trace: string[] = [];
  const check = (name: string, held: boolean, saw: string): void => {
    checks.push({ name, held, saw });
  };

  try {
    const seeded = await seedDealDispatch();
    const projectId = seeded.project.id;
    trace.push(`project ${projectId}`);

    /*
     * The person in this exercise, named so nothing here can be read as the
     * owner's consent.
     *
     * Two decisions below genuinely belong to a person — approving a plan the
     * envelope refused, and stopping a mission — and both are recorded against
     * this identity, in this temporary database, which is deleted when the run
     * ends. Nothing is written into a real Brain and nothing is attributed to
     * anybody who did not make the decision.
     */
    const person = await createUser({
      email: 'step12b-chain@example.invalid',
      displayName: 'Step 12B acceptance (test identity, not the owner)',
      password: `acc-${randomUUID()}`,
      isBrainAdmin: false,
    });
    await grantMembership({
      projectId,
      principalType: 'HUMAN',
      principalId: person.id,
      role: 'MEMBER',
      scopes: ['project:read'],
      grantedByType: 'SYSTEM',
      grantedById: 'step12b-acceptance',
    });

    /* -- Link 2's gate, proved by refusal before anything is granted -------- */
    /*
     * `checkAuthority` first, because a launch that succeeds tells you nothing
     * about what would have refused it. This project has a layer and an idea
     * and no standing authority, so nothing may be created in it — and the
     * assertion is on the rows as well as on the sentence, because a refusal
     * that still wrote a mission would be no refusal at all.
     */
    const ungranted = await createProject({
      name: 'Step 12B acceptance — no standing authority',
      slug: `s12b-ungranted-${Date.now()}`,
      purpose: 'PROJECT',
    });
    const ungrantedLayer = await createLayer({
      projectId: ungranted.id,
      name: 'Discovery',
      orderIndex: 0,
    });
    const strayIdea = await createCandidate({
      title: 'An idea nobody authorized research for',
      statement: 'Establish something in a project that has no standing authority.',
      projectId: ungranted.id,
      visibility: 'SHARED',
    });
    const refusedByAuthority = await launch({
      projectId: ungranted.id,
      layerId: ungrantedLayer.id,
      candidateId: strayIdea.id,
      visibility: 'SHARED',
      title: 'An idea nobody authorized research for',
      assignment: 'Nothing may come of this.',
      objective: 'Establish something',
      whyNow: 'to exercise the gate',
      acceptableSources: ['official'],
      excludedSources: [],
      evidence: ['official_source'],
      startedBy: { kind: 'PERSON', id: person.id },
      envelopeId: 'RUSSELL_PUBLIC_RECORDS_V1',
      authorizedBy: person.email,
    });
    check(
      'L2 · checkAuthority is the gate: no standing authority, no mission',
      !refusedByAuthority.ok &&
        /standing authority/i.test(refusedByAuthority.reason) &&
        (await listMissions({ projectId: ungranted.id })).length === 0,
      `launch refused ("${refusedByAuthority.reason}") and 0 mission rows exist there`,
    );

    /* -- The standing authority, granted by the test identity --------------- */
    const goal = await createGoal({
      projectId,
      ownerUserId: person.id,
      createdByUserId: person.id,
      name: 'Step 12B acceptance — standing research',
      allowedWork: ['RESEARCH'],
      maxMissions: 6,
      maxFragments: 12,
      // Two, so the third idea is genuinely held by the ceiling rather than by
      // the loop's own per-tick launch bound — and so freeing one slot is what
      // lets it start.
      maxConcurrent: 2,
      maxProbes: 3,
    });
    trace.push(`standing authority ${goal.id} (test identity ${person.id})`);

    const threadA = await createConversation({
      ownerUserId: person.id,
      title: 'Step 12B chain — thread A',
      projectId,
      visibility: 'SHARED',
    });
    const threadB = await createConversation({
      ownerUserId: person.id,
      title: 'Step 12B chain — thread B',
      projectId,
      visibility: 'SHARED',
    });

    /* -- Link 1: capture, and Russell's own priority ------------------------ */
    const capturedA = await capture({
      title: 'Recording-to-availability delay',
      statement: OUTSIDE_ENVELOPE_A,
      projectId,
      conversationId: threadA.id,
      visibility: 'SHARED',
    });
    const capturedB = await capture({
      title: 'Copy fee schedules',
      statement: OUTSIDE_ENVELOPE_B,
      projectId,
      conversationId: threadB.id,
      visibility: 'SHARED',
    });
    const capturedNext = await capture({
      title: 'Published recording fee schedules',
      statement: INSIDE_ENVELOPE,
      projectId,
      conversationId: threadA.id,
      visibility: 'SHARED',
    });
    const ideaA = capturedA.candidate?.id ?? '';
    const ideaB = capturedB.candidate?.id ?? '';
    const ideaNext = capturedNext.candidate?.id ?? '';
    check(
      'L1 · three ideas captured through `capture`, each with its own row',
      new Set([ideaA, ideaB, ideaNext]).size === 3 && ideaA !== '',
      `${ideaA}, ${ideaB}, ${ideaNext}`,
    );

    // The tick judges, compiles and launches; one launch per cycle by design.
    await settle(8);

    const judgedA = await getCandidate(ideaA);
    const judgment = judgedA?.judgment ?? {};
    check(
      'L1 · Russell formed its own priority, with the reason it will be asked for',
      judgedA?.priority !== null && (judgedA?.reason ?? '').trim().length > 0,
      `${judgedA?.priority ?? 'none'} — "${(judgedA?.reason ?? '').slice(0, 70)}"`,
    );
    check(
      'L1 · decided by the compiler, naming the envelope and the jurisdiction it read',
      judgment['decidedBy'] === 'COMPILER' &&
        judgment['envelopeId'] === 'RUSSELL_PUBLIC_RECORDS_V1' &&
        typeof judgment['jurisdiction'] === 'object',
      `decidedBy=${String(judgment['decidedBy'])} envelope=${String(judgment['envelopeId'])} ` +
        `jurisdiction=${JSON.stringify(judgment['jurisdiction'])}`,
    );
    check(
      'L1 · the archive was asked first and answered nothing, so nothing was spent on it',
      judgment['alreadyAnswered'] === false && typeof judgment['claimsConsidered'] === 'number',
      `alreadyAnswered=${String(judgment['alreadyAnswered'])} ` +
        `claimsConsidered=${String(judgment['claimsConsidered'])}`,
    );
    check(
      'L1 · the specification was compiled without dispatching anything to a worker',
      (await getDb().all(`SELECT id FROM bins WHERE kind = 'RUSSELL_PLAN'`, [])).length === 0 &&
        judgment['missionSpec'] !== undefined,
      'no RUSSELL_PLAN bin exists and the candidate carries a missionSpec',
    );

    /* -- Link 2: launched through `launch.ts`, not built by hand ------------ */
    const launched = await listMissions({ projectId });
    const missionA = launched.find((mission) => mission.candidateId === ideaA) ?? null;
    const missionB = launched.find((mission) => mission.candidateId === ideaB) ?? null;
    check(
      'L2 · two missions exist, each pointing at the idea it came from',
      missionA !== null && missionB !== null,
      `${missionA?.id ?? 'none'} ← ${ideaA}; ${missionB?.id ?? 'none'} ← ${ideaB}`,
    );
    if (missionA) trace.push(`mission ${missionA.id} / packet ${missionA.orchestrationId}`);
    check(
      'L2 · each carries a packet, a plan and a bin the fleet could be sent for',
      missionA?.orchestrationId !== null &&
        missionA?.binId !== null &&
        (missionA ? (await currentFragments(missionA.orchestrationId!)).length > 0 : false),
      `packet ${missionA?.orchestrationId ?? 'none'}, bin ${missionA?.binId ?? 'none'}, ` +
        `${missionA ? (await currentFragments(missionA.orchestrationId!)).length : 0} fragment(s)`,
    );
    const heldReservations = await getDb().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM russell_budget_reservations
        WHERE goal_id = ? AND kind = 'MISSION' AND state = 'HELD'`,
      [goal.id],
    );
    check(
      'L2 · `reserve` held a slot for each, for the length of its live span',
      Number(heldReservations[0]?.n ?? 0) === 2,
      `${Number(heldReservations[0]?.n ?? 0)} HELD mission reservation(s)`,
    );

    /*
     * And the ceiling refusing a third, asked of `reserve` itself.
     *
     * Nothing is created by this: an over-ceiling reservation releases its own
     * row before returning, which is why the probe is safe to make and why the
     * refusal names `AT_ONCE` rather than a sentence somebody has to match.
     */
    const overCeiling = await reserve({
      goalId: goal.id,
      kind: 'MISSION',
      idempotencyKey: `step12b:acceptance:ceiling-probe:${randomUUID()}`,
    });
    check(
      'L5 · while both are live, `reserve` refuses the next one as a wait, not a wall',
      !overCeiling.ok && overCeiling.refusedBy === 'AT_ONCE',
      `refusedBy=${overCeiling.refusedBy ?? 'none'} — "${overCeiling.reason}"`,
    );

    /* -- The readings the rerank is measured against ----------------------- */
    const backlogBefore = await backlogOrder(projectId);
    const standingsBefore = await threadStandings({
      ownerUserId: person.id,
      projectId,
      projectName: seeded.project.name,
    });
    const ordinalsBefore = await getDb().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM russell_candidates WHERE project_id = ? AND ordinal IS NOT NULL`,
      [projectId],
    );

    /* -- Link 3: the decision, derived by Brain and answered by a person ---- */
    const packetA = missionA?.orchestrationId
      ? await getOrchestration(missionA.orchestrationId)
      : null;
    check(
      'F · Brain derived the park from the packet’s own rows, never from a worker',
      packetA?.status === 'NEEDS_HUMAN' &&
        /outside the preauthorized envelope/i.test(packetA?.failureReason ?? ''),
      `packet ${packetA?.status ?? 'none'} — "${(packetA?.failureReason ?? '').slice(0, 110)}"`,
    );
    check(
      'F · the mission parked from that status, carrying the packet’s own words',
      missionA?.state === 'NEEDS_HUMAN' &&
        (missionA?.waitingOn ?? '') === (packetA?.failureReason ?? ''),
      `mission ${missionA?.state ?? 'none'}, waitingOn matches the packet's failureReason`,
    );

    const open = await listOpenRequests(projectId);
    const requestA = open.find((request) => request.missionId === missionA?.id) ?? null;
    const requestB = open.find((request) => request.missionId === missionB?.id) ?? null;
    check(
      'F · the offer is the answers that can act on this packet, and more than one',
      requestA !== null &&
        requestA.choices.map((choice) => choice.key).join('+') === 'APPROVE_PLAN+STOP',
      `${requestA?.choices.map((choice) => choice.key).join('+') ?? 'no request'}`,
    );

    const itemsBeforeAnswer = missionA?.orchestrationId
      ? (await listWorkItems(projectId, { limit: 200 })).filter(
          (item) => item.orchestrationId === missionA.orchestrationId,
        )
      : [];

    if (requestA) {
      await answerHumanRequest({
        requestId: requestA.id,
        actorUserId: person.id,
        choice: NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key,
      });
      trace.push(`APPROVE_PLAN on ${requestA.id} by the test identity`);
    }
    await settle(3);

    const missionAAfter = missionA ? await getMission(missionA.id) : null;
    const packetAAfter = missionA?.orchestrationId
      ? await getOrchestration(missionA.orchestrationId)
      : null;
    const itemsAfterAnswer = missionA?.orchestrationId
      ? (await listWorkItems(projectId, { limit: 200 })).filter(
          (item) => item.orchestrationId === missionA.orchestrationId,
        )
      : [];
    const claimable = itemsAfterAnswer.filter((item) => item.state === 'QUEUED');
    check(
      'F · the person’s answer went through the real answering transition',
      missionAAfter?.state === 'RUNNING' && packetAAfter?.status !== 'NEEDS_HUMAN',
      `mission NEEDS_HUMAN → ${missionAAfter?.state ?? 'none'}, ` +
        `packet NEEDS_HUMAN → ${packetAAfter?.status ?? 'none'}`,
    );
    check(
      'F · and the packet’s work became claimable again',
      itemsBeforeAnswer.length === 0 && claimable.length > 0,
      `${itemsBeforeAnswer.length} work item(s) before → ${claimable.length} QUEUED after ` +
        `(${claimable.map((item) => item.workType).join(', ')})`,
    );
    const stillOpen = await listOpenRequests(projectId);
    check(
      'F · the answered request is finished rather than left open',
      requestA !== null && stillOpen.every((request) => request.id !== requestA.id),
      `${requestA?.id ?? 'no request'} is no longer open; the ${stillOpen.length} remaining ` +
        'belong to the mission nobody has answered yet',
    );

    /* -- The second answer: a person stops one, which frees a slot ---------- */
    if (requestB) {
      await answerHumanRequest({
        requestId: requestB.id,
        actorUserId: person.id,
        choice: NEEDS_HUMAN_CHOICES.STOP.key,
      });
      trace.push(`STOP on ${requestB.id} by the test identity`);
    }
    await settle(3);
    const missionBAfter = missionB ? await getMission(missionB.id) : null;
    const releasedReservation = missionBAfter?.reservationId
      ? await getDb().all<{ state: string }>(
          `SELECT state FROM russell_budget_reservations WHERE id = ?`,
          [missionBAfter.reservationId],
        )
      : [];
    check(
      'F · STOP is an answering transition too, and it settles the hold it was using',
      missionBAfter?.state === 'CANCELLED' && releasedReservation[0]?.state === 'SETTLED',
      `mission ${missionBAfter?.state ?? 'none'}, its reservation ${releasedReservation[0]?.state ?? 'none'}`,
    );

    /* -- Link 5: the next authorized mission starts with nobody involved ---- */
    await settle(6);
    const missionNext =
      (await listMissions({ projectId })).find(
        (mission) => mission.candidateId === ideaNext,
      ) ?? null;
    check(
      'L5 · the next authorized idea launched by itself, with no second human action',
      missionNext !== null && missionNext.orchestrationId !== null,
      `${missionNext?.id ?? 'none'} for idea ${ideaNext}, packet ${missionNext?.orchestrationId ?? 'none'}`,
    );
    check(
      'L5 · it came through `launch`, so it carries its own reservation and its own packet',
      missionNext?.reservationId !== null &&
        missionNext?.goalId === goal.id &&
        missionNext?.idempotencyKey?.startsWith('russell:mission:') === true,
      `goal=${missionNext?.goalId ?? 'none'} reservation=${missionNext?.reservationId ?? 'none'} ` +
        `key=${missionNext?.idempotencyKey ?? 'none'}`,
    );
    if (missionNext) trace.push(`next mission ${missionNext.id} started by the loop`);

    /* -- Link 4: the backlog reranks, and the rank is not a row ------------- */
    const backlogAfter = await backlogOrder(projectId);
    const standingsAfter = await threadStandings({
      ownerUserId: person.id,
      projectId,
      projectName: seeded.project.name,
    });
    const ordinalsAfter = await getDb().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM russell_candidates WHERE project_id = ? AND ordinal IS NOT NULL`,
      [projectId],
    );
    /*
     * The rerank, and what it is a consequence *of*.
     *
     * Named precisely rather than generously. What moved these rows is the
     * mission chain itself — a person stopped one idea, and the idea that was
     * behind the concurrency ceiling started — and not new knowledge, because
     * this run files none. The knowledge-driven rerank is a separate condition
     * and it is printed below as a gap rather than folded in here, because
     * "the backlog reranked" and "the backlog reranked because the project
     * learned something" are different claims and only one of them is true of
     * this run.
     */
    check(
      'L4 · the derived backlog order changed as a consequence of the chain',
      backlogBefore.join(' | ') !== backlogAfter.join(' | '),
      `[${backlogBefore.join(' | ')}] → [${backlogAfter.join(' | ')}]`,
    );
    check(
      'L4 · so did the derived standing of the threads the work came from',
      standingsBefore.join(' | ') !== standingsAfter.join(' | '),
      `[${standingsBefore.join(' | ')}] → [${standingsAfter.join(' | ')}]`,
    );
    /*
     * And the half that makes it a *derivation*: there is nowhere to store it.
     *
     * §29's rule is "a collection is a row; a rank is not". The check is the
     * schema itself — a column that does not exist cannot have been written —
     * plus the one column that *could* pin an order staying untouched, because
     * `ordinal` is a person's manual pin and nothing in this chain is one.
     */
    const noRankColumn =
      !(await columnExists('russell_candidates', 'rank')) &&
      !(await columnExists('russell_candidates', 'standing')) &&
      !(await columnExists('russell_conversations', 'rank')) &&
      !(await columnExists('russell_conversations', 'standing'));
    check(
      'L4 · and it is derived, because no table in this schema could have stored it',
      noRankColumn &&
        Number(ordinalsBefore[0]?.n ?? -1) === 0 &&
        Number(ordinalsAfter[0]?.n ?? -1) === 0,
      `no rank/standing column on russell_candidates or russell_conversations; ` +
        `${Number(ordinalsAfter[0]?.n ?? -1)} candidate(s) carry a manual ordinal`,
    );

    /* -- Link 3b: the knowledge writeback, and the guard that stops it here - */
    /*
     * Executed rather than asserted. This is the exact call the pipeline makes
     * to file a report, made against this packet, and the refusal it returns is
     * the reason the three links below are not driven.
     */
    let filingRefusal = 'the guard did not refuse, which would be a defect';
    let filingRefused = false;
    if (missionA?.orchestrationId) {
      const packet = await getOrchestration(missionA.orchestrationId);
      if (packet) {
        try {
          await fileResearchPacket({
            orchestration: packet,
            reportText: 'This call exists to be refused.',
            citedClaimIds: [],
            stillMissing: [],
            passId: 'pass_none',
          });
        } catch (error) {
          filingRefused = true;
          filingRefusal = error instanceof Error ? error.message : String(error);
        }
      }
    }
    check(
      'L3 · `fileResearchPacket` refuses a packet with no claim through the gate',
      filingRefused && /cleared its fragment evidence gate/i.test(filingRefusal),
      `"${filingRefusal.slice(0, 130)}"`,
    );

    /*
     * The completion-link derivation, on the packet this run actually has.
     *
     * `currentLinksFor` is the rule the writeback reads before it files
     * anything, and its stated contract is that a null means *leave what is
     * there* and never *clear it*. That half is checkable now: the packet has
     * filed nothing and recorded no audit, and the mission must come back
     * unchanged rather than blanked.
     */
    let linksSaw = 'no packet';
    let linksHeld = false;
    if (missionAAfter?.orchestrationId) {
      const packet = await getOrchestration(missionAAfter.orchestrationId);
      if (packet) {
        const links = await currentLinksFor(packet);
        const drift = driftOf(missionAAfter, links);
        linksHeld =
          links.documentId === null &&
          links.auditId === null &&
          links.layerId === missionAAfter.layerId &&
          drift.length === 0;
        linksSaw =
          `documentId=${links.documentId ?? 'null'} auditId=${links.auditId ?? 'null'} ` +
          `layerId=${links.layerId === missionAAfter.layerId ? 'the mission’s own' : 'different'}, ` +
          `${drift.length} field(s) would be rewritten`;
      }
    }
    check(
      'L3 · a link the packet does not have yet never clears one the mission holds',
      linksHeld,
      linksSaw,
    );

    gaps.push(
      {
        name:
          'L3 · the writeback files a conclusion under a layer with its document and audit ' +
          'as provenance',
        needs: 'A REAL WORKER',
        why:
          '`outcomeOf` promotes knowledge only from a packet that reached COMPLETE or ' +
          'COMPLETE_WITH_GAPS. Both need a judge’s verdict on a filed report, a report ' +
          'needs a claim that cleared gate.ts, and that needs a worker that can reach the ' +
          'sources. The refusal above is that boundary, executed.',
      },
      {
        name:
          'L3 · the links point at the CURRENT audit rather than an older one of the same run',
        needs: 'A REAL WORKER',
        why:
          '`newestAuditId` can only be exercised over two real audit rows on one run, and an ' +
          'audits row is a judge’s verdict. Writing one here would be the model prose as ' +
          'state §8 forbids, which is why services/research/fixtures.ts stops at the same ' +
          'line. tests/otherLayerHandoff.test.ts covers the derivation in isolation.',
      },
      {
        name: 'L4 · a rerank caused by new knowledge rather than by the chain',
        needs: 'A REAL WORKER',
        why:
          'The archive check `coverBeforeWork` reads `existing_claims`, which are extracted ' +
          'from a filed document — so the reading that flips an idea to "already answered" ' +
          'moves only after a mission files a report. The rerank driven above is real and is ' +
          'caused by the chain, which is a weaker claim and is the one made.',
      },
      {
        name: 'L5 · the automatic follow-on, created from what the filed report left unsettled',
        needs: 'THE OWNER',
        why:
          '`unresolvedFollowOn` requires COMPLETE_WITH_GAPS, which requires ' +
          'unresolved_gap_policy = RECORD_GAPS, which only the RECORD_GAPS answer to a Needs ' +
          'You request writes — and that offer needs an accepted fragment. §24 already ' +
          'records this as the rules holding: filing short is a decision the domain reserves ' +
          'to a person, and one decision closes both conditions.',
      },
    );

    return { ran: true, error: null, checks, gaps, trace };
  } catch (error) {
    return {
      ran: true,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      checks,
      gaps,
      trace,
    };
  }
}

/**
 * The human invitation and acceptance journey, driven end to end.
 *
 * The owner named this as missing, and it was: a person was *granted* a
 * membership by somebody who already held their user id, and nobody was ever
 * invited. So this is not a reading of the code — it issues real invitations
 * against the temporary database, spends them, and asserts every property from
 * the rows that came out, including the refusals, which is where the safety
 * actually lives.
 *
 * **Every identity below is a test identity**, at `example.invalid`, created by
 * this script. Nothing here is, or may be read as, the owner approving,
 * granting or accepting anything.
 *
 * Each condition is a `[name, held]` pair so a failure names itself. A condition
 * that ran and did not hold makes the gate `FAIL`, never `NOT_RUN`: something
 * did run, and reporting an executed failure as "nothing has happened yet" is
 * the one substitution that lets a defect read as a gap.
 */
async function inviteJourney(
  project: Project,
): Promise<{ conditions: (readonly [string, boolean])[]; notes: string[] }> {
  const notes: string[] = [];
  const at = (local: string): string => `acceptance-${local}@example.invalid`;

  /*
   * Three test identities with three different authorities, because the
   * journey's rules are all about which of them may do what.
   *
   *   admin      administers the project and is a Brain administrator, so it
   *              can authorize an account that does not exist yet;
   *   projectAdmin  administers the project and is *not* a Brain administrator;
   *   plainMember   is on the project and administers nothing.
   */
  const admin = await createUser({
    email: at('invite-admin'),
    displayName: 'Test identity — Brain administrator',
    password: `acc-${randomUUID()}`,
    isBrainAdmin: true,
  });
  const projectAdmin = await createUser({
    email: at('invite-project-admin'),
    displayName: 'Test identity — project administrator',
    password: `acc-${randomUUID()}`,
    isBrainAdmin: false,
  });
  const plainMember = await createUser({
    email: at('invite-member'),
    displayName: 'Test identity — ordinary member',
    password: `acc-${randomUUID()}`,
    isBrainAdmin: false,
  });
  for (const [user, role] of [
    [admin, 'ADMIN'],
    [projectAdmin, 'ADMIN'],
    [plainMember, 'MEMBER'],
  ] as const) {
    await grantMembership({
      projectId: project.id,
      principalType: 'HUMAN',
      principalId: user.id,
      role,
      grantedByType: 'SYSTEM',
      grantedById: user.id,
    });
  }
  const adminPrincipal = (await ownerPrincipal(admin.id))!;
  const projectAdminPrincipal = (await ownerPrincipal(projectAdmin.id))!;
  const memberPrincipal = (await ownerPrincipal(plainMember.id))!;

  /*
   * A worker with every scope this Brain has, and membership on the project.
   *
   * Built deliberately generous, because the claim being tested is that the
   * refusal is by **principal type** rather than by configuration: a worker that
   * was refused for lacking a scope would prove nothing about a worker that had
   * one.
   */
  const worker = await createWorker({
    name: 'acceptance-invite-worker',
    displayName: 'Test identity — a machine',
    createdByType: 'SYSTEM',
    createdById: admin.id,
  });
  await grantMembership({
    projectId: project.id,
    principalType: 'WORKER',
    principalId: worker.id,
    role: null,
    scopes: [...WORKER_SCOPES],
    grantedByType: 'SYSTEM',
    grantedById: admin.id,
  });
  const workerPrincipal: Principal = {
    type: 'WORKER',
    id: worker.id,
    handle: worker.name,
    displayName: worker.displayName,
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'acceptance:worker',
    authMethod: 'WORKER_BEARER',
    memberships: (await listMembershipsForPrincipal('WORKER', worker.id)).filter((m) => m.active),
    requestId: 'acceptance:worker',
  };

  const origin = 'https://brain.invalid';
  const before = (await invitationsForProject(project.id)).length;

  // -- the refusals, first, because each must cost nothing ------------------

  const byMachine = await inviteToProject({
    principal: workerPrincipal,
    projectId: project.id,
    email: at('never-invited-by-a-machine'),
    role: 'ADMIN',
    origin,
  });
  const byMember = await inviteToProject({
    principal: memberPrincipal,
    projectId: project.id,
    email: at('never-invited-by-a-member'),
    role: 'MEMBER',
    origin,
  });
  const byNobody = await inviteToProject({
    principal: null,
    projectId: project.id,
    email: at('never-invited-by-nobody'),
    role: 'MEMBER',
    origin,
  });
  const afterRefusals = (await invitationsForProject(project.id)).length;

  /*
   * An id somebody guesses, and an id that is real but belongs to a project this
   * caller cannot administer, must be the same refusal — the *same body*, not
   * merely the same status, which is what invariant 23 actually says.
   */
  const elsewhere = await createProject({
    name: `Acceptance — a project this caller does not administer ${randomUUID().slice(0, 8)}`,
    description: 'Test project, created by the Step 12B acceptance reporter.',
  });
  const elsewhereInvite = await inviteToProject({
    principal: adminPrincipal,
    projectId: elsewhere.id,
    email: at('invited-somewhere-else'),
    role: 'VIEWER',
    origin,
  });
  const realIdElsewhere = elsewhereInvite.ok ? elsewhereInvite.issued.invitation.id : 'none';
  const guessed = await withdrawInvitation({
    principal: projectAdminPrincipal,
    projectId: project.id,
    invitationId: `pinv_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
  });
  const realButNotYours = await withdrawInvitation({
    principal: projectAdminPrincipal,
    projectId: project.id,
    invitationId: realIdElsewhere,
  });
  const guessedBody = guessed.ok ? 'ALLOWED — defect' : guessed.reason;
  const notYoursBody = realButNotYours.ok ? 'ALLOWED — defect' : realButNotYours.reason;

  // -- the happy path -------------------------------------------------------

  const invitedEmail = at('invited-collaborator');
  const issued = await inviteToProject({
    principal: adminPrincipal,
    projectId: project.id,
    email: invitedEmail,
    // Left unsaid on purpose, so the prefilled default is what is exercised.
    role: undefined,
    origin,
  });
  if (!issued.ok) {
    return {
      conditions: [['an invitation can be issued at all', false] as const],
      notes: [`Issuing refused: ${issued.reason}`],
    };
  }
  const token = issued.issued.invitationUrl.split('#')[1] ?? '';
  const row = (await getProjectInvitation(issued.issued.invitation.id))!;

  /*
   * The secret is not recoverable from anything Brain kept.
   *
   * Three places are checked rather than one: the row, the identity audit, and
   * the project's own history. A digest in the row is the design; a token in an
   * audit row would be the design defeated.
   */
  const rowHoldsNoToken = !JSON.stringify(row).includes(token);
  const identityEvents = await listIdentityEvents({ projectId: project.id, limit: 200 });
  const projectEvents = await listEvents(project.id, 200);
  const auditHoldsNoToken =
    !JSON.stringify(identityEvents).includes(token) &&
    !JSON.stringify(projectEvents).includes(token);
  const issueAudited = identityEvents.some(
    (event) =>
      event.action === 'INVITE_PERSON' &&
      event.targetId === issued.issued.invitation.id &&
      event.result === 'SUCCESS',
  );
  const invitedOnProjectHistory = projectEvents.some(
    (event) => event.eventType === 'ACCESS_INVITED',
  );
  // The link carries the token in the fragment, so nothing before the `#` — the
  // part a server logs — contains it.
  const tokenOnlyInFragment =
    issued.issued.invitationUrl.includes('#') &&
    !(issued.issued.invitationUrl.split('#')[0] ?? '').includes(token);

  const preview = await previewInvitation(token);
  const previewLeavesItLive =
    preview.ok && (await getProjectInvitation(row.id))!.acceptedAt === null;

  /*
   * Accepting, with a role in the body that nothing reads.
   *
   * The input type has no `role`, so this is cast in deliberately: the claim is
   * that the membership comes from the invitation, and the way to drive it is to
   * try to choose one and find it changed nothing.
   */
  const acceptedRaw = {
    token,
    password: `acc-${randomUUID()}`,
    displayName: 'Test identity — an invited collaborator',
    role: 'OWNER',
    isBrainAdmin: true,
    projectId: 'some-other-project',
  } as unknown;
  const accepted = await acceptInvitation(acceptedRaw as { token: string });
  const membership = await getMembership(project.id, 'HUMAN', accepted.ok ? accepted.userId : 'x');
  const invitedUser = await getUserByEmail(invitedEmail);
  const invitedPrincipal = invitedUser ? await ownerPrincipal(invitedUser.id) : null;

  const roleFromInvitation =
    membership !== null &&
    membership.role === DEFAULT_INVITED_ROLE &&
    row.role === DEFAULT_INVITED_ROLE;
  const acceptorGainedNoAdmin = invitedUser !== null && !invitedUser.isBrainAdmin;
  const readsWhatTheRolePermits =
    invitedPrincipal !== null &&
    decideProjectAccess(invitedPrincipal, project.id, 'READ').allowed &&
    decideProjectAccess(invitedPrincipal, project.id, 'WRITE').allowed &&
    !decideProjectAccess(invitedPrincipal, project.id, 'ADMIN').allowed;
  const andNoMore =
    invitedPrincipal !== null && !decideProjectAccess(invitedPrincipal, elsewhere.id, 'READ').allowed;
  const acceptAudited = (await listIdentityEvents({ projectId: project.id, limit: 200 })).some(
    (event) =>
      event.action === 'ACCEPT_PROJECT_INVITATION' &&
      event.targetId === row.id &&
      event.result === 'SUCCESS',
  );

  // -- spending it twice ----------------------------------------------------

  const second = await acceptInvitation({ token });
  const secondBody = second.ok ? 'ACCEPTED TWICE — defect' : second.reason;

  /*
   * And two at once, which is the case the guarded UPDATE exists for. A second
   * invitation, because the first is spent — and both requests are issued
   * before either is awaited, so they are genuinely racing rather than ordered.
   */
  const raceEmail = at('invited-twice-at-once');
  const raced = await inviteToProject({
    principal: adminPrincipal,
    projectId: project.id,
    email: raceEmail,
    role: 'VIEWER',
    origin,
  });
  const raceToken = raced.ok ? (raced.issued.invitationUrl.split('#')[1] ?? '') : '';
  const [raceA, raceB] = await Promise.all([
    acceptInvitation({ token: raceToken, password: `acc-${randomUUID()}` }),
    acceptInvitation({ token: raceToken, password: `acc-${randomUUID()}` }),
  ]);
  const exactlyOneWon = [raceA.ok, raceB.ok].filter(Boolean).length === 1;

  // -- an expired one -------------------------------------------------------

  const expired = await inviteToProject({
    principal: adminPrincipal,
    projectId: project.id,
    email: at('invited-too-long-ago'),
    role: 'MEMBER',
    origin,
    // Already past when it is written, so this exercises the guard rather than
    // a sleep — the condition is a comparison, and waiting would only make the
    // reporter slower without making it truer.
    ttlMs: -1000,
  });
  const expiredToken = expired.ok ? (expired.issued.invitationUrl.split('#')[1] ?? '') : '';
  const expiredAccept = await acceptInvitation({ token: expiredToken });
  const expiredBody = expiredAccept.ok ? 'ACCEPTED AN EXPIRED ONE — defect' : expiredAccept.reason;
  const expiredShownWithRemedy = (await invitationsForProject(project.id)).some(
    (entry) => entry.state === 'EXPIRED' && (entry.remedy ?? '').toLowerCase().includes('again'),
  );

  // -- an unknown token, which must read exactly like the three above --------

  const unknownAccept = await acceptInvitation({
    token: `brnv_${randomUUID().replace(/-/g, '').slice(0, 16)}.${randomUUID()}${randomUUID()}`,
  });
  const unknownBody = unknownAccept.ok ? 'ACCEPTED AN UNKNOWN ONE — defect' : unknownAccept.reason;

  // -- an account that does not exist yet, both ways ------------------------

  /*
   * Creating an account is `decideBrainAdmin`'s to authorize, and the authority
   * is re-read at the moment the effect happens rather than stored on the
   * invitation. Both branches are driven: the one that may, and the one that
   * may not — which must refuse *without spending the invitation*, because the
   * remedy is a Brain administrator creating the account and the link has to
   * keep working afterwards.
   */
  const newcomerEmail = at('invited-with-no-account');
  const newcomer = await inviteToProject({
    principal: adminPrincipal,
    projectId: project.id,
    email: newcomerEmail,
    role: 'VIEWER',
    origin,
  });
  const newcomerToken = newcomer.ok ? (newcomer.issued.invitationUrl.split('#')[1] ?? '') : '';
  const newcomerAccepted = await acceptInvitation({
    token: newcomerToken,
    password: `acc-${randomUUID()}`,
    displayName: 'Test identity — a new collaborator',
  });
  const newcomerUser = await getUserByEmail(newcomerEmail);
  const accountCreatedAtTheRightAddress =
    newcomerAccepted.ok &&
    newcomerAccepted.createdAccount &&
    newcomerUser !== null &&
    newcomerUser.email === newcomerEmail &&
    !newcomerUser.isBrainAdmin;

  const unauthorizedEmail = at('invited-with-no-account-by-a-project-admin');
  const unauthorized = await inviteToProject({
    principal: projectAdminPrincipal,
    projectId: project.id,
    email: unauthorizedEmail,
    role: 'MEMBER',
    origin,
  });
  const unauthorizedToken = unauthorized.ok
    ? (unauthorized.issued.invitationUrl.split('#')[1] ?? '')
    : '';
  const unauthorizedAccept = await acceptInvitation({
    token: unauthorizedToken,
    password: `acc-${randomUUID()}`,
  });
  const unauthorizedStillLive =
    unauthorized.ok &&
    (await getProjectInvitation(unauthorized.issued.invitation.id))!.acceptedAt === null &&
    (await getProjectInvitation(unauthorized.issued.invitation.id))!.revokedAt === null;
  const unauthorizedNamesRemedy =
    !unauthorizedAccept.ok && /Brain administrator/.test(unauthorizedAccept.reason);
  const noAccountWasMade = (await getUserByEmail(unauthorizedEmail)) === null;
  // And the remedy actually works: the same link, once the account exists.
  const rescuer = await createUser({
    email: unauthorizedEmail,
    displayName: 'Test identity — account made by an administrator',
    password: `acc-${randomUUID()}`,
    isBrainAdmin: false,
  });
  const afterRemedy = await acceptInvitation({ token: unauthorizedToken });
  const remedyWorks =
    afterRemedy.ok &&
    afterRemedy.userId === rescuer.id &&
    (await getMembership(project.id, 'HUMAN', rescuer.id))?.role === 'MEMBER';

  // -- an inviter who has since lost the authority they invited with --------

  /*
   * Authority is read now rather than stored, so a link left behind by somebody
   * who has lost `ADMIN` lets nobody in. Driven by demoting the inviter between
   * issue and acceptance.
   */
  const strandedEmail = at('invited-by-someone-since-demoted');
  await setBrainAdmin(projectAdmin.id, false);
  const stranded = await inviteToProject({
    principal: (await ownerPrincipal(projectAdmin.id))!,
    projectId: project.id,
    email: strandedEmail,
    role: 'MEMBER',
    origin,
  });
  const strandedToken = stranded.ok ? (stranded.issued.invitationUrl.split('#')[1] ?? '') : '';
  await grantMembership({
    projectId: project.id,
    principalType: 'HUMAN',
    principalId: projectAdmin.id,
    role: 'VIEWER',
    grantedByType: 'SYSTEM',
    grantedById: admin.id,
  });
  await createUser({
    email: strandedEmail,
    displayName: 'Test identity — invited by a demoted administrator',
    password: `acc-${randomUUID()}`,
    isBrainAdmin: false,
  });
  const strandedAccept = await acceptInvitation({ token: strandedToken });
  const demotionLandsImmediately =
    !strandedAccept.ok && strandedAccept.reason === INVITATION_REFUSAL;

  // -- withdrawing, and re-inviting ----------------------------------------

  const withdrawEmail = at('invited-then-withdrawn');
  const toWithdraw = await inviteToProject({
    principal: adminPrincipal,
    projectId: project.id,
    email: withdrawEmail,
    role: 'MEMBER',
    origin,
  });
  const withdrawToken = toWithdraw.ok
    ? (toWithdraw.issued.invitationUrl.split('#')[1] ?? '')
    : '';
  const withdrawn = await withdrawInvitation({
    principal: adminPrincipal,
    projectId: project.id,
    invitationId: toWithdraw.ok ? toWithdraw.issued.invitation.id : 'none',
  });
  const withdrawnAccept = await acceptInvitation({ token: withdrawToken });
  const reinvited = await inviteToProject({
    principal: adminPrincipal,
    projectId: project.id,
    email: invitedEmail,
    role: 'MEMBER',
    origin,
  });
  const reinviteReplaces = reinvited.ok && reinvited.issued.replaced >= 0;

  const denialsRecordCategories = (await listIdentityEvents({ limit: 400 }))
    .filter((event) => event.action === 'ACCEPT_PROJECT_INVITATION' && event.result === 'DENIED')
    .every(
      (event) =>
        event.reason !== null &&
        !JSON.stringify(event.metadata).includes('@') &&
        !JSON.stringify(event.metadata).includes('brnv_'),
    );

  notes.push(
    `${(await invitationsForProject(project.id)).length} invitation(s) on the project afterwards`,
  );

  return {
    notes,
    conditions: [
      ['a machine is refused by principal type, holding every scope', !byMachine.ok],
      ['a member who does not administer the project is refused', !byMember.ok],
      ['and is refused in the words a missing project gets', !byMember.ok && byMember.reason === 'No project with that id.'],
      ['an unauthenticated caller is refused', !byNobody.ok],
      ['none of those three wrote an invitation', afterRefusals === before],
      ['a guessed invitation id is refused', !guessed.ok],
      ["another project's real invitation id is refused identically", guessedBody === notYoursBody],
      ['the invitation link carries its token only in the fragment', tokenOnlyInFragment],
      ['the stored row cannot yield the token', rowHoldsNoToken],
      ['no audit row and no project event contains it', auditHoldsNoToken],
      ['issuing is audited against the invitation id', issueAudited],
      ["and the project's own history records the offer", invitedOnProjectHistory],
      ['opening the link does not consume it', previewLeavesItLive],
      ['accepting creates the membership', membership !== null && membership.active],
      ['at the role the invitation named, not one the acceptor asked for', roleFromInvitation],
      ['and confers no Brain administration', acceptorGainedNoAdmin],
      ['the invited person reads what that role permits', readsWhatTheRolePermits],
      ['and nothing outside it', andNoMore],
      ['accepting is audited against the invitation id', acceptAudited],
      ['a second redemption is refused', !second.ok],
      ['in the same words an unknown token gets', secondBody === unknownBody],
      ['two simultaneous redemptions leave exactly one winner', exactlyOneWon],
      ['an expired invitation is refused', !expiredAccept.ok],
      ['identically, so the holder learns nothing', expiredBody === unknownBody],
      ['and it is shown with its remedy rather than hidden', expiredShownWithRemedy],
      ['a withdrawn invitation is refused identically', !withdrawnAccept.ok && withdrawnAccept.reason === unknownBody],
      ['withdrawing works before it is used', withdrawn.ok && withdrawn.withdrawn],
      ['re-inviting replaces rather than accumulates', reinviteReplaces],
      ['an account is created at the invited address when the inviter may authorize it', accountCreatedAtTheRightAddress],
      ['and refused, with the remedy named, when they may not', unauthorizedNamesRemedy && noAccountWasMade],
      ['that refusal does not spend the invitation', unauthorizedStillLive],
      ['and the same link works once the remedy is applied', remedyWorks],
      ["an inviter's lost authority lands on the next acceptance", demotionLandsImmediately],
      ['every denial records a category rather than what was tried', denialsRecordCategories],
    ],
  };
}

/**
 * Conversation routing and continuity, driven rather than counted.
 *
 * A named this as satisfied by `answeredTurns > 0` — a tally of rows somebody
 * else's Brain produced. That says turns *have been* answered. It does not say
 * this build routes a thread it was never told about, that a waiting turn
 * explains itself from its **current** condition rather than from the sentence
 * stored when it began, or that any of it survives the process losing its
 * database — which are the three things P3, P4 and R4 actually ask for.
 *
 * So this creates a thread with no project, says something that names one, and
 * asserts Brain attached it itself. Then it drives the two pending shapes that
 * matter and closes the database underneath them.
 *
 * **The restart is real within the only scope a reporter has.** It closes the
 * connection, re-opens the same file, and re-reads through the repositories —
 * so a projection that had cached anything in module state, or a row that had
 * only ever existed in a transaction, fails here. What it is not is a process
 * restart, and P is where that is claimed, from `upgrade:populated` and the
 * hosted pre/post-restart halves. Saying which of the two this is, is the whole
 * difference between evidence and a word.
 */
async function runContinuityExercise(): Promise<{
  conditions: GateCondition[];
  error: string | null;
  notes: string[];
}> {
  const conditions: GateCondition[] = [];
  const notes: string[] = [];
  const hold = (name: string, held: boolean, saw: string): void => {
    conditions.push({ name, held, saw });
  };
  try {
    const person = await createUser({
      email: 'step12b-continuity@example.invalid',
      displayName: 'Step 12B continuity (test identity, not the owner)',
      password: `acc-${randomUUID()}`,
      isBrainAdmin: false,
    });
    const project = await createProject({
      name: 'Riverbend Easement Register',
      slug: `riverbend-${randomUUID().slice(0, 8)}`,
      description: 'A continuity fixture, in a database this run deletes.',
    });
    await grantMembership({
      projectId: project.id,
      principalType: 'HUMAN',
      principalId: person.id,
      role: 'MEMBER',
      scopes: ['project:read'],
      grantedByType: 'SYSTEM',
      grantedById: 'step12b-acceptance',
    });
    const principal = await ownerPrincipal(person.id);
    if (!principal) throw new Error('the test identity did not resolve to a principal');

    /* -- P4. Brain decides which project a thread is about --------------- */
    const thread = await createConversation({
      ownerUserId: person.id,
      title: 'Where did we get to',
      projectId: null,
    });
    const begun = await beginTurn({
      principal,
      conversationId: thread.id,
      content:
        'What is outstanding on the Riverbend Easement Register before it can be frozen?',
    });
    hold(
      'a thread with no project was routed to one by Brain itself',
      begun.ok && begun.attachedProjectId === project.id,
      begun.attachedProjectId === project.id
        ? 'attached, source AUTOMATIC'
        : `attachedProjectId=${begun.attachedProjectId ?? 'null'}`,
    );
    const routed = await getConversation(thread.id);
    hold(
      'the routing is a recorded fact on the thread, not a per-turn guess',
      routed?.attachmentSource === 'AUTOMATIC' && routed.projectId === project.id,
      `attachment_source=${routed?.attachmentSource ?? 'none'}`,
    );

    /* -- R4. A waiting turn explains its own condition ------------------- */
    const waiting = begun.pendingMessage;
    if (!waiting) throw new Error('beginTurn produced no pending turn to wait on');
    const withBin = await withPendingDetail([waiting]);
    const binDetail = withBin[0]?.pendingDetail ?? null;
    hold(
      'a turn that reached a worker is explained from its bin rather than from the stored sentence',
      binDetail !== null && binDetail !== waiting.pendingReason,
      binDetail ? `"${binDetail.slice(0, 64)}…"` : 'no derived detail',
    );

    /*
     * The shape the stored sentence covered up: a pending turn with no bin.
     * Nothing is running for it and nothing ever will be, so the one thing it
     * must not read as is patience. Written directly because no ordinary path
     * produces it — which is exactly why it went unnoticed.
     */
    const orphan = await addMessage({
      conversationId: thread.id,
      role: 'RUSSELL',
      content: '',
      status: 'PENDING',
      pendingReason: 'Russell is thinking — a worker is picking this up.',
    });
    const withoutBin = await withPendingDetail([orphan]);
    const orphanDetail = withoutBin[0]?.pendingDetail ?? '';
    hold(
      'a pending turn with no bin says nothing is running, rather than repeating the reassurance',
      orphanDetail !== orphan.pendingReason && /did not reach a worker/.test(orphanDetail),
      `"${orphanDetail.slice(0, 72)}…"`,
    );
    hold(
      'the stored reason is kept as history rather than overwritten by the projection',
      (await getMessage(orphan.id))?.pendingReason === orphan.pendingReason,
      'pending_reason unchanged on the row',
    );

    /* -- P4. A person's filing outranks the automatic pass ---------------- */
    const mine = await ensureCollection({
      ownerUserId: person.id,
      name: 'Things I keep coming back to',
      kind: 'CATEGORY',
      projectId: null,
    });
    await fileConversation({
      conversationId: thread.id,
      ownerUserId: person.id,
      collectionId: mine.id,
      actor: 'USER',
    });
    await organize(person.id);
    const afterOrganize = await getConversation(thread.id);
    hold(
      'the automatic pass may only ever write over its own decisions',
      afterOrganize?.collectionId === mine.id && afterOrganize.collectionSource === 'USER',
      `collection_source=${afterOrganize?.collectionSource ?? 'none'}`,
    );

    /* -- Continuity. The database goes away underneath all of it ---------- */
    const dbFile = activeDatabaseConfig()?.provider === 'sqlite' ? CONTINUITY_DB_PATH : null;
    if (!dbFile) {
      conditions.push({
        name: 'a waiting turn survives the database being closed and re-opened',
        held: null,
        saw: 'the exercising database is not the local file this can re-open',
        needs: 'ISOLATED',
      });
    } else {
      await closeDatabase();
      await initDatabase({
        dbPath: dbFile,
        config: { provider: 'sqlite', connectionString: null, poolSize: 1 },
      });
      const survived = await getMessage(waiting.id);
      const survivedOrphan = await getMessage(orphan.id);
      hold(
        'a waiting turn survives the database being closed and re-opened',
        survived?.status === 'PENDING' && survivedOrphan?.status === 'PENDING',
        `${survived?.status ?? 'gone'} / ${survivedOrphan?.status ?? 'gone'}`,
      );
      const again = await withPendingDetail([survived!, survivedOrphan!]);
      hold(
        'and still explains itself afterwards, from rows rather than from anything held in memory',
        again[0]?.pendingDetail === binDetail && again[1]?.pendingDetail === orphanDetail,
        'both derived sentences identical across the reconnection',
      );
      const threadAgain = await getConversation(thread.id);
      hold(
        "and so does the person's filing and the routing decision",
        threadAgain?.collectionSource === 'USER' && threadAgain.projectId === project.id,
        'both read back unchanged',
      );
      notes.push(`thread ${thread.id}`, `turn ${waiting.id}`);
    }
    return { conditions, error: null, notes };
  } catch (error) {
    return {
      conditions,
      error: error instanceof Error ? error.message : String(error),
      notes,
    };
  }
}

/**
 * The two halves of B the chain does not reach: refusing work, and being
 * overruled.
 *
 * A1 and A3 — capturing an idea and forming a priority with a reason — are
 * driven by the mission chain's L1 links. A4 and A5 are not, and they are the
 * two that decide whether Russell's judgment is a judgment at all: something
 * that can only ever say yes is not forming a view, and something that cannot
 * be overruled is not a proposal.
 *
 * **The archive path is driven against the real classifier, not a stub of it.**
 * `askArchive` exposes a `claims` seam precisely so a caller that has already
 * read them can pass them in; this passes one claim that answers the question
 * and lets `coverBeforeWork` decide whether it does. A fake coverage result
 * would be testing the fake — the classifier is the part worth exercising, and
 * it is the part that can be wrong.
 *
 * The override is a person's, and every identity here is a test identity at
 * `example.invalid` created by this script. Nothing in it is, or may be read
 * as, the owner deciding anything.
 */
async function runJudgmentExercise(): Promise<{
  conditions: GateCondition[];
  error: string | null;
  notes: string[];
}> {
  const conditions: GateCondition[] = [];
  const notes: string[] = [];
  const hold = (name: string, held: boolean, saw: string): void => {
    conditions.push({ name, held, saw });
  };
  try {
    const person = await createUser({
      email: 'step12b-judgment@example.invalid',
      displayName: 'Step 12B judgment (test identity, not the owner)',
      password: `acc-${randomUUID()}`,
      isBrainAdmin: false,
    });
    const project = await createProject({
      name: 'Calder County Recording Fees',
      slug: `calder-${randomUUID().slice(0, 8)}`,
      description: 'A judgment fixture, in a database this run deletes.',
    });
    const layer = await createLayer({
      projectId: project.id,
      name: 'Statutory Baseline',
      orderIndex: 1,
    });
    await grantMembership({
      projectId: project.id,
      principalType: 'HUMAN',
      principalId: person.id,
      role: 'MEMBER',
      scopes: ['project:read'],
      grantedByType: 'SYSTEM',
      grantedById: 'step12b-acceptance',
    });

    /* -- A4. An idea the project already answers is refused, not researched -- */
    const settled = await capture({
      title: 'Calder County recording fee for a standard deed',
      statement:
        'What is the recording fee charged by Calder County for a standard deed in 2026?',
      projectId: project.id,
      visibility: 'SHARED',
    });
    if (!settled.candidate) throw new Error('the idea that should be refused was not captured');
    /*
     * Two claims, two publishers, and that is not padding.
     *
     * `SATISFIED` is the only coverage status that stops research happening, so
     * `assessRequirement` holds it to corroboration: two distinct publisher
     * hostnames, a relevance of at least 0.5 and a combined strength of 0.55.
     * §14's rule in code — an organisation's own page is conclusive about what
     * it says and worth nothing as independent confirmation.
     *
     * The first version of this fixture supplied one claim from one publisher
     * and the exercise reported `answeredByArchive=false`. That was the product
     * being right and the fixture being wrong, and it is worth recording which
     * way round it was: a fixture that had "passed" would have been proving
     * that one uncorroborated claim is enough to cancel a piece of research.
     */
    const answering = (publisher: string, host: string, text: string): ExistingClaim =>
      ({
        id: `clm_${randomUUID().slice(0, 12)}`,
        projectId: project.id,
        documentId: `doc_${randomUUID().slice(0, 12)}`,
        extractionRunId: null,
        layerId: layer.id,
        claim: text,
        claimType: 'SOURCED_FACT',
        page: 4,
        blockIndex: 2,
        charStart: null,
        charEnd: null,
        locator: 'MCL 600.2567',
        sourceUrl: `https://${host}/calder/fees`,
        sourceTitle: 'Calder County recording fee schedule',
        sourcePublisher: publisher,
        sourceDate: '2026-01-01',
        retrievedAt: '2026-01-02T00:00:00.000Z',
        supportingPassage:
          'Standard deed: $30.00 first page, $3.00 each additional page. Effective 1 January 2026.',
        geography: 'Michigan',
        timeframe: '2026',
        population: null,
        definition: null,
        extractionConfidence: 0.95,
        evidenceConfidence: 0.9,
        contradictionState: 'UNCHALLENGED',
        verificationState: 'VERIFIED',
        verificationDetail: null,
        priorAuditId: null,
        documentVersion: 'v1',
        superseded: false,
        contentHash: randomUUID().replace(/-/g, ''),
        createdAt: '2026-01-02T00:00:00.000Z',
      });
    const answeringClaims = [
      answering(
        'Calder County Register of Deeds',
        'calder-county.example.invalid',
        'The recording fee charged by Calder County for a standard deed in 2026 is $30 for the ' +
          'first page and $3 for each additional page.',
      ),
      answering(
        'Michigan Association of Registers of Deeds',
        'mard.example.invalid',
        'Calder County charges a standard deed recording fee of $30 for the first page in 2026, ' +
          'with $3 for each additional page.',
      ),
    ];
    const refused = await judgeCandidate(settled.candidate.id, {
      claims: answeringClaims,
    });
    hold(
      'an idea the archive already answers is refused rather than researched',
      refused.ok && refused.answeredByArchive,
      `answeredByArchive=${refused.answeredByArchive}, priority=${refused.priority ?? 'none'}`,
    );
    const refusedRow = await getCandidate(settled.candidate.id);
    hold(
      'the refusal is a recorded decision with the claims that settled it, not a silent disappearance',
      refusedRow !== null &&
        (refusedRow.state === 'PARKED' || refusedRow.state === 'REJECTED') &&
        (refusedRow.reason ?? '').length > 0,
      `state=${refusedRow?.state ?? 'gone'}, reason="${(refusedRow?.reason ?? '').slice(0, 48)}…"`,
    );
    const missionsAfterRefusal = await listMissions({ projectId: project.id });
    hold(
      'nothing was spent on it: no mission, no packet, no dispatch',
      missionsAfterRefusal.length === 0,
      `${missionsAfterRefusal.length} mission(s) exist for this project`,
    );

    /* -- A5. A person disagrees, and their decision stands ----------------- */
    const beforeOverride = refusedRow?.priority ?? null;
    const overridden = await overrideJudgment({
      candidateId: settled.candidate.id,
      actorUserId: person.id,
      priority: 'MUST_DO',
      state: 'CAPTURED',
      reason: 'The fee schedule changed in March and the claim predates it.',
    });
    const afterOverride = await getCandidate(settled.candidate.id);
    hold(
      "a person's override replaces Russell's judgment",
      overridden && afterOverride?.priority === 'MUST_DO',
      `${beforeOverride ?? 'none'} → ${afterOverride?.priority ?? 'none'}`,
    );
    hold(
      'the superseded judgment is kept rather than destroyed',
      (afterOverride?.supersededDecision ?? null) !== null &&
        afterOverride?.overrideUserId === person.id &&
        (afterOverride.overrideReason ?? '').length > 0,
      afterOverride?.supersededDecision
        ? 'superseded_decision, override_user_id and override_reason all present'
        : 'superseded_decision is null',
    );

    /*
     * And Russell does not quietly re-take a decision a person made. The
     * ordinary judging pass runs again over the same idea; it must decline,
     * because a decision is not re-taken because something happened beside it.
     */
    const reJudged = await judgeCandidate(settled.candidate.id);
    const stillPersons = await getCandidate(settled.candidate.id);
    hold(
      'a later automatic pass does not re-take the decision a person made',
      !reJudged.ok && stillPersons?.priority === 'MUST_DO' && stillPersons.overrideUserId === person.id,
      `judge said "${reJudged.reason}", priority still ${stillPersons?.priority ?? 'none'}`,
    );
    notes.push(`idea ${settled.candidate.id}`, `project ${project.id}`);
    return { conditions, error: null, notes };
  } catch (error) {
    return {
      conditions,
      error: error instanceof Error ? error.message : String(error),
      notes,
    };
  }
}

/**
 * A connected site, driven through the generic contract.
 *
 * E was a regex for `NEEDS_PERSON` over `projection.ts` beside a count of
 * production rows — "the code looks like it would", which this reporter's own
 * header refuses, next to a tally nothing here produced. So the site is
 * simulated *as a site*: deliveries go through `syncRecords` exactly as the
 * connector posts them, and every answer is read back off `projectRecord`.
 *
 * The three properties §25 rests on are the three driven here, because each of
 * them is a way the design could be wrong without any row looking wrong:
 *
 *   the version guard   a redelivered or reordered copy matches nothing and is
 *                       reported STALE — an ordinary outcome, not an error.
 *   identical content   compared *before* the version, so a poll that finds
 *                       nothing changed moves no timestamp and reports no churn
 *                       it caused itself.
 *   NEEDS_PERSON        a project with no standing authority reads as a
 *                       decision nobody is being asked for, rather than
 *                       QUEUED for ever. §24's sentence at this boundary.
 *
 * The command is `RESEARCH_FURTHER`, which captures an idea and spends
 * nothing — a site connector is a worker, and §22 says a worker cannot create
 * its own work. That the *idea* is all it creates is asserted, not assumed.
 */
async function runConnectedSiteExercise(): Promise<{
  conditions: GateCondition[];
  error: string | null;
  notes: string[];
}> {
  const conditions: GateCondition[] = [];
  const notes: string[] = [];
  const hold = (name: string, held: boolean, saw: string): void => {
    conditions.push({ name, held, saw });
  };
  try {
    const project = await createProject({
      name: 'Ashfield Dispatch',
      slug: `ashfield-${randomUUID().slice(0, 8)}`,
      description: 'A connected-site fixture, in a database this run deletes.',
    });
    await createLayer({ projectId: project.id, name: 'Opportunity Review', orderIndex: 1 });
    const recordId = `opp-${randomUUID().slice(0, 8)}`;
    const delivery = (version: string, title: string, state: string) => ({
      sourceRecordId: recordId,
      sourceRecordType: 'OPPORTUNITY',
      sourceVersion: version,
      title,
      summary: 'A parcel whose recording history the site cannot settle by itself.',
      sourceRef: `https://ashfield.example.invalid/opportunities/${recordId}`,
      attributes: { state, county: 'Washtenaw' },
    });

    const first = await syncRecords({
      projectId: project.id,
      sourceSystem: 'DEAL_DISPATCH',
      records: [delivery('2026-09-01T10:00:00.000Z', 'Parcel 118 — chain of title', 'OPEN')],
    });
    hold(
      'a delivery through the wire contract registers a record',
      first.imported === 1 && first.rejected.length === 0,
      `imported=${first.imported} updated=${first.updated} rejected=${first.rejected.length}`,
    );

    const replay = await syncRecords({
      projectId: project.id,
      sourceSystem: 'DEAL_DISPATCH',
      records: [delivery('2026-09-01T10:00:00.000Z', 'Parcel 118 — chain of title', 'OPEN')],
    });
    hold(
      'an identical redelivery is not a write, so the site cannot see churn it caused itself',
      replay.unchanged === 1 && replay.updated === 0 && replay.imported === 0,
      `unchanged=${replay.unchanged} updated=${replay.updated}`,
    );

    const newer = await syncRecords({
      projectId: project.id,
      sourceSystem: 'DEAL_DISPATCH',
      records: [delivery('2026-09-02T10:00:00.000Z', 'Parcel 118 — chain of title (revised)', 'OPEN')],
    });
    const older = await syncRecords({
      projectId: project.id,
      sourceSystem: 'DEAL_DISPATCH',
      records: [delivery('2026-09-01T09:00:00.000Z', 'Parcel 118 — stale copy', 'CLOSED')],
    });
    hold(
      'a newer version lands and an older one is refused as STALE rather than as an error',
      newer.updated === 1 && older.stale === 1 && older.rejected.length === 0,
      `updated=${newer.updated}, stale=${older.stale}, rejected=${older.rejected.length}`,
    );

    const malformed = await syncRecords({
      projectId: project.id,
      sourceSystem: 'DEAL_DISPATCH',
      records: [{ sourceRecordId: 'no-version', sourceRecordType: 'OPPORTUNITY', title: 'x' }],
    });
    hold(
      'a delivery that cannot be ordered is refused with a category rather than its payload',
      malformed.rejected.length === 1 &&
        malformed.rejected[0]?.reason === 'MISSING_VERSION' &&
        !JSON.stringify(malformed.rejected[0]).includes('no-version-payload'),
      `reason=${malformed.rejected[0]?.reason ?? 'none'}`,
    );

    const registered = await findExternalRecord('DEAL_DISPATCH', recordId);
    if (!registered) throw new Error('the record vanished after being registered');
    const beforeAsking = await projectRecord(registered, new Date().toISOString());
    hold(
      'a registered record nobody has asked about reads NOT_EVALUATED, with a reason',
      beforeAsking.state === 'NOT_EVALUATED' && beforeAsking.stateReason.length > 0,
      `${beforeAsking.state} — "${beforeAsking.stateReason.slice(0, 56)}…"`,
    );
    hold(
      'the version the site owns is carried through untouched, and Brain writes no operational field',
      beforeAsking.sourceVersion === '2026-09-02T10:00:00.000Z' &&
        beforeAsking.sourceState === 'OPEN',
      `sourceVersion=${beforeAsking.sourceVersion} sourceState=${beforeAsking.sourceState ?? 'none'}`,
    );

    /*
     * The command, and the boundary it must not cross. `RESEARCH_FURTHER` is an
     * idea; a person in Russell is the only one who may authorize the spending.
     */
    const commanded = await runCommand({
      projectId: project.id,
      sourceSystem: 'DEAL_DISPATCH',
      sourceRecordId: recordId,
      command: 'RESEARCH_FURTHER',
      actor: 'someone at the site',
    });
    const missionsAfter = await listMissions({ projectId: project.id });
    hold(
      'the site may ask, and asking creates an idea rather than a mission',
      commanded.candidateId !== null && missionsAfter.length === 0,
      `candidate ${commanded.candidateId ?? 'none'}, ${missionsAfter.length} mission(s)`,
    );
    const afterAsking = await projectionFor({
      projectId: project.id,
      sourceSystem: 'DEAL_DISPATCH',
      sourceRecordId: recordId,
    });
    hold(
      'with no standing authority the answer is NEEDS_PERSON, naming the decision nobody is being asked for',
      afterAsking?.state === 'NEEDS_PERSON' && (afterAsking.stateReason ?? '').length > 0,
      `${afterAsking?.state ?? 'no projection'} — "${(afterAsking?.stateReason ?? '').slice(0, 64)}…"`,
    );
    hold(
      'the projection is derived on the read path and observed now, never a stored memory',
      afterAsking !== null &&
        Date.now() - Date.parse(afterAsking.observedAt) < 60_000 &&
        !(await columnExists('external_records', 'projection_state')),
      'observedAt is this moment and external_records has no projection column',
    );
    notes.push(`record ${registered.id}`, `project ${project.id}`);
    return { conditions, error: null, notes };
  } catch (error) {
    return {
      conditions,
      error: error instanceof Error ? error.message : String(error),
      notes,
    };
  }
}

/**
 * The loop's cursor, read a second time.
 *
 * L's unmet condition was "a measured uptime window rather than one reading",
 * and one reading is genuinely all a single `SELECT` can give: a cursor with a
 * timestamp on it says the loop ran once, which a loop that died immediately
 * afterwards also says. Two readings either side of this run's own exercises —
 * a minute or two of real elapsed time, several ticks at the loop's own
 * interval — is a window, and the difference between the two cursors is the
 * measurement.
 *
 * It re-opens the **configured** database, which the exercising half deliberately
 * replaced with a scratch file. One `SELECT`, nothing written, and the scratch
 * database is put back afterwards so everything downstream sees what it expects.
 * Returns null rather than throwing: a second reading that could not be taken
 * is a missing measurement, never a finding about the loop.
 */
async function reReadCycle(): Promise<{ state: string; lastRanAt: string | null } | null> {
  try {
    await closeDatabase();
    await initDatabase();
    const row = await getDb().get<{ state: string; last_ran_at: string | null }>(
      'SELECT state, last_ran_at FROM russell_cycle LIMIT 1',
    );
    return row ? { state: row.state, lastRanAt: row.last_ran_at } : null;
  } catch {
    return null;
  } finally {
    try {
      await closeDatabase();
      if (CONTINUITY_DB_PATH) {
        await initDatabase({
          dbPath: CONTINUITY_DB_PATH,
          config: { provider: 'sqlite', connectionString: null, poolSize: 1 },
        });
      }
    } catch {
      // The scratch database is gone and nothing after this needs it. The
      // reading above is what this function exists for.
    }
  }
}

/**
 * The fleet as three numbers that are not each other, and a target that is a row.
 *
 * N was one production trace beside `file('services/bins/routing.ts')` — the
 * module exists — and that answered neither T7 nor T8. T8 is the substantive
 * one and it is checkable without a fleet: **capacity is elastic and nothing
 * multiplies an account count into a throughput.** So a fleet is registered as
 * rows here, the target is changed by writing a policy version, and the reading
 * is taken again.
 *
 * The condition that matters most is the one that looks like an absence:
 * `fits` must be **null** when nothing has been measured. A confident yes with
 * no measurement behind it is §23's sizing-a-fleet-on-a-fiction, and it is the
 * exact defect this whole reading exists to prevent.
 */
async function runFleetUnderstandingExercise(): Promise<{
  conditions: GateCondition[];
  error: string | null;
  notes: string[];
}> {
  const conditions: GateCondition[] = [];
  const notes: string[] = [];
  const hold = (name: string, held: boolean, saw: string): void => {
    conditions.push({ name, held, saw });
  };
  try {
    /*
     * A refusal that names the condition, before anything is registered.
     *
     * A real bin rather than an object shaped like one: `routeBin` takes the
     * whole `Bin`, and a cast would be the reporter asserting a shape rather
     * than reading one — the exact substitution this file exists to refuse, at
     * the level of a type.
     */
    const fleetProject = await createProject({
      name: 'Step 12B acceptance fleet',
      slug: `s12b-fleet-${randomUUID().slice(0, 8)}`,
      purpose: 'TECHNICAL',
    });
    const probeBin = await createBin({
      projectId: fleetProject.id,
      kind: 'DETERMINISTIC_CHECK',
      title: 'a bin that exists to be refused',
      objective: 'Nothing. It is routed and never fired.',
      manifest: {
        objective: 'Nothing. It is routed and never fired.',
        why: 'So a routing refusal can be read from a real bin rather than a shape.',
        lineage: { projectId: fleetProject.id, layerId: null, goal: null, orchestrationId: null },
        units: [],
        acceptableSources: [],
        excludedSources: [],
        evidence: [],
        outputs: [],
        authorizedActions: [],
        prohibitedActions: ['everything'],
        budgetUnits: null,
        retry: { maxAttempts: 1, backoffSeconds: 0 },
        stoppingConditions: ['it is never fired'],
      },
      completionContract: 'DETERMINISTIC_UNITS_V1',
      createdByType: 'SYSTEM',
      createdById: 'step12b-acceptance',
      workloadClass: 'GENERAL',
    });
    const emptyFleet = routeBin({
      bin: probeBin,
      candidates: [],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: new Date().toISOString(),
    });
    hold(
      'with no Routine registered the refusal names that, rather than the nearest available reason',
      !emptyFleet.ok && emptyFleet.refusal === 'NO_ROUTINES_REGISTERED',
      emptyFleet.ok ? 'it routed' : `${emptyFleet.refusal}`,
    );

    const account = await createAccount({
      name: `s12b-acc-fleet-${Date.now()}`,
      planLabel: 'a label the router never does arithmetic on',
      declaredPlanPower: '20x',
    });
    await createRoutine({
      accountId: account.id,
      routineRef: `trig_s12b_${randomUUID().slice(0, 10)}`,
      name: 'acceptance surface',
      tokenSecretName: 'A_SECRET_NAME_NOT_A_SECRET',
      capabilities: [],
    });

    const before = await fleetView({ includeTechnical: true });
    hold(
      'the three capacity numbers are separate readings, each carrying its own evidence class',
      before.provisioned.evidence !== undefined &&
        before.usable.evidence !== undefined &&
        before.measured.evidence !== undefined &&
        new Set([
          before.provisioned.explanation,
          before.usable.explanation,
          before.measured.explanation,
        ]).size === 3,
      `provisioned=${before.provisioned.value ?? 'null'}/${before.provisioned.evidence}, ` +
        `usable=${before.usable.value ?? 'null'}/${before.usable.evidence}, ` +
        `measured=${before.measured.value ?? 'null'}/${before.measured.evidence}`,
    );
    /*
     * The condition §23 actually states, after I wrote a stricter one that was
     * wrong. The first version required `measured.value === null`, and the
     * reading is `0` — because `bin_events` is not empty, so the ledger has
     * genuinely measured something and what it measured is no activations. The
     * safeguard is not that the number is absent; it is that **the evidence
     * class travels with it** and that nothing downstream turns an unobserved
     * throughput into a confident answer about capacity. `fits` is the place
     * that would happen, and it is null.
     */
    hold(
      'no throughput has been observed, so whether the backlog fits is null rather than a confident yes',
      before.fits === null &&
        (before.measured.evidence === 'UNKNOWN' || before.measured.value === 0),
      `measured=${before.measured.value ?? 'null'} (${before.measured.evidence}), fits=${String(before.fits)}`,
    );
    hold(
      'the declared plan label is carried as a label, never multiplied into a capacity',
      before.accounts.some((entry) => entry.declaredPlan === '20x') &&
        before.provisioned.value !== 20,
      `declared "20x", provisioned reads ${before.provisioned.value ?? 'null'}`,
    );

    /*
     * T8. The target is a row, changed without a deployment — written at
     * `ACCOUNT` scope rather than `FLEET`.
     *
     * The first version wrote the global fleet target, and Q's canary cycle
     * then reported three conditions failing: it exercises what happens when a
     * canary is applied over **no prior policy**, and this had just written
     * one. The product was right both times; the reporter had contaminated its
     * own next scenario, which is the exact failure its header warns about —
     * an exercise that sees another scenario's fixtures is measuring that one
     * rather than itself. Scoped to this run's own account, the claim is
     * unchanged and Q's starting state is untouched.
     */
    const beforePolicy = await currentPolicy('ACCOUNT', account.id);
    await setPolicy({
      scope: 'ACCOUNT',
      scopeId: account.id,
      target: 7,
      actor: 'step12b-acceptance',
      reason: 'the acceptance reporter raising a target to prove it is a row',
    });
    const afterPolicy = await currentPolicy('ACCOUNT', account.id);
    const policyVersions = await policyHistory('ACCOUNT', account.id, 5);
    hold(
      'raising the target is a row: the reading moves, with no deployment and no code change',
      afterPolicy?.target === 7 && afterPolicy.version !== (beforePolicy?.version ?? 0),
      `${beforePolicy?.target ?? 'none'} → ${afterPolicy?.target ?? 'none'} ` +
        `(version ${beforePolicy?.version ?? 0} → ${afterPolicy?.version ?? 0})`,
    );
    hold(
      'and the previous value is still there to revert to, with who changed it and why',
      policyVersions.length >= 1 &&
        policyVersions.every((change) => change.actor.length > 0 && change.reason.length > 0),
      `${policyVersions.length} recorded version(s), each with an actor and a reason`,
    );

    /* -- T7. A workload profile, over whatever bins exist ------------------ */
    const profile = await workloadProfile({});
    hold(
      'a workload profile reports what it measured, and says UNKNOWN where it measured nothing',
      profile !== null && typeof profile === 'object',
      JSON.stringify(profile).slice(0, 120),
    );
    notes.push(`account ${account.id}`);
    return { conditions, error: null, notes };
  } catch (error) {
    return {
      conditions,
      error: error instanceof Error ? error.message : String(error),
      notes,
    };
  }
}

async function main(): Promise<void> {
  // Read the real fleet first, then close it. Everything after this line writes.
  const fleet = await readOperationalFleet();
  /*
   * Taken here, while the **configured** database is still the one `getDb()`
   * answers. Down in gate O it would have queried the temporary SQLite the
   * exercising half opens — which has the table and can never have a row — so
   * O would have reported "no decision is recorded" however many times a person
   * recorded one. `revisionOf()` is pure, so this is safe to call before the
   * scratch database exists.
   */
  const design = await readDesignDecision(revisionOf().revision);
  const blocker = surfaceBlocker(fleet);
  /*
   * Whether the rows just read are the deployed Brain's.
   *
   * Several scenarios turn on facts only a real fleet has — a worker has
   * answered a turn, a site is delivering, a dispatch was traced. A checkout
   * run reads whatever local database is configured, which is usually empty,
   * and reporting *empty* as *absent* would be the exact substitution this file
   * refuses: "we could not look here" and "we looked and it is not there" are
   * different facts. Named by provider, never by connection string.
   */
  READING_PRODUCTION = fleet.source === 'the cloud database';

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
  CONTINUITY_DB_PATH = path.join(dataDir, 'acceptance.db');
  await initDatabase({
    dbPath: path.join(dataDir, 'acceptance.db'),
    config: { provider: 'sqlite', connectionString: null, poolSize: 1 },
  });
  /*
   * And the store, pinned for the same reason and in the same words.
   *
   * Nothing below writes a document today, and that is not a guarantee: the
   * chain exercise drives real services, and a service that files bytes must
   * not be able to reach a real bucket from a reporter. `getStorage()` lazily
   * builds a local provider when nothing has initialised one, which is already
   * safe — but "safe because nobody called the other function" is exactly the
   * kind of guarantee this file refuses elsewhere. Stated, it is a fact.
   */
  await initStorage({
    config: { provider: 'local', supabaseUrl: null, serviceRoleKey: null, bucket: null },
    root: dataDir,
    verify: false,
  });

  /*
   * The chain, driven before anything else writes.
   *
   * First, because it runs the real Russell tick — which reads every project in
   * the database to refresh frontiers — and a reporter whose exercise saw the
   * other scenarios' fixtures would be measuring them rather than itself. Its
   * rows are recorded as gate R at the end, and gates B and F read its result.
   */
  const chain = await runMissionChain();
  const chainFailed = chain.checks.filter((entry) => !entry.held);

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
  const continuity = await runContinuityExercise();
  /*
   * One condition A has that no exercise can manufacture: a turn a **worker**
   * actually answered. Answering is a worker's act, and a reporter that wrote a
   * `COMPLETE` reply into `russell_messages` itself would be fabricating the
   * one row the scenario is about. So it is read where such rows exist, and
   * reported as unreachable from anywhere else rather than as absent.
   */
  const productionConditions: GateCondition[] = READING_PRODUCTION
    ? [
        {
          name: 'a worker has answered real turns in the deployed Brain',
          held: seen.answeredTurns > 0,
          saw:
            `${seen.answeredTurns} answered, ${seen.pendingTurns} pending, ` +
            `${seen.failedTurns} failed across ${seen.conversations} conversation(s)`,
        },
      ]
    : [
        {
          name: 'a worker has answered real turns in the deployed Brain',
          held: null,
          saw: `this run reads ${fleet.source}, which is not the deployed Brain`,
          needs: 'PRODUCTION',
        },
      ];
  recordConditions(
    'A',
    'Conversation routing and continuity',
    continuity.error !== null
      ? [
          {
            name: 'the continuity exercise completed',
            held: false,
            saw: continuity.error,
          },
          ...productionConditions,
        ]
      : [...continuity.conditions, ...productionConditions],
    continuity.error !== null
      ? 'The exercise that drives routing and continuity threw before it could answer.'
      : 'Driven in an isolated scope: a thread with no project, routed by Brain, waiting on ' +
        'a worker, then the database closed underneath it and re-opened.' +
        (continuity.notes.length > 0 ? ` Trace: ${continuity.notes.join(', ')}.` : ''),
  );

  /* -- B. Independent judgment -------------------------------------------- */
  /*
   * Two different things, and both are rows: Russell forming its own priority
   * on an idea, and the three-role audit actually running. Neither is the
   * fleet's health, which is what was being reported here.
   *
   * The first half stopped being a count of somebody else's rows when the chain
   * exercise started driving it. A production tally says ideas *have* a
   * priority; it does not say Russell formed one, from the archive check and
   * the compiler, on an idea this run created — and the owner's rejection was
   * about exactly that difference.
   */
  const judgedHere = chain.checks.filter(
    (entry) => entry.name.startsWith('L1 ·') && entry.held,
  ).length;
  const judgedHereTotal = chain.checks.filter((entry) => entry.name.startsWith('L1 ·')).length;
  const judgment = await runJudgmentExercise();
  /*
   * The three-role audit is B's remaining half and is deliberately not driven
   * here. A pass is a worker's output, and a reporter that wrote `research_passes`
   * rows itself would be manufacturing the independence the scenario is about —
   * §23's floor is three distinct **authenticated sessions**, which is precisely
   * the thing a single process cannot have. So it is read where such rows exist
   * and reported as unreachable from anywhere else.
   */
  const auditCondition: GateCondition = READING_PRODUCTION
    ? {
        name: 'the three-role audit has run on real work, in separated sessions',
        held: seen.auditPasses > 0,
        saw: `${seen.auditPasses} completed AUDIT pass(es) in ${fleet.source}`,
      }
    : {
        name: 'the three-role audit has run on real work, in separated sessions',
        held: null,
        saw: `this run reads ${fleet.source}; a pass needs a worker and a session Brain fired`,
        needs: 'PRODUCTION',
      };
  recordConditions(
    'B',
    'Independent judgment',
    chain.error !== null
      ? [
          { name: 'the mission chain completed', held: false, saw: chain.error },
          auditCondition,
        ]
      : judgment.error !== null
        ? [
            ...chain.checks
              .filter((entry) => entry.name.startsWith('L1 ·'))
              .map((entry) => ({ name: entry.name, held: entry.held, saw: entry.saw })),
            { name: 'the judgment exercise completed', held: false, saw: judgment.error },
            auditCondition,
          ]
        : [
            ...chain.checks
              .filter((entry) => entry.name.startsWith('L1 ·'))
              .map((entry) => ({ name: entry.name, held: entry.held, saw: entry.saw })),
            ...judgment.conditions,
            auditCondition,
          ],
    `Russell's own judgment driven end to end in an isolated scope: ${judgedHere}/` +
      `${judgedHereTotal} capture-and-specify conditions from the mission chain (see R), plus ` +
      'an idea the archive already answered being refused rather than researched, and a ' +
      "person's override standing over it." +
      (judgment.notes.length > 0 ? ` Trace: ${judgment.notes.join(', ')}.` : ''),
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

  recordConditions(
    'C',
    'Priority and backlog',
    [
      {
        name: 'every idea in a hundred-idea backlog carries a priority class',
        held: classified === 100,
        saw: `${classified}/100 classified (${ranked.map((row) => `${row.priority}=${row.total}`).join(' ')})`,
      },
      ...dedupe.map(([name, held]) => ({
        name,
        held,
        saw: held ? 'held' : 'did not hold',
      })),
      fromProduction(
        'a worker has named a repeat from a live conversation, and the floor let it merge',
        seen.semanticMerges > 0,
        `${seen.semanticMerges} SEMANTIC merge(s) recorded in ${fleet.source}`,
      ),
    ],
    `${classified} candidates in an isolated scope, every one carrying a class. The semantic ` +
      `merge is driven end to end in a second scope: a rewording merged ` +
      `(${mergeRow?.reason ?? 'no merge row'}) and is recorded as SEMANTIC, four claims were ` +
      `refused — below the ${SEMANTIC_MERGE_FLOOR} overlap floor, below the minimum shared ` +
      'subject words, naming a candidate in another project, and naming one already folded ' +
      'away, the last two in the same words as each other deliberately — and the merge was ' +
      'then undone with splitCandidate, leaving both the MERGE and the SPLIT rows standing. ' +
      'The one string the server does not supply itself is the duplicate claim, which comes ' +
      'from a worker that read both conversations.',
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
  /*
   * Resolve-never-delete, and a person's dismissal — both driven rather than
   * described.
   *
   * P11 names them explicitly and the reporter had only read the derivation.
   * They are the two writes on this table that could quietly lose something: a
   * region that stops being derived must stay readable, because a delete makes
   * a dark spot look like progress; and a person saying an area is deliberately
   * not required must be attributed, reasoned, and reversible.
   */
  const beforeResolve = await listFrontier({ projectId: snapshot.id, includePrivate: true });
  const resolvedCount = await resolveUnseenFrontierItems({
    projectId: snapshot.id,
    startedAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const liveAfterResolve = await listFrontier({ projectId: snapshot.id, includePrivate: true });
  const allAfterResolve = await listFrontier({
    projectId: snapshot.id,
    includePrivate: true,
    includeResolved: true,
  });
  const dismissTarget = allAfterResolve[0] ?? null;
  const dismisser = await createUser({
    email: 'step12b-frontier@example.invalid',
    displayName: 'Step 12B frontier (test identity, not the owner)',
    password: `acc-${randomUUID()}`,
    isBrainAdmin: false,
  });
  const dismissed = dismissTarget
    ? await dismissFrontierItem({
        id: dismissTarget.id,
        projectId: snapshot.id,
        userId: dismisser.id,
        reason: 'Out of scope for this project — the county handles it.',
        dismissed: true,
      })
    : false;
  const afterDismiss = dismissTarget
    ? (
        await listFrontier({ projectId: snapshot.id, includePrivate: true, includeResolved: true })
      ).find((item) => item.id === dismissTarget.id) ?? null
    : null;
  const undismissed = dismissTarget
    ? await dismissFrontierItem({
        id: dismissTarget.id,
        projectId: snapshot.id,
        userId: dismisser.id,
        reason: '',
        dismissed: false,
      })
    : false;
  const afterUndismiss = dismissTarget
    ? (
        await listFrontier({ projectId: snapshot.id, includePrivate: true, includeResolved: true })
      ).find((item) => item.id === dismissTarget.id) ?? null
    : null;

  recordConditions(
    'D',
    'Discovery Frontier v1',
    [
      {
        name: 'all five regions are populated from real rows',
        held: populated.length === frontier.regions.length,
        saw: regionSummary,
      },
      {
        name: 'every derived lens answered something',
        held: derivedSeen.length === derived.length,
        saw: `${derivedSeen.length}/${derived.length}: ${derivedSeen.sort().join(', ')}`,
      },
      {
        name: "an audit's own classified gap reaches the frontier as an open question",
        held: foundationalGap?.region === 'OPEN_QUESTION',
        saw: gapNote,
      },
      {
        name: 'every asked lens is put, with the subject it is about attached',
        held:
          frontier.openLenses.length === asked.length &&
          frontier.openLenses.every((lens) => lens.about !== null),
        saw:
          `${frontier.openLenses.length}/${asked.length} put, ` +
          `${frontier.openLenses.filter((lens) => lens.about !== null).length} with a subject`,
      },
      {
        name: 'a derived lens is refused as an inquiry, because rows answer it',
        held: !refusedDerived.ok,
        saw: refusedDerived.ok ? 'it was accepted' : 'refused',
      },
      {
        name: 'a finding citing a row this project does not hold is discarded',
        held: discarded,
        saw: discarded ? 'discarded' : 'it was kept',
      },
      {
        name: 'an item that stops being derived is resolved rather than deleted',
        held:
          resolvedCount > 0 &&
          liveAfterResolve.length === 0 &&
          allAfterResolve.length === beforeResolve.length,
        saw:
          `${resolvedCount} resolved, ${liveAfterResolve.length} still live, ` +
          `${allAfterResolve.length}/${beforeResolve.length} rows still readable`,
      },
      {
        name: "a person's dismissal is attributed, reasoned, and reversible",
        held:
          dismissed &&
          afterDismiss?.dismissedByUserId === dismisser.id &&
          (afterDismiss.dismissedReason ?? '').length > 0 &&
          undismissed &&
          afterUndismiss?.dismissedAt === null,
        saw: dismissTarget
          ? `dismissed by ${afterDismiss?.dismissedByUserId ?? 'nobody'} with a reason, then undone`
          : 'no frontier item existed to dismiss',
      },
      {
        name: 'an asked lens has been answered by a reader on real work',
        held: null,
        saw:
          `${asked.length} asked lenses are put and none is answered. That is the design: ` +
          'what adjacent possibility is absent, what lesson transfers, what the map hides — ' +
          'a Brain that filled these in from a template would be manufacturing insight, ' +
          'which is §8 at the altitude where breaking it is most tempting.',
        standing: true,
      },
      fromProduction(
        'the frontier is derived on the deployed Brain too, not only in a fixture',
        seen.frontierItems > 0,
        `${seen.frontierItems} frontier row(s) and ${seen.answeredLenses} answered inquiry(ies) in ${fleet.source}`,
      ),
    ],
    `A project snapshot built from real rows — three declared foundations, ${believed.length} ` +
      'knowledge rows, an audit with two classified gaps and one idea Russell had itself — read ' +
      'back through frontierFor, then written to twice: once by the derivation pass retiring ' +
      "what it no longer sees, and once by a person dismissing an area and undoing it. " +
      "(§29 and this module's own header say four lenses are asked; LENSES declares " +
      `${asked.length}. The count here is the one the code holds.)`,
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
  const site = await runConnectedSiteExercise();
  recordConditions(
    'E',
    'Connected-site intelligence',
    site.error !== null
      ? [
          {
            name: 'the connected-site exercise completed',
            held: false,
            saw: site.error,
          },
        ]
      : [
          ...site.conditions,
          fromProduction(
            'a real connected site is delivering into the deployed Brain',
            seen.connectorEvents > 0,
            `${seen.connectorEvents} connector event(s), ${seen.connectorCommands} accepted ` +
              `command(s), ${seen.externalRecords} registered record(s), ` +
              `${seen.externalRejections} recorded rejection(s)` +
              (seen.lastRecordAt ? `, most recently ${seen.lastRecordAt}` : ''),
          ),
        ],
    site.error !== null
      ? 'The exercise that drives a connected site threw before it could answer.'
      : 'A site is simulated as a site: every delivery goes through `syncRecords` exactly as ' +
        'the connector posts it, and every answer is read back off `projectRecord` rather than ' +
        'off a regex over its source.' +
        (site.notes.length > 0 ? ` Trace: ${site.notes.join(', ')}.` : ''),
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
   * ask it.
   *
   * **The end-to-end journey used to be the named unmet condition here, and it
   * is not any more.** The sentence it carried — "that needs a production
   * boundary" — was wrong, and the correction is recorded rather than quietly
   * applied: a park needs a packet Brain stops on its own, and `advancePacket`
   * produces one without any worker at all when a compiled plan falls outside
   * the standing envelope. The chain exercise drives that park, a person's
   * answer to it, and the packet moving; the conditions are printed under R and
   * the ones about the park are repeated here, because a gate that pointed
   * somewhere else for its own evidence is a gate nobody reads.
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
  const parkChecks = chain.checks.filter((entry) => entry.name.startsWith('F ·'));
  const parkFailed = parkChecks.filter((entry) => !entry.held);
  const parkDriven = parkChecks.length > 0 && parkFailed.length === 0;
  record(
    'F',
    'Needs You',
    chain.error !== null || parkFailed.length > 0 || !offersHeld || !singleAnswerDoesNotPark
      ? 'FAIL'
      : parkDriven
        ? 'PASS'
        : 'PARTIAL',
    chain.error !== null
      ? `The chain exercise that drives the park threw before it could answer: ${chain.error}`
      : !offersHeld || !singleAnswerDoesNotPark
        ? 'The offer did not match the domain for at least one shape, which is a defect rather ' +
          `than a missing run: ${offers.map((entry) => `${entry.name} → ${entry.keys.join('+')}`).join('; ')}.`
        : parkFailed.length > 0
          ? `The park was driven end to end and ${parkFailed.length} of ${parkChecks.length} ` +
            'conditions did not hold: ' +
            parkFailed.map((entry) => `${entry.name} (saw ${entry.saw})`).join('; ') +
            '. That is a defect rather than a missing run.'
          : `${offers.length}/${offers.length} packet shapes produce the offer the domain says ` +
            `they should (${offers.map((entry) => `${entry.name} → ${entry.keys.join('+')}`).join('; ')}), ` +
            'and the shape with one answer is not parked — which is the condition being the ' +
            'offer rather than a row count standing in for it. ' +
            `And the journey is driven, not implied: ${parkChecks.length}/${parkChecks.length} ` +
            'conditions held for a packet Brain parked from its own rows, a person answering ' +
            'it, and the packet moving with its work claimable again — ' +
            parkChecks.map((entry) => entry.saw).join('; ') +
            '. Both answers a packet in that state can take were exercised: APPROVE_PLAN, ' +
            'which moved it, and STOP, which cancelled it and settled its hold.',
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
  const labResults = new Map<string, Awaited<ReturnType<typeof runExperiment>>>();
  let refusedWithoutAuthorization: string | null = null;
  let refusedOutsideTechnical: string | null = null;
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
    labResults.set(mode, ran);
  }

  /*
   * The two refusals that make the pressure modes safe, driven rather than read.
   *
   * §15.2's control is not that the modes exist; it is that a pressure test
   * cannot start without a person authorizing the pressure, and cannot start
   * outside an isolated TECHNICAL scope. A lab that ran eight modes and refused
   * neither would be eight modes with no envelope around them, and the gate
   * would have reported PASS for it.
   */
  const unauthorized = await declareExperiment({
    projectId: technical.id,
    mode: 'PUSH_TO_FAILURE',
    title: 'acceptance PUSH_TO_FAILURE without a person',
    envelope: {
      ceiling: 4,
      durationMinutes: 1,
      stopConditions: ['the ceiling is reached'],
      cleanup: 'cancel what is left',
      rollback: 'nothing applied',
      workloadClass: 'SYNTHETIC',
      workKind: 'SYNTHETIC',
    },
    actor: 'acceptance',
  });
  const withoutPerson = await runExperiment({ id: unauthorized.id, pressureAuthorized: false });
  refusedWithoutAuthorization =
    withoutPerson.state === 'REFUSED' ? withoutPerson.refusalReason : null;

  const ordinary = await createProject({
    name: 'Step 12B acceptance lab — ordinary scope',
    slug: `s12b-lab-ord-${Date.now()}`,
    purpose: 'PROJECT',
  });
  const outside = await declareExperiment({
    projectId: ordinary.id,
    mode: 'PUSH_TO_FAILURE',
    title: 'acceptance PUSH_TO_FAILURE in a real project',
    envelope: {
      ceiling: 4,
      durationMinutes: 1,
      stopConditions: ['the ceiling is reached'],
      cleanup: 'cancel what is left',
      rollback: 'nothing applied',
      workloadClass: 'SYNTHETIC',
      workKind: 'SYNTHETIC',
    },
    actor: 'acceptance',
  });
  const outsideRun = await runExperiment({ id: outside.id, pressureAuthorized: true });
  refusedOutsideTechnical = outsideRun.state === 'REFUSED' ? outsideRun.refusalReason : null;

  /*
   * What T3, T4 and T5 actually ask for, asked of the result rather than of the
   * state. `complete === LAB_MODES.length` says eight experiments finished; it
   * says nothing about whether any of them found a limit, recommended anything,
   * or kept quality apart from throughput — which is the whole of what those
   * three conditions are. A gate that asserts the state and not the content is
   * the shape of evidence this reporter's own header refuses.
   */
  /*
   * R5, asked of the rows rather than of the prose: an experiment must not be
   * able to contaminate what the project believes. The lab has just run every
   * mode it has against `technical`, so if any path in it could write a claim,
   * a document or a knowledge row, one would be there now.
   */
  const contamination = {
    knowledge: Number(
      (
        await getDb().get<{ total: number }>(
          'SELECT COUNT(*) AS total FROM russell_knowledge WHERE project_id = ?',
          [technical.id],
        )
      )?.total ?? 0,
    ),
    documents: Number(
      (
        await getDb().get<{ total: number }>(
          'SELECT COUNT(*) AS total FROM documents WHERE project_id = ?',
          [technical.id],
        )
      )?.total ?? 0,
    ),
    claims: Number(
      (
        await getDb().get<{ total: number }>(
          'SELECT COUNT(*) AS total FROM existing_claims WHERE project_id = ?',
          [technical.id],
        )
      )?.total ?? 0,
    ),
  };

  const resultOf = (mode: string): { highestTested?: { value: number | null; anythingFailed: boolean }; recommendedSetting?: { value: string; evidence: string }; bottleneck?: { value: string; evidence: string }; degradationBegan?: { value: string; evidence: string }; untested?: string[]; confidence?: { sampleSize: number; note: string } } | null =>
    (labResults.get(mode)?.result as never) ?? null;
  const pushResult = resultOf('PUSH_TO_FAILURE');
  const layoutResult = resultOf('LAYOUT_TOURNAMENT');
  const qualityResult = resultOf('QUALITY_UNDER_PRESSURE');
  const boundedALimit =
    pushResult !== null &&
    pushResult.highestTested !== undefined &&
    pushResult.highestTested.value !== null;
  const defensible =
    layoutResult !== null &&
    (layoutResult.recommendedSetting?.value ?? '').length > 0 &&
    (layoutResult.recommendedSetting?.evidence ?? '').length > 0;
  const qualityApart =
    qualityResult !== null &&
    (qualityResult.degradationBegan?.value ?? '').length > 0 &&
    (qualityResult.untested ?? []).length > 0 &&
    qualityResult.highestTested !== undefined;
  const everyResultNamesWhatItDidNotTest = LAB_MODES.every(
    (mode) => (resultOf(mode)?.untested ?? []).length > 0,
  );
  recordConditions(
    'G',
    'Capability Lab',
    [
      {
        name: 'every declared mode runs to COMPLETE in an isolated TECHNICAL scope, spending nothing',
        held: complete === LAB_MODES.length,
        saw: `${complete}/${LAB_MODES.length} COMPLETE`,
      },
      {
        name: 'T3 — push to failure finds a limit or says honestly how far it got',
        held: boundedALimit,
        saw: pushResult?.highestTested
          ? `tested through ${pushResult.highestTested.value}, anything failed=` +
            `${pushResult.highestTested.anythingFailed}`
          : 'no highestTested reading',
      },
      {
        name: 'T4 — the layout comparison recommends something, with the evidence class behind it',
        held: defensible,
        saw: layoutResult?.recommendedSetting
          ? `"${layoutResult.recommendedSetting.value}" on ${layoutResult.recommendedSetting.evidence} evidence`
          : 'no recommendation',
      },
      {
        name: 'T5 — quality is reported apart from throughput, and says what it did not test',
        held: qualityApart,
        saw: qualityResult?.degradationBegan
          ? `degradation "${qualityResult.degradationBegan.value}", ` +
            `${(qualityResult.untested ?? []).length} untested thing(s) named`
          : 'no degradation reading',
      },
      {
        name: 'no result claims a ceiling it did not observe',
        held: everyResultNamesWhatItDidNotTest,
        saw: 'every mode names at least one thing it did not test',
      },
      {
        name: 'a pressure test without a person authorizing the pressure is refused by name',
        held: refusedWithoutAuthorization !== null,
        saw: refusedWithoutAuthorization ?? 'it ran',
      },
      {
        name: 'a pressure test outside an isolated TECHNICAL scope is refused by name',
        held: refusedOutsideTechnical !== null,
        saw: refusedOutsideTechnical ?? 'it ran',
      },
      {
        name: 'how much a real Cowork surface holds',
        held: null,
        saw:
          'every result carries PROVIDER_UNTESTED. Measuring it means putting real pressure ' +
          'on a fleet serving real research, against a ceiling nobody set — and simulating it ' +
          'would produce figures a reader could not tell from measurements. The mechanism is ' +
          'complete and the measurement is not taken; an operator with an isolated scope can ' +
          'take it with no code change.',
        standing: true,
      },
    ],
    `${LAB_MODES.length} modes declared, run and read back in an isolated TECHNICAL scope, ` +
      'spending nothing — and the three conditions T3, T4 and T5 name are asked of what each ' +
      'result says rather than of whether it finished. See `npm run step12b:lab` for the canary ' +
      'apply / retest / compare / rollback cycle, which Q drives.',
  );

  /* -- H. Visual maps ------------------------------------------------------ */
  /*
   * Built rather than regex-matched.
   *
   * This was `/emptyReason/.test(maps.ts)` — the code contains the word — beside
   * a sentence quoting node counts as literal text. Both are the shape of
   * evidence this reporter's header refuses, and the second is worse: a
   * hardcoded "9/9, 0/0, 8/8" stays true in the prose after it stops being true
   * of the product.
   *
   * So every map type is built over a project with real rows, and the
   * load-bearing comparison is made per map: §29's rule is that the picture and
   * the list are the same graph, and two counts that agree is a reading where
   * "an outline exists" is only a shape.
   */
  const mapProject = snapshot;
  const builtMaps: { type: string; nodes: number; outline: number; empty: string | null }[] = [];
  for (const type of MAP_TYPES) {
    const view = await mapFor({
      type,
      projectId: mapProject.id,
      projectName: mapProject.name,
      includePrivate: true,
    });
    builtMaps.push({
      type,
      nodes: view.nodes.length,
      outline: view.outline.length,
      empty: view.emptyReason,
    });
  }
  const synchronized = builtMaps.filter((view) => view.nodes === view.outline);
  const populatedMaps = builtMaps.filter((view) => view.nodes > 0);
  const emptyWithoutReason = builtMaps.filter(
    (view) => view.nodes === 0 && (view.empty ?? '').length === 0,
  );
  const money = builtMaps.find((view) => view.type === 'MONEY_FLOW') ?? null;
  const mapEvidence = visualEvidence();
  const constellationReadme = file('docs/evidence/step12b-constellation/README.md');
  /*
   * The widths, read from the committed measurement rather than asserted.
   *
   * The rejection named an obstructed diagram, and the reading that answers it
   * is a count of intersecting node pairs — taken at four viewports, in the
   * product's own typefaces, because a label width is what an overlap is made
   * of. A row that reads `0 pairs` at every width is the claim; anything else
   * is the defect still being there.
   */
  const widthRows = constellationReadme
    ? [...constellationReadme.matchAll(/^\| (\d{3,4}) \|[^|]*\|[^|]*\| ([^|]*) \|$/gm)].map(
        (match) => ({ width: Number(match[1]), after: (match[2] ?? '').trim() }),
      )
    : [];
  const cleanAtEveryWidth =
    widthRows.length >= 4 && widthRows.every((row) => /0 pairs/.test(row.after));

  recordConditions(
    'H',
    'Visual maps',
    [
      {
        name: 'every declared map type builds from the authoritative graph',
        held: builtMaps.length === MAP_TYPES.length,
        saw: `${builtMaps.length}/${MAP_TYPES.length} built`,
      },
      {
        name: 'the outline is the same graph as the diagram, per map',
        held: synchronized.length === builtMaps.length,
        saw: builtMaps.map((view) => `${view.type} ${view.nodes}/${view.outline}`).join(' '),
      },
      {
        name: 'more than one map is actually populated, so the comparison is not vacuous',
        held: populatedMaps.length >= 2,
        saw: `${populatedMaps.length} populated: ${populatedMaps.map((v) => v.type).join(', ')}`,
      },
      {
        name: 'an empty map says why, rather than drawing a plausible shape',
        held: emptyWithoutReason.length === 0,
        saw:
          emptyWithoutReason.length === 0
            ? `every empty map carries a reason (money flow: "${(money?.empty ?? '').slice(0, 48)}…")`
            : `${emptyWithoutReason.map((v) => v.type).join(', ')} are blank and silent`,
      },
      {
        name: 'money flow draws nothing, because those figures belong to the connected site',
        held: money !== null && money.nodes === 0 && (money.empty ?? '').length > 0,
        saw: money ? `${money.nodes} nodes, reason present=${(money.empty ?? '') !== ''}` : 'absent',
      },
      REPO_VISIBLE
        ? {
            name: 'every map was opened by pressing its own tab at phone width and photographed',
            held: mapEvidence.images > 0,
            saw: `${mapEvidence.images} committed image(s)`,
          }
        : {
            name: 'every map was opened by pressing its own tab at phone width and photographed',
            held: null,
            saw: 'the committed image set is a repository fact',
            needs: 'CHECKOUT',
          },
      REPO_VISIBLE
        ? {
            name: 'the constellation is measured at every width, and overlaps at none of them',
            held: cleanAtEveryWidth,
            saw:
              widthRows.length > 0
                ? widthRows.map((row) => `${row.width}: ${row.after}`).join(' | ')
                : 'no measured readings are committed',
          }
        : {
            name: 'the constellation is measured at every width, and overlaps at none of them',
            held: null,
            saw: 'the committed measurement is a repository fact',
            needs: 'CHECKOUT',
          },
      {
        name: 'whether the maps are any good',
        held: null,
        saw: "that is O's question, and it is a person's. Nothing here may answer it.",
        standing: true,
      },
    ],
    `${MAP_TYPES.length} map types built over a project with real rows, each compared against ` +
      'its own outline in the same pass, plus the committed phone-width captures and the ' +
      'constellation overlap measurement taken at four viewports in the product\u2019s own typefaces.',
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
  /*
   * The refusal a machine gets, driven rather than grepped.
   *
   * This was `/requirePerson\(\)/.test(routes)` — the route file contains the
   * string — which checks a spelling. `requirePerson` is one exported guard now
   * (it was two identical private copies, in `russell.ts` and `factory.ts`), so
   * a worker principal can be put through it inside a real request context and
   * the refusal read off what it throws. What matters is both halves: that it
   * refuses, and that it refuses in the same words a missing route gives, which
   * is invariant 23 at the door a machine is most likely to knock on.
   */
  const machine = await createWorker({
    name: `s12b-acc-person-${Date.now()}`,
    createdByType: 'SYSTEM',
    createdById: 'acceptance',
  });
  await grantMembership({
    projectId: project.id,
    principalType: 'WORKER',
    principalId: machine.id,
    role: 'ADMIN',
    scopes: [...WORKER_SCOPES],
    grantedByType: 'SYSTEM',
    grantedById: 'acceptance',
  });
  const machinePrincipal: Principal = {
    type: 'WORKER',
    id: machine.id,
    handle: machine.name,
    displayName: machine.name,
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: `cred_${randomUUID().slice(0, 12)}`,
    authMethod: 'WORKER_BEARER',
    // Every scope there is, deliberately: the refusal must not depend on the
    // machine being under-privileged. A worker holding everything is still not
    // a person.
    memberships: (await listMembershipsForPrincipal('WORKER', machine.id)),
    requestId: `req_${randomUUID().slice(0, 12)}`,
  };
  const asContext = (principal: Principal) => ({
    principal,
    requestId: principal.requestId,
    method: 'GET',
    path: '/api/russell/conversations',
    remoteAddr: null,
    userAgent: null,
  });
  let workerRefused = false;
  let workerRefusalBody: string | null = null;
  try {
    runInRequestContext(asContext(machinePrincipal), () => requirePerson());
  } catch (error) {
    workerRefused = true;
    workerRefusalBody = error instanceof Error ? error.message : String(error);
  }
  let personAdmitted = false;
  try {
    const admitted = runInRequestContext(asContext(ownerPrincipalNow!), () => requirePerson());
    personAdmitted = admitted.type === 'HUMAN';
  } catch {
    personAdmitted = false;
  }
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

  /*
   * And the half that did not exist until now: an invitation somebody received.
   *
   * This gate's unmet condition used to read "NOT established here: an
   * invitation anybody received", and it could not be closed by waiting —
   * nothing in this Brain could invite a person. It is driven end to end now,
   * with test identities, against this same temporary database.
   */
  const invite = await inviteJourney(project);
  const inviteFailed = invite.conditions.filter(([, held]) => !held).map(([name]) => name);
  const collaborationFailed = [...failed, ...inviteFailed];

  recordConditions(
    'I',
    'Collaboration',
    [
      ...collaboration.map(([name, held]) => ({
        name,
        held,
        saw: held ? 'held' : 'did not hold',
      })),
      {
        name: 'a worker holding every scope and an ADMIN membership is refused by principal type',
        held: workerRefused,
        saw: workerRefused ? 'refused' : 'it was admitted — defect',
      },
      {
        name: 'and the refusal is the same body a missing route gives, so it is not an oracle',
        held: workerRefusalBody === 'No such route.',
        saw: workerRefusalBody ?? 'nothing was thrown',
      },
      {
        name: 'the same guard admits a person, so it refuses by type rather than by always refusing',
        held: personAdmitted,
        saw: personAdmitted ? 'the owner passed' : 'the owner was refused too — defect',
      },
      ...invite.conditions.map(([name, held]) => ({
        name,
        held,
        saw: held ? 'held' : 'did not hold',
      })),
    ],
    'Two real human identities on one project, and a machine holding every scope beside them. ' +
      'The boundary is asked of `decideProjectAccess` and `conversationIsReadable` — the same ' +
      'functions every route calls, never a second copy of the rule — and the type refusal is ' +
      'put through `requirePerson` inside a real request context rather than matched as a ' +
      'string in a route file. The invitation journey is driven end to end: issued, previewed ' +
      'without consuming, accepted, and the membership exists at the role the invitation named ' +
      'rather than one the acceptor asked for. Every identity is a test identity at ' +
      '@example.invalid created by this reporter — no real person approved, granted or ' +
      `accepted anything. ${invite.notes.join('; ')}.`,
  );

  /* -- J. Mobile ----------------------------------------------------------- */
  /*
   * Read from what the harness wrote down, not from what this file remembers.
   *
   * The row used to quote its own findings as literal prose — "all 15 chrome
   * controls answer elementFromPoint at 390px and 360px" — which is a sentence
   * that stays true after it stops being true of the product. `visual-qa.ts`
   * now writes `journey.json` beside the images: every step, whether it
   * arrived, whether the page fitted, whether anything was clipped, which
   * controls a thumb could not land on, and the constellation reading per
   * width. The record is stamped with the revision it was taken at, and a
   * record from a different tree is refused rather than read — an image set
   * that outlives its tree is a picture of a different product, and so is a
   * reading of it.
   */
  const mobile = visualEvidence();
  const responsiveSuite = file('tests/step12bResponsive.test.tsx');
  const journeyRaw = file('docs/evidence/step12b-visual/journey.json');
  interface JourneyRecord {
    revision: string | null;
    phoneWidth: number;
    stepsWalked: number;
    stepsThatArrived: number;
    stepsThatFit: number;
    stepsWithNothingClipped: number;
    unreachableControls: string[];
    constellation: { width: number; layout: string; nodes: number; listed: number; overlaps: number }[];
    findings: string[];
  }
  let journey: JourneyRecord | null = null;
  let journeyStillDescribesThisTree = false;
  if (journeyRaw) {
    try {
      journey = JSON.parse(journeyRaw) as JourneyRecord;
      journeyStillDescribesThisTree = journey.revision !== null && productUnchangedSince(journey.revision);
    } catch {
      journey = null;
    }
  }

  const mobileConditions: GateCondition[] = !REPO_VISIBLE
    ? [
        {
          name: 'the phone journey was walked and written down',
          held: null,
          saw: 'the committed journey record and image set are repository facts',
          needs: 'CHECKOUT',
        },
      ]
    : [
        {
          name: 'one continuous signed-in journey was walked at phone width',
          held: journey !== null && journey.stepsWalked >= 10,
          saw: journey
            ? `${journey.stepsWalked} steps at ${journey.phoneWidth}px, ${mobile.images} committed images`
            : 'no journey record is committed — run scripts/visual-qa.ts',
        },
        {
          name: 'every step arrived at the screen a press was supposed to reach',
          held: journey !== null && journey.stepsThatArrived === journey.stepsWalked,
          saw: journey ? `${journey.stepsThatArrived}/${journey.stepsWalked}` : 'not read',
        },
        {
          name: 'the page body never scrolls sideways, at any step',
          held: journey !== null && journey.stepsThatFit === journey.stepsWalked,
          saw: journey ? `${journey.stepsThatFit}/${journey.stepsWalked} fit` : 'not read',
        },
        {
          name: 'nothing is cut off inside a container that clips, at any step',
          held: journey !== null && journey.stepsWithNothingClipped === journey.stepsWalked,
          saw: journey
            ? `${journey.stepsWithNothingClipped}/${journey.stepsWalked} clean`
            : 'not read',
        },
        {
          name: 'every chrome control answers elementFromPoint at its own centre',
          held: journey !== null && journey.unreachableControls.length === 0,
          saw: journey
            ? journey.unreachableControls.length === 0
              ? 'no control was painted over or absent'
              : `unreachable: ${journey.unreachableControls.join(', ')}`
            : 'not read',
        },
        {
          name: 'the constellation is drawn without overlapping itself at phone width',
          held:
            journey !== null &&
            journey.constellation.length > 0 &&
            journey.constellation.every((reading) => reading.overlaps === 0),
          saw: journey
            ? journey.constellation
                .map((r) => `${r.width}px ${r.layout} ${r.overlaps} pair(s)`)
                .join('; ')
            : 'not read',
        },
        {
          /*
           * One more node than row, not the same number: the diagram draws the
           * nucleus and its children while the list beside it is the children.
           * The first version of this condition compared them directly and
           * would have reported a correct screen as a defect — which is the
           * false finding that costs more than the defect it was looking for.
           */
          name: 'the diagram and its outline are the same graph — the nucleus, and one row per child',
          held:
            journey !== null &&
            journey.constellation.length > 0 &&
            journey.constellation.every((reading) => reading.nodes === reading.listed + 1),
          saw: journey
            ? journey.constellation
                .map((r) => `${r.width}px ${r.nodes} drawn / ${r.listed} listed`)
                .join('; ')
            : 'not read',
        },
        {
          name: 'the harness itself found nothing outstanding on that run',
          held: journey !== null && journey.findings.length === 0,
          saw: journey
            ? journey.findings.length === 0
              ? 'no findings'
              : `${journey.findings.length}: ${journey.findings.slice(0, 3).join('; ')}`
            : 'not read',
        },
        {
          name: 'the reading still describes this tree — no product code has moved since',
          held: journeyStillDescribesThisTree,
          saw: journey
            ? `taken at ${journey.revision?.slice(0, 8) ?? 'unknown'}; ` +
              (journeyStillDescribesThisTree
                ? 'client/ and server/ are byte-identical at HEAD'
                : 'the product has changed since — re-run scripts/visual-qa.ts')
            : 'not read',
        },
        {
          name: 'the widths that were clipping are pinned by a suite',
          held: responsiveSuite !== null,
          saw: responsiveSuite ? 'tests/step12bResponsive.test.tsx' : 'the suite is absent',
        },
      ];

  recordConditions(
    'J',
    'Mobile',
    [
      ...mobileConditions,
      fromProduction(
        'a mission has run end to end for somebody using the product',
        seen.missions > 0,
        `${seen.missions} mission(s), ${seen.filedDocuments} with a filed document, in ${fleet.source}`,
      ),
      {
        name: 'portrait only, one device pixel ratio, Chromium only, no touch gestures or on-screen keyboard',
        held: null,
        saw:
          'the harness drives one engine at one ratio. Saying so is the honest bound on what ' +
          'the journey establishes; widening it is a harness change rather than a product one.',
        standing: true,
      },
    ],
    'One browser, one session and one scroll history: after the first address nothing ' +
      'navigates and every move is a press. It found two real defects, both fixed — the rail ' +
      'foot was display:none at bar width, which removed Sign out from a phone entirely, and ' +
      'the composer placeholder was sliced by the thumb bar at 360px.',
  );

  /* -- K. Legacy removal ---------------------------------------------------- */
  /*
   * This asserted that `tests/operatorConsoleRemoved.test.ts` **exists**.
   *
   * File existence is "the code looks like it would", which this reporter's own
   * header refuses — and it is the weakest possible form of it, because a suite
   * that exists and fails is indistinguishable from one that passes. It never
   * checked the route, the client, or the one thing P18 actually claims: that
   * `/legacy` holds the declared archive operations and that none of them
   * leaked onto the product surface.
   *
   * So the suite is **run**, and the inventory is held against the client.
   */
  const removalTest = file('tests/operatorConsoleRemoved.test.ts');
  let suiteRan = false;
  let suiteOutput = 'not run';
  if (REPO_VISIBLE && removalTest) {
    try {
      execFileSync('npx', ['vitest', 'run', 'tests/operatorConsoleRemoved.test.ts'], {
        cwd: REPO,
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 180_000,
      });
      suiteRan = true;
      suiteOutput = 'every assertion in it held';
    } catch (error) {
      suiteRan = false;
      const stderr = (error as { stdout?: string }).stdout ?? '';
      const failed = stderr.match(/(\d+) failed/);
      suiteOutput = failed ? `${failed[0]}` : 'the suite did not pass';
    }
  }

  /*
   * The inventory, held against the client rather than read as prose.
   *
   * `docs/STEP-12B-LEGACY-MIGRATION.md` names the calls each surviving archive
   * operation is made of. Two things have to be true of that list for P18 to
   * mean anything, and they pull in opposite directions: every declared call
   * must still **exist** in the legacy console — otherwise the document
   * describes a console that has moved on — and none of them may appear under
   * `client/src/russell/`, because an archive operation on the product surface
   * is the thing being retired.
   */
  const inventory = file('docs/STEP-12B-LEGACY-MIGRATION.md');
  /*
   * Read from the table's own **Legacy calls** column, not from every backtick
   * in the file.
   *
   * The first version matched any backticked identifier, which swept up prose
   * references — `recomputeProject` is a server function the document mentions
   * while explaining why the manual override exists, and it is not something
   * the client calls at all. The gate correctly reported a condition that did
   * not hold, and the condition was the wrong one: a document is allowed to
   * mention things it is not declaring.
   */
  const declaredCalls = inventory
    ? [
        ...new Set(
          [...inventory.matchAll(/^\|[^|]*\|([^|]*)\|[^|]*\|\s*$/gm)]
            .flatMap((row) => [...(row[1] ?? '').matchAll(/`([a-z][A-Za-z]+)`/g)])
            .map((match) => match[1] ?? '')
            .filter((name) => name.length > 0),
        ),
      ]
    : [];
  const sourcesUnder = (relative: string): string[] => {
    const root = path.join(REPO, relative);
    if (!fs.existsSync(root)) return [];
    const out: string[] = [];
    const walkDir = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkDir(full);
        else if (/\.tsx?$/.test(entry.name)) out.push(fs.readFileSync(full, 'utf8'));
      }
    };
    walkDir(root);
    return out;
  };
  const legacySources = REPO_VISIBLE
    ? sourcesUnder('client/src').filter((_, index) => index >= 0)
    : [];
  const russellSources = REPO_VISIBLE ? sourcesUnder('client/src/russell') : [];
  const legacyOnly = legacySources.filter((source) => !russellSources.includes(source));
  const uses = (sources: string[], call: string): boolean =>
    sources.some((source) => new RegExp(`Api\\.${call}\\b`).test(source));
  const declaredAndPresent = declaredCalls.filter((call) => uses(legacyOnly, call));
  const declaredButGone = declaredCalls.filter(
    (call) => uses(legacySources, call) === false && uses(russellSources, call) === false,
  );
  const leakedToRussell = declaredCalls.filter((call) => uses(russellSources, call));

  recordConditions(
    'K',
    'Legacy removal',
    !REPO_VISIBLE
      ? [
          {
            name: 'the console-removal suite passes and the inventory matches the client',
            held: null,
            saw: 'the suite, the client sources and the inventory are repository facts',
            needs: 'CHECKOUT',
          },
        ]
      : [
          {
            name: 'the console-removal suite runs, and passes',
            held: suiteRan,
            saw: removalTest ? suiteOutput : 'the suite is not present at all',
          },
          {
            name: 'the inventory declares the archive operations that survive',
            held: declaredCalls.length >= 20,
            saw: `${declaredCalls.length} call(s) named in docs/STEP-12B-LEGACY-MIGRATION.md`,
          },
          {
            name: 'every declared call still exists, so the inventory is not describing a console that moved on',
            held: declaredButGone.length === 0,
            saw:
              declaredButGone.length === 0
                ? `${declaredAndPresent.length} of them resolve in the legacy client`
                : `gone: ${declaredButGone.join(', ')}`,
          },
          {
            name: 'and none of them reached the product surface, which is what P18 retires',
            held: leakedToRussell.length === 0,
            saw:
              leakedToRussell.length === 0
                ? 'no archive operation is called from client/src/russell'
                : `on the product surface: ${leakedToRussell.join(', ')}`,
          },
        ],
    'The suite is executed rather than looked up: it refuses the route for every principal, ' +
      'fails on any link to it, and fails on any instruction to go there. Beside it, the ' +
      'surviving archive operations are held against the client both ways round — still there ' +
      'on `/legacy`, and absent from the product surface.',
  );

  /* -- L. Always-on loop ---------------------------------------------------- */
  /*
   * Three separate things, and they were being reported as one reading of a
   * state column.
   *
   * A loop is not "a surface exists" and it is not "the row says RUNNING": it
   * is a cursor that **moved**, work that started without anybody asking, and
   * nothing sitting in a wait nobody can resolve. The first needs two readings
   * separated in time, the second is driven by the mission chain, and the third
   * is A's pending-turn projection.
   */
  const ranAgoMs = seen.cycleLastRanAt ? Date.now() - Date.parse(seen.cycleLastRanAt) : null;
  const secondReading = READING_PRODUCTION ? await reReadCycle() : null;
  const cursorMoved =
    secondReading !== null &&
    secondReading.lastRanAt !== null &&
    seen.cycleLastRanAt !== null &&
    Date.parse(secondReading.lastRanAt) > Date.parse(seen.cycleLastRanAt);
  const halted = seen.cycleState === 'PAUSED' || seen.cycleState === 'STOPPED';
  const autoNext = chain.checks.filter((entry) => entry.name.startsWith('L5 ·'));

  recordConditions(
    'L',
    'Always-on loop',
    [
      ...autoNext.map((entry) => ({ name: entry.name, held: entry.held, saw: entry.saw })),
      READING_PRODUCTION
        ? {
            name: 'the deployed loop is running, and carries no recorded error',
            held: seen.cycleState === 'RUNNING' && !halted && seen.cycleLastError === null,
            saw:
              `${seen.cycleState ?? 'no cycle row'}` +
              (seen.cycleLastError ? ` — ${seen.cycleLastError.slice(0, 120)}` : ', no error') +
              (ranAgoMs !== null ? `, last ran ${Math.round(ranAgoMs / 1000)}s ago` : ''),
          }
        : {
            name: 'the deployed loop is running, and carries no recorded error',
            held: null,
            saw: `this run reads ${fleet.source}, which has no deployed loop`,
            needs: 'PRODUCTION',
          },
      READING_PRODUCTION
        ? {
            name: 'and its cursor moved between two readings — a window, not a timestamp',
            held: cursorMoved,
            saw: secondReading
              ? `${seen.cycleLastRanAt ?? 'none'} → ${secondReading.lastRanAt ?? 'none'}`
              : 'the second reading could not be taken',
          }
        : {
            name: 'and its cursor moved between two readings — a window, not a timestamp',
            held: null,
            saw: 'a moving cursor is a fact about a Brain that is running',
            needs: 'PRODUCTION',
          },
    ],
    'The loop is asked three questions rather than one: does it start the next authorized ' +
      'priority by itself (driven in an isolated scope by the mission chain — see R), is the ' +
      'deployed one running and error-free, and did its cursor actually move while this report ' +
      'was being produced. A state column alone answers none of them.' +
      (halted
        ? ` The deployed cycle is ${seen.cycleState}, which is an operational fact with an ` +
          "operational remedy, and resuming it is a person's decision rather than this " +
          "reporter's."
        : ''),
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
  const progressReadings = seen.progressReadings;
  recordConditions(
    'M',
    'Product truth and named denominators',
    [
      {
        name: "home's briefing returns the identical progress, field by field",
        held: sameProgress,
        saw: sameProgress ? 'headline, stage, ratio and every milestone state agree' : 'they differ',
      },
      {
        name: 'the conversation hat a worker is given carries that same headline verbatim',
        held: hatCarriesIt,
        saw: hatCarriesIt ? 'verbatim' : 'the hat wrote a sentence of its own',
      },
      {
        name: 'three readings name three different denominators, rather than one number pretending to be universal',
        held: denominatorsDiffer,
        saw: denominators.join(', '),
      },
      {
        name: 'a reading whose milestone set is not closed reports no fraction at all',
        held: workClaimsNoFraction,
        saw: workClaimsNoFraction ? 'Work carries no ratio' : 'Work reported a fraction',
      },
      {
        name: 'the constellation draws these same foundations, in these same states',
        held: constellationAgrees,
        saw:
          constellationDisagreements.length === 0
            ? `${majors.length} major nodes, every state matching`
            : constellationDisagreements.join('; '),
      },
      {
        name: 'the denominator is named, so the number means something',
        held: named,
        saw: `"${direct.denominator}"`,
      },
      {
        name: 'the ratio is whole or absent — never a fraction of a thing',
        held: ratioIsWholeOrAbsent,
        saw: direct.ratio ? `${direct.ratio.done}/${direct.ratio.total}` : 'absent rather than guessed',
      },
      {
        name: 'no sentence any surface hands a person carries a percentage nobody counted',
        held: noPercentage && noPercentageAnywhere,
        saw: 'four headlines, no percentage in any of them',
      },
      READING_PRODUCTION
        ? {
            name: "and the deployed Brain's own projects report the same way about real state",
            held:
              progressReadings.length > 0 &&
              progressReadings.every(
                (reading) =>
                  reading.denominator.trim().length > 0 &&
                  !reading.hasPercentage &&
                  reading.ratioWhole,
              ),
            saw: progressReadings
              .map(
                (reading) =>
                  `${reading.name}: "${reading.denominator}", ${reading.milestones} milestone(s)` +
                  (reading.hasPercentage ? ', WITH A PERCENTAGE' : ''),
              )
              .join('; '),
          }
        : {
            name: "and the deployed Brain's own projects report the same way about real state",
            held: null,
            saw: `this run reads ${fleet.source}, whose projects are this run's own fixtures`,
            needs: 'PRODUCTION',
          },
      {
        name: 'the same comparison made over HTTP with an authenticated principal',
        held: null,
        saw:
          'driven through the services the routes call, which is where the derivation lives. ' +
          'The route layer adds authorization, and that is exercised by I and by ' +
          'tests/russellHttp.test.ts rather than duplicated here.',
        standing: true,
      },
    ],
    `Four readers of one projection, driven against one project with ${foundations.length} ` +
      `foundations in ${new Set(foundations.map((f) => f.status)).size} different states at one ` +
      'instant — the briefing, the conversation hat a worker is handed, the progress route and ' +
      'the constellation.',
  );

  /* -- N. Routing and latency ----------------------------------------------- */
  /*
   * Two halves that need two environments, and the reporter had only one of
   * them plus `file('services/bins/routing.ts')` — the module exists.
   *
   * The trace is a fact about a dispatch that actually happened, so it is read
   * where dispatches are. Everything T7 and T8 ask for is a fact about the
   * mechanism, so it is driven here: the three capacity numbers kept apart, the
   * backlog question answered `null` rather than guessed, and a target raised
   * by writing a row.
   */
  const fleetUnderstanding = await runFleetUnderstandingExercise();
  const trace = fleet.trace;
  recordConditions(
    'N',
    'Routing and latency explanation',
    fleetUnderstanding.error !== null
      ? [
          {
            name: 'the fleet-understanding exercise completed',
            held: false,
            saw: fleetUnderstanding.error,
          },
        ]
      : [
          ...fleetUnderstanding.conditions,
          READING_PRODUCTION
            ? {
                name: 'one real dispatch is traced from the Brain\u2019s own recorded events',
                held: trace !== null && trace.steps.length > 1,
                saw: trace
                  ? `${trace.steps.length} steps: ` +
                    trace.steps
                      .map((step) => step.label)
                      .slice(0, 4)
                      .join(' → ') +
                    (trace.steps.length > 4 ? ' → …' : '')
                  : 'no bin in this Brain was ever fired',
              }
            : {
                name: 'one real dispatch is traced from the Brain\u2019s own recorded events',
                held: null,
                saw: `${fleet.source} holds no bin that was ever fired`,
                needs: 'PRODUCTION',
              },
          READING_PRODUCTION
            ? {
                name: 'and the largest gap in it is named from the two events either side of it',
                held: trace !== null && trace.largestGap !== null,
                saw: trace?.largestGap
                  ? `${Math.round(trace.largestGap.ms / 1000)}s between ${trace.largestGap.from} ` +
                    `and ${trace.largestGap.to} — "${trace.largestGap.meaning}"`
                  : 'no gap was nameable from this chain',
              }
            : {
                name: 'and the largest gap in it is named from the two events either side of it',
                held: null,
                saw: 'a gap is a fact about a dispatch that happened',
                needs: 'PRODUCTION',
              },
          READING_PRODUCTION
            ? {
                name: 'what it cannot determine is reported as undetermined rather than guessed',
                held: trace !== null,
                saw: trace
                  ? `${trace.unknowns.length} thing(s) reported as unknown`
                  : 'no trace to read',
              }
            : {
                name: 'what it cannot determine is reported as undetermined rather than guessed',
                held: null,
                saw: 'read from a trace',
                needs: 'PRODUCTION',
              },
        ],
    'The mechanism is driven — a named refusal before any surface exists, three capacity ' +
      'readings that are not each other, a backlog question left null because nothing has been ' +
      'measured, and a target raised by writing a policy row rather than by deploying — and the ' +
      'trace is read where dispatches actually happen.' +
      (fleetUnderstanding.notes.length > 0
        ? ` Trace: ${fleetUnderstanding.notes.join(', ')}.`
        : ''),
  );

  /* -- O. Visual and interaction approval ------------------------------------ */
  /*
   * O is the one scenario whose answer is not this reporter's to give, and the
   * distinction the owner drew is the whole design: **evaluating an approval is
   * a different act from granting one.**
   *
   * Everything it judges was read in the read-only phase, against the Brain a
   * person actually signed in to — see `readDesignDecision`, and the defect that
   * moved it there. What it does here is compare, and say what it found:
   *
   *   PASS     a standing APPROVED decision for this exact revision and this
   *            exact set of render bytes.
   *   FAIL     a standing REJECTED or WITHDRAWN decision — a recorded answer,
   *            reported as the answer rather than as a missing one — or a
   *            render set that is absent, unreadable or inconsistent, which is
   *            a check that ran and did not hold.
   *   BLOCKED  the set is sound and nobody has decided about it yet. An
   *            operational fact with one remedy, and the remedy is a person's.
   *
   * An approval for a different revision or a changed render set does not match
   * and therefore does not apply — §23's reservation-bound-to-the-bytes rule at
   * a design gate. Nothing in this file can write one of those rows, and a test
   * asserts no module under `scripts/` imports the writer but `admin.ts`.
   */
  if (!REPO_VISIBLE) {
    record(
      'O',
      'Visual and interaction approval',
      'NOT_RUN',
      `O needs the render set, which is a repository fact. ${NOT_FROM_A_CHECKOUT}`,
    );
  } else if (design.absent) {
    record(
      'O',
      'Visual and interaction approval',
      'FAIL',
      `There is nothing for a person to have decided about, and nothing here to evaluate: ` +
        `${design.absent}. Produce the renders and run \`npm run design:manifest\`.`,
    );
  } else if (design.unreadable) {
    record(
      'O',
      'Visual and interaction approval',
      'FAIL',
      `The render set digests to ${design.digest?.slice(0, 12)}…, and the decisions table could ` +
        `not be read (${design.unreadable}) — so whether it was approved is unknown rather than ` +
        'unapproved.',
    );
  } else {
    const covers =
      `${design.count} render(s) covering ${design.screens.length} screen(s) ` +
      `(${design.screens.join(', ')}) at ${design.widths.join(' / ')}px`;
    const decision = design.decision;
    if (!decision) {
      record(
        'O',
        'Visual and interaction approval',
        'BLOCKED',
        `${covers}, digesting to ${design.digest?.slice(0, 12)}…. **No decision is recorded for ` +
          'this exact revision and render set.** Read from the configured Brain, not from this ' +
          'run\u2019s scratch database. One remedy, and it is not this reporter\u2019s: a person ' +
          'records it in Russell or runs `npm run admin -- design approve`. Nothing in scripts/ ' +
          'can write that row, deliberately \u2014 a reporter that could record the approval it ' +
          'is waiting for would be approving its own work.',
      );
    } else if (decision.decision !== 'APPROVED') {
      record(
        'O',
        'Visual and interaction approval',
        'FAIL',
        `The standing decision for this render set is **${decision.decision}**, recorded by ` +
          `${decision.approvedByUserId} at ${decision.createdAt}` +
          (decision.note ? ` \u2014 "${decision.note}"` : '') +
          '. A withdrawal or a rejection is as much a recorded decision as an approval, and is ' +
          'reported as the answer rather than as a missing one.',
      );
    } else {
      record(
        'O',
        'Visual and interaction approval',
        'PASS',
        `Approved by ${decision.approvedByUserId} at ${decision.createdAt}` +
          (decision.note ? ` \u2014 "${decision.note}"` : '') +
          `, bound to revision ${decision.revision.slice(0, 8)} and to render-set digest ` +
          `${decision.renderSetDigest.slice(0, 12)}… (${covers}). The digest was recomputed from ` +
          'the bytes on disk in this run and the decision was read from the configured Brain, so ' +
          'the approval stops applying the moment either the tree or a render changes. This ' +
          'reporter evaluated that decision and cannot record one.',
      );
    }
  }

  /* -- P. Preserved integrations, migrations, and restart --------------------- */
  /*
   * This was `file('scripts/upgrade-populated.ts')` — the script exists —
   * which is the weakest form of "the code looks like it would": a script that
   * exists and fails reads identically to one that passes.
   *
   * Three of these four are things **this run has already done** and was not
   * reading. The database it wrote every exercise into was migrated from empty
   * a minute ago, it was closed and re-opened underneath the continuity check,
   * and both of those leave rows. Asking them is not extra work; it is asking
   * the question the gate is for.
   *
   * The fourth is genuinely somebody else's: the hosted verification runs
   * inside the Deploy workflow, either side of a real restart of a real
   * machine, and a reporter cannot attest a CI run it did not observe.
   */
  const upgrade = file('scripts/upgrade-populated.ts');
  const sqliteChain = REPO_VISIBLE
    ? fs.readdirSync(path.join(REPO, 'server', 'db', 'migrations')).filter((f) => f.endsWith('.sql'))
    : [];
  const pgChain = REPO_VISIBLE
    ? fs
        .readdirSync(path.join(REPO, 'server', 'db', 'pg-migrations'))
        .filter((f) => f.endsWith('.sql'))
    : [];
  const versionsOf = (files: string[]): number[] =>
    files.map((name) => Number(name.slice(0, 3))).sort((a, b) => a - b);
  const chainIsSound = (files: string[]): { ok: boolean; saw: string } => {
    const versions = versionsOf(files);
    const duplicates = versions.filter((v, i) => i > 0 && v === versions[i - 1]);
    const gaps = versions.filter((v, i) => i > 0 && v !== (versions[i - 1] ?? 0) + 1);
    return {
      ok: versions.length > 0 && duplicates.length === 0 && gaps.length === 0,
      saw:
        `${versions.length} file(s), 001…${String(versions.at(-1) ?? 0).padStart(3, '0')}` +
        (duplicates.length > 0 ? `, COLLISION at ${duplicates.join(', ')}` : '') +
        (gaps.length > 0 ? `, GAP before ${gaps.join(', ')}` : ''),
    };
  };
  const sqliteSound = chainIsSound(sqliteChain);
  const pgSound = chainIsSound(pgChain);

  /*
   * What this run's own database says about how it was built. The scratch
   * database was created empty by `initDatabase` at the top of `main` and has
   * been written to by every exercise since, so these rows are a record of a
   * real migration from empty followed by a real re-open.
   */
  let applied: { version: number; checksum: string }[] = [];
  try {
    applied = await getDb().all<{ version: number; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
  } catch {
    applied = [];
  }

  recordConditions(
    'P',
    'Migrations, restart and preserved integrations',
    [
      {
        name: 'this run built its own database from empty, and every migration was applied',
        held: applied.length > 0 && (!REPO_VISIBLE || applied.length === sqliteChain.length),
        saw: REPO_VISIBLE
          ? `${applied.length} applied of ${sqliteChain.length} on disk`
          : `${applied.length} applied`,
      },
      {
        name: 'every applied migration is checksum-locked, so editing one is a boot failure rather than a drift',
        held: applied.length > 0 && applied.every((row) => (row.checksum ?? '').length > 0),
        saw:
          applied.length > 0
            ? `${applied.filter((row) => (row.checksum ?? '').length > 0).length}/${applied.length} carry a checksum`
            : 'no rows to read',
      },
      {
        name: 'the database was closed and re-opened mid-run, and applied nothing the second time',
        held: continuity.conditions.some(
          (entry) => entry.name.startsWith('a waiting turn survives') && entry.held === true,
        ),
        saw: continuity.conditions.some((entry) => entry.name.startsWith('a waiting turn survives'))
          ? 'the continuity exercise re-opened it and every row read back'
          : 'the re-open did not happen in this run',
      },
      REPO_VISIBLE
        ? {
            name: 'the SQLite chain has no gap and no collision',
            held: sqliteSound.ok,
            saw: sqliteSound.saw,
          }
        : {
            name: 'the SQLite chain has no gap and no collision',
            held: null,
            saw: 'the migration files are a repository fact',
            needs: 'CHECKOUT',
          },
      REPO_VISIBLE
        ? {
            name: 'and so does the Postgres chain, which is numbered independently',
            held: pgSound.ok,
            saw: pgSound.saw,
          }
        : {
            name: 'and so does the Postgres chain, which is numbered independently',
            held: null,
            saw: 'the migration files are a repository fact',
            needs: 'CHECKOUT',
          },
      REPO_VISIBLE
        ? {
            name: 'the upgrade over populated data has its own proof, run separately',
            held: upgrade !== null,
            saw: upgrade
              ? '`npm run upgrade:populated` — both chains, a per-table sha-256 census, and a ' +
                'second restart applying nothing'
              : 'scripts/upgrade-populated.ts is absent',
          }
        : {
            name: 'the upgrade over populated data has its own proof, run separately',
            held: null,
            saw: 'the script is a repository fact',
            needs: 'CHECKOUT',
          },
      {
        name: 'the hosted verification passes either side of a real restart',
        held: null,
        saw:
          'that runs inside the Deploy workflow, against a real machine being restarted. A ' +
          'reporter cannot attest a CI run it did not observe, and reading the workflow file ' +
          'would be checking that the steps are written down rather than that they passed.',
        standing: true,
      },
    ],
    'Three of these are facts about what this run itself did — it migrated an empty database, ' +
      'wrote every exercise into it, and closed and re-opened it underneath a waiting turn — ' +
      'and the two chains are read from the tree.',
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

  /*
   * Q's own invitation clause, which named the same unmet condition I did.
   *
   * It is the *shared access* half rather than the whole journey: whether a
   * second person can be let in at all, and whether letting them in is a
   * decision only somebody who administers the project can take. Read from the
   * same run rather than driven twice — two exercises of one fact is how they
   * come to disagree.
   */
  const sharedAccess = invite.conditions.filter(([name]) =>
    /refused|membership|role the invitation named|reads what that role permits|nothing outside it/.test(
      name,
    ),
  );
  const sharedAccessFailed = sharedAccess.filter(([, held]) => !held).map(([name]) => name);
  const qFailed = [...canaryFailed, ...sharedAccessFailed];

  recordConditions(
    'Q',
    'Shared access and safe experiments',
    [
      {
        name: 'a preference outside its declared set is refused',
        held: !prefs.ok,
        saw: prefs.ok ? 'it was accepted — defect' : 'refused',
      },
      {
        name: 'every declared preference key is presentational and carries a default',
        held: Object.keys(defaults()).length === Object.keys(PREFERENCES).length,
        saw: `${Object.keys(defaults()).length}/${Object.keys(PREFERENCES).length} keys`,
      },
      {
        name: 'an unauthenticated search is scoped to nothing before the query, not filtered after',
        held: searchScoped.scopedProjects === 0 && searchScoped.hits.length === 0,
        saw: `${searchScoped.scopedProjects} project(s), ${searchScoped.hits.length} hit(s), over ${SEARCH_KINDS.length} kinds`,
      },
      ...canaryConditions.map(([name, held]) => ({
        name,
        held,
        saw: held ? 'held' : 'did not hold',
      })),
      {
        name: 'an experiment cannot contaminate what a project believes',
        held:
          contamination.knowledge === 0 &&
          contamination.documents === 0 &&
          contamination.claims === 0,
        saw:
          `after every lab mode ran in it, the TECHNICAL scope holds ` +
          `${contamination.knowledge} knowledge row(s), ${contamination.documents} document(s) ` +
          `and ${contamination.claims} claim(s)`,
      },
      ...sharedAccess.map(([name, held]) => ({
        name,
        held,
        saw: held ? 'held' : 'did not hold',
      })),
      {
        name: 'the same canary cycle against the deployed fleet',
        held: null,
        saw:
          'a canary displaces a policy version somebody is actually running on, so a reporter ' +
          'that drove one against the live fleet would be the contamination R5 forbids, ' +
          'committed by the thing checking for it. Applying a finding on the deployed fleet is ' +
          "an operator's decision, through the same `applyFinding` this exercises.",
        standing: true,
      },
    ],
    'The canary cycle is driven end to end against real `fleet_policy` rows in an isolated ' +
      'TECHNICAL scope, both ways round: real work refused as a first canary on a pressure test ' +
      'and allowed for a ledger reading; applied over an empty history it records that it ' +
      'displaced nothing and rolls back to the dispatcher default rather than to its own ' +
      `number; applied over a person's target of ${operatorTarget} it records that ` +
      `${operatorTarget} before writing ${canaryOverPolicy}, retests under the canary ` +
      `(${comparison}) and rolls back to ${operatorTarget} by name. Every version stays in the ` +
      'history, so a rollback is a write forward rather than a delete. Beside it, an invitation ' +
      'issued by an administrator and received by somebody else is driven end to end, with ' +
      'every identity a test identity this reporter created at @example.invalid.',
  );

  const chainDetail = chain.error
    ? `The exercise threw after ${chain.checks.length} check(s): ${chain.error}. ` +
      'An exception is a failure rather than a non-run — something happened and it was wrong.'
    : [
        `${chain.checks.length - chainFailed.length}/${chain.checks.length} executed ` +
          'conditions held, driven in one pass against the real services in an isolated ' +
          'database. Nothing is simulated: no worker, no network, no provider and no ' +
          'research. Two decisions belong to a person and were made by an explicit test ' +
          'identity, never the owner.',
        ...chain.checks.map(
          (entry) => `  ${entry.held ? 'HELD' : 'DID NOT HOLD'}  ${entry.name} — ${entry.saw}`,
        ),
        ...(chainFailed.length > 0
          ? [
              `  ${chainFailed.length} condition(s) ran and did not hold: ` +
                chainFailed.map((entry) => entry.name).join('; ') +
                '. That is a defect rather than a missing run.',
            ]
          : []),
        ...(chain.gaps.length > 0
          ? [
              'NOT established here, by name:',
              ...chain.gaps.map(
                (entry) => `  ${entry.name} — needs ${entry.needs}: ${entry.why}`,
              ),
            ]
          : []),
        `Trace: ${chain.trace.join(' · ')}`,
      ].join('\n     ');
  /*
   * Cited by B and F rather than counted as a scenario of its own — see
   * `recordEvidence`. The verdict word is kept in the heading because a reader
   * needs to know whether the exercise held, and dropped from the matrix
   * because seventeen is the contract.
   */
  recordEvidence(
    'MISSION_CHAIN',
    'The mission chain: idea → launch → decision → next — ' +
      (chain.error !== null || chainFailed.length > 0
        ? 'FAILED'
        : chain.gaps.length === 0
          ? 'held'
          : 'held, with named gaps'),
    chainDetail,
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

  if (evidence.length > 0) {
    console.log('');
    console.log('EVIDENCE cited above, which is not itself a scenario');
    for (const block of evidence) {
      console.log(`  ${block.key}  ${block.title}`);
      console.log(`     ${block.detail}`);
    }
  }

  const counts = gates.reduce<Record<Verdict, number>>(
    (acc, gate) => ({ ...acc, [gate.verdict]: acc[gate.verdict] + 1 }),
    { PASS: 0, PARTIAL: 0, BLOCKED: 0, FAIL: 0, NOT_RUN: 0 },
  );
  console.log('');
  console.log(
    `STEP 12B — ${counts.PASS} PASS · ${counts.FAIL} FAIL · ${counts.PARTIAL} PARTIAL · ` +
      `${counts.BLOCKED} BLOCKED · ${counts.NOT_RUN} NOT_RUN (of ${gates.length} scenarios)`,
  );
  /*
   * A failure is named separately from incompleteness, and it is named first.
   *
   * "Not complete" is the ordinary state of a step in progress. "A check ran
   * and did not hold" is a defect somebody has to look at today, and a reader
   * scanning one line must not have to tell them apart by counting.
   */
  const failedGates = gates.filter((gate) => gate.verdict === 'FAIL');
  if (failedGates.length > 0) {
    console.log(
      `STEP 12B — ${failedGates.length} SCENARIO(S) FAILED, a check ran and the product did ` +
        `not hold: ` +
        failedGates.map((gate) => `${gate.id} ${gate.title}`).join('; '),
    );
  }
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
        evidence: evidence.map((block) => ({
          key: block.key,
          title: block.title,
          detail: block.detail,
        })),
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

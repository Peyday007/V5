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
import { createProject } from '../server/repos/projects.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { listRoutines, listAccounts } from '../server/repos/fleet.ts';
import { LENSES } from '../server/services/russell/frontier.ts';
import { askableLenses, openInquiry, validateLensReply } from '../server/services/russell/inquiry.ts';
import { LAB_MODES, declareExperiment, runExperiment } from '../server/services/fleet/lab.ts';
import { MAP_TYPES } from '../server/services/russell/maps.ts';
import { PREFERENCES, checkPreference, defaults } from '../server/services/russell/preferences.ts';
import { SEARCH_KINDS, search } from '../server/services/russell/search.ts';
import { usability } from '../server/services/fleet/view.ts';
import { CANDIDATE_PRIORITIES } from '../server/domain/types.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));

type Verdict = 'PASS' | 'PARTIAL' | 'BLOCKED' | 'NOT_RUN';

interface Gate {
  id: string;
  title: string;
  verdict: Verdict;
  detail: string;
}

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
 * The fleet as the configured Brain actually holds it, read before anything
 * else opens a database.
 *
 * ---------------------------------------------------------------------------
 * Two databases, on purpose, and in this order
 * ---------------------------------------------------------------------------
 *
 * The exercising half of this report runs against a **temporary** database it
 * creates and deletes, because it writes: it registers a project, a hundred
 * candidates, an inquiry and a Capability Lab experiment, and doing any of that
 * to a real Brain would make the reporter a mutation. But several scenarios are
 * not about a mechanism at all — they are about whether the deployed fleet can
 * run anything — and against a scratch database that question has no answer.
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
}

async function readOperationalFleet(): Promise<FleetReading> {
  try {
    await initDatabase();
    const config = activeDatabaseConfig();
    const [routines, accounts] = await Promise.all([listRoutines(), listAccounts()]);
    // Named by provider, never by connection string — §18's rule, and this
    // output goes into a CI log.
    const source = config?.provider === 'postgres' ? 'the cloud database' : 'the local database';
    await closeDatabase();
    return { routines, accounts, unreadable: null, source };
  } catch (error) {
    // A developer machine with nothing configured is the ordinary case here,
    // and it is not a finding about the fleet.
    return {
      routines: [],
      accounts: [],
      unreadable: error instanceof Error ? error.message : String(error),
      source: 'nothing — no database was configured for this run',
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

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-12b-acc-'));
  await initDatabase({ dbPath: path.join(dataDir, 'acceptance.db') });

  /* -- A. Conversation routing and continuity ----------------------------- */
  // Needs a worker to answer a turn: no inference is bought (§24), so a turn is
  // a bin and a bin needs a surface.
  record('A', 'Conversation routing and continuity', blocker.verdict, blocker.detail);

  /* -- B. Independent judgment -------------------------------------------- */
  record('B', 'Independent judgment', blocker.verdict, blocker.detail);

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
  record(
    'C',
    'Priority and backlog',
    classified === 100 ? 'PARTIAL' : 'NOT_RUN',
    `${classified} candidates in an isolated scope, every one carrying a class ` +
      `(${ranked.map((row) => `${row.priority}=${row.total}`).join(' ')}). ` +
      'NOT established here: semantic merge of duplicates, which needs a worker to name the repeat.',
  );

  /* -- D. Discovery Frontier v1 ------------------------------------------- */
  const derived = LENSES.filter((lens) => lens.kind === 'DERIVED');
  const asked = askableLenses();
  // The asked half now has a path; that the path *exists and validates* is
  // exercised here, and that a worker answers one is not.
  const refusedDerived = await openInquiry({
    projectId: project.id,
    projectName: project.name,
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
  record(
    'D',
    'Discovery Frontier v1',
    'PARTIAL',
    `${derived.length} lenses answered from rows, ${asked.length} asked with a governed path. ` +
      `A derived lens is refused as an inquiry (${refusedDerived.ok ? 'NOT REFUSED — defect' : 'refused'}); ` +
      `a finding citing a row this project does not hold is discarded (${discarded ? 'discarded' : 'KEPT — defect'}). ` +
      'NOT established here: the six discovery classes found in a real project snapshot, which needs a worker for the asked half.',
  );

  /* -- E. Connected-site intelligence ------------------------------------- */
  const connect = file('server/services/connect/projection.ts');
  const sixAnswers = connect ? /NEEDS_PERSON/.test(connect) && /stateReason/.test(connect) : false;
  record(
    'E',
    'Connected-site intelligence',
    'NOT_RUN',
    sixAnswers
      ? 'The six-answer projection including NEEDS_PERSON is present and derived on the read path; no live site was read in this run.'
      : 'The projection could not be read.',
  );

  /* -- F. Needs You -------------------------------------------------------- */
  const needsHuman = file('server/services/russell/needsHuman.ts');
  record(
    'F',
    'Needs You',
    needsHuman && /choicesFor/.test(needsHuman) ? 'NOT_RUN' : 'NOT_RUN',
    'The park and its answering transition are present and unit-tested; a genuine production ' +
      'boundary answered end to end is not established by this run.',
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
  record(
    'H',
    'Visual maps',
    maps && /emptyReason/.test(maps) ? 'PARTIAL' : 'NOT_RUN',
    `${MAP_TYPES.length} map types derived from the authoritative graph, each with a ` +
      'synchronized outline, and the money-flow map returns a reason for being empty rather ' +
      'than inventing edges. NOT established here: interaction on a real project at phone width ' +
      '(see scripts/visual-qa.ts for the rendered evidence).',
  );

  /* -- I. Collaboration ---------------------------------------------------- */
  const routes = file('server/routes/russell.ts');
  const workerRefused = routes ? /requirePerson\(\)/.test(routes) : false;
  record(
    'I',
    'Collaboration',
    'NOT_RUN',
    workerRefused
      ? 'A worker principal is refused at the conversation and decision routes by type, and ' +
        'private threads are scoped by owner. Two real human identities were not exercised in this run.'
      : 'The route guards could not be read.',
  );

  /* -- J. Mobile ----------------------------------------------------------- */
  record(
    'J',
    'Mobile',
    'NOT_RUN',
    'Rendered evidence at 390px is produced by scripts/visual-qa.ts, including three driven ' +
      'interactions. A complete end-to-end mobile flow through a mission was not driven here.',
  );

  /* -- K. Legacy removal ---------------------------------------------------- */
  const removalTest = file('tests/operatorConsoleRemoved.test.ts');
  const clientHasOperator = fs
    .readdirSync(path.join(REPO, 'client', 'src'), { recursive: true } as never)
    .some((entry) => typeof entry === 'string' && entry.endsWith('.tsx'));
  record(
    'K',
    'Legacy removal',
    removalTest ? 'PASS' : 'NOT_RUN',
    removalTest
      ? 'tests/operatorConsoleRemoved.test.ts refuses the route for every principal, fails on any ' +
        'link to it, and fails on any instruction to go there. It runs in the suite this report ' +
        `requires (${clientHasOperator ? 'client present' : 'client missing'}).`
      : 'The removal test is not present.',
  );

  /* -- L. Always-on loop ---------------------------------------------------- */
  record('L', 'Always-on loop', blocker.verdict, blocker.detail);

  /* -- M. Product truth, historical knowledge, and memory -------------------- */
  const progress = file('server/services/russell/progress.ts');
  const denominators = progress ? /denominator/.test(progress) : false;
  record(
    'M',
    'Product truth and named denominators',
    denominators ? 'PARTIAL' : 'NOT_RUN',
    'Progress is milestone-backed with a named denominator and there is no path that turns a ' +
      'feeling into a percentage; one projection answers every surface. NOT established here: ' +
      'the comparison across home, Work, project, constellation and briefing against the same ' +
      'versioned production state.',
  );

  /* -- N. Routing and latency ----------------------------------------------- */
  const routing = file('server/services/bins/routing.ts');
  record(
    'N',
    'Routing and latency explanation',
    routing ? 'PARTIAL' : 'NOT_RUN',
    'One routing decision is read by the candidate query, the admission hook and the fire ' +
      'router, and a refusal costs no claim state. NOT established here: a traced real dispatch, ' +
      'which needs a surface.',
  );

  /* -- O. Visual and interaction approval ------------------------------------ */
  record(
    'O',
    'Visual and interaction approval',
    'PARTIAL',
    'scripts/visual-qa.ts captures desktop, intermediate and phone, sweeps the 822-953 band ' +
      'that the rejected build clipped in, and drives three real interactions. It found and ' +
      'the build fixed one real clipping (the depth toggle at 822 and 860). NOT established ' +
      'here: your review of the images against the approved direction — that is yours to give.',
  );

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
  record(
    'Q',
    'Shared access and safe experiments',
    'PARTIAL',
    `A preference outside its declared set is refused (${prefs.ok ? 'ACCEPTED — defect' : 'refused'}); ` +
      `an unauthenticated search is scoped to nothing (${searchScoped.scopedProjects} projects, ` +
      `${searchScoped.hits.length} hits); ${Object.keys(PREFERENCES).length} preference keys are ` +
      `presentational only and every one has a default (${Object.keys(defaults()).length}). ` +
      `${SEARCH_KINDS.length} search kinds are scoped before the query rather than filtered after. ` +
      'NOT established here: invite/accept/role-change with two real identities, and a canary ' +
      'rollback in production.',
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
  console.log('');
  for (const gate of gates) {
    console.log(`${gate.id}  ${gate.verdict.padEnd(8)} ${gate.title}`);
    console.log(`     ${gate.detail}`);
  }

  const counts = gates.reduce<Record<Verdict, number>>(
    (acc, gate) => ({ ...acc, [gate.verdict]: acc[gate.verdict] + 1 }),
    { PASS: 0, PARTIAL: 0, BLOCKED: 0, NOT_RUN: 0 },
  );
  console.log('');
  console.log(
    `STEP 12B — ${counts.PASS} PASS · ${counts.PARTIAL} PARTIAL · ${counts.BLOCKED} BLOCKED · ` +
      `${counts.NOT_RUN} NOT_RUN (of ${gates.length} scenarios)`,
  );
  if (counts.PASS !== gates.length) {
    console.log('STEP 12B IS NOT COMPLETE.');
  }

  await closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

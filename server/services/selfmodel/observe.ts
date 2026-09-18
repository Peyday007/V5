/**
 * What Brain can honestly read about itself, from where it is standing.
 *
 * ---------------------------------------------------------------------------
 * The rule this module is written against
 * ---------------------------------------------------------------------------
 *
 * **Do not infer deployment or live behaviour from code existence.** Every
 * observer below answers exactly the levels its own source of truth can answer
 * and `unknown(...)` for the rest, with the reason. The temptation is to let a
 * module that exists imply that it runs; that inference is how §27's "a
 * mechanism nothing calls is not a mechanism" happens five times.
 *
 * ---------------------------------------------------------------------------
 * Four sources of truth, and what each one can and cannot say
 * ---------------------------------------------------------------------------
 *
 * **The filesystem** says what is on disk. The deployment image copies `server`
 * and `client` and nothing else, so it answers IN_SOURCE and cannot answer
 * EVALUATED — `tests/` is not there. A deployed Brain therefore reads
 * evaluation as `UNKNOWN`, which is the whole reason there are three answers.
 *
 * **The process** says what is wired. A registry entry, a mounted evaluator, a
 * tool in the tool list: something reachable from running code. This is the
 * only level that can distinguish a module from a mechanism.
 *
 * **The schema** says what this database actually has. `schema_migrations` is
 * what *applied here*, which is a different fact from a file existing — a
 * rolled-back instance has the file and not the row.
 *
 * **The rows** say what has run. OBSERVED_ACTIVE is any evidence at all;
 * PRODUCTION_PROVEN additionally requires a terminal result in a scope that is
 * somebody's work rather than the machinery proving itself, which is exactly
 * what `projects.purpose` was added for.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../../db/database.ts';
import { loadMigrationFiles, migrationsDirFor } from '../../db/migrate.ts';
import { listWorkTypes } from '../queue/workTypes.ts';
import { COMPLETION_CONTRACTS } from '../../domain/types.ts';
import { TOOLS } from '../../mcp/tools.ts';
import { listAccounts, listRoutines } from '../../repos/fleet.ts';
import { BRAIN_REVISION } from '../../env.ts';
import {
  no,
  unknown,
  yes,
  type ComponentObservation,
  type Reading,
} from './levels.ts';

const SERVER_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');
const TESTS_ROOT = path.join(REPO_ROOT, 'tests');
const DOCS_ROOT = path.join(REPO_ROOT, 'docs');

export interface ObservationPass {
  components: ComponentObservation[];
  /** What this pass could not read, and why. Never silently omitted. */
  unreadable: string[];
}

/**
 * Whether the repository's own tests are visible from here.
 *
 * Computed once per pass rather than asked per component, because the answer is
 * a property of where the process is standing and not of any one component —
 * and because a hundred components each re-stating "tests/ is not in the image"
 * is a hundred identical sentences a reader stops reading.
 */
function testsVisible(): boolean {
  try {
    return fs.existsSync(TESTS_ROOT) && fs.statSync(TESTS_ROOT).isDirectory();
  } catch {
    return false;
  }
}

const NO_TESTS_HERE =
  'The deployment image copies `server` and `client` only, so `tests/` is not readable from ' +
  'this process. Evaluation coverage is a repository fact and cannot be answered here — ' +
  'reporting it as NO would turn "we cannot see" into "it is untested".';

/**
 * The same sentence about documents, and it is the one I got wrong first.
 *
 * `documentedReading` answered `NO` — "no document in this image names it" —
 * which is a true sentence and the wrong answer. The image copies `server` and
 * `client`, so neither `docs/` nor `CLAUDE.md` is there, and every one of the
 * five hundred components in a deployed Brain would have read undocumented when
 * the truth is that nothing could be read. That is precisely the collapse the
 * third answer exists to prevent, built into the column that was supposed to
 * prevent it, and only checking the Dockerfile found it.
 *
 * So the two are symmetrical: with nothing to read, the answer is `UNKNOWN`
 * with the reason. With documents present, `NO` is a genuine reading.
 */
const NO_DOCS_HERE =
  'The deployment image copies `server` and `client` only, so neither `docs/` nor `CLAUDE.md` ' +
  'is readable from this process. Whether a component is documented is a repository fact and ' +
  'cannot be answered here — reporting it as NO would turn "we cannot see" into "nothing ' +
  'documents it".';

/** Every `.ts` file under a directory, relative to the repository root. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The text of every suite and every document, read once per pass.
 *
 * Built eagerly rather than asked per component, and that is a correctness
 * decision as much as a speed one. Asked per component it is
 * O(components x files): six hundred components against a hundred and fifty
 * suites is ninety thousand file reads for one scan, which made a scan take two
 * minutes in a suite and would make a production scan something nobody runs.
 * A scan nobody runs is a self-model that is always stale, which is the
 * *mechanism nothing calls* defect arriving through the back door of cost.
 *
 * Held for the duration of one pass and discarded, so a scan never answers from
 * a file it read an hour ago.
 */
interface TextIndex {
  suites: Array<{ name: string; text: string }>;
  docs: Array<{ name: string; text: string }>;
}

function readTextIndex(): TextIndex {
  const suites: TextIndex['suites'] = [];
  if (testsVisible()) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(TESTS_ROOT).filter((name) => name.endsWith('.test.ts'));
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      try {
        suites.push({ name: entry, text: fs.readFileSync(path.join(TESTS_ROOT, entry), 'utf8') });
      } catch {
        /* a suite we cannot read contributes nothing rather than failing the pass */
      }
    }
  }

  const docs: TextIndex['docs'] = [];
  const candidates = [path.join(REPO_ROOT, 'CLAUDE.md')];
  try {
    for (const entry of fs.readdirSync(DOCS_ROOT)) {
      if (entry.endsWith('.md')) candidates.push(path.join(DOCS_ROOT, entry));
    }
  } catch {
    /* no docs directory here; the CLAUDE.md candidate still stands */
  }
  for (const file of candidates) {
    try {
      docs.push({
        name: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
        text: fs.readFileSync(file, 'utf8'),
      });
    } catch {
      /* likewise */
    }
  }
  return { suites, docs };
}

function mentioning(
  entries: Array<{ name: string; text: string }>,
  needles: string[],
): string[] {
  const hits: string[] = [];
  for (const entry of entries) {
    if (needles.some((needle) => entry.text.includes(needle))) hits.push(entry.name);
  }
  return hits.sort();
}

function documentedReading(index: TextIndex, needles: string[]): Reading {
  // Nothing to read is `UNKNOWN`, never `NO`. See NO_DOCS_HERE.
  if (index.docs.length === 0) return unknown(NO_DOCS_HERE);
  const hits = mentioning(index.docs, needles);
  return hits.length > 0
    ? yes(`named in ${hits.slice(0, 3).join(', ')}`)
    : no('no document readable from here names it');
}

function evaluatedReading(index: TextIndex, needles: string[]): Reading {
  if (!testsVisible()) return unknown(NO_TESTS_HERE);
  const hits = mentioning(index.suites, needles);
  return hits.length > 0
    ? yes(`covered by ${hits.slice(0, 3).join(', ')}`)
    : no('no suite in `tests/` mentions it');
}

/* ------------------------------------------------------------------------- */
/* Migrations                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * A migration file exists; a migration *applied* is a different fact.
 *
 * The distinction is the reason this observer exists at all. A file in the
 * image and a row in `schema_migrations` disagree exactly when an instance is
 * behind its own code — which is the condition a deployment is most likely to
 * be in and the one nothing else here would notice.
 */
async function observeMigrations(index: TextIndex): Promise<ComponentObservation[]> {
  const db = getDb();
  const dir = migrationsDirFor(db.dialect);
  const files = loadMigrationFiles(dir);
  const applied = await db.all<{ version: number; name: string }>(
    `SELECT version, name FROM schema_migrations`,
  );
  const appliedVersions = new Map(applied.map((row) => [Number(row.version), String(row.name)]));

  return files.map((file) => {
    const isApplied = appliedVersions.has(file.version);
    return {
      kind: 'MIGRATION' as const,
      name: `${String(file.version).padStart(3, '0')}_${file.name}`,
      detail: `${db.dialect} chain`,
      readings: {
        DOCUMENTED: documentedReading(index, [file.name]),
        IN_SOURCE: yes(`${path.relative(REPO_ROOT, dir).split(path.sep).join('/')}/`),
        // A migration is not a mechanism the process calls; the runner applies
        // the chain. `CONNECTED` would be the same fact as `DEPLOYED` here, and
        // two columns saying one thing is how they come to disagree.
        CONNECTED: unknown(
          'A migration is applied by the runner rather than called by the process, so ' +
            '"connected" is not a distinct fact about it. `DEPLOYED` is the reading that matters.',
        ),
        DEPLOYED: isApplied
          ? yes(`schema_migrations holds version ${file.version}`)
          : no(
              `the file is in this image and schema_migrations does not hold version ` +
                `${file.version}: this database is behind its own code`,
            ),
        OBSERVED_ACTIVE: isApplied
          ? yes('it applied, which is the only running a migration does')
          : no('it has not applied here'),
        EVALUATED: evaluatedReading(index, [file.name]),
        PRODUCTION_PROVEN: unknown(
          'A migration is proven by the tables it created being used, which is a reading about ' +
            'those tables rather than about the file.',
        ),
      },
    };
  });
}

/* ------------------------------------------------------------------------- */
/* Work types                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * A registered work type, and whether anything has ever been queued as one.
 *
 * `PRODUCTION_PROVEN` asks for a *succeeded* item in a project whose purpose is
 * `PROJECT` rather than `TECHNICAL`. The machinery proving itself is real work
 * and is not evidence that the type does its job for somebody — which is the
 * exact distinction migration 028 was added to make.
 */
async function observeWorkTypes(index: TextIndex): Promise<ComponentObservation[]> {
  const db = getDb();
  const counts = await db.all<{ work_type: string; total: number; succeeded: number; real: number }>(
    `SELECT w.work_type AS work_type,
            COUNT(*) AS total,
            SUM(CASE WHEN w.state = 'SUCCEEDED' THEN 1 ELSE 0 END) AS succeeded,
            SUM(CASE WHEN w.state = 'SUCCEEDED' AND p.purpose = 'PROJECT' THEN 1 ELSE 0 END) AS real
       FROM work_items w
       JOIN projects p ON p.id = w.project_id
      GROUP BY w.work_type`,
  );
  const byType = new Map(counts.map((row) => [String(row.work_type), row]));

  return listWorkTypes().map((definition) => {
    const seen = byType.get(definition.type);
    const total = Number(seen?.total ?? 0);
    const real = Number(seen?.real ?? 0);
    return {
      kind: 'WORK_TYPE' as const,
      name: definition.type,
      detail: `${definition.repeatSafety}${definition.operationNamespace ? ` via ${definition.operationNamespace}` : ''}`,
      readings: {
        DOCUMENTED: documentedReading(index, [definition.type]),
        IN_SOURCE: yes('server/services/queue/workTypes.ts'),
        CONNECTED: yes('present in the running registry, so `workType()` resolves it'),
        DEPLOYED: yes('the registry is part of this process'),
        OBSERVED_ACTIVE:
          total > 0
            ? yes(`${total} work item(s) of this type exist`)
            : no('no work item of this type has ever been queued here'),
        EVALUATED: evaluatedReading(index, [definition.type]),
        PRODUCTION_PROVEN:
          real > 0
            ? yes(`${real} succeeded in a project whose purpose is PROJECT`)
            : no(
                'nothing of this type has succeeded outside a TECHNICAL scope, so the machinery ' +
                  'proving itself is all there is',
              ),
      },
    };
  });
}

/* ------------------------------------------------------------------------- */
/* Bin contracts                                                              */
/* ------------------------------------------------------------------------- */

/**
 * A declared completion contract, and whether a bin ever finished under it.
 *
 * `CONNECTED` is the interesting one: the contract is a string in a closed set,
 * and having an evaluator registered is what makes it a mechanism. A contract
 * with no evaluator refuses every bin (`evaluateContract` says so explicitly),
 * which is exactly the "declared and unreachable" state this level exists to
 * catch.
 */
async function observeBinContracts(index: TextIndex): Promise<ComponentObservation[]> {
  const db = getDb();
  const counts = await db.all<{ completion_contract: string; total: number; complete: number }>(
    `SELECT completion_contract, COUNT(*) AS total,
            SUM(CASE WHEN state = 'COMPLETE' THEN 1 ELSE 0 END) AS complete
       FROM bins GROUP BY completion_contract`,
  );
  const byContract = new Map(counts.map((row) => [String(row.completion_contract), row]));

  const { hasEvaluator } = await import('../bins/contracts.ts');

  return COMPLETION_CONTRACTS.map((contract) => {
    const seen = byContract.get(contract);
    const total = Number(seen?.total ?? 0);
    const complete = Number(seen?.complete ?? 0);
    const wired = hasEvaluator(contract);
    return {
      kind: 'BIN_CONTRACT' as const,
      name: contract,
      detail: null,
      readings: {
        DOCUMENTED: documentedReading(index, [contract]),
        IN_SOURCE: yes('server/domain/types.ts declares it'),
        CONNECTED: wired
          ? yes('an evaluator is registered, so a bin under it can be judged')
          : no(
              'no evaluator is registered, so every bin under this contract is refused rather ' +
                'than judged — it is declared and unreachable',
            ),
        DEPLOYED: yes('the registry is part of this process'),
        OBSERVED_ACTIVE: total > 0 ? yes(`${total} bin(s) exist under it`) : no('no bin uses it'),
        EVALUATED: evaluatedReading(index, [contract]),
        PRODUCTION_PROVEN:
          complete > 0
            ? yes(`${complete} bin(s) reached COMPLETE under it`)
            : no('no bin has ever completed under it'),
      },
    };
  });
}

/* ------------------------------------------------------------------------- */
/* MCP tools                                                                  */
/* ------------------------------------------------------------------------- */

function observeMcpTools(index: TextIndex): ComponentObservation[] {
  return TOOLS.map((tool) => ({
    kind: 'MCP_TOOL' as const,
    name: tool.name,
    detail: tool.annotations.readOnlyHint ? 'read-only' : 'mutating',
    readings: {
      DOCUMENTED: documentedReading(index, [tool.name]),
      IN_SOURCE: yes('server/mcp/'),
      CONNECTED: yes('present in the running tool registry, so `tools/list` returns it'),
      DEPLOYED: yes('the registry is part of this process'),
      // Whether a tool has ever been *called* is not a row this Brain keeps —
      // there is no per-tool call ledger — so it is unknown rather than no.
      OBSERVED_ACTIVE: unknown(
        'Brain keeps no per-tool call ledger, so how often a tool has been called is not a fact ' +
          'available here. What a tool did is recorded by the service it wraps, under that ' +
          "service's own rows.",
      ),
      EVALUATED: evaluatedReading(index, [tool.name]),
      PRODUCTION_PROVEN: unknown('the same absent ledger as OBSERVED_ACTIVE'),
    },
  }));
}

/* ------------------------------------------------------------------------- */
/* Source modules                                                             */
/* ------------------------------------------------------------------------- */

/**
 * The service and repository modules that exist on disk.
 *
 * `CONNECTED` is deliberately `UNKNOWN` for every one of them, and that is the
 * most honest line in this file. Whether anything imports a module is a static
 * fact this process cannot establish about itself: the module graph is only
 * partially loaded at any moment, and a module that nothing imports looks
 * identical from in here to one that four things import lazily. §24's
 * `reconcileAcceptedFragment` and §27's `reconcileRepairs` were both exactly
 * this — a function with one caller that should have had two — and neither
 * would have been visible to a runtime check.
 */
function observeModules(index: TextIndex): ComponentObservation[] {
  const groups: Array<{ kind: 'SERVICE_MODULE' | 'REPOSITORY_MODULE'; dir: string }> = [
    { kind: 'SERVICE_MODULE', dir: path.join(SERVER_ROOT, 'services') },
    { kind: 'REPOSITORY_MODULE', dir: path.join(SERVER_ROOT, 'repos') },
  ];
  const out: ComponentObservation[] = [];
  for (const group of groups) {
    for (const file of sourceFiles(group.dir)) {
      out.push({
        kind: group.kind,
        name: file,
        detail: null,
        readings: {
          DOCUMENTED: documentedReading(index, [file, path.basename(file)]),
          IN_SOURCE: yes('present on disk in this image'),
          CONNECTED: unknown(
            'Whether anything imports this module is a static fact about the repository that a ' +
              'running process cannot establish about itself — a module nothing imports looks ' +
              'identical from in here to one imported lazily.',
          ),
          DEPLOYED: yes('the file is in this image'),
          OBSERVED_ACTIVE: unknown('no per-module execution ledger exists'),
          EVALUATED: evaluatedReading(index, [file]),
          PRODUCTION_PROVEN: unknown('no per-module execution ledger exists'),
        },
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* The fleet                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Accounts and Routines, with §23's distinction kept.
 *
 * An account holds a subscription allowance; a Routine is a fire surface, and
 * the two are counted separately because a second Routine under one account
 * changes how fast Brain can *start* sessions and nothing about how much that
 * account may *do*. `PRODUCTION_PROVEN` for a Routine is `proveSurface`'s
 * question in one line: did Brain fire it and did a session arrive and finish
 * something. A registered Routine with a secret is `CONFIGURED`, which is a
 * different word on purpose.
 */
async function observeFleet(index: TextIndex): Promise<ComponentObservation[]> {
  const db = getDb();
  const out: ComponentObservation[] = [];

  for (const account of await listAccounts()) {
    const fired = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'DISPATCH_SENT' AND account_id = ?`,
      [account.id] as never[],
    );
    const n = Number(fired?.n ?? 0);
    out.push({
      kind: 'FLEET_ACCOUNT',
      name: account.name,
      detail: `${account.kind}${account.declaredPlanPower ? ` (${account.declaredPlanPower})` : ''}`,
      readings: {
        DOCUMENTED: documentedReading(index, [account.name]),
        IN_SOURCE: unknown('an account is a row an operator wrote, not a module'),
        CONNECTED: yes('registered in fleet_accounts'),
        DEPLOYED: yes('the row is in this database'),
        OBSERVED_ACTIVE:
          n > 0 ? yes(`${n} dispatch(es) attributed to it`) : no('no dispatch is attributed to it'),
        EVALUATED: unknown('an account is not something a suite can cover'),
        PRODUCTION_PROVEN:
          n > 0
            ? yes(`${n} fire(s) recorded against it`)
            : no('nothing has been fired through it, so its capacity is configured rather than proven'),
      },
    });
  }

  for (const routine of await listRoutines()) {
    /*
     * §23's four-row chain, as one query: Brain fired this Routine, a session
     * arrived and was attributed to the worker the Routine is bound to *from
     * that same dispatch row*, it was handed a bin, and the bin reached
     * COMPLETE. Arrivals with no completion prove a connector and not a
     * surface, which is why the join is on the bin's state rather than on the
     * arrival alone.
     *
     * A Routine with no bound worker cannot have a chain, and that is a fact
     * about the registration rather than about the surface, so it is said in
     * those words.
     */
    let proven: Reading;
    if (routine.workerId === null) {
      proven = no(
        'this Routine is bound to no worker, so no arrival can be attributed to it. Registered ' +
          'is CONFIGURED, which is a different word on purpose.',
      );
    } else {
      const chain = await db.get<{ n: number }>(
        `SELECT COUNT(*) AS n
           FROM worker_sessions s
           JOIN bins b ON b.id = s.bin_id
          WHERE s.routine_id = ? AND s.worker_id = ? AND b.state = 'COMPLETE'`,
        [routine.id, routine.workerId] as never[],
      );
      const completed = Number(chain?.n ?? 0);
      proven =
        completed > 0
          ? yes(
              `${completed} session(s) Brain fired on this Routine arrived as its bound worker ` +
                'and finished a bin',
            )
          : no(
              'no session Brain fired on this Routine has arrived as its bound worker and ' +
                'finished a bin. Registered with a credential is CONFIGURED, not proven.',
            );
    }
    out.push({
      kind: 'FLEET_ROUTINE',
      name: routine.name,
      detail: routine.state,
      readings: {
        DOCUMENTED: documentedReading(index, [routine.name]),
        IN_SOURCE: unknown('a Routine is a row an operator wrote, not a module'),
        CONNECTED: routine.state === 'ENABLED'
          ? yes('ENABLED, so the router may select it')
          : no(`${routine.state}: left out of routing${routine.stateReason ? ` — ${routine.stateReason}` : ''}`),
        DEPLOYED: yes('the row is in this database'),
        OBSERVED_ACTIVE: unknown('see PRODUCTION_PROVEN, which asks the stronger question'),
        EVALUATED: unknown('a Routine is not something a suite can cover'),
        PRODUCTION_PROVEN: proven,
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Evaluation suites                                                          */
/* ------------------------------------------------------------------------- */

function observeSuites(index: TextIndex): ComponentObservation[] {
  if (!testsVisible()) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(TESTS_ROOT).filter((name) => name.endsWith('.test.ts')).sort();
  } catch {
    return [];
  }
  return entries.map((entry) => ({
    kind: 'EVALUATION_SUITE' as const,
    name: `tests/${entry}`,
    detail: null,
    readings: {
      DOCUMENTED: documentedReading(index, [`tests/${entry}`, entry]),
      IN_SOURCE: yes('present in the repository checkout'),
      CONNECTED: yes('vitest collects every tests/*.test.ts'),
      DEPLOYED: no('`tests/` is deliberately not copied into the deployment image'),
      // Whether it *passed* is not a row Brain holds. Reading a suite's name off
      // disk says it exists; it says nothing about whether it is green, and
      // claiming otherwise is the "activity is not progress" error at a new
      // altitude.
      OBSERVED_ACTIVE: unknown(
        'Brain holds no record of test runs. Whether this suite passes is the CI system\'s ' +
          'answer and is not in any row here.',
      ),
      EVALUATED: unknown('a suite is the evaluation; asking whether it is evaluated is circular'),
      PRODUCTION_PROVEN: no('a suite does not run in production'),
    },
  }));
}

/* ------------------------------------------------------------------------- */
/* Storage                                                                    */
/* ------------------------------------------------------------------------- */

async function observeStorage(index: TextIndex): Promise<ComponentObservation[]> {
  const { currentStorageProvider } = await import('../storage.ts');
  const provider = currentStorageProvider();
  const db = getDb();
  const stored = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM documents WHERE storage_key IS NOT NULL`,
  );
  const n = Number(stored?.n ?? 0);
  return [
    {
      kind: 'STORAGE_PROVIDER',
      name: provider,
      detail: `${db.kind} database`,
      readings: {
        DOCUMENTED: documentedReading(index, ['storage/supabase.ts', 'storage/local.ts']),
        IN_SOURCE: yes('server/services/storage/'),
        CONNECTED: yes('chosen by config and proved at boot by a real listing'),
        DEPLOYED: yes('this process is serving through it'),
        OBSERVED_ACTIVE: n > 0 ? yes(`${n} document(s) carry a storage key`) : no('nothing stored'),
        EVALUATED: evaluatedReading(index, ['storage']),
        PRODUCTION_PROVEN:
          n > 0
            ? yes(`${n} stored object(s)`)
            : no('no document has ever been stored through it here'),
      },
    },
  ];
}

/* ------------------------------------------------------------------------- */

/**
 * One full pass. Every observer runs; a failing one is reported, not fatal.
 *
 * A self-model that refused to produce a reading because one of its sources was
 * unavailable would be least useful exactly when something is wrong — which is
 * when somebody is asking it. So each observer is caught individually and what
 * it could not read is named.
 */
export async function observeSystem(): Promise<ObservationPass> {
  const components: ComponentObservation[] = [];
  const unreadable: string[] = [];

  const index = readTextIndex();
  const observers: Array<
    [string, (index: TextIndex) => Promise<ComponentObservation[]> | ComponentObservation[]]
  > = [
    ['migrations', observeMigrations],
    ['work types', observeWorkTypes],
    ['bin contracts', observeBinContracts],
    ['MCP tools', observeMcpTools],
    ['modules', observeModules],
    ['the fleet', observeFleet],
    ['evaluation suites', observeSuites],
    ['storage', observeStorage],
  ];

  for (const [label, observer] of observers) {
    try {
      components.push(...(await observer(index)));
    } catch (error) {
      unreadable.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}. Nothing about ` +
          'this group is reported rather than being reported as absent.',
      );
    }
  }

  if (!testsVisible()) unreadable.push(NO_TESTS_HERE);
  if (index.docs.length === 0) unreadable.push(NO_DOCS_HERE);
  if (BRAIN_REVISION === null) {
    unreadable.push(
      'This process carries no BRAIN_REVISION, so the reading cannot be attributed to a commit. ' +
        'A local checkout, a plain `docker run` and a test all legitimately have none.',
    );
  }

  return { components, unreadable };
}

export { DOCS_ROOT, NO_DOCS_HERE, NO_TESTS_HERE, REPO_ROOT, TESTS_ROOT, testsVisible };

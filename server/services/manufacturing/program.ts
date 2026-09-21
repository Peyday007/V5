/**
 * Starting a manufacturing programme, what that authorizes, and the two ways
 * out of it.
 *
 * ---------------------------------------------------------------------------
 * Why this is not a Cash Mode sprint
 * ---------------------------------------------------------------------------
 *
 * §30 says Cash Mode is a temporary section meant to be wound down after a
 * month or two, and invariant 40 says a temporary section's off switch must
 * never stop work it does not own. This kernel's horizon is the opposite of a
 * sprint: it is the question a sprint runs underneath, and the brief is
 * explicit that its levels are decades apart. Hanging it off `cash_modes` would
 * mean winding one sprint down silently ended a programme nobody had decided to
 * end — which is precisely the defect that invariant names, and it would have
 * looked like it had worked.
 *
 * So `manufacturing_programs` is its own row with its own lifecycle, and the
 * two sections are independent: a project may run either, both or neither.
 *
 * ---------------------------------------------------------------------------
 * Pressing Start *is* the authorization
 * ---------------------------------------------------------------------------
 *
 * §33 records the alternative in production: a section was activated, ten
 * questions were captured, and every one of them parked because nothing existed
 * for a launch to run under — a sentence recorded in a JSON column no surface
 * read. The remedy was not another form. A person deciding to run a programme
 * has decided Brain may read published sources about it, and asking them to
 * then fill in a research grant is asking twice for one decision.
 *
 * What it does not authorize is structural rather than promised. `ensureGoal`
 * unions `ALWAYS_PROHIBITED` into every grant and writes `max_external_spend`
 * as a literal zero, so a grant permitting contact, purchase, spending,
 * commitment or publication cannot be written by this module at all. Every one
 * of those is a commercial action under a separate grant a person makes
 * deliberately (§30), and this file neither reads nor writes one.
 *
 * **And nothing here authorizes building anything.** The brief's whole point is
 * that manufacturing follows demand, and every one of this kernel's questions
 * is a question about published sources. Deciding to actually produce a machine
 * is a decision with a factory on the end of it; there is no route to it
 * through this module, and there must never be one.
 */
import { createLayer, listLayers } from '../../repos/layers.ts';
import { getProject } from '../../repos/projects.ts';
import {
  ensureGoal,
  liveGoalNamed,
  revokeGoal,
} from '../../repos/russellAuthority.ts';
import {
  createProgram,
  getProgram,
  setProgramState,
} from '../../repos/manufacturing.ts';
import { recordEvent } from '../../repos/events.ts';
import { readDirective } from './directive.ts';
import type { ManufacturingProgram, RussellGoal } from '../../domain/types.ts';

/**
 * The directive a programme runs under unless a caller names another.
 *
 * A constant path and never a hash: the sha-256 is computed by `readDirective`
 * from the bytes it actually opened, because a hash a caller supplied is a
 * claim about a file nobody checked and is indistinguishable afterwards from
 * one Brain computed. §20's rule that a scope is built from server-controlled
 * facts, arriving at a provenance column.
 */
export const DEFAULT_DIRECTIVE_PATH = 'blueprints/MANUFACTURING-EMPIRE-KERNEL.md';

/**
 * The grant's name, and the identity the unique index is written against.
 *
 * A constant rather than a derived string: the index predicate compares against
 * this exact literal, so a name built per project would make the index match
 * nothing and the one-per-project rule would quietly stop being enforced.
 */
export const MANUFACTURING_AUTHORITY_NAME = 'Manufacturing programme research';

/** Where a programme's work is filed when the project has nowhere yet. */
export const MANUFACTURING_LAYER_NAME = 'Manufacturing programme';

const RESEARCH_WORK = 'RESEARCH';

/**
 * How many of this programme's questions may run at once.
 *
 * A concurrency bound and not an allowance — §24 removed exactly that kind of
 * lifetime number and recorded why, and nothing this rations is scarce. It is
 * deliberately smaller than Cash Mode's six: a manufacturing question has a
 * horizon measured in years, and a programme that took most of the fleet would
 * push the immediate cash work behind research nobody is waiting on this week.
 */
export const PROGRAMME_CONCURRENCY = 3;

export type ProgrammeOutcome =
  | { ok: true; program: ManufacturingProgram; created: boolean }
  | { ok: false; reason: string };

/**
 * Start a programme on a project.
 *
 * Refuses everything it cannot honour, in the order a person would hit it. The
 * objective floor is the same one Cash Mode applies and for the same reason:
 * "build machines" is a slogan and not an objective, and every question this
 * kernel asks carries the objective as the thing that decides which findings
 * are worth reporting.
 */
export async function startProgramme(input: {
  projectId: string;
  ownerUserId: string;
  actorUserId: string;
  objective: string;
  /** Repository-relative, under `blueprints/`. Defaults to the committed one. */
  directivePath?: string;
}): Promise<ProgrammeOutcome> {
  const objective = input.objective.replace(/\s+/g, ' ').trim();
  if (objective.length < 24) {
    return {
      ok: false,
      reason:
        'A manufacturing programme needs an objective somebody wrote. "Build machines" is not ' +
        'one: say what kinds of machine this company is trying to be able to build, and what ' +
        'it is starting from.',
    };
  }

  const project = await getProject(input.projectId);
  if (!project) return { ok: false, reason: 'No project with that id.' };

  /*
   * The directive is read and parsed *before* anything is written, and a
   * programme that cannot carry one does not start.
   *
   * Refusing here is what makes the column mean something. A programme that
   * started with an unreadable directive would record a path, record no hash,
   * and open questions carrying the objective alone — which is the exact state
   * `directive.ts` exists to make impossible, and it would have looked
   * perfectly healthy. The failure is a person's to fix (a file that is not in
   * the image, a path that is wrong) and it is reported in those words.
   */
  const directivePath = (input.directivePath ?? DEFAULT_DIRECTIVE_PATH).trim();
  const directive = await readDirective(directivePath);
  if (!directive.ok) {
    return {
      ok: false,
      reason:
        `A manufacturing programme runs under a directive, and this one could not be read: ` +
        `${directive.reason} Recording a path and a hash proves the file has not changed and ` +
        'says nothing about whether one word of it reached a worker, so a programme that ' +
        'cannot carry its directive does not start.',
    };
  }

  /*
   * A programme needs somewhere to file what it finds, and a project created
   * for one has nowhere.
   *
   * `standingAuthority` refuses every launch on a project with no layer, and
   * §30 records the cost of learning that the hard way: a section that could
   * open questions and answer none of them, for ever, with every row reading
   * healthy. Created only when there is none, so a programme started on a
   * project that already does research files into what that project already
   * has and nothing here reorganizes it.
   */
  if ((await listLayers(project.id)).length === 0) {
    await createLayer({
      projectId: project.id,
      name: MANUFACTURING_LAYER_NAME,
      orderIndex: 0,
    });
  }

  const { program, created } = await createProgram({
    projectId: input.projectId,
    objective,
    ownerUserId: input.ownerUserId,
    createdByUserId: input.actorUserId,
    blueprintPath: directive.directive.path,
    blueprintSha256: directive.directive.sha256,
  });

  await ensureProgrammeAuthority(input.projectId);

  if (created) {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'MANUFACTURING_PROGRAM',
      entityId: program.id,
      eventType: 'MANUFACTURING_PROGRAMME_STARTED',
      payload: {
        summary:
          'A manufacturing programme was started. Brain may now research, from published ' +
          'sources, what machine categories exist, who is buying, how product reaches them, ' +
          'and what producing each one takes and teaches. Nothing here permits spending, ' +
          'contact, purchase, commitment, publication — or building anything.',
        objective: program.objective,
        directivePath: program.blueprintPath,
        directiveSha256: program.blueprintSha256,
        authorizedByUserId: input.actorUserId,
      },
    });
  }
  return { ok: true, program, created };
}

/**
 * The live research grant for one programme, created if it is absent.
 *
 * Idempotent by the index, so it is safe to call from activation *and* from
 * every tick — which is what reconciles a programme started before this existed
 * without anybody pressing anything. The same distinction
 * `rearmSurfaceDeferredIntents` draws, and the reason this repository keeps
 * needing it: a hook fixes one entrance, and rows reach every entrance plus
 * everything already stranded.
 *
 * Returns null when there is no programme, or when it is archived. Most
 * projects hold neither and the tick asks about all of them.
 */
export async function ensureProgrammeAuthority(
  projectId: string,
): Promise<{ goal: RussellGoal; created: boolean } | null> {
  const program = await getProgram(projectId);
  if (!program || program.state === 'ARCHIVED') return null;

  /*
   * PAUSED keeps the grant deliberately.
   *
   * Pausing stops Brain opening *new* questions — that is `allocate`'s gate —
   * and everything already running has to be able to finish, be absorbed and be
   * read. §30 draws the same line between winding a sprint down and ending a
   * customer's obligation: an off switch that also killed work already paid for
   * would be throwing away spending nobody chose to waste.
   */
  return ensureGoal({
    projectId,
    ownerUserId: program.ownerUserId,
    createdByUserId: program.createdByUserId,
    name: MANUFACTURING_AUTHORITY_NAME,
    allowedWork: [RESEARCH_WORK],
    // `ALWAYS_PROHIBITED` is unioned in by the repository and carries every
    // external effect. These are named again because they are the ones a reader
    // of a manufacturing programme will look for, and a prohibition that is
    // only implied is one somebody argues about later.
    prohibitions: ['NEW_SPENDING', 'PURCHASE', 'CONTACT_PERSON', 'PUBLISH_EXTERNALLY'],
    // Meaningless under UNCAPPED and written as zero rather than as a large
    // number pretending to be unlimited, which is §24's own correction.
    maxMissions: 0,
    maxFragments: 0,
    maxProbes: 0,
    maxConcurrent: PROGRAMME_CONCURRENCY,
    workPolicy: 'UNCAPPED',
    // No expiry. The programme's own lifecycle is the bound: archiving revokes
    // this, and a clock that ended it mid-programme would be the "released by a
    // clock" failure §30 forbids one table along.
    expiresAt: null,
  });
}

export async function programmeAuthority(projectId: string): Promise<RussellGoal | null> {
  return liveGoalNamed(projectId, MANUFACTURING_AUTHORITY_NAME);
}

export type ProgrammeMoveOutcome =
  | { ok: true; program: ManufacturingProgram; changed: boolean }
  | { ok: false; reason: string };

/**
 * Pause, resume or archive a programme.
 *
 * Every move is a compare-and-swap naming the states it moves from, so two
 * people acting at once produce one outcome. Archiving additionally withdraws
 * the research grant, which is the one state that should not leave a standing
 * authorization on a project nobody is working — and it destroys nothing: the
 * grant keeps its id, its terms and its reason, every round and every category
 * stays exactly as written, and resuming calls `ensureProgrammeAuthority`
 * again.
 */
export async function moveProgramme(input: {
  projectId: string;
  actorUserId: string;
  to: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  reason?: string | null;
}): Promise<ProgrammeMoveOutcome> {
  const program = await getProgram(input.projectId);
  if (!program) return { ok: false, reason: 'This project has no manufacturing programme.' };

  const from: readonly ('ACTIVE' | 'PAUSED' | 'ARCHIVED')[] =
    input.to === 'ACTIVE'
      ? ['PAUSED', 'ARCHIVED']
      : input.to === 'PAUSED'
        ? ['ACTIVE']
        : ['ACTIVE', 'PAUSED'];

  const changed = await setProgramState({ programId: program.id, from, to: input.to });

  if (changed && input.to === 'ARCHIVED') {
    const goal = await programmeAuthority(input.projectId);
    if (goal) {
      await revokeGoal({
        goalId: goal.id,
        actorUserId: input.actorUserId,
        reason:
          input.reason?.trim() ||
          'The manufacturing programme was archived, so the research it authorized ended with it.',
      });
    }
  }
  if (changed && input.to === 'ACTIVE') await ensureProgrammeAuthority(input.projectId);

  if (changed) {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'MANUFACTURING_PROGRAM',
      entityId: program.id,
      eventType: 'MANUFACTURING_PROGRAMME_MOVED',
      payload: {
        summary: `The manufacturing programme moved from ${program.state} to ${input.to}.`,
        from: program.state,
        to: input.to,
        actorUserId: input.actorUserId,
        reason: input.reason ?? null,
      },
    });
  }

  const after = await getProgram(input.projectId);
  return { ok: true, program: after ?? program, changed };
}

/**
 * Whether Brain may open a *new* question for this programme.
 *
 * Deliberately a separate answer from whether it may absorb one. Filing what
 * research already found is not new discovery — the spending happened when it
 * ran — and dropping results because somebody paused the programme would throw
 * away work already paid for. §30's rule, one section along.
 */
export async function programmeMayAsk(
  projectId: string,
): Promise<{ allowed: true; program: ManufacturingProgram } | { allowed: false; reason: string }> {
  const program = await getProgram(projectId);
  if (!program) return { allowed: false, reason: 'This project has no manufacturing programme.' };
  if (program.state === 'PAUSED') {
    return {
      allowed: false,
      reason:
        'The programme is paused, so no new question is opened. Everything already running ' +
        'finishes and is filed, and it resumes where it left off.',
    };
  }
  if (program.state === 'ARCHIVED') {
    return { allowed: false, reason: 'The programme is archived.' };
  }
  const goal = await programmeAuthority(projectId);
  if (!goal) {
    return {
      allowed: false,
      reason:
        'No live research grant covers this programme, so nothing it asked could run. Starting ' +
        'or resuming the programme writes one.',
    };
  }
  return { allowed: true, program };
}

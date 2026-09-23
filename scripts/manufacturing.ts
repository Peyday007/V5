/**
 * `npm run manufacturing -- <command>` — the operator surface for the
 * manufacturing empire kernel.
 *
 * §26's rule about where these live: reaching the shell is the authentication,
 * and a decision a person makes about their own project belongs on the surface
 * they already use. Both are true here and they point in opposite directions,
 * so the split is drawn deliberately.
 *
 * Starting a programme, seeding a category, retiring one and recording that
 * this company holds a capability all exist as **routes** as well, at
 * `/api/projects/:id/manufacturing`, behind `requirePerson` and
 * `decideProjectAccess` at ADMIN — which is where they belong now that a
 * surface exists to show them. An earlier version of this header said **there
 * is no client surface for this kernel yet**; that was true when it was written
 * and is corrected here rather than deleted, because a reader who believed it
 * would conclude this file is the only door and reach for a terminal to make a
 * decision the product now offers. `client/src/russell/Machines.tsx` at
 * `/machines` is that surface, and it is where starting a programme, moving its
 * lifecycle and recording a held capability belong.
 *
 * This file stays, for §26's own reason: it is the recovery for when the client
 * bundle will not load, and it is the same operations against the same services
 * rather than a second, weaker path — every write below calls exactly what the
 * route calls.
 *
 * It follows the rule §23's fleet surface paid for twice: **a command that
 * changes nothing must not print success.** Every mutating command reports
 * whether a row actually changed and exits non-zero when none did.
 *
 * `--admin <email>` is *attribution*, not authentication, and §23 records the
 * difference: it resolves an enabled administrator from `users`, which
 * establishes that such a person exists and may authorize this and nothing
 * about who typed the command. Reaching this shell is what authenticated it.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { getUserByEmail } from '../server/repos/identity.ts';
import { getProjectBySlug, listProjects } from '../server/repos/projects.ts';
import { moveProgramme, programmeAuthority, startProgramme } from '../server/services/manufacturing/program.ts';
import {
  declareHeld,
  ledger,
  retireCategoryDecision,
  seedCategory,
  withdrawHeld,
} from '../server/services/manufacturing/declare.ts';
import { programmeView } from '../server/services/manufacturing/view.ts';
import { runManufacturingKernel } from '../server/services/manufacturing/kernel.ts';
import { MACHINE_CATEGORY_KINDS, type MachineCategoryKind } from '../server/domain/types.ts';

function out(line = ''): void {
  console.log(line);
}

class ExitSignal extends Error {}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exitCode = 1;
  throw new ExitSignal();
}

function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

const USAGE = `
  npm run manufacturing -- <command>

  start <project> --objective "…" --admin <email>   start a programme on a project
  state <project> --to ACTIVE|PAUSED|ARCHIVED --admin <email> [--reason "…"]
  show <project>                                    the ladder, the gaps and the next questions
  tick <project>                                    run one kernel pass by hand

  seed <project> --name "…" [--parent <id>] [--kind <k>] --admin <email> [--reason "…"]
  retire <project> --category <id> --reason "…" --admin <email>

  capabilities <project>                            the ledger, held first
  hold <project> --name "…"|--capability <id> --note "…" --admin <email>
  unhold <project> --capability <id> --reason "…" --admin <email>

  A project is named by slug or id.

  What none of these do: build, buy, tool, certify or enter anything. This
  kernel reads published sources and records what a person decides, and every
  decision with a factory on the end of it is somebody's to make elsewhere.
`;

async function resolveProject(ref: string | undefined): Promise<{ id: string; name: string }> {
  if (!ref) fail('Name a project, by slug or id.');
  const bySlug = await getProjectBySlug(ref as string);
  if (bySlug) return { id: bySlug.id, name: bySlug.name };
  const all = await listProjects();
  const byId = all.find((one) => one.id === ref);
  if (byId) return { id: byId.id, name: byId.name };
  fail(
    `No project matches "${ref}". This Brain holds: ${
      all.map((one) => one.slug).join(', ') || 'none'
    }.`,
  );
}

/**
 * An enabled administrator, resolved from rows.
 *
 * Attribution rather than authentication (§23), so the failure message says so
 * — an operator who reads "not authorized" here will go looking for a
 * permission problem that does not exist.
 */
async function resolveAdmin(argv: string[]): Promise<string> {
  const email = flag(argv, 'admin');
  if (!email) fail('--admin <email> says whose authority this carries, and it is required.');
  const person = await getUserByEmail(email as string);
  if (!person || !person.isBrainAdmin || person.disabled) {
    fail(
      `"${email}" resolves to no enabled administrator of this Brain. This is the attribution ` +
        'on the row rather than the check that let you in — reaching this shell is what did ' +
        'that — so it has to name somebody who exists and could have authorized it.',
    );
  }
  return person.id;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    out(USAGE);
    return;
  }

  // `initDatabase` applies the chain itself, so there is nothing to run here.
  await initDatabase();

  switch (command) {
    case 'start': {
      const project = await resolveProject(rest[0]);
      const admin = await resolveAdmin(rest);
      const objective = flag(rest, 'objective');
      if (!objective) fail('--objective "…" is required: a programme is research for something.');
      const outcome = await startProgramme({
        projectId: project.id,
        ownerUserId: admin,
        actorUserId: admin,
        objective: objective as string,
      });
      if (!outcome.ok) fail(outcome.reason);
      out('');
      out(`  ${outcome.created ? 'Started' : 'Already running'}  ${project.name}`);
      out(`  Objective  ${outcome.program.objective}`);
      out(`  State      ${outcome.program.state}`);
      out(
        `  Research   ${
          (await programmeAuthority(project.id))
            ? 'authorized — published sources only, no spending, no contact, no publication'
            : 'NOT authorized, which should not happen; nothing will run'
        }`,
      );
      out('');
      if (!outcome.created) fail('Nothing changed.');
      break;
    }

    case 'state': {
      const project = await resolveProject(rest[0]);
      const admin = await resolveAdmin(rest);
      const to = flag(rest, 'to');
      if (to !== 'ACTIVE' && to !== 'PAUSED' && to !== 'ARCHIVED') {
        fail('--to must be ACTIVE, PAUSED or ARCHIVED.');
      }
      const outcome = await moveProgramme({
        projectId: project.id,
        actorUserId: admin,
        to,
        reason: flag(rest, 'reason'),
      });
      if (!outcome.ok) fail(outcome.reason);
      out('');
      out(`  ${outcome.changed ? 'Moved to' : 'Already'}  ${outcome.program.state}`);
      out('');
      if (!outcome.changed) fail('Nothing changed.');
      break;
    }

    case 'show': {
      const project = await resolveProject(rest[0]);
      await show(project.id);
      break;
    }

    case 'tick': {
      const project = await resolveProject(rest[0]);
      const pass = await runManufacturingKernel(project.id);
      out('');
      out(`  Opened     ${pass.opened.length}`);
      for (const one of pass.opened) out(`    ${one.purpose.padEnd(12)} ${one.title}`);
      for (const one of pass.opened) out(`      why: ${one.why}`);
      out(`  Absorbed   ${pass.absorbed.categories.length} categor${
        pass.absorbed.categories.length === 1 ? 'y' : 'ies'
      }, ${pass.absorbed.edges.length} capability link(s), ${
        pass.absorbed.evidence.length
      } piece(s) of evidence`);
      out(`  Settled    ${pass.absorbed.settled.length} round(s)`);
      for (const one of pass.absorbed.refused) out(`    refused ${one.claimId}: ${one.why}`);
      if (pass.declined.length > 0) {
        out('  Considered and not asked');
        for (const one of pass.declined.slice(0, 10)) out(`    ${one.subject} — ${one.why}`);
      }
      out('');
      break;
    }

    case 'seed': {
      const project = await resolveProject(rest[0]);
      const admin = await resolveAdmin(rest);
      const name = flag(rest, 'name');
      if (!name) fail('--name "…" is required.');
      const kind = flag(rest, 'kind');
      if (kind && !(MACHINE_CATEGORY_KINDS as readonly string[]).includes(kind)) {
        fail(`--kind must be one of: ${MACHINE_CATEGORY_KINDS.join(', ')}.`);
      }
      const outcome = await seedCategory({
        projectId: project.id,
        name: name as string,
        kind: (kind as MachineCategoryKind | null) ?? undefined,
        parentId: flag(rest, 'parent'),
        description: flag(rest, 'description'),
        actorRef: admin,
        reason: flag(rest, 'reason'),
      });
      if ('error' in outcome) fail(outcome.error);
      out('');
      out(`  ${outcome.created ? 'Seeded' : 'Already on the ladder'}  ${outcome.category.name}`);
      out(`  ${outcome.category.id}  ${outcome.category.kind}  origin ${outcome.category.origin}`);
      out('');
      if (!outcome.created) fail('Nothing changed.');
      break;
    }

    case 'retire': {
      const project = await resolveProject(rest[0]);
      const admin = await resolveAdmin(rest);
      const categoryId = flag(rest, 'category');
      const reason = flag(rest, 'reason');
      if (!categoryId || !reason) fail('Usage: retire <project> --category <id> --reason "…"');
      const outcome = await retireCategoryDecision({
        projectId: project.id,
        categoryId: categoryId as string,
        reason: reason as string,
        actorRef: admin,
      });
      if ('error' in outcome) fail(outcome.error);
      out('');
      out(`  ${outcome.retiredAt ? 'Retired' : 'Not retired'}  ${outcome.name}`);
      if (outcome.retiredReason) out(`  ${outcome.retiredReason}`);
      out('  Nothing was destroyed: its evidence, its children and every round stay.');
      out('');
      if (!outcome.retiredAt) fail('Nothing changed.');
      break;
    }

    case 'capabilities': {
      const project = await resolveProject(rest[0]);
      const all = await ledger(project.id);
      out('');
      if (all.length === 0) out('  The ledger is empty.');
      for (const one of all) {
        const held = one.heldAt
          ? `HELD   ${one.heldEvidence} by ${one.heldBy}`
          : 'not held';
        out(`  ${held.padEnd(34)} ${one.name}`);
        if (one.heldNote) out(`      ${one.heldNote}`);
        out(`      ${one.id}`);
      }
      out('');
      out(
        `  ${all.filter((one) => one.heldAt !== null).length} of ${all.length} are recorded as ` +
          'held. A capability a machine *teaches* is never one this company holds — only a ' +
          'person can record that.',
      );
      out('');
      break;
    }

    case 'hold': {
      const project = await resolveProject(rest[0]);
      const admin = await resolveAdmin(rest);
      const note = flag(rest, 'note');
      if (!note) {
        fail(
          '--note "…" is required: say what was hired, bought, built or delivered. A capability ' +
            'held for no stated reason is indistinguishable afterwards from one somebody guessed.',
        );
      }
      const outcome = await declareHeld({
        projectId: project.id,
        capabilityId: flag(rest, 'capability'),
        name: flag(rest, 'name'),
        note: note as string,
        actorRef: admin,
      });
      if ('error' in outcome) fail(outcome.error);
      out('');
      out(`  ${outcome.changed ? 'Recorded as held' : 'Already held'}  ${outcome.capability.name}`);
      out(`  ${outcome.capability.id}`);
      if (outcome.capability.heldNote) out(`  ${outcome.capability.heldNote}`);
      out('');
      if (!outcome.changed) fail('Nothing changed.');
      break;
    }

    case 'unhold': {
      const project = await resolveProject(rest[0]);
      const admin = await resolveAdmin(rest);
      const capabilityId = flag(rest, 'capability');
      const reason = flag(rest, 'reason');
      if (!capabilityId || !reason) {
        fail('Usage: unhold <project> --capability <id> --reason "…"');
      }
      const outcome = await withdrawHeld({
        projectId: project.id,
        capabilityId: capabilityId as string,
        reason: reason as string,
        actorRef: admin,
      });
      if ('error' in outcome) fail(outcome.error);
      out('');
      out(`  ${outcome.heldAt ? 'Still held' : 'No longer held'}  ${outcome.name}`);
      out('');
      if (outcome.heldAt) fail('Nothing changed.');
      break;
    }

    default:
      out(USAGE);
      fail(`"${command}" is not a command.`);
  }
}

async function show(projectId: string): Promise<void> {
  const view = await programmeView(projectId);
  if (!view) fail('This project has no manufacturing programme. Start one first.');
  const it = view as NonNullable<Awaited<ReturnType<typeof programmeView>>>;

  out('');
  out(`  ${it.program.state}   ${it.program.objective}`);
  out(
    `  Research ${it.authorized ? 'authorized' : 'NOT authorized'} — ` +
      `${it.counts.categories} categor${it.counts.categories === 1 ? 'y' : 'ies'}, ` +
      `${it.counts.capabilitiesHeld} of ${it.counts.capabilities} capabilities held, ` +
      `${it.counts.openRounds} question(s) running`,
  );

  out('');
  out('  ENTERABLE NOW');
  if (it.enterable.length === 0) {
    out('    none — which is the honest answer until demand, a route and every requirement');
    out('    have all been established for one category.');
  }
  for (const one of it.enterable) out(`    ${one.path.join(' → ')}`);

  out('');
  out('  CLOSEST, AND WHAT WOULD CLOSE IT');
  if (it.next.length === 0) out('    nothing has both published buyers and a published route yet.');
  for (const one of it.next) {
    out(`    ${one.reading.path.join(' → ')}`);
    out(`      ${one.reading.because}`);
    for (const bridge of one.bridges) {
      out(`      via ${bridge.name}: ${bridge.supplies.join(', ')}`);
    }
  }

  out('');
  out('  THE DIRECTIVE');
  out(`    ${it.directive.path ?? '(none named)'}`);
  if (it.directive.sha256) out(`    sha-256 ${it.directive.sha256}`);
  /*
   * Two lines rather than one, because *hashed* and *operative* are two facts
   * and a hash can only answer the first. A programme whose directive stopped
   * being readable would otherwise print a perfectly healthy digest.
   */
  out(
    it.directive.reaching
      ? '    reaching the questions: yes — its own sentences are in every assignment'
      : `    reaching the questions: NO — ${it.directive.why ?? 'unknown'}`,
  );

  out('');
  out('  STRONGEST NEXT EXPANSION');
  if (it.frontier.length === 0) out('    nothing is on the ladder, so there is nothing to rank.');
  for (const one of it.frontier.slice(0, 10)) {
    out(`    ${String(one.position).padStart(2)}. ${one.path.join(' → ')}`);
    // The single factor that put it below the entry above, which is what makes
    // this a ranking somebody can argue with rather than only accept.
    out(
      one.separatedBy
        ? `        separated by ${one.separatedBy.factor}: ${one.separatedBy.because}`
        : '        level with the entry above on every factor Brain measures.',
    );
  }

  out('');
  out('  THE LADDER');
  for (const one of it.ladder.slice(0, 30)) {
    out(`    ${one.verdict.padEnd(24)} ${one.path.join(' → ')}`);
    for (const condition of one.conditions) {
      out(`      ${condition.answer.padEnd(8)} ${condition.condition}`);
    }
  }

  out('');
  out('  WHAT ENTERING COSTS');
  for (const one of it.ladder.slice(0, 30)) {
    if (one.capital.state === 'UNEXAMINED') continue;
    out(`    ${one.path.join(' → ')}`);
    out(`      ${one.capital.because}`);
    for (const scenario of one.capital.scenarios) {
      const total =
        scenario.totals === null
          ? 'no total — a requirement is unpriced'
          : scenario.totals
              .map((money) =>
                money.lowMinor === money.highMinor
                  ? `${money.currency} ${(money.lowMinor / 100).toLocaleString('en-US')}`
                  : `${money.currency} ${(money.lowMinor / 100).toLocaleString('en-US')}–` +
                    `${(money.highMinor / 100).toLocaleString('en-US')}`,
              )
              .join(' plus ');
      out(`      ${scenario.scenario.padEnd(24)} ${total}`);
    }
  }

  out('');
  out('  COULD BE BOUGHT RATHER THAN BUILT');
  if (it.acquisitions.length === 0) {
    out('    nothing named. Asked only where a category requires something nothing on the');
    out('    ladder is established to develop. Identification only: no approach, no');
    out('    valuation, no offer, and no route in this kernel to any of them.');
  }
  for (const one of it.acquisitions) {
    out(
      `    ${one.candidate.name}${one.candidate.setAsideAt ? ' (set aside)' : ''} — ` +
        `${one.candidate.contribution}${one.subject ? ` for ${one.subject}` : ''}`,
    );
  }

  out('');
  out('  OPEN QUESTIONS');
  for (const one of it.openQuestions) {
    out(`    ${one.topic}  ${one.state}`);
    out(`      ${one.because}`);
    if (one.resolution) out(`      answered: ${one.resolution}`);
  }

  out('');
  out('  WHAT BRAIN WOULD ASK NEXT');
  if (it.plan.asks.length === 0) out('    nothing — every slot is taken or nothing qualifies.');
  for (const one of it.plan.asks) {
    out(`    ${one.purpose.padEnd(12)} ${one.subject}`);
    out(`      ${one.why}`);
  }
  if (it.plan.declined.length > 0) {
    out('  CONSIDERED AND NOT ASKED');
    for (const one of it.plan.declined.slice(0, 10)) out(`    ${one.subject} — ${one.why}`);
  }
  out('');
}

try {
  await main();
} catch (error) {
  if (!(error instanceof ExitSignal)) {
    console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} finally {
  await closeDatabase();
}

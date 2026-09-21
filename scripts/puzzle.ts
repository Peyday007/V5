/**
 * `npm run puzzle -- <command>` — the operator surface for the puzzle
 * products + production kernel.
 *
 * §26's rule about where these live: reaching the shell is the
 * authentication, and a decision a person makes about their own project
 * belongs on the surface they already use. Both are true here, so the split is
 * drawn deliberately.
 *
 * Every write below exists as a **route** as well, at
 * `/api/projects/:id/puzzle/...`, behind `requirePerson` and
 * `decideProjectAccess` at ADMIN. **There is no client surface for this kernel
 * yet**, so this file is the door that works today, and it is the same
 * operations against the same services rather than a second, weaker path:
 * every command below calls exactly what the route calls.
 *
 * It follows the rule §23's fleet surface paid for twice: **a command that
 * changes nothing must not print success.** Every mutating command reports
 * whether a row actually changed and exits non-zero when none did.
 *
 * `--admin <email>` is *attribution*, not authentication, and §23 records the
 * difference: it resolves an enabled administrator from `users`, which
 * establishes that such a person exists and may authorize this and nothing
 * about who typed the command.
 *
 * **What none of these do:** publish, price, list, print, buy, or contact
 * anybody. Releasing an output records that a person decided it is ready;
 * pursuing it is Cash Mode's machinery behind a commercial grant somebody made
 * separately.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { getUserByEmail } from '../server/repos/identity.ts';
import { getProjectBySlug, listProjects } from '../server/repos/projects.ts';
import {
  compileOutput,
  decideRoute,
  declareFormat,
  declareMaster,
  declareRoute,
  recordPersonObservation,
  releaseOutput,
  reviewMaster,
  usableInstances,
} from '../server/services/puzzle/declare.ts';
import { produceBatch } from '../server/services/puzzle/produce.ts';
import { runPuzzleKernel } from '../server/services/puzzle/kernel.ts';
import { puzzleView } from '../server/services/puzzle/view.ts';
import { listEngines } from '../server/services/puzzle/engines/index.ts';
import { listMasters, listOutputs } from '../server/repos/puzzle.ts';
import {
  isDifferentiatorAxis,
  isProductionClass,
  isPuzzleObservationKind,
  isRouteClass,
  isRouteDisposition,
} from '../server/domain/puzzle.ts';
import {
  DIFFERENTIATOR_AXES,
  PRODUCTION_CLASSES,
  PUZZLE_OBSERVATION_KINDS,
  ROUTE_CLASSES,
  ROUTE_DISPOSITIONS,
} from '../server/domain/types.ts';

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
  npm run puzzle -- <command>

  show <project>                          everything: the ledger, the formats, what needs a person
  tick <project>                          run one kernel pass by hand
  engines                                 what can actually be generated and checked

  format <project> --name "…" --admin <email>
  route  <project> --name "…" --class <c> --admin <email> [--note "…"]
  decide <project> --route <id> --to <disposition> --reason "…" --admin <email>

  master  <project> --format "…" --name "…" --engine <id> --rights "…" --admin <email>
                    [--params '<json>']
  review  <project> --master <id> --note "…" --admin <email>
  produce <project> --master <id> --count <n> --admin <email> [--run <label>]

  instances <project> --master <id>       the validated ones, which is all a product may contain
  compile   <project> --master <id> --title "…" --class <c> --axes a,b --instances i1,i2
                      --admin <email> [--buyer "…"] [--route <id>]
  release   <project> --output <id> --admin <email>

  observe <project> --kind <k> --statement "…" --admin <email> [--subject "…"]

  A project is named by slug or id.

  What none of these do: publish, price, list, print, buy or contact anybody.
  This kernel makes puzzles, checks them, and records what a person decides.
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

/** Print a refusal in the service's own words, and exit non-zero. */
function settle<T>(result: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!result.ok) fail(result.reason);
  return result.value;
}

const money = (minor: number, currency: string): string =>
  `${(minor / 100).toFixed(2)} ${currency}`;

async function show(projectId: string, name: string): Promise<void> {
  const view = await puzzleView(projectId);

  out(`\n  ${name} — puzzle products + production\n`);
  if (!view.active) {
    out('  This project holds no sprint, so the kernel does nothing here.\n');
    return;
  }

  out('  RIGHT NOW');
  out(
    `    collected            ${
      view.rightNow.collected.length === 0
        ? 'nothing has settled'
        : view.rightNow.collected.map((one) => money(one.amountMinor, one.currency)).join(', ')
    }`,
  );
  out(`    validated puzzles    ${view.rightNow.validatedPuzzles}`);
  out(`    qualified outputs    ${view.rightNow.qualifiedOutputs}`);
  out(`    released             ${view.rightNow.released}`);
  out(`    production stage     ${view.rightNow.productionStage}`);
  if (view.rightNow.nextQuestion) out(`    next question        ${view.rightNow.nextQuestion}`);
  if (view.rightNow.notAsking) out(`    not asking           ${view.rightNow.notAsking}`);

  out('\n  TOP 5 NOW');
  if (view.ledger.topNow.length === 0) out('    nothing is on the ledger yet.');
  for (const route of view.ledger.topNow) {
    out(`    ${route.rank}. ${route.name}  [${route.routeClass}]  ${route.routeId}`);
    out(`       ${route.why}`);
    if (route.aheadBecause) out(`       ahead because: ${route.aheadBecause}`);
    if (route.nextQuestion) out(`       next: ${route.nextQuestion}`);
  }
  out(
    `\n    ledger: ${view.ledger.totals.routes} route(s), ${view.ledger.totals.active} active, ` +
      `${view.ledger.totals.withDemand} with a dated signal, ` +
      `${view.ledger.totals.searchedAndEmpty} searched and empty. ` +
      `${view.ledger.watchlist.length} watch-listed, ${view.ledger.blocked.length} blocked, ` +
      `${view.ledger.unproven.length} unproven, ` +
      `${view.ledger.archivedOrRejected.length} archived or rejected, ` +
      `${view.ledger.physicalLadder.length} need capital.`,
  );

  out('\n  BEING MADE NOW');
  if (view.beingMade.length === 0) out('    no question is open.');
  for (const one of view.beingMade) {
    out(`    ${one.purpose}${one.subject ? ` — ${one.subject}` : ''} (round ${one.round})`);
    out(`       ${one.why}`);
  }

  out('\n  FORMATS');
  if (view.formats.length === 0) out('    nothing is on the map yet.');
  for (const format of view.formats) {
    out(`    ${format.name}  [${format.maturity}]`);
    out(`       ${format.why}`);
    if (format.nextQuestion) out(`       next: ${format.nextQuestion}`);
    out(
      `       engines ${format.engines.length ? format.engines.join(', ') : 'none'} · ` +
        `masters ${format.masters} (${format.reviewedMasters} reviewed) · ` +
        `puzzles ${format.passing}/${format.instances} passing · ` +
        `outputs ${format.qualifiedOutputs}/${format.outputs} qualified`,
    );
    if (format.missingChecks.length > 0) {
      out(`       demanded and unrunnable: ${format.missingChecks.join(', ')}`);
    }
  }

  out('\n  OUTPUTS');
  if (view.outputs.length === 0) out('    nothing has been compiled.');
  for (const output of view.outputs) {
    out(`    ${output.title}  [${output.qualification}]  ${output.outputId}`);
    out(`       ${output.why}`);
    out(
      `       ${output.members} puzzle(s), ${output.unvalidatedMembers} unvalidated · ` +
        `qualifying: ${output.qualifyingAxes.join(', ') || 'none'} · ` +
        `cosmetic: ${output.cosmeticAxes.join(', ') || 'none'}`,
    );
  }

  out('\n  LEVERAGE');
  const lev = view.leverage;
  const measured = (m: { value: number | null; denominator: string; wouldMeasure: string | null }) =>
    m.value === null ? `not measured — ${m.wouldMeasure}` : `${m.value} ${m.denominator}`;
  out(`    validated master systems   ${lev.validatedMasters}`);
  out(`    validated puzzles          ${lev.validatedInstances}`);
  out(`    qualified outputs          ${lev.qualifiedOutputs}   (reprints ${lev.reprints}, drafts ${lev.drafts})`);
  out(`    master to SKU              ${measured(lev.masterToSku)}`);
  out(`    setup to unit yield        ${measured(lev.setupToUnitYield)}`);
  out(`    contribution per setup     ${measured(lev.contributionPerSetup)}`);
  out(`    puzzles per editorial hour ${measured(lev.puzzlesPerEditorialHour)}`);
  out(`    the directive's target     ${lev.target.masters} systems, ${lev.target.outputs} outputs`);
  out(`                               ${lev.target.note}`);

  out('\n  QUALITY');
  out(`    validation pass rate  ${measured(lev.quality.validationPassRate)}`);
  out(`    unvalidated instances ${lev.quality.unvalidated}`);
  out(`    human playtests       ${lev.quality.playtests}`);
  if (lev.quality.failuresByCheck.length > 0) {
    out(
      `    failures              ${lev.quality.failuresByCheck
        .map((one) => `${one.check} x${one.count}`)
        .join(', ')}`,
    );
  }

  out('\n  ECONOMICS');
  if (view.economics.length === 0) out('    nothing publishes what any route pays or costs.');
  for (const reading of view.economics) {
    out(`    ${reading.routeName ?? 'unattached'} as ${reading.productionClass}`);
    if (reading.withheld) {
      out(`       withheld (${reading.withheld}): ${reading.why}`);
    } else {
      out(
        `       contribution ${money(reading.contributionPerUnitMinor ?? 0, reading.currency ?? '')}` +
          ` per ${reading.basis}` +
          (reading.breakevenUnits ? ` · breakeven ${reading.breakevenUnits} units` : ''),
      );
    }
  }

  out('\n  PHYSICAL PRODUCTION');
  out(`    stage                 ${view.production.stage}`);
  out(`    ${view.production.why}`);
  out(`    recorded runs         ${view.production.recordedProductionRuns}`);
  out(`    next                  ${view.production.nextQuestion}`);

  out('\n  THE ONE-DOLLAR BOOK');
  out(`    ${view.cheapBook.why}`);
  if (view.cheapBook.established.length > 0) {
    out(`    established: ${view.cheapBook.established.join(', ')}`);
  }
  if (view.cheapBook.missing.length > 0) {
    out(`    missing:     ${view.cheapBook.missing.join(', ')}`);
  }

  if (view.lessons.length > 0) {
    out('\n  WHAT ATTEMPTS TAUGHT');
    for (const lesson of view.lessons) {
      out(`    ${lesson.kind}${lesson.subjectKey ? ` — ${lesson.subjectKey}` : ''}  [${lesson.reading}]`);
      out(`       ${lesson.why}`);
      for (const one of lesson.sample.slice(0, 3)) out(`       · ${one.statement}`);
    }
  }

  out('\n  NEEDS ME');
  if (view.needsPerson.length === 0) out('    nothing is waiting on a person.');
  for (const one of view.needsPerson) {
    out(`    ${one.what}  (${one.where})`);
    out(`       ${one.why}`);
  }

  out('\n  DIRECTIVE');
  if (view.directive) {
    out(`    ${view.directive.path}  ${view.directive.bytes} bytes`);
    out(`    sha-256 ${view.directive.digest}`);
  } else {
    out(`    ${view.directiveProblem}`);
  }
  out();
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    out(USAGE);
    return;
  }

  await initDatabase();

  if (command === 'engines') {
    out('\n  What this Brain can actually generate and check\n');
    for (const engine of listEngines()) {
      out(`    ${engine.id}@${engine.version}  →  ${engine.formatKey}`);
      out(`       ${engine.summary}`);
      out(`       checks: ${engine.implementsChecks.join(', ')}`);
    }
    out(
      '\n    A format with no engine here is RESEARCHED rather than GENERATABLE, which is the\n' +
        '    honest answer: the directive says not to claim support for formats lacking real\n' +
        '    validators.\n',
    );
    return;
  }

  const project = await resolveProject(rest[0]);

  if (command === 'show') {
    await show(project.id, project.name);
    return;
  }

  if (command === 'tick') {
    const pass = await runPuzzleKernel(project.id);
    out(`\n  ${project.name}\n`);
    if (pass.blocked) out(`    blocked: ${pass.blocked}`);
    out(`    opened   ${pass.opened.length}`);
    for (const one of pass.opened) out(`      ${one.purpose}  ${one.roundId}  ${one.title}`);
    out(
      `    filed    ${pass.filed.formats.length} format(s), ${pass.filed.standards.length} ` +
        `standard(s), ${pass.filed.rights.length} rights rule(s), ${pass.filed.routes.length} ` +
        `route(s), ${pass.filed.routeEvidence.length} demand row(s), ` +
        `${pass.filed.economics.length} figure(s)`,
    );
    out(`    settled  ${pass.filed.settled.map((one) => `${one.roundId}(${one.found})`).join(', ') || 'none'}`);
    if (pass.filed.refused.length > 0) {
      out(`    refused  ${pass.filed.refused.length}`);
      for (const one of pass.filed.refused.slice(0, 5)) out(`      ${one.claimId}: ${one.why}`);
    }
    if (pass.observed.length > 0) out(`    observed ${pass.observed.length} defect(s)`);
    out(`    declined ${pass.declined.length}`);
    for (const one of pass.declined.slice(0, 5)) out(`      ${one.subject}: ${one.why}`);
    out();
    return;
  }

  if (command === 'instances') {
    const masterId = flag(rest, 'master');
    if (!masterId) fail('--master <id> is required.');
    const instances = await usableInstances({ projectId: project.id, masterId: masterId as string });
    out(`\n  ${instances.length} validated instance(s)\n`);
    for (const one of instances) out(`    ${one.instanceId}  ${one.difficulty ?? ''}`);
    out(
      '\n    These are the only ones a product may contain. An instance whose validation\n' +
        '    failed, or which nothing validated, is one this kernel does not have.\n',
    );
    return;
  }

  const adminId = await resolveAdmin(rest);

  if (command === 'format') {
    const name = flag(rest, 'name');
    if (!name) fail('--name "…" is required.');
    const format = settle(await declareFormat({ projectId: project.id, name: name as string }));
    out(`\n  ${format.name}  ${format.id}  [${format.origin}]\n`);
    return;
  }

  if (command === 'route') {
    const name = flag(rest, 'name');
    const routeClass = flag(rest, 'class');
    if (!name) fail('--name "…" is required.');
    if (!isRouteClass(routeClass)) fail(`--class must be one of ${ROUTE_CLASSES.join(', ')}.`);
    const route = settle(
      await declareRoute({
        projectId: project.id,
        name: name as string,
        routeClass,
        note: flag(rest, 'note'),
      }),
    );
    out(`\n  ${route.name}  ${route.id}  [${route.routeClass}]\n`);
    return;
  }

  if (command === 'decide') {
    const id = flag(rest, 'route');
    const to = flag(rest, 'to');
    const reason = flag(rest, 'reason') ?? '';
    if (!id) fail('--route <id> is required.');
    if (!isRouteDisposition(to)) fail(`--to must be one of ${ROUTE_DISPOSITIONS.join(', ')}.`);
    const route = settle(await decideRoute({ id: id as string, disposition: to, reason, byId: adminId }));
    out(`\n  ${route.name} is ${route.disposition}: ${route.dispositionReason ?? 'active'}\n`);
    return;
  }

  if (command === 'master') {
    const formatKey = flag(rest, 'format');
    const name = flag(rest, 'name');
    const engineId = flag(rest, 'engine');
    const rights = flag(rest, 'rights');
    const paramsRaw = flag(rest, 'params');
    if (!formatKey || !name || !engineId || !rights) {
      fail('--format, --name, --engine and --rights are all required.');
    }
    let params: Record<string, unknown> = {};
    if (paramsRaw) {
      try {
        params = JSON.parse(paramsRaw) as Record<string, unknown>;
      } catch {
        fail('--params must be JSON.');
      }
    }
    const master = settle(
      await declareMaster({
        projectId: project.id,
        formatKey: formatKey as string,
        name: name as string,
        engineId: engineId as string,
        params,
        rightsBasis: rights as string,
      }),
    );
    out(`\n  ${master.name}  ${master.id}  ${master.engineId}@${master.engineVersion}`);
    out(`    rights basis: ${master.rightsBasis}`);
    out('    Not reviewed. Nothing may be compiled from it until a person has reviewed it.\n');
    return;
  }

  if (command === 'review') {
    const id = flag(rest, 'master');
    const note = flag(rest, 'note');
    if (!id || !note) fail('--master <id> and --note "…" are required.');
    const master = settle(
      await reviewMaster({ id: id as string, reviewedById: adminId, note: note as string }),
    );
    out(`\n  ${master.name} reviewed at ${master.reviewedAt}\n`);
    return;
  }

  if (command === 'produce') {
    const id = flag(rest, 'master');
    const count = Number(flag(rest, 'count') ?? '0');
    if (!id) fail('--master <id> is required.');
    if (!Number.isInteger(count) || count < 1) fail('--count must be a whole number of at least one.');
    let report;
    try {
      report = await produceBatch({
        projectId: project.id,
        masterId: id as string,
        count,
        run: flag(rest, 'run') ?? undefined,
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : 'That batch could not run.');
    }
    out(`\n  ${report.engineId}: asked for ${report.requested}`);
    out(`    passed     ${report.passed.length}`);
    out(`    failed     ${report.failed.length}`);
    out(`    unchecked  ${report.unchecked.length}`);
    out(`    duplicates ${report.duplicates}`);
    if (report.refused.length > 0) {
      out(`    refused    ${report.refused.length}`);
      for (const one of report.refused.slice(0, 3)) out(`      ${one.seed}: ${one.error}`);
    }
    if (report.note) out(`    note: ${report.note}`);
    if (report.blocked) {
      out(`\n    BLOCKED on ${report.blocked.check}`);
      out(`    ${report.blocked.why}\n`);
      process.exitCode = 1;
      return;
    }
    if (report.passed.length === 0) {
      fail('Nothing passed, so nothing was added to the catalog.');
    }
    out();
    return;
  }

  if (command === 'compile') {
    const masterId = flag(rest, 'master');
    const title = flag(rest, 'title');
    const productionClass = flag(rest, 'class');
    const axesRaw = flag(rest, 'axes') ?? '';
    const instancesRaw = flag(rest, 'instances') ?? '';
    if (!masterId || !title) fail('--master <id> and --title "…" are required.');
    if (!isProductionClass(productionClass)) {
      fail(`--class must be one of ${PRODUCTION_CLASSES.join(', ')}.`);
    }
    const axes = axesRaw
      .split(',')
      .map((one) => one.trim())
      .filter(Boolean);
    for (const axis of axes) {
      if (!isDifferentiatorAxis(axis)) {
        fail(`--axes must be drawn from ${DIFFERENTIATOR_AXES.join(', ')}.`);
      }
    }
    const instanceIds = instancesRaw
      .split(',')
      .map((one) => one.trim())
      .filter(Boolean);
    const compiled = settle(
      await compileOutput({
        projectId: project.id,
        masterId: masterId as string,
        title: title as string,
        productionClass,
        differentiators: axes.filter(isDifferentiatorAxis),
        instanceIds,
        targetBuyer: flag(rest, 'buyer'),
        routeId: flag(rest, 'route'),
      }),
    );
    out(`\n  ${compiled.output.title}  ${compiled.output.id}  ${compiled.members} puzzle(s)\n`);
    return;
  }

  if (command === 'release') {
    const id = flag(rest, 'output');
    if (!id) fail('--output <id> is required.');
    const output = settle(await releaseOutput({ id: id as string, byId: adminId }));
    out(`\n  ${output.title} released at ${output.releasedAt}`);
    out(
      '    This records a decision. It publishes nothing and lists nothing for sale —\n' +
        '    pursuing it is Cash Mode, behind a commercial grant somebody made separately.\n',
    );
    return;
  }

  if (command === 'observe') {
    const kind = flag(rest, 'kind');
    const statement = flag(rest, 'statement');
    if (!isPuzzleObservationKind(kind)) {
      fail(`--kind must be one of ${PUZZLE_OBSERVATION_KINDS.join(', ')}.`);
    }
    if (!statement) fail('--statement "…" is required.');
    settle(
      await recordPersonObservation({
        projectId: project.id,
        kind,
        subjectKey: flag(rest, 'subject'),
        statement: statement as string,
        observerId: adminId,
        masterId: flag(rest, 'master'),
        outputId: flag(rest, 'output'),
      }),
    );
    out('\n  Recorded.\n');
    return;
  }

  if (command === 'masters') {
    const masters = await listMasters(project.id);
    out(`\n  ${masters.length} master(s)\n`);
    for (const one of masters) {
      out(
        `    ${one.name}  ${one.id}  ${one.engineId}@${one.engineVersion}  ` +
          `${one.reviewedAt ? 'reviewed' : 'NOT REVIEWED'}`,
      );
    }
    out();
    return;
  }

  if (command === 'outputs') {
    const outputs = await listOutputs(project.id);
    out(`\n  ${outputs.length} output(s)\n`);
    for (const one of outputs) {
      out(`    ${one.title}  ${one.id}  [${one.productionClass}]  ${one.releasedAt ? 'released' : ''}`);
    }
    out();
    return;
  }

  fail(`Unknown command "${command}".${USAGE}`);
}

main()
  .catch((error: unknown) => {
    if (!(error instanceof ExitSignal)) {
      console.error(error);
      process.exitCode = 1;
    }
  })
  .finally(() => {
    void closeDatabase();
  });

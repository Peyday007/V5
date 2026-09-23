/**
 * `npm run report:puzzle` — what the puzzle kernel has actually made, sold and
 * learned.
 *
 * Read-only, on purpose and by construction: it opens the database, prints
 * what is there, and closes it. It generates nothing, compiles nothing, asks
 * nothing and spends nothing. The one thing it can do to production is read
 * it. `cash-report.ts` and `labor-report.ts` are the same shape one axis
 * along, and it runs the same way — inside the container, through
 * `flyctl ssh console` — so the answer comes from rows rather than from a
 * screen somebody photographed.
 *
 *   npm run report:puzzle -- --project prj_xxx
 *   npm run report:puzzle                      (every project with a sprint)
 *   npm run report:puzzle -- --project prj_xxx --puzzle pzi_xxx
 *
 * The sections are the ones the brief asks for, in its order: RIGHT NOW, TOP 5
 * NOW, BEING MADE NOW, LEVERAGE, QUALITY, PHYSICAL PRODUCTION, WHAT CHANGED,
 * NEEDS ME, NEXT. Every figure resolves to a row and every one that does not
 * prints `UNKNOWN` with what would measure it — an absent line reads as
 * *nothing to say about it*, and the honest answer is *nobody has measured
 * this*.
 *
 * With `--puzzle` it renders one stored puzzle from its specification and says
 * whether it still hashes to what was recorded. That is the whole of "the
 * specification is the storage" made checkable from a terminal: the grid, the
 * solution and the answer key are produced together, every time, and a hash
 * that no longer matches means the generator moved underneath a stored row.
 *
 * No credential is read, printed or required.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { describePoolerRefusal } from '../server/db/adapters/postgres.ts';
import { listProjects } from '../server/repos/projects.ts';
import { getPuzzleInstance } from '../server/repos/puzzle.ts';
import { renderInstance } from '../server/services/puzzle/generate.ts';
import { puzzleView } from '../server/services/puzzle/view.ts';
import type { Reading } from '../server/services/puzzle/leverage.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function money(cents: number | null, currency: string | null): string {
  if (cents === null) return 'unknown';
  return `${(cents / 100).toFixed(2)} ${currency ?? ''}`.trim();
}

/**
 * A reading printed with its evidence class, always.
 *
 * `UNKNOWN` prints the note rather than a dash, because the note is the useful
 * half: *nobody has measured this, and here is what would* is an action, and a
 * dash is a shrug.
 */
function reading(label: string, one: Reading, format?: (value: number) => string): void {
  if (one.evidence === 'UNKNOWN' || one.value === null) {
    console.log(`  ${label.padEnd(34)} UNKNOWN — ${one.note}`);
    return;
  }
  const shown = format ? format(one.value) : String(Math.round(one.value * 100) / 100);
  console.log(`  ${label.padEnd(34)} ${shown}  (MEASURED)`);
  console.log(`  ${''.padEnd(34)} ${one.note}`);
}

async function main(): Promise<void> {
  await initDatabase();

  const only = flag('project');
  const puzzleId = flag('puzzle');
  const projects = await listProjects();
  const wanted = only ? projects.filter((one) => one.id === only) : projects;

  if (wanted.length === 0) {
    console.log(only ? `No project with id ${only}.` : 'No projects.');
    console.log('PUZZLE-REPORT: OK kernels=0');
    return;
  }

  if (puzzleId) {
    await printOnePuzzle(puzzleId);
    console.log('PUZZLE-REPORT: OK puzzle=' + puzzleId);
    return;
  }

  let printed = 0;
  for (const project of wanted) {
    const view = await puzzleView(project.id);
    /*
     * A project with no sprint and nothing on the map is skipped rather than
     * printed empty — unless it was named, in which case somebody asked about
     * it and "there is nothing here" is the answer they wanted.
     */
    if (!only && !view.active && view.rightNow.formatsOnMap === 0) continue;
    printed += 1;
    print(project.id, project.name, view);
  }

  /*
   * The line the workflow greps for, on every path that reached the end.
   *
   * It is what tells a caller the difference between a report that found
   * nothing and a session a restart cut off half way — `flyctl ssh console`
   * exits 0 either way, so without a terminal marker the second reads as the
   * first. Zero kernels is not a failure: most projects hold none, and saying
   * so is the answer.
   */
  if (printed === 0) {
    console.log('No project is running a puzzle kernel.');
    console.log('PUZZLE-REPORT: OK kernels=0');
    return;
  }
  console.log(`PUZZLE-REPORT: OK kernels=${printed}`);
}

async function printOnePuzzle(instanceId: string): Promise<void> {
  const instance = await getPuzzleInstance(instanceId);
  if (!instance) {
    console.log(`No puzzle with id ${instanceId}.`);
    return;
  }
  console.log(`PUZZLE ${instance.id}`);
  console.log(`  system      ${instance.masterId}`);
  console.log(`  seed        ${instance.seed}`);
  console.log(`  state       ${instance.validationState}`);
  console.log(`  difficulty  ${instance.measuredDifficulty ?? 'not measured'} (measured, not intended)`);
  console.log(`  content     ${instance.contentHash}`);
  console.log(`  canonical   ${instance.canonicalHash ?? '—'}`);
  console.log('');
  console.log('  WHAT WAS CHECKED');
  for (const check of instance.checks) {
    console.log(`    ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}`);
    console.log(`         ${check.detail}`);
  }
  console.log('');

  const rendered = await renderInstance(instance);
  if ('error' in rendered) {
    console.log(`  COULD NOT RE-RENDER: ${rendered.error}`);
    return;
  }
  console.log(
    `  RE-RENDERED FROM ITS SPECIFICATION — ${
      rendered.reproduced
        ? 'and it hashes to what was recorded.'
        : 'and it does NOT hash to what was recorded. The generator has moved underneath this ' +
          'row, so what follows is not what was checked.'
    }`,
  );
  console.log('');
  console.log(`  ${rendered.artifact.instructions}`);
  console.log('');
  for (const row of rendered.artifact.grid) console.log(`    ${row}`);
  if (rendered.artifact.prompts.length > 0) {
    console.log('');
    console.log(`    ${rendered.artifact.prompts.join('  ')}`);
  }
  console.log('');
  console.log('  ANSWER KEY');
  for (const row of rendered.artifact.answerKey) console.log(`    ${row}`);
}

function print(projectId: string, name: string, view: Awaited<ReturnType<typeof puzzleView>>): void {
  console.log('');
  console.log('='.repeat(78));
  console.log(`${name}  (${projectId})`);
  console.log('='.repeat(78));

  console.log('');
  console.log('RIGHT NOW');
  console.log(`  cash collected                 ${money(view.rightNow.collectedCents, view.rightNow.currency)}`);
  console.log(`  formats on the map             ${view.rightNow.formatsOnMap}`);
  console.log(`  ...that Brain can make         ${view.rightNow.formatsBrainCanMake}`);
  console.log(`  puzzle systems                 ${view.rightNow.systems}`);
  console.log(`  validated puzzles              ${view.rightNow.validPuzzles}`);
  console.log(`  qualified products             ${view.rightNow.qualifiedProducts}`);
  console.log(`  promoted into the portfolio    ${view.rightNow.promoted}`);
  console.log(
    `  furthest along                 ${
      view.rightNow.furthest
        ? `${view.rightNow.furthest.format} at ${view.rightNow.furthest.rung} ` +
          `(${view.rightNow.furthest.validPuzzles} proved puzzle(s), ` +
          `${view.rightNow.furthest.products} product(s))`
        : 'nothing on the map'
    }`,
  );

  console.log('');
  console.log('TOP 5 NOW');
  if (view.topFive.length === 0) {
    console.log('  Nothing in the ledger has anything established about it yet.');
  }
  for (const entry of view.topFive) {
    console.log(`  [${entry.state}] ${entry.route.title}`);
    console.log(`     ${entry.route.description}`);
    console.log(
      `     capital at risk ${entry.route.capitalAtRisk}, production stage ${entry.route.stage}` +
        `, ${entry.met.length} of ${entry.route.requires.length} requirement(s) met`,
    );
    console.log(`     NEXT: ${entry.next}`);
  }

  console.log('');
  console.log(`THE WHOLE LEDGER (${view.ledger.length} routes, none ever removed)`);
  for (const entry of view.ledger) {
    console.log(
      `  ${entry.state.padEnd(10)} ${entry.route.id.padEnd(26)} ` +
        `unmet: ${entry.unmet.length === 0 ? 'none' : entry.unmet.join(', ')}`,
    );
  }

  console.log('');
  console.log('BEING MADE NOW');
  if (view.beingMade.openQuestions.length === 0) {
    console.log('  No question is being researched.');
  }
  for (const one of view.beingMade.openQuestions) {
    console.log(`  ${one.purpose} round ${one.round} — ${one.subject}  (${one.roundId})`);
  }
  for (const one of view.beingMade.systemsGenerating) {
    console.log(`  system ${one.title}: ${one.held} validated puzzle(s)  (${one.masterId})`);
  }

  console.log('');
  console.log('LEVERAGE');
  console.log(`  working systems                    ${view.leverage.provenMasters}`);
  console.log(`  validated puzzles                  ${view.leverage.validPuzzles}`);
  console.log(`  qualified outputs                  ${view.leverage.qualifiedOutputs}`);
  console.log(`  refused as reskins                 ${view.leverage.reskins}`);
  reading('master to SKU multiplier', view.leverage.masterToSku);
  reading('setup to unit yield', view.leverage.setupToUnitYield);
  reading('contribution per setup', view.leverage.contributionPerSetup);
  reading('valid puzzles per editorial hour', view.leverage.validPuzzlesPerEditorialHour);

  console.log('');
  console.log('QUALITY');
  reading('validation pass rate', view.quality.passRate, (value) => `${Math.round(value * 100)}%`);
  console.log(`  duplicate puzzles held             ${view.quality.duplicatesHeld}`);
  console.log(`  defects reported                   ${view.quality.defectsReported}`);
  console.log(`  customer complaints                ${view.quality.complaints}`);
  console.log(
    `  formats a person has read          ${
      view.quality.humanEdited.length === 0 ? 'none' : view.quality.humanEdited.join(', ')
    }`,
  );
  for (const one of view.quality.failingChecks) {
    console.log(`  failing check: ${one.name} (${one.count})`);
  }

  console.log('');
  console.log('THE MONEY, AS PUBLISHED');
  if (view.economics.length === 0) {
    console.log('  Nothing has been published about what any of this earns or costs.');
  }
  for (const one of view.economics) {
    console.log(`  ${one.formatKey} as ${one.productClass}`);
    for (const line of one.lines) {
      console.log(
        `     ${line.component.padEnd(22)} ${
          line.lowCents === line.highCents
            ? money(line.lowCents, line.currency)
            : `${money(line.lowCents, line.currency)} to ${money(line.highCents, line.currency)}`
        }  (${line.sources} source${line.sources === 1 ? '' : 's'}, per ${line.basisNotes.join('; ')})`,
      );
    }
    if (one.withheld) {
      console.log(`     CONTRIBUTION WITHHELD: ${one.withheld}`);
    } else {
      console.log(
        `     contribution per unit  ${money(one.contributionPerUnitCents, one.currency)}` +
          (one.breakevenUnits !== null ? `, breakeven at ${one.breakevenUnits} unit(s)` : ''),
      );
    }
  }

  console.log('');
  console.log('THE HUNDRED-PUZZLES-FOR-A-DOLLAR QUESTION');
  console.log(`  ${view.dollarBook.verdict}`);
  for (const one of view.dollarBook.established) console.log(`     established: ${one}`);
  for (const one of view.dollarBook.missing) console.log(`     MISSING: ${one}`);

  console.log('');
  console.log('PHYSICAL PRODUCTION');
  console.log(`  stage ${view.physical.stage} of 5`);
  console.log(`  ${view.physical.reading}`);
  for (const one of view.physical.productionRoutes) {
    console.log(`     ${one.name} (${one.format}) — ${one.terms}`);
  }

  console.log('');
  console.log('MATURITY, PER FORMAT');
  for (const one of view.maturity) {
    console.log(`  ${one.rung.padEnd(18)} ${one.name}`);
    console.log(`     waiting on [${one.remedy}]: ${one.waitingOn}`);
    if (one.limitation) console.log(`     what Brain can say about it: ${one.limitation}`);
  }

  console.log('');
  console.log('WHAT CHANGED');
  if (view.lessons.length === 0) console.log('  Nothing has been attempted yet.');
  for (const one of view.lessons) {
    console.log(
      `  [${one.strength}] ${one.kind} about ${one.subject}: ${one.observations} observation(s)` +
        `, ${one.fromPeople} from a person`,
    );
    for (const statement of one.statements.slice(0, 3)) console.log(`     ${statement}`);
  }

  console.log('');
  console.log('WHAT BRAIN CAN AND CANNOT DO');
  for (const one of view.capabilities.puzzle) {
    console.log(`  ${one.state.padEnd(8)} ${one.id}`);
    console.log(`     ${one.reading}`);
    if (one.nextStep) console.log(`     next: ${one.nextStep}`);
  }
  for (const one of view.capabilities.commercial) {
    console.log(`  ${one.state.padEnd(8)} ${one.id}`);
  }

  console.log('');
  console.log('NEEDS ME');
  if (view.needsPerson.length === 0) {
    console.log('  Nothing. Every open thing is Brain’s or a code change.');
  }
  for (const one of view.needsPerson) {
    console.log(`  ${one.what}`);
    console.log(`     ${one.why}`);
  }

  console.log('');
  console.log('NEXT');
  console.log(`  ${view.nextAction}`);
  console.log('');
}

main()
  .catch((error: unknown) => {
    const refusal = describePoolerRefusal(error);
    console.error('PUZZLE-REPORT: FAILED');
    console.error(refusal ?? (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
  });

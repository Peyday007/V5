/**
 * `npm run report:labor` — who produces the work here, and why it is still a
 * person.
 *
 * Read-only, on purpose and by construction: it opens the database, prints
 * what is there, and closes it. It declares nothing, decides nothing, asks
 * nothing and spends nothing. The one thing it can do to production is read
 * it. `cash-report.ts` is the same shape one axis along, and runs the same way
 * — inside the container, through `flyctl ssh console` — so the answer comes
 * from rows rather than from a screen somebody photographed.
 *
 *   npm run report:labor -- --project prj_xxx
 *   npm run report:labor                      (every project with a labor map)
 *
 * What it prints is §13's six readings in the order the brief asks for them,
 * then §11's measurements with an evidence class on every one. Four of those
 * measurements are `UNKNOWN` and are printed anyway, because an absent line
 * reads as *nothing to say about it* and the honest answer is *this is not
 * measured, and here is what would measure it*. An invented automation
 * percentage is exactly the figure somebody would quote in a decision about
 * whether to keep employing a person, so there is no code path here that can
 * produce one.
 *
 * No credential is read, printed or required.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { listProjects } from '../server/repos/projects.ts';
import { laborView, describeRate } from '../server/services/labor/view.ts';
import { laborSnapshot } from '../server/services/labor/map.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function describeBacking(backing: 'RESEARCH' | 'PERSON' | 'ASSERTED'): string {
  if (backing === 'RESEARCH') return 'a published rule, with the claim on the record';
  if (backing === 'PERSON') return 'somebody’s own answer to the necessity question';
  return 'nothing — the reason is on the allocation and no question behind it is answered';
}

/** One line, never wrapped, never a wall of JSON. */
function trim(value: string | null | undefined, width = 96): string {
  if (!value) return '—';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

async function reportProject(projectId: string, projectName: string): Promise<boolean> {
  const view = await laborView(projectId);
  if (view.tasks === 0 && view.workflows === 0) return false;

  console.log('');
  console.log('='.repeat(100));
  console.log(`LABOR — ${projectName} (${projectId})`);
  console.log('='.repeat(100));
  console.log(`  ${view.summary}`);

  console.log('');
  console.log('HUMAN DEPENDENCIES');
  if (view.humanDependencies.length === 0) {
    console.log('  none recorded — no task here has a person on it');
  }
  for (const one of view.humanDependencies) {
    console.log(`  ${one.path}`);
    console.log(`    produces      ${trim(one.output)}`);
    console.log(`    by            ${one.layer} for ${one.reason}`);
    /*
     * What actually backs it, printed on its own line and in three values.
     *
     * A role on a published rule is a fact about the world. One on somebody's
     * own answer is a judgement that has been recorded. One on nothing is a
     * decision nothing has checked, and it is exactly the kind §7 asks Brain
     * to keep re-examining — so collapsing any two of them would hide the list
     * worth reading.
     */
    console.log(`    backing       ${describeBacking(one.backing)}`);
    console.log(`    sourcing      ${one.sourcingOptions} published option(s) on record`);
    console.log(`    because       ${trim(one.rationale)}`);
  }

  console.log('');
  console.log('AUTOMATION FRONTIER');
  if (view.automationFrontier.length === 0) {
    console.log('  nothing waiting — every task is already produced without a person');
  }
  for (const one of view.automationFrontier) {
    const where = one.layer ?? 'nobody has decided';
    console.log(
      `  ${one.path}  [${where}]  ${one.blockers.length} blocker(s), ` +
        `${one.automatedPrecedents} published software precedent(s)`,
    );
    for (const blocker of one.blockers) {
      console.log(`    ${blocker.kind}  ${trim(blocker.statement, 80)}`);
      console.log(`      → ${trim(blocker.remedy, 88)}`);
    }
  }

  console.log('');
  console.log('BOTTLENECKS');
  if (view.bottlenecks.length === 0) console.log('  none');
  for (const one of view.bottlenecks) {
    console.log(
      `  ${one.kind}  holding ${one.tasks} task(s)` +
        (one.capabilityId ? `  (${one.capabilityId})` : ''),
    );
    console.log(`    → ${trim(one.remedy, 88)}`);
  }

  console.log('');
  console.log('HUMAN CAPACITY NEEDS');
  if (view.capacityNeeds.length === 0) console.log('  none');
  for (const one of view.capacityNeeds) {
    console.log(`  ${one.kind}  ${one.path}`);
    console.log(`    ${trim(one.statement, 92)}`);
  }

  console.log('');
  console.log('ROLE COMPRESSION');
  if (view.roleCompression.length === 0) {
    // Not a failure and not a zero worth alarming about: a map that has never
    // changed hands has nothing to report here, which is the ordinary state of
    // a new one.
    console.log('  nothing has changed hands yet');
  }
  for (const one of view.roleCompression) {
    console.log(
      `  ${one.direction}  ${one.path}  ${one.from} → ${one.to}` +
        (one.wasFor ? `  (was for ${one.wasFor})` : ''),
    );
    console.log(`    at ${one.at}: ${trim(one.rationale, 84)}`);
  }

  console.log('');
  console.log('WORKFLOW ECONOMICS');
  for (const one of view.economics) {
    console.log(
      `  ${trim(one.name, 60)}  tasks=${one.tasks} human=${one.humanTasks} ` +
        `machine=${one.machineTasks} undecided=${one.undecided} ` +
        `compressed=${one.compressedSince}` +
        (one.fullyAutomated ? '  [no person on any decided task]' : ''),
    );
  }

  console.log('');
  console.log('MEASUREMENTS');
  for (const figure of view.measurements) {
    const value = figure.value === null ? 'UNKNOWN' : String(figure.value);
    console.log(
      `  ${figure.evidence.padEnd(8)} ${figure.label}: ${value}` +
        (figure.denominator ? ` ${figure.denominator}` : ''),
    );
    console.log(`    ${trim(figure.note, 92)}`);
  }

  console.log('');
  console.log('WHAT BRAIN WOULD ASK NEXT');
  if (view.nextQuestions.length === 0) console.log('  nothing');
  for (const one of view.nextQuestions) {
    console.log(`  ${one.purpose}  ${one.subject}`);
    console.log(`    ${trim(one.why, 92)}`);
  }
  if (view.declined.length > 0) {
    console.log('  considered and not asked:');
    for (const one of view.declined.slice(0, 12)) {
      console.log(`    ${one.subject}: ${trim(one.why, 80)}`);
    }
  }

  /*
   * The published sourcing options, printed last and in full.
   *
   * Read from the snapshot rather than from the view, because the view carries
   * counts and the thing worth reading here is the rate beside its channel. A
   * channel with no published rate prints as exactly that — never as a blank,
   * and never left out, because an option nobody has costed is still an option
   * and leaving it out would make the cheapest-looking one look like the only
   * one.
   */
  const snapshot = await laborSnapshot(projectId);
  const withOptions = snapshot.coverage.filter((one) => one.options.length > 0);
  if (withOptions.length > 0) {
    console.log('');
    console.log('PUBLISHED SOURCING OPTIONS');
    for (const one of withOptions) {
      console.log(`  ${one.path}`);
      for (const option of one.options) {
        console.log(
          `    ${describeRate(option.rateCents, option.rateBasis, option.channel)}` +
            (option.jurisdiction ? `  in ${option.jurisdiction}` : '  jurisdiction not stated'),
        );
        console.log(`      ${trim(option.statement, 88)}`);
      }
    }
  }

  return true;
}

async function main(): Promise<void> {
  await initDatabase();

  const only = flag('project');
  const projects = await listProjects();
  let found = 0;
  for (const project of projects) {
    if (only && project.id !== only) continue;
    if (await reportProject(project.id, project.name)) found += 1;
  }

  console.log('');
  if (found === 0) {
    // Not a failure: most projects hold no labor map, and saying so is the
    // answer rather than an error.
    console.log('LABOR-REPORT: OK maps=0 — no project here has a labor map yet');
    return;
  }
  console.log(`LABOR-REPORT: OK maps=${found}`);
}

main()
  .catch((error) => {
    console.error('LABOR-REPORT: FAILED', error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());

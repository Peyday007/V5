/**
 * `npm run puzzles -- <command>` — the operator surface for the puzzle
 * products and production kernel.
 *
 * §26's rule about where these live: reaching the shell is the authentication,
 * and a decision a person makes about their own project belongs on the surface
 * they already use. Both are true here, so the split is drawn deliberately.
 *
 * Every operation below exists as a **route** as well, at
 * `/api/projects/:id/puzzles`, behind `requirePerson` and
 * `decideProjectAccess` at ADMIN. **There is no client surface for this kernel
 * yet**, so this file is the door that works today — and it is the same
 * operations against the same services rather than a second, weaker path:
 * every write below calls exactly what the route calls.
 *
 * It follows the rule §23's fleet surface paid for twice: **a command that
 * changes nothing must not print success.** Every mutating command reports
 * whether a row actually changed and exits non-zero when none did.
 *
 * `--admin <email>` is *attribution*, not authentication, and §23 records the
 * difference: it resolves an enabled administrator from `users`, which
 * establishes that such a person exists and may authorize this and nothing
 * about who typed the command.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { getUserByEmail } from '../server/repos/identity.ts';
import { getProjectBySlug, listProjects } from '../server/repos/projects.ts';
import {
  declareEdition,
  declareFormat,
  declareMaster,
} from '../server/services/puzzles/declare.ts';
import { produceBatch } from '../server/services/puzzles/produce.ts';
import { placeInEdition, readEditions } from '../server/services/puzzles/editions.ts';
import { compileEdition } from '../server/services/puzzles/compile.ts';
import { puzzleView } from '../server/services/puzzles/view.ts';
import { runPuzzleKernel } from '../server/services/puzzles/kernel.ts';
import { allSupport, supportFor } from '../server/services/puzzles/registry.ts';
import {
  getEdition,
  getMaster,
  listFormats,
  listInstancesForMaster,
  unblockMaster,
} from '../server/repos/puzzles.ts';
import { supportForGenerator } from '../server/services/puzzles/registry.ts';
import {
  isDistinctnessAxis,
  isProductClass,
  isRightsBasis,
} from '../server/domain/puzzles.ts';

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

function usage(): void {
  out(`
  npm run puzzles -- <command>

  Reading
    report <project>                              the whole kernel, as a person reads it
    formats <project>                             the universe, and what Brain can actually make
    catalog <project>                             every edition and the conditions outstanding
    generators                                    what this repository implements, and nothing else

  Declaring (a person's decisions)
    seed <project> --admin <email>                put the brief's starting universe on the map
    format <project> --name "…" --admin <email>
    master <project> --format <id> --name "…" --generator <key> --spec '<json>'
           --rights PUBLIC_DOMAIN|OWN_WORK|LICENSED|UNESTABLIShED [--statement "…"] --admin <email>
    edition <project> --master <id> --name "…" --class <PRODUCT_CLASS>
           --axis <DISTINCTNESS_AXIS> [--value "…"] --rationale "…" --admin <email>

  Making
    produce <project> --master <id> [--count 10]  generate a batch, checking every one
    fill <project> --edition <id> [--count 10]    put this master's validated puzzles in it
    compile <project> --edition <id>              write the proof sheet, if it qualifies
    tick <project>                                run one kernel pass, as the loop does

  Repairing
    unblock <project> --master <id> --admin <email>
           clears a block only when the generator's version has actually changed
`);
}

/**
 * The brief's starting universe.
 *
 * Seeded deliberately by a person running a command rather than written into
 * the schema, because §41's rule holds here: `SEED` is the one origin Brain
 * may never write, and deciding what this operation makes is a design act. The
 * list is **not** a limit — `PUZZLE_FORMAT` findings put more on the map from
 * evidence, which is the whole reason the universe is rows and the registry is
 * code.
 *
 * Several of these are formats this Brain cannot currently generate, and they
 * are seeded anyway on purpose: a map that held only what Brain can already do
 * could not record the gaps that decide what to build next.
 */
const SEED_UNIVERSE: { name: string; description: string }[] = [
  { name: 'Sudoku', description: 'A 9x9 number-placement grid with exactly one solution.' },
  { name: 'Word Search', description: 'A letter grid hiding a list of words in eight directions.' },
  { name: 'Maze', description: 'A path puzzle from a start to an end through a carved grid.' },
  {
    name: 'Cryptogram',
    description: 'A short text enciphered by a simple letter substitution.',
  },
  {
    name: 'Crossword',
    description:
      'An interlocking word grid with clues. Needs a rights-established lexicon and clue bank.',
  },
  { name: 'Mini Crossword', description: 'A small interlocking word grid, usually 5x5.' },
  { name: 'Nonogram', description: 'A picture-logic grid solved from row and column run lengths.' },
  { name: 'Logic Grid', description: 'A deduction puzzle solved from a set of constraints.' },
  { name: 'Acrostic', description: 'Clue answers whose initials spell a quotation.' },
  { name: 'Cryptic Crossword', description: 'A crossword whose clues are wordplay constructions.' },
  { name: 'Word Fill-In', description: 'A grid filled from a supplied word list without clues.' },
  { name: 'Anagram', description: 'A word or phrase to be rearranged into another.' },
  { name: 'Spot the Difference', description: 'Two near-identical images with planted changes.' },
  { name: 'Hidden Object', description: 'A scene with named objects to be located in it.' },
  { name: 'Jigsaw', description: 'A physical or digital interlocking piece puzzle.' },
  { name: 'Mechanical Puzzle', description: 'A physical object puzzle in wood, metal or plastic.' },
  { name: 'Escape Kit', description: 'A boxed sequence of puzzles forming one narrative.' },
  { name: 'Puzzle Hunt', description: 'A multi-stage competition of linked puzzles.' },
  { name: 'Trivia', description: 'A question-and-answer set, usually themed.' },
  { name: 'Riddle', description: 'A short verbal puzzle with a single intended answer.' },
];

async function resolveProject(slug: string) {
  const project = await getProjectBySlug(slug);
  if (project) return project;
  const all = await listProjects();
  fail(
    `No project with the slug "${slug}". This Brain holds: ` +
      `${all.map((one) => one.slug).join(', ') || '(none)'}.`,
  );
}

async function resolveAdmin(argv: string[]): Promise<string> {
  const email = flag(argv, 'admin');
  if (!email) {
    fail(
      '--admin <email> is required. It is attribution rather than authentication — reaching ' +
        'this shell is what authenticated the call — and an audit row with no author answers ' +
        'nothing later.',
    );
  }
  const user = await getUserByEmail(email);
  if (!user || user.disabledAt) {
    fail(`No enabled administrator with the address ${email}.`);
  }
  if (!user.isBrainAdmin) {
    fail(`${email} is not a Brain administrator, so this decision is not theirs to attribute to.`);
  }
  return user.id;
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  if (!command || command === 'help' || command === '--help') {
    usage();
    return;
  }

  if (command === 'generators') {
    out('\n  What this repository can actually make and check:\n');
    for (const support of allSupport()) {
      out(`  ${support.slug}`);
      out(`    generator  ${support.generatorKey} ${support.generatorVersion}`);
      out(`    validator  ${support.validatorKey} ${support.validatorVersion}`);
      out(`    checks     ${support.requiredChecks.join(', ')}`);
      for (const gap of support.knownGaps) out(`    gap        ${gap}`);
      out();
    }
    out(
      '  Anything not listed is a format this Brain cannot produce, whatever any row says.\n' +
        '  Adding one is a Software Factory change somebody approves, not a row.\n',
    );
    return;
  }

  await initDatabase();

  const slug = argv[1];
  if (!slug) fail('Name a project.');
  const project = await resolveProject(slug);

  switch (command) {
    case 'report': {
      const view = await puzzleView(project.id);
      out(`\n  ${project.name} — puzzle products\n`);
      out(`  RIGHT NOW`);
      out(
        `    ${view.rightNow.formats} format(s), ${view.rightNow.generatableFormats} of which ` +
          `Brain can make`,
      );
      out(
        `    ${view.rightNow.masters} master(s), ${view.rightNow.puzzles} puzzle(s), ` +
          `${view.rightNow.validatedPuzzles} validated`,
      );
      out(
        `    ${view.rightNow.editions} edition(s), ${view.rightNow.qualifiedEditions} ` +
          `qualified, ${view.rightNow.compiledEditions} compiled`,
      );
      out(`    revenue: not readable here — ${view.rightNow.revenue.wouldMeasureIt}`);

      out(`\n  LEVERAGE`);
      out(`    ${view.leverage.summary}`);
      const m = view.leverage.masterToSku;
      out(
        m.value === null
          ? `    master to SKU: not measured — ${'wouldMeasureIt' in m ? m.wouldMeasureIt : ''}`
          : `    master to SKU: ${m.value} (${'denominator' in m ? m.denominator : ''})`,
      );
      out(`    setup to unit yield: not measured here`);
      out(`    contribution per setup: not measured here`);

      out(`\n  QUALITY`);
      out(
        `    validated ${view.quality.validated}, failing ${view.quality.failing}, ` +
          `unproven ${view.quality.unproven}, uncheckable ${view.quality.uncheckable}`,
      );
      out(
        `    pass rate: ${view.quality.passRate === null ? 'nothing checked yet' : view.quality.passRate}`,
      );
      for (const blocked of view.quality.blockedMasters) {
        out(`    BLOCKED ${blocked.name}: ${blocked.reason}`);
      }

      out(`\n  STANDING`);
      for (const one of view.standing) {
        out(`    ${one.name} — ${one.reached}${one.generatable ? '' : ' (no generator)'}`);
        if (one.blocker) out(`        blocked by ${one.blocker}`);
      }

      out(`\n  BEING MADE`);
      for (const one of view.beingMade) {
        out(
          `    ${one.name}: ${one.held} held, ${one.validated} validated — ${one.stock}` +
            `${one.publishable ? '' : ' — rights unestablished, cannot be sold'}`,
        );
      }
      if (view.beingMade.length === 0) out('    nothing — no master is declared');

      out(`\n  RESEARCH`);
      out(`    ${view.research.open.length} open, ${view.research.settled} settled`);
      for (const one of view.research.next) out(`    next: ${one.purpose} on ${one.subject}`);
      for (const one of view.research.declined.slice(0, 3)) {
        out(`    not asked: ${one.subject} — ${one.why}`);
      }

      out(`\n  NEEDS ME`);
      if (view.needsPerson.length === 0) out('    nothing');
      for (const one of view.needsPerson) {
        out(`    ${one.what}`);
        out(`        ${one.why}`);
      }

      out(`\n  NEXT (without anybody)`);
      for (const one of view.next) out(`    ${one}`);
      out();
      return;
    }

    case 'formats': {
      const formats = await listFormats(project.id);
      out(`\n  ${formats.length} format(s) on the map:\n`);
      for (const one of formats) {
        const support = supportFor(one.slug);
        out(
          `  ${one.name}  [${one.origin}]${one.retiredAt ? ' RETIRED' : ''}\n` +
            `    ${one.id}\n` +
            `    ${support ? `generatable by ${support.generatorKey} ${support.generatorVersion}` : 'no generator in this repository'}`,
        );
      }
      out();
      return;
    }

    case 'catalog': {
      const readings = await readEditions(project.id);
      out(`\n  ${readings.length} edition(s):\n`);
      for (const one of readings) {
        out(`  ${one.summary}`);
        for (const condition of one.conditions) {
          if (condition.state === 'MET') continue;
          out(`      ${condition.key} (${condition.state}): ${condition.why}`);
        }
        out();
      }
      return;
    }

    case 'seed': {
      const actorRef = await resolveAdmin(argv);
      let created = 0;
      for (const entry of SEED_UNIVERSE) {
        const result = await declareFormat({
          projectId: project.id,
          name: entry.name,
          description: entry.description,
          actorRef,
        });
        if (result.ok && result.created) created += 1;
      }
      if (created === 0) {
        fail('Every one of those formats was already on the map, so nothing changed.');
      }
      const makeable = SEED_UNIVERSE.filter((one) =>
        allSupport().some((s) => s.slug === one.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')),
      ).length;
      out(
        `\n  ${created} format(s) added. ${makeable} of the ${SEED_UNIVERSE.length} seeded are ` +
          'ones this Brain can currently generate; the rest are on the map because a map that ' +
          'held only what Brain can already do could not record the gaps that decide what to ' +
          'build next.\n',
      );
      return;
    }

    case 'format': {
      const actorRef = await resolveAdmin(argv);
      const name = flag(argv, 'name');
      if (!name) fail('--name "…" is required.');
      const result = await declareFormat({
        projectId: project.id,
        name,
        description: flag(argv, 'description'),
        actorRef,
      });
      if (!result.ok) fail(result.reason);
      if (!result.created) fail(`${result.value.name} was already on the map.`);
      out(`\n  ${result.value.name} — ${result.value.id}\n`);
      return;
    }

    case 'master': {
      const actorRef = await resolveAdmin(argv);
      const formatId = flag(argv, 'format');
      const name = flag(argv, 'name');
      const generatorKey = flag(argv, 'generator');
      const specRaw = flag(argv, 'spec');
      const rights = flag(argv, 'rights');
      if (!formatId || !name || !generatorKey || !specRaw || !rights) {
        fail('--format, --name, --generator, --spec and --rights are all required.');
      }
      if (!isRightsBasis(rights)) fail(`"${rights}" is not a rights basis.`);
      let spec: unknown;
      try {
        spec = JSON.parse(specRaw);
      } catch {
        fail('--spec must be valid JSON.');
      }
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('--spec must be a JSON object.');
      }
      const result = await declareMaster({
        projectId: project.id,
        formatId,
        name,
        generatorKey,
        spec: spec as Record<string, unknown>,
        rightsBasis: rights,
        rightsStatement: flag(argv, 'statement'),
        actorRef,
      });
      if (!result.ok) fail(result.reason);
      if (!result.created) fail(`${result.value.name} already existed.`);
      out(`\n  ${result.value.name} — ${result.value.id}`);
      out(`  ${result.value.generatorKey} ${result.value.generatorVersion}\n`);
      return;
    }

    case 'edition': {
      const actorRef = await resolveAdmin(argv);
      const masterId = flag(argv, 'master');
      const name = flag(argv, 'name');
      const productClass = flag(argv, 'class');
      const axis = flag(argv, 'axis');
      const rationale = flag(argv, 'rationale');
      if (!masterId || !name || !productClass || !axis || !rationale) {
        fail('--master, --name, --class, --axis and --rationale are all required.');
      }
      if (!isProductClass(productClass)) fail(`"${productClass}" is not a product class.`);
      if (!isDistinctnessAxis(axis)) fail(`"${axis}" is not a distinctness axis.`);
      const result = await declareEdition({
        projectId: project.id,
        masterId,
        name,
        productClass,
        distinctnessAxis: axis,
        distinctnessValue: flag(argv, 'value'),
        rationale,
        actorRef,
      });
      if (!result.ok) fail(result.reason);
      if (!result.created) fail(`${result.value.name} already existed.`);
      out(`\n  ${result.value.name} — ${result.value.id}\n`);
      return;
    }

    case 'produce': {
      const masterId = flag(argv, 'master');
      if (!masterId) fail('--master <id> is required.');
      const count = Number(flag(argv, 'count') ?? 10);
      const outcome = await produceBatch({ projectId: project.id, masterId, count });
      if (!outcome.ok) fail(outcome.reason);
      const batch = outcome.value;
      out(`\n  ${batch.created.length} new puzzle(s), every one checked.`);
      if (batch.duplicates > 0) {
        out(`  ${batch.duplicates} attempt(s) re-found a puzzle this master had already made.`);
      }
      for (const one of batch.refused) out(`  refused: ${one.error}`);
      for (const one of batch.failures) out(`  FAILED ${one.check}: ${one.detail ?? ''}`);
      for (const one of batch.unsupported) out(`  UNSUPPORTED ${one.check}`);
      if (batch.blocked) out(`\n  MASTER BLOCKED: ${batch.blocked.reason}`);
      if (batch.created.length === 0 && batch.duplicates === 0) {
        fail('Nothing was produced.');
      }
      out();
      return;
    }

    case 'fill': {
      const editionId = flag(argv, 'edition');
      if (!editionId) fail('--edition <id> is required.');
      const count = Number(flag(argv, 'count') ?? 10);

      // The edition's own master, read from the row rather than guessed: an
      // edition belongs to one master, and `placeInEdition` refuses a puzzle
      // from another one anyway.
      const row = await getEdition(editionId);
      if (!row || row.projectId !== project.id) fail('No edition with that id.');

      const instances = await listInstancesForMaster(row.masterId);
      let placed = 0;
      for (const [index, instance] of instances.slice(0, count).entries()) {
        const result = await placeInEdition({
          projectId: project.id,
          editionId,
          instanceId: instance.id,
          position: index,
        });
        if (!result.ok) fail(result.reason);
        if (result.created) placed += 1;
      }
      if (placed === 0) fail('Nothing new went in.');
      out(`\n  ${placed} puzzle(s) placed.\n`);
      return;
    }

    case 'compile': {
      const editionId = flag(argv, 'edition');
      if (!editionId) fail('--edition <id> is required.');
      const outcome = await compileEdition({ projectId: project.id, editionId });
      if (!outcome.ok) fail(outcome.reason);
      out(`\n  ${outcome.value.puzzles} puzzle(s) compiled.`);
      out(`  key    ${outcome.value.artifactKey}`);
      out(`  sha256 ${outcome.value.artifactHash}`);
      out(`  bytes  ${outcome.value.bytes}`);
      out(
        `\n  This is a proof sheet, not a press-ready artifact. It has no typography, page\n` +
          `  architecture, trim, bleed or imposition, and its first page says so.\n`,
      );
      return;
    }

    case 'tick': {
      const pass = await runPuzzleKernel(project.id);
      const produced = pass.produced.reduce((sum, one) => sum + one.created.length, 0);
      out(`\n  produced ${produced}, opened ${pass.opened.length} question(s)`);
      for (const one of pass.produced) {
        if (one.blocked) out(`  BLOCKED ${one.masterId}: ${one.blocked}`);
      }
      for (const one of pass.opened) out(`  asked: ${one.purpose} — ${one.title}`);
      for (const one of pass.declined.slice(0, 3)) out(`  not asked: ${one.why}`);
      out();
      return;
    }

    case 'unblock': {
      await resolveAdmin(argv);
      const masterId = flag(argv, 'master');
      if (!masterId) fail('--master <id> is required.');
      const master = await getMaster(masterId);
      if (!master || master.projectId !== project.id) fail('No master with that id.');
      if (!master.blockedAt) fail(`${master.name} is not blocked.`);
      const support = supportForGenerator(master.generatorKey);
      if (!support) fail(`No generator named ${master.generatorKey} exists any more.`);
      if (support.generatorVersion === master.generatorVersion) {
        fail(
          `${master.generatorKey} is still at ${support.generatorVersion}, which is the version ` +
            'that produced the wrong puzzles. Unblocking now would be the same code claiming ' +
            'to be different. Repair the generator and bump its version.',
        );
      }
      const cleared = await unblockMaster({
        id: master.id,
        projectId: project.id,
        generatorVersion: support.generatorVersion,
      });
      out(`\n  ${cleared?.name} unblocked at ${support.generatorVersion}.\n`);
      return;
    }

    default:
      fail(`Unknown command "${command}".`);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof ExitSignal)) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} finally {
  await closeDatabase();
}

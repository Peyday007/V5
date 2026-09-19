/**
 * `npm run capability -- <command>` — the operator surface for the kernel.
 *
 * §26's rule about where these live: creating a project, queueing an item and
 * starting a packet by hand are `npm run admin` on a terminal, because reaching
 * the shell is the authentication. Registering a blueprint and advancing its
 * ingestion are the same kind of operation, so they are here rather than on a
 * page.
 *
 * It follows the rule §11's fleet surface paid for twice: **a command that
 * changes nothing must not print success.** Every mutating command below
 * reports whether a row actually changed and exits non-zero when none did.
 */
import fs from 'node:fs';
import path from 'node:path';
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { registerBlueprint, ensureArchitectureScope } from '../server/services/capability/ingest.ts';
import { listLayers } from '../server/repos/layers.ts';
import {
  advanceSources,
  readSource,
  settleAudit,
  settleExtraction,
} from '../server/services/capability/extraction.ts';
import {
  getSource,
  listCandidates,
  listFaculties,
  listRelationships,
  listSources,
  listStateEvents,
} from '../server/repos/faculties.ts';
import { describeFaculty } from '../server/domain/faculties.ts';
import { latestScan, listComponents, scanSystem } from '../server/services/selfmodel/scan.ts';
import { readingStaleness } from '../server/services/selfmodel/refresh.ts';
import { describeComponent, EVIDENCE_LEVELS } from '../server/services/selfmodel/levels.ts';
import {
  currentSections,
  derivePacket,
  facultiesWithoutPackets,
  judgeGap,
  listGaps,
  livePacketFor,
  missingSections,
  openPacket,
  readiness,
} from '../server/services/realize/packet.ts';
import { decisionReadiness, directorPass } from '../server/services/realize/director.ts';
import { GAP_KINDS } from '../server/services/realize/gaps.ts';
import { compile } from '../server/services/realize/compile.ts';
import { handOff } from '../server/services/realize/handoff.ts';
import { applyRealization, readRealization } from '../server/services/realize/realized.ts';
import { askTheWorld, outstandingQuestions } from '../server/services/realize/askTheWorld.ts';

function out(line = ''): void {
  console.log(line);
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exitCode = 1;
  throw new ExitSignal();
}

class ExitSignal extends Error {}

const USAGE = `
  npm run capability -- <command>

  register <file> --title <t> [--amends <sourceId>]   register a blueprint or amendment
  sources                                             every registered source and its state
  advance                                             run one ingestion tick
  read <sourceId>                                     what Brain can see in one source
  candidates [<sourceId>]                             proposed definitions and their verdicts
  faculties                                           the canonical registry, all six dimensions
  history <slug>                                      why each dimension of one faculty moved

  scan [--reason <r>]                                 take a reading of Brain's own parts
  model [--kind <k>] [--level <l>] [--answer <a>]     read the self-model back
  staleness                                           whether the last reading still stands

  packet open <slug>                                  open a realization packet for a faculty
  packet derive <packetId>                            compute the derivable sections and gaps
  packet show <packetId>                              sections, gaps and readiness
  packet research <packetId>                          what it should research next, if anything
  packet compile <packetId>                           the change request it implies
  packets                                             every packet, and faculties with none

  submit <binId> <file.json> --worker <handle>        submit a reading through the worker path
  verdicts <binId> <file.json> --worker <handle>      submit audit verdicts, as a second session

  Both of the last two take a JSON file and hand it to the same service a fired
  Routine reaches through MCP: a real principal, a real check-in, a real lease
  and the real validator. They exist because a reading has to come from a reader
  and Brain must not be the one holding the pen — what they do NOT do is make
  the reader independent, which is a property of who runs them.
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    out(USAGE);
    return;
  }

  // `initDatabase` applies the chain itself, so there is nothing to run here.
  await initDatabase();

  switch (command) {
    case 'register':
      await register(rest);
      break;
    case 'sources':
      await sources();
      break;
    case 'advance':
      await advance();
      break;
    case 'read':
      await read(rest);
      break;
    case 'candidates':
      await candidates(rest);
      break;
    case 'faculties':
      await faculties();
      break;
    case 'history':
      await history(rest);
      break;
    case 'scan':
      await scan(rest);
      break;
    case 'model':
      await model(rest);
      break;
    case 'staleness':
      await staleness();
      break;
    case 'packet':
      await packet(rest);
      break;
    case 'packets':
      await packets();
      break;
    case 'submit':
      await submitReading(rest, 'EXTRACTION');
      break;
    case 'verdicts':
      await submitReading(rest, 'AUDIT');
      break;
    default:
      out(USAGE);
      fail(`Unknown command: ${command}`);
  }
}

function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

/* ------------------------------------------------------------------------- */

async function register(argv: string[]): Promise<void> {
  const file = argv[0];
  if (!file || file.startsWith('--')) fail('Usage: register <file> --title <title> [--amends <id>]');
  const title = flag(argv, 'title');
  if (!title) fail('A source needs a title: --title "Brain Intelligence Map"');
  const amends = flag(argv, 'amends');

  const absolute = path.resolve(file as string);
  if (!fs.existsSync(absolute)) fail(`There is no file at ${absolute}.`);
  const contents = fs.readFileSync(absolute);

  const scope = await ensureArchitectureScope();
  const registered = await registerBlueprint({
    filename: path.basename(absolute),
    contents,
    title: title as string,
    kind: amends ? 'AMENDMENT' : 'BLUEPRINT',
    amendsId: amends,
    origin: `the operator, from ${absolute}`,
    registeredBy: 'operator (shell)',
  });

  out('');
  out(`  ${registered.created ? 'Registered' : 'Already registered'}  ${registered.source.id}`);
  out(`  Kind             ${registered.source.kind} v${registered.source.version}`);
  out(`  Scope            ${scope.slug} (${scope.purpose})`);
  out(`  Document         ${registered.documentId}`);
  out(`  Bytes            ${registered.source.byteSize}`);
  out(`  Hash             ${registered.source.contentHash}`);
  out(`  Extraction       ${registered.extractionStatus ?? 'none'} (${registered.extractionRunId ?? '-'})`);
  if (registered.source.amendsId) out(`  Amends           ${registered.source.amendsId}`);
  for (const problem of registered.problems) out(`  PROBLEM          ${problem}`);
  out('');

  if (!registered.created) {
    // A command that changed nothing must not print success.
    fail('These exact bytes were already registered, so nothing changed.');
  }
}

async function sources(): Promise<void> {
  const rows = await listSources();
  out('');
  if (rows.length === 0) out('  No source has been registered.');
  for (const row of rows) {
    out(`  ${row.id}  ${row.ingestState.padEnd(10)} ${row.kind.padEnd(9)} v${row.version}  ${row.title}`);
    if (row.amendsId) out(`      amends ${row.amendsId}`);
    if (row.binId) out(`      bin    ${row.binId}`);
    if (row.ingestDetail) out(`      ${row.ingestDetail}`);
  }
  out('');
}

async function advance(): Promise<void> {
  const report = await advanceSources();
  out('');
  out(`  dispatched ${report.dispatched}  settled ${report.settled}  audited ${report.audited}  ` +
      `promoted ${report.promoted}  recovered ${report.recovered}`);
  out('');
  const moved =
    report.dispatched + report.settled + report.audited + report.promoted + report.recovered;
  if (moved === 0) fail('Nothing moved. Every source is waiting on a worker or is terminal.');
}

async function read(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) fail('Usage: read <sourceId>');
  const reading = await readSource(id as string);
  if (!reading) fail(`No such source: ${id}`);
  out('');
  out(`  ${reading.source.title}  (${reading.source.ingestState})`);
  if (reading.unreadable) {
    out(`  UNREADABLE  ${reading.unreadable}`);
    out('');
    return;
  }
  out(`  ${reading.sections.length} section(s) Brain can declare a unit for:`);
  for (const section of reading.sections) {
    out(`    ${(section.number ?? '-').padEnd(6)} ${section.kind.padEnd(17)} ${section.title}`);
  }
  if (reading.skipped.length > 0) {
    out(`  Skipped (numbered, but under another chapter):`);
    for (const skipped of reading.skipped) out(`    ${skipped}`);
  }
  out('');
}

async function candidates(argv: string[]): Promise<void> {
  const rows = await listCandidates(argv[0] ? { sourceId: argv[0] } : {});
  out('');
  if (rows.length === 0) out('  No candidate has been proposed.');
  for (const row of rows) {
    out(`  ${row.state.padEnd(10)} ${String(row.ordinal ?? '-').padStart(3)}  ${row.canonicalName}`);
    out(`      slug ${row.slug}  page ${row.evidencePage ?? '-'}  block ${row.evidenceBlockId ?? '-'}`);
    if (row.rejectionReason) out(`      ${row.rejectionReason}`);
  }
  out('');
}

async function faculties(): Promise<void> {
  const rows = await listFaculties();
  out('');
  if (rows.length === 0) {
    out('  The registry is empty. Nothing has been promoted.');
    out('');
    return;
  }
  for (const row of rows) {
    out(`  ${String(row.ordinal ?? '-').padStart(3)}  ${row.canonicalName}`);
    out(`       ${describeFaculty(row)}`);
  }
  const edges = await listRelationships();
  out('');
  out(`  ${edges.length} recorded relationship(s).`);
  out('');
}

async function history(argv: string[]): Promise<void> {
  const slug = argv[0];
  if (!slug) fail('Usage: history <slug>');
  const faculty = (await listFaculties()).find((row) => row.slug === slug);
  if (!faculty) fail(`No canonical faculty with slug ${slug}.`);
  const events = await listStateEvents((faculty as NonNullable<typeof faculty>).id);
  out('');
  for (const event of events) {
    out(`  ${event.createdAt}  ${event.dimension}  ${event.fromState} -> ${event.toState}`);
    out(`      ${event.reason}`);
    if (event.evidenceRef) out(`      evidence ${event.evidenceRef}`);
  }
  out('');
}

/* ------------------------------------------------------------------------- */

async function scan(argv: string[]): Promise<void> {
  const reason = (flag(argv, 'reason') ?? 'REQUESTED') as Parameters<typeof scanSystem>[0];
  const report = await scanSystem(reason);
  out('');
  out(`  ${report.components} component(s) read, ${report.drift.length} level(s) moved.`);
  out(`  Revision  ${report.revision ?? 'unstamped'}`);
  for (const move of report.drift.slice(0, 30)) {
    out(`    ${move.componentKey}  ${move.level}  ${move.from} -> ${move.to}`);
  }
  if (report.drift.length > 30) out(`    … and ${report.drift.length - 30} more`);
  if (report.unreadable.length > 0) {
    out('  Could not read:');
    for (const line of report.unreadable) out(`    ${line}`);
  }
  out('');
}

async function model(argv: string[]): Promise<void> {
  const rows = await listComponents({
    kind: (flag(argv, 'kind') ?? undefined) as never,
    level: (flag(argv, 'level') ?? undefined) as never,
    answer: (flag(argv, 'answer') ?? undefined) as never,
  });
  out('');
  out(`  ${rows.length} component(s).`);
  const byKind = new Map<string, number>();
  for (const row of rows) byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
  for (const [kind, count] of [...byKind].sort()) out(`    ${String(count).padStart(5)}  ${kind}`);
  out('');
  for (const row of rows.slice(0, 40)) {
    out(`  ${row.componentKey}`);
    out(`      ${EVIDENCE_LEVELS.map((level) => `${level}=${row.answers[level]}`).join(' ')}`);
  }
  if (rows.length > 40) out(`  … and ${rows.length - 40} more`);
  out('');
}

async function staleness(): Promise<void> {
  const last = await latestScan();
  const verdict = await readingStaleness();
  out('');
  out(`  Last reading  ${last ? `${last.scanId} at ${last.startedAt} (${last.reason})` : 'none'}`);
  out(`  Stale         ${verdict.stale ? 'YES' : 'no'}  ${verdict.detail ?? ''}`);
  out('');
}

/* ------------------------------------------------------------------------- */

async function packet(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'open': {
      const slug = rest[0];
      if (!slug) fail('Usage: packet open <slug>');
      const faculty = (await listFaculties()).find((row) => row.slug === slug);
      if (!faculty) fail(`No canonical faculty with slug ${slug}.`);
      const opened = await openPacket({
        facultyId: (faculty as NonNullable<typeof faculty>).id,
        createdByType: 'PERSON',
        createdById: 'operator (shell)',
      });
      out('');
      out(`  ${opened.created ? 'Opened' : 'Already open'}  ${opened.packet.id}  (${opened.packet.state})`);
      out('');
      if (!opened.created) fail('A live packet already existed, so nothing changed.');
      break;
    }
    case 'derive': {
      const id = rest[0];
      if (!id) fail('Usage: packet derive <packetId>');
      const report = await derivePacket(id as string);
      out('');
      out(`  Reading   ${report.scanId}`);
      out(`  Gaps      ${report.gaps}`);
      for (const [kind, count] of Object.entries(report.summary.byKind)) {
        if (count > 0) out(`    ${String(count).padStart(4)}  ${kind}`);
      }
      out(`  Written   ${report.sectionsWritten.join(', ')}`);
      out(`  Still to be written by a reader:`);
      for (const section of report.stillMissing) out(`    ${section}`);
      out('');
      break;
    }
    case 'show': {
      const id = rest[0];
      if (!id) fail('Usage: packet show <packetId>');
      const sections = await currentSections(id as string);
      const gaps = await listGaps(id as string);
      const verdict = await readiness(id as string);
      out('');
      out('  Sections');
      for (const section of sections) {
        out(`    ${section.section.padEnd(24)} v${section.version}  ${section.authorKind}`);
      }
      for (const missing of await missingSections(id as string)) {
        out(`    ${missing.padEnd(24)} —   absent`);
      }
      out('');
      out('  Gaps');
      for (const gap of gaps) {
        out(`    ${gap.id}`);
        out(`      ${gap.state.padEnd(9)} ${gap.kind.padEnd(26)} ${gap.derivedBy.padEnd(7)} ${gap.aspect}`);
        out(`        ${gap.requirement}`);
        if (gap.componentKey) out(`        against ${gap.componentKey}`);
      }
      out('');
      out(`  Ready: ${verdict.ready ? 'YES' : 'no'}`);
      for (const condition of verdict.conditions) {
        out(`    ${condition.holds ? 'ok  ' : 'NO  '}${condition.condition}`);
        if (!condition.holds) out(`        ${condition.detail}`);
      }
      out('');
      break;
    }
    case 'research': {
      const id = rest[0];
      if (!id) fail('Usage: packet research <packetId> [--project <id> --layer <id>]');
      /*
       * The architecture scope by default, because that is the archive a
       * capability question is asked against — and naming it every time would
       * be asking an operator to know an id Brain assigned itself. A caller may
       * still name another project, which is how the same question is asked
       * against a different archive.
       */
      const scope = await ensureArchitectureScope();
      const layers = await listLayers(scope.id);
      const projectId = flag(rest, 'project') ?? scope.id;
      const layerId = flag(rest, 'layer') ?? layers[0]?.id ?? null;
      if (!layerId) fail('That project has no layer for the work to file under.');
      const pass = await directorPass({
        packetId: id as string,
        projectId,
        layerId: layerId as string,
      });
      const stop = await decisionReadiness(id as string);
      out('');
      out(`  ${pass.explanation}`);
      out(`  Researchable ${pass.researchable}  already answered ${pass.alreadyAnswered}  ` +
          `questions ${pass.questions.length}`);
      for (const question of pass.questions) {
        out(`    ${question.key}`);
        out(`        ${question.statement}`);
      }
      if (pass.notResearch.length > 0) {
        out('  Real gaps that are not research:');
        for (const entry of pass.notResearch) out(`    ${entry.kind.padEnd(26)} needs ${entry.remedy}`);
      }
      out('');
      out(`  Decision-ready: ${stop.decisionReady ? 'YES' : 'no'}`);
      out(`  ${stop.reason}`);
      for (const line of stop.unresolved.slice(0, 20)) out(`    ${line}`);
      out('');
      break;
    }
    case 'compile': {
      const id = rest[0];
      if (!id) fail('Usage: packet compile <packetId> [--project <id>]');
      const scope = await ensureArchitectureScope();
      const outcome = await compile({
        packetId: id as string,
        projectId: flag(rest, 'project') ?? scope.id,
      });
      out('');
      if (!outcome.ok) {
        out(`  Refused: ${outcome.reason}`);
        for (const line of outcome.unresolved) out(`    ${line}`);
        out('');
        fail('Nothing was compiled.');
      }
      out(`  Objective`);
      out(`    ${outcome.compiled.submission.objective}`);
      out(`  Expected outcome`);
      out(`    ${outcome.compiled.submission.expectedOutcome}`);
      out(`  Acceptance conditions`);
      for (const entry of outcome.compiled.provenance) out(`    ${entry.condition}`);
      out(`  Non-goals`);
      for (const line of outcome.compiled.submission.nonGoals ?? []) out(`    ${line}`);
      out('');
      out('  This is a submission. Approving it and starting a campaign is a person\'s decision,');
      out('  through the same `approveAndStartCampaign` every other entrance uses.');
      out('');
      break;
    }
    case 'judge': {
      /*
       * The reading a packet waits for, and the thing nothing could record.
       *
       * `judgeGap` existed, was exercised by four suites and had **no
       * production caller** — so `NEEDS_A_READING` was a state a packet could
       * enter and never leave. Everything downstream is guarded on it:
       * `readiness` refuses while one is open, `decisionReadiness` refuses,
       * `compile` refuses, `handOff` refuses, and the implementation reading
       * refuses. So every packet in production was permanently stuck, and the
       * kernel's own record of a reader classifying twenty-five gaps was done
       * through something that is not a shipped surface.
       *
       * It belongs on a terminal for §26's reason: reaching the shell is the
       * authentication, and `--admin` is the attribution. A reader may answer
       * any kind — `DERIVABLE` bounds what *Brain* may derive by itself, and
       * `NEEDS_JUDGEMENT` is precisely the set a person is here to supply — so
       * the constraint is not on the answer but on who it is recorded as.
       * `derivedBy` is always PERSON, and there is no flag that changes it.
       */
      const gapId = rest[0];
      const kind = flag(rest, 'kind');
      const evidence = flag(rest, 'evidence');
      if (!gapId || !kind || !evidence) {
        fail(
          'Usage: packet judge <gapId> --kind <kind> --evidence "what you compared" ' +
            '[--component <componentKey>]\n  kinds: ' +
            GAP_KINDS.join(', '),
        );
      }
      if (!(GAP_KINDS as readonly string[]).includes(kind as string)) {
        fail(`Not a gap kind: ${kind}. One of: ${GAP_KINDS.join(', ')}`);
      }
      await judgeGap({
        gapId: gapId as string,
        kind: kind as (typeof GAP_KINDS)[number],
        evidence: evidence as string,
        componentKey: flag(rest, 'component'),
        derivedBy: 'PERSON',
      });
      out('');
      out(`  ${gapId} is ${kind}, on a person's reading.`);
      out('  Nothing else moved. What this unblocks is whatever was waiting on the reading:');
      out('  `packet show` for the stopping condition, `packet realize` for the dimensions.');
      out('');
      break;
    }
    case 'ask': {
      const id = rest[0];
      if (!id) fail('Usage: packet ask <packetId> [--project <id> --layer <id>]');
      const scope = await ensureArchitectureScope();
      const layers = await listLayers(scope.id);
      const layerId = flag(rest, 'layer') ?? layers[0]?.id ?? null;
      if (!layerId) fail('That project has no layer for the work to file under.');
      const outcome = await askTheWorld({
        packetId: id as string,
        projectId: flag(rest, 'project') ?? scope.id,
        layerId,
      });
      out('');
      out(`  ${outcome.explanation}`);
      out(`  Already answered by the archive: ${outcome.alreadyAnswered}`);
      out(`  Asked: ${outcome.asked.length}`);
      for (const row of outcome.asked) {
        out(`    ${row.question.aspect.padEnd(24)} ${row.candidateId ?? 'not captured'}`);
        out(`      ${row.reason}`);
      }
      if (outcome.notResearch.length > 0) {
        out('');
        out(`  ${outcome.notResearch.length} gap(s) are real and are not research:`);
        for (const row of outcome.notResearch) out(`    ${row.kind.padEnd(28)} ${row.remedy}`);
      }
      out('');
      out('  Nothing was launched, approved or spent. Each of these is an idea, and whether');
      out('  it becomes a mission is the standing authority\'s decision on the same path');
      out('  every other idea takes.');
      out('');
      break;
    }
    case 'outstanding': {
      const id = rest[0];
      if (!id) fail('Usage: packet outstanding <packetId>');
      const rows = await outstandingQuestions(id as string);
      out('');
      if (rows.length === 0) out('  Nothing is out with the world for this packet.');
      for (const row of rows) {
        out(`  ${row.candidateId}  ${row.requirement}`);
        out(`    ${row.reason}`);
      }
      out('');
      break;
    }
    case 'handoff': {
      const id = rest[0];
      if (!id) fail('Usage: packet handoff <packetId> [--project <id>] [--remote <url>]');
      const scope = await ensureArchitectureScope();
      const outcome = await handOff({
        packetId: id as string,
        projectId: flag(rest, 'project') ?? scope.id,
        repositoryRemote: flag(rest, 'remote') ?? undefined,
        baseBranch: flag(rest, 'base') ?? undefined,
      });
      out('');
      if (!outcome.ok) {
        out(`  Refused: ${outcome.reason}`);
        for (const line of outcome.unresolved) out(`    ${line}`);
        out('');
        fail('Nothing was handed off.');
      }
      out(`  Change request  ${outcome.changeRequest.id}`);
      out(`  State           ${outcome.changeRequest.state}`);
      out(`  ${outcome.created ? 'Recorded now.' : 'This ask already existed; the packet points at it.'}`);
      out(`  Objective`);
      out(`    ${outcome.compiled.submission.objective}`);
      out(`  Acceptance conditions`);
      for (const entry of outcome.compiled.provenance) {
        out(`    ${entry.condition}`);
        out(`      from gap ${entry.gapId} (${entry.aspect})`);
      }
      out('');
      out('  Nothing has started. Approving this and starting a campaign is a person\'s');
      out('  decision, through the same approve-and-start every other entrance uses.');
      out('');
      break;
    }
    case 'realize': {
      const id = rest[0];
      if (!id) fail('Usage: packet realize <packetId> [--apply]');
      const reading = await readRealization(id as string);
      out('');
      out(`  ${reading.facultySlug}`);
      for (const row of reading.readings) {
        out(`    ${row.dimension.padEnd(16)} ${row.to ?? 'no reading'}`);
        out(`      ${row.reason}`);
        for (const line of row.basis) out(`      - ${line}`);
        if (row.withheld) out(`      withheld: ${row.withheld}`);
      }
      if (rest.includes('--apply')) {
        const applied = await applyRealization({
          packetId: id as string,
          actorType: 'OPERATOR',
          actorId: flag(rest, 'admin'),
        });
        out('');
        for (const row of applied.moved) out(`  moved ${row.dimension} -> ${row.to}`);
        for (const row of applied.unchanged) out(`  kept  ${row.dimension}: ${row.why}`);
        if (applied.moved.length === 0) {
          out('');
          fail('Nothing moved.');
        }
      } else {
        out('');
        out('  Reading only. Pass --apply to record the moves this supports.');
      }
      out('');
      break;
    }
    default:
      fail('Usage: packet <open|derive|show|judge|research|compile|ask|outstanding|handoff|realize> …');
  }
}

async function packets(): Promise<void> {
  out('');
  for (const faculty of await listFaculties()) {
    const live = await livePacketFor(faculty.id);
    out(`  ${faculty.slug.padEnd(40)} ${live ? `${live.id} (${live.state})` : 'no packet'}`);
  }
  const without = await facultiesWithoutPackets();
  out('');
  out(`  ${without.length} canonical faculty/ies have no live packet.`);
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


/* ------------------------------------------------------------------------- */
/* Handing a reading to Brain the way a worker does                           */
/* ------------------------------------------------------------------------- */

/**
 * Submit a file of unit answers through the real worker path.
 *
 * Not a shortcut into the repository: it builds a `WORKER` principal, calls
 * `checkIn`, takes the lease the assigner gives it and submits through
 * `submitUnit` — so the routing scope, the family filter, the independence
 * admission and the manifest's own declared-unit check all run exactly as they
 * do for a fired Routine. A unit key Brain never declared is refused here for
 * the same reason it is refused there.
 *
 * What it does **not** do is make the reader independent. Who runs this decides
 * that, and the independence guard decides whether it counts — which is why the
 * worker handle is an argument rather than a constant: an extraction and its
 * audit have to be run under different ones, and the guard refuses them if they
 * are not.
 */
async function submitReading(argv: string[], phase: 'EXTRACTION' | 'AUDIT'): Promise<void> {
  const binId = argv[0];
  const file = argv[1];
  const handle = flag(argv, 'worker');
  if (!binId || !file || !handle) {
    fail(`Usage: ${phase === 'AUDIT' ? 'verdicts' : 'submit'} <binId> <file.json> --worker <handle>`);
  }

  const absolute = path.resolve(file as string);
  if (!fs.existsSync(absolute)) fail(`There is no file at ${absolute}.`);
  const answers = JSON.parse(fs.readFileSync(absolute, 'utf8')) as Record<string, unknown>;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    fail('The file must be a JSON object mapping unit keys to answers.');
  }

  const { getBin: readBin } = await import('../server/repos/bins.ts');
  const bin = await readBin(binId as string);
  if (!bin) fail(`No such bin: ${binId}`);

  const { ensureReaderWorker } = await import('../server/services/capability/reader.ts');
  const { principal, workerId, sessionRef } = await ensureReaderWorker({
    handle: handle as string,
    projectId: (bin as NonNullable<typeof bin>).projectId,
  });

  const { checkIn, submitUnit, requestCompletion } = await import('../server/services/bins/service.ts');
  const arrival = await checkIn({ principal, workerId, sessionRef });
  if (!arrival.assigned) {
    fail(
      `Nothing was assigned: ${arrival.reason}. That is the assigner's answer, not a failure of ` +
        'this command — an audit bin is refused to the session that produced the reading.',
    );
  }
  if (arrival.assignment.binId !== binId) {
    fail(
      `The assigner handed over ${arrival.assignment.binId} rather than ${binId}. It chooses; ` +
        'a caller that could name its own bin would be steering itself.',
    );
  }

  const proof = {
    binId: arrival.assignment.binId,
    leaseId: arrival.assignment.leaseId,
    leaseGeneration: arrival.assignment.leaseGeneration,
    workerId,
  };

  let stored = 0;
  const refused: string[] = [];
  for (const [unitKey, value] of Object.entries(answers)) {
    const result = await submitUnit({
      workerId,
      proof,
      unitKey,
      value: JSON.stringify(value),
    });
    if (!result.held) fail('The lease was lost while submitting.');
    if (result.stored) stored += 1;
    else refused.push(`${unitKey}${result.unknownUnit ? ' (not a declared unit)' : ''}`);
  }

  const completion = await requestCompletion({ workerId, proof });
  out('');
  out(`  Worker     ${handle} (${workerId})`);
  out(`  Session    ${sessionRef}`);
  out(`  Stored     ${stored} of ${Object.keys(answers).length}`);
  if (refused.length > 0) out(`  Refused    ${refused.join(', ')}`);
  out(`  Contract   ${completion.verdict?.satisfied ? 'satisfied' : 'not satisfied'}`);
  out(`  Bin        ${completion.terminal ? (completion.state ?? 'terminal') : 'still open'}`);
  for (const reason of completion.verdict?.reasons ?? []) out(`    ${reason}`);
  out('');
  if (stored === 0) fail('Nothing was stored.');
}

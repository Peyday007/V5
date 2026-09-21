/**
 * The design kernel's operator surface, on a terminal.
 *
 * ---------------------------------------------------------------------------
 * Why a terminal and not a page
 * ---------------------------------------------------------------------------
 *
 * §26 deleted a whole console over this and the reasoning holds here: **a
 * decision a person makes about their own project belongs on the surface they
 * already use; everything else is internal machinery that should never have had
 * a page.** Running a render, reading the self-model and asking what the
 * expansion loop would do next are all machinery — and the one thing here that
 * *is* a person's decision, recording a correction, is deliberately also
 * available as a decision rather than a form.
 *
 * Reaching the shell is the authentication, which is the same reasoning
 * `verify-hosted.ts` and `npm run admin` already run on.
 *
 * ---------------------------------------------------------------------------
 * This is where rendering lives
 * ---------------------------------------------------------------------------
 *
 * A capture needs a headless browser and a running product. The deployed Brain
 * has neither and must not acquire either, so the operating loop starts here:
 * `cycle` builds the client, boots a server against a throwaway data directory,
 * signs in, renders, measures, repairs within its bounds, renders again and
 * closes with a reason. `resume` does the same for a cycle the Factory opened
 * when a change landed, and `render` answers a `DESIGN_RENDER_V1` bin for a
 * deployed Brain that has no browser of its own — the route that carries a
 * picture from a machine that can take one to the Brain that asked for it.
 *
 *   npx tsx scripts/design.ts surfaces
 *   npx tsx scripts/design.ts capabilities
 *   npx tsx scripts/design.ts next
 *   npx tsx scripts/design.ts expand
 *   npx tsx scripts/design.ts cycle --surfaces russell/default,build/default
 *   npx tsx scripts/design.ts resume <cycleId>
 *   npx tsx scripts/design.ts render --surfaces russell/default --pass 0
 *   npx tsx scripts/design.ts findings [--cycle <id>]
 *   npx tsx scripts/design.ts impact --paths a,b --says "..."
 *   npx tsx scripts/design.ts route --paths a,b --says "..." --revision <sha>
 *   npx tsx scripts/design.ts correction --admin you@example.com --says "..."
 *   npx tsx scripts/design.ts report
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { pickPort } from '../tests/helpers/ports.ts';

import type { CycleResult } from '../server/services/design/operate.ts';

/*
 * Every server module is loaded **after** the data directory is decided.
 *
 * `server/env.ts` resolves `DATA_ROOT` and `DB_PATH` once, at import time, from
 * the environment as it stands then. A static import here would therefore freeze
 * them to the repository's own database before `withServer` has created the
 * throwaway one — and the run would boot a server against a temporary directory
 * and then write its captures, cycles and findings into the real Brain, which is
 * exactly the confusion a throwaway directory exists to prevent. It is a
 * one-line mistake with no symptom until somebody reads the wrong rows.
 *
 * So the loading is deferred and `load()` is the single place it happens.
 */
type ServerModules = {
  db: typeof import('../server/db/database.ts');
  repo: typeof import('../server/repos/design.ts');
  capabilities: typeof import('../server/services/design/capabilities.ts');
  capture: typeof import('../server/services/design/capture.ts');
  corrections: typeof import('../server/services/design/corrections.ts');
  impact: typeof import('../server/services/design/impact.ts');
  kernel: typeof import('../server/services/design/kernel.ts');
  runtime: typeof import('../server/services/design/renderRuntime.ts');
  route: typeof import('../server/services/design/route.ts');
  expand: typeof import('../server/services/design/expand.ts');
  operate: typeof import('../server/services/design/operate.ts');
  priority: typeof import('../server/services/design/priority.ts');
  surfaces: typeof import('../server/services/design/surfaces.ts');
};

let loaded: ServerModules | null = null;

async function load(): Promise<ServerModules> {
  if (loaded) return loaded;
  loaded = {
    db: await import('../server/db/database.ts'),
    repo: await import('../server/repos/design.ts'),
    capabilities: await import('../server/services/design/capabilities.ts'),
    capture: await import('../server/services/design/capture.ts'),
    corrections: await import('../server/services/design/corrections.ts'),
    impact: await import('../server/services/design/impact.ts'),
    kernel: await import('../server/services/design/kernel.ts'),
    runtime: await import('../server/services/design/renderRuntime.ts'),
    route: await import('../server/services/design/route.ts'),
    expand: await import('../server/services/design/expand.ts'),
    operate: await import('../server/services/design/operate.ts'),
    priority: await import('../server/services/design/priority.ts'),
    surfaces: await import('../server/services/design/surfaces.ts'),
  };
  return loaded;
}

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * A range no suite holds, through the helper every suite uses.
 *
 * `deploymentOwnership` refuses two suites that share a range, and the reason it
 * exists applies here too even though this is a script: `/healthz` is
 * unauthenticated, so a collision does not fail loudly — the readiness probe
 * finds somebody else's server, waits happily for it, and then signs in against
 * a Brain with a different bootstrap administrator, which reports 401 and reads
 * as a broken sign-in. The first version of this line sat on 6800, which
 * `cashHttp` and `cashCurrencyHttp` already hold between them.
 *
 * The helper also keeps it off the WHATWG bad-port list, which is the other way
 * this has been got wrong: Node's `fetch` refuses such a port before it opens a
 * socket, so the server boots, answers nothing the caller can see, and the run
 * reports the product broken.
 */
const PORT = pickPort(7600, 120);
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = 'design-kernel@example.invalid';
const BOOTSTRAP = 'bootstrap-password-01';
const PASSWORD = 'design-kernel-password-01';

function fail(message: string): never {
  console.error(`DESIGN: ${message}`);
  process.exit(1);
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    fail(
      'Usage: design <seed|surfaces|capabilities|next|expand|cycle|resume|render|findings|' +
        'impact|correction|report>',
    );
  }

  /*
   * The rendering commands run against their own server and their own database,
   * so they open the repository's one only after that server has closed. Every
   * other command reads the ordinary database.
   */
  const rendering = command === 'cycle' || command === 'resume' || command === 'render';
  if (!rendering) {
    const { db } = await load();
    await db.initDatabase();
  }

  try {
    switch (command) {
      case 'seed': {
        const { kernel } = await load();
        const seeded = await kernel.seedDesignKernel();
        console.log(
          `Seeded ${seeded.surfaces} surface(s), ${seeded.patterns} pattern(s) and ` +
            `${seeded.capabilities} declared capability(ies).`,
        );
        break;
      }
      case 'surfaces':
        await printSurfaces();
        break;
      case 'capabilities':
        await printCapabilities();
        break;
      case 'next':
        await printNext();
        break;
      case 'expand':
        await runExpand();
        break;
      case 'findings':
        await printFindings(flag(rest, 'cycle'));
        break;
      case 'impact':
        await printImpact(rest);
        break;
      case 'route':
        await routeLandedChange(rest);
        break;
      case 'correction':
        await recordCorrectionFromTerminal(rest);
        break;
      case 'report':
        await printReport();
        break;
      case 'cycle':
        await withServer(async (cookie, outputDir) => {
          const { operate } = await load();
          return operate.runDesignCycle({
            triggerKind: 'OWNER_REQUEST',
            triggerRef: null,
            surfaceKeys: (flag(rest, 'surfaces') ?? '').split(',').filter(Boolean),
            baseUrl: BASE,
            cookie: parseCookie(cookie),
            outputDir,
            satisfied: ['SIGNED_IN', 'BRAIN_ADMINISTRATOR', 'PROJECT_EXISTS'],
            maxPasses: Number(flag(rest, 'passes') ?? 2),
          });
        });
        break;
      case 'resume': {
        const id = rest[0];
        if (!id) fail('Usage: design resume <cycleId>');
        await withServer(async (cookie, outputDir) => {
          const { repo, operate } = await load();
          const cycle = await repo.getCycle(id);
          if (!cycle) fail(`No cycle ${id}.`);
          if (cycle.state !== 'OPEN') fail(`Cycle ${id} is ${cycle.state}, so there is nothing to resume.`);
          return operate.resumeDesignCycle(cycle, {
            baseUrl: BASE,
            cookie: parseCookie(cookie),
            outputDir,
            satisfied: ['SIGNED_IN', 'BRAIN_ADMINISTRATOR', 'PROJECT_EXISTS'],
            maxPasses: Number(flag(rest, 'passes') ?? 2),
          });
        });
        break;
      }
      case 'render':
        await renderForBin(rest);
        break;
      default:
        fail(`Unknown command "${command}".`);
    }
  } finally {
    if (!rendering) {
      const { db } = await load();
      await db.closeDatabase();
    }
  }
}

/* =========================================================================
 * Reading
 * ====================================================================== */

async function printSurfaces(): Promise<void> {
  const { repo, priority } = await load();
  const surfaces = await repo.listSurfaces();
  if (surfaces.length === 0) {
    console.log('No design surface is registered. `design seed` writes the seed set.');
    return;
  }
  const ranked = await priority.rankSurfaces(surfaces);
  console.log('WHAT CAN BE LOOKED AT, IN THE ORDER IT IS WORTH LOOKING AT');
  console.log('');
  for (const entry of ranked) {
    console.log(`  ${String(entry.rank).padStart(2)}. ${entry.surface.surfaceKey}  ${entry.surface.route}`);
    console.log(`      ${entry.surface.title}`);
    console.log(`      about: ${entry.surface.concepts.join(', ')}`);
    console.log(`      because ${entry.because}`);
    console.log('');
  }
}

async function printCapabilities(): Promise<void> {
  const { repo, capabilities: caps, priority } = await load();
  const refreshed = await caps.refreshCapabilities('OPERATOR');
  const capabilities = await repo.listCapabilities();
  console.log('WHAT THE DESIGN KERNEL CAN AND CANNOT DO');
  console.log('');
  for (const capability of capabilities) {
    console.log(`  ${capability.capabilityKey}`);
    console.log(`      ${capability.title}`);
    console.log(
      `      ${capability.abilityState} / ${capability.evidenceState}` +
        `   [${capability.primitive}]`,
    );
    console.log(`      ${caps.describeCapability(capability)}`);
    console.log('');
  }
  if (refreshed.moved.length > 0) {
    console.log('  Moved on this reading:');
    for (const move of refreshed.moved) {
      console.log(`    ${move.capabilityKey} ${move.dimension}: ${move.from} -> ${move.to}`);
    }
    console.log('');
  }
  /*
   * The two readings that decide whether either loop can run right now, printed
   * whichever way they came out. A surface that says only what is *available*
   * teaches a reader to assume the rest is fine.
   */
  const availability = await priority.runtimeAvailability();
  console.log(`  Can render here: ${availability.canRender ? 'yes' : 'no'}`);
  console.log(`  Can send a judgement to the fleet: ${availability.canJudge ? 'yes' : 'no'}`);
  for (const reason of availability.reasons) console.log(`    ${reason.lane}: ${reason.reason}`);
}

async function printNext(): Promise<void> {
  const { expand } = await load();
  const preview = await expand.previewExpansion();
  console.log('WHAT THE EXPANSION LOOP WOULD DO NEXT — reading only; nothing is created');
  console.log('');
  for (const entry of preview.ranked.slice(0, 10)) {
    console.log(
      `  ${String(entry.rank).padStart(2)}. ${entry.capability.capabilityKey} ` +
        `(${entry.capability.abilityState}/${entry.capability.evidenceState})`,
    );
    console.log(`      ${entry.because}`);
  }
  console.log('');
  if (preview.wouldOpen.length === 0) {
    console.log('  It would open nothing. Every capability is either already proven or has had no demand.');
  } else {
    console.log('  It would open:');
    for (const entry of preview.wouldOpen) {
      console.log(`    ${entry.capabilityKey} -> ${entry.route}`);
      console.log(`      ${entry.statement}`);
      console.log(`      ${entry.why}`);
    }
  }
  for (const blocked of preview.blocked) console.log(`  BLOCKED ${blocked.lane}: ${blocked.reason}`);
}

async function runExpand(): Promise<void> {
  const { expand } = await load();
  const pass = await expand.runExpansionPass('PROACTIVE');
  console.log(`EXPANSION PASS — ${pass.liveBefore} expansion(s) were already live`);
  for (const settled of pass.settled) {
    console.log(`  settled ${settled.expansionId} -> ${settled.state}: ${settled.outcome}`);
  }
  for (const opened of pass.opened) {
    console.log(`  opened  ${opened.id} [${opened.route}] ${opened.capabilityKey}`);
    console.log(`          ${opened.statement}`);
    console.log(`          ${opened.why}`);
    if (opened.outcome) console.log(`          ${opened.outcome}`);
  }
  for (const declined of pass.declined.slice(0, 8)) {
    console.log(`  passed over ${declined.capabilityKey}: ${declined.why}`);
  }
  if (pass.opened.length === 0 && pass.settled.length === 0) {
    console.log('  Nothing opened and nothing settled.');
  }
}

async function printFindings(cycleId: string | undefined): Promise<void> {
  const { repo } = await load();
  const findings = await repo.listFindings(cycleId ? { cycleId, limit: 200 } : { limit: 60 });
  if (findings.length === 0) {
    console.log('No findings.');
    return;
  }
  for (const finding of findings) {
    console.log(
      `  [${finding.severity}] [${finding.lane}] ${finding.surfaceKey} — ${finding.kind} (${finding.state})`,
    );
    console.log(`      ${finding.region}`);
    console.log(`      ${finding.statement}`);
    console.log(`      why: ${finding.whyItMatters}`);
    console.log(`      fix: ${finding.proposedRepair}`);
    if (finding.resolution) console.log(`      settled: ${finding.resolution}`);
    console.log('');
  }
}

async function printImpact(argv: string[]): Promise<void> {
  const paths = (flag(argv, 'paths') ?? '').split(',').filter(Boolean);
  const says = flag(argv, 'says') ?? '';
  const { impact: impactModule } = await load();
  const impact = await impactModule.classifyUiImpact({ changedPaths: paths, description: says });
  console.log(`UI IMPACT: ${impact.verdict}`);
  console.log(`  ${impact.because}`);
  if (impact.interfacePaths.length > 0) console.log(`  interface: ${impact.interfacePaths.join(', ')}`);
  if (impact.adjacentPaths.length > 0) console.log(`  adjacent:  ${impact.adjacentPaths.join(', ')}`);
  if (impact.concepts.length > 0) console.log(`  concepts:  ${impact.concepts.join(', ')}`);
  if (impact.surfaces.length > 0) {
    console.log(`  surfaces:  ${impact.surfaces.map((one) => one.surfaceKey).join(', ')}`);
  }
  if (impact.unrepresented.length > 0) {
    console.log(`  no surface is registered about: ${impact.unrepresented.join(', ')}`);
  }
}

/**
 * A change that has landed, offered to the classifier that already decides.
 *
 * ---------------------------------------------------------------------------
 * Why this exists, and why it is not a shortcut
 * ---------------------------------------------------------------------------
 *
 * `requestDesignCycle` had exactly one caller in the whole repository: the
 * Software Factory's integrate stage. So the kernel could only notice a change
 * made by the one route almost nothing in this project's history actually used.
 * **Every UI change that has ever reached this product landed by a merge and a
 * deploy**, and the kernel was blind to all of them — which is this file's own
 * recurring sentence at the top of the loop rather than a gap in the walk: a
 * mechanism with one entrance is not a mechanism.
 *
 * It decides nothing that the factory's own hook does not decide. The same
 * `classifyUiImpact` reads the same changed paths against the same registered
 * surfaces, `shouldOpenCycle` is untouched, and a change with no interface
 * consequence produces no cycle and the reason why. What differs is only where
 * the paths come from: a unit's declared mutation scope there, and the two
 * commits a deploy actually moved between here.
 *
 * ---------------------------------------------------------------------------
 * The paths are a fact, not an argument
 * ---------------------------------------------------------------------------
 *
 * They are computed by `git diff --name-only <from> <to>` in the checkout the
 * workflow already has, and handed here. The deployed image has no `.git` and
 * must not acquire one, so this end takes them as given — and that is why the
 * workflow computes them from the two SHAs rather than accepting a typed list:
 * a hand-written path list is somebody's account of a change, and the point of
 * this kernel is that an account of a change is not the change.
 *
 * Idempotent by the trigger, in `requestDesignCycle`'s own way: running it twice
 * for one revision finds the open cycle and returns it rather than opening a
 * second.
 */
async function routeLandedChange(argv: string[]): Promise<void> {
  const paths = (flag(argv, 'paths') ?? '').split(',').map((one) => one.trim()).filter(Boolean);
  const says = flag(argv, 'says');
  const revision = flag(argv, 'revision') ?? null;
  const ref = flag(argv, 'ref') ?? null;
  if (paths.length === 0 || !says) {
    fail(
      'Usage: design route --paths a,b --says "<what the change was>" ' +
        '[--revision <sha>] [--ref <deploy or run id>]\n\n' +
        'A change with no paths is not a change. Nothing is opened for an empty list, ' +
        'because an empty list is indistinguishable from a diff nobody read.',
    );
  }

  const { route } = await load();
  const outcome = await route.requestDesignCycle({
    triggerKind: 'UI_IMPACT',
    triggerRef: ref,
    changedPaths: paths,
    description: says,
    revision,
  });

  console.log(`UI IMPACT: ${outcome.impact.verdict}`);
  console.log(`  ${outcome.impact.because}`);
  if (outcome.impact.interfacePaths.length > 0) {
    console.log(`  interface: ${outcome.impact.interfacePaths.join(', ')}`);
  }
  if (outcome.impact.surfaces.length > 0) {
    console.log(`  surfaces:  ${outcome.impact.surfaces.map((one) => one.surfaceKey).join(', ')}`);
  }
  console.log('');
  if (outcome.cycle) {
    console.log(`CYCLE ${outcome.cycle.id}`);
    console.log(`  state:     ${outcome.cycle.state}`);
    console.log(`  revision:  ${outcome.cycle.revision ?? '(none recorded)'}`);
    console.log(`  surfaces:  ${outcome.cycle.surfaceKeys.join(', ')}`);
    console.log('');
    console.log(
      '  The tick will open a DESIGN_RENDER_V1 bin for it, because this Brain has no browser.',
    );
  } else {
    console.log('NO CYCLE');
    console.log(`  ${outcome.because}`);
  }
}

/**
 * Record what the owner said, at the scope they gave it.
 *
 * On a terminal for §26's reason — reaching the shell is the authentication —
 * and `--admin` is the *attribution*, resolved against `users` rather than
 * trusted, because a correction with no author answers nothing later. §23 draws
 * the distinction this rests on: attribution is not authentication.
 *
 * The scope is **asked for, never defaulted**. `suggestScope` prints the
 * narrowest reading of what was pointed at and what else it could reasonably
 * be, and a caller that gives none is refused rather than quietly filed as a
 * one-off — the convenient answer here is always the wider one, and the failure
 * the owner described is a fix applied everywhere removing something useful.
 */
async function recordCorrectionFromTerminal(argv: string[]): Promise<void> {
  const { repo, corrections } = await load();
  const email = flag(argv, 'admin');
  const says = flag(argv, 'says');
  if (!email || !says) {
    fail('Usage: design correction --admin <email> --says "<their words>" [--surface k] ' +
      '[--components a,b] [--scope ONE_OFF|COMPONENT|SCREEN|FACULTY|GLOBAL] [--scope-ref r] ' +
      '[--before <captureId>] [--after <captureId>] [--confidence LOW|MEDIUM|HIGH]');
  }

  const { getUserByEmail } = await import('../server/repos/identity.ts');
  const person = await getUserByEmail(email);
  if (!person) fail(`No account for ${email}. A correction with no author answers nothing later.`);

  const surfaceKey = flag(argv, 'surface') ?? null;
  const components = (flag(argv, 'components') ?? '').split(',').filter(Boolean);
  const surface = surfaceKey ? await repo.getSurface(surfaceKey) : null;

  const suggestion = corrections.suggestScope({
    components,
    surfaceKey,
    faculty: surface?.faculty ?? null,
  });

  const scope = flag(argv, 'scope');
  if (!scope) {
    console.log('HOW FAR DOES THIS REACH? Brain will not choose for you.');
    console.log('');
    console.log(`  suggested  --scope ${suggestion.scope}` +
      (suggestion.scopeRef ? ` --scope-ref ${suggestion.scopeRef}` : ''));
    console.log(`             ${suggestion.because}`);
    for (const alternative of suggestion.alternatives) {
      console.log(`  or         --scope ${alternative.scope}` +
        (alternative.scopeRef ? ` --scope-ref ${alternative.scopeRef}` : ''));
      console.log(`             ${alternative.because}`);
    }
    console.log('');
    console.log('  Re-run with --scope. Nothing was recorded.');
    return;
  }

  const outcome = await corrections.recordOwnerCorrection({
    correction: says,
    surfaceKey,
    beforeCaptureId: flag(argv, 'before') ?? null,
    afterCaptureId: flag(argv, 'after') ?? null,
    components,
    scope: scope as Parameters<typeof corrections.recordOwnerCorrection>[0]['scope'],
    scopeRef: flag(argv, 'scope-ref') ?? (scope === suggestion.scope ? suggestion.scopeRef : null),
    confidence:
      (flag(argv, 'confidence') ?? 'MEDIUM') as
        Parameters<typeof corrections.recordOwnerCorrection>[0]['confidence'],
    lesson: null,
    recordedByUserId: person.id,
  });

  if (!outcome.ok) fail(outcome.refusal);
  console.log(`Recorded ${outcome.correction.id} at ${outcome.correction.scope} scope.`);
  console.log(`  "${outcome.correction.correction}"`);
  console.log('');
  console.log('  It is evidence now. Whether it becomes a rule is a second decision, and a');
  console.log('  one-off can never become one — see docs/DESIGN-KERNEL.md.');
}

async function printReport(): Promise<void> {
  const { repo, runtime: runtimeModule, route } = await load();
  const runtime = runtimeModule.probeRenderRuntime();
  const surfaces = await repo.listSurfaces();
  const captures = await repo.listCaptures({ limit: 2000 });
  const findings = await repo.listFindings({ limit: 2000 });
  const patterns = await repo.listPatterns({});
  const cycles = await repo.listCycles({ limit: 200 });
  const waiting = await route.pendingCycles();

  console.log('DESIGN KERNEL');
  console.log('');
  console.log(`  render runtime     ${runtime.available ? runtime.version : 'none'}`);
  console.log(`  surfaces           ${surfaces.length}`);
  console.log(`  captures           ${captures.length}`);
  console.log(`  findings           ${findings.length} (${findings.filter((f) => f.state === 'OPEN').length} open)`);
  console.log(`  patterns           ${patterns.length} (${patterns.filter((p) => p.state === 'ACTIVE').length} active)`);
  console.log(`  cycles             ${cycles.length}`);
  console.log('');
  if (waiting.length > 0) {
    console.log('  OPEN, AND WHAT EACH ONE IS WAITING FOR');
    for (const entry of waiting) {
      console.log(
        `    ${entry.cycle.id}  ${entry.waitingFor.padEnd(21)} ` +
          `${entry.cycle.surfaceKeys.join(', ')}`,
      );
      console.log(`      ${entry.remedy}`);
    }
    console.log('');
  }
  for (const cycle of cycles.slice(0, 10)) {
    console.log(
      `  ${cycle.id}  ${cycle.state.padEnd(6)} ${cycle.triggerKind.padEnd(20)} ` +
        `${cycle.stopReason ?? '—'}`,
    );
    if (cycle.stopDetail) console.log(`      ${cycle.stopDetail}`);
  }
}

/* =========================================================================
 * Running the product, so there is something real to look at
 * ====================================================================== */

function parseCookie(cookie: string): { name: string; value: string } | null {
  const [name, ...value] = cookie.split('=');
  return name && value.length > 0 ? { name, value: value.join('=') } : null;
}

/**
 * Build the client, boot a server against a throwaway database, and run.
 *
 * A throwaway data directory on purpose: a render is supposed to be a fact about
 * the product rather than about whatever happens to be in somebody's database,
 * and pointing a harness at a live Brain would make a capture of a real
 * project's rows. The design rows the run writes go into the same throwaway
 * directory, so `design report` afterwards reads the ordinary database and shows
 * nothing — which is correct and is why the run prints its own result in full.
 */
async function withServer(body: (cookie: string, outputDir: string) => Promise<CycleResult>): Promise<void> {
  await withProduct(async (cookie, outputDir) => {
    const result = await body(cookie, outputDir);
    printCycle(result);
    writeRenderIndex(outputDir, result);
  });
}

/**
 * Build the client, boot a server against a throwaway database, and run.
 *
 * Generic over what the body returns, because two things now need a running
 * product: a cycle, which measures and reports, and a **render for a bin**,
 * which measures and prints a submission for a worker to hand back. Two copies
 * of ninety lines of process management would be two copies to get the port,
 * the sign-in and the process group wrong in.
 */
async function withProduct<T>(body: (cookie: string, outputDir: string) => Promise<T>): Promise<T> {
  await buildClient();

  /*
   * A throwaway directory unless the caller named one.
   *
   * Throwaway is the right default: a render is supposed to be a fact about the
   * product rather than about whatever happens to be in somebody's database, and
   * pointing this at a live Brain would photograph a real project's rows.
   *
   * `BRAIN_DATA_DIR` overrides it and is **kept**, which is how a run's cycles,
   * captures and findings survive for `design capabilities`, `design next` and
   * `design report` to read afterwards. Without it the rows go with the
   * directory, and a person asking what the kernel learned would be told
   * nothing — the run's own printed result would be the only record, which is
   * the transcript-as-state this repository refuses everywhere else.
   */
  const named = (process.env['BRAIN_DATA_DIR'] ?? '').trim();
  const dataDir = named.length > 0 ? named : fs.mkdtempSync(path.join(os.tmpdir(), 'brain-design-'));
  if (named.length > 0) fs.mkdirSync(dataDir, { recursive: true });
  const outputDir = path.join(REPO_ROOT, 'docs', 'evidence', 'design-renders');
  let log = '';
  const server: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO_ROOT, 'server', 'index.ts')],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BRAIN_DB_PATH: undefined,
        BRAIN_DATA_DIR: dataDir,
        PORT: String(PORT),
        NODE_ENV: 'production',
        BRAIN_BOOTSTRAP_ADMIN_EMAIL: EMAIL,
        BRAIN_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group: `tsx`'s CLI is a launcher, so the real server is a
      // grandchild and a signal to the child leaves it holding the port.
      detached: true,
    },
  );
  server.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()));
  server.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));

  try {
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`the server never became healthy:\n${log.slice(-2000)}`);
      try {
        if ((await fetch(`${BASE}/healthz`)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // The ordinary first-run path rather than a shortcut: a bootstrap password
    // must be changed before anything else works.
    const first = await signIn(BOOTSTRAP);
    await fetch(`${BASE}/api/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, cookie: first },
      body: JSON.stringify({ currentPassword: BOOTSTRAP, newPassword: PASSWORD }),
    });
    const cookie = await signIn(PASSWORD);

    /*
     * Only now is the data directory decided, so only now may a server module be
     * loaded: `server/env.ts` freezes `DATA_ROOT` at import time, and loading
     * earlier would point every write at the repository's own database while the
     * server this run is photographing lives somewhere else.
     */
    process.env['BRAIN_DATA_DIR'] = dataDir;
    delete process.env['BRAIN_DB_PATH'];
    const { db } = await load();
    await db.initDatabase();

    const result = await body(cookie, outputDir);
    await db.closeDatabase();
    return result;
  } finally {
    endProcessTree(server);
    if (named.length === 0) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* left in the temp directory deliberately */
      }
    }
  }
}

/**
 * Declare the render set, so the existing manifest tool can digest it.
 *
 * `scripts/design-manifest.ts` **refuses to guess** what a file is: every render
 * must be declared with its screen and its width, because a digest built from a
 * filename convention silently changes meaning the first time somebody renames a
 * file. That refusal is right and is not weakened here — this writes the
 * declaration the tool asks for, from the captures the run actually recorded, so
 * the two cannot disagree about what the set covers.
 *
 * The last pass only. A directory holding two passes' images would digest a set
 * nobody looked at as a whole, and an approval of it would be an approval of
 * something that was never on a screen together.
 */
function writeRenderIndex(outputDir: string, result: CycleResult): void {
  const last = result.passes[result.passes.length - 1];
  if (!last || last.captures.length === 0) return;
  const declared = last.captures.map((capture) => ({
    screen: capture.surfaceKey,
    width: capture.width,
    file: capture.artifactRef,
  }));
  fs.writeFileSync(
    path.join(outputDir, 'index.json'),
    `${JSON.stringify(declared, null, 2)}\n`,
  );
  console.log(`  declared ${declared.length} render(s) in index.json`);
  console.log('  npm run design:manifest -- docs/evidence/design-renders');
}

/* =========================================================================
 * Answering a render bin
 * ====================================================================== */

/** The markers a worker copies between, so a log line cannot become evidence. */
const SUBMISSION_BEGIN = '----- BEGIN DESIGN RENDER SUBMISSION -----';
const SUBMISSION_END = '----- END DESIGN RENDER SUBMISSION -----';

/**
 * Render the surfaces a bin asked about and print what to submit.
 *
 * This is the worker half of the render lane. The deployed Brain has no browser,
 * so it opens a `DESIGN_RENDER_V1` bin; a worker with a checkout and a browser
 * runs this, and hands the printed object back through `brain_bin_submit_unit`.
 * Nothing here talks to that Brain — the worker's own connector does — which is
 * what keeps this a command rather than a second client with a second credential.
 *
 * It renders against a **throwaway** Brain of its own, for `withProduct`'s
 * reason: a capture is supposed to be a fact about the product, and pointing a
 * harness at live data would photograph somebody's real project rows. The
 * surfaces come from the seed, which every Brain writes at boot, so the two
 * agree about what `russell/default` means without anything being copied across.
 *
 * The bytes are written beside the run and their **hashes** are what travel.
 * §27's standard, at a picture: the address is an address and the digest is the
 * evidence, and a submission carrying the images would be megabytes of
 * base64 nobody could check anyway.
 */
async function renderForBin(rest: string[]): Promise<void> {
  const keys = (flag(rest, 'surfaces') ?? '')
    .split(',')
    .map((one) => one.trim())
    .filter(Boolean);
  if (keys.length === 0) {
    fail('Usage: design render --surfaces <key,key> [--pass <n>]');
  }
  const pass = Number(flag(rest, 'pass') ?? 0);
  if (!Number.isInteger(pass) || pass < 0) fail('--pass must be a whole number of rounds.');

  /*
   * A throwaway directory, never the committed evidence set.
   *
   * `cycle` writes into `docs/evidence/design-renders` on purpose: that set is
   * declared, digested and committed as the evidence of one run at one commit.
   * A render answering a bin is a *different* artifact — it is submitted, not
   * committed — and writing it there would silently replace half of a
   * content-addressed set with pictures from another revision, leaving a
   * manifest whose digest no longer describes what is in the directory. The
   * first version of this command did exactly that, and the only reason it was
   * noticed is that one byte count moved.
   */
  const renderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-design-render-'));

  await withProduct(async (cookie) => {
    const outputDir = renderDir;
    const { capture, surfaces: surfaceService } = await load();
    const { surfaces, unknown } = await surfaceService.resolveSurfaces(keys);
    if (unknown.length > 0) {
      /*
       * Named and refused rather than silently rendered short. A submission
       * missing a surface the bin asked about would be measured as though that
       * screen were fine, which is the one thing a render must never say.
       */
      fail(
        `This checkout has no registered surface called ${unknown.join(', ')}. ` +
          'Report that as a blocker rather than submitting a partial render.',
      );
    }

    const outcome = await capture.captureSurfaces({
      baseUrl: BASE,
      cookie: parseCookie(cookie),
      surfaces,
      // Null: these rows belong to the worker's throwaway database, and the
      // cycle they are *for* lives in a Brain this process cannot see.
      cycleId: null,
      pass,
      outputDir,
      satisfied: ['SIGNED_IN', 'BRAIN_ADMINISTRATOR', 'PROJECT_EXISTS'],
    });

    const { revision, dirty } = capture.treeRevision(REPO_ROOT);
    const submission = {
      revision,
      treeDirty: dirty,
      captures: outcome.captures.map((one) => ({
        surfaceKey: one.surfaceKey,
        viewportName: one.viewportName,
        width: one.width,
        height: one.height,
        contentHash: one.contentHash,
        byteSize: one.byteSize,
        artifactRef: one.artifactRef,
        engine: one.engine,
        engineVersion: one.engineVersion,
        capturedAt: one.capturedAt,
        readings: one.readings,
      })),
    };

    console.log('');
    console.log(`Rendered ${outcome.captures.length} capture(s) into ${outputDir}.`);
    for (const skipped of outcome.skipped) {
      console.log(`  NOT RENDERED  ${skipped.surfaceKey}: ${skipped.reason}`);
    }
    if (outcome.captures.length === 0) {
      /*
       * Loud, and not a submission. An empty render reads downstream as a screen
       * with nothing wrong with it, so the contract refuses one — and a worker
       * that printed an empty object here would spend an attempt learning that.
       */
      console.log('');
      console.log(
        'Nothing rendered. Report this as a blocker naming what stopped it — a missing browser, ' +
          'a product that would not start, an address that answered 404 — rather than submitting ' +
          'an empty render.',
      );
      return;
    }
    console.log('');
    console.log(SUBMISSION_BEGIN);
    console.log(JSON.stringify(submission));
    console.log(SUBMISSION_END);
  });
}

function printCycle(result: CycleResult): void {
  console.log('');
  console.log(`CYCLE ${result.cycle.id}`);
  console.log(`  trigger    ${result.cycle.triggerKind}`);
  console.log(`  surfaces   ${result.cycle.surfaceKeys.join(', ')}`);
  console.log(`  stopped    ${result.stopReason}`);
  console.log(`  because    ${result.stopDetail}`);
  console.log('');
  for (const pass of result.passes) {
    console.log(`  PASS ${pass.pass} — ${pass.captures.length} capture(s), digest ${pass.captureDigest.slice(0, 12)}…`);
    for (const capture of pass.captures) {
      console.log(
        `    ${capture.surfaceKey.padEnd(26)} ${String(capture.width).padStart(5)}px  ` +
          `${capture.artifactRef}  sha ${capture.contentHash.slice(0, 12)}`,
      );
    }
    for (const skipped of pass.skipped) console.log(`    SKIPPED ${skipped.surfaceKey}: ${skipped.reason}`);
    for (const finding of pass.findings) {
      console.log(`    [${finding.severity}] ${finding.surfaceKey} ${finding.kind} — ${finding.statement}`);
    }
    for (const closed of pass.closed) console.log(`    CLOSED ${closed.findingId}: ${closed.because}`);
    console.log('');
  }
  if (result.repairs.length > 0) {
    console.log('  REPAIRS');
    for (const repair of result.repairs) console.log(`    ${repair.outcome}`);
    console.log('');
  }
  if (result.unresolved.length > 0) {
    console.log(`  ${result.unresolved.length} finding(s) left unresolved, kept rather than closed:`);
    for (const finding of result.unresolved) {
      console.log(`    [${finding.severity}] ${finding.surfaceKey} ${finding.kind}`);
    }
  }
}

async function buildClient(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const build = spawn('npx', ['vite', 'build'], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let noise = '';
    build.stdout.on('data', (chunk: Buffer) => (noise += chunk.toString()));
    build.stderr.on('data', (chunk: Buffer) => (noise += chunk.toString()));
    build.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`the client did not build:\n${noise.slice(-2000)}`)),
    );
  });
}

async function signIn(password: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email: EMAIL, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status}`);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

function endProcessTree(child: { pid?: number; kill(signal: NodeJS.Signals): boolean }): void {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

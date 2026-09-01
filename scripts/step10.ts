/**
 * The Step 10 acceptance harness.
 *
 * A script rather than operator buttons, deliberately: the instruction for this
 * step is to prefer permanent services, structured reports and scripts over new
 * console surface, and to leave the existing console frozen because Step 12 is
 * going to rebuild it.
 *
 * Everything here is either a read or an operator action that a person is
 * already authorized to take. It creates its own clearly-named acceptance
 * project and never touches another one — Deal Dispatch in particular is not
 * reachable from any subcommand.
 *
 *   setup                 create the acceptance project and grant the worker
 *   seed <n> [units]      mint n tiny deterministic bins
 *   report                bins, dispatch intents, and what the events say
 *   tick [burst]          run one dispatcher pass by hand
 *   reconcile             run the governing-invariant pass
 *   standards             the measurements Step 11 will start from
 *   fire-check            whether activation is configured, without the token
 *   trace <binId>         one bin's dispatches, events and units, in order
 *   watch [secs] [every]  follow the bins from inside the machine until they settle
 *   ramp <n> [units] [secs]  one rung of the concurrency ramp: seed, watch, measure
 */
import { initDatabase, getDb } from '../server/db/database.ts';
import { initStorage } from '../server/services/storage/index.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { grantMembership, listWorkers } from '../server/repos/identity.ts';
import {
  createBin,
  getBin,
  listBins,
  listBinEvents,
  listBinUnitResults,
  listDispatchesForBin,
  sweepExpiredBinLeases,
} from '../server/repos/bins.ts';
import { reconcileBins } from '../server/services/bins/service.ts';
import { dispatchTick } from '../server/services/dispatch/loop.ts';
import { describeFireTarget } from '../server/services/dispatch/fire.ts';
import type { BinManifest, WorkerScope } from '../server/domain/types.ts';

const SLUG = 'step-10-acceptance';
const NAME = 'Step 10 acceptance';

const SCOPES: WorkerScope[] = [
  'queue:read',
  'queue:claim',
  'queue:heartbeat',
  'queue:complete',
  'research:read',
  'research:write',
  'research:propose',
  'claims:write',
  'checkpoints:write',
  'blockers:report',
  'work:complete',
];

function arg(index: number): string | undefined {
  return process.argv[3 + index];
}

async function scope(): Promise<string> {
  const existing = await getProjectBySlug(SLUG);
  if (existing) return existing.id;
  const created = await createProject({
    name: NAME,
    slug: SLUG,
    description:
      'Created by scripts/step10.ts. Holds the Step 10 dispatch acceptance bins so that ' +
      'measuring the dispatcher never puts test items into a project with real research in it.',
  });
  return created.id;
}

/**
 * A tiny mission whose answer Brain can recompute.
 *
 * Not an echo: each unit names an input and a transform, the worker has to
 * apply the transform, and the contract compares against Brain's own
 * computation. A worker that returns the input fails, which is the property
 * that makes these bins worth running at all.
 */
function tinyManifest(projectId: string, index: number, units: number): BinManifest {
  const transforms = ['sha256', 'reverse', 'word_count', 'upper'];
  return {
    objective: `Establish ${units} checkable values for acceptance bin ${index}.`,
    why:
      'Dispatch, leasing, concurrency and completion validation have to be measured against ' +
      'something cheap and unambiguous before they are trusted with research.',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: Array.from({ length: units }, (_, unit) => ({
      key: `u${unit + 1}`,
      establishes: `The declared transform of input ${unit + 1}`,
      input: `acceptance bin ${index} unit ${unit + 1}`,
      transform: transforms[unit % transforms.length]!,
      dependsOn: [],
    })),
    acceptableSources: ['the input given in this manifest'],
    excludedSources: ['anything external'],
    evidence: ['a stored value that matches Brain\'s own recomputation'],
    outputs: ['one unit result per declared unit'],
    authorizedActions: ['brain_bin_submit_unit'],
    prohibitedActions: [
      'any external request',
      'any spend',
      'any action outside this bin',
    ],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['every declared unit has a value Brain recomputes to the same thing'],
  };
}


/**
 * Follow a set of bins until they settle, from inside the machine.
 *
 * A snapshot taken from a workflow run answers "what is true now" and costs a
 * ninety-second round trip to ask. Dispatch is a process with a shape — ready,
 * fired, assigned, drained — and the shape is the thing being measured, so the
 * observation belongs next to the database rather than three network hops away.
 *
 * It reports transitions rather than a poll log: a line appears when a bin
 * changes state, and nothing is printed while the fleet is simply working.
 */
async function watchBins(
  projectId: string,
  deadlineMs: number,
  everyMs: number,
  only?: Set<string>,
): Promise<{ settled: boolean; bins: string[] }> {
  const started = Date.now();
  const seen = new Map<string, string>();
  let ids: string[] = [];
  for (;;) {
    const all = await listBins({ projectId, limit: 500 });
    const bins = only ? all.filter((b) => only.has(b.id)) : all;
    ids = bins.map((b) => b.id);
    const elapsed = Math.round((Date.now() - started) / 1000);
    for (const bin of bins) {
      const was = seen.get(bin.id);
      if (was === bin.state) continue;
      seen.set(bin.id, bin.state);
      if (was === undefined && bin.state === 'READY') continue;
      const units = bin.state === 'COMPLETE' ? (await listBinUnitResults(bin.id)).length : 0;
      console.log(
        `  +${String(elapsed).padStart(4)}s  ${bin.id}  ${(was ?? 'new').padEnd(9)} -> ` +
          `${bin.state.padEnd(11)} gen ${bin.leaseGeneration}` +
          (units ? ` units ${units}` : '') +
          (bin.terminalReason ? `  ${bin.terminalReason.slice(0, 90)}` : ''),
      );
    }
    const pending = bins.filter(
      (b) => b.state === 'READY' || b.state === 'LEASED' || b.state === 'DRAFT',
    );
    if (bins.length > 0 && pending.length === 0) return { settled: true, bins: ids };
    if (Date.now() - started >= deadlineMs) return { settled: false, bins: ids };
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

/** ready -> assigned -> complete, per bin, from the bin's own row and events. */
async function measureBins(ids: string[]): Promise<void> {
  console.log('');
  console.log('  bin                       ready→assigned  assigned→done  ready→done  units  gen');
  const waits: number[] = [];
  const works: number[] = [];
  const totals: number[] = [];
  for (const id of ids) {
    const events = await listBinEvents(id, 500);
    const assigned = events.find((e) => e.eventType === 'BIN_ASSIGNED');
    const bin = await getBin(id);
    if (!bin) continue;
    const readyAt = bin.readyAt ? new Date(bin.readyAt).getTime() : null;
    const assignedAt = assigned ? new Date(assigned.at).getTime() : null;
    const doneAt = bin.completedAt ? new Date(bin.completedAt).getTime() : null;
    const wait = readyAt !== null && assignedAt !== null ? assignedAt - readyAt : null;
    const work = assignedAt !== null && doneAt !== null ? doneAt - assignedAt : null;
    const total = readyAt !== null && doneAt !== null ? doneAt - readyAt : null;
    if (wait !== null) waits.push(wait);
    if (work !== null) works.push(work);
    if (total !== null) totals.push(total);
    const units = (await listBinUnitResults(id)).length;
    const ms = (v: number | null): string => (v === null ? '—' : `${Math.round(v / 100) / 10}s`);
    console.log(
      `  ${id}  ${ms(wait).padStart(14)}  ${ms(work).padStart(13)}  ${ms(total).padStart(10)}  ` +
        `${String(units).padStart(5)}  ${bin.leaseGeneration}`,
    );
  }
  const stat = (values: number[], label: string): void => {
    if (values.length === 0) {
      console.log(`  ${label.padEnd(16)} —`);
      return;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    console.log(
      `  ${label.padEnd(16)} median ${Math.round(median / 100) / 10}s  ` +
        `min ${Math.round(sorted[0]! / 100) / 10}s  max ${Math.round(sorted[sorted.length - 1]! / 100) / 10}s  ` +
        `n=${sorted.length}`,
    );
  };
  console.log('');
  stat(waits, 'queue wait');
  stat(works, 'drain');
  stat(totals, 'ready→done');
}

async function main(): Promise<void> {
  await initDatabase();
  // The store, opened explicitly. `getStorage()` falls back to a local provider
  // when nothing has booted, which is right for a unit test and wrong here: a
  // script that reads documents without opening the store looks on the
  // machine's own disk while the bytes are in a bucket. It cost Step 9 three
  // deploys to learn that once.
  await initStorage();

  const command = process.argv[2] ?? 'report';

  if (command === 'setup') {
    const projectId = await scope();
    // Every worker that already exists gets the acceptance project too. The
    // fleet is meant to be interchangeable; a worker that could only reach one
    // project would be the fixed mapping this step exists to remove.
    const workers = await listWorkers();
    let granted = 0;
    for (const worker of workers) {
      if (worker.disabled) continue;
      // Additive: this grants the acceptance project and touches no existing
      // membership, so a worker's reach into a real project is unchanged.
      await grantMembership({
        projectId,
        principalType: 'WORKER',
        principalId: worker.id,
        scopes: SCOPES,
        grantedByType: 'SYSTEM',
        grantedById: 'step10-harness',
      });
      granted += 1;
      console.log(`  granted ${worker.name} access to ${SLUG}`);
    }
    console.log(`STEP10: OK setup project=${projectId} workers=${granted}`);
    return;
  }

  if (command === 'seed') {
    const projectId = await scope();
    const count = Math.max(1, Math.min(200, Number(arg(0) ?? '1')));
    const units = Math.max(1, Math.min(20, Number(arg(1) ?? '3')));
    const made: string[] = [];
    const existing = (await listBins({ projectId, limit: 500 })).length;
    for (let index = 0; index < count; index += 1) {
      const bin = await createBin({
        projectId,
        kind: 'DETERMINISTIC_CHECK',
        title: `Acceptance bin ${existing + index + 1}`,
        objective: `Establish ${units} checkable values.`,
        rationale: 'Measuring the dispatcher, not researching anything.',
        manifest: tinyManifest(projectId, existing + index + 1, units),
        completionContract: 'DETERMINISTIC_UNITS_V1',
        createdByType: 'SYSTEM',
        createdById: 'step10-harness',
        ready: true,
        priority: 5,
      });
      made.push(bin.id);
    }
    console.log(`STEP10: OK seeded=${made.length} units=${units}`);
    for (const id of made) console.log(`  ${id}`);
    return;
  }

  if (command === 'tick') {
    const burst = Math.max(1, Math.min(60, Number(arg(0) ?? '5')));
    const result = await dispatchTick({ burst });
    console.log(
      `STEP10: OK tick superseded=${result.superseded} intents=${result.intentsCreated} ` +
        `fired=${result.fired} failed=${result.failed} configured=${!result.skippedNotConfigured}`,
    );
    return;
  }

  if (command === 'reconcile') {
    const projectId = (await getProjectBySlug(SLUG))?.id;
    const report = await reconcileBins(projectId);
    console.log(
      `STEP10: OK reconcile examined=${report.examined} healthy=${report.healthy} ` +
        `escalated=${report.escalated}`,
    );
    for (const detail of report.details) console.log(`  ${detail.binId} ${detail.disposition}`);
    return;
  }

  if (command === 'fire-check') {
    const target = describeFireTarget();
    // Names the routine and whether a credential is present. Never the value.
    console.log(
      `STEP10: OK fire configured=${target.configured} routine=${target.routineId ?? '—'} ` +
        `token=${target.tokenPresent ? 'set' : 'absent'} prompt=${target.routineVersion ?? '—'}`,
    );
    return;
  }

  if (command === 'standards') {
    const projectId = (await getProjectBySlug(SLUG))?.id;
    if (!projectId) {
      console.log('STEP10: OK standards bins=0');
      return;
    }
    const bins = await listBins({ projectId, limit: 500 });
    const waits: number[] = [];
    const holds: number[] = [];
    let takeovers = 0;
    let renewals = 0;
    let refusals = 0;
    let signals = 0;
    for (const bin of bins) {
      renewals += bin.leaseRenewals;
      refusals += bin.refusalCount;
      const events = await listBinEvents(bin.id, 2000);
      for (const event of events) {
        if (event.eventType === 'BIN_TAKEOVER') takeovers += 1;
        if (event.eventType === 'BIN_QUALITY_SIGNAL') signals += 1;
        const wait = event.measures['queueWaitMs'];
        if (event.eventType === 'BIN_ASSIGNED' && typeof wait === 'number') waits.push(wait);
      }
      if (bin.completedAt && bin.readyAt) {
        holds.push(new Date(bin.completedAt).getTime() - new Date(bin.readyAt).getTime());
      }
    }
    const median = (values: number[]): number =>
      values.length === 0 ? 0 : [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    console.log('STEP10 STANDARDS');
    console.log(`  bins                 ${bins.length}`);
    console.log(`  complete             ${bins.filter((b) => b.state === 'COMPLETE').length}`);
    console.log(`  needs human          ${bins.filter((b) => b.state === 'NEEDS_HUMAN').length}`);
    console.log(`  median queue wait    ${median(waits)} ms  (n=${waits.length})`);
    console.log(`  median ready→done    ${median(holds)} ms  (n=${holds.length})`);
    console.log(`  lease renewals       ${renewals}`);
    console.log(`  takeovers            ${takeovers}`);
    console.log(`  completion refusals  ${refusals}`);
    console.log(`  quality signals      ${signals}`);
    console.log(`STEP10: OK standards bins=${bins.length}`);
    return;
  }

  if (command === 'trace') {
    // Who did what to one bin, in order. The question this answers is not
    // "what state is it in" but "which activation caused this" — and during
    // acceptance that distinction is the whole point: a bin drained by a
    // worker Brain did not fire proves the bin protocol and nothing about
    // dispatch.
    const id = arg(0);
    if (!id) {
      console.log('STEP10: OK trace bin=—  (pass a bin id)');
      return;
    }
    const bin = await getBin(id);
    if (!bin) {
      console.log(`STEP10: OK trace bin=${id} found=false`);
      return;
    }
    console.log(`BIN ${bin.id}  ${bin.state}  gen ${bin.leaseGeneration}`);
    console.log(`  title      ${bin.title}`);
    console.log(`  ready      ${bin.readyAt ?? '—'}`);
    console.log(`  completed  ${bin.completedAt ?? '—'}`);
    console.log(`  worker     ${bin.workerId ?? '—'}  lease ${bin.leaseId ?? '—'}`);
    console.log(`  session    ${bin.leaseSessionRef ?? '—'}`);
    console.log(`  heartbeat  ${bin.heartbeatAt ?? '—'}  expires ${bin.leaseExpiresAt ?? '—'}`);
    console.log(`  renewals   ${bin.leaseRenewals}  refusals ${bin.refusalCount}`);
    if (bin.terminalReason) console.log(`  terminal   ${bin.terminalReason}`);
    if (bin.checkpoint) {
      console.log(`  checkpoint ${JSON.stringify(bin.checkpoint).slice(0, 240)}`);
    }
    console.log('');
    console.log('  DISPATCH');
    for (const dispatch of await listDispatchesForBin(bin.id)) {
      console.log(
        `    gen ${dispatch.leaseGeneration}  ${dispatch.state.padEnd(10)} ` +
          `attempt ${dispatch.attemptCount}/${dispatch.maxAttempts}  sent ${dispatch.sentAt ?? '—'}  ` +
          `session ${dispatch.sessionRef ?? '—'}`,
      );
      if (dispatch.lastError) {
        console.log(`      ${dispatch.lastErrorKind}: ${dispatch.lastError.slice(0, 160)}`);
      }
    }
    console.log('');
    console.log('  EVENTS');
    for (const event of await listBinEvents(bin.id, 500)) {
      console.log(
        `    ${event.at}  ${event.eventType.padEnd(24)} ` +
          `worker ${(event.workerId ?? '—').padEnd(24)} session ${event.sessionRef ?? '—'}` +
          (event.outcome ? `  ${event.outcome}` : '') +
          (event.reason ? `  ${event.reason.slice(0, 80)}` : ''),
      );
    }
    console.log('');
    console.log('  UNITS');
    for (const unit of await listBinUnitResults(bin.id)) {
      console.log(
        `    ${unit.unitKey.padEnd(6)} ${unit.contentHash.slice(0, 16)}  ` +
          `by ${unit.submittedBy ?? '—'}  ${unit.createdAt}`,
      );
    }
    console.log('');
    console.log(`STEP10: OK trace bin=${bin.id} state=${bin.state}`);
    return;
  }

  if (command === 'watch') {
    const projectId = (await getProjectBySlug(SLUG))?.id;
    if (!projectId) {
      console.log('STEP10: OK watch bins=0');
      return;
    }
    const seconds = Math.max(10, Math.min(3000, Number(arg(0) ?? '600')));
    const every = Math.max(2, Math.min(60, Number(arg(1) ?? '10')));
    console.log(`STEP10 WATCH ${seconds}s every ${every}s`);
    const result = await watchBins(projectId, seconds * 1000, every * 1000);
    await measureBins(result.bins);
    console.log('');
    console.log(`STEP10: OK watch settled=${result.settled} bins=${result.bins.length}`);
    return;
  }

  if (command === 'ramp') {
    // One rung. Seed n bins at once, then watch them settle without touching
    // anything else: the dispatcher is the thing under test, so the harness
    // must not fire, assign, or nudge. Its only actions are create and read.
    const projectId = await scope();
    const count = Math.max(1, Math.min(60, Number(arg(0) ?? '1')));
    const units = Math.max(1, Math.min(20, Number(arg(1) ?? '3')));
    const seconds = Math.max(30, Math.min(3000, Number(arg(2) ?? '900')));
    const existing = (await listBins({ projectId, limit: 500 })).length;
    const made: string[] = [];
    const seededAt = Date.now();
    for (let index = 0; index < count; index += 1) {
      const bin = await createBin({
        projectId,
        kind: 'DETERMINISTIC_CHECK',
        title: `Acceptance bin ${existing + index + 1}`,
        objective: `Establish ${units} checkable values.`,
        rationale: 'Measuring the dispatcher, not researching anything.',
        manifest: tinyManifest(projectId, existing + index + 1, units),
        completionContract: 'DETERMINISTIC_UNITS_V1',
        createdByType: 'SYSTEM',
        createdById: 'step10-harness',
        ready: true,
        priority: 5,
      });
      made.push(bin.id);
    }
    console.log(`STEP10 RAMP rung=${count} units=${units} deadline=${seconds}s`);
    const only = new Set(made);
    const result = await watchBins(projectId, seconds * 1000, 10_000, only);
    const wall = Math.round((Date.now() - seededAt) / 100) / 10;
    await measureBins(made);
    const after = await listBins({ projectId, limit: 500 });
    const mine = after.filter((b) => only.has(b.id));
    const complete = mine.filter((b) => b.state === 'COMPLETE').length;
    const stuck = mine.filter((b) => b.state === 'READY' || b.state === 'LEASED');
    const bad = mine.filter(
      (b) => b.state === 'FAILED' || b.state === 'NEEDS_HUMAN' || b.state === 'CANCELLED',
    );
    let sent = 0;
    let intents = 0;
    for (const bin of mine) {
      const dispatches = await listDispatchesForBin(bin.id);
      intents += dispatches.length;
      sent += dispatches.filter((d) => d.state === 'SENT').length;
    }
    console.log('');
    console.log(`  rung wall clock  ${wall}s`);
    console.log(`  complete         ${complete}/${count}`);
    console.log(`  still open       ${stuck.length}  ${stuck.map((b) => b.state).join(' ')}`);
    console.log(`  not complete     ${bad.length}  ${bad.map((b) => `${b.id}:${b.state}`).join(' ')}`);
    console.log(`  dispatch intents ${intents}  sent ${sent}`);
    console.log('');
    console.log(
      `STEP10: OK ramp=${count} complete=${complete} settled=${result.settled} wall=${wall}s`,
    );
    return;
  }

  // report
  const projectId = (await getProjectBySlug(SLUG))?.id;
  const bins = projectId ? await listBins({ projectId, limit: 500 }) : [];
  const target = describeFireTarget();
  console.log('STEP 10');
  console.log(`  project     ${SLUG} ${projectId ?? '(not created)'}`);
  console.log(
    `  activation  configured=${target.configured} routine=${target.routineId ?? '—'} ` +
      `token=${target.tokenPresent ? 'set' : 'absent'}`,
  );
  console.log(`  expired leases swept ${await sweepExpiredBinLeases()}`);
  console.log('');
  const byState = new Map<string, number>();
  for (const bin of bins) byState.set(bin.state, (byState.get(bin.state) ?? 0) + 1);
  console.log(`BINS (${bins.length})`);
  for (const [state, n] of [...byState].sort()) console.log(`  ${state.padEnd(12)} ${n}`);
  console.log('');
  for (const bin of bins.slice(0, 40)) {
    const dispatches = await listDispatchesForBin(bin.id);
    const sent = dispatches.filter((d) => d.state === 'SENT').length;
    console.log(
      `  ${bin.id}  ${bin.state.padEnd(11)} attempt ${bin.attemptCount}/${bin.maxAttempts} ` +
        `gen ${bin.leaseGeneration} intents ${dispatches.length} sent ${sent} ` +
        `refusals ${bin.refusalCount}`,
    );
    if (bin.terminalReason) console.log(`      ${bin.terminalReason.slice(0, 160)}`);
    const failed = dispatches.find((d) => d.lastError);
    if (failed) console.log(`      last dispatch error: ${failed.lastErrorKind} ${failed.lastError}`);
  }
  console.log('');
  const rows = await getDb().all<{ event_type: string; n: number }>(
    `SELECT event_type, COUNT(*) AS n FROM bin_events GROUP BY event_type ORDER BY event_type`,
  );
  console.log('EVENTS');
  for (const row of rows) console.log(`  ${String(row.event_type).padEnd(26)} ${row.n}`);
  console.log('');
  console.log(`STEP10: OK bins=${bins.length}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

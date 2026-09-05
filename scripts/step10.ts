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
 *   research-start        the one real-research acceptance packet, and its bin
 *   research-ready <bin>  make that bin dispatchable again after approval
 *   regrant <bin> <n> [why]  raise a bin's assignment ceiling: platform-defect | surface-blocked
 *   probe                 ask a fired worker what its execution surface can reach
 *   probe-read <binId>    the readings that probe recorded
 *   recover <key> <bin> <orc>  requeue a fragment an execution-surface failure blocked
 *   admins                who on this Brain can sign an authorization
 *   gap-policy <orc> <usr>  authorize one packet to record unresolved gaps
 *   cf8                   whether a client ever refreshed an expiring access token
 *   cancel-ready <n>      cancel exactly n READY acceptance bins, or refuse
 *   cancel-bin <binId>    cancel one named unleased acceptance bin
 *   prompt                the exact prompt a worker routine must hold
 *   trace <binId>         one bin's dispatches, events and units, in order
 *   watch [secs] [every]  follow the bins from inside the machine until they settle
 *   ramp <n> [units] [secs]  one rung of the concurrency ramp: seed, watch, measure
 */
import { initDatabase, getDb } from '../server/db/database.ts';
import { listPasses } from '../server/repos/research.ts';
import { auditMatrixVerdict } from '../server/services/research/auditEligibility.ts';
import { STEP11_AUDIT_INDEPENDENCE_ASSIGNMENT } from '../server/services/research/approvalEnvelope.ts';
import { initStorage } from '../server/services/storage/index.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { getUser, grantMembership, listUsers, listWorkers } from '../server/repos/identity.ts';
import { listTokensForWorker } from '../server/repos/oauth.ts';
import {
  createBin,
  getBin,
  resolveNeedsHumanBin,
  terminateUnleasedBin,
  listBins,
  listBinEvents,
  listBinUnitResults,
  listDispatchesForBin,
  markBinReady,
  regrantBinAttempts,
  sweepExpiredBinLeases,
} from '../server/repos/bins.ts';
import { reconcileBins, reopenParkedBin } from '../server/services/bins/service.ts';
import { evaluateContract, readSurfaceProbe } from '../server/services/bins/contracts.ts';
import {
  recoverFragmentAfterSurfaceChange,
  SurfaceRecoveryRefused,
} from '../server/services/research/surfaceRecovery.ts';
import { startPacket } from '../server/services/research/startPacket.ts';
import {
  MICHIGAN_LICENSING_ASSIGNMENT,
} from '../server/services/research/approvalEnvelope.ts';
import { getOrchestration } from '../server/repos/research.ts';
import { authorizeUnresolvedGaps } from '../server/services/research/gapPolicy.ts';
import { advancePacket } from '../server/services/research/packetRunner.ts';
import { createLayer, listLayers } from '../server/repos/layers.ts';
import { DEAL_DISPATCH_SLUG } from '../server/seed.ts';
import { dispatchTick } from '../server/services/dispatch/loop.ts';
import { describeFireTarget } from '../server/services/dispatch/fire.ts';
import {
  instructionProblems,
  WORKER_INSTRUCTIONS,
  WORKER_INSTRUCTIONS_VERSION,
} from '../server/services/bins/workerInstructions.ts';
import type { BinManifest, WorkerScope } from '../server/domain/types.ts';

const SLUG = 'step-10-acceptance';
const STEP11_SLUG = 'step-11-acceptance';
const STEP11_LAYER_SLUG = 'delaware-entity-obligations';
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

/** Refuse, in the shape the workflow greps for. */
function refuseStep10(why: string): void {
  console.log(`STEP10 REFUSED: ${why}`);
  process.exitCode = 1;
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
    // The same separation the description already describes, made a fact about
    // the row so a person's Work screen can act on it. See migration 028.
    purpose: 'TECHNICAL',
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
/**
 * The rung, measured. Every number the acceptance asks for, from rows only.
 *
 * Ready→fired is the dispatcher's own latency and comes from the dispatch row's
 * `sent_at`, not from any event a worker wrote. Ready→assigned is queue wait:
 * how long ready work waited for somebody to take it. The two are different
 * questions and conflating them would hide exactly the failure this step spent
 * a morning on — a bin fired at in three seconds and picked up forty minutes
 * later is a dispatcher working and a fleet that is not.
 */
async function measureBins(ids: string[]): Promise<void> {
  console.log('');
  console.log('  bin                       ready→fired  ready→assigned  drain  ready→done  units  gen');
  const fires: number[] = [];
  const waits: number[] = [];
  const works: number[] = [];
  const totals: number[] = [];
  let takeovers = 0;
  let refusals = 0;
  let staleWrites = 0;
  let leaseExpiries = 0;
  let duplicateSends = 0;
  let assignments = 0;
  const throttles = new Map<string, number>();
  const stranded: string[] = [];

  for (const id of ids) {
    const events = await listBinEvents(id, 500);
    const bin = await getBin(id);
    if (!bin) continue;
    const dispatches = await listDispatchesForBin(bin.id);

    for (const event of events) {
      if (event.eventType === 'BIN_TAKEOVER') takeovers += 1;
      if (event.eventType === 'BIN_ASSIGNED' || event.eventType === 'BIN_TAKEOVER') assignments += 1;
      if (event.eventType === 'BIN_COMPLETION_REFUSED') refusals += 1;
      // The fence, observed rather than assumed: a write from a worker that no
      // longer holds the lease. Zero of these under load is the claim; one of
      // them accepted would be the defect.
      if (event.eventType === 'BIN_STALE_WRITE') staleWrites += 1;
      if (event.eventType === 'BIN_LEASE_EXPIRED') leaseExpiries += 1;
    }

    // A duplicate activation is two SENT intents at one generation. The unique
    // index makes that impossible, so this counts the thing the index is meant
    // to prevent rather than trusting that it did.
    const sentPerGeneration = new Map<number, number>();
    for (const dispatch of dispatches) {
      if (dispatch.state === 'SENT') {
        sentPerGeneration.set(
          dispatch.leaseGeneration,
          (sentPerGeneration.get(dispatch.leaseGeneration) ?? 0) + 1,
        );
      }
      if (dispatch.lastErrorKind) {
        throttles.set(dispatch.lastErrorKind, (throttles.get(dispatch.lastErrorKind) ?? 0) + 1);
      }
    }
    for (const n of sentPerGeneration.values()) if (n > 1) duplicateSends += n - 1;

    // The FIRST time it was ready, from the append-only event — not bin.readyAt,
    // which is reset every time a released bin returns to READY. Measuring
    // against the moving one produced negative latencies in rung 1: a dispatch
    // sent before a later re-ready looks like it was sent before the bin
    // existed.
    const firstReady = events
      .filter((e) => e.eventType === 'BIN_READY')
      .map((e) => new Date(e.at).getTime())
      .sort((a, b) => a - b)[0];
    const readyAt = firstReady ?? (bin.readyAt ? new Date(bin.readyAt).getTime() : null);
    const firstSent = dispatches
      .filter((d) => d.sentAt)
      .map((d) => new Date(d.sentAt!).getTime())
      .sort((a, b) => a - b)[0];
    // The first assignment, likewise: a bin reassigned after a release must not
    // report the last pickup as its queue wait.
    const assigned = events
      .filter((e) => e.eventType === 'BIN_ASSIGNED' || e.eventType === 'BIN_TAKEOVER')
      .sort((a, b) => a.at.localeCompare(b.at))[0];
    const assignedAt = assigned ? new Date(assigned.at).getTime() : null;
    const doneAt = bin.completedAt ? new Date(bin.completedAt).getTime() : null;

    const fired = readyAt !== null && firstSent !== undefined ? firstSent - readyAt : null;
    const wait = readyAt !== null && assignedAt !== null ? assignedAt - readyAt : null;
    const work = assignedAt !== null && doneAt !== null ? doneAt - assignedAt : null;
    const total = readyAt !== null && doneAt !== null ? doneAt - readyAt : null;
    if (fired !== null) fires.push(fired);
    if (wait !== null) waits.push(wait);
    if (work !== null) works.push(work);
    if (total !== null) totals.push(total);
    if (bin.state !== 'COMPLETE') stranded.push(`${bin.id}:${bin.state}`);

    const units = (await listBinUnitResults(id)).length;
    const ms = (v: number | null): string => (v === null ? '—' : `${Math.round(v / 100) / 10}s`);
    console.log(
      `  ${id}  ${ms(fired).padStart(11)}  ${ms(wait).padStart(14)}  ${ms(work).padStart(5)}  ` +
        `${ms(total).padStart(10)}  ${String(units).padStart(5)}  ${bin.leaseGeneration}`,
    );
  }

  const stat = (values: number[], label: string): void => {
    if (values.length === 0) {
      console.log(`  ${label.padEnd(16)} —`);
      return;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const p = (v: number): number => Math.round(v / 100) / 10;
    console.log(
      `  ${label.padEnd(16)} median ${p(median)}s  min ${p(sorted[0]!)}s  ` +
        `max ${p(sorted[sorted.length - 1]!)}s  n=${sorted.length}`,
    );
  };
  console.log('');
  stat(fires, 'ready→fired');
  stat(waits, 'queue wait');
  stat(works, 'drain');
  stat(totals, 'ready→done');
  console.log('');
  console.log(`  assignments          ${assignments}`);
  console.log(`  takeovers            ${takeovers}`);
  console.log(`  duplicate activations ${duplicateSends}`);
  console.log(`  completion refusals  ${refusals}`);
  console.log(`  lease expiries       ${leaseExpiries}`);
  console.log(`  fenced stale writes  ${staleWrites}  (refused; >0 is correct behaviour, not a fault)`);
  console.log(`  not complete         ${stranded.length}${stranded.length ? '  ' + stranded.join(' ') : ''}`);
  console.log(
    `  provider errors      ${
      throttles.size === 0 ? 'none' : [...throttles].map(([k, n]) => `${k}×${n}`).join(' ')
    }`,
  );
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

  if (command === 'research-start') {
    /*
     * The real-research acceptance bin.
     *
     * This is deliberately thin. It does not plan anything, decompose
     * anything, or decide what to research: it calls `startPacket`, which is
     * the same function the operator console calls, and then creates a bin
     * pointing at what that returned. There is no second orchestration system
     * here and there must never be one — if this file ever starts making
     * research decisions, the thing it is testing has been replaced by a
     * simulation of itself.
     *
     * `startPacket` queues exactly one planning job and stops. That is §16: a
     * run a person initiated is planned in full and then waits, so the plan can
     * be read before anything is spent. The bin is created READY so Brain
     * dispatches a worker to do that planning — and when the packet lands at
     * AWAITING_APPROVAL the contract refuses with HUMAN, the bin goes
     * NEEDS_HUMAN, and the fleet goes quiet until a person approves.
     */
    const project = await getProjectBySlug(DEAL_DISPATCH_SLUG);
    if (!project) {
      console.log('STEP10 RESEARCH REFUSED: the Deal Dispatch project does not exist.');
      process.exitCode = 1;
      return;
    }
    const layer = (await listLayers(project.id)).find((l) => l.name === 'Monetization Logic');
    if (!layer) {
      console.log('STEP10 RESEARCH REFUSED: no Monetization Logic layer.');
      process.exitCode = 1;
      return;
    }

    const started = await startPacket({
      projectId: project.id,
      layerId: layer.id,
      title: 'Michigan intermediary licensing for a no-real-property business sale',
      assignment: MICHIGAN_LICENSING_ASSIGNMENT,
      // The operator authorized this exact topic, scope, source restriction and
      // execution in advance, so the judgement has already been made and asking
      // again would add a delay rather than a decision. The envelope is named,
      // not supplied — this file cannot widen the limits its own packet will be
      // judged against.
      approval: {
        mode: 'AUTO_WITHIN_ENVELOPE',
        envelopeId: 'STEP10_MICHIGAN_LICENSING_V1',
        authorizedBy: 'operator:step-10-acceptance',
      },
      startedBy: { kind: 'PERSON', id: 'step10-acceptance' },
    });

    const orchestration = started.orchestration;
    const bin = await createBin({
      projectId: project.id,
      layerId: layer.id,
      kind: 'RESEARCH_PACKET',
      title: 'Step 10 acceptance — one real research packet',
      objective:
        'Carry one bounded, genuinely useful research packet from an approved plan to an audited, ' +
        'citable document, with Brain deciding when it is finished.',
      rationale:
        'The synthetic ramp measured dispatch. This measures whether the thing dispatch exists to ' +
        'start can actually do the work.',
      manifest: {
        objective: 'Drain this research packet to its own terminal state.',
        why:
          'Every control this packet passes through belongs to Step 9 and is reused unchanged. ' +
          'What is being tested is that Brain starts the worker and judges the result.',
        lineage: {
          projectId: project.id,
          layerId: layer.id,
          goal: 'Michigan licensing for a success-fee intermediary, no real property transferred.',
          orchestrationId: orchestration.id,
        },
        units: [],
        acceptableSources: [
          'Michigan Occupational Code and its licensing article',
          'Michigan administrative rules',
          'Published LARA or Board guidance and declaratory rulings',
        ],
        excludedSources: [
          'Law-firm articles, association pages and secondary summaries as support for a claim',
          'Other states, federal securities-broker registration, and tax',
        ],
        evidence: [
          'Each in-scope item answered from a quoted primary provision with its citation, or ' +
            'explicitly recorded as unresolved with the search that failed',
        ],
        outputs: ['One filed, audited document with a claim ledger inside it'],
        authorizedActions: [
          'brain_claim_work and the research tools, for work items belonging to this packet',
        ],
        prohibitedActions: [
          'any spend beyond this packet',
          'any work item outside this orchestration',
          'enabling paid overage',
        ],
        budgetUnits: 1,
        retry: { maxAttempts: 3, backoffSeconds: 60 },
        stoppingConditions: [
          'The packet reaches its own terminal state and the filed document has bytes in the store',
        ],
      },
      completionContract: 'RESEARCH_PACKET_V1',
      orchestrationId: orchestration.id,
      createdByType: 'SYSTEM',
      createdById: 'step10-acceptance',
      ready: true,
      priority: 9,
      maxAttempts: 5,
    });

    console.log('STEP10 RESEARCH');
    console.log(`  project        ${project.slug} ${project.id}`);
    console.log(`  layer          ${layer.name} ${layer.id}`);
    console.log(`  orchestration  ${orchestration.id}  ${orchestration.status}`);
    console.log(`  run            ${started.run.id}`);
    console.log(`  bin            ${bin.id}  ${bin.state}`);
    console.log(`  archive census ${JSON.stringify(started.archive)}`);
    console.log(`STEP10: OK research-start orchestration=${orchestration.id} bin=${bin.id}`);
    return;
  }

  if (command === 'audit-packet') {
    /*
     * The Step 11 acceptance packet. One question, one fragment, one use.
     *
     * Its own project, so an acceptance run never files into one holding real
     * research, and its own frozen envelope, which pins this exact assignment
     * by digest and is spent by its first approval. The human authorization is
     * the instruction that defined the envelope; the planner is not approving
     * itself, because the limits were fixed in code before any plan existed.
     */
    const project =
      (await getProjectBySlug(STEP11_SLUG)) ??
      (await createProject({
        name: 'Step 11 acceptance',
        slug: STEP11_SLUG,
        description:
          'Created by scripts/step10.ts for the Step 11 audit-independence acceptance. Holds one ' +
          'packet so that proving a lease guard never puts an acceptance document into a project ' +
          'with real research in it.',
        purpose: 'TECHNICAL',
      }));
    const layers = await listLayers(project.id);
    const layer =
      layers.find((candidate) => candidate.slug === STEP11_LAYER_SLUG) ??
      (await createLayer({
        projectId: project.id,
        name: 'Delaware entity obligations',
        slug: STEP11_LAYER_SLUG,
        orderIndex: layers.length,
      }));

    const started = await startPacket({
      projectId: project.id,
      layerId: layer.id,
      title: 'Delaware LLC annual tax under 6 Del. C. §18-1107',
      assignment: STEP11_AUDIT_INDEPENDENCE_ASSIGNMENT,
      approval: {
        mode: 'AUTO_WITHIN_ENVELOPE',
        envelopeId: 'STEP11_AUDIT_INDEPENDENCE_V1',
        authorizedBy: 'operator:step-11-audit-independence-instruction',
      },
      startedBy: { kind: 'PERSON', id: 'step11-audit-independence' },
    });

    const orchestration = started.orchestration;
    const bin = await createBin({
      projectId: project.id,
      layerId: layer.id,
      kind: 'RESEARCH_PACKET',
      title: 'Step 11 acceptance — audit independence on a real packet',
      objective:
        'Carry one small real research packet to a verdict whose three audit roles ran on ' +
        'independent execution lineages that Brain enforced before each lease.',
      rationale:
        'Step 11 proved routing. This proves the roles Brain hands out cannot be taken by one ' +
        'surface, on work that is real rather than synthetic.',
      manifest: {
        objective: 'Drain this research packet to its own terminal state.',
        why: 'The audit roles must land on separate accounts and separate sessions.',
        lineage: {
          projectId: project.id,
          layerId: layer.id,
          goal: 'The Delaware LLC annual tax and its due date, from the statute.',
          orchestrationId: orchestration.id,
        },
        units: [],
        acceptableSources: ['The Delaware Code, title 6', "Delaware's own published state guidance"],
        excludedSources: [
          'Law-firm articles, registered-agent pages and any secondary summary as support for a claim',
          'Any other state, and anything federal',
        ],
        evidence: ['The exact section and the relied-upon passage, quoted'],
        outputs: ['One filed, audited document with a claim ledger inside it'],
        authorizedActions: [
          'brain_claim_work and the research tools, for work items belonging to this packet',
        ],
        prohibitedActions: [
          'any spend beyond this packet',
          'any work item outside this orchestration',
          'enabling paid overage',
          'any purchase, contact, filing or other irreversible external action',
        ],
        budgetUnits: 1,
        retry: { maxAttempts: 3, backoffSeconds: 60 },
        stoppingConditions: [
          'The packet reaches its own terminal state and the filed document has bytes in the store',
        ],
      },
      completionContract: 'RESEARCH_PACKET_V1',
      orchestrationId: orchestration.id,
      createdByType: 'SYSTEM',
      createdById: 'step11-audit-independence',
      ready: true,
      priority: 9,
      maxAttempts: 5,
    });

    console.log('STEP11 AUDIT PACKET');
    console.log(`  project        ${project.slug} ${project.id}`);
    console.log(`  layer          ${layer.name} ${layer.id}`);
    console.log(`  orchestration  ${orchestration.id}  ${orchestration.status}`);
    console.log(`  bin            ${bin.id}  ${bin.state}`);
    console.log(`STEP10: OK audit-packet orchestration=${orchestration.id} bin=${bin.id}`);
    return;
  }

  if (command === 'audit-lineage') {
    /*
     * What the audit roles actually ran on, read from rows.
     *
     * The point of the whole exercise is that this is answerable without
     * trusting anybody's account of it: the lineage is on the pass, and the
     * matrix is applied to what is there.
     */
    const orchestrationId = arg(0);
    if (!orchestrationId) return refuseStep10('pass an orchestration id.');
    const passes = (await listPasses(orchestrationId)).filter((pass) => pass.passKey === 'AUDIT');
    const roleOf: Record<number, string> = { 5: 'PRIMARY', 6: 'ADVERSARIAL', 7: 'JUDGE' };
    console.log('STEP11 AUDIT LINEAGE');
    for (const pass of passes) {
      console.log(
        `  ${roleOf[pass.ordinal] ?? `ordinal ${pass.ordinal}`}  ${pass.status}` +
          `  worker=${pass.executorWorkerId ?? '—'}` +
          `  routine=${pass.executorRoutineId ?? '—'}` +
          `  account=${pass.executorAccountId ?? '—'}` +
          `  session=${pass.executorSessionRef ?? '—'}`,
      );
    }
    const verdict = auditMatrixVerdict(passes);
    for (const applied of verdict.applied) {
      console.log(`  applied    ${applied.pair} at ${applied.level}`);
    }
    for (const reason of verdict.reasons) console.log(`  VIOLATION  ${reason}`);
    console.log(`STEP10: OK audit-lineage compliant=${verdict.eligible} passes=${passes.length}`);
    if (!verdict.eligible) process.exitCode = 1;
    return;
  }

  if (command === 'research-ready') {
    // After a person approves the plan. The bin was parked at NEEDS_HUMAN
    // precisely because a person had to decide; this is that decision landing,
    // and nothing else about the bin changes.
    const id = arg(0);
    if (!id) {
      console.log('STEP10 REFUSED: pass the bin id.');
      process.exitCode = 1;
      return;
    }
    const before = await getBin(id);
    if (!before) {
      console.log('STEP10 REFUSED: no such bin.');
      process.exitCode = 1;
      return;
    }
    if (before.orchestrationId) {
      const packet = await getOrchestration(before.orchestrationId);
      console.log(`  packet ${before.orchestrationId} is ${packet?.status ?? 'missing'}`);
      if (packet && packet.status === 'AWAITING_APPROVAL') {
        console.log('STEP10 REFUSED: that packet is still awaiting approval. Approve it first.');
        process.exitCode = 1;
        return;
      }
    }
    /*
     * Two paths, because there are two reasons a bin is not dispatchable, and
     * printing the resulting state for both is how this command lied.
     *
     * It used to call `markBinReady` and then report `was=… now=…`, which is a
     * *description* rather than an assertion. `markBinReady` matches `DRAFT`
     * only, so pointed at a `NEEDS_HUMAN` bin it changed nothing and printed
     * `was=NEEDS_HUMAN now=NEEDS_HUMAN` under a `STEP10: OK` line — and the
     * workflow's gate greps for exactly that line. A no-op reported as a
     * success cost a full activation window of waiting on a bin that had never
     * moved, and it would have gone on costing one every time.
     *
     * So: a drafted bin is made ready, an escalated one is *reopened* through
     * the guarded transition, and either way the exit code follows whether a
     * row actually changed.
     */
    if (before.state === 'NEEDS_HUMAN') {
      const outcome = await reopenParkedBin({
        binId: id,
        operator: `operator:${SLUG}`,
        reason: arg(1)
          ? arg(1)!.replace(/_/g, ' ')
          : 'Reopened by the operator after the condition this bin escalated on was resolved.',
      });
      if (!outcome.ok) {
        console.log(`STEP10 REFUSED: research-ready ${id} ${outcome.refusal} — ${outcome.reason}`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `  reopened    ${id} ${outcome.previousState} → ${outcome.bin.state}, ` +
          `generation ${outcome.previousGeneration} → ${outcome.generation}, ` +
          `attempts ${outcome.bin.attemptCount}/${outcome.bin.maxAttempts} unchanged`,
      );
      console.log(
        `STEP10: OK research-ready ${id} reopened=true state=${outcome.bin.state} ` +
          `gen=${outcome.generation}`,
      );
      return;
    }

    const after = await markBinReady(id);
    if (after?.state !== 'READY') {
      console.log(
        `STEP10 REFUSED: research-ready ${id} did not transition. It is ${before.state}; ` +
          'only a DRAFT bin is made ready here, and only a NEEDS_HUMAN one is reopened.',
      );
      process.exitCode = 1;
      return;
    }
    console.log(`STEP10: OK research-ready ${id} was=${before.state} now=${after.state}`);
    return;
  }

  if (command === 'regrant') {
    /*
     * Restore a bin's assignment budget after Brain wasted it.
     *
     * The real-research bin was dispatched three times into a confinement bug
     * that left it nothing to claim. Those three attempts measure a fault in
     * Brain rather than a fault in the packet, and letting them retire a live
     * packet would be the platform blaming the work for its own defect. The
     * ceiling goes up; the count and its history stay exactly where they are.
     */
    const id = arg(0);
    const to = Number(arg(1) ?? '0');
    /*
     * The upper bound is 100 rather than 25, and the reason is arithmetic.
     *
     * A bin's attempt count is its *assignment* count, and a long research
     * packet is inherently many assignments: four fragments, their
     * verifications, a synthesis and three audit roles, across sessions that
     * each end when their allowance does. Twenty-five was picked when the only
     * bins were three-unit deterministic ones that drained in a single
     * activation, and the real packet reached it having spent twenty-four
     * assignments on defects and a blocked network — leaving one for the work.
     * A ceiling that has to be raised every few activations is a ceiling that
     * stops being read and starts being clicked through.
     */
    if (!id || !Number.isInteger(to) || to < 1 || to > 100) {
      console.log('STEP10 REFUSED: pass a bin id and a new ceiling between 1 and 100.');
      process.exitCode = 1;
      return;
    }
    const before = await getBin(id);
    if (!before) {
      console.log('STEP10 REFUSED: no such bin.');
      process.exitCode = 1;
      return;
    }
    /*
     * Why the budget went, in the words that are actually true of this bin.
     *
     * The first version hardcoded "a Brain-side confinement defect", which was
     * true of the first two regrants and became false for the third: thirteen
     * of that bin's assignments went to an execution-surface failure, which is
     * not a defect in Brain at all. An audit row that records the wrong cause
     * is worse than one that records none, because it is the row somebody will
     * believe later. A closed set of codes, because the workflow that calls
     * this can only pass letters and dashes — and because a free-text reason
     * here would be a caller writing its own audit trail.
     */
    const REASONS: Record<string, string> = {
      'platform-defect':
        'Attempts spent on a Brain-side defect that left the bin nothing to claim — the queue ' +
        'confinement excluded the packet\'s own work, and the plan tool told every worker to ' +
        'wait for a person. Not spent on the packet failing.',
      'surface-blocked':
        'Attempts spent on an execution-surface failure — the worker could reach Brain and not ' +
        'the sources — which the operator has since corrected and a SURFACE_PROBE_V1 bin has ' +
        'evidenced. Not spent on the packet failing.',
    };
    const code = arg(2) ?? 'platform-defect';
    const reason = REASONS[code];
    if (!reason) {
      console.log(
        `STEP10 REFUSED: unknown reason code "${code}". One of: ${Object.keys(REASONS).join(', ')}.`,
      );
      process.exitCode = 1;
      return;
    }
    const outcome = await regrantBinAttempts({ binId: id, maxAttempts: to, reason });
    console.log(
      `STEP10: OK regrant ${id} raised=${outcome.raised} ` +
        `attempts=${outcome.bin?.attemptCount ?? '—'}/${outcome.bin?.maxAttempts ?? '—'} ` +
        `was=${before.attemptCount}/${before.maxAttempts}`,
    );
    return;
  }

  if (command === 'probe') {
    /*
     * Ask a fired worker what its execution surface can actually reach.
     *
     * The real research packet died because the worker could not reach the
     * sources, and every activation reported it as "blocked" — one word for
     * four different facts with four different remedies. This bin makes the
     * worker say which, per host, in a vocabulary Brain checks.
     *
     * The hosts are the publishers of the source classes the packet's
     * assignment already authorises — the Compiled Laws, the Administrative
     * Code, and the regulator's own site. Naming three of them broadens
     * nothing: they are three doors into the same authorised evidence, and the
     * point of asking about all three is that a publisher refusing a robot is
     * a different problem from a surface that cannot reach anything.
     */
    const projectId = await scope();
    const hosts = [
      {
        key: 'mcl',
        host: 'https://www.legislature.mi.gov/Laws/MCL?objectName=mcl-339-2501',
        establishes:
          'Whether the Michigan Compiled Laws, as published by the Legislature, can be ' +
          'retrieved from this worker\'s execution surface.',
      },
      {
        key: 'admin-rules',
        host: 'https://ars.apps.lara.state.mi.us/AdminCode/DeptBureauAdminCode?Department=Licensing%20and%20Regulatory%20Affairs',
        establishes:
          'Whether the Michigan Administrative Code (the R rules), as published by LARA, can ' +
          'be retrieved from this worker\'s execution surface.',
      },
      {
        key: 'lara',
        host: 'https://www.michigan.gov/lara',
        establishes:
          'Whether the Department of Licensing and Regulatory Affairs\' own publications can ' +
          'be retrieved from this worker\'s execution surface.',
      },
    ];

    const bin = await createBin({
      projectId,
      kind: 'SURFACE_PROBE',
      title: 'What can this worker surface reach?',
      objective:
        'Establish, per host, exactly which of five outcomes this worker\'s execution surface ' +
        'produces when it tries to retrieve a Michigan primary-law source.',
      rationale:
        'A research packet was blocked by an execution-surface failure. Whether that is still ' +
        'true, and if not which hosts are now reachable, is a fact about the surface rather ' +
        'than about the research, and it has to be established before anything is re-run.',
      manifest: {
        objective:
          'Retrieve each declared host and record which of the five outcomes occurred.',
        why:
          'Four different failures were being reported as one. They have different remedies: a ' +
          'surface that refuses the host is an operator configuration; a host that refuses the ' +
          'client, or excludes robots, means use another authorised publisher of the same law.',
        lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
        units: hosts.map((entry) => ({
          key: entry.key,
          establishes: entry.establishes,
          input: entry.host,
          transform: 'probe',
          dependsOn: [],
        })),
        acceptableSources: ['The declared URL itself, fetched directly'],
        excludedSources: [
          'Any cached, mirrored or third-party copy — the question is what THIS surface reaches',
          'Search-engine result pages standing in for the document',
        ],
        evidence: [
          'For each unit, submit a value whose FIRST WORD is exactly one of: RETRIEVED, ' +
            'HOST_NOT_ALLOWED, ORIGIN_REJECTED, ROBOTS_RESTRICTED, OTHER_FAILURE.',
          'RETRIEVED means the document body came back. Follow it with the final URL, the HTTP ' +
            'status, the byte count, and a short verbatim phrase from the page proving it is the ' +
            'real document rather than an error page.',
          'HOST_NOT_ALLOWED means your own environment refused the request before it left — an ' +
            'allowlist or policy refusal naming the host. Quote the exact error.',
          'ORIGIN_REJECTED means the host answered and refused you: 403, a bot wall, a captcha, ' +
            'a challenge page. Give the status and what it said.',
          'ROBOTS_RESTRICTED means robots.txt or an equivalent policy excludes automated ' +
            'retrieval of that path. Quote the directive.',
          'OTHER_FAILURE is anything else — DNS, TLS, timeout, 5xx. Say which.',
          'Do not guess and do not infer from a previous session. Actually try each one now.',
        ],
        outputs: ['One reading per declared host, in that vocabulary'],
        authorizedActions: [
          'Retrieving the declared URLs, read-only',
          'brain_bin_submit_unit for each declared key',
        ],
        prohibitedActions: [
          'any spend',
          'any request that is not a read of a declared host',
          'submitting a reading you did not actually observe this session',
        ],
        budgetUnits: 1,
        retry: { maxAttempts: 3, backoffSeconds: 30 },
        stoppingConditions: ['every declared host has a reading in the declared vocabulary'],
      },
      completionContract: 'SURFACE_PROBE_V1',
      createdByType: 'SYSTEM',
      createdById: 'step10-surface-probe',
      ready: true,
      priority: 10,
      maxAttempts: 6,
    });

    console.log('STEP10 PROBE');
    console.log(`  project  ${SLUG} ${projectId}`);
    console.log(`  bin      ${bin.id}  ${bin.state}`);
    for (const entry of hosts) console.log(`  host     ${entry.key.padEnd(12)} ${entry.host}`);
    console.log(`STEP10: OK probe bin=${bin.id}`);
    return;
  }

  if (command === 'probe-read') {
    const id = arg(0);
    const bin = id ? await getBin(id) : null;
    if (!bin) {
      console.log('STEP10 REFUSED: pass the probe bin id.');
      process.exitCode = 1;
      return;
    }
    const verdict = await evaluateContract(bin);
    console.log(`PROBE ${bin.id}  ${bin.state}  attempts ${bin.attemptCount}/${bin.maxAttempts}`);
    console.log(`  contract ${bin.completionContract} satisfied=${verdict.satisfied} ${verdict.disposition}`);
    for (const reason of verdict.reasons) console.log(`    ${reason}`);
    console.log('');
    for (const reading of await readSurfaceProbe(bin)) {
      console.log(`  ${reading.unitKey.padEnd(12)} ${reading.outcome.padEnd(18)} ${reading.host}`);
      console.log(`      at ${reading.recordedAt}  by ${reading.submittedBy ?? '—'}`);
      if (reading.detail) console.log(`      ${reading.detail.slice(0, 300)}`);
    }
    console.log('');
    console.log(`STEP10: OK probe-read bin=${bin.id} state=${bin.state}`);
    return;
  }

  if (command === 'recover') {
    /*
     * The narrowest way back for a fragment the surface broke.
     *
     * Everything that decides whether this is allowed is in
     * `recoverFragmentAfterSurfaceChange`; this only names the fragment and the
     * probe that evidences the change. A refusal is printed in full, because a
     * refusal here is the mechanism working and the reasons are the whole
     * content of it.
     */
    const fragmentKey = arg(0);
    const probeBinId = arg(1);
    if (!fragmentKey || !probeBinId) {
      console.log('STEP10 REFUSED: pass a fragment key and the SURFACE_PROBE_V1 bin id.');
      process.exitCode = 1;
      return;
    }
    const orchestrationId = arg(2);
    if (!orchestrationId) {
      console.log('STEP10 REFUSED: pass the orchestration id as the third argument.');
      process.exitCode = 1;
      return;
    }
    try {
      const result = await recoverFragmentAfterSurfaceChange({
        fragmentKey,
        orchestrationId,
        probeBinId,
        reason:
          'The operator changed the worker Routine environment\'s network access from Trusted ' +
          'to Full, and a fired worker then reached a Michigan primary-law publisher that the ' +
          'blocked attempts could not.',
        actor: { type: 'SYSTEM', id: 'step10-surface-recovery' },
        grantAttempts: 2,
      });
      console.log('STEP10 RECOVER');
      console.log(`  fragment    ${result.fragmentKey}`);
      console.log(`  attempts    history ends at ${result.attemptBefore}; new attempt ${result.attemptAfter}`);
      console.log(`  ceiling     ${result.maxRepairsBefore} -> ${result.maxRepairsAfter}`);
      console.log(`  probe       ${result.probeBinId}  reached [${result.reachedHosts.join(', ')}]`);
      console.log(`  unblocked   [${result.unblockedDependents.join(', ')}]`);
      console.log(`  advanced    ${result.advanced?.status ?? '—'} enqueued ${result.advanced?.enqueued.length ?? 0}`);
      console.log(`STEP10: OK recover fragment=${result.fragmentKey} attempt=${result.attemptAfter}`);
    } catch (error) {
      if (error instanceof SurfaceRecoveryRefused) {
        console.log('STEP10 RECOVER REFUSED');
        for (const reason of error.reasons) console.log(`  - ${reason}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    return;
  }

  if (command === 'admins') {
    /*
     * Who can sign an authorization, read from the rows.
     *
     * Not a convenience. Two of this harness's operator actions — authorizing a
     * packet to record its gaps, and anything else that must carry a person's
     * name — resolve an administrator and refuse without one, and the address
     * they resolve is not written down anywhere in this repository on purpose.
     * Without this the only ways to learn it are the admin console, which needs
     * the address to sign in, and a database console, which is the thing §2
     * exists to avoid.
     *
     * Reaching this shell is already the authentication, and the console shows
     * an administrator the list of people anyway. Addresses and ids only: no
     * digest, no verifier, no session, no worker credential.
     */
    const users = await listUsers();
    const admins = users.filter((user) => user.isBrainAdmin);
    for (const user of admins) {
      console.log(
        `  ${user.id}  ${user.email}${user.disabledAt ? `  DISABLED ${user.disabledAt}` : ''}`,
      );
    }
    const enabled = admins.filter((user) => !user.disabledAt).length;
    console.log(`STEP10: OK admins total=${admins.length} enabled=${enabled}`);
    return;
  }

  if (command === 'gap-policy') {
    /*
     * The same authorization `npm run authorize:gap-policy` performs, addressed
     * by user id rather than by email.
     *
     * Not a second mechanism: it calls `authorizeUnresolvedGaps` and then
     * `advancePacket`, exactly as the script does, and the audit row it leaves
     * is identical. What differs is only how the person is named, and the
     * reason is unglamorous — the workflow that reaches this shell restricts
     * its arguments to letters, digits, dash and underscore so that an input
     * can never be interpolated into a command line as anything else, and an
     * email address does not fit that alphabet. A `usr_` id does.
     *
     * The decision is still a person's and still recorded against them: the id
     * is resolved against the database, a disabled account is refused, and a
     * non-administrator is refused.
     */
    const orchestrationId = arg(0);
    const adminId = arg(1);
    if (!orchestrationId || !adminId) {
      console.log('STEP10 REFUSED: pass the orchestration id and the administrator user id.');
      process.exitCode = 1;
      return;
    }
    const admin = await getUser(adminId);
    if (!admin || !admin.isBrainAdmin || admin.disabledAt) {
      // One message for "no such account", "not an administrator" and
      // "disabled". Invariant 23 at a smaller boundary: a refusal here must not
      // tell a caller which user ids exist.
      console.log(`STEP10 REFUSED: ${adminId} cannot authorize anything on this Brain.`);
      process.exitCode = 1;
      return;
    }
    const before = await getOrchestration(orchestrationId);
    if (!before) {
      console.log('STEP10 REFUSED: no such orchestration.');
      process.exitCode = 1;
      return;
    }
    console.log(`  packet      ${before.id} — ${before.title}`);
    console.log(`  status      ${before.status}`);
    const result = await authorizeUnresolvedGaps({
      orchestrationId,
      authorizedBy: { id: admin.id, email: admin.email },
    });
    console.log(
      `  ${result.status === 'AUTHORIZED' ? 'authorized ' : 'already    '} RECORD_GAPS by ` +
        `${admin.email} at ${result.orchestration.unresolvedGapAuthorizedAt}`,
    );
    const advanced = await advancePacket(orchestrationId);
    console.log(
      `  advanced    ${advanced.status}${advanced.waitingOn ? ` — ${advanced.waitingOn}` : ''}`,
    );
    console.log(`STEP10: OK gap-policy ${result.status} status=${advanced.status}`);
    return;
  }

  if (command === 'cf8') {
    /*
     * CF-8, answered from rows rather than from confidence.
     *
     * Step 8 issued refresh tokens for thirty days, implemented the rotation
     * grant and tested it, and recorded that **nothing had exercised it live**.
     * Step 9 decomposed a packet into items each far shorter than an hour and
     * assigned the question here. Step 10's own plan lists it as the second
     * thing a long unattended run could finally observe.
     *
     * The observation needs no new instrumentation, because Step 8 already
     * recorded the thing that settles it: an ACCESS token carries
     * `parent_token_id` when it was minted by a refresh rather than by an
     * authorization code. So a chained access token that has been *used* is a
     * client that refreshed and carried on — which is the whole claim.
     *
     * Prints no digest, no prefix, no scope value and no client secret. A
     * report about credentials must not become a way to read them.
     */
    const workers = await listWorkers();
    let chained = 0;
    let chainedAndUsed = 0;
    let roots = 0;
    console.log('CF-8 — did a client actually refresh an expiring access token?');
    for (const worker of workers) {
      const tokens = await listTokensForWorker(worker.id);
      if (tokens.length === 0) continue;
      console.log('');
      console.log(`  worker ${worker.name} (${worker.id})`);
      for (const token of tokens) {
        const rotated = token.parentTokenId !== null;
        if (token.kind === 'ACCESS') {
          if (rotated) chained += 1;
          else roots += 1;
          if (rotated && token.lastUsedAt) chainedAndUsed += 1;
        }
        console.log(
          `    ${token.kind.padEnd(7)} issued ${token.createdAt}  expires ${token.expiresAt}` +
            `  used ${token.lastUsedAt ?? 'never'}` +
            `  ${rotated ? `rotated from ${token.parentTokenId}` : 'from an authorization code'}` +
            (token.revokedAt ? `  revoked ${token.revokedAt}` : ''),
        );
      }
    }
    console.log('');
    console.log(`  access tokens from an authorization code : ${roots}`);
    console.log(`  access tokens minted by a refresh        : ${chained}`);
    console.log(`  ...of those, actually used               : ${chainedAndUsed}`);
    console.log('');
    console.log(
      chainedAndUsed > 0
        ? '  VERDICT: a client refreshed an access token and went on using it. CF-8 is observed.'
        : '  VERDICT: no refreshed access token has been used. CF-8 remains unobserved — which is\n' +
          '           a finding, not a failure: it means no session has yet outlived its token.',
    );
    console.log(`STEP10: OK cf8 rotated=${chained} used=${chainedAndUsed} roots=${roots}`);
    return;
  }

  if (command === 'cancel-ready') {
    /*
     * Cancel the READY bins of an abandoned rung, with an interlock.
     *
     * The dangerous version of this command is the one that takes a filter and
     * trusts it. This one takes the number the caller believes it will cancel
     * and refuses outright if the project disagrees, so a rung that drained
     * while the operator was deciding, or a bin somebody added meanwhile,
     * stops the whole thing instead of being swept up in it.
     *
     * Three further limits, none of them optional:
     *   - it resolves the acceptance project by slug, so Deal Dispatch is not
     *     addressable from here at all;
     *   - `terminateUnleasedBin` is CAS-guarded on the generation and matches
     *     only READY or DRAFT, so a bin a worker holds cannot be cancelled out
     *     from under it, and a COMPLETE one cannot be rewritten;
     *   - nothing is deleted. The bin keeps its events, its unit results and
     *     its dispatch rows, RATE_LIMIT errors included, because the point of
     *     cancelling a measured rung is to stop it firing, not to lose what it
     *     measured.
     */
    const projectId = (await getProjectBySlug(SLUG))?.id;
    if (!projectId) {
      console.log('STEP10: OK cancel-ready cancelled=0 (no acceptance project)');
      return;
    }
    const expected = Number(arg(0) ?? 'NaN');
    if (!Number.isInteger(expected) || expected < 0) {
      console.log('STEP10 CANCEL REFUSED: pass the exact number of READY bins you expect.');
      process.exitCode = 1;
      return;
    }
    const ready = await listBins({ projectId, states: ['READY'], limit: 500 });
    if (ready.length !== expected) {
      console.log(
        `STEP10 CANCEL REFUSED: expected ${expected} READY bins, found ${ready.length}. ` +
          'Nothing was changed.',
      );
      for (const bin of ready) console.log(`  ${bin.id}  ${bin.title}`);
      process.exitCode = 1;
      return;
    }
    let cancelled = 0;
    for (const bin of ready) {
      const ok = await terminateUnleasedBin(
        bin.id,
        bin.leaseGeneration,
        'CANCELLED',
        'Synthetic ramp bin cancelled by the operator after the provider ceiling was measured. ' +
          'Telemetry and dispatch history are kept.',
      );
      if (ok) cancelled += 1;
      console.log(`  ${ok ? 'cancelled' : 'skipped  '} ${bin.id}  ${bin.title}`);
    }
    console.log(`STEP10: OK cancel-ready cancelled=${cancelled} of ${ready.length}`);
    return;
  }

  if (command === 'cancel-bin') {
    // One named bin, and only inside the acceptance project — a bin id from
    // anywhere else is refused rather than looked up.
    const projectId = (await getProjectBySlug(SLUG))?.id;
    const id = arg(0);
    if (!id || !projectId) {
      console.log('STEP10 CANCEL REFUSED: pass a bin id.');
      process.exitCode = 1;
      return;
    }
    const bin = await getBin(id);
    if (!bin || bin.projectId !== projectId) {
      console.log('STEP10 CANCEL REFUSED: that bin is not in the acceptance project.');
      process.exitCode = 1;
      return;
    }
    const reason =
      'Acceptance test bin retired by the operator. It was broken deliberately, it did its job, ' +
      'and its failure history is kept as the evidence for it.';
    const ok =
      bin.state === 'NEEDS_HUMAN'
        ? await resolveNeedsHumanBin(bin.id, bin.leaseGeneration, 'CANCELLED', reason)
        : await terminateUnleasedBin(bin.id, bin.leaseGeneration, 'CANCELLED', reason);
    console.log(`STEP10: OK cancel-bin ${bin.id} was=${bin.state} cancelled=${ok}`);
    return;
  }

  if (command === 'prompt') {
    // Printed from the constant, never kept as a second copy of it.
    //
    // A routine holds its own copy of this text, made when it was created, and
    // Brain can neither see nor fix drift in it — so the one thing that must
    // not happen is a *third* copy sitting in the repository going stale. When
    // somebody has to recreate a routine, they should be reading today's
    // prompt out of today's deployment.
    //
    // Gated on the contract the instructions are supposed to satisfy: a prompt
    // that names an id, a project or a subject is one this platform must never
    // hand anybody, and refusing here costs a round trip where shipping it
    // costs a worker that thinks it has an assignment of its own.
    const problems = instructionProblems();
    if (problems.length > 0) {
      console.log(`STEP10 PROMPT REFUSED version=${WORKER_INSTRUCTIONS_VERSION}`);
      for (const problem of problems) console.log(`  ${problem}`);
      process.exitCode = 1;
      return;
    }
    console.log(`STEP10 PROMPT version=${WORKER_INSTRUCTIONS_VERSION}`);
    console.log('--- begin ---');
    console.log(WORKER_INSTRUCTIONS);
    console.log('--- end ---');
    console.log(`STEP10: OK prompt version=${WORKER_INSTRUCTIONS_VERSION}`);
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
    // The number that decides whether this bin will ever be handed out again,
    // and the one this trace did not print. Working it out meant counting
    // BIN_ASSIGNED events by hand, which is how an hour of a live packet
    // sitting still got mistaken for a dispatcher that had stopped.
    console.log(
      `  attempts   ${bin.attemptCount}/${bin.maxAttempts}` +
        (bin.attemptCount >= bin.maxAttempts
          ? '  — spent, so nothing will be dispatched or assigned until it is regranted'
          : ''),
    );
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

  if (command === 'turn-trace') {
    /*
     * One Russell turn, end to end, read-only — and deliberately without a
     * word of anybody's conversation in it.
     *
     * The question an operator actually has when an answer does not appear is
     * structural: was a message stored, did it produce a bin, was the bin
     * dispatched, did a session arrive, did it complete, and was an answer
     * written back. Every one of those is an id, a state or a timestamp.
     *
     * **It prints no message content.** §24's boundary is that a machine must
     * not read somebody's private thread, and the fact that this runs as the
     * operator rather than as a worker is not a licence to turn it into a
     * transcript reader. Ids, roles, states, reasons the server itself wrote,
     * and times. That is enough to locate a break and not enough to read a
     * conversation.
     *
     * The link from a turn to its bin is `bins.created_by_id`, which
     * `beginTurn` writes as `russell:turn:<messageId>` — a real foreign
     * reference rather than a title match.
     */
    const project = await getProjectBySlug('deal-dispatch');
    if (!project) {
      console.log('STEP10: OK turn-trace project=deal-dispatch found=false');
      return;
    }
    const limit = Number(arg(0) ?? '8');
    const messages = await getDb().all<{
      id: string;
      conversation_id: string;
      role: string;
      status: string;
      pending_reason: string | null;
      created_at: string;
      updated_at: string;
      chars: number;
    }>(
      `SELECT m.id, m.conversation_id, m.role, m.status, m.pending_reason,
              m.created_at, m.updated_at, LENGTH(m.content) AS chars
         FROM russell_messages m
         JOIN russell_conversations c ON c.id = m.conversation_id
        WHERE c.project_id = ?
        ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT ?`,
      [project.id, Math.min(60, Math.max(1, Number.isFinite(limit) ? limit : 8))],
    );

    console.log(`TURN TRACE  project ${project.slug} ${project.id}`);
    console.log('  (content is deliberately not printed; lengths only)');
    console.log('');
    for (const message of messages) {
      console.log(
        `  ${message.created_at}  ${message.role.padEnd(7)} ${message.status.padEnd(8)} ` +
          `${String(message.chars).padStart(5)} chars  conv ${message.conversation_id}  ${message.id}`,
      );
      if (message.pending_reason) console.log(`      pending: ${message.pending_reason}`);
      if (message.updated_at !== message.created_at) {
        console.log(`      settled: ${message.updated_at}`);
      }
      const bins = await getDb().all<{ id: string }>(
        `SELECT id FROM bins WHERE created_by_id = ?`,
        [`russell:turn:${message.id}`],
      );
      for (const row of bins) {
        const bin = await getBin(row.id);
        if (!bin) continue;
        console.log(
          `      bin ${bin.id}  ${bin.state}  gen ${bin.leaseGeneration}  ` +
            `attempts ${bin.attemptCount}/${bin.maxAttempts}  workload ${bin.workloadClass ?? '—'}`,
        );
        console.log(
          `          worker ${bin.workerId ?? '—'}  session ${bin.leaseSessionRef ?? '—'}  ` +
            `completed ${bin.completedAt ?? '—'}`,
        );
        if (bin.terminalReason) console.log(`          terminal ${bin.terminalReason.slice(0, 120)}`);
        for (const dispatch of await listDispatchesForBin(bin.id)) {
          console.log(
            `          dispatch gen ${dispatch.leaseGeneration} ${dispatch.state} ` +
              `routine ${dispatch.routineRef ?? '—'} sent ${dispatch.sentAt ?? '—'} ` +
              `session ${dispatch.sessionRef ?? '—'}`,
          );
        }
        for (const event of await listBinEvents(bin.id, 60)) {
          console.log(
            `          ${event.at}  ${event.eventType.padEnd(22)} ` +
              `worker ${(event.workerId ?? '—').padEnd(24)} session ${event.sessionRef ?? '—'}`,
          );
        }
        for (const unit of await listBinUnitResults(bin.id)) {
          console.log(
            `          unit ${unit.unitKey} ${unit.contentHash.slice(0, 16)} ` +
              `by ${unit.submittedBy ?? '—'} ${unit.createdAt}`,
          );
        }
      }
      console.log('');
    }
    console.log(`STEP10: OK turn-trace messages=${messages.length}`);
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

/**
 * The operator's hands on the Software Factory.
 *
 * Registering a worker, submitting an objective, approving it, installing a
 * plan, running a campaign to a stop, and answering the release. Everything here
 * is an operator action on purpose: a surface that can execute code is granted by
 * a person where that worker runs, and the registry row is the second half of
 * that grant rather than something a campaign can arrange for itself.
 *
 *   npm run factory -- fleet
 *   npm run factory -- register --name local-1 --capabilities IMPLEMENT,REVIEW
 *   npm run factory -- submit --project <id> --file objective.json
 *   npm run factory -- approve --change-request <id>
 *   npm run factory -- plan --campaign <id> --file plan.json
 *   npm run factory -- run --campaign <id> --max-ticks 40
 *   npm run factory -- status --campaign <id>
 *   npm run factory -- release --campaign <id> --decision APPROVED
 */
import fs from 'node:fs';
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { listProjects } from '../server/repos/projects.ts';
import { listUsers } from '../server/repos/identity.ts';
import {
  ensureCampaign,
  getCampaign,
  getCampaignByChangeRequest,
  getChangeRequest,
  listCampaigns,
  listUnits,
} from '../server/repos/factory.ts';
import {
  answerRelease,
  getRelease,
  listFactoryEvents,
  listFindings,
  listReviews,
  listSessions,
  listWorkers,
} from '../server/repos/factoryFleet.ts';
import { amendContract, approveObjective, submitObjective } from '../server/services/factory/contract.ts';
import {
  capacity,
  probeFleet,
  readiness,
  register,
  RegistryError,
  setAvailability,
  WORKER_STATE_REASONS,
  type WorkerStateReason,
} from '../server/services/factory/registry.ts';
import { INITIAL_LANE_TARGET } from '../server/services/factory/scheduler.ts';
import { installPlan, validatePlan } from '../server/services/factory/planner.ts';
import { runCampaign, tickAllCampaigns, tickCampaign } from '../server/services/factory/loop.ts';
import { campaignMetrics, FACTORY_EVENT_KINDS } from '../server/services/factory/metrics.ts';
import { throughputReport } from '../server/services/factory/throughput.ts';
import { pullRequestFor } from '../server/services/factory/pullRequest.ts';
import type { FactoryCapability, FactoryWorkerKind } from '../server/domain/factory.ts';
import { campaignSpecFor } from '../server/services/factory/remote.ts';
import {
  tickAllRemoteCampaigns,
  tickRemoteCampaign,
} from '../server/services/factory/remoteLoop.ts';

interface Args {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const command = argv[0] ?? 'help';
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

function flagString(flags: Args['flags'], key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  await initDatabase();

  switch (command) {
    case 'fleet': {
      const workers = await listWorkers();
      const snapshot = await capacity();
      const ready = await readiness();
      const probes = await probeFleet();
      process.stdout.write(
        `registered ${snapshot.registered}, free slots ${snapshot.available}, ` +
          `rate-limited ${snapshot.rateLimited}, quarantined ${snapshot.quarantined}\n` +
          `ready: ${ready.ready} — ${ready.reason}\n`,
      );
      for (const worker of workers) {
        const probe = probes.find((entry) => entry.workerId === worker.id);
        process.stdout.write(
          `  ${worker.name} [${worker.kind}] ${worker.model} ` +
            `x${worker.maxConcurrency} ${worker.capabilities.join('/')} ` +
            `${worker.availability}${probe ? ` surface:${probe.ok ? 'ok' : 'unusable'}` : ''}\n`,
        );
      }
      break;
    }

    case 'register': {
      const name = flagString(flags, 'name') ?? fail('--name is required');
      const capabilities = (flagString(flags, 'capabilities') ?? 'IMPLEMENT')
        .split(',')
        .map((value) => value.trim().toUpperCase()) as FactoryCapability[];
      const worker = await register({
        name,
        kind: (flagString(flags, 'kind') ?? 'LOCAL_CLI') as FactoryWorkerKind,
        accountRef: flagString(flags, 'account') ?? 'local-subscription',
        model: flagString(flags, 'model') ?? 'sonnet',
        modelClass: (flagString(flags, 'model-class') ?? 'FAST') as 'FAST' | 'STRONGEST' | 'EITHER',
        capabilities,
        repositories: (flagString(flags, 'repositories') ?? '*').split(','),
        maxConcurrency: Number(flagString(flags, 'concurrency') ?? '1'),
      });
      process.stdout.write(`${worker.name} ${worker.id} ${worker.capabilities.join('/')}\n`);
      break;
    }

    /*
     * The answering transition for a quarantined worker.
     *
     * `recordWorkerFailure` quarantines at three consecutive failures and
     * `capacity()` then gives that worker no free slots at all. Nothing wrote
     * `AVAILABLE` back — `registerWorker` is `ON CONFLICT DO NOTHING`, so
     * re-registering under the same name changed nothing, and the one function
     * that could had no caller anywhere — so three ordinary failures retired a
     * local-plane worker permanently, repairable only by hand-written SQL, which
     * invariant 1 forbids. §23 has the same transition one object along for the
     * dispatch fleet; this is it for the factory's own registry.
     *
     * A terminal because §26's line is that reaching the shell is the
     * authentication, and `--admin` is the attribution: resolved against the
     * database rather than trusted, because an audit row with no author answers
     * nothing later.
     */
    case 'set-state': {
      const name = flagString(flags, 'worker') ?? fail('--worker is required');
      const to = (flagString(flags, 'to') ?? fail('--to is required')) as
        | 'AVAILABLE'
        | 'PAUSED'
        | 'QUARANTINED';
      const reasons = Object.values(WORKER_STATE_REASONS);
      const reason = flagString(flags, 'reason') as WorkerStateReason | undefined;
      if (!reason || !reasons.includes(reason)) {
        fail(`--reason is required, and is one of: ${reasons.join(', ')}`);
      }

      /*
       * Whose authority this carries, resolved rather than accepted. It is
       * attribution and not authentication — §23's column pair — so it says an
       * enabled administrator exists who may authorize this, and nothing about
       * who typed the command.
       */
      const admin = flagString(flags, 'admin');
      const users = await listUsers();
      const actor = admin
        ? users.find((one) => one.email === admin && one.isBrainAdmin && !one.disabled)
        : users.find((one) => one.isBrainAdmin && !one.disabled);
      if (!actor) fail(admin ? `no enabled administrator with that address` : 'no enabled administrator exists');

      const outcome = await setAvailability({ name, to, reason, actorRef: actor.id });
      process.stdout.write(`${outcome.note}\n`);
      break;
    }

    case 'submit': {
      const file = flagString(flags, 'file') ?? fail('--file is required');
      const projectFlag = flagString(flags, 'project');
      const projects = await listProjects();
      const projectId = projectFlag ?? projects[0]?.id ?? fail('no project exists');
      const spec = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const result = await submitObjective({
        projectId,
        objective: String(spec['objective'] ?? ''),
        expectedOutcome: String(spec['expectedOutcome'] ?? ''),
        nonGoals: (spec['nonGoals'] as string[]) ?? [],
        acceptanceConditions:
          (spec['acceptanceConditions'] as { statement: string; verification: string }[]) ?? [],
        mutationScope: spec['mutationScope'] as string[] | undefined,
        deploymentPolicy: spec['deploymentPolicy'] as undefined,
        /*
         * The key decides whether this is the same ask or a new one, and a flag
         * can override the file's because a second attempt at the same objective
         * is an ordinary thing. The first hosted campaign for this objective
         * retired against a defect in the execution plane rather than against the
         * work; the objective did not change, so rewriting the file to say it had
         * would have been the wrong record.
         */
        submissionKey:
          flagString(flags, 'submission-key') ?? (spec['submissionKey'] as string | undefined),
        // The repository this objective is about, when it is not the one the
        // factory itself lives in. Recorded on the contract, so every later tick
        // resolves the same checkout without being told again.
        repositoryRoot:
          flagString(flags, 'repo') ?? (spec['repositoryRoot'] as string | undefined),
        // Or the repository as a remote, which is what makes the submission
        // remote: everything is pinned through the forge and the checkout belongs
        // to whichever worker takes the work.
        repositoryRemote:
          flagString(flags, 'repository') ?? (spec['repository'] as string | undefined),
        baseBranch: flagString(flags, 'base') ?? (spec['baseBranch'] as string | undefined),
      });
      process.stdout.write(
        `${result.created ? 'created' : 'already existed'} ${result.changeRequest.id}\n` +
          `base ${result.changeRequest.baseSha} on ${result.changeRequest.baseBranch}\n` +
          `repository ${result.changeRequest.repository}\n` +
          `checkout ${result.changeRequest.repositoryRoot ?? '(the factory default)'}\n` +
          `verification ${result.changeRequest.verificationCommands.join(', ')}\n`,
      );
      break;
    }

    case 'approve': {
      const changeRequestId =
        flagString(flags, 'change-request') ?? fail('--change-request is required');
      const userFlag = flagString(flags, 'user');
      const users = await listUsers();
      const user = userFlag
        ? users.find((candidate) => candidate.id === userFlag)
        : users.find((candidate) => candidate.isBrainAdmin && !candidate.disabled) ?? users[0];
      if (!user) fail('no person exists to approve this; bootstrap an administrator first');
      const approved = await approveObjective({
        changeRequestId,
        via: 'PERSON',
        userId: user.id,
      });
      if (!approved.ok) fail(approved.reason ?? 'refused');
      const changeRequest = approved.changeRequest;
      const spec = await campaignSpecFor(changeRequest);
      const { campaign, created } = await ensureCampaign({
        changeRequestId: changeRequest.id,
        projectId: changeRequest.projectId,
        baseSha: changeRequest.baseSha,
        laneTarget: INITIAL_LANE_TARGET,
        laneTargetReason: 'initial',
        // The same derivation the HTTP route uses, from the same function.
        executionMode: spec.executionMode,
        integrationBranch: spec.integrationBranch,
        pullRequest: spec.pullRequest,
      });
      process.stdout.write(
        `approved by ${user.email}\ncampaign ${campaign.id} ${created ? '(created)' : '(already existed)'}\n`,
      );
      break;
    }

    /*
     * The amendment ledger, with an entrance.
     *
     * `amendContract` already existed, was already tested, and could be reached
     * by nothing an operator runs — which is the shape this codebase keeps
     * finding and keeps calling a defect rather than a gap. The case it is for is
     * real and arrived immediately: a repository with no package.json derives no
     * verification commands, so the contract starts with none, and the moment a
     * campaign's first unit lands a test harness the commands have to be added or
     * every later integration verifies nothing.
     *
     * Adding is all this can do to them. The service refuses a FACTORY actor on
     * an immutable field and refuses a mutation scope that widens; this passes
     * PERSON because an operator is typing it, and the reason is required because
     * an amendment with no reason is a silent redefinition of success.
     */
    case 'amend': {
      const changeRequestId =
        flagString(flags, 'change-request') ?? fail('--change-request is required');
      const field = flagString(flags, 'field') ?? fail('--field is required');
      const reason = flagString(flags, 'reason') ?? fail('--reason is required');
      const raw = flagString(flags, 'value') ?? fail('--value is required');
      // A list for the list-shaped fields, a plain string for the rest. Parsed
      // here rather than guessed inside the service.
      const listFields = new Set([
        'acceptance_conditions',
        'non_goals',
        'mutation_scope',
        'verification_commands',
      ]);
      const newValue: unknown = listFields.has(field)
        ? raw.trim().startsWith('[')
          ? (JSON.parse(raw) as unknown)
          : raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
        : raw;
      const campaign = await getCampaignByChangeRequest(changeRequestId);
      const users = await listUsers();
      const actorId = flagString(flags, 'user') ?? users[0]?.id ?? null;
      const result = await amendContract({
        changeRequestId,
        campaignId: campaign?.id ?? null,
        field,
        newValue,
        reason,
        actorType: 'PERSON',
        actorId,
        affectedWork: (flagString(flags, 'affects') ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      });
      if (!result.ok) fail(result.reason);
      process.stdout.write(
        `amended ${field}\n` +
          `from ${JSON.stringify(result.amendment.oldValue)}\n` +
          `to   ${JSON.stringify(result.amendment.newValue)}\n` +
          `reason ${result.amendment.reason}\n` +
          `re-verification ${result.amendment.requiresReverification ? 'required' : 'not required'}\n`,
      );
      break;
    }

    case 'plan': {
      const campaignId = flagString(flags, 'campaign') ?? fail('--campaign is required');
      const file = flagString(flags, 'file') ?? fail('--file is required');
      const campaign = await getCampaign(campaignId);
      if (!campaign) fail('no such campaign');
      const changeRequest = await getChangeRequest(campaign.changeRequestId);
      if (!changeRequest) fail('no such change request');
      const proposed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      const validation = validatePlan(proposed, changeRequest);
      for (const warning of validation.warnings) process.stdout.write(`warning: ${warning}\n`);
      if (!validation.ok) {
        for (const error of validation.errors) process.stderr.write(`refused: ${error}\n`);
        fail('the plan was refused whole');
      }
      if (validation.uncoveredConditions.length > 0) {
        process.stdout.write(
          `warning: no unit claims to serve ${validation.uncoveredConditions.join(', ')}\n`,
        );
      }
      const installed = await installPlan(campaignId, validation.units);
      process.stdout.write(
        `installed ${installed.created} new unit(s), ${installed.existing} already present, ` +
          `${installed.promoted} ready${installed.cycle ? `, CYCLE: ${installed.cycle.join(' -> ')}` : ''}\n`,
      );
      break;
    }

    case 'tick':
    case 'run': {
      const campaignId = flagString(flags, 'campaign') ?? fail('--campaign is required');
      const options = {
        maxTicks: Number(flagString(flags, 'max-ticks') ?? '40'),
        maxDispatch: flags['max-dispatch'] ? Number(flagString(flags, 'max-dispatch')) : undefined,
        unitTimeoutMs: flags['unit-timeout']
          ? Number(flagString(flags, 'unit-timeout')) * 1000
          : undefined,
        // For a recovery drill: a short lease makes a dead dispatcher's work
        // claimable in seconds rather than half an hour.
        unitLeaseMs: flags['lease-seconds']
          ? Number(flagString(flags, 'lease-seconds')) * 1000
          : undefined,
        owner: flagString(flags, 'owner') ?? `cli-${process.pid}`,
        onTick: (report: {
          state: string;
          stage: string;
          dispatched: number;
          integrated: number;
          rejected: number;
          reviewed: boolean;
          repairsQueued: number;
          tickHeld: boolean;
          notes: string[];
        }) => {
          process.stdout.write(
            `[${new Date().toISOString()}] ${report.state} — ${report.stage}; ` +
              `dispatched ${report.dispatched}, integrated ${report.integrated}, ` +
              `rejected ${report.rejected}${report.reviewed ? ', reviewed' : ''}` +
              `${report.repairsQueued > 0 ? `, repairs ${report.repairsQueued}` : ''}\n` +
              report.notes.map((note) => `    ${note}\n`).join(''),
          );
        },
      };
      if (command === 'tick') {
        const report = await tickCampaign(campaignId, options);
        options.onTick(report);
      } else {
        const result = await runCampaign(campaignId, options);
        process.stdout.write(
          `\nstopped after ${result.reports.length} tick(s) in ${result.final?.state}` +
            `${result.final?.blockerKind ? ` (${result.final.blockerKind}: ${result.final.blockerDetail})` : ''}\n`,
        );
      }
      break;
    }

    case 'tick-all': {
      // One tick for every live campaign. What a scheduled dispatcher calls, and
      // the reason this entry point exists at all.
      const reports = await tickAllCampaigns({
        owner: flagString(flags, 'owner') ?? `cli-all-${process.pid}`,
      });
      if (reports.length === 0) process.stdout.write('no live campaign\n');
      for (const report of reports) {
        process.stdout.write(
          `${report.campaignId} ${report.state} — ${report.stage}; ` +
            `dispatched ${report.dispatched}, integrated ${report.integrated}, ` +
            `rejected ${report.rejected}\n` +
            report.notes.map((note) => `    ${note}\n`).join(''),
        );
      }
      break;
    }

    /*
     * One tick of the hosted loop, on demand.
     *
     * The deployed Brain already ticks every remote campaign every twenty
     * seconds, so this is never needed to make one progress. It exists so that a
     * person can *see* one tick's decision — what it ingested, what it created,
     * and why it did neither — which a loop writing to a log nobody reads does
     * not give you.
     */
    case 'remote-tick': {
      const campaignId = flagString(flags, 'campaign');
      const reports = campaignId
        ? [await tickRemoteCampaign(campaignId)]
        : await tickAllRemoteCampaigns();
      if (reports.length === 0) process.stdout.write('no live remote campaign\n');
      for (const report of reports) {
        process.stdout.write(
          `${report.campaignId} ${report.state} — ${report.stage}\n` +
            (report.ingested.length > 0 ? `    ingested ${report.ingested.join(', ')}\n` : '') +
            (report.created.length > 0 ? `    created ${report.created.join(', ')}\n` : '') +
            report.notes.map((note) => `    ${note}\n`).join(''),
        );
      }
      break;
    }

    /*
     * Every bin a campaign has, and what happened when Brain tried to fire one.
     *
     * The one thing neither `campaigns` nor `status` could answer: a campaign can
     * read EXECUTING while its bin has been refused by every surface, and the
     * reason lives on the dispatch row rather than on the campaign. Read-only,
     * and it prints no credential — a dispatch row holds the Routine's reference
     * and the provider's own error, never a token.
     */
    case 'bins': {
      const campaignId = flagString(flags, 'campaign') ?? fail('--campaign is required');
      const { campaignBins } = await import('../server/services/factory/remote.ts');
      const { listDispatchesForBin, listSessionRefusals } = await import(
        '../server/repos/bins.ts'
      );
      const bins = await campaignBins(campaignId);
      if (bins.length === 0) process.stdout.write('no bin for this campaign\n');
      for (const bin of bins) {
        process.stdout.write(
          `${bin.id} ${bin.kind} ${bin.state} gen ${bin.leaseGeneration} ` +
            `attempts ${bin.attemptCount}/${bin.maxAttempts} ` +
            `needs [${bin.requiredCapabilities.join(',')}]` +
            `${bin.workerId ? ` worker=${bin.workerId}` : ''}\n`,
        );
        for (const dispatch of await listDispatchesForBin(bin.id)) {
          process.stdout.write(
            `    dispatch gen ${dispatch.leaseGeneration} ${dispatch.state} ` +
              `attempt ${dispatch.attemptCount}/${dispatch.maxAttempts} ` +
              `routine=${dispatch.routineRef ?? '—'} session=${dispatch.sessionRef ?? '—'}` +
              `${dispatch.lastErrorKind ? ` ${dispatch.lastErrorKind}: ${(dispatch.lastError ?? '').slice(0, 200)}` : ''}\n`,
          );
        }
        for (const refusal of await listSessionRefusals(bin.id)) {
          process.stdout.write(
            `    refused  ${refusal.sessionRef} x${refusal.refusals} ` +
              `until ${refusal.retryAt}: ${refusal.reason.slice(0, 220)}\n`,
          );
        }
      }
      break;
    }

    /*
     * What campaigns exist. Every project unless `--project` narrows it: this
     * used to take the first project the list returned, so the question an
     * operator asks first — what is there — was answered for one project and
     * silently not for the rest.
     */
    case 'campaigns': {
      const projectFlag = flagString(flags, 'project');
      const projects = await listProjects();
      if (projects.length === 0) fail('no project exists');
      const scope = projectFlag ? projects.filter((project) => project.id === projectFlag) : projects;
      if (projectFlag && scope.length === 0) fail(`no project ${projectFlag}`);
      let total = 0;
      for (const project of scope) {
        const campaigns = await listCampaigns(project.id);
        if (campaigns.length === 0) continue;
        process.stdout.write(`${project.id} ${project.name}\n`);
        for (const campaign of campaigns) {
          total += 1;
          const changeRequest = await getChangeRequest(campaign.changeRequestId);
          process.stdout.write(
            `  ${campaign.id} ${campaign.executionMode} ${campaign.state} ` +
              `${campaign.prUrl ?? campaign.prRef ?? '(no pull request)'} — ` +
              `${(changeRequest?.objective ?? '').slice(0, 70)}\n` +
              `      ${campaign.stageDetail ?? ''}` +
              `${campaign.blockerKind ? ` [${campaign.blockerKind}]` : ''}\n`,
          );
        }
      }
      if (total === 0) process.stdout.write('no campaign in scope\n');
      break;
    }

    case 'status': {
      const campaignId =
        flagString(flags, 'campaign') ??
        (flagString(flags, 'change-request')
          ? (await getCampaignByChangeRequest(flagString(flags, 'change-request') ?? ''))?.id
          : undefined) ??
        fail('--campaign or --change-request is required');
      const campaign = await getCampaign(campaignId);
      if (!campaign) fail('no such campaign');
      const changeRequest = await getChangeRequest(campaign.changeRequestId);
      const units = await listUnits(campaignId);
      const metrics = await campaignMetrics(campaignId);
      const reviews = await listReviews(campaignId);
      const findings = await listFindings(campaignId);
      const sessions = await listSessions(campaignId);
      process.stdout.write(
        `${changeRequest?.objective ?? '(no objective)'}\n` +
          `campaign ${campaign.id} ${campaign.state} — ${campaign.stageDetail ?? ''}\n` +
          `${campaign.blockerKind ? `BLOCKER ${campaign.blockerKind}: ${campaign.blockerDetail}\n` : ''}` +
          `base ${campaign.baseSha.slice(0, 12)} -> ${(campaign.integrationSha ?? campaign.baseSha).slice(0, 12)} on ${campaign.integrationBranch}\n` +
          `units: ${metrics.units.integrated}/${metrics.units.total} integrated, ` +
          `${metrics.units.ready} ready, ${metrics.units.leased} leased, ${metrics.units.failed} failed\n` +
          `sessions ${sessions.length}, max observed concurrency ${metrics.maxObservedConcurrency} (${metrics.concurrencyEvidence})\n` +
          `reviews ${reviews.length}, findings ${findings.length} ` +
          `(${findings.filter((f) => f.state === 'OPEN').length} open, ` +
          `${findings.filter((f) => f.state === 'REPAIRED').length} repaired)\n` +
          `lane target ${campaign.laneTarget} — ${campaign.laneTargetReason}\n` +
          `paid-API executions recorded: ${metrics.paidApiExecutions}\n`,
      );
      for (const unit of units) {
        process.stdout.write(
          `  ${unit.state.padEnd(12)} ${unit.unitKey} (attempt ${unit.attempt}/${unit.maxAttempts})` +
            `${unit.failureCategory ? ` ${unit.failureCategory}` : ''}\n` +
            // The reason, not only the category. A category names the kind of
            // refusal and the detail names the file that caused it, and an
            // operator with only the first has to redeploy to learn the second.
            `${unit.failureDetail ? `        ${unit.failureDetail.slice(0, 400)}\n` : ''}` +
            `${unit.branch ? `        branch ${unit.branch}${unit.headSha ? ` @ ${unit.headSha.slice(0, 12)}` : ''}\n` : ''}`,
        );
      }

      /*
       * The rows behind the three counts above.
       *
       * `reviews 1, findings 1 (0 open, 1 repaired)` is a true sentence that
       * answers none of the questions somebody reads a review for: what the
       * verdict was, which commit it was a verdict about, and — the one this
       * repository cares about most — what independence tier the lineage
       * actually supported. §27 is explicit that the tier is reported at what
       * the lineage supports and never rounded up, and an operator who cannot
       * read it has to take the rounding on trust.
       *
       * Likewise `sessions 13, max observed concurrency 1 (MEASURED)`: on the
       * hosted plane those rows are derived from Brain's own dispatch and lease
       * events rather than from a process this Brain timed, so the bin and
       * generation each one names are what make the derivation checkable.
       *
       * Read-only, and printed after the units so the existing shape of this
       * output is unchanged for anything already reading it.
       */
      for (const review of reviews) {
        process.stdout.write(
          `  REVIEW round ${review.round} ${review.scope} ${review.verdict} ` +
            `on ${review.reviewedSha.slice(0, 12)} — independence ${review.independence}\n` +
            `        session ${review.reviewerSessionId ?? '—'}  ${review.createdAt}\n` +
            `        ${review.summary.slice(0, 400)}\n`,
        );
      }
      for (const finding of findings) {
        process.stdout.write(
          `  FINDING ${finding.severity.padEnd(8)} ${finding.state.padEnd(9)} ` +
            `${finding.findingKey} (${finding.category})\n` +
            `        ${finding.statement.slice(0, 400)}\n` +
            `${finding.resolution ? `        resolved: ${finding.resolution.slice(0, 300)}\n` : ''}`,
        );
      }
      /*
       * The refusals, which are the answer to *why is this campaign not
       * moving* and had no reader anywhere.
       *
       * `factory_events` is written by every stage and, until this, was read
       * by `campaignMetrics` for aggregates and by `surfaceBlockedIntegrations`
       * for a ceiling — and by no operator surface at all. So a completed
       * integration bin whose report Brain refused recorded a row saying
       * exactly which of four things went wrong, and nobody could see it. A
       * record nothing can read is the defect the record was written to close,
       * one layer along.
       *
       * These two kinds here rather than the whole ledger, because this command
       * answers *what is the state of this campaign* — `factory events` prints
       * the rest.
       */
      const refusals = await listFactoryEvents(campaignId, {
        kinds: [
          FACTORY_EVENT_KINDS.integrationNotIngested,
          FACTORY_EVENT_KINDS.integrationRejected,
          // The delivery stage's own, because *why does this campaign have no
          // pull request* is exactly the question this command answers, and a
          // reader who has to know the kind exists in order to ask for it is
          // reading a ledger with no reader again.
          FACTORY_EVENT_KINDS.deliveryNotIngested,
          // A report Brain could not yet record, and a reviewer refused for
          // lineage: both cost nothing, and both are why a stage is not moving.
          FACTORY_EVENT_KINDS.unitRefused,
          // A tick that threw. The loop reads nothing else about it.
          FACTORY_EVENT_KINDS.tickFailed,
        ],
      });
      for (const event of refusals) {
        const detail = (event.detail ?? {}) as Record<string, unknown>;
        process.stdout.write(
          `  REFUSED ${event.kind.padEnd(26)} ${event.at}\n` +
            `        ${String(detail['reason'] ?? detail['means'] ?? detail['message'] ?? '').slice(0, 300)}\n` +
            `${detail['binId'] ? `        bin ${String(detail['binId'])}\n` : ''}` +
            `${detail['problems'] ? `        ${JSON.stringify(detail['problems']).slice(0, 400)}\n` : ''}` +
            `${detail['errors'] ? `        ${JSON.stringify(detail['errors']).slice(0, 400)}\n` : ''}`,
        );
      }
      for (const session of sessions) {
        process.stdout.write(
          `  SESSION ${session.role.padEnd(11)} ${session.state.padEnd(9)} ` +
            `${session.externalSessionId ?? '—'}\n` +
            `        worker ${session.workerId}  account ${session.accountRef}` +
            `${session.binId ? `  bin ${session.binId} gen ${session.leaseGeneration}` : ''}\n` +
            `        ${session.startedAt} -> ${session.endedAt ?? '—'}` +
            `${session.durationMs === null ? '' : `  ${Math.round(session.durationMs / 1000)}s`}` +
            `${session.exitReason ? `  ${session.exitReason.slice(0, 120)}` : ''}\n`,
        );
      }
      break;
    }

    /*
     * What the factory actually managed, with an evidence class on every number.
     *
     * `throughputReport` was reachable at `GET /factory/campaigns/:id/throughput`
     * and from nowhere else: no screen called it and this door had no command for
     * it, so the one capability whose whole point is *not* rounding a ceiling up
     * could be read only by hand-writing an HTTP request. §26's rule is that a
     * reading an operator takes belongs on a terminal, and `status` beside this
     * already carries the campaign's own rows.
     *
     * Every figure is printed with its class and its basis, including the ones
     * that are `UNKNOWN` — which is the half that matters. A report that dropped
     * them would read as a campaign with no queue time rather than as a campaign
     * nobody measured one for, and `value: null` is never rendered as `0`.
     */
    /*
     * The campaign's own ledger, in the order it was written.
     *
     * `factory_events` is where every claim this factory makes about what
     * happened resolves to — and it had no reader on any operator surface:
     * `campaignMetrics` aggregates it and `surfaceBlockedIntegrations` counts
     * one slice of it, and neither prints a row. So a stage that refused a
     * report, a base that drifted, a unit that failed and a bin that was
     * created were all recorded and none of them could be looked at.
     *
     * Everything, oldest first, because a ledger read out of order is a story
     * rather than a record. `--kind` narrows it; nothing is hidden by default.
     */
    case 'events': {
      /*
       * Optional, because not every claim belongs to a campaign. Registering a
       * worker and moving its availability are facts about the fleet, written
       * with no campaign — and while this required one, they were recorded and
       * unreadable. `--kind` still narrows either way.
       */
      const campaignId = flagString(flags, 'campaign') ?? null;
      const kind = flagString(flags, 'kind');
      const events = await listFactoryEvents(campaignId, kind ? { kinds: [kind] } : {});
      process.stdout.write(
        `${campaignId ? `campaign ${campaignId}` : 'every campaign and the fleet'} — ` +
          `${events.length} event(s)\n`,
      );
      for (const event of events) {
        const detail = JSON.stringify(event.detail ?? {});
        process.stdout.write(
          `  ${event.at}  ${event.kind.padEnd(26)} ${event.evidenceClass.padEnd(8)}` +
            `${event.unitId ? ` unit ${event.unitId}` : ''}` +
            `${event.workerId ? ` worker ${event.workerId}` : ''}\n` +
            // Bounded rather than truncated silently: a detail that was cut
            // says so, because a JSON object that ends mid-key reads as
            // corruption rather than as a limit.
            `        ${detail.length > 600 ? `${detail.slice(0, 600)}… (${detail.length} chars)` : detail}\n`,
        );
      }
      break;
    }

    case 'throughput': {
      const campaignId = flagString(flags, 'campaign') ?? fail('--campaign is required');
      const report = await throughputReport(campaignId);
      const figure = (label: string, one: { value: number | null; evidence: string; basis: string }): string =>
        `${label.padEnd(26)} ${(one.value === null ? 'not measured' : String(one.value)).padEnd(14)}` +
        ` ${one.evidence.padEnd(8)} ${one.basis}\n`;
      const duration = (label: string, one: { total: { value: number | null; evidence: string; basis: string }; samples: { value: number | null; evidence: string; basis: string }; average: { value: number | null; evidence: string; basis: string } }): string =>
        figure(`${label} total ms`, one.total) +
        figure(`${label} samples`, one.samples) +
        figure(`${label} average ms`, one.average);

      process.stdout.write(
        `campaign ${report.campaignId}\n` +
          figure('units per hour', report.unitsPerHour) +
          duration('session duration', report.sessionDurations) +
          duration('queue time', report.queueTime) +
          figure('max observed concurrency', report.maxObservedConcurrency) +
          figure('concurrency observed', report.concurrency.observed) +
          // Beside it rather than instead of it: a declared lane target is a
          // projection and is never reported as throughput.
          figure('concurrency declared', report.concurrency.declared) +
          figure('ceiling', report.ceiling) +
          figure('rate-limited sessions', report.rateLimited.sessions) +
          figure('rate-limited deferred ms', report.rateLimited.deferredMs),
      );
      for (const [heading, entries] of [
        ['per worker', report.perWorker],
        ['per role', report.perRole],
        ['per account', report.perAccountRef],
      ] as const) {
        if (entries.length === 0) continue;
        process.stdout.write(`\n${heading}\n`);
        for (const entry of entries) {
          process.stdout.write(
            `  ${entry.id}${entry.accountRef ? ` (${entry.accountRef})` : ''}\n` +
              `  ${figure('  sessions', entry.sessions)}` +
              `  ${figure('  units merged', entry.unitsMerged)}` +
              `  ${figure('  units per hour', entry.unitsPerHour)}` +
              `  ${figure('  max concurrency', entry.maxObservedConcurrency)}`,
          );
        }
      }
      break;
    }

    /*
     * The reviewable artifact, in the words a person will read.
     *
     * `assemble.ts` "produces the branch, the patch and the body and stops", and
     * on the local plane that body *is* the deliverable: opening the request
     * against a remote host is a separately authorized step somebody performs
     * outside the factory, so the body has to be readable by the person who will
     * perform it. It was reachable at `GET /factory/campaigns/:id/pull-request`
     * and by nothing else — no client function, no command — which is the same
     * shape as `throughput` two cases up and the release decision one screen
     * along: a complete door with nothing that calls it, which this file has now
     * had to close three times.
     *
     * It renders through `pullRequestFor`, which is the function the route calls,
     * rather than reading the stored `PR_BODY` artifact. That is deliberate and
     * it is the same argument `assemble.ts` makes about itself: the artifact is a
     * snapshot taken when the campaign was assembled, and a second reader with
     * its own idea of the body is how the stored document and the live route came
     * to disagree about one campaign in the first place. One derivation, three
     * readers.
     *
     * It publishes nothing. There is no outbound call on this path at all.
     */
    case 'pull-request': {
      const campaignId = flagString(flags, 'campaign') ?? fail('--campaign is required');
      const rendered = await pullRequestFor(campaignId);
      if (!rendered) {
        // Not an empty body. A campaign whose rows do not resolve into a view has
        // nothing to render, and printing a blank document would read as one.
        process.stdout.write(
          `no reviewable artifact: ${campaignId} did not resolve into a campaign view\n`,
        );
        break;
      }
      process.stdout.write(`${rendered.title}\n\n${rendered.body}\n`);
      break;
    }

    case 'release': {
      const campaignId = flagString(flags, 'campaign') ?? fail('--campaign is required');
      const decision = (flagString(flags, 'decision') ?? 'APPROVED') as 'APPROVED' | 'REFUSED';
      const release = await getRelease(campaignId, 'CONTROL_PLANE');
      if (!release) fail('no release is waiting on this campaign');
      const users = await listUsers();
      const user = users.find((candidate) => candidate.isBrainAdmin && !candidate.disabled) ?? users[0];
      if (!user) fail('no person exists to answer this');
      const answered = await answerRelease(
        release.id,
        decision,
        user.id,
        flagString(flags, 'reason') ?? '',
      );
      process.stdout.write(`${answered ? 'answered' : 'already answered'} ${decision}\n`);
      break;
    }

    /*
     * Answer a factory stage bin that parked, when the platform is what spent its
     * attempts.
     *
     * Two guarded transitions in one command, because either alone leaves the bin
     * stuck: an exhausted bin cannot be reopened (`reopenNeedsHumanBin` refuses it
     * by name, because reopening it would produce a bin nothing can assign), and a
     * regranted bin that is still NEEDS_HUMAN is not handed out. Neither resets
     * anything — the attempt count, the completion refusals, the unit results and
     * every event stay exactly where they are, and the generation advances so every
     * worker that held the bin before is fenced.
     *
     * The reason is a code from a closed set rather than free text, for the reason
     * `step10.ts` already wrote down: a caller that can write its own audit trail
     * is a caller whose audit trail says whatever it wanted. An operator action
     * with no truthful cause recorded is invariant 3 again.
     */
    case 'answer-bin': {
      const binId = flagString(flags, 'bin') ?? fail('--bin is required');
      const to = Number(flagString(flags, 'to') ?? '0');
      if (!Number.isInteger(to) || to < 1 || to > 40) {
        fail('--to must be a new assignment ceiling between 1 and 40');
      }
      const REASONS: Record<string, string> = {
        /*
         * The first one, and the defect it is named for: the completion contract
         * could not express the outcome the worker actually had. It reported
         * BLOCKED with the operation its surface had refused, the schema demanded
         * a commit sha for a branch it had deliberately not pushed, and the bin
         * retired having said exactly the right thing on every attempt. An honest
         * blocker is a result; a contract that cannot accept one turns it into an
         * exhausted bin.
         */
        'contract-refused-honest-report':
          'Attempts spent being refused for a report that was correct — the completion contract ' +
          'could not express the outcome the worker actually had, so the honest answer was ' +
          'unsubmittable. Fixed in the platform. Not spent on the work failing.',
        'platform-defect':
          'Attempts spent on a Brain-side defect that left the bin nothing it could satisfy. ' +
          'Not spent on the work failing.',
        'surface-blocked':
          'Attempts spent on an execution-surface failure — the worker could reach Brain and not ' +
          'the repository — which the operator has since corrected where the workers run. Not ' +
          'spent on the work failing.',
      };
      const code = flagString(flags, 'why') ?? 'platform-defect';
      const reason = REASONS[code];
      if (!reason) fail(`unknown reason code "${code}". One of: ${Object.keys(REASONS).join(', ')}`);
      const { describeBin, reopenParkedBin } = await import('../server/services/bins/service.ts');
      const { regrantBinAttempts } = await import('../server/repos/bins.ts');
      const before = await describeBin(binId);
      if (!before) fail('no such bin');
      const users = await listUsers();
      const operator = users.find((candidate) => candidate.isBrainAdmin && !candidate.disabled);
      if (!operator) fail('no administrator exists to attribute this to');
      const regranted = await regrantBinAttempts({ binId, maxAttempts: to, reason: reason! });
      process.stdout.write(
        `regrant raised=${regranted.raised} attempts ` +
          `${before!.attemptCount}/${before!.maxAttempts} -> ` +
          `${regranted.bin?.attemptCount ?? '—'}/${regranted.bin?.maxAttempts ?? '—'}\n`,
      );
      if (before!.state !== 'NEEDS_HUMAN') {
        process.stdout.write(`bin is ${before!.state}; only a parked bin is reopened\n`);
        break;
      }
      const reopened = await reopenParkedBin({
        binId,
        // The id rather than the address: an audit row needs an author it can
        // resolve, and never a personal detail it has no use for.
        operator: `operator:${operator!.id}`,
        reason: reason!,
      });
      if (!reopened.ok) {
        process.stdout.write(`FACTORY REFUSED: reopen ${reopened.refusal} — ${reopened.reason}\n`);
        process.exitCode = 1;
        break;
      }
      process.stdout.write(
        `reopened ${binId} ${reopened.previousState} -> ${reopened.bin.state}, ` +
          `generation ${reopened.previousGeneration} -> ${reopened.generation}, ` +
          `attempts ${reopened.bin.attemptCount}/${reopened.bin.maxAttempts} unchanged\n`,
      );
      break;
    }

    /*
     * A person says the operational condition a stage stopped on has been fixed.
     *
     * This is the answering transition for a stage ceiling, and it exists because
     * the ceiling would otherwise be permanent: the count of surface-blocked
     * integrations only ever rises, so granting the repository to a worker surface
     * — the remedy the blocker itself names — could not start the campaign again.
     * A state that says "waiting for a person" which that person cannot resolve is
     * not waiting, it is stuck.
     *
     * It re-authorizes the stage and nothing else. No unit, commit, finding,
     * verdict or attempt counter moves; the append-only row names who said it and
     * why; and the next tick re-derives everything from rows as usual, so if the
     * condition has *not* been fixed the stage simply blocks again with the same
     * reason. That is the difference between a way out and an override.
     */
    /*
     * Give a unit that ran out of attempts more of them — the answer to
     * `UNIT_EXHAUSTED_ATTEMPTS`, which had none. Raises and never resets; the
     * reason is a code from a closed set. See `services/factory/regrant.ts`.
     */
    case 'regrant-unit': {
      const campaignId = flagString(flags, 'campaign') ?? fail('--campaign is required');
      const unitKey = flagString(flags, 'unit') ?? fail('--unit is required: the unit key');
      const to = Number(flagString(flags, 'to') ?? '0');
      const code = flagString(flags, 'why') ?? 'work-corrected';
      const users = await listUsers();
      const operator = users.find((candidate) => candidate.isBrainAdmin && !candidate.disabled);
      if (!operator) fail('no administrator exists to attribute this to');
      const { regrantUnit } = await import('../server/services/factory/regrant.ts');
      const outcome = await regrantUnit({
        campaignId,
        unitKey,
        maxAttempts: to,
        reasonCode: code,
        operator: `operator:${operator!.id}`,
      });
      if (!outcome.ok) {
        process.stdout.write(`FACTORY REFUSED: regrant-unit — ${outcome.reason}\n`);
        process.exitCode = 1;
        break;
      }
      process.stdout.write(
        `regranted ${unitKey} on ${campaignId}: ceiling ${outcome.from} -> ${outcome.to}, ` +
          `now ${outcome.state} (${code}). The next tick decides what is true.\n`,
      );
      break;
    }

    case 'reauthorize': {
      const campaignId = flagString(flags, 'campaign') ?? fail('--campaign is required');
      const REASONS: Record<string, string> = {
        'repository-granted':
          'The repository has been attached to a worker surface, so a session that can push is ' +
          'now reachable. Brain holds no credential and issued none.',
        'surface-restored':
          'The execution surface that could not reach the repository has been restored where the ' +
          'workers run.',
        /*
         * The answer to a stage that failed its bins to exhaustion. The failed
         * bins keep their rows; the count starts again from this row, and if the
         * condition was not in fact corrected the stage fails its way back to
         * the same block.
         */
        'stage-corrected':
          'The condition that failed this stage has been corrected — the contract amended or the ' +
          'surface fixed — so the stage may be handed out again.',
      };
      const code = flagString(flags, 'why') ?? 'repository-granted';
      const reason = REASONS[code];
      if (!reason) fail(`unknown reason code "${code}". One of: ${Object.keys(REASONS).join(', ')}`);
      const campaign = await getCampaign(campaignId);
      if (!campaign) fail('no such campaign');
      const users = await listUsers();
      const operator = users.find((candidate) => candidate.isBrainAdmin && !candidate.disabled);
      if (!operator) fail('no administrator exists to attribute this to');
      const { recordFactoryEvent } = await import('../server/repos/factoryFleet.ts');
      const { FACTORY_EVENT_KINDS } = await import('../server/services/factory/metrics.ts');
      await recordFactoryEvent({
        campaignId,
        kind: FACTORY_EVENT_KINDS.stageReauthorized,
        evidenceClass: 'MEASURED',
        detail: {
          operator: `operator:${operator!.id}`,
          reason,
          code,
          blockerKind: campaign!.blockerKind,
          blockerDetail: campaign!.blockerDetail,
        },
      });
      /*
       * And the campaign comes out of BLOCKED, because the tick is what re-derives
       * the stage and a BLOCKED campaign is still ticked. The state is a projection
       * either way — whatever is actually true is established again on the next
       * pass — so this is the honest starting point rather than an assertion.
       */
      if (campaign!.state === 'BLOCKED') {
        const { patchCampaign } = await import('../server/repos/factory.ts');
        await patchCampaign(campaignId, {
          state: 'INTEGRATING',
          blockerKind: null,
          blockerDetail: null,
          stageDetail: 'the stage was re-authorized; the next tick decides what is true',
        });
      }
      process.stdout.write(
        `reauthorized ${campaignId} (${code}); was ${campaign!.state}` +
          `${campaign!.blockerKind ? ` [${campaign!.blockerKind}]` : ''}\n`,
      );
      break;
    }

    /*
     * Retire a campaign whose work is obsolete, and everything still claimable in
     * it.
     *
     * Two halves, and doing one without the other is what leaves a worker Brain
     * can still be sent for a settled question (§24, three times). Cancelling the
     * campaign stops the tick creating anything new; retiring its non-terminal
     * bins stops an arriving worker being handed what is already there — an
     * expired lease is claimable work, so a `LEASED` bin whose session is gone is
     * not finished just because nothing is running.
     *
     * **It destroys nothing.** `CANCELLED` rather than `FAILED`, because the work
     * did not fail — something stopped wanting it; the campaign's own recorded
     * reason, every unit, commit, review, finding, bin result and event stays
     * exactly as written, and the fencing generation advances so a late completion
     * from a previous owner matches nothing. A terminal campaign is already out of
     * `listLiveCampaigns`, so this is also what "archived" means here: nothing
     * ticks it, and all of it is still readable.
     */
    case 'retire': {
      const campaignId = flagString(flags, 'campaign') ?? fail('--campaign is required');
      const reason = flagString(flags, 'reason') ?? fail('--reason is required: why this work is obsolete');
      const campaign = await getCampaign(campaignId);
      if (!campaign) fail('no such campaign');
      const { campaignBins } = await import('../server/services/factory/remote.ts');
      const { retireBin } = await import('../server/repos/bins.ts');
      const users = await listUsers();
      const operator = users.find((candidate) => candidate.isBrainAdmin && !candidate.disabled);
      if (!operator) fail('no administrator exists to attribute this to');

      const wasTerminal = campaign!.state === 'COMPLETE' || campaign!.state === 'CANCELLED';
      let retired = 0;
      let alreadyDone = 0;
      for (const bin of await campaignBins(campaignId)) {
        const outcome = await retireBin({
          binId: bin.id,
          leaseGeneration: bin.leaseGeneration,
          operator: `operator:${operator!.id}`,
          reason: `Campaign retired: ${reason}`,
        });
        if (outcome.ok) {
          retired += 1;
          process.stdout.write(`  retired ${bin.id} ${bin.kind} (was ${bin.state})\n`);
        } else if (outcome.refusal === 'ALREADY_TERMINAL') {
          alreadyDone += 1;
        } else {
          process.stdout.write(`  REFUSED ${bin.id}: ${outcome.refusal}\n`);
        }
      }

      /*
       * The campaign's own state moves only if it was still live. A COMPLETE
       * campaign stays COMPLETE — rewriting a finished campaign as cancelled would
       * assert that its work was abandoned, which is a different and untrue thing.
       */
      if (!wasTerminal) {
        const { patchCampaign } = await import('../server/repos/factory.ts');
        await patchCampaign(campaignId, {
          state: 'CANCELLED',
          stageDetail: 'retired by an operator; the work is obsolete',
          blockerKind: null,
          blockerDetail: null,
        });
      }
      const { recordFactoryEvent } = await import('../server/repos/factoryFleet.ts');
      const { FACTORY_EVENT_KINDS } = await import('../server/services/factory/metrics.ts');
      await recordFactoryEvent({
        campaignId,
        kind: FACTORY_EVENT_KINDS.campaignState,
        evidenceClass: 'MEASURED',
        detail: {
          operator: `operator:${operator!.id}`,
          retired: true,
          reason,
          wasState: campaign!.state,
          nowState: wasTerminal ? campaign!.state : 'CANCELLED',
          binsRetired: retired,
          binsAlreadyTerminal: alreadyDone,
        },
      });
      process.stdout.write(
        `retired ${campaignId}: was ${campaign!.state}, now ` +
          `${wasTerminal ? campaign!.state : 'CANCELLED'}; ${retired} bin(s) retired, ` +
          `${alreadyDone} already terminal\n`,
      );
      break;
    }

    default:
      process.stdout.write(
        'commands: fleet, register, submit, approve, amend, plan, run, tick, tick-all,\n' +
          '  remote-tick, campaigns, bins, status, events, throughput, pull-request,\n' +
          '  set-state,\n' +
          '  answer-bin,\n' +
          '  reauthorize, regrant-unit, retire, release\n',
      );
      // An unknown command is the caller getting it wrong, and it used to be
      // reported as success — see the verdict line below.
      process.exitCode = 1;
  }

  await closeDatabase();

  /**
   * The verdict, printed rather than left to an exit code.
   *
   * `deploy.yml` gives the reason in its own words — *"the verdict comes from a
   * line the script printed, not from an exit code that had to survive an SSH
   * session, a shell and a CLI"* — and `step10.sh` has answered `STEP10: OK`
   * for the same reason since it was written. This door had neither: `factory.yml`
   * pipes into `tee`, the pipeline's status is `tee`'s, and nothing anywhere
   * asserted a thing about the output. Measured on 2026-09-22 against the
   * deployed image: `factory pull-request` on a build with no such command
   * printed the usage list and the workflow run went **green**.
   *
   * A failure that renders as a pass is the one §47 records as worse than a
   * gate that did not run, because a green tick is read as evidence. So the
   * line is printed only where nothing set a failing code — `fail()` has
   * already exited, and a refusal that set one prints `FACTORY REFUSED` instead
   * — and `factory.yml` greps for it.
   */
  if (!process.exitCode) {
    process.stdout.write('FACTORY: OK\n');
  }
}

/**
 * A refusal reads as a refusal, and anything else reads as a crash.
 *
 * `RegistryError` is what the registry raises when it declines — no worker of
 * that name, a state that is not a state, a compare-and-swap lost to another
 * operator. Uncaught, every one of those reached the operator as a stack
 * trace, which is the wrong sentence about a decision the factory made
 * deliberately, and the workflow could not tell it from a process that died.
 *
 * Only that one class is caught, because the distinction is the point: *the
 * factory refused this* and *the command did not complete* send an operator to
 * two different places, and dressing an unexpected error as a refusal would
 * lose the stack that explains it.
 */
try {
  await main();
} catch (error) {
  if (error instanceof RegistryError) {
    process.stderr.write(`FACTORY REFUSED: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

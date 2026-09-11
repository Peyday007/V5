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
  listUnits,
} from '../server/repos/factory.ts';
import {
  answerRelease,
  getRelease,
  listFindings,
  listReviews,
  listSessions,
  listWorkers,
} from '../server/repos/factoryFleet.ts';
import { amendContract, approveObjective, submitObjective } from '../server/services/factory/contract.ts';
import { capacity, probeFleet, readiness, register } from '../server/services/factory/registry.ts';
import { INITIAL_LANE_TARGET } from '../server/services/factory/scheduler.ts';
import { installPlan, validatePlan } from '../server/services/factory/planner.ts';
import { runCampaign, tickAllCampaigns, tickCampaign } from '../server/services/factory/loop.ts';
import { campaignMetrics } from '../server/services/factory/metrics.ts';
import type { FactoryCapability, FactoryWorkerKind } from '../server/domain/factory.ts';
import { campaignSpecFor } from '../server/services/factory/remote.ts';

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
        submissionKey: spec['submissionKey'] as string | undefined,
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
            `${unit.failureCategory ? ` ${unit.failureCategory}` : ''}\n`,
        );
      }
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

    default:
      process.stdout.write(
        'commands: fleet, register, submit, approve, plan, run, tick, tick-all, status, release\n',
      );
  }

  await closeDatabase();
}

await main();

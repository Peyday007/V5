/**
 * The architect pass: turning an approved objective into a dependency graph.
 *
 * This is the one stage where a model decides the *shape* of the work, so it is
 * the stage where "a model proposes, the server decides" has to be most literal.
 * The architect's reply is read, validated against the contract by `planner.ts`,
 * and either installed whole or refused whole. A plan that named a command the
 * repository does not have, owned a path outside the approved scope, or closed a
 * dependency cycle is not partially installed — a graph with holes in it runs
 * happily and builds something nobody asked for.
 *
 * It also records what it sent and what came back before acting on either, for
 * the reason §12 gives about research passes: a crash between the call and the
 * decision must leave evidence rather than a mystery, and a pass that was already
 * bought is not bought twice.
 */
import path from 'node:path';
import fs from 'node:fs';
import type { FactoryCampaign, FactoryChangeRequest, FactoryWorker } from '../../domain/factory.ts';
import {
  closeSession,
  openSession,
  putArtifact,
  recordFactoryEvent,
  recordWorkerFailure,
  recordWorkerSuccess,
} from '../../repos/factoryFleet.ts';
import { FACTORY_EVENT_KINDS } from './metrics.ts';
import { PLAN_FENCE, compilePlanAssignment } from './prompts.ts';
import { MAX_PLAN_UNITS, installPlan, validatePlan, type PlanValidation } from './planner.ts';
import { executorFor } from './executors/index.ts';
import { REVIEWER_ALLOWED_TOOLS } from './review.ts';
import { campaignWorkspace, ensureWorktree } from './git.ts';

export const DEFAULT_PLAN_TIMEOUT_MS = 25 * 60 * 1000;

/**
 * A short, factual orientation for the architect.
 *
 * Gathered by the factory from the repository rather than asked for, and kept
 * small: an architect that has to read the whole tree before proposing anything
 * spends its context on orientation instead of on the decomposition. Top-level
 * directories and the files immediately inside the areas the scope allows is
 * enough to decide what the units are; the workers read the detail.
 */
export function orientation(repoRoot: string, mutationScope: string[]): string {
  const lines: string[] = [];
  const top = fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  lines.push(`Top level: ${top.join(' ')}`);

  for (const glob of mutationScope.slice(0, 6)) {
    const star = glob.indexOf('*');
    const stem = star === -1 ? glob : glob.slice(0, star);
    const dir = path.join(repoRoot, stem);
    if (!stem || !fs.existsSync(dir)) continue;
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) continue;
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .slice(0, 60);
      lines.push(`${stem}: ${entries.join(' ')}`);
    } catch {
      // A scope naming something that is not there is the plan's problem, not
      // the orientation's.
    }
  }
  return lines.join('\n');
}

export function parsePlanBlock(text: string): unknown | null {
  const fenced = new RegExp('```(?:' + PLAN_FENCE + '|json)?\\s*([\\s\\S]*?)```', 'g');
  const blocks: string[] = [];
  for (const match of text.matchAll(fenced)) if (match[1]) blocks.push(match[1]);
  for (const block of blocks.reverse()) {
    try {
      return JSON.parse(block) as unknown;
    } catch {
      continue;
    }
  }
  return null;
}

export interface ArchitectInput {
  repoRoot: string;
  campaign: FactoryCampaign;
  changeRequest: FactoryChangeRequest;
  worker: FactoryWorker;
  model: string;
  maxUnits?: number;
  timeoutMs?: number;
}

export type ArchitectOutcome =
  | { ok: true; installed: number; units: number; warnings: string[]; sessionId: string }
  | { ok: false; reason: string; validation: PlanValidation | null; sessionId: string | null };

export async function planCampaign(input: ArchitectInput): Promise<ArchitectOutcome> {
  const { campaign, changeRequest, worker } = input;
  const executor = executorFor(worker.kind);
  if (!executor) {
    return {
      ok: false,
      reason: `No executor implements ${worker.kind}.`,
      validation: null,
      sessionId: null,
    };
  }

  const session = await openSession({
    campaignId: campaign.id,
    unitId: null,
    workerId: worker.id,
    accountRef: worker.accountRef,
    attempt: 0,
    role: 'ARCHITECT',
    model: input.model,
  });

  // The architect reads and does not write: its worktree is the campaign base and
  // its allowance has no writing tool in it. A planner that could edit the
  // repository would be an implementer nobody reviewed.
  const worktreePath = path.join(campaignWorkspace(campaign.id), 'architect');
  await ensureWorktree(input.repoRoot, {
    path: worktreePath,
    branch: `factory/${campaign.id}/architect`,
    baseSha: campaign.baseSha,
  });

  const assignment = compilePlanAssignment({
    changeRequest,
    allowedVerification: changeRequest.verificationCommands,
    repositoryNotes: orientation(worktreePath, changeRequest.mutationScope),
    maxUnits: input.maxUnits ?? MAX_PLAN_UNITS,
  });

  // Written down before the provider is called, so a crash leaves evidence.
  await putArtifact({
    campaignId: campaign.id,
    sessionId: session.id,
    kind: 'REVIEW_INPUT',
    text: assignment,
  });

  const result = await executor.execute({
    campaignId: campaign.id,
    unitId: null as unknown as string,
    sessionId: session.id,
    worktreePath,
    branch: `factory/${campaign.id}/architect`,
    model: input.model,
    assignment,
    timeoutMs: input.timeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS,
    allowedTools: REVIEWER_ALLOWED_TOOLS,
  });

  if (result.rawLog) {
    await putArtifact({
      campaignId: campaign.id,
      sessionId: session.id,
      kind: 'WORKER_LOG',
      text: result.rawLog,
    });
  }

  if (result.outcome !== 'COMPLETED') {
    await closeSession(session.id, {
      state: result.outcome === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'FAILED',
      exitReason: result.detail,
      externalSessionId: result.externalSessionId,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      usage: result.usage,
    });
    if (result.outcome !== 'RATE_LIMITED') await recordWorkerFailure(worker.id);
    return {
      ok: false,
      reason: `The architect did not finish: ${result.detail}`,
      validation: null,
      sessionId: session.id,
    };
  }

  const proposed = parsePlanBlock(result.summary);
  if (proposed === null) {
    await closeSession(session.id, {
      state: 'FAILED',
      exitReason: 'no plan block',
      externalSessionId: result.externalSessionId,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      usage: result.usage,
    });
    return {
      ok: false,
      reason: 'The architect wrote no readable plan block, so there is nothing to validate.',
      validation: null,
      sessionId: session.id,
    };
  }

  const validation = validatePlan(proposed, changeRequest, { maxUnits: input.maxUnits });

  await closeSession(session.id, {
    state: validation.ok ? 'FINISHED' : 'FAILED',
    exitReason: validation.ok ? 'plan accepted' : validation.errors.slice(0, 5).join('; '),
    externalSessionId: result.externalSessionId,
    durationMs: result.durationMs,
    numTurns: result.numTurns,
    usage: result.usage,
  });

  await recordFactoryEvent({
    campaignId: campaign.id,
    workerId: worker.id,
    sessionId: session.id,
    accountRef: worker.accountRef,
    kind: FACTORY_EVENT_KINDS.unitPlanned,
    phase: 'ARCHITECT',
    durationMs: result.durationMs,
    evidenceClass: 'MEASURED',
    detail: {
      accepted: validation.ok,
      proposedUnits: validation.units.length,
      errors: validation.errors.slice(0, 10),
      warnings: validation.warnings.slice(0, 10),
      uncoveredConditions: validation.uncoveredConditions,
    },
  });

  if (!validation.ok) {
    await recordWorkerFailure(worker.id);
    return {
      ok: false,
      reason: `The plan was refused whole: ${validation.errors.slice(0, 5).join('; ')}`,
      validation,
      sessionId: session.id,
    };
  }

  if (validation.uncoveredConditions.length > 0) {
    // A plan that covers the objective is the plan's job, and a plan that leaves a
    // mandatory condition unserved has not done it. Refused rather than installed
    // with a gap, because the gap would only be discovered by the final review.
    await recordWorkerFailure(worker.id);
    return {
      ok: false,
      reason:
        `No unit claims to serve ${validation.uncoveredConditions.join(', ')}. A plan that ` +
        'leaves a mandatory acceptance condition to nobody cannot satisfy the objective.',
      validation,
      sessionId: session.id,
    };
  }

  const installed = await installPlan(campaign.id, validation.units);
  await recordWorkerSuccess(worker.id);

  return {
    ok: true,
    installed: installed.created,
    units: validation.units.length,
    warnings: validation.warnings,
    sessionId: session.id,
  };
}

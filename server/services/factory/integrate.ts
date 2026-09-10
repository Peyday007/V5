/**
 * Integration, as an active and continuous role.
 *
 * The integrator is the only thing in the factory that decides a unit succeeded,
 * and it decides it from the repository: a branch that advanced, a diff inside
 * the paths the unit owns, and the repository's own verification commands
 * passing afterwards. A worker's report is stored beside that and never counted
 * as part of it.
 *
 * Continuous rather than final, deliberately. Waiting until every lane finished
 * before finding out whether their components connect is how a campaign
 * discovers an interface mismatch after six units were built on it. Each unit is
 * integrated as it lands, and the cross-unit verification runs again at each
 * meaningful boundary.
 *
 * The order of the checks is the whole design:
 *
 *   1. **Did anything happen?** A branch that did not move is not an
 *      implementation, whatever the worker wrote.
 *   2. **Is it this unit's work?** Every changed path must be inside the unit's
 *      declared ownership. An unrelated change is rejected whole — not
 *      cherry-picked, not partially taken — because a diff the unit did not
 *      declare is a diff nobody reviewed the scope of.
 *   3. **Did it already land?** A redelivered tick must not produce a second
 *      merge commit for work already in the branch.
 *   4. **Does it merge?** A conflict is reported and aborted, leaving the
 *      integration branch exactly where it was. Integration never silently drops
 *      another lane's work.
 *   5. **Does the tree still work?** Verification runs on the merged tree, and a
 *      failure rolls the merge back. The integration branch stays a branch a
 *      person could read.
 */
import path from 'node:path';
import type {
  FactoryCampaign,
  FactoryChangeRequest,
  FactoryVerificationResult,
  FactoryWorkUnit,
} from '../../domain/factory.ts';
import {
  getCampaign,
  markIntegrated,
  patchCampaign,
  promoteReadyUnits,
  reopenUnit,
} from '../../repos/factory.ts';
import { recordFactoryEvent, recordIntegration } from '../../repos/factoryFleet.ts';
import { FACTORY_EVENT_KINDS } from './metrics.ts';
import {
  alreadyMerged,
  changedPaths,
  commitsBetween,
  diffStat,
  ensureWorktree,
  git,
  gitOrThrow,
  isAncestor,
  mergeBranch,
  resolveSha,
  run,
  campaignWorkspace,
} from './git.ts';

/* ------------------------------------------------------------------------- */
/* Ownership                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Does this path match this glob?
 *
 * `**` crosses directory separators, `*` does not, `?` is one character. Small
 * and exact rather than a dependency, because the answer decides whether a
 * worker's diff is accepted and a surprising matcher would be a surprising
 * rejection.
 */
export function matchesGlob(candidate: string, glob: string): boolean {
  const normalise = (value: string): string => value.split(path.sep).join('/').replace(/^\.\//, '');
  const target = normalise(candidate);
  const pattern = normalise(glob);

  if (pattern === '**' || pattern === '*') return true;

  let regex = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      // `a/**` owns `a` itself as well as everything under it, which is what a
      // reader of the glob expects and what a directory-owning unit means by it.
      // So the separator in front of the `**` becomes part of the optional tail
      // rather than something the path must contain.
      if (regex.endsWith('/')) regex = `${regex.slice(0, -1)}(?:/.*)?`;
      else regex += '.*';
      i += 1;
      if (pattern[i + 1] === '/') i += 1;
    } else if (char === '*') {
      regex += '[^/]*';
    } else if (char === '?') {
      regex += '[^/]';
    } else if (char && '\\^$.|+()[]{}'.includes(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  // A pattern naming a directory owns everything under it.
  const asDirectory = pattern.endsWith('/') ? `${regex}.*` : `${regex}(/.*)?`;
  return new RegExp(`^${asDirectory}$`).test(target);
}

export interface OwnershipVerdict {
  ok: boolean;
  outside: string[];
}

/** Every changed path must be inside something the unit declared. */
export function checkOwnership(paths: string[], ownedPaths: string[]): OwnershipVerdict {
  const outside = paths.filter((candidate) => !ownedPaths.some((glob) => matchesGlob(candidate, glob)));
  return { ok: outside.length === 0, outside };
}

/* ------------------------------------------------------------------------- */
/* Verification                                                               */
/* ------------------------------------------------------------------------- */

/** Keep the tail: the end of a failing command is where the reason is. */
function tailOf(result: { stdout: string; stderr: string }, limit = 4000): string {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  return combined.length <= limit ? combined : `...${combined.slice(-limit)}`;
}

/**
 * Run the repository's own checks on a tree.
 *
 * A shell, because a project's verification lines are shell lines — and safe to
 * shell, because the strings came from the change request, which derived them
 * from the repository's `package.json` and refuses any command a plan tried to
 * invent.
 */
export async function runVerification(
  worktreePath: string,
  commands: string[],
  context: { campaignId: string; unitId?: string | null; timeoutMs?: number } ,
): Promise<FactoryVerificationResult[]> {
  const results: FactoryVerificationResult[] = [];
  for (const command of commands) {
    const result = await run(command, [], {
      cwd: worktreePath,
      shell: true,
      timeoutMs: context.timeoutMs ?? 30 * 60 * 1000,
    });
    const entry: FactoryVerificationResult = {
      command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      tail: tailOf(result),
    };
    results.push(entry);
    await recordFactoryEvent({
      campaignId: context.campaignId,
      unitId: context.unitId ?? null,
      kind: FACTORY_EVENT_KINDS.verificationRan,
      durationMs: result.durationMs,
      evidenceClass: 'MEASURED',
      detail: {
        command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        // The tail only. A full build log belongs in the artifact table.
        tail: entry.tail.slice(-1200),
      },
    });
    // Stop at the first failure: the later commands would report the same break.
    if (result.exitCode !== 0) break;
  }
  return results;
}

export function verificationPassed(results: FactoryVerificationResult[]): boolean {
  return results.length > 0 && results.every((result) => result.exitCode === 0);
}

/* ------------------------------------------------------------------------- */
/* The integration worktree                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The campaign's own checkout, where merges happen.
 *
 * Never the primary checkout. This Brain's repository is the one under work, so
 * a factory that merged into the branch the server is running from would be
 * rewriting its own code while executing it.
 */
export async function ensureIntegrationWorktree(
  repoRoot: string,
  campaign: FactoryCampaign,
): Promise<string> {
  const worktreePath = path.join(campaignWorkspace(campaign.id), 'integration');
  await ensureWorktree(repoRoot, {
    path: worktreePath,
    branch: campaign.integrationBranch,
    baseSha: campaign.baseSha,
  });
  return worktreePath;
}

/* ------------------------------------------------------------------------- */
/* Integrating one unit                                                       */
/* ------------------------------------------------------------------------- */

export interface IntegrationResult {
  outcome: 'MERGED' | 'REJECTED' | 'CONFLICT' | 'VERIFICATION_FAILED' | 'ALREADY_MERGED';
  reason: string;
  integrationSha: string | null;
  rejectedPaths: string[];
  verification: FactoryVerificationResult[];
}

export interface IntegrateOptions {
  repoRoot: string;
  campaign: FactoryCampaign;
  changeRequest: FactoryChangeRequest;
  unit: FactoryWorkUnit;
  /** Extra commands to run on the merged tree, beyond the unit's own. */
  crossUnitVerification?: string[];
  integratorSessionId?: string | null;
}

export async function integrateUnit(options: IntegrateOptions): Promise<IntegrationResult> {
  const { repoRoot, campaign, unit } = options;
  const startedAt = Date.now();
  const worktreePath = await ensureIntegrationWorktree(repoRoot, campaign);
  const beforeSha = await gitOrThrow(worktreePath, ['rev-parse', 'HEAD']);

  const record = async (
    outcome: IntegrationResult['outcome'],
    reason: string,
    extra: { rejectedPaths?: string[]; verification?: FactoryVerificationResult[]; afterSha?: string | null },
  ): Promise<IntegrationResult> => {
    const storedOutcome = outcome === 'ALREADY_MERGED' ? 'MERGED' : outcome;
    await recordIntegration({
      campaignId: campaign.id,
      unitId: unit.id,
      attempt: unit.attempt,
      outcome: storedOutcome,
      reason,
      rejectedPaths: extra.rejectedPaths ?? [],
      beforeSha,
      afterSha: extra.afterSha ?? null,
      verification: extra.verification ?? [],
      integratorSessionId: options.integratorSessionId ?? null,
    });
    await recordFactoryEvent({
      campaignId: campaign.id,
      unitId: unit.id,
      sessionId: options.integratorSessionId ?? null,
      kind:
        storedOutcome === 'MERGED'
          ? FACTORY_EVENT_KINDS.integrationMerged
          : storedOutcome === 'CONFLICT'
            ? FACTORY_EVENT_KINDS.integrationConflict
            : FACTORY_EVENT_KINDS.integrationRejected,
      durationMs: Date.now() - startedAt,
      evidenceClass: 'MEASURED',
      detail: {
        unitKey: unit.unitKey,
        attempt: unit.attempt,
        outcome: storedOutcome,
        reason: reason.slice(0, 800),
        rejectedPaths: (extra.rejectedPaths ?? []).slice(0, 40),
      },
    });
    return {
      outcome,
      reason,
      integrationSha: extra.afterSha ?? null,
      rejectedPaths: extra.rejectedPaths ?? [],
      verification: extra.verification ?? [],
    };
  };

  if (!unit.branch) {
    await reopenUnit(unit.id, 'NO_CHANGE_PRODUCED', 'The unit reported no branch.');
    return await record('REJECTED', 'The unit has no branch to integrate.', {});
  }

  const branchSha = await resolveSha(repoRoot, unit.branch);
  if (!branchSha) {
    await reopenUnit(unit.id, 'NO_CHANGE_PRODUCED', `Branch ${unit.branch} does not exist.`);
    return await record('REJECTED', `Branch ${unit.branch} does not exist.`, {});
  }

  const unitBase = unit.baseSha ?? campaign.baseSha;
  if (branchSha === unitBase || (await isAncestor(repoRoot, branchSha, unitBase))) {
    await reopenUnit(
      unit.id,
      'NO_CHANGE_PRODUCED',
      'The branch did not advance past its base: no commit was produced.',
    );
    return await record('REJECTED', 'The branch did not advance past its base.', {});
  }

  // Already in the integration branch: a redelivered tick, not a second merge.
  if (await alreadyMerged(repoRoot, unit.branch, beforeSha)) {
    await markIntegrated(unit.id, beforeSha);
    return await record('ALREADY_MERGED', 'The branch is already contained in the integration branch.', {
      afterSha: beforeSha,
    });
  }

  const paths = await changedPaths(repoRoot, unitBase, branchSha);
  const ownership = checkOwnership(paths, unit.ownedPaths);
  if (!ownership.ok) {
    await reopenUnit(
      unit.id,
      'OUT_OF_SCOPE_MUTATION',
      `The diff touched paths this unit does not own: ${ownership.outside.slice(0, 20).join(', ')}`,
    );
    return await record(
      'REJECTED',
      'The diff reaches outside the paths this unit owns, so it was rejected whole rather than ' +
        'partially taken.',
      { rejectedPaths: ownership.outside },
    );
  }

  const commits = await commitsBetween(repoRoot, unitBase, branchSha);
  const stat = await diffStat(repoRoot, unitBase, branchSha);

  const merge = await mergeBranch(
    worktreePath,
    unit.branch,
    `Integrate ${unit.unitKey}: ${unit.title}\n\n` +
      `Campaign: ${campaign.id}\nUnit: ${unit.id}\nAttempt: ${unit.attempt}\n` +
      `Files: ${stat.filesChanged}, +${stat.insertions}/-${stat.deletions}`,
  );
  if (!merge.ok || !merge.sha) {
    await reopenUnit(
      unit.id,
      'INTEGRATION_CONFLICT',
      `Merging into ${campaign.integrationBranch} conflicted: ${merge.detail.slice(0, 1000)}`,
    );
    return await record(
      merge.conflict ? 'CONFLICT' : 'REJECTED',
      merge.conflict
        ? 'The merge conflicted and was aborted; the integration branch is unchanged.'
        : `The merge failed: ${merge.detail.slice(0, 500)}`,
      {},
    );
  }

  const commands = [...new Set([...unit.verification, ...(options.crossUnitVerification ?? [])])];
  const verification = commands.length > 0
    ? await runVerification(worktreePath, commands, { campaignId: campaign.id, unitId: unit.id })
    : [];

  if (commands.length > 0 && !verificationPassed(verification)) {
    // Roll the merge back so the integration branch stays a tree a person could
    // read, and send the unit back with the failure as its reason.
    await gitOrThrow(worktreePath, ['reset', '--hard', beforeSha]);
    const failed = verification.find((result) => result.exitCode !== 0);
    await reopenUnit(
      unit.id,
      'VERIFICATION_FAILED',
      `\`${failed?.command}\` exited ${failed?.exitCode} on the merged tree:\n${failed?.tail ?? ''}`,
    );
    return await record(
      'VERIFICATION_FAILED',
      `\`${failed?.command}\` failed on the merged tree; the merge was rolled back.`,
      { verification },
    );
  }

  await markIntegrated(unit.id, merge.sha);
  await patchCampaign(campaign.id, { integrationSha: merge.sha });

  const promoted = await promoteReadyUnits(campaign.id);
  for (const ready of promoted) {
    await recordFactoryEvent({
      campaignId: campaign.id,
      unitId: ready.id,
      kind: FACTORY_EVENT_KINDS.unitReady,
      evidenceClass: 'MEASURED',
      detail: { unitKey: ready.unitKey, reason: `unblocked by ${unit.unitKey}` },
    });
  }

  return await record(
    'MERGED',
    `Merged ${commits.length} commit(s), ${stat.filesChanged} file(s), +${stat.insertions}/-${stat.deletions}.`,
    { verification, afterSha: merge.sha },
  );
}

/**
 * Has the campaign's pinned base gone stale?
 *
 * Asked rather than assumed, because the alternative is a campaign that produces
 * a pull request against a branch that has moved and a reviewer who finds out.
 * Reported as a fact with a remedy; the remedy — rebase or re-plan — is the
 * loop's decision, not this function's.
 */
export async function baseIsStale(
  repoRoot: string,
  campaign: FactoryCampaign,
  baseBranch: string,
): Promise<{ stale: boolean; headSha: string | null; behindBy: number }> {
  const headSha = await resolveSha(repoRoot, baseBranch);
  if (!headSha) return { stale: false, headSha: null, behindBy: 0 };
  if (headSha === campaign.baseSha) return { stale: false, headSha, behindBy: 0 };
  const contained = await isAncestor(repoRoot, headSha, campaign.integrationSha ?? campaign.baseSha);
  if (contained) return { stale: false, headSha, behindBy: 0 };
  const count = await git(repoRoot, ['rev-list', '--count', `${campaign.baseSha}..${headSha}`]);
  return {
    stale: true,
    headSha,
    behindBy: count.exitCode === 0 ? Number(count.stdout.trim()) || 0 : 0,
  };
}

/**
 * Bring the base branch into the campaign's integration branch.
 *
 * A merge rather than a rebase: unit branches are already recorded against their
 * shas and rewriting the integration branch would invalidate every one of them.
 * A conflict here is reported and left — resolving somebody else's concurrent
 * work automatically is exactly the silent drop this file exists to prevent.
 */
export async function rebaseCampaign(
  repoRoot: string,
  campaign: FactoryCampaign,
  baseBranch: string,
): Promise<{ ok: boolean; detail: string; sha: string | null }> {
  const worktreePath = await ensureIntegrationWorktree(repoRoot, campaign);
  const merge = await mergeBranch(
    worktreePath,
    baseBranch,
    `Bring ${baseBranch} into the campaign's integration branch\n\nCampaign: ${campaign.id}`,
  );
  if (merge.ok && merge.sha) {
    await patchCampaign(campaign.id, { integrationSha: merge.sha });
    await recordFactoryEvent({
      campaignId: campaign.id,
      kind: FACTORY_EVENT_KINDS.rebased,
      evidenceClass: 'MEASURED',
      detail: { baseBranch, sha: merge.sha },
    });
    return { ok: true, detail: 'merged', sha: merge.sha };
  }
  const fresh = await getCampaign(campaign.id);
  return {
    ok: false,
    detail: merge.detail,
    sha: fresh?.integrationSha ?? null,
  };
}

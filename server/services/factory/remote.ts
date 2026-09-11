/**
 * The execution plane: a campaign's work becomes bins, and permanent workers
 * drain them.
 *
 * ---------------------------------------------------------------------------
 * What changed, and why it had to
 * ---------------------------------------------------------------------------
 *
 * The factory's first executor spawned a process beside the Brain and handed it
 * the Brain's own checkout. That works exactly once — on a laptop. The deployed
 * Brain has no `.git`, deliberately, so the hosted factory could only refuse an
 * objective: an honest diagnosis and a dead end.
 *
 * The way out is not to give production a checkout. It is to notice that Brain
 * already has a machinery for *work a permanent worker does somewhere else*:
 * Step 10's bins. A bin is a complete idea with a manifest a worker executes and
 * a completion contract Brain judges, and the dispatcher is deliberately
 * indifferent to what the work is about. So a factory stage becomes a bin, a
 * subscription-backed worker with its own checkout drains it, and the Brain keeps
 * the three things that were always its job: the contract, the schedule, and the
 * verdict.
 *
 * ---------------------------------------------------------------------------
 * How a worker is kept honest without a diff
 * ---------------------------------------------------------------------------
 *
 * §27's rule is that `IMPLEMENTED` means a branch moved, not that a worker said
 * so. Brain cannot read a diff it does not have, so the rule is kept by asking
 * the **forge**: the branch's head commit, and the files a range of commits
 * touched, come from the repository's own account of itself. The worker's own
 * file list is parsed, stored and then *not used* for the ownership decision —
 * it is there so a later reader can see whether the worker knew what it had done.
 *
 * A repository Brain cannot read fails closed. There is no path here where an
 * unverifiable push becomes an integrated unit.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately not here
 * ---------------------------------------------------------------------------
 *
 * No credential, of any kind. The manifest names a remote and never a secret; how
 * a worker comes to be able to push is granted where the worker runs. That is
 * §22's rule and the reason Brain must never mint its own workers — and it is
 * also the cheapest possible answer to "credentials must never appear in prompts,
 * logs, database content or browser output": there is nothing to place anywhere.
 */
import type {
  Bin,
  BinManifest,
  BinRepository,
  BinUnitSpec,
  CompletionContract,
} from '../../domain/types.ts';
import type {
  FactoryCampaign,
  FactoryChangeRequest,
  FactoryWorkUnit,
} from '../../domain/factory.ts';
import { createBin, getBin, listBinUnitResults } from '../../repos/bins.ts';
import {
  claimUnits,
  factoryNow,
  getChangeRequest,
  listUnits,
  markImplemented,
  markIntegrated,
  patchCampaign,
} from '../../repos/factory.ts';
import { recordFactoryEvent, recordIntegration } from '../../repos/factoryFleet.ts';
import { FACTORY_EVENT_KINDS } from './metrics.ts';
import { matchesGlob } from './integrate.ts';
import {
  compareCommits,
  findPullRequestForBranch,
  parseRemote,
  readChecks,
  readPullRequest,
  resolveBranch,
  type ForgeChecks,
  type ForgeRepository,
} from './forge.ts';
import {
  parseDeliveryReport,
  parseIntegrationReport,
  parseReviewReport,
  parseUnitReport,
  type FactoryDeliveryReport,
  type FactoryIntegrationReport,
  type FactoryUnitReport,
} from './remoteReport.ts';

/** What a factory bin is for. Carried in the manifest, matched exactly. */
export const FACTORY_BIN_ROLES = ['PLAN', 'IMPLEMENT', 'INTEGRATE', 'REVIEW', 'DELIVER'] as const;
export type FactoryBinRole = (typeof FACTORY_BIN_ROLES)[number];

/**
 * The capabilities a Routine must carry to be handed factory work.
 *
 * Two, not one, and the distinction is what makes an independent review possible
 * on a fleet where only some surfaces can push. Reading a repository and running
 * its tests needs nothing but network; pushing a branch needs a credential the
 * surface was granted where it runs. So a reviewer may be any surface that can
 * read, and only the bins that actually write require the stronger one.
 *
 * Collapsing them would force every factory bin onto the pushing surfaces, and
 * with one such surface that makes the reviewer the implementer — which is the
 * single property review independence exists to prevent.
 */
export const FACTORY_CAPABILITY = 'repository';
export const FACTORY_WRITE_CAPABILITY = 'repository-write';

/**
 * The branch a unit's work belongs on, derived rather than chosen.
 *
 * A worker that named its own branch could collide with another worker's, and
 * Brain would have no way to tell which push answered which unit. Deriving it
 * from the campaign, the unit key and the attempt makes every branch answerable
 * to exactly one attempt of one unit, and makes a retry a new branch rather than
 * a force-push over evidence.
 */
export function remoteBranchFor(campaign: FactoryCampaign, unit: FactoryWorkUnit): string {
  return `factory/${campaign.id}/${unit.unitKey}/a${unit.attempt + 1}`;
}

/**
 * The commit a round of work starts from.
 *
 * Not the campaign's pin after the first round: once an integration has landed,
 * the next unit branches from *that*, because a unit branched from the original
 * pin would reopen everything already integrated the moment it was merged. The
 * campaign's `baseSha` stays what it always was — the pin a person approved — and
 * this is the moving head the work is actually built on.
 */
export function roundBaseFor(campaign: FactoryCampaign): string {
  return campaign.integrationSha ?? campaign.baseSha;
}

/**
 * The base a bin was created against, read back from the bin itself.
 *
 * An ingest must compare against the range the worker was actually given, not
 * against whatever the campaign's head happens to be by the time the report is
 * read. The bin recorded it, so the bin is asked — which is the same reason every
 * other decision here is taken from a row rather than from the clock.
 */
export function binBaseOf(bin: Bin, campaign: FactoryCampaign): string {
  const recorded = bin.manifest.repository?.baseSha;
  return typeof recorded === 'string' && /^[0-9a-f]{40}$/.test(recorded)
    ? recorded
    : campaign.baseSha;
}

/**
 * The branch this bin told a unit to use, read back from the bin.
 *
 * `remoteBranchFor` *derives* the name from the unit's attempt, and that was
 * self-destroying: `acceptUnitReport` claims the unit, a claim increments the
 * attempt, so the moment a report was accepted the name Brain expected no longer
 * matched the branch it had just accepted. The next tick re-verified the same
 * report, refused it for naming `a1` when the unit was now on `a2`, reopened the
 * unit, charged another attempt — and three passes later a unit whose work was
 * sitting correctly on a confirmed commit had retired as FAILED.
 *
 * A derivation over a mutable counter cannot be the contract. The bin recorded
 * the name when it handed the work out, so the bin is asked — the same "read it
 * back from the row Brain wrote" this loop uses for the base commit, and for the
 * same reason.
 */
export function declaredBranchFor(bin: Bin, unitKey: string): string | null {
  const spec = (bin.manifest.units ?? []).find((unit) => unit.key === unitKey);
  if (!spec) return null;
  try {
    const parsed = JSON.parse(spec.input) as { branch?: unknown };
    return typeof parsed.branch === 'string' && parsed.branch.length > 0 ? parsed.branch : null;
  } catch {
    return null;
  }
}

function repositoryFor(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  pullRequest: number | null,
  baseSha: string,
): BinRepository {
  return {
    remote: changeRequest.repository,
    ref: changeRequest.baseBranch,
    baseSha,
    integrationBranch: campaign.integrationBranch,
    pullRequest,
  };
}

/**
 * The pull request this campaign updates, read from the campaign rather than
 * invented. `prRef` holds a number for a campaign that was pointed at an existing
 * request; anything else means open one.
 */
export function pullRequestNumber(campaign: FactoryCampaign): number | null {
  const match = /^#?(\d+)$/.exec((campaign.prRef ?? '').trim());
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function baseManifest(input: {
  role: FactoryBinRole;
  objective: string;
  why: string;
  campaign: FactoryCampaign;
  changeRequest: FactoryChangeRequest;
  units: BinUnitSpec[];
  outputs: string[];
  authorized: string[];
  baseSha: string;
}): BinManifest {
  return {
    objective: input.objective,
    why: input.why,
    repository: repositoryFor(
      input.campaign,
      input.changeRequest,
      pullRequestNumber(input.campaign),
      input.baseSha,
    ),
    lineage: {
      projectId: input.campaign.projectId,
      layerId: null,
      goal: input.changeRequest.objective,
      orchestrationId: null,
    },
    units: input.units,
    acceptableSources: [input.changeRequest.repository],
    excludedSources: [
      'any repository other than the one named above',
      'any credential, secret or environment variable value',
    ],
    evidence: [
      'A pushed branch, named by Brain, whose head commit Brain will confirm with the forge.',
      'The exit code of every verification command the contract named.',
    ],
    outputs: input.outputs,
    authorizedActions: [
      /*
       * How a worker comes to be able to read and write this repository, said
       * once and in the manifest rather than anywhere else.
       *
       * Brain holds no credential for it. The access is granted where the worker
       * runs, by the worker's own execution surface, which is what makes it
       * scoped and revocable without Brain ever storing a secret — §22's rule
       * that Brain must never mint its own workers, applied to a repository. It
       * is also the cheapest possible answer to "credentials must never appear in
       * prompts, logs, database content or browser output": there is nothing on
       * this side to put anywhere.
       */
      'obtain access to the repository named above through your own execution surface — Brain ' +
        'holds no credential for it and will never send you one',
      ...input.authorized,
    ],
    prohibitedActions: [
      `merge anything into ${input.changeRequest.baseBranch} or any other protected branch`,
      'deploy, release or publish anything',
      'force-push over, delete or rewrite any branch you did not create in this bin',
      'touch any path the unit does not declare as its own',
      'print, log or commit any credential, token or environment variable value',
      'widen, narrow or re-scope this bin',
    ],
    budgetUnits: null,
    retry: { maxAttempts: 2, backoffSeconds: 60 },
    stoppingConditions: [
      'every unit in this bin has a submitted result',
      'or a unit is blocked and its reason is recorded',
    ],
  };
}

/* ------------------------------------------------------------------------- */
/* Creating the work                                                          */
/* ------------------------------------------------------------------------- */

/** The plan bin: read the pinned repository, propose units, and nothing else. */
export async function createPlanBin(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
): Promise<Bin> {
  const conditions = changeRequest.acceptanceConditions
    .map((condition) => `${condition.id}: ${condition.statement} (checked by: ${condition.verification})`)
    .join('\n');
  const manifest = baseManifest({
    role: 'PLAN',
    objective: changeRequest.objective,
    why:
      'A campaign cannot start until its work is broken into units Brain can schedule, ' +
      'own and verify separately. You are proposing that decomposition; Brain validates it ' +
      'and refuses the whole plan rather than repairing one.',
    campaign,
    changeRequest,
    units: [
      {
        key: 'plan',
        establishes:
          'A decomposition of the objective into bounded units. Submit it through ' +
          '`brain_bin_submit_unit` with unit key `plan` and a JSON value of the shape ' +
          '{"units":[{"key","kind","title","objective","acceptance":[],"ownedPaths":[],' +
          '"requiredContext":[],"verification":[],"expectedArtifact","risk","criticalPath",' +
          '"dependsOn":[],"serves":[]}]}. Every path you name must sit inside the approved ' +
          'mutation scope, every verification command must be one the contract already ' +
          'declares, no two units may own an overlapping path unless one depends on the ' +
          'other, and every mandatory acceptance condition must be served by some unit. ' +
          'Brain refuses the whole plan for any of those, so read the repository first.',
        input: JSON.stringify({
          expectedOutcome: changeRequest.expectedOutcome,
          nonGoals: changeRequest.nonGoals,
          acceptanceConditions: conditions,
          mutationScope: changeRequest.mutationScope,
          verificationCommands: changeRequest.verificationCommands,
        }),
        transform: 'FACTORY_PLAN',
        dependsOn: [],
      },
    ],
    outputs: ['one submitted unit result with key `plan`'],
    authorized: [
      'read the repository at the pinned commit',
      'run read-only commands that help you understand it',
    ],
    baseSha: roundBaseFor(campaign),
  });
  manifest.prohibitedActions = [
    ...manifest.prohibitedActions,
    'write, commit or push anything at all — this bin is a proposal',
  ];

  return await createBin({
    projectId: campaign.projectId,
    kind: 'FACTORY_PLAN',
    title: `Plan: ${changeRequest.objective.slice(0, 80)}`,
    objective: changeRequest.objective,
    rationale: 'The objective has no units yet.',
    manifest,
    completionContract: 'FACTORY_PLAN_V1' as CompletionContract,
    priority: 8,
    createdByType: 'SYSTEM',
    createdById: `factory:plan:${campaign.id}`,
    requiredCapabilities: [FACTORY_CAPABILITY],
    workloadClass: 'FACTORY_PLAN',
    factoryCampaignId: campaign.id,
    ready: true,
    maxAttempts: 2,
  });
}

/**
 * The implementation bin: one bin unit per ready factory unit.
 *
 * The units go in together rather than one bin each, because a worker that holds
 * the checkout can do several bounded changes in one activation and because the
 * bin's own drain order already respects what Brain declared. What it must not do
 * is decide the set: the units are the ones Brain leased to it, and nothing else.
 */
export async function createUnitsBin(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  units: FactoryWorkUnit[],
): Promise<Bin | null> {
  if (units.length === 0) return null;
  const base = roundBaseFor(campaign);
  const specs: BinUnitSpec[] = units.map((unit) => ({
    key: unit.unitKey,
    establishes: [
      unit.objective,
      '',
      `Acceptance: ${unit.acceptance.join('; ') || '(none declared)'}`,
      `You own exactly these paths and nothing else: ${unit.ownedPaths.join(', ')}`,
      `Work on branch ${remoteBranchFor(campaign, unit)}, created from ${base}.`,
      'Units in this bin are independent of each other — every one of them branches from that ' +
        'same commit and owns paths no other one owns — so they may be implemented ' +
        'concurrently. Do not merge them into each other and do not touch the integration ' +
        'branch: a later bin integrates them in the order Brain decides.',
      'Commit your work and push that branch. Then submit a result for this unit key with a ' +
        'JSON value of the shape {"unitKey","outcome":"IMPLEMENTED"|"BLOCKED","branch",' +
        '"headSha","filesChanged":[],"commands":[{"command","exitCode"}],"summary",' +
        '"blockedReason"}. Brain confirms the branch and the commit with the forge and ' +
        'refuses the result if the files that moved are outside the paths above.',
    ].join('\n'),
    input: JSON.stringify({
      branch: remoteBranchFor(campaign, unit),
      baseSha: base,
      ownedPaths: unit.ownedPaths,
      verification: unit.verification.length > 0 ? unit.verification : changeRequest.verificationCommands,
      expectedArtifact: unit.expectedArtifact,
      requiredContext: unit.requiredContext,
    }),
    transform: 'FACTORY_UNIT',
    dependsOn: [],
  }));

  const manifest = baseManifest({
    role: 'IMPLEMENT',
    objective: changeRequest.objective,
    why:
      'These units are ready: everything they depend on has already landed. Implement each ' +
      'one inside the paths it declares, push it on the branch Brain named, and report what ' +
      'the repository now contains.',
    campaign,
    changeRequest,
    units: specs,
    outputs: [
      'one pushed branch per unit, at the name Brain gave it',
      'one submitted result per unit',
      changeRequest.verificationCommands.length > 0
        ? `the repository's own commands run on the work: ${changeRequest.verificationCommands.join(', ')}`
        : 'no verification commands are declared by this contract',
    ],
    authorized: [
      'read the repository at the pinned commit',
      'create and push the branches Brain named, and only those',
      'install the repository\'s own dependencies and run its own tests and build',
    ],
    baseSha: base,
  });
  manifest.prohibitedActions = [
    ...manifest.prohibitedActions,
    `push, merge into or otherwise move ${campaign.integrationBranch} — integrating is a ` +
      'separate bin, judged by a session that did not implement any of this',
    'open, update or comment on a pull request',
  ];

  return await createBin({
    projectId: campaign.projectId,
    kind: 'FACTORY_UNITS',
    title: `Implement ${units.length} unit(s): ${changeRequest.objective.slice(0, 60)}`,
    objective: changeRequest.objective,
    rationale: `${units.length} unit(s) ready with dependencies satisfied.`,
    manifest,
    completionContract: 'FACTORY_UNITS_V1' as CompletionContract,
    priority: 7,
    createdByType: 'SYSTEM',
    createdById: `factory:units:${campaign.id}`,
    requiredCapabilities: [FACTORY_CAPABILITY, FACTORY_WRITE_CAPABILITY],
    workloadClass: 'FACTORY_UNIT',
    factoryCampaignId: campaign.id,
    ready: true,
    maxAttempts: 2,
  });
}

/**
 * The integration bin: the campaign's one branch, moved once, by somebody else.
 *
 * Three reasons it is its own bin rather than a last step of the implementation
 * bin. It is a different question — a unit is judged for staying inside its own
 * paths, an integration for carrying every unit and nothing else, and the two are
 * answered against different commit ranges. It is a separate lease, so on a fleet
 * with more than one surface that can push it is a separate session, and the
 * commit a pull request carries was assembled by somebody who wrote none of it —
 * a property of the fleet rather than a guarantee of this design, and never
 * reported as one. And it is the only bin authorized to move the integration
 * branch, which *is* a guarantee: "the branch moved once per round" is a property
 * of the work rather than a hope about a worker.
 *
 * The integrator is told not to push a tree the contract's own commands reject.
 * That is the remote shape of what the local integrator did by rolling the merge
 * back: a failed verification must leave the campaign's branch where it was, or
 * the pull request carries a commit nobody could have verified.
 */
export async function createIntegrateBin(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  units: FactoryWorkUnit[],
): Promise<Bin | null> {
  const mergeable = units.filter((unit) => unit.branch !== null && unit.headSha !== null);
  if (mergeable.length === 0) return null;
  const base = roundBaseFor(campaign);
  const order = mergeable.map((unit) => ({
    unitKey: unit.unitKey,
    branch: unit.branch,
    headSha: unit.headSha,
    ownedPaths: unit.ownedPaths,
  }));

  const manifest = baseManifest({
    role: 'INTEGRATE',
    objective: changeRequest.objective,
    why:
      'These unit branches are implemented and confirmed by the forge. The campaign has one ' +
      'branch, and this is the bin that moves it: merge them in the order given, run the ' +
      "repository's own commands on the merged tree, and push only if they pass.",
    campaign,
    changeRequest,
    units: [
      {
        key: 'integrate',
        establishes: [
          `Bring every branch listed in the input into ${campaign.integrationBranch}, in the ` +
            `order given, starting from ${base}.`,
          '',
          'Create the integration branch from that commit if it does not exist yet; otherwise ' +
            'start from where it is. Merge each unit branch in turn. Then run every command the ' +
            'contract declares on the merged tree.',
          '',
          '**Push the integration branch only if every command exits 0.** If one fails, or if a ' +
            'merge conflicts, push nothing and report BLOCKED with the command, its exit code ' +
            'and enough of its output to act on. A branch that carries a tree the contract ' +
            'rejects is worse than a branch that did not move.',
          '',
          /*
           * The fields are how Brain tells the two kinds of blocker apart, so the
           * contract says so rather than leaving it to be inferred. Brain reads the
           * `conflicts` list and the exit codes — never the prose — to decide
           * whether the work was judged at all, and therefore whether the units go
           * back for another attempt or keep their commits untouched.
           */
          'If you report BLOCKED, the fields decide what happens next, so fill them in. A merge ' +
            'conflict belongs in `conflicts`; a command that failed belongs in `commands` with ' +
            'its real exit code. **A BLOCKED report carrying neither tells Brain you never got ' +
            'as far as judging the work** — which is the right answer when the repository refused ' +
            'you, and the wrong one when a command failed, because then the work goes back ' +
            'unchanged and the next integrator meets the same failure.',
          '',
          'Then submit a result for unit key `integrate` with a JSON value of the shape ' +
            '{"outcome":"IMPLEMENTED"|"BLOCKED","integrationBranch","headSha",' +
            '"merged":[{"unitKey","branch","headSha"}],"conflicts":[],' +
            '"commands":[{"command","exitCode"}],"summary","blockedReason"}.',
          '',
          'Brain confirms with the forge that the branch is at the commit you report, that it ' +
            'carries every branch you say it merged, and that the whole range from the base ' +
            'touches no path outside the union of those units\' declared paths.',
        ].join('\n'),
        input: JSON.stringify({
          integrationBranch: campaign.integrationBranch,
          baseSha: base,
          mergeInOrder: order,
          verification:
            changeRequest.verificationCommands.length > 0
              ? changeRequest.verificationCommands
              : ['(this contract declares no verification commands)'],
        }),
        transform: 'FACTORY_INTEGRATE',
        dependsOn: [],
      },
    ],
    outputs: [
      `${campaign.integrationBranch} at a commit carrying all ${mergeable.length} unit branch(es)`,
      'one submitted result with key `integrate`',
    ],
    authorized: [
      'read the repository',
      `create and push ${campaign.integrationBranch}`,
      "install the repository's own dependencies and run its own commands",
    ],
    baseSha: base,
  });
  manifest.prohibitedActions = [
    ...manifest.prohibitedActions,
    'rewrite, force-push or delete any unit branch',
    'open, update or comment on a pull request — delivery is a later bin',
    'change any file yourself: resolving a conflict by editing the work is implementing, and ' +
      'this bin does not implement',
  ];

  return await createBin({
    projectId: campaign.projectId,
    kind: 'FACTORY_INTEGRATE',
    title: `Integrate ${mergeable.length} unit(s): ${changeRequest.objective.slice(0, 60)}`,
    objective: changeRequest.objective,
    rationale: `${mergeable.length} implemented unit(s) awaiting integration.`,
    manifest,
    completionContract: 'FACTORY_INTEGRATION_V1' as CompletionContract,
    priority: 8,
    createdByType: 'SYSTEM',
    createdById: `factory:integrate:${campaign.id}:${base.slice(0, 12)}`,
    requiredCapabilities: [FACTORY_CAPABILITY, FACTORY_WRITE_CAPABILITY],
    workloadClass: 'FACTORY_INTEGRATE',
    factoryCampaignId: campaign.id,
    ready: true,
    maxAttempts: 2,
  });
}

/**
 * The review bin.
 *
 * A separate bin on purpose, and that is the whole mechanism of independence
 * here: a bin holds exactly one lease, so a second bin is a second session, and
 * `services/research/independence.ts` reads the recorded lineage rather than a
 * role name. The reviewer is told the commit to read and is authorized to read
 * and run, never to write.
 */
export async function createReviewBin(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  reviewedSha: string,
  round: number,
): Promise<Bin> {
  const conditions = changeRequest.acceptanceConditions
    .map((condition) => `${condition.id}: ${condition.statement} (checked by: ${condition.verification})`)
    .join('\n');
  const manifest = baseManifest({
    role: 'REVIEW',
    objective: changeRequest.objective,
    why:
      'Somebody who did not write this has to judge it against the objective as it was ' +
      'approved, not against the summary of whoever implemented it. You are that session.',
    campaign,
    changeRequest,
    units: [
      {
        key: 'review',
        establishes: [
          `Read ${reviewedSha} and judge it against the objective and its acceptance conditions.`,
          '',
          conditions,
          '',
          'Ask the questions that matter: does the user-visible objective actually work through ' +
            'the repository\'s real entry points; can every state be reached; is any test ' +
            'asserting a state production cannot produce; does every producer have a consumer; ' +
            'did the change add burden the objective did not ask for.',
          'Submit a result for unit key `review` with a JSON value of the shape ' +
            '{"verdict":"PASS"|"CHANGES_REQUIRED"|"BLOCKED","reviewedSha","summary",' +
            '"findings":[{"key","severity":"BLOCKER"|"MAJOR"|"MINOR","category","statement",' +
            '"evidence","acceptanceConditionId"}]}. A PASS carrying a BLOCKER is refused.',
        ].join('\n'),
        input: JSON.stringify({
          reviewedSha,
          round,
          acceptanceConditions: changeRequest.acceptanceConditions.map((c) => c.id),
          verification: changeRequest.verificationCommands,
        }),
        transform: 'FACTORY_REVIEW',
        dependsOn: [],
      },
    ],
    outputs: ['one submitted unit result with key `review`'],
    authorized: [
      'read the repository at the commit named above',
      'run the repository\'s own tests and build to see for yourself',
    ],
    baseSha: campaign.baseSha,
  });
  manifest.prohibitedActions = [
    ...manifest.prohibitedActions,
    'change, commit or push anything — a reviewer that can edit what it reviews is not a reviewer',
  ];

  return await createBin({
    projectId: campaign.projectId,
    kind: 'FACTORY_REVIEW',
    title: `Review round ${round}: ${changeRequest.objective.slice(0, 60)}`,
    objective: changeRequest.objective,
    rationale: `Round ${round} against ${reviewedSha.slice(0, 12)}.`,
    manifest,
    completionContract: 'FACTORY_UNITS_V1' as CompletionContract,
    priority: 8,
    createdByType: 'SYSTEM',
    createdById: `factory:review:${campaign.id}:${round}`,
    requiredCapabilities: [FACTORY_CAPABILITY],
    workloadClass: 'FACTORY_REVIEW',
    factoryCampaignId: campaign.id,
    ready: true,
    maxAttempts: 2,
  });
}

/* ------------------------------------------------------------------------- */
/* Believing what comes back                                                  */
/* ------------------------------------------------------------------------- */

export interface ForgeVerdict {
  ok: boolean;
  /** Every reason it failed, so a worker is told all of them at once. */
  problems: string[];
  /** What the forge said the range touched, when it could be asked. */
  files: string[];
  verified: boolean;
}

/**
 * Is this report true about the repository, and did it stay inside its scope?
 *
 * Three checks, in the order that fails cheapest first: the branch is the one
 * Brain named; the forge agrees the branch is at that commit; the files the forge
 * says moved are all inside the unit's declared paths.
 *
 * A forge that cannot be read is a refusal. A truncated file list is also a
 * refusal — the compare endpoint caps its list, and a capped list cannot prove a
 * diff stayed inside a scope, so treating it as clean would be inventing the one
 * guarantee this function exists to provide.
 */
export async function verifyUnitReport(
  repository: ForgeRepository,
  expected: { branch: string; baseSha: string; ownedPaths: string[] },
  report: FactoryUnitReport,
): Promise<ForgeVerdict> {
  const problems: string[] = [];

  if (report.branch !== expected.branch) {
    problems.push(
      `The report names branch "${report.branch}"; this unit's branch is "${expected.branch}". ` +
        'Brain names the branch so that every push answers exactly one attempt of one unit.',
    );
    return { ok: false, problems, files: [], verified: false };
  }

  const head = await resolveBranch(repository, expected.branch);
  if (!head.ok || !head.body) {
    return {
      ok: false,
      problems: [
        `The forge could not confirm ${expected.branch}: ${head.reason ?? 'no answer'}. ` +
          'Push the branch before reporting it.',
      ],
      files: [],
      verified: false,
    };
  }
  if (head.body.sha !== report.headSha) {
    problems.push(
      `The report says ${report.headSha.slice(0, 12)} but the forge says ${expected.branch} is at ` +
        `${head.body.sha.slice(0, 12)}. Brain believes the repository.`,
    );
  }

  const comparison = await compareCommits(repository, expected.baseSha, head.body.sha);
  if (!comparison.ok || !comparison.body) {
    return {
      ok: false,
      problems: [
        ...problems,
        `The forge could not compare ${expected.baseSha.slice(0, 12)} with ` +
          `${head.body.sha.slice(0, 12)}: ${comparison.reason ?? 'no answer'}.`,
      ],
      files: [],
      verified: false,
    };
  }
  if (comparison.body.truncated) {
    return {
      ok: false,
      problems: [
        ...problems,
        'The forge truncated the list of changed files, so this diff cannot be shown to have ' +
          'stayed inside the unit\'s paths. That is refused rather than assumed: the check ' +
          'exists precisely for the case it cannot see.',
      ],
      files: comparison.body.files,
      verified: false,
    };
  }

  const outside = comparison.body.files.filter(
    (file) => !expected.ownedPaths.some((glob) => matchesGlob(file, glob)),
  );
  if (outside.length > 0) {
    problems.push(
      `${outside.length} file(s) changed outside this unit's declared paths: ` +
        `${outside.slice(0, 10).join(', ')}. The whole report is refused rather than the ` +
        'extra files ignored — a change nobody declared is a change nobody reviewed the scope of.',
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    files: comparison.body.files,
    verified: true,
  };
}

/** Every submitted result on a bin, parsed and keyed. Unparseable ones are kept as problems. */
export async function readUnitReports(
  binId: string,
): Promise<{ reports: Map<string, FactoryUnitReport>; problems: string[] }> {
  const reports = new Map<string, FactoryUnitReport>();
  const problems: string[] = [];
  for (const result of await listBinUnitResults(binId)) {
    let raw: unknown;
    try {
      raw = JSON.parse(result.value);
    } catch {
      problems.push(`The result for "${result.unitKey}" is not valid JSON.`);
      continue;
    }
    const parsed = parseUnitReport(raw);
    if (!parsed.ok) {
      problems.push(`The result for "${result.unitKey}" was refused: ${parsed.errors.join(' ')}`);
      continue;
    }
    if (parsed.value.unitKey !== result.unitKey) {
      problems.push(
        `The result submitted under "${result.unitKey}" names unit "${parsed.value.unitKey}".`,
      );
      continue;
    }
    reports.set(result.unitKey, parsed.value);
  }
  return { reports, problems };
}

/** The review a reviewer submitted, parsed, or the reasons it was refused. */
export async function readReviewReport(binId: string) {
  const results = await listBinUnitResults(binId);
  const submitted = results.find((row) => row.unitKey === 'review');
  if (!submitted) return { ok: false as const, errors: ['No review was submitted.'] };
  let raw: unknown;
  try {
    raw = JSON.parse(submitted.value);
  } catch {
    return { ok: false as const, errors: ['The review is not valid JSON.'] };
  }
  return parseReviewReport(raw);
}

/** The plan a planner submitted, still unvalidated — `validatePlan` is the judge. */
export async function readPlanProposal(binId: string): Promise<unknown | null> {
  const results = await listBinUnitResults(binId);
  const submitted = results.find((row) => row.unitKey === 'plan');
  if (!submitted) return null;
  try {
    return JSON.parse(submitted.value) as unknown;
  } catch {
    return null;
  }
}

/**
 * Record that a unit's pushed work is real, and move it on.
 *
 * The lease is taken here rather than assumed: the unit may have been retaken
 * while the bin was being worked, and a write that did not prove ownership in the
 * same statement is the one thing §19 forbids. A unit whose claim is lost is left
 * exactly as it was — the next tick will offer it again.
 */
export async function acceptUnitReport(input: {
  campaign: FactoryCampaign;
  unit: FactoryWorkUnit;
  report: FactoryUnitReport;
  files: string[];
  workerId: string;
  sessionId: string | null;
  /**
   * The bin whose report this is, recorded so the acceptance is idempotent by the
   * bin rather than by the unit's state. "It is no longer READY" was the only
   * guard, and it holds exactly while nothing else can return a unit to READY — a
   * refused integration does, and then this bin's old report was read again and
   * accepted the unit straight back to the commit the integration had just
   * refused. A loop that looks like progress is worse than a stop.
   */
  binId: string;
}): Promise<{ accepted: boolean; reason: string }> {
  const claimed = await claimUnits({
    campaignId: input.campaign.id,
    workerId: input.workerId,
    unitIds: [input.unit.id],
    sessionId: input.sessionId ?? undefined,
    leaseMs: 60_000,
  });
  const held = claimed[0];
  if (!held) {
    return { accepted: false, reason: 'The unit is no longer claimable; somebody else holds it.' };
  }

  const implemented = await markImplemented(
    {
      unitId: input.unit.id,
      workerId: input.workerId,
      leaseId: held.leaseId,
      leaseGeneration: held.leaseGeneration,
    },
    {
      branch: input.report.branch,
      headSha: input.report.headSha,
      baseSha: input.campaign.baseSha,
      worktreePath: null,
      workerSummary: input.report.summary,
      terminalResult: {
        outcome: input.report.outcome,
        commands: input.report.commands,
        // The forge's list, not the worker's. Both are kept so a later reader can
        // see whether the worker knew what it had changed.
        filesForgeReported: input.files,
        filesWorkerReported: input.report.filesChanged,
      },
    },
  );
  if (!implemented.ok) {
    return { accepted: false, reason: `The unit refused the result: ${implemented.reason}.` };
  }

  await recordFactoryEvent({
    campaignId: input.campaign.id,
    unitId: input.unit.id,
    workerId: input.workerId,
    sessionId: input.sessionId,
    kind: FACTORY_EVENT_KINDS.unitImplemented,
    evidenceClass: 'MEASURED',
    detail: {
      unitKey: input.unit.unitKey,
      binId: input.binId,
      branch: input.report.branch,
      headSha: input.report.headSha,
      filesForgeReported: input.files.length,
      verifiedBy: 'forge',
    },
  });

  /*
   * And no further. A confirmed branch is IMPLEMENTED and not INTEGRATED, which
   * is §25's rule that a dependency is satisfied by integration rather than by
   * implementation: a dependent unit must not branch from work that has not yet
   * been shown to merge, build and pass on one tree with everything else.
   *
   * The campaign's head is therefore untouched here. It moves in exactly one
   * place — when an integrator's push is confirmed — so there is no path by which
   * a pull request carries a commit no integration produced.
   */
  return { accepted: true, reason: 'Confirmed by the forge.' };
}

/* ------------------------------------------------------------------------- */
/* Believing an integration                                                   */
/* ------------------------------------------------------------------------- */

export interface IntegrationVerdict {
  ok: boolean;
  problems: string[];
  /** Every path the whole range from the base touched, as the forge reports it. */
  files: string[];
  /** The units the forge agrees are carried by the integration commit. */
  carried: string[];
}

/**
 * Is the campaign's branch really at this commit, and does that commit really
 * carry exactly the work it claims?
 *
 * Four questions, each answered by the repository rather than by the report:
 *
 *   * the branch is the one Brain named, and the forge agrees it is at the
 *     reported commit;
 *   * every unit branch the report says it merged is *contained* in that commit —
 *     the forge's own `identical` or `ahead` between the two, which is the only
 *     way to establish containment without holding either tree;
 *   * the whole range from the round's base touches no path outside the union of
 *     those units' declared paths, so an integrator cannot smuggle a change in
 *     under cover of a merge; and
 *   * the file list was not truncated, because a capped list cannot prove the
 *     third question and assuming it could would invent the guarantee.
 */
export async function verifyIntegrationReport(
  repository: ForgeRepository,
  expected: {
    integrationBranch: string;
    baseSha: string;
    units: { unitKey: string; headSha: string; ownedPaths: string[] }[];
  },
  report: FactoryIntegrationReport,
): Promise<IntegrationVerdict> {
  const problems: string[] = [];

  if (report.integrationBranch !== expected.integrationBranch) {
    return {
      ok: false,
      problems: [
        `The report names "${report.integrationBranch}"; this campaign's branch is ` +
          `"${expected.integrationBranch}". Brain names it so that one branch answers one ` +
          'campaign.',
      ],
      files: [],
      carried: [],
    };
  }

  const head = await resolveBranch(repository, expected.integrationBranch);
  if (!head.ok || !head.body) {
    return {
      ok: false,
      problems: [
        `The forge could not confirm ${expected.integrationBranch}: ${head.reason ?? 'no answer'}. ` +
          'Push the integration branch before reporting it.',
      ],
      files: [],
      carried: [],
    };
  }
  if (head.body.sha !== report.headSha) {
    problems.push(
      `The report says ${report.headSha.slice(0, 12)} but the forge says ` +
        `${expected.integrationBranch} is at ${head.body.sha.slice(0, 12)}. Brain believes the ` +
        'repository.',
    );
  }

  const carried: string[] = [];
  const declared = new Map(expected.units.map((unit) => [unit.unitKey, unit]));
  for (const merge of report.merged) {
    const unit = declared.get(merge.unitKey);
    if (!unit) {
      problems.push(
        `The report claims to have merged "${merge.unitKey}", which is not one of the units this ` +
          'bin was given.',
      );
      continue;
    }
    if (merge.headSha !== unit.headSha) {
      problems.push(
        `"${merge.unitKey}" was confirmed at ${unit.headSha.slice(0, 12)} and the report merged ` +
          `${merge.headSha.slice(0, 12)}. Brain integrates the commit it verified.`,
      );
      continue;
    }
    const containment = await compareCommits(repository, unit.headSha, head.body.sha);
    if (!containment.ok || !containment.body) {
      problems.push(
        `The forge could not relate ${unit.headSha.slice(0, 12)} to the integration commit: ` +
          `${containment.reason ?? 'no answer'}.`,
      );
      continue;
    }
    if (containment.body.status !== 'ahead' && containment.body.status !== 'identical') {
      problems.push(
        `The integration commit does not contain "${merge.unitKey}": the forge calls their ` +
          `relationship "${containment.body.status}". An integration that does not carry the work ` +
          'it names is not one.',
      );
      continue;
    }
    carried.push(merge.unitKey);
  }

  const comparison = await compareCommits(repository, expected.baseSha, head.body.sha);
  if (!comparison.ok || !comparison.body) {
    return {
      ok: false,
      problems: [
        ...problems,
        `The forge could not compare ${expected.baseSha.slice(0, 12)} with the integration ` +
          `commit: ${comparison.reason ?? 'no answer'}.`,
      ],
      files: [],
      carried,
    };
  }
  if (comparison.body.truncated) {
    return {
      ok: false,
      problems: [
        ...problems,
        'The forge truncated the list of changed files, so this integration cannot be shown to ' +
          'have stayed inside the units\' paths. Refused rather than assumed.',
      ],
      files: comparison.body.files,
      carried,
    };
  }

  const allowed = report.merged
    .map((merge) => declared.get(merge.unitKey))
    .filter((unit): unit is { unitKey: string; headSha: string; ownedPaths: string[] } => !!unit)
    .flatMap((unit) => unit.ownedPaths);
  const outside = comparison.body.files.filter(
    (file) => !allowed.some((glob) => matchesGlob(file, glob)),
  );
  if (outside.length > 0) {
    problems.push(
      `${outside.length} file(s) in this integration are outside every merged unit's declared ` +
        `paths: ${outside.slice(0, 10).join(', ')}. The whole integration is refused.`,
    );
  }

  return { ok: problems.length === 0, problems, files: comparison.body.files, carried };
}

/**
 * Record an integration Brain has confirmed.
 *
 * The units it carries become INTEGRATED and the campaign's head moves — in that
 * order, and only here. Every unit gets its own integration row carrying the same
 * before and after, because "which commit did this unit land in" is a question a
 * reader will ask about one unit rather than about the round.
 */
export async function acceptIntegration(input: {
  campaign: FactoryCampaign;
  units: FactoryWorkUnit[];
  report: FactoryIntegrationReport;
  verdict: IntegrationVerdict;
  baseSha: string;
  workerId: string;
  sessionId: string | null;
  /** The bin this report came from, so the ingest is idempotent by the bin. */
  binId: string;
}): Promise<{ integrated: string[] }> {
  const integrated: string[] = [];
  const byKey = new Map(input.units.map((unit) => [unit.unitKey, unit]));
  for (const key of input.verdict.carried) {
    const unit = byKey.get(key);
    if (!unit) continue;
    const moved = await markIntegrated(unit.id, input.report.headSha);
    if (!moved) continue;
    await recordIntegration({
      campaignId: input.campaign.id,
      unitId: unit.id,
      attempt: unit.attempt,
      outcome: 'MERGED',
      reason:
        'The forge confirmed the integration branch at this commit, confirmed it contains the ' +
        "unit's verified head, and confirmed the range touched no undeclared path.",
      rejectedPaths: [],
      verification: input.report.commands.map((command) => ({
        command: command.command,
        exitCode: command.exitCode,
        durationMs: 0,
        tail: '',
      })),
      beforeSha: input.baseSha,
      afterSha: input.report.headSha,
      integratorSessionId: input.sessionId,
    });
    integrated.push(key);
  }
  if (integrated.length > 0) {
    await patchCampaign(input.campaign.id, { integrationSha: input.report.headSha });
    await recordFactoryEvent({
      campaignId: input.campaign.id,
      workerId: input.workerId,
      sessionId: input.sessionId,
      kind: FACTORY_EVENT_KINDS.integrationMerged,
      evidenceClass: 'MEASURED',
      detail: {
        integrationBranch: input.report.integrationBranch,
        binId: input.binId,
        beforeSha: input.baseSha,
        afterSha: input.report.headSha,
        units: integrated,
        filesForgeReported: input.verdict.files.length,
        verifiedBy: 'forge',
      },
    });
  }
  return { integrated };
}

/**
 * What the repository's own continuous integration says about a commit.
 *
 * Kept as a reading rather than folded into a verdict, because its three answers
 * are different facts with different consequences and a caller has to be able to
 * tell them apart. Absent is recorded as absent; `evidenceClass` says so.
 */
export async function integrationChecks(
  repository: ForgeRepository,
  sha: string,
): Promise<ForgeChecks | null> {
  const reply = await readChecks(repository, sha);
  return reply.ok && reply.body ? reply.body : null;
}

/* ------------------------------------------------------------------------- */
/* Delivering it                                                              */
/* ------------------------------------------------------------------------- */

/**
 * The delivery bin: the reviewable artifact, opened or updated once.
 *
 * Brain composes the title and the body — `assemble.ts` and `pullRequest.ts`
 * already do, from rows — and the worker performs the one action Brain cannot,
 * because the credential that may write to the repository lives where the worker
 * runs and nowhere else. That split is the whole of requirement 9 and it needs no
 * mechanism: there is no secret on this side to leak.
 *
 * It stops at a pull request. A worker authorized to merge it would be a factory
 * that decides what ships, and §25 gives that decision to a person.
 */
export async function createDeliverBin(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  deliverable: { title: string; body: string },
): Promise<Bin> {
  const existing = pullRequestNumber(campaign);
  const head = campaign.integrationSha ?? campaign.baseSha;
  const manifest = baseManifest({
    role: 'DELIVER',
    objective: changeRequest.objective,
    why:
      'The work is integrated and a session that did not write it has passed it. What is left ' +
      'is the one action Brain cannot perform: putting it in front of a person as a pull ' +
      'request. Brain wrote the title and the body; use them exactly.',
    campaign,
    changeRequest,
    units: [
      {
        key: 'deliver',
        establishes: [
          existing === null
            ? `Open one pull request from ${campaign.integrationBranch} into ` +
              `${changeRequest.baseBranch}, using the title and body in the input verbatim.`
            : `Update pull request #${existing} — do not open another — setting its title and ` +
              'body to the ones in the input verbatim. Its head branch already points at this ' +
              'campaign, so nothing needs pushing.',
          '',
          'Do not merge it. Do not approve it. Do not change any file. Do not edit the body to ' +
            'add anything of your own: it is composed from the campaign\'s rows and a sentence ' +
            'you wrote yourself would be the one sentence in it that resolves to nothing.',
          '',
          'Then submit a result for unit key `deliver` with a JSON value of the shape ' +
            '{"outcome":"IMPLEMENTED"|"BLOCKED","pullRequest","headSha","action":' +
            '"OPENED"|"UPDATED","summary","blockedReason"}. Brain reads the request back from ' +
            'the forge and confirms its head is the integrated commit.',
        ].join('\n'),
        input: JSON.stringify({
          pullRequest: existing,
          head: campaign.integrationBranch,
          headSha: head,
          base: changeRequest.baseBranch,
          title: deliverable.title,
          body: deliverable.body,
        }),
        transform: 'FACTORY_DELIVER',
        dependsOn: [],
      },
    ],
    outputs: [
      existing === null
        ? 'one open pull request carrying the integrated commit'
        : `pull request #${existing}, updated once`,
      'one submitted result with key `deliver`',
    ],
    authorized: [
      'read the repository',
      existing === null
        ? `open one pull request from ${campaign.integrationBranch}`
        : `update the title and body of pull request #${existing}`,
    ],
    /*
     * For a delivery the "base" is the commit being delivered, not a commit the
     * work starts from — there is no work. It is recorded there because that is
     * the field a later tick reads back with `binBaseOf` to answer "has this
     * commit already been put in front of a person", which is the whole of how
     * "exactly once" is kept without a flag.
     */
    baseSha: head,
  });
  manifest.prohibitedActions = [
    ...manifest.prohibitedActions,
    'merge, approve, close or request review on any pull request',
    'open a second pull request',
    'change, commit or push anything at all',
  ];

  return await createBin({
    projectId: campaign.projectId,
    kind: 'FACTORY_DELIVER',
    title: existing === null
      ? `Open the pull request: ${changeRequest.objective.slice(0, 60)}`
      : `Update pull request #${existing}: ${changeRequest.objective.slice(0, 60)}`,
    objective: changeRequest.objective,
    rationale: 'Reviewed, integrated and confirmed; a person has to be able to read it.',
    manifest,
    completionContract: 'FACTORY_DELIVERY_V1' as CompletionContract,
    priority: 9,
    createdByType: 'SYSTEM',
    createdById: `factory:deliver:${campaign.id}:${head.slice(0, 12)}`,
    requiredCapabilities: [FACTORY_CAPABILITY, FACTORY_WRITE_CAPABILITY],
    workloadClass: 'FACTORY_DELIVER',
    factoryCampaignId: campaign.id,
    ready: true,
    maxAttempts: 2,
  });
}

export interface DeliveryVerdict {
  ok: boolean;
  problems: string[];
  number: number | null;
  url: string | null;
  headSha: string | null;
}

/**
 * Did the pull request the worker reported actually land, and on this work?
 *
 * Read back from the forge, and checked against the campaign rather than against
 * the report: the request must exist, be open, point its head at the commit Brain
 * integrated, and target the branch the contract pinned. A request whose head has
 * moved on since is not evidence for this campaign — it is evidence for whatever
 * is on it now.
 */
export async function verifyDelivery(
  repository: ForgeRepository,
  expected: { headSha: string; baseBranch: string; pullRequest: number | null },
  report: FactoryDeliveryReport,
): Promise<DeliveryVerdict> {
  const number = report.pullRequest;
  if (number === null) {
    return {
      ok: false,
      problems: ['The report names no pull request number.'],
      number: null,
      url: null,
      headSha: null,
    };
  }
  if (expected.pullRequest !== null && expected.pullRequest !== number) {
    return {
      ok: false,
      problems: [
        `This campaign updates pull request #${expected.pullRequest}; the report names ` +
          `#${number}. Opening a second request rather than updating the one a person is ` +
          'already reading is refused.',
      ],
      number,
      url: null,
      headSha: null,
    };
  }
  const reply = await readPullRequest(repository, number);
  if (!reply.ok || !reply.body) {
    return {
      ok: false,
      problems: [`The forge could not read pull request #${number}: ${reply.reason ?? 'no answer'}.`],
      number,
      url: null,
      headSha: null,
    };
  }
  const problems: string[] = [];
  const pull = reply.body;
  if (pull.headSha !== expected.headSha) {
    problems.push(
      `Pull request #${number} points at ${pull.headSha.slice(0, 12)} and this campaign ` +
        `integrated ${expected.headSha.slice(0, 12)}.`,
    );
  }
  /*
   * Where it is aimed, but only for a request the factory opened.
   *
   * A campaign that *continues* an existing request keeps whatever base that
   * request already has — which is the point of continuing it — and the factory
   * must not retarget somebody else's open request. So this is the one check that
   * applies to an opening and not to an update.
   */
  if (expected.pullRequest === null && pull.baseRef !== expected.baseBranch) {
    problems.push(
      `Pull request #${number} targets ${pull.baseRef}; this contract is pinned against ` +
        `${expected.baseBranch}.`,
    );
  }
  if (pull.merged) {
    problems.push(
      `Pull request #${number} is already merged. The factory may not merge, so this was a ` +
        "person's decision — it is recorded rather than treated as the factory's delivery.",
    );
  }
  return {
    ok: problems.length === 0,
    problems,
    number,
    url: pull.url.length > 0 ? pull.url : null,
    headSha: pull.headSha,
  };
}

/** Every submitted integration report on a bin. */
export async function readIntegrationReport(
  binId: string,
): Promise<{ ok: true; value: FactoryIntegrationReport } | { ok: false; errors: string[] }> {
  return await readSingle(binId, 'integrate', parseIntegrationReport);
}

/** The delivery report on a bin. */
export async function readDeliveryReport(
  binId: string,
): Promise<{ ok: true; value: FactoryDeliveryReport } | { ok: false; errors: string[] }> {
  return await readSingle(binId, 'deliver', parseDeliveryReport);
}

async function readSingle<T>(
  binId: string,
  unitKey: string,
  parse: (raw: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
): Promise<{ ok: true; value: T } | { ok: false; errors: string[] }> {
  for (const result of await listBinUnitResults(binId)) {
    if (result.unitKey !== unitKey) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(result.value);
    } catch {
      return { ok: false, errors: [`The result for "${unitKey}" is not valid JSON.`] };
    }
    return parse(raw);
  }
  return { ok: false, errors: [`No result was submitted for "${unitKey}".`] };
}

/** The bins this campaign has, newest first. */
export async function campaignBins(campaignId: string): Promise<Bin[]> {
  const { getDb } = await import('../../db/database.ts');
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM bins WHERE factory_campaign_id = ? ORDER BY created_at DESC`,
    [campaignId],
  );
  const bins: Bin[] = [];
  for (const row of rows) {
    const bin = await getBin(row.id);
    if (bin) bins.push(bin);
  }
  return bins;
}

/** Whether this campaign already has a live bin for a stage, so a tick adds no second one. */
export function liveBinOfKind(bins: Bin[], kind: string): Bin | null {
  return (
    bins.find(
      (bin) => bin.kind === kind && (bin.state === 'READY' || bin.state === 'LEASED' || bin.state === 'DRAFT'),
    ) ?? null
  );
}

/** The repository a campaign works in, or null when its remote is not one we read. */
export async function repositoryOf(campaign: FactoryCampaign): Promise<ForgeRepository | null> {
  const changeRequest = await getChangeRequest(campaign.changeRequestId);
  if (!changeRequest) return null;
  return parseRemote(changeRequest.repository);
}

/** Units whose dependencies have landed and which have no live bin yet. */
export async function readyUnitsFor(campaignId: string): Promise<FactoryWorkUnit[]> {
  const units = await listUnits(campaignId);
  return units.filter((unit) => unit.state === 'READY');
}

/**
 * How a campaign for this contract must be executed, derived rather than chosen.
 *
 * A contract pinned from a checkout has a `repositoryRoot`; one pinned from the
 * forge does not, because the checkout belongs to whichever worker takes the work.
 * So the absence of a root *is* the statement that execution is remote, and both
 * entrances — the HTTP route and the operator command — read it from the same
 * function rather than each deciding for itself.
 */
export function executionModeFor(changeRequest: FactoryChangeRequest): 'LOCAL' | 'REMOTE' {
  const root = (changeRequest.repositoryRoot ?? '').trim();
  return root.length > 0 ? 'LOCAL' : 'REMOTE';
}


/**
 * How a campaign for this contract is created, asked once and answered from the
 * forge rather than from a caller.
 *
 * Two facts come out of it, and the second is the interesting one. **A campaign
 * pinned at a branch that is already an open pull request's head continues that
 * request.** It is derived rather than supplied for the reason every other
 * envelope in this codebase exists: a number in a request body would be a caller
 * choosing which pull request the factory writes into, and an open request is
 * somebody's reading surface. A branch that is nobody's head means open a new one.
 *
 * That is also what makes "update the existing request" possible at all without a
 * special case: continuing it means landing the work on the branch it already
 * points at, so the campaign's integration branch *is* that branch, and the
 * request updates because its head moved.
 */
export interface CampaignSpec {
  executionMode: 'LOCAL' | 'REMOTE';
  /** Set only when continuing an existing request; otherwise the derived name. */
  integrationBranch: string | null;
  pullRequest: number | null;
  /** What was decided, in a sentence, for the event row and for a person. */
  note: string;
}

export async function campaignSpecFor(
  changeRequest: FactoryChangeRequest,
): Promise<CampaignSpec> {
  const executionMode = executionModeFor(changeRequest);
  if (executionMode === 'LOCAL') {
    return {
      executionMode,
      integrationBranch: null,
      pullRequest: null,
      note: 'Executed from a checkout on this machine.',
    };
  }
  const repository = parseRemote(changeRequest.repository);
  if (!repository) {
    return {
      executionMode,
      integrationBranch: null,
      pullRequest: null,
      note: 'The repository is not one this Brain can read, so no pull request was looked up.',
    };
  }
  const found = await findPullRequestForBranch(repository, changeRequest.baseBranch);
  if (found.ok && found.body) {
    return {
      executionMode,
      integrationBranch: changeRequest.baseBranch,
      pullRequest: found.body.number,
      note:
        `Continues pull request #${found.body.number}, whose head is already ` +
        `${changeRequest.baseBranch}. The work lands on that branch and the request updates.`,
    };
  }
  return {
    executionMode,
    integrationBranch: null,
    pullRequest: null,
    note: 'No open pull request has this branch as its head, so one will be opened.',
  };
}

/**
 * Who produced a bin's results: the session from the worker, the account and the
 * worker identity from Brain's own dispatch row.
 *
 * The split is not a compromise, it is what the two facts are. Brain wrote
 * `worker_sessions` from the dispatch it sent, so the account and the worker come
 * from there and from nothing the worker said. But that row is keyed by the
 * *credential*, and the credential is per-connector rather than per-session — so
 * it cannot say which of an account's sessions this was, and the only thing that
 * can is the session reference the worker reported.
 *
 * I had this the other way round first, on the reasoning that an independence
 * decision must never rest on a value the claimant supplies. The reasoning holds
 * and the premise did not: comparing credentials would have made every reviewer
 * identical to every implementer and refused every review for ever. §24 settled
 * the same question the same way and says so — a reported session, validated
 * against a real credential of the presenting worker.
 */
export async function binIdentity(
  bin: Bin,
): Promise<{ sessionId: string | null; workerId: string | null; accountId: string | null }> {
  const { workerSessionForBin } = await import('../../repos/fleet.ts');
  const observed = await workerSessionForBin(bin.id);
  return {
    /*
     * The session the worker reported, which is the finest identity this surface
     * exposes. `worker_sessions.session_ref` is the *credential*, and the
     * credential is per-connector rather than per-session — every session this
     * account fires presents the same one — so it answers "which account and
     * Routine" and cannot answer "which session". `bins.lease_session_ref` can,
     * and unlike the lease itself it survives `finishBin`.
     */
    sessionId: bin.leaseSessionRef,
    // These two are Brain's own: written from the dispatch row it sent, never
    // from anything the worker said about itself.
    workerId: observed?.workerId ?? bin.workerId,
    accountId: observed?.accountId ?? null,
  };
}

/**
 * Who actually did the implementing, read from the ledger.
 *
 * Every accepted unit report writes a `UNIT_IMPLEMENTED` row carrying the bin's
 * worker and lease session, so the set of sessions that wrote this campaign's
 * code is a query rather than an assumption. That is the whole input to the
 * review-independence decision below, and it is deliberately the recorded
 * lineage rather than a role name: §23's rule, at the factory's boundary.
 */
export async function implementingSessions(
  campaignId: string,
): Promise<{ sessions: Set<string>; workers: Set<string> }> {
  const { listFactoryEvents } = await import('../../repos/factoryFleet.ts');
  const events = await listFactoryEvents(campaignId, {
    kinds: [FACTORY_EVENT_KINDS.unitImplemented, FACTORY_EVENT_KINDS.integrationMerged],
  });
  const sessions = new Set<string>();
  const workers = new Set<string>();
  for (const event of events) {
    if (event.sessionId) sessions.add(event.sessionId);
    if (event.workerId) workers.add(event.workerId);
  }
  return { sessions, workers };
}

export interface ReviewLineage {
  ok: boolean;
  /** The tier actually achieved, never rounded up. */
  independence: 'SESSION_SEPARATED' | 'WORKER_SEPARATED' | 'ACCOUNT_SEPARATED';
  reason: string | null;
}

/**
 * Is this reviewer independent of the work it is judging, and how independent?
 *
 * The floor is a **different session** from every session that implemented the
 * work, and it is a refusal rather than a label: a verdict from the context that
 * wrote the code is the one thing an independent review exists to prevent, so
 * nothing is recorded at all. `WORKER_SEPARATED` is reported when the reviewer's
 * worker identity also differs, which is a stronger assurance the fleet either
 * supplies or does not.
 *
 * Unknown lineage fails closed. A review bin that records no session cannot be
 * shown to be independent, and "we could not tell" must never read the same as
 * "we checked" — §23's sentence, which this codebase has now needed at four
 * altitudes.
 *
 * `ACCOUNT_SEPARATED` is deliberately not derivable here. It would need the
 * account each session's Routine resolves to, and claiming it from a worker id
 * would be reporting a separation the fleet may not have.
 */
export async function reviewLineage(
  campaignId: string,
  reviewer: { sessionId: string | null; workerId: string | null },
): Promise<ReviewLineage> {
  if (!reviewer.sessionId) {
    return {
      ok: false,
      independence: 'SESSION_SEPARATED',
      reason:
        'The review bin recorded no session, so its independence from the work cannot be ' +
        'established. An audit whose independence cannot be established did not establish it.',
    };
  }
  const { sessions, workers } = await implementingSessions(campaignId);
  if (sessions.has(reviewer.sessionId)) {
    return {
      ok: false,
      independence: 'SESSION_SEPARATED',
      reason:
        `Session ${reviewer.sessionId} implemented part of this campaign, so its verdict on the ` +
        'same work is not an independent review. Nothing is recorded. The remedy is operational: ' +
        'a fleet surface that can read the repository and did not write this work.',
    };
  }
  const workerSeparated =
    reviewer.workerId !== null && !workers.has(reviewer.workerId) && workers.size > 0;
  return {
    ok: true,
    independence: workerSeparated ? 'WORKER_SEPARATED' : 'SESSION_SEPARATED',
    reason: null,
  };
}

export function nowIso(): string {
  return factoryNow();
}

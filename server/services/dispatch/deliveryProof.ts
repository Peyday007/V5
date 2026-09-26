/**
 * Can this Routine actually deliver to this repository?
 *
 * ---------------------------------------------------------------------------
 * Why the surface proof was not enough
 * ---------------------------------------------------------------------------
 *
 * `proveSurface` asks four rows: Brain fired the Routine, a session arrived as
 * the bound worker, it was handed a bin, the bin completed. That establishes the
 * **Brain half** of a surface — the connector, the identity, the queue — and it
 * was reported as VERIFIED. On 2026-09-26 a surface verified that way declared
 * `repository-write`, was handed real Factory work, planned it, implemented it,
 * typechecked it, passed review, and then could not push a single commit:
 * Claude's git proxy answered *"Peyday007/V5 is not in this session's authorized
 * repository set"*, because the Routine that starts its sessions was attached to
 * a different repository. Nothing Brain had checked could have seen it, and the
 * first reading was a real build discarded at its last step.
 *
 * So the repository half is its own proof, per repository, and it is the same
 * shape as the work it stands in for: the session Brain fires at this Routine
 * clones the repository, creates a disposable branch, pushes one harmless
 * commit, opens a pull request, closes it **without merging** and deletes the
 * branch. Brain then reads the forge — never the worker's summary — and records
 * PROVEN only if the pull request exists at the reported commit, touched nothing
 * but the probe's own file, is closed and was not merged.
 *
 * ---------------------------------------------------------------------------
 * The three tiers, and what reads each one
 * ---------------------------------------------------------------------------
 *
 *   CONNECTED             an arrival authenticated as the bound worker
 *   EXECUTION_VERIFIED    `proveSurface`'s four-row chain closed
 *   DELIVERY_VERIFIED     the newest settled delivery probe for (Routine,
 *                         repository) is PROVEN
 *
 * The router fires a bin requiring `repository-write` only at a Routine at the
 * third tier for that bin's repository (`deliveryProvenFor`), and the assigner
 * asks the same question of an arriving session. Planning and review require
 * only `repository` and are untouched: a read-only surface is still a reviewer.
 *
 * Nothing here merges, deploys or holds a credential. The worker's access is
 * granted where it runs — which is exactly the thing being measured.
 */
import { randomBytes } from 'node:crypto';
import { createBin, getBin, listBinUnitResults, markBinReady } from '../../repos/bins.ts';
import { listMembershipsForPrincipal } from '../../repos/identity.ts';
import { getDb } from '../../db/database.ts';
import {
  createDeliveryProof,
  getDeliveryProofByBin,
  listPendingDeliveryProofs,
  normalizeRepository,
  settleDeliveryProof,
} from '../../repos/deliveryProofs.ts';
import {
  DELIVERY_FAILURE_STEPS,
  type Bin,
  type DeliveryFailureStep,
  type RoutineDeliveryProof,
} from '../../domain/types.ts';
import { nowIso } from '../../repos/util.ts';
import type { ContractVerdict } from '../bins/contracts.ts';
import { DELIVERY_PROBE_CLASS } from './router.ts';

export const DELIVERY_PROBE_CONTRACT = 'FACTORY_DELIVERY_PROBE_V1';
export const DELIVERY_PROBE_UNIT = 'deliver';

/** The steps a worker may report as where it stopped. The rest are Brain's. */
export const WORKER_REPORTABLE_STEPS: readonly DeliveryFailureStep[] = [
  'REPOSITORY_NOT_IN_SESSION',
  'CLONE_REFUSED',
  'BRANCH_OR_PUSH_REFUSED',
  'PULL_REQUEST_REFUSED',
  'CLEANUP_REFUSED',
];

/** What each failure step means an operator has to fix, in words. */
export const DELIVERY_REMEDY: Record<DeliveryFailureStep, string> = {
  REPOSITORY_NOT_IN_SESSION:
    'The Claude Routine is not attached to this repository, so its sessions get no credential for it. ' +
    'In the account that owns the Routine: open the Routine, set Repository to this repository ' +
    '(branch production), save, then re-run the probe.',
  CLONE_REFUSED:
    'The session could not read the repository. Check the account holder has GitHub access to it and ' +
    'that the Claude GitHub app is authorized for it.',
  BRANCH_OR_PUSH_REFUSED:
    'The session could read but not push. The account holder needs write (collaborator) access, and the ' +
    'Routine must be attached to this repository so the proxy injects a credential for it.',
  PULL_REQUEST_REFUSED:
    'The push worked but a pull request could not be opened from the session. Check the Claude GitHub ' +
    'app is authorized for this repository in the account that owns the Routine.',
  CLEANUP_REFUSED:
    'Delivery worked but the probe pull request or branch could not be closed or deleted. Close it by hand; ' +
    'the surface can still push, and the probe can be re-run once cleanup is possible.',
  REPORT_UNREADABLE: 'The worker answered in a shape Brain could not read. Re-run the probe.',
  FORGE_DID_NOT_CONFIRM:
    'The worker reported a delivery the forge does not show. Re-run the probe; if it repeats, the session is ' +
    'not pushing where it says it is.',
  PULL_REQUEST_MERGED:
    'The probe pull request was MERGED, which a probe must never do. Revert it by hand and investigate the ' +
    'Routine before it is given any work.',
  BIN_NOT_COMPLETED:
    'The probe bin ended without a result — the session never arrived, or never finished. Check the ' +
    'surface proof first (verify-surface), then re-run the probe.',
};

export interface DeliveryProbeReport {
  outcome: 'DELIVERED' | 'BLOCKED';
  branch?: string;
  headSha?: string;
  pullRequest?: number;
  step?: DeliveryFailureStep;
  detail?: string;
}

/** Strict parse: an unknown field or a wrong type refuses the whole report. */
export function parseDeliveryProbeReport(
  value: string,
): { ok: true; report: DeliveryProbeReport } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return { ok: false, error: 'The unit result is not JSON.' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'The unit result must be a JSON object.' };
  }
  const allowed = new Set(['outcome', 'branch', 'headSha', 'pullRequest', 'step', 'detail']);
  const extra = Object.keys(raw).filter((key) => !allowed.has(key));
  if (extra.length > 0) return { ok: false, error: `Unknown field(s): ${extra.join(', ')}.` };
  const r = raw as Record<string, unknown>;
  if (r.outcome === 'BLOCKED') {
    if (typeof r.step !== 'string' || !WORKER_REPORTABLE_STEPS.includes(r.step as DeliveryFailureStep)) {
      return {
        ok: false,
        error: `A BLOCKED report must name "step" as one of: ${WORKER_REPORTABLE_STEPS.join(', ')}.`,
      };
    }
    return {
      ok: true,
      report: {
        outcome: 'BLOCKED',
        step: r.step as DeliveryFailureStep,
        detail: typeof r.detail === 'string' ? r.detail.slice(0, 2000) : undefined,
      },
    };
  }
  if (r.outcome !== 'DELIVERED') return { ok: false, error: '"outcome" must be DELIVERED or BLOCKED.' };
  if (typeof r.branch !== 'string' || r.branch.length === 0) return { ok: false, error: '"branch" is required.' };
  if (typeof r.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(r.headSha)) {
    return { ok: false, error: '"headSha" must be the 40-character commit you pushed.' };
  }
  if (typeof r.pullRequest !== 'number' || !Number.isInteger(r.pullRequest) || r.pullRequest < 1) {
    return { ok: false, error: '"pullRequest" must be the number of the pull request you opened.' };
  }
  return {
    ok: true,
    report: {
      outcome: 'DELIVERED',
      branch: r.branch,
      headSha: r.headSha,
      pullRequest: r.pullRequest,
      detail: typeof r.detail === 'string' ? r.detail.slice(0, 2000) : undefined,
    },
  };
}

/** The forge's account of a reported delivery. Never the worker's. */
export interface DeliveryVerdict {
  ok: boolean;
  /** Set when the problem is permanent for this probe rather than a retry. */
  failureStep: DeliveryFailureStep | null;
  problems: string[];
  /** True when the forge itself could not be read — never a verdict about the surface. */
  forgeUnreadable: boolean;
}

export async function verifyDeliveryProbe(
  proof: Pick<RoutineDeliveryProof, 'repository' | 'branch' | 'probePath'>,
  report: DeliveryProbeReport,
  base: string,
): Promise<DeliveryVerdict> {
  const { parseRemote, readPullRequest, compareCommits, resolveBranch } = await import(
    '../factory/forge.ts'
  );
  const repository = parseRemote(`https://github.com/${proof.repository}`);
  if (!repository) {
    return { ok: false, failureStep: 'FORGE_DID_NOT_CONFIRM', problems: ['Unreadable repository.'], forgeUnreadable: false };
  }
  const problems: string[] = [];
  if (report.branch !== proof.branch) {
    return {
      ok: false,
      failureStep: 'FORGE_DID_NOT_CONFIRM',
      problems: [`The report names branch ${report.branch}; this probe declared ${proof.branch}.`],
      forgeUnreadable: false,
    };
  }
  const pr = await readPullRequest(repository, report.pullRequest!);
  if (!pr.ok || !pr.body) {
    return {
      ok: false,
      failureStep: pr.status === 404 ? 'FORGE_DID_NOT_CONFIRM' : null,
      problems: [`The forge did not show pull request #${report.pullRequest}: ${pr.reason ?? 'no answer'}.`],
      forgeUnreadable: pr.status !== 404,
    };
  }
  if (pr.body.merged) {
    return {
      ok: false,
      failureStep: 'PULL_REQUEST_MERGED',
      problems: [`Pull request #${pr.body.number} was merged. A probe must never merge.`],
      forgeUnreadable: false,
    };
  }
  if (pr.body.headRef !== proof.branch) {
    problems.push(`Pull request #${pr.body.number} is from ${pr.body.headRef}, not ${proof.branch}.`);
  }
  if (pr.body.headSha !== report.headSha) {
    problems.push(`Pull request #${pr.body.number} is at ${pr.body.headSha}, not the reported ${report.headSha}.`);
  }
  if (problems.length > 0) {
    return { ok: false, failureStep: 'FORGE_DID_NOT_CONFIRM', problems, forgeUnreadable: false };
  }
  const diff = await compareCommits(repository, base, report.headSha!);
  if (!diff.ok || !diff.body) {
    return {
      ok: false,
      failureStep: null,
      problems: [`The forge could not compare ${base}...${report.headSha}: ${diff.reason ?? 'no answer'}.`],
      forgeUnreadable: true,
    };
  }
  const files = diff.body.files;
  if (files.length !== 1 || files[0] !== proof.probePath) {
    return {
      ok: false,
      failureStep: 'FORGE_DID_NOT_CONFIRM',
      problems: [
        `The pushed commit changed ${files.length === 0 ? 'nothing' : files.join(', ')}; ` +
          `a probe changes exactly ${proof.probePath}.`,
      ],
      forgeUnreadable: false,
    };
  }
  // Cleanup: closed and branch gone. Both are retries — the worker can still do them.
  if (pr.body.state !== 'closed') {
    problems.push(`Pull request #${pr.body.number} is still ${pr.body.state}; close it without merging.`);
  }
  const branch = await resolveBranch(repository, proof.branch);
  if (branch.ok && branch.body) {
    problems.push(`Branch ${proof.branch} still exists; delete it.`);
  } else if (!branch.ok && branch.status !== 404) {
    return {
      ok: false,
      failureStep: null,
      problems: [`The forge could not say whether ${proof.branch} was deleted: ${branch.reason ?? 'no answer'}.`],
      forgeUnreadable: true,
    };
  }
  return { ok: problems.length === 0, failureStep: null, problems, forgeUnreadable: false };
}

/** The contract evaluator: may this probe bin finish? */
export async function evaluateDeliveryProbe(bin: Bin): Promise<ContractVerdict> {
  const observed = { kind: bin.kind, contract: DELIVERY_PROBE_CONTRACT };
  const proof = await getDeliveryProofByBin(bin.id);
  if (!proof) {
    return { satisfied: false, disposition: 'HUMAN', reasons: ['No delivery proof row names this bin.'], observed };
  }
  const results = await listBinUnitResults(bin.id);
  const result = results.find((unit) => unit.unitKey === DELIVERY_PROBE_UNIT);
  if (!result) {
    return {
      satisfied: false,
      disposition: 'RETRY',
      reasons: [`Submit a result for unit "${DELIVERY_PROBE_UNIT}" — DELIVERED or BLOCKED.`],
      observed,
    };
  }
  const parsed = parseDeliveryProbeReport(result.value);
  if (!parsed.ok) return { satisfied: false, disposition: 'RETRY', reasons: [parsed.error], observed };
  // An honest blocker is a result: the probe has answered, and the proof records where it stopped.
  if (parsed.report.outcome === 'BLOCKED') return { satisfied: true, disposition: 'SATISFIED', reasons: [], observed };
  const verdict = await verifyDeliveryProbe(proof, parsed.report, baseOf(bin));
  if (verdict.ok) return { satisfied: true, disposition: 'SATISFIED', reasons: [], observed };
  if (verdict.failureStep === 'PULL_REQUEST_MERGED') {
    return { satisfied: false, disposition: 'HUMAN', reasons: verdict.problems, observed };
  }
  return { satisfied: false, disposition: 'RETRY', reasons: verdict.problems, observed };
}

function baseOf(bin: Bin): string {
  const ref = bin.manifest.repository?.ref;
  return typeof ref === 'string' && ref.length > 0 ? ref : 'main';
}

export class DeliveryProbeRefused extends Error {}

/**
 * Create one delivery probe bin pinned to one Routine, and its PENDING proof row.
 *
 * The branch and file names carry a random nonce Brain chose, so only a session
 * that was handed this bin can know them — which is what makes a pull request
 * from that branch evidence about *this* fire.
 */
export async function createDeliveryProbe(input: {
  routine: { id: string; name: string; routineRef: string; capabilities: string[]; workerId: string | null };
  repository: string;
  baseBranch: string;
  requestedBy: string;
}): Promise<{ binId: string; proof: RoutineDeliveryProof }> {
  if (!input.routine.workerId) {
    throw new DeliveryProbeRefused('This Routine is bound to no worker; bind it first (fleet bind-worker).');
  }
  const memberships = (await listMembershipsForPrincipal('WORKER', input.routine.workerId)).filter(
    (membership) => membership.active,
  );
  const projectId = memberships[0]?.projectId;
  if (!projectId) {
    throw new DeliveryProbeRefused(
      'This Routine’s worker is a member of no project, so nothing could be handed to it. ' +
        'Onboard the repository for its project first.',
    );
  }
  const repository = normalizeRepository(input.repository);
  const nonce = randomBytes(6).toString('hex');
  const branch = `factory-verify/${input.routine.routineRef}/${nonce}`;
  const probePath = `.factory-verify/${nonce}.md`;
  const title = `[factory delivery probe] ${input.routine.name} ${nonce} — do not merge`;
  const spec = {
    repository,
    base: input.baseBranch,
    branch,
    path: probePath,
    contents: `Factory delivery probe ${nonce} for ${input.routine.name}. Safe to delete.\n`,
    commitMessage: `factory delivery probe ${nonce} (do not merge)`,
    pullRequestTitle: title,
  };
  const bin = await createBin({
    projectId,
    kind: 'DETERMINISTIC_CHECK',
    title: `Delivery probe for ${input.routine.name} on ${repository}`,
    objective:
      `Prove this session can deliver to ${repository}: clone it, create branch ${branch} from ` +
      `${input.baseBranch}, add exactly one file at ${probePath} with the contents given, commit, push the ` +
      `branch, open a pull request into ${input.baseBranch} titled "${title}", then CLOSE the pull request ` +
      'WITHOUT MERGING and delete the branch. Submit the unit result as JSON: ' +
      '{"outcome":"DELIVERED","branch":"<branch>","headSha":"<40-char commit you pushed>","pullRequest":<number>} — ' +
      'or, if any step is refused, {"outcome":"BLOCKED","step":"<one of ' +
      `${WORKER_REPORTABLE_STEPS.join(' | ')}>","detail":"<the refusal, verbatim, with no credential in it>"}. ` +
      'REPOSITORY_NOT_IN_SESSION is the right step when a push or clone is refused because the repository is ' +
      'not in this session. Do not retry a refusal; report it. Brain verifies DELIVERED against the forge.',
    rationale: 'repository delivery probe',
    manifest: {
      objective: `Prove this session can push to and open a pull request on ${repository}, then clean up.`,
      why:
        'A surface that declares repository-write is handed implementation work only after its own fired ' +
        'session has delivered to this repository once. This is that delivery, with nothing at stake.',
      lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
      units: [
        {
          key: DELIVERY_PROBE_UNIT,
          establishes: `this session can clone, branch, push and open a pull request on ${repository}`,
          input: JSON.stringify(spec),
          transform: 'FACTORY_DELIVERY_PROBE',
          dependsOn: [],
        },
      ],
      repository: {
        remote: `https://github.com/${repository}`,
        ref: input.baseBranch,
        baseSha: '',
        integrationBranch: '',
        pullRequest: null,
      },
      acceptableSources: [`https://github.com/${repository}`],
      excludedSources: ['any other repository', 'any credential, secret or environment variable value'],
      evidence: ['A closed, unmerged pull request from the named branch, at the commit you report.'],
      outputs: ['one JSON unit result: DELIVERED with branch, headSha and pullRequest, or BLOCKED with step'],
      authorizedActions: [
        'obtain access to the repository through your own execution surface — Brain holds no credential for it',
        `create branch ${branch}, add ${probePath}, commit, push it`,
        `open one pull request from ${branch} into ${input.baseBranch}, then close it without merging`,
        `delete branch ${branch}`,
        'submit the unit result and complete this bin',
      ],
      prohibitedActions: [
        'merge anything, anywhere',
        'touch any branch or file other than the ones named above',
        'deploy, release or publish anything',
        'print, log or commit any credential, token or environment variable value',
        'claim or create any other work',
      ],
      budgetUnits: 1,
      retry: { maxAttempts: 2, backoffSeconds: 30 },
      stoppingConditions: ['the unit has a DELIVERED or BLOCKED result'],
    },
    completionContract: DELIVERY_PROBE_CONTRACT,
    workloadClass: DELIVERY_PROBE_CLASS,
    requiredCapabilities: [...input.routine.capabilities],
    pinnedRoutineId: input.routine.id,
    createdByType: 'SYSTEM',
    createdById: 'delivery-probe',
    ready: false,
    maxAttempts: 2,
  });
  const proof = await createDeliveryProof({
    routineId: input.routine.id,
    repository,
    binId: bin.id,
    branch,
    probePath,
    requestedBy: input.requestedBy,
  });
  // Ready only once the proof row exists, so no fire can answer a probe nothing is waiting for.
  await markBinReady(bin.id);
  return { binId: bin.id, proof };
}

/**
 * Turn finished probe bins into settled proofs. Idempotent: a proof is settled
 * by a compare-and-swap on PENDING, so two ticks produce one verdict.
 *
 * On PROVEN the Routine row is touched, because a routing refusal deferred for
 * want of a capable surface is re-armed by a Routine write
 * (`rearmSurfaceDeferredIntents`) — so work that was waiting for this surface
 * notices it without a person re-queueing anything.
 */
export async function settleDeliveryProofs(): Promise<{ settled: number }> {
  let settled = 0;
  for (const proof of await listPendingDeliveryProofs()) {
    const bin = await getBin(proof.binId);
    if (!bin) {
      if (await settleDeliveryProof({ id: proof.id, state: 'FAILED', failureStep: 'BIN_NOT_COMPLETED', detail: 'The probe bin no longer exists.' })) settled += 1;
      continue;
    }
    if (bin.state === 'NEEDS_HUMAN' || bin.state === 'FAILED' || bin.state === 'CANCELLED') {
      if (
        await settleDeliveryProof({
          id: proof.id,
          state: 'FAILED',
          failureStep: 'BIN_NOT_COMPLETED',
          detail: bin.terminalReason ?? `The probe bin ended ${bin.state}.`,
        })
      ) settled += 1;
      continue;
    }
    if (bin.state !== 'COMPLETE') continue;
    const result = (await listBinUnitResults(bin.id)).find((unit) => unit.unitKey === DELIVERY_PROBE_UNIT);
    const parsed = result ? parseDeliveryProbeReport(result.value) : null;
    if (!parsed || !parsed.ok) {
      if (await settleDeliveryProof({ id: proof.id, state: 'FAILED', failureStep: 'REPORT_UNREADABLE', detail: parsed && !parsed.ok ? parsed.error : 'No unit result.' })) settled += 1;
      continue;
    }
    if (parsed.report.outcome === 'BLOCKED') {
      if (
        await settleDeliveryProof({
          id: proof.id,
          state: 'FAILED',
          failureStep: parsed.report.step ?? null,
          detail: parsed.report.detail ?? null,
        })
      ) settled += 1;
      continue;
    }
    const verdict = await verifyDeliveryProbe(proof, parsed.report, baseOf(bin));
    if (verdict.forgeUnreadable) continue; // ask again next tick; unknown is not a verdict
    const ok = verdict.ok;
    if (
      await settleDeliveryProof({
        id: proof.id,
        state: ok ? 'PROVEN' : 'FAILED',
        headSha: parsed.report.headSha ?? null,
        pullRequest: parsed.report.pullRequest ?? null,
        failureStep: ok ? null : verdict.failureStep ?? 'FORGE_DID_NOT_CONFIRM',
        detail: ok ? null : verdict.problems.join(' '),
      })
    ) {
      settled += 1;
      if (ok) {
        await getDb().run('UPDATE fleet_routines SET updated_at = ? WHERE id = ?', [nowIso(), proof.routineId]);
      }
    }
  }
  return { settled };
}

export { DELIVERY_FAILURE_STEPS };

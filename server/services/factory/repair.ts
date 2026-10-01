/**
 * A finding becomes work, without anybody carrying it.
 *
 * This is the module that exists to delete a workflow: a review produces
 * findings, and rather than a person reading them, writing a new prompt and
 * pasting them somewhere else, each one becomes a repair unit in the same
 * campaign with the finding attached to it. The loop then runs, integrates and
 * re-reviews it like any other unit.
 *
 * Three rules it keeps:
 *
 *   * **One finding, one repair.** `attachRepair` is a guarded update, so a tick
 *     that runs twice over the same finding queues one unit. A second repair for
 *     one defect is two workers editing the same thing.
 *   * **A repair's ownership comes from the contract, not from the reviewer.** The
 *     paths a reviewer suggests are a hint; what a repair may touch is the
 *     intersection of that hint with the approved mutation scope, and a hint that
 *     reaches outside it is discarded rather than honoured.
 *   * **A repair is a planned second attempt, not a retry.** It carries the
 *     finding's statement and evidence, and the assignment tells the worker what
 *     earlier attempts already tried — so the same failing strategy is not run
 *     again. §15, at the factory.
 */
import type {
  FactoryCampaign,
  FactoryChangeRequest,
  FactoryFinding,
  FactoryRiskClass,
  FactoryWorkUnit,
} from '../../domain/factory.ts';
import { ensureUnit, getUnit, listUnits, promoteReadyUnits } from '../../repos/factory.ts';
import {
  attachRepair,
  listOpenFindings,
  listUnqueuedFindings,
  recordFactoryEvent,
  resolveFinding,
} from '../../repos/factoryFleet.ts';
import { FACTORY_EVENT_KINDS } from './metrics.ts';
import { matchesGlob } from './integrate.ts';
import { forbiddenIn, forbiddenPathsFor } from './forbidden.ts';

/** A finding severity that has to be repaired before the campaign can finish. */
export const GATING_SEVERITIES = new Set(['BLOCKER', 'MAJOR']);

/**
 * Pull the paths a reviewer suggested back out of the evidence it wrote.
 *
 * They were appended to the evidence by the review recorder rather than given a
 * column, because they are a hint rather than a fact about the code. Reading them
 * back here keeps the hint exactly as weak as it should be: it can narrow a
 * repair's ownership and it can never widen it.
 */
export function suggestedPathsFrom(finding: FactoryFinding): string[] {
  const match = /Suggested paths:\s*(.+)$/m.exec(finding.evidence);
  if (!match?.[1]) return [];
  return match[1]
    .split(',')
    .map((path) => path.trim())
    .filter((path) => path.length > 0 && !path.startsWith('/') && !path.includes('..'));
}

/**
 * Repository-relative files a finding's own statement names, `path:line` included.
 *
 * Read only when the reviewer suggested no paths. The statement is the defect
 * in the reviewer's words, so a file it names is where the defect is; the
 * evidence is not read, because evidence routinely cites files for context
 * that nobody has to change.
 */
export function pathsNamedIn(text: string): string[] {
  const out = new Set<string>();
  const pattern = /(?:^|[\s`'"(\[])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)(?::\d+)?/g;
  for (const match of text.matchAll(pattern)) {
    const path = match[1]!;
    if (path.startsWith('/') || path.split('/').includes('..') || path.includes('://')) continue;
    out.add(path);
  }
  return [...out];
}

/**
 * The exact files an accepted finding requires changing: the reviewer's
 * suggested paths, or — when it suggested none — the files its statement
 * names. Empty when neither names anything, which is a finding about the
 * work in general rather than about a place.
 */
export function requiredPathsFor(finding: FactoryFinding): string[] {
  const suggested = suggestedPathsFrom(finding);
  return suggested.length > 0 ? suggested : pathsNamedIn(finding.statement);
}

export type RepairOwnership =
  | {
      ok: true;
      ownedPaths: string[];
      derivedFrom: 'REQUIRED_FILES' | 'UNIT_OWNERSHIP' | 'CAMPAIGN_SCOPE';
      /** Required files no unit of this campaign owned — the widening, named. */
      beyondUnits: string[];
    }
  | {
      ok: false;
      required: string[];
      /** Required files the approved mutation scope does not cover. */
      outsideScope: string[];
      /** Required files no contract may grant, because the repository forbids them. */
      forbidden: string[];
    };

/**
 * What a repair unit is allowed to touch.
 *
 * Exactly the files the finding requires, when the approved scope covers every
 * one of them — including files no unit of the campaign owned, because a
 * repair that cannot reach the file the defect is in is a bin that can only
 * BLOCK, attempt after attempt. Nothing broader: never the campaign's whole
 * scope, never the units' union on top.
 *
 * When any required file is outside the approved scope the answer is a refusal
 * naming it. Dropping it and repairing with what is left was the old behaviour,
 * and it produced exactly that impossible bin. Widening a scope is a person's
 * amendment; the factory may not grant itself authority (§27).
 *
 * A finding that names no file falls back to the units' own paths, which
 * serialises the repair against those units rather than letting it roam.
 */
export function ownershipForRepair(
  finding: FactoryFinding,
  changeRequest: FactoryChangeRequest,
  units: FactoryWorkUnit[],
  forbiddenPaths: string[] = [],
): RepairOwnership {
  const required = requiredPathsFor(finding);
  if (required.length > 0) {
    const forbidden = forbiddenIn(required, forbiddenPaths);
    const outsideScope = required.filter(
      (path) =>
        !forbidden.includes(path) &&
        !changeRequest.mutationScope.some((glob) => matchesGlob(path, glob)),
    );
    if (outsideScope.length > 0 || forbidden.length > 0) {
      return { ok: false, required, outsideScope, forbidden };
    }
    const owned = new Set(units.flatMap((unit) => unit.ownedPaths));
    const beyondUnits = required.filter(
      (path) => !owned.has(path) && !units.some((unit) => unit.ownedPaths.some((g) => matchesGlob(path, g))),
    );
    return { ok: true, ownedPaths: required, derivedFrom: 'REQUIRED_FILES', beyondUnits };
  }

  const unionOfUnits = [...new Set(units.flatMap((unit) => unit.ownedPaths))];
  if (unionOfUnits.length > 0) {
    return { ok: true, ownedPaths: unionOfUnits, derivedFrom: 'UNIT_OWNERSHIP', beyondUnits: [] };
  }
  return { ok: true, ownedPaths: changeRequest.mutationScope, derivedFrom: 'CAMPAIGN_SCOPE', beyondUnits: [] };
}

/** The blocker sentence for findings whose repair needs a person's amendment first. */
export function amendmentNeededDetail(
  needs: RepairResult['needsAmendment'],
  changeRequestId: string,
): string {
  const lines = needs.map((need) => {
    const parts = [];
    if (need.outsideScope.length > 0) parts.push(`outside the approved scope: ${need.outsideScope.join(', ')}`);
    if (need.forbidden.length > 0) parts.push(`forbidden in this repository: ${need.forbidden.join(', ')}`);
    return `${need.findingKey} requires ${parts.join('; ')}`;
  });
  const missing = [...new Set(needs.flatMap((need) => need.outsideScope))];
  return (
    `${lines.join(' — ')}. A repair is not created for a file it may not change. ` +
    (missing.length > 0
      ? `Amend the scope to add exactly ${missing.join(', ')} ` +
        `(factory amend --change-request ${changeRequestId} --field mutation_scope); ` +
        'the next tick queues the repair by itself.'
      : 'A forbidden file cannot be granted by an amendment; retire the finding or the campaign.')
  );
}

function riskForSeverity(severity: FactoryFinding['severity']): FactoryRiskClass {
  if (severity === 'BLOCKER') return 'HIGH';
  if (severity === 'MAJOR') return 'MEDIUM';
  return 'LOW';
}

export interface RepairResult {
  queued: { findingId: string; unitId: string; unitKey: string }[];
  skipped: { findingId: string; reason: string }[];
  /** Findings left unqueued because a file they require is outside the approved scope. */
  needsAmendment: { findingId: string; findingKey: string; outsideScope: string[]; forbidden: string[] }[];
}

/**
 * Turn every open finding into a repair unit, exactly once.
 *
 * MINOR findings are queued too but at a lower priority and without gating the
 * campaign, because a nit that blocks a release is a nit that gets waived by
 * somebody in a hurry — and a waiver nobody recorded is how a standard erodes.
 */
export async function queueRepairs(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
): Promise<RepairResult> {
  // Only findings that have no repair yet. A finding whose repair is queued is
  // still unresolved, so it belongs in the open set — but it does not need a
  // second repair unit, and `attachRepair` would refuse one anyway.
  const findings = await listUnqueuedFindings(campaign.id);
  const units = await listUnits(campaign.id);
  const result: RepairResult = { queued: [], skipped: [], needsAmendment: [] };
  const forbiddenPaths = changeRequest.repository ? forbiddenPathsFor(changeRequest.repository) : [];

  for (const finding of findings) {
    const ownership = ownershipForRepair(finding, changeRequest, units, forbiddenPaths);
    if (!ownership.ok) {
      result.needsAmendment.push({
        findingId: finding.id,
        findingKey: finding.findingKey,
        outsideScope: ownership.outsideScope,
        forbidden: ownership.forbidden,
      });
      continue;
    }
    const unitKey = `repair-${finding.findingKey}`.slice(0, 60);

    const { unit } = await ensureUnit({
      campaignId: campaign.id,
      unitKey,
      kind: 'REPAIR',
      role: 'IMPLEMENTER',
      title: `Repair: ${finding.statement.slice(0, 80)}`,
      objective:
        `A reviewer found this and your job is to make it untrue:\n\n${finding.statement}\n\n` +
        `Their evidence: ${finding.evidence}\n\n` +
        'Fix the cause rather than the symptom. Weakening a test, deleting an assertion or ' +
        'skipping a check is a worse outcome than the finding.',
      acceptance: [
        `The finding is no longer true: ${finding.statement}`,
        'No test was weakened, skipped or deleted to achieve it.',
        ...(finding.acceptanceConditionId
          ? [`Acceptance condition ${finding.acceptanceConditionId} is satisfied.`]
          : []),
      ],
      ownedPaths: ownership.ownedPaths,
      requiredContext: [],
      verification: changeRequest.verificationCommands.slice(0, 2),
      expectedArtifact: 'a commit that makes the finding untrue, and a test that would catch it',
      risk: riskForSeverity(finding.severity),
      criticalPath: finding.severity === 'BLOCKER',
      priority: finding.severity === 'BLOCKER' ? 9 : finding.severity === 'MAJOR' ? 7 : 3,
      modelClass: finding.severity === 'BLOCKER' ? 'STRONGEST' : 'FAST',
      maxAttempts: 3,
      repairsFindingId: finding.id,
      // A repair runs against the integration branch as it stands, so it has no
      // dependency to wait for — which is what lets repairs run in parallel with
      // each other when their ownership does not overlap.
      state: 'READY',
    });

    const attached = await attachRepair(finding.id, unit.id);
    if (!attached) {
      result.skipped.push({
        findingId: finding.id,
        reason: 'A repair is already attached to this finding.',
      });
      continue;
    }

    result.queued.push({ findingId: finding.id, unitId: unit.id, unitKey });
    await recordFactoryEvent({
      campaignId: campaign.id,
      unitId: unit.id,
      kind: FACTORY_EVENT_KINDS.repairQueued,
      evidenceClass: 'MEASURED',
      detail: {
        findingKey: finding.findingKey,
        severity: finding.severity,
        unitKey,
        ownedPaths: ownership.ownedPaths.slice(0, 20),
        ownershipDerivedFrom: ownership.derivedFrom,
        widenedBeyondUnits: ownership.beyondUnits,
        gating: GATING_SEVERITIES.has(finding.severity),
      },
    });
  }

  await promoteReadyUnits(campaign.id);
  return result;
}

/**
 * A failing verification command is a defect, and defects become work.
 *
 * The final check runs on the whole merged tree, so it catches what no single
 * unit could: two units that each passed and broke each other. When it fails,
 * the campaign must not simply be re-reviewed — the previous review judged a
 * tree that no longer passes, and re-reading its verdict would cycle forever
 * without producing anything. Nor is a model asked for an opinion about it: an
 * exit code is a fact the factory observed, so the finding is authored from the
 * observation.
 *
 * Keyed by the command, so the same failing command produces one repair however
 * many times the verification is run.
 */
export async function queueVerificationRepair(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  failure: { command: string; exitCode: number; tail: string },
): Promise<{ unitId: string; unitKey: string; created: boolean }> {
  const slug = failure.command.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const unitKey = `repair-verification-${slug}`.slice(0, 60);
  const units = await listUnits(campaign.id);
  const ownedPaths = [...new Set(units.flatMap((unit) => unit.ownedPaths))];

  const { unit, created } = await ensureUnit({
    campaignId: campaign.id,
    unitKey,
    kind: 'REPAIR',
    role: 'IMPLEMENTER',
    title: `Repair: \`${failure.command}\` fails on the merged tree`,
    objective:
      `The campaign's own verification command \`${failure.command}\` exits ${failure.exitCode} ` +
      'on the integration branch. Every unit passed its own checks, so this is something two ' +
      'of them did to each other. Make the command pass.\n\nWhat it printed:\n\n' +
      failure.tail.slice(-2000) +
      '\n\nFix the cause. Do not weaken, skip or delete a test, and do not remove the command.',
    acceptance: [
      `\`${failure.command}\` exits 0 on the merged tree`,
      'no test was weakened, skipped or deleted to achieve it',
    ],
    ownedPaths: ownedPaths.length > 0 ? ownedPaths : changeRequest.mutationScope,
    requiredContext: [],
    verification: [failure.command],
    expectedArtifact: 'a commit that makes the command pass',
    risk: 'HIGH',
    criticalPath: true,
    priority: 9,
    modelClass: 'STRONGEST',
    maxAttempts: 3,
    state: 'READY',
  });

  if (created) {
    await recordFactoryEvent({
      campaignId: campaign.id,
      unitId: unit.id,
      kind: FACTORY_EVENT_KINDS.repairQueued,
      evidenceClass: 'MEASURED',
      detail: {
        unitKey,
        source: 'FINAL_VERIFICATION',
        command: failure.command,
        exitCode: failure.exitCode,
      },
    });
  }
  await promoteReadyUnits(campaign.id);
  return { unitId: unit.id, unitKey, created };
}

/**
 * Close out the findings whose repair landed.
 *
 * A finding is REPAIRED when its unit is INTEGRATED — which means the repair's
 * diff was inside its ownership and the verification passed on the merged tree.
 * It is not repaired because a worker said so. A repair unit that exhausted its
 * attempts leaves the finding open with that recorded, because a defect nobody
 * fixed is not a defect that went away.
 */
export async function reconcileRepairs(campaignId: string): Promise<{
  repaired: number;
  stillOpen: number;
  exhausted: { findingId: string; unitKey: string }[];
}> {
  const findings = await listOpenFindings(campaignId);
  const queued = findings.filter((finding) => finding.repairUnitId !== null);
  let repaired = 0;
  const exhausted: { findingId: string; unitKey: string }[] = [];

  for (const finding of queued) {
    if (!finding.repairUnitId) continue;
    const unit = await getUnit(finding.repairUnitId);
    if (!unit) continue;
    if (unit.state === 'INTEGRATED') {
      const moved = await resolveFinding(
        finding.id,
        'REPAIRED',
        `Repaired by ${unit.unitKey} at ${unit.headSha ?? 'unknown'} and verified on the merged tree.`,
      );
      if (moved) {
        repaired += 1;
        await recordFactoryEvent({
          campaignId,
          unitId: unit.id,
          kind: FACTORY_EVENT_KINDS.findingResolved,
          evidenceClass: 'MEASURED',
          detail: { findingKey: finding.findingKey, unitKey: unit.unitKey, state: 'REPAIRED' },
        });
      }
    } else if (unit.state === 'FAILED') {
      exhausted.push({ findingId: finding.id, unitKey: unit.unitKey });
    }
  }

  const remaining = await listOpenFindings(campaignId);
  return { repaired, stillOpen: remaining.length, exhausted };
}

/**
 * Findings that still stand in the way of finishing.
 *
 * Read from rows rather than from the last review's verdict, because a review is
 * a statement about one commit and a campaign moves. A blocker whose repair
 * failed is still a blocker.
 */
export async function gatingFindings(campaignId: string): Promise<FactoryFinding[]> {
  const findings = await listOpenFindings(campaignId);
  return findings.filter((finding) => GATING_SEVERITIES.has(finding.severity));
}

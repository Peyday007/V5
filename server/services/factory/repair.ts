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
  recordFactoryEvent,
  resolveFinding,
} from '../../repos/factoryFleet.ts';
import { FACTORY_EVENT_KINDS } from './metrics.ts';
import { matchesGlob } from './integrate.ts';

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
 * What a repair unit is allowed to touch.
 *
 * The hint, held against the approved scope. When the hint survives nothing, the
 * repair owns the units' own paths instead — which serialises it against those
 * units rather than letting it roam, and is the conservative answer.
 */
export function ownershipForRepair(
  finding: FactoryFinding,
  changeRequest: FactoryChangeRequest,
  units: FactoryWorkUnit[],
): { ownedPaths: string[]; derivedFrom: 'SUGGESTION' | 'UNIT_OWNERSHIP' | 'CAMPAIGN_SCOPE' } {
  const suggested = suggestedPathsFrom(finding);
  const inScope = suggested.filter((candidate) =>
    changeRequest.mutationScope.some((glob) => matchesGlob(candidate, glob)),
  );
  if (inScope.length > 0) return { ownedPaths: inScope, derivedFrom: 'SUGGESTION' };

  // Nothing usable was suggested. Own what the campaign's own units own, which is
  // narrower than the campaign scope and still certainly enough to fix anything
  // the campaign produced.
  const unionOfUnits = [...new Set(units.flatMap((unit) => unit.ownedPaths))];
  if (unionOfUnits.length > 0) return { ownedPaths: unionOfUnits, derivedFrom: 'UNIT_OWNERSHIP' };
  return { ownedPaths: changeRequest.mutationScope, derivedFrom: 'CAMPAIGN_SCOPE' };
}

function riskForSeverity(severity: FactoryFinding['severity']): FactoryRiskClass {
  if (severity === 'BLOCKER') return 'HIGH';
  if (severity === 'MAJOR') return 'MEDIUM';
  return 'LOW';
}

export interface RepairResult {
  queued: { findingId: string; unitId: string; unitKey: string }[];
  skipped: { findingId: string; reason: string }[];
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
  const findings = await listOpenFindings(campaign.id);
  const units = await listUnits(campaign.id);
  const result: RepairResult = { queued: [], skipped: [] };

  for (const finding of findings) {
    const ownership = ownershipForRepair(finding, changeRequest, units);
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
        gating: GATING_SEVERITIES.has(finding.severity),
      },
    });
  }

  await promoteReadyUnits(campaign.id);
  return result;
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

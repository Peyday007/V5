/**
 * The answering transition for a unit that ran out of attempts.
 *
 * `UNIT_EXHAUSTED_ATTEMPTS` blocks a campaign on both planes, and until this
 * existed its remedy — "raise its ceiling or replan the work" — named an action
 * nothing could take: no function raised a unit's ceiling, no transition moved a
 * FAILED unit back out, and an amendment touches no unit. So the only way past a
 * unit that had honestly spent its attempts on a condition since corrected was
 * `factory retire`, which cancels the whole campaign. §24's sentence at the
 * factory: an escalation with no answering transition is stuck, not waiting.
 *
 * It re-authorizes **work**, where `FACTORY_STAGE_REAUTHORIZED` re-authorizes a
 * stage, so it is its own event. It is a person's decision taken on a terminal
 * (§26), the reason is a code from a closed set because a caller that writes its
 * own audit trail writes whatever it wanted, and it moves nothing else: the next
 * tick re-derives the stage from rows, so the unit is handed out again only
 * because it is now READY with an attempt left.
 */
import { getCampaign, getUnitByKey, regrantUnitAttempts } from '../../repos/factory.ts';
import { recordFactoryEvent } from '../../repos/factoryFleet.ts';
import { FACTORY_EVENT_KINDS } from './metrics.ts';

export const UNIT_REGRANT_REASONS: Readonly<Record<string, string>> = {
  'work-corrected':
    'What failed the unit has been corrected — the contract amended or the plan clarified — ' +
    'so another attempt is a different attempt rather than the same one repeated.',
  'platform-defect':
    'The attempts were spent on a Brain-side defect rather than on the work failing.',
  'surface-blocked':
    'The attempts were spent on an execution-surface failure that has since been corrected ' +
    'where the workers run.',
};

/** The most a single regrant may raise a ceiling to. A bound, not a budget. */
export const MAX_UNIT_ATTEMPTS = 12;

export type UnitRegrantOutcome =
  | { ok: true; from: number; to: number; state: string }
  | { ok: false; reason: string };

export async function regrantUnit(input: {
  campaignId: string;
  unitKey: string;
  maxAttempts: number;
  reasonCode: string;
  operator: string;
}): Promise<UnitRegrantOutcome> {
  const reason = UNIT_REGRANT_REASONS[input.reasonCode];
  if (!reason) {
    return {
      ok: false,
      reason:
        `unknown reason code "${input.reasonCode}". One of: ` +
        Object.keys(UNIT_REGRANT_REASONS).join(', '),
    };
  }
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > MAX_UNIT_ATTEMPTS) {
    return { ok: false, reason: `the new ceiling must be a whole number between 1 and ${MAX_UNIT_ATTEMPTS}` };
  }
  const campaign = await getCampaign(input.campaignId);
  if (!campaign) return { ok: false, reason: 'no such campaign' };
  if (campaign.state === 'COMPLETE' || campaign.state === 'CANCELLED') {
    return { ok: false, reason: `the campaign is ${campaign.state}; a finished campaign is not reopened here` };
  }
  const unit = await getUnitByKey(campaign.id, input.unitKey);
  if (!unit) return { ok: false, reason: `the campaign has no unit "${input.unitKey}"` };
  if (input.maxAttempts <= unit.maxAttempts) {
    return {
      ok: false,
      reason: `the ceiling is already ${unit.maxAttempts}; a regrant only ever raises it`,
    };
  }
  const regranted = await regrantUnitAttempts({ unitId: unit.id, maxAttempts: input.maxAttempts });
  if (!regranted.raised || !regranted.unit) {
    return {
      ok: false,
      reason:
        `the unit is ${regranted.unit?.state ?? unit.state}, or changed while this was asked; ` +
        'only a unit that is not leased and not finished is regranted',
    };
  }
  await recordFactoryEvent({
    campaignId: campaign.id,
    unitId: unit.id,
    kind: FACTORY_EVENT_KINDS.unitAttemptsRegranted,
    evidenceClass: 'MEASURED',
    detail: {
      operator: input.operator,
      code: input.reasonCode,
      reason,
      unitKey: unit.unitKey,
      from: unit.maxAttempts,
      to: regranted.unit.maxAttempts,
      attempt: regranted.unit.attempt,
      stateBefore: unit.state,
      stateAfter: regranted.unit.state,
    },
  });
  return {
    ok: true,
    from: unit.maxAttempts,
    to: regranted.unit.maxAttempts,
    state: regranted.unit.state,
  };
}

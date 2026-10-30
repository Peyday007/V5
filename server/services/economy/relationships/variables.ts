/**
 * Per-activity economic variables, read in the shape `goalScenario.ts` consumes.
 *
 * There is no second calculator here. This module only translates a stored
 * reading (VERIFIED / ESTIMATE / UNKNOWN) into the `ModelInput` the goal model
 * already takes, keeping the claim or the stated basis as its source so a
 * reader can follow any number back. A reading it cannot place in the goal
 * model's units is reported as unknown rather than guessed at.
 */
import { currentVariables } from '../../../repos/economy.ts';
import type { ActivityVariable, EvidenceStatus, OperatorKind } from '../../../domain/economy.ts';
import type { SourceRef, VariableProvenance } from '../../../domain/scenario.ts';
import type { ModelInput } from '../../cash/goalScenario.ts';

/** The goal model's inputs a stored variable may feed, in the model's units. */
export const GOAL_INPUTS = ['price', 'capital', 'hours', 'daysToCash', 'close', 'directCost'] as const;
export type GoalInputName = (typeof GOAL_INPUTS)[number];

type Dimension = 'money' | 'hours' | 'days' | 'rate';

const INPUT_DIMENSION: Record<GoalInputName, Dimension> = {
  price: 'money', capital: 'money', hours: 'hours', daysToCash: 'days', close: 'rate', directCost: 'money',
};

/** Names a variable is commonly stored under. The set of variables is open; this only says which feed the goal model. */
const ALIASES: Record<GoalInputName, readonly string[]> = {
  price: ['revenue per transaction', 'price', 'price per deal', 'revenue per deal'],
  capital: ['upfront capital', 'money tied up', 'capital'],
  hours: ['completion time', 'hours per deal', 'hours'],
  daysToCash: ['payment timing', 'days to cash', 'time to cash'],
  close: ['conversion', 'close rate', 'conversion rate'],
  directCost: ['direct cost', 'cost per transaction', 'cost per deal'],
};

export function normalName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function goalInputFor(name: string): GoalInputName | null {
  const n = normalName(name);
  for (const input of GOAL_INPUTS) if (ALIASES[input].includes(n)) return input;
  return null;
}

/** A VERIFIED reading is evidence; an ESTIMATE is a stated assumption; UNKNOWN stays unknown. */
export function provenanceOf(status: EvidenceStatus): VariableProvenance {
  return status === 'VERIFIED' ? 'EVIDENCE' : status === 'ESTIMATE' ? 'ASSUMPTION' : 'UNKNOWN';
}

function sourceOf(v: ActivityVariable): SourceRef | null {
  if (v.status === 'VERIFIED' && v.sourceClaimId) return { kind: 'CLAIM', ref: v.sourceClaimId };
  if (v.status === 'ESTIMATE') return { kind: 'OTHER', ref: v.id, note: v.basis ?? undefined };
  return null;
}

/** Convert a stored value into the goal model's unit, or say why it cannot be. */
export function inGoalUnits(input: GoalInputName, v: Pick<ActivityVariable, 'value' | 'unit'>): { value: number } | { problem: string } {
  if (v.value === null) return { problem: 'no value' };
  const unit = (v.unit ?? '').trim().toLowerCase();
  switch (INPUT_DIMENSION[input]) {
    case 'money':
      if (unit === 'cents' || unit === 'cent') return { value: v.value / 100 };
      if (['usd', 'dollars', 'dollar', 'major', 'major units'].includes(unit)) return { value: v.value };
      return { problem: `a money figure needs a unit (cents or dollars); got ${unit || 'none'}` };
    case 'hours':
      if (unit === 'hours' || unit === 'hour') return { value: v.value };
      if (unit === 'minutes' || unit === 'minute') return { value: v.value / 60 };
      return { problem: `hours need a unit of hours or minutes; got ${unit || 'none'}` };
    case 'days':
      if (unit === 'days' || unit === 'day') return { value: v.value };
      if (unit === 'weeks' || unit === 'week') return { value: v.value * 7 };
      return { problem: `days need a unit of days or weeks; got ${unit || 'none'}` };
    case 'rate':
      if (unit === 'fraction' || unit === 'ratio') return { value: v.value };
      if (unit === 'percent' || unit === '%') return { value: v.value / 100 };
      return { problem: `a rate needs a unit of fraction or percent; got ${unit || 'none'}` };
  }
}

/** One stored reading as the goal model's input. Never invents a range: low and high are the value itself, or null. */
export function toModelInput(input: GoalInputName, v: ActivityVariable): ModelInput {
  if (v.status === 'UNKNOWN') {
    return { value: null, low: null, high: null, provenance: 'UNKNOWN', source: null, note: `${v.name}: not established` };
  }
  const converted = inGoalUnits(input, v);
  if ('problem' in converted) {
    return { value: null, low: null, high: null, provenance: 'UNKNOWN', source: sourceOf(v), note: `${v.name}: ${converted.problem}` };
  }
  return {
    value: converted.value, low: converted.value, high: converted.value,
    provenance: provenanceOf(v.status), source: sourceOf(v),
    note: `${v.name} (${v.status}, ${v.operatorKind === 'ESTABLISHED_OPERATOR' ? 'an established operator' : 'reproducible by a new operator'})${v.basis ? `: ${v.basis}` : ''}`,
  };
}

export type ActivityModelInputs = Partial<Record<GoalInputName, ModelInput>>;

/** Pure: the goal-model inputs among these readings for one operator kind. A reading is used only if the operator kind matches. */
export function modelInputsFrom(variables: readonly ActivityVariable[], operatorKind: OperatorKind): ActivityModelInputs {
  const out: ActivityModelInputs = {};
  for (const v of variables) {
    if (v.operatorKind !== operatorKind) continue;
    const input = goalInputFor(v.name);
    if (input) out[input] = toModelInput(input, v);
  }
  return out;
}

/**
 * What this activity would feed the goal model for the given kind of operator.
 * A new operator is never handed an established operator's figures: the two
 * are different facts, and the established one's price or conversion is
 * exactly what a newcomer cannot assume.
 */
export async function activityModelInputs(projectId: string, activityRef: string, operatorKind: OperatorKind): Promise<ActivityModelInputs> {
  return modelInputsFrom(await currentVariables(projectId, activityRef), operatorKind);
}

/**
 * What Brain can establish about an objective from current records, before
 * it asks anybody anything.
 *
 * The project, what it is for, the constraints it runs under, the resources it
 * holds and the authority somebody has granted — every one read from a row,
 * every time. The only thing this cannot read is what somebody is trying to
 * achieve, which is why that is the one field an objective stores.
 *
 * `questions` is the short list of things Brain genuinely cannot establish
 * **and** that would change what it recommends. It is deliberately not a form:
 * a missing figure that Brain can research is a research step, not a question,
 * and a question whose answer would change nothing is not asked (§41's burden
 * of proof, pointed at the person rather than at the work).
 */
import { getProject } from '../../repos/projects.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import { checkAuthority } from '../../repos/russellAuthority.ts';
import { liveAuthority } from '../../repos/cashAuthority.ts';
import { cashPosition } from '../cash/money.ts';
import { readCapability, type CapabilityState } from '../cash/capabilities.ts';
import { describeAuthority } from '../cash/authority.ts';
import type { Objective } from '../../repos/objectives.ts';

export interface ObjectiveContext {
  projectId: string;
  projectName: string;
  /** What the project is for, as declared on its row. Never inferred from a name. */
  purpose: string;
  /** Whether this objective is judged as a revenue objective. */
  revenue: boolean;
  intendedOutcome: string;
  constraints: string[];
  resources: { label: string; value: string; kind: 'MEASURED' | 'DECISION' | 'UNKNOWN' }[];
  authority: {
    research: { granted: boolean; sentence: string };
    commercial: { granted: boolean; lines: string[]; allowedActions: string[] };
  };
  capabilities: { id: string; state: CapabilityState }[];
  /** Facts or decisions Brain cannot establish that would change the recommendation. */
  questions: string[];
  deployableCents: number | null;
  currency: string | null;
}

function money(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export async function readContext(objective: Objective): Promise<ObjectiveContext> {
  const project = await getProject(objective.projectId);
  const mode = await getCashMode(objective.projectId);
  const research = await checkAuthority({ projectId: objective.projectId, workClass: 'RESEARCH' });
  const commercial = mode ? await liveAuthority(objective.projectId) : null;
  const purpose = (project as unknown as { purpose?: string } | null)?.purpose ?? 'UNDECLARED';

  const capabilities = await Promise.all(
    ['RESEARCH_A_QUESTION', 'SEND_A_MESSAGE'].map(async (id) => ({
      id,
      state: (await readCapability(id)).state,
    })),
  );

  const resources: ObjectiveContext['resources'] = [];
  let deployableCents: number | null = null;
  if (mode) {
    const position = await cashPosition({ projectId: objective.projectId, currency: mode.currency });
    deployableCents = position.deployableCents;
    resources.push({
      label: 'Cash that may be committed to something new',
      value: money(position.deployableCents, mode.currency),
      kind: 'MEASURED',
    });
    if (position.otherCurrencies.length > 0) {
      resources.push({
        label: 'Money in other currencies, not counted above',
        value: position.otherCurrencies.join(', '),
        kind: 'MEASURED',
      });
    }
  }
  const researchCapacity = capabilities.find((one) => one.id === 'RESEARCH_A_QUESTION')!.state;
  resources.push({
    label: 'Research capacity (a healthy execution surface)',
    value: researchCapacity === 'PRESENT' ? 'present' : researchCapacity.toLowerCase(),
    kind: researchCapacity === 'UNKNOWN' ? 'UNKNOWN' : 'MEASURED',
  });
  const messaging = capabilities.find((one) => one.id === 'SEND_A_MESSAGE')!.state;
  resources.push({
    label: 'Sending a message to a buyer',
    value:
      messaging === 'PRESENT'
        ? 'present'
        : 'not something this Brain can do — a person sends it, or an integration is connected',
    kind: messaging === 'UNKNOWN' ? 'UNKNOWN' : 'MEASURED',
  });

  const constraints: string[] = [];
  if (mode) {
    constraints.push(
      `Cash Mode is ${mode.state.toLowerCase().replace('_', ' ')}; its money is kept in ${mode.currency}.`,
    );
  }
  if (research.ok && research.goal) {
    const prohibitions = research.goal.prohibitions ?? [];
    if (prohibitions.length > 0) {
      constraints.push(`The research grant prohibits: ${prohibitions.join(', ')}.`);
    }
    if (research.goal.maxExternalSpend === 0) {
      constraints.push('The research grant allows no external spending.');
    }
  }
  if (!commercial && mode) {
    constraints.push(
      'No commercial grant exists, so nothing may contact a buyer, buy, spend, commit or publish.',
    );
  }

  const questions: string[] = [];
  if (!project) questions.push('Which project this objective belongs to.');

  return {
    projectId: objective.projectId,
    projectName: project?.name ?? objective.projectId,
    purpose,
    revenue: mode !== null,
    intendedOutcome: objective.statement,
    constraints,
    resources,
    authority: {
      research: {
        granted: research.ok,
        sentence: research.ok
          ? 'Research from published sources is authorized on this project.'
          : `Research is not authorized here: ${research.reason}`,
      },
      commercial: {
        granted: commercial !== null,
        lines: commercial ? describeAuthority(commercial) : [],
        allowedActions: commercial?.allowedActions ?? [],
      },
    },
    capabilities,
    questions,
    deployableCents,
    currency: mode?.currency ?? null,
  };
}

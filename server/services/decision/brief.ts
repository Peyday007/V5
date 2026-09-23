/**
 * The decision brief: what Russell says when asked "what can we actually do?"
 *
 * A projection. It reads the objective, the context, every candidate path and
 * the step Brain last took, decides with the pure `decide`, and composes the
 * answer — and it writes nothing. Taking the step is `act.ts`; this is what a
 * person reads, and it reads the same rows whether they ask in a conversation,
 * open the objective on Home, or an operator prints it.
 *
 * Every sentence is the server's. A client that paraphrased a recommendation
 * would eventually paraphrase it wrongly, and then a person would be reading
 * one thing while the machinery acted on another.
 */
import { getObjective, listDecisions, listSteps, type Objective, type ObjectiveDecision, type ObjectiveStep } from '../../repos/objectives.ts';
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { getCandidate } from '../../repos/russellCandidates.ts';
import { getMission, latestMissionForCandidate } from '../../repos/russellMissions.ts';
import { getSoftwareRequest } from '../../repos/russellSoftware.ts';
import {
  CRITERION_LABEL,
  decide,
  type CriterionAssessment,
  type DecisionOutcome,
  type JudgedPath,
  type PlannedStep,
} from '../../domain/decision.ts';
import { readContext, type ObjectiveContext } from './context.ts';
import { candidatePaths } from './paths.ts';

/** Where the work a step became has got to, read from the row it points at. */
export interface StepReading {
  step: ObjectiveStep;
  /** RUNNING, WAITING_ON_PERSON, FINISHED, STOPPED or NOT_STARTED — derived, never stored. */
  status: 'NOT_STARTED' | 'RUNNING' | 'WAITING_ON_PERSON' | 'FINISHED' | 'STOPPED';
  detail: string;
}

export async function readStep(step: ObjectiveStep): Promise<StepReading> {
  if (step.authority === 'NEEDS_PERSON' && !step.workRef) {
    return {
      step,
      status: 'WAITING_ON_PERSON',
      detail: step.boundary ?? 'Prepared, and waiting for a person to decide.',
    };
  }
  switch (step.workKind) {
    case 'OPPORTUNITY': {
      const opportunity = step.workRef ? await getOpportunity(step.workRef) : null;
      if (!opportunity) return { step, status: 'STOPPED', detail: 'The opening it points at is gone.' };
      if (step.kind === 'QUALIFY_OPENING') {
        const state = opportunity.validationState;
        if (state === null) {
          return {
            step,
            status: 'NOT_STARTED',
            detail: 'Steered to the front of the deep-dive queue; it starts the moment one of the bounded slots is free.',
          };
        }
        if (state === 'PENDING' || state === 'RUNNING') {
          return { step, status: 'RUNNING', detail: `Its deep dive is ${state.toLowerCase()} (candidate ${opportunity.candidateId ?? '—'}).` };
        }
        if (state === 'NEEDS_PERSON') {
          return { step, status: 'WAITING_ON_PERSON', detail: 'Its deep dive stopped at a decision in Needs You.' };
        }
        return {
          step,
          status: state === 'COMPLETE' ? 'FINISHED' : 'STOPPED',
          detail: `Its deep dive settled ${state.toLowerCase()}.`,
        };
      }
      return { step, status: 'RUNNING', detail: `The opening is ${opportunity.state.toLowerCase()}.` };
    }
    case 'CANDIDATE': {
      const candidate = step.workRef ? await getCandidate(step.workRef) : null;
      if (!candidate) return { step, status: 'STOPPED', detail: 'The idea it points at is gone.' };
      const mission = await latestMissionForCandidate(candidate.id);
      if (mission) return missionReading(step, mission.state, mission.id, mission.terminalReason);
      if (candidate.state === 'PARKED' || candidate.state === 'REJECTED') {
        return { step, status: 'STOPPED', detail: `The idea was ${candidate.state.toLowerCase()}: ${candidate.reason ?? ''}`.trim() };
      }
      return { step, status: 'NOT_STARTED', detail: `Captured as idea ${candidate.id}; Russell judges and launches it inside the standing grant.` };
    }
    case 'MISSION': {
      const mission = step.workRef ? await getMission(step.workRef) : null;
      if (!mission) return { step, status: 'STOPPED', detail: 'The mission it points at is gone.' };
      return missionReading(step, mission.state, mission.id, mission.terminalReason);
    }
    case 'SOFTWARE_REQUEST': {
      const request = step.workRef ? await getSoftwareRequest(step.workRef) : null;
      if (!request) return { step, status: 'STOPPED', detail: 'The request it points at is gone.' };
      if (request.state === 'PROPOSED') return { step, status: 'WAITING_ON_PERSON', detail: 'Waiting for a person to authorize it in Needs You.' };
      if (request.state === 'DECLINED') return { step, status: 'STOPPED', detail: `Declined: ${request.declineReason ?? ''}`.trim() };
      return { step, status: 'RUNNING', detail: `Authorized; campaign ${request.campaignId ?? 'starting'}.` };
    }
    default:
      return { step, status: step.authority === 'NEEDS_PERSON' ? 'WAITING_ON_PERSON' : 'NOT_STARTED', detail: step.boundary ?? step.description };
  }
}

function missionReading(
  step: ObjectiveStep,
  state: string,
  missionId: string,
  terminalReason: string | null,
): StepReading {
  if (state === 'DONE') return { step, status: 'FINISHED', detail: `Mission ${missionId} finished and wrote its result back.` };
  if (state === 'FAILED' || state === 'CANCELLED') {
    return { step, status: 'STOPPED', detail: `Mission ${missionId} ${state.toLowerCase()}${terminalReason ? `: ${terminalReason}` : '.'}` };
  }
  if (state === 'NEEDS_HUMAN') return { step, status: 'WAITING_ON_PERSON', detail: `Mission ${missionId} is waiting in Needs You.` };
  return { step, status: 'RUNNING', detail: `Mission ${missionId} is ${state.toLowerCase()}.` };
}

export interface BriefPath {
  ref: string;
  source: string;
  title: string;
  how: string | null;
  standing: JudgedPath['standing'];
  because: string;
  tests: CriterionAssessment[];
  economics: JudgedPath['economics'];
}

export interface DecisionBrief {
  objective: Pick<Objective, 'id' | 'statement' | 'sourceKind' | 'sourceRef' | 'projectId' | 'conversationId' | 'createdAt' | 'closedAt'>;
  context: ObjectiveContext;
  verdict: DecisionOutcome['verdict'];
  /** The one-line answer. */
  headline: string;
  reasons: string[];
  leading: BriefPath | null;
  alternatives: (BriefPath & { whyLower: string })[];
  rejected: BriefPath[];
  counts: { paths: number; live: number; rejected: number; qualifying: number };
  /** What Brain proposes to do next, before it is taken. */
  proposedStep: PlannedStep | null;
  /** The step Brain actually took and where its work has got to. */
  currentStep: StepReading | null;
  /** What can happen today, and what needs an integration or a person. */
  today: string[];
  needsPerson: string[];
  watch: DecisionOutcome['watch'];
  history: ObjectiveDecision[];
  /** The whole brief as the text Russell posts. */
  text: string;
}

function toBriefPath(path: JudgedPath): BriefPath {
  return {
    ref: path.ref,
    source: path.source,
    title: path.title,
    how: path.how,
    standing: path.standing,
    because: path.because,
    tests: path.assessments,
    economics: path.economics,
  };
}

const KIND_TAG: Record<string, string> = {
  FACT: 'sourced',
  MEASURED: 'measured',
  ESTIMATE: 'Brain’s estimate',
  DECISION: 'a person’s decision',
  UNKNOWN: 'unknown',
};

export interface ComposedBrief {
  brief: DecisionBrief;
  outcome: DecisionOutcome;
}

export async function composeBrief(
  objective: Objective,
  now: string = new Date().toISOString(),
): Promise<ComposedBrief> {
  const context = await readContext(objective);
  const paths = await candidatePaths(context, now);
  const outcome = decide(paths);
  const steps = await listSteps(objective.id);
  const live = steps.filter((one) => one.supersededAt === null);
  const current = live[live.length - 1] ?? null;
  const currentStep = current ? await readStep(current) : null;
  const history = await listDecisions(objective.id);

  const liveCount = paths.length - outcome.rejected.length;
  const qualifying = outcome.leading?.standing === 'QUALIFIES' ? 1 + outcome.alternatives.filter((one) => one.path.standing === 'QUALIFIES').length : 0;

  const deciding = paths.length > 0 && outcome.nextStepPath
    ? [outcome.leading, ...outcome.alternatives.map((one) => one.path)].find((one) => one?.ref === outcome.nextStepPath) ?? outcome.leading
    : outcome.leading;
  const headline =
    outcome.verdict === 'RECOMMEND'
      ? `Do this: ${outcome.leading!.title} — ${outcome.nextStep?.description ?? 'see it through'}`
      : outcome.verdict === 'NO_PATH_QUALIFIES'
        ? `Nothing qualifies yet. What decides it next: ${
            outcome.nextStep?.serves ? CRITERION_LABEL[outcome.nextStep.serves].toLowerCase() : 'its first open test'
          }, for "${deciding?.title ?? ''}".`
        : outcome.leading
          ? 'Stop here: no live path has a way forward Brain can take.'
          : 'Stop here: there is no candidate path to decide between.';

  const today: string[] = [];
  const needsPerson: string[] = [];
  if (outcome.nextStep) {
    if (outcome.nextStep.authority === 'AUTHORIZED') today.push(outcome.nextStep.description);
    else needsPerson.push(outcome.nextStep.boundary ?? outcome.nextStep.description);
  }
  if (outcome.leading) {
    const execution = outcome.leading.executionStep;
    const covered = execution?.authority === 'NEEDS_PERSON' && execution.boundary !== null;
    for (const test of outcome.leading.assessments) {
      if (test.reading !== 'NEEDS_PERSON') continue;
      // The grant is said once, by the step that needs it, rather than per test.
      if (covered && (test.criterion === 'AUTHORITY' || test.criterion === 'CAPACITY')) continue;
      needsPerson.push(`${CRITERION_LABEL[test.criterion]}: ${test.statement}`);
    }
    if (execution && execution !== outcome.nextStep && covered) {
      needsPerson.push(`Once it qualifies, the first step is: ${execution.description} ${execution.boundary}`);
    }
  }

  const brief: DecisionBrief = {
    objective: {
      id: objective.id,
      statement: objective.statement,
      sourceKind: objective.sourceKind,
      sourceRef: objective.sourceRef,
      projectId: objective.projectId,
      conversationId: objective.conversationId,
      createdAt: objective.createdAt,
      closedAt: objective.closedAt,
    },
    context,
    verdict: outcome.verdict,
    headline,
    reasons: outcome.reasons,
    leading: outcome.leading ? toBriefPath(outcome.leading) : null,
    alternatives: outcome.alternatives.map((one) => ({ ...toBriefPath(one.path), whyLower: one.whyLower })),
    rejected: outcome.rejected.map(toBriefPath),
    counts: { paths: paths.length, live: liveCount, rejected: outcome.rejected.length, qualifying },
    proposedStep: outcome.nextStep,
    currentStep,
    today: [...new Set(today)],
    needsPerson: [...new Set(needsPerson)],
    watch: outcome.watch,
    history,
    text: '',
  };
  brief.text = briefText(brief);
  return { brief, outcome };
}

export async function briefFor(objectiveId: string): Promise<DecisionBrief | null> {
  const objective = await getObjective(objectiveId);
  if (!objective) return null;
  return (await composeBrief(objective)).brief;
}

function testLine(test: CriterionAssessment): string {
  return `${CRITERION_LABEL[test.criterion]}: ${test.reading.replace('_', ' ').toLowerCase()} (${KIND_TAG[test.kind]}) — ${test.statement}${
    test.evidenceRef ? ` [${test.evidenceRef}]` : ''
  }`;
}

/** The brief as prose. Every clause comes from a field above; nothing is added here. */
export function briefText(brief: DecisionBrief): string {
  const lines: string[] = [];
  lines.push(
    `Objective: ${brief.objective.statement}` +
      (brief.objective.sourceKind === 'CASH_MODE'
        ? ' (the objective recorded on this project’s Cash Mode sprint)'
        : ' (as you stated it)'),
  );
  lines.push(
    `What I can establish: ${brief.context.authority.research.sentence} ` +
      (brief.context.authority.commercial.granted
        ? `A commercial grant permits ${brief.context.authority.commercial.allowedActions.join(', ')}.`
        : 'There is no commercial grant, so nothing may contact, buy, spend, commit or publish.') +
      ' ' +
      brief.context.resources.map((one) => `${one.label}: ${one.value}.`).join(' '),
  );
  lines.push('');
  lines.push(brief.headline);
  for (const reason of brief.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push(
    `I compared ${brief.counts.paths} candidate path${brief.counts.paths === 1 ? '' : 's'}: ${brief.counts.live} still live, ${brief.counts.rejected} rejected on evidence.`,
  );
  if (brief.leading) {
    lines.push(`Leading: ${brief.leading.title}${brief.leading.how ? ` — ${brief.leading.how.replace(/[.\s]+$/, '')}` : ''}.`);
    lines.push(`  ${brief.leading.because}`);
    for (const test of brief.leading.tests) {
      if (test.reading === 'NOT_APPLICABLE') continue;
      lines.push(`  · ${testLine(test)}`);
    }
    const figures = brief.leading.economics.filter((one) => one.value !== null || one.basis);
    if (figures.length > 0) {
      lines.push('  Economics and effort:');
      for (const figure of figures) {
        lines.push(
          `  · ${figure.label}: ${figure.value ?? 'not established'} (${KIND_TAG[figure.kind]})${
            figure.basis ? ` — ${figure.basis}` : ''
          }`,
        );
      }
    }
  }
  if (brief.alternatives.length > 0) {
    lines.push('Alternatives, and why each ranks lower:');
    for (const alt of brief.alternatives) lines.push(`- ${alt.title}: ${alt.whyLower}.`);
  }
  if (brief.rejected.length > 0) {
    lines.push(`Rejected (${brief.rejected.length}):`);
    for (const rejected of brief.rejected.slice(0, 5)) {
      const decisive = rejected.tests.find((one) => one.reading === 'NOT_MET' && one.kind !== 'ESTIMATE');
      lines.push(`- ${rejected.title}: ${rejected.because}${decisive?.evidenceRef ? ` [${decisive.evidenceRef}]` : ''}`);
    }
    if (brief.rejected.length > 5) lines.push(`- and ${brief.rejected.length - 5} more, each with its reason.`);
  }
  lines.push('');
  if (brief.today.length > 0) {
    lines.push('What Brain can do today:');
    for (const one of brief.today) lines.push(`- ${one}`);
  }
  if (brief.currentStep) {
    lines.push(
      `Next step taken: ${brief.currentStep.step.description} — ${brief.currentStep.status.replace(/_/g, ' ').toLowerCase()}: ${brief.currentStep.detail}`,
    );
  }
  if (brief.needsPerson.length > 0) {
    lines.push('What needs a person or an integration:');
    for (const one of brief.needsPerson) lines.push(`- ${one}`);
  }
  lines.push('What would change this:');
  if (brief.watch.continueIf) lines.push(`- Continue if ${brief.watch.continueIf}`);
  if (brief.watch.reviseIf) lines.push(`- Revise if ${brief.watch.reviseIf}`);
  if (brief.watch.stopIf) lines.push(`- Stop if ${brief.watch.stopIf}`);
  return lines.join('\n');
}

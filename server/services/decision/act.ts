/**
 * Turning a decision into work, and carrying the result back.
 *
 * `advanceObjective` composes the brief, and if Brain proposes a step it
 * records that step and — only where a grant a person already set covers it —
 * turns it into an existing kind of work item:
 *
 *  - **QUALIFY_OPENING** steers the existing bounded deep dive: the opening is
 *    moved to the front of `startValidations`' queue (a preference, never a
 *    ceiling) and a dive is started if a slot is free. No second research
 *    path, no second queue, no second evidence gate.
 *  - **RESEARCH_QUESTION** captures one bounded Russell idea, which the loop
 *    judges against the archive, compiles and launches inside the standing
 *    research grant — or parks with the grant's own reason.
 *  - **COMMERCIAL_ACTION** and **SOFTWARE_REQUEST** are never performed here.
 *    They are recorded as a prepared action with the exact boundary a person
 *    owns; the grant, the authorization and the effect all stay where they
 *    already are.
 *  - **AWAIT_EXISTING** points at work that is already running, so the same
 *    question is not bought twice.
 *
 * Then the decision is compared with the last one recorded. When it changed —
 * because research came back, a grant was set, an opening closed — a row is
 * appended and Russell says so in the conversation the objective was asked
 * in. That is what makes the result return to Russell without anybody pasting
 * it back in: the next brief is derived from the rows the finished work wrote.
 *
 * Idempotent by rows: a step is keyed by the objective, the path, its kind and
 * the question it serves, and a decision is appended only when its fingerprint
 * moved. Two ticks running this at once produce one step and one snapshot.
 */
import {
  appendDecision,
  setDecisionMessage,
  getObjective,
  latestDecision,
  listObjectives,
  listSteps,
  recordStep,
  supersedeStep,
  type Objective,
  type ObjectiveStep,
} from '../../repos/objectives.ts';
import { addMessage, getConversation, recordProduced } from '../../repos/russellConversations.ts';
import { startValidations } from '../cash/validation.ts';
import { capture } from '../russell/judgment.ts';
import { decisionFingerprint, type DecisionOutcome, type PlannedStep } from '../../domain/decision.ts';
import { composeBrief, readStep, type DecisionBrief } from './brief.ts';
import { getUser, listMembershipsForPrincipal } from '../../repos/identity.ts';
import { decideProjectAccess } from '../identity/policy.ts';
import type { Principal } from '../../domain/types.ts';

/**
 * May the person this objective belongs to cause work on its project, now?
 *
 * Read from current rows on every pass, never from the moment the objective
 * was opened: a person whose write access was withdrawn still gets a brief,
 * and Brain stops taking steps on their behalf. The step itself still goes
 * through the grant that owns its kind of work, which decides again.
 */
export async function ownerMayAct(objective: Objective): Promise<boolean> {
  const user = await getUser(objective.createdByUserId);
  if (!user || user.disabledAt) return false;
  const principal: Principal = {
    type: 'HUMAN',
    id: user.id,
    handle: user.email,
    displayName: user.displayName,
    isBrainAdmin: user.isBrainAdmin,
    mustChangePassword: user.mustChangePassword,
    credentialId: `decision:objective:${objective.id}`,
    authMethod: 'SESSION_COOKIE',
    memberships: (await listMembershipsForPrincipal('HUMAN', user.id)).filter((m) => m.active),
    requestId: `decision:objective:${objective.id}`,
  };
  return decideProjectAccess(principal, objective.projectId, 'WRITE').allowed;
}

export interface AdvanceResult {
  objectiveId: string;
  brief: DecisionBrief;
  /** The step taken on this pass, if one was new. */
  took: ObjectiveStep | null;
  /** Whether the recommendation changed and was reported. */
  changed: boolean;
  messageId: string | null;
}

function stepKey(outcome: DecisionOutcome, step: PlannedStep): string {
  return `${step.kind}:${outcome.nextStepPath ?? '-'}:${step.serves ?? '-'}:${step.existingWork?.id ?? '-'}`;
}

/** Turn the proposed step into a work item, where a grant already covers it. */
async function take(objective: Objective, outcome: DecisionOutcome, step: PlannedStep): Promise<ObjectiveStep> {
  const key = stepKey(outcome, step);
  const pathRef = outcome.nextStepPath ?? outcome.leading?.ref ?? '-';
  const steps = await listSteps(objective.id);
  const existing = steps.find((one) => one.stepKey === key);
  if (existing) return existing;
  /*
   * Waiting on work the last step already started is the same step, not a new
   * one: the deep dive this objective steered is now simply running.
   */
  if (step.kind === 'AWAIT_EXISTING') {
    const live = steps.find((one) => one.supersededAt === null && one.pathRef === pathRef);
    if (live) return live;
  }

  let workKind: string | null = step.existingWork?.kind ?? null;
  let workRef: string | null = step.existingWork?.id ?? null;

  if (step.authority === 'AUTHORIZED' && step.kind === 'QUALIFY_OPENING') {
    const [source, id] = pathRef.split(':');
    if (source === 'CASH_OPPORTUNITY' && id) {
      workKind = 'OPPORTUNITY';
      workRef = id;
    }
  }
  if (step.authority === 'AUTHORIZED' && step.kind === 'RESEARCH_QUESTION') {
    const captured = await capture({
      title: step.description.slice(0, 140),
      statement: step.description,
      projectId: objective.projectId,
      visibility: 'SHARED',
      conversationId: objective.conversationId,
    });
    if (captured.candidate) {
      workKind = 'CANDIDATE';
      workRef = captured.candidate.id;
    }
  }

  const { step: recorded } = await recordStep({
    objectiveId: objective.id,
    kind: step.kind,
    pathRef,
    serves: step.serves,
    description: step.description,
    workKind,
    // A step that could not become work is a prepared action at a boundary.
    workRef,
    authority: step.authority === 'AUTHORIZED' && workRef ? 'AUTHORIZED' : 'NEEDS_PERSON',
    boundary: step.boundary,
    prepared: step.prepared,
    stepKey: key,
  });

  // Supersede the steps this one replaces, keeping their rows.
  for (const other of await listSteps(objective.id)) {
    if (other.id !== recorded.id && other.supersededAt === null) {
      await supersedeStep(other.id, `The decision moved on to: ${recorded.description}`);
    }
  }

  if (recorded.kind === 'QUALIFY_OPENING' && recorded.authority === 'AUTHORIZED') {
    // Start it now if a bounded slot is free; otherwise it goes first when one is.
    await startValidations({ projectId: objective.projectId, limit: 1 });
  }
  return recorded;
}

/** What changed since the last decision, in words, from the step it had taken. */
async function whatChanged(objective: Objective): Promise<string | null> {
  const steps = await listSteps(objective.id);
  const last = [...steps].reverse().find((one) => one.supersededAt !== null) ?? steps[steps.length - 1];
  if (!last) return null;
  const reading = await readStep(last);
  return `The step "${last.description}" is ${reading.status.replace(/_/g, ' ').toLowerCase()}: ${reading.detail}`;
}

export async function advanceObjective(
  objectiveId: string,
  options: { now?: string; announce?: boolean } = {},
): Promise<AdvanceResult | null> {
  const objective = await getObjective(objectiveId);
  if (!objective || objective.closedAt) return null;
  let { brief, outcome } = await composeBrief(objective, options.now);

  let took: ObjectiveStep | null = null;
  if (outcome.nextStep && (await ownerMayAct(objective))) {
    const before = (await listSteps(objective.id)).length;
    took = await take(objective, outcome, outcome.nextStep);
    if ((await listSteps(objective.id)).length === before) took = null;
    // Re-read so the brief shows the step as taken rather than as proposed.
    ({ brief, outcome } = await composeBrief(objective, options.now));
  }

  const fingerprint = decisionFingerprint(outcome);
  const previous = await latestDecision(objective.id);
  if (previous && previous.fingerprint === fingerprint) {
    return { objectiveId, brief, took, changed: false, messageId: null };
  }

  const changedBecause = previous ? await whatChanged(objective) : null;
  /*
   * Append first, then speak. The append is keyed on the decision it follows,
   * so of two passes that noticed the same change exactly one wins — and only
   * the winner posts, which is what stops one change being announced twice.
   */
  const appended = await appendDecision({
    objectiveId: objective.id,
    followsId: previous?.id ?? null,
    verdict: outcome.verdict,
    pathRef: outcome.leading?.ref ?? null,
    fingerprint,
    summary: brief.headline,
    changedBecause,
    messageId: null,
  });
  if (!appended) return { objectiveId, brief, took, changed: false, messageId: null };

  let messageId: string | null = null;
  const announce = options.announce ?? true;
  if (previous && announce && objective.conversationId) {
    const conversation = await getConversation(objective.conversationId);
    if (conversation) {
      const message = await addMessage({
        conversationId: conversation.id,
        role: 'RUSSELL',
        content:
          `The recommendation for "${
            objective.statement.length > 120 ? `${objective.statement.slice(0, 117).trimEnd()}\u2026` : objective.statement
          }" changed.\n` +
          `Before: ${previous.summary}\n` +
          (changedBecause ? `What changed: ${changedBecause}\n` : '') +
          `\n${brief.text}`,
      });
      await recordProduced(message.id, { objectiveId: objective.id, verdict: brief.verdict });
      await setDecisionMessage(appended.id, message.id);
      messageId = message.id;
    }
  }
  const history = (await composeBrief(objective, options.now)).brief.history;
  return { objectiveId, brief: { ...brief, history }, took, changed: previous !== null, messageId };
}

/** The tick's pass: every live objective, re-derived, with its step taken. */
export async function advanceObjectives(options: { now?: string } = {}): Promise<AdvanceResult[]> {
  const out: AdvanceResult[] = [];
  for (const objective of await listObjectives({})) {
    try {
      const result = await advanceObjective(objective.id, options);
      if (result && (result.took || result.changed)) out.push(result);
    } catch {
      /* an objective that could not be advanced is left exactly as it was */
    }
  }
  return out;
}

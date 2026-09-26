/**
 * Named, reviewed shapes of work that only a person can do — composed from
 * rows, never from a sentence somebody typed.
 *
 * A recipe is not a shortcut around any step. It uses the same labor
 * allocation, the same work order, the same candidate and the same engagement
 * decision every other piece of human work goes through; what it adds is that
 * the exact work, the reason and the acceptance standard for a recurring kind
 * of task are written once, in code somebody reviews, instead of re-typed.
 *
 * ---------------------------------------------------------------------------
 * CONNECT_CLAUDE_CAPACITY
 * ---------------------------------------------------------------------------
 *
 * A member's Claude account becoming research capacity. Every step inside
 * Brain is already built (§34, §35); the one step nothing in Brain may do is
 * the authorization **inside that member's own Claude account** — an
 * identity-bearing act on somebody else's account is on the list no
 * commercial grant can ever carry. So a person is necessary, for exactly that,
 * and the result is judged by reading the same account-foundation dimensions
 * People renders: connection proven, worker attributed, capacity usable. Brain
 * reads them from rows; nobody's say-so settles them.
 */
import { getUser } from '../../repos/identity.ts';
import { createTask, createWorkflow, getTask, listTasks } from '../../repos/labor.ts';
import { assignByPerson } from '../labor/assign.ts';
import { foundationReading } from '../identity/foundation.ts';
import { namesFor } from '../capacity/connection.ts';
import { openWorkOrder } from './order.ts';
import { addWorkCandidate } from './candidates.ts';
import { listEngagements } from '../../repos/humanWork.ts';
import { prepareEngagement, requestEngagementDecision } from './engage.ts';
import type { Checked } from './vocabulary.ts';
import type { HumanWorkEngagement, HumanWorkOrder, RussellHumanRequest } from '../../domain/types.ts';

export const CAPACITY_WORKFLOW = 'Execution capacity';

export interface RecipeOutcome {
  order: HumanWorkOrder;
  engagement: HumanWorkEngagement | null;
  decision: RussellHumanRequest | null;
  notes: string[];
}

export async function connectClaudeCapacity(input: {
  projectId: string;
  memberUserId: string;
  actorRef: string;
  dueBy?: string | null;
}): Promise<Checked<RecipeOutcome>> {
  const member = await getUser(input.memberUserId);
  if (!member || member.kind !== 'PERSON' || member.disabled) {
    return { ok: false, reason: 'The member must be an enabled person on this Brain.' };
  }
  const names = namesFor(member);
  const notes: string[] = [];

  // The labor map: a workflow and a task, and a person's allocation of it.
  const { workflow } = await createWorkflow({
    projectId: input.projectId,
    name: CAPACITY_WORKFLOW,
    description: 'The Claude accounts whose Routines Brain fires, connected and proven.',
    origin: 'SEED',
    declaredByRef: input.actorRef,
  });
  const taskName = `Connect ${member.displayName}'s Claude account`;
  const existing = (await listTasks(input.projectId)).find((one) => one.workflowId === workflow.id && one.name === taskName);
  const task =
    existing ??
    (
      await createTask({
        projectId: input.projectId,
        workflowId: workflow.id,
        name: taskName,
        output: `The "${names.connectorName}" connector authorized in ${member.displayName}'s own Claude account, with that account's Routines bound to the worker it mints and proven by a fired session`,
        origin: 'SEED',
        declaredByRef: input.actorRef,
      })
    ).task;
  const allocated = await assignByPerson({
    projectId: input.projectId,
    task: (await getTask(task.id))!,
    productionLayer: 'DOMESTIC_HUMAN',
    necessityReason: 'ACCOUNTABILITY_LICENSING',
    rationale:
      `Only the holder of a Claude account may authorize a connector inside it. Brain acting in ` +
      `${member.displayName}'s account would be an identity-bearing act, which no grant on this Brain can carry.`,
    actorRef: input.actorRef,
  });
  if (!allocated.ok) return { ok: false, reason: allocated.reason };

  // What Brain prepares first, read from the same foundation People renders.
  const foundation = await foundationReading();
  const account = foundation.accounts.find((one) => one.userId === member.id);
  const prepares = [
    `The names are fixed in advance: connector "${names.connectorName}", Routine "${names.routineName}", worker "${names.workerName}", deployment secret "${names.secretName}".`,
    'The connection page on People & capacity walks each step in order and resumes wherever it stopped.',
    ...(account?.findings ?? [])
      .filter((finding) => finding.verdict === 'BLOCKED' && finding.owner !== 'MEMBER')
      .map((finding) => `Outstanding on Brain's side (${finding.owner}): ${finding.nextAction}`),
  ];

  const opened = await openWorkOrder({
    projectId: input.projectId,
    taskId: task.id,
    title: taskName,
    work:
      `Sign in to Brain, open People & capacity, and follow your Claude connection to the end: authorize the ` +
      `"${names.connectorName}" connector inside your own Claude account through the invitation it issues, ` +
      `and give Brain the trigger reference of each Routine you want it to fire.`,
    brainPrepares: prepares,
    deliverables: ['The connector authorized in your own Claude account', 'The trigger reference of each Routine'],
    acceptance: [
      { key: 'connection', statement: 'The Claude connection is proven by a session Brain fired', check: 'ACCOUNT_FOUNDATION', userId: member.id, dimension: 'CLAUDE_CONNECTION' },
      { key: 'attribution', statement: `Work run on it is attributed to ${member.displayName}`, check: 'ACCOUNT_FOUNDATION', userId: member.id, dimension: 'WORKER_ATTRIBUTION' },
      { key: 'capacity', statement: 'The dispatcher can fire it', check: 'ACCOUNT_FOUNDATION', userId: member.id, dimension: 'CAPACITY' },
    ],
    sharedContext: [
      'Your connection page on People & capacity names each step and who performs it.',
      'The connector invitation is a single-use credential shown once, in your browser. Do not paste it anywhere else.',
    ],
    accessRequired: [],
    dueBy: input.dueBy ?? null,
    currency: 'USD',
    actorRef: input.actorRef,
  });
  if (!opened.ok) return opened;
  const order = opened.value.order;
  if (!opened.value.created) notes.push('The work was already open; nothing was duplicated.');

  const candidate = await addWorkCandidate({
    orderId: order.id,
    relationship: 'TEAM_MEMBER',
    userId: member.id,
    competence: [
      {
        statement: `${member.displayName} holds the Claude account this connects — the only person who can authorize inside it.`,
        basis: 'BRAIN_RECORD',
        ref: `users/${member.id}`,
      },
    ],
    quoteCents: 0,
    quoteSource: 'INTERNAL_NO_CHARGE',
    uncertainties: [
      `Availability is unknown: nobody has asked ${member.displayName} when they can do this.`,
      ...(account?.findings.find((one) => one.dimension === 'SIGN_IN' && one.verdict === 'BLOCKED')
        ? [`${member.displayName} cannot currently sign in to Brain, so the assignment cannot reach them until that is fixed.`]
        : []),
    ],
    actorRef: input.actorRef,
  });
  if (!candidate.ok) return candidate;

  const live = await listEngagements(order.id);
  const current = live.find((one) => ['PROPOSED', 'APPROVED', 'INVITED', 'ENGAGED'].includes(one.state));
  if (current) {
    notes.push(`An engagement is already ${current.state}; nothing new was proposed.`);
    return { ok: true, value: { order, engagement: current, decision: null, notes } };
  }

  const engagement = await prepareEngagement({
    orderId: order.id,
    candidateId: candidate.value.candidate.id,
    terms: {
      scope: order.work,
      deliverables: order.deliverables,
      schedule: [{ milestone: 'Connector authorized and a fired session arrives', due: input.dueBy ?? null }],
      compensationCents: 0,
      currency: 'USD',
      rateBasis: null,
      compensationBasis: `${member.displayName} is a member of this Brain; connecting their own account is not paid work.`,
      access: [],
      confidentiality:
        'The connector invitation is a single-use credential shown once to the member; no secret value passes through Brain or anybody else.',
      ownership: 'Not applicable: the account stays the member’s, and Brain holds only a token it minted for the worker.',
    },
    actorRef: input.actorRef,
  });
  if (!engagement.ok) return engagement;
  const decision = await requestEngagementDecision({ engagementId: engagement.value.id, actorRef: input.actorRef });
  if (!decision.ok) return decision;
  return { ok: true, value: { order, engagement: engagement.value, decision: decision.value, notes } };
}


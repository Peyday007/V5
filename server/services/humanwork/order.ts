/**
 * Step 1: deciding that a person is necessary, and saying precisely for what.
 *
 * The decision is not made here. §41's labor kernel already makes it — a task
 * whose live allocation names a human layer and one of six reasons — and this
 * refuses to open work for anybody unless that judgment exists. What this adds
 * is everything the judgment left unsaid: the exact work, why a person, what
 * Brain prepares before anybody is asked, and the standard the result will be
 * accepted against.
 */
import { getTask, liveAllocationFor } from '../../repos/labor.ts';
import { layerIsHuman } from '../../domain/labor.ts';
import { getMembership, getUser } from '../../repos/identity.ts';
import { createOrder, getOrder, recordHumanWorkEvent, setCoordinator } from '../../repos/humanWork.ts';
import { recordEvent } from '../../repos/events.ts';
import { acceptanceConditions, stringList, type Checked } from './vocabulary.ts';
import { roleAtLeast } from '../identity/policy.ts';
import type { HumanWorkOrder } from '../../domain/types.ts';

export async function openWorkOrder(input: {
  projectId: string;
  taskId: string;
  title: string;
  work: string;
  whyPerson?: string | null;
  brainPrepares?: unknown;
  deliverables?: unknown;
  acceptance: unknown;
  sharedContext?: unknown;
  accessRequired?: unknown;
  dueBy?: string | null;
  budgetCents?: number | null;
  currency?: string | null;
  coordinatorUserId?: string | null;
  actorRef: string;
}): Promise<Checked<{ order: HumanWorkOrder; created: boolean }>> {
  const task = await getTask(input.taskId);
  if (!task || task.projectId !== input.projectId) return { ok: false, reason: 'No task with that id.' };
  if (task.retiredAt) return { ok: false, reason: 'That task is retired; nothing is produced by it any more.' };

  const allocation = await liveAllocationFor(task.id);
  if (!allocation || !layerIsHuman(allocation.productionLayer) || !allocation.necessityReason) {
    return {
      ok: false,
      reason:
        'Nothing has established that a person produces this task. Record who produces it on the ' +
        'labor map first — a human layer with one of the six reasons — and the work can be opened ' +
        'against that decision. Brain does not engage people for work nobody has said needs one.',
    };
  }

  const title = (input.title ?? '').trim();
  const work = (input.work ?? '').trim();
  if (!title) return { ok: false, reason: 'Give the work a title.' };
  if (!work) return { ok: false, reason: 'Say precisely what the person must do.' };

  const prepares = stringList(input.brainPrepares, 'brainPrepares');
  if (!prepares.ok) return prepares;
  const deliverables = stringList(input.deliverables, 'deliverables', { min: 1 });
  if (!deliverables.ok) return deliverables;
  const acceptance = acceptanceConditions(input.acceptance);
  if (!acceptance.ok) return acceptance;
  for (const condition of acceptance.value) {
    if (condition.check === 'ACCOUNT_FOUNDATION' && condition.userId && !(await getUser(condition.userId))) {
      return { ok: false, reason: `acceptance "${condition.key}" names an account that does not exist.` };
    }
  }
  const shared = stringList(input.sharedContext, 'sharedContext');
  if (!shared.ok) return shared;
  const access = stringList(input.accessRequired, 'accessRequired');
  if (!access.ok) return access;
  if (input.dueBy && Number.isNaN(Date.parse(input.dueBy))) return { ok: false, reason: 'dueBy is not a date.' };
  if (input.budgetCents !== undefined && input.budgetCents !== null) {
    if (!Number.isInteger(input.budgetCents) || input.budgetCents < 0) {
      return { ok: false, reason: 'budgetCents must be a whole, non-negative number.' };
    }
  }
  if (input.coordinatorUserId) {
    const refusal = await coordinatorRefusal(input.projectId, input.coordinatorUserId);
    if (refusal) return { ok: false, reason: refusal };
  }

  const whyPerson =
    (input.whyPerson ?? '').trim() ||
    `The labor map records that a person produces this (${allocation.productionLayer}, ` +
      `${allocation.necessityReason}): ${allocation.rationale}`;

  const result = await createOrder({
    projectId: input.projectId,
    taskId: task.id,
    allocationId: allocation.id,
    necessityReason: allocation.necessityReason,
    title,
    work,
    whyPerson,
    brainPrepares: prepares.value,
    deliverables: deliverables.value,
    acceptance: acceptance.value,
    sharedContext: shared.value,
    accessRequired: access.value,
    dueBy: input.dueBy ?? null,
    budgetCents: input.budgetCents ?? null,
    currency: (input.currency ?? 'USD').toUpperCase(),
    coordinatorUserId: input.coordinatorUserId ?? null,
    openedBy: input.actorRef,
  });
  if (result.created) {
    await recordHumanWorkEvent({
      projectId: input.projectId,
      orderId: result.order.id,
      kind: 'ORDER_OPENED',
      summary: `Work opened for a person: ${title}.`,
      detail: { taskId: task.id, allocationId: allocation.id, reason: allocation.necessityReason },
      actor: 'PERSON',
      actorUserId: input.actorRef,
    });
    await recordEvent({
      projectId: input.projectId,
      entityType: 'human_work_order',
      entityId: result.order.id,
      eventType: 'HUMAN_WORK_ORDER_OPENED',
      payload: { taskId: task.id, allocationId: allocation.id, openedBy: input.actorRef },
    });
  }
  return { ok: true, value: result };
}

/**
 * A coordinator works with Brain on delivery, so they must already be able to
 * write to this project. Designating somebody never grants them anything.
 */
export async function coordinatorRefusal(projectId: string, userId: string): Promise<string | null> {
  const user = await getUser(userId);
  if (!user || user.disabled || user.kind !== 'PERSON') return 'The coordinator must be an enabled person on this Brain.';
  if (user.isBrainAdmin) return null;
  const membership = await getMembership(projectId, 'HUMAN', userId);
  if (!membership || !membership.active || !roleAtLeast(membership.role, 'MEMBER')) {
    return (
      'A coordinator must already be able to write to this project. Designating somebody grants ' +
      'nothing; give them membership first, which is its own decision.'
    );
  }
  return null;
}

export async function designateCoordinator(input: {
  orderId: string;
  userId: string | null;
  actorRef: string;
}): Promise<Checked<HumanWorkOrder>> {
  const order = await getOrder(input.orderId);
  if (!order) return { ok: false, reason: 'No work order with that id.' };
  if (order.state !== 'OPEN') return { ok: false, reason: 'That work is closed.' };
  if (input.userId) {
    const refusal = await coordinatorRefusal(order.projectId, input.userId);
    if (refusal) return { ok: false, reason: refusal };
  }
  await setCoordinator(order.id, input.userId);
  await recordHumanWorkEvent({
    projectId: order.projectId,
    orderId: order.id,
    kind: 'COORDINATOR_DESIGNATED',
    summary: input.userId ? 'A coordinator was designated to work with Brain on delivery.' : 'The coordinator was removed.',
    detail: { coordinatorUserId: input.userId },
    actor: 'PERSON',
    actorUserId: input.actorRef,
  });
  const updated = await getOrder(order.id);
  return { ok: true, value: updated! };
}

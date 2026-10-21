/**
 * The decisions only a person makes about the commerce kernel (§73): starting
 * it, pausing it, naming a product to look at, and retiring one.
 *
 * **Pressing start is the authorization**, and what it authorizes is reading
 * published sources inside the project's Cash Mode sprint — exactly what the
 * sprint's own discovery grant already allows. It authorizes no order with a
 * supplier, no store, no listing, no advertisement and no spending: every one
 * of those is a `COMMERCIAL_ACTION` a person grants separately, and nothing in
 * this kernel performs any of them.
 *
 * The actor is a person's user id resolved from the authenticated principal by
 * the route or the terminal; Brain never starts, pauses or seeds anything here
 * for itself, and `SEED` is the one product origin it may not write.
 */
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import {
  createCommerceProduct,
  getCommerceProgramme,
  insertCommerceProgramme,
  listCommerceProducts,
  retireCommerceProduct,
  setCommerceProgrammeState,
} from '../../repos/commerce.ts';
import type { CommerceProduct, CommerceProgramme, CommerceProgrammeState } from '../../domain/types.ts';

export type Refusal = { ok: false; reason: string };

/** The shortest objective that says what the programme is for. */
export const MIN_OBJECTIVE_CHARS = 20;

export async function startCommerceProgramme(input: {
  projectId: string;
  actorUserId: string;
  objective: string;
}): Promise<{ ok: true; programme: CommerceProgramme; created: boolean } | Refusal> {
  const objective = input.objective.replace(/\s+/g, ' ').trim();
  if (objective.length < MIN_OBJECTIVE_CHARS) {
    return {
      ok: false,
      reason:
        `Say what the programme is for in at least ${MIN_OBJECTIVE_CHARS} characters — for example ` +
        '"find generic products selling now that one order can pay to advertise".',
    };
  }
  if (input.actorUserId === 'BRAIN') {
    return { ok: false, reason: 'Starting the commerce programme is a person’s decision.' };
  }
  const mode = await getCashMode(input.projectId);
  if (!mode) {
    return {
      ok: false,
      reason:
        'This project has no Cash Mode sprint. The commerce kernel runs inside one, because its ' +
        'questions are read-only research under the sprint’s discovery grant — activate a sprint first.',
    };
  }
  const { programme, created } = await insertCommerceProgramme({
    projectId: input.projectId,
    objective,
    startedBy: input.actorUserId,
  });
  if (created) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: 'COMMERCE_PROGRAMME_STARTED',
      actorRef: input.actorUserId,
      summary: `The commerce programme was started: ${objective}`,
      detail: { programmeId: programme.id },
    });
  }
  return { ok: true, programme, created };
}

export async function moveCommerceProgramme(input: {
  projectId: string;
  actorUserId: string;
  to: CommerceProgrammeState;
}): Promise<{ ok: true; programme: CommerceProgramme } | Refusal> {
  const programme = await getCommerceProgramme(input.projectId);
  if (!programme) return { ok: false, reason: 'No commerce programme has been started here.' };
  if (programme.state === input.to) return { ok: true, programme };
  const moved = await setCommerceProgrammeState({
    projectId: input.projectId,
    from: programme.state,
    to: input.to,
  });
  if (!moved) return { ok: false, reason: 'The programme changed state while this was being decided; read it again.' };
  await recordCashEvent({
    projectId: input.projectId,
    kind: 'COMMERCE_PROGRAMME_MOVED',
    actorRef: input.actorUserId,
    summary: `The commerce programme moved from ${programme.state} to ${input.to}.`,
    detail: { programmeId: programme.id, from: programme.state, to: input.to },
  });
  return { ok: true, programme: (await getCommerceProgramme(input.projectId))! };
}

export async function seedCommerceProduct(input: {
  projectId: string;
  actorUserId: string;
  name: string;
  note?: string | null;
}): Promise<{ ok: true; product: CommerceProduct; created: boolean } | Refusal> {
  if (!(await getCommerceProgramme(input.projectId))) {
    return { ok: false, reason: 'Start the commerce programme before naming products for it.' };
  }
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (name.length < 3) return { ok: false, reason: 'Name the product as a shopper would search for it.' };
  const { product, created } = await createCommerceProduct({
    projectId: input.projectId,
    name,
    note: input.note ?? `Named by ${input.actorUserId}.`,
    origin: 'SEED',
  });
  if (created) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: 'COMMERCE_PRODUCT_SEEDED',
      actorRef: input.actorUserId,
      summary: `A person put ${name} on the commerce map.`,
      detail: { productId: product.id },
    });
  }
  return { ok: true, product, created };
}

export async function retireCommerceProductDecision(input: {
  projectId: string;
  actorUserId: string;
  productId: string;
  reason: string;
}): Promise<{ ok: true } | Refusal> {
  const reason = input.reason.trim();
  if (!reason) return { ok: false, reason: 'Say why the product is being retired; the reason is kept.' };
  const known = (await listCommerceProducts(input.projectId)).some((one) => one.id === input.productId);
  if (!known) return { ok: false, reason: 'No such product on this project’s map.' };
  const retired = await retireCommerceProduct({ projectId: input.projectId, productId: input.productId, reason });
  if (!retired) return { ok: false, reason: 'That product is already retired.' };
  await recordCashEvent({
    projectId: input.projectId,
    kind: 'COMMERCE_PRODUCT_RETIRED',
    actorRef: input.actorUserId,
    summary: `A product was retired from the commerce map: ${reason}`,
    detail: { productId: input.productId },
  });
  return { ok: true };
}

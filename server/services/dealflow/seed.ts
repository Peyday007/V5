/**
 * The two things a person does to this kernel directly.
 *
 * ---------------------------------------------------------------------------
 * Naming a counterparty is a person's, and the schema enforces it
 * ---------------------------------------------------------------------------
 *
 * `deal_parties.origin` is `SEED` or `DISCOVERED`, and a CHECK requires every
 * `DISCOVERED` row to carry the claim that established it. So Brain cannot
 * write a `SEED` party at all: there is no code path that could, because there
 * is no way for it to produce a row with no claim and a seeded origin. §22's
 * split at the table that decides who the market is — a machine that could
 * name its own counterparties would be deciding who exists.
 *
 * Seeding spends nothing and starts nothing. It creates a row; the allocator
 * decides when that party is asked about, the discovery grant decides whether
 * that may run, and the evidence gate decides what may be claimed.
 *
 * ---------------------------------------------------------------------------
 * Recording what happened is a person's for a different reason
 * ---------------------------------------------------------------------------
 *
 * An observation is the one kind of fact in this kernel that no source
 * publishes: whether the buyer replied, whether the supplier would deal,
 * whether the certification turned out to be something nobody had researched.
 * It comes from an attempt somebody made, so it comes from them.
 *
 * `recorded_by` keeps a person's observation apart from Brain reading its own
 * rows, and `lessons.ts` counts them separately — because four of Brain's own
 * derivations about one deal are one observation four times over, and
 * presenting them as a sample of four would be arithmetic on a fiction.
 */
import { recordCashEvent } from '../../repos/cashMode.ts';
import {
  createParty,
  getParty,
  recordObservation,
  retireParty,
} from '../../repos/dealflow.ts';
import type {
  DealObservation,
  DealObservationKind,
  DealParty,
  DealPartyKind,
} from '../../domain/types.ts';

const SEEDED = 'DEALFLOW_PARTY_SEEDED';
const RETIRED = 'DEALFLOW_PARTY_RETIRED';
const OBSERVED = 'DEALFLOW_OUTCOME_OBSERVED';

export async function seedParty(input: {
  projectId: string;
  actorRef: string;
  kind: DealPartyKind;
  name: string;
  country?: string | null;
  equipmentClass: string;
  note?: string | null;
}): Promise<{ party: DealParty; created: boolean }> {
  const result = await createParty({
    projectId: input.projectId,
    kind: input.kind,
    name: input.name,
    country: input.country ?? null,
    equipmentClass: input.equipmentClass,
    note: input.note ?? null,
    origin: 'SEED',
    sourceClaimId: null,
  });
  if (result.created) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: SEEDED,
      actorRef: input.actorRef,
      summary: `${result.party.name} was seeded as a ${input.kind.toLowerCase()} for ${result.party.equipmentClass}.`,
      detail: {
        partyId: result.party.id,
        kind: input.kind,
        country: result.party.country,
        equipmentClass: result.party.equipmentClass,
      },
    });
  }
  return result;
}

/**
 * Stop asking about a party.
 *
 * Never a delete. A retired party is evidence about where Brain has already
 * looked, and deleting it would make the same organisation arrive again on the
 * next round as a fresh discovery — §5, and §38's own argument for the same
 * column on `industry_nodes`.
 *
 * Its deals keep their rows too. A pairing that is no longer worth pursuing is
 * still a pairing that was considered, and the reading will say so.
 */
export async function retire(input: {
  projectId: string;
  actorRef: string;
  partyId: string;
  reason: string;
}): Promise<DealParty | null> {
  const before = await getParty(input.partyId);
  if (!before || before.projectId !== input.projectId) return null;
  const after = await retireParty({ partyId: input.partyId, reason: input.reason });
  if (after && before.retiredAt === null) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: RETIRED,
      actorRef: input.actorRef,
      summary: `${before.name} was retired: ${input.reason}`,
      detail: { partyId: before.id, reason: input.reason },
    });
  }
  return after;
}

export async function observe(input: {
  projectId: string;
  actorRef: string;
  dealId?: string | null;
  kind: DealObservationKind;
  jurisdiction?: string | null;
  equipmentClass?: string | null;
  statement: string;
}): Promise<DealObservation> {
  const observation = await recordObservation({
    projectId: input.projectId,
    dealId: input.dealId ?? null,
    kind: input.kind,
    jurisdiction: input.jurisdiction ?? null,
    equipmentClass: input.equipmentClass ?? null,
    statement: input.statement,
    recordedBy: input.actorRef,
  });
  await recordCashEvent({
    projectId: input.projectId,
    kind: OBSERVED,
    actorRef: input.actorRef,
    summary: `${input.kind} recorded: ${input.statement}`,
    detail: {
      observationId: observation.id,
      dealId: observation.dealId,
      kind: observation.kind,
      jurisdiction: observation.jurisdiction,
      equipmentKey: observation.equipmentKey,
    },
  });
  return observation;
}

/**
 * What a control on the dealflow screen may be *offered* for, decided by the
 * server.
 *
 * ---------------------------------------------------------------------------
 * Why this is not derived in the client
 * ---------------------------------------------------------------------------
 *
 * `services/cash/access.ts` and `services/labor/access.ts` make the argument
 * in full and it is the same argument here. The browser holds one role flag
 * — is this a Brain administrator — and every decision on this screen is
 * project `ADMIN`, exactly as `services/identity/policy.ts` already states at
 * `/^\/api\/projects\/[^/]+\/cash\/dealflow/`. A client deriving it would be
 * wrong in both directions at once: it would hide the controls from a project
 * administrator who is not a Brain administrator, which is §24's *waiting
 * nobody can resolve*, and it would offer them on a project where the level
 * was the real question, because a Brain administrator reaches every project
 * by design.
 *
 * So the same `decideProjectAccess` every route applies answers it here too.
 * **There is no dealflow policy module and there must never be one.**
 *
 * ---------------------------------------------------------------------------
 * It is a convenience and never the control
 * ---------------------------------------------------------------------------
 *
 * `mayAdminister` is re-decided at the moment anything happens, by
 * `requirePerson`, `requireProject` and the policy module. A hidden button is
 * not authorization (§17) and this is not one. What it is for is §35's rule:
 * a control somebody may not use is **disabled with the server's reason**,
 * never removed — because a screen that removes it has a different shape per
 * reader, and *there is no button* and *the button is not for you* are
 * answers a person reads very differently.
 *
 * `because` is on the row for the same reason every verdict on the Labor and
 * Machines screens is: a sentence composed in the browser is a second reader
 * of a decision the server already made, and it will eventually say
 * something the server did not.
 *
 * ---------------------------------------------------------------------------
 * The vocabulary travels with the reading
 * ---------------------------------------------------------------------------
 *
 * §24's manifest lesson, applied to this form: `partyKinds` and
 * `observationKinds` are `DEAL_PARTY_KINDS` and `DEAL_OBSERVATION_KINDS`
 * verbatim, never restated, so the set a form offers and the set the route
 * refuses outside of are one object. A browser holding its own copy would
 * eventually offer a value the server had removed — a refusal the person
 * could not have predicted, which §35 records as the thing that teaches
 * somebody a refusal is arbitrary.
 */
import { currentPrincipal } from '../identity/context.ts';
import { decideProjectAccess } from '../identity/policy.ts';
import { listDeals, listParties } from '../../repos/dealflow.ts';
import { DEAL_OBSERVATION_KINDS, DEAL_PARTY_KINDS } from '../../domain/types.ts';
import type { DealObservationKind, DealParty, DealPartyKind } from '../../domain/types.ts';

export interface DealflowCapabilities {
  /** Seed a party, retire one, or record an observation. Project `ADMIN`. */
  mayAdminister: boolean;
  /** Why not, in the server's own words, or null where there is nothing to say. */
  because: string | null;
}

export interface DealflowVocabulary {
  partyKinds: readonly DealPartyKind[];
  observationKinds: readonly DealObservationKind[];
}

export interface DealflowAccess {
  capabilities: DealflowCapabilities;
  vocabulary: DealflowVocabulary;
}

export function dealflowAccess(projectId: string): DealflowAccess {
  const administers = decideProjectAccess(currentPrincipal(), projectId, 'ADMIN').allowed;
  return {
    capabilities: {
      mayAdminister: administers,
      because: administers
        ? null
        : 'Seeding a party, retiring one and recording an observation are decisions an ' +
          'administrator of this project makes. Reading everything below is not restricted.',
    },
    vocabulary: {
      partyKinds: DEAL_PARTY_KINDS,
      observationKinds: DEAL_OBSERVATION_KINDS,
    },
  };
}

/**
 * A party a person retired, kept and shown rather than hidden.
 *
 * ---------------------------------------------------------------------------
 * Why this lives beside access rather than beside the kernel view
 * ---------------------------------------------------------------------------
 *
 * `dealflowView` filters a retired party out of `buyers`/`suppliers` on
 * purpose: retiring one is a signal to the *allocator* — Brain stops asking
 * about it — and that filter is the kernel's own reading of the map it would
 * research next. It says nothing about whether the *operator surface* may
 * still show what was decided, which is exactly the question this module
 * already answers for every other control on this screen: a decision does
 * not make a row disappear, it changes what a reader is shown about it (§35).
 * So a retired party's continued visibility is composed here, alongside
 * `dealflowAccess`, and merged into the same response the identical way.
 *
 * `services/industry/view.ts` keeps a `retired` list inside its own view for
 * the identical reason — a person retiring a subject there does not stop that
 * subject being readable, only stops it being researched. The same fact is
 * shown here from outside the kernel view rather than inside it, because nothing about
 * an operator-surface reading needs the kernel's own derivation.
 */
export interface RetiredPartyView {
  id: string;
  name: string;
  country: string | null;
  equipmentClass: string;
  note: string | null;
  decisionMaker: string | null;
  /** The claim that established it, so every line resolves to a passage. */
  sourceClaimId: string | null;
  deals: number;
  retiredAt: string;
  retiredReason: string | null;
}

export interface DealflowRetired {
  retiredBuyers: RetiredPartyView[];
  retiredSuppliers: RetiredPartyView[];
}

function isRetired(party: DealParty): party is DealParty & { retiredAt: string } {
  return party.retiredAt !== null;
}

export async function retiredDealflowParties(projectId: string): Promise<DealflowRetired> {
  const [parties, deals] = await Promise.all([listParties(projectId), listDeals(projectId)]);
  const retired = parties.filter(isRetired);
  const toView = (party: DealParty & { retiredAt: string }): RetiredPartyView => ({
    id: party.id,
    name: party.name,
    country: party.country,
    equipmentClass: party.equipmentClass,
    note: party.note,
    decisionMaker: party.decisionMaker,
    sourceClaimId: party.sourceClaimId,
    deals: deals.filter((one) => one.buyerPartyId === party.id || one.supplierPartyId === party.id)
      .length,
    retiredAt: party.retiredAt,
    retiredReason: party.retiredReason,
  });
  return {
    retiredBuyers: retired.filter((one) => one.kind === 'BUYER').map(toView),
    retiredSuppliers: retired.filter((one) => one.kind === 'SUPPLIER').map(toView),
  };
}

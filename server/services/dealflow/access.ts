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
import { DEAL_OBSERVATION_KINDS, DEAL_PARTY_KINDS } from '../../domain/types.ts';
import type { DealObservationKind, DealPartyKind } from '../../domain/types.ts';

export interface DealflowCapabilities {
  /** Seed a party, retire one, or record an observation. Project `ADMIN`. */
  mayAdminister: boolean;
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
    capabilities: { mayAdminister: administers },
    vocabulary: {
      partyKinds: DEAL_PARTY_KINDS,
      observationKinds: DEAL_OBSERVATION_KINDS,
    },
  };
}

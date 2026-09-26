/**
 * What a control on the industry map screen may be *offered* for, decided by
 * the server.
 *
 * ---------------------------------------------------------------------------
 * Why this is not derived in the client
 * ---------------------------------------------------------------------------
 *
 * `services/labor/access.ts` makes the argument in full and it is the same
 * argument here. The browser holds one role flag — is this a Brain
 * administrator — and every decision on this screen is project `ADMIN`. So a
 * client deriving it would be wrong in both directions at once: it would hide
 * the controls from the project administrator entitled to press them, which is
 * §24's *waiting nobody can resolve*, and it would offer them on a project
 * where the level was the real question, because a Brain administrator reaches
 * every project by design.
 *
 * So the same `decideProjectAccess` every route applies answers it here too.
 * **There is no industry policy module and there must never be one** — the
 * route's own comment says so about authorization, and this is the same
 * sentence about the surface over it.
 *
 * ---------------------------------------------------------------------------
 * It is a convenience and never the control
 * ---------------------------------------------------------------------------
 *
 * Both of these are re-decided at the moment anything happens, by
 * `requirePerson`, `requireProject` and the policy module. A hidden button is
 * not authorization (§17) and this is not one. What it is for is §35's rule:
 * a control somebody may not use is **disabled with the server's reason**,
 * never removed — because a screen that removes it has a different shape per
 * reader, and *there is no button* and *the button is not for you* are answers
 * a person reads very differently.
 *
 * `because` is on the row for the same reason every verdict on the Machines
 * and Labor screens is: a sentence composed in the browser is a second reader
 * of a decision the server already made, and it will eventually say something
 * the server did not.
 */
import { decideProjectAccess } from '../identity/policy.ts';
import { currentPrincipal } from '../identity/context.ts';
import { INDUSTRY_NODE_KINDS } from '../../domain/types.ts';
import type { IndustryNodeKind } from '../../domain/types.ts';

export interface IndustryCapabilities {
  /** Name a subject. Project `ADMIN`. */
  maySeed: boolean;
  /** Retire one. Project `ADMIN`. */
  mayRetire: boolean;
  /** Why not, in the server's own words, or null where there is nothing to say. */
  because: string | null;
}

export function industryCapabilities(projectId: string): IndustryCapabilities {
  const administers = decideProjectAccess(currentPrincipal(), projectId, 'ADMIN').allowed;
  return {
    maySeed: administers,
    mayRetire: administers,
    because: administers
      ? null
      : 'Naming a subject and retiring one are decisions an administrator of this project ' +
        'makes. You can read the whole map.',
  };
}

/**
 * The closed set a form on this screen may offer, sent with the reading.
 *
 * Travelling down with the view rather than being duplicated in the client,
 * for §24's reason: the contract a person is shown and the contract the
 * validator enforces are then **one object**. The route refuses a kind
 * outside `INDUSTRY_NODE_KINDS` by name, and a browser holding its own copy
 * would eventually offer a value the server had removed — a refusal the
 * person could not have predicted, which §35 records as the thing that
 * teaches somebody a refusal is arbitrary.
 */
export interface IndustryVocabulary {
  industryNodeKinds: readonly IndustryNodeKind[];
}

export function industryVocabulary(): IndustryVocabulary {
  return { industryNodeKinds: INDUSTRY_NODE_KINDS };
}

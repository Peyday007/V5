/**
 * What a control on the Labor screen may be *offered* for, decided by the
 * server.
 *
 * ---------------------------------------------------------------------------
 * Why this is not derived in the client
 * ---------------------------------------------------------------------------
 *
 * `services/cash/access.ts` makes the argument in full and it is the same
 * argument here. The browser holds one role flag — is this a Brain
 * administrator — and every decision on this screen is project `ADMIN`. So a
 * client deriving it would be wrong in both directions at once: it would hide
 * the controls from the project administrator entitled to press them, which is
 * §24's *waiting nobody can resolve*, and it would offer them on a project
 * where the level was the real question, because a Brain administrator reaches
 * every project by design.
 *
 * So the same `decideProjectAccess` every route applies answers it here too.
 * **There is no labor policy module and there must never be one** — the route's
 * own comment says so about authorization, and this is the same sentence about
 * the surface over it.
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
 * screen is: a sentence composed in the browser is a second reader of a
 * decision the server already made, and it will eventually say something the
 * server did not.
 */
import { decideProjectAccess } from '../identity/policy.ts';
import { currentPrincipal } from '../identity/context.ts';
import { layerIsHuman } from '../../domain/labor.ts';
import { HUMAN_NECESSITY_REASONS, PRODUCTION_LAYERS } from '../../domain/types.ts';
import type { HumanNecessityReason, ProductionLayer } from '../../domain/types.ts';

export interface LaborCapabilities {
  /** Name a workflow or a task, and retire one. Project `ADMIN`. */
  mayShapeTheMap: boolean;
  /** Record who produces a task. Project `ADMIN`. */
  mayRecordWhoProduces: boolean;
  /** Why not, in the server's own words, or null where there is nothing to say. */
  because: string | null;
}

export function laborCapabilities(projectId: string): LaborCapabilities {
  const administers = decideProjectAccess(currentPrincipal(), projectId, 'ADMIN').allowed;
  return {
    mayShapeTheMap: administers,
    mayRecordWhoProduces: administers,
    because: administers
      ? null
      : 'Naming a workflow and recording who produces a task are decisions an administrator of ' +
        'this project makes. You can read the whole map.',
  };
}

/**
 * The closed sets a form on this screen may offer, sent with the reading.
 *
 * Travelling down with the view rather than being duplicated in the client, for
 * §24's reason: the contract a person is shown and the contract the validator
 * enforces are then **one object**. The route refuses a layer outside
 * `PRODUCTION_LAYERS` and a reason outside `HUMAN_NECESSITY_REASONS` by name,
 * and a browser holding its own copy of either would eventually offer a value
 * the server had removed — a refusal the person could not have predicted, which
 * §35 records as the thing that teaches somebody a refusal is arbitrary.
 *
 * `humanLayers` is here for the same reason and is the one a screen most needs:
 * the schema's own CHECK refuses a human layer with no necessity reason, so the
 * form has to know which layers those are. Deriving it in the browser from the
 * layer's *name* is exactly the guess this kernel exists to stop — a layer added
 * later that happens not to read like a person would silently lose its reason.
 */
export interface LaborVocabulary {
  productionLayers: readonly ProductionLayer[];
  /** The subset of the above that is a person, so the form demands a reason. */
  humanLayers: readonly ProductionLayer[];
  humanReasons: readonly HumanNecessityReason[];
}

export function laborVocabulary(): LaborVocabulary {
  return {
    productionLayers: PRODUCTION_LAYERS,
    humanLayers: PRODUCTION_LAYERS.filter((layer) => layerIsHuman(layer)),
    humanReasons: HUMAN_NECESSITY_REASONS,
  };
}

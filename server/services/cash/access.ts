/**
 * Who may read the shared frontier, and where privacy actually begins.
 *
 * ---------------------------------------------------------------------------
 * The defect this file exists for
 * ---------------------------------------------------------------------------
 *
 * An ordinary enrolled member opening `/cash` was told:
 *
 *     There is nothing here for you to see. That is the same answer a project
 *     that does not exist gives, on purpose.
 *
 * That sentence is correct about what the server said and wrong about what it
 * should have said. `GET /api/projects/:id/cash` resolved through
 * `requireProject`, which is `decideProjectAccess(principal, projectId, 'READ')`;
 * the shared root is a *project*, and a member who had joined the Brain held no
 * membership row on it, so `NOT_A_MEMBER` became the same 404 a missing project
 * gives — invariant 23 behaving exactly as designed, at a door where absent and
 * forbidden are not what is being distinguished.
 *
 * The owner saw the frontier because a Brain administrator reaches every
 * project by design. So the failure was invisible from the only screen anybody
 * was looking at, which is the shape of defect that survives longest.
 *
 * ---------------------------------------------------------------------------
 * Where the boundary actually is
 * ---------------------------------------------------------------------------
 *
 * `services/cash/root.ts` already says it in its own opening paragraph:
 * **discovery is one shared frontier, and separation begins when a validated
 * opportunity becomes an execution job**, because that is the first moment
 * there is anything private to separate — an owner, a budget, a credential, a
 * decision. Before that there is only evidence, and evidence about the world is
 * not anybody's private state. §31 settled the identical question one boundary
 * out: a validated finding belongs to the Brain.
 *
 * The project membership implemented the *opposite* boundary: it made
 * discovery private and left execution wherever the project happened to put it.
 * This module is the seam that puts it back, and it does so in three lines of
 * decision rather than by special-casing a page:
 *
 *   1. The subject is the **server-resolved** root — `findCashRoot()` — and
 *      never a project id a caller chose. A caller who could nominate the
 *      project this rule applies to would be choosing which project to be
 *      granted a shared read of.
 *   2. A **genuine authenticated person** may read it. `requirePerson` already
 *      resolves that from server rows: a worker is refused by type, an
 *      anonymous caller has no principal, an invalid session resolves to none,
 *      and a revoked or disabled account fails authentication before it gets
 *      here. Nothing the caller sent about itself contributes.
 *   3. Everything else — any other project, any other level, every write —
 *      goes through `decideProjectAccess` exactly as before, with the same 404
 *      and the same body.
 *
 * ---------------------------------------------------------------------------
 * What it does not do
 * ---------------------------------------------------------------------------
 *
 * It does not make any Cash route public, and it grants no write of any kind.
 * `FULL` is still `decideProjectAccess` and nothing else; `SHARED` is a
 * strictly smaller payload built by `services/cash/shared.ts`, which is the
 * half that makes this safe — a read boundary that widened who may read while
 * leaving the payload alone would be publishing one person's ledger to the
 * team.
 *
 * There is **no cash policy module and there must never be one.** This is not
 * one: it decides nothing about roles, scopes or projects. It answers one
 * question — *is this the shared frontier, and is this a person* — and defers
 * everything else, including every refusal, to
 * `services/identity/policy.ts`.
 */
import { currentPrincipal } from '../identity/context.ts';
import { decideProjectAccess } from '../identity/policy.ts';
import { findCashRoot } from './root.ts';

/**
 * How much of the sprint this caller may be handed.
 *
 * `FULL` is the owner's view: money, the grant, the decisions, the private
 * execution state. `SHARED` is the frontier every member of this Brain is
 * entitled to. `NONE` is the refusal, and the caller is never told which of the
 * two reasons produced it.
 */
export type CashReadScope = 'FULL' | 'SHARED' | 'NONE';

export interface CashReadDecision {
  scope: CashReadScope;
  /** The resolved shared root, when there is one. Never caller-supplied. */
  rootProjectId: string | null;
}

/**
 * May the current principal read this project's Cash section, and how much?
 *
 * Asked of the project id the route was addressed with, so a member who guesses
 * another project's id is answered about *that* project — by
 * `decideProjectAccess`, unchanged — rather than being handed the frontier
 * because they asked about something.
 */
export async function decideCashRead(projectId: string): Promise<CashReadDecision> {
  const principal = currentPrincipal();
  const root = await findCashRoot();
  const rootProjectId = root?.id ?? null;

  /*
   * The full view first, so nothing about this widens: a caller who already
   * reached the project keeps exactly the view they had, by the identical
   * decision, before any of the reasoning above is consulted.
   */
  if (decideProjectAccess(principal, projectId, 'READ').allowed) {
    return { scope: 'FULL', rootProjectId };
  }

  /*
   * A person, and the shared root.
   *
   * `HUMAN` is the whole of the membership test, and deliberately so: there is
   * no `users` row without an account somebody created, no session without a
   * credential Brain issued, and `authenticate.ts` resolves neither for a
   * disabled account. So "an enrolled member of this Brain" is a fact the
   * principal's own type already carries, and re-deriving it from a second
   * table here would be a second answer to one question.
   *
   * A worker is refused by type. §22's rule at a read: no membership
   * configuration turns a machine into a person, and a research worker holding
   * `project:read` on the root must not thereby be handed the portfolio.
   */
  if (
    principal !== null &&
    principal.type === 'HUMAN' &&
    rootProjectId !== null &&
    projectId === rootProjectId
  ) {
    return { scope: 'SHARED', rootProjectId };
  }

  return { scope: 'NONE', rootProjectId };
}

/**
 * What a control on the Cash page may be *offered* for, decided by the server.
 *
 * ---------------------------------------------------------------------------
 * Why this is not derived in the client
 * ---------------------------------------------------------------------------
 *
 * The obvious client-side answer is "is this a Brain administrator", because
 * that is the one role flag the browser holds. It is the wrong answer twice
 * over, in opposite directions. Activating a sprint, moving its lifecycle and
 * granting commercial authority are all **project `ADMIN`** — so a project
 * administrator who is not a Brain administrator would have had those controls
 * hidden from them although every route would have accepted the call, and an
 * escalation with no visible remedy is §24's *waiting nobody can resolve*. And
 * a Brain administrator reaches every project by design, so the flag would
 * equally have offered controls on a project where the level was the real
 * question.
 *
 * So the same `decideProjectAccess` every route applies answers it here too.
 * There is no Cash capability module and there must never be one.
 *
 * ---------------------------------------------------------------------------
 * It is a convenience and never the control
 * ---------------------------------------------------------------------------
 *
 * Every one of these four is re-decided at the moment anything happens, by
 * `requirePerson`, `requireProject`, `checkCommercialAuthority` and the policy
 * module. A hidden button is not authorization (§17) and this is not one. What
 * it is for is that a control which cannot succeed should not be offered: a
 * refusal somebody could not have predicted teaches them the refusal is
 * arbitrary.
 */
export interface CashCapabilities {
  /** Start, wind down, reactivate or archive the sprint. Project `ADMIN`. */
  mayAdminister: boolean;
  /** Make or withdraw the commercial grant. Project `ADMIN`. */
  mayGrantAuthority: boolean;
  /** Money, commercial terms, engine cards, the decisions review. */
  mayViewPrivateJob: boolean;
  /** Record an action, mark a piece ready, answer a decision. */
  mayActOnJob: boolean;
}

export function cashCapabilities(input: {
  scope: CashReadScope;
  projectId: string;
}): CashCapabilities {
  /*
   * A SHARED reader has no private blocks in their payload at all, so every
   * one of these is false whatever their membership says — there is nothing
   * present for a control to act on, which is the boundary rather than this
   * function's opinion of it.
   */
  if (input.scope !== 'FULL') {
    return {
      mayAdminister: false,
      mayGrantAuthority: false,
      mayViewPrivateJob: false,
      mayActOnJob: false,
    };
  }
  const administers = decideProjectAccess(currentPrincipal(), input.projectId, 'ADMIN').allowed;
  return {
    mayAdminister: administers,
    mayGrantAuthority: administers,
    mayViewPrivateJob: true,
    mayActOnJob: true,
  };
}

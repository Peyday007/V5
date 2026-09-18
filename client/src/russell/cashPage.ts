/**
 * One Cash page, two roles: the view model both of them render from.
 *
 * ---------------------------------------------------------------------------
 * What was wrong
 * ---------------------------------------------------------------------------
 *
 * `Cash.tsx` used to answer a member with an early `return <SharedFrontier/>`,
 * which was a **second page**: nine sections against five, no heading in
 * common, and not one section identifier in common — every member card was a
 * bare `.rs-card` with no `rs-cash-*` class at all, so nothing on the member
 * page was even addressable by the name the owner's page used for the same
 * subject.
 *
 * The privacy boundary was right and is untouched. The layout divergence was
 * not: two people looking at one Brain saw two products, and a section that
 * moved on one page and not the other was invisible to anybody checking only
 * the page they had.
 *
 * ---------------------------------------------------------------------------
 * The shape of the correction
 * ---------------------------------------------------------------------------
 *
 * There is **one** skeleton — the owner's, unchanged in order and in name —
 * and the role decides what is *inside* a section, never which sections exist.
 * That is the whole rule, and it is the same one §29 already applies to a
 * status line: a screen whose structure depends on who is looking is a screen
 * whose defects are only visible to half the people who could report them.
 *
 * Every shared section reads `page.frontier`, which is **the same object the
 * server builds for a member**, embedded in the owner's payload by
 * `cashView`. Not a client reconciliation of two shapes: one function, one
 * derivation, both roles. Two readers of one fact disagree eventually.
 *
 * ---------------------------------------------------------------------------
 * The capabilities are the server's, and are a convenience even so
 * ---------------------------------------------------------------------------
 *
 * All four come from `services/cash/access.ts`, decided by the same
 * `decideProjectAccess` every Cash route applies. **They are deliberately not
 * derived here**: the browser holds only a Brain-administrator flag, and
 * activating a sprint, moving its lifecycle and granting commercial authority
 * are all project `ADMIN` — so a client deriving them would have hidden a
 * lifecycle control from the project administrator entitled to press it, which
 * is §24's *waiting nobody can resolve* wearing a permission.
 *
 * And they are still only a convenience. Every one is re-decided server-side at
 * the moment anything happens. A hidden button is not authorization (§17), and
 * nothing here may be read as one; what it is for is that a control which
 * cannot succeed should not be offered, because a refusal somebody could not
 * have predicted teaches them the refusal is arbitrary.
 *
 * The private blocks are absent from a member's response, so there is no
 * arrangement of this page that could render one and no hidden client data to
 * find in the bundle — that, and not a flag, is the boundary.
 */
import type {
  CashCapabilities,
  CashModeState,
  CashView,
  CashViewReading,
  SharedCashView,
} from '../lib/cashApi.ts';

export type SharedFrontierView = Omit<SharedCashView, 'scope' | 'capabilities'>;
export type { CashCapabilities };

/**
 * What a payload with no `capabilities` on it may be offered: nothing.
 *
 * Fail closed. An older server, a truncated response or a shape this client did
 * not expect must not become a page full of controls; deny-by-default is the
 * same rule every route already applies, and the cost of getting it wrong in
 * this direction is a control somebody has to reload to see.
 */
const NOTHING: CashCapabilities = {
  mayAdminister: false,
  mayGrantAuthority: false,
  mayViewPrivateJob: false,
  mayActOnJob: false,
};

export interface CashPage {
  capabilities: CashCapabilities;
  /** The shared frontier, identical for both roles because it is one object. */
  frontier: SharedFrontierView;
  /**
   * The owner's private blocks, or null.
   *
   * Null is the *absence of the data*, not a flag over data that is present:
   * when the server answered `SHARED` there is nothing here to hide.
   */
  full: CashView | null;
}

export function cashPage(input: { reading: CashViewReading }): CashPage {
  const reading = input.reading;
  const full = reading.scope === 'FULL' ? reading : null;
  /*
   * A FULL reading carries the frontier the server built for it; a SHARED one
   * *is* that frontier. Either way the object below was produced by
   * `sharedFrontier`, so the shared sections cannot render two different
   * answers about one sprint.
   */
  const frontier: SharedFrontierView =
    reading.scope === 'FULL' ? reading.frontier : reading;

  return { capabilities: reading.capabilities ?? NOTHING, frontier, full };
}

/** The sprint's state, from whichever half of the payload carries it. */
export function modeState(page: CashPage): CashModeState | null {
  return (page.full?.mode?.state ?? page.frontier.mode?.state ?? null) as CashModeState | null;
}

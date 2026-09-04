/**
 * What a screen says, decided without a screen.
 *
 * Every view in the shell has the same five states and gets them wrong in the
 * same five ways, so the decisions live here as pure functions and the
 * components render what they return. That is not tidiness for its own sake:
 * it makes "an empty list and a forbidden project must not look the same" a
 * thing a test asserts directly, rather than something a person has to notice
 * in a browser.
 *
 * The rules these encode, all of which the assignment asks for by name:
 *
 *   - **Loading is not empty.** A view that has not answered yet says so.
 *   - **Forbidden is not empty.** A project a person may not read says that,
 *     and does not imply the work does not exist.
 *   - **Stale is not current.** A reading Russell could not refresh is labelled
 *     with when it was true, never presented as now.
 *   - **Nothing is optimistic.** There is no "saved!" that precedes the save.
 */

export type Phase = 'LOADING' | 'READY' | 'EMPTY' | 'FORBIDDEN' | 'ERROR';

export interface ViewState<T> {
  phase: Phase;
  items: T[];
  /** One sentence a person reads. Always present, including when ready. */
  message: string;
  /** True when the caller should offer a retry. */
  retryable: boolean;
}

export interface AsyncInput<T> {
  loading: boolean;
  error: { status: number; message: string } | null;
  items: T[] | null;
  /** What this screen is about, for the empty sentence. E.g. "work". */
  noun: string;
}

/**
 * The state of one list-shaped view.
 *
 * A 404 from a project-scoped route is `FORBIDDEN` here even though the server
 * said "not found" — deliberately. The server must not distinguish absent from
 * forbidden, and the interface must not pretend to know which it was: it says
 * the honest thing, which is that this is not something you can see, without
 * claiming the work does or does not exist.
 */
export function listState<T>(input: AsyncInput<T>): ViewState<T> {
  if (input.loading) {
    return { phase: 'LOADING', items: [], message: `Loading ${input.noun}…`, retryable: false };
  }
  if (input.error) {
    if (input.error.status === 401) {
      return {
        phase: 'FORBIDDEN',
        items: [],
        message: 'You are signed out. Sign in again to carry on.',
        retryable: false,
      };
    }
    if (input.error.status === 404 || input.error.status === 403) {
      return {
        phase: 'FORBIDDEN',
        items: [],
        // Not "there is none". Saying that would turn the server's deliberate
        // ambiguity into a claim the interface has no basis for.
        message: `This is not something you can open. Ask whoever runs this Brain for access to see the ${input.noun}.`,
        retryable: false,
      };
    }
    return {
      phase: 'ERROR',
      items: [],
      message: `Could not load the ${input.noun}. ${input.error.message}`,
      retryable: true,
    };
  }
  const items = input.items ?? [];
  if (items.length === 0) {
    return { phase: 'EMPTY', items: [], message: `There is no ${input.noun} yet.`, retryable: false };
  }
  return { phase: 'READY', items, message: '', retryable: false };
}

/**
 * The state of a view that reads one thing rather than a list.
 *
 * Separate from `listState` because "empty" is not a state it has: a reading
 * always exists, even when what it says is that nothing could be read. Forcing
 * it through the list machine meant handing that machine a fake one-element
 * array, which is the kind of small lie that later reads as a real one.
 */
export function readingState<T>(input: Omit<AsyncInput<T>, 'items'> & { value: T | null }): ViewState<T> {
  const asList = listState<T>({ ...input, items: input.value === null ? null : [input.value] });
  return asList.phase === 'EMPTY'
    ? { phase: 'READY', items: [], message: '', retryable: false }
    : asList;
}

/**
 * How a reading should be labelled, given when it was taken.
 *
 * A stale reading is shown with its age rather than hidden, because hiding it
 * leaves a person looking at an empty screen with no idea whether that means
 * "nothing is happening" or "we lost contact". `UNAVAILABLE` is the one case
 * where there is genuinely nothing to show.
 */
export function freshnessLabel(input: {
  freshness: 'CURRENT' | 'STALE' | 'UNAVAILABLE';
  asOf: string | null;
  now?: number;
}): string {
  if (input.freshness === 'UNAVAILABLE') return 'Russell cannot read this right now.';
  if (input.freshness === 'CURRENT') return 'Up to date.';
  if (!input.asOf) return 'This is an older reading; Russell could not refresh it.';
  const minutes = Math.max(1, Math.round(((input.now ?? Date.now()) - Date.parse(input.asOf)) / 60_000));
  return minutes < 60
    ? `This is how it looked ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago; Russell could not refresh it.`
    : `This is an older reading; Russell could not refresh it.`;
}

/**
 * What a person's own message looks like while the fleet is answering.
 *
 * The pending reason comes from the server, so the interface never invents one.
 * A turn that failed says so plainly instead of leaving a spinner turning — a
 * spinner that never ends is not waiting, it is stuck.
 */
export function turnLabel(status: string, pendingReason: string | null): string | null {
  if (status === 'PENDING') return pendingReason ?? 'Russell is thinking.';
  if (status === 'FAILED') return 'Russell could not answer that one.';
  return null;
}

/** Phone-width layouts collapse the navigation; desktop shows it beside. */
export const PHONE_MAX_WIDTH = 720;

export function navigationMode(viewportWidth: number): 'RAIL' | 'BAR' {
  return viewportWidth <= PHONE_MAX_WIDTH ? 'BAR' : 'RAIL';
}

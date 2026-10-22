/**
 * Readable routes to the channels a cash campaign reads most, for a worker
 * whose first route failed.
 *
 * Fast Cash's first round stopped on four channels, and each fragment named
 * why: SAM.gov needed "an api.sam.gov key or renderer", and PublicSurplus read
 * as empty to a page fetcher. The guidance block already named the hosts a
 * surface could not read and told the worker to find another route. It never
 * said which route.
 *
 * Each entry here is a public, unauthenticated address that the platform itself
 * serves. Each was read successfully on 2026-10-18, and each lists the fields
 * that answer the lanes cash research asks for. None needs a key, an account or
 * a payment, so none widens what an envelope allows: they are the same
 * publisher's own pages and the same source class the assignment already
 * authorizes, reached by a form a fetcher can read.
 *
 * This is context and never a control. Nothing reads it except the guidance
 * text. Adding a channel is a reviewed code change, verified against the live
 * endpoint first; a route that stops answering is removed, never guessed at.
 */

export interface ReadableRoute {
  /** The host as a worker would meet it, and the names a question may use for it. */
  host: string;
  names: readonly string[];
  /** Other hosts that are the same publisher, such as a country domain. */
  aliases?: RegExp;
  /** One line per address: what to open, and what in it answers which lane. */
  lines: readonly string[];
}

export const READABLE_ROUTES: readonly ReadableRoute[] = Object.freeze([
  {
    host: 'sam.gov',
    names: ['sam.gov'],
    lines: [
      'search active notices, no key needed: https://sam.gov/api/prod/sgs/v1/search/?index=opp&page=0&size=25&sort=-modifiedDate&mode=search&is_active=true&q=<words> — ' +
        'each result has _id, title, publishDate, responseDate (the deadline), type.value and organizationHierarchy',
      'one notice: https://sam.gov/api/prod/opps/v2/opportunities/<_id> (set-aside, NAICS, deadlines); ' +
        'its canonical page is https://sam.gov/opp/<_id>/view',
    ],
  },
  {
    host: 'publicsurplus.com',
    names: ['publicsurplus.com', 'publicsurplus'],
    lines: [
      'an auction page https://www.publicsurplus.com/sms/all,<state>/auction/view?auc=<auction id> is ' +
        'server-rendered: "Current Price", "Increment", "Minimum bid", "Time Left" and "Auction Ends" are ' +
        'plain text, with the selling agency named beside them',
    ],
  },
]);

function mentions(text: string, name: string): boolean {
  // Bounded, so "sam.gov" does not match inside "usam.gov" and a channel is
  // named only by its own name, never by an ordinary word inside a longer one.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(text);
}

/**
 * The routes this assignment should be told about. A route is included when
 * the question names the channel, or when this surface recently failed to read
 * the channel's host. `question` carries the fragment's question and the
 * packet's title, because a fragment often asks about "this opening" and only
 * the title names where it is. Pure.
 */
export function routesFor(input: {
  question: string | null;
  unreachableHosts: readonly string[];
}): ReadableRoute[] {
  const question = input.question ?? '';
  return READABLE_ROUTES.filter(
    (route) =>
      route.names.some((name) => mentions(question, name)) ||
      input.unreachableHosts.some(
        (host) => host === route.host || host.endsWith(`.${route.host}`) || (route.aliases?.test(host) ?? false),
      ),
  );
}

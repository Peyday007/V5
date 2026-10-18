/**
 * Readable routes to the channels a cash campaign reads most, for a worker
 * whose first route failed.
 *
 * Fast Cash's first round stopped on four channels, and each fragment named
 * why: Freelancer pages were "JS-only" or the posting date was "a cached
 * render"; SAM.gov needed "an api.sam.gov key or renderer"; PublicSurplus and
 * PeoplePerHour read as empty to a page fetcher. The guidance block already
 * named the hosts a surface could not read and told the worker to find another
 * route. It never said which route. Some workers found the Freelancer API on
 * their own and others did not.
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
    host: 'freelancer.com',
    names: ['freelancer.com'],
    // Its country sites (freelancer.co.uk, .ca, .cn, .in …) serve the same
    // projects, and are where surfaces have failed with JS_ONLY.
    aliases: /^(www\.)?freelancer\.(co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/,
    lines: [
      'search open projects: https://www.freelancer.com/api/projects/0.1/projects/active/?query=<words>&limit=20&full_description=true',
      'one project: https://www.freelancer.com/api/projects/0.1/projects/<project id>/?full_description=true — ' +
        'status and frontend_project_status say whether it is open (closed or awarded is demand_closed); ' +
        'time_submitted is the posting time in epoch seconds; budget.minimum/maximum with currency.code ' +
        'and type (fixed or hourly) are the economics; bid_stats.bid_count and bid_avg are the competition',
      'the listing page https://www.freelancer.com/projects/<seo_url> is server-rendered: "About the client" ' +
        'gives location, rating and member-since; in "Client Verification" an icon whose span carries ' +
        'data-color="success" is achieved (Payment verified, Deposit made, Email, Phone, Profile)',
    ],
  },
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
  // named only by its own name, never by an ordinary word like "freelancer".
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

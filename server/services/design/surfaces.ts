/**
 * What the design kernel can look at, and what each screen is about.
 *
 * ---------------------------------------------------------------------------
 * A registry rather than a renderer full of addresses
 * ---------------------------------------------------------------------------
 *
 * `scripts/visual-qa.ts` knows seven addresses, in a constant, inside the
 * harness that photographs them — which is fine for a harness and wrong for a
 * kernel: a surface registered next month would need a deployment, and nothing
 * outside that file could answer *what can Brain look at*. So the surfaces are
 * rows (`fleet_routines`' argument), seeded from the constant below on every
 * boot, and an operator may add to the table without touching this file.
 *
 * ---------------------------------------------------------------------------
 * What a surface declares, and why each field is not optional
 * ---------------------------------------------------------------------------
 *
 * `concepts` and `actions` are what make design work here *about this product*
 * rather than about interfaces in general. A kernel that knew only the route
 * would be reduced to style rules — "the primary button is blue" — because it
 * would have nothing to reason from. With them it can ask the questions that
 * actually decide a layout: what is this screen representing, what can a person
 * do, which of those is the thing the screen exists for, how often, and what
 * does it cost them to have done it.
 *
 * They are **declared and never inferred**. A kernel that read a route and
 * guessed the domain would hallucinate a product, which is §25's Westbrook
 * defect at a screen: every row around it healthy, the wrong answer confidently
 * derived, and nothing downstream able to catch it because the thing that was
 * wrong was the premise. Adding a surface therefore means saying what it is
 * about, and that is the cost of the guarantee.
 *
 * `viewports` is per surface for the reason §29 measured: the rejected build
 * clipped between 822 and 953 pixels, which is neither a desktop nor a phone. A
 * band matters because of what a *layout* does at it — a rail, a main column and
 * a detail column ceasing to fit side by side — so the widths belong to the
 * surface rather than to a global list.
 *
 * ---------------------------------------------------------------------------
 * The seed is bounded on purpose
 * ---------------------------------------------------------------------------
 *
 * Eight surfaces across six screens, not forty. §16's separation applies: a
 * registry passing its tests says nothing about whether a real render of a real
 * screen produced anything useful, and the way to find that out is to run a few
 * properly rather than to declare many.
 */
import {
  listSurfaces as listSurfaceRows,
  registerSurface,
  type RegisterSurfaceInput,
} from '../../repos/design.ts';
import type { DesignSurface } from '../../domain/design.ts';

/**
 * The three widths every Brain surface is judged at.
 *
 * A default rather than a rule: a surface may declare its own, and one with a
 * band of its own should. The middle number is the one that earned its place.
 */
export const DEFAULT_VIEWPORTS = [
  { name: 'desktop', width: 1180, height: 900 },
  { name: 'intermediate', width: 953, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

type SeedSurface = Omit<RegisterSurfaceInput, 'registeredBy'>;

/**
 * The seed set.
 *
 * Every entry here is a real address in `client/src/lib/router.ts` and a real
 * state the product can be in without anything being faked. The one thing that
 * is *not* declared is a state only a fixture could produce: a screenshot of a
 * fixture is a screenshot of a fixture, and a design finding about one is a
 * finding about something nobody uses.
 */
export const SEED_SURFACES: SeedSurface[] = [
  {
    surfaceKey: 'russell/default',
    screen: 'russell',
    stateKey: 'default',
    title: 'Russell — the conversation and the command centre',
    route: '/',
    preconditions: ['SIGNED_IN'],
    concepts: ['conversation', 'project', 'mission', 'candidate', 'briefing', 'collection'],
    actions: [
      { name: 'Say something to Russell', frequency: 'CONSTANT', reversibility: 'FREE', primary: true },
      { name: 'Open a collection', frequency: 'REGULAR', reversibility: 'FREE', primary: false },
      { name: 'Change reading depth', frequency: 'OCCASIONAL', reversibility: 'FREE', primary: false },
      { name: 'Sign out', frequency: 'RARE', reversibility: 'RECOVERABLE', primary: false },
    ],
    viewports: DEFAULT_VIEWPORTS,
    faculty: 'RUSSELL',
  },
  {
    surfaceKey: 'needs-you/empty',
    screen: 'needs-you',
    stateKey: 'empty',
    title: 'Needs you — nothing outstanding',
    route: '/needs-you',
    preconditions: ['SIGNED_IN', 'STANDING_AUTHORITY_GRANTED'],
    concepts: ['decision', 'standing authority', 'human request', 'mission'],
    actions: [
      { name: 'Read what continues without you', frequency: 'REGULAR', reversibility: 'FREE', primary: true },
      { name: 'Withdraw the standing authority', frequency: 'RARE', reversibility: 'RECOVERABLE', primary: false },
    ],
    viewports: DEFAULT_VIEWPORTS,
    faculty: 'RUSSELL',
  },
  {
    /*
     * The same address with a decision on it, and the pair is the whole reason
     * a surface is a screen *plus a state*. §29 records this exact screen
     * saying "nothing needs your decision" directly above the one approval
     * nothing could proceed without — a defect that exists only in one of these
     * two states and is invisible from the other.
     */
    surfaceKey: 'needs-you/populated',
    screen: 'needs-you',
    stateKey: 'populated',
    title: 'Needs you — a decision outstanding',
    route: '/needs-you',
    preconditions: ['SIGNED_IN', 'DECISION_OUTSTANDING'],
    concepts: ['decision', 'standing authority', 'approval', 'reach', 'expiry'],
    actions: [
      { name: 'Approve the standing authority', frequency: 'RARE', reversibility: 'COSTLY', primary: true },
      { name: 'Change the details first', frequency: 'RARE', reversibility: 'FREE', primary: false },
    ],
    viewports: DEFAULT_VIEWPORTS,
    faculty: 'RUSSELL',
  },
  {
    surfaceKey: 'work/default',
    screen: 'work',
    stateKey: 'default',
    title: 'Work — what is running and what it produced',
    route: '/work',
    preconditions: ['SIGNED_IN'],
    concepts: ['mission', 'packet', 'fragment', 'claim', 'audit', 'document'],
    actions: [
      { name: 'Read what a mission is doing', frequency: 'REGULAR', reversibility: 'FREE', primary: true },
      { name: 'Open a filed report', frequency: 'OCCASIONAL', reversibility: 'FREE', primary: false },
    ],
    viewports: DEFAULT_VIEWPORTS,
    faculty: 'RESEARCH',
  },
  {
    surfaceKey: 'projects/default',
    screen: 'projects',
    stateKey: 'default',
    title: 'Ideas — the project constellation',
    route: '/projects',
    preconditions: ['SIGNED_IN', 'PROJECT_EXISTS'],
    concepts: ['project', 'layer', 'candidate', 'idea', 'frontier'],
    actions: [
      { name: 'Open a project', frequency: 'REGULAR', reversibility: 'FREE', primary: true },
      { name: 'Open an idea', frequency: 'REGULAR', reversibility: 'FREE', primary: false },
    ],
    viewports: DEFAULT_VIEWPORTS,
    faculty: 'RUSSELL',
  },
  {
    surfaceKey: 'fleet/default',
    screen: 'fleet',
    stateKey: 'default',
    title: 'Who — people, capacity and the surfaces Brain fires',
    route: '/fleet',
    preconditions: ['SIGNED_IN'],
    concepts: ['worker', 'routine', 'account', 'member', 'capacity', 'quarantine'],
    actions: [
      { name: 'Read what can run', frequency: 'OCCASIONAL', reversibility: 'FREE', primary: true },
      { name: 'Connect a Claude account', frequency: 'RARE', reversibility: 'RECOVERABLE', primary: false },
    ],
    viewports: DEFAULT_VIEWPORTS,
    faculty: 'FLEET',
  },
  {
    surfaceKey: 'build/default',
    screen: 'build',
    stateKey: 'default',
    title: 'Build — a software objective and the two decisions a person makes',
    route: '/build',
    preconditions: ['SIGNED_IN'],
    concepts: ['change request', 'repository', 'mutation scope', 'campaign', 'unit', 'review'],
    actions: [
      /*
       * Authorizing is IRREVERSIBLE in the sense that decides emphasis: it
       * starts a campaign that writes commits under somebody's name. §27
       * reserves it to a person, and the interface has to make that weight
       * visible rather than make it convenient.
       */
      { name: 'Authorize a change request', frequency: 'RARE', reversibility: 'IRREVERSIBLE', primary: true },
      { name: 'Choose the repository boundary', frequency: 'RARE', reversibility: 'COSTLY', primary: false },
      { name: 'Read a campaign', frequency: 'OCCASIONAL', reversibility: 'FREE', primary: false },
    ],
    viewports: DEFAULT_VIEWPORTS,
    faculty: 'FACTORY',
  },
  {
    surfaceKey: 'knowledge/default',
    screen: 'knowledge',
    stateKey: 'default',
    title: 'Knows — what the project has established',
    route: '/knowledge',
    preconditions: ['SIGNED_IN'],
    concepts: ['knowledge', 'claim', 'source', 'layer', 'conclusion'],
    actions: [
      { name: 'Read a conclusion', frequency: 'REGULAR', reversibility: 'FREE', primary: true },
      { name: 'Follow a citation to its passage', frequency: 'OCCASIONAL', reversibility: 'FREE', primary: false },
    ],
    viewports: DEFAULT_VIEWPORTS,
    faculty: 'RESEARCH',
  },
];

/**
 * Write the seed into the table.
 *
 * Idempotent by `surface_key`, and it never un-retires: a surface somebody took
 * out stays out across a redeploy, because a boot that quietly restored a
 * decision a person made would be the second way to get it wrong that §26
 * deleted a whole console over.
 */
export async function seedDesignSurfaces(
  registeredBy = 'SEED',
): Promise<{ created: string[]; updated: string[] }> {
  const created: string[] = [];
  const updated: string[] = [];
  for (const seed of SEED_SURFACES) {
    const result = await registerSurface({ ...seed, registeredBy });
    (result.created ? created : updated).push(seed.surfaceKey);
  }
  return { created, updated };
}

/** Every live surface, newest registration rules applied. */
export async function liveSurfaces(): Promise<DesignSurface[]> {
  return listSurfaceRows();
}

/**
 * The surfaces a set of keys resolves to, reporting the ones that did not.
 *
 * The second half is the point: a cycle asked to look at a surface that is not
 * registered must say so rather than silently looking at fewer screens, which
 * is the same rule `retrieveEvidence` follows when it reports the documents it
 * could not read (§10).
 */
export async function resolveSurfaces(
  keys: readonly string[],
): Promise<{ surfaces: DesignSurface[]; unknown: string[] }> {
  const live = await listSurfaceRows();
  const byKey = new Map(live.map((one) => [one.surfaceKey, one]));
  const surfaces: DesignSurface[] = [];
  const unknown: string[] = [];
  for (const key of keys) {
    const surface = byKey.get(key);
    if (surface) surfaces.push(surface);
    else unknown.push(key);
  }
  return { surfaces, unknown };
}

/**
 * Which registered surfaces a set of changed product concepts touches.
 *
 * The join that makes UI-impact routing product-aware rather than
 * path-shaped: a change that adds an action to *missions* reaches every surface
 * that declares `mission` as one of its concepts, whichever files moved. A
 * concept nothing declares reaches nothing, and `impact.ts` reports that
 * separately rather than falling back to *everything*, because a fallback that
 * captures the whole product on every change is a fallback nobody leaves on.
 */
export async function surfacesForConcepts(concepts: readonly string[]): Promise<DesignSurface[]> {
  if (concepts.length === 0) return [];
  const wanted = new Set(concepts.map((one) => one.toLowerCase()));
  return (await listSurfaceRows()).filter((surface) =>
    surface.concepts.some((concept) => wanted.has(concept.toLowerCase())),
  );
}

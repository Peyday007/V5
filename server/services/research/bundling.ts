/**
 * Packing compatible fragments into one job.
 *
 * A fragment is a logical evidence unit; a job is an execution container. Six
 * fragments about the same statute in the same jurisdiction do not need six
 * conversations, six retrievals of the same sources, and six slices of the
 * user's quota — they need one job that answers all six and returns the answers
 * separately.
 *
 * "Separately" is the whole constraint. Bundling is only safe while each
 * fragment's claims come back under its own key, so its evidence can be judged,
 * accepted, rejected or repaired without touching the others. Output that blends
 * the fragments together is rejected rather than untangled, because untangling
 * it would mean guessing which claim belonged to which question.
 */
import { dependencyKeys } from '../../domain/dependencies.ts';
import type { ResearchFragment } from '../../domain/types.ts';
import type { JobKind } from '../../domain/types.ts';

/** More than this in one job and the instructions stop being unambiguous. */
export const MAX_FRAGMENTS_PER_JOB = 4;

/** A prompt past this size gets worse answers, whatever the context window says. */
export const MAX_BUNDLE_PROMPT_CHARS = 24_000;

export interface Bundle {
  fragments: ResearchFragment[];
  rationale: string;
  jobKind: JobKind;
  priority: number;
}

/** The dimensions that have to agree before two fragments can share a job. */
function compatibilityKey(fragment: ResearchFragment): string {
  return [
    fragment.geography ?? '-',
    fragment.timeframe ?? '-',
    fragment.population ?? '-',
    // Different definitions in one conversation is how scope drift starts.
    fragment.definitions ?? '-',
    [...fragment.acceptableSourceTypes].sort().join(','),
  ].join('|');
}

/**
 * Do these two fragments draw on the same sources?
 *
 * Shared source ecosystems are the actual saving: two questions answered from
 * the same registry are one retrieval. Two questions from unrelated ecosystems
 * bundled together just make a longer prompt.
 */
function sharesEcosystem(a: ResearchFragment, b: ResearchFragment): boolean {
  const left = new Set([...a.acceptableSourceTypes, ...a.preferredSourceTypes].map(lower));
  const right = new Set([...b.acceptableSourceTypes, ...b.preferredSourceTypes].map(lower));
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared / Math.min(left.size, right.size) >= 0.5;
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

/** A rough size for a fragment's share of a bundled prompt. */
function promptWeight(fragment: ResearchFragment): number {
  return (
    fragment.question.length +
    fragment.requiredEvidence.map((lane) => lane.description).join(' ').length +
    fragment.completionCriteria.join(' ').length +
    (fragment.whyExistingInsufficient?.length ?? 0) +
    600
  );
}

/**
 * Group the runnable fragments into jobs.
 *
 * Order is preserved from the caller, which has already sorted by dependency and
 * priority — so bundling never moves a fragment ahead of its own premise.
 */
export function bundleFragments(fragments: ResearchFragment[]): Bundle[] {
  const bundles: Bundle[] = [];

  for (const fragment of fragments) {
    const key = compatibilityKey(fragment);
    const candidate = bundles.find((bundle) => {
      if (bundle.fragments.length >= MAX_FRAGMENTS_PER_JOB) return false;
      const first = bundle.fragments[0]!;
      if (compatibilityKey(first) !== key) return false;
      if (!sharesEcosystem(first, fragment)) return false;
      // A fragment that depends on another in the same bundle would be asked to
      // build on an answer that does not exist yet.
      // Compared by key, and across every kind rather than only the blocking
      // ones: a conditional dependent may run before its dependency, but not
      // *beside* it in one session, because the condition it has to carry is
      // whatever that dependency ends up establishing.
      const keysOf = (entry: ResearchFragment): string[] => dependencyKeys(entry.dependsOn);
      if (bundle.fragments.some((entry) => keysOf(fragment).includes(entry.fragmentKey))) return false;
      if (bundle.fragments.some((entry) => keysOf(entry).includes(fragment.fragmentKey))) return false;
      const size = bundle.fragments.reduce((sum, entry) => sum + promptWeight(entry), 0);
      return size + promptWeight(fragment) <= MAX_BUNDLE_PROMPT_CHARS;
    });

    if (candidate) {
      candidate.fragments.push(fragment);
      candidate.priority = Math.min(candidate.priority, fragment.priority);
      continue;
    }

    bundles.push({
      fragments: [fragment],
      rationale: '',
      jobKind: 'INVESTIGATION',
      priority: fragment.priority,
    });
  }

  for (const bundle of bundles) {
    bundle.rationale = describeBundle(bundle);
    bundle.jobKind = kindOf(bundle);
  }
  return bundles;
}

function describeBundle(bundle: Bundle): string {
  const first = bundle.fragments[0]!;
  if (bundle.fragments.length === 1) {
    return `One fragment: ${first.fragmentKey}.`;
  }
  const scope = [first.geography, first.timeframe, first.population]
    .filter((value): value is string => Boolean(value))
    .join(', ');
  return (
    `${bundle.fragments.length} fragments sharing the same scope${scope ? ` (${scope})` : ''} and ` +
    `source types, answered together to avoid retrieving the same sources ` +
    `${bundle.fragments.length} times: ${bundle.fragments.map((f) => f.fragmentKey).join(', ')}.`
  );
}

/**
 * What kind of work this job is, which decides how much model it deserves.
 *
 * Broad discovery and extraction are well served by a lighter model; a
 * contradiction that has already survived one attempt is not.
 */
function kindOf(bundle: Bundle): JobKind {
  // A contradiction is the case a cheap model gets wrong most confidently.
  if (bundle.fragments.some((fragment) => fragment.contradictionTargets.length > 0)) {
    return 'INVESTIGATION';
  }
  // A calculation's inputs have to be exactly right or the arithmetic is worse
  // than useless, so they are not discovery work either.
  if (bundle.fragments.some((fragment) => fragment.expectedClaimTypes.includes('CALCULATION'))) {
    return 'INVESTIGATION';
  }
  // A first broad pass over supporting evidence is what a lighter model is for.
  // If it comes back weak the repair is an investigation, on the strong model —
  // the bar it has to clear does not move, only the cost of the first try.
  if (bundle.fragments.every((fragment) => fragment.attempt === 1 && fragment.priority > 3)) {
    return 'DISCOVERY';
  }
  return 'INVESTIGATION';
}

/**
 * Which model a job should use.
 *
 * Cheap work goes to the light model and hard work to the strong one, but the
 * evidence bar never moves with it: a discovery job that produces weak claims is
 * repaired, not accepted because it was cheap.
 */
export function modelFor(jobKind: JobKind, defaults: { light: string | null; strong: string | null }): string | null {
  switch (jobKind) {
    case 'DISCOVERY':
      return defaults.light ?? defaults.strong;
    case 'VERIFICATION':
    case 'SYNTHESIS':
      return defaults.strong ?? defaults.light;
    default:
      return defaults.strong ?? defaults.light;
  }
}

/**
 * Reject output that blended the fragments together.
 *
 * Every claim in a bundled result must name the fragment it answers. A result
 * that cannot be split back apart is not usable at any confidence, because
 * accepting it would attach one fragment's evidence to another's question.
 */
export function assertSeparable(
  bundle: Bundle,
  claimsByFragmentKey: Map<string, unknown[]>,
): { ok: true } | { ok: false; error: string } {
  const unknownKeys = [...claimsByFragmentKey.keys()].filter(
    (key) => !bundle.fragments.some((fragment) => fragment.fragmentKey === key),
  );
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error:
        `The job returned claims under ${unknownKeys.length} fragment key(s) that were not in it ` +
        `(${unknownKeys.join(', ')}), so the results cannot be attributed.`,
    };
  }
  return { ok: true };
}

/**
 * Which bundle this fragment belongs to, named so a worker can see it.
 *
 * Bundling already decides which fragments may share one session: same scope,
 * same source ecosystem, no dependency between them. That analysis was reachable
 * only from the in-process path, so a pulling worker had no way to know that
 * three of the items in front of it were safely researched together.
 *
 * What it deliberately does **not** do is put them under one work item. That
 * would give several fragments one Step 6 idempotency scope, and a redelivery
 * could then record one fragment's ledger against another's key. One item per
 * fragment, one key per effect, and a shared name so a session can claim the
 * set on purpose.
 */
export function bundleKeyFor(fragment: ResearchFragment, all: ResearchFragment[]): string | null {
  const bundles = bundleFragments(all.filter((entry) => entry.status !== 'CANCELLED'));
  const found = bundles.find((bundle) =>
    bundle.fragments.some((entry) => entry.id === fragment.id),
  );
  if (!found || found.fragments.length < 2) return null;
  // Named from the bundle's members rather than its index, so it is stable
  // across advances: an index shifts whenever a neighbour is cancelled.
  return found.fragments
    .map((entry) => entry.fragmentKey)
    .sort()
    .join('+');
}

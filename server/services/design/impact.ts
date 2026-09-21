/**
 * Whether a completed change affects the interface, and which screens.
 *
 * ---------------------------------------------------------------------------
 * Why filename matching is not enough, and is still half the answer
 * ---------------------------------------------------------------------------
 *
 * A change under `client/` is obviously a UI change. The two cases that matter
 * are the ones either side of that:
 *
 *   - **A server change with a UI consequence.** A route that starts returning
 *     a new field, a projection that gains a state, a capability that becomes
 *     grantable — none of them touches a `.tsx` file and all of them change what
 *     a person sees. §29's own catalogue is full of these: the nav badge, the
 *     briefing line and the Needs You heading were three readers of one server
 *     fact, and correcting two of them left the third asserting the opposite.
 *   - **A client change with no UI consequence.** A rename, a comment, a test.
 *     Rendering the whole product for one of those spends a browser run to
 *     discover nothing.
 *
 * So the classification has two independent halves and reports both. **Paths**
 * say whether the interface *could* have moved. **Concepts** — the product nouns
 * a change names, held against what each registered surface declares it is about
 * — say *which screens*. Neither is sufficient: a path with no concept reaches
 * every surface or none, and a concept with no path is somebody writing about
 * missions in a comment.
 *
 * ---------------------------------------------------------------------------
 * The failure mode is fixed at *too few screens*
 * ---------------------------------------------------------------------------
 *
 * §27 records four widenings of a closed list that had to be complete over
 * ordinary English, each adding the one word the last production message was
 * declined for. The lesson taken here is to make the cost of a miss small rather
 * than to try to be complete: a missed surface costs one screen not being
 * re-checked this round, and it will be picked up the next time that screen is
 * captured. A fallback to *everything* would spend a full render of the product
 * on every commit, which is a fallback somebody turns off — and then the whole
 * mechanism is gone rather than imperfect.
 */
import type { DesignSurface } from '../../domain/design.ts';
import { liveSurfaces, surfacesForConcepts } from './surfaces.ts';

/**
 * Paths whose contents are, by construction, what a person looks at.
 *
 * Prefixes and extensions rather than a regular expression over the whole path,
 * because a pattern is a small language and a boundary written in one is a
 * boundary somebody widens by accident — §27's own argument about a mutation
 * scope, at a classifier.
 */
export const INTERFACE_PATH_PREFIXES = ['client/'];
export const INTERFACE_EXTENSIONS = ['.tsx', '.css', '.html', '.svg'];

/**
 * Paths that are about the interface without being it.
 *
 * A route module, a projection or a view service decides what a screen is handed
 * and therefore what it can show. These raise the question rather than settle
 * it: a change here is UI-relevant only if it also names a product concept, and
 * `classifyUiImpact` requires both.
 */
export const INTERFACE_ADJACENT_PREFIXES = [
  'server/routes/',
  'server/services/russell/',
  'server/services/cash/view',
  'server/services/fleet/view',
  'server/services/connect/projection',
];

/** Paths that cannot change what anybody sees, whatever else they touch. */
export const NON_INTERFACE_PREFIXES = [
  'tests/',
  'docs/',
  'scripts/',
  'server/db/migrations/',
  'server/db/pg-migrations/',
  '.github/',
];

export type UiImpactVerdict = 'DIRECT' | 'INDIRECT' | 'NONE' | 'UNKNOWN';

export interface UiImpact {
  verdict: UiImpactVerdict;
  /** Why, in one sentence, whichever way it went. A NONE with no reason is a shrug. */
  because: string;
  /** The files that raised it, so a reader can check the classification. */
  interfacePaths: string[];
  adjacentPaths: string[];
  /** Product nouns the change named, matched against what surfaces declare. */
  concepts: string[];
  /** Registered surfaces those concepts reach. */
  surfaces: DesignSurface[];
  /**
   * Concepts the change named that no registered surface declares.
   *
   * Reported rather than ignored, because it is the most useful thing this
   * classifier produces: a product concept with no screen registered against it
   * is either a screen nobody has registered or a capability with no interface,
   * and both are worth somebody knowing.
   */
  unrepresented: string[];
}

function isUnder(path: string, prefixes: readonly string[]): boolean {
  const normalised = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return prefixes.some((prefix) => normalised.startsWith(prefix));
}

function hasInterfaceExtension(path: string): boolean {
  return INTERFACE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));
}

/**
 * The product nouns a piece of text names.
 *
 * Matched on word boundaries against the vocabulary the **surfaces themselves
 * declare**, rather than against a list kept here. That is what makes it grow
 * with the product: registering a surface about a new concept teaches the
 * classifier that concept, in the same row, with nobody editing this file.
 *
 * Word boundaries matter: §25 records `rAPId` matching `API`, and the same
 * mistake here would route a change to a screen it has nothing to do with.
 */
export function conceptsNamed(text: string, vocabulary: readonly string[]): string[] {
  const found = new Set<string>();
  const haystack = text.toLowerCase();
  for (const concept of vocabulary) {
    const needle = concept.toLowerCase().trim();
    if (needle.length < 3) continue;
    const pattern = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`);
    if (pattern.test(haystack)) found.add(concept);
  }
  return [...found];
}

export interface ClassifyInput {
  /** Every path the change touched. */
  changedPaths: readonly string[];
  /**
   * What the change said it was for — an objective, an expected outcome, a
   * commit subject. Read for the concepts it names, never for a verdict.
   */
  description: string;
}

/**
 * Decide whether, and where, a change reaches the interface.
 *
 * `UNKNOWN` is a real answer and not a failure: a change whose paths were never
 * recorded cannot be classified, and reporting that as `NONE` would turn *we
 * could not tell* into *we checked*, which §30 already had to correct once at a
 * capability reading.
 */
export async function classifyUiImpact(input: ClassifyInput): Promise<UiImpact> {
  /*
   * The vocabulary is the union of what every registered surface says it is
   * about. That is what makes the classifier grow with the product rather than
   * with this file: registering a surface for a new concept teaches it that
   * concept in the same row, and nothing here needs editing.
   */
  const registered = await liveSurfaces();
  const vocabulary = [...new Set(registered.flatMap((one) => one.concepts))];
  const concepts = conceptsNamed(input.description, vocabulary);
  const reached = await surfacesForConcepts(concepts);

  if (input.changedPaths.length === 0) {
    return {
      verdict: 'UNKNOWN',
      because:
        'No changed paths were recorded for this change, so whether it reaches the interface ' +
        'cannot be established — which is not the same fact as it not reaching it.',
      interfacePaths: [],
      adjacentPaths: [],
      concepts,
      surfaces: reached,
      unrepresented: [],
    };
  }

  const considered = input.changedPaths.filter((path) => !isUnder(path, NON_INTERFACE_PREFIXES));
  const interfacePaths = considered.filter(
    (path) => isUnder(path, INTERFACE_PATH_PREFIXES) || hasInterfaceExtension(path),
  );
  const adjacentPaths = considered.filter(
    (path) => !interfacePaths.includes(path) && isUnder(path, INTERFACE_ADJACENT_PREFIXES),
  );

  const unrepresented = concepts.filter(
    (concept) => !reached.some((surface) => surface.concepts.includes(concept)),
  );

  if (interfacePaths.length > 0) {
    return {
      verdict: 'DIRECT',
      because:
        `${interfacePaths.length} changed file(s) are part of what a person looks at` +
        (reached.length > 0
          ? `, and the change names ${concepts.join(', ')}, which ${reached.length} registered ` +
            'surface(s) are about.'
          : ', and it names no product concept any registered surface declares — so which screens ' +
            'it reaches is decided by the paths alone.'),
      interfacePaths,
      adjacentPaths,
      concepts,
      surfaces: reached,
      unrepresented,
    };
  }

  if (adjacentPaths.length > 0 && reached.length > 0) {
    return {
      verdict: 'INDIRECT',
      because:
        `Nothing a person looks at was edited, but ${adjacentPaths.length} file(s) that decide what ` +
        `a screen is handed were, and the change names ${concepts.join(', ')} — which ` +
        `${reached.length} registered surface(s) are about. A server change with a UI consequence ` +
        'touches no .tsx file and still changes what somebody sees.',
      interfacePaths,
      adjacentPaths,
      concepts,
      surfaces: reached,
      unrepresented,
    };
  }

  if (adjacentPaths.length > 0) {
    return {
      verdict: 'NONE',
      because:
        `${adjacentPaths.length} file(s) that can decide what a screen is handed were changed, but ` +
        'the change names no product concept any registered surface is about — so there is no ' +
        'screen to re-check. Registering a surface for the concept it names would change this answer.',
      interfacePaths,
      adjacentPaths,
      concepts,
      surfaces: [],
      unrepresented,
    };
  }

  return {
    verdict: 'NONE',
    because:
      considered.length === 0
        ? 'Every changed path is somewhere that cannot alter what anybody sees — tests, docs, ' +
          'scripts, migrations or workflows.'
        : `None of the ${considered.length} changed file(s) is part of the interface or decides ` +
          'what a screen is handed.',
    interfacePaths,
    adjacentPaths,
    concepts,
    surfaces: [],
    unrepresented,
  };
}

/** Whether a verdict is one that should open a design cycle. */
export function shouldOpenCycle(impact: UiImpact): boolean {
  return impact.verdict === 'DIRECT' || impact.verdict === 'INDIRECT';
}

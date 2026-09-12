/**
 * The Discovery Frontier — where a project's understanding runs out.
 *
 * §11 asks every project to maintain a living reading of five regions: what is
 * strongly understood, what is believed on thin evidence, what is known to be
 * unanswered, what nobody has looked at, and what Brain found for itself. This
 * derives all five from rows the project already holds, and the derivation is
 * the whole design.
 *
 * **The honest split.** §11 lists nine discovery lenses. Some of them are
 * questions about *state* — which assumptions have nothing supporting them,
 * which findings contradict each other, which declared region has no work in it
 * — and those are answerable from rows, deterministically, with no model
 * involved. The rest are questions about *meaning*: what adjacent possibility
 * is absent, what lesson from another project transfers, what the current map
 * makes impossible to see. Those need a reader, and a Brain that answered them
 * from a template would be manufacturing insight.
 *
 * So the row-derivable lenses run here and produce frontier items directly. The
 * judgment lenses are carried as *prompts* — real questions, attached to real
 * subjects — which the existing conversation and proposal path can put to a
 * worker, whose output is then validated like every other proposal (§24). There
 * is no code path in this file that invents a finding.
 *
 * **v1 is v1, and says so.** This is useful and testable and is not the final
 * cognitive frontier. It counts what it produced so a later version can measure
 * whether the discoveries were any good — which is the instrumentation §11 asks
 * for, and the difference between a capability that can improve and a claim.
 */
import { listLayers } from '../../repos/layers.ts';
import { listCurrentKnowledge } from '../../repos/russellMissions.ts';
import { listCandidates } from '../../repos/russellCandidates.ts';
import { listGapsByLayer } from '../../repos/audits.ts';
import {
  listFrontier,
  observeFrontierItem,
  resolveUnseenFrontierItems,
} from '../../repos/russellFrontier.ts';
import { plainLayerName } from './dealDispatch.ts';
import { milestoneStateOfLayer } from './progress.ts';
// One set of words for the five regions, imported rather than re-declared.
import { FRONTIER_REGION_LABELS as REGION_LABELS } from '../../domain/types.ts';
import type {
  FrontierRegion,
  FrontierSourceKind,
  RussellFrontierItem,
} from '../../domain/types.ts';

/**
 * The lenses, named.
 *
 * `DERIVED` ones are answered from rows in `refreshFrontier`. `ASKED` ones are
 * questions only a reader can answer, and the engine's job is to put them —
 * never to answer them.
 */
export const LENSES = [
  { key: 'UNSUPPORTED_ASSUMPTION', kind: 'DERIVED', question: 'Which assumptions were never tested?' },
  { key: 'CONTRADICTION', kind: 'DERIVED', question: 'Which findings contradict each other?' },
  { key: 'UNSTUDIED_REGION', kind: 'DERIVED', question: 'What important region has not been studied?' },
  { key: 'THIN_EVIDENCE', kind: 'DERIVED', question: 'What is believed on evidence that would not survive scrutiny?' },
  { key: 'OPEN_GAP', kind: 'DERIVED', question: 'What has an audit said is still missing?' },
  { key: 'MISSING_MECHANISM', kind: 'ASKED', question: 'What mechanism is missing from this model?' },
  { key: 'FIXED_VARIABLE', kind: 'ASKED', question: 'What is being treated as fixed that is not?' },
  { key: 'TRANSFERABLE_LESSON', kind: 'ASKED', question: 'What lesson from another project transfers here?' },
  { key: 'ADJACENT_POSSIBILITY', kind: 'ASKED', question: 'What adjacent possibility is absent?' },
  { key: 'WHAT_THE_MAP_HIDES', kind: 'ASKED', question: 'What does the current map make impossible to see?' },
] as const;

export type LensKey = (typeof LENSES)[number]['key'];

/** The five, in the order a person reads them. */
export const REGION_ORDER: readonly FrontierRegion[] = [
  'OPEN_QUESTION',
  'WEAK_GROUND',
  'UNEXAMINED',
  'NEW_PATH',
  'SOLID_GROUND',
];

interface Observed {
  region: FrontierRegion;
  subject: string;
  detail: string | null;
  sourceKind: FrontierSourceKind;
  sourceId: string | null;
  lens: LensKey | null;
  visibility: 'PRIVATE' | 'SHARED';
}

/**
 * Read one project's edges, from rows.
 *
 * Pure over what it is given, so the classification rules are testable without
 * a database — which matters because these rules are the whole claim the
 * frontier makes, and "is a disputed conclusion weak ground or an open
 * question" is exactly the kind of decision that drifts if it lives inside an
 * async function nobody can call directly.
 */
export function classify(input: {
  knowledge: {
    id: string;
    kind: string;
    statement: string;
    detail: string | null;
    confidence: string;
    visibility: 'PRIVATE' | 'SHARED';
  }[];
  layers: { id: string; name: string; status: string }[];
  gaps: { id: string; title: string; detail: string | null; classification: string }[];
  candidates: {
    id: string;
    title: string;
    statement: string;
    conversationId: string | null;
    state: string;
    visibility: 'PRIVATE' | 'SHARED';
  }[];
}): Observed[] {
  const observed: Observed[] = [];

  for (const row of input.knowledge) {
    /*
     * Confidence decides the region, and the kind decides which question it
     * is. A conclusion nothing supports is weak ground — the project believes
     * it — while an unknown is an open question, which the project does not
     * believe at all. Treating them the same would mean a person could not
     * tell what needs shoring up from what needs answering.
     */
    if (row.kind === 'CONCLUSION' || row.kind === 'DECISION') {
      const strong = row.confidence === 'ESTABLISHED' || row.confidence === 'SUPPORTED';
      observed.push({
        region: strong ? 'SOLID_GROUND' : 'WEAK_GROUND',
        subject: row.statement,
        detail: row.detail,
        sourceKind: 'KNOWLEDGE',
        sourceId: row.id,
        lens: strong ? null : 'THIN_EVIDENCE',
        visibility: row.visibility,
      });
      continue;
    }
    if (row.kind === 'ASSUMPTION') {
      observed.push({
        region: 'WEAK_GROUND',
        subject: row.statement,
        detail: row.detail,
        sourceKind: 'KNOWLEDGE',
        sourceId: row.id,
        lens: 'UNSUPPORTED_ASSUMPTION',
        visibility: row.visibility,
      });
      continue;
    }
    if (row.kind === 'CONTRADICTION') {
      observed.push({
        region: 'OPEN_QUESTION',
        subject: row.statement,
        detail: row.detail,
        sourceKind: 'CONTRADICTION',
        sourceId: row.id,
        lens: 'CONTRADICTION',
        visibility: row.visibility,
      });
      continue;
    }
    if (row.kind === 'GAP' || row.kind === 'UNKNOWN') {
      observed.push({
        region: 'OPEN_QUESTION',
        subject: row.statement,
        detail: row.detail,
        sourceKind: 'KNOWLEDGE',
        sourceId: row.id,
        lens: 'OPEN_GAP',
        visibility: row.visibility,
      });
    }
  }

  /*
   * A declared region with nothing in it.
   *
   * This is the one item derived from an *absence*, and it is the most
   * valuable region on the frontier: a layer nobody has started is a piece of
   * the model the project has said it needs and has not looked at. Its source
   * is the layer, so the reading walks back to something real even though what
   * it reports is the lack of something.
   */
  for (const layer of input.layers) {
    if (milestoneStateOfLayer(layer.status as never) !== 'OPEN') continue;
    observed.push({
      region: 'UNEXAMINED',
      subject: plainLayerName(layer.name),
      detail: 'Nothing has been researched or written here yet.',
      sourceKind: 'LAYER',
      sourceId: layer.id,
      lens: 'UNSTUDIED_REGION',
      visibility: 'SHARED',
    });
  }

  /*
   * What an audit said was missing.
   *
   * The judge's own classified gaps, not a re-reading of its prose. A gap the
   * domain says may keep research open is an open question; the rest are
   * recorded as weak ground, because they describe something believed that the
   * audit was not satisfied by.
   */
  for (const gap of input.gaps) {
    observed.push({
      region: gap.classification === 'FOUNDATIONAL' ? 'OPEN_QUESTION' : 'WEAK_GROUND',
      subject: gap.title,
      detail: gap.detail,
      sourceKind: 'AUDIT_GAP',
      sourceId: gap.id,
      lens: 'OPEN_GAP',
      visibility: 'SHARED',
    });
  }

  /*
   * A path Brain found for itself.
   *
   * The test is provenance, not enthusiasm: a candidate with no conversation
   * behind it was not asked for by a person. One that came out of a
   * conversation is somebody's idea, which is a different thing and belongs in
   * Work rather than on the frontier.
   */
  for (const candidate of input.candidates) {
    if (candidate.conversationId !== null) continue;
    if (candidate.state === 'MERGED' || candidate.state === 'REJECTED') continue;
    observed.push({
      region: 'NEW_PATH',
      subject: candidate.title,
      detail: candidate.statement,
      sourceKind: 'CANDIDATE',
      sourceId: candidate.id,
      lens: null,
      visibility: candidate.visibility,
    });
  }

  return observed;
}

/**
 * How often the durable loop re-reads a project's edges.
 *
 * Ten minutes, not the loop's thirty seconds, and the reason is write churn:
 * observing an item touches its `last_seen_at`, so a tick-rate refresh would
 * write every row of every project's frontier twice a minute for ever. The
 * frontier changes when knowledge, layers or candidates change — which is
 * minutes apart at the fastest — so this is the cadence the data actually has.
 *
 * A read of the page always refreshes regardless. A person looking at the
 * frontier is asking what is true now, and answering with a reading up to ten
 * minutes old would be the staleness this whole module exists to remove.
 */
export const FRONTIER_REFRESH_MS = 10 * 60 * 1000;

/**
 * Whether the background loop should re-read this project.
 *
 * Derived from the rows rather than from in-process state, so it survives a
 * restart: the newest `last_seen_at` *is* when the last pass ran. A project
 * with no frontier rows at all has never been read and is always due.
 */
export async function frontierIsDue(projectId: string, now = Date.now()): Promise<boolean> {
  const items = await listFrontier({ projectId, includeResolved: true, includePrivate: true });
  let newest = 0;
  for (const item of items) {
    const at = Date.parse(item.lastSeenAt);
    if (!Number.isNaN(at) && at > newest) newest = at;
  }
  if (newest === 0) return true;
  return now - newest >= FRONTIER_REFRESH_MS;
}

/**
 * Re-read one project's frontier and record what is true now.
 *
 * Everything observed is touched; everything that was live and is no longer
 * observed is resolved rather than deleted. Returns the counts, because §11
 * asks for the engine to be instrumented — a discovery capability that cannot
 * be measured cannot be improved, and cannot be honestly described either.
 */
export async function refreshFrontier(projectId: string): Promise<{
  observed: number;
  resolved: number;
  byRegion: Record<FrontierRegion, number>;
}> {
  const [knowledge, layers, candidates] = await Promise.all([
    listCurrentKnowledge({
      projectId,
      kinds: ['CONCLUSION', 'DECISION', 'ASSUMPTION', 'GAP', 'UNKNOWN', 'CONTRADICTION'],
      includePrivate: true,
      limit: 500,
    }),
    listLayers(projectId),
    listCandidates({ projectId, limit: 500 }),
  ]);

  const gaps: { id: string; title: string; detail: string | null; classification: string }[] = [];
  for (const layer of layers) {
    for (const gap of await listGapsByLayer(layer.id, 50)) {
      // An `audit_gaps` row has no resolved state of its own: a gap is settled
      // by a later audit not recording it, which the frontier's own resolve
      // pass then picks up. Filtering on a status that does not exist would
      // have been a quiet no-op.
      gaps.push({
        id: gap.id,
        title: gap.title,
        detail: gap.detail,
        classification: gap.classification,
      });
    }
  }

  const observed = classify({
    knowledge: knowledge.map((row) => ({
      id: row.id,
      kind: row.kind,
      statement: row.statement,
      detail: row.detail,
      confidence: row.confidence,
      visibility: row.visibility,
    })),
    layers: layers.map((layer) => ({ id: layer.id, name: layer.name, status: layer.status })),
    gaps,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      statement: candidate.statement,
      conversationId: candidate.conversationId,
      state: candidate.state,
      visibility: candidate.visibility,
    })),
  });

  /*
   * The pass is stamped, not listed.
   *
   * Everything observed below is written with a `last_seen_at` at or after
   * this instant, so resolving what was *not* observed is one comparison
   * rather than a list of every fingerprint — which SQLite would refuse past
   * 999 of them, on exactly the projects whose edges are worth reading.
   */
  const startedAt = new Date().toISOString();
  const byRegion: Record<FrontierRegion, number> = {
    SOLID_GROUND: 0,
    WEAK_GROUND: 0,
    OPEN_QUESTION: 0,
    UNEXAMINED: 0,
    NEW_PATH: 0,
  };
  for (const item of observed) {
    await observeFrontierItem({ projectId, ...item });
    byRegion[item.region] += 1;
  }

  const resolved = await resolveUnseenFrontierItems({ projectId, startedAt });
  return { observed: observed.length, resolved, byRegion };
}

export interface FrontierRegionView {
  region: FrontierRegion;
  label: string;
  /** One sentence saying what this region means, composed from the region only. */
  meaning: string;
  items: RussellFrontierItem[];
}

export interface FrontierView {
  regions: FrontierRegionView[];
  /**
   * The questions only a reader can answer, with the subject each is about.
   *
   * These are *put*, never answered. A Brain that filled them in from a
   * template would be manufacturing insight, which is the one thing a discovery
   * engine must not do.
   */
  openLenses: { lens: LensKey; question: string; about: string | null }[];
  /** What this pass produced, so the capability can be measured (§11). */
  counts: { live: number; dismissed: number; resolved: number };
}

const MEANINGS: Record<FrontierRegion, string> = {
  SOLID_GROUND: 'Understood well enough to build on.',
  WEAK_GROUND: 'Believed, on evidence that would not survive much scrutiny.',
  OPEN_QUESTION: 'Known to be unanswered.',
  UNEXAMINED: 'Part of the model nobody has looked at yet.',
  NEW_PATH: 'Something Russell found rather than something anybody asked for.',
};

/**
 * The frontier as a person reads it.
 *
 * Refreshes first, so what is shown is what is true now rather than what was
 * true the last time something happened to run. A dismissed item stays in its
 * region and carries its reason — hiding it would recreate the silent dark
 * spot the dismissal was supposed to make explicit.
 */
export async function frontierFor(input: {
  projectId: string;
  projectName: string;
  includePrivate?: boolean;
}): Promise<FrontierView> {
  await refreshFrontier(input.projectId);
  const items = await listFrontier({
    projectId: input.projectId,
    includePrivate: input.includePrivate ?? false,
  });

  const regions = REGION_ORDER.map((region) => ({
    region,
    label: REGION_LABELS[region],
    meaning: MEANINGS[region],
    items: items.filter((item) => item.region === region),
  }));

  /*
   * The judgment questions, each attached to something real.
   *
   * "What mechanism is missing?" about nothing is a slogan. About the weakest
   * thing the project currently believes, it is a question somebody can
   * actually take away and answer.
   */
  const weakest = items.find((item) => item.region === 'WEAK_GROUND') ?? null;
  const unexamined = items.find((item) => item.region === 'UNEXAMINED') ?? null;
  const openLenses = LENSES.filter((lens) => lens.kind === 'ASKED').map((lens) => ({
    lens: lens.key,
    question: lens.question,
    about:
      lens.key === 'MISSING_MECHANISM' || lens.key === 'FIXED_VARIABLE'
        ? (weakest?.subject ?? null)
        : lens.key === 'ADJACENT_POSSIBILITY' || lens.key === 'WHAT_THE_MAP_HIDES'
          ? (unexamined?.subject ?? null)
          : input.projectName,
  }));

  const resolvedItems = await listFrontier({
    projectId: input.projectId,
    includeResolved: true,
    includePrivate: input.includePrivate ?? false,
  });

  return {
    regions,
    openLenses,
    counts: {
      live: items.length,
      dismissed: items.filter((item) => item.dismissedAt !== null).length,
      resolved: resolvedItems.filter((item) => item.resolvedAt !== null).length,
    },
  };
}

/**
 * Whether a frontier item is worth proposing as work.
 *
 * Deliberately narrow, and deliberately not a value judgment: it says which
 * regions *could* justify a bounded look, and nothing about whether one is
 * worth taking. The decision to spend anything still goes through
 * `judgeCandidate`, the coverage check and the standing authority — this only
 * says the question exists.
 */
export function couldBecomeWork(item: RussellFrontierItem): boolean {
  if (item.dismissedAt !== null || item.resolvedAt !== null) return false;
  return (
    item.region === 'OPEN_QUESTION' ||
    item.region === 'UNEXAMINED' ||
    item.region === 'WEAK_GROUND'
  );
}

export type { RussellFrontierItem };

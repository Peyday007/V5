/**
 * The three things about a possibility that only a person can decide.
 *
 * Naming one that the enumeration could not produce, judging one, and saying
 * that two of them are really one. Everything else about a path is read from
 * rows, which is what stops this being a way to set a status by hand: there is
 * no `setStatus` here and there must never be one — a caller that could mark a
 * possibility healthy over evidence that says otherwise would make the whole
 * derivation decorative.
 *
 * ---------------------------------------------------------------------------
 * Nothing here destroys anything
 * ---------------------------------------------------------------------------
 *
 * Invalidating appends a row. Archiving appends a row. Merging sets one
 * pointer, and clearing that pointer is the whole of the reversal — the
 * absorbed path keeps its id, its facts, its judgements and its entire rank
 * history. Splitting creates children that name the parent they came out of,
 * and the parent stays readable.
 *
 * That is the brief's own central instruction, enforced by there being no other
 * operation: `repos/monetization.ts` contains no `DELETE` at all.
 */
import { getCashMode, recordCashEvent } from '../../../repos/cashMode.ts';
import {
  getPath,
  recordEdge,
  recordJudgment,
  recordPath,
  setMergedInto,
  setSplitFrom,
} from '../../../repos/monetization.ts';
import { getOpportunity } from '../../../repos/cashPortfolio.ts';
import { getNode } from '../../../repos/industry.ts';
import { titleFor } from './enumerate.ts';
import type {
  MonetizationEdgeKind,
  MonetizationMethod,
  MonetizationPath,
  MonetizationPathJudgment,
  PathJudgment,
} from '../../../domain/types.ts';

/**
 * The activity-feed kind per judgement, spelled out.
 *
 * A table rather than a string built from the judgement, because the built form
 * is one irregular verb away from producing a kind nothing can group by — and
 * `cash_events.kind` is exactly what the shared frontier aggregates activity on
 * (§34), so a malformed one is a count nobody can read.
 */
const EVENT_KIND: Readonly<Record<PathJudgment, string>> = Object.freeze({
  WATCH: 'MONETIZATION_PATH_WATCHED',
  INVALIDATE: 'MONETIZATION_PATH_INVALIDATED',
  ARCHIVE: 'MONETIZATION_PATH_ARCHIVED',
  REVIVE: 'MONETIZATION_PATH_REVIVED',
});

export type DecisionOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/**
 * Name a possibility the table could not produce.
 *
 * `SEED` is the one origin Brain may never write — §22's rule at this table: a
 * machine that could name its own possibilities would be deciding what the
 * space is. So this is reachable only from a route behind `requirePerson`, and
 * the method still comes from the closed set, because a person naming a shape
 * of transaction nothing else in the system understands would produce a row
 * nothing could rank, relate or research.
 *
 * Idempotent by the same unique index the enumeration uses: seeding a method
 * the table already enumerated finds that row and says so, rather than forking
 * the ledger into two entries for one shape of transaction.
 */
export async function seedPath(input: {
  projectId: string;
  method: MonetizationMethod;
  opportunityId?: string | null;
  industryNodeId?: string | null;
  title?: string | null;
  thesis?: string | null;
  seededByUserId: string;
}): Promise<DecisionOutcome<{ path: MonetizationPath; created: boolean }>> {
  if (!(await getCashMode(input.projectId))) {
    return { ok: false, reason: 'Cash Mode has not been activated for this project.' };
  }
  if ((input.opportunityId ? 1 : 0) + (input.industryNodeId ? 1 : 0) !== 1) {
    return {
      ok: false,
      reason:
        'A possibility is a way of monetizing exactly one thing: name a discovery or an industry ' +
        'subject, not both and not neither.',
    };
  }

  /*
   * The subject is re-resolved **in this project** rather than trusted.
   *
   * A path carrying an id from somebody else's operation would be a row in one
   * project pointing into another, and every projection over it would read as
   * though the two were one. §24's rule about re-resolving every project
   * reference, at a new write.
   */
  let subjectTitle: string;
  if (input.opportunityId) {
    const opportunity = await getOpportunity(input.opportunityId);
    if (!opportunity || opportunity.projectId !== input.projectId) {
      return { ok: false, reason: 'That discovery is not in this project.' };
    }
    subjectTitle = opportunity.title;
  } else {
    const node = await getNode(input.industryNodeId!);
    if (!node || node.projectId !== input.projectId) {
      return { ok: false, reason: 'That industry subject is not in this project.' };
    }
    subjectTitle = node.name;
  }

  const recorded = await recordPath({
    projectId: input.projectId,
    opportunityId: input.opportunityId ?? null,
    industryNodeId: input.industryNodeId ?? null,
    method: input.method,
    title: (input.title ?? '').trim() || titleFor(input.method, subjectTitle),
    thesis: (input.thesis ?? '').trim() || null,
    origin: 'SEED',
  });

  if (recorded.created) {
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: input.opportunityId ?? null,
      kind: 'MONETIZATION_PATH_SEEDED',
      actorRef: input.seededByUserId,
      summary: `A person added "${recorded.path.title}" to the possibility ledger.`,
      detail: { pathId: recorded.path.id, method: input.method },
    });
  }
  return { ok: true, value: recorded };
}

/**
 * Record what a person decided about a possibility.
 *
 * The reason is required by the schema and by this function, and that is not
 * ceremony: a possibility put away with no reason is one nobody can reconsider
 * later, which is precisely the state the ledger exists to prevent. The
 * *reconsider* group is derived by comparing a judgement's timestamp against
 * the answers recorded since it, so a judgement is a dated statement rather
 * than a permanent verdict.
 */
export async function judgePath(input: {
  projectId: string;
  pathId: string;
  judgment: PathJudgment;
  reason: string;
  decidedByUserId: string;
  channel?: MonetizationPathJudgment['channel'];
}): Promise<DecisionOutcome<MonetizationPathJudgment>> {
  const path = await getPath(input.pathId);
  if (!path || path.projectId !== input.projectId) {
    return { ok: false, reason: 'That possibility is not in this project.' };
  }
  const reason = input.reason.trim();
  if (!reason) {
    return {
      ok: false,
      reason:
        'Say why. A possibility put away with no reason is one nobody can reconsider when the ' +
        'thing that made it wrong stops being true.',
    };
  }

  const judgment = await recordJudgment({
    projectId: input.projectId,
    pathId: input.pathId,
    judgment: input.judgment,
    reason,
    decidedById: input.decidedByUserId,
    /*
     * The weaker value by default, because Brain cannot check a channel and
     * must never assume the stronger one — §23's column pair, at a new table.
     * A route holding an authenticated browser principal passes the stronger
     * one explicitly.
     */
    channel: input.channel ?? 'DELEGATED_TERMINAL',
  });

  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: path.opportunityId,
    kind: EVENT_KIND[input.judgment],
    actorRef: input.decidedByUserId,
    summary: `"${path.title}": ${input.judgment.toLowerCase()} — ${reason}`,
    detail: { pathId: path.id, judgment: input.judgment },
  });

  return { ok: true, value: judgment };
}

/**
 * Say that two possibilities are really one.
 *
 * The absorbed path is *pointed at* the survivor rather than removed, and the
 * judgement row beside it says who did it and why. Both stay in the ledger,
 * both keep their facts, and `unmergePath` is the reversal — which is what
 * makes this safe to do on a hunch, rather than a decision somebody has to be
 * sure about.
 *
 * Refused where it would make the graph nonsense: a path cannot be merged into
 * itself, into one on a different discovery, or into one that is itself merged
 * away — the last of which would produce a chain a reader has to walk to find
 * out what is actually carrying the work.
 */
export async function mergePaths(input: {
  projectId: string;
  absorbedId: string;
  survivorId: string;
  reason: string;
  decidedByUserId: string;
  channel?: MonetizationPathJudgment['channel'];
}): Promise<DecisionOutcome<{ absorbed: MonetizationPath; survivor: MonetizationPath }>> {
  const absorbed = await getPath(input.absorbedId);
  const survivor = await getPath(input.survivorId);
  if (!absorbed || absorbed.projectId !== input.projectId) {
    return { ok: false, reason: 'That possibility is not in this project.' };
  }
  if (!survivor || survivor.projectId !== input.projectId) {
    return { ok: false, reason: 'That possibility is not in this project.' };
  }
  if (absorbed.id === survivor.id) {
    return { ok: false, reason: 'A possibility cannot be merged into itself.' };
  }
  if (absorbed.opportunityId !== survivor.opportunityId || absorbed.industryNodeId !== survivor.industryNodeId) {
    return {
      ok: false,
      reason:
        'These are ways of monetizing two different things, so one cannot carry the other. ' +
        'Nothing was changed.',
    };
  }
  if (survivor.mergedIntoId) {
    return {
      ok: false,
      reason:
        `"${survivor.title}" has itself been merged away, so merging into it would leave a ` +
        'chain somebody has to walk to find what is actually carrying this.',
    };
  }
  const reason = input.reason.trim();
  if (!reason) return { ok: false, reason: 'Say why these are one possibility rather than two.' };

  const moved = await setMergedInto({
    pathId: absorbed.id,
    intoId: survivor.id,
    expectCurrent: null,
  });
  if (!moved) {
    return {
      ok: false,
      reason: 'That possibility has already been merged into something. Nothing was changed.',
    };
  }

  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: absorbed.opportunityId,
    kind: 'MONETIZATION_PATHS_MERGED',
    actorRef: input.decidedByUserId,
    summary: `"${absorbed.title}" was merged into "${survivor.title}" — ${reason}`,
    detail: { absorbedId: absorbed.id, survivorId: survivor.id },
  });

  return {
    ok: true,
    value: { absorbed: { ...absorbed, mergedIntoId: survivor.id }, survivor },
  };
}

/** Undo a merge. The pointer is the whole of it, so clearing it is the whole reversal. */
export async function unmergePath(input: {
  projectId: string;
  pathId: string;
  decidedByUserId: string;
}): Promise<DecisionOutcome<MonetizationPath>> {
  const path = await getPath(input.pathId);
  if (!path || path.projectId !== input.projectId) {
    return { ok: false, reason: 'That possibility is not in this project.' };
  }
  if (!path.mergedIntoId) {
    return { ok: false, reason: 'That possibility is not merged into anything.' };
  }
  const moved = await setMergedInto({
    pathId: path.id,
    intoId: null,
    expectCurrent: path.mergedIntoId,
  });
  if (!moved) {
    return { ok: false, reason: 'It moved while this was being read. Nothing was changed.' };
  }
  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: path.opportunityId,
    kind: 'MONETIZATION_PATH_UNMERGED',
    actorRef: input.decidedByUserId,
    summary: `"${path.title}" is a separate possibility again.`,
    detail: { pathId: path.id, wasMergedInto: path.mergedIntoId },
  });
  return { ok: true, value: { ...path, mergedIntoId: null } };
}

/**
 * Say that one possibility is really several.
 *
 * Each child is a seeded path on the same subject carrying the method the
 * person named, pointing back at the parent it came out of. The parent is left
 * exactly as it is — not archived, not merged, not altered — because whether it
 * is still worth pursuing alongside its children is a question the ordinary
 * derivation answers, and deciding it here would be this function making a
 * judgement it was not asked for.
 */
export async function splitPath(input: {
  projectId: string;
  pathId: string;
  into: { method: MonetizationMethod; title?: string | null; thesis?: string | null }[];
  reason: string;
  decidedByUserId: string;
}): Promise<DecisionOutcome<MonetizationPath[]>> {
  const parent = await getPath(input.pathId);
  if (!parent || parent.projectId !== input.projectId) {
    return { ok: false, reason: 'That possibility is not in this project.' };
  }
  if (input.into.length < 2) {
    return { ok: false, reason: 'A split produces at least two possibilities.' };
  }
  const reason = input.reason.trim();
  if (!reason) return { ok: false, reason: 'Say why this is more than one possibility.' };

  const subjectTitle = parent.title;
  const children: MonetizationPath[] = [];
  for (const child of input.into) {
    const recorded = await recordPath({
      projectId: input.projectId,
      opportunityId: parent.opportunityId,
      industryNodeId: parent.industryNodeId,
      method: child.method,
      title: (child.title ?? '').trim() || titleFor(child.method, subjectTitle),
      thesis: (child.thesis ?? '').trim() || null,
      origin: 'SEED',
      splitFromId: parent.id,
    });
    /*
     * A child the enumeration had already produced keeps its row and gains the
     * lineage.
     *
     * `recordPath` is idempotent by (subject, method), so splitting into a
     * shape of transaction the table had already enumerated finds that row
     * rather than forking the ledger — which is right, and left the *split*
     * unrecorded on it. Running this is what found that: the history §20 asks
     * to be preserved was being preserved only for children that happened not
     * to exist yet.
     */
    if (!recorded.created && recorded.path.splitFromId === null) {
      await setSplitFrom(recorded.path.id, parent.id);
      children.push({ ...recorded.path, splitFromId: parent.id });
      continue;
    }
    children.push(recorded.path);
  }

  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: parent.opportunityId,
    kind: 'MONETIZATION_PATH_SPLIT',
    actorRef: input.decidedByUserId,
    summary: `"${parent.title}" was split into ${children.length} possibilities — ${reason}`,
    detail: { parentId: parent.id, childIds: children.map((one) => one.id) },
  });

  return { ok: true, value: children };
}

/**
 * Record a relation that is true of *these two* possibilities.
 *
 * The graph is derived from the method table, so almost everything §21 asks for
 * exists without a row: what enables what, what competes with what, what is the
 * cheaper thing to do first. What a derivation cannot have is a relation about
 * this situation — *this supplier will not deal through a broker*, *here, the
 * referral has to happen before the sale* — and this is the entrance for it.
 *
 * Without one the table had no writer at all, which is the failure this
 * repository keeps correcting: a mechanism nothing calls is not a mechanism,
 * and a `REQUIRES` that only a person can record is unreachable while nobody
 * can record one.
 *
 * It is the one thing here that can make a possibility **BLOCKED** by another,
 * which is why it is a person's: a derived requirement is a statement about two
 * methods and blocks nothing, and letting it block would put a fresh ledger
 * entirely into a state nobody established and nobody could act on.
 */
export async function linkPaths(input: {
  projectId: string;
  fromPathId: string;
  toPathId: string;
  kind: MonetizationEdgeKind;
  rationale: string;
  decidedByUserId: string;
}): Promise<DecisionOutcome<{ created: boolean }>> {
  const from = await getPath(input.fromPathId);
  const to = await getPath(input.toPathId);
  if (!from || from.projectId !== input.projectId) {
    return { ok: false, reason: 'That possibility is not in this project.' };
  }
  if (!to || to.projectId !== input.projectId) {
    return { ok: false, reason: 'That possibility is not in this project.' };
  }
  if (from.id === to.id) {
    return { ok: false, reason: 'A possibility cannot be related to itself.' };
  }
  if (from.opportunityId !== to.opportunityId || from.industryNodeId !== to.industryNodeId) {
    return {
      ok: false,
      reason:
        'These are ways of monetizing two different things. "Instead of" and "on the way to" ' +
        'mean nothing between them, so nothing was recorded.',
    };
  }
  const rationale = input.rationale.trim();
  if (!rationale) {
    return {
      ok: false,
      reason:
        'Say why this holds between these two in particular. The method table already says what ' +
        'is true of every pair of these shapes; a row here is for what it could not know.',
    };
  }

  const recorded = await recordEdge({
    projectId: input.projectId,
    fromPathId: from.id,
    toPathId: to.id,
    kind: input.kind,
    rationale,
    source: 'PERSON',
    decidedById: input.decidedByUserId,
  });

  if (recorded.created) {
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: from.opportunityId,
      kind: 'MONETIZATION_PATHS_LINKED',
      actorRef: input.decidedByUserId,
      summary: `"${from.title}" ${input.kind.toLowerCase().replace(/_/g, ' ')} "${to.title}" — ${rationale}`,
      detail: { fromPathId: from.id, toPathId: to.id, kind: input.kind },
    });
  }
  return { ok: true, value: { created: recorded.created } };
}

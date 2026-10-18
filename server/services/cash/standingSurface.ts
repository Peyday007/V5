/**
 * What the Cash page says about standing: the groups, the history, the
 * reconsiderations and the research progress (OPPORTUNITY-INTELLIGENCE §3.6).
 *
 * `standing.ts` decides each piece's standing. This module reads those answers
 * and the rows beside them into the shapes a person reads — and, separately,
 * into the shape a member reads. The second is **written field by field** (§34)
 * rather than filtered from the first: a member is told a piece's standing kind,
 * the blocker keys it waits or would reopen on, by name, and counts. Never a
 * figure, never a person's recorded reason, never the summary sentence the
 * owner's page carries, and nothing at all about a piece somebody has claimed.
 *
 * It writes nothing. Every reading is derived on the read path from rows that
 * already exist; the history is `CASH_OPPORTUNITY_STANDING` events, the
 * reconsiderations are the `cash_reconsideration_triggers` ledger, and the
 * research progress is the deep dive's own refusal per piece.
 */
import { getDb } from '../../db/database.ts';
import { cashNow } from '../../repos/cashMode.ts';
import { listOpportunities, RECONSIDERABLE_FROM } from '../../repos/cashPortfolio.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { parseJson } from '../../repos/util.ts';
import {
  BLOCKER_DETECTION,
  STANDING_KINDS,
  blockerKindOf,
  isBlockerKind,
  parseBlockerKey,
} from '../../domain/types.ts';
import type {
  CashCardFact,
  CashOpportunity,
  CashReopenCondition,
  Standing,
  StandingKind,
} from '../../domain/types.ts';
import { readStandingRows, STANDING_EVENT, type StandingRowsReading } from './standing.ts';
import { assemble } from './portfolio.ts';
import { cashPosition } from './money.ts';
import { authorityFor } from './opportunities.ts';
import { cashTier, type TierReading } from './tier.ts';
import { cashEngineCard } from './engineCard.ts';
import { evidenceCard } from './card.ts';
import { cashOutcomeLessons, measuredByMechanism } from './journey/learning.ts';
import type { DiveRefusal } from './validation.ts';

/** How many history rows per piece travel with the page. The total is reported beside them. */
export const HISTORY_SHOWN = 8;
/** How far back "reconsidered recently" reaches. */
export const RECONSIDERED_WINDOW_DAYS = 14;
/** The page size of the actionable list. A page, never a cap: every page is reachable. */
export const ACTIONABLE_PAGE_SIZE = 25;

/** States in which a piece is somebody's job, so its standing is theirs. */
const CLAIMED = new Set(['READY', 'EXECUTING', 'DELIVERING']);

/* --------------------------------------------------------------------------
 * Standings for a project, composed exactly as the owner's page composes them
 * ------------------------------------------------------------------------ */

/**
 * Every piece's standing, derived with the same inputs `cashView` passes
 * `assemble`: the tiers, the measured mechanism lessons, the real position, the
 * grant's concurrency and the standing rows.
 *
 * The member's frontier calls this; the owner's view passes its own placements'
 * standings instead, which are the same derivation over the same rows. The
 * shared projection redacts afterwards — what a member reads is a redaction of
 * the true answer, never an answer composed against an invented balance (the
 * `deployableCents: 0` defect §34 records).
 */
export async function standingsForProject(input: {
  projectId: string;
  opportunities?: readonly CashOpportunity[];
  rows?: StandingRowsReading;
}): Promise<Map<string, Standing>> {
  const out = new Map<string, Standing>();
  const { mode, authority } = await authorityFor(input.projectId);
  const opportunities = input.opportunities ?? (await listOpportunities({ projectId: input.projectId }));
  if (opportunities.length === 0) return out;
  const facts = new Map<string, CashCardFact[]>();
  for (const fact of await cardFactsForProject(input.projectId)) {
    facts.set(fact.opportunityId, [...(facts.get(fact.opportunityId) ?? []), fact]);
  }
  const tiers: Record<string, TierReading> = {};
  for (const opportunity of opportunities) {
    tiers[opportunity.id] = cashTier({
      opportunity,
      card: cashEngineCard({ opportunity, facts: facts.get(opportunity.id) ?? [] }),
      readiness: evidenceCard(opportunity).readiness,
    });
  }
  const rows = input.rows ?? (await readStandingRows(input.projectId, opportunities));
  const position = await cashPosition({
    projectId: input.projectId,
    currency: mode?.currency ?? 'USD',
  });
  const plan = assemble({
    opportunities: [...opportunities],
    tiers,
    measured: measuredByMechanism(await cashOutcomeLessons(input.projectId)),
    deployableCents: position.deployableCents,
    maxConcurrent: authority?.maxConcurrent ?? 0,
    discoveryOpen: mode?.state === 'ACTIVE',
    standingInputs: rows.standingInputs,
    diveRoom: rows.diveRoom,
  });
  for (const placement of plan.placements) out.set(placement.opportunity.id, placement.standing);
  return out;
}

/* --------------------------------------------------------------------------
 * Blocker groups
 * ------------------------------------------------------------------------ */

export interface BlockerGroup {
  /** The shared key (`CAPABILITY:SEND_A_MESSAGE`), or `SLOT` / `CASH`. */
  key: string;
  kind: string;
  count: number;
  opportunityIds: string[];
  /** "17 openings wait on CAPABILITY:SEND_A_MESSAGE." Composed here. */
  sentence: string;
  /** How a change to it is noticed, from `BLOCKER_DETECTION`, in words. */
  noticed: string;
  satisfiedWhen: string;
  /** Whether satisfying it can ever happen without a person. Null for SLOT and CASH. */
  automatic: boolean | null;
}

const DETECTION_WORDS: Record<string, string> = {
  READ: 'Brain reads the row that would change, on every pass.',
  MARKER: 'Brain compares a marker over the pool that would change.',
  CLOCK: 'Brain compares its own clock to the date.',
  NEVER: 'Only a person can say this has changed.',
  NOT_DETECTED: 'Nothing notices a change to this yet; a person has to say so.',
};

function describeKey(key: string): Pick<BlockerGroup, 'kind' | 'noticed' | 'satisfiedWhen' | 'automatic'> {
  if (key === 'SLOT') {
    return {
      kind: 'SLOT',
      noticed: 'Brain counts the free slots on every pass.',
      satisfiedWhen: 'a slot is free',
      automatic: null,
    };
  }
  if (key === 'CASH') {
    return {
      kind: 'CASH',
      noticed: 'Brain reads the ledger on every pass.',
      satisfiedWhen: 'enough is deployable',
      automatic: null,
    };
  }
  const parsed = parseBlockerKey(key);
  const kind = parsed ? blockerKindOf(parsed) : key.split(':')[0] ?? key;
  if (!isBlockerKind(kind)) {
    return { kind, noticed: 'An unrecognised key: nothing notices it.', satisfiedWhen: 'unknown', automatic: null };
  }
  const definition = BLOCKER_DETECTION[kind];
  return {
    kind,
    noticed: DETECTION_WORDS[definition.detection] ?? definition.detection,
    satisfiedWhen: definition.satisfiedWhen,
    automatic: definition.automatic,
  };
}

function group(
  entries: readonly { opportunityId: string; keys: readonly string[] }[],
  verb: (count: number, key: string) => string,
): BlockerGroup[] {
  const byKey = new Map<string, string[]>();
  for (const entry of entries) {
    for (const key of new Set(entry.keys)) {
      byKey.set(key, [...(byKey.get(key) ?? []), entry.opportunityId]);
    }
  }
  return [...byKey.entries()]
    .map(([key, ids]) => ({
      key,
      count: ids.length,
      opportunityIds: [...ids].sort(),
      sentence: verb(ids.length, key),
      ...describeKey(key),
    }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The pieces waiting on each shared fact, and the dormant pieces that would
 * reopen on each. One key is one fact (§3.2), so one group is one thing that,
 * if it changed, would move every piece in it.
 */
export function blockerGroups(
  entries: readonly { opportunityId: string; kind: StandingKind | null; keys: readonly string[] }[],
): { waitingOn: BlockerGroup[]; reopenOn: BlockerGroup[] } {
  return {
    waitingOn: group(
      entries.filter((one) => one.kind === 'WAITING'),
      (count, key) => `${count} ${count === 1 ? 'opening waits' : 'openings wait'} on ${key}.`,
    ),
    reopenOn: group(
      entries.filter((one) => one.kind === 'DORMANT'),
      (count, key) =>
        `${count} stopped ${count === 1 ? 'opening reopens' : 'openings reopen'} for consideration when ${key} changes.`,
    ),
  };
}

/* --------------------------------------------------------------------------
 * The shared standing of one piece
 * ------------------------------------------------------------------------ */

export interface SharedStanding {
  /** Null only when withheld. */
  kind: StandingKind | null;
  /** Why it is stopped, for DORMANT and NOT_WORTH_PURSUING; null otherwise. */
  cause: string | null;
  /** The keys it waits on (WAITING) or would reopen on (DORMANT), by name. */
  keys: string[];
  /** A sentence composed from the kind, the cause and the keys alone. */
  sentence: string;
  /** True for a piece somebody has claimed: how it is going is theirs. */
  withheld: boolean;
}

const SHARED_KIND_WORDS: Record<StandingKind, string> = {
  ADVANCING: 'Moving: something is being done about it now.',
  WAITING: 'Waiting on something named.',
  DORMANT: 'Stopped, with conditions that would reopen it.',
  NOT_WORTH_PURSUING: 'Stopped, and nothing was named that would reopen it.',
  DONE: 'Done: the money for it is in.',
};

const CAUSE_WORDS: Record<string, string> = {
  ARCHIVED: 'somebody stopped it',
  DECLINED: 'somebody passed on it',
  DISQUALIFIED: 'a published fact rules it out',
  ROUNDS_SPENT: 'its bounded deep dives for what is known now are spent; a new fact reopens it',
  EXPIRED: 'its closing date has passed',
  WEAK_ECONOMICS: 'the economics did not hold',
  DUPLICATE: 'it is a second record of another opening',
};

/**
 * One piece's standing as a member may read it.
 *
 * Three redactions, each with its reason: a claimed piece says nothing (its
 * standing is a fact about somebody's job); `CASH` never crosses (it is a fact
 * about somebody's balance); and the sentence is composed here from the kind,
 * the cause and the keys rather than reusing the owner's, which can quote a
 * person's archive reason, a declined reason or a figure.
 */
export function sharedStandingOf(opportunity: CashOpportunity, standing: Standing | undefined): SharedStanding {
  if (!standing || CLAIMED.has(opportunity.state)) {
    return {
      kind: null,
      cause: null,
      keys: [],
      sentence: 'Somebody has taken this on. How it is going is theirs.',
      withheld: true,
    };
  }
  const keys = (
    standing.kind === 'WAITING'
      ? (standing.on as readonly string[])
      : standing.kind === 'DORMANT'
        ? (standing.reopenWhen as readonly string[])
        : []
  ).filter((key) => key !== 'CASH');
  if (standing.kind === 'WAITING' && keys.length === 0) {
    return {
      kind: null,
      cause: null,
      keys: [],
      sentence: 'What this waits on belongs to whoever owns the operation.',
      withheld: true,
    };
  }
  const cause =
    standing.kind === 'DORMANT' || standing.kind === 'NOT_WORTH_PURSUING' ? standing.cause : null;
  const parts = [SHARED_KIND_WORDS[standing.kind]];
  if (cause) parts.push(`It stopped because ${CAUSE_WORDS[cause] ?? cause.toLowerCase()}.`);
  if (standing.kind === 'WAITING') parts.push(`It waits on ${keys.join(', ')}.`);
  if (standing.kind === 'DORMANT' && keys.length > 0) {
    parts.push(`It reopens for consideration when ${keys.join(', ')} changes.`);
  }
  if (standing.kind === 'DORMANT' && standing.reconsiderationRequested) {
    parts.push('A condition named for it has changed.');
  }
  return { kind: standing.kind, cause, keys: [...keys], sentence: parts.join(' '), withheld: false };
}

/* --------------------------------------------------------------------------
 * Standing history, from the events
 * ------------------------------------------------------------------------ */

export interface StandingHistoryEntry {
  at: string;
  kind: string;
  keys: string[];
  /** The owner's sentence as recorded. Null in the shared form. */
  because: string | null;
}

export interface StandingHistory {
  /** Newest first, at most `HISTORY_SHOWN` per piece. */
  entries: Record<string, StandingHistoryEntry[]>;
  /** How many events each piece has in total, so a cut list says it was cut. */
  totals: Record<string, number>;
}

function parseSignature(signature: unknown): { kind: string; keys: string[] } | null {
  if (typeof signature !== 'string' || !signature.includes('|')) return null;
  const [kind, rest] = signature.split('|', 2) as [string, string];
  return { kind, keys: rest ? rest.split(',').filter(Boolean) : [] };
}

/**
 * Each piece's recorded standing changes, newest first.
 *
 * `privateDetail` decides whether the recorded sentence travels; the shared
 * form carries the kind and the keys from the signature alone (CASH removed),
 * and nothing for a piece in `withhold`.
 */
export async function standingHistory(input: {
  projectId: string;
  privateDetail: boolean;
  withhold?: ReadonlySet<string>;
}): Promise<StandingHistory> {
  const rows = await getDb().all<{ opportunity_id: string; detail: string; created_at: string }>(
    `SELECT opportunity_id, detail, created_at FROM cash_events
      WHERE project_id = ? AND kind = ? AND opportunity_id IS NOT NULL
      ORDER BY created_at DESC, rowid DESC
      LIMIT 20000`,
    [input.projectId, STANDING_EVENT],
  );
  const entries: Record<string, StandingHistoryEntry[]> = {};
  const totals: Record<string, number> = {};
  for (const row of rows) {
    if (input.withhold?.has(row.opportunity_id)) continue;
    const detail = parseJson<Record<string, unknown>>(row.detail, {});
    const signature = parseSignature(detail['signature']);
    if (!signature) continue;
    totals[row.opportunity_id] = (totals[row.opportunity_id] ?? 0) + 1;
    const list = (entries[row.opportunity_id] ??= []);
    if (list.length >= HISTORY_SHOWN) continue;
    const standing = detail['standing'] as { because?: unknown } | undefined;
    list.push({
      at: row.created_at,
      kind: signature.kind,
      keys: input.privateDetail ? signature.keys : signature.keys.filter((key) => key !== 'CASH'),
      because:
        input.privateDetail && standing && typeof standing.because === 'string'
          ? standing.because
          : null,
    });
  }
  return { entries, totals };
}

/* --------------------------------------------------------------------------
 * Reconsidered recently
 * ------------------------------------------------------------------------ */

export type ReconsiderationOutcome = 'ADVANCED' | 'WAITING' | 'DORMANT_AGAIN' | 'UNKNOWN';

export interface ReconsideredEntry {
  opportunityId: string;
  title: string;
  at: string;
  /** What consumed the change: a reopen condition, a live request, or a person. */
  via: string;
  blockerKey: string | null;
  /** Where the piece stands now, read from its current standing. */
  outcome: ReconsiderationOutcome;
  /** The recorded summary of the event that carried it. Owner only: absent in the shared form. */
  summary?: string | null;
}

function outcomeOf(standing: Standing | undefined, withheld: boolean): ReconsiderationOutcome {
  if (!standing || withheld) return 'UNKNOWN';
  if (standing.kind === 'ADVANCING' || standing.kind === 'DONE') return 'ADVANCED';
  if (standing.kind === 'WAITING') return 'WAITING';
  return 'DORMANT_AGAIN';
}

/**
 * Every reconsideration in the window, from the consumed-change ledger.
 *
 * The ledger is authoritative because every path that reconsiders writes it —
 * the person's transition and the automatic triggers both — so this neither
 * double-counts a person's reconsideration nor misses one the reconsideration
 * engine wrote. The summary is joined from the event that names the same
 * change, where one does.
 */
export async function recentReconsiderations(input: {
  projectId: string;
  opportunities: readonly CashOpportunity[];
  standings: ReadonlyMap<string, Standing>;
  privateDetail: boolean;
  now?: string;
}): Promise<ReconsideredEntry[]> {
  const now = input.now ?? cashNow();
  const since = new Date(Date.parse(now) - RECONSIDERED_WINDOW_DAYS * 86_400_000).toISOString();
  const byId = new Map(input.opportunities.map((one) => [one.id, one]));
  const triggers = await getDb().all<{
    opportunity_id: string;
    change_ref: string;
    blocker_key: string | null;
    kind: string;
    created_at: string;
  }>(
    `SELECT opportunity_id, change_ref, blocker_key, kind, created_at
       FROM cash_reconsideration_triggers
      WHERE project_id = ? AND created_at >= ?
      ORDER BY created_at DESC, change_ref ASC
      LIMIT 200`,
    [input.projectId, since],
  );
  const summaries = new Map<string, string>();
  if (input.privateDetail && triggers.length > 0) {
    const events = await getDb().all<{ opportunity_id: string; summary: string; detail: string }>(
      `SELECT opportunity_id, summary, detail FROM cash_events
        WHERE project_id = ? AND created_at >= ?
          AND kind IN ('CASH_OPPORTUNITY_RECONSIDERED', 'CASH_RECONSIDERATION_TRIGGERED')`,
      [input.projectId, since],
    );
    for (const event of events) {
      const ref = parseJson<Record<string, unknown>>(event.detail, {})['changeRef'];
      if (typeof ref !== 'string') continue;
      summaries.set(`${event.opportunity_id}|${ref}`, event.summary);
      summaries.set(`${event.opportunity_id}|RECONSIDERED:${ref}`, event.summary);
    }
  }
  const out: ReconsideredEntry[] = [];
  for (const row of triggers) {
    const opportunity = byId.get(row.opportunity_id);
    if (!opportunity) continue;
    const withheld = !input.privateDetail && CLAIMED.has(opportunity.state);
    out.push({
      opportunityId: row.opportunity_id,
      title: opportunity.title,
      at: row.created_at,
      via: row.kind,
      blockerKey: withheld ? null : row.blocker_key,
      outcome: outcomeOf(input.standings.get(row.opportunity_id), withheld),
      ...(input.privateDetail
        ? { summary: summaries.get(`${row.opportunity_id}|${row.change_ref}`) ?? null }
        : {}),
    });
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Research progress
 * ------------------------------------------------------------------------ */

const REFUSAL_LABEL: Record<DiveRefusal['kind'], string> = {
  ELIGIBLE: 'eligible for a deep dive',
  IN_FLIGHT: 'a deep dive is running',
  AWAITING_PERSON: 'its dive stopped at a decision only a person can make',
  EPOCH_SPENT: 'both bounded dives for what is known now are spent; a new fact reopens it',
  STAGE_ONE_FAILED: 'the screen found no payer; a payer appearing reopens it',
  ALREADY_QUALIFIED: 'already qualified',
  DISQUALIFIED: 'a published fact rules it out',
  NOT_A_QUALIFYING_STATE: 'not in a state where the commercial questions are asked',
  NOTHING_PUBLISHED_TO_ASK_ABOUT: 'nothing published to ask a dive about',
  DUPLICATE: 'a second record of another opening',
  EXPIRED: 'its closing date has passed',
};

export interface ResearchProgress {
  sprint: {
    kind: string;
    inFlight: number | null;
    cap: number | null;
    free: number | null;
    sentence: string;
  };
  /** How many evaluating pieces each dive refusal accounts for. Counts only. */
  byRefusal: { kind: string; label: string; count: number }[];
  evaluating: number;
}

export function researchProgress(rows: StandingRowsReading): ResearchProgress {
  const counts = new Map<string, number>();
  for (const refusal of Object.values(rows.dives)) {
    counts.set(refusal.kind, (counts.get(refusal.kind) ?? 0) + 1);
  }
  const sprint = rows.sprint;
  const sentence =
    sprint.kind === 'READY'
      ? `${sprint.free} of ${sprint.cap} deep-dive slots are free.`
      : sprint.kind === 'SLOTS_TAKEN'
        ? `All ${sprint.cap} deep-dive slots are taken (${sprint.inFlight} in flight).`
        : sprint.kind === 'WOUND_DOWN'
          ? `No deep dive starts: ${sprint.reason}`
          : sprint.kind === 'NO_RESEARCH_AUTHORITY'
            ? 'No deep dive starts: no research authority is live for this project.'
            : 'No deep dive starts: Cash Mode is not active here.';
  return {
    sprint: {
      kind: sprint.kind,
      inFlight: sprint.kind === 'SLOTS_TAKEN' ? sprint.inFlight : null,
      cap: sprint.kind === 'SLOTS_TAKEN' || sprint.kind === 'READY' ? sprint.cap : null,
      free: sprint.kind === 'READY' ? sprint.free : null,
      sentence,
    },
    byRefusal: [...counts.entries()]
      .map(([kind, count]) => ({
        kind,
        label: REFUSAL_LABEL[kind as DiveRefusal['kind']] ?? kind,
        count,
      }))
      .sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1)),
    evaluating: Object.keys(rows.dives).length,
  };
}

/* --------------------------------------------------------------------------
 * Whether a person may reconsider a piece, decided here and not in a client
 * ------------------------------------------------------------------------ */

export interface ReconsiderEligibility {
  /** Whether the piece is in a state the reconsider transition accepts. */
  allowed: boolean;
  /** Why not, in the server's words; or what pressing it does. */
  reason: string;
  /** The met reopen condition the reconsideration answers, when there is one. */
  conditionId: string | null;
}

/**
 * The state half of the reconsider control's decision. The permission half is
 * `CashCapabilities.mayReconsider`, decided by `decideProjectAccess`; the page
 * offers the control only where both say yes, and the route re-decides both.
 */
export function reconsiderEligibility(
  opportunity: CashOpportunity,
  conditions: readonly CashReopenCondition[],
): ReconsiderEligibility {
  if (!RECONSIDERABLE_FROM.includes(opportunity.state)) {
    return {
      allowed: false,
      reason:
        opportunity.state === 'DISCOVERED' || opportunity.state === 'EVIDENCE_CARD'
          ? 'This is stopped by Brain’s own reading rather than by a person, so it is not ' +
            'reconsidered by hand: it is looked at again when a condition named for it changes.'
          : `This is ${opportunity.state.toLowerCase()}. Only a piece somebody archived or declined is reconsidered.`,
      conditionId: null,
    };
  }
  const met = [...conditions]
    .filter((one) => one.triggeredAt !== null)
    .sort((a, b) => ((a.triggeredAt ?? '') < (b.triggeredAt ?? '') ? 1 : -1))[0];
  return {
    allowed: true,
    reason: met
      ? `${met.blockerKey} changed. Reconsidering returns it to evaluation; every gate still applies.`
      : 'Reconsidering returns it to evaluation; every gate still applies before it can be ready.',
    conditionId: met?.id ?? null,
  };
}

/* --------------------------------------------------------------------------
 * The two surfaces
 * ------------------------------------------------------------------------ */

export interface SharedStandingSurface {
  byKind: Record<StandingKind, number>;
  /** Pieces whose standing a member is not told, because somebody has taken them on. */
  withheld: number;
  waitingOn: BlockerGroup[];
  reopenOn: BlockerGroup[];
  reconsidered: ReconsideredEntry[];
  history: StandingHistory;
  refinement: ResearchProgress;
}

export function emptyByKind(): Record<StandingKind, number> {
  return Object.fromEntries(STANDING_KINDS.map((kind) => [kind, 0])) as Record<StandingKind, number>;
}

/**
 * What every member reads about standing, from the shared standings.
 *
 * Built only from `SharedStanding` values, so nothing the redaction removed can
 * reach a group, a count or a list here.
 */
export async function sharedStandingSurface(input: {
  projectId: string;
  opportunities: readonly CashOpportunity[];
  standings: ReadonlyMap<string, Standing>;
  shared: ReadonlyMap<string, SharedStanding>;
  rows: StandingRowsReading;
  now?: string;
}): Promise<SharedStandingSurface> {
  const byKind = emptyByKind();
  let withheld = 0;
  const visible: { opportunityId: string; kind: StandingKind; keys: string[] }[] = [];
  for (const opportunity of input.opportunities) {
    const shared = input.shared.get(opportunity.id);
    if (!shared || shared.withheld || shared.kind === null) {
      withheld += 1;
      continue;
    }
    byKind[shared.kind] += 1;
    visible.push({ opportunityId: opportunity.id, kind: shared.kind, keys: shared.keys });
  }
  const withholdIds = new Set(
    input.opportunities.filter((one) => input.shared.get(one.id)?.withheld).map((one) => one.id),
  );
  return {
    byKind,
    withheld,
    ...blockerGroups(visible),
    reconsidered: await recentReconsiderations({
      projectId: input.projectId,
      opportunities: input.opportunities,
      standings: input.standings,
      privateDetail: false,
      ...(input.now ? { now: input.now } : {}),
    }),
    history: await standingHistory({
      projectId: input.projectId,
      privateDetail: false,
      withhold: withholdIds,
    }),
    refinement: researchProgress(input.rows),
  };
}

export interface OwnerStandingSurface {
  waitingOn: BlockerGroup[];
  reopenOn: BlockerGroup[];
  reconsidered: ReconsideredEntry[];
  history: StandingHistory;
  reopenConditions: Record<string, CashReopenCondition[]>;
  reconsider: Record<string, ReconsiderEligibility>;
  actionablePageSize: number;
}

/** The owner's reading: every piece, the recorded sentences, the conditions and the control. */
export async function ownerStandingSurface(input: {
  projectId: string;
  opportunities: readonly CashOpportunity[];
  standings: ReadonlyMap<string, Standing>;
  rows: StandingRowsReading;
  now?: string;
}): Promise<OwnerStandingSurface> {
  const entries = [...input.standings.entries()].map(([opportunityId, standing]) => ({
    opportunityId,
    kind: standing.kind,
    keys: (standing.kind === 'WAITING'
      ? standing.on
      : standing.kind === 'DORMANT'
        ? standing.reopenWhen
        : []) as readonly string[],
  }));
  const reopenConditions: Record<string, CashReopenCondition[]> = {};
  const reconsider: Record<string, ReconsiderEligibility> = {};
  for (const opportunity of input.opportunities) {
    const conditions = input.rows.standingInputs[opportunity.id]?.reopenConditions ?? [];
    if (conditions.length > 0) reopenConditions[opportunity.id] = [...conditions];
    const standing = input.standings.get(opportunity.id);
    if (standing?.kind === 'DORMANT' || standing?.kind === 'NOT_WORTH_PURSUING') {
      reconsider[opportunity.id] = reconsiderEligibility(opportunity, conditions);
    }
  }
  return {
    ...blockerGroups(entries),
    reconsidered: await recentReconsiderations({
      projectId: input.projectId,
      opportunities: input.opportunities,
      standings: input.standings,
      privateDetail: true,
      ...(input.now ? { now: input.now } : {}),
    }),
    history: await standingHistory({ projectId: input.projectId, privateDetail: true }),
    reopenConditions,
    reconsider,
    actionablePageSize: ACTIONABLE_PAGE_SIZE,
  };
}

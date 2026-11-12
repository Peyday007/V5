/**
 * Reconsideration: notice that a fact changed, and find every piece waiting on
 * it (OPPORTUNITY-INTELLIGENCE §3.2(c)–(f), assignment B).
 *
 * ---------------------------------------------------------------------------
 * What was missing
 * ---------------------------------------------------------------------------
 *
 * Nothing detected a change as an event that affects named opportunities. The
 * capability path re-read every capability once per live opportunity per tick
 * and the rest — a grant, a holding, a card fact, new evidence, a date passing,
 * a parent moving — were noticed by nobody, so a dead end stayed a dead end
 * whatever happened in the world.
 *
 * ---------------------------------------------------------------------------
 * Three rules
 * ---------------------------------------------------------------------------
 *
 *   * **Only a distinct change reconsiders, and it does so once.** Every change
 *     carries a deterministic `changeRef` built from the fact and the position
 *     it was read from (`CAPABILITY:SEND_A_MESSAGE@<previous watermark>`,
 *     `AUTHORITY:CONTACT_BUYER@<grant id>`, `FIELD:payer@<fact updated_at>` …),
 *     and A's `consumeChange` is keyed by `(opportunity_id, change_ref)`. So a
 *     replay, a restart mid-pass or two instances racing reconsider a piece
 *     once — and there is no count anywhere: if a hundred pieces share a
 *     blocker and it changes, all hundred become eligible, and a second,
 *     different change makes them eligible again.
 *   * **Reconsideration is not readiness.** A trigger moves no state. A live
 *     piece or a derived dead end gets `reconsider_requested_at` and returns to
 *     evaluation; every gate after that — the tier, `markReady`'s card gate,
 *     the commercial authority, `sendGate`, the capability reading — still
 *     applies. A piece a *person* archived or declined is never moved at all:
 *     one Needs-You request asks whether to look again, and A's guarded
 *     `reconsider` is the answer to it.
 *   * **The cost is the changes, not the portfolio.** Each source is read once
 *     per pass behind a watermark (capabilities: the eight readers, once;
 *     authorities: the one live grant; holdings: the held rows), or is driven
 *     by the watches themselves (card facts, dates, dependencies, evidence),
 *     and each changed key is fanned out with one indexed read over
 *     `cash_needs.blocker_key` (OPEN) and one over untriggered
 *     `cash_reopen_conditions`. An unchanged tick does a constant number of
 *     statements whatever the portfolio holds.
 *
 * Ordering is what makes it crash-safe. Detection only reads; the fan-out is
 * idempotent per change ref (each target is consumed, flagged and evented in
 * one transaction); the source events and the watermark move commit last, in
 * one transaction guarded by the watermark's compare-and-swap. A pass that dies
 * anywhere is replayed by the next one with the same refs.
 */
import { getDb } from '../../db/database.ts';
import { nowIso } from '../../repos/util.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import {
  advanceWatermark,
  consumeChange,
  getWatermark,
  recordReopenCondition,
  reopenConditionsForProject,
  retireSiblingConditions,
  triggerReopenCondition,
} from '../../repos/cashReconsideration.ts';
import { cardFactsFor } from '../../repos/cashCardFacts.ts';
import { liveAuthority } from '../../repos/cashAuthority.ts';
import { askHuman } from '../../repos/russellMissions.ts';
import { hostReachability } from '../../repos/research.ts';
import {
  blockerArgumentOf,
  blockerKindOf,
  formatBlockerKey,
  parseBlockerKey,
} from '../../domain/types.ts';
import type {
  BlockerKey,
  BlockerKind,
  CashOpportunity,
  CashReopenCondition,
  CashReopenConditionRow,
  RussellHumanRequest,
  Standing,
} from '../../domain/types.ts';
import { readAllCapabilities, type CapabilityReading } from './capabilities.ts';
import { cashEngineCard } from './engineCard.ts';
import { evidenceCard } from './card.ts';
import { CAPTURE_INPUTS, CAPTURE_KEY, cashTier } from './tier.ts';
import { ALSO_ANSWERS_BY_LANE, FIELD_BY_LANE } from './validation.ts';
import { closedBy } from './closing.ts';
import { requestDecisionRecompute } from '../../repos/cashDecisions.ts';

const BRAIN = 'BRAIN';

/** The event a capability change writes, once, beside the watermark that recorded it. */
export const CAPABILITY_CHANGED_EVENT = 'CASH_CAPABILITY_CHANGED';
/** The event each reconsideration writes, once, beside the consumption that made it. */
export const RECONSIDERATION_TRIGGERED_EVENT = 'CASH_RECONSIDERATION_TRIGGERED';

/** Watermark sources, one row each per project in `cash_change_watermarks`. */
export const RECONSIDER_SOURCES = Object.freeze({
  capabilities: 'reconsider:capabilities',
  authorities: 'reconsider:authorities',
  manufacturing: 'reconsider:manufacturing',
  evidence: 'reconsider:evidence',
  sourceHosts: 'reconsider:source-hosts',
});

/** The prefix of every Needs-You request this module raises. */
export const RECONSIDER_REQUEST_PREFIX = 'cash-reconsider:';

/** The two answers a person may give, each with a transition behind it. */
export const RECONSIDER_CHOICES = Object.freeze({
  RECONSIDER: {
    key: 'RECONSIDER',
    label: 'Look at it again',
    consequence:
      'It goes back to evaluation (discovered), with your reason and its history kept. Every gate ' +
      'still applies: nothing becomes ready, executes or spends anything because of this answer.',
  },
  KEEP: {
    key: 'KEEP',
    label: 'Keep it stopped',
    consequence:
      'It stays where you put it, with your reason kept. The condition stays recorded as met; a ' +
      'later, different change can ask again.',
  },
});

/**
 * Blocker kinds whose change makes a *live* piece holding an open need worth
 * re-evaluating.
 *
 * `FIELD` and `EVIDENCE` are deliberately absent. A need keyed by one is Brain's
 * own research about that piece, and the pass that raised it settles it the
 * moment the card answers (`reconcileDiscoverableGaps`). Flagging the piece as
 * well would turn every research answer into a new evaluation epoch, and an
 * answer from a re-evaluation would then flag it again — a loop that looks like
 * progress. A dormant piece watching the same keys is still triggered: there,
 * nothing else is looking.
 */
const LIVE_FLAG_KINDS: ReadonlySet<BlockerKind> = new Set([
  'CAPABILITY',
  'AUTHORITY',
  'MANUFACTURING',
  'SOURCE_HOST',
  'DEPENDENCY',
  'DATE',
]);

/** States a person put a piece in; a trigger on one asks them rather than moving it. */
const PERSONS_DECISION = new Set(['ARCHIVED', 'DECLINED']);

/**
 * Card facts that answer one card field under another name.
 *
 * `whyNotDiving` reads a disqualification from `disqualifiedBy`, and the
 * condition a disqualification records is `FIELD:disqualifiers` (the plan's
 * key). A new answer under either name is the same change.
 */
const FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  disqualifiers: ['disqualifiers', 'disqualifiedBy'],
});

/** The opportunity column a reopen condition can watch, as a FIELD key. */
export const EXPIRY_FIELD = 'expiresAt';

/* ------------------------------------------------------------------------ */
/* Detection                                                                 */
/* ------------------------------------------------------------------------ */

/** One fact that became true, and everything needed to find who waits on it. */
export interface Change {
  key: BlockerKey;
  /** Deterministic from the fact and the position read, so a replay is the same change. */
  changeRef: string;
  /**
   * When the fact became true, where a row says. A watch recorded after this
   * moment is not met by it — it was recorded already knowing. Null when the
   * moment is only "since the last pass" (a capability transition).
   */
  at: string | null;
  /** For a fact about one piece (a card field, its expiry), the only piece it can touch. */
  opportunityId?: string;
  /**
   * A capability's first reading. With no previous value, a condition is met
   * only if it recorded a different state when it was written.
   */
  initial?: boolean;
  detail: Record<string, unknown>;
}

interface PendingCommit {
  source: string;
  from: string | null;
  fromMarker: string | null;
  through: string;
  marker: string;
  events: { kind: string; summary: string; detail: Record<string, unknown> }[];
}

export interface Detection {
  /** Every capability, read once, for the capability-need pass to reuse. */
  readings: Map<string, CapabilityReading>;
  changes: Change[];
  /** Source events and watermark moves, committed after the fan-out. */
  commits: PendingCommit[];
}

/**
 * The SOURCE_HOST reading: every host a surface actually read (RETRIEVED) at
 * or after `since`, from Workstream D's `hostReachability` — claims' own
 * `retrieval_state` plus SURFACE_PROBE_V1 readings, the newest per host.
 *
 * Hosts are facts about the network rather than about one project, so the
 * reading is unscoped by surface; a host that came back for any surface is a
 * change worth asking about. Only RETRIEVED counts: a refusal is not a host
 * becoming reachable. `since` null (a first reading) looks back one day rather
 * than over all of history.
 */
export async function readSourceHostChanges(
  _projectId: string,
  since: string | null,
): Promise<{ host: string; at: string }[]> {
  const from = since ?? new Date(Date.now() - 86_400_000).toISOString();
  return (await hostReachability(null, from))
    .filter((reading) => reading.outcome === 'RETRIEVED' && reading.at >= from)
    .map((reading) => ({ host: reading.host, at: reading.at }));
}

function parseMarker(marker: string | null | undefined): Record<string, string> {
  if (!marker) return {};
  try {
    const parsed = JSON.parse(marker) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMarker(value: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key]!;
  return JSON.stringify(sorted);
}

function keyOrNull(kind: BlockerKind, argument: string): BlockerKey | null {
  return parseBlockerKey(`${kind}:${argument}`);
}

/**
 * The capability half: the eight readers, once, against the last recorded
 * value. A reader that could not answer (`UNKNOWN` for a capability Brain has
 * a word for) has not answered, so its previous value stands — an unreadable
 * reader is never a change.
 */
async function detectCapabilities(
  projectId: string,
  now: string,
  readings: Map<string, CapabilityReading>,
): Promise<{ changes: Change[]; commit: PendingCommit | null }> {
  const watermark = await getWatermark(projectId, RECONSIDER_SOURCES.capabilities);
  const previous = parseMarker(watermark?.marker);
  const current: Record<string, string> = { ...previous };
  for (const reading of readings.values()) {
    if (reading.state === 'UNKNOWN') continue;
    current[reading.id] = reading.state;
  }
  const changes: Change[] = [];
  const events: PendingCommit['events'] = [];
  for (const [id, state] of Object.entries(current)) {
    const before = previous[id] ?? null;
    if (watermark && before === state) continue;
    if (watermark) {
      events.push({
        kind: CAPABILITY_CHANGED_EVENT,
        summary: `${id} now reads ${state}${before ? ` (it read ${before})` : ''}.`,
        detail: { capability: id, from: before, to: state, readAt: now },
      });
    }
    if (state !== 'PRESENT') continue;
    const key = keyOrNull('CAPABILITY', id);
    if (!key) continue;
    changes.push({
      key,
      changeRef: `${key}@${watermark ? watermark.through : 'initial'}`,
      at: null,
      initial: !watermark,
      detail: { capability: id, from: before, to: state },
    });
  }
  const marker = writeMarker(current);
  if (watermark && marker === writeMarker(previous)) return { changes, commit: null };
  return {
    changes,
    commit: {
      source: RECONSIDER_SOURCES.capabilities,
      from: watermark?.through ?? null,
      fromMarker: watermark?.marker ?? null,
      through: now,
      marker,
      events,
    },
  };
}

/** The live grant's covered actions, against the last recorded set. */
async function detectAuthorities(
  projectId: string,
  now: string,
  clock: string,
): Promise<{ changes: Change[]; commit: PendingCommit | null }> {
  const watermark = await getWatermark(projectId, RECONSIDER_SOURCES.authorities);
  const previous = parseMarker(watermark?.marker);
  const grant = await liveAuthority(projectId, clock);
  const current: Record<string, string> = {};
  if (grant) {
    const prohibited = new Set(grant.prohibitions);
    for (const action of grant.allowedActions) {
      if (!prohibited.has(action)) current[action] = grant.id;
    }
  }
  const changes: Change[] = [];
  for (const [action, grantId] of Object.entries(current)) {
    if (previous[action] === grantId) continue;
    const key = keyOrNull('AUTHORITY', action);
    if (!key) continue;
    changes.push({
      key,
      changeRef: `${key}@${grantId}`,
      // A watch recorded after the grant was made was recorded knowing it.
      at: grant!.createdAt,
      detail: { action, grantId },
    });
  }
  const marker = writeMarker(current);
  if (watermark && marker === (watermark.marker ?? writeMarker({}))) return { changes, commit: null };
  return {
    changes,
    commit: {
      source: RECONSIDER_SOURCES.authorities,
      from: watermark?.through ?? null,
      fromMarker: watermark?.marker ?? null,
      through: now,
      marker,
      events: [],
    },
  };
}

/** Manufacturing capabilities a person declared held, against the last recorded set. */
async function detectManufacturing(
  projectId: string,
  now: string,
): Promise<{ changes: Change[]; commit: PendingCommit | null }> {
  const watermark = await getWatermark(projectId, RECONSIDER_SOURCES.manufacturing);
  const previous = parseMarker(watermark?.marker);
  const rows = await getDb().all<{ slug: string; held_at: string }>(
    `SELECT slug, held_at FROM capabilities
      WHERE project_id = ? AND held_at IS NOT NULL
      ORDER BY slug`,
    [projectId],
  );
  const current: Record<string, string> = {};
  for (const row of rows) current[row.slug] = row.held_at;
  const changes: Change[] = [];
  for (const [slug, heldAt] of Object.entries(current)) {
    if (previous[slug] === heldAt) continue;
    const key = keyOrNull('MANUFACTURING', slug);
    if (!key) continue;
    changes.push({ key, changeRef: `${key}@${heldAt}`, at: heldAt, detail: { slug, heldAt } });
  }
  const marker = writeMarker(current);
  if (watermark && marker === (watermark.marker ?? writeMarker({}))) return { changes, commit: null };
  return {
    changes,
    commit: {
      source: RECONSIDER_SOURCES.manufacturing,
      from: watermark?.through ?? null,
      fromMarker: watermark?.marker ?? null,
      through: now,
      marker,
      events: [],
    },
  };
}

/** A range over one blocker kind in the untriggered-conditions index. */
function kindRange(kind: BlockerKind): [string, string] {
  // ';' sorts directly after ':', so this is every `KIND:<anything>`.
  return [`${kind}:`, `${kind};`];
}

async function untriggeredOfKind(
  projectId: string,
  kind: BlockerKind,
): Promise<CashReopenConditionRow[]> {
  const [low, high] = kindRange(kind);
  return getDb().all<CashReopenConditionRow>(
    `SELECT * FROM cash_reopen_conditions
      WHERE project_id = ? AND triggered_at IS NULL
        AND blocker_key >= ? AND blocker_key < ?
      ORDER BY created_at, id`,
    [projectId, low, high],
  );
}

/**
 * Card facts and the expiry column, driven by the watches on them.
 *
 * A FIELD key is per opportunity by nature, so instead of scanning every fact
 * written since a watermark this asks only about the pieces watching a field:
 * one indexed read of the FIELD watches, then one read of those pieces' facts.
 */
async function detectFields(projectId: string, now: string): Promise<Change[]> {
  const watches = await untriggeredOfKind(projectId, 'FIELD');
  if (watches.length === 0) return [];
  const changes: Change[] = [];
  const opportunityIds = [...new Set(watches.map((one) => one.opportunity_id))];
  const facts = await getDb().all<{
    id: string;
    opportunity_id: string;
    field: string;
    updated_at: string;
  }>(
    `SELECT id, opportunity_id, field, updated_at FROM cash_card_facts
      WHERE opportunity_id IN (${opportunityIds.map(() => '?').join(', ')})`,
    opportunityIds,
  );
  const expiries = new Map<string, string | null>();
  if (watches.some((one) => one.blocker_key === `FIELD:${EXPIRY_FIELD}`)) {
    for (const row of await getDb().all<{ id: string; expires_at: string | null }>(
      `SELECT id, expires_at FROM cash_opportunities
        WHERE id IN (${opportunityIds.map(() => '?').join(', ')})`,
      opportunityIds,
    )) {
      expiries.set(row.id, row.expires_at);
    }
  }
  for (const watch of watches) {
    const key = parseBlockerKey(watch.blocker_key);
    if (!key) continue;
    const field = blockerArgumentOf(key)!;
    if (field === EXPIRY_FIELD) {
      /*
       * A new window: the closing date moved, and it is not already past. An
       * opening with no recorded date is not assumed open (invariant 39).
       */
      const expiresAt = expiries.get(watch.opportunity_id) ?? null;
      if (!expiresAt || expiresAt === (watch.observed_at_record ?? null)) continue;
      if (closedBy(expiresAt, now)) continue;
      changes.push({
        key,
        changeRef: `${key}@${expiresAt}`,
        at: null,
        opportunityId: watch.opportunity_id,
        detail: { field, expiresAt, was: watch.observed_at_record },
      });
      continue;
    }
    const names = FIELD_ALIASES[field] ?? [field];
    const newest = facts
      .filter((fact) => fact.opportunity_id === watch.opportunity_id && names.includes(fact.field))
      .filter((fact) => fact.updated_at > watch.created_at)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
    if (!newest) continue;
    changes.push({
      key,
      changeRef: `${key}@${newest.updated_at}`,
      at: newest.updated_at,
      opportunityId: watch.opportunity_id,
      detail: { field, factId: newest.id, factField: newest.field },
    });
  }
  return changes;
}

/** Dates in watched keys that Brain's own clock has passed. */
async function detectDates(projectId: string, now: string): Promise<Change[]> {
  const [low] = kindRange('DATE');
  // Every key whose date sorts at or before today-plus-a-day, then exactly by parse.
  const horizon = `DATE:${new Date(Date.parse(now) + 86_400_000).toISOString()}`;
  const keys = new Set<string>();
  for (const row of await getDb().all<{ blocker_key: string }>(
    `SELECT DISTINCT blocker_key FROM cash_reopen_conditions
      WHERE project_id = ? AND triggered_at IS NULL AND blocker_key >= ? AND blocker_key <= ?`,
    [projectId, low, horizon],
  )) {
    keys.add(row.blocker_key);
  }
  for (const row of await getDb().all<{ blocker_key: string }>(
    `SELECT DISTINCT blocker_key FROM cash_needs
      WHERE project_id = ? AND state = 'OPEN' AND blocker_key >= ? AND blocker_key <= ?`,
    [projectId, low, horizon],
  )) {
    keys.add(row.blocker_key);
  }
  const out: Change[] = [];
  for (const raw of keys) {
    const key = parseBlockerKey(raw);
    if (!key) continue;
    const date = blockerArgumentOf(key)!;
    if (Date.parse(date) > Date.parse(now)) continue;
    // A date passes once: the date itself is the change.
    out.push({ key, changeRef: key, at: null, detail: { date } });
  }
  return out;
}

/** A parent opportunity that moved since its child recorded where it was. */
async function detectDependencies(projectId: string): Promise<Change[]> {
  const watches = await untriggeredOfKind(projectId, 'DEPENDENCY');
  if (watches.length === 0) return [];
  const parents = [
    ...new Set(
      watches
        .map((one) => parseBlockerKey(one.blocker_key))
        .filter((key): key is BlockerKey => key !== null)
        .map((key) => blockerArgumentOf(key)!),
    ),
  ];
  const states = new Map<string, string>();
  for (const row of await getDb().all<{ id: string; state: string }>(
    `SELECT id, state FROM cash_opportunities
      WHERE project_id = ? AND id IN (${parents.map(() => '?').join(', ')})`,
    [projectId, ...parents],
  )) {
    states.set(row.id, row.state);
  }
  const out: Change[] = [];
  for (const watch of watches) {
    const key = parseBlockerKey(watch.blocker_key);
    if (!key) continue;
    const parent = blockerArgumentOf(key)!;
    const state = states.get(parent);
    if (!state || state === watch.observed_at_record) continue;
    out.push({
      key,
      changeRef: `${key}@${state}`,
      at: null,
      opportunityId: watch.opportunity_id,
      detail: { parent, state, was: watch.observed_at_record },
    });
  }
  return out;
}

/**
 * The citable pool, per lane, for the lanes somebody is watching.
 *
 * Read only when a watch on an `EVIDENCE:` key exists, so a project with none
 * reads nothing here. Own accepted claims count except those from a cash
 * opportunity's own deep dive: a dive establishing one opening's payer says
 * nothing about another's, and counting it would let one dive's answers
 * reconsider every spent piece waiting on that lane, whose dives would then
 * reconsider the first — an unbounded loop wearing distinct change refs.
 * Shared findings (§31) count, because a finding promoted to the Brain is a
 * fact about the world rather than about one opening.
 */
async function detectEvidence(
  projectId: string,
  now: string,
): Promise<{ changes: Change[]; commit: PendingCommit | null }> {
  const watches = await untriggeredOfKind(projectId, 'EVIDENCE');
  if (watches.length === 0) return { changes: [], commit: null };
  const lanes = [
    ...new Set(
      watches
        .map((one) => parseBlockerKey(one.blocker_key))
        .filter((key): key is BlockerKey => key !== null)
        .map((key) => blockerArgumentOf(key)!),
    ),
  ].sort();
  const lanePlaceholders = lanes.map(() => '?').join(', ');
  const dives = (
    await getDb().all<{ id: string }>(
      `SELECT DISTINCT validation_orchestration_id AS id FROM cash_opportunities
        WHERE project_id = ? AND validation_orchestration_id IS NOT NULL`,
      [projectId],
    )
  ).map((row) => row.id);
  const own = await getDb().all<{ lane: string; at: string }>(
    `SELECT c.evidence_lane AS lane, MAX(c.created_at) AS at
       FROM research_claims c
       JOIN research_orchestrations o ON o.id = c.orchestration_id
      WHERE o.project_id = ? AND c.accepted = 1 AND c.evidence_lane IN (${lanePlaceholders})
        ${dives.length > 0 ? `AND c.orchestration_id NOT IN (${dives.map(() => '?').join(', ')})` : ''}
      GROUP BY c.evidence_lane`,
    [projectId, ...lanes, ...dives],
  );
  const shared = await getDb().all<{ lane: string; at: string }>(
    `SELECT c.evidence_lane AS lane, MAX(s.promoted_at) AS at
       FROM shared_findings s
       JOIN research_claims c ON c.id = s.claim_id
      WHERE s.state = 'ACTIVE' AND c.evidence_lane IN (${lanePlaceholders})
      GROUP BY c.evidence_lane`,
    lanes,
  );
  const current: Record<string, string> = {};
  for (const row of [...own, ...shared]) {
    if (!row.at) continue;
    if (!current[row.lane] || current[row.lane]! < row.at) current[row.lane] = row.at;
  }
  const watermark = await getWatermark(projectId, RECONSIDER_SOURCES.evidence);
  const marker = writeMarker(current);
  const newestWatch = watches.reduce((max, one) => (one.created_at > max ? one.created_at : max), '');
  // Nothing moved in the pool and no watch is newer than the last pass: nothing to ask.
  if (watermark && watermark.marker === marker && watermark.through >= newestWatch) {
    return { changes: [], commit: null };
  }
  const changes: Change[] = [];
  for (const [lane, at] of Object.entries(current)) {
    const key = keyOrNull('EVIDENCE', lane);
    if (!key) continue;
    changes.push({ key, changeRef: `${key}@${at}`, at, detail: { lane, newestAt: at } });
  }
  return {
    changes,
    commit: {
      source: RECONSIDER_SOURCES.evidence,
      from: watermark?.through ?? null,
      fromMarker: watermark?.marker ?? null,
      through: now,
      marker,
      events: [],
    },
  };
}

async function detectSourceHosts(
  projectId: string,
  now: string,
): Promise<{ changes: Change[]; commit: PendingCommit | null }> {
  /*
   * Read only while something is watching a host: a project with no
   * SOURCE_HOST watch or open need reads nothing here, and the window is
   * bounded by the watermark, which moves on every pass that read.
   */
  const [low, high] = kindRange('SOURCE_HOST');
  const watched = await getDb().all<{ found: number }>(
    `SELECT 1 AS found FROM cash_reopen_conditions
      WHERE project_id = ? AND triggered_at IS NULL AND blocker_key >= ? AND blocker_key < ?
     UNION ALL
     SELECT 1 AS found FROM cash_needs
      WHERE project_id = ? AND state = 'OPEN' AND blocker_key >= ? AND blocker_key < ?`,
    [projectId, low, high, projectId, low, high],
  );
  if (watched.length === 0) return { changes: [], commit: null };
  const watermark = await getWatermark(projectId, RECONSIDER_SOURCES.sourceHosts);
  // A little behind the watermark, for a claim committed just after the last
  // pass read the clock; a re-read host has the same change ref.
  const since = watermark
    ? new Date(Date.parse(watermark.through) - 5 * 60_000).toISOString()
    : null;
  const readings = await readSourceHostChanges(projectId, since);
  const changes: Change[] = [];
  for (const reading of readings) {
    const key = keyOrNull('SOURCE_HOST', reading.host);
    if (!key) continue;
    changes.push({
      key,
      changeRef: `${key}@${reading.at}`,
      at: reading.at,
      detail: { host: reading.host, retrievedAt: reading.at },
    });
  }
  return {
    changes,
    commit: {
      source: RECONSIDER_SOURCES.sourceHosts,
      from: watermark?.through ?? null,
      fromMarker: watermark?.marker ?? null,
      through: now,
      marker: watermark?.marker ?? '',
      events: [],
    },
  };
}

/**
 * Every change since the last pass, per source. Reads only; writes nothing.
 *
 * `readings` may be passed in by a caller that already read the vocabulary;
 * otherwise the eight readers are asked here, once.
 */
export async function detectChanges(
  projectId: string,
  options: { now?: string; readings?: Map<string, CapabilityReading> } = {},
): Promise<Detection> {
  // `now` is the clock a date is compared with (a caller's, in a test that
  // walks time forward); `position` is where a watermark is left, which is a
  // place in the rows' own timestamps and so always the real clock.
  const now = options.now ?? nowIso();
  const position = nowIso();
  const readings = options.readings ?? (await readAllCapabilities());
  const changes: Change[] = [];
  const commits: PendingCommit[] = [];
  for (const source of [
    await detectCapabilities(projectId, position, readings),
    await detectAuthorities(projectId, position, now),
    await detectManufacturing(projectId, position),
    await detectEvidence(projectId, position),
    await detectSourceHosts(projectId, position),
  ]) {
    changes.push(...source.changes);
    if (source.commit) commits.push(source.commit);
  }
  changes.push(...(await detectFields(projectId, now)));
  changes.push(...(await detectDates(projectId, now)));
  changes.push(...(await detectDependencies(projectId)));
  return { readings, changes, commits };
}

/* ------------------------------------------------------------------------ */
/* Fan-out                                                                   */
/* ------------------------------------------------------------------------ */

export interface Triggered {
  opportunityId: string;
  key: BlockerKey;
  changeRef: string;
  /** NEED: a live piece's open need; DERIVED: a derived dead end; PERSON: asked, not moved. */
  via: 'NEED' | 'DERIVED' | 'PERSON';
  /** The Needs-You request raised, for a piece a person stopped. */
  requestId?: string | null;
}

/**
 * Set the flag on a piece nothing a person decided is being overruled on.
 *
 * Refuses an archived or declined piece in the statement, exactly as A's
 * `requestReconsideration` does.
 */
async function flag(opportunityId: string, changeRef: string, at: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE cash_opportunities
        SET reconsider_requested_at = ?, last_reconsider_change_ref = ?, updated_at = ?
      WHERE id = ? AND state NOT IN ('ARCHIVED', 'DECLINED')`,
    [at, changeRef, at, opportunityId],
  );
  return result.changes === 1;
}

/** Rolls back a target's transaction when one half did not land. Never escapes. */
class Lost extends Error {}

async function atomically<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await getDb().transaction(work);
  } catch (error) {
    if (error instanceof Lost) return null;
    throw error;
  }
}

async function openRequestForOpportunity(
  projectId: string,
  opportunityId: string,
): Promise<string | null> {
  const prefix = `${RECONSIDER_REQUEST_PREFIX}${opportunityId}:`;
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM russell_human_requests
      WHERE project_id = ? AND state = 'OPEN' AND substr(resume_key, 1, ?) = ?
      ORDER BY created_at, id`,
    [projectId, prefix.length, prefix],
  );
  return rows[0]?.id ?? null;
}

async function askPerson(
  projectId: string,
  opportunity: { id: string; title: string; state: string },
  condition: CashReopenCondition,
  change: Change,
): Promise<string> {
  const open = await openRequestForOpportunity(projectId, opportunity.id);
  if (open) return open;
  const stopped = opportunity.state === 'DECLINED' ? 'passed on' : 'archived';
  const { request } = await askHuman({
    projectId,
    authorityNeeded: `Reconsider "${opportunity.title}"? The condition you named changed.`,
    whyNotRussell:
      `You ${stopped} this and named ${condition.blockerKey} as what would justify looking again. ` +
      `That changed (${change.changeRef}). Brain never reverses a person's decision by itself, so ` +
      'it is asking rather than moving it.',
    recommendation: null,
    choices: [RECONSIDER_CHOICES.RECONSIDER, RECONSIDER_CHOICES.KEEP],
    urgency: 'WHENEVER',
    resumeKey: `${RECONSIDER_REQUEST_PREFIX}${opportunity.id}:${condition.id}`,
  });
  return request.id;
}

async function triggeredEvent(
  projectId: string,
  target: Triggered,
  change: Change,
): Promise<void> {
  await recordCashEvent({
    projectId,
    opportunityId: target.opportunityId,
    kind: RECONSIDERATION_TRIGGERED_EVENT,
    actorRef: BRAIN,
    summary:
      target.via === 'PERSON'
        ? `${target.key} changed; you are asked whether to look at this again. Nothing moved.`
        : `${target.key} changed, so this goes back to evaluation. No gate is skipped.`,
    detail: {
      key: target.key,
      change: target.changeRef,
      via: target.via,
      requestId: target.requestId ?? null,
      ...change.detail,
    },
  });
}

async function openNeedsForKey(
  projectId: string,
  key: BlockerKey,
  opportunityId: string | undefined,
): Promise<{ id: string; opportunity_id: string; created_at: string }[]> {
  return getDb().all(
    `SELECT id, opportunity_id, created_at FROM cash_needs
      WHERE project_id = ? AND blocker_key = ? AND state = 'OPEN'
        AND opportunity_id IS NOT NULL${opportunityId ? ' AND opportunity_id = ?' : ''}
      ORDER BY created_at, id`,
    opportunityId ? [projectId, key, opportunityId] : [projectId, key],
  );
}

async function conditionsForKey(
  projectId: string,
  key: BlockerKey,
  opportunityId: string | undefined,
): Promise<CashReopenConditionRow[]> {
  return getDb().all<CashReopenConditionRow>(
    `SELECT * FROM cash_reopen_conditions
      WHERE project_id = ? AND blocker_key = ? AND triggered_at IS NULL${
        opportunityId ? ' AND opportunity_id = ?' : ''
      }
      ORDER BY created_at, id`,
    opportunityId ? [projectId, key, opportunityId] : [projectId, key],
  );
}

function asCondition(row: CashReopenConditionRow): CashReopenCondition | null {
  const key = parseBlockerKey(row.blocker_key);
  if (!key) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    opportunityId: row.opportunity_id,
    blockerKey: key,
    recordedFrom: row.recorded_from as CashReopenCondition['recordedFrom'],
    observedAtRecord: row.observed_at_record,
    actorRef: row.actor_ref,
    createdAt: row.created_at,
    triggeredAt: row.triggered_at,
    triggerChangeRef: row.trigger_change_ref,
  };
}

/** Whether a watch recorded at `createdAt` is met by this change. */
function meets(change: Change, condition: CashReopenCondition): boolean {
  if (change.initial) return condition.observedAtRecord !== 'PRESENT';
  if (change.at === null) return true;
  return condition.createdAt < change.at;
}

/**
 * Find everyone waiting on each change, and reconsider each of them once.
 *
 * One indexed read per changed key over open needs, one over untriggered
 * reopen conditions, and one to learn the affected pieces' states. Each target
 * is consumed, flagged or asked, and evented in one transaction, so a replay
 * finds the change already consumed and writes nothing.
 */
export async function fanOut(
  projectId: string,
  detection: Pick<Detection, 'changes'>,
  options: { now?: string } = {},
): Promise<Triggered[]> {
  const at = options.now ?? nowIso();
  const out: Triggered[] = [];
  for (const change of detection.changes) {
    const kind = blockerKindOf(change.key);

    if (LIVE_FLAG_KINDS.has(kind)) {
      const needs = await openNeedsForKey(projectId, change.key, change.opportunityId);
      const seen = new Set<string>();
      for (const need of needs) {
        if (seen.has(need.opportunity_id)) continue;
        seen.add(need.opportunity_id);
        if (change.at !== null && need.created_at >= change.at) continue;
        const target: Triggered = {
          opportunityId: need.opportunity_id,
          key: change.key,
          changeRef: change.changeRef,
          via: 'NEED',
        };
        const landed = await atomically(async () => {
          const consumed = await consumeChange({
            projectId,
            opportunityId: need.opportunity_id,
            changeRef: change.changeRef,
            blockerKey: change.key,
            kind: 'LIVE_REQUEST',
            at,
          });
          if (!consumed) return false;
          if (!(await flag(need.opportunity_id, change.changeRef, at))) throw new Lost();
          await triggeredEvent(projectId, target, change);
          return true;
        });
        if (landed) out.push(target);
      }
    }

    const conditions = (await conditionsForKey(projectId, change.key, change.opportunityId))
      .map(asCondition)
      .filter((one): one is CashReopenCondition => one !== null)
      .filter((one) => meets(change, one));
    if (conditions.length === 0) continue;
    const ids = [...new Set(conditions.map((one) => one.opportunityId))];
    const pieces = new Map<string, { id: string; title: string; state: string }>();
    for (const row of await getDb().all<{ id: string; title: string; state: string }>(
      `SELECT id, title, state FROM cash_opportunities WHERE id IN (${ids.map(() => '?').join(', ')})`,
      ids,
    )) {
      pieces.set(row.id, row);
    }
    for (const condition of conditions) {
      const piece = pieces.get(condition.opportunityId);
      if (!piece) continue;
      const person = PERSONS_DECISION.has(piece.state);
      const target: Triggered = {
        opportunityId: piece.id,
        key: change.key,
        changeRef: change.changeRef,
        via: person ? 'PERSON' : 'DERIVED',
      };
      const landed = await atomically(async () => {
        if (!(await triggerReopenCondition({ conditionId: condition.id, changeRef: change.changeRef, at }))) {
          return false;
        }
        if (person) {
          target.requestId = await askPerson(projectId, piece, condition, change);
        } else {
          if (!(await flag(piece.id, change.changeRef, at))) throw new Lost();
          // One reopening per dormancy: its other watches stop guarding it.
          await retireSiblingConditions({
            opportunityId: piece.id,
            exceptConditionId: condition.id,
            changeRef: change.changeRef,
            at,
          });
        }
        await triggeredEvent(projectId, target, change);
        return true;
      });
      if (landed) out.push(target);
    }
  }
  return out;
}

/**
 * Write each source's events and move its watermark, one transaction per
 * source, guarded on the position detection read. A loser wrote nothing and
 * the next pass reads from where the winner left it.
 */
export async function commitDetection(
  projectId: string,
  detection: Pick<Detection, 'commits'>,
): Promise<string[]> {
  const moved: string[] = [];
  for (const commit of detection.commits) {
    const ok = await atomically(async () => {
      for (const event of commit.events) {
        await recordCashEvent({
          projectId,
          kind: event.kind,
          actorRef: BRAIN,
          summary: event.summary,
          detail: event.detail,
        });
      }
      const advanced = await advanceWatermark({
        projectId,
        source: commit.source,
        from: commit.from,
        through: commit.through,
        marker: commit.marker,
        ...(commit.from !== null ? { fromMarker: commit.fromMarker } : {}),
        at: commit.through,
      });
      if (!advanced) throw new Lost();
      return true;
    });
    if (ok) moved.push(commit.source);
  }
  return moved;
}

export interface ReconsiderPass {
  /** The vocabulary, read once, for the capability-need pass. */
  readings: Map<string, CapabilityReading>;
  changes: number;
  triggered: Triggered[];
  watermarksMoved: string[];
}

/**
 * The operating loop's reconsideration pass: detect, fan out, commit.
 *
 * Runs in every sprint state. A wound-down sprint still records what changed
 * and still flags or asks — writing down history is not new discovery — and
 * starts nothing: a re-dive is the validation pass's decision, and it refuses a
 * sprint that is not active.
 */
export async function reconsiderAffected(
  projectId: string,
  options: { now?: string } = {},
): Promise<ReconsiderPass> {
  const now = options.now ?? nowIso();
  const detection = await detectChanges(projectId, { now });
  const triggered = await fanOut(projectId, detection, { now });
  // A reopened piece's goal decisions are recomputed for this change, once. A
  // piece a person stopped is only asked about, and is never decided over.
  for (const target of triggered) {
    if (target.via !== 'PERSON') await requestDecisionRecompute(target.opportunityId, target.changeRef, now);
  }
  const watermarksMoved = await commitDetection(projectId, detection);
  return { readings: detection.readings, changes: detection.changes.length, triggered, watermarksMoved };
}

/* ------------------------------------------------------------------------ */
/* Derived dead ends record what would reopen them                           */
/* ------------------------------------------------------------------------ */

const FIELD_LANE: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  for (const [lane, field] of Object.entries(FIELD_BY_LANE)) if (!out.has(field)) out.set(field, lane);
  for (const [lane, field] of Object.entries(ALSO_ANSWERS_BY_LANE)) if (!out.has(field)) out.set(field, lane);
  return out;
})();

export interface DerivedCondition {
  opportunityId: string;
  recordedFrom: 'DISQUALIFY' | 'ROUNDS_SPENT' | 'EXPIRY';
  keys: BlockerKey[];
}

/**
 * Give every derived dead end the watch that could reopen it. Idempotent.
 *
 *   * DISQUALIFIED → `FIELD:disqualifiers`: a new answer about what rules it out.
 *   * ROUNDS_SPENT → `EVIDENCE:<lane>` for each unanswered field the next tier
 *     needs that a validation lane answers.
 *   * EXPIRED → `FIELD:expiresAt`, recording the date it closed on, so a new
 *     window is a different date.
 *
 * Read from the standing already composed this pass, so it costs nothing for a
 * piece that is not dormant, and only for a dormant piece holding no live watch
 * from that cause. A watch is recorded once per dormancy: after a distinct
 * change triggers it and the piece is still where it was, the next pass
 * records a fresh one — which only another distinct change can meet.
 */
export async function recordDerivedReopenConditions(
  projectId: string,
  standings: ReadonlyMap<string, { opportunity: CashOpportunity; standing: Standing }>,
): Promise<DerivedCondition[]> {
  const causes = new Map<string, DerivedCondition['recordedFrom']>();
  for (const [id, { standing }] of standings) {
    // A derived dead end with no watch reads NOT_WORTH_PURSUING — which is
    // exactly the piece that needs one recorded.
    if (standing.kind !== 'DORMANT' && standing.kind !== 'NOT_WORTH_PURSUING') continue;
    if (standing.cause === 'DISQUALIFIED') causes.set(id, 'DISQUALIFY');
    else if (standing.cause === 'ROUNDS_SPENT') causes.set(id, 'ROUNDS_SPENT');
    else if (standing.cause === 'EXPIRED') causes.set(id, 'EXPIRY');
  }
  if (causes.size === 0) return [];
  const live = new Set<string>();
  for (const condition of await reopenConditionsForProject(projectId)) {
    if (condition.triggeredAt === null) live.add(`${condition.opportunityId}|${condition.recordedFrom}`);
  }
  const out: DerivedCondition[] = [];
  for (const [id, recordedFrom] of causes) {
    if (live.has(`${id}|${recordedFrom}`)) continue;
    const opportunity = standings.get(id)!.opportunity;
    const keys: { key: BlockerKey; observed: string | null }[] = [];
    if (recordedFrom === 'DISQUALIFY') {
      keys.push({ key: formatBlockerKey('FIELD', 'disqualifiers'), observed: null });
    } else if (recordedFrom === 'EXPIRY') {
      keys.push({ key: formatBlockerKey('FIELD', EXPIRY_FIELD), observed: opportunity.expiresAt });
    } else {
      const tier = cashTier({
        opportunity,
        card: cashEngineCard({ opportunity, facts: await cardFactsFor(opportunity.id) }),
        readiness: evidenceCard(opportunity).readiness,
      });
      /*
       * What the next tier still needs. The capture thesis is composed rather
       * than researched, so in its place stand the card fields it is composed
       * from that are still blank — the payer, above all.
       */
      const card = evidenceCard(opportunity);
      const wanted = new Set<string>();
      for (const requirement of tier.toAdvance) {
        if (requirement.key === CAPTURE_KEY) {
          for (const input of CAPTURE_INPUTS) {
            if (card.fields.find((field) => field.key === input)?.value === null) wanted.add(input);
          }
        } else {
          wanted.add(requirement.key);
        }
      }
      const lanes = new Set<string>();
      for (const field of wanted) {
        const lane = FIELD_LANE.get(field);
        if (lane) lanes.add(lane);
      }
      for (const lane of [...lanes].sort()) {
        const key = keyOrNull('EVIDENCE', lane);
        if (key) keys.push({ key, observed: null });
      }
    }
    if (keys.length === 0) continue;
    for (const { key, observed } of keys) {
      await recordReopenCondition({
        projectId,
        opportunityId: id,
        blockerKey: key,
        recordedFrom,
        observedAtRecord: observed,
        actorRef: BRAIN,
      });
    }
    out.push({ opportunityId: id, recordedFrom, keys: keys.map((one) => one.key) });
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* The answer to a Needs-You request                                         */
/* ------------------------------------------------------------------------ */

/**
 * Carry out a person's answer to "the condition you named changed —
 * reconsider?".
 *
 * RECONSIDER is A's guarded `reconsider`, naming the condition that was met,
 * attributed to the person who answered. KEEP changes nothing and says so on
 * the history. Either way the request is settled: a refusal because the piece
 * moved meanwhile is an answer to a question that no longer stands.
 */
export async function resumeReconsiderRequest(
  request: RussellHumanRequest,
): Promise<{ ok: boolean; reason: string; settled: boolean }> {
  const rest = request.resumeKey.slice(RECONSIDER_REQUEST_PREFIX.length);
  const separator = rest.lastIndexOf(':');
  if (separator <= 0) return { ok: false, reason: 'the request names no opportunity', settled: true };
  const opportunityId = rest.slice(0, separator);
  const conditionId = rest.slice(separator + 1);
  if (!request.answeredByUserId) {
    return { ok: false, reason: 'nobody is recorded as answering', settled: false };
  }
  if (request.answeredChoice === RECONSIDER_CHOICES.RECONSIDER.key) {
    const { reconsider } = await import('./opportunities.ts');
    const outcome = await reconsider({
      opportunityId,
      actorUserId: request.answeredByUserId,
      reason:
        request.answeredReason?.trim() ||
        'The condition named when it was stopped changed, and the person chose to look again.',
      conditionId,
    });
    return {
      ok: outcome.ok,
      reason: outcome.ok ? 'reconsidered, as asked' : outcome.reason,
      settled: true,
    };
  }
  await recordCashEvent({
    projectId: request.projectId,
    opportunityId,
    kind: 'CASH_RECONSIDERATION_KEPT',
    actorRef: request.answeredByUserId,
    summary: 'Asked whether to look at this again, and kept it stopped.',
    detail: { conditionId, requestId: request.id, reason: request.answeredReason ?? null },
  });
  return { ok: true, reason: 'kept stopped, as asked', settled: true };
}

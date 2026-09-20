/**
 * The Faculty Realization Packet: one mission's living state.
 *
 * ---------------------------------------------------------------------------
 * What a packet is, and what it is not
 * ---------------------------------------------------------------------------
 *
 * It is not a report. A report is regenerated, so it has no history, and the
 * two questions somebody asks when a realization goes wrong — *when did Brain
 * decide this had to be built* and *what did it believe before the research
 * came back* — are both unanswerable from one.
 *
 * So a packet is a row, its sections are versioned rows beside it, and reading
 * the packet means taking the newest version of each section. Nothing is
 * overwritten and no section is deleted.
 *
 * ---------------------------------------------------------------------------
 * Three of the ten sections are derived and seven are not
 * ---------------------------------------------------------------------------
 *
 * `CAPABILITY_MAP`, `CURRENT_STATE` and `IMPLEMENTATION_GAPS` are computed from
 * rows — the promoted definition, the self-model reading, and the gap calculus
 * over both. Re-running produces the same thing, which is what `DERIVED` means.
 *
 * The other seven need a reader: a target topology, an information-supply map,
 * a cognitive contract and an evaluation graph are designs rather than
 * readings. Brain composes the *questions* for them and answers none of them,
 * for §29's reason — a Brain that filled them in from a template would be
 * manufacturing insight at the one altitude where it is most tempting.
 *
 * A section nobody has written is **absent**, and `missingSections` names which.
 * An empty section written by a template would be indistinguishable from an
 * answered one to every reader downstream.
 *
 * ---------------------------------------------------------------------------
 * Opening a packet decides nothing about the faculty
 * ---------------------------------------------------------------------------
 *
 * Opening one moves no dimension on the faculty. `implementation_state` stays
 * `ABSENT` until something that is actually about code moves it, exactly as
 * ingesting the blueprint left it there. A packet is Brain intending to work on
 * something, and intending is not having.
 */
import { getDb } from '../../db/database.ts';
import { newId, nowIso, parseJson, toJson } from '../../repos/util.ts';
import { getFaculty, listFaculties, type Faculty } from '../../repos/faculties.ts';
import { latestScan, listComponents, scanSystem } from '../selfmodel/scan.ts';
import { deriveGaps, summarize, type DerivedGap, type GapKind, type GapSummary } from './gaps.ts';

export const PACKET_SECTIONS = [
  'CAPABILITY_MAP',
  'CURRENT_STATE',
  'TARGET_TOPOLOGY',
  'INFORMATION_SUPPLY',
  'KNOWLEDGE_COMPILATION',
  'COGNITIVE_CONTRACT',
  'IMPLEMENTATION_GAPS',
  'FACTORY_DEPENDENCIES',
  'EVALUATION_GRAPH',
  'CAPABILITY_REGISTRATION',
] as const;
export type PacketSection = (typeof PACKET_SECTIONS)[number];

/** The three Brain computes. Everything else needs a reader; see the header. */
export const DERIVED_SECTIONS: readonly PacketSection[] = [
  'CAPABILITY_MAP',
  'CURRENT_STATE',
  'IMPLEMENTATION_GAPS',
];

export const PACKET_STATES = [
  'DRAFT',
  'RESEARCHING',
  'READY',
  'BUILDING',
  'EVALUATING',
  'REALIZED',
  'BLOCKED',
  'ABANDONED',
] as const;
export type PacketState = (typeof PACKET_STATES)[number];

const TERMINAL: ReadonlySet<PacketState> = new Set(['REALIZED', 'ABANDONED']);

export interface RealizationPacket {
  id: string;
  facultyId: string;
  state: PacketState;
  blocker: string | null;
  scanId: string | null;
  campaignId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PacketSectionRow {
  id: string;
  packetId: string;
  section: PacketSection;
  version: number;
  content: unknown;
  authorKind: 'DERIVED' | 'PROPOSED' | 'ACCEPTED';
  evidence: string;
  createdAt: string;
}

export interface PacketGap extends DerivedGap {
  id: string;
  derivedBy: 'BRAIN' | 'WORKER' | 'PERSON';
  state: 'OPEN' | 'ASSIGNED' | 'CLOSED' | 'WAIVED';
  stateReason: string | null;
  carriedBy: string | null;
}

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  return String(row[key] ?? '');
}
function nullable(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function mapPacket(row: Row): RealizationPacket {
  return {
    id: text(row, 'id'),
    facultyId: text(row, 'faculty_id'),
    state: text(row, 'state') as PacketState,
    blocker: nullable(row, 'blocker'),
    scanId: nullable(row, 'scan_id'),
    campaignId: nullable(row, 'campaign_id'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

function mapGap(row: Row): PacketGap {
  return {
    id: text(row, 'id'),
    requirement: text(row, 'requirement'),
    aspect: text(row, 'aspect'),
    kind: text(row, 'kind') as GapKind,
    componentKey: nullable(row, 'component_key'),
    evidence: text(row, 'evidence'),
    derivedBy: text(row, 'derived_by') as PacketGap['derivedBy'],
    state: text(row, 'state') as PacketGap['state'],
    stateReason: nullable(row, 'state_reason'),
    carriedBy: nullable(row, 'carried_by'),
  };
}

/* ------------------------------------------------------------------------- */
/* Opening one                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Open a packet for a faculty, or hand back the live one.
 *
 * Idempotent by the faculty's live packet rather than by a flag: asking twice
 * for the same faculty is one packet, which is what makes this safe to call
 * from a tick. A faculty whose definition is not canonical is refused — there
 * is nothing to hold against the system, and a packet built from a draft would
 * be planning against a definition nobody audited.
 */
export async function openPacket(input: {
  facultyId: string;
  createdByType: string;
  createdById?: string | null;
}): Promise<{ packet: RealizationPacket; created: boolean }> {
  const faculty = await getFaculty(input.facultyId);
  if (!faculty) throw new Error(`No such faculty: ${input.facultyId}`);
  if (faculty.definitionState !== 'CANONICAL') {
    throw new Error(
      `${faculty.canonicalName}'s definition is ${faculty.definitionState}. A packet planned ` +
        'against a definition nobody audited would be holding the system against a draft.',
    );
  }

  const live = await livePacketFor(input.facultyId);
  if (live) return { packet: live, created: false };

  const id = newId('rlp');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO realization_packets
       (id, faculty_id, state, blocker, scan_id, campaign_id, created_by_type, created_by_id,
        created_at, updated_at)
     VALUES (?, ?, 'DRAFT', NULL, NULL, NULL, ?, ?, ?, ?)`,
    [id, input.facultyId, input.createdByType, input.createdById ?? null, at, at] as never[],
  );
  const packet = await getPacket(id);
  if (!packet) throw new Error('The packet was inserted and could not be read back.');
  return { packet, created: true };
}

export async function getPacket(id: string): Promise<RealizationPacket | null> {
  const row = await getDb().get<Row>(
    `SELECT * FROM realization_packets WHERE id = ?`,
    [id] as never[],
  );
  return row ? mapPacket(row) : null;
}

/** The packet currently being worked, if any. Terminal ones are not live. */
export async function livePacketFor(facultyId: string): Promise<RealizationPacket | null> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM realization_packets WHERE faculty_id = ? ORDER BY created_at DESC, id DESC`,
    [facultyId] as never[],
  );
  for (const row of rows) {
    const packet = mapPacket(row);
    if (!TERMINAL.has(packet.state)) return packet;
  }
  return null;
}

export async function listPackets(states?: PacketState[]): Promise<RealizationPacket[]> {
  const rows = await getDb().all<Row>(
    states && states.length > 0
      ? `SELECT * FROM realization_packets WHERE state IN (${states.map(() => '?').join(',')})
         ORDER BY updated_at DESC, id DESC`
      : `SELECT * FROM realization_packets ORDER BY updated_at DESC, id DESC`,
    (states ?? []) as never[],
  );
  return rows.map(mapPacket);
}

/**
 * Move a packet's state, naming the state it came from.
 *
 * A compare-and-swap for the reason every other transition in this codebase is
 * one: two ticks reading one `DRAFT` packet must produce one advance. The loser
 * gets `false`, which is an ordinary outcome.
 */
export async function advance(input: {
  id: string;
  from: PacketState;
  to: PacketState;
  blocker?: string | null;
  campaignId?: string | null;
}): Promise<boolean> {
  if (input.to === 'BLOCKED' && !input.blocker) {
    throw new Error(
      'A packet may not be blocked without naming what is blocking it and a remedy. A state ' +
        'that says "waiting for a person" which that person cannot resolve is not waiting.',
    );
  }
  const result = await getDb().run(
    `UPDATE realization_packets
        SET state = ?, blocker = ?, campaign_id = COALESCE(?, campaign_id), updated_at = ?
      WHERE id = ? AND state = ?`,
    [
      input.to,
      input.blocker ?? null,
      input.campaignId ?? null,
      nowIso(),
      input.id,
      input.from,
    ] as never[],
  );
  return (result.changes ?? 0) > 0;
}

/* ------------------------------------------------------------------------- */
/* Sections                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Write the next version of a section.
 *
 * Always a new version. There is no update path, because the whole reason this
 * is a table of versions rather than ten columns is that the previous answer
 * has to still be there — a packet whose current-state map changed under it is
 * the interesting case, not a detail.
 */
export async function putSection(input: {
  packetId: string;
  section: PacketSection;
  content: unknown;
  authorKind: 'DERIVED' | 'PROPOSED' | 'ACCEPTED';
  evidence: string;
}): Promise<PacketSectionRow> {
  if (input.evidence.trim().length === 0) {
    throw new Error(
      'A section must say what it was computed or proposed from. A section with no stated basis ' +
        'cannot be re-checked when the system moves under it.',
    );
  }
  const prior = await getDb().get<{ v: number }>(
    `SELECT MAX(version) AS v FROM realization_sections WHERE packet_id = ? AND section = ?`,
    [input.packetId, input.section] as never[],
  );
  const version = Number(prior?.v ?? 0) + 1;
  const id = newId('rls');
  await getDb().run(
    `INSERT INTO realization_sections
       (id, packet_id, section, version, content, author_kind, evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.packetId,
      input.section,
      version,
      toJson(input.content),
      input.authorKind,
      input.evidence,
      nowIso(),
    ] as never[],
  );
  return {
    id,
    packetId: input.packetId,
    section: input.section,
    version,
    content: input.content,
    authorKind: input.authorKind,
    evidence: input.evidence,
    createdAt: nowIso(),
  };
}

/** The newest version of every section this packet has. */
export async function currentSections(packetId: string): Promise<PacketSectionRow[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM realization_sections WHERE packet_id = ? ORDER BY section, version`,
    [packetId] as never[],
  );
  const newest = new Map<string, Row>();
  for (const row of rows) newest.set(text(row, 'section'), row);
  return [...newest.values()].map((row) => ({
    id: text(row, 'id'),
    packetId: text(row, 'packet_id'),
    section: text(row, 'section') as PacketSection,
    version: Number(row['version'] ?? 1),
    content: parseJson<unknown>(text(row, 'content'), null),
    authorKind: text(row, 'author_kind') as PacketSectionRow['authorKind'],
    evidence: text(row, 'evidence'),
    createdAt: text(row, 'created_at'),
  }));
}

/**
 * Which of the ten nobody has written.
 *
 * Named rather than filled in. A section written from a template would be
 * indistinguishable from an answered one to every reader downstream, which is
 * the one thing a packet must never do: it is the artifact a decision to spend
 * the Factory's time is made from.
 */
export async function missingSections(packetId: string): Promise<PacketSection[]> {
  const present = new Set((await currentSections(packetId)).map((row) => row.section));
  return PACKET_SECTIONS.filter((section) => !present.has(section));
}

/* ------------------------------------------------------------------------- */
/* Deriving what can be derived                                               */
/* ------------------------------------------------------------------------- */

export interface DerivationReport {
  packetId: string;
  scanId: string | null;
  gaps: number;
  summary: GapSummary;
  sectionsWritten: PacketSection[];
  /** The seven a reader still has to answer. */
  stillMissing: PacketSection[];
}

/**
 * Compute the three derivable sections and the gaps, against one reading.
 *
 * The reading is pinned onto the packet, so a gap can be re-checked against the
 * reading it was decided on rather than against a database that has moved.
 * §23's reason for recording the router's input: *why did this come out that
 * way* has to be answerable afterwards, and re-deriving against current rows
 * answers a different question.
 */
export async function derivePacket(packetId: string): Promise<DerivationReport> {
  const packet = await getPacket(packetId);
  if (!packet) throw new Error(`No such packet: ${packetId}`);
  const faculty = await getFaculty(packet.facultyId);
  if (!faculty) throw new Error(`Packet ${packetId} names a faculty that does not exist.`);

  // Take a reading if there is none at all; otherwise use the one there is.
  // Forcing a fresh scan here would make deriving a packet walk the whole source
  // tree, and the staleness rule already decides when that is worth doing.
  const existing = await latestScan();
  const scan = existing ?? (await scanSystem('REQUESTED'));
  const components = await listComponents();

  const gaps = deriveGaps(faculty.definition, components);
  await replaceGaps(packetId, gaps);

  const written: PacketSection[] = [];

  await putSection({
    packetId,
    section: 'CAPABILITY_MAP',
    content: capabilityMap(faculty),
    authorKind: 'DERIVED',
    evidence: `The promoted definition of ${faculty.slug} (candidate ${faculty.candidateId}).`,
  });
  written.push('CAPABILITY_MAP');

  await putSection({
    packetId,
    section: 'CURRENT_STATE',
    content: currentState(faculty, gaps, components.length),
    authorKind: 'DERIVED',
    evidence: `Self-model reading ${scan.scanId} over ${components.length} component(s).`,
  });
  written.push('CURRENT_STATE');

  const summary = summarize(gaps.map((gap) => ({ kind: gap.kind })));
  await putSection({
    packetId,
    section: 'IMPLEMENTATION_GAPS',
    content: { summary, gaps },
    authorKind: 'DERIVED',
    evidence: `Gap calculus over reading ${scan.scanId} and definition of ${faculty.slug}.`,
  });
  written.push('IMPLEMENTATION_GAPS');

  await getDb().run(
    `UPDATE realization_packets SET scan_id = ?, updated_at = ? WHERE id = ?`,
    [scan.scanId, nowIso(), packetId] as never[],
  );

  return {
    packetId,
    scanId: scan.scanId,
    gaps: gaps.length,
    summary,
    sectionsWritten: written,
    stillMissing: await missingSections(packetId),
  };
}

/**
 * The capability map, from the definition and nothing else.
 *
 * "Before" is deliberately the faculty's own six dimensions rather than a
 * sentence about what Brain cannot do: the dimensions are rows, and a sentence
 * would be Brain narrating its own shortcomings, which is neither checkable nor
 * stable between two derivations.
 *
 * `fakeCompletionConditions` is the part worth having. Every one of them is
 * drawn from something this repository has actually been caught doing, so it is
 * a list of *known* ways to look finished rather than an imagined one.
 */
function capabilityMap(faculty: Faculty): Record<string, unknown> {
  return {
    faculty: faculty.slug,
    canonicalName: faculty.canonicalName,
    before: {
      definitionState: faculty.definitionState,
      contractState: faculty.contractState,
      implementationState: faculty.implementationState,
      evaluationState: faculty.evaluationState,
      availabilityState: faculty.availabilityState,
    },
    promisedAfter: faculty.definition.promisedPower,
    scope: faculty.definition.purpose,
    nonGoals: faculty.definition.boundaries,
    fakeCompletionConditions: [
      'A table exists and nothing writes to it.',
      'A module exists and nothing imports it.',
      'A registry entry exists and no caller reaches it.',
      'A suite passes against a fixture that arranged its own starting state.',
      'A dimension moved because a document was read rather than because code ran.',
      'A reading says UNKNOWN and a screen renders it as satisfied.',
      'A worker reported success and no row changed.',
    ],
  };
}

function currentState(
  faculty: Faculty,
  gaps: readonly DerivedGap[],
  componentCount: number,
): Record<string, unknown> {
  const byKind = new Map<GapKind, DerivedGap[]>();
  for (const gap of gaps) {
    byKind.set(gap.kind, [...(byKind.get(gap.kind) ?? []), gap]);
  }
  return {
    faculty: faculty.slug,
    componentsRead: componentCount,
    live: (byKind.get('EXISTS_AND_LIVE') ?? []).map((gap) => gap.componentKey),
    disconnected: (byKind.get('EXISTS_BUT_DISCONNECTED') ?? []).map((gap) => gap.componentKey),
    // Deliberately not called "missing". Nothing matched is not the same fact
    // as nothing exists, and naming it "missing" here is precisely how the
    // second becomes believed.
    nothingMatched: (byKind.get('NEEDS_A_READING') ?? [])
      .filter((gap) => gap.componentKey === null)
      .map((gap) => gap.requirement),
    awaitingAPerson: (byKind.get('REQUIRES_PERSON_AUTHORITY') ?? []).map((gap) => gap.requirement),
    note:
      'Every entry here is a reading over the self-model, not a judgement about sufficiency. ' +
      'Whether a live component actually serves the requirement it matched is a reading ' +
      'somebody makes; Brain will not decide it.',
  };
}

/**
 * Replace this packet's derived gaps.
 *
 * Derived gaps only: a gap a worker or a person classified is left exactly as
 * it is, because re-deriving over somebody's judgement would silently discard
 * the reading they were asked for. That is `mayReplace`'s rule from §30 —
 * about authority rather than recency — at a new table.
 */
async function replaceGaps(packetId: string, gaps: readonly DerivedGap[]): Promise<void> {
  const db = getDb();
  const at = nowIso();
  const existing = await db.all<Row>(
    `SELECT * FROM realization_gaps WHERE packet_id = ?`,
    [packetId] as never[],
  );
  const judged = new Set(
    existing
      .filter((row) => text(row, 'derived_by') !== 'BRAIN')
      .map((row) => `${text(row, 'aspect')}::${text(row, 'requirement')}`),
  );

  for (const gap of gaps) {
    const key = `${gap.aspect}::${gap.requirement}`;
    if (judged.has(key)) continue;
    const prior = existing.find(
      (row) => text(row, 'aspect') === gap.aspect && text(row, 'requirement') === gap.requirement,
    );
    if (prior) {
      await db.run(
        `UPDATE realization_gaps
            SET kind = ?, component_key = ?, evidence = ?, updated_at = ?
          WHERE id = ?`,
        [gap.kind, gap.componentKey, gap.evidence, at, text(prior, 'id')] as never[],
      );
      continue;
    }
    await db.run(
      `INSERT INTO realization_gaps
         (id, packet_id, requirement, aspect, kind, derived_by, component_key, evidence,
          state, state_reason, carried_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'BRAIN', ?, ?, 'OPEN', NULL, NULL, ?, ?)`,
      [
        newId('rlg'),
        packetId,
        gap.requirement,
        gap.aspect,
        gap.kind,
        gap.componentKey,
        gap.evidence,
        at,
        at,
      ] as never[],
    );
  }
}

export async function listGaps(
  packetId: string,
  filter: { states?: PacketGap['state'][]; kinds?: GapKind[] } = {},
): Promise<PacketGap[]> {
  const where: string[] = ['packet_id = ?'];
  const params: unknown[] = [packetId];
  if (filter.states && filter.states.length > 0) {
    where.push(`state IN (${filter.states.map(() => '?').join(',')})`);
    params.push(...filter.states);
  }
  if (filter.kinds && filter.kinds.length > 0) {
    where.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
    params.push(...filter.kinds);
  }
  const rows = await getDb().all<Row>(
    `SELECT * FROM realization_gaps WHERE ${where.join(' AND ')} ORDER BY aspect, requirement`,
    params as never[],
  );
  return rows.map(mapGap);
}

/**
 * Record somebody's reading of a gap.
 *
 * The one way a gap becomes a kind Brain may not derive. `derivedBy` is
 * required and is never `BRAIN` here, because that is the whole distinction the
 * column exists to keep: a classification that needed a reader must carry who
 * read it.
 */
export async function judgeGap(input: {
  gapId: string;
  kind: GapKind;
  derivedBy: 'WORKER' | 'PERSON';
  evidence: string;
}): Promise<void> {
  if (input.evidence.trim().length === 0) {
    throw new Error('A judged gap must say what it was judged from.');
  }
  await getDb().run(
    `UPDATE realization_gaps SET kind = ?, derived_by = ?, evidence = ?, updated_at = ?
      WHERE id = ?`,
    [input.kind, input.derivedBy, input.evidence, nowIso(), input.gapId] as never[],
  );
}

/** Move a gap's own state: assigned to something, closed, or waived. */
export async function setGapState(input: {
  gapId: string;
  state: PacketGap['state'];
  reason: string;
  carriedBy?: string | null;
}): Promise<void> {
  await getDb().run(
    `UPDATE realization_gaps
        SET state = ?, state_reason = ?, carried_by = COALESCE(?, carried_by), updated_at = ?
      WHERE id = ?`,
    [input.state, input.reason, input.carriedBy ?? null, nowIso(), input.gapId] as never[],
  );
}

/* ------------------------------------------------------------------------- */
/* Readiness                                                                  */
/* ------------------------------------------------------------------------- */

export interface Readiness {
  ready: boolean;
  /** Every condition, and whether it holds. Never a single score. */
  conditions: Array<{ condition: string; holds: boolean; detail: string }>;
}

/**
 * May this packet be handed to the Factory?
 *
 * Every condition is reported whether or not it holds, and there is no
 * aggregate score — the same reason `describeFaculty` composes rather than
 * counts. A packet that is one condition short and one that is five short need
 * different actions, and a percentage tells a reader neither.
 *
 * The conditions are the blueprint's own stopping condition, made checkable:
 * the promised power is explicit, the current and target topologies are mapped,
 * acceptance tests exist, and nothing is waiting on a reading or a person.
 */
export async function readiness(packetId: string): Promise<Readiness> {
  const sections = await currentSections(packetId);
  const present = new Map(sections.map((row) => [row.section, row]));
  const gaps = await listGaps(packetId, { states: ['OPEN', 'ASSIGNED'] });
  const summary = summarize(gaps);

  const conditions: Readiness['conditions'] = [];

  const needsAnAuthor: PacketSection[] = PACKET_SECTIONS.filter(
    (section) => !DERIVED_SECTIONS.includes(section),
  );
  for (const section of PACKET_SECTIONS) {
    const row = present.get(section);
    conditions.push({
      condition: `${section} is written`,
      holds: row !== undefined,
      detail:
        row === undefined
          ? needsAnAuthor.includes(section)
            ? 'Nobody has written it. Brain composes the question and answers none of this kind: ' +
              'a design filled in from a template would be indistinguishable from one somebody made.'
            : 'Brain has not derived it yet; `derivePacket` writes it.'
          : `version ${row.version}, ${row.authorKind}`,
    });
  }

  conditions.push({
    condition: 'no gap is still waiting on a reading',
    holds: summary.awaitingAReading === 0,
    detail:
      summary.awaitingAReading === 0
        ? 'every gap has been classified by a reading or a derivation'
        : `${summary.awaitingAReading} gap(s) matched nothing or matched something the ` +
          'self-model cannot speak for. Whether each has to be built, researched or is already ' +
          'served is a judgement somebody makes.',
  });

  conditions.push({
    condition: 'no gap is waiting on a person',
    holds: summary.awaitingAPerson === 0,
    detail:
      summary.awaitingAPerson === 0
        ? 'nothing here needs an authority nobody has granted'
        : `${summary.awaitingAPerson} requirement(s) name permission, authority, approval, ` +
          'consent, a credential or spending, and no amount of building answers one.',
  });

  conditions.push({
    condition: 'something is actually left to build',
    holds: (summary.byKind.MUST_BE_BUILT ?? 0) + (summary.byKind.MUST_BE_REPLACED ?? 0) > 0,
    detail:
      (summary.byKind.MUST_BE_BUILT ?? 0) + (summary.byKind.MUST_BE_REPLACED ?? 0) > 0
        ? `${summary.byKind.MUST_BE_BUILT} to build and ${summary.byKind.MUST_BE_REPLACED} to replace`
        : 'nothing is classified as needing to be built or replaced, so there is no change ' +
          'request to make. That is a real outcome and not a failure: a faculty whose ' +
          'requirements are already served needs connecting or evaluating, not building.',
  });

  return { ready: conditions.every((condition) => condition.holds), conditions };
}

/** Every faculty with no live packet, so a tick can see what has not been started. */
export async function facultiesWithoutPackets(): Promise<Faculty[]> {
  const out: Faculty[] = [];
  for (const faculty of await listFaculties()) {
    if (faculty.definitionState !== 'CANONICAL') continue;
    if (await livePacketFor(faculty.id)) continue;
    out.push(faculty);
  }
  return out;
}

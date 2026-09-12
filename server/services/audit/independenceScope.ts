/**
 * Triage for the fleet-wide audit-independence scan.
 *
 * ---------------------------------------------------------------------------
 * Why a second reader of the same rows
 * ---------------------------------------------------------------------------
 *
 * `scanAuthorReviewerOverlap` answers one question — *is there a packet whose
 * reviewer shared a session with its author* — and it answers it well. Run
 * against production it named **117 packets**: eight where an author
 * demonstrably also took a reviewer role, and a hundred and nine where a
 * reviewer or the author recorded no session at all.
 *
 * A flat list of a hundred and seventeen is not a decision. It reads as a
 * hundred and seventeen approvals, and a person looking at it has no way to
 * tell the eight from the hundred and nine, or either from the ones already
 * being re-run, or any of those from a conclusion nothing in the project
 * depends on any more. **A report that makes the correct next action harder to
 * see than the wrong one is a worse report than no report** — §23's objection
 * to a warning that cries wolf, at a list rather than at a bin.
 *
 * So this module classifies. Every packet lands in exactly one status, from
 * rows, and for the ones that are not clean it asks the second question the
 * first scan never asked: **is this conclusion still in use, and what depends
 * on it?**
 *
 * ---------------------------------------------------------------------------
 * The one thing this must never do
 * ---------------------------------------------------------------------------
 *
 * A hundred and nine packets recorded no session. **That is not a hundred and
 * nine violations.** `UNATTRIBUTED` is its own status with its own wording, it
 * is never counted with `DEMONSTRATED`, and no sentence composed here describes
 * one as the other. §23: *we could not tell* is not the same fact as *we
 * checked*, and this whole repair is that distinction in one column. The remedy
 * for a missing attribution is attribution — `lineageRecovery.ts` walks the
 * credential back to the dispatch row Brain wrote — and it is not an approval.
 *
 * ---------------------------------------------------------------------------
 * Read-only, deliberately
 * ---------------------------------------------------------------------------
 *
 * Nothing here opens a reopen, queues a bin, proposes a remedy per packet or
 * writes a row. §23: **the scan reports and does not act**, because reopening
 * work nobody asked about is the opposite of what a scan is for. The transition
 * that *does* act is `requestIntegrityReaudit`, it is a person's to call, and
 * this module imports nothing from it.
 */
import { getDb } from '../../db/database.ts';
import { parseJson } from '../../repos/util.ts';
import { listDocuments } from '../../repos/documents.ts';
import { listLayers } from '../../repos/layers.ts';
import { listPasses } from '../../repos/research.ts';
import { listReopens } from '../../repos/auditReopens.ts';
import { lineageFromPasses } from '../research/independence.ts';
import { auditRoundFor, passInRound } from '../research/auditRound.ts';
import { ROLE_PASS_ORDINAL } from '../research/auditBrief.ts';
import { normalizeVersion } from '../../domain/version.ts';
import type { AuditIntegrityReopen, ReopenState } from '../../repos/auditReopens.ts';
import type { AuditRole } from '../queue/workTypes.ts';
import type { Document, Layer, ResearchPass } from '../../domain/types.ts';

/* ========================================================================== */
/* The vocabulary                                                             */
/* ========================================================================== */

/**
 * What a packet is, on the one axis this report is about.
 *
 * Five words, and the gap between the first two is the point of the report.
 * They are ordered by how strong a statement each makes rather than
 * alphabetically, because the order they print in is the order a person should
 * read them in.
 */
export const SCOPE_STATUSES = [
  /** A reviewer's recorded session is one of the author's. We checked; it happened. */
  'DEMONSTRATED',
  /** A reviewer's or the author's session was never recorded. Not a violation. */
  'UNATTRIBUTED',
  /** An `audit_integrity_reopens` row is OPEN: the round is already being re-run. */
  'RECOVERING',
  /** Cancelled, failed, or a verdict a later round replaced. Not the standing conclusion. */
  'SUPERSEDED_HISTORY',
  /** Every reviewer pair and every author pair is separated. Left out of the report. */
  'CLEAN',
] as const;
export type ScopeStatus = (typeof SCOPE_STATUSES)[number];

/**
 * Why a conclusion counts as in use. Each one is a row, and `rowId` names it.
 *
 * There is no `PROBABLY` here and there is no default. `inUse` is false unless
 * one of these four found a row, because absence of evidence is not use — the
 * same rule `evidence_class` applies to a ceiling nobody has measured.
 */
export const USE_KINDS = [
  /** `documents` says this artifact is the layer's canonical or current one. */
  'DOCUMENT_CURRENT',
  /** `layers.status = 'FROZEN'` and `layers.canonical_document_id` names it. */
  'LAYER_FROZEN',
  /** A `russell_knowledge` row from this packet's mission is not superseded. */
  'KNOWLEDGE_CURRENT',
  /** Another packet's coverage row, fragment or claim names one of its claim ids. */
  'CITED_BY_PACKET',
] as const;
export type UseKind = (typeof USE_KINDS)[number];

/** What kind of row is leaning on this conclusion. */
export const DEPENDENT_KINDS = [
  'LAYER',
  'KNOWLEDGE',
  'REQUIREMENT_COVERAGE',
  'FRAGMENT',
  'CLAIM',
] as const;
export type DependentKind = (typeof DEPENDENT_KINDS)[number];

/** A row that says this conclusion is in use, named so it can be read back. */
export interface UseEvidence {
  kind: UseKind;
  /** The id of the row that proves it. */
  rowId: string;
  /** What that row is, in one phrase. Composed here, never by a model. */
  detail: string;
}

/** Something that would have to change if this conclusion changed. */
export interface Dependent {
  kind: DependentKind;
  id: string;
  /** The packet it belongs to, where it belongs to one. */
  orchestrationId: string | null;
  label: string;
}

export interface ScopeFinding {
  orchestrationId: string;
  projectId: string;
  layerId: string;
  /** `research_orchestrations.status`, verbatim. */
  packetStatus: string;
  status: ScopeStatus;
  /** One sentence naming the rows the status came from. */
  statusReason: string;
  /**
   * Reviewer roles whose recorded session is also an author's, in the round
   * that stands.
   *
   * A role appears here only when two recorded session strings are equal, which
   * is a fact rather than an inference — so a role that recorded nothing can
   * never reach this list, and an `UNATTRIBUTED` finding therefore always
   * carries an empty one. It is never populated to stand in for a missing
   * attribution.
   */
  conflictedRoles: AuditRole[];
  /** Reviewer roles that recorded no session. Unknown, never a violation. */
  unattributedRoles: AuditRole[];
  /** True when no completed synthesis pass recorded a session. */
  authorUnattributed: boolean;
  /** The boundary of the round the finding was judged against, when there is one. */
  roundStartedAt: string | null;
  /** This packet's newest reopen, if it has one. */
  reopen: { id: string; state: ReopenState } | null;
  documentId: string | null;
  /** True only when a row below says so. */
  inUse: boolean;
  use: UseEvidence[];
  /** What was checked and found absent, when nothing says it is in use. */
  notInUseReason: string | null;
  dependents: Dependent[];
}

export interface TriageSummary {
  /** Packets examined. */
  scanned: number;
  byStatus: Record<ScopeStatus, number>;
  /** Among the packets that are not CLEAN. */
  notClean: number;
  inUse: number;
  historical: number;
  /** The short list: demonstrated, and still relied on. These are the decisions. */
  decisions: string[];
  demonstratedHistorical: number;
  unattributedInUse: number;
  unattributedHistorical: number;
  /** The counts as a sentence, composed from the numbers above and nothing else. */
  headline: string;
}

export interface IndependenceScopeReport {
  summary: TriageSummary;
  /** Not-CLEAN packets, strongest statement first. */
  findings: ScopeFinding[];
}

/* ========================================================================== */
/* The overlap, over one set of passes                                        */
/* ========================================================================== */

interface Overlap {
  /** There was at least one completed author pass and one completed reviewer pass. */
  comparable: boolean;
  conflicted: AuditRole[];
  unattributedRoles: AuditRole[];
  authorUnattributed: boolean;
  flagged: boolean;
}

/**
 * Who reviewed whose work, in one set of passes.
 *
 * `lineageFromPasses` is the single reader of those columns and it returns both
 * halves — the reviewers **and** the author. §23 records what happened when
 * every caller destructured `{ audits }` and dropped the other one, so this
 * takes both on purpose.
 */
function overlapOf(passes: ResearchPass[]): Overlap {
  const { audits, synthesisAttempts } = lineageFromPasses(passes);

  const authorSessions = new Set(
    synthesisAttempts
      .map((attempt) => attempt.sessionRef)
      .filter((ref): ref is string => typeof ref === 'string' && ref !== ''),
  );
  const authorUnattributed = synthesisAttempts.length > 0 && authorSessions.size === 0;
  const unattributedRoles = audits.filter((audit) => !audit.sessionRef).map((audit) => audit.role);
  const conflicted = audits
    .filter((audit) => audit.sessionRef !== null && authorSessions.has(audit.sessionRef))
    .map((audit) => audit.role);

  const comparable = audits.length > 0 && synthesisAttempts.length > 0;
  return {
    comparable,
    conflicted,
    unattributedRoles,
    authorUnattributed,
    flagged:
      comparable &&
      (conflicted.length > 0 || authorUnattributed || unattributedRoles.length > 0),
  };
}

/**
 * The round this packet's standing verdict belongs to, and what it carried.
 *
 * `auditRoundFor` is the shared rule and is asked first — §23 is explicit that
 * a boundary applied by three of its four readers is worse than none. It reads
 * the newest fifty round events and filters them in memory, which is right for
 * the one packet a runner is working on and can miss an older one in a
 * fleet-wide sweep. So the packet's own newest reopen row is consulted too, and
 * the later of the two wins.
 *
 * **Both halves come from one source**, never one from each: a reader that took
 * the boundary from the newest round and the carried set from an older one
 * would offer a role as satisfied against a boundary that postdates it. A
 * reopen row carries `round_started_at` and `roles_carried` in the same row,
 * which is exactly why reading it here is safe.
 */
function roundFrom(
  shared: { since: string | null; carried: ReadonlySet<number> },
  reopens: AuditIntegrityReopen[],
): { since: string | null; carried: ReadonlySet<number> } {
  const newest = reopens[0];
  if (!newest) return shared;
  if (shared.since !== null && shared.since >= newest.roundStartedAt) return shared;

  const carried = new Set<number>();
  for (const role of newest.rolesCarried) carried.add(ROLE_PASS_ORDINAL[role.role]);
  return { since: newest.roundStartedAt, carried };
}

/* ========================================================================== */
/* What depends on a conclusion                                               */
/* ========================================================================== */

/**
 * Everything one project's dependency questions need, read once.
 *
 * Built per project rather than per packet, because the alternative is a full
 * scan of six tables a hundred and seventeen times and because the answers do
 * not change between packets inside one sweep.
 *
 * The JSON columns are parsed in TypeScript rather than in SQL on purpose:
 * `json_each` and `jsonb` are not the same function in the two dialects, and a
 * report that only runs on the laptop is not a report about production.
 */
interface ProjectIndex {
  layers: Map<string, Layer>;
  documents: Map<string, Document>;
  /** Claim ids each filed document produced, as `existing_claims` rows. */
  existingClaimsByDocument: Map<string, string[]>;
  /** Claim ids each packet produced, as `research_claims` rows. */
  researchClaimsByPacket: Map<string, string[]>;
  /** Who names an `existing_claims` id: coverage rows and fragments. */
  citesExistingClaim: Map<string, Dependent[]>;
  /** Who derives from a `research_claims` id. */
  derivesFromClaim: Map<string, Dependent[]>;
  /** Missions per packet, and the knowledge each mission still has standing. */
  missionsByPacket: Map<string, string[]>;
  knowledgeByMission: Map<string, Dependent[]>;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

async function buildProjectIndex(projectId: string): Promise<ProjectIndex> {
  const db = getDb();

  const layers = new Map((await listLayers(projectId)).map((layer) => [layer.id, layer]));
  const documents = new Map(
    (await listDocuments(projectId)).map((document) => [document.id, document]),
  );

  const existingClaimsByDocument = new Map<string, string[]>();
  for (const row of await db.all<{ id: string; document_id: string }>(
    `SELECT id, document_id
       FROM existing_claims
      WHERE project_id = ?
      ORDER BY document_id, id`,
    [projectId],
  )) {
    push(existingClaimsByDocument, row.document_id, row.id);
  }

  const citesExistingClaim = new Map<string, Dependent[]>();
  for (const row of await db.all<{
    id: string;
    orchestration_id: string;
    requirement_id: string;
    claim_ids: string;
  }>(
    `SELECT c.id AS id,
            c.orchestration_id AS orchestration_id,
            c.requirement_id AS requirement_id,
            c.claim_ids AS claim_ids
       FROM requirement_coverage c
       JOIN research_orchestrations o ON o.id = c.orchestration_id
      WHERE o.project_id = ?
      ORDER BY c.orchestration_id, c.id`,
    [projectId],
  )) {
    for (const claimId of parseJson<string[]>(row.claim_ids, [])) {
      push(citesExistingClaim, claimId, {
        kind: 'REQUIREMENT_COVERAGE',
        id: row.id,
        orchestrationId: row.orchestration_id,
        label: `requirement ${row.requirement_id} is covered by this claim`,
      });
    }
  }

  for (const row of await db.all<{
    id: string;
    orchestration_id: string;
    fragment_key: string;
    existing_claim_ids: string;
  }>(
    `SELECT id, orchestration_id, fragment_key, existing_claim_ids
       FROM research_fragments
      WHERE project_id = ?
      ORDER BY orchestration_id, id`,
    [projectId],
  )) {
    for (const claimId of parseJson<string[]>(row.existing_claim_ids, [])) {
      push(citesExistingClaim, claimId, {
        kind: 'FRAGMENT',
        id: row.id,
        orchestrationId: row.orchestration_id,
        label: `fragment ${row.fragment_key} holds this claim as evidence it already had`,
      });
    }
  }

  const researchClaimsByPacket = new Map<string, string[]>();
  const derivesFromClaim = new Map<string, Dependent[]>();
  for (const row of await db.all<{
    id: string;
    orchestration_id: string;
    derived_from: string;
  }>(
    `SELECT c.id AS id,
            c.orchestration_id AS orchestration_id,
            c.derived_from AS derived_from
       FROM research_claims c
       JOIN research_orchestrations o ON o.id = c.orchestration_id
      WHERE o.project_id = ?
      ORDER BY c.orchestration_id, c.id`,
    [projectId],
  )) {
    push(researchClaimsByPacket, row.orchestration_id, row.id);
    for (const claimId of parseJson<string[]>(row.derived_from, [])) {
      push(derivesFromClaim, claimId, {
        kind: 'CLAIM',
        id: row.id,
        orchestrationId: row.orchestration_id,
        label: 'a calculation rests on this claim',
      });
    }
  }

  const missionsByPacket = new Map<string, string[]>();
  for (const row of await db.all<{ id: string; orchestration_id: string }>(
    `SELECT id, orchestration_id
       FROM russell_missions
      WHERE project_id = ? AND orchestration_id IS NOT NULL
      ORDER BY orchestration_id, id`,
    [projectId],
  )) {
    push(missionsByPacket, row.orchestration_id, row.id);
  }

  /*
   * Current knowledge only.
   *
   * `superseded_by_id` is how §24 records a belief that was replaced without
   * destroying the row that held it, so a superseded conclusion is history in
   * exactly the way a superseded document is. Counting one as a dependent would
   * report a project as relying on something it has already stopped believing.
   */
  const knowledgeByMission = new Map<string, Dependent[]>();
  for (const row of await db.all<{
    id: string;
    mission_id: string;
    kind: string;
    statement: string;
  }>(
    `SELECT id, mission_id, kind, statement
       FROM russell_knowledge
      WHERE project_id = ? AND mission_id IS NOT NULL AND superseded_by_id IS NULL
      ORDER BY mission_id, id`,
    [projectId],
  )) {
    push(knowledgeByMission, row.mission_id, {
      kind: 'KNOWLEDGE',
      id: row.id,
      orchestrationId: null,
      label: `${row.kind}: ${row.statement.slice(0, 120)}`,
    });
  }

  return {
    layers,
    documents,
    existingClaimsByDocument,
    researchClaimsByPacket,
    citesExistingClaim,
    derivesFromClaim,
    missionsByPacket,
    knowledgeByMission,
  };
}

interface UseAnswer {
  inUse: boolean;
  use: UseEvidence[];
  dependents: Dependent[];
  notInUseReason: string | null;
}

/**
 * Is this conclusion currently in use, and what is leaning on it?
 *
 * Four questions, each answered by a row or not answered at all. **`inUse` is
 * false unless one of them found a row** — a packet whose tables are simply
 * empty is not thereby in use, and reporting it as such would turn the short
 * list this report exists to produce straight back into the long one.
 */
function useOf(input: {
  orchestrationId: string;
  layerId: string;
  documentId: string | null;
  index: ProjectIndex;
}): UseAnswer {
  const { index } = input;
  const use: UseEvidence[] = [];
  const dependents: Dependent[] = [];
  const absent: string[] = [];

  const document = input.documentId ? (index.documents.get(input.documentId) ?? null) : null;
  const layer = index.layers.get(document?.layerId ?? input.layerId) ?? null;

  // 1. The artifact itself. Superseded is a row saying it is *not* current, so
  //    it is read before anything that could say it is.
  if (!document) {
    absent.push('no document was filed');
  } else if (document.supersededByDocumentId !== null || document.status === 'SUPERSEDED') {
    absent.push(
      `the filed document ${document.canonicalName} is superseded` +
        (document.supersededByDocumentId ? ` by ${document.supersededByDocumentId}` : ''),
    );
  } else {
    const canonical = document.isCanonical || layer?.canonicalDocumentId === document.id;
    const current =
      layer !== null &&
      layer.currentVersion !== null &&
      normalizeVersion(document.version) === layer.currentVersion;
    if (canonical || current) {
      use.push({
        kind: 'DOCUMENT_CURRENT',
        rowId: document.id,
        detail: canonical
          ? `${document.canonicalName} is the layer's canonical artifact`
          : `${document.canonicalName} is the layer's current version`,
      });
    } else {
      absent.push(
        `the filed document ${document.canonicalName} is neither canonical nor the layer's current version`,
      );
    }
  }

  // 2. A frozen layer is the strongest statement the archive makes about a
  //    document: invariant 6 says a layer is never frozen without a canonical
  //    artifact, so a freeze naming this one is the project standing on it.
  if (document && layer && layer.status === 'FROZEN' && layer.canonicalDocumentId === document.id) {
    use.push({
      kind: 'LAYER_FROZEN',
      rowId: layer.id,
      detail: `${layer.name} is FROZEN on this document`,
    });
    dependents.push({
      kind: 'LAYER',
      id: layer.id,
      orchestrationId: null,
      label: `${layer.name} is frozen on ${document.canonicalName}`,
    });
  } else if (layer) {
    absent.push(`its layer ${layer.name} is not frozen on it`);
  }

  // 3. What the project ended up believing, if a mission wrote anything back.
  const knowledge: Dependent[] = [];
  for (const missionId of index.missionsByPacket.get(input.orchestrationId) ?? []) {
    knowledge.push(...(index.knowledgeByMission.get(missionId) ?? []));
  }
  if (knowledge.length > 0) {
    const first = knowledge[0]!;
    use.push({
      kind: 'KNOWLEDGE_CURRENT',
      rowId: first.id,
      detail:
        knowledge.length === 1
          ? 'one current knowledge row was written back from this packet'
          : `${knowledge.length} current knowledge rows were written back from this packet`,
    });
    dependents.push(...knowledge);
  } else {
    absent.push('no current knowledge row came from it');
  }

  // 4. Whether anything else built on its claims. Both directions: the claims a
  //    reader extracted from the filed document, and the claims the packet's own
  //    ledger holds. A row inside this same packet is not a dependent.
  const citing: Dependent[] = [];
  const extracted = input.documentId
    ? (index.existingClaimsByDocument.get(input.documentId) ?? [])
    : [];
  for (const claimId of extracted) {
    for (const dependent of index.citesExistingClaim.get(claimId) ?? []) {
      if (dependent.orchestrationId === input.orchestrationId) continue;
      citing.push(dependent);
    }
  }
  for (const claimId of index.researchClaimsByPacket.get(input.orchestrationId) ?? []) {
    for (const dependent of index.derivesFromClaim.get(claimId) ?? []) {
      if (dependent.orchestrationId === input.orchestrationId) continue;
      citing.push(dependent);
    }
  }
  if (citing.length > 0) {
    const packets = new Set(
      citing
        .map((dependent) => dependent.orchestrationId)
        .filter((id): id is string => id !== null),
    );
    use.push({
      kind: 'CITED_BY_PACKET',
      rowId: citing[0]!.id,
      detail: `${citing.length} row(s) in ${packets.size} other packet(s) cite its claims`,
    });
    dependents.push(...citing);
  } else {
    absent.push('no other packet cites its claims');
  }

  return {
    inUse: use.length > 0,
    use,
    dependents,
    notInUseReason: use.length > 0 ? null : absent.join('; '),
  };
}

/* ========================================================================== */
/* The classification                                                         */
/* ========================================================================== */

interface PacketRow {
  id: string;
  project_id: string;
  layer_id: string;
  status: string;
  document_id: string | null;
}

/**
 * One packet, in exactly one status.
 *
 * The order the branches are asked in is the substance of the classifier:
 *
 *   1. **Nothing to compare, or nothing wrong** — `CLEAN`, and left out.
 *   2. **An OPEN reopen** — `RECOVERING`. The round is being re-run right now,
 *      so this is not a decision waiting to be made; it is one already made.
 *      Asked before the finding is described, so a packet mid-correction can
 *      never be counted among the violations somebody still has to act on.
 *   3. **Cancelled or failed** — `SUPERSEDED_HISTORY`. The packet never
 *      produced a standing conclusion, so its lineage is a record rather than a
 *      liability.
 *   4. **A conflicted reviewer in the round that stands** — `DEMONSTRATED`.
 *   5. **A missing session in the round that stands** — `UNATTRIBUTED`, which
 *      is a different fact with a different remedy and is never folded into 4.
 *   6. **Otherwise** — the flagged pairing is in a round a later one replaced,
 *      so `SUPERSEDED_HISTORY` again, with the boundary named.
 *
 * Steps 4 and 5 read the **current round**, and steps 1 and 6 the whole
 * history, which is what lets a corrected packet be reported as corrected
 * without a single recorded row being edited: the boundary moved in time and
 * the old passes are exactly where they were.
 */
async function classify(row: PacketRow, index: ProjectIndex): Promise<ScopeFinding> {
  const [passes, sharedRound, reopens] = await Promise.all([
    listPasses(row.id),
    auditRoundFor(row.id),
    listReopens(row.id),
  ]);

  const round = roundFrom(sharedRound, reopens);
  const historic = overlapOf(passes);
  const current = overlapOf(passes.filter((pass) => passInRound(pass, round.since, round.carried)));

  const newest = reopens[0] ?? null;
  const openReopen = reopens.find((entry) => entry.state === 'OPEN') ?? null;

  const base = {
    orchestrationId: row.id,
    projectId: row.project_id,
    layerId: row.layer_id,
    packetStatus: row.status,
    roundStartedAt: round.since,
    reopen: newest ? { id: newest.id, state: newest.state } : null,
    documentId: row.document_id,
  };

  if (!historic.flagged) {
    return {
      ...base,
      status: 'CLEAN',
      statusReason: historic.comparable
        ? 'every reviewer and the author recorded a session, and no two of them are the same'
        : 'no completed audit or no completed synthesis: there is nothing to compare',
      conflictedRoles: [],
      unattributedRoles: [],
      authorUnattributed: false,
      inUse: false,
      use: [],
      notInUseReason: null,
      dependents: [],
    };
  }

  const usage = useOf({
    orchestrationId: row.id,
    layerId: row.layer_id,
    documentId: row.document_id,
    index,
  });

  const decided = (status: ScopeStatus, statusReason: string): ScopeFinding => ({
    ...base,
    status,
    statusReason,
    /*
     * The recorded fact, on whatever status it lands under.
     *
     * A conflicted role can only reach an UNATTRIBUTED finding if it were put
     * there deliberately: the branches below reach `UNATTRIBUTED` exactly when
     * `current.conflicted` is empty, so the list stays empty there by
     * construction rather than by being blanked afterwards — which is the
     * difference between a guarantee and a habit. A `RECOVERING` or
     * `SUPERSEDED_HISTORY` packet, on the other hand, may genuinely carry one,
     * and it is the reason the round is being re-run or the reason the verdict
     * was replaced. Suppressing it there would hide a recorded fact to keep a
     * field tidy.
     */
    conflictedRoles: current.conflicted,
    unattributedRoles: current.unattributedRoles,
    authorUnattributed: current.authorUnattributed,
    inUse: usage.inUse,
    use: usage.use,
    notInUseReason: usage.notInUseReason,
    dependents: usage.dependents,
  });

  if (openReopen) {
    return decided(
      'RECOVERING',
      `reopen ${openReopen.id} is OPEN: ${openReopen.rolesRerun.join(', ') || 'no role'} ` +
        `${openReopen.rolesRerun.length === 1 ? 'is' : 'are'} running again against ` +
        `${openReopen.documentVersion}`,
    );
  }

  if (row.status === 'CANCELLED' || row.status === 'FAILED') {
    return decided(
      'SUPERSEDED_HISTORY',
      `the packet is ${row.status}, so it never produced a standing conclusion`,
    );
  }

  if (current.conflicted.length > 0) {
    return decided(
      'DEMONSTRATED',
      `${current.conflicted.join(', ')} ran in a session that also authored this packet's report`,
    );
  }

  if (current.authorUnattributed || current.unattributedRoles.length > 0) {
    const missing = current.authorUnattributed
      ? ['the author', ...current.unattributedRoles]
      : current.unattributedRoles;
    return decided(
      'UNATTRIBUTED',
      `${missing.join(', ')} recorded no session, so this one cannot be told either way — ` +
        'it is not a violation, and the remedy is attribution rather than a decision',
    );
  }

  return decided(
    'SUPERSEDED_HISTORY',
    round.since
      ? `the pairing is in an audit round that the one begun at ${round.since} replaced` +
          (newest && newest.state === 'RESOLVED'
            ? `; reopen ${newest.id} settled on ${newest.resolvedAuditId ?? 'a later verdict'}`
            : '')
      : 'the pairing is not in the round whose verdict stands',
  );
}

/* ========================================================================== */
/* The report                                                                 */
/* ========================================================================== */

/** Strongest statement first, then in-use ahead of historical, then by id. */
const STATUS_RANK: Record<ScopeStatus, number> = {
  DEMONSTRATED: 0,
  RECOVERING: 1,
  UNATTRIBUTED: 2,
  SUPERSEDED_HISTORY: 3,
  CLEAN: 4,
};

function order(a: ScopeFinding, b: ScopeFinding): number {
  if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) {
    return STATUS_RANK[a.status] - STATUS_RANK[b.status];
  }
  if (a.inUse !== b.inUse) return a.inUse ? -1 : 1;
  if (a.orchestrationId < b.orchestrationId) return -1;
  return a.orchestrationId > b.orchestrationId ? 1 : 0;
}

export interface ScopeOptions {
  /** Narrow to one project. Every packet in the Brain when absent. */
  projectId?: string | null;
  limit?: number;
}

/**
 * Classify one packet on its own.
 *
 * Returns `CLEAN` rather than null for a packet with nothing wrong, because a
 * caller asking about one packet is owed the answer rather than an absence.
 * Null means there is no such packet.
 */
export async function classifyPacket(orchestrationId: string): Promise<ScopeFinding | null> {
  const row = await getDb().get<PacketRow>(
    `SELECT id, project_id, layer_id, status, document_id
       FROM research_orchestrations
      WHERE id = ?`,
    [orchestrationId],
  );
  if (!row) return null;
  return await classify(row, await buildProjectIndex(row.project_id));
}

/**
 * The triage.
 *
 * `findings` holds the packets that are not CLEAN; the clean ones are counted
 * and then dropped, because a report whose length is the number of packets in
 * the Brain is the flat list again.
 */
export async function scopeIndependence(
  options: ScopeOptions = {},
): Promise<IndependenceScopeReport> {
  const limit = Math.max(1, options.limit ?? 500);
  const projectId = options.projectId ?? null;

  /*
   * Newest first, and the tiebreak is `id`.
   *
   * Not `rowid`: `dialect.ts` rewrites that to `seq`, which is a column one of
   * the two backends has and the other does not, and this repository has been
   * bitten by exactly that three times — `012_checkpoint_seq.sql`, §25's three
   * connect tables, and `workerSessionForBin`. Every `ORDER BY` in this module
   * names columns that are in its own select list, so both dialects say the
   * same thing; none of them orders by an aggregate, so none needs an alias.
   */
  const rows = projectId
    ? await getDb().all<PacketRow>(
        `SELECT id, project_id, layer_id, status, document_id, created_at
           FROM research_orchestrations
          WHERE project_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        [projectId, limit],
      )
    : await getDb().all<PacketRow>(
        `SELECT id, project_id, layer_id, status, document_id, created_at
           FROM research_orchestrations
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        [limit],
      );

  const indexes = new Map<string, ProjectIndex>();
  const findings: ScopeFinding[] = [];
  const byStatus: Record<ScopeStatus, number> = {
    DEMONSTRATED: 0,
    UNATTRIBUTED: 0,
    RECOVERING: 0,
    SUPERSEDED_HISTORY: 0,
    CLEAN: 0,
  };

  for (const row of rows) {
    let index = indexes.get(row.project_id);
    if (!index) {
      index = await buildProjectIndex(row.project_id);
      indexes.set(row.project_id, index);
    }
    const finding = await classify(row, index);
    byStatus[finding.status] += 1;
    if (finding.status !== 'CLEAN') findings.push(finding);
  }

  findings.sort(order);

  const inUse = findings.filter((finding) => finding.inUse);
  const decisions = inUse
    .filter((finding) => finding.status === 'DEMONSTRATED')
    .map((finding) => finding.orchestrationId);
  const demonstratedHistorical = findings.filter(
    (finding) => finding.status === 'DEMONSTRATED' && !finding.inUse,
  ).length;
  const unattributedInUse = findings.filter(
    (finding) => finding.status === 'UNATTRIBUTED' && finding.inUse,
  ).length;

  const summary: TriageSummary = {
    scanned: rows.length,
    byStatus,
    notClean: findings.length,
    inUse: inUse.length,
    historical: findings.length - inUse.length,
    decisions,
    demonstratedHistorical,
    unattributedInUse,
    unattributedHistorical: byStatus.UNATTRIBUTED - unattributedInUse,
    headline: headlineFor({
      notClean: findings.length,
      decisions: decisions.length,
      demonstratedHistorical,
      recovering: byStatus.RECOVERING,
      supersededHistory: byStatus.SUPERSEDED_HISTORY,
      unattributed: byStatus.UNATTRIBUTED,
    }),
  };

  return { summary, findings };
}

/**
 * The counts as a sentence.
 *
 * Composed from the numbers and from nothing else — no adjective the rows did
 * not earn, and the unattributed count is described as what it is every time it
 * is mentioned. A person reading one line should come away knowing the decision
 * is a handful of conclusions rather than a hundred and seventeen approvals,
 * and must not be able to come away thinking the hundred and nine were
 * violations.
 */
function headlineFor(counts: {
  notClean: number;
  decisions: number;
  demonstratedHistorical: number;
  recovering: number;
  supersededHistory: number;
  unattributed: number;
}): string {
  if (counts.notClean === 0) return 'No packet needs a decision on audit independence.';

  const parts = [
    `${counts.notClean} packet(s) are not clean.`,
    counts.decisions === 0
      ? 'None of them is a demonstrated author-reviewed conclusion that is still in use, ' +
        'so there is nothing to decide here today.'
      : `${counts.decisions} ${counts.decisions === 1 ? 'is a' : 'are'} demonstrated ` +
        `author-reviewed conclusion${counts.decisions === 1 ? '' : 's'} still in use — ` +
        `${counts.decisions === 1 ? 'that is the decision' : 'those are the decisions'}.`,
  ];
  if (counts.demonstratedHistorical > 0) {
    parts.push(
      `${counts.demonstratedHistorical} more ${
        counts.demonstratedHistorical === 1 ? 'is' : 'are'
      } demonstrated but no longer relied on.`,
    );
  }
  if (counts.recovering > 0) {
    parts.push(
      `${counts.recovering} ${counts.recovering === 1 ? 'is' : 'are'} already being re-run.`,
    );
  }
  if (counts.supersededHistory > 0) {
    parts.push(
      `${counts.supersededHistory} ${
        counts.supersededHistory === 1 ? 'is' : 'are'
      } cancelled, failed or superseded history.`,
    );
  }
  if (counts.unattributed > 0) {
    parts.push(
      `${counts.unattributed} recorded no session, which cannot be told either way: ` +
        'not a violation, and the remedy is attribution rather than a decision.',
    );
  }
  return parts.join(' ');
}

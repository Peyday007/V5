/**
 * What is actually being worked on — all of it, and honestly labelled.
 *
 * The defect this exists to fix is one a person hit directly: Work showed
 * nothing while the Brain was running a research packet, because the only table
 * it read was `russell_missions`, and every packet Steps 9 to 11 filed had been
 * created before Russell existed. "No work" and "no work *of the kind I was
 * written to look for*" are different sentences, and only one of them was true.
 *
 * So this reads three authoritative sources and projects them into one list:
 *
 *   - `russell_missions`, which is Step 12A's spine;
 *   - `research_orchestrations`, which is where real research lives;
 *   - `bins`, which is where a dispatched unit of work lives.
 *
 * It **projects** rather than copies. Nothing here writes a row, and each entry
 * carries the id of the thing it was derived from, so a reader can always walk
 * back to the authoritative record instead of trusting this summary of it.
 *
 * Two rules shape the rest.
 *
 * **Deduplication is by id, never by title.** A mission that owns an
 * orchestration which owns a bin is one piece of work with three rows, and
 * showing it three times would tell somebody the Brain is three times busier
 * than it is. The links are foreign keys, so the dedupe is exact — Step 9 paid
 * for the lesson that an identity reconstructed by matching titles breaks the
 * first time two things are called the same thing.
 *
 * **Provenance is a fact about the row, not a guess from its name.** The
 * verifier's scopes, the fault harness, fixture packets and the conversation
 * machinery are all real work that the Brain really did, and none of them is
 * *somebody's project*. Counted together they inflate every number a person
 * reads. So each entry declares which it is, from a column or a foreign key,
 * and the ordinary view asks for `PROJECT` only. Nothing is hidden — the
 * technical view shows the rest, deliberately opened.
 */
import { listBins } from '../../repos/bins.ts';
import { listOrchestrationsByProject } from '../../repos/research.ts';
import { groupOf, listMissions } from '../../repos/russellMissions.ts';
import { getProject } from '../../repos/projects.ts';
import type {
  Bin,
  MissionGroup,
  OrchestrationStatus,
  ResearchOrchestration,
  RussellMission,
} from '../../domain/types.ts';

/**
 * Where a piece of work came from, and therefore whether it is somebody's.
 *
 * `PROJECT` is the only one that counts as ordinary work. The other four are
 * each a different kind of machinery, kept apart rather than merged into one
 * "technical" bucket, because the remedies differ: a fixture is reviewed, a
 * harness run is re-run, a conversation turn is answered, a technical scope is
 * left alone.
 */
export const WORK_PROVENANCES = [
  'PROJECT',
  'FIXTURE',
  'HARNESS',
  'CONVERSATION',
  'TECHNICAL_SCOPE',
] as const;
export type WorkProvenance = (typeof WORK_PROVENANCES)[number];

/** What a person reads. One mapping, so two screens cannot disagree. */
export const PROVENANCE_LABELS: Record<WorkProvenance, string> = {
  PROJECT: 'Project work',
  FIXTURE: 'Written-in fixture',
  HARNESS: 'Machinery proving itself',
  CONVERSATION: 'Answering you',
  TECHNICAL_SCOPE: 'Technical scope',
};

/** Which authoritative row this entry was derived from. */
export type WorkSource = 'MISSION' | 'ORCHESTRATION' | 'BIN';

export interface WorkEntry {
  /** `mission:<id>`, `packet:<id>` or `bin:<id>` — derived, never stored. */
  id: string;
  source: WorkSource;
  /** The authoritative row's own id, so a reader can walk back to it. */
  sourceId: string;
  group: MissionGroup;
  provenance: WorkProvenance;
  title: string;
  /** Why this work exists, in the row's own words. Never composed here. */
  why: string | null;
  /** The row's own state name, unmodified. */
  state: string;
  /** What it is waiting on, when it is waiting on something nameable. */
  waitingOn: string | null;
  /** When it last moved. Sorting key, and the "since" a person reads. */
  updatedAt: string;
  /** Links to the rows this entry already knows about. */
  links: {
    missionId: string | null;
    orchestrationId: string | null;
    binId: string | null;
    documentId: string | null;
    conversationId: string | null;
    layerId: string | null;
  };
}

/**
 * Which group a research packet belongs in.
 *
 * `AWAITING_APPROVAL` is `WAITING` rather than `UP_NEXT` on purpose: it is not
 * queued, it is stopped, and a person is the reason. Telling somebody it is
 * next would hide the fact that it is waiting for them.
 */
export function groupOfOrchestration(status: OrchestrationStatus): MissionGroup {
  switch (status) {
    case 'PLANNING':
    case 'RESEARCHING':
    case 'SYNTHESIZING':
    case 'AUDITING':
      return 'WORKING_NOW';
    case 'QUEUED':
      return 'UP_NEXT';
    case 'AWAITING_APPROVAL':
    case 'AWAITING_REPAIR':
    case 'NEEDS_HUMAN':
    case 'INTERRUPTED':
    case 'PAUSED_QUOTA':
      return 'WAITING';
    case 'COMPLETE':
    case 'COMPLETE_WITH_GAPS':
    case 'FAILED':
    case 'CANCELLED':
    default:
      return 'FINISHED';
  }
}

/** Which group a dispatched bin belongs in. */
export function groupOfBin(bin: Bin): MissionGroup {
  switch (bin.state) {
    case 'LEASED':
      return 'WORKING_NOW';
    case 'READY':
      return 'UP_NEXT';
    case 'DRAFT':
      // Authored and not dispatchable. It is not queued and it is not running;
      // it is being decided about, which is what EXPLORING means here.
      return 'EXPLORING';
    case 'NEEDS_HUMAN':
      return 'WAITING';
    case 'COMPLETE':
    case 'FAILED':
    case 'CANCELLED':
    default:
      return 'FINISHED';
  }
}

/**
 * What a bin's `kind` says about whose work it is.
 *
 * `kind` is free text the dispatcher never reads, so this is a projection
 * decision rather than a contract — but the four values in use are the four the
 * Brain itself creates, and an unrecognised one is treated as project work
 * because the failure that matters is hiding somebody's work, not showing one
 * extra harness row.
 */
export function provenanceOfBinKind(kind: string): WorkProvenance {
  switch (kind) {
    case 'RUSSELL_TURN':
      return 'CONVERSATION';
    case 'DETERMINISTIC_CHECK':
    case 'SURFACE_PROBE':
      return 'HARNESS';
    default:
      return 'PROJECT';
  }
}

/** The five groups, in the order a person reads them. */
export const GROUP_ORDER: readonly MissionGroup[] = [
  'WORKING_NOW',
  'UP_NEXT',
  'EXPLORING',
  'WAITING',
  'FINISHED',
];

export interface GroupedWork {
  group: MissionGroup;
  entries: WorkEntry[];
}

/**
 * Everything happening in one project, grouped and provenance-labelled.
 *
 * `includeTechnical` defaults to false, which is the addendum's rule: ordinary
 * counts are ordinary work. It is a parameter rather than a separate function
 * so that the technical view is the *same* projection deliberately opened,
 * rather than a second one that can drift from it.
 */
export async function workForProject(input: {
  projectId: string;
  includeTechnical?: boolean;
  limit?: number;
}): Promise<{ entries: WorkEntry[]; technicalHidden: number }> {
  const limit = Math.min(500, Math.max(1, input.limit ?? 200));
  const [project, missions, orchestrations, bins] = await Promise.all([
    getProject(input.projectId),
    listMissions({ projectId: input.projectId, limit }),
    listOrchestrationsByProject(input.projectId),
    listBins({ projectId: input.projectId, limit }),
  ]);

  // A technical scope makes everything inside it technical. The project's own
  // classification outranks each row's, because a fixture inside the verifier's
  // scope is not somebody's project work however ordinary the row looks.
  const scopeIsTechnical = project?.purpose === 'TECHNICAL';
  const label = (row: WorkProvenance): WorkProvenance =>
    scopeIsTechnical ? 'TECHNICAL_SCOPE' : row;

  const entries: WorkEntry[] = [];
  const claimedOrchestrations = new Set<string>();
  const claimedBins = new Set<string>();

  for (const mission of missions) {
    if (mission.orchestrationId) claimedOrchestrations.add(mission.orchestrationId);
    if (mission.binId) claimedBins.add(mission.binId);
    entries.push(fromMission(mission, label('PROJECT')));
  }

  for (const orchestration of orchestrations) {
    if (claimedOrchestrations.has(orchestration.id)) continue;
    entries.push(
      fromOrchestration(orchestration, label(orchestration.fixture ? 'FIXTURE' : 'PROJECT')),
    );
    claimedOrchestrations.add(orchestration.id);
  }

  for (const bin of bins) {
    if (claimedBins.has(bin.id)) continue;
    // A bin driving a packet already shown is the same work seen from the
    // dispatcher's side, not a second thing to do.
    if (bin.orchestrationId && claimedOrchestrations.has(bin.orchestrationId)) continue;
    entries.push(fromBin(bin, label(provenanceOfBinKind(bin.kind))));
  }

  const wanted = input.includeTechnical
    ? entries
    : entries.filter((entry) => entry.provenance === 'PROJECT');

  wanted.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { entries: wanted, technicalHidden: entries.length - wanted.length };
}

/** The same list, split into the five groups a person reads. */
export function groupWork(entries: WorkEntry[]): GroupedWork[] {
  return GROUP_ORDER.map((group) => ({
    group,
    entries: entries.filter((entry) => entry.group === group),
  }));
}

function fromMission(mission: RussellMission, provenance: WorkProvenance): WorkEntry {
  return {
    id: `mission:${mission.id}`,
    source: 'MISSION',
    sourceId: mission.id,
    group: groupOf(mission),
    provenance,
    title: mission.objective,
    why: mission.whyNow,
    state: mission.state,
    waitingOn: mission.waitingOn ?? mission.terminalReason,
    updatedAt: mission.updatedAt,
    links: {
      missionId: mission.id,
      orchestrationId: mission.orchestrationId,
      binId: mission.binId,
      documentId: mission.documentId,
      conversationId: mission.conversationId,
      layerId: mission.layerId,
    },
  };
}

function fromOrchestration(
  orchestration: ResearchOrchestration,
  provenance: WorkProvenance,
): WorkEntry {
  return {
    id: `packet:${orchestration.id}`,
    source: 'ORCHESTRATION',
    sourceId: orchestration.id,
    group: groupOfOrchestration(orchestration.status),
    provenance,
    title: orchestration.title,
    why: orchestration.assignment,
    state: orchestration.status,
    waitingOn:
      orchestration.status === 'AWAITING_APPROVAL'
        ? 'a person approving the plan before anything is spent'
        : (orchestration.failureReason ?? orchestration.repairReason),
    updatedAt:
      orchestration.completedAt ??
      orchestration.failedAt ??
      orchestration.cancelledAt ??
      orchestration.heartbeatAt ??
      orchestration.startedAt ??
      orchestration.queuedAt,
    links: {
      missionId: null,
      orchestrationId: orchestration.id,
      binId: null,
      documentId: orchestration.documentId,
      conversationId: null,
      layerId: orchestration.layerId,
    },
  };
}

function fromBin(bin: Bin, provenance: WorkProvenance): WorkEntry {
  return {
    id: `bin:${bin.id}`,
    source: 'BIN',
    sourceId: bin.id,
    group: groupOfBin(bin),
    provenance,
    title: bin.title,
    why: bin.rationale ?? bin.objective,
    state: bin.state,
    waitingOn: bin.terminalReason,
    updatedAt: bin.updatedAt,
    links: {
      missionId: null,
      orchestrationId: bin.orchestrationId,
      binId: bin.id,
      documentId: null,
      conversationId: null,
      layerId: bin.layerId,
    },
  };
}

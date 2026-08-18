/**
 * Master Planner (spec section 5).
 *
 * The product exists to answer one question — WHAT SHOULD I DO NEXT? — and this
 * module is the only place that answers it. Everything here is derived from the
 * database plus the filesystem: never from chat memory, never from a status the
 * user typed into a dropdown. Two calls a second apart return the same plan.
 *
 * Every layer contributes exactly one item. The bucket it lands in follows from
 * the layer state the state engine already derived, and its place in the queue
 * follows from a fixed numeric ladder, so the answer is stable and explainable.
 */
import { buildCanonicalName } from '../domain/naming.ts';
import {
  nextExpansionVersion,
  normalizeVersion,
  sortVersions,
  synthesisVersion,
} from '../domain/version.ts';
import type {
  Document,
  Layer,
  LayerStateSnapshot,
  PlannerItem,
  PlannerResult,
  Project,
  ResearchRun,
  VersionPolicy,
} from '../domain/types.ts';
import { listDocuments } from '../repos/documents.ts';
import { listLayers } from '../repos/layers.ts';
import { getProject } from '../repos/projects.ts';
import { listActiveRuns } from '../repos/runs.ts';
import { nowIso } from '../repos/util.ts';
import { computeLayerState, recomputeLayer } from './stateEngine.ts';
import { fileExists } from './storage.ts';

/**
 * The priority ladder. Lower sorts first, and the numbers are deliberately
 * sparse so a future rule can slot between two existing ones without renumbering
 * anything the UI or the tests already depend on.
 */
const PRIORITY = {
  /** A document row whose file vanished: nothing downstream can be trusted. */
  INCONSISTENT: 0,
  MISSING_DEPENDENCY: 10,
  /**
   * A declared expected document that is simply absent. It is a hole in the
   * layer's own packet and blocks everything downstream of it, so it outranks
   * routine work elsewhere — section 5's example board has exactly this shape and
   * names "Run Discovery Logic v1G." as the one prominent next best action, with
   * audits pending on two other layers.
   */
  MISSING_EXPECTED: 15,
  REDO: 20,
  AUDIT: 30,
  SYNTHESIS: 40,
  FREEZE: 50,
  EXPANSION: 60,
  FOUNDATION: 70,
  PARKED: 90,
  /** Frozen: finished work, kept visible for provenance only. */
  SETTLED: 100,
} as const;

/**
 * Where an item belongs before the NOW/NEXT split is applied. `ACTIONABLE` work
 * can be started right now; `WAITING` work has already been dispatched, so it
 * can never claim the NEXT BEST ACTION slot.
 */
type Placement = 'BLOCKED' | 'ACTIONABLE' | 'WAITING' | 'LATER';

interface Classification {
  placement: Placement;
  priority: number;
  actionType: PlannerItem['actionType'];
  title: string;
  /** Extra sentences merged into `detail` ahead of the generic state facts. */
  facts: string[];
  targetVersion: string | null;
  missing: string[];
}

interface PlannedLayer {
  layer: Layer;
  snapshot: LayerStateSnapshot;
  classification: Classification;
  item: PlannerItem;
}

/**
 * Build the full NOW / NEXT / LATER / BLOCKED plan for a project.
 *
 * Read-only by design: it consumes the snapshots the state engine derives and
 * never writes, so the API can call it on every page load without generating
 * events or fighting a concurrent recompute.
 */
export function buildPlan(projectId: string): PlannerResult {
  const project = requireProject(projectId);
  const layers = listLayers(projectId);
  const documentsByLayer = groupByLayer(listDocuments(projectId));
  const runsByLayer = groupByLayer(listActiveRuns(projectId));

  const planned: PlannedLayer[] = layers.map((layer) => {
    const snapshot = computeLayerState(layer.id);
    const documents = documentsByLayer.get(layer.id) ?? [];
    const runs = runsByLayer.get(layer.id) ?? [];
    const classification = classify({
      layer,
      snapshot,
      policy: project.versionPolicy,
      documents,
      runs,
    });
    const item: PlannerItem = {
      // Provisional: the real bucket is assigned once the whole project is ranked.
      bucket: 'NEXT',
      layerId: layer.id,
      layerName: snapshot.layerName || layer.name,
      status: snapshot.status,
      title: classification.title,
      detail: buildDetail(layer, snapshot, classification, runs),
      priority: classification.priority,
      actionType: classification.actionType,
      targetVersion: classification.targetVersion,
      missing: classification.missing,
    };
    return { layer, snapshot, classification, item };
  });

  const blocked: PlannedLayer[] = [];
  const later: PlannedLayer[] = [];
  const waiting: PlannedLayer[] = [];
  const actionable: PlannedLayer[] = [];

  for (const entry of planned) {
    // Work that belongs to a later wave than the project is on is real work,
    // just not now — it is parked in LATER so it cannot hijack NEXT BEST ACTION.
    const farOff =
      entry.layer.currentWave > project.currentWave &&
      (entry.classification.placement === 'ACTIONABLE' ||
        entry.classification.placement === 'WAITING');
    const placement: Placement = farOff ? 'LATER' : entry.classification.placement;
    if (placement === 'BLOCKED') blocked.push(entry);
    else if (placement === 'LATER') later.push(entry);
    else if (placement === 'WAITING') waiting.push(entry);
    else actionable.push(entry);
  }

  blocked.sort(byPriorityThenLayer);
  later.sort(byPriorityThenLayer);
  waiting.sort(byPriorityThenLayer);
  actionable.sort(byPriorityThenLayer);

  // NOW holds exactly one thing: the single highest-priority startable item.
  const head = actionable.at(0) ?? null;
  const nowEntries = head ? [head] : [];
  const nextEntries = [...actionable.slice(1), ...waiting].sort(byPriorityThenLayer);

  assignBucket(nowEntries, 'NOW');
  assignBucket(nextEntries, 'NEXT');
  assignBucket(later, 'LATER');
  assignBucket(blocked, 'BLOCKED');

  const now = nowEntries.map((entry) => entry.item);
  const next = nextEntries.map((entry) => entry.item);

  // The single prominent answer considers blocked work too. A missing file or a
  // missing dependency is something the user can act on right now, and it
  // outranks ordinary research — the spec's own example makes "Discovery Logic
  // is blocked on v1G" produce the next best action, not the audit elsewhere.
  const nextBestAction =
    [...blocked, ...actionable].sort(byPriorityThenLayer).at(0)?.item ?? null;

  return {
    projectId: project.id,
    projectName: project.name,
    wave: project.currentWave,
    now,
    next,
    later: later.map((entry) => entry.item),
    blocked: blocked.map((entry) => entry.item),
    nextBestAction,
    nextBestActionText: buildNextBestActionText({
      layerCount: layers.length,
      nextBestAction,
      blocked: blocked.map((entry) => entry.item),
      waiting: waiting.map((entry) => entry.item),
    }),
    layers: planned.map((entry) => entry.snapshot),
    generatedAt: nowIso(),
  };
}

/**
 * The one sentence the UI puts at the top of the screen, as a `PlannerItem`.
 *
 * Unlike `buildPlan` this is the deliberate "recalculate" entry point (the chat
 * tool `calculate_next_action` and the next-action endpoint use it), so it first
 * re-derives and persists each layer's status. That keeps the stored layer rows honest
 * after an out-of-band change without ever changing the answer it returns.
 */
export function calculateNextAction(projectId: string): PlannerItem | null {
  requireProject(projectId);
  for (const layer of listLayers(projectId)) {
    recomputeLayer(layer.id);
  }
  return buildPlan(projectId).nextBestAction;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classify(input: {
  layer: Layer;
  snapshot: LayerStateSnapshot;
  policy: VersionPolicy;
  documents: Document[];
  runs: ResearchRun[];
}): Classification {
  const { layer, snapshot, policy, documents, runs } = input;
  const name = snapshot.layerName || layer.name;
  const running = runs.filter((run) => run.status === 'RUNNING');
  const auditPending = runs.some((run) => run.status === 'AUDIT_REQUIRED');
  const synthVersion = synthesisVersion(policy);

  // Invariant 9: a registered document whose file disappeared makes every other
  // conclusion about this layer unsafe, so it outranks even a parked layer.
  if (snapshot.inconsistentDocuments.length > 0) {
    const first = snapshot.inconsistentDocuments[0] ?? name;
    return {
      placement: 'BLOCKED',
      priority: PRIORITY.INCONSISTENT,
      actionType: 'RECONCILE',
      title: `Restore the missing file for ${first}.`,
      facts: [
        `${snapshot.inconsistentDocuments.length} registered document(s) have no file on disk: ${formatList(snapshot.inconsistentDocuments)}.`,
        'Put the file back or re-import it, then run a reconcile scan.',
      ],
      targetVersion: null,
      missing: [...snapshot.inconsistentDocuments],
    };
  }

  if (snapshot.status === 'PARKED') {
    return {
      placement: 'LATER',
      priority: PRIORITY.PARKED,
      actionType: 'NONE',
      title: `${name} is parked.`,
      facts: [layer.parkedNote ?? snapshot.nextAction ?? 'Deferred to a future wave.'],
      targetVersion: null,
      missing: [],
    };
  }

  if (snapshot.status === 'FROZEN') {
    const canonical = snapshot.canonicalName ?? canonicalOrNull(name, snapshot.currentVersion);
    return {
      placement: 'LATER',
      priority: PRIORITY.SETTLED,
      actionType: 'NONE',
      title: canonical ? `${name} is frozen on ${canonical}.` : `${name} is frozen.`,
      facts: [
        canonical
          ? 'Earlier research is kept as provenance.'
          : 'No canonical document is recorded for this frozen layer, which should be reconciled.',
        'Nothing to do unless the layer is explicitly reopened.',
      ],
      targetVersion: snapshot.currentVersion,
      missing: [],
    };
  }

  if (snapshot.status === 'BLOCKED' || snapshot.missingDependencies.length > 0) {
    return blockedByDependencies(name, snapshot);
  }

  switch (snapshot.status) {
    case 'MORE_RESEARCH_REQUIRED': {
      const target = snapshot.nextVersion ?? snapshot.currentVersion;
      if (running.length > 0) {
        return {
          placement: 'WAITING',
          priority: PRIORITY.REDO,
          actionType: 'WAIT',
          title: `Wait for the ${name} redo to come back, then import it.`,
          facts: ['A corrected run is already in flight; the original attempt is preserved.'],
          targetVersion: target,
          missing: [],
        };
      }
      return {
        placement: 'ACTIONABLE',
        priority: PRIORITY.REDO,
        actionType: 'RUN_REDO',
        title: target
          ? `Redo ${buildCanonicalName(name, target)}.`
          : `Run the corrective research for ${name}.`,
        facts: ['The audit rejected the current work; the failed attempt stays on record.'],
        targetVersion: target,
        missing: [],
      };
    }

    case 'AUDIT_READY': {
      // The state engine picked the *first unaudited* document, which is not the
      // same as the highest version — prefer its answer so the layer row and the
      // planner never name different documents.
      const target = snapshot.nextVersion ?? snapshot.currentVersion ?? latestUsableVersion(documents);
      return {
        placement: 'ACTIONABLE',
        priority: PRIORITY.AUDIT,
        actionType: 'RUN_AUDIT',
        title: target ? `Audit ${buildCanonicalName(name, target)}.` : `Audit ${name}.`,
        facts: ['Every expected document is present and none of them has been audited yet.'],
        targetVersion: target,
        missing: [],
      };
    }

    case 'AUDITING': {
      const target = snapshot.nextVersion ?? snapshot.currentVersion ?? latestUsableVersion(documents);
      if (running.length > 0 && !auditPending) {
        return {
          placement: 'WAITING',
          priority: PRIORITY.AUDIT,
          actionType: 'WAIT',
          title: `Wait for the ${name} audit to come back.`,
          facts: ['An audit run is in flight; record its structured verdict when it returns.'],
          targetVersion: target,
          missing: [],
        };
      }
      return {
        placement: 'ACTIONABLE',
        priority: PRIORITY.AUDIT,
        actionType: 'RUN_AUDIT',
        title: target ? `Audit ${buildCanonicalName(name, target)}.` : `Audit ${name}.`,
        facts: ['A completed run is waiting on its audit before the layer can move on.'],
        targetVersion: target,
        missing: [],
      };
    }

    case 'SYNTHESIS_READY': {
      const freezeTarget = freezeCandidate(snapshot, documents, synthVersion);
      if (freezeTarget) {
        return {
          placement: 'ACTIONABLE',
          priority: PRIORITY.FREEZE,
          actionType: 'FREEZE_LAYER',
          title: `Freeze ${name} on ${freezeTarget.canonicalName}.`,
          facts: ['The canonical artifact exists and its audit cleared it for freezing.'],
          targetVersion: freezeTarget.version,
          missing: [],
        };
      }
      return {
        placement: 'ACTIONABLE',
        priority: PRIORITY.SYNTHESIS,
        actionType: 'RUN_SYNTHESIS',
        title: `Run ${buildCanonicalName(name, synthVersion)}.`,
        facts: ['The source packet is complete, so the canonical synthesis can be compiled.'],
        targetVersion: synthVersion,
        missing: [],
      };
    }

    case 'SYNTHESIS_RUNNING':
      return {
        placement: 'WAITING',
        priority: PRIORITY.SYNTHESIS,
        actionType: 'WAIT',
        title: `Import ${buildCanonicalName(name, synthVersion)} when the synthesis run returns.`,
        facts: ['The synthesis is already running; nothing else should start in this layer.'],
        targetVersion: synthVersion,
        missing: [],
      };

    case 'INCOMPLETE': {
      const target = sortVersions(snapshot.missingVersions).at(0) ?? null;
      if (!target) {
        return continueExpansion(name, snapshot, policy, running, [
          'The layer is incomplete but no specific version is outstanding.',
        ]);
      }
      return {
        placement: running.length > 0 ? 'WAITING' : 'ACTIONABLE',
        priority: running.length > 0 ? PRIORITY.EXPANSION : PRIORITY.MISSING_EXPECTED,
        actionType: running.length > 0 ? 'WAIT' : actionForVersion(target, policy),
        title:
          running.length > 0
            ? `Import ${buildCanonicalName(name, target)} when the running ${name} research returns.`
            : `Run ${buildCanonicalName(name, target)}.`,
        facts: [
          `${snapshot.missingVersions.length} expected document(s) are still absent: ` +
            `${snapshot.missingVersions.map((version) => buildCanonicalName(name, version)).join(', ')}.`,
        ],
        targetVersion: target,
        missing: snapshot.missingVersions.map((version) => buildCanonicalName(name, version)),
      };
    }

    case 'RESEARCHING':
      return continueExpansion(name, snapshot, policy, running, []);

    case 'REOPENED':
      return continueExpansion(name, snapshot, policy, running, [
        'The layer was reopened, so its previous canonical document no longer settles it.',
      ]);

    case 'NOT_STARTED': {
      const target =
        sortVersions(snapshot.expectedVersions).at(0) ?? normalizeVersion(policy.foundationVersion);
      return {
        placement: 'ACTIONABLE',
        priority: PRIORITY.FOUNDATION,
        actionType: actionForVersion(target, policy),
        title: `Run ${buildCanonicalName(name, target)}.`,
        facts:
          snapshot.expectedVersions.length > 0
            ? [`${snapshot.expectedVersions.length} document(s) are expected in this layer.`]
            : [],
        targetVersion: target,
        missing: snapshot.expectedVersions.map((version) => buildCanonicalName(name, version)),
      };
    }
  }
}

/** A layer waiting on documents it does not own — the BLOCKED bucket. */
function blockedByDependencies(name: string, snapshot: LayerStateSnapshot): Classification {
  const missing = [...snapshot.missingDependencies];
  const first = missing[0];
  return {
    placement: 'BLOCKED',
    priority: PRIORITY.MISSING_DEPENDENCY,
    actionType: 'RESOLVE_DEPENDENCY',
    title: first
      ? `Provide ${first} to unblock ${name}.`
      : `Resolve what is blocking ${name}.`,
    facts: first
      ? ['A dependency only counts once the document exists, is complete and its file is on disk.']
      : [snapshot.nextAction || 'The layer is blocked and needs a human decision.'],
    targetVersion: snapshot.nextVersion,
    missing,
  };
}

/** The generic "add the next sibling expansion" outcome. */
function continueExpansion(
  name: string,
  snapshot: LayerStateSnapshot,
  policy: VersionPolicy,
  running: ResearchRun[],
  facts: string[],
): Classification {
  const outstanding = sortVersions(snapshot.missingVersions).at(0) ?? null;
  const target = outstanding ?? nextExpansionVersion(snapshot.presentVersions, policy);
  if (running.length > 0) {
    return {
      placement: 'WAITING',
      priority: PRIORITY.EXPANSION,
      actionType: 'WAIT',
      title: `Import the ${name} research when the running attempt returns.`,
      facts,
      targetVersion: target,
      missing: snapshot.missingVersions.map((version) => buildCanonicalName(name, version)),
    };
  }
  return {
    placement: 'ACTIONABLE',
    priority: PRIORITY.EXPANSION,
    actionType: actionForVersion(target, policy),
    title: `Run ${buildCanonicalName(name, target)}.`,
    facts: facts.length > 0 ? facts : ['Research is under way; the next sibling expansion is due.'],
    targetVersion: target,
    missing: snapshot.missingVersions.map((version) => buildCanonicalName(name, version)),
  };
}

/** Which kind of run produces a given version under this project's policy. */
function actionForVersion(version: string, policy: VersionPolicy): PlannerItem['actionType'] {
  const normalized = normalizeVersion(version);
  if (normalized === synthesisVersion(policy)) return 'RUN_SYNTHESIS';
  if (normalized === normalizeVersion(policy.foundationVersion)) return 'RUN_FOUNDATION';
  return 'RUN_EXPANSION';
}

/**
 * The document a freeze would make canonical, or null when there is nothing to
 * freeze onto. Invariant 6: never propose freezing a layer with no artifact.
 */
function freezeCandidate(
  snapshot: LayerStateSnapshot,
  documents: Document[],
  synthVersion: string,
): Document | null {
  const usable = documents.filter(isUsable);
  const synthesisDocument =
    usable.find((doc) => normalizeVersion(doc.version) === synthVersion) ?? null;
  if (snapshot.latestAuditVerdict === 'READY_TO_FREEZE') {
    return synthesisDocument ?? highestVersion(usable);
  }
  if (
    synthesisDocument &&
    (snapshot.latestAuditVerdict === 'PASS' || snapshot.latestAuditVerdict === 'KEEP')
  ) {
    return synthesisDocument;
  }
  return null;
}

/**
 * Invariants 8 and 9: a document only counts when the database says it is
 * finished AND its bytes are actually on disk right now.
 */
function isUsable(doc: Document): boolean {
  if (doc.status !== 'COMPLETE' && doc.status !== 'FROZEN') return false;
  if (doc.fileMissing) return false;
  return fileExists(doc.filesystemPath);
}

function highestVersion(documents: Document[]): Document | null {
  return (
    [...documents].sort((a, b) => a.versionSort.localeCompare(b.versionSort)).at(-1) ?? null
  );
}

function latestUsableVersion(documents: Document[]): string | null {
  return highestVersion(documents.filter(isUsable))?.version ?? null;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * The supporting sentences under an item's title: the state engine's reason
 * first, then the facts the spec asks to be visible per layer (progress,
 * missing documents, dependencies, active runs, freeze status).
 */
function buildDetail(
  layer: Layer,
  snapshot: LayerStateSnapshot,
  classification: Classification,
  runs: ResearchRun[],
): string {
  const parts: string[] = [];
  const reason = snapshot.reason.trim();
  if (reason) parts.push(reason);
  parts.push(...classification.facts.filter((fact) => fact.trim().length > 0));
  if (snapshot.documentsExpected > 0) {
    parts.push(
      `${snapshot.documentsComplete} of ${snapshot.documentsExpected} expected documents complete`,
    );
  }
  if (snapshot.missingVersions.length > 0) {
    const name = snapshot.layerName || layer.name;
    parts.push(
      `Missing: ${formatList(snapshot.missingVersions.map((version) => buildCanonicalName(name, version)))}`,
    );
  }
  if (snapshot.missingDependencies.length > 0) {
    parts.push(`Waiting on: ${formatList(snapshot.missingDependencies)}`);
  }
  const running = runs.filter((run) => run.status === 'RUNNING');
  if (running.length > 0) {
    parts.push(`${running.length} run${running.length === 1 ? '' : 's'} in progress`);
  }
  if (snapshot.latestAuditVerdict) {
    parts.push(`Latest audit verdict: ${snapshot.latestAuditVerdict}`);
  }
  if (snapshot.canonicalName && classification.actionType !== 'NONE') {
    parts.push(`${snapshot.frozen ? 'Canonical' : 'Current'}: ${snapshot.canonicalName}`);
  }
  return dedupe(parts.map(asSentence)).join(' ');
}

/** The single prominent line. When there is nothing to do it says exactly that. */
function buildNextBestActionText(input: {
  layerCount: number;
  nextBestAction: PlannerItem | null;
  blocked: PlannerItem[];
  waiting: PlannerItem[];
}): string {
  if (input.nextBestAction) return input.nextBestAction.title;
  if (input.layerCount === 0) {
    return 'No layers yet. Add a layer to this project to get started.';
  }
  const firstBlocked = input.blocked[0];
  if (firstBlocked) {
    return `Nothing can start yet. ${asSentence(firstBlocked.title)}`;
  }
  if (input.waiting.length > 0) {
    const count = input.waiting.length;
    return `Nothing to start. ${count} layer${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} waiting on work already in flight; import each result when it returns.`;
  }
  return 'Nothing to do. Every layer is frozen or parked.';
}

/**
 * Drop repeated sentences. The state engine's `reason` often already embeds a
 * fact (a parked note, for instance), so an exact-match filter is not enough:
 * anything a kept sentence already contains is dropped too.
 */
function dedupe(values: string[]): string[] {
  const kept: { key: string; value: string }[] = [];
  for (const value of values) {
    if (!value) continue;
    const key = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) continue;
    const redundant = kept.some(
      (entry) => entry.key === key || (key.length >= 12 && entry.key.includes(key)),
    );
    if (redundant) continue;
    kept.push({ key, value });
  }
  return kept.map((entry) => entry.value);
}

function asSentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** `a, b and 2 more` — keeps planner details readable with long missing lists. */
function formatList(values: string[], limit = 4): string {
  if (values.length === 0) return 'nothing';
  if (values.length <= limit) {
    if (values.length === 1) return values[0] ?? '';
    return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1] ?? ''}`;
  }
  return `${values.slice(0, limit).join(', ')} and ${values.length - limit} more`;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function requireProject(projectId: string): Project {
  const project = getProject(projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  return project;
}

function groupByLayer<T extends { layerId: string | null }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.layerId) continue;
    const bucket = grouped.get(row.layerId);
    if (bucket) bucket.push(row);
    else grouped.set(row.layerId, [row]);
  }
  return grouped;
}

/** Ties break on layer order so the plan never reshuffles between calls. */
function byPriorityThenLayer(a: PlannedLayer, b: PlannedLayer): number {
  return (
    a.item.priority - b.item.priority ||
    a.layer.orderIndex - b.layer.orderIndex ||
    a.layer.id.localeCompare(b.layer.id)
  );
}

function assignBucket(entries: PlannedLayer[], bucket: PlannerItem['bucket']): void {
  for (const entry of entries) entry.item.bucket = bucket;
}

function canonicalOrNull(layerName: string, version: string | null): string | null {
  return version ? buildCanonicalName(layerName, version) : null;
}

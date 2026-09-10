/**
 * The consumer for `OTHER_LAYER`.
 *
 * ---------------------------------------------------------------------------
 * What was missing
 * ---------------------------------------------------------------------------
 *
 * `auditProfile.ts` has always said what `OTHER_LAYER` means — *"The issue is
 * real but a different layer owns it. Record the handoff; do not open research
 * in this layer for it."* — and Brain recorded the handoff faithfully: the
 * judge's structured output names an `owning_layer`, `schema.ts` refuses the
 * classification without one, `toGapInputs` resolves that name to a real layer
 * id, and `recordAuditPasses` writes an `OTHER_LAYER_HANDOFF` finding beside
 * it.
 *
 * Then nothing read any of it. The handoff was a fact in the database with no
 * consequence, so a document filed under the wrong layer stayed there, its
 * packet parked at `NEEDS_HUMAN`, and a person was asked a question the rows
 * had already answered. §24's rule at yet another altitude: **a mechanism
 * nothing calls is not a mechanism.**
 *
 * ---------------------------------------------------------------------------
 * What this is, and what it is careful not to be
 * ---------------------------------------------------------------------------
 *
 * It is a routing decision, and routing is the one thing an `OTHER_LAYER`
 * classification is *for*. It is not a judgment about the research: the claims,
 * the citations, the ledger, the stored bytes, the extraction runs, the audit
 * row and every gap on it are untouched, and nothing here re-opens or rewrites
 * a verdict. The document keeps its id and its bytes keep their storage key —
 * where a file was written is a fact about history, and moving objects in a
 * bucket to make a path read tidily would be an external effect performed for
 * cosmetics.
 *
 * What changes is ownership: `documents.layer_id`, and with it the three names
 * §4 derives from (layer, version) — because a document filed under Discovery
 * Logic that still calls itself "World Model v1B" is the naming lie that rule
 * exists to prevent.
 *
 * **The decision is a pure function over rows** (`decideHandoff`), for the
 * reason §23 keeps the router pure and §16 keeps the envelope in code: the
 * thing that decides must not be the thing that can be talked into a different
 * answer. It reads gap rows a validator already checked and a layer list Brain
 * owns; no prose is parsed, and a layer name the judge invented resolves to
 * nothing and is refused.
 *
 * **Exactly one owner, or a person.** Zero named owners, a name that matches no
 * layer of this project, two different owners across the audit's gaps, or a
 * document already in the named layer — each is its own refusal with its own
 * word, and each leaves the park exactly where it was. Ambiguity is the case a
 * person is *for*; a routing engine that guesses between two owners is worse
 * than one that admits it cannot tell.
 */
import { getAudit } from '../../repos/audits.ts';
import { getDocument, listDocumentsByLayer, updateDocument } from '../../repos/documents.ts';
import { getLayer, listLayers } from '../../repos/layers.ts';
import { getOrchestration, updateOrchestration } from '../../repos/research.ts';
import { getMissionByOrchestration, linkMission } from '../../repos/russellMissions.ts';
import { recordEvent } from '../../repos/events.ts';
import { getDb } from '../../db/database.ts';
import { buildNames } from '../../domain/naming.ts';
import { nextExpansionVersion, parseVersion, versionSortKey } from '../../domain/version.ts';
import type { AuditGap, Document, Layer } from '../../domain/types.ts';

/**
 * Bumped when the rule changes, and recorded on every routing.
 *
 * "Brain moved this document" is auditable only if you can tell which version
 * of the rule moved it — the same reasoning that puts a validator version on an
 * automatic approval.
 */
export const HANDOFF_DECIDER_VERSION = '2026-09-09.1';

/** Why a handoff was not performed. A closed set, so a caller can branch. */
export type HandoffRefusal =
  | 'NO_AUDITED_DOCUMENT'
  | 'NO_OTHER_LAYER_GAP'
  | 'NO_OWNING_LAYER_NAMED'
  | 'OWNING_LAYER_UNKNOWN'
  | 'AMBIGUOUS_OWNERS'
  | 'ALREADY_IN_OWNING_LAYER';

export type HandoffDecision =
  | { ok: true; targetLayerId: string; gapId: string; owningLayerName: string }
  | { ok: false; refusal: HandoffRefusal; detail: string };

/**
 * Which layer, if exactly one, this audit says owns the document it read.
 *
 * Pure and total: rows in, one decision out, no clock and no database. That is
 * what makes it testable against every shape of malformed judgment without
 * arranging a project, and what stops it being the sort of check that quietly
 * acquires an exception.
 *
 * `layers` is the project's own layer list, so an `owning_layer_id` that
 * belongs to some other project resolves to nothing here and is refused —
 * crossing a project boundary is not a routing decision, it is a different
 * question with a different authorization.
 */
export function decideHandoff(input: {
  gaps: AuditGap[];
  layers: Layer[];
  documentLayerId: string | null;
}): HandoffDecision {
  const owned = input.gaps.filter((gap) => gap.classification === 'OTHER_LAYER');
  if (owned.length === 0) {
    return {
      ok: false,
      refusal: 'NO_OTHER_LAYER_GAP',
      detail: 'This audit recorded no gap classified OTHER_LAYER, so nothing asked for a handoff.',
    };
  }

  const named = owned.filter((gap) => (gap.owningLayerName ?? '').trim().length > 0);
  if (named.length === 0) {
    return {
      ok: false,
      refusal: 'NO_OWNING_LAYER_NAMED',
      detail:
        'An OTHER_LAYER gap named no owning layer, so there is no destination to route to. ' +
        'A person decides where this belongs.',
    };
  }

  /*
   * Resolved here rather than trusted from the row.
   *
   * `toGapInputs` already matched the judge's layer name against the project's
   * layers when the gap was written, but a layer can be renamed or removed
   * between then and now, and a stored id is only as good as the row it points
   * at. Re-resolving costs one list and makes the decision true of the project
   * as it is rather than as it was.
   */
  const byId = new Map(input.layers.map((layer) => [layer.id, layer]));
  const byName = new Map(input.layers.map((layer) => [normalize(layer.name), layer]));

  const resolved: { gap: AuditGap; layer: Layer }[] = [];
  const unresolved: string[] = [];
  for (const gap of named) {
    const layer =
      (gap.owningLayerId ? byId.get(gap.owningLayerId) : undefined) ??
      byName.get(normalize(gap.owningLayerName));
    if (layer) resolved.push({ gap, layer });
    else unresolved.push(gap.owningLayerName!.trim());
  }

  if (resolved.length === 0) {
    return {
      ok: false,
      refusal: 'OWNING_LAYER_UNKNOWN',
      detail:
        `No layer of this project is named ${unresolved.map((name) => `"${name}"`).join(' or ')}. ` +
        'A destination that does not exist is not a routing decision.',
    };
  }

  /*
   * More than one distinct destination is the case a person exists for.
   *
   * Two gaps naming the same layer are one destination and route fine — that is
   * a judge making the same point twice. Two gaps naming *different* layers are
   * a genuine disagreement about ownership, and picking either one would be
   * Brain inventing an answer the evidence does not contain.
   */
  const distinct = new Set(resolved.map((entry) => entry.layer.id));
  if (distinct.size > 1) {
    const names = resolved.map((entry) => entry.layer.name).sort();
    return {
      ok: false,
      refusal: 'AMBIGUOUS_OWNERS',
      detail:
        `This audit names more than one owning layer (${[...new Set(names)].join(', ')}), so which ` +
        'one owns the document is a decision the rows do not settle.',
    };
  }

  const first = resolved[0]!;
  if (unresolved.length > 0) {
    /*
     * One resolvable owner and one that names nothing is still ambiguous.
     *
     * It would be easy to route on the one that resolved and treat the other as
     * noise, and that is exactly the shortcut that turns a routing engine into
     * a guesser: the unresolvable name may be the *right* answer, misspelt.
     */
    return {
      ok: false,
      refusal: 'AMBIGUOUS_OWNERS',
      detail:
        `This audit names ${first.layer.name} and also ${unresolved
          .map((name) => `"${name}"`)
          .join(', ')}, which matches no layer of this project.`,
    };
  }

  if (input.documentLayerId === first.layer.id) {
    return {
      ok: false,
      refusal: 'ALREADY_IN_OWNING_LAYER',
      detail: `The document is already filed under ${first.layer.name}.`,
    };
  }

  return {
    ok: true,
    targetLayerId: first.layer.id,
    gapId: first.gap.id,
    owningLayerName: first.layer.name,
  };
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface HandoffOutcome {
  ok: boolean;
  auditId: string;
  documentId: string | null;
  fromLayerId: string | null;
  toLayerId: string | null;
  /** The canonical name the document now carries. */
  canonicalName: string | null;
  refusal: HandoffRefusal | null;
  detail: string;
}

/**
 * Route one audited document to the layer its audit says owns it.
 *
 * Idempotent by the state it produces rather than by a flag: once the document
 * is in the owning layer the decision refuses with `ALREADY_IN_OWNING_LAYER`,
 * so a caller that re-derives this from rows on every tick performs it once and
 * then does nothing for ever. There is no column saying "handed off" to fall
 * out of step with where the document actually is.
 */
export async function routeAuditedDocument(input: { auditId: string }): Promise<HandoffOutcome> {
  const audit = await getAudit(input.auditId);
  if (!audit) {
    return refuse(input.auditId, 'NO_AUDITED_DOCUMENT', 'That audit does not exist.');
  }

  const documentId = audit.auditedDocumentId ?? audit.auditedDocumentIds[0] ?? null;
  const document = documentId ? await getDocument(documentId) : null;
  if (!document) {
    return refuse(
      audit.id,
      'NO_AUDITED_DOCUMENT',
      'This audit read no single filed document, so there is nothing to route.',
    );
  }

  const layers = await listLayers(audit.projectId);
  const decision = decideHandoff({
    gaps: audit.gaps,
    layers,
    documentLayerId: document.layerId,
  });
  if (!decision.ok) {
    return {
      ok: false,
      auditId: audit.id,
      documentId: document.id,
      fromLayerId: document.layerId,
      toLayerId: null,
      canonicalName: null,
      refusal: decision.refusal,
      detail: decision.detail,
    };
  }

  const target = layers.find((layer) => layer.id === decision.targetLayerId)!;
  const version = await versionInLayer(document, target);
  const names = buildNames(target.name, version, extensionOf(document));
  const fromLayerId = document.layerId;
  const fromLayer = fromLayerId ? await getLayer(fromLayerId) : null;

  /*
   * The bytes do not move, and that is deliberate.
   *
   * `storage_key` is where Brain wrote this file, which is a fact about what
   * happened rather than a description of what the document is *about*. Copying
   * an object in the bucket so a path reads tidily is an external effect with
   * its own failure modes, performed for cosmetics, and §18 is explicit that a
   * key is built from Brain's own identifiers rather than from meaning.
   *
   * So `filesystemPath` and `storageKey` are deliberately absent from this
   * patch — `updateDocument` derives `storage_key` from `filesystemPath` when
   * one is given, and passing either would silently re-point the row at bytes
   * that are not there.
   */
  await updateDocument(document.id, {
    layerId: target.id,
    version,
    versionSort: versionSortKey(version),
    canonicalName: names.canonicalName,
    conversationTitle: names.conversationTitle,
    filename: names.filename,
  });

  /*
   * The packet follows its document.
   *
   * An orchestration carries the layer its audit context is built from, so
   * leaving it pointing at the old layer would mean the next audit reads the
   * document against the criteria of a layer it has left — which is the exact
   * mistake this handoff exists to correct, repeated one round later.
   */
  const orchestration = audit.runId ? await orchestrationForDocument(document.id) : null;
  if (orchestration && orchestration.layerId !== target.id) {
    await updateOrchestration(orchestration.id, { layerId: target.id });
  }

  /*
   * And the mission, which is the third row carrying the same ownership fact.
   *
   * `documents.layer_id`, `research_orchestrations.layer_id` and
   * `russell_missions.layer_id` all say which layer this work belongs to, so a
   * routing that moved two of them and left the third produced a mission that
   * reported a filed report under a heading its own audit said was wrong — and
   * `writeBack` files the project's conclusion under exactly that column. It
   * *was* corrected, in the Russell loop's re-open path, which meant it was
   * corrected only when the Russell loop was the caller. Ownership belongs to
   * the routing decision rather than to whichever consumer notices it.
   *
   * The audit link is deliberately not touched here: this round has not
   * produced a verdict yet, and `completionLinks.ts` is what points a mission
   * at the one it eventually does.
   */
  if (orchestration) {
    const mission = await getMissionByOrchestration(orchestration.id);
    if (mission && mission.layerId !== target.id) {
      await linkMission({ missionId: mission.id, layerId: target.id });
    }
  }

  /*
   * Append-only, and it carries everything needed to explain the move later:
   * which audit decided it, which gap, where from, where to, and under which
   * version of this rule. A document that changed layers with no row saying why
   * is indistinguishable from one somebody edited by hand.
   */
  await recordEvent({
    projectId: audit.projectId,
    layerId: target.id,
    entityType: 'DOCUMENT',
    entityId: document.id,
    eventType: 'DOCUMENT_HANDED_OFF',
    payload: {
      auditId: audit.id,
      gapId: decision.gapId,
      fromLayerId,
      fromLayerName: fromLayer?.name ?? null,
      toLayerId: target.id,
      toLayerName: target.name,
      previousCanonicalName: document.canonicalName,
      canonicalName: names.canonicalName,
      previousVersion: document.version,
      version,
      orchestrationId: orchestration?.id ?? null,
      deciderVersion: HANDOFF_DECIDER_VERSION,
    },
  });

  return {
    ok: true,
    auditId: audit.id,
    documentId: document.id,
    fromLayerId,
    toLayerId: target.id,
    canonicalName: names.canonicalName,
    refusal: null,
    detail:
      `${document.canonicalName} is ${target.name}'s, and is now filed there as ` +
      `${names.canonicalName}.`,
  };
}

function refuse(auditId: string, refusal: HandoffRefusal, detail: string): HandoffOutcome {
  return {
    ok: false,
    auditId,
    documentId: null,
    fromLayerId: null,
    toLayerId: null,
    canonicalName: null,
    refusal,
    detail,
  };
}

/** `.md`, `.pdf` — whatever the file already is. The move is not a conversion. */
function extensionOf(document: Document): string {
  const match = /(\.[A-Za-z0-9]{1,8})$/.exec(document.filename ?? '');
  return match?.[1]?.toLowerCase() ?? '.pdf';
}

/**
 * Which version this document takes in its new layer.
 *
 * It keeps its own version when that version is free there, because a document
 * that was `v1B` and is still the same bytes has no reason to be renumbered —
 * and the smaller the change, the less of the provenance a reader has to
 * reconcile. When the version is already taken in the destination, the next
 * expansion version is derived by the same policy every other document uses;
 * inventing a number here would be exactly the naming improvisation §4 forbids.
 */
async function versionInLayer(document: Document, target: Layer): Promise<string> {
  const existing = (await listDocumentsByLayer(target.id))
    .filter((other) => other.id !== document.id)
    .map((other) => other.version);
  const mine = parseVersion(document.version);
  const taken = new Set(existing.map((value) => parseVersion(value).normalized));
  if (mine.valid && !taken.has(mine.normalized)) return mine.normalized;
  return nextExpansionVersion(existing);
}

/** The packet that filed this document, if one did. */
async function orchestrationForDocument(documentId: string) {
  const row = await getDb().get<{ id: string }>(
    'SELECT id FROM research_orchestrations WHERE document_id = ? ORDER BY created_at DESC LIMIT 1',
    [documentId],
  );
  return row ? await getOrchestration(row.id) : null;
}

/**
 * Audits whose handoff has not been acted on, newest first.
 *
 * Derived entirely from rows — an audit with an `OTHER_LAYER` gap over a filed
 * document — rather than from a queue or a flag. That is what lets one caller
 * cover an audit recorded a second ago and one recorded before this code
 * existed alike, and it is why performing the routing is what stops it being
 * selected again.
 *
 * Deliberately looser than `decideHandoff`, and never stricter. A selector that
 * filtered on `owning_layer_id` would silently skip a gap whose owner resolves
 * by name — and would be a second, quieter copy of the rule that decides, which
 * is how the two come to disagree. This finds anything that might be a handoff;
 * the pure function says whether it is.
 */
export async function handoffCandidates(limit = 5): Promise<string[]> {
  const rows = await getDb().all<{ audit_id: string; created_at: string }>(
    `SELECT DISTINCT g.audit_id AS audit_id, a.created_at AS created_at
       FROM audit_gaps g
       JOIN audits a ON a.id = g.audit_id
       JOIN documents d ON d.id = a.audited_document_id
      WHERE g.classification = 'OTHER_LAYER'
        AND d.layer_id IS NOT NULL
      ORDER BY a.created_at DESC
      LIMIT ?`,
    [Math.max(1, limit)],
  );
  return rows.map((row) => row.audit_id);
}

/**
 * What a mission's completion links must point at, and correcting one that
 * already wrote back against links that had gone stale.
 *
 * ---------------------------------------------------------------------------
 * What was wrong
 * ---------------------------------------------------------------------------
 *
 * `russell_missions` carries three pointers at what its packet produced —
 * `document_id`, `audit_id` and `layer_id` — and the writeback reads all three:
 * `recordKnowledge` files the conclusion under `mission.layerId`, and the
 * provenance it attaches is built from `mission.documentId` and
 * `mission.auditId`. So those three columns decide what the project ends up
 * believing and where it believes it.
 *
 * They were filled once and then trusted for ever. `linkFiledWork` returned
 * early the moment the document and the audit were both non-null, which is
 * correct exactly while a packet is audited once — and §22's `OTHER_LAYER`
 * handoff is the case where it is not. A handoff moves the document to the
 * layer its own audit named, re-opens the packet, and a second round of three
 * roles produces a *new* audit. After that:
 *
 *   - the mission's `audit_id` still names round one's verdict, which is the
 *     one that said the work belonged somewhere else;
 *   - the mission's `layer_id` was aligned only by the Russell loop's own
 *     re-open path, so any other caller of the handoff left it behind;
 *   - and both were non-null, so the early return guaranteed neither would
 *     ever be revisited.
 *
 * In production that is exactly what happened: mission `rms_2f53d1629a4348b2be53`
 * finished a compliant second round and wrote back citing the *first* round's
 * `MORE_RESEARCH` audit. The packet was right and the report it filed was
 * right; the pointer the project's knowledge hangs off was wrong.
 *
 * **Non-null is not the same fact as current.** That is the whole of it, and it
 * is the reason this module exists rather than a two-line edit at the call
 * site: the derivation has more than one reader — the link taken before a
 * writeback, and the reconciliation of a mission that already took one — and a
 * rule applied by one of the two is worse than none, because the two would
 * disagree about the same mission.
 *
 * ---------------------------------------------------------------------------
 * The rule
 * ---------------------------------------------------------------------------
 *
 * The packet is authoritative and the mission is a projection of it. So each
 * link takes the orchestration's own current value, and a null there means
 * Brain has nothing better to say than what the mission already holds — never
 * an instruction to blank one. Nothing here reads a model's prose, and nothing
 * here re-judges: it copies ids Brain wrote itself.
 *
 * The audit is the newest one this packet's own run has recorded, which is the
 * latest completed audit of the current round whenever the current round has
 * produced one — and, unlike a round-scoped rule, is total. `newestAuditId`
 * below records why the round boundary was the wrong instrument here.
 *
 * And the projection is corrected with the links, because the knowledge a
 * writeback promoted is derived from them: a mission repointed while its
 * knowledge still names the old layer has moved the pointer nobody reads and
 * left the row somebody does.
 */
import { getDb } from '../../db/database.ts';
import { getAudit, listAuditsByProject } from '../../repos/audits.ts';
import { recordEvent } from '../../repos/events.ts';
import { getOrchestration } from '../../repos/research.ts';
import {
  getMission,
  knowledgeForMission,
  linkMission,
  reanchorKnowledge,
} from '../../repos/russellMissions.ts';
import type { ResearchOrchestration, RussellMission } from '../../domain/types.ts';

/**
 * Bumped when the derivation changes, and recorded on every correction.
 *
 * "Brain repointed this mission" is auditable only if you can tell which
 * version of the rule repointed it — the same reasoning that puts a decider
 * version on a handoff and a validator version on an automatic approval.
 */
export const COMPLETION_LINK_VERSION = '2026-09-10.1';

/** The three pointers, as the packet says they should be. */
export interface MissionLinks {
  documentId: string | null;
  auditId: string | null;
  layerId: string | null;
}

export type LinkField = 'documentId' | 'auditId' | 'layerId';

export interface LinkDrift {
  field: LinkField;
  from: string | null;
  to: string;
}

/**
 * Where this packet's current round left its document, its verdict and its
 * layer.
 *
 * Pure over rows and total: no clock, no prose, no judgement. A field comes
 * back null when the packet does not know it yet, which callers treat as
 * "leave whatever is there" rather than as "clear it".
 */
export async function currentLinksFor(
  orchestration: ResearchOrchestration,
): Promise<MissionLinks> {
  return {
    documentId: orchestration.documentId ?? null,
    layerId: orchestration.layerId ?? null,
    auditId: await newestAuditId(orchestration),
  };
}

/**
 * The newest audit this packet has, or null if it has none.
 *
 * **"The latest audit of the current round" and "the newest audit" are the same
 * answer whenever the current round has produced one, and only the second is
 * total** — so the second is what this computes, and the difference is worth
 * writing down because the first is what the defect report asked for.
 *
 * A round boundary was the obvious rule and is wrong here. A handoff can happen
 * *after* a packet is terminal — the routing is selected from rows and reaches
 * an audit recorded a second ago or a month ago — and when it does, no new round
 * runs, because a terminal packet is not re-opened. Under a boundary rule the
 * newest handoff would then place every existing audit in a previous round and
 * this would answer null, which means refusing to cite the verdict that was
 * actually performed on this report. The production packet is exactly that
 * shape: judged compliant, written back, and routed once more afterwards.
 *
 * Citing the newest audit is truthful in every case. While a re-opened round is
 * still running it names the packet's standing verdict, which is the only thing
 * there is to name; the moment the new judge records one, this answers with it
 * and the mission is repointed. Nothing is ever attributed to a verdict that a
 * later one has superseded, which is the whole of what the boundary was for.
 *
 * `orchestration.audit_id` is Brain's own pointer, written by the judge's own
 * submission, so it is included as a candidate rather than re-derived — and it
 * loses to a genuinely newer audit on the same run rather than winning by being
 * named. The run scope is the original rule and stays: a project's other audits
 * belong to other work and must never be attributed here.
 *
 * The ordering is explicit rather than trusting a repository's `ORDER BY`. The
 * previous version of this took the *last* element of a list that arrives
 * newest-first, and so picked the oldest audit in the run every time. That is
 * the single line that put round one's `MORE_RESEARCH` verdict on a mission
 * that had passed round two.
 */
async function newestAuditId(orchestration: ResearchOrchestration): Promise<string | null> {
  const candidates = (await listAuditsByProject(orchestration.projectId)).filter(
    (audit) => audit.runId !== null && audit.runId === orchestration.runId,
  );

  const named = orchestration.auditId ? await getAudit(orchestration.auditId) : null;
  if (named && !candidates.some((audit) => audit.id === named.id)) candidates.push(named);

  candidates.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return candidates[0]?.id ?? null;
}

/** Which of the three the mission disagrees with. Empty means it is current. */
export function driftOf(mission: RussellMission, links: MissionLinks): LinkDrift[] {
  const drift: LinkDrift[] = [];
  const compare = (field: LinkField, from: string | null, to: string | null): void => {
    if (to === null || to === from) return;
    drift.push({ field, from, to });
  };
  compare('documentId', mission.documentId, links.documentId);
  compare('auditId', mission.auditId, links.auditId);
  compare('layerId', mission.layerId, links.layerId);
  return drift;
}

/**
 * Bring one mission's links up to date with its packet, and hand it back.
 *
 * This is what runs *before* a writeback, so the knowledge the writeback files
 * is anchored correctly the first time. It writes only what differs, so a
 * mission that is already current is not churned and its `updated_at` does not
 * move.
 */
export async function alignMissionLinks(
  mission: RussellMission,
): Promise<{ mission: RussellMission; drift: LinkDrift[] }> {
  if (!mission.orchestrationId) return { mission, drift: [] };
  const orchestration = await getOrchestration(mission.orchestrationId);
  if (!orchestration) return { mission, drift: [] };

  const drift = driftOf(mission, await currentLinksFor(orchestration));
  if (drift.length === 0) return { mission, drift };

  await linkMission(patchFor(mission.id, drift));
  return { mission: (await getMission(mission.id)) ?? mission, drift };
}

export type ReconcileRefusal =
  | 'NO_ORCHESTRATION'
  | 'NO_SUCH_PACKET'
  | 'NO_PACKET_AUDIT'
  | 'ALREADY_CURRENT';

export interface ReconcileOutcome {
  ok: boolean;
  missionId: string;
  corrections: LinkDrift[];
  /** Knowledge rows re-anchored onto the corrected links. */
  knowledgeIds: string[];
  refusal: ReconcileRefusal | null;
  detail: string;
}

/**
 * Correct a mission that already wrote back against links that had gone stale,
 * and the knowledge projection it produced.
 *
 * Non-destructive throughout, and the distinction matters. Every audit, pass,
 * claim, message, document, bin and event stays exactly as it was written; no
 * id changes; nothing is deleted and nothing is superseded. What moves is a
 * *pointer* and a *projection*: three columns on the mission, and the layer and
 * provenance of the knowledge rows that were derived from them.
 *
 * Re-recording the knowledge instead — a new row superseding the old — was the
 * obvious alternative and is wrong here. The conclusion did not change and the
 * evidence did not change; only the citation was wrong. A superseding row would
 * assert that the project once believed something it never believed, and a
 * second conversation turn would tell a person their work had concluded twice.
 * §5 protects history, and the history of this correction is the append-only
 * `RUSSELL_LINKS_RECONCILED` event below, which carries every before and after.
 *
 * Idempotent by the state it produces rather than by a flag: once the links
 * agree with the packet the drift is empty and this refuses with
 * `ALREADY_CURRENT`, so a caller that re-derives it from rows on every tick
 * performs it once and then does nothing for ever.
 */
export async function reconcileCompletedMission(
  missionId: string,
): Promise<ReconcileOutcome> {
  const mission = await getMission(missionId);
  if (!mission || !mission.orchestrationId) {
    return refuse(missionId, 'NO_ORCHESTRATION', 'This mission has no packet to be a projection of.');
  }
  const orchestration = await getOrchestration(mission.orchestrationId);
  if (!orchestration) {
    return refuse(missionId, 'NO_SUCH_PACKET', 'The packet this mission names does not exist.');
  }

  const links = await currentLinksFor(orchestration);
  if (links.auditId === null && mission.auditId !== null) {
    /*
     * The mission cites an audit and the packet it now names has none.
     *
     * Fail-closed rather than expected: repointing at nothing would leave a
     * filed conclusion citing no verdict at all, which is worse than a citation
     * that has to be explained. It is reported rather than silent, because a
     * repeated line here means a mission and a packet that do not belong
     * together, and that is a fact somebody would want.
     */
    return refuse(
      missionId,
      'NO_PACKET_AUDIT',
      'The packet this mission names has recorded no audit, so there is no verdict to point at.',
    );
  }

  const corrections = driftOf(mission, links);
  if (corrections.length > 0) await linkMission(patchFor(mission.id, corrections));
  const corrected = (await getMission(mission.id)) ?? mission;

  /*
   * And the projection those links produced.
   *
   * A knowledge row's `layer_id` is a copy of the mission's, and its provenance
   * is a copy of the mission's document and audit ids. Correcting the mission
   * and leaving these is the same defect one level down: the project would
   * still believe its conclusion under the wrong heading, citing the wrong
   * verdict, and the row a person actually reads is this one.
   *
   * It is re-anchored against the mission rather than against the corrections,
   * because the mission's own links can move without this function moving them
   * — an `OTHER_LAYER` handoff repoints all three ownership rows itself, and
   * the knowledge it left behind is then the only thing still naming the old
   * layer. That case has no drift for `driftOf` to find, which is why the
   * selection below asks about the knowledge as well.
   *
   * Only the two derived fields are touched. The statement, the confidence, the
   * author, the mission, the conversation and every timestamp are what they
   * were, and nothing is superseded.
   */
  const knowledgeIds: string[] = [];
  for (const row of await knowledgeForMission(mission.id)) {
    const provenance = { ...row.provenance };
    let changed = false;
    if (corrected.auditId && provenance['auditId'] !== corrected.auditId) {
      provenance['auditId'] = corrected.auditId;
      changed = true;
    }
    if (corrected.documentId && provenance['documentId'] !== corrected.documentId) {
      provenance['documentId'] = corrected.documentId;
      changed = true;
    }
    const layerMoved = corrected.layerId !== null && row.layerId !== corrected.layerId;
    if (!changed && !layerMoved) continue;
    await reanchorKnowledge({
      knowledgeId: row.id,
      ...(layerMoved ? { layerId: corrected.layerId } : {}),
      ...(changed ? { provenance } : {}),
    });
    knowledgeIds.push(row.id);
  }

  if (corrections.length === 0 && knowledgeIds.length === 0) {
    return {
      ok: true,
      missionId,
      corrections: [],
      knowledgeIds: [],
      refusal: 'ALREADY_CURRENT',
      detail: 'This mission already points at what its packet produced.',
    };
  }

  await recordEvent({
    projectId: mission.projectId,
    layerId: corrected.layerId,
    entityType: 'RUSSELL_MISSION',
    entityId: mission.id,
    eventType: 'RUSSELL_LINKS_RECONCILED',
    payload: {
      orchestrationId: mission.orchestrationId,
      corrections,
      knowledgeIds,
      reconcilerVersion: COMPLETION_LINK_VERSION,
      reason:
        'This mission had already written back against links that no longer described its ' +
        'packet — a superseded audit round, a layer its document has left, or a projection ' +
        'still naming both. The mission and the knowledge it promoted now cite what the ' +
        'packet actually produced. No audit, pass, claim, document or message was altered, ' +
        'nothing was superseded and no id changed.',
    },
  });

  return {
    ok: true,
    missionId,
    corrections,
    knowledgeIds,
    refusal: null,
    detail:
      corrections
        .map((entry) => `${entry.field}: ${entry.from ?? 'none'} -> ${entry.to}`)
        .join('; ') || `re-anchored ${knowledgeIds.length} knowledge row(s)`,
  };
}

/**
 * Missions that already wrote back and no longer describe their own packet.
 *
 * Two arms, because there are two ways to drift apart and only one of them is
 * about the mission's own columns.
 *
 * The first is the packet moving underneath the mission — a second audit round,
 * a handoff — and it is deliberately the *same three columns* the derivation
 * reads, so a mission this selects is one `reconcileCompletedMission` will
 * either correct or refuse by name.
 *
 * The second is the projection being left behind. `routeAuditedDocument` moves
 * the document, the packet **and** the mission together, which is right and
 * leaves nothing for the first arm to find — and the knowledge the writeback
 * promoted still names the layer the work has left. So the knowledge is asked
 * about directly. Only the layer is compared here; a provenance that drifted
 * did so because a link drifted, which the first arm already catches.
 *
 * Selecting on rows rather than from a queue is what makes this reach a mission
 * written back before this code existed.
 */
export async function missionsWithStaleLinks(limit: number): Promise<string[]> {
  const rows = await getDb().all<{ id: string }>(
    `SELECT m.id AS id
       FROM russell_missions m
       JOIN research_orchestrations o ON o.id = m.orchestration_id
      WHERE m.writeback_at IS NOT NULL
        AND (
             (o.document_id IS NOT NULL AND (m.document_id IS NULL OR m.document_id <> o.document_id))
          OR (o.audit_id    IS NOT NULL AND (m.audit_id    IS NULL OR m.audit_id    <> o.audit_id))
          OR (o.layer_id    IS NOT NULL AND (m.layer_id    IS NULL OR m.layer_id    <> o.layer_id))
          OR (m.layer_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM russell_knowledge k
                 WHERE k.mission_id = m.id
                   AND (k.layer_id IS NULL OR k.layer_id <> m.layer_id)
              ))
        )
      ORDER BY m.updated_at, m.rowid
      LIMIT ?`,
    [Math.max(1, limit)],
  );
  return rows.map((row) => row.id);
}

/** The drift, as the exact named columns `linkMission` understands. */
function patchFor(
  missionId: string,
  drift: LinkDrift[],
): { missionId: string; documentId?: string; auditId?: string; layerId?: string } {
  const patch: { missionId: string; documentId?: string; auditId?: string; layerId?: string } = {
    missionId,
  };
  for (const entry of drift) patch[entry.field] = entry.to;
  return patch;
}

function refuse(
  missionId: string,
  refusal: ReconcileRefusal,
  detail: string,
): ReconcileOutcome {
  return { ok: false, missionId, corrections: [], knowledgeIds: [], refusal, detail };
}

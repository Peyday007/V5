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
 * `orchestration.audit_id` is written by the judge's own submission on every
 * round, so it *is* the latest completed audit of the current round. The round
 * boundary is still checked rather than assumed — `auditRoundStartedAt` reads
 * the append-only handoff event — because a value that predates the current
 * round is precisely the stale pointer this module exists to refuse, and
 * refusing it visibly is worth more than linking it quietly.
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
import { auditRoundStartedAt } from '../research/auditRound.ts';
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
    auditId: await currentRoundAuditId(orchestration),
  };
}

/**
 * The audit the current round produced, or null while it has not produced one.
 *
 * The packet's own `audit_id` is the answer in every ordinary case, and it is
 * trusted rather than re-derived: it is written by the judge's own submission,
 * so it names the verdict this packet is actually resting on. It is only *not*
 * the answer when a handoff has started a new round and that column still names
 * the round before it — the state a re-opened packet sits in between the
 * handoff and its new judge. Linking that would attribute a superseded verdict
 * to a finished mission, which is the defect this file is named after, so it is
 * refused and the round is asked directly instead.
 *
 * The fallback is scoped to the packet's own run for the reason the original
 * lookup was: a project's other audits belong to other work and must never be
 * attributed here. It is also ordered explicitly rather than trusting a
 * repository's `ORDER BY` — the previous version of this took the *last*
 * element of a list that arrives newest-first, and picked the oldest audit in
 * the run every time. That is the single line that put round one's
 * `MORE_RESEARCH` verdict on a mission that had passed round two.
 */
async function currentRoundAuditId(
  orchestration: ResearchOrchestration,
): Promise<string | null> {
  const since = await auditRoundStartedAt(orchestration.id);

  const named = orchestration.auditId ?? null;
  if (named) {
    const audit = await getAudit(named);
    if (audit && (!since || audit.createdAt > since)) return named;
  }

  const audits = (await listAuditsByProject(orchestration.projectId))
    .filter((audit) => audit.runId !== null && audit.runId === orchestration.runId)
    .filter((audit) => (since ? audit.createdAt > since : true))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return audits[0]?.id ?? null;
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
  | 'NO_CURRENT_ROUND_AUDIT'
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
     * The mission cites an audit the current round has superseded and the new
     * round has not produced its own yet. Repointing at nothing would be worse
     * than the stale pointer — a conclusion citing no audit at all — so this
     * stops and says so, and is picked up again once the judge has run.
     *
     * Reported rather than silent, because a repeated refusal here means a
     * re-opened round is not finishing, which is a fact somebody would want.
     */
    return refuse(
      missionId,
      'NO_CURRENT_ROUND_AUDIT',
      'This packet is between audit rounds, so there is no current verdict to point at yet.',
    );
  }

  const corrections = driftOf(mission, links);
  if (corrections.length === 0) {
    return {
      ok: true,
      missionId,
      corrections: [],
      knowledgeIds: [],
      refusal: 'ALREADY_CURRENT',
      detail: 'This mission already points at what its packet produced.',
    };
  }

  await linkMission(patchFor(mission.id, corrections));
  const corrected = (await getMission(mission.id)) ?? mission;

  /*
   * And the projection the stale links produced.
   *
   * A knowledge row's `layer_id` is a copy of the mission's, and its
   * provenance is a copy of the mission's document and audit ids. Correcting
   * the mission and leaving these is the same defect one level down: the
   * project would still believe its conclusion under the wrong heading, citing
   * the wrong verdict, and the row a person actually reads is this one.
   *
   * Only the two derived fields are touched. The statement, the confidence, the
   * author, the mission, the conversation and every timestamp are what they
   * were.
   */
  const knowledgeIds: string[] = [];
  for (const row of await knowledgeForMission(mission.id)) {
    const provenance = { ...row.provenance };
    let changed = false;
    for (const entry of corrections) {
      if (entry.field === 'layerId') continue;
      if (provenance[entry.field] === entry.from) {
        provenance[entry.field] = entry.to;
        changed = true;
      }
    }
    const layerId = corrected.layerId;
    const layerMoved = layerId !== null && row.layerId !== layerId;
    if (!changed && !layerMoved) continue;
    await reanchorKnowledge({
      knowledgeId: row.id,
      ...(layerMoved ? { layerId } : {}),
      ...(changed ? { provenance } : {}),
    });
    knowledgeIds.push(row.id);
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
        'This mission was written back while its links still named the previous audit round. ' +
        'The packet was re-audited after its document was handed to the layer that owns it, ' +
        'and the mission and the knowledge it produced now cite that round instead. No audit, ' +
        'claim, document or message was altered.',
    },
  });

  return {
    ok: true,
    missionId,
    corrections,
    knowledgeIds,
    refusal: null,
    detail: corrections
      .map((entry) => `${entry.field}: ${entry.from ?? 'none'} -> ${entry.to}`)
      .join('; '),
  };
}

/**
 * Missions that already wrote back and whose links disagree with their packet.
 *
 * A pre-filter, and deliberately the *same three columns* the derivation reads,
 * so a mission this selects is one `reconcileCompletedMission` will either
 * correct or refuse by name. Selecting on rows rather than from a queue is what
 * makes this reach a mission written back before this code existed.
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

/**
 * A Russell conversation asking for a deliverable, and asking for it again.
 *
 * `REQUEST_DELIVERABLE` is the tenth action a turn may propose, and its whole
 * effect is a row: a `deliverables` brief in the conversation's project, or a
 * correction recorded against one already delivered. Everything after that is
 * `services/deliverables/pipeline.ts`, on the tick, from rows.
 *
 * Three decisions here are the ones worth reading.
 *
 *  - **A deterministic gate on the person's own words.** The worker reading the
 *    thread proposes; the server checks that the message actually names a
 *    concrete output (a dossier, a spreadsheet, a comparison…) before a brief is
 *    written, because a model that decided a remark was a request would spend a
 *    fleet on something nobody asked for. Its failure mode is *missing* a
 *    request, which costs one clearer sentence.
 *  - **The format Brain produces is honest about the one asked for.** Brain
 *    builds and verifies `.docx` and `.xlsx`. A request for a PDF, a slide deck
 *    or a CSV gets the nearest verified format *and* a named need saying what is
 *    missing and how to get the rest — never a silent swap, and never a refusal
 *    of the work that can be done.
 *  - **Sending it to somebody is not something a turn can do.** A request to
 *    email or publish the file becomes a need, stated in the file and in the
 *    delivery message. This build is not authorized to contact anyone.
 */
import { createHash } from 'node:crypto';
import { decideProjectAccess } from '../identity/policy.ts';
import { recordEvent } from '../../repos/events.ts';
import {
  captureDeliverable,
  getDeliverable,
  getVersion,
  latestVersion,
  listDeliverablesForConversation,
  listDeliverablesForProject,
  listFindings,
  listVersions,
  requestCorrection,
} from '../../repos/deliverables.ts';
import type { Principal } from '../../domain/types.ts';
import type { Deliverable, DeliverableFormat, DeliverableNeed, DeliverableVersion, RequestedFormat } from '../../domain/deliverables.ts';
import { REQUESTED_FORMATS } from '../../domain/deliverables.ts';
import type { ProposedDeliverable } from './proposal.ts';
import { fileUrl } from '../deliverables/pipeline.ts';

/** Nouns that name a concrete output. Widened by what real requests miss, never guessed. */
const OUTPUT_NOUN =
  /\b(dossiers?|reports?|comparisons?|compare|documents?|docs?|write-?ups?|briefs?|briefings?|memos?|summar(?:y|ies)|spreadsheets?|workbooks?|sheets?|datasets?|data ?sets?|tables?|csv|xlsx|excel|docx|word (?:file|doc)|pdfs?|decks?|slides?|files?|lists?|matrix|tracker|inventory|overview|analysis|profile)\b/i;

/** Verbs that ask for a change to something already made. */
const REVISION_VERB =
  /\b(change|add|remove|drop|fix|correct|revise|update|replace|include|rename|split|sort|reorder|expand|shorten|make|put|move|delete|redo|rewrite|edit)\b/i;

export function namesAnOutput(message: string): boolean {
  return OUTPUT_NOUN.test(message);
}

export function asksForRevision(message: string): boolean {
  return REVISION_VERB.test(message);
}

export function formatFor(kind: 'WRITTEN' | 'STRUCTURED'): DeliverableFormat {
  return kind === 'WRITTEN' ? 'DOCX' : 'XLSX';
}

/** What the request depends on that Brain cannot supply, named with what it would take. */
export function needsFor(kind: 'WRITTEN' | 'STRUCTURED', requested: RequestedFormat | null, externalDelivery: string | null): DeliverableNeed[] {
  const needs: DeliverableNeed[] = [];
  const produced = formatFor(kind);
  if (requested === 'PDF') {
    needs.push({
      capability: 'PDF rendering',
      detail: `Brain builds and verifies a ${produced === 'DOCX' ? 'Word document' : 'workbook'} but has no PDF renderer in production; open the file and save it as PDF, or connect a document-rendering integration.`,
    });
  } else if (requested === 'PPTX') {
    needs.push({
      capability: 'Slide deck production',
      detail: 'Brain has no slide renderer; the content is delivered as a document to lay out as slides, until a presentation integration is connected.',
    });
  } else if (requested === 'CSV' && produced === 'XLSX') {
    needs.push({
      capability: 'CSV export',
      detail: 'Delivered as a workbook; each data sheet saves as CSV from any spreadsheet program.',
    });
  } else if (requested === 'XLSX' && produced === 'DOCX') {
    needs.push({ capability: 'Format', detail: 'Asked for a spreadsheet but the request reads as a written document; say so and it will be rebuilt as a workbook.' });
  } else if (requested === 'DOCX' && produced === 'XLSX') {
    needs.push({ capability: 'Format', detail: 'Asked for a document but the request reads as a dataset; say so and it will be rebuilt as a document.' });
  }
  if (externalDelivery) {
    needs.push({
      capability: 'Sending the file to someone',
      detail: `Not done: sending a file outside Brain (${externalDelivery.slice(0, 200)}) is not authorized here. The file is in this conversation to forward yourself.`,
    });
  }
  return needs;
}

function normalizeFormat(raw: string | null): RequestedFormat | null {
  if (!raw) return null;
  const upper = raw.toUpperCase().replace(/^\./, '');
  const mapped = upper === 'XLS' || upper === 'EXCEL' || upper === 'SPREADSHEET' ? 'XLSX' : upper === 'WORD' || upper === 'DOC' ? 'DOCX' : upper === 'MD' ? 'MARKDOWN' : upper === 'SLIDES' ? 'PPTX' : upper;
  return (REQUESTED_FORMATS as readonly string[]).includes(mapped) ? (mapped as RequestedFormat) : null;
}

export type DeliverableCaptureOutcome =
  | { ok: true; deliverable: Deliverable; created: boolean; reason: 'BRIEFED' | 'ALREADY_BRIEFED' | 'REVISION_RECORDED' }
  | { ok: false; reason: 'NO_PROJECT_ATTACHED' | 'NOT_A_DELIVERABLE_REQUEST' | 'NOT_AUTHORIZED' | 'UNKNOWN_DELIVERABLE' | 'NOT_A_REVISION'; answer: string };

export async function captureDeliverableRequest(input: {
  projectId: string | null;
  conversationId: string;
  askedMessageId: string | null;
  askedText: string | null;
  proposed: ProposedDeliverable;
  owner: Principal;
}): Promise<DeliverableCaptureOutcome> {
  if (!input.projectId) {
    return { ok: false, reason: 'NO_PROJECT_ATTACHED', answer: 'Which project should this be built from? A deliverable is built from a project’s evidence.' };
  }
  if (!decideProjectAccess(input.owner, input.projectId, 'WRITE').allowed) {
    return { ok: false, reason: 'NOT_AUTHORIZED', answer: 'Building a deliverable needs write access to this project.' };
  }
  const asked = input.askedText ?? '';

  if (input.proposed.mode === 'REVISION') {
    const target = await getDeliverable(input.proposed.revisionOf);
    // Absent and elsewhere are one answer: a revision can only name a
    // deliverable of this project.
    if (!target || target.projectId !== input.projectId) {
      return { ok: false, reason: 'UNKNOWN_DELIVERABLE', answer: 'I could not find that deliverable in this project.' };
    }
    if (!asksForRevision(asked)) {
      return { ok: false, reason: 'NOT_A_REVISION', answer: 'That did not read as a change to the file; say what should change.' };
    }
    await requestCorrection(target.id, input.proposed.correction);
    await recordEvent({
      projectId: target.projectId,
      entityType: 'deliverable',
      entityId: target.id,
      eventType: 'DELIVERABLE_REVISION_REQUESTED',
      payload: { messageId: input.askedMessageId, correction: input.proposed.correction.slice(0, 500) },
    });
    return { ok: true, deliverable: (await getDeliverable(target.id))!, created: false, reason: 'REVISION_RECORDED' };
  }

  if (!namesAnOutput(asked)) {
    return {
      ok: false,
      reason: 'NOT_A_DELIVERABLE_REQUEST',
      answer: 'That did not read as a request for a file. Name what you want made — a dossier, a comparison, a spreadsheet — and I will build it.',
    };
  }
  const p = input.proposed;
  const requested = normalizeFormat(p.requestedFormat);
  const key = input.askedMessageId
    ? `msg:${input.askedMessageId}`
    : `sha:${createHash('sha256').update(`${p.title}\n${p.requiredContents.join('\n')}`.toLowerCase()).digest('hex').slice(0, 32)}`;
  const { deliverable, created } = await captureDeliverable({
    projectId: input.projectId,
    conversationId: input.conversationId,
    requestedMessageId: input.askedMessageId,
    requestedByUserId: input.owner.type === 'HUMAN' ? input.owner.id : null,
    title: p.title,
    kind: p.kind,
    format: formatFor(p.kind),
    requestedFormat: requested,
    spec: {
      intendedUse: p.intendedUse,
      audience: p.audience,
      requiredContents: p.requiredContents,
      sourceRequirements: p.sourceRequirements,
      acceptanceConditions: p.acceptanceConditions,
    },
    needs: needsFor(p.kind, requested, p.externalDelivery),
    submissionKey: key,
  });
  if (created) {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'deliverable',
      entityId: deliverable.id,
      eventType: 'DELIVERABLE_REQUESTED',
      payload: { conversationId: input.conversationId, messageId: input.askedMessageId, kind: p.kind, format: deliverable.format, requestedFormat: requested },
    });
  }
  return { ok: true, deliverable, created, reason: created ? 'BRIEFED' : 'ALREADY_BRIEFED' };
}

/* =========================================================================
 * Views
 * ====================================================================== */

export interface DeliverableVersionView {
  versionNumber: number;
  status: DeliverableVersion['status'];
  reason: DeliverableVersion['reason'];
  reasonDetail: string | null;
  filename: string;
  byteSize: number;
  fileHash: string;
  fileUrl: string;
  previewUrl: string | null;
  checks: DeliverableVersion['checkReport'];
  review: DeliverableVersion['reviewReport'];
  reviewIndependence: string | null;
  createdAt: string;
}

export interface DeliverableView {
  id: string;
  projectId: string;
  conversationId: string | null;
  title: string;
  kind: Deliverable['kind'];
  format: Deliverable['format'];
  requestedFormat: Deliverable['requestedFormat'];
  state: Deliverable['state'];
  stateReason: string | null;
  spec: Deliverable['spec'];
  needs: Deliverable['needs'];
  current: DeliverableVersionView | null;
  /** The newest version when it is not the current one — work in progress or a failed attempt. */
  latest: DeliverableVersionView | null;
  versions: DeliverableVersionView[];
  pendingCorrection: string | null;
  findings: Array<{ severity: string; stage: string; code: string; message: string; versionId: string | null; resolved: boolean }>;
  createdAt: string;
  updatedAt: string;
}

function versionView(d: Deliverable, v: DeliverableVersion): DeliverableVersionView {
  return {
    versionNumber: v.versionNumber,
    status: v.status,
    reason: v.reason,
    reasonDetail: v.reasonDetail,
    filename: v.filename,
    byteSize: v.byteSize,
    fileHash: v.fileHash,
    fileUrl: fileUrl(d.id, v.versionNumber),
    previewUrl: v.previewKey ? `/api/deliverables/${d.id}/versions/${v.versionNumber}/preview` : null,
    checks: v.checkReport,
    review: v.reviewReport,
    reviewIndependence: v.reviewIndependence,
    createdAt: v.createdAt,
  };
}

export async function viewOfDeliverable(d: Deliverable, detail = true): Promise<DeliverableView> {
  const versions = await listVersions(d.id);
  const current = d.currentVersionId ? versions.find((v) => v.id === d.currentVersionId) ?? (await getVersion(d.currentVersionId)) : null;
  const newest = versions[versions.length - 1] ?? (await latestVersion(d.id));
  const findings = detail ? await listFindings(d.id) : [];
  return {
    id: d.id,
    projectId: d.projectId,
    conversationId: d.conversationId,
    title: d.title,
    kind: d.kind,
    format: d.format,
    requestedFormat: d.requestedFormat,
    state: d.state,
    stateReason: d.stateReason,
    spec: d.spec,
    needs: d.needs,
    current: current ? versionView(d, current) : null,
    latest: newest && newest.id !== current?.id ? versionView(d, newest) : null,
    versions: versions.map((v) => versionView(d, v)),
    pendingCorrection: d.pendingCorrection,
    findings: findings.map((f) => ({
      severity: f.severity,
      stage: f.stage,
      code: f.code,
      message: f.message,
      versionId: f.versionId,
      resolved: f.resolvedByVersionId !== null,
    })),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export async function deliverablesForConversation(conversationId: string): Promise<DeliverableView[]> {
  return Promise.all((await listDeliverablesForConversation(conversationId)).map((d) => viewOfDeliverable(d, false)));
}

export async function deliverablesForProject(projectId: string): Promise<DeliverableView[]> {
  return Promise.all((await listDeliverablesForProject(projectId)).map((d) => viewOfDeliverable(d, false)));
}

/**
 * Carrying a deliverable from a request to a file a person can open.
 *
 *     BRIEFED ──build bin──▶ BUILDING ──content──▶ render · store · check
 *        ▲                      ▲  │                        │
 *        │           repair ────┘  │ check failed           │ check passed
 *        │                         ▼                        ▼
 *   correction              NEEDS_PERSON ◀── no builds ── REVIEWING ──review bin──▶
 *   (revision)                     ▲          left            │
 *        │                         │                          ├── PASS ──▶ DELIVERED
 *        └───────── DELIVERED ◀────┴── REPAIR, builds left ───┘   (message in the
 *                                                                  conversation)
 *
 * Every arrow is one guarded `UPDATE` naming the state and the bin it read
 * (`moveDeliverable`), and every one is derived on the tick from rows rather
 * than hooked to the moment something finished — so a tick that died halfway,
 * two instances ticking at once, and a deploy mid-flight all converge on the
 * same outcome, and the deliverables already stranded are reached too.
 *
 * Nothing here is a second research pipeline or a second queue. The work is
 * two bins on the fleet that already fires; the source material is the
 * project's citable claims; the bytes go through the storage layer; and the
 * delivery is a message in the conversation that asked. What is new is the
 * record of carrying it, and the rule that *a plan for a file is not the file*.
 */
import { createHash } from 'node:crypto';
import {
  createBin,
  dispatchedSessionForLease,
  getBin,
  listBinUnitResults,
  markBinReady,
  retireBin,
} from '../../repos/bins.ts';
import { workerSessionForBin } from '../../repos/fleet.ts';
import { getProject } from '../../repos/projects.ts';
import { recordEvent } from '../../repos/events.ts';
import { addMessage } from '../../repos/russellConversations.ts';
import {
  attachReviewBin,
  claimAnnouncement,
  getDeliverable,
  getVersion,
  getVersionByReviewBin,
  latestVersion,
  listAdvanceableDeliverables,
  listFindings,
  listVersions,
  moveDeliverable,
  nextVersionNumber,
  recordAnnouncement,
  recordFinding,
  recordVersion,
  resolveOpenFindings,
  settleReview,
} from '../../repos/deliverables.ts';
import { getStorage } from '../storage/index.ts';
import { assertSafeKey } from '../storage/keys.ts';
import { decideReviewIndependence, type ReviewLineage } from '../design/judge.ts';
import type { Bin, BinManifest } from '../../domain/types.ts';
import type { Deliverable, DeliverableVersion, VersionReason } from '../../domain/deliverables.ts';
import { isMaterial } from '../../domain/deliverables.ts';
import { CONTENT_LIMITS, COLUMN_TYPES, TOTAL_FUNCTIONS, UNSOURCED_INTEGER_CEILING, validateContent } from './content.ts';
import type { DeliverableContent, EvidenceClaim } from './content.ts';
import { evidencePack, resolverFor } from './evidence.ts';
import { renderDocx } from './docx.ts';
import { renderXlsx } from './xlsx.ts';
import { checkDeliverable } from './check.ts';
import { REVIEW_UNIT_KEY, validateReview } from './review.ts';

export const DELIVERABLE_BUILD_CONTRACT = 'DELIVERABLE_BUILD_V1';
export const DELIVERABLE_REVIEW_CONTRACT = 'DELIVERABLE_REVIEW_V1';
export const DELIVERABLE_BIN_KIND = 'RUSSELL_DELIVERABLE';
/**
 * `RUSSELL_` so `services/bins/routing.ts` sends it to the research family —
 * the workers that already read claims and submit structured answers — rather
 * than to a repository surface that would spend a fire discovering it has
 * nothing to push.
 */
export const DELIVERABLE_WORKLOAD_CLASS = 'RUSSELL_DELIVERABLE';
export const BUILD_UNIT_KEY = 'content';

/** Builds, counting repairs and revisions, before a person is asked. */
export const MAX_BUILDS = 4;
/** Review bins per version before a person is asked. */
export const MAX_REVIEWS = 3;

export function buildCreator(deliverableId: string, buildNumber: number): string {
  return `deliverable:build:${deliverableId}:${buildNumber}`;
}
export function reviewCreator(deliverableId: string, versionNumber: number, attempt: number): string {
  return `deliverable:review:${deliverableId}:v${versionNumber}:${attempt}`;
}

/** Where one version's bytes live. Outside the documents tree, so reconcile never reads it as an unregistered document. */
export function versionKey(projectSlug: string, deliverableId: string, versionNumber: number, filename: string): string {
  return assertSafeKey(`projects/${projectSlug}/deliverables/${deliverableId}/v${versionNumber}/${filename}`);
}

export function fileUrl(deliverableId: string, versionNumber: number): string {
  return `/api/deliverables/${deliverableId}/versions/${versionNumber}/file`;
}

/* =========================================================================
 * The build bin
 * ====================================================================== */

function schemaFor(kind: Deliverable['kind'], requiredCount: number): string {
  const covers = `"covers": [required-content numbers this part answers, 0 to ${requiredCount - 1}]`;
  if (kind === 'WRITTEN') {
    return [
      'Submit ONE JSON object (as the unit value, a string) of exactly this shape — no other fields:',
      '{',
      '  "title": string,',
      '  "subtitle": string | null,',
      '  "summary": [ { "text": string, "cites": [claimId, ...] } ],   // what the reader needs first',
      `  "sections": [ { "heading": string, ${covers},`,
      '      "blocks": [',
      '        { "type": "paragraph", "text": string, "cites": [claimId, ...] }',
      '        | { "type": "paragraph", "text": string, "framing": true }      // states no fact and no figure',
      '        | { "type": "bullets", "items": [ { "text": string, "cites": [claimId, ...] } ] }',
      '        | { "type": "table", "columns": [string], "rows": [[string]], "cites": [claimId, ...] }',
      '      ] } ],',
      '  "gaps": [ { "requiredContent": number, "reason": string } ],   // what the evidence does not settle',
      '  "limitations": [string]',
      '}',
      'Do NOT write reference numbers, a sources list or URLs into the text: Brain numbers the citations and writes the Sources section from the claims you cite.',
    ].join('\n');
  }
  return [
    'Submit ONE JSON object (as the unit value, a string) of exactly this shape — no other fields:',
    '{',
    '  "title": string,',
    '  "description": string,   // what the workbook contains and how to use it',
    `  "sheets": [ { "name": string (≤${CONTENT_LIMITS.sheetName} chars, not "About" or "Sources"), ${covers},`,
    `      "columns": [ { "key": identifier, "label": string, "type": ${COLUMN_TYPES.map((t) => `"${t}"`).join(' | ')} } ],`,
    '      "rows": [ { "values": { columnKey: string | number | null }, "cites": [claimId, ...] } ],',
    `      "totals": [ { "column": columnKey, "function": ${TOTAL_FUNCTIONS.map((t) => `"${t}"`).join(' | ')} } ]   // at most one per column`,
    '  } ],',
    '  "gaps": [ { "requiredContent": number, "reason": string } ],',
    '  "notes": [string]',
    '}',
    'number, currency and percent columns take JSON numbers (a percent is written as the percentage, e.g. 12.5 for 12.5%). Use null for a value the evidence does not state — never an estimate.',
    'Brain adds the About sheet, a Sources column on every row, the Sources sheet, and writes each total as a live formula.',
  ].join('\n');
}

const RULES = [
  'Every paragraph, bullet, table and row must cite at least one claim id from the evidence below. A paragraph that states no fact may instead be marked "framing": true, and then it may contain no figure.',
  `Every figure in cited text (any number other than a whole number from 0 to ${UNSOURCED_INTEGER_CEILING}) must appear in one of the claims it cites — in the claim, its passage, its locator or its date. A figure no cited claim states is refused. Do not compute, round, convert or estimate figures.`,
  'Every required content must be covered by a section/sheet (its "covers") or declared in "gaps" with the reason the evidence does not settle it. A gap is an honest answer; a padded section is not.',
  'Cite only ids listed below (or other citable claims of this project). An id that is not a citable claim of this project refuses the whole submission.',
  'If the submission is refused, the bin tells you exactly why while you still hold the lease — correct it and submit the unit again, then complete.',
];

async function buildManifest(d: Deliverable, reason: VersionReason, detail: string | null): Promise<{ manifest: BinManifest; omitted: number }> {
  const prior = await latestVersion(d.id);
  let priorBlock = '';
  if (prior && (reason === 'REPAIR' || reason === 'REVISION')) {
    const text = JSON.stringify(prior.content);
    priorBlock =
      text.length <= 18_000
        ? `\n\nTHE PREVIOUS VERSION (v${prior.versionNumber}) — start from this and change what the correction or findings require; keep what was right:\n${text}`
        : `\n\nThe previous version (v${prior.versionNumber}) is ${text.length} characters, too large to carry here; rebuild it from the evidence, keeping its structure.`;
  }
  const budget = Math.max(12_000, 40_000 - priorBlock.length);
  const pack = await evidencePack({
    projectId: d.projectId,
    title: d.title,
    spec: d.spec,
    extraText: detail ?? '',
    budget,
  });
  const why =
    reason === 'INITIAL'
      ? 'A person asked for this deliverable in a Russell conversation. A plan for it, or a prompt for another model, does not complete the request — the file does.'
      : reason === 'REPAIR'
        ? `The previous version did not pass. Fix exactly this:\n${detail ?? ''}`
        : `The person asked for a revision:\n"${detail ?? ''}"`;
  const spec = [
    `Deliverable: ${d.title} (${d.kind === 'WRITTEN' ? 'a written, source-backed document — Brain renders it as .docx' : 'a structured dataset — Brain renders it as an .xlsx workbook'})`,
    `Intended use: ${d.spec.intendedUse}`,
    `Audience: ${d.spec.audience}`,
    'Required contents (numbered from 0):',
    ...d.spec.requiredContents.map((one, n) => `  ${n}. ${one}`),
    `Source requirements: ${d.spec.sourceRequirements}`,
    'Acceptance conditions (an independent reviewer will hold the file to these):',
    ...d.spec.acceptanceConditions.map((one, n) => `  ${n}. ${one}`),
    ...(d.needs.length ? ['Known limitations Brain will state in the file (do not work around them):', ...d.needs.map((n) => `  - ${n.capability}: ${n.detail}`)] : []),
  ].join('\n');
  const evidence = pack.claims
    .map((c) => JSON.stringify({ id: c.id, claim: c.claim, publisher: c.sourcePublisher, title: c.sourceTitle, date: c.sourceDate, url: c.sourceUrl, passage: c.excerpt, locator: c.locator }))
    .join('\n');
  const input = [
    spec,
    '',
    `WHY THIS BUILD: ${why}`,
    '',
    schemaFor(d.kind, d.spec.requiredContents.length),
    '',
    'RULES:',
    ...RULES.map((r) => `- ${r}`),
    '',
    `EVIDENCE — ${pack.claims.length} of this project's ${pack.totalCitable} citable claims, most relevant first` +
      (pack.omitted ? ` (${pack.omitted} more exist and are also citable; search with brain_search_evidence if you need them)` : '') +
      '. One JSON object per line:',
    evidence,
  ].join('\n') + priorBlock;

  const manifest: BinManifest = {
    objective: `Compose the content of "${d.title}" from the evidence below and submit it under the unit key "${BUILD_UNIT_KEY}".`,
    why,
    lineage: { projectId: d.projectId, layerId: null, goal: d.spec.intendedUse.slice(0, 300), orchestrationId: null },
    units: [
      {
        key: BUILD_UNIT_KEY,
        establishes: `the content of the ${d.kind === 'WRITTEN' ? 'document' : 'workbook'}, every part citing the claims it rests on`,
        input,
        transform: 'NONE',
        dependsOn: [],
      },
    ],
    acceptableSources: ['The citable claims of this project listed in the unit input, and others Brain can resolve by id.'],
    excludedSources: [
      'Anything you know that no listed claim states. A deliverable Brain delivers says only what the project has established.',
      'The web. This is a composition task over evidence already gated, not new research.',
    ],
    evidence: [
      'Brain re-reads every cited id against the project and refuses one that is not a citable claim now.',
      'Brain checks every figure against the claims it cites.',
    ],
    outputs: [`One unit result under "${BUILD_UNIT_KEY}" whose value is the JSON object described in the input.`],
    authorizedActions: ['reading this manifest and the project evidence', 'submitting one unit result', 'completing the bin'],
    prohibitedActions: [
      'writing or uploading a file anywhere — Brain renders the file',
      'sending anything to anyone',
      'researching outside the listed evidence',
      'inventing, estimating or rounding a figure',
    ],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 60 },
    stoppingConditions: ['the content unit has been accepted and the bin completed', 'or a blocker has been reported naming what prevented it'],
  };
  return { manifest, omitted: pack.omitted };
}

async function openBuild(d: Deliverable, reason: VersionReason, detail: string | null): Promise<boolean> {
  const { manifest } = await buildManifest(d, reason, detail);
  const bin = await createBin({
    projectId: d.projectId,
    layerId: null,
    kind: DELIVERABLE_BIN_KIND,
    title: `Build ${d.kind === 'WRITTEN' ? 'document' : 'workbook'}: ${d.title}`.slice(0, 200),
    objective: manifest.objective,
    rationale: manifest.why.slice(0, 1000),
    manifest,
    completionContract: DELIVERABLE_BUILD_CONTRACT,
    createdByType: 'SYSTEM',
    createdById: buildCreator(d.id, d.buildCount + 1),
    ready: false,
    priority: 8,
    maxAttempts: 3,
    workloadClass: DELIVERABLE_WORKLOAD_CLASS,
  });
  const won = await moveDeliverable({
    id: d.id,
    fromState: d.state,
    fromBinId: d.activeBinId,
    toState: 'BUILDING',
    activeBinId: bin.id,
    activeStage: 'BUILD',
    activeReason: reason,
    activeReasonDetail: detail,
    stateReason:
      reason === 'INITIAL'
        ? 'A worker is composing the content from the project’s evidence.'
        : reason === 'REPAIR'
          ? 'A worker is repairing what the checks or the reviewer found.'
          : 'A worker is making the revision you asked for.',
    incrementBuild: true,
    // A person's revision is a new round with its own repair budget; the
    // builds before it stay on the record, they just stop counting against it.
    restartBuilds: reason === 'REVISION',
    restartReviews: true,
    clearCorrection: reason === 'REVISION',
  });
  if (!won) {
    await retireBin({
      binId: bin.id,
      leaseGeneration: bin.leaseGeneration,
      operator: 'deliverables',
      reason: `Another pass moved ${d.id} first. This draft was never dispatchable and is retired rather than deleted.`,
    });
    return false;
  }
  await markBinReady(bin.id);
  await recordEvent({
    projectId: d.projectId,
    entityType: 'deliverable',
    entityId: d.id,
    eventType: 'DELIVERABLE_BUILD_OPENED',
    payload: { binId: bin.id, reason, build: d.buildCount + 1 },
  });
  return true;
}

/* =========================================================================
 * Ingesting a build: render, store, check
 * ====================================================================== */

async function storeBytes(key: string, body: Buffer, contentType: string, filename: string): Promise<string> {
  const hash = createHash('sha256').update(body).digest('hex');
  const store = getStorage();
  try {
    await store.put({ key, body, contentType, originalFilename: filename });
  } catch (error) {
    // A tick that died after the put and before the row: the same bytes at the
    // same key are the same version. Different bytes are a real collision.
    const head = await store.head(key).catch(() => null);
    if (!head || head.checksum !== hash) throw error;
  }
  return hash;
}

async function failBuild(d: Deliverable, code: string, message: string, versionId: string | null): Promise<void> {
  await recordFinding({ deliverableId: d.id, versionId, stage: versionId ? 'CHECK' : 'BUILD', severity: 'BLOCKER', code, message });
  const fresh = (await getDeliverable(d.id))!;
  if (fresh.buildCount < MAX_BUILDS) {
    await openBuild(fresh, 'REPAIR', message);
    return;
  }
  await needsPerson(fresh, `${MAX_BUILDS} builds did not produce a file that passes its checks. Last problem: ${message}`);
}

async function needsPerson(d: Deliverable, reason: string): Promise<void> {
  const won = await moveDeliverable({
    id: d.id,
    fromState: d.state,
    fromBinId: d.activeBinId,
    toState: 'NEEDS_PERSON',
    activeBinId: null,
    activeStage: null,
    activeReason: null,
    stateReason: reason,
  });
  if (!won) return;
  await recordEvent({ projectId: d.projectId, entityType: 'deliverable', entityId: d.id, eventType: 'DELIVERABLE_NEEDS_PERSON', payload: { reason } });
  if (d.conversationId) {
    const latest = await latestVersion(d.id);
    const current = d.currentVersionId ? await getVersion(d.currentVersionId) : null;
    await addMessage({
      conversationId: d.conversationId,
      role: 'RUSSELL',
      content:
        `I could not finish "${d.title}" on my own. ${reason}` +
        (current ? `\n\nThe last version that passed is still available: ${fileUrl(d.id, current.versionNumber)}` : '') +
        (latest && latest.id !== current?.id
          ? `\n\nThe newest attempt (version ${latest.versionNumber}) did not pass; it is kept for reference at ${fileUrl(d.id, latest.versionNumber)}.`
          : '') +
        '\n\nTell me how to proceed — for example a narrower scope, or what to leave out — and I will build it again.',
      produced: { deliverableId: d.id, effect: 'DELIVERABLE_NEEDS_PERSON' },
    });
  }
}

async function ingestBuild(d: Deliverable, bin: Bin): Promise<void> {
  if (bin.state !== 'COMPLETE') {
    await failBuild(d, 'BUILD_BIN_ENDED', `The build bin ended ${bin.state} without an accepted submission.`, null);
    return;
  }
  const results = await listBinUnitResults(bin.id);
  const submitted = results.find((r) => r.unitKey === BUILD_UNIT_KEY);
  if (!submitted) {
    await failBuild(d, 'NO_CONTENT', 'The build bin finished with no content submitted.', null);
    return;
  }
  const validated = await validateContent({ raw: submitted.value, kind: d.kind, spec: d.spec, resolve: resolverFor(d.projectId) });
  if (!validated.ok) {
    await failBuild(d, 'CONTENT_REFUSED', validated.problems.slice(0, 20).join(' '), null);
    return;
  }
  const project = await getProject(d.projectId);
  if (!project) return;
  const versionNumber = await nextVersionNumber(d.id);
  const generatedAt = new Date().toISOString();
  const unmetNeeds = d.needs.map((n) => `${n.capability}: ${n.detail}`);
  const meta = { versionNumber, generatedAt, projectName: project.name, spec: d.spec, unmetNeeds };
  const rendered =
    validated.value.kind === 'WRITTEN'
      ? renderDocx(validated.value.content, validated.claims, meta)
      : renderXlsx(validated.value.content, validated.claims, meta);
  const key = versionKey(project.slug, d.id, versionNumber, rendered.filename);
  const hash = await storeBytes(key, rendered.bytes, rendered.contentType, rendered.filename);

  // The native check reads the bytes back out of the store, not from memory:
  // what is checked is what a person will download.
  const stored = await getStorage().get(key);
  const check = await checkDeliverable({
    bytes: stored,
    content: validated.value,
    claims: validated.claims,
    referenceOrder: rendered.referenceOrder,
    spec: d.spec,
    unmetNeeds,
  });
  const previewKey = assertSafeKey(`projects/${project.slug}/deliverables/${d.id}/v${versionNumber}/preview.html`);
  await storeBytes(previewKey, Buffer.from(check.previewHtml, 'utf8'), 'text/html; charset=utf-8', 'preview.html');

  const { version, created } = await recordVersion({
    deliverableId: d.id,
    versionNumber,
    buildBinId: bin.id,
    reason: d.activeReason ?? 'INITIAL',
    reasonDetail: d.activeReasonDetail,
    content: validated.value.content,
    citedClaimIds: validated.citedClaimIds,
    storageKey: key,
    filename: rendered.filename,
    contentType: rendered.contentType,
    byteSize: stored.length,
    fileHash: hash,
    previewKey,
    status: check.passed ? 'CHECKED' : 'CHECK_FAILED',
    checkReport: check.report,
  });
  if (created) {
    await recordEvent({
      projectId: d.projectId,
      entityType: 'deliverable',
      entityId: d.id,
      eventType: 'DELIVERABLE_VERSION_RECORDED',
      payload: { versionId: version.id, versionNumber, passed: check.passed, bytes: stored.length, hash },
    });
  }
  if (!check.passed) {
    const failed = check.report.items.filter((i) => !i.passed && isMaterial(i.severity));
    for (const one of failed) {
      await recordFinding({ deliverableId: d.id, versionId: version.id, stage: 'CHECK', severity: one.severity, code: one.code, message: one.detail });
    }
    const fresh = (await getDeliverable(d.id))!;
    const summary = failed.map((i) => `${i.code}: ${i.detail}`).join(' ');
    if (fresh.buildCount < MAX_BUILDS) await openBuild(fresh, 'REPAIR', `The file Brain rendered failed its native checks. ${summary}`);
    else await needsPerson(fresh, `The file failed its native checks after ${MAX_BUILDS} builds. ${summary}`);
    return;
  }
  await openReview((await getDeliverable(d.id))!, version, validated.claims);
}

/* =========================================================================
 * The review bin
 * ====================================================================== */

function htmlToText(html: string): string {
  return html
    .replace(/<h1[^>]*>/g, '\n\n# ')
    .replace(/<h2[^>]*>/g, '\n\n## ')
    .replace(/<\/(p|h1|h2|li|tr)>/g, '\n')
    .replace(/<li>/g, '- ')
    .replace(/<\/t[dh]>/g, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function openReview(d: Deliverable, version: DeliverableVersion, claims: Map<string, EvidenceClaim>): Promise<boolean> {
  const preview = version.previewKey ? (await getStorage().get(version.previewKey)).toString('utf8') : '';
  let pages = htmlToText(preview);
  if (pages.length > 36_000) pages = `${pages.slice(0, 36_000)}\n[… ${pages.length - 36_000} more characters; the full file is at ${fileUrl(d.id, version.versionNumber)}]`;
  const cited = version.citedClaimIds
    .map((id) => claims.get(id))
    .filter((c): c is EvidenceClaim => Boolean(c))
    .map((c) => JSON.stringify({ id: c.id, claim: c.claim, publisher: c.sourcePublisher, url: c.sourceUrl, passage: (c.excerpt ?? '').slice(0, 300) }));
  let citedText = cited.join('\n');
  if (citedText.length > 18_000) citedText = citedText.slice(0, 18_000) + '\n[… truncated for size]';
  const checks = version.checkReport.items.map((i) => `${i.passed ? 'PASS' : 'FAIL'} ${i.code}: ${i.detail}`).join('\n');
  const input = [
    `Deliverable: ${d.title}, version ${version.versionNumber} (${d.format}).`,
    `Intended use: ${d.spec.intendedUse}`,
    `Audience: ${d.spec.audience}`,
    'Required contents (numbered from 0):',
    ...d.spec.requiredContents.map((one, n) => `  ${n}. ${one}`),
    `Source requirements: ${d.spec.sourceRequirements}`,
    'Acceptance conditions:',
    ...d.spec.acceptanceConditions.map((one, n) => `  ${n}. ${one}`),
    ...(d.pendingCorrection || version.reason === 'REVISION' ? [`The person's requested revision for this version: "${version.reasonDetail ?? ''}" — check it was made.`] : []),
    '',
    'WHAT BRAIN ALREADY VERIFIED IN THE FILE ITSELF (do not repeat these; judge what they cannot):',
    checks,
    '',
    'THE RENDERED FILE, as a reader sees it:',
    pages,
    '',
    'THE CLAIMS IT CITES (check that each supports the sentence citing it):',
    citedText,
    '',
    'Submit ONE JSON object under the unit key "review":',
    '{ "verdict": "PASS" | "REPAIR",',
    '  "summary": string,                       // does it serve the intended use, for this audience?',
    '  "findings": [ { "severity": "BLOCKER" | "MAJOR" | "MINOR", "about": "acceptance condition N" | "required content N" | "purpose" | "citation <claimId>",',
    '                  "statement": string, "repair": string } ],',
    '  "coverage": [ { "requiredContent": N, "met": true | false, "note": string } ]   // one per required content',
    '}',
    'PASS may carry only MINOR findings. REPAIR must name at least one BLOCKER or MAJOR finding with a concrete repair.',
    'A required content declared in the file as "not settled by the evidence" is met=false but is an honest gap, not by itself a reason to repair.',
  ].join('\n');

  const attempt = d.reviewCount + 1;
  const bin = await createBin({
    projectId: d.projectId,
    layerId: null,
    kind: DELIVERABLE_BIN_KIND,
    title: `Review: ${d.title} v${version.versionNumber}`.slice(0, 200),
    objective: `Read version ${version.versionNumber} of "${d.title}" as its audience would and judge it against the request.`,
    rationale: 'A file that opens and cites is not yet a file that serves its purpose; that needs a reader who did not write it.',
    manifest: {
      objective: `Review version ${version.versionNumber} of "${d.title}" against its acceptance conditions.`,
      why: 'Independent review before delivery. The session that built this file may not review it.',
      lineage: { projectId: d.projectId, layerId: null, goal: d.spec.intendedUse.slice(0, 300), orchestrationId: null },
      units: [{ key: REVIEW_UNIT_KEY, establishes: 'whether the file serves its purpose, and what would fix it if not', input, transform: 'NONE', dependsOn: [] }],
      acceptableSources: ['The rendered file and the cited claims in the unit input.'],
      excludedSources: ['Your own view of the subject where it disagrees with the cited evidence — report that as a finding instead.'],
      evidence: ['The native checks already run on the file.'],
      outputs: [`One unit result under "${REVIEW_UNIT_KEY}".`],
      authorizedActions: ['reading', 'submitting one unit result', 'completing the bin'],
      prohibitedActions: ['editing the file', 'sending it to anyone'],
      budgetUnits: 1,
      retry: { maxAttempts: 3, backoffSeconds: 60 },
      stoppingConditions: ['the review has been submitted and the bin completed'],
    },
    completionContract: DELIVERABLE_REVIEW_CONTRACT,
    createdByType: 'SYSTEM',
    createdById: reviewCreator(d.id, version.versionNumber, attempt),
    ready: false,
    priority: 8,
    maxAttempts: 3,
    workloadClass: DELIVERABLE_WORKLOAD_CLASS,
  });
  const won = await moveDeliverable({
    id: d.id,
    fromState: d.state,
    fromBinId: d.activeBinId,
    toState: 'REVIEWING',
    activeBinId: bin.id,
    activeStage: 'REVIEW',
    stateReason: `Version ${version.versionNumber} passed its native checks; an independent session is reviewing it.`,
    incrementReview: true,
  });
  if (!won) {
    await retireBin({ binId: bin.id, leaseGeneration: bin.leaseGeneration, operator: 'deliverables', reason: `Another pass moved ${d.id} first; this review draft was never dispatchable.` });
    return false;
  }
  await attachReviewBin(version.id, bin.id);
  await markBinReady(bin.id);
  return true;
}

/** Brain's own record of which session produced a unit result. Never the worker's word. */
async function lineageOf(binId: string, unitKey: string): Promise<ReviewLineage> {
  const results = await listBinUnitResults(binId);
  const result = results.find((r) => r.unitKey === unitKey) ?? results[0];
  const sessionId =
    result?.leaseGeneration !== null && result?.leaseGeneration !== undefined
      ? await dispatchedSessionForLease(binId, result.leaseGeneration)
      : null;
  const session = await workerSessionForBin(binId);
  return {
    sessionId,
    workerId: result?.submittedBy ?? null,
    accountId: session?.accountId ?? null,
    routineId: session?.routineId ?? null,
  };
}

async function ingestReview(d: Deliverable, bin: Bin): Promise<void> {
  const version = await getVersionByReviewBin(bin.id);
  if (!version) {
    await needsPerson(d, 'A review finished for a version Brain has no record of asking about.');
    return;
  }
  const retryReview = async (why: string): Promise<void> => {
    await recordFinding({ deliverableId: d.id, versionId: version.id, stage: 'REVIEW', severity: 'MINOR', code: 'REVIEW_REFUSED', message: why });
    if (d.reviewCount < MAX_REVIEWS) {
      // Back to BUILDING-with-a-passed-check is not a state; re-open the review
      // from REVIEWING directly by treating it as the state that was read.
      const claims = await resolverFor(d.projectId)(version.citedClaimIds);
      await openReview(d, version, claims);
    } else {
      await needsPerson(d, `The independent review could not be completed ${MAX_REVIEWS} times. Last reason: ${why}`);
    }
  };
  if (bin.state !== 'COMPLETE') {
    await retryReview(`The review bin ended ${bin.state} without a review.`);
    return;
  }
  const results = await listBinUnitResults(bin.id);
  const submitted = results.find((r) => r.unitKey === REVIEW_UNIT_KEY);
  if (!submitted) {
    await retryReview('The review bin finished with no review submitted.');
    return;
  }
  const reviewer = await lineageOf(bin.id, REVIEW_UNIT_KEY);
  const builder = await lineageOf(version.buildBinId, BUILD_UNIT_KEY);
  const independence = decideReviewIndependence(reviewer, [builder]);
  if (!independence.ok) {
    await retryReview(independence.reason);
    return;
  }
  const content = version.content as { gaps?: Array<{ requiredContent: number }> } | null;
  const gapped = new Set((content?.gaps ?? []).map((g) => g.requiredContent));
  const validated = validateReview(submitted.value, d.spec, gapped);
  if (!validated.ok) {
    await retryReview(`The review did not validate: ${validated.problems.join(' ')}`);
    return;
  }
  const report = validated.report;
  const passed = report.verdict === 'PASS';
  const settled = await settleReview({
    versionId: version.id,
    status: passed ? 'REVIEW_PASSED' : 'REVIEW_FAILED',
    report,
    reviewerSessionRef: reviewer.sessionId,
    independence: independence.tier,
  });
  if (!settled) return;
  await recordEvent({
    projectId: d.projectId,
    entityType: 'deliverable',
    entityId: d.id,
    eventType: 'DELIVERABLE_REVIEWED',
    payload: { versionId: version.id, verdict: report.verdict, independence: independence.tier, findings: report.findings.length },
  });
  for (const f of report.findings) {
    await recordFinding({ deliverableId: d.id, versionId: version.id, stage: 'REVIEW', severity: f.severity, code: `REVIEW:${f.about}`.slice(0, 120), message: `${f.statement} Repair: ${f.repair}` });
  }
  if (passed) {
    const won = await moveDeliverable({
      id: d.id,
      fromState: 'REVIEWING',
      fromBinId: bin.id,
      toState: 'DELIVERED',
      activeBinId: null,
      activeStage: null,
      activeReason: null,
      currentVersionId: version.id,
      stateReason: `Version ${version.versionNumber} passed its checks and an independent review.`,
    });
    if (!won) return;
    await resolveOpenFindings(d.id, version.id);
    await recordEvent({ projectId: d.projectId, entityType: 'deliverable', entityId: d.id, eventType: 'DELIVERABLE_DELIVERED', payload: { versionId: version.id, versionNumber: version.versionNumber } });
    await announce((await getDeliverable(d.id))!, (await getVersion(version.id))!);
    return;
  }
  const material = report.findings.filter((f) => isMaterial(f.severity));
  const detail = material.map((f) => `[${f.severity}] ${f.about}: ${f.statement} Repair: ${f.repair}`).join('\n');
  const fresh = (await getDeliverable(d.id))!;
  if (fresh.buildCount < MAX_BUILDS) await openBuild(fresh, 'REPAIR', `The independent reviewer asked for repairs:\n${detail}`);
  else await needsPerson(fresh, `The reviewer still found material problems after ${MAX_BUILDS} builds:\n${detail}`);
}

/* =========================================================================
 * Delivery
 * ====================================================================== */

function describeContents(version: DeliverableVersion): string {
  const content = version.content as DeliverableContent['content'] | null;
  if (!content) return '';
  if ('sections' in content) {
    return `A ${version.checkReport.measures['words'] ?? '?'}-word document: summary, ${content.sections.map((s) => `“${s.heading}”`).join(', ')}, then limitations and ${version.checkReport.measures['sources'] ?? 0} numbered sources.`;
  }
  return `A workbook with ${content.sheets.map((s) => `“${s.name}” (${s.rows.length} rows)`).join(', ')}, plus an About sheet and a Sources sheet resolving ${version.checkReport.measures['sources'] ?? 0} cited claims.`;
}

export function deliveryMessage(d: Deliverable, version: DeliverableVersion, previous: DeliverableVersion | null): string {
  const passedChecks = version.checkReport.items.filter((i) => i.passed);
  const content = version.content as { gaps?: Array<{ requiredContent: number; reason: string }> } | null;
  const gaps = (content?.gaps ?? []).map((g) => `“${d.spec.requiredContents[g.requiredContent] ?? ''}” is not settled by the project’s evidence: ${g.reason}`);
  const limits = [...gaps, ...d.needs.map((n) => `${n.capability}: ${n.detail}`)];
  const lines = [
    `${d.title} is ready — version ${version.versionNumber} (${version.filename}, ${Math.round(version.byteSize / 1024)} KB).`,
    `Open it: ${fileUrl(d.id, version.versionNumber)}`,
    '',
    `What it contains: ${describeContents(version)}`,
    '',
    `What was verified: Brain opened the stored file with ${version.checkReport.readers.join(' and ')} and ${passedChecks.length} of ${version.checkReport.items.length} checks passed — ${passedChecks.map((i) => i.code.toLowerCase().replace(/_/g, ' ')).join('; ')}. ` +
      `An independent session (${(version.reviewIndependence ?? 'unknown').toLowerCase().replace(/_/g, ' ')}) reviewed it against your acceptance conditions: ${version.reviewReport?.summary ?? ''}`,
  ];
  if (previous) lines.push('', `This replaces version ${previous.versionNumber} as the current version; version ${previous.versionNumber} is kept and still opens at ${fileUrl(d.id, previous.versionNumber)}.`);
  if (limits.length) lines.push('', `Limitations: ${limits.join(' ')}`);
  return lines.join('\n');
}

async function announce(d: Deliverable, version: DeliverableVersion): Promise<void> {
  if (!(await claimAnnouncement(version.id))) return;
  if (!d.conversationId) return;
  const earlier = (await latestPassedBefore(d.id, version.versionNumber)) ?? null;
  const message = await addMessage({
    conversationId: d.conversationId,
    role: 'RUSSELL',
    content: deliveryMessage(d, version, earlier),
    produced: {
      deliverableId: d.id,
      deliverableVersion: version.versionNumber,
      fileUrl: fileUrl(d.id, version.versionNumber),
      effect: 'DELIVERABLE_DELIVERED',
    },
  });
  await recordAnnouncement(version.id, message.id);
}

async function latestPassedBefore(deliverableId: string, versionNumber: number): Promise<DeliverableVersion | null> {
  const passed = (await listVersions(deliverableId)).filter((v) => v.status === 'REVIEW_PASSED' && v.versionNumber < versionNumber);
  return passed[passed.length - 1] ?? null;
}

/* =========================================================================
 * The tick
 * ====================================================================== */

export interface AdvanceReport {
  opened: string[];
  ingested: string[];
  delivered: string[];
  needsPerson: string[];
}

/** One deliverable, one step. Returns what happened, for the tick's report. */
export async function advanceDeliverable(id: string): Promise<'OPENED' | 'INGESTED' | 'NOTHING'> {
  const d = await getDeliverable(id);
  if (!d) return 'NOTHING';
  if (d.state === 'BRIEFED') return (await openBuild(d, 'INITIAL', null)) ? 'OPENED' : 'NOTHING';
  if ((d.state === 'DELIVERED' || d.state === 'NEEDS_PERSON') && d.pendingCorrection) {
    await recordFinding({ deliverableId: d.id, versionId: d.currentVersionId, stage: 'PERSON', severity: 'MAJOR', code: 'REVISION_REQUESTED', message: d.pendingCorrection });
    return (await openBuild(d, 'REVISION', d.pendingCorrection)) ? 'OPENED' : 'NOTHING';
  }
  if (d.state === 'DELIVERED' && d.currentVersionId) {
    // Recovery: a delivery whose message a dead tick never posted.
    const version = await getVersion(d.currentVersionId);
    if (version && !version.announcedAt) await announce(d, version);
    return 'NOTHING';
  }
  if ((d.state === 'BUILDING' || d.state === 'REVIEWING') && d.activeBinId) {
    const bin = await getBin(d.activeBinId);
    if (!bin) return 'NOTHING';
    if (!['COMPLETE', 'FAILED', 'CANCELLED', 'NEEDS_HUMAN'].includes(bin.state)) return 'NOTHING';
    if (d.activeStage === 'BUILD') await ingestBuild(d, bin);
    else await ingestReview(d, bin);
    return 'INGESTED';
  }
  return 'NOTHING';
}

export async function advanceDeliverables(limit = 25): Promise<AdvanceReport> {
  const report: AdvanceReport = { opened: [], ingested: [], delivered: [], needsPerson: [] };
  for (const d of await listAdvanceableDeliverables(limit)) {
    try {
      const outcome = await advanceDeliverable(d.id);
      if (outcome === 'OPENED') report.opened.push(d.id);
      if (outcome === 'INGESTED') report.ingested.push(d.id);
      const after = await getDeliverable(d.id);
      if (after && after.state !== d.state) {
        if (after.state === 'DELIVERED') report.delivered.push(d.id);
        if (after.state === 'NEEDS_PERSON') report.needsPerson.push(d.id);
      }
    } catch (error) {
      // One deliverable that cannot advance must not stop the rest, and must
      // not stop the Russell tick it runs inside.
      console.error(`[deliverables] ${d.id} could not advance:`, error instanceof Error ? error.message : error);
    }
  }
  return report;
}

export { listFindings };

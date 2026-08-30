/**
 * Turning a submitted report into a registered document.
 *
 * The same reasoning as `submission.ts`: Step 9 added a second way to *produce*
 * a packet and must not add a second way to *file* one. So the citation check,
 * the ledger, the naming and the registration all live here, and both the
 * in-process orchestrator and the MCP synthesis tool call them.
 *
 * Two rules this enforces that nothing else can.
 *
 * **Every citation resolves to an accepted claim.** A report citing a claim
 * that was rejected, that belongs to a blocked fragment, or that does not exist
 * is refused whole — not annotated, not filed with a warning. A packet whose
 * citations are approximately right is worse than no packet, because the reader
 * has no way to tell which sentences are the approximate ones.
 *
 * **The platform owns the filename.** `buildNames` decides `canonical_name`,
 * and the report's own title never does. That is §4, and it is the rule most
 * likely to be quietly broken by a path that files a document a model produced.
 */
import type { ResearchClaim, ResearchOrchestration } from '../../domain/types.ts';
import { getLayer } from '../../repos/layers.ts';
import { getProject } from '../../repos/projects.ts';
import { getRun } from '../../repos/runs.ts';
import { citableClaimCoverage, citableClaims, updateOrchestration } from '../../repos/research.ts';
import { registerRunArtifact, targetVersionForRun } from '../runArtifacts.ts';
import { enqueueExtraction } from '../documents/queue.ts';
import { isAuditable } from '../documents/quality.ts';

export class UncitableClaims extends Error {
  readonly claimIds: string[];
  constructor(claimIds: string[]) {
    super(
      `${claimIds.length} cited claim(s) are not accepted evidence for this packet: ` +
        `${claimIds.slice(0, 10).join(', ')}${claimIds.length > 10 ? ', …' : ''}. ` +
        'A citation must resolve to a claim that cleared its fragment\'s evidence gate.',
    );
    this.name = 'UncitableClaims';
    this.claimIds = claimIds;
  }
}

export class NothingToFile extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NothingToFile';
  }
}

/**
 * The evidence ledger, appended to every filed report.
 *
 * This is what makes a sentence in the packet resolve to a claim id, a URL and
 * a passage. A report filed without it would be prose that happens to be true;
 * with it, a reader can check.
 */

/**
 * The passage, and an honest mark when it did not fit.
 *
 * The ledger's own preamble used to promise "the exact passage is preserved"
 * directly above a hard 400-character slice with no marker, so a cut quotation
 * was indistinguishable from a complete one and could be carried onward as if
 * exact. The stored excerpt was never truncated — only the rendering was — so
 * nothing was lost except the reader's ability to tell.
 */
function excerpt(value: string | null): string {
  const flat = (value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > 400 ? `${flat.slice(0, 399)}…` : flat;
}

/** Said beside the claim, because a reader cannot infer it from the citation. */
function coverageNote(
  entry: { fragmentKey: string; status: string; reason: string | null } | undefined,
): string | null {
  if (!entry || entry.status !== 'BLOCKED') return null;
  return (
    `  - Coverage: **incomplete** — fragment \`${entry.fragmentKey}\` did not meet its evidence ` +
    `bar${entry.reason ? `: ${entry.reason.replace(/\s+/g, ' ').slice(0, 200)}` : '.'} ` +
    'This claim is accepted evidence; the requirement it belongs to is not settled.'
  );
}

export function appendLedger(
  report: string,
  claims: ResearchClaim[],
  coverage: Map<string, { fragmentKey: string; status: string; reason: string | null }> = new Map(),
): string {
  const lines = [
    report.trim(),
    '',
    '---',
    '',
    '## Evidence ledger',
    '',
    'Every claim below passed the fragment evidence gate: it has a canonical source URL, the',
    'source was verified to support it, and its scope matches the fragment that produced it.',
    'Passages are quoted from the stored excerpt and are truncated at 400 characters, marked',
    'with an ellipsis where that happened; the full excerpt is held against the claim.',
    '',
    'A claim marked **coverage incomplete** is accepted evidence whose fragment did not answer',
    'its question to the declared bar. The claim stands; the requirement behind it does not.',
    '',
  ];
  for (const claim of claims) {
    // Built as a list and filtered here, rather than filtering the whole
    // document at the end.
    //
    // The end-of-function filter dropped *every* empty string, which was meant
    // to remove the two conditional entries below and also removed the blank
    // lines above that separate the rule from the heading and the heading from
    // its paragraph. Markdown needs those: without them the `## Evidence
    // ledger` heading sits against the `---` above it and renders as part of
    // it. Every packet the Brain has ever filed had that defect, and it only
    // showed up when somebody read one.
    const entry = [
      `- **[${claim.id}]** ${claim.claim}`,
      `  - Source: ${claim.sourcePublisher ?? 'unknown publisher'} — ${claim.sourceTitle ?? 'untitled'}` +
        `${claim.sourceDate ? ` (${claim.sourceDate})` : ''}`,
      `  - URL: ${claim.sourceUrl}`,
      `  - Passage: "${excerpt(claim.evidenceExcerpt)}"` +
        `${claim.evidenceLocator ? ` — ${claim.evidenceLocator}` : ''}`,
      coverageNote(coverage.get(claim.id)),
      claim.retrievedAt ? `  - Retrieved: ${claim.retrievedAt}` : null,
      claim.contradictionState !== 'UNCHALLENGED'
        ? `  - Contradiction state: ${claim.contradictionState}${claim.contradictionNote ? ` — ${claim.contradictionNote}` : ''}`
        : null,
    ].filter((line): line is string => line !== null);
    lines.push(...entry);
  }
  return `${lines.join('\n')}\n`;
}

/** What is still open, stated in the packet rather than left for the reader. */
function appendLimitations(report: string, stillMissing: string[]): string {
  if (stillMissing.length === 0) return report;
  return [
    report,
    '',
    '---',
    '',
    '## What this packet does not settle',
    '',
    ...stillMissing.map((entry) => `- ${entry}`),
  ].join('\n');
}

export interface FiledPacket {
  documentId: string | null;
  summary: string;
  value: Record<string, unknown>;
}

/**
 * Check the citations, assemble the artifact, and register it.
 *
 * Does not run the audit. That is the caller's next step and it is a separate
 * work item in the pull path, because an audit is its own passes rather than a
 * continuation of the synthesis — and because a report that filed but could not
 * be audited is a state a person can act on rather than a failure.
 */
export async function assertCitable(
  orchestrationId: string,
  citedClaimIds: string[],
): Promise<ResearchClaim[]> {
  const accepted = await citableClaims(orchestrationId);
  if (accepted.length === 0) {
    // Refusing rather than filing an empty packet. A report with no accepted
    // evidence behind it is the thing this whole engine exists to make
    // impossible, and it must not become possible at the last step.
    throw new NothingToFile(
      'No claim in this packet cleared its fragment evidence gate, so there is nothing to file. ' +
        'Repair or narrow the fragments instead.',
    );
  }

  const acceptedIds = new Set(accepted.map((claim) => claim.id));
  const uncitable = citedClaimIds.filter((id) => !acceptedIds.has(id));
  if (uncitable.length > 0) throw new UncitableClaims(uncitable);
  return accepted;
}

export async function fileResearchPacket(input: {
  orchestration: ResearchOrchestration;
  reportText: string;
  citedClaimIds: string[];
  stillMissing: string[];
  passId: string;
}): Promise<FiledPacket> {
  const { orchestration } = input;

  // Checked again here even though the caller checks first. The caller checks
  // so that a bad citation is an argument error rather than a poisoned
  // idempotency record; this checks because a service that files a packet must
  // not depend on every caller having remembered to.
  const accepted = await assertCitable(orchestration.id, input.citedClaimIds);

  const layer = await getLayer(orchestration.layerId);
  const project = await getProject(orchestration.projectId);
  const run = await getRun(orchestration.runId);
  if (!layer || !project || !run) {
    throw new NothingToFile('The packet\'s layer, project or run is missing.');
  }

  await updateOrchestration(orchestration.id, {
    reportText: input.reportText,
    status: 'SYNTHESIZING',
    currentPass: 'SYNTHESIS',
  });

  const version = await targetVersionForRun(run, layer.id, project.id);
  const body = appendLedger(
    appendLimitations(input.reportText, input.stillMissing),
    accepted,
    await citableClaimCoverage(orchestration.id),
  );

  const filed = await registerRunArtifact({
    run,
    layer,
    project,
    // A hint, not the name. `buildNames` decides what this document is called;
    // passing the report's own title here is how a model would end up naming a
    // canonical artifact.
    originalFilename: `${layer.name} ${version}.md`,
    contents: Buffer.from(body, 'utf8'),
    notes:
      `Staged research ${orchestration.id}: ${accepted.length} accepted claims, ` +
      `${input.citedClaimIds.length} cited.`,
  });

  if (!filed.imported.documentId) {
    const reason = `The report could not be filed: ${filed.imported.message}`;
    await updateOrchestration(orchestration.id, { status: 'NEEDS_HUMAN', failureReason: reason });
    return { documentId: null, summary: 'filing failed', value: { filed: false, reason } };
  }

  await updateOrchestration(orchestration.id, { documentId: filed.imported.documentId });

  // The audit reads extracted evidence, never raw bytes (invariant 9), and
  // importing only queues the extraction. Waiting for it here is what makes the
  // handoff real: without it the audit would judge a document Brain had not yet
  // read, and would correctly refuse.
  const extraction = await enqueueExtraction(filed.imported.documentId);
  if (!isAuditable(extraction.run.status)) {
    const reason =
      'The report was filed but could not be read back for audit: ' +
      `${extraction.quality?.blockedReason ?? extraction.run.status}.`;
    await updateOrchestration(orchestration.id, {
      status: 'NEEDS_HUMAN',
      failureReason: reason,
      completedAt: new Date().toISOString(),
    });
    return {
      documentId: filed.imported.documentId,
      summary: 'filed, unreadable',
      value: { filed: true, documentId: filed.imported.documentId, auditable: false, reason },
    };
  }

  await updateOrchestration(orchestration.id, { status: 'AUDITING', currentPass: 'AUDIT' });

  return {
    documentId: filed.imported.documentId,
    summary: `filed as ${filed.document?.canonicalName ?? filed.imported.documentId}`,
    value: {
      filed: true,
      documentId: filed.imported.documentId,
      // The platform's name, so the worker can see that its own title was not
      // used and does not try again with a better one.
      canonicalName: filed.document?.canonicalName ?? null,
      version,
      acceptedClaims: accepted.length,
      citedClaims: input.citedClaimIds.length,
      auditable: true,
      status: 'AUDITING',
    },
  };
}

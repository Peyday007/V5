/**
 * Prompt compiler (sections 9 and 10).
 *
 * A prompt is never a stored blob of prose. It is composed, in one fixed order,
 * from sections that each read live project state, which is what makes invariant
 * 10 worth anything: the exact text handed to a research model is reproducible
 * from the database, and the attachment list beside it is the same list the
 * dependency checker validates.
 *
 * Section 10 is enforced here rather than trusted to the model. Every compiled
 * prompt carries the hardened naming block and ends with the final naming check,
 * and all three names always come from `buildNames(layer.name, targetVersion)` —
 * the platform decides what the document is called, never the model.
 */
import type {
  CompiledPrompt,
  DependencyCheckItem,
  DependencyCheckResult,
  Document,
  DocumentStatus,
  Layer,
  Project,
  PromptSection,
  PromptSectionKey,
  RunType,
  VersionPolicy,
} from '../domain/types.ts';
import { AUDIT_VERDICTS } from '../domain/types.ts';
import type { CanonicalNames } from '../domain/naming.ts';
import {
  buildCanonicalName,
  buildNames,
  finalNamingCheckBlock,
  namesMatch,
  namingRulesBlock,
  normalizeName,
} from '../domain/naming.ts';
import {
  maxVersion,
  nextExpansionVersion,
  normalizeVersion,
  sortVersions,
  synthesisSourceVersions,
  synthesisVersion,
  waveForVersion,
} from '../domain/version.ts';
import { getAudit, getLatestAuditForRun } from '../repos/audits.ts';
import { listDocuments, listDocumentsByLayer } from '../repos/documents.ts';
import { getLayer, listLayers } from '../repos/layers.ts';
import { getProject } from '../repos/projects.ts';
import { getRun } from '../repos/runs.ts';
import { checkCanonicalNames } from './dependencies.ts';

export interface CompilePromptInput {
  projectId: string;
  layerId: string;
  runType: RunType;
  targetVersion?: string | null;
  /** Canonical names of the source packet. Defaults per run type when omitted. */
  requiredDocuments?: string[] | null;
  /** Include the AUDIT_FINDINGS section built from this audit. */
  auditId?: string | null;
  /** Include the PREVIOUS_ATTEMPT section built from this run. */
  previousRunId?: string | null;
  objective?: string | null;
  scope?: string | null;
  researchQuestions?: string[] | null;
}

/** The fixed order every compiled prompt follows. Conditional keys are skipped. */
const SECTION_ORDER: readonly PromptSectionKey[] = [
  'PROJECT_CONTEXT',
  'LAYER_CONTEXT',
  'RUN_TYPE',
  'OBJECTIVE',
  'SOURCE_PACKET',
  'REQUIRED_ATTACHMENTS',
  'SCOPE',
  'RESEARCH_QUESTIONS',
  'PROHIBITED_DUPLICATION',
  'CROSS_LAYER_BOUNDARIES',
  'AUDIT_FINDINGS',
  'PREVIOUS_ATTEMPT',
  'OUTPUT_REQUIREMENTS',
  'NAMING_RULES',
  'FINAL_NAMING_CHECK',
];

const SECTION_HEADINGS: Record<PromptSectionKey, string> = {
  PROJECT_CONTEXT: 'PROJECT CONTEXT',
  LAYER_CONTEXT: 'LAYER CONTEXT',
  RUN_TYPE: 'RUN TYPE',
  OBJECTIVE: 'OBJECTIVE',
  SOURCE_PACKET: 'SOURCE PACKET',
  REQUIRED_ATTACHMENTS: 'REQUIRED ATTACHMENTS',
  SCOPE: 'SCOPE',
  RESEARCH_QUESTIONS: 'RESEARCH QUESTIONS',
  PROHIBITED_DUPLICATION: 'PROHIBITED DUPLICATION',
  CROSS_LAYER_BOUNDARIES: 'CROSS-LAYER BOUNDARIES',
  AUDIT_FINDINGS: 'AUDIT FINDINGS',
  PREVIOUS_ATTEMPT: 'PREVIOUS ATTEMPT',
  OUTPUT_REQUIREMENTS: 'OUTPUT REQUIREMENTS',
  NAMING_RULES: 'NAMING RULES',
  FINAL_NAMING_CHECK: 'FINAL NAMING CHECK',
};

/** Documents that count as usable sources: finished work with a real artifact. */
const PACKET_STATUSES: ReadonlySet<DocumentStatus> = new Set<DocumentStatus>(['COMPLETE', 'FROZEN']);

/** Run types that produce the target document (so it cannot also be a source). */
const PRODUCING_RUN_TYPES: ReadonlySet<RunType> = new Set<RunType>([
  'FOUNDATION',
  'EXPANSION',
  'SYNTHESIS',
  'REDO',
]);

// ---------------------------------------------------------------------------
// Small text helpers — sections are assembled, never pasted
// ---------------------------------------------------------------------------

function bullets(items: readonly string[]): string {
  return items.map((item) => `  - ${item}`).join('\n');
}

function numbered(items: readonly string[]): string {
  const width = String(items.length).length;
  return items.map((item, index) => `  ${String(index + 1).padStart(width)}. ${item}`).join('\n');
}

/** Aligned `Label : value` rows, so the header of a section scans in one look. */
function labelled(rows: readonly (readonly [string, string])[]): string {
  const width = rows.reduce((max, row) => Math.max(max, row[0].length), 0);
  return rows.map(([label, value]) => `${label.padEnd(width)} : ${value}`).join('\n');
}

/**
 * Trim blank lines around a block without touching its indentation — list
 * bullets are indented on purpose and a plain `trim()` eats the first one.
 */
function trimBlock(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
}

function blocks(...parts: readonly (string | null | undefined)[]): string {
  return parts
    .map((part) => trimBlock(part ?? ''))
    .filter((part) => part.length > 0)
    .join('\n\n');
}

function section(key: PromptSectionKey, body: string): PromptSection {
  return { key, heading: SECTION_HEADINGS[key], body: trimBlock(body) };
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = (raw ?? '').trim();
    if (value.length === 0) continue;
    const key = normalizeName(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface LayerContext {
  project: Project;
  layer: Layer;
  layers: Layer[];
  policy: VersionPolicy;
  /** Every registered row in the layer, in version order. */
  documents: Document[];
  /** The subset usable as sources: finished, non-audit documents. */
  packetDocuments: Document[];
  documentsByVersion: Map<string, Document>;
}

interface PromptContext extends LayerContext {
  runType: RunType;
  targetVersion: string;
  names: CanonicalNames;
  requiredDocuments: string[];
  packet: DependencyCheckResult;
}

async function loadLayerContext(projectId: string, layerId: string): Promise<LayerContext> {
  const project = await getProject(projectId);
  if (!project) throw new Error(`Cannot compile a prompt: unknown project ${projectId}`);
  const layer = await getLayer(layerId);
  if (!layer) throw new Error(`Cannot compile a prompt: unknown layer ${layerId}`);
  if (layer.projectId !== project.id) {
    throw new Error(
      `Cannot compile a prompt: layer ${layer.name} does not belong to project ${project.name}`,
    );
  }

  const documents = await listDocumentsByLayer(layerId);
  const packetDocuments = documents.filter(
    (document) => PACKET_STATUSES.has(document.status) && document.documentType !== 'AUDIT',
  );

  // One document per version, preferring a finished artifact over a placeholder
  // row, so canonical names in the prompt match what the checker will look up.
  const documentsByVersion = new Map<string, Document>();
  for (const document of documents) {
    const key = normalizeVersion(document.version);
    const current = documentsByVersion.get(key);
    if (!current || (!PACKET_STATUSES.has(current.status) && PACKET_STATUSES.has(document.status))) {
      documentsByVersion.set(key, document);
    }
  }

  return {
    project,
    layer,
    layers: await listLayers(project.id),
    policy: project.versionPolicy,
    documents,
    packetDocuments,
    documentsByVersion,
  };
}

function registeredVersions(ctx: LayerContext): string[] {
  return sortVersions(unique(ctx.documents.map((document) => normalizeVersion(document.version))));
}

function packetVersions(ctx: LayerContext): string[] {
  return sortVersions(
    unique(ctx.packetDocuments.map((document) => normalizeVersion(document.version))),
  );
}

function expectedVersions(ctx: LayerContext): string[] {
  return sortVersions(unique(ctx.layer.expectedVersions.map((version) => normalizeVersion(version))));
}

/** Everything the layer either has or has promised — the synthesis denominator. */
function declaredVersions(ctx: LayerContext): string[] {
  return sortVersions(unique([...registeredVersions(ctx), ...expectedVersions(ctx)]));
}

/** The registered spelling wins; a version with no row yet gets the derived name. */
function canonicalNameForVersion(ctx: LayerContext, version: string): string {
  const normalized = normalizeVersion(version);
  return (
    ctx.documentsByVersion.get(normalized)?.canonicalName ??
    buildCanonicalName(ctx.layer.name, normalized)
  );
}

async function canonicalDocumentsOfOtherLayers(ctx: LayerContext): Promise<string[]> {
  return (await listDocuments(ctx.project.id))
    .filter(
      (document) =>
        document.layerId !== null &&
        document.layerId !== ctx.layer.id &&
        (document.isCanonical || document.frozen),
    )
    .map((document) => document.canonicalName);
}

// ---------------------------------------------------------------------------
// Defaults per run type
// ---------------------------------------------------------------------------

function resolveTargetVersion(ctx: LayerContext, runType: RunType): string {
  const foundation = normalizeVersion(ctx.policy.foundationVersion);
  const synthesis = synthesisVersion(ctx.policy);

  switch (runType) {
    case 'FOUNDATION':
      return foundation;
    case 'SYNTHESIS':
      return synthesis;
    case 'EXPANSION': {
      // Mirrors the state engine: a declared expectation that is still missing
      // is the next thing to run, so the planner and the prompt never disagree.
      const present = packetVersions(ctx);
      const outstanding = expectedVersions(ctx).filter(
        (version) => version !== synthesis && !present.includes(version),
      );
      return outstanding[0] ?? nextExpansionVersion(registeredVersions(ctx), ctx.policy);
    }
    case 'AUDIT':
    case 'PATCH':
    case 'REDO':
    case 'CROSS_LAYER_AUDIT': {
      // These act on work that already exists: the newest finished document,
      // falling back to whatever the layer last recorded.
      const current =
        maxVersion(packetVersions(ctx)) ??
        ctx.layer.currentVersion ??
        maxVersion(registeredVersions(ctx)) ??
        foundation;
      return normalizeVersion(current);
    }
  }
}

async function resolveRequiredDocuments(
  ctx: LayerContext,
  runType: RunType,
  targetVersion: string,
): Promise<string[]> {
  const target = normalizeVersion(targetVersion);
  const synthesis = synthesisVersion(ctx.policy);
  const sourcesForSynthesis = (): string[] =>
    synthesisSourceVersions(declaredVersions(ctx), ctx.policy)
      .filter((version) => version !== target)
      .map((version) => canonicalNameForVersion(ctx, version));

  switch (runType) {
    case 'FOUNDATION':
      // The first document in a layer has nothing to consume.
      return [];
    case 'EXPANSION':
    case 'REDO':
      return ctx.packetDocuments
        .filter((document) => normalizeVersion(document.version) !== target)
        .map((document) => document.canonicalName);
    case 'SYNTHESIS':
      // Expected-but-missing versions stay in the list on purpose: that is how
      // the checker reports `6 / 7 READY` instead of silently synthesising a
      // packet with a hole in it (invariant 4).
      return sourcesForSynthesis();
    case 'AUDIT':
    case 'PATCH': {
      const names = [canonicalNameForVersion(ctx, target)];
      // Auditing or patching the canonical document means checking it against
      // the packet it claims to consolidate.
      if (target === synthesis) names.push(...sourcesForSynthesis());
      return names;
    }
    case 'CROSS_LAYER_AUDIT':
      return [canonicalNameForVersion(ctx, target), ...await canonicalDocumentsOfOtherLayers(ctx)];
  }
}

/** The version this run type would target for this layer right now. */
export async function defaultTargetVersion(
  projectId: string,
  layerId: string,
  runType: RunType,
): Promise<string> {
  const ctx = await loadLayerContext(projectId, layerId);
  return resolveTargetVersion(ctx, runType);
}

/** The canonical names this run type would require for this layer right now. */
export async function defaultRequiredDocuments(
  projectId: string,
  layerId: string,
  runType: RunType,
): Promise<string[]> {
  const ctx = await loadLayerContext(projectId, layerId);
  const targetVersion = resolveTargetVersion(ctx, runType);
  return unique(await resolveRequiredDocuments(ctx, runType, targetVersion));
}

// ---------------------------------------------------------------------------
// Run-type playbook — the methodology this project applies to each kind of run
// ---------------------------------------------------------------------------

interface RunPlaybook {
  /** What this run type is expected to produce, in this project's methodology. */
  methodology: readonly string[];
  objective: (ctx: PromptContext) => string;
  inScope: (ctx: PromptContext) => string[];
  outOfScope: (ctx: PromptContext) => string[];
  questions: (ctx: PromptContext) => string[];
  /** Requirements specific to this run type, added to the shared ones. */
  output: (ctx: PromptContext) => string[];
  /** How the already-covered documents must be treated. */
  duplication: (ctx: PromptContext) => string[];
}

const SHARED_OUTPUT_RULES: readonly string[] = [
  'One document. Not an outline followed by a document, not a summary followed by the real thing, not a series of messages.',
  'Structure it with numbered top-level sections and descriptive headings, so a later audit can cite "section 4.2" and mean something.',
  'Every non-obvious claim carries its support inline: the mechanism, a worked example, or the canonical name of the source document it comes from.',
  'Uncertainty is content. Where the evidence runs out, say so, say what would settle it, and keep going — do not paper over the gap with confident prose.',
  'No meta-commentary: do not describe your process, do not restate this prompt back, do not narrate what you are about to do.',
  'Write for a reader who knows this project but has not read this document.',
];

const PLAYBOOKS: Record<RunType, RunPlaybook> = {
  FOUNDATION: {
    methodology: [
      'A FOUNDATION run establishes a layer that has nothing in it yet. There is no packet to widen and nothing to reconcile: you are fixing the core model of the layer — its entities, the relationships between them, the mechanisms that make it move, and the vocabulary every later document in this layer is required to reuse.',
      'Precision beats breadth. Every sibling expansion and the eventual synthesis inherit these definitions, so an ambiguity introduced here is repeated in every document that follows it.',
    ],
    objective: (ctx) =>
      `Produce ${ctx.names.canonicalName} — the founding document of the ${ctx.layer.name} layer, written so that every later document in this layer can build on it without redefining its terms.`,
    inScope: (ctx) => [
      `The entities, relationships and mechanisms that ${ctx.layer.name} is made of.`,
      'The definitions that must be fixed now because later documents will depend on them.',
      'The boundary of the layer: what belongs inside it and what belongs to a neighbouring layer.',
      'The assumptions you are making, stated as assumptions, with what they rest on.',
      'The open questions the sibling expansions should attack next.',
    ],
    outOfScope: (ctx) => [
      `Any layer of ${ctx.project.name} other than ${ctx.layer.name}.`,
      'Speculation presented as settled fact.',
      'Implementation, tooling or interface detail, unless this layer is explicitly about them.',
    ],
    questions: (ctx) => [
      `What are the core entities and mechanisms of ${ctx.layer.name}, and how do they interact?`,
      'Which definitions must be fixed here so that later documents can rely on them without restating them?',
      'Where exactly does this layer end, and which neighbouring layer picks up on the other side of that line?',
      'What is currently assumed rather than established, and what would it take to establish it?',
      'What are the two or three questions a sibling expansion should be sent after first?',
    ],
    output: () => [
      'Open with a one-paragraph statement of what this layer is and what it is responsible for.',
      'Give definitions their own numbered section; later documents will cite them by number.',
      'Close with an explicit list of open questions, each phrased so it could become a research run.',
    ],
    duplication: () => [
      'Do not restate the documents listed above. A foundation written into a layer that already holds work earns its place by being more precise than that work, never by repeating it.',
    ],
  },

  EXPANSION: {
    methodology: [
      'An EXPANSION run produces a SIBLING of the documents already in this layer, not a revision of them. Nothing in the existing packet is rewritten, re-ordered or replaced: the packet stands, and your document sits beside it.',
      'The purpose of a sibling expansion is to WIDEN COVERAGE. Read the packet first, work out where its coverage actually stops — the cases it does not reach, the mechanisms it names but never explains, the actors and conditions it assumes away — and then go past that edge.',
      'If you find an outright error in an existing document, record it plainly as a defect for the audit to pick up. Do not silently correct it here: the packet is the layer provenance, and only an audit is allowed to invalidate part of it.',
    ],
    objective: (ctx) => {
      const sources = ctx.requiredDocuments.length;
      const packet =
        sources === 0
          ? 'the work already on file'
          : `the ${count(sources, 'document')} already in the source packet`;
      return `Produce ${ctx.names.canonicalName} — a sibling expansion that widens ${ctx.layer.name} beyond ${packet}, without re-deriving what is already covered.`;
    },
    inScope: (ctx) => [
      `Coverage of ${ctx.layer.name} that the source packet does not already have: new mechanisms, new cases, new actors, new conditions.`,
      'The evidence behind that new coverage: how it works, when it holds, and what it depends on.',
      'One-line interfaces to the packet where you build on an existing conclusion.',
      'Defects you noticed in the packet, listed as defects for the audit rather than corrected in place.',
    ],
    outOfScope: (ctx) => [
      'Rewriting, re-summarising or re-ordering anything already in the source packet.',
      `Any layer of ${ctx.project.name} other than ${ctx.layer.name}.`,
      'Changing the target version, the document title, or the name of the layer.',
      'Implementation, tooling or interface detail, unless this layer is explicitly about them.',
    ],
    questions: (ctx) => [
      `Where does the source packet's coverage of ${ctx.layer.name} actually stop, and which of those gaps matters most to the project's north star?`,
      'Which situations does the packet treat as edge cases that are in fact common, and what happens when you take them seriously?',
      'Which claims does the packet assert without demonstrating, and what evidence or mechanism can you supply for them?',
      "Where does the packet's vocabulary break down when applied to the material you are adding, and what needs renaming or splitting?",
      'What would have to be true for the core claims of this layer to be wrong, and how close is the current packet to that?',
    ],
    output: () => [
      'Open with one paragraph stating precisely what this expansion adds that the packet did not have.',
      'Depth over breadth: this is a research deliverable, not a briefing note. A thin survey of familiar ground fails the audit.',
      'Close with the open questions this expansion leaves behind, each phrased so it could become the next run.',
    ],
    duplication: () => [
      'Do not re-derive, re-summarise or re-explain the documents listed above. Referring to one of their conclusions in a sentence and building on it is correct; reproducing their reasoning is duplication, and the audit treats duplication as a defect.',
      'If you cannot add to a topic the packet already covers, say nothing about it. Silence on settled ground is not a gap.',
    ],
  },

  SYNTHESIS: {
    methodology: [
      'A SYNTHESIS run consolidates the ENTIRE packet into one canonical document that replaces the packet as the thing anyone reads. The sources stay on file as provenance, but after synthesis the canonical document is what the project treats as its current model of the layer.',
      'Nothing substantive may be lost. Every claim, mechanism, distinction, example and caveat in the sources must survive the consolidation — deduplicated, reconciled, and reorganised into a single structure that reads as though it had been written once.',
      'Where two sources disagree, resolve the disagreement in the open: state both readings, say which one survives, and say why. Do not average them, do not keep both silently, and do not drop the losing claim without recording that you dropped it.',
    ],
    objective: (ctx) =>
      `Produce ${ctx.names.canonicalName} — the single canonical ${ctx.layer.name} document, consolidating ${count(ctx.requiredDocuments.length, 'source document')} into one internally consistent reference that stands alone in place of them.`,
    inScope: () => [
      'Every substantive claim, mechanism, distinction and caveat present in the source packet.',
      'Explicit resolution of every conflict between sources, with the reasoning for the resolution.',
      'A structure chosen for the consolidated whole, not inherited from any one source.',
      'Gaps in the packet, recorded as open questions rather than quietly filled in.',
    ],
    outOfScope: (ctx) => [
      'New research. Nothing may appear here that is not traceable to the source packet or explicitly flagged as an open question.',
      'Dropping material because it is awkward to reconcile.',
      `Any layer of ${ctx.project.name} other than ${ctx.layer.name}.`,
      'Changing the canonical version, the document title, or the name of the layer.',
    ],
    questions: (ctx) => [
      'Where do the source documents contradict each other, and which reading survives once you look at the evidence behind each?',
      'Which claims appear in several sources with different wording, and what is the single canonical statement of each?',
      `What is the smallest structure that holds everything the packet says about ${ctx.layer.name} without repeating itself?`,
      'Which parts of the packet are unsupported, and should therefore be marked as open questions rather than canonised?',
      'What will a reader of this document alone still not know about this layer?',
    ],
    output: () => [
      'The document must stand alone: a reader with none of the sources must come away with the complete current model of the layer.',
      'Include a short provenance note listing, by canonical name, every source document consolidated into this one.',
      'Include a conflicts-resolved list: each conflict, the readings involved, and the resolution you applied.',
      'Include an open-questions list: what the packet does not settle, and what would settle it.',
    ],
    duplication: () => [
      'Consolidating the documents above is the job, so their content is not off-limits here — but re-deriving them is. Do not re-run their research, re-litigate settled conclusions, or state the same claim twice in two sections because two sources happened to make it.',
    ],
  },

  PATCH: {
    methodology: [
      'A PATCH run repairs specific, named defects in a document that otherwise stands. It is surgical: the document is not re-derived, its research is not re-run, its structure is not reorganised, and the parts that are already correct are not restated.',
      'Produce only the corrected material, each piece keyed to exactly where it belongs, so that the repair can be applied to the existing document without disturbing anything around it.',
    ],
    objective: (ctx) =>
      `Repair ${ctx.names.canonicalName}: fix each defect recorded against it, and change nothing else.`,
    inScope: () => [
      'Only the defects named below, plus the minimum surrounding text needed to apply each fix cleanly.',
      'For each defect: where it lives, what is wrong with it, and the exact replacement text.',
      'A note on any defect you believe is not in fact a defect, with the argument.',
    ],
    outOfScope: () => [
      'Anything the audit did not flag.',
      'Restructuring, retitling or reordering the document.',
      'New research, new sections, or new claims not required by a named defect.',
    ],
    questions: () => [
      'For each defect: what exactly is wrong — a factual error, an internal contradiction, a missing dependency, or an omission?',
      'What is the smallest replacement text that fixes it without changing anything correct around it?',
      'Does the correction contradict anything else in the document, and if so what else must change with it?',
      'Is any defect actually a symptom of a deeper problem that a patch cannot fix, and therefore needs a redo instead?',
    ],
    output: () => [
      'Output the patch only, as a numbered list keyed to the defects below, in the same order.',
      'Each entry: LOCATION (section and heading), DEFECT (what is wrong), REPLACEMENT (the exact new text).',
      'Do not reproduce unchanged parts of the document.',
    ],
    duplication: () => [
      'The documents listed above are the context for the repair, not material to reproduce. Quote from them only where a quotation is needed to locate or justify a fix.',
    ],
  },

  AUDIT: {
    methodology: [
      'An AUDIT run inspects work that already exists and returns a verdict. It produces no new research and no replacement text.',
      'You are checking whether the document does what its layer needs: coverage against what was asked of it, internal consistency, honest use of its source packet, correct naming and versioning, and whether it is ready for the next stage of the programme.',
      'Findings must be specific enough to act on and specific enough to verify. "Section 3 asserts X while section 7 assumes not-X" is a finding; "could be more rigorous" is not.',
    ],
    objective: (ctx) =>
      `Audit ${ctx.names.canonicalName} and return a structured verdict on whether it is complete, internally consistent, correctly built on its source packet, and ready for the next stage.`,
    inScope: (ctx) => [
      `${ctx.names.canonicalName} and the source packet it claims to build on.`,
      'Coverage: does it deliver what a document of this type in this layer is supposed to deliver?',
      'Internal consistency: do its own sections agree with each other?',
      'Dependency use: does it rely on documents that do not exist, or ignore ones it should have used?',
      'Naming and versioning compliance.',
      'Readiness: more research, a patch, a redo, synthesis, or freeze?',
    ],
    outOfScope: () => [
      'Writing replacement content. Recommend; do not rewrite.',
      'Judging other layers (a cross-layer audit is a separate run type).',
      'Softening a verdict because the document was expensive to produce.',
    ],
    questions: (ctx) => [
      `What was ${ctx.names.canonicalName} supposed to deliver, and which parts of that are missing?`,
      'Where does the document contradict itself, and which reading is right?',
      'Which claims are asserted with no mechanism, evidence or source behind them?',
      'Does it duplicate work that its source packet had already settled?',
      'Which documents does it depend on that are not in the packet?',
      'What is the single next action that would move this layer forward?',
    ],
    output: (ctx) => [
      'Write the findings as prose first: what you checked, what you found, and how confident you are.',
      `Then return one JSON object, in a fenced \`\`\`json block, with exactly these keys: verdict, summary, failures, missingDocuments, requiredResearchRuns, requiredPatches, synthesisRequired, freezeEligible, nextVersion, nextAction, confidence.`,
      `verdict must be exactly one of: ${AUDIT_VERDICTS.join(', ')}.`,
      'failures, missingDocuments, requiredResearchRuns and requiredPatches are arrays of strings; synthesisRequired and freezeEligible are booleans; confidence is a number between 0 and 1.',
      `Name any missing document by its canonical name (for example "${buildCanonicalName(ctx.layer.name, ctx.policy.foundationVersion)}"), never by a description, because the platform resolves those names against its database.`,
      'The JSON is the record the platform stores. Prose alone is not an audit.',
    ],
    duplication: () => [
      'Report on the documents listed above; do not rewrite them, and do not restate their content back as if it were a finding.',
    ],
  },

  REDO: {
    methodology: [
      'A REDO run is a fresh attempt at a target whose previous attempt failed. It is not a patch of the failed text and it is not a new sibling version: the target version is unchanged, and the earlier attempt is kept as history but must not be reused.',
      'Start again from the source packet. Treat the recorded failure as a hard constraint on this attempt: the defect that sank the previous attempt must be impossible to find in this one.',
    ],
    objective: (ctx) =>
      `Produce ${ctx.names.canonicalName} again, from the source packet, correcting every defect recorded against the previous attempt. The target version does not change.`,
    inScope: (ctx) => [
      `The whole of ${ctx.names.canonicalName}, produced again from the source packet.`,
      'Explicit, checkable coverage of every recorded failure.',
      'The same scope the original attempt was given — no wider, no narrower.',
    ],
    outOfScope: () => [
      'Reusing, quoting or lightly editing the failed attempt.',
      'Changing the target version to sidestep the failure.',
      'Treating a recorded failure as a matter of taste and ignoring it.',
    ],
    questions: () => [
      'What exactly failed in the previous attempt — a missing section, an unsupported claim, a naming error, or a misread of the packet?',
      'What structural choice in this attempt makes that failure impossible rather than merely unlikely?',
      'Which parts of the packet did the previous attempt under-use, and what do they yield when used properly?',
      'What would an auditor look at first to check that the failure is really gone?',
    ],
    output: () => [
      'Open with one paragraph stating how this attempt differs from the failed one, in terms of the recorded failure.',
      'Deliver the complete target document, not a diff against the previous attempt.',
    ],
    duplication: () => [
      'Do not re-derive the documents listed above, and do not carry over text from the failed attempt. This is a new attempt, written from the packet.',
    ],
  },

  CROSS_LAYER_AUDIT: {
    methodology: [
      'A CROSS_LAYER_AUDIT run checks this layer against the rest of the project. You are looking for three things: claims in this layer that contradict another layer, concepts that two layers both claim to own, and gaps that fall between layers because each assumed the other covered them.',
      'As with any audit, the output is a verdict on work that already exists, not new research.',
    ],
    objective: (ctx) =>
      `Audit ${ctx.names.canonicalName} against the other layers of ${ctx.project.name} and report every contradiction, duplicated ownership and gap between layers.`,
    inScope: (ctx) => [
      `Contradictions between ${ctx.layer.name} and any other layer of ${ctx.project.name}.`,
      'Concepts owned by two layers at once, with a recommendation of which layer should own each.',
      'Gaps that fall between layers because each assumed the other handled them.',
      'Vocabulary drift: the same term used differently in different layers.',
    ],
    outOfScope: () => [
      'Rewriting either layer. Recommend; do not rewrite.',
      'New research into any layer.',
    ],
    questions: (ctx) => [
      `Which claims in ${ctx.layer.name} are incompatible with a claim in another layer, and which of the two is better supported?`,
      'Which concept is defined in more than one layer, and where should it live?',
      'What does each neighbouring layer assume this layer provides, and does it actually provide it?',
      'Which terms mean different things in different layers?',
    ],
    output: (ctx) => [
      'Group findings by the other layer involved, and name both documents by canonical name in every finding.',
      `Then return the same structured JSON audit object described for an audit run, with verdict one of: ${AUDIT_VERDICTS.join(', ')}.`,
    ],
    duplication: () => [
      'Report on the documents listed above; do not rewrite or restate them.',
    ],
  },
};

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function waveLegend(policy: VersionPolicy): string {
  const foundation = normalizeVersion(policy.foundationVersion);
  return (
    `Wave 1 lays the foundation document (${foundation}). ` +
    `Wave 2 widens it with sibling expansions (${foundation}${policy.expansionStartBranch}, and onwards). ` +
    `Wave ${policy.synthesisWave} consolidates the packet into the canonical synthesis (${synthesisVersion(policy)}), which is then audited and frozen.`
  );
}

function layerSequence(ctx: PromptContext): string {
  const width = ctx.layers.reduce((max, layer) => Math.max(max, layer.name.length), 0);
  return ctx.layers
    .map((layer, index) => {
      const marker = layer.id === ctx.layer.id ? '  <-- this run' : '';
      const parked = layer.parked ? ' (parked)' : '';
      return `  ${index + 1}. ${layer.name.padEnd(width)}  ${layer.status}${parked}${marker}`;
    })
    .join('\n');
}

function projectContextSection(ctx: PromptContext): PromptSection {
  const position = ctx.layers.findIndex((layer) => layer.id === ctx.layer.id) + 1;
  const rows: [string, string][] = [['Project', ctx.project.name]];
  if (ctx.project.description) rows.push(['Description', ctx.project.description]);
  if (ctx.project.northStar) rows.push(['North star', ctx.project.northStar]);
  rows.push(['Current wave', String(ctx.project.currentWave)]);
  rows.push([
    'This run',
    `layer ${position || ctx.layers.length} of ${ctx.layers.length}: ${ctx.layer.name}`,
  ]);

  return section(
    'PROJECT_CONTEXT',
    blocks(
      labelled(rows),
      waveLegend(ctx.policy),
      `${ctx.project.name} is built as an ordered stack of research layers. Each layer is researched to a foundation document, widened by sibling expansions, audited, consolidated into one canonical document, and then frozen. The layers, in order:`,
      layerSequence(ctx),
      `You are working inside exactly one of those layers. Everything you produce must serve the project's north star and must stay inside the layer named above.`,
    ),
  );
}

function describeDocument(document: Document): string {
  const flags: string[] = [document.documentType, document.status];
  if (document.isCanonical) flags.push('canonical');
  if (document.frozen) flags.push('frozen');
  if (document.fileMissing) flags.push('FILE MISSING');
  return `${document.canonicalName} [${flags.join(', ')}]`;
}

function layerContextSection(ctx: PromptContext): PromptSection {
  const position = ctx.layers.findIndex((layer) => layer.id === ctx.layer.id) + 1;
  const expected = expectedVersions(ctx);
  const present = packetVersions(ctx);
  const missing = expected.filter((version) => !present.includes(version));

  const rows: [string, string][] = [
    ['Layer', `${ctx.layer.name} (layer ${position || ctx.layers.length} of ${ctx.layers.length})`],
    [
      'Status',
      ctx.layer.statusSource === 'MANUAL'
        ? `${ctx.layer.status} (pinned by a human${ctx.layer.manualStatusReason ? `: ${ctx.layer.manualStatusReason}` : ''})`
        : `${ctx.layer.status} (derived from the project database)`,
    ],
    ['Target of this run', `${ctx.names.canonicalName} (wave ${waveForVersion(ctx.targetVersion, ctx.policy)})`],
  ];
  if (ctx.layer.currentVersion) rows.push(['Newest version on file', ctx.layer.currentVersion]);
  if (expected.length > 0) {
    rows.push(['Expected version set', expected.join(', ')]);
    rows.push(['Still missing', missing.length > 0 ? missing.join(', ') : 'nothing — the set is complete']);
  }
  if (ctx.layer.parked) {
    rows.push(['Parked', ctx.layer.parkedNote ?? 'yes']);
  }

  const purpose =
    ctx.layer.notes ??
    `The ${ctx.layer.name} layer holds everything ${ctx.project.name} believes about ${ctx.layer.name.toLowerCase()}. Any claim the project makes on this subject must be traceable to a document in this layer.`;

  const inventory =
    ctx.documents.length === 0
      ? 'No documents are registered in this layer yet. This run is its first entry.'
      : blocks('Documents already registered in this layer:', bullets(ctx.documents.map(describeDocument)));

  return section('LAYER_CONTEXT', blocks(labelled(rows), `Purpose: ${purpose}`, inventory));
}

function runTypeSection(ctx: PromptContext): PromptSection {
  const playbook = PLAYBOOKS[ctx.runType];
  const naming =
    ctx.runType === 'AUDIT' || ctx.runType === 'CROSS_LAYER_AUDIT'
      ? 'The naming block at the end of this prompt names the document UNDER AUDIT. Refer to it by exactly that name, and give this conversation exactly that title, so the platform can file your verdict against the right document.'
      : null;

  return section(
    'RUN_TYPE',
    blocks(
      labelled([
        ['Run type', ctx.runType],
        ['Target', `${ctx.names.canonicalName} (${ctx.targetVersion})`],
        ['Source documents', String(ctx.requiredDocuments.length)],
      ]),
      ...playbook.methodology,
      naming,
    ),
  );
}

/** Audits report on a document instead of producing one, so they are filed differently. */
function isVerdictRun(runType: RunType): boolean {
  return runType === 'AUDIT' || runType === 'CROSS_LAYER_AUDIT';
}

function objectiveSection(ctx: PromptContext, override: string | null | undefined): PromptSection {
  const objective = override?.trim() || PLAYBOOKS[ctx.runType].objective(ctx);
  const rows: [string, string][] = isVerdictRun(ctx.runType)
    ? [
        ['Deliverable', `one audit of "${ctx.names.canonicalName}", ending in the structured JSON verdict`],
        ['Document under audit', `${ctx.names.canonicalName} (${ctx.targetVersion})`],
        ['Conversation title', ctx.names.conversationTitle],
      ]
    : ctx.runType === 'PATCH'
      ? [
          ['Deliverable', `one patch against "${ctx.names.canonicalName}", and nothing else`],
          ['Document being patched', `${ctx.names.canonicalName} (${ctx.targetVersion})`],
          ['Conversation title', ctx.names.conversationTitle],
        ]
      : [
          ['Deliverable', `one document, titled exactly "${ctx.names.canonicalName}"`],
          ['Target version', `${ctx.targetVersion} (fixed by the platform, not negotiable)`],
          ['Filename', ctx.names.filename],
        ];
  return section('OBJECTIVE', blocks(objective, labelled(rows)));
}

function sourcePacketSection(ctx: PromptContext): PromptSection {
  if (ctx.requiredDocuments.length === 0) {
    return section(
      'SOURCE_PACKET',
      blocks(
        'No prior documents feed this run: there is nothing in this layer to consume yet.',
        'Work from the project context above and from your own research. Do not cite documents from this project that are not listed anywhere in this prompt — they do not exist, and a fabricated citation is a hard audit failure.',
      ),
    );
  }

  const missingNote =
    ctx.packet.missing.length > 0
      ? `Not yet available: ${ctx.packet.missing.join(', ')}. Do not invent the contents of a document you were not given. Where a conclusion would depend on one of them, mark that conclusion provisional and name the missing document.`
      : null;
  const inconsistentNote =
    ctx.packet.inconsistent.length > 0
      ? `Registered but the file is missing on disk: ${ctx.packet.inconsistent.join(', ')}. Treat these as unavailable until the file is restored.`
      : null;

  return section(
    'SOURCE_PACKET',
    blocks(
      `These ${count(ctx.requiredDocuments.length, 'document')} are the source packet for this run. Packet status right now: ${ctx.packet.summary}.`,
      bullets(ctx.requiredDocuments),
      'Consume them; do not restate them. Before you write anything, read each one and establish three things: what it already covers, what vocabulary it fixes, and where its coverage stops.',
      'Your output is judged on what it adds to this packet. A paragraph that re-explains something the packet already says is a defect, not a contribution. When you build on a source, cite it by its canonical name in one line and move on.',
      missingNote,
      inconsistentNote,
    ),
  );
}

function attachmentAnnotation(item: DependencyCheckItem): string {
  if (item.present) return 'ready to attach';
  if (item.fileMissing) return 'REGISTERED BUT ITS FILE IS MISSING — restore it before running';
  if (item.status) return `registered as ${item.status} — not a finished artifact yet`;
  return 'NOT AVAILABLE — no document with this name is registered';
}

function requiredAttachmentsSection(ctx: PromptContext): PromptSection {
  if (ctx.packet.items.length === 0) {
    return section(
      'REQUIRED_ATTACHMENTS',
      'No attachments are required for this run. Attach nothing else either: an unlisted document changes what this run is.',
    );
  }

  const width = ctx.packet.items.reduce((max, item) => Math.max(max, item.canonicalName.length), 0);
  const checklist = ctx.packet.items.map(
    (item) => `[ ] ${item.canonicalName.padEnd(width)}  (${attachmentAnnotation(item)})`,
  );

  return section(
    'REQUIRED_ATTACHMENTS',
    blocks(
      `Attach exactly ${count(ctx.packet.items.length, 'document')} to this conversation before sending the prompt. Packet status: ${ctx.packet.summary}.`,
      numbered(checklist),
      ctx.packet.ready
        ? 'The packet is complete. Attach all of it — a run started with a partial packet produces a document the audit will send back.'
        : 'The packet is INCOMPLETE. Either produce the missing documents first, or proceed deliberately and state in the output which conclusions are provisional because of the gap.',
    ),
  );
}

function scopeSection(ctx: PromptContext, override: string | null | undefined): PromptSection {
  if (override?.trim()) return section('SCOPE', override.trim());
  const playbook = PLAYBOOKS[ctx.runType];
  return section(
    'SCOPE',
    blocks(
      'IN SCOPE:',
      bullets(playbook.inScope(ctx)),
      'OUT OF SCOPE:',
      bullets(playbook.outOfScope(ctx)),
    ),
  );
}

function researchQuestionsSection(
  ctx: PromptContext,
  override: readonly string[] | null | undefined,
): PromptSection {
  const supplied = (override ?? []).map((question) => question.trim()).filter(Boolean);
  const questions = supplied.length > 0 ? supplied : PLAYBOOKS[ctx.runType].questions(ctx);
  return section(
    'RESEARCH_QUESTIONS',
    blocks(
      'Work through these. They are the spine of the document, not a questionnaire:',
      numbered(questions),
      'Answer them inside the structure of the document. Do not append a question-and-answer section, and do not answer a question you have no evidence for — say what is missing instead.',
    ),
  );
}

function prohibitedDuplicationSection(ctx: PromptContext): PromptSection {
  const covered = unique([
    ...ctx.packetDocuments.map((document) => document.canonicalName),
    ...ctx.requiredDocuments,
  ]).filter((name) => !namesMatch(name, ctx.names.canonicalName));

  if (covered.length === 0) {
    return section(
      'PROHIBITED_DUPLICATION',
      blocks(
        `Nothing has been produced in the ${ctx.layer.name} layer yet, so there is no earlier work of its own to duplicate.`,
        'The cross-layer boundaries below still bind you: material that belongs to another layer is duplication even when this layer is empty.',
      ),
    );
  }

  return section(
    'PROHIBITED_DUPLICATION',
    blocks(
      'The following documents already exist and are treated as covered ground for this run:',
      bullets(covered),
      ...PLAYBOOKS[ctx.runType].duplication(ctx),
    ),
  );
}

function crossLayerBoundariesSection(ctx: PromptContext): PromptSection {
  const others = ctx.layers.filter((layer) => layer.id !== ctx.layer.id);
  if (others.length === 0) {
    return section(
      'CROSS_LAYER_BOUNDARIES',
      `${ctx.layer.name} is currently the only layer in ${ctx.project.name}, so there is no neighbouring layer to trespass on. Still keep the document to this layer's subject.`,
    );
  }

  const frozen = others.filter((layer) => layer.status === 'FROZEN');
  const width = others.reduce((max, layer) => Math.max(max, layer.name.length), 0);

  return section(
    'CROSS_LAYER_BOUNDARIES',
    blocks(
      `${ctx.project.name} is divided into ${count(ctx.layers.length, 'layer')}. These belong to other layers and are OUT OF SCOPE for this run:`,
      bullets(others.map((layer) => `${layer.name.padEnd(width)}  (${layer.status})`)),
      `Where your material touches one of them, state the interface in a single sentence — name the neighbouring layer, say what it owns, and keep your own analysis inside ${ctx.layer.name}.`,
      'Do not define, extend or contradict another layer here. A contradiction across layers is a cross-layer audit finding, and a concept owned by two layers is a defect in both of them.',
      frozen.length > 0
        ? `Layers already FROZEN (${frozen.map((layer) => layer.name).join(', ')}) are settled: you may rely on their conclusions as fixed constraints, but you may not revise them.`
        : null,
    ),
  );
}

async function auditFindingsSection(ctx: PromptContext, auditId: string): Promise<PromptSection> {
  const audit = await getAudit(auditId);
  if (!audit) throw new Error(`Cannot compile a prompt: unknown audit ${auditId}`);

  const group = (type: string): string[] =>
    audit.findings.filter((finding) => finding.findingType === type).map((finding) => finding.content);

  const failures = group('FAILURE');
  const missingDocuments = group('MISSING_DOCUMENT');
  const requiredRuns = group('REQUIRED_RESEARCH_RUN');
  const requiredPatches = group('REQUIRED_PATCH');
  const nextActions = group('NEXT_ACTION');

  const list = (title: string, items: string[]): string | null =>
    items.length === 0 ? null : blocks(title, numbered(items));

  const nothingRecorded =
    failures.length + missingDocuments.length + requiredRuns.length + requiredPatches.length === 0
      ? 'The audit recorded no itemised findings; treat its summary above as the whole of the correction required.'
      : null;

  return section(
    'AUDIT_FINDINGS',
    blocks(
      labelled([
        ['Audit verdict', audit.verdict],
        ['Recorded', audit.createdAt],
        ['Concerning', ctx.names.canonicalName],
      ]),
      `Audit summary: ${audit.summary}`,
      list('Failures that must be fixed:', failures),
      list('Documents the audit found missing:', missingDocuments),
      list('Research runs the audit requires:', requiredRuns),
      list('Patches the audit requires:', requiredPatches),
      list('Next action recorded by the audit:', nextActions.length > 0 ? nextActions : audit.nextAction ? [audit.nextAction] : []),
      nothingRecorded,
      'Fix each numbered item specifically. For every item, the output must contain material a re-audit can point at and mark resolved — an item addressed "in spirit" counts as still open.',
    ),
  );
}

async function previousAttemptSection(ctx: PromptContext, previousRunId: string): Promise<PromptSection> {
  const previous = await getRun(previousRunId);
  if (!previous) throw new Error(`Cannot compile a prompt: unknown run ${previousRunId}`);
  const audit = await getLatestAuditForRun(previous.id);

  const reason =
    previous.failureReason?.trim() ||
    previous.redoReason?.trim() ||
    audit?.summary.trim() ||
    'not recorded — treat the previous attempt as unusable and re-derive from the source packet.';

  const rows: [string, string][] = [
    ['Previous attempt', `attempt ${previous.attemptNumber}, ${previous.runType}, status ${previous.status}`],
    ['Target', previous.targetVersion ? buildCanonicalName(ctx.layer.name, previous.targetVersion) : ctx.names.canonicalName],
    ['Started', previous.startedAt ?? previous.createdAt],
  ];
  if (previous.failedAt) rows.push(['Failed', previous.failedAt]);
  if (previous.completedAt) rows.push(['Completed', previous.completedAt]);
  if (audit) rows.push(['Audit verdict', `${audit.verdict} — ${audit.summary}`]);

  return section(
    'PREVIOUS_ATTEMPT',
    blocks(
      `This run replaces an earlier attempt at ${ctx.names.canonicalName}. The earlier attempt is kept as project history and is not to be reused, quoted or patched.`,
      labelled(rows),
      `Why it failed: ${reason}`,
      'Start again from the source packet. Before you return your answer, read the failure above once more and confirm the same failure cannot be found in what you are about to send.',
    ),
  );
}

function outputRequirementsSection(ctx: PromptContext): PromptSection {
  const header = isVerdictRun(ctx.runType)
    ? `This run produces ONE audit of ${ctx.names.canonicalName}: prose findings followed by the structured verdict the platform stores as data. These requirements are checked when the verdict is recorded:`
    : ctx.runType === 'PATCH'
      ? `This run produces ONE patch against ${ctx.names.canonicalName}, not a replacement document. These requirements are checked before the patch is applied:`
      : 'This run produces ONE document. These requirements are checked by the audit that follows it:';

  const filing = isVerdictRun(ctx.runType)
    ? `The verdict is filed by the platform against "${ctx.names.canonicalName}", so keep that name exact in your report and as the title of this conversation. Do not produce a replacement for the document you are auditing.`
    : ctx.runType === 'PATCH'
      ? `The patch is filed by the platform against "${ctx.names.canonicalName}" in the ${ctx.layer.name} layer of ${ctx.project.name}. Send the patch only; the platform decides where the corrected text lands.`
      : `The document is filed by the platform as "${ctx.names.filename}" under the ${ctx.layer.name} layer of ${ctx.project.name}. Anything you send outside the document itself — commentary, apologies, alternative titles — is discarded.`;

  return section(
    'OUTPUT_REQUIREMENTS',
    blocks(header, bullets([...PLAYBOOKS[ctx.runType].output(ctx), ...SHARED_OUTPUT_RULES]), filing),
  );
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

/**
 * Compile the exact prompt for one run, together with the attachment list the
 * dependency checker validates and the three names the platform will enforce.
 * Pure: it reads state and returns text, and the caller records both on the run
 * (invariant 10).
 */
export async function compilePrompt(input: CompilePromptInput): Promise<CompiledPrompt> {
  const base = await loadLayerContext(input.projectId, input.layerId);
  const runType = input.runType;
  const requestedVersion = input.targetVersion?.trim();
  const targetVersion = normalizeVersion(
    requestedVersion && requestedVersion.length > 0 ? requestedVersion : resolveTargetVersion(base, runType),
  );
  const names = buildNames(base.layer.name, targetVersion);

  const requested = input.requiredDocuments ?? await resolveRequiredDocuments(base, runType, targetVersion);
  // A run never depends on the document it is about to create.
  const requiredDocuments = unique(requested).filter(
    (name) => !(PRODUCING_RUN_TYPES.has(runType) && namesMatch(name, names.canonicalName)),
  );
  const packet = await checkCanonicalNames(base.project.id, requiredDocuments);

  const ctx: PromptContext = {
    ...base,
    runType,
    targetVersion,
    names,
    requiredDocuments: packet.items.map((item) => item.canonicalName),
    packet,
  };

  const built = new Map<PromptSectionKey, PromptSection>();
  built.set('PROJECT_CONTEXT', projectContextSection(ctx));
  built.set('LAYER_CONTEXT', layerContextSection(ctx));
  built.set('RUN_TYPE', runTypeSection(ctx));
  built.set('OBJECTIVE', objectiveSection(ctx, input.objective));
  built.set('SOURCE_PACKET', sourcePacketSection(ctx));
  built.set('REQUIRED_ATTACHMENTS', requiredAttachmentsSection(ctx));
  built.set('SCOPE', scopeSection(ctx, input.scope));
  built.set('RESEARCH_QUESTIONS', researchQuestionsSection(ctx, input.researchQuestions));
  built.set('PROHIBITED_DUPLICATION', prohibitedDuplicationSection(ctx));
  built.set('CROSS_LAYER_BOUNDARIES', crossLayerBoundariesSection(ctx));
  if (input.auditId) built.set('AUDIT_FINDINGS', await auditFindingsSection(ctx, input.auditId));
  if (input.previousRunId) {
    built.set('PREVIOUS_ATTEMPT', await previousAttemptSection(ctx, input.previousRunId));
  }
  built.set('OUTPUT_REQUIREMENTS', outputRequirementsSection(ctx));
  // Section 10 is not optional and is not the model's decision.
  built.set('NAMING_RULES', section('NAMING_RULES', namingRulesBlock(names)));
  built.set('FINAL_NAMING_CHECK', section('FINAL_NAMING_CHECK', finalNamingCheckBlock(names)));

  const sections = SECTION_ORDER.map((key) => built.get(key)).filter(
    (value): value is PromptSection => value !== undefined,
  );

  return {
    prompt: sections.map((part) => `=== ${part.heading} ===\n${part.body}`).join('\n\n'),
    sections,
    requiredAttachments: ctx.requiredDocuments,
    expectedConversationTitle: names.conversationTitle,
    expectedFilename: names.filename,
    targetCanonicalName: names.canonicalName,
    targetVersion,
  };
}

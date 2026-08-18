/**
 * Audit engine (section 12).
 *
 * An audit is never stored as prose (invariant 11): the model's answer is
 * parsed into a `StructuredAuditResult`, normalised, persisted with its
 * findings as rows, and then *acted on* — a REDO verdict creates the redo run,
 * a MISSING_DEPENDENCY verdict materialises the missing documents as
 * dependency rows so the checker keeps reporting them, and every path ends by
 * recomputing derived state so the UI only needs a refresh.
 *
 * Model output is treated as hostile input: it arrives wrapped in fences, with
 * leading prose, trailing commentary, snake_case keys and invented verdicts.
 * Everything here is written to survive that without losing the verdict.
 */
import type {
  Audit,
  AuditVerdict,
  CompiledPrompt,
  Document,
  Layer,
  LayerStateSnapshot,
  Project,
  ResearchRun,
  StructuredAuditResult,
  VersionPolicy,
} from '../domain/types.ts';
import { AUDIT_VERDICTS, DEFAULT_VERSION_POLICY } from '../domain/types.ts';
import { buildCanonicalName, normalizeName } from '../domain/naming.ts';
import {
  extractVersionToken,
  maxVersion,
  nextExpansionVersion,
  normalizeVersion,
  parseVersion,
  synthesisVersion,
} from '../domain/version.ts';
import { getDb } from '../db/database.ts';
import { createAudit } from '../repos/audits.ts';
import {
  createDependency,
  listDependenciesForDocument,
  listDependenciesForRun,
} from '../repos/dependencies.ts';
import {
  findDocumentByCanonicalName,
  getDocument,
  listDocumentsByLayer,
  updateDocument,
} from '../repos/documents.ts';
import { recordEvent } from '../repos/events.ts';
import { getLayer } from '../repos/layers.ts';
import { getProject } from '../repos/projects.ts';
import { createRun, getRun, listRunsByLayer, updateRun } from '../repos/runs.ts';
import { nowIso } from '../repos/util.ts';
import { checkCanonicalNames, setRunDependencies } from './dependencies.ts';
import { freezeLayer } from './freeze.ts';
import { compilePrompt, defaultRequiredDocuments, defaultTargetVersion } from './promptCompiler.ts';
import { canAutoRedo, createRedoRun } from './redoEngine.ts';
import { computeLayerState, recomputeProject } from './stateEngine.ts';

/** Verdicts that accept the audited work as finished. */
const ACCEPTED_VERDICTS: ReadonlySet<AuditVerdict> = new Set<AuditVerdict>([
  'PASS',
  'KEEP',
  'READY_FOR_SYNTHESIS',
  'READY_TO_FREEZE',
]);

/**
 * The section-12 inspection list. It is returned as data (not baked into one
 * prompt string) because the same checklist is shown in the UI, sent to the
 * model, and used as the shape of the findings that come back.
 */
export function auditChecklist(): string[] {
  return [
    'Prompt requirements: was every requirement of the prompt that produced this document actually answered?',
    'Contradictions: does the document contradict itself, or contradict an earlier document in this layer?',
    'Missing sections: is any required section absent, truncated, or left as a placeholder?',
    'Unsupported expansion: are there claims, numbers or conclusions asserted with no stated basis?',
    'Source consumption: was every attached source document actually consumed, or was attached material ignored?',
    'Missing dependencies: did this work need a document it did not have? Name each one by its canonical name.',
    'Version and naming errors: do the title, version string and layer name match the assigned canonical name exactly?',
    'More research: is further research genuinely required, or is this ground already covered by existing documents?',
    'Synthesis justification: is a synthesis justified now, or is the source packet still incomplete?',
    'Freeze readiness: can this layer be frozen — is there one canonical artifact that supersedes the rest?',
  ];
}

// ---------------------------------------------------------------------------
// Tolerant parsing of model output
// ---------------------------------------------------------------------------

/** Every spelling of a verdict we are willing to accept, mapped to a canonical one. */
const VERDICT_ALIASES: Record<string, AuditVerdict> = {
  ...(Object.fromEntries(AUDIT_VERDICTS.map((verdict) => [verdict, verdict])) as Record<
    string,
    AuditVerdict
  >),
  PASSED: 'PASS',
  PASSES: 'PASS',
  OK: 'PASS',
  ACCEPT: 'PASS',
  ACCEPTED: 'PASS',
  APPROVE: 'PASS',
  APPROVED: 'PASS',
  GOOD: 'PASS',
  KEEP_AS_IS: 'KEEP',
  RETAIN: 'KEEP',
  NO_CHANGE: 'KEEP',
  NO_CHANGES: 'KEEP',
  UNCHANGED: 'KEEP',
  PATCH_REQUIRED: 'PATCH',
  NEEDS_PATCH: 'PATCH',
  FIX: 'PATCH',
  AMEND: 'PATCH',
  REVISE: 'PATCH',
  MINOR_FIX: 'PATCH',
  MINOR_FIXES: 'PATCH',
  REDO_REQUIRED: 'REDO',
  RERUN: 'REDO',
  RE_RUN: 'REDO',
  REWRITE: 'REDO',
  FAIL: 'REDO',
  FAILED: 'REDO',
  REJECT: 'REDO',
  REJECTED: 'REDO',
  MISSING_DEPENDENCIES: 'MISSING_DEPENDENCY',
  DEPENDENCY_MISSING: 'MISSING_DEPENDENCY',
  MISSING_DOCUMENT: 'MISSING_DEPENDENCY',
  MISSING_DOCUMENTS: 'MISSING_DEPENDENCY',
  MISSING_SOURCE: 'MISSING_DEPENDENCY',
  MISSING_SOURCES: 'MISSING_DEPENDENCY',
  MISSING_INPUTS: 'MISSING_DEPENDENCY',
  MORE_RESEARCH_REQUIRED: 'MORE_RESEARCH',
  MORE_RESEARCH_NEEDED: 'MORE_RESEARCH',
  NEEDS_MORE_RESEARCH: 'MORE_RESEARCH',
  CONTINUE_RESEARCH: 'MORE_RESEARCH',
  EXPAND: 'MORE_RESEARCH',
  EXPANSION: 'MORE_RESEARCH',
  INCOMPLETE: 'MORE_RESEARCH',
  SYNTHESIS_READY: 'READY_FOR_SYNTHESIS',
  READY_FOR_SYNTHESES: 'READY_FOR_SYNTHESIS',
  SYNTHESIS: 'READY_FOR_SYNTHESIS',
  SYNTHESISE: 'READY_FOR_SYNTHESIS',
  SYNTHESIZE: 'READY_FOR_SYNTHESIS',
  FREEZE: 'READY_TO_FREEZE',
  FREEZE_READY: 'READY_TO_FREEZE',
  FREEZE_ELIGIBLE: 'READY_TO_FREEZE',
  READY_FOR_FREEZE: 'READY_TO_FREEZE',
  CANONICAL: 'READY_TO_FREEZE',
  FINAL: 'READY_TO_FREEZE',
  BLOCK: 'BLOCKED',
  HOLD: 'BLOCKED',
  STOP: 'BLOCKED',
};

/**
 * A negation anywhere in the verdict text disqualifies substring matching.
 * "not ready for synthesis" contains "READY_FOR_SYNTHESIS", and matching it
 * would invert a rejection into an approval that the engine then acts on.
 */
const NEGATION_RE = /(^|_)(NOT|NO|NEVER|CANNOT|CANT|WONT|ISNT|AINT|WITHOUT|FAIL|FAILS|FAILED|UNREADY)(_|$)/;

/** Coerce anything the model said into one of the nine canonical verdicts. */
function coerceVerdict(value: unknown): AuditVerdict {
  const key = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!key) return 'MORE_RESEARCH';
  const exact = VERDICT_ALIASES[key];
  if (exact) return exact;
  // Only an exact alias may express a positive verdict. Anything negated falls
  // back to the safe default rather than being read as its own opposite.
  if (NEGATION_RE.test(key)) return 'MORE_RESEARCH';
  // "the verdict is needs more research" still has to land somewhere sensible:
  // the longest alias contained in the text wins.
  let best: AuditVerdict | null = null;
  let bestLength = 0;
  for (const [alias, verdict] of Object.entries(VERDICT_ALIASES)) {
    if (alias.length > bestLength && key.includes(alias)) {
      best = verdict;
      bestLength = alias.length;
    }
  }
  return best ?? 'MORE_RESEARCH';
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = (raw ?? '').trim();
    if (!value) continue;
    const key = normalizeName(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function splitList(value: string): string[] {
  return value
    .split(/\r?\n|;/)
    .map((line) => line.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0);
}

/** Pull a display string out of whatever the model put in a list slot. */
function toStringItem(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'object') return String(value);
  const record = value as Record<string, unknown>;
  const keys = [
    'content',
    'text',
    'detail',
    'description',
    'finding',
    'title',
    'name',
    'document',
    'canonicalName',
    'canonical_name',
    'item',
    'run',
    'patch',
  ];
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return JSON.stringify(record);
}

function toStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return unique(value.map(toStringItem));
  if (typeof value === 'string') return unique(splitList(value));
  if (typeof value === 'object') {
    return unique(Object.values(value as Record<string, unknown>).map(toStringItem));
  }
  return unique([String(value)]);
}

function toOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'required', 'eligible'].includes(text)) return true;
    if (['false', 'no', 'n', '0', 'none', 'not required', 'not eligible'].includes(text)) return false;
  }
  return null;
}

function toOptionalConfidence(value: unknown): number | null {
  const raw = typeof value === 'string' ? Number(value.replace(/%$/, '')) : value;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const scaled = raw > 1 && raw <= 100 ? raw / 100 : raw;
  return Math.min(1, Math.max(0, scaled));
}

/** Key lookup that ignores case, underscores and spaces. */
function normalizeKeys(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!(normalized in out)) out[normalized] = value;
  }
  return out;
}

function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

const NESTING_KEYS = ['audit', 'auditresult', 'result', 'data', 'output', 'response', 'json'];

/** Locate the object that actually carries the audit fields, unwrapping wrappers. */
function asAuditRecord(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 3 || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = normalizeKeys(value as Record<string, unknown>);
  const signals = [
    'verdict',
    'summary',
    'failures',
    'missingdocuments',
    'requiredresearchruns',
    'requiredpatches',
    'nextaction',
    'nextversion',
    'freezeeligible',
    'synthesisrequired',
  ].filter((key) => normalized[key] !== undefined);
  if (typeof normalized['verdict'] === 'string' || signals.length >= 2) return normalized;
  for (const key of NESTING_KEYS) {
    const nested = asAuditRecord(normalized[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Every balanced `{...}` span in the text, outermost first. */
function braceCandidates(text: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < text.length && out.length < 24; index += 1) {
    if (text[index] !== '{') continue;
    const end = matchingBrace(text, index);
    if (end === -1) continue;
    out.push(text.slice(index, end + 1));
  }
  return out;
}

/** Ordered guesses at where the JSON object is hiding in a model reply. */
function jsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const candidates: string[] = [];
  const fenced = /```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)```/g;
  let match = fenced.exec(trimmed);
  while (match !== null) {
    const body = match[1]?.trim();
    if (body) candidates.push(body);
    match = fenced.exec(trimmed);
  }
  // A reply that opened a fence and never closed it is still worth reading.
  const unterminated = /```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*)$/.exec(trimmed);
  const tail = unterminated?.[1]?.trim();
  if (tail && !candidates.includes(tail)) candidates.push(tail);
  candidates.push(trimmed);
  candidates.push(...braceCandidates(trimmed));
  return candidates;
}

function tryParse(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    // Trailing commas are the single most common way a model breaks JSON.
    const repaired = candidate.replace(/,\s*([}\]])/g, '$1');
    if (repaired === candidate) return null;
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

/** Build a result from an already-located record, without project context. */
function shapeAuditRecord(record: Record<string, unknown>): StructuredAuditResult {
  const nextVersionRaw = pick(record, 'nextversion', 'targetversion', 'version');
  const nextVersionText = typeof nextVersionRaw === 'string' ? nextVersionRaw.trim() : '';
  const nextActionRaw = pick(
    record,
    'nextaction',
    'action',
    'recommendedaction',
    'recommendation',
    'nextstep',
    'nextsteps',
  );
  return {
    verdict: coerceVerdict(pick(record, 'verdict', 'decision', 'outcome', 'status')),
    summary: toStringItem(
      pick(record, 'summary', 'assessment', 'rationale', 'reasoning', 'explanation', 'notes') ?? '',
    ),
    failures: toStringArray(
      pick(record, 'failures', 'failure', 'issues', 'problems', 'errors', 'defects', 'findings'),
    ),
    missingDocuments: toStringArray(
      pick(
        record,
        'missingdocuments',
        'missingdocs',
        'missingdependencies',
        'missingdependency',
        'missinginputs',
        'missing',
      ),
    ),
    requiredResearchRuns: toStringArray(
      pick(
        record,
        'requiredresearchruns',
        'requiredruns',
        'researchruns',
        'requiredresearch',
        'requiredexpansions',
      ),
    ),
    requiredPatches: toStringArray(
      pick(record, 'requiredpatches', 'patches', 'patchesrequired', 'requiredpatch'),
    ),
    synthesisRequired:
      toOptionalBoolean(pick(record, 'synthesisrequired', 'requiressynthesis', 'needssynthesis')) ??
      false,
    freezeEligible:
      toOptionalBoolean(pick(record, 'freezeeligible', 'canfreeze', 'readytofreeze', 'freezable')) ??
      false,
    nextVersion:
      nextVersionText && parseVersion(nextVersionText).valid ? normalizeVersion(nextVersionText) : null,
    nextAction: toStringItem(nextActionRaw ?? ''),
    confidence: toOptionalConfidence(pick(record, 'confidence', 'confidencescore', 'certainty')),
  };
}

/**
 * Extract the structured audit object from arbitrary model text. Tolerates
 * fenced code blocks, leading prose, trailing commentary, snake_case keys and
 * trailing commas. Returns `null` only when nothing audit-shaped is present.
 */
export function parseAuditJson(text: string): StructuredAuditResult | null {
  if (!text || !text.trim()) return null;
  for (const candidate of jsonCandidates(text)) {
    const parsed = tryParse(candidate);
    if (parsed === null) continue;
    const record = asAuditRecord(parsed);
    if (record) return shapeAuditRecord(record);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function deriveNextVersion(
  verdict: AuditVerdict,
  layerVersions: string[],
  policy: VersionPolicy,
  missingDocuments: string[],
): string | null {
  const current = maxVersion(layerVersions);
  switch (verdict) {
    case 'PASS':
    case 'KEEP':
    case 'BLOCKED':
      return null;
    case 'REDO':
    case 'PATCH':
      return current ?? normalizeVersion(policy.foundationVersion);
    case 'MORE_RESEARCH':
      return nextExpansionVersion(layerVersions, policy);
    case 'READY_FOR_SYNTHESIS':
      return synthesisVersion(policy);
    case 'READY_TO_FREEZE':
      return current ?? synthesisVersion(policy);
    case 'MISSING_DEPENDENCY': {
      const first = missingDocuments[0];
      return first ? extractVersionToken(first) : null;
    }
    default:
      return null;
  }
}

function deriveNextAction(
  verdict: AuditVerdict,
  layerName: string,
  nextVersion: string | null,
  result: Pick<StructuredAuditResult, 'missingDocuments' | 'requiredResearchRuns' | 'requiredPatches'>,
): string {
  const target = nextVersion ? buildCanonicalName(layerName, nextVersion) : layerName;
  switch (verdict) {
    case 'PASS':
    case 'KEEP':
      return `No further action is required for ${layerName}.`;
    case 'PATCH': {
      const named = result.requiredPatches.find((entry) => extractVersionToken(entry) !== null);
      return named ? `Patch ${named}.` : `Patch ${target}.`;
    }
    case 'REDO':
      return `Redo ${target}.`;
    case 'MORE_RESEARCH': {
      const named = result.requiredResearchRuns.find((entry) => extractVersionToken(entry) !== null);
      return named ? `Run ${named}.` : `Run ${target}.`;
    }
    case 'READY_FOR_SYNTHESIS':
      return `Run ${target}.`;
    case 'READY_TO_FREEZE':
      return nextVersion ? `Freeze ${layerName} at ${nextVersion}.` : `Freeze ${layerName}.`;
    case 'MISSING_DEPENDENCY': {
      const first = result.missingDocuments[0];
      return first
        ? `Import ${first} before continuing ${layerName}.`
        : `Resolve the missing dependencies for ${layerName}.`;
    }
    case 'BLOCKED':
      return `Resolve what is blocking ${layerName}.`;
    default:
      return `Review ${layerName}.`;
  }
}

/**
 * Fill every array, coerce the verdict, and derive `nextVersion` / `nextAction`
 * when the model omitted them — the planner and the state engine read those two
 * fields directly, so they are never allowed to be empty.
 */
export function normalizeAuditResult(
  input: Partial<StructuredAuditResult> & { verdict: AuditVerdict },
  context: { projectId: string; layerId: string },
): StructuredAuditResult {
  const project = getProject(context.projectId);
  const layer = getLayer(context.layerId);
  const policy: VersionPolicy = project?.versionPolicy ?? DEFAULT_VERSION_POLICY;
  const layerName = layer?.name ?? 'this layer';
  const layerVersions = layer
    ? listDocumentsByLayer(layer.id).map((document) => normalizeVersion(document.version))
    : [];

  const verdict = coerceVerdict(input.verdict);
  const failures = toStringArray(input.failures);
  const missingDocuments = toStringArray(input.missingDocuments);
  const requiredResearchRuns = toStringArray(input.requiredResearchRuns);
  const requiredPatches = toStringArray(input.requiredPatches);

  const rawNextVersion = typeof input.nextVersion === 'string' ? input.nextVersion.trim() : '';
  const nextVersion =
    rawNextVersion && parseVersion(rawNextVersion).valid
      ? normalizeVersion(rawNextVersion)
      : deriveNextVersion(verdict, layerVersions, policy, missingDocuments);

  const rawNextAction = typeof input.nextAction === 'string' ? input.nextAction.trim() : '';
  const nextAction =
    rawNextAction ||
    deriveNextAction(verdict, layerName, nextVersion, {
      missingDocuments,
      requiredResearchRuns,
      requiredPatches,
    });

  const rawSummary = typeof input.summary === 'string' ? input.summary.trim() : '';
  const summary =
    rawSummary ||
    `Audit verdict ${verdict} recorded for ${layerName}${
      failures.length > 0 ? ` with ${failures.length} finding${failures.length === 1 ? '' : 's'}` : ''
    }.`;

  return {
    verdict,
    summary,
    failures,
    missingDocuments,
    requiredResearchRuns,
    requiredPatches,
    synthesisRequired: input.synthesisRequired ?? verdict === 'READY_FOR_SYNTHESIS',
    freezeEligible: input.freezeEligible ?? verdict === 'READY_TO_FREEZE',
    nextVersion,
    nextAction,
    confidence: toOptionalConfidence(input.confidence),
  };
}

// ---------------------------------------------------------------------------
// Recording an audit and applying its consequences
// ---------------------------------------------------------------------------

export interface RecordAuditInput {
  projectId: string;
  layerId: string;
  runId?: string | null;
  auditedDocumentId?: string | null;
  result: Partial<StructuredAuditResult> & { verdict: AuditVerdict };
  source?: string;
}

export interface AuditOutcome {
  audit: Audit;
  layerState: LayerStateSnapshot;
  redoRun: ResearchRun | null;
}

/** The redo cap: an explicit project setting wins, otherwise the version policy. */
function maxAutoRedosFor(project: Project): number {
  const override = Number(project.settings['maxAutoRedos']);
  if (Number.isFinite(override) && override >= 0) return Math.floor(override);
  const policy = Number(project.versionPolicy.maxAutoRedos);
  if (Number.isFinite(policy) && policy >= 0) return Math.floor(policy);
  return DEFAULT_VERSION_POLICY.maxAutoRedos;
}

function isAuditRun(run: ResearchRun): boolean {
  return run.runType === 'AUDIT' || run.runType === 'CROSS_LAYER_AUDIT';
}

/**
 * The run whose *work* was audited. Callers may hand us either the research run
 * or the audit run that inspected it; consequences always land on the research
 * run so a redo is chained to the attempt that actually failed.
 */
function resolveAuditedRun(given: ResearchRun | null): ResearchRun | null {
  if (!given) return null;
  if (isAuditRun(given) && given.parentRunId) return getRun(given.parentRunId) ?? given;
  return given;
}

function resolveAuditedDocument(
  explicitId: string | null | undefined,
  auditedRun: ResearchRun | null,
  layer: Layer,
): Document | null {
  if (explicitId) return getDocument(explicitId);
  if (auditedRun?.targetDocumentId) {
    const target = getDocument(auditedRun.targetDocumentId);
    if (target) return target;
  }
  const version = auditedRun?.targetVersion;
  if (version) {
    return findDocumentByCanonicalName(layer.projectId, buildCanonicalName(layer.name, version));
  }
  return null;
}

interface ConsequenceContext {
  project: Project;
  layer: Layer;
  audit: Audit;
  result: StructuredAuditResult;
  auditedRun: ResearchRun | null;
  auditedDocument: Document | null;
}

interface ConsequenceOutcome {
  redoRun: ResearchRun | null;
  notes: string[];
}

/** Everything an audit verdict changes in the database, in one place. */
function applyConsequences(context: ConsequenceContext): ConsequenceOutcome {
  const { project, layer, audit, result, auditedRun, auditedDocument } = context;
  const notes: string[] = [];
  let redoRun: ResearchRun | null = null;

  if (ACCEPTED_VERDICTS.has(result.verdict)) {
    if (auditedRun) updateRun(auditedRun.id, { status: 'APPROVED' });
    if (
      auditedDocument &&
      auditedDocument.status !== 'COMPLETE' &&
      auditedDocument.status !== 'FROZEN' &&
      auditedDocument.status !== 'SUPERSEDED'
    ) {
      updateDocument(auditedDocument.id, { status: 'COMPLETE' });
      recordEvent({
        projectId: project.id,
        layerId: layer.id,
        entityType: 'DOCUMENT',
        entityId: auditedDocument.id,
        eventType: 'DOCUMENT_COMPLETED',
        payload: { canonicalName: auditedDocument.canonicalName, verdict: result.verdict },
      });
    }
  }

  switch (result.verdict) {
    case 'REDO': {
      const reason =
        result.summary || result.failures[0] || `The audit returned REDO for ${layer.name}.`;
      if (!auditedRun) {
        notes.push(
          'The audit requires a redo but no run was linked to it; start the redo from the layer.',
        );
        break;
      }
      const decision = canAutoRedo(auditedRun.id, maxAutoRedosFor(project));
      if (decision.allowed) {
        redoRun = createRedoRun({
          parentRunId: auditedRun.id,
          auditId: audit.id,
          reason,
          automatic: true,
        });
        notes.push(`Automatic redo created as attempt ${redoRun.attemptNumber}.`);
      } else {
        updateRun(auditedRun.id, {
          status: 'REDO_REQUIRED',
          redoReason: `${reason} ${decision.reason}`,
        });
        notes.push(decision.reason);
      }
      break;
    }
    case 'READY_FOR_SYNTHESIS': {
      recordEvent({
        projectId: project.id,
        layerId: layer.id,
        entityType: 'LAYER',
        entityId: layer.id,
        eventType: 'SYNTHESIS_READY',
        payload: {
          auditId: audit.id,
          nextVersion: result.nextVersion,
          nextAction: result.nextAction,
        },
      });
      notes.push(`${layer.name} is cleared for synthesis.`);
      break;
    }
    case 'READY_TO_FREEZE': {
      // Sections 4, 14 (step 8) and 18 all say the same thing: a synthesis that
      // passes its final audit freezes the layer. Doing it here is what keeps
      // the promise that the event changing reality updates the database — the
      // alternative is the user remembering to press FREEZE afterwards.
      try {
        freezeLayer(layer.id);
        notes.push(
          `${layer.name} passed its final audit and is now frozen` +
            `${result.nextVersion ? ` at ${result.nextVersion}` : ''}.`,
        );
      } catch (error) {
        // Invariant 6: no frozen layer without a canonical artifact. If there is
        // none the audit still stands; the layer simply waits for the document.
        notes.push(
          `${layer.name} is eligible to freeze${result.nextVersion ? ` at ${result.nextVersion}` : ''}, ` +
            `but it cannot be frozen yet: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      break;
    }
    case 'MISSING_DEPENDENCY':
    case 'BLOCKED': {
      const named = unique(result.missingDocuments);
      if (auditedRun) {
        if (named.length > 0) {
          const existing = listDependenciesForRun(auditedRun.id).map(
            (dependency) => dependency.requiredCanonicalName,
          );
          setRunDependencies(auditedRun.id, unique([...existing, ...named]));
        }
        updateRun(auditedRun.id, { status: 'BLOCKED' });
      } else if (auditedDocument && named.length > 0) {
        const existing = new Set(
          listDependenciesForDocument(auditedDocument.id).map((dependency) =>
            normalizeName(dependency.requiredCanonicalName),
          ),
        );
        for (const canonicalName of named) {
          if (existing.has(normalizeName(canonicalName))) continue;
          createDependency({
            projectId: project.id,
            dependentDocumentId: auditedDocument.id,
            requiredCanonicalName: canonicalName,
            dependencyType: 'SOURCE_PACKET',
            required: true,
          });
        }
      }
      if (named.length > 0) {
        const check = checkCanonicalNames(project.id, named);
        if (check.missing.length > 0) {
          recordEvent({
            projectId: project.id,
            layerId: layer.id,
            entityType: 'DEPENDENCY',
            entityId: auditedRun?.id ?? auditedDocument?.id ?? layer.id,
            eventType: 'DEPENDENCY_MISSING',
            payload: {
              auditId: audit.id,
              canonicalNames: check.missing,
              summary: check.summary,
            },
          });
          notes.push(`Missing: ${check.missing.join(', ')}.`);
        }
      }
      break;
    }
    case 'MORE_RESEARCH':
    case 'PATCH': {
      // The attempt itself is finished; the layer simply owes more work.
      if (auditedRun && auditedRun.status === 'AUDIT_REQUIRED') {
        updateRun(auditedRun.id, { status: 'COMPLETE' });
      }
      notes.push(result.nextAction);
      break;
    }
    case 'PASS':
    case 'KEEP':
      break;
    default:
      break;
  }

  return { redoRun, notes };
}

/**
 * Persist an audit with its findings, apply the verdict's consequences, and
 * recompute derived state. This is the only supported way to record an audit.
 */
export function recordAudit(input: RecordAuditInput): AuditOutcome {
  const project = getProject(input.projectId);
  if (!project) throw new Error(`Cannot record audit: unknown project ${input.projectId}`);
  const layer = getLayer(input.layerId);
  if (!layer) throw new Error(`Cannot record audit: unknown layer ${input.layerId}`);

  const result = normalizeAuditResult(input.result, {
    projectId: input.projectId,
    layerId: input.layerId,
  });

  const db = getDb();
  const persisted = db.transaction((): { audit: Audit; redoRun: ResearchRun | null } => {
    const givenRun = input.runId ? getRun(input.runId) : null;
    const auditedRun = resolveAuditedRun(givenRun);
    const auditedDocument = resolveAuditedDocument(input.auditedDocumentId, auditedRun, layer);

    const audit = createAudit({
      projectId: input.projectId,
      layerId: input.layerId,
      runId: input.runId ?? null,
      auditedDocumentId: auditedDocument?.id ?? null,
      result,
      source: input.source ?? 'MANUAL',
    });

    // An audit run that produced this verdict has done its job.
    if (givenRun && isAuditRun(givenRun) && givenRun.id !== auditedRun?.id) {
      updateRun(givenRun.id, { status: 'COMPLETE', completedAt: nowIso() });
    }

    const outcome = applyConsequences({
      project,
      layer,
      audit,
      result,
      auditedRun,
      auditedDocument,
    });

    recordEvent({
      projectId: input.projectId,
      layerId: input.layerId,
      entityType: 'AUDIT',
      entityId: audit.id,
      eventType: 'AUDIT_COMPLETED',
      payload: {
        verdict: result.verdict,
        summary: result.summary,
        nextAction: result.nextAction,
        nextVersion: result.nextVersion,
        failures: result.failures.length,
        missingDocuments: result.missingDocuments,
        synthesisRequired: result.synthesisRequired,
        freezeEligible: result.freezeEligible,
        runId: input.runId ?? null,
        auditedDocumentId: auditedDocument?.id ?? null,
        redoRunId: outcome.redoRun?.id ?? null,
        notes: outcome.notes,
        source: input.source ?? 'MANUAL',
      },
    });

    return { audit, redoRun: outcome.redoRun };
  });

  const snapshots = recomputeProject(input.projectId);
  const layerState =
    snapshots.find((snapshot) => snapshot.layerId === input.layerId) ??
    computeLayerState(input.layerId);

  return {
    audit: persisted.audit,
    layerState,
    redoRun: persisted.redoRun ? (getRun(persisted.redoRun.id) ?? persisted.redoRun) : null,
  };
}

// ---------------------------------------------------------------------------
// Audit prompt
// ---------------------------------------------------------------------------

/** The exact JSON object the auditor must return (invariant 11). */
function auditJsonTemplate(): string {
  return JSON.stringify(
    {
      verdict: AUDIT_VERDICTS.join(' | '),
      summary: 'one short paragraph stating what is wrong and what must happen next',
      failures: ['each concrete failure, one per entry'],
      missingDocuments: ['canonical names of documents this work needed but did not have'],
      requiredResearchRuns: ['canonical names of research runs that must happen next'],
      requiredPatches: ['canonical names of documents that need a patch'],
      synthesisRequired: false,
      freezeEligible: false,
      nextVersion: 'v1H',
      nextAction: 'one imperative sentence',
      confidence: 0.8,
    },
    null,
    2,
  );
}

function auditObjective(auditedName: string): string {
  return [
    `Audit ${auditedName} against the prompt that produced it and the source packet attached below.`,
    'You are not writing new research. You are inspecting finished work and returning a verdict.',
    'Answer every item of the inspection checklist explicitly, naming evidence from the document.',
    '',
    'Write your findings as prose, then end your reply with a single JSON object of exactly this shape:',
    auditJsonTemplate(),
    '',
    `"verdict" must be exactly one of: ${AUDIT_VERDICTS.join(', ')}.`,
    '"missingDocuments" must use canonical names such as "Discovery Logic v1G" so the platform can resolve them.',
    '"nextVersion" must be a version string such as v1H or v3.1, or null.',
  ].join('\n');
}

function auditScope(auditedName: string, layerName: string): string {
  return [
    `Only ${auditedName} is under audit.`,
    `Do not audit other layers of the project and do not extend ${layerName} yourself.`,
    'Judge the document only against the attached material and the prompt that produced it — never against material you cannot see.',
    'If a required input was not attached, report it as a missing document rather than inventing its contents.',
  ].join('\n');
}

/** An audit run already open against `run`, so re-compiling stays idempotent. */
function findOpenAuditRun(run: ResearchRun, layerId: string): ResearchRun | null {
  return (
    listRunsByLayer(layerId).find(
      (candidate) =>
        candidate.parentRunId === run.id &&
        (candidate.runType === 'AUDIT' || candidate.runType === 'CROSS_LAYER_AUDIT') &&
        candidate.status !== 'COMPLETE' &&
        candidate.status !== 'APPROVED' &&
        candidate.status !== 'FAILED',
    ) ?? null
  );
}

/**
 * Compile the audit prompt for a completed run and record it (invariant 10).
 *
 * The prompt is stored on a dedicated AUDIT run — a child of the run being
 * audited — rather than overwriting the research prompt that produced the
 * document, because the exact prompt of a finished run is history we must keep.
 * When the caller already hands us an audit run, that run is updated in place.
 */
export function compileAuditPrompt(runId: string): CompiledPrompt {
  const run = getRun(runId);
  if (!run) throw new Error(`Cannot compile an audit prompt: unknown run ${runId}`);
  const layerId = run.layerId;
  if (!layerId) {
    throw new Error(`Cannot compile an audit prompt: run ${runId} is not attached to a layer`);
  }
  const layer = getLayer(layerId);
  if (!layer) throw new Error(`Cannot compile an audit prompt: unknown layer ${layerId}`);

  const version =
    run.targetVersion ?? defaultTargetVersion(run.projectId, layerId, 'AUDIT');
  const auditedName = buildCanonicalName(layer.name, version);
  const packet = unique([
    auditedName,
    ...listDependenciesForRun(run.id).map((dependency) => dependency.requiredCanonicalName),
    ...defaultRequiredDocuments(run.projectId, layerId, 'AUDIT'),
  ]);

  const compiled = compilePrompt({
    projectId: run.projectId,
    layerId,
    runType: 'AUDIT',
    targetVersion: version,
    requiredDocuments: packet,
    previousRunId: run.id,
    objective: auditObjective(auditedName),
    scope: auditScope(auditedName, layer.name),
    researchQuestions: auditChecklist(),
  });

  const db = getDb();
  db.transaction(() => {
    const reused = isAuditRun(run) ? run : findOpenAuditRun(run, layerId);
    const auditRun =
      reused ??
      createRun({
        projectId: run.projectId,
        layerId,
        targetDocumentId: run.targetDocumentId,
        targetVersion: version,
        runType: 'AUDIT',
        attemptNumber: run.attemptNumber,
        status: 'READY',
        provider: run.provider,
        model: run.model,
        parentRunId: run.id,
        conversationId: run.conversationId,
      });

    updateRun(auditRun.id, {
      targetVersion: version,
      status: 'READY',
      prompt: compiled.prompt,
      promptSections: compiled.sections,
      requiredAttachments: compiled.requiredAttachments,
      expectedConversationTitle: compiled.expectedConversationTitle,
      expectedFilename: compiled.expectedFilename,
    });
    setRunDependencies(auditRun.id, packet, { dependencyType: 'AUDIT_INPUT' });

    if (!reused) {
      recordEvent({
        projectId: run.projectId,
        layerId,
        entityType: 'RUN',
        entityId: auditRun.id,
        eventType: 'RUN_CREATED',
        payload: { runType: 'AUDIT', auditedRunId: run.id, targetVersion: version },
      });
    }
    recordEvent({
      projectId: run.projectId,
      layerId,
      entityType: 'RUN',
      entityId: auditRun.id,
      eventType: 'RUN_PROMPT_COMPILED',
      payload: {
        runType: 'AUDIT',
        auditedRunId: run.id,
        auditedDocument: auditedName,
        targetVersion: version,
        requiredAttachments: compiled.requiredAttachments,
        checklist: auditChecklist().length,
      },
    });

    // The audited run is now waiting for a verdict rather than simply finished.
    if (!isAuditRun(run) && (run.status === 'COMPLETE' || run.status === 'RUNNING')) {
      updateRun(run.id, { status: 'AUDIT_REQUIRED' });
    }
  });

  recomputeProject(run.projectId);
  return compiled;
}

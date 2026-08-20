/**
 * Zero-trust parsing of model output (section 20).
 *
 * Model prose never mutates project state. Everything a pass returns is parsed
 * as strict JSON and validated against exact enum membership: no substring
 * matching, no negation handling, no "closest verdict", no template
 * placeholders, no inferred approval. Anything that does not validate is an
 * audit FAILURE, which leaves the project exactly as it was.
 *
 * The older `parseAuditJson` in auditEngine.ts remains for hand-pasted audits,
 * where a human is reading the result before it lands. This module is the path
 * a model's own output takes, and it is deliberately less forgiving.
 */
import {
  ASSIGNMENT_VERDICTS,
  AUDIT_VERDICTS,
  CONSISTENCY_RELATIONS,
  GAP_CLASSIFICATIONS,
  type AssignmentVerdict,
  type AuditVerdict,
  type ConsistencyRelation,
  type GapClassification,
} from '../../domain/types.ts';

export class AuditValidationError extends Error {
  readonly rawResponse: string;
  readonly reason: string;

  constructor(reason: string, rawResponse: string) {
    super(reason);
    this.name = 'AuditValidationError';
    this.reason = reason;
    this.rawResponse = rawResponse;
  }
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Phrases that only ever appear in the instructions we sent, never in a real
 * answer. A model that echoes the template back must not have that echo stored
 * as a verdict.
 */
const TEMPLATE_MARKERS = [
  'one imperative sentence',
  'each concrete failure',
  'one per entry',
  'one short paragraph',
  'exactly this shape',
  'fill this in',
  'your answer here',
  '<verdict>',
  '...',
];

/**
 * A value naming several enum members at once is a menu, not a decision.
 *
 * A member that is merely a substring of another matched member does not count:
 * "MISMATCH" contains "MATCH" by spelling, not by meaning, and reading that as
 * two answers would reject a perfectly clear one. Only members that survive that
 * test are treated as separately named.
 */
function namesMultipleMembers(value: string, members: readonly string[]): boolean {
  const upper = value.toUpperCase();
  const matched = members.filter((member) => upper.includes(member));
  const distinct = matched.filter(
    (member) => !matched.some((other) => other !== member && other.includes(member)),
  );
  return distinct.length > 1;
}

export function looksLikeTemplate(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (lower.length === 0) return true;
  return TEMPLATE_MARKERS.some((marker) => lower === marker || lower.includes(marker));
}

/**
 * Extract one JSON object from a model reply.
 *
 * Only two shapes are accepted: the whole reply is JSON, or the reply ends with
 * a fenced block. The LAST fenced block wins, because every pass prompt asks the
 * model to finish with its JSON — an earlier block is usually our own template
 * being quoted back.
 */
export function extractJsonObject(text: string): ParseResult<Record<string, unknown>> {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { ok: false, error: 'The model returned an empty response.' };

  const candidates: string[] = [];
  const fenced = /```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)```/g;
  const bodies: string[] = [];
  let match = fenced.exec(trimmed);
  while (match !== null) {
    const body = match[1]?.trim();
    if (body) bodies.push(body);
    match = fenced.exec(trimmed);
  }
  candidates.push(...bodies.reverse());
  candidates.push(trimmed);

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, value: parsed as Record<string, unknown> };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return {
    ok: false,
    error: 'The model did not return a JSON object (expected the reply to end with a JSON block).',
  };
}

/** Exact, case-sensitive-after-trim enum membership. Nothing else is accepted. */
export function strictEnum<T extends string>(
  value: unknown,
  members: readonly T[],
  field: string,
): ParseResult<T> {
  if (typeof value !== 'string') {
    return { ok: false, error: `"${field}" must be a string naming one of: ${members.join(', ')}.` };
  }
  const trimmed = value.trim();
  if (looksLikeTemplate(trimmed)) {
    return { ok: false, error: `"${field}" still contains the template placeholder, not an answer.` };
  }
  if (namesMultipleMembers(trimmed, members)) {
    return {
      ok: false,
      error: `"${field}" names more than one value ("${trimmed}"), which is a menu rather than a decision.`,
    };
  }
  const upper = trimmed.toUpperCase();
  const found = members.find((member) => member === upper);
  if (!found) {
    return {
      ok: false,
      error: `"${field}" was "${trimmed}", which is not one of: ${members.join(', ')}.`,
    };
  }
  return { ok: true, value: found };
}

/*
 * The validators below are the strict-parsing vocabulary, exported because the
 * research passes parse model output under exactly the same rules. Sharing them
 * is the point: two definitions of "a required string" would eventually disagree
 * about what a model is allowed to get away with.
 */

export function stringField(
  value: unknown,
  field: string,
  options: { required?: boolean } = {},
): ParseResult<string> {
  if (value === undefined || value === null) {
    if (options.required) return { ok: false, error: `"${field}" is required.` };
    return { ok: true, value: '' };
  }
  if (typeof value !== 'string') return { ok: false, error: `"${field}" must be a string.` };
  const trimmed = value.trim();
  if (options.required && trimmed.length === 0) {
    return { ok: false, error: `"${field}" is required and was empty.` };
  }
  if (options.required && looksLikeTemplate(trimmed)) {
    return { ok: false, error: `"${field}" still contains the template placeholder, not an answer.` };
  }
  return { ok: true, value: trimmed };
}

export function stringArray(value: unknown, field: string): ParseResult<string[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: `"${field}" must be an array of strings.` };
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return { ok: false, error: `"${field}" must contain only strings.` };
    const trimmed = entry.trim();
    if (trimmed.length === 0 || looksLikeTemplate(trimmed)) continue;
    out.push(trimmed);
  }
  return { ok: true, value: out };
}

export function booleanField(value: unknown, field: string): ParseResult<boolean> {
  if (value === undefined || value === null) return { ok: true, value: false };
  if (typeof value !== 'boolean') {
    // "true" as a string is a model being sloppy; accepting it is how inference
    // creeps in. Refuse.
    return { ok: false, error: `"${field}" must be a JSON boolean, not ${JSON.stringify(value)}.` };
  }
  return { ok: true, value };
}

export function confidenceField(value: unknown): ParseResult<number | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: '"confidence" must be a number between 0 and 1.' };
  }
  if (value < 0 || value > 1) return { ok: false, error: '"confidence" must be between 0 and 1.' };
  return { ok: true, value };
}

export function nonNegativeInteger(value: unknown, field: string): ParseResult<number> {
  if (value === undefined || value === null) return { ok: true, value: 0 };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { ok: false, error: `"${field}" must be a non-negative integer.` };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Pass outputs
// ---------------------------------------------------------------------------

export interface ParsedGap {
  classification: GapClassification;
  title: string;
  detail: string;
  owningLayerName: string | null;
  justification: string;
  researchQuestion: string | null;
  expectedContribution: string | null;
}

export interface PrimaryPassOutput {
  assignmentSatisfied: AssignmentVerdict;
  requirementFindings: string[];
  structuralFindings: string[];
  boundaryFindings: string[];
  consistencyFindings: { relation: ConsistencyRelation; detail: string }[];
  candidateGaps: ParsedGap[];
  notes: string;
}

export interface AdversarialAttack {
  attack: string;
  material: boolean;
  reasoning: string;
}

export interface AdversarialPassOutput {
  attacks: AdversarialAttack[];
  strongestReasonNotToAdvance: string;
}

export interface JudgePassOutput {
  verdict: AuditVerdict;
  summary: string;
  gapClassifications: ParsedGap[];
  requiredPatches: string[];
  otherLayerHandoffs: string[];
  blockingDependencies: string[];
  synthesisReady: boolean;
  freezeReady: boolean;
  confidence: number | null;
  nextAction: string;
  /** Reported by the model; recomputed from gaps and cross-checked. */
  foundationalGapCount: number;
  targetedResearchRunsRequired: number;
}

function parseGap(value: unknown, index: number): ParseResult<ParsedGap> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: `gap_classifications[${index}] must be an object.` };
  }
  const record = value as Record<string, unknown>;
  const classification = strictEnum<GapClassification>(
    record['classification'],
    GAP_CLASSIFICATIONS,
    `gap_classifications[${index}].classification`,
  );
  if (!classification.ok) return classification;

  const title = stringField(record['title'], `gap_classifications[${index}].title`, { required: true });
  if (!title.ok) return title;

  const detail = stringField(record['detail'], `gap_classifications[${index}].detail`);
  if (!detail.ok) return detail;

  const justification = stringField(
    record['justification'],
    `gap_classifications[${index}].justification`,
  );
  if (!justification.ok) return justification;

  const owningLayer = stringField(record['owning_layer'], `gap_classifications[${index}].owning_layer`);
  if (!owningLayer.ok) return owningLayer;

  const researchQuestion = stringField(
    record['research_question'],
    `gap_classifications[${index}].research_question`,
  );
  if (!researchQuestion.ok) return researchQuestion;

  const expectedContribution = stringField(
    record['expected_contribution'],
    `gap_classifications[${index}].expected_contribution`,
  );
  if (!expectedContribution.ok) return expectedContribution;

  // A gap routed to another layer has to say which one, or it is not a handoff.
  if (classification.value === 'OTHER_LAYER' && owningLayer.value.length === 0) {
    return {
      ok: false,
      error: `gap_classifications[${index}] is OTHER_LAYER but names no owning_layer.`,
    };
  }
  // A gap that keeps the layer open has to state the question it would answer.
  if (classification.value === 'TARGETED_RESEARCH_GAP' && researchQuestion.value.length === 0) {
    return {
      ok: false,
      error:
        `gap_classifications[${index}] is TARGETED_RESEARCH_GAP but states no research_question. ` +
        'A research run needs a specific unresolved question.',
    };
  }

  return {
    ok: true,
    value: {
      classification: classification.value,
      title: title.value,
      detail: detail.value,
      owningLayerName: owningLayer.value || null,
      justification: justification.value,
      researchQuestion: researchQuestion.value || null,
      expectedContribution: expectedContribution.value || null,
    },
  };
}

function parseGapList(value: unknown, field: string): ParseResult<ParsedGap[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: `"${field}" must be an array.` };
  const out: ParsedGap[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = parseGap(entry, index);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return { ok: true, value: out };
}

export function parsePrimaryPass(text: string): ParseResult<PrimaryPassOutput> {
  const json = extractJsonObject(text);
  if (!json.ok) return json;
  const record = json.value;

  const assignment = strictEnum<AssignmentVerdict>(
    record['assignment_satisfied'],
    ASSIGNMENT_VERDICTS,
    'assignment_satisfied',
  );
  if (!assignment.ok) return assignment;

  const requirement = stringArray(record['requirement_findings'], 'requirement_findings');
  if (!requirement.ok) return requirement;
  const structural = stringArray(record['structural_findings'], 'structural_findings');
  if (!structural.ok) return structural;
  const boundary = stringArray(record['boundary_findings'], 'boundary_findings');
  if (!boundary.ok) return boundary;
  const gaps = parseGapList(record['candidate_gaps'], 'candidate_gaps');
  if (!gaps.ok) return gaps;
  const notes = stringField(record['notes'], 'notes');
  if (!notes.ok) return notes;

  const consistencyRaw = record['consistency_findings'];
  const consistency: { relation: ConsistencyRelation; detail: string }[] = [];
  if (Array.isArray(consistencyRaw)) {
    for (const [index, entry] of consistencyRaw.entries()) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return { ok: false, error: `consistency_findings[${index}] must be an object.` };
      }
      const item = entry as Record<string, unknown>;
      const relation = strictEnum<ConsistencyRelation>(
        item['relation'],
        CONSISTENCY_RELATIONS,
        `consistency_findings[${index}].relation`,
      );
      if (!relation.ok) return relation;
      const detail = stringField(item['detail'], `consistency_findings[${index}].detail`);
      if (!detail.ok) return detail;
      consistency.push({ relation: relation.value, detail: detail.value });
    }
  } else if (consistencyRaw !== undefined && consistencyRaw !== null) {
    return { ok: false, error: '"consistency_findings" must be an array.' };
  }

  return {
    ok: true,
    value: {
      assignmentSatisfied: assignment.value,
      requirementFindings: requirement.value,
      structuralFindings: structural.value,
      boundaryFindings: boundary.value,
      consistencyFindings: consistency,
      candidateGaps: gaps.value,
      notes: notes.value,
    },
  };
}

export function parseAdversarialPass(text: string): ParseResult<AdversarialPassOutput> {
  const json = extractJsonObject(text);
  if (!json.ok) return json;
  const record = json.value;

  const raw = record['attacks'];
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    return { ok: false, error: '"attacks" must be an array.' };
  }
  const attacks: AdversarialAttack[] = [];
  for (const [index, entry] of (Array.isArray(raw) ? raw : []).entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `attacks[${index}] must be an object.` };
    }
    const item = entry as Record<string, unknown>;
    const attack = stringField(item['attack'], `attacks[${index}].attack`, { required: true });
    if (!attack.ok) return attack;
    // VALID / NOT_MATERIAL is a decision, so it is a strict enum too.
    const verdict = strictEnum(item['assessment'], ['VALID', 'NOT_MATERIAL'] as const, `attacks[${index}].assessment`);
    if (!verdict.ok) return verdict;
    const reasoning = stringField(item['reasoning'], `attacks[${index}].reasoning`);
    if (!reasoning.ok) return reasoning;
    attacks.push({ attack: attack.value, material: verdict.value === 'VALID', reasoning: reasoning.value });
  }

  const strongest = stringField(record['strongest_reason_not_to_advance'], 'strongest_reason_not_to_advance');
  if (!strongest.ok) return strongest;

  return { ok: true, value: { attacks, strongestReasonNotToAdvance: strongest.value } };
}

/**
 * The only output that is allowed to change project state, and therefore the
 * strictest. Every enum is exact, the counts must agree with the classified
 * gaps, and an approving verdict is refused outright when a foundational gap is
 * still on the list — approval is never inferred.
 */
export function parseJudgePass(text: string): ParseResult<JudgePassOutput> {
  const json = extractJsonObject(text);
  if (!json.ok) return json;
  const record = json.value;

  const verdict = strictEnum<AuditVerdict>(record['verdict'], AUDIT_VERDICTS, 'verdict');
  if (!verdict.ok) return verdict;

  const summary = stringField(record['summary'], 'summary', { required: true });
  if (!summary.ok) return summary;

  const nextAction = stringField(record['next_action'], 'next_action', { required: true });
  if (!nextAction.ok) return nextAction;

  const gaps = parseGapList(record['gap_classifications'], 'gap_classifications');
  if (!gaps.ok) return gaps;

  const patches = stringArray(record['required_patches'], 'required_patches');
  if (!patches.ok) return patches;
  const handoffs = stringArray(record['other_layer_handoffs'], 'other_layer_handoffs');
  if (!handoffs.ok) return handoffs;
  const blocking = stringArray(record['blocking_dependencies'], 'blocking_dependencies');
  if (!blocking.ok) return blocking;

  const synthesisReady = booleanField(record['synthesis_ready'], 'synthesis_ready');
  if (!synthesisReady.ok) return synthesisReady;
  const freezeReady = booleanField(record['freeze_ready'], 'freeze_ready');
  if (!freezeReady.ok) return freezeReady;

  const confidence = confidenceField(record['confidence']);
  if (!confidence.ok) return confidence;

  const declaredFoundational = nonNegativeInteger(
    record['foundational_gap_count'],
    'foundational_gap_count',
  );
  if (!declaredFoundational.ok) return declaredFoundational;
  const declaredTargeted = nonNegativeInteger(
    record['targeted_research_runs_required'],
    'targeted_research_runs_required',
  );
  if (!declaredTargeted.ok) return declaredTargeted;

  const actualFoundational = gaps.value.filter((gap) => gap.classification === 'FOUNDATIONAL_GAP').length;
  const actualTargeted = gaps.value.filter((gap) => gap.classification === 'TARGETED_RESEARCH_GAP').length;

  // The counts are a cross-check, not decoration: a judge that says "0 gaps"
  // while listing three is not producing a usable decision.
  if (declaredFoundational.value !== actualFoundational) {
    return {
      ok: false,
      error:
        `"foundational_gap_count" is ${declaredFoundational.value} but ${actualFoundational} gap(s) ` +
        'are classified FOUNDATIONAL_GAP.',
    };
  }
  if (declaredTargeted.value !== actualTargeted) {
    return {
      ok: false,
      error:
        `"targeted_research_runs_required" is ${declaredTargeted.value} but ${actualTargeted} gap(s) ` +
        'are classified TARGETED_RESEARCH_GAP.',
    };
  }

  // Approval is never inferred: an advancing verdict cannot coexist with an
  // unresolved gap the profile says justifies research.
  const openResearchGaps = actualFoundational + actualTargeted;
  const ADVANCING: AuditVerdict[] = ['PASS', 'KEEP', 'READY_FOR_SYNTHESIS', 'READY_TO_FREEZE'];
  if (ADVANCING.includes(verdict.value) && openResearchGaps > 0) {
    return {
      ok: false,
      error:
        `verdict "${verdict.value}" advances the layer while ${openResearchGaps} unresolved ` +
        'foundational or targeted research gap(s) remain.',
    };
  }
  if ((synthesisReady.value || freezeReady.value) && openResearchGaps > 0) {
    return {
      ok: false,
      error: 'synthesis_ready/freeze_ready cannot be true while foundational research remains open.',
    };
  }
  // MORE_RESEARCH has to say what to research.
  if (verdict.value === 'MORE_RESEARCH' && openResearchGaps === 0) {
    return {
      ok: false,
      error:
        'verdict "MORE_RESEARCH" requires at least one FOUNDATIONAL_GAP or TARGETED_RESEARCH_GAP ' +
        'naming the unresolved question.',
    };
  }
  // BLOCKED has to say what is missing.
  if (verdict.value === 'BLOCKED' && blocking.value.length === 0) {
    return {
      ok: false,
      error: 'verdict "BLOCKED" requires at least one entry in "blocking_dependencies".',
    };
  }

  return {
    ok: true,
    value: {
      verdict: verdict.value,
      summary: summary.value,
      gapClassifications: gaps.value,
      requiredPatches: patches.value,
      otherLayerHandoffs: handoffs.value,
      blockingDependencies: blocking.value,
      synthesisReady: synthesisReady.value,
      freezeReady: freezeReady.value,
      confidence: confidence.value,
      nextAction: nextAction.value,
      foundationalGapCount: actualFoundational,
      targetedResearchRunsRequired: actualTargeted,
    },
  };
}

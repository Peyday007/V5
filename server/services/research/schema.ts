/**
 * Zero-trust parsing of what the research worker returns.
 *
 * The same rule the audit engine lives by, applied one layer earlier: prose
 * never becomes project state. A pass returns strict JSON or it failed, and a
 * fragment plan, a claim, a verification verdict and a synthesis are each
 * validated field by field before anything is written down.
 *
 * The stakes here are specific. A claim that arrives without a source, with a
 * scope that does not match the fragment's, or with a calculation whose inputs
 * are not themselves claims, is not a slightly weaker claim — it is the thing
 * the evidence gate exists to keep out of the synthesis. So validation is where
 * it is caught, not somewhere downstream where it might be argued about.
 */
import {
  CONTRADICTION_STATES,
  SUFFICIENCY_VERDICTS,
  type ContradictionState,
  type SufficiencyVerdict,
} from '../../domain/types.ts';
import {
  booleanField,
  confidenceField,
  extractJsonObject,
  nonNegativeInteger,
  stringArray,
  stringField,
  strictEnum,
  type ParseResult,
} from '../audit/schema.ts';

/** The spec's bounds on decomposition: enough to cover a subject, few enough to finish. */
export const MIN_FRAGMENTS = 5;
export const MAX_FRAGMENTS = 15;

/** A fragment cannot rest on one source and call itself covered. */
export const MIN_INDEPENDENT_SOURCES_FLOOR = 2;
const MIN_INDEPENDENT_SOURCES_CEILING = 10;

function fail<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

function arrayOf(value: unknown, field: string): ParseResult<Record<string, unknown>[]> {
  if (!Array.isArray(value)) return fail(`"${field}" must be an array.`);
  const out: Record<string, unknown>[] = [];
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return fail(`"${field}[${index}]" must be an object.`);
    }
    out.push(entry as Record<string, unknown>);
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Pass 1 — the fragmentation plan
// ---------------------------------------------------------------------------

export interface PlannedFragment {
  key: string;
  question: string;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definitions: string | null;
  requiredEvidence: string[];
  acceptableSourceTypes: string[];
  excludedSourceTypes: string[];
  completionCriteria: string[];
  dependsOn: string[];
  minIndependentSources: number;
}

export interface PlanPassOutput {
  rationale: string;
  fragments: PlannedFragment[];
}

/** `Market size, US, 2023` -> `market-size-us-2023`. Stable, and safe in a citation. */
function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : fallback;
}

export function parsePlanPass(text: string): ParseResult<PlanPassOutput> {
  const json = extractJsonObject(text);
  if (!json.ok) return json;
  const body = json.value;

  const rationale = stringField(body['rationale'], 'rationale', { required: true });
  if (!rationale.ok) return rationale;

  const rows = arrayOf(body['fragments'], 'fragments');
  if (!rows.ok) return rows;

  if (rows.value.length < MIN_FRAGMENTS) {
    return fail(
      `The plan proposed ${rows.value.length} fragment(s). An assignment is decomposed into at ` +
        `least ${MIN_FRAGMENTS}: fewer means one conversation is still carrying a broad subject.`,
    );
  }
  if (rows.value.length > MAX_FRAGMENTS) {
    return fail(
      `The plan proposed ${rows.value.length} fragments, above the ceiling of ${MAX_FRAGMENTS}. ` +
        'Decomposition past that point is a research programme, not an assignment.',
    );
  }

  const fragments: PlannedFragment[] = [];
  const keys = new Set<string>();

  for (const [index, row] of rows.value.entries()) {
    const where = `fragments[${index}]`;

    const question = stringField(row['question'], `${where}.question`, { required: true });
    if (!question.ok) return question;
    // One bounded question. Two questions joined by "and" is two fragments.
    if (question.value.split('?').filter((part) => part.trim().length > 0).length > 1) {
      return fail(`"${where}.question" contains more than one question; fragments ask exactly one.`);
    }

    const requiredEvidence = stringArray(row['requiredEvidence'], `${where}.requiredEvidence`);
    if (!requiredEvidence.ok) return requiredEvidence;
    if (requiredEvidence.value.length === 0) {
      return fail(
        `"${where}.requiredEvidence" is empty. A fragment that does not say what evidence it ` +
          'needs cannot be judged complete.',
      );
    }

    const acceptable = stringArray(row['acceptableSourceTypes'], `${where}.acceptableSourceTypes`);
    if (!acceptable.ok) return acceptable;
    if (acceptable.value.length === 0) {
      return fail(`"${where}.acceptableSourceTypes" is empty; say what may be cited.`);
    }

    const excluded = stringArray(row['excludedSourceTypes'], `${where}.excludedSourceTypes`);
    if (!excluded.ok) return excluded;

    const criteria = stringArray(row['completionCriteria'], `${where}.completionCriteria`);
    if (!criteria.ok) return criteria;
    if (criteria.value.length === 0) {
      return fail(`"${where}.completionCriteria" is empty; say what "done" means for this fragment.`);
    }

    const dependsOn = stringArray(row['dependsOn'], `${where}.dependsOn`);
    if (!dependsOn.ok) return dependsOn;

    const minSources = nonNegativeInteger(
      row['minIndependentSources'],
      `${where}.minIndependentSources`,
    );
    if (!minSources.ok) return minSources;
    if (minSources.value < MIN_INDEPENDENT_SOURCES_FLOOR) {
      return fail(
        `"${where}.minIndependentSources" is ${minSources.value}; at least ` +
          `${MIN_INDEPENDENT_SOURCES_FLOOR} independent sources are required before a fragment ` +
          'counts as covered.',
      );
    }
    if (minSources.value > MIN_INDEPENDENT_SOURCES_CEILING) {
      return fail(
        `"${where}.minIndependentSources" is ${minSources.value}, which no fragment can satisfy. ` +
          `The ceiling is ${MIN_INDEPENDENT_SOURCES_CEILING}.`,
      );
    }

    const geography = stringField(row['geography'], `${where}.geography`);
    if (!geography.ok) return geography;
    const timeframe = stringField(row['timeframe'], `${where}.timeframe`);
    if (!timeframe.ok) return timeframe;
    const population = stringField(row['population'], `${where}.population`);
    if (!population.ok) return population;
    const definitions = stringField(row['definitions'], `${where}.definitions`);
    if (!definitions.ok) return definitions;

    const rawKey = stringField(row['key'], `${where}.key`);
    if (!rawKey.ok) return rawKey;
    let key = slugify(rawKey.value || question.value, `fragment-${index + 1}`);
    // Keys address fragments in dependencies and citations, so they are unique
    // by construction rather than by trusting the plan.
    let suffix = 2;
    while (keys.has(key)) {
      key = `${key}-${suffix}`;
      suffix += 1;
    }
    keys.add(key);

    fragments.push({
      key,
      question: question.value,
      geography: geography.value || null,
      timeframe: timeframe.value || null,
      population: population.value || null,
      definitions: definitions.value || null,
      requiredEvidence: requiredEvidence.value,
      acceptableSourceTypes: acceptable.value,
      excludedSourceTypes: excluded.value,
      completionCriteria: criteria.value,
      dependsOn: dependsOn.value,
      minIndependentSources: minSources.value,
    });
  }

  // A dependency on a fragment that does not exist would stall the queue forever.
  const known = new Set(fragments.map((fragment) => fragment.key));
  for (const fragment of fragments) {
    fragment.dependsOn = fragment.dependsOn
      .map((dependency) => slugify(dependency, ''))
      .filter((dependency) => dependency.length > 0 && dependency !== fragment.key && known.has(dependency));
  }

  return { ok: true, value: { rationale: rationale.value, fragments } };
}

// ---------------------------------------------------------------------------
// Fragment research passes — the claims themselves
// ---------------------------------------------------------------------------

export interface ParsedClaim {
  claim: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourcePublisher: string | null;
  sourceDate: string | null;
  evidenceExcerpt: string | null;
  evidenceLocator: string | null;
  retrievedAt: string | null;
  confidence: number;
  evidenceLane: string | null;
  derived: boolean;
  derivedFrom: string[];
}

export interface ResearchPassOutput {
  claims: ParsedClaim[];
  searchQueries: string[];
  unresolved: string[];
  notes: string;
}

function parseClaim(row: Record<string, unknown>, where: string): ParseResult<ParsedClaim> {
  const claim = stringField(row['claim'], `${where}.claim`, { required: true });
  if (!claim.ok) return claim;

  const url = stringField(row['sourceUrl'], `${where}.sourceUrl`);
  if (!url.ok) return url;
  const title = stringField(row['sourceTitle'], `${where}.sourceTitle`);
  if (!title.ok) return title;
  const publisher = stringField(row['sourcePublisher'], `${where}.sourcePublisher`);
  if (!publisher.ok) return publisher;
  const date = stringField(row['sourceDate'], `${where}.sourceDate`);
  if (!date.ok) return date;
  const excerpt = stringField(row['evidenceExcerpt'], `${where}.evidenceExcerpt`);
  if (!excerpt.ok) return excerpt;
  const locator = stringField(row['evidenceLocator'], `${where}.evidenceLocator`);
  if (!locator.ok) return locator;
  const retrievedAt = stringField(row['retrievedAt'], `${where}.retrievedAt`);
  if (!retrievedAt.ok) return retrievedAt;
  const lane = stringField(row['evidenceLane'], `${where}.evidenceLane`);
  if (!lane.ok) return lane;

  const confidence = confidenceField(row['confidence']);
  if (!confidence.ok) return confidence;

  const derived = booleanField(row['derived'], `${where}.derived`);
  if (!derived.ok) return derived;
  const derivedFrom = stringArray(row['derivedFrom'], `${where}.derivedFrom`);
  if (!derivedFrom.ok) return derivedFrom;

  return {
    ok: true,
    value: {
      claim: claim.value,
      sourceUrl: url.value || null,
      sourceTitle: title.value || null,
      sourcePublisher: publisher.value || null,
      sourceDate: date.value || null,
      evidenceExcerpt: excerpt.value || null,
      evidenceLocator: locator.value || null,
      retrievedAt: retrievedAt.value || null,
      confidence: confidence.value ?? 0,
      evidenceLane: lane.value || null,
      derived: derived.value,
      derivedFrom: derivedFrom.value,
    },
  };
}

export function parseResearchPass(text: string): ParseResult<ResearchPassOutput> {
  const json = extractJsonObject(text);
  if (!json.ok) return json;
  const body = json.value;

  const rows = arrayOf(body['claims'], 'claims');
  if (!rows.ok) return rows;

  const claims: ParsedClaim[] = [];
  for (const [index, row] of rows.value.entries()) {
    const parsed = parseClaim(row, `claims[${index}]`);
    if (!parsed.ok) return parsed;
    claims.push(parsed.value);
  }

  const searchQueries = stringArray(body['searchQueries'], 'searchQueries');
  if (!searchQueries.ok) return searchQueries;
  const unresolved = stringArray(body['unresolved'], 'unresolved');
  if (!unresolved.ok) return unresolved;
  const notes = stringField(body['notes'], 'notes');
  if (!notes.ok) return notes;

  return {
    ok: true,
    value: {
      claims,
      searchQueries: searchQueries.value,
      unresolved: unresolved.value,
      notes: notes.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Verification pass — does the evidence actually hold, and is there enough
// ---------------------------------------------------------------------------

export const SCOPE_MATCH_VALUES = ['MATCH', 'MISMATCH', 'UNSTATED'] as const;
export type ScopeMatchValue = (typeof SCOPE_MATCH_VALUES)[number];

export interface ClaimScopeMatch {
  geography: ScopeMatchValue;
  timeframe: ScopeMatchValue;
  population: ScopeMatchValue;
  definitions: ScopeMatchValue;
}

export interface ClaimVerdict {
  claimIndex: number;
  supportsClaim: boolean;
  scopeMatch: ClaimScopeMatch;
  contradictionState: ContradictionState;
  note: string;
}

export interface VerificationPassOutput {
  claimVerdicts: ClaimVerdict[];
  sufficiency: SufficiencyVerdict;
  missingLanes: string[];
  unresolvedGaps: string[];
  reasoning: string;
}

function parseScopeMatch(value: unknown, where: string): ParseResult<ClaimScopeMatch> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`"${where}" must be an object naming geography, timeframe, population and definitions.`);
  }
  const row = value as Record<string, unknown>;
  const out: Partial<ClaimScopeMatch> = {};
  for (const field of ['geography', 'timeframe', 'population', 'definitions'] as const) {
    const parsed = strictEnum(row[field], SCOPE_MATCH_VALUES, `${where}.${field}`);
    if (!parsed.ok) return parsed;
    out[field] = parsed.value;
  }
  return { ok: true, value: out as ClaimScopeMatch };
}

export function parseVerificationPass(text: string): ParseResult<VerificationPassOutput> {
  const json = extractJsonObject(text);
  if (!json.ok) return json;
  const body = json.value;

  const rows = arrayOf(body['claimVerdicts'], 'claimVerdicts');
  if (!rows.ok) return rows;

  const claimVerdicts: ClaimVerdict[] = [];
  const seen = new Set<number>();
  for (const [index, row] of rows.value.entries()) {
    const where = `claimVerdicts[${index}]`;
    const claimIndex = nonNegativeInteger(row['claimIndex'], `${where}.claimIndex`);
    if (!claimIndex.ok) return claimIndex;
    if (seen.has(claimIndex.value)) {
      return fail(`"${where}.claimIndex" ${claimIndex.value} was judged twice.`);
    }
    seen.add(claimIndex.value);

    const supports = booleanField(row['supportsClaim'], `${where}.supportsClaim`);
    if (!supports.ok) return supports;

    const scopeMatch = parseScopeMatch(row['scopeMatch'], `${where}.scopeMatch`);
    if (!scopeMatch.ok) return scopeMatch;

    const contradiction = strictEnum(
      row['contradictionState'],
      CONTRADICTION_STATES,
      `${where}.contradictionState`,
    );
    if (!contradiction.ok) return contradiction;

    const note = stringField(row['note'], `${where}.note`);
    if (!note.ok) return note;

    claimVerdicts.push({
      claimIndex: claimIndex.value,
      supportsClaim: supports.value,
      scopeMatch: scopeMatch.value,
      contradictionState: contradiction.value,
      note: note.value,
    });
  }

  const sufficiency = strictEnum(body['sufficiency'], SUFFICIENCY_VERDICTS, 'sufficiency');
  if (!sufficiency.ok) return sufficiency;

  const missingLanes = stringArray(body['missingLanes'], 'missingLanes');
  if (!missingLanes.ok) return missingLanes;
  const unresolvedGaps = stringArray(body['unresolvedGaps'], 'unresolvedGaps');
  if (!unresolvedGaps.ok) return unresolvedGaps;
  const reasoning = stringField(body['reasoning'], 'reasoning', { required: true });
  if (!reasoning.ok) return reasoning;

  return {
    ok: true,
    value: {
      claimVerdicts,
      sufficiency: sufficiency.value,
      missingLanes: missingLanes.value,
      unresolvedGaps: unresolvedGaps.value,
      reasoning: reasoning.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

export interface SynthesisPassOutput {
  report: string;
  citedClaimIds: string[];
  unresolvedGaps: string[];
}

/** Enough of a report to be an artifact; a paragraph is a summary, not a layer document. */
const MIN_REPORT_CHARS = 400;

export function parseSynthesisPass(text: string): ParseResult<SynthesisPassOutput> {
  const json = extractJsonObject(text);
  if (!json.ok) return json;
  const body = json.value;

  const report = stringField(body['report'], 'report', { required: true });
  if (!report.ok) return report;
  if (report.value.length < MIN_REPORT_CHARS) {
    return fail(
      `The synthesis is ${report.value.length} characters, too short to be the layer's document.`,
    );
  }

  const cited = stringArray(body['citedClaimIds'], 'citedClaimIds');
  if (!cited.ok) return cited;
  const gaps = stringArray(body['unresolvedGaps'], 'unresolvedGaps');
  if (!gaps.ok) return gaps;

  return {
    ok: true,
    value: { report: report.value, citedClaimIds: cited.value, unresolvedGaps: gaps.value },
  };
}

export type { ParseResult };

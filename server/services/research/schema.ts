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
import { isLaneId, LANE_NECESSITIES, laneIdFrom } from '../../domain/evidenceLanes.ts';
import {
  CLAIM_TYPES,
  CONTRADICTION_STATES,
  REQUIREMENT_KINDS,
  REQUIREMENT_NECESSITIES,
  SUFFICIENCY_VERDICTS,
  type ClaimType,
  type ContradictionState,
  type RequirementKind,
  type RequirementNecessity,
  type SufficiencyVerdict,
  type RetrievalState,
  type EvidenceLane,
  type LaneNecessity,
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

/**
 * How many fragments an assignment may have.
 *
 * There is deliberately no minimum. The count comes from the gaps the coverage
 * matrix finds: an assignment whose archive already answers most of it needs two
 * fragments, and a genuinely open one needs thirty. A fixed floor would force
 * research nobody needed, which is exactly the waste this build exists to stop.
 *
 * The ceiling is a backstop against a runaway plan, not a target.
 */
export const MAX_FRAGMENTS = 60;

/**
 * A fragment must rest on at least one source. It must not be told in advance
 * how many more.
 *
 * This was 2, and it was a general minimum — the thing §14 says does not exist.
 * "Two independent sources" is right for a disputed market estimate and wrong
 * for a statutory fact, where one directly inspected primary source settles the
 * question and a second adds nothing but cost. Enforced here, before any
 * evidence exists, it applied the contested-estimate bar to every question a
 * plan could ask.
 *
 * It was one of three places that independently imposed the same number, and
 * together they failed three fragments of the first live packet whose integrity
 * had *passed*: each had quoted the statute it was asked about, and each was
 * refused for having found only the one source that answers such a question.
 *
 * So the floor is now what it can honestly be: a fragment resting on nothing is
 * not covered. How many sources a *claim* needs is decided per claim by
 * `standards.ts`, from what the claim asserts, once there is something to
 * judge — and the gate raises the fragment's bar to match. A fragment whose
 * question really is contested still declares more, and the planner still
 * declares 3 for a requirement the archive already found contradictory.
 */
export const MIN_INDEPENDENT_SOURCES_FLOOR = 1;
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
// Pass 1a — the boundary contract and the requirement graph
//
// This is what the plan pass produces now. Fragments are not proposed here at
// all: they are derived later, from the gaps the coverage matrix finds, so that
// nothing is researched merely because it appeared in the goal.
// ---------------------------------------------------------------------------

export interface ParsedBoundary {
  primaryQuestion: string;
  decisionSupported: string | null;
  audience: string | null;
  includedSubjects: string[];
  excludedSubjects: string[];
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definitions: { term: string; definition: string }[];
  requiredComparisons: string[];
  requiredCalculations: string[];
  expectedOutput: string | null;
  requiredConfidence: string | null;
  acceptableUncertainty: string | null;
  prohibitedAssumptions: string[];
  sourceConstraints: string[];
  completionStandard: string | null;
  ambiguities: { question: string; why: string }[];
}

export interface ParsedRequirement {
  key: string;
  statement: string;
  necessity: RequirementNecessity;
  kind: RequirementKind;
  rationale: string | null;
  requiredEvidence: EvidenceLane[];
  completionCriteria: string[];
  dependsOn: string[];
  owningLayerName: string | null;
}

export interface GoalPlanOutput {
  boundary: ParsedBoundary;
  requirements: ParsedRequirement[];
}

/** At least this many requirements, or the goal was restated rather than analysed. */
const MIN_REQUIREMENTS = 3;
const MAX_REQUIREMENTS = 60;

function pairs(value: unknown, field: string): ParseResult<{ term: string; definition: string }[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  const rows = arrayOf(value, field);
  if (!rows.ok) return rows;
  const out: { term: string; definition: string }[] = [];
  for (const [index, row] of rows.value.entries()) {
    const term = stringField(row['term'], `${field}[${index}].term`, { required: true });
    if (!term.ok) return term;
    const definition = stringField(row['definition'], `${field}[${index}].definition`, {
      required: true,
    });
    if (!definition.ok) return definition;
    out.push({ term: term.value, definition: definition.value });
  }
  return { ok: true, value: out };
}

export function parseGoalPlan(text: string): ParseResult<GoalPlanOutput> {
  const json = extractJsonObject(text);
  if (!json.ok) return json;
  const body = json.value;

  const boundaryRaw = body['boundary'];
  if (!boundaryRaw || typeof boundaryRaw !== 'object' || Array.isArray(boundaryRaw)) {
    return fail('"boundary" must be an object stating what this assignment is and is not about.');
  }
  const b = boundaryRaw as Record<string, unknown>;

  const primaryQuestion = stringField(b['primaryQuestion'], 'boundary.primaryQuestion', {
    required: true,
  });
  if (!primaryQuestion.ok) return primaryQuestion;

  const strings = (key: string): ParseResult<string[]> => stringArray(b[key], `boundary.${key}`);
  const included = strings('includedSubjects');
  if (!included.ok) return included;
  const excluded = strings('excludedSubjects');
  if (!excluded.ok) return excluded;
  const comparisons = strings('requiredComparisons');
  if (!comparisons.ok) return comparisons;
  const calculations = strings('requiredCalculations');
  if (!calculations.ok) return calculations;
  const prohibited = strings('prohibitedAssumptions');
  if (!prohibited.ok) return prohibited;
  const constraints = strings('sourceConstraints');
  if (!constraints.ok) return constraints;

  const definitions = pairs(b['definitions'], 'boundary.definitions');
  if (!definitions.ok) return definitions;

  const optional = (key: string): ParseResult<string> => stringField(b[key], `boundary.${key}`);
  const decision = optional('decisionSupported');
  if (!decision.ok) return decision;
  const audience = optional('audience');
  if (!audience.ok) return audience;
  const geography = optional('geography');
  if (!geography.ok) return geography;
  const timeframe = optional('timeframe');
  if (!timeframe.ok) return timeframe;
  const population = optional('population');
  if (!population.ok) return population;
  const expectedOutput = optional('expectedOutput');
  if (!expectedOutput.ok) return expectedOutput;
  const requiredConfidence = optional('requiredConfidence');
  if (!requiredConfidence.ok) return requiredConfidence;
  const acceptableUncertainty = optional('acceptableUncertainty');
  if (!acceptableUncertainty.ok) return acceptableUncertainty;
  const completionStandard = optional('completionStandard');
  if (!completionStandard.ok) return completionStandard;

  const ambiguityRows = arrayOf(b['ambiguities'] ?? [], 'boundary.ambiguities');
  if (!ambiguityRows.ok) return ambiguityRows;
  const ambiguities: { question: string; why: string }[] = [];
  for (const [index, row] of ambiguityRows.value.entries()) {
    const question = stringField(row['question'], `boundary.ambiguities[${index}].question`, {
      required: true,
    });
    if (!question.ok) return question;
    const why = stringField(row['why'], `boundary.ambiguities[${index}].why`);
    if (!why.ok) return why;
    ambiguities.push({ question: question.value, why: why.value });
  }

  const requirementRows = arrayOf(body['requirements'], 'requirements');
  if (!requirementRows.ok) return requirementRows;
  if (requirementRows.value.length < MIN_REQUIREMENTS) {
    return fail(
      `The plan listed ${requirementRows.value.length} requirement(s). A goal that decomposes into ` +
        `fewer than ${MIN_REQUIREMENTS} has been restated rather than analysed.`,
    );
  }
  if (requirementRows.value.length > MAX_REQUIREMENTS) {
    return fail(`The plan listed ${requirementRows.value.length} requirements, above the ceiling of ${MAX_REQUIREMENTS}.`);
  }

  const requirements: ParsedRequirement[] = [];
  const keys = new Set<string>();
  for (const [index, row] of requirementRows.value.entries()) {
    const where = `requirements[${index}]`;
    const statement = stringField(row['statement'], `${where}.statement`, { required: true });
    if (!statement.ok) return statement;

    const necessity = strictEnum(row['necessity'], REQUIREMENT_NECESSITIES, `${where}.necessity`);
    if (!necessity.ok) return necessity;
    const kind = strictEnum(row['kind'], REQUIREMENT_KINDS, `${where}.kind`);
    if (!kind.ok) return kind;

    const rationale = stringField(row['rationale'], `${where}.rationale`);
    if (!rationale.ok) return rationale;
    const requiredEvidence = laneArray(row['requiredEvidence'], `${where}.requiredEvidence`);
    if (!requiredEvidence.ok) return requiredEvidence;
    const completionCriteria = stringArray(row['completionCriteria'], `${where}.completionCriteria`);
    if (!completionCriteria.ok) return completionCriteria;
    const dependsOn = stringArray(row['dependsOn'], `${where}.dependsOn`);
    if (!dependsOn.ok) return dependsOn;
    const owningLayer = stringField(row['owningLayer'], `${where}.owningLayer`);
    if (!owningLayer.ok) return owningLayer;

    // A research requirement that does not say what evidence would answer it
    // cannot be judged covered or uncovered, which makes it useless.
    if (kind.value === 'RESEARCH' && requiredEvidence.value.length === 0) {
      return fail(`"${where}.requiredEvidence" is empty; say what evidence would answer it.`);
    }

    const rawKey = stringField(row['key'], `${where}.key`);
    if (!rawKey.ok) return rawKey;
    let key = slugify(rawKey.value || statement.value, `requirement-${index + 1}`);
    let suffix = 2;
    while (keys.has(key)) {
      key = `${key}-${suffix}`;
      suffix += 1;
    }
    keys.add(key);

    requirements.push({
      key,
      statement: statement.value,
      necessity: necessity.value,
      kind: kind.value,
      rationale: rationale.value || null,
      requiredEvidence: requiredEvidence.value,
      completionCriteria: completionCriteria.value,
      dependsOn: dependsOn.value,
      owningLayerName: owningLayer.value || null,
    });
  }

  // Dependencies are resolved against the keys that exist, for the same reason
  // as fragments: one pointing nowhere would stall the graph.
  const known = new Set(requirements.map((requirement) => requirement.key));
  for (const requirement of requirements) {
    requirement.dependsOn = requirement.dependsOn
      .map((dependency) => slugify(dependency, ''))
      .filter((dependency) => dependency.length > 0 && dependency !== requirement.key && known.has(dependency));
  }

  return {
    ok: true,
    value: {
      boundary: {
        primaryQuestion: primaryQuestion.value,
        decisionSupported: decision.value || null,
        audience: audience.value || null,
        includedSubjects: included.value,
        excludedSubjects: excluded.value,
        geography: geography.value || null,
        timeframe: timeframe.value || null,
        population: population.value || null,
        definitions: definitions.value,
        requiredComparisons: comparisons.value,
        requiredCalculations: calculations.value,
        expectedOutput: expectedOutput.value || null,
        requiredConfidence: requiredConfidence.value || null,
        acceptableUncertainty: acceptableUncertainty.value || null,
        prohibitedAssumptions: prohibited.value,
        sourceConstraints: constraints.value,
        completionStandard: completionStandard.value || null,
        ambiguities,
      },
      requirements,
    },
  };
}

// ---------------------------------------------------------------------------
// Pass 1 — the fragmentation plan (retained for direct fragment planning)
// ---------------------------------------------------------------------------

export interface PlannedFragment {
  key: string;
  question: string;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definitions: string | null;
  requiredEvidence: EvidenceLane[];
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

  if (rows.value.length === 0) {
    return fail('The plan proposed no fragments at all, so there is nothing to research.');
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

    const requiredEvidence = laneArray(row['requiredEvidence'], `${where}.requiredEvidence`);
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
  /** What kind of claim this is, which decides what would count as evidence. */
  claimType: ClaimType;
  /** True when the source is the body that produced the data, not a report of it. */
  primarySource: boolean;
  /** For a claimed absence: where the worker looked. */
  searchedRepositories: string[];
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourcePublisher: string | null;
  sourceDate: string | null;
  evidenceExcerpt: string | null;
  evidenceLocator: string | null;
  retrievedAt: string | null;
  confidence: number;
  evidenceLane: string | null;
  /**
   * Whether the worker could actually read the source.
   *
   * Optional here because the in-process research passes do not set it — a
   * scripted provider has no retrieval to fail — and absent means RETRIEVED.
   * The worker path does set it, and it has to survive the trip to storage:
   * a claim marked PAYWALLED that lands as RETRIEVED is judged as though
   * somebody had read the page, which is the opposite of what marking it says.
   */
  retrievalState?: RetrievalState;
  derived: boolean;
  derivedFrom: string[];
}

export interface ResearchPassOutput {
  claims: ParsedClaim[];
  searchQueries: string[];
  unresolved: string[];
  notes: string;
}

/**
 * Evidence lanes as a plan declares them.
 *
 * Accepts either shape and says which it got. An object with `id`,
 * `description` and `necessity` is the intended one: the id is the key
 * coverage compares, the description is the question, and the necessity says
 * whether an empty lane fails the fragment.
 *
 * A bare string is still accepted and read as a description with a derived id
 * and `REQUIRED` — the meaning it had when every lane was mandatory prose. It
 * is a fallback rather than the path: a derived id names whatever the sentence
 * opened with, where a declared one names the concept.
 *
 * A declared id that is not id-shaped is **refused** rather than slugged. That
 * is the whole correction: the packet that failed used 160-character sentences
 * as identifiers, and quietly turning a sentence into an id would leave the
 * plan believing it had named something.
 */
function laneArray(value: unknown, where: string): ParseResult<EvidenceLane[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return fail(`"${where}" must be an array.`);
  const lanes: EvidenceLane[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `${where}[${index}]`;
    if (typeof entry === 'string') {
      const description = entry.trim();
      if (description.length === 0) return fail(`"${at}" is empty.`);
      lanes.push({ id: laneIdFrom(description), description, necessity: 'REQUIRED' });
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return fail(`"${at}" must be an object with id, description and necessity, or a string.`);
    }
    const row = entry as Record<string, unknown>;
    const description = stringField(row['description'], `${at}.description`);
    if (!description.ok) return description;
    if (description.value.trim().length === 0) return fail(`"${at}.description" is empty.`);

    const rawId = row['id'];
    if (rawId !== undefined && typeof rawId !== 'string') return fail(`"${at}.id" must be a string.`);
    const declared = typeof rawId === 'string' ? rawId.trim() : '';
    if (declared.length > 0 && !isLaneId(declared)) {
      return fail(
        `"${at}.id" is ${JSON.stringify(declared.slice(0, 60))}, which is not an identifier. ` +
          'A lane id is short, stable and machine-shaped — lowercase letters, digits and ' +
          'underscores, starting with a letter, at most 40 characters, like ' +
          '"operative_authority". The sentence describing the lane goes in "description"; a ' +
          'description used as an id is what made a fragment\'s evidence uncountable.',
      );
    }
    const necessity = row['necessity'] === undefined
      ? { ok: true as const, value: 'REQUIRED' as LaneNecessity }
      : strictEnum(row['necessity'], LANE_NECESSITIES, `${at}.necessity`);
    if (!necessity.ok) return necessity;

    lanes.push({
      id: declared.length > 0 ? declared : laneIdFrom(description.value),
      description: description.value.trim(),
      necessity: necessity.value as LaneNecessity,
    });
  }
  const ids = new Set<string>();
  for (const lane of lanes) {
    if (ids.has(lane.id)) {
      return fail(
        `"${where}" declares the lane id "${lane.id}" twice. Coverage is counted per id, so two ` +
          'lanes sharing one are indistinguishable to the gate.',
      );
    }
    ids.add(lane.id);
  }
  return { ok: true, value: lanes };
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
  const primarySource = booleanField(row['primarySource'], `${where}.primarySource`);
  if (!primarySource.ok) return primarySource;
  const searched = stringArray(row['searchedRepositories'], `${where}.searchedRepositories`);
  if (!searched.ok) return searched;

  // The claim's own type decides its evidence standard, so it is required rather
  // than guessed: a forecast filed as a fact is the error this prevents.
  const claimType = strictEnum(row['claimType'] ?? 'SOURCED_FACT', CLAIM_TYPES, `${where}.claimType`);
  if (!claimType.ok) return claimType;
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
      claimType: claimType.value,
      primarySource: primarySource.value,
      searchedRepositories: searched.value,
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

/**
 * A bundled job's output, keyed by fragment.
 *
 * Several fragments can share one execution, but never one answer: each returns
 * its own claims under its own key so its evidence can be judged, accepted,
 * rejected or repaired without touching the others. A reply that blends them is
 * refused rather than untangled — untangling would mean guessing which claim
 * belonged to which question, which is exactly the attribution error the whole
 * ledger exists to prevent.
 *
 * The single-fragment shape is still accepted, because a job carrying one
 * fragment has nothing to key.
 */
export interface BundledResearchOutput {
  byFragment: Map<string, ResearchPassOutput>;
}

export function parseBundledResearchPass(
  text: string,
  fragmentKeys: string[],
): ParseResult<BundledResearchOutput> {
  const json = extractJsonObject(text);
  if (!json.ok) return json;
  const body = json.value;

  // One fragment, or a reply in the plain shape: read it as that fragment's.
  if (!Array.isArray(body['fragments'])) {
    const single = parseResearchPass(text);
    if (!single.ok) return single;
    if (fragmentKeys.length > 1) {
      return fail(
        `This job carried ${fragmentKeys.length} fragments, so its reply must key the claims by ` +
          'fragment. A single undifferentiated list cannot be attributed.',
      );
    }
    return {
      ok: true,
      value: { byFragment: new Map([[fragmentKeys[0] ?? '', single.value]]) },
    };
  }

  const rows = arrayOf(body['fragments'], 'fragments');
  if (!rows.ok) return rows;

  const byFragment = new Map<string, ResearchPassOutput>();
  const known = new Set(fragmentKeys);
  for (const [index, row] of rows.value.entries()) {
    const key = stringField(row['fragmentKey'], `fragments[${index}].fragmentKey`, { required: true });
    if (!key.ok) return key;
    if (!known.has(key.value)) {
      return fail(
        `"fragments[${index}].fragmentKey" is "${key.value}", which was not one of the fragments ` +
          `in this job (${fragmentKeys.join(', ')}).`,
      );
    }
    if (byFragment.has(key.value)) {
      return fail(`Fragment "${key.value}" was answered twice in one reply.`);
    }

    const parsed = parseResearchPass(JSON.stringify(row));
    if (!parsed.ok) {
      return fail(`fragments[${index}] (${key.value}): ${parsed.error}`);
    }
    byFragment.set(key.value, parsed.value);
  }

  const missing = fragmentKeys.filter((key) => !byFragment.has(key));
  if (missing.length > 0) {
    // A missing fragment is not an error in the others: it is recorded as that
    // fragment producing nothing, which its own gate will judge.
    for (const key of missing) {
      byFragment.set(key, { claims: [], searchQueries: [], unresolved: [], notes: '' });
    }
  }

  return { ok: true, value: { byFragment } };
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

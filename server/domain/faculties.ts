/**
 * What a capability definition is, and what a worker may say about one.
 *
 * ---------------------------------------------------------------------------
 * Six dimensions and no seventh
 * ---------------------------------------------------------------------------
 *
 * The single most tempting mistake in a capability registry is one `status`
 * column that walks from "somebody wrote it down" to "it works in production".
 * It is wrong at every value in between and nobody can say which part is wrong,
 * so a Brain holding one would answer *is Research Intelligence done?* with a
 * word that means six different things.
 *
 * So there are six independent dimensions, each moved by a different kind of
 * evidence and each with a different remedy when it is behind. There is
 * deliberately **no aggregate** — not a percentage, not a rollup, not a
 * `isComplete` helper — because the moment one exists every reader uses it and
 * the six become decoration. `describeFaculty` below composes a sentence out of
 * all six instead, which is the honest shape of the same answer.
 *
 * ---------------------------------------------------------------------------
 * Ingesting a document may only ever move the first one
 * ---------------------------------------------------------------------------
 *
 * Reading the blueprint establishes what Brain is *supposed* to be able to do.
 * It establishes nothing whatsoever about whether it can. A Brain that ingested
 * a document about Research Intelligence and then reported Research
 * Intelligence as implemented would be lying in the most expensive available
 * direction — it would stop the very work the document exists to start.
 *
 * `INGESTION_MAY_MOVE` names the one dimension ingestion may touch, and
 * `assertIngestionScope` refuses the rest. It is enforced here rather than
 * remembered, because it is the property the whole registry exists to keep.
 */

/* ------------------------------------------------------------------------- */
/* The six dimensions                                                         */
/* ------------------------------------------------------------------------- */

/** What the source says. Moved by ingesting a registered, audited source. */
export const DEFINITION_STATES = ['MISSING', 'DRAFT', 'CANONICAL'] as const;
export type DefinitionState = (typeof DEFINITION_STATES)[number];

/** The cognitive contract. Moved by compiling one, never by writing a document. */
export const CONTRACT_STATES = ['MISSING', 'DRAFT', 'COMPILED'] as const;
export type ContractState = (typeof CONTRACT_STATES)[number];

/**
 * Whether code exists and runs. Moved by the Factory and by the self-model.
 *
 * `CONNECTED` and `LIVE` are two different facts and the difference is §3's
 * whole lesson: code that exists is not code that is deployed, and code that is
 * deployed is not code anything calls.
 */
export const IMPLEMENTATION_STATES = ['ABSENT', 'PARTIAL', 'CONNECTED', 'LIVE'] as const;
export type ImplementationState = (typeof IMPLEMENTATION_STATES)[number];

/** Whether it was proved. Moved by evaluation, never by a passing typecheck. */
export const EVALUATION_STATES = ['UNTESTED', 'FAILING', 'PASSING', 'PRODUCTION_PROVEN'] as const;
export type EvaluationState = (typeof EVALUATION_STATES)[number];

/** Whether it is switched on. A person's decision, never derived. */
export const AVAILABILITY_STATES = ['DISABLED', 'SHADOW', 'ACTIVE'] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

/** Whether the source moved underneath it. Moved by registering a new version. */
export const FRESHNESS_STATES = ['CURRENT', 'NEEDS_REVIEW', 'SUPERSEDED'] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

export const FACULTY_DIMENSIONS = [
  'DEFINITION',
  'CONTRACT',
  'IMPLEMENTATION',
  'EVALUATION',
  'AVAILABILITY',
  'FRESHNESS',
] as const;
export type FacultyDimension = (typeof FACULTY_DIMENSIONS)[number];

/**
 * The only dimension a source ingestion may move.
 *
 * A constant rather than a comment, so the rule is something code can be held
 * to. `assertIngestionScope` is the holding.
 */
export const INGESTION_MAY_MOVE: readonly FacultyDimension[] = ['DEFINITION'];

export class IngestionScopeViolation extends Error {
  constructor(dimension: FacultyDimension) {
    super(
      `Ingesting a source may only move ${INGESTION_MAY_MOVE.join(', ')}; it tried to move ` +
        `${dimension}. Reading a document establishes what Brain is supposed to be able to do ` +
        'and nothing about whether it can.',
    );
    this.name = 'IngestionScopeViolation';
  }
}

export function assertIngestionScope(dimension: FacultyDimension): void {
  if (!INGESTION_MAY_MOVE.includes(dimension)) throw new IngestionScopeViolation(dimension);
}

/* ------------------------------------------------------------------------- */
/* The relationship vocabulary                                                */
/* ------------------------------------------------------------------------- */

/**
 * The typed edges between faculties, and between a faculty and the machinery.
 *
 * A closed set with a CHECK behind it in the schema, so a worker proposing an
 * edge type nobody implemented is refused at the write rather than discovered
 * by a reader who cannot interpret it.
 */
export const FACULTY_RELATIONSHIPS = [
  'ACTIVATED_BY',
  'READS',
  'RETRIEVES',
  'CONSUMES',
  'PRODUCES',
  'PROPOSES_TO',
  'VALIDATED_BY',
  'PERSISTS_TO',
  'DISPATCHES_THROUGH',
  'DELEGATES_TO',
  'CONSTRAINED_BY',
  'REACTIVATED_BY',
  'EVALUATED_BY',
  'IMPLEMENTED_BY',
  'LEARNS_FROM',
] as const;
export type FacultyRelationship = (typeof FACULTY_RELATIONSHIPS)[number];

export function isFacultyRelationship(value: unknown): value is FacultyRelationship {
  return typeof value === 'string' && (FACULTY_RELATIONSHIPS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------------- */
/* The definition a worker proposes                                           */
/* ------------------------------------------------------------------------- */

/**
 * One faculty, as the source describes it.
 *
 * Every field here is something the blueprint states about the faculty. None of
 * them is a judgement about Brain: there is no `implemented`, no `priority`, no
 * `effort` and no `readiness`, because a worker reading a document has no
 * standing to answer any of those and a field it could fill in would be a field
 * something downstream would eventually read.
 */
export interface FacultyDefinition {
  slug: string;
  ordinal: number | null;
  canonicalName: string;
  purpose: string;
  /** The single central question the source poses for this faculty. */
  centralQuestion: string | null;
  promisedPower: string;
  responsibilities: string[];
  boundaries: string[];
  inputs: string[];
  outputs: string[];
  activationConditions: string[];
  reentryConditions: string[];
  dependencies: string[];
  infrastructure: string[];
  allowedProposals: string[];
  invariants: string[];
  evaluationRequirements: string[];
  failureModes: string[];
  /** Typed edges. The endpoint is another faculty's slug or a named component. */
  connections: ProposedConnection[];
}

export interface ProposedConnection {
  relationship: FacultyRelationship;
  /** Exactly one of these. A slug names a faculty; a component names machinery. */
  toFacultySlug: string | null;
  toComponent: string | null;
  rationale: string;
}

/* ------------------------------------------------------------------------- */
/* Zero-trust validation                                                      */
/* ------------------------------------------------------------------------- */

/**
 * §8 at a new boundary: a model proposes, and this decides whether the proposal
 * is even a proposal.
 *
 * Two rules it follows that a forgiving parser would not:
 *
 * **An unknown field refuses the whole candidate.** Not the field — the
 * candidate. A worker that sent `implementationStatus` has misunderstood what
 * it was asked for, and dropping the field silently leaves that belief in place
 * while storing a definition written under it. `services/russell/proposal.ts`
 * settles the identical question the identical way.
 *
 * **An empty list is not a missing list.** `responsibilities: []` is a claim
 * that the source states none, which for a faculty definition is almost
 * certainly wrong and is worth seeing. It is accepted and counted, and
 * `coverageProblems` is what notices that a candidate is thin.
 */
export class InvalidFacultyDefinition extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`The proposed definition was refused: ${problems.join(' ')}`);
    this.name = 'InvalidFacultyDefinition';
    this.problems = problems;
  }
}

const MAX_TEXT = 4_000;
const MAX_LIST = 40;
const MAX_LIST_ITEM = 1_000;
const MAX_CONNECTIONS = 40;

/** The exact key set. Anything else refuses the candidate; see above. */
export const DEFINITION_KEYS: readonly string[] = [
  'slug',
  'ordinal',
  'canonicalName',
  'purpose',
  'centralQuestion',
  'promisedPower',
  'responsibilities',
  'boundaries',
  'inputs',
  'outputs',
  'activationConditions',
  'reentryConditions',
  'dependencies',
  'infrastructure',
  'allowedProposals',
  'invariants',
  'evaluationRequirements',
  'failureModes',
  'connections',
];

const CONNECTION_KEYS: readonly string[] = [
  'relationship',
  'toFacultySlug',
  'toComponent',
  'rationale',
];

export const LIST_FIELDS: readonly (keyof FacultyDefinition)[] = [
  'responsibilities',
  'boundaries',
  'inputs',
  'outputs',
  'activationConditions',
  'reentryConditions',
  'dependencies',
  'infrastructure',
  'allowedProposals',
  'invariants',
  'evaluationRequirements',
  'failureModes',
];

/**
 * A slug is derived from the canonical name and never taken from the worker.
 *
 * The same reasoning `naming.ts` gives for a document's filename: the platform
 * owns the identifier. Two workers reading the same heading must produce the
 * same slug, and a worker free to choose would eventually produce
 * `research-intelligence` and `RESEARCH_INTEL` for one faculty.
 */
export function facultySlug(canonicalName: string): string {
  const slug = canonicalName
    .normalize('NFKD')
    .replace(/[‐-―]/g, '-')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return slug.slice(0, 80);
}

function asRecord(value: unknown, label: string, problems: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${label} was not a structured object.`);
    return null;
  }
  return value as Record<string, unknown>;
}

function requireText(
  record: Record<string, unknown>,
  key: string,
  problems: string[],
): string | null {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    problems.push(`"${key}" must be a non-empty string.`);
    return null;
  }
  if (value.length > MAX_TEXT) {
    problems.push(`"${key}" may be at most ${MAX_TEXT} characters; ${value.length} arrived.`);
    return null;
  }
  return value.trim();
}

function optionalText(
  record: Record<string, unknown>,
  key: string,
  problems: string[],
): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    problems.push(`"${key}" must be a string or null.`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_TEXT) {
    problems.push(`"${key}" may be at most ${MAX_TEXT} characters.`);
    return null;
  }
  return trimmed;
}

function requireList(
  record: Record<string, unknown>,
  key: string,
  problems: string[],
): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    problems.push(`"${key}" must be an array of strings.`);
    return [];
  }
  if (value.length > MAX_LIST) {
    problems.push(`"${key}" may hold at most ${MAX_LIST} entries; ${value.length} arrived.`);
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      problems.push(`"${key}" holds a non-string or empty entry.`);
      return [];
    }
    if (entry.length > MAX_LIST_ITEM) {
      problems.push(`"${key}" holds an entry longer than ${MAX_LIST_ITEM} characters.`);
      return [];
    }
    out.push(entry.trim());
  }
  return out;
}

function validateConnections(value: unknown, problems: string[]): ProposedConnection[] {
  if (!Array.isArray(value)) {
    problems.push('"connections" must be an array.');
    return [];
  }
  if (value.length > MAX_CONNECTIONS) {
    problems.push(`"connections" may hold at most ${MAX_CONNECTIONS} entries.`);
    return [];
  }
  const out: ProposedConnection[] = [];
  for (const raw of value) {
    const record = asRecord(raw, 'A connection', problems);
    if (!record) return [];
    const unknown = Object.keys(record).filter((key) => !CONNECTION_KEYS.includes(key));
    if (unknown.length > 0) {
      problems.push(`A connection carried unknown field(s): ${unknown.join(', ')}.`);
      return [];
    }
    if (!isFacultyRelationship(record['relationship'])) {
      problems.push(
        `A connection named relationship "${String(record['relationship'])}", which is not one of ` +
          `${FACULTY_RELATIONSHIPS.join(', ')}.`,
      );
      return [];
    }
    const toFaculty = optionalText(record, 'toFacultySlug', problems);
    const toComponent = optionalText(record, 'toComponent', problems);
    if ((toFaculty === null) === (toComponent === null)) {
      problems.push(
        'A connection must name exactly one endpoint: either "toFacultySlug" or "toComponent".',
      );
      return [];
    }
    const rationale = requireText(record, 'rationale', problems);
    if (rationale === null) return [];
    out.push({
      relationship: record['relationship'],
      toFacultySlug: toFaculty === null ? null : facultySlug(toFaculty),
      toComponent,
      rationale,
    });
  }
  return out;
}

/**
 * Validate one proposed definition, whole.
 *
 * Returns the normalised definition or throws with every problem found, rather
 * than the first: a worker that has to discover its mistakes one round trip at
 * a time spends the allowance learning the schema.
 */
export function validateFacultyDefinition(value: unknown): FacultyDefinition {
  const problems: string[] = [];
  const record = asRecord(value, 'The definition', problems);
  if (!record) throw new InvalidFacultyDefinition(problems);

  const unknown = Object.keys(record).filter((key) => !DEFINITION_KEYS.includes(key));
  if (unknown.length > 0) {
    // The whole candidate, not the field. See the class comment.
    throw new InvalidFacultyDefinition([
      `The definition carried unknown field(s): ${unknown.join(', ')}. The whole candidate is ` +
        'refused rather than the field dropped, because a field nobody asked for is a ' +
        'misunderstanding about what was asked.',
    ]);
  }

  const canonicalName = requireText(record, 'canonicalName', problems);
  const purpose = requireText(record, 'purpose', problems);
  const promisedPower = requireText(record, 'promisedPower', problems);
  const centralQuestion = optionalText(record, 'centralQuestion', problems);

  const ordinalRaw = record['ordinal'];
  let ordinal: number | null = null;
  if (ordinalRaw !== undefined && ordinalRaw !== null) {
    if (typeof ordinalRaw !== 'number' || !Number.isInteger(ordinalRaw) || ordinalRaw < 0) {
      problems.push('"ordinal" must be a non-negative integer or null.');
    } else {
      ordinal = ordinalRaw;
    }
  }

  const lists: Partial<Record<keyof FacultyDefinition, string[]>> = {};
  for (const field of LIST_FIELDS) lists[field] = requireList(record, field, problems);

  const connections = validateConnections(record['connections'], problems);

  if (problems.length > 0) throw new InvalidFacultyDefinition(problems);

  // `slug` is derived rather than read. A worker may send one — the key is in
  // the accepted set so that echoing back what it was given is not an error —
  // and what is stored is always Brain's own derivation from the name.
  return {
    slug: facultySlug(canonicalName as string),
    ordinal,
    canonicalName: canonicalName as string,
    purpose: purpose as string,
    centralQuestion,
    promisedPower: promisedPower as string,
    responsibilities: lists.responsibilities ?? [],
    boundaries: lists.boundaries ?? [],
    inputs: lists.inputs ?? [],
    outputs: lists.outputs ?? [],
    activationConditions: lists.activationConditions ?? [],
    reentryConditions: lists.reentryConditions ?? [],
    dependencies: lists.dependencies ?? [],
    infrastructure: lists.infrastructure ?? [],
    allowedProposals: lists.allowedProposals ?? [],
    invariants: lists.invariants ?? [],
    evaluationRequirements: lists.evaluationRequirements ?? [],
    failureModes: lists.failureModes ?? [],
    connections,
  };
}

/**
 * Which of the required aspects a definition left empty.
 *
 * Separate from validation on purpose: an empty list is a *valid* claim that
 * the source states none, and it is also usually a sign that the worker skimmed
 * the section. So it is reported rather than refused, and the extraction
 * contract decides what to do about it — which keeps "the schema was wrong" and
 * "the reading was thin" as two different findings with two different remedies.
 */
export function coverageProblems(definition: FacultyDefinition): string[] {
  const thin: string[] = [];
  const required: (keyof FacultyDefinition)[] = [
    'responsibilities',
    'boundaries',
    'inputs',
    'outputs',
    'activationConditions',
    'dependencies',
    'invariants',
    'evaluationRequirements',
    'failureModes',
  ];
  for (const field of required) {
    const value = definition[field];
    if (Array.isArray(value) && value.length === 0) thin.push(String(field));
  }
  return thin;
}

/**
 * The six dimensions as one sentence, composed rather than aggregated.
 *
 * This is what exists instead of a completion percentage. A reader asking "how
 * far along is Research Intelligence" gets all six facts, because the honest
 * answer to that question has six parts and any single number would be picking
 * one of them to stand for the rest.
 */
export function describeFaculty(states: {
  canonicalName: string;
  definitionState: DefinitionState;
  contractState: ContractState;
  implementationState: ImplementationState;
  evaluationState: EvaluationState;
  availabilityState: AvailabilityState;
  freshnessState: FreshnessState;
}): string {
  const definition =
    states.definitionState === 'CANONICAL'
      ? 'canonically defined'
      : states.definitionState === 'DRAFT'
        ? 'defined in draft'
        : 'not yet defined';
  const implementation =
    states.implementationState === 'LIVE'
      ? 'its implementation is live'
      : states.implementationState === 'CONNECTED'
        ? 'its implementation is connected but not live'
        : states.implementationState === 'PARTIAL'
          ? 'its implementation is partial'
          : 'it has no implementation';
  const evaluation =
    states.evaluationState === 'PRODUCTION_PROVEN'
      ? 'production-proven'
      : states.evaluationState === 'PASSING'
        ? 'passing its evaluation but not production-proven'
        : states.evaluationState === 'FAILING'
          ? 'failing its evaluation'
          : 'not yet evaluated';
  const availability =
    states.availabilityState === 'ACTIVE'
      ? 'active'
      : states.availabilityState === 'SHADOW'
        ? 'running in shadow'
        : 'switched off';
  const freshness =
    states.freshnessState === 'CURRENT'
      ? ''
      : states.freshnessState === 'NEEDS_REVIEW'
        ? ' Its source has moved since it was defined, so the definition needs review.'
        : ' Its definition has been superseded by a later source.';
  const contract =
    states.contractState === 'COMPILED'
      ? 'its cognitive contract is compiled'
      : states.contractState === 'DRAFT'
        ? 'its cognitive contract is a draft'
        : 'it has no cognitive contract';
  return (
    `${states.canonicalName} is ${definition}, ${contract}, ${implementation}, it is ` +
    `${evaluation}, and it is ${availability}.${freshness}`
  );
}

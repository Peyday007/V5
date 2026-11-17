/**
 * Knowledge acquisition and mechanism understanding (META-18-2, layers 1 and 2).
 *
 * Layer 1 — knowledge. A project's gated research claims are read back as
 * atomic, sourced claims, each carrying its provenance (source, publisher,
 * retrieval date, lane) and an explicit status:
 *
 *   SUPPORTED            a sourced, retrieved, unchallenged claim;
 *   CONFLICTING          contested, refuted, or materially disagreeing with
 *                        another claim about the same thing (classified by
 *                        `classifyContradiction`, never averaged);
 *   OUTDATED             past its stated validity, its invalidating condition
 *                        met, or superseded by a newer reading;
 *   LOCALLY_INAPPLICABLE scoped to a geography, population or timeframe the
 *                        question is not about;
 *   MISSING              a facet of the market nobody has evidenced. Reported
 *                        as missing, never filled.
 *
 * Every claim keeps its reason. The facets (what the market or process is,
 * actors, rules, buyer and supplier behaviour, prices, constraints, timing,
 * competition, infrastructure, performance data, the evidence that exists) are
 * a starting checklist, not a whitelist: a claim filed under a lane no facet
 * names opens a facet of that lane's own name rather than being dropped.
 *
 * Layer 2 — mechanism. `buildMechanismModel` states how a transaction actually
 * happens in a domain on the existing causal graph (`server/services/quant/
 * graph.ts`): who initiates, how access is won, which rights are needed, whose
 * balance sheet carries which risk, what triggers purchase, who delivers, how
 * money moves, what can fail and what is reusable. A role with no evidence is
 * a node marked UNKNOWN, never given a value. Node and relation types beyond
 * the seed vocabulary are declared with a reason, so no fixed five- or
 * fourteen-factor form is assumed.
 *
 * Nothing here creates a table, a scheduler or a store: claims are read
 * through the research repository and the graph is the one the quant layer
 * already owns.
 */
import { citableClaims, listOrchestrationsByProject } from '../../repos/research.ts';
import type { ResearchClaim } from '../../domain/types.ts';
import {
  addMoneyRoute,
  addNode,
  addRelation,
  createGraph,
  declareType,
  discoverMissing,
  makeFigure,
  recordClaim,
  unknownFigure,
  type CausalGraph,
  type Discovery,
  type MoneyRoute,
} from '../quant/graph.ts';
import { aboutTheSameThing, classifyContradiction } from './contradictions.ts';

/* ------------------------------------------------------------------------- */
/* Layer 1: knowledge                                                        */
/* ------------------------------------------------------------------------- */

/** The starting checklist of what a market or process is made of. Illustrative, not exhaustive. */
export const KNOWLEDGE_FACETS = [
  'definition',
  'actors',
  'rules',
  'buyer_behavior',
  'supplier_behavior',
  'prices',
  'constraints',
  'timing',
  'competition',
  'infrastructure',
  'performance',
] as const;

export const KNOWLEDGE_STATUSES = ['SUPPORTED', 'CONFLICTING', 'OUTDATED', 'LOCALLY_INAPPLICABLE', 'MISSING'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

/** The fields of a research claim this layer reads. A `ResearchClaim` satisfies it. */
export type KnowledgeSourceClaim = Pick<
  ResearchClaim,
  | 'id'
  | 'claim'
  | 'claimType'
  | 'sourceUrl'
  | 'sourceTitle'
  | 'sourcePublisher'
  | 'sourceDate'
  | 'retrievedAt'
  | 'retrievalState'
  | 'evidenceLane'
  | 'geography'
  | 'timeframe'
  | 'population'
  | 'definition'
  | 'contradictionState'
  | 'contradictionNote'
  | 'contradictionKind'
  | 'reconciliation'
  | 'reconciledClaimId'
  | 'accepted'
  | 'sourced'
  | 'primarySource'
  | 'structuralFinding'
  | 'laborFinding'
  | 'createdAt'
> &
  Partial<Pick<ResearchClaim, 'validUntil' | 'invalidationMetAt' | 'invalidationNote' | 'closesOn'>>;

export interface Provenance {
  sourceUrl: string | null;
  sourceTitle: string | null;
  publisher: string | null;
  publishedAt: string | null;
  /** When the source was read. Never invented: null when no row recorded it. */
  retrievedAt: string | null;
  retrievalState: string;
  lane: string | null;
  primary: boolean;
}

export interface AtomicClaim {
  /** The research claim id; for a MISSING facet, `missing:<facet>`. */
  id: string;
  facet: string;
  text: string | null;
  status: KnowledgeStatus;
  /** Why it has that status, in a sentence. Always present. */
  reason: string;
  provenance: Provenance | null;
  scope: { geography: string | null; timeframe: string | null; population: string | null; definition: string | null };
  /** Other claim ids this one conflicts with or was superseded by. */
  related: string[];
}

export interface KnowledgeScope {
  /** The geography the question is about; a claim scoped elsewhere is locally inapplicable. */
  geography?: string | null;
  population?: string | null;
  timeframe?: string | null;
}

export interface KnowledgeInput {
  subject: string;
  claims: readonly KnowledgeSourceClaim[];
  scope?: KnowledgeScope;
  /**
   * Which facet a declared lane id answers. A lane mapped nowhere and carrying
   * no structured finding opens a facet named after the lane.
   */
  laneFacets?: Readonly<Record<string, string>>;
  /** Facets this question needs beyond the checklist. Each one with no claim is reported MISSING. */
  extraFacets?: readonly string[];
  now?: Date;
}

export interface FacetReading {
  facet: string;
  counts: Record<KnowledgeStatus, number>;
  /** True when at least one SUPPORTED claim answers it. */
  answered: boolean;
}

export interface KnowledgeReading {
  subject: string;
  claims: AtomicClaim[];
  facets: FacetReading[];
  /** Facets with no SUPPORTED claim, in checklist order: the information needs. */
  needs: string[];
  /** What evidence exists: sources, publishers and retrieval states, counted. */
  evidence: { claims: number; sources: number; primary: number; byRetrieval: Record<string, number> };
}

const normal = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The facet a claim answers, read from its declared structure — never from its prose. */
export function facetOf(claim: KnowledgeSourceClaim, laneFacets: Readonly<Record<string, string>> = {}): string {
  const lane = claim.evidenceLane ? laneFacets[claim.evidenceLane] : undefined;
  if (lane) return lane;
  switch (claim.structuralFinding) {
    case 'SUB_INDUSTRY':
    case 'VALUE_CHAIN_LAYER':
    case 'TRANSACTION_TYPE':
      return 'definition';
    case 'BUYER_TYPE':
      return 'buyer_behavior';
    case 'FULFILMENT_SOURCE':
      return 'supplier_behavior';
    case 'BOTTLENECK':
    case 'HIDDEN_CONSTRAINT':
    case 'CAPITAL_REQUIREMENT':
    case 'CAPITAL_RESTRUCTURING':
      return 'constraints';
    case 'ADJACENT_INDUSTRY':
      return 'competition';
    case 'UNIT_ECONOMIC':
      return 'prices';
    default:
      break;
  }
  if (claim.structuralFinding) return 'actors';
  if (claim.laborFinding === 'HUMAN_REQUIREMENT') return 'rules';
  if (claim.laborFinding === 'SOURCING_CHANNEL') return 'supplier_behavior';
  if (claim.laborFinding) return 'infrastructure';
  if (claim.closesOn) return 'timing';
  if (claim.evidenceLane) return normal(claim.evidenceLane).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unclassified';
  return 'unclassified';
}

function provenanceOf(claim: KnowledgeSourceClaim): Provenance {
  return {
    sourceUrl: claim.sourceUrl,
    sourceTitle: claim.sourceTitle,
    publisher: claim.sourcePublisher,
    publishedAt: claim.sourceDate,
    retrievedAt: claim.retrievedAt,
    retrievalState: claim.retrievalState,
    lane: claim.evidenceLane,
    primary: claim.primarySource,
  };
}

function scopeMismatch(claim: KnowledgeSourceClaim, scope: KnowledgeScope): string | null {
  for (const key of ['geography', 'population', 'timeframe'] as const) {
    const wanted = scope[key];
    const held = claim[key];
    if (wanted && held && normal(wanted) !== normal(held)) return `It is about ${key} "${held}", and the question is about "${wanted}".`;
  }
  return null;
}

/** The status of one claim before claims are compared with each other. */
function ownStatus(claim: KnowledgeSourceClaim, scope: KnowledgeScope, now: Date, supersededBy: ReadonlyMap<string, string>): { status: KnowledgeStatus; reason: string; related: string[] } {
  if (!claim.sourceUrl || !claim.sourced) {
    return { status: 'MISSING', reason: 'The claim names no citable source, so it is not evidence of anything.', related: [] };
  }
  if (claim.contradictionState === 'REFUTED' || claim.contradictionState === 'CONTESTED') {
    return { status: 'CONFLICTING', reason: `Recorded as ${claim.contradictionState.toLowerCase()}${claim.contradictionNote ? `: ${claim.contradictionNote}` : '.'}`, related: claim.reconciledClaimId ? [claim.reconciledClaimId] : [] };
  }
  if (claim.reconciliation === 'CONTRADICTS' && claim.contradictionKind === 'DIRECT_FACTUAL_CONFLICT') {
    return { status: 'CONFLICTING', reason: 'Reconciled as a direct factual conflict with an earlier claim.', related: claim.reconciledClaimId ? [claim.reconciledClaimId] : [] };
  }
  if (claim.invalidationMetAt) {
    return { status: 'OUTDATED', reason: `Its invalidating condition was met on ${claim.invalidationMetAt}${claim.invalidationNote ? `: ${claim.invalidationNote}` : '.'}`, related: [] };
  }
  if (claim.validUntil && claim.validUntil < now.toISOString().slice(0, 10)) {
    return { status: 'OUTDATED', reason: `The source says it held until ${claim.validUntil}.`, related: [] };
  }
  const newer = supersededBy.get(claim.id);
  if (newer) return { status: 'OUTDATED', reason: `A newer reading (${newer}) updated it as stale.`, related: [newer] };
  const mismatch = scopeMismatch(claim, scope);
  if (mismatch) return { status: 'LOCALLY_INAPPLICABLE', reason: mismatch, related: [] };
  if (claim.reconciliation === 'CONTRADICTS' && claim.contradictionKind && claim.contradictionKind !== 'RESOLVED_BY_CONTEXT') {
    const kind = claim.contradictionKind.toLowerCase().replace(/_/g, ' ');
    return { status: 'LOCALLY_INAPPLICABLE', reason: `It disagrees with an earlier claim by ${kind}, not on the facts: it answers a differently scoped question.`, related: claim.reconciledClaimId ? [claim.reconciledClaimId] : [] };
  }
  if (claim.retrievalState !== 'RETRIEVED') {
    return { status: 'MISSING', reason: `Its source was never read (${claim.retrievalState}); the claim is unresolved, not supported.`, related: [] };
  }
  return { status: 'SUPPORTED', reason: claim.primarySource ? 'Sourced from a primary source that was read.' : 'Sourced from a secondary source that was read.', related: [] };
}

/**
 * Read claims into atomic, sourced knowledge with an explicit status each, and
 * name every facet nobody has evidenced. Pure.
 */
export function acquireKnowledge(input: KnowledgeInput): KnowledgeReading {
  const now = input.now ?? new Date();
  const scope = input.scope ?? {};
  const live = input.claims.filter((claim) => claim.accepted);

  const supersededBy = new Map<string, string>();
  for (const claim of live) if (claim.reconciliation === 'UPDATES_STALE' && claim.reconciledClaimId) supersededBy.set(claim.reconciledClaimId, claim.id);

  const out: AtomicClaim[] = live.map((claim) => {
    const own = ownStatus(claim, scope, now, supersededBy);
    return {
      id: claim.id,
      facet: facetOf(claim, input.laneFacets),
      text: claim.claim,
      status: own.status,
      reason: own.reason,
      provenance: provenanceOf(claim),
      scope: { geography: claim.geography, timeframe: claim.timeframe, population: claim.population, definition: claim.definition },
      related: own.related,
    };
  });

  // Two supported claims about the same thing that cannot both be right are both conflicting.
  const byId = new Map(live.map((claim) => [claim.id, claim]));
  const supported = out.filter((one) => one.status === 'SUPPORTED');
  for (let i = 0; i < supported.length; i += 1) {
    for (let j = i + 1; j < supported.length; j += 1) {
      const a = supported[i]!;
      const b = supported[j]!;
      if (a.facet !== b.facet || !a.text || !b.text || !aboutTheSameThing(a.text, b.text)) continue;
      const left = byId.get(a.id)!;
      const right = byId.get(b.id)!;
      const verdict = classifyContradiction(
        { ...left, sourcePublisher: left.sourcePublisher, claimType: left.claimType },
        { ...right, sourcePublisher: right.sourcePublisher, claimType: right.claimType },
      );
      if (!verdict.material) continue;
      for (const [one, other] of [[a, b], [b, a]] as const) {
        one.status = 'CONFLICTING';
        one.reason = `${verdict.reason}${verdict.resolutionQuestion ? ` Settle by: ${verdict.resolutionQuestion}` : ''}`;
        if (!one.related.includes(other.id)) one.related.push(other.id);
      }
    }
  }

  const facetNames = [...new Set([...KNOWLEDGE_FACETS, ...(input.extraFacets ?? []), ...out.map((one) => one.facet)])];
  const empty = (): Record<KnowledgeStatus, number> => ({ SUPPORTED: 0, CONFLICTING: 0, OUTDATED: 0, LOCALLY_INAPPLICABLE: 0, MISSING: 0 });
  const facets: FacetReading[] = facetNames.map((facet) => {
    const counts = empty();
    for (const one of out) if (one.facet === facet) counts[one.status] += 1;
    return { facet, counts, answered: counts.SUPPORTED > 0 };
  });
  const needs = facets.filter((one) => !one.answered && one.facet !== 'unclassified').map((one) => one.facet);
  for (const facet of needs) {
    const held = facets.find((one) => one.facet === facet)!;
    const others = KNOWLEDGE_STATUSES.filter((status) => status !== 'SUPPORTED' && held.counts[status] > 0);
    out.push({
      id: `missing:${facet}`,
      facet,
      text: null,
      status: 'MISSING',
      reason: others.length > 0
        ? `No supported claim answers it; what exists is ${others.map((status) => `${held.counts[status]} ${status.toLowerCase().replace(/_/g, ' ')}`).join(', ')}.`
        : 'Nobody has evidenced it. It is an information need, not a value.',
      provenance: null,
      scope: { geography: scope.geography ?? null, timeframe: scope.timeframe ?? null, population: scope.population ?? null, definition: null },
      related: [],
    });
    held.counts.MISSING += 1;
  }

  const byRetrieval: Record<string, number> = {};
  for (const claim of live) byRetrieval[claim.retrievalState] = (byRetrieval[claim.retrievalState] ?? 0) + 1;
  return {
    subject: input.subject,
    claims: out,
    facets,
    needs,
    evidence: {
      claims: live.length,
      sources: new Set(live.map((claim) => claim.sourceUrl).filter((url): url is string => Boolean(url))).size,
      primary: live.filter((claim) => claim.primarySource).length,
      byRetrieval,
    },
  };
}

/**
 * A project's knowledge, read from the gated claims every non-fixture research
 * packet of the project holds. Reads through the repository; writes nothing.
 */
export async function loadProjectKnowledge(projectId: string, input: Omit<KnowledgeInput, 'claims'>): Promise<KnowledgeReading> {
  const packets = (await listOrchestrationsByProject(projectId)).filter((one) => !one.fixture);
  const claims: ResearchClaim[] = [];
  for (const packet of packets) claims.push(...(await citableClaims(packet.id)));
  return acquireKnowledge({ ...input, claims });
}

/* ------------------------------------------------------------------------- */
/* Layer 2: the mechanism of a transaction                                   */
/* ------------------------------------------------------------------------- */

/**
 * A starting checklist of questions most transactions answer — never a
 * universal form (S-0194: the graph is open-ended). Each role a domain has
 * becomes one or more graph nodes; a role the domain does not have is judged
 * not applicable from evidence (`notApplicable`) and is then neither a node,
 * an unknown nor a gap; anything the checklist lacks is added through
 * `types`, `extraNodes` and `relations`, and the default skeleton can be
 * replaced by the domain's own wiring (`skeleton: 'NONE'`).
 */
export const MECHANISM_ROLES = {
  initiator: { type: 'actor', question: 'Who initiates the transaction?' },
  access: { type: 'channel', question: 'How is access to the buyer won?' },
  rights: { type: 'right', question: 'Which rights, licences or permissions are needed?' },
  riskBearer: { type: 'liability', question: 'Whose balance sheet carries which risk?' },
  trigger: { type: 'acquisition_event', question: 'What triggers the purchase?' },
  deliverer: { type: 'supplier', question: 'Who delivers?' },
  moneyMovement: { type: 'payment', question: 'How does money move?' },
  failure: { type: 'failure_mode', question: 'What can fail?' },
  reusable: { type: 'asset', question: 'What is reusable afterwards?' },
} as const;
export type MechanismRole = keyof typeof MECHANISM_ROLES;
export const MECHANISM_ROLE_NAMES = Object.keys(MECHANISM_ROLES) as MechanismRole[];

export interface MechanismPart {
  id: string;
  label: string;
  /** Overrides the role's seed type; a type outside the vocabulary must be declared in `types`. */
  type?: string;
  /** Claim ids that evidence this part. Only a SUPPORTED claim counts. */
  evidence: string[];
  /** A figure the evidence states about this part, e.g. a price or a payment term. */
  figure?: { meaning: string; unit: string; value: number };
  attributes?: Record<string, string | number | boolean | null>;
}

export interface MechanismInput {
  subject: string;
  knowledge: KnowledgeReading;
  roles: Partial<Record<MechanismRole, MechanismPart | MechanismPart[]>>;
  /** Types the domain needs beyond the seed vocabulary, each with why. */
  types?: { kind: 'node' | 'relation'; name: string; reason: string }[];
  /**
   * Checklist roles this domain does not have, each with why and the claim ids
   * that show it (Brain judges fitness per case from evidence). A judged role
   * is recorded as NOT_APPLICABLE: no node, not unknown, no skeleton edge.
   * Without a supported claim the judgment is refused rather than assumed.
   */
  notApplicable?: Partial<Record<MechanismRole, { reason: string; evidence: string[] }>>;
  /** 'DEFAULT' wires the checklist skeleton between present roles; 'NONE' wires only `relations` and `routes`. */
  skeleton?: 'DEFAULT' | 'NONE';
  /** Further parts outside the checklist roles: the graph is open-ended. */
  extraNodes?: MechanismPart[];
  /** Relations beyond the default skeleton. */
  relations?: { id: string; type: string; from: string; to: string; label?: string }[];
  routes?: MoneyRoute[];
}

export interface RoleReading {
  role: MechanismRole;
  question: string;
  nodes: string[];
  /** KNOWN when every part has supported evidence; NOT_APPLICABLE when evidence shows the domain has no such role; UNKNOWN otherwise. */
  status: 'KNOWN' | 'UNKNOWN' | 'NOT_APPLICABLE';
  reason: string;
}

export interface MechanismModel {
  graph: CausalGraph;
  roles: RoleReading[];
  /** Roles without evidence, by name: what research must still establish. A role judged not applicable is never here. */
  unknown: MechanismRole[];
  /** Checklist roles the domain does not have, with the evidence that says so. */
  notApplicable: { role: MechanismRole; reason: string; evidence: string[] }[];
  /** Types declared beyond the seed vocabulary, with the reason each was needed. */
  declaredTypes: { kind: 'node' | 'relation'; name: string; reason: string }[];
  /** Variables the graph implies but does not hold (`discoverMissing`). */
  gaps: Discovery[];
}

export type MechanismResult = { ok: true; model: MechanismModel } | { ok: false; reason: string };

/** The default causal skeleton between checklist roles; an edge touching an absent role is not drawn. */
const SKELETON: { from: MechanismRole; to: MechanismRole; type: string }[] = [
  { from: 'access', to: 'initiator', type: 'authorizes' },
  { from: 'initiator', to: 'trigger', type: 'causes' },
  { from: 'trigger', to: 'moneyMovement', type: 'causes' },
  { from: 'rights', to: 'deliverer', type: 'authorizes' },
  { from: 'deliverer', to: 'initiator', type: 'delivers' },
  { from: 'moneyMovement', to: 'deliverer', type: 'pays' },
  { from: 'failure', to: 'moneyMovement', type: 'constrains' },
  { from: 'riskBearer', to: 'failure', type: 'depends_on' },
  { from: 'reusable', to: 'deliverer', type: 'depends_on' },
];

/**
 * Model how a transaction happens in a domain on the causal graph. A role with
 * no part, or a part whose evidence is not a supported claim, is added as a
 * node marked UNKNOWN with an unknown figure — never a value.
 */
export function buildMechanismModel(input: MechanismInput): MechanismResult {
  const graph = createGraph(input.subject);
  const declaredTypes: MechanismModel['declaredTypes'] = [];
  for (const one of input.types ?? []) {
    const result = declareType(graph, one.kind, one.name, one.reason);
    if (!result.ok) return { ok: false, reason: `Type ${one.name}: ${result.reason}` };
    declaredTypes.push(one);
  }

  const known = new Map(input.knowledge.claims.map((claim) => [claim.id, claim]));
  const evidenced = (part: MechanismPart): { ok: boolean; reason: string; source: string | null; retrievedAt: string | null } => {
    const usable = part.evidence.map((id) => known.get(id)).filter((claim): claim is AtomicClaim => claim?.status === 'SUPPORTED');
    if (usable.length === 0) {
      const named = part.evidence.map((id) => known.get(id)).filter((claim): claim is AtomicClaim => Boolean(claim));
      const why = part.evidence.length === 0
        ? 'no evidence was cited'
        : named.length === 0
          ? 'the cited claims are not in this project\'s knowledge'
          : `the cited claims are ${[...new Set(named.map((claim) => claim.status.toLowerCase().replace(/_/g, ' ')))].join(', ')}`;
      return { ok: false, reason: why, source: null, retrievedAt: null };
    }
    const first = usable[0]!;
    return { ok: true, reason: `evidenced by ${usable.map((claim) => claim.id).join(', ')}`, source: first.provenance?.sourceUrl ?? null, retrievedAt: first.provenance?.retrievedAt ?? null };
  };

  const addPart = (part: MechanismPart, fallbackType: string, role: string): { ok: true; known: boolean; reason: string } | { ok: false; reason: string } => {
    const proof = evidenced(part);
    const result = addNode(graph, {
      id: part.id,
      type: part.type ?? fallbackType,
      label: part.label,
      attributes: { ...(part.attributes ?? {}), role, status: proof.ok ? 'KNOWN' : 'UNKNOWN', evidence: part.evidence.join(',') || null, source: proof.source, retrievedAt: proof.retrievedAt },
    });
    if (!result.ok) return result;
    if (part.figure) {
      const figure = proof.ok
        ? makeFigure({ ...part.figure, status: 'EVIDENCED', source: proof.source, scope: input.subject })
        : { ok: true as const, figure: unknownFigure(part.figure.meaning, part.figure.unit, [`evidence for ${part.label}`]) };
      if (!figure.ok) return { ok: false, reason: `${part.label}: ${figure.reason}` };
      recordClaim(graph, part.id, figure.figure);
    }
    return { ok: true, known: proof.ok, reason: proof.reason };
  };

  const roles: RoleReading[] = [];
  const roleNodes = new Map<MechanismRole, string[]>();
  const notApplicable: MechanismModel['notApplicable'] = [];
  for (const role of MECHANISM_ROLE_NAMES) {
    const spec = MECHANISM_ROLES[role];
    const given = input.roles[role];
    const absent = input.notApplicable?.[role];
    if (absent !== undefined) {
      if (given !== undefined) return { ok: false, reason: `${role}: a role cannot both have parts and be judged not applicable.` };
      if (!absent.reason.trim()) return { ok: false, reason: `${role}: a not-applicable judgment states why.` };
      const proof = evidenced({ id: `na:${role}`, label: role, evidence: absent.evidence });
      if (!proof.ok) return { ok: false, reason: `${role}: not applicable is a judgment from evidence, and ${proof.reason}.` };
      notApplicable.push({ role, reason: absent.reason.trim(), evidence: [...absent.evidence] });
      roles.push({ role, question: spec.question, nodes: [], status: 'NOT_APPLICABLE', reason: `${absent.reason.trim()} (${proof.reason})` });
      continue;
    }
    const parts = given === undefined ? [] : Array.isArray(given) ? given : [given];
    if (parts.length === 0) {
      const id = `unknown:${role}`;
      const added = addNode(graph, { id, type: spec.type, label: `${spec.question} (unknown)`, attributes: { role, status: 'UNKNOWN', evidence: null, source: null, retrievedAt: null } });
      if (!added.ok) return added;
      roleNodes.set(role, [id]);
      roles.push({ role, question: spec.question, nodes: [id], status: 'UNKNOWN', reason: 'Nobody has stated it, so it is unknown rather than assumed.' });
      continue;
    }
    const reasons: string[] = [];
    let allKnown = true;
    for (const part of parts) {
      const added = addPart(part, spec.type, role);
      if (!added.ok) return { ok: false, reason: `${role}: ${added.reason}` };
      if (!added.known) allKnown = false;
      reasons.push(`${part.label}: ${added.reason}`);
    }
    roleNodes.set(role, parts.map((part) => part.id));
    roles.push({ role, question: spec.question, nodes: parts.map((part) => part.id), status: allKnown ? 'KNOWN' : 'UNKNOWN', reason: reasons.join('; ') });
  }

  for (const part of input.extraNodes ?? []) {
    const added = addPart(part, part.type ?? 'actor', 'extra');
    if (!added.ok) return { ok: false, reason: `extra: ${added.reason}` };
  }

  let n = 0;
  for (const edge of input.skeleton === 'NONE' ? [] : SKELETON) {
    for (const from of roleNodes.get(edge.from) ?? []) {
      for (const to of roleNodes.get(edge.to) ?? []) {
        n += 1;
        const added = addRelation(graph, { id: `skeleton:${n}`, type: edge.type, from, to });
        if (!added.ok) return added;
      }
    }
  }
  for (const relation of input.relations ?? []) {
    const added = addRelation(graph, relation);
    if (!added.ok) return added;
  }
  for (const route of input.routes ?? []) {
    const added = addMoneyRoute(graph, route);
    if (!added.ok) return added;
  }

  return {
    ok: true,
    model: {
      graph,
      roles,
      unknown: roles.filter((one) => one.status === 'UNKNOWN').map((one) => one.role),
      notApplicable,
      declaredTypes,
      gaps: discoverMissing(graph),
    },
  };
}

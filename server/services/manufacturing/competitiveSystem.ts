/**
 * The competitive system of an unfamiliar industry, reconstructed from evidence
 * (VENT-24-1).
 *
 * ---------------------------------------------------------------------------
 * The mechanisms come from the claims, never from a blueprint
 * ---------------------------------------------------------------------------
 *
 * The specification names many things a market *may* turn on: segments,
 * switching costs, substitutes, quality requirements, IP, sourcing, production,
 * supplier reliability, distribution, service, regulation, capital, sales
 * cycles, cash conversion. Turning that sentence into the output would be the
 * fixed "ten-box blueprint" it refuses, so it is used for exactly one thing
 * here: prompts. A prompt nobody has evidence for becomes an **open research
 * question**, never a box on the map. The map itself holds only mechanisms that
 * an accepted, sourced claim names, including ones no prompt anticipated — so
 * the number and the kind of mechanisms emerge from the problem, and two
 * industries produce two different maps.
 *
 * ---------------------------------------------------------------------------
 * Three readings, because they are three different questions
 * ---------------------------------------------------------------------------
 *
 * Making the product, making a company that can sell it, and holding a durable
 * position are separate. Each is read from the conditions the claims attach to
 * it. An unknown condition never makes a reading established (invariant 39),
 * and a reading with no conditions at all is UNKNOWN rather than met.
 *
 * Pure: it reads the claims a caller passes and writes nothing. A claim that
 * has not cleared the evidence gate, or carries no source, is not evidence and
 * is ignored here (§10, §14). `competitiveSystemsFor` is the production entrance:
 * the manufacturing kernel calls it on every tick with the ladder's rows, and it
 * reads each cited claim's gate state and source from the research claims store.
 */
import type {
  AcquisitionCandidate,
  CategoryCapitalEntry,
  CategoryEvidenceEntry,
} from '../../domain/types.ts';
import { claimsByIds } from '../../repos/research.ts';
import type { LadderSnapshot } from './ladder.ts';

/** How an activity can be obtained. */
export const ACQUISITION_MODES = ['RENT', 'CONTRACT', 'LICENSE', 'PARTNER', 'OWN_OR_DEVELOP'] as const;
export type AcquisitionMode = (typeof ACQUISITION_MODES)[number];

/** The three separate things a venture has to achieve in a market. */
export const COMPETITIVE_LEVELS = ['PRODUCT', 'SELLING_COMPANY', 'DURABLE_POSITION'] as const;
export type CompetitiveLevel = (typeof COMPETITIVE_LEVELS)[number];

/**
 * One research claim about the industry, as the evidence gate left it.
 *
 * Every optional part is something the claim itself states; a part it does not
 * state is absent, never inferred.
 */
export interface CompetitiveClaim {
  id: string;
  /** Cleared the evidence gate. */
  accepted: boolean;
  sourceUrl: string | null;
  /** The causal mechanism the claim is about, in the claim's own words. */
  mechanism: string;
  statement: string;
  /** Where participants earn margin, when the claim says so. */
  profitPool?: { name: string; marginShare?: number | null } | null;
  /** A resource or asset the claim says confers advantage. */
  advantage?: { resource: string } | null;
  /** How an activity can be obtained, when the claim says so. */
  activity?: { name: string; mode: AcquisitionMode; reason: string } | null;
  /** A condition one of the three levels depends on, and whether it is met (null: not known). */
  condition?: { level: CompetitiveLevel; requirement: string; met: boolean | null } | null;
}

export interface Mechanism {
  key: string;
  name: string;
  claimIds: string[];
  statements: string[];
}

export interface OpenQuestion {
  prompt: string;
  question: string;
}

export interface ProfitPool {
  name: string;
  /** The largest share any claim states; null when none states one. */
  marginShare: number | null;
  claimIds: string[];
}

export interface AdvantageResource {
  resource: string;
  claimIds: string[];
}

export interface ActivityClassification {
  activity: string;
  mode: AcquisitionMode;
  reasons: string[];
  claimIds: string[];
  /** True when claims disagree on the mode; the strongest-commitment mode is kept and the disagreement named. */
  contested: boolean;
}

export type LevelVerdict = 'ESTABLISHED' | 'NOT_MET' | 'UNKNOWN';

export interface LevelReading {
  level: CompetitiveLevel;
  verdict: LevelVerdict;
  met: { requirement: string; claimIds: string[] }[];
  unmet: { requirement: string; claimIds: string[] }[];
  unknown: { requirement: string; claimIds: string[] }[];
  because: string;
}

export interface CompetitiveSystem {
  subject: string;
  mechanisms: Mechanism[];
  openQuestions: OpenQuestion[];
  profitPools: ProfitPool[];
  advantages: AdvantageResource[];
  activities: ActivityClassification[];
  readings: Record<CompetitiveLevel, LevelReading>;
  /** Claims left out, and why: not accepted, or no source. */
  ignored: { claimId: string; why: string }[];
}

/**
 * Concerns the specification says a market *may* turn on. Prompts only: each
 * one without evidence becomes an open question, and none is ever placed on the
 * map by being listed here.
 */
export const MECHANISM_PROMPTS: readonly { prompt: string; matches: RegExp }[] = [
  { prompt: 'customer segments', matches: /segment|customer|buyer type/ },
  { prompt: 'buyer motivations and switching costs', matches: /motivat|switching|lock.?in/ },
  { prompt: 'competing products and substitute solutions', matches: /compet|substitut|rival|alternative/ },
  { prompt: 'performance and quality requirements', matches: /performance|quality|specification|tolerance/ },
  { prompt: 'design and engineering', matches: /design|engineer/ },
  { prompt: 'intellectual property and rights', matches: /intellectual|patent|\bip\b|licen[cs]|rights|trademark/ },
  { prompt: 'sourcing, components and materials', matches: /sourc|component|material|input/ },
  { prompt: 'manufacturing and production options', matches: /manufactur|production|fabricat|assembl/ },
  { prompt: 'procurement and supplier reliability', matches: /procure|supplier|vendor/ },
  { prompt: 'distribution and marketing', matches: /distribut|channel|marketing|dealer|retail/ },
  { prompt: 'after-sales and service operations', matches: /after.?sales|service|warranty|maintenance|repair/ },
  { prompt: 'regulation, standards and liability', matches: /regulat|standard|certif|liabil|complian/ },
  { prompt: 'financial and capital requirements', matches: /capital|financ|invest|funding/ },
  { prompt: 'sales cycles, cash conversion and working capital', matches: /sales cycle|cash conversion|working capital|payment terms|receivable/ },
];

/** Higher means more commitment; a contested activity keeps the most committed mode any claim requires. */
const MODE_COMMITMENT: Record<AcquisitionMode, number> = { RENT: 0, CONTRACT: 1, LICENSE: 2, PARTNER: 3, OWN_OR_DEVELOP: 4 };

function keyOf(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isEvidence(claim: CompetitiveClaim): string | null {
  if (!claim.accepted) return 'not accepted by the evidence gate';
  if (!claim.sourceUrl || !claim.sourceUrl.trim()) return 'carries no source';
  if (!claim.mechanism.trim()) return 'names no mechanism';
  return null;
}

function openQuestionFor(subjectPath: readonly string[], prompt: string): string {
  // A path, never a leaf: the same scoping rule the programme questions follow (questions.ts).
  const subject = subjectPath.length > 0 ? subjectPath.join(' → ') : 'this industry';
  return (
    `In ${subject}, what do primary sources establish about ${prompt}, and does it actually decide ` +
    'who wins and who earns margin? Report only what a source states, with the source.'
  );
}

function readLevel(level: CompetitiveLevel, claims: readonly CompetitiveClaim[]): LevelReading {
  const byRequirement = new Map<string, { requirement: string; claimIds: string[]; met: (boolean | null)[] }>();
  for (const claim of claims) {
    const c = claim.condition;
    if (!c || c.level !== level) continue;
    const k = keyOf(c.requirement);
    const row = byRequirement.get(k) ?? { requirement: c.requirement.trim(), claimIds: [], met: [] };
    row.claimIds.push(claim.id);
    row.met.push(c.met);
    byRequirement.set(k, row);
  }
  const met: LevelReading['met'] = [];
  const unmet: LevelReading['unmet'] = [];
  const unknown: LevelReading['unknown'] = [];
  for (const row of byRequirement.values()) {
    const entry = { requirement: row.requirement, claimIds: row.claimIds };
    // Any claim saying it is not met wins; it is met only when every claim that speaks says so.
    if (row.met.some((m) => m === false)) unmet.push(entry);
    else if (row.met.length > 0 && row.met.every((m) => m === true)) met.push(entry);
    else unknown.push(entry);
  }
  let verdict: LevelVerdict;
  let because: string;
  if (unmet.length > 0) {
    verdict = 'NOT_MET';
    because = `${unmet.length} requirement(s) the evidence says are not met`;
  } else if (unknown.length > 0) {
    verdict = 'UNKNOWN';
    because = `${unknown.length} requirement(s) not yet known; an unknown never establishes a level`;
  } else if (met.length === 0) {
    verdict = 'UNKNOWN';
    because = 'no claim states what this level requires';
  } else {
    verdict = 'ESTABLISHED';
    because = `all ${met.length} stated requirement(s) are met on the evidence`;
  }
  return { level, verdict, met, unmet, unknown, because };
}

/** Reconstruct the competitive system of one subject from the claims about it. Pure. */
export function reconstructCompetitiveSystem(input: {
  subjectPath: readonly string[];
  claims: readonly CompetitiveClaim[];
}): CompetitiveSystem {
  const ignored: CompetitiveSystem['ignored'] = [];
  const evidence: CompetitiveClaim[] = [];
  for (const claim of input.claims) {
    const why = isEvidence(claim);
    if (why) ignored.push({ claimId: claim.id, why });
    else evidence.push(claim);
  }

  const mechanisms = new Map<string, Mechanism>();
  for (const claim of evidence) {
    const k = keyOf(claim.mechanism);
    const m = mechanisms.get(k) ?? { key: k, name: claim.mechanism.trim(), claimIds: [], statements: [] };
    m.claimIds.push(claim.id);
    if (claim.statement.trim()) m.statements.push(claim.statement.trim());
    mechanisms.set(k, m);
  }

  const covered = (matches: RegExp) => [...mechanisms.keys()].some((k) => matches.test(k));
  const openQuestions = MECHANISM_PROMPTS.filter((p) => !covered(p.matches)).map((p) => ({
    prompt: p.prompt,
    question: openQuestionFor(input.subjectPath, p.prompt),
  }));

  const pools = new Map<string, ProfitPool>();
  for (const claim of evidence) {
    if (!claim.profitPool) continue;
    const k = keyOf(claim.profitPool.name);
    const pool = pools.get(k) ?? { name: claim.profitPool.name.trim(), marginShare: null, claimIds: [] };
    pool.claimIds.push(claim.id);
    const share = claim.profitPool.marginShare;
    if (typeof share === 'number' && Number.isFinite(share)) pool.marginShare = Math.max(pool.marginShare ?? share, share);
    pools.set(k, pool);
  }

  const advantages = new Map<string, AdvantageResource>();
  for (const claim of evidence) {
    if (!claim.advantage) continue;
    const k = keyOf(claim.advantage.resource);
    const a = advantages.get(k) ?? { resource: claim.advantage.resource.trim(), claimIds: [] };
    a.claimIds.push(claim.id);
    advantages.set(k, a);
  }

  const activities = new Map<string, ActivityClassification & { modes: Set<AcquisitionMode> }>();
  for (const claim of evidence) {
    const act = claim.activity;
    if (!act) continue;
    const k = keyOf(act.name);
    const row = activities.get(k) ?? { activity: act.name.trim(), mode: act.mode, reasons: [], claimIds: [], contested: false, modes: new Set() };
    row.modes.add(act.mode);
    if (MODE_COMMITMENT[act.mode] > MODE_COMMITMENT[row.mode]) row.mode = act.mode;
    if (act.reason.trim()) row.reasons.push(act.reason.trim());
    row.claimIds.push(claim.id);
    row.contested = row.modes.size > 1;
    activities.set(k, row);
  }

  const readings = Object.fromEntries(COMPETITIVE_LEVELS.map((level) => [level, readLevel(level, evidence)])) as Record<
    CompetitiveLevel,
    LevelReading
  >;

  return {
    subject: input.subjectPath.join(' → '),
    mechanisms: [...mechanisms.values()],
    openQuestions,
    profitPools: [...pools.values()].sort((a, b) => (b.marginShare ?? -1) - (a.marginShare ?? -1)),
    advantages: [...advantages.values()],
    activities: [...activities.values()].map(({ modes: _modes, ...rest }) => rest),
    readings,
    ignored,
  };
}

/* ------------------------------------------------------------------------- */
/* Fed from the ladder and the claims store, on the kernel tick               */
/* ------------------------------------------------------------------------- */

/**
 * The research claims' own gate state and source, by claim id. A claim id the
 * store does not return is absent from this map and is read as not evidence.
 */
export type ClaimGate = ReadonlyMap<string, { accepted: boolean; sourceUrl: string | null }>;

/** One live category's rows, as the ladder snapshot holds them. */
export interface CategoryRows {
  categoryId: string;
  path: readonly string[];
  evidence: readonly Pick<CategoryEvidenceEntry, 'kind' | 'subject' | 'statement' | 'sourceClaimId'>[];
  capital: readonly Pick<CategoryCapitalEntry, 'requirement' | 'statement' | 'sourceClaimId'>[];
  candidates: readonly Pick<AcquisitionCandidate, 'name' | 'statement' | 'sourceClaimId' | 'setAsideAt'>[];
  /** Capabilities a source establishes this category requires, and whether this company holds each. */
  requires: readonly { name: string; heldAt: string | null; sourceClaimId: string }[];
}

function phrase(text: string): string {
  return text.toLowerCase().replace(/_/g, ' ');
}

/**
 * The claims one category's filed rows stand on, as competitive claims. Pure.
 *
 * Every mechanism is named from the row's own subject, so the map is as wide as
 * what research filed for that category and no wider. A kind adds only what
 * the kind itself states: a bought-in component is obtained by contract; an
 * entry barrier is a requirement on becoming a selling company whose status no
 * row states (UNKNOWN, invariant 39); a required capability is a product
 * requirement that is met only when a person has recorded it held (§39).
 */
export function claimsFromCategoryRows(rows: CategoryRows, gate: ClaimGate): CompetitiveClaim[] {
  const base = (sourceClaimId: string) => {
    const g = gate.get(sourceClaimId);
    return { id: sourceClaimId, accepted: g?.accepted ?? false, sourceUrl: g?.sourceUrl ?? null };
  };
  const out: CompetitiveClaim[] = [];
  for (const e of rows.evidence) {
    const subject = e.subject.trim();
    switch (e.kind) {
      case 'DEMAND_EVIDENCE':
        out.push({ ...base(e.sourceClaimId), mechanism: `customer demand: ${subject}`, statement: e.statement });
        break;
      case 'DISTRIBUTION_CHANNEL':
        out.push({ ...base(e.sourceClaimId), mechanism: `distribution channel: ${subject}`, statement: e.statement });
        break;
      case 'INCUMBENT_WEAKNESS':
        out.push({ ...base(e.sourceClaimId), mechanism: `competing incumbents: ${subject}`, statement: e.statement });
        break;
      case 'ENTRY_BARRIER':
        out.push({
          ...base(e.sourceClaimId),
          mechanism: `entry barrier: ${subject}`,
          statement: e.statement,
          condition: { level: 'SELLING_COMPANY', requirement: subject, met: null },
        });
        break;
      case 'BOUGHT_IN_COMPONENT':
        out.push({
          ...base(e.sourceClaimId),
          mechanism: `sourcing of bought-in components: ${subject}`,
          statement: e.statement,
          activity: { name: subject, mode: 'CONTRACT', reason: 'a source states participants buy it in rather than make it' },
        });
        break;
      default: {
        // A kind added later still reaches the map under its own name rather than being dropped.
        const kind: string = e.kind;
        out.push({ ...base(e.sourceClaimId), mechanism: `${phrase(kind)}: ${subject}`, statement: e.statement });
      }
    }
  }
  for (const c of rows.capital) {
    out.push({ ...base(c.sourceClaimId), mechanism: `capital requirement: ${phrase(c.requirement)}`, statement: c.statement });
  }
  for (const c of rows.candidates) {
    if (c.setAsideAt) continue;
    out.push({ ...base(c.sourceClaimId), mechanism: `acquirable supplier: ${c.name.trim()}`, statement: c.statement });
  }
  for (const r of rows.requires) {
    out.push({
      ...base(r.sourceClaimId),
      mechanism: `production capability: ${r.name.trim()}`,
      statement: `requires ${r.name.trim()}`,
      condition: { level: 'PRODUCT', requirement: r.name.trim(), met: r.heldAt !== null },
    });
  }
  return out;
}

/** Every live category's rows, split out of one ladder snapshot. Pure. */
export function categoryRowsOf(snapshot: Pick<LadderSnapshot, 'coverage' | 'edges' | 'capabilities'>): CategoryRows[] {
  const capabilityById = new Map(snapshot.capabilities.map((c) => [c.id, c]));
  return snapshot.coverage.map((cov) => ({
    categoryId: cov.category.id,
    path: cov.path,
    evidence: [...cov.demand, ...cov.distribution, ...cov.weaknesses, ...cov.barriers, ...cov.boughtIn],
    capital: cov.capital,
    candidates: cov.candidates,
    requires: snapshot.edges
      .filter((edge) => edge.categoryId === cov.category.id && edge.relation === 'REQUIRES')
      .flatMap((edge) => {
        const capability = capabilityById.get(edge.capabilityId);
        return capability ? [{ name: capability.name, heldAt: capability.heldAt, sourceClaimId: edge.sourceClaimId }] : [];
      }),
  }));
}

export interface CategoryCompetitiveSystem extends CompetitiveSystem {
  categoryId: string;
}

/**
 * The competitive system of every live category on a programme's ladder,
 * reconstructed from the claims its rows were filed from (VENT-24-1).
 *
 * Reads the research claims store for each claim's gate state and source in
 * one batch, so a claim that has since lost acceptance, or never carried a
 * source, is ignored rather than trusted because a row once cited it. Writes
 * nothing: re-derived on every kernel pass from rows.
 */
export async function competitiveSystemsFor(
  snapshot: Pick<LadderSnapshot, 'coverage' | 'edges' | 'capabilities'>,
): Promise<CategoryCompetitiveSystem[]> {
  const rows = categoryRowsOf(snapshot);
  const ids = [
    ...new Set(
      rows.flatMap((r) => [
        ...r.evidence.map((e) => e.sourceClaimId),
        ...r.capital.map((c) => c.sourceClaimId),
        ...r.candidates.map((c) => c.sourceClaimId),
        ...r.requires.map((c) => c.sourceClaimId),
      ]),
    ),
  ];
  const gate = new Map(
    ids.length === 0 ? [] : (await claimsByIds(ids)).map((c) => [c.id, { accepted: c.accepted, sourceUrl: c.sourceUrl }] as const),
  );
  return rows.map((r) => ({
    categoryId: r.categoryId,
    ...reconstructCompetitiveSystem({ subjectPath: r.path, claims: claimsFromCategoryRows(r, gate) }),
  }));
}

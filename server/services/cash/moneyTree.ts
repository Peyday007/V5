/**
 * The commercial money tree, read from what Brain already stores (§81/§82,
 * owner's requirement of August, reiterated 2026-11-14 and 2026-11-24).
 *
 * There is no second world model here. The tree's levels are rows Brain
 * already keeps:
 *
 *   commercial universe   every project's library, together
 *   → industry            the first name on a part's path (a SECTOR node, or an opening's industry)
 *   → sub-industry        the next name on that path
 *   → economic activity   the rest of the path above the buyer, and the need it pays for
 *   → mechanism           the §49 method a stored arrangement captures money by
 *   → transaction design  its design (structure, funding, aggregation, repeat)
 *   → economics           the reconstruction stored with it (`design_json`)
 *   → requirements        its supply, capital exposure and constraints
 *   → evidence            its claims, EVIDENCE facts and research verdict
 *
 * What was missing was the reading: for any mechanism, which of the eleven
 * questions the owner set are *established* on evidence, which Brain only
 * *hypothesises* from the design, and which nobody has answered. Without it
 * "how many mechanisms have meaningful economic evidence" had no answer, and
 * research could not be pointed at the dimension a mechanism lacks.
 *
 * Every status is read off fields the constructor already derived from gated
 * claims; nothing reads prose, and an absent field is UNKNOWN, never a
 * favourable assumption (invariant 39). A HYPOTHESIS is what the design says
 * must be true — never evidence that it is.
 */
import { getDb } from '../../db/database.ts';

/** The owner's eleven questions about every mechanism, in his order. */
export const MONEY_TREE_DIMENSIONS = [
  'PAYING_CUSTOMERS',
  'EXCHANGE',
  'ROLES_AND_CONTRACTS',
  'PRICES_COSTS_MARGINS',
  'ACQUISITION',
  'CONVERSION_AND_FREQUENCY',
  'CAPITAL_AND_CASH_TIMING',
  'SUPPLY_AND_FULFILMENT',
  'AI_AUTOMATION',
  'CONSTRAINTS_AND_RISKS',
  'EVIDENCE_AND_COMPARABLES',
] as const;
export type MoneyTreeDimension = (typeof MONEY_TREE_DIMENSIONS)[number];

export const DIMENSION_LABEL: Record<MoneyTreeDimension, string> = {
  PAYING_CUSTOMERS: 'paying customers and demand',
  EXCHANGE: 'products and services exchanged',
  ROLES_AND_CONTRACTS: 'commercial roles and contractual structures',
  PRICES_COSTS_MARGINS: 'prices, costs and margins',
  ACQUISITION: 'customer acquisition',
  CONVERSION_AND_FREQUENCY: 'conversion and transaction frequency',
  CAPITAL_AND_CASH_TIMING: 'capital requirements and cash timing',
  SUPPLY_AND_FULFILMENT: 'suppliers and fulfilment',
  AI_AUTOMATION: 'AI automation potential',
  CONSTRAINTS_AND_RISKS: 'constraints, risks and dependencies',
  EVIDENCE_AND_COMPARABLES: 'evidence and transferable comparables',
};

export type DimensionStatus = 'ESTABLISHED' | 'HYPOTHESIS' | 'UNKNOWN';

/** The fields of a stored arrangement this reading uses — a subset of `ConstructedArrangement`, read defensively from JSON. */
interface StoredPart {
  name?: string;
  claimId?: string | null;
  from?: string;
  path?: string;
}
interface StoredEstimate {
  tier?: string;
  observations?: number;
  sources?: string[];
  notEvidence?: string;
  evidence?: unknown;
  p50?: number | null;
}
export interface StoredArrangement {
  structure?: string;
  design?: { base?: string; funding?: string; aggregation?: string; repeat?: string };
  origin?: string;
  precedent?: { opportunityId: string } | null;
  sector?: string | null;
  demand?: StoredPart;
  need?: StoredPart | null;
  supply?: StoredPart | null;
  label?: string;
  stress?: { exposure?: string };
  evidenced?: number;
  value?: StoredEstimate;
  conversion?: StoredEstimate;
  fixedCost?: StoredEstimate;
  supplyCost?: StoredEstimate;
  commission?: StoredEstimate;
  unknownParts?: string[];
  relatedOpenings?: string[];
  buyerTerms?: unknown;
  repeatBusiness?: { observations?: number };
}

/** One stored mechanism, as the tree reads it. */
export interface MechanismInput {
  pathId: string;
  projectId: string;
  method: string;
  signature: string;
  design: { version?: number; arrangement?: StoredArrangement; constraints?: unknown[] } | null;
  verdict: 'CONFIRMED' | 'REFUTED' | null;
  /** EVIDENCE facts on the path (each resolves to a gated claim). */
  evidenceFacts: number;
  evaluatedCount: number;
  askedCount: number;
}

export interface MechanismReading {
  pathId: string;
  projectId: string;
  signature: string;
  method: string;
  industry: string;
  subIndustry: string;
  activity: string;
  design: string;
  label: string;
  dimensions: Record<MoneyTreeDimension, DimensionStatus>;
  established: number;
  /** Price evidence and either demand or conversion established: economics a plan can weigh. */
  meaningful: boolean;
  /** The dimensions nobody has answered: what research about this mechanism should ask first. */
  gaps: MoneyTreeDimension[];
  verdict: MechanismInput['verdict'];
  evaluated: boolean;
  asked: boolean;
}

/** Proved: Brain's own deliverable, which its capability path names. */
const isCapability = (part: StoredPart | null | undefined): boolean => part?.from === 'CAPABILITY';
const isReverse = (part: StoredPart | null | undefined): boolean => !part || part.from === 'REVERSE';
const gated = (part: StoredPart | null | undefined): boolean => !!part?.claimId || part?.from === 'OPENING';
const observed = (e: StoredEstimate | undefined): boolean => !!e && (e.observations ?? 0) > 0 && e.tier !== 'UNKNOWN' && !e.notEvidence;
/** A structure in which supply, not Brain, fulfils (the closed §81 table). */
const SUPPLY_STRUCTURES = new Set(['BROKER', 'REFERRAL', 'SUBCONTRACT', 'POOL']);

/** The names on a part's path, root first: `KIND:a>b>c` → [a, b, c]. */
export function pathNames(path: string | undefined): string[] {
  if (!path) return [];
  const at = path.indexOf(':');
  const body = at >= 0 ? path.slice(at + 1) : path;
  return body.split('>').map((one) => one.trim()).filter(Boolean);
}

/** Where a mechanism sits in the tree, from its buyer's path (or its need's, for a reverse design). */
export function placeOf(a: StoredArrangement): { industry: string; subIndustry: string; activity: string } {
  const demand = a.demand;
  if (isReverse(demand) && !demand?.path?.startsWith('INVENTED')) {
    return { industry: '(reverse design: buyers to be found)', subIndustry: '-', activity: a.need?.name ?? '-' };
  }
  /*
   * An opening's payer path is `OPENING_PAYER:<industry>><payer>`, and the
   * opening's industry is usually unrecorded (production 2026-11-24: none of
   * 695 openings names one), which leaves the payer's own sentence first.
   * That sentence is a buyer, never an industry.
   */
  if (demand?.path?.startsWith('OPENING_')) {
    const body = demand.path.slice(demand.path.indexOf(':') + 1);
    const cut = body.indexOf('>');
    const recorded = cut > 0 ? body.slice(0, cut).trim() : '';
    return { industry: a.sector ?? (recorded || '(opening: industry not recorded)'), subIndustry: '-', activity: a.need?.name ?? '-' };
  }
  const names = pathNames(demand?.path);
  const industry = a.sector ?? names[0] ?? '(unclassified)';
  const subIndustry = names.length >= 3 ? names[1]! : '-';
  const middle = names.slice(2, -1).join(' > ');
  const activity = [middle, a.need?.name].filter((one) => !!one).join(' : ') || '-';
  return { industry, subIndustry, activity };
}

/** The eleven statuses for one stored mechanism. Pure. */
export function dimensionsOf(input: MechanismInput): Record<MoneyTreeDimension, DimensionStatus> {
  const a: StoredArrangement = input.design?.arrangement ?? {};
  const unknown = new Set(a.unknownParts ?? []);
  const base = a.design?.base ?? a.structure ?? '';
  const needsSupply = SUPPLY_STRUCTURES.has(base);
  const named = (part: StoredPart | null | undefined) => !!part && !isReverse(part);
  const status = (established: boolean, hypothesis: boolean): DimensionStatus => (established ? 'ESTABLISHED' : hypothesis ? 'HYPOTHESIS' : 'UNKNOWN');

  const priced = observed(a.value);
  // Margin needs the other side of the price where supply is paid; Brain's own production needs only the price.
  const costed = !needsSupply || observed(a.supplyCost) || observed(a.commission) || observed(a.fixedCost);
  const constraints = Array.isArray(input.design?.constraints) ? input.design!.constraints!.length : 0;
  const exposure = a.stress?.exposure;

  return {
    // An opening's payer is a buyer observed asking or paying on a gated claim; a map population is established once its size is.
    PAYING_CUSTOMERS: status((a.demand?.from === 'OPENING' && !!a.demand.claimId) || (gated(a.demand) && !unknown.has('buyers')), named(a.demand)),
    EXCHANGE: status(gated(a.need) || isCapability(a.supply) || gated(a.supply), named(a.need) || !!a.supply),
    ROLES_AND_CONTRACTS: status(!!a.precedent || input.verdict === 'CONFIRMED', !!base),
    PRICES_COSTS_MARGINS: status(priced && costed, priced || (a.value?.p50 ?? null) !== null),
    // A channel is established when buyers of exactly this kind were found asking in public (held openings).
    ACQUISITION: status((a.relatedOpenings?.length ?? 0) > 0, named(a.demand)),
    CONVERSION_AND_FREQUENCY: status(
      observed(a.conversion) || (a.repeatBusiness?.observations ?? 0) > 0 || (!unknown.has('conversion') && !unknown.has('need_rate') && named(a.demand)),
      !!a.design?.repeat,
    ),
    CAPITAL_AND_CASH_TIMING: status(!!exposure && exposure !== 'UNKNOWN' && !!a.buyerTerms, !!exposure || !!a.design?.funding),
    SUPPLY_AND_FULFILMENT: status(
      isCapability(a.supply) || (gated(a.supply) && (!needsSupply || observed(a.supplyCost) || observed(a.commission))),
      !!a.supply || (!!base && !needsSupply),
    ),
    AI_AUTOMATION: status(isCapability(a.supply), !!base),
    CONSTRAINTS_AND_RISKS: status(constraints > 0 || input.verdict === 'REFUTED', !!exposure),
    EVIDENCE_AND_COMPARABLES: status(
      input.evidenceFacts > 0 || input.verdict !== null || (a.value?.sources?.length ?? 0) > 0 || !!a.precedent,
      (a.evidenced ?? 0) > 0,
    ),
  };
}

export function readMechanism(input: MechanismInput): MechanismReading {
  const a: StoredArrangement = input.design?.arrangement ?? {};
  const dimensions = dimensionsOf(input);
  const place = placeOf(a);
  const d = a.design;
  return {
    pathId: input.pathId,
    projectId: input.projectId,
    signature: input.signature,
    method: input.method,
    ...place,
    design: d ? [d.base, d.funding, d.aggregation, d.repeat].filter(Boolean).join('/') : a.structure ?? '-',
    label: a.label ?? '-',
    dimensions,
    established: MONEY_TREE_DIMENSIONS.filter((k) => dimensions[k] === 'ESTABLISHED').length,
    meaningful:
      dimensions.PRICES_COSTS_MARGINS === 'ESTABLISHED' &&
      (dimensions.PAYING_CUSTOMERS === 'ESTABLISHED' || dimensions.CONVERSION_AND_FREQUENCY === 'ESTABLISHED'),
    gaps: MONEY_TREE_DIMENSIONS.filter((k) => dimensions[k] === 'UNKNOWN'),
    verdict: input.verdict,
    evaluated: input.evaluatedCount > 0,
    asked: input.askedCount > 0,
  };
}

export interface MoneyTreeSummary {
  mechanisms: number;
  /** Distinct structures (signature) across every project: the same mechanism in two projects counts once. */
  uniqueMechanisms: number;
  industries: number;
  subIndustries: number;
  activities: number;
  methods: number;
  designs: number;
  withAnyEstablished: number;
  meaningful: number;
  confirmed: number;
  refuted: number;
  evaluated: number;
  asked: number;
  /** Per dimension: how many mechanisms hold it ESTABLISHED / HYPOTHESIS / UNKNOWN. */
  byDimension: Record<MoneyTreeDimension, Record<DimensionStatus, number>>;
  /** Industry → mechanisms, meaningful, established dimensions summed. */
  byIndustry: Array<{ industry: string; subIndustries: number; mechanisms: number; meaningful: number; methods: number }>;
}

export function summarize(readings: readonly MechanismReading[]): MoneyTreeSummary {
  const byDimension = Object.fromEntries(
    MONEY_TREE_DIMENSIONS.map((k) => [k, { ESTABLISHED: 0, HYPOTHESIS: 0, UNKNOWN: 0 } as Record<DimensionStatus, number>]),
  ) as Record<MoneyTreeDimension, Record<DimensionStatus, number>>;
  for (const one of readings) for (const k of MONEY_TREE_DIMENSIONS) byDimension[k][one.dimensions[k]] += 1;
  const industries = new Map<string, { subs: Set<string>; mechanisms: number; meaningful: number; methods: Set<string> }>();
  for (const one of readings) {
    const at = industries.get(one.industry) ?? { subs: new Set<string>(), mechanisms: 0, meaningful: 0, methods: new Set<string>() };
    at.subs.add(one.subIndustry);
    at.mechanisms += 1;
    if (one.meaningful) at.meaningful += 1;
    at.methods.add(one.method);
    industries.set(one.industry, at);
  }
  return {
    mechanisms: readings.length,
    uniqueMechanisms: new Set(readings.map((one) => one.signature)).size,
    industries: industries.size,
    subIndustries: new Set(readings.map((one) => `${one.industry}>${one.subIndustry}`)).size,
    activities: new Set(readings.map((one) => `${one.industry}>${one.subIndustry}>${one.activity}`)).size,
    methods: new Set(readings.map((one) => one.method)).size,
    designs: new Set(readings.map((one) => one.design)).size,
    withAnyEstablished: readings.filter((one) => one.established > 0).length,
    meaningful: readings.filter((one) => one.meaningful).length,
    confirmed: readings.filter((one) => one.verdict === 'CONFIRMED').length,
    refuted: readings.filter((one) => one.verdict === 'REFUTED').length,
    evaluated: readings.filter((one) => one.evaluated).length,
    asked: readings.filter((one) => one.asked).length,
    byDimension,
    byIndustry: [...industries.entries()]
      .map(([industry, one]) => ({ industry, subIndustries: one.subs.size, mechanisms: one.mechanisms, meaningful: one.meaningful, methods: one.methods.size }))
      .sort((a, b) => b.meaningful - a.meaningful || b.mechanisms - a.mechanisms || a.industry.localeCompare(b.industry)),
  };
}

/**
 * Every stored mechanism, read from the library: `projectId` for one
 * project's tree, omitted for the whole commercial universe. Paged by id, and
 * each page is handed to `visit` and let go, so a library of tens of
 * thousands of designs is never held in memory at once (production held
 * 15,217 on 2026-11-24).
 */
export async function eachMechanism(visit: (one: MechanismInput) => void, projectId?: string, pageSize = 500): Promise<number> {
  let seen = 0;
  let after = '';
  for (;;) {
    const rows = await getDb().all<{
      id: string;
      project_id: string;
      method: string;
      design_signature: string;
      design_json: string | null;
      research_verdict: string | null;
      evaluated_count: number | null;
      asked_count: number | null;
    }>(
      `SELECT id, project_id, method, design_signature, design_json, research_verdict, evaluated_count, asked_count
         FROM monetization_paths
        WHERE origin = 'CONSTRUCTED' AND design_signature IS NOT NULL AND id > ?${projectId ? ' AND project_id = ?' : ''}
        ORDER BY id LIMIT ?`,
      projectId ? [after, projectId, pageSize] : [after, pageSize],
    );
    if (rows.length === 0) break;
    const ids = rows.map((row) => row.id);
    const facts = new Map<string, number>();
    for (const row of await getDb().all<{ path_id: string; n: number }>(
      `SELECT path_id, COUNT(*) AS n FROM monetization_path_facts WHERE kind = 'EVIDENCE' AND path_id IN (${ids.map(() => '?').join(', ')}) GROUP BY path_id`,
      ids,
    )) {
      facts.set(row.path_id, Number(row.n));
    }
    for (const row of rows) {
      let design: MechanismInput['design'] = null;
      try {
        design = row.design_json ? (JSON.parse(row.design_json) as MechanismInput['design']) : null;
      } catch {
        design = null;
      }
      seen += 1;
      visit({
        pathId: row.id,
        projectId: row.project_id,
        method: row.method,
        signature: row.design_signature,
        design,
        verdict: row.research_verdict === 'CONFIRMED' || row.research_verdict === 'REFUTED' ? row.research_verdict : null,
        evidenceFacts: facts.get(row.id) ?? 0,
        evaluatedCount: Number(row.evaluated_count ?? 0),
        askedCount: Number(row.asked_count ?? 0),
      });
    }
    after = rows[rows.length - 1]!.id;
    if (rows.length < pageSize) break;
  }
  return seen;
}

/** The tree as one reading: every mechanism's statuses (designs let go) and the counts over them. */
export async function readMoneyTree(projectId?: string): Promise<{ summary: MoneyTreeSummary; mechanisms: MechanismReading[] }> {
  const mechanisms: MechanismReading[] = [];
  await eachMechanism((one) => mechanisms.push(readMechanism(one)), projectId);
  return { summary: summarize(mechanisms), mechanisms };
}

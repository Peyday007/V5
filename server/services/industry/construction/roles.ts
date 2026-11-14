/**
 * The commercial role, modelled separately from the industry (COM-13-1, §92).
 *
 * An industry says who pays whom for what. A role says where an operation can
 * stand inside one of those flows: lead source, distributor, affiliate or
 * referrer, broker or agent, representative, marketplace, booking/dispatch
 * coordinator, reseller, prime contractor, outsourced operator, technology
 * provider, capital arranger (only where a recorded gate permits it) and the
 * principal bearing delivery risk. Those are **seeds, not a whitelist**: a
 * party the evidence records in a role none of them names (an intermediary, a
 * platform, a financier, an insurer, an asset provider) is kept as its own
 * role, read from the evidence, with the same fields.
 *
 * For every flow and every role on it this records:
 *
 *   - whether Brain can legally and contractually occupy it — YES, NO or
 *     UNKNOWN, with the recorded gate (or recorded refusal) that decides it. A
 *     gate nobody recorded is UNKNOWN, never favourable (invariant 39);
 *   - what it controls, across the eight dimensions demand, supply,
 *     distribution, information, payment, financing, coordination and
 *     fulfilment rights;
 *   - what that control is worth per unit of work, from the evidence's own
 *     facts (`resolveFact`), and UNKNOWN where no fact states it;
 *   - the duties and risks that follow, including the gates it must pass and
 *     the recorded failure modes that apply to it.
 *
 * A role is keyed by flow and role, never by industry, and nothing here ranks a
 * role or an acquisition channel best across markets: the best role of a flow
 * is whichever the flow's own evidence values highest, so two markets with
 * different evidence answer differently, and a flow whose value nobody stated
 * has no best role. Every role maps onto the existing §92 `Position` values
 * (`allPositions` / `mechanismsOf` in `businesses.ts`) — there is no second
 * position model and no store. A physical service performed by others stays a
 * candidate: the operator doing the work itself (`SELF`) is the only position
 * the standing rule refuses, and no role here is built on it, so every role is
 * one Brain could own or operate remotely.
 *
 * Pure, except `commercialRolesHoldOnRows`, which only reads.
 */
import {
  type Actor,
  type ActorRole,
  type FactKey,
  type FactSource,
  type Flow,
  type Gate,
  type IndustryEvidence,
  type Mechanism,
  type Position,
  type Segment,
} from '../../../domain/construction.ts';
import { allPositions, appliesTo, mechanismsOf, positionKey } from './businesses.ts';
import { resolveFact } from './model.ts';

/* ------------------------------------------------------------------ vocabulary */

/** What a role can control. */
export const CONTROL_DIMENSIONS = ['DEMAND', 'SUPPLY', 'DISTRIBUTION', 'INFORMATION', 'PAYMENT', 'FINANCING', 'COORDINATION', 'FULFILMENT_RIGHTS'] as const;
export type ControlDimension = (typeof CONTROL_DIMENSIONS)[number];

/** How a role's control turns into money per unit of work, read from the evidence's facts. */
type ValueBasis = 'TAKE' | 'SPREAD' | 'PLACEMENT' | 'OPERATING' | 'NONE';

interface SeedRole {
  id: string;
  label: string;
  /** Which §92 positions express this role. */
  fits: (p: Position) => boolean;
  controls: ControlDimension[];
  value: ValueBasis;
  duties: string[];
  risks: string[];
  /** Enumerated only where a recorded gate permits it. */
  gatePermitted?: RegExp;
  /** Words that, in an evidence actor's name, mean the evidence names this seed rather than a new role. */
  names: RegExp;
}

const INTRODUCES = (p: Position) => p.contract === 'INTRODUCE';
const PRIME = (p: Position) => p.contract === 'PRIME';

/** The starting vocabulary. Extended by the evidence, never a ceiling on it. */
export const SEED_ROLES: readonly SeedRole[] = [
  {
    id: 'lead_source', label: 'lead source', fits: (p) => INTRODUCES(p) && p.information === 'NONE',
    controls: ['DEMAND', 'INFORMATION'], value: 'TAKE',
    duties: ['deliver buyers who match what the receiving operator accepts', 'keep consent for every contact passed on'],
    risks: ['paid only when the receiving operator converts the lead', 'the operator can go around the source once it knows the buyer'],
    names: /\blead(s| source| gen)/i,
  },
  {
    id: 'distributor', label: 'distributor', fits: (p) => PRIME(p) && p.supply === 'NETWORK' && p.aggregation === 'SINGLE',
    controls: ['DISTRIBUTION', 'DEMAND', 'PAYMENT'], value: 'SPREAD',
    duties: ['carry the supplier’s output to buyers under our own terms', 'collect from buyers and pay the supplier'],
    risks: ['holds what buyers do not take', 'the supplier can sell to the same buyers directly'],
    names: /\bdistribut/i,
  },
  {
    id: 'affiliate_referrer', label: 'affiliate or referrer', fits: (p) => INTRODUCES(p),
    controls: ['DEMAND'], value: 'TAKE',
    duties: ['disclose the referral relationship to the buyer'],
    risks: ['commission terms set by the party paying it', 'attribution can be disputed'],
    names: /\b(affiliate|referr)/i,
  },
  {
    id: 'broker_agent', label: 'broker or agent', fits: (p) => INTRODUCES(p) || p.supply === 'RECRUIT',
    controls: ['DEMAND', 'SUPPLY', 'INFORMATION'], value: 'TAKE',
    duties: ['match the buyer to a qualified operator and stand behind the match', 'hold any broker licence or bond the transaction requires'],
    risks: ['disintermediation once the parties have met', 'liability for a negligent selection'],
    names: /\b(broker|agent|agency)\b/i,
  },
  {
    id: 'representative', label: 'representative', fits: (p) => p.contract === 'REPRESENT',
    controls: ['DEMAND', 'SUPPLY'], value: 'TAKE',
    duties: ['sell the represented operators’ capacity honestly and account to them'],
    risks: ['paid by the operators, so their capacity bounds every sale', 'a represented operator’s failure lands on the relationship'],
    names: /\b(represent|rep firm|sales agent)/i,
  },
  {
    id: 'marketplace', label: 'marketplace', fits: (p) => INTRODUCES(p) && p.information === 'PLATFORM',
    controls: ['DEMAND', 'SUPPLY', 'INFORMATION', 'PAYMENT'], value: 'TAKE',
    duties: ['run the matching system and its terms of use', 'handle disputes between the two sides'],
    risks: ['needs both sides at once before either has a reason to come', 'platform cost before the first transaction'],
    names: /\b(marketplace|platform|app-based)/i,
  },
  {
    id: 'booking_dispatch_coordinator', label: 'booking or dispatch coordinator', fits: (p) => PRIME(p) && p.supply === 'NETWORK' && p.aggregation === 'POOLED',
    controls: ['COORDINATION', 'INFORMATION', 'SUPPLY'], value: 'SPREAD',
    duties: ['schedule several buyers’ work onto shared capacity and keep it filled'],
    risks: ['paying for capacity days the bookings do not fill', 'needs several buyers before the pooling pays'],
    names: /\b(dispatch|booking|scheduler|coordinat)/i,
  },
  {
    id: 'reseller', label: 'reseller', fits: (p) => PRIME(p) && p.supply === 'NETWORK',
    controls: ['DISTRIBUTION', 'PAYMENT', 'DEMAND'], value: 'SPREAD',
    duties: ['sell the supplier’s service under our name and price', 'answer to the buyer for what the supplier delivers'],
    risks: ['the supplier’s price rise comes out of our margin', 'the buyer’s complaint is ours, whoever did the work'],
    names: /\b(resell|white.?label)/i,
  },
  {
    id: 'prime_contractor', label: 'prime contractor', fits: PRIME,
    controls: ['DEMAND', 'PAYMENT', 'FULFILMENT_RIGHTS'], value: 'SPREAD',
    duties: ['hold the buyer’s contract and every obligation in it', 'pay subcontractors or staff whether or not the buyer has paid'],
    risks: ['liable for the whole delivery', 'working capital between paying supply and being paid'],
    names: /\b(prime|general contractor|main contractor)/i,
  },
  {
    id: 'outsourced_operator', label: 'outsourced operator', fits: (p) => PRIME(p) && p.supply === 'EMPLOY',
    controls: ['FULFILMENT_RIGHTS', 'SUPPLY', 'COORDINATION'], value: 'OPERATING',
    duties: ['employ and manage the staff who do the work, under a hired manager', 'meet the buyer’s service levels'],
    risks: ['payroll and equipment costs run whether or not volume does', 'the buyer can take the work back in house'],
    names: /\b(outsourc|operator|contract operator|3pl)\b/i,
  },
  {
    id: 'technology_provider', label: 'technology provider', fits: (p) => p.information === 'PLATFORM',
    controls: ['INFORMATION', 'COORDINATION'], value: 'NONE',
    duties: ['keep the system running and the data it holds secure'],
    risks: ['platform cost before any revenue', 'operators may not adopt it'],
    names: /\b(software|technology|saas|system provider)/i,
  },
  {
    id: 'capital_arranger', label: 'capital arranger', fits: INTRODUCES,
    controls: ['FINANCING', 'PAYMENT'], value: 'TAKE',
    duties: ['arrange financing only as the permitting licence or registration allows', 'disclose the arrangement fee'],
    risks: ['regulated activity: acting outside the permission is unlawful', 'paid only when the financing closes'],
    gatePermitted: /\b(financ|lend|loan|credit|capital|mortgage|factoring)/i,
    names: /\b(financ|lender|factor|capital)/i,
  },
  {
    id: 'principal_delivery_risk', label: 'principal bearing delivery risk', fits: (p) => PRIME(p) && (p.supply === 'EMPLOY' || p.supply === 'NETWORK'),
    controls: ['FULFILMENT_RIGHTS', 'PAYMENT', 'DEMAND'], value: 'SPREAD',
    duties: ['deliver what was sold, redo or refund what fails', 'carry the insurance the buyer requires'],
    risks: ['every failure is ours to pay for', 'refund exposure until acceptance'],
    names: /\b(principal)\b/i,
  },
];

/** A party the evidence records in a role, when no seed names it: what standing there means. */
const EVIDENCE_ROLE: Partial<Record<ActorRole, { fits: (p: Position) => boolean; controls: ControlDimension[]; value: ValueBasis }>> = {
  INTERMEDIARY: { fits: (p) => p.contract === 'INTRODUCE' || p.contract === 'REPRESENT', controls: ['DEMAND', 'SUPPLY', 'INFORMATION'], value: 'TAKE' },
  PLATFORM: { fits: (p) => p.information === 'PLATFORM', controls: ['INFORMATION', 'COORDINATION', 'PAYMENT'], value: 'TAKE' },
  FINANCIER: { fits: INTRODUCES, controls: ['FINANCING', 'PAYMENT'], value: 'TAKE' },
  INSURER: { fits: INTRODUCES, controls: ['FINANCING', 'INFORMATION'], value: 'TAKE' },
  ASSET_PROVIDER: { fits: (p) => PRIME(p) && (p.assets === 'OWNED' || p.assets === 'LEASED'), controls: ['SUPPLY', 'FULFILMENT_RIGHTS'], value: 'OPERATING' },
};

/* ---------------------------------------------------------------------- shape */

export type Occupiable = 'YES' | 'NO' | 'UNKNOWN';

export interface RolePosition {
  key: string;
  position: Position;
  mechanisms: Mechanism[];
}

export interface ControlValue {
  /** Dollars per unit of work; null when no fact states it. */
  lowUsdPerUnit: number | null;
  highUsdPerUnit: number | null;
  /** The weakest status among the facts it was computed from; UNKNOWN when any is absent. */
  status: 'OBSERVED' | 'VERIFIED' | 'ESTIMATE' | 'ASSUMPTION' | 'UNKNOWN';
  basis: string;
  facts: FactKey[];
}

export interface CommercialRole {
  /** Flow and role: never the industry. */
  key: string;
  flowKey: string;
  roleId: string;
  label: string;
  origin: 'SEED' | 'EVIDENCE';
  /** The §92 positions this role is, after the evidence's refusals. */
  positions: RolePosition[];
  occupiable: { answer: Occupiable; gates: string[]; because: string };
  controls: ControlDimension[];
  controlValue: ControlValue;
  duties: string[];
  risks: string[];
  /** Ownable or operable without the operator doing the physical work. */
  remotelyOperable: boolean;
  sources: FactSource[];
}

export interface FlowRoles {
  flowKey: string;
  flow: Flow;
  /** The segment the flow's paying side is, when the evidence has one. */
  segmentId: string | null;
  /** How that payer is reached, as the evidence says. Reported, never ranked. */
  channel: string | null;
  /** The work in this flow's market is done by independent people or operators, not by us. */
  physicalByOthers: boolean;
  roles: CommercialRole[];
  /** Roles not enumerated on this flow, with why (a capital arranger nothing permits). Kept, not discarded. */
  withheld: { roleId: string; because: string }[];
  /** The role(s) this flow's own evidence values highest; empty when no value is evidenced. */
  best: { roleIds: string[]; because: string };
}

/* -------------------------------------------------------------------- engine */

export function flowKeyOf(flow: Flow, index: number): string {
  return `${index}:${flow.kind}:${flow.from}->${flow.to}`;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'unnamed';
}

function segmentOf(e: IndustryEvidence, flow: Flow): Segment | null {
  return e.segments.find((s) => s.actorId === flow.from) ?? e.segments.find((s) => s.actorId === flow.to) ?? null;
}

function sellable(p: Position, segment: Segment | null): boolean {
  // The operator doing the physical work itself is the one position the standing rule refuses.
  if (p.supply === 'SELF') return false;
  if (!segment) return true;
  return p.supply === 'RECRUIT' ? segment.buys === 'LABOR' : segment.buys === 'WORK';
}

/** Why a recorded fact refuses this position on this flow, or null. */
function refusal(p: Position, segment: Segment | null): string | null {
  if (!segment) return null;
  if ((p.contract === 'INTRODUCE' || p.contract === 'REPRESENT') && segment.acceptsIntermediary === false) return `${segment.actorId} contracts operators directly and does not pay an intermediary`;
  if (segment.refuses?.supply?.includes(p.supply)) return `${segment.actorId} refuses it: ${segment.refuses.because}`;
  return null;
}

type Resolved = { low: number; high: number; status: ControlValue['status'] } | null;

function fact(e: IndustryEvidence, key: FactKey, segment: string | null): Resolved {
  const r = resolveFact(e.facts, key, segment);
  return r.status === 'UNKNOWN' || !Number.isFinite(r.low) || !Number.isFinite(r.high) ? null : { low: r.low, high: r.high, status: r.status };
}

const STATUS_ORDER: ControlValue['status'][] = ['OBSERVED', 'VERIFIED', 'ESTIMATE', 'ASSUMPTION', 'UNKNOWN'];
const weakest = (xs: ControlValue['status'][]): ControlValue['status'] => xs.reduce((w, s) => (STATUS_ORDER.indexOf(s) > STATUS_ORDER.indexOf(w) ? s : w), 'OBSERVED' as ControlValue['status']);

function unknownValue(basis: string, facts: FactKey[]): ControlValue {
  return { lowUsdPerUnit: null, highUsdPerUnit: null, status: 'UNKNOWN', basis, facts };
}

/** What standing in this role is worth per unit of work, from the evidence's facts only. */
function valueOf(e: IndustryEvidence, basis: ValueBasis, segment: string | null): ControlValue {
  const unit = e.workUnit;
  if (basis === 'NONE') return unknownValue(`no fact key prices this role per ${unit}; its value is unestablished`, []);
  if (basis === 'TAKE') {
    const keys: FactKey[] = ['broker_take_rate', 'price_per_unit'];
    const take = fact(e, 'broker_take_rate', segment);
    const price = fact(e, 'price_per_unit', segment);
    if (!take || !price) return unknownValue(`take rate × price per ${unit}: ${!take ? 'the take rate' : 'the price'} is not established`, keys);
    return { lowUsdPerUnit: take.low * price.low, highUsdPerUnit: take.high * price.high, status: weakest([take.status, price.status]), basis: `take rate × price per ${unit}`, facts: keys };
  }
  if (basis === 'SPREAD') {
    const keys: FactKey[] = ['price_per_unit', 'contractor_rate_per_unit'];
    const price = fact(e, 'price_per_unit', segment);
    const rate = fact(e, 'contractor_rate_per_unit', null);
    if (!price || !rate) return unknownValue(`price per ${unit} − what independent supply accepts: ${!price ? 'the price' : 'the supply rate'} is not established`, keys);
    return { lowUsdPerUnit: price.low - rate.high, highUsdPerUnit: price.high - rate.low, status: weakest([price.status, rate.status]), basis: `price per ${unit} − independent supply’s rate per ${unit}`, facts: keys };
  }
  if (basis === 'PLACEMENT') {
    const fee = fact(e, 'placement_fee', segment);
    if (!fee) return unknownValue('the placement fee is not established', ['placement_fee']);
    return { lowUsdPerUnit: fee.low, highUsdPerUnit: fee.high, status: fee.status, basis: 'placement fee per worker placed', facts: ['placement_fee'] };
  }
  // OPERATING: price less the per-unit cost of running our own capacity.
  const keys: FactKey[] = ['price_per_unit', 'units_per_capacity_day', 'labor_cost_per_day'];
  const price = fact(e, 'price_per_unit', segment);
  const units = fact(e, 'units_per_capacity_day', segment);
  const labor = fact(e, 'labor_cost_per_day', null);
  if (!price || !units || !labor || units.low <= 0) return unknownValue(`price per ${unit} − (staff cost per day ÷ ${unit}s per day): not every input is established`, keys);
  const extra: Resolved[] = e.needsEquipment ? [fact(e, 'asset_lease_per_day', null), fact(e, 'variable_cost_per_day', null)] : [];
  if (extra.some((x) => x === null)) return unknownValue(`price per ${unit} − operating cost per ${unit}: the equipment lease or running cost is not established`, [...keys, 'asset_lease_per_day', 'variable_cost_per_day']);
  const dayLow = labor.low + extra.reduce((s, x) => s + (x?.low ?? 0), 0);
  const dayHigh = labor.high + extra.reduce((s, x) => s + (x?.high ?? 0), 0);
  return {
    lowUsdPerUnit: price.low - dayHigh / units.low,
    highUsdPerUnit: price.high - dayLow / units.high,
    status: weakest([price.status, units.status, labor.status, ...extra.map((x) => x!.status)]),
    basis: `price per ${unit} − daily operating cost ÷ ${unit}s per capacity-day`,
    facts: e.needsEquipment ? [...keys, 'asset_lease_per_day', 'variable_cost_per_day'] : keys,
  };
}

function occupiability(gates: Gate[], refusedAll: string | null): CommercialRole['occupiable'] {
  if (refusedAll) return { answer: 'NO', gates: [], because: refusedAll };
  if (gates.length === 0) return { answer: 'UNKNOWN', gates: [], because: 'no gate is recorded for this role on this flow, so whether it may be occupied legally and contractually is unanswered' };
  const open = gates.find((g) => g.upfrontLow === null || g.upfrontHigh === null || g.days === null || g.status === 'ASSUMPTION');
  if (open) return { answer: 'UNKNOWN', gates: gates.map((g) => g.id), because: `the recorded gate "${open.name}" does not state ${open.status === 'ASSUMPTION' ? 'a checked requirement' : 'its cost and time'}, so it cannot be counted as passable` };
  return { answer: 'YES', gates: gates.map((g) => g.id), because: `occupiable once the recorded gates are passed: ${gates.map((g) => g.name).join('; ')}` };
}

interface RoleSpec {
  roleId: string;
  label: string;
  origin: 'SEED' | 'EVIDENCE';
  fits: (p: Position) => boolean;
  controls: ControlDimension[];
  value: ValueBasis;
  duties: string[];
  risks: string[];
  sources: FactSource[];
}

function buildRole(e: IndustryEvidence, flow: Flow, flowKey: string, segment: Segment | null, spec: RoleSpec): CommercialRole | null {
  const candidates = allPositions(e.needsEquipment).filter((p) => sellable(p, segment) && spec.fits(p));
  if (candidates.length === 0) return null;
  const refusals = candidates.map((p) => refusal(p, segment));
  const kept = candidates.filter((_, i) => refusals[i] === null);
  const segmentId = segment?.actorId ?? '';
  const considered = kept.length ? kept : candidates;
  const gates = e.gates.filter((g) => considered.some((p) => appliesTo(g.applies, p, segmentId)));
  const failures = e.failures.filter((f) => considered.some((p) => appliesTo(f.applies, p, segmentId)));
  const basis: ValueBasis = spec.value === 'TAKE' && considered.every((p) => p.supply === 'RECRUIT') ? 'PLACEMENT' : spec.value;
  return {
    key: `${flowKey}#${spec.roleId}`,
    flowKey,
    roleId: spec.roleId,
    label: spec.label,
    origin: spec.origin,
    positions: considered.map((p) => ({ key: positionKey(p), position: p, mechanisms: mechanismsOf(p) })),
    occupiable: occupiability(gates, kept.length ? null : (refusals[0] ?? null)),
    controls: spec.controls,
    controlValue: valueOf(e, basis, segment?.actorId ?? null),
    duties: [...spec.duties, ...gates.map((g) => `pass ${g.name}`)],
    risks: [...spec.risks, ...failures.map((f) => f.statement), ...(kept.length < candidates.length ? refusals.filter((r): r is string => r !== null).map((r) => `refused in part: ${r}`) : [])],
    remotelyOperable: considered.every((p) => p.supply !== 'SELF'),
    sources: [flow.source, ...spec.sources],
  };
}

function endpoints(e: IndustryEvidence, flow: Flow): Actor[] {
  return e.actors.filter((a) => a.id === flow.from || a.id === flow.to);
}

/** The roles on one flow. Pure. */
export function rolesForFlow(e: IndustryEvidence, flow: Flow, index: number): FlowRoles {
  const flowKey = flowKeyOf(flow, index);
  const segment = segmentOf(e, flow);
  const roles: CommercialRole[] = [];
  const withheld: FlowRoles['withheld'] = [];
  const parties = endpoints(e, flow);

  for (const seed of SEED_ROLES) {
    const permit = seed.gatePermitted ? e.gates.filter((g) => seed.gatePermitted!.test(`${g.name} ${g.kind}`)) : null;
    if (permit && permit.length === 0) {
      withheld.push({ roleId: seed.id, because: `${seed.label} is enumerated only where a recorded gate permits it, and none here does` });
      continue;
    }
    const evidenced = parties.filter((a) => seed.names.test(a.name));
    const role = buildRole(e, flow, flowKey, segment, { roleId: seed.id, label: seed.label, origin: 'SEED', fits: seed.fits, controls: seed.controls, value: seed.value, duties: seed.duties, risks: seed.risks, sources: evidenced.map((a) => a.source) });
    if (role) roles.push(role);
    else withheld.push({ roleId: seed.id, because: `no coherent §92 position expresses ${seed.label} for this flow’s payer` });
  }

  // A party in a role the seeds do not name is a role of its own: no whitelist.
  for (const actor of e.actors) {
    const shape = EVIDENCE_ROLE[actor.role];
    if (!shape) continue;
    if (!parties.includes(actor) && actor.role !== 'INTERMEDIARY' && actor.role !== 'PLATFORM') continue;
    if (SEED_ROLES.some((seed) => seed.names.test(actor.name))) continue;
    const roleId = `evidence:${slug(actor.name)}`;
    if (roles.some((r) => r.roleId === roleId)) continue;
    const role = buildRole(e, flow, flowKey, segment, {
      roleId,
      label: actor.name,
      origin: 'EVIDENCE',
      fits: shape.fits,
      controls: shape.controls,
      value: shape.value,
      duties: [`stand where the evidence records ${actor.name}: ${actor.description || actor.role.toLowerCase()}`],
      risks: [`read from one record (${actor.status.toLowerCase()}); whether Brain can stand there as ${actor.name} does is what the gates decide`],
      sources: [actor.source],
    });
    if (role) roles.push(role);
    else withheld.push({ roleId, because: `no coherent §92 position expresses ${actor.name}’s role for this flow’s payer` });
  }

  const physicalByOthers = e.flows.some((f) => f.kind === 'WORK' && e.actors.some((a) => a.id === f.from && (a.role === 'OPERATOR' || a.role === 'LABOR')));
  return { flowKey, flow, segmentId: segment?.actorId ?? null, channel: segment?.channel ?? null, physicalByOthers, roles, withheld, best: bestOf(roles) };
}

/** The best role of one flow by its own evidence; never a global ranking. */
function bestOf(roles: CommercialRole[]): FlowRoles['best'] {
  const valued = roles.filter((r) => r.occupiable.answer !== 'NO' && r.controlValue.lowUsdPerUnit !== null && r.controlValue.highUsdPerUnit !== null);
  if (valued.length === 0) return { roleIds: [], because: 'no role’s value is evidenced on this flow, so none is best yet' };
  const mid = (r: CommercialRole) => ((r.controlValue.lowUsdPerUnit ?? 0) + (r.controlValue.highUsdPerUnit ?? 0)) / 2;
  const top = Math.max(...valued.map(mid));
  const ids = valued.filter((r) => mid(r) === top).map((r) => r.roleId);
  return { roleIds: ids, because: `highest evidenced value per unit on this flow (${top.toFixed(2)} USD), from its own facts` };
}

/** Every flow's role set. Pure. */
export function commercialRoles(e: IndustryEvidence): FlowRoles[] {
  return e.flows.map((flow, i) => rolesForFlow(e, flow, i));
}

/* ------------------------------------------------- the role model at work */

/**
 * One role on one recorded flow, in words a research question can carry: the
 * position, what it controls, what that control is worth (or that nothing has
 * established it), whether Brain may occupy it and why, and the duties and
 * risks that follow. This is how the role model reaches the running Brain —
 * `cash/discovery.ts` asks a goal's research from it — rather than living only
 * in the probe. A value nobody evidenced is said to be unestablished, never
 * stated as a number (invariant 39). Pure.
 */
export function describeRole(subject: string, set: FlowRoles, role: CommercialRole): string {
  const money = (x: number) => (Math.abs(x) >= 100 ? Math.round(x).toString() : (Math.round(x * 100) / 100).toString());
  const v = role.controlValue;
  const value =
    v.status !== 'UNKNOWN' && v.lowUsdPerUnit !== null && v.highUsdPerUnit !== null
      ? `worth about USD ${money(v.lowUsdPerUnit)}–${money(v.highUsdPerUnit)} per unit by ${v.basis} (${v.status.toLowerCase()})`
      : `whose value is not established (${v.basis})`;
  const controls = role.controls.map((c) => c.toLowerCase().replace(/_/g, ' ')).join(', ');
  const terms = set.flow.terms ? ` (${set.flow.terms})` : '';
  return (
    `the ${role.label} position in ${subject}, on the flow from ${set.flow.from} to ${set.flow.to}${terms}: ` +
    `it controls ${controls}, ${value}; ` +
    `whether this operation may occupy it legally and contractually is ${role.occupiable.answer.toLowerCase()} — ${role.occupiable.because}; ` +
    `its duties: ${role.duties.join('; ')}; its risks: ${role.risks.join('; ')}`
  );
}

/** A role on a recorded flow, ready to be asked about. */
export interface RoleLensSeed {
  /** Subject and role: one per role per subject, as `unrepresentedRoleAsks` keys it. */
  key: string;
  subject: string;
  roleId: string;
  flowKey: string;
  roleKey: string;
  occupiable: Occupiable;
  angle: string;
}

/**
 * The roles a subject's recorded flows offer, one per role, in flow order.
 * Only flows the map recorded count (a reference pack is not a record), and a
 * role the record refuses (occupiable NO) is not asked about — the record
 * already answered it. Nothing is ranked across markets: the order is the
 * map's. Pure.
 */
export function roleLensSeeds(subject: string, sets: readonly FlowRoles[]): RoleLensSeed[] {
  const out: RoleLensSeed[] = [];
  const seen = new Set<string>();
  for (const set of sets) {
    if (set.flow.source.kind !== 'MAP') continue;
    for (const role of set.roles) {
      if (role.occupiable.answer === 'NO') continue;
      const key = `role:${subject.toLowerCase()}:${role.roleId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, subject, roleId: role.roleId, flowKey: set.flowKey, roleKey: role.key, occupiable: role.occupiable.answer, angle: describeRole(subject, set, role) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the probe */

/** What a role set must carry for the requirement to hold. Null when it does. */
export function roleSetDefect(set: FlowRoles): string | null {
  if (set.roles.length === 0) return `flow ${set.flowKey} yields no role`;
  for (const r of set.roles) {
    if (!['YES', 'NO', 'UNKNOWN'].includes(r.occupiable.answer)) return `role ${r.key} has no occupiability`;
    if (r.occupiable.answer === 'YES' && r.occupiable.gates.length === 0) return `role ${r.key} reads YES without a recorded gate`;
    if (r.positions.length === 0) return `role ${r.key} maps onto no §92 position`;
    if (r.controls.some((c) => !CONTROL_DIMENSIONS.includes(c))) return `role ${r.key} controls an undeclared dimension`;
    if (r.duties.length === 0 || r.risks.length === 0) return `role ${r.key} states no duties or no risks`;
    if (r.controlValue.status === 'UNKNOWN' && r.controlValue.lowUsdPerUnit !== null) return `role ${r.key} carries a value its facts do not support`;
  }
  if (set.physicalByOthers && !set.roles.some((r) => r.remotelyOperable)) return `flow ${set.flowKey} is physical work by others and yields no remotely operable role`;
  return null;
}

/**
 * Read-only check for the r01.com-13-1 probe: every flow on the production
 * industry maps yields a complete role set. Reads rows, writes nothing.
 */
export async function commercialRolesHoldOnRows(): Promise<{ ok: boolean; detail: string }> {
  const { getDb } = await import('../../../db/database.ts');
  const { listNodes, listConstraintsForProject } = await import('../../../repos/industry.ts');
  const { assembleEvidence, evidenceFromMap, subtreeFor } = await import('./service.ts');
  const projects = await getDb().all<{ project_id: string }>(
    `SELECT DISTINCT project_id FROM industry_nodes WHERE retired_at IS NULL ORDER BY project_id`,
    [],
  );
  let flows = 0;
  let roles = 0;
  let evidenceRoles = 0;
  for (const { project_id: projectId } of projects) {
    const nodes = await listNodes(projectId);
    const constraints = await listConstraintsForProject(projectId);
    for (const root of nodes.filter((n) => n.parentId === null && !n.retiredAt)) {
      const map = evidenceFromMap(subtreeFor(nodes, root.name), constraints);
      if (map.flows.length === 0) continue;
      const evidence = assembleEvidence({ text: root.name, industry: root.name, geography: null, map, recorded: [] });
      for (const set of commercialRoles(evidence)) {
        // Only flows the rows recorded count: a reference pack is not a production record.
        if (set.flow.source.kind !== 'MAP') continue;
        const defect = roleSetDefect(set);
        if (defect) return { ok: false, detail: `project ${projectId}, subject "${root.name}": ${defect}` };
        flows += 1;
        roles += set.roles.length;
        evidenceRoles += set.roles.filter((r) => r.origin === 'EVIDENCE').length;
      }
    }
  }
  if (flows === 0) return { ok: false, detail: 'no flow is recorded on any production industry map, so no role set could be demonstrated' };
  return { ok: true, detail: `${flows} recorded flow(s) across ${projects.length} project(s) each yield a complete role set: ${roles} role(s), ${evidenceRoles} read from evidence beyond the seeds` };
}

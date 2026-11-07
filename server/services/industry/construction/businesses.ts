/**
 * Businesses constructed from positions, not picked from a menu (§92).
 *
 * A position is five independent choices (`domain/construction.ts`); coherence
 * rules refuse combinations that cannot exist, and every coherent position is
 * paired with every buyer segment the evidence holds that could pay for it.
 * Nothing names "a brokerage" or "a delivery company": driver recruitment is
 * `NONE/RECRUIT`, capacity coordination is `PRIME/NETWORK/POOLED`,
 * subcontracting is `PRIME/NETWORK/SINGLE`, a directly operated fleet is
 * `PRIME/EMPLOY/LEASED` — and the same rules produce crew placement, a
 * cleaning subcontractor or an equipment-owning operator in any other
 * industry whose evidence supports them.
 *
 * Each business answers the owner's ten questions (who pays and why, what we
 * provide, how customers are obtained, how fulfilment happens, what we
 * control, what must be acquired or negotiated, capital committed, the first
 * collected dollar, what limits expansion, what survives) from the position,
 * the segment and the gates that apply — and the standing rule decides whether
 * it may be operated at all, through the one reader of it, `operatingFit`.
 */
import { operatingFit, breaksOperatingModel, type OperatingFit } from '../../../domain/operatingModel.ts';
import {
  AGGREGATIONS,
  ASSET_LABELS,
  INFORMATION_MODES,
  type Applies,
  type Asset,
  type Gate,
  type IndustryEvidence,
  type Mechanism,
  type Position,
  type Segment,
} from '../../../domain/construction.ts';

export interface Business {
  key: string;
  position: Position;
  segment: Segment;
  segmentName: string;
  label: string;
  mechanisms: Mechanism[];
  /** Who is paid by whom: the segment, or (for representation) the operator we represent. */
  payer: string;
  answers: {
    whoPaysAndWhy: string;
    whatWeProvide: string;
    howWeGetCustomers: string;
    howFulfilmentHappens: string;
    whatWeControl: string;
    mustAcquireOrNegotiate: string[];
    firstCollectedDollar: string;
    limitsExpansion: string;
    durableAsset: string;
  };
  /** Assets this business leaves behind once it has operated. */
  accumulates: Asset[];
  /** Assets that must be held before it can start: the segment's own demands and the position's. */
  requires: Asset[];
  gates: Gate[];
  operating: OperatingFit;
  /** Refused outright, with the reason (the standing rule, a buyer that will not pay an intermediary). */
  excluded: string | null;
}

export function positionKey(p: Position): string {
  return `${p.contract}/${p.supply}/${p.assets}/${p.aggregation}/${p.information}`;
}

/** Rules, not a list: each refuses a combination that cannot exist. */
export function coherentPosition(p: Position, needsEquipment: boolean): boolean {
  if (p.supply === 'SELF') return p.contract === 'PRIME' && p.assets === (needsEquipment ? 'LEASED' : 'NONE') && p.aggregation === 'SINGLE' && p.information === 'NONE';
  // Placing workers is paid by the operator that employs them; it holds no work contract and no assets.
  if (p.supply === 'RECRUIT') return p.contract === 'NONE' && p.assets === 'NONE' && p.aggregation === 'SINGLE';
  if (p.contract === 'NONE') return false;
  // An introduction or a representation passes the work to independent operators who bring their own equipment.
  if (p.contract === 'INTRODUCE' || p.contract === 'REPRESENT') return p.supply === 'NETWORK' && p.assets === (needsEquipment ? 'CONTRACTOR' : 'NONE') && p.aggregation === 'SINGLE';
  // PRIME
  if (p.supply === 'NETWORK') return p.assets === (needsEquipment ? 'CONTRACTOR' : 'NONE');
  if (p.supply === 'EMPLOY') return needsEquipment ? p.assets === 'LEASED' || p.assets === 'OWNED' : p.assets === 'NONE';
  return false;
}

/** Every coherent position for an industry. */
export function allPositions(needsEquipment: boolean): Position[] {
  const out: Position[] = [];
  for (const contract of ['NONE', 'INTRODUCE', 'REPRESENT', 'PRIME'] as const) {
    for (const supply of ['SELF', 'RECRUIT', 'NETWORK', 'EMPLOY'] as const) {
      for (const assets of ['NONE', 'CONTRACTOR', 'LEASED', 'OWNED'] as const) {
        for (const aggregation of AGGREGATIONS) {
          for (const information of INFORMATION_MODES) {
            const p: Position = { contract, supply, assets, aggregation, information };
            if (coherentPosition(p, needsEquipment)) out.push(p);
          }
        }
      }
    }
  }
  return out;
}

export function mechanismsOf(p: Position): Mechanism[] {
  const m = new Set<Mechanism>();
  if (p.contract === 'PRIME') m.add('CONTRACT_CONTROL').add('DEMAND_OWNERSHIP');
  if (p.contract === 'INTRODUCE') m.add('BROKERAGE').add('TRANSACTION_FACILITATION');
  if (p.contract === 'REPRESENT') m.add('REPRESENTATION');
  if (p.supply === 'NETWORK') m.add('SUPPLY_COORDINATION');
  if (p.supply === 'NETWORK' && p.contract === 'PRIME') m.add('SUBCONTRACTING');
  if (p.supply === 'RECRUIT') m.add('SUPPLY_COORDINATION').add('BROKERAGE');
  if (p.supply === 'EMPLOY' || p.supply === 'SELF') m.add('FULFILMENT_OWNERSHIP');
  if (p.aggregation === 'POOLED') m.add('AGGREGATION').add('CAPACITY_COORDINATION');
  if (p.information === 'PLATFORM') m.add('INFORMATION_ADVANTAGE');
  if (p.assets === 'OWNED') m.add('ASSET_OWNERSHIP');
  return [...m];
}

export function accumulatesOf(p: Position): Asset[] {
  const a = new Set<Asset>();
  if (p.contract === 'INTRODUCE' || p.contract === 'REPRESENT') a.add('BUYER_RELATIONSHIPS');
  if (p.contract === 'PRIME') a.add('CUSTOMER_CONTRACTS').add('BUYER_RELATIONSHIPS').add('DELIVERY_RECORD');
  if (p.supply === 'NETWORK') a.add('SUPPLY_NETWORK');
  if (p.supply === 'RECRUIT') a.add('LABOR_PIPELINE').add('BUYER_RELATIONSHIPS');
  if (p.supply === 'EMPLOY') a.add('OPERATING_CAPABILITY');
  if (p.assets === 'LEASED' || p.assets === 'OWNED') a.add('FLEET');
  if (p.assets === 'OWNED') a.add('FLEET_EQUITY');
  if (p.aggregation === 'POOLED') a.add('ROUTE_DENSITY');
  if (p.information === 'PLATFORM') a.add('DISPATCH_DATA');
  if (p.contract === 'PRIME' && p.supply === 'NETWORK') a.add('OPERATING_CAPABILITY');
  return [...a];
}

/** What a position needs before it can start, beyond what the segment demands. */
export function positionRequires(p: Position): Asset[] {
  const r = new Set<Asset>();
  // Several buyers on shared capacity needs several buyers first.
  if (p.aggregation === 'POOLED') r.add('CUSTOMER_CONTRACTS');
  // Owning equipment before operating any is the one move this rule refuses: an operator that
  // has never run the work buys the asset the work turns out not to need.
  if (p.assets === 'OWNED') r.add('OPERATING_CAPABILITY');
  return [...r];
}

export function appliesTo(applies: Applies, p: Position, segmentId: string): boolean {
  if (applies.contract && !applies.contract.includes(p.contract)) return false;
  if (applies.supply && !applies.supply.includes(p.supply)) return false;
  if (applies.assets && !applies.assets.includes(p.assets)) return false;
  if (applies.aggregation && !applies.aggregation.includes(p.aggregation)) return false;
  if (applies.segments && !applies.segments.includes(segmentId)) return false;
  return true;
}

function describe(p: Position, e: IndustryEvidence, segName: string): { label: string; provide: string; fulfil: string } {
  const unit = e.workUnit;
  const cap = e.capacityUnit;
  if (p.supply === 'SELF') return { label: `Do the ${unit} work yourself for ${segName}`, provide: `the work, performed by the operator`, fulfil: `the operator performs it in person` };
  if (p.supply === 'RECRUIT') return { label: `Recruit and place workers with ${segName}${p.information === 'PLATFORM' ? ', on our own recruiting system' : ''}`, provide: `screened workers placed with the operator, paid per placement`, fulfil: `the operator employs and runs the workers; we recruit, screen and place them online` };
  const pooled = p.aggregation === 'POOLED' ? ` pooling several buyers’ volume onto shared ${cap}s` : '';
  const platform = p.information === 'PLATFORM' ? ', on our own dispatch and pricing system' : '';
  if (p.contract === 'INTRODUCE') return { label: `Broker ${unit} work from ${segName} to independent operators${platform}`, provide: `matching: the buyer contracts the operator directly and we take a commission`, fulfil: `independent operators with their own ${cap}s perform it and contract with the buyer` };
  if (p.contract === 'REPRESENT') return { label: `Represent independent operators and sell their capacity to ${segName}${platform}`, provide: `sales and account management for operators, paid a share by them`, fulfil: `the operators we represent perform it under their own contracts` };
  if (p.supply === 'NETWORK') {
    return p.aggregation === 'POOLED'
      ? { label: `Hold ${segName} contracts and coordinate contracted ${cap}-days${pooled}${platform}`, provide: `the whole service under our contract, priced per ${unit}`, fulfil: `independent operators are paid by the day and we fill their capacity with several buyers’ ${unit}s` }
      : { label: `Hold ${segName} contracts and subcontract each ${unit} to independent operators${platform}`, provide: `the whole service under our contract, priced per ${unit}`, fulfil: `independent operators with their own ${cap}s are paid per ${unit} as subcontractors` };
  }
  const assets = p.assets === 'OWNED' ? 'owned' : p.assets === 'LEASED' ? 'leased' : '';
  return {
    label: `Operate our own ${assets ? `${assets} ` : ''}${cap}s with employed staff for ${segName}${pooled}${platform}`,
    provide: `the whole service with our own staff${assets ? ` and ${assets} equipment` : ''}`,
    fulfil: `employed staff run by a hired operations manager perform it; the owner coordinates remotely`,
  };
}

/** Construct every business the evidence supports. Pure. */
export function constructBusinesses(e: IndustryEvidence): Business[] {
  const out: Business[] = [];
  for (const segment of e.segments) {
    const segActor = e.actors.find((a) => a.id === segment.actorId);
    const segmentName = segActor?.name ?? segment.actorId;
    for (const p of allPositions(e.needsEquipment)) {
      if (p.supply === 'RECRUIT' ? segment.buys !== 'LABOR' : segment.buys !== 'WORK') continue;
      const { label, provide, fulfil } = describe(p, e, segmentName);
      const gates = e.gates.filter((g) => appliesTo(g.applies, p, segment.actorId));
      const accumulates = accumulatesOf(p);
      for (const g of gates) for (const a of g.grants) if (!accumulates.includes(a)) accumulates.push(a);
      const requires = [...new Set([...segment.requires, ...positionRequires(p)])];
      const payer = p.contract === 'REPRESENT' ? 'the independent operators we represent' : segmentName;
      // The standing rule, read by its one reader from the business's own description.
      const operating = operatingFit({
        title: label,
        offerScope: provide,
        fulfillmentOwner: p.supply === 'SELF' ? 'the owner' : p.supply === 'EMPLOY' ? 'employed staff under a hired operations manager' : p.supply === 'RECRUIT' ? 'the operator that employs the placed workers' : 'independent operators (subcontractors)',
        captureMechanism: p.supply === 'SELF' ? 'paid for performing the work' : p.contract === 'INTRODUCE' ? 'brokerage commission' : p.contract === 'REPRESENT' ? 'commission from the operators' : p.supply === 'RECRUIT' ? 'placement fee' : p.supply === 'NETWORK' ? 'subcontracted margin' : 'operating margin',
        delivery: fulfil,
      });
      let excluded: string | null = null;
      if (p.supply === 'SELF' || breaksOperatingModel(operating)) excluded = `the operator would do the physical work (${operating.because}); Brain’s standing rule and the operator’s own words refuse it`;
      else if ((p.contract === 'INTRODUCE' || p.contract === 'REPRESENT') && segment.acceptsIntermediary === false) excluded = `${segmentName} contracts operators directly and does not pay an intermediary`;
      else if (segment.refuses?.supply?.includes(p.supply)) excluded = `${segmentName} refuses it: ${segment.refuses.because}`;
      const mustAcquire = [
        ...gates.map((g) => `${g.name}${g.upfrontHigh !== null ? ` (about $${Math.round(g.upfrontLow ?? g.upfrontHigh).toLocaleString('en-US')}–$${Math.round(g.upfrontHigh).toLocaleString('en-US')})` : ' (cost unknown)'}`),
        ...requires.map((a) => `before ${segmentName} contracts: ${ASSET_LABELS[a]}`),
        ...(p.supply === 'NETWORK' ? [`independent operators who accept our rate`] : []),
        ...(p.supply === 'EMPLOY' ? [`a hired operations manager and staff`, ...(p.assets === 'LEASED' ? [`${e.capacityUnit} leases`] : p.assets === 'OWNED' ? [`${e.capacityUnit} purchases or financing`] : [])] : []),
      ];
      const limits =
        p.supply === 'RECRUIT'
          ? `how many workers one recruiter places a month, and how many operators keep hiring`
          : p.supply === 'NETWORK'
            ? `independent operators willing to take our rate, and the accounts we hold`
            : p.supply === 'EMPLOY'
              ? `capital per ${e.capacityUnit}, hiring, and insurance per ${e.capacityUnit}`
              : `buyers willing to pay an intermediary`;
      out.push({
        key: `${positionKey(p)}@${segment.actorId}`,
        position: p,
        segment,
        segmentName,
        label,
        mechanisms: mechanismsOf(p),
        payer,
        answers: {
          whoPaysAndWhy:
            p.contract === 'REPRESENT'
              ? `${payer} pay us a share because we bring them ${segmentName}'s work they could not win alone`
              : p.supply === 'RECRUIT'
                ? `${segmentName} pays per placed worker because hiring drivers or crews is its constraint`
                : `${segmentName} pays per ${e.workUnit} for work it needs done and does not want to staff itself`,
          whatWeProvide: provide,
          howWeGetCustomers: segment.channel,
          howFulfilmentHappens: fulfil,
          whatWeControl: accumulates.map((a) => ASSET_LABELS[a]).join('; '),
          mustAcquireOrNegotiate: mustAcquire,
          firstCollectedDollar: segment.firstTransaction,
          limitsExpansion: limits,
          durableAsset: accumulates.filter((a) => a !== 'BUYER_RELATIONSHIPS').map((a) => ASSET_LABELS[a]).join('; ') || 'buyer relationships only',
        },
        accumulates,
        requires,
        gates,
        operating,
        excluded,
      });
    }
  }
  return out;
}

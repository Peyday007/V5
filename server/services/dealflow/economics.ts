/**
 * What it costs to land the goods, what the buyer pays today, and — the number
 * this whole module exists to keep separate — what any of it requires of us.
 *
 * ---------------------------------------------------------------------------
 * Transaction value is not our capital
 * ---------------------------------------------------------------------------
 *
 * A tanker costing a quarter of a million dollars is a quarter-million-dollar
 * transaction. It is a quarter-million dollars *of ours* only under one of the
 * thirteen commercial structures, and most of them require nothing of our
 * balance sheet at all. A kernel that rejected large transactions because the
 * equipment is expensive would decline every deal in this trade worth doing,
 * which is the request's §13 in one sentence.
 *
 * So `landedEconomics` answers the transaction and says nothing about us, and
 * `structures.ts` answers what each way of participating would require. The
 * two numbers never meet in one field.
 *
 * ---------------------------------------------------------------------------
 * A total past an unknown is worse than no total
 * ---------------------------------------------------------------------------
 *
 * §30 settled this for the margin and the reasoning is identical here, only
 * sharper: a landed cost that silently skips the duty line because no source
 * published one is a landed cost that is wrong by nineteen per cent, in the
 * direction that makes the deal look worth doing. Nobody checks a number that
 * flatters them.
 *
 * So the total is **withheld** when any load-bearing component has no row, and
 * the reading names which ones are missing. That is an answer — it says
 * exactly what research would settle it — where a computed figure would be a
 * confident lie.
 *
 * ---------------------------------------------------------------------------
 * The basis is reported, never reconciled
 * ---------------------------------------------------------------------------
 *
 * One source publishes a price per unit, another a freight rate per forty-foot
 * container. Dividing the second by an assumed number of trailers per
 * container would be Brain inventing a load plan and presenting the result as
 * arithmetic over published figures. So mixed bases are **reported as mixed**
 * and the total is withheld, exactly as a missing component is. A person
 * reading "these figures are on three different bases" can fix it; a person
 * reading a single wrong number cannot.
 */
import { equipmentKey, jurisdictionKey } from '../../domain/dealflow.ts';
import type { CostComponent, DealCost } from '../../domain/types.ts';

/**
 * The components a landed cost cannot be honest without.
 *
 * Five, and each one is here because leaving it out changes the answer by
 * enough to reverse a decision. Inspection, certification and financing are
 * deliberately *not* load-bearing: they are real costs and they are small
 * relative to the asset, so their absence degrades the estimate without
 * inverting it — and requiring them would withhold every total this kernel
 * could ever produce.
 */
export const LOAD_BEARING_COMPONENTS: readonly CostComponent[] = Object.freeze([
  'FACTORY_PRICE',
  'OCEAN_FREIGHT',
  'IMPORT_DUTY',
  'CUSTOMS_CLEARANCE',
  'INLAND_DESTINATION',
]);

/** Everything that is a cost of getting the goods there. Never the alternative. */
const COST_SIDE: readonly CostComponent[] = Object.freeze([
  'FACTORY_PRICE',
  'INLAND_ORIGIN',
  'EXPORT_HANDLING',
  'OCEAN_FREIGHT',
  'INSURANCE',
  'IMPORT_DUTY',
  'IMPORT_TAX',
  'CUSTOMS_CLEARANCE',
  'INLAND_DESTINATION',
  'INSPECTION',
  'CERTIFICATION_COST',
  'FINANCING_COST',
]);

export interface ComponentReading {
  component: CostComponent;
  amountCents: number | null;
  currency: string | null;
  basis: string | null;
  sourceClaimId: string | null;
  loadBearing: boolean;
  /** What would answer it, where it is unknown. Null where it is known. */
  task: string | null;
}

/** Why a total is not being reported, from a closed set rather than prose. */
export const WITHHELD_REASONS = [
  'MISSING_LOAD_BEARING',
  'MIXED_CURRENCY',
  'MIXED_BASIS',
] as const;
export type WithheldReason = (typeof WITHHELD_REASONS)[number];

export interface LandedEconomics {
  equipmentClass: string;
  destination: string;
  components: ComponentReading[];
  /**
   * The landed cost, or null with a reason.
   *
   * Null is the common answer early on and it is the correct one. A number
   * here means every load-bearing line has a published figure, on one basis,
   * in one currency.
   */
  landedCents: number | null;
  currency: string | null;
  basis: string | null;
  withheld: WithheldReason[];
  /** What the buyer pays today, where a source published it. */
  buyerAlternativeCents: number | null;
  /**
   * What the buyer saves, and only when both sides are real figures.
   *
   * Never derived from one of them: a saving computed against an unknown
   * alternative is the whole error this module is arranged to prevent, wearing
   * the most persuasive number in the deal.
   */
  savingCents: number | null;
  /** The sentence a person reads. Composed here so two screens cannot differ. */
  because: string;
  missing: CostComponent[];
}

const COMPONENT_TASK: Readonly<Record<CostComponent, string>> = Object.freeze({
  FACTORY_PRICE: 'Get a published or quoted ex-works price for this configuration.',
  INLAND_ORIGIN: 'Establish the cost of moving it from the factory to the export port.',
  EXPORT_HANDLING: 'Establish terminal handling and export documentation charges.',
  OCEAN_FREIGHT: 'Establish the freight rate on this lane, and say what it is per.',
  INSURANCE: 'Establish the marine insurance rate for goods of this value.',
  IMPORT_DUTY: 'Establish the duty rate for this tariff heading in the destination.',
  IMPORT_TAX: 'Establish VAT or equivalent charged on import in the destination.',
  CUSTOMS_CLEARANCE: 'Establish clearance and port charges in the destination.',
  INLAND_DESTINATION: 'Establish delivery from the destination port to the buyer.',
  INSPECTION: 'Establish the cost of any pre-shipment or third-party inspection required.',
  CERTIFICATION_COST: 'Establish what the compliance requirements cost to obtain.',
  FINANCING_COST: 'Establish the cost of whatever payment instrument the deal uses.',
  BUYER_ALTERNATIVE: 'Establish what the buyer pays for this today, from their current source.',
});

/**
 * Pick one row per component.
 *
 * The newest, deliberately, and it is the only place in this module that makes
 * a choice at all. Two published freight rates for one lane are two facts
 * about a market that moves; averaging them would produce a figure no source
 * states, and taking the lower one would flatter the deal. The newest is at
 * least a figure somebody published, and every row stays readable beside it.
 */
function pick(rows: readonly DealCost[], component: CostComponent): DealCost | null {
  const mine = rows
    .filter((one) => one.component === component)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return mine[mine.length - 1] ?? null;
}

export function landedEconomics(input: {
  equipmentClass: string;
  destination: string;
  costs: readonly DealCost[];
}): LandedEconomics {
  const key = equipmentKey(input.equipmentClass);
  const destKey = jurisdictionKey(input.destination);

  /*
   * A factory price has no destination and a duty has no origin, so a row with
   * no destination applies to every lane out of that class. The filter is
   * therefore "this class, and either this destination or none" rather than an
   * exact match on both — which is what the nullable column in the schema is
   * for.
   */
  const mine = input.costs.filter(
    (one) =>
      one.equipmentKey === key &&
      (one.destination === null || jurisdictionKey(one.destination) === destKey),
  );

  const components: ComponentReading[] = [...COST_SIDE, 'BUYER_ALTERNATIVE' as const].map(
    (component) => {
      const row = pick(mine, component);
      const loadBearing = LOAD_BEARING_COMPONENTS.includes(component);
      return {
        component,
        amountCents: row?.amountCents ?? null,
        currency: row?.currency ?? null,
        basis: row?.basis ?? null,
        sourceClaimId: row?.sourceClaimId ?? null,
        loadBearing,
        task: row ? null : COMPONENT_TASK[component],
      };
    },
  );

  /*
   * `=== null` rather than a truthiness test, because a published **zero** is a
   * figure and reading it as an absence is an unknown taken as the assumption
   * — here the unfavourable one, which is the rarer direction and no less
   * wrong. A duty-free tariff line is published as `0`, and it is often the
   * exact fact that makes one of these deals work; the first version of this
   * filter withheld the whole landed cost over it while every line was
   * established, and said the duty was a line nobody had found.
   */
  const missing = LOAD_BEARING_COMPONENTS.filter(
    (component) =>
      (components.find((one) => one.component === component)?.amountCents ?? null) === null,
  );

  const present = components.filter(
    (one) => one.component !== 'BUYER_ALTERNATIVE' && one.amountCents !== null,
  );
  const currencies = new Set(present.map((one) => one.currency).filter(Boolean));
  const bases = new Set(present.map((one) => one.basis?.replace(/\s+/g, ' ').trim().toLowerCase()));

  const withheld: WithheldReason[] = [];
  if (missing.length > 0) withheld.push('MISSING_LOAD_BEARING');
  if (currencies.size > 1) withheld.push('MIXED_CURRENCY');
  if (bases.size > 1) withheld.push('MIXED_BASIS');

  const alternative = components.find((one) => one.component === 'BUYER_ALTERNATIVE') ?? null;
  const buyerAlternativeCents = alternative?.amountCents ?? null;

  const landedCents =
    withheld.length === 0
      ? present.reduce((sum, one) => sum + (one.amountCents ?? 0), 0)
      : null;

  const currency = currencies.size === 1 ? ([...currencies][0] ?? null) : null;
  const basis = bases.size === 1 ? (present[0]?.basis ?? null) : null;

  /*
   * A saving needs both halves to be real figures on comparable terms. With
   * the landed cost withheld it is withheld too — never computed against
   * whatever happens to be present, which would be the unknown-as-favourable
   * assumption at the most persuasive number in the deal.
   */
  const savingCents =
    landedCents !== null &&
    buyerAlternativeCents !== null &&
    alternative?.currency === currency &&
    (alternative?.basis?.replace(/\s+/g, ' ').trim().toLowerCase() ?? null) ===
      (basis?.replace(/\s+/g, ' ').trim().toLowerCase() ?? null)
      ? buyerAlternativeCents - landedCents
      : null;

  return {
    equipmentClass: input.equipmentClass,
    destination: input.destination,
    components,
    landedCents,
    currency,
    basis,
    withheld,
    buyerAlternativeCents,
    savingCents,
    missing,
    because: explain({ withheld, missing, landedCents, savingCents, buyerAlternativeCents, basis }),
  };
}

function explain(input: {
  withheld: WithheldReason[];
  missing: CostComponent[];
  landedCents: number | null;
  savingCents: number | null;
  buyerAlternativeCents: number | null;
  basis: string | null;
}): string {
  const parts: string[] = [];

  if (input.withheld.includes('MISSING_LOAD_BEARING')) {
    parts.push(
      `The landed cost is withheld because ${input.missing.length} load-bearing ` +
        `line${input.missing.length === 1 ? '' : 's'} ` +
        `(${input.missing.join(', ')}) ${input.missing.length === 1 ? 'has' : 'have'} no ` +
        'published figure. A total that skipped them would be wrong in the direction that ' +
        'makes the deal look worth doing.',
    );
  }
  if (input.withheld.includes('MIXED_CURRENCY')) {
    parts.push(
      'The figures are in more than one currency. Converting them would put a rate nobody ' +
        'published inside a number presented as published arithmetic.',
    );
  }
  if (input.withheld.includes('MIXED_BASIS')) {
    parts.push(
      'The figures are on more than one basis — a price per unit against a rate per ' +
        'container, or similar. Reconciling them needs a load plan Brain does not have, and ' +
        'assuming one would be inventing it.',
    );
  }

  if (input.landedCents !== null) {
    parts.push(
      `Every load-bearing line has a published figure, on one basis${
        input.basis ? ` (${input.basis})` : ''
      }, so the landed cost is the sum of them.`,
    );
    if (input.savingCents === null && input.buyerAlternativeCents === null) {
      parts.push(
        'What the buyer pays today is unknown, so whether this saves them anything is ' +
          'unknown too — and that, rather than the landed cost, is what decides whether they ' +
          'would switch.',
      );
    } else if (input.savingCents === null) {
      parts.push(
        "The buyer's current cost is on different terms from ours, so the two are not " +
          'comparable as they stand.',
      );
    } else if (input.savingCents <= 0) {
      parts.push(
        'The buyer pays no more than this today. That is a reason to decline rather than a ' +
          'reason to look for a cheaper supplier of the same thing.',
      );
    }
  }

  return parts.join(' ');
}

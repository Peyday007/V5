/**
 * Where a product stops being a catalog entry and becomes work somebody
 * pursues.
 *
 * ---------------------------------------------------------------------------
 * Pursuit is Cash Mode's, and there is no second lifecycle here
 * ---------------------------------------------------------------------------
 *
 * Cash Mode already owns execution: the standing commercial authority that
 * says what may be spent, the recorded `cash_actions` row that is the only
 * evidence an action happened, the money ledger, the jobs, the needs. A second
 * set of those in this kernel would be a second security model, and the weaker
 * of two always wins.
 *
 * So a product whose format has reached SELLABLE is **promoted** into a
 * `cash_opportunities` row and everything after that is machinery that already
 * exists. The product keeps its own rows; what it gains is a pointer.
 *
 * ---------------------------------------------------------------------------
 * `price_cents` is written here, and dealflow deliberately does not write it
 * ---------------------------------------------------------------------------
 *
 * The difference is worth stating because the rule looks contradicted. A cash
 * card's price means *what we are paid*. In a cross-border equipment deal that
 * is a commission under a structure nobody has chosen, so §45 refuses to write
 * it and the landed cost — the largest number in the deal — stays out of the
 * field that decides what Brain thinks we earn.
 *
 * Here what we are paid is exactly what `NET_RECEIPT_PER_UNIT` means, and a
 * source has published it. So it is written when that figure exists and left
 * null when it does not — and it is never taken from `RETAIL_PRICE`, which is
 * the same refusal one component along: a shelf price in the receipts field
 * would overstate what this operation earns by the retailer's whole margin.
 */
import { createOpportunity, updateOpportunity } from '../../repos/cashPortfolio.ts';
import { archiveOpportunity } from '../cash/opportunities.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { linkPuzzleOpportunity } from '../../repos/puzzle.ts';
import type { UnitEconomics } from './economics.ts';
import type { FormatMaturity } from './maturity.ts';
import type { PuzzleSnapshot } from './graph.ts';
import type { CashOpportunity, PuzzleProduct } from '../../domain/types.ts';

const PROMOTED = 'PUZZLE_PRODUCT_PROMOTED';

export interface Promotion {
  productId: string;
  opportunityId: string;
  title: string;
}

/**
 * Promote every qualified product of a sellable format that holds no
 * opportunity yet.
 *
 * Derived from the readings on the tick rather than hooked to the moment a
 * format became sellable — the fifth time this repository has needed that
 * distinction. A hook fixes one entrance; a derivation reaches every entrance
 * plus everything already stranded, survives a tick that died halfway, and
 * cannot be missed by a code path that forgot to call something.
 */
export async function promoteSellableProducts(input: {
  projectId: string;
  snapshot: PuzzleSnapshot;
  maturity: readonly FormatMaturity[];
  economics: readonly UnitEconomics[];
}): Promise<Promotion[]> {
  const mode = await getCashMode(input.projectId);
  if (!mode) return [];

  const sellable = new Set(
    input.maturity.filter((one) => one.reached.includes('SELLABLE')).map((one) => one.formatKey),
  );
  const qualified = new Set(
    input.snapshot.qualifications
      .filter((one) => one.verdict === 'QUALIFIED')
      .map((one) => one.productId),
  );
  const byMaster = new Map(input.snapshot.masters.map((one) => [one.id, one] as const));

  const out: Promotion[] = [];
  for (const product of input.snapshot.products) {
    if (product.retiredAt !== null || product.opportunityId !== null) continue;
    if (!qualified.has(product.id)) continue;
    const master = byMaster.get(product.masterId);
    if (!master || !sellable.has(master.formatKey)) continue;

    const view = input.snapshot.formats.find((one) => one.key === master.formatKey);
    const channel = view?.channels[0] ?? null;
    const buyer = view?.demand[0] ?? null;
    const reading = input.economics.find(
      (one) => one.formatKey === master.formatKey && one.productClass === product.productClass,
    );

    const opportunity = await createOpportunity({
      projectId: input.projectId,
      cashModeId: mode.id,
      ownerUserId: mode.ownerUserId,
      title: product.title,
      /*
       * A puzzle product sold into a published need is the shape
       * `EXISTING_BUYING_SIGNAL` names: somebody has said, in public, that
       * they buy this. Choosing the mechanism from the shape of the thing
       * rather than from a worker's prose is the same discipline
       * `mechanismForSignal` already applies.
       */
      mechanism: 'EXISTING_BUYING_SIGNAL',
      currency: reading?.currency ?? mode.currency,
      industry: view?.name ?? master.formatKey,
      source: channel?.name ?? null,
      sourceClaimId: buyer?.sourceClaimId ?? channel?.sourceClaimId ?? null,
      opportunitySignal: 'ACTIVE_BUYER_DEMAND',
    });

    const won = await linkPuzzleOpportunity({
      productId: product.id,
      opportunityId: opportunity.id,
    });
    if (!won) {
      /*
       * Another tick got there first. Retire this one rather than leaving two
       * pieces of work for one product — and archive rather than delete,
       * because §5 does not allow destroying a row and the reason is worth
       * keeping.
       */
      await archiveOpportunity({
        opportunityId: opportunity.id,
        actorRef: 'BRAIN',
        reason:
          'A concurrent pass promoted the same product first, so this duplicate was retired ' +
          'before anybody worked on it.',
      });
      continue;
    }

    await fill(opportunity, product, {
      formatName: view?.name ?? master.formatKey,
      channel: channel?.name ?? null,
      channelTerms: channel?.terms ?? null,
      buyer: buyer?.buyer ?? null,
      buyerStatement: buyer?.statement ?? null,
      buyerObservedOn: buyer?.observedOn ?? null,
      reading: reading ?? null,
    });

    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: opportunity.id,
      kind: PROMOTED,
      actorRef: 'BRAIN',
      summary: `${product.title} reached a sellable format and was promoted into the portfolio.`,
      detail: {
        productId: product.id,
        masterId: master.id,
        formatKey: master.formatKey,
        productClass: product.productClass,
        instanceCount: product.instanceCount,
        receiptsPerUnitCents: reading?.receiptsPerUnitCents ?? null,
        contributionPerUnitCents: reading?.contributionPerUnitCents ?? null,
        withheld: reading?.withheld ?? null,
      },
    });

    out.push({ productId: product.id, opportunityId: opportunity.id, title: product.title });
  }
  return out;
}

/**
 * Fill the card from the product's own rows.
 *
 * Every value here traces to a claim or to a validated puzzle. Nothing is
 * composed from a model's prose and nothing is left for a sentence somebody
 * types later.
 */
async function fill(
  opportunity: CashOpportunity,
  product: PuzzleProduct,
  context: {
    formatName: string;
    channel: string | null;
    channelTerms: string | null;
    buyer: string | null;
    buyerStatement: string | null;
    buyerObservedOn: string | null;
    reading: UnitEconomics | null;
  },
): Promise<void> {
  const reading = context.reading;
  await updateOpportunity(opportunity.id, {
    payer: context.buyer,
    reachable_channel: context.channel,
    buying_signal: context.buyerStatement,
    signal_observed_at: context.buyerObservedOn,
    offer_scope:
      `${product.instanceCount} validated ${context.formatName} puzzle(s), compiled as a ` +
      `${product.productClass.toLowerCase().replace(/_/g, ' ')}` +
      (product.difficulty ? ` at ${product.difficulty.toLowerCase()} difficulty` : '') +
      (product.audience ? `, for ${product.audience}` : '') +
      '. Every puzzle in it was checked from its printed form: solvable, its answer key ' +
      'verified against the grid, and — where the format allows the claim — its answer unique.',
    acceptance_condition:
      'The buyer receives the stated number of puzzles of the stated kind and difficulty, each ' +
      'with a verified answer key, in the agreed format by the agreed date.',
    delivery_method: context.channel,
    fulfillment_owner: 'BRAIN',
    /*
     * What we are paid, where a source says so. Never the retail price: see
     * the header. A withheld reading leaves it null, which keeps the card off
     * `readyToTest` until somebody has established the number rather than
     * letting a plausible one through.
     */
    price_cents: reading?.receiptsPerUnitCents ?? null,
    economics_note: reading
      ? reading.withheld
        ? `The money is not settled: ${reading.withheld}`
        : `Net receipts ${reading.receiptsPerUnitCents} ${reading.currency ?? ''} per unit ` +
          `against ${reading.perUnitCostCents} of per-unit cost, a contribution of ` +
          `${reading.contributionPerUnitCents}` +
          (reading.breakevenUnits !== null
            ? `, with ${reading.breakevenUnits} unit(s) covering the ${reading.perRunCostCents} ` +
              'spent once per run.'
            : '.')
      : 'Nothing has been published about what this earns or costs.',
    peak_funding_cents: null,
    next_action: context.channel
      ? `Offer it through ${context.channel}${
          context.channelTerms ? ` (${context.channelTerms})` : ''
        }. Nothing here authorizes submitting, listing or contacting anybody: that is a ` +
        'recorded commercial action under the standing grant.'
      : 'Establish a route to the buyer. Nothing here authorizes contacting anybody.',
  });
}

/**
 * A constructed arrangement as an executable step list (§93, §95 C-8). Pure.
 *
 * Production, 2026-11-18 (goal wst_7b4fcbb5f2384f31b6c3): the plan's leading
 * candidate was a constructed arrangement — a buyer population, a supplier, a
 * transaction design and a revenue model — and the plan's `steps` held one
 * line, "Discover, construct and research openings…", with no execution. When
 * no reconstruction is adopted and nothing is for sale, `planSteps` had only
 * the goal's generic next step to sequence, so the arrangement's known
 * structure never reached the plan as work.
 *
 * This reads that structure, and only that structure, into steps: who to reach
 * and how, what supply to line up and from whom, the offer and price, how cash
 * settles and when, ordering and delivery, and a repeat where the design
 * repeats. Each part the arrangement has not established (`unknownParts`) is a
 * RESEARCH step carrying its own question, and conversion — which only a sale
 * measures — makes the offer a VALIDATE step. Nothing here is a fact the
 * arrangement does not hold: an unknown stays a question, never a number.
 */
import type { ConstructedArrangement } from '../cash/construct.ts';
import { PART_ASK } from '../cash/construct.ts';
import type { ModelledOpportunity } from '../cash/goalScenario.ts';
import { designFacts, STRUCTURES } from '../cash/properties.ts';
import { fieldFromInput } from './planSet.ts';
import type { PlanStep } from './plan.ts';

/** Which part of the transaction an unknown part belongs to: the research step that asks it. */
type Link = 'BUYERS' | 'PRICE' | 'SUPPLY' | 'SETTLEMENT' | 'COST' | 'REPEAT';

const LINK_OF_PART: Record<string, Link> = {
  buyers: 'BUYERS',
  need_rate: 'BUYERS',
  min_participants: 'BUYERS',
  value: 'PRICE',
  fee: 'PRICE',
  commission: 'SUPPLY',
  supply_cost: 'SUPPLY',
  supply_units: 'SUPPLY',
  fixed_cost: 'SUPPLY',
  prepay_share: 'SETTLEMENT',
  days_to_cash: 'SETTLEMENT',
  refund_terms: 'SETTLEMENT',
  cost: 'COST',
  repeat_rate: 'REPEAT',
};

const LINK_LABEL: Record<Link, string> = {
  BUYERS: 'Research the buyers',
  PRICE: 'Research the price',
  SUPPLY: 'Research the supply',
  SETTLEMENT: 'Research settlement',
  COST: 'Research the cost per deal',
  REPEAT: 'Research repeat purchases',
};

const ORDER: Link[] = ['BUYERS', 'PRICE', 'SUPPLY', 'SETTLEMENT', 'COST', 'REPEAT'];

export interface ArrangementStepContext {
  currency: string;
  daysLeft: number | null;
  /** Money that may be tied up before the first customer payment, major units; null when no limit is set. */
  capitalBeforeProof: number | null;
  /** The arrangement's own scenario conversion, when one was made: what its timing and costs read from. */
  modelled?: ModelledOpportunity | null;
  /**
   * Set when the plan holds no estimate of this arrangement (`plan.ts`): why,
   * in one sentence. Its steps are then the work that would make it one, and
   * the first step says so — a construction nothing priced is never presented
   * as an estimated plan's subject (production, 2026-11-18: 0 of 208 estimated,
   * and the steps read as the plan).
   */
  unestimated?: string | null;
  /** Permissions a send needs and a collection needs: execution dependencies, never blocks on the plan. */
  send: string[];
  collect: string[];
}

const money = (n: number, currency: string) => `${currency} ${Math.round(n).toLocaleString('en-US')}`;
const range = (low: number, high: number, currency: string) => (Math.round(low) === Math.round(high) ? money(low, currency) : `${money(low, currency)}–${Math.round(high).toLocaleString('en-US')}`);

/**
 * The arrangement's steps, numbered from `startAt`. Research steps start on
 * day 0 and run beside one another; execution steps run in order, each naming
 * the earlier step it follows (`dependsOn`) and the research it needs
 * answered first (`requires`).
 */
export function arrangementSteps(a: ConstructedArrangement, ctx: ArrangementStepContext, startAt = 1): PlanStep[] {
  const def = STRUCTURES[a.design.base];
  const facts = designFacts(a.design);
  const pooled = a.design.aggregation === 'POOLED_BUYERS';
  const threshold = a.design.funding === 'THRESHOLD_PRESALE';
  const prepaid = a.design.funding === 'PREPAID' || threshold;
  const unknown = new Set(a.unknownParts);
  const buyers = a.demand.name;
  const supplier = a.supply?.name ?? null;
  const unit = pooled ? 'slot in a shared run' : 'unit';
  const cur = ctx.currency;
  const steps: PlanStep[] = [];
  const push = (step: Omit<PlanStep, 'order'>): number => {
    const order = startAt + steps.length;
    steps.push({ order, ...step });
    return order;
  };

  // 1. Every unknown part, as the research question that establishes it.
  const byLink = new Map<Link, string[]>();
  for (const part of a.unknownParts) {
    if (part === 'conversion') continue; // only a sale measures it: the offer below validates it
    const link = LINK_OF_PART[part] ?? 'COST';
    const ask = PART_ASK[part] ?? part;
    byLink.set(link, [...(byLink.get(link) ?? []), ask]);
  }
  const access = (a.positionQuestions ?? []).filter((q) => q.kind === 'BUYER_ACCESS').map((q) => q.ask ?? q.question);
  if (access.length > 0) byLink.set('BUYERS', [...(byLink.get('BUYERS') ?? []), ...access]);
  // Settlement nothing stated: a buyer's terms are unknown, never prepaid (invariant 39).
  if (!prepaid && facts.payer === 'BUYER' && (!a.buyerTerms || a.buyerTerms.timing === 'UNKNOWN') && !(byLink.get('SETTLEMENT') ?? []).length) {
    byLink.set('SETTLEMENT', [PART_ASK['days_to_cash'] ?? 'how many days from agreement to usable money']);
  }
  const research = new Map<Link, number>();
  for (const link of ORDER) {
    const asks = byLink.get(link);
    if (!asks || asks.length === 0) continue;
    const subject = link === 'SUPPLY' && supplier ? `"${supplier}" supplying "${buyers}"` : `"${buyers}"`;
    const question = `For ${subject}: ${[...new Set(asks)].join('; ')}.`;
    research.set(
      link,
      push({
        label: LINK_LABEL[link],
        detail: `Not yet established for this arrangement. ${question}`,
        startDay: { low: 0, high: 0 },
        cost: 0,
        basis: 'ASSUMPTION',
        owner: 'BRAIN',
        ownerReason: null,
        dependsOn: null,
        kill: 'no published source answers it after two research rounds → the part stays unknown; re-plan on the next arrangement rather than assume it',
        execution: [],
        kind: 'RESEARCH',
        question,
        requires: [],
        withinLimits: null,
      }),
    );
  }
  const needs = (...links: Link[]) => links.map((l) => research.get(l)).filter((n): n is number => n !== undefined);
  const basisOf = (...links: Link[]) => (needs(...links).length > 0 ? 'ASSUMPTION' : 'ESTIMATE') as PlanStep['basis'];
  let previous: number | null = null;
  const next = (step: Omit<PlanStep, 'order' | 'dependsOn'>): number => {
    previous = push({ ...step, dependsOn: previous });
    return previous;
  };

  // 2. Who to reach, and how.
  next({
    label: `Reach ${buyers}`,
    detail:
      `Build the list of "${buyers}" from a published directory, register or list` +
      `${unknown.has('buyers') ? ' (how many exist is not yet established)' : ''}` +
      ` and contact them directly through Brain's outreach campaign${a.need ? `, about "${a.need.name}"` : ''}.`,
    startDay: null,
    cost: 0,
    basis: basisOf('BUYERS'),
    owner: 'BRAIN',
    ownerReason: null,
    kill: `the list holds too few reachable "${buyers}" for the deals the goal needs → re-plan on the next arrangement`,
    execution: ctx.send,
    kind: 'EXECUTE',
    requires: needs('BUYERS'),
    withinLimits: null,
  });

  // 3. Supply, lined up before anything is sold.
  if (def.needsSupply) {
    const terms =
      a.design.base === 'BROKER'
        ? 'the commission share it pays on a brokered sale'
        : a.design.base === 'REFERRAL'
          ? 'the fee it pays per referred buyer'
          : pooled
            ? `its price for one shared run, the most participants a run takes, and its lead time`
            : 'its price per unit and its lead time';
    const runCost = a.fixedCost && a.fixedCost.tier !== 'UNKNOWN' ? ` A shared run is published at about ${range(a.fixedCost.p10, a.fixedCost.p90, cur)}.` : '';
    next({
      label: `Get written terms from ${supplier ?? 'a supplier'}`,
      detail: `Ask ${supplier ? `"${supplier}"` : 'a supplier of this work'} for ${terms}, in writing, before any buyer is offered it.${runCost}`,
      startDay: null,
      cost: 0,
      basis: basisOf('SUPPLY'),
      owner: 'BRAIN',
      ownerReason: null,
      kill: `no ${supplier ? `"${supplier}"` : 'supplier'} quotes terms that leave a margin under what buyers pay → drop this supply and re-plan`,
      execution: ctx.send,
      kind: 'EXECUTE',
      requires: needs('SUPPLY'),
      withinLimits: null,
    });
  }

  // 4. The offer and its price; conversion is measured here.
  const priced = a.value.tier !== 'UNKNOWN' && !unknown.has('value') && a.value.p90 > 0;
  const price = priced ? `at ${range(a.value.p10, a.value.p90, cur)} per ${unit}${a.value.notEvidence ? ' (carried from another payment mechanism: an assumption)' : ''}` : 'at the price the price research establishes (not yet known)';
  const funding = threshold
    ? `as a presale: each buyer pays for a ${unit} now, held until enough have joined for the run to pay; if it does not fill, every buyer is refunded`
    : a.design.funding === 'PREPAID'
      ? 'paid in advance, before supply is bought'
      : facts.payer === 'SUPPLIER'
        ? 'free to the buyer: the supplier pays'
        : 'paid on delivery';
  const conversionKnown = !unknown.has('conversion') && a.conversion !== undefined;
  const conversionQuestion = PART_ASK['conversion'] ?? 'what share of buyers approached agree';
  const offerKill = threshold
    ? `the run does not reach its minimum participants before the deadline leaves time to deliver → refund every buyer and re-plan`
    : conversionKnown
      ? `fewer than ${Math.max(0.1, Math.round(a.conversion!.p10 * 1000) / 10)}% of the first 200 approached agree (the low end of what is published for these buyers) → stop and re-plan`
      : 'no buyer agrees in the first 200 approached → stop and re-plan on the next arrangement';
  next({
    label: conversionKnown ? `Offer it to ${buyers}` : `Validate the offer with ${buyers}`,
    detail: `Offer ${a.need ? `"${a.need.name}" ` : ''}${def.needsSupply ? `fulfilled by ${supplier ? `"${supplier}"` : 'the supplier'} ` : ''}${price}, ${funding}.${conversionKnown ? '' : ` The first batch measures what share agree: ${conversionQuestion}.`}`,
    startDay: null,
    cost: 0,
    basis: priced && conversionKnown ? 'ESTIMATE' : 'ASSUMPTION',
    owner: 'BRAIN',
    ownerReason: null,
    kill: offerKill,
    execution: ctx.send,
    kind: conversionKnown ? 'EXECUTE' : 'VALIDATE',
    ...(conversionKnown ? {} : { question: `For "${buyers}": ${conversionQuestion}.` }),
    requires: needs('PRICE', 'BUYERS'),
    withinLimits: null,
  });

  // 5. Settlement, and when cash lands against the deadline.
  const days = fieldFromInput(ctx.modelled?.daysToCash, 'days to usable cash');
  const daysHigh = days ? (typeof days.high === 'number' ? days.high : typeof days.value === 'number' ? days.value : null) : null;
  const inTime = daysHigh === null || ctx.daysLeft === null ? null : daysHigh <= ctx.daysLeft;
  const when = days && daysHigh !== null ? ` Cash is usable about ${Math.round(Number(days.low ?? daysHigh))}–${Math.round(daysHigh)} days after agreement (${days.status.toLowerCase()})${ctx.daysLeft !== null ? `, ${inTime ? 'inside' : 'OUTSIDE'} the ${ctx.daysLeft} days left` : ''}.` : ' When cash is usable is not yet established.';
  const terms = a.buyerTerms && a.buyerTerms.timing !== 'UNKNOWN' ? ` These buyers are stated to pay ${a.buyerTerms.timing === 'PREPAID' ? 'in advance' : 'in arrears'} (${a.buyerTerms.basis}).` : '';
  const fromSupplier = a.design.base === 'BROKER' || a.design.base === 'REFERRAL';
  const settle = (detail: string) =>
    next({
      label: fromSupplier ? `Collect the ${a.design.base === 'BROKER' ? 'commission' : 'referral fee'} from ${supplier ?? 'the supplier'}` : 'Collect payment',
      detail: `${detail}${terms}${when}`,
      startDay: null,
      cost: 0,
      basis: basisOf('SETTLEMENT'),
      owner: 'BRAIN',
      ownerReason: null,
      kill: `cash would not be usable by day ${ctx.daysLeft ?? 'the deadline'} → re-plan this arrangement's payment terms (a deposit or a presale) or drop it`,
      execution: ctx.collect,
      kind: 'EXECUTE',
      requires: needs('SETTLEMENT'),
      withinLimits: inTime,
    });

  // 6. Ordering supply: money paid out, so the owner's; funded by buyers when the design presells.
  const atRisk = a.stress.worstCaseCents !== null ? a.stress.worstCaseCents / 100 : null;
  const order = () => {
    const committed = prepaid ? 0 : (atRisk ?? 0);
    const within = prepaid ? true : atRisk === null || ctx.capitalBeforeProof === null ? null : atRisk <= ctx.capitalBeforeProof;
    const costText = prepaid
      ? 'paid from what buyers already paid, so nothing of the owner\'s is tied up first'
      : atRisk !== null
        ? `up to ${money(atRisk, cur)} paid before buyers pay${ctx.capitalBeforeProof !== null ? `, ${within ? 'inside' : 'OVER'} the ${money(ctx.capitalBeforeProof, cur)} allowed before proof` : ''}`
        : 'what it costs before buyers pay is not yet established';
    next({
      label: `Order the ${pooled ? 'run' : 'work'} from ${supplier ?? 'the supplier'}`,
      detail: `Place the order on the written terms${threshold ? ' once the run has its minimum participants' : ''}: ${costText}.`,
      startDay: null,
      cost: committed,
      basis: basisOf('SUPPLY', 'COST'),
      owner: 'PERSON',
      ownerReason: prepaid ? 'a payment to the supplier, from the money buyers paid in' : `a payment${committed > 0 ? ` of ${money(committed, cur)}` : ''} from the owner's account, inside the goal's limits`,
      kill: `the order would tie up more than ${ctx.capitalBeforeProof !== null ? money(ctx.capitalBeforeProof, cur) : 'the goal allows'} before buyers pay, or the supplier's price leaves no margin → refund buyers and re-plan`,
      execution: [],
      kind: 'EXECUTE',
      requires: needs('SUPPLY', 'COST'),
      withinLimits: within,
    });
  };
  const deliver = () =>
    next({
      label: 'Deliver and confirm',
      detail: facts.fulfiller === 'BRAIN' ? `Brain produces ${supplier ? `"${supplier}"` : 'the deliverable'} for each buyer and records delivery.` : `${supplier ? `"${supplier}"` : 'The supplier'} delivers to each buyer; Brain confirms delivery with each buyer and records it.`,
      startDay: null,
      cost: 0,
      basis: 'ESTIMATE',
      owner: 'BRAIN',
      ownerReason: null,
      kill: 'a buyer reports non-delivery or a defect → hold collection for that buyer, refund under the stated terms, and re-plan the supply',
      execution: [],
      kind: 'EXECUTE',
      requires: [],
      withinLimits: null,
    });

  const ordersSupply = a.design.base === 'SUBCONTRACT' || a.design.base === 'POOL';
  if (prepaid) {
    settle(threshold ? 'Charge each committed buyer once the run reaches its minimum; refund all if it does not.' : 'Collect each buyer\'s payment before supply is bought.');
    if (ordersSupply) order();
    deliver();
  } else if (fromSupplier) {
    deliver();
    settle(a.design.base === 'BROKER' ? 'The supplier pays the agreed commission after the brokered sale.' : 'The supplier pays the agreed fee once a referred buyer purchases.');
  } else {
    if (ordersSupply) order();
    deliver();
    settle('Invoice each buyer on delivery.');
  }

  // 7. A design that repeats asks for the next run or renewal.
  if (a.design.repeat !== 'ONE_OFF') {
    next({
      label: a.design.repeat === 'SUBSCRIPTION' ? 'Renew' : 'Run the next group',
      detail: a.design.repeat === 'SUBSCRIPTION' ? `Renew the same "${buyers}" for the next period.` : `Offer the next run to a fresh group of "${buyers}".`,
      startDay: null,
      cost: 0,
      basis: basisOf('REPEAT'),
      owner: 'BRAIN',
      ownerReason: null,
      kill: 'fewer buyers return or join than the first run needed → stop repeating and re-plan',
      execution: [...ctx.send, ...ctx.collect],
      kind: 'EXECUTE',
      requires: needs('REPEAT'),
      withinLimits: null,
    });
  }
  if (ctx.unestimated && steps[0]) steps[0] = { ...steps[0], detail: `${ctx.unestimated} ${steps[0].detail}` };
  return steps;
}

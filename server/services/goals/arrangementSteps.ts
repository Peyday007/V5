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
 *
 * Production, 2026-11-19 (release cb6d27b5, the same goal): every execution
 * step carried no day and every cost was 0, so nothing could be scheduled or
 * checked against the goal's limits although the plan was scored on a model
 * holding days to usable cash, direct cost and money tied up. Each step's day
 * and cost are now read from those same model values (`ctx.modelled`, read
 * through `fieldFromInput` exactly as the plan's candidate is), with `when`
 * saying what the day rests on; where the model holds no value the day stays
 * null and `when` names the step or measurement that establishes it. Research
 * answers in `RESEARCH_TURNAROUND_DAYS`, the turnaround the plan's research
 * decisions are made with.
 */
import { namesOneOrganisation } from '../../domain/industry.ts';
import type { ConstructedArrangement } from '../cash/construct.ts';
import { PART_ASK } from '../cash/construct.ts';
import type { ModelledOpportunity } from '../cash/goalScenario.ts';
import { designFacts, STRUCTURES } from '../cash/properties.ts';
import { fieldFromInput, type ModelField } from './planSet.ts';
import { RESEARCH_TURNAROUND_DAYS, type PlanStep } from './plan.ts';

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
  /**
   * The days to usable cash the plan's simulation drew for this arrangement
   * (its demand row): what its reach was scored on. Read only when no evidence
   * or justified inference establishes the days, and then labelled an assumption.
   */
  simulatedDays?: { p10: number; p50: number; p90: number } | null;
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
  const one = namesOneOrganisation(buyers);
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
    // One organisation is not counted or listed: what is unknown is who there buys, and how to reach them.
    const ask = part === 'buyers' && one ? `who at "${buyers}" decides this purchase, and the published address, contact or submission page it is reached at` : (PART_ASK[part] ?? part);
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
        when: `day 0, answered in about ${RESEARCH_TURNAROUND_DAYS} days (the research turnaround the plan decides research with)`,
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
  /** The research step that establishes a part, or the measurement that does when no research step asks it. */
  const establishedBy = (link: Link, otherwise: string) => (research.has(link) ? `${LINK_LABEL[link]} (step ${research.get(link)})` : otherwise);
  let previous: number | null = null;
  let previousDay: Day | null = { low: 0, high: 0 };
  const next = (step: Omit<PlanStep, 'order' | 'dependsOn'>): number => {
    previous = push({ ...step, dependsOn: previous });
    previousDay = step.startDay;
    return previous;
  };
  /** A step starts once the research it needs has answered, and not before the step it follows. */
  const startOf = (requires: number[]): Day | null => {
    if (previousDay === null) return null;
    const wait = requires.length > 0 ? RESEARCH_TURNAROUND_DAYS : 0;
    return { low: Math.max(previousDay.low, wait), high: Math.max(previousDay.high, wait) };
  };
  const startWhen = (requires: number[], day: Day | null) =>
    day === null ? 'after the step it follows, whose day is not yet established' : requires.length > 0 ? `${dayText(day)}: once its research (step ${requires.join(', step ')}) has answered, about ${RESEARCH_TURNAROUND_DAYS} days` : `${dayText(day)}: nothing it needs is unanswered`;

  // The model values the plan was scored with, read exactly as the plan's candidate reads them (`candidateFromArrangement`).
  const days = fieldFromInput(ctx.modelled?.daysToCash, 'days to usable cash');
  const daysSpan = spanOf(days);
  const simulated = !daysSpan && ctx.simulatedDays ? { low: ctx.simulatedDays.p10, high: ctx.simulatedDays.p90 } : null;
  const cashSpan = daysSpan ?? simulated;
  const cashStanding = days ? days.status.toLowerCase() : 'swept by the plan\'s simulation: an assumption, not established';
  /*
   * A presale over buyers stated to pay in arrears contradicts itself
   * (transfer test, 2026-11-19, goal wst_fa4761773e4441b89e5a: step 8 presold
   * to "VA", step 9 said VA pays after a procurement award). The steps say so,
   * and nothing after the offer is scheduled as if the presale settled.
   */
  const conflict = prepaid && a.buyerTerms?.timing === 'ARREARS';
  const arrears = conflict ? ` "${buyers}" are stated to pay in arrears (${a.buyerTerms!.basis})` : '';
  const direct = fieldFromInput(ctx.modelled?.directCost, 'direct cost per deal');
  const directSpan = spanOf(direct);
  const tiedUp = fieldFromInput(ctx.modelled?.capital, 'money tied up');
  const tiedUpSpan = spanOf(tiedUp);

  // 2. Who to reach, and how.
  const reachNeeds = needs('BUYERS');
  const reachDay = startOf(reachNeeds);
  next({
    label: `Reach ${buyers}`,
    detail:
      (one
        ? `Contact "${buyers}" directly at its published address, contact or submission page${a.need ? `, about "${a.need.name}"` : ''}, through Brain's outreach campaign.`
        : `Build the list of "${buyers}" from a published directory, register or list` +
          `${unknown.has('buyers') ? ' (how many exist is not yet established)' : ''}` +
          ` and contact them directly through Brain's outreach campaign${a.need ? `, about "${a.need.name}"` : ''}.`) +
      ' The model prices no outreach cost for these sends.',
    startDay: reachDay,
    when: startWhen(reachNeeds, reachDay),
    cost: 0,
    basis: basisOf('BUYERS'),
    owner: 'BRAIN',
    ownerReason: null,
    kill: one ? `"${buyers}" cannot be reached at any published address, or does not answer the first three attempts → re-plan on the next arrangement` : `the list holds too few reachable "${buyers}" for the deals the goal needs → re-plan on the next arrangement`,
    execution: ctx.send,
    kind: 'EXECUTE',
    requires: reachNeeds,
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
    // A commission or referral agreement binds the owner; a quote does not (the order that pays one is the owner's below).
    const signs = a.design.base === 'BROKER' || a.design.base === 'REFERRAL';
    const supplyNeeds = needs('SUPPLY');
    const supplyDay = startOf(supplyNeeds);
    next({
      label: `Get written terms from ${supplier ?? 'a supplier'}`,
      detail: `Ask ${supplier ? `"${supplier}"` : 'a supplier of this work'} for ${terms}, in writing, before any buyer is offered it.${runCost}${signs ? ' Brain negotiates the terms; the agreement is signed in the owner\'s name.' : ''}`,
      startDay: supplyDay,
      when: startWhen(supplyNeeds, supplyDay),
      cost: 0,
      basis: basisOf('SUPPLY'),
      owner: signs ? 'PERSON' : 'BRAIN',
      ownerReason: signs ? `a ${a.design.base === 'BROKER' ? 'commission' : 'referral'} agreement signed in the owner's name` : null,
      kill: `no ${supplier ? `"${supplier}"` : 'supplier'} quotes terms that leave a margin under what buyers pay → drop this supply and re-plan`,
      execution: ctx.send,
      kind: 'EXECUTE',
      requires: supplyNeeds,
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
  const offerNeeds = needs('PRICE', 'BUYERS');
  // The first agreements come from the offer's first batch: every later day is counted from it.
  const agreeDay = startOf(offerNeeds);
  const agreeOrder = next({
    label: conversionKnown && !conflict ? `Offer it to ${buyers}` : `Validate the offer with ${buyers}`,
    detail: `Offer ${a.need ? `"${a.need.name}" ` : ''}${def.needsSupply ? `fulfilled by ${supplier ? `"${supplier}"` : 'the supplier'} ` : ''}${price}, ${funding}.${conversionKnown ? '' : ` The first batch measures what share agree: ${conversionQuestion}.`}${conflict ? ` This contradicts their terms:${arrears}, so the first batch first measures whether they will pay in advance at all.` : ''}`,
    startDay: agreeDay,
    when: startWhen(offerNeeds, agreeDay),
    cost: 0,
    basis: priced && conversionKnown ? 'ESTIMATE' : 'ASSUMPTION',
    owner: 'BRAIN',
    ownerReason: null,
    kill: offerKill,
    execution: ctx.send,
    kind: conversionKnown && !conflict ? 'EXECUTE' : 'VALIDATE',
    ...(conflict
      ? { question: `For "${buyers}": will they pay before delivery, against their stated terms (${a.buyerTerms!.basis})?${conversionKnown ? '' : ` And ${conversionQuestion}.`}` }
      : conversionKnown
        ? {}
        : { question: `For "${buyers}": ${conversionQuestion}.` }),
    requires: offerNeeds,
    withinLimits: null,
  });

  // 5. Settlement, and when cash lands against the deadline: the offer's day plus the model's days to usable cash.
  const settleSpan: Day | null = agreeDay && cashSpan ? { low: Math.round(agreeDay.low + cashSpan.low), high: Math.round(agreeDay.high + cashSpan.high) } : null;
  // Even the soonest cash lands after the deadline: the plan cannot settle in time, and is not scheduled as if it could.
  const late = !conflict && settleSpan !== null && ctx.daysLeft !== null && settleSpan.low > ctx.daysLeft;
  const cashDay: Day | null = conflict || late ? null : settleSpan;
  const daysUnknown = `days to usable cash, which ${establishedBy('SETTLEMENT', 'the first sale measures')} establishes`;
  // Why a step after the offer has no day: what establishes it, or why it cannot be scheduled at all.
  const pending = conflict
    ? `not scheduled: the design presells, but${arrears}; nothing settles until the offer (step ${agreeOrder}) shows they will pay in advance`
    : late
      ? `not scheduled: cash would be usable on ${dayText(settleSpan!)} (${cashStanding}), after the ${ctx.daysLeft} days left`
      : `not yet scheduled: set by ${daysUnknown}`;
  const cashWhen = cashDay ? `${dayText(cashDay)}: the offer's day plus ${Math.round(cashSpan!.low)}–${Math.round(cashSpan!.high)} days to usable cash (${cashStanding})` : pending;
  const inTime = ctx.daysLeft === null || conflict || settleSpan === null ? null : settleSpan.high <= ctx.daysLeft;
  const when = cashSpan ? ` Cash is usable about ${Math.round(cashSpan.low)}–${Math.round(cashSpan.high)} days after agreement (${cashStanding})${ctx.daysLeft !== null && inTime !== null ? `, ${inTime ? 'inside' : 'OUTSIDE'} the ${ctx.daysLeft} days left` : ''}.` : ' When cash is usable is not yet established.';
  const terms = a.buyerTerms && a.buyerTerms.timing !== 'UNKNOWN' ? ` These buyers are stated to pay ${a.buyerTerms.timing === 'PREPAID' ? 'in advance' : 'in arrears'} (${a.buyerTerms.basis}).` : '';
  const fromSupplier = a.design.base === 'BROKER' || a.design.base === 'REFERRAL';
  // Taking money needs an account in the owner's name: a sign-in only the owner holds (rule 11, MISSING_AUTHORITY).
  const account = ctx.collect.filter((one) => /billing|payment account|merchant|provider/i.test(one));
  const settle = (detail: string) =>
    next({
      label: fromSupplier ? `Collect the ${a.design.base === 'BROKER' ? 'commission' : 'referral fee'} from ${supplier ?? 'the supplier'}` : 'Collect payment',
      detail: `${detail}${terms}${when}`,
      startDay: cashDay,
      when: cashWhen,
      cost: 0,
      basis: simulated || conflict ? 'ASSUMPTION' : basisOf('SETTLEMENT'),
      owner: account.length > 0 ? 'PERSON' : 'BRAIN',
      ownerReason: account.length > 0 ? `a payment account in the owner's name (${account.join(', ')}), which only the owner can open; Brain collects once it is connected` : null,
      kill: `cash would not be usable by day ${ctx.daysLeft ?? 'the deadline'} → re-plan this arrangement's payment terms (a deposit or a presale) or drop it`,
      execution: ctx.collect,
      kind: 'EXECUTE',
      requires: needs('SETTLEMENT'),
      withinLimits: inTime,
    });

  // 6. Ordering supply: money paid out, so the owner's; funded by buyers when the design presells.
  const stressed = a.stress.worstCaseCents !== null ? a.stress.worstCaseCents / 100 : null;
  const atRisk = stressed ?? tiedUpSpan?.high ?? null;
  const atRiskFrom = stressed !== null ? 'the arrangement\'s stress test' : tiedUp ? `the model's money tied up (${tiedUp.status.toLowerCase()})` : null;
  const order = () => {
    const committed = prepaid ? 0 : (atRisk ?? 0);
    const within = prepaid ? true : atRisk === null || ctx.capitalBeforeProof === null ? null : atRisk <= ctx.capitalBeforeProof;
    const costText = prepaid
      ? 'paid from what buyers already paid, so nothing of the owner\'s is tied up first'
      : atRisk !== null
        ? `up to ${money(atRisk, cur)} paid before buyers pay (${atRiskFrom})${ctx.capitalBeforeProof !== null ? `, ${within ? 'inside' : 'OVER'} the ${money(ctx.capitalBeforeProof, cur)} allowed before proof` : ''}`
        : `what it costs before buyers pay is not yet established: ${establishedBy('SUPPLY', establishedBy('COST', 'the supplier\'s written terms establish it'))}`;
    // Paid once buyers have paid (a presale), or on agreement when the owner pays first.
    const day = prepaid || late ? cashDay : agreeDay;
    next({
      label: `Order the ${pooled ? 'run' : 'work'} from ${supplier ?? 'the supplier'}`,
      detail: `Place the order on the written terms${threshold ? ' once the run has its minimum participants' : ''}: ${costText}.`,
      startDay: day,
      when: prepaid ? (cashDay ? `${dayText(cashDay)}: once the buyers' payments are usable` : `once the buyers' payments are usable: ${pending}`) : late ? pending : startWhen([], agreeDay).replace('nothing it needs is unanswered', 'on the first agreement'),
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
  const ordersSupply = a.design.base === 'SUBCONTRACT' || a.design.base === 'POOL';
  const deliver = () => {
    // Delivery has no time of its own in the model: it falls inside days to usable cash, or after payment on a presale.
    const day: Day | null = prepaid ? cashDay : agreeDay && cashDay ? { low: agreeDay.low, high: cashDay.high } : null;
    const deliverWhen = prepaid
      ? cashDay
        ? `${dayText(cashDay)}: once paid (the model holds no separate delivery time)`
        : `once paid: ${pending}`
      : day
        ? `${dayText(day)}: between the first agreement and usable cash, which the model's days to usable cash spans (it holds no separate delivery time)`
        : `after the first agreement: ${pending}`;
    // Who pays for the work before the buyer does: the order above, the supplier, the buyers' money, or the owner.
    const ownCost = !ordersSupply && !fromSupplier;
    const paysFirst = ownCost && !prepaid;
    const costLine = !ownCost
      ? ''
      : directSpan && direct
        ? ` Direct cost per deal about ${range(directSpan.low, directSpan.high, cur)} (${direct.status.toLowerCase()})${prepaid ? ', paid from the buyer\'s payment' : `, paid before the buyer pays${ctx.capitalBeforeProof !== null ? `, ${directSpan.high <= ctx.capitalBeforeProof ? 'inside' : 'OVER'} the ${money(ctx.capitalBeforeProof, cur)} allowed before proof` : ''}`}.`
        : ` Direct cost per deal is not yet established: ${establishedBy('COST', 'the first delivery measures it')}.`;
    const cost = paysFirst && directSpan ? directSpan.high : 0;
    next({
      label: 'Deliver and confirm',
      detail: `${facts.fulfiller === 'BRAIN' ? `Brain produces ${supplier ? `"${supplier}"` : 'the deliverable'} for each buyer and records delivery.` : `${supplier ? `"${supplier}"` : 'The supplier'} delivers to each buyer; Brain confirms delivery with each buyer and records it.`}${costLine}`,
      startDay: day,
      when: deliverWhen,
      cost,
      basis: paysFirst && !directSpan ? 'ASSUMPTION' : 'ESTIMATE',
      owner: cost > 0 ? 'PERSON' : 'BRAIN',
      ownerReason: cost > 0 ? `a payment of up to ${money(cost, cur)} per deal from the owner's account before the buyer pays, inside the goal's limits` : null,
      kill: 'a buyer reports non-delivery or a defect → hold collection for that buyer, refund under the stated terms, and re-plan the supply',
      execution: [],
      kind: 'EXECUTE',
      requires: paysFirst ? needs('COST') : [],
      withinLimits: paysFirst ? (directSpan && ctx.capitalBeforeProof !== null ? directSpan.high <= ctx.capitalBeforeProof : null) : null,
    });
  };

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
    const subscription = a.design.repeat === 'SUBSCRIPTION';
    // A next group follows one cycle of the model's days to usable cash; a renewal's period is not in the model.
    const day = subscription ? null : cashDay;
    next({
      label: subscription ? 'Renew' : 'Run the next group',
      detail: subscription ? `Renew the same "${buyers}" for the next period.` : `Offer the next run to a fresh group of "${buyers}".`,
      startDay: day,
      when: subscription
        ? `not yet scheduled: the renewal falls at the end of the subscription period, which the model does not hold; ${establishedBy('REPEAT', 'the first period')} establishes it`
        : cashDay
          ? `${dayText(cashDay)}: one cycle after the offer, the first group's days to usable cash`
          : `one cycle after the offer: ${pending}`,
      cost: 0,
      basis: basisOf('REPEAT'),
      owner: 'BRAIN',
      ownerReason: null,
      kill: 'fewer buyers return or join than the first run needed → stop repeating and re-plan',
      execution: [...ctx.send, ...ctx.collect],
      kind: 'EXECUTE',
      requires: needs('REPEAT'),
      withinLimits: day && ctx.daysLeft !== null ? day.high <= ctx.daysLeft : null,
    });
  }
  const notice = conflict
    ? `This arrangement contradicts its buyers' terms: it presells, but${arrears}, so nothing after the offer is scheduled until they are shown to pay in advance.`
    : late
      ? `This arrangement cannot settle inside the deadline: cash is usable on ${dayText(settleSpan!)} at the soonest (${cashStanding}), after the ${ctx.daysLeft} days left, so nothing after the offer is scheduled.`
      : null;
  const lead = [ctx.unestimated, notice].filter(Boolean).join(' ');
  if (lead && steps[0]) steps[0] = { ...steps[0], detail: `${lead} ${steps[0].detail}` };
  return steps;
}

type Day = { low: number; high: number };

/** A model field's numeric range, or null when the model holds no number for it. */
function spanOf(field: ModelField | null): Day | null {
  if (!field) return null;
  const high = typeof field.high === 'number' ? field.high : typeof field.value === 'number' ? field.value : null;
  if (high === null) return null;
  const low = typeof field.low === 'number' ? field.low : high;
  return { low, high };
}

const dayText = (d: Day) => (Math.round(d.low) === Math.round(d.high) ? `day ${Math.round(d.low)}` : `day ${Math.round(d.low)}–${Math.round(d.high)}`);

/**
 * Industry construction (§92): from an operator's ambition to the next
 * business position, with the reasoning a person can check.
 *
 *   intent  →  industry model  →  constructed businesses  →  economics
 *           →  multi-stage strategies  →  a decision  →  the first transaction
 *
 * Pure. `service.ts` loads the evidence from rows (the industry map, the
 * capital and constraint tables, the operation's own observed results) and
 * the goal's own terms; this module decides.
 *
 * What it owns and what it does not:
 *
 *   * It owns the comparison. Positions, assets and economics are this
 *     capability's; the arithmetic is the scenario grammar and the quant
 *     reconstruction engine, unchanged.
 *   * It owns no execution. The first transaction is handed to the existing
 *     cash journey as a structure and design from `cash/properties.ts` and a
 *     `CashMechanism`, and what may be contacted, signed or spent is still the
 *     commercial authority's and the goal's money limits'.
 *   * It owns no other goal. A construction reads one goal; another active
 *     money goal is listed and left exactly as it is.
 */
import { goalExecutionPolicy, SQUEEZE_QUALIFICATION, type GoalExecutionPolicy } from '../../../domain/goalPolicy.ts';
import { ASSET_LABELS, FACT_KEYS, type Asset, type Fact, type FactKey, type IndustryEvidence, type KnownStatus } from '../../../domain/construction.ts';
import type { CashMechanism } from '../../../domain/types.ts';
import { STRUCTURES, type Design, type Structure } from '../../cash/properties.ts';
import { constructBusinesses, type Business } from './businesses.ts';
import { solveEconomics, type BusinessEconomics } from './economics.ts';
import { interpretIntent, type IntentOverrides, type OperatorIntent } from './intent.ts';
import { buildIndustryModel, resolveFact, type IndustryModel } from './model.ts';
import {
  bestPerEntry,
  compareWithBest,
  criteriaFor,
  followsSequence,
  searchStrategies,
  STAGE_ACCOUNTS,
  type Comparison,
  type Stage,
  type Strategy,
} from './strategy.ts';

export interface ConstructionGoal {
  id: string;
  title: string;
  /** From the goal's target: a deadline and a remainder make it SQUEEZE. */
  daysLeft: number | null;
  remainingCents: number;
  /** The goal's own money ceiling, in dollars; it caps whatever the words said. */
  capitalCeiling: number | null;
  resources: string | null;
}

export interface ConstructionInput {
  intentText: string;
  overrides?: IntentOverrides;
  evidence: IndustryEvidence;
  goal?: ConstructionGoal | null;
  otherMoneyGoals?: { id: string; title: string; policy: GoalExecutionPolicy }[];
  now?: Date;
}

export interface EntryReading {
  key: string;
  label: string;
  segment: string;
  mechanisms: string[];
  payer: string;
  excluded: string | null;
  viability: BusinessEconomics['viability'] | 'EXCLUDED' | 'CANNOT_START';
  cannotStartBecause: string | null;
  economics: BusinessEconomics | null;
  /** What it earns and needs as it grows: the scaling requirement at each stage scale. */
  scaling: { accounts: number; contribution: number | null; worstUpfront: number | null; workers: number | null }[];
  answers: Business['answers'];
}

/** One kind of business — recruitment, brokerage, subcontracting, coordination, direct operation — and where it stands. */
export interface FamilyReading {
  family: string;
  name: string;
  bestEntry: string;
  reading: string;
  /** The stage of the recommended strategy this kind of business appears in, if any. */
  stage: number | null;
  verdict: string;
  /** The same kind of business sold to the other buyer segments. */
  otherSegments: string[];
}

export function familyOf(b: Business['position']): { key: string; name: string } {
  if (b.supply === 'SELF') return { key: 'SELF', name: 'doing the work yourself' };
  if (b.supply === 'RECRUIT') return { key: 'RECRUIT', name: 'worker / driver recruitment' };
  if (b.contract === 'INTRODUCE') return { key: 'INTRODUCE', name: 'brokerage' };
  if (b.contract === 'REPRESENT') return { key: 'REPRESENT', name: 'representing operators' };
  if (b.supply === 'NETWORK') return b.aggregation === 'POOLED' ? { key: 'COORDINATE', name: 'capacity coordination (pooled contracted capacity)' } : { key: 'SUBCONTRACT', name: 'subcontracting' };
  return b.assets === 'OWNED' ? { key: 'OWN', name: 'direct operation with owned equipment' } : { key: 'OPERATE', name: 'direct operation (employed staff, leased equipment)' };
}

export interface Challenge {
  assumption: string;
  verdict: 'HOLDS' | 'PARTLY' | 'FAILS';
  because: string;
}

export interface ResearchQuestion {
  /** The quantity it prices, or null for a structural question about the industry. */
  key: FactKey | null;
  dimension?: string;
  segment: string | null;
  question: string;
  status: KnownStatus;
  /** Whether the answer can change the recommended entry. */
  decisive: boolean;
  because: string;
  /** Settled by the first sale's own conversation rather than research first. */
  learnedBySelling: boolean;
  /** Whether it bears on the entry itself, rather than a later stage or the ambition. */
  blocksEntry: boolean;
}

export interface ExecutionHandoff {
  policy: GoalExecutionPolicy | null;
  mode: 'SELL_NOW' | 'RESEARCH_BESIDE_SELLING' | 'RESEARCH_FIRST';
  buyer: string;
  firstTransaction: string;
  offer: string;
  channel: string;
  priceFloor: string | null;
  /** The cash journey's own vocabulary, so the existing qualification and sales path takes it. */
  cashMechanism: CashMechanism | null;
  structure: Structure | null;
  design: Design | null;
  /** Externally binding steps, each still decided by the commercial authority and the goal's limits. */
  authorizations: string[];
  /**
   * The answers a SQUEEZE goal needs before it sells (`SQUEEZE_QUALIFICATION`),
   * read off the constructed business, so the existing qualification takes it
   * without asking again. Null where the construction does not know.
   */
  qualification: Record<(typeof SQUEEZE_QUALIFICATION)[number], string | null>;
  otherGoals: string;
  steps: string[];
}

export interface Construction {
  intent: OperatorIntent;
  model: IndustryModel;
  businessesConstructed: number;
  entries: EntryReading[];
  recommended: Strategy | null;
  alternatives: Comparison[];
  /** Every kind of business the positions produced, compared with the recommendation. */
  families: FamilyReading[];
  /** The operator's own preferred sequence, evaluated beside the best one. */
  preferredSequence: { strategy: Strategy | null; verdict: string } | null;
  decision: {
    verdict: 'RECOMMEND' | 'RECOMMEND_CONDITIONAL' | 'NO_DEFENSIBLE_STRUCTURE';
    headline: string;
    reasoning: string[];
    decisiveObstacle: string | null;
    nearestAlternative: string | null;
  };
  challenges: Challenge[];
  research: ResearchQuestion[];
  execution: ExecutionHandoff | null;
  learning: { observed: Fact[]; superseded: number; note: string };
}

function money(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'unknown';
  const sign = x < 0 ? '−' : '';
  return `${sign}$${Math.round(Math.abs(x)).toLocaleString('en-US')}`;
}

function days(x: number | null | undefined): string {
  return x === null || x === undefined || !Number.isFinite(x) ? 'unknown' : `${Math.round(x)} days`;
}

/** The cash journey's name for a position, so the existing sales path can take the first transaction. */
export function cashShapeOf(b: Business): { mechanism: CashMechanism | null; structure: Structure | null; design: Design | null } {
  const p = b.position;
  if (p.supply === 'RECRUIT' || p.contract === 'REPRESENT')
    return { mechanism: 'SUPPLY_DEMAND_MISMATCH', structure: 'REFERRAL', design: { base: 'REFERRAL', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'RECURRING_COHORT' } };
  if (p.contract === 'INTRODUCE') return { mechanism: 'SUPPLY_DEMAND_MISMATCH', structure: 'BROKER', design: { base: 'BROKER', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'SUBSCRIPTION' } };
  if (p.contract === 'PRIME' && p.supply === 'NETWORK')
    return p.aggregation === 'POOLED'
      ? { mechanism: 'JIGSAW_COMBINATION', structure: 'POOL', design: { base: 'POOL', funding: 'ON_DELIVERY', aggregation: 'POOLED_BUYERS', repeat: 'SUBSCRIPTION' } }
      : { mechanism: 'SUBCONTRACTED_FULFILMENT', structure: 'SUBCONTRACT', design: { base: 'SUBCONTRACT', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'SUBSCRIPTION' } };
  // An operation with its own staff and equipment has no arranger structure: it is run, not arranged.
  return { mechanism: null, structure: null, design: null };
}

function cannotStart(b: Business, held: ReadonlySet<Asset>): string | null {
  const granted = new Set(b.gates.flatMap((g) => g.grants));
  const missing = b.requires.filter((a) => !held.has(a) && !granted.has(a));
  const gateMissing = b.gates.flatMap((g) => g.requires ?? []).filter((a) => !held.has(a));
  const all = [...new Set([...missing, ...gateMissing])];
  return all.length ? `needs ${all.map((a) => ASSET_LABELS[a]).join(', ')} first` : null;
}

function entryReadings(businesses: Business[], evidence: IndustryEvidence, held: ReadonlySet<Asset>, now: Date): EntryReading[] {
  return businesses.map((b) => {
    const base = { key: b.key, label: b.label, segment: b.segmentName, mechanisms: b.mechanisms, payer: b.payer, excluded: b.excluded, answers: b.answers };
    if (b.excluded) return { ...base, viability: 'EXCLUDED', cannotStartBecause: null, economics: null, scaling: [] };
    const economics = solveEconomics(b, evidence, { accounts: 1, held, reconstructRanges: true, now });
    const blocked = cannotStart(b, held);
    const scaling = b.position.supply === 'RECRUIT'
      ? []
      : STAGE_ACCOUNTS.map((accounts) => {
          const e = accounts === 1 ? economics : solveEconomics(b, evidence, { accounts, held, thresholds: false });
          return { accounts, contribution: e.mid?.contribution ?? null, worstUpfront: e.worst?.upfront ?? null, workers: e.mid?.workers ?? null };
        });
    return { ...base, viability: blocked ? 'CANNOT_START' : economics.viability, cannotStartBecause: blocked, economics, scaling };
  });
}

function stageSentence(s: Stage, evidence: IndustryEvidence): string {
  const m = s.economics.mid;
  const scale = s.business.position.supply === 'RECRUIT' ? 'placing workers' : `${s.accounts} account${s.accounts === 1 ? '' : 's'}`;
  const fleet = m && m.capacityUnits > 0 && s.business.position.supply === 'EMPLOY' ? `, ${Math.round(m.capacityUnits)} ${evidence.capacityUnit}${Math.round(m.capacityUnits) === 1 ? '' : 's'}` : '';
  return `Stage ${s.index}: ${s.business.label} (${scale}${fleet}) — about ${money(m?.contribution)}/month (worst ${money(s.economics.worst?.contribution)}), ${money(s.economics.worst?.upfront)} committed at most`;
}

function challengesFor(intent: OperatorIntent, entries: EntryReading[], best: Strategy | null, all: Strategy[], evidence: IndustryEvidence): Challenge[] {
  const out: Challenge[] = [];
  const live = entries.filter((e) => e.economics && !e.excluded);
  if (intent.capital) {
    const operated = live.filter((e) => e.key.startsWith('PRIME/EMPLOY'));
    const affordable = operated.filter((e) => (e.economics?.worst?.upfront ?? Infinity) <= intent.capital!.high);
    if (operated.length) {
      const cheapest = operated.map((e) => e.economics?.mid?.upfront ?? Infinity).reduce((a, b) => Math.min(a, b), Infinity);
      out.push({
        assumption: `${money(intent.capital.low)}–${money(intent.capital.high)} is enough to run our own ${evidence.capacityUnit}s from day one`,
        verdict: affordable.length === operated.length ? 'HOLDS' : affordable.length ? 'PARTLY' : 'FAILS',
        because: affordable.length
          ? `${affordable.length} of ${operated.length} directly operated entries fit at worst case; the cheapest needs about ${money(cheapest)} before the first collected dollar`
          : `the cheapest directly operated entry needs about ${money(cheapest)} before the first collected dollar, beyond the ${money(intent.capital.high)} available at worst case`,
      });
    }
  }
  if (intent.firstCashWithinDays !== null) {
    const fastest = live.map((e) => e.economics?.mid?.firstCashDays ?? Infinity).reduce((a, b) => Math.min(a, b), Infinity);
    out.push({
      assumption: `revenue can start within about ${intent.firstCashWithinDays} days`,
      verdict: fastest <= intent.firstCashWithinDays ? 'HOLDS' : 'FAILS',
      because: Number.isFinite(fastest) ? `the fastest constructed entry collects its first dollar in about ${Math.round(fastest)} days` : 'no entry is priced well enough to say',
    });
  }
  if (intent.capitalAppetite === 'HEAVY' || intent.control.includes('ASSETS')) {
    const owning = all.find((s) => s.stages.some((st) => st.business.position.assets === 'OWNED'));
    out.push({
      assumption: 'owning the heavy assets is the valuable position',
      verdict: owning && best && owning.key === best.key ? 'HOLDS' : owning ? 'PARTLY' : 'FAILS',
      because: owning
        ? best && owning.key !== best.key
          ? `owned ${evidence.capacityUnit}s appear only late, once an operating record exists; the control that pays is ${evidence.chokepoints.map((c) => c.name).slice(0, 2).join(' and ') || 'held elsewhere'}`
          : 'the best strategy does end owning equipment'
        : `no strategy reaches owned ${evidence.capacityUnit}s inside the money and stages available`,
    });
  }
  if (intent.control.includes('CHOKEPOINTS') && best) {
    const held = new Set(best.stages.at(-1)!.holds);
    const reached = evidence.chokepoints.filter((c) => c.controlledBy.every((a) => held.has(a)));
    out.push({
      assumption: 'the valuable parts of this market can be controlled from this starting point',
      verdict: reached.length === evidence.chokepoints.length ? 'HOLDS' : reached.length ? 'PARTLY' : 'FAILS',
      because: reached.length
        ? `the recommended path ends controlling ${reached.map((c) => c.name).join('; ')}${reached.length < evidence.chokepoints.length ? `; not ${evidence.chokepoints.filter((c) => !reached.includes(c)).map((c) => c.name).join('; ')}` : ''}`
        : 'no reachable path ends holding a chokepoint',
    });
  }
  return out;
}

function researchFor(input: { best: Strategy | null; evidence: IndustryEvidence; intent: OperatorIntent; businesses: Business[]; policy: GoalExecutionPolicy | null }): ResearchQuestion[] {
  const { best, evidence, intent, businesses } = input;
  if (!best) return [];
  const entry = best.stages[0]!;
  const next = best.stages[1];
  const keys = new Map<string, { key: FactKey; segment: string | null; stage: Stage }>();
  for (const stage of [entry, next].filter(Boolean) as Stage[]) {
    for (const f of stage.economics.inputs) {
      if (f.status === 'OBSERVED' || f.status === 'VERIFIED') continue;
      const seg = FACT_KEYS[f.key].segment ? stage.business.segment.actorId : null;
      keys.set(`${f.key}@${seg}`, { key: f.key, segment: seg, stage });
    }
  }
  const out: ResearchQuestion[] = [];
  const entryKey = entry.business.key;
  for (const { key, segment, stage } of keys.values()) {
    const fact = resolveFact(evidence.facts, key, segment);
    const segName = segment ? evidence.actors.find((a) => a.id === segment)?.name ?? segment : null;
    const where = evidence.geography ? ` in ${evidence.geography}` : '';
    const question = `${FACT_KEYS[key].label}${segName ? ` — ${segName}` : ''}${where}`;
    const learnedBySelling = ['price_per_unit', 'account_win_rate', 'sales_cycle_days', 'buyer_payment_days', 'account_units_per_month', 'contractor_rate_per_unit', 'placement_fee'].includes(key);
    if (fact.status === 'UNKNOWN') {
      out.push({ key, segment, question, status: 'UNKNOWN', decisive: true, because: `stage ${stage.index} cannot be priced without it; its threshold is the decision`, learnedBySelling, blocksEntry: stage === entry });
      continue;
    }
    if (stage !== entry) {
      out.push({ key, segment, question, status: fact.status, decisive: false, because: `it prices stage ${stage.index}, which its advance trigger re-reads before anything is committed`, learnedBySelling, blocksEntry: false });
      continue;
    }
    // Value of information: does the recommended entry change across this input's range?
    let changes = false;
    for (const at of [fact.low, fact.high]) {
      const facts = evidence.facts.filter((f) => !(f.key === key && (f.segment ?? null) === fact.segment)).concat([{ key, segment: fact.segment, low: at, high: at, status: 'ASSUMPTION', source: { title: 'value-of-information probe', url: null, kind: 'OPERATOR' }, measures: 'probe' }]);
      const probe = searchStrategies(businesses, { ...evidence, facts }, intent, { lite: true })[0];
      if (!probe || probe.stages[0]!.business.key !== entryKey) changes = true;
      if (changes) break;
    }
    out.push({
      key,
      segment,
      question,
      status: fact.status,
      decisive: changes,
      because: changes
        ? `across its ${fact.status.toLowerCase()} range the best entry changes, so establishing it can change the decision`
        : `the recommended entry is the same across its whole ${fact.status.toLowerCase()} range: not worth researching before acting`,
      learnedBySelling,
      blocksEntry: true,
    });
  }
  // Control the ambition asks for that no priced path reaches: what would price the business that holds it.
  for (const asset of best.ambitionMissing) {
    for (const b of businesses) {
      if (b.excluded || !b.accumulates.includes(asset)) continue;
      for (const f of solveEconomics(b, evidence, { accounts: 1, thresholds: false }).inputs) {
        if (f.status !== 'UNKNOWN') continue;
        const seg = FACT_KEYS[f.key].segment ? b.segment.actorId : null;
        if (out.some((q) => q.key === f.key && q.segment === seg)) continue;
        out.push({
          key: f.key,
          segment: seg,
          question: `${FACT_KEYS[f.key].label} — ${b.segmentName}${evidence.geography ? ` in ${evidence.geography}` : ''}`,
          status: 'UNKNOWN',
          decisive: true,
          because: `${ASSET_LABELS[asset]} is held only by businesses nobody can price yet (${b.label}); this is what prices them`,
          learnedBySelling: false,
          blocksEntry: false,
        });
      }
    }
  }
  return out.sort((a, b) => Number(b.decisive) - Number(a.decisive) || Number(a.learnedBySelling) - Number(b.learnedBySelling));
}

function executionFor(best: Strategy | null, goal: ConstructionGoal | null | undefined, others: ConstructionInput['otherMoneyGoals'], research: ResearchQuestion[]): ExecutionHandoff | null {
  if (!best) return null;
  const entry = best.stages[0]!;
  const b = entry.business;
  const policy = goal ? goalExecutionPolicy({ daysLeft: goal.daysLeft, remainingCents: goal.remainingCents }) : null;
  const decisiveFirst = research.filter((r) => r.decisive && r.blocksEntry && !r.learnedBySelling);
  const mode: ExecutionHandoff['mode'] = policy === 'SQUEEZE' ? 'SELL_NOW' : decisiveFirst.length ? 'RESEARCH_FIRST' : 'RESEARCH_BESIDE_SELLING';
  const price = entry.economics.thresholds.find((t) => t.key === 'price_per_unit' || t.key === 'placement_fee');
  const priceFloor = price?.breakEven ? `never quote below ${money(price.breakEven)}${price.key === 'placement_fee' ? ' per placement' : ` per unit`} — the break-even at this scale` : null;
  const shape = cashShapeOf(b);
  const upfront = entry.economics.worst?.upfront ?? null;
  const steps = [
    `Pitch ${b.segmentName} through ${b.segment.channel}.`,
    `Sell ${b.answers.firstCollectedDollar}${priceFloor ? `; ${priceFloor}` : ''}.`,
    ...(b.position.supply === 'NETWORK' || b.position.contract === 'INTRODUCE' || b.position.contract === 'REPRESENT' ? ['Line up two independent operators who accept the rate before the first run, so a no-show does not lose the account.'] : []),
    ...b.gates.map((g) => `Put ${g.name} in place.`),
    `Record the quoted price, the rate supply accepted, and the payment terms as observed facts: they replace the estimates and re-run this decision.`,
  ];
  return {
    policy,
    mode,
    buyer: b.segmentName,
    firstTransaction: b.answers.firstCollectedDollar,
    offer: b.answers.whatWeProvide,
    channel: b.segment.channel,
    priceFloor,
    cashMechanism: shape.mechanism,
    structure: shape.structure,
    design: shape.design,
    authorizations: [
      `contacting ${b.segmentName} — the commercial authority's outreach permission`,
      'signing the first contract or rate sheet — a person’s approval',
      `spending up to ${money(upfront)} before the first collected dollar — inside the goal’s money limit, never above it`,
    ],
    qualification: {
      payer: b.answers.whoPaysAndWhy,
      offer: b.answers.whatWeProvide,
      access: b.segment.channel,
      delivery: b.answers.howFulfilmentHappens,
      fulfillment: b.position.supply === 'NETWORK' ? 'independent operators (subcontractors)' : b.position.supply === 'EMPLOY' ? 'employed staff under a hired operations manager' : b.position.supply === 'RECRUIT' ? 'the operator that employs the placed workers' : null,
      directCosts: entry.economics.mid ? `about ${money(entry.economics.mid.directCost)}/month paid to supply at ${entry.accounts} account(s)` : null,
      requiredCapital: entry.economics.worst ? `at most ${money(entry.economics.worst.upfront)} before the first collected dollar` : null,
      eligibility: b.gates.length ? b.gates.map((g) => g.name).join('; ') : 'no licence or program gate is recorded',
      disqualifiers: b.excluded ?? (b.segment.refuses ? b.segment.refuses.because : 'none recorded'),
    },
    otherGoals:
      others && others.length
        ? `${others.length} other active money goal(s) (${others.map((o) => o.title).join('; ')}) are unchanged: this construction reads its own goal and changes no other goal’s plan, priority or sales.`
        : 'No other active money goal is affected.',
    steps:
      mode === 'SELL_NOW'
        ? ['SQUEEZE goal: no market-testing phase — the first offer pursues an actual paid transaction now; research runs beside the sale.', ...steps]
        : mode === 'RESEARCH_FIRST'
          ? [`Establish first: ${decisiveFirst.map((r) => r.question).join('; ')}.`, ...steps]
          : steps,
  };
}

/** Construct the industry and decide. Pure. */
export function constructIndustry(input: ConstructionInput): Construction {
  const now = input.now ?? new Date();
  const text = [input.intentText, input.goal?.resources ? `I have ${input.goal.resources}.` : ''].filter(Boolean).join(' ');
  let intent = interpretIntent(text, input.overrides);
  if (input.goal?.capitalCeiling !== null && input.goal?.capitalCeiling !== undefined) {
    const ceiling = input.goal.capitalCeiling;
    const capital = intent.capital ? { low: Math.min(intent.capital.low, ceiling), high: Math.min(intent.capital.high, ceiling) } : { low: ceiling, high: ceiling };
    intent = {
      ...intent,
      capital,
      requirements: [...intent.requirements.filter((r) => r.id !== 'capital_ceiling'), { id: 'capital_ceiling', statement: `The goal’s own money limit caps this at ${money(ceiling)}.`, kind: 'HARD', from: 'OVERRIDE' }],
    };
  }
  const evidence = input.evidence;
  const model = buildIndustryModel(evidence);
  const businesses = constructBusinesses(evidence);
  const strategies = searchStrategies(businesses, evidence, intent);
  const criteria = criteriaFor(intent);
  const perEntry = bestPerEntry(strategies);
  // A recommendation needs an entry somebody can price; an unpriced one is a question, not a plan.
  const usable = perEntry.filter((s) => s.stages[0]!.economics.viability === 'VIABLE' || s.stages[0]!.economics.viability === 'CONDITIONAL');
  const best = usable[0] ?? null;

  const held = new Set<Asset>();
  const entries = entryReadings(businesses, evidence, held, now).sort((a, b) => {
    const order = ['VIABLE', 'CONDITIONAL', 'UNPRICED', 'NOT_VIABLE', 'CANNOT_START', 'EXCLUDED'];
    return order.indexOf(a.viability) - order.indexOf(b.viability) || (b.economics?.mid?.contribution ?? -Infinity) - (a.economics?.mid?.contribution ?? -Infinity);
  });

  const alternatives = best ? compareWithBest(best, usable.slice(1, 8), criteria) : [];
  let preferredSequence: Construction['preferredSequence'] = null;
  if (intent.sequence.length) {
    const match = strategies.find((s) => followsSequence(s, intent.sequence)) ?? null;
    preferredSequence = {
      strategy: match,
      verdict: !match
        ? `no feasible strategy follows ${intent.sequence.join(' → ').toLowerCase()} inside the constraints`
        : best && match.key === best.key
          ? 'the preferred sequence is the best strategy found'
          : `the preferred sequence works but ranks below the recommendation because ${compareWithBest(best!, [match], criteria)[0]!.lostOn}`,
    };
  }

  const families: FamilyReading[] = [];
  {
    const seen = new Set<string>();
    for (const e of entries) {
      const b = businesses.find((x) => x.key === e.key)!;
      const fam = familyOf(b.position);
      if (seen.has(fam.key)) continue;
      seen.add(fam.key);
      const stage = best?.feasible ? (best.stages.find((st) => familyOf(st.business.position).key === fam.key)?.index ?? null) : null;
      const entryStrategy = perEntry.find((st) => st.stages[0]!.business.key === e.key);
      const isEntry = best?.feasible && best.stages[0]!.business.key === e.key;
      const lost = !isEntry && entryStrategy && best ? compareWithBest(best, [entryStrategy], criteria)[0] : null;
      const m = e.economics?.mid;
      const reading = e.excluded
        ? 'excluded'
        : e.cannotStartBecause
          ? `cannot start at entry: ${e.cannotStartBecause}`
          : e.viability === 'UNPRICED'
            ? `unpriced: ${e.economics?.unpriced.map((k) => FACT_KEYS[k].label.toLowerCase()).join(', ')}`
            : `${e.viability.toLowerCase()}: about ${money(m?.contribution)}/month at one account, ${money(e.economics?.worst?.upfront)} committed at most, first cash ${days(m?.firstCashDays)}`;
      const verdictText = isEntry
        ? 'the recommended entry'
        : e.excluded
          ? e.excluded
          : stage
            ? `not the entry, but stage ${stage} of the recommendation${lost ? ` — as an entry ${lost.lostOn}` : ''}`
            : lost
              ? `not chosen: ${lost.lostOn}${lost.detail ? ` (${lost.detail})` : ''}`
              : e.cannotStartBecause ?? 'not reachable inside the constraints';
      const otherSegments = entries
        .filter((o) => o.key !== e.key && o.segment !== e.segment && familyOf(businesses.find((x) => x.key === o.key)!.position).key === fam.key)
        .filter((o, i, all) => all.findIndex((x) => x.segment === o.segment) === i)
        .map((o) => `${o.segment}: ${o.excluded ? 'excluded' : o.cannotStartBecause ? `cannot start (${o.cannotStartBecause})` : o.viability === 'UNPRICED' ? 'unpriced' : `${o.viability.toLowerCase()}, about ${money(o.economics?.mid?.contribution)}/month (best case ${money(o.economics?.best?.contribution)})`}`);
      families.push({ family: fam.key, name: fam.name, bestEntry: e.label, reading, stage, verdict: verdictText, otherSegments });
    }
  }

  const reasoning: string[] = [];
  let verdict: Construction['decision']['verdict'] = 'NO_DEFENSIBLE_STRUCTURE';
  let headline: string;
  let decisiveObstacle: string | null = null;
  let nearestAlternative: string | null = null;
  if (best && best.feasible) {
    const entry = best.stages[0]!;
    verdict = entry.economics.viability === 'VIABLE' ? 'RECOMMEND' : 'RECOMMEND_CONDITIONAL';
    headline = `Enter as: ${entry.business.label}. First transaction: ${entry.business.answers.firstCollectedDollar}.`;
    for (const s of best.stages) reasoning.push(stageSentence(s, evidence));
    reasoning.push(`First collected cash in about ${days(best.firstCashDays)}; at most ${money(best.entryExposure)} at risk at entry.`);
    if (best.control.length) {
      const held = best.control.filter((c) => c.held);
      const missing = best.control.filter((c) => !c.held);
      reasoning.push(`Ends controlling ${held.map((c) => c.name).join('; ') || 'none of what the ambition asks for'}${missing.length ? `; not yet ${missing.map((c) => `${c.name} (needs ${c.needs.filter((a) => !best.stages.at(-1)!.holds.includes(a)).map((a) => ASSET_LABELS[a]).join(', ')})`).join('; ')}` : ''}.`);
    }
    for (const a of alternatives.slice(0, 4)) reasoning.push(`Not ${a.entry}: ${a.lostOn}${a.detail ? ` (${a.detail})` : ''}.`);
    // An entry nobody can price is not a loser; it is a question, and its threshold says what answer would change the decision.
    const seenSegments = new Set<string>();
    for (const e of entries.filter((x) => x.viability === 'UNPRICED')) {
      if (seenSegments.has(e.segment)) continue;
      seenSegments.add(e.segment);
      const t = e.economics?.thresholds.find((x) => x.status === 'UNKNOWN' && x.breakEven !== null);
      reasoning.push(`Not yet ${e.label}: ${e.economics?.unpriced.map((k) => FACT_KEYS[k].label.toLowerCase()).join(', ')} is not published${t?.condition ? `; it breaks even only if ${t.condition}` : ''}.`);
    }
    if (verdict === 'RECOMMEND_CONDITIONAL') {
      const open = entry.economics.thresholds.filter((t) => t.reading !== 'CLEARS');
      reasoning.push(
        open.length
          ? `The entry is viable only if: ${open.map((t) => t.sentence).join(' ')}`
          : `Every input alone clears its break-even, but with all of them at the bad end of their ranges at once it loses ${money(-(entry.economics.worst?.contribution ?? 0))}/month — the first quotes settle which end is real.`,
      );
    }
  } else {
    const reasons = perEntry.map((s) => s.infeasibleBecause ?? `${s.stages[0]!.business.label} reads ${s.stages[0]!.economics.viability.toLowerCase()}`);
    const unpricedEntry = entries.find((e) => e.viability === 'UNPRICED');
    decisiveObstacle =
      best?.infeasibleBecause ??
      (entries.length === 0
        ? `no buyer of ${evidence.industry} is established, so no business can be constructed`
        : entries.every((e) => e.viability === 'EXCLUDED')
          ? 'every constructed business needs the operator’s own physical work'
          : unpricedEntry && !perEntry.some((x) => x.stages[0]!.economics.viability !== 'UNPRICED')
            ? `every business that could start is unpriced: ${[...new Set(entries.flatMap((e) => (e.viability === 'UNPRICED' ? (e.economics?.unpriced ?? []) : [])))].map((k) => FACT_KEYS[k].label.toLowerCase()).join('; ')} not established`
            : (reasons[0] ?? 'no constructed business can be priced or started from what is held'));
    const nearest = [...perEntry].filter((x) => x.stages[0]!.economics.worst).sort((a, b) => (a.stages[0]!.economics.worst?.upfront ?? Infinity) - (b.stages[0]!.economics.worst?.upfront ?? Infinity))[0];
    nearestAlternative = nearest
      ? `${nearest.stages[0]!.business.label}: needs ${money(nearest.stages[0]!.economics.worst?.upfront)} at worst case${intent.capital ? ` against ${money(intent.capital.high)}` : ''}`
      : entries.find((e) => e.viability === 'UNPRICED')
        ? `research the unpriced inputs of ${entries.find((e) => e.viability === 'UNPRICED')!.label}`
        : null;
    headline = `No defensible structure under these constraints: ${decisiveObstacle}.`;
    if (nearestAlternative) reasoning.push(`Nearest better alternative: ${nearestAlternative}.`);
  }

  const goal = input.goal ?? null;
  const policy = goal ? goalExecutionPolicy({ daysLeft: goal.daysLeft, remainingCents: goal.remainingCents }) : null;
  const research = researchFor({ best: best && best.feasible ? best : null, evidence, intent, businesses, policy });
  // Without a recommendation, what is missing about the industry itself is the question.
  if (!best || !best.feasible) {
    for (const d of model.coverage.filter((x) => x.reading !== 'EVIDENCED')) {
      research.push({
        key: null,
        dimension: d.dimension,
        segment: null,
        question: `${d.dimension.toLowerCase().replace(/_/g, ' ')} of ${evidence.industry}${evidence.geography ? ` in ${evidence.geography}` : ''}`,
        status: 'UNKNOWN',
        decisive: ['PARTICIPANTS', 'DEMAND_AND_SUPPLY', 'PRICING', 'LABOR_AND_FULFILMENT', 'REGULATORY_GATES'].includes(d.dimension),
        because: d.reading === 'UNKNOWN' ? 'nothing establishes it, and no business can be constructed or priced without it' : 'only partly established',
        learnedBySelling: false,
        blocksEntry: true,
      });
    }
  }
  const execution = best && best.feasible ? executionFor(best, goal, input.otherMoneyGoals, research) : null;
  const observed = evidence.facts.filter((f) => f.status === 'OBSERVED');
  const superseded = observed.length ? evidence.facts.filter((f) => f.status !== 'OBSERVED' && observed.some((o) => o.key === f.key && (o.segment ?? null) === (f.segment ?? null))).length : 0;
  return {
    intent,
    model,
    businessesConstructed: businesses.length,
    entries,
    recommended: best && best.feasible ? best : null,
    alternatives,
    families,
    preferredSequence,
    decision: { verdict, headline, reasoning, decisiveObstacle, nearestAlternative },
    challenges: challengesFor(intent, entries, best && best.feasible ? best : null, strategies, evidence),
    research,
    execution,
    learning: {
      observed,
      superseded,
      note: observed.length
        ? `${observed.length} observed result(s) from this operation answer ahead of published figures; ${superseded} weaker figure(s) are kept as history.`
        : 'No observed result yet: every figure is published or assumed. The first quotes and rates recorded here replace them.',
    },
  };
}

/** A terminal rendering, every number traceable to the structure above. */
export function renderConstruction(c: Construction): string {
  const lines: string[] = [];
  const i = c.intent;
  lines.push(`INTENT  ${i.industry ?? 'industry unstated'}${i.geography ? ` · ${i.geography}` : ''} · capital ${i.capital ? `${money(i.capital.low)}–${money(i.capital.high)}` : 'unstated'} · urgency ${i.urgency ?? 'unstated'} · control ${i.control.join(', ') || 'unstated'}`);
  for (const r of i.requirements) lines.push(`  ${r.kind.padEnd(10)} ${r.statement}`);
  for (const k of i.conflicts) lines.push(`  CONFLICT   ${k.between.join(' vs ')}: ${k.why} → reconcile by ${k.reconcile.toLowerCase()}`);
  lines.push(`MODEL   ${c.model.evidence.industry} (${c.model.evidence.provenance.join('; ')})`);
  for (const d of c.model.coverage) lines.push(`  ${d.reading.padEnd(9)} ${d.dimension.padEnd(24)} ${d.note}`);
  for (const v of c.model.valueChain) for (const l of v.lines) lines.push(`  ${v.kind.padEnd(9)} ${l}`);
  lines.push(`  facts: ${Object.entries(c.model.factStatus).map(([k, n]) => `${k.toLowerCase()} ${n}`).join(', ')}`);
  lines.push(`BUSINESSES  ${c.businessesConstructed} constructed from positions × buyer segments`);
  for (const e of c.entries.slice(0, 14)) {
    const m = e.economics;
    lines.push(`  ${e.viability.padEnd(12)} ${e.label}${e.excluded ? ` — ${e.excluded}` : e.cannotStartBecause ? ` — ${e.cannotStartBecause}` : m?.mid ? ` — ${money(m.mid.contribution)}/mo at 1 account (worst ${money(m.worst?.contribution)}, best ${money(m.best?.contribution)}); upfront ${money(m.mid.upfront)}; first cash ${days(m.mid.firstCashDays)}` : m?.unpriced.length ? ` — unpriced: ${m.unpriced.join(', ')}` : ''}`);
    if (m?.mid && c.entries.indexOf(e) < 6) {
      const x = m.mid;
      lines.push(`      billings ${money(x.billings)} · direct cost ${money(x.directCost)} · gross ${money(x.revenue)} · indirect ${money(x.indirectCost)} · operating ${money(x.contribution)} /month`);
      lines.push(`      win an account ${money(x.acquisitionPerAccount)} (payback ${x.acquisitionPaybackMonths === null ? 'never' : `${x.acquisitionPaybackMonths.toFixed(1)} months`}) · ${x.workers} performing the work · working capital ${money(x.workingCapital)} · break-even ${m.breakEvenAccounts === null ? 'n/a' : `${m.breakEvenAccounts.toFixed(1)} accounts`} · exposure ${money(m.worst?.exposure)} · first revenue ${days(x.firstRevenueDays)}`);
      if (m.sensitivity.length) lines.push(`      most sensitive to: ${m.sensitivity.slice(0, 3).map((q) => `${q.key} (±${money(q.swing / 2)})`).join(', ')}`);
      if (e.scaling.length) lines.push(`      scaling: ${e.scaling.map((q) => `${q.accounts} acct → ${money(q.contribution)}/mo, ${money(q.worstUpfront)} upfront, ${q.workers ?? '?'} working`).join(' | ')}`);
      if (m.reconstructed.contribution) lines.push(`      reconstructed (quant engine): p10 ${money(m.reconstructed.contribution.p10)} p50 ${money(m.reconstructed.contribution.p50)} p90 ${money(m.reconstructed.contribution.p90)} [${m.reconstructed.contribution.tier.toLowerCase()}${m.reconstructed.contribution.distributionJustified ? '' : ', bounds only — not a probability'}]`);
    }
    for (const t of (m?.thresholds ?? []).filter((t) => t.reading !== 'CLEARS').slice(0, 3)) lines.push(`      threshold: ${t.sentence}`);
  }
  lines.push('COMPARED');
  for (const f of c.families) {
    lines.push(`  ${f.name} [${f.bestEntry}]: ${f.reading} → ${f.verdict}`);
    for (const o of f.otherSegments) lines.push(`      also ${o}`);
  }
  lines.push(`DECISION  ${c.decision.verdict}: ${c.decision.headline}`);
  for (const r of c.decision.reasoning) lines.push(`  ${r}`);
  if (c.recommended) {
    for (const s of c.recommended.stages) {
      lines.push(`  stage ${s.index} accumulates: ${s.accumulated.map((a) => ASSET_LABELS[a]).join(', ') || 'scale'}${s.alsoRunning.length ? ` · still running: ${s.alsoRunning.join('; ')}` : ''}`);
      for (const a of s.advanceWhen) lines.push(`    advance when: ${a}`);
      for (const a of s.changeIf.slice(0, 3)) lines.push(`    change if: ${a}`);
    }
  }
  if (c.preferredSequence) lines.push(`PREFERRED SEQUENCE  ${c.preferredSequence.verdict}`);
  for (const ch of c.challenges) lines.push(`CHALLENGE ${ch.verdict.padEnd(6)} "${ch.assumption}" — ${ch.because}`);
  for (const q of c.research) lines.push(`RESEARCH ${q.decisive ? 'DECISIVE' : 'skip    '} ${q.question} [${q.status.toLowerCase()}] — ${q.because}${q.learnedBySelling ? ' (the first sale answers it)' : ''}`);
  if (c.execution) {
    lines.push(`EXECUTION  ${c.execution.mode} · policy ${c.execution.policy ?? 'no goal target'} · cash mechanism ${c.execution.cashMechanism ?? 'operated (no arranger structure)'}`);
    for (const s of c.execution.steps) lines.push(`  - ${s}`);
    for (const a of c.execution.authorizations) lines.push(`  authorization: ${a}`);
    for (const [k, v] of Object.entries(c.execution.qualification)) lines.push(`  qualifies ${k}: ${v ?? 'unknown'}`);
    lines.push(`  ${c.execution.otherGoals}`);
  }
  lines.push(`LEARNING  ${c.learning.note}`);
  return lines.join('\n');
}

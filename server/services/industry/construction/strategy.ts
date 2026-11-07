/**
 * Multi-stage strategies and the decision between them (§92).
 *
 * A strategy is a walk over assets: each stage operates a business whose
 * requirements are met by what the operator holds and what earlier stages
 * accumulated, funded by the operator's capital and what earlier stages
 * earned. An earlier business keeps running beside a later one when it sells
 * to a different buyer — the quick-cash engine operated separately from the
 * long-term company — and is replaced when the later one takes over the same
 * buyer.
 *
 * Strategies are compared lexicographically, never by a weighted score (§38,
 * `domain/goals.ts`): feasible under the hard constraints, then the entry's
 * viability, then how much of the ambition's control the last stage holds,
 * then whether the first collected dollar arrives inside the operator's
 * window, then downside exposure, then the long-run contribution. The first
 * criterion two strategies differ on is the whole reason one is above the
 * other, and the comparison says which one it was.
 *
 * Vertical integration and capital spending are never assumed superior: an
 * owned fleet ranks above a leased one only when the ambition asks for owned
 * assets and the money reaches it, and the operator's own preferred sequence
 * is evaluated beside the best one and challenged when it is worse.
 */
import { ASSET_LABELS, CONTROL_ASSETS, type Asset, type IndustryEvidence } from '../../../domain/construction.ts';
import type { Business } from './businesses.ts';
import { solveEconomics, type BusinessEconomics } from './economics.ts';
import type { OperatorIntent, SequenceStep } from './intent.ts';

/** The planning scale of each stage: accounts held. A ladder, not a forecast. */
export const STAGE_ACCOUNTS = [1, 3, 8, 20] as const;
/** Months a stage runs before its advance trigger is read, for the capital it earns. A stated convention. */
export const STAGE_MONTHS = 6;
const BEAM = 40;

export interface Stage {
  index: number;
  business: Business;
  accounts: number;
  economics: BusinessEconomics;
  /** Businesses from earlier stages still operating beside this one. */
  alsoRunning: string[];
  /** Assets held once this stage has operated. */
  holds: Asset[];
  /** Assets this stage added. */
  accumulated: Asset[];
  /** Operator money available at the start of the stage, worst case. */
  capitalAvailable: number;
  advanceWhen: string[];
  changeIf: string[];
}

export interface Strategy {
  key: string;
  stages: Stage[];
  feasible: boolean;
  infeasibleBecause: string | null;
  ambitionHeld: Asset[];
  ambitionMissing: Asset[];
  /** Each piece of control the ambition asks for, and whether the last stage holds it. */
  control: { name: string; held: boolean; needs: Asset[] }[];
  firstCashDays: number | null;
  entryExposure: number | null;
  finalContribution: number | null;
  ranks: Record<string, number>;
}

export interface Comparison {
  strategy: string;
  entry: string;
  lostOn: string;
  detail: string;
}

/**
 * The pieces of control the ambition asks for. A chokepoint is held only when
 * every asset it takes is held — a fleet without the program that allocates
 * routes controls nothing — and a named kind of control when any asset that
 * makes it real is held.
 */
export function controlPieces(intent: OperatorIntent, evidence: IndustryEvidence): { name: string; needs: Asset[]; all: boolean }[] {
  const out: { name: string; needs: Asset[]; all: boolean }[] = [];
  for (const c of intent.control) {
    if (c === 'CHOKEPOINTS') for (const cp of evidence.chokepoints) out.push({ name: cp.name, needs: cp.controlledBy, all: true });
    else out.push({ name: `control of ${c.toLowerCase()}`, needs: CONTROL_ASSETS[c], all: false });
  }
  if (out.length === 0 && (intent.durable || intent.scale === 'LARGE')) {
    out.push({ name: 'customer contracts', needs: ['CUSTOMER_CONTRACTS'], all: true }, { name: 'an operating capability', needs: ['OPERATING_CAPABILITY'], all: true });
  }
  return out;
}

/** Assets the ambition asks for: the named control, the chokepoints, or a durable company's core. */
export function ambitionAssets(intent: OperatorIntent, evidence: IndustryEvidence): Asset[] {
  const out = new Set<Asset>();
  for (const c of intent.control) for (const a of CONTROL_ASSETS[c]) out.add(a);
  if (intent.control.includes('CHOKEPOINTS')) for (const cp of evidence.chokepoints) for (const a of cp.controlledBy) out.add(a);
  if (out.size === 0 && (intent.durable || intent.scale === 'LARGE')) {
    out.add('CUSTOMER_CONTRACTS');
    out.add('OPERATING_CAPABILITY');
  }
  return [...out];
}

/** What the operator says they hold, as assets. */
export function heldFromIntent(intent: OperatorIntent): Asset[] {
  const out = new Set<Asset>();
  for (const a of intent.assets) {
    if (/\b(van|truck|vehicle|fleet|trailer|equipment|machine)s?\b/i.test(a)) out.add('FLEET');
    if (/\binsurance\b/i.test(a)) out.add('INSURANCE_COVER');
    if (/\b(licen[cs]e|authority|permit)\b/i.test(a)) out.add('OPERATING_AUTHORITY');
    if (/\b(customers?|clients?|accounts?|relationships?|contacts?)\b/i.test(a)) out.add('BUYER_RELATIONSHIPS');
    if (/\b(drivers?|crews?|staff|team|workers?)\b/i.test(a)) out.add('SUPPLY_NETWORK');
  }
  return [...out];
}

function gateRequires(b: Business): Asset[] {
  return b.gates.flatMap((g) => g.requires ?? []);
}

function canStart(b: Business, held: ReadonlySet<Asset>): boolean {
  if (b.excluded) return false;
  const granted = new Set(b.gates.flatMap((g) => g.grants));
  // A gate the stage passes itself can satisfy a buyer's demand (the insurance the buyer requires).
  return [...b.requires].every((a) => held.has(a) || granted.has(a)) && gateRequires(b).every((a) => held.has(a));
}

function matchesStep(b: Business, step: SequenceStep): boolean {
  const p = b.position;
  switch (step) {
    case 'BROKER':
      return p.contract === 'INTRODUCE' || p.contract === 'REPRESENT';
    case 'RECRUIT':
      return p.supply === 'RECRUIT';
    case 'SUBCONTRACT':
      return p.contract === 'PRIME' && p.supply === 'NETWORK' && p.aggregation === 'SINGLE';
    case 'COORDINATE':
      return p.contract === 'PRIME' && p.supply === 'NETWORK';
    case 'FULFILMENT':
      return p.supply === 'EMPLOY';
    case 'ASSETS':
      return p.assets === 'OWNED';
  }
}

const VIABILITY_RANK: Record<BusinessEconomics['viability'], number> = { VIABLE: 0, CONDITIONAL: 1, UNPRICED: 3, NOT_VIABLE: 4 };

/** Conditional at the middle of its ranges ranks above conditional only at their favourable end. */
export function viabilityRank(e: BusinessEconomics): number {
  if (e.viability === 'CONDITIONAL' && (e.mid?.contribution ?? 0) <= 0) return 2;
  return VIABILITY_RANK[e.viability];
}

function money(x: number): string {
  return `$${Math.round(x).toLocaleString('en-US')}`;
}

interface Partial {
  stages: Stage[];
  held: Set<Asset>;
  /** Worst-case operator money left after upfronts, plus what stages earned at their middle. */
  pool: number;
  feasible: boolean;
  because: string | null;
}

function triggers(stage: Stage, next: Business | null, nextAccounts: number, evidence: IndustryEvidence): { advance: string[]; change: string[] } {
  const e = stage.economics;
  const advance: string[] = [];
  const change: string[] = [];
  advance.push(
    stage.business.position.supply === 'RECRUIT'
      ? `${stage.accounts} operator account(s) paying placement fees on collected invoices`
      : `${stage.accounts} account(s) of ${stage.business.segmentName} paying on collected invoices, at or above ${e.breakEvenAccounts !== null ? `break-even (${e.breakEvenAccounts.toFixed(1)} accounts)` : 'break-even'}`,
  );
  if (next) {
    const needs = next.requires.filter((a) => !stage.holds.includes(a));
    for (const a of needs) advance.push(`${ASSET_LABELS[a]} established`);
    if (next.requires.includes('DELIVERY_RECORD') || next.segment.requires.includes('DELIVERY_RECORD')) advance.push('a performance record buyers can check: at least three months of on-time, claim-free work');
    advance.push(`collected contribution covering the next stage’s upfront money`);
    if (nextAccounts > stage.accounts) advance.push(`demand for ${nextAccounts} accounts confirmed by signed or quoted work`);
  }
  for (const t of e.thresholds) {
    if ((t.reading === 'STRADDLES' || t.reading === 'UNKNOWN_RANGE') && t.condition) change.push(`the observed figure breaks ${t.condition} — re-plan from the next best entry`);
  }
  for (const f of evidence.failures) {
    const a = f.applies;
    const p = stage.business.position;
    if ((a.contract && !a.contract.includes(p.contract)) || (a.supply && !a.supply.includes(p.supply)) || (a.assets && !a.assets.includes(p.assets))) continue;
    change.push(f.statement.replace(/\.$/, ''));
  }
  return { advance, change };
}

function extend(part: Partial, b: Business, accounts: number, evidence: IndustryEvidence, cache: Map<string, BusinessEconomics>, lite: boolean): Partial | null {
  if (!canStart(b, part.held)) return null;
  const heldKey = [...part.held].sort().join(',');
  const cacheKey = `${b.key}|${accounts}|${heldKey}`;
  let econ = cache.get(cacheKey);
  if (!econ) {
    econ = solveEconomics(b, evidence, { accounts, held: part.held, thresholds: !lite });
    cache.set(cacheKey, econ);
  }
  if (econ.viability === 'NOT_VIABLE') return null;
  const prior = part.stages.at(-1);
  // Growing the same business pays only for the increment; what it already bought is held.
  const grownFrom = prior && prior.business.key === b.key ? (prior.economics.worst?.upfront ?? 0) : 0;
  const upfrontWorst = econ.worst ? Math.max(0, econ.worst.upfront - grownFrom) : null;
  let feasible = part.feasible;
  let because = part.because;
  if (upfrontWorst !== null && upfrontWorst > part.pool && feasible) {
    feasible = false;
    because = `stage ${part.stages.length + 1} (${b.label}) needs up to ${money(upfrontWorst)} before its first collected dollar and at most ${money(Math.max(0, part.pool))} is available`;
  }
  const alsoRunning = part.stages
    .filter((s) => s.business.segment.actorId !== b.segment.actorId)
    .map((s) => s.business.label)
    .filter((l, i, all) => all.indexOf(l) === i);
  const holds = new Set(part.held);
  const accumulated: Asset[] = [];
  for (const a of b.accumulates) if (!holds.has(a)) { holds.add(a); accumulated.push(a); }
  const stage: Stage = {
    index: part.stages.length + 1,
    business: b,
    accounts,
    economics: econ,
    alsoRunning,
    holds: [...holds],
    accumulated,
    capitalAvailable: part.pool,
    advanceWhen: [],
    changeIf: [],
  };
  const earned = econ.mid ? Math.max(0, econ.mid.contribution) * STAGE_MONTHS : 0;
  const parallel = part.stages.filter((s) => s.business.segment.actorId !== b.segment.actorId && s !== prior);
  const parallelEarned = parallel.reduce((sum, s) => sum + Math.max(0, s.economics.mid?.contribution ?? 0) * STAGE_MONTHS, 0);
  return {
    stages: [...part.stages, stage],
    held: holds,
    pool: part.pool - (upfrontWorst ?? 0) + earned + parallelEarned,
    feasible,
    because,
  };
}

function finish(part: Partial, intent: OperatorIntent, evidence: IndustryEvidence, ambition: Asset[]): Strategy {
  const stages = part.stages;
  for (let i = 0; i < stages.length; i++) {
    const next = stages[i + 1] ?? null;
    const t = triggers(stages[i]!, next?.business ?? null, next?.accounts ?? 0, evidence);
    stages[i]!.advanceWhen = t.advance;
    stages[i]!.changeIf = t.change;
  }
  const entry = stages[0]!;
  const last = stages.at(-1)!;
  const held = new Set(last.holds);
  const ambitionHeld = ambition.filter((a) => held.has(a));
  const control = controlPieces(intent, evidence).map((p) => ({ name: p.name, needs: p.needs, held: p.needs.length > 0 && (p.all ? p.needs.every((a) => held.has(a)) : p.needs.some((a) => held.has(a))) }));
  const firstCash = entry.economics.mid?.firstCashDays ?? null;
  const exposure = entry.economics.worst?.exposure ?? null;
  // The company at the end is everything still running: the last stage and every parallel engine beside it.
  const running = [last, ...stages.filter((s) => last.alsoRunning.includes(s.business.label) && s !== last)];
  const seen = new Set<string>();
  let finalContribution: number | null = 0;
  for (const s of running) {
    if (seen.has(s.business.label)) continue;
    seen.add(s.business.label);
    const c = s.economics.mid?.contribution;
    finalContribution = c === undefined || finalContribution === null ? null : finalContribution + c;
  }
  const window = intent.firstCashWithinDays;
  const ranks: Record<string, number> = {
    feasible: part.feasible ? 0 : 1,
    entryViability: viabilityRank(entry.economics),
    // A stage nobody can price is an option, not a plan: a path through one ranks after every priced path.
    unpricedStages: stages.filter((s) => s.economics.viability === 'UNPRICED').length,
    ambition: -control.filter((c) => c.held).length,
    firstCash: firstCash === null ? 2 : window !== null && firstCash > window ? 1 : 0,
    firstCashDays: firstCash === null ? 9999 : Math.round(firstCash / 15),
    exposure: exposure === null ? 1e12 : Math.round(exposure / 2500),
    finalContribution: finalContribution === null ? 0 : -Math.round(finalContribution / 1000),
    stages: stages.length,
  };
  return {
    key: stages.map((s) => `${s.business.key}x${s.accounts}`).join(' > '),
    stages,
    feasible: part.feasible,
    infeasibleBecause: part.because,
    ambitionHeld,
    ambitionMissing: ambition.filter((a) => !held.has(a)),
    control,
    firstCashDays: firstCash,
    entryExposure: exposure,
    finalContribution,
    ranks,
  };
}

/** The order criteria are compared in, which the operator's risk tolerance can change. */
export function criteriaFor(intent: OperatorIntent): string[] {
  const base = ['feasible', 'entryViability', 'unpricedStages', 'ambition', 'firstCash', 'firstCashDays', 'exposure', 'finalContribution', 'stages'];
  if (intent.riskTolerance === 'HIGH') return ['feasible', 'entryViability', 'unpricedStages', 'ambition', 'firstCash', 'finalContribution', 'firstCashDays', 'exposure', 'stages'];
  if (intent.riskTolerance === 'LOW') return ['feasible', 'entryViability', 'unpricedStages', 'exposure', 'ambition', 'firstCash', 'firstCashDays', 'finalContribution', 'stages'];
  if (!intent.urgency) return ['feasible', 'entryViability', 'unpricedStages', 'ambition', 'finalContribution', 'exposure', 'firstCash', 'firstCashDays', 'stages'];
  return base;
}

export function compareStrategies(a: Strategy, b: Strategy, criteria: string[]): { order: number; criterion: string } {
  for (const c of criteria) {
    const d = (a.ranks[c] ?? 0) - (b.ranks[c] ?? 0);
    if (d !== 0) return { order: d, criterion: c };
  }
  return { order: a.key.localeCompare(b.key), criterion: 'TIE' };
}

export const CRITERION_SENTENCE: Record<string, string> = {
  feasible: 'it does not fit the money available',
  entryViability: 'its entry business is less certain to earn more than it costs',
  unpricedStages: 'it passes through a stage nobody can price yet',
  ambition: 'it ends holding less of the control the ambition asks for',
  firstCash: 'its first collected dollar arrives outside the operator’s window',
  firstCashDays: 'its first collected dollar arrives later',
  exposure: 'it puts more of the operator’s money at risk before buyers pay',
  finalContribution: 'it earns less once built',
  stages: 'it needs more stages to get there',
  TIE: 'it is equivalent on every criterion',
};

/** Search strategies up to four stages deep. Pure. */
export function searchStrategies(businesses: Business[], evidence: IndustryEvidence, intent: OperatorIntent, options: { lite?: boolean } = {}): Strategy[] {
  const ambition = ambitionAssets(intent, evidence);
  const criteria = criteriaFor(intent);
  const cache = new Map<string, BusinessEconomics>();
  const start: Partial = { stages: [], held: new Set(heldFromIntent(intent)), pool: intent.capital?.high ?? Number.POSITIVE_INFINITY, feasible: true, because: null };
  const reachable = businesses.filter((b) => !b.excluded);
  const finished: Strategy[] = [];
  let frontier: Partial[] = [start];
  for (let depth = 0; depth < STAGE_ACCOUNTS.length; depth++) {
    const next: Partial[] = [];
    for (const part of frontier) {
      const usedLabels = new Set(part.stages.map((s) => s.business.key));
      for (const b of reachable) {
        // A stage either moves to a new business or grows the same one to the next scale.
        const prior = part.stages.at(-1);
        if (usedLabels.has(b.key) && prior?.business.key !== b.key) continue;
        const accounts = STAGE_ACCOUNTS[depth]!;
        const grown = extend(part, b, accounts, evidence, cache, options.lite === true);
        if (grown) next.push(grown);
      }
    }
    if (next.length === 0) break;
    const scored = next.map((p) => ({ p, s: finish({ ...p, stages: p.stages.map((s) => ({ ...s })) }, intent, evidence, ambition) }));
    scored.sort((x, y) => compareStrategies(x.s, y.s, criteria).order);
    for (const one of scored) finished.push(one.s);
    // Keep the beam diverse: the best few per entry business, so every entry stays comparable.
    const perEntry = new Map<string, number>();
    frontier = [];
    for (const one of scored) {
      const entry = one.p.stages[0]!.business.key;
      const n = perEntry.get(entry) ?? 0;
      if (n >= 2) continue;
      perEntry.set(entry, n + 1);
      frontier.push(one.p);
      if (frontier.length >= BEAM) break;
    }
  }
  finished.sort((a, b) => compareStrategies(a, b, criteria).order);
  return finished;
}

/** The best strategy for each distinct entry business, best first. */
export function bestPerEntry(strategies: Strategy[]): Strategy[] {
  const seen = new Set<string>();
  const out: Strategy[] = [];
  for (const s of strategies) {
    const entry = s.stages[0]!.business.key;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(s);
  }
  return out;
}

export function compareWithBest(best: Strategy, others: Strategy[], criteria: string[]): Comparison[] {
  return others.map((o) => {
    const { criterion } = compareStrategies(o, best, criteria);
    const detail =
      criterion === 'feasible'
        ? (o.infeasibleBecause ?? '')
        : criterion === 'ambition'
          ? `ends controlling ${o.control.filter((c) => c.held).length} of ${o.control.length} (best: ${best.control.filter((c) => c.held).length} — ${best.control.filter((c) => c.held).map((c) => c.name).join('; ')})`
          : criterion === 'firstCash' || criterion === 'firstCashDays'
            ? `first collected cash in about ${o.firstCashDays === null ? 'an unknown number of' : Math.round(o.firstCashDays)} days (best: ${best.firstCashDays === null ? 'unknown' : Math.round(best.firstCashDays)})`
            : criterion === 'exposure'
              ? `up to ${o.entryExposure === null ? 'an unknown amount' : money(o.entryExposure)} at risk at entry (best: ${best.entryExposure === null ? 'unknown' : money(best.entryExposure)})`
              : criterion === 'finalContribution'
                ? `about ${o.finalContribution === null ? 'unknown' : money(o.finalContribution)}/month once built (best: ${best.finalContribution === null ? 'unknown' : money(best.finalContribution)})`
                : criterion === 'entryViability'
                  ? `entry reads ${o.stages[0]!.economics.viability.toLowerCase()} (best: ${best.stages[0]!.economics.viability.toLowerCase()})`
                  : '';
    return { strategy: o.key, entry: o.stages[0]!.business.label, lostOn: CRITERION_SENTENCE[criterion] ?? criterion, detail };
  });
}

export function followsSequence(s: Strategy, sequence: SequenceStep[]): boolean {
  if (sequence.length === 0) return false;
  let i = 0;
  for (const stage of s.stages) {
    if (i < sequence.length && matchesStep(stage.business, sequence[i]!)) i += 1;
  }
  return i === sequence.length && matchesStep(s.stages[0]!.business, sequence[0]!);
}

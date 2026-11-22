/**
 * What would resolve a no-plan conclusion's decisive blocker (COMPLETION-SPEC §3a).
 *
 * A conclusion that no executable plan exists is complete only when it says what
 * would change that: the measurement, research or change of terms that would make
 * the blocked link hold, and the number it would have to reach. "Costs at least
 * what it pays" is a verdict; "the direct cost must fall below 2,000 USD a deal —
 * obtain the supplier's written quote, renegotiate it, or find a fulfiller under
 * 2,000" is what to do about it.
 *
 * Every threshold here is computed from the planner's own numbers for the members
 * of the strategies the gate judged NOT_VIABLE — their price, direct cost, days to
 * cash, owner hours, capital and the deals each strategy takes — against the goal's
 * own limits. Nothing here changes a verdict: a resolution is advice that rides
 * beside the conclusion as a research priority (`resolve:` variables, which
 * `sendPlanQuestions` never dispatches and `pathResearch` never keys), and, for a
 * goal arithmetic rules out, as the owner-hours relaxation `judgeFeasibility`
 * cannot see. Pure.
 */
import type { ModelledOpportunity } from '../cash/goalScenario.ts';
import { decideResearch } from '../quant/deadline.ts';
import type { ResearchPriority } from './plan.ts';

/** One member of a strategy the gate judged NOT_VIABLE, with the deals that strategy takes of it. */
export interface BlockedMember {
  one: ModelledOpportunity;
  /** Deals the strategy takes, agreed ones included (`dealsTaken`). */
  deals: number;
}

export interface ResolutionInput {
  /** Each NOT_VIABLE strategy's members. */
  strategies: BlockedMember[][];
  remaining: number;
  currency: string;
  daysLeft: number | null;
  hoursCeiling: number | null;
  capitalCeiling: number | null;
  /** The target counts money kept (net of direct costs). */
  net: boolean;
  /** How long a research question takes to come back (`RESEARCH_TURNAROUND_DAYS`). */
  researchDays: number;
  /** What resolving it is worth in the goal-met share: the gap between the requirement and the reach held. */
  value: number;
}

export interface Resolution {
  priority: ResearchPriority;
  /** The objective's limit this resolution would relax, when changing the terms is one way to resolve it. */
  relax: { constraint: 'DEADLINE' | 'CAPITAL' | 'TARGET' | 'OWNER_HOURS'; suggestion: string } | null;
}

const known = (x: { value: number | null; provenance: string }): number | null => (x.value !== null && x.provenance !== 'UNKNOWN' ? x.value : null);
const fmt = (x: number): string => (Math.abs(x) >= 100 ? Math.round(x).toLocaleString('en-US') : String(Math.round(x * 100) / 100));
const titleOf = (one: ModelledOpportunity): string => `"${one.opportunity.title.slice(0, 60)}"`;
/** A price the plan can sell at: the stated figure, else the top of its range. */
const priceOf = (one: ModelledOpportunity): number | null => one.price.value ?? one.price.high ?? null;

/**
 * The resolutions of every blocker the NOT_VIABLE strategies show, most decisive
 * first, one per condition and opening. Pure.
 */
export function blockerResolutions(input: ResolutionInput): Resolution[] {
  const out = new Map<string, Resolution>();
  const cur = input.currency;
  const add = (key: string, variable: string, field: string | null, learnable: boolean, reason: string, relax: Resolution['relax'] = null) => {
    if (out.has(key)) return;
    const verdict = decideResearch(
      { key: variable, informationValue: Math.max(0.01, input.value), changesDecision: true, researchDays: input.researchDays, learnableInExecution: learnable },
      // Nothing executes while the blocker stands, so the slowest path is not yet running.
      { daysLeft: input.daysLeft ?? 365, executionDaysP90: 0 },
    );
    out.set(key, {
      priority: { variable, opportunityId: null, field, value: Math.max(0.01, input.value), changesDecision: true, decision: verdict.decision, reason: `${reason}${relax ? `; or change the terms — ${relax.suggestion}` : ''}; ${verdict.reason}` },
      relax,
    });
  };

  for (const members of input.strategies) {
    const ids = members.map((m) => m.one.opportunity.id);
    let reachable = 0;
    let deals = 0;
    for (const { one, deals: taken } of members) {
      const price = priceOf(one);
      const cost = known(one.directCost);
      const days = known(one.daysToCash) ?? (one.daysToCash.inferred?.justified ? one.daysToCash.inferred.p10 : null);
      const hours = known(one.hours);
      const capital = known(one.capital);
      const n = Math.max(1, taken);
      deals += n;
      const late = days !== null && input.daysLeft !== null && days > input.daysLeft;
      if (!late && price !== null) reachable += n * (input.net ? price - (cost ?? 0) : price);

      // ECONOMICS: a deal that costs at least what it pays.
      if (price !== null && cost !== null && cost >= price) {
        add(
          `cost:${one.opportunity.id}`,
          `resolve:direct cost:${one.opportunity.id}`,
          'directCosts',
          false,
          `${titleOf(one)} costs ${fmt(cost)} ${cur} a deal against a price of ${fmt(price)}: the direct cost must fall below ${fmt(price)} ${cur} a deal (a cut of more than ${fmt(cost - price)}) — obtain the supplier's written quote, renegotiate it, or find a fulfiller that delivers for under ${fmt(price)} — or buyers must be shown to pay more than ${fmt(cost)}`,
        );
      }

      // SETTLES_IN_TIME: cash that arrives after the deadline.
      if (late && days !== null && input.daysLeft !== null) {
        add(
          `days:${one.opportunity.id}`,
          `resolve:days to cash:${one.opportunity.id}`,
          'timeToFirstCash',
          false,
          `${titleOf(one)} settles in ${fmt(days)} days, ${fmt(days - input.daysLeft)} after the ${fmt(input.daysLeft)} left: its cash must arrive within ${fmt(input.daysLeft)} days — obtain the buyer's payment terms in writing and secure a deposit, payment on delivery or terms of ${fmt(input.daysLeft)} days or fewer, or find buyers of it who pay that fast`,
          { constraint: 'DEADLINE', suggestion: `move the deadline to at least ${Math.ceil(days)} days from now, when ${titleOf(one)} settles` },
        );
      }

      // CAPITAL: one lot ties up more than the goal may commit.
      if (capital !== null && capital > 0 && input.capitalCeiling !== null && capital > input.capitalCeiling) {
        add(
          `capital:${one.opportunity.id}`,
          `resolve:capital:${one.opportunity.id}`,
          'requiredCapital',
          false,
          `one deal of ${titleOf(one)} ties up ${fmt(capital)} ${cur} before it pays, more than the ${fmt(input.capitalCeiling)} the goal may commit: what a deal ties up must fall to ${fmt(input.capitalCeiling)} ${cur} or less — secure a buyer's deposit, supplier credit or a smaller first lot`,
          { constraint: 'CAPITAL', suggestion: `allow the goal to commit at least ${fmt(capital)} ${cur}, what one deal of ${titleOf(one)} ties up` },
        );
      }
    }

    // OWNER_HOURS: the deals the strategy takes need more owner hours than the goal has.
    if (input.hoursCeiling !== null) {
      const owned = members.filter(({ one }) => (known(one.hours) ?? 0) > 0);
      const needed = owned.reduce((sum, { one, deals: taken }) => sum + Math.max(1, taken) * known(one.hours)!, 0);
      if (owned.length > 0 && needed > input.hoursCeiling + 1e-9) {
        const lead = [...owned].sort((a, b) => Math.max(1, b.deals) * known(b.one.hours)! - Math.max(1, a.deals) * known(a.one.hours)!)[0]!;
        const ownerDeals = owned.reduce((sum, m) => sum + Math.max(1, m.deals), 0);
        const perDeal = input.hoursCeiling / ownerDeals;
        add(
          `hours:${ids.join(',')}`,
          `resolve:${lead.one.opportunity.id}:owner hours`,
          null,
          false,
          `the ${fmt(ownerDeals)} deal(s) need ${fmt(needed)} owner hours against the ${fmt(input.hoursCeiling)} this goal has: the owner's hours must fall to ${fmt(perDeal)} a deal (from ${fmt(known(lead.one.hours)!)} on ${titleOf(lead.one)}) — find a provider who performs the work for a fee inside the margin, so the owner only hands it over — or the goal must allow ${fmt(needed)} owner hours`,
          { constraint: 'OWNER_HOURS', suggestion: `allow at least ${Math.ceil(needed)} owner hours over the goal's window, what the deals held need` },
        );
      }
    }

    // TARGET, net of direct costs: the margin the strategy's deals must keep.
    if (input.net && deals > 0 && reachable < input.remaining) {
      const lead = members.find(({ one }) => priceOf(one) !== null && known(one.directCost) !== null);
      if (lead) {
        const price = priceOf(lead.one)!;
        const cost = known(lead.one.directCost)!;
        const margin = input.remaining / deals;
        const ceiling = price - margin;
        add(
          `net:${ids.join(',')}`,
          `resolve:net direct cost:${lead.one.opportunity.id}`,
          'directCosts',
          false,
          `the ${fmt(deals)} deal(s) held must keep ${fmt(margin)} ${cur} each to net the ${fmt(input.remaining)} still needed: ${ceiling > 0 ? `the direct cost of ${titleOf(lead.one)} must fall below ${fmt(ceiling)} ${cur} a deal (it is ${fmt(cost)}) — obtain the supplier's written quote, renegotiate it, or find a cheaper fulfiller — or` : 'no cut in cost alone reaches it, so'} the price must rise to at least ${fmt(cost + margin)}`,
        );
      }
    }

    // TARGET / MARKET_VOLUME: deals in time that cannot add up to what is still needed.
    if (!input.net && deals > 0 && reachable > 0 && reachable < input.remaining) {
      const shortBy = input.remaining - reachable;
      const lead = members
        .filter(({ one }) => priceOf(one) !== null && !(known(one.daysToCash) !== null && input.daysLeft !== null && known(one.daysToCash)! > input.daysLeft))
        .sort((a, b) => priceOf(b.one)! - priceOf(a.one)!)[0];
      if (lead) {
        const price = priceOf(lead.one)!;
        const more = Math.ceil(shortBy / price - 1e-9);
        const held = Math.max(1, lead.deals);
        const relax = { constraint: 'TARGET' as const, suggestion: `lower the target to about ${fmt(reachable)} ${cur}, what the deals held bring at most` };
        if (lead.one.repeatable) {
          add(
            `market:${ids.join(',')}`,
            `resolve:market:${lead.one.opportunity.id}`,
            'buyerVolume',
            false,
            `the deals held bring at most ${fmt(reachable)} of the ${fmt(input.remaining)} ${cur} still needed: the market for ${titleOf(lead.one)} must hold at least ${fmt(held + more)} deals at ${fmt(price)} inside the window (the plan holds ${fmt(held)}) — find and count ${fmt(more)} more buyers who pay, or establish a price of at least ${fmt(price + shortBy / held)}`,
            relax,
          );
        } else {
          add(
            `price:${ids.join(',')}`,
            `resolve:price:${lead.one.opportunity.id}`,
            'revenueRange',
            false,
            `the deals held bring at most ${fmt(reachable)} of the ${fmt(input.remaining)} ${cur} still needed: buyers of ${titleOf(lead.one)} must be shown to pay at least ${fmt(price + shortBy / held)} a deal (they pay ${fmt(price)}), or ${fmt(more)} more openings like it must be found`,
            relax,
          );
        }
      }
    }
  }
  return [...out.values()];
}

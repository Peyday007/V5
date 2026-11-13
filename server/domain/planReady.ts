/**
 * When a cash goal's plan is ready to tell the owner about, and what the message says.
 *
 * Owner, 2026-11-13: "NOTIFY ME IMMEDIATELY WHEN BRAIN HAS FINISHED DEVELOPING A VIABLE,
 * ACTIONABLE PLAN TO GENERATE $10,000 IN COLLECTED REVENUE WITHIN 30 DAYS … Do not notify me
 * merely because a plan document exists or Brain generated an optimistic forecast … Do not
 * require the $10,000 to have already been earned."
 *
 * Owner, 2026-11-13 (later): "a credible plan to generate $10,000 in collected revenue within
 * 30 days, using no more than $3,000 in starting capital … The completion response must
 * prominently begin: "$10K / 30-DAY PLAN — COMPLETE"". The starting capital is a condition and
 * its allocation is a section of the message.
 *
 * Every condition is read off what Brain already computes — §95's acceptance (the 90%
 * Wilson lower bound on an all-evidence portfolio), the quant portfolio and its demand
 * estimates, the plan's own execution steps — and the operator's committed, challenged
 * ADOPT_PLAN decision (§108). Pure: no effect, no read.
 */

export interface PlanReadyMember {
  opportunityId: string;
  title: string;
  /** Major units, p10/p50/p90 over the worlds evaluated. */
  revenue: { p10: number; p50: number; p90: number } | null;
  price: { p50: number } | null;
  deals: { p50: number } | null;
  spend: { p50: number } | null;
  days: { p50: number; p90: number } | null;
  capitalAtStart: number | null;
  /** Every input rests on evidence or this Brain's own measurements. */
  justified: boolean;
  unestablished: string[];
}

export interface PlanReadyFacts {
  goalId: string;
  goalTitle: string;
  /** Major units. */
  targetAmount: number;
  remainingAmount: number;
  currency: string;
  daysLeft: number | null;
  achieved: boolean;
  /** §95: RECOMMENDABLE iff ACCEPTED. */
  verdict: string;
  acceptance: {
    status: string;
    required: number;
    probability: { value: number; lowerBound: number; basis: string; sample: number; note: string } | null;
    accepted: { label: string; opportunityIds: string[] } | null;
    sentence: string;
  };
  summary: string;
  portfolio: {
    basis: string;
    worlds: number;
    reach: number;
    settledP10: number;
    settledP50: number;
    settledP90: number;
    correlation: number;
    missing: string[];
  } | null;
  members: PlanReadyMember[];
  /** The plan's execution steps: what each opening needs next, and who does it. */
  steps: { title: string; step: string; by: string; blocker: string | null }[];
  /** The operator's committed ADOPT_PLAN decision on this plan, with the challenger's reading. */
  hermes: {
    decisionId: string;
    committedAt: string;
    chosenAction: string;
    adopted: boolean;
    challenge: { verdict: string; model: string; reasons: string; hiddenAssumptions: string[]; missingVariables: string[]; strongerAlternative: string | null } | null;
    answeredChallenge: string | null;
    prediction: { outcome: string; probability: number; horizonDays: number };
  } | null;
  /** When the current accepted plan was first read as ACCEPTED; the decision must follow it. */
  acceptedSince: string | null;
  /** The goal's own capital ceiling, major units, or null when it has none. */
  capitalCeiling: number | null;
}

/** The owner's starting-capital limit for the plan, major units (owner, 2026-11-13). */
export const OWNER_STARTING_CAPITAL = 3000;

/** The capital the plan may commit: the owner's limit, or the goal's own ceiling when lower. */
export function capitalLimit(f: Pick<PlanReadyFacts, 'capitalCeiling'>): number {
  return f.capitalCeiling !== null ? Math.min(f.capitalCeiling, OWNER_STARTING_CAPITAL) : OWNER_STARTING_CAPITAL;
}

/** What the plan commits before its revenue arrives: each member's capital at start plus its median spend. */
export function capitalCommitted(f: Pick<PlanReadyFacts, 'members'>): number {
  return f.members.reduce((sum, m) => sum + (m.capitalAtStart ?? 0) + (m.spend?.p50 ?? 0), 0);
}

export const PLAN_READY_CONDITIONS = [
  'STRATEGIES_AND_SOURCES',
  'QUANTIFIED_ECONOMICS_AND_TIMELINES',
  'EVIDENCE_FOR_ASSUMPTIONS',
  'RESOURCES_DEPENDENCIES_STEPS',
  'WHY_THE_COMBINATION_REACHES_TARGET',
  'STARTING_CAPITAL_WITHIN_LIMIT',
  'DEFENSIBLE_UNCERTAINTY',
  'CHALLENGED_BY_HERMES',
  'PASSED_PLANNING_AND_EVIDENCE_REQUIREMENTS',
] as const;
export type PlanReadyCondition = (typeof PLAN_READY_CONDITIONS)[number];

/**
 * Whether the plan qualifies. Each condition is null when met, else why not. A forecast
 * alone never qualifies: the probability must be §95's defensible one, every member's inputs
 * evidenced, and the operator must have challenged and adopted this plan after it was accepted.
 */
export function planReady(f: PlanReadyFacts): { ready: boolean; conditions: Record<PlanReadyCondition, string | null> } {
  const p = f.acceptance.probability;
  const members = f.members;
  const accepted = f.acceptance.accepted;
  const conditions: Record<PlanReadyCondition, string | null> = {
    STRATEGIES_AND_SOURCES:
      !accepted || accepted.opportunityIds.length === 0
        ? 'no accepted plan names its revenue sources'
        : members.length === 0
          ? 'the accepted plan has no modelled members'
          : null,
    QUANTIFIED_ECONOMICS_AND_TIMELINES: !f.portfolio
      ? 'no quantified portfolio'
      : members.some((m) => !m.revenue || !m.price || !m.days)
        ? `unquantified: ${members.filter((m) => !m.revenue || !m.price || !m.days).map((m) => m.title).join(', ').slice(0, 200)}`
        : f.daysLeft === null
          ? 'the goal has no deadline to time the plan against'
          : members.some((m) => m.days!.p50 > f.daysLeft!)
            ? `a member's median time to cash is past the ${f.daysLeft}-day deadline`
            : null,
    EVIDENCE_FOR_ASSUMPTIONS:
      !p || p.basis === 'TARGET_MET'
        ? 'no evidenced probability'
        : f.portfolio && f.portfolio.basis !== 'PROBABILITY'
          ? 'the portfolio is coverage, not a probability on evidence'
          : members.some((m) => !m.justified)
            ? `inputs not on evidence: ${members.flatMap((m) => m.unestablished.map((u) => `${m.title}: ${u}`)).join('; ').slice(0, 300)}`
            : null,
    RESOURCES_DEPENDENCIES_STEPS:
      members.some((m) => m.capitalAtStart === null || !m.spend)
        ? 'a member has no stated capital or spend'
        : f.steps.length === 0
          ? 'no execution steps'
          : null,
    WHY_THE_COMBINATION_REACHES_TARGET: !f.portfolio
      ? 'no combined reading'
      : f.portfolio.settledP50 < f.remainingAmount
        ? `the combination's median settles ${f.portfolio.settledP50}, under the ${f.remainingAmount} remaining`
        : null,
    STARTING_CAPITAL_WITHIN_LIMIT:
      members.some((m) => m.capitalAtStart === null || !m.spend)
        ? 'a member has no stated capital or spend to allocate'
        : capitalCommitted(f) > capitalLimit(f)
          ? `the plan commits ${Math.round(capitalCommitted(f))} before revenue, over the ${capitalLimit(f)} starting-capital limit`
          : null,
    DEFENSIBLE_UNCERTAINTY: !p
      ? 'no probability'
      : p.lowerBound < f.acceptance.required
        ? `lower bound ${p.lowerBound} under the required ${f.acceptance.required}`
        : p.sample <= 0
          ? 'no sample behind the probability'
          : null,
    CHALLENGED_BY_HERMES: !f.hermes
      ? 'Hermes has not challenged and adopted this plan (brain_operator_decide ADOPT_PLAN)'
      : !f.hermes.challenge
        ? 'no challenger model answered on the adoption'
        : f.hermes.challenge.verdict === 'REVISE' && !(f.hermes.answeredChallenge ?? '').trim()
          ? 'the challenger said REVISE and it was not answered'
          : !f.hermes.adopted
            ? `Hermes chose "${f.hermes.chosenAction.slice(0, 120)}", not to adopt the plan`
            : f.acceptedSince && f.hermes.committedAt < f.acceptedSince
              ? 'the adoption predates the plan being accepted'
              : null,
    PASSED_PLANNING_AND_EVIDENCE_REQUIREMENTS:
      f.acceptance.status !== 'ACCEPTED' || f.verdict !== 'RECOMMENDABLE'
        ? `the plan is ${f.acceptance.status} (${f.verdict}), not ACCEPTED`
        : f.achieved
          ? 'the target is already collected: there is no plan left to report'
          : null,
  };
  return { ready: Object.values(conditions).every((c) => c === null), conditions };
}

const money = (n: number, currency: string): string =>
  `${currency === 'USD' ? '$' : `${currency} `}${Math.round(n).toLocaleString('en-US')}`;
const pct = (x: number): string => `${Math.round(x * 1000) / 10}%`;

/** The first line of the completion response, exactly as the owner asked for it. */
export function completionHeader(f: Pick<PlanReadyFacts, 'targetAmount'>): string {
  return f.targetAmount === 10000 ? '$10K / 30-DAY PLAN — COMPLETE' : `$${Math.round(f.targetAmount / 1000)}K PLAN — COMPLETE`;
}

/**
 * The completion response: it begins with the owner's header, then the actual plan, how the
 * starting capital is allocated, how the plan reaches the target, the evidence and confidence
 * (with Hermes' challenge), and what Brain executes next. Every figure is the reading's.
 */
export function planReadyNotice(f: PlanReadyFacts): { subject: string; text: string } {
  const c = f.currency;
  const p = f.acceptance.probability!;
  const pf = f.portfolio!;
  const h = f.hermes!;
  const limit = capitalLimit(f);
  const committed = capitalCommitted(f);
  const subject = completionHeader(f);
  const text = [
    subject,
    '',
    `Goal: ${f.goalTitle} — ${money(f.remainingAmount, c)} to collect${f.daysLeft !== null ? `, ${f.daysLeft} days left` : ''}. Nothing has been collected by this announcement; Brain and Hermes keep executing and improving the plan.`,
    '',
    'THE ACTUAL PLAN',
    f.acceptance.accepted!.label,
    f.summary.slice(0, 700),
    ...f.members.map((m) => `- ${m.title}: sold at ${money(m.price!.p50, c)}, ~${Math.round(m.deals?.p50 ?? 0)} deal(s), cash in ~${Math.round(m.days!.p50)} days (p90 ${Math.round(m.days!.p90)}).`),
    '',
    `HOW THE ${money(limit, c)} IS ALLOCATED`,
    ...f.members.map((m) => `- ${m.title}: ${money(m.capitalAtStart ?? 0, c)} at start + ${money(m.spend!.p50, c)} median spend.`),
    `Committed before revenue: ${money(committed, c)} of ${money(limit, c)}; held in reserve: ${money(Math.max(0, limit - committed), c)}.`,
    '',
    `HOW THE PLAN GENERATES ${money(f.targetAmount, c)}`,
    ...f.members.map((m) => `- ${m.title}: ${money(m.revenue!.p50, c)} median (${money(m.revenue!.p10, c)}–${money(m.revenue!.p90, c)}).`),
    `Combined: ${money(pf.settledP50, c)} median settled (p10 ${money(pf.settledP10, c)}, p90 ${money(pf.settledP90, c)}) against ${money(f.remainingAmount, c)} remaining; the target is reached in ${pct(pf.reach)} of ${pf.worlds} worlds.`,
    f.acceptance.sentence.slice(0, 600),
    '',
    'SUPPORTING EVIDENCE AND CONFIDENCE',
    `Probability of collecting the target before the deadline: ${pct(p.value)}, defensible lower bound ${pct(p.lowerBound)} (Brain requires ${pct(f.acceptance.required)}), over ${p.sample} worlds; shared-outreach correlation assumed ${pf.correlation}.`,
    `Basis: ${p.basis} — ${p.note.slice(0, 400)} Every input of every member rests on evidence or Brain's own measurements.`,
    ...(pf.missing.length ? [`Stated limits: ${pf.missing.slice(0, 4).join('; ').slice(0, 400)}`] : []),
    `Hermes challenged and adopted it (decision ${h.decisionId}): "${h.chosenAction.slice(0, 160)}", predicting ${pct(h.prediction.probability)} that ${h.prediction.outcome.slice(0, 160)} within ${h.prediction.horizonDays} days.`,
    h.challenge
      ? `Challenger (${h.challenge.model}): ${h.challenge.verdict}. ${h.challenge.reasons.slice(0, 400)}${h.challenge.hiddenAssumptions.length ? ` Hidden assumptions named: ${h.challenge.hiddenAssumptions.slice(0, 4).join('; ')}.` : ''}${h.challenge.strongerAlternative ? ` Alternative raised: ${h.challenge.strongerAlternative.slice(0, 200)}.` : ''}`
      : '',
    h.answeredChallenge ? `Hermes' answer to the challenge: ${h.answeredChallenge.slice(0, 400)}` : '',
    '',
    'WHAT BRAIN IS EXECUTING NEXT',
    ...f.steps.slice(0, 8).map((s) => `- ${s.title}: ${s.step}${s.by === 'PERSON' ? ` — needs you: ${s.blocker ?? 'see Brain'}` : ''}`),
    '',
    `Goal ${f.goalId}. Announced once for this plan; a different plan that qualifies later is announced on its own.`,
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n');
  return { subject, text: text.slice(0, 12_000) };
}

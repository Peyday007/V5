/**
 * The investment committee (§117; owner, 2026-11-23): a permanent, independent,
 * adversarial review of every plan reading, inside the acceptance it gates.
 *
 * Six roles read the same structured record and judge it each from its own
 * position: SKEPTIC (unsupported assumptions, invented markets, misread
 * payments, contradictions, weak evidence), INVESTOR (capital, downside,
 * concentration), OPERATOR (acquisition, fulfilment, collection), MARKET_EXPERT
 * (paying buyers, reachable demand, volume), QUANT (the figures reconstructed
 * from the original evidence, the estimators against each other, a coverage
 * figure presented as a probability) and OWNER_PROXY (the goal reached, fast
 * cash, repeatable economics, no routine owner work, no speculation dressed as a
 * repeatable business).
 *
 * Nothing new decides acceptance. The committee is read where the plan's
 * integrity already is (`gateIntegrity`, plan.ts), and it can only take an
 * acceptance away, never grant one:
 *
 *   * every role has a DETERMINISTIC layer, computed here from the reading's
 *     own structured fields — the pathway facts with the evidence sentence each
 *     rests on, the simulation's inputs, the goal's limits. A critical defect
 *     (a non-purchase counted as a price, one company counted as a population,
 *     economics the evidence cannot reach, a coverage figure claimed as a
 *     probability, cash after the deadline, capital over the ceiling) BLOCKS,
 *     whatever any other role says. There is no vote.
 *   * a judgment the code cannot settle is UNKNOWN, and on a final plan (an
 *     ACCEPTED reading, or one committing material capital) it becomes a
 *     specialist question routed through the needs owner that already exists
 *     (`sendNeeds`, research), carrying only the objective and the original
 *     evidence — never the planner's verdict, reach or recommendation. That is
 *     how "independent before seeing the planner's conclusions" is held: the
 *     question a worker receives has no conclusion in it to agree with.
 *   * a question research has answered is read back (`committeeAnswersOf`,
 *     the accepted sourced claims under the idea the question opened): the role
 *     that asked it settles it from the answer — the fact established, or broken
 *     with a RESEARCH defect (money that is not a purchase, cash after the
 *     window) — on the next reading, so an UNKNOWN for want of evidence names its
 *     research need and ends when the evidence arrives (`settleByAnswers`).
 *   * SKEPTIC's specialist layer is the existing independent model challenge
 *     (`quant/modelChallenge.ts`, read off the portfolio's assurance): a REVISE
 *     fails the role, an unanswered required challenge leaves it UNKNOWN.
 *   * on a FULL review with a model configured, every role is also read by an
 *     independent specialist model (`committeeSpecialists.ts`), combined by
 *     `withSpecialist`: a model adds a FAIL or holds a PASS as UNKNOWN, never
 *     turns a FAIL or UNKNOWN into a PASS, and an unanswered model is UNKNOWN.
 *   * two roles reading the same fact of the same leg the opposite way (one
 *     finds it established, another finds it broken) is a dispute: it becomes
 *     a targeted investigation naming the fact, and the FAIL still stands —
 *     disagreement is never settled by agreement.
 *
 * The roles' inputs are split so the judgment is not the planner's: every role
 * reads `evidence` (the objective and the facts with their sources); only QUANT,
 * SKEPTIC and INVESTOR read `claims` (the planner's figures), and only as the
 * thing they challenge. No role reads the acceptance's status, verdict or
 * sentence. Pure.
 */
import { createHash } from 'node:crypto';
import { namesOneOrganisation } from '../../domain/industry.ts';
import { evidenceIsAbout, nonPurchaseSentence, paymentNatureOf } from '../../domain/paymentNature.ts';
import type { Need } from '../quant/needs.ts';
import type { GapKind, PathFact, TransactionPathway } from './pathways.ts';
import type { PlanReading } from './plan.ts';
import type { DemandEstimate } from './portfolio.ts';

export const COMMITTEE_ROLES = ['SKEPTIC', 'INVESTOR', 'OPERATOR', 'MARKET_EXPERT', 'QUANT', 'OWNER_PROXY'] as const;
export type CommitteeRole = (typeof COMMITTEE_ROLES)[number];
export type CommitteeVerdict = 'PASS' | 'FAIL' | 'UNKNOWN';

/** A fact of one leg two roles can disagree about. */
export type CommitteeFact = 'price' | 'volume' | 'buyer' | 'channel' | 'fulfilment' | 'payment' | 'capital' | 'economics' | 'reach' | 'probability' | 'mechanism';

export interface CommitteeDefect {
  /** What the plan claims or rests on, in its own words. */
  claim: string;
  /** Where the evidence is: `<opening>#<fact>` with the source sentence, or the reading field. */
  evidenceRef: string;
  /** Why it is a defect, exactly. */
  why: string;
  critical: boolean;
  opportunityId: string | null;
  fact: CommitteeFact;
  /**
   * Who found it: the role's own code (RULE, the default when absent), a sourced
   * research answer to the role's own question (RESEARCH), or the role's
   * independent specialist model (MODEL). A MODEL defect is never critical.
   */
  source?: CommitteeSource;
}

/** Who found a defect or settled a question. */
export type CommitteeSource = 'RULE' | 'RESEARCH' | 'MODEL';

/**
 * A sourced research answer read back to the committee: an accepted claim with
 * its source, under the research idea the committee's question opened
 * (`committeeAnswersOf`, portfolioNeeds.ts). Matched to its question by the
 * idea's title, which `sendNeeds` builds from the question's research subject.
 */
export interface CommitteeAnswer {
  /** The research idea's title (`Causal unknown: committee <ROLE>: …`, `needIdeaTitle`). */
  ideaTitle: string;
  claimId: string;
  text: string;
  sourceUrl: string;
}

/** A question research answered, and what the answer did to the role's verdict. */
export interface CommitteeSettled {
  subject: string;
  /** The research need it was asked as. */
  research: string;
  opportunityId: string | null;
  fact: CommitteeFact;
  /** PASS: the answer establishes the fact; FAIL: it breaks it (a RESEARCH defect is recorded); UNKNOWN: read, still unsettled. */
  outcome: CommitteeVerdict;
  why: string;
  claimIds: string[];
  sourceUrls: string[];
}

/**
 * One role's independent specialist reading (a model call, `committeeSpecialists.ts`).
 * UNKNOWN when the model did not answer, timed out, or answered FAIL without
 * citing a defect: never a pass.
 */
export interface SpecialistFinding {
  role: CommitteeRole;
  verdict: CommitteeVerdict;
  /** Its cited defects (source MODEL, never critical). */
  defects: CommitteeDefect[];
  citations: string[];
  /** The model that answered (its label), null when none did. */
  model: string | null;
  /** Why it is UNKNOWN, when it is. */
  reason: string | null;
}

/** The specialist pass over one committee input, as recorded (`COMMITTEE_SPECIALIST_REVIEW`). */
export interface SpecialistReview {
  /** `committeeFingerprint` of the input the models read: a review binds only the plan it read. */
  fingerprint: string;
  reviewedAt: string;
  findings: SpecialistFinding[];
}

/** What the committee reads beside the reading: research answers and the specialist pass. */
export interface CommitteeContext {
  answers?: readonly CommitteeAnswer[];
  /** Recorded specialist reviews, newest first; only one with this input's fingerprint binds. */
  specialistReviews?: readonly SpecialistReview[];
  /** A specialist model is configured: on a FULL review a role without its answer is UNKNOWN, never a pass. */
  specialistsAvailable?: boolean;
}

/** A judgment the code could not settle, put to a specialist with only the objective and the evidence. */
export interface CommitteeQuestion {
  role: CommitteeRole;
  opportunityId: string | null;
  fact: CommitteeFact;
  subject: string;
  question: string;
  /** The research need this question is sent as (`committeeResearchSubject`): what a finding UNKNOWN for want of evidence waits on. */
  research: string;
  /** Answers research returned that did not settle it, by claim id. */
  answeredBy?: string[];
}

export interface RoleVerdict {
  role: CommitteeRole;
  verdict: CommitteeVerdict;
  /** Any of its defects is critical: it blocks acceptance on its own. */
  critical: boolean;
  defects: CommitteeDefect[];
  /** The evidence it read, each `<opening>#<fact>: "<source sentence>"`. */
  citations: string[];
  /** What it could not settle (UNKNOWN), as questions. */
  open: CommitteeQuestion[];
  /** Its questions research has answered, and what each answer did. */
  settled: CommitteeSettled[];
  /** Its independent specialist's reading, when the specialist pass applies (FULL, a model configured). */
  specialist: SpecialistFinding | null;
}

/** Two roles reading one fact of one leg the opposite way: investigated, never voted. */
export interface CommitteeInvestigation {
  opportunityId: string;
  fact: CommitteeFact;
  established: CommitteeRole[];
  broken: CommitteeRole[];
  question: string;
}

export interface CommitteeReading {
  /** ROUTINE: deterministic layers only. FULL: a final commercial plan or a material commitment — specialists are asked too. */
  tier: 'ROUTINE' | 'FULL';
  /** Every leg the committee read, the plan's own first. */
  reviewed: string[];
  roles: RoleVerdict[];
  /** FAIL when any role fails, UNKNOWN when none fails and any is unsettled, else PASS. Never a majority. */
  verdict: CommitteeVerdict;
  /** Critical defects found, across roles. */
  criticalDefects: number;
  /** Whether it refuses an acceptance: any FAIL, any critical defect, or (FULL) any UNKNOWN. */
  blocks: boolean;
  /** The one thing that stops it, in a sentence; null when it passes. */
  blocker: string | null;
  investigations: CommitteeInvestigation[];
  /** Milliseconds the review took on this read (set by the caller that timed it). */
  reviewMs?: number;
  /** `committeeFingerprint` of the input: what a specialist review must have read to bind. */
  fingerprint: string;
  /**
   * The specialist pass: NOT_RUN (a routine review, or no model configured — the
   * deterministic committee alone, and the record says so), PENDING (due and not
   * yet answered: every role it would read is UNKNOWN), BOUND (a review of this
   * very input is combined).
   */
  specialists: { state: 'NOT_RUN' | 'PENDING' | 'BOUND'; reviewedAt: string | null; models: string[] };
  /** Committee questions research answered on this read. */
  answered: number;
}

/** The leg as every role reads it: its transaction facts and the simulation's inputs, nothing concluded. */
export interface CommitteeLeg {
  opportunityId: string;
  /** Counted by the plan (accepted or candidate), or only presented in a figure a person reads. */
  scope: 'COUNTED' | 'PRESENTED';
  pathway: Pick<TransactionPathway, 'title' | 'origin' | 'buyer' | 'channel' | 'offer' | 'fulfiller' | 'revenuePerDeal' | 'fulfilmentCost' | 'acquisitionCost' | 'volume' | 'daysToCash' | 'capital' | 'gaps' | 'contribution' | 'permissionsMissing'> | null;
  demand: Pick<DemandEstimate, 'deals' | 'price' | 'unestablished' | 'capitalAtStart' | 'repeatable'> | null;
}

export interface CommitteeInput {
  /** What every role reads: the objective and the original evidence. */
  evidence: {
    goalId: string;
    objective: string;
    remaining: number;
    daysLeft: number | null;
    capitalCeiling: number | null;
    currency: string;
    legs: CommitteeLeg[];
  };
  /** The planner's figures, read only by QUANT and SKEPTIC, and only to challenge them. */
  claims: {
    reach: number | null;
    reachBasis: 'PROBABILITY' | 'COVERAGE' | null;
    probability: { value: number; lowerBound: number; basis: string } | null;
    portfolioBasis: 'PROBABILITY' | 'COVERAGE' | null;
    settledP50: number | null;
    /** The largest figure the reading presents toward the target (a combination's upper case). */
    presentedHigh: number | null;
    adverse: number | null;
    pathwayP10: number | null;
    keptP50: number | null;
    modelChallenge: { required: boolean; verdict: 'PROCEED' | 'REVISE' | null; due: boolean } | null;
  };
  /** FULL for a final commercial plan or a material commitment (`committeeTier`). */
  tier: 'ROUTINE' | 'FULL';
  /**
   * Sourced research answers to the committee's own questions, read back
   * (`committeeAnswersOf`): each role reads the answers to the questions it
   * asked, and only those. Not part of the fingerprint: an answer changes what
   * a role knows, not the plan a specialist read.
   */
  answers?: readonly CommitteeAnswer[];
}

const EVIDENCED = (f: PathFact | undefined | null) => !!f && f.status === 'PROVEN';
const num = (v: number | string | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const money = (x: number, currency: string) => `${currency === 'USD' ? '$' : `${currency} `}${Math.round(x).toLocaleString('en-US')}`;
const quote = (s: string) => `"${s.replace(/\s+/g, ' ').slice(0, 160)}"`;
const refOf = (leg: CommitteeLeg, fact: string, f: PathFact | null | undefined) => `${leg.opportunityId}#${fact}${f ? `: ${quote(f.basis)}` : ''}`;
const titleOf = (leg: CommitteeLeg) => (leg.pathway?.title ?? leg.opportunityId).slice(0, 80);
const has = (leg: CommitteeLeg, ...gaps: GapKind[]) => gaps.some((g) => leg.pathway?.gaps.includes(g));
/** The deals the plan's simulation counts on a leg at its upper end. */
const dealsCounted = (leg: CommitteeLeg) => leg.demand?.deals.p90 ?? num(leg.pathway?.volume.high) ?? 1;
const OWNER = /\b(?:the owner|owner(?:'s)? (?:own|personally)|personally)\b/i;

/** What one role sees and records, with its judgments of each fact kept for the dispute check. */
class Bench {
  readonly defects: CommitteeDefect[] = [];
  readonly citations = new Set<string>();
  readonly open: CommitteeQuestion[] = [];
  /** fact judgments: `<opportunityId>|<fact>` → established? */
  readonly judged = new Map<string, boolean>();
  readonly settled: CommitteeSettled[] = [];
  constructor(
    readonly role: CommitteeRole,
    private readonly input?: Pick<CommitteeInput, 'evidence' | 'answers'>,
  ) {}
  cite(ref: string) {
    this.citations.add(ref);
  }
  ok(leg: CommitteeLeg, fact: CommitteeFact, ref: string) {
    this.cite(ref);
    if (!this.judged.has(`${leg.opportunityId}|${fact}`)) this.judged.set(`${leg.opportunityId}|${fact}`, true);
  }
  fail(d: CommitteeDefect) {
    if (this.defects.some((x) => x.opportunityId === d.opportunityId && x.fact === d.fact && x.why === d.why)) return;
    this.defects.push(d);
    this.citations.add(d.evidenceRef);
    if (d.opportunityId) this.judged.set(`${d.opportunityId}|${d.fact}`, false);
  }
  /**
   * A judgment the code could not settle, named by the research need it is
   * sent as. When research has answered that question (`CommitteeInput.answers`),
   * the answer is read here and settles it — establishing the fact, or breaking
   * it with a RESEARCH defect — instead of it staying open; an answer that
   * settles nothing keeps it open with the claims it read.
   */
  ask(q: Omit<CommitteeQuestion, 'role' | 'research'>) {
    if (this.open.some((x) => x.subject === q.subject) || this.settled.some((x) => x.subject === q.subject)) return;
    const research = committeeResearchSubject(q.subject);
    const title = committeeIdeaTitle(research);
    const answers = (this.input?.answers ?? []).filter((a) => a.ideaTitle === title);
    if (answers.length === 0) {
      this.open.push({ ...q, role: this.role, research });
      return;
    }
    const read = settleByAnswers(q.fact, answers, this.input?.evidence.daysLeft ?? null);
    const claimIds = answers.map((a) => a.claimId);
    this.settled.push({ subject: q.subject, research, opportunityId: q.opportunityId, fact: q.fact, outcome: read.outcome, why: read.why, claimIds, sourceUrls: [...new Set(answers.map((a) => a.sourceUrl))] });
    const ref = `research ${read.claim.claimId} (${read.claim.sourceUrl}): ${quote(read.claim.text)}`;
    if (read.outcome === 'PASS') {
      this.cite(ref);
      if (q.opportunityId) this.judged.set(`${q.opportunityId}|${q.fact}`, true);
    } else if (read.outcome === 'FAIL') {
      this.fail({ claim: q.subject.replace(/^[A-Z_]+: /, ''), evidenceRef: ref, why: read.why, critical: read.critical, opportunityId: q.opportunityId, fact: q.fact, source: 'RESEARCH' });
    } else {
      this.cite(ref);
      this.open.push({ ...q, role: this.role, research, answeredBy: claimIds });
    }
  }
  verdict(): RoleVerdict {
    const verdict: CommitteeVerdict = this.defects.length > 0 ? 'FAIL' : this.open.length > 0 ? 'UNKNOWN' : 'PASS';
    return { role: this.role, verdict, critical: this.defects.some((d) => d.critical), defects: this.defects, citations: [...this.citations].slice(0, 12), open: this.open, settled: this.settled, specialist: null };
  }
}

/** The research need a committee question is sent as (`committeeNeeds`), keyed by the goal's committee scope. Pure. */
export function committeeResearchSubject(subject: string): string {
  return `committee ${subject}`.slice(0, 200);
}

/**
 * The title `sendNeeds` gives the research idea a RESEARCH need opens
 * (`needIdeaTitle`, quant/needs.ts, which owns it; kept here so this module
 * stays free of the database, and pinned equal by tests/committeeResearch.test.ts):
 * the idea a sourced answer is filed under, so an answer finds its question. Pure.
 */
export function committeeIdeaTitle(subject: string): string {
  return `Causal unknown: ${subject}`.slice(0, 200);
}

/** An answer that says it could not settle the question. */
const UNSETTLED_ANSWER = /\b(?:unknown|no (?:public |published )?(?:source|data|figure|evidence)|could not (?:find|establish|verify|confirm)|not (?:publicly )?(?:available|disclosed|published|found)|unable to (?:find|establish|verify))\b/i;
/** A money figure stated in an answer. */
const MONEY_FIGURE = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|dollars?)\b)/i;
/** A count stated in an answer. */
const COUNT_FIGURE = /\b\d[\d,]*(?:\.\d+)?\b/;
/** Days to cash stated in an answer: "net 30", "within 45 days", "14 business days". */
const DAYS_FIGURE = /\bnet[\s-]?(\d{1,3})\b|\b(\d{1,3})\s?(?:business |calendar |working )?days?\b/gi;
/** Paid at once: at order, at checkout, upfront, in advance. */
const PAID_AT_ONCE = /\b(?:up[\s-]?front|at (?:checkout|order|purchase|booking)|on (?:order|purchase)|prepa(?:id|y|yment)|in advance|immediately)\b/i;

/**
 * What the research answers to one committee question establish, read from
 * the claims' own sentences — never from the planner. PASS: a sourced answer
 * establishes the fact. FAIL: the answer breaks it (money that is not a
 * purchase, cash after the window), critical as the role's own rule would be.
 * UNKNOWN: the answers do not settle it. Pure.
 */
export function settleByAnswers(fact: CommitteeFact, answers: readonly CommitteeAnswer[], daysLeft: number | null): { outcome: CommitteeVerdict; why: string; critical: boolean; claim: CommitteeAnswer } {
  const first = answers[0]!;
  const useful = answers.filter((a) => !UNSETTLED_ANSWER.test(a.text));
  if (useful.length === 0) return { outcome: 'UNKNOWN', why: `research answered without settling it (${answers.length} claim(s) say it is not established)`, critical: false, claim: first };
  const lead = useful[0]!;
  if (fact === 'price') {
    const misread = useful.find((a) => paymentNatureOf(a.text).nature !== 'PURCHASE');
    if (misread) return { outcome: 'FAIL', why: `research found its money is ${nonPurchaseSentence(paymentNatureOf(misread.text))}`, critical: true, claim: misread };
    const priced = useful.find((a) => MONEY_FIGURE.test(a.text));
    return priced ? { outcome: 'PASS', why: 'a sourced answer states what these buyers pay', critical: false, claim: priced } : { outcome: 'UNKNOWN', why: 'research answered without a price', critical: false, claim: lead };
  }
  if (fact === 'volume') {
    const counted = useful.find((a) => COUNT_FIGURE.test(a.text));
    return counted ? { outcome: 'PASS', why: 'a sourced answer states how many buy', critical: false, claim: counted } : { outcome: 'UNKNOWN', why: 'research answered without a count', critical: false, claim: lead };
  }
  if (fact === 'payment') {
    for (const a of useful) {
      const days = [...a.text.matchAll(DAYS_FIGURE)].map((m) => Number(m[1] ?? m[2])).filter((d) => Number.isFinite(d));
      if (days.length > 0) {
        const soonest = Math.min(...days);
        if (daysLeft !== null && soonest > daysLeft) return { outcome: 'FAIL', why: `research found the money arrives after ${soonest} days, past the ${daysLeft} days left`, critical: true, claim: a };
        return { outcome: 'PASS', why: `research found the money arrives within ${soonest} days`, critical: false, claim: a };
      }
      if (PAID_AT_ONCE.test(a.text)) return { outcome: 'PASS', why: 'research found these buyers pay at order', critical: false, claim: a };
    }
    return { outcome: 'UNKNOWN', why: 'research answered without saying when the money arrives', critical: false, claim: lead };
  }
  return { outcome: 'PASS', why: `a sourced answer establishes the ${fact}`, critical: false, claim: lead };
}

/**
 * The specialist question for a fact the code could not settle: the objective and the
 * leg's own evidence, never what the planner concluded. Pure.
 */
export function specialistQuestion(input: Pick<CommitteeInput['evidence'], 'objective'>, leg: CommitteeLeg, ask: string): string {
  const p = leg.pathway;
  const facts = p
    ? [
        ['buyer', p.buyer],
        ['price', p.revenuePerDeal],
        ['volume', p.volume],
        ['channel', p.channel],
        ['fulfilment', p.fulfiller],
        ['days to cash', p.daysToCash],
      ]
        .map(([name, f]) => `${name as string}: ${(f as PathFact).status === 'UNKNOWN' ? 'nothing on record' : quote((f as PathFact).basis)}`)
        .join('; ')
    : 'nothing on record';
  return `Independent review. Objective: ${input.objective}. Offer: "${titleOf(leg)}". Evidence on record — ${facts}. ${ask} Answer from sources you open yourself, each with its URL; say UNKNOWN where no source settles it.`.slice(0, 900);
}

function skeptic(input: CommitteeInput): Bench {
  const b = new Bench('SKEPTIC', input);
  for (const leg of input.evidence.legs) {
    const p = leg.pathway;
    // A counted leg with no transaction record is judged by nobody: on a final plan that is an open question, never a pass.
    if (!p && leg.scope === 'COUNTED' && input.tier === 'FULL') b.ask({ opportunityId: null, fact: 'mechanism', subject: `SKEPTIC: no evidence record for ${leg.opportunityId}`, question: `The plan counts ${leg.opportunityId}, and no transaction record of its buyer, price, volume or delivery was read.` });
    if (!p) continue;
    const price = p.revenuePerDeal;
    // What the money is, re-read from the evidence sentence and the offer's own words, not from the planner's status.
    const nature = paymentNatureOf([p.title, price.basis, typeof p.buyer.value === 'string' ? p.buyer.value : ''].join('. '));
    if (nature.nature !== 'PURCHASE' || has(leg, 'NOT_A_PURCHASE')) {
      b.fail({
        claim: `"${titleOf(leg)}" is counted at ${num(price.value) ?? num(price.high) ?? 'an unstated'} a deal`,
        evidenceRef: refOf(leg, 'price', price),
        why: nature.nature !== 'PURCHASE' ? `its money is ${nonPurchaseSentence(nature)}` : 'its only figure is not a purchase price (the commercial reality check read it so)',
        critical: true,
        opportunityId: leg.opportunityId,
        fact: 'price',
      });
    } else if (EVIDENCED(price) && !evidenceIsAbout(price.basis, [p.title, typeof p.buyer.value === 'string' ? p.buyer.value : '', typeof p.offer.value === 'string' ? p.offer.value : ''].join(' '))) {
      b.fail({ claim: `"${titleOf(leg)}" is priced from established evidence`, evidenceRef: refOf(leg, 'price', price), why: 'the price evidence names another market: none of its words is this buyer, this offer or its industry', critical: true, opportunityId: leg.opportunityId, fact: 'price' });
    }
    // Two of the planner's own readings of one price that disagree are a contradiction in the evidence.
    const held = leg.demand && !leg.demand.unestablished.includes('price') ? leg.demand.price.p50 : null;
    const stated = EVIDENCED(price) ? num(price.value) : null;
    if (held !== null && stated !== null && held > 0 && stated > 0 && Math.max(held, stated) > 2 * Math.min(held, stated)) {
      b.fail({ claim: `"${titleOf(leg)}" has one established price`, evidenceRef: refOf(leg, 'price', price), why: `the transaction model holds ${stated} a deal and the simulation draws ${Math.round(held)}: two readings of one price more than twofold apart`, critical: true, opportunityId: leg.opportunityId, fact: 'price' });
    }
    // An invented market: a constructed design counted in the plan with no buyer of its kind found.
    if (leg.scope === 'COUNTED' && p.origin === 'CONSTRUCTED' && !EVIDENCED(p.buyer)) {
      b.fail({ claim: `the plan counts "${titleOf(leg)}"`, evidenceRef: refOf(leg, 'buyer', p.buyer), why: 'it is a constructed design: no buyer of this kind has been found, so its market is an assumption', critical: false, opportunityId: leg.opportunityId, fact: 'buyer' });
    }
  }
  // The existing independent model challenge is this role's specialist layer.
  const mc = input.claims.modelChallenge;
  if (mc?.verdict === 'REVISE') b.fail({ claim: 'the plan as the optimizer holds it', evidenceRef: 'portfolio.assurance.challenge.modelChallenge', why: 'the independent model challenge answered REVISE', critical: false, opportunityId: null, fact: 'mechanism' });
  // A due challenge holds a plan that rests on the simulation; an acceptance on this Brain's measured record of real outcomes already has its independent check.
  else if (mc?.required && mc.due && input.tier === 'FULL' && input.claims.probability?.basis === 'MEASURED_RECORD') b.cite('the independent model challenge has not answered; the acceptance rests on the measured record of real outcomes');
  else if (mc?.required && mc.due && input.tier === 'FULL') b.ask({ opportunityId: null, fact: 'mechanism', subject: 'SKEPTIC: the independent model challenge', question: 'The plan earns a deep review and the independent model challenge has not answered.' });
  return b;
}

function marketExpert(input: CommitteeInput): Bench {
  const b = new Bench('MARKET_EXPERT', input);
  for (const leg of input.evidence.legs) {
    const p = leg.pathway;
    if (!p) continue;
    const buyer = typeof p.buyer.value === 'string' ? p.buyer.value : null;
    const deals = dealsCounted(leg);
    // One organisation is one buyer: many deals from it need evidence it buys again. Critical wherever it is counted or presented.
    if (has(leg, 'ONE_PAYER_REPEATS') || (buyer && namesOneOrganisation(buyer) && deals > 1 && !EVIDENCED(p.volume))) {
      b.fail({ claim: `"${titleOf(leg)}" is modelled at up to ${Math.round(Math.max(deals, num(p.volume.high) ?? 1))} deals`, evidenceRef: refOf(leg, 'volume', p.volume), why: `"${(buyer ?? 'its payer').slice(0, 60)}" is one organisation, and nothing shows it buys more than once`, critical: true, opportunityId: leg.opportunityId, fact: 'volume' });
    }
    if (leg.scope !== 'COUNTED') continue;
    // A constructed design's buyer kind is the SKEPTIC's (an invented market); a found opening's buyer is this role's.
    if (p.buyer.status === 'UNKNOWN' || has(leg, 'NO_BUYER', 'SUPPLY_WITHOUT_BUYER')) b.fail({ claim: `the plan sells "${titleOf(leg)}"`, evidenceRef: refOf(leg, 'buyer', p.buyer), why: 'no paying buyer is identified', critical: false, opportunityId: leg.opportunityId, fact: 'buyer' });
    else if (EVIDENCED(p.buyer)) b.ok(leg, 'buyer', refOf(leg, 'buyer', p.buyer));
    else if (p.origin === 'FOUND') b.ask({ opportunityId: leg.opportunityId, fact: 'buyer', subject: `MARKET_EXPERT: who pays for "${titleOf(leg)}"`, question: specialistQuestion(input.evidence, leg, 'Who are the paying buyers of this offer, by name or by a population a list can be built from?') });
    if (p.revenuePerDeal.status === 'UNKNOWN') b.fail({ claim: `"${titleOf(leg)}" earns money a deal`, evidenceRef: refOf(leg, 'price', p.revenuePerDeal), why: 'nothing shows these buyers paying any price for it', critical: false, opportunityId: leg.opportunityId, fact: 'price' });
    else if (p.revenuePerDeal.status === 'ESTIMATED') b.ask({ opportunityId: leg.opportunityId, fact: 'price', subject: `MARKET_EXPERT: what buyers of "${titleOf(leg)}" pay`, question: specialistQuestion(input.evidence, leg, 'What do these buyers actually pay for this offer, per purchase?') });
    else b.ok(leg, 'price', refOf(leg, 'price', p.revenuePerDeal));
    if (deals > 1) {
      if (p.volume.status === 'UNKNOWN' || has(leg, 'VOLUME_UNEVIDENCED', 'SMALL_TICKET_VOLUME_UNKNOWN'))
        b.fail({ claim: `the plan counts up to ${Math.round(deals)} deals of "${titleOf(leg)}"`, evidenceRef: refOf(leg, 'volume', p.volume), why: 'nothing establishes that many purchases: the reachable demand and how often buyers repeat are unknown', critical: false, opportunityId: leg.opportunityId, fact: 'volume' });
      else if (p.volume.status === 'ESTIMATED') b.ask({ opportunityId: leg.opportunityId, fact: 'volume', subject: `MARKET_EXPERT: how many buyers of "${titleOf(leg)}" buy`, question: specialistQuestion(input.evidence, leg, 'How many distinct buyers of this kind buy this inside the window, how often do they repeat, and who already sells it to them?') });
      else b.ok(leg, 'volume', refOf(leg, 'volume', p.volume));
    }
  }
  return b;
}

function operator(input: CommitteeInput): Bench {
  const b = new Bench('OPERATOR', input);
  const daysLeft = input.evidence.daysLeft;
  for (const leg of input.evidence.legs) {
    const p = leg.pathway;
    if (!p || leg.scope !== 'COUNTED') continue;
    if (p.channel.status === 'UNKNOWN' || has(leg, 'NO_CHANNEL')) b.fail({ claim: `the plan reaches the buyers of "${titleOf(leg)}"`, evidenceRef: refOf(leg, 'channel', p.channel), why: 'no way to reach the buyers is established', critical: false, opportunityId: leg.opportunityId, fact: 'channel' });
    else b.ok(leg, 'channel', refOf(leg, 'channel', p.channel));
    if (p.offer.status === 'UNKNOWN' || has(leg, 'NO_OFFER')) b.fail({ claim: `the plan offers "${titleOf(leg)}"`, evidenceRef: refOf(leg, 'offer', p.offer), why: 'no specific offer is stated', critical: false, opportunityId: leg.opportunityId, fact: 'fulfilment' });
    if (p.fulfiller.status === 'UNKNOWN' || has(leg, 'NO_SUPPLIER')) b.fail({ claim: `"${titleOf(leg)}" is delivered`, evidenceRef: refOf(leg, 'fulfilment', p.fulfiller), why: 'nobody is named to deliver it', critical: false, opportunityId: leg.opportunityId, fact: 'fulfilment' });
    else b.ok(leg, 'fulfilment', refOf(leg, 'fulfilment', p.fulfiller));
    const settleLow = EVIDENCED(p.daysToCash) ? (num(p.daysToCash.low) ?? num(p.daysToCash.value)) : null;
    if (daysLeft !== null && settleLow !== null && settleLow > daysLeft)
      b.fail({ claim: `"${titleOf(leg)}" pays inside the window`, evidenceRef: refOf(leg, 'payment', p.daysToCash), why: `its money arrives after ${settleLow} days, past the ${daysLeft} days left`, critical: true, opportunityId: leg.opportunityId, fact: 'payment' });
    else if (EVIDENCED(p.daysToCash)) b.ok(leg, 'payment', refOf(leg, 'payment', p.daysToCash));
    else b.ask({ opportunityId: leg.opportunityId, fact: 'payment', subject: `OPERATOR: when buyers of "${titleOf(leg)}" pay`, question: specialistQuestion(input.evidence, leg, 'How and when is the money collected — at order, on delivery, on invoice terms — and how many days from a yes to usable cash?') });
    if (p.permissionsMissing.length > 0) b.cite(`${leg.opportunityId}#permissions: waits on ${p.permissionsMissing.slice(0, 4).join(', ')}`);
  }
  return b;
}

function investor(input: CommitteeInput): Bench {
  const b = new Bench('INVESTOR', input);
  const { capitalCeiling, currency } = input.evidence;
  const counted = input.evidence.legs.filter((l) => l.scope === 'COUNTED');
  let tied = 0;
  for (const leg of counted) {
    const p = leg.pathway;
    const atStart = leg.demand?.capitalAtStart ?? (p && EVIDENCED(p.capital) ? (num(p.capital.low) ?? 0) : 0);
    tied += atStart;
    if (p) {
      const priceLow = num(p.revenuePerDeal.low) ?? num(p.revenuePerDeal.value);
      const costHigh = (num(p.fulfilmentCost.high) ?? num(p.fulfilmentCost.value) ?? 0) + (num(p.acquisitionCost.value) ?? 0);
      if (EVIDENCED(p.revenuePerDeal) && priceLow !== null && priceLow - costHigh <= 0)
        b.fail({ claim: `"${titleOf(leg)}" makes money a deal`, evidenceRef: refOf(leg, 'economics', p.fulfilmentCost), why: `at its lowest evidenced price (${priceLow}) and highest cost (${Math.round(costHigh * 100) / 100}) one deal loses money`, critical: true, opportunityId: leg.opportunityId, fact: 'economics' });
      else if (priceLow !== null) b.ok(leg, 'economics', refOf(leg, 'economics', p.fulfilmentCost));
    }
  }
  if (capitalCeiling !== null && tied > capitalCeiling + 1e-6)
    b.fail({ claim: `the plan ties up ${money(tied, currency)} at the start`, evidenceRef: 'target.capitalCeiling', why: `over the ${money(capitalCeiling, currency)} the owner allowed`, critical: true, opportunityId: null, fact: 'capital' });
  else b.cite(`capital tied up at start ${money(tied, currency)}${capitalCeiling !== null ? ` within ${money(capitalCeiling, currency)}` : ''}`);
  // Concentration: the money a person reads resting almost wholly on one leg whose price or volume nobody established.
  const all = input.evidence.legs.filter((l) => l.pathway);
  const total = all.reduce((s, l) => s + Math.max(0, l.pathway!.contribution.p50), 0);
  for (const leg of all) {
    const p = leg.pathway!;
    const share = total > 0 ? Math.max(0, p.contribution.p50) / total : 0;
    if (all.length > 1 && share >= 0.8 && (!EVIDENCED(p.revenuePerDeal) || (dealsCounted(leg) > 1 && !EVIDENCED(p.volume))))
      b.fail({ claim: `${Math.round(share * 100)}% of the plan's expected money comes from "${titleOf(leg)}"`, evidenceRef: refOf(leg, EVIDENCED(p.revenuePerDeal) ? 'volume' : 'price', EVIDENCED(p.revenuePerDeal) ? p.volume : p.revenuePerDeal), why: 'one leg whose price or volume is not established carries the plan: its failure takes the plan with it', critical: false, opportunityId: leg.opportunityId, fact: EVIDENCED(p.revenuePerDeal) ? 'volume' : 'price' });
  }
  const kept = input.claims.keptP50;
  if (kept !== null && kept < 0) b.fail({ claim: 'the plan keeps money after its costs', evidenceRef: 'portfolio.best.keptP50', why: `its median outcome keeps ${money(kept, currency)}: a loss`, critical: true, opportunityId: null, fact: 'economics' });
  return b;
}

/** The most the legs' original evidence supports, at its favourable end: evidenced price × evidenced deals − cost. Pure. */
export function evidencedReach(legs: readonly CommitteeLeg[]): { total: number; byLeg: Array<{ opportunityId: string; deals: number; net: number; amount: number }> } {
  const byLeg = legs
    .filter((l) => l.pathway)
    .map((leg) => {
      const p = leg.pathway!;
      const priceOk = EVIDENCED(p.revenuePerDeal) && !(leg.demand?.unestablished.includes('price') ?? false) && !has(leg, 'NOT_A_PURCHASE');
      const priceHigh = priceOk ? (num(p.revenuePerDeal.high) ?? num(p.revenuePerDeal.value) ?? 0) : 0;
      const costLow = num(p.fulfilmentCost.low) ?? num(p.fulfilmentCost.value) ?? 0;
      // One deal needs its buyer; a second needs evidence of the volume (§116).
      const deals = EVIDENCED(p.volume) && !has(leg, 'ONE_PAYER_REPEATS') ? Math.max(1, num(p.volume.high) ?? num(p.volume.value) ?? 1) : EVIDENCED(p.buyer) ? 1 : 0;
      const net = Math.max(0, priceHigh - costLow);
      return { opportunityId: leg.opportunityId, deals, net, amount: deals * net };
    });
  return { total: byLeg.reduce((s, x) => s + x.amount, 0), byLeg };
}

function quant(input: CommitteeInput): Bench {
  const b = new Bench('QUANT', input);
  const { remaining, currency } = input.evidence;
  const c = input.claims;
  // 1. Reconstruct from the original evidence and set it against what the reading presents.
  const rebuilt = evidencedReach(input.evidence.legs);
  const presented = Math.max(c.presentedHigh ?? 0, c.settledP50 ?? 0);
  const claimsReach = (c.reach ?? 0) > 0 || presented >= remaining - 1e-6;
  b.cite(`reconstructed from evidence: ${rebuilt.byLeg.filter((x) => x.amount > 0).map((x) => `${x.opportunityId} ${x.deals}×${Math.round(x.net)}`).join(' + ') || 'nothing'} = ${money(rebuilt.total, currency)} against ${money(remaining, currency)} remaining`);
  if (remaining > 0 && claimsReach && rebuilt.total < remaining - 1e-6) {
    b.fail({
      claim: `the reading presents ${c.reach !== null && c.reach > 0 ? `a ${Math.round(c.reach * 1000) / 10}% reach` : ''}${c.reach !== null && c.reach > 0 && presented > 0 ? ' and ' : ''}${presented > 0 ? `up to ${money(presented, currency)}` : ''} toward ${money(remaining, currency)}`,
      evidenceRef: `reconstruction: ${rebuilt.byLeg.filter((x) => x.amount > 0).map((x) => `${x.opportunityId} ${x.deals} deal(s) × ${Math.round(x.net)}`).join(' + ') || 'no leg has an evidenced price and buyer'}`,
      why: `rebuilt from proven facts alone (a proven price × a proven deal count − cost, one deal where only the buyer is proven) the legs bring at most ${money(rebuilt.total, currency)}: the rest of the figure rests on prices or volumes nobody established, which the simulation's figures assume`,
      critical: true,
      opportunityId: null,
      fact: 'reach',
    });
  } else if (remaining > 0) b.cite(`proven facts alone support ${money(rebuilt.total, currency)} (a proven price × a proven deal count − cost); any larger figure in the reading assumes the rest`);
  // 2. A probability only from evidence: a coverage figure is never one.
  const unestablished = input.evidence.legs.filter((l) => l.scope === 'COUNTED' && (l.demand?.unestablished.length ?? 1) > 0);
  if ((c.reachBasis === 'PROBABILITY' || (c.probability && c.probability.basis === 'EVIDENCED_PORTFOLIO')) && (c.portfolioBasis !== 'PROBABILITY' || unestablished.length > 0))
    b.fail({ claim: `a ${Math.round((c.probability?.value ?? c.reach ?? 0) * 1000) / 10}% probability`, evidenceRef: unestablished[0] ? `${unestablished[0].opportunityId}#inputs: unestablished ${unestablished[0].demand?.unestablished.slice(0, 4).join(', ') ?? 'all'}` : 'portfolio.basis: COVERAGE', why: 'a share of simulated worlds over inputs nobody established is coverage of assumptions, not a probability', critical: true, opportunityId: null, fact: 'probability' });
  // 3. The estimators against each other: the outcome's adverse case and the pathway portfolio's low end.
  if (c.adverse !== null && c.pathwayP10 !== null && remaining > 0) {
    const a = Math.min(c.adverse, remaining);
    const p = Math.min(c.pathwayP10, remaining);
    const ref = `objective.outcome.adverse=${Math.round(c.adverse)} vs pathways.leading.net.p10=${Math.round(c.pathwayP10)}`;
    // The higher of two disagreeing downsides is a defect only when the evidence does not rebuild it: an agreed deal the
    // pathway ranking leaves out makes the outcome's floor higher, and the evidence carries it.
    if (Math.max(a, p) > 2 * Math.min(a, p) && Math.abs(a - p) > 0.1 * remaining) {
      if (Math.max(a, p) > rebuilt.total + 1e-6)
        b.fail({ claim: `a downside of ${money(Math.max(a, p), currency)}`, evidenceRef: ref, why: `the plan's two downside estimators disagree by more than twofold and a tenth of the gap, and the higher is more than the evidence rebuilds (${money(rebuilt.total, currency)})`, critical: false, opportunityId: null, fact: 'reach' });
      else b.cite(`downside estimators disagree (${ref}); the evidence rebuilds the higher`);
    }
  }
  // 4. Each counted leg's price as the simulation holds it, against the transaction model's.
  for (const leg of input.evidence.legs) {
    if (leg.scope !== 'COUNTED' || !leg.pathway || !leg.demand) continue;
    if (EVIDENCED(leg.pathway.revenuePerDeal) && leg.demand.unestablished.includes('price'))
      b.fail({ claim: `"${titleOf(leg)}" is priced at ${num(leg.pathway.revenuePerDeal.value)}`, evidenceRef: refOf(leg, 'price', leg.pathway.revenuePerDeal), why: 'the simulation holds this price as unestablished: the evidence behind it is contradicted or incomplete', critical: false, opportunityId: leg.opportunityId, fact: 'price' });
    else if (!leg.demand.unestablished.includes('price')) b.ok(leg, 'price', `${leg.opportunityId}#price (simulation input): established`);
  }
  return b;
}

function ownerProxy(input: CommitteeInput): Bench {
  const b = new Bench('OWNER_PROXY', input);
  const counted = input.evidence.legs.filter((l) => l.scope === 'COUNTED' && l.pathway);
  for (const leg of input.evidence.legs) {
    const p = leg.pathway;
    if (!p) continue;
    const repeatable = leg.demand?.repeatable ?? false;
    // Speculation dressed as a repeatable business: a one-off award or one payer counted as a run of sales.
    if (repeatable && (has(leg, 'NOT_A_PURCHASE') || has(leg, 'ONE_PAYER_REPEATS')))
      b.fail({ claim: `"${titleOf(leg)}" is counted as repeatable business`, evidenceRef: refOf(leg, 'mechanism', p.revenuePerDeal), why: has(leg, 'NOT_A_PURCHASE') ? 'its money is a one-off payout, not a sale anyone repeats' : 'its one payer is not a market that repeats', critical: true, opportunityId: leg.opportunityId, fact: 'mechanism' });
    if (leg.scope !== 'COUNTED') continue;
    const who = `${typeof p.fulfiller.value === 'string' ? p.fulfiller.value : ''} ${p.fulfiller.basis}`;
    if (OWNER.test(who) && dealsCounted(leg) > 1)
      b.fail({ claim: `"${titleOf(leg)}" is delivered ${Math.round(dealsCounted(leg))} times`, evidenceRef: refOf(leg, 'fulfilment', p.fulfiller), why: 'the owner delivers every one: routine owner work, not a business that runs without him', critical: false, opportunityId: leg.opportunityId, fact: 'fulfilment' });
  }
  if (counted.length > 0 && counted.every((l) => l.pathway!.origin === 'CONSTRUCTED'))
    b.fail({ claim: 'the plan rests on its counted legs', evidenceRef: counted.map((l) => `${l.opportunityId}#origin: constructed`).join('; ').slice(0, 300), why: 'every counted leg is a constructed design with no buyer found: speculation, not strong commercial evidence', critical: false, opportunityId: null, fact: 'mechanism' });
  // The goal reached at all, on what the evidence supports.
  const rebuilt = evidencedReach(counted);
  if (input.evidence.remaining > 0 && counted.length > 0 && rebuilt.total < input.evidence.remaining - 1e-6)
    b.fail({ claim: input.evidence.objective, evidenceRef: `reconstruction of the counted legs: ${money(rebuilt.total, input.evidence.currency)}`, why: `on proven facts alone (a proven price × a proven deal count − cost) the counted legs' evidence supports ${money(rebuilt.total, input.evidence.currency)} of the ${money(input.evidence.remaining, input.evidence.currency)} the goal needs; the simulation's larger figures rest on assumed prices and volumes`, critical: false, opportunityId: null, fact: 'reach' });
  else if (counted.length > 0) b.cite(`the counted legs' evidence supports ${money(rebuilt.total, input.evidence.currency)} of ${money(input.evidence.remaining, input.evidence.currency)}`);
  return b;
}

const ROLE_OF: Record<CommitteeRole, (input: CommitteeInput) => Bench> = {
  SKEPTIC: skeptic,
  INVESTOR: investor,
  OPERATOR: operator,
  MARKET_EXPERT: marketExpert,
  QUANT: quant,
  OWNER_PROXY: ownerProxy,
};

/** One role on its own, for its own unit tests. Pure. */
export function reviewRole(role: CommitteeRole, input: CommitteeInput): RoleVerdict {
  return ROLE_OF[role](input).verdict();
}

/**
 * The committee over one reading's evidence. Each role judges alone (none reads
 * another's verdict); the verdicts are then combined without a vote: any FAIL
 * fails, a critical defect blocks, and on a final plan an unsettled role keeps
 * it a candidate. Disputed facts become investigations.
 *
 * Research answers to the roles' own questions are read inside each role
 * (`Bench.ask`). The specialist pass, when it applies (`specialistsApply`), is
 * combined per role by `withSpecialist`: a model can add a FAIL, can turn a
 * PASS into UNKNOWN, and can never turn a FAIL or an UNKNOWN into a PASS; an
 * unanswered specialist is UNKNOWN. Pure.
 */
export function reviewPlan(input: CommitteeInput, context: Omit<CommitteeContext, 'answers'> = {}): CommitteeReading {
  // Each role sees its own copy of the inputs: nothing one writes can reach another, and none reads another's verdict.
  const benches = COMMITTEE_ROLES.map((role) => ROLE_OF[role](structuredClone(input)));
  const fingerprint = committeeFingerprint(input);
  const applies = specialistsApply(input.tier, context.specialistsAvailable ?? false);
  const review = applies ? ((context.specialistReviews ?? []).find((r) => r.fingerprint === fingerprint) ?? null) : null;
  const roles = benches.map((b) => {
    const own = b.verdict();
    return applies ? withSpecialist(own, review?.findings.find((f) => f.role === own.role) ?? null) : own;
  });
  const judged = new Map<string, { established: CommitteeRole[]; broken: CommitteeRole[] }>();
  for (const b of benches) for (const [key, ok] of b.judged) entry(judged, key)[ok ? 'established' : 'broken'].push(b.role);
  const investigations: CommitteeInvestigation[] = [];
  for (const [key, v] of judged) {
    const established = [...new Set(v.established)];
    const broken = [...new Set(v.broken)];
    if (established.length === 0 || broken.length === 0) continue;
    const [opportunityId, fact] = key.split('|') as [string, CommitteeFact];
    const leg = input.evidence.legs.find((l) => l.opportunityId === opportunityId);
    const why = roles.flatMap((r) => r.defects.filter((d) => d.opportunityId === opportunityId && d.fact === fact).map((d) => `${r.role}: ${d.why}`)).join('; ');
    investigations.push({
      opportunityId,
      fact,
      established,
      broken,
      question: leg
        ? specialistQuestion(input.evidence, leg, `The ${fact} of this offer is disputed (${established.join(', ')} read it as established; ${why.slice(0, 240)}). Which is true, from primary sources?`)
        : `The ${fact} of ${opportunityId} is disputed: ${why.slice(0, 400)}`,
    });
  }
  const failing = roles.filter((r) => r.verdict === 'FAIL');
  const unknown = roles.filter((r) => r.verdict === 'UNKNOWN');
  const criticalDefects = roles.reduce((s, r) => s + r.defects.filter((d) => d.critical).length, 0);
  const verdict: CommitteeVerdict = failing.length > 0 ? 'FAIL' : unknown.length > 0 ? 'UNKNOWN' : 'PASS';
  const first = roles.flatMap((r) => r.defects.map((d) => ({ r, d }))).sort((a, b) => Number(b.d.critical) - Number(a.d.critical))[0];
  const blocks = verdict === 'FAIL' || criticalDefects > 0 || (input.tier === 'FULL' && verdict === 'UNKNOWN');
  const blocker = first
    ? `${first.r.role}${first.d.critical ? ' (critical)' : ''}: ${first.d.claim} — ${first.d.why} [${first.d.evidenceRef.slice(0, 160)}]`
    : unknown[0]?.open[0]
      ? `${unknown[0].role} could not settle ${unknown[0].open[0].subject.replace(/^[A-Z_]+: /, '')}; a specialist review is asked`
      : null;
  const specialists: CommitteeReading['specialists'] = !applies
    ? { state: 'NOT_RUN', reviewedAt: null, models: [] }
    : review
      ? { state: 'BOUND', reviewedAt: review.reviewedAt, models: [...new Set(review.findings.map((f) => f.model).filter((m): m is string => !!m))] }
      : { state: 'PENDING', reviewedAt: null, models: [] };
  const answered = roles.reduce((s, r) => s + r.settled.length, 0);
  return { tier: input.tier, reviewed: input.evidence.legs.map((l) => l.opportunityId), roles, verdict, criticalDefects, blocks, blocker, investigations, fingerprint, specialists, answered };
}

/**
 * Whether the specialist pass applies: a FULL review (a final plan or a material
 * commitment) with a specialist model configured. A routine review, or one with
 * no model configured, is the deterministic committee alone (NOT_RUN on the
 * record) — the pass is bounded and optional, never a reason a plan cannot be
 * read where no model is reachable. Pure.
 */
export function specialistsApply(tier: CommitteeInput['tier'], available: boolean): boolean {
  return tier === 'FULL' && available;
}

/**
 * The identity of the plan a specialist read: the objective, the evidence and
 * the planner's figures, without the research answers. A plan whose figures
 * changed is a different plan, and a review of one never binds another. Pure.
 */
export function committeeFingerprint(input: CommitteeInput): string {
  const { answers: _answers, ...plan } = input;
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 24);
}

/**
 * One role's verdict with its specialist's reading combined, without a vote:
 *   - the role's own FAIL stands whatever the model says (its critical defects
 *     included); the model's cited defects are added beside them;
 *   - a model FAIL with cited defects fails a PASS or an UNKNOWN role (its
 *     defects are never critical: only the role's code declares one);
 *   - a model UNKNOWN — no answer, a timeout, a FAIL without a cited defect —
 *     makes a PASS role UNKNOWN: an unanswered specialist is never a pass;
 *   - a model PASS never settles what the role left UNKNOWN: only evidence does.
 * `finding` null means the pass is due and has not answered. Pure.
 */
export function withSpecialist(own: RoleVerdict, finding: SpecialistFinding | null): RoleVerdict {
  const f: SpecialistFinding = finding ?? { role: own.role, verdict: 'UNKNOWN', defects: [], citations: [], model: null, reason: 'the independent specialist review has not answered yet' };
  const out: RoleVerdict = { ...own, defects: [...own.defects], citations: [...own.citations], open: [...own.open], specialist: f };
  if (f.verdict === 'FAIL' && f.defects.length > 0) {
    for (const d of f.defects) if (!out.defects.some((x) => x.opportunityId === d.opportunityId && x.fact === d.fact && x.why === d.why)) out.defects.push({ ...d, critical: false, source: 'MODEL' });
    out.verdict = 'FAIL';
  } else if (f.verdict !== 'PASS' && out.verdict === 'PASS') {
    const subject = `${own.role}: the independent specialist review`;
    out.open.push({ role: own.role, opportunityId: null, fact: 'mechanism', subject, question: f.reason ?? 'The specialist did not settle it.', research: committeeResearchSubject(subject) });
    out.verdict = 'UNKNOWN';
  }
  if (f.verdict === 'PASS' && f.model) out.citations.push(`specialist ${f.model}: PASS`);
  out.citations = out.citations.slice(0, 12);
  out.critical = out.defects.some((d) => d.critical);
  return out;
}

function entry(m: Map<string, { established: CommitteeRole[]; broken: CommitteeRole[] }>, key: string) {
  let e = m.get(key);
  if (!e) m.set(key, (e = { established: [], broken: [] }));
  return e;
}

/**
 * Which review a reading earns: FULL for a final commercial plan (an acceptance
 * that is not the ledger's own) or a material commitment of capital (at least a
 * tenth of the remaining target, or $250), ROUTINE otherwise. Pure.
 */
export function committeeTier(input: { accepted: boolean; targetMet: boolean; capitalCommitted: number; remaining: number }): 'ROUTINE' | 'FULL' {
  if (input.accepted && !input.targetMet) return 'FULL';
  return input.capitalCommitted >= Math.max(250, 0.1 * input.remaining) ? 'FULL' : 'ROUTINE';
}

/** The committee's specialist questions and investigations as needs for the existing owner (`sendNeeds`). Pure. */
export function committeeNeeds(reading: CommitteeReading): Need[] {
  if (reading.tier !== 'FULL' && reading.investigations.length === 0) return [];
  const asks = reading.tier === 'FULL' ? reading.roles.flatMap((r) => r.open.filter((q) => q.opportunityId !== null)) : [];
  return [
    ...reading.investigations.map((i) => ({ subject: `committee dispute: ${i.fact} of ${i.opportunityId}`, question: i.question, route: 'RESEARCH' as const, permissions: [] })),
    ...asks.map((q) => ({ subject: q.research ?? committeeResearchSubject(q.subject), question: q.question, route: 'RESEARCH' as const, permissions: [] })),
  ];
}

/** The committee as the lines a terminal prints. Pure. */
export function committeeLines(c: CommitteeReading): string[] {
  const out = [`  committee   ${c.verdict} (${c.tier.toLowerCase()} review, ${c.reviewed.length} leg(s), ${c.criticalDefects} critical defect(s)${c.reviewMs !== undefined ? `, ${c.reviewMs} ms` : ''})${c.blocks ? ' — blocks acceptance' : ''}`];
  for (const r of c.roles) {
    out.push(`    ${r.role.padEnd(13)} ${r.verdict}${r.critical ? ' CRITICAL' : ''}`);
    for (const d of r.defects.slice(0, 3)) out.push(`      - ${d.critical ? '[critical] ' : ''}${d.claim.slice(0, 120)} — ${d.why.slice(0, 200)} [${d.evidenceRef.slice(0, 140)}]`);
    for (const q of r.open.slice(0, 2)) out.push(`      ? ${q.subject.slice(0, 160)}${q.answeredBy?.length ? ` (research answered, not settled: ${q.answeredBy.slice(0, 3).join(', ')})` : ''}`);
    for (const s of (r.settled ?? []).filter((x) => x.outcome !== 'UNKNOWN').slice(0, 2)) out.push(`      = ${s.subject.slice(0, 120)}: research ${s.outcome} — ${s.why.slice(0, 160)} [${s.claimIds.slice(0, 3).join(', ')}]`);
    if (r.specialist) out.push(`      specialist ${r.specialist.verdict}${r.specialist.model ? ` (${r.specialist.model})` : ''}${r.specialist.reason ? ` — ${r.specialist.reason.slice(0, 160)}` : ''}`);
  }
  if (c.specialists && c.specialists.state !== 'NOT_RUN') out.push(`    specialists ${c.specialists.state.toLowerCase()}${c.specialists.reviewedAt ? ` (${c.specialists.reviewedAt})` : ''}`);
  for (const i of c.investigations.slice(0, 3)) out.push(`    dispute     ${i.fact} of ${i.opportunityId}: ${i.established.join(', ')} vs ${i.broken.join(', ')}`);
  return out;
}

/**
 * The committee's input from a plan reading: the legs the plan counts (accepted,
 * else candidate) and the legs whose money the reading presents (the quant
 * engine's best combination, the pathway portfolio's leading one), each with its
 * transaction facts and simulation inputs. The planner's acceptance status,
 * verdict and sentences are not read — only whether it is a final plan, which
 * sets the tier. Pure.
 */
export function committeeInputOf(reading: Pick<PlanReading, 'goalId' | 'target' | 'acceptance' | 'portfolio' | 'pathways' | 'objective'>): CommitteeInput {
  const a = reading.acceptance;
  // A reading built by hand may carry only part of the record: what it lacks is read as nothing, never as favourable.
  const t = reading.target ?? { metricLabel: 'the goal', remainingCents: 0, daysLeft: null, capitalCeilingCents: null, currency: 'USD' };
  const counted = [...new Set(a?.accepted?.opportunityIds?.length ? a.accepted.opportunityIds : (a?.candidate?.opportunityIds ?? []))];
  const presented = [...new Set([...(reading.portfolio?.best?.members?.map((m) => m.opportunityId) ?? []), ...(reading.pathways?.portfolio?.leading?.members ?? [])])].filter((id) => !counted.includes(id));
  const paths = new Map((reading.pathways?.pathways ?? []).map((p) => [p.opportunityId, p]));
  const demand = new Map((reading.portfolio?.demand ?? []).map((d) => [d.opportunityId, d]));
  const FACTS = ['buyer', 'channel', 'offer', 'fulfiller', 'revenuePerDeal', 'fulfilmentCost', 'acquisitionCost', 'volume', 'daysToCash', 'capital'] as const;
  const whole = (p: TransactionPathway | undefined): CommitteeLeg['pathway'] => (p && Array.isArray(p.gaps) && p.contribution && FACTS.every((k) => p[k] && typeof p[k].status === 'string') ? p : null);
  const wholeDemand = (d: DemandEstimate | undefined): CommitteeLeg['demand'] => (d && d.deals && d.price && Array.isArray(d.unestablished) ? d : null);
  const legOf = (opportunityId: string, scope: CommitteeLeg['scope']): CommitteeLeg => ({ opportunityId, scope, pathway: whole(paths.get(opportunityId)), demand: wholeDemand(demand.get(opportunityId)) });
  const remaining = Math.max(0, (t.remainingCents ?? 0) / 100);
  const best = reading.portfolio?.best ?? null;
  const leading = reading.pathways?.portfolio?.leading ?? null;
  // The outcome a person reads as the plan's (`planOutcomeOf`): the supported one whenever the full one is assumption-only.
  // The full combination's outcome: the estimator the pathway portfolio's low end is read against (both over every counted leg).
  const outcome = reading.objective?.outcome ?? null;
  const mc = (reading.portfolio?.assurance as { challenge?: { modelChallenge?: { required: boolean; verdict: 'PROCEED' | 'REVISE' | null; due: boolean } } } | null | undefined)?.challenge?.modelChallenge ?? null;
  const legs = [...counted.map((id) => legOf(id, 'COUNTED')), ...presented.map((id) => legOf(id, 'PRESENTED'))];
  const capitalCommitted = legs.filter((l) => l.scope === 'COUNTED').reduce((s, l) => s + (l.demand?.capitalAtStart ?? 0), 0);
  return {
    evidence: {
      goalId: reading.goalId,
      objective: `${t.metricLabel} of ${money(remaining, t.currency)} more${t.daysLeft != null ? ` within ${t.daysLeft} days` : ''}${t.capitalCeilingCents != null ? `, tying up at most ${money(t.capitalCeilingCents / 100, t.currency)}` : ''}`,
      remaining,
      daysLeft: t.daysLeft ?? null,
      capitalCeiling: t.capitalCeilingCents != null ? t.capitalCeilingCents / 100 : null,
      currency: t.currency ?? 'USD',
      legs,
    },
    claims: {
      reach: a?.candidate?.reach ?? null,
      reachBasis: a?.candidate?.reachBasis ?? null,
      probability: a?.probability ? { value: a.probability.value, lowerBound: a.probability.lowerBound, basis: a.probability.basis } : null,
      portfolioBasis: reading.portfolio?.basis ?? null,
      settledP50: a?.candidate?.settledP50 ?? best?.settledP50 ?? null,
      presentedHigh: Math.max(best?.settledP90 ?? 0, leading?.net?.p90 ?? 0) || null,
      adverse: typeof outcome?.adverse === 'number' ? outcome.adverse : null,
      pathwayP10: leading?.net ? leading.net.p10 : null,
      keptP50: best?.keptP50 ?? null,
      modelChallenge: mc ? { required: !!mc.required, verdict: mc.verdict ?? null, due: !!mc.due } : null,
    },
    tier: committeeTier({ accepted: a?.status === 'ACCEPTED', targetMet: a?.probability?.basis === 'TARGET_MET', capitalCommitted, remaining }),
  };
}

/**
 * The committee over a reading, timed, with what was read back beside it: the
 * research answers to its own questions and the specialist reviews recorded
 * (`committeeContextOf`, committeeSpecialists.ts). Pure but for the clock.
 */
export function committeeOf(reading: Parameters<typeof committeeInputOf>[0], context: CommitteeContext = {}): CommitteeReading {
  const t0 = performance.now();
  const { answers, ...rest } = context;
  const out = reviewPlan({ ...committeeInputOf(reading), ...(answers?.length ? { answers } : {}) }, rest);
  return { ...out, reviewMs: Math.round((performance.now() - t0) * 100) / 100 };
}

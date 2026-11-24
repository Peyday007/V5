/**
 * The investment committee's independent specialist reviewers (§117; owner,
 * 2026-11-23: "independent model-based specialist reviewers").
 *
 * Each of the six roles is read by its own model call: the role's brief, the
 * objective and the original evidence (and, for QUANT, SKEPTIC and INVESTOR,
 * the planner's figures to challenge) — never the acceptance's status, verdict
 * or sentence, and never another role's verdict. The answer is a structured
 * PASS / FAIL / UNKNOWN with cited defects, combined with the role's
 * deterministic layer by `withSpecialist` (committee.ts): a model can add a
 * FAIL and can hold a PASS as UNKNOWN; it can never turn a FAIL or an UNKNOWN
 * into a PASS, its defects are never critical, and a model that fails or times
 * out is UNKNOWN — never a pass.
 *
 * Nothing here is a new routing system (rule 6). The models are the operator's
 * (`modelsFor`), ordered as the existing challenger orders them
 * (`challengerModels`), asked through the same chat call (`chatFor`,
 * `firstJson`) the model challenge uses.
 *
 * Bounded and optional:
 *   - only a FULL review (a final plan or a material commitment) with a model
 *     configured is reviewed (`specialistsApply`); otherwise the committee is
 *     its deterministic layer alone and the record says NOT_RUN — so a Brain,
 *     or a test, with no model reachable reads plans exactly as before;
 *   - once per plan (`committeeFingerprint`): a recorded review binds only the
 *     input it read, and a plan whose figures change is asked again;
 *   - a review some role's model did not answer is asked again no sooner than
 *     `SPECIALIST_RETRY_MS`; at most `SPECIALIST_MAX_IN_FLIGHT` goals at once;
 *     every role's calls end inside `SPECIALIST_ROLE_BUDGET_MS`;
 *   - the plan read never waits for it: the read arms it (`armSpecialistReview`)
 *     and the next read binds the recorded answer.
 *
 * Recorded structurally (invariant 11): each review is a
 * `COMMITTEE_SPECIALIST_REVIEW` workstream event on the goal whose detail is
 * the findings themselves, read back by `committeeContextOf`.
 */
import { COMMITTEE_ROLES, committeeFingerprint, committeeInputOf, type CommitteeContext, type CommitteeDefect, type CommitteeFact, type CommitteeInput, type CommitteeReading, type CommitteeRole, type CommitteeVerdict, type SpecialistFinding, type SpecialistReview } from './committee.ts';
import type { OperatorModel } from '../../domain/operator.ts';
import { chatFor, firstJson } from '../cheap/modelBench.ts';
import { challengerModels } from '../operator/decisions.ts';
import { recordWorkstreamEvent, workstreamEventsOfKind } from '../../repos/register.ts';
import { committeeAnswersOf } from './portfolioNeeds.ts';

/** The workstream event a specialist review is recorded as. */
export const SPECIALIST_EVENT = 'COMMITTEE_SPECIALIST_REVIEW';
/** One role's model calls, together, end inside this. */
export const SPECIALIST_ROLE_BUDGET_MS = 60_000;
/** One model's longest turn at one role. */
export const SPECIALIST_ATTEMPT_MS = 45_000;
/** An attempt with less than this left is not started. */
const SPECIALIST_MIN_ATTEMPT_MS = 5_000;
/** A review some role's model did not answer is asked again no sooner than this. */
export const SPECIALIST_RETRY_MS = 30 * 60_000;
/** Goals whose specialists are being asked at once, across the process. */
export const SPECIALIST_MAX_IN_FLIGHT = 2;
/** How far back a recorded review is read. */
const REVIEW_LOOKBACK_MS = 14 * 24 * 3600_000;

const FACTS: readonly CommitteeFact[] = ['price', 'volume', 'buyer', 'channel', 'fulfilment', 'payment', 'capital', 'economics', 'reach', 'probability', 'mechanism'];

/** What each role judges, in its own words: the brief its model is given. */
const ROLE_BRIEF: Record<CommitteeRole, string> = {
  SKEPTIC: 'Attack the plan: unsupported assumptions, invented markets, money that is not a purchase (a prize, grant, bounty, transfer or wage counted as a price), price evidence about another market, contradictions between figures, weak evidence.',
  INVESTOR: 'Judge capital and downside: capital tied up against the ceiling, deals that lose money, concentration of the expected money on a leg whose price or volume nobody established.',
  OPERATOR: 'Judge execution: is there an established way to reach these buyers, a stated offer, someone named to deliver it, and does the cash arrive inside the days left.',
  MARKET_EXPERT: 'Judge the market: are there identified paying buyers, is the price what these buyers actually pay, is one organisation being counted as a population, is the volume of purchases established.',
  QUANT: "Rebuild the figures from the evidenced prices, costs and deal counts and set them against the planner's figures; a share of simulated worlds over unestablished inputs is coverage, not a probability; compare the downside estimators.",
  OWNER_PROXY: "Judge for the owner: is the goal reached on what the evidence supports, is it fast cash, is it repeatable business rather than a one-off payout dressed as one, does it need the owner's routine personal work.",
};

/** The roles that read the planner's figures, and only to challenge them (committee.ts). */
const READS_CLAIMS = new Set<CommitteeRole>(['QUANT', 'SKEPTIC', 'INVESTOR']);

const factOf = (f: { status: string; value: unknown; low: unknown; high: unknown; basis: string } | null | undefined) =>
  f ? { status: f.status, value: f.value, low: f.low, high: f.high, evidence: f.basis.replace(/\s+/g, ' ').slice(0, 200) } : null;

/**
 * The prompt one role's specialist reads: its brief, the objective and the
 * original evidence; the planner's figures only for the roles that challenge
 * them. No acceptance, verdict or other role's reading is in it. Pure.
 */
export function specialistPrompt(role: CommitteeRole, input: CommitteeInput): string {
  const ev = input.evidence;
  const facts = {
    objective: ev.objective,
    remaining: ev.remaining,
    daysLeft: ev.daysLeft,
    capitalCeiling: ev.capitalCeiling,
    currency: ev.currency,
    legs: ev.legs.map((l) => ({
      id: l.opportunityId,
      scope: l.scope,
      ...(l.pathway
        ? {
            title: l.pathway.title,
            origin: l.pathway.origin,
            buyer: factOf(l.pathway.buyer),
            channel: factOf(l.pathway.channel),
            offer: factOf(l.pathway.offer),
            fulfiller: factOf(l.pathway.fulfiller),
            price: factOf(l.pathway.revenuePerDeal),
            fulfilmentCost: factOf(l.pathway.fulfilmentCost),
            acquisitionCost: factOf(l.pathway.acquisitionCost),
            volume: factOf(l.pathway.volume),
            daysToCash: factOf(l.pathway.daysToCash),
            capital: factOf(l.pathway.capital),
            gaps: l.pathway.gaps,
          }
        : { record: 'no transaction record' }),
      ...(l.demand ? { simulatedDeals: l.demand.deals, simulatedPrice: l.demand.price, unestablished: l.demand.unestablished, capitalAtStart: l.demand.capitalAtStart, repeatable: l.demand.repeatable } : {}),
    })),
  };
  const { modelChallenge: _mc, ...figures } = input.claims;
  return [
    `You are the ${role} on an independent investment committee. ${ROLE_BRIEF[role]}`,
    'Judge only from the facts below. You have not seen, and must not assume, the planner\'s conclusion or any other reviewer\'s.',
    `FACTS: ${JSON.stringify(facts)}`,
    READS_CLAIMS.has(role) ? `PLANNER'S FIGURES (to challenge, not to trust): ${JSON.stringify(figures)}` : '',
    'Reply with exactly one JSON object and nothing else:',
    `{"verdict":"PASS"|"FAIL"|"UNKNOWN","defects":[{"claim":"what the plan claims","evidenceRef":"<leg id>#<fact> or the field you read","why":"exactly why it is a defect","opportunityId":"<leg id> or null","fact":one of ${JSON.stringify(FACTS)}}],"citations":["the evidence you relied on"],"reason":"why, when UNKNOWN"}`,
    'FAIL only with at least one defect that cites the evidence it rests on. UNKNOWN when these facts cannot settle it. PASS only when nothing in your remit is wrong.',
  ]
    .filter(Boolean)
    .join('\n');
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * One model's answer as a finding, or null when it is not one (the next model
 * is asked). A FAIL that cites no well-formed defect is UNKNOWN: an uncited
 * failure is not evidence, and never a pass. Pure.
 */
export function parseSpecialist(obj: Record<string, unknown> | null, role: CommitteeRole, legIds: readonly string[], model: string): SpecialistFinding | null {
  if (!obj) return null;
  const raw = str(obj['verdict'], 16)?.toUpperCase();
  if (raw !== 'PASS' && raw !== 'FAIL' && raw !== 'UNKNOWN') return null;
  const defects: CommitteeDefect[] = [];
  for (const d of Array.isArray(obj['defects']) ? (obj['defects'] as unknown[]).slice(0, 6) : []) {
    if (!d || typeof d !== 'object') continue;
    const r = d as Record<string, unknown>;
    const claim = str(r['claim'], 240);
    const why = str(r['why'], 400);
    const evidenceRef = str(r['evidenceRef'], 240);
    if (!claim || !why || !evidenceRef) continue;
    const id = str(r['opportunityId'], 80);
    const fact = str(r['fact'], 24)?.toLowerCase() as CommitteeFact | undefined;
    defects.push({ claim, why, evidenceRef, critical: false, opportunityId: id && legIds.includes(id) ? id : null, fact: fact && FACTS.includes(fact) ? fact : 'mechanism', source: 'MODEL' });
  }
  const citations = (Array.isArray(obj['citations']) ? (obj['citations'] as unknown[]) : []).map((c) => str(c, 200)).filter((c): c is string => !!c).slice(0, 6);
  let verdict: CommitteeVerdict = raw;
  let reason = verdict === 'UNKNOWN' ? (str(obj['reason'], 300) ?? 'the specialist could not settle it from the evidence') : null;
  if (verdict === 'FAIL' && defects.length === 0) {
    verdict = 'UNKNOWN';
    reason = 'the specialist answered FAIL without citing a defect';
  }
  return { role, verdict, defects: verdict === 'FAIL' ? defects : [], citations, model, reason };
}

export interface SpecialistBounds {
  fetchImpl?: typeof fetch;
  roleBudgetMs?: number;
  attemptMs?: number;
  clock?: () => number;
}

/**
 * Every role read by its own model call, in parallel and each inside its own
 * budget: the first model (in the challenger's order) whose answer parses is
 * the role's specialist; none is UNKNOWN. Never throws.
 */
export async function reviewWithSpecialists(input: CommitteeInput, models: OperatorModel[], bounds: SpecialistBounds = {}): Promise<SpecialistReview> {
  const clock = bounds.clock ?? Date.now;
  const ordered = challengerModels(models);
  const legIds = input.evidence.legs.map((l) => l.opportunityId);
  const one = async (role: CommitteeRole): Promise<SpecialistFinding> => {
    const deadline = clock() + Math.min(SPECIALIST_ROLE_BUDGET_MS, bounds.roleBudgetMs ?? SPECIALIST_ROLE_BUDGET_MS);
    const prompt = specialistPrompt(role, input);
    const failures: string[] = [];
    for (const model of ordered) {
      const left = deadline - clock();
      if (left < SPECIALIST_MIN_ATTEMPT_MS) break;
      const chat = chatFor({ label: model.label, url: model.baseUrl, key: model.apiKey, model: model.model, usdPerHour: null }, bounds.fetchImpl ?? fetch, Math.min(bounds.attemptMs ?? SPECIALIST_ATTEMPT_MS, left));
      const r = await chat(
        [
          { role: 'system', content: 'You are an independent specialist reviewer. Answer with exactly one JSON object.' },
          { role: 'user', content: prompt },
        ],
        undefined,
        1500,
      );
      if (r.error) {
        failures.push(`${model.label}: ${r.error.slice(0, 80)}`);
        continue;
      }
      const parsed = parseSpecialist(firstJson(r.content), role, legIds, model.label);
      if (parsed) return parsed;
      failures.push(`${model.label}: no parseable verdict`);
    }
    return { role, verdict: 'UNKNOWN', defects: [], citations: [], model: null, reason: ordered.length === 0 ? 'no specialist model is configured' : `no specialist model answered within the bound (${failures.join('; ').slice(0, 240) || 'out of time'})` };
  };
  const findings = await Promise.all(COMMITTEE_ROLES.map((role) => one(role).catch((error: unknown): SpecialistFinding => ({ role, verdict: 'UNKNOWN', defects: [], citations: [], model: null, reason: `the specialist call failed: ${String((error as Error)?.message ?? error).slice(0, 160)}` }))));
  return { fingerprint: committeeFingerprint(input), reviewedAt: new Date(clock()).toISOString(), findings };
}

/** A recorded review read back, or null when the row is not one. Pure. */
export function reviewFromDetail(detail: Record<string, unknown>): SpecialistReview | null {
  const fingerprint = str(detail['fingerprint'], 64);
  const reviewedAt = str(detail['reviewedAt'], 40);
  const findings = Array.isArray(detail['findings']) ? (detail['findings'] as SpecialistFinding[]) : null;
  if (!fingerprint || !reviewedAt || !findings) return null;
  const ok = findings.filter((f) => f && COMMITTEE_ROLES.includes(f.role) && (f.verdict === 'PASS' || f.verdict === 'FAIL' || f.verdict === 'UNKNOWN') && Array.isArray(f.defects));
  return { fingerprint, reviewedAt, findings: ok.map((f) => ({ ...f, defects: f.defects.map((d) => ({ ...d, critical: false, source: 'MODEL' as const })) })) };
}

export interface SpecialistDeps {
  /** The models to ask; production: the operator's (`modelsFor`). */
  models?: () => Promise<OperatorModel[]>;
  record?: typeof recordWorkstreamEvent;
  readEvents?: typeof workstreamEventsOfKind;
  answers?: typeof committeeAnswersOf;
  bounds?: SpecialistBounds;
  env?: NodeJS.ProcessEnv;
}

let configured: { at: number; value: boolean } | null = null;

async function operatorModels(): Promise<OperatorModel[]> {
  const { modelsFor } = await import('../operator/run.ts');
  return modelsFor();
}

/**
 * Whether a specialist model is configured: the switch is not off
 * (`BRAIN_COMMITTEE_SPECIALISTS=off`) and the operator has a model. Read at
 * most every five minutes; a failure to read is "not configured".
 */
export async function specialistsConfigured(deps: SpecialistDeps = {}, now = Date.now()): Promise<boolean> {
  const env = deps.env ?? process.env;
  if ((env['BRAIN_COMMITTEE_SPECIALISTS'] ?? '').trim().toLowerCase() === 'off') return false;
  // Neither the free switchboard nor a pod is configured: the operator has no model (`modelsFor`), and nothing is loaded to say so.
  if (!deps.models && !env['BRAIN_CHEAP_LLM_URL']?.trim() && !env['BRAIN_RUNPOD_URL']?.trim()) return false;
  if (!deps.models && configured && now - configured.at < 5 * 60_000) return configured.value;
  const value = await (deps.models ?? operatorModels)()
    .then((m) => m.length > 0)
    .catch(() => false);
  if (!deps.models) configured = { at: now, value };
  return value;
}

/**
 * What the committee reads beside a goal's reading: the research answers to its
 * questions, the specialist reviews recorded for the goal, and whether a
 * specialist is configured. Each part that cannot be read is said in
 * `degraded` and read as nothing — never as favourable.
 */
export async function committeeContextOf(goalId: string, projectId: string, now: Date, deps: SpecialistDeps = {}): Promise<CommitteeContext & { degraded: string[] }> {
  const degraded: string[] = [];
  const answers = await (deps.answers ?? committeeAnswersOf)(projectId, goalId).catch((error: unknown) => {
    degraded.push(`committee research answers: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
    return [];
  });
  const events = await (deps.readEvents ?? workstreamEventsOfKind)(goalId, SPECIALIST_EVENT, new Date(now.getTime() - REVIEW_LOOKBACK_MS).toISOString(), 10).catch((error: unknown) => {
    degraded.push(`committee specialist reviews: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
    return [];
  });
  const specialistReviews = events.map((e) => reviewFromDetail(e.detail)).filter((r): r is SpecialistReview => r !== null);
  const specialistsAvailable = await specialistsConfigured(deps, now.getTime());
  return { answers, specialistReviews, specialistsAvailable, degraded };
}

/**
 * Whether this committee reading should ask its specialists now: the pass
 * applies and no review of this plan is recorded, or the one recorded has a
 * role no model answered and is older than `SPECIALIST_RETRY_MS`. Pure.
 */
export function specialistReviewDue(committee: Pick<CommitteeReading, 'fingerprint' | 'specialists'>, reviews: readonly SpecialistReview[], now: Date): boolean {
  if (committee.specialists.state === 'NOT_RUN') return false;
  if (committee.specialists.state === 'PENDING') return true;
  const bound = reviews.find((r) => r.fingerprint === committee.fingerprint);
  if (!bound) return true;
  return bound.findings.some((f) => f.model === null) && now.getTime() - Date.parse(bound.reviewedAt) >= SPECIALIST_RETRY_MS;
}

const inFlight = new Map<string, Promise<SpecialistReview | null>>();

/**
 * Ask the six specialists about one plan and record the answer on the goal.
 * At most one ask per goal and `SPECIALIST_MAX_IN_FLIGHT` across the process;
 * returns null when it did not ask (busy, or no model) or the record failed.
 * Never throws.
 */
export function startSpecialistReview(goalId: string, input: CommitteeInput, deps: SpecialistDeps = {}): Promise<SpecialistReview | null> {
  const running = inFlight.get(goalId);
  if (running) return running;
  if (inFlight.size >= SPECIALIST_MAX_IN_FLIGHT) return Promise.resolve(null);
  const run = (async (): Promise<SpecialistReview | null> => {
    const models = await (deps.models ?? operatorModels)().catch(() => [] as OperatorModel[]);
    // No model configured is no review, and nothing is recorded: the committee stays its deterministic layer.
    if (models.length === 0) return null;
    const review = await reviewWithSpecialists(input, models, deps.bounds);
    const failed = review.findings.filter((f) => f.verdict === 'FAIL').map((f) => f.role);
    const open = review.findings.filter((f) => f.verdict === 'UNKNOWN').map((f) => f.role);
    await (deps.record ?? recordWorkstreamEvent)({
      workstreamId: goalId,
      kind: SPECIALIST_EVENT,
      summary: `Investment committee specialists: ${failed.length ? `FAIL ${failed.join(', ')}` : 'no FAIL'}${open.length ? `; UNKNOWN ${open.join(', ')}` : ''}`.slice(0, 400),
      detail: { fingerprint: review.fingerprint, reviewedAt: review.reviewedAt, findings: review.findings },
      actorRef: 'BRAIN',
    });
    return review;
  })()
    .catch((error: unknown) => {
      console.warn(`goal ${goalId}: committee specialists: ${String((error as Error)?.message ?? error)}`);
      return null;
    })
    .finally(() => inFlight.delete(goalId));
  inFlight.set(goalId, run);
  return run;
}

/**
 * After a plan read: when the committee's specialist pass is due, ask it in the
 * background (the read never waits); the next read binds the recorded answer.
 * Returns the ask, or null when none is due, for a caller that wants to wait.
 */
export function armSpecialistReview(
  goalId: string,
  reading: Parameters<typeof committeeInputOf>[0],
  committee: Pick<CommitteeReading, 'fingerprint' | 'specialists'> | null | undefined,
  context: Pick<CommitteeContext, 'specialistReviews'>,
  now: Date,
  deps: SpecialistDeps = {},
): Promise<SpecialistReview | null> | null {
  if (!committee || !specialistReviewDue(committee, context.specialistReviews ?? [], now)) return null;
  const input = committeeInputOf(reading);
  // The ask must be about the plan the committee read, or its answer would never bind.
  if (committeeFingerprint(input) !== committee.fingerprint) return null;
  return startSpecialistReview(goalId, input, deps);
}

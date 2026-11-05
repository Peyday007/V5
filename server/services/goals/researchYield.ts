/**
 * What a cash goal's research produced for its plan, and why it fell short.
 *
 * Two halves, both readings over existing rows (§43, invariant 45): nothing
 * here stores state about work whose rows can be read.
 *
 *  - `diagnoseGoalResearch` (pure) reads the plan's own judgement of every
 *    opening it holds and the goal's recent rounds, and names the reasons the
 *    research is not producing openings the plan can use — each with the
 *    instruction the next round is given. `openGoalDiscovery` puts them in the
 *    question, so a search that keeps returning a provider's price page
 *    instead of a buyer is told so and asked differently. The bar does not
 *    move: the gate, harvest and plan judge exactly as before.
 *  - `goalResearchProgress` measures the chain from a research job to the
 *    plan: the goal's research jobs by model (the RunPod GPU among them),
 *    claims accepted on them, openings harvested from them and from which
 *    model's fragment, how many have a buyer and a price the plan accepts, how
 *    many the quant model takes, and the plan's own reach over time.
 */
import { getDb } from '../../db/database.ts';
import type { ChainLink, ConsideredOpening } from './plan.ts';

export const RESEARCH_CAUSES = [
  'RESEARCH_NOT_FINISHING',
  'NO_OPENINGS_REPORTED',
  'NO_BUYER',
  'NO_SUPPORTED_PRICE',
  'TOO_SMALL',
  'OVER_LIMITS',
  'SETTLEMENT_UNKNOWN',
] as const;
export type ResearchCause = (typeof RESEARCH_CAUSES)[number];

export interface ResearchDiagnosis {
  cause: ResearchCause;
  /** What the rows show, in one sentence. */
  evidence: string;
  /** What the next round is asked to do differently. */
  instruction: string;
}

export interface GoalRoundOutcome {
  state: string;
  found: number;
}

/** A share at or above this of the openings held lacking a link names that link as a cause. */
export const CAUSE_SHARE = 0.5;
/** Rounds settled empty (or abandoned) before research itself is named the cause. */
export const BARREN_ROUNDS_FOR_CAUSE = 2;
/** At most this many instructions go into one question, so it stays a question. */
export const MAX_INSTRUCTIONS = 3;

const INSTRUCTION: Record<ResearchCause, string> = {
  RESEARCH_NOT_FINISHING:
    'Recent searches for this goal ended without a report because no claim survived the evidence check, so cite only pages that open without a login or bot wall (official pages, public marketplace listings, public registers) and quote the exact sentence that names the buyer, the work and the price.',
  NO_OPENINGS_REPORTED:
    'Recent searches for this goal reported no opening, so report buyer-side evidence: a dated public request, job post, tender or marketplace listing where a business asks and pays for this work.',
  NO_BUYER:
    'Most openings Brain holds are a provider describing its own service, not a buyer asking for one, so for each opening name the kind of business that pays, where it publicly asks for the work, and one dated example of it doing so.',
  NO_SUPPORTED_PRICE:
    'Most openings Brain holds have no price buyers are shown paying, so give the price buyers pay for this exact deliverable — completed-job prices on a marketplace, or a competitor\'s published price for the same deliverable to the same buyers — with its page.',
  TOO_SMALL:
    'The openings Brain holds are each too small to matter for the goal, so prefer work many buyers pay for repeatedly, and state how many such buyers exist (a count from a directory, register or marketplace) and how often each buys.',
  OVER_LIMITS:
    'Most openings Brain holds need more money up front, or cost more, than the goal allows, so prefer work delivered remotely by AI-produced digital output with almost no up-front cost, and state the direct cost per sale.',
  SETTLEMENT_UNKNOWN:
    'Nobody has established when the money from the openings held would settle, so for each opening say how buyers pay (card at checkout, prepaid, invoice terms) and how many days until the cash arrives.',
};

/**
 * Why the goal's research is not producing openings its plan can use.
 * Pure: the plan's considered openings, the reasons it excluded others, and
 * the goal's recent rounds. Most severe first; empty when nothing stands out.
 */
export function diagnoseGoalResearch(input: {
  considered: Pick<ConsideredOpening, 'missing' | 'supportedReach' | 'potentialReach'>[];
  excludedReasons: string[];
  rounds: GoalRoundOutcome[];
  /** The amount still needed, in major units. */
  remaining: number;
}): ResearchDiagnosis[] {
  const out: ResearchDiagnosis[] = [];
  const settled = input.rounds.filter((one) => one.state !== 'OPEN');
  const fruitful = settled.filter((one) => one.state === 'HARVESTED' && one.found > 0).length;
  const abandoned = settled.filter((one) => one.state === 'ABANDONED').length;
  const empty = settled.filter((one) => one.state === 'HARVESTED' && one.found === 0).length;
  if (fruitful === 0 && abandoned >= BARREN_ROUNDS_FOR_CAUSE && abandoned >= empty) {
    out.push({ cause: 'RESEARCH_NOT_FINISHING', evidence: `${abandoned} of the goal's last ${settled.length} settled rounds ended without a report, and none filed an opening`, instruction: INSTRUCTION.RESEARCH_NOT_FINISHING });
  } else if (fruitful === 0 && empty >= BARREN_ROUNDS_FOR_CAUSE) {
    out.push({ cause: 'NO_OPENINGS_REPORTED', evidence: `${empty} of the goal's last ${settled.length} settled rounds filed a report with no opening in it`, instruction: INSTRUCTION.NO_OPENINGS_REPORTED });
  }
  const held = input.considered;
  if (held.length > 0) {
    const lacking = (links: ChainLink[]) => held.filter((one) => one.missing.some((link) => links.includes(link))).length;
    const share = (n: number) => `${n} of ${held.length} openings held`;
    const buyer = lacking(['REACHABLE_BUYER', 'CURRENT_DEMAND']);
    if (buyer / held.length >= CAUSE_SHARE) out.push({ cause: 'NO_BUYER', evidence: `${share(buyer)} lack a reachable buyer or a dated sign of demand`, instruction: INSTRUCTION.NO_BUYER });
    const price = lacking(['OFFER_AND_PRICE']);
    if (price / held.length >= CAUSE_SHARE) out.push({ cause: 'NO_SUPPORTED_PRICE', evidence: `${share(price)} lack a price buyers are shown to pay`, instruction: INSTRUCTION.NO_SUPPORTED_PRICE });
    const largest = Math.max(0, ...held.map((one) => Math.max(one.supportedReach, one.potentialReach ?? 0)));
    if (input.remaining > 0 && largest < input.remaining * 0.1) {
      out.push({ cause: 'TOO_SMALL', evidence: `the largest opening held could bring ${Math.round(largest)} of the ${Math.round(input.remaining)} still needed`, instruction: INSTRUCTION.TOO_SMALL });
    }
    const money = lacking(['ECONOMICS']);
    if (money / held.length >= CAUSE_SHARE) out.push({ cause: 'OVER_LIMITS', evidence: `${share(money)} have costs or money tied up that are unknown or over the limits`, instruction: INSTRUCTION.OVER_LIMITS });
    const settles = lacking(['SETTLES_IN_TIME']);
    if (settles / held.length >= CAUSE_SHARE) out.push({ cause: 'SETTLEMENT_UNKNOWN', evidence: `${share(settles)} have no established settlement date`, instruction: INSTRUCTION.SETTLEMENT_UNKNOWN });
  }
  const limits = input.excludedReasons.filter((reason) => /capital|tie[sd]? up|physical|more than the/i.test(reason)).length;
  if (limits >= 3 && !out.some((one) => one.cause === 'OVER_LIMITS')) {
    out.push({ cause: 'OVER_LIMITS', evidence: `${limits} openings were left out of the plan for money tied up or physical work`, instruction: INSTRUCTION.OVER_LIMITS });
  }
  return out;
}

/** The instructions a goal round is given, from a diagnosis. */
export function diagnosisInstructions(diagnosis: ResearchDiagnosis[]): string {
  return diagnosis.slice(0, MAX_INSTRUCTIONS).map((one) => one.instruction).join(' ');
}

/** The goal's own rounds (lens and constructed), newest first. */
export async function recentGoalRounds(projectId: string, goalId: string, limit = 12): Promise<GoalRoundOutcome[]> {
  return await getDb().all<GoalRoundOutcome>(
    `SELECT state, found FROM cash_discovery_rounds WHERE project_id = ? AND bucket_id LIKE ?
      ORDER BY opened_at DESC, id DESC LIMIT ${Math.max(1, Math.trunc(limit))}`,
    [projectId, `goal-${goalId}%`],
  );
}

/** The model that answered a free-lane job, from its event's reason (`model <name>[: why]`). */
export function modelOfReason(reason: string | null): string {
  return String(reason ?? '').replace(/^model /, '').split(':')[0]!.trim() || '(unknown)';
}

/** A free-lane failure reason without its model, counts, hosts and quotes, so like failures group. */
export function failureClass(reason: string | null): string {
  const why = String(reason ?? '').replace(/^model [^:]+:\s*/, '');
  return why
    .replace(/\{[^}]*\}/g, '{…}')
    .replace(/\d+/g, 'N')
    .replace(/(getaddrinfo \w+|attempted address:|answered) .*/, '$1 …')
    .slice(0, 110)
    .trim() || '(no reason)';
}

export interface GoalResearchProgress {
  since: string;
  rounds: { opened: number; harvested: number; withOpenings: number; abandoned: number; open: number };
  /** Free-lane jobs on the goal's research, by model. */
  jobs: Record<string, { submitted: number; failed: number }>;
  /** Accepted (sourced) claims on fragments each model submitted for the goal. */
  claims: Record<string, { claims: number; sourced: number; signalled: number }>;
  /** Why the goal's research jobs were not accepted, most frequent first (reason with ids stripped). */
  failures: { reason: string; n: number }[];
  /** Openings harvested from the goal's research in the window. */
  openings: { id: string; title: string; model: string | null; payer: boolean; price: boolean }[];
}

/**
 * The chain from a goal's research jobs to its openings, over a window.
 * A goal's research is every mission whose idea one of its rounds asked.
 */
export async function goalResearchProgress(projectId: string, goalId: string, since: string): Promise<GoalResearchProgress> {
  const db = getDb();
  const bucket = `goal-${goalId}%`;
  const rounds = await db.all<{ state: string; found: number; opened_at: string; harvested_at: string | null }>(
    `SELECT state, found, opened_at, harvested_at FROM cash_discovery_rounds
      WHERE project_id = ? AND bucket_id LIKE ? AND (opened_at >= ? OR harvested_at >= ? OR state = 'OPEN')`,
    [projectId, bucket, since, since],
  );
  const goalOrchestrations = `SELECT m.orchestration_id FROM russell_missions m
      JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id
     WHERE r.project_id = ? AND r.bucket_id LIKE ? AND m.orchestration_id IS NOT NULL`;
  const jobRows = await db.all<{ reason: string | null; outcome: string; n: number | string }>(
    `SELECT e.reason, e.outcome, COUNT(*) AS n FROM bin_events e JOIN work_items w ON w.id = e.work_item_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.at >= ? AND w.orchestration_id IN (${goalOrchestrations})
      GROUP BY e.reason, e.outcome`,
    [since, projectId, bucket],
  );
  const jobs: GoalResearchProgress['jobs'] = {};
  for (const row of jobRows) {
    const model = modelOfReason(row.reason);
    const entry = (jobs[model] ??= { submitted: 0, failed: 0 });
    if (row.outcome === 'SUBMITTED') entry.submitted += Number(row.n);
    else entry.failed += Number(row.n);
  }
  const claimRows = await db.all<{ reason: string | null; claims: number | string; sourced: number | string | null; signalled: number | string | null }>(
    `SELECT e.reason, COUNT(c.id) AS claims,
            SUM(CASE WHEN c.sourced = 1 THEN 1 ELSE 0 END) AS sourced,
            SUM(CASE WHEN c.sourced = 1 AND c.opportunity_signal IS NOT NULL THEN 1 ELSE 0 END) AS signalled
       FROM bin_events e JOIN work_items w ON w.id = e.work_item_id
       JOIN research_claims c ON c.fragment_id = w.fragment_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED' AND e.workload_class = 'RESEARCH_FRAGMENT'
        AND e.at >= ? AND w.fragment_id IS NOT NULL AND w.orchestration_id IN (${goalOrchestrations})
      GROUP BY e.reason`,
    [since, projectId, bucket],
  );
  const failRows = await db.all<{ reason: string | null }>(
    `SELECT e.reason FROM bin_events e JOIN work_items w ON w.id = e.work_item_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome <> 'SUBMITTED' AND e.at >= ?
        AND w.orchestration_id IN (${goalOrchestrations})`,
    [since, projectId, bucket],
  );
  const failCounts = new Map<string, number>();
  for (const row of failRows) {
    const why = failureClass(row.reason);
    failCounts.set(why, (failCounts.get(why) ?? 0) + 1);
  }
  const failures = [...failCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([reason, n]) => ({ reason, n }));
  const claims: GoalResearchProgress['claims'] = {};
  for (const row of claimRows) {
    const entry = (claims[modelOfReason(row.reason)] ??= { claims: 0, sourced: 0, signalled: 0 });
    entry.claims += Number(row.claims);
    entry.sourced += Number(row.sourced ?? 0);
    entry.signalled += Number(row.signalled ?? 0);
  }
  const openingRows = await db.all<{ id: string; title: string; payer: string | null; price_cents: number | null; fragment_id: string | null }>(
    `SELECT o.id, o.title, o.payer, o.price_cents, o.fragment_id FROM cash_opportunities o
       JOIN cash_discovery_rounds r ON r.id = o.discovery_round_id
      WHERE o.project_id = ? AND r.bucket_id LIKE ? AND o.created_at >= ? AND o.duplicate_of_id IS NULL
      ORDER BY o.created_at DESC`,
    [projectId, bucket, since],
  );
  const fragments = [...new Set(openingRows.map((one) => one.fragment_id).filter((one): one is string => !!one))];
  const byFragment = new Map<string, string>();
  if (fragments.length > 0) {
    const rows = await db.all<{ fragment_id: string; reason: string | null }>(
      `SELECT w.fragment_id, e.reason FROM bin_events e JOIN work_items w ON w.id = e.work_item_id
        WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED'
          AND w.fragment_id IN (${fragments.map(() => '?').join(', ')})`,
      fragments,
    );
    for (const row of rows) byFragment.set(row.fragment_id, modelOfReason(row.reason));
  }
  return {
    since,
    rounds: {
      opened: rounds.filter((one) => one.opened_at >= since).length,
      harvested: rounds.filter((one) => one.state === 'HARVESTED' && (one.harvested_at ?? '') >= since).length,
      withOpenings: rounds.filter((one) => one.state === 'HARVESTED' && one.found > 0 && (one.harvested_at ?? '') >= since).length,
      abandoned: rounds.filter((one) => one.state === 'ABANDONED' && (one.harvested_at ?? one.opened_at) >= since).length,
      open: rounds.filter((one) => one.state === 'OPEN').length,
    },
    jobs,
    failures,
    claims,
    openings: openingRows.map((one) => ({
      id: one.id,
      title: one.title,
      // A fragment no free-lane model answered was answered by a Claude routine or a person.
      model: one.fragment_id ? (byFragment.get(one.fragment_id) ?? 'not the free lane') : null,
      payer: !!one.payer?.trim(),
      price: one.price_cents !== null,
    })),
  };
}

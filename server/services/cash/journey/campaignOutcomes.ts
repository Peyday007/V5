/**
 * What Brain's Instantly campaigns measured, written as outcomes the outreach
 * funnel can model (COM-13-3, §94, §107).
 *
 * The outreach funnel (`funnel.ts` `mechanismsFromRows`) reads `cash_outcomes`,
 * and until now the only writer of a `CONTACT_RESULT` was `learning.ts`, which
 * learns only from a deal's own `CONTACT_BUYER` action. Brain's real outreach —
 * The Neighbor Card, the expansion businesses' campaigns and every campaign the
 * sales desk feeds — runs through campaigns in the owner's Instantly workspace,
 * never creates a deal action, and so never reached the funnel: production had
 * outreach and the funnel had "no mechanism to model". This reads each of those
 * campaigns' leads back from Instantly and records one `CONTACT_RESULT` per lead
 * once the provider's own record states a terminal answer:
 *
 *   - bounced (lead status −1)                       → CONTACT_UNDELIVERABLE
 *   - interest status won                            → BUYER_ACCEPTED
 *   - interest status not interested / lost          → BUYER_DECLINED
 *   - unsubscribed (−2), or the sales desk recorded
 *     an opt-out on the lead's reply                 → BUYER_DECLINED
 *   - any reply on record                            → BUYER_REPLIED
 *   - the sequence completed (3) with no reply       → BUYER_SILENT
 *
 * A lead still in an active or paused sequence (Instantly status 1 or 2)
 * records nothing while it can still answer. A cohort is not held for ever,
 * though: a paused campaign, or one that keeps running, would otherwise leave
 * the funnel with no rows at all. Once a cohort was enrolled
 * `COHORT_SETTLE_DAYS` ago, each of its leads still without a terminal state
 * is resolved at that bound, and says so in its basis:
 *
 *   - a lead Instantly never contacted (no last-contact time)  → not reached:
 *     like a skipped lead it records nothing and holds nothing back;
 *   - a lead last contacted at least `SILENCE_AFTER_CONTACT_DAYS` ago with no
 *     reply → `BUYER_SILENT`, marked `SILENT_AT_BOUND` ("no answer by the
 *     bound", not a provider-terminal silence), which a reply arriving later
 *     still refines to that answer (`insertOutcome` `refineReply`);
 *   - a lead contacted more recently than that still holds its cohort.
 *
 * So the funnel reads a whole cohort — every answer and every lead that had
 * the same chance and gave none — instead of nothing, and nothing it reads is
 * a lead that was never sent to.
 *
 * Answers are recorded by enrolment cohort, never lead by lead. A reply or a
 * bounce ends a lead's sequence days before a silent lead's last step does, so
 * recording each lead the moment it is terminal would put every early answer
 * in the funnel's denominator and leave out most of the silent leads beside
 * them, overstating the bounce rate and the response rate while a campaign
 * runs. A cohort is the leads a campaign enrolled on one UTC day
 * (Instantly's `timestamp_created`; leads without one are one cohort of their
 * own), and none of its leads is recorded until every one of them is terminal.
 * A cohort is chosen by when it was enrolled, never by how its leads answered,
 * so the rows the funnel reads are a whole sample: what was answered, and every
 * lead that had the same chance and did not. A lead Instantly skipped (−3) was
 * never sent to, records nothing and holds no cohort back. One row
 * per lead, keyed by the campaign and Instantly's lead id, so a second pass
 * writes nothing. The one exception is a plain `BUYER_REPLIED`, which this
 * path alone (it passes `refineReply`) lets become the classified answer
 * Instantly's interest status later states; every other answer is final.
 * A deal's contact outcome in `learning.ts` does not opt in, so there the
 * first terminal answer stands unchanged. Messages are never recorded: a lead is
 * a prospect, an answer is an answer, and neither is a buyer or revenue.
 *
 * The mechanism is the campaign's own name — whatever the workspace calls it,
 * no category list. Brain's deal campaign (the one `perform.ts` sends through,
 * whose replies `instantlySync.ts` reads onto deals) is left out, because
 * `learning.ts` already learns it from the deals' own rows.
 *
 * The rows go to one project: the earliest-activated cash project whose
 * standing commercial authority permits CONTACT_BUYER. Any other project's tick
 * records nothing, so a campaign is never counted twice; with no such project,
 * or no Instantly key, or a read that fails, nothing is written and the pass
 * says why. Read-only toward Instantly.
 *
 * A pass sends at most `CAMPAIGN_OUTCOMES_REQUESTS_PER_PASS` requests and never
 * waits: it runs inside the journey tick, ahead of the deal passes, and shares
 * the workspace's 20-a-minute allowance with the reply sync. When the budget
 * is spent, or Instantly answers 429 or 5xx, the pass stops where it got to and
 * the next tick continues the same read a rate window later, so a workspace of
 * any size is read whole over several ticks and never stalls one.
 */
import { getDb } from '../../../db/database.ts';
import { SILENT_AT_BOUND, insertOutcome } from '../../../repos/cashJourney.ts';
import { BRAIN_PRINCIPAL, actionContext, checkCommercialAuthority } from '../authority.ts';
import { CAMPAIGN_NAME, PERSONAL_CAMPAIGN_NAME, defaultDeps, instantly, itemsOf, type Deps } from '../neighborCard.ts';
import { EXPANSION_CAMPAIGNS } from '../expansionOutreach.ts';
import { BRAIN_CAMPAIGN_NAME, BRAIN_CAMPAIGN_PREFIX, answerFromInterestStatus } from '../providers/instantly.ts';
import { INSTANTLY_CAMPAIGN_ENV, secretValue } from '../providers/config.ts';

/** The channel every campaign row carries. */
export const CAMPAIGN_CHANNEL = 'email (Instantly)';

/** Instantly's lead statuses that end a lead's sequence. */
const LEAD_BOUNCED = -1;
const LEAD_UNSUBSCRIBED = -2;
const LEAD_COMPLETED = 3;
const LEAD_SKIPPED = -3;
/**
 * A cohort enrolled this long ago is resolved: none of its leads holds it back
 * any longer. Well past any sequence Brain's campaigns run, so a cohort still
 * sending normally has ended long before it.
 */
export const COHORT_SETTLE_DAYS = 30;
/** A contacted lead with no reply this long after its last contact is silent at the bound. */
export const SILENCE_AFTER_CONTACT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The cohort of leads whose enrolment time Instantly did not state. */
export const UNDATED_COHORT = 'undated';

/** A workspace allows 20 requests a minute; a full read is a few hundred leads, so every few hours is plenty. */
export const CAMPAIGN_OUTCOMES_EVERY_MS = 6 * 60 * 60 * 1000;
/** At most this many pages of 100 leads per campaign. */
const MAX_LEAD_PAGES = 50;
/** At most this many campaign-list pages per read of the workspace. */
const MAX_CAMPAIGN_PAGES = 20;
/**
 * The most Instantly requests one pass may send. The workspace allows 20 a
 * minute, and the reply sync (`instantlySync.ts`) and the sales desk share
 * that allowance, so one pass takes well under half of it. A read larger than
 * this is not cut short: the pass stops where it got to, and the next tick
 * continues from there (see `CAMPAIGN_OUTCOMES_CONTINUE_MS`).
 */
export const CAMPAIGN_OUTCOMES_REQUESTS_PER_PASS = 8;
/** A read left unfinished by the budget or a refusal continues no sooner than one rate window later. */
export const CAMPAIGN_OUTCOMES_CONTINUE_MS = 60 * 1000;

export type CampaignContactResult =
  | 'CONTACT_UNDELIVERABLE'
  | 'BUYER_ACCEPTED'
  | 'BUYER_DECLINED'
  | 'BUYER_REPLIED'
  | 'BUYER_SILENT';

export interface CampaignLead {
  id: string;
  email: string | null;
  status: number | null;
  replies: number;
  interestStatus: number | null;
  /** When the campaign enrolled the lead (Instantly's `timestamp_created`), or null when not stated. */
  enrolledAt: string | null;
  /** When Instantly last sent to the lead (`timestamp_last_contact`), or null when it never has (or did not say). */
  lastContactAt?: string | null;
}

export interface CampaignOutcomesReport {
  /** Campaigns read this pass. */
  campaigns: number;
  /** Leads read across them. */
  leads: number;
  /** New CONTACT_RESULT rows written this pass. */
  recorded: number;
  /** Leads still in their sequence with no answer: nothing recorded for them. */
  pending: number;
  /**
   * Leads whose answer is terminal but whose enrolment cohort still has a lead
   * in its sequence: held, not recorded, so the funnel never reads the answers
   * of a cohort without its silences.
   */
  held: number;
  /**
   * Leads with no terminal provider state whose cohort settled
   * (`COHORT_SETTLE_DAYS`) and who were contacted with no reply for
   * `SILENCE_AFTER_CONTACT_DAYS`: recorded as silent at the bound.
   */
  silentAtBound: number;
  /** Leads in a settled cohort that Instantly never contacted: no prospect reached, nothing recorded. */
  notReached: number;
  /** Why nothing was read or written, when that is the case. */
  skipped: string | null;
  /**
   * Why this pass stopped before the read was finished — its request budget
   * was spent, or Instantly asked it to slow down — or null when it finished.
   * The pass never waits inside the tick: the next one continues from here.
   */
  paused: string | null;
  /** Instantly requests this pass sent. Never more than `CAMPAIGN_OUTCOMES_REQUESTS_PER_PASS`. */
  requests: number;
  /** Campaigns whose read failed, with why. A failure writes nothing for that campaign. */
  failed: { campaign: string; reason: string }[];
}

function emptyReport(): CampaignOutcomesReport {
  return { campaigns: 0, leads: 0, recorded: 0, pending: 0, held: 0, silentAtBound: 0, notReached: 0, skipped: null, paused: null, requests: 0, failed: [] };
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The terminal answer Instantly's record of one lead states, or null while it
 * states none. `optedOut` is the sales desk's own reading of the lead's reply.
 */
export function contactResultOf(lead: CampaignLead, optedOut = false): CampaignContactResult | null {
  if (lead.status === LEAD_BOUNCED) return 'CONTACT_UNDELIVERABLE';
  const answer = answerFromInterestStatus(lead.interestStatus);
  if (answer) return answer;
  if (lead.status === LEAD_UNSUBSCRIBED || optedOut) return 'BUYER_DECLINED';
  if (lead.replies > 0) return 'BUYER_REPLIED';
  if (lead.status === LEAD_COMPLETED) return 'BUYER_SILENT';
  return null;
}

/** The enrolment cohort a lead belongs to: the UTC day the campaign enrolled it. */
export function cohortOf(lead: CampaignLead): string {
  const at = lead.enrolledAt === null ? Number.NaN : Date.parse(lead.enrolledAt);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : UNDATED_COHORT;
}

/**
 * How a lead with no terminal provider state stands at the cohort bound:
 * `NOT_REACHED` when its cohort has settled and Instantly never contacted it,
 * `SILENT_AT_BOUND` when its cohort has settled and its last contact is
 * `SILENCE_AFTER_CONTACT_DAYS` old with no reply, or null while it can still
 * answer and so holds its cohort. A lead with no enrolment time settles on its
 * last contact instead; with neither, nothing says it has had its chance, and
 * it keeps holding. Pure.
 */
export function boundStateOf(lead: CampaignLead, nowMs: number): 'NOT_REACHED' | 'SILENT_AT_BOUND' | null {
  const enrolled = lead.enrolledAt === null ? Number.NaN : Date.parse(lead.enrolledAt);
  const contacted = lead.lastContactAt ? Date.parse(lead.lastContactAt) : Number.NaN;
  const since = Number.isFinite(enrolled) ? enrolled : contacted;
  if (!Number.isFinite(since) || nowMs - since < COHORT_SETTLE_DAYS * DAY_MS) return null;
  if (!Number.isFinite(contacted)) return 'NOT_REACHED';
  return nowMs - contacted >= SILENCE_AFTER_CONTACT_DAYS * DAY_MS ? 'SILENT_AT_BOUND' : null;
}

/** A lead Instantly never sent to: it is no prospect reached and no answer. */
function neverSent(lead: CampaignLead): boolean {
  return lead.status === LEAD_SKIPPED;
}

/**
 * The project campaign outcomes belong to: the earliest-activated cash project
 * whose standing authority permits CONTACT_BUYER, or why there is none.
 */
export async function campaignOutcomeProject(): Promise<{ ok: true; projectId: string } | { ok: false; reason: string }> {
  const modes = await getDb().all<{ project_id: string }>(
    `SELECT project_id FROM cash_modes ORDER BY activated_at, id`,
  );
  for (const { project_id: projectId } of modes) {
    const decision = await checkCommercialAuthority(
      { projectId, action: 'CONTACT_BUYER', ...actionContext({ principal: BRAIN_PRINCIPAL }) },
      { record: false },
    );
    if (decision.ok) return { ok: true, projectId };
  }
  return { ok: false, reason: 'no cash project holds standing commercial authority to contact buyers' };
}

/**
 * Where an unfinished read got to. A pass is bounded by a request budget, so a
 * large workspace is read over several passes; nothing of a campaign is
 * recorded until all of its leads have been read, so the cohort rule below
 * always sees the whole campaign. Held in memory: after a restart the read
 * simply starts again, and the request keys make a repeat write nothing.
 */
interface ReadProgress {
  /** Brain's campaigns, once the workspace list has been read to its end. */
  campaigns: { id: string; name: string }[] | null;
  listed: { id: string; name: string }[];
  listAfter: string | undefined;
  listPage: number;
  /** The campaign being read, as an index into `campaigns`. */
  index: number;
  leads: CampaignLead[];
  leadAfter: string | undefined;
  leadPage: number;
}

function freshProgress(): ReadProgress {
  return { campaigns: null, listed: [], listAfter: undefined, listPage: 0, index: 0, leads: [], leadAfter: undefined, leadPage: 0 };
}

/** Thrown when a pass must stop and continue on the next tick instead of waiting. */
class PassPaused extends Error {}

/**
 * The provider dependencies one pass reads through: every request counts
 * against the pass's budget and is refused once it is spent, and a retry's
 * wait — a 429, a 5xx, a dropped connection — ends the pass rather than
 * sleeping inside the tick. `instantly()` retries by sleeping, so turning the
 * sleep into a stop is what keeps its backoff out of `advanceJourney`.
 */
function budgeted(deps: Deps, report: CampaignOutcomesReport, budget: number): Deps {
  return {
    ...deps,
    fetch: (async (input: Parameters<Deps['fetch']>[0], init?: Parameters<Deps['fetch']>[1]) => {
      if (report.requests >= budget) throw new PassPaused(`request budget of ${budget} spent; the next pass continues`);
      report.requests += 1;
      return deps.fetch(input, init);
    }) as Deps['fetch'],
    sleep: async () => {
      throw new PassPaused(
        report.requests >= budget
          ? `request budget of ${budget} spent; the next pass continues`
          : 'Instantly asked the pass to slow down; the next pass continues',
      );
    },
  };
}

/** Brain's outreach campaigns in the workspace, by name or by a sales-desk lead row, less the deal campaign. */
async function readCampaigns(deps: Deps, progress: ReadProgress): Promise<{ id: string; name: string }[]> {
  if (progress.campaigns) return progress.campaigns;
  const named = new Set<string>([CAMPAIGN_NAME, PERSONAL_CAMPAIGN_NAME, ...EXPANSION_CAMPAIGNS.map((c) => c.name)]);
  const deskRows = await getDb().all<{ campaign_id: string }>(
    `SELECT DISTINCT campaign_id FROM sales_leads WHERE campaign_id IS NOT NULL ORDER BY campaign_id`,
  );
  const deskIds = new Set(deskRows.map((row) => row.campaign_id));
  const dealCampaignId = secretValue(INSTANTLY_CAMPAIGN_ENV, deps.env);

  while (progress.listPage < MAX_CAMPAIGN_PAGES) {
    const after = progress.listAfter;
    const answer = await instantly(deps, 'GET', `/campaigns?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`);
    const rows = itemsOf(answer);
    for (const row of rows) {
      const id = typeof row.id === 'string' ? row.id : null;
      const name = typeof row.name === 'string' ? row.name : '';
      if (!id) continue;
      if (name === BRAIN_CAMPAIGN_NAME || (dealCampaignId && id === dealCampaignId)) continue;
      if (named.has(name) || deskIds.has(id) || name.startsWith(BRAIN_CAMPAIGN_PREFIX)) progress.listed.push({ id, name: name || id });
    }
    progress.listPage += 1;
    progress.listAfter = typeof answer.next_starting_after === 'string' ? answer.next_starting_after : undefined;
    if (!progress.listAfter || rows.length === 0) break;
  }
  progress.campaigns = [...progress.listed].sort((a, b) => a.name.localeCompare(b.name));
  return progress.campaigns;
}

/** Reads the current campaign's leads onward from where `progress` got to, until the last page. */
async function readLeads(deps: Deps, campaignId: string, progress: ReadProgress): Promise<CampaignLead[]> {
  while (progress.leadPage < MAX_LEAD_PAGES) {
    const after = progress.leadAfter;
    const answer = await instantly(deps, 'POST', '/leads/list', { campaign: campaignId, limit: 100, ...(after ? { starting_after: after } : {}) });
    const rows = itemsOf(answer);
    for (const row of rows) {
      if (typeof row.id !== 'string') continue;
      progress.leads.push({
        id: row.id,
        email: typeof row.email === 'string' ? row.email.toLowerCase() : null,
        status: num(row.status),
        replies: Math.max(0, num(row.email_reply_count) ?? 0),
        interestStatus: num(row.lt_interest_status),
        enrolledAt: typeof row.timestamp_created === 'string' ? row.timestamp_created : null,
        lastContactAt: typeof row.timestamp_last_contact === 'string' ? row.timestamp_last_contact : null,
      });
    }
    progress.leadPage += 1;
    progress.leadAfter = typeof answer.next_starting_after === 'string' ? answer.next_starting_after : undefined;
    if (!progress.leadAfter || rows.length === 0) break;
  }
  return progress.leads;
}

function nextCampaign(progress: ReadProgress): void {
  progress.index += 1;
  progress.leads = [];
  progress.leadAfter = undefined;
  progress.leadPage = 0;
}

/** Lead addresses the sales desk recorded an opt-out for, on one campaign. */
async function optedOutOn(campaignId: string): Promise<Set<string>> {
  const rows = await getDb().all<{ lead_email: string }>(
    `SELECT DISTINCT lead_email FROM sales_replies WHERE campaign_id = ? AND opt_out IS NOT NULL AND opt_out <> '' AND opt_out <> 'null'`,
    [campaignId],
  );
  return new Set(rows.map((row) => row.lead_email.toLowerCase()));
}

/** When each project's last complete read began. */
const lastPass = new Map<string, number>();
/** Each project's unfinished read, and when it last advanced. */
const unfinished = new Map<string, { progress: ReadProgress; at: number }>();

/**
 * One pass for `projectId`. Records only when it is the campaign-outcome
 * project (see `campaignOutcomeProject`); `ownerProjectId` states that answer
 * when the caller already has it. `force` ignores the pacing.
 */
export async function recordCampaignOutcomes(
  projectId: string,
  options: { deps?: Deps; now?: Date; force?: boolean; ownerProjectId?: string; requestBudget?: number } = {},
): Promise<CampaignOutcomesReport> {
  const report = emptyReport();
  const deps = options.deps ?? defaultDeps();
  if (!secretValue('INSTANTLY_API_KEY', deps.env)) {
    report.skipped = 'INSTANTLY_API_KEY is not configured';
    return report;
  }
  const nowMs = (options.now ?? new Date()).getTime();
  const resumed = unfinished.get(projectId);
  if (!options.force) {
    if (resumed && nowMs - resumed.at < CAMPAIGN_OUTCOMES_CONTINUE_MS) {
      report.skipped = 'an unfinished read continues once the rate window has passed';
      return report;
    }
    if (!resumed && nowMs - (lastPass.get(projectId) ?? -Infinity) < CAMPAIGN_OUTCOMES_EVERY_MS) {
      report.skipped = 'read recently; the next pass reads again';
      return report;
    }
  }
  const owner = options.ownerProjectId
    ? { ok: true as const, projectId: options.ownerProjectId }
    : await campaignOutcomeProject();
  if (!owner.ok) {
    report.skipped = owner.reason;
    return report;
  }
  if (owner.projectId !== projectId) {
    report.skipped = `campaign outcomes are recorded on project ${owner.projectId}`;
    return report;
  }
  const budget = options.requestBudget ?? CAMPAIGN_OUTCOMES_REQUESTS_PER_PASS;
  const reader = budgeted(deps, report, budget);
  const progress = resumed?.progress ?? freshProgress();
  if (!resumed) lastPass.set(projectId, nowMs);
  const pause = (error: unknown): boolean => {
    if (!(error instanceof PassPaused)) return false;
    report.paused = error.message;
    unfinished.set(projectId, { progress, at: nowMs });
    return true;
  };

  let campaigns: { id: string; name: string }[];
  try {
    campaigns = await readCampaigns(reader, progress);
  } catch (error) {
    if (pause(error)) return report;
    unfinished.delete(projectId);
    report.skipped = `the workspace's campaigns could not be read: ${error instanceof Error ? error.message.slice(0, 200) : 'failed'}`;
    return report;
  }
  while (progress.index < campaigns.length) {
    const campaign = campaigns[progress.index]!;
    let leads: CampaignLead[];
    try {
      leads = await readLeads(reader, campaign.id, progress);
    } catch (error) {
      if (pause(error)) return report;
      report.failed.push({ campaign: campaign.name, reason: error instanceof Error ? error.message.slice(0, 200) : 'failed' });
      nextCampaign(progress);
      continue;
    }
    report.campaigns += 1;
    report.leads += leads.length;
    const optedOut = await optedOutOn(campaign.id);
    const answered: { lead: CampaignLead; result: CampaignContactResult | null; atBound: boolean }[] = [];
    for (const lead of leads) {
      if (neverSent(lead)) continue;
      const result = contactResultOf(lead, lead.email !== null && optedOut.has(lead.email));
      if (result) {
        answered.push({ lead, result, atBound: false });
        continue;
      }
      const bound = boundStateOf(lead, nowMs);
      if (bound === 'NOT_REACHED') {
        // Never sent to, and its cohort has had its time: no prospect reached, and it holds nothing back.
        report.notReached += 1;
        continue;
      }
      answered.push({ lead, result: bound === 'SILENT_AT_BOUND' ? 'BUYER_SILENT' : null, atBound: bound === 'SILENT_AT_BOUND' });
    }
    // A cohort with any lead still able to answer records none of its leads.
    const openCohorts = new Set(answered.filter((one) => one.result === null).map((one) => cohortOf(one.lead)));
    for (const { lead, result, atBound } of answered) {
      if (!result) {
        report.pending += 1;
        continue;
      }
      if (openCohorts.has(cohortOf(lead))) {
        report.held += 1;
        continue;
      }
      const state = `status ${lead.status ?? 'none'}, replies ${lead.replies}, interest ${lead.interestStatus ?? 'none'}`;
      const basis = atBound
        ? `instantly campaign ${campaign.id}; lead ${lead.id}: ${state}, last contact ${lead.lastContactAt}; ${SILENT_AT_BOUND} ` +
          `no terminal provider state: enrolment cohort ${cohortOf(lead)} settled (${COHORT_SETTLE_DAYS} days) and no reply ` +
          `${SILENCE_AFTER_CONTACT_DAYS}+ days after the last contact; a later reply refines it`
        : `instantly campaign ${campaign.id}; lead ${lead.id}: ${state}; enrolment cohort ${cohortOf(lead)}, every lead terminal or settled`;
      const fresh = await insertOutcome({
        projectId,
        opportunityId: `instantly-lead:${lead.id}`,
        kind: 'CONTACT_RESULT',
        mechanism: campaign.name,
        channel: CAMPAIGN_CHANNEL,
        valueText: result,
        basis,
        requestKey: `outcome:campaign:${campaign.id}:${lead.id}:CONTACT_RESULT`,
        // An Instantly lead's interest status follows its reply, and a reply may follow a silence at the bound; only this path refines.
        refineReply: true,
      });
      if (fresh) {
        report.recorded += 1;
        if (atBound) report.silentAtBound += 1;
      }
    }
    nextCampaign(progress);
  }
  unfinished.delete(projectId);
  return report;
}

/** Test seam: forget the pacing and any unfinished read. */
export function resetCampaignOutcomePacing(): void {
  lastPass.clear();
  unfinished.clear();
}

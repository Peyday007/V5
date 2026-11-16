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
 * A lead still in an active or paused sequence records nothing: silence is
 * learned only from a terminal provider state, never from a clock here.
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
 * writes nothing, and the first terminal answer stands — exactly as
 * `learning.ts` treats a deal's contact. Messages are never recorded: a lead is
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
 */
import { getDb } from '../../../db/database.ts';
import { insertOutcome } from '../../../repos/cashJourney.ts';
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
/** The cohort of leads whose enrolment time Instantly did not state. */
export const UNDATED_COHORT = 'undated';

/** A workspace allows 20 requests a minute; a full read is a few hundred leads, so every few hours is plenty. */
export const CAMPAIGN_OUTCOMES_EVERY_MS = 6 * 60 * 60 * 1000;
/** At most this many pages of 100 leads per campaign per pass. */
const MAX_LEAD_PAGES = 50;

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
  /** Why nothing was read or written, when that is the case. */
  skipped: string | null;
  /** Campaigns whose read failed, with why. A failure writes nothing for that campaign. */
  failed: { campaign: string; reason: string }[];
}

function emptyReport(): CampaignOutcomesReport {
  return { campaigns: 0, leads: 0, recorded: 0, pending: 0, held: 0, skipped: null, failed: [] };
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

/** Brain's outreach campaigns in the workspace, by name or by a sales-desk lead row, less the deal campaign. */
async function brainCampaigns(deps: Deps): Promise<{ id: string; name: string }[]> {
  const named = new Set<string>([CAMPAIGN_NAME, PERSONAL_CAMPAIGN_NAME, ...EXPANSION_CAMPAIGNS.map((c) => c.name)]);
  const deskRows = await getDb().all<{ campaign_id: string }>(
    `SELECT DISTINCT campaign_id FROM sales_leads WHERE campaign_id IS NOT NULL ORDER BY campaign_id`,
  );
  const deskIds = new Set(deskRows.map((row) => row.campaign_id));
  const dealCampaignId = secretValue(INSTANTLY_CAMPAIGN_ENV, deps.env);

  const out: { id: string; name: string }[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const answer = await instantly(deps, 'GET', `/campaigns?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`);
    const rows = itemsOf(answer);
    for (const row of rows) {
      const id = typeof row.id === 'string' ? row.id : null;
      const name = typeof row.name === 'string' ? row.name : '';
      if (!id) continue;
      if (name === BRAIN_CAMPAIGN_NAME || (dealCampaignId && id === dealCampaignId)) continue;
      if (named.has(name) || deskIds.has(id) || name.startsWith(BRAIN_CAMPAIGN_PREFIX)) out.push({ id, name: name || id });
    }
    after = typeof answer.next_starting_after === 'string' ? answer.next_starting_after : undefined;
    if (!after || rows.length === 0) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function leadsOf(deps: Deps, campaignId: string): Promise<CampaignLead[]> {
  const leads: CampaignLead[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_LEAD_PAGES; page += 1) {
    const answer = await instantly(deps, 'POST', '/leads/list', { campaign: campaignId, limit: 100, ...(after ? { starting_after: after } : {}) });
    const rows = itemsOf(answer);
    for (const row of rows) {
      if (typeof row.id !== 'string') continue;
      leads.push({
        id: row.id,
        email: typeof row.email === 'string' ? row.email.toLowerCase() : null,
        status: num(row.status),
        replies: Math.max(0, num(row.email_reply_count) ?? 0),
        interestStatus: num(row.lt_interest_status),
        enrolledAt: typeof row.timestamp_created === 'string' ? row.timestamp_created : null,
      });
    }
    after = typeof answer.next_starting_after === 'string' ? answer.next_starting_after : undefined;
    if (!after || rows.length === 0) break;
  }
  return leads;
}

/** Lead addresses the sales desk recorded an opt-out for, on one campaign. */
async function optedOutOn(campaignId: string): Promise<Set<string>> {
  const rows = await getDb().all<{ lead_email: string }>(
    `SELECT DISTINCT lead_email FROM sales_replies WHERE campaign_id = ? AND opt_out IS NOT NULL AND opt_out <> '' AND opt_out <> 'null'`,
    [campaignId],
  );
  return new Set(rows.map((row) => row.lead_email.toLowerCase()));
}

const lastPass = new Map<string, number>();

/**
 * One pass for `projectId`. Records only when it is the campaign-outcome
 * project (see `campaignOutcomeProject`); `ownerProjectId` states that answer
 * when the caller already has it. `force` ignores the pacing.
 */
export async function recordCampaignOutcomes(
  projectId: string,
  options: { deps?: Deps; now?: Date; force?: boolean; ownerProjectId?: string } = {},
): Promise<CampaignOutcomesReport> {
  const report = emptyReport();
  const deps = options.deps ?? defaultDeps();
  if (!secretValue('INSTANTLY_API_KEY', deps.env)) {
    report.skipped = 'INSTANTLY_API_KEY is not configured';
    return report;
  }
  const nowMs = (options.now ?? new Date()).getTime();
  if (!options.force && nowMs - (lastPass.get(projectId) ?? -Infinity) < CAMPAIGN_OUTCOMES_EVERY_MS) {
    report.skipped = 'read recently; the next pass reads again';
    return report;
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
  lastPass.set(projectId, nowMs);

  let campaigns: { id: string; name: string }[];
  try {
    campaigns = await brainCampaigns(deps);
  } catch (error) {
    report.skipped = `the workspace's campaigns could not be read: ${error instanceof Error ? error.message.slice(0, 200) : 'failed'}`;
    return report;
  }
  for (const campaign of campaigns) {
    let leads: CampaignLead[];
    try {
      leads = await leadsOf(deps, campaign.id);
    } catch (error) {
      report.failed.push({ campaign: campaign.name, reason: error instanceof Error ? error.message.slice(0, 200) : 'failed' });
      continue;
    }
    report.campaigns += 1;
    report.leads += leads.length;
    const optedOut = await optedOutOn(campaign.id);
    const answered = leads
      .filter((lead) => !neverSent(lead))
      .map((lead) => ({ lead, result: contactResultOf(lead, lead.email !== null && optedOut.has(lead.email)) }));
    // A cohort with any lead still in its sequence records none of its leads.
    const openCohorts = new Set(answered.filter((one) => one.result === null).map((one) => cohortOf(one.lead)));
    for (const { lead, result } of answered) {
      if (!result) {
        report.pending += 1;
        continue;
      }
      if (openCohorts.has(cohortOf(lead))) {
        report.held += 1;
        continue;
      }
      const fresh = await insertOutcome({
        projectId,
        opportunityId: `instantly-lead:${lead.id}`,
        kind: 'CONTACT_RESULT',
        mechanism: campaign.name,
        channel: CAMPAIGN_CHANNEL,
        valueText: result,
        basis: `instantly campaign ${campaign.id}; lead ${lead.id}: status ${lead.status ?? 'none'}, replies ${lead.replies}, interest ${lead.interestStatus ?? 'none'}; enrolment cohort ${cohortOf(lead)}, every lead terminal`,
        requestKey: `outcome:campaign:${campaign.id}:${lead.id}:CONTACT_RESULT`,
      });
      if (fresh) report.recorded += 1;
    }
  }
  return report;
}

/** Test seam: forget the pacing. */
export function resetCampaignOutcomePacing(): void {
  lastPass.clear();
}

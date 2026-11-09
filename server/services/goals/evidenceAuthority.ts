/**
 * What a historical result is allowed to say about a plan (§99).
 *
 * A measured result is evidence about the implementation that produced it:
 * its list, its offer, its copy, its sending set-up, its moment. It transfers
 * to a new plan only as far as the new plan repeats that implementation.
 * Production, 2026-11-09: the owner's Instantly workspace had sent 4,096 emails
 * across four campaigns for other offers, from lists that bounced 9.7%, and
 * that record was applied to every cold-outreach opening Brain modelled (#649).
 * A redesigned campaign (verified list, a different offer) was judged by the
 * old campaigns' failure, and the plan sank to coverage of ~0%.
 *
 * The rule here is the one `quant/pool.ts` already applies to published
 * evidence: a difference on a dimension that matters excludes the observation
 * from the estimate, and a defect in how it was measured is named rather than
 * averaged in. What is excluded is not discarded: it becomes the plan's
 * *as-is floor* — what happens if the new implementation performs no better
 * than the old — which is exactly the question it does answer.
 *
 * Nothing here reads prose for authority: the defects are computed from the
 * record's own counts against named, sourced thresholds.
 */

/** One campaign's own counts, as the provider reports them. */
export interface OutreachCampaignRecord {
  name: string;
  sent: number;
  replies: number;
  opportunities: number;
  bounced: number;
  /** Whether Brain created and ran it for the opening being judged. */
  brainOwned?: boolean;
  /** The opening it was run for, when Brain ran it. */
  opportunityId?: string | null;
}

export interface OutreachRecord {
  sent: number;
  replies: number;
  opportunities: number;
  bounced: number;
  campaigns?: OutreachCampaignRecord[];
}

/**
 * Hard-bounce share above which the list, not the market, is what was
 * measured. Instantly targets under 2% and pauses a campaign by itself at 5%
 * (help.instantly.ai/en/articles/16034903), so a record over 5% was sent from a
 * reputation its own platform would have stopped.
 */
export const LIST_DEFECT_BOUNCE = 0.05;
/** Below this many sends a reply rate locates nothing (one reply moves it by 0.2 points). */
export const MIN_RECORD_SENDS = 500;
/** A record with fewer replies than this cannot say how many of them were interested. */
export const MIN_REPLIES_FOR_INTEREST = 20;

export type EvidenceAuthority =
  /** Measured on this plan's own implementation: it binds the estimate. */
  | 'TRANSFERABLE'
  /** A comparable implementation: it informs the estimate as a discounted observation. */
  | 'COMPARABLE'
  /** A different or defective implementation: it bounds the as-is floor, never the redesigned estimate. */
  | 'CONTEXT_ONLY'
  /** Too small to say anything. */
  | 'NOISE';

export interface EvidenceDefect {
  kind: 'LIST_QUALITY' | 'DIFFERENT_OFFER' | 'SMALL_SAMPLE' | 'FEW_REPLIES';
  sentence: string;
}

export interface EvidenceAssessment {
  authority: EvidenceAuthority;
  defects: EvidenceDefect[];
  /** What the record does answer, in one sentence. */
  answers: string;
  /** Why it does or does not bind a redesigned implementation. */
  sentence: string;
  bounceRate: number;
  replyRate: number;
}

const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;

/**
 * Judge an outreach record against the opening it would be applied to.
 * `opportunityId` null means "any cold-outreach opening" (the workspace-wide use).
 */
export function assessOutreachRecord(record: OutreachRecord, opportunityId: string | null = null): EvidenceAssessment {
  const bounceRate = record.sent > 0 ? record.bounced / record.sent : 0;
  const replyRate = record.sent > 0 ? record.replies / record.sent : 0;
  const defects: EvidenceDefect[] = [];
  if (record.sent < MIN_RECORD_SENDS) {
    defects.push({ kind: 'SMALL_SAMPLE', sentence: `${record.sent} sends is under the ${MIN_RECORD_SENDS} a reply rate needs` });
  }
  if (bounceRate > LIST_DEFECT_BOUNCE) {
    const worst = (record.campaigns ?? [])
      .filter((c) => c.sent > 0)
      .map((c) => `${c.name} ${pct(c.bounced / c.sent)}`)
      .join(', ');
    defects.push({
      kind: 'LIST_QUALITY',
      sentence: `${pct(bounceRate)} of sends bounced (over the ${pct(LIST_DEFECT_BOUNCE)} at which the list and the sender's reputation, not the market, are being measured)${worst ? `: ${worst}` : ''}`,
    });
  }
  const campaigns = record.campaigns ?? [];
  const matched = opportunityId === null ? 0 : campaigns.filter((c) => c.brainOwned && c.opportunityId === opportunityId).reduce((n, c) => n + c.sent, 0);
  // Brain's own campaigns are Brain's implementation; the owner's other campaigns are not.
  const allBrains = campaigns.length > 0 && campaigns.every((c) => c.brainOwned);
  if (matched === 0 && !allBrains) {
    const names = campaigns.filter((c) => !c.brainOwned).map((c) => c.name).filter(Boolean);
    defects.push({
      kind: 'DIFFERENT_OFFER',
      sentence: `measured on other offers, lists and copy${names.length ? ` (${names.slice(0, 6).join(', ')})` : ''}, not on the implementation being planned`,
    });
  }
  if (record.replies < MIN_REPLIES_FOR_INTEREST) {
    defects.push({ kind: 'FEW_REPLIES', sentence: `${record.replies} replies cannot say what share were interested` });
  }
  let authority: EvidenceAuthority;
  if (record.sent < MIN_RECORD_SENDS) authority = 'NOISE';
  else if (defects.some((d) => d.kind === 'LIST_QUALITY' || d.kind === 'DIFFERENT_OFFER')) authority = 'CONTEXT_ONLY';
  else authority = matched > 0 ? 'TRANSFERABLE' : 'COMPARABLE';
  const answers = `how the owner's earlier campaigns performed as they were run: ${record.replies} replies and ${record.opportunities} opportunities on ${record.sent} sends (${pct(replyRate)} reply, ${pct(bounceRate)} bounced)`;
  const sentence =
    authority === 'TRANSFERABLE'
      ? `It was measured on this opening's own campaign on a sound list, so it binds the estimate.`
      : authority === 'COMPARABLE'
        ? `It was measured on a sound list for a comparable offer, so it informs the estimate as a discounted observation.`
        : authority === 'NOISE'
          ? `It is too small to say anything about a reply rate.`
          : `It does not bind a redesigned implementation: ${defects.filter((d) => d.kind === 'LIST_QUALITY' || d.kind === 'DIFFERENT_OFFER').map((d) => d.sentence).join('; ')}. It is kept as the as-is floor: what the plan reaches if the new campaign performs no better than the old ones.`;
  return { authority, defects, answers, sentence, bounceRate, replyRate };
}

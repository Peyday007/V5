/**
 * Replies from the owner's Instantly unibox, as evidence on the deal they
 * answer (§94).
 *
 * A contact Brain made through Instantly is recorded with the lead's id as
 * its reference (`perform.ts` stores the provider receipt). A received email
 * on Brain's campaign carries that lead id, so the reply is matched to the
 * contact by a row, never by guessing from an address. Each becomes one
 * `BUYER_REPLIED` observation from the PROVIDER, keyed by the email id, so a
 * second pass records nothing twice. Auto-replies (out-of-office) are not a
 * buyer's answer and are skipped. `journey/learning.ts` turns these into the
 * measured reply rates the plan's quant engine uses in place of a sweep.
 *
 * Read-only toward Instantly: nothing is sent, marked or moved there.
 */
import { contactByReference } from '../../../repos/cashActions.ts';
import { recordObservation } from '../journey/deal.ts';
import { messagingConfig } from './config.ts';
import { ensureBrainCampaign, readInstantlyReplies } from './instantly.ts';
import type { FetchLike } from './http.ts';

export interface ReplySyncReport {
  read: number;
  recorded: number;
  unmatched: number;
  autoReplies: number;
  skipped: string | null;
}

export async function syncInstantlyReplies(projectId: string, options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {}): Promise<ReplySyncReport> {
  const report: ReplySyncReport = { read: 0, recorded: 0, unmatched: 0, autoReplies: 0, skipped: null };
  const config = messagingConfig(options.env ?? process.env);
  if (config.provider !== 'instantly' || !config.configured) {
    report.skipped = 'Instantly is not the configured messaging provider';
    return report;
  }
  // Only Brain's own campaign: the owner's other campaigns' replies are not Brain's deals.
  const campaign = await ensureBrainCampaign({ ...options, create: false });
  if (!campaign.ok) {
    report.skipped = campaign.reason;
    return report;
  }
  const replies = await readInstantlyReplies({ campaignId: campaign.id, ...options });
  if (!replies.ok) {
    report.skipped = replies.reason;
    return report;
  }
  for (const reply of replies.replies) {
    report.read += 1;
    if (reply.autoReply) {
      report.autoReplies += 1;
      continue;
    }
    const contact = reply.leadId ? await contactByReference(projectId, reply.leadId) : null;
    if (!contact) {
      report.unmatched += 1;
      continue;
    }
    const written = await recordObservation({
      opportunityId: contact.opportunityId,
      kind: 'BUYER_REPLIED',
      source: 'PROVIDER',
      evidenceRef: `instantly:email:${reply.emailId}`,
      channel: 'email (Instantly)',
      observedAt: reply.at ?? undefined,
      note: 'A reply in the Instantly unibox to the lead Brain added for this deal.',
      actorRef: 'BRAIN',
      requestKey: `observation:instantly:${reply.emailId}`,
    });
    if (written.ok && written.message === 'Recorded.') report.recorded += 1;
  }
  return report;
}

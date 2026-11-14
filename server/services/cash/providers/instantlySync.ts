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
 * A reply is also an answer when — and only when — Instantly states one: its
 * interest status on the email (`answerFromInterestStatus`) reads won, which
 * is a `BUYER_ACCEPTED`, or not interested / lost, which is a `BUYER_DECLINED`.
 * That is the provider's record, set in the unibox, never a reading of the
 * reply's words (§8). Each answer is one more PROVIDER observation keyed by the
 * email id and the kind, so a status set after the reply was first read is
 * still recorded on a later pass, and none is recorded twice. Instantly has no
 * counter-offer status, so a counter (which must carry the buyer's amount) is
 * never recorded from here.
 *
 * Read-only toward Instantly: nothing is sent, marked or moved there.
 */
import { contactByReference } from '../../../repos/cashActions.ts';
import { recordObservation } from '../journey/deal.ts';
import { messagingConfig } from './config.ts';
import { answerFromInterestStatus, ensureBrainCampaign, readInstantlyReplies } from './instantly.ts';
import type { FetchLike } from './http.ts';

export interface ReplySyncReport {
  read: number;
  recorded: number;
  /** Buyer answers the provider stated (accepted or declined), newly recorded on this pass. */
  answers: number;
  unmatched: number;
  autoReplies: number;
  skipped: string | null;
}

export async function syncInstantlyReplies(projectId: string, options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {}): Promise<ReplySyncReport> {
  const report: ReplySyncReport = { read: 0, recorded: 0, answers: 0, unmatched: 0, autoReplies: 0, skipped: null };
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
    const answer = answerFromInterestStatus(reply.interestStatus);
    if (answer) {
      const answered = await recordObservation({
        opportunityId: contact.opportunityId,
        kind: answer,
        source: 'PROVIDER',
        evidenceRef: `instantly:email:${reply.emailId}:i_status:${reply.interestStatus}`,
        channel: 'email (Instantly)',
        observedAt: reply.at ?? undefined,
        note: `Instantly's interest status on this reply (${reply.interestStatus}) states the buyer ${answer === 'BUYER_ACCEPTED' ? 'accepted' : 'declined'}.`,
        actorRef: 'BRAIN',
        requestKey: `observation:instantly:${reply.emailId}:${answer}`,
      });
      if (answered.ok && answered.message === 'Recorded.') report.answers += 1;
    }
  }
  return report;
}

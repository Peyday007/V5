/**
 * Talking to Russell about a site, and Brain doing the software work.
 *
 * ---------------------------------------------------------------------------
 * What this adds, and what it deliberately does not
 * ---------------------------------------------------------------------------
 *
 * The Software Factory already accepts an objective, plans it, implements it,
 * integrates it, has it reviewed by an independent session, repairs the
 * findings and opens a pull request. All of that is untouched. What was missing
 * was an *entrance*: the only way to reach it was the Build page, and a person
 * describing a change in a conversation got a conversation back.
 *
 * So this is one more entrance to machinery Steps 5 to 12C already built, and
 * it is not a second set of rules. There is no second submission path, no
 * second approval, no second campaign starter and no second authorization
 * check — `approveAndStartCampaign` is the one both entrances call, for the
 * reason it exists.
 *
 * ---------------------------------------------------------------------------
 * Discussing something is not asking for it to be done
 * ---------------------------------------------------------------------------
 *
 * This is the distinction the whole feature turns on, and it is drawn twice
 * rather than once, because either check alone would be wrong in a different
 * direction.
 *
 * **First, deterministically, on the person's own words.** `asksForExecution`
 * reads the message a person actually sent — not a worker's restatement of it,
 * which is the correction `shouldCapture` already carries. A remark about how
 * the checkout page feels is a remark; *"change the checkout page so the total
 * updates without a reload"* is a request. Narrow by construction, exactly like
 * the capture gate: its failure mode must stay *missing* a request, which a
 * later message can restate, rather than inventing one, which would put a
 * campaign card in front of somebody who was thinking out loud.
 *
 * **Second, structurally, by what a capture can actually cause.** Even when
 * both the gate and the model agree, the entire effect is an unauthorized row
 * in `russell_software_requests`. Nothing is submitted, no repository is
 * touched, no worker is fired and nothing is spent. A person authorizes it in
 * Needs You, and only then does anything reach the factory. That is what makes
 * "a model proposes, the server decides" true here rather than merely intended:
 * it is not a check inside the turn that could be forgotten, it is that the turn
 * has no other effect available to it.
 *
 * ---------------------------------------------------------------------------
 * Reporting back
 * ---------------------------------------------------------------------------
 *
 * `softwareForConversation` is a **projection**, in `pending.ts`'s shape and for
 * its reason: it writes nothing, derives on the read path, and reads the
 * campaign's state from `campaignBriefing` — the authoritative derivation Build
 * already renders — rather than composing a second opinion about the same
 * campaign. Two surfaces inferring their own status from the same rows is how a
 * person reads two different answers about one piece of work.
 */
import { createHash } from 'node:crypto';
import {
  captureSoftwareRequest,
  claimSoftwareRequest,
  declineSoftwareRequest,
  getSoftwareRequest,
  listSoftwareRequests,
  listSoftwareRequestsForConversation,
  recordSoftwareAuthorization,
  releaseSoftwareRequest,
} from '../../repos/russellSoftware.ts';
import { ContractError, submitObjective, submissionKeyFor } from '../factory/contract.ts';
import { approveAndStartCampaign } from '../factory/start.ts';
import { campaignBriefing } from '../factory/projections.ts';
import { getCampaign } from '../../repos/factory.ts';
import {
  ScopeError,
  describeBoundary,
  directoriesOf,
  resolveProjectScope,
} from '../factory/projectScope.ts';
import { listProjectRepositories } from '../../repos/factory.ts';
import { listRepositoryGrants } from '../factory/repositoryEnvelope.ts';
import type { CampaignBriefing } from '../factory/projections.ts';
import type { RussellSoftwareRequest } from '../../domain/types.ts';

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Verbs that mean *make this change*, asked of somebody.
 *
 * The same construction rule as `PROPOSAL_MARKERS` in `judgment.ts`, and the
 * same failure mode on purpose: the verb has to be an instruction to change
 * something, in a form addressed to Russell rather than reporting what already
 * happened. "We fixed the header last week" matches nothing, because the word
 * boundary excludes the past tense and nobody is being asked.
 */
const EXECUTION_MARKERS = [
  /\b(?:please\s+)?(?:go\s+(?:ahead\s+)?(?:and\s+)?)?(?:change|fix|add|remove|update|rename|refactor|implement|build|migrate|upgrade|delete|rewrite|replace)\b/i,
  /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:change|fix|add|remove|update|rename|refactor|implement|build|migrate|upgrade|delete|rewrite|replace)\b/i,
  /\b(?:make|get)\s+(?:it|the|this|that)\b.*\b(?:work|stop|start|show|hide|load|render|match)\b/i,
  /\bship\s+(?:a|an|the)\b/i,
];

/**
 * Phrasings that are *about* a change without asking for one.
 *
 * Checked first, because "I wonder whether we should rewrite the checkout page"
 * contains an execution verb and is plainly a thought rather than an
 * instruction. Getting this wrong in the permissive direction puts an
 * authorization card in front of somebody who was thinking aloud, which teaches
 * them to dismiss the cards — the same damage §29 records from a status that
 * contradicts the control beside it.
 */
const DELIBERATION_MARKERS = [
  /\b(?:i wonder|wondering|thinking about|thinking of|not sure whether|not sure if)\b/i,
  /\b(?:what|how) (?:would|might|could) it (?:take|look|mean)\b/i,
  /\b(?:one day|eventually|some ?day|at some point|in future|in the future)\b/i,
  /\bwould it be (?:possible|hard|worth)\b/i,
  /\b(?:do not|don'?t|no need to) (?:change|do|build|touch)\b/i,
];

/** Past-tense reports, which are neither a request nor an idea. */
const REPORT_MARKERS = [/\b(?:i|we|they)\s+(?:already\s+)?(?:changed|fixed|added|removed|updated|shipped|built)\b/i];

export interface ExecutionDecision {
  asks: boolean;
  /** Plain, and shown when Russell explains why it captured an idea instead. */
  reason: string;
}

/**
 * Did this message ask for a change to be made?
 *
 * Deliberation and past-tense reports lose to nothing: a message that reads as
 * either is not a request however many execution verbs it contains, because the
 * cost of a false positive here is a decision card nobody asked for and the
 * cost of a false negative is one more sentence from the person.
 */
export function asksForExecution(message: string): ExecutionDecision {
  const trimmed = message.trim();
  if (trimmed.length < 15) {
    return { asks: false, reason: 'too short to be a change request on its own' };
  }
  if (REPORT_MARKERS.some((pattern) => pattern.test(trimmed))) {
    return { asks: false, reason: 'it reports something already done' };
  }
  if (DELIBERATION_MARKERS.some((pattern) => pattern.test(trimmed))) {
    return { asks: false, reason: 'it weighs a change rather than asking for one' };
  }
  if (!EXECUTION_MARKERS.some((pattern) => pattern.test(trimmed))) {
    return { asks: false, reason: 'nothing here asks for a change to be made' };
  }
  return { asks: true, reason: 'it asks for a change to be made' };
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

export interface CaptureSoftwareOutcome {
  request: RussellSoftwareRequest | null;
  created: boolean;
  /** Why nothing was captured, when nothing was. */
  reason: string;
}

/**
 * Write down a software change somebody asked for, so a person can authorize it.
 *
 * The submission key is the factory's own — `submissionKeyFor(projectId,
 * objective)` — so this row and the change request it may eventually produce
 * agree about what "the same ask" means. Two people describing the same change
 * in two threads collide here; two *wordings* of the same change collide at the
 * factory, on the same key, when the second one is authorized.
 */
export async function captureSoftwareChange(input: {
  projectId: string;
  conversationId: string;
  messageId: string | null;
  /** The person's own words, which is what the gate judges. */
  askedText: string | null;
  title: string;
  objective: string;
  expectedOutcome: string;
}): Promise<CaptureSoftwareOutcome> {
  if (input.askedText === null) {
    /*
     * No question to judge is a broken link rather than a licence — the same
     * decision `applyValidated` makes for a candidate, for the same reason. A
     * change request with no reachable source message is provenance nobody can
     * check, sitting in front of a person as something to authorize.
     */
    return { request: null, created: false, reason: 'NO_SOURCE_MESSAGE' };
  }
  const decision = asksForExecution(input.askedText);
  if (!decision.asks) {
    return { request: null, created: false, reason: decision.reason };
  }

  const objective = input.objective.trim();
  const outcome = await captureSoftwareRequest({
    projectId: input.projectId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    title: input.title.trim(),
    objective,
    expectedOutcome: input.expectedOutcome.trim(),
    submissionKey: submissionKeyFor(input.projectId, objective),
  });
  return {
    request: outcome.request,
    created: outcome.created,
    reason: outcome.created ? 'captured' : 'already waiting for you',
  };
}

/* -------------------------------------------------------------------------- */
/* What a person is shown before they authorize                                */
/* -------------------------------------------------------------------------- */

export interface SoftwareRepositoryChoice {
  grantId: string;
  repositoryId: string;
  remote: string;
  defaultBranch: string;
  description: string;
  /** The exact scope a campaign here would run under, in globs. */
  scope: string[];
  /** The same thing in a sentence, composed by the server. */
  scopeSentence: string;
}

/**
 * The repositories this project may actually submit against, with the reach
 * each one would give.
 *
 * Built from the onboarding rows rather than from the envelope, because the
 * envelope says what the *factory* may be pointed at and this question is what
 * *this project* was given. A grant with no onboarding row for this project is
 * absent from the list rather than offered and then refused at submission.
 *
 * The scope travels with the choice rather than being described separately, so
 * the contract a person is shown and the contract the validator enforces are one
 * object — the manifest lesson, applied to an authorization card.
 */
export async function repositoryChoicesFor(projectId: string): Promise<SoftwareRepositoryChoice[]> {
  const grants = listRepositoryGrants();
  const rows = await listProjectRepositories(projectId);
  const out: SoftwareRepositoryChoice[] = [];
  for (const row of rows) {
    const grant = grants.find((candidate) => candidate.id === row.grantId);
    // A grant withdrawn in code leaves its onboarding row behind, and offering
    // it would be offering a repository `decideRepository` now refuses.
    if (!grant) continue;
    out.push({
      grantId: row.grantId,
      repositoryId: row.repositoryId,
      remote: grant.remote,
      defaultBranch: grant.defaultBranch,
      description: grant.description,
      scope: [...row.pathScope],
      scopeSentence:
        row.scopeKind === 'WHOLE_REPOSITORY'
          ? `Anywhere in ${row.repositoryId}.`
          : `Only ${directoriesOf(row.pathScope)
              .map((directory) => `${directory}/`)
              .join(', ')} in ${row.repositoryId}.`,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Authorization                                                               */
/* -------------------------------------------------------------------------- */

export type AuthorizeOutcome =
  | { ok: false; reason: string; detail?: unknown }
  | {
      ok: true;
      request: RussellSoftwareRequest;
      campaignId: string;
      changeRequestId: string;
      scope: string[];
      execution: string;
    };

/**
 * The one action that spends anything, and it belongs to a person.
 *
 * The caller has already established that this is a person with write access to
 * the project — this function is not the authorization and must not be mistaken
 * for it. What it is, is the sequence: claim the request, submit the objective
 * through the existing contract, start the campaign through the one starter, and
 * record the link back to the conversation.
 *
 * The claim comes first and the effects are on the far side of it, so two
 * clicks make one campaign. A refusal on the far side puts the request back
 * rather than leaving it marked authorized with nothing behind it: a card that
 * vanished is a decision nobody can retake.
 */
export async function authorizeSoftwareRequest(input: {
  requestId: string;
  grantId: string;
  userId: string;
  /** Optional; the repository's own default branch when absent. */
  baseBranch?: string | null;
  /** Optional narrowing *inside* the project's boundary. Never a widening. */
  mutationScope?: string[] | null;
  acceptanceConditions?: { statement: string; verification: string; mandatory?: boolean }[];
}): Promise<AuthorizeOutcome> {
  const request = await getSoftwareRequest(input.requestId);
  if (!request) return { ok: false, reason: 'No such software request.' };
  if (request.state === 'DECLINED') {
    return { ok: false, reason: 'That request was declined. Ask again in the conversation.' };
  }
  if (request.state === 'AUTHORIZED' && request.campaignId) {
    // Already done, by an earlier click or a retried request. Reported as
    // settled rather than as an error, and never as a second campaign.
    return {
      ok: true,
      request,
      campaignId: request.campaignId,
      changeRequestId: request.changeRequestId ?? '',
      scope: request.requestedScope ?? [],
      execution: 'already authorized',
    };
  }

  const choices = await repositoryChoicesFor(request.projectId);
  const choice = choices.find((candidate) => candidate.grantId === input.grantId);
  if (!choice) {
    /*
     * The same refusal an unknown repository gets. A person choosing from the
     * list this project was given cannot land here; anything that does named a
     * repository the project was not given, and saying which of the two it was
     * would describe the factory's reach to somebody who does not have it.
     */
    return {
      ok: false,
      reason:
        'That is not a repository this project has been given. Onboard it on Build → ' +
        'Repositories, where the directories it may change are declared too.',
    };
  }

  if (!(await claimSoftwareRequest(request.id))) {
    return { ok: false, reason: 'That request has already been answered.' };
  }

  try {
    const requested = input.mutationScope && input.mutationScope.length > 0
      ? input.mutationScope
      : undefined;
    const submitted = await submitObjective({
      projectId: request.projectId,
      objective: request.objective,
      expectedOutcome: request.expectedOutcome,
      repositoryRemote: choice.remote,
      baseBranch: input.baseBranch?.trim() || undefined,
      mutationScope: requested,
      acceptanceConditions: input.acceptanceConditions ?? [],
      submissionKey: request.submissionKey,
    });

    const started = await approveAndStartCampaign({
      changeRequestId: submitted.changeRequest.id,
      userId: input.userId,
    });
    if (!started.ok) {
      await releaseSoftwareRequest(request.id);
      return { ok: false, reason: started.reason };
    }

    const linked = await recordSoftwareAuthorization({
      id: request.id,
      grantId: choice.grantId,
      repositoryId: choice.repositoryId,
      baseBranch: submitted.changeRequest.baseBranch,
      requestedScope: submitted.changeRequest.mutationScope,
      changeRequestId: submitted.changeRequest.id,
      campaignId: started.campaign.id,
      authorizedByUserId: input.userId,
    });

    return {
      ok: true,
      request: linked ?? request,
      campaignId: started.campaign.id,
      changeRequestId: submitted.changeRequest.id,
      scope: submitted.changeRequest.mutationScope,
      execution: started.execution.note,
    };
  } catch (error: unknown) {
    await releaseSoftwareRequest(request.id);
    if (error instanceof ContractError || error instanceof ScopeError) {
      return { ok: false, reason: error.message, detail: error.detail };
    }
    throw error;
  }
}

export async function declineSoftware(input: {
  requestId: string;
  reason: string;
  userId: string;
}): Promise<{ ok: boolean; reason: string }> {
  const moved = await declineSoftwareRequest({
    id: input.requestId,
    reason: input.reason,
    userId: input.userId,
  });
  return moved
    ? { ok: true, reason: 'declined' }
    : { ok: false, reason: 'That request has already been answered.' };
}

/* -------------------------------------------------------------------------- */
/* Reporting back                                                              */
/* -------------------------------------------------------------------------- */

export interface SoftwareRequestView {
  request: RussellSoftwareRequest;
  /** The authoritative campaign state, or null before there is a campaign. */
  campaign: CampaignBriefing | null;
  /** The reviewable artifact, when there is one. */
  pullRequestUrl: string | null;
  /** One line for the conversation, composed from the rows above. */
  line: string;
  /** True when this is what a person has to answer next. */
  awaitingPerson: boolean;
}

/**
 * One request as a reader of the thread should see it.
 *
 * The campaign half is `campaignBriefing`'s, unchanged and not re-derived. The
 * only thing composed here is the sentence, and every branch of it resolves to a
 * state column, a blocker kind or a count of unit rows.
 */
async function viewOf(request: RussellSoftwareRequest): Promise<SoftwareRequestView> {
  if (request.state === 'PROPOSED') {
    return {
      request,
      campaign: null,
      pullRequestUrl: null,
      line: 'Waiting for you to authorize it. Nothing has been spent.',
      awaitingPerson: true,
    };
  }
  if (request.state === 'DECLINED') {
    return {
      request,
      campaign: null,
      pullRequestUrl: null,
      line: `You declined this${request.declineReason ? `: ${request.declineReason}` : '.'}`,
      awaitingPerson: false,
    };
  }

  const campaignId = request.campaignId;
  if (!campaignId) {
    /*
     * Authorized with no campaign behind it. `releaseSoftwareRequest` exists so
     * this should not happen; if it ever does, it is said rather than shown as
     * patience — the state §24 keeps having to correct.
     */
    return {
      request,
      campaign: null,
      pullRequestUrl: null,
      line: 'Authorized, but no campaign was recorded. Authorize it again.',
      awaitingPerson: true,
    };
  }

  const [briefing, campaign] = await Promise.all([
    campaignBriefing(campaignId),
    getCampaign(campaignId),
  ]);
  if (!briefing) {
    return {
      request,
      campaign: null,
      pullRequestUrl: null,
      line: 'Authorized. The campaign could not be read.',
      awaitingPerson: false,
    };
  }

  const progress =
    briefing.progress.kind === 'MILESTONE'
      ? `${briefing.progress.integratedUnits} of ${briefing.progress.totalUnits} units integrated`
      : briefing.progress.label;

  const line = briefing.blocker
    ? `Blocked: ${briefing.blocker.detail ?? briefing.blocker.kind}. ${briefing.blocker.remedy}`
    : briefing.personNeeded.needed
      ? briefing.personNeeded.detail
      : `${briefing.stage} (${progress})`;

  return {
    request,
    campaign: briefing,
    pullRequestUrl: campaign?.prUrl ?? null,
    line,
    awaitingPerson: briefing.personNeeded.needed,
  };
}

/** Everything this conversation asked for, and where each one got to. */
export async function softwareForConversation(
  conversationId: string,
): Promise<SoftwareRequestView[]> {
  const requests = await listSoftwareRequestsForConversation(conversationId);
  return Promise.all(requests.map(viewOf));
}

/** Everything in this project that a person still has to answer. */
export async function softwareNeedingPerson(projectId: string): Promise<SoftwareRequestView[]> {
  const requests = await listSoftwareRequests({
    projectId,
    states: ['PROPOSED', 'AUTHORIZED'],
  });
  const views = await Promise.all(requests.map(viewOf));
  return views.filter((view) => view.awaitingPerson);
}

/** Everything in this project, for the project-wide view. */
export async function softwareForProject(projectId: string): Promise<SoftwareRequestView[]> {
  const requests = await listSoftwareRequests({ projectId });
  return Promise.all(requests.map(viewOf));
}

/**
 * A stable id for one boundary declaration, so a card and an audit row can be
 * compared afterwards without storing the whole thing twice.
 */
export function scopeFingerprint(scope: readonly string[]): string {
  return createHash('sha256').update([...scope].sort().join('\n')).digest('hex').slice(0, 16);
}

export { describeBoundary, resolveProjectScope };

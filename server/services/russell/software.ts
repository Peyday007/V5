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
import { listTurns } from '../../repos/russellConversations.ts';
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
import { decideProjectAccess } from '../identity/policy.ts';
import { NEGATORS, clauseBefore } from './negation.ts';
import { projectNamedInReply, resolveSoftwareTarget } from './softwareTarget.ts';
import type { TargetDecision } from './softwareTarget.ts';
import type { Principal, RussellSoftwareRequest } from '../../domain/types.ts';

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Did this message ask Russell to change something?
 *
 * ---------------------------------------------------------------------------
 * The fifth widening, and why this one is not a sixth word added to a list
 * ---------------------------------------------------------------------------
 *
 * §24 records three of these in `judgment.ts` and §27 a fourth here: every time,
 * the *rule* the list was written to express was right and its **alphabet** was
 * short. `improve` was the fourth. Driving fifty ordinary sentences through the
 * gate found fifteen more in one pass — *"Move the phone number into the
 * header"*, *"Turn off the newsletter popup"*, *"Wire the booking button to the
 * calendar page"*, *"Sort that out for me on the homepage"* — and two sentences
 * it invented a request from, both negations: *"No need to fix the footer"* and
 * *"Please do not add anything else to the homepage"*.
 *
 * **Fifteen misses in one pass is not a short alphabet; it is the wrong shape.**
 * Adding fifteen words would leave the sixteenth for production to find. So what
 * changed is the structure, in three ways, and the vocabulary only came along
 * with it:
 *
 * 1. **A verb is strong or weak, and a weak one only counts in imperative
 *    position.** `fix` is an instruction wherever it appears; `set`, `move`,
 *    `handle` and `clean` are ordinary English until they open a sentence or
 *    follow *please* / *could you* / *let's*. That distinction is what lets the
 *    list hold the words people actually use without matching *"the address on
 *    the contact page is wrong"* or *"do you know how the form works"*.
 * 2. **Negation is scoped to the occurrence rather than to the message.** Every
 *    match is examined for a negator in its own clause, and the message asks for
 *    a change only if **some** occurrence is un-negated — so *"No need to fix the
 *    footer"* declines and *"Don't touch the pricing page, but do fix the
 *    footer"* still asks. A message-level negation flag would have got the
 *    second one wrong in the expensive direction.
 * 3. **Anaphora is answered by a row, never by a word.** *"Do that for the
 *    contact page too"* has no execution verb and cannot get one, because the
 *    verb is in the sentence before it. It is admitted only when this
 *    conversation **already holds a software request** — a referent Brain wrote
 *    down, in the shape §25 insists on: a row outranks prose, and *"do that"*
 *    with no *that* is not a request.
 *
 * **A closed list can never be complete over ordinary English, and that is why
 * the failure mode is fixed at *missing*.** A miss costs one more sentence from
 * the person and Russell says which sentence would work; an invention costs an
 * authorization card in front of somebody who was thinking aloud, which teaches
 * them to stop reading the cards — the damage §29 records from a status that
 * contradicts the control beside it. **Build never consults this gate at all**,
 * so there is always an entrance that cannot mis-read a sentence.
 */

/**
 * Verbs that are an instruction to change something wherever they appear.
 *
 * Grouped by what the change *does* rather than by whichever word turned up in a
 * bug report, because a list organised by accident is a list that grows by
 * accident. The word boundary is what keeps the past tense out: `improve` does
 * not match "improved", so *"we improved it last week"* reaches nothing here.
 */
const STRONG_VERBS = [
  // change what is already there
  'change', 'update', 'edit', 'adjust', 'tweak', 'improve', 'optimise', 'optimize',
  'refactor', 'rewrite', 'revise', 'redesign', 'restyle',
  // bring something into existence
  'add', 'create', 'implement', 'introduce',
  // take something away
  'remove', 'delete', 'uninstall',
  // put it somewhere else, or something else there
  'rename', 'migrate', 'upgrade', 'downgrade', 'convert',
  // make it work
  'fix', 'repair', 'unbreak', 'debug',
].join('|');

/**
 * Verbs and phrases that are an instruction **only in imperative position**.
 *
 * Every one of these is an ordinary noun, auxiliary or preposition somewhere in
 * English — a *set* of pages, a *point* about pricing, a *link* to the terms —
 * so matching them anywhere would invent requests out of description. In
 * imperative position they are unambiguous, and imperative position is exactly
 * what "an instruction addressed to Russell" means.
 */
const WEAK_VERBS = [
  'take care of', 'deal with', 'sort out', 'clean up', 'tidy up', 'turn on', 'turn off',
  'hook up', 'wire up', 'set up', 'swap out', 'roll back',
  'move', 'swap', 'replace', 'enable', 'disable', 'connect', 'wire', 'hook', 'link',
  'set', 'configure', 'point', 'tidy', 'sort', 'handle', 'split', 'merge', 'apply',
  'build', 'ship', 'drop', 'strip', 'hide', 'put',
  /*
   * "Show me the homepage" is a request to look at something, and it opens a
   * sentence exactly like an instruction does. The lookahead is narrower than
   * dropping the verb, which would lose "show the discount on the cart".
   */
  String.raw`show(?!\s+(?:me|us)\b)`,
].join('|');

/**
 * What puts a weak verb in imperative position.
 *
 * The start of the message, the start of a sentence, or a request frame that can
 * only be addressed to somebody. `and`/`also`/`then` are here because a second
 * instruction in one message is still an instruction.
 */
const IMPERATIVE_LEAD =
  String.raw`(?:^|[.!?;\n]\s*|\b(?:please|and|also|then|now|next|go ahead and|go and|` +
  String.raw`can you|could you|would you|will you|let'?s|let us|i need you to|i'?d like you to|` +
  String.raw`i would like you to|i want you to)\s+)`;

const EXECUTION_MARKERS = [
  new RegExp(`\\b(?:${STRONG_VERBS})\\b`, 'i'),
  new RegExp(`${IMPERATIVE_LEAD}(?:${WEAK_VERBS})\\b`, 'i'),
  /*
   * "Make the sidebar collapse on phones", "let's get that dropdown working".
   *
   * The completion is a *shape* rather than a word list — a participle, a
   * comparative, or one of the handful of bare states a page can be in — because
   * this is the one frame where the interesting word is never a verb the list
   * could hold. "Make it clear that we ship daily" reaches none of them and
   * declines, which is the safe direction.
   */
  /\b(?:make|get)\s+(?:it|the|this|that|them|those|these)\s+\S+.*\b(?:\w+(?:ing|er|ed)|work|stop|start|show|hide|load|render|match|fit|wrap|align|responsive|faster|visible|hidden|collapse|expand|scroll|gone)\b/i,
];

/**
 * Phrasings that are *about* a change without asking for one.
 *
 * Checked before anything else, because "I wonder whether we should rewrite the
 * checkout page" contains an execution verb and is plainly a thought.
 */
const DELIBERATION_MARKERS = [
  /\b(?:i wonder|wondering|thinking about|thinking of|not sure whether|not sure if)\b/i,
  /\b(?:what|how) (?:would|might|could) it (?:take|look|mean)\b/i,
  /\b(?:one day|eventually|some ?day|at some point|in future|in the future)\b/i,
  /\bwould it be (?:possible|hard|worth)\b/i,
  /\bis it worth\b/i,
];

/**
 * Asking for something to be left as it is.
 *
 * Separate from the scoped negation below because these name no verb to negate:
 * "leave the booking form alone" has nothing in it a per-occurrence rule could
 * find.
 */
const LEAVE_ALONE_MARKERS = [
  /\bleave\s+(?:it|them|that|this|the\s+\S+(?:\s+\S+)?)\s+(?:alone|as[- ]is|as it is|be)\b/i,
  /\b(?:no need|nothing) to (?:do|change|fix)\b/i,
];

/** Past-tense reports, which are neither a request nor an idea. */
const REPORT_MARKERS = [
  /\b(?:i|we|they)\s+(?:already\s+)?(?:changed|fixed|added|removed|updated|shipped|built|improved|moved|renamed)\b/i,
];

/**
 * A continuation of something already asked for.
 *
 * Admitted only against a referent that exists as a row — see the header. The
 * phrases are deliberately anaphoric rather than generic: "do that", not "do".
 */
const CONTINUATION_MARKERS = [
  /\b(?:do|apply|repeat)\s+(?:that|this|it|the same)\b/i,
  /\b(?:the\s+)?same\s+(?:thing|change|fix|again|goes for|for)\b/i,
  /\bwhat we (?:agreed|discussed|said)\b/i,
  /\b(?:as|like) (?:above|we discussed|we agreed|before)\b/i,
  /\b(?:that|this) one too\b/i,
];

/** Every place this message asks for something, negated or not. */
function executionOccurrences(text: string): number[] {
  const found: number[] = [];
  for (const marker of EXECUTION_MARKERS) {
    const global = new RegExp(marker.source, `${marker.flags.replace('g', '')}g`);
    for (const match of text.matchAll(global)) {
      if (match.index !== undefined) found.push(match.index);
    }
  }
  return found.sort((a, b) => a - b);
}

export interface ExecutionDecision {
  asks: boolean;
  /** Plain, and shown when Russell explains why it captured an idea instead. */
  reason: string;
}

/**
 * Context that can only come from rows.
 *
 * `hasPriorRequest` is whether this conversation already holds a software
 * request. It is what makes "do that for the contact page too" a request rather
 * than a sentence with a dangling pronoun, and it is read from the table rather
 * than inferred from the transcript — a row outranks prose, at the one place
 * where the prose genuinely does not contain the answer.
 */
export interface ExecutionContext {
  hasPriorRequest?: boolean;
}

/**
 * Did this message ask for a change to be made?
 *
 * Deliberation, past-tense reports and leave-it-alone lose to everything: a
 * message that reads as any of them is not a request however many execution
 * verbs it contains.
 */
export function asksForExecution(message: string, context: ExecutionContext = {}): ExecutionDecision {
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
  if (LEAVE_ALONE_MARKERS.some((pattern) => pattern.test(trimmed))) {
    return { asks: false, reason: 'it asks for something to be left as it is' };
  }

  /*
   * The referent comes first, and that ordering is the decision.
   *
   * "Apply the same to the quotes page" holds a weak verb in imperative
   * position and would otherwise be read as an instruction — but *the same as
   * what* is not in the sentence, so a capture would file an objective nobody
   * could act on. Anaphora is a property of the message rather than of its
   * verbs, so it is asked before them and it applies whichever verbs are there.
   */
  const anaphoric = CONTINUATION_MARKERS.some((pattern) => pattern.test(trimmed));
  if (anaphoric && !context.hasPriorRequest) {
    return {
      asks: false,
      reason: 'it refers back to a change, and nothing has been asked for in this conversation yet',
    };
  }

  const occurrences = executionOccurrences(trimmed);
  if (occurrences.length > 0) {
    const live = occurrences.filter((at) => !NEGATORS.test(clauseBefore(trimmed, at)));
    if (live.length === 0) {
      return { asks: false, reason: 'it asks for something not to be changed' };
    }
    return { asks: true, reason: 'it asks for a change to be made' };
  }

  if (anaphoric) {
    if (NEGATORS.test(trimmed)) {
      return { asks: false, reason: 'it asks for something not to be changed' };
    }
    return { asks: true, reason: 'it continues a change already asked for here' };
  }

  return { asks: false, reason: 'nothing here asks for a change to be made' };
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

export interface CaptureSoftwareOutcome {
  request: RussellSoftwareRequest | null;
  created: boolean;
  /** Why nothing was captured, when nothing was. */
  reason: string;
  /**
   * The question to put to the person, when the reason is that Brain will not
   * guess. Present only for an ambiguity a sentence from them settles.
   *
   * `RESOLVED` is excluded by the type rather than by a convention: a resolved
   * target has nothing to ask, and a field that could hold one would let a
   * reader print an empty question.
   */
  clarify?: Exclude<TargetDecision, { kind: 'RESOLVED' }>;
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
  /**
   * Who is asking, so a project named in the message can be resolved against
   * what they may actually read.
   *
   * Optional because the ambiguity check only ever *adds* a refusal: a caller
   * that cannot supply a principal loses a clarification, never a control. The
   * request is still filed against the conversation's own attachment, which is
   * the row the authorization comes from.
   */
  principal?: Principal;
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
  /*
   * The referent for an anaphoric ask, read from the table rather than from the
   * transcript.
   *
   * "Do that for the contact page too" is a request exactly when there is a
   * *that*, and the only trustworthy account of whether there is one is a row
   * Brain wrote. Reading it from the conversation's own prose would be asking
   * the sentence to vouch for itself, which is what §25 refuses one altitude up.
   */
  const priorRequests = await listSoftwareRequestsForConversation(input.conversationId);
  const decision = asksForExecution(input.askedText, {
    hasPriorRequest: priorRequests.length > 0,
  });
  if (!decision.asks) {
    return { request: null, created: false, reason: decision.reason };
  }

  /*
   * Which project this is about, before anything is written.
   *
   * A request is filed against a project, and the project decides which
   * repository and which directories the work may touch — so a request filed
   * against the wrong one is a change authorized for the wrong code, and it
   * looks healthy the whole way. When the message names a different project
   * this person can read, nothing is captured and the answer says what is
   * ambiguous. See `softwareTarget.ts`, and §25 for the same defect one
   * altitude away.
   */
  let projectId = input.projectId;
  if (input.principal) {
    const target = await resolveSoftwareTarget({
      principal: input.principal,
      attachedProjectId: input.projectId,
      askedText: input.askedText,
    });
    if (target.kind !== 'RESOLVED') {
      return { request: null, created: false, reason: target.kind, clarify: target };
    }
    /*
     * The resolved project, which is usually the thread's and is not always.
     *
     * The one case it differs is an explicit exclusion: the person ruled the
     * thread's project out in the same sentence and named exactly one place the
     * work goes. Filing against `input.projectId` there would file it against
     * the project they had just excluded — which is precisely the defect this
     * resolution exists to prevent, so reading the answer and then ignoring it
     * would be worse than never asking.
     */
    projectId = target.projectId;
  }

  return writeRequest({ ...input, projectId });
}

/** The write both entrances share, so a row can only be made one way. */
async function writeRequest(input: {
  projectId: string;
  conversationId: string;
  messageId: string | null;
  title: string;
  objective: string;
  expectedOutcome: string;
}): Promise<CaptureSoftwareOutcome> {
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

/**
 * Finish a request Brain refused, once the person supplies the missing word.
 *
 * ---------------------------------------------------------------------------
 * Why this is not the gate again
 * ---------------------------------------------------------------------------
 *
 * The gate answers *did this message ask for a change*. The message that asked
 * was the earlier one, and Brain refused it for one reason: it would not guess
 * which project. **"V4" is the answer to that question, and it is not a change
 * request** — it has no verb, names nothing to do, and is two characters long,
 * so `asksForExecution` correctly declines it and would go on declining it for
 * ever. Making the person repeat the whole instruction is the product asking
 * them to work around a check that has already been satisfied.
 *
 * So this is the *other* half of a question Brain itself asked: the ask is read
 * back from the row Brain wrote when it refused, the person's reply supplies
 * only the project, and the effect is the same `PROPOSED` row a capture makes.
 * Nothing about the authorization moves — the card, the repository choice, the
 * boundary and the person's approval are all exactly as they were.
 *
 * The project is re-resolved against the caller here rather than trusted from
 * the stored question, because the stored one is a record of what was offered
 * and access is a fact about now.
 */
export async function resolveClarifiedChange(input: {
  principal: Principal;
  conversationId: string;
  /** The message the answer arrived in, so the row points at the person. */
  messageId: string | null;
  projectId: string;
  ask: { title: string; objective: string; expectedOutcome: string };
}): Promise<CaptureSoftwareOutcome> {
  if (!decideProjectAccess(input.principal, input.projectId, 'READ').allowed) {
    /*
     * The same refusal a project that does not exist gives (invariant 23). A
     * question Brain asked cannot become a way to file work into somewhere the
     * asker cannot see.
     */
    return { request: null, created: false, reason: 'NO_SUCH_PROJECT' };
  }
  return writeRequest({
    projectId: input.projectId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    title: input.ask.title,
    objective: input.ask.objective,
    expectedOutcome: input.ask.expectedOutcome,
  });
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

/* -------------------------------------------------------------------------- */
/* A refusal a person can answer                                               */
/* -------------------------------------------------------------------------- */

/**
 * The question Brain is waiting on, when it declined to write a change down and
 * a sentence from the person is what would settle it.
 *
 * **Only the answerable refusals reach here, and that is the whole design.**
 * "It weighs a change rather than asking for one" is a correct refusal that
 * needs no answer — the person was thinking aloud and Russell replied in prose;
 * printing a prompt under it would be Brain nagging somebody for a decision they
 * did not ask to make. What does reach here is the case where they *did* ask and
 * the only thing missing is a word only they have: which project, or what "that"
 * refers to.
 *
 * §24 keeps recording the same defect — *a state that says waiting which nobody
 * can resolve is not waiting, it is stuck* — and `clarify` was one move from
 * being the next instance: `softwareTarget.ts` composed the question, `turn.ts`
 * carried it onto the message row, and **nothing read it**. A mechanism nothing
 * calls is not a mechanism.
 */
export type SoftwareClarificationKind =
  | 'AMBIGUOUS_PROJECT'
  | 'EXCLUDED_PROJECT'
  | 'NO_PROJECT'
  | 'NO_REFERENT';

export interface SoftwareClarification {
  kind: SoftwareClarificationKind;
  /** The server's own sentence. The client renders it and composes nothing. */
  question: string;
}

/** The refusal reasons a person can act on, and what to say about each. */
const ANSWERABLE: Record<string, { kind: SoftwareClarificationKind; fallback: string }> = {
  AMBIGUOUS: {
    kind: 'AMBIGUOUS_PROJECT',
    fallback:
      'You named more than one project, so I have not written anything down. Say which one the ' +
      'change belongs to and I will.',
  },
  EXCLUDED: {
    kind: 'EXCLUDED_PROJECT',
    fallback:
      'You said not to change this project, and I have not written anything down. Say which ' +
      'project the change belongs in and I will.',
  },
  NO_PROJECT: {
    kind: 'NO_PROJECT',
    fallback:
      'I need to know which project this belongs to before I can write it down — that is what ' +
      'decides which repository it may change.',
  },
  NO_PROJECT_ATTACHED: {
    kind: 'NO_PROJECT',
    fallback:
      'This conversation is not attached to a project yet, and the project is what decides which ' +
      'repository a change may touch. Tell me which site this is about.',
  },
  'it refers back to a change, and nothing has been asked for in this conversation yet': {
    kind: 'NO_REFERENT',
    fallback:
      'You have asked me to do the same again, and nothing has been asked for in this ' +
      'conversation yet — so I do not know what "that" is. Say what should change and I will ' +
      'write it down.',
  },
};

/** The ask Brain refused, kept so a one-word answer can finish it. */
export interface PendingAsk {
  title: string;
  objective: string;
  expectedOutcome: string;
}

export interface OutstandingClarification {
  /** The message the refusal was recorded on. */
  messageId: string;
  at: string;
  kind: SoftwareClarificationKind;
  question: string;
  /**
   * The request Brain would have written, if the person had answered first.
   *
   * Null for a refusal there is nothing to resume — `NO_REFERENT` is a question
   * about *what* should change, and an ask reconstructed from a sentence that
   * pointed at nothing would be Brain finishing somebody's thought.
   */
  ask: PendingAsk | null;
  /** The projects the question offered, when it offered a list. */
  choices: { id: string; name: string }[];
  /**
   * The projects the original request ruled out.
   *
   * Carried separately from `choices` because the two answer different
   * questions, and because an empty `choices` must never read as *anything
   * goes*: a question that named no candidates still remembers what the request
   * excluded, and no answer to it may select one of those.
   */
  excluded: { id: string; name: string }[];
}

function askFrom(value: unknown): PendingAsk | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
  const objective = typeof record['objective'] === 'string' ? record['objective'].trim() : '';
  const expectedOutcome =
    typeof record['expectedOutcome'] === 'string' ? record['expectedOutcome'].trim() : '';
  if (!title || !objective || !expectedOutcome) return null;
  return { title, objective, expectedOutcome };
}

function choicesFrom(value: unknown): { id: string; name: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { id: string; name: string }[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : '';
    const name = typeof record['name'] === 'string' ? record['name'] : '';
    if (id && name) out.push({ id, name });
  }
  return out;
}

/**
 * The question this conversation is waiting on, and everything needed to answer
 * it — one derivation, because the two readers must not disagree.
 *
 * `softwareClarificationFor` shows a person the sentence; `answerClarification`
 * finishes the request behind it. If those read the message rows separately,
 * one would eventually show a question the other had already settled, which is
 * the status-contradicting-the-control defect §29 records.
 */
export async function outstandingClarification(
  conversationId: string,
): Promise<OutstandingClarification | null> {
  const [turns, requests] = await Promise.all([
    listTurns(conversationId),
    listSoftwareRequestsForConversation(conversationId),
  ]);

  let latest: OutstandingClarification | null = null;
  for (const turn of turns) {
    const produced = turn.produced as Record<string, unknown>;
    if (produced['softwareDeclined'] !== true) continue;
    const reason = typeof produced['gateReason'] === 'string' ? produced['gateReason'] : '';
    const answerable = ANSWERABLE[reason];
    if (!answerable) continue;
    const asked =
      typeof produced['clarify'] === 'string' && produced['clarify'].trim().length > 0
        ? produced['clarify'].trim()
        : answerable.fallback;
    latest = {
      messageId: turn.id,
      at: turn.createdAt,
      kind: answerable.kind,
      question: asked,
      ask: askFrom(produced['pendingAsk']),
      choices: choicesFrom(produced['clarifyChoices']),
      excluded: choicesFrom(produced['clarifyExcluded']),
    };
  }
  if (!latest) return null;
  const refusal = latest;

  /*
   * A change captured after the refusal answers it, ordered by the
   * conversation rather than by the clock where the conversation can say.
   *
   * This compared `createdAt > refusal.at`, and both are ISO-8601 to the
   * millisecond: a capture written in the *same* millisecond as the refusal
   * it answers compared as not-after, so the question stayed on screen after
   * the person had settled it — §29's status-contradicting-the-control defect,
   * reached by nothing but machine speed. It passed locally and failed in CI,
   * which is the whole tell.
   *
   * The conversation's own order is the answer where both rows carry a
   * message: `listTurns` is ordered, so a request captured from a *later* turn
   * than the refused one settles it and one from an earlier turn is a
   * different ask. A request with no message — a capture from a path that is
   * not a turn — has only the clock, and there `>=` is right rather than
   * generous: **a refusal captured nothing**, so any request at that same
   * instant is necessarily a different and successful capture.
   */
  const turnIndex = new Map(turns.map((turn, index) => [turn.id, index]));
  const refusedAt = turnIndex.get(refusal.messageId) ?? -1;
  const superseded = requests.some((request) => {
    const at = request.messageId === null ? undefined : turnIndex.get(request.messageId);
    return at === undefined ? request.createdAt >= refusal.at : at > refusedAt;
  });
  return superseded ? null : refusal;
}

/**
 * The one thing Brain declined to guess, in the server's own words.
 *
 * **Only the answerable refusals reach here, and that is the whole design.**
 * "It weighs a change rather than asking for one" is a correct refusal that
 * needs no answer — the person was thinking aloud and Russell replied in prose;
 * printing a prompt under it would be Brain nagging somebody for a decision they
 * did not ask to make. What does reach here is the case where they *did* ask and
 * the only thing missing is a word only they have: which project, or what "that"
 * refers to.
 *
 * §24 keeps recording the same defect — *a state that says waiting which nobody
 * can resolve is not waiting, it is stuck* — and `clarify` was one move from
 * being the next instance: `softwareTarget.ts` composed the question, `turn.ts`
 * carried it onto the message row, and **nothing read it**. A mechanism nothing
 * calls is not a mechanism.
 */
export async function softwareClarificationFor(
  conversationId: string,
): Promise<SoftwareClarification | null> {
  const outstanding = await outstandingClarification(conversationId);
  return outstanding ? { kind: outstanding.kind, question: outstanding.question } : null;
}

/**
 * Answer the question, if this message answers it.
 *
 * Deterministic and narrow: it fires only when a clarification is outstanding,
 * the refusal left an ask to resume, and the reply names **exactly one**
 * readable project. A reply that names none, or two, leaves the question exactly
 * where it was — which is the honest outcome, because the alternative is
 * choosing for somebody who has just told you they are choosing.
 *
 * It is not a second capture path: the row is written by `writeRequest`, the one
 * function that writes them, and the person still authorizes it.
 */
export async function answerClarification(input: {
  principal: Principal;
  conversationId: string;
  replyText: string | null;
  messageId: string | null;
}): Promise<{
  resolved: boolean;
  projectId?: string;
  projectName?: string;
  request?: RussellSoftwareRequest | null;
  created?: boolean;
  /** Present when a question is outstanding and this reply did not settle it. */
  stillAsking?: string;
}> {
  const reply = (input.replyText ?? '').trim();
  if (!reply) return { resolved: false };

  const outstanding = await outstandingClarification(input.conversationId);
  if (!outstanding || !outstanding.ask) return { resolved: false };

  const chosen = await projectNamedInReply({
    principal: input.principal,
    replyText: reply,
    choices: outstanding.choices,
    excluded: outstanding.excluded,
  });
  if (!chosen) return { resolved: false, stillAsking: outstanding.question };

  const outcome = await resolveClarifiedChange({
    principal: input.principal,
    conversationId: input.conversationId,
    messageId: input.messageId,
    projectId: chosen.id,
    ask: outstanding.ask,
  });
  if (!outcome.request) return { resolved: false, stillAsking: outstanding.question };
  return {
    resolved: true,
    projectId: chosen.id,
    projectName: chosen.name,
    request: outcome.request,
    created: outcome.created,
  };
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

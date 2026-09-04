/**
 * Whether something said is worth capturing, and what Russell thinks of it.
 *
 * Two obligations pull against each other here and both matter.
 *
 * **Not everything is a candidate.** Casual, social, irrelevant and
 * already-answered remarks stay conversation. A Brain that turned every
 * utterance into a tracked idea would produce a backlog nobody asked for and
 * would make its own ranking meaningless — the point of a priority is that most
 * things do not have one.
 *
 * **A meaningful idea is captured without being asked.** "Implement this visual
 * builder" is a candidate even though nobody said the word research, and
 * Russell is expected to have an opinion about it — including the opinion that
 * it should not be built yet.
 *
 * The deterministic rules below decide the first question and are intentionally
 * conservative: they capture what looks like a proposal or an open question,
 * and they do not try to be clever. A model's structured proposal can capture
 * things these rules miss, and it is validated against the same authority and
 * scope checks. Nothing here decides *authorization*; that has already happened.
 */
import {
  createCandidate,
  findByFingerprint,
  getCandidate,
  mergeCandidate,
  recordJudgment,
} from '../../repos/russellCandidates.ts';
import type {
  CandidatePriority,
  CandidateState,
  RussellCandidate,
  RussellVisibility,
} from '../../domain/types.ts';

/**
 * Phrases that make a message a proposal rather than a remark.
 *
 * Kept small and readable on purpose. This is a cheap first pass whose failure
 * mode should be *missing* a candidate — which a later message or a model
 * proposal can still capture — rather than inventing one, which fills a backlog
 * with noise nobody will clear.
 */
const PROPOSAL_MARKERS = [
  /\b(?:should|could|can) we\b/i,
  /\b(?:let'?s|lets)\b/i,
  /\bwe (?:should|need to|ought to|have to)\b/i,
  /\b(?:build|implement|add|create|design|research|investigate|look into|find out)\b/i,
  /\bwhat about\b/i,
  /\bidea:/i,
  /\bworth (?:doing|checking|looking)\b/i,
];

/** Openers that mark a genuine unresolved question about the work. */
const QUESTION_MARKERS = [
  /\b(?:do|does|is|are|must|should|can|could|would|will)\b.*\?/i,
  /\b(?:what|which|why|how|when|where|who)\b.*\?/i,
];

/** Things that are conversation and stay conversation. */
const SOCIAL_MARKERS = [
  /^\s*(?:hi|hey|hello|thanks|thank you|cheers|ok|okay|cool|nice|great|morning|good morning)\b/i,
  /^\s*(?:how are you|how's it going|hows it going)\b/i,
];

export interface CaptureDecision {
  capture: boolean;
  /** Plain, and shown when Russell explains why it did nothing. */
  reason: string;
}

/**
 * Is this worth capturing at all?
 *
 * Social first, because "thanks, should we look at the money model?" is both,
 * and the proposal is what matters. Short fragments are not captured: an idea
 * has to be statable, and a three-word remark usually is not one.
 */
export function shouldCapture(message: string): CaptureDecision {
  const trimmed = message.trim();
  if (trimmed.length < 12) {
    return { capture: false, reason: 'too short to be an idea on its own' };
  }
  const hasProposal = PROPOSAL_MARKERS.some((pattern) => pattern.test(trimmed));
  const hasQuestion = QUESTION_MARKERS.some((pattern) => pattern.test(trimmed));
  if (!hasProposal && !hasQuestion) {
    const social = SOCIAL_MARKERS.some((pattern) => pattern.test(trimmed));
    return {
      capture: false,
      reason: social ? 'conversational, with nothing to act on' : 'nothing here proposes work',
    };
  }
  if (!hasProposal && hasQuestion && SOCIAL_MARKERS.some((p) => p.test(trimmed))) {
    return { capture: false, reason: 'conversational, with nothing to act on' };
  }
  return { capture: true, reason: hasProposal ? 'it proposes work' : 'it asks something unresolved' };
}

export interface CaptureOutcome {
  candidate: RussellCandidate | null;
  /** True when this collided with an existing idea rather than making a new one. */
  merged: boolean;
  reason: string;
}

/**
 * Capture an idea, or fold it into the one that already exists.
 *
 * The cheap deterministic key is tried first, inside the same scope. Two
 * identical asks — including two arriving at the same moment — therefore land
 * on one canonical candidate without any semantic comparison being needed, and
 * a merge is a pointer that a person can undo rather than a deletion.
 *
 * Scope is passed through rather than derived, because a candidate inherits the
 * most restrictive scope that contributed to it: an idea from a private thread
 * is private even when the project it is about is shared.
 */
export async function capture(input: {
  title: string;
  statement: string;
  projectId: string | null;
  visibility: RussellVisibility;
  conversationId?: string | null;
  sourceMessageId?: string | null;
}): Promise<CaptureOutcome> {
  const candidate = await createCandidate(input);

  /*
   * Look *after* creating, not before.
   *
   * Checking first and inserting second leaves a window, and a test found it
   * immediately: two equivalent messages arriving together both looked, both
   * saw nothing, and both created a candidate. Creating first and then asking
   * "is there an earlier row with this meaning?" has no window — both racers
   * exist by the time either asks, both see the same earliest row under a
   * stable `(created_at, id)` order, and the later one folds into it.
   *
   * The loser of that comparison is whichever sorts second, which is a decision
   * the database makes rather than one either caller supplies.
   */
  const existing = await findByFingerprint({
    projectId: input.projectId,
    fingerprint: candidate.fingerprint,
    visibility: input.visibility,
    excludeId: candidate.id,
  });

  if (existing && isEarlier(existing, candidate)) {
    const ok = await mergeCandidate({
      candidateId: candidate.id,
      canonicalId: existing.id,
      method: 'FINGERPRINT',
      reason: 'the same idea, worded the same way',
    });
    if (ok) {
      return {
        candidate: await getCandidate(existing.id),
        merged: true,
        reason: 'this is already on the list',
      };
    }
  }

  return { candidate, merged: false, reason: 'captured' };
}

/** Stable ordering, matching the one the lookup uses. */
function isEarlier(a: RussellCandidate, b: RussellCandidate): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
  return a.id < b.id;
}

export interface JudgmentInputs {
  /** Does something else have to happen before this can work? */
  blockedBy?: string | null;
  /** Accepted knowledge that supports it. */
  supporting?: string[];
  /** Accepted knowledge that argues against it. */
  contradicting?: string[];
  /** True when the archive already answers the question behind it. */
  alreadyAnswered?: boolean;
  /** True when a cheap probe could settle the uncertainty. */
  cheapToReduce?: boolean;
  /** How much this would move the project's actual goal, 0..100. */
  expectedValue?: number;
}

export interface Judgment {
  priority: CandidatePriority;
  state: CandidateState;
  reason: string;
  inputs: JudgmentInputs;
}

/**
 * Russell's own opinion, from structured inputs rather than from tone.
 *
 * The order of the tests is the order of the objections, and the first one that
 * fires decides — which is what makes the reason true rather than a summary of
 * several half-reasons.
 *
 * The case that matters most is the second: **an idea whose dependency is not
 * ready is parked, and says so.** That is the "this should not be built yet"
 * judgment the product is supposed to be capable of, and it is a stored
 * decision with a stated dependency rather than a sentence in a reply.
 */
export function judge(inputs: JudgmentInputs): Judgment {
  if (inputs.alreadyAnswered) {
    return {
      priority: 'PARKED',
      state: 'REJECTED',
      reason: 'the project already answers this, so researching it would spend allowance to learn what it knows',
      inputs,
    };
  }
  if (inputs.blockedBy) {
    return {
      priority: 'PARKED',
      state: 'PARKED',
      reason: `this depends on ${inputs.blockedBy}, which is not ready — building it now would mostly produce a shell`,
      inputs,
    };
  }
  if ((inputs.contradicting?.length ?? 0) > 0) {
    return {
      priority: 'EXPLORE',
      state: 'CAPTURED',
      reason: 'what the project already believes argues against this, so it is worth a cheap look before anything larger',
      inputs,
    };
  }
  if (inputs.cheapToReduce) {
    return {
      priority: 'EXPLORE',
      state: 'CAPTURED',
      reason: 'the uncertainty here is cheap to reduce, so a bounded look comes before committing capacity',
      inputs,
    };
  }
  const value = inputs.expectedValue ?? 50;
  if (value >= 80) {
    return {
      priority: 'MUST_DO',
      state: 'QUEUED',
      reason: 'other work depends on settling this, so it comes first',
      inputs,
    };
  }
  if (value >= 60) {
    return {
      priority: 'BIG_MOVE',
      state: 'QUEUED',
      reason: 'this could change what the project is able to do, rather than only strengthening it',
      inputs,
    };
  }
  return {
    priority: 'WORTH_DOING',
    state: 'QUEUED',
    reason: 'useful strengthening work with nothing blocking it',
    inputs,
  };
}

/** Apply a judgment to a candidate, keeping the structured inputs beside it. */
export async function applyJudgment(input: {
  candidateId: string;
  judgment: Judgment;
  ordinal?: number | null;
  confidence?: number | null;
}): Promise<boolean> {
  return recordJudgment({
    candidateId: input.candidateId,
    state: input.judgment.state,
    priority: input.judgment.priority,
    ordinal: input.ordinal ?? null,
    confidence: input.confidence ?? null,
    reason: input.judgment.reason,
    judgment: { ...input.judgment.inputs },
    supporting: input.judgment.inputs.supporting ?? [],
    contradicting: input.judgment.inputs.contradicting ?? [],
  });
}

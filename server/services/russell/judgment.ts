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
import { clearsFloor } from './similarity.ts';
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
  /*
   * Asking for it directly, which the list had every hedged form of and not
   * the plain one.
   *
   * It held "worth checking" but not "check", and "look into" but not "see
   * whether" — so a person writing *"Please check something for me … Go and
   * see whether that holds for Michigan"* was declined with "nothing here
   * proposes work". Production did exactly that on 2026-09-10, and a direct
   * request to check something is the clearest proposal of work there is.
   *
   * Deliberately narrow, because this list's failure mode should stay
   * *missing* a candidate rather than inventing one: the verb has to be asked
   * of somebody, or followed by the thing to be established. "I checked it
   * yesterday" matches neither — the word boundary excludes "checked" — and
   * "please look at this file" matches neither, because bare `look` is not in
   * the second alternation.
   *
   * **And `establish`, which is the sentence the comment above describes.**
   * The rule it states is *"the verb has to be asked of somebody, or followed
   * by the thing to be established"* — and the verb for establishing something
   * was not in either alternation, so production declined *"Please go and
   * establish, county by county for Michigan, how long after recording a new
   * document becomes available electronically"* on 2026-09-11 with "nothing
   * here proposes work". That is the third time this list has been the thing,
   * and each time it has been the same defect: a direct request for work, in a
   * verb the list happened not to hold.
   *
   * `determine` joins it for the same reason and no further. The failure mode
   * is unchanged: "we established that yesterday" matches neither, because the
   * word boundary excludes "established" and it is not asked of anybody.
   */
  /\b(?:please|can you|could you|would you)\s+(?:go\s+(?:and\s+)?)?(?:check|verify|confirm|establish|determine|look\s+(?:into|up)|find\s+out|see)\b/i,
  /\b(?:check|verify|confirm|establish|determine|find\s+out|look\s+up|see)\s+(?:whether|if)\b/i,
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
  /**
   * The candidate a worker that read both says this repeats.
   *
   * A claim, never an instruction. It is re-resolved against rows, held to the
   * same scope every other comparison here uses, and put under
   * `clearsFloor` before anything is merged.
   */
  duplicateOf?: string | null;
}): Promise<CaptureOutcome> {
  const candidate = await createCandidate(input);

  /*
   * Look *after* creating, not before, and ask which row was written first.
   *
   * Checking first and inserting second leaves a window, and a test found it
   * immediately: two equivalent messages arriving together both looked, both
   * saw nothing, and both created a candidate.
   *
   * The obvious repair — create, then ask whether an *earlier* row exists —
   * has its own flaw, which a second test found: with equal timestamps the
   * tiebreak fell to a random id, so the row that truly arrived first could
   * sort second, decline to merge, and leave two canonical candidates for one
   * idea.
   *
   * So the question is not "is there an earlier one?" but "which one is the
   * earliest?" — asked by every caller, including about itself. All of them get
   * the same answer because it is insertion order, exactly one of them *is*
   * that row, and every other folds into it.
   */
  const earliest = await findByFingerprint({
    projectId: input.projectId,
    fingerprint: candidate.fingerprint,
    visibility: input.visibility,
  });

  if (earliest && earliest.id !== candidate.id) {
    const ok = await mergeCandidate({
      candidateId: candidate.id,
      canonicalId: earliest.id,
      method: 'FINGERPRINT',
      reason: 'the same idea, worded the same way',
    });
    if (ok) {
      return {
        candidate: await getCandidate(earliest.id),
        merged: true,
        reason: 'this is already on the list',
      };
    }
  }

  /*
   * The same idea in different words.
   *
   * The fingerprint above is exact by construction, so it cannot see a
   * rewording — and a rewording is the ordinary case, not the exotic one. What
   * sees it is the worker that read the conversation and the list of ideas
   * already open in this project, and named one.
   *
   * That is a model's opinion, so it decides nothing on its own (§8). Three
   * things have to agree before a merge happens, and each is checked here
   * against rows rather than taken from the proposal:
   *
   *   1. the named id resolves, in **this** scope — the same project and the
   *      same visibility `findByFingerprint` uses, for the same reason: a
   *      merge that reached across scopes would confirm the existence of a
   *      private candidate to somebody who cannot read it;
   *   2. it is not this candidate, and not one already merged away, so no
   *      chain and no cycle;
   *   3. the two statements clear `SEMANTIC_MERGE_FLOOR` — the guard that
   *      stops a confident model folding two unrelated ideas into one.
   *
   * A failure at any of them leaves both candidates standing. Nothing is
   * refused and nothing is lost: the capture already happened, and the reason
   * records that a merge was proposed and why the server did not make it.
   */
  if (input.duplicateOf && input.duplicateOf !== candidate.id) {
    const named = await getCandidate(input.duplicateOf);
    const inScope =
      named !== null &&
      named.projectId === input.projectId &&
      named.visibility === input.visibility &&
      named.state !== 'MERGED';

    if (!inScope) {
      return {
        candidate,
        merged: false,
        reason: 'captured; the idea it was said to repeat is not one that can be merged into',
      };
    }

    const floor = clearsFloor(candidate.statement, named.statement);
    if (!floor.ok) {
      return {
        candidate,
        merged: false,
        reason: `captured; not merged because ${floor.reason}`,
      };
    }

    const ok = await mergeCandidate({
      candidateId: candidate.id,
      canonicalId: named.id,
      method: 'SEMANTIC',
      reason: `the same question in different words — ${floor.reason}`,
    });
    if (ok) {
      return {
        candidate: await getCandidate(named.id),
        merged: true,
        reason: 'this is already on the list, asked another way',
      };
    }
  }

  return { candidate, merged: false, reason: 'captured' };
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

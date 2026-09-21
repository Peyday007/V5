/**
 * What the owner said, kept as evidence rather than turned into a rule.
 *
 * ---------------------------------------------------------------------------
 * The strongest evidence, and the easiest to ruin
 * ---------------------------------------------------------------------------
 *
 * "Make this smaller." "Bring that back but change this." "Imagery needs more
 * emphasis." "I preferred version 2." These are the highest-quality design
 * signal this kernel will ever receive, and the cycle the owner described is
 * what happens when they are mishandled in either direction:
 *
 *   - **Under-applied**, and the same correction has to be given again on the
 *     next screen, for ever. That is the loop as it stands today.
 *   - **Over-applied**, and *something useful gets removed* — a fix made for one
 *     card becomes a rule that strips four others.
 *
 * So the whole of this module is about scope. A correction is recorded at the
 * scope it was *given* at, that scope never widens on its own, and becoming a
 * rule is a second decision with its own refusals (`proposePatternFromCorrection`).
 *
 * ---------------------------------------------------------------------------
 * Three things it will not do
 * ---------------------------------------------------------------------------
 *
 * **It does not paraphrase.** `correction` is their words, verbatim. A
 * paraphrase of a correction is a correction somebody else made, and the lesson
 * Brain took is kept in a separate column so the two can be told apart — the
 * same separation §11 draws between a passage and a claim about it.
 *
 * **It does not guess the scope silently.** `suggestScope` exists and returns a
 * *suggestion with its reasoning*, which a person may take or replace. What it
 * must never do is default quietly to the convenient answer, because the
 * convenient answer is always the wider one.
 *
 * **It does not accept a correction about nothing.** A correction with no
 * before-capture is allowed — the owner may be talking about the product in
 * general — but one that names a surface it cannot resolve is refused, because
 * a lesson filed against a screen that does not exist will never be retrieved
 * and will look like knowledge that is being applied.
 */
import type {
  DesignConfidence,
  DesignCorrection,
  DesignScope,
} from '../../domain/design.ts';
import { SCOPE_RANK, scopeNeedsRef } from '../../domain/design.ts';
import {
  getCapture,
  getSurface,
  recordCorrection,
  setCorrectionLesson,
} from '../../repos/design.ts';

export interface RecordOwnerCorrectionInput {
  /** Their words. Stored verbatim. */
  correction: string;
  /** The screen it is about, when it is about one. */
  surfaceKey: string | null;
  /** The renders they were comparing, when they were comparing two. */
  beforeCaptureId: string | null;
  afterCaptureId: string | null;
  /** The parts of the interface named, as selectors or component names. */
  components: string[];
  /** How far this reaches. A person's decision; `suggestScope` only advises. */
  scope: DesignScope;
  scopeRef: string | null;
  confidence: DesignConfidence;
  /** What Brain took from it. Optional now, settable later. */
  lesson: string | null;
  /** From the authenticated principal. Never a field on the request. */
  recordedByUserId: string;
}

export type RecordCorrectionOutcome =
  | { ok: true; correction: DesignCorrection }
  | { ok: false; refusal: string };

/**
 * Record one correction.
 *
 * Every refusal here is about the correction being *findable later*. A lesson
 * nothing can retrieve is worse than no lesson, because the kernel will report
 * that it learned something.
 */
export async function recordOwnerCorrection(
  input: RecordOwnerCorrectionInput,
): Promise<RecordCorrectionOutcome> {
  const words = input.correction.trim();
  if (words.length === 0) {
    return { ok: false, refusal: 'A correction with no words in it is not a correction.' };
  }

  if (input.surfaceKey !== null && !(await getSurface(input.surfaceKey))) {
    return {
      ok: false,
      refusal:
        `No surface is registered as ${input.surfaceKey}. A correction filed against a screen that ` +
        'does not exist would never be retrieved, and would look like knowledge being applied.',
    };
  }

  if (scopeNeedsRef(input.scope) && !input.scopeRef) {
    return {
      ok: false,
      refusal:
        `A ${input.scope} correction has to name what it is about. Without that it either reaches ` +
        'nothing or reaches everything, and the second is how one card’s fix strips four others.',
    };
  }

  /*
   * A capture id that does not resolve is refused rather than nulled.
   *
   * "I preferred version 2" resolves to two hashes or it resolves to nothing,
   * and a correction that quietly lost one of its two pictures would be a
   * comparison nobody can check afterwards — `design_approvals`' own argument,
   * at the other end of the same evidence chain.
   */
  for (const [label, id] of [
    ['before', input.beforeCaptureId],
    ['after', input.afterCaptureId],
  ] as const) {
    if (id !== null && !(await getCapture(id))) {
      return {
        ok: false,
        refusal:
          `The ${label} render ${id} is not a capture Brain holds. A correction comparing two ` +
          'versions has to resolve to both, or there is nothing to compare later.',
      };
    }
  }

  const correction = await recordCorrection({
    surfaceKey: input.surfaceKey,
    beforeCaptureId: input.beforeCaptureId,
    afterCaptureId: input.afterCaptureId,
    correction: words,
    components: input.components,
    lesson: input.lesson,
    scope: input.scope,
    scopeRef: input.scopeRef,
    confidence: input.confidence,
    recordedByUserId: input.recordedByUserId,
  });
  return { ok: true, correction };
}

export interface ScopeSuggestion {
  scope: DesignScope;
  scopeRef: string | null;
  /** Why, in one sentence, so a person can disagree with the reasoning. */
  because: string;
  /** What else it could reasonably be, so the suggestion is not a decision. */
  alternatives: { scope: DesignScope; scopeRef: string | null; because: string }[];
}

/**
 * Suggest how far a correction reaches — advice, never a default.
 *
 * The rule is **narrowest thing consistent with what they pointed at**, which is
 * the opposite of the convenient rule. A correction naming one component is
 * about that component; one naming a screen is about that screen; one naming
 * neither is a one-off until somebody says otherwise.
 *
 * It reads the *shape* of what was pointed at and never the words. A version
 * that read "always" or "everywhere" out of the sentence would be inferring
 * intent from prose, which is §25's Westbrook defect at the one place where
 * getting it wrong silently widens a rule — and `jurisdictionFor`'s own lesson
 * is that what changes in that case is the question, never the reader.
 */
export function suggestScope(input: {
  components: readonly string[];
  surfaceKey: string | null;
  faculty: string | null;
}): ScopeSuggestion {
  const alternatives: { scope: DesignScope; scopeRef: string | null; because: string }[] = [];

  if (input.components.length === 1) {
    const component = input.components[0]!;
    if (input.surfaceKey) {
      alternatives.push({
        scope: 'SCREEN',
        scopeRef: input.surfaceKey,
        because: 'if the point is about this screen rather than about that one component',
      });
    }
    return {
      scope: 'COMPONENT',
      scopeRef: component,
      because: `one component was named — ${component} — so the narrowest reading is that it is about that.`,
      alternatives,
    };
  }

  if (input.surfaceKey) {
    if (input.faculty) {
      alternatives.push({
        scope: 'FACULTY',
        scopeRef: input.faculty,
        because: `if every screen in ${input.faculty} should follow it`,
      });
    }
    return {
      scope: 'SCREEN',
      scopeRef: input.surfaceKey,
      because:
        input.components.length === 0
          ? 'a screen was named and no single component was, so it reads as being about the screen.'
          : `${input.components.length} components on one screen were named, which reads as being about the screen.`,
      alternatives,
    };
  }

  /*
   * Nothing to point at. ONE_OFF rather than GLOBAL, deliberately: a correction
   * whose subject Brain cannot establish is a correction Brain does not
   * understand, and the safe reading of one it does not understand is the one
   * that changes nothing else.
   */
  return {
    scope: 'ONE_OFF',
    scopeRef: null,
    because:
      'nothing was named that this could be filed against, so it is kept as evidence about one ' +
      'decision rather than applied anywhere.',
    alternatives: [
      {
        scope: 'GLOBAL',
        scopeRef: null,
        because: 'if this is a rule for the whole product — which is worth saying explicitly',
      },
    ],
  };
}

/**
 * Write down what Brain took from a correction.
 *
 * Separate from recording it, because the two are different claims: the words
 * are theirs and the lesson is Brain's reading of them. Keeping the second out
 * of the first is what lets somebody later say *that is not what I meant*
 * without the evidence having been overwritten.
 */
export async function takeLesson(correctionId: string, lesson: string): Promise<void> {
  await setCorrectionLesson(correctionId, lesson.trim());
}

/**
 * Whether one correction's scope may be widened to another.
 *
 * The answer is *never, on Brain's own initiative*. This exists so that a caller
 * that wants to widen has to hold a person's decision, and so the refusal reads
 * the same wherever it is asked.
 */
export function mayWiden(from: DesignScope, to: DesignScope): { ok: boolean; reason: string } {
  if (SCOPE_RANK[to] <= SCOPE_RANK[from]) {
    return { ok: true, reason: 'narrowing or leaving a scope where it is needs nobody.' };
  }
  return {
    ok: false,
    reason:
      `Widening a ${from} lesson to ${to} is a decision about screens the owner did not look at. ` +
      'Brain records the scope it was given at; a person widens it, deliberately.',
  };
}

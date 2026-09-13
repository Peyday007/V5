/**
 * "Not this", scoped to the words it governs.
 *
 * Two readers need the same answer and must not each write their own: the
 * execution gate asks whether a verb was negated (*"no need to fix the
 * footer"*), and the target resolver asks whether a project was
 * (*"do not change Brain"*). A rule applied by one of two readers is worse than
 * none — this repository has recorded that four times — and here the two would
 * disagree about the same sentence, which is the worst version of it: one half
 * would refuse the change and the other would file it against the project the
 * person ruled out.
 *
 * It lives in its own module rather than in either reader because both import
 * it, and a shared rule kept inside one of its callers is a cycle waiting to be
 * discovered by whichever file happens to load first.
 */

/**
 * Negators, looked for inside one clause rather than across a message.
 *
 * Bare `not` is deliberately **absent**. It is the commonest word in the list
 * and the one most often about something other than the instruction — *"it's
 * not right, change the header"* asks for a change, and a gate that read the
 * `not` would decline it. The target resolver adds `not` to its own copy,
 * because there a false positive only ever *removes* a candidate and the worst
 * it can do is make Brain ask.
 */
export const NEGATORS =
  /\b(?:do not|don'?t|does not|doesn'?t|did not|didn'?t|no need to|never|rather than|instead of|without|avoid|refrain from|stop)\b/i;

/**
 * The clause a position sits in: back to the start of its sentence, then
 * forward past the last contrast marker.
 *
 * "Don't touch the pricing page, but do fix the footer" must still ask, so the
 * negation attached to the first clause may not reach the second. Cutting at the
 * contrast is what draws that line, and the sentence boundary is what stops a
 * negation two sentences ago silencing a later instruction.
 */
export function clauseBefore(text: string, index: number): string {
  const sentenceStart = Math.max(
    0,
    ...['.', '!', '?', ';', '\n'].map((mark) => text.lastIndexOf(mark, index - 1) + 1),
  );
  let clause = text.slice(sentenceStart, index);
  for (const contrast of [', but ', ' but ', ', though ', ', however ', ' — ']) {
    const at = clause.toLowerCase().lastIndexOf(contrast);
    if (at >= 0) clause = clause.slice(at + contrast.length);
  }
  return clause;
}

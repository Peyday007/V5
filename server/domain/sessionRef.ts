/**
 * Two names for one provider session, and whether they are the same one.
 *
 * Brain learns a session's identity twice, from two sides, in two spellings.
 * When it fires a Routine the provider answers with the session it created and
 * Brain writes that on `bin_dispatch.session_ref` — `cse_01NHKxvEWmtqBAvNxuLWcr1t`.
 * When the worker in that session checks in it reports its own session id, and
 * the surface spells the identical session `claude-code-session_01NHKxvEWmtqBAvNxuLWcr1t`.
 *
 * Nothing in this repository ever had to compare the two, because nothing ever
 * asked *whether the session that arrived is the session Brain fired*. Every
 * existing linkage goes through the bin and its generation instead —
 * `creditDispatchArrival` reads the SENT dispatch at the generation an
 * assignment has just superseded and credits whoever claimed it. That is right
 * for attribution and it cannot answer this question, because it assumes the
 * claimer *is* the arrival rather than establishing it.
 *
 * So the comparison is here, on its own, as a function over two strings:
 *
 *   - A known prefix is removed and the remainder compared. The prefixes are
 *     listed rather than guessed, and the list is the whole of what this module
 *     knows.
 *   - A value carrying **no** known prefix is compared whole. Stripping to "the
 *     part after the last underscore" would silently mangle a format nobody has
 *     seen yet, and a normalizer that corrupts an unknown input is worse than
 *     one that declines to normalize it.
 *   - An absent or blank value is never equal to anything, including another
 *     absent one. "We could not tell" must not read as "we checked" — the rule
 *     this file applies everywhere lineage is concerned.
 *
 * It decides nothing on its own. Its one caller uses it to *refuse*, so a wrong
 * answer costs a probe and can never hand anybody work they were not already
 * eligible for.
 */

/**
 * Every way a provider session id is spelled where Brain can see it.
 *
 * `cse_` is what the fire response carries. `claude-code-session_` is what a
 * Cowork worker reports about itself. `session_` is the bare form the same
 * surface uses elsewhere. All three wrap the same opaque id.
 */
const SESSION_PREFIXES = ['claude-code-session_', 'cse_', 'session_'] as const;

/** The opaque id inside whichever spelling this is, or the value unchanged. */
export function normalizeSessionRef(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  for (const prefix of SESSION_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      const rest = trimmed.slice(prefix.length);
      // A prefix with nothing after it identifies no session. Falling through to
      // "compare the whole value" would make `cse_` equal to `cse_`, which is an
      // identity claim about two sessions neither of which was named.
      return rest.length > 0 ? rest : null;
    }
  }
  return trimmed;
}

/** Whether two spellings name the same provider session. Absent is never equal. */
export function sameProviderSession(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normalizeSessionRef(a);
  const right = normalizeSessionRef(b);
  if (left === null || right === null) return false;
  return left === right;
}

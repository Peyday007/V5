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

/**
 * A `session_ref` that is a shell variable nobody expanded, not a session.
 *
 * The check-in contract tells a worker to send the value of
 * `CLAUDE_CODE_REMOTE_SESSION_ID`. Production, 2026-10-05 10:22Z: the recovery
 * probe's own session (`cse_01QREme3…`) checked in with the literal string
 * `$CLAUDE_CODE_REMOTE_SESSION_ID`. Compared whole — which `normalizeSessionRef`
 * correctly does for a value with no known prefix — it matched nothing, so the
 * probe recorded NO_MCP about a session that had arrived and worked two bins.
 * And every worker sending the same literal would be one "session" to the
 * audit-independence floor, which would then refuse every role after the first.
 *
 * No spelling of a provider session contains `$`, so a value that does is a
 * placeholder rather than an identity, and is refused at the door rather than
 * stored: the worker can send the real value, or omit the field and let Brain
 * use the session it recorded when it fired.
 */
export function isUnexpandedSessionRef(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.includes('$');
}

/**
 * Every spelling of one provider session, for an exact-match lookup in SQL.
 *
 * The no-show pass looks rows up by the session a fire produced, and the rows
 * were written in whichever spelling the writer saw — `cse_` from the fire,
 * `claude-code-session_` or `session_` from the worker. Matching only one or two
 * of them made an arrival under the third read as no arrival at all: a healthy
 * surface charged a no-show for a session that had checked in. Empty for an
 * absent value, which is never equal to anything.
 */
export function sessionSpellings(value: string | null | undefined): string[] {
  const id = normalizeSessionRef(value);
  if (id === null) return [];
  const known = SESSION_PREFIXES.some((prefix) => value!.trim().startsWith(prefix));
  return known ? SESSION_PREFIXES.map((prefix) => `${prefix}${id}`) : [id];
}

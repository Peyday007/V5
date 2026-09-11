/**
 * When can a *different* authenticated session turn up?
 *
 * ---------------------------------------------------------------------------
 * The defect this exists for, stated exactly
 * ---------------------------------------------------------------------------
 *
 * `auditEligibility` compares roles on `ExecutorLineage.sessionRef`, and that
 * value is the credential the request authenticated with — `oauth_tokens.id`
 * for the Cowork connector. That is the right dimension: it is server-derived,
 * a worker cannot present somebody else's, and it identifies one model context,
 * which is the thing an independent audit exists to keep apart.
 *
 * It is also **stable for the life of the access token**, and that lifetime is
 * an hour (`ACCESS_TOKEN_TTL_MS`). So two activations of one Routine inside one
 * hour authenticate as the *same* session, and the second is correctly refused
 * the next audit role. Brain then fires again, is refused again, and walks the
 * refusal ladder — 1, 2, 5, 15, 30 minutes, then 30 minutes for ever.
 *
 * Nothing in that loop can succeed until the token ages out, and nothing in it
 * knows that. So a packet whose research is finished waits for an hour it is
 * never told about, re-firing at a surface whose answer cannot change, and the
 * three roles complete at the pace of the token clock rather than the pace of
 * the ten-second dispatcher. That is the "waiting for hourly schedules" the
 * product owner named, and the hourly thing is Brain's own token lifetime.
 *
 * ---------------------------------------------------------------------------
 * What this fixes, and what it deliberately does not
 * ---------------------------------------------------------------------------
 *
 * It computes the moment the blocking condition can first stop being true, and
 * the refusal path uses it as an **upper bound** on the backoff. The ladder is
 * unchanged and still applies; this can only ever move a retry *earlier*.
 *
 * It does not change what a session is, which rules out the two tempting fixes
 * and is worth recording as a refusal rather than an omission:
 *
 *   - **Rotating the credential on refusal.** Brain issued the token and could
 *     revoke it, and the connector would refresh within seconds. It would also
 *     mean one model context authenticating under two session ids, and the
 *     context Brain had just refused a role would come straight back eligible
 *     for it. That defeats the control outright — the whole point of the
 *     session dimension is that one context cannot hold two roles.
 *   - **Shortening the access token's life.** The same hole, arrived at more
 *     slowly: a lifetime short enough to guarantee a fresh session per
 *     activation is also short enough to expire *inside* one, and then the
 *     identity the matrix compares stops identifying a context at all.
 *
 * The honest consequence is that Brain cannot manufacture a second simultaneous
 * identity — §22's "the surface owns whether a worker may act" applies to *who*
 * a worker is as much as to what it may do. What Brain can do is stop waiting
 * longer than it has to, and say what it is waiting for.
 */
import { getToken } from '../../repos/oauth.ts';

/**
 * The earliest instant at which the credential behind `credentialId` can no
 * longer be the one presenting, or null when that cannot be established.
 *
 * Null is not "never" and must not be read as one. It is the ordinary answer
 * for the two cases that are not an expiring bearer:
 *
 *   - a `brnw_` worker credential, which an operator issued and which does not
 *     age out — a client holding one presents it for ever, so no bound exists
 *     and the ladder is the whole answer;
 *   - an id that resolves to nothing, which is the fail-open direction on
 *     purpose: an unreadable token must not shorten a backoff, and an unknown
 *     bound leaves the existing behaviour exactly as it was.
 *
 * A token already revoked or already expired answers with its own recorded
 * `expiresAt` rather than with "now". Saying the condition has already cleared
 * is the caller's business — this reports the row, and the floor the caller
 * applies is what stops a retry landing in the past.
 */
export async function distinctSessionPossibleAt(
  credentialId: string | null | undefined,
): Promise<string | null> {
  if (!credentialId) return null;
  const token = await getToken(credentialId);
  // Only an access token bounds an arrival. A refresh token is never presented
  // to a Brain route, so its expiry says nothing about who turns up next.
  if (!token || token.kind !== 'ACCESS') return null;
  return token.expiresAt;
}

/*
 * The clamp itself lives in `repos/util.ts` as `retryAtWithin`, and not here.
 *
 * It is applied inside `recordSessionRefusal`, which is a repository function,
 * and a repository reaching into a service to learn how to compare two strings
 * is a dependency this layer does not have and should not grow. What belongs
 * here is the *question* — when can a different session exist — because
 * answering it means reading a grant, and that is service work.
 */

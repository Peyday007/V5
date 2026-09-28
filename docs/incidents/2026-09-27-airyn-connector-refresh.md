# 2026-09-27 — Airyn's Factory connector stopped working

Read from `npm run admin -- oauth trace` (identity_events and the oauth tables).

- Client `brnc_578364…` (Airyn's "Brain (Airyn)" connector, resource `/mcp`,
  worker-10 / `wkr_f8e118…`) refreshed hourly until **07:27Z**. That refresh
  revoked the presented refresh token at 07:27:10, minted its successor at
  07:27:14 and the access token at 07:27:38 — about 30 s, during pool
  contention. The successor pair was never used, and Claude's requests with the
  old access token were refused `INVALID_CREDENTIALS` at 07:27:38–40. The
  client evidently never received the response, so it held a refresh token
  Brain had already revoked: every later refresh is `invalid_grant`, which is
  "Your connection stopped working. Reconnect."
- Reconnect attempts registered new clients (19:23, 19:25, 19:26, 21:42–43,
  23:10–11) and never produced an authorization code. Before 22:08 no
  invitation existed, so a member reaches the sign-in page (only an
  administrator or a live invitation can approve). The invitation issued at
  22:08 (`inv_2ca598…`, bound to Airyn) was opened 22:08–22:10; its browser
  cookie lasts an hour, and the next attempt arrived at 23:10:22, eleven
  seconds after it lapsed.
- Neither step was recorded: a refused refresh and the consent screen a
  request was shown wrote no row. Both are audited now
  (`OAUTH_TOKEN DENIED {reason}`, `OAUTH_AUTHORIZE_PAGE {shown}`).

Repaired (owner authorized a narrowly bounded retry): rotation is one
transaction in `rotateRefreshToken` (`server/repos/oauth.ts`) — a failed write
changes nothing — and a rotated refresh token names the one it replaced. A
revoked refresh token is honoured once more only when it was revoked by a
rotation no more than five minutes earlier and the pair minted in its place has
never been used; the unused pair is revoked and a new one issued. A replay after
the replacement was used, a second replay, a replay after the window and any
explicitly revoked token are refused (`REUSED`, `RECOVERY_SPENT`,
`OUTSIDE_RETRY_WINDOW`, `NOT_LIVE`). Tests: `tests/oauth.test.ts` (the incident,
reproduced first against the old handler; replay after use; two racing
refreshes) and `tests/oauthRefreshRecovery.test.ts` (rollback, window, explicit
revocation, racing retries), on SQLite and Postgres.

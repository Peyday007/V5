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

Owed, not done here: refresh rotation revokes before the response is
delivered, so a response lost to a slow commit ends the connector. A bounded
retry grace for an unused successor would fix it and relaxes "a refresh token
is usable at most once" (`tests/oauth.test.ts`), which is an owner decision.

-- How a recovery was authenticated, recorded apart from whose authority it carries.
--
-- `047` called `requested_by_id` "the authenticated principal that initiated the
-- recovery". That is the sentence this migration corrects. The only entrance
-- that exists is `npm run admin -- packets reaudit … --admin <email>`, and what
-- `--admin` does is resolve an email against `users` and check it is an enabled
-- administrator. **That is attribution, not authentication.** It proves such a
-- person exists and may authorize this; it proves nothing whatever about who
-- typed the command.
--
-- What actually authenticated the call is reaching the shell — §26's rule, and
-- in production that shell was reached by a GitHub Actions job holding the
-- deployment credential, running `flyctl ssh console`, dispatched by an agent
-- acting on the owner's recorded instruction. Recording that as though the owner
-- had approved it in a browser would be the most consequential kind of quiet
-- overstatement this file exists to refuse: it would make a delegated terminal
-- action indistinguishable, later, from one a person performed themselves.
--
-- So there are two facts and they are stored as two columns:
--
--   requested_by_id    whose authority this carries        (resolved from rows)
--   authority_channel  how the call was authenticated      (a closed set)
--
-- `authority_channel` defaults to the weaker, unverifiable claim, because Brain
-- cannot check a channel and must never assume the stronger one. Only a caller
-- that genuinely holds an authenticated HTTP principal may assert
-- `BROWSER_SESSION`, and nothing in this repository does yet. A default that can
-- only ever *understate* assurance is the same shape as unknown lineage failing
-- closed.
--
-- `executed_by_ref` is deliberately nullable and deliberately untrusted: a
-- terminal can report a workflow run or a session, and Brain cannot verify one
-- word of it. It is stored as a lead for a person reading the record later, and
-- every reader prints it as reported rather than as established.
ALTER TABLE audit_integrity_reopens
  ADD COLUMN authority_channel TEXT NOT NULL DEFAULT 'DELEGATED_TERMINAL';

ALTER TABLE audit_integrity_reopens
  ADD COLUMN executed_by_ref TEXT;

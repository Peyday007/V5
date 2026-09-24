-- Several people connecting one factory worker, at once, each with their own link.
--
-- Onboarding a repository issues one invitation and withdraws every other unused
-- one for that worker, which is right for what it was built for: a repair and a
-- rotation, with never more than one live link to reason about. It is wrong for
-- commissioning a pool. A Factory worker served by several Claude accounts needs
-- one link per account, sent to several people at once, and issuing the second
-- must not kill the first before its recipient has opened it.
--
-- Two columns, and neither is a verdict:
--
--   * `kind` says which of the two a row is. `ROTATING` is onboarding's link and
--     is still withdrawn when onboarding runs again; `ADDITIONAL` is issued
--     beside the others and is only ever withdrawn on its own, by a person.
--     Existing rows are all onboarding's, so the default is exact rather than a
--     guess.
--   * `intended_user_id` is the Brain member the link was issued for. When set,
--     the consent screen spends it only for a browser signed in as that member,
--     so a forwarded link cannot connect somebody else's Claude account under
--     another person's name. It is chosen by the administrator issuing it and
--     never inferred from a display name or from who opened it first.
ALTER TABLE worker_invitations ADD COLUMN kind TEXT NOT NULL DEFAULT 'ROTATING'
  CHECK (kind IN ('ROTATING', 'ADDITIONAL'));
ALTER TABLE worker_invitations ADD COLUMN intended_user_id TEXT;

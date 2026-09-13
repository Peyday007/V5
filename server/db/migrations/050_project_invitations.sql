-- Inviting a person, and their accepting.
--
-- Until this migration there was no way to invite a human being to anything. A
-- person was *granted* a membership at `POST /api/projects/:id/members`, by
-- somebody who already knew their user id — which means the only people who
-- could ever be added were people a Brain administrator had already created an
-- account for. Nobody was ever invited and nobody ever accepted. The only
-- `invitations` table in this repository is `worker_invitations`, and a worker
-- is not a person: it holds no threads, reads no project, and the thing it
-- redeems is an OAuth consent screen.
--
-- So this is `worker_invitations`' shape applied to the other kind of
-- principal, deliberately rather than by copying, because the two differ in
-- exactly two places and both are recorded here.
--
--   * A worker invitation names **a worker**; this one names **an email and a
--     role**. Neither is chosen by whoever redeems it. A person who could pick
--     their own role on the way in would make the invitation a way to grant
--     oneself access, which is precisely what the issuing administrator's
--     decision is for.
--
--   * A worker invitation is redeemed by a browser approving a connector; this
--     one is redeemed by a person, and the person may not have a Brain account
--     yet. Whether accepting may *create* one is not recorded here on purpose:
--     it is re-derived from the inviter's **current** authority at the moment
--     the effect happens, because §17's rule is that authority is read on every
--     request rather than baked into a token. A column saying "this token may
--     create an account" would be exactly such a baking.
--
-- It is a credential, so it is stored the way every other credential in this
-- Brain is: a prefix to find the row by, and a sha-256 of the secret. The
-- plaintext exists in the link and nowhere else and cannot be recovered
-- afterwards by anybody, including an administrator.
--
-- `accepted_at` is set by a single guarded UPDATE that carries every condition
-- making the invitation valid, so two requests holding the same intercepted
-- link cannot both come away with a membership: the database picks the winner
-- and the loser is told the same thing an unknown token is told.
--
-- No `ORDER BY` in this table's queries tiebreaks on `rowid`. `created_at DESC,
-- id DESC` is a total order that is sayable in both dialects, and `id` is a
-- random unique string — which is the fourth time a tiebreak column only one
-- backend has has cost a production tick.
CREATE TABLE project_invitations (
  id                  TEXT PRIMARY KEY,

  -- What is being offered. Both fixed at issue by the person deciding.
  project_id          TEXT NOT NULL REFERENCES projects(id),
  invited_email       TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER')),

  -- The credential. A prefix to look it up by, and a digest of the secret.
  token_prefix        TEXT NOT NULL UNIQUE,
  token_digest        TEXT NOT NULL,

  -- Whose decision this carries. Re-read at acceptance rather than trusted:
  -- an inviter who has since lost ADMIN on this project cannot let anybody in
  -- through a link they left behind.
  invited_by_user_id  TEXT NOT NULL REFERENCES users(id),

  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,

  -- Single use. Set in the same statement that checks it is unset.
  accepted_at         TEXT,
  -- Who it resolved to. Written from the invited email, never from anything the
  -- acceptor said about themselves.
  accepted_user_id    TEXT REFERENCES users(id),

  -- Withdrawn before use. An invitation is never deleted: the offer having been
  -- made is part of who was let into this project and who was not.
  revoked_at          TEXT,
  revoked_reason      TEXT,

  note                TEXT
);

CREATE INDEX idx_project_invitations_project ON project_invitations (project_id);
-- Acceptance looks the row up by prefix and then compares the secret in
-- constant time, so authentication is one indexed read rather than a scan that
-- digests every live invitation to find out which one this is.
CREATE INDEX idx_project_invitations_email ON project_invitations (invited_email);

-- Several people connecting one factory worker, at once, each with their own link.
-- See the SQLite migration 093_worker_invitation_members.sql for the reasoning.
ALTER TABLE worker_invitations ADD COLUMN kind TEXT NOT NULL DEFAULT 'ROTATING'
  CHECK (kind IN ('ROTATING', 'ADDITIONAL'));
ALTER TABLE worker_invitations ADD COLUMN intended_user_id TEXT;

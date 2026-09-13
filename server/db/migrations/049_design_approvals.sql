-- A person's recorded approval of what the product looks like.
--
-- §24's design gate requires a recorded visual, mobile and interaction approval
-- before broad UI rollout, and `docs/STEP-12B-MATRIX.md` has carried that gate
-- as a **markdown table** whose top row still reads `— pending —`. A table in a
-- document is a fine place to write down that a decision was made and a useless
-- place to check it from: nothing can read it, nothing can bind it to a
-- revision, and nothing stops it being edited by whoever is writing the report
-- that cites it.
--
-- So the approval is a row, and three properties are what make it evidence
-- rather than a formality:
--
--   * It is bound to a **revision** and to a **render-set digest**. An approval
--     is of a specific thing somebody looked at; the moment either changes it
--     no longer describes what they saw, and the reader must say so rather than
--     carrying it forward. This is §23's reservation-bound-to-the-bytes shape at
--     a smaller scale.
--   * `approved_by_user_id` comes from the **authenticated principal** and from
--     no field, so nothing a caller sends about itself can make it an approval
--     by somebody else (§17).
--   * It is **append-only**. A withdrawal is a new row with decision
--     `WITHDRAWN`, so "it was approved and then it wasn't" stays readable. §5.
--
-- What this table deliberately does not do is let anything approve itself. The
-- acceptance reporter **reads** it; no code path in `scripts/` writes it. The
-- write is a route behind `requirePerson`, and an agent running the acceptance
-- can no more create one of these than it can create the session it would need
-- to do so.
CREATE TABLE design_approvals (
  id TEXT PRIMARY KEY,
  -- What was looked at. The revision is the tree, the digest is the exact set of
  -- renders — because two different render sets can be produced from one tree.
  revision TEXT NOT NULL,
  render_set_digest TEXT NOT NULL,
  -- How many renders the set held and where the manifest lives, so a reader can
  -- go and look at the same thing rather than taking the digest on trust.
  render_count INTEGER NOT NULL,
  manifest_path TEXT NOT NULL,
  -- APPROVED | REJECTED | WITHDRAWN. A rejection is as much a recorded decision
  -- as an approval and is kept for the same reason.
  decision TEXT NOT NULL,
  -- Resolved from the authenticated principal, never from a request field.
  approved_by_user_id TEXT NOT NULL,
  -- In the approver's own words. A decision with no stated reason answers
  -- nothing later, which is the same argument `--admin` attribution rests on.
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_design_approvals_revision ON design_approvals (revision, created_at);
CREATE INDEX idx_design_approvals_digest ON design_approvals (render_set_digest, created_at);

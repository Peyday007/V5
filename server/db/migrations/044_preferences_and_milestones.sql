-- Step 12B — the per-account preference seam.
--
-- §18 is explicit about what this is *not*: not a customization survey, not a
-- personalization engine, and not something the owner has to configure for
-- anybody. It is the smallest clean versioned seam that later presentation,
-- notification, communication and layout preferences can live in.
--
-- Two properties make it safe to have at all.
--
-- **A preference is scoped to one person and cannot reach anything else.**
-- The primary key is the person and the key together, so there is no shape
-- here that could hold a project-wide setting by accident.
--
-- **A preference may never change a fact.** That is enforced in the service by
-- a closed allow-list of keys, all of them presentational, rather than by
-- convention — §18's rule is that personalization may never change facts,
-- evidence standards, build quality or authorization rules, and a free-text
-- key column with no list would make that a promise rather than a property.

CREATE TABLE user_preferences (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,

  -- JSON, so a later preference can be richer than a string without a
  -- migration. The *set* of keys is still closed in code.
  value      TEXT NOT NULL,

  -- Versioned from the start: a preference whose meaning changes later must be
  -- distinguishable from one written under the old meaning.
  version    INTEGER NOT NULL DEFAULT 1,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  PRIMARY KEY (user_id, key)
);

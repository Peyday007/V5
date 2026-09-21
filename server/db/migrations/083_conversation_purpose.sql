-- What a conversation is for, said rather than inferred from a default.
--
-- ---------------------------------------------------------------------------
-- What was wrong
-- ---------------------------------------------------------------------------
--
-- Every general Russell thread in this Brain was filed under **Deal Dispatch**,
-- and nothing anywhere had decided that. `RussellShell` picks
-- `projects.data.projects[0]` — the first project the API happens to return —
-- and passes it as the new thread's `projectId`; `collectionNameFor` files a
-- thread with a project under that project's name. So the seeded project became
-- the home of every conversation about anything, and a person looking for what
-- they said about Brain found it under a customer's name.
--
-- The schema already said this was wrong. `project_id`'s own comment reads
-- *"NULL means Russell has not attached it yet, which is a real state and not
-- an error"*, and `attachment_source` records **who** attached it: `NONE`,
-- `AUTOMATIC` (the router), `USER` (a person), `MIGRATED`. `createConversation`
-- writes `'NONE'` unconditionally — including when a caller passes a project.
-- So the rows carry, in two columns, both *this thread is attached to Deal
-- Dispatch* and *nobody attached this thread*, which cannot both be true.
--
-- ---------------------------------------------------------------------------
-- What this does
-- ---------------------------------------------------------------------------
--
-- `purpose` is the explicit statement that was missing. It is derived here from
-- **linkage**, never from a title: a title is a sentence somebody typed, and
-- classifying by the words in it is the guess this column exists to replace.
--
--   * `PROJECT`   — attached by somebody or by the router, or the thread
--                   actually produced work against that project: a candidate,
--                   a mission, a piece of knowledge, a software request.
--   * `GENERAL`   — everything else. The default for a new thread.
--   * `OPERATIONAL` and `TECHNICAL` exist in the vocabulary and are written by
--     nothing here: they are for a thread somebody deliberately opens as one,
--     and inventing members of them from existing rows would be the same guess
--     one column along.
--
-- Then the inconsistency is repaired rather than judged: a thread whose
-- `attachment_source` is `NONE` was, by the schema's own definition, never
-- attached — so its `project_id` is cleared. Nothing else moves. **Every
-- message, every thread id, every candidate, mission, knowledge row and
-- software request is untouched**, and a thread that genuinely belongs to a
-- project keeps its attachment, its source and its confidence exactly as they
-- were.

ALTER TABLE russell_conversations ADD COLUMN purpose TEXT NOT NULL DEFAULT 'GENERAL';

-- Attached by a decision: the router's, or a person's, or an earlier migration's.
UPDATE russell_conversations
   SET purpose = 'PROJECT'
 WHERE project_id IS NOT NULL
   AND attachment_source IN ('AUTOMATIC', 'USER', 'MIGRATED');

-- Or attached by nobody and yet demonstrably about that project, because work
-- came out of it. Four tables, because a thread can reach a project through
-- any of them and reading only one would call a real deal thread general.
UPDATE russell_conversations
   SET purpose = 'PROJECT'
 WHERE project_id IS NOT NULL
   AND purpose = 'GENERAL'
   AND (
     EXISTS (SELECT 1 FROM russell_candidates c
              WHERE c.conversation_id = russell_conversations.id
                AND c.project_id = russell_conversations.project_id)
     OR EXISTS (SELECT 1 FROM russell_missions m
                 WHERE m.conversation_id = russell_conversations.id
                   AND m.project_id = russell_conversations.project_id)
     OR EXISTS (SELECT 1 FROM russell_knowledge k
                 WHERE k.conversation_id = russell_conversations.id
                   AND k.project_id = russell_conversations.project_id)
     OR EXISTS (SELECT 1 FROM russell_software_requests s
                 WHERE s.conversation_id = russell_conversations.id)
   );

-- What the repair is about to remove, written down before it removes it.
--
-- `russell_conversation_context` is append-only and exists for exactly this:
-- the history of what a thread was attached to and why. `attachConversation`
-- writes a row on every attachment and `createConversation` never did, so the
-- value this clears was recorded nowhere at all — and clearing it silently
-- would be the one thing §5 does not allow. `MIGRATED` is the source vocabulary
-- already has for a change a migration made. The row records what the thread is
-- attached to *after* the decision — NULL — exactly as `attachConversation`
-- does, and the reason names the project it was detached from, which is the
-- table's own comment: "Russell detached this" is a decision worth recording.
INSERT INTO russell_conversation_context
  (id, conversation_id, project_id, source, confidence, reason, actor_user_id, created_at)
SELECT
  'rcx_m082_' || substr(id, 5, 20),
  id,
  NULL,
  'MIGRATED',
  NULL,
  'Detached from ' || project_id || ' by migration 083: this thread carried a project and '
    || 'attachment_source = ''NONE'', which is the schema''s own way of saying nothing attached '
    || 'it. It was the value a client default wrote. Re-attach it from the conversation if it '
    || 'really is about that project.',
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM russell_conversations
WHERE purpose = 'GENERAL'
  AND project_id IS NOT NULL
  AND attachment_source = 'NONE';

-- The repair. `attachment_source = 'NONE'` says nothing attached this thread,
-- so a project on it is a value the default wrote and no reader can defend.
-- Guarded on the purpose the two passes above established, so a thread that
-- produced real work keeps its project whatever its source column says.
UPDATE russell_conversations
   SET project_id = NULL,
       attachment_confidence = NULL
 WHERE purpose = 'GENERAL'
   AND project_id IS NOT NULL
   AND attachment_source = 'NONE';

CREATE INDEX idx_russell_conversations_purpose
  ON russell_conversations (owner_user_id, purpose);

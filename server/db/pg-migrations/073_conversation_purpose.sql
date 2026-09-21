-- The Postgres half of SQLite migration 082. See that file for why every
-- general thread in this Brain was filed under Deal Dispatch, why the two
-- columns already disagreed with each other, and why the repair is derived
-- from linkage rather than from a title.
--
-- The three passes are the same three, in the same order, with `EXISTS` written
-- against the outer row the way Postgres wants it. Nothing here is a different
-- rule expressed twice: a divergence between the two chains about which threads
-- are general would mean the two backends disagreed about what a person's own
-- conversation list looks like.

ALTER TABLE russell_conversations ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'GENERAL';

UPDATE russell_conversations
   SET purpose = 'PROJECT'
 WHERE project_id IS NOT NULL
   AND attachment_source IN ('AUTOMATIC', 'USER', 'MIGRATED');

UPDATE russell_conversations AS rc
   SET purpose = 'PROJECT'
 WHERE rc.project_id IS NOT NULL
   AND rc.purpose = 'GENERAL'
   AND (
     EXISTS (SELECT 1 FROM russell_candidates c
              WHERE c.conversation_id = rc.id AND c.project_id = rc.project_id)
     OR EXISTS (SELECT 1 FROM russell_missions m
                 WHERE m.conversation_id = rc.id AND m.project_id = rc.project_id)
     OR EXISTS (SELECT 1 FROM russell_knowledge k
                 WHERE k.conversation_id = rc.id AND k.project_id = rc.project_id)
     OR EXISTS (SELECT 1 FROM russell_software_requests s
                 WHERE s.conversation_id = rc.id)
   );

-- What the repair is about to remove, written down before it removes it. See
-- the SQLite file: `createConversation` never wrote a context row, so the value
-- this clears was recorded nowhere, and clearing it silently is the one thing
-- §5 does not allow. The timestamp expression is the dialect's own; the rest is
-- the same rule, because two chains disagreeing about which threads are general
-- would mean the two backends disagreed about a person's conversation list.
INSERT INTO russell_conversation_context
  (id, conversation_id, project_id, source, confidence, reason, actor_user_id, created_at)
SELECT
  'rcx_m082_' || substr(id, 5, 20),
  id,
  NULL,
  'MIGRATED',
  NULL,
  'Detached from ' || project_id || ' by migration 082: this thread carried a project and '
    || 'attachment_source = ''NONE'', which is the schema''s own way of saying nothing attached '
    || 'it. It was the value a client default wrote. Re-attach it from the conversation if it '
    || 'really is about that project.',
  NULL,
  to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM russell_conversations
WHERE purpose = 'GENERAL'
  AND project_id IS NOT NULL
  AND attachment_source = 'NONE';

UPDATE russell_conversations
   SET project_id = NULL,
       attachment_confidence = NULL
 WHERE purpose = 'GENERAL'
   AND project_id IS NOT NULL
   AND attachment_source = 'NONE';

CREATE INDEX IF NOT EXISTS idx_russell_conversations_purpose
  ON russell_conversations (owner_user_id, purpose);

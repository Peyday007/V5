-- ---------------------------------------------------------------------------
-- OBJECT KEYS FOR DOCUMENTS
--
-- A document's bytes have always been addressed by a path relative to the data
-- folder. That works exactly as long as the data folder is the only place they
-- can be, which stops being true the moment a second Brain instance exists.
--
-- So a document now records the key its bytes are stored under. In local mode
-- the key is the same human-readable path it always was — the project tree
-- stays browsable, which is a feature rather than an accident — and in cloud
-- mode it is an identity-based key that no rename can invalidate.
--
-- `filesystem_path` is kept and keeps its meaning: where the file is on this
-- machine, when it is on this machine. Nothing reinterprets it, and a row
-- written before this migration still resolves, because a null storage key
-- means "addressed the old way".
-- ---------------------------------------------------------------------------
ALTER TABLE documents ADD COLUMN storage_key TEXT;

-- Which store those bytes are in: LOCAL or SUPABASE. Recorded per document
-- rather than inferred from configuration, so a project half-migrated to the
-- cloud can say which half — and the migration tool can resume by asking.
ALTER TABLE documents ADD COLUMN storage_provider TEXT;

-- Existing rows keep addressing their bytes exactly as they did. The path is
-- already a valid key for the local store, so this is a restatement rather than
-- a reinterpretation: nothing moves, and nothing is re-read.
UPDATE documents
   SET storage_key = filesystem_path,
       storage_provider = 'LOCAL'
 WHERE filesystem_path IS NOT NULL AND storage_key IS NULL;

CREATE INDEX idx_documents_storage_key ON documents (storage_key);

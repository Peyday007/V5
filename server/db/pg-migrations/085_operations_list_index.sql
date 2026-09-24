-- The operations inspection route reads a project's newest operations:
--   WHERE project_id = ? ORDER BY created_at DESC, id LIMIT n
-- The only project index was (project_id, state), so every call read and
-- sorted the project's whole history. On production the verification project
-- gains operations every deploy, and the statement timed out (deploy 346,
-- 10:51:28Z; the route answered 500 in 345 and 346). An index in the query's
-- own order lets the limit stop the read.
CREATE INDEX idx_idempotency_operations_project_created
  ON idempotency_operations (project_id, created_at DESC, id);

-- ---------------------------------------------------------------------------
-- A GOAL'S COMMERCIAL EXECUTION WINDOW (§119)
-- ---------------------------------------------------------------------------
--
-- The owner, 2026-11-19 and again 2026-11-24: the $10K objective has a 30-day
-- COMMERCIAL EXECUTION period that begins when commercial execution is
-- authorized. Planning, engineering and research before then do not consume
-- it, and until then the deadline is relative, not a calendar date.
--
-- The 2026-11-19 instruction was never written into a row or code, so every
-- reader kept counting down to the fixed `due_at` (2026-12-09) that the words
-- "within 30 days" had been turned into when the target was set on 2026-11-03
-- (invariant 12). These columns make the window a fact on the goal:
--
--   execution_window_days  the window's length; NULL for a fixed calendar deadline
--   execution_started_at   set once, when a grant first authorizes buyer-facing work
--
-- Before the start, `due_at` is NULL and every reader derives the deadline as
-- now + window (`domain/executionWindow.ts`); at the start it becomes
-- start + window.
--
-- The live $10K goal had a 30-day window turned into 2026-12-09. Execution has
-- not been authorized for it (its authority is research-only), so it gets its
-- full window back.
-- ---------------------------------------------------------------------------

-- The correction is history too (invariant 3): the event keeps the date it replaced.
INSERT INTO workstream_events (id, workstream_id, kind, summary, detail, actor_ref, created_at)
SELECT 'wse_execution_window_restored_7b4f', id, 'GOAL_EXECUTION_WINDOW_SET',
       'The owner''s 30-day commercial execution window (2026-11-19) replaced the fixed deadline ' || COALESCE(due_at, 'none') || ': the window starts when commercial execution is authorized.',
       '{"windowDays":30,"replacedDueAt":"' || COALESCE(due_at, '') || '","source":"owner 2026-11-19, restated 2026-11-24"}',
       'migration:goal_execution_window', '2026-11-24T12:00:00.000Z'
  FROM workstreams WHERE id = 'wst_7b4fcbb5f2384f31b6c3';

ALTER TABLE workstreams ADD COLUMN execution_window_days INTEGER;
ALTER TABLE workstreams ADD COLUMN execution_started_at TEXT;

UPDATE workstreams
   SET execution_window_days = 30, due_at = NULL
 WHERE id = 'wst_7b4fcbb5f2384f31b6c3' AND execution_started_at IS NULL;

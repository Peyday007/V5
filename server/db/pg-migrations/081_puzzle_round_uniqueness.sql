-- The Postgres half of SQLite migration 090. See that file for why the
-- bootstrap question could open twice, what production measured, and why the
-- renumber is a correction rather than a rewrite.
--
-- Stated plainly rather than inside any procedural block: §48's own convention,
-- paid for by `080_puzzle_kernel.sql`, whose `DO $$ … END $$;` existence guard
-- could not survive `splitStatements` and failed the whole chain.
--
-- `DROP INDEX IF EXISTS` names the index rather than a constraint, because that
-- is what `080` created — a unique *index*, not a table constraint — so
-- Postgres has no `puzzle_rounds_unique_key` to drop and naming one would fail
-- the boot. §35 records the reverse mistake one table along, where a constraint
-- was dropped by the wrong name.

UPDATE puzzle_rounds
   SET round = (
     SELECT COUNT(*)
       FROM puzzle_rounds AS earlier
      WHERE earlier.project_id = puzzle_rounds.project_id
        AND earlier.purpose = puzzle_rounds.purpose
        AND COALESCE(earlier.format_key, '-') = COALESCE(puzzle_rounds.format_key, '-')
        AND COALESCE(earlier.product_class, '-') = COALESCE(puzzle_rounds.product_class, '-')
        AND (earlier.created_at < puzzle_rounds.created_at
             OR (earlier.created_at = puzzle_rounds.created_at
                 AND earlier.id <= puzzle_rounds.id))
   );

DROP INDEX IF EXISTS puzzle_rounds_unique;

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_rounds_unique
  ON puzzle_rounds (project_id, purpose, COALESCE(format_key, '-'),
                    COALESCE(product_class, '-'), round);

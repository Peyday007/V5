-- The exclusion that makes two ticks produce one round, for the question that
-- carries no format.
--
-- ---------------------------------------------------------------------------
-- What production proved
-- ---------------------------------------------------------------------------
--
-- `089_puzzle_kernel.sql` wrote the uniqueness key as
--
--     (project_id, purpose, format_key, product_class, round)
--
-- and the bootstrap question — SEED_FORMATS, the one that reaches outside
-- everything already on the map — carries **NULL for both nullable columns by
-- design**. A NULL is distinct from every other NULL in a unique index, on
-- SQLite and on Postgres alike, so that index cannot refuse a second copy of
-- the one row it most needed to refuse.
--
-- Within a single pass the allocator already declines it: `live` finds the open
-- round and `null === null` is true in JavaScript. The hole is the race between
-- two passes, which is exactly what the index is there for — §38 states the
-- split in as many words: the allocator is pure over a snapshot, "being pure
-- makes it useless as a safety mechanism… the exclusion is the unique index,
-- and two ticks both deciding correctly produce one round."
--
-- Measured rather than reasoned: on the first production tick after the kernel
-- was released, `pzq_b04df7d4c4574c59ad1d` and `pzq_6e4bc50e9a2046b28c52` were
-- both open, both `SEED_FORMATS`, both round 1, on one project. Two of the
-- three concurrent research slots spent asking one question twice, and the
-- allowance spent twice to learn the same thing. `MAX_OPEN_PUZZLE_ROUNDS` is
-- what bounded it at two rather than at every tick for ever.
--
-- ---------------------------------------------------------------------------
-- The remedy is the one the sibling kernels already use
-- ---------------------------------------------------------------------------
--
-- `072_industry_kernel.sql` writes `COALESCE(node_id, '-')` and
-- `075_manufacturing_kernel.sql` writes `COALESCE(category_id, '-')`, both for
-- this reason and both proved on the two backends. This kernel was the only one
-- of the three that did not copy it. The sentinel is theirs verbatim so a
-- reader comparing the three finds one rule rather than three spellings.
--
-- ---------------------------------------------------------------------------
-- Nothing is destroyed, and the renumber is a correction rather than a rewrite
-- ---------------------------------------------------------------------------
--
-- The two live rows cannot both stay at round 1 once the key is total, so the
-- second is renumbered to 2 — which is the number the allocator would itself
-- have computed (`history.length + 1`) had its snapshot included the first.
-- Every row keeps its id, its candidate, its state, its timestamps and its
-- mission; §5's rule is that history does not mutate, and what moves here is a
-- counter that was wrong rather than a record of what happened.
--
-- The ordering is `(created_at, id)` rather than `rowid`, because `dialect.ts`
-- rewrites `rowid` to `seq` and a tiebreak on a column one backend does not
-- have is §27's own recurring defect. A correlated count rather than a window
-- function, for the same reason: it says the same thing in both dialects.

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

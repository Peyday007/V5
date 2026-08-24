/**
 * Keeping savepoints stacked when the code around them is asynchronous.
 *
 * Savepoints are a stack in both SQLite and Postgres: releasing one that is not
 * on top silently discards everything above it. That was never a risk while the
 * boundary was synchronous, because a nested transaction could not be
 * interrupted. Now it can:
 *
 *     await db.transaction(async () => {
 *       await Promise.all(layers.map((layer) => recomputeLayer(layer.id)));
 *     });
 *
 * Each `recomputeLayer` opens its own nested transaction. Without ordering, the
 * first opens `sp_1` and awaits, the second opens `sp_2` and awaits, the first
 * releases `sp_1` — taking `sp_2` with it — and the second fails on a savepoint
 * that no longer exists. Which is exactly the failure the suite found.
 *
 * So sibling nested transactions are serialised: each frame hands out a lock its
 * direct children take in turn. A grandchild takes its own parent's lock, which
 * is free, so a transaction nested inside a nested transaction never waits for
 * itself.
 *
 * The depth lives on the frame rather than in a counter shared by the whole
 * async tree, so two siblings cannot see each other's numbering.
 */

/** A promise chain: each holder waits for the previous one to let go. */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    await previous;
    return release;
  }
}

/** One transaction frame: how deep it is, and the queue for its children. */
export interface TransactionFrame {
  depth: number;
  children: Mutex;
}

export function rootFrame(): TransactionFrame {
  return { depth: 0, children: new Mutex() };
}

export function childFrame(parent: TransactionFrame): TransactionFrame {
  return { depth: parent.depth + 1, children: new Mutex() };
}

/** The savepoint name for a frame. Unique within its transaction's stack. */
export function savepointName(frame: TransactionFrame): string {
  return `brain_sp_${frame.depth}`;
}

/**
 * What one free-lane item used, measured while it ran (CAP-16-3, S-0170: collect
 * per stage model calls avoided and CPU/RAM/DB/network use). The worker opens a
 * meter when it starts an item and closes it when the item ends; the readings go
 * on that item's `FREE_LANE_ITEM` row (`measures.usage`), so `stageCapacity.ts`
 * sums them by the stage the item's work type belongs to.
 *
 * What each figure is, exactly:
 *
 * - `modelCalls`: calls this item made to its model route (each attempt counts).
 * - `modelCallsAvoided`: model calls the item's own protocol provides for that
 *   Brain answered deterministically instead (a refused claim dropped rather than
 *   a repair asked; a second source round not needed; a struck audit not asked
 *   the long way). A call that was simply never reached because the item failed
 *   is not "avoided".
 * - `cpuMicros`: the process's CPU time while the item was in flight, divided
 *   equally among the lane items in flight at each moment (Node gives no
 *   per-task CPU clock). The process also serves the web and other ticks, so it
 *   is an upper bound on what the item itself spent, and is labelled so.
 * - `peakRssBytes`: the highest process RSS sampled while the item ran;
 *   `rssShareBytes`: RSS at the item's end divided by the items then in flight.
 * - `dbCalls` / `dbMs`: Brain tool calls the item made and the time spent in
 *   them — every claim, read and submission is a database transaction.
 * - `networkBytesOut` / `networkBytesIn`: UTF-8 bytes of what the item sent to
 *   and received from the network — model prompts and replies, fetched pages,
 *   search queries and results. Application payload, not wire bytes (TLS and
 *   HTTP framing are not visible here).
 *
 * In memory only; nothing here is a store. Pure apart from reading the process clock.
 */

export interface ItemUsage {
  modelCalls: number;
  modelCallsAvoided: number;
  cpuMicros: number;
  peakRssBytes: number;
  rssShareBytes: number;
  dbCalls: number;
  dbMs: number;
  networkBytesOut: number;
  networkBytesIn: number;
}

interface Clock {
  cpu: () => number;
  rss: () => number;
}

const processClock: Clock = {
  cpu: () => {
    const usage = process.cpuUsage();
    return usage.user + usage.system;
  },
  rss: () => process.memoryUsage().rss,
};

export const utf8Bytes = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return Buffer.byteLength(text, 'utf8');
};

/**
 * Apportions process CPU among the items in flight: every time the set changes,
 * the CPU spent since the last change is divided equally among the items that
 * were in flight through it.
 */
export class ItemMeters {
  private readonly inFlight = new Map<string, ItemUsage>();
  private lastCpu: number;

  constructor(private readonly clock: Clock = processClock) {
    this.lastCpu = clock.cpu();
  }

  private settle(): void {
    const now = this.clock.cpu();
    const spent = Math.max(0, now - this.lastCpu);
    this.lastCpu = now;
    const rss = this.clock.rss();
    if (this.inFlight.size === 0) return;
    const share = spent / this.inFlight.size;
    for (const usage of this.inFlight.values()) {
      usage.cpuMicros += share;
      if (rss > usage.peakRssBytes) usage.peakRssBytes = rss;
    }
  }

  /** Opens a meter for one item; the returned object is the item's running tally. */
  open(key: string): ItemUsage {
    this.settle();
    const usage: ItemUsage = {
      modelCalls: 0, modelCallsAvoided: 0, cpuMicros: 0, peakRssBytes: this.clock.rss(), rssShareBytes: 0,
      dbCalls: 0, dbMs: 0, networkBytesOut: 0, networkBytesIn: 0,
    };
    this.inFlight.set(key, usage);
    return usage;
  }

  /** Closes the item's meter and returns what it used, CPU settled to now. */
  close(key: string): ItemUsage | null {
    const usage = this.inFlight.get(key);
    if (!usage) return null;
    this.settle();
    usage.rssShareBytes = Math.round(this.clock.rss() / this.inFlight.size);
    this.inFlight.delete(key);
    usage.cpuMicros = Math.round(usage.cpuMicros);
    return usage;
  }

  get size(): number {
    return this.inFlight.size;
  }
}

/** The worker's one set of meters. */
export const itemMeters = new ItemMeters();

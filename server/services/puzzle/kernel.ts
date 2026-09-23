/**
 * One project's puzzle pass, for the tick.
 *
 * ---------------------------------------------------------------------------
 * Derived on the tick, never hooked to a moment
 * ---------------------------------------------------------------------------
 *
 * Everything here is re-derived from rows on every pass, which is the sixth
 * time this repository has needed that distinction: a hook fixes one entrance,
 * and a derivation reaches every entrance plus everything already stranded. A
 * sprint activated before this kernel existed gets a map on the next tick with
 * nobody pressing anything; a tick that dies halfway leaves rows the next one
 * reads correctly; and two instances running it produce one round, because the
 * arbiter is a unique index rather than a check-then-write.
 *
 * ---------------------------------------------------------------------------
 * The order of the steps is the design, and so is which of them the sprint's
 * off switch reaches
 * ---------------------------------------------------------------------------
 *
 * File, make, compile, promote, allocate — each because of the one after it.
 *
 * Filing first means a round that settled on the previous pass has its formats
 * and buyers on the map *before* anything else looks, so a format that has
 * just gained a buyer is acted on this pass rather than the next. Making
 * before compiling means puzzles that have just passed can go into a product
 * immediately. Compiling before promoting means a product that has just become
 * possible is promoted at its real state. Promoting before allocating means a
 * format that is finished with research is out of the allocator's way, so the
 * slots go to the ones that still need it.
 *
 * **Winding the sprint down stops making, compiling and asking, and stops
 * nothing else.** Filing what research already found is not new discovery —
 * the spending happened when it ran. Promoting a product that is already
 * compiled and already qualified is finishing work already paid for. What
 * winding down ends is *starting* things: new puzzles, new products, new
 * questions. §30's rule that an off switch must not reach past the thing it
 * owns, applied per step rather than to the pass.
 */
import { getCashMode } from '../../repos/cashMode.ts';
import { listPuzzleMasters } from '../../repos/puzzle.ts';
import { discoveryAllowed } from '../cash/lifecycle.ts';
import { allocate, MAX_OPEN_PUZZLE_ROUNDS, type Ask, type Declined } from './allocate.ts';
import { readEconomics, type UnitEconomics } from './economics.ts';
import { filePuzzleFindings, openPuzzleAsks, type Filed, type OpenedPuzzleRound } from './expand.ts';
import { generateBatch, refusalFor, type BatchReport } from './generate.ts';
import { puzzleSnapshot, type PuzzleSnapshot } from './graph.ts';
import { readMaturity, type FormatMaturity } from './maturity.ts';
import { compileProduct, isRefusal } from './products.ts';
import { promoteSellableProducts, type Promotion } from './promote.ts';
import { defineMaster } from './seed.ts';
import { formatFor } from './formats/index.ts';
import { listMoneyEntries } from '../../repos/cashLedger.ts';
import { getProgram } from '../../repos/manufacturing.ts';
import { listCapabilities } from '../../repos/manufacturing.ts';
import type { PuzzleMaster, PuzzleProduct } from '../../domain/types.ts';

/** How many validated puzzles one system aims to hold before more are pointless. */
export const CATALOG_TARGET = 40;

/** How many puzzles go into one compiled product. */
export const PRODUCT_SIZE = 20;

/** How much generation one pass may do, across every system in the project. */
export const GENERATION_BUDGET = 25;

export interface PuzzlePass {
  /** What the finished rounds established. */
  filed: Filed;
  /** Systems Brain set up because the code and the rights allowed it. */
  systems: PuzzleMaster[];
  /** What was generated, and what was refused, per system. */
  batches: BatchReport[];
  /** Products compiled from puzzles no product already held. */
  compiled: PuzzleProduct[];
  /** Products that became portfolio work. */
  promoted: Promotion[];
  /** Rounds opened, each carrying why the allocator chose it. */
  opened: OpenedPuzzleRound[];
  /** Considered and not asked, with the reason. Reported, never acted on. */
  declined: Declined[];
  formats: number;
  validPuzzles: number;
  openRounds: number;
}

/**
 * The pass a project with no sprint returns.
 *
 * A function rather than a shared constant, for `emptyFiled`'s reason: every
 * field is an array, and a constant returned from a function is the *same*
 * array every time — so a caller that appended to one would be appending to
 * the value every other project's empty pass reports.
 */
function emptyPass(): PuzzlePass {
  return {
    filed: {
      formats: [],
      demand: [],
      routes: [],
      economics: [],
      constraints: [],
      settled: [],
      refused: [],
    },
    systems: [],
    batches: [],
    compiled: [],
    promoted: [],
    opened: [],
    declined: [],
    formats: 0,
    validPuzzles: 0,
    openRounds: 0,
  };
}

export async function runPuzzleKernel(projectId: string): Promise<PuzzlePass> {
  // One read answers it for the many projects that hold no sprint at all,
  // which is what makes this cheap enough to run for every project every tick.
  const mode = await getCashMode(projectId);
  if (!mode) return emptyPass();

  const filed = await filePuzzleFindings({ projectId });
  const gate = await discoveryAllowed(projectId);

  const systems: PuzzleMaster[] = [];
  const batches: BatchReport[] = [];
  const compiled: PuzzleProduct[] = [];

  if (gate.allowed) {
    systems.push(...(await ensureSystems(projectId)));
    batches.push(...(await makePuzzles(projectId)));
    compiled.push(...(await compileWhatIsReady(projectId)));
  }

  const snapshot = await puzzleSnapshot(projectId);
  const economics = readEconomics(snapshot.economics);
  const maturity = await readMaturityFor(projectId, snapshot);

  /*
   * Promotion runs whether or not the sprint is winding down. The product is
   * compiled, the research behind it is spent, and it is qualified — handing
   * it to the portfolio is finishing rather than starting, and §30's rule is
   * that an off switch ends new discovery and never a customer's obligation.
   */
  const promoted = await promoteSellableProducts({
    projectId,
    snapshot,
    maturity,
    economics,
  });

  if (!gate.allowed) {
    return {
      filed,
      systems,
      batches,
      compiled,
      promoted,
      opened: [],
      declined: [{ subject: 'every question this kernel would ask', why: gate.reason }],
      formats: snapshot.formats.length,
      validPuzzles: snapshot.instances.filter((one) => one.validationState === 'VALID').length,
      openRounds: snapshot.openRounds,
    };
  }

  const plan = allocate({
    snapshot,
    economics,
    slots: Math.max(0, MAX_OPEN_PUZZLE_ROUNDS - snapshot.openRounds),
  });
  const opened = await openPuzzleAsks({ projectId, asks: plan.asks, snapshot });

  return {
    filed,
    systems,
    batches,
    compiled,
    promoted,
    opened,
    declined: plan.declined,
    formats: snapshot.formats.length,
    validPuzzles: snapshot.instances.filter((one) => one.validationState === 'VALID').length,
    openRounds: snapshot.openRounds,
  };
}

/**
 * Set up a system for every format this repository can actually make.
 *
 * Brain's to decide, and the reason it is Brain's is that every condition is a
 * fact about code and constants rather than a judgement: a generator exists or
 * it does not, a validator exists or it does not, a corpus carries commercial
 * rights or it does not. There is nothing here a model forms a view about.
 *
 * What Brain may **not** do is name a format, which is why this only ever
 * makes a system for a format already on the map — seeded by a person or
 * established by a gated claim.
 */
async function ensureSystems(projectId: string): Promise<PuzzleMaster[]> {
  const snapshot = await puzzleSnapshot(projectId);
  const existing = new Set((await listPuzzleMasters(projectId)).map((one) => one.formatKey));
  const out: PuzzleMaster[] = [];

  for (const view of snapshot.formats) {
    if (existing.has(view.key)) continue;
    const implementation = formatFor(view.key);
    if (!implementation?.render) continue;
    /*
     * Which corpus a format needs is a property of the format: a word search
     * needs words and a cryptogram needs passages. Trying every shipped corpus
     * and keeping the first that works would set a system up against material
     * that happens not to throw, which is a different thing from the right
     * one.
     */
    const corpusId = corpusForFormat(view.key);
    if (!corpusId) continue;

    const result = await defineMaster({
      projectId,
      actorRef: 'BRAIN',
      title: `${view.name} — medium`,
      formatName: view.name,
      corpusId,
      difficulty: 'MEDIUM',
      parameters: {},
    });
    if ('master' in result) out.push(result.master);
  }
  return out;
}

function corpusForFormat(key: string): string | null {
  if (key === 'cryptogram') return 'traditional-proverbs-v1';
  if (key === 'word search') return 'common-english-v1';
  /*
   * Sudoku and maze take no source material at all — their content is the
   * grid. They are given the word corpus because a master must name one, and
   * the generator ignores it. Said out loud because a reader seeing a word
   * list attached to a sudoku would reasonably wonder.
   */
  if (key === 'sudoku' || key === 'maze') return 'common-english-v1';
  return null;
}

/**
 * Generate for every system short of a catalog, inside one budget, **shared
 * evenly**.
 *
 * The share is the correction. The first version walked the masters in order
 * and gave each one everything it asked for until the budget ran out, which
 * looks fine and starves every system after the first: driving it live against
 * four systems produced forty sudoku, ten cryptograms and *nothing at all* for
 * the maze and the word search, for two passes running. Every row was healthy
 * and the operator report said `working systems 2` beside four set up.
 *
 * A system that cannot use its share gives the remainder back rather than
 * holding it — the cryptogram corpus has sixteen passages, so its catalog is
 * genuinely sixteen puzzles and asking for more finds duplicates — and what is
 * handed back goes to whoever is still short. So the budget is spent and the
 * systems fill together, which is what makes the *second* format's first
 * product possible at all.
 */
async function makePuzzles(projectId: string): Promise<BatchReport[]> {
  const masters = await listPuzzleMasters(projectId);
  const snapshot = await puzzleSnapshot(projectId);

  /*
   * What each system is aiming at: the catalog target, or the format's own
   * ceiling where it has one. A cryptogram corpus of sixteen passages is a
   * catalog of sixteen cryptograms, and asking for forty means twenty-four
   * refusals a pass, for ever.
   */
  const targetFor = (master: PuzzleMaster): number => {
    const ceiling = formatFor(master.formatKey)?.catalogCeiling;
    const bound = ceiling ? ceiling(master.corpusId, master.parameters) : null;
    return bound === null ? CATALOG_TARGET : Math.min(CATALOG_TARGET, bound);
  };
  const heldBy = (master: PuzzleMaster): number =>
    snapshot.instances.filter(
      (one) => one.masterId === master.id && one.validationState === 'VALID',
    ).length;

  const short = masters.filter(
    (master) => refusalFor(master) === null && heldBy(master) < targetFor(master),
  );
  if (short.length === 0) return [];

  const out: BatchReport[] = [];
  let budget = GENERATION_BUDGET;
  let remaining = short.length;

  for (const master of short) {
    if (budget <= 0) break;
    /*
     * An equal share of what is left, rounded up so the last system is not
     * handed a zero by division. A system that uses less than its share leaves
     * the rest in the budget for the ones after it.
     */
    const share = Math.max(1, Math.ceil(budget / remaining));
    remaining -= 1;
    const want = Math.min(share, budget, targetFor(master) - heldBy(master));
    if (want <= 0) continue;

    const report = await generateBatch({ projectId, masterId: master.id, count: want });
    budget -= report.made.length;
    if (report.made.length > 0 || report.blocked !== null || report.invalid.length > 0) {
      out.push(report);
    }
  }
  return out;
}

/**
 * Compile a product wherever there are enough puzzles no product already
 * holds.
 *
 * Bounded to one per system per pass and gated on *unused* instances, which is
 * what keeps this from manufacturing reskins: a product built from puzzles
 * already out is exactly what `qualify` reads as the same thing again, and
 * making one automatically every tick would fill the catalog with them. The
 * condition is the honest one — genuinely new content exists — rather than a
 * count of products.
 */
async function compileWhatIsReady(projectId: string): Promise<PuzzleProduct[]> {
  const snapshot = await puzzleSnapshot(projectId);
  const used = new Set<string>();
  for (const ids of snapshot.membership.values()) for (const id of ids) used.add(id);

  const out: PuzzleProduct[] = [];
  for (const master of snapshot.masters) {
    const fresh = snapshot.instances.filter(
      (one) =>
        one.masterId === master.id && one.validationState === 'VALID' && !used.has(one.id),
    );
    if (fresh.length < PRODUCT_SIZE) continue;

    const view = snapshot.formats.find((one) => one.key === master.formatKey);
    const ordinal =
      snapshot.products.filter((one) => one.masterId === master.id).length + 1;
    const result = await compileProduct({
      projectId,
      masterId: master.id,
      title: `${view?.name ?? master.formatKey} pack ${ordinal}`,
      /*
       * A downloadable pack, because that is what the rendered artifact
       * actually is. Compiling a PRINT_BOOK would claim a capability this
       * repository does not have — `TYPESET_FOR_PRINT` reads MISSING — and a
       * product class Brain cannot produce is a promise the catalog cannot
       * keep.
       */
      productClass: 'DIGITAL_DOWNLOAD',
      count: PRODUCT_SIZE,
    });
    if (!isRefusal(result)) out.push(result.product);
  }
  return out;
}

/**
 * The maturity reading, with the two things it needs from outside this kernel.
 *
 * Settlements come from the money ledger, because a payment is the only thing
 * that moves `REVENUE_PROVEN` and an agreement is not one. Held capabilities
 * come from §39's manufacturing programme, because a printing or binding
 * capability is a manufacturing capability and a second ladder here would be
 * the parallel universe the brief forbids.
 */
export async function readMaturityFor(
  projectId: string,
  snapshot: PuzzleSnapshot,
): Promise<FormatMaturity[]> {
  const entries = await listMoneyEntries({ projectId, limit: 2000 });
  const settled = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'SETTLEMENT' || !entry.opportunityId) continue;
    settled.add(entry.opportunityId);
  }

  const program = await getProgram(projectId);
  const held = program
    ? (await listCapabilities(program.id))
        .filter((one) => one.heldAt !== null)
        .map((one) => one.name)
    : [];

  return readMaturity({
    formats: snapshot.formats.map((one) => one.entry),
    masters: snapshot.masters.map((one) => ({ id: one.id, formatKey: one.formatKey })),
    instances: snapshot.instances,
    products: snapshot.products,
    qualifications: snapshot.qualifications,
    demand: snapshot.demand,
    routes: snapshot.routes,
    constraints: snapshot.constraints,
    observations: snapshot.observations,
    settledOpportunityIds: settled,
    heldCapabilities: held,
  });
}

/**
 * What the allocator would do next, without anything being created.
 *
 * Exported separately from the pass that acts on it so a person — or a test —
 * can look before anything moves. `services/dealflow/kernel.ts` and
 * `services/industry/kernel.ts` both split reading from applying for the same
 * reason.
 */
export function planFrom(
  snapshot: PuzzleSnapshot,
  economics: readonly UnitEconomics[],
): { asks: Ask[]; declined: Declined[] } {
  return allocate({
    snapshot,
    economics,
    slots: Math.max(0, MAX_OPEN_PUZZLE_ROUNDS - snapshot.openRounds),
  });
}

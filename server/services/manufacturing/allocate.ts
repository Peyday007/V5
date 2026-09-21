/**
 * Which question the kernel asks next, and why.
 *
 * ---------------------------------------------------------------------------
 * Pure, for the reason `services/dispatch/router.ts` is pure
 * ---------------------------------------------------------------------------
 *
 * A function over a recorded snapshot, so "why did Brain research that" is
 * answerable afterwards from an input rather than from a re-run against a
 * database that has moved on. Being pure also makes it useless as a safety
 * mechanism, which is deliberate and is the same split the dispatcher draws:
 * the exclusion is the unique index on `manufacturing_rounds`, so two ticks
 * both deciding correctly that a category should be asked about produce one
 * round.
 *
 * ---------------------------------------------------------------------------
 * The rule order is the brief's core principle, not a preference
 * ---------------------------------------------------------------------------
 *
 *     Distribution and demand intelligence should pull manufacturing forward.
 *     Manufacturing should not blindly search for demand afterward.
 *
 * So `DEMAND` outranks `CAPABILITY` for every category, always. Establishing
 * what a machine takes to build, for a machine nobody has shown anybody is
 * buying, is the exact inversion the brief exists to forbid — and it is the
 * expensive inversion, because capability research is the long kind.
 *
 * Underneath that, the order follows what the answers unlock: finish the
 * category that is closest to being enterable, then close the gap on one whose
 * demand is proven, then look at what has never been looked at, then widen the
 * ladder, then come back to what has gone quiet.
 *
 * Lexicographic over rules rather than a weighted score. A score needs weights,
 * weights are a judgement nobody made, and the number then reads like a
 * measurement — `verdict.ts` settled this for industry subjects and
 * `portfolio.ts` for opportunities, and nothing about machines changes it.
 *
 * ---------------------------------------------------------------------------
 * It stops
 * ---------------------------------------------------------------------------
 *
 * Three bounds, each a bound rather than a preference. A category with a live
 * round of a purpose is not asked that question twice at once. A settled round
 * waits out a cool-off. And a category asked the demand question
 * `BARREN_ROUNDS` times with nothing published coming back is not asked again
 * — not because looking is forbidden, but because Brain has now documented that
 * nothing is there, and §13's rule about the archive applies to Brain's own
 * history exactly as it applies to a project's.
 *
 * What is deliberately *not* a bound is a lifetime quota. §24 removed exactly
 * that kind of number and recorded why: nothing it rationed was scarce, so it
 * measured a starting point and then became a permanent ceiling. What bounds
 * this is how many questions may be open at once, which is real.
 */
import { BARREN_ROUNDS, ROUND_COOL_OFF_MS } from '../cash/discovery.ts';
import { readLadder, type CategoryReading } from './readiness.ts';
import type { CategoryCoverage, LadderSnapshot } from './ladder.ts';
import type { ManufacturingRound, ManufacturingRoundPurpose } from '../../domain/types.ts';

export interface Ask {
  purpose: ManufacturingRoundPurpose;
  categoryId: string | null;
  round: number;
  /** Which rule admitted it. Lower is stronger, and the numbers are spaced. */
  rank: number;
  /**
   * What this is about, in words a person reads.
   *
   * Carried on the ask rather than resolved by each reader. §38 records the
   * first version of the industry allocator leaving every decline reading
   * `ind_d947…: there is no free slot` — technically true and useless, and §29
   * records what a status nobody can read costs: they stop reading it.
   */
  subject: string;
  /**
   * When Brain came to know about this category. The tiebreak between asks of
   * equal rank.
   *
   * Eleven categories with no evidence between them are genuinely equal, and
   * breaking that tie on the generated id is deterministic, meaningless, and
   * leaves the same categories at the back of the queue for ever.
   */
  since: string;
  /** The recorded input, in words, so the decision can be argued with. */
  why: string;
}

/**
 * How many programme questions may be open at once.
 *
 * Matched to `PROGRAMME_CONCURRENCY` in `program.ts` rather than chosen
 * separately: a kernel that queued more than the grant will run produces a
 * backlog that looks like progress. It is concurrency and not an allowance.
 */
export const MAX_OPEN_PROGRAMME_ROUNDS = 3;

export interface Allocation {
  asks: Ask[];
  /** Everything considered and not asked, with the reason. Reported, not acted on. */
  declined: { subject: string; why: string }[];
}

export function allocate(input: {
  snapshot: LadderSnapshot;
  /** How many more rounds may be opened now. Never negative. */
  slots: number;
}): Allocation {
  const { snapshot } = input;
  const slots = Math.max(0, Math.trunc(input.slots));
  const declined: Allocation['declined'] = [];
  const candidates: Ask[] = [];

  const readings = new Map(readLadder(snapshot).map((one) => [one.categoryId, one]));

  /*
   * Rule 0 — the opening question.
   *
   * There is no list of machine categories in this codebase and this is why:
   * the first question asks what classes of machine the trade and statistical
   * sources actually recognise, and the categories arrive as gated claims. The
   * brief's own six levels are an example sequence it explicitly refuses to
   * mandate, so a constant holding them would encode the one thing it says not
   * to encode.
   *
   * It is first only while the ladder is empty, which is the one state in
   * which nothing else can be asked at all.
   */
  if (!snapshot.bootstrap.asked) {
    candidates.push({
      purpose: 'BOOTSTRAP',
      categoryId: null,
      round: 1,
      rank: 50,
      subject: 'the machines themselves',
      since: snapshot.at,
      why: 'The ladder is empty, so nothing has been asked what classes of machine exist.',
    });
  } else if (snapshot.bootstrap.open) {
    declined.push({
      subject: 'the opening question',
      why: 'It is already running, and asking again would duplicate its spending.',
    });
  }

  for (const coverage of snapshot.coverage) {
    const reading = readings.get(coverage.category.id);
    if (!reading) continue;
    if (reading.verdict === 'RETIRED') {
      declined.push({ subject: reading.path.join(' → '), why: reading.because });
      continue;
    }
    const where = reading.path.join(' → ');
    const since = coverage.category.createdAt;

    /*
     * Rule 1 — finish the category that is closest to being enterable.
     *
     * Demand and a route are established and what it takes to build is not.
     * This is the most expensive thing in the kernel to leave alone: the
     * research that found the demand is already paid for, and without this
     * nobody can say what stands between here and producing it.
     *
     * `launchOrdinal` makes the same argument one layer down and production
     * measured what its absence cost — twenty openings found and both of their
     * deep dives queued behind fifty broad searches.
     */
    if (
      reading.verdict === 'BUILD_CAPABILITY_FIRST' &&
      coverage.requires.length === 0 &&
      !coverage.open.CAPABILITY &&
      !barrenOf(coverage, 'CAPABILITY')
    ) {
      candidates.push({
        purpose: 'CAPABILITY',
        categoryId: coverage.category.id,
        round: nextRound(snapshot.rounds, 'CAPABILITY', coverage.category.id),
        rank: 100 + coverage.depth,
        subject: where,
        since,
        why:
          `Somebody is buying in ${where} and there is a published route to them, and nothing ` +
          'has established what producing there actually requires.',
      });
    }

    /*
     * Rule 2 — demand before anything else about a category.
     *
     * The brief's core principle as an ordering. A category whose demand has
     * never been asked about is asked about that and nothing else, however
     * interesting its engineering is, because every other answer about it is
     * worth nothing until somebody is established to be buying.
     */
    if (coverage.settled.DEMAND === 0 && !coverage.open.DEMAND) {
      candidates.push({
        purpose: 'DEMAND',
        categoryId: coverage.category.id,
        round: nextRound(snapshot.rounds, 'DEMAND', coverage.category.id),
        rank: 200 + coverage.depth,
        subject: where,
        since,
        why:
          `Nothing has asked who is buying in ${where}, how product reaches them, or where ` +
          'what is on the market today falls short.',
      });
    }

    /*
     * Rule 3 — what a proven category takes to build.
     *
     * Behind rule 2 for every *other* category, which is the point: the kernel
     * establishes demand broadly before it establishes capability deeply. A
     * category that has reached here has published buyers, so the long question
     * is worth asking of it.
     */
    if (
      coverage.demand.length > 0 &&
      coverage.settled.CAPABILITY === 0 &&
      !coverage.open.CAPABILITY
    ) {
      candidates.push({
        purpose: 'CAPABILITY',
        categoryId: coverage.category.id,
        round: nextRound(snapshot.rounds, 'CAPABILITY', coverage.category.id),
        rank: 300 + coverage.depth,
        subject: where,
        since,
        why:
          `${where} has published buyers and nothing has established what producing there ` +
          'requires, what it develops, or what has to be certified first.',
      });
    }

    /*
     * Rule 4 — what is bought in rather than made.
     *
     * The brief's vertical-integration question, and it is asked of a category
     * whose requirements are already established because that is what makes the
     * answer mean anything: a component list with no capability list beside it
     * cannot say whether making it in-house would be reachable.
     *
     * It is never a recommendation to integrate. *Do NOT vertically integrate
     * merely for ideological reasons* is the brief's own sentence, and nothing
     * in this kernel forms a view about whether integrating is worth it — it
     * establishes what is bought in, and a person decides.
     */
    if (
      coverage.requires.length > 0 &&
      coverage.settled.INTEGRATION === 0 &&
      !coverage.open.INTEGRATION
    ) {
      candidates.push({
        purpose: 'INTEGRATION',
        categoryId: coverage.category.id,
        round: nextRound(snapshot.rounds, 'INTEGRATION', coverage.category.id),
        rank: 400 + coverage.depth,
        subject: where,
        since,
        why:
          `What producing in ${where} requires is established, and nothing has established ` +
          'which parts of it producers buy in rather than make.',
      });
    }

    /*
     * Rule 5 — widen the ladder where something was found.
     *
     * The recursion the brief asks for, and the condition it turns on is
     * evidence rather than enthusiasm: a category only earns decomposition once
     * something published has actually come back about it. Behind capability
     * work, because a broader ladder with nothing established on it is a longer
     * list of things nobody has looked at.
     */
    if (
      coverage.demand.length + coverage.requires.length > 0 &&
      coverage.settled.MAP === 0 &&
      !coverage.open.MAP
    ) {
      candidates.push({
        purpose: 'MAP',
        categoryId: coverage.category.id,
        round: nextRound(snapshot.rounds, 'MAP', coverage.category.id),
        rank: 500 + coverage.depth,
        subject: where,
        since,
        why:
          `${where} has produced published evidence and nothing has established what narrower ` +
          'or adjacent classes of machine sit around it.',
      });
    }

    /*
     * Rule 6 — come back to what has gone quiet.
     *
     * Shipments, registrations and tenders are published continuously, so a
     * settled demand round is a reading of one moment rather than a final
     * answer. Only past the cool-off, and never for a category already
     * documented barren, which is what keeps "ongoing" from becoming
     * "uncontrolled".
     */
    if (
      coverage.settled.DEMAND > 0 &&
      !coverage.open.DEMAND &&
      !barrenOf(coverage, 'DEMAND') &&
      pastCoolOff(coverage, snapshot.at)
    ) {
      candidates.push({
        purpose: 'DEMAND',
        categoryId: coverage.category.id,
        round: nextRound(snapshot.rounds, 'DEMAND', coverage.category.id),
        rank: 600 - Math.min(99, coverage.demand.length),
        subject: where,
        since,
        why:
          `${where} was last asked who is buying ${coverage.settled.DEMAND} round` +
          (coverage.settled.DEMAND === 1 ? '' : 's') +
          ' ago and the cool-off has passed. Shipments and tenders are published continuously.',
      });
    }

    if (barrenOf(coverage, 'DEMAND')) {
      declined.push({
        subject: where,
        why:
          `${coverage.settled.DEMAND} rounds have asked who is buying in ${where} and nothing ` +
          'published came back. Brain has documented that there is nothing there.',
      });
    }
  }

  candidates.sort(
    (a, b) => a.rank - b.rank || a.since.localeCompare(b.since) || compareAsk(a, b),
  );

  /*
   * One question per category per pass.
   *
   * Without it a category that qualifies under three rules takes every slot and
   * everything else waits — which is the failure the dispatcher already had to
   * correct once, where one bin's refusal ended the whole burst. Breadth is the
   * point of a coverage engine, and here it is also the core principle: a
   * kernel that spent all three slots on one category's capability research
   * would be deepening before it had broadened.
   */
  const taken = new Set<string>();
  const asks: Ask[] = [];
  for (const ask of candidates) {
    if (asks.length >= slots) {
      declined.push({
        subject: ask.subject,
        why: 'There is no free slot this pass. It is the next thing asked when one opens.',
      });
      continue;
    }
    const key = ask.categoryId ?? 'bootstrap';
    if (taken.has(key)) {
      declined.push({
        subject: ask.subject,
        why: 'Something else about the same category is being asked this pass.',
      });
      continue;
    }
    taken.add(key);
    asks.push(ask);
  }
  return { asks, declined };
}

/**
 * Asked enough times, with nothing to show for it.
 *
 * Both halves have to hold: a category asked once and told nothing is not
 * barren, and a category whose rounds produced findings is never barren
 * however many there have been.
 */
function barrenOf(coverage: CategoryCoverage, purpose: ManufacturingRoundPurpose): boolean {
  return coverage.settled[purpose] >= BARREN_ROUNDS && coverage.found[purpose] === 0;
}

function pastCoolOff(coverage: CategoryCoverage, now: string): boolean {
  const settled = coverage.lastSettledAt;
  if (!settled) return false;
  return Date.parse(now) - Date.parse(settled) >= ROUND_COOL_OFF_MS;
}

/** The last resort when rank and age are both equal. Stable, never meaningful. */
function compareAsk(a: Ask, b: Ask): number {
  return (a.categoryId ?? '').localeCompare(b.categoryId ?? '') || a.purpose.localeCompare(b.purpose);
}

/** The next asking of one exact question, from what has already been asked. */
export function nextRound(
  rounds: readonly ManufacturingRound[],
  purpose: ManufacturingRoundPurpose,
  categoryId: string | null,
): number {
  return (
    rounds
      .filter((one) => one.purpose === purpose && one.categoryId === categoryId)
      .reduce((highest, one) => Math.max(highest, one.round), 0) + 1
  );
}

/** Re-exported so a caller can read the ladder and the plan from one import. */
export type { CategoryReading };

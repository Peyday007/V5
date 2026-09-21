/**
 * Which question this kernel asks next, and why.
 *
 * ---------------------------------------------------------------------------
 * Pure over a recorded snapshot
 * ---------------------------------------------------------------------------
 *
 * `services/dispatch/router.ts` draws the line and §38, §39 and §45 all
 * follow it: this is a pure function, so *why did Brain research that* is
 * answerable from a recorded input rather than from a re-run against a
 * database that has moved. Being pure also makes it useless as a safety
 * mechanism — two ticks can both compute the same allocation — so the
 * exclusion is the partial unique index on the live rounds, never the
 * decision. It can under-ask and it cannot over-ask.
 *
 * ---------------------------------------------------------------------------
 * Finishing something outranks starting something
 * ---------------------------------------------------------------------------
 *
 * §45 records this ordering being written the wrong way round at a deal and
 * corrected, and §38 before it: the research that found a thing has already
 * been paid for, so the question that is one fact from making it usable beats
 * the question that adds another thing to the map. Every rule below is in that
 * order, and the last three — widening the universe, widening the ledger, and
 * the one specific product shape the directive names — are last precisely
 * because the first two never run out and the third stands on both.
 *
 * ---------------------------------------------------------------------------
 * Nothing here is a lifetime quota
 * ---------------------------------------------------------------------------
 *
 * `MAX_OPEN_PUZZLE_ROUNDS` bounds how many questions are open **at once**,
 * which is real provider capacity. §24 removed exactly the other kind of
 * number — a lifetime cap that measured a starting point and then became a
 * permanent ceiling — and recorded why. A subject that goes quiet is bounded
 * by `BARREN_ROUNDS`, which is Brain having documented that nothing is there:
 * §13's rule about the archive, applied to Brain's own history.
 */
import { readLedger } from './ledger.ts';
import { readFormats, readOutputs } from './maturity.ts';
import { enginesForFormat } from './engines/index.ts';
import type { PuzzleSnapshot } from './graph.ts';
import type { PuzzleRoundPurpose } from '../../domain/types.ts';

/** How many questions may be open at once. Concurrency, never a quota. */
export const MAX_OPEN_PUZZLE_ROUNDS = 3;

/** How long a settled round's subject rests before the same purpose is asked again. */
export const COOL_OFF_MS = 24 * 60 * 60 * 1000;

/**
 * How many times one subject may be asked one purpose and establish nothing
 * before it is left alone.
 *
 * Brain has then documented that there is nothing there, and asking again
 * spends the allowance to learn what its own rows already say.
 */
export const BARREN_ROUNDS = 2;

export interface Ask {
  purpose: PuzzleRoundPurpose;
  /** The key the round is about, or null for the two questions that are about nothing yet. */
  subjectKey: string | null;
  subjectLabel: string | null;
  round: number;
  /** The allocator's own sentence, recorded with the round it produced. */
  why: string;
  rank: number;
}

export interface Declined {
  subject: string;
  why: string;
}

interface Candidate {
  purpose: PuzzleRoundPurpose;
  subjectKey: string | null;
  subjectLabel: string | null;
  why: string;
}

export function allocate(input: {
  snapshot: PuzzleSnapshot;
  slots: number;
}): { asks: Ask[]; declined: Declined[] } {
  const { snapshot } = input;
  const declined: Declined[] = [];
  const candidates: Candidate[] = [];

  const outputs = readOutputs(snapshot);
  const formats = readFormats(snapshot);
  const ledger = readLedger(snapshot, outputs);

  /* ---- 1. A format that produces and has no standard to be judged by ---- */
  for (const format of formats) {
    if (format.instances === 0) continue;
    if (format.demandedChecks.length > 0) continue;
    candidates.push({
      purpose: 'STANDARD',
      subjectKey: format.formatKey,
      subjectLabel: format.name,
      why:
        `${format.name} already produces ${format.instances} puzzle(s) and nothing establishes ` +
        'what the trade demands of one, so there is no standard for its validator to be judged ' +
        'against. The production is already paid for; this is the fact that makes it usable.',
    });
  }

  /* ---- 2. A format that produces and whose rights nobody has looked at ---- */
  for (const format of formats) {
    if (format.instances === 0) continue;
    if (snapshot.rights.some((one) => one.formatKey === format.formatKey)) continue;
    candidates.push({
      purpose: 'RIGHTS',
      subjectKey: format.formatKey,
      subjectLabel: format.name,
      why:
        `${format.name} produces and nothing establishes what may lawfully be sold in it. A ` +
        'format with no rights rows has not been cleared — nobody has looked — and this is the ' +
        'one question whose wrong answer is not recoverable by repairing anything.',
    });
  }

  /* ---- 3. A route with a product ready for it and nobody known to buy ---- */
  for (const route of ledger.allActive) {
    if (route.readyOutputs === 0) continue;
    if (route.demandSignals.length > 0 || route.searchedAndEmpty > 0) continue;
    candidates.push({
      purpose: 'DEMAND',
      subjectKey: route.routeId,
      subjectLabel: route.name,
      why:
        `${route.readyOutputs} qualified product(s) are aimed at "${route.name}" and nothing ` +
        'establishes that anybody buys through it. The product exists; this is the fact ' +
        'between it and a sale.',
    });
  }

  /* ---- 4. A route with demand and no published price ---- */
  for (const route of ledger.allActive) {
    if (route.demandSignals.length === 0) continue;
    if (route.priced) continue;
    candidates.push({
      purpose: 'ECONOMICS',
      subjectKey: route.routeId,
      subjectLabel: route.name,
      why:
        `Somebody publishes that they buy through "${route.name}" and nothing publishes what ` +
        'they pay. A route with demand and no price is one nobody can decide about.',
    });
  }

  /* ---- 6. Active routes nobody has looked at, best-ranked first ---- */
  for (const route of ledger.unproven) {
    candidates.push({
      purpose: 'DEMAND',
      subjectKey: route.routeId,
      subjectLabel: route.name,
      why:
        `"${route.name}" is on the ledger and nobody has looked at it. It ranks ${route.rank} ` +
        'of the active routes on what is currently known.',
    });
  }

  /* ---- 7. Widen the universe ---- */
  candidates.push({
    purpose: 'UNIVERSE',
    subjectKey: null,
    subjectLabel: null,
    why:
      snapshot.formats.length === 0
        ? 'Nothing is on the map yet, so this is the only question there is.'
        : `${snapshot.formats.length} format(s) are on the map. The directive asks for the ` +
          'universe to be continuously expanded from evidence, and this is the one question ' +
          'that names sources rather than formats, so it is the one that can reach outside ' +
          'what is already here.',
  });

  /* ---- 8. Widen the ledger ---- */
  candidates.push({
    purpose: 'ROUTE',
    subjectKey: null,
    subjectLabel: null,
    why:
      `${ledger.totals.routes} route(s) are on the ledger and ${ledger.totals.withDemand} of ` +
      'them have a dated buying signal. Widening it is the cheapest way to find a route that ' +
      'reaches a paid proof without inventory.',
  });

  /* ---- 9. The directive's own investigation, asked once ---- */
  if (!snapshot.rounds.some((one) => one.purpose === 'CHEAP_BOOK')) {
    candidates.push({
      purpose: 'CHEAP_BOOK',
      subjectKey: null,
      subjectLabel: null,
      why:
        'The directive names this reverse-engineering explicitly and nothing has asked it. It ' +
        'decides whether the highest-volume shape of this business is a route, a downstream ' +
        'use of an already-paid-for catalogue, or one to decline — and it is asked after ' +
        'the two questions that say what exists and how money is captured, because it is one ' +
        'specific product shape rather than the ground those stand on.',
    });
  }

  /* ---- Now bound it ---- */
  const asks: Ask[] = [];
  for (const candidate of candidates) {
    const label = candidate.subjectLabel ?? candidate.purpose;

    if (asks.length >= input.slots) {
      declined.push({
        subject: label,
        why:
          input.slots === 0
            ? `${MAX_OPEN_PUZZLE_ROUNDS} question(s) are already open, which is the limit on how ` +
              'many may run at once.'
            : 'The free slots went to questions ranked above it on this pass.',
      });
      continue;
    }

    const history = snapshot.rounds.filter(
      (one) => one.purpose === candidate.purpose && one.subjectKey === candidate.subjectKey,
    );

    if (history.some((one) => one.state === 'OPEN')) {
      declined.push({
        subject: label,
        why: 'That exact question is already open.',
      });
      continue;
    }

    const settled = history.filter((one) => one.state !== 'OPEN');
    const barren = settled.filter((one) => (one.found ?? 0) === 0);
    if (barren.length >= BARREN_ROUNDS) {
      declined.push({
        subject: label,
        why:
          `${barren.length} round(s) of this question established nothing. Brain has documented ` +
          'that there is nothing there, and asking again would spend the allowance to learn ' +
          'what these rows already say.',
      });
      continue;
    }

    const newest = settled
      .map((one) => one.settledAt)
      .filter((one): one is string => Boolean(one))
      .sort()
      .pop();
    if (newest) {
      // The instant is the snapshot's, never a clock this function reads: a
      // pure decision that took its own time would answer differently on a
      // re-run against the same recorded input.
      const elapsed = Date.parse(snapshot.at) - Date.parse(newest);
      if (Number.isFinite(elapsed) && elapsed < COOL_OFF_MS) {
        declined.push({
          subject: label,
          why: 'That question settled recently enough that asking it again would be the same ' +
            'search twice.',
        });
        continue;
      }
    }

    asks.push({
      purpose: candidate.purpose,
      subjectKey: candidate.subjectKey,
      subjectLabel: candidate.subjectLabel,
      round: settled.length + 1,
      why: candidate.why,
      rank: asks.length + 1,
    });
  }

  return { asks, declined };
}

/**
 * Formats that have an engine but no reviewed master.
 *
 * Not an ask — it is a **person's** decision, so it can never become a round.
 * It is surfaced by `view.ts` under what needs a person, because a format with
 * a generator nobody has reviewed is the one condition here that Brain can see
 * clearly and must not resolve.
 */
export function awaitingReview(snapshot: PuzzleSnapshot): { formatKey: string; name: string }[] {
  return snapshot.formats
    .filter((format) => {
      if (format.retiredAt) return false;
      if (enginesForFormat(format.formatKey).length === 0) return false;
      const masters = snapshot.masters.filter(
        (one) => one.formatKey === format.formatKey && !one.retiredAt,
      );
      return masters.length > 0 && masters.every((one) => one.reviewedAt === null);
    })
    .map((one) => ({ formatKey: one.formatKey, name: one.name }));
}

/**
 * Opening the kernel's questions, and absorbing what comes back.
 *
 * ---------------------------------------------------------------------------
 * This is an entrance, not a pipeline
 * ---------------------------------------------------------------------------
 *
 * Nothing here researches anything. It creates a Russell candidate and lets
 * the path that already exists do all of it: `judgeCandidate` asks the archive
 * first (§13), the compiler writes the specification, the approval envelope
 * decides whether it may start, the evidence gate decides what may be claimed,
 * and all three audit roles decide whether it stands. Everything this kernel
 * adds is a new way *in* to machinery Steps 4 to 12C already built.
 *
 * ---------------------------------------------------------------------------
 * Only one finding creates a row, and that is the universe rule
 * ---------------------------------------------------------------------------
 *
 * `PUZZLE_FORMAT` puts a subject on the map, because the map is what expands
 * from evidence. The other five stay on the claim and are read through it —
 * §31's argument, one kernel along: the claim already carries the statement,
 * the source, the publisher and the date, and a table beside it would be a
 * copy, which is the one nobody reconciles.
 *
 * ---------------------------------------------------------------------------
 * Absorbing is a lookup, never a reading
 * ---------------------------------------------------------------------------
 *
 * Every row this writes comes from a claim that cleared the gate and carries a
 * declaration from a closed set — or, for a format, a name a source gave.
 * Nothing here inspects a sentence or decides from prose that something sounds
 * like a puzzle format.
 */
import { recordEvent } from '../../repos/events.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { listMissions } from '../../repos/russellMissions.ts';
import { puzzleClaims } from '../../repos/research.ts';
import { closePuzzleRound, openPuzzleRound, openRoundsByCandidate, upsertFormat } from '../../repos/puzzles.ts';
import { findingCreatesFormat, isPuzzleFinding, slugFor } from '../../domain/puzzles.ts';
import { compose, standingFor } from './questions.ts';
import { supportFor, unimplementedReason } from './registry.ts';
import type { Ask } from './allocate.ts';
import type { PuzzleSnapshot } from './map.ts';
import type { PuzzleFormat, PuzzleRound, PuzzleRoundPurpose } from '../../domain/types.ts';

const OPENED = 'PUZZLE_ROUND_OPENED';
const ABSORBED = 'PUZZLE_FINDINGS_ABSORBED';

export interface OpenedRound {
  roundId: string;
  formatId: string | null;
  purpose: PuzzleRoundPurpose;
  candidateId: string;
  round: number;
  title: string;
  why: string;
}

export interface Absorbed {
  /** Formats a gated claim put on the map. */
  formats: PuzzleFormat[];
  /** Findings recorded against a format without creating one. */
  facts: { claimId: string; finding: string; subject: string }[];
  settled: { roundId: string; found: number }[];
  /** What could not be filed, kept beside what could. */
  refused: { claimId: string; why: string }[];
}

/**
 * Turn the allocator's decisions into work.
 *
 * The round is written *after* the candidate and the insert is
 * `ON CONFLICT DO NOTHING`, so a tick that dies between the two leaves a
 * candidate nothing points at — harmless, because the next tick's insert
 * collides on the same key and the orphan is never asked anything.
 */
export async function openAsks(input: {
  projectId: string;
  asks: readonly Ask[];
  snapshot: PuzzleSnapshot;
}): Promise<OpenedRound[]> {
  const byFormat = new Map(input.snapshot.formats.map((one) => [one.formatId, one]));
  const out: OpenedRound[] = [];

  for (const ask of input.asks) {
    const reading = ask.formatId ? byFormat.get(ask.formatId) : null;
    const generatable =
      reading?.rungs.find((one) => one.rung === 'GENERATABLE')?.state === 'MET';

    const composed = compose({
      purpose: ask.purpose,
      round: ask.round,
      subject: {
        format: reading?.name ?? null,
        standing: standingFor({
          format: reading?.name ?? null,
          generatable,
          validated: reading?.counts.validated ?? 0,
          blocker:
            reading && !generatable
              ? unimplementedReason(reading.slug, reading.name)
              : null,
        }),
      },
    });

    const candidate = await createCandidate({
      projectId: input.projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title: ask.round === 1 ? composed.title : `${composed.title} (round ${ask.round})`,
      statement: composed.question,
    });

    const opened = await openPuzzleRound({
      projectId: input.projectId,
      formatId: ask.formatId,
      purpose: ask.purpose,
      round: ask.round,
      candidateId: candidate.id,
    });
    if (!opened.created) continue;

    await recordEvent({
      projectId: input.projectId,
      entityType: 'puzzle_kernel',
      entityId: ask.formatId ?? undefined,
      eventType: OPENED,
      payload: {
        roundId: opened.round.id,
        formatId: ask.formatId,
        purpose: ask.purpose,
        round: ask.round,
        candidateId: candidate.id,
        /*
         * The allocator's recorded reason, carried onto the event. §38 records
         * what the alternative cost: a decline that read as a bare id, which
         * §29 says teaches a person to stop reading the surface.
         */
        why: ask.why,
      },
    });

    out.push({
      roundId: opened.round.id,
      formatId: ask.formatId,
      purpose: ask.purpose,
      candidateId: candidate.id,
      round: ask.round,
      title: composed.title,
      why: ask.why,
    });
  }

  return out;
}

export async function absorb(input: { projectId: string; limit?: number }): Promise<Absorbed> {
  const out: Absorbed = { formats: [], facts: [], settled: [], refused: [] };

  const limit = Math.max(1, input.limit ?? 60);
  const live = await openRoundsByCandidate(input.projectId);
  if (live.size === 0) return out;

  /*
   * Which round each orchestration belongs to, through the mission.
   *
   * An orchestration with no mission belongs to no puzzle round, which is
   * honest rather than a gap: nobody asked a puzzle question for it, and
   * absorbing its claims would put a format on the map that no round asked
   * about.
   */
  const missions = await listMissions({ projectId: input.projectId });
  const byOrchestration = new Map<
    string,
    { round: PuzzleRound; settles: 'HARVESTED' | 'ABANDONED' | null }
  >();
  for (const mission of missions) {
    if (!mission.orchestrationId || !mission.candidateId) continue;
    const round = live.get(mission.candidateId);
    if (!round) continue;
    byOrchestration.set(mission.orchestrationId, {
      round,
      /*
       * A round settles on *any* terminal mission, not only a successful one.
       *
       * A mission that failed or was cancelled has answered this question as
       * far as it is going to, and a round left OPEN is precisely what stops
       * that purpose being asked again — for ever, since nothing else will
       * close it. §24's *waiting nobody can resolve*, arriving through a table
       * nobody would think to look at. The two outcomes stay distinct, because
       * "it ran and found nothing" and "it never finished" have different
       * remedies and the allocator's barren rule reads only the first.
       */
      settles:
        mission.state === 'DONE'
          ? 'HARVESTED'
          : mission.state === 'FAILED' || mission.state === 'CANCELLED'
            ? 'ABANDONED'
            : null,
    });
  }
  if (byOrchestration.size === 0) return out;

  const foundPerRound = new Map<string, number>();

  const claims = await puzzleClaims({
    projectId: input.projectId,
    orchestrationIds: [...byOrchestration.keys()],
    limit,
  });

  for (const entry of claims) {
    const context = byOrchestration.get(entry.orchestrationId);
    if (!context) continue;

    const finding = entry.claim.puzzleFinding;
    const subject = (entry.claim.puzzleSubject ?? '').trim();
    if (!isPuzzleFinding(finding) || !subject) {
      out.refused.push({
        claimId: entry.claim.id,
        why: 'the declaration on this claim is not one this kernel recognises',
      });
      continue;
    }

    if (findingCreatesFormat(finding)) {
      if (!slugFor(subject)) {
        out.refused.push({
          claimId: entry.claim.id,
          why: `"${subject}" has no nameable name, so it cannot go on the map`,
        });
        continue;
      }
      const result = await upsertFormat({
        projectId: input.projectId,
        name: subject,
        description: entry.claim.claim,
        origin: 'DISCOVERED',
        sourceClaimId: entry.claim.id,
      });
      if (result.created) out.formats.push(result.format);
      /*
       * Counted whether or not it was new. `found` is what the allocator's
       * barren rule reads, and a round that re-established three formats
       * somebody already knew about has established something — it just has
       * not expanded the map. Counting only new rows would make a confirming
       * round look barren and retire the question.
       */
      foundPerRound.set(context.round.id, (foundPerRound.get(context.round.id) ?? 0) + 1);
      continue;
    }

    /*
     * Everything else stays on the claim. Recorded here so the pass can report
     * it and the round can count it; the readings query the claims directly.
     */
    out.facts.push({ claimId: entry.claim.id, finding, subject });
    foundPerRound.set(context.round.id, (foundPerRound.get(context.round.id) ?? 0) + 1);
  }

  /*
   * A round settles by its own bookkeeping rather than by the loop ending.
   *
   * `found` is what the next round is decided against, so a round whose
   * mission has finished has to record what it produced — **including
   * nothing**. Leaving a barren round OPEN would stop it ever being asked
   * again while looking like it was still running, which is the state this
   * kernel is built to make impossible.
   */
  for (const { round, settles } of byOrchestration.values()) {
    if (!settles) continue;
    const found = foundPerRound.get(round.id) ?? 0;
    if (await closePuzzleRound({ id: round.id, state: settles, found })) {
      out.settled.push({ roundId: round.id, found });
    }
  }

  if (out.formats.length + out.facts.length > 0 || out.refused.length > 0) {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'puzzle_kernel',
      eventType: ABSORBED,
      payload: {
        formats: out.formats.length,
        formatIds: out.formats.map((one) => one.id),
        facts: out.facts.length,
        /*
         * How many of the discovered formats this Brain can actually make.
         * The gap between the two numbers is the whole reason the universe and
         * the registry are separate things.
         */
        generatable: out.formats.filter((one) => supportFor(one.slug) !== null).length,
        refused: out.refused,
      },
    });
  }

  return out;
}

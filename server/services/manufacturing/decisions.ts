/**
 * The decisions this kernel cannot make, and must not quietly forget.
 *
 * ---------------------------------------------------------------------------
 * Why an unanswered question is a row
 * ---------------------------------------------------------------------------
 *
 * The directive asks for **one master brand** capable of appearing on a
 * pressure washer and on a cargo aircraft, says it must therefore not describe
 * the original product category, sketches `[MASTER BRAND] EQUIPMENT` /
 * `MOTOR` / `INDUSTRIAL` / `AEROSPACE` — and then says, in its own words, *do
 * not lock these division names prematurely*.
 *
 * Both halves are load-bearing and the obvious readings break one of them.
 * Inventing a name is Brain deciding something reserved to a person, and it is
 * the kind of decision that becomes expensive to reverse the moment anything
 * is printed. Dropping the concern because it cannot be decided yet loses the
 * requirement entirely: nothing would ever raise it again, and the first time
 * anybody noticed would be when a category outgrew a name chosen by accident.
 *
 * So **`OPEN` is valid state**, and it is the state this decision is in. What
 * makes that useful rather than a note is everything below: the criteria it
 * would have to satisfy, what it currently depends on, and the condition under
 * which it stops being safe to leave open — all derived from the ladder, so
 * they move as the ladder does.
 *
 * ---------------------------------------------------------------------------
 * Derived, never stored
 * ---------------------------------------------------------------------------
 *
 * `programme_decisions` holds four things: which topic, whether it is open, a
 * person's own words if they resolved it, and who. It holds no criteria, no
 * dependency list and no trigger, because every one of those is a fact about
 * rows that change underneath it — the span the brand has to cover *is* the
 * ladder, and a stored criterion would be stale the moment a category was
 * added. `ladder.ts`, `tier.ts` and `placements` all make the same argument;
 * this is it at the one row whose whole purpose is to stay unanswered.
 *
 * ---------------------------------------------------------------------------
 * Nothing here proposes a name
 * ---------------------------------------------------------------------------
 *
 * Not a shortlist, not a generator, not an example. `resolution` is free text
 * a person writes, nothing validates it against a vocabulary, and no research
 * round can reach it — there is no `capability_finding` that writes this table
 * and no route that lets a worker principal near it. A Brain that suggested
 * three candidate names would have made the decision and left somebody the
 * clerical half of it.
 */
import { ensureProgrammeDecision, listProgrammeDecisions } from '../../repos/manufacturing.ts';
import type { ProgrammeDecision, ProgrammeDecisionTopic } from '../../domain/types.ts';
import type { Directive } from './directive.ts';
import type { LadderSnapshot } from './ladder.ts';

/** Every topic this kernel raises, so a programme cannot be missing one. */
export const RAISED_TOPICS: readonly ProgrammeDecisionTopic[] = ['MASTER_BRAND_ARCHITECTURE'];

export interface DecisionReading {
  topic: ProgrammeDecisionTopic;
  state: 'OPEN' | 'RESOLVED';
  /** A person's own words, where they have written any. */
  resolution: string | null;
  resolvedAt: string | null;
  /** What the decision is, in the directive's words where it has them. */
  question: string;
  /** What any answer would have to satisfy. Derived from the ladder. */
  criteria: string[];
  /** What it currently depends on, and how far that has got. */
  dependencies: string[];
  /**
   * When leaving it open stops being the safe answer.
   *
   * Derived rather than scheduled, and the condition is the one thing that
   * actually makes a name urgent: something being *produced*. A date would
   * have been arbitrary and would have gone off while the answer was still
   * correctly unknown.
   */
  trigger: string;
  /** Why it is in the state it is, from the rows above. */
  because: string;
}

/**
 * Make sure every topic this kernel raises has a row.
 *
 * Idempotent by the unique index, and called from the tick rather than only
 * from activation, so a programme started before a topic existed acquires it
 * without anybody pressing anything — the derivation-not-a-hook distinction
 * this repository has needed six times, at the table where the alternative is
 * a decision silently missing from a programme nobody looks at twice.
 */
export async function ensureRaisedDecisions(programId: string): Promise<ProgrammeDecision[]> {
  const out: ProgrammeDecision[] = [];
  for (const topic of RAISED_TOPICS) {
    out.push(await ensureProgrammeDecision({ programId, topic }));
  }
  return out;
}

/**
 * Read the decisions for one programme against the ladder they are about.
 *
 * `directive` is optional and its absence is visible rather than silent: the
 * question falls back to Brain's own statement of it, and the reading says the
 * directive's own wording could not be read.
 */
export async function readDecisions(
  snapshot: LadderSnapshot,
  directive: Directive | null,
): Promise<DecisionReading[]> {
  await ensureRaisedDecisions(snapshot.program.id);
  const rows = await listProgrammeDecisions(snapshot.program.id);
  return rows.map((row) => read(row, snapshot, directive));
}

function read(
  row: ProgrammeDecision,
  snapshot: LadderSnapshot,
  directive: Directive | null,
): DecisionReading {
  const live = snapshot.categories.filter((one) => one.retiredAt === null);
  const named = live.map((one) => one.name);
  const withDemand = snapshot.coverage.filter((one) => one.demand.length > 0);

  const question = directive
    ? directive.brandConstraint
    : 'One master brand, capable of appearing on every class of machine this company ends up ' +
      "building. The directive's own wording could not be read for this programme, so this is " +
      "Brain's statement of it rather than the directive's.";

  /*
   * The criteria, and the first two are the directive's own constraints rather
   * than Brain's opinion about naming.
   *
   * The third is the one that moves: the span a name has to cover is the
   * ladder, so it is read from the ladder. A criterion that said "must work
   * for machinery" would have been true and useless; naming the categories
   * that actually exist is what lets a person test a candidate against
   * something.
   */
  const criteria = [
    'It must not describe the original product category, because it has to keep working when ' +
      'the company is producing something else entirely.',
    'It must sit naturally on the whole span of what gets built, not on the first thing built.',
    live.length === 0
      ? 'Nothing is on the ladder yet, so there is no span to test a candidate against. That ' +
        'is the strongest reason this is open rather than a weakness in the question.'
      : `Today that span is ${named.length} categor${named.length === 1 ? 'y' : 'ies'}: ` +
        `${named.join(', ')}. A candidate has to read correctly across all of them, and the ` +
        'span grows.',
    'The division names the directive sketches are deliberately not part of this. It says in ' +
      'as many words not to lock them prematurely, so a resolution that fixed them would be ' +
      'answering more than was asked.',
  ];

  const dependencies = [
    live.length === 0
      ? 'Nothing has been established about what this company would build.'
      : `${live.length} categor${live.length === 1 ? 'y is' : 'ies are'} on the ladder.`,
    withDemand.length === 0
      ? 'No category yet has published buyers, so nothing is close to being produced under any ' +
        'name.'
      : `${withDemand.length} categor${withDemand.length === 1 ? 'y has' : 'ies have'} ` +
        'published buyers: ' +
        withDemand.map((one) => one.path.join(' → ')).join('; ') +
        '.',
    'Nothing in this kernel can answer it. There is no research round that produces a name, ' +
      'and no verdict that depends on one.',
  ];

  /*
   * The trigger is a condition on rows rather than a date.
   *
   * What makes a brand urgent is something being about to carry it — so the
   * trigger is the first category actually being entered, which is a person's
   * decision downstream of an `ENTER` verdict. A date would have fired while
   * the answer was still correctly unknown, which is how a reminder becomes
   * something people dismiss.
   */
  const trigger =
    'Reconsider when a category is first actually entered — that is the point at which ' +
    'something will carry a name, and the point after which changing it costs more than ' +
    'choosing it. Until then, open is the right state and nothing is waiting on it.';

  if (row.state === 'RESOLVED') {
    return {
      topic: row.topic,
      state: 'RESOLVED',
      resolution: row.resolution,
      resolvedAt: row.resolvedAt,
      question,
      criteria,
      dependencies,
      trigger:
        'A resolved decision can be reopened. The directive’s own reason for caution — do ' +
        'not lock names prematurely — is a reason a name chosen early may need unchoosing, and ' +
        'that transition exists.',
      because:
        `A person answered this${row.resolvedAt ? ` on ${row.resolvedAt.slice(0, 10)}` : ''}. ` +
        'Their words stand exactly as written; nothing here derives, validates or improves ' +
        'them.',
    };
  }

  return {
    topic: row.topic,
    state: 'OPEN',
    resolution: null,
    resolvedAt: null,
    question,
    criteria,
    dependencies,
    trigger,
    because:
      'No name has been chosen, and that is the correct state rather than a gap. Nothing is ' +
      'blocked by it: no category verdict, no round and no question depends on a name. It is ' +
      'recorded so that it is not forgotten, and it is left open so that it is not answered ' +
      'by accident.',
  };
}

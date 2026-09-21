/**
 * LOOP 2 — get better by having done it.
 *
 * ---------------------------------------------------------------------------
 * What learning is here, and what it is not
 * ---------------------------------------------------------------------------
 *
 * Not "remember this screenshot". A screenshot transfers nothing: the next
 * screen is a different screen. What transfers is the shape of the mistake —
 * *this kind of defect keeps happening under these conditions, and here is what
 * prevents it* — which is why the unit of memory is a `design_patterns` row and
 * not an image.
 *
 * Three things feed it, in ascending order of how much they are worth:
 *
 *   **A recurrence.** One instance of a defect is a bug; the same kind on three
 *   surfaces is a rule nobody has written down. That is the cheapest learning
 *   available and the kernel can do it alone.
 *
 *   **A judged review.** Somebody read the screen against its purpose and said
 *   what was wrong with it. Worth more than a recurrence because it carries a
 *   reason.
 *
 *   **An owner correction.** The strongest signal there is, and the one this
 *   whole kernel exists to stop needing so often. Handled in `corrections.ts`,
 *   promoted here.
 *
 * ---------------------------------------------------------------------------
 * Everything it writes starts PROPOSED
 * ---------------------------------------------------------------------------
 *
 * A compiled pattern is `PROPOSED`, never `ACTIVE`. §37's rule is that nothing
 * canonical arrives without passing through a candidate, and the reason bites
 * hardest here: a rule the kernel wrote for itself and immediately started
 * applying would be a system that generalises from its own output — and the
 * first wrong generalisation becomes the lens it reads everything else through.
 * Only the reviewed seed and a person's activation make a pattern ACTIVE.
 *
 * ---------------------------------------------------------------------------
 * And confidence is evidence, not enthusiasm
 * ---------------------------------------------------------------------------
 *
 * `confidenceFor` counts *independent* evidence — three findings in one cycle
 * are one observation of one screen, which is §14's rule about sources that are
 * really one source, applied to a design lesson.
 */
import type {
  DesignCorrection,
  DesignCycle,
  DesignFinding,
  DesignPattern,
  DesignPrimitive,
} from '../../domain/design.ts';
import { PRIMITIVE_OF_KIND } from '../../domain/design.ts';
import {
  listCorrections,
  listFindings,
  listReviews,
  upsertPattern,
} from '../../repos/design.ts';
import { confidenceFor, emergingBranches, patternFingerprint } from './patterns.ts';
import { noteLimitation, refreshCapabilities } from './capabilities.ts';

/**
 * How many distinct cycles a defect kind has to appear in before it is a rule.
 *
 * Three, and distinct *cycles* rather than distinct findings: ten instances in
 * one run of one screen is one observation, however many rows it wrote.
 */
export const RECURRENCE_THRESHOLD = 3;

export interface LearningReport {
  /** Patterns compiled from what kept happening. Proposed, never active. */
  compiled: DesignPattern[];
  /** Owner corrections that now have a lesson written against them. */
  lessons: { correctionId: string; lesson: string }[];
  /** Branches that have accumulated enough patterns to be a real distinction. */
  branches: { primitive: string; branch: string; count: number }[];
  /** Capability dimensions that moved because of what this cycle established. */
  moved: { capabilityKey: string; dimension: string; from: string; to: string }[];
  /** Limitations the run discovered about the kernel itself. */
  limitations: { capabilityKey: string; limitation: string }[];
  /** What the run did *not* teach, said rather than omitted. */
  nothingLearned: string[];
}

/**
 * Learn from one completed cycle.
 *
 * Idempotent: everything it writes is keyed by fingerprint or guarded on a
 * state, so running it twice over one cycle produces one set of patterns with
 * the evidence accumulated once. That matters because it runs on a tick, and a
 * tick that dies halfway must leave the next one able to finish rather than
 * double.
 *
 * **What it does *not* do is the fleet-wide half**, and that was a correction:
 * `compileRecurrences`, `emergingBranches` and the self-model refresh are all
 * questions about every finding rather than about this cycle, so calling them
 * per cycle meant a tick with twenty closed cycles scanned every finding twenty
 * times and refreshed ten capabilities twenty times, every thirty seconds, to
 * reach the same answer. `learnFleetWide` is that half, called once per pass.
 */
export async function learnFromCycle(cycle: DesignCycle): Promise<LearningReport> {
  const report: LearningReport = {
    compiled: [],
    lessons: [],
    branches: [],
    moved: [],
    limitations: [],
    nothingLearned: [],
  };

  const findings = await listFindings({ cycleId: cycle.id, limit: 1000 });
  const reviews = await listReviews(cycle.id);

  /* ---------------------------------------------------------------------
   * What the run revealed about the kernel itself
   *
   * Recorded first, because it is the observation most easily lost: a reader
   * that could not answer is a limitation of this kernel, and a run that
   * quietly carried on would report *nothing was wrong* about a surface it
   * never measured. §9's sentence, one altitude up from a document.
   * ------------------------------------------------------------------ */
  const unreadable = new Set<string>();
  for (const review of reviews) {
    if (review.lane === 'MEASURED' && review.detail?.includes('could not be taken')) {
      unreadable.add(review.detail);
    }
  }
  for (const detail of unreadable) {
    const limitation = `Observed on cycle ${cycle.id}: ${detail}`;
    await noteLimitation('MEASURE_LAYOUT_FAULTS', limitation);
    report.limitations.push({ capabilityKey: 'MEASURE_LAYOUT_FAULTS', limitation });
  }

  const refusedJudgements = reviews.filter(
    (one) => one.lane === 'JUDGED' && one.verdict === 'REFUSED',
  );
  for (const refusal of refusedJudgements) {
    const limitation =
      `A judged review was refused on cycle ${cycle.id}: ${refusal.detail ?? 'no reason recorded'}`;
    await noteLimitation('JUDGE_COMPOSITION', limitation);
    report.limitations.push({ capabilityKey: 'JUDGE_COMPOSITION', limitation });
  }

  if (report.limitations.length === 0) {
    report.nothingLearned.push(
      findings.length === 0
        ? 'The cycle found nothing about itself, which is the right outcome for a pass in which ' +
          'every reader answered.'
        : `${findings.length} finding(s) were recorded and every reader answered, so this cycle ` +
          'revealed nothing about the kernel itself.',
    );
  }

  return report;
}

/**
 * The half of learning that is about every finding rather than about one cycle.
 *
 * Called once per kernel pass. A recurrence is *by construction* a question
 * across cycles — three distinct ones is the bar — so asking it per cycle
 * produces the same answer N times at N times the cost, and a tick that did
 * that with twenty closed cycles would scan every finding twenty times every
 * thirty seconds.
 */
export async function learnFleetWide(): Promise<{
  compiled: DesignPattern[];
  lessons: { correctionId: string; lesson: string }[];
  branches: { primitive: string; branch: string; count: number }[];
  moved: LearningReport['moved'];
}> {
  const compiled = await compileRecurrences();

  const lessons: { correctionId: string; lesson: string }[] = [];
  for (const correction of await listCorrections({ limit: 200 })) {
    if (correction.lesson !== null) continue;
    const lesson = lessonFrom(correction);
    if (lesson === null) continue;
    lessons.push({ correctionId: correction.id, lesson });
  }

  const branches = await emergingBranches();
  const refresh = await refreshCapabilities('DESIGN_LEARN');
  return { compiled, lessons, branches, moved: refresh.moved };
}

/**
 * Compile a rule from a defect kind that keeps coming back.
 *
 * The statement is composed from the *kind*, not from any one finding's prose.
 * That is deliberate and is the difference between a rule and a memory: a rule
 * generated by concatenating three findings' sentences would carry three
 * screens' specifics and apply cleanly to none of them.
 *
 * Scope is `GLOBAL` when the kind recurred across several surfaces and `SCREEN`
 * when it kept happening on one — because those are two different lessons. The
 * first is a rule about the product; the second is a fact about one screen, and
 * §24's own defect was a rule applied one altitude wider than its evidence.
 */
export async function compileRecurrences(): Promise<DesignPattern[]> {
  const all = await listFindings({ limit: 2000 });
  const byKind = new Map<string, DesignFinding[]>();
  for (const finding of all) {
    byKind.set(finding.kind, [...(byKind.get(finding.kind) ?? []), finding]);
  }

  const compiled: DesignPattern[] = [];
  for (const [kind, findings] of byKind) {
    const cycles = new Set(findings.map((one) => one.cycleId).filter((one): one is string => one !== null));
    if (cycles.size < RECURRENCE_THRESHOLD) continue;

    const surfaces = new Set(findings.map((one) => one.surfaceKey));
    const primitive = PRIMITIVE_OF_KIND[findings[0]!.kind];
    const global = surfaces.size > 1;

    const statement = statementFor(kind, primitive, global, surfaces.size);
    const fingerprint = patternFingerprint({
      primitive,
      scope: global ? 'GLOBAL' : 'SCREEN',
      scopeRef: global ? null : [...surfaces][0]!,
      statement,
    });

    const { pattern } = await upsertPattern({
      primitive,
      /*
       * The branch is the kind, lower-cased. A branch has to come from
       * somewhere, and the kind is the one label the evidence genuinely shares —
       * inventing a prettier name would be naming a distinction nobody
       * established, which is what `emergingBranches` is there to notice rather
       * than to manufacture.
       */
      branch: kind.toLowerCase().replace(/_/g, ' '),
      statement,
      appliesWhen: global
        ? `Any surface of this product. It has happened on ${surfaces.size} of them across ` +
          `${cycles.size} separate cycles.`
        : `${[...surfaces][0]}, where it has happened in ${cycles.size} separate cycles.`,
      exceptions:
        'Compiled from recurrence rather than from a reason, so it says what keeps going wrong and ' +
        'not why. A case where this is deliberate is an exception nobody has written down yet.',
      scope: global ? 'GLOBAL' : 'SCREEN',
      scopeRef: global ? null : [...surfaces][0]!,
      confidence: confidenceFor({
        ownerCorrections: 0,
        distinctCycles: cycles.size,
        gatedClaims: 0,
      }),
      origin: 'OPERATION',
      evidence: [
        ...[...cycles].slice(0, 10).map((id) => `design_cycle:${id}`),
        ...findings.slice(0, 10).map((one) => `design_finding:${one.id}`),
      ],
      /*
       * PROPOSED. A kernel that activated its own compiled rules would be
       * generalising from its own output, and the first wrong generalisation
       * becomes the lens it reads everything else through.
       */
      state: 'PROPOSED',
      fingerprint,
    });
    compiled.push(pattern);
  }
  return compiled;
}

/** The rule a recurring kind implies, said once, in one place. */
function statementFor(
  kind: string,
  primitive: DesignPrimitive,
  global: boolean,
  surfaces: number,
): string {
  const where = global ? `across ${surfaces} surfaces` : 'on this surface';
  const rules: Record<string, string> = {
    HORIZONTAL_OVERFLOW:
      'Something in this product keeps being laid out wider than the space it is given. Constrain ' +
      'against the container rather than against the viewport, and let a container scroll rather ' +
      'than letting the page do it.',
    CONTENT_CLIPPED:
      'Containers here keep clipping their own children. A fixed width holding variable content ' +
      'either needs room or needs to scroll; hiding the overflow makes the content unreachable.',
    CONTROL_UNREACHABLE:
      'Controls here keep ending up under something else. A control is not placed until its own ' +
      'centre belongs to it, and a stacking context is what usually takes that away.',
    RESPONSIVE_REGRESSION:
      'Destinations keep disappearing at narrower widths. Every width is an arrangement of one ' +
      'product; a rule that removes an element is removing a feature.',
    CONTRAST_BELOW_FLOOR:
      'Text here keeps landing under the contrast floor. Contrast is a property of the pair, so it ' +
      'has to be decided where the foreground and the backdrop are chosen together.',
    TOUCH_TARGET_TOO_SMALL:
      'Controls here keep being smaller than the target floor. Hit area comes from padding rather ' +
      'than from type size.',
    CONTROL_OVERLAPPED:
      'Placed elements here keep landing on top of each other. Two cells of a grid are disjoint ' +
      'whatever the label does; two absolutely-placed siblings are not.',
    STATUS_CONTRADICTS_CONTROL:
      'Sentences here keep disagreeing with the controls beside them. Where both describe one fact ' +
      'they must read it from one place, and an unknown withholds the reassuring version.',
  };
  const rule =
    rules[kind] ??
    `${kind.toLowerCase().replace(/_/g, ' ')} keeps recurring, which means something about how this ` +
      'is built makes it easy to get wrong.';
  return `${rule} Observed ${where}, under ${primitive}.`;
}

/**
 * What Brain takes from a correction, as a sentence.
 *
 * Deliberately **null** unless the correction named something concrete. A lesson
 * composed from a bare "make this smaller" would be Brain writing a rule out of
 * a phrase, which is the model-prose-as-state §8 forbids one artifact along — and
 * the correction is not lost by being left without one: it is still evidence,
 * still retrieved by `describeProblem`, and still shown to a reviewer verbatim.
 */
export function lessonFrom(correction: DesignCorrection): string | null {
  if (correction.components.length === 0 && correction.surfaceKey === null) return null;
  const subject =
    correction.components.length > 0
      ? correction.components.join(', ')
      : (correction.surfaceKey as string);
  return (
    `The owner said "${correction.correction}" about ${subject}. Held at ${correction.scope} scope ` +
    'until somebody widens it.'
  );
}

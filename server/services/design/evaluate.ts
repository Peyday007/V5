/**
 * Readings become findings, deterministically.
 *
 * ---------------------------------------------------------------------------
 * The measured lane, and why it is worth having on its own
 * ---------------------------------------------------------------------------
 *
 * Nothing here has an opinion. Every finding this module produces is a fact
 * about the capture it names, reproducible by anybody holding the same readings,
 * and a person who disagrees with one is filing a bug report rather than a
 * difference of taste. That is what makes it safe to act on without a person and
 * without a model: §8's rule is that model prose never mutates state, and the
 * counterpart is that a measurement may, because it is not prose.
 *
 * The judged lane is next door and goes through a bin. The two never merge.
 *
 * ---------------------------------------------------------------------------
 * The four properties every finding here has
 * ---------------------------------------------------------------------------
 *
 * 1. **It names a region.** `region` is the page's own label for the thing —
 *    the selector the reader found — so a repair has something to open. "The
 *    header area" is not a region.
 * 2. **It says why it matters.** Not as decoration: severity is an argument, and
 *    a reader who cannot see the argument cannot disagree with the ranking.
 * 3. **It carries the measurement.** The number, in `evidence`, so a repair can
 *    be held against it and a later capture can be compared.
 * 4. **It proposes a repair.** §24's rule that an escalation with no answering
 *    transition is stuck rather than waiting, at the size of one sentence.
 *
 * ---------------------------------------------------------------------------
 * An unreadable reading is never a clean one
 * ---------------------------------------------------------------------------
 *
 * `readings.unreadable` is checked before anything is concluded. §9's sentence
 * is the rule: *a BLOCKED document is something the auditor does not have, and
 * every code path must say so rather than treating an empty extraction as an
 * empty document.* A capture whose contrast reader threw has no contrast
 * findings, and reporting that as *the contrast is fine* would be the same lie
 * one artifact along. So `evaluateCaptures` returns the unreadable list beside
 * the findings and `summarise` refuses to call a surface clean while it is
 * non-empty.
 *
 * **`partial` is the other half, and separating the two was a correction rather
 * than a design.** The contrast reader names every element with no opaque
 * backdrop — text over an image, text over a gradient — and the first version
 * put those on `unreadable`. Every real page has at least one, so no surface
 * could ever be called clean and the SETTLED branch was unreachable: a bar with
 * no way over it is a park rather than a standard (§24). A partial measurement
 * is now reported beside the verdict and blocks nothing, and the clean sentence
 * still says how many elements are unknown rather than acceptable.
 */
import type {
  CaptureReadings,
  DesignCapture,
  DesignFinding,
  DesignFindingKind,
  DesignSeverity,
} from '../../domain/design.ts';
import { PRIMITIVE_OF_KIND, SEVERITY_RANK } from '../../domain/design.ts';
import { recordFinding, type RecordFindingInput } from '../../repos/design.ts';

/** A finding before it has a row: everything but the ids. */
export interface ProposedFinding {
  region: string;
  kind: DesignFindingKind;
  statement: string;
  whyItMatters: string;
  severity: DesignSeverity;
  evidence: Record<string, unknown>;
  proposedRepair: string;
}

/**
 * The width below which a surface is being held in one hand.
 *
 * Used only to decide severity, never to decide whether something is a finding:
 * a control nobody can press is a control nobody can press at any width, and a
 * phone is where it stops being recoverable by moving a window.
 */
const HANDHELD_WIDTH = 500;

/**
 * Everything a single capture's readings establish.
 *
 * Pure. It takes readings and gives findings, so the rules can be tested without
 * a browser, a database or a server — which matters because these are the rules
 * a repair is judged against, and a rule that can only be exercised by a full
 * render is a rule nobody exercises.
 */
export function findingsFromReadings(
  readings: CaptureReadings,
  context: { width: number; surfaceKey: string },
): ProposedFinding[] {
  const out: ProposedFinding[] = [];
  const handheld = context.width <= HANDHELD_WIDTH;

  if (readings.horizontalOverflow) {
    out.push({
      region: 'document',
      kind: 'HORIZONTAL_OVERFLOW',
      statement: `The page scrolls sideways at ${context.width}px.`,
      whyItMatters:
        'A person reading on a screen this wide has to scroll horizontally to see content that ' +
        'was meant to be on the page. On a phone that usually means half a column is simply ' +
        'never seen, because nobody scrolls sideways to look for it.',
      severity: handheld ? 'BLOCKER' : 'MAJOR',
      evidence: { width: context.width, offenders: readings.offenders.slice(0, 6) },
      proposedRepair:
        readings.offenders.length > 0
          ? `Constrain ${readings.offenders[0]?.split('@')[0] ?? 'the widest element'} so it fits its ` +
            'container, or let the container scroll rather than the document.'
          : 'Find the element wider than the viewport and constrain it, or let its own container scroll.',
    });
  }

  for (const entry of readings.clipped) {
    out.push({
      region: entry,
      kind: 'CONTENT_CLIPPED',
      statement: `Content is cut off: ${entry}.`,
      whyItMatters:
        'The parent clips rather than scrolls, so what sticks out is not hidden behind a scrollbar ' +
        '— it is gone. A person cannot reach it by any means.',
      severity: 'BLOCKER',
      evidence: { width: context.width, where: entry },
      proposedRepair:
        'Either give the child room — the container is asking a fixed width to hold variable ' +
        'content — or let the container scroll in that axis so the rest is reachable.',
    });
  }

  for (const entry of readings.unreachable) {
    out.push({
      region: entry.split(':')[0] ?? entry,
      kind: 'CONTROL_UNREACHABLE',
      statement: `A control cannot be pressed: ${entry}.`,
      whyItMatters:
        'A box of the right size in the right place is still not a control if something else is ' +
        'painted over it. Whatever this control does, nobody at this width can do it.',
      severity: 'BLOCKER',
      evidence: { width: context.width, detail: entry },
      proposedRepair:
        'Work out what is on top of it — a sticky header, an overlay that did not close, a ' +
        'stacking context — and either move the control or stop the other thing covering it.',
    });
  }

  for (const entry of readings.overlaps) {
    out.push({
      region: entry.split(' over ')[0] ?? entry,
      kind: 'CONTROL_OVERLAPPED',
      statement: `Two placed elements are painted over each other: ${entry}.`,
      whyItMatters:
        'These are siblings in one stacking context, so an intersection is one covering the other. ' +
        'The covered label is not hard to read — it is not there.',
      severity: handheld ? 'MAJOR' : 'MINOR',
      evidence: { width: context.width, pair: entry },
      proposedRepair:
        'Give the arrangement more room per element at this width, or lay it out with a rule that ' +
        'cannot overlap — two cells of a grid are disjoint whatever the label does.',
    });
  }

  for (const entry of readings.smallTargets) {
    out.push({
      region: entry.split(':')[0] ?? entry,
      kind: 'TOUCH_TARGET_TOO_SMALL',
      statement: `A control is smaller than the target floor: ${entry}.`,
      whyItMatters:
        'Below the floor a control is one some people cannot reliably hit, which is a different ' +
        'thing from one that is merely uncomfortable.',
      severity: handheld ? 'MAJOR' : 'MINOR',
      evidence: { width: context.width, detail: entry },
      proposedRepair: 'Give it padding rather than a larger font, so the hit area grows and the type does not.',
    });
  }

  for (const entry of readings.lowContrast) {
    out.push({
      region: entry.split(':')[0] ?? entry,
      kind: 'CONTRAST_BELOW_FLOOR',
      statement: `Text is below the contrast floor: ${entry}.`,
      whyItMatters:
        'Under the floor this text is not reliably readable in ordinary conditions — bright light, ' +
        'a dim screen, or eyes that are not twenty-five.',
      severity: 'MAJOR',
      evidence: { width: context.width, detail: entry },
      proposedRepair:
        'Darken the foreground or lighten the backdrop until the ratio clears the floor. A ' +
        'lighter weight is not a substitute: weight does not change the ratio.',
    });
  }

  /*
   * A page with no heading at all.
   *
   * Reported rather than inferred to be intentional, and MINOR rather than
   * MAJOR, because a legitimately heading-less screen exists — but a screen
   * reader's user reaches a page by its outline, and one with none is a wall.
   */
  if (readings.counts.headings === 0 && readings.counts.textNodes > 8) {
    out.push({
      region: 'document',
      kind: 'CONTENT_MISSING',
      statement: 'The page has text but no heading of any level.',
      whyItMatters:
        'The outline is how somebody using a screen reader finds their way around, and how ' +
        'everybody else skims. A page with none has to be read from the top every time.',
      severity: 'MINOR',
      evidence: { width: context.width, textNodes: readings.counts.textNodes },
      proposedRepair: 'Give the page a heading naming what it is, and the sections under it their own.',
    });
  }

  /*
   * A page that painted nothing worth calling a page.
   *
   * The empty-state kind exists because an empty screen is a *design* problem
   * rather than an absence: §29's rule is that loading, empty, forbidden and
   * error are four different screens, and a surface that renders as nothing at
   * all is none of them.
   */
  if (readings.counts.interactive === 0 && readings.counts.textNodes === 0 && readings.unreadable.length === 0) {
    out.push({
      region: 'document',
      kind: 'EMPTY_STATE_MALFORMED',
      statement: 'The surface rendered with no text and no controls at all.',
      whyItMatters:
        'Loading, empty, forbidden and error are four different screens. A surface that paints ' +
        'nothing is none of them, so a person cannot tell which it is or what to do next.',
      severity: 'BLOCKER',
      evidence: { width: context.width, counts: readings.counts },
      proposedRepair:
        'Give the surface an explicit state for this case, saying which of the four it is and ' +
        'what would change it.',
    });
  }

  return out;
}

/**
 * A responsive regression, found by comparing one surface across widths.
 *
 * It is not "this is broken at 390" — that is already reported per capture. It
 * is *this works at one width and not at another*, which is a different repair:
 * the wide layout is the evidence that the content fits, so the narrow one is a
 * rule that stopped applying rather than content that is too big.
 */
export function responsiveRegressions(
  captures: ReadonlyArray<Pick<DesignCapture, 'surfaceKey' | 'width' | 'readings' | 'id'>>,
): { captureId: string; finding: ProposedFinding }[] {
  const bySurface = new Map<string, typeof captures>();
  for (const capture of captures) {
    bySurface.set(capture.surfaceKey, [...(bySurface.get(capture.surfaceKey) ?? []), capture]);
  }

  const out: { captureId: string; finding: ProposedFinding }[] = [];
  for (const [surfaceKey, group] of bySurface) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => b.width - a.width);
    const widest = ordered[0]!;
    /*
     * The set of chrome destinations is the comparison, because that is the one
     * §29 paid for: the phone bar lost Search, the depth control, Build,
     * Connected sites and Sign out, and every one of those was present and
     * correct in React. A width at which a destination disappears is a width at
     * which the product is missing a feature — and a person on a phone could
     * not sign out of Brain.
     */
    const reference = new Set(widest.readings.reachableControls);
    if (reference.size === 0) continue;

    for (const capture of ordered.slice(1)) {
      const here = new Set(capture.readings.reachableControls);
      const lost = [...reference].filter((name) => !here.has(name));
      if (lost.length === 0) continue;
      out.push({
        captureId: capture.id,
        finding: {
          region: 'shell navigation',
          kind: 'RESPONSIVE_REGRESSION',
          statement:
            `${lost.length} destination(s) reachable at ${widest.width}px cannot be pressed at ` +
            `${capture.width}px: ${lost.slice(0, 6).join(', ')}.`,
          whyItMatters:
            'A phone and a desktop are one product rather than two. A destination that exists at ' +
            'one width and not another is a feature a person loses by picking up their phone — and ' +
            'the code for it is usually still there, which is why nothing but a render finds it.',
          severity: 'BLOCKER',
          evidence: {
            surfaceKey,
            referenceWidth: widest.width,
            width: capture.width,
            lost,
          },
          proposedRepair:
            'Find what removes the element at this width — it is usually a stylesheet rule rather ' +
            'than a branch in the component — and give the narrow layout its own arrangement that ' +
            'still reaches every destination, in one press or in two.',
        },
      });
    }
  }
  return out;
}

export interface EvaluationOutcome {
  findings: DesignFinding[];
  /** A reader that could not run at all, so nothing concludes a surface is clean. */
  unreadable: { captureId: string; surfaceKey: string; detail: string }[];
  /**
   * A reader that ran and could not answer about some elements.
   *
   * Reported and **not** blocking, which was a correction rather than a design.
   * The contrast reader names every element with no opaque backdrop — text over
   * an image or a gradient — and treating that as a failed reader meant a real
   * page could never be called clean, because there is always one. A bar with no
   * way over it is a park rather than a standard (§24).
   */
  partial: { captureId: string; surfaceKey: string; detail: string }[];
}

/**
 * Evaluate a whole set of captures and write what it found.
 *
 * Writes through `recordFinding`, which is idempotent by capture, kind and
 * region — so re-evaluating a capture whose bytes have not changed produces the
 * same findings rather than a second copy of them, and the repair loop's
 * stopping condition stays a count of real defects.
 */
export async function evaluateCaptures(input: {
  cycleId: string | null;
  pass: number;
  captures: readonly DesignCapture[];
}): Promise<EvaluationOutcome> {
  const findings: DesignFinding[] = [];
  const unreadable: { captureId: string; surfaceKey: string; detail: string }[] = [];
  const partial: { captureId: string; surfaceKey: string; detail: string }[] = [];

  for (const capture of input.captures) {
    for (const detail of capture.readings.unreadable) {
      unreadable.push({ captureId: capture.id, surfaceKey: capture.surfaceKey, detail });
    }
    for (const detail of capture.readings.partial) {
      partial.push({ captureId: capture.id, surfaceKey: capture.surfaceKey, detail });
    }
    for (const proposed of findingsFromReadings(capture.readings, {
      width: capture.width,
      surfaceKey: capture.surfaceKey,
    })) {
      findings.push(await write(input, capture, proposed));
    }
  }

  for (const entry of responsiveRegressions(input.captures)) {
    const capture = input.captures.find((one) => one.id === entry.captureId);
    if (!capture) continue;
    findings.push(await write(input, capture, entry.finding));
  }

  return { findings, unreadable, partial };
}

async function write(
  input: { cycleId: string | null; pass: number },
  capture: DesignCapture,
  proposed: ProposedFinding,
): Promise<DesignFinding> {
  const record: RecordFindingInput = {
    cycleId: input.cycleId,
    reviewId: null,
    captureId: capture.id,
    pass: input.pass,
    surfaceKey: capture.surfaceKey,
    region: proposed.region.slice(0, 200),
    lane: 'MEASURED',
    kind: proposed.kind,
    primitive: PRIMITIVE_OF_KIND[proposed.kind],
    statement: proposed.statement,
    whyItMatters: proposed.whyItMatters,
    severity: proposed.severity,
    evidence: proposed.evidence,
    proposedRepair: proposed.proposedRepair,
  };
  const { finding } = await recordFinding(record);
  return finding;
}

export interface EvaluationSummary {
  /** True only when nothing is open **and** everything was readable. */
  clean: boolean;
  worst: DesignSeverity | null;
  byseverity: Record<DesignSeverity, number>;
  /** Why it is not clean, in one sentence, when it is not. */
  reason: string | null;
}

/**
 * Whether a pass settled.
 *
 * The `unreadable` half is the whole reason this is a function rather than
 * `findings.length === 0`: a capture whose readers threw has no findings, and
 * concluding *clean* from that is exactly the false confidence the engine exists
 * to prevent.
 */
export function summarise(outcome: EvaluationOutcome): EvaluationSummary {
  const byseverity: Record<DesignSeverity, number> = { BLOCKER: 0, MAJOR: 0, MINOR: 0, NIT: 0 };
  const open = outcome.findings.filter((one) => one.state === 'OPEN');
  for (const finding of open) byseverity[finding.severity] += 1;

  const worst =
    open.length === 0
      ? null
      : open.reduce<DesignSeverity>(
          (best, one) => (SEVERITY_RANK[one.severity] < SEVERITY_RANK[best] ? one.severity : best),
          'NIT',
        );

  if (outcome.unreadable.length > 0) {
    return {
      clean: false,
      worst,
      byseverity,
      reason:
        `${outcome.unreadable.length} reading(s) could not be taken, so this surface has not been ` +
        'checked rather than checked and found clean.',
    } as EvaluationSummary;
  }
  return {
    clean: open.length === 0,
    worst,
    byseverity,
    reason:
      open.length > 0
        ? `${open.length} finding(s) are open, the worst of them ${worst}.`
        : outcome.partial.length > 0
          ? /*
             * Clean, and it still says what it could not measure. A surface
             * reported as clean with a silent gap in the measurement is the
             * false confidence §9 refuses; a surface reported as *not* clean
             * because of one is a bar nothing could ever clear.
             */
            `Nothing is open. ${outcome.partial.length} element(s) could not be measured and are ` +
            'unknown rather than acceptable.'
          : null,
  } as EvaluationSummary;
}

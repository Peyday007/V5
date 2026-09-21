/**
 * The whole kernel, as a person reads it.
 *
 * ---------------------------------------------------------------------------
 * One projection, in the order the directive asks for
 * ---------------------------------------------------------------------------
 *
 * Right now, the best few routes, what is being made, the three leverage
 * readings, quality, physical production, what changed, what needs a person,
 * and what happens next. §29's rule that one projection answers every surface
 * applies here too: a second reader deriving its own status from the same rows
 * is how two screens come to disagree about one project.
 *
 * ---------------------------------------------------------------------------
 * Every sentence here is the server's
 * ---------------------------------------------------------------------------
 *
 * A screen renders these and composes none of its own. §24 records why: a
 * surface that paraphrased a verdict would eventually paraphrase it wrongly,
 * and then a person is reading one thing while the machinery acts on another.
 *
 * ---------------------------------------------------------------------------
 * Reading it performs no effect
 * ---------------------------------------------------------------------------
 *
 * No round is opened, no batch produced, no validation run, no route
 * disposition set and no money moved. It is a read, and `tests/puzzleKernel`
 * asserts that against the rows rather than trusting this sentence.
 */
import { readContribution, readCheapBook, readProductionStage } from './economics.ts';
import { puzzleSnapshot, type PuzzleSnapshot } from './graph.ts';
import { readLedger, type LedgerView } from './ledger.ts';
import { readLessons, type Lesson } from './lessons.ts';
import { readLeverage, type LeverageReading } from './leverage.ts';
import { readFormats, readOutputs, type FormatReading, type OutputReading } from './maturity.ts';
import { planFrom } from './kernel.ts';
import { awaitingReview } from './allocate.ts';
import { listEngines } from './engines/index.ts';
import { readPuzzleDirective } from './directive.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import { discoveryAllowed } from '../cash/lifecycle.ts';
import type { ContributionReading, ProductionReading, CheapBookReading } from './economics.ts';

export interface PuzzleView {
  projectId: string;
  /** Null when this project holds no sprint, which is most of them. */
  active: boolean;

  rightNow: {
    /** Settled money against outputs from this kernel, grouped by currency. */
    collected: { currency: string; amountMinor: number }[];
    /** Outputs a person has released. */
    released: number;
    validatedPuzzles: number;
    qualifiedOutputs: number;
    /** Where the physical production ladder actually is. */
    productionStage: string;
    /** What the tick would ask next, without asking it. */
    nextQuestion: string | null;
    /** Why the tick is asking nothing, where it is not. */
    notAsking: string | null;
  };

  ledger: LedgerView;
  formats: FormatReading[];
  outputs: OutputReading[];
  leverage: LeverageReading;
  economics: ContributionReading[];
  production: ProductionReading;
  cheapBook: CheapBookReading;
  lessons: Lesson[];

  /** What is open right now, with the allocator's own reason on each. */
  beingMade: {
    purpose: string;
    subject: string | null;
    round: number;
    why: string;
    openedAt: string;
  }[];

  /** The engines that exist, so a reader can see what is and is not buildable. */
  engines: { id: string; version: string; formatKey: string; summary: string; checks: string[] }[];

  /** Only exact person-only actions. Never work Brain could do itself. */
  needsPerson: { what: string; why: string; where: string }[];

  /** Set when the directive cannot be read, which stops questions and nothing else. */
  directive: { path: string; digest: string; bytes: number } | null;
  directiveProblem: string | null;
}

export async function puzzleView(projectId: string): Promise<PuzzleView> {
  const mode = await getCashMode(projectId);
  const snapshot = await puzzleSnapshot(projectId);

  const outputs = readOutputs(snapshot);
  const formats = readFormats(snapshot);
  const ledger = readLedger(snapshot, outputs);
  const leverage = readLeverage(snapshot, outputs);
  const production = readProductionStage(snapshot);
  const cheapBook = readCheapBook(snapshot);
  const lessons = readLessons(snapshot);

  const read = await readPuzzleDirective();

  /*
   * What the tick would ask next, computed without asking it. The plan is pure
   * over the snapshot, so this is the same decision the tick makes and not a
   * second one that could disagree with it.
   */
  const plan = planFrom(snapshot);
  const gate = mode ? await discoveryAllowed(projectId) : { allowed: false, reason: '' };

  const ourOpportunityIds = new Set(
    snapshot.outputs
      .map((one) => one.opportunityId)
      .filter((one): one is string => typeof one === 'string'),
  );
  const collected = new Map<string, number>();
  for (const settlement of snapshot.settlements) {
    if (!ourOpportunityIds.has(settlement.opportunityId)) continue;
    collected.set(
      settlement.currency,
      (collected.get(settlement.currency) ?? 0) + settlement.amountCents,
    );
  }

  return {
    projectId,
    active: Boolean(mode),

    rightNow: {
      collected: [...collected.entries()]
        .map(([currency, amountMinor]) => ({ currency, amountMinor }))
        .sort((a, b) => (a.currency < b.currency ? -1 : 1)),
      released: snapshot.outputs.filter((one) => one.releasedAt !== null).length,
      validatedPuzzles: leverage.validatedInstances,
      qualifiedOutputs: leverage.qualifiedOutputs,
      productionStage: production.stage,
      nextQuestion: plan.asks[0]
        ? `${plan.asks[0].purpose}${
            plan.asks[0].subjectLabel ? ` on ${plan.asks[0].subjectLabel}` : ''
          }: ${plan.asks[0].why}`
        : null,
      notAsking: !mode
        ? 'This project holds no sprint, so the kernel does nothing here.'
        : !gate.allowed
          ? gate.reason
          : !read.ok
            ? read.reason
            : plan.asks.length === 0
              ? (plan.declined[0]?.why ??
                'Every question this kernel would ask is already open or already answered.')
              : null,
    },

    ledger,
    formats,
    outputs,
    leverage,
    economics: routeEconomics(snapshot),
    production,
    cheapBook,
    lessons,

    beingMade: snapshot.rounds
      .filter((one) => one.state === 'OPEN')
      .map((one) => ({
        purpose: one.purpose,
        subject: one.subjectLabel,
        round: one.round,
        why: one.why,
        openedAt: one.createdAt,
      })),

    engines: listEngines().map((one) => ({
      id: one.id,
      version: one.version,
      formatKey: one.formatKey,
      summary: one.summary,
      checks: [...one.implementsChecks],
    })),

    needsPerson: needsPerson(snapshot, outputs, formats),

    directive: read.ok
      ? { path: read.directive.path, digest: read.directive.digest, bytes: read.directive.bytes }
      : null,
    directiveProblem: read.ok ? null : read.reason,
  };
}

/** One contribution reading per route that has any figures at all. */
function routeEconomics(snapshot: PuzzleSnapshot): ContributionReading[] {
  const out: ContributionReading[] = [];
  for (const route of snapshot.routes) {
    const lines = snapshot.economics.filter((one) => one.routeId === route.id);
    if (lines.length === 0) continue;
    const classes = [
      ...new Set(
        snapshot.outputs
          .filter((one) => one.routeId === route.id)
          .map((one) => one.productionClass),
      ),
    ];
    for (const productionClass of classes.length > 0 ? classes : (['DIGITAL_ONLY'] as const)) {
      out.push(
        readContribution({ lines, routeId: route.id, routeName: route.name, productionClass }),
      );
    }
  }
  return out;
}

/**
 * Exact person-only actions, and nothing Brain could do itself.
 *
 * §33 records the correction this list is written from: a card that asked a
 * person to attest to research Brain was at that moment doing, above a control
 * that recorded their sentence as a fact. Every entry below is something no
 * amount of research settles — a review, a compilation, a release, a
 * disposition, a playtest.
 */
function needsPerson(
  snapshot: PuzzleSnapshot,
  outputs: readonly OutputReading[],
  formats: readonly FormatReading[],
): { what: string; why: string; where: string }[] {
  const out: { what: string; why: string; where: string }[] = [];

  for (const format of awaitingReview(snapshot)) {
    out.push({
      what: `Review the generator for ${format.name}`,
      why:
        'It has a master and nobody has editorially reviewed it. The directive requires a ' +
        'person to review every new generator or template before it produces, and nothing ' +
        'automatic can record that review.',
      where: 'Masters',
    });
  }

  const ready = outputs.filter((one) => one.qualification === 'SELLABLE');
  for (const output of ready) {
    const row = snapshot.outputs.find((one) => one.id === output.outputId);
    if (row?.releasedAt) continue;
    out.push({
      what: `Release "${output.title}"`,
      why: output.why,
      where: 'Outputs',
    });
  }

  /*
   * A qualified product with no route recorded to reach its buyer.
   *
   * Attaching one is a person's decision — it is part of compiling the
   * product — so it belongs here even though *finding* a route is research
   * Brain is already doing. The sentence names both, because §24's rule is
   * that an item a person cannot act on is worse than none: with nothing on
   * the ledger yet, the honest remedy is to name a route or to wait for the
   * question that is open.
   */
  for (const output of outputs) {
    if (output.qualification !== 'QUALIFIED') continue;
    const row = snapshot.outputs.find((one) => one.id === output.outputId);
    if (row?.routeId) continue;
    out.push({
      what: `Say how "${output.title}" reaches its buyer`,
      why:
        snapshot.routes.length === 0
          ? 'Nothing is on the monetization ledger yet, so there is no route to attach. Name ' +
            'one, or wait for the question Brain has open about how money is captured here.'
          : `${snapshot.routes.length} route(s) are on the ledger and none is attached to it. ` +
            'A product with no route to its buyer cannot be read as sellable.',
      where: 'Outputs',
    });
  }

  const compilable = formats.filter((one) => one.maturity === 'VALIDATABLE');
  for (const format of compilable) {
    out.push({
      what: `Compile a product from ${format.name}`,
      why: `${format.passing} validated puzzle(s) exist and nothing has been compiled from them.`,
      where: 'Outputs',
    });
  }

  /*
   * The one reading no validator can produce. Reported as a standing need
   * rather than as a blocker, because the directive asks for a *sample* to be
   * playtested and does not say a product may not exist before one.
   */
  const playtests = snapshot.observations.filter((one) => one.kind === 'PLAYTEST_RESULT').length;
  const produced = snapshot.instances.length;
  if (produced > 0 && playtests === 0) {
    out.push({
      what: 'Playtest a sample',
      why:
        `${produced} puzzle(s) have been produced and nobody has played one. Ambiguity, ` +
        'readability, enjoyment, cultural fit and actual difficulty are not properties any ' +
        'validator here can check, so a person is the only reading of them there is.',
      where: 'Quality',
    });
  }

  return out;
}

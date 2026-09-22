/**
 * The operator surface: what the kernel holds, in the order the brief asks
 * for it.
 *
 * ---------------------------------------------------------------------------
 * Every figure here is a row, and the ones that are not say so
 * ---------------------------------------------------------------------------
 *
 * Nine sections, composed from readings that were each built to refuse rather
 * than estimate: a contribution withheld past a missing line, a leverage
 * multiplier that reports UNKNOWN rather than zero, a maturity rung that stops
 * at the first thing that is not true. What this module adds is the ordering
 * and the sentences; it computes no new number and softens none.
 *
 * `nextAction` is the one sentence that has to be right, because it is the one
 * somebody acts on. It comes from the allocator's own recorded reason where a
 * question is next, and from the maturity ladder's own blocker where it is
 * not — never from a summary written here, because a summary is the thing that
 * drifts from the rows it describes.
 */
import { listMoneyEntries } from '../../repos/cashLedger.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import { allCapabilities, type PuzzleCapability } from './capabilities.ts';
import { dollarBookReading, readEconomics, type UnitEconomics } from './economics.ts';
import { puzzleSnapshot, type PuzzleSnapshot } from './graph.ts';
import { planFrom, readMaturityFor } from './kernel.ts';
import { readLeverage, readQuality, type Leverage, type Quality } from './leverage.ts';
import { readLedger, topFive, type LedgerEntry } from './ledger.ts';
import { readLessons, type Lesson } from './lessons.ts';
import { implementedFormats } from './formats/index.ts';
import type { FormatMaturity } from './maturity.ts';
import type { CapabilityReading } from '../cash/capabilities.ts';
import type { PuzzleObservation } from '../../domain/types.ts';

export interface PuzzleView {
  projectId: string;
  /** Null when this project holds no sprint, which is most of them. */
  active: boolean;

  /* ---- RIGHT NOW ---- */
  rightNow: {
    formatsOnMap: number;
    formatsBrainCanMake: number;
    systems: number;
    validPuzzles: number;
    qualifiedProducts: number;
    promoted: number;
    /** Settled money attributable to a product of this kernel, in minor units. */
    collectedCents: number;
    currency: string | null;
    /** What the kernel is furthest along with, by the maturity ladder. */
    furthest: {
      format: string;
      rung: string;
      validPuzzles: number;
      products: number;
    } | null;
  };

  /* ---- TOP 5 NOW ---- */
  topFive: LedgerEntry[];
  /** The whole ledger, every state, never filtered. */
  ledger: LedgerEntry[];

  /* ---- BEING MADE NOW ---- */
  beingMade: {
    openQuestions: { roundId: string; purpose: string; subject: string; round: number }[];
    systemsGenerating: { masterId: string; title: string; held: number }[];
  };

  /* ---- LEVERAGE and QUALITY ---- */
  leverage: Leverage;
  quality: Quality;

  /* ---- ECONOMICS ---- */
  economics: UnitEconomics[];
  /** The brief's named question, answered from rows or not at all. */
  dollarBook: { established: string[]; missing: string[]; verdict: string };

  /* ---- PHYSICAL PRODUCTION ---- */
  physical: {
    stage: number;
    reading: string;
    productionRoutes: { name: string; format: string; terms: string }[];
    heldCapabilities: string[];
  };

  /* ---- MATURITY ---- */
  maturity: FormatMaturity[];

  /* ---- WHAT CHANGED ---- */
  lessons: Lesson[];
  recent: PuzzleObservation[];

  /* ---- NEEDS ME ---- */
  needsPerson: { what: string; why: string }[];

  /* ---- NEXT ---- */
  nextAction: string;

  /* ---- WHAT BRAIN CAN AND CANNOT DO ---- */
  capabilities: { puzzle: PuzzleCapability[]; commercial: CapabilityReading[] };
}

export async function puzzleView(projectId: string): Promise<PuzzleView> {
  const mode = await getCashMode(projectId);
  const snapshot = await puzzleSnapshot(projectId);
  const economics = readEconomics(snapshot.economics);
  const maturity = await readMaturityFor(projectId, snapshot);
  const capabilities = await allCapabilities();

  const held = heldCapabilitiesFrom(maturity);
  const ledger = readLedger({
    maturity,
    demand: snapshot.demand,
    routes: snapshot.routes,
    economics,
    constraints: snapshot.constraints,
    observations: snapshot.observations,
    heldCapabilities: held,
  });

  const leverage = readLeverage({
    masters: snapshot.masters,
    instances: snapshot.instances,
    products: snapshot.products,
    qualifications: snapshot.qualifications,
    observations: snapshot.observations,
  });
  const quality = readQuality({
    instances: snapshot.instances,
    observations: snapshot.observations,
  });

  const promotedIds = snapshot.products
    .map((one) => one.opportunityId)
    .filter((one): one is string => one !== null);
  const entries = await listMoneyEntries({ projectId, limit: 2000 });
  let collectedCents = 0;
  for (const entry of entries) {
    if (entry.kind !== 'SETTLEMENT') continue;
    if (!entry.opportunityId || !promotedIds.includes(entry.opportunityId)) continue;
    collectedCents += entry.amountCents;
  }

  const furthest = maturity[0] ?? null;
  const plan = planFrom(snapshot, economics);

  return {
    projectId,
    active: mode !== null,
    rightNow: {
      formatsOnMap: snapshot.formats.length,
      formatsBrainCanMake: snapshot.formats.filter((one) => one.generates).length,
      systems: snapshot.masters.length,
      validPuzzles: leverage.validPuzzles,
      qualifiedProducts: leverage.qualifiedOutputs,
      promoted: promotedIds.length,
      collectedCents,
      currency: mode?.currency ?? null,
      /*
       * The rung and what stands behind it, because the rung alone reads as
       * "nothing has happened" for a format holding a catalog and no buyer —
       * which is a real and common state, and a correct DISCOVERED beside
       * `136 validated puzzles` is a completely different sentence.
       */
      furthest: furthest
        ? {
            format: furthest.name,
            rung: furthest.rung,
            validPuzzles: furthest.evidence.validPuzzles,
            products: furthest.evidence.products,
          }
        : null,
    },
    topFive: topFive(ledger),
    ledger,
    beingMade: {
      openQuestions: snapshot.rounds
        .filter((one) => one.state === 'OPEN')
        .map((one) => ({
          roundId: one.id,
          purpose: one.purpose,
          subject:
            snapshot.formats.find((format) => format.key === one.formatKey)?.name ??
            one.formatKey ??
            'the puzzle trade',
          round: one.round,
        })),
      systemsGenerating: snapshot.masters.map((one) => ({
        masterId: one.id,
        title: one.title,
        held: snapshot.instances.filter(
          (instance) => instance.masterId === one.id && instance.validationState === 'VALID',
        ).length,
      })),
    },
    leverage,
    quality,
    economics,
    dollarBook: dollarBookReading(snapshot.economics),
    physical: physicalReading(snapshot, held),
    maturity,
    lessons: readLessons(snapshot.observations),
    /* Newest first, which is the one place in this module where recency is the point. */
    recent: [...snapshot.observations].reverse().slice(0, 10),
    needsPerson: needsPerson(maturity, ledger, capabilities.puzzle),
    nextAction: nextAction(plan, maturity, snapshot),
    capabilities,
  };
}

/**
 * Which manufacturing capabilities this operation holds, read back out of the
 * maturity reading rather than queried twice.
 *
 * `readMaturityFor` already asked §39's programme, and asking again here would
 * be two readers of one fact — which is the defect this repository records
 * more often than any other. What it can recover is whether *any* were held,
 * which is all the ledger's `OWNED_MANUFACTURING` requirement needs.
 */
function heldCapabilitiesFrom(maturity: readonly FormatMaturity[]): string[] {
  return maturity.some((one) => one.rung === 'PRODUCTION_OWNED') ? ['owned production'] : [];
}

function physicalReading(
  snapshot: PuzzleSnapshot,
  held: readonly string[],
): PuzzleView['physical'] {
  const production = snapshot.routes.filter((one) => one.kind === 'PRODUCTION');
  const physicalProducts = snapshot.products.filter(
    (one) => one.productClass === 'PRINT_BOOK' || one.productClass === 'CARD_OR_BOXED',
  );

  const stage =
    held.length > 0 ? 4 : physicalProducts.length > 0 ? 2 : production.length > 0 ? 1 : 0;

  return {
    stage,
    reading:
      stage === 0
        ? 'Nothing physical. Everything this kernel has made is text, which is enough to prove ' +
          'a puzzle and not enough to print one — TYPESET_FOR_PRINT reads MISSING, and it is ' +
          'the first capability between here and any printed route.'
        : stage === 1
          ? `${production.length} production route(s) are established and nothing physical has ` +
            'been compiled. The next step is a print-on-demand or prototype run, which puts no ' +
            'inventory at risk.'
          : stage === 2
            ? `${physicalProducts.length} physical product(s) are compiled against ` +
              `${production.length} established route(s). Whether a real run is worth it is the ` +
              'economics reading, and it is withheld until the lines that decide it are published.'
            : 'Production capability is held. Whether owning more of it is worth it is the ' +
              'manufacturing programme’s capital arithmetic rather than this kernel’s.',
    productionRoutes: production.map((one) => ({
      name: one.name,
      format: one.formatKey,
      terms: one.terms,
    })),
    heldCapabilities: [...held],
  };
}

/**
 * The decisions that are genuinely a person's.
 *
 * Only the things nothing else can resolve — never a research question, never
 * a code change, and never a figure Brain could look up. §30 records what
 * asking a person for research costs: a card that asks the owner for nine
 * commercial facts Brain could have established itself.
 */
function needsPerson(
  maturity: readonly FormatMaturity[],
  ledger: readonly LedgerEntry[],
  capabilities: readonly PuzzleCapability[],
): { what: string; why: string }[] {
  const out: { what: string; why: string }[] = [];

  for (const one of maturity) {
    if (one.remedy !== 'PERSON') continue;
    out.push({ what: `${one.name}: ${one.rung} → next rung`, why: one.waitingOn });
  }

  const active = ledger.filter((one) => one.state === 'ACTIVE');
  if (active.length > 0) {
    out.push({
      what: `Authorize a commercial action for ${active.length} ready route(s)`,
      why:
        `${active.map((one) => one.route.title).join(', ')} need nothing further researched. ` +
        'What remains is a commercial action under the standing grant, which is a person’s ' +
        'decision and never this kernel’s.',
    });
  }

  const rights = capabilities.find((one) => one.id === 'HOLD_RIGHTS_IN_SOURCE_MATERIAL');
  if (rights && rights.nextStep) {
    out.push({ what: 'Establish the rights position on a blocked corpus', why: rights.nextStep });
  }

  return out;
}

function nextAction(
  plan: { asks: { purpose: string; formatName: string | null; why: string }[] },
  maturity: readonly FormatMaturity[],
  snapshot: PuzzleSnapshot,
): string {
  const first = plan.asks[0];
  if (first) {
    return (
      `Ask ${first.purpose}${first.formatName ? ` about ${first.formatName}` : ''}. ${first.why}`
    );
  }
  if (snapshot.openRounds > 0) {
    return (
      `${snapshot.openRounds} question(s) are already being researched and no slot is free. ` +
      'The next thing happens when one of them settles.'
    );
  }
  const blocked = maturity.find((one) => one.remedy !== 'NOTHING');
  if (blocked) return `${blocked.name}: ${blocked.waitingOn}`;
  if (snapshot.formats.length === 0) {
    return (
      'Nothing is on the map. The first pass of the tick asks which kinds of puzzle are ' +
      `actually published and sold; this repository can already generate ${implementedFormats()
        .filter((one) => one.render)
        .length} of them and check ${implementedFormats().length}.`
    );
  }
  return 'Every question this kernel knows how to ask has been asked and settled.';
}

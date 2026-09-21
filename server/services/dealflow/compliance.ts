/**
 * Whether these goods may actually be sold, imported, registered, operated and
 * accepted in that market — read from rows, one layer at a time.
 *
 * ---------------------------------------------------------------------------
 * The four layers do not collapse, and that is the whole module
 * ---------------------------------------------------------------------------
 *
 * A factory holding ISO 9001 says something about the factory. It says nothing
 * about whether this trailer carries the type approval the destination demands
 * of it, nothing about whether that state will register it, and nothing about
 * whether the buyer's own standards accept it. Four different questions, four
 * different bodies answering them, four different ways to fail — and the trade
 * is full of people who found out in that order, after the equipment was
 * built.
 *
 * So `layerReading` answers each one separately and `envelopeFor` refuses to
 * compose them into a single yes. The only aggregate it produces is a verdict
 * that goes wrong in the safe direction.
 *
 * ---------------------------------------------------------------------------
 * NOT_ESTABLISHED is not CLEAR, and the difference is a whole finding
 * ---------------------------------------------------------------------------
 *
 * §30's rule — an unknown is never a favourable assumption — is at its
 * sharpest here, because the absence of requirement rows looks exactly like
 * the absence of requirements. A layer nobody has researched has no rows; a
 * layer somebody researched and found empty also has no rows, unless the
 * schema gives that second fact somewhere to live.
 *
 * It does: `REQUIREMENT_ABSENCE` writes a row with posture `NONE_FOUND`, and
 * the validator refuses to accept one that does not name where the worker
 * looked (§14). So a layer with no rows at all is `NOT_ESTABLISHED`, which is
 * a *task*, and a layer with a NONE_FOUND row is `NONE_REQUIRED`, which is an
 * answer. Nothing in this file may report the first as the second.
 *
 * ---------------------------------------------------------------------------
 * Nothing here reads a sentence
 * ---------------------------------------------------------------------------
 *
 * The layer, the posture and the destination are all columns a worker declared
 * from a closed set. This module counts rows and compares enums. It does not
 * decide that a requirement "sounds satisfied", does not infer that one
 * approval implies another, and does not judge whether a statement is
 * important — §8, at the question where a confident wrong answer is most
 * expensive.
 */
import { COMPLIANCE_LAYERS, equipmentKey, jurisdictionKey } from '../../domain/dealflow.ts';
import type { ComplianceLayer, DealRequirement } from '../../domain/types.ts';

/**
 * What one layer says.
 *
 * Four values, and the ordering between them is not a scale. `NOT_ESTABLISHED`
 * and `PROHIBITED` are both "you may not proceed", and they are different
 * words because their remedies are opposite: one is answered by research and
 * the other cannot be answered at all.
 */
export const LAYER_READINGS = [
  /** Nobody has looked. A task, never a clearance. */
  'NOT_ESTABLISHED',
  /** A documented search found this layer demands nothing here. */
  'NONE_REQUIRED',
  /** Requirements are known, and something must be done about them. */
  'REQUIREMENTS_KNOWN',
  /** A source says these goods may not enter or be used at all. */
  'PROHIBITED',
] as const;
export type LayerReading = (typeof LAYER_READINGS)[number];

export interface LayerView {
  layer: ComplianceLayer;
  reading: LayerReading;
  /** The requirements themselves, so a reader can check every one. */
  requirements: DealRequirement[];
  /** What this says, and what it does not. Composed here, never by a screen. */
  because: string;
  /** The remedy, where the reading has one. Null where it needs no action. */
  remedy: string | null;
  /**
   * The most recent effective date any row carries, so freshness is readable.
   *
   * Null where no source stated one, which is common and honest: plenty of
   * sources state a requirement without naming when it took effect.
   */
  latestEffectiveDate: string | null;
}

/** What the whole envelope says, and it is never a single yes. */
export const ENVELOPE_VERDICTS = [
  /** At least one layer is prohibited. Nothing downstream should proceed. */
  'BLOCKED',
  /** One or more layers have never been looked at. */
  'INCOMPLETE',
  /** Every layer is answered, and some carry requirements to satisfy. */
  'ESTABLISHED',
] as const;
export type EnvelopeVerdict = (typeof ENVELOPE_VERDICTS)[number];

export interface ComplianceEnvelope {
  equipmentClass: string;
  destination: string;
  verdict: EnvelopeVerdict;
  because: string;
  layers: LayerView[];
  /** The layers nobody has researched, named, because that is the work. */
  unestablished: ComplianceLayer[];
  /** How many separate requirements a deal here would have to satisfy. */
  openRequirements: number;
}

const LAYER_MEANING: Readonly<Record<ComplianceLayer, string>> = Object.freeze({
  FACTORY_CERTIFICATION: 'what the factory itself must hold',
  PRODUCT_CERTIFICATION: 'what this product must hold',
  MARKET_APPROVAL: 'what the destination state demands before it may be registered or used',
  BUYER_ACCEPTANCE: 'what this buyer demands beyond anything a government requires',
  IMPORT_BARRIER: 'what stands in the way of bringing the goods in at all',
});

const LAYER_REMEDY: Readonly<Record<ComplianceLayer, string>> = Object.freeze({
  FACTORY_CERTIFICATION:
    'Research which quality, welding and materials approvals the destination requires of a ' +
    'factory supplying these goods, and which ones this supplier actually holds.',
  PRODUCT_CERTIFICATION:
    'Research the type approvals, testing and marking this class of equipment must carry, ' +
    'for the cargo and operating conditions it is actually for.',
  MARKET_APPROVAL:
    'Research whether this equipment can be registered and operated in the destination — ' +
    'axle loads, braking, lighting, dimensions, dangerous-goods rules — and what the state ' +
    'demands before it may be.',
  BUYER_ACCEPTANCE:
    'Research whether this buyer imposes standards of its own beyond the law, which large ' +
    'industrial and mining buyers routinely do.',
  IMPORT_BARRIER:
    'Research duties, quotas, bans, age limits and pre-shipment inspection requirements for ' +
    'these goods entering this market.',
});

/**
 * Read one layer from the rows that apply to it.
 *
 * `PROHIBITED` wins over everything, and that ordering is deliberate rather
 * than incidental: a market that bans these goods is not made less banned by
 * three other requirements somebody could satisfy.
 */
export function layerReading(
  layer: ComplianceLayer,
  rows: readonly DealRequirement[],
): LayerView {
  const mine = rows.filter((one) => one.layer === layer);
  const prohibited = mine.filter((one) => one.posture === 'PROHIBITED');
  const required = mine.filter((one) => one.posture === 'REQUIRED');
  const noneFound = mine.filter((one) => one.posture === 'NONE_FOUND');

  const dates = mine
    .map((one) => one.effectiveDate)
    .filter((one): one is string => typeof one === 'string' && one !== '')
    .sort();
  const latestEffectiveDate = dates.length > 0 ? (dates[dates.length - 1] ?? null) : null;

  if (prohibited.length > 0) {
    return {
      layer,
      reading: 'PROHIBITED',
      requirements: mine,
      because:
        `A source states these goods may not enter or be used here — ${LAYER_MEANING[layer]}. ` +
        'This is not a requirement that more work satisfies.',
      remedy:
        'Nothing here is researchable into a yes. Either the equipment class, the ' +
        'configuration or the destination has to change, or this deal does not exist.',
      latestEffectiveDate,
    };
  }

  if (required.length > 0) {
    return {
      layer,
      reading: 'REQUIREMENTS_KNOWN',
      requirements: mine,
      because:
        `${required.length} requirement${required.length === 1 ? '' : 's'} established for ` +
        `${LAYER_MEANING[layer]}. Established means somebody read a source saying so — it ` +
        'does not mean anybody has satisfied them.',
      remedy:
        'Confirm, per requirement, whether the supplier already holds it, can obtain it, or ' +
        'cannot — and what that costs and how long it takes.',
      latestEffectiveDate,
    };
  }

  if (noneFound.length > 0) {
    return {
      layer,
      reading: 'NONE_REQUIRED',
      requirements: mine,
      because:
        `A documented search found nothing demanded here for ${LAYER_MEANING[layer]}. That is ` +
        'an answer because somebody looked and said where; it would not be one otherwise.',
      remedy: null,
      latestEffectiveDate,
    };
  }

  return {
    layer,
    reading: 'NOT_ESTABLISHED',
    requirements: [],
    because:
      `Nobody has looked at ${LAYER_MEANING[layer]} for this class into this market. No rows ` +
      'is not the same fact as no requirements, and reading it as one is how equipment gets ' +
      'built for a market it cannot enter.',
    remedy: LAYER_REMEDY[layer],
    latestEffectiveDate: null,
  };
}

/**
 * The whole envelope for one (class, destination).
 *
 * Keyed by those two and by nothing else — never by deal, never by party —
 * because that is what a requirement is actually about. The same dangerous-
 * goods approval applies to every fuel tanker entering that market, so binding
 * it to one deal would make Brain research it again for the next one, which is
 * §13's waste at the most expensive question in this trade.
 */
export function envelopeFor(input: {
  equipmentClass: string;
  destination: string;
  requirements: readonly DealRequirement[];
}): ComplianceEnvelope {
  const key = equipmentKey(input.equipmentClass);
  const destKey = jurisdictionKey(input.destination);
  const mine = input.requirements.filter(
    (one) => one.equipmentKey === key && jurisdictionKey(one.destination) === destKey,
  );

  const layers = COMPLIANCE_LAYERS.map((layer) => layerReading(layer, mine));
  const unestablished = layers
    .filter((one) => one.reading === 'NOT_ESTABLISHED')
    .map((one) => one.layer);
  const openRequirements = mine.filter((one) => one.posture === 'REQUIRED').length;

  const blocked = layers.filter((one) => one.reading === 'PROHIBITED');
  if (blocked.length > 0) {
    return {
      equipmentClass: input.equipmentClass,
      destination: input.destination,
      verdict: 'BLOCKED',
      because:
        `${blocked.map((one) => one.layer).join(' and ')} says these goods may not be brought ` +
        'in or used here. No amount of further work turns that into a yes.',
      layers,
      unestablished,
      openRequirements,
    };
  }

  if (unestablished.length > 0) {
    return {
      equipmentClass: input.equipmentClass,
      destination: input.destination,
      verdict: 'INCOMPLETE',
      because:
        `${unestablished.length} of ${COMPLIANCE_LAYERS.length} layers ` +
        `(${unestablished.join(', ')}) ` +
        `${unestablished.length === 1 ? 'has' : 'have'} never been researched for ` +
        `${input.equipmentClass} into ${input.destination}. Until ` +
        `${unestablished.length === 1 ? 'it has' : 'they have'}, "we found nothing against ` +
        'it" is a statement about our searching rather than about the market.',
      layers,
      unestablished,
      openRequirements,
    };
  }

  return {
    equipmentClass: input.equipmentClass,
    destination: input.destination,
    verdict: 'ESTABLISHED',
    because:
      openRequirements === 0
        ? `All ${COMPLIANCE_LAYERS.length} layers were searched and none demands anything for ` +
          `${input.equipmentClass} into ${input.destination}.`
        : `All ${COMPLIANCE_LAYERS.length} layers are answered. ${openRequirements} ` +
          `requirement${openRequirements === 1 ? '' : 's'} ` +
          `${openRequirements === 1 ? 'applies' : 'apply'}, each of which still has to be met ` +
          'by the supplier rather than merely known about.',
    layers,
    unestablished,
    openRequirements,
  };
}

/**
 * Which layer to research next for one envelope, or null when none is missing.
 *
 * In the order the trade fails in, and that order is an argument rather than a
 * preference. An import barrier can make every other answer irrelevant, so it
 * is asked first and cheaply. Market approval is the one that most often kills
 * a deal after the money is committed, so it is second. The buyer's own
 * standards come last because they are the only layer that can be negotiated
 * with a person rather than researched against a state.
 */
export const LAYER_RESEARCH_ORDER: readonly ComplianceLayer[] = Object.freeze([
  'IMPORT_BARRIER',
  'MARKET_APPROVAL',
  'PRODUCT_CERTIFICATION',
  'FACTORY_CERTIFICATION',
  'BUYER_ACCEPTANCE',
]);

export function nextLayerToResearch(envelope: ComplianceEnvelope): ComplianceLayer | null {
  const missing = new Set(envelope.unestablished);
  for (const layer of LAYER_RESEARCH_ORDER) {
    if (missing.has(layer)) return layer;
  }
  return null;
}

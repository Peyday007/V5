/**
 * Per-position intermediation evidence, as rows (RES-15-4; S-0148, S-0150).
 *
 * "The research deliverable is commercially usable evidence per constructed position,
 * not industry fact dumps: exact payer and reachable channel, observed demand, … and the
 * fastest meaningful next action. Where a source establishes only a public asking price
 * or total market size, identify and separately investigate the remaining buyer-access
 * and conversion gaps."
 *
 * `intermediationPositions.ts` says what must be established at a position and what is
 * missing; this module is where that is written down for a real opening, so a reader of
 * production records — a probe, a screen, a later dive — has something to read. Before
 * it, the per-position contract existed only as question prose and in-memory estimates.
 *
 * The store is the one Cash Mode already has: one append-only `cash_events` row of kind
 * `CASH_POSITION_EVIDENCE` per reading (§10.3, §20.4 — no second store). A reading is
 * taken when an intermediation or constructed round's claim is harvested into an
 * opening, and again whenever the opening's own evidence moves (`applyValidationAnswers`).
 * A new reading never edits an old one (invariant 17); a reading identical to the
 * latest is not written twice, so a replayed pass changes nothing.
 *
 * Every field value is read from a row that already holds it — the opening's columns or
 * its evidence card facts, each with the claim behind it — and nothing is estimated
 * here. A field nothing answered is missing, and is named as a gap at each position.
 */
import { createHash } from 'node:crypto';
import type { CashCardFact, CashOpportunity, OpportunitySignal } from '../../domain/types.ts';
import { cashEventsOfKind, cashEventsOfKindInProject, recordCashEvent } from '../../repos/cashMode.ts';
import { cardFactsFor } from '../../repos/cashCardFacts.ts';
import { INTERMEDIATION_BUCKETS, isIntermediationBucket, type IntermediationBucket } from './intermediationBuckets.ts';
import {
  EVIDENCE_FIELD_KEYS,
  narrowEvidence,
  POSITIONS,
  POSITION_KEYS,
  positionEvidenceGaps,
  positionsToExamine,
  positionStructureLabel,
  resolvePosition,
  type EvidenceBasis,
  type EvidenceField,
  type PositionFacts,
  type ResolvedPosition,
} from './intermediationPositions.ts';

export const POSITION_EVIDENCE_EVENT = 'CASH_POSITION_EVIDENCE';

/** `GOAL_BUCKET_PREFIX` in `discovery.ts`, restated because discovery imports this module; a test pins the two equal. */
export const GOAL_ROUND_PREFIX = 'goal-';

// ── which rounds carry the contract ──────────────────────────────────────────

/**
 * Whether openings from this bucket owe per-position evidence: an intermediation entry
 * bucket, or a goal's constructed arrangement (`goal-<id>-mx-<key>`), which is a
 * transaction Brain built and must examine position by position.
 */
export function owesPositionEvidence(bucketId: string | null | undefined): boolean {
  if (!bucketId) return false;
  if (isIntermediationBucket({ id: bucketId })) return true;
  return bucketId.startsWith(GOAL_ROUND_PREFIX) && bucketId.includes('-mx-');
}

function entryOf(bucketId: string | null | undefined): IntermediationBucket | null {
  return bucketId ? (INTERMEDIATION_BUCKETS.find((one) => one.id === bucketId) ?? null) : null;
}

// ── what a source established ────────────────────────────────────────────────

const MARKET_SIZE = /\b(market (size|value|worth)|market (is|was) (worth|valued)|total addressable|TAM\b|industry (is|was) worth|(valued|worth) at)\b|\b\d[\d,.]*\s*(billion|bn|trillion)\b/i;
const ASKING_PRICE = /\b(asking price|list(ed)? (price|at)|priced at|for sale (at|for)|sells? for|retail (price|for)|price list|rate card)\b/i;

const BASIS_BY_SIGNAL: Readonly<Record<OpportunitySignal, EvidenceBasis>> = Object.freeze({
  ACTIVE_BUYER_DEMAND: 'BUYER_INQUIRY',
  EXPIRING_OPENING: 'BUYER_INQUIRY',
  PAID_TASK_OR_CONTRACT: 'CONTRACT',
  RECURRING_OUTSOURCED_WORK: 'OBSERVED_TRANSACTION',
  PRICING_OR_INFORMATION_ASYMMETRY: 'PUBLIC_ASKING_PRICE',
  RESALABLE_ASSET_OPENING: 'PUBLIC_ASKING_PRICE',
  SUPPLY_DEMAND_MISMATCH: 'PUBLISHED_MISMATCH',
});

/**
 * What the claim an opening was harvested from establishes. A sentence that only states
 * a market's size, or only a published asking price, is read as exactly that whatever
 * signal the worker set — neither shows the payer can be reached or will buy.
 */
/** True when a sentence states a market-level figure (a market's size or worth), the claimBasis reading. */
export function isMarketLevelFigure(text: string | null | undefined): boolean {
  return !!text && MARKET_SIZE.test(text);
}

export function claimBasis(input: { signal: OpportunitySignal | null; claim: string | null }): EvidenceBasis[] {
  const text = input.claim ?? '';
  if (MARKET_SIZE.test(text)) return ['TOTAL_MARKET_SIZE'];
  if (ASKING_PRICE.test(text) && input.signal !== 'ACTIVE_BUYER_DEMAND' && input.signal !== 'PAID_TASK_OR_CONTRACT') return ['PUBLIC_ASKING_PRICE'];
  return input.signal ? [BASIS_BY_SIGNAL[input.signal]] : [];
}

// ── which position a finding is about ────────────────────────────────────────

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const POSITION_PATTERNS: ReadonlyArray<[string, RegExp]> = POSITION_KEYS.map((key) => {
  const label = POSITIONS[key].label;
  const words = label.split(/[\s-]+/).map(escape).join('[\\s-]+');
  return [key, new RegExp(`\\b${words}s?\\b`, 'i')];
});

/** The catalogued positions a finding names in its own words; empty when it names none. */
export function positionsNamed(text: string | null | undefined): string[] {
  if (!text) return [];
  return POSITION_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([key]) => key);
}

// ── a reading ────────────────────────────────────────────────────────────────

export interface EvidenceValue {
  value: string;
  /** Where it was read from: a card fact (with its claim) or the opening's own column. */
  from: 'CARD_FACT' | 'OPENING';
  claimId: string | null;
}

export interface PositionReading {
  position: string;
  catalogued: string | null;
  structure: string | null;
  /** What of ours is exposed at this position, from the catalogue; null for a discovered one. */
  capitalExposure: string | null;
  /** S-0150 fields still missing at this position, plus BUYER_ACCESS / CONVERSION where only a price or size is known. */
  gaps: string[];
  /** The separate investigations a narrow source leaves open, asked at this exact position. */
  separateInvestigations: string[];
}

export interface PositionEvidence {
  opportunityId: string;
  bucketId: string | null;
  sourceClaimId: string | null;
  entry: { end: string; entryPoint: string; buyerType: string; marketStructure: string } | null;
  /** Named by the finding itself; when it names none, every catalogued position is examined. */
  chosen: string[];
  fields: Partial<Record<EvidenceField, EvidenceValue>>;
  bases: EvidenceBasis[];
  narrow: boolean;
  positions: PositionReading[];
  fingerprint: string;
}

/** Card fields that answer each S-0150 field, first present wins. Never a guess: a field with no row stays missing. */
const CARD_FIELDS: Readonly<Partial<Record<EvidenceField, readonly string[]>>> = Object.freeze({
  payer: ['payer'],
  channel: ['access', 'acquisitionAccess'],
  offer: ['offer'],
  supply: ['fulfillment'],
  price: ['price', 'revenueRange'],
  spread: ['spread', 'commission'],
  acquisitionCost: ['acquisitionCost'],
  throughput: ['throughput'],
  fulfilment: ['delivery', 'laborNeeds'],
  margin: ['margin', 'economics'],
  timing: ['timeToFirstCash'],
  cashStructure: ['terms', 'paymentTerms'],
  capitalExposure: ['exposure'],
  rights: ['eligibility', 'rights'],
  limits: ['limits'],
  nextAction: ['nextAction'],
});

/** The opening's own columns behind each field, read only where no card fact answers it. */
function openingValue(opportunity: CashOpportunity, field: EvidenceField): string | null {
  switch (field) {
    case 'payer': return opportunity.payer;
    case 'channel': return opportunity.reachableChannel;
    case 'demand': return opportunity.buyingSignal;
    case 'offer': return opportunity.offerScope;
    case 'supply': return opportunity.fulfillmentOwner;
    case 'price': return opportunity.priceCents === null ? null : `${opportunity.priceCents} ${opportunity.currency} minor units`;
    case 'fulfilment': return opportunity.deliveryMethod;
    case 'margin': return opportunity.economicsNote;
    case 'cashStructure': return opportunity.paymentTerms;
    case 'capitalExposure': return opportunity.peakFundingCents === null ? null : `${opportunity.peakFundingCents} ${opportunity.currency} minor units`;
    default: return null;
  }
}

const filled = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim().length > 0;

/**
 * Read one opening's per-position evidence from its rows. Pure: the caller supplies the
 * opening, its card facts and the source claim's text. `nextAction` and `uncertainties`
 * are taken only from what research recorded; the gaps this reading names are what is
 * uncertain, and they are carried on every position.
 */
export function readPositionEvidence(input: {
  opportunity: CashOpportunity;
  facts: readonly CashCardFact[];
  bucketId: string | null;
  claim: { id: string; claim: string; signal: OpportunitySignal | null } | null;
  /** Positions Brain discovered for this transaction, carried verbatim (R01-A1). */
  discovered?: readonly string[];
}): PositionEvidence {
  const { opportunity } = input;
  const byField = new Map(input.facts.filter((one) => filled(one.value)).map((one) => [one.field, one]));
  const bases = input.claim ? claimBasis({ signal: input.claim.signal, claim: input.claim.claim }) : claimBasis({ signal: opportunity.opportunitySignal, claim: opportunity.buyingSignal });
  // The buying signal is observed demand only when its source observed demand: a sentence
  // that states an asking price or a market size is not anybody asking to buy.
  const signalIsDemand = !narrowEvidence({ fields: {}, bases });
  const fields: Partial<Record<EvidenceField, EvidenceValue>> = {};
  for (const field of EVIDENCE_FIELD_KEYS) {
    if (field === 'demand' && !signalIsDemand) continue;
    const fact = (CARD_FIELDS[field] ?? []).map((name) => byField.get(name)).find((one) => one !== undefined);
    if (fact) {
      fields[field] = { value: fact.value.slice(0, 600), from: 'CARD_FACT', claimId: fact.claimId ?? null };
      continue;
    }
    const own = field === 'nextAction' ? null : openingValue(opportunity, field);
    if (filled(own)) fields[field] = { value: own.slice(0, 600), from: 'OPENING', claimId: field === 'demand' ? (input.claim?.id ?? opportunity.sourceClaimId) : null };
  }

  const asFacts: PositionFacts = {
    fields: Object.fromEntries(Object.entries(fields).map(([key, one]) => [key, one!.value])) as PositionFacts['fields'],
    bases,
  };
  const narrow = narrowEvidence(asFacts);

  const named = positionsNamed(`${input.claim?.claim ?? ''} ${opportunity.buyingSignal ?? ''} ${opportunity.offerScope ?? ''}`);
  const discovered = (input.discovered ?? []).filter((one) => one.trim().length > 0);
  const examine: ResolvedPosition[] = named.length
    ? [...named.map((key) => resolvePosition(key)), ...discovered.map((name) => resolvePosition(name))]
    : positionsToExamine(discovered);

  const positions = examine.map((position): PositionReading => {
    const gaps = positionEvidenceGaps(position, asFacts).filter((gap) => gap.kind !== 'FIELD' || gap.field !== 'uncertainties');
    return {
      position: position.definition?.label ?? position.name,
      catalogued: position.catalogued,
      structure: positionStructureLabel(position),
      capitalExposure: position.definition?.capitalExposure ?? null,
      gaps: gaps.map((gap) => (gap.kind === 'FIELD' ? gap.field : gap.kind)),
      separateInvestigations: gaps.filter((gap) => gap.kind !== 'FIELD').map((gap) => gap.ask),
    };
  });

  const entry = entryOf(input.bucketId);
  const body = {
    opportunityId: opportunity.id,
    bucketId: input.bucketId,
    sourceClaimId: input.claim?.id ?? opportunity.sourceClaimId,
    entry: entry ? { end: entry.entry, entryPoint: entry.entryPoint, buyerType: entry.buyerType, marketStructure: entry.marketStructure } : null,
    chosen: named.length ? named.map((key) => POSITIONS[key as keyof typeof POSITIONS].label) : [],
    fields,
    bases,
    narrow,
    positions,
  };
  const fingerprint = createHash('sha256').update(JSON.stringify({ fields, bases, positions: positions.map((one) => [one.position, one.gaps]) })).digest('hex').slice(0, 32);
  return { ...body, fingerprint };
}

/** The S-0150 fields a reading established, for a one-line summary. */
function establishedFields(reading: PositionEvidence): EvidenceField[] {
  return EVIDENCE_FIELD_KEYS.filter((field) => reading.fields[field] !== undefined);
}

// ── rows ─────────────────────────────────────────────────────────────────────

/**
 * Take and record one opening's per-position evidence. Append-only; a reading identical
 * to the opening's latest is not written again, so a replayed pass writes nothing.
 * Returns the reading written, or null when nothing changed.
 */
export async function recordPositionEvidence(input: {
  projectId: string;
  opportunity: CashOpportunity;
  bucketId: string | null;
  claim: { id: string; claim: string; signal: OpportunitySignal | null } | null;
  discovered?: readonly string[];
}): Promise<PositionEvidence | null> {
  const facts = await cardFactsFor(input.opportunity.id);
  const reading = readPositionEvidence({ ...input, facts });
  const history = await cashEventsOfKind(input.opportunity.id, POSITION_EVIDENCE_EVENT);
  const latest = history.at(-1);
  if (latest && latest.detail.fingerprint === reading.fingerprint) return null;
  const established = establishedFields(reading);
  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: input.opportunity.id,
    kind: POSITION_EVIDENCE_EVENT,
    actorRef: 'BRAIN',
    summary:
      `Per-position evidence across ${reading.positions.length} position(s): ` +
      `${established.length} of ${EVIDENCE_FIELD_KEYS.length} fields established` +
      (reading.narrow ? '; only a public asking price or market size is known, so buyer access and conversion are investigated separately.' : '.'),
    detail: reading as unknown as Record<string, unknown>,
  });
  return reading;
}

/**
 * Re-read an opening that already owes per-position evidence, after its own evidence
 * moved. An opening with no earlier reading is not one this contract covers and is left
 * alone; the earlier reading's round and source claim are carried forward.
 */
export async function refreshPositionEvidence(projectId: string, opportunity: CashOpportunity): Promise<PositionEvidence | null> {
  const history = await cashEventsOfKind(opportunity.id, POSITION_EVIDENCE_EVENT);
  const latest = history.at(-1);
  if (!latest) return null;
  const bucketId = typeof latest.detail.bucketId === 'string' ? latest.detail.bucketId : null;
  const discovered = (Array.isArray(latest.detail.positions) ? latest.detail.positions : [])
    .filter((one): one is { position: string; catalogued: string | null } => !!one && typeof (one as { position?: unknown }).position === 'string')
    .filter((one) => one.catalogued === null)
    .map((one) => one.position);
  return recordPositionEvidence({ projectId, opportunity, bucketId, claim: null, discovered });
}

/** Each opening's latest per-position evidence in a project, as recorded. */
export async function latestPositionEvidence(projectId: string): Promise<Map<string, PositionEvidence>> {
  const out = new Map<string, PositionEvidence>();
  for (const event of await cashEventsOfKindInProject(projectId, POSITION_EVIDENCE_EVENT)) {
    if (event.opportunityId) out.set(event.opportunityId, event.detail as unknown as PositionEvidence);
  }
  return out;
}

/**
 * What a deep dive must investigate separately for an opening whose recorded evidence is
 * only a public asking price or a market size (S-0150): buyer access and conversion, each
 * named on its own and at the positions still missing it. Empty when the opening's latest
 * reading is not narrow, or it has none.
 */
export function separateInvestigationsSentence(reading: Pick<PositionEvidence, 'narrow' | 'positions'> | null | undefined): string {
  if (!reading?.narrow) return '';
  const missing = (kind: string) => reading.positions.filter((one) => one.gaps.includes(kind)).map((one) => one.position);
  const access = missing('BUYER_ACCESS');
  const conversion = missing('CONVERSION');
  if (!access.length && !conversion.length) return '';
  const parts: string[] = [];
  if (access.length) parts.push(`buyer access — a reachable channel to a named payer (at the ${access.join(', ')} position${access.length > 1 ? 's' : ''})`);
  if (conversion.length) parts.push(`conversion — observed buying through that channel (at the ${conversion.join(', ')} position${conversion.length > 1 ? 's' : ''})`);
  return (
    ' What is recorded for this opening is only a public asking price or a total market size, which shows neither that the payer ' +
    `can be reached nor that anyone buys this way, so investigate separately and report each on its own: ${parts.join('; and ')}.`
  );
}

/** An opening's latest per-position reading, or null when none was recorded. */
export async function latestReadingFor(opportunityId: string): Promise<PositionEvidence | null> {
  const latest = (await cashEventsOfKind(opportunityId, POSITION_EVIDENCE_EVENT)).at(-1);
  return latest ? (latest.detail as unknown as PositionEvidence) : null;
}

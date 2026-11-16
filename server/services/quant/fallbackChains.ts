/**
 * The fallback chain of every real fulfilment dependency (FALL-37-2).
 *
 * `fallbacks.ts` exports the machine-readable chain — primary path → failure
 * condition → evidence that failure occurred → replacement options →
 * eligibility/authority → switching cost → time to switch → cash/capability
 * impact → verification that recovery worked — and the LOCATED / VALIDATED /
 * RESERVED distinction. This reads the one high-impact dependency production
 * already records for every commercial opening: who fulfils it. The
 * counterparty model (`labor/counterparties`, CP-31) names each opening's
 * primary fulfiller, its alternative and every other candidate, with the ladder
 * stage each has reached; that is turned into a `Dependency` and its chain, and
 * the chain is recorded on `bin_events` whenever it changes, so a person — or
 * the probe — reads it from a row.
 *
 * Nothing is invented. A ladder stage maps onto readiness (a listing or
 * willingness is LOCATED; shown capability or a quote is VALIDATED; a hold or a
 * contract is RESERVED), authority to switch is on record only where a hold was
 * granted, an ineligible candidate carries the model's own reasons, and every
 * figure no row states — probabilities, time to harm, switching cost, cash at
 * risk — is UNKNOWN (invariant 39). It switches nothing and writes no
 * counterparty row: it reads the existing owner and records what it read.
 */
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { unknownFigure } from './graph.ts';
import { chooseReplacement, fallbackChain, type Dependency, type FallbackChain, type Substitute, type SubstituteReadiness } from './fallbacks.ts';
import type { OpportunityCounterparties, ProjectCounterpartyReading } from '../labor/counterparties/operations.ts';
import type { CandidateReading } from '../labor/counterparties/compare.ts';

/** The event a fulfilment chain is recorded under. */
export const FALLBACK_CHAIN_EVENT = 'FALLBACK_CHAIN_READ';
/** The failure mode every fulfilment dependency carries: the primary does not perform. */
export const PRIMARY_DOES_NOT_PERFORM = 'primary-does-not-perform';

const RESERVED_STAGES: ReadonlySet<string> = new Set(['RESERVED', 'CONTRACTED', 'PERFORMED']);
const VALIDATED_STAGES: ReadonlySet<string> = new Set(['CAPABILITY', 'QUOTE']);

/** A ladder stage as fallback readiness: found, shown able, or held. Pure. */
export function readinessOfStage(stage: string | null): SubstituteReadiness {
  if (stage && RESERVED_STAGES.has(stage)) return 'RESERVED';
  if (stage && VALIDATED_STAGES.has(stage)) return 'VALIDATED';
  return 'LOCATED';
}

function substituteOf(opportunityId: string, candidate: CandidateReading): Substitute {
  const held = candidate.stage !== null && RESERVED_STAGES.has(candidate.stage);
  return {
    key: candidate.counterpartyId,
    label: candidate.counterpartyId,
    changes: ['PROVIDER'],
    readiness: readinessOfStage(candidate.stage),
    capacity: unknownFigure(`${candidate.counterpartyId} capacity for opportunity ${opportunityId}`, 'units'),
    failureProbability:
      candidate.reliability === null
        ? unknownFigure(`${candidate.counterpartyId} fails too`, 'probability')
        : unknownFigure(`${candidate.counterpartyId} fails too (reported reliability ${candidate.reliability})`, 'probability'),
    eligibility: {
      // A granted hold is the only authority to rely on this fulfiller the rows record.
      authorized: held ? true : null,
      meetsObligations: candidate.eligible ? true : candidate.reasons.length > 0 ? false : null,
      basis: candidate.reasons.length > 0 ? candidate.reasons.join('; ') : `ladder stage ${candidate.stage ?? 'none'}`,
    },
    switchingCost: null,
    timeToSwitchDays: null,
    overrides: {},
    recoveryVerification: `a PERFORMED report recorded on ${candidate.counterpartyId}'s hold for opportunity:${opportunityId}`,
  };
}

/**
 * One opening's fulfilment as a dependency: its primary fulfiller, every other
 * candidate the comparison read as a substitute, and the one failure mode a
 * fulfilment has. Null when the opening has no reading or no primary. Pure.
 */
export function fulfilmentDependency(opportunity: Pick<OpportunityCounterparties, 'opportunityId' | 'title' | 'transaction'>): Dependency | null {
  const reading = opportunity.transaction.reading;
  const primary = reading?.primary ?? null;
  if (!reading || !primary) return null;
  const seen = new Set<string>([primary.counterpartyId]);
  const others: CandidateReading[] = [];
  for (const one of [reading.alternative, ...reading.comparison.ranked, ...reading.comparison.ineligible]) {
    if (!one || seen.has(one.counterpartyId)) continue;
    seen.add(one.counterpartyId);
    others.push(one);
  }
  const id = opportunity.opportunityId;
  return {
    key: `fulfilment:${id}`,
    label: `Who fulfils ${opportunity.title}`,
    servesActivity: `opportunity:${id}`,
    primaryPath: `${primary.counterpartyId} fulfils it (ladder stage ${primary.stage ?? 'none'})`,
    primaryFailureProbability: unknownFigure(`${primary.counterpartyId} does not perform`, 'probability'),
    failureModes: [
      {
        key: PRIMARY_DOES_NOT_PERFORM,
        condition: `${primary.counterpartyId} does not perform ${opportunity.title}`,
        detectionSignals: [
          "the primary's hold passes its window with no PERFORMED report (the step reads UNKNOWN)",
          'a reservation event on the primary hold reports anything other than PERFORMED',
        ],
        failureEvidence: ['a recorded reservation event on the primary hold that is not a PERFORMED report'],
        timeToHarmDays: unknownFigure(`days until ${opportunity.title} is late`, 'days'),
        recoveryWindowDays: unknownFigure(`days a substitute can still deliver ${opportunity.title}`, 'days'),
        probability: unknownFigure(`${primary.counterpartyId} does not perform`, 'probability'),
      },
    ],
    substitutes: others.map((one) => substituteOf(id, one)),
    consequence: {
      cashAtRisk: unknownFigure(`cash at risk if ${opportunity.title} is not fulfilled`, 'cash'),
      obligations: [`deliver ${opportunity.title} to the buyer`],
      capability: null,
      tolerableLoss: unknownFigure(`loss tolerable on ${opportunity.title}`, 'cash'),
    },
  };
}

export interface FulfilmentChain {
  opportunityId: string;
  chain: FallbackChain;
  /** The substitute to switch to if the primary fails now, or null when none is eligible and validated or reserved. */
  replacement: string | null;
}

/** Every opening's fulfilment chain from one counterparty reading. Pure. */
export function fulfilmentChains(reading: Pick<ProjectCounterpartyReading, 'opportunities'>): FulfilmentChain[] {
  const out: FulfilmentChain[] = [];
  for (const opportunity of reading.opportunities) {
    const dependency = fulfilmentDependency(opportunity);
    if (!dependency) continue;
    out.push({
      opportunityId: opportunity.opportunityId,
      chain: fallbackChain(dependency, PRIMARY_DOES_NOT_PERFORM),
      replacement: chooseReplacement(dependency)?.key ?? null,
    });
  }
  return out;
}

function signatureOf(one: FulfilmentChain): string {
  return JSON.stringify([
    one.chain.primaryPath,
    one.replacement,
    one.chain.replacements.map((r) => [r.substitute, r.readiness, r.eligibility.eligible, r.eligibility.authorized, r.eligibility.meetsObligations]),
  ]);
}

/** The latest recorded chain of every fulfilment dependency of a project, by dependency key. */
export async function readFulfilmentChains(projectId: string): Promise<Map<string, FulfilmentChain & { signature: string; at: string }>> {
  const rows = await getDb().all<{ measures: string | null; at: string }>(
    `SELECT measures, at FROM bin_events WHERE event_type = ? AND project_id = ? ORDER BY at ASC, id ASC`,
    [FALLBACK_CHAIN_EVENT, projectId],
  );
  const latest = new Map<string, FulfilmentChain & { signature: string; at: string }>();
  for (const row of rows) {
    try {
      const one = (JSON.parse(row.measures ?? '{}') as { fallbackChain?: FulfilmentChain & { signature: string } }).fallbackChain;
      if (one?.chain?.dependency && typeof one.signature === 'string') latest.set(one.chain.dependency, { ...one, at: row.at });
    } catch {
      /* a row that does not parse is not a chain */
    }
  }
  return latest;
}

/**
 * Read every fulfilment dependency of a project from the counterparty model,
 * build its chain, and record each chain whose shape changed since the last
 * one recorded. Runs on the cash-knowledge refresh; returns what it read.
 */
export async function recordFulfilmentChains(
  projectId: string,
  deps: {
    read?: (projectId: string) => Promise<Pick<ProjectCounterpartyReading, 'opportunities'>>;
    record?: typeof recordBinEvent;
    held?: (projectId: string) => Promise<Map<string, { signature: string }>>;
  } = {},
): Promise<{ chains: FulfilmentChain[]; written: number }> {
  const read =
    deps.read ??
    (async (id: string) => {
      const { projectCounterparties } = await import('../labor/counterparties/operations.ts');
      return projectCounterparties(id);
    });
  const chains = fulfilmentChains(await read(projectId));
  if (chains.length === 0) return { chains, written: 0 };
  const held = await (deps.held ?? readFulfilmentChains)(projectId);
  let written = 0;
  for (const one of chains) {
    const signature = signatureOf(one);
    if (held.get(one.chain.dependency)?.signature === signature) continue;
    await (deps.record ?? recordBinEvent)({
      eventType: FALLBACK_CHAIN_EVENT,
      projectId,
      workloadClass: 'fallback-chain',
      outcome: one.replacement ? 'REPLACEMENT_READY' : 'NO_ELIGIBLE_REPLACEMENT',
      reason: `${one.chain.dependency}: ${one.chain.replacements.length} replacement option(s); ${one.replacement ? `switch to ${one.replacement}` : 'none eligible and validated or reserved'}`.slice(0, 480),
      evidenceClass: 'MEASURED',
      measures: { fallbackChain: { ...one, signature } },
    });
    written += 1;
  }
  return { chains, written };
}

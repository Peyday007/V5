/**
 * Producing the possibility space, deterministically.
 *
 * ---------------------------------------------------------------------------
 * The thing this is instead of
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation of "map the complete monetization possibility
 * space" is to ask a model for forty ways to make money from a discovery. That
 * would be forty plausible sentences, indistinguishable from forty researched
 * ones the moment they are rendered, each of them then ranked and put in front
 * of a person as work — §8's rule broken at the most expensive altitude in this
 * codebase.
 *
 * So the space is produced by applying the closed method table to what the
 * subject's own rows already say. A method declares which kinds of evidence it
 * is structurally applicable to; a discovery declares what kind of evidence it
 * is, in `opportunity_signal`, chosen by a worker that read the source. The
 * intersection is arithmetic. It reads no prose, forms no view, and claims
 * nothing beyond *this is a shape of transaction that could apply here* — which
 * is exactly what a possibility is, and exactly what the rest of the ledger
 * then spends its time establishing or refusing.
 *
 * ---------------------------------------------------------------------------
 * Less where less is known
 * ---------------------------------------------------------------------------
 *
 * A subject whose signal nothing recorded gets only the methods that need no
 * particular kind of opening. That is deny-by-default at an enumeration: a
 * signal of null means nobody said what kind of thing this is, and the
 * alternative — every method, because nothing ruled anything out — would
 * produce the largest possibility space for the discovery Brain understands
 * least.
 *
 * ---------------------------------------------------------------------------
 * What carries over from the subject, and what does not
 * ---------------------------------------------------------------------------
 *
 * One path per subject gets the subject's own established figures: the one
 * whose method is what the existing single-answer `mechanism` column actually
 * stood for. A published price for a transcription job is what *that* job pays;
 * it is not what a referral fee on it pays, or what a subscription about that
 * market pays, and writing it onto all of them would be the collapse this
 * ledger exists to undo, wearing a number.
 *
 * Those carried figures are recorded as `RECOMMENDATION`, never as evidence.
 * They rest on a column rather than on a claim, they carry their basis, their
 * assumption and what would change them, and `mayReplace` lets researched
 * evidence overwrite them the moment any arrives.
 */
import { METHOD, MONETIZATION_METHODS } from '../../../domain/monetization.ts';
import { listOpportunities, opportunityForClaim } from '../../../repos/cashPortfolio.ts';
import { claimedMethods } from '../../../repos/research.ts';
import { recordCashEvent } from '../../../repos/cashMode.ts';
import { mayReplace } from '../../../repos/cashCardFacts.ts';
import {
  listPaths,
  pathFactsForProject,
  recordPath,
  recordPathFact,
  setSourceClaim,
} from '../../../repos/monetization.ts';
import type {
  CashMechanism,
  CashOpportunity,
  MonetizationMethod,
  MonetizationPath,
  MonetizationPathFact,
  OpportunitySignal,
} from '../../../domain/types.ts';

/** Brain acting on its own account, never a person and never a worker. */
const BRAIN = 'BRAIN';

/**
 * What the single `mechanism` column actually meant, per value.
 *
 * A lookup rather than a reading, in `opportunitySignals.ts`' shape and for its
 * reason. It is used for one thing only: deciding which of the enumerated paths
 * inherits the subject's own recorded price, exposure and hours. Getting it
 * wrong costs one proposal that research then overwrites; deriving it from the
 * title would be the prose-parsing §25 records the cost of.
 */
const PRIMARY_METHOD: Readonly<Record<CashMechanism, MonetizationMethod>> = Object.freeze({
  EXISTING_BUYING_SIGNAL: 'DIRECT_SALE',
  DIAGNOSTIC_OPPORTUNITY: 'AUDIT_OR_ASSESSMENT',
  EXPLICIT_PAID_REQUEST: 'DIRECT_SALE',
  TEMPORARY_EXPLOIT: 'ARBITRAGE',
  SUPPLY_DEMAND_MISMATCH: 'BROKERAGE',
  PAIN_TRIGGERED_IMPLEMENTATION: 'PRODUCTIZED_SERVICE',
  RESALE_OR_ASSET: 'RESALE',
  INFORMATION_ASYMMETRY: 'ARBITRAGE',
  PRODUCTIZED_SERVICE: 'PRODUCTIZED_SERVICE',
  CAPABILITY_ARBITRAGE: 'SUBCONTRACTED_FULFILMENT',
  SUBCONTRACTED_FULFILMENT: 'SUBCONTRACTED_FULFILMENT',
  JIGSAW_COMBINATION: 'MANAGED_SERVICE',
  OTHER: 'DIRECT_SALE',
});

/**
 * Which shapes of transaction could apply to a subject of this kind.
 *
 * Pure over the method table and one signal, so the space a discovery has is a
 * property of what was recorded about it rather than of when it was asked.
 */
export function applicableMethods(signal: OpportunitySignal | null): MonetizationMethod[] {
  return MONETIZATION_METHODS.filter((method) => {
    const declaration = METHOD[method];
    if (declaration.appliesTo.length === 0) return true;
    return signal !== null && declaration.appliesTo.includes(signal);
  });
}

/** What a person reads, composed from the declaration and the subject's own title. */
export function titleFor(method: MonetizationMethod, subjectTitle: string): string {
  return `${METHOD[method].label} — ${subjectTitle}`;
}

export interface EnumerationReport {
  /** The paths actually added, by subject. Empty on a pass that changed nothing. */
  added: { opportunityId: string; pathIds: string[] }[];
  /** Figures carried from a subject onto the path its old column stood for. */
  carried: { pathId: string; attributes: string[] }[];
  /** Possibilities a source named that the table would not have produced. */
  evidenced: string[];
}

/**
 * Give every live discovery its complete possibility space.
 *
 * Idempotent by the unique index rather than by a flag, which is what makes it
 * safe on a tick that dies halfway and safe on two instances at once: the
 * insert collides and the loser is told it lost. A pass over an unchanged
 * project writes nothing at all and records no event, so the activity feed says
 * what happened rather than that a tick ran.
 *
 * Archived and declined discoveries are skipped. Their existing paths stay
 * exactly where they are and read as archived through the subject, because
 * nothing here deletes anything — what is skipped is *adding* to a discovery
 * that is over.
 */
export async function enumeratePossibilities(projectId: string): Promise<EnumerationReport> {
  const opportunities = await listOpportunities({ projectId });
  const report: EnumerationReport = { added: [], carried: [], evidenced: [] };

  const factsByPath = new Map<string, MonetizationPathFact[]>();
  for (const fact of await pathFactsForProject(projectId)) {
    factsByPath.set(fact.pathId, [...(factsByPath.get(fact.pathId) ?? []), fact]);
  }

  /*
   * What is already there, read once.
   *
   * Without this the steady state is the expensive one: thirty discoveries at
   * twenty-five applicable methods each is 750 no-op inserts and 750 read-backs
   * **per tick**, for ever, to discover that nothing changed. The unique index
   * is still the arbiter — two ticks racing on a subject both reach
   * `recordPath` and one of them loses there, exactly as before — so this is a
   * cheaper way of asking the same question rather than a second answer to it.
   */
  const existing = new Map<string, MonetizationPath>();
  for (const path of await listPaths({ projectId })) {
    existing.set(`${path.opportunityId ?? '-'}|${path.method}`, path);
  }

  for (const opportunity of opportunities) {
    if (opportunity.state === 'ARCHIVED' || opportunity.state === 'DECLINED') continue;

    const added: string[] = [];
    const primary = PRIMARY_METHOD[opportunity.mechanism];

    for (const method of applicableMethods(opportunity.opportunitySignal)) {
      const known = existing.get(`${opportunity.id}|${method}`) ?? null;
      const { path, created } = known
        ? { path: known, created: false }
        : await recordPath({
            projectId,
            opportunityId: opportunity.id,
            method,
            title: titleFor(method, opportunity.title),
            origin: 'ENUMERATED',
          });
      if (created) added.push(path.id);

      if (method !== primary) continue;
      const carried = await carryFigures({
        projectId,
        pathId: path.id,
        opportunity,
        existing: factsByPath.get(path.id) ?? [],
      });
      if (carried.length > 0) report.carried.push({ pathId: path.id, attributes: carried });
    }

    if (added.length === 0) continue;
    report.added.push({ opportunityId: opportunity.id, pathIds: added });
    await recordCashEvent({
      projectId,
      opportunityId: opportunity.id,
      kind: 'MONETIZATION_PATHS_ENUMERATED',
      actorRef: BRAIN,
      summary:
        `${added.length} way${added.length === 1 ? '' : 's'} of monetizing this were added to ` +
        'the possibility ledger. None of them is a claim that it works; each is a shape of ' +
        'transaction that could apply, with its own questions still open.',
      detail: { pathIds: added, signal: opportunity.opportunitySignal },
    });
  }

  /*
   * And the ones a source named, after the table's own.
   *
   * After, because a declared method usually *is* one the table would have
   * produced, and finding that row rather than creating it is the right
   * outcome — the claim then strengthens the existing possibility instead of
   * forking the ledger into two entries for one shape of transaction.
   */
  report.evidenced = await promoteDeclaredMethods(projectId);

  return report;
}

/**
 * Carry the subject's own established figures onto the path its old column
 * stood for.
 *
 * The two figures the evidence card already holds as money: the price and the
 * peak funding. They are proposals here — the basis is the column, the
 * assumption is that this shape of transaction is the one the figure was
 * established for, and what would change it is research into this path in
 * particular.
 *
 * The hours are deliberately left out. `humanHours` is effort rather than a
 * money figure, `derivedEconomics` already refuses to price it at a rate nobody
 * set, and carrying it here would put a number on a path with no attribute to
 * hold it.
 *
 * `mayReplace` is asked before each write, from the one function that decides
 * the authority order for both fact tables. So a figure a person set and a
 * figure research established are both safe from this: a proposal never
 * replaces either.
 */
async function carryFigures(input: {
  projectId: string;
  pathId: string;
  opportunity: CashOpportunity;
  existing: readonly MonetizationPathFact[];
}): Promise<string[]> {
  const byAttribute = new Map(input.existing.map((one) => [one.attribute, one]));
  const written: string[] = [];

  const propose = async (
    attribute: 'expectedRevenue' | 'requiredCapital',
    cents: number | null,
    assumption: string,
  ): Promise<void> => {
    if (cents === null) return;
    if (!mayReplace(byAttribute.get(attribute) ?? null, 'RECOMMENDATION')) return;
    await recordPathFact({
      projectId: input.projectId,
      pathId: input.pathId,
      attribute,
      kind: 'RECOMMENDATION',
      value: `${input.opportunity.currency} ${(cents / 100).toFixed(2)}`,
      amountCents: cents,
      basis:
        'the figure already established on the discovery itself, which this is the shape of ' +
        'transaction that column stood for',
      assumptions: assumption,
      uncertainty:
        'Nothing has researched this figure for this way of being paid in particular. Anything ' +
        'that does replaces this.',
      decidedBy: BRAIN,
    });
    written.push(attribute);
  };

  await propose(
    'expectedRevenue',
    input.opportunity.priceCents,
    'that what this discovery was priced at is what this way of being paid would produce',
  );
  await propose(
    'requiredCapital',
    input.opportunity.peakFundingCents,
    'that the exposure established for this discovery is the exposure of this way of taking it',
  );

  return written;
}

/**
 * Possibilities a worker named that the table could not produce.
 *
 * §20's question — *given everything I now know, are there monetization paths I
 * could not see before?* — as a declaration rather than as prose. Brain
 * enumerates every shape of transaction that structurally applies to an opening
 * of a given kind; a worker that read the source may name one it did not, and
 * `research_claims.monetization_method` is where that arrives: one value from
 * the closed set, validated exactly on submission, refused whole if it is
 * outside it.
 *
 * **The subject is never guessed.** A method claim is admitted only where the
 * same claim also carried an `opportunity_signal`, so the thing it is a way of
 * monetizing is the opening that claim itself established — resolved through
 * `opportunityForClaim` rather than read out of a sentence. A declaration whose
 * claim produced no opening yet is left alone and picked up on a later pass;
 * one whose claim never produces an opening is never promoted, which is correct
 * rather than a gap.
 *
 * Idempotent by the same unique index everything else here uses: a path the
 * enumeration already produced under that method is found rather than forked,
 * and the claim strengthens it by being recorded as its source.
 */
export async function promoteDeclaredMethods(projectId: string): Promise<string[]> {
  const declared = await claimedMethods({ projectId, limit: 50 });
  const added: string[] = [];

  for (const entry of declared) {
    const opportunity = await opportunityForClaim(projectId, entry.claim.id);
    if (!opportunity) continue;
    if (opportunity.state === 'ARCHIVED' || opportunity.state === 'DECLINED') continue;

    const { path, created } = await recordPath({
      projectId,
      opportunityId: opportunity.id,
      method: entry.claim.monetizationMethod!,
      title: titleFor(entry.claim.monetizationMethod!, opportunity.title),
      /*
       * The claim's own sentence as the thesis, clamped.
       *
       * It is the source's statement of how money would be made here, which is
       * exactly what a thesis is — and it resolves to a passage, because the
       * claim carries the URL, the publisher and the excerpt.
       */
      thesis: entry.claim.claim.slice(0, 400),
      origin: 'EVIDENCED',
      sourceClaimId: entry.claim.id,
    });
    if (!created) {
      /*
       * The table had already enumerated this shape of transaction, which is
       * the common case and the right outcome: one possibility per method per
       * discovery, found rather than forked. What the claim adds is the
       * passage — so it is recorded on the existing row, guarded on there being
       * none, and the origin stays `ENUMERATED` because that is how the row
       * actually came to exist.
       */
      await setSourceClaim(path.id, entry.claim.id);
      continue;
    }

    added.push(path.id);
    await recordCashEvent({
      projectId,
      opportunityId: opportunity.id,
      kind: 'MONETIZATION_PATH_EVIDENCED',
      actorRef: BRAIN,
      summary:
        `A source named a way of being paid here that the method table would not have ` +
        `produced: ${METHOD[entry.claim.monetizationMethod!].label}.`,
      detail: { pathId: path.id, claimId: entry.claim.id },
    });
  }

  return added;
}

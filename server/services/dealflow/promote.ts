/**
 * Where a deal stops being research and becomes work somebody pursues.
 *
 * ---------------------------------------------------------------------------
 * Pursuit is Cash Mode's, and there is no second lifecycle here
 * ---------------------------------------------------------------------------
 *
 * The brief is explicit: do not create redundant registries, schedulers,
 * evidence stores or lifecycle engines. Cash Mode already owns execution — the
 * standing commercial authority that says what may be spent, the recorded
 * `cash_actions` row that is the only evidence an action happened, the money
 * ledger, the jobs, the needs. A second set of those in this kernel would be a
 * second security model, and §27's rule holds: the weaker of the two is always
 * the one that wins.
 *
 * So a deal that reaches `OUTREACH_READY` is **promoted** into a
 * `cash_opportunities` row, and everything after that is machinery that
 * already exists. The deal keeps its own rows and its own reading; what it
 * gains is a pointer.
 *
 * ---------------------------------------------------------------------------
 * The card is filled from rows, and only from rows
 * ---------------------------------------------------------------------------
 *
 * Every field written here resolves to a claim that cleared the gate: the
 * payer is the buyer's own row, the price is a published cost line, the
 * buying signal is the claim that established the need. Nothing is composed
 * from a model's prose, and nothing is left to be filled in later by a
 * sentence somebody typed.
 *
 * The one field deliberately **not** written is `price_cents`. A cash card's
 * price means *what we are paid*, and what we are paid is the commission or
 * fee under a structure a person has not yet chosen — so writing the landed
 * cost or the transaction value there would put the largest number in the deal
 * in the field that decides what Brain thinks we earn. That is §13's whole
 * distinction, at the one column where collapsing it would be invisible.
 *
 * ---------------------------------------------------------------------------
 * Promoting is a compare-and-swap
 * ---------------------------------------------------------------------------
 *
 * Two ticks may both read a deal as ready. `linkOpportunity` is guarded on the
 * column still being null, so exactly one wins and the loser is an ordinary
 * outcome — and the opportunity the loser created is retired rather than left
 * as a second piece of work for one deal.
 */
import { createOpportunity, updateOpportunity } from '../../repos/cashPortfolio.ts';
import { archiveOpportunity } from '../cash/opportunities.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import { linkOpportunity } from '../../repos/dealflow.ts';
import { describeCapital } from './structures.ts';
import type { DealReading } from './maturity.ts';
import type { CashOpportunity } from '../../domain/types.ts';

const PROMOTED = 'DEALFLOW_DEAL_PROMOTED';

export interface Promotion {
  dealId: string;
  opportunityId: string;
  title: string;
}

/**
 * Promote every deal that has reached `OUTREACH_READY` and holds no
 * opportunity yet.
 *
 * Derived from the readings on the tick rather than hooked to the moment a
 * deal became ready — the fourth time this repository has needed that
 * distinction. A hook fixes one entrance; a derivation reaches every entrance
 * plus everything already stranded, survives a tick that died halfway, and
 * cannot be missed by a code path that forgot to call something.
 */
export async function promoteReadyDeals(input: {
  projectId: string;
  readings: readonly DealReading[];
}): Promise<Promotion[]> {
  const mode = await getCashMode(input.projectId);
  if (!mode) return [];

  const out: Promotion[] = [];
  for (const reading of input.readings) {
    if (reading.stage !== 'OUTREACH_READY') continue;
    if (reading.deal.opportunityId) continue;

    const title = `${reading.deal.equipmentClass} for ${reading.buyer.name}`;
    const opportunity = await createOpportunity({
      projectId: input.projectId,
      cashModeId: mode.id,
      ownerUserId: mode.ownerUserId,
      title,
      /*
       * A cross-border equipment deal is a published demand and a published
       * available supply that are not connected to each other, which is
       * exactly what `SUPPLY_DEMAND_MISMATCH` names. Choosing the mechanism
       * from the shape of the thing rather than from a worker's prose is the
       * same discipline `mechanismForSignal` already applies.
       */
      mechanism: 'SUPPLY_DEMAND_MISMATCH',
      currency: mode.currency,
      industry: reading.deal.equipmentClass,
      source: reading.supplier.name,
      sourceClaimId: reading.buyer.sourceClaimId,
      opportunitySignal: 'SUPPLY_DEMAND_MISMATCH',
    });

    const won = await linkOpportunity({
      dealId: reading.deal.id,
      opportunityId: opportunity.id,
    });
    if (!won) {
      /*
       * Another tick got there first. Retire this one rather than leaving two
       * pieces of work for one deal — and archive rather than delete, because
       * §5 does not allow destroying a row and the reason is worth keeping.
       */
      await archiveOpportunity({
        opportunityId: opportunity.id,
        actorRef: 'BRAIN',
        reason:
          'A concurrent pass promoted the same deal first, so this duplicate was retired ' +
          'before anybody worked on it. It would be reopened only if that pointer were ' +
          'cleared, which nothing does.',
      });
      continue;
    }

    await fillFromReading(opportunity, reading);

    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: opportunity.id,
      kind: PROMOTED,
      actorRef: 'BRAIN',
      summary: `${title} reached outreach-ready and was promoted into the portfolio.`,
      detail: {
        dealId: reading.deal.id,
        buyerPartyId: reading.buyer.id,
        supplierPartyId: reading.supplier.id,
        equipmentClass: reading.deal.equipmentClass,
        destination: reading.destination,
        landedCents: reading.economics.landedCents,
        savingCents: reading.economics.savingCents,
        lightestCapitalClass: reading.path.lightestCapitalClass,
        because: reading.because,
      },
    });

    out.push({ dealId: reading.deal.id, opportunityId: opportunity.id, title });
  }
  return out;
}

/**
 * Fill the card from the deal's own rows.
 *
 * Every value here traces to a claim. `price_cents` is deliberately absent —
 * see the header: what we are paid is the fee under a structure nobody has
 * chosen yet, and the landed cost is the largest number in the deal.
 */
async function fillFromReading(
  opportunity: CashOpportunity,
  reading: DealReading,
): Promise<void> {
  const money = (cents: number | null): string =>
    cents === null
      ? 'unknown'
      : `${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${
          reading.economics.currency ?? ''
        }`.trim();

  const structures = reading.path.attested
    .map((one) => one.profile.structure)
    .slice(0, 4)
    .join(', ');

  await updateOpportunity(opportunity.id, {
    payer: `${reading.buyer.name}${reading.destination ? ` (${reading.destination})` : ''}`,
    reachable_channel: reading.buyer.decisionMaker,
    buying_signal: reading.buyer.note,
    signal_observed_at: null,
    offer_scope:
      `Source ${reading.deal.equipmentClass} from ${reading.supplier.name}` +
      `${reading.supplier.country ? ` (${reading.supplier.country})` : ''} and coordinate the ` +
      `transaction into ${reading.destination ?? 'the buyer’s market'}. ` +
      `The compliance envelope is established across all five layers` +
      `${
        reading.envelope.openRequirements > 0
          ? `, with ${reading.envelope.openRequirements} requirement${
              reading.envelope.openRequirements === 1 ? '' : 's'
            } the supplier must actually meet`
          : ''
      }.`,
    acceptance_condition:
      'The buyer accepts equipment that satisfies every established requirement in the ' +
      'compliance envelope, delivered to the agreed point at the agreed price.',
    delivery_method: structures || null,
    fulfillment_owner: reading.supplier.name,
    economics_note:
      `Landed cost ${money(reading.economics.landedCents)} against a buyer alternative of ` +
      `${money(reading.economics.buyerAlternativeCents)}, a saving of ` +
      `${money(reading.economics.savingCents)}. That is the *transaction*. What we are paid ` +
      'is the fee under whichever structure is chosen, which is a separate decision and a ' +
      'separate number — the lightest attested structure requires ' +
      `${describeCapital(reading.path.lightestCapitalClass)}.`,
    /*
     * The exposure a *person* would be committing, and it is the honest answer
     * rather than the landed cost. Under the lightest attested structure this
     * operation funds nothing, so nothing is written here — and an absent
     * exposure keeps the card off `readyToTest` until somebody has answered it
     * against the structure they actually intend to use.
     */
    peak_funding_cents: null,
    next_action:
      `Approach ${reading.buyer.decisionMaker ?? 'the buyer'} at ${reading.buyer.name} under a ` +
      'commercial structure a person has authorized. Nothing here authorizes contacting ' +
      'anybody: that is a recorded commercial action under the standing grant.',
  });
}

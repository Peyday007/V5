/**
 * What Brain may decide about somebody's money, and where it stops.
 *
 * §30 used to reserve the offer, the price, the acceptance condition and who
 * fulfils the work to the owner permanently, on the reasoning that a researched
 * answer to "what should we charge" is invented judgment wearing a citation.
 * That is true of a *citation* and wrong as a prohibition — reserving every
 * commercial judgment to a human makes an operator into a form somebody fills
 * in — so `proposeTerms` forms a view and `advanceWithinAuthority` acts on the
 * part of it a person has already authorized.
 *
 * Every test here is about a way that could become dishonest rather than about
 * the happy path:
 *
 *   * a number appearing that no source stated,
 *   * a range reported as a price,
 *   * a margin computed against an unknown cost, which fails in the direction
 *     that makes a piece look worth doing,
 *   * effort silently converted to money at a rate nobody set,
 *   * a recommendation rendered where a fact belongs,
 *   * and a run that says it contacted somebody.
 *
 * The last one is the one that costs real money, and it is why the capability
 * reading is asserted rather than assumed: no test in this repository contacts
 * a buyer, takes a payment or fires a live worker, and none of them says it has.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate, setLifecycle } from '../server/services/cash/lifecycle.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  COMMERCIAL_ACTIONS,
} from '../server/services/cash/authority.ts';
import { capture, fillCard } from '../server/services/cash/opportunities.ts';
import { applyProposal, proposeTerms } from '../server/services/cash/answers.ts';
import type { ProposedTerm } from '../server/services/cash/answers.ts';
import { advanceWithinAuthority } from '../server/services/cash/operate.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { readMoneyFigures } from '../server/services/cash/figures.ts';
import { cardFact, recordCardFact } from '../server/repos/cashCardFacts.ts';
import { getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { listCashEvents } from '../server/repos/cashMode.ts';
import { readCapability } from '../server/services/cash/capabilities.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `proposal-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  expect(
    (
      await activate({
        projectId,
        ownerUserId: userId,
        actorUserId: userId,
        objective: 'Maximize additional usable cash over the next few weeks.',
      })
    ).ok,
  ).toBe(true);
});

async function granted(): Promise<void> {
  await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
}

/** An opening with a published request on it, and nothing decided yet. */
async function opening(
  signal: string,
  over: Record<string, unknown> = {},
  currency = 'USD',
): Promise<CashOpportunity> {
  const captured = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title: 'A published intake repair request',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency,
  });
  if (!captured.ok) throw new Error(captured.reason);
  const filled = await fillCard({
    opportunityId: captured.value.id,
    actorRef: 'BRAIN',
    patch: {
      payer: 'The operations manager, who signs',
      reachableChannel: 'The address on the notice',
      buyingSignal: signal,
      signalObservedAt: '2026-09-15T09:00:00.000Z',
      ...over,
    },
  });
  if (!filled.ok) throw new Error(filled.reason);
  return (await getOpportunity(captured.value.id))!;
}

function term(terms: ProposedTerm[], field: string): ProposedTerm | undefined {
  return terms.find((one) => one.field === field);
}

// ---------------------------------------------------------------------------
// Reading a figure, rather than producing one
// ---------------------------------------------------------------------------

describe('a money figure is read from a source', () => {
  it('reads a figure the text actually marks with this currency', () => {
    expect(readMoneyFigures('Budget is $1,200 for the work.', 'USD')).toEqual([
      { cents: 120_000, currency: 'USD', text: '$1,200' },
    ]);
    expect(readMoneyFigures('We pay 1,200 USD on delivery.', 'USD')[0]?.cents).toBe(120_000);
    expect(readMoneyFigures('Fee: USD 950.50', 'USD')[0]?.cents).toBe(95_050);
  });

  it('reads the other convention for separators, because both are written', () => {
    expect(readMoneyFigures('Der Preis betragt €1.234,56.', 'EUR')[0]?.cents).toBe(123_456);
  });

  it('refuses a bare number, because nothing says what it is denominated in', () => {
    // Reading the sprint's currency into it would be the unknown read as a
    // favourable assumption, one column along.
    expect(readMoneyFigures('Budget is 1,200 for the work.', 'USD')).toEqual([]);
  });

  it('refuses a figure marked in a currency this sprint is not in', () => {
    expect(readMoneyFigures('Budget is €1,200.', 'USD')).toEqual([]);
  });

  it('refuses shorthand, because 1.2k is 1,200 to a reader and 1.2 to a parser', () => {
    expect(readMoneyFigures('Around $1.2k.', 'USD')).toEqual([]);
    // These two are the ones the shorthand guard is actually for: the digits
    // parse cleanly on their own, so without it `$1,200k` would be read as
    // USD 1,200.00 — a thousandfold error reported as a figure somebody
    // published. `$1.2k` is refused one step earlier, by the separator rule.
    expect(readMoneyFigures('Around $1,200k.', 'USD')).toEqual([]);
    expect(readMoneyFigures('About $3m in total.', 'USD')).toEqual([]);
  });

  it('refuses a percentage, whatever currency stands beside it', () => {
    expect(readMoneyFigures('A USD 15% retainer applies.', 'USD')).toEqual([]);
  });

  it('does not read USD out of USDT', () => {
    expect(readMoneyFigures('Paid in 1,200 USDT.', 'USD')).toEqual([]);
  });

  it('counts one figure quoted twice as one figure, and orders what it finds', () => {
    const read = readMoneyFigures('Between $2,500 and $900. Again: $2,500.', 'USD');
    expect(read.map((one) => one.cents)).toEqual([90_000, 250_000]);
  });
});

// ---------------------------------------------------------------------------
// The proposal
// ---------------------------------------------------------------------------

describe('Brain proposes terms', () => {
  it('scopes the offer and states its edges, because an unstated edge is what gets argued about', async () => {
    const piece = await opening('Wanted: intake form repaired and tested.');
    const { terms } = await proposeTerms(piece);
    const offer = term(terms, 'offer')!;
    expect(offer.value).toContain('Wanted: intake form repaired and tested.');
    expect(offer.value).toContain('Not included');
    expect(offer.value).toContain('anything the request does not name');
    // All three, every time: a recommendation with no stated uncertainty is a
    // guess wearing a citation.
    expect(offer.basis.length).toBeGreaterThan(0);
    expect(offer.assumptions.length).toBeGreaterThan(0);
    expect(offer.uncertainty.length).toBeGreaterThan(0);
  });

  it('withholds a price when no source states one, and says what would settle it', async () => {
    const piece = await opening('Wanted: intake form repaired and tested.');
    const proposal = await proposeTerms(piece);
    expect(term(proposal.terms, 'price')).toBeUndefined();
    const withheld = proposal.withheld.find((one) => one.field === 'price')!;
    expect(withheld.because).toContain('USD');
    expect(withheld.because).toContain('research the published rate');
  });

  it('quotes a single published figure as published', async () => {
    const piece = await opening('Wanted: intake form repaired. Budget $1,200.');
    const price = term((await proposeTerms(piece)).terms, 'price')!;
    expect(price.cents).toBe(120_000);
    expect(price.value).toContain('as published');
    expect(price.uncertainty).toContain('ceiling');
  });

  it('takes the low end of a range and says why, rather than the number it could least defend', async () => {
    const piece = await opening('Similar jobs have gone for $900 to $2,500 this year.');
    const price = term((await proposeTerms(piece)).terms, 'price')!;
    expect(price.cents).toBe(90_000);
    expect(price.value).toContain('low end');
    expect(price.value).toContain('USD 2,500.00');
    expect(price.value).toContain('least defend');
  });

  it('withholds the margin when the cost is unknown, naming which half is missing', async () => {
    const piece = await opening('Wanted: intake repair. Budget $1,200.');
    const proposal = await proposeTerms(piece);
    expect(term(proposal.terms, 'economics')).toBeUndefined();
    const withheld = proposal.withheld.find((one) => one.field === 'economics')!;
    // The direction matters: a margin against an unknown cost makes a piece
    // look worth doing.
    expect(withheld.because).toContain('bounded exposure');
    expect(withheld.because).toContain('worth doing');
  });

  it('withholds the margin when no price exists, rather than computing against nothing', async () => {
    const piece = await opening('Wanted: intake repair.', { peakFundingCents: 5_000 });
    const withheld = (await proposeTerms(piece)).withheld.find((one) => one.field === 'economics')!;
    expect(withheld.because).toContain('needs a price');
  });

  it('reports unpriced effort beside the margin instead of costing it at a rate nobody set', async () => {
    const piece = await opening('Wanted: intake repair. Budget $1,200.', {
      peakFundingCents: 20_000,
      humanHours: 6,
    });
    const economics = term((await proposeTerms(piece)).terms, 'economics')!;
    expect(economics.cents).toBeUndefined();
    expect(economics.value).toContain('USD 1,000.00 expected');
    expect(economics.value).toContain('6 hours of effort this does not price');
    expect(economics.uncertainty).toContain('nobody has set a rate');
  });

  it('calls a negative margin a reason to decline, not a reason to raise the price', async () => {
    const piece = await opening('Wanted: intake repair. Budget $1,200.', {
      peakFundingCents: 300_000,
    });
    const economics = term((await proposeTerms(piece)).terms, 'economics')!;
    expect(economics.uncertainty).toContain('reason to decline');
  });

  it('states cash timing from the terms, and withholds it when nothing says when', async () => {
    const withTerms = await opening('Wanted: intake repair.', {
      paymentTerms: 'Net 14 from invoice',
    });
    expect(term((await proposeTerms(withTerms)).terms, 'cashDates')!.value).toContain('Net 14');

    const bare = await opening('Wanted: intake repair.');
    const withheld = (await proposeTerms(bare)).withheld.find((one) => one.field === 'cashDates')!;
    expect(withheld.because).toContain('when the money would arrive');
  });

  it('proposes nothing at all with no buying evidence to build on', async () => {
    const piece = await opening('placeholder');
    await updateOpportunity(piece.id, { buying_signal: null } as never);
    const proposal = await proposeTerms((await getOpportunity(piece.id))!);
    expect(proposal.terms).toEqual([]);
    expect(proposal.withheld.map((one) => one.field)).toEqual(['offer']);
  });
});

// ---------------------------------------------------------------------------
// Writing it down
// ---------------------------------------------------------------------------

describe('a proposal reaches the card as a proposal', () => {
  it('puts the figure in the column and the sentence on the record', async () => {
    const piece = await opening('Wanted: intake repair. Budget $1,200.');
    const proposal = await proposeTerms(piece);
    expect(await applyProposal({ opportunity: piece, proposal })).toContain('price');

    // The integer column, not the sentence: a recommendation that reads well
    // and leaves the column blank is a card that still is not ready.
    expect((await getOpportunity(piece.id))!.priceCents).toBe(120_000);
    const fact = (await cardFact(piece.id, 'price'))!;
    expect(fact.kind).toBe('RECOMMENDATION');
    expect(fact.decidedBy).toBe('BRAIN');
    expect(fact.value).toContain('USD 1,200.00');
  });

  it('never writes the cash-timing sentence back over the date it was derived from', async () => {
    const piece = await opening('Wanted: intake repair.', { deadline: '2026-10-01' });
    const proposal = await proposeTerms(piece);
    await applyProposal({ opportunity: piece, proposal });
    // Otherwise the next pass derives from its own output.
    expect((await getOpportunity(piece.id))!.deadline).toBe('2026-10-01');
    expect((await cardFact(piece.id, 'cashDates'))!.value).toContain('2026-10-01');
  });

  it('leaves a person’s own answer exactly alone', async () => {
    const piece = await opening('Wanted: intake repair. Budget $1,200.');
    await recordCardFact({
      projectId,
      opportunityId: piece.id,
      field: 'price',
      kind: 'PERSON',
      value: 'USD 3,000.00 — what we charge for this',
      decidedBy: userId,
    });
    await updateOpportunity(piece.id, { price_cents: 300_000 } as never);

    const proposal = await proposeTerms((await getOpportunity(piece.id))!);
    expect(await applyProposal({ opportunity: piece, proposal })).not.toContain('price');
    expect((await getOpportunity(piece.id))!.priceCents).toBe(300_000);
    expect((await cardFact(piece.id, 'price'))!.kind).toBe('PERSON');
  });
});

// ---------------------------------------------------------------------------
// Acting on it, inside the limits somebody set
// ---------------------------------------------------------------------------

describe('Brain acts inside the standing authority', () => {
  /** A card complete enough for the readiness gate to pass. */
  async function readyToTest(): Promise<CashOpportunity> {
    const piece = await opening('Wanted: intake repair. Budget $1,200.', {
      peakFundingCents: 0,
    });
    const proposal = await proposeTerms(piece);
    await applyProposal({ opportunity: piece, proposal });
    /*
     * And the rest of the execution thesis.
     *
     * `markReady` asks for more than the short card now — whether we are
     * eligible, how the work actually gets done, whether calling is required,
     * what it costs and when the money arrives — because a piece can answer
     * every readiness field and still have nothing saying any of that. The
     * gate `advanceWithinAuthority` presses is unchanged: what changed is what
     * the gate checks, and this fixture answers it.
     */
    for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
      await recordCardFact({
        projectId,
        opportunityId: piece.id,
        field,
        kind: 'EVIDENCE',
        value: `A published answer to ${field}.`,
        claimId: `clm_${field}`,
        decidedBy: 'BRAIN',
      });
    }
    return (await getOpportunity(piece.id))!;
  }

  it('declares a complete card ready to test, and the record says Brain did', async () => {
    await granted();
    const piece = await readyToTest();
    const advanced = await advanceWithinAuthority(projectId);

    expect(advanced.took).toContainEqual(
      expect.objectContaining({ opportunityId: piece.id, did: 'MARKED_READY' }),
    );
    expect((await getOpportunity(piece.id))!.state).toBe('READY');
    const event = (await listCashEvents(projectId, 200)).find(
      (one) => one.kind === 'CASH_OPPORTUNITY_READY' && one.opportunityId === piece.id,
    )!;
    expect(event.actorRef).toBe('BRAIN');
  });

  it('leaves an incomplete card alone rather than reporting it as withheld every tick', async () => {
    await granted();
    const piece = await opening('Wanted: intake repair.');
    const advanced = await advanceWithinAuthority(projectId);
    expect(advanced.took).toEqual([]);
    expect(advanced.withheld.some((one) => one.opportunityId === piece.id)).toBe(false);
    expect((await getOpportunity(piece.id))!.state).toBe('DISCOVERED');
  });

  it('will not act at all without the grant, and says that is the decision it cannot take', async () => {
    const piece = await readyToTest();
    // The readiness half still happens: the card gate is what bounds it, and
    // that is not the person's spending decision.
    await advanceWithinAuthority(projectId);
    expect((await getOpportunity(piece.id))!.state).toBe('READY');

    const withheld = (await advanceWithinAuthority(projectId)).withheld.find(
      (one) => one.opportunityId === piece.id,
    )!;
    expect(withheld.because).toContain('no standing commercial authority');
    expect(withheld.because).toContain('nobody has been contacted');
  });

  it('stops at the missing integration, and never says it contacted anybody', async () => {
    await granted();
    const piece = await readyToTest();
    await advanceWithinAuthority(projectId);

    // Authorized, and still unable: this Brain has no messaging integration,
    // and the honest report of that is the whole point of the capability
    // register reading rows rather than declaring.
    expect((await readCapability('SEND_A_MESSAGE')).state).toBe('MISSING');
    const advanced = await advanceWithinAuthority(projectId);
    const withheld = advanced.withheld.find((one) => one.opportunityId === piece.id)!;
    expect(withheld.because).toContain('SEND_A_MESSAGE');
    expect(withheld.because).toContain('nobody has been contacted');

    // Withholding is not a state change, and nothing was recorded as done.
    expect((await getOpportunity(piece.id))!.state).toBe('READY');
    expect(advanced.took.some((one) => one.did === 'BEGAN_EXECUTION')).toBe(false);
  });

  it('does not start new work once the sprint is winding down', async () => {
    await granted();
    const piece = await readyToTest();
    expect((await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: 'Enough for this month.',
    })).ok).toBe(true);

    // The off switch ends new discovery and never a customer's obligation —
    // and this is the one thing in Cash Mode it also stops, because Brain
    // starting a new obligation after somebody said stop is not a person's
    // decision being carried out. They can still do it by hand.
    expect(await advanceWithinAuthority(projectId)).toEqual({ took: [], withheld: [] });
    expect((await getOpportunity(piece.id))!.state).toBe('DISCOVERED');

    // A skip, not a refusal: it resumes by itself.
    expect((await setLifecycle({
      projectId,
      to: 'ACTIVE',
      actorUserId: userId,
      reason: 'Back on.',
    })).ok).toBe(true);
    expect((await advanceWithinAuthority(projectId)).took).toContainEqual(
      expect.objectContaining({ opportunityId: piece.id, did: 'MARKED_READY' }),
    );
  });

  it('does nothing for a project with no sprint', async () => {
    const other = await freshProject();
    expect(await advanceWithinAuthority(other.project.id)).toEqual({ took: [], withheld: [] });
  });
});

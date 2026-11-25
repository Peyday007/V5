import { describe, expect, it } from 'vitest';
import { isNonPurchasePayment, paymentNatureOf } from '../server/domain/paymentNature.ts';
import { namesABuyerPopulation, subjectOf } from '../server/domain/industry.ts';

/** Audit of goal wst_7b4fcbb5f2384f31b6c3 (docs/audits/2026-11-23-10k-plan-audit.md). */
describe('payment nature: a price is what a buyer pays for a deliverable', () => {
  it('reads the bug-bounty reward that carried the $10K plan as a contingent reward, not a price', () => {
    // clm_5e038810b7a945728e2f, verbatim.
    expect(paymentNatureOf('GitHub Inc pays $10,000 per slot for a critical finding in its public bug bounty program.').nature).toBe('CONTINGENT_REWARD');
    expect(paymentNatureOf("As of July 27, 2026, GitHub's public bug bounty program pays fixed amounts: $250 for low-severity findings, $2,000 for medium, $5,000 high, and $10,000 for critical.").nature).toBe('CONTINGENT_REWARD');
    expect(paymentNatureOf('The company rewards researchers up to $30,000 for a valid critical vulnerability.').nature).toBe('CONTINGENT_REWARD');
    expect(paymentNatureOf('The hackathon awards $5,000 to the top team.').nature).toBe('CONTINGENT_REWARD');
    expect(paymentNatureOf('Prize money of $50,000 goes to the winner of the design competition.').nature).toBe('CONTINGENT_REWARD');
  });

  it('reads grants, rebates, reimbursements, settlements and wages as non-purchase payments', () => {
    expect(paymentNatureOf('The Farm Vitality Planning Grant reimburses up to $15,000 of planning costs.').nature).not.toBe('PURCHASE');
    expect(paymentNatureOf('The foundation provides a $25,000 grant to each selected nonprofit.').nature).toBe('GRANT');
    expect(paymentNatureOf('Homeowners receive a rebate of up to $1,500 for a heat pump.').nature).toBe('TRANSFER');
    expect(paymentNatureOf('The class action settlement of $2,000 per claimant was approved.').nature).toBe('TRANSFER');
    expect(paymentNatureOf('Warehouse associates earn an hourly wage of $19.').nature).toBe('EMPLOYMENT');
  });

  it('keeps real purchases as purchases, including those that mention a grant or a prize', () => {
    // clm_cbc36da6673c4b7581fc (NameExperts).
    expect(paymentNatureOf("flat-fee-plus-commission brokers charge 10-20% plus a service fee 'often $75-$500'").nature).toBe('PURCHASE');
    expect(paymentNatureOf('Grant writers charge $2,000 per application.').nature).toBe('PURCHASE');
    expect(paymentNatureOf('The Puzzle Society pays $500 for each accepted puzzle.').nature).toBe('PURCHASE');
    expect(paymentNatureOf('Dental practices pay $299 per month for the scheduling software subscription.').nature).toBe('PURCHASE');
    expect(paymentNatureOf('Agencies charge $1,200 to design a prize-draw landing page.').nature).toBe('PURCHASE');
    expect(paymentNatureOf('The state awarded a $480,000 contract for road resurfacing after a bid.').nature).toBe('PURCHASE');
    expect(isNonPurchasePayment(null)).toBe(false);
  });
});

describe('buyer population: a sentence about one company is one company', () => {
  it('reads the subject of the payer sentence that reached the industry map', () => {
    const node = 'GitHub Inc is the payer — its bug bounty page publishes rewards of $10,000 or more in its public program';
    expect(subjectOf(node)).toBe('GitHub Inc');
    expect(namesABuyerPopulation(node)).toBe(false);
    expect(namesABuyerPopulation('GitHub Inc is the payer its bug bounty page publishes rewards of $10 000 or more in its pu')).toBe(false);
  });

  it('keeps kinds of buyer that carry a description after them', () => {
    expect(namesABuyerPopulation('domain buyer or seller — what this buyer pays per unit of work')).toBe(true);
    expect(namesABuyerPopulation('small business operators — what this buyer pays per unit of work')).toBe(true);
    expect(namesABuyerPopulation('Dental practices')).toBe(true);
    expect(namesABuyerPopulation('Companies running bug bounty programs')).toBe(true);
  });
});

describe('a revenue goal leaves non-commercial payouts out unless it asks for them', () => {
  const bounty = "GitHub's own bug bounty program page states the program pays researchers $10,000 for a valid critical vulnerability via HackerOne.";
  const revenueGoal = 'Collect 10000 dollars of settled cash within 30 days using little up-front capital';
  it('excludes a bounty, a prize and a grant from a revenue goal', async () => {
    const { nonCommercialExclusion } = await import('../server/domain/paymentNature.ts');
    expect(nonCommercialExclusion(bounty, revenueGoal)).toMatch(/not a sale/);
    expect(nonCommercialExclusion('Design competition: prize money of $20,000 for the winning entry', revenueGoal)).toMatch(/not a sale/);
    expect(nonCommercialExclusion('The foundation offers a $25,000 grant to small nonprofits', revenueGoal)).toMatch(/not a sale/);
  });
  it('keeps a sale, and keeps a payout the goal asks for by name', async () => {
    const { nonCommercialExclusion } = await import('../server/domain/paymentNature.ts');
    expect(nonCommercialExclusion('Dental practices pay $299 a month for appointment-reminder software', revenueGoal)).toBeNull();
    expect(nonCommercialExclusion('Sweepstakes rules review for consumer brands', revenueGoal)).toBeNull();
    expect(nonCommercialExclusion(bounty, 'Earn $10,000 from bug bounties this quarter')).toBeNull();
    expect(nonCommercialExclusion('The foundation offers a $25,000 grant to small nonprofits', 'Win $50,000 in grant funding for the nonprofit')).toBeNull();
  });
});

describe('a legitimate purchase beside a reward program stays a purchase', () => {
  it('reads a bug-bounty platform subscription as what the programs buy', () => {
    expect(paymentNatureOf('Companies running bug bounty programs pay HackerOne $20,000 a year.').nature).toBe('PURCHASE');
    expect(paymentNatureOf('Contest organizers pay judging platforms $1,500 per event.').nature).toBe('PURCHASE');
  });
});

describe('a bounty platform paying per finding is a reward', () => {
  it('reads a per-report payout on a bounty platform as a contingent reward', () => {
    expect(paymentNatureOf('The huntr bounty platform pays security researchers $500 for each valid vulnerability report in an open-source project.').nature).toBe('CONTINGENT_REWARD');
  });
});

describe('a fee for preparing a grant is a purchase', () => {
  it('reads payment per grant application prepared as a purchase', () => {
    expect(paymentNatureOf('The Pennsylvania Department of Agriculture pays $2,500 per farm grant application prepared.').nature).toBe('PURCHASE');
    expect(paymentNatureOf('The foundation provides a $25,000 grant to each selected nonprofit.').nature).toBe('GRANT');
  });
});

describe('price evidence must be about these buyers or this deliverable', () => {
  it('refuses an HVAC-software price as a trucking workbook price, and keeps on-topic and bare figures', async () => {
    const { evidenceIsAbout } = await import('../server/domain/paymentNature.ts');
    expect(evidenceIsAbout('Software Advice analyzed data from HVAC contractors: field-service management software for HVAC businesses costs $1,200 a year per technician seat.', 'Regional trucking fleet managers; preventive-maintenance scheduling workbook')).toBe(false);
    expect(evidenceIsAbout('Comparable allergen meal-plan workbooks sell for $29 on the marketplace.', 'Allergen-labelled weekly meal-plan workbook')).toBe(true);
    expect(evidenceIsAbout('$250', 'anything')).toBe(true);
  });
  it('reads prizes, settlement payouts and filing fees correctly', () => {
    expect(paymentNatureOf('The challenge awards a $50,000 first prize to the single best-scoring entry.').nature).toBe('CONTINGENT_REWARD');
    expect(paymentNatureOf('The settlement administrator pays each eligible claimant about $1,200.').nature).toBe('TRANSFER');
    expect(paymentNatureOf('Rebate-filing services charge installers $45 for each rebate application filed.').nature).toBe('PURCHASE');
  });
});

describe('worded price evidence must show a buyer paying a supplier', () => {
  it('refuses purses, funding, giveaways, claim payouts and royalties, and keeps fees, contracts and per-unit payments', async () => {
    const { evidencesPurchase } = await import('../server/domain/paymentNature.ts');
    for (const t of [
      'The dairy cooperative challenge will award a single purse of $15,000 to the team the judging panel ranks first.',
      'The arts council provides $6,000 in project funding to each muralist selected.',
      'One entrant drawn at random wins $3,000 in store credit; no purchase necessary.',
      'Insurers paid vehicle owners an average of $4,600 per approved hail-damage claim.',
      'The society distributed an average of $1,800 in annual performance royalties to each composer.',
    ]) expect(evidencesPurchase(t)).toBe(false);
    for (const t of [
      'Small accounting firms pay contingency recruiters a placement fee of $3,500 per bookkeeper hired.',
      'The port authority awarded an $18,000 contract for records digitisation, payable net 30.',
      'Homeowners pay $250 per energy audit report.',
      '$250',
    ]) expect(evidencesPurchase(t)).toBe(true);
  });
});

describe('production buyer-name fragments are not populations (Surge B report, 2026-11-23)', () => {
  it('refuses the stored fragments', () => {
    for (const n of ['GitHub Inc operates the bug bounty program and', 'The GitHub Bug Bounty Program Overhaul does not specify who actually pays for it', "GitHub's bug bounty program will restructure on July 27 2026 with lower public payouts and"]) expect(namesABuyerPopulation(n)).toBe(false);
    expect(namesABuyerPopulation('GitHub Sponsors maintainers')).toBe(true);
  });
});

describe('structural reading of payments and buyers (holdout, 2026-11-23)', () => {
  it('reads denial of exchange, receipt by the selected and compensation as non-purchases, and supplier price documents as purchases', async () => {
    const { evidencesPurchase } = await import('../server/domain/paymentNature.ts');
    expect(evidencesPurchase("Presenters chosen by the committee receive a $1,500 recognition honorarium; sessions are not commissioned or purchased.")).toBe(false);
    expect(evidencesPurchase('The foundation sends a $5,000 matching contribution; no goods or services are exchanged.')).toBe(false);
    expect(evidencesPurchase('The defendant shall pay $2,400 in restitution to each affected merchant.')).toBe(false);
    expect(evidencesPurchase('Admitted students receive $3,000 per term in tuition support.')).toBe(false);
    expect(evidencesPurchase('Promotion-compliance firm fee schedule: brands pay $800 per sweepstakes rules review.')).toBe(true);
    expect(evidencesPurchase('Editing-service price list: students pay $120 per scholarship essay edited.')).toBe(true);
    expect(evidencesPurchase('Claims-documentation vendor rate card: contractors pay $300 per claim packet.')).toBe(true);
  });
  it("reads an opening's singular organisation payer as one body", async () => {
    const { describesOneBody } = await import('../server/domain/industry.ts');
    expect(describesOneBody('City of Ridgeport public-works department')).toBe(true);
    expect(describesOneBody('Regional community foundation')).toBe(true);
    expect(describesOneBody('Licensed local moving companies')).toBe(false);
  });
});

describe('funding programmes and paying-out payers stay out of revenue goals (fresh-plan audit, 2026-11-24)', () => {
  const goal = 'Collect 10000 dollars of settled cash within 30 days using little up-front capital';
  it('reads production payers that pay out, and keeps a fee for preparing a grant application', async () => {
    const { nonCommercialExclusion, payerPaysOut } = await import('../server/domain/paymentNature.ts');
    expect(payerPaysOut('GitHub, Inc. operates the bug bounty program and pays rewards to researchers')).toBe(true);
    expect(nonCommercialExclusion('Pennsylvania: the Farm Vitality Planning Grant reimburses the cost of business planning', goal)).toMatch(/not a sale/);
    expect(nonCommercialExclusion('Market: US federal grants (NEH cooperative agreements), not a buyer', goal)).toMatch(/not a sale/);
    expect(nonCommercialExclusion('Farm grant application preparation. The PA Department of Agriculture pays $2,500 per farm grant application prepared.', goal)).toBeNull();
    expect(nonCommercialExclusion('Market: US federal grants (NEH cooperative agreements)', 'Win $50,000 of federal grant funding for the museum')).toBeNull();
    expect(payerPaysOut('Dental practices')).toBe(false);
  });
});

describe('a funder word that names a trade is the trade (planner residuals, 2026-11-25)', () => {
  it('reads foundation-repair contractors as buyers paying for a deliverable, and a foundation as a funder', async () => {
    const { readPriceEvidence } = await import('../server/domain/paymentNature.ts');
    const offer = { title: 'Exclusive homeowner leads', offerScope: 'Exclusive homeowner leads' };
    expect(readPriceEvidence('$1500 a month', { ...offer, payer: 'Roofers and foundation-repair contractors' }).counts).toBe(true);
    expect(readPriceEvidence('$1500 a month', { ...offer, payer: 'Foundation repair contractors' }).counts).toBe(true);
    expect(readPriceEvidence('$1500 a month', { ...offer, payer: 'The Kresge Foundation' })).toMatchObject({ direction: 'PAYOUT', counts: false });
  });
});

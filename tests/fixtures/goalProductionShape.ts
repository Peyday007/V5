/**
 * A goal of production's shape, seeded through the repositories (Surge B speed,
 * 2026-11-15). The live $10K goal's plan read took ~25 minutes after Deploy
 * 1070; its trace (revision 7a8b565) read 979 frontier openings, 418 live, ~80
 * modelled, 404 constructed arrangements out of ~1,300 candidates, and a map of
 * 52 sectors with 11 buyer populations. This seeds the same counts.
 *
 * Deterministic: names and figures come from the index, never from a clock or
 * a random draw, so two seedings read the same plan.
 */
import { getDb } from '../../server/db/database.ts';
import { createOpportunity, updateOpportunity } from '../../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../../server/repos/cashCardFacts.ts';
import { createNode } from '../../server/repos/industry.ts';
import { CAPTURE_KEY } from '../../server/services/cash/tier.ts';

export interface ProductionShape {
  /** Openings Brain filed and later archived or declined. */
  archived: number;
  /** Live openings with only a signal: no payer anybody showed would pay. */
  signals: number;
  /** Live, qualified, repeatable plays the model reads. */
  plays: number;
  /** Sectors with a buyer population, a bottleneck and a supplier each. */
  populated: number;
  /** Sectors the map holds without a buyer population. */
  bare: number;
  /** Bottlenecks and suppliers per populated sector. */
  partsPerSector: number;
}

export const PRODUCTION_SHAPE: ProductionShape = { archived: 561, signals: 338, plays: 80, populated: 11, bare: 41, partsPerSector: 2 };

const INDUSTRIES = ['property management', 'dental', 'veterinary', 'logistics', 'legal', 'accounting', 'construction', 'hospitality', 'retail', 'education'];
const PAYERS = ['Property managers', 'Dental practices', 'Veterinary clinics', 'Freight brokers', 'Law firms', 'Bookkeepers', 'General contractors', 'Boutique hotels', 'Independent retailers', 'Tutoring centers', 'Insurance agencies', 'Real estate agents', 'Marketing agencies', 'Recruiters', 'Event planners', 'Wedding venues', 'Fitness studios', 'Home inspectors', 'Mortgage brokers', 'Coffee roasters'];

export async function seedProductionShape(input: { projectId: string; cashModeId: string; ownerUserId: string; now: Date; shape?: ProductionShape }): Promise<void> {
  const { projectId, cashModeId, ownerUserId, now } = input;
  const shape = input.shape ?? PRODUCTION_SHAPE;
  const day = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
  const base = (i: number, title: string) => ({
    projectId,
    cashModeId,
    ownerUserId,
    title,
    mechanism: 'PRODUCTIZED_SERVICE' as const,
    currency: 'USD',
    sourceClaimId: `clm_shape_${i}`,
    opportunitySignal: 'RECURRING_OUTSOURCED_WORK' as const,
    source: 'A publisher',
    requiredCapabilities: ['PRODUCE_SPREADSHEET'],
  });
  let i = 0;
  for (let k = 0; k < shape.plays; k++, i++) {
    const payer = PAYERS[k % PAYERS.length]!;
    const industry = INDUSTRIES[k % INDUSTRIES.length]!;
    const o = await createOpportunity(base(i, `Monthly ${industry} report ${k}`));
    const fact = (field: string, value: string) => recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
    await fact(CAPTURE_KEY, 'Sell the work to each buyer.');
    await fact('payer', payer);
    await fact('delivery', 'Brain produces it.');
    const price = 4_000 + ((k * 7919) % 46_000);
    await updateOpportunity(o.id, {
      payer,
      industry,
      price_cents: price,
      offer_scope: `One ${industry} report`,
      reachable_channel: 'Published business email addresses',
      buying_signal: 'Posted asking for this report',
      signal_observed_at: day(-2),
      peak_funding_cents: k % 3 === 0 ? 0 : 500 + ((k * 31) % 4_000),
      human_hours: 1 + (k % 4),
    });
    await fact('price', `$${price / 100}`);
    await fact('timeToFirstCash', `${3 + (k % 12)} days`);
    await fact('directCosts', `$${5 + (k % 30)}`);
    await fact('buyerVolume', `${200 + ((k * 37) % 3_000)} ${payer.toLowerCase()} are listed in the state directory; each orders monthly.`);
  }
  for (let k = 0; k < shape.signals; k++, i++) {
    await createOpportunity(base(i, `A posted request ${k}`));
  }
  const gone: string[] = [];
  for (let k = 0; k < shape.archived; k++, i++) {
    gone.push((await createOpportunity(base(i, `An old lead ${k}`))).id);
  }
  for (let k = 0; k < gone.length; k += 400) {
    const chunk = gone.slice(k, k + 400);
    await getDb().run(`UPDATE cash_opportunities SET state = 'ARCHIVED' WHERE id IN (${chunk.map(() => '?').join(', ')})`, chunk);
  }
  for (let s = 0; s < shape.populated + shape.bare; s++) {
    const sector = await createNode({ projectId, parentId: null, kind: 'SECTOR', name: `Sector ${s} ${INDUSTRIES[s % INDUSTRIES.length]}`, origin: 'SEED' });
    if (s >= shape.populated) {
      await createNode({ projectId, parentId: sector.node.id, kind: 'BOTTLENECK', name: `Backlog in sector ${s}`, origin: 'SEED' });
      continue;
    }
    await createNode({ projectId, parentId: sector.node.id, kind: 'BUYER_TYPE', name: `${PAYERS[(s + 7) % PAYERS.length]} in region ${s}`, origin: 'SEED' });
    for (let p = 0; p < shape.partsPerSector; p++) {
      await createNode({ projectId, parentId: sector.node.id, kind: 'BOTTLENECK', name: `Reconciling ledger backlog ${s}-${p}`, origin: 'SEED' });
      await createNode({ projectId, parentId: sector.node.id, kind: 'FULFILMENT_SOURCE', name: `Freelance analysts ${s}-${p}`, origin: 'SEED' });
    }
  }
}

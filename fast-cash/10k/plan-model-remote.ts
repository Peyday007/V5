/**
 * The $10K plan under the standing operating rule: run online, no physical work
 * by the owner, markets chosen nationally. Run by Brain's scenario engine.
 *
 *   npx tsx fast-cash/10k/plan-model-remote.ts
 *
 * The scarce input every remote line shares is OUTREACH: an aged mailbox sends
 * ~30 a day safely (Instantly guidance), LinkedIn allows ~100 invites a week, and
 * a new domain needs 2–4 weeks of warmup — so every line draws on one pool of
 * touches instead of each assuming its own. Paid ads feed only the lead-brokerage
 * line. Settlement: a new Stripe account's first payout comes 7–14 days after its
 * first payment, so card sales must land by ~Nov 13; business clients paying by
 * ACH or wire settle in days. Every rate nobody has measured for this operation is
 * UNKNOWN and swept over its published span; the engine reports coverage of the
 * tested conditions, never a probability.
 *
 * Sources: fast-cash/10k/research-{remote-brokerage,digital-automated,b2b-brokerage,
 * ai-research-products,high-ticket-remote}.md
 */
import { runScenarioModel } from '../../server/services/scenario/run.ts';
import type { ScenarioModelDefinition, ScenarioVariable } from '../../server/domain/scenario.ts';

const v = (key: string, label: string, unit: string, provenance: ScenarioVariable['provenance'], spec: ScenarioVariable['spec'], note: string, controllable = false): ScenarioVariable => ({ key, label, unit, provenance, controllable, spec, note });

export function remotePlanModel(): ScenarioModelDefinition {
  return {
    title: '$10K plan, Nov 3–27 2026, run online with no physical work by the owner',
    currency: 'USD',
    horizon: '2026-11-03 to 2026-11-27 (settled cash)',
    variables: [
      // Decisions: how the shared outreach is spent.
      v('share_high', 'Share of touches spent on high-ticket AI setups', 'share', 'ASSUMPTION', { kind: 'FIXED', value: 0.5 }, 'A strategy sets it.', true),
      v('share_gift', 'Share of touches spent on corporate gift brokerage', 'share', 'ASSUMPTION', { kind: 'FIXED', value: 0.2 }, 'A strategy sets it.', true),
      v('share_list', 'Share of touches spent on trigger lists', 'share', 'ASSUMPTION', { kind: 'FIXED', value: 0.1 }, 'A strategy sets it.', true),
      v('ads_on', 'Run the lead-brokerage ads', 'flag', 'ASSUMPTION', { kind: 'FIXED', value: 1 }, 'A strategy sets it.', true),
      // Outreach capacity.
      v('emails', 'Cold emails from an aged mailbox, Nov 4–23', 'emails', 'ASSUMPTION', { kind: 'FIXED', value: 600 }, '30/day × 20 days (Instantly per-inbox guidance); requires an aged mailbox the owner already has.'),
      v('li_invites', 'LinkedIn invites, Nov 4–23', 'invites', 'ASSUMPTION', { kind: 'FIXED', value: 300 }, '~100 a week (LinkedIn limit, published).'),
      v('li_accept', 'LinkedIn invites accepted', 'share', 'EVIDENCE', { kind: 'RANGE', min: 0.2, max: 0.35 }, '~28.5% published average.'),
      v('li_reply', 'Accepted connections who reply', 'share', 'EVIDENCE', { kind: 'RANGE', min: 0.05, max: 0.15 }, '~10% published.'),
      v('email_reply', 'Cold email reply rate', 'share', 'UNKNOWN', { kind: 'RANGE', min: 0.0045, max: 0.0343 }, 'Belkins 0.45% (7.5M emails, 2025) to Apollo/Instantly 3.43%.'),
      v('positive', 'Replies that are interested', 'share', 'UNKNOWN', { kind: 'RANGE', min: 0.1, max: 0.3 }, 'Instantly: 14.1% of replies positive.'),
      // High-ticket: AI receptionist + missed-call text-back for home-service firms.
      v('close_high', 'Interested conversations that buy a $1,500+ setup', 'share', 'UNKNOWN', { kind: 'RANGE', min: 0.05, max: 0.25 }, 'No published close rate for a new seller without case studies; 10–15% estimate in research.'),
      v('p_high', 'Setup fee plus first month', 'USD', 'EVIDENCE', { kind: 'RANGE', min: 1500, max: 2297 }, 'Published agency setup fees $1,500–5,500; plan prices $1,500 + $297.'),
      v('settle_high', 'High-ticket deals that settle by Nov 27', 'share', 'UNKNOWN', { kind: 'RANGE', min: 0.5, max: 1 }, 'ACH/wire for invoices over $1k; Stripe first payout 7–14 days.'),
      // Corporate gift brokerage (supplier drop-ships; client prepays gross).
      v('close_gift', 'Interested buyers who place a gift order', 'share', 'UNKNOWN', { kind: 'RANGE', min: 0.1, max: 0.4 }, 'No published rate.'),
      v('gift_order', 'Gross per gift order (recipients × $60 × 1.15)', 'USD', 'EVIDENCE', { kind: 'RANGE', min: 690, max: 3450 }, '10–50 recipients; median client gift $30, employee gift $62 (published); fee 10–20%.'),
      // Trigger lists (business-level records only).
      v('close_list', 'Interested buyers who buy a list', 'share', 'UNKNOWN', { kind: 'RANGE', min: 0.1, max: 0.4 }, 'No published rate.'),
      v('p_list', 'List price', 'USD', 'EVIDENCE', { kind: 'RANGE', min: 149, max: 499 }, 'Comparable list products $29–500.'),
      // Lead brokerage: exclusive junk-removal leads, charged per lead (brokered physical work).
      v('ad_budget', 'Ad spend on lead brokerage', 'USD', 'ASSUMPTION', { kind: 'FIXED', value: 300 }, 'Inside the $300 before-income limit; scaled only if a lead sells above its cost.'),
      v('cpl', 'Cost per lead (Facebook lead forms, home services)', 'USD', 'EVIDENCE', { kind: 'RANGE', min: 25, max: 60 }, 'WordStream home improvement ~$41.'),
      v('lead_price', 'Price a contractor pays per exclusive lead', 'USD', 'EVIDENCE', { kind: 'RANGE', min: 20, max: 43 }, 'Service Direct $34–43 (2023); a new broker ~$20–30 (estimate).'),
      v('lead_sold', 'Leads that a contractor buys', 'share', 'UNKNOWN', { kind: 'RANGE', min: 0.4, max: 0.9 }, 'Disputes and unsold leads.'),
      // Small remote licence packs.
      v('packs', 'Senior-living and church puzzle licence packs, settled', 'USD', 'UNKNOWN', { kind: 'RANGE', min: 0, max: 500 }, 'research-digital-automated.md: $0–500.'),
    ],
    derived: [
      { key: 'conversations', label: 'Interested conversations', unit: 'conversations', expr: 'emails * email_reply * positive + li_invites * li_accept * li_reply' },
      { key: 'high_deals', label: 'High-ticket deals settled', unit: 'deals', expr: 'conversations * share_high * close_high * settle_high' },
      { key: 'gift_orders', label: 'Gift orders', unit: 'orders', expr: 'conversations * share_gift * close_gift' },
      { key: 'lists', label: 'Lists sold', unit: 'lists', expr: 'conversations * share_list * close_list' },
      { key: 'leads', label: 'Leads bought', unit: 'leads', expr: 'ads_on * ad_budget / cpl' },
      { key: 'collected', label: 'Settled cash by Nov 27', unit: 'USD', expr: 'high_deals * p_high + gift_orders * gift_order + lists * p_list + leads * lead_sold * lead_price + packs' },
    ],
    lines: [
      { key: 'r_high', label: 'AI receptionist / missed-call setups', kind: 'REVENUE', expr: 'high_deals * p_high' },
      { key: 'r_gift', label: 'Corporate gift orders (gross, client prepays)', kind: 'REVENUE', expr: 'gift_orders * gift_order' },
      { key: 'r_list', label: 'Trigger lists', kind: 'REVENUE', expr: 'lists * p_list' },
      { key: 'r_leads', label: 'Exclusive leads to contractors', kind: 'REVENUE', expr: 'leads * lead_sold * lead_price' },
      { key: 'r_packs', label: 'Licence packs', kind: 'REVENUE', expr: 'packs' },
      { key: 'c_gift', label: 'Gift supplier cost (after prepayment)', kind: 'COST', expr: 'gift_orders * gift_order / 1.15' },
      { key: 'c_ads', label: 'Lead ads', kind: 'COST', expr: 'ads_on * ad_budget' },
      { key: 'c_high', label: 'Voice agent minutes and tools (after deposit)', kind: 'COST', expr: 'high_deals * 150 + 60' },
      { key: 'c_fees', label: 'Card/ACH fees, worst case', kind: 'COST', expr: 'collected * 0.03' },
    ],
    metrics: [
      { key: 'collected_m', label: 'Settled', unit: 'USD', expr: 'collected', better: 'HIGHER' },
      { key: 'reach10', label: '≥ $10,000', unit: 'flag', expr: 'if(collected >= 10000, 1, 0)', better: 'HIGHER' },
      { key: 'reach5', label: '≥ $5,000', unit: 'flag', expr: 'if(collected >= 5000, 1, 0)', better: 'HIGHER' },
      { key: 'reach2', label: '≥ $2,000', unit: 'flag', expr: 'if(collected >= 2000, 1, 0)', better: 'HIGHER' },
      { key: 'conv', label: 'Interested conversations', unit: 'conversations', expr: 'conversations', better: 'HIGHER' },
    ],
    strategies: [
      { key: 'high_focus', label: 'Half the outreach on AI setups, rest on gifts/lists, ads on', set: { share_high: 0.5, share_gift: 0.3, share_list: 0.2, ads_on: 1 } },
      { key: 'all_high', label: 'All outreach on AI setups, ads on', set: { share_high: 1, share_gift: 0, share_list: 0, ads_on: 1 } },
      { key: 'gift_focus', label: 'Mostly gift brokerage', set: { share_high: 0.2, share_gift: 0.7, share_list: 0.1, ads_on: 1 } },
      { key: 'no_ads', label: 'Half on AI setups, no ads', set: { share_high: 0.5, share_gift: 0.3, share_list: 0.2, ads_on: 0 } },
    ],
  };
}

/** What outreach volume $10K would need at mid-evidence rates, to state the gap in the plan's own terms. */
export function touchesForTarget(target: number): { conversationsNeeded: number; perConversation: number } {
  const mid = { email_reply: 0.0194, positive: 0.2, close_high: 0.15, p_high: 1797, settle_high: 0.75, close_gift: 0.25, gift_order: 1725, close_list: 0.25, p_list: 299 };
  const perConversation = 0.5 * mid.close_high * mid.settle_high * mid.p_high + 0.3 * mid.close_gift * mid.gift_order + 0.2 * mid.close_list * mid.p_list;
  return { conversationsNeeded: Math.ceil(target / perConversation), perConversation };
}

if (process.argv[1]?.endsWith('plan-model-remote.ts')) {
  const result = runScenarioModel(remotePlanModel(), { seed: 20261103, evaluations: 40_000 });
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  console.log(`basis ${result.basis} · probabilistic=${result.probabilistic}`);
  console.log(result.basisNote);
  for (const s of result.strategies) {
    const c = s.metrics['collected_m']!;
    const conv = s.metrics['conv']!;
    const pct = (k: string) => `${Math.round((s.metrics[k]?.mean ?? 0) * 100)}%`;
    console.log(`\n${s.key}: ${s.label}`);
    console.log(`  settled p10 ${usd(c.p10)} · p50 ${usd(c.p50)} · p90 ${usd(c.p90)} · max ${usd(c.max)}`);
    console.log(`  share of tested conditions: ≥$10k ${pct('reach10')} · ≥$5k ${pct('reach5')} · ≥$2k ${pct('reach2')}`);
    console.log(`  interested conversations p10 ${conv.p10.toFixed(1)} p50 ${conv.p50.toFixed(1)} p90 ${conv.p90.toFixed(1)}`);
    for (const [k, line] of Object.entries(s.lines)) if (k.startsWith('r_')) console.log(`    ${k.padEnd(8)} mean ${usd(line.meanCents / 100)}`);
  }
  const need = touchesForTarget(10_000);
  console.log(`\n$10k at mid-evidence rates needs ~${need.conversationsNeeded} interested conversations (each worth ~${usd(need.perConversation)}); the shared outreach yields the conversations above.`);
}

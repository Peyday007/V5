/**
 * The $10K plan as a scenario model, run by Brain's own engine (§60, §79).
 *
 *   npx tsx fast-cash/10k/plan-model.ts
 *
 * Every rate nobody has measured for this operation is UNKNOWN and swept over a
 * range whose bounds come from the published benchmarks in the research files;
 * prices and costs carry the evidence they came from. The engine therefore
 * reports coverage of the tested conditions — never a probability — and that is
 * what the plan quotes. Revenue is COLLECTED cash (the goal's metric); costs are
 * shown beside it as contribution.
 *
 * Sources: fast-cash/10k/research-*.md and docs/CASH-10K-PLAN-2026-11-02.md.
 */
import { runScenarioModel } from '../../server/services/scenario/run.ts';
import type { ScenarioModelDefinition, ScenarioVariable } from '../../server/domain/scenario.ts';

const v = (
  key: string,
  label: string,
  unit: string,
  provenance: ScenarioVariable['provenance'],
  spec: ScenarioVariable['spec'],
  note: string,
  controllable = false,
): ScenarioVariable => ({ key, label, unit, provenance, controllable, spec, note });

export function planModel(): ScenarioModelDefinition {
  return {
    title: '$10K plan, Nov 3–27 2026: prepaid local seasonal lines + co-op mailer + B2B gifts + fundraiser brokerage',
    description: 'Collected cash inside the window, by line. Unmeasured rates are swept, not assumed.',
    currency: 'USD',
    horizon: '2026-11-03 to 2026-11-27',
    variables: [
      // Decisions a strategy sets.
      v('hangers', 'Door hangers distributed', 'cards', 'ASSUMPTION', { kind: 'FIXED', value: 3000 }, 'A decision: 3,000 or 6,000.', true),
      v('biz_contacts', 'Businesses contacted for gift boxes', 'contacts', 'ASSUMPTION', { kind: 'FIXED', value: 80 }, 'A decision; 81 are listed in buyers-gift-boxes.csv.', true),
      v('mailer_on', 'Run the co-op mailer presale', 'flag', 'ASSUMPTION', { kind: 'FIXED', value: 1 }, 'A decision.', true),
      v('gift_on', 'Run client gift boxes', 'flag', 'ASSUMPTION', { kind: 'FIXED', value: 1 }, 'A decision.', true),
      v('org_on', 'Run wreath fundraiser brokerage', 'flag', 'ASSUMPTION', { kind: 'FIXED', value: 1 }, 'A decision.', true),
      // Lead generation — nobody has measured these for this operation.
      v('r_hanger', 'Door-hanger response rate', 'share', 'UNKNOWN', { kind: 'RANGE', min: 0.004, max: 0.03 }, 'Published span 0.4–5% (4over4, doorhangerswork, stompstickers); upper bound capped at 3%.'),
      v('c_hanger', 'Responses that book and pay', 'share', 'UNKNOWN', { kind: 'RANGE', min: 0.25, max: 0.5 }, 'One operator reports ~50% (anecdotal); swept down to 25%.'),
      v('warm_contacts', 'People personally messaged (owner + 2 helpers)', 'people', 'ASSUMPTION', { kind: 'FIXED', value: 300 }, 'A stated plan, 100 each.'),
      v('warm_rate', 'Personal contacts who buy', 'share', 'UNKNOWN', { kind: 'RANGE', min: 0.02, max: 0.06 }, 'House-list response 5–9% (ANA via directmail.io) as a ceiling reference.'),
      // Order mix and prices.
      v('mix_lights', 'Share of home orders that are light installs', 'share', 'ASSUMPTION', { kind: 'FIXED', value: 0.25 }, 'Estimate.'),
      v('mix_trees', 'Share that are tree delivery', 'share', 'ASSUMPTION', { kind: 'FIXED', value: 0.4 }, 'Estimate.'),
      v('p_lights', 'Light install price', 'USD', 'EVIDENCE', { kind: 'RANGE', min: 249, max: 449 }, 'Angi 2025 avg $442 (via Jobber); HomeAdvisor $220–683; plan prices $249–449.'),
      v('p_tree', 'Tree delivered + set up + January removal', 'USD', 'ASSUMPTION', { kind: 'FIXED', value: 159 }, 'Decision; farm setup service sells at $149 (Cornell Farms), delivery services from $100.'),
      v('cost_tree', 'Tree cost', 'USD', 'EVIDENCE', { kind: 'RANGE', min: 70, max: 100 }, '6 ft Fraser $90 at a PA farm 2025 (WESA); lot average ~$100.'),
      v('p_cleanup', 'Leaf + single-story gutter cleanup', 'USD', 'EVIDENCE', { kind: 'RANGE', min: 129, max: 200 }, 'Gutter cleaning avg $144–168 (Angi).'),
      v('wreath_attach', 'Tree orders that add a wreath', 'share', 'UNKNOWN', { kind: 'RANGE', min: 0.2, max: 0.6 }, 'Nobody has measured it.'),
      v('cost_wreath', 'Wreath cost', 'USD', 'EVIDENCE', { kind: 'RANGE', min: 18.5, max: 30 }, 'McCarthy 2018 $18.50; Armstrong group cost $30.'),
      // Co-op mailer (5,000 homes, Retail EDDM, threshold presale).
      v('slots', 'Mailer slots sold by Nov 12', 'slots', 'UNKNOWN', { kind: 'RANGE', min: 0, max: 14 }, 'No close rate published; vendors say a first card takes 4–6 weeks to fill.'),
      v('p_slot', 'Slot price, 5,000 homes', 'USD', 'EVIDENCE', { kind: 'RANGE', min: 250, max: 400 }, 'Asking prices $250–810 per 10k homes; $150/2,500 in Missoula.'),
      v('mailer_cost', 'Print + EDDM postage + design, 5,000 homes', 'USD', 'EVIDENCE', { kind: 'RANGE', min: 2100, max: 2760 }, 'EDDM Retail $0.260/piece (USPS Notice 123); 9x12 print $744–1,309 per 5k.'),
      // Client gift boxes.
      v('gift_rate', 'Businesses contacted that order', 'share', 'UNKNOWN', { kind: 'RANGE', min: 0, max: 0.04 }, 'Cold email reply median 1.6%, average 4.5% (Instantly, Hunter): orders cannot exceed replies.'),
      v('boxes', 'Boxes per order', 'boxes', 'UNKNOWN', { kind: 'RANGE', min: 10, max: 30 }, 'Minimum 10 by the offer.'),
      v('cost_box', 'Cost per box', 'USD', 'ASSUMPTION', { kind: 'RANGE', min: 30, max: 40 }, 'Estimate until wholesale quotes; promo distributors average 37.8% margin (ASI).'),
      // Wreath fundraiser brokerage.
      v('orgs', 'Churches, scouts, clubs, HOAs contacted', 'orgs', 'ASSUMPTION', { kind: 'FIXED', value: 30 }, 'A plan.'),
      v('org_rate', 'Organisations that run the sale', 'share', 'UNKNOWN', { kind: 'RANGE', min: 0, max: 0.1 }, 'Most schools ran fall sales already.'),
      v('wreaths_per_org', 'Wreaths per organisation', 'wreaths', 'UNKNOWN', { kind: 'RANGE', min: 30, max: 80 }, 'Nobody has measured it.'),
      // Remote digital packs (senior living, churches) — small by payout timing.
      v('remote', 'Remote puzzle-pack cash settled by Nov 27', 'USD', 'UNKNOWN', { kind: 'RANGE', min: 0, max: 500 }, 'research-remote-puzzle-lines.md: $0–500 realistic.'),
    ],
    derived: [
      { key: 'home_orders', label: 'Home-service orders', unit: 'orders', expr: 'hangers * r_hanger * c_hanger + warm_contacts * warm_rate' },
      { key: 'n_lights', label: 'Light installs', unit: 'jobs', expr: 'home_orders * mix_lights' },
      { key: 'n_trees', label: 'Trees presold', unit: 'orders', expr: 'home_orders * mix_trees' },
      { key: 'n_cleanup', label: 'Cleanups', unit: 'jobs', expr: 'home_orders * (1 - mix_lights - mix_trees)' },
      { key: 'mailer_runs', label: 'Mailer reaches its minimum of 8 slots', unit: 'flag', expr: 'if(slots >= 8, 1, 0) * mailer_on' },
      { key: 'gift_boxes', label: 'Gift boxes ordered', unit: 'boxes', expr: 'biz_contacts * gift_rate * boxes * gift_on' },
      { key: 'org_wreaths', label: 'Wreaths sold to organisations', unit: 'wreaths', expr: 'orgs * org_rate * wreaths_per_org * org_on' },
      { key: 'collected', label: 'Cash collected inside the window', unit: 'USD', expr: 'n_lights * p_lights + n_trees * (p_tree + 45 * wreath_attach) + n_cleanup * p_cleanup + mailer_runs * slots * p_slot + gift_boxes * 55 + org_wreaths * 30 + remote' },
      { key: 'hours', label: 'Person-hours inside the window', unit: 'hours', expr: 'hangers / 70 + n_lights * 5 + n_cleanup * 2.5 + 60 + mailer_on * 35 + gift_on * (15 + gift_boxes / 6) + org_on * 15' },
    ],
    lines: [
      { key: 'r_lights', label: 'Light installs', kind: 'REVENUE', expr: 'n_lights * p_lights' },
      { key: 'r_trees', label: 'Trees + wreaths (prepaid)', kind: 'REVENUE', expr: 'n_trees * (p_tree + 45 * wreath_attach)' },
      { key: 'r_cleanup', label: 'Cleanups', kind: 'REVENUE', expr: 'n_cleanup * p_cleanup' },
      { key: 'r_mailer', label: 'Co-op mailer slots (prepaid)', kind: 'REVENUE', expr: 'mailer_runs * slots * p_slot' },
      { key: 'r_gift', label: 'Client gift boxes (prepaid)', kind: 'REVENUE', expr: 'gift_boxes * 55' },
      { key: 'r_org', label: 'Wreaths to organisations', kind: 'REVENUE', expr: 'org_wreaths * 30' },
      { key: 'r_remote', label: 'Remote puzzle packs', kind: 'REVENUE', expr: 'remote' },
      { key: 'c_trees', label: 'Trees + wreaths bought after payment', kind: 'COST', expr: 'n_trees * (cost_tree + cost_wreath * wreath_attach)' },
      { key: 'c_lights', label: 'Light clips and consumables', kind: 'COST', expr: 'n_lights * 20' },
      { key: 'c_mailer', label: 'Mailer print + postage (after presale)', kind: 'COST', expr: 'mailer_runs * mailer_cost' },
      { key: 'c_gift', label: 'Gift box contents', kind: 'COST', expr: 'gift_boxes * cost_box' },
      { key: 'c_org', label: 'Wreaths bought for organisations', kind: 'COST', expr: 'org_wreaths * cost_wreath' },
      { key: 'c_hangers', label: 'Door-hanger printing', kind: 'COST', expr: 'hangers * 0.127' },
      { key: 'c_fees', label: 'Card fees (3.3% + 0.30 online, worst case)', kind: 'COST', expr: 'collected * 0.033 + home_orders * 0.3' },
    ],
    metrics: [
      { key: 'collected_m', label: 'Collected', unit: 'USD', expr: 'collected', better: 'HIGHER' },
      { key: 'reach10', label: 'Collects $10,000', unit: 'flag', expr: 'if(collected >= 10000, 1, 0)', better: 'HIGHER' },
      { key: 'reach9', label: 'Collects $9,000', unit: 'flag', expr: 'if(collected >= 9000, 1, 0)', better: 'HIGHER' },
      { key: 'reach8', label: 'Collects $8,000', unit: 'flag', expr: 'if(collected >= 8000, 1, 0)', better: 'HIGHER' },
      { key: 'hours_m', label: 'Person-hours', unit: 'hours', expr: 'hours', better: 'LOWER', role: 'LABOR_HOURS' },
      { key: 'upfront', label: 'Money out before any income', unit: 'USD', expr: 'min(hangers, 1500) * 0.127 + 45 + 15', better: 'LOWER', role: 'CAPITAL_EXPOSURE' },
    ],
    constraints: [
      { key: 'capacity', label: 'Within ~280 person-hours (owner 50/wk, helpers 15/wk each)', expr: 'hours - 280', op: '<=', value: 0 },
    ],
    strategies: [
      { key: 'full', label: 'All lines, 3,000 hangers, 80 businesses', set: { hangers: 3000, biz_contacts: 80, mailer_on: 1, gift_on: 1, org_on: 1 } },
      { key: 'full_wide', label: 'All lines, 6,000 hangers, 160 businesses', set: { hangers: 6000, biz_contacts: 160, mailer_on: 1, gift_on: 1, org_on: 1 } },
      { key: 'no_mailer_wide', label: 'No mailer, 6,000 hangers, 160 businesses', set: { hangers: 6000, biz_contacts: 160, mailer_on: 0, gift_on: 1, org_on: 1 } },
      { key: 'home_only', label: 'Home services only, 3,000 hangers', set: { hangers: 3000, biz_contacts: 0, mailer_on: 0, gift_on: 0, org_on: 0 } },
    ],
  };
}

if (process.argv[1]?.endsWith('plan-model.ts')) {
  const result = runScenarioModel(planModel(), { seed: 20261102, evaluations: 40_000 });
  const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
  console.log(`basis ${result.basis} · probabilistic=${result.probabilistic} · ${result.scenarios} scenarios`);
  console.log(result.basisNote);
  for (const s of result.strategies) {
    const c = s.metrics['collected_m'];
    const h = s.metrics['hours_m'];
    const share = (k: string) => `${Math.round((s.metrics[k]?.mean ?? 0) * 100)}%`;
    console.log(`\n${s.key}: ${s.label}  (infeasible ${s.infeasible}/${s.evaluated})`);
    if (c) console.log(`  collected p10 $${Math.round(c.p10)}  p50 $${Math.round(c.p50)}  p90 $${Math.round(c.p90)}  · hours p50 ${Math.round(h?.p50 ?? 0)} p90 ${Math.round(h?.p90 ?? 0)}`);
    console.log(`  share of tested conditions collecting ≥$10k ${share('reach10')} · ≥$9k ${share('reach9')} · ≥$8k ${share('reach8')}`);
    console.log(`  contribution p10 ${usd(s.contribution?.p10 ?? 0)} p50 ${usd(s.contribution?.p50 ?? 0)} p90 ${usd(s.contribution?.p90 ?? 0)}`);
    for (const [k, line] of Object.entries(s.lines)) if (k.startsWith('r_')) console.log(`    ${k.padEnd(10)} mean ${usd(line.meanCents)}  p50 ${usd(line.p50Cents)}`);
  }
  const rc = result.sensitivity.rankCorrelation['full_wide'] ?? [];
  console.log('\nwhat moves the result most (full_wide, rank correlation with contribution):');
  for (const one of rc.slice(0, 8)) console.log(`  ${one.rho.toFixed(2)}  ${one.label}`);
}

/** The same formulas at named points: base = mid-evidence, adverse = low end of every benchmark. */
export interface Case { [k: string]: number }
export const BASE: Case = { hangers: 3000, r_hanger: 0.015, c_hanger: 0.45, warm_rate: 0.04, p_lights: 349, p_cleanup: 150, wreath_attach: 0.4, slots: 10, p_slot: 350, mailer_on: 1, biz_contacts: 80, gift_rate: 0.025, boxes: 20, gift_on: 1, org_rate: 2 / 30, wreaths_per_org: 50, org_on: 1, remote: 250 };
export const ADVERSE: Case = { hangers: 3000, r_hanger: 0.0075, c_hanger: 0.35, warm_rate: 0.02, p_lights: 299, p_cleanup: 135, wreath_attach: 0.2, slots: 6, p_slot: 300, mailer_on: 1, biz_contacts: 80, gift_rate: 0.0125, boxes: 15, gift_on: 1, org_rate: 1 / 30, wreaths_per_org: 30, org_on: 1, remote: 0 };

export function evaluateCase(c: Case): { lines: Record<string, number>; collected: number; hours: number } {
  const home = c.hangers! * c.r_hanger! * c.c_hanger! + 300 * c.warm_rate!;
  const lights = home * 0.25, trees = home * 0.4, cleanup = home * 0.35;
  const mailer = c.slots! >= 8 && c.mailer_on ? c.slots! * c.p_slot! : 0;
  const boxes = c.biz_contacts! * c.gift_rate! * c.boxes! * c.gift_on!;
  const wreaths = 30 * c.org_rate! * c.wreaths_per_org! * c.org_on!;
  const lines = {
    lights: lights * c.p_lights!,
    trees_wreaths: trees * (159 + 45 * c.wreath_attach!),
    cleanup: cleanup * c.p_cleanup!,
    mailer,
    gift_boxes: boxes * 55,
    org_wreaths: wreaths * 30,
    remote: c.remote!,
  };
  const collected = Object.values(lines).reduce((a, b) => a + b, 0);
  const hours = c.hangers! / 70 + lights * 5 + cleanup * 2.5 + 60 + (c.mailer_on ? 35 : 0) + (c.gift_on ? 15 + boxes / 6 : 0) + (c.org_on ? 15 : 0);
  return { lines, collected, hours };
}

if (process.argv[1]?.endsWith('plan-model.ts')) {
  for (const [name, c] of [['BASE', BASE], ['ADVERSE', ADVERSE]] as const) {
    const r = evaluateCase(c);
    console.log(`\n${name}: collected $${Math.round(r.collected)} in ${Math.round(r.hours)} person-hours`);
    for (const [k, val] of Object.entries(r.lines)) console.log(`  ${k.padEnd(14)} $${Math.round(val)}`);
  }
  // What closes the adverse gap to $8,000, one lever at a time.
  const gap = (c: Case) => 8000 - evaluateCase(c).collected;
  console.log(`\nADVERSE gap to $8,000: $${Math.round(gap(ADVERSE))}`);
  for (const [label, change] of [
    ['mailer fills to 8 slots at $300', { slots: 8 }],
    ['+3,000 door hangers (second batch)', { hangers: 6000 }],
    ['gift orders at the 1.6% median reply rate', { gift_rate: 0.016 }],
    ['+80 more businesses contacted', { biz_contacts: 160 }],
    ['one more organisation (2 of 30)', { org_rate: 2 / 30 }],
  ] as const) {
    const c = { ...ADVERSE, ...change };
    console.log(`  ${label}: collected $${Math.round(evaluateCase(c).collected)}, hours ${Math.round(evaluateCase(c).hours)}`);
  }
  const all = { ...ADVERSE, slots: 8, hangers: 6000, biz_contacts: 160, gift_rate: 0.016, org_rate: 2 / 30 };
  console.log(`  all five together: collected $${Math.round(evaluateCase(all).collected)}, hours ${Math.round(evaluateCase(all).hours)}`);
}

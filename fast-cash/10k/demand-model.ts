/**
 * The $10K plan's customer demand, estimated by the quant engine (§79) rather
 * than typed into the scenario sweep.
 *
 *   npx tsx fast-cash/10k/demand-model.ts            # print the reading
 *   npx tsx fast-cash/10k/demand-model.ts --write    # also refresh plans/quant/cash-10k-demand-*.json
 *   npm run quant -- plans/quant/cash-10k-demand-remote-2026-11-02.json
 *
 * Why this exists. `plan-model.ts` (the plan's only model) declared every demand
 * rate as a hand-typed range, swept it uniformly, and quoted base and adverse
 * cases picked by hand in a second calculator. Nothing pooled the published
 * evidence, nothing separated a reply from an order, and nothing let one bad
 * month hit several lines at once. Here every demand rate climbs the evidence
 * ladder (observations pooled with random effects, discounted for each way the
 * source population differs from ours), every count is whole, the lines share
 * a risk factor, and total outflows are read against the spending ceiling in
 * the same world as the cash.
 *
 * Two variants:
 *   PLAN    the seven lines as the plan wrote them: owner and helpers install,
 *           deliver, rake and hand out hangers;
 *   REMOTE  the goal's actual constraint — no owner physical labour: hangers
 *           distributed by a paid crew, installs and cleanups subcontracted,
 *           trees delivered by the lot, gift boxes white-label fulfilled.
 */
import { writeFileSync } from 'node:fs';
import { solveProblem, type QuantProblem } from '../../server/services/quant/problem.ts';
import type { Observation, QuantGraph, QuantityNode } from '../../server/domain/quant.ts';

type Variant = 'PLAN' | 'REMOTE';

const url = (ref: string, note?: string) => ({ kind: 'URL' as const, ref, ...(note ? { note } : {}) });
const doc = (ref: string, note?: string) => ({ kind: 'DOCUMENT' as const, ref, ...(note ? { note } : {}) });
const FORUM = 'https://community.windowcleaner.com/t/what-has-been-your-response-rate-for-door-hangers/25593';
const RESEARCH = 'fast-cash/10k/research-brokerage-pooled.md';

/** A decision the plan makes: a constant, not a measurement. */
const decide = (key: string, label: string, unit: string, value: number): QuantityNode => ({ key, label, unit, kind: 'POSITIVE', min: value, max: value });
/** Nothing establishes it: a person's or a research worker's range, bounds only. */
const assume = (key: string, label: string, unit: string, kind: QuantityNode['kind'], low: number, high: number, why: string): QuantityNode => ({
  key, label, unit, kind, ...(kind === 'RATE' ? { min: 0, max: 1 } : { min: 0 }), assumed: { low, high, source: doc('fast-cash/10k/demand-model.ts', why) },
});
/** A uniform 0–1 draw that turns an expected count into a whole one (randomised rounding). */
const roundingDraw = (key: string): QuantityNode => ({ key, label: 'Rounding draw', unit: 'share', kind: 'RATE', min: 0, max: 1 });
const obs = (id: string, value: Observation['value'], context: Record<string, string>, lineage: string, source: Observation['source'], measures: string): Observation => ({ id, value, context, lineage: [lineage], source, measures });
const formula = (key: string, label: string, unit: string, expr: string, kind: QuantityNode['kind'] = 'POSITIVE'): QuantityNode => ({ key, label, unit, kind, ...(kind === 'REAL' ? {} : { min: 0 }), formula: expr });

/* ------------------------------------------------------------------ home (A + B + C) */

function home(v: Variant): QuantGraph {
  const target = { service: 'seasonal-home-service', operator: 'new-no-reviews', season: 'november' };
  const nodes: QuantityNode[] = [
    decide('h_doors', 'Door hangers delivered', 'doors', v === 'PLAN' ? 3000 : 2000),
    {
      key: 'h_resp', label: 'Door-hanger response rate (calls, texts, scans)', unit: 'share', kind: 'RATE', min: 0, max: 1,
      context: target, material: [],
      observations: [
        obs('hotwinwash', { kind: 'RANGE', low: 0.005, high: 0.007 }, { service: 'window-cleaning', operator: 'established' }, 'forum-hotwinwash', url(FORUM), 'every campaign over years, operator self-report'),
        obs('doherty', { kind: 'POINT', value: 0.02 }, { service: 'roof-cleaning', operator: 'established' }, 'forum-doherty', url(FORUM), 'consistent response, operator self-report'),
        obs('phinkle', { kind: 'POINT', value: 0.01 }, { service: 'exterior-cleaning', operator: 'established' }, 'forum-phinkle', url(FORUM), 'usual response, self-report'),
        obs('wcs', { kind: 'POINT', value: 0.01 }, { service: 'exterior-cleaning', operator: 'established' }, 'forum-wcs', url(FORUM), 'past door hangers, self-report'),
        obs('printer_claim', { kind: 'RANGE', low: 0.01, high: 0.05 }, { service: 'any', operator: 'printer-marketing' }, '4over4-claim', url('https://www.4over4.com/statistics/door-hanger-advertising-effectiveness-data'), 'printer marketing page, no data basis'),
      ],
    },
    {
      key: 'h_book', label: 'Responses that book and pay', unit: 'share', kind: 'RATE', min: 0, max: 1,
      context: target, material: [],
      observations: [
        obs('doherty_close', { kind: 'POINT', value: 0.5 }, { service: 'roof-cleaning', operator: 'established' }, 'forum-doherty', url(FORUM), 'usually around 50% closing'),
        obs('hotwinwash_close', { kind: 'POINT', value: 0.9 }, { service: 'window-cleaning', operator: 'established' }, 'forum-hotwinwash', url(FORUM), 'reported 100% close on flyer calls; read as 0.9'),
      ],
    },
    decide('h_warm_n', 'People personally messaged', 'people', 300),
    {
      ...assume('h_warm_rate', 'Personal contacts who buy', 'share', 'RATE', 0.01, 0.05, 'No source measures this population. The plan cited house-list response 5–9%, which is a business’s past customers, not the personal contacts of an 18-year-old; excluded below.'),
      context: { relationship: 'personal-network' }, material: ['relationship'],
      observations: [obs('house_list', { kind: 'RANGE', low: 0.05, high: 0.09 }, { relationship: 'business-house-list' }, 'ana-via-directmail-io', url('https://directmail.io/direct-mail-response-rate'), 'house-list direct mail response')],
    },
    assume('h_inst', 'Light installs finished (balance collected) by Nov 27', 'share', 'RATE', 0.4, 0.8, 'Installs run Nov 14–Dec 6; only the 50% deposit is certain inside the window.'),
    assume('h_wreath', 'Tree orders that add a wreath', 'share', 'RATE', 0.2, 0.6, 'Unmeasured; the plan’s range.'),
    formula('h_orders', 'Home orders', 'orders', 'h_doors * h_resp * h_book + h_warm_n * h_warm_rate'),
    // Mix 25% lights / 40% trees / 35% cleanup is the plan's assumption; prices are the plan's decisions.
    formula('h_cash', 'Home cash collected by Nov 27', 'USD', 'h_orders * (0.25 * 349 * (0.5 + 0.5 * h_inst) + 0.40 * (159 + 45 * h_wreath) + 0.35 * 150)'),
    { key: 'h_tree_cost', label: 'Tree cost', unit: 'USD', kind: 'POSITIVE', min: 0, observations: [
      obs('wesa_farm', { kind: 'POINT', value: 90 }, {}, 'wesa-2025', url('https://m.washingtontimes.com/news/2025/dec/11/trump-tariffs-drive-artificial-christmas-tree-prices-real-saplings/'), '6 ft Fraser at a farm, 2025'),
      obs('benkens', { kind: 'POINT', value: 100 }, {}, 'benkens', url('https://shop.benkens.com/item/638708983105/Fraser-Fir-Tree-6-7ft?cid=43'), '6–7 ft Fraser retail'),
    ] },
    { key: 'h_wreath_cost', label: 'Wreath cost', unit: 'USD', kind: 'POSITIVE', min: 0, observations: [
      obs('mccarthy', { kind: 'POINT', value: 18.5 }, {}, 'mccarthy-2018', url('https://cdn.shopify.com/s/files/1/0071/2956/3191/files/Wreath-Fundraiser-Letter-2018-1.pdf'), 'group cost 2018'),
      obs('armstrong', { kind: 'POINT', value: 30 }, {}, 'armstrong', url('https://www.armstronggarden.com/fundraiser'), 'group cost'),
    ] },
  ];
  if (v === 'PLAN') {
    nodes.push(formula('h_spend', 'Home outflows', 'USD', 'h_doors * 0.127 + h_orders * (0.25 * 20 + 0.40 * (h_tree_cost + h_wreath * h_wreath_cost)) + 0.033 * h_cash'));
  } else {
    nodes.push(
      { key: 'h_door_cost', label: 'Hanger printed and delivered by a paid crew', unit: 'USD', kind: 'POSITIVE', min: 0, observations: [
        obs('dtd_bundle', { kind: 'POINT', value: 0.695 }, {}, 'directtodoor-2026', url('https://doorhangerswork.com/door-hanger-distribution-cost'), '1,000-piece campaign from about $695, printing bundled, 2026'),
        obs('hired_walker', { kind: 'POINT', value: 0.27 }, {}, 'forum-hotwinwash-pace', url(FORUM), '$0.127 print + $18/h at 125 doors/h (500 in under 4 h)'),
      ] },
      { key: 'h_sub_lights', label: 'Share of a light install paid to an insured crew', unit: 'share', kind: 'RATE', min: 0, max: 1, observations: [
        obs('jobber_sub', { kind: 'RANGE', low: 0.6, high: 0.7 }, {}, 'jobber-holiday', url('https://getjobber.com/academy/holiday-lighting/how-to-bid-christmas-light-installation/'), 'subcontract at 60–70% of price (research reading)'),
      ] },
      assume('h_sub_clean', 'Share of a cleanup paid to a crew', 'share', 'RATE', 0.65, 0.75, `${RESEARCH}: kill test at a crew for ≤75%.`),
      assume('h_tree_delivery', 'Lot or courier delivery and set-up per tree', 'USD', 'POSITIVE', 30, 60, 'Unpriced; nobody delivers for us for free.'),
      formula('h_spend', 'Home outflows', 'USD', 'h_doors * h_door_cost + h_orders * (0.25 * 349 * h_sub_lights + 0.40 * (h_tree_cost + h_tree_delivery + h_wreath * h_wreath_cost) + 0.35 * 150 * h_sub_clean) + 0.033 * h_cash'),
    );
  }
  return { nodes };
}

/* ------------------------------------------------------------------ D: co-op mailer */

function mailer(v: Variant): QuantGraph {
  return { nodes: [
    decide('m_conv', 'Advertiser conversations by Nov 12', 'conversations', 60),
    {
      ...assume('m_close', 'Conversations that buy a slot', 'share', 'RATE', 0.05, 0.10, `${'fast-cash/10k/research-coop-mailer.md'}: no close rate is published; the research assumed 5–10% for cold contacts.`),
      context: { lead: 'cold' }, material: ['lead'],
      observations: [obs('vendor_fill', { kind: 'RANGE', low: 0.16, high: 0.32 }, { lead: 'warm-inbound' }, '9x12tools-claim', url('https://www.9x12tools.com/postcard-marketing-business'), '16 slots from 50–100 conversations, vendor claim for warm leads')],
    },
    roundingDraw('m_u'),
    formula('m_slots', 'Paid slots', 'slots', 'floor(m_conv * m_close + m_u)'),
    formula('m_cash', 'Mailer cash kept (refunded below 8 slots)', 'USD', 'if(m_slots >= 8, m_slots * 325, 0)'),
    { key: 'm_fixed', label: 'Print and EDDM postage, 5,000 homes', unit: 'USD', kind: 'POSITIVE', min: 0, observations: [
      obs('usps_print', { kind: 'RANGE', low: 2100, high: 2760 }, {}, 'usps-notice-123', url('https://pe.usps.com/text/dmm300/Notice123.htm'), '$0.260/piece postage + 9x12 print $744–1,309'),
    ] },
    ...(v === 'REMOTE' ? [assume('m_drop', 'Full-service mailing (nobody walks it to the post office)', 'USD', 'POSITIVE', 100, 300, 'Unpriced vendor surcharge.')] : []),
    formula('m_spend', 'Mailer outflows', 'USD', v === 'REMOTE' ? 'if(m_slots >= 8, m_fixed + m_drop + 0.033 * m_cash, 0)' : 'if(m_slots >= 8, m_fixed + 0.033 * m_cash, 0)'),
  ] };
}

/* ------------------------------------------------------------------ E: client gift boxes */

function gift(v: Variant): QuantGraph {
  const t = { audience: 'local-smb', campaign: 'new-sender' };
  return { nodes: [
    decide('g_contacts', 'Businesses contacted', 'contacts', v === 'PLAN' ? 80 : 160),
    {
      key: 'g_reply', label: 'Cold contacts who reply at all', unit: 'share', kind: 'RATE', min: 0, max: 1, context: t, material: [],
      observations: [
        obs('belkins', { kind: 'POINT', value: 0.0045 }, { audience: 'b2b' }, 'belkins', url('https://belkins.io/blog/cold-email-response-rates.md'), 'replies per send'),
        obs('instantly', { kind: 'POINT', value: 0.016 }, { audience: 'b2b' }, 'instantly', url('https://instantly.ai/blog/cold-email-reply-rate-benchmarks'), 'median reply rate'),
        obs('hunter', { kind: 'POINT', value: 0.045 }, { audience: 'b2b' }, 'hunter', url('https://hunter.io/the-state-of-cold-email-2025'), 'average reply rate'),
        obs('saleshandy', { kind: 'POINT', value: 0.045 }, { audience: 'b2b' }, 'saleshandy-2026', url('https://saleshandy.com/blog/cold-email-statistics/'), 'average reply rate 2026'),
      ],
    },
    {
      key: 'g_interest', label: 'Replies that are interested', unit: 'share', kind: 'RATE', min: 0, max: 1, context: t, material: [],
      observations: [obs('saleshandy_interest', { kind: 'RANGE', low: 0.25, high: 0.5 }, { audience: 'b2b', campaign: 'top-performing' }, 'saleshandy-2026-interest', url('https://saleshandy.com/blog/cold-email-statistics/'), 'interested share of replies, strongest campaigns')],
    },
    assume('g_close', 'Interested businesses that prepay an order', 'share', 'RATE', 0.2, 0.5, 'No published close rate for a first order from a cold B2B lead.'),
    roundingDraw('g_u'),
    formula('g_orders', 'Prepaid orders', 'orders', 'floor(g_contacts * g_reply * g_interest * g_close + g_u)'),
    assume('g_boxes', 'Boxes per order', 'boxes', 'POSITIVE', 10, 30, 'Offer minimum 10; nothing measures the rest.'),
    formula('g_cash', 'Gift cash collected', 'USD', 'g_orders * g_boxes * 55'),
    v === 'PLAN'
      ? assume('g_box_cost', 'Cost per box, assembled in house', 'USD', 'POSITIVE', 30, 40, 'Estimate until wholesale quotes.')
      : assume('g_box_cost', 'Cost per box, white-label packed and shipped', 'USD', 'POSITIVE', 38, 48, 'No in-house packing under the remote constraint.'),
    formula('g_spend', 'Gift outflows', 'USD', 'g_orders * g_boxes * g_box_cost + 0.033 * g_cash'),
  ] };
}

/* ------------------------------------------------------------------ F: wreath fundraiser brokerage */

function orgs(): QuantGraph {
  return { nodes: [
    decide('o_n', 'Organisations contacted', 'orgs', 30),
    assume('o_rate', 'Organisations that sign and run a sale', 'share', 'RATE', 0, 0.1, 'Nobody has measured it; most school sales already ran.'),
    roundingDraw('o_u'),
    formula('o_signed', 'Organisations signed', 'orgs', 'floor(o_n * o_rate + o_u)'),
    assume('o_wreaths', 'Wreaths per organisation', 'wreaths', 'POSITIVE', 30, 80, 'Nobody has measured it.'),
    assume('o_inwin', 'Share of the organisation’s payment that arrives by Nov 27', 'share', 'RATE', 0.3, 1, 'An organisation pays after its own sale closes (about 2 weeks).'),
    formula('o_cash', 'Organisation cash collected by Nov 27', 'USD', 'o_signed * o_wreaths * 30 * o_inwin'),
    { key: 'o_wreath_cost', label: 'Wreath cost', unit: 'USD', kind: 'POSITIVE', min: 0, observations: [
      obs('o_mccarthy', { kind: 'POINT', value: 18.5 }, {}, 'mccarthy-2018', url('https://cdn.shopify.com/s/files/1/0071/2956/3191/files/Wreath-Fundraiser-Letter-2018-1.pdf'), 'group cost 2018'),
      obs('o_armstrong', { kind: 'POINT', value: 30 }, {}, 'armstrong', url('https://www.armstronggarden.com/fundraiser'), 'group cost'),
    ] },
    formula('o_spend', 'Organisation outflows', 'USD', 'o_signed * o_wreaths * o_wreath_cost'),
  ] };
}

/* ------------------------------------------------------------------ G: remote puzzle packs */

function remote(): QuantGraph {
  return { nodes: [
    assume('r_cash', 'Remote pack cash settled by Nov 27', 'USD', 'POSITIVE', 0, 500, 'fast-cash/10k/research-remote-puzzle-lines.md: Stripe’s first payout lands 7–14 days after the first charge.'),
    formula('r_spend', 'Remote outflows', 'USD', 'r_cash * 0.04'),
  ] };
}

export function demandProblem(v: Variant, options: { rho?: number; spendCeiling?: number | null } = {}): QuantProblem {
  const group = 'local-new-operator';
  return {
    title: `$10K plan demand, ${v === 'PLAN' ? 'as the plan wrote it (owner and helpers on site)' : 'remote: no owner physical labour'}, Nov 3–27 2026`,
    currency: 'USD',
    graphs: [
      { key: 'home', graph: home(v) },
      { key: 'mailer', graph: mailer(v) },
      { key: 'gift', graph: gift(v) },
      { key: 'orgs', graph: orgs() },
      { key: 'remote', graph: remote() },
    ],
    report: [
      { graph: 'home', node: 'h_orders' }, { graph: 'home', node: 'h_resp' }, { graph: 'home', node: 'h_book' },
      { graph: 'mailer', node: 'm_slots' }, { graph: 'gift', node: 'g_orders' }, { graph: 'orgs', node: 'o_signed' },
    ],
    portfolio: {
      target: 10_000,
      deadlineDays: 25,
      startingCapital: 375,
      ...(options.spendCeiling === null ? {} : { spendCeiling: options.spendCeiling ?? 3_000 }),
      // One new operator, one metro, one owner's attention, one season: a bad month is bad for every local line.
      riskCorrelation: { [group]: options.rho ?? 0.3 },
      activities: [
        { key: 'home', label: 'A+B+C home services', graph: 'home', cashNode: 'h_cash', spendNode: 'h_spend', days: 18, startDay: 1, capital: v === 'PLAN' ? 190 : 300, riskGroup: group, learnableInExecution: true, researchDays: 6 },
        { key: 'mailer', label: 'D co-op mailer', graph: 'mailer', cashNode: 'm_cash', spendNode: 'm_spend', days: 9, startDay: 1, capital: 15, riskGroup: group, learnableInExecution: true, researchDays: 3 },
        { key: 'gift', label: 'E client gift boxes', graph: 'gift', cashNode: 'g_cash', spendNode: 'g_spend', days: 14, startDay: 2, capital: 45, riskGroup: group, learnableInExecution: true, researchDays: 7 },
        { key: 'orgs', label: 'F wreath fundraisers', graph: 'orgs', cashNode: 'o_cash', spendNode: 'o_spend', days: 22, startDay: 2, capital: 0, riskGroup: group, learnableInExecution: true, researchDays: 9 },
        { key: 'remote', label: 'G remote puzzle packs', graph: 'remote', cashNode: 'r_cash', spendNode: 'r_spend', days: 20, startDay: 1, capital: 0 },
      ],
    },
  };
}

/* ------------------------------------------------------------------ the current plan: online lines, one outreach pool */

/**
 * The plan rebuilt for remote operation (#445): AI-receptionist setups, gift
 * brokerage, trigger lists and puzzle packs, all sold through one pool of
 * interested conversations. One graph and one activity, so every line reads the
 * same pool in the same world (activities from one graph would be drawn apart).
 */
function online(split: { high: number; gift: number; list: number }): QuantGraph {
  const t = { audience: 'smb-owners', sender: 'new-no-case-studies' };
  const RES = 'fast-cash/10k/research-high-ticket-remote.md';
  return { nodes: [
    decide('n_emails', 'Cold emails from one aged mailbox, Nov 4–23', 'emails', 600),
    decide('n_invites', 'LinkedIn invites, Nov 4–23', 'invites', 300),
    {
      key: 'n_reply', label: 'Cold email reply rate', unit: 'share', kind: 'RATE', min: 0, max: 1, context: t, material: [],
      observations: [
        obs('n_belkins', { kind: 'COUNT', successes: 33_750, trials: 7_500_000 }, { audience: 'b2b' }, 'belkins', url('https://belkins.io/blog/cold-email-response-rates.md'), '0.45% of ~7.5M B2B emails, 2025'),
        obs('n_instantly', { kind: 'POINT', value: 0.0343 }, { audience: 'b2b' }, 'instantly', url('https://instantly.ai/blog/cold-email-reply-rate-benchmarks'), 'platform average reply rate 2026'),
        obs('n_salesco', { kind: 'POINT', value: 0.0209 }, { audience: 'b2b' }, 'salesco-2026', url('https://somethinginc.com/blog/cold-email-response-rates-2026-data/'), 'reply rate, Feb 2026'),
        obs('n_hunter', { kind: 'POINT', value: 0.045 }, { audience: 'b2b' }, 'hunter', url('https://hunter.io/the-state-of-cold-email-2025'), 'average reply rate'),
      ],
    },
    {
      key: 'n_positive', label: 'Replies that are interested', unit: 'share', kind: 'RATE', min: 0, max: 1, context: t, material: [],
      observations: [
        obs('n_pos_salesco', { kind: 'POINT', value: 0.141 }, { audience: 'b2b' }, 'salesco-2026', url('https://somethinginc.com/blog/cold-email-response-rates-2026-data/'), '14.1% of replies positive'),
        obs('n_pos_saleshandy', { kind: 'RANGE', low: 0.25, high: 0.5 }, { audience: 'b2b', campaign: 'top-performing' }, 'saleshandy-2026-interest', url('https://saleshandy.com/blog/cold-email-statistics/'), 'strongest campaigns only'),
      ],
    },
    { key: 'n_accept', label: 'LinkedIn invites accepted', unit: 'share', kind: 'RATE', min: 0, max: 1, observations: [
      obs('n_expandi_acc', { kind: 'COUNT', successes: 3_762_000, trials: 13_200_000 }, {}, 'expandi-2026', url('https://expandi.io/blog/linkedin-outreach-benchmarks-2026/'), '28.5% of 13.2M attempts'),
      obs('n_belkins_acc', { kind: 'POINT', value: 0.264 }, {}, 'belkins-linkedin', url('https://belkins.io/blog/linkedin-outreach-study.md'), '26.4% acceptance'),
    ] },
    { key: 'n_li_reply', label: 'Accepted connections who reply (interested share not separated)', unit: 'share', kind: 'RATE', min: 0, max: 1, observations: [
      obs('n_expandi_rep', { kind: 'POINT', value: 0.104 }, {}, 'expandi-2026', url('https://expandi.io/blog/linkedin-outreach-benchmarks-2026/'), '10.4% reply on messages after acceptance'),
    ] },
    // LinkedIn replies are counted as conversations only at the email positive share: a reply is not interest.
    formula('n_conv', 'Interested conversations', 'conversations', 'n_emails * n_reply * n_positive + n_invites * n_accept * n_li_reply * n_positive'),
    assume('n_close_high', 'Conversations that buy a $1,500 AI setup', 'share', 'RATE', 0.05, 0.25, `${RES}: no published close rate for a new seller without case studies.`),
    assume('n_settle_high', 'Setups whose payment settles by Nov 27', 'share', 'RATE', 0.5, 1, 'ACH or wire over $1k; Stripe first payout 7–14 days.'),
    assume('n_close_gift', 'Conversations that place a gift order', 'share', 'RATE', 0.1, 0.4, 'No published rate.'),
    assume('n_gift_order', 'Gross per gift order', 'USD', 'POSITIVE', 690, 3450, '10–50 recipients × $60 × 1.15; recipient count unmeasured.'),
    assume('n_close_list', 'Conversations that buy a list', 'share', 'RATE', 0.1, 0.4, 'No published rate.'),
    assume('n_p_list', 'List price', 'USD', 'POSITIVE', 149, 499, 'Comparable list products.'),
    roundingDraw('n_u1'), roundingDraw('n_u2'), roundingDraw('n_u3'),
    formula('n_high', 'AI setups settled', 'deals', `floor(n_conv * ${split.high} * n_close_high * n_settle_high + n_u1)`),
    formula('n_gift', 'Gift orders', 'orders', `floor(n_conv * ${split.gift} * n_close_gift + n_u2)`),
    formula('n_list', 'Lists sold', 'lists', `floor(n_conv * ${split.list} * n_close_list + n_u3)`),
    assume('n_packs', 'Puzzle-pack cash settled', 'USD', 'POSITIVE', 0, 500, 'fast-cash/10k/research-digital-automated.md.'),
    formula('n_cash', 'Settled cash by Nov 27', 'USD', 'n_high * 1797 + n_gift * n_gift_order + n_list * n_p_list + n_packs'),
    formula('n_spend', 'Outflows', 'USD', 'n_gift * n_gift_order / 1.15 + n_high * 150 + 60 + 0.03 * n_cash'),
  ] };
}

export function onlineProblem(split: { high: number; gift: number; list: number }, options: { spendCeiling?: number | null } = {}): QuantProblem {
  return {
    title: `$10K plan demand, online lines (AI setups ${split.high}, gifts ${split.gift}, lists ${split.list} of the outreach), Nov 3–27 2026`,
    currency: 'USD',
    graphs: [{ key: 'online', graph: online(split) }],
    report: [
      { graph: 'online', node: 'n_reply' }, { graph: 'online', node: 'n_positive' }, { graph: 'online', node: 'n_conv' },
      { graph: 'online', node: 'n_high' }, { graph: 'online', node: 'n_gift' }, { graph: 'online', node: 'n_list' },
    ],
    portfolio: {
      target: 10_000, deadlineDays: 25, startingCapital: 375,
      ...(options.spendCeiling === null ? {} : { spendCeiling: options.spendCeiling ?? 3_000 }),
      activities: [{ key: 'online', label: 'Online lines on one outreach pool', graph: 'online', cashNode: 'n_cash', spendNode: 'n_spend', days: 20, startDay: 1, capital: 60, learnableInExecution: true, researchDays: 7 }],
    },
  };
}

if (process.argv[1]?.endsWith('demand-model.ts')) {
  const now = new Date('2026-11-02T23:00:00Z');
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
  for (const v of ['PLAN', 'REMOTE'] as const) {
    const s = solveProblem(demandProblem(v), now);
    console.log(`\n=== ${s.title}`);
    for (const e of s.estimates.filter((one) => /^(h_orders|h_resp|h_book|h_cash|h_spend|m_slots|m_cash|g_reply|g_orders|g_cash|o_signed|o_cash|r_cash)$/.test(one.key))) {
      console.log(`  ${e.tier.padEnd(10)} ${e.key.padEnd(9)} p10 ${e.p10.toFixed(e.p50 < 1 ? 4 : 0)}  p50 ${e.p50.toFixed(e.p50 < 1 ? 4 : 0)}  p90 ${e.p90.toFixed(e.p50 < 1 ? 4 : 0)}  ${e.justified ? 'distribution' : 'bounds only'}`);
    }
    for (const ceiling of [3_000, null] as const) {
      for (const rho of [0, 0.3, 0.6]) {
        const r = solveProblem(demandProblem(v, { rho, spendCeiling: ceiling }), now).portfolio!;
        const b = r.best!;
        console.log(`  ceiling ${ceiling === null ? 'none ' : '$3,000'} rho ${rho.toFixed(1)}: best ${b.keys.join('+')} reaches $10k in ${pct(b.reach)} (settled p10 ${usd(b.settledP10)} p50 ${usd(b.settledP50)} p90 ${usd(b.settledP90)}; over the ceiling ${pct(b.overSpend)}; basis ${b.basis})`);
      }
    }
    for (const q of s.questions.slice(0, 6)) console.log(`  question ${q.key}: reach ${pct(q.reachAtP10)} at p10 → ${pct(q.reachAtP90)} at p90 · ${q.decision}`);
    if (process.argv.includes('--write')) {
      const file = `plans/quant/cash-10k-demand-${v.toLowerCase()}-2026-11-02.json`;
      writeFileSync(file, `${JSON.stringify(demandProblem(v), null, 2)}\n`);
      console.log(`  wrote ${file}`);
    }
  }
  for (const [name, split] of [['high_focus', { high: 0.5, gift: 0.3, list: 0.2 }], ['gift_focus', { high: 0.2, gift: 0.7, list: 0.1 }]] as const) {
    const s = solveProblem(onlineProblem(split), now);
    console.log(`\n=== ONLINE ${name}: ${s.title}`);
    for (const e of s.estimates.filter((one) => /^n_(reply|positive|conv|high|gift|list|cash|spend)$/.test(one.key))) {
      console.log(`  ${e.tier.padEnd(10)} ${e.key.padEnd(10)} p10 ${e.p10.toFixed(e.p50 < 1 ? 4 : 0)}  p50 ${e.p50.toFixed(e.p50 < 1 ? 4 : 0)}  p90 ${e.p90.toFixed(e.p50 < 1 ? 4 : 0)}  ${e.justified ? 'distribution' : 'bounds only'}`);
    }
    for (const ceiling of [3_000, null] as const) {
      const b = solveProblem(onlineProblem(split, { spendCeiling: ceiling }), now).portfolio!.best!;
      console.log(`  ceiling ${ceiling === null ? 'none ' : '$3,000'}: reaches $10k in ${pct(b.reach)} (settled p10 ${usd(b.settledP10)} p50 ${usd(b.settledP50)} p90 ${usd(b.settledP90)}; over the ceiling ${pct(b.overSpend)}; basis ${b.basis})`);
    }
    if (process.argv.includes('--write')) {
      const file = `plans/quant/cash-10k-demand-online-${name.replace('_', '-')}-2026-11-02.json`;
      writeFileSync(file, `${JSON.stringify(onlineProblem(split), null, 2)}\n`);
      console.log(`  wrote ${file}`);
    }
  }
}

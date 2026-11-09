/**
 * The $10K plan, rebuilt 2026-11-09 for a 30-day window (Nov 9 → Dec 9 2026).
 *
 *   npx tsx fast-cash/10k/plan-model-2026-11-09.ts
 *
 * What changed from plan-model-remote.ts (Nov 3, 60 touches a day):
 *  - Outreach is the owner's Instantly workspace (§94): 12 healthy accounts,
 *    930 sends a day measured, shared with the owner's own campaigns, so
 *    Brain's share is a range, not the whole figure.
 *  - Nothing sends until the owner grants CONTACT_BUYER (a person's decision,
 *    docs/CASH-DEPLOYMENT.md "Three grants"); the start day is a range.
 *  - Failures are CORRELATED on purpose. One reply-rate factor (deliverability
 *    and how the market reads a cold email) and one credibility factor (a new
 *    seller with no case studies) are drawn once per world and applied to
 *    every line, plus one deliverability incident that cuts every line's
 *    volume at once. Nothing is multiplied as if independent.
 *  - Deals are counted, not averaged: replies are Poisson, closes Binomial,
 *    so small numbers carry their real noise.
 *  - Collected cash is GROSS money received by Dec 9 (what the ledger counts)
 *    and NET after supplier cost and fees, both reported.
 *
 * Every rate not measured for this operation is a published range, swept.
 * The result is coverage of the stated ranges, NOT a defensible probability
 * (§95): no input here is this Brain's own measurement yet.
 *
 * Sources (all published):
 *  - Cold reply rate 0.45% (Belkins, 7.5M emails 2025) to 3.43% (Instantly
 *    2026 benchmark, 2025 data); ~14.1% of replies positive (Prospeo/Instantly).
 *  - Employee gift ≈ $62 average (Tremendous 2025), $63.66 (Custom Ink 2025).
 *  - Gift order cut-offs Dec 5–18 (Marigold & Grey, Bake Me a Wish, Goldbelly
 *    2+ weeks for 15+ packages).
 *  - AI receptionist setup $1,500–5,500 published agency fees
 *    (fast-cash/10k/research-high-ticket-remote.md).
 *  - Facebook lead-form CPL, home services ~$41 (WordStream);
 *    exclusive lead $34–43 (Service Direct).
 */

type Range = readonly [number, number];
const u = (r: Range, x: number) => r[0] + (r[1] - r[0]) * x;

// A small deterministic PRNG so the run is reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function poisson(lambda: number, r: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda > 60) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(r)));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= r();
  } while (p > L);
  return k - 1;
}
function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
}
function binom(n: number, p: number, r: () => number) {
  let k = 0;
  for (let i = 0; i < n; i++) if (r() < p) k++;
  return k;
}

/** One revenue line: the share of sends it takes, and its economics. */
interface Line {
  key: string;
  label: string;
  /** Last day (from Nov 9 = day 0) a send can still turn into collected cash by Dec 9. */
  lastUsefulSendDay: number;
  close: Range; // positive conversation → paid order, at credibility factor 1
  ticket: Range; // gross per paid order, USD
  costShare: Range; // supplier / tool cost as a share of gross
  settled: Range; // share of closed orders whose money arrives by Dec 9
}

export const LINES: Line[] = [
  // Year-end client and employee gifts: supplier drop-ships, client prepays.
  // Cut-offs Dec 5–18 bound when an order can still be placed.
  { key: 'gift', label: 'Corporate year-end gift brokerage', lastUsefulSendDay: 21, close: [0.08, 0.3], ticket: [690, 3450], costShare: [0.8, 0.87], settled: [0.85, 1] },
  // AI receptionist / missed-call text-back setups for home-service firms,
  // fulfilled on a white-label tool; setup fee invoiced.
  { key: 'ai', label: 'AI receptionist setups (home-service firms)', lastUsefulSendDay: 18, close: [0.04, 0.2], ticket: [1500, 2297], costShare: [0.05, 0.15], settled: [0.5, 0.95] },
  // Trigger / prospect lists Brain compiles from public business records.
  { key: 'list', label: 'Trigger lists (Brain-produced data)', lastUsefulSendDay: 25, close: [0.1, 0.35], ticket: [149, 499], costShare: [0, 0.05], settled: [0.9, 1] },
  // Puzzle licence packs for senior-living activity directors (Brain generates puzzles).
  { key: 'puzzle', label: 'Puzzle licence packs (senior living)', lastUsefulSendDay: 25, close: [0.05, 0.25], ticket: [49, 199], costShare: [0, 0.03], settled: [0.9, 1] },
];

export interface Strategy {
  key: string;
  label: string;
  shares: Record<string, number>;
  ads: number; // lead-brokerage ad spend, USD (needs SPEND_FROM_ALLOWANCE)
}

export const STRATEGIES: Strategy[] = [
  { key: 'gift_lead', label: 'Gifts first (seasonal), AI setups second', shares: { gift: 0.55, ai: 0.3, list: 0.1, puzzle: 0.05 }, ads: 0 },
  { key: 'balanced', label: 'Balanced four lines', shares: { gift: 0.35, ai: 0.35, list: 0.15, puzzle: 0.15 }, ads: 0 },
  { key: 'ai_lead', label: 'AI setups first', shares: { gift: 0.25, ai: 0.6, list: 0.1, puzzle: 0.05 }, ads: 0 },
  { key: 'gift_lead_ads', label: 'Gifts first + $300 lead brokerage', shares: { gift: 0.55, ai: 0.3, list: 0.1, puzzle: 0.05 }, ads: 300 },
];

export interface Assumptions {
  brainSendsPerDay: Range; // Brain's share of the 930/day the workspace can send
  startDay: Range; // days until the CONTACT_BUYER grant and first send
  replyRate: Range; // all replies / sends
  positiveShare: Range; // positive replies / replies
  credibility: Range; // one multiplier on every close rate (new seller)
  incidentChance: number; // deliverability incident (blocklist, domain burn)
  incidentCut: Range; // share of volume lost after it
}

export const NOV9: Assumptions = {
  brainSendsPerDay: [150, 600],
  startDay: [1, 6],
  replyRate: [0.0045, 0.0343],
  positiveShare: [0.1, 0.2],
  credibility: [0.5, 1.1],
  incidentChance: 0.15,
  incidentCut: [0.3, 0.8],
};

/**
 * The same plan on the owner's OWN measured rates (Instantly analytics, read
 * 2026-11-09, read-only): four campaigns, 4,096 sends, 15 unique replies
 * (0.37%; Wilson 90% ≈ 0.24–0.55%), 2 opportunities among 15 replies, 396
 * bounces (9.7%). This is this workspace's evidence, and it outranks the
 * published ranges above (§92: OBSERVED beats ESTIMATE).
 */
export const MEASURED: Assumptions = {
  ...NOV9,
  replyRate: [0.0024, 0.0055],
  positiveShare: [0.04, 0.35],
};

export interface Outcome {
  gross: number;
  net: number;
  byLine: Record<string, number>;
  positives: number;
}

export function simulate(strategy: Strategy, a: Assumptions, worlds: number, seed = 20261109): Outcome[] {
  const r = rng(seed);
  const out: Outcome[] = [];
  for (let w = 0; w < worlds; w++) {
    // Shared, correlated draws: one per world, applied to every line.
    const perDay = u(a.brainSendsPerDay, r());
    const start = Math.round(u(a.startDay, r()));
    const reply = u(a.replyRate, r());
    const positive = u(a.positiveShare, r());
    const cred = u(a.credibility, r());
    const incident = r() < a.incidentChance;
    const incidentDay = start + Math.floor(r() * 14);
    const cut = u(a.incidentCut, r());
    const byLine: Record<string, number> = {};
    let gross = 0;
    let net = 0;
    let positives = 0;
    for (const line of LINES) {
      const share = strategy.shares[line.key] ?? 0;
      let sends = 0;
      for (let d = start; d <= line.lastUsefulSendDay; d++) sends += perDay * share * (incident && d >= incidentDay ? 1 - cut : 1);
      const pos = poisson(sends * reply * positive, r);
      positives += pos;
      const closed = binom(pos, Math.min(1, u(line.close, r()) * cred), r);
      const paid = binom(closed, u(line.settled, r()), r);
      let g = 0;
      for (let i = 0; i < paid; i++) g += u(line.ticket, r());
      const c = g * u(line.costShare, r()) + g * 0.03;
      byLine[line.key] = g;
      gross += g;
      net += g - c;
    }
    if (strategy.ads > 0) {
      const cpl = u([25, 60], r());
      const leads = Math.floor(strategy.ads / cpl);
      const sold = binom(leads, u([0.4, 0.9], r()) * cred, r);
      const g = sold * u([20, 43], r());
      byLine['leads'] = g;
      gross += g;
      net += g - strategy.ads;
    }
    out.push({ gross, net, byLine, positives });
  }
  return out;
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
/** Wilson lower bound, the same test §95 applies before calling a reach a probability. */
export function wilsonLower(k: number, n: number, z = 1.645) {
  if (n === 0) return 0;
  const p = k / n;
  const d = 1 + (z * z) / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
}

export function summarize(strategy: Strategy, a: Assumptions, worlds = 20_000) {
  const res = simulate(strategy, a, worlds);
  const gross = res.map((o) => o.gross);
  const net = res.map((o) => o.net);
  const hit = res.filter((o) => o.gross >= 10_000).length;
  const hitNet = res.filter((o) => o.net >= 10_000).length;
  const lines: Record<string, number> = {};
  for (const o of res) for (const [k, v] of Object.entries(o.byLine)) lines[k] = (lines[k] ?? 0) + v / worlds;
  return {
    strategy: strategy.key,
    label: strategy.label,
    grossP10: q(gross, 0.1),
    grossP50: q(gross, 0.5),
    grossP90: q(gross, 0.9),
    netP50: q(net, 0.5),
    reachGross: hit / worlds,
    reachNet: hitNet / worlds,
    positivesP50: q(res.map((o) => o.positives), 0.5),
    meanByLine: lines,
  };
}

/** What the inputs would have to be for 90%: hold every other range, move one. */
export function whatRaisesConfidence(strategy: Strategy) {
  const probes: { name: string; a: Assumptions }[] = [
    { name: 'measured reply ≥ 2.5% (first 1,000 sends)', a: { ...NOV9, replyRate: [0.025, 0.0343] } },
    { name: 'Brain sends 600/day (owner dedicates the workspace)', a: { ...NOV9, brainSendsPerDay: [600, 600] } },
    { name: 'grant today (start day 1)', a: { ...NOV9, startDay: [1, 1] } },
    { name: 'credibility at published close rates (case study / referral)', a: { ...NOV9, credibility: [1, 1.1] } },
    { name: 'all four together', a: { ...NOV9, replyRate: [0.025, 0.0343], brainSendsPerDay: [600, 600], startDay: [1, 1], credibility: [1, 1.1] } },
  ];
  return probes.map((p) => ({ name: p.name, ...summarize(strategy, p.a, 8_000) }));
}

if (process.argv[1]?.endsWith('plan-model-2026-11-09.ts')) {
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log('$10K by 2026-12-09 — correlated simulation, 20,000 worlds per strategy (coverage of published ranges, not a probability)\n');
  const all = STRATEGIES.map((s) => summarize(s, NOV9));
  for (const s of all) {
    console.log(`${s.strategy}: ${s.label}`);
    console.log(`  gross collected p10 ${usd(s.grossP10)} · p50 ${usd(s.grossP50)} · p90 ${usd(s.grossP90)} · net p50 ${usd(s.netP50)}`);
    console.log(`  reach $10k gross ${pct(s.reachGross)} (Wilson lower ${pct(wilsonLower(Math.round(s.reachGross * 20_000), 20_000))}) · net ${pct(s.reachNet)} · positive conversations p50 ${s.positivesP50}`);
    console.log(`  mean by line ${Object.entries(s.meanByLine).map(([k, v]) => `${k} ${usd(v)}`).join(' · ')}`);
  }
  console.log('\nOn the workspace\'s own measured reply and positive rates (0.24–0.55% reply, 4–35% positive):');
  for (const s of STRATEGIES.map((x) => summarize(x, MEASURED))) {
    console.log(`  ${s.strategy.padEnd(14)} gross p10 ${usd(s.grossP10)} · p50 ${usd(s.grossP50)} · p90 ${usd(s.grossP90)} · reach $10k ${pct(s.reachGross)} (Wilson lower ${pct(wilsonLower(Math.round(s.reachGross * 20_000), 20_000))})`);
  }
  const best = all.reduce((x, y) => (y.reachGross > x.reachGross ? y : x));
  console.log(`\nBest: ${best.strategy}. What would raise confidence (one input moved, the rest held):`);
  for (const p of whatRaisesConfidence(STRATEGIES.find((s) => s.key === best.strategy)!)) {
    console.log(`  ${p.name.padEnd(62)} reach ${pct(p.reachGross)} · p10 ${usd(p.grossP10)} · p50 ${usd(p.grossP50)}`);
  }
}

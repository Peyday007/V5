/**
 * The probe reader for META-18-1 (S-0191, S-0192): no anchoring to the owner's
 * example categories, and an unfamiliar category can outrank familiar ones.
 *
 * Read-only. For every project it reads the live industry map and its
 * constraints through the existing repositories, ranks them exactly as a
 * goal's discovery does (`rankSubjectMarkets`), and demonstrates on those rows:
 *
 * 1. every live subject is ranked — no shortlist, fixed count or quota;
 * 2. the order is label-invariant — each subject's evidence, scored again with
 *    its label replaced by a neutral token, keeps its place, and the order the
 *    production ranker gave is the order its evidence earns;
 * 3. seed origin confers no advantage — the same rows ranked with every origin
 *    set to SEED, and again to DISCOVERED, give the same order and scores;
 * 4. the criteria each place rests on are economics, scale, time to cash,
 *    capital, feasibility and risk, each a finite reading on every subject.
 *
 * It also scans `server/services/industry` for a category whitelist: a
 * constant holding the example categories, or named as an allow-list,
 * shortlist or quota. None may narrow the search.
 *
 * Each subject's evidence is its subtree on the map and the facts research
 * filed under that subtree (`subjectEvidence`, the read `rankSubjectMarkets`
 * makes); since W-9 no reference pack is looked up by a map subject's name.
 * The label is still replaced in the assembled evidence rather than on the
 * node, so the demonstration asks exactly the requirement's question — does
 * the score read the name — whatever the evidence was assembled from.
 *
 * No table, scheduler, store or authority path: it reads rows the industry,
 * construction-fact and project repositories already serve and writes nothing.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { listConstraintsForProject, listNodes } from '../../../repos/industry.ts';
import { listProjectConstructionFacts } from '../../../repos/construction.ts';
import { listProjects } from '../../../repos/projects.ts';
import type { IndustryNode, OpportunityConstraint } from '../../../domain/types.ts';
import type { Fact, IndustryEvidence } from '../../../domain/construction.ts';
import { marketOfEvidence, rankMarkets, rankSubjectMarkets, subjectEvidence, type MarketCandidate, type MarketCriteria, type RankedSubject } from './origins.ts';

/** The criteria a place in the ranking rests on, and the reading of each (META-18-1). */
export const RANKING_CRITERIA = {
  economics: 'monthlyContributionUsd',
  scale: 'monthlyContributionUsd',
  'time to cash': 'timeFactor',
  capital: 'capitalFactor',
  feasibility: 'feasibility',
  risk: 'riskFactor',
} as const satisfies Record<string, keyof MarketCriteria>;
export type RankingCriterion = keyof typeof RANKING_CRITERIA;

/** The owner's example categories (S-0191). Named only so the scan can prove no constant narrows the search to them. */
const EXAMPLE_CATEGORY = /^(?:insurance\s+)?(?:brokerage|subcontract(?:ing|or|ors)?|distribution|insurance|manufactur(?:e|ing|er|ers))$/i;
const WHITELIST_NAME = /(?:WHITE_?LIST|ALLOW_?LIST|SHORT_?LIST|ALLOWED_(?:INDUSTR|CATEGOR|SUBJECT)|PREFERRED_(?:INDUSTR|CATEGOR|SUBJECT)|(?:INDUSTRY|CATEGORY)_(?:QUOTA|LIST|WHITELIST)|FAMILIAR_(?:INDUSTR|CATEGOR))/i;

export type AnchoringViolationKind = 'UNRANKED' | 'LABEL_ANCHORED' | 'RANKER_DIVERGED' | 'ORIGIN_ADVANTAGE' | 'CRITERIA_MISSING' | 'WHITELIST';

export interface AnchoringViolation {
  kind: AnchoringViolationKind;
  projectId: string | null;
  detail: string;
}

export interface WhitelistFinding {
  file: string;
  constant: string;
  why: string;
}

export interface SubjectCheck {
  live: number;
  ranked: number;
  /** Ranked subjects whose evidence gives them a score above zero. */
  scored: number;
  /**
   * Whether the evidence decides this project's order: at least two subjects
   * with different scores. When every score is equal (typically all zero, no
   * economics recorded) the order is the row order, and label-invariance and
   * origin-neutrality hold trivially — they demonstrate nothing.
   */
  discriminating: boolean;
  violations: AnchoringViolation[];
}

export interface AnchoringReport {
  ok: boolean;
  detail: string;
  projects: number;
  live: number;
  ranked: number;
  /** Ranked subjects scored above zero by their evidence. */
  scored: number;
  /** Projects whose order the evidence decides (two or more distinct scores); a pass needs at least one. */
  discriminating: number;
  /** Live subjects a person seeded, and those Brain discovered: both are ranked by the same criteria. */
  seeded: number;
  discovered: number;
  criteria: RankingCriterion[];
  filesScanned: number;
  whitelists: WhitelistFinding[];
  violations: AnchoringViolation[];
}

/** The ranker under test; production passes `rankSubjectMarkets`, a test may pass one that misbehaves. */
export type SubjectRanker = (nodes: readonly IndustryNode[], constraints: readonly OpportunityConstraint[], recorded: readonly Fact[]) => Promise<RankedSubject[]>;
/** How one subject's evidence becomes a market; production uses `marketOfEvidence` over its commercial roles. */
export type EvidenceScorer = (key: string, evidence: IndustryEvidence) => MarketCandidate;

export interface CheckOptions {
  rank?: SubjectRanker;
  score?: EvidenceScorer;
  /** The project's recorded construction facts; each subject reads those filed under its own subtree. */
  recorded?: readonly Fact[];
}

const orderOf = (ranked: readonly RankedSubject[]) => ranked.map((r) => r.node.id);
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

async function defaultScorer(): Promise<EvidenceScorer> {
  const { commercialRoles } = await import('./roles.ts');
  return (key, evidence) => marketOfEvidence(key, evidence, commercialRoles(evidence));
}

/**
 * The four demonstrations on one project's rows. Reads nothing beyond its
 * arguments and writes nothing; the ranker and scorer default to production's.
 */
export async function checkSubjects(
  projectId: string | null,
  nodes: readonly IndustryNode[],
  constraints: readonly OpportunityConstraint[],
  options: CheckOptions = {},
): Promise<SubjectCheck> {
  const rank = options.rank ?? rankSubjectMarkets;
  const score = options.score ?? (await defaultScorer());
  const recorded = options.recorded ?? [];
  const violations: AnchoringViolation[] = [];
  const live = nodes.filter((n) => !n.retiredAt);
  if (live.length === 0) return { live: 0, ranked: 0, scored: 0, discriminating: false, violations };
  const ranked = await rank(nodes, constraints, recorded);
  const order = orderOf(ranked);

  // (1) Every live subject ranked, once: no shortlist, fixed count or quota.
  const liveIds = new Set(live.map((n) => n.id));
  const rankedIds = new Set(order);
  const missing = live.filter((n) => !rankedIds.has(n.id)).length;
  const extra = order.filter((id) => !liveIds.has(id)).length;
  if (missing > 0 || extra > 0 || rankedIds.size !== order.length) {
    violations.push({ kind: 'UNRANKED', projectId, detail: `${live.length} live subject(s), ${order.length} ranked (${missing} left out, ${extra} not live, ${order.length - rankedIds.size} repeated)` });
  }

  // (2) Label-invariance: the order each subject's evidence earns does not move when its label is a neutral token.
  const width = String(live.length).length;
  const labelled: MarketCandidate[] = [];
  const neutral: MarketCandidate[] = [];
  const idOfKey = new Map<string, string>();
  for (const [index, node] of live.entries()) {
    const evidence = await subjectEvidence(live, node, constraints, recorded);
    const key = `${String(index).padStart(width, '0')}:${node.id}`;
    idOfKey.set(key, node.id);
    labelled.push(score(key, evidence));
    const renamed = JSON.parse(JSON.stringify(evidence)) as IndustryEvidence;
    renamed.industry = `subject-${String(index).padStart(width, '0')}`;
    neutral.push(score(key, renamed));
  }
  const earned = rankMarkets(labelled).map((m) => idOfKey.get(m.key)!);
  const unlabelled = rankMarkets(neutral).map((m) => idOfKey.get(m.key)!);
  if (!same(earned, unlabelled)) {
    const moved = earned.filter((id, i) => unlabelled[i] !== id).length;
    violations.push({ kind: 'LABEL_ANCHORED', projectId, detail: `${moved} of ${earned.length} subject(s) change place when their label is replaced by a neutral token` });
  }
  if (missing === 0 && extra === 0 && !same(order, earned)) {
    const moved = order.filter((id, i) => earned[i] !== id).length;
    violations.push({ kind: 'RANKER_DIVERGED', projectId, detail: `${moved} of ${order.length} subject(s) sit where their evidence does not put them` });
  }

  // (3) Seed origin confers no advantage: every origin set to SEED, then to DISCOVERED, ranks the same.
  for (const origin of ['SEED', 'DISCOVERED'] as const) {
    const flipped = await rank(nodes.map((n) => ({ ...n, origin })), constraints, recorded);
    const scores = ranked.map((r) => r.criteria.score);
    const flippedScores = flipped.map((r) => r.criteria.score);
    if (!same(orderOf(flipped), order) || !same(flippedScores.map(String), scores.map(String))) {
      violations.push({ kind: 'ORIGIN_ADVANTAGE', projectId, detail: `ranking every subject as ${origin} changes the order or the scores` });
    }
  }

  // (4) Each place rests on the stated criteria, each a finite reading.
  const lacking = new Set<string>();
  for (const r of ranked) {
    for (const [criterion, field] of Object.entries(RANKING_CRITERIA)) {
      const v = (r.criteria as Partial<MarketCriteria>)[field];
      if (typeof v !== 'number' || !Number.isFinite(v)) lacking.add(criterion);
    }
  }
  if (lacking.size > 0) violations.push({ kind: 'CRITERIA_MISSING', projectId, detail: `no finite reading for ${[...lacking].join(', ')}` });

  const scores = ranked.map((r) => r.criteria.score).filter((v) => Number.isFinite(v));
  const scored = scores.filter((v) => v > 0).length;
  const discriminating = new Set(scores).size >= 2;
  return { live: live.length, ranked: order.length, scored, discriminating, violations };
}

/**
 * Constants in source that would narrow the search to named categories: an
 * array or Set literal holding two or more of the owner's example categories,
 * or a constant named as an allow-list, shortlist or category quota. Pure.
 */
export function findCategoryWhitelists(files: ReadonlyArray<{ path: string; text: string }>): WhitelistFinding[] {
  const found: WhitelistFinding[] = [];
  const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:new\s+Set\s*(?:<[^>]*>)?\(\s*)?\[([^\]]*)\]/g;
  for (const f of files) {
    for (const m of f.text.matchAll(decl)) {
      const name = m[1]!;
      const literals = [...m[2]!.matchAll(/(['"`])([^'"`]*)\1/g)].map((s) => s[2]!.trim());
      const examples = literals.filter((s) => EXAMPLE_CATEGORY.test(s));
      if (examples.length >= 2) found.push({ file: f.path, constant: name, why: `holds example categories ${examples.join(', ')}` });
      else if (WHITELIST_NAME.test(name)) found.push({ file: f.path, constant: name, why: 'named as a category allow-list, shortlist or quota' });
    }
  }
  return found;
}

/** Every TypeScript source file under a directory, this reader excluded (it names the examples in order to look for them). */
async function sourcesUnder(root: string, dir: string, self: string): Promise<Array<{ path: string; text: string }>> {
  const out: Array<{ path: string; text: string }> = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourcesUnder(root, full, self)));
    else if (entry.name.endsWith('.ts') && full !== self) out.push({ path: relative(root, full), text: await readFile(full, 'utf8') });
  }
  return out;
}

/**
 * Reads every project's live industry map through the existing repositories
 * and reports whether META-18-1 holds on it. Writes nothing. Holds only when
 * there is at least one live subject to demonstrate on, every one is ranked,
 * the order is label-invariant, seed origin confers no advantage, every place
 * rests on the stated criteria, and no category whitelist exists in source.
 */
export async function noAnchoringHoldsOnRows(): Promise<AnchoringReport> {
  const projects = await listProjects();
  const violations: AnchoringViolation[] = [];
  let live = 0;
  let ranked = 0;
  let scored = 0;
  let discriminating = 0;
  let seeded = 0;
  let discovered = 0;
  const score = await defaultScorer();
  for (const p of projects) {
    const [nodes, constraints, recorded] = await Promise.all([listNodes(p.id), listConstraintsForProject(p.id), listProjectConstructionFacts(p.id)]);
    for (const n of nodes) if (!n.retiredAt) { if (n.origin === 'SEED') seeded += 1; else discovered += 1; }
    const check = await checkSubjects(p.id, nodes, constraints, { score, recorded });
    live += check.live;
    ranked += check.ranked;
    scored += check.scored;
    if (check.discriminating) discriminating += 1;
    violations.push(...check.violations);
  }

  const self = new URL(import.meta.url).pathname;
  const industryDir = join(self, '..', '..');
  const repoRoot = join(industryDir, '..', '..', '..');
  let files: Array<{ path: string; text: string }> = [];
  let scanError: string | null = null;
  try {
    files = await sourcesUnder(repoRoot, industryDir, self);
  } catch (err) {
    scanError = err instanceof Error ? err.message : String(err);
  }
  const whitelists = findCategoryWhitelists(files);
  for (const w of whitelists) violations.push({ kind: 'WHITELIST', projectId: null, detail: `${w.file}: ${w.constant} ${w.why}` });

  const criteria = Object.keys(RANKING_CRITERIA) as RankingCriterion[];
  const counts: Partial<Record<AnchoringViolationKind, number>> = {};
  for (const v of violations) counts[v.kind] = (counts[v.kind] ?? 0) + 1;
  // A pass must demonstrate something: an order the evidence decides somewhere, not only row order.
  const ok = live > 0 && discriminating > 0 && violations.length === 0 && scanError === null;
  const detail =
    `${ranked} of ${live} live subject(s) ranked across ${projects.length} project(s) (${seeded} seeded, ${discovered} discovered); ` +
    `${scored} scored above zero, ${discriminating} project(s) whose order the evidence decides; ` +
    `criteria: ${criteria.join(', ')}; ` +
    (scanError ? `source scan failed: ${scanError}; ` : `${files.length} industry source file(s) scanned, ${whitelists.length} category whitelist(s); `) +
    (violations.length === 0 ? 'order label-invariant and origin-neutral' : `violations: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(', ')} — ${violations.slice(0, 5).map((v) => v.detail).join('; ')}`) +
    (live === 0
      ? '; no live subject to demonstrate on'
      : discriminating === 0
        ? '; vacuous: no project has two subjects its evidence scores differently, so the order is row order and the invariance demonstrates nothing'
        : '');
  return { ok, detail, projects: projects.length, live, ranked, scored, discriminating, seeded, discovered, criteria, filesScanned: files.length, whitelists, violations };
}

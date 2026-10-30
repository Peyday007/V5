/**
 * Which ways of looking actually find openings worth having, counted from rows.
 *
 * Discovery asked many questions and nothing recorded which of them paid off,
 * so every new search started from scratch and a way of looking that only ever
 * produced noise was asked again exactly like one that produced real work.
 * This reads it back: for every way Brain looked — a discovery bucket, a goal's
 * search angle, the feed shortlist — and for every source an opening came from,
 * how many openings it filed, how many reached a real candidate or better, and
 * what it cost in research. Rows only; it decides nothing and writes nothing.
 *
 * "Useful" is the tier the card already derives — CANDIDATE or above means a
 * payer and a way to capture the money are known — so this measures the same
 * thing the rest of Cash Mode does rather than a second idea of quality.
 */
import { getDb } from '../../db/database.ts';
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { listRounds } from '../../repos/cashDiscovery.ts';
import type { CashCardFact } from '../../domain/types.ts';
import { cashTier, tierRank } from './tier.ts';
import { cashEngineCard } from './engineCard.ts';
import { evidenceCard } from './card.ts';
import { hostOf } from '../research/gate.ts';
import { openingsWithSourceUrl } from '../../repos/cashPortfolio.ts';
import { openingSourceKey } from './duplicates.ts';
import { sourceYield } from '../collect/metrics/read.ts';
import type { OpeningOutcome } from '../collect/metrics/yield.ts';
import type { SourceYieldRow } from '../collect/metrics/yield.ts';

export interface YieldRow {
  /** The bucket id, or a source host. */
  key: string;
  rounds: number;
  /** Rounds whose research ended without filing anything. */
  failedRounds: number;
  /** Research fragments spent on those rounds. */
  fragments: number;
  openings: number;
  /** Openings at CANDIDATE or above: a payer and a capture path are known. */
  useful: number;
  qualified: number;
  duplicates: number;
}

export interface DiscoveryYield {
  byMethod: YieldRow[];
  bySource: YieldRow[];
  /** Collected feeds, judged on what their leads became. */
  byFeed: SourceYieldRow[];
}

const empty = (key: string): YieldRow => ({ key, rounds: 0, failedRounds: 0, fragments: 0, openings: 0, useful: 0, qualified: 0, duplicates: 0 });

export async function discoveryYield(projectId: string): Promise<DiscoveryYield> {
  const rounds = await listRounds(projectId);
  const roundOf = new Map(rounds.map((one) => [one.candidateId, one]));
  const methods = new Map<string, YieldRow>();
  const sources = new Map<string, YieldRow>();
  const row = (map: Map<string, YieldRow>, key: string) => {
    const existing = map.get(key);
    if (existing) return existing;
    const made = empty(key);
    map.set(key, made);
    return made;
  };

  const fragments = await fragmentsByCandidate(rounds.map((one) => one.candidateId));
  for (const round of rounds) {
    const m = row(methods, round.bucketId);
    m.rounds += 1;
    m.fragments += fragments.get(round.candidateId) ?? 0;
    if (round.state === 'ABANDONED') m.failedRounds += 1;
  }

  const facts = new Map<string, CashCardFact[]>();
  for (const fact of await cardFactsForProject(projectId)) {
    facts.set(fact.opportunityId, [...(facts.get(fact.opportunityId) ?? []), fact]);
  }
  const hosts = await sourceHosts(projectId);
  const outcomes: OpeningOutcome[] = [];
  const urlKeys = new Map((await openingsWithSourceUrl(projectId)).map((o) => [o.opportunity.id, o]));
  for (const opportunity of await listOpportunities({ projectId })) {
    const round = opportunity.discoveredByCandidateId ? roundOf.get(opportunity.discoveredByCandidateId) : undefined;
    const method = row(methods, round?.bucketId ?? 'unattributed');
    const source = row(sources, hosts.get(opportunity.id) ?? 'unknown source');
    for (const one of [method, source]) {
      if (opportunity.duplicateOfId) {
        one.duplicates += 1;
        continue;
      }
      one.openings += 1;
    }
    if (opportunity.duplicateOfId) continue;
    const tier = cashTier({
      opportunity,
      card: cashEngineCard({ opportunity, facts: facts.get(opportunity.id) ?? [] }),
      readiness: evidenceCard(opportunity).readiness,
    }).tier;
    const held = urlKeys.get(opportunity.id);
    outcomes.push({
      urlKey: openingSourceKey(held?.sourceUrl),
      verified: !!held?.hasWork,
      useful: tierRank(tier) >= tierRank('CANDIDATE'),
      qualified: tierRank(tier) >= tierRank('QUALIFIED'),
    });
    if (tierRank(tier) >= tierRank('CANDIDATE')) {
      method.useful += 1;
      source.useful += 1;
    }
    if (tierRank(tier) >= tierRank('QUALIFIED')) {
      method.qualified += 1;
      source.qualified += 1;
    }
  }
  const order = (a: YieldRow, b: YieldRow) => b.qualified - a.qualified || b.useful - a.useful || b.openings - a.openings || a.key.localeCompare(b.key);
  return { byMethod: [...methods.values()].sort(order), bySource: [...sources.values()].sort(order), byFeed: await sourceYield(outcomes) };
}

/** Research fragments each discovery idea's missions spent. */
async function fragmentsByCandidate(candidateIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < candidateIds.length; i += 200) {
    const chunk = candidateIds.slice(i, i + 200);
    if (chunk.length === 0) continue;
    const rows = await getDb().all<{ candidate_id: string; n: number }>(
      `SELECT m.candidate_id AS candidate_id, COUNT(f.id) AS n
         FROM russell_missions m JOIN research_fragments f ON f.orchestration_id = m.orchestration_id
        WHERE m.candidate_id IN (${chunk.map(() => '?').join(', ')})
        GROUP BY m.candidate_id`,
      chunk,
    );
    for (const one of rows) out.set(one.candidate_id, Number(one.n));
  }
  return out;
}

/** The host of the claim each opening came from. */
async function sourceHosts(projectId: string): Promise<Map<string, string>> {
  const rows = await getDb().all<{ id: string; url: string | null }>(
    `SELECT o.id AS id, c.source_url AS url FROM cash_opportunities o
       LEFT JOIN research_claims c ON c.id = o.source_claim_id
      WHERE o.project_id = ?`,
    [projectId],
  );
  const out = new Map<string, string>();
  for (const one of rows) {
    const host = hostOf(one.url);
    if (host) out.set(one.id, host);
  }
  return out;
}

/**
 * What discovery has learned about where to look, in a sentence a search
 * question can carry. The sources that produced useful openings, so the next
 * search starts from them; and the ways of looking that keep producing nothing
 * usable, so it does not repeat them.
 */
export function yieldGuidance(reading: DiscoveryYield): string {
  const good = reading.bySource.filter((one) => one.useful > 0 && one.key !== 'unknown source').slice(0, 6);
  const noisy = reading.bySource
    .filter((one) => one.key !== 'unknown source' && one.openings >= 3 && one.useful === 0)
    .slice(0, 6);
  const parts: string[] = [];
  if (good.length > 0) {
    parts.push(
      `Sources that have produced openings with a known payer before: ${good.map((one) => `${one.key} (${one.useful} of ${one.openings})`).join(', ')} — similar sources are worth checking first.`,
    );
  }
  if (noisy.length > 0) {
    parts.push(
      `Sources that produced many openings and none with a known payer: ${noisy.map((one) => `${one.key} (0 of ${one.openings})`).join(', ')} — do not rely on them.`,
    );
  }
  const feeds = reading.byFeed.filter((one) => one.qualified > 0 || one.useful > 0).slice(0, 4);
  if (feeds.length > 0) {
    parts.push(`Collected feeds whose leads became openings with a known payer: ${feeds.map((one) => `${one.source} (${one.useful} of ${one.shortlisted} shortlisted)`).join(', ')}.`);
  }
  return parts.join(' ');
}

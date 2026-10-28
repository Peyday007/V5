/**
 * The scoreboard: how many ideas Brain is producing, and how far they get.
 *
 * The owner (2026-10-22) asked for a baseline — "5 strong ideas a day" is a
 * target nobody can set until somebody has counted. Every number here is a
 * count of rows; nothing is estimated. Read on the same derivation the Cash
 * page reads (`sharedFrontier`), so the board and the page cannot disagree.
 */
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { sharedFrontier } from './shared.ts';
import { laneReading } from '../cheap/lane.ts';
import { feedReading } from '../../repos/feeds.ts';
import { shortlistFunnel } from '../feeds/run.ts';
import { siteReading, type SiteReading } from '../feeds/sites.ts';
import { detectionReading, type DetectionReading } from '../feeds/detectors.ts';
import { listRounds } from '../../repos/cashDiscovery.ts';
import { TRIGGER_BUCKETS, triggersEnabled } from './triggers.ts';

export interface Scoreboard {
  /** Openings found in the window, and how many of them were quick plays. */
  foundLast7Days: number;
  foundPerDay: number;
  quickPlaysLast7Days: number;
  /** Where every live opening is right now. */
  signals: number;
  candidates: number;
  qualified: number;
  readyToTest: number;
  executing: number;
  collected: number;
  /** Per trigger: rounds asked, openings found, and how many got past evidence. */
  triggers: { id: string; title: string; rounds: number; found: number; beyondEvidence: number }[];
  triggersOn: boolean;
  /** The free-model lane today. */
  cheapLane: Awaited<ReturnType<typeof laneReading>>;
  /** Raw leads code pulled, and how many reached a Claude shortlist. */
  feeds: Awaited<ReturnType<typeof feedReading>>;
  sites: SiteReading | null;
  detections: DetectionReading | null;
  funnel: { pool: number; screened: number; kept: number; passedRules: number; ready: number } | null;
}

export async function scoreboard(projectId: string, now: Date = new Date()): Promise<Scoreboard> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const all = await listOpportunities({ projectId });
  const recent = all.filter((one) => one.createdAt >= since);
  const frontier = await sharedFrontier({ projectId });
  const state = frontier.byState;
  return {
    foundLast7Days: recent.length,
    foundPerDay: Math.round((recent.length / 7) * 10) / 10,
    quickPlaysLast7Days: recent.filter((one) => one.mechanism === 'TEMPORARY_EXPLOIT').length,
    signals: frontier.byTier.SIGNAL ?? 0,
    candidates: frontier.byTier.CANDIDATE ?? 0,
    qualified: frontier.byTier.QUALIFIED ?? 0,
    readyToTest: frontier.byTier.READY_TO_TEST ?? 0,
    executing: (state.EXECUTING ?? 0) + (state.DELIVERING ?? 0),
    collected: state.COLLECTED ?? 0,
    cheapLane: await laneReading(now),
    feeds: await feedReading(now),
    sites: await siteReading().catch(() => null),
    detections: await detectionReading().catch(() => null),
    funnel: await shortlistFunnel(projectId, now)
      .then((f) => ({ pool: f.pool, screened: f.screened, kept: f.kept, passedRules: f.passedRules, ready: f.chosen.length }))
      .catch(() => null),
    triggersOn: triggersEnabled(),
    triggers: await triggerYields(projectId, all, frontier.opportunities),
  };
}

async function triggerYields(
  projectId: string,
  all: Awaited<ReturnType<typeof listOpportunities>>,
  shared: { id: string; tier: { tier: string } }[],
): Promise<Scoreboard['triggers']> {
  const rounds = await listRounds(projectId);
  const tierOf = new Map(shared.map((one) => [one.id, one.tier.tier]));
  return TRIGGER_BUCKETS.map((bucket) => {
    const ids = new Set(rounds.filter((one) => one.bucketId === bucket.id).map((one) => one.id));
    const found = all.filter((one) => one.discoveryRoundId !== null && ids.has(one.discoveryRoundId));
    return {
      id: bucket.id,
      title: bucket.title,
      rounds: ids.size,
      found: found.length,
      beyondEvidence: found.filter((one) => (tierOf.get(one.id) ?? 'SIGNAL') !== 'SIGNAL').length,
    };
  });
}

export function formatScoreboard(board: Scoreboard): string[] {
  const lane = board.cheapLane;
  return [
    'SCOREBOARD',
    `  found       ${board.foundLast7Days} in the last 7 days (${board.foundPerDay}/day), ${board.quickPlaysLast7Days} of them quick plays`,
    `  now         ${board.signals} evidence only · ${board.candidates} candidates · ${board.qualified} qualified · ${board.readyToTest} ready to act on`,
    `  acted       ${board.executing} being worked · ${board.collected} paid`,
    lane.enabled
      ? `  free lane   ${lane.today} screens today of ${lane.budget} (keep ${lane.verdicts.KEEP}, drop ${lane.verdicts.DROP}, unsure ${lane.verdicts.UNSURE}, failed ${lane.failed})`
      : '  free lane   off (no BRAIN_CHEAP_LLM_URL set)',
    `  feeds       ${board.feeds.today} raw leads today · ${board.feeds.items} held · ${board.feeds.shortlisted} sent to Claude`,
    board.sites
      ? `  sites       ${board.sites.businesses} named businesses mapped · ${board.sites.checked} checked · ${board.sites.pending} problems waiting a second look · ${board.sites.confirmed} confirmed${Object.keys(board.sites.byProblem).length ? ` (${Object.entries(board.sites.byProblem).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`
      : '  sites       could not be read',
    board.detections
      ? `  code rules  ${board.detections.byRule.map((one) => `${one.rule} ${one.mode} ${one.detections} found, ${one.leads} sent on`).join(' · ') || 'none fired yet'} · ${board.detections.covered} raw records covered, ${board.detections.coveredUnscreened} of them never sent to the free AI`
      : '  code rules  could not be read',
    board.funnel
      ? `  funnel      ${board.funnel.pool} recent → ${board.funnel.screened} screened → ${board.funnel.kept} kept → ${board.funnel.passedRules} pass rules → ${board.funnel.ready} ready for Claude`
      : '  funnel      could not be read',
    ...board.feeds.bySource.map(
      (one) => `    ${one.source.padEnd(28)} ${one.items} leads${one.lastError ? ` · last pull failed: ${one.lastError}` : ''}`,
    ),
    `  triggers    ${board.triggersOn ? 'on' : 'off (starts when the free lane is connected)'}`,
    ...board.triggers.map(
      (one) => `    ${one.id.padEnd(28)} rounds ${one.rounds} · found ${one.found} · past evidence ${one.beyondEvidence}`,
    ),
  ];
}

/**
 * How continuously the factory actually ran, read back from Brain's own rows.
 *
 * Every timestamp here is one Brain wrote when the thing happened: a bin became
 * READY, a fire was sent, a session was handed the bin, the bin went terminal,
 * the line recorded the start or end of unexplained idle. Nothing a worker said
 * about itself contributes, and a stage with a missing timestamp reports that
 * figure as null rather than borrowing the one beside it — a latency computed
 * from a guessed endpoint is a number that looks like a measurement.
 */
import type { BinEvent } from '../../domain/types.ts';
import { listBinEvents } from '../../repos/bins.ts';
import { getCampaign, getChangeRequest } from '../../repos/factory.ts';
import { listFactoryEvents } from '../../repos/factoryFleet.ts';
import { listFactoryBinsSince } from '../../repos/factoryLine.ts';
import { LINE_EVENT_KINDS } from './line.ts';

export interface StageTimeline {
  binId: string;
  campaignId: string;
  kind: string;
  state: string;
  executableAt: string | null;
  firedAt: string | null;
  arrivedAt: string | null;
  completedAt: string | null;
  /** READY → first fire sent. */
  executableToFireMs: number | null;
  /** First fire sent → first assignment. */
  fireToArrivalMs: number | null;
  /** First assignment → terminal. */
  stageDurationMs: number | null;
  /** The previous stage's terminal → this stage READY, within one campaign. */
  transitionIdleMs: number | null;
  fires: number;
  assignments: number;
  releases: number;
  noShows: number;
  deferrals: number;
  routines: string[];
}

export interface CampaignTimeline {
  campaignId: string;
  objective: string;
  state: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  stages: StageTimeline[];
}

export interface IdleInterval {
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  because: string | null;
}

export interface BurnInReading {
  since: string;
  until: string;
  campaigns: CampaignTimeline[];
  idle: IdleInterval[];
  totals: {
    stages: number;
    fires: number;
    retries: number;
    noShows: number;
    deferrals: number;
    /** Sum of stage durations over the window: how much of it a worker was holding a stage. */
    workedMs: number;
    windowMs: number;
    utilization: number | null;
    unexplainedIdleMs: number;
    medianExecutableToFireMs: number | null;
    medianFireToArrivalMs: number | null;
    medianTransitionIdleMs: number | null;
  };
}

function ms(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const value = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function first(events: BinEvent[], type: string): string | null {
  return events.find((event) => event.eventType === type)?.at ?? null;
}

function median(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (present.length === 0) return null;
  const mid = Math.floor(present.length / 2);
  return present.length % 2 === 1 ? present[mid]! : Math.round((present[mid - 1]! + present[mid]!) / 2);
}

export async function readBurnIn(input: { hours: number; now?: Date }): Promise<BurnInReading> {
  const now = input.now ?? new Date();
  const until = now.toISOString();
  const since = new Date(now.getTime() - input.hours * 3_600_000).toISOString();

  const bins = await listFactoryBinsSince(since);
  const byCampaign = new Map<string, StageTimeline[]>();
  for (const bin of bins) {
    const events = await listBinEvents(bin.id, 2000);
    const executableAt = bin.readyAt ?? first(events, 'BIN_READY');
    const firedAt = first(events, 'DISPATCH_SENT');
    const arrivedAt = first(events, 'BIN_ASSIGNED') ?? first(events, 'BIN_TAKEOVER');
    const completedAt = bin.completedAt ?? first(events, 'BIN_TERMINAL');
    const count = (type: string) => events.filter((event) => event.eventType === type).length;
    const assignments = count('BIN_ASSIGNED') + count('BIN_TAKEOVER');
    const stage: StageTimeline = {
      binId: bin.id,
      campaignId: bin.factoryCampaignId!,
      kind: bin.kind,
      state: bin.state,
      executableAt,
      firedAt,
      arrivedAt,
      completedAt,
      executableToFireMs: ms(executableAt, firedAt),
      fireToArrivalMs: ms(firedAt, arrivedAt),
      stageDurationMs: ms(arrivedAt, completedAt),
      transitionIdleMs: null,
      fires: count('DISPATCH_SENT'),
      assignments,
      releases: count('BIN_RELEASED'),
      noShows: count('DISPATCH_NO_SHOW'),
      deferrals: count('DISPATCH_DEFERRED'),
      routines: [...new Set(events.map((event) => event.routineRef).filter((ref): ref is string => !!ref))],
    };
    const list = byCampaign.get(stage.campaignId) ?? [];
    list.push(stage);
    byCampaign.set(stage.campaignId, list);
  }

  const campaigns: CampaignTimeline[] = [];
  for (const [campaignId, stages] of byCampaign) {
    stages.sort((a, b) => (a.executableAt ?? '').localeCompare(b.executableAt ?? ''));
    for (let i = 1; i < stages.length; i += 1) {
      stages[i]!.transitionIdleMs = ms(stages[i - 1]!.completedAt, stages[i]!.executableAt);
    }
    const campaign = await getCampaign(campaignId);
    const request = campaign ? await getChangeRequest(campaign.changeRequestId) : null;
    campaigns.push({
      campaignId,
      objective: (request?.objective ?? '').slice(0, 140),
      state: campaign?.state ?? 'UNKNOWN',
      startedAt: campaign?.startedAt ?? null,
      finishedAt: campaign?.finishedAt ?? null,
      durationMs: ms(campaign?.startedAt ?? null, campaign?.finishedAt ?? until),
      stages,
    });
  }

  const lineEvents = await listFactoryEvents(null, {
    kinds: [LINE_EVENT_KINDS.idleStarted, LINE_EVENT_KINDS.idleEnded],
  });
  const idle: IdleInterval[] = [];
  for (const event of lineEvents) {
    if (event.kind === LINE_EVENT_KINDS.idleStarted) {
      idle.push({
        startedAt: event.at,
        endedAt: null,
        durationMs: null,
        because: typeof event.detail?.['because'] === 'string' ? (event.detail['because'] as string) : null,
      });
    } else {
      const open = idle[idle.length - 1];
      if (open && open.endedAt === null) {
        open.endedAt = event.at;
        open.durationMs = ms(open.startedAt, event.at);
      }
    }
  }
  const inWindow = idle.filter((interval) => (interval.endedAt ?? until) >= since);
  const unexplainedIdleMs = inWindow.reduce((sum, interval) => {
    const start = interval.startedAt > since ? interval.startedAt : since;
    return sum + (ms(start, interval.endedAt ?? until) ?? 0);
  }, 0);

  const stages = campaigns.flatMap((campaign) => campaign.stages);
  const workedMs = stages.reduce((sum, stage) => sum + (stage.stageDurationMs ?? 0), 0);
  const windowMs = input.hours * 3_600_000;
  return {
    since,
    until,
    campaigns,
    idle: inWindow,
    totals: {
      stages: stages.length,
      fires: stages.reduce((sum, stage) => sum + stage.fires, 0),
      retries: stages.reduce((sum, stage) => sum + Math.max(0, stage.assignments - 1), 0),
      noShows: stages.reduce((sum, stage) => sum + stage.noShows, 0),
      deferrals: stages.reduce((sum, stage) => sum + stage.deferrals, 0),
      workedMs,
      windowMs,
      utilization: windowMs > 0 ? Math.round((workedMs / windowMs) * 1000) / 1000 : null,
      unexplainedIdleMs,
      medianExecutableToFireMs: median(stages.map((stage) => stage.executableToFireMs)),
      medianFireToArrivalMs: median(stages.map((stage) => stage.fireToArrivalMs)),
      medianTransitionIdleMs: median(stages.map((stage) => stage.transitionIdleMs)),
    },
  };
}

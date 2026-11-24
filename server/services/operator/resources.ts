/**
 * Each major resource Brain runs on, read as the questions a person asks of it
 * (owner, 2026-11-24): what is it accomplishing, how much useful work waits,
 * is it at its productive limit, why not, what is Brain doing about it, would
 * spending help, and what would that cost.
 *
 * Nothing here decides anything. Every figure is the existing owner's reading
 * — the capacity pools (`engineering/watchdog.ts`), the GPU supervisor's own
 * rows and budget (`cheap/runpodPod.ts`), the research grant
 * (`cash/researchRoom.ts`) — and every sentence is built from those figures.
 * A figure nobody measured is null and says so (invariant 33).
 */
import { utilizationWithin } from '../engineering/watchdog.ts';

export interface ResourceReading {
  key: 'ROUTINES' | 'FREE_LANE' | 'GPU' | 'RESEARCH_SLOTS' | 'FACTORY';
  name: string;
  accomplishing: string;
  waiting: number | null;
  running: number | null;
  capacity: number | null;
  /** True when it runs at its limit; false when there is room; null when unknown. */
  atLimit: boolean | null;
  /** True when work waits beside idle capacity: a fault, not a wait. */
  idleBesideWork: boolean;
  why: string;
  brainDoing: string;
  spendingHelps: 'YES' | 'NO' | 'UNKNOWN';
  spending: string;
  /** Dollars per hour for more of it, when a price is on record. */
  costPerHour: number | null;
}

/**
 * The GPU, from its own reader (`cheap/gpuStatus.ts`, §121): the pod, the
 * standing authorization, spend, waiting work, accepted results and every
 * active restriction. Only the seven-question wording is composed here.
 */
async function gpuReading(): Promise<ResourceReading> {
  const { readGpuStatus } = await import('../cheap/gpuStatus.ts');
  const g = await readGpuStatus();
  const running = g.pod.status === 'RUNNING' && g.pod.ready;
  const idleWithWork = g.work.state === 'IDLE_WITH_WORK' || g.work.state === 'STOPPED_WITH_WORK';
  const productive =
    g.work.accepted24h > 0
      ? ` In the last 24 h it ran ${g.work.runningHours24h.toFixed(1)} h and ${g.work.accepted24h} of its results were accepted (${g.work.acceptedLastHour} in the last hour${g.work.acceptedPerDollar24h !== null ? `, ${g.work.acceptedPerDollar24h.toFixed(1)} per dollar` : ''}).`
      : ` No GPU result was accepted in the last 24 h (${g.work.runningHours24h.toFixed(1)} h running).`;
  const restrictions = g.restrictions.length > 0 ? g.restrictions.join(' ') : 'No restriction is active.';
  const authorized = g.authorization;
  return {
    key: 'GPU',
    name: `Dedicated GPU${g.pod.card ? ` (${g.pod.card})` : ''}`,
    accomplishing: (running ? 'Answering research jobs on the dedicated model.' : `Not serving: the pod is ${g.pod.status.toLowerCase()}.`) + productive,
    waiting: g.work.waiting,
    running: g.work.inFlight,
    capacity: g.work.slotTarget,
    atLimit: g.work.slotTarget !== null && g.work.inFlight !== null ? g.work.inFlight >= g.work.slotTarget : null,
    idleBesideWork: idleWithWork,
    why: `${restrictions}${g.work.slotReason ? ` Concurrency is held at ${g.work.slotTarget ?? '?'}: ${g.work.slotReason}.` : ''}`,
    brainDoing: g.configured
      ? 'The pod supervisor starts the pod whenever useful work waits and stops it when none does, within the standing authorization; the lane controller sizes the GPU slot from what the GPU itself answered.'
      : 'Nothing automatic: the GPU is not in the lane.',
    spendingHelps: idleWithWork && authorized ? 'UNKNOWN' : 'NO',
    spending: authorized
      ? `The owner authorized up to $${authorized.usdPerHour.toFixed(2)}/h on one card; spend today ${g.spend.todayUsd === null ? 'not read' : `$${g.spend.todayUsd.toFixed(2)}`}, RunPod balance ${g.balanceUsd === null ? 'not read' : `$${g.balanceUsd.toFixed(2)}`}. More money helps only if a restriction above is a price or balance limit.`
      : 'No standing GPU authorization is recorded, so Brain does not spend on it.',
    costPerHour: g.pod.costPerHr,
  };
}

const POOL_TEXT: Record<string, { name: string; accomplishing: string; brainDoing: string; spending: (idle: boolean) => { helps: 'YES' | 'NO' | 'UNKNOWN'; text: string } }> = {
  ROUTINES: {
    name: 'Claude routines',
    accomplishing: 'Engineering and judgment work Brain fires at Claude routines (bins).',
    brainDoing: 'The watchdog records idle capacity beside executable work as a defect, and the dispatch tick fires the next free routine.',
    spending: (idle) =>
      idle
        ? { helps: 'NO', text: 'No: capacity is already there and idle; the limit is dispatch, not paid capacity.' }
        : { helps: 'UNKNOWN', text: 'Only if every routine is busy; more routines are a Claude account a person adds.' },
  },
  FREE_LANE: {
    name: 'Free model lane',
    accomplishing: 'Research jobs answered by free and cheap models (finding, verifying, synthesising).',
    brainDoing: 'Its controller grows or shrinks each model\'s slots from measured accepted results and database pressure.',
    spending: () => ({ helps: 'UNKNOWN', text: 'Not directly: its slots are bounded by the database share and by measured useful yield. Spending helps only through the GPU, which serves one of its slots.' }),
  },
  RESEARCH_SLOTS: {
    name: 'Research slots',
    accomplishing: 'Research missions launched from queued ideas under each project\'s research grant.',
    brainDoing: 'The grant controller raises the at-once ceiling when the free lane has spare capacity and lowers it under backlog or database pressure; obsolete ideas are retired every 30 minutes.',
    spending: () => ({ helps: 'NO', text: 'No: the ceiling is a software limit set from the free lane\'s spare capacity. More throughput comes from the GPU serving and from retiring obsolete ideas, not from a larger ceiling.' }),
  },
  FACTORY: {
    name: 'Factory line',
    accomplishing: 'Code changes Brain builds, reviews and releases.',
    brainDoing: 'Factory repairs are handled by the Factory session; this reading only reports it.',
    spending: () => ({ helps: 'NO', text: 'No: the limit is the review step, not paid capacity.' }),
  },
};

export async function readResources(): Promise<{ readAt: string | null; source: string; resources: ResourceReading[] }> {
  const reading = await utilizationWithin();
  const pools = reading.pools ?? [];
  const resources: ResourceReading[] = pools.map((p) => {
    const text = POOL_TEXT[p.pool] ?? {
      name: p.pool,
      accomplishing: '',
      brainDoing: '',
      spending: () => ({ helps: 'UNKNOWN' as const, text: 'Not known.' }),
    };
    const spend = text.spending(p.idle);
    return {
      key: p.pool as ResourceReading['key'],
      name: text.name,
      accomplishing: text.accomplishing,
      waiting: p.waiting,
      running: p.running,
      capacity: p.capacity,
      atLimit: p.capacity > 0 ? p.running >= p.capacity : null,
      idleBesideWork: p.idle,
      why: p.because,
      brainDoing: text.brainDoing,
      spendingHelps: spend.helps,
      spending: spend.text,
      costPerHour: null,
    };
  });
  resources.splice(2, 0, await gpuReading().catch(() => ({ key: 'GPU' as const, name: 'Dedicated GPU', accomplishing: 'Not read.', waiting: null, running: null, capacity: null, atLimit: null, idleBesideWork: false, why: 'The GPU reading failed this time; it is read again on the next refresh.', brainDoing: '', spendingHelps: 'UNKNOWN' as const, spending: 'Not known.', costPerHour: null })));
  return { readAt: reading.readAt, source: reading.source, resources };
}

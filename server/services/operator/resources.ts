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
import { getDb } from '../../db/database.ts';
import { utilizationWithin } from '../engineering/watchdog.ts';
import { readPodBudget } from '../cheap/runpodPod.ts';
import { runpodConfig, runpodPaused } from '../cheap/runpod.ts';

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

interface PodRow { outcome: string; reason: string | null; measures: unknown; at: string }

function measuresOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

async function gpuReading(laneWaiting: number | null): Promise<ResourceReading> {
  const config = runpodConfig();
  const mode = (process.env['BRAIN_RUNPOD_MODE'] ?? '').trim().toLowerCase() || 'unset';
  const rows = await getDb()
    .all<PodRow>(
      `SELECT outcome, reason, measures, at FROM bin_events WHERE event_type = 'RUNPOD_POD' ORDER BY at DESC LIMIT 60`,
      [],
    )
    .catch(() => [] as PodRow[]);
  const sample = rows.find((r) => r.outcome.startsWith('SAMPLE_'));
  const decision = rows.find((r) => !r.outcome.startsWith('SAMPLE_'));
  const status = sample ? sample.outcome.replace('SAMPLE_', '') : null;
  const cost = sample ? measuresOf(sample.measures)['costPerHr'] : null;
  const costPerHour = typeof cost === 'number' && cost > 0 ? cost : null;
  const budget = await readPodBudget().catch(() => null);
  const paused = runpodPaused();
  const running = status === 'RUNNING' && !paused;

  const budgetLine = budget
    ? `Budget $${budget.budget.toFixed(0)} per ${budget.windowHours} h; ${budget.spent === null ? 'spend unreadable' : `$${budget.spent.toFixed(2)} spent`}${budget.remaining !== null ? `, $${budget.remaining.toFixed(2)} left` : ''}.`
    : 'No GPU budget applies.';
  const why = !config
    ? 'No GPU is configured, so its slot is answered by the free fallback model.'
    : mode !== 'primary'
      ? `The GPU is out of the lane (mode ${mode}); every GPU-slot call is answered by the free fallback.`
      : running
        ? 'The pod is running and answering research.'
        : `The pod is ${(status ?? 'in an unknown state').toLowerCase()}${paused ? ` (${paused})` : ''}; until it serves, GPU-slot calls are answered by the free fallback. ${decision?.reason ? `Supervisor's last decision: ${decision.reason}.` : ''}`;
  const exhausted = !!budget?.exhausted;
  return {
    key: 'GPU',
    name: 'Dedicated GPU (RunPod)',
    accomplishing: running ? 'Answering research jobs on the dedicated model.' : 'Nothing right now: the pod is not serving.',
    waiting: laneWaiting,
    running: running ? 1 : 0,
    capacity: config ? 1 : 0,
    atLimit: config ? running : null,
    idleBesideWork: !!config && mode === 'primary' && !running && (laneWaiting ?? 0) > 0,
    why: `${why} ${budgetLine}`.trim(),
    brainDoing:
      config && mode === 'primary'
        ? 'The pod supervisor checks every minute: it starts a stopped pod while research waits and the budget allows, and stops it after 15 idle minutes or when the budget is spent.'
        : 'Nothing automatic: the GPU is not in the lane.',
    spendingHelps: exhausted ? 'YES' : config && mode === 'primary' && !running && (laneWaiting ?? 0) > 0 ? 'UNKNOWN' : 'NO',
    spending: exhausted
      ? `Yes: the budget is spent, so the pod cannot start until the window turns or the budget is raised.${costPerHour ? ` Each extra hour costs about $${costPerHour.toFixed(2)}.` : ''}`
      : running
        ? 'No: it is already running within its budget.'
        : budget && budget.remaining !== null && budget.remaining > 0
          ? 'Not more money: budget remains, so what holds it is the pod state above, not spending.'
          : 'Not known from the rows.',
    costPerHour,
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
  const lane = pools.find((p) => p.pool === 'FREE_LANE');
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
  resources.splice(2, 0, await gpuReading(lane ? lane.waiting : null));
  return { readAt: reading.readAt, source: reading.source, resources };
}

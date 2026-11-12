/**
 * The integration registry's own clock (§103): an hourly health check of every
 * integration, a Neighbor Card pass, and the approved browser capabilities that
 * are due (ACQ-21-5, `sources/browser/schedule.ts`), run by the Brain process.
 *
 * GitHub's scheduler was the only clock, and it fired the hourly Neighbor Card
 * workflow twice in eight hours on 2026-11-11, so "the mailer keeps finding and
 * loading prospects" depended on a cron nobody controls. The workflows stay as
 * a second door; this is the one Brain owns.
 *
 * Deploys restart the process several times an hour, so the cadence is read
 * from the last recorded run, not from the process's own start: a five-minute
 * tick runs a job only when its last row is older than its period. Each tick is
 * guarded against overlapping itself (tests/tickOverlap.test.ts), and the work
 * is network-bound reads and writes in this process, not a spawned compiler.
 */
import { withActivity } from '../../db/infra.ts';
import { countIntegrationUsage, latestIntegrationEvent, recordIntegrationEvent } from '../../repos/integrationEvents.ts';
import { defaultAgents, defaultDeps, runNeighborCard } from '../cash/neighborCard.ts';
import { runDueBrowserCapabilities } from '../sources/browser/schedule.ts';
import { checkAndRecord } from './health.ts';
import { signingKey } from './keys.ts';
import { searchPlacesViaV2 } from './v2Bridge.ts';

export const INTEGRATIONS_TICK_MS = 5 * 60_000;
export const CHECK_PERIOD_MS = 60 * 60_000;
/**
 * A pass every quarter hour (owner's order, 2026-11-12: "Remove the unnecessary
 * one-search-per-hour bottleneck"). Each pass reads several sources at once and
 * rotates by the quarter hour, so the whole area is covered several times a day;
 * Places stays inside its daily ceiling, which the meter enforces.
 */
export const NEIGHBOR_CARD_PERIOD_MS = 15 * 60_000;
/**
 * Nothing runs in a process's first twenty minutes: Deploy restarts the Brain
 * and then verifies it end to end, and a crawl beside that verification is load
 * it did not ask for (Deploy 958's post-restart pass timed out on a research
 * call while the first Neighbor Card pass ran).
 */
export const WARMUP_MS = 20 * 60_000;

const PASS_STATE = 'NEIGHBOR_CARD_PASS';

async function due(integrationId: string, kind: 'CHECK' | 'USAGE', state: string | null, periodMs: number, now: number): Promise<boolean> {
  const last = await latestIntegrationEvent(integrationId, kind, state);
  return !last || now - Date.parse(last.recordedAt) >= periodMs;
}

/** The Places meter the Neighbor Card pass searches through: one row per call, refused past the ceiling. */
export function placesMeter(source: string) {
  return {
    used: () => countIntegrationUsage('google-places', `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`),
    record: async (detail: string) => {
      await recordIntegrationEvent({ integrationId: 'google-places', kind: 'USAGE', state: 'SENT', detail: `Text Search "${detail}"`, source });
    },
  };
}

/** One tick: whichever of the jobs is due. */
export async function integrationsTick(now = Date.now(), env: NodeJS.ProcessEnv = process.env, uptimeMs = process.uptime() * 1000): Promise<string[]> {
  const done: string[] = [];
  if (uptimeMs < WARMUP_MS) return done;
  if (await due('instantly', 'CHECK', null, CHECK_PERIOD_MS, now)) {
    await checkAndRecord({ env, source: 'brain tick' });
    done.push('check');
  }
  if ((env.INSTANTLY_API_KEY ?? '').trim() && (await due('instantly', 'USAGE', PASS_STATE, NEIGHBOR_CARD_PERIOD_MS, now))) {
    // Recorded before the pass, so a restart mid-pass does not start a second one at once.
    await recordIntegrationEvent({ integrationId: 'instantly', kind: 'USAGE', state: PASS_STATE, detail: 'Neighbor Card pass started', source: 'brain tick' });
    const deps = defaultDeps();
    deps.log = () => undefined;
    if (signingKey(env)) deps.places = (query) => searchPlacesViaV2(query, placesMeter('brain tick'));
    deps.agents = defaultAgents(env);
    const result = await runNeighborCard(deps);
    await recordIntegrationEvent({
      integrationId: 'instantly',
      kind: 'USAGE',
      state: result.ok ? 'NEIGHBOR_CARD_OK' : 'NEIGHBOR_CARD_ATTENTION',
      detail: result.lines.join(' | '),
      source: 'brain tick',
    });
    done.push('neighbor-card');
  }
  // Approved, input-free browser reads whose last result went stale. Each run is
  // its own BROWSER_WORKFLOW_RUN row; freshness, backoff and the request budget
  // are decided inside operateCapability, so a tick with nothing due runs nothing.
  const browser = await runDueBrowserCapabilities();
  if (browser.length > 0) done.push(`browser-capabilities:${browser.length}`);
  return done;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startIntegrationsLoop(intervalMs = INTEGRATIONS_TICK_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void withActivity('integrations:tick', () => integrationsTick())
      .catch(() => {
        /* swallowed: a throwing timer callback takes the process down; the next tick retries */
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
}

export function stopIntegrationsLoop(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * The counterparty model, reached from the running Brain (CP-31, S-0466–S-0469).
 *
 * `transaction.ts` composes the ladder, the comparison and the reservations
 * into one reading of a sourced transaction, and its opportunity entry points
 * read the candidates from the opportunity's own rows. Until this module that
 * reading, the step coordination and the workforce plan had no caller outside
 * tests, so no production record could ever demonstrate them. This is their
 * production caller, on two doors that already exist and that this module does
 * not duplicate:
 *
 *   * the project's labor reading (`laborView`, served at
 *     `GET /api/projects/:projectId/labor` and printed by `npm run
 *     report:labor`) carries `counterparties`: every opportunity of the project
 *     whose rows name a fulfiller, read end to end — the primary and the
 *     alternative, which facts are verified and which are pending, cost /
 *     capacity / timing compared, whether a reserve is permitted under the
 *     project's live grant (and, if not, the authority it needs), the transfer
 *     a reported failure would plan, and whether the sale is deliverable — with
 *     its project steps coordinated from the recorded holds and one workforce
 *     plan over all of them;
 *   * the program probe registry (registered at boot by
 *     `cash/providers/register.ts`) carries the same reading over every
 *     project as `cash.counterparties.opportunities`, passing only when no
 *     opportunity breaches the model's refusals (`transactionBreaches`).
 *
 * Everything here reads. Nothing reserves, transfers, records a fact or holds
 * an authority: the reading proposes and names what it would need; a write is
 * the recorded entry points' (`reserveOpportunityTransaction`,
 * `transferOpportunityTransaction`), under the capacity lock and the live
 * grant. Nothing here names a kind of counterparty, an industry or a
 * geography: the candidates are whoever the rows name.
 */
import type { Counterparty } from './ladder.ts';
import { recordedReservationEvents, type ReservationEvent } from './reservations.ts';
import {
  coordinateSteps,
  planWorkforce,
  readOpportunityTransaction,
  reservationKey,
  sourcedCandidate,
  transactionBreaches,
  type OpportunityTransaction,
  type ProjectStep,
  type StepReading,
  type SourcedFulfiller,
  type WorkforceDemand,
  type WorkforceLine,
} from './transaction.ts';

/**
 * How far ahead the reading counts capacity when nobody named a window: the
 * shape of the work a person reads, never a fact about a counterparty.
 */
export const COUNTERPARTY_HORIZON_DAYS = 30;
/** The most recent opportunities one project reading covers, so a page stays a page. */
export const COUNTERPARTY_OPPORTUNITY_LIMIT = 25;

export interface OpportunityCounterparties {
  opportunityId: string;
  title: string;
  state: string;
  transaction: OpportunityTransaction;
  /** One step per place the rows name a fulfiller, coordinated from the recorded holds. */
  steps: StepReading[];
  /** The model's refusals this reading breaches. Empty when it holds. */
  breaches: string[];
}

export interface ProjectCounterpartyReading {
  projectId: string;
  at: string;
  window: { windowStart: string; windowEnd: string };
  opportunities: OpportunityCounterparties[];
  /** One plan over every opportunity read, on the holds of every business, so no unit is counted twice. */
  workforce: WorkforceLine[];
  breaches: string[];
  summary: string;
}

export function horizon(at: string, days = COUNTERPARTY_HORIZON_DAYS): { windowStart: string; windowEnd: string } {
  return { windowStart: at, windowEnd: new Date(new Date(at).getTime() + days * 86_400_000).toISOString() };
}

/**
 * The steps an opportunity's fulfilment runs through, as its rows name them:
 * each declared fulfilment, and the card's named owner, is one step carried by
 * that fulfiller's hold on the opportunity's commitment, when one is recorded.
 */
export function opportunitySteps(commitmentId: string, fulfillers: readonly SourcedFulfiller[]): ProjectStep[] {
  const steps: ProjectStep[] = [];
  for (const f of fulfillers) {
    for (const source of f.sources) {
      steps.push({ id: source, dependsOn: [], holdKey: reservationKey(commitmentId, f.counterpartyId) });
    }
  }
  return steps;
}

/** Which of a project's opportunities name a fulfiller on their own rows, most recent first. */
async function opportunitiesNamingFulfillers(projectId: string, limit: number) {
  const [{ listOpportunities }, { listFulfillments }] = await Promise.all([
    import('../../../repos/cashPortfolio.ts'),
    import('../../../repos/cashFulfillment.ts'),
  ]);
  const [opportunities, fulfillments] = await Promise.all([listOpportunities({ projectId }), listFulfillments(projectId)]);
  const declared = new Set(fulfillments.map((f) => f.opportunityId));
  return opportunities
    .filter((o) => (o.fulfillmentOwner ?? '').trim() !== '' || declared.has(o.id))
    .slice(0, limit);
}

/**
 * How long a probe pass's readings answer a default-options reading of the
 * same project. `r01.cp-31` reads every project through
 * `opportunityCounterpartyProbe` and then reads every project again through
 * `projectCounterparties`; the pass is one reading of the record, so its second
 * half reuses the first instead of re-querying it. A reading with any explicit
 * option never uses it.
 *
 * What this does and does not answer (§61, §88). On 2026-11-27 the probe failed
 * with "8/8 connection(s) in use, 0 idle, 15 caller(s) waiting, ceiling 8". The
 * pass did not hold those connections: it awaits one statement at a time, with
 * at most `PROBE_PASS_PEAK_CONNECTIONS` in flight at once (the obligations and
 * money reads of one opportunity), so it can never hold more than two of the
 * eight. The other six or more were checked out by other callers in the same
 * process, and the 15 waiters were queued behind them. The probe was a victim
 * of that saturation, not its cause. Re-reading the record a second time only
 * lengthened the window in which it could be refused. Cutting the probe's
 * statement count shortens that window. Reading the refusal as UNKNOWN keeps a
 * pool nobody measured from being recorded as a breach. Neither of them
 * identifies who held the pool: the pool records counts, not holders. Every
 * UNKNOWN this probe answers therefore says so on the record, with the pool's
 * reading at that moment, so the next episode starts from the measurement
 * rather than repeating this diagnosis.
 */
export const PROBE_PASS_TTL_MS = 60_000;

/**
 * The most pooled statements one probe pass has in flight at once. A reading
 * that exceeds it has stopped being the bounded, sequential pass the diagnosis
 * above rests on; `tests/program-ea512f54-repair-cp-31-1-reads.test.ts`
 * measures it on real rows.
 */
export const PROBE_PASS_PEAK_CONNECTIONS = 2;

interface PassEntry { reading: ProjectCounterpartyReading; expiresAt: number }
const probePass = new Map<string, PassEntry>();

/** Forget the current probe pass (tests, and the start of every pass). */
export function clearProbePass(): void {
  probePass.clear();
}

function fromProbePass(projectId: string): ProjectCounterpartyReading | null {
  const entry = probePass.get(projectId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    probePass.delete(projectId);
    return null;
  }
  return entry.reading;
}

/**
 * The project's counterparties, read end to end on its own rows. Writes nothing.
 * `at` and `window` are the reading's shape; every fact, hold and authority is
 * read from the record.
 */
export async function projectCounterparties(
  projectId: string,
  options: { at?: string; window?: { windowStart: string; windowEnd: string }; limit?: number } = {},
): Promise<ProjectCounterpartyReading> {
  const defaults = options.at === undefined && options.window === undefined && options.limit === undefined;
  if (defaults) {
    const cached = fromProbePass(projectId);
    if (cached) return cached;
  }
  return readProjectCounterparties(projectId, options);
}

async function readProjectCounterparties(
  projectId: string,
  options: { at?: string; window?: { windowStart: string; windowEnd: string }; limit?: number },
): Promise<ProjectCounterpartyReading> {
  const at = options.at ?? new Date().toISOString();
  const window = options.window ?? horizon(at);
  const chosen = await opportunitiesNamingFulfillers(projectId, options.limit ?? COUNTERPARTY_OPPORTUNITY_LIMIT);
  const opportunities: OpportunityCounterparties[] = [];
  const demands: WorkforceDemand[] = [];
  const candidates = new Map<string, Counterparty>();
  // One reading reads each counterparty's reservation ledger once (§61).
  const ledgers = new Map<string, ReservationEvent[]>();
  const eventsOf = async (ids: readonly string[]): Promise<ReservationEvent[]> => {
    const unique = [...new Set(ids)].sort();
    const missing = unique.filter((id) => !ledgers.has(id));
    if (missing.length > 0) {
      const read = await recordedReservationEvents(missing);
      for (const id of missing) ledgers.set(id, []);
      for (const e of read) ledgers.get(e.counterpartyId)?.push(e);
    }
    return unique.flatMap((id) => ledgers.get(id) ?? []);
  };
  for (const o of chosen) {
    const transaction = await readOpportunityTransaction({ opportunityId: o.id, window, at });
    const commitmentId = `opportunity:${o.id}`;
    for (const f of transaction.fulfillers) {
      if (!candidates.has(f.counterpartyId)) candidates.set(f.counterpartyId, await sourcedCandidate(f, f.sources.some((s) => s.startsWith('fulfillment:')) ? 'supplier' : 'fulfiller'));
    }
    const ids = transaction.fulfillers.map((f) => f.counterpartyId);
    const events = ids.length > 0 ? await eventsOf(ids) : [];
    const steps = coordinateSteps(opportunitySteps(commitmentId, transaction.fulfillers), events, at);
    const breaches = transaction.reading ? transactionBreaches(commitmentId, transaction.reading) : [];
    if (transaction.reading) demands.push({ commitment: { id: commitmentId, capacityUnits: 1 }, businessId: projectId, window });
    opportunities.push({ opportunityId: o.id, title: o.title, state: o.state, transaction, steps, breaches });
  }
  const parties = [...candidates.values()];
  const events = parties.length > 0 ? await eventsOf(parties.map((c) => c.id)) : [];
  const workforce = demands.length > 0 ? planWorkforce(demands, parties, events, at) : [];
  const breaches = opportunities.flatMap((o) => o.breaches);
  return { projectId, at, window, opportunities, workforce, breaches, summary: summarize(opportunities, workforce) };
}

function summarize(opportunities: readonly OpportunityCounterparties[], workforce: readonly WorkforceLine[]): string {
  if (opportunities.length === 0) return 'No opportunity in this project names a fulfiller other than Brain.';
  const read = opportunities.filter((o) => o.transaction.reading);
  const deliverable = read.filter((o) => o.transaction.reading!.deliverability.deliverable).length;
  const reservable = read.filter((o) => o.transaction.reading!.reserve.permitted).length;
  const short = workforce.filter((w) => w.shortfall > 0).length;
  return `${opportunities.length} opportunit${opportunities.length === 1 ? 'y names' : 'ies name'} a fulfiller; `
    + `${deliverable} deliverable on a contract, ${reservable} reservable under the live grant, `
    + `${short} without verified free capacity.`;
}

/** The probe name the opportunity reading is registered under. Not a release name: a campaign never defines its own judge (§96). */
export const OPPORTUNITY_COUNTERPARTY_PROBE = 'cash.counterparties.opportunities';

/**
 * A database that could not be reached. Its outcome is unknown (§26), and an
 * unknown is never read as a breach (§39): the probe answers UNKNOWN with the
 * reason instead of failing a model nobody judged. Matches the pool's own
 * refusal (`server/db/adapters/postgres.ts`).
 */
export const DATABASE_UNAVAILABLE = /database pool had no free connection|database would not give this pool a connection|Connection terminated due to connection timeout|too many clients|database did not answer in time/i;

/**
 * The record a pool refusal leaves: what the pass read before it, that the pass
 * itself holds at most `PROBE_PASS_PEAK_CONNECTIONS`, and the pool's own
 * reading now (Postgres only). The rest of the pool was held by other callers,
 * and this says so instead of implying the probe exhausted it.
 */
export async function poolRefusalDetail(message: string, read: number, of: number): Promise<string> {
  const { databasePoolReadings } = await import('../../../db/database.ts');
  const pool = databasePoolReadings()?.workload ?? null;
  const now = pool ? `; pool now ${pool.total - pool.idle}/${pool.total} in use, ${pool.idle} idle, ${pool.waiting} waiting, ceiling ${pool.max}` : '';
  const bound = `this pass holds at most ${PROBE_PASS_PEAK_CONNECTIONS} pooled connection(s) at a time`;
  const cause = /no free connection/i.test(message)
    ? `— held by other callers: ${bound}`
    : `— not this pass (${bound}): the database or the network refused the connection`;
  return `database unavailable while reading counterparties (${read} of ${of || '?'} project(s) read): ${message} ${cause}${now}`;
}

/**
 * The probe body: every project's opportunities that name a fulfiller, read
 * through the model, passing only when none breaches its refusals. `project`
 * narrows it to one. Read-only. The readings it makes answer a default-options
 * `projectCounterparties` of the same project for `PROBE_PASS_TTL_MS`, so a
 * caller that reads the pass again does not re-query it.
 */
export async function opportunityCounterpartyProbe(
  args: Record<string, string | number | boolean> = {},
): Promise<{ ok: boolean | null; detail: string }> {
  const only = typeof args.project === 'string' && args.project ? args.project : null;
  if (!only) clearProbePass();
  const readings: ProjectCounterpartyReading[] = [];
  let projects: string[] = [];
  try {
    const { listProjects } = await import('../../../repos/projects.ts');
    projects = only ? [only] : (await listProjects()).map((p) => p.id);
    for (const id of projects) {
      const reading = await readProjectCounterparties(id, {});
      probePass.set(id, { reading, expiresAt: Date.now() + PROBE_PASS_TTL_MS });
      readings.push(reading);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!DATABASE_UNAVAILABLE.test(message)) throw error;
    return { ok: null, detail: (await poolRefusalDetail(message, readings.length, projects.length)).slice(0, 900) };
  }
  const breaches = readings.flatMap((r) => r.breaches);
  if (breaches.length > 0) return { ok: false, detail: breaches.join('; ').slice(0, 900) };
  const opportunities = readings.flatMap((r) => r.opportunities);
  const withReading = opportunities.filter((o) => o.transaction.reading);
  const lines = withReading.slice(0, 5).map((o) => {
    const r = o.transaction.reading!;
    const primary = r.primary ? `${r.primary.counterpartyId} at ${r.primary.stage ?? 'no stage'}` : 'no primary';
    const alternative = r.alternative ? r.alternative.counterpartyId : 'no alternative';
    return `${o.opportunityId}: ${primary}, ${alternative}; deliverable=${r.deliverability.deliverable}; reserve=${r.reserve.permitted ? 'permitted' : r.reserve.reason}`;
  });
  return {
    ok: true,
    detail: `${opportunities.length} opportunity reading(s) across ${projects.length} project(s), ${withReading.length} with a candidate, no breach${lines.length ? ` | ${lines.join(' | ')}` : ''}`.slice(0, 900),
  };
}

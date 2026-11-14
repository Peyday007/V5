/**
 * A commercial provider the deployment chose, read as a counterparty (CP-31).
 *
 * A software service is one of the parties that performs or enables a
 * commitment — Instantly sends the message, Stripe issues the invoice — so the
 * counterparty model must be able to carry it beside contractors and
 * suppliers. This module does not add a second health check, registry or
 * status store: it re-expresses the existing reading (`status.ts`
 * `commercialProviderStatus`, itself composed from `readCapability`) in the
 * ladder's terms, so the provider's status and its counterparty facts cannot
 * disagree.
 *
 * Only what that reading establishes is VERIFIED, with the reading named as the
 * evidence — and the reading establishes configuration, nothing more (§18:
 * configuration is a request; only a real operation is a fact). That the
 * deployment names a provider is the LISTING. That its key is present and its
 * capability registered (`state: CONNECTED`) is configuration health, carried
 * as its own `configuration` fact. It is not the counterparty's willingness,
 * availability, scope or eligibility: a connected account can be suspended,
 * rate-limited or refuse the work, and only an operation the provider actually
 * performed shows otherwise. Those four stay PENDING here, so a connected
 * provider reads at LISTING — the same distinction between a directory entry
 * and a willing party that every other counterparty is held to. A missing
 * provider is not a counterparty at all until one is chosen. Nothing here
 * asserts a quote, a contract, a reservation or a performance — those stay
 * ABSENT on the ladder and are reported as missing.
 *
 * No setting's value is read or carried: the facts name capabilities and
 * provider names, never a key.
 */
import { stageIndex, type Counterparty, type Fact } from '../../labor/counterparties/ladder.ts';
import { recordedReservationEvents, withoutAuthority, type AuthorityReading, type ReservationEvent } from '../../labor/counterparties/reservations.ts';
import { recordedCounterparty } from '../../labor/counterparties/ladder.ts';
import { readTransaction, transactionBreaches, type TransactionReading } from '../../labor/counterparties/transaction.ts';
import { commercialProviderStatus, type ProviderLine } from './status.ts';
import { billingAlternates, messagingAlternates } from './config.ts';

const EVIDENCE = 'commercialProviderStatus (server/services/cash/providers/status.ts)';

/** The counterparty one provider line describes, or null when no provider is chosen for that area. */
export function providerCounterparty(line: ProviderLine): Counterparty | null {
  if (!line.provider) return null;
  const connected = line.state === 'CONNECTED';
  // Not established by a configuration reading, whatever its state: a task, never a default.
  const pending = (dimension: string, value: string | null = null): Fact => ({ dimension, status: 'PENDING', evidence: null, value });
  const facts: Fact[] = [
    // The deployment's own configuration names the provider: that is the listing.
    { dimension: 'listing', status: 'VERIFIED', evidence: `${EVIDENCE}: ${line.area} names ${line.provider}`, value: line.provider },
    // Configuration health, as the reading observed it. Not a ladder dimension.
    connected
      ? { dimension: 'configuration', status: 'VERIFIED', evidence: `${EVIDENCE}: ${line.capability} CONNECTED`, value: line.capability }
      : { dimension: 'configuration', status: 'PENDING', evidence: null, value: line.capability },
    // Willingness and capacity are the provider's to show by performing, not the deployment's to assert by configuring.
    pending('willingness'),
    pending('availability'),
    pending('scope', line.capability),
    pending('eligibility', line.capability),
    // A hosted API serves wherever the deployment runs; there is no service area to verify.
    { dimension: 'geography', status: 'NOT_APPLICABLE', evidence: 'a hosted software service has no service area', value: null },
    { dimension: 'providerState', status: 'VERIFIED', evidence: EVIDENCE, value: line.state },
  ];
  if (line.mode) facts.push({ dimension: 'mode', status: 'VERIFIED', evidence: EVIDENCE, value: line.mode });
  return {
    id: `provider:${line.area.toLowerCase()}:${line.provider}`,
    kind: 'software service',
    geography: null,
    humanOperator: false,
    facts,
  };
}

/**
 * The alternative fulfillers the deployment named for one area's line
 * (`BRAIN_MESSAGING_ALTERNATES` / `BRAIN_BILLING_ALTERNATES`), each a
 * counterparty listed by that naming and nothing more — its willingness,
 * availability and scope stay PENDING until an operation it performed shows
 * them, exactly as the chosen provider's do. Only fully configured names are
 * alternatives (`config.ts`).
 */
export function alternateCounterparties(line: Pick<ProviderLine, 'area' | 'capability' | 'provider'>, env: NodeJS.ProcessEnv = process.env): Counterparty[] {
  const named = line.area === 'MESSAGING' ? messagingAlternates(env).providers : line.area === 'INVOICES' ? billingAlternates(env).providers : [];
  return named
    .filter((provider) => provider !== line.provider)
    .map((provider) => {
      const pending = (dimension: string, value: string | null = null): Fact => ({ dimension, status: 'PENDING', evidence: null, value });
      return {
        id: `provider:${line.area.toLowerCase()}:${provider}`,
        kind: 'software service',
        geography: null,
        humanOperator: false,
        facts: [
          { dimension: 'listing', status: 'VERIFIED', evidence: `${EVIDENCE}: ${line.area} names ${provider} as an alternative`, value: provider },
          pending('willingness'),
          pending('availability'),
          pending('scope', line.capability),
          pending('eligibility', line.capability),
          { dimension: 'geography', status: 'NOT_APPLICABLE', evidence: 'a hosted software service has no service area', value: null },
        ],
      };
    });
}

/** Every chosen commercial provider as a counterparty, read from the existing status reading. */
export async function providerCounterparties(env: NodeJS.ProcessEnv = process.env): Promise<Counterparty[]> {
  const lines = await commercialProviderStatus(env);
  return lines.map(providerCounterparty).filter((c): c is Counterparty => c !== null);
}

// ---------------------------------------------------------------------------
// The running Brain's reading of its own provider commitments (CP-31)
// ---------------------------------------------------------------------------

/**
 * The name the provider-counterparty reading is registered under in the
 * program probe registry. Deliberately not a release name (`r01.…`): a
 * campaign never defines its own judge (§96), so this is the reading the
 * owner's `r01.cp-31` may consult, not a verdict on this work.
 */
export const PROVIDER_COUNTERPARTY_PROBE = 'cash.counterparties.providers';

export interface ProviderTransactionReading {
  area: string;
  capability: string;
  /** True when the provider's own recorded operations stand behind facts beyond configuration. */
  evidenced?: boolean;
  /** The alternative fulfillers the deployment seated behind the chosen provider. */
  alternates?: string[];
  /** Every candidate (chosen or alternative) whose own recorded operations stand behind its facts. */
  evidencedIds?: string[];
  reading: TransactionReading;
}

/**
 * Every commercial commitment Brain's deployment makes through a software
 * service — sending a message, issuing an invoice, taking a payment — read end
 * to end through the counterparty model: who fulfils it (the chosen provider),
 * what about them is verified and what is still pending, how they compare,
 * whether a reserve may be made, what happens after a failure, and whether the
 * commitment is deliverable.
 *
 * The candidates are the providers the existing status reading names, so this
 * runs on the deployment's real configuration, with the facts and holds every
 * real send recorded (`counterpartyRecord.ts`): the holds across every
 * business, so a double-commitment of provider capacity is a breach the probe
 * can actually find. No authority is assumed held: the reading proposes, it
 * never performs, and unless it is handed the owner's reading (`authorityFor`)
 * a reserve is refused with the authority named.
 */
export async function readProviderTransactions(options: {
  env?: NodeJS.ProcessEnv;
  at?: string;
  events?: readonly ReservationEvent[];
  /** The authority owner's reading (`authorityFor`); absent, nothing is held. */
  authority?: AuthorityReading;
} = {}): Promise<ProviderTransactionReading[]> {
  const env = options.env ?? process.env;
  const at = options.at ?? new Date().toISOString();
  const lines = await commercialProviderStatus(env);
  const out: ProviderTransactionReading[] = [];
  for (const line of lines) {
    const configured = providerCounterparty(line);
    // What the provider's own operations established (`counterpartyRecord.ts`) is read after what
    // configuration says, so a receipt's VERIFIED replaces configuration's PENDING, never the reverse.
    const recorded = configured ? await recordedCounterparty(configured.id) : null;
    const candidate = configured ? { ...configured, facts: [...configured.facts, ...(recorded?.facts ?? [])] } : null;
    // The alternatives the deployment seated behind it (`register.ts`), read the same way, so the
    // reading names a primary and an alternative and a failure has somewhere to go.
    const alternates: Counterparty[] = [];
    const evidencedIds = configured && recorded ? [configured.id] : [];
    for (const one of configured ? alternateCounterparties(line, env) : []) {
      const known = await recordedCounterparty(one.id);
      if (known) evidencedIds.push(one.id);
      alternates.push({ ...one, facts: [...one.facts, ...(known?.facts ?? [])] });
    }
    const candidates = candidate ? [candidate, ...alternates] : [];
    const events = options.events ?? (candidates.length > 0 ? await recordedReservationEvents(candidates.map((c) => c.id)) : []);
    out.push({
      area: line.area,
      capability: line.capability,
      evidenced: recorded !== null,
      alternates: alternates.map((one) => one.id),
      evidencedIds,
      reading: readTransaction({
        commitment: { id: `commitment:${line.area.toLowerCase()}`, capacityUnits: 1 },
        candidates,
        events,
        businessId: 'brain',
        window: { windowStart: at, windowEnd: at },
        authority: options.authority ?? withoutAuthority('brain', undefined, 'the deployment reading holds no commercial grant'),
        at,
        source: `${EVIDENCE}: ${line.area}`,
      }),
    });
  }
  return out;
}

/**
 * The model's guarantees, checked against a set of readings. Empty when every
 * one holds; otherwise one sentence per breach. These are the clauses the
 * specification states as refusals: a sale is never reported deliverable
 * below a contract, a reserve is never permitted without the required
 * authority, capacity is never double-committed, and a configured provider is
 * never read as willing.
 */
export function counterpartyBreaches(readings: readonly ProviderTransactionReading[]): string[] {
  const breaches: string[] = [];
  for (const { area, reading, evidenced, evidencedIds } of readings) {
    breaches.push(...transactionBreaches(area, reading));
    // The chosen provider and its alternative alike: neither is read as willing on configuration alone.
    for (const one of [reading.primary, reading.alternative]) {
      if (!one || one.kind !== 'software service' || stageIndex(one.stage) <= stageIndex('LISTING')) continue;
      const backed = evidencedIds ? evidencedIds.includes(one.counterpartyId) : one === reading.primary && evidenced === true;
      if (!backed) breaches.push(`${area}: ${one.counterpartyId} read past LISTING from configuration alone`);
    }
  }
  return breaches;
}

function summarize(readings: readonly ProviderTransactionReading[]): string {
  if (readings.length === 0) return 'no provider area is read';
  return readings
    .map(({ area, reading }) => {
      const who = reading.primary ? `${reading.primary.counterpartyId} at ${reading.primary.stage ?? 'no stage'}` : 'no fulfiller';
      const pending = reading.facts[0]?.pending.length ?? 0;
      return `${area}: ${who}; ${pending} pending fact(s); deliverable=${reading.deliverability.deliverable}; reserve=${reading.reserve.permitted ? 'permitted' : reading.reserve.reason}`;
    })
    .join(' | ')
    .slice(0, 900);
}

/** The probe body: the live providers read through the model, passing only when no guarantee is breached. */
export async function providerCounterpartyProbe(env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; detail: string }> {
  const readings = await readProviderTransactions({ env });
  const breaches = counterpartyBreaches(readings);
  return breaches.length === 0
    ? { ok: true, detail: summarize(readings) }
    : { ok: false, detail: breaches.join('; ').slice(0, 900) };
}

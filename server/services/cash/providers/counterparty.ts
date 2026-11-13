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
 * evidence. A provider that is configured but not registered is PENDING; a
 * missing provider is not a counterparty at all until one is chosen. Nothing
 * here asserts a contract, a reservation or a performance the reading did not
 * observe — those stay ABSENT on the ladder and are reported as missing.
 *
 * No setting's value is read or carried: the facts name capabilities and
 * provider names, never a key.
 */
import type { Counterparty, Fact } from '../../labor/counterparties/ladder.ts';
import { commercialProviderStatus, type ProviderLine } from './status.ts';

const EVIDENCE = 'commercialProviderStatus (server/services/cash/providers/status.ts)';

/** The counterparty one provider line describes, or null when no provider is chosen for that area. */
export function providerCounterparty(line: ProviderLine): Counterparty | null {
  if (!line.provider) return null;
  const connected = line.state === 'CONNECTED';
  const established = (dimension: string, value: string | null = null): Fact =>
    connected ? { dimension, status: 'VERIFIED', evidence: `${EVIDENCE}: ${line.capability} CONNECTED`, value } : { dimension, status: 'PENDING', evidence: null, value };
  const facts: Fact[] = [
    // The deployment's own configuration names the provider: that is the listing.
    { dimension: 'listing', status: 'VERIFIED', evidence: `${EVIDENCE}: ${line.area} names ${line.provider}`, value: line.provider },
    // A registered, configured provider accepts work on the deployment's account.
    established('willingness'),
    established('availability'),
    established('scope', line.capability),
    established('eligibility', line.capability),
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

/** Every chosen commercial provider as a counterparty, read from the existing status reading. */
export async function providerCounterparties(env: NodeJS.ProcessEnv = process.env): Promise<Counterparty[]> {
  const lines = await commercialProviderStatus(env);
  return lines.map(providerCounterparty).filter((c): c is Counterparty => c !== null);
}

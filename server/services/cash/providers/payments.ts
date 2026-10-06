/**
 * Reading whether an issued invoice has been paid, and whether that money is
 * usable — the half of payment collection that is a reading rather than an
 * effect.
 *
 * Collecting a payment is not something Brain *does* to a buyer: the invoice's
 * hosted page is where the buyer pays, and the provider holds the money. What
 * Brain must do is learn, from the provider's own answer, two separate facts —
 * the customer paid, and the funds became available — and record each exactly
 * once as its own ledger entry (`invoicing.ts`). A registry of readers rather
 * than a direct import, for the same reason effect adapters have one: what is
 * registered is what a capability reading can see, and a test can stand a
 * fake provider in its place without reaching the network.
 */
import type { AdapterHealth } from '../../effects/adapter.ts';
import type { InvoiceReading } from './stripe.ts';

export interface PaymentReader {
  name: string;
  /** The provider whose invoices this reads; matches `cash_invoices.provider`. */
  provider: string;
  health(): AdapterHealth;
  read(providerInvoiceId: string): Promise<InvoiceReading>;
}

let READER: PaymentReader | null = null;

export function registerPaymentReader(reader: PaymentReader): void {
  READER = reader;
}

export function paymentReader(): PaymentReader | null {
  return READER;
}

/** Registered and configured now — the TAKE_A_PAYMENT reading. */
export function usablePaymentReader(): PaymentReader | null {
  return READER && READER.health().usable ? READER : null;
}

/** For tests, which register throwaway readers and must not leak them. */
export function clearPaymentReader(): void {
  READER = null;
}

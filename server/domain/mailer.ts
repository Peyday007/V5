/**
 * The rolling city mailer, as types.
 *
 * One printed mailer per city, a fixed number of ad slots in it, one business
 * per category so nobody shares a mailer with a competitor. Brain sells one
 * city at a time and opens the next queued city the moment the last slot sells.
 */

export const MAILER_CITY_STATES = ['QUEUED', 'SELLING', 'FULL', 'PRINT_APPROVED', 'MAILED', 'CLOSED'] as const;
export type MailerCityState = (typeof MAILER_CITY_STATES)[number];

export const MAILER_LEAD_STATES = ['NEW', 'DRAFTED', 'SOLD', 'DECLINED', 'OPTED_OUT'] as const;
export type MailerLeadState = (typeof MAILER_LEAD_STATES)[number];

export const MAILER_OUTREACH_STATES = ['HELD', 'SENT', 'WITHDRAWN'] as const;
export type MailerOutreachState = (typeof MAILER_OUTREACH_STATES)[number];

/** The defaults the owner gave: 16 slots at $500, about $3,000 to print and mail, ~500 businesses. */
export const MAILER_DEFAULTS = {
  slotCount: 16,
  slotPriceCents: 50_000,
  printCostCents: 300_000,
  leadTarget: 500,
} as const;

export interface MailerCityRow {
  id: string;
  project_id: string;
  city: string;
  region: string;
  city_key: string;
  ordinal: number;
  slot_count: number;
  slot_price_cents: number;
  print_cost_cents: number;
  lead_target: number;
  state: string;
  opened_at: string | null;
  filled_at: string | null;
  print_approved_by: string | null;
  print_approved_at: string | null;
  mailed_at: string | null;
  created_by: string;
  created_at: string;
}

export interface MailerCity {
  id: string;
  projectId: string;
  city: string;
  region: string;
  cityKey: string;
  ordinal: number;
  slotCount: number;
  slotPriceCents: number;
  printCostCents: number;
  leadTarget: number;
  state: MailerCityState;
  openedAt: string | null;
  filledAt: string | null;
  printApprovedBy: string | null;
  printApprovedAt: string | null;
  mailedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface MailerLeadRow {
  id: string;
  project_id: string;
  city_id: string;
  business_name: string;
  category: string;
  category_key: string;
  email: string;
  email_key: string;
  source_url: string | null;
  state: string;
  created_at: string;
}

export interface MailerLead {
  id: string;
  projectId: string;
  cityId: string;
  businessName: string;
  category: string;
  categoryKey: string;
  email: string;
  sourceUrl: string | null;
  state: MailerLeadState;
  createdAt: string;
}

export interface MailerSlotRow {
  id: string;
  project_id: string;
  city_id: string;
  slot_number: number;
  lead_id: string;
  category_key: string;
  amount_cents: number;
  payment_ref: string;
  recorded_by: string;
  sold_at: string;
}

export interface MailerSlot {
  id: string;
  projectId: string;
  cityId: string;
  slotNumber: number;
  leadId: string;
  categoryKey: string;
  amountCents: number;
  paymentRef: string;
  recordedBy: string;
  soldAt: string;
}

export interface MailerOutreachRow {
  id: string;
  project_id: string;
  city_id: string;
  lead_id: string;
  recipient: string;
  subject: string;
  body: string;
  state: string;
  created_at: string;
}

export interface MailerOutreach {
  id: string;
  projectId: string;
  cityId: string;
  leadId: string;
  recipient: string;
  subject: string;
  body: string;
  state: MailerOutreachState;
  createdAt: string;
}

/** Case and whitespace only — two spellings of one word are one key, two words are two. */
export function mailerKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;

/** One plain business address, or null. A list, a name or a phrase is not an address. */
export function plainEmail(text: string): string | null {
  const value = text.trim();
  return EMAIL.test(value) ? value : null;
}

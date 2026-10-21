/**
 * The rolling city mailer's rows.
 *
 * Every write that two callers could race on is arbitrated by a unique index
 * rather than a check-then-write: one SELLING city per project, one slot per
 * number, one business per category per city, one sale per payment reference,
 * one draft per lead. Nothing here deletes.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type {
  MailerCity,
  MailerCityRow,
  MailerCityState,
  MailerLead,
  MailerLeadRow,
  MailerLeadState,
  MailerOutreach,
  MailerOutreachRow,
  MailerOutreachState,
  MailerSlot,
  MailerSlotRow,
} from '../domain/mailer.ts';

function mapCity(r: MailerCityRow): MailerCity {
  return {
    id: r.id,
    projectId: r.project_id,
    city: r.city,
    region: r.region,
    cityKey: r.city_key,
    ordinal: Number(r.ordinal),
    slotCount: Number(r.slot_count),
    slotPriceCents: Number(r.slot_price_cents),
    printCostCents: Number(r.print_cost_cents),
    leadTarget: Number(r.lead_target),
    state: r.state as MailerCityState,
    openedAt: r.opened_at,
    filledAt: r.filled_at,
    printApprovedBy: r.print_approved_by,
    printApprovedAt: r.print_approved_at,
    mailedAt: r.mailed_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function mapLead(r: MailerLeadRow): MailerLead {
  return {
    id: r.id,
    projectId: r.project_id,
    cityId: r.city_id,
    businessName: r.business_name,
    category: r.category,
    categoryKey: r.category_key,
    email: r.email,
    sourceUrl: r.source_url,
    state: r.state as MailerLeadState,
    createdAt: r.created_at,
  };
}

function mapSlot(r: MailerSlotRow): MailerSlot {
  return {
    id: r.id,
    projectId: r.project_id,
    cityId: r.city_id,
    slotNumber: Number(r.slot_number),
    leadId: r.lead_id,
    categoryKey: r.category_key,
    amountCents: Number(r.amount_cents),
    paymentRef: r.payment_ref,
    recordedBy: r.recorded_by,
    soldAt: r.sold_at,
  };
}

function mapOutreach(r: MailerOutreachRow): MailerOutreach {
  return {
    id: r.id,
    projectId: r.project_id,
    cityId: r.city_id,
    leadId: r.lead_id,
    recipient: r.recipient,
    subject: r.subject,
    body: r.body,
    state: r.state as MailerOutreachState,
    createdAt: r.created_at,
  };
}

/* ------------------------------------------------------------------ cities */

export async function insertCity(input: {
  projectId: string;
  city: string;
  region: string;
  cityKey: string;
  slotCount: number;
  slotPriceCents: number;
  printCostCents: number;
  leadTarget: number;
  createdBy: string;
}): Promise<{ city: MailerCity; created: boolean }> {
  const db = getDb();
  const id = newId('mlc');
  const last = await db.get<{ n: number | null }>(
    'SELECT MAX(ordinal) AS n FROM mailer_cities WHERE project_id = ?',
    [input.projectId],
  );
  const result = await db.run(
    `INSERT INTO mailer_cities
       (id, project_id, city, region, city_key, ordinal, slot_count, slot_price_cents,
        print_cost_cents, lead_target, state, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.city,
      input.region,
      input.cityKey,
      Number(last?.n ?? 0) + 1,
      input.slotCount,
      input.slotPriceCents,
      input.printCostCents,
      input.leadTarget,
      input.createdBy,
      nowIso(),
    ],
  );
  const row = await db.get<MailerCityRow>(
    'SELECT * FROM mailer_cities WHERE project_id = ? AND city_key = ?',
    [input.projectId, input.cityKey],
  );
  if (!row) throw new Error('A city that was just written could not be read back.');
  return { city: mapCity(row), created: result.changes === 1 };
}

export async function getCity(id: string): Promise<MailerCity | null> {
  const row = await getDb().get<MailerCityRow>('SELECT * FROM mailer_cities WHERE id = ?', [id]);
  return row ? mapCity(row) : null;
}

export async function listCities(projectId: string): Promise<MailerCity[]> {
  const rows = await getDb().all<MailerCityRow>(
    'SELECT * FROM mailer_cities WHERE project_id = ? ORDER BY ordinal ASC, id ASC',
    [projectId],
  );
  return rows.map(mapCity);
}

/**
 * Move one city from one state to another, guarded on the state it is in.
 * `stamp` names the timestamp column the move sets.
 */
export async function moveCity(input: {
  id: string;
  from: MailerCityState;
  to: MailerCityState;
  stamp?: 'opened_at' | 'filled_at' | 'print_approved_at' | 'mailed_at';
  approvedBy?: string;
}): Promise<boolean> {
  const at = nowIso();
  const sets = ['state = ?'];
  const params: (string | null)[] = [input.to];
  if (input.stamp) {
    sets.push(`${input.stamp} = ?`);
    params.push(at);
  }
  if (input.approvedBy) {
    sets.push('print_approved_by = ?');
    params.push(input.approvedBy);
  }
  // Opening a city is also guarded on no other city selling, so the ordinary
  // path never reaches the partial unique index; the index is the backstop for
  // two ticks racing past this check at the same instant.
  const onlyOne =
    input.to === 'SELLING'
      ? " AND NOT EXISTS (SELECT 1 FROM mailer_cities other WHERE other.project_id = mailer_cities.project_id AND other.state = 'SELLING')"
      : '';
  try {
    const result = await getDb().run(
      `UPDATE mailer_cities SET ${sets.join(', ')} WHERE id = ? AND state = ?${onlyOne}`,
      [...params, input.id, input.from],
    );
    return result.changes === 1;
  } catch (error) {
    // The partial unique index refused a second SELLING city: an ordinary loss.
    if (input.to === 'SELLING' && /unique|duplicate/i.test(String((error as Error).message))) return false;
    throw error;
  }
}

/* ------------------------------------------------------------------- leads */

export async function insertLead(input: {
  projectId: string;
  cityId: string;
  businessName: string;
  category: string;
  categoryKey: string;
  email: string;
  emailKey: string;
  sourceUrl: string | null;
}): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO mailer_leads
       (id, project_id, city_id, business_name, category, category_key, email, email_key, source_url, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW', ?)
     ON CONFLICT DO NOTHING`,
    [
      newId('mll'),
      input.projectId,
      input.cityId,
      input.businessName,
      input.category,
      input.categoryKey,
      input.email,
      input.emailKey,
      input.sourceUrl,
      nowIso(),
    ],
  );
  return result.changes === 1;
}

export async function getLead(id: string): Promise<MailerLead | null> {
  const row = await getDb().get<MailerLeadRow>('SELECT * FROM mailer_leads WHERE id = ?', [id]);
  return row ? mapLead(row) : null;
}

export async function listLeads(cityId: string): Promise<MailerLead[]> {
  const rows = await getDb().all<MailerLeadRow>(
    'SELECT * FROM mailer_leads WHERE city_id = ? ORDER BY created_at ASC, id ASC',
    [cityId],
  );
  return rows.map(mapLead);
}

export async function moveLead(id: string, from: MailerLeadState[], to: MailerLeadState): Promise<boolean> {
  const marks = from.map(() => '?').join(', ');
  const result = await getDb().run(
    `UPDATE mailer_leads SET state = ? WHERE id = ? AND state IN (${marks})`,
    [to, id, ...from],
  );
  return result.changes === 1;
}

/* ------------------------------------------------------------------- slots */

export async function listSlots(cityId: string): Promise<MailerSlot[]> {
  const rows = await getDb().all<MailerSlotRow>(
    'SELECT * FROM mailer_slots WHERE city_id = ? ORDER BY slot_number ASC',
    [cityId],
  );
  return rows.map(mapSlot);
}

export async function slotForPayment(projectId: string, paymentRef: string): Promise<MailerSlot | null> {
  const row = await getDb().get<MailerSlotRow>(
    'SELECT * FROM mailer_slots WHERE project_id = ? AND payment_ref = ?',
    [projectId, paymentRef],
  );
  return row ? mapSlot(row) : null;
}

/** One slot, or nothing: a taken number, category or payment reference matches no row. */
export async function insertSlot(input: {
  projectId: string;
  cityId: string;
  slotNumber: number;
  leadId: string;
  categoryKey: string;
  amountCents: number;
  paymentRef: string;
  recordedBy: string;
}): Promise<MailerSlot | null> {
  const id = newId('mls');
  const result = await getDb().run(
    `INSERT INTO mailer_slots
       (id, project_id, city_id, slot_number, lead_id, category_key, amount_cents, payment_ref, recorded_by, sold_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.cityId,
      input.slotNumber,
      input.leadId,
      input.categoryKey,
      input.amountCents,
      input.paymentRef,
      input.recordedBy,
      nowIso(),
    ],
  );
  if (result.changes !== 1) return null;
  const row = await getDb().get<MailerSlotRow>('SELECT * FROM mailer_slots WHERE id = ?', [id]);
  return row ? mapSlot(row) : null;
}

/* ---------------------------------------------------------------- outreach */

export async function insertOutreach(input: {
  projectId: string;
  cityId: string;
  leadId: string;
  recipient: string;
  subject: string;
  body: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO mailer_outreach (id, project_id, city_id, lead_id, recipient, subject, body, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'HELD', ?)
     ON CONFLICT DO NOTHING`,
    [newId('mlo'), input.projectId, input.cityId, input.leadId, input.recipient, input.subject, input.body, nowIso()],
  );
  return result.changes === 1;
}

export async function listOutreach(cityId: string): Promise<MailerOutreach[]> {
  const rows = await getDb().all<MailerOutreachRow>(
    'SELECT * FROM mailer_outreach WHERE city_id = ? ORDER BY created_at ASC, id ASC',
    [cityId],
  );
  return rows.map(mapOutreach);
}

/**
 * Held drafts for a category that has just been sold: the buyer's own (they
 * already bought) and every competitor's (the slot is gone).
 */
export async function withdrawHeldForCategory(cityId: string, categoryKey: string): Promise<number> {
  const result = await getDb().run(
    `UPDATE mailer_outreach SET state = 'WITHDRAWN'
      WHERE city_id = ? AND state = 'HELD'
        AND lead_id IN (SELECT id FROM mailer_leads WHERE city_id = ? AND category_key = ?)`,
    [cityId, cityId, categoryKey],
  );
  return result.changes;
}

/** A lead that declined or opted out keeps no live draft. */
export async function withdrawHeldForLead(cityId: string, leadId: string): Promise<number> {
  const result = await getDb().run(
    "UPDATE mailer_outreach SET state = 'WITHDRAWN' WHERE city_id = ? AND lead_id = ? AND state = 'HELD'",
    [cityId, leadId],
  );
  return result.changes;
}

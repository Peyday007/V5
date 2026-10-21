/**
 * The rolling city mailer.
 *
 * One printed mailer per city, `slotCount` ad slots in it, one business per
 * category. Brain sells one city at a time — "send them till they're done" —
 * and the moment the last slot sells the city is FULL and the next queued city
 * opens by itself. Nobody has to say "next city".
 *
 * What Brain does by itself, on every Cash tick:
 *   - opens the next queued city when none is selling;
 *   - marks a city FULL when its slots are sold, and opens the next one;
 *   - composes one outreach draft per business lead, and HOLDS it;
 *   - withdraws held drafts for a category somebody has already bought.
 *
 * What it never does by itself, and why:
 *   - **Send.** The owner said outreach waits until they are up. Nothing in this
 *     module calls a provider; a held draft is a row a person can read and
 *     export. Sending is a separate, later decision (and Resend, the only
 *     messaging adapter Brain has, does not permit cold email).
 *   - **Spend.** The print run costs money, and invariant 38 says no money is
 *     committed outside a ceiling a person set. A FULL city waits for a
 *     person's print approval.
 *   - **Invent a sale.** A slot is sold only when a payment reference is
 *     recorded against a lead; an unpaid "yes" is not a slot.
 *
 * Every figure the view reports is derived from slot rows and the city's own
 * terms; nothing is stored as a total.
 */
import { getCashMode, recordCashEvent } from '../../../repos/cashMode.ts';
import {
  getCity,
  getLead,
  insertCity,
  insertLead,
  insertOutreach,
  insertSlot,
  listCities,
  listLeads,
  listOutreach,
  listSlots,
  moveCity,
  moveLead,
  slotForPayment,
  withdrawHeldForCategory,
  withdrawHeldForLead,
} from '../../../repos/mailer.ts';
import { MAILER_DEFAULTS, mailerKey, plainEmail } from '../../../domain/mailer.ts';
import type { MailerCity, MailerLead } from '../../../domain/mailer.ts';

/** How many drafts one pass composes, so a 500-lead upload never makes one long tick. */
export const MAX_DRAFTS_PER_PASS = 100;

type Refusal = { ok: false; reason: string };
const refuse = (reason: string): Refusal => ({ ok: false, reason });

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/* ------------------------------------------------------------- the queue */

export async function queueCity(input: {
  projectId: string;
  city: string;
  region: string;
  actorRef: string;
  slotCount?: number;
  slotPriceCents?: number;
  printCostCents?: number;
  leadTarget?: number;
}): Promise<{ ok: true; city: MailerCity; created: boolean } | Refusal> {
  const city = input.city.trim();
  const region = input.region.trim();
  if (city.length < 2) return refuse('Name the city, e.g. "Austin".');
  if (region.length < 2) return refuse('Name the state or region, e.g. "TX", so two Springfields stay two cities.');
  const slotCount = input.slotCount ?? MAILER_DEFAULTS.slotCount;
  const slotPriceCents = input.slotPriceCents ?? MAILER_DEFAULTS.slotPriceCents;
  const printCostCents = input.printCostCents ?? MAILER_DEFAULTS.printCostCents;
  const leadTarget = input.leadTarget ?? MAILER_DEFAULTS.leadTarget;
  for (const [name, value, min] of [
    ['slotCount', slotCount, 1],
    ['slotPriceCents', slotPriceCents, 1],
    ['printCostCents', printCostCents, 0],
    ['leadTarget', leadTarget, 1],
  ] as const) {
    if (!Number.isInteger(value) || value < min) return refuse(`"${name}" must be a whole number of at least ${min}.`);
  }
  const outcome = await insertCity({
    projectId: input.projectId,
    city,
    region,
    cityKey: `${mailerKey(city)}|${mailerKey(region)}`,
    slotCount,
    slotPriceCents,
    printCostCents,
    leadTarget,
    createdBy: input.actorRef,
  });
  if (outcome.created) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: 'MAILER_CITY_QUEUED',
      actorRef: input.actorRef,
      summary: `${city}, ${region} queued: ${slotCount} slots at ${dollars(slotPriceCents)}.`,
      detail: { cityId: outcome.city.id, ordinal: outcome.city.ordinal },
    });
  }
  return { ok: true, ...outcome };
}

/* ------------------------------------------------------------- the leads */

export interface LeadInput {
  businessName: string;
  category: string;
  email: string;
  sourceUrl?: string | null;
}

export async function addLeads(input: {
  projectId: string;
  cityId: string;
  leads: LeadInput[];
}): Promise<{ ok: true; added: number; duplicates: number; refused: { index: number; reason: string }[] } | Refusal> {
  const city = await getCity(input.cityId);
  if (!city || city.projectId !== input.projectId) return refuse('No such city in this project.');
  if (city.state === 'MAILED' || city.state === 'CLOSED') return refuse(`${city.city} is ${city.state}; leads are no longer useful there.`);
  let added = 0;
  let duplicates = 0;
  const refused: { index: number; reason: string }[] = [];
  for (const [index, lead] of input.leads.entries()) {
    const name = (lead.businessName ?? '').trim();
    const category = (lead.category ?? '').trim();
    const email = plainEmail(lead.email ?? '');
    if (!name) {
      refused.push({ index, reason: 'no business name' });
      continue;
    }
    if (!category) {
      refused.push({ index, reason: 'no category (one business per category per mailer)' });
      continue;
    }
    if (!email) {
      refused.push({ index, reason: 'not one plain business email address' });
      continue;
    }
    const wrote = await insertLead({
      projectId: input.projectId,
      cityId: city.id,
      businessName: name,
      category,
      categoryKey: mailerKey(category),
      email,
      emailKey: email.toLowerCase(),
      sourceUrl: lead.sourceUrl?.trim() || null,
    });
    if (wrote) added += 1;
    else duplicates += 1;
  }
  return { ok: true, added, duplicates, refused };
}

/** A lead says no, or asks not to be contacted again. Its held draft is withdrawn by the next pass. */
export async function setLeadResponse(input: {
  projectId: string;
  leadId: string;
  to: 'DECLINED' | 'OPTED_OUT';
}): Promise<{ ok: true; changed: boolean } | Refusal> {
  const lead = await getLead(input.leadId);
  if (!lead || lead.projectId !== input.projectId) return refuse('No such lead in this project.');
  const changed = await moveLead(lead.id, ['NEW', 'DRAFTED', 'DECLINED'], input.to);
  return { ok: true, changed };
}

/* ------------------------------------------------------------- the sales */

/**
 * Record that a business paid for a slot.
 *
 * A payment reference is required: an unpaid "yes" is not a slot, and the
 * reference is what makes this idempotent — the same reference recorded twice
 * is one slot, and a reference already used on another lead is refused.
 */
export async function recordSlotSale(input: {
  projectId: string;
  cityId: string;
  leadId: string;
  paymentRef: string;
  amountCents?: number;
  actorRef: string;
}): Promise<{ ok: true; slotNumber: number; replay: boolean; full: boolean } | Refusal> {
  const paymentRef = input.paymentRef.trim();
  if (paymentRef.length < 3) return refuse('Record the payment reference (Stripe id, check number…); an unpaid yes is not a slot.');
  const prior = await slotForPayment(input.projectId, paymentRef);
  if (prior) {
    if (prior.leadId !== input.leadId) return refuse('That payment reference is already recorded for another business.');
    const city = await getCity(prior.cityId);
    const sold = (await listSlots(prior.cityId)).length;
    return { ok: true, slotNumber: prior.slotNumber, replay: true, full: city ? sold >= city.slotCount : false };
  }
  const city = await getCity(input.cityId);
  if (!city || city.projectId !== input.projectId) return refuse('No such city in this project.');
  if (city.state !== 'SELLING') return refuse(`${city.city} is ${city.state}, not selling.`);
  const lead = await getLead(input.leadId);
  if (!lead || lead.cityId !== city.id) return refuse('That business is not a lead in this city.');
  if (lead.state === 'OPTED_OUT') return refuse('That business opted out.');
  const amountCents = input.amountCents ?? city.slotPriceCents;
  if (!Number.isInteger(amountCents) || amountCents <= 0) return refuse('The amount must be a positive number of cents.');

  // Up to slotCount tries: a concurrent sale may take the number we chose.
  for (let attempt = 0; attempt < city.slotCount; attempt += 1) {
    const slots = await listSlots(city.id);
    if (slots.some((s) => s.categoryKey === lead.categoryKey)) {
      return refuse(`The ${lead.category} slot in ${city.city} is already sold — one business per category.`);
    }
    if (slots.length >= city.slotCount) return refuse(`${city.city} is full.`);
    const taken = new Set(slots.map((s) => s.slotNumber));
    let next = 1;
    while (taken.has(next)) next += 1;
    const slot = await insertSlot({
      projectId: input.projectId,
      cityId: city.id,
      slotNumber: next,
      leadId: lead.id,
      categoryKey: lead.categoryKey,
      amountCents,
      paymentRef,
      recordedBy: input.actorRef,
    });
    if (!slot) {
      const raced = await slotForPayment(input.projectId, paymentRef);
      if (raced) return { ok: true, slotNumber: raced.slotNumber, replay: true, full: false };
      continue;
    }
    await moveLead(lead.id, ['NEW', 'DRAFTED', 'DECLINED'], 'SOLD');
    await withdrawHeldForCategory(city.id, lead.categoryKey);
    await recordCashEvent({
      projectId: input.projectId,
      kind: 'MAILER_SLOT_SOLD',
      actorRef: input.actorRef,
      summary: `${lead.businessName} bought slot ${next} of ${city.slotCount} in ${city.city} (${dollars(amountCents)}).`,
      detail: { cityId: city.id, leadId: lead.id, slotNumber: next, paymentRef },
    });
    return { ok: true, slotNumber: next, replay: false, full: slots.length + 1 >= city.slotCount };
  }
  return refuse('Could not take a slot number after several attempts; try again.');
}

/* ------------------------------------------------------------- print & mail */

/** The one spending decision: a person approves the print run for a FULL city. */
export async function approvePrint(input: { projectId: string; cityId: string; actorUserId: string }) {
  const city = await getCity(input.cityId);
  if (!city || city.projectId !== input.projectId) return refuse('No such city in this project.');
  if (city.state === 'PRINT_APPROVED') return { ok: true as const, changed: false };
  if (city.state !== 'FULL') return refuse(`${city.city} is ${city.state}; only a full mailer is printed.`);
  const changed = await moveCity({
    id: city.id,
    from: 'FULL',
    to: 'PRINT_APPROVED',
    stamp: 'print_approved_at',
    approvedBy: input.actorUserId,
  });
  if (changed) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: 'MAILER_PRINT_APPROVED',
      actorRef: input.actorUserId,
      summary: `Print run approved for ${city.city} (estimated ${dollars(city.printCostCents)}).`,
      detail: { cityId: city.id },
    });
  }
  return { ok: true as const, changed };
}

export async function markMailed(input: { projectId: string; cityId: string; actorRef: string }) {
  const city = await getCity(input.cityId);
  if (!city || city.projectId !== input.projectId) return refuse('No such city in this project.');
  if (city.state === 'MAILED') return { ok: true as const, changed: false };
  if (city.state !== 'PRINT_APPROVED') return refuse(`${city.city} is ${city.state}; it is mailed only after its print run is approved.`);
  const changed = await moveCity({ id: city.id, from: 'PRINT_APPROVED', to: 'MAILED', stamp: 'mailed_at' });
  if (changed) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: 'MAILER_MAILED',
      actorRef: input.actorRef,
      summary: `${city.city} mailer dropped.`,
      detail: { cityId: city.id },
    });
  }
  return { ok: true as const, changed };
}

/* ------------------------------------------------------------- the tick */

export function composeOutreach(city: MailerCity, lead: MailerLead): { subject: string; body: string } {
  const price = dollars(city.slotPriceCents);
  return {
    subject: `${lead.category} spot in the ${city.city} local mailer`,
    body: [
      `Hi ${lead.businessName},`,
      '',
      `We're putting together a printed mailer that goes to homes across ${city.city}, ${city.region}. ` +
        `It carries ${city.slotCount} local businesses, and only one per category — so if you take the ` +
        `${lead.category} spot, no competitor shares the page with you.`,
      '',
      `A spot is ${price}, design included. Once the ${city.slotCount} spots are taken it goes to print.`,
      '',
      'Want me to hold the spot for you? Reply here and I will send the details.',
      '',
      "If you'd rather not hear about this again, just reply \"no thanks\" and you won't.",
    ].join('\n'),
  };
}

export interface MailerPass {
  opened: string[];
  filled: string[];
  drafted: number;
  withdrawn: number;
  skipped?: string;
}

/**
 * One project's mailer step, derived from rows. Idempotent: a pass that dies
 * halfway resumes on the next tick.
 *
 * Winding the sprint down stops opening cities and composing outreach, and
 * nothing else — a sale already paid for is still recorded and a full city
 * still waits for its print run.
 */
export async function runMailer(projectId: string): Promise<MailerPass> {
  const pass: MailerPass = { opened: [], filled: [], drafted: 0, withdrawn: 0 };
  const mode = await getCashMode(projectId);
  if (!mode) return { ...pass, skipped: 'Cash Mode is not active here.' };
  const active = mode.state === 'ACTIVE';

  let cities = await listCities(projectId);
  // A selling city whose slots are all sold is full.
  for (const city of cities.filter((c) => c.state === 'SELLING')) {
    const sold = (await listSlots(city.id)).length;
    if (sold >= city.slotCount && (await moveCity({ id: city.id, from: 'SELLING', to: 'FULL', stamp: 'filled_at' }))) {
      pass.filled.push(city.id);
      await recordCashEvent({
        projectId,
        kind: 'MAILER_CITY_FULL',
        actorRef: 'BRAIN',
        summary:
          `${city.city} is full: ${sold} slots, ${dollars(sold * city.slotPriceCents)} sold. ` +
          `Its print run (about ${dollars(city.printCostCents)}) waits for your approval.`,
        detail: { cityId: city.id },
      });
    }
  }
  if (!active) return { ...pass, skipped: `The sprint is ${mode.state}; no new city is opened and no outreach is composed.` };

  cities = await listCities(projectId);
  if (!cities.some((c) => c.state === 'SELLING')) {
    const next = cities.find((c) => c.state === 'QUEUED');
    if (next && (await moveCity({ id: next.id, from: 'QUEUED', to: 'SELLING', stamp: 'opened_at' }))) {
      pass.opened.push(next.id);
      await recordCashEvent({
        projectId,
        kind: 'MAILER_CITY_OPENED',
        actorRef: 'BRAIN',
        summary: `Now selling ${next.city}, ${next.region}: ${next.slotCount} slots at ${dollars(next.slotPriceCents)}.`,
        detail: { cityId: next.id },
      });
    }
  }

  const selling = (await listCities(projectId)).find((c) => c.state === 'SELLING');
  if (!selling) return pass;
  const sold = new Set((await listSlots(selling.id)).map((s) => s.categoryKey));
  const leads = await listLeads(selling.id);
  for (const lead of leads) {
    if (lead.state === 'DECLINED' || lead.state === 'OPTED_OUT') {
      pass.withdrawn += await withdrawHeldForLead(selling.id, lead.id);
    }
  }
  for (const lead of leads) {
    if (pass.drafted >= MAX_DRAFTS_PER_PASS) break;
    if (lead.state !== 'NEW' || sold.has(lead.categoryKey)) continue;
    const { subject, body } = composeOutreach(selling, lead);
    if (await insertOutreach({ projectId, cityId: selling.id, leadId: lead.id, recipient: lead.email, subject, body })) {
      pass.drafted += 1;
    }
    await moveLead(lead.id, ['NEW'], 'DRAFTED');
  }
  return pass;
}

/* ------------------------------------------------------------- the view */

export interface MailerCityView {
  id: string;
  city: string;
  region: string;
  ordinal: number;
  state: MailerCity['state'];
  slots: { sold: number; total: number; left: number };
  categoriesSold: string[];
  leads: { total: number; target: number; drafted: number; declined: number; optedOut: number };
  outreach: { held: number; withdrawn: number; sent: number };
  money: {
    soldCents: number;
    potentialCents: number;
    printCostEstimateCents: number;
    netIfFullCents: number;
    netSoFarCents: number;
  };
  /** One sentence: what happens next here, and who does it. */
  next: string;
  nextBy: 'BRAIN' | 'PERSON' | 'NOBODY';
}

export async function mailerView(projectId: string): Promise<{ cities: MailerCityView[]; summary: string }> {
  const cities = await listCities(projectId);
  const views: MailerCityView[] = [];
  for (const city of cities) {
    const slots = await listSlots(city.id);
    const leads = await listLeads(city.id);
    const outreach = await listOutreach(city.id);
    const soldCents = slots.reduce((sum, s) => sum + s.amountCents, 0);
    const potentialCents = city.slotCount * city.slotPriceCents;
    const categoriesSold = slots
      .map((s) => leads.find((l) => l.id === s.leadId)?.category ?? s.categoryKey)
      .sort();
    const held = outreach.filter((o) => o.state === 'HELD').length;
    let next: string;
    let nextBy: MailerCityView['nextBy'] = 'BRAIN';
    switch (city.state) {
      case 'QUEUED':
        next = 'Opens by itself when the city ahead of it fills.';
        nextBy = 'NOBODY';
        break;
      case 'SELLING':
        if (leads.length < city.leadTarget) {
          next = `Needs business leads: ${leads.length} of ${city.leadTarget}. Add them and Brain drafts the outreach.`;
          nextBy = 'PERSON';
        } else if (held > 0) {
          next = `${held} outreach email(s) are drafted and held until you say send.`;
          nextBy = 'PERSON';
        } else {
          next = `Selling: ${city.slotCount - slots.length} slot(s) left. Record each payment as it lands.`;
          nextBy = 'PERSON';
        }
        break;
      case 'FULL':
        next = `Full. Approve the print run (about ${dollars(city.printCostCents)}) to send it to print.`;
        nextBy = 'PERSON';
        break;
      case 'PRINT_APPROVED':
        next = 'Print approved. Mark it mailed when the drop happens.';
        nextBy = 'PERSON';
        break;
      default:
        next = 'Done.';
        nextBy = 'NOBODY';
    }
    views.push({
      id: city.id,
      city: city.city,
      region: city.region,
      ordinal: city.ordinal,
      state: city.state,
      slots: { sold: slots.length, total: city.slotCount, left: Math.max(0, city.slotCount - slots.length) },
      categoriesSold,
      leads: {
        total: leads.length,
        target: city.leadTarget,
        drafted: leads.filter((l) => l.state === 'DRAFTED').length,
        declined: leads.filter((l) => l.state === 'DECLINED').length,
        optedOut: leads.filter((l) => l.state === 'OPTED_OUT').length,
      },
      outreach: {
        held,
        withdrawn: outreach.filter((o) => o.state === 'WITHDRAWN').length,
        sent: outreach.filter((o) => o.state === 'SENT').length,
      },
      money: {
        soldCents,
        potentialCents,
        printCostEstimateCents: city.printCostCents,
        netIfFullCents: potentialCents - city.printCostCents,
        netSoFarCents: soldCents - city.printCostCents,
      },
      next,
      nextBy,
    });
  }
  const selling = views.find((v) => v.state === 'SELLING');
  const summary = selling
    ? `Selling ${selling.city}: ${selling.slots.sold} of ${selling.slots.total} slots sold (${dollars(selling.money.soldCents)}).`
    : views.length === 0
      ? 'No city is queued. Queue one (any city) and Brain starts selling it.'
      : 'No city is selling right now.';
  return { cities: views, summary };
}

export async function heldOutreach(projectId: string, cityId: string) {
  const city = await getCity(cityId);
  if (!city || city.projectId !== projectId) return null;
  return (await listOutreach(cityId)).filter((o) => o.state === 'HELD');
}

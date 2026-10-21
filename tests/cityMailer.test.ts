/**
 * The rolling city mailer: one city at a time, sold until full, then the next.
 *
 * What is asserted is the half that matters most: nothing is sent and nothing
 * is spent by Brain; a slot exists only with a payment reference; one business
 * per category; and a full city opens the next by itself.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate, setLifecycle } from '../server/services/cash/lifecycle.ts';
import {
  addLeads,
  approvePrint,
  heldOutreach,
  mailerView,
  markMailed,
  queueCity,
  recordSlotSale,
  runMailer,
  setLeadResponse,
} from '../server/services/cash/mailer/index.ts';
import { listLeads } from '../server/repos/mailer.ts';
import { getDb } from '../server/db/database.ts';

let projectId: string;
let userId: string;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `mailer-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const outcome = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Sell local mailer slots city by city.',
  });
  expect(outcome.ok).toBe(true);
});

async function city(name: string, region: string, slotCount = 3) {
  const q = await queueCity({ projectId, city: name, region, actorRef: userId, slotCount, leadTarget: 4 });
  if (!q.ok) throw new Error(q.reason);
  return q.city;
}

const lead = (n: number, category: string) => ({
  businessName: `Business ${n}`,
  category,
  email: `owner${n}@biz${n}.example`,
});

async function sellAll(cityId: string, categories: string[]) {
  const leads = await listLeads(cityId);
  for (const [i, category] of categories.entries()) {
    const l = leads.find((x) => x.category === category && x.state !== 'SOLD');
    if (!l) throw new Error(`no lead for ${category}`);
    const sale = await recordSlotSale({ projectId, cityId, leadId: l.id, paymentRef: `pay_${cityId}_${i}`, actorRef: userId });
    if (!sale.ok) throw new Error(sale.reason);
  }
}

describe('the rolling city mailer', () => {
  it('uses the owner’s numbers by default: 16 slots at $500, about $3,000 to print', async () => {
    const q = await queueCity({ projectId, city: 'Austin', region: 'TX', actorRef: userId });
    expect(q.ok && q.city.slotCount).toBe(16);
    expect(q.ok && q.city.slotPriceCents).toBe(50_000);
    expect(q.ok && q.city.printCostCents).toBe(300_000);
    const view = await mailerView(projectId);
    expect(view.cities[0]?.money.potentialCents).toBe(800_000);
    expect(view.cities[0]?.money.netIfFullCents).toBe(500_000);
  });

  it('opens the first queued city, and the next one only when it is full', async () => {
    const austin = await city('Austin', 'TX');
    const boston = await city('Boston', 'MA');
    const pass = await runMailer(projectId);
    expect(pass.opened).toEqual([austin.id]);
    // A second pass opens nothing while Austin is still selling.
    expect((await runMailer(projectId)).opened).toEqual([]);

    await addLeads({ projectId, cityId: austin.id, leads: [lead(1, 'Plumber'), lead(2, 'Roofer'), lead(3, 'Dentist')] });
    await sellAll(austin.id, ['Plumber', 'Roofer', 'Dentist']);
    const next = await runMailer(projectId);
    expect(next.filled).toEqual([austin.id]);
    expect(next.opened).toEqual([boston.id]);

    const view = await mailerView(projectId);
    expect(view.cities.map((c) => c.state)).toEqual(['FULL', 'SELLING']);
    expect(view.cities[0]?.nextBy).toBe('PERSON');
    expect(view.cities[0]?.money.soldCents).toBe(150_000);
  });

  it('composes outreach and holds it — nothing is sent', async () => {
    const austin = await city('Austin', 'TX');
    await runMailer(projectId);
    await addLeads({ projectId, cityId: austin.id, leads: [lead(1, 'Plumber'), lead(2, 'Roofer')] });
    const pass = await runMailer(projectId);
    expect(pass.drafted).toBe(2);
    const held = await heldOutreach(projectId, austin.id);
    expect(held?.length).toBe(2);
    expect(held?.every((o) => o.state === 'HELD')).toBe(true);
    expect(held?.[0]?.body).toMatch(/only one per category/);
    expect(held?.[0]?.body).toMatch(/no thanks/);
    const sent = await getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM mailer_outreach WHERE state = 'SENT'");
    expect(Number(sent?.n)).toBe(0);
    // A replay drafts nothing twice.
    expect((await runMailer(projectId)).drafted).toBe(0);
  });

  it('sells one business per category, and withdraws the competitors’ drafts', async () => {
    const austin = await city('Austin', 'TX');
    await runMailer(projectId);
    await addLeads({ projectId, cityId: austin.id, leads: [lead(1, 'Plumber'), lead(2, 'plumber ')] });
    await runMailer(projectId);
    const leads = await listLeads(austin.id);
    const first = await recordSlotSale({ projectId, cityId: austin.id, leadId: leads[0]!.id, paymentRef: 'pay_1', actorRef: userId });
    expect(first.ok).toBe(true);
    const second = await recordSlotSale({ projectId, cityId: austin.id, leadId: leads[1]!.id, paymentRef: 'pay_2', actorRef: userId });
    expect(second.ok).toBe(false);
    expect((await heldOutreach(projectId, austin.id))?.length).toBe(0);
  });

  it('needs a payment reference, and the same payment is one slot', async () => {
    const austin = await city('Austin', 'TX');
    await runMailer(projectId);
    await addLeads({ projectId, cityId: austin.id, leads: [lead(1, 'Plumber'), lead(2, 'Roofer')] });
    const [a, b] = await listLeads(austin.id);
    expect((await recordSlotSale({ projectId, cityId: austin.id, leadId: a!.id, paymentRef: '', actorRef: userId })).ok).toBe(false);
    const once = await recordSlotSale({ projectId, cityId: austin.id, leadId: a!.id, paymentRef: 'pay_x', actorRef: userId });
    const again = await recordSlotSale({ projectId, cityId: austin.id, leadId: a!.id, paymentRef: 'pay_x', actorRef: userId });
    expect(once.ok && again.ok && again.replay).toBe(true);
    expect((await recordSlotSale({ projectId, cityId: austin.id, leadId: b!.id, paymentRef: 'pay_x', actorRef: userId })).ok).toBe(false);
    expect((await mailerView(projectId)).cities[0]?.slots.sold).toBe(1);
  });

  it('refuses a lead that is not one plain address, and dedupes by address', async () => {
    const austin = await city('Austin', 'TX');
    const result = await addLeads({
      projectId,
      cityId: austin.id,
      leads: [lead(1, 'Plumber'), lead(1, 'Plumber'), { businessName: 'X', category: 'Bakery', email: 'a@b.com, c@d.com' }],
    });
    expect(result.ok && result.added).toBe(1);
    expect(result.ok && result.duplicates).toBe(1);
    expect(result.ok && result.refused.length).toBe(1);
  });

  it('withdraws the draft of a business that opted out', async () => {
    const austin = await city('Austin', 'TX');
    await runMailer(projectId);
    await addLeads({ projectId, cityId: austin.id, leads: [lead(1, 'Plumber')] });
    await runMailer(projectId);
    const [l] = await listLeads(austin.id);
    await setLeadResponse({ projectId, leadId: l!.id, to: 'OPTED_OUT' });
    const pass = await runMailer(projectId);
    expect(pass.withdrawn).toBe(1);
    expect((await recordSlotSale({ projectId, cityId: austin.id, leadId: l!.id, paymentRef: 'p', actorRef: userId })).ok).toBe(false);
  });

  it('prints only a full city, and only on a person’s approval', async () => {
    const austin = await city('Austin', 'TX', 1);
    await runMailer(projectId);
    expect((await approvePrint({ projectId, cityId: austin.id, actorUserId: userId })).ok).toBe(false);
    await addLeads({ projectId, cityId: austin.id, leads: [lead(1, 'Plumber')] });
    await sellAll(austin.id, ['Plumber']);
    await runMailer(projectId);
    expect((await markMailed({ projectId, cityId: austin.id, actorRef: userId })).ok).toBe(false);
    expect((await approvePrint({ projectId, cityId: austin.id, actorUserId: userId })).ok).toBe(true);
    expect((await markMailed({ projectId, cityId: austin.id, actorRef: userId })).ok).toBe(true);
    expect((await mailerView(projectId)).cities[0]?.state).toBe('MAILED');
  });

  it('winding down opens no new city and drafts nothing, but still fills a sold-out one', async () => {
    const austin = await city('Austin', 'TX', 1);
    await city('Boston', 'MA');
    await runMailer(projectId);
    await addLeads({ projectId, cityId: austin.id, leads: [lead(1, 'Plumber')] });
    await sellAll(austin.id, ['Plumber']);
    await setLifecycle({ projectId, to: 'WINDING_DOWN', actorUserId: userId, reason: 'test' });
    const pass = await runMailer(projectId);
    expect(pass.filled).toEqual([austin.id]);
    expect(pass.opened).toEqual([]);
    expect(pass.drafted).toBe(0);
  });

  it('never has two cities selling at once', async () => {
    await city('Austin', 'TX');
    await city('Boston', 'MA');
    await Promise.all([runMailer(projectId), runMailer(projectId), runMailer(projectId)]);
    const selling = (await mailerView(projectId)).cities.filter((c) => c.state === 'SELLING');
    expect(selling.length).toBe(1);
  });
});

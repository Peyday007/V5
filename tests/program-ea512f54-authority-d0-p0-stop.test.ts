/**
 * AUTH-34 (S-0481): a person can turn the emergency stop on and off.
 *
 * The action path reads the stop (`decideAction` → `emergencyStopOn`); this
 * proves the control a person reaches — the terminal in
 * `server/services/cash/emergencyStopCli.ts` — writes it through
 * `setEmergencyStop`, that a stopped project refuses a consequential action
 * while internal work continues, that resuming lifts it, and that only an
 * enabled administrator or the Cash Mode owner may use it, with a reason.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  EMERGENCY_RESUME_KIND,
  EMERGENCY_STOP_KIND,
  decideAction,
  emergencyStopOn,
} from '../server/services/cash/authority.ts';
import { runEmergencyStopCommand } from '../server/services/cash/emergencyStopCli.ts';

let projectId = '';
let slug = '';
let ownerId = '';
let ownerEmail = '';
const suffix = (): string => Math.random().toString(36).slice(2, 10);

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  slug = fixture.project.slug;
  ownerEmail = `stop-owner-${suffix()}@example.test`;
  ownerId = (await createUser({ email: ownerEmail, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: ownerId, actorUserId: ownerId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
  await createAuthority({
    projectId,
    ownerUserId: ownerId,
    createdByUserId: ownerId,
    name: 'Commercial authority',
    allowedActions: ['QUOTE_AND_INVOICE'],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('the emergency stop terminal', () => {
  it('stops consequential actions on the real action path and resumes them, recording who and why', async () => {
    expect((await decideAction({ projectId, action: 'QUOTE_AND_INVOICE', principal: ownerId })).ok).toBe(true);

    const stop = await runEmergencyStopCommand(['stop', '--project', projectId, '--as', ownerEmail, '--reason', 'a buyer disputes the invoice']);
    expect(stop.code).toBe(0);
    expect(stop.out).toMatch(/ON/);
    expect(await emergencyStopOn(projectId)).toBe(true);
    const stops = await cashEventsOfKindInProject(projectId, EMERGENCY_STOP_KIND);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ actorRef: ownerId, summary: 'a buyer disputes the invoice' });

    const refused = await decideAction({ projectId, action: 'QUOTE_AND_INVOICE', principal: ownerId });
    expect(refused.ok).toBe(false);
    expect(refused.ledger.cause).toBe('EMERGENCY_STOP');
    // Internal work carries on under a stop.
    expect((await decideAction({ projectId, action: 'CALCULATE', principal: ownerId })).ok).toBe(true);

    await tick();
    const resume = await runEmergencyStopCommand(['resume', '--project', slug, '--as', ownerEmail, '--reason', 'dispute resolved']);
    expect(resume.code).toBe(0);
    expect(resume.out).toMatch(/OFF/);
    await tick();
    expect(await emergencyStopOn(projectId)).toBe(false);
    expect(await cashEventsOfKindInProject(projectId, EMERGENCY_RESUME_KIND)).toHaveLength(1);
    expect((await decideAction({ projectId, action: 'QUOTE_AND_INVOICE', principal: ownerId })).ok).toBe(true);
  });

  it('reports the state without changing it', async () => {
    const before = await runEmergencyStopCommand(['status', '--project', projectId]);
    expect(before).toMatchObject({ code: 0 });
    expect(before.out).toMatch(/OFF/);
    expect(await cashEventsOfKindInProject(projectId, EMERGENCY_STOP_KIND)).toHaveLength(0);
  });

  it('lets an enabled administrator stop a project they do not own', async () => {
    const adminEmail = `stop-admin-${suffix()}@example.test`;
    await createUser({ email: adminEmail, displayName: 'Admin', password: 'correct horse battery staple', isBrainAdmin: true });
    const stop = await runEmergencyStopCommand(['stop', '--project', projectId, '--as', adminEmail, '--reason', 'provider incident']);
    expect(stop.code).toBe(0);
    expect(await emergencyStopOn(projectId)).toBe(true);
  });

  it('refuses anyone else, a missing reason, an unknown project and an unknown command, writing nothing', async () => {
    const strangerEmail = `stop-stranger-${suffix()}@example.test`;
    await createUser({ email: strangerEmail, displayName: 'Stranger', password: 'correct horse battery staple' });
    expect((await runEmergencyStopCommand(['stop', '--project', projectId, '--as', strangerEmail, '--reason', 'x'])).code).toBe(1);
    expect((await runEmergencyStopCommand(['stop', '--project', projectId, '--as', 'nobody@example.test', '--reason', 'x'])).code).toBe(1);
    expect((await runEmergencyStopCommand(['stop', '--project', projectId, '--as', ownerEmail])).code).toBe(2);
    expect((await runEmergencyStopCommand(['stop', '--project', 'no-such-project', '--as', ownerEmail, '--reason', 'x'])).code).toBe(1);
    expect((await runEmergencyStopCommand(['toggle', '--project', projectId])).code).toBe(2);
    expect(await cashEventsOfKindInProject(projectId, EMERGENCY_STOP_KIND)).toHaveLength(0);
    expect(await emergencyStopOn(projectId)).toBe(false);
  });
});

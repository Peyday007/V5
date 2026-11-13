/**
 * AUTH-20-3, AUTH-21-6 and AUTH-34 are judged from the authority ledger's rows,
 * and fail — with the reason — until real decisions are on it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import { recordCashEvent } from '../server/repos/cashMode.ts';

let t: TestProject;
beforeEach(async () => {
  t = await freshProject();
});
afterEach(async () => {
  await teardown();
});

const NAMES = ['r01.auth-20-3', 'r01.auth-21-6', 'r01.auth-34'];

async function decision(detail: Record<string, unknown>): Promise<void> {
  await recordCashEvent({
    projectId: t.project.id,
    kind: 'AUTHORITY_DECISION',
    actorRef: 'BRAIN',
    summary: `${String(detail.action)}: ${String(detail.disposition)}`,
    detail: { path: 'API', principal: 'usr_owner', scope: { projectId: t.project.id, accountRef: null }, policyVersion: 1, amountCents: null, ok: false, approvalNeedId: null, neededApproval: null, ...detail },
  });
}

describe('the authority probes', () => {
  it('fail on a Brain where no action has been judged', async () => {
    for (const name of NAMES) {
      const result = await getProbe(name)!({});
      expect(result.ok, `${name}: ${result.detail}`).toBe(false);
      expect(result.detail).toMatch(/no AUTHORITY_DECISION row/);
    }
  });

  it('pass on a ledger of well-formed decisions, every performed one authorized', async () => {
    await decision({ action: 'CONTACT_BUYER', consequenceClass: 'EXTERNALLY_CONSEQUENTIAL', disposition: 'PERFORMED', cause: 'ALLOWED', ok: true });
    await decision({ action: 'FACTORY_DEPLOY', consequenceClass: 'STANDING_GRANT_ENGINEERING', disposition: 'PERFORMED', cause: 'RELEASE_ENVELOPE', ok: true });
    await decision({ action: 'AUTHENTICATED_OPERATION', consequenceClass: 'THIRD_PARTY_AUTHENTICATED', path: 'BROWSER', disposition: 'REFUSED', cause: 'READ_ONLY_GRANT' });
    for (const name of NAMES) {
      const result = await getProbe(name)!({});
      expect(result.ok, `${name}: ${result.detail}`).toBe(true);
    }
  });

  it('fail when a read-only grant carried an act, or an act ran without an authorizing cause', async () => {
    await decision({ action: 'SEND_OUTREACH', consequenceClass: 'EXTERNALLY_CONSEQUENTIAL', disposition: 'PERFORMED', cause: 'READ_ONLY_GRANT', ok: true });
    for (const name of NAMES) expect((await getProbe(name)!({})).ok, name).toBe(false);
  });

  it('fail AUTH-34 when an act was performed under an emergency stop, or a halt left no record of its obligations', async () => {
    await recordCashEvent({ projectId: t.project.id, kind: 'AUTHORITY_EMERGENCY_STOP', actorRef: 'usr_owner', summary: 'stop', detail: {} });
    await decision({ action: 'CONTACT_BUYER', consequenceClass: 'EXTERNALLY_CONSEQUENTIAL', disposition: 'REFUSED', cause: 'EMERGENCY_STOP' });
    const missing = await getProbe('r01.auth-34')!({});
    expect(missing.ok).toBe(false);
    expect(missing.detail).toMatch(/obligations/);
    await recordCashEvent({ projectId: t.project.id, kind: 'AUTHORITY_ACTION_SUSPENDED', actorRef: 'BRAIN', summary: 'held', detail: { action: 'CONTACT_BUYER', cause: 'EMERGENCY_STOP', heldCommitmentIds: [] } });
    expect((await getProbe('r01.auth-34')!({})).ok).toBe(true);
    await decision({ action: 'CONTACT_BUYER', consequenceClass: 'EXTERNALLY_CONSEQUENTIAL', disposition: 'PERFORMED', cause: 'ALLOWED', ok: true });
    const under = await getProbe('r01.auth-34')!({});
    expect(under.ok).toBe(false);
    expect(under.detail).toMatch(/emergency stop/);
  });

  it('fail AUTH-20-3 when a missing approval was named but never stored as a request', async () => {
    await decision({ action: 'RUN_PAID_TEST', consequenceClass: 'EXTERNALLY_CONSEQUENTIAL', disposition: 'REFUSED', cause: 'OVER_PER_ACTION_CEILING', neededApproval: 'raise the per-action ceiling' });
    const result = await getProbe('r01.auth-20-3')!({});
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/stored no request/);
  });
});

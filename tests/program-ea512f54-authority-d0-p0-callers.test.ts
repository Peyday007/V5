/**
 * F-CALLERS-PASS-NO-PATH-ACCESS-PRINCIPAL: every production caller of
 * `checkCommercialAuthority` used to pass only `{ projectId, action }`, so
 * every ledger row said `principal: null` whoever acted, and the path and
 * access the judgment reads were never stated on the real action path.
 *
 * These tests drive the real production functions and read the rows they
 * write. The structural check would catch a new caller that forgets the context.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  AUTHORITY_DECISION_KIND,
  BRAIN_PRINCIPAL,
  actionContext,
  checkCommercialAuthority,
} from '../server/services/cash/authority.ts';
import { commitSpend } from '../server/services/cash/opportunities.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `callers-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function grant(allowedActions: string[]) {
  return createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Commercial authority',
    allowedActions,
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
}

const decisions = async () =>
  (await cashEventsOfKindInProject(projectId, AUTHORITY_DECISION_KIND)).map((row) => row.detail as Record<string, unknown>);

/** Every `checkCommercialAuthority(` call in the cash action paths, with the text of its argument list. */
function callsIn(dir: string): Array<{ file: string; args: string }> {
  const out: Array<{ file: string; args: string }> = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && entry.name !== 'authority.ts') {
        const text = fs.readFileSync(full, 'utf8');
        const marker = 'await checkCommercialAuthority(';
        for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + 1)) {
          let depth = 0;
          let end = at + marker.length - 1;
          for (; end < text.length; end += 1) {
            if (text[end] === '(') depth += 1;
            else if (text[end] === ')' && --depth === 0) break;
          }
          out.push({ file: path.relative(process.cwd(), full), args: text.slice(at + marker.length, end) });
        }
      }
    }
  };
  walk(dir);
  return out;
}

describe('every production caller states who acts and how', () => {
  it('each checkCommercialAuthority call in the cash action paths composes an actionContext', () => {
    const calls = callsIn(path.join(process.cwd(), 'server/services/cash'));
    expect(calls.length).toBeGreaterThanOrEqual(12);
    const bare = calls.filter((call) => !call.args.includes('actionContext('));
    expect(bare.map((call) => `${call.file}: ${call.args.replace(/\s+/g, ' ').slice(0, 120)}`)).toEqual([]);
  });
});

describe('actionContext composes the facts from what the caller knows', () => {
  it('Brain performing through a provider adapter is API under operating access; a person recording their own act is INTERNAL', () => {
    expect(actionContext({ principal: BRAIN_PRINCIPAL })).toEqual({ principal: 'BRAIN', path: 'API', access: 'OPERATE', amountCents: null });
    expect(actionContext({ principal: 'usr_1', performedBy: 'PERSON', amountCents: 1_200 })).toEqual({
      principal: 'usr_1',
      path: 'INTERNAL',
      access: 'OPERATE',
      amountCents: 1_200,
    });
    expect(actionContext({ principal: 'usr_1', path: 'BROWSER', access: 'READ_ONLY' })).toMatchObject({ path: 'BROWSER', access: 'READ_ONLY' });
  });

  it('an empty principal stays unknown and is never read as Brain', () => {
    expect(actionContext({ principal: '  ' }).principal).toBeNull();
    expect(actionContext({ principal: 'usr_1', amountCents: Number.NaN }).amountCents).toBeNull();
  });

  it('a read-only context on the browser path is refused as read-only, and the row names the principal and path', async () => {
    await grant(['CONTACT_BUYER']);
    const decision = await checkCommercialAuthority({
      projectId,
      action: 'CONTACT_BUYER',
      ...actionContext({ principal: userId, path: 'BROWSER', access: 'READ_ONLY' }),
    });
    expect(decision.ok).toBe(false);
    const [row] = await decisions();
    expect(row).toMatchObject({ action: 'CONTACT_BUYER', cause: 'READ_ONLY_GRANT', path: 'BROWSER', principal: userId, disposition: 'REFUSED' });
  });
});

describe('the real action path records the responsible principal', () => {
  it('commitSpend ledgers its decision under the person who committed, on the API path', async () => {
    await grant(['SPEND_FROM_ALLOWANCE']);
    await commitSpend({
      projectId,
      action: 'SPEND_FROM_ALLOWANCE',
      amountCents: 2_500,
      purpose: 'Buy a supplier quote',
      expectedResult: 'A quotable cost',
      stopCondition: 'Stop at one quote',
      idempotencyKey: 'callers-commit',
      actorRef: userId,
    });
    const rows = await decisions();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.principal).toBe(userId);
      expect(row.path).toBe('API');
    }
  });

  it('a refusal on the real path still names who asked', async () => {
    // No grant: refused, and the refusal row says who was refused.
    const outcome = await commitSpend({
      projectId,
      action: 'SPEND_FROM_ALLOWANCE',
      amountCents: 2_500,
      purpose: 'Buy a supplier quote',
      expectedResult: 'A quotable cost',
      stopCondition: 'Stop at one quote',
      idempotencyKey: 'callers-refused',
      actorRef: userId,
    });
    expect(outcome.ok).toBe(false);
    const [row] = await decisions();
    expect(row).toMatchObject({ action: 'SPEND_FROM_ALLOWANCE', disposition: 'REFUSED', principal: userId, path: 'API' });
  });
});

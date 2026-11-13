/**
 * CONT-35 (S-0484, S-0486): the continuity account reaches the caller who
 * would act on a wrong belief. Every idempotent route refuses a retry through
 * `runIdempotentRequest`; when an earlier attempt is unknown or settled as
 * failed, the refusal carries what Brain knows and what remains uncertain —
 * read from the effects engine's rows — and nothing a caller did not already
 * hold (invariant 30).
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { HttpError } from '../server/routes/helpers.ts';
import { runIdempotentRequest } from '../server/services/effects/http.ts';
import { TerminalEffectFailure, type OperationNamespace } from '../server/services/effects/engine.ts';
import { listOperations, markUncertain } from '../server/repos/idempotency.ts';
import { operationContinuity } from '../server/services/effects/continuity.ts';

const NS: OperationNamespace = { name: 'continuity.consumer', version: 1, principalScope: 'PRINCIPAL', retention: 'PERMANENT' };

let projectId = '';
let seq = 0;
const nextKey = (): string => `continuity-consumer-${String(++seq).padStart(8, '0')}`;

const request = (key: string, execute: () => Promise<{ value: string }>) =>
  runIdempotentRequest<string>(
    { namespace: NS, projectId, key, payload: { note: 'x' }, principalType: 'HUMAN', principalId: 'usr_one', replay: async () => 'replayed' },
    execute,
  );

async function refusal(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

describe('the continuity account at the point of retry', () => {
  it('a retry of an operation whose outcome is unknown is told what is known and what remains uncertain', async () => {
    const key = nextKey();
    await expect(request(key, async () => { throw new Error('socket hang up'); })).rejects.toThrow('socket hang up');
    const [operation] = await listOperations(projectId, { limit: 10 });
    expect(operation).toBeDefined();
    expect(await markUncertain(operation!.id, 'provider said rcpt_private_123 then went silent')).toBe(true);

    let executed = false;
    const refused = await refusal(request(key, async () => { executed = true; return { value: 'again' }; }));
    expect(executed).toBe(false);
    expect(refused.status).toBe(409);
    const detail = refused.detail as Record<string, unknown>;
    expect(detail).toMatchObject({
      reason: 'RECONCILIATION_REQUIRED',
      operationId: operation!.id,
      continuity: { class: 'UNKNOWN', retrySafe: false, needsReconciliation: true, attempts: 1 },
    });
    const continuity = detail.continuity as { known: string; uncertain: string | null };
    expect(continuity.known).toMatch(/not established/);
    expect(continuity.uncertain).toMatch(/may have taken effect/);
    // The recorded reason carries provider words; the caller-safe projection does not.
    expect(JSON.stringify(detail)).not.toContain('rcpt_private_123');
    expect(await operationContinuity(operation!.id)).toEqual(detail.continuity);
  });

  it('a retry of a terminally refused operation is told the refusal is final, without the provider words', async () => {
    const key = nextKey();
    await expect(
      request(key, async () => { throw new TerminalEffectFailure('PROVIDER_REJECTED', 'private provider words'); }),
    ).rejects.toThrow('private provider words');

    const refused = await refusal(request(key, async () => ({ value: 'again' })));
    expect(refused.status).toBe(409);
    const detail = refused.detail as Record<string, unknown>;
    expect(detail).toMatchObject({
      reason: 'ALREADY_TERMINAL',
      continuity: { class: 'FAILED_EXTERNAL_CONSTRAINT', retrySafe: false, needsReconciliation: false, uncertain: null },
    });
    expect(JSON.stringify(detail)).not.toContain('private provider words');
  });

  it('a successful request is unchanged, and a missing operation has no report', async () => {
    const reply = await request(nextKey(), async () => ({ value: 'done' }));
    expect(reply).toMatchObject({ value: 'done', replayed: false });
    expect(await operationContinuity('op_does_not_exist')).toBeNull();
  });

  it('the account has a consumer outside tests: the idempotent request layer every idempotent route uses', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const http = fs.readFileSync(path.join(root, 'server/services/effects/http.ts'), 'utf8');
    expect(http).toMatch(/from '\.\/continuity\.ts'/);
    expect((http.match(/continuity: await operationContinuity\(/g) ?? []).length).toBe(3);
    const routes = ['projects.ts', 'work.ts', 'connect.ts'].filter((file) =>
      fs.readFileSync(path.join(root, 'server/routes', file), 'utf8').includes('runIdempotentRequest'),
    );
    expect(routes.length).toBeGreaterThan(0);
  });
});

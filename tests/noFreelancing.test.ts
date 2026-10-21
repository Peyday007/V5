/**
 * The owner rejected freelance work as a Cash Mode strategy (2026-10-20).
 *
 * That decision has to reach behaviour, not just a document: the operation
 * must not run on the tick, its prepared bids must not read as execution jobs,
 * no worker may be pointed at a marketplace's API, and the operations file must
 * not tell anybody to connect a freelance account. Each assertion below reads
 * the thing that would otherwise drift.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FREELANCER_OPERATION_ENV,
  freelancerOperationEnabled,
} from '../server/services/cash/freelancer/enabled.ts';
import { READABLE_ROUTES } from '../server/services/research/readableRoutes.ts';
import { executionFrameSentence } from '../server/services/cash/discovery.ts';

const root = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

afterEach(() => {
  delete process.env[FREELANCER_OPERATION_ENV];
});

describe('no freelancing', () => {
  it('is off unless a deployment explicitly turns it on', () => {
    expect(freelancerOperationEnabled()).toBe(false);
    process.env[FREELANCER_OPERATION_ENV] = 'true';
    expect(freelancerOperationEnabled()).toBe(false);
    process.env[FREELANCER_OPERATION_ENV] = 'on';
    expect(freelancerOperationEnabled()).toBe(true);
  });

  it('the Russell tick runs the operation only behind the switch', () => {
    const loop = read('server/services/russell/loop.ts');
    const calls = loop.match(/runFreelancerOperation\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(loop).toMatch(/freelancerOperationEnabled\(\)\s*\?\s*await runFreelancerOperation\(/);
  });

  it('the Cash pipeline reads no marketplace job while the operation is off', () => {
    const pipeline = read('server/services/cash/marketplacePipeline.ts');
    expect(pipeline).toMatch(/if \(!freelancerOperationEnabled\(\)\) return \[\];/);
  });

  it('no worker is pointed at a freelance marketplace', () => {
    expect(READABLE_ROUTES.map((route) => route.host)).not.toContain('freelancer.com');
  });

  it('discovery says this operation does not take freelance work', () => {
    const frame = executionFrameSentence({ delivers: [], deployableCents: 0, currency: 'USD' });
    expect(frame).toMatch(/does not take freelance work/);
    expect(frame).not.toMatch(/reads Freelancer itself/);
  });

  it('discovery no longer hunts posted gigs, briefs or listings', async () => {
    const { SEARCH_BUCKETS } = await import('../server/services/cash/discovery.ts');
    expect(SEARCH_BUCKETS.map((one) => one.id)).not.toContain('explicit-paid-request');
    for (const bucket of SEARCH_BUCKETS) {
      expect(bucket.question).not.toMatch(/\bon boards\b|posting or listing for work/i);
    }
  });

  it('the operations file asks nobody to connect a freelance account', () => {
    const ops = read('fast-cash/OPS.md');
    expect(ops).toMatch(/No freelancing/);
    expect(ops).not.toMatch(/freelancer\.com\/signup/i);
    expect(ops).not.toMatch(/FREELANCER_OAUTH_TOKEN/);
    const watch = JSON.parse(read('fast-cash/watch.json')) as { freelancer: unknown[] };
    expect(watch.freelancer).toEqual([]);
  });
});

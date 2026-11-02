/**
 * The browser's cancel and resume controls must not rewrite a finished packet,
 * and a refused resume must say so rather than answer 200.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProject, teardown } from './helpers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration, getOrchestration, updateOrchestration } from '../server/repos/research.ts';
import { listEventsByEntity } from '../server/repos/events.ts';
import { cancelResearch, resumeRefusal, resumeResearch } from '../server/services/research/queue.ts';
import { researchRouter } from '../server/routes/research.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import type { Principal } from '../server/domain/types.ts';

let projectId = '';
let layerId = '';
let server: Server | null = null;
let base = '';

async function make(provider: string, status: string) {
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', provider });
  const o = await createOrchestration({
    projectId, layerId, runId: run.id, title: 't', assignment: 'a', provider,
  });
  await updateOrchestration(o.id, { status: status as any, failureReason: 'kept' });
  return (await getOrchestration(o.id))!;
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = fixture.layers[0]!.id;
  const principal = {
    type: 'HUMAN', id: 'usr_t', handle: 't', displayName: 't', isBrainAdmin: true,
    mustChangePassword: false, credentialId: 's', authMethod: 'SESSION_COOKIE',
    memberships: [], requestId: 'r',
  } as unknown as Principal;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, { principal, requestId: newRequestId(), method: req.method, path: req.path, remoteAddr: null, userAgent: null });
    next();
  });
  app.use('/api', researchRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(typeof error?.status === 'number' ? error.status : 500).json({ error: String(error?.message ?? error) });
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  await teardown();
});

describe('cancel and resume leave finished packets alone', () => {
  it('A01: cancelling COMPLETE_WITH_GAPS changes nothing', async () => {
    const o = await make('MOCK', 'COMPLETE_WITH_GAPS');
    const result = await cancelResearch(o.id, 'nope');
    expect(result!.status).toBe('COMPLETE_WITH_GAPS');
    const after = (await getOrchestration(o.id))!;
    expect(after.cancelledAt).toBeNull();
    expect(after.cancelReason).toBeNull();
    const events = await listEventsByEntity('RUN', o.runId);
    expect(events.map((e) => e.eventType)).not.toContain('RESEARCH_CANCELLED');
  });

  it('A02: resume refuses finished and worker-driven packets, writing nothing', async () => {
    for (const [provider, status] of [['MOCK', 'COMPLETE'], ['MOCK', 'COMPLETE_WITH_GAPS'], ['WORKER', 'INTERRUPTED']] as const) {
      const o = await make(provider, status);
      await expect(resumeResearch(o.id)).rejects.toThrow();
      const after = (await getOrchestration(o.id))!;
      expect(after.status).toBe(status);
      expect(after.failureReason).toBe('kept');
    }
    expect(resumeRefusal({ status: 'CANCELLED', provider: 'MOCK' })).toBeNull();
    expect(resumeRefusal({ status: 'INTERRUPTED', provider: 'MOCK' })).toBeNull();
  });

  it('A03: the route answers 409 with the sentence and writes nothing', async () => {
    const o = await make('MOCK', 'COMPLETE_WITH_GAPS');
    const response = await fetch(`${base}/api/research/${o.id}/resume`, { method: 'POST' });
    expect(response.status).toBe(409);
    const body: any = await response.json();
    expect(body.error).toBe(resumeRefusal(o));
    expect((await getOrchestration(o.id))!.status).toBe('COMPLETE_WITH_GAPS');

    const src = fs.readFileSync('server/routes/research.ts', 'utf8');
    expect(src).not.toMatch(/void\s+resumeResearch\(/);
    expect(src).toMatch(/resumeResearch\([^)]*\)\s*\.catch\(/);
  });

  it('A04: queue.ts reads TERMINAL_ORCHESTRATION, not a literal list', () => {
    const src = fs.readFileSync('server/services/research/queue.ts', 'utf8');
    expect(src).toContain('TERMINAL_ORCHESTRATION');
    expect(src).not.toMatch(/\['COMPLETE',\s*'CANCELLED',\s*'FAILED'\]/);
  });
});

/**
 * Historical memory at the door: a person's history is theirs alone.
 *
 *   * A worker is refused by type, reads included.
 *   * Somebody else's idea, conversation or archive reads exactly like one that
 *     does not exist — same status, same body.
 *   * The import path works over HTTP end to end, through the same uploader the
 *     page and the terminal importer use, and resumes when re-run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { memoryRouter } from '../server/routes/memory.ts';
import { uploadArchive, type ArchiveEntrySource } from '../server/services/memory/upload.ts';
import type { Principal } from '../server/domain/types.ts';

let server: Server | null = null;
let base = '';
let ownerId = '';
let otherId = '';
let current: Principal | null = null;

function person(id: string, authMethod = 'SESSION_COOKIE'): Principal {
  return {
    type: 'HUMAN', id, handle: `${id}@example.test`, displayName: 'P', isBrainAdmin: false, mustChangePassword: false,
    credentialId: 'ses', authMethod, memberships: [], requestId: 'req',
  } as unknown as Principal;
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

function exportOf(): string {
  const mapping: Record<string, unknown> = {
    r: { id: 'r', parent: null, children: ['a'], message: null },
    a: { id: 'a', parent: 'r', children: ['b'], message: { id: 'a', author: { role: 'user' }, content: { content_type: 'text', parts: ['My dream is to open a bookshop café by the sea. But I cannot afford the lease.'] }, create_time: 1714000000 } },
    b: { id: 'b', parent: 'a', children: [], message: { id: 'b', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['That sounds wonderful.'] }, create_time: 1714000060 } },
  };
  return JSON.stringify([{ id: 'conv-http-1', title: 'Bookshop', create_time: 1714000000, update_time: 1714000060, mapping, current_node: 'b' }]);
}

beforeEach(async () => {
  await freshProject();
  ownerId = (await createUser({ email: `h-${Math.random().toString(36).slice(2, 9)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  otherId = (await createUser({ email: `x-${Math.random().toString(36).slice(2, 9)}@example.test`, displayName: 'Other', password: 'correct horse battery staple' })).id;
  current = person(ownerId);
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, _res, next) => {
    attachContext(req, { principal: current, requestId: newRequestId(), method: req.method, path: req.path, remoteAddr: null, userAgent: null });
    next();
  });
  app.use('/api', memoryRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(typeof error?.status === 'number' ? error.status : 500).json({ error: String(error?.message ?? error) });
  });
  // Port 0: this suite owns no range.
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

const entries = (): ArchiveEntrySource[] => [
  { name: 'conversations.json', size: null, text: async () => exportOf(), base64: async () => '' },
];

const post = async <T,>(path: string, body: unknown): Promise<T> => {
  const r = await call('POST', path, body);
  if (r.status !== 200) throw new Error(`${path} ${r.status} ${r.text}`);
  return r.body as T;
};

describe('historical memory over HTTP', () => {
  it('imports, resumes, surfaces, and refuses everyone else', async () => {
    const first = await uploadArchive({ label: 'export.zip', entries: entries(), post });
    expect(first).toMatchObject({ declared: 1, sent: 1, alreadyHeld: 0 });
    const again = await uploadArchive({ label: 'export.zip', entries: entries(), post });
    expect(again).toMatchObject({ declared: 1, sent: 0, alreadyHeld: 1 });

    await call('POST', '/api/memory/process', {});
    const ideas = await call('GET', '/api/memory/ideas');
    const bookshop = ideas.body.ideas.find((i: { title: string }) => /bookshop/i.test(i.title));
    expect(bookshop).toBeTruthy();
    const coverage = await call('GET', '/api/memory/coverage');
    expect(coverage.body.coverage.conversations.recovered).toBe(1);

    // Another person: absent and forbidden are one answer.
    current = person(otherId);
    const theirs = await call('GET', `/api/memory/ideas/${bookshop.id}`);
    const invented = await call('GET', '/api/memory/ideas/mid_does_not_exist');
    expect(theirs.status).toBe(404);
    expect(theirs.text).toBe(invented.text);
    expect((await call('POST', `/api/memory/ideas/${bookshop.id}/decide`, { decision: 'NOT_INTERESTED' })).text).toBe(invented.text);
    expect((await call('GET', '/api/memory/coverage')).body.coverage.conversations.total).toBe(0);

    // A worker is refused by type, reads included.
    current = { ...person('wrk_x'), type: 'WORKER', authMethod: 'WORKER_BEARER' } as unknown as Principal;
    for (const path of ['/api/memory/overview', '/api/memory/discoveries', '/api/memory/ideas', `/api/memory/ideas/${bookshop.id}`]) {
      expect((await call('GET', path)).status, path).toBe(404);
    }
    expect((await call('POST', '/api/memory/archives', { sourceFormat: 'CHATGPT_OFFICIAL', entries: [] })).status).toBe(404);

    // The person's own bridge credential may import (the terminal path).
    current = person(ownerId, 'BRIDGE_BEARER');
    expect((await call('GET', '/api/memory/archives')).status).toBe(200);
  });
});

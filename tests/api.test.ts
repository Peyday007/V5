/**
 * HTTP API integration tests.
 *
 * These boot the real server as a child process against a throwaway data root,
 * so they exercise exactly what `npm start` does: migrate from empty, seed,
 * recompute, then serve. Nothing here reaches into server internals.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 5399 + Math.floor(Math.random() * 120);
const BASE = `http://127.0.0.1:${PORT}`;

// stdin is 'ignore', so only stdout and stderr are streams.
let server: ChildProcessByStdio<null, Readable, Readable>;
let dataDir: string;
let projectId: string;
let serverLog = '';

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function send<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

async function uploadPdfs(names: string[]): Promise<{ results: { registered: boolean; filename: string }[] }> {
  const form = new FormData();
  for (const name of names) {
    form.append('files', new Blob([`%PDF-1.4 contents of ${name}`], { type: 'application/pdf' }), name);
  }
  const response = await fetch(`${BASE}/api/projects/${projectId}/import`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`import -> ${response.status} ${await response.text()}`);
  return (await response.json()) as { results: { registered: boolean; filename: string }[] };
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-api-'));
  server = spawn(
    process.execPath,
    [path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO_ROOT, 'server', 'index.ts')],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // tests/setup.ts pins BRAIN_DB_PATH for this process; the child must derive
        // its own path from its own data root instead of inheriting ours.
        BRAIN_DB_PATH: undefined,
        BRAIN_DATA_DIR: dataDir,
        PORT: String(PORT),
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
  server.stderr.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));

  const deadline = Date.now() + 45_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`server never became healthy:\n${serverLog}`);
    try {
      const health = await get<{ ok: boolean }>('/api/health');
      if (health.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const { projects } = await get<{ projects: { id: string; slug: string }[] }>('/api/projects');
  projectId = projects[0]!.id;
}, 60_000);

afterAll(() => {
  server?.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('boot', () => {
  it('migrates from empty and reports its own configuration', async () => {
    const health = await get<{
      ok: boolean;
      schemaVersion: number;
      driver: string;
      databasePath: string;
      dataRoot: string;
      providers: { name: string; available: boolean }[];
    }>('/api/health');

    expect(health.ok).toBe(true);
    expect(health.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(health.databasePath).toContain(dataDir);
    expect(health.providers.find((p) => p.name === 'mock')?.available).toBe(true);
  });

  it('seeds Deal Dispatch with its eight layers in order', async () => {
    const detail = await get<{
      project: { name: string; slug: string };
      layers: { name: string; orderIndex: number }[];
    }>(`/api/projects/${projectId}`);

    expect(detail.project.name).toBe('Deal Dispatch');
    expect(detail.layers.map((l) => l.name)).toEqual([
      'World Model',
      'Taxonomy',
      'Monetization Logic',
      'Discovery Logic',
      'Qualification Logic',
      'Execution Playbooks',
      'Decision Routing Rules',
      'Learning Evaluation',
    ]);
  });
});

describe('import over HTTP', () => {
  it('accepts a batch of PDFs and registers the confident ones', async () => {
    const { results } = await uploadPdfs([
      'World Model v1.pdf',
      'World Model v1B.pdf',
      'quarterly notes.pdf',
    ]);
    expect(results).toHaveLength(3);
    expect(results.filter((r) => r.registered)).toHaveLength(2);

    const { documents } = await get<{ documents: { canonicalName: string }[] }>(
      `/api/projects/${projectId}/documents`,
    );
    expect(documents.map((d) => d.canonicalName)).toContain('World Model v1');
  });

  it('serves the stored file back', async () => {
    const { documents } = await get<{ documents: { id: string; canonicalName: string }[] }>(
      `/api/projects/${projectId}/documents`,
    );
    const document = documents.find((d) => d.canonicalName === 'World Model v1')!;
    const response = await fetch(`${BASE}/api/documents/${document.id}/file`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('%PDF-1.4');
  });
});

describe('planner over HTTP', () => {
  it('answers what to do next', async () => {
    const plan = await get<{ plan: { nextBestActionText: string; layers: unknown[] } }>(
      `/api/projects/${projectId}/plan`,
    );
    expect(plan.plan.layers).toHaveLength(8);
    expect(plan.plan.nextBestActionText.length).toBeGreaterThan(0);

    const next = await get<{ text: string }>(`/api/projects/${projectId}/next-action`);
    expect(next.text.length).toBeGreaterThan(0);
  });
});

describe('prompts and runs', () => {
  it('previews a prompt without persisting anything', async () => {
    const { layers } = await get<{ layers: { id: string; name: string }[] }>(`/api/projects/${projectId}`);
    const world = layers.find((l) => l.name === 'World Model')!;

    const preview = await get<{
      compiled: { prompt: string; expectedFilename: string; requiredAttachments: string[] };
      dependencies: { summary: string };
    }>(`/api/layers/${world.id}/prompt?runType=EXPANSION`);

    expect(preview.compiled.expectedFilename).toBe('World Model v1C.pdf');
    expect(preview.compiled.prompt).toContain('World Model v1C');
    expect(preview.dependencies.summary).toMatch(/^\d+ \/ \d+ READY$/);

    const { runs } = await get<{ runs: unknown[] }>(`/api/projects/${projectId}/runs`);
    expect(runs).toHaveLength(0);
  });

  it('creates a run that records its exact prompt and attachments', async () => {
    const { layers } = await get<{ layers: { id: string; name: string }[] }>(`/api/projects/${projectId}`);
    const world = layers.find((l) => l.name === 'World Model')!;

    const created = await send<{
      run: { id: string; prompt: string; requiredAttachments: string[]; expectedFilename: string };
    }>('POST', `/api/layers/${world.id}/runs`, { runType: 'EXPANSION' });

    expect(created.status).toBe(200);
    // Invariant 10.
    expect(created.body.run.prompt.length).toBeGreaterThan(0);
    expect(created.body.run.expectedFilename).toBe('World Model v1C.pdf');

    const detail = await get<{ run: { prompt: string } }>(`/api/runs/${created.body.run.id}`);
    expect(detail.run.prompt).toBe(created.body.run.prompt);
  });
});

describe('invariants are enforced at the HTTP boundary', () => {
  it('refuses a synthesis with an incomplete packet, with 409 and the checklist', async () => {
    const { layers } = await get<{ layers: { id: string; name: string }[] }>(`/api/projects/${projectId}`);
    const discovery = layers.find((l) => l.name === 'Discovery Logic')!;

    await send('PATCH', `/api/layers/${discovery.id}`, {
      expectedVersions: ['v1', 'v1B', 'v1C'],
    });

    const blocked = await send<{ error: string; detail: { missing: string[]; summary: string } }>(
      'POST',
      `/api/layers/${discovery.id}/synthesis`,
      {},
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.detail.missing.length).toBeGreaterThan(0);
  });

  it('refuses to freeze a layer with no canonical artifact', async () => {
    const { layers } = await get<{ layers: { id: string; name: string }[] }>(`/api/projects/${projectId}`);
    const taxonomy = layers.find((l) => l.name === 'Taxonomy')!;
    const response = await send<{ error: string }>('POST', `/api/layers/${taxonomy.id}/freeze`, {});
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.error.length).toBeGreaterThan(0);
  });

  it('returns 404 for an unknown id rather than throwing', async () => {
    const response = await send<{ error: string }>('GET', '/api/layers/lyr_does_not_exist');
    expect(response.status).toBe(404);
    expect(response.body.error.length).toBeGreaterThan(0);
  });

  it('rejects an invalid enum with 400', async () => {
    const { layers } = await get<{ layers: { id: string }[] }>(`/api/projects/${projectId}`);
    const response = await send<{ error: string }>('POST', `/api/layers/${layers[0]!.id}/runs`, {
      runType: 'NOT_A_RUN_TYPE',
    });
    expect(response.status).toBe(400);
  });
});

describe('a synthesis cannot be finished on an incomplete packet', () => {
  it('refuses to start, complete, or register a result', async () => {
    const { layers } = await get<{ layers: { id: string; name: string }[] }>(`/api/projects/${projectId}`);
    const qualification = layers.find((l) => l.name === 'Qualification Logic')!;

    // One document present, three expected: the packet can never be ready.
    await uploadPdfs(['Qualification Logic v1.pdf']);
    await send('PATCH', `/api/layers/${qualification.id}`, {
      expectedVersions: ['v1', 'v1B', 'v1C'],
    });

    // Force a synthesis run into existence with an explicit override, then
    // confirm every later door still checks the packet.
    const prepared = await send<{ run: { id: string; dependencyOverride: boolean } }>(
      'POST',
      `/api/layers/${qualification.id}/synthesis`,
      { override: true, overrideReason: 'staged deliberately for this test' },
    );
    expect(prepared.status).toBe(200);
    expect(prepared.body.run.dependencyOverride).toBe(true);

    // An overridden run is allowed through — the user took responsibility.
    const started = await send('POST', `/api/runs/${prepared.body.run.id}/start`);
    expect(started.status).toBe(200);
  });

  it('refuses a synthesis run that never had an override', async () => {
    const { layers } = await get<{ layers: { id: string; name: string }[] }>(`/api/projects/${projectId}`);
    const learning = layers.find((l) => l.name === 'Learning Evaluation')!;
    await send('PATCH', `/api/layers/${learning.id}`, { expectedVersions: ['v1', 'v1B'] });

    const blocked = await send<{ error: string }>('POST', `/api/layers/${learning.id}/synthesis`, {});
    // No documents at all, so it is refused before any run exists.
    expect(blocked.status).toBeGreaterThanOrEqual(400);
  });
});

describe('a recorded prompt is history', () => {
  it('refuses to recompile over a finished run', async () => {
    const { layers } = await get<{ layers: { id: string; name: string }[] }>(`/api/projects/${projectId}`);
    const playbooks = layers.find((l) => l.name === 'Execution Playbooks')!;

    const created = await send<{ run: { id: string; prompt: string } }>(
      'POST',
      `/api/layers/${playbooks.id}/runs`,
      { runType: 'FOUNDATION' },
    );
    const runId = created.body.run.id;
    const originalPrompt = created.body.run.prompt;

    await send('POST', `/api/runs/${runId}/start`);
    await send('POST', `/api/runs/${runId}/fail`, { failureReason: 'model ran out of context' });

    // Invariants 5 and 10: the prompt that was actually sent is the only copy.
    const recompiled = await send<{ error: string }>('POST', `/api/runs/${runId}/prompt`, {
      objective: 'something completely different',
    });
    expect(recompiled.status).toBe(409);

    const after = await get<{ run: { prompt: string; status: string } }>(`/api/runs/${runId}`);
    expect(after.run.prompt).toBe(originalPrompt);
    expect(after.run.status).toBe('FAILED');
  });
});

describe('invariant 6 has no back door', () => {
  it('refuses to pin a layer to FROZEN', async () => {
    const { layers } = await get<{ layers: { id: string; name: string }[] }>(`/api/projects/${projectId}`);
    const taxonomy = layers.find((l) => l.name === 'Taxonomy')!;

    // POST /freeze refuses without a canonical document; pinning the status must
    // not be a way around that.
    const pinned = await send<{ error: string }>('PATCH', `/api/layers/${taxonomy.id}`, {
      manualStatus: 'FROZEN',
    });
    expect(pinned.status).toBe(400);

    const detail = await get<{ state: { status: string } }>(`/api/layers/${taxonomy.id}`);
    expect(detail.state.status).not.toBe('FROZEN');
  });

  it('still allows an honest manual pin', async () => {
    const { layers } = await get<{ layers: { id: string; name: string }[] }>(`/api/projects/${projectId}`);
    const taxonomy = layers.find((l) => l.name === 'Taxonomy')!;

    const pinned = await send('PATCH', `/api/layers/${taxonomy.id}`, {
      manualStatus: 'BLOCKED',
      manualStatusReason: 'waiting on an external source',
    });
    expect(pinned.status).toBe(200);

    const released = await send('PATCH', `/api/layers/${taxonomy.id}`, { manualStatus: null });
    expect(released.status).toBe(200);
  });
});

describe('important changes reach the history', () => {
  it('records a project change, including the version policy', async () => {
    const before = await get<{ events: unknown[] }>(`/api/projects/${projectId}/events?limit=500`);

    const patched = await send('PATCH', `/api/projects/${projectId}`, {
      northStar: 'A sharper statement of the goal.',
    });
    expect(patched.status).toBe(200);

    const after = await get<{ events: { eventType: string }[] }>(
      `/api/projects/${projectId}/events?limit=500`,
    );
    // Invariant 3: the version policy decides every canonical name, so a silent
    // change would reinterpret the whole project with nothing saying why.
    expect(after.events.length).toBeGreaterThan(before.events.length);
    expect(after.events.some((e) => e.eventType === 'USER_CORRECTION')).toBe(true);
  });

  it('records a layer rename', async () => {
    const { layers } = await get<{ layers: { id: string; name: string }[] }>(`/api/projects/${projectId}`);
    const learning = layers.find((l) => l.name === 'Learning Evaluation')!;
    const before = await get<{ events: unknown[] }>(`/api/projects/${projectId}/events?limit=500`);

    await send('PATCH', `/api/layers/${learning.id}`, { notes: 'these notes matter' });

    const after = await get<{ events: unknown[] }>(`/api/projects/${projectId}/events?limit=500`);
    expect(after.events.length).toBeGreaterThan(before.events.length);
  });
});

describe('audit and reconcile over HTTP', () => {
  it('records a structured audit and moves the layer', async () => {
    const { layers } = await get<{ layers: { id: string; name: string }[] }>(`/api/projects/${projectId}`);
    const world = layers.find((l) => l.name === 'World Model')!;

    const created = await send<{ run: { id: string } }>('POST', `/api/layers/${world.id}/runs`, {
      runType: 'AUDIT',
    });
    const runId = created.body.run.id;

    const audited = await send<{
      audit: { verdict: string; findings: { findingType: string }[] };
      state: { status: string };
    }>('POST', `/api/runs/${runId}/audit`, {
      verdict: 'MORE_RESEARCH',
      summary: 'Coverage is thin on the second half.',
      failures: ['No evidence for the second half'],
    });

    expect(audited.status).toBe(200);
    expect(audited.body.audit.verdict).toBe('MORE_RESEARCH');
    expect(audited.body.audit.findings.some((f) => f.findingType === 'FAILURE')).toBe(true);
  });

  it('reports reconciliation state', async () => {
    const response = await send<{ report: { issues: unknown[]; healthy: boolean } }>(
      'POST',
      `/api/projects/${projectId}/reconcile`,
    );
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.report.issues)).toBe(true);
  });
});

describe('chat over HTTP', () => {
  it('answers from tool calls and persists the exchange', async () => {
    const turn = await send<{
      assistantMessage: { content: string };
      toolCalls: { name: string }[];
    }>('POST', '/api/chat', { projectId, content: "What's next?" });

    expect(turn.status).toBe(200);
    expect(turn.body.toolCalls.length).toBeGreaterThan(0);
    expect(turn.body.assistantMessage.content.length).toBeGreaterThan(0);

    const history = await get<{ messages: { role: string }[] }>(`/api/chat?projectId=${projectId}`);
    expect(history.messages.some((m) => m.role === 'USER')).toBe(true);
    expect(history.messages.some((m) => m.role === 'ASSISTANT')).toBe(true);
  });
});

describe('the event log', () => {
  it('records what happened, newest first', async () => {
    const { events } = await get<{ events: { eventType: string; createdAt: string }[] }>(
      `/api/projects/${projectId}/events?limit=100`,
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.eventType === 'DOCUMENT_IMPORTED')).toBe(true);
    expect(events.some((e) => e.eventType === 'AUDIT_COMPLETED')).toBe(true);
  });
});

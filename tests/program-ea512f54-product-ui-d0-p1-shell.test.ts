// @vitest-environment jsdom
/**
 * The World destination (UI-08, UI-27-3): a deep link that restores the lens,
 * three modes over one read with the conversation docked beside every one,
 * turns that carry the selected record on the existing turn route,
 * explanations that link to their records, no action route of its own, and a
 * numbers-first fallback at phone width.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { World, WorldFact } from '../server/routes/world.ts';
import { WorldApi, WORLD_CONTRACT_READ, WorldVersionError } from '../client/src/lib/worldApi.ts';
import { RussellApi } from '../client/src/lib/russellApi.ts';
import { parseRoute, pathFor } from '../client/src/lib/router.ts';
import { SECTIONS } from '../client/src/russell/RussellShell.tsx';
import { WorldPage, factsInTimeframe } from '../client/src/world/WorldPage.tsx';
import { parseLensQuery } from '../client/src/world/lens.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date();
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

function fact(kind: WorldFact['kind'], id: string, over: Partial<WorldFact> = {}): WorldFact {
  return {
    kind,
    recordId: id,
    href: `/api/x/${id}`,
    title: `Title ${id}`,
    owner: 'prs_1',
    state: 'WAITING',
    recordState: 'QUEUED',
    startedAt: iso(3_600_000),
    lastChangedAt: iso(60_000),
    blocker: null,
    nextAction: null,
    source: { table: 't', id },
    freshness: 'FRESH',
    missing: [],
    district: null,
    ...over,
  };
}

const WORLD: World = {
  version: 1,
  generatedAt: NOW.toISOString(),
  projectId: 'prj_1',
  districts: [],
  facts: [
    fact('GOAL', 'g1', { title: 'Reach revenue', href: '/api/goals/g1', state: 'WORKING' }),
    fact('OPPORTUNITY', 'o1', { title: 'Dental bookkeeping', href: '/api/cash/opportunities/o1', state: 'NEEDS_APPROVAL', nextAction: 'Approve the offer' }),
    fact('CAMPAIGN', 'c1', { title: 'Build the page', href: '/api/factory/campaigns/c1', state: 'BLOCKED', blocker: 'A check failed' }),
    fact('RESEARCH_JOB', 'r1', { title: 'Old research', lastChangedAt: iso(60 * 86_400_000) }),
  ],
  workers: [],
  workingCount: 0,
  money: [],
  explanations: [
    { kind: 'BLOCK', text: 'A check failed', recordKind: 'CAMPAIGN', recordId: 'c1', href: '/api/factory/campaigns/c1', lastChangedAt: iso(60_000) },
    { kind: 'APPROVAL', text: 'Approve the offer', recordKind: 'OPPORTUNITY', recordId: 'o1', href: '/api/cash/opportunities/o1', lastChangedAt: iso(60_000) },
  ],
  viewer: { principalId: 'prs_1', canRead: true, canWrite: false },
  truncated: [],
};

const THREAD = { conversation: { id: 'rcv_1' }, turns: [], software: [], clarification: null } as unknown as Awaited<ReturnType<typeof RussellApi.thread>>;

beforeEach(() => {
  vi.spyOn(WorldApi, 'world').mockResolvedValue(WORLD);
  vi.spyOn(RussellApi, 'thread').mockResolvedValue(THREAD);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

async function renderPage(path: string, renderMode?: 'ANIMATED' | 'STATIC' | 'NUMBERS_ONLY') {
  window.history.replaceState({}, '', path);
  const utils = render(createElement(WorldPage, { projectId: 'prj_1', conversationId: 'rcv_1', ...(renderMode ? { renderMode } : {}) }));
  await waitFor(() => expect(screen.queryByText('Reading the world…')).toBeNull());
  return utils;
}

describe('the World route', () => {
  it('is an address in the router and a destination in the shell', () => {
    expect(parseRoute('/world')).toEqual({ name: 'WORLD' });
    expect(pathFor({ name: 'WORLD' })).toBe('/world');
    expect(parseRoute('/world/extra')).toEqual({ name: 'NOT_FOUND', path: '/world/extra' });
    expect(SECTIONS.some((s) => s.name === 'WORLD')).toBe(true);
    // The six primary destinations stay six.
    expect(SECTIONS.filter((s) => s.primary)).toHaveLength(6);
  });

  it('a deep link restores mode, selection, timeframe and goal', async () => {
    await renderPage('/world?lens=operations&sel=OPPORTUNITY:o1&tf=30d&goal=g1', 'STATIC');
    expect(screen.getByTestId('world-page').getAttribute('data-mode')).toBe('OPERATIONS');
    expect((screen.getByLabelText('Timeframe') as HTMLSelectElement).value).toBe('30d');
    expect((screen.getByLabelText('Goal') as HTMLSelectElement).value).toBe('g1');
    expect(screen.getByTestId('record-drawer').getAttribute('data-record')).toBe('OPPORTUNITY:o1');
    // The 30-day window leaves out what last changed 60 days ago.
    expect(screen.getByTestId('operations-records').querySelector('[data-record="RESEARCH_JOB:r1"]')).toBeNull();
  });

  it('switching mode keeps selection, timeframe and goal, and writes them into the address', async () => {
    await renderPage('/world?sel=OPPORTUNITY:o1&tf=30d&goal=g1', 'STATIC');
    for (const name of ['Operations', 'Goal', 'World']) {
      fireEvent.click(screen.getByRole('tab', { name }));
      const lens = parseLensQuery(window.location.search);
      expect(lens.mode).toBe(name.toUpperCase());
      expect(lens.selected).toEqual({ kind: 'OPPORTUNITY', id: 'o1' });
      expect(lens.timeframe).toEqual({ preset: '30d' });
      expect(lens.goalId).toBe('g1');
      expect(window.location.pathname).toBe('/world');
    }
  });
});

describe('the docked conversation', () => {
  it('is reachable from all three modes', async () => {
    await renderPage('/world', 'STATIC');
    for (const name of ['World', 'Operations', 'Goal']) {
      fireEvent.click(screen.getByRole('tab', { name }));
      const docked = screen.getByTestId('world-conversation');
      expect(within(docked).getByLabelText('Say something to Russell')).toBeTruthy();
    }
  });

  it('a turn carries the selected record id and href on the existing turn route', async () => {
    const say = vi.spyOn(RussellApi, 'say').mockResolvedValue({} as Awaited<ReturnType<typeof RussellApi.say>>);
    await renderPage('/world?lens=goal&sel=CAMPAIGN:c1', 'STATIC');
    expect(screen.getByTestId('conversation-grounding').textContent).toContain('/api/factory/campaigns/c1');
    const box = within(screen.getByTestId('world-conversation')).getByLabelText('Say something to Russell');
    fireEvent.change(box, { target: { value: 'Why is this blocked?' } });
    await act(async () => {
      fireEvent.submit(box.closest('form')!);
    });
    expect(say).toHaveBeenCalledOnce();
    const [conversationId, content] = say.mock.calls[0]!;
    expect(conversationId).toBe('rcv_1');
    expect(content).toContain('CAMPAIGN c1');
    expect(content).toContain('/api/factory/campaigns/c1');
    expect(content).toContain('Why is this blocked?');
  });

  it('never reports an action as done: a failed turn shows the server refusal and keeps the words', async () => {
    vi.spyOn(RussellApi, 'say').mockRejectedValue(new Error('network'));
    await renderPage('/world?sel=CAMPAIGN:c1', 'STATIC');
    const box = within(screen.getByTestId('world-conversation')).getByLabelText('Say something to Russell') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Retry the check' } });
    await act(async () => {
      fireEvent.submit(box.closest('form')!);
    });
    expect(screen.getByText(/did not send/)).toBeTruthy();
    expect(box.value).toBe('Retry the check');
  });
});

describe('explanations and actions', () => {
  it('explanations of decisions and blocks link to the records they describe', async () => {
    await renderPage('/world', 'STATIC');
    const list = screen.getByTestId('world-explanations');
    const block = list.querySelector('[data-kind="BLOCK"]')!;
    expect(block.textContent).toContain('A check failed');
    expect(block.querySelector('a')!.getAttribute('href')).toBe('/api/factory/campaigns/c1');
    const approval = list.querySelector('[data-kind="APPROVAL"]')!;
    expect(approval.querySelector('a')!.getAttribute('href')).toBe('/api/cash/opportunities/o1');
  });

  it('adds no action route: the world client only reads, and checks the contract version', async () => {
    expect(Object.keys(WorldApi)).toEqual(['world']);
    const source = readFileSync(join(process.cwd(), 'client/src/world/WorldPage.tsx'), 'utf8') + readFileSync(join(process.cwd(), 'client/src/lib/worldApi.ts'), 'utf8');
    expect(source).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
    vi.restoreAllMocks();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...WORLD, version: 2 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(WorldApi.world('prj_1')).rejects.toBeInstanceOf(WorldVersionError);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/projects/prj_1/world');
    vi.unstubAllGlobals();
    expect(WORLD_CONTRACT_READ).toBe(1);
  });
});

describe('responsive', () => {
  it('at phone width the device decision is numbers-first: no map, every record in the table', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    await renderPage('/world?tf=all');
    expect(screen.queryByTestId('world-svg')).toBeNull();
    const rows = [...screen.getByTestId('world-facts').querySelectorAll('tbody tr')].map((r) => r.getAttribute('data-record'));
    expect(rows).toEqual(WORLD.facts.map((f) => `${f.kind}:${f.recordId}`));
  });

  it('a fact with no change time stays in every timeframe', () => {
    const facts = [fact('GOAL', 'a', { lastChangedAt: null }), fact('GOAL', 'b', { lastChangedAt: iso(40 * 86_400_000) })];
    expect(factsInTimeframe(facts, { preset: '7d' }, NOW.getTime()).map((f) => f.recordId)).toEqual(['a']);
    expect(factsInTimeframe(facts, { preset: 'all' }, NOW.getTime())).toHaveLength(2);
  });
});

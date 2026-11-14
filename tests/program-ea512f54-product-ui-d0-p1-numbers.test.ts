// @vitest-environment jsdom
/**
 * Operations mode, Goal mode and the record drawer (UI-27-3, UI-27-6, UI-27-2).
 *
 * Acceptance: Operations sorts and filters, and every numeric cell links to
 * the record it came from; Goal separates candidate from accepted plans and
 * modelled from measured figures; the drawer shows owner, timestamps, blocker
 * and next action, and "unknown" for what the response lacks; export is absent
 * unless the response marks the caller authorised.
 *
 * Literals stand in for the world route's response so no server code loads.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { World, WorldFact } from '../server/routes/world.ts';
import {
  OperationsLens,
  exportAllowed,
  factsToCsv,
  filterFacts,
  moneyLineHref,
  sortFacts,
  EMPTY_FILTER,
} from '../client/src/world/OperationsLens.tsx';
import { GoalLens, planStanding, splitFigures, splitPlans, type GoalPlanView } from '../client/src/world/GoalLens.tsx';
import { RecordDrawer, UNKNOWN_TEXT, drawerRows } from '../client/src/world/RecordDrawer.tsx';
import { REALISED_LABELS, type TruthContext } from '../client/src/world/truth.ts';

afterEach(cleanup);

const NOW = Date.parse('2026-11-14T12:00:00.000Z');

function fact(over: Partial<WorldFact> = {}): WorldFact {
  return {
    kind: 'WORK_UNIT',
    recordId: 'wi_1',
    href: '/api/work/wi_1',
    title: 'Unit one',
    owner: 'worker-a',
    state: 'WORKING',
    recordState: 'CLAIMED',
    startedAt: '2026-11-14T10:00:00.000Z',
    lastChangedAt: '2026-11-14T11:00:00.000Z',
    blocker: null,
    nextAction: 'finish the unit',
    source: { table: 'work_items', id: 'wi_1' },
    freshness: 'FRESH',
    missing: [],
    district: 'FORGE',
    ...over,
  };
}

const FACTS: WorldFact[] = [
  fact(),
  fact({ kind: 'GOAL', recordId: 'g_1', href: '/api/goals/g_1', title: 'Reach first revenue', state: 'BLOCKED', recordState: 'ACTIVE', blocker: 'no buyer list', nextAction: null, district: 'CITADEL', source: { table: 'goals', id: 'g_1' } }),
  fact({ kind: 'OPPORTUNITY', recordId: 'op_1', href: '/api/cash/opportunities/op_1', title: 'Alpha deal', state: 'NEEDS_APPROVAL', owner: null, nextAction: null, lastChangedAt: null, freshness: 'MISSING', missing: ['owner'], district: 'MARKET', source: { table: 'cash_opportunities', id: 'op_1' } }),
  fact({ kind: 'INVOICE', recordId: 'inv_1', href: '/api/cash/opportunities/op_1', title: 'Beta invoice', state: 'FAILED', lastChangedAt: '2026-11-14T09:00:00.000Z', district: 'TREASURY', source: { table: 'cash_invoices', id: 'inv_1' } }),
];

function world(over: Partial<World> = {}): World {
  return {
    version: 1,
    generatedAt: '2026-11-14T11:59:00.000Z',
    projectId: 'prj_1',
    districts: [],
    facts: FACTS,
    workers: [{ workerId: 'worker-a', state: 'WORKING', holding: [{ kind: 'WORK_UNIT', recordId: 'wi_1', href: '/api/work/wi_1', heartbeatAt: '2026-11-14T11:58:00.000Z', leaseExpiresAt: '2026-11-14T12:10:00.000Z' }] }],
    workingCount: 1,
    money: [
      { class: 'received', meaning: 'cash in', lines: [{ kind: 'CUSTOMER_PAYMENT', direction: 'IN', currency: 'USD', amountCents: 12_500, source: { table: 'cash_ledger', filter: 'kind = CUSTOMER_PAYMENT' }, lastChangedAt: '2026-11-14T08:00:00.000Z' }], missing: null },
      { class: 'due', meaning: 'owed', lines: [{ kind: 'INVOICE_SENT', direction: 'IN', currency: 'USD', amountCents: 40_000, source: { table: 'cash_invoices', filter: 'state = SENT' }, lastChangedAt: null }], missing: null },
      { class: 'projected', meaning: 'pipeline', lines: [{ kind: 'PIPELINE', direction: 'IN', currency: 'USD', amountCents: 900_000, source: { table: 'cash_ledger', filter: 'kind = PIPELINE' }, lastChangedAt: '2026-11-14T07:00:00.000Z' }], missing: null },
      { class: 'simulated', meaning: 'scenario', lines: [], missing: 'Scenario figures are read elsewhere.' },
    ],
    explanations: [{ kind: 'BLOCK', text: 'Reach first revenue is blocked: no buyer list', recordKind: 'GOAL', recordId: 'g_1', href: '/api/goals/g_1', lastChangedAt: '2026-11-14T11:00:00.000Z' }],
    viewer: { principalId: 'p_1', canRead: true, canWrite: true },
    truncated: [],
    ...over,
  };
}

const ctx: TruthContext = { world: { generatedAt: '2026-11-14T11:59:00.000Z', projectId: 'prj_1' }, nowMs: NOW };

describe('Operations lens', () => {
  it('filters by text, kind group and state, and sorts with missing values last', () => {
    expect(filterFacts(FACTS, { ...EMPTY_FILTER, kind: 'TRANSACTIONS' }).map((f) => f.recordId)).toEqual(['op_1', 'inv_1']);
    expect(filterFacts(FACTS, { ...EMPTY_FILTER, state: 'BLOCKED' }).map((f) => f.recordId)).toEqual(['g_1']);
    expect(filterFacts(FACTS, { ...EMPTY_FILTER, text: 'buyer' }).map((f) => f.recordId)).toEqual(['g_1']);
    expect(sortFacts(FACTS, 'title', 'asc').map((f) => f.title)).toEqual(['Alpha deal', 'Beta invoice', 'Reach first revenue', 'Unit one']);
    expect(sortFacts(FACTS, 'lastChangedAt', 'desc').at(-1)!.recordId).toBe('op_1');
    expect(sortFacts(FACTS, 'lastChangedAt', 'asc').at(-1)!.recordId).toBe('op_1');
  });

  it('sorts and filters in the rendered table', () => {
    render(createElement(OperationsLens, { world: world(), nowMs: NOW }));
    const table = screen.getByRole('table', { name: 'Records' });
    fireEvent.click(within(table).getByRole('button', { name: /Record/ }));
    const titles = within(table).getAllByRole('row').slice(1).map((r) => r.querySelectorAll('td')[1]!.textContent);
    expect(titles).toEqual(['Alpha deal', 'Beta invoice', 'Reach first revenue', 'Unit one']);
    fireEvent.change(screen.getByLabelText('Filter by state'), { target: { value: 'FAILED' } });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Beta invoice')).toBeTruthy();
  });

  it('links every numeric cell to the record or read it came from', () => {
    const { container } = render(createElement(OperationsLens, { world: world(), nowMs: NOW }));
    // A figure: an amount, a count, or "N of M records"/"N workers…". Timestamps are not figures.
    const figure = /^\s*(\$[\d,.]+|\d+(\s+of\s+\d+\s+records|\s+workers?\b.*)?)\s*$/;
    const numeric = [...container.querySelectorAll('td, p')].filter((el) => figure.test(el.textContent ?? ''));
    expect(numeric.length).toBeGreaterThanOrEqual(6);
    expect(numeric.length).toBeGreaterThan(0);
    for (const el of numeric) expect(el.querySelector('a[href]'), el.textContent ?? '').not.toBeNull();
    const amounts = screen.getAllByTestId('money-amount');
    expect(amounts).toHaveLength(3);
    expect(amounts.map((a) => a.getAttribute('href'))).toEqual(['/api/projects/prj_1/world', '/api/projects/prj_1/cash/invoices', '/api/projects/prj_1/world']);
    expect(screen.getByTestId('working-count').textContent).toBe('1 worker holding a live lease');
  });

  it('never labels a projected or empty class as cash, and an empty class is not zero', () => {
    const { container } = render(createElement(OperationsLens, { world: world(), nowMs: NOW }));
    const projected = container.querySelector('tr[data-money-class="projected"]')!;
    expect(projected.textContent).toContain('Projected — not cash');
    for (const label of REALISED_LABELS) expect(projected.textContent).not.toContain(label);
    const simulated = container.querySelector('tr[data-money-class="simulated"]')!;
    expect(simulated.textContent).toContain('Not recorded');
    expect(simulated.textContent).not.toMatch(/\$0/);
  });

  it('offers export only when the response marks the caller authorised', () => {
    expect(exportAllowed(world().viewer)).toBe(false);
    render(createElement(OperationsLens, { world: world(), nowMs: NOW }));
    expect(screen.queryByTestId('export')).toBeNull();
    cleanup();
    const viewer = { principalId: 'p_1', canRead: true, canWrite: false, canExport: true } as unknown as World['viewer'];
    expect(exportAllowed(viewer)).toBe(true);
    render(createElement(OperationsLens, { world: world({ viewer }), nowMs: NOW }));
    expect(screen.getByTestId('export')).toBeTruthy();
    expect(factsToCsv([FACTS[2]!]).split('\n')[1]).toContain(UNKNOWN_TEXT);
  });

  it('traces invoice lines to the invoice read', () => {
    expect(moneyLineHref('prj_1', world().money[1]!.lines[0]!)).toBe('/api/projects/prj_1/cash/invoices');
  });
});

const PLANS: GoalPlanView[] = [
  {
    id: 'pl_a', title: 'Sell to list A', status: 'ACCEPTED', href: '/api/goals/g_1/plan', owner: 'brain', method: 'outbound email', uncertainty: 'buyer count unconfirmed',
    figures: [
      { label: 'revenue collected', basis: 'COLLECTED', amountCents: 12_500, currency: 'USD', asOf: '2026-11-14T08:00:00.000Z', source: 'cash_ledger' },
      { label: 'revenue', basis: 'PROJECTED', amountCents: 900_000, currency: 'USD', asOf: '2026-11-14T07:00:00.000Z', source: 'goal plan' },
      { label: 'cost', basis: 'ESTIMATED', amountCents: null, currency: 'USD', asOf: null, source: null },
    ],
    chain: [{ title: 'Unit one', kind: 'WORK_UNIT', recordId: 'wi_1', href: '/api/work/wi_1' }],
    dependencies: [],
  },
  { id: 'pl_b', title: 'Broker list B', status: 'PROPOSED', href: null, owner: null, method: null, uncertainty: null, figures: [], chain: [], dependencies: [] },
  { id: 'pl_c', title: 'No status', status: null, href: null, owner: null, method: null, uncertainty: null, figures: [], chain: [], dependencies: [] },
];

describe('Goal lens', () => {
  it('treats only an ACCEPTED status as accepted', () => {
    expect(planStanding({ status: 'ACCEPTED' })).toBe('ACCEPTED');
    expect(planStanding({ status: 'accepted' })).toBe('CANDIDATE');
    expect(planStanding({ status: null })).toBe('CANDIDATE');
    const { accepted, candidates } = splitPlans(PLANS);
    expect(accepted.map((p) => p.id)).toEqual(['pl_a']);
    expect(candidates.map((p) => p.id)).toEqual(['pl_b', 'pl_c']);
  });

  it('separates measured from modelled figures, and a missing amount is never measured', () => {
    const split = splitFigures(PLANS[0]!, ctx);
    expect(split.measured.map((r) => r.figure.label)).toEqual(['revenue collected']);
    expect(split.modelled.map((r) => r.figure.label)).toEqual(['revenue', 'cost']);
    expect(split.modelled[1]!.value.text).toBe('Not recorded');
  });

  it('renders accepted and candidate plans apart, with blockers and next action', () => {
    render(createElement(GoalLens, { world: world(), goalId: 'g_1', plans: PLANS, nowMs: NOW }));
    const accepted = screen.getByTestId('accepted-plans');
    const candidates = screen.getByTestId('candidate-plans');
    expect(within(accepted).getByText('Sell to list A')).toBeTruthy();
    expect(within(accepted).queryByText('Broker list B')).toBeNull();
    expect(within(candidates).getByText('Broker list B')).toBeTruthy();
    expect(within(candidates).getAllByText('Candidate — not accepted')).toHaveLength(2);
    const plan = screen.getByTestId('plan-pl_a');
    const measured = within(plan).getByRole('table', { name: 'Measured' });
    const modelled = within(plan).getByRole('table', { name: 'Modelled — not observed' });
    expect(measured.textContent).toContain('$125.00');
    expect(measured.textContent).not.toContain('$9,000.00');
    expect(modelled.textContent).toContain('Projected — not cash');
    expect(screen.getByText('no buyer list')).toBeTruthy();
  });

  it('says a goal not in the read is unknown rather than guessing', () => {
    render(createElement(GoalLens, { world: world(), goalId: 'g_missing', nowMs: NOW }));
    expect(screen.getByTestId('goal-not-found').textContent).toContain('Unknown');
  });
});

describe('Record drawer', () => {
  it('shows owner, timestamps, blocker and next action from the record', () => {
    render(createElement(RecordDrawer, { selection: { kind: 'GOAL', id: 'g_1' }, facts: FACTS, ctx }));
    const drawer = screen.getByTestId('record-drawer');
    expect(drawer.textContent).toContain('worker-a');
    expect(drawer.textContent).toContain('2026-11-14T10:00:00.000Z');
    expect(drawer.textContent).toContain('2026-11-14T11:00:00.000Z');
    expect(drawer.textContent).toContain('no buyer list');
    expect(screen.getByTestId('record-link').getAttribute('href')).toBe('/api/goals/g_1');
  });

  it('prints "unknown" for every field the response lacks', () => {
    const rows = Object.fromEntries(drawerRows(FACTS[2]!, ctx).map((r) => [r.label, r]));
    for (const label of ['Owner', 'Last changed', 'Blocker', 'Next action', 'Inputs', 'Output', 'Queue', 'Economic consequence']) {
      expect(rows[label]!.text, label).toBe(UNKNOWN_TEXT);
      expect(rows[label]!.known).toBe(false);
    }
    render(createElement(RecordDrawer, { selection: { kind: 'OPPORTUNITY', id: 'op_1' }, facts: FACTS, ctx }));
    expect(screen.getAllByText(UNKNOWN_TEXT).length).toBeGreaterThanOrEqual(8);
  });

  it('says a selection outside the read is not found, and renders nothing with no selection', () => {
    render(createElement(RecordDrawer, { selection: { kind: 'WORKER', id: 'nobody' }, facts: FACTS, ctx }));
    expect(screen.getByTestId('record-not-found')).toBeTruthy();
    cleanup();
    const { container } = render(createElement(RecordDrawer, { selection: null, facts: FACTS, ctx }));
    expect(container.innerHTML).toBe('');
  });
});

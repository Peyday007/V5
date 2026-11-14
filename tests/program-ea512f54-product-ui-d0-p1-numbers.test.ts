// @vitest-environment jsdom
/**
 * Numbers-first lenses (UI-27-3, UI-27-6): Operations sorts, filters and links
 * every number to its source; Goal separates candidate from accepted plans and
 * modelled from measured figures; the record drawer says "unknown" for what
 * the response lacks; export appears only when the response authorises it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement, useReducer } from 'react';
import type { World, WorldFact } from '../server/routes/world.ts';
import { OperationsLens, exportAuthorized, factsCsv, filterFacts, sortFacts } from '../client/src/world/OperationsLens.tsx';
import { GoalLens, splitFigures, type GoalPlan } from '../client/src/world/GoalLens.tsx';
import { RecordDrawer, UNKNOWN } from '../client/src/world/RecordDrawer.tsx';
import { initialLensState, lensReducer, parseLensQuery, recordViewHref, type LensState } from '../client/src/world/lens.ts';
import { REALISED_LABELS, type TruthContext } from '../client/src/world/truth.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const GENERATED = '2026-11-14T12:00:00.000Z';
const ctx: TruthContext = { world: { generatedAt: GENERATED, projectId: 'prj_1' }, nowMs: Date.parse(GENERATED) };

function fact(kind: WorldFact['kind'], id: string, over: Partial<WorldFact> = {}): WorldFact {
  return {
    kind,
    recordId: id,
    href: `/api/x/${id}`,
    title: `Title ${id}`,
    owner: 'prs_1',
    state: 'WAITING',
    recordState: 'QUEUED',
    startedAt: '2026-11-14T08:00:00.000Z',
    lastChangedAt: '2026-11-14T10:00:00.000Z',
    blocker: null,
    nextAction: null,
    source: { table: 't', id },
    freshness: 'FRESH',
    missing: [],
    district: null,
    ...over,
  };
}

const FACTS: WorldFact[] = [
  fact('GOAL', 'g1', { title: 'Alpha goal', state: 'WORKING', lastChangedAt: '2026-11-14T11:00:00.000Z' }),
  fact('RESEARCH_JOB', 'r1', { title: 'Beta research', state: 'FAILED', lastChangedAt: '2026-11-14T09:00:00.000Z' }),
  fact('OPPORTUNITY', 'o1', { title: 'Gamma offer', state: 'NEEDS_APPROVAL', nextAction: 'Approve', lastChangedAt: '2026-11-14T07:00:00.000Z' }),
  fact('INVOICE', 'i1', { title: 'Delta invoice', href: null }),
];

function world(over: Partial<World> = {}): World {
  return {
    version: 1,
    generatedAt: GENERATED,
    projectId: 'prj_1',
    districts: [],
    facts: FACTS,
    workers: [{ workerId: 'w1', state: 'WORKING', holding: [{ kind: 'WORK_UNIT', recordId: 'wi1', href: '/api/work/wi1', heartbeatAt: GENERATED, leaseExpiresAt: GENERATED }] }],
    workingCount: 1,
    money: [
      {
        class: 'received',
        meaning: 'Cash a customer actually paid',
        lines: [{ kind: 'CUSTOMER_PAYMENT', direction: 'IN', currency: 'USD', amountCents: 2500, source: { table: 'cash_money_entries', filter: 'kind = CUSTOMER_PAYMENT AND currency = USD' }, lastChangedAt: GENERATED }],
        missing: null,
      },
      {
        class: 'due',
        meaning: 'Owed',
        lines: [{ kind: 'INVOICE_ISSUED', direction: 'IN', currency: 'USD', amountCents: 9900, source: { table: 'cash_invoices', filter: 'state = ISSUED AND currency = USD' }, lastChangedAt: GENERATED }],
        missing: null,
      },
      { class: 'projected', meaning: 'Pipeline', lines: [], missing: 'No entry of this class is recorded for this project.' },
    ],
    explanations: [],
    viewer: { principalId: 'prs_1', canRead: true, canWrite: false },
    truncated: [],
    ...over,
  };
}

function Harness({ w, onExport, initial }: { w: World; onExport?: (csv: string) => void; initial?: LensState }) {
  const [lens, dispatch] = useReducer(lensReducer, initial ?? initialLensState());
  return createElement(OperationsLens, { world: w, ctx, lens, onLensAction: dispatch, onExport });
}

function recordRows(): string[] {
  return [...screen.getByTestId('operations-records').querySelectorAll('tbody tr')].map((r) => r.getAttribute('data-record') ?? '');
}

describe('operations lens', () => {
  it('sorts by a column header and reverses on a second click', () => {
    render(createElement(Harness, { w: world() }));
    const header = within(screen.getByTestId('operations-records')).getByRole('button', { name: 'Record' });
    fireEvent.click(header);
    expect(recordRows()).toEqual(['GOAL:g1', 'RESEARCH_JOB:r1', 'INVOICE:i1', 'OPPORTUNITY:o1']);
    expect(header.closest('th')!.getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(header);
    expect(recordRows()).toEqual(['OPPORTUNITY:o1', 'INVOICE:i1', 'RESEARCH_JOB:r1', 'GOAL:g1']);
  });

  it('filters by kind, state and search, through the shared lens', () => {
    render(createElement(Harness, { w: world() }));
    fireEvent.change(screen.getByLabelText('Filter by state'), { target: { value: 'FAILED' } });
    expect(recordRows()).toEqual(['RESEARCH_JOB:r1']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    fireEvent.change(screen.getByLabelText('Filter by kind'), { target: { value: 'OPPORTUNITY' } });
    expect(recordRows()).toEqual(['OPPORTUNITY:o1']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    fireEvent.change(screen.getByLabelText('Search records'), { target: { value: 'delta' } });
    expect(recordRows()).toEqual(['INVOICE:i1']);
    expect(filterFacts(FACTS, { kind: 'GOAL' }).map((f) => f.recordId)).toEqual(['g1']);
    expect(sortFacts(FACTS, 'lastChangedAt', 'asc')[0]!.recordId).toBe('o1');
  });

  it('a summary count filters the table to the records behind it', () => {
    render(createElement(Harness, { w: world() }));
    const failures = screen.getByTestId('operations-summary').querySelector('[data-category="failures"]') as HTMLButtonElement;
    expect(failures.textContent).toBe('1');
    fireEvent.click(failures);
    expect(recordRows()).toEqual(['RESEARCH_JOB:r1']);
  });

  it('every numeric cell links to the record or route it came from', () => {
    render(createElement(Harness, { w: world() }));
    for (const table of ['operations-summary', 'operations-money']) {
      for (const cell of screen.getByTestId(table).querySelectorAll('td.numbers-num')) {
        const link = cell.querySelector('a, button');
        if (cell.textContent === 'Not recorded') continue;
        expect(link, `${table}: ${cell.textContent}`).not.toBeNull();
      }
    }
    const money = screen.getByTestId('operations-money');
    const received = money.querySelector('[data-money-class="received"] a') as HTMLAnchorElement;
    // A money figure opens the Cash page; the JSON it was read from is named as its source, not linked.
    expect(received.getAttribute('href')).toBe('/cash');
    expect(received.getAttribute('title')).toContain('/api/projects/prj_1/cash');
    expect(received.textContent).toBe('$25.00');
    const due = money.querySelector('[data-money-class="due"] a') as HTMLAnchorElement;
    expect(due.getAttribute('href')).toBe('/cash');
    expect(due.getAttribute('title')).toContain('/api/projects/prj_1/cash/invoices');
    const projected = money.querySelector('[data-money-class="projected"]')!;
    expect(projected.textContent).toContain('Not recorded');
    expect(projected.textContent).toContain('Projected — not cash');
    const fleet = screen.getByTestId('operations-summary').querySelector('a') as HTMLAnchorElement;
    expect(fleet.getAttribute('href')).toBe('/fleet');
    expect(fleet.textContent).toBe('1');
  });

  it('no link in the operations lens sends a person to an /api/ JSON address', () => {
    render(createElement(Harness, { w: world() }));
    const links = [...document.querySelectorAll('a')];
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) expect(a.getAttribute('href') ?? '', a.textContent ?? '').not.toMatch(/^\/api\//);
    // Each fact row's source link opens that record's own view.
    const row = document.querySelector('a[data-record="OPPORTUNITY:o1"]') as HTMLAnchorElement;
    expect(row.getAttribute('href')).toBe(recordViewHref('OPPORTUNITY', 'o1'));
  });

  it('labels money by class: a projected line never reads as collected', () => {
    render(createElement(Harness, { w: world() }));
    const projected = screen.getByTestId('operations-money').querySelector('[data-money-class="projected"]')!;
    expect(projected.textContent).not.toContain('Cash collected');
  });

  it('offers export only when the response marks the viewer authorised', () => {
    render(createElement(Harness, { w: world() }));
    expect(screen.queryByTestId('operations-export')).toBeNull();
    cleanup();
    const onExport = vi.fn();
    const authorised = world({ viewer: { principalId: 'prs_1', canRead: true, canWrite: true } });
    expect(exportAuthorized(authorised)).toBe(true);
    render(createElement(Harness, { w: authorised, onExport }));
    fireEvent.click(screen.getByTestId('operations-export'));
    expect(onExport).toHaveBeenCalledOnce();
    expect(onExport.mock.calls[0]![0]).toBe(factsCsv(sortFacts(FACTS, 'lastChangedAt', 'desc')));
  });

  it('opens the record drawer for the selected row, which survives from another lens', () => {
    const initial = lensReducer(initialLensState(), { type: 'SELECT', selection: { kind: 'OPPORTUNITY', id: 'o1' } });
    render(createElement(Harness, { w: world(), initial }));
    expect(screen.getByTestId('record-drawer').getAttribute('data-record')).toBe('OPPORTUNITY:o1');
  });
});

describe('record drawer', () => {
  it('shows owner, timestamps, blocker and next action', () => {
    const f = fact('CAMPAIGN', 'c1', { blocker: 'Check failed', nextAction: 'Repair', owner: 'prs_9' });
    render(createElement(RecordDrawer, { fact: f, ctx, detail: { queue: 'factory', inputs: 'spec', output: 'branch', economicConsequence: 'none' } }));
    const field = (k: string) => screen.getByTestId('record-drawer').querySelector(`[data-field="${k}"]`)!.textContent;
    expect(field('Owner')).toBe('prs_9');
    expect(field('Started')).toBe(f.startedAt);
    expect(field('Last changed')).toBe(f.lastChangedAt);
    expect(field('Blocker')).toBe('Check failed');
    expect(field('Next action')).toBe('Repair');
    expect(field('Queue')).toBe('factory');
    const link = screen.getByRole('link', { name: 'Link to this record' });
    expect(link.getAttribute('href')).toBe(recordViewHref('CAMPAIGN', 'c1'));
    expect(link.getAttribute('href')).not.toMatch(/^\/api\//);
    expect(parseLensQuery(link.getAttribute('href')!.split('?')[1]!).selected).toEqual({ kind: 'CAMPAIGN', id: 'c1' });
    // The API address is still inspectable, as provenance text rather than a page link.
    expect(field('Source address')).toContain(f.href!);
  });

  it('shows "unknown" for anything the response lacks', () => {
    const f = fact('WORKER', 'w1', { owner: null, startedAt: null, lastChangedAt: null, blocker: null, nextAction: null, recordState: null, href: null, freshness: 'MISSING' });
    render(createElement(RecordDrawer, { fact: f, ctx }));
    for (const k of ['Owner', 'Started', 'Last changed', 'Blocker', 'Next action', 'Queue', 'Inputs', 'Output', 'Economic consequence']) {
      expect(screen.getByTestId('record-drawer').querySelector(`[data-field="${k}"]`)!.textContent).toBe(UNKNOWN);
    }
    expect(screen.getByTestId('record-drawer').querySelector('[data-field="State"]')!.textContent).toContain('record says unknown');
  });
});

describe('goal lens', () => {
  const plans: GoalPlan[] = [
    {
      id: 'p_acc',
      title: 'Accepted plan',
      status: 'ACCEPTED',
      href: '/api/goals/g1/plan',
      acquisition: 'outbound email',
      figures: [
        { label: 'Collected so far', basis: 'COLLECTED', amountCents: 10000, currency: 'USD', asOf: GENERATED, source: 'cash_money_entries' },
        { label: 'Expected revenue', basis: 'PROJECTED', amountCents: 50000, currency: 'USD', asOf: GENERATED, source: 'goal_plan' },
        { label: 'Scenario success', basis: 'MODELLED', amountCents: null, currency: 'USD', asOf: null, source: null },
      ],
    },
    { id: 'p_cand', title: 'Candidate plan', status: 'CANDIDATE', href: null, figures: [{ label: 'Estimated cost', basis: 'ESTIMATED', amountCents: 2000, currency: 'USD', asOf: GENERATED, source: 'goal_plan' }] },
  ];
  const goal = fact('GOAL', 'g1', { title: 'Reach revenue', state: 'WORKING' });
  const chain = [fact('WORK_UNIT', 'wu1', { blocker: 'Waiting on review', nextAction: 'Review' })];
  const deps = [fact('RESEARCH_JOB', 'r9')];

  it('separates candidate from accepted plans', () => {
    render(createElement(GoalLens, { goal, plans, chain, dependencies: deps, uncertainty: 'Reply rate unmeasured', ctx, onLensAction: () => {} }));
    const accepted = screen.getByTestId('goal-accepted');
    const candidates = screen.getByTestId('goal-candidates');
    expect(accepted.querySelector('[data-plan="p_acc"]')).not.toBeNull();
    expect(accepted.querySelector('[data-plan="p_cand"]')).toBeNull();
    expect(candidates.querySelector('[data-plan="p_cand"]')).not.toBeNull();
    expect(candidates.querySelector('[data-plan="p_acc"]')).toBeNull();
    expect(candidates.textContent).toContain('not accepted');
  });

  it('separates modelled from measured figures, and modelled figures never carry a realised label', () => {
    render(createElement(GoalLens, { goal, plans, chain, dependencies: deps, uncertainty: null, ctx, onLensAction: () => {} }));
    const measured = screen.getByTestId('p_acc-measured');
    const modelled = screen.getByTestId('p_acc-modelled');
    expect(measured.textContent).toContain('Collected so far');
    expect(measured.textContent).not.toContain('Expected revenue');
    expect(modelled.textContent).toContain('Expected revenue');
    expect(modelled.textContent).toContain('Scenario success');
    expect(modelled.textContent).toContain('Not recorded');
    for (const label of REALISED_LABELS) expect(modelled.textContent).not.toContain(label);
    expect(screen.getByTestId('p_cand-modelled').textContent).toContain('Estimated cost');
    expect(screen.getByTestId('goal-uncertainty').textContent).toContain('unknown');
    const split = splitFigures(plans[0]!.figures, ctx);
    expect(split.measured.map(([f]) => f.basis)).toEqual(['COLLECTED']);
    expect(split.modelled.map(([f]) => f.basis)).toEqual(['PROJECTED', 'MODELLED']);
  });

  it('lists blockers and next actions, and selecting one dispatches the shared SELECT', () => {
    const onLensAction = vi.fn();
    render(createElement(GoalLens, { goal, plans, chain, dependencies: deps, uncertainty: null, ctx, onLensAction }));
    const blockers = screen.getByTestId('goal-blockers');
    expect(blockers.textContent).toContain('Waiting on review');
    fireEvent.click(within(blockers).getByRole('button', { name: 'Title wu1' }));
    expect(onLensAction).toHaveBeenCalledWith({ type: 'SELECT', selection: { kind: 'WORK_UNIT', id: 'wu1' } });
  });

  it('stands alone with no goal chosen', () => {
    render(createElement(GoalLens, { goal: null, plans: [], chain: [], dependencies: [], uncertainty: null, ctx, onLensAction: () => {} }));
    expect(screen.getByTestId('goal-lens').textContent).toContain('Choose a goal');
  });
});

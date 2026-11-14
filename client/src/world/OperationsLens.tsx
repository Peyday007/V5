/**
 * Operations mode (UI-27-3, S-0420): "high-density, readable factual interface
 * for transactions, goals, research throughput, worker utilization, failures,
 * cash movements, portfolio decisions, approvals, and performance trends.
 * Sort, filter, compare, export if authorized, and trace each number to its
 * source."
 *
 * It reads one `World` response and nothing else, so it agrees with the world
 * scene by construction. Filters live in the shared lens (they survive a mode
 * switch); only the sort order is local. Every number is a link to the record
 * or route it was read from, and money goes through `truth.ts`, so each class
 * keeps its own label and a missing class reads "Not recorded", never zero.
 * Export is offered only when the response says the viewer may write.
 */
import { useMemo, useState } from 'react';
import type { World, WorldFact, WorldMoneyLine } from '../../../server/routes/world.ts';
import type { LensAction, LensState } from './lens.ts';
import { RecordDrawer } from './RecordDrawer.tsx';
import { displayFact, displayMoneyClass, displayState, type TruthContext } from './truth.ts';
import './numbers.css';

export type SortKey = 'title' | 'kind' | 'state' | 'lastChangedAt';
export type SortDir = 'asc' | 'desc';

/** The response decides whether export is offered; the client never assumes it. */
export function exportAuthorized(world: Pick<World, 'viewer'>): boolean {
  return world.viewer.canWrite === true;
}

/** Filters read from the lens: `f.kind`, `f.state`, `f.q`. */
export function filterFacts(facts: readonly WorldFact[], filters: Readonly<Record<string, string>>): WorldFact[] {
  const kind = filters['kind'];
  const state = filters['state'];
  const q = filters['q']?.toLowerCase();
  return facts.filter((f) => (!kind || f.kind === kind) && (!state || f.state === state) && (!q || f.title.toLowerCase().includes(q) || f.recordId.toLowerCase().includes(q)));
}

export function sortFacts(facts: readonly WorldFact[], key: SortKey, dir: SortDir): WorldFact[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...facts].sort((a, b) => {
    const av = a[key] ?? '';
    const bv = b[key] ?? '';
    if (av === bv) return a.recordId < b.recordId ? -1 : 1;
    return av < bv ? -sign : sign;
  });
}

/** The route a money line's figure can be checked at. */
export function moneyLineHref(projectId: string, line: Pick<WorldMoneyLine, 'source'>): string {
  const p = encodeURIComponent(projectId);
  return line.source.table === 'cash_invoices' ? `/api/projects/${p}/cash/invoices` : `/api/projects/${p}/cash`;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function factsCsv(facts: readonly WorldFact[]): string {
  const head = ['kind', 'recordId', 'title', 'state', 'recordState', 'owner', 'startedAt', 'lastChangedAt', 'freshness', 'source'];
  const rows = facts.map((f) => [f.kind, f.recordId, f.title, f.state, f.recordState ?? '', f.owner ?? '', f.startedAt ?? '', f.lastChangedAt ?? '', f.freshness, `${f.source.table}#${f.source.id}`]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

function downloadCsv(name: string, text: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Summary categories. Each count filters the table to the records behind it. */
const CATEGORIES: ReadonlyArray<{ key: string; label: string; filter: Record<string, string>; match: (f: WorldFact) => boolean }> = [
  { key: 'goals', label: 'Goals', filter: { kind: 'GOAL' }, match: (f) => f.kind === 'GOAL' },
  { key: 'research', label: 'Research jobs', filter: { kind: 'RESEARCH_JOB' }, match: (f) => f.kind === 'RESEARCH_JOB' },
  { key: 'transactions', label: 'Opportunities', filter: { kind: 'OPPORTUNITY' }, match: (f) => f.kind === 'OPPORTUNITY' },
  { key: 'invoices', label: 'Invoices', filter: { kind: 'INVOICE' }, match: (f) => f.kind === 'INVOICE' },
  { key: 'failures', label: 'Failures', filter: { state: 'FAILED' }, match: (f) => f.state === 'FAILED' },
  { key: 'approvals', label: 'Needs approval', filter: { state: 'NEEDS_APPROVAL' }, match: (f) => f.state === 'NEEDS_APPROVAL' },
  { key: 'working', label: 'Working (live lease)', filter: { state: 'WORKING' }, match: (f) => f.state === 'WORKING' },
];

export interface OperationsLensProps {
  world: World;
  ctx: TruthContext;
  lens: LensState;
  onLensAction: (action: LensAction) => void;
  /** Replaces the browser download, for embedding and tests. */
  onExport?: (csv: string) => void;
}

export function OperationsLens({ world, ctx, lens, onLensAction, onExport }: OperationsLensProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'lastChangedAt', dir: 'desc' });
  const shown = useMemo(() => sortFacts(filterFacts(world.facts, lens.filters), sort.key, sort.dir), [world.facts, lens.filters, sort]);
  const selectedFact = lens.selected ? world.facts.find((f) => f.kind === lens.selected!.kind && f.recordId === lens.selected!.id) ?? null : null;
  const kinds = [...new Set(world.facts.map((f) => f.kind))].sort();
  const states = [...new Set(world.facts.map((f) => f.state))].sort();
  const canExport = exportAuthorized(world);

  const setFilter = (key: string, value: string) => onLensAction({ type: 'SET_FILTER', key, value: value === '' ? null : value });
  const applyFilters = (filters: Record<string, string>) => {
    onLensAction({ type: 'CLEAR_FILTERS' });
    for (const [key, value] of Object.entries(filters)) onLensAction({ type: 'SET_FILTER', key, value });
  };
  const toggleSort = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));
  const ariaSort = (key: SortKey): 'ascending' | 'descending' | 'none' => (sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  const select = (f: WorldFact) => onLensAction({ type: 'SELECT', selection: { kind: f.kind, id: f.recordId } });

  return (
    <section className="numbers-lens" aria-label="Operations" data-testid="operations-lens">
      <header className="numbers-controls">
        <h2>Operations</h2>
        <span className="numbers-muted">Data as of {world.generatedAt}</span>
        {world.truncated.length > 0 ? <span className="numbers-muted">Cut at a page limit: {world.truncated.join(', ')}</span> : null}
      </header>

      <div className="numbers-section">
        <table className="numbers-table" data-testid="operations-summary">
          <caption>Summary — each count filters the records table</caption>
          <tbody>
            {CATEGORIES.map((c) => {
              const n = world.facts.filter(c.match).length;
              return (
                <tr key={c.key}>
                  <th scope="row">{c.label}</th>
                  <td className="numbers-num">
                    <button type="button" className="numbers-link" data-category={c.key} onClick={() => applyFilters(c.filter)}>
                      {n}
                    </button>
                  </td>
                </tr>
              );
            })}
            <tr>
              <th scope="row">Workers holding a live lease</th>
              <td className="numbers-num">
                <a className="numbers-link" href={`/api/russell/projects/${encodeURIComponent(world.projectId)}/fleet`}>
                  {world.workingCount}
                </a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="numbers-section">
        <div className="numbers-controls" role="group" aria-label="Filters">
          <label>
            Kind
            <select aria-label="Filter by kind" value={lens.filters['kind'] ?? ''} onChange={(e) => setFilter('kind', e.target.value)}>
              <option value="">All</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label>
            State
            <select aria-label="Filter by state" value={lens.filters['state'] ?? ''} onChange={(e) => setFilter('state', e.target.value)}>
              <option value="">All</option>
              {states.map((s) => (
                <option key={s} value={s}>
                  {displayState(s).label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Search
            <input aria-label="Search records" value={lens.filters['q'] ?? ''} onChange={(e) => setFilter('q', e.target.value)} />
          </label>
          <button type="button" className="numbers-button" onClick={() => onLensAction({ type: 'CLEAR_FILTERS' })}>
            Clear filters
          </button>
          {canExport ? (
            <button type="button" className="numbers-button" data-testid="operations-export" onClick={() => (onExport ?? ((csv) => downloadCsv(`brain-${world.projectId}.csv`, csv)))(factsCsv(shown))}>
              Export CSV
            </button>
          ) : null}
        </div>
        <table className="numbers-table" data-testid="operations-records">
          <caption>
            Records ({shown.length} of {world.facts.length})
          </caption>
          <thead>
            <tr>
              {(
                [
                  ['title', 'Record'],
                  ['kind', 'Kind'],
                  ['state', 'State'],
                  ['lastChangedAt', 'Last changed'],
                ] as const
              ).map(([key, label]) => (
                <th key={key} scope="col" aria-sort={ariaSort(key)}>
                  <button type="button" className="numbers-sort" onClick={() => toggleSort(key)}>
                    {label}
                  </button>
                </th>
              ))}
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((f) => {
              const d = displayFact(f, ctx);
              return (
                <tr key={`${f.kind}:${f.recordId}`} data-record={`${f.kind}:${f.recordId}`}>
                  <td>
                    <button type="button" className="numbers-link" onClick={() => select(f)}>
                      {f.title}
                    </button>
                  </td>
                  <td>{f.kind}</td>
                  <td>{d.state.label}</td>
                  <td>
                    {d.lastChangedAt}
                    {d.freshness !== 'CURRENT' ? ` (${d.freshness.toLowerCase()})` : ''}
                  </td>
                  <td>{f.href ? <a className="numbers-link" href={f.href}>{d.source}</a> : d.source}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selectedFact ? <RecordDrawer fact={selectedFact} ctx={ctx} onClose={() => onLensAction({ type: 'SELECT', selection: null })} /> : null}

      <div className="numbers-section">
        <table className="numbers-table" data-testid="operations-workers">
          <caption>Workers</caption>
          <thead>
            <tr>
              <th scope="col">Worker</th>
              <th scope="col">State</th>
              <th scope="col">Holding</th>
            </tr>
          </thead>
          <tbody>
            {world.workers.length === 0 ? (
              <tr>
                <td colSpan={3}>No worker holds a lease.</td>
              </tr>
            ) : (
              world.workers.map((w) => (
                <tr key={w.workerId}>
                  <td>{w.workerId}</td>
                  <td>{displayState(w.state).label}</td>
                  <td>
                    {w.holding.map((h) => (h.href ? <a key={h.recordId} className="numbers-link" href={h.href}>{`${h.kind} ${h.recordId} `}</a> : <span key={h.recordId}>{`${h.kind} ${h.recordId} `}</span>))}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="numbers-section">
        <table className="numbers-table" data-testid="operations-money">
          <caption>Cash movements by class — never summed across classes or currencies</caption>
          <thead>
            <tr>
              <th scope="col">Class</th>
              <th scope="col">Basis</th>
              <th scope="col">Amount</th>
              <th scope="col">Confidence</th>
              <th scope="col">As of</th>
            </tr>
          </thead>
          <tbody>
            {world.money.flatMap((m) =>
              displayMoneyClass(m, ctx).map((v, i) => {
                const line = m.lines[i];
                return (
                  <tr key={`${m.class}:${i}`} data-money-class={m.class}>
                    <th scope="row" title={m.meaning}>
                      {m.class}
                    </th>
                    <td>{v.basisLabel}</td>
                    <td className="numbers-num">
                      {line ? (
                        <a className="numbers-link" href={moneyLineHref(world.projectId, line)} title={v.source}>
                          {v.text}
                        </a>
                      ) : (
                        <span title={v.note ?? undefined}>{v.text}</span>
                      )}
                    </td>
                    <td>
                      <span className={`numbers-tag numbers-tag-${v.confidence.toLowerCase()}`}>{v.confidence.toLowerCase()}</span>
                    </td>
                    <td>{v.asOf ?? 'unknown'}</td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

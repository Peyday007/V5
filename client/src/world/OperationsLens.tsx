/**
 * Operations mode (UI-27-3, S-0420; UI-27-6, S-0430 – S-0431).
 *
 * "High-density, readable factual interface for transactions, goals, research
 * throughput, worker utilization, failures, cash movements, portfolio
 * decisions, approvals, and performance trends. Sort, filter, compare, export
 * if authorized, and trace each number to its source."
 *
 * One input: the `World` that `GET /api/projects/:projectId/world` returned.
 * No second store and no second authority path — this file only arranges what
 * the route served. Every figure goes through the truth contract
 * (`truth.ts`), so a projected or simulated line can never print as cash, and
 * every numeric cell is a link to the record (or the ledger read) it came
 * from. Export appears only when the response itself marks the caller
 * authorised to export; `canWrite` is not an export grant and is not read as
 * one (invariants 21, 28, 39).
 *
 * It stands alone: nothing here needs the world scene.
 */
import { useMemo, useState } from 'react';
import type { World, WorldEntityKind, WorldFact, WorldMoney, WorldMoneyLine, WorldState } from '../../../server/routes/world.ts';
import { displayFact, displayMoneyClass, displayState, workingCountDisplay, type DisplayValue, type TruthContext } from './truth.ts';
import { UNKNOWN_TEXT } from './RecordDrawer.tsx';
import './numbers.css';

export const OPERATIONS_LENS_VERSION = 1 as const;

export type FactSortKey = 'kind' | 'title' | 'state' | 'owner' | 'lastChangedAt';
export type SortDirection = 'asc' | 'desc';

export interface FactFilter {
  /** Matched against title, record id, owner, blocker and next action. */
  text: string;
  /** '' means every kind. A group name ("TRANSACTIONS") covers several kinds. */
  kind: string;
  /** '' means every state. */
  state: WorldState | '';
}

/** Named groups of kinds the spec talks about, so "transactions" is one filter. Not a whitelist: every kind is also selectable alone. */
export const KIND_GROUPS: Readonly<Record<string, readonly WorldEntityKind[]>> = {
  TRANSACTIONS: ['OPPORTUNITY', 'INVOICE'],
  WORK: ['WORK_UNIT', 'BIN', 'CAMPAIGN'],
};

export const EMPTY_FILTER: FactFilter = { text: '', kind: '', state: '' };

export function filterFacts(facts: readonly WorldFact[], filter: FactFilter): WorldFact[] {
  const text = filter.text.trim().toLowerCase();
  const group = KIND_GROUPS[filter.kind];
  return facts.filter((f) => {
    if (filter.kind !== '' && (group ? !group.includes(f.kind) : f.kind !== filter.kind)) return false;
    if (filter.state !== '' && f.state !== filter.state) return false;
    if (text === '') return true;
    return [f.title, f.recordId, f.owner, f.blocker, f.nextAction].some((v) => typeof v === 'string' && v.toLowerCase().includes(text));
  });
}

/** A stable sort; a missing value sorts last in either direction, so absence never ranks first. */
export function sortFacts(facts: readonly WorldFact[], key: FactSortKey, dir: SortDirection): WorldFact[] {
  const sign = dir === 'asc' ? 1 : -1;
  return facts
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const av = a.f[key];
      const bv = b.f[key];
      if (av === null || av === undefined) return bv === null || bv === undefined ? a.i - b.i : 1;
      if (bv === null || bv === undefined) return -1;
      const c = String(av).localeCompare(String(bv));
      return c !== 0 ? sign * c : a.i - b.i;
    })
    .map(({ f }) => f);
}

/**
 * Whether the response grants export. Only an explicit `canExport: true` on
 * the viewer counts; its absence — which is what the route serves today — means
 * no export control is drawn at all.
 */
export function exportAllowed(viewer: World['viewer'] | null | undefined): boolean {
  return (viewer as { canExport?: unknown } | null | undefined)?.canExport === true;
}

/**
 * Where a money line can be traced. Invoices have their own read; every other
 * class is the ledger read the world route made, named by its table and filter.
 */
export function moneyLineHref(projectId: string, line: WorldMoneyLine): string {
  if (line.source.table === 'cash_invoices') return `/api/projects/${projectId}/cash/invoices`;
  return `/api/projects/${projectId}/world`;
}

export function factsToCsv(facts: readonly WorldFact[]): string {
  const cell = (v: string | null) => {
    const s = v ?? UNKNOWN_TEXT;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['kind', 'recordId', 'title', 'state', 'recordState', 'owner', 'startedAt', 'lastChangedAt', 'blocker', 'nextAction', 'source', 'href'];
  const rows = facts.map((f) =>
    [f.kind, f.recordId, f.title, f.state, f.recordState, f.owner, f.startedAt, f.lastChangedAt, f.blocker, f.nextAction, `${f.source.table}#${f.source.id}`, f.href]
      .map(cell)
      .join(','),
  );
  return [head.join(','), ...rows].join('\n');
}

export interface OperationsLensProps {
  world: World;
  /** The reader's clock; defaults to now. */
  nowMs?: number;
  initialFilter?: Partial<FactFilter>;
  /** Opens the shared record drawer; the lens never keeps its own selection. */
  onSelect?: (selection: { kind: WorldEntityKind; id: string }) => void;
}

const STATES: WorldState[] = ['WORKING', 'WAITING', 'BLOCKED', 'NEEDS_APPROVAL', 'SUCCEEDED', 'FAILED', 'IDLE', 'UNKNOWN'];

const COLUMNS: Array<{ key: FactSortKey; label: string }> = [
  { key: 'kind', label: 'Kind' },
  { key: 'title', label: 'Record' },
  { key: 'state', label: 'State' },
  { key: 'owner', label: 'Owner' },
  { key: 'lastChangedAt', label: 'Last changed' },
];

function NumberLink({ value, href, testId }: { value: DisplayValue; href: string; testId?: string }) {
  return (
    <a href={href} className="wn-num" data-testid={testId} title={`${value.basisLabel}; source ${value.source}`}>
      {value.text}
    </a>
  );
}

function MoneyTable({ world, ctx }: { world: World; ctx: TruthContext }) {
  return (
    <table className="wn-table" aria-label="Cash movements by class">
      <thead>
        <tr>
          <th scope="col">Class</th>
          <th scope="col">What it is</th>
          <th scope="col">Ledger kind</th>
          <th scope="col">Direction</th>
          <th scope="col" className="wn-right">
            Amount
          </th>
          <th scope="col">Confidence</th>
          <th scope="col">As of</th>
          <th scope="col">Source</th>
        </tr>
      </thead>
      <tbody>
        {world.money.flatMap((money: WorldMoney) => {
          const shown = displayMoneyClass(money, ctx);
          if (money.lines.length === 0) {
            const v = shown[0]!;
            return [
              <tr key={money.class} data-money-class={money.class}>
                <th scope="row">{money.class}</th>
                <td>{v.basisLabel}</td>
                <td className="wn-unknown">{UNKNOWN_TEXT}</td>
                <td className="wn-unknown">{UNKNOWN_TEXT}</td>
                <td className="wn-right wn-unknown">{v.text}</td>
                <td>{v.confidence}</td>
                <td className="wn-unknown">{UNKNOWN_TEXT}</td>
                <td>{v.note}</td>
              </tr>,
            ];
          }
          return money.lines.map((line, i) => {
            const v = shown[i]!;
            return (
              <tr key={`${money.class}:${line.kind}:${line.currency}`} data-money-class={money.class}>
                <th scope="row">{money.class}</th>
                <td>{v.basisLabel}</td>
                <td>{line.kind}</td>
                <td>{line.direction}</td>
                <td className="wn-right">
                  <NumberLink value={v} href={moneyLineHref(world.projectId, line)} testId="money-amount" />
                </td>
                <td>{v.confidence}</td>
                <td className={v.asOf ? undefined : 'wn-unknown'}>{v.asOf ?? UNKNOWN_TEXT}</td>
                <td>
                  {v.source}
                  {v.note ? <span className="wn-note"> — {v.note}</span> : null}
                </td>
              </tr>
            );
          });
        })}
      </tbody>
    </table>
  );
}

export function OperationsLens({ world, nowMs, initialFilter, onSelect }: OperationsLensProps) {
  const ctx: TruthContext = { world, nowMs: nowMs ?? Date.now() };
  const [filter, setFilter] = useState<FactFilter>({ ...EMPTY_FILTER, ...initialFilter });
  const [sort, setSort] = useState<{ key: FactSortKey; dir: SortDirection }>({ key: 'lastChangedAt', dir: 'desc' });
  const rows = useMemo(() => sortFacts(filterFacts(world.facts, filter), sort.key, sort.dir), [world.facts, filter, sort]);
  const kinds = useMemo(() => [...new Set(world.facts.map((f) => f.kind))].sort(), [world.facts]);
  const working = workingCountDisplay(world);
  const canExport = exportAllowed(world.viewer);

  const toggleSort = (key: FactSortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const doExport = () => {
    const blob = new Blob([factsToCsv(rows)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `brain-operations-${world.projectId}-${world.generatedAt}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="wn-lens" aria-label="Operations" data-testid="operations-lens">
      <header className="wn-lens__head">
        <h2>Operations</h2>
        <p className="wn-meta">
          Read at <time dateTime={world.generatedAt}>{world.generatedAt}</time> · contract v{world.version} · project {world.projectId}
          {world.truncated.length > 0 ? <span className="wn-note"> · partial: {world.truncated.join(', ')} cut at a page limit</span> : null}
        </p>
      </header>

      <section aria-label="Needs attention and decisions">
        <h3>Needs attention and decisions</h3>
        {world.explanations.length === 0 ? (
          <p className="wn-note">Nothing blocked, failed, awaiting approval or decided in this read.</p>
        ) : (
          <ul className="wn-list">
            {world.explanations.map((e) => (
              <li key={`${e.kind}:${e.recordKind}:${e.recordId}`} data-explanation={e.kind}>
                <span className="wn-tag">{e.kind}</span> {e.href ? <a href={e.href}>{e.text}</a> : e.text}
                <span className="wn-meta"> · {e.lastChangedAt ?? UNKNOWN_TEXT}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Records">
        <h3>Records</h3>
        <div className="wn-filters" role="search">
          <label>
            Search
            <input type="search" value={filter.text} onChange={(e) => setFilter({ ...filter, text: e.target.value })} aria-label="Filter records by text" />
          </label>
          <label>
            Kind
            <select value={filter.kind} onChange={(e) => setFilter({ ...filter, kind: e.target.value })} aria-label="Filter by kind">
              <option value="">Every kind</option>
              {Object.keys(KIND_GROUPS).map((g) => (
                <option key={g} value={g}>
                  {g.toLowerCase()}
                </option>
              ))}
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label>
            State
            <select value={filter.state} onChange={(e) => setFilter({ ...filter, state: e.target.value as WorldState | '' })} aria-label="Filter by state">
              <option value="">Every state</option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {displayState(s).label}
                </option>
              ))}
            </select>
          </label>
          {canExport ? (
            <button type="button" className="wn-button" onClick={doExport} data-testid="export">
              Export CSV
            </button>
          ) : null}
        </div>
        <p className="wn-meta" aria-live="polite">
          <a href={`/api/projects/${world.projectId}/world`} className="wn-num">
            {rows.length} of {world.facts.length} records
          </a>
        </p>
        <table className="wn-table" aria-label="Records">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} scope="col" aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="wn-sort" onClick={() => toggleSort(c.key)}>
                    {c.label}
                    {sort.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </button>
                </th>
              ))}
              <th scope="col">Blocker / next action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => {
              const d = displayFact(f, ctx);
              return (
                <tr key={`${f.kind}:${f.recordId}`} data-state={f.state} data-kind={f.kind}>
                  <td>{f.kind}</td>
                  <td>
                    {onSelect ? (
                      <button type="button" className="wn-link" onClick={() => onSelect({ kind: f.kind, id: f.recordId })}>
                        {f.title}
                      </button>
                    ) : f.href ? (
                      <a href={f.href}>{f.title}</a>
                    ) : (
                      f.title
                    )}
                  </td>
                  <td>
                    <span className="wn-state" data-state={f.state}>
                      {d.state.label}
                    </span>
                  </td>
                  <td className={f.owner ? undefined : 'wn-unknown'}>{f.owner ?? UNKNOWN_TEXT}</td>
                  <td className={f.lastChangedAt ? undefined : 'wn-unknown'}>
                    {f.lastChangedAt ?? UNKNOWN_TEXT}
                    {d.freshness === 'STALE' ? <span className="wn-tag">stale</span> : null}
                  </td>
                  <td>{f.blocker ? `Blocked: ${f.blocker}` : f.nextAction ? `Next: ${f.nextAction}` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section aria-label="Worker utilisation">
        <h3>Worker utilisation</h3>
        <p>
          <a href={`/api/russell/projects/${world.projectId}/fleet`} className="wn-num" data-testid="working-count">
            {working.text}
          </a>
        </p>
        {world.workers.length === 0 ? (
          <p className="wn-note">No worker holds a lease in this read.</p>
        ) : (
          <table className="wn-table" aria-label="Workers">
            <thead>
              <tr>
                <th scope="col">Worker</th>
                <th scope="col">State</th>
                <th scope="col" className="wn-right">
                  Leases held
                </th>
                <th scope="col">Holding</th>
              </tr>
            </thead>
            <tbody>
              {world.workers.map((w) => (
                <tr key={w.workerId} data-state={w.state}>
                  <td>{w.workerId}</td>
                  <td>{displayState(w.state).label}</td>
                  <td className="wn-right">
                    <a href={`/api/russell/projects/${world.projectId}/fleet`} className="wn-num">
                      {w.holding.length}
                    </a>
                  </td>
                  <td>
                    {w.holding.map((h) => (
                      <span key={`${h.kind}:${h.recordId}`} className="wn-chip">
                        {h.href ? <a href={h.href}>{`${h.kind} ${h.recordId}`}</a> : `${h.kind} ${h.recordId}`} · heartbeat {h.heartbeatAt ?? UNKNOWN_TEXT}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Cash movements">
        <h3>Cash movements</h3>
        <p className="wn-note">Each class is separate and lines are never summed: projected and simulated figures are not cash.</p>
        <MoneyTable world={world} ctx={ctx} />
      </section>
    </section>
  );
}

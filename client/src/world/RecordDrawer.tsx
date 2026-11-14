/**
 * The record drawer (UI-27-2, S-0418): what clicking a place, a character or
 * a row opens. "Clicking a place or character resolves to the correct Brain
 * record and shows ownership, inputs, output, source data, started/last-changed
 * times, queues, blocker, economic consequence and next available action."
 *
 * Every field the response does not carry reads "unknown" — never blank,
 * never zero, never a favourable default (invariant 39). It stands alone: the
 * world scene, the operations table and the goal lens all open the same one.
 */
import type { WorldFact } from '../../../server/routes/world.ts';
import { displayFact, type TruthContext } from './truth.ts';
import './numbers.css';

export const UNKNOWN = 'unknown';

/** Fields the world contract does not serve; a caller that read them from the record's own route passes them. */
export interface RecordDetail {
  inputs?: string | null;
  output?: string | null;
  queue?: string | null;
  economicConsequence?: string | null;
}

export interface RecordDrawerProps {
  fact: WorldFact;
  ctx: TruthContext;
  detail?: RecordDetail;
  onClose?: () => void;
}

function known(value: string | null | undefined): string {
  return value === null || value === undefined || value.trim() === '' || value === 'Not recorded' || value === 'Owner not recorded' ? UNKNOWN : value;
}

export function drawerRows(fact: WorldFact, ctx: TruthContext, detail: RecordDetail = {}): Array<[string, string]> {
  const d = displayFact(fact, ctx);
  return [
    ['Owner', known(fact.owner)],
    ['State', `${d.state.label} (record says ${known(fact.recordState)})`],
    ['Started', known(fact.startedAt)],
    ['Last changed', known(fact.lastChangedAt)],
    ['Freshness', d.freshness],
    ['Source', d.source],
    ['Queue', known(detail.queue)],
    ['Inputs', known(detail.inputs)],
    ['Output', known(detail.output)],
    ['Progress', known(fact.progress)],
    ['Blocker', known(fact.blocker)],
    ['Economic consequence', known(detail.economicConsequence)],
    ['Next action', known(fact.nextAction)],
  ];
}

export function RecordDrawer({ fact, ctx, detail, onClose }: RecordDrawerProps) {
  const rows = drawerRows(fact, ctx, detail);
  const d = displayFact(fact, ctx);
  return (
    <aside className="numbers-drawer" role="dialog" aria-label={`Record ${fact.title}`} data-testid="record-drawer" data-record={`${fact.kind}:${fact.recordId}`}>
      <header className="numbers-drawer-head">
        <h3>{fact.title}</h3>
        {onClose ? (
          <button type="button" className="numbers-button" onClick={onClose} aria-label="Close record">
            Close
          </button>
        ) : null}
      </header>
      <p className="numbers-muted">
        {fact.kind} · {fact.recordId}
      </p>
      <dl className="numbers-dl">
        {rows.map(([k, v]) => (
          <div key={k} className="numbers-dl-row">
            <dt>{k}</dt>
            <dd data-field={k}>{v}</dd>
          </div>
        ))}
        {fact.missing.length > 0 ? (
          <div className="numbers-dl-row">
            <dt>Not recorded</dt>
            <dd data-field="Not recorded">{fact.missing.join(', ')}</dd>
          </div>
        ) : null}
      </dl>
      {d.note ? <p className="numbers-muted">{d.note}</p> : null}
      {fact.href ? (
        <a className="numbers-link" href={fact.href}>
          Open the record
        </a>
      ) : (
        <p className="numbers-muted">No route serves this record alone.</p>
      )}
    </aside>
  );
}

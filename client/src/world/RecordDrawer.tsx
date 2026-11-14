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
import type { ReactNode } from 'react';
import type { WorldEntityKind, WorldFact } from '../../../server/routes/world.ts';
import { displayFact, type TruthContext } from './truth.ts';
import { followInApp, recordViewHref } from './lens.ts';
import './numbers.css';

/**
 * A link to a record's page in this app — never to its `/api/…` address, which
 * is JSON a person cannot read. Clicking it moves the app there in place.
 */
export function RecordLink({ kind, recordId, className = 'numbers-link', children }: { kind: WorldEntityKind; recordId: string; className?: string; children: ReactNode }): JSX.Element {
  const href = recordViewHref(kind, recordId);
  return (
    <a className={className} href={href} data-record={`${kind}:${recordId}`} onClick={(e) => followInApp(e, href)}>
      {children}
    </a>
  );
}

/** A record's API address shown as provenance text, not as a link a person is sent through. */
export function SourceAddress({ href }: { href: string }): JSX.Element {
  return (
    <span className="numbers-muted" data-field="Source address">
      source data <code>{href}</code>
    </span>
  );
}

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
      <p>
        <RecordLink kind={fact.kind} recordId={fact.recordId}>
          Link to this record
        </RecordLink>{' '}
        {fact.href ? <SourceAddress href={fact.href} /> : <span className="numbers-muted">No route serves this record&rsquo;s data alone.</span>}
      </p>
    </aside>
  );
}

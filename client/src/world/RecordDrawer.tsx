/**
 * The record drawer (UI-27-2, S-0418; UI-27-6, S-0430).
 *
 * "Clicking a place or character resolves to the correct Brain record and
 * shows ownership, inputs, output, source data, started/last-changed times,
 * queues, blocker, economic consequence and next available action."
 *
 * Every field comes from what the world route returned. A field the response
 * does not carry is printed as "unknown" — never blank, never a default and
 * never the favourable answer (invariants 39, 45). The drawer stands alone:
 * it needs no scene, and every renderer opens the same one.
 */
import type { WorldEntityKind, WorldFact } from '../../../server/routes/world.ts';
import { displayFact, displayState, type DisplayValue, type TruthContext } from './truth.ts';
import './numbers.css';

/** The word every surface prints for a field the response did not carry. */
export const UNKNOWN_TEXT = 'unknown';

/** Facts beyond the world fact itself, when another existing route served them. Each is optional. */
export interface RecordExtras {
  inputs?: readonly string[] | null;
  output?: string | null;
  queue?: string | null;
  /** The economic consequence, already a truth-contract display value. */
  economic?: DisplayValue | null;
}

export interface RecordDrawerProps {
  /** The selection the drawer was opened for. */
  selection: { kind: WorldEntityKind; id: string } | null;
  /** The facts of the world read; the drawer finds the selected record among them. */
  facts: readonly WorldFact[];
  ctx: TruthContext;
  extras?: RecordExtras;
  onClose?: () => void;
}

export interface DrawerRow {
  label: string;
  text: string;
  known: boolean;
}

function row(label: string, value: string | null | undefined): DrawerRow {
  const known = typeof value === 'string' && value.trim() !== '';
  return { label, text: known ? (value as string) : UNKNOWN_TEXT, known };
}

/**
 * The drawer's rows for a fact, in order. Pure, so the "unknown" rule is
 * testable without rendering. Raw fact fields are read, not display text, so
 * an absent owner is "unknown" rather than a phrase that looks like data.
 */
export function drawerRows(fact: WorldFact, ctx: TruthContext, extras: RecordExtras = {}): DrawerRow[] {
  const shown = displayFact(fact, ctx);
  const economic = extras.economic ?? null;
  return [
    row('State', `${shown.state.label} (record: ${fact.recordState ?? UNKNOWN_TEXT})`),
    row('Owner', fact.owner),
    row('Inputs', extras.inputs && extras.inputs.length > 0 ? extras.inputs.join(', ') : null),
    row('Output', extras.output),
    row('Source', shown.source),
    row('Started', fact.startedAt),
    row('Last changed', fact.lastChangedAt),
    row('Freshness', shown.note ? `${shown.freshness} — ${shown.note}` : shown.freshness),
    row('Queue', extras.queue),
    row('Blocker', fact.blocker),
    row('Economic consequence', economic ? `${economic.text} — ${economic.basisLabel} (${economic.confidence})` : null),
    row('Next action', fact.nextAction),
  ];
}

export function RecordDrawer({ selection, facts, ctx, extras, onClose }: RecordDrawerProps) {
  if (!selection) return null;
  const fact = facts.find((f) => f.kind === selection.kind && f.recordId === selection.id) ?? null;
  const titleId = `record-drawer-${selection.kind}-${selection.id}`;
  return (
    <aside className="wn-drawer" role="dialog" aria-modal="false" aria-labelledby={titleId} data-testid="record-drawer">
      <header className="wn-drawer__head">
        <h2 id={titleId} className="wn-drawer__title">
          {fact ? fact.title : `${selection.kind} ${selection.id}`}
        </h2>
        {onClose ? (
          <button type="button" className="wn-button" onClick={onClose}>
            Close
          </button>
        ) : null}
      </header>
      <p className="wn-drawer__kind">
        {selection.kind} · <code>{selection.id}</code>
      </p>
      {fact ? (
        <>
          <dl className="wn-drawer__rows">
            {drawerRows(fact, ctx, extras).map((r) => (
              <div key={r.label} className={r.known ? 'wn-drawer__row' : 'wn-drawer__row wn-unknown'}>
                <dt>{r.label}</dt>
                <dd>{r.text}</dd>
              </div>
            ))}
          </dl>
          {fact.missing.length > 0 ? <p className="wn-note">The record does not carry: {fact.missing.join(', ')}.</p> : null}
          <p className="wn-drawer__link">
            {fact.href ? (
              <a href={fact.href} data-testid="record-link">
                Open the record
              </a>
            ) : (
              <span>No route serves this record alone; source {displayFact(fact, ctx).source}.</span>
            )}
          </p>
        </>
      ) : (
        <p className="wn-note" data-testid="record-not-found">
          State {displayState('UNKNOWN').label}: this record is not among the facts of the current world read.
        </p>
      )}
    </aside>
  );
}

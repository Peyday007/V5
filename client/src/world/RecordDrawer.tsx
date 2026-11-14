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
import { useEffect, useState } from 'react';
import type { WorldFact } from '../../../server/routes/world.ts';
import { api } from '../lib/api.ts';
import { displayFact, type TruthContext } from './truth.ts';
import './numbers.css';

export const UNKNOWN = 'unknown';

/**
 * Fields the world contract does not serve. They live on the record's own
 * route (`fact.href`), so the drawer reads that route itself rather than
 * relying on every caller to fetch it — a caller that already holds them may
 * still pass them, and what it passes wins field by field.
 */
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

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function cents(value: unknown, currency: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${(value / 100).toFixed(2)} ${str(currency) ?? 'USD'}`;
}

function brief(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return str(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = JSON.stringify(value);
  if (!text || text === '{}' || text === '[]') return null;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function joined(parts: Array<string | null>): string | null {
  const kept = parts.filter((one): one is string => one !== null);
  return kept.length > 0 ? kept.join('; ') : null;
}

/**
 * What the record's own route says about inputs, output, queue and economic
 * consequence, read from the body that route serves for this kind. Only what
 * the body actually carries is returned; nothing is defaulted or inferred, so
 * an absent field stays absent and the drawer prints "unknown" (invariant 39).
 */
export function detailFromRecord(fact: WorldFact, body: unknown): RecordDetail {
  const root = obj(body);
  if (!root) return {};
  switch (fact.kind) {
    case 'WORK_UNIT': {
      const item = obj(root.item);
      if (!item) return {};
      const attempts = Array.isArray(root.attempts) ? root.attempts.length : null;
      return {
        inputs: brief(item.payload),
        output: joined([str(item.resultSummary), str(item.resultRef) ? `result ${String(item.resultRef)}` : null]),
        queue: joined([
          str(item.workType),
          str(item.state),
          typeof item.priority === 'number' ? `priority ${item.priority}` : null,
          typeof item.attemptCount === 'number' ? `attempt ${item.attemptCount}${typeof item.maxAttempts === 'number' ? ` of ${item.maxAttempts}` : ''}` : null,
          attempts !== null ? `${attempts} lease(s) recorded` : null,
        ]),
      };
    }
    case 'RESEARCH_JOB': {
      const o = obj(root.orchestration);
      const ledger = obj(root.ledger);
      const doc = obj(root.document);
      const claims = Array.isArray(root.claims) ? root.claims.length : null;
      return {
        inputs: o ? str(o.assignment) : null,
        output: joined([
          claims !== null ? `${claims} claim(s) generated` : null,
          ledger ? brief(ledger) : null,
          doc ? `document ${str(doc.canonicalName) ?? str(doc.id) ?? ''}`.trim() : null,
        ]),
        queue: o ? joined([str(o.status), str(o.currentPass) ? `pass ${String(o.currentPass)}` : null]) : null,
      };
    }
    case 'CAMPAIGN': {
      const units = Array.isArray(root.units) ? root.units.length : null;
      const releases = obj(root.decisionWaiting);
      return {
        inputs: joined([str(root.objective), str(root.expectedOutcome) ? `expected: ${String(root.expectedOutcome)}` : null]),
        output: joined([brief(root.outcome), units !== null ? `${units} unit(s)` : null]),
        queue: joined([str(root.stage), str(root.stageDetail), releases ? 'a release decision is waiting' : null]),
      };
    }
    case 'OPPORTUNITY':
    case 'INVOICE': {
      const op = obj(root.opportunity);
      if (!op) return {};
      // An invoice is served through its opportunity; only what that body says about the deal is shown, never an invoice amount it does not carry.
      const price = cents(op.priceCents, op.currency);
      const peak = cents(op.peakFundingCents, op.currency);
      return {
        inputs: fact.kind === 'OPPORTUNITY' ? joined([str(op.offerScope), str(op.deliveryMethod) ? `delivered by ${String(op.deliveryMethod)}` : null]) : null,
        output: fact.kind === 'OPPORTUNITY' ? str(op.validationState) : null,
        economicConsequence: fact.kind === 'OPPORTUNITY' ? joined([price ? `price ${price} (stated, not received)` : null, peak ? `peak funding ${peak}` : null]) : null,
      };
    }
    case 'GOAL': {
      const goal = obj(root.goal);
      if (!goal) return {};
      const target = obj(goal.target);
      const target$ = target ? cents(target.targetCents, target.currency) : null;
      const achieved$ = target ? cents(target.achievedCents, target.currency) : null;
      return {
        inputs: joined([str(goal.intent), target ? str(target.resources) : null]),
        output: str(goal.outcome),
        economicConsequence: joined([
          target$ ? `target ${target$}` : null,
          achieved$ ? `achieved ${achieved$} (${target && Array.isArray(target.counted) ? `counting ${target.counted.join(', ')}` : 'as read by the goal model'})` : null,
        ]),
      };
    }
    default:
      return {};
  }
}

/** The kinds whose `href` serves that one record, so reading it answers the drawer's detail. */
const READS_OWN_RECORD: ReadonlySet<WorldFact['kind']> = new Set(['WORK_UNIT', 'RESEARCH_JOB', 'CAMPAIGN', 'OPPORTUNITY', 'INVOICE', 'GOAL']);

function merged(read: RecordDetail, given: RecordDetail | undefined): RecordDetail {
  const out: RecordDetail = { ...read };
  for (const key of ['inputs', 'output', 'queue', 'economicConsequence'] as const) {
    const value = given?.[key];
    if (value !== undefined && value !== null && value.trim() !== '') out[key] = value;
  }
  return out;
}

/** Read the record's own route once per record; a refusal or failure leaves the fields unknown rather than guessed. */
export function useRecordDetail(fact: WorldFact, given?: RecordDetail): RecordDetail {
  const [read, setRead] = useState<RecordDetail>({});
  const href = fact.href && READS_OWN_RECORD.has(fact.kind) ? fact.href : null;
  useEffect(() => {
    setRead({});
    if (!href) return;
    let live = true;
    api<unknown>(href)
      .then((body) => {
        if (live) setRead(detailFromRecord(fact, body));
      })
      .catch(() => {
        if (live) setRead({});
      });
    return () => {
      live = false;
    };
  }, [href, fact.kind, fact.recordId]);
  return merged(read, given);
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
  const resolved = useRecordDetail(fact, detail);
  const rows = drawerRows(fact, ctx, resolved);
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

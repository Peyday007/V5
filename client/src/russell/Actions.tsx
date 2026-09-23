/**
 * External actions (§50): what Brain may do outside itself, and what it did.
 *
 * Four sections, each answering one question a person asks:
 *
 *   What can Brain do out there?   — the capability readings, in the server's
 *                                    words, including the two it never can.
 *   What is connected, and how?    — each provider's state, the one next step,
 *                                    and the name of the secret to deploy.
 *   What is waiting for me?        — prepared actions, shown exactly as they
 *                                    would be sent, with Approve and Cancel.
 *   What happened?                 — every action with the provider's own
 *                                    identifier and what reading it back said.
 *
 * Every sentence is the server's. A control a person may not use is disabled
 * with the reason rather than removed, and a hidden control is never the
 * authorization: the routes decide again at the moment anything happens.
 *
 * There is no field anywhere on this page for a credential. Connecting a
 * provider names a deployment secret; an administrator sets its value outside
 * Brain.
 */
import { useState } from 'react';
import { api } from '../lib/api.ts';
import { useAsync } from './useAsync.ts';

interface Capability {
  id: string;
  state: 'PRESENT' | 'MISSING' | 'UNKNOWN';
  does: string | null;
  requires: string | null;
  detail: string | null;
}

interface ConnectionSummary {
  id: string;
  label: string;
  state: string;
  says: string;
  nextStep: string | null;
  secretName: string;
  selfDestination: string | null;
  sender: string | null;
  connectionState: string;
  lastCheckedAt: string | null;
  mode: string | null;
  connectedAt: string;
  revokedAt: string | null;
}

interface ProviderEntry {
  provider: 'NTFY' | 'RESEND' | 'STRIPE';
  title: string;
  does: string;
  secretShape: string;
  setup: string[];
  capabilities: string[];
  secretName: string;
  current: ConnectionSummary | null;
  history: ConnectionSummary[];
}

interface Action {
  id: string;
  kind: 'NOTIFY_OWNER' | 'SEND_EMAIL' | 'ISSUE_INVOICE';
  commercialAction: string | null;
  destination: string;
  content: { subject?: string; body?: string; lines?: Array<{ description: string; amountCents: number }> };
  expectedEffect: string;
  amountCents: number | null;
  currency: string | null;
  state: string;
  approvalRequired: boolean;
  requestedByType: string;
  approvedAt: string | null;
  providerRef: string | null;
  outcomeDetail: string | null;
  readbackState: string | null;
  readbackDetail: string | null;
  readbackAt: string | null;
  createdAt: string;
  opportunityId: string | null;
  conversationId: string | null;
}

interface ExternalView {
  project: { id: string; name: string };
  providers: ProviderEntry[];
  capabilities: Capability[];
  actions: Action[];
  can: { administer: boolean; approve: boolean; prepare: boolean };
}

const NOT_ADMIN = 'Only an administrator of this project can do this.';

export function ActionsView({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync<ExternalView | null>(
    async () => (projectId ? await api<ExternalView>(`/api/projects/${projectId}/external`) : null),
    [projectId],
  );
  if (!projectId) return <p className="rs-empty">Open a project to see what Brain may do outside itself.</p>;
  if (query.loading && !query.data) return <p className="rs-empty">Reading connections…</p>;
  if (query.error) return <p className="rs-empty">{query.error.message}</p>;
  const view = query.data;
  if (!view) return <p className="rs-empty">Reading connections…</p>;
  const waiting = view.actions.filter((one) => one.state === 'AWAITING_APPROVAL');
  return (
    <div className="rs-stack rs-actions">
      <Capabilities view={view} />
      <Waiting actions={waiting} view={view} reload={query.reload} />
      <Connections view={view} reload={query.reload} />
      <Prepare view={view} reload={query.reload} />
      <History actions={view.actions.filter((one) => one.state !== 'AWAITING_APPROVAL')} view={view} reload={query.reload} />
    </div>
  );
}

function Capabilities({ view }: { view: ExternalView }): JSX.Element {
  return (
    <section className="rs-card rs-actions-capabilities">
      <h3>What Brain can do outside itself</h3>
      <p className="rs-item-meta">
        Read from this project’s connections now. A capability is available only when a credential
        is deployed and the provider answered for it; an entered key or a written adapter is not
        enough.
      </p>
      <ul className="rs-list">
        {view.capabilities.map((one) => (
          <li key={one.id} className="rs-item">
            <strong>{one.does ?? one.id}</strong>{' '}
            <span className={`rs-chip rs-chip-${one.state.toLowerCase()}`}>
              {one.state === 'PRESENT' ? 'available' : one.state === 'MISSING' ? 'not available' : 'unknown'}
            </span>
            <p className="rs-item-meta">{one.detail ?? one.requires}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

async function post(path: string, body: unknown = {}): Promise<string | null> {
  try {
    await api(path, { method: 'POST', body: JSON.stringify(body) });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'That did not work.';
  }
}

function ActionBody({ action }: { action: Action }): JSX.Element {
  return (
    <>
      <p>{action.expectedEffect}</p>
      {action.kind === 'ISSUE_INVOICE' ? (
        <ul className="rs-list">
          {(action.content.lines ?? []).map((line, index) => (
            <li key={index} className="rs-item-meta">
              {line.description} — {(line.amountCents / 100).toFixed(2)} {action.currency}
            </li>
          ))}
        </ul>
      ) : (
        <blockquote className="rs-actions-message">
          <strong>{action.content.subject}</strong>
          <p style={{ whiteSpace: 'pre-wrap' }}>{action.content.body}</p>
        </blockquote>
      )}
      <p className="rs-item-meta">
        {action.commercialAction
          ? `This is ${action.commercialAction} under the standing commercial authority.`
          : 'Self-directed: it reaches nobody but you.'}{' '}
        Proposed by {action.requestedByType === 'HUMAN' ? 'a person' : action.requestedByType === 'WORKER' ? 'Russell' : 'Brain'}.
      </p>
    </>
  );
}

function Waiting({ actions, view, reload }: { actions: Action[]; view: ExternalView; reload(): void }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const base = `/api/projects/${view.project.id}/external/actions`;
  return (
    <section className="rs-card rs-actions-waiting">
      <h3>Waiting for your approval</h3>
      {actions.length === 0 ? (
        <p className="rs-item-meta">Nothing is waiting. Nothing reaches anybody else until a person approves it here.</p>
      ) : (
        <ul className="rs-list">
          {actions.map((action) => (
            <li key={action.id} className="rs-item">
              <ActionBody action={action} />
              <div className="rs-row">
                <button
                  type="button"
                  disabled={!view.can.approve}
                  title={view.can.approve ? undefined : NOT_ADMIN}
                  onClick={async () => {
                    setError(await post(`${base}/${action.id}/approve`));
                    reload();
                  }}
                >
                  Approve and send
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setError(await post(`${base}/${action.id}/cancel`, { reason: 'cancelled on External actions' }));
                    reload();
                  }}
                >
                  Cancel
                </button>
              </div>
              {!view.can.approve ? <p className="rs-item-meta">{NOT_ADMIN}</p> : null}
            </li>
          ))}
        </ul>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function Connections({ view, reload }: { view: ExternalView; reload(): void }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, { sender: string; self: string }>>({});
  const base = `/api/projects/${view.project.id}/external/connections`;
  return (
    <section className="rs-card rs-actions-connections">
      <h3>Connections</h3>
      <p className="rs-item-meta">
        Brain never asks for a credential here. Connecting names a deployment secret; an
        administrator sets its value in the deployment (which restarts Brain), then presses Check.
      </p>
      {view.providers.map((entry) => {
        const current = entry.current;
        const revoked = entry.history.find((one) => one.connectionState === 'REVOKED');
        const own = fields[entry.provider] ?? { sender: '', self: '' };
        return (
          <article key={entry.provider} className="rs-item">
            <h4>{entry.title}</h4>
            <p>{entry.does}</p>
            {current ? (
              <>
                <p>
                  <span className="rs-chip">{current.state.replace(/_/g, ' ').toLowerCase()}</span> {current.says}
                </p>
                {current.nextStep ? <p className="rs-item-meta">Next: {current.nextStep}</p> : null}
                <p className="rs-item-meta">
                  Deployment secret: <code>{current.secretName}</code>
                  {current.sender ? ` · sends as ${current.sender}` : ''}
                  {current.selfDestination ? ` · your own address ${current.selfDestination}` : ''}
                  {current.lastCheckedAt ? ` · last checked ${current.lastCheckedAt}` : ''}
                </p>
                <div className="rs-row">
                  <button
                    type="button"
                    disabled={!view.can.administer}
                    title={view.can.administer ? undefined : NOT_ADMIN}
                    onClick={async () => {
                      setError(await post(`${base}/${current.id}/check`));
                      reload();
                    }}
                  >
                    Check
                  </button>
                  <button
                    type="button"
                    disabled={!view.can.administer}
                    title={view.can.administer ? undefined : NOT_ADMIN}
                    onClick={async () => {
                      if (!window.confirm('Revoke this connection? Brain stops acting through it at once.')) return;
                      setError(await post(`${base}/${current.id}/revoke`, { reason: 'revoked on External actions' }));
                      reload();
                    }}
                  >
                    Revoke
                  </button>
                </div>
              </>
            ) : (
              <>
                <ol className="rs-item-meta">
                  {entry.setup.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ol>
                <p className="rs-item-meta">
                  The secret it will read: <code>{entry.secretName}</code>. {entry.secretShape}
                </p>
                {entry.provider !== 'NTFY' ? (
                  <div className="rs-row">
                    {entry.provider === 'RESEND' ? (
                      <label>
                        Send as
                        <input
                          value={own.sender}
                          placeholder="brain@your-domain"
                          onChange={(event) => setFields({ ...fields, [entry.provider]: { ...own, sender: event.target.value } })}
                        />
                      </label>
                    ) : null}
                    <label>
                      Your own address, for tests
                      <input
                        value={own.self}
                        placeholder="you@your-domain"
                        onChange={(event) => setFields({ ...fields, [entry.provider]: { ...own, self: event.target.value } })}
                      />
                    </label>
                  </div>
                ) : null}
                <button
                  type="button"
                  disabled={!view.can.administer}
                  title={view.can.administer ? undefined : NOT_ADMIN}
                  onClick={async () => {
                    setError(
                      revoked
                        ? await post(`${base}/${revoked.id}/reconnect`)
                        : await post(base, {
                            provider: entry.provider,
                            sender: own.sender || undefined,
                            selfDestination: own.self || undefined,
                          }),
                    );
                    reload();
                  }}
                >
                  {revoked ? 'Reconnect' : 'Connect'}
                </button>
                {!view.can.administer ? <p className="rs-item-meta">{NOT_ADMIN}</p> : null}
              </>
            )}
          </article>
        );
      })}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function Prepare({ view, reload }: { view: ExternalView; reload(): void }): JSX.Element {
  const [kind, setKind] = useState<Action['kind']>('NOTIFY_OWNER');
  const [destination, setDestination] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [message, setMessage] = useState<string | null>(null);
  return (
    <section className="rs-card rs-actions-prepare">
      <h3>Prepare an action</h3>
      <p className="rs-item-meta">
        Brain checks the connection, the destination and — for anybody but you — the standing
        commercial authority before anything is written. A message to your own phone is sent at
        once; everything else waits for approval.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const payload =
            kind === 'ISSUE_INVOICE'
              ? {
                  kind,
                  destination,
                  currency,
                  lines: [{ description: subject || 'Services', amountCents: Math.round(Number(amount) * 100) }],
                }
              : { kind, destination: kind === 'SEND_EMAIL' ? destination : undefined, subject, body };
          const failed = await post(`/api/projects/${view.project.id}/external/actions`, payload);
          setMessage(failed ?? 'Prepared. See below for what happened.');
          reload();
        }}
      >
        <label>
          What
          <select value={kind} onChange={(event) => setKind(event.target.value as Action['kind'])}>
            <option value="NOTIFY_OWNER">A message to my phone</option>
            <option value="SEND_EMAIL">An email</option>
            <option value="ISSUE_INVOICE">An invoice</option>
          </select>
        </label>
        {kind !== 'NOTIFY_OWNER' ? (
          <label>
            To
            <input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="name@example.com" />
          </label>
        ) : null}
        <label>
          {kind === 'ISSUE_INVOICE' ? 'Line description' : 'Subject'}
          <input value={subject} onChange={(event) => setSubject(event.target.value)} />
        </label>
        {kind === 'ISSUE_INVOICE' ? (
          <>
            <label>
              Amount
              <input value={amount} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} />
            </label>
            <label>
              Currency
              <input value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} />
            </label>
          </>
        ) : (
          <label>
            Message
            <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={4} />
          </label>
        )}
        <button type="submit" disabled={!view.can.prepare}>
          Prepare
        </button>
      </form>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}

function History({ actions, view, reload }: { actions: Action[]; view: ExternalView; reload(): void }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const base = `/api/projects/${view.project.id}/external/actions`;
  return (
    <section className="rs-card rs-actions-history">
      <h3>What happened</h3>
      {actions.length === 0 ? (
        <p className="rs-item-meta">Nothing has been sent from this project.</p>
      ) : (
        <ul className="rs-list">
          {actions.map((action) => (
            <li key={action.id} className="rs-item">
              <p>
                <span className="rs-chip">{action.state.toLowerCase()}</span> {action.expectedEffect}
              </p>
              {action.providerRef ? (
                <p className="rs-item-meta">
                  Provider’s identifier: <code>{action.providerRef}</code>
                  {action.readbackState ? ` · read back: ${action.readbackState} — ${action.readbackDetail}` : ''}
                </p>
              ) : null}
              {action.outcomeDetail ? <p className="rs-item-meta">{action.outcomeDetail}</p> : null}
              <div className="rs-row">
                {action.state === 'CONFIRMED' ? (
                  <button
                    type="button"
                    onClick={async () => {
                      setError(await post(`${base}/${action.id}/refresh`));
                      reload();
                    }}
                  >
                    Read back now
                  </button>
                ) : null}
                {action.state === 'UNCERTAIN' ? (
                  <button
                    type="button"
                    disabled={!view.can.approve}
                    title={view.can.approve ? undefined : NOT_ADMIN}
                    onClick={async () => {
                      const note = window.prompt('You checked with the provider and nothing was sent? Say how you know.');
                      if (!note) return;
                      setError(await post(`${base}/${action.id}/resolve`, { outcome: 'DID_NOT_HAPPEN', note }));
                      reload();
                    }}
                  >
                    It did not happen
                  </button>
                ) : null}
                {action.state === 'UNCERTAIN' ? (
                  <button
                    type="button"
                    disabled={!view.can.approve}
                    title={view.can.approve ? undefined : NOT_ADMIN}
                    onClick={async () => {
                      const providerRef = window.prompt('The provider’s identifier for what was sent:');
                      if (!providerRef) return;
                      setError(await post(`${base}/${action.id}/resolve`, { outcome: 'HAPPENED', providerRef, note: 'confirmed at the provider' }));
                      reload();
                    }}
                  >
                    It happened
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

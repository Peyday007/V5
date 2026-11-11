/**
 * Integrations (§103): every service Brain and its connected projects use, in
 * one place — which components use each, its health, what is missing, the
 * repairs Brain made by itself, and the only things the owner must do.
 *
 * Every word of state comes from the server's registry reading
 * (`services/integrations/health.ts`); this file renders it. No credential
 * value ever reaches this page — only setting names.
 */
import { useState } from 'react';
import { api } from '../lib/api.ts';
import { useAsync } from './useAsync.ts';
import { listState } from './present.ts';
import type { IntegrationsView as View, IntegrationState } from '../../../server/services/integrations/health.ts';

const WORDS: Record<IntegrationState, { label: string; tone: string }> = {
  CONNECTED: { label: 'Connected', tone: 'good' },
  CONFIGURED: { label: 'Configured', tone: 'good' },
  REPAIRING: { label: 'Brain is repairing', tone: 'watch' },
  NEEDS_OWNER: { label: 'Needs you', tone: 'bad' },
  REFUSED: { label: 'Refused', tone: 'bad' },
  UNREACHABLE: { label: 'Not answering', tone: 'watch' },
  NOT_IN_USE: { label: 'Not in use', tone: 'quiet' },
};

const CREDENTIAL_WORDS: Record<string, string> = {
  PRESENT: 'present',
  MISSING: 'missing',
  MALFORMED: 'malformed',
  ELSEWHERE: 'held outside this machine',
};

export function IntegrationsView(): JSX.Element {
  const [checking, setChecking] = useState(false);
  const [fresh, setFresh] = useState<View | null>(null);
  const page = useAsync(() => api<View>('/api/integrations'), []);
  const data = fresh ?? page.data;
  const state = listState({
    loading: page.loading && data === null,
    error: page.error,
    items: data ? data.integrations : null,
    noun: 'integrations',
    explanation: 'No integration is declared.',
  });

  const checkNow = async () => {
    setChecking(true);
    try {
      setFresh(await api<View>('/api/integrations/check', { method: 'POST' }));
    } finally {
      setChecking(false);
    }
  };

  const list = data?.integrations ?? [];
  const working = list.filter((one) => one.state === 'CONNECTED' || one.state === 'CONFIGURED').length;
  const inUse = list.filter((one) => one.state !== 'NOT_IN_USE').length;

  return (
    <div className="rs-column">
      <section className="rs-panel" aria-labelledby="rs-integrations-title">
        <h2 id="rs-integrations-title">Integrations</h2>
        <p className="rs-hint">
          Every connected service, which parts of Brain use it, and its health. Brain supplies missing credentials
          itself where it is authorized to; only what it cannot reach is asked of you.
        </p>
        {data ? (
          <p className="rs-lede">
            {working} of {inUse} integrations in use are working
            {data.ownerActions.length > 0 ? `; ${data.ownerActions.length} need${data.ownerActions.length === 1 ? 's' : ''} you` : ''}.{' '}
            <button type="button" className="rs-link" onClick={() => void checkNow()} disabled={checking}>
              {checking ? 'Checking…' : 'Check now'}
            </button>
          </p>
        ) : null}
        {state.phase !== 'READY' ? (
          <p className={`rs-state rs-state-${state.phase.toLowerCase()}`} role={state.phase === 'ERROR' ? 'alert' : undefined}>
            {state.message}
          </p>
        ) : null}
      </section>

      {data && data.ownerActions.length > 0 ? (
        <section className="rs-panel" aria-labelledby="rs-integrations-owner">
          <h3 id="rs-integrations-owner">What only you can do</h3>
          <ul className="rs-list">
            {data.ownerActions.map((one) => (
              <li key={one.integration}>
                <strong>{one.integration}:</strong> {one.action}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {list.map((one) => {
        const words = WORDS[one.state] ?? WORDS.CONFIGURED;
        return (
          <section key={one.id} className="rs-card" aria-label={one.name} data-integration={one.id}>
            <div className="rs-mission-head">
              <strong>{one.name}</strong>
              <span className={`rs-pill rs-pill-${words.tone}`} data-state={one.state}>
                {words.label}
              </span>
            </div>
            <p className="rs-hint">{one.purpose}</p>
            <p className="rs-item-meta">
              {one.detail}
              {one.lastCheck ? ` · checked ${one.lastCheck.recordedAt}` : ''}
              {one.dailyCeiling ? ` · at most ${one.dailyCeiling} paid calls a day` : ''}
            </p>
            <details className="rs-details">
              <summary>Used by {one.consumers.length} part{one.consumers.length === 1 ? '' : 's'} of Brain · credentials</summary>
              <ul className="rs-list">
                {one.consumers.map((c) => (
                  <li key={c.path + c.component}>
                    {c.component} <code>{c.path}</code>
                  </li>
                ))}
              </ul>
              <ul className="rs-list">
                {one.credentials.map((c) => (
                  <li key={c.name}>
                    <code>{c.name}</code> — {CREDENTIAL_WORDS[c.state] ?? c.state}
                    {c.required ? '' : ' (optional)'}
                    {c.state === 'MISSING' && c.repair ? ` · Brain supplies it (${c.repair.toLowerCase().replace('_', ' ')})` : ''}
                  </li>
                ))}
              </ul>
              <p className="rs-hint">Capabilities: {one.capabilities.join(', ')}</p>
            </details>
            {one.ownerAction ? (
              <p className="rs-state rs-state-error rs-required-action">
                <strong>You need to: </strong>
                {one.ownerAction}
              </p>
            ) : null}
          </section>
        );
      })}

      {data && data.repairs.length > 0 ? (
        <section className="rs-panel" aria-labelledby="rs-integrations-repairs">
          <h3 id="rs-integrations-repairs">Repairs Brain made</h3>
          <ul className="rs-list">
            {data.repairs.map((r) => (
              <li key={r.id}>
                {r.recordedAt} · <strong>{r.integrationId}</strong> · {r.detail}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

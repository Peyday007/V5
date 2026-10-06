/**
 * Who and what is connected — every Claude account Brain can run work on, in
 * one of six words whose remedies differ (Integration 3).
 *
 *   - Healthy                 — Brain fires it and sessions arrive.
 *   - Retrying                — held back for a moment; nobody does anything.
 *   - Reconnect required      — its authorization is genuinely gone, read from
 *                               token rows. The only state that ever asks a
 *                               person to reconnect.
 *   - Quarantined             — Brain took it out after it stopped answering.
 *   - Disabled                — turned off, retired, or bound to an identity
 *                               that cannot sign in.
 *   - Setting up              — registered, not yet usable or not yet proven.
 *
 * The word is the server's (`SurfaceReading.connection`); this file only says
 * it in English. A read that failed is shown as a temporary failure to read —
 * never as an account that needs reconnecting.
 */
import { useAsync } from './useAsync.ts';
import { listState } from './present.ts';
import { PeopleApi } from '../lib/peopleApi.ts';
import type { SurfaceConnectionState, SurfaceReading } from '../../../server/services/fleet/capacity.ts';

export const CONNECTION_WORDS: Record<SurfaceConnectionState, { label: string; tone: string; meaning: string }> = {
  HEALTHY: { label: 'Healthy', tone: 'good', meaning: 'Brain runs work here and it arrives.' },
  RETRYING: {
    label: 'Retrying',
    tone: 'watch',
    meaning: 'Held back for a moment; Brain tries again by itself. Nothing to do.',
  },
  REAUTH_REQUIRED: {
    label: 'Reconnect required',
    tone: 'bad',
    meaning: 'Its authorization is gone. The person who owns this Claude account reconnects it.',
  },
  QUARANTINED: {
    label: 'Quarantined',
    tone: 'bad',
    meaning: 'Brain stopped sending work here after it stopped answering. An operator looks at it.',
  },
  DISABLED: { label: 'Disabled', tone: 'quiet', meaning: 'Turned off; Brain sends it nothing.' },
  SETTING_UP: {
    label: 'Setting up',
    tone: 'watch',
    meaning: 'Registered, and not yet shown to finish a piece of work.',
  },
};

/**
 * The older, coarser reading, for a payload from a server that predates the
 * connection word — a cached bundle against a Brain mid-deploy must render
 * something true rather than throw.
 */
const FROM_HEALTH: Record<string, SurfaceConnectionState> = {
  HEALTHY: 'HEALTHY',
  CONFIGURING: 'SETTING_UP',
  WAITING: 'SETTING_UP',
  UNAVAILABLE: 'DISABLED',
};

export function connectionOf(surface: { connection?: SurfaceConnectionState; health: string }): SurfaceConnectionState {
  return surface.connection ?? FROM_HEALTH[surface.health] ?? 'SETTING_UP';
}

export function ConnectionWord({ state }: { state: SurfaceConnectionState }): JSX.Element {
  const words = CONNECTION_WORDS[state] ?? CONNECTION_WORDS.SETTING_UP;
  return (
    <span className={`rs-pill rs-pill-${words.tone}`} data-connection={state}>
      {words.label}
    </span>
  );
}

export function ConnectionsPanel({ onOpenPeople }: { onOpenPeople?: () => void }): JSX.Element {
  const page = useAsync(() => PeopleApi.page(), []);
  const data = page.data ?? null;
  const surfaces: SurfaceReading[] = data?.capacity.surfaces ?? [];
  const state = listState({
    loading: page.loading && data === null,
    error: page.error,
    items: data ? surfaces : null,
    noun: 'connections',
    explanation: 'No Claude account is connected to this Brain yet.',
  });

  /* Which member contributed which surface — the server's own attribution. */
  const owners = new Map(
    (data?.contributed.surfaces ?? [])
      .filter((one) => one.routineId)
      .map((one) => [one.routineId!, one]),
  );
  const byAccount = new Map<string, SurfaceReading[]>();
  for (const surface of surfaces) {
    const list = byAccount.get(surface.accountName) ?? [];
    list.push(surface);
    byAccount.set(surface.accountName, list);
  }
  const needing = surfaces.filter((one) => connectionOf(one) === 'REAUTH_REQUIRED').length;

  return (
    <section className="rs-panel rs-connections" aria-labelledby="rs-connections-title">
      <h2 id="rs-connections-title">Connections</h2>
      {data && surfaces.length > 0 ? (
        <p className="rs-lede">
          {surfaces.filter((one) => connectionOf(one) === 'HEALTHY').length} of {surfaces.length} Claude{' '}
          {surfaces.length === 1 ? 'connection is' : 'connections are'} healthy
          {needing > 0 ? `; ${needing} ${needing === 1 ? 'needs' : 'need'} reconnecting` : ''}.
        </p>
      ) : null}
      {state.phase !== 'READY' ? (
        <p className={`rs-state rs-state-${state.phase.toLowerCase()}`} role={state.phase === 'ERROR' ? 'alert' : undefined}>
          {state.message}
          {state.retryable ? (
            <button type="button" className="rs-retry" onClick={page.reload}>
              Try again
            </button>
          ) : null}
        </p>
      ) : null}
      {[...byAccount.entries()].map(([account, list]) => (
        <section key={account} className="rs-card rs-connection-account" aria-label={`Claude account ${account}`}>
          <h3>{account}</h3>
          <ul className="rs-list">
            {list.map((surface) => {
              const owner = owners.get(surface.routineId);
              return (
                <li key={surface.routineId} className="rs-connection-row">
                  <div className="rs-mission-head">
                    <strong>{surface.name}</strong>
                    <ConnectionWord state={connectionOf(surface)} />
                  </div>
                  <p className="rs-hint">
                    {surface.because ?? CONNECTION_WORDS[connectionOf(surface)].meaning}
                  </p>
                  <p className="rs-item-meta">
                    {owner ? `Connected by ${owner.displayName}` : 'Registered by an administrator'}
                    {owner?.routing
                      ? ` · serves ${owner.routing.families.map((one) => one.toLowerCase()).join(', ') || 'nothing yet'}`
                      : ''}
                    {surface.proven ? ' · has finished real work' : ' · has not finished work yet'}
                  </p>
                  {surface.detail ? (
                    <details className="rs-details">
                      <summary>Details</summary>
                      <p className="rs-hint">
                        Worker <code>{surface.detail.workerId ?? 'none'}</code> · state{' '}
                        <code>{surface.detail.state}</code> · {surface.detail.totalFires} fires,{' '}
                        {surface.detail.unansweredFires} unanswered
                        {surface.detail.lastArrivalAt ? ` · last arrived ${surface.detail.lastArrivalAt}` : ''}
                        {surface.detail.stateReason ? ` · ${surface.detail.stateReason}` : ''}
                      </p>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {onOpenPeople ? (
        <p className="rs-hint">
          <button type="button" className="rs-link" onClick={onOpenPeople}>
            People &amp; capacity
          </button>{' '}
          is where a member connects their own Claude account and an administrator invites people.
        </p>
      ) : null}
    </section>
  );
}

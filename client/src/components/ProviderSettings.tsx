/**
 * Settings → Research Providers → Antigravity.
 *
 * Everything a person needs to connect the research worker, without opening a
 * terminal: detect it, see where it is and which version, check that an account
 * is signed in, run one real job to prove it works, choose which model does
 * which kind of work, and decide whether Brain may ever spend money.
 *
 * The page is built around four separate facts rather than one green dot,
 * because each maps to a different thing the user would have to do next. And it
 * never claims more than it knows: "installed" is not "signed in", and neither
 * is "has actually done the work here" — only a passing connection test says
 * that.
 */
import { useCallback, useEffect, useState } from 'react';
import { Api, type ConnectionTestView, type ProviderConnectionView } from '../lib/api.ts';

function when(value: string | null): string {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** One of the four facts, with the answer stated rather than colour-coded. */
function Fact(props: { label: string; ok: boolean; detail: string }): JSX.Element {
  return (
    <li className={props.ok ? 'setup-steps__done' : ''}>
      <span className="setup-steps__mark">{props.ok ? '✓' : '○'}</span>
      <div>
        <strong>{props.label}</strong>
        <div className="small muted">{props.detail}</div>
      </div>
    </li>
  );
}

export function ProviderSettings(props: { provider?: string }): JSX.Element {
  const provider = props.provider ?? 'antigravity';
  const [connection, setConnection] = useState<ProviderConnectionView | null>(null);
  const [test, setTest] = useState<ConnectionTestView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [light, setLight] = useState('');
  const [strong, setStrong] = useState('');
  const [overageNote, setOverageNote] = useState('');

  const apply = useCallback((view: ProviderConnectionView): void => {
    setConnection(view);
    setLight(view.models.light ?? '');
    setStrong(view.models.strong ?? '');
    setOverageNote(view.paidOverage.note ?? '');
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      apply((await Api.providerConnection(provider)).connection);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apply, provider]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every button on this page does the same three things around one call. */
  const run = useCallback(
    async (label: string, work: () => Promise<ProviderConnectionView>): Promise<void> => {
      setBusy(label);
      setError(null);
      try {
        apply(await work());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [apply],
  );

  const runTest = useCallback(async (): Promise<void> => {
    setBusy('test');
    setError(null);
    setTest(null);
    try {
      const result = await Api.testProviderConnection(provider);
      setTest(result);
      apply(result.connection);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [apply, provider]);

  if (!connection) {
    return <div className="small muted">{error ?? 'Reading the connection…'}</div>;
  }

  const quotaTone =
    connection.quota.state === 'EXHAUSTED'
      ? 'bad'
      : connection.quota.state === 'LIMITED'
        ? 'warn'
        : connection.quota.state === 'AVAILABLE'
          ? 'ok'
          : 'muted';

  return (
    <div className="provider-settings">
      <section className="card">
        <h3>Connection</h3>
        <p className="small">{connection.message}</p>

        <ol className="setup-steps">
          <Fact
            label="Antigravity is installed"
            ok={connection.installed}
            detail={
              connection.installed
                ? `${connection.executablePath ?? 'found'}${connection.version ? ` · ${connection.version}` : ''}`
                : 'Not found on this computer.'
            }
          />
          <Fact
            label="An account is signed in"
            ok={connection.authenticated}
            detail={
              connection.authenticated
                ? 'Brain never sees your password; it only observes that you are signed in.'
                : 'Sign in inside Antigravity itself, then press Check Authentication.'
            }
          />
          <Fact
            label="This build can be driven by another program"
            ok={connection.automationReady}
            detail={
              connection.automationReady
                ? 'Brain can run a prompt without opening a window.'
                : "Brain will not drive the app's window on your behalf."
            }
          />
          <Fact
            label="A real job has actually run here"
            ok={Boolean(connection.verifiedRunAt)}
            detail={
              connection.verifiedRunAt
                ? `${connection.verifiedRunDetail ?? 'Verified.'} (${when(connection.verifiedRunAt)})`
                : 'Not yet. Press Test Connection — nothing else proves the tool works on this machine.'
            }
          />
        </ol>

        <div className="row">
          <button
            type="button"
            className="btn btn--primary btn--small"
            onClick={() => void run('detect', async () => (await Api.detectProvider(provider)).connection)}
            disabled={busy !== null}
          >
            {busy === 'detect' ? 'DETECTING…' : 'DETECT ANTIGRAVITY'}
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => void run('auth', async () => (await Api.detectProvider(provider)).connection)}
            disabled={busy !== null}
          >
            {busy === 'auth' ? 'CHECKING…' : 'CHECK AUTHENTICATION'}
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => void runTest()}
            disabled={busy !== null}
          >
            {busy === 'test' ? 'RUNNING ONE JOB…' : 'TEST CONNECTION'}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => void run('disconnect', async () => (await Api.disconnectProvider(provider)).connection)}
            disabled={busy !== null}
          >
            DISCONNECT
          </button>
        </div>

        <ul className="small muted provider-settings__next">
          {connection.remediation.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        {test ? (
          <div className={test.ok ? 'ok small' : 'error small'}>
            {test.ok ? 'Connection test passed. ' : 'Connection test failed. '}
            {test.detail}
          </div>
        ) : null}

        <div className="small muted">
          last checked {when(connection.lastCheckedAt)} · last success {when(connection.lastSuccessAt)}
          {connection.lastFailureReason ? ` · last failure: ${connection.lastFailureReason}` : ''}
        </div>
      </section>

      <section className="card">
        <h3>Allowance</h3>
        <p className={`small chip chip--${quotaTone}`}>
          {connection.quota.state} · {connection.quota.detail}
          {connection.quota.resetsAt ? ` Resets ${connection.quota.resetsAt}.` : ''}
        </p>
        <p className="small muted">
          When the allowance runs out, research pauses and keeps everything it has done — accepted
          evidence stays accepted and queued work stays queued. Running low is never a reason to
          accept weaker evidence.
        </p>

        <label className="field field--check">
          <input
            type="checkbox"
            checked={connection.paidOverage.enabled}
            disabled={busy !== null}
            onChange={(event) =>
              void run(
                'overage',
                async () =>
                  (await Api.setPaidOverage(provider, event.target.checked, overageNote.trim() || null))
                    .connection,
              )
            }
          />
          <span>
            Allow paid overages
            <span className="small muted">
              {' '}
              — off by default. With this off, Brain will never spend money: it pauses instead.
            </span>
          </span>
        </label>
        <input
          className="input"
          placeholder="Why you turned this on (recorded with the date)"
          value={overageNote}
          onChange={(event) => setOverageNote(event.target.value)}
        />
        {connection.paidOverage.setAt ? (
          <div className="small muted">
            Last changed {when(connection.paidOverage.setAt)}
            {connection.paidOverage.note ? ` — ${connection.paidOverage.note}` : ''}
          </div>
        ) : null}
      </section>

      <section className="card">
        <h3>Models</h3>
        <p className="small muted">
          Broad discovery and extraction go to the lighter model; contradictions, difficult
          investigation and synthesis go to the stronger one. The evidence bar does not follow the
          model — a cheap job that comes back weak is repaired on the stronger one, never accepted
          because it was cheap.
        </p>
        <div className="row">
          <label className="field">
            <span>Light model</span>
            <input
              className="input"
              value={light}
              placeholder="left to the tool's default"
              onChange={(event) => setLight(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Strong model</span>
            <input
              className="input"
              value={strong}
              placeholder="left to the tool's default"
              onChange={(event) => setStrong(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn--small"
            disabled={busy !== null}
            onClick={() =>
              void run(
                'models',
                async () =>
                  (
                    await Api.setProviderModels(provider, {
                      light: light.trim() || null,
                      strong: strong.trim() || null,
                    })
                  ).connection,
              )
            }
          >
            {busy === 'models' ? 'SAVING…' : 'SAVE MODELS'}
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Diagnostics</h3>
        <p className="small muted">
          What Brain found, in the order it looked. Credentials, environment and raw tool output
          stay on your machine and are never shown here or sent anywhere.
        </p>
        <table className="table table--compact">
          <tbody>
            {connection.diagnostics.map((entry) => (
              <tr key={entry.stage}>
                <th scope="row">{entry.stage}</th>
                <td className="small">{entry.result}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">
          <strong>Terminal path:</strong> {connection.pty.detail}
        </p>
      </section>

      {error ? <div className="error small">{error}</div> : null}
    </div>
  );
}

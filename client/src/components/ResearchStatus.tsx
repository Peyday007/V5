/**
 * Whether Brain can run research for you, said plainly (sections 1 and 7).
 *
 * This replaces the old `providers: mock` line, which was true in a way nobody
 * could act on. The chip states one of four things — connected, setup required,
 * quota limited, unavailable — and opening it explains what to do next in
 * sentences, not commands.
 *
 * Two rules govern everything here. It never tells the user to operate a
 * terminal during normal use: signing in happens in Antigravity's own window,
 * and installing happens once from a download link. And it never presents the
 * offline mock as though it were real research — when automation is unavailable
 * it says the work stays manual, which is the honest description of the
 * copy-the-prompt workflow.
 */
import { useCallback, useEffect, useState } from 'react';
import { Api, type ResearchProviderStatusView } from '../lib/api.ts';

type Tone = 'ok' | 'warn' | 'bad' | 'muted';

interface Summary {
  label: string;
  tone: Tone;
  /** The single thing to do next, or null when nothing is required. */
  action: string | null;
}

/**
 * Reduce the four facts to the one that blocks progress.
 *
 * Order matters: it reports the earliest unmet condition, because that is the
 * one the user has to deal with first. Telling somebody their quota is unknown
 * when the app is not even installed would be true and useless.
 */
function summarize(status: ResearchProviderStatusView | null): Summary {
  if (!status) return { label: 'CHECKING…', tone: 'muted', action: null };
  if (!status.installed) {
    return { label: 'SETUP REQUIRED', tone: 'warn', action: 'Install Antigravity' };
  }
  if (!status.automationReady) {
    return { label: 'UNAVAILABLE', tone: 'bad', action: 'No automatic mode in this version' };
  }
  if (!status.authenticated) {
    return { label: 'SETUP REQUIRED', tone: 'warn', action: 'Connect your Google account' };
  }
  if (status.quotaState === 'exhausted') {
    return { label: 'QUOTA USED UP', tone: 'bad', action: 'Wait for the allowance to reset' };
  }
  if (status.quotaState === 'limited') {
    return { label: 'QUOTA LIMITED', tone: 'warn', action: null };
  }
  return { label: 'CONNECTED', tone: 'ok', action: null };
}

/** The setup steps, chosen by what the probe actually found. */
function steps(status: ResearchProviderStatusView): { title: string; body: string; done: boolean }[] {
  return [
    {
      title: 'Install Antigravity',
      body: 'Download and install it like any other program. Brain finds it by itself afterwards — there is nothing to configure.',
      done: status.installed,
    },
    {
      title: 'Sign in to Google in Antigravity',
      body: 'Open Antigravity and sign in there. Brain never asks for your password and never sees it.',
      done: status.authenticated,
    },
    {
      title: 'Come back and press Check connection',
      body: 'Brain re-checks and tells you what it found. Nothing else is needed.',
      done: status.installed && status.authenticated && status.automationReady,
    },
  ];
}

export function ResearchStatus(props: { onChanged?: (s: ResearchProviderStatusView) => void }): JSX.Element {
  const { onChanged } = props;
  const [status, setStatus] = useState<ResearchProviderStatusView | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await Api.researchStatus();
      setStatus(result.status);
      onChanged?.(result.status);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onChanged]);

  useEffect(() => {
    void load();
  }, [load]);

  const check = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await Api.checkResearchConnection();
      setStatus(result.status);
      onChanged?.(result.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [onChanged]);

  const summary = summarize(status);

  return (
    <div className="research-status">
      <button
        type="button"
        className={`chip chip--${summary.tone}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={status?.message ?? 'Checking what research automation is available'}
      >
        RESEARCH: {summary.label}
        {summary.action ? <span className="chip__action"> · {summary.action}</span> : null}
        <span className="chip__caret">{open ? '▾' : '▸'}</span>
      </button>

      {open && status ? (
        <div className="research-drawer card">
          <p className="small">{status.message}</p>

          <ol className="setup-steps">
            {steps(status).map((step) => (
              <li key={step.title} className={step.done ? 'setup-steps__done' : ''}>
                <span className="setup-steps__mark">{step.done ? '✓' : '○'}</span>
                <div>
                  <strong>{step.title}</strong>
                  <div className="small muted">{step.body}</div>
                </div>
              </li>
            ))}
          </ol>

          <div className="row">
            <button type="button" className="btn btn--primary btn--small" onClick={() => void check()} disabled={busy}>
              {busy ? 'CHECKING…' : 'CHECK CONNECTION'}
            </button>
            {status.version ? <span className="small mono muted">{status.version}</span> : null}
            <span className="small muted">
              last checked {new Date(status.lastCheckedAt).toLocaleTimeString()}
            </span>
          </div>

          {!status.installed || !status.automationReady ? (
            <p className="small muted">
              Nothing is blocked in the meantime. Research stays manual: use GENERATE PROMPT, run
              it wherever you like, and import the report back. Brain audits it either way.
            </p>
          ) : null}

          {error ? <div className="error small">{error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

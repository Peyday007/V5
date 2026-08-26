/**
 * The application shell: it owns every piece of shared state and is the only
 * component that decides what "now" looks like.
 *
 * The contract with the children is deliberately blunt — each of them calls
 * `onChanged()` after a mutation and this component re-fetches the project
 * detail (project + layers + derived state + plan) in one request. There is no
 * client-side cache to invalidate and no optimistic update to reconcile,
 * because the server has just recomputed the truth and the user must never have
 * to wonder whether the screen is stale.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Layer,
  LayerStateSnapshot,
  PlannerItem,
  PlannerResult,
  Project,
  ReconcileIssue,
  ReconcileReport,
} from '../../server/domain/types.ts';
import type { HealthResponse, SessionUser } from './lib/api.ts';
import { Api, ApiError } from './lib/api.ts';
import { SignIn } from './components/SignIn.tsx';
import { Pill } from './components/Badge.tsx';
import { ImportPanel } from './components/ImportPanel.tsx';
import { SourceReview } from './components/SourceReview.tsx';
import { LayerDetail } from './components/LayerDetail.tsx';
import { LayerList } from './components/LayerList.tsx';
import { Modal } from './components/Modal.tsx';
import { PlannerPane } from './components/PlannerPane.tsx';
import { ProviderSettings } from './components/ProviderSettings.tsx';
import { TopBar } from './components/TopBar.tsx';

type BannerTone = 'info' | 'ok' | 'warn' | 'bad';

interface Banner {
  tone: BannerTone;
  text: string;
  action?: PlannerItem | null;
}

/** Turn anything thrown by `fetch`/the API into one readable sentence. */
function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status > 0 ? `${error.message} (HTTP ${error.status})` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Decide whether the server is healthy enough to render a project. A migration
 * that did not apply is a hard stop: every screen below reads derived state, and
 * derived state from a half-migrated database is worse than no screen at all.
 */
function healthProblem(health: HealthResponse): string | null {
  if (health.ok === false) {
    return typeof health.error === 'string' && health.error
      ? health.error
      : 'The server reported that it is not healthy.';
  }
  if (typeof health.schemaVersion === 'number' && health.schemaVersion < 1) {
    return 'The database reports schema version 0 — the migrations in server/db/migrations did not apply.';
  }
  return null;
}

function summariseMigrations(health: HealthResponse | null): string {
  if (!health) return '';
  const lines = [
    `driver:        ${health.driver}`,
    `schema:        v${health.schemaVersion}`,
    `database:      ${health.databasePath}`,
    `data root:     ${health.dataRoot}`,
  ];
  const report = health.migrations;
  if (report) {
    lines.push(`applied now:   ${report.applied.length}`);
    lines.push(`already applied: ${report.alreadyApplied}`);
    for (const applied of report.applied) {
      lines.push(`  ${applied.version} ${applied.name} (${applied.durationMs}ms)`);
    }
    if (report.backupPath) lines.push(`backup:        ${report.backupPath}`);
  }
  return lines.join('\n');
}

export default function App(): JSX.Element {
  /**
   * Who is signed in, as far as this tab knows.
   *
   * `undefined` means "not asked yet", which is a third state and a necessary
   * one: rendering the sign-in form while the answer is still in flight makes
   * every reload flash a login screen at somebody who is already signed in.
   */
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [layerState, setLayerState] = useState<LayerStateSnapshot[]>([]);
  const [plan, setPlan] = useState<PlannerResult | null>(null);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reconcileReport, setReconcileReport] = useState<ReconcileReport | null>(null);
  const [layerReloadKey, setLayerReloadKey] = useState(0);

  const projectIdRef = useRef<string | null>(null);
  const bootedRef = useRef(false);

  const loadProject = useCallback(async (projectId: string): Promise<void> => {
    const detail = await Api.project(projectId);
    projectIdRef.current = detail.project.id;
    setProject(detail.project);
    setLayers(detail.layers);
    setLayerState(detail.state);
    setPlan(detail.plan);
    setSelectedLayerId((current) => {
      if (current && detail.layers.some((layer) => layer.id === current)) return current;
      return detail.layers[0]?.id ?? null;
    });
  }, []);

  /** Re-read derived project state. Cheap, and the only cache invalidation we have. */
  const refreshProject = useCallback(async (): Promise<void> => {
    const projectId = projectIdRef.current;
    if (!projectId) return;
    try {
      await loadProject(projectId);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [loadProject]);

  /** Refresh everything, including the layer pane, after a change made elsewhere. */
  const refresh = useCallback(async (): Promise<void> => {
    await refreshProject();
    setLayerReloadKey((key) => key + 1);
  }, [refreshProject]);

  const boot = useCallback(async (): Promise<void> => {
    setLoading(true);
    setBootError(null);
    try {
      const info = await Api.health();
      setHealth(info);
      const problem = healthProblem(info);
      if (problem) {
        setBootError(problem);
        return;
      }
      const { projects } = await Api.projects();
      const first = projects[0];
      if (!first) {
        setBootError(
          'The server is healthy but no project exists. Restart the server so the Deal Dispatch seed runs, ' +
            'or create a project with POST /api/projects.',
        );
        return;
      }
      await loadProject(first.id);
      setBootError(null);
    } catch (err) {
      setHealth(null);
      setBootError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [loadProject]);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void (async (): Promise<void> => {
      // Who am I, before anything else. Every other call below is behind the
      // gate, so asking them first would just produce a 401 and a misleading
      // "cannot reach the server".
      let session: Awaited<ReturnType<typeof Api.session>>;
      try {
        session = await Api.session();
      } catch (err) {
        setUser(null);
        setBootError(describeError(err));
        setLoading(false);
        return;
      }
      setUser(session.user);
      if (!session.authenticated || session.user?.mustChangePassword) {
        setLoading(false);
        return;
      }
      await boot();
    })();
  }, [boot]);

  /**
   * Signed in — or finished choosing a password.
   *
   * The project is only loaded once the account is fully usable; an account
   * that still owes a password change is refused by the server for everything
   * except the change itself, so fetching a project here would produce a 403
   * behind the form.
   */
  const handleSignedIn = useCallback(
    (signedIn: SessionUser): void => {
      setUser(signedIn);
      setBootError(null);
      if (signedIn.mustChangePassword) return;
      setLoading(true);
      void boot();
    },
    [boot],
  );

  const handleSignOut = useCallback((): void => {
    void (async (): Promise<void> => {
      try {
        await Api.logout();
      } finally {
        // Whatever the server said, this tab is done: the cookie is gone or the
        // session is revoked, and continuing to render a project would be
        // showing state nobody can refresh.
        setUser(null);
        setProject(null);
        setLayers([]);
        setPlan(null);
        bootedRef.current = false;
      }
    })();
  }, []);

  const handleChanged = useCallback((): void => {
    void refresh();
  }, [refresh]);

  const handleLayerChanged = useCallback((): void => {
    // The layer pane has already re-fetched itself; only the shared state is stale.
    void refreshProject();
  }, [refreshProject]);

  const handleSelectLayer = useCallback((layerId: string): void => {
    setSelectedLayerId(layerId);
  }, []);

  const handleRefreshClick = useCallback((): void => {
    setBusy(true);
    void refresh().finally(() => setBusy(false));
  }, [refresh]);

  /** WHAT NEXT? — one derived sentence, shown where the user cannot miss it. */
  const handleWhatNext = useCallback(async (): Promise<void> => {
    const projectId = projectIdRef.current;
    if (!projectId) return;
    setBusy(true);
    try {
      const answer = await Api.nextAction(projectId);
      const text = answer.text.trim() || 'There is no next action: every layer is frozen or parked.';
      setBanner({ tone: answer.action ? 'info' : 'ok', text, action: answer.action });
      await refreshProject();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [refreshProject]);

  /** SCAN & RECONCILE — compare the database with the project folder. */
  const handleReconcile = useCallback(async (): Promise<void> => {
    const projectId = projectIdRef.current;
    if (!projectId) return;
    setBusy(true);
    try {
      const { report } = await Api.reconcile(projectId);
      setReconcileReport(report);
      setReconcileOpen(true);
      const issues = report.issues.length;
      setBanner({
        tone: issues === 0 ? 'ok' : 'warn',
        text:
          issues === 0
            ? `Scan complete: ${report.scannedFiles} file(s) on disk, ${report.registeredDocuments} registered document(s), no issues.`
            : `Scan complete: ${issues} issue(s) found across ${report.scannedFiles} file(s). Resolve them before trusting layer state.`,
      });
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const handleFixIssue = useCallback(
    async (issue: ReconcileIssue): Promise<void> => {
      const projectId = projectIdRef.current;
      if (!projectId) return;
      setBusy(true);
      try {
        const response = await Api.reconcileFix(projectId, {
          kind: issue.kind,
          path: issue.path,
          documentId: issue.documentId,
        });
        setReconcileReport(response.report);
        setBanner({
          tone: response.ok ? 'ok' : 'bad',
          text: response.message,
        });
        await refresh();
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const bannerAction = banner?.action ?? null;

  // Still asking.
  if (user === undefined) {
    return <div className="app app--booting">Loading…</div>;
  }

  // Not signed in, or signed in with a password that is not yet theirs. Both
  // are the sign-in screen's business, and neither renders any project data —
  // there is none in this component to render, because nothing was fetched.
  if (user === null || user.mustChangePassword) {
    return <SignIn onSignedIn={handleSignedIn} pendingUser={user} />;
  }

  return (
    <div className="app">
      <TopBar
        project={project}
        plan={plan}
        health={health}
        user={user}
        onSignOut={handleSignOut}
        onImport={() => setImportOpen(true)}
        onSources={() => setSourcesOpen(true)}
        onWhatNext={() => void handleWhatNext()}
        onReconcile={() => void handleReconcile()}
        onSettings={() => setSettingsOpen(true)}
        onRefresh={handleRefreshClick}
        busy={busy || loading}
      />

      {banner ? (
        <div className={`banner banner--${banner.tone}`}>
          <div className="banner__text">{banner.text}</div>
          <div className="row">
            {bannerAction ? (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => handleSelectLayer(bannerAction.layerId)}
              >
                GO TO {bannerAction.layerName.toUpperCase()}
              </button>
            ) : null}
            <button type="button" className="btn btn--ghost" onClick={() => setBanner(null)}>
              DISMISS
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="error spread">
          <span>{error}</span>
          <button type="button" className="btn btn--ghost" onClick={() => setError(null)}>
            DISMISS
          </button>
        </div>
      ) : null}

      {bootError ? (
        <main className="boot-error">
          <h1>BRAIN COULD NOT START</h1>
          <p className="boot-error__reason">{bootError}</p>
          <p>
            The interface refuses to render project state it could not verify, so nothing below is
            shown until the server answers <span className="mono">/api/health</span>.
          </p>
          <ol className="boot-error__steps">
            <li>
              Start the API server: <span className="mono">npm run dev</span> (server + client) or{' '}
              <span className="mono">npm run dev:server</span>. The client proxies{' '}
              <span className="mono">/api</span> to it.
            </li>
            <li>
              Read the server terminal. A migration failure stops boot on purpose — applied
              migrations are checksum-locked, so an edited{' '}
              <span className="mono">server/db/migrations/*.sql</span> must be restored, and a schema
              change must be added as a NEW numbered migration file.
            </li>
            <li>
              If the database is from an abandoned experiment, run{' '}
              <span className="mono">npm run db:reset</span> and restart. This deletes only{' '}
              <span className="mono">data/brain.db</span>; your imported files stay on disk and can
              be re-registered with SCAN &amp; RECONCILE.
            </li>
            <li>Then press RETRY. No manual SQL is ever required.</li>
          </ol>
          {health ? <pre className="pre">{summariseMigrations(health)}</pre> : null}
          <button type="button" className="btn btn--primary" onClick={() => void boot()} disabled={loading}>
            RETRY
          </button>
        </main>
      ) : (
        <main className="panes">
          <section className="pane pane--left">
            <div className="pane__header">
              <span>LAYERS</span>
              <span className="muted mono">{layers.length}</span>
            </div>
            <div className="pane__body">
              {loading && layers.length === 0 ? (
                <div className="empty">Loading project…</div>
              ) : (
                <LayerList
                  project={project}
                  layers={layers}
                  state={layerState}
                  selectedLayerId={selectedLayerId}
                  onSelect={handleSelectLayer}
                />
              )}
            </div>
          </section>

          <section className="pane pane--center">
            <div className="pane__header">
              <span>LAYER WORKFLOW</span>
            </div>
            <div className="pane__body">
              <LayerDetail
                // Keyed on the layer alone: switching layers should reset the
                // pane, but a refresh should only re-fetch it.
                key={selectedLayerId ?? 'none'}
                layerId={selectedLayerId}
                layers={layers}
                onChanged={handleLayerChanged}
                onSelectLayer={handleSelectLayer}
                reloadKey={layerReloadKey}
              />
            </div>
          </section>

          <section className="pane pane--right">
            <div className="pane__header">
              <span>MASTER PLANNER</span>
            </div>
            <div className="pane__body">
              <PlannerPane
                plan={plan}
                onSelectLayer={handleSelectLayer}
                projectId={project?.id ?? null}
                onChanged={handleChanged}
              />
            </div>
          </section>
        </main>
      )}

      <Modal
        title="SETTINGS · RESEARCH PROVIDERS · ANTIGRAVITY"
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        footer={
          <span className="muted">
            Brain drives Antigravity as its research worker. Once it is installed and signed in,
            nothing here needs a terminal.
          </span>
        }
      >
        <ProviderSettings />
      </Modal>

      <ImportPanel
        projectId={project?.id ?? null}
        layers={layers}
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onChanged={handleChanged}
      />

      <SourceReview
        projectId={project?.id ?? null}
        layers={layers}
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
        onChanged={handleChanged}
      />

      <Modal
        title="SCAN & RECONCILE"
        open={reconcileOpen}
        onClose={() => setReconcileOpen(false)}
        footer={
          <>
            <span className="muted">
              A file on disk is not a document until it is registered; a row whose file vanished is
              not a document either.
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => void handleReconcile()}
              disabled={busy}
            >
              SCAN AGAIN
            </button>
          </>
        }
      >
        {reconcileReport ? (
          <div className="stack">
            <div className="row">
              <Pill label="SCANNED" value={reconcileReport.scannedFiles} />
              <Pill label="REGISTERED" value={reconcileReport.registeredDocuments} />
              <Pill
                label="ISSUES"
                value={reconcileReport.issues.length}
                tone={reconcileReport.issues.length ? 'bad' : 'ok'}
              />
              <span className="muted mono">{reconcileReport.generatedAt}</span>
            </div>
            {reconcileReport.issues.length === 0 ? (
              <div className="empty">
                Database and filesystem agree. Every registered document has its file and every file
                under this project is registered.
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>ISSUE</th>
                    <th>TARGET</th>
                    <th>DETAIL</th>
                    <th>SUGGESTED FIX</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {reconcileReport.issues.map((issue, index) => (
                    <tr key={`${issue.kind}:${issue.path ?? issue.documentId ?? index}`}>
                      <td className="nowrap">
                        <span className={issue.kind === 'UNREGISTERED_FILE' ? 'warn' : 'bad'}>
                          {issue.kind.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="mono">{issue.path ?? issue.canonicalName ?? issue.documentId}</td>
                      <td>{issue.detail}</td>
                      <td className="muted">{issue.suggestedFix}</td>
                      <td>
                        {issue.fixable ? (
                          <button
                            type="button"
                            className="btn btn--small"
                            disabled={busy}
                            onClick={() => void handleFixIssue(issue)}
                          >
                            FIX
                          </button>
                        ) : (
                          <span className="muted">manual</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <div className="empty">No scan has been run yet.</div>
        )}
      </Modal>
    </div>
  );
}

/**
 * Build: the factory, as a person uses it.
 *
 * One screen, and the shape of it is the specification. A person says what
 * should become true, picks one of the repositories this factory is allowed to
 * work in, and approves. Everything after that is the factory's: decomposition,
 * worker count, branches, retries, integration order, review rounds and repairs
 * have no control here, because none of them is a decision a person should be
 * asked to take.
 *
 * Two things it deliberately is not. It is not an administration page — the two
 * decisions it offers are the two the server guards by principal type, and
 * nothing else. And it is not optimistic: a campaign's stage, its blocker and
 * its pull request are whatever the server says they are on this read, and the
 * four states of a read — loading, empty, forbidden, error — are four different
 * screens.
 */
import { useCallback, useEffect, useState } from 'react';
import { listState } from './present.ts';
import { useAsync } from './useAsync.ts';
import { FactoryApi } from '../lib/factoryApi.ts';
import type {
  FactoryCampaign,
  FactoryChangeRequest,
  FactoryInvitations,
  FactoryInvitationView,
  FactoryRelease,
  FactoryAllocation,
  FactoryLine,
  IssuedFactoryInvitation,
  OnboardResult,
  RepositoryOnboarding,
  SubmitResponse,
} from '../lib/factoryApi.ts';

export function BuildView({ projectId }: { projectId: string | null }): JSX.Element {
  const repositories = useAsync(
    () =>
      projectId
        ? FactoryApi.repositories(projectId)
        : Promise.resolve({
            repositories: [] as RepositoryOnboarding[],
            mayConnectAccounts: false,
            connectAccountsRefusal: null as string | null,
          }),
    [projectId],
  );
  const campaigns = useAsync(
    () =>
      projectId
        ? FactoryApi.campaigns(projectId)
        : Promise.resolve({ campaigns: [] as FactoryCampaign[] }),
    [projectId],
  );
  const requests = useAsync(
    () =>
      projectId
        ? FactoryApi.changeRequests(projectId)
        : Promise.resolve({ changeRequests: [] as FactoryChangeRequest[] }),
    [projectId],
  );

  /*
   * A refresh must not blank a card that is already showing something.
   *
   * `loading` is true both when there is nothing yet and when the list is being
   * read again, and treating the second one as "not ready" unmounted this whole
   * section — which took the invitation *shown once* down with it, on the very
   * reload that pressing the button triggers. A person would have completed the
   * onboarding and never seen the link. So loading is a phase only while there
   * is nothing to show; a re-read leaves the previous answer up until the new
   * one arrives.
   */
  const shown = repositories.data?.repositories ?? null;
  const state = listState({
    loading: repositories.loading && shown === null,
    error: repositories.error,
    items: shown,
    noun: 'repositories this factory may work in',
  });

  return (
    <section className="rs-view rs-view-build">
      <h2>Build</h2>
      <p className="rs-lede">
        Say what should become true in one of these repositories. The factory plans it, writes
        it, brings it together, has a session that did not write it review it, repairs what the
        review finds, and stops at a pull request for you to read. It never merges and it never
        deploys.
      </p>

      {projectId ? <Line key={`line-${projectId}`} projectId={projectId} /> : null}

      {state.phase !== 'READY' ? (
        <p className={`rs-state rs-state-${state.phase.toLowerCase()}`}>
          {state.message}
          {state.retryable ? (
            <button type="button" onClick={repositories.reload}>
              Try again
            </button>
          ) : null}
        </p>
      ) : (
        <>
          {/*
            * Keyed by the project, which is the other half of that decision: a
            * re-read of the same project keeps what is on screen, and a change
            * of project throws it away. An invitation belongs to the project it
            * was issued for and must never outlive it on screen.
            */}
          <Repositories
            key={projectId ?? 'none'}
            projectId={projectId}
            repositories={state.items}
            mayConnectAccounts={repositories.data?.mayConnectAccounts === true}
            connectAccountsRefusal={
              repositories.data?.connectAccountsRefusal ??
              'This control was not offered by the server.'
            }
            onChanged={repositories.reload}
          />
          <Allocation
            key={`allocation-${projectId ?? 'none'}`}
            projectId={projectId}
            allocation={repositories.data?.allocation ?? null}
            loading={repositories.loading}
            error={repositories.error}
            onReload={repositories.reload}
          />
          <Submit
            projectId={projectId}
            repositories={state.items}
            onStarted={() => {
              campaigns.reload();
              requests.reload();
            }}
          />
        </>
      )}

      <Campaigns
        campaigns={campaigns.data?.campaigns ?? null}
        loading={campaigns.loading}
        error={campaigns.error}
        onReload={campaigns.reload}
      />

      <Unapproved
        requests={requests.data?.changeRequests ?? []}
        campaigns={campaigns.data?.campaigns ?? []}
        onApproved={() => {
          campaigns.reload();
          requests.reload();
        }}
      />
    </section>
  );
}

/** How long, in words a person reads at a glance. */
function duration(ms: number | null): string {
  if (ms === null) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * The production line: whether the factory is moving, and if not, why.
 *
 * Read again every twenty seconds, which is the remote loop's own tick, so the
 * panel is never staler than the thing it describes by more than one pass. A
 * re-read leaves the previous answer up until the new one arrives, for the same
 * reason the repository list does. Nothing here is a control: admission is set
 * on a terminal and approving stays on the objective's own card.
 */
function Line({ projectId }: { projectId: string }): JSX.Element {
  const line = useAsync(() => FactoryApi.line(projectId), [projectId]);
  const { reload } = line;
  useEffect(() => {
    const timer = setInterval(reload, 20_000);
    return () => clearInterval(timer);
  }, [reload]);
  const data: FactoryLine | null = line.data ?? null;

  if (!data) {
    return (
      <section className="rs-card rs-factory-line">
        <h3>Production line</h3>
        <p className="rs-hint">{line.error ? `Could not read the line: ${line.error.message}` : 'Reading the line…'}</p>
      </section>
    );
  }

  const active = data.campaigns.filter((row) => row.working && !row.blocked);
  const blocked = data.campaigns.filter((row) => row.blocked);
  const waiting = data.campaigns.filter((row) => !row.working && !row.blocked);
  return (
    <section className="rs-card rs-factory-line">
      <h3>Production line</h3>
      <dl className="rs-line-headline">
        <div><dt>Auto</dt><dd>{data.auto ? `ON — up to ${data.policy.maxActive} at once` : 'OFF'}</dd></div>
        <div><dt>Executable backlog</dt><dd>{data.executable.total}</dd></div>
        <div><dt>Active</dt><dd>{data.active.leasedBins} running, {data.active.arriving} arriving</dd></div>
        <div><dt>Available capacity</dt><dd>{data.capacity.freeSurfaces} free surface(s)</dd></div>
        <div>
          <dt>Unexplained idle</dt>
          <dd className={data.unexplainedIdle ? 'rs-line-fault' : undefined}>{data.unexplainedIdle ? 'YES — a fault' : 'no'}</dd>
        </div>
      </dl>
      <p className="rs-hint">{data.because}</p>

      <h4>Active builds</h4>
      {active.length === 0 ? <p className="rs-hint">None.</p> : (
        <ul className="rs-line-list">
          {active.map((row) => {
            const bin = row.bins.find((one) => one.state === 'LEASED') ?? row.bins[0] ?? null;
            return (
              <li key={row.campaign.id}>
                <strong>{row.objective.slice(0, 140)}</strong>
                <p className="rs-item-meta">
                  {row.campaign.state.toLowerCase()} · {bin ? `${bin.kind.toLowerCase()} ${bin.state.toLowerCase()}` : 'no stage bin yet'}
                  {bin?.lastRoutine ? ` · on ${bin.lastRoutine}` : ''}
                  {bin?.sessionRef ? ` · session ${bin.sessionRef}` : ''}
                  {` · ${duration(row.elapsedMs)}`}
                </p>
                <p className="rs-item-meta">Next: {row.next}</p>
              </li>
            );
          })}
        </ul>
      )}

      <h4>Queued builds</h4>
      {data.queue.length === 0 ? <p className="rs-hint">Nothing is queued.</p> : (
        <ol className="rs-line-list">
          {data.queue.map((row) => (
            <li key={row.entry.id}>
              <strong>{row.objective.slice(0, 140)}</strong>
              <p className="rs-item-meta">
                {row.executableNow ? 'Starts on the next pass. ' : 'Waiting. '}
                {row.why}
              </p>
            </li>
          ))}
        </ol>
      )}

      <h4>Blocked builds</h4>
      {blocked.length === 0 ? <p className="rs-hint">None.</p> : (
        <ul className="rs-line-list">
          {blocked.map((row) => (
            <li key={row.campaign.id}>
              <strong>{row.objective.slice(0, 140)}</strong>
              <p className="rs-item-meta">
                {row.blocked!.wait === 'PERSON' ? 'Needs you' : 'Waiting automatically'} · {row.blocked!.kind}
                {row.blocked!.detail ? ` — ${row.blocked!.detail}` : ''}
              </p>
              <p className="rs-item-meta">{row.blocked!.remedy}</p>
            </li>
          ))}
        </ul>
      )}
      {waiting.length > 0 ? (
        <p className="rs-hint">
          {waiting.length} other campaign(s) are live and hold no slot.
        </p>
      ) : null}

      <h4>Capacity</h4>
      {data.capacity.surfaces.length === 0 ? <p className="rs-hint">No Factory surface is registered.</p> : (
        <ul className="rs-line-list">
          {data.capacity.surfaces.map((surface) => (
            <li key={`${surface.accountName}-${surface.routineName}`}>
              <strong>{surface.routineName}</strong> ({surface.accountName})
              <p className="rs-item-meta">
                {surface.inFlight} of {surface.target ?? 'no target'} in flight
                {surface.capabilities.includes('repository-write') ? ' · can push' : ' · read only'}
                {' · '}{surface.free ? 'free' : surface.refusal ?? 'at its target'}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Which Factory account gets the next task, and what each has done.
 *
 * Every sentence about the choice is the router's own (`explanation`); the
 * card composes none. Measured activity and a reported allowance are labelled
 * as what they are, because a percentage a person typed in and a count Brain
 * recorded are different kinds of fact.
 */
function Allocation({ projectId, allocation: initial, loading, error, onReload }: {
  projectId: string | null;
  allocation: FactoryAllocation | null;
  loading: boolean;
  error: { status: number; message: string } | null;
  onReload(): void;
}): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [tested, setTested] = useState<{ view: FactoryAllocation; at: string } | null>(null);
  const [testing, setTesting] = useState(false);
  // A test result is newer than what the repository list carried until that
  // list is read again, which a report or a reload does.
  useEffect(() => { setTested(null); }, [initial]);
  const allocation = tested?.view ?? initial;

  async function test(): Promise<void> {
    if (!projectId) return;
    setTesting(true);
    setProblem(null);
    try {
      const view = await FactoryApi.allocation(projectId);
      setTested({ view, at: new Date().toLocaleTimeString() });
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'Could not read the routing choice.');
    } finally {
      setTesting(false);
    }
  }

  async function report(accountId: string): Promise<void> {
    const raw = (values[accountId] ?? '').trim();
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > 100 || !projectId) {
      setProblem('Enter a whole percentage from 0 to 100.');
      return;
    }
    setBusy(accountId);
    setProblem(null);
    try {
      await FactoryApi.reportAllowance(projectId, accountId, Number(raw));
      setValues((prior) => ({ ...prior, [accountId]: '' }));
      onReload();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'Could not save that reading.');
    } finally {
      setBusy(null);
    }
  }

  const hours = allocation?.reportExpiresAfterHours ?? 6;
  return (
    <section className="rs-card rs-factory-allocation">
      <h3>Factory account allocation</h3>
      <p className="rs-hint">
        Brain chooses an eligible account for each new Factory task by itself. Fires, arrivals and
        provider refusals are measured by Brain; they are not a subscription balance. A remaining
        percentage is <em>reported</em> by a person from the account holder’s Claude usage screen
        and stops counting after {hours} hours. When every eligible account has a fresh report,
        Brain prefers the one with more remaining; otherwise it uses measured headroom. Cooldowns,
        account health and concurrency limits always decide first.
      </p>
      <button type="button" onClick={() => { void test(); }} disabled={testing || !projectId}>
        {testing ? 'Testing…' : 'Test next routing choice'}
      </button>
      <p className="rs-hint">
        This asks the dispatcher’s own routing decision. It does not fire a Routine.
        {tested ? ` Tested at ${tested.at}.` : ''}
      </p>
      {loading && !allocation ? <p className="rs-hint">Reading Factory capacity…</p> : null}
      {error && !allocation ? (
        <p role="alert">
          Could not read allocation: {error.message}{' '}
          <button type="button" onClick={onReload}>Try again</button>
        </p>
      ) : null}
      {problem ? <p role="alert">{problem}</p> : null}
      {allocation?.repositories.map((repo) => (
        <div className="rs-allocation-repository" key={repo.grantId}>
          <h4>{repo.remote.replace('https://github.com/', '')}</h4>
          {repo.accounts.length === 0 ? (
            <p className="rs-hint">No Factory account can take work for this repository in this project yet.</p>
          ) : (
            <>
              <p>
                Next task goes to:{' '}
                <strong>
                  {repo.accounts.find((account) => account.id === repo.nextAccountId)?.name ??
                    'nobody right now'}
                </strong>
              </p>
              <p className="rs-hint">{repo.explanation}</p>
              <ul className="rs-allocation-accounts">
                {repo.accounts.map((account) => (
                  <li key={account.id}>
                    <strong>{account.name}</strong>
                    {account.id === repo.nextAccountId ? ' (next)' : ''}
                    <div>
                      Reported remaining:{' '}
                      {account.remainingPercent === null
                        ? 'not reported'
                        : `${account.remainingPercent}%${account.reportFresh ? '' : ` (older than ${hours} hours, not used)`}`}
                      {account.reportedAt ? `, reported ${new Date(account.reportedAt).toLocaleString()}` : ''}
                    </div>
                    <div className="rs-hint">
                      Measured, last {allocation.windowHours} hours in this project: {account.fires} fires,{' '}
                      {account.arrivals} arrivals, {account.providerRefusals} provider refusals.
                    </div>
                    {account.unavailable ? (
                      <div className="rs-hint">Not available now: {account.unavailable}</div>
                    ) : null}
                    {allocation.canReport ? (
                      <form onSubmit={(event) => { event.preventDefault(); void report(account.id); }}>
                        <label>
                          Remaining allowance shown in Claude (%)
                          <input
                            type="number" min="0" max="100" step="1" inputMode="numeric"
                            value={values[account.id] ?? ''}
                            onChange={(event) =>
                              setValues((prior) => ({ ...prior, [account.id]: event.target.value }))}
                          />
                        </label>
                        <button type="submit" disabled={busy !== null}>
                          {busy === account.id ? 'Saving…' : 'Save reading'}
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ))}
    </section>
  );
}

/**
 * Which repositories could actually execute, and the one action that fixes one
 * that could not.
 *
 * This card exists because of the state it replaces. The list used to be a
 * dropdown of remotes, and a person could submit an objective against one that
 * had no worker registered for it — the campaign would be created, plan a stage,
 * and sit at `READY` for ever with the reason on a ledger nobody reads. §24's
 * sentence, at the factory: **a state that says waiting which nobody can resolve
 * is not waiting, it is stuck.**
 *
 * So the readiness is derived on every read and said out loud, and the remaining
 * steps are printed in the order they have to happen. Two of the three are Brain's
 * and happen when the button is pressed; the third is not Brain's and says so —
 * the surface a worker runs on is granted where it runs, and a Brain that could
 * mint its own execution surfaces would be exactly what §22's split forbids.
 */
function Repositories({
  projectId,
  repositories,
  mayConnectAccounts = false,
  connectAccountsRefusal = null,
  onChanged,
}: {
  projectId: string | null;
  repositories: RepositoryOnboarding[];
  mayConnectAccounts?: boolean;
  connectAccountsRefusal?: string | null;
  onChanged(): void;
}): JSX.Element | null {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [issued, setIssued] = useState<OnboardResult | null>(null);
  /*
   * The boundary, per repository, with **no default selected**.
   *
   * `null` until a person answers, and the button stays disabled while it is —
   * because the whole point is that the widest reach must be chosen rather than
   * arrived at. A pre-selected "whole repository" would be the old default
   * wearing a radio button.
   */
  const [scope, setScope] = useState<Record<string, 'WHOLE_REPOSITORY' | 'DIRECTORIES'>>({});
  const [directories, setDirectories] = useState<Record<string, string>>({});
  if (repositories.length === 0) return null;

  async function onboard(grantId: string): Promise<void> {
    if (!projectId) return;
    const kind = scope[grantId];
    if (!kind) return;
    setBusy(grantId);
    setProblem(null);
    try {
      setIssued(
        await FactoryApi.onboard(
          projectId,
          grantId,
          kind === 'WHOLE_REPOSITORY'
            ? { scopeKind: 'WHOLE_REPOSITORY' }
            : {
                scopeKind: 'DIRECTORIES',
                directories: (directories[grantId] ?? '')
                  .split(/[\n,]/)
                  .map((entry) => entry.trim())
                  .filter((entry) => entry.length > 0),
              },
        ),
      );
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rs-card rs-factory-repositories">
      <h3>Repositories</h3>
      <ul className="rs-repo-list">
        {repositories.map((repo) => (
          <li key={repo.grantId} className={`rs-repo rs-repo-${repo.readiness.toLowerCase()}`}>
            <div className="rs-repo-head">
              <strong>{repo.remote.replace('https://github.com/', '')}</strong>
              <span className="rs-repo-readiness">{READINESS[repo.readiness]}</span>
            </div>
            <p className="rs-hint">{repo.description}</p>
            {/*
              * The server's own sentence first: which readiness this is and why,
              * composed once so the card and the picker below cannot disagree.
              */}
            <p className="rs-hint rs-repo-summary">{repo.summary}</p>
            {repo.surfaces.length > 0 ? (
              /*
               * Accounts, then surfaces, then what each one would actually do.
               *
               * This used to render only on READY, and READY used to mean "an
               * enabled Routine is bound" — so a surface with no deployed secret,
               * or no repository-write, read *Ready to execute* while the
               * dispatcher would fire none of it. Every configured surface is
               * listed now with the dispatcher's own decision about it, and
               * whether it has ever completed work is a separate fact beside it:
               * a proof is history, and a surface taken out of routing since
               * counts for nothing here however well it ran.
               */
              <>
                <p className="rs-hint">
                  Registered as <code>{repo.workerName}</code>.{' '}
                  {repo.eligibleSurfaces} of {repo.surfaces.length} configured{' '}
                  {repo.surfaces.length === 1 ? 'surface' : 'surfaces'} can take work now, on{' '}
                  {repo.accountsServing === 1
                    ? '1 Claude account'
                    : `${repo.accountsServing} Claude accounts`}
                  ; {repo.provenSurfaces} {repo.provenSurfaces === 1 ? 'has' : 'have'} completed work
                  Brain sent {repo.provenSurfaces === 1 ? 'it' : 'them'}.
                </p>
                <ul className="rs-repo-surfaces">
                  {repo.surfaces.map((surface) => (
                    <li
                      key={`${surface.accountName}/${surface.routineName}`}
                      className={`rs-repo-surface rs-repo-surface-${surface.dispatch.toLowerCase()}`}
                    >
                      {surface.routineName} — {surface.accountName} —{' '}
                      <strong>{DISPATCH[surface.dispatch]}</strong>
                      {surface.proven ? ' (has completed work)' : ' (not yet proven)'}
                      {surface.dispatch === 'ELIGIBLE' ? null : (
                        <span className="rs-hint"> {surface.dispatchReason}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {/*
              * Member-contributed Claude accounts this repository may use.
              *
              * Only the verified ones reach this list, and only once somebody
              * has authorized that worker for this repository — the server
              * decides both and this renders what it is given. Silence here
              * means no member's connection is usable for this repository,
              * which is a different fact from no member having connected one.
              */}
            {repo.contributedSurfaces.length > 0 ? (
              <p className="rs-hint">
                Member capacity authorized here:{' '}
                {repo.contributedSurfaces
                  .map((one) => `${one.displayName} (${one.workerName})`)
                  .join(', ')}
                .
              </p>
            ) : null}
            {repo.readiness === 'AWAITING_SURFACE' ? (
              /*
               * The exact URL, composed here rather than on the server.
               *
               * Brain does not know its own public address without a request,
               * and a guessed one in a setup instruction is worse than none —
               * this page is *served* from that address, so it can say it
               * exactly. The path is a constant from the server, and it grants
               * nothing: the worker approved on the consent screen is what
               * decides what the connection can do.
               */
              <p className="rs-hint">
                Connector URL:{' '}
                <code>{`${window.location.origin}${repo.connectorPath}`}</code>
              </p>
            ) : null}
            {repo.remaining.length > 0 ? (
              <ol className="rs-repo-remaining">
                {repo.remaining.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            ) : null}
            {repo.waiting > 0 ? (
              /*
               * What the steps are actually for. Work already deferred for want
               * of this surface is put back by Brain when the surface arrives —
               * so this says the one thing a person most needs to know before
               * doing a setup task: nothing has to be started again afterwards.
               */
              <p className="rs-repo-waiting">
                {repo.waiting === 1
                  ? 'One stage is waiting on this'
                  : `${repo.waiting} stages are waiting on this`}
                , and resumes by itself once the surface is registered. Nothing has to be
                submitted again.
              </p>
            ) : null}
            {repo.boundary ? (
              <p className="rs-repo-boundary">
                This project may change <strong>{repo.boundary.sentence}</strong>.
              </p>
            ) : null}
            {repo.readiness !== 'NOT_ONBOARDED' && projectId ? (
              /*
               * More Claude accounts for the worker this repository already has.
               *
               * Offered in every onboarded state and above all in READY, which
               * is when a pool is being commissioned. It asks nothing about the
               * repository, and each link is for one named member and leaves
               * every other link alone. Disabled with the server's reason for
               * somebody who may not issue one, never removed, so two people
               * reading one project see one page.
               */
              <FactoryInvites
                projectId={projectId}
                grantId={repo.grantId}
                connectorUrl={`${window.location.origin}${repo.connectorPath}`}
                mayIssue={mayConnectAccounts}
                refusal={connectAccountsRefusal}
              />
            ) : null}
            {/*
              * Onboarding is the remedy for exactly two readinesses. A surface
              * that is configured and refused, or merely busy, is not answered by
              * a new invitation — offering one would rotate a working connector's
              * link to fix a missing secret or a cooldown.
              */}
            {repo.readiness === 'NOT_ONBOARDED' || repo.readiness === 'AWAITING_SURFACE' ? (
              <div className="rs-repo-scope">
                {/*
                  * The one question here that has a wrong answer, asked rather
                  * than defaulted. Neither radio starts selected and the button
                  * is disabled until one is: "the whole repository" is an
                  * ordinary answer and it has to be given, because the defect
                  * this closes is that the widest reach used to be what you got
                  * by saying nothing.
                  */}
                <p className="rs-hint">
                  What may this project change in it? A campaign submitted here can narrow this
                  and can never widen it, and narrowing it afterwards would not correct an
                  answer that was too broad — so it is asked now.
                </p>
                <label className="rs-repo-scope-choice">
                  <input
                    type="radio"
                    name={`scope-${repo.grantId}`}
                    checked={scope[repo.grantId] === 'WHOLE_REPOSITORY'}
                    onChange={() =>
                      setScope((current) => ({ ...current, [repo.grantId]: 'WHOLE_REPOSITORY' }))
                    }
                  />
                  <span>The whole repository</span>
                </label>
                <label className="rs-repo-scope-choice">
                  <input
                    type="radio"
                    name={`scope-${repo.grantId}`}
                    checked={scope[repo.grantId] === 'DIRECTORIES'}
                    onChange={() =>
                      setScope((current) => ({ ...current, [repo.grantId]: 'DIRECTORIES' }))
                    }
                  />
                  <span>Only these directories</span>
                </label>
                {scope[repo.grantId] === 'DIRECTORIES' ? (
                  <textarea
                    rows={2}
                    placeholder={'sites/v4\nshared/ui'}
                    aria-label="Directories this project may change"
                    value={directories[repo.grantId] ?? ''}
                    onChange={(event) =>
                      setDirectories((current) => ({
                        ...current,
                        [repo.grantId]: event.target.value,
                      }))
                    }
                  />
                ) : null}
                <button
                  type="button"
                  disabled={busy !== null || !projectId || !scope[repo.grantId]}
                  onClick={() => void onboard(repo.grantId)}
                >
                  {busy === repo.grantId
                    ? 'Registering…'
                    : repo.readiness === 'NOT_ONBOARDED'
                      ? 'Onboard this repository'
                      : 'Issue a new invitation'}
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}

      {issued ? (
        <div className="rs-repo-issued">
          <h4>Connect the surface</h4>
          <p>
            {issued.createdIdentity ? 'Created' : 'Repaired'} <code>
              {issued.onboarding.workerName}
            </code>
            , registered it for <code>{issued.onboarding.repositoryId}</code> and nothing else, and
            issued one invitation. Open this link in the browser you will connect from — it is
            shown once and expires {new Date(issued.invitationExpiresAt).toLocaleString()}.
          </p>
          {/*
            * Selectable rather than a link: opening it here would spend the browser
            * cookie on this tab, and the browser that needs it is the one that will
            * register the connector.
            */}
          <p className="rs-repo-invite">
            <code>{issued.invitationUrl}</code>
          </p>
          <p className="rs-hint">
            The invitation connects that one worker and nothing else, and a signed-in person still
            has to approve it. It is not a credential: on its own it cannot read anything, call a
            tool, or obtain a token.
          </p>
          {issued.onboarding.waiting > 0 ? (
            <p className="rs-hint">
              {issued.onboarding.waiting === 1
                ? 'One stage already deferred for this repository resumes'
                : `${issued.onboarding.waiting} stages already deferred for this repository resume`}{' '}
              on their own once a surface is registered — Brain puts the deferred work back rather
              than asking for it again.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const READINESS: Record<RepositoryOnboarding['readiness'], string> = {
  NOT_ONBOARDED: 'No worker registered',
  AWAITING_SURFACE: 'Registered — waiting for a surface',
  NO_USABLE_SURFACE: 'No Factory surface can take work',
  WAITING_FOR_CAPACITY: 'Waiting for capacity',
  READY: 'Ready to execute',
};

const DISPATCH: Record<RepositoryOnboarding['surfaces'][number]['dispatch'], string> = {
  ELIGIBLE: 'can take work now',
  WAITING: 'waiting for capacity',
  UNUSABLE: 'will not be fired',
};

/**
 * The objective, and the one decision that starts it.
 *
 * Submitting records the ask and pins the repository; approving is what freezes
 * the objective and starts the campaign. They are two steps on purpose and the
 * wording says why: what is pinned between them — the commit, the branch, the
 * repository's own verification commands — is what the work will be judged
 * against, and a person should see it before it becomes immutable.
 *
 * The detailed fields start hidden. A person who wants to write the acceptance
 * conditions themselves can; one who does not gets them derived and recorded as
 * an amendment before any unit is claimable, which is the contract's own rule.
 */
function Submit({
  projectId,
  repositories,
  onStarted,
}: {
  projectId: string | null;
  repositories: RepositoryOnboarding[];
  onStarted(): void;
}): JSX.Element {
  const [repository, setRepository] = useState(repositories[0]?.remote ?? '');
  const [objective, setObjective] = useState('');
  const [outcome, setOutcome] = useState('');
  const [branch, setBranch] = useState('');
  const [conditions, setConditions] = useState('');
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pinned, setPinned] = useState<SubmitResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!projectId) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await FactoryApi.submit(projectId, {
        objective,
        expectedOutcome: outcome,
        repository,
        baseBranch: branch.trim() === '' ? undefined : branch.trim(),
        acceptanceConditions: parseConditions(conditions),
      });
      setPinned(result);
    } catch (cause: unknown) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const approve = async (): Promise<void> => {
    if (!pinned) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await FactoryApi.approve(pinned.changeRequest.id);
      setStarted(`${result.campaign.id} — ${result.execution.note}`);
      setPinned(null);
      setObjective('');
      setOutcome('');
      setConditions('');
      onStarted();
    } catch (cause: unknown) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="rs-card rs-build-submit"
      onSubmit={(event) => {
        event.preventDefault();
        if (pinned) void approve();
        else void submit();
      }}
    >
      <fieldset disabled={busy}>
        <legend>What should become true</legend>

        <label>
          <span>Repository</span>
          <select value={repository} onChange={(event) => setRepository(event.target.value)}>
            {repositories.map((grant) => (
              <option key={grant.grantId} value={grant.remote}>
                {grant.remote.replace('https://github.com/', '')}
                {grant.readiness === 'READY' ? '' : ` — ${READINESS[grant.readiness].toLowerCase()}`}
              </option>
            ))}
          </select>
        </label>
        <p className="rs-hint">
          {repositories.find((grant) => grant.remote === repository)?.description ??
            'Pick the repository this objective is about.'}
        </p>
        {/*
          * What executing here would actually meet, in the server's own words.
          * A submission is still accepted when nothing can execute it — the work
          * waits and resumes by itself — but a person should know that before
          * they write the objective rather than after the campaign stalls.
          */}
        {(() => {
          const chosen = repositories.find((grant) => grant.remote === repository);
          return chosen && chosen.readiness !== 'READY' ? (
            <p className="rs-hint rs-build-not-ready">{chosen.summary}</p>
          ) : null;
        })()}

        <label>
          <span>The objective</span>
          <textarea
            rows={4}
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            placeholder="What should be true in this repository that is not true now?"
          />
        </label>

        <label>
          <span>What you would see differently afterwards</span>
          <textarea
            rows={3}
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
            placeholder="How would somebody know it worked?"
          />
        </label>

        <button type="button" className="rs-link" onClick={() => setDetails(!details)}>
          {details ? 'Hide details' : 'Change details'}
        </button>

        {details ? (
          <div className="rs-build-details">
            <label>
              <span>Branch to build on</span>
              <input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="the repository's default branch"
              />
            </label>
            <p className="rs-hint">
              Leave it empty for the default branch. Naming a branch that is already an open
              pull request's head continues that request instead of opening another.
            </p>
            <label>
              <span>Acceptance conditions, one per line</span>
              <textarea
                rows={5}
                value={conditions}
                onChange={(event) => setConditions(event.target.value)}
                placeholder={'what must be true :: the command that proves it'}
              />
            </label>
            <p className="rs-hint">
              Leave it empty and the factory derives them from the objective and records them
              before any work can be claimed. Either way they are frozen when you approve.
            </p>
          </div>
        ) : null}

        {pinned ? (
          <div className="rs-build-pinned">
            <h3>Pinned, and waiting for you</h3>
            <p>
              {pinned.derived.repository} at <code>{pinned.derived.baseSha.slice(0, 12)}</code> on{' '}
              <code>{pinned.derived.baseBranch}</code>.
            </p>
            <p>
              {pinned.derived.verificationCommands.length > 0
                ? `Every unit will be judged by the repository's own commands: ${pinned.derived.verificationCommands.join(', ')}.`
                : 'That commit declares no verification commands, so nothing can be run against the work yet. The factory can be given one later; it may add commands and may never remove one.'}
            </p>
            {/*
              * The reach, before anybody approves it.
              *
              * It is the scope that was actually *stored* — the project's
              * boundary, or the narrowing this submission asked for inside it —
              * rather than the deriver's guess, so this card and the contract
              * cannot say different things about the same campaign.
              */}
            <p className="rs-build-scope">
              {pinned.derived.mutationScope.length === 1 &&
              pinned.derived.mutationScope[0] === '**'
                ? 'Units may change anything in that repository.'
                : `Units may change only: ${pinned.derived.mutationScope.join(', ')}. A diff that reaches outside is rejected whole.`}
            </p>
            <p className="rs-hint">
              Approving freezes the objective and its conditions — nothing in the factory can
              change them afterwards — and starts the campaign.
            </p>
          </div>
        ) : null}

        <button type="submit" className="rs-primary">
          {pinned ? 'Approve and start' : 'Pin it'}
        </button>
      </fieldset>

      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
      {started ? <p className="rs-state rs-state-ready">Started: {started}</p> : null}
    </form>
  );
}

/**
 * `statement :: verification`, one per line.
 *
 * A condition with no verification is refused by the server, so a line with no
 * separator is given the whole line as its statement and left for that refusal
 * to name rather than being silently completed here. A client that invented a
 * verification command would be inventing the standard the work is judged by.
 */
function parseConditions(text: string): { statement: string; verification: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [statement, verification] = line.split('::');
      return {
        statement: (statement ?? '').trim(),
        verification: (verification ?? '').trim(),
      };
    });
}

/** What is running, and what came of it. */
function Campaigns({
  campaigns,
  loading,
  error,
  onReload,
}: {
  campaigns: FactoryCampaign[] | null;
  loading: boolean;
  error: { status: number; message: string } | null;
  onReload(): void;
}): JSX.Element {
  const state = listState({ loading, error, items: campaigns, noun: 'campaigns' });
  return (
    <div className="rs-build-campaigns">
      <h3>What the factory is doing</h3>
      {state.phase !== 'READY' ? (
        <p className={`rs-state rs-state-${state.phase.toLowerCase()}`}>
          {state.message}
          {state.retryable ? (
            <button type="button" onClick={onReload}>
              Try again
            </button>
          ) : null}
        </p>
      ) : (
        <ul className="rs-list">
          {state.items.map((campaign) => (
            <CampaignRow key={campaign.id} campaign={campaign} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CampaignRow({ campaign }: { campaign: FactoryCampaign }): JSX.Element {
  const detail = useAsync(() => FactoryApi.campaign(campaign.id), [campaign.id]);
  const view = detail.data;
  const landed = view?.units.filter((unit) => unit.state === 'INTEGRATED').length ?? 0;
  const total = view?.units.length ?? 0;

  return (
    <li className="rs-card rs-build-campaign">
      <h4>{view?.objective ?? campaign.id}</h4>
      <p className="rs-build-stage">
        <strong>{view?.stage ?? campaign.state}</strong>
        {view?.stageDetail ? ` — ${view.stageDetail}` : null}
      </p>
      {total > 0 ? (
        <p className="rs-hint">
          {landed} of {total} unit(s) integrated
          {view?.review ? `; review round ${view.review.round}: ${view.review.verdict}` : ''}
          {view && view.openFindings.length > 0
            ? `; ${view.openFindings.length} open finding(s)`
            : ''}
        </p>
      ) : null}
      {view?.blocker ? (
        <p className="rs-state rs-state-error">
          <strong>{view.blocker.kind}</strong>
          {view.blocker.detail ? ` — ${view.blocker.detail}` : null} {view.blocker.remedy}
        </p>
      ) : null}
      {view?.decisionWaiting ? (
        <ReleaseDecision
          campaignId={campaign.id}
          release={view.decisionWaiting}
          onAnswered={detail.reload}
        />
      ) : null}
      {view && view.openFindings.length > 0 ? (
        <ul className="rs-findings">
          {view.openFindings.map((finding) => (
            <li key={finding.id}>
              <strong>{finding.severity}</strong> {finding.statement}
            </li>
          ))}
        </ul>
      ) : null}
      {campaign.prUrl ? (
        <p>
          <a href={campaign.prUrl} target="_blank" rel="noreferrer">
            Read the pull request{campaign.prRef ? ` ${campaign.prRef}` : ''}
          </a>
        </p>
      ) : campaign.prRef ? (
        /*
         * A campaign that ran on a checkout stops at a reviewed branch: `assemble.ts`
         * produces the branch, the patch and the body and deliberately publishes
         * nothing. This used to fall through to "No pull request yet", which told
         * a person the work did not exist while the thing they needed was sitting
         * on a named branch.
         */
        <p>
          The reviewed work is on branch <code>{campaign.prRef}</code>
          {campaign.integrationSha ? (
            <>
              {' '}at <code>{campaign.integrationSha.slice(0, 12)}</code>
            </>
          ) : null}
          . This campaign ran on a checkout, so it stops there: opening the pull request is a
          person&apos;s step.
        </p>
      ) : (
        <p className="rs-hint">
          No pull request yet. One is opened when the work has been integrated and an
          independent session has passed it.
        </p>
      )}
    </li>
  );
}

/**
 * The second of a person's two decisions, where the campaign is waiting for it.
 *
 * A campaign whose deployment policy is not `NONE` reaches `AWAITING_RELEASE`
 * and parks with the blocker `AWAITING_HUMAN_RELEASE`. Before this, the row
 * above rendered that sentence and nothing else — a stage whose whole purpose
 * is to wait for a person, with no way for that person to answer. §24's
 * escalation nobody can resolve, and §26's rule that a decision a person makes
 * about their own project belongs on the surface they already use.
 *
 * **What is being let out is shown rather than assumed.** The release carries
 * the evidence it was requested with — the integration commit, how many units
 * landed, the review rounds, the last verdict, what independence was achieved
 * and how many findings are still open — and every one of those is printed,
 * because a decision card that asks somebody to approve a thing it declines to
 * describe is a confirmation dialog rather than a decision. Unknown keys are
 * printed too, with their own names, so evidence that grows on the server never
 * goes quietly missing from the one screen it is for.
 *
 * **Both answers, and a reason.** A card that offers one answer is not a
 * decision (§33), and a refusal with no reason answers nothing later. Nothing
 * here decides whether the reason is good enough: the server takes it, and a
 * client-side rule the server does not enforce would be a second reader of one
 * decision.
 *
 * **No capability flag, deliberately, and that is this screen's own
 * convention.** Approving an objective — the other of the two — is rendered the
 * same way: the control is offered, and the server refuses it with the same 404
 * a project that does not exist gives. Adding a flag to one of two matching
 * decisions would make the screen inconsistent with itself, and a hidden button
 * is not authorization in either case.
 */
function ReleaseDecision({
  campaignId,
  release,
  onAnswered,
}: {
  campaignId: string;
  release: FactoryRelease;
  onAnswered(): void;
}): JSX.Element {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const answer = useCallback(
    (decision: 'APPROVED' | 'REFUSED') => {
      if (busy) return;
      setBusy(true);
      setProblem(null);
      void FactoryApi.answerRelease(campaignId, decision, reason).then(
        () => {
          setBusy(false);
          onAnswered();
        },
        (error: unknown) => {
          // The buttons come back rather than spinning. A control that never
          // recovers from one failed press is worse than one that did nothing.
          setBusy(false);
          setProblem(error instanceof Error ? error.message : String(error));
        },
      );
    },
    [busy, campaignId, onAnswered, reason],
  );

  return (
    <div className="rs-card rs-build-release">
      <h5>This campaign is waiting for you to let the work out</h5>
      <p className="rs-hint">
        The reviewable artifact is ready. Approving it records that a person allowed this
        campaign&rsquo;s result out; refusing it records that a person did not, with the reason.
        Neither merges anything and neither deploys anything.
      </p>
      <ul className="rs-build-release-evidence">
        {Object.entries(release.evidence).map(([key, value]) => (
          <li key={key}>
            <span className="rs-field-label">{key.replace(/([a-z])([A-Z])/g, '$1 $2')}</span>{' '}
            <span>{value === null ? 'not established' : String(value)}</span>
          </li>
        ))}
      </ul>
      <label>
        <span className="rs-field-label">Why</span>
        <textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <p className="rs-build-actions">
        <button type="button" disabled={busy} onClick={() => answer('APPROVED')}>
          {busy ? 'Recording…' : 'Approve the release'}
        </button>
        <button
          type="button"
          className="rs-button-quiet"
          disabled={busy}
          onClick={() => answer('REFUSED')}
        >
          Refuse it
        </button>
      </p>
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
    </div>
  );
}

/**
 * Objectives that are pinned and not yet approved.
 *
 * They exist because pinning and approving are two steps, and a person who
 * closed the tab between them would otherwise have no way back to the second
 * one. Nothing is running here — an unapproved objective has no campaign — so
 * the only control is the same single decision.
 */
function Unapproved({
  requests,
  campaigns,
  onApproved,
}: {
  requests: FactoryChangeRequest[];
  campaigns: FactoryCampaign[];
  onApproved(): void;
}): JSX.Element | null {
  const started = new Set(campaigns.map((campaign) => campaign.changeRequestId));
  const waiting = requests.filter((request) => !started.has(request.id));
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (waiting.length === 0) return null;

  return (
    <div className="rs-build-unapproved">
      <h3>Pinned, waiting for you to approve</h3>
      <ul className="rs-list">
        {waiting.map((request) => (
          <li key={request.id} className="rs-card">
            <h4>{request.objective}</h4>
            <p className="rs-hint">
              {request.repository} at <code>{request.baseSha.slice(0, 12)}</code> on{' '}
              <code>{request.baseBranch}</code>
            </p>
            <button
              type="button"
              className="rs-primary"
              disabled={busy !== null}
              onClick={() => {
                setBusy(request.id);
                setProblem(null);
                FactoryApi.approve(request.id)
                  .then(() => onApproved())
                  .catch((cause: unknown) =>
                    setProblem(cause instanceof Error ? cause.message : String(cause)),
                  )
                  .finally(() => setBusy(null));
              }}
            >
              Approve and start
            </button>
          </li>
        ))}
      </ul>
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
    </div>
  );
}

function inviteStatusText(one: FactoryInvitationView): string {
  const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : '');
  switch (one.status) {
    case 'WAITING':
      return `Waiting to be used — expires ${when(one.expiresAt)}`;
    case 'CONNECTED':
      return `Used to connect a Claude account ${when(one.endedAt)}`;
    case 'EXPIRED':
      return `Expired ${when(one.expiresAt)} without being used`;
    case 'WITHDRAWN':
      return `Withdrawn ${when(one.endedAt)}`;
  }
}

/**
 * Invite another Claude account to an onboarded factory worker, one member at a
 * time, and see every link already sent.
 *
 * Each link is for one named member and is shown exactly once with a copy
 * control; the list afterwards says who it was for and whether it has been
 * used, and never shows a link again. Issuing one never withdraws another.
 */
function FactoryInvites({
  projectId,
  grantId,
  connectorUrl,
  mayIssue,
  refusal,
}: {
  projectId: string;
  grantId: string;
  connectorUrl: string;
  /** The server's decision for this reader; the routes re-decide regardless. */
  mayIssue: boolean;
  refusal: string | null;
}): JSX.Element {
  const [state, setState] = useState<FactoryInvitations | null>(null);
  const [member, setMember] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fresh, setFresh] = useState<IssuedFactoryInvitation[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      setState(await FactoryApi.invitations(projectId, grantId));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The invitations could not be read.');
    }
  }
  useEffect(() => {
    // Somebody who may not issue a link may not read who was sent one either;
    // the control is shown disabled with the server's reason instead.
    if (mayIssue) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, grantId]);

  async function issue(): Promise<void> {
    if (!member) return;
    setBusy(true);
    setProblem(null);
    try {
      const issued = await FactoryApi.invite(projectId, grantId, member);
      // Newest first, and kept on screen: re-reading the list below must not
      // take a link down with it, since it is shown once.
      setFresh((current) => [issued, ...current]);
      setMember('');
      await load();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(invitationId: string): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await FactoryApi.withdrawInvitation(projectId, grantId, invitationId);
      await load();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string, id: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(id);
    } catch {
      setProblem('Copying was refused by this browser. Press and hold the link to copy it instead.');
    }
  }

  return (
    <div className="rs-factory-invites">
      <h4>Invite another Factory account</h4>
      <p className="rs-hint">
        Each link lets one Brain member connect their own Claude account to{' '}
        <code>{state?.workerName ?? 'this worker'}</code>. It asks nothing about the repository
        again, changes nothing already connected, and leaves every other link as it is. It only
        works in a browser signed in to Brain as the member it is for, once, within seven days.
      </p>
      {!mayIssue ? (
        <p className="rs-hint">
          <button type="button" disabled>
            Issue a link
          </button>{' '}
          {refusal}
        </p>
      ) : null}
      {state && !state.mayIssue ? <p className="rs-hint">{state.refusal}</p> : null}
      {mayIssue && state?.mayIssue ? (
        <div className="rs-factory-invite-form">
          <label>
            <span>Who is this link for?</span>
            <select
              value={member}
              aria-label="Member this link is for"
              onChange={(event) => setMember(event.target.value)}
            >
              <option value="">Choose a member…</option>
              {state.members.map((one) => (
                <option key={one.userId} value={one.userId}>
                  {one.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={busy || !member} onClick={() => void issue()}>
            {busy ? 'Issuing…' : 'Issue a link'}
          </button>
        </div>
      ) : null}
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
      {fresh.map((one) => (
        <div key={one.invitation.id} className="rs-repo-issued rs-factory-invite-fresh">
          <p>
            Link for <strong>{one.invitation.intendedName}</strong> — shown once, expires{' '}
            {new Date(one.invitation.expiresAt).toLocaleString()}.
          </p>
          <p className="rs-repo-invite">
            <code>{one.invitationUrl}</code>
          </p>
          <p className="rs-hint">
            They sign in to Brain as themselves in the browser they will use, open this link, then
            add a Claude connector named Factory Brain at <code>{connectorUrl}</code> and approve.
          </p>
          <button type="button" onClick={() => void copy(one.invitationUrl, one.invitation.id)}>
            {copied === one.invitation.id ? 'Copied' : 'Copy link'}
          </button>
        </div>
      ))}
      {state && state.invitations.length > 0 ? (
        <ul className="rs-factory-invite-list">
          {state.invitations.map((one) => (
            <li key={one.id}>
              <span>
                <strong>{one.intendedName ?? 'Onboarding link (anyone holding it)'}</strong>
                {' — '}
                {inviteStatusText(one)}
              </span>
              {one.status === 'WAITING' ? (
                <button type="button" disabled={busy} onClick={() => void withdraw(one.id)}>
                  Withdraw
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

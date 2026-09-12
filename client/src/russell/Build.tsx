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
import { useState } from 'react';
import { listState } from './present.ts';
import { useAsync } from './useAsync.ts';
import { FactoryApi } from '../lib/factoryApi.ts';
import type {
  FactoryCampaign,
  FactoryChangeRequest,
  OnboardResult,
  RepositoryOnboarding,
  SubmitResponse,
} from '../lib/factoryApi.ts';

export function BuildView({ projectId }: { projectId: string | null }): JSX.Element {
  const repositories = useAsync(
    () =>
      projectId
        ? FactoryApi.repositories(projectId)
        : Promise.resolve({ repositories: [] as RepositoryOnboarding[] }),
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

  const state = listState({
    loading: repositories.loading,
    error: repositories.error,
    items: repositories.data?.repositories ?? null,
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
          <Repositories
            projectId={projectId}
            repositories={state.items}
            onChanged={repositories.reload}
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
  onChanged,
}: {
  projectId: string | null;
  repositories: RepositoryOnboarding[];
  onChanged(): void;
}): JSX.Element | null {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [issued, setIssued] = useState<OnboardResult | null>(null);

  if (repositories.length === 0) return null;

  async function onboard(grantId: string): Promise<void> {
    if (!projectId) return;
    setBusy(grantId);
    setProblem(null);
    try {
      setIssued(await FactoryApi.onboard(projectId, grantId));
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
            {repo.readiness === 'READY' ? (
              <p className="rs-hint">
                Registered as <code>{repo.workerName}</code>, running on{' '}
                {repo.surfaces.join(', ')}.
              </p>
            ) : null}
            {repo.remaining.length > 0 ? (
              <ol className="rs-repo-remaining">
                {repo.remaining.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            ) : null}
            {repo.readiness !== 'READY' ? (
              <button
                type="button"
                disabled={busy !== null || !projectId}
                onClick={() => void onboard(repo.grantId)}
              >
                {busy === repo.grantId
                  ? 'Registering…'
                  : repo.readiness === 'NOT_ONBOARDED'
                    ? 'Onboard this repository'
                    : 'Issue a new invitation'}
              </button>
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
        </div>
      ) : null}
    </section>
  );
}

const READINESS: Record<RepositoryOnboarding['readiness'], string> = {
  NOT_ONBOARDED: 'No worker registered',
  AWAITING_SURFACE: 'Registered — waiting for a surface',
  READY: 'Ready to execute',
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
                {grant.readiness === 'READY' ? '' : ' — not ready to execute'}
              </option>
            ))}
          </select>
        </label>
        <p className="rs-hint">
          {repositories.find((grant) => grant.remote === repository)?.description ??
            'Pick the repository this objective is about.'}
        </p>

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

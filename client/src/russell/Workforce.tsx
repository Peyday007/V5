/**
 * The workforce: one card per Claude account.
 *
 * Every number on this screen is the server's count of Brain's own rows over
 * the last day (`services/fleet/workforce.ts`), and every status word is the
 * server's. The screen chooses only the order to show them in and the colour
 * of a status — it composes no judgement of its own, so this page and the
 * dispatcher cannot disagree about whether an account is idle.
 *
 * A job in a project the reader cannot read arrives with no title, and is
 * shown as "work in another project": the count crosses, the subject does not.
 */
import { RussellApi } from '../lib/russellApi.ts';
import type { WorkforceView } from '../lib/russellApi.ts';
import { useAsync } from './useAsync.ts';
import { humanWhen, readingState } from './present.ts';

type Account = WorkforceView['accounts'][number];
type Job = Account['current'][number];

const STATUS_WORD: Record<Account['status'], string> = {
  WORKING: 'Working',
  READY: 'Ready',
  IDLE_WITH_WORK: 'Idle — work waiting',
  HELD: 'Held back',
  NOT_CONNECTED: 'Not connected',
};

const STATUS_TONE: Record<Account['status'], string> = {
  WORKING: 'good',
  READY: 'neutral',
  IDLE_WITH_WORK: 'watch',
  HELD: 'bad',
  NOT_CONNECTED: 'bad',
};

function jobTitle(job: Job | null): string {
  if (!job) return 'Nothing queued for it';
  return job.title ?? 'Work in another project';
}

export function useWorkforce(projectId: string | null) {
  return useAsync(
    () => (projectId ? RussellApi.workforce(projectId) : Promise.resolve(null)),
    [projectId],
  );
}

/** The figures across the whole workforce, as a row of tiles. */
export function WorkforceTotals({ view }: { view: WorkforceView }): JSX.Element {
  const total = view.accounts.length;
  return (
    <div className="rs-kpis" role="list" aria-label="Workforce in the last day">
      <Kpi label="Accounts working" value={`${view.totals.working} / ${total}`} tone={view.totals.working > 0 ? 'good' : 'bad'} />
      <Kpi label="Bins completed (24h)" value={String(view.totals.completed24h)} />
      <Kpi label="Research passes (24h)" value={String(view.totals.researchPasses24h)} />
      <Kpi label="Work waiting" value={String(view.queue.ready)} />
      <Kpi label="In progress" value={String(view.queue.leased)} />
      <Kpi
        label="Idle with work waiting"
        value={String(view.totals.idleWithWork)}
        tone={view.totals.idleWithWork > 0 ? 'watch' : undefined}
      />
    </div>
  );
}

export function Kpi({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string | null;
  tone?: string;
}): JSX.Element {
  return (
    <div className={`rs-kpi${tone ? ` rs-kpi-${tone}` : ''}`} role="listitem">
      <span className="rs-kpi-label">{label}</span>
      <span className="rs-kpi-value">{value}</span>
      {detail ? <span className="rs-kpi-detail">{detail}</span> : null}
    </div>
  );
}

export function AccountCard({ account }: { account: Account }): JSX.Element {
  const tone = STATUS_TONE[account.status];
  const last = humanWhen(account.lastWorkAt);
  const t = account.last24h;
  return (
    <article className={`rs-wf-card rs-wf-${tone}`} aria-label={`${account.name}: ${STATUS_WORD[account.status]}`}>
      <header className="rs-wf-head">
        <h3 className="rs-wf-name">{account.name}</h3>
        <span className={`rs-chip rs-chip-${tone}`}>{STATUS_WORD[account.status]}</span>
      </header>
      <p className="rs-wf-sentence">{account.statusSentence}</p>

      <dl className="rs-wf-facts">
        <div>
          <dt>Routines</dt>
          <dd>
            {account.routines.usable} of {account.routines.total} usable
          </dd>
        </div>
        <div>
          <dt>Capacity</dt>
          <dd>
            {account.capacity.inFlight}
            {account.capacity.limit !== null ? ` of ${account.capacity.limit}` : ''} in use
          </dd>
        </div>
        <div>
          <dt>Last useful work</dt>
          <dd title={last?.exact}>{last ? last.text : 'none in the last day'}</dd>
        </div>
      </dl>

      <div className="rs-wf-section">
        <p className="rs-wf-label">Now</p>
        {account.current.length === 0 ? (
          <p className="rs-wf-empty">No job in progress.</p>
        ) : (
          <ul className="rs-wf-jobs">
            {account.current.map((job, index) => (
              <li key={job.binId ?? `hidden-${index}`}>
                <span className="rs-wf-job">{jobTitle(job)}</span>
                {job.routineName ? <span className="rs-wf-meta">{job.routineName}</span> : null}
              </li>
            ))}
          </ul>
        )}
        <p className="rs-wf-label">Next eligible</p>
        <p className="rs-wf-job rs-wf-next">{jobTitle(account.nextQueued)}</p>
      </div>

      <table className="rs-wf-tally">
        <caption>Last 24 hours</caption>
        <tbody>
          <tr>
            <th scope="row">Sessions started</th>
            <td>{t.started}</td>
            <th scope="row">Arrived</th>
            <td>{t.arrived}</td>
          </tr>
          <tr>
            <th scope="row">Jobs taken</th>
            <td>{t.assigned}</td>
            <th scope="row">Completed</th>
            <td className="rs-wf-strong">{t.completed}</td>
          </tr>
          <tr>
            <th scope="row">Handed back</th>
            <td>{t.handedBack}</td>
            <th scope="row">Failed</th>
            <td className={t.failed > 0 ? 'rs-wf-warn' : undefined}>{t.failed}</td>
          </tr>
          <tr>
            <th scope="row">Research passes</th>
            <td className="rs-wf-strong" colSpan={3}>
              {t.researchPasses}
            </td>
          </tr>
        </tbody>
      </table>

      {account.heldReasons.length > 0 ? (
        <div className="rs-wf-held">
          <p className="rs-wf-label">Why some Routines are held</p>
          <ul>
            {account.heldReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

/** The workforce page: totals, the four cards, and how work moved. */
export function WorkforcePanel({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useWorkforce(projectId);
  const state = readingState({
    loading: query.loading,
    error: query.error,
    value: query.data ?? null,
    noun: 'the workforce',
  });
  if (state.phase !== 'READY' || !query.data) {
    return <p className={`rs-state rs-state-${state.phase.toLowerCase()}`}>{state.message}</p>;
  }
  const view = query.data.workforce;
  return (
    <section className="rs-wf" aria-labelledby="rs-wf-title">
      <div className="rs-page-head">
        <div>
          <p className="rs-eyebrow">Workforce</p>
          <h2 id="rs-wf-title" className="rs-view-title">
            {view.accounts.length} Claude account{view.accounts.length === 1 ? '' : 's'}, one queue
          </h2>
        </div>
        <button type="button" className="rs-button-quiet" onClick={() => query.reload()}>
          Refresh
        </button>
      </div>
      <WorkforceTotals view={view} />
      {view.accounts.length === 0 ? (
        <p className="rs-state rs-state-empty">
          No Claude account is registered for Brain to run on yet. Connecting one is on People &amp; capacity.
        </p>
      ) : null}
      <div className="rs-wf-grid">
        {view.accounts.map((account) => (
          <AccountCard key={account.accountId} account={account} />
        ))}
      </div>
      {view.movement.length > 0 ? (
        <section className="rs-panel">
          <h3 className="rs-group-title">How work moved</h3>
          <ul className="rs-wf-moves">
            {view.movement.map((move, index) => {
              const when = humanWhen(move.at);
              return (
                <li key={`${move.at}-${index}`}>
                  <span className="rs-wf-meta" title={when?.exact}>
                    {when?.text}
                  </span>
                  <span>
                    <strong>{move.accountName ?? 'Unattributed'}</strong> {move.event}{' '}
                    {move.title ?? 'work in another project'}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {view.totals.unattributed24h > 0 ? (
        <p className="rs-hint">
          {view.totals.unattributed24h} job event{view.totals.unattributed24h === 1 ? '' : 's'} in the last day
          could not be attributed to one account, and are not counted on any card.
        </p>
      ) : null}
    </section>
  );
}

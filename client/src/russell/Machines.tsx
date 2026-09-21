/**
 * The manufacturing programme, as a person reads it.
 *
 * ---------------------------------------------------------------------------
 * One authoritative verdict, composed on the server
 * ---------------------------------------------------------------------------
 *
 * Every verdict, every reason and every condition on this screen is a string
 * the server produced. Nothing here re-derives a status, re-orders a ladder or
 * composes an explanation of its own — §29 records what two readers of one fact
 * cost, and §33 records it again: a screen that paraphrases a decision will
 * eventually paraphrase it wrongly, and then a person is reading one thing
 * while the machinery acts on another.
 *
 * ---------------------------------------------------------------------------
 * The one thing this screen must not become
 * ---------------------------------------------------------------------------
 *
 * **There is no control here that lets Brain infer or award a held
 * capability.** A capability a machine *teaches* is never one this company
 * holds; only a person records that, and the only control that does it demands
 * a sentence saying how it came to be true. The screen shows required against
 * held plainly, side by side, because the *difference* between them is the
 * whole kernel — a single "12 capabilities" would read as competence.
 *
 * Research claims and company-held declarations are kept visually and
 * structurally apart for the same reason: one is what published sources say
 * about machines, the other is what this company can do, and nothing derives
 * the second from the first.
 */
import { useCallback, useState } from 'react';
import { api } from '../lib/api.ts';
import { useAsync } from './useAsync.ts';

interface ConditionReading {
  condition: string;
  answer: 'MET' | 'NOT_MET' | 'UNKNOWN';
  because: string;
}

interface CapabilityRow {
  id: string;
  name: string;
  heldAt: string | null;
  heldEvidence: string | null;
  heldBy: string | null;
  heldNote: string | null;
}

interface CategoryReading {
  categoryId: string;
  path: string[];
  verdict: string;
  conditions: ConditionReading[];
  missing: { capability: CapabilityRow; taughtBy: { id: string; name: string }[] }[];
  held: CapabilityRow[];
  barriers: string[];
  because: string;
}

interface CapabilityReading {
  capability: CapabilityRow;
  requiredBy: { categoryId: string; name: string; path: string[] }[];
  taughtBy: { categoryId: string; name: string; path: string[] }[];
}

interface RoundReading {
  id: string;
  purpose: string;
  state: string;
  round: number;
  subject: string | null;
  openedAt: string;
  harvestedAt: string | null;
  found: number | null;
  barren: boolean;
}

interface PersonDecision {
  kind: string;
  what: string;
  why: string;
  categoryId: string | null;
  capabilities: { id: string; name: string; taughtBy: string[] }[];
}

interface ProgrammeView {
  program: { id: string; objective: string; state: string };
  authorized: boolean;
  counts: {
    categories: number;
    retired: number;
    capabilities: number;
    capabilitiesHeld: number;
    openRounds: number;
    settledRounds: number;
  };
  ladder: CategoryReading[];
  enterable: CategoryReading[];
  next: {
    reading: CategoryReading;
    bridges: { categoryId: string; name: string; supplies: string[] }[];
  }[];
  plan: {
    asks: { purpose: string; subject: string; why: string }[];
    declined: { subject: string; why: string }[];
  };
  open: { id: string; purpose: string; round: number }[];
  capabilities: CapabilityReading[];
  history: RoundReading[];
  refusals: { at: string; claimId: string; why: string }[];
  decisions: PersonDecision[];
}

/**
 * What each state means, in one line.
 *
 * Presentational only: the server decides which state this is, and this maps it
 * to a sentence. A screen that decided the state itself would be the second
 * reader §29 keeps having to remove.
 */
const PROGRAMME_STATE: Record<string, string> = {
  ACTIVE: 'Running — Brain is opening questions and filing what comes back.',
  PAUSED: 'Deferred — everything already running still finishes and is filed.',
  ARCHIVED: 'Stopped — the research authority was withdrawn.',
};

const ANSWER_LABEL: Record<ConditionReading['answer'], string> = {
  MET: 'met',
  NOT_MET: 'not met',
  UNKNOWN: 'not established',
};

const CONDITION_LABEL: Record<string, string> = {
  DEMAND_ESTABLISHED: 'Somebody is buying',
  ROUTE_TO_BUYER_ESTABLISHED: 'There is a route to them',
  REQUIREMENTS_KNOWN: 'What producing requires is known',
  CAPABILITIES_HELD: 'We hold what it requires',
};

const VERDICT_LABEL: Record<string, string> = {
  ENTER: 'Ready to enter',
  BUILD_CAPABILITY_FIRST: 'Capability first',
  NO_ROUTE_FOUND: 'No route to buyers found',
  INVESTIGATING: 'Being researched',
  UNEXAMINED: 'Not yet examined',
  NO_DEMAND_FOUND: 'No demand found',
  RETIRED: 'Retired',
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MachinesView({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync<ProgrammeView | null>(
    async () =>
      projectId ? api<ProgrammeView>(`/api/projects/${projectId}/manufacturing`) : null,
    [projectId],
  );

  if (!projectId) {
    return <p className="rs-empty">Open a project to see its manufacturing programme.</p>;
  }
  if (query.loading) return <p className="rs-empty">Reading the programme…</p>;
  if (query.error?.status === 404) {
    return <StartProgramme projectId={projectId} onStarted={query.reload} />;
  }
  if (query.error) {
    return <p className="rs-empty">{query.error.message}</p>;
  }
  const view = query.data;
  if (!view) return <p className="rs-empty">Nothing to show.</p>;

  return (
    <div className="rs-stack rs-machines">
      <ProgrammeHeader view={view} />
      <Decisions view={view} projectId={projectId} reload={query.reload} />
      <NowResearching view={view} />
      <Ladder view={view} />
      <Ledger view={view} />
      <History view={view} />
    </div>
  );
}

/**
 * The objective a programme starts with, unless somebody changes it.
 *
 * `startProgramme` refuses anything under twenty-four characters with a
 * sentence explaining that *"Build machines" is not an objective*, and it is
 * right to: the objective is what every compiled question is judged against.
 * What was wrong is that the screen asked for one and offered no way to give
 * it, so the refusal was unreachable and so was the programme.
 *
 * So it arrives filled in — §24's rule that a decision a person makes is a
 * proposal to approve rather than a form to fill in — and *Change the
 * objective* reveals the field, which starts hidden. Nothing about the server's
 * check moved; what changed is that there is now something to check.
 */
const SUGGESTED_OBJECTIVE =
  'Establish, from published sources, which classes of machine this company could produce, ' +
  'who is buying them, how product reaches those buyers, and what producing each one requires — ' +
  'starting from what it can already do.';

/**
 * The empty state, with the action it was missing.
 *
 * It used to be a card with a paragraph and nothing to press: *No manufacturing
 * programme*, an accurate explanation of what starting one would authorize, and
 * no way to start one. §24's sentence at a new surface — a state that says a
 * person must decide, which that person cannot act on, is stuck rather than
 * waiting — and here the remedy did not exist anywhere in the product: the
 * route was real, the service was real, and nothing in any browser called
 * either.
 *
 * Idempotent by the server: `startProgramme` answers `created: false` for a
 * project that already has one, so a double press, a retry after a lost
 * response and two tabs all produce one programme. The screen reloads the
 * programme either way rather than reporting which it was, because *it exists
 * now* is the fact and *this press is the one that made it* is not.
 */
function StartProgramme({
  projectId,
  onStarted,
}: {
  projectId: string;
  onStarted(): void;
}): JSX.Element {
  const [objective, setObjective] = useState(SUGGESTED_OBJECTIVE);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const start = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    void api(`/api/projects/${projectId}/manufacturing`, {
      method: 'POST',
      body: JSON.stringify({ objective }),
    }).then(
      () => {
        setBusy(false);
        onStarted();
      },
      (error: unknown) => {
        // The button comes back rather than spinning. A control that never
        // recovers from one failed press is worse than one that did nothing.
        setBusy(false);
        setProblem(error instanceof Error ? error.message : String(error));
      },
    );
  }, [busy, objective, projectId, onStarted]);

  return (
    <section className="rs-card rs-machines rs-machines-start">
      <h2>No manufacturing programme</h2>
      <p className="rs-hint">
        This project has none. Starting one authorizes Brain to research, from published sources,
        which classes of machine exist, who is buying them, how product reaches them, and what
        producing each one takes.
      </p>
      <p className="rs-hint">
        It authorizes nothing else. No spending, no contact with anybody, no purchase, no tooling,
        and nothing about actually building anything — every one of those is a separate decision
        with its own grant, and none of them is on this page.
      </p>
      <p className="rs-item-meta">{objective}</p>
      {editing ? (
        <div className="rs-machines-declare">
          <label className="rs-field-label" htmlFor="machines-objective">
            What this programme is trying to establish
          </label>
          <textarea
            id="machines-objective"
            rows={4}
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
          />
        </div>
      ) : null}
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
      <div className="rs-cash-actions">
        <button type="button" className="rs-primary" disabled={busy} onClick={start}>
          {busy ? 'Starting…' : 'Start the programme'}
        </button>
        <button
          type="button"
          className="rs-button-quiet"
          disabled={busy}
          onClick={() => setEditing((was) => !was)}
        >
          {editing ? 'Keep this objective' : 'Change the objective'}
        </button>
      </div>
    </section>
  );
}

function ProgrammeHeader({ view }: { view: ProgrammeView }): JSX.Element {
  return (
    <section className="rs-card rs-machines-state">
      <h2>Manufacturing programme</h2>
      <p className="rs-machines-status">
        {PROGRAMME_STATE[view.program.state] ?? view.program.state}
      </p>
      {!view.authorized ? (
        <p className="rs-hint rs-machines-warn">
          No live research grant covers this programme, so nothing it asks could run.
        </p>
      ) : null}
      <p className="rs-hint">{view.program.objective}</p>
      <ul className="rs-machines-counts">
        <li>
          <strong>{view.counts.categories}</strong> categories considered
          {view.counts.retired > 0 ? ` (${view.counts.retired} retired)` : ''}
        </li>
        <li>
          <strong>
            {view.counts.capabilitiesHeld} of {view.counts.capabilities}
          </strong>{' '}
          capabilities held
        </li>
        <li>
          <strong>{view.counts.openRounds}</strong> questions running,{' '}
          {view.counts.settledRounds} settled
        </li>
      </ul>
    </section>
  );
}

/**
 * The decisions that are genuinely yours.
 *
 * Only two kinds reach here, and both are things no amount of research could
 * settle. A list that also carried everything Brain is merely *doing* is a list
 * nobody finishes reading.
 */
function Decisions({
  view,
  projectId,
  reload,
}: {
  view: ProgrammeView;
  projectId: string;
  reload: () => void;
}): JSX.Element | null {
  if (view.decisions.length === 0) {
    return (
      <section className="rs-card rs-machines-decisions">
        <h3>Needs you</h3>
        <p className="rs-hint">
          Nothing is waiting on a decision. Brain keeps researching, and a category only
          reaches you once published sources have settled everything they can.
        </p>
      </section>
    );
  }
  return (
    <section className="rs-card rs-machines-decisions">
      <h3>Needs you</h3>
      {view.decisions.map((decision, index) => (
        <article key={`${decision.kind}-${decision.categoryId ?? index}`} className="rs-machines-decision">
          <p className="rs-machines-decision-what">{decision.what}</p>
          <p className="rs-hint">{decision.why}</p>
          {decision.capabilities.length > 0 ? (
            <DeclareHeld
              projectId={projectId}
              capabilities={decision.capabilities}
              reload={reload}
            />
          ) : null}
        </article>
      ))}
    </section>
  );
}

/**
 * The only control on this screen that records a held capability.
 *
 * It demands a sentence saying how it came to be true, and the server refuses
 * an empty one — a capability recorded as held for no stated reason is
 * indistinguishable afterwards from one somebody guessed. Nothing is
 * pre-filled, nothing is suggested, and there is no control anywhere that marks
 * one held from what research established.
 */
function DeclareHeld({
  projectId,
  capabilities,
  reload,
}: {
  projectId: string;
  capabilities: { id: string; name: string; taughtBy: string[] }[];
  reload: () => void;
}): JSX.Element {
  const [chosen, setChosen] = useState(capabilities[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/projects/${projectId}/manufacturing/capabilities`, {
        method: 'POST',
        body: JSON.stringify({ capabilityId: chosen, note }),
      });
      setNote('');
      reload();
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  }, [chosen, note, projectId, reload]);

  return (
    <div className="rs-machines-declare">
      <ul className="rs-machines-gap">
        {capabilities.map((one) => (
          <li key={one.id}>
            <strong>{one.name}</strong>
            {one.taughtBy.length > 0 ? (
              <span className="rs-hint"> — developed by {one.taughtBy.join(', ')}</span>
            ) : (
              <span className="rs-hint"> — nothing on the ladder develops this yet</span>
            )}
          </li>
        ))}
      </ul>
      <label>
        Which capability
        <select value={chosen} onChange={(event) => setChosen(event.target.value)}>
          {capabilities.map((one) => (
            <option key={one.id} value={one.id}>
              {one.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        How this company came to hold it
        <textarea
          value={note}
          rows={2}
          placeholder="What was hired, bought, built or delivered."
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <button type="button" disabled={busy || note.trim().length === 0} onClick={submit}>
        Record as held
      </button>
      {problem ? <p className="rs-machines-warn">{problem}</p> : null}
    </div>
  );
}

function NowResearching({ view }: { view: ProgrammeView }): JSX.Element {
  return (
    <section className="rs-card rs-machines-now">
      <h3>Research</h3>
      {view.open.length === 0 ? (
        <p className="rs-hint">No question is running.</p>
      ) : (
        <ul className="rs-machines-open">
          {view.open.map((one) => (
            <li key={one.id}>
              <span className="rs-machines-purpose">{one.purpose}</span> round {one.round}
            </li>
          ))}
        </ul>
      )}
      {view.plan.asks.length > 0 ? (
        <>
          <h4>Next</h4>
          <ul className="rs-machines-asks">
            {view.plan.asks.map((one) => (
              <li key={`${one.purpose}-${one.subject}`}>
                <span className="rs-machines-purpose">{one.purpose}</span> {one.subject}
                <p className="rs-hint">{one.why}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {view.plan.declined.length > 0 ? (
        <details className="rs-machines-declined">
          <summary>Considered and not asked ({view.plan.declined.length})</summary>
          <ul>
            {view.plan.declined.map((one, index) => (
              <li key={`${one.subject}-${index}`}>
                {one.subject} — <span className="rs-hint">{one.why}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {view.refusals.length > 0 ? (
        <details className="rs-machines-refusals">
          <summary>Declarations Brain could not file ({view.refusals.length})</summary>
          <ul>
            {view.refusals.map((one) => (
              <li key={one.claimId}>
                <code>{one.claimId}</code> — <span className="rs-hint">{one.why}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function Ladder({ view }: { view: ProgrammeView }): JSX.Element {
  return (
    <section className="rs-card rs-machines-ladder">
      <h3>Categories</h3>
      {view.ladder.length === 0 ? (
        <p className="rs-hint">Nothing is on the ladder yet.</p>
      ) : null}
      {view.ladder.map((reading) => (
        <article key={reading.categoryId} className="rs-machines-category">
          <header>
            <h4>{reading.path.join(' → ')}</h4>
            <span className={`rs-machines-verdict rs-machines-verdict-${reading.verdict}`}>
              {VERDICT_LABEL[reading.verdict] ?? reading.verdict}
            </span>
          </header>
          {/* The server's own sentence, never one composed here. */}
          <p className="rs-machines-because">{reading.because}</p>
          <ul className="rs-machines-conditions">
            {reading.conditions.map((condition) => (
              <li key={condition.condition} className={`rs-machines-${condition.answer}`}>
                <span className="rs-machines-answer">{ANSWER_LABEL[condition.answer]}</span>{' '}
                {CONDITION_LABEL[condition.condition] ?? condition.condition}
                <p className="rs-hint">{condition.because}</p>
              </li>
            ))}
          </ul>
          <div className="rs-machines-capsplit">
            <div>
              <h5>Required, and held</h5>
              {reading.held.length === 0 ? (
                <p className="rs-hint">None recorded.</p>
              ) : (
                <ul>
                  {reading.held.map((one) => (
                    <li key={one.id}>
                      {one.name}
                      {one.heldNote ? <span className="rs-hint"> — {one.heldNote}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h5>Required, and not held</h5>
              {reading.missing.length === 0 ? (
                <p className="rs-hint">None outstanding.</p>
              ) : (
                <ul>
                  {reading.missing.map((gap) => (
                    <li key={gap.capability.id}>
                      {gap.capability.name}
                      {gap.taughtBy.length > 0 ? (
                        <span className="rs-hint">
                          {' '}
                          — developed by {gap.taughtBy.map((one) => one.name).join(', ')}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {reading.barriers.length > 0 ? (
            <p className="rs-hint">Must be obtained first: {reading.barriers.join(', ')}</p>
          ) : null}
        </article>
      ))}
    </section>
  );
}

/**
 * The capability ledger, and what holding each one would unlock.
 *
 * `requiredBy` is the answer to *what does this unlock* and it is derived from
 * the same edges the chain is, so it moves the moment a category establishes
 * that it needs something.
 */
function Ledger({ view }: { view: ProgrammeView }): JSX.Element {
  return (
    <section className="rs-card rs-machines-ledger">
      <h3>Capabilities</h3>
      <p className="rs-hint">
        What published sources say producing a machine requires is research. Whether this
        company holds it is not — no claim can establish that, and nothing here infers it.
      </p>
      {view.capabilities.length === 0 ? (
        <p className="rs-hint">The ledger is empty.</p>
      ) : (
        <ul className="rs-machines-caps">
          {view.capabilities.map(({ capability, requiredBy, taughtBy }) => (
            <li key={capability.id}>
              <span
                className={
                  capability.heldAt ? 'rs-machines-held' : 'rs-machines-notheld'
                }
              >
                {capability.heldAt ? 'held' : 'not held'}
              </span>{' '}
              <strong>{capability.name}</strong>
              {capability.heldNote ? (
                <p className="rs-hint">
                  Recorded by a person: {capability.heldNote}
                </p>
              ) : null}
              {requiredBy.length > 0 ? (
                <p className="rs-hint">Unlocks: {requiredBy.map((one) => one.name).join(', ')}</p>
              ) : null}
              {taughtBy.length > 0 ? (
                <p className="rs-hint">
                  Developed by: {taughtBy.map((one) => one.name).join(', ')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Every round ever asked, including the barren ones.
 *
 * A round that found nothing is a reading of a market. Dropping it would make
 * the history look like it had only ever been productive, which is the shape of
 * encouragement §29 refuses.
 */
function History({ view }: { view: ProgrammeView }): JSX.Element {
  return (
    <section className="rs-card rs-machines-history">
      <h3>Rounds</h3>
      {view.history.length === 0 ? (
        <p className="rs-hint">Nothing has been asked yet.</p>
      ) : (
        <table className="rs-machines-rounds">
          <thead>
            <tr>
              <th scope="col">Question</th>
              <th scope="col">About</th>
              <th scope="col">State</th>
              <th scope="col">Found</th>
            </tr>
          </thead>
          <tbody>
            {view.history.map((one) => (
              <tr key={one.id} className={one.barren ? 'rs-machines-barren' : undefined}>
                <td>
                  {one.purpose} {one.round > 1 ? `(round ${one.round})` : ''}
                </td>
                <td>{one.subject ?? 'the machines themselves'}</td>
                <td>{one.state}</td>
                <td>
                  {/* Null while OPEN rather than 0: not counted yet and nothing
                      found are different facts. */}
                  {one.found === null ? 'not counted yet' : one.found}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

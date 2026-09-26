/**
 * The industry map (§38), as a person reads it.
 *
 * ---------------------------------------------------------------------------
 * Every sentence on this screen is the server's
 * ---------------------------------------------------------------------------
 *
 * Nothing here re-derives a verdict, composes a reason of its own, or scores
 * anything. `services/industry/view.ts` already says why a subject ranks
 * where it does, what would have to become true, and why an opening's capital
 * requirement is or is not established — this screen renders those sentences
 * verbatim, the way `client/src/russell/Labor.tsx` renders §13's readings.
 *
 * ---------------------------------------------------------------------------
 * What this screen must not do
 * ---------------------------------------------------------------------------
 *
 * **It must not render an unknown as a zero or a dash.** A capital row whose
 * `executableNow` is `UNKNOWN`, or whose `minimumOwnerCents` is null, has no
 * established figure — it renders the server's own unknown reason instead of a
 * currency figure, never nought and never a placeholder that could be read as
 * one. A settled bootstrap round with `found: null` reads "not counted yet",
 * never zero.
 *
 * **It must not hide a retired subject.** A subject a person retired keeps its
 * row and its reason, exactly where the ledger keeps every other decision.
 *
 * **It must not hardcode a kind.** The seed form's options come from
 * `vocabulary.industryNodeKinds`, sent with the reading, so the set a person
 * may choose from and the set the route validates against are one object.
 *
 * ---------------------------------------------------------------------------
 * Which controls exist, and why they are disabled rather than removed
 * ---------------------------------------------------------------------------
 *
 * Naming a subject and retiring one are both project `ADMIN` — the same split
 * `services/industry/access.ts` composes and `services/labor/access.ts`
 * argues for in full. `capabilities` comes from the server rather than being
 * derived here, because the browser holds one role flag and every decision on
 * this screen is a project-level one. A control somebody may not use stays in
 * the document with its inputs disabled and the server's own reason rendered
 * beside it — never swapped away — because a screen with a different shape per
 * reader is how "there is no button" and "the button is not for you" become
 * indistinguishable.
 */
import { useCallback, useState } from 'react';
import { useAsync } from './useAsync.ts';
import {
  getIndustryView,
  seedIndustrySubject,
  retireIndustrySubject,
} from '../lib/industryApi.ts';
import type {
  IndustryView as IndustryViewData,
  IndustrySubjectView,
  IndustryCapitalView,
} from '../lib/industryApi.ts';

/**
 * A closed-set value as a person reads it.
 *
 * Presentation only, and a fallback rather than a dictionary: a value this
 * screen has never heard of renders as its own words with the underscores
 * taken out, so a vocabulary that grows on the server never leaves a blank.
 */
function words(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Minor units as a figure. Two decimal places, matching the server's own
 * rendering rather than guessing an exponent per currency.
 */
function money(minor: number): string {
  const whole = Math.trunc(minor / 100);
  const rest = Math.abs(minor % 100);
  return `${whole.toLocaleString('en-US')}.${String(rest).padStart(2, '0')}`;
}

export function IndustryView({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync<IndustryViewData | null>(
    async () => (projectId ? await getIndustryView(projectId) : null),
    [projectId],
  );

  if (!projectId) {
    return <p className="rs-empty">Open a project to see its industry map.</p>;
  }
  /*
   * A re-read leaves the previous answer up until the new one arrives, for
   * §29's reason: replacing the whole screen with a placeholder on reload
   * would unmount a form a person was part-way through.
   */
  if (query.loading && !query.data) {
    return <p className="rs-empty">Reading the industry map…</p>;
  }
  /*
   * The server's own sentence, whatever the status. A 404 here is absent or
   * forbidden and the route refuses both with the same body on purpose —
   * invariant 23 — so this branch says what the server said rather than
   * guessing which one it was.
   */
  if (query.error) {
    return <p className="rs-empty">{query.error.message}</p>;
  }
  const view = query.data;
  if (!view) return <p className="rs-empty">Reading the industry map…</p>;

  return (
    <div className="rs-stack rs-industry">
      <Header view={view} />
      <Bootstrap view={view} />
      <Subjects view={view} projectId={projectId} reload={query.reload} />
      <Retired view={view} />
      <NextAndDeclined view={view} />
      <CapitalSection view={view} />
      <SeedSubject view={view} projectId={projectId} reload={query.reload} />
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function Header({ view }: { view: IndustryViewData }): JSX.Element {
  const kinds = Object.entries(view.byKind);
  return (
    <section className="rs-card rs-industry-header">
      <h3>The industry map</h3>
      <p className="rs-hint">
        {view.subjects.length} live subject{view.subjects.length === 1 ? '' : 's'}
        {view.retired.length > 0
          ? `, ${view.retired.length} retired`
          : ''}{' '}
        &middot; deployable {money(view.deployableCents)}
      </p>
      {kinds.length > 0 ? (
        <p className="rs-hint">
          {kinds.map(([kind, count]) => `${count} ${words(kind)}`).join(' · ')}
        </p>
      ) : null}
    </section>
  );
}

function Bootstrap({ view }: { view: IndustryViewData }): JSX.Element {
  return (
    <section className="rs-card rs-industry-bootstrap">
      <h3>Starting the map</h3>
      <p className="rs-hint">
        {!view.bootstrap.asked
          ? 'The map has not been started.'
          : view.bootstrap.open
            ? 'The starting question is live now.'
            : `The starting question settled: ${
                view.bootstrap.found === null ? 'not counted yet' : `${view.bootstrap.found} found`
              }.`}
      </p>
    </section>
  );
}

/** One subject's whole reading. Never a score — named facts, in the server's words. */
function Subject({ subject }: { subject: IndustrySubjectView }): JSX.Element {
  return (
    <>
      <h4>{subject.path.length > 0 ? subject.path.join(' → ') : subject.name}</h4>
      <p className="rs-hint">
        <strong>{words(subject.kind)}</strong> &mdash; {words(subject.origin)}
      </p>
      <p className="rs-hint">
        <strong>{words(subject.verdict)}</strong> &mdash; {subject.because}
      </p>
      {subject.description ? <p className="rs-hint">{subject.description}</p> : null}
      <p className="rs-hint">
        {subject.children} {subject.children === 1 ? 'child' : 'children'} &middot;{' '}
        {subject.openings} {subject.openings === 1 ? 'opening' : 'openings'} &middot;{' '}
        {subject.constraints} {subject.constraints === 1 ? 'constraint' : 'constraints'}
      </p>
      <p className="rs-hint">
        {subject.mapRounds} map round{subject.mapRounds === 1 ? '' : 's'} &middot;{' '}
        {subject.scanRounds} scan round{subject.scanRounds === 1 ? '' : 's'}
        {subject.live ? ' — a question is live right now' : ''}
      </p>
      <p className="rs-hint">
        Asked {subject.bucketsAsked} of {subject.bucketsTotal} ways of being paid
        {subject.lastAskedAt ? `, last asked ${subject.lastAskedAt}` : ''}
      </p>
      {subject.retiredAt ? (
        <p className="rs-hint rs-industry-retired-line">
          Retired {subject.retiredAt}
          {subject.retiredReason ? `: ${subject.retiredReason}` : ''}
        </p>
      ) : null}
    </>
  );
}

function Subjects({
  view,
  projectId,
  reload,
}: {
  view: IndustryViewData;
  projectId: string;
  reload(): void;
}): JSX.Element {
  return (
    <section className="rs-card rs-industry-subjects">
      <h3>Subjects</h3>
      {view.subjects.length === 0 ? (
        <p className="rs-empty">Nothing is on the map yet.</p>
      ) : (
        <ul>
          {view.subjects.map((subject) => (
            <li key={subject.id} className="rs-industry-subject">
              <Subject subject={subject} />
              <RetireSubject
                subject={subject}
                projectId={projectId}
                capabilities={view.capabilities}
                reload={reload}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Retired({ view }: { view: IndustryViewData }): JSX.Element | null {
  if (view.retired.length === 0) return null;
  return (
    <section className="rs-card rs-industry-retired-section">
      <h3>Retired</h3>
      <p className="rs-hint">
        Put away rather than deleted: its evidence, its children and every round ever run against
        it are exactly where they were.
      </p>
      <ul>
        {view.retired.map((subject) => (
          <li key={subject.id} className="rs-industry-subject">
            <Subject subject={subject} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function NextAndDeclined({ view }: { view: IndustryViewData }): JSX.Element {
  return (
    <section className="rs-card rs-industry-next">
      <h3>What Brain would ask next</h3>
      <p className="rs-hint">Reading this creates nothing.</p>
      {view.next.length === 0 ? (
        <p className="rs-empty">Nothing is queued.</p>
      ) : (
        <ul>
          {view.next.map((one, index) => (
            <li key={index}>
              <strong>{one.subject}</strong> ({words(one.purpose)}) &mdash; {one.why}
            </li>
          ))}
        </ul>
      )}
      {view.declined.length > 0 ? (
        <>
          <h4>Declined</h4>
          <ul>
            {view.declined.map((one, index) => (
              <li key={index}>
                <strong>{one.subject}</strong> &mdash; {one.why}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/** One opening's capital requirement, taken apart. Never a figure this kernel did not establish. */
function Capital({ row }: { row: IndustryCapitalView }): JSX.Element {
  const priced = row.executableNow !== 'UNKNOWN' && row.minimumOwnerCents !== null;
  return (
    <li className="rs-industry-capital">
      <h4>{row.title}</h4>
      <p className="rs-hint">
        {priced
          ? `Minimum owner capital: ${money(row.minimumOwnerCents as number)}`
          : row.unknown
            ? words(row.unknown)
            : 'Not established.'}
        {row.tier ? ` (${words(row.tier)})` : ''}
      </p>
      <p className="rs-hint">
        <strong>
          {row.executableNow === 'YES'
            ? 'Executable now'
            : row.executableNow === 'NO'
              ? 'Not executable now'
              : 'Not established whether this is executable now'}
        </strong>
      </p>
      {row.requirements.length > 0 ? (
        <ul>
          {row.requirements.map((requirement, index) => (
            <li key={index}>
              {requirement.requirement}
              {requirement.grossCents !== null
                ? ` — gross ${money(requirement.grossCents)}`
                : ' — no published figure'}
              {requirement.netCents !== null ? `, net ${money(requirement.netCents)}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {row.mechanisms.length > 0 ? (
        <p className="rs-hint">Mechanisms: {row.mechanisms.map(words).join(', ')}</p>
      ) : null}
      {row.removedCents !== null ? (
        <p className="rs-hint">Removed: {money(row.removedCents)}</p>
      ) : null}
      {row.cashNow.facts.length > 0 || row.cashNow.unknown.length > 0 ? (
        <div>
          <h5>Cash now</h5>
          {row.cashNow.facts.length > 0 ? (
            <ul>
              {row.cashNow.facts.map((fact, index) => (
                <li key={index}>{fact}</li>
              ))}
            </ul>
          ) : null}
          {row.cashNow.unknown.length > 0 ? (
            <ul className="rs-hint">
              {row.cashNow.unknown.map((one, index) => (
                <li key={index}>Unknown: {one}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {row.positionLater.facts.length > 0 || row.positionLater.unknown.length > 0 ? (
        <div>
          <h5>Position later</h5>
          {row.positionLater.facts.length > 0 ? (
            <ul>
              {row.positionLater.facts.map((fact, index) => (
                <li key={index}>{fact}</li>
              ))}
            </ul>
          ) : null}
          {row.positionLater.unknown.length > 0 ? (
            <ul className="rs-hint">
              {row.positionLater.unknown.map((one, index) => (
                <li key={index}>Unknown: {one}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {row.constraints.length > 0 ? (
        <p className="rs-hint">Constraints: {row.constraints.join('; ')}</p>
      ) : null}
    </li>
  );
}

function CapitalSection({ view }: { view: IndustryViewData }): JSX.Element {
  return (
    <section className="rs-card rs-industry-capital-section">
      <h3>What entering would cost</h3>
      {view.capital.length === 0 ? (
        <p className="rs-empty">Nothing has had its capital requirement taken apart yet.</p>
      ) : (
        <ul>
          {view.capital.map((row) => (
            <Capital key={row.opportunityId} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Retiring is reversible in exactly the sense the domain allows: nothing is
 * destroyed, so there is no un-retire here — only a reason recorded once.
 */
function RetireSubject({
  subject,
  projectId,
  capabilities,
  reload,
}: {
  subject: IndustrySubjectView;
  projectId: string;
  capabilities: IndustryViewData['capabilities'];
  reload(): void;
}): JSX.Element | null {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  if (subject.retiredAt) return null;
  const allowed = capabilities.mayRetire;

  const submit = useCallback(() => {
    if (busy || reason.trim().length === 0) return;
    setBusy(true);
    setProblem(null);
    retireIndustrySubject(projectId, subject.id, reason).then(
      (answer) => {
        setBusy(false);
        setSaid(answer.message);
        setReason('');
        reload();
      },
      (error: unknown) => {
        setBusy(false);
        setProblem(describe(error));
      },
    );
  }, [busy, reason, projectId, subject.id, reload]);

  return (
    <div className="rs-industry-retire">
      <label>
        <span className="rs-field-label">Retire, and say why</span>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={!allowed || busy}
          placeholder="Why this is a dead end"
        />
      </label>
      <button type="button" disabled={!allowed || busy || reason.trim().length === 0} onClick={submit}>
        {busy ? 'Retiring…' : 'Retire'}
      </button>
      {!allowed ? <p className="rs-hint rs-industry-locked">{capabilities.because}</p> : null}
      {problem ? <p className="rs-hint rs-industry-problem">{problem}</p> : null}
      {said ? <p className="rs-hint rs-industry-said">{said}</p> : null}
    </div>
  );
}

/**
 * Naming a subject the enumeration could not produce. `SEED` is the one
 * origin Brain itself may never write, so this is a person's decision start
 * to finish — and it spends nothing and starts nothing on its own.
 */
function SeedSubject({
  view,
  projectId,
  reload,
}: {
  view: IndustryViewData;
  projectId: string;
  reload(): void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [kind, setKind] = useState(view.vocabulary.industryNodeKinds[0] ?? '');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const allowed = view.capabilities.maySeed;

  const submit = useCallback(() => {
    if (busy || name.trim().length === 0) return;
    setBusy(true);
    setProblem(null);
    seedIndustrySubject(projectId, {
      name,
      kind: kind || undefined,
      description: description.trim() || undefined,
      parentId: parentId || undefined,
      reason: reason.trim() || undefined,
    }).then(
      (answer) => {
        setBusy(false);
        setSaid(answer.message);
        setName('');
        setDescription('');
        setReason('');
        reload();
      },
      (error: unknown) => {
        setBusy(false);
        setProblem(describe(error));
      },
    );
  }, [busy, name, kind, description, parentId, reason, projectId, reload]);

  return (
    <section className="rs-card rs-industry-seed">
      <h3>Name a subject</h3>
      <p className="rs-hint">
        Brain never writes one of these itself. A subject is on the map because a person named it
        or because a gated claim declared it.
      </p>
      {!allowed && view.capabilities.because ? (
        <p className="rs-hint rs-industry-locked">{view.capabilities.because}</p>
      ) : null}
      <div className="rs-industry-form">
        <label>
          <span className="rs-field-label">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={!allowed || busy}
          />
        </label>
        <label>
          <span className="rs-field-label">Kind</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            disabled={!allowed || busy}
          >
            {view.vocabulary.industryNodeKinds.map((one) => (
              <option key={one} value={one}>
                {words(one)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="rs-field-label">Parent (optional)</span>
          <select
            value={parentId}
            onChange={(event) => setParentId(event.target.value)}
            disabled={!allowed || busy}
          >
            <option value="">No parent — a root subject</option>
            {view.subjects.map((one) => (
              <option key={one.id} value={one.id}>
                {one.path.length > 0 ? one.path.join(' → ') : one.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="rs-field-label">Description (optional)</span>
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={!allowed || busy}
          />
        </label>
        <label>
          <span className="rs-field-label">Why (optional)</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={!allowed || busy}
          />
        </label>
        <p className="rs-industry-actions">
          <button
            type="button"
            disabled={!allowed || busy || name.trim().length === 0}
            onClick={submit}
          >
            {busy ? 'Naming…' : 'Name it'}
          </button>
        </p>
      </div>
      {problem ? <p className="rs-hint rs-industry-problem">{problem}</p> : null}
      {said ? <p className="rs-hint rs-industry-said">{said}</p> : null}
    </section>
  );
}

/**
 * The cross-border dealflow kernel (§45), as a person reads it.
 *
 * ---------------------------------------------------------------------------
 * Every sentence here is the server's
 * ---------------------------------------------------------------------------
 *
 * `dealflowView` and `dealDetail` (server/services/dealflow/view.ts) already
 * refuse to compose a score, a percentage or a probability anywhere in the
 * kernel — a deal is described by its established and outstanding facts, never
 * by a number derived from them. This screen keeps that refusal: nothing here
 * ranks a deal, rates a party or turns a payment schedule into a day count.
 *
 * `transactionValueCents` renders as a figure only when the server sent one;
 * the deal's own established/outstanding lists already say why it is missing
 * when it is not, so no reason is composed here. `ourRevenueCents` is always
 * null and is never rendered as a number — `ourRevenueNote` is, verbatim,
 * every time. `paidWhen` is the server's own words about when a structure
 * normally pays, or nothing at all; it is never turned into a number of days,
 * because Brain holds no lead time or sailing schedule to compose one from.
 *
 * ---------------------------------------------------------------------------
 * Which controls exist, and why they are disabled rather than removed
 * ---------------------------------------------------------------------------
 *
 * Seeding a party, retiring one and recording an observation are all project
 * `ADMIN` server-side (`services/dealflow/access.ts`). The browser holds one
 * role flag and every one of these decisions is a project-level one, so it is
 * not derived here — `capabilities.mayAdminister` comes down with the view,
 * exactly as `Labor.tsx` and `Machines.tsx` already do it, and a control
 * somebody may not use is disabled with an explanatory sentence rather than
 * removed (§35): a screen that removes it has a different shape per reader.
 *
 * Every kind option in the two forms is read from `vocabulary.partyKinds` /
 * `vocabulary.observationKinds`, which travel with the reading rather than
 * being restated here — a second copy is the one that drifts the day the
 * server's set changes.
 *
 * ---------------------------------------------------------------------------
 * Nothing here acts on a deal
 * ---------------------------------------------------------------------------
 *
 * Seeding a party spends nothing and starts nothing: it creates a row, and the
 * allocator, the discovery grant and the evidence gate decide the rest.
 * Recording an observation is the same. Nothing on this screen contacts
 * anybody, quotes anybody or commits anything — acting on a deal, once one is
 * promoted, happens on the Cash page's own commercial-action routes, which
 * this file does not read or write.
 */
import { useState } from 'react';
import { useAsync } from './useAsync.ts';
import { DealflowApi, type DealObservationKind, type DealPartyKind } from '../lib/dealflowApi.ts';

type DealflowViewReading = Awaited<ReturnType<typeof DealflowApi.view>>;

/** Cents to a readable amount. Presentation only; no arithmetic happens here. */
function money(cents: number, currency: string): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}${currency} ${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** A closed-set value as a person reads it, never a dictionary that can miss one. */
function words(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A control somebody may not use, disabled with an explanatory sentence.
 *
 * `DealflowCapabilities` carries only the boolean — there is no per-request
 * `because` sentence the way `Labor.tsx`'s does — so the sentence is fixed and
 * factual rather than composed from anything the server sent, matching the
 * plain no-grant sentences already used elsewhere on this shell (for example
 * `Cash.tsx`'s `Authority` "no grant" branch).
 */
function Locked(): JSX.Element {
  return (
    <p className="rs-hint">
      Seeding a party, retiring one and recording an observation are a project administrator's
      decision here — the same level the route itself requires. Reading everything below is not
      restricted.
    </p>
  );
}

export function DealflowScreen({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync<DealflowViewReading | null>(
    async () => (projectId ? await DealflowApi.view(projectId) : null),
    [projectId],
  );

  if (!projectId) {
    return <p className="rs-empty">Open a project to see its cross-border dealflow.</p>;
  }
  /*
   * A re-read leaves the previous answer up until the new one arrives — the
   * same reason `Labor.tsx` gives: reloading must not unmount a form somebody
   * is part-way through filling in.
   */
  if (query.loading && !query.data) {
    return <p className="rs-empty">Reading the dealflow kernel…</p>;
  }
  /*
   * The server's own sentence, whatever the status. A deal or a project in
   * somebody else's operation must not be distinguishable from one that never
   * existed — invariant 23 — so this never says "empty" or "forbidden" of its
   * own accord.
   */
  if (query.error) {
    return <p className="rs-empty">{query.error.message}</p>;
  }
  const view = query.data;
  if (!view) return <p className="rs-empty">Reading the dealflow kernel…</p>;

  return (
    <div className="rs-stack rs-dealflow">
      <Header view={view} />
      {view.gate ? <p className="rs-hint rs-dealflow-gate">{view.gate}</p> : null}
      <Categories view={view} />
      <Markets view={view} />
      <Parties
        title="Buyers"
        kind="BUYER"
        parties={view.buyers}
        projectId={projectId}
        mayAdminister={view.capabilities.mayAdminister}
        reload={query.reload}
      />
      <Parties
        title="Suppliers"
        kind="SUPPLIER"
        parties={view.suppliers}
        projectId={projectId}
        mayAdminister={view.capabilities.mayAdminister}
        reload={query.reload}
      />
      <SeedParty
        projectId={projectId}
        vocabulary={view.vocabulary}
        mayAdminister={view.capabilities.mayAdminister}
        reload={query.reload}
      />
      <Deals view={view} projectId={projectId} />
      <Questions view={view} />
      <Lessons view={view} />
      <RecordObservation
        projectId={projectId}
        deals={view.deals}
        vocabulary={view.vocabulary}
        mayAdminister={view.capabilities.mayAdminister}
        reload={query.reload}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function Header({ view }: { view: DealflowViewReading }): JSX.Element {
  const counts = view.counts;
  return (
    <section className="rs-card rs-dealflow-header">
      <h3>Cross-border dealflow</h3>
      <ul className="rs-dealflow-counts">
        <li>
          {counts.categories} equipment {counts.categories === 1 ? 'class' : 'classes'}
        </li>
        <li>
          {counts.buyers} buyer{counts.buyers === 1 ? '' : 's'}
        </li>
        <li>
          {counts.suppliers} supplier{counts.suppliers === 1 ? '' : 's'}
        </li>
        <li>
          {counts.deals} deal{counts.deals === 1 ? '' : 's'}
        </li>
        <li>{counts.outreachReady} ready for outreach</li>
        <li>{counts.blocked} blocked</li>
        <li>
          {counts.liveQuestions} of {counts.questionSlots} question slots live
        </li>
        <li>
          {counts.requirements} requirement{counts.requirements === 1 ? '' : 's'} on record
        </li>
        <li>{counts.costLines} published cost lines</li>
        <li>{counts.structures} structures with evidence</li>
        <li>
          {counts.observations} observation{counts.observations === 1 ? '' : 's'}
        </li>
      </ul>
    </section>
  );
}

function Categories({ view }: { view: DealflowViewReading }): JSX.Element | null {
  if (view.categories.length === 0) return null;
  return (
    <section className="rs-card rs-dealflow-categories">
      <h4>Equipment classes</h4>
      <ul className="rs-list">
        {view.categories.map((one) => (
          <li key={one.equipmentClass} className="rs-row">
            <span className="rs-item-title">{one.equipmentClass}</span>
            <span className="rs-item-meta">
              {one.buyers} buyer{one.buyers === 1 ? '' : 's'}, {one.suppliers} supplier
              {one.suppliers === 1 ? '' : 's'}, {one.deals} deal{one.deals === 1 ? '' : 's'}
              {one.markets.length > 0 ? ` — into ${one.markets.join(', ')}` : ''}
            </span>
            <span className="rs-item-meta">
              {one.costLines} cost line{one.costLines === 1 ? '' : 's'}, {one.attestedStructures}{' '}
              structure{one.attestedStructures === 1 ? '' : 's'} attested, {one.liveQuestions} live
              question{one.liveQuestions === 1 ? '' : 's'}
              {one.lastAskedAt ? ` — last asked ${one.lastAskedAt}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Markets({ view }: { view: DealflowViewReading }): JSX.Element | null {
  if (view.markets.length === 0) return null;
  return (
    <section className="rs-card rs-dealflow-markets">
      <h4>Markets</h4>
      <ul className="rs-list">
        {view.markets.map((one) => (
          <li key={one.destination} className="rs-row">
            <span className="rs-item-title">{one.destination}</span>
            <span className="rs-item-meta">
              {one.buyers} buyer{one.buyers === 1 ? '' : 's'}, {one.deals} deal
              {one.deals === 1 ? '' : 's'}
            </span>
            <ul className="rs-list">
              {one.envelopes.map((envelope) => (
                <li key={envelope.equipmentClass} className="rs-item-meta">
                  {envelope.equipmentClass}: {words(envelope.verdict)}
                  {envelope.unestablished > 0
                    ? ` (${envelope.unestablished} layer${envelope.unestablished === 1 ? '' : 's'} not yet researched)`
                    : ''}
                  <ul className="rs-list">
                    {envelope.layers.map((layer) => (
                      <li key={layer.layer}>
                        {words(layer.layer)}: {words(layer.reading)}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Parties({
  title,
  kind,
  parties,
  projectId,
  mayAdminister,
  reload,
}: {
  title: string;
  kind: DealPartyKind;
  parties: DealflowViewReading['buyers'];
  projectId: string;
  mayAdminister: boolean;
  reload(): void;
}): JSX.Element {
  return (
    <section className={`rs-card rs-dealflow-parties rs-dealflow-parties-${kind.toLowerCase()}`}>
      <h4>{title}</h4>
      {!mayAdminister ? <Locked /> : null}
      {parties.length === 0 ? (
        <p className="rs-empty">None on the map yet.</p>
      ) : (
        <ul className="rs-list">
          {parties.map((one) => (
            <li key={one.id} className="rs-row">
              <span className="rs-item-title">{one.name}</span>
              <span className="rs-item-meta">
                {one.equipmentClass}
                {one.country ? ` — ${one.country}` : ''} — {one.deals} deal
                {one.deals === 1 ? '' : 's'}
              </span>
              {one.decisionMaker ? (
                <span className="rs-item-meta">Decides the purchase: {one.decisionMaker}</span>
              ) : null}
              {one.note ? <span className="rs-item-meta">{one.note}</span> : null}
              {/*
                * `PartyView` carries no explicit origin column, and it does
                * not need one: the schema refuses a `DISCOVERED` row with no
                * claim (§45), so a null `sourceClaimId` can only mean a
                * person named this one — the same reading `PathDetail`
                * already gives a possibility's own origin in `Cash.tsx`.
                */}
              <span className="rs-item-meta">
                {one.sourceClaimId ? `Claim ${one.sourceClaimId}` : 'Somebody named this.'}
              </span>
              <RetireParty
                projectId={projectId}
                partyId={one.id}
                name={one.name}
                mayAdminister={mayAdminister}
                reload={reload}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RetireParty({
  projectId,
  partyId,
  name,
  mayAdminister,
  reload,
}: {
  projectId: string;
  partyId: string;
  name: string;
  mayAdminister: boolean;
  reload(): void;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (done) return <span className="rs-hint">{done}</span>;

  if (!asking) {
    /*
     * Disabled rather than removed when the grant does not cover it — §35's
     * rule, applied per row rather than once, because the section-level
     * `Locked` sentence above already carries the reason and repeating it on
     * every party would teach a reader to stop reading it.
     */
    return (
      <button
        type="button"
        className="rs-linklike"
        disabled={!mayAdminister}
        onClick={() => setAsking(true)}
      >
        Retire
      </button>
    );
  }

  return (
    <span className="rs-cash-actions">
      <label className="rs-field-label" htmlFor={`dealflow-retire-reason-${partyId}`}>
        Why {name} is a dead end
      </label>
      <input
        id={`dealflow-retire-reason-${partyId}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <button
        type="button"
        className="rs-button-quiet"
        disabled={busy || reason.trim().length === 0}
        onClick={() =>
          void (async () => {
            setBusy(true);
            setProblem(null);
            try {
              const answer = await DealflowApi.retireParty(projectId, partyId, reason.trim());
              setDone(answer.message);
              setAsking(false);
              reload();
            } catch (error) {
              setProblem(describeError(error));
            } finally {
              setBusy(false);
            }
          })()
        }
      >
        {busy ? 'Retiring…' : 'Confirm'}
      </button>
      <button type="button" className="rs-linklike" onClick={() => setAsking(false)}>
        Cancel
      </button>
      {problem ? <span className="rs-state rs-state-error">{problem}</span> : null}
    </span>
  );
}

function SeedParty({
  projectId,
  vocabulary,
  mayAdminister,
  reload,
}: {
  projectId: string;
  vocabulary: DealflowViewReading['vocabulary'];
  mayAdminister: boolean;
  reload(): void;
}): JSX.Element {
  const [kind, setKind] = useState<DealPartyKind>(vocabulary.partyKinds[0] ?? 'BUYER');
  const [name, setName] = useState('');
  const [equipmentClass, setEquipmentClass] = useState('');
  const [country, setCountry] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  return (
    <section className="rs-card rs-dealflow-seed-party">
      <h4>Name a party</h4>
      <p className="rs-hint">
        Seeding a party spends nothing and starts nothing: it creates a row, and Brain decides
        when to ask about it. Nobody is contacted by naming somebody here.
      </p>
      {!mayAdminister ? (
        <Locked />
      ) : (
        <>
          <label className="rs-field-label" htmlFor="dealflow-seed-kind">
            Which side of the transaction
          </label>
          <select
            id="dealflow-seed-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as DealPartyKind)}
          >
            {vocabulary.partyKinds.map((one) => (
              <option key={one} value={one}>
                {words(one)}
              </option>
            ))}
          </select>
          <label className="rs-field-label" htmlFor="dealflow-seed-name">
            Name
          </label>
          <input id="dealflow-seed-name" value={name} onChange={(event) => setName(event.target.value)} />
          <label className="rs-field-label" htmlFor="dealflow-seed-class">
            Equipment class
          </label>
          <input
            id="dealflow-seed-class"
            value={equipmentClass}
            onChange={(event) => setEquipmentClass(event.target.value)}
          />
          <label className="rs-field-label" htmlFor="dealflow-seed-country">
            Country, if known
          </label>
          <input
            id="dealflow-seed-country"
            value={country}
            onChange={(event) => setCountry(event.target.value)}
          />
          <label className="rs-field-label" htmlFor="dealflow-seed-note">
            Note, if any
          </label>
          <input id="dealflow-seed-note" value={note} onChange={(event) => setNote(event.target.value)} />
          <button
            type="button"
            className="rs-button-quiet"
            disabled={busy || name.trim().length === 0 || equipmentClass.trim().length === 0}
            onClick={() =>
              void (async () => {
                setBusy(true);
                setProblem(null);
                try {
                  const answer = await DealflowApi.seedParty(projectId, {
                    kind,
                    name: name.trim(),
                    equipmentClass: equipmentClass.trim(),
                    ...(country.trim().length > 0 ? { country: country.trim() } : {}),
                    ...(note.trim().length > 0 ? { note: note.trim() } : {}),
                  });
                  setDone(answer.message);
                  setName('');
                  setEquipmentClass('');
                  setCountry('');
                  setNote('');
                  reload();
                } catch (error) {
                  setProblem(describeError(error));
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            {busy ? 'Naming…' : 'Name them'}
          </button>
          {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
          {done ? <p className="rs-hint">{done}</p> : null}
        </>
      )}
    </section>
  );
}

function Deals({
  view,
  projectId,
}: {
  view: DealflowViewReading;
  projectId: string;
}): JSX.Element {
  return (
    <section className="rs-card rs-dealflow-deals">
      <h4>Deals</h4>
      {view.deals.length === 0 ? (
        <p className="rs-empty">Nothing has paired a buyer with a supplier yet.</p>
      ) : (
        <ol className="rs-list">
          {view.deals.map((deal) => (
            <li key={deal.id} className="rs-row">
              <span className="rs-item-title">
                {deal.buyer} &rarr; {deal.supplier}
              </span>
              <span className="rs-item-meta">
                {deal.equipmentClass}
                {deal.destination ? ` into ${deal.destination}` : ''} — {words(deal.stage)}
              </span>
              <p className="rs-item-meta">{deal.because}</p>
              {deal.transactionValueCents !== null && deal.currency ? (
                <p className="rs-item-meta">
                  Landed cost: {money(deal.transactionValueCents, deal.currency)}
                </p>
              ) : null}
              <p className="rs-item-meta">{deal.ourRevenueNote}</p>
              <p className="rs-item-meta">
                {deal.capitalNote}
                {deal.paidWhen ? ` ${deal.paidWhen}` : ''}
              </p>
              {deal.established.length > 0 ? (
                <div>
                  <span className="rs-item-meta">Established:</span>
                  <ul className="rs-list">
                    {deal.established.map((one) => (
                      <li key={one}>{one}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {deal.outstanding.length > 0 ? (
                <div>
                  <span className="rs-item-meta">Outstanding:</span>
                  <ul className="rs-list">
                    {deal.outstanding.map((one) => (
                      <li key={one}>{one}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {deal.blocker ? <p className="rs-state rs-state-error">{deal.blocker}</p> : null}
              {deal.nextAction ? <p className="rs-hint">{deal.nextAction}</p> : null}
              <p className="rs-item-meta">
                {deal.opportunityId
                  ? `Promoted as opportunity ${deal.opportunityId}.`
                  : 'Nothing has been created for this yet.'}
              </p>
              <DealDetail projectId={projectId} dealId={deal.id} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Everything recorded about one deal, fetched only on open.
 *
 * The list above already carries every field the manifest asks for at a
 * glance; this is the same "detail behind a disclosure" shape `PathDetail`
 * already uses in `Cash.tsx` — loading it for every deal on the page would be
 * paying for reads nobody asked for, and a failed fetch keeps its own words
 * rather than pretending the page is still loading.
 */
function DealDetail({ projectId, dealId }: { projectId: string; dealId: string }): JSX.Element {
  const [state, setState] = useState<
    | { kind: 'IDLE' }
    | { kind: 'LOADING' }
    | { kind: 'ERROR'; because: string }
    | { kind: 'READY'; detail: Awaited<ReturnType<typeof DealflowApi.dealDetail>> }
  >({ kind: 'IDLE' });

  async function open(): Promise<void> {
    if (state.kind === 'LOADING' || state.kind === 'READY') return;
    setState({ kind: 'LOADING' });
    try {
      setState({ kind: 'READY', detail: await DealflowApi.dealDetail(projectId, dealId) });
    } catch (error) {
      setState({ kind: 'ERROR', because: describeError(error) });
    }
  }

  return (
    <details
      className="rs-dealflow-deal-detail"
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) void open();
      }}
    >
      <summary>Everything recorded about this deal</summary>
      {state.kind === 'LOADING' ? <p className="rs-hint">Reading it…</p> : null}
      {state.kind === 'ERROR' ? <p className="rs-hint">{state.because}</p> : null}
      {state.kind === 'READY' && state.detail ? (
        <div>
          <h5>Compliance, all five layers</h5>
          <p className="rs-item-meta">{state.detail.reading.envelope.because}</p>
          <ul className="rs-list">
            {state.detail.reading.envelope.layers.map((layer) => (
              <li key={layer.layer}>
                <strong>{words(layer.layer)}</strong>: {words(layer.reading)}
                <p className="rs-item-meta">{layer.because}</p>
                {layer.remedy ? <p className="rs-hint">{layer.remedy}</p> : null}
              </li>
            ))}
          </ul>

          <h5>Landed cost, component by component</h5>
          <p className="rs-item-meta">{state.detail.reading.economics.because}</p>
          <ul className="rs-list">
            {state.detail.reading.economics.components.map((component) => (
              <li key={component.component}>
                <strong>{words(component.component)}</strong>:{' '}
                {component.amountCents !== null && component.currency
                  ? money(component.amountCents, component.currency)
                  : component.task ?? 'not established'}
                {component.basis ? <span className="rs-hint"> ({component.basis})</span> : null}
              </li>
            ))}
          </ul>

          <h5>Commercial structures</h5>
          <p className="rs-item-meta">{state.detail.reading.path.because}</p>
          <ul className="rs-list">
            {state.detail.reading.structures.map((option) => (
              <li key={option.profile.structure}>
                <strong>{words(option.profile.structure)}</strong>
                {option.attested ? ' — attested by a source' : ' — not attested here'}
                <p className="rs-item-meta">{option.profile.what}</p>
                <p className="rs-item-meta">Requires: {option.profile.requires}</p>
                <p className="rs-item-meta">Paid: {option.profile.paidWhen}</p>
                {option.rateNotes.length > 0 ? (
                  <ul className="rs-list">
                    {option.rateNotes.map((note, index) => (
                      <li key={index} className="rs-item-meta">
                        {note}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>

          {state.detail.reading.lessons.length > 0 ? (
            <>
              <h5>Lessons that bear on this deal</h5>
              <LessonList lessons={state.detail.reading.lessons} />
            </>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function Questions({ view }: { view: DealflowViewReading }): JSX.Element {
  return (
    <section className="rs-card rs-dealflow-questions">
      <h4>What Brain is asking</h4>
      {view.live.length === 0 ? (
        <p className="rs-empty">No question is open right now.</p>
      ) : (
        <ul className="rs-list">
          {view.live.map((one) => (
            <li key={one.id} className="rs-row">
              <span className="rs-item-title">
                {words(one.purpose)}: {one.subject}
              </span>
              <span className="rs-item-meta">
                round {one.round} — {words(one.state)} — {one.id}
              </span>
              <span className="rs-item-meta">
                {one.found === null ? 'not settled yet' : `found ${one.found}`} — opened{' '}
                {one.openedAt}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h5>What it would ask next</h5>
      {view.next.length === 0 ? (
        <p className="rs-empty">Nothing is queued.</p>
      ) : (
        <ul className="rs-list">
          {view.next.map((one, index) => (
            <li key={index} className="rs-item-meta">
              {words(one.purpose)}: {one.subject} — {one.why}
            </li>
          ))}
        </ul>
      )}

      {view.declined.length > 0 ? (
        <>
          <h5>Declined</h5>
          <ul className="rs-list">
            {view.declined.map((one, index) => (
              <li key={index} className="rs-item-meta">
                {one.subject} — {one.why}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function LessonList({ lessons }: { lessons: DealflowViewReading['lessons'] }): JSX.Element {
  return (
    <ul className="rs-list">
      {lessons.map((one, index) => (
        <li key={index} className="rs-row">
          <span className="rs-item-title">{words(one.kind)}</span>
          <span className="rs-item-meta">
            {one.equipmentClass ?? 'any class'}
            {one.jurisdiction ? ` — ${one.jurisdiction}` : ''}
          </span>
          <p className="rs-item-meta">{one.says}</p>
          <span className="rs-item-meta">
            {one.byPerson} from a person, {one.byBrain} from Brain — last seen {one.lastSeenAt}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Lessons({ view }: { view: DealflowViewReading }): JSX.Element | null {
  if (view.lessons.length === 0) return null;
  return (
    <section className="rs-card rs-dealflow-lessons">
      <h4>What has been learned</h4>
      <p className="rs-hint">
        These never gate a deal or a question. A pattern across a few attempts is worth telling a
        person about and is nowhere near evidence enough to stop the next one.
      </p>
      <LessonList lessons={view.lessons} />
    </section>
  );
}

function RecordObservation({
  projectId,
  deals,
  vocabulary,
  mayAdminister,
  reload,
}: {
  projectId: string;
  deals: DealflowViewReading['deals'];
  vocabulary: DealflowViewReading['vocabulary'];
  mayAdminister: boolean;
  reload(): void;
}): JSX.Element {
  const [kind, setKind] = useState<DealObservationKind>(vocabulary.observationKinds[0] ?? 'BUYER_RESPONDED');
  const [statement, setStatement] = useState('');
  const [dealId, setDealId] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');
  const [equipmentClass, setEquipmentClass] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  return (
    <section className="rs-card rs-dealflow-record-observation">
      <h4>Record what actually happened</h4>
      <p className="rs-hint">
        One observation. Whether several amount to a rule is derived when somebody reads them,
        with the sample size printed beside it — nothing here gates a deal or skips a question.
      </p>
      {!mayAdminister ? (
        <Locked />
      ) : (
        <>
          <label className="rs-field-label" htmlFor="dealflow-obs-kind">
            What kind of outcome
          </label>
          <select
            id="dealflow-obs-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as DealObservationKind)}
          >
            {vocabulary.observationKinds.map((one) => (
              <option key={one} value={one}>
                {words(one)}
              </option>
            ))}
          </select>
          <label className="rs-field-label" htmlFor="dealflow-obs-statement">
            What happened
          </label>
          <input
            id="dealflow-obs-statement"
            value={statement}
            onChange={(event) => setStatement(event.target.value)}
          />
          <label className="rs-field-label" htmlFor="dealflow-obs-deal">
            Which deal, if any
          </label>
          <select
            id="dealflow-obs-deal"
            value={dealId}
            onChange={(event) => setDealId(event.target.value)}
          >
            <option value="">Not about one deal in particular</option>
            {deals.map((one) => (
              <option key={one.id} value={one.id}>
                {one.buyer} &rarr; {one.supplier}
              </option>
            ))}
          </select>
          <label className="rs-field-label" htmlFor="dealflow-obs-jurisdiction">
            Jurisdiction, if this is about one
          </label>
          <input
            id="dealflow-obs-jurisdiction"
            value={jurisdiction}
            onChange={(event) => setJurisdiction(event.target.value)}
          />
          <label className="rs-field-label" htmlFor="dealflow-obs-class">
            Equipment class, if this is about one
          </label>
          <input
            id="dealflow-obs-class"
            value={equipmentClass}
            onChange={(event) => setEquipmentClass(event.target.value)}
          />
          <button
            type="button"
            className="rs-button-quiet"
            disabled={busy || statement.trim().length === 0}
            onClick={() =>
              void (async () => {
                setBusy(true);
                setProblem(null);
                try {
                  const answer = await DealflowApi.recordObservation(projectId, {
                    kind,
                    statement: statement.trim(),
                    ...(dealId ? { dealId } : {}),
                    ...(jurisdiction.trim().length > 0 ? { jurisdiction: jurisdiction.trim() } : {}),
                    ...(equipmentClass.trim().length > 0
                      ? { equipmentClass: equipmentClass.trim() }
                      : {}),
                  });
                  setDone(answer.message);
                  setStatement('');
                  setDealId('');
                  setJurisdiction('');
                  setEquipmentClass('');
                  reload();
                } catch (error) {
                  setProblem(describeError(error));
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            {busy ? 'Recording…' : 'Record it'}
          </button>
          {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
          {done ? <p className="rs-hint">{done}</p> : null}
        </>
      )}
    </section>
  );
}

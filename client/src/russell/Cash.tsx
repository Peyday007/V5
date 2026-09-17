/**
 * Cash: one person's private sprint, and nobody else's.
 *
 * The five things §10 of the plan asks a person to be shown, in the order it
 * asks for them — my cash, my current work, what Brain has done, what Brain
 * needs, decisions for me — plus the one decision at the top that nothing can
 * proceed without.
 *
 * Three rules, and every one of them is a defect this repository has already
 * recorded somewhere else.
 *
 * **Nothing here derives a figure.** Every number comes from the server's own
 * projection. A screen that computed deployable cash would be a second opinion
 * about the same money, and the two would eventually disagree in the direction
 * that spends something.
 *
 * **Nothing here composes a sentence about a permission or a state.** The
 * authority's lines, the disposition's reason, the review item's consequence
 * and the lifecycle's message are all the server's words. A screen that
 * paraphrased a permission would eventually paraphrase it wrongly.
 *
 * **The status agrees with the control beside it.** Where an approval is
 * outstanding it is named first and never folded, and answering it goes back to
 * the server rather than optimistically redrawing — §29's rule, at the surface
 * that authorizes spending.
 */
import { useState } from 'react';
import { useAsync } from './useAsync.ts';
import {
  CashApi,
  type CashModeState,
  type CashReadiness,
  type CashView,
  type Placement,
  type ReviewItem,
} from '../lib/cashApi.ts';
import { ReadinessPanel } from './Readiness.tsx';

/**
 * What a round is really doing, in the words a person reads.
 *
 * The state column says OPEN until a round is harvested, which in production
 * meant ten rounds reading as research under way while every candidate was
 * parked and no work item existed. The server derives the real answer; this
 * only names it.
 */
const ROUND_ACTIVITY: Record<string, string> = {
  AWAITING_LAUNCH: 'captured, not started yet',
  PARKED: 'stopped',
  RESEARCHING: 'being researched now',
  ANSWERED: 'research finished',
};

const DISPOSITION_LABEL: Record<Placement['disposition'], string> = {
  EXECUTE_NOW: 'Execute now',
  RUN_IN_PARALLEL: 'Run in parallel',
  WAIT_FOR_DEPENDENCY: 'Wait for a named dependency',
  TEST_A_DECISIVE_UNKNOWN: 'Test a decisive unknown',
  ARCHIVED: 'Archived',
};

/** Cents to a readable amount. Presentation only; no arithmetic happens here. */
function money(cents: number, currency: string): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}${currency} ${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * A typed amount in ordinary money, as cents.
 *
 * Null when it is not a well-formed amount, which is what the control checks
 * rather than trying to guess what somebody meant. Commas and a leading
 * currency symbol are tolerated because people type them; anything else is
 * refused, because rounding an ambiguous string into a spending ceiling is the
 * wrong direction to be forgiving in.
 *
 * Presentation only. The API still takes cents and its guards are unchanged —
 * this is the conversion that stops a person being asked to do it in their
 * head, which is how $250 gets typed where 25000 was meant.
 */
function centsFromAmount(typed: string): number | null {
  const cleaned = typed.trim().replace(/^[^0-9.]+/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole = '0', fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/**
 * The section, over one chosen operation.
 *
 * `projectId` is the shell's current selection and is a **candidate**, not the
 * answer. It used to be the answer, which meant somebody with a broad Brain
 * project and a private cash project could be shown — and could activate — the
 * wrong one, because the shell hands out the first project a person can see. An
 * operation is what a sprint belongs to, so it is chosen here.
 */
export function CashView_({
  projectId: _shellProject,
  isBrainAdmin,
}: {
  projectId: string | null;
  /**
   * Whether to *offer* the invite control. It is a convenience and never the
   * control: the route refuses anybody else with the same 404 a missing one
   * gives, whatever this renders.
   */
  isBrainAdmin: boolean;
}): JSX.Element {
  /*
   * No operation is chosen, because there is nothing to choose between.
   *
   * This used to read a list of sprints and pick one — the shell's project if
   * it happened to have a sprint, otherwise the first the person had. That was
   * the four-operation model rendered: four frontiers, four objectives, and a
   * question in front of a person before anything could start. The server now
   * resolves the single root, so the shell's project is deliberately ignored.
   */
  const reading = useAsync(() => CashApi.mode(), []);
  const known = reading.data ?? null;
  const rootId = known?.root?.projectId ?? null;

  const view = useAsync(
    () => (rootId ? CashApi.view(rootId) : Promise.resolve(null as CashView | null)),
    [rootId],
  );

  if (!known) {
    return (
      <section className="rs-view rs-view-cash">
        <h2>Cash</h2>
        <p className="rs-state rs-state-loading">Reading Cash Mode&hellip;</p>
      </section>
    );
  }

  /*
   * Not started: no root at all, or a root with no sprint on it. Both are the
   * same thing to a person and get the same one-button card.
   */
  if (!known.mode) {
    return (
      <Activate
        objective={known.objective}
        currencies={known.currencies}
        readiness={known.readiness}
        isBrainAdmin={isBrainAdmin}
        onActivated={() => {
          reading.reload();
          view.reload();
        }}
      />
    );
  }

  /*
   * A re-read must not blank what is already showing.
   *
   * `loading` is true both when there is nothing yet and when the view is being
   * read again, and treating the second as "not ready" unmounts the section —
   * which is how Build lost an invitation that was shown once.
   */
  const data = view.data ?? null;

  if (view.error) {
    return (
      <section className="rs-view rs-view-cash">
        <h2>Cash</h2>
        <p className={`rs-state rs-state-${view.error.status === 404 ? 'forbidden' : 'error'}`}>
          {view.error.status === 404
            ? 'There is nothing here for you to see. That is the same answer a project that does not exist gives, on purpose.'
            : view.error.message}
          {view.error.status === 404 ? null : (
            <button type="button" onClick={view.reload}>
              Try again
            </button>
          )}
        </p>
      </section>
    );
  }

  /*
   * `known.mode` above says a sprint exists; this says the *view* has caught up
   * with it. Both are asked, because the two reads are separate requests and a
   * render between them would otherwise dereference a mode that is not there
   * yet — the same "loading is not the same as absent" distinction the error
   * branch above makes.
   */
  if (!data || !rootId || !data.mode) {
    return (
      <section className="rs-view rs-view-cash">
        <h2>Cash</h2>
        <p className="rs-state rs-state-loading">Reading the frontier&hellip;</p>
      </section>
    );
  }

  return (
    <section className="rs-view rs-view-cash">
      <h2>Cash</h2>
      {/*
        * Brain's mandate, not a sentence somebody typed. The short reading is
        * what is shown; the full text is on the element so it is always
        * reachable rather than paraphrased away.
        */}
      <p className="rs-lede" title={known.objective.full}>
        {known.objective.summary}
      </p>
      <p className="rs-hint">{data.discovery.reason}</p>

      <Decisions view={data} projectId={rootId} onChanged={view.reload} />
      <MoneyPicture view={data} />
      <MyCash view={data} />
      <CurrentWork view={data} onChanged={view.reload} />
      <Needs view={data} />
      <Roadmap view={data} />
      <Done view={data} />
      {/*
        * People and capacity, on the running sprint.
        *
        * It used to render only on the not-started card, so activating removed
        * the one entrance to inviting somebody — which made an activation state
        * decide an enrollment question it has nothing to do with. The two are
        * independent: people join a Brain whether or not a sprint is running,
        * and the counts stop nothing either way (§32). This is the *same*
        * component the activation card mounts, with the same routes behind it;
        * there is no second invitation path and nothing about enrollment
        * changed.
        */}
      <section className="rs-card rs-cash-people">
        <h3>People and capacity</h3>
        <p className="rs-hint">
          Counts, not gates. Anybody can be invited while the sprint runs, and a capacity
          account can be registered at any time; neither stops or starts the work below.
        </p>
        <ReadinessPanel readiness={known.readiness} isBrainAdmin={isBrainAdmin} />
      </section>
      <Lifecycle projectId={rootId} state={data.mode.state} onChanged={view.reload} />
    </section>
  );
}

/**
 * Cash Mode is not running yet.
 *
 * One button, and deliberately nothing else required.
 *
 * It used to ask two questions first: *which operation* — a picker over four
 * person-derived sprints — and *what is this account trying to produce*, a
 * required free-text objective with a 12-character floor. Both were wrong for
 * the same reason. There is one shared frontier, so there is no operation to
 * choose; and an objective typed into a box silently becomes a boundary the
 * Brain will not search past, made of whatever the person did not think to
 * write that morning. Nobody can see that omission afterwards.
 *
 * So the mandate is Brain's own and is shown rather than solicited, and the
 * constraints box is collapsed, optional, and **additive** — the server appends
 * it under a heading that keeps the standing mandate legible beside it.
 *
 * Starting it still takes one deliberate click, because activation is a
 * person's decision. It authorizes no spending: what Brain may do with money is
 * a separate grant, below, and this card cannot make one.
 */
function Activate({
  objective,
  currencies,
  readiness,
  isBrainAdmin,
  onActivated,
}: {
  objective: { summary: string; full: string };
  currencies: string[];
  readiness: CashReadiness;
  isBrainAdmin: boolean;
  onActivated(): void;
}): JSX.Element {
  const [currency, setCurrency] = useState(currencies[0] ?? 'USD');
  const [constraints, setConstraints] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await CashApi.start({
        ...(constraints.trim().length > 0 ? { constraints: constraints.trim() } : {}),
        currency,
      });
      onActivated();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rs-view rs-view-cash">
      <h2>Cash</h2>
      <div className="rs-card rs-cash-activate">
        <p className="rs-authority-headline">What Cash Mode does</p>
        <p className="rs-lede">{objective.summary}</p>
        <p className="rs-item-meta">Not started.</p>

        <p className="rs-hint">
          Starting this spends nothing and authorizes nothing. What Brain may do with money is a
          separate decision, and it is yours.
        </p>

        <ReadinessPanel readiness={readiness} isBrainAdmin={isBrainAdmin} />

        {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
        {/*
          * Readiness is reported above and does not gate this button.
          *
          * The four-of-four count was the owner's decision to wait for
          * everybody rather than a property of the system, and it has been
          * withdrawn — on the screen and on the route together, because a
          * button enabled against a route that still refused would be the
          * worse of the two failures. The panel above still says who cannot
          * sign in yet and which surfaces are unproven; it simply stops
          * nothing. The "not ready to start" sentence went with the lock: a
          * status contradicting the control beside it is §29's own defect.
          */}
        <button type="button" className="rs-button" disabled={busy} onClick={submit}>
          {busy ? 'Starting\u2026' : 'Start Cash Mode'}
        </button>

        <button
          type="button"
          className="rs-button-quiet"
          aria-expanded={showAdvanced}
          aria-controls="cash-advanced"
          onClick={() => setShowAdvanced((open) => !open)}
        >
          {showAdvanced ? 'Hide constraints' : 'Add constraints (optional)'}
        </button>
        {showAdvanced ? (
          <div id="cash-advanced">
            <label className="rs-field-label" htmlFor="cash-currency">
              The one currency this keeps its money in
            </label>
            <select
              id="cash-currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <p className="rs-hint">
              It holds exactly one. Brain does not choose an exchange rate, so an entry in another
              currency is refused rather than converted.
            </p>

            <label className="rs-field-label" htmlFor="cash-constraints">
              Anything to prioritise, rule out, or make Brain aware of
            </label>
            <textarea
              id="cash-constraints"
              rows={3}
              value={constraints}
              onChange={(event) => setConstraints(event.target.value)}
              placeholder="A deadline, a category to avoid, a resource you have, a budget change."
            />
            <p className="rs-hint">
              This is added to the mandate above, never substituted for it. Leaving it empty
              narrows nothing.
            </p>

            <details>
              <summary className="rs-field-label">The mandate in full</summary>
              <p className="rs-item-meta">{objective.full}</p>
            </details>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Decisions for me.
 *
 * Named first because the first of them is usually the one nothing can proceed
 * without. The compression is reported rather than claimed: the count of
 * underlying items each group stands for is on the screen.
 */
function Decisions({
  view,
  projectId,
  onChanged,
}: {
  view: CashView;
  projectId: string;
  onChanged(): void;
}): JSX.Element {
  return (
    <section className="rs-card rs-cash-decisions">
      <h3>Decisions for you</h3>
      <p className="rs-hint">{view.decisionsForMe.summary}</p>
      {/*
        * The approval is listed *or* rendered as its card, never both.
        *
        * The server names it first because nothing can proceed without it, and
        * the card below is the control that answers it. Rendering both put the
        * same sentence on the screen twice, one of them with no button — which
        * is the noisier half of §29's defect: a person learns to skim the list
        * because part of it repeats what is underneath.
        *
        * The condition is exactly the one that decides whether the card
        * renders, so the two can never disagree about which is showing it.
        */}
      {view.decisionsForMe.items.length === 0 ? null : (
        <ul className="rs-list">
          {view.decisionsForMe.items
            .filter((item) => !(item.key === 'AUTHORITY' && !view.authority.exists))
            .map((item) => (
              <li key={item.key} className={`rs-decision rs-decision-${item.urgency.toLowerCase()}`}>
                <p className="rs-item-title">{item.title}</p>
                <p className="rs-decision-why">{item.why}</p>
                <p className="rs-decision-what">{item.recommendation}</p>
                <p className="rs-choice-consequence">{item.consequence}</p>
                {item.costNote ? <p className="rs-item-meta">{item.costNote}</p> : null}
                {item.underlying.length > 0 ? (
                  <p className="rs-item-meta">
                    {/*
                      * "Stands for" and "covers" are different claims, and the
                      * server decides which. A group whose members share one
                      * remedy is answered once; one that merely shares a kind
                      * of work is a batch, and saying otherwise teaches a
                      * person to stop believing the counts.
                      */}
                    {item.sharedRemedy ? 'One answer covers' : 'The same kind of work on'}{' '}
                    {item.underlying.length} {item.underlying.length === 1 ? 'item' : 'items'}.
                  </p>
                ) : null}
                <DecisionAnswer item={item} view={view} onDone={onChanged} />
              </li>
            ))}
        </ul>
      )}
      <Authority view={view} projectId={projectId} onChanged={onChanged} />
    </section>
  );
}

/**
 * The control that answers one decision, and the honest absence of one.
 *
 * Every answer names an operation that already exists — the grant, closing a
 * need, releasing a commitment, filling a card. This renders the one the server
 * chose and composes none of its own; a screen that decided what answering
 * something meant would be a second opinion about one sprint.
 *
 * `NOTHING_TO_PRESS` renders as a sentence rather than a disabled button. An
 * expiring opening is worth putting in front of somebody and is answered by
 * taking it, and a button that only marked it read would be a control that
 * pretends to do something.
 */
function DecisionAnswer({
  item,
  view,
  onDone,
}: {
  item: ReviewItem;
  view: CashView;
  onDone(): void;
}): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [said, setSaid] = useState('');
  const [substitute, setSubstitute] = useState('');
  const [reference, setReference] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const kind = item.answer.kind;

  async function run(work: () => Promise<string>): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      setDone(await work());
      setAsking(false);
      setSaid('');
      setSubstitute('');
      setReference('');
      onDone();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /*
   * What the answer would actually touch, named before it is given.
   *
   * §29's rule about counts, one surface along: a control that says it releases
   * five and releases one teaches a person to stop believing the screen. The
   * server already says which rows an item stands for; this says it back.
   */
  const affects =
    item.answer.targets.length > 0 ? (
      <p className="rs-item-meta">
        This answer applies to {item.answer.targets.length}{' '}
        {item.answer.targets.length === 1 ? 'record' : 'records'}. Brain then checks it by
        reading: {item.answer.completionCondition}
      </p>
    ) : null;

  const outcome = done ? <p className="rs-state rs-state-ok">{done}</p> : null;
  const failure = problem ? <p className="rs-state rs-state-error">{problem}</p> : null;

  if (kind === 'NOTHING_TO_PRESS') {
    return (
      <>
        <p className="rs-item-meta">{item.answer.label}.</p>
        {affects}
      </>
    );
  }

  /*
   * The grant is answered by the card below, which is the control it *is*.
   *
   * The rest used to render as a sentence with the same excuse — that funding
   * and release controls existed elsewhere on the page — and they did not: the
   * money panel is a read-only table and the opportunity actions are
   * ready/execute/deliver/collect/decline. So every answer but one was a
   * paragraph telling somebody what to do somewhere that had no way to do it.
   */
  if (kind === 'GRANT_AUTHORITY') {
    return (
      <>
        <p className="rs-item-meta">{item.answer.label} — the card below is where.</p>
        {affects}
      </>
    );
  }

  const opportunityId = item.answer.targets[0] ?? null;

  return (
    <div className="rs-cash-actions">
      {affects}
      {!asking ? (
        <button type="button" className="rs-button-quiet" onClick={() => setAsking(true)}>
          {item.answer.label}
        </button>
      ) : null}

      {asking && kind === 'RESOLVE_NEED' ? (
        <>
          <label className="rs-field-label" htmlFor={`cash-answer-${item.key}`}>
            What did you do? Brain reads this back against: {item.answer.completionCondition}
          </label>
          <input
            id={`cash-answer-${item.key}`}
            value={said}
            onChange={(event) => setSaid(event.target.value)}
          />
          <label className="rs-field-label" htmlFor={`cash-instead-${item.key}`}>
            If the integration is still missing and you are doing this another way, say how.
            Brain records that rather than pretending the condition was met.
          </label>
          <input
            id={`cash-instead-${item.key}`}
            value={substitute}
            onChange={(event) => setSubstitute(event.target.value)}
          />
          <button
            type="button"
            className="rs-button-quiet"
            disabled={busy || said.trim().length === 0}
            onClick={() =>
              void run(async () => {
                for (const needId of item.answer.targets) {
                  await CashApi.closeNeed(
                    needId,
                    'RESOLVED',
                    said,
                    substitute.trim() || undefined,
                  );
                }
                return `Recorded against ${item.answer.targets.length} need${
                  item.answer.targets.length === 1 ? '' : 's'
                }.`;
              })
            }
          >
            {busy ? 'Recording…' : 'Confirm'}
          </button>
          <button type="button" className="rs-linklike" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </>
      ) : null}

      {asking && kind === 'FILL_CARD_FIELD' && opportunityId ? (
        <>
          <p className="rs-hint">
            {item.answer.targets.length === 1
              ? 'One card, one answer.'
              : `These are ${item.answer.targets.length} separate answers of the same kind. ` +
                'This answers the first; the rest are on their own cards.'}
          </p>
          <label className="rs-field-label" htmlFor={`cash-field-${item.key}`}>
            {item.title}
          </label>
          <input
            id={`cash-field-${item.key}`}
            value={said}
            onChange={(event) => setSaid(event.target.value)}
          />
          <button
            type="button"
            className="rs-button-quiet"
            disabled={busy || said.trim().length === 0}
            onClick={() =>
              void run(async () => {
                const field = item.key.replace(/^MISSING_/, '').toLowerCase();
                await CashApi.fillCard(opportunityId, { [CARD_PATCH_KEY[field] ?? field]: said });
                return 'Answered. It is yours now, so Brain will not propose over it.';
              })
            }
          >
            {busy ? 'Saving…' : 'Confirm'}
          </button>
          <button type="button" className="rs-linklike" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </>
      ) : null}

      {asking && kind === 'RECORD_MONEY' ? (
        <>
          <p className="rs-hint">
            Money that actually arrived. A settlement needs the bank or provider reference that
            makes it verifiable — a payment nobody can trace is pipeline, not cash.
          </p>
          <label className="rs-field-label" htmlFor={`cash-amount-${item.key}`}>
            How much, in {view.myCash.position.currency} cents
          </label>
          <input
            id={`cash-amount-${item.key}`}
            inputMode="numeric"
            value={said}
            onChange={(event) => setSaid(event.target.value)}
          />
          <label className="rs-field-label" htmlFor={`cash-ref-${item.key}`}>
            The reference it can be traced by
          </label>
          <input
            id={`cash-ref-${item.key}`}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
          <button
            type="button"
            className="rs-button-quiet"
            disabled={busy || !/^\d+$/.test(said.trim()) || reference.trim().length === 0}
            onClick={() =>
              void run(async () => {
                await CashApi.recordMoney(view.mode!.projectId, {
                  kind: 'CAPITAL_IN',
                  amountCents: Number(said.trim()),
                  currency: view.myCash.position.currency,
                  verifiedReference: reference.trim(),
                  // Built from what it records rather than from a clock, so a
                  // retry after a lost response is the same entry once.
                  idempotencyKey: `funding:${reference.trim()}`,
                });
                return 'Recorded. Deployable cash is recomputed from the ledger.';
              })
            }
          >
            {busy ? 'Recording…' : 'Confirm'}
          </button>
          <button type="button" className="rs-linklike" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </>
      ) : null}

      {asking && kind === 'RELEASE_COMMITMENT' ? (
        <>
          <p className="rs-hint">
            Releasing frees the money for something else. It is never released by a clock, so
            this is somebody saying it is not going to be spent.
          </p>
          {view.myCash.commitments.filter((one) => one.state === 'HELD').length === 0 ? (
            <p className="rs-item-meta">Nothing is held, so there is nothing to release.</p>
          ) : (
            <>
              <label className="rs-field-label" htmlFor={`cash-release-${item.key}`}>
                Which commitment
              </label>
              <select
                id={`cash-release-${item.key}`}
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              >
                <option value="">Choose one</option>
                {view.myCash.commitments
                  .filter((one) => one.state === 'HELD')
                  .map((one) => (
                    <option key={one.id} value={one.id}>
                      {money(one.amountCents, one.currency)} &mdash; {one.purpose}
                    </option>
                  ))}
              </select>
              <label className="rs-field-label" htmlFor={`cash-why-${item.key}`}>
                Why it is not being spent
              </label>
              <input
                id={`cash-why-${item.key}`}
                value={said}
                onChange={(event) => setSaid(event.target.value)}
              />
              <button
                type="button"
                className="rs-button-quiet"
                disabled={busy || reference === '' || said.trim().length === 0}
                onClick={() =>
                  void run(async () => {
                    await CashApi.releaseCommitment(reference, said.trim());
                    return 'Released. Nothing was spent, and the record stays.';
                  })
                }
              >
                {busy ? 'Releasing…' : 'Confirm'}
              </button>
            </>
          )}
          <button type="button" className="rs-linklike" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </>
      ) : null}

      {outcome}
      {failure}
    </div>
  );
}

/**
 * The patch key each review group's field is written under.
 *
 * The review names a field by the card's own key and `fillCard` takes the view
 * type's name for it; they differ for exactly the fields where the column and
 * the concept are not the same word. Anything absent falls through as itself,
 * so a new field reaches the card without a second place to remember.
 */
const CARD_PATCH_KEY: Record<string, string> = {
  access: 'reachableChannel',
  buyingevidence: 'buyingSignal',
  offer: 'offerScope',
  acceptance: 'acceptanceCondition',
  delivery: 'deliveryMethod',
  fulfillment: 'fulfillmentOwner',
  economics: 'economicsNote',
  cashdates: 'deadline',
  nextaction: 'nextAction',
};

/**
 * What Brain may spend here.
 *
 * **The defaults are gone, and their absence is the point.** The card used to
 * arrive prefilled — $1,000 committed, $250 per action, three opportunities,
 * every commercial action ticked — with **Approve** visible and the actual
 * terms folded away under *Change details*. Three things were wrong with that
 * and they compound: nobody chose the numbers, the person approving could not
 * see what they were approving, and the three-opportunity cap quietly
 * contradicted the whole point of assembling several pieces at once.
 *
 * It is §27's `mutationScope` defect one subject along: the safe answer was the
 * one somebody had to remember and the unsafe one was free. So the ceilings are
 * typed, the server says what they would mean, and only then is there anything
 * to approve. Reading the preview creates nothing.
 */
function Authority({
  view,
  projectId,
  onChanged,
}: {
  view: CashView;
  projectId: string;
  onChanged(): void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [committed, setCommitted] = useState('');
  const [perAction, setPerAction] = useState('');
  const [concurrent, setConcurrent] = useState('');
  const [actions, setActions] = useState<string[]>(view.vocabulary.commercialActions);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [withdrawReason, setWithdrawReason] = useState('');

  if (view.authority.exists) {
    return (
      <div className="rs-authority">
        <p className="rs-authority-headline">Spending limits &mdash; what Brain may spend here</p>
        <ul className="rs-authority-list">
          {view.authority.lines.map((line) => (
            <li key={line} className="rs-authority-limit">
              {line}
            </li>
          ))}
        </ul>
        <p className="rs-item-meta">
          Committed right now: {money(view.authority.heldCents, view.myCash.position.currency)}.
          Used so far is evidence, not an allowance.
        </p>
        <details>
          <summary className="rs-linklike">Withdraw this</summary>
          <label className="rs-field-label" htmlFor="cash-withdraw">
            Why
          </label>
          <input
            id="cash-withdraw"
            value={withdrawReason}
            onChange={(event) => setWithdrawReason(event.target.value)}
          />
          <p className="rs-hint">
            Withdrawing keeps every commitment, every money record and every opportunity. What
            stops is new commercial action, and money still held stays held against whatever you
            grant next.
          </p>
          <button
            type="button"
            className="rs-button-quiet"
            disabled={busy || withdrawReason.trim().length === 0}
            onClick={async () => {
              setBusy(true);
              setProblem(null);
              try {
                await CashApi.withdrawAuthority(projectId, view.authority.id!, withdrawReason);
                onChanged();
              } catch (error) {
                setProblem(error instanceof Error ? error.message : String(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            Withdraw
          </button>
          {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
        </details>
      </div>
    );
  }

  /** Whether there is anything to spend on yet, which decides how loud this is. */
  const hasWork = view.myCurrentWork.placements.length > 0;

  /*
   * Typed in ordinary money, sent in cents.
   *
   * The two ceilings used to be typed *in cents*, which asked a person to do a
   * conversion in their head in the one box where being out by a factor of a
   * hundred is a spending limit. Nothing about the grant moved: the route still
   * takes cents, `checkCommercialAuthority` still decides, and the preview a
   * person approves is still the server's own sentences about the values that
   * actually arrive.
   */
  const committedCents = centsFromAmount(committed);
  const perActionCents = centsFromAmount(perAction);
  const concurrentCount = Number(concurrent);
  const numbers = {
    maxCommittedCents: committedCents ?? 0,
    maxPerActionCents: perActionCents ?? 0,
    maxConcurrent: concurrentCount,
  };
  const complete =
    committedCents !== null &&
    perActionCents !== null &&
    concurrent.trim().length > 0 &&
    Number.isInteger(concurrentCount) &&
    concurrentCount >= 1 &&
    actions.length > 0;

  async function run(what: 'preview' | 'approve'): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      if (what === 'preview') {
        setPreview((await CashApi.previewAuthority(projectId, { allowedActions: actions, ...numbers })).lines);
      } else {
        await CashApi.grantAuthority(projectId, { allowedActions: actions, ...numbers });
        onChanged();
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rs-authority">
      <p className="rs-authority-headline">Spending limits &mdash; what Brain may spend here</p>
      <p className="rs-hint">
        These are <em>limits</em>, not a forecast and not a budget anybody expects to be used.
        Nothing is set aside, reserved or pre-paid by setting them; they are the ceiling every
        commitment is checked against. Nothing can be committed, quoted or collected until this
        exists, however good an opening is. Discovery keeps running meanwhile, and reading this
        card creates nothing.
      </p>

      {/*
        * The decision stays named; the form is what folds.
        *
        * With nothing in the portfolio yet, a set of empty ceiling boxes is the
        * largest thing on the screen and the least useful, which is what the
        * money picture above is actually for. §29's rule is that the approval a
        * project cannot proceed without is never folded away — so the headline,
        * the consequence and the control to open it are always visible, and
        * only the inputs start closed. Once there is something to spend on,
        * they start open.
        */}
      <details className="rs-cash-authority-details" open={hasWork}>
        <summary className="rs-linklike">
          {hasWork ? 'Set the limits' : 'Set the limits now, or leave it until there is an opening'}
        </summary>
        <label className="rs-field-label" htmlFor="cash-committed">
          Most that may be committed at once
        </label>
        <input
          id="cash-committed"
          inputMode="decimal"
          placeholder={`${view.myCash.position.currency} 1,000.00`}
          value={committed}
          onChange={(event) => {
            setCommitted(event.target.value);
            setPreview(null);
          }}
        />
        <p className="rs-hint">
          In ordinary {view.myCash.position.currency}, not cents. The total Brain may have held
          against openings at any one moment. Money released or settled stops counting against it.
        </p>
        <label className="rs-field-label" htmlFor="cash-per-action">
          Most in any single commitment
        </label>
        <input
          id="cash-per-action"
          inputMode="decimal"
          placeholder={`${view.myCash.position.currency} 250.00`}
          value={perAction}
          onChange={(event) => {
            setPerAction(event.target.value);
            setPreview(null);
          }}
        />
        <p className="rs-hint">
          The size of one commitment Brain may make without you. It is a per-item ceiling, not a
          share of the figure above.
        </p>
        <label className="rs-field-label" htmlFor="cash-concurrent">
          How many opportunities may be executing at once
        </label>
        <input
          id="cash-concurrent"
          inputMode="numeric"
          value={concurrent}
          onChange={(event) => {
            setConcurrent(event.target.value);
            setPreview(null);
          }}
        />
        <p className="rs-hint">
          This bounds what may be <em>executing</em>, which is real fulfilment capacity. It is not
          a limit on how many pieces the portfolio may hold.
        </p>
        {[committed, perAction].some((typed) => typed.trim().length > 0) &&
        (committedCents === null || perActionCents === null) ? (
          <p className="rs-state rs-state-error">
            Type an amount like 1000 or 1,000.50. Brain will not guess at an amount it cannot read.
          </p>
        ) : null}
        <fieldset>
          <legend className="rs-field-label">What it authorizes</legend>
          {view.vocabulary.commercialActions.map((action) => (
            <label key={action} className="rs-choice">
              <input
                type="checkbox"
                checked={actions.includes(action)}
                onChange={(event) => {
                  setActions((current) =>
                    event.target.checked
                      ? [...current, action]
                      : current.filter((entry) => entry !== action),
                  );
                  setPreview(null);
                }}
              />
              <span className="rs-choice-text">{action}</span>
            </label>
          ))}
        </fieldset>
      </details>

      <ul className="rs-authority-never">
        {view.vocabulary.neverAuthorizable.map((entry) => (
          <li key={entry}>{entry}</li>
        ))}
      </ul>
      <p className="rs-item-meta">Those can never be authorized, by any grant, at any ceiling.</p>

      {preview ? (
        <>
          <p className="rs-authority-headline">This is what you would be approving</p>
          <ul className="rs-authority-list">
            {preview.map((line) => (
              <li key={line} className="rs-authority-limit">
                {line}
              </li>
            ))}
          </ul>
          <button type="button" className="rs-button" disabled={busy} onClick={() => void run('approve')}>
            {busy ? 'Approving\u2026' : 'Approve'}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="rs-button"
          disabled={busy || !complete}
          onClick={() => void run('preview')}
        >
          Show me what this authorizes
        </button>
      )}
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
    </div>
  );
}

/**
 * The money picture: what is *known*, and what the evidence cannot yet say.
 *
 * Two kinds of number and they are never shown alike. A **fact** is derived
 * from an append-only entry or from a limit a person set — authorized,
 * committed, spent, remaining — and zero is one of those: "nothing authorized"
 * is something Brain knows, not something it has failed to work out. A
 * **forecast** is arithmetic over evidence on opportunity cards, and where the
 * cards are blank it is withheld naming the blanks, rather than estimated.
 *
 * Nothing on this screen is computed here. Every figure comes down on the view;
 * a client deriving one would be a second opinion about one sprint.
 */
function MoneyPicture({ view }: { view: CashView }): JSX.Element {
  const currency = view.forecast.currency;
  const grant = view.authority;
  const remaining = Math.max(grant.maxCommittedCents - grant.committedCents, 0);

  const facts: { label: string; value: string; note: string }[] = [
    {
      label: 'Authorized',
      value: grant.exists ? money(grant.maxCommittedCents, currency) : money(0, currency),
      note: grant.exists
        ? 'The most that may be committed at once, which you set.'
        : 'No spending has been authorized here yet. Nothing can be committed until it is.',
    },
    {
      label: 'Committed',
      value: money(grant.committedCents, currency),
      note: 'Authorized and held against something, not yet spent.',
    },
    {
      label: 'Spent',
      value: money(grant.spentCents, currency),
      note: 'Money that has actually left the account.',
    },
    {
      label: 'Remaining authorized capacity',
      value: grant.exists ? money(remaining, currency) : money(0, currency),
      note: grant.exists
        ? 'What is left inside the limit you set, not a forecast of what will be used.'
        : 'There is no limit to have room inside yet.',
    },
  ];

  const estimates: {
    key: string;
    label: string;
    value: string | null;
    range: string | null;
    basis: string;
    unknown: string[];
    blocking: string;
    confidence: string;
    fromRows: number;
  }[] = [
    { key: 'upfront', label: 'Upfront cash needed', e: view.forecast.upfrontCash },
    { key: 'ongoing', label: 'Ongoing costs', e: view.forecast.ongoingCosts },
    { key: 'revenue', label: 'Revenue', e: view.forecast.revenue },
    { key: 'contribution', label: 'Profit contribution', e: view.forecast.contribution },
  ].map(({ key, label, e }) => ({
    key,
    label,
    value: e.valueCents === null ? null : money(e.valueCents, currency),
    range:
      e.lowCents === null || e.highCents === null || e.lowCents === e.highCents
        ? null
        : `${money(e.lowCents, currency)} to ${money(e.highCents, currency)}`,
    basis: e.basis,
    unknown: e.unknown,
    blocking: e.blocking,
    confidence: e.confidence,
    fromRows: e.fromRows,
  }));

  const durations: {
    key: string;
    label: string;
    value: string | null;
    range: string | null;
    basis: string;
    unknown: string[];
    blocking: string;
    confidence: string;
    fromRows: number;
  }[] = [
    { key: 'first-dollar', label: 'Time to the first dollar', d: view.forecast.timeToFirstDollar },
    { key: 'break-even', label: 'Time to break even', d: view.forecast.breakEven },
  ].map(({ key, label, d }) => ({
    key,
    label,
    value: d.days === null ? null : `${d.days} ${d.days === 1 ? 'day' : 'days'}`,
    range:
      d.lowDays === null || d.highDays === null || d.lowDays === d.highDays
        ? null
        : `${d.lowDays} to ${d.highDays} days`,
    basis: d.basis,
    unknown: d.unknown,
    blocking: d.blocking,
    confidence: d.confidence,
    fromRows: d.fromRows,
  }));

  const rows = [...estimates, ...durations];

  return (
    <section className="rs-card rs-cash-picture">
      <h3>The money picture</h3>

      <p className="rs-item-meta">
        These four are facts. They are what you authorized and what has actually moved.
      </p>
      <div className="rs-table-wrap">
        <table>
          <caption className="rs-visually-hidden">
            Authorized, committed, spent and remaining: figures Brain knows
          </caption>
          <thead>
            <tr>
              <th scope="col">Figure</th>
              <th scope="col">Amount</th>
              <th scope="col">What it means</th>
            </tr>
          </thead>
          <tbody>
            {facts.map((fact) => (
              <tr key={fact.label}>
                <th scope="row">{fact.label}</th>
                <td>{fact.value}</td>
                <td>{fact.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="rs-item-meta">
        These are estimates over the openings Brain has qualified &mdash;{' '}
        {view.forecast.qualified} of {view.forecast.considered}. An estimate is shown only where
        the evidence carries it; the rest say exactly what is still unknown.
      </p>
      <div className="rs-table-wrap">
        <table>
          <caption className="rs-visually-hidden">
            What the evidence supports estimating, and what it does not
          </caption>
          <thead>
            <tr>
              <th scope="col">Estimate</th>
              <th scope="col">Figure</th>
              <th scope="col">Range and confidence</th>
              <th scope="col">Where it comes from</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{row.value ?? <span className="rs-item-meta">Not yet estimable</span>}</td>
                <td>
                  {row.value === null
                    ? '\u2014'
                    : `${row.range ?? 'No spread: one figure'} \u00b7 ${
                        row.confidence === 'SEVERAL_ROWS'
                          ? `from ${row.fromRows} openings`
                          : row.confidence === 'SINGLE_ROW'
                            ? 'from a single opening'
                            : 'no supporting rows'
                      }`}
                </td>
                <td>
                  {row.basis}
                  {row.value === null ? (
                    <>
                      {' '}
                      <strong>{row.blocking}</strong>
                      {row.unknown.length > 0 ? ` Still unknown: ${row.unknown.join(', ')}.` : ''}
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {view.forecast.humanHours.total === null ? (
        <p className="rs-hint">
          Nobody has estimated the hours these openings would take.
          {view.forecast.humanHours.unknown.length > 0
            ? ` Still unknown: ${view.forecast.humanHours.unknown.join(', ')}.`
            : ''}
        </p>
      ) : (
        <p className="rs-hint">
          {view.forecast.humanHours.total} hours of your own work across{' '}
          {view.forecast.humanHours.fromRows}{' '}
          {view.forecast.humanHours.fromRows === 1 ? 'opening' : 'openings'}. Reported beside the
          money rather than inside it: no hourly rate has been set, so turning hours into a cost
          would be a number nobody chose.
        </p>
      )}
    </section>
  );
}

/** My cash: the six figures, kept apart, each labelled with what it means. */
function MyCash({ view }: { view: CashView }): JSX.Element {
  const p = view.myCash.position;
  const rows: { label: string; value: number; note: string }[] = [
    { label: 'Pipeline', value: p.pipelineCents, note: 'Agreed work. No cash received.' },
    {
      label: 'Customer payments',
      value: p.customerPaymentsCents,
      note: 'Verified, including what is still pending with the provider.',
    },
    {
      label: 'Available funds',
      value: p.availableFundsCents,
      note: 'Settled and usable through the verified route.',
    },
    {
      label: 'Unpaid commitments',
      value: p.unpaidCommitmentsCents,
      note: 'Delivery costs and supplier bills owed.',
    },
    {
      label: 'Held commitments',
      value: p.heldCommitmentsCents,
      note: 'Authorized and not yet spent.',
    },
    { label: 'Reserves', value: p.reservesCents, note: 'Protected cash: delivery, tax, operating.' },
    {
      label: 'Deployable',
      value: p.deployableCents,
      note: 'What can actually be committed to something new.',
    },
    {
      label: 'Completed contribution',
      value: p.completedContributionCents,
      note: 'Earned sales minus every incremental cost, before overhead and tax.',
    },
  ];

  return (
    <section className="rs-card rs-cash-money">
      <h3>Your cash</h3>
      {p.shortfall ? (
        <p className="rs-state rs-state-error">
          Deployable cash is negative. New discretionary commitments are refused until that is
          funded or something is released. Delivery on work already sold continues.
        </p>
      ) : null}
      <div className="rs-table-wrap">
        <table>
          <caption className="rs-visually-hidden">
            The figures of this account, each kept separate
          </caption>
          <thead>
            <tr>
              <th scope="col">Figure</th>
              <th scope="col">Amount</th>
              <th scope="col">What it means</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{money(row.value, p.currency)}</td>
                <td>{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view.myCash.entries.length === 0 ? (
        <p className="rs-hint">No money has moved yet.</p>
      ) : (
        <ul className="rs-list">
          {view.myCash.entries.slice(0, 8).map(({ entry, effect }) => (
            <li key={entry.id} className="rs-row">
              <span className="rs-item-title">
                {entry.kind} {money(entry.amountCents, entry.currency)}
              </span>
              <span className="rs-item-meta">
                {effect} &middot; {entry.occurredAt}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * My current work: the assembled plan, not a ranked list to choose from.
 *
 * Every piece carries its disposition and the server's own sentence saying what
 * decided it, so "waiting" always names what it is waiting for.
 */
function CurrentWork({
  view,
  onChanged,
}: {
  view: CashView;
  onChanged(): void;
}): JSX.Element {
  const plan = view.myCurrentWork;
  return (
    <section className="rs-card rs-cash-portfolio">
      <h3>Your current work</h3>
      {plan.placements.length === 0 ? (
        <p className="rs-hint">
          Nothing in the portfolio yet. {view.discovery.reason}
        </p>
      ) : (
        <>
          <p className="rs-item-meta">
            {plan.executeNow.length} to act on now, {plan.waiting.length} waiting. Combined
            conservative contribution of the live pieces:{' '}
            {money(plan.combinedContributionCents, view.myCash.position.currency)} &mdash; an
            arithmetic illustration from quoted prices, not a bank balance.
          </p>
          <ul className="rs-list">
            {plan.placements.map((placement) => (
              <li key={placement.opportunity.id} className="rs-group">
                <p className="rs-item-title">{placement.opportunity.title}</p>
                <p className="rs-badge">{DISPOSITION_LABEL[placement.disposition]}</p>
                <p className="rs-decision-why">{placement.because}</p>
                {placement.opportunity.exhaustedAt ? (
                  <p className="rs-item-meta">
                    This opening is finished: {placement.opportunity.exhaustedReason}. Whatever it
                    earned still counts.
                  </p>
                ) : null}
                <Actions
                  placement={placement}
                  allowedActions={view.authority.allowedActions}
                  onChanged={onChanged}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * The transitions this piece actually has, from its own state.
 *
 * A transition that needs a reason reveals a field for it rather than opening a
 * browser dialog: a dialog cannot be read by the page that explains what the
 * choice does, cannot be styled to the 44px target the rest of the shell keeps,
 * and on a phone covers the thing it is asking about.
 */
function Actions({
  placement,
  allowedActions,
  onChanged,
}: {
  placement: Placement;
  allowedActions: string[];
  onChanged(): void;
}): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [performed, setPerformed] = useState(allowedActions[0] ?? 'CONTACT_BUYER');
  const state = placement.opportunity.state;

  /*
   * `asks` says what the server needs before this transition is true.
   *
   * `REASON` is a sentence kept on the record. `ACTION` is the correction §3
   * asked for: executing means the transaction is being pursued, so the call
   * has to say what was actually done, and the control asks rather than
   * pressing a button that writes the state anyway.
   */
  const available: { action: string; label: string; asks?: 'REASON' | 'ACTION' }[] = [];
  if (state === 'DISCOVERED' || state === 'EVIDENCE_CARD') {
    available.push({ action: 'ready', label: 'Mark ready to test' });
    available.push({ action: 'decline', label: 'Pass on this', asks: 'REASON' });
  }
  if (state === 'READY') {
    available.push({ action: 'execute', label: 'Record the first move', asks: 'ACTION' });
  }
  if (state === 'EXECUTING') available.push({ action: 'deliver', label: 'Delivering' });
  if (state === 'EXECUTING' || state === 'DELIVERING') {
    available.push({ action: 'collect', label: 'Money is in' });
  }
  if (available.length === 0) return null;

  const asks = available.find((entry) => entry.action === asking)?.asks ?? null;

  async function run(action: string, body: Record<string, unknown> = {}): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await CashApi.act(placement.opportunity.id, action, body);
      setAsking(null);
      setReason('');
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rs-cash-actions">
      {available.map((entry) => (
        <button
          key={entry.action}
          type="button"
          className="rs-button-quiet"
          disabled={busy}
          onClick={() => (entry.asks ? setAsking(entry.action) : void run(entry.action))}
        >
          {entry.label}
        </button>
      ))}
      {asks === 'REASON' && asking ? (
        <>
          <label className="rs-field-label" htmlFor={`cash-reason-${placement.opportunity.id}`}>
            Why? It is kept on the record, and it is what an offer to somebody else says.
          </label>
          <input
            id={`cash-reason-${placement.opportunity.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button
            type="button"
            className="rs-button-quiet"
            disabled={busy || reason.trim().length === 0}
            onClick={() => void run(asking, { reason })}
          >
            Confirm
          </button>
          <button type="button" className="rs-linklike" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </>
      ) : null}
      {asks === 'ACTION' && asking ? (
        <>
          <p className="rs-hint">
            Executing means the transaction is being pursued, so say what actually happened. The
            list is what your standing authority permits.
          </p>
          <label className="rs-field-label" htmlFor={`cash-did-${placement.opportunity.id}`}>
            What did you do?
          </label>
          <select
            id={`cash-did-${placement.opportunity.id}`}
            value={performed}
            onChange={(event) => setPerformed(event.target.value)}
          >
            {(allowedActions.length > 0 ? allowedActions : ['CONTACT_BUYER']).map((one) => (
              <option key={one} value={one}>
                {one.toLowerCase().replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <label className="rs-field-label" htmlFor={`cash-detail-${placement.opportunity.id}`}>
            In your own words, and any reference it has outside Brain.
          </label>
          <input
            id={`cash-detail-${placement.opportunity.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button
            type="button"
            className="rs-button-quiet"
            disabled={busy || reason.trim().length === 0}
            onClick={() => void run(asking, { action: performed, detail: reason })}
          >
            Confirm
          </button>
          <button type="button" className="rs-linklike" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </>
      ) : null}
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
    </div>
  );
}

/** What Brain needs: a blocked action with a recommended way forward. */
function Needs({ view }: { view: CashView }): JSX.Element {
  return (
    <section className="rs-card rs-cash-needs">
      <h3>What Brain needs</h3>
      {view.whatBrainNeeds.length === 0 ? (
        <p className="rs-hint">Nothing is missing that Brain knows about.</p>
      ) : (
        <ul className="rs-list">
          {view.whatBrainNeeds.map((need) => (
            <li key={need.id} className="rs-group">
              <p className="rs-item-title">{need.blockedAction}</p>
              <p className="rs-decision-why">{need.whyItMatters}</p>
              <p className="rs-decision-what">{need.recommendedPath}</p>
              <p className="rs-item-meta">
                {need.setupEffort} &middot; next step: {need.nextStep}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="rs-hint">
        An open need never stops unrelated work. Everything Brain can do without it carries on.
      </p>
    </section>
  );
}

/**
 * Where the research is up to.
 *
 * Above the activity log and deliberately separate from it. The log answers
 * *what happened* — a stream of event codes, newest first — and reading it for
 * progress is what left a person watching `CASH_DISCOVERY_OPENED` scroll past
 * with no idea whether that was one of three things or one of thirty. This
 * answers *where is this up to*, and every number on it is a count the server
 * took over rows that already existed.
 *
 * **Every denominator here is the plan's own.** A round's planned count is how
 * many fragments its mission actually holds. There is no target in this file,
 * and no completion percentage over discovery as a whole: discovery is
 * open-ended by mandate, so a percentage of it would be a fraction of a number
 * nobody knows. A *round* is bounded, so a round is what carries a fraction.
 *
 * It renders a projection and presses nothing. There is no control on it.
 */
function Roadmap({ view }: { view: CashView }): JSX.Element {
  const map = view.roadmap;
  const research = map.research;
  const queued = research.byStatus.PLANNED + research.byStatus.QUEUED;
  const running = research.byStatus.RUNNING + research.byStatus.VALIDATING;
  /*
   * Every status is on the screen, so the rows sum to the plan.
   *
   * A table that showed five of nine statuses would be a denominator that does
   * not add up, and the missing four are exactly the ones a person needs to see:
   * stopped work, and work that stopped for them.
   */
  const stopped = research.byStatus.CANCELLED + research.byStatus.NEEDS_HUMAN;

  return (
    <section className="rs-card rs-cash-roadmap">
      <h3>What Brain is researching</h3>
      <p className="rs-hint">{map.whatHappensNext}</p>

      <div className="rs-table-wrap">
        <table>
          <caption className="rs-visually-hidden">
            The research plan of the rounds that are open, counted from the plan itself
          </caption>
          <thead>
            <tr>
              <th scope="col">Research</th>
              <th scope="col">How many</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Planned in the open rounds</th>
              <td>{research.planned}</td>
            </tr>
            <tr>
              <th scope="row">Waiting to start</th>
              <td>{queued}</td>
            </tr>
            <tr>
              <th scope="row">Being researched now</th>
              <td>{running}</td>
            </tr>
            <tr>
              <th scope="row">Finished and accepted</th>
              <td>{research.byStatus.ACCEPTED}</td>
            </tr>
            <tr>
              <th scope="row">Rejected at the evidence gate</th>
              <td>{research.byStatus.REJECTED}</td>
            </tr>
            <tr>
              <th scope="row">Blocked</th>
              <td>{research.byStatus.BLOCKED}</td>
            </tr>
            <tr>
              <th scope="row">Stopped, or waiting on a person</th>
              <td>{stopped}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="rs-item-meta">
        {map.rounds.open} {map.rounds.open === 1 ? 'round' : 'rounds'} open of {map.rounds.total}{' '}
        opened so far ({map.rounds.harvested} harvested, {map.rounds.abandoned} abandoned), across{' '}
        {map.mechanisms.length} {map.mechanisms.length === 1 ? 'way' : 'ways'} of earning.
      </p>

      {map.active.length === 0 ? (
        <p className="rs-hint">No round is open right now. {view.discovery.reason}</p>
      ) : (
        <ul className="rs-list">
          {map.active.map((round) => (
            <li key={round.roundId} className="rs-row">
              <span className="rs-item-title">
                {round.mechanism} &mdash; round {round.round}
              </span>
              <span className="rs-item-meta" title={`${round.bucketId} \u00b7 ${round.roundId}`}>
                {ROUND_ACTIVITY[round.activity]}
                {' \u00b7 '}
                {round.plan
                  ? `${round.plan.byStatus.ACCEPTED} of ${round.plan.planned} research items done`
                  : 'no research planned yet'}
                {' \u00b7 '}
                {round.found} {round.found === 1 ? 'opening' : 'openings'} found
                {' \u00b7 '}
                opened {round.openedAt}
              </span>
              {/*
                * Why it is not moving, in the words of whatever stopped it.
                *
                * A round reads OPEN until it is harvested, so a parked one used
                * to show as research under way with nothing behind it — which
                * is what every round of the live sprint looked like while all
                * ten candidates were parked and no work item existed anywhere.
                */}
              {round.blocker ? (
                <p className="rs-item-meta">Not moving: {round.blocker}</p>
              ) : null}
              {round.plan && round.plan.inFlight.length > 0 ? (
                <ul className="rs-list rs-sublist">
                  {round.plan.inFlight.map((question) => (
                    <li key={question} className="rs-item-meta">
                      {question}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="rs-table-wrap">
        <table>
          <caption className="rs-visually-hidden">
            What discovery has produced, counted by the state each piece is in
          </caption>
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">How many</th>
              <th scope="col">What it means</th>
            </tr>
          </thead>
          <tbody>
            {map.pipeline.map((stage) => (
              <tr key={stage.key}>
                <th scope="row">{stage.label}</th>
                <td>{stage.count}</td>
                <td>{stage.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * An event code, in the words somebody reads.
 *
 * The code is kept rather than replaced: it is on the row's own title, so the
 * underlying detail stays reachable exactly as it was. A kind with no entry
 * falls back to its own words rather than to a shrug, so a new event kind
 * reaches the screen legibly without this map having to be remembered.
 */
const EVENT_PLAIN: Record<string, string> = {
  CASH_MODE_ACTIVATED: 'Cash Mode started',
  CASH_MODE_WINDING_DOWN: 'Winding down: no new discovery',
  CASH_MODE_ARCHIVED: 'Archived',
  CASH_MODE_ACTIVE: 'Made active again',
  CASH_LAYER_CREATED: 'Somewhere to file the work was created',
  CASH_DISCOVERY_OPENED: 'A new search was opened',
  CASH_OPPORTUNITY_HARVESTED: 'An opening was harvested from the research',
  CASH_OPPORTUNITY_CAPTURED: 'An opening was written down',
  CASH_OPPORTUNITY_READY: 'An opening became ready to test',
  CASH_OPPORTUNITY_DECLINED: 'An opening was declined',
  CASH_OPPORTUNITY_ARCHIVED: 'An opening was archived',
  CASH_OPPORTUNITY_REOFFERED: 'An archived opening was offered again',
  CASH_OPENING_EXHAUSTED: 'An opening ran out of attempts',
  CASH_CARD_UPDATED: 'An answer was filled in on a card',
  CASH_CARD_ANSWERED: 'Research answered something on a card',
  CASH_TERMS_PROPOSED: 'Brain proposed terms for an opening',
  CASH_NEED_RAISED: 'Brain said what it is missing',
  CASH_NEED_RESOLVED: 'Something Brain was missing was answered',
  CASH_NEED_WITHDRAWN: 'A need was withdrawn',
  CASH_AUTHORITY_GRANTED: 'You set what Brain may spend',
  CASH_AUTHORITY_WITHDRAWN: 'Spending authority was withdrawn',
  CASH_COMMITTED: 'Money was committed',
  CASH_COMMITMENT_RELEASED: 'A commitment was released',
  CASH_COMMITMENT_SETTLED: 'A commitment was settled',
  CASH_MONEY_RECORDED: 'A money record was added',
  CASH_ACTION_RECORDED: 'Brain did something in the world',
  CASH_EXECUTION_STARTED: 'Work on an opening started',
};

function plainEvent(kind: string): string {
  const known = EVENT_PLAIN[kind];
  if (known !== undefined) return known;
  const words = kind.replace(/^CASH_/, '').toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What Brain has done: the append-only history, newest first.
 *
 * Supporting detail under the roadmap rather than the progress report itself.
 * The internal code is translated and kept: it is on the row, so a person
 * reading for progress is not decoding enum names and somebody debugging has
 * lost nothing.
 */
function Done({ view }: { view: CashView }): JSX.Element {
  return (
    <section className="rs-card rs-cash-history">
      <h3>Everything that has happened</h3>
      {view.whatBrainHasDone.length === 0 ? (
        <p className="rs-hint">Nothing has happened here yet.</p>
      ) : (
        <ul className="rs-list">
          {view.whatBrainHasDone.map((event) => (
            <li key={event.id} className="rs-row">
              <span className="rs-item-title">{event.summary}</span>
              <span className="rs-item-meta" title={event.kind}>
                {plainEvent(event.kind)} &middot; {event.createdAt}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Winding the sprint down, and what that actually stops.
 *
 * The consequence sentence is the server's, because it is the one thing about
 * this control people get wrong: winding down stops **new discovery** and
 * nothing else. Customers, delivery, money and every other part of Brain carry
 * on, and reactivating is a decision rather than a recovery.
 */
function Lifecycle({
  projectId,
  state,
  onChanged,
}: {
  projectId: string;
  state: CashModeState;
  onChanged(): void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const next: CashModeState[] = (['ACTIVE', 'WINDING_DOWN', 'ARCHIVED'] as const).filter(
    (candidate) => candidate !== state,
  );

  return (
    <section className="rs-card rs-cash-lifecycle">
      <h3>The sprint</h3>
      <p className="rs-item-meta">It is {state.toLowerCase().replace('_', ' ')}.</p>
      <label className="rs-field-label" htmlFor="cash-lifecycle-reason">
        Why
      </label>
      <input
        id="cash-lifecycle-reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="rs-cash-actions">
        {next.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className="rs-button-quiet"
            disabled={busy || reason.trim().length === 0}
            onClick={async () => {
              setBusy(true);
              setProblem(null);
              try {
                const answer = await CashApi.setLifecycle(projectId, candidate, reason);
                setMessage(answer.message);
                onChanged();
              } catch (error) {
                setProblem(error instanceof Error ? error.message : String(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            {candidate === 'ACTIVE'
              ? 'Make it active'
              : candidate === 'WINDING_DOWN'
                ? 'Wind it down'
                : 'Archive it'}
          </button>
        ))}
      </div>
      {message ? <p className="rs-hint">{message}</p> : null}
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
    </section>
  );
}

export { CashView_ as CashSection };

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
  type CashView,
  type Placement,
  type ReviewItem,
} from '../lib/cashApi.ts';

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
 * The section, over one chosen operation.
 *
 * `projectId` is the shell's current selection and is a **candidate**, not the
 * answer. It used to be the answer, which meant somebody with a broad Brain
 * project and a private cash project could be shown — and could activate — the
 * wrong one, because the shell hands out the first project a person can see. An
 * operation is what a sprint belongs to, so it is chosen here.
 */
export function CashView_({ projectId }: { projectId: string | null }): JSX.Element {
  const operations = useAsync(() => CashApi.operations(), []);
  const [chosen, setChosen] = useState<string | null>(null);

  const known = operations.data;
  /*
   * The shell's project wins only when it is genuinely one of this person's
   * operations. Otherwise the first operation they have, and otherwise nothing
   * — at which point the screen offers to start one rather than guessing.
   */
  const selected =
    chosen ??
    (known?.operations.some((o) => o.projectId === projectId) ? projectId : null) ??
    known?.operations[0]?.projectId ??
    null;

  const view = useAsync(
    () => (selected ? CashApi.view(selected) : Promise.resolve(null as CashView | null)),
    [selected],
  );

  if (known && known.operations.length === 0) {
    return (
      <Activate
        candidates={known.candidates}
        preferred={projectId}
        currencies={['USD', 'GBP', 'EUR', 'CAD', 'AUD']}
        onActivated={() => {
          operations.reload();
          view.reload();
        }}
      />
    );
  }

  if (!selected) {
    return (
      <section className="rs-view rs-view-cash">
        <h2>Cash</h2>
        <p className="rs-state rs-state-loading">Finding your operations&hellip;</p>
      </section>
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

  if (!data) {
    return (
      <section className="rs-view rs-view-cash">
        <h2>Cash</h2>
        <p className="rs-state rs-state-loading">Reading this account&rsquo;s sprint&hellip;</p>
      </section>
    );
  }

  if (!data.mode) {
    return (
      <Activate
        candidates={[{ projectId: selected, projectName: null }]}
        preferred={selected}
        currencies={data.vocabulary.currencies}
        onActivated={() => {
          operations.reload();
          view.reload();
        }}
      />
    );
  }

  return (
    <section className="rs-view rs-view-cash">
      <h2>Cash</h2>
      {known && known.operations.length > 1 ? (
        <label className="rs-field-label">
          Which operation
          <select
            value={selected}
            onChange={(event) => setChosen(event.target.value)}
          >
            {known.operations.map((operation) => (
              <option key={operation.projectId} value={operation.projectId}>
                {operation.projectName ?? operation.projectId} &middot;{' '}
                {operation.state.toLowerCase().replace('_', ' ')}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p className="rs-lede">{data.objective}</p>
      <p className="rs-hint">{data.discovery.reason}</p>

      <Decisions view={data} projectId={selected} onChanged={view.reload} />
      <MyCash view={data} />
      <CurrentWork view={data} onChanged={view.reload} />
      <Needs view={data} />
      <Done view={data} />
      <Lifecycle
        projectId={selected}
        state={data.mode.state}
        onChanged={view.reload}
      />
    </section>
  );
}

/**
 * No sprint here yet.
 *
 * Turning one on spends nothing and authorizes nothing: it creates a sprint for
 * opportunities to belong to, and the separate decision about money is the one
 * below it. What it *does* fix is the two things that cannot be changed
 * afterwards — which operation this is, and the one currency the money is kept
 * in.
 */
function Activate({
  candidates,
  preferred,
  currencies,
  onActivated,
}: {
  candidates: { projectId: string; projectName: string | null }[];
  preferred: string | null;
  currencies: string[];
  onActivated(): void;
}): JSX.Element {
  const [objective, setObjective] = useState('');
  const [currency, setCurrency] = useState(currencies[0] ?? 'USD');
  const [where, setWhere] = useState<string>(
    candidates.some((c) => c.projectId === preferred)
      ? preferred!
      : (candidates[0]?.projectId ?? ''),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!where) return;
    setBusy(true);
    setProblem(null);
    try {
      await CashApi.activate(where, { objective, currency });
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
      <p className="rs-lede">
        A temporary operating section inside Brain. It searches broadly, assembles a private
        portfolio of cash-producing opportunities for this account, and keeps every other part of
        Brain exactly as it is.
      </p>
      <div className="rs-card rs-cash-activate">
        {candidates.length === 0 ? (
          <p className="rs-state rs-state-empty">
            You are not on a project that could hold a sprint. A sprint belongs to one project,
            because a project is the privacy boundary — nobody else&rsquo;s appears here.
          </p>
        ) : (
          <>
            <label className="rs-field-label" htmlFor="cash-where">
              Which operation
            </label>
            <select id="cash-where" value={where} onChange={(e) => setWhere(e.target.value)}>
              {candidates.map((candidate) => (
                <option key={candidate.projectId} value={candidate.projectId}>
                  {candidate.projectName ?? candidate.projectId}
                </option>
              ))}
            </select>

            <label className="rs-field-label" htmlFor="cash-objective">
              What is this account trying to produce?
            </label>
            <textarea
              id="cash-objective"
              rows={3}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              placeholder="Maximize additional usable cash over the next few weeks while building toward established cash flow."
            />

            <label className="rs-field-label" htmlFor="cash-currency">
              The one currency this sprint keeps its money in
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
              A sprint holds exactly one. Brain does not choose an exchange rate, so an entry in
              another currency is refused rather than converted — a second currency is a second
              sprint.
            </p>

            <p className="rs-hint">
              Turning this on creates nothing that can be spent. What Brain may do with money is a
              separate decision, and it is yours.
            </p>
            {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
            <button
              type="button"
              className="rs-button"
              disabled={busy || !where || objective.trim().length < 12}
              onClick={submit}
            >
              {busy ? 'Starting\u2026' : 'Start Cash Mode'}
            </button>
          </>
        )}
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
        <p className="rs-authority-headline">What Brain may spend here</p>
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

  const numbers = {
    maxCommittedCents: Number(committed),
    maxPerActionCents: Number(perAction),
    maxConcurrent: Number(concurrent),
  };
  const complete =
    [committed, perAction, concurrent].every((value) => value.trim().length > 0) &&
    Number.isInteger(numbers.maxCommittedCents) &&
    Number.isInteger(numbers.maxPerActionCents) &&
    Number.isInteger(numbers.maxConcurrent) &&
    numbers.maxConcurrent >= 1 &&
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
      <p className="rs-authority-headline">Decide what Brain may spend here</p>
      <p className="rs-hint">
        Nothing can be committed, quoted or collected until this exists, however good an opening
        is. Discovery keeps running meanwhile, and reading this card creates nothing.
      </p>

      <div className="rs-cash-authority-details">
        <label className="rs-field-label" htmlFor="cash-committed">
          Most that may be committed at once, in cents
        </label>
        <input
          id="cash-committed"
          inputMode="numeric"
          value={committed}
          onChange={(event) => {
            setCommitted(event.target.value);
            setPreview(null);
          }}
        />
        <label className="rs-field-label" htmlFor="cash-per-action">
          Most in one commitment, in cents
        </label>
        <input
          id="cash-per-action"
          inputMode="numeric"
          value={perAction}
          onChange={(event) => {
            setPerAction(event.target.value);
            setPreview(null);
          }}
        />
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
      </div>

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

/** What Brain has done: the append-only history, newest first. */
function Done({ view }: { view: CashView }): JSX.Element {
  return (
    <section className="rs-card rs-cash-history">
      <h3>What Brain has done</h3>
      {view.whatBrainHasDone.length === 0 ? (
        <p className="rs-hint">Nothing has happened here yet.</p>
      ) : (
        <ul className="rs-list">
          {view.whatBrainHasDone.map((event) => (
            <li key={event.id} className="rs-row">
              <span className="rs-item-title">{event.summary}</span>
              <span className="rs-item-meta">
                {event.kind} &middot; {event.createdAt}
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

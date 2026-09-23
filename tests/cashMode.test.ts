/**
 * The sprint's lifecycle, and the one thing winding it down is allowed to stop.
 *
 * This file exists because of a defect the plan's own review predicted rather
 * than one production found: `russell_cycle` is a **singleton** whose pause
 * stops the entire Russell tick — writeback, request resumption, every other
 * project — and the obvious way to build an off switch for a temporary section
 * is to reach for it. A Brain that did would look like it had worked.
 *
 * So the first test here reads the Cash Mode source and refuses any reference
 * to it at all. That is not a substitute for the behavioural tests below; it is
 * the one property those cannot demonstrate, because a test that proved
 * delivery still runs would also pass in a Brain where the *whole tick* had
 * been paused and nothing else was running either.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshProject } from './helpers.ts';
import { EXECUTION_THESIS } from './helpers/cashTier.ts';
import { createUser } from '../server/repos/identity.ts';
import { createProject } from '../server/repos/projects.ts';
import { getCashMode, listCashEvents } from '../server/repos/cashMode.ts';
import {
  getOpportunity,
  transitionOpportunity,
  updateOpportunity,
} from '../server/repos/cashPortfolio.ts';
import { createCandidate, getCandidate } from '../server/repos/russellCandidates.ts';
import {
  activate,
  discoveryAllowed,
  isSelectableCashEnvelope,
  launchableUnderCashMode,
  setLifecycle,
} from '../server/services/cash/lifecycle.ts';
import {
  actionKey,
  advance,
  beginExecution,
  capture,
  fillCard,
  markReady,
} from '../server/services/cash/opportunities.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  COMMERCIAL_ACTIONS,
} from '../server/services/cash/authority.ts';
import { raiseNeed } from '../server/services/cash/needs.ts';
import { openDiscovery } from '../server/services/cash/discovery.ts';
import { recordMoneyEvent } from '../server/services/cash/opportunities.ts';
import { walkToCollected } from './helpers/commerce.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `cash-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function activated(): Promise<void> {
  const outcome = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
}

/** A card with every load-bearing field answered, so a piece can be executed. */
async function completeCard(opportunityId: string): Promise<void> {
  const filled = await fillCard({
    opportunityId,
    actorRef: userId,
    patch: {
      payer: 'The owner, who signs',
      reachableChannel: 'Replied to our message on Tuesday',
      buyingSignal: 'Asked for a quote',
      signalObservedAt: '2026-09-15T09:00:00.000Z',
      offerScope: 'One fixed-scope intake repair',
      acceptanceCondition: 'Form submits and a test enquiry arrives',
      priceCents: 75_000,
      deliveryMethod: 'One afternoon of configuration',
      fulfillmentOwner: 'Us',
      peakFundingCents: 0,
      /*
       * And the execution thesis. `markReady` asks for both now: the twelve
       * short-card fields are what a bounded *test* turns on, and these are
       * what a *decision* turns on. They have no column, so a person
       * answering one is a `PERSON` row in `cash_card_facts`.
       */
      ...EXECUTION_THESIS,
    },
  });
  expect(filled.ok).toBe(true);
}

describe('the off switch is not the Brain’s off switch', () => {
  it('names the Russell cycle nowhere in Cash Mode', () => {
    /*
     * Read rather than asserted, because this is a property of the *code* and
     * the behaviour it protects cannot be observed: a Brain whose whole tick
     * was paused would still pass every behavioural test in this file, since
     * nothing else would be running either.
     */
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(path.join(REPO, 'server/services/cash'));
    files.push(
      path.join(REPO, 'server/repos/cashMode.ts'),
      path.join(REPO, 'server/repos/cashAuthority.ts'),
      path.join(REPO, 'server/repos/cashPortfolio.ts'),
      path.join(REPO, 'server/repos/cashLedger.ts'),
      path.join(REPO, 'server/routes/cash.ts'),
    );
    expect(files.length).toBeGreaterThan(5);

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      // The import path and the function, both. A comment naming it is fine and
      // is how the reasoning stays where somebody will read it — so only code
      // is checked, by requiring the line not to be a comment.
      for (const line of source.split('\n')) {
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) continue;
        expect(
          /pauseCycle|russellCycle|russell_cycle/.test(code),
          `${path.relative(REPO, file)} reaches for the Russell cycle: ${code}`,
        ).toBe(false);
      }
    }
  });
});

describe('activating', () => {
  it('refuses an objective nobody wrote', async () => {
    const outcome = await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'money',
    });
    expect(outcome.ok).toBe(false);
  });

  it('refuses an envelope outside the reviewed set', async () => {
    const outcome = await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
      envelopeId: 'STEP11_AUDIT_INDEPENDENCE_V1',
    });
    expect(outcome.ok).toBe(false);
    expect(isSelectableCashEnvelope('STEP11_AUDIT_INDEPENDENCE_V1')).toBe(false);
  });

  it('is idempotent by the project, and says which happened', async () => {
    await activated();
    const again = await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'A completely different objective, written later.',
    });
    expect(again.ok && again.changed).toBe(false);
    // The first objective stands. A second activation is not a way to rewrite
    // what somebody agreed to.
    const mode = await getCashMode(projectId);
    expect(mode!.objective).toContain('usable cash');
  });

  it('records who activated it and why, and what that authorized', async () => {
    await activated();
    const events = await listCashEvents(projectId);
    /*
     * Named rather than taken by position.
     *
     * Activating now writes two events in the same moment — the activation and
     * the internal research authorization it carries — and `listCashEvents`
     * tiebreaks a shared second on a random id, so reading `events[0]` was a
     * coin flip between them. A test that has to win a coin flip is a test
     * about ordering rather than about what it says it is about.
     */
    const activation = events.find((event) => event.kind === 'CASH_MODE_ACTIVATED');
    expect(activation).toBeTruthy();
    expect(activation!.actorRef).toBe(userId);

    // And pressing Start is what authorized the reading, with the person who
    // pressed it on the row rather than a process that wanted a grant.
    const authorized = events.find((event) => event.kind === 'CASH_DISCOVERY_AUTHORIZED');
    expect(authorized).toBeTruthy();
    expect(authorized!.actorRef).toBe('BRAIN');
    expect(authorized!.detail).toMatchObject({ authorizedByUserId: userId, maxExternalSpend: 0 });
  });
});

describe('winding down stops new discovery and nothing else', () => {
  it('refuses a new opportunity once the sprint is winding down', async () => {
    await activated();
    const first = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'A paid intake repair',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    expect(first.ok).toBe(true);

    const wound = await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: 'Established cash flow makes the urgency unnecessary.',
    });
    expect(wound.ok).toBe(true);

    const second = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'Something new',
      mechanism: 'TEMPORARY_EXPLOIT',
      currency: 'USD',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain('winding down');
  });

  it('keeps delivery, collection, money and needs working in every state', async () => {
    await activated();
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'A job somebody already agreed to',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const id = captured.value.id;
    await completeCard(id);
    expect((await markReady({ opportunityId: id, actorRef: userId })).ok).toBe(true);

    // Archived is the strongest of the three, so proving it there proves it for
    // winding down too.
    const archived = await setLifecycle({
      projectId,
      to: 'ARCHIVED',
      actorUserId: userId,
      reason: 'The sprint is over.',
    });
    expect(archived.ok).toBe(true);

    // A card can still be corrected.
    const corrected = await fillCard({
      opportunityId: id,
      actorRef: userId,
      patch: { nextAction: 'Send the invoice' },
    });
    expect(corrected.ok).toBe(true);

    // Money still moves. This is the customer's obligation, not the sprint's.
    const paid = await recordMoneyEvent({
      projectId,
      opportunityId: id,
      kind: 'PIPELINE_AGREED',
      amountCents: 75_000,
      currency: 'USD',
      idempotencyKey: 'agreed-1',
      actorRef: userId,
    });
    expect(paid.ok).toBe(true);

    // A need can still be raised against it.
    const need = await raiseNeed({
      projectId,
      opportunityId: id,
      actorRef: userId,
      blockedAction: 'Send a hosted invoice',
      whyItMatters: 'The buyer cannot pay without one.',
      recommendedPath: 'Use a hosted payment link from the existing provider account.',
      setupEffort: 'Minutes, no code.',
      nextStep: 'Create the link and send it.',
      completionCondition: 'A payable link exists and the buyer has it.',
    });
    expect(need.ok).toBe(true);
  });

  it('skips a queued cash idea while the sprint is not active, and charges it nothing', async () => {
    /*
     * The second entrance. An idea captured while the sprint was active can
     * still be queued when it winds down, and launching it then would be
     * exactly the new discovery the wind-down exists to stop — so the rule is
     * asked at the producer *and* here, because a guard on one entrance is not
     * a guard.
     */
    await activated();
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'An idea that produced a research question',
      mechanism: 'TEMPORARY_EXPLOIT',
      currency: 'USD',
    });
    if (!captured.ok) throw new Error('capture failed');

    const candidate = await createCandidate({
      projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title: 'What is the remaining demand for this?',
      statement: 'Establish how many units of this opening remain.',
    });
    await updateOpportunity(captured.value.id, { candidate_id: candidate.id });

    const active = await getCashMode(projectId);
    expect(await launchableUnderCashMode({ candidateId: candidate.id, mode: active })).toBe(true);

    await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: 'Enough for now.',
    });
    const wound = await getCashMode(projectId);
    expect(await launchableUnderCashMode({ candidateId: candidate.id, mode: wound })).toBe(false);

    // The candidate is untouched: no state moved, no reason was written, and it
    // becomes launchable again by itself.
    const after = await getCandidate(candidate.id);
    expect(after!.state).toBe(candidate.state);
    expect(after!.reason).toBe(candidate.reason);

    await setLifecycle({
      projectId,
      to: 'ACTIVE',
      actorUserId: userId,
      reason: 'Back on.',
    });
    expect(
      await launchableUnderCashMode({ candidateId: candidate.id, mode: await getCashMode(projectId) }),
    ).toBe(true);
  });

  it('keeps researching for a customer already owed something', async () => {
    /*
     * The first version of this guard read every linked candidate as discovery,
     * so winding a sprint down stopped Brain researching a question it needed
     * in order to *deliver* what a customer had already been promised. That is
     * the off switch reaching past the thing it owns — the `russell_cycle`
     * mistake this module exists to refuse, one altitude down.
     */
    await activated();
    await createAuthority({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'Cash Mode commercial authority',
      allowedActions: [...COMMERCIAL_ACTIONS],
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 100_000,
      maxPerActionCents: 40_000,
      maxConcurrent: 3,
      currency: 'USD',
    });

    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'A piece somebody is now owed',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    if (!captured.ok) throw new Error('capture failed');
    await completeCard(captured.value.id);
    expect((await markReady({ opportunityId: captured.value.id, actorRef: userId })).ok).toBe(true);
    expect(
      (
        await beginExecution({
          opportunityId: captured.value.id,
          actorRef: userId,
          firstAction: {
            action: 'CONTACT_BUYER',
            performedBy: 'PERSON',
            detail: 'Emailed the owner and they replied.',
            requestKey: actionKey(captured.value.id, 'CONTACT_BUYER', 'first'),
          },
        })
      ).ok,
    ).toBe(true);

    const support = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: 'Which format does this buyer need the file in?',
      statement: 'Establish the delivery format this customer’s system accepts.',
    });
    await updateOpportunity(captured.value.id, { candidate_id: support.id });

    await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: 'No new pieces.',
    });
    const wound = await getCashMode(projectId);
    expect(await launchableUnderCashMode({ candidateId: support.id, mode: wound })).toBe(true);

    // And it stays true once the money is in but the record is still open.
    // Through the real journey: `advance` refuses a bare move to either state.
    await walkToCollected({ projectId, opportunityId: captured.value.id, userId });
    expect((await getOpportunity(captured.value.id))?.state).toBe('COLLECTED');
    expect(
      await launchableUnderCashMode({ candidateId: support.id, mode: await getCashMode(projectId) }),
    ).toBe(true);
  });

  it('stops the discovery the producer actually queued', async () => {
    /*
     * Built by `openDiscovery` rather than by hand, because the defect was
     * exactly a bucket that a hand-built fixture could not have: the guard
     * asked whether a candidate had an opportunity on `candidate_id`, and a
     * discovery bucket has none — its link lives on
     * `discovered_by_candidate_id`, and a bucket that has not found anything
     * yet has no link at all. So "no link" read as "not a cash idea" and the
     * queued buckets, which are the whole of what winding down stops, kept
     * launching.
     *
     * A test that made its own candidate agreed with the code either way.
     */
    await activated();
    const [opened] = await openDiscovery({ projectId });
    expect(opened).toBeTruthy();

    const active = await getCashMode(projectId);
    expect(await launchableUnderCashMode({ candidateId: opened!.candidateId, mode: active })).toBe(
      true,
    );

    await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: 'No new pieces.',
    });
    expect(
      await launchableUnderCashMode({
        candidateId: opened!.candidateId,
        mode: await getCashMode(projectId),
      }),
    ).toBe(false);

    // Archived stops it too, and reactivating lets it go again — the idea
    // keeps its place rather than being cancelled.
    await setLifecycle({ projectId, to: 'ARCHIVED', actorUserId: userId, reason: 'Done.' });
    expect(
      await launchableUnderCashMode({
        candidateId: opened!.candidateId,
        mode: await getCashMode(projectId),
      }),
    ).toBe(false);
    await setLifecycle({ projectId, to: 'ACTIVE', actorUserId: userId, reason: 'Back on.' });
    expect(
      await launchableUnderCashMode({
        candidateId: opened!.candidateId,
        mode: await getCashMode(projectId),
      }),
    ).toBe(true);
  });

  it('leaves an ordinary research idea alone in a project that runs a sprint', async () => {
    // §30: Cash Mode is a section, not the definition of what Brain may pursue.
    await activated();
    await setLifecycle({
      projectId,
      to: 'ARCHIVED',
      actorUserId: userId,
      reason: 'Done.',
    });
    const unrelated = await createCandidate({
      projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title: 'An ordinary research question',
      statement: 'Establish which counties publish their fee schedules.',
    });
    expect(
      await launchableUnderCashMode({
        candidateId: unrelated.id,
        mode: await getCashMode(projectId),
      }),
    ).toBe(true);
  });

  it('reactivates, because archiving destroyed nothing', async () => {
    await activated();
    await setLifecycle({
      projectId,
      to: 'ARCHIVED',
      actorUserId: userId,
      reason: 'Done for now.',
    });
    expect((await discoveryAllowed(projectId)).allowed).toBe(false);

    const back = await setLifecycle({
      projectId,
      to: 'ACTIVE',
      actorUserId: userId,
      reason: 'A new opening turned up.',
    });
    expect(back.ok).toBe(true);
    expect((await discoveryAllowed(projectId)).allowed).toBe(true);
  });

  it('refuses a lifecycle change with no reason', async () => {
    await activated();
    const outcome = await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: '   ',
    });
    expect(outcome.ok).toBe(false);
  });

  it('treats a repeated move as already-done rather than as a failure', async () => {
    await activated();
    await setLifecycle({ projectId, to: 'WINDING_DOWN', actorUserId: userId, reason: 'Enough.' });
    const again = await setLifecycle({
      projectId,
      to: 'WINDING_DOWN',
      actorUserId: userId,
      reason: 'Enough.',
    });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.changed).toBe(false);
  });
});

describe('a completed one-off is a success even when the opening is finished', () => {
  it('records the money and the exhaustion as two separate facts', async () => {
    await activated();
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'A short-lived spread',
      mechanism: 'TEMPORARY_EXPLOIT',
      currency: 'USD',
      expiryReason: 'The supplier reprices on Friday',
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const id = captured.value.id;
    await completeCard(id);
    await markReady({ opportunityId: id, actorRef: userId });

    const { exhaust } = await import('../server/services/cash/opportunities.ts');
    const done = await exhaust({
      opportunityId: id,
      actorRef: userId,
      reason: 'The supplier repriced; there is no more of it.',
    });
    expect(done.ok).toBe(true);

    const after = await getOpportunity(id);
    // Exhausted, and still READY rather than archived: the opening being spent
    // says nothing about whether the transaction succeeded.
    expect(after!.exhaustedAt).not.toBeNull();
    expect(after!.state).toBe('READY');
  });
});

describe('a project with no sprint', () => {
  it('captures nothing, and says what would change that', async () => {
    const other = await createProject({ name: 'Another private operation' });
    const outcome = await capture({
      projectId: other.id,
      actorRef: userId,
      ownerUserId: userId,
      title: 'Something',
      mechanism: 'OTHER',
      currency: 'USD',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('has not been activated');
  });
});

describe('advancing through delivery', () => {
  it('refuses a move that does not follow the state it is in', async () => {
    await activated();
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'A job',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    if (!captured.ok) throw new Error('capture failed');
    const outcome = await advance({
      opportunityId: captured.value.id,
      to: 'DELIVERING',
      actorRef: userId,
    });
    expect(outcome.ok).toBe(false);
  });
});

/**
 * Four people, four private operations.
 *
 * The privacy boundary is the project membership `decideProjectAccess` already
 * enforces, so what is worth proving here is the one thing Cash Mode adds on
 * top of it: an opening one person passes on can be offered to another, and
 * doing so must not carry the first person's working with it.
 */
describe('an opening one person passes on', () => {
  it('goes to the other operation as a fresh opening, and keeps the first person’s record', async () => {
    await activated();
    const second = await createProject({ name: 'The second private operation' });
    const other = await createUser({
      email: `second-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Second owner',
      password: 'correct horse battery staple',
    });
    await activate({
      projectId: second.id,
      ownerUserId: other.id,
      actorUserId: other.id,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });

    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'A short-lived resale',
      mechanism: 'RESALE_OR_ASSET',
      currency: 'USD',
      source: 'A public listing',
    });
    if (!captured.ok) throw new Error('capture failed');
    await completeCard(captured.value.id);

    const { decline, reoffer } = await import('../server/services/cash/opportunities.ts');
    const passed = await decline({
      opportunityId: captured.value.id,
      actorUserId: userId,
      reason: 'No capacity this month.',
    });
    expect(passed.ok).toBe(true);

    const offered = await reoffer({
      opportunityId: captured.value.id,
      toProjectId: second.id,
      toOwnerUserId: other.id,
      actorUserId: userId,
      reason: 'It suits their supplier better.',
    });
    expect(offered.ok).toBe(true);
    if (!offered.ok) return;

    // A copy, in the other project, carrying the opening and none of the first
    // owner's card: their payer notes and their quoted price are their working.
    expect(offered.value.projectId).toBe(second.id);
    expect(offered.value.ownerUserId).toBe(other.id);
    expect(offered.value.payer).toBeNull();
    expect(offered.value.priceCents).toBeNull();
    expect(offered.value.reofferedFromId).toBe(captured.value.id);
    expect(offered.value.title).toBe('A short-lived resale');

    // The original keeps its row, its decline and its reason.
    const original = await getOpportunity(captured.value.id);
    expect(original!.state).toBe('DECLINED');
    expect(original!.declinedReason).toBe('No capacity this month.');
    expect(original!.payer).not.toBeNull();
  });

  it('refuses to push an opening into an operation that is not running a sprint', async () => {
    await activated();
    const dormant = await createProject({ name: 'Somebody who is not doing this' });
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'An opening',
      mechanism: 'OTHER',
      currency: 'USD',
    });
    if (!captured.ok) throw new Error('capture failed');
    const { decline, reoffer } = await import('../server/services/cash/opportunities.ts');
    await decline({ opportunityId: captured.value.id, actorUserId: userId, reason: 'Not mine.' });

    const offered = await reoffer({
      opportunityId: captured.value.id,
      toProjectId: dormant.id,
      toOwnerUserId: userId,
      actorUserId: userId,
      reason: 'Try them.',
    });
    expect(offered.ok).toBe(false);
  });

  it('refuses to reoffer something nobody has passed on', async () => {
    await activated();
    const second = await createProject({ name: 'Another operation' });
    await activate({
      projectId: second.id,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'Still mine',
      mechanism: 'OTHER',
      currency: 'USD',
    });
    if (!captured.ok) throw new Error('capture failed');

    const { reoffer } = await import('../server/services/cash/opportunities.ts');
    const offered = await reoffer({
      opportunityId: captured.value.id,
      toProjectId: second.id,
      toOwnerUserId: userId,
      actorUserId: userId,
      reason: 'Taking it off them.',
    });
    expect(offered.ok).toBe(false);
  });
});

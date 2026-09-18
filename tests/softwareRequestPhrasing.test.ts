/**
 * The conversational entrance, against the sentences people actually type.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists as a corpus rather than as a handful of examples
 * ---------------------------------------------------------------------------
 *
 * `asksForExecution` had been widened four times, each time by the one word a
 * real message had just been declined for. Driving fifty ordinary sentences
 * through it in one pass found **fifteen more misses and two inventions** — so
 * the alphabet was never the defect, the shape was. §27 records the correction:
 * strong verbs that count anywhere, weak ones that count only in imperative
 * position, negation scoped to the occurrence rather than the message, and
 * anaphora admitted only against a row.
 *
 * A corpus is the only thing that could have found that, and it is the only
 * thing that can stop it coming back — which is why the families below are
 * declared with their purpose rather than accumulated. **The declines matter
 * more than the accepts**: a miss costs one more sentence from the person, and
 * an invention puts an authorization card in front of somebody who was thinking
 * aloud, which teaches them to stop reading the cards.
 *
 * Nothing here buys inference. The gate is deterministic by design (§24: *no
 * inference is bought*), and the model half of the journey runs on the
 * subscription-backed Cowork fleet exactly as every other Russell turn does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createConversation } from '../server/repos/russellConversations.ts';
import {
  asksForExecution,
  captureSoftwareChange,
  softwareClarificationFor,
} from '../server/services/russell/software.ts';
import { addMessage } from '../server/repos/russellConversations.ts';
import { listSoftwareRequests } from '../server/repos/russellSoftware.ts';
import type { User } from '../server/domain/types.ts';

let fixture: TestProject;
let actor: User;

beforeEach(async () => {
  fixture = await freshProject();
  actor = await createUser({
    email: `owner-${Math.random().toString(36).slice(2)}@example.test`,
    displayName: 'An owner',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
    createdByType: 'SYSTEM',
    createdById: 't',
  });
});

afterEach(async () => {
  await teardown();
});

async function thread(): Promise<string> {
  const conversation = await createConversation({
    ownerUserId: actor.id,
    title: 'A thread',
    visibility: 'SHARED',
    projectId: fixture.project.id,
  });
  return conversation.id;
}

/* ========================================================================== */
/* What a person says when they want something done                           */
/* ========================================================================== */

/** The four verbs named as the ones that must work, in ordinary sentences. */
const PLAIN_VERBS = [
  'Improve this part of the site we are discussing — the quote page feels slow.',
  'Add a contact form to the services page.',
  'Change the checkout page so the total updates without a reload.',
  'Fix the bug where the quote form drops the message.',
  'Please fix the footer links on mobile.',
  'Can you add a sitemap to the site?',
  'Could you change the hero copy to say same-day?',
  'Would you fix the broken image on the pricing page?',
  'Go ahead and remove the old testimonials block.',
];

/**
 * The families the four widenings kept missing.
 *
 * Every one of these was declined by the previous gate with "nothing here asks
 * for a change to be made", and every one of them is a plain instruction.
 */
const OTHER_FAMILIES = [
  // moving and replacing
  'Move the phone number into the header.',
  'Swap the stock photo on the homepage for the new one.',
  // switching things on and off
  'Turn off the newsletter popup.',
  'Enable the sitemap generation on build.',
  // connecting
  'Hook the contact form up to the mailer.',
  'Wire the booking button to the calendar page.',
  // configuring
  'Set the meta description on the services page.',
  // tidying
  'Tidy up the spacing on the pricing cards.',
  'Clean up the leftover debug logging in the checkout flow.',
  // dealing with a named problem
  'Sort out the alignment on the homepage.',
  'Take care of that alignment issue we found.',
  'Handle the duplicate heading on the about page.',
  // making something behave
  'Make the sidebar collapse on phones.',
  'Make it faster — the gallery takes forever to load.',
  'Let us get that dropdown working on Safari.',
  'Ship a dark mode toggle for the settings page.',
];

/** Pointing at what is on screen, or at what was just said. */
const REFERRING_TO_CONTEXT = [
  'Improve the part of the site we were just talking about.',
  'Fix the thing we discussed earlier about the booking form.',
  'On the page I just showed you, change the button colour to match the header.',
];

describe('an ordinary request is read as one', () => {
  for (const message of [...PLAIN_VERBS, ...OTHER_FAMILIES, ...REFERRING_TO_CONTEXT]) {
    it(`asks: ${message}`, () => {
      expect(asksForExecution(message).asks).toBe(true);
    });
  }
});

/* ========================================================================== */
/* What must never become a card                                              */
/* ========================================================================== */

/** Saying not to do something is not saying to do it. */
const NEGATION = [
  'Do not change the checkout page, it is fine as it is.',
  'No need to fix the footer, we are replacing it anyway.',
  'Please do not add anything else to the homepage.',
  'Leave the booking form alone for now.',
  'Nothing to fix there, it is working.',
];

/** Weighing a change is not asking for one, however many verbs it holds. */
const HYPOTHETICAL = [
  'I wonder whether we should rewrite the checkout page.',
  'Would it be worth adding a live chat widget?',
  'One day we should improve the gallery loading.',
  'I have been thinking about migrating the blog to Markdown.',
  'What would it take to add multi-language support?',
  'Not sure if we should replace the booking widget.',
  'Eventually I want to rebuild the whole services section.',
  'Is it worth replacing the booking widget?',
];

/** Reporting is neither a request nor an idea. */
const REPORTS = [
  'We improved the gallery loading last week.',
  'I already fixed the footer links.',
  'They shipped the new pricing page yesterday.',
  'I optimised the checkout query yesterday, so that is done.',
];

/**
 * Description and questions that happen to contain a weak verb.
 *
 * This family is the reason weak verbs only count in imperative position. Every
 * sentence here would have matched a flat list.
 */
const NOT_INSTRUCTIONS = [
  'The address on the contact page is wrong, by the way.',
  'Do you know how the booking form works?',
  'The build fails on Node 20 for some reason.',
  'That link points at the old pricing page.',
  'There is a whole set of pages nobody visits.',
  'The point I was making is that the gallery is slow.',
  'Can you show me what the homepage looks like now?',
  'Could you explain how the quote form is wired up?',
  'What does the sort order on the listings depend on?',
  'The checkout page feels slow on my phone.',
  'Nice work on the new homepage.',
];

describe('nothing here is an instruction', () => {
  for (const message of [...NEGATION, ...HYPOTHETICAL, ...REPORTS, ...NOT_INSTRUCTIONS]) {
    it(`declines: ${message}`, () => {
      expect(asksForExecution(message).asks).toBe(false);
    });
  }

  it('declines a fragment too short to be a change request', () => {
    expect(asksForExecution('fix it').asks).toBe(false);
  });
});

/* ========================================================================== */
/* Negation is about an occurrence, not about a message                       */
/* ========================================================================== */

describe('a negated verb silences itself and nothing else', () => {
  it('still asks when a second clause asks', () => {
    /*
     * The case a message-level negation flag gets wrong, and it gets it wrong in
     * the expensive direction: the person did ask for the footer, and a gate
     * that declined would have looked like Russell ignoring them.
     */
    expect(asksForExecution('Do not touch the pricing page, but do fix the footer.').asks).toBe(
      true,
    );
    expect(
      asksForExecution('Please do not add a popup — instead, change the banner copy.').asks,
    ).toBe(true);
  });

  it('says which refusal it is', () => {
    expect(asksForExecution('Please do not add anything else to the homepage.').reason).toContain(
      'not to be changed',
    );
    expect(asksForExecution('I wonder whether we should rewrite the checkout.').reason).toContain(
      'weighs a change',
    );
  });
});

/* ========================================================================== */
/* Anaphora is answered by a row                                              */
/* ========================================================================== */

describe('“do that too” needs a that', () => {
  const CONTINUATIONS = [
    'Do that for the contact page too.',
    'Apply the same to the quotes page.',
    'Same again on the services page.',
    'Do the same thing for the about page.',
    'Apply what we agreed above to the quotes page.',
    // Carries a strong verb and is still anaphoric: "the same" as what?
    'Same fix on the services page please.',
  ];

  it('declines every one of them in a conversation that has asked for nothing', () => {
    for (const message of CONTINUATIONS) {
      const decision = asksForExecution(message, { hasPriorRequest: false });
      expect(decision.asks, message).toBe(false);
      // And says why, because "nothing here asks for a change" would be untrue:
      // something here does, and the thing it refers to is missing.
      expect(decision.reason).toContain('refers back');
    }
  });

  it('accepts every one of them once one exists', () => {
    for (const message of CONTINUATIONS) {
      expect(asksForExecution(message, { hasPriorRequest: true }).asks, message).toBe(true);
    }
  });

  it('still declines a negated continuation', () => {
    expect(
      asksForExecution('Do not do that for the contact page.', { hasPriorRequest: true }).asks,
    ).toBe(false);
  });

  /**
   * The referent is a row, and this is the test that proves the wiring rather
   * than the rule. A pure-function test would pass with `hasPriorRequest`
   * hard-coded either way — which is the "a mechanism nothing calls is not a
   * mechanism" failure this repository keeps recording.
   */
  it('reads the referent from the table, through the real capture path', async () => {
    const conversationId = await thread();

    const anaphoric = {
      projectId: fixture.project.id,
      conversationId,
      messageId: null,
      askedText: 'Do that for the contact page too.',
      title: 'Contact page, same change',
      objective: 'Apply the same change to the contact page.',
      expectedOutcome: 'The contact page matches.',
    };

    const first = await captureSoftwareChange(anaphoric);
    expect(first.request).toBeNull();
    expect(first.reason).toContain('refers back');
    expect(await listSoftwareRequests({ projectId: fixture.project.id })).toHaveLength(0);

    // Now ask for something plainly, in the same thread.
    const plain = await captureSoftwareChange({
      projectId: fixture.project.id,
      conversationId,
      messageId: null,
      askedText: 'Fix the quote form so it stops dropping the message.',
      title: 'Quote form drops the message',
      objective: 'Fix the quote form so a submitted message is not dropped.',
      expectedOutcome: 'A submitted message arrives.',
    });
    expect(plain.request?.state).toBe('PROPOSED');

    // The identical anaphoric sentence now has a referent, and lands.
    const second = await captureSoftwareChange(anaphoric);
    expect(second.request?.state).toBe('PROPOSED');
    expect(await listSoftwareRequests({ projectId: fixture.project.id })).toHaveLength(2);
  });

  it('does not borrow a referent from another conversation', async () => {
    const asked = await thread();
    await captureSoftwareChange({
      projectId: fixture.project.id,
      conversationId: asked,
      messageId: null,
      askedText: 'Fix the quote form so it stops dropping the message.',
      title: 'Quote form drops the message',
      objective: 'Fix the quote form so a submitted message is not dropped.',
      expectedOutcome: 'A submitted message arrives.',
    });

    const elsewhere = await thread();
    const outcome = await captureSoftwareChange({
      projectId: fixture.project.id,
      conversationId: elsewhere,
      messageId: null,
      askedText: 'Do that for the contact page too.',
      title: 'Contact page, same change',
      objective: 'Apply the same change to the contact page.',
      expectedOutcome: 'The contact page matches.',
    });
    /*
     * "That" is a word about *this* conversation. A referent from another thread
     * is a different person's sentence, and resolving across threads would let
     * one conversation put a card in another one's project.
     */
    expect(outcome.request).toBeNull();
    expect(outcome.reason).toContain('refers back');
  });
});

/* ========================================================================== */
/* A refusal a person can act on                                              */
/* ========================================================================== */

describe('every refusal names itself', () => {
  it('gives a different reason for each family', () => {
    const reasons = new Set(
      [
        'We improved the gallery loading last week.',
        'I wonder whether we should rewrite the checkout page.',
        'Leave the booking form alone for now.',
        'Please do not add anything else to the homepage.',
        'The checkout page feels slow on my phone.',
        'Do that for the contact page too.',
      ].map((message) => asksForExecution(message).reason),
    );
    // Six sentences, six different answers: a person told "nothing here asks for
    // a change" about a negation would have no idea what to do next.
    expect(reasons.size).toBe(6);
  });
});

/* ========================================================================== */
/* The question reaches the person who can answer it                          */
/* ========================================================================== */

/**
 * `clarify` was composed, carried onto the message row, and read by nothing.
 *
 * A person whose message named two projects got an ordinary reply and no card,
 * with nothing anywhere saying Brain had stopped on purpose or what would unstop
 * it. §24's sentence, at a new surface — and the fourth time this repository has
 * had to write that a mechanism nothing calls is not a mechanism.
 */
describe('what this conversation is waiting for a word about', () => {
  async function declined(
    conversationId: string,
    produced: Record<string, unknown>,
  ): Promise<void> {
    await addMessage({
      conversationId,
      role: 'RUSSELL',
      content: 'An answer.',
      produced,
    });
  }

  it('is nothing, in a conversation where nothing was refused', async () => {
    expect(await softwareClarificationFor(await thread())).toBeNull();
  });

  it('is nothing for a refusal a person cannot act on', async () => {
    const conversationId = await thread();
    /*
     * "It weighs a change rather than asking for one" is a *correct* refusal to
     * a remark, and prompting somebody to answer it would be Brain asking for a
     * decision they never raised. Only the refusals with an answer surface.
     */
    await declined(conversationId, {
      softwareDeclined: true,
      gateReason: 'it weighs a change rather than asking for one',
    });
    expect(await softwareClarificationFor(conversationId)).toBeNull();
  });

  it('carries the server’s own sentence when the message named two projects', async () => {
    const conversationId = await thread();
    await declined(conversationId, {
      softwareDeclined: true,
      gateReason: 'AMBIGUOUS',
      clarify: 'This conversation is about Deal Dispatch, and you have named V4.',
    });
    const clarification = await softwareClarificationFor(conversationId);
    expect(clarification?.kind).toBe('AMBIGUOUS_PROJECT');
    expect(clarification?.question).toContain('named V4');
  });

  it('falls back to its own words when no sentence was carried', async () => {
    const conversationId = await thread();
    await declined(conversationId, { softwareDeclined: true, gateReason: 'NO_PROJECT_ATTACHED' });
    const clarification = await softwareClarificationFor(conversationId);
    expect(clarification?.kind).toBe('NO_PROJECT');
    expect(clarification?.question).toMatch(/which site|project/i);
  });

  it('asks about the missing referent, and stops once one exists', async () => {
    const conversationId = await thread();
    await declined(conversationId, {
      softwareDeclined: true,
      gateReason:
        'it refers back to a change, and nothing has been asked for in this conversation yet',
    });
    expect((await softwareClarificationFor(conversationId))?.kind).toBe('NO_REFERENT');

    await captureSoftwareChange({
      projectId: fixture.project.id,
      conversationId,
      messageId: null,
      askedText: 'Fix the quote form so it stops dropping the message.',
      title: 'Quote form drops the message',
      objective: 'Fix the quote form so a submitted message is not dropped.',
      expectedOutcome: 'A submitted message arrives.',
    });

    /*
     * Answered by doing, rather than by saying. A question still on screen after
     * the person has settled it is the status-contradicting-the-control defect
     * §29 records, one surface along.
     */
    expect(await softwareClarificationFor(conversationId)).toBeNull();
  });

  it('stops asking even when the capture lands in the same millisecond', async () => {
    /*
     * The ordering this rests on was `createdAt > refusal.at`, and both are
     * ISO-8601 to the millisecond — so on a machine quick enough to write the
     * refusal and the capture answering it inside one millisecond, the
     * question stayed on screen after the person had settled it. It passed
     * here and failed in CI, which is the whole tell: an ordering that is true
     * only sometimes is not an ordering.
     *
     * The timestamps are forced equal rather than raced, because a test that
     * hoped for the collision would be the same flake wearing a different hat.
     */
    const conversationId = await thread();
    await declined(conversationId, {
      softwareDeclined: true,
      gateReason:
        'it refers back to a change, and nothing has been asked for in this conversation yet',
    });
    await captureSoftwareChange({
      projectId: fixture.project.id,
      conversationId,
      messageId: null,
      askedText: 'Fix the quote form so it stops dropping the message.',
      title: 'Quote form drops the message',
      objective: 'Fix the quote form so a submitted message is not dropped.',
      expectedOutcome: 'A submitted message arrives.',
    });

    const db = getDb();
    const stamp = '2026-09-18T00:00:00.000Z';
    await db.run('UPDATE russell_messages SET created_at = ? WHERE conversation_id = ?', [
      stamp,
      conversationId,
    ]);
    await db.run('UPDATE russell_software_requests SET created_at = ? WHERE conversation_id = ?', [
      stamp,
      conversationId,
    ]);

    expect(await softwareClarificationFor(conversationId)).toBeNull();
  });

  it('reports the most recent refusal, not the first', async () => {
    const conversationId = await thread();
    await declined(conversationId, { softwareDeclined: true, gateReason: 'NO_PROJECT_ATTACHED' });
    await declined(conversationId, {
      softwareDeclined: true,
      gateReason: 'AMBIGUOUS',
      clarify: 'You have named V4 and V2.',
    });
    expect((await softwareClarificationFor(conversationId))?.question).toContain('V4 and V2');
  });
});

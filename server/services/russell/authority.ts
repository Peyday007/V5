/**
 * What Russell may do on this project, in the words a person decides in.
 *
 * The grant itself has always lived in `repos/russellAuthority.ts` and has
 * always been enforced there — `checkAuthority` and `reserve` are untouched by
 * this module and are still the only things that decide whether work may
 * start. What was missing was a way for the person who holds the project to
 * *see* and *make* that decision without leaving Russell.
 *
 * It was on the operator console, and that was wrong. §22 puts the console's
 * buttons there for a specific reason — "a machine that could create its own
 * work could also create work nobody asked for" — and that reasoning is about
 * **machines**, not about the person who owns the project. Applying it to them
 * sent the one decision Russell most obviously needs from a person out of
 * Russell and into an administration surface §24 had already retired from the
 * normal route. The correction is recorded rather than quietly applied.
 *
 * What did *not* move: nothing about authorization. A grant is still made by an
 * authenticated person against a project they may write to, `owner_user_id` is
 * still taken from the principal and never from a field, the prohibitions are
 * still the constant list nobody supplies, and every ceiling is still spent
 * through `reserve`'s compare-and-swap. This module composes sentences and
 * counts rows. It decides nothing.
 */
import { listGoals, spendTotals } from '../../repos/russellAuthority.ts';
import { getUser } from '../../repos/identity.ts';
import { getProject } from '../../repos/projects.ts';
import type { RussellGoal } from '../../domain/types.ts';

/** The one class of work a grant made here authorizes. */
export const RESEARCH_WORK = 'RESEARCH';

/**
 * The limits, as a person sets them.
 *
 * Four numbers and a date, each with the sentence that says what it buys.
 * Exported so the screen renders the contract from the same object the
 * validator enforces — the manifest lesson, applied to a form: a rule enforced
 * against somebody who was never told it is a trap.
 */
export const AUTHORITY_LIMITS = [
  {
    key: 'maxConcurrent',
    label: 'At the same time',
    meaning:
      'How many investigations may run at once. One means Russell finishes before it starts ' +
      'the next. This is what your subscription can actually run in parallel, not an allowance ' +
      'that runs out.',
    max: 20,
    suggested: 1,
  },
] as const;

/**
 * What the grant still counts, without stopping anything.
 *
 * Three of the four numbers a person used to set were lifetime quotas —
 * missions, fragments, probes — and reaching one meant Russell stopped until
 * somebody topped it up. That is a machine for managing an allowance rather
 * than one that does the work, and the original specification had already said
 * measured starting values must not become permanent capacity ceilings.
 *
 * The counting stays, because what a grant has consumed is real and worth
 * showing. It is reported as *used*, with no denominator, because there is no
 * denominator: `ceilingsFor` returns `null` for these under the UNCAPPED
 * policy and `reserve` skips a null ceiling. A big number here would read as a
 * limit, and one day would be.
 */
export const AUTHORITY_COUNTERS = [
  {
    key: 'maxMissions',
    label: 'Pieces of research',
    meaning: 'Separate investigations Russell has started here.',
  },
  {
    key: 'maxFragments',
    label: 'Questions inside them',
    meaning: 'Bounded sub-questions those investigations broke down into.',
  },
  {
    key: 'maxProbes',
    label: 'Cheap looks',
    meaning: 'Quick checks taken before committing to a full investigation.',
  },
] as const;

/** A number a person sets. Today that is concurrency and nothing else. */
export type AuthorityLimitKey = (typeof AUTHORITY_LIMITS)[number]['key'];

/** A number a person reads. Counted, never capped. */
export type AuthorityCounterKey = (typeof AUTHORITY_COUNTERS)[number]['key'];

/**
 * Everything the card shows, whether it caps anything or not.
 *
 * One record rather than two, because a reader wants "what has this grant
 * done" in one place — and because splitting it would let the two drift about
 * which key means what.
 */
export type AuthoritySpendKey = AuthorityLimitKey | AuthorityCounterKey;

export interface AuthoritySpend {
  /** Everything this grant has committed, settled or still held. */
  used: number;
  /** What is running right now. */
  active: number;
  /**
   * The ceiling it is counted against, or `null` when nothing stops it.
   *
   * Null is the ordinary answer for missions, fragments and probes: those are
   * counted, not capped. Only concurrency has a real number, because it is
   * real provider capacity rather than an allowance.
   */
  limit: number | null;
}

export interface AuthorityView {
  /** The live grant, when there is one. Null is an ordinary answer. */
  grant: {
    id: string;
    name: string;
    /** Who decided, by name rather than by id. */
    grantedBy: string;
    grantedAt: string;
    expiresAt: string | null;
    /** True once the clock has passed the expiry. Derived, never stored. */
    expired: boolean;
    /** Plain sentences, one per line, describing exactly what it permits. */
    permits: string[];
    /** What it will never permit, however the numbers are set. */
    neverPermits: string[];
    spend: Record<AuthoritySpendKey, AuthoritySpend>;
  } | null;
  /**
   * Grants that are over: revoked, expired or spent. Kept because withdrawing
   * a decision is not the same as never having made one.
   */
  history: {
    id: string;
    name: string;
    state: string;
    endedAt: string | null;
    endedReason: string | null;
  }[];
  /**
   * What is true right now, in one sentence, whether or not a grant exists.
   * The screen shows this rather than assembling its own.
   */
  headline: string;
  /**
   * The limits themselves, sent rather than duplicated.
   *
   * The screen renders the form from this, so the contract a person is shown
   * and the contract the validator enforces are the same object — the manifest
   * lesson, applied to a form. Sending it also keeps the client from importing
   * a server *value*: a type crosses that boundary freely, a constant drags
   * `getDb` and the whole environment into the browser bundle, which a test
   * caught the moment it was tried.
   */
  limits: {
    key: AuthorityLimitKey;
    label: string;
    meaning: string;
    max: number;
    suggested: number;
  }[];
  /**
   * The numbers the card reports without capping anything.
   *
   * Sent alongside `limits` for the same reason those are: the screen renders
   * from the server's own list rather than a second copy, so a counter cannot
   * appear on one and not the other.
   */
  counters: { key: AuthorityCounterKey; label: string; meaning: string }[];
  /** A proposal only: nothing is granted until a person approves it. */
  suggestedApproval: { name: string; expiresAt: string };
  /** The suggested numbers for a first grant, from `limits`. */
  suggested: Record<AuthorityLimitKey, number>;
}

/** The four prohibitions worth saying out loud, from the constant list. */
const NEVER = [
  'Spend money, or turn on paid usage',
  'Contact anybody, or publish anything outside this Brain',
  'Widen its own access, or issue itself a credential',
  'Do work outside what this grant names',
];

/**
 * What this grant permits, said the way it is enforced.
 *
 * Under the UNCAPPED policy the sentences must not name a lifetime number,
 * because there is not one: research keeps going on the subscription that is
 * already paid for, and what bounds it is how much may run at once, what the
 * grant is *for*, and when it ends. A sentence promising "at most 2 pieces of
 * research" against a policy that stops at none would be the screen lying
 * about the validator — which is the exact failure `limits` is sent down to
 * prevent.
 */
function permitSentences(goal: RussellGoal): string[] {
  const capped = goal.workPolicy === 'CAPPED';
  const out = capped
    ? [
        `Start at most ${goal.maxMissions} ${goal.maxMissions === 1 ? 'piece' : 'pieces'} of research on this project`,
        `Run at most ${goal.maxConcurrent} at a time`,
        `Break them into at most ${goal.maxFragments} bounded questions`,
        `Take at most ${goal.maxProbes} cheap ${goal.maxProbes === 1 ? 'look' : 'looks'} before committing to one`,
      ]
    : [
        'Keep researching this project for as long as there is work worth doing',
        `Run at most ${goal.maxConcurrent} ${goal.maxConcurrent === 1 ? 'investigation' : 'investigations'} at a time, on the subscription you already pay for`,
        'Break each one into as many bounded questions as the evidence actually needs',
        'Take a cheap look before committing to a full investigation, whenever that is the cheaper answer',
      ];
  out.push(
    goal.expiresAt
      ? `Do all of that until ${goal.expiresAt}`
      : 'Do all of that until you withdraw this',
  );
  return out;
}

/**
 * Count what a grant has actually spent.
 *
 * Read from `russell_budget_reservations`, which is the same table `reserve`
 * writes and counts — so this cannot report a different number than the one the
 * ceiling is enforced against. `SETTLED` and live `HELD` are the cumulative
 * spend; live `HELD` alone is what is running. That split is mutation 13's, and
 * repeating its arithmetic somewhere else would be how the screen and the
 * enforcement drift apart.
 */
async function spendOf(
  goal: RussellGoal,
  now: string,
): Promise<Record<AuthoritySpendKey, AuthoritySpend>> {
  /*
   * Read through the same arithmetic enforcement uses, not a second copy of it.
   *
   * This function had its own: it counted reservation **rows** while
   * `totalsThroughMine` summed **`amount`**. Every caller passes no amount
   * today, so the two agreed by accident — and `reserve` takes one, so the
   * first reservation of 2 would have enforced as 2 and displayed as 1. A
   * person would have been told they had a mission left while Russell refused
   * to start one.
   *
   * `spendTotals` is that arithmetic, exported from the repository that owns
   * it and sitting next to the guard, so the number on the card and the number
   * in the refusal come from the same expression.
   */
  const [mission, fragment, probe] = await Promise.all([
    spendTotals(goal.id, 'MISSION', now),
    spendTotals(goal.id, 'FRAGMENT', now),
    spendTotals(goal.id, 'PROBE', now),
  ]);

  /*
   * `null` where the policy is uncapped, so the card cannot show a
   * denominator that stops nothing. Read from the same policy `ceilingsFor`
   * applies, rather than from a second opinion about it.
   */
  const capped = goal.workPolicy === 'CAPPED';
  return {
    maxMissions: {
      used: mission.committed,
      active: mission.live,
      limit: capped ? goal.maxMissions : null,
    },
    maxConcurrent: { used: mission.live, active: mission.live, limit: goal.maxConcurrent },
    maxFragments: {
      used: fragment.committed,
      active: fragment.live,
      limit: capped ? goal.maxFragments : null,
    },
    maxProbes: {
      used: probe.committed,
      active: probe.live,
      limit: capped ? goal.maxProbes : null,
    },
  };
}

function endedReason(goal: RussellGoal, now: string): string | null {
  if (goal.state === 'REVOKED') return goal.revokedReason ?? 'withdrawn';
  if (goal.expiresAt && goal.expiresAt <= now) return 'the date it was set to run until has passed';
  if (goal.state === 'PAUSED') return 'paused';
  return null;
}

/**
 * The whole picture for one project.
 *
 * `now` is injected so a test can ask what a person would see tomorrow without
 * waiting, and so expiry is decided by one clock rather than by whichever call
 * happens to evaluate `Date.now()` first.
 */
export async function authorityFor(input: {
  projectId: string;
  now?: string;
}): Promise<AuthorityView> {
  const now = input.now ?? new Date().toISOString();
  const goals = await listGoals(input.projectId);
  const project = await getProject(input.projectId);
  // Fixed expiry for the bounded 12A rollout. Never silently roll it forward
  // on a refresh: renewing authority requires a new explicit decision.
  const suggestedApproval = {
    name: `${project?.name ?? 'Project'} discovery research`,
    expiresAt: '2026-10-06T00:00:00.000Z',
  };

  const live = goals.find(
    (goal) => goal.state === 'ACTIVE' && (!goal.expiresAt || goal.expiresAt > now),
  );

  const suggested = Object.fromEntries(
    AUTHORITY_LIMITS.map((limit) => [limit.key, limit.suggested]),
  ) as Record<AuthorityLimitKey, number>;
  const limits = AUTHORITY_LIMITS.map((limit) => ({ ...limit }));
  const counters = AUTHORITY_COUNTERS.map((counter) => ({ ...counter }));

  const history = goals
    .filter((goal) => goal !== live)
    .map((goal) => ({
      id: goal.id,
      name: goal.name,
      state: goal.state,
      endedAt: goal.revokedAt ?? goal.expiresAt,
      endedReason: endedReason(goal, now),
    }));

  if (!live) {
    return {
      grant: null,
      history,
      limits,
      counters,
      headline:
        'Russell may not start research on this project. It will still read what you say, ' +
        'capture ideas and rank them — and it will park every one of them rather than spend ' +
        'anything you have not agreed to.',
      suggested,
      suggestedApproval,
    };
  }

  // By name, not by id. "Granted by usr_1443…" answers nothing a year later.
  const owner = await getUser(live.ownerUserId);

  return {
    grant: {
      id: live.id,
      name: live.name,
      grantedBy: owner?.displayName ?? owner?.email ?? 'someone whose account has since gone',
      grantedAt: live.createdAt,
      expiresAt: live.expiresAt,
      expired: false,
      permits: permitSentences(live),
      neverPermits: NEVER,
      spend: await spendOf(live, now),
    },
    history,
    limits,
    counters,
    headline: `Russell may research on this project, within the limits you set on ${live.createdAt.slice(0, 10)}.`,
    suggested,
    suggestedApproval,
  };
}

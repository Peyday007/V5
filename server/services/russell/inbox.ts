/**
 * Needs You, as one inbox: everything that genuinely requires a person, from
 * every system that can ask, grouped by what kind of decision it is.
 *
 * Integration 3. Before this, the Needs You page read three of the eleven
 * places a decision can come from and the badge counted a different three, so
 * a commercial grant Cash Mode could not proceed without, a campaign waiting
 * for its release and a connector whose authorization had genuinely lapsed were
 * each only visible on their own section's page.
 *
 * It composes and decides nothing. Every item is read from the service that
 * owns it — `authorityFor`, `listOpenRequests`, `softwareNeedingPerson`, the
 * factory's own change requests and campaigns, `goalBriefing`'s pull-request
 * decisions, `cashView`'s review and journey, `listGoalBudgetViews`, and
 * `connectionView` — and every action an item offers is an operation that
 * already exists. Nothing here grants, approves, answers or retries anything.
 *
 * Two rules decide what is **not** an item, and they are the half that makes
 * this useful:
 *
 *   - **Only a person's turn.** A step Brain takes by itself, a step the buyer
 *     owes, work merely queued, a retry, a transient database failure — none of
 *     those is a decision, and putting them here is how an inbox teaches a
 *     person to stop reading it. The cash journey's own `owner` field decides
 *     this for commercial steps; nothing is inferred from prose.
 *   - **Reconnect only when authorization is genuinely gone.** A connection
 *     item exists when the member's tokens are revoked or expired
 *     (`authorizationExpired`, read from token rows) or the connection is
 *     `FAILED` / `MISBOUND` — never because a read failed. A source that could
 *     not be read is reported in `unreadable` with whether it was temporary,
 *     and the rest of the inbox still renders.
 */
import type { Principal } from '../../domain/types.ts';
import { classifyInfraFailure } from '../../db/infra.ts';
import { getDb } from '../../db/database.ts';
import { authorityFor } from './authority.ts';
import { listOpenRequests } from '../../repos/russellMissions.ts';
import { softwareNeedingPerson } from './software.ts';
import { listCampaigns, listChangeRequests } from '../../repos/factory.ts';
import { goalBriefing } from '../goals/briefing.ts';
import { decideProjectAccess } from '../identity/policy.ts';
import { listProjects } from '../../repos/projects.ts';
import { findCashRoot } from '../cash/root.ts';
import { decideCashRead } from '../cash/access.ts';
import { cashView } from '../cash/view.ts';
import { listGoalBudgetViews } from '../research/goalBudgetView.ts';
import { connectionView } from '../capacity/connection.ts';
import { connectionForUser } from '../../repos/capacityConnections.ts';
import { getUser } from '../../repos/identity.ts';
import type { JourneyStepKind } from '../cash/journey/view.ts';

/** The kinds of decision a person is asked for, in the order they are shown. */
export const INBOX_CATEGORIES = [
  'AUTHORITY',
  'BUDGET',
  'JUDGMENT',
  'RESEARCH_JUDGMENT',
  'BUYER',
  'INVOICE',
  'FINANCIAL',
  'RELEASE',
  'CONNECTION',
  'OTHER',
] as const;
export type InboxCategory = (typeof INBOX_CATEGORIES)[number];

export const INBOX_CATEGORY_LABELS: Record<InboxCategory, string> = {
  AUTHORITY: 'Permission to act',
  BUDGET: 'Budget and ceilings',
  JUDGMENT: 'Your judgment',
  RESEARCH_JUDGMENT: 'Research that needs your judgment',
  BUYER: 'Buyers and agreements',
  INVOICE: 'Invoice details',
  FINANCIAL: 'Money that needs a person',
  RELEASE: 'Approve, merge or release a build',
  CONNECTION: 'Connections and accounts',
  OTHER: 'Other decisions',
};

/**
 * What a person does to answer an item. Each is an operation that already has
 * a route; `OPEN` sends them to the surface that holds the control, because a
 * second copy of every control here would be a second place for it to drift.
 */
export type InboxAction =
  | { type: 'GRANT_RESEARCH_AUTHORITY' }
  | {
      type: 'ANSWER_REQUEST';
      requestId: string;
      choices: { key: string; label: string; consequence: string }[];
      recommendation: string | null;
    }
  /** The software card for one request: authorize it, or follow it once it is under way. */
  | { type: 'SOFTWARE'; requestId: string }
  | { type: 'OPEN'; destination: 'CASH' | 'BUILD' | 'RESEARCH' | 'PEOPLE'; label: string }
  | { type: 'EXTERNAL'; url: string; label: string };

export interface InboxItem {
  id: string;
  category: InboxCategory;
  /** What is being asked, in one line. */
  title: string;
  /** Why a person is being asked rather than Brain deciding. */
  reason: string;
  /** What happens if nobody answers. */
  ifIgnored: string;
  /** The exact thing to do. */
  requestedAction: string;
  /** What this is about: a project, an opportunity, a campaign, a goal, a connection. */
  affects: string;
  /** Whether Brain keeps working on other things meanwhile. */
  continuing: string;
  urgency: 'URGENT' | 'BLOCKING' | 'WHENEVER';
  since: string | null;
  action: InboxAction;
}

export interface Inbox {
  items: InboxItem[];
  /** The category headings, in display order, so the client restates neither. */
  categories: { key: InboxCategory; label: string }[];
  /** Sources that could not be read this time, and whether that is temporary. */
  unreadable: { source: string; temporary: boolean }[];
}

const CONTINUING = 'Brain carries on with everything else meanwhile.';

/**
 * The blocker kinds a person can answer. The others — nowhere to run it, no
 * independent reviewer yet, a base that moved — Brain resolves by itself, and
 * the projection marks them `personNeeded` only because somebody may want to
 * know. An inbox that held them would teach a person to stop reading it.
 */
const PERSON_BLOCKERS = new Set([
  'AWAITING_HUMAN_RELEASE',
  'EXTERNAL_CREDENTIAL_REQUIRED',
  'SCOPE_AMENDMENT_REQUIRED',
  'REPAIR_OWNERSHIP_UNRESOLVED',
  'CONTRADICTORY_CONTRACT',
  'UNIT_EXHAUSTED_ATTEMPTS',
  'DEPENDENCY_CYCLE',
]);

/** Which inbox category a person-owned cash journey step belongs to. Pure. */
export function categoryOfJourneyStep(kind: JourneyStepKind): InboxCategory {
  switch (kind) {
    case 'CONTACT':
    case 'AGREEMENT':
    case 'FOLLOW_UP':
    case 'AWAIT_BUYER':
    case 'ACCEPTANCE':
      return 'BUYER';
    case 'INVOICE_TERMS':
    case 'ISSUE_INVOICE':
    case 'OVERDUE':
      return 'INVOICE';
    case 'PAYMENT':
    case 'PAYMENT_UNKNOWN':
    case 'SETTLEMENT':
    case 'COLLECT':
      return 'FINANCIAL';
    case 'FULFIL':
    default:
      return 'OTHER';
  }
}

/** Which inbox category a cash review item belongs to. Pure. */
export function categoryOfCashReview(key: string): InboxCategory {
  if (key === 'AUTHORITY') return 'AUTHORITY';
  if (key === 'SHORTFALL') return 'BUDGET';
  return 'JUDGMENT';
}

async function source<T>(
  name: string,
  unreadable: Inbox['unreadable'],
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    unreadable.push({ source: name, temporary: classifyInfraFailure(error) !== null });
    return null;
  }
}

const URGENCY_ORDER = { URGENT: 0, BLOCKING: 1, WHENEVER: 2 } as const;

export async function inboxFor(input: {
  principal: Principal;
  projectId: string | null;
  origin: string;
}): Promise<Inbox> {
  const unreadable: Inbox['unreadable'] = [];
  const items: InboxItem[] = [];
  const projectId = input.projectId;

  const [authority, requests, software, changeRequests, campaigns, budgets] = projectId
    ? await Promise.all([
        source('research permission', unreadable, () => authorityFor({ projectId })),
        source('open questions', unreadable, () => listOpenRequests(projectId)),
        source('software requests', unreadable, () => softwareNeedingPerson(projectId)),
        source('build objectives', unreadable, () => listChangeRequests(projectId)),
        source('builds', unreadable, () => listCampaigns(projectId)),
        source('research budgets', unreadable, () => listGoalBudgetViews(projectId)),
      ])
    : [null, null, null, null, null, null];

  /* Permission for Russell to research at all. */
  if (authority && authority.grant === null) {
    items.push({
      id: 'authority:research',
      category: 'AUTHORITY',
      title: 'Let Russell research in this project',
      reason: 'Starting research spends shared capacity, so it needs a standing permission a person grants once.',
      ifIgnored: 'Russell keeps ideas and conversations, and starts no research here.',
      requestedAction: 'Approve the standing research permission, or change its limits first.',
      affects: 'This project',
      continuing: 'Nothing else in this project can start research until this is answered.',
      urgency: 'BLOCKING',
      since: null,
      action: { type: 'GRANT_RESEARCH_AUTHORITY' },
    });
  }

  /* Questions Russell parked for a person. */
  /*
   * A PRIVATE request belongs in its owner's own Needs you (§50): the owner of
   * the conversation it came from. One without a conversation stays with the
   * project, as it always has.
   */
  const privateOwners = new Map<string, string>();
  const privateIds = (requests ?? []).filter((r) => r.visibility === 'PRIVATE' && r.conversationId);
  if (privateIds.length > 0) {
    const rows = await getDb().all<{ id: string; owner_user_id: string }>(
      `SELECT id, owner_user_id FROM russell_conversations WHERE id IN (${privateIds.map(() => '?').join(', ')})`,
      privateIds.map((r) => r.conversationId!),
    );
    for (const row of rows) privateOwners.set(row.id, row.owner_user_id);
  }
  for (const request of requests ?? []) {
    if (
      request.visibility === 'PRIVATE' &&
      request.conversationId &&
      privateOwners.get(request.conversationId) !== input.principal.id
    ) {
      continue;
    }
    items.push({
      id: `request:${request.id}`,
      category: request.missionId ? 'RESEARCH_JUDGMENT' : 'JUDGMENT',
      title: request.authorityNeeded,
      reason: request.whyNotRussell,
      ifIgnored: 'The work this is about stays stopped at this question.',
      requestedAction: 'Choose one of the answers below.',
      affects: request.missionId ? 'A piece of research' : 'This project',
      continuing: CONTINUING,
      urgency: request.urgency,
      since: request.createdAt,
      action: {
        type: 'ANSWER_REQUEST',
        requestId: request.id,
        choices: request.choices.map((choice) => ({
          key: choice.key,
          label: choice.label,
          consequence: choice.consequence,
        })),
        recommendation: request.recommendation,
      },
    });
  }

  /* Software asked for in conversation. */
  const coveredChangeRequests = new Set<string>();
  const coveredCampaigns = new Set<string>();
  for (const entry of software ?? []) {
    if (entry.request.changeRequestId) coveredChangeRequests.add(entry.request.changeRequestId);
    if (entry.request.campaignId) coveredCampaigns.add(entry.request.campaignId);
    if (entry.request.state === 'PROPOSED') {
      items.push({
        id: `software:${entry.request.id}`,
        category: 'AUTHORITY',
        title: `Authorize a change: ${entry.request.title}`,
        reason: 'Changing code is a decision a person makes; Brain will not start building without it.',
        ifIgnored: 'Nothing is built and nothing is spent.',
        requestedAction: 'Choose the repository it may change and authorize it, or decline it.',
        affects: entry.request.title,
        continuing: CONTINUING,
        urgency: 'WHENEVER',
        since: entry.request.createdAt,
        action: { type: 'SOFTWARE', requestId: entry.request.id },
      });
    } else if (
      entry.awaitingPerson &&
      (entry.campaign?.personNeeded.needed !== true ||
        entry.campaign.personNeeded.kind === 'RELEASE_APPROVAL' ||
        PERSON_BLOCKERS.has(entry.campaign.blocker?.kind ?? ''))
    ) {
      items.push({
        id: `software:${entry.request.id}`,
        category: 'RELEASE',
        title: entry.request.title,
        reason: entry.line,
        ifIgnored: 'The build stays where it is.',
        requestedAction: entry.pullRequestUrl ? 'Review the pull request.' : 'Open the build and answer it.',
        affects: entry.request.title,
        continuing: CONTINUING,
        urgency: 'BLOCKING',
        since: entry.request.updatedAt,
        action: { type: 'SOFTWARE', requestId: entry.request.id },
      });
    }
  }

  /* Build objectives waiting for approval, and builds waiting for release. */
  for (const request of changeRequests ?? []) {
    if (request.state !== 'DRAFT' || coveredChangeRequests.has(request.id)) continue;
    items.push({
      id: `change-request:${request.id}`,
      category: 'AUTHORITY',
      title: `Approve a build objective: ${request.objective}`,
      reason: 'A build objective is pinned and waits for a person before any work runs.',
      ifIgnored: 'The build never starts.',
      requestedAction: 'Read the objective and approve it on Build.',
      affects: request.repository,
      continuing: CONTINUING,
      urgency: 'WHENEVER',
      since: request.createdAt,
      action: { type: 'OPEN', destination: 'BUILD', label: 'Open Build' },
    });
  }
  for (const campaign of campaigns ?? []) {
    if (campaign.state !== 'AWAITING_RELEASE' || coveredCampaigns.has(campaign.id)) continue;
    items.push({
      id: `release:${campaign.id}`,
      category: 'RELEASE',
      title: 'Approve the release of a finished build',
      reason: 'The build passed review; releasing it is a person’s decision.',
      ifIgnored: 'The finished work is kept and is not released.',
      requestedAction: 'Read what is being released and approve or refuse it on Build.',
      affects: 'A finished build',
      continuing: CONTINUING,
      urgency: 'BLOCKING',
      since: campaign.updatedAt,
      action: { type: 'OPEN', destination: 'BUILD', label: 'Open Build' },
    });
  }

  /* Pull requests only a person can merge, from the goals this person can read. */
  const goals = await source('goals', unreadable, async () => {
    const projects = await listProjects();
    const readable = projects
      .filter((project) => decideProjectAccess(input.principal, project.id, 'READ').allowed)
      .map((project) => project.id);
    return goalBriefing(readable);
  });
  for (const decision of goals?.briefing.decisions ?? []) {
    if (decision.kind !== 'PULL_REQUEST') continue;
    items.push({
      id: `pull-request:${decision.ref}`,
      category: 'RELEASE',
      title: 'Merge a finished build’s pull request',
      reason: 'The build passed its independent review and its pull request is open. Brain never merges; that step is yours.',
      ifIgnored: `Waiting on this: ${decision.waitingWork.join('; ') || 'the goal it belongs to'}.`,
      requestedAction: 'Read the pull request and merge it on GitHub if it is right.',
      affects: decision.goalTitle,
      continuing: CONTINUING,
      urgency: 'BLOCKING',
      since: decision.since,
      action: /^https?:\/\//.test(decision.ref)
        ? { type: 'EXTERNAL', url: decision.ref, label: 'Open the pull request' }
        : { type: 'OPEN', destination: 'BUILD', label: 'Open Build' },
    });
  }

  /* Research goals stopped by a ceiling a person set. */
  for (const budget of budgets ?? []) {
    if (budget.state === 'REVOKED' || budget.state === 'PAUSED') continue;
    if (budget.stoppedBy !== 'PACKETS' && budget.stoppedBy !== 'FRAGMENTS' && budget.stoppedBy !== 'DEADLINE') continue;
    items.push({
      id: `budget:${budget.goalId}`,
      category: 'BUDGET',
      title: `Research goal “${budget.name}” has reached its limit`,
      reason: budget.stoppingSentence,
      ifIgnored: 'Research already done is kept; nothing new starts under this goal.',
      requestedAction: 'Open Research and approve the proposed successor goal, or change its limits first.',
      affects: budget.name,
      continuing: CONTINUING,
      urgency: 'WHENEVER',
      since: null,
      action: { type: 'OPEN', destination: 'RESEARCH', label: 'Open Research' },
    });
  }

  /* Cash: the sprint's own review, and the journey steps that are a person's. */
  const cash = await source('cash', unreadable, async () => {
    const root = await findCashRoot();
    if (!root) return null;
    const decision = await decideCashRead(root.id);
    if (decision.scope !== 'FULL') return null;
    return cashView({ projectId: root.id });
  });
  if (cash) {
    for (const review of cash.decisionsForMe.items) {
      items.push({
        id: `cash-review:${review.key}`,
        category: categoryOfCashReview(review.key),
        title: review.title,
        reason: review.why,
        ifIgnored: review.consequence,
        requestedAction: review.recommendation,
        affects: 'Cash',
        continuing: CONTINUING,
        urgency: review.urgency,
        since: null,
        action: { type: 'OPEN', destination: 'CASH', label: 'Open Cash' },
      });
    }
    for (const deal of cash.myCurrentWork.journey.deals) {
      deal.next.forEach((step, index) => {
        if (step.owner !== 'PERSON') return;
        items.push({
          id: `cash-step:${deal.opportunityId}:${step.kind}:${index}`,
          category: categoryOfJourneyStep(step.kind),
          title: step.step,
          reason: step.why,
          ifIgnored: 'This deal waits here.',
          requestedAction: 'Open the deal in Cash and record it there.',
          affects: deal.title,
          continuing: CONTINUING,
          urgency: step.kind === 'PAYMENT_UNKNOWN' || step.kind === 'OVERDUE' ? 'URGENT' : 'BLOCKING',
          since: null,
          action: { type: 'OPEN', destination: 'CASH', label: 'Open the deal in Cash' },
        });
      });
    }
  }

  /* This person's own Claude connection, only when authorization is genuinely gone. */
  const connection = await source('your Claude connection', unreadable, async () => {
    /*
     * Only a connection that already exists. `connectionView` creates the row
     * that assigns a member their names, which is right on their own page and
     * wrong here: opening the shell must not start a connection journey for
     * somebody who has never asked for one (§44).
     */
    if (!(await connectionForUser(input.principal.id))) return null;
    const user = await getUser(input.principal.id);
    return user ? connectionView({ user, origin: input.origin }) : null;
  });
  if (
    connection &&
    (connection.authorizationExpired || connection.state === 'FAILED' || connection.state === 'MISBOUND')
  ) {
    items.push({
      id: 'connection:me',
      category: 'CONNECTION',
      title: 'Your Claude connection needs you',
      reason: connection.headline,
      ifIgnored: 'Your Claude account contributes no capacity until this is fixed; other accounts keep working.',
      requestedAction: connection.nextAction ?? 'Open your connection and follow its next step.',
      affects: 'Your Claude connection',
      continuing: CONTINUING,
      urgency: 'WHENEVER',
      since: null,
      action: { type: 'OPEN', destination: 'PEOPLE', label: 'Open your connection' },
    });
  }

  items.sort((a, b) => {
    const byCategory = INBOX_CATEGORIES.indexOf(a.category) - INBOX_CATEGORIES.indexOf(b.category);
    if (byCategory !== 0) return byCategory;
    return URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
  });
  return {
    items,
    categories: INBOX_CATEGORIES.map((key) => ({ key, label: INBOX_CATEGORY_LABELS[key] })),
    unreadable,
  };
}

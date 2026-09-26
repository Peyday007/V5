/**
 * Cash Mode over HTTP.
 *
 * Thin by design: every decision is the server's, and this file's whole job is
 * to name the routes and the shapes. Nothing here derives a figure, composes a
 * sentence about a permission, or decides what state something is in — a client
 * that did any of those would be a second opinion about one sprint, which is
 * the defect §29 records.
 */
import { api } from './api.ts';
import type { CashReadiness } from '../../../server/services/cash/readiness.ts';
/*
 * The roadmap and the forecast are the server's shapes, imported rather than
 * restated. `CashReadiness` already established the precedent here and the
 * reason is the same one §24 gives for sending an authority's limits down with
 * the view: a client holding its own copy of a contract is a second contract,
 * and the copy is the one that drifts. These are type-only imports, so nothing
 * of the server reaches the bundle.
 */
import type { CashRoadmap } from '../../../server/services/cash/roadmap.ts';
import type { CashForecast } from '../../../server/services/cash/forecast.ts';
import type { SharedCashView } from '../../../server/services/cash/shared.ts';
import type { CommissionView } from '../../../server/services/cash/monetization/inFlight.ts';
import type {
  MonetizationSurface,
  TopEntry,
} from '../../../server/services/cash/monetization/surface.ts';
import type { LedgerEntry } from '../../../server/services/cash/monetization/ledger.ts';
import type { RankExplanation } from '../../../server/services/cash/monetization/rank.ts';

export type {
  CashReadiness,
  CashRoadmap,
  CashForecast,
  SharedCashView,
  MonetizationSurface,
  LedgerEntry,
  TopEntry,
  RankExplanation,
};

/**
 * Two readers of one section, told apart by the server rather than by the page.
 *
 * `FULL` is the owner's view — money, the grant, the decisions, the private
 * execution state. `SHARED` is the frontier every member of this Brain may
 * read, and it is a *strictly smaller payload* rather than the same one with
 * fields blanked: there is no shape of the access defect a screen could paper
 * over, because the private fields are absent from the wire.
 */
/**
 * What may be *offered*, decided by the server's own `decideProjectAccess`.
 *
 * Optional because an older deployment does not send it, and the client fails
 * closed rather than assuming: see `cashPage.ts`. It authorizes nothing — every
 * route re-decides at the moment anything happens.
 */
export interface CashCapabilities {
  mayAdminister: boolean;
  mayGrantAuthority: boolean;
  mayViewPrivateJob: boolean;
  mayActOnJob: boolean;
}

export type CashViewReading = (({ scope: 'FULL' } & CashView) | SharedCashView) & {
  capabilities?: CashCapabilities;
};

export type CashModeState = 'ACTIVE' | 'WINDING_DOWN' | 'ARCHIVED';

export type CashDisposition =
  | 'EXECUTE_NOW'
  | 'RUN_IN_PARALLEL'
  | 'WAIT_FOR_DEPENDENCY'
  | 'TEST_A_DECISIVE_UNKNOWN'
  | 'BEING_QUALIFIED'
  | 'EVIDENCE_ONLY'
  | 'ARCHIVED';

export interface CashMode {
  id: string;
  projectId: string;
  ownerUserId: string;
  objective: string;
  horizonDays: number;
  envelopeId: string;
  state: CashModeState;
  activatedAt: string;
  stateReason: string | null;
}

export interface CashPosition {
  currency: string;
  pipelineCents: number;
  customerPaymentsCents: number;
  availableFundsCents: number;
  unpaidCommitmentsCents: number;
  heldCommitmentsCents: number;
  reservesCents: number;
  deployableCents: number;
  completedContributionCents: number;
  shortfall: boolean;
  otherCurrencies: string[];
}

export interface CashOpportunity {
  id: string;
  title: string;
  mechanism: string;
  state: string;
  currency: string;
  priceCents: number | null;
  peakFundingCents: number | null;
  expiresAt: string | null;
  expiryReason: string | null;
  exhaustedAt: string | null;
  exhaustedReason: string | null;
  nextAction: string | null;
  outcome: string | null;
}

export interface Placement {
  opportunity: CashOpportunity;
  disposition: CashDisposition;
  because: string;
  missing: string[];
  /**
   * Whether this is evidence, a capture thesis, a qualified opportunity or
   * something ready to test — and what is still open before the next one.
   *
   * Optional here and required on the server, deliberately. A deploy replaces
   * the server and the browser tab separately, so for the minutes between them
   * a client built after this existed can hold a view fetched before it did.
   * Every reader falls back rather than throwing, which is the difference
   * between one blank badge and the whole section coming down.
   */
  tier?: TierReadingView;
}

/** One line of the Signal / Candidate / Qualified / Ready reading. */
export interface TierRequirementView {
  key: string;
  label: string;
  task: string;
  owner: 'BRAIN_RESEARCH' | 'BRAIN_PROPOSES' | 'PERSON_ONLY';
}

export interface TierReadingView {
  tier: 'SIGNAL' | 'CANDIDATE' | 'QUALIFIED' | 'READY_TO_TEST';
  establishes: string;
  doesNotEstablish: string;
  toAdvance: TierRequirementView[];
  answered: number;
  required: number;
  summary: string;
}

export interface CashEvent {
  id: string;
  kind: string;
  summary: string;
  actorRef: string;
  createdAt: string;
}

export interface CashNeed {
  id: string;
  blockedAction: string;
  whyItMatters: string;
  recommendedPath: string;
  expectedCostCents: number | null;
  setupEffort: string;
  nextStep: string;
  state: string;
}

export type ReviewAnswerKind =
  | 'GRANT_AUTHORITY'
  | 'RELEASE_COMMITMENT'
  | 'RECORD_MONEY'
  | 'FILL_CARD_FIELD'
  | 'NOTHING_TO_PRESS';

export interface ReviewAnswer {
  kind: ReviewAnswerKind;
  targets: string[];
  label: string;
  completionCondition: string;
}

/**
 * Where one answer on a card came from.
 *
 * `kind` is what a screen has to render differently. A card that showed Brain's
 * proposal the way it shows a published source would have told somebody a guess
 * was checked.
 */
export interface CashCardFact {
  field: string;
  kind: 'EVIDENCE' | 'RECOMMENDATION' | 'PERSON';
  value: string;
  claimId: string | null;
  basis: string | null;
  assumptions: string | null;
  uncertainty: string | null;
  decidedBy: string;
}

export interface ReviewItem {
  key: string;
  title: string;
  why: string;
  recommendation: string;
  consequence: string;
  urgency: 'URGENT' | 'BLOCKING' | 'WHENEVER';
  underlying: string[];
  /** Whether one act answers every row under it, or they merely look alike. */
  sharedRemedy: boolean;
  costCents: number | null;
  costNote: string | null;
  answer: ReviewAnswer;
}

/**
 * One line of the Cash Engine Card, as the server composed it.
 *
 * `kind` is the whole point and is never re-derived here: a gated research
 * claim, Brain's own estimate carrying its basis, a person's decision, or an
 * honest unknown. A screen that rendered an estimate the way it renders a fact
 * would have told somebody a guess was checked.
 */
export interface EngineCardEntryView {
  key: string;
  label: string;
  value: string | null;
  kind: 'FACT' | 'ESTIMATE' | 'DECISION' | 'UNKNOWN';
  task: string;
  /**
   * Whose question this is. The screen renders a person-answer control for
   * `PERSON_ONLY` and for nothing else — a blank Brain owns is Brain's work,
   * and its task is what gets shown instead.
   */
  owner: 'BRAIN_RESEARCH' | 'BRAIN_PROPOSES' | 'PERSON_ONLY';
  claimId: string | null;
  basis: string | null;
  assumptions: string | null;
  uncertainty: string | null;
}

export interface EngineCardView {
  opportunityId: string;
  entries: EngineCardEntryView[];
  unknowns: string[];
  validationState: string | null;
  recommendation: EngineCardEntryView | null;
}

export interface DerivedFigureView {
  key: string;
  label: string;
  formula: string;
  inputs: { field: string; value: string; claimId: string | null }[];
  value: string | null;
  /** Why it is null, when it is. Never an estimate standing in for a refusal. */
  withheld: string | null;
}

export interface CashView {
  mode: CashMode | null;
  objective: string | null;
  discovery: { open: boolean; reason: string };
  authority: {
    exists: boolean;
    id: string | null;
    lines: string[];
    maxConcurrent: number;
    heldCents: number;
    /**
     * The ceilings the grant carries, and what has been committed and spent
     * against them. Sent so the money picture can show an authorization as an
     * authorization rather than as a forecast.
     */
    maxCommittedCents: number;
    maxPerActionCents: number;
    committedCents: number;
    spentCents: number;
    /** What this grant permits, so the screen offers those and not the vocabulary. */
    allowedActions: string[];
  };
  myCash: {
    position: CashPosition;
    entries: {
      entry: {
        id: string;
        kind: string;
        amountCents: number;
        currency: string;
        occurredAt: string;
        note: string | null;
      };
      effect: string;
    }[];
    commitments: {
      id: string;
      amountCents: number;
      currency: string;
      purpose: string;
      state: string;
      stopCondition: string;
    }[];
  };
  myCurrentWork: {
    placements: Placement[];
    executeNow: Placement[];
    waiting: Placement[];
    /** How many pieces are at each tier. Optional for the same deploy reason. */
    byTier?: Record<'SIGNAL' | 'CANDIDATE' | 'QUALIFIED' | 'READY_TO_TEST', number>;
    /** The few worth putting in front of a person, in rank order. */
    best?: Placement[];
    /** True when `best` holds candidates rather than qualified openings. */
    bestAreNearlyQualified?: boolean;
    /**
     * The openings Brain is still qualifying, and the evidence it has not yet
     * found a payer for. Neither is work, and neither is waiting on a person.
     *
     * Optional for the ordinary deploy reason: a bundle built after these
     * existed may briefly hold a payload fetched before they did, and a
     * missing list has to read as *none of these* rather than throw.
     */
    beingQualified?: Placement[];
    evidence?: Placement[];
    /**
     * The conservative contribution of the pieces that are actually work —
     * and **null** when there are none.
     *
     * Null is a real answer here and the reader must render it as one. Zero
     * over an empty work list is a figure, and a figure reads as a
     * measurement; this used to total the gaps between other people's
     * published prices and present the result as what the sprint would earn.
     */
    combinedContributionCents: number | null;
    peakFundingCents: number;
    cards: Record<string, { ready: boolean; missing: string[]; summary: string }>;
    provenance: Record<string, CashCardFact[]>;
    /** The decision brief per piece: every answer, and what kind of answer it is. */
    engineCards: Record<string, EngineCardView>;
    /** The arithmetic, with its inputs named and its refusals stated. */
    economics: Record<string, DerivedFigureView[]>;
  };
  whatBrainHasDone: CashEvent[];
  whatBrainNeeds: (CashNeed & { researchStatus: string | null })[];
  /** Where the research is up to, counted from rows. Never mutated by reading it. */
  roadmap: CashRoadmap;
  /** What the evidence supports saying about money, and what it does not. */
  forecast: CashForecast;
  /**
   * The same shared frontier a member is sent, produced by the same server
   * function. The page's shared sections render from this for **both** roles,
   * so there is no shape for a client to reconcile and no way for the two
   * pages to disagree about one sprint.
   */
  frontier: Omit<SharedCashView, 'scope'>;
  /**
   * The whole possibility ledger with the figures on it.
   *
   * The frontier above carries the same space in names and counts, which is
   * what a member is sent. This is the owner's reading, and it is absent from a
   * member's payload rather than blanked in it — so there is no arrangement of
   * the page that could render a figure somebody may not read.
   *
   * Optional for the same deploy reason `byTier` is: an older server does not
   * send it, and the section renders what it has rather than crashing.
   */
  monetization?: MonetizationSurface;
  /**
   * What Brain is researching about that space, in the owner's own words.
   *
   * Optional for the reason `monetization` is: a rolling deploy serves an older
   * body to a newer bundle until the last instance turns over, and a section
   * that assumed the field would render nothing at all rather than rendering
   * what it has. The questions themselves are on `frontier.monetization`, which
   * both roles get — this carries only the recorded reason and the outcome
   * sentence, both of which quote the ledger.
   */
  monetizationWork?: CommissionView;
  decisionsForMe: { items: ReviewItem[]; underlyingCount: number; summary: string };
  vocabulary: {
    mechanisms: string[];
    moneyKinds: string[];
    commercialActions: string[];
    neverAuthorizable: string[];
    lifecycleStates: CashModeState[];
    envelopes: string[];
    defaultEnvelope: string;
    defaultHorizonDays: number;
    currencies: string[];
  };
}

export interface CashOperation {
  projectId: string;
  projectName: string | null;
  objective: string;
  state: CashModeState;
  currency: string;
  activatedAt: string;
}

export interface CashOperations {
  operations: CashOperation[];
  candidates: { projectId: string; projectName: string | null }[];
}

/** The single shared frontier, as the server reads it. */
export interface CashModeReading {
  root: { projectId: string; projectName: string | null } | null;
  mode: {
    projectId: string;
    state: CashModeState;
    currency: string;
    activatedAt: string | null;
    objective: string;
  } | null;
  /** Brain's own mandate: a short reading, and the text itself. */
  objective: { summary: string; full: string };
  currencies: string[];
}

export interface MemberSlotLink {
  id: string;
  userId: string;
  displayName: string;
  kind: 'ENROLLMENT' | 'RECOVERY';
  state: 'LIVE' | 'USED' | 'EXPIRED' | 'REVOKED';
  expiresAt: string;
}

export interface IssuedEnrollment {
  enrollmentId: string;
  userId: string;
  displayName: string;
  /** Shown once. The server does not store it and cannot show it again. */
  token: string;
  expiresAt: string;
}

const p = (value: string): string => encodeURIComponent(value);

export const CashApi = {
  /**
   * Which operations this person actually has.
   *
   * The section used to take whichever project the shell had selected, so
   * somebody with a broad Brain project and a private cash project could be
   * shown — and could activate — the wrong one. The operation is chosen rather
   * than inherited.
   */
  /**
   * The one Cash Mode, and what it is for.
   *
   * This replaced `operations`, which listed sprints a person chose between.
   * There is one shared frontier, so there is nothing to choose: the server
   * resolves where it lives and sends its own objective. Reading it creates
   * nothing.
   */
  mode: (): Promise<CashModeReading> => api('/api/cash/mode'),

  /*
   * Member slots and their links.
   *
   * On the cash client rather than a new one because this is where the count
   * they feed is read, and a second module for four calls is a second place for
   * the same shapes to drift.
   */
  members: (): Promise<{ readiness: CashReadiness; links: MemberSlotLink[] }> =>
    api('/api/members'),

  inviteMember: (displayName: string): Promise<{ enrollment: IssuedEnrollment }> =>
    api('/api/members', { method: 'POST', body: JSON.stringify({ displayName }) }),

  /**
   * Another first link for a slot nobody has filled.
   *
   * Not recovery: that retires what somebody is holding, which is right after
   * a lost device and wrong for a person who has never signed in. The server
   * refuses this for anybody who already has a way in.
   */
  relinkMember: (userId: string): Promise<{ enrollment: IssuedEnrollment }> =>
    api(`/api/members/${p(userId)}/link`, { method: 'POST' }),

  recoverMember: (userId: string, reason: string): Promise<{ enrollment: IssuedEnrollment }> =>
    api(`/api/members/${p(userId)}/recovery`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  /**
   * Correct somebody's name, which is what they type to sign in.
   *
   * A label and nothing else: no role, no membership, no credential and no
   * session moves with it. The server refuses a name somebody else already
   * signs in with, so this cannot move a collision rather than fixing one.
   */
  renameMember: (userId: string, displayName: string): Promise<{ user: { id: string } }> =>
    api(`/api/admin/users/${p(userId)}/display-name`, {
      method: 'POST',
      body: JSON.stringify({ displayName }),
    }),

  withdrawLink: (enrollmentId: string, reason: string): Promise<{ revoked: boolean }> =>
    api(`/api/members/enrollments/${p(enrollmentId)}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  /** One click. No project, no objective — see `services/cash/root.ts`. */
  start: (body: {
    constraints?: string;
    currency?: string;
  }): Promise<{ mode: CashMode; changed: boolean; message: string }> =>
    api('/api/cash/activate', { method: 'POST', body: JSON.stringify(body) }),

  view: (projectId: string): Promise<CashViewReading> =>
    api(`/api/projects/${p(projectId)}/cash`),

  /*
   * The possibility ledger's own two questions, and its four decisions.
   *
   * The ledger itself is **not** fetched here: it travels with the section, so
   * the page and the ranking cannot disagree about it. What these add is what a
   * payload cannot carry — a comparison somebody asks for, and the decisions
   * only a person makes.
   */
  whyRanked: (
    projectId: string,
    pathId: string,
    against?: string,
  ): Promise<{
    criteria: { id: string; label: string }[];
    comparison?: RankExplanation;
    toEnterTop?: {
      conditions: { criterion: string; label: string; now: string; needed: string; sentence: string }[];
      against: string | null;
      note: string | null;
    };
  }> =>
    api(
      `/api/projects/${p(projectId)}/cash/monetization/compare?a=${p(pathId)}` +
        (against ? `&b=${p(against)}` : ''),
    ),

  /**
   * Everything about one possibility, including what the list has no room for.
   *
   * The per-path route existed from the start and no client called it, which
   * made it the only reader of the rank history, of a snapshot's deciding
   * criterion, of a fact's basis and uncertainty, and of the judgement trail —
   * so all of those were written every tick and read by nobody. §22 requires
   * simplification to happen by presentation rather than by removing the
   * information; this is the presentation.
   */
  pathDetail: (
    pathId: string,
  ): Promise<{
    entry: { path: { id: string; title: string }; rank: number; statusBecause: string };
    history: {
      rank: number;
      previousRank: number | null;
      reason: string;
      status: string;
      criterion: string | null;
      evaluatedAt: string;
    }[];
    toEnterTop: {
      conditions: { criterion: string; label: string; now: string; needed: string; sentence: string }[];
      against: string | null;
      note: string | null;
    };
    provenance: {
      origin: string;
      sourceClaimId: string | null;
      splitFromId: string | null;
      mergedIntoId: string | null;
      lastEvaluatedAt: string | null;
    };
    facts: {
      attribute: string;
      kind: string;
      value: string;
      claimId: string | null;
      basis: string | null;
      assumptions: string | null;
      uncertainty: string | null;
      updatedAt: string;
    }[];
    judgments: {
      judgment: string;
      reason: string;
      /** Whose authority it carries. Never the same fact as the channel. */
      decidedById: string | null;
      channel: string;
      createdAt: string;
    }[];
    /** Relations somebody recorded, with whose statement each one is. */
    relations: {
      fromPathId: string;
      toPathId: string;
      kind: string;
      rationale: string;
      source: string;
      sourceClaimId: string | null;
      decidedById: string | null;
      createdAt: string;
    }[];
    questions: {
      id: string;
      attribute: string;
      round: number;
      state: string;
      reason: string;
      outcome: string | null;
      answered: number | null;
      openedAt: string;
    }[];
  }> => api(`/api/cash/monetization/paths/${p(pathId)}`),

  judgePath: (
    pathId: string,
    judgment: 'WATCH' | 'INVALIDATE' | 'ARCHIVE' | 'REVIVE',
    reason: string,
  ): Promise<{ message: string }> =>
    api(`/api/cash/monetization/paths/${p(pathId)}/judgment`, {
      method: 'POST',
      body: JSON.stringify({ judgment, reason }),
    }),

  seedPath: (
    projectId: string,
    body: { method: string; opportunityId?: string; industryNodeId?: string; thesis?: string },
  ): Promise<{ message: string }> =>
    api(`/api/projects/${p(projectId)}/cash/monetization/paths`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  activate: (
    projectId: string,
    body: { objective: string; horizonDays?: number; currency?: string },
  ): Promise<{ mode: CashMode; changed: boolean; message: string }> =>
    api(`/api/projects/${p(projectId)}/cash/mode`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  setLifecycle: (
    projectId: string,
    state: CashModeState,
    reason: string,
  ): Promise<{ mode: CashMode; changed: boolean; message: string }> =>
    api(`/api/projects/${p(projectId)}/cash/mode`, {
      method: 'POST',
      body: JSON.stringify({ state, reason }),
    }),

  /**
   * What a proposed grant would authorize, in the server's own words.
   *
   * Writes nothing: reading what a permission would mean must never be a way to
   * grant it. It exists so the terms can be shown *before* Approve rather than
   * folded away behind "Change details" under a prefilled number nobody chose.
   */
  previewAuthority: (
    projectId: string,
    body: {
      allowedActions: string[];
      maxCommittedCents: number;
      maxPerActionCents: number;
      maxConcurrent: number;
      expiresAt?: string | null;
    },
  ): Promise<{ lines: string[] }> =>
    api(`/api/projects/${p(projectId)}/cash/authority/preview`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  grantAuthority: (
    projectId: string,
    body: {
      allowedActions: string[];
      maxCommittedCents: number;
      maxPerActionCents: number;
      maxConcurrent: number;
      expiresAt?: string | null;
    },
  ): Promise<{ authority: { id: string }; lines: string[] }> =>
    api(`/api/projects/${p(projectId)}/cash/authority`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  withdrawAuthority: (
    projectId: string,
    authorityId: string,
    reason: string,
  ): Promise<{ withdrawn: boolean; message: string }> =>
    api(`/api/projects/${p(projectId)}/cash/authority/${p(authorityId)}/withdraw`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  capture: (
    projectId: string,
    body: { title: string; mechanism: string; source?: string; nextAction?: string },
  ): Promise<{ opportunity: CashOpportunity; message: string }> =>
    api(`/api/projects/${p(projectId)}/cash/opportunities`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  closeNeed: (
    needId: string,
    to: 'RESOLVED' | 'WITHDRAWN',
    resolution: string,
    /**
     * What is being done instead, when the condition genuinely does not hold.
     *
     * The server refuses a resolution whose completion condition fails and has
     * no substitute, because a written explanation is not a working
     * integration. Supplying one records `PERSON_SUBSTITUTE`, which is a
     * different fact and reads as one.
     */
    substitute?: string,
  ): Promise<{ need: { id: string; state: string }; message: string }> =>
    api(`/api/cash/needs/${p(needId)}/close`, {
      method: 'POST',
      body: JSON.stringify({ to, resolution, substitute }),
    }),

  /**
   * Answer one card field as a person.
   *
   * The same guarded route the card editor uses, so an answer given from the
   * decision list and one given on the card are one operation — a second way to
   * do it would be one forgotten guard away from doing less. The server records
   * it as a `PERSON` fact, which is what stops Brain proposing over it again.
   */
  fillCard: (
    opportunityId: string,
    patch: Record<string, unknown>,
  ): Promise<{ opportunity: CashOpportunity; message: string }> =>
    api(`/api/cash/opportunities/${p(opportunityId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  /** Record money that actually moved. Refused without a verifiable reference. */
  recordMoney: (
    projectId: string,
    body: {
      kind: string;
      amountCents: number;
      currency?: string;
      verifiedReference?: string;
      opportunityId?: string;
      note?: string;
      idempotencyKey: string;
    },
  ): Promise<{ entry: { id: string }; message: string }> =>
    api(`/api/projects/${p(projectId)}/cash/money`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Hold part of the ceiling for a named obstacle.
   *
   * Names the obstacle, the result to expect and where to stop, because a
   * commitment that named none of those would be a budget line rather than a
   * decision about this opening. The action is checked against the grant
   * server-side and is never echoed back on the commitment row.
   */
  commitSpend: (
    projectId: string,
    body: {
      action: string;
      amountCents: number;
      purpose: string;
      expectedResult: string;
      stopCondition: string;
      idempotencyKey: string;
      opportunityId?: string;
    },
  ): Promise<{ commitment: { id: string; state: string }; message: string }> =>
    api(`/api/projects/${p(projectId)}/cash/commitments`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Release a commitment that is not going to be spent. */
  releaseCommitment: (
    commitmentId: string,
    reason: string,
  ): Promise<{ released: boolean; message: string }> =>
    api(`/api/cash/commitments/${p(commitmentId)}/release`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  /**
   * The spend happened: the hold becomes history and what it actually cost is
   * recorded. Never released by a clock — this is somebody saying what the
   * money bought.
   */
  settleCommitment: (
    commitmentId: string,
    spentCents: number,
    note?: string,
  ): Promise<{ commitment: { id: string; state: string }; settled: boolean; message: string }> =>
    api(`/api/cash/commitments/${p(commitmentId)}/settle`, {
      method: 'POST',
      body: JSON.stringify({ spentCents, note }),
    }),

  act: (
    opportunityId: string,
    action: string,
    body: Record<string, unknown> = {},
  ): Promise<{ opportunity: CashOpportunity; message: string }> =>
    api(`/api/cash/opportunities/${p(opportunityId)}/${p(action)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

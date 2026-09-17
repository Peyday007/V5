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

export type { CashReadiness, CashRoadmap, CashForecast };

export type CashModeState = 'ACTIVE' | 'WINDING_DOWN' | 'ARCHIVED';

export type CashDisposition =
  | 'EXECUTE_NOW'
  | 'RUN_IN_PARALLEL'
  | 'WAIT_FOR_DEPENDENCY'
  | 'TEST_A_DECISIVE_UNKNOWN'
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
  | 'RESOLVE_NEED'
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
    combinedContributionCents: number;
    peakFundingCents: number;
    cards: Record<string, { ready: boolean; missing: string[]; summary: string }>;
    provenance: Record<string, CashCardFact[]>;
  };
  whatBrainHasDone: CashEvent[];
  whatBrainNeeds: CashNeed[];
  /** Where the research is up to, counted from rows. Never mutated by reading it. */
  roadmap: CashRoadmap;
  /** What the evidence supports saying about money, and what it does not. */
  forecast: CashForecast;
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
  /** Whether anybody can get in, and whether anything can run. Derived. */
  readiness: CashReadiness;
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

  recoverMember: (userId: string, reason: string): Promise<{ enrollment: IssuedEnrollment }> =>
    api(`/api/members/${p(userId)}/recovery`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
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

  view: (projectId: string): Promise<CashView> => api(`/api/projects/${p(projectId)}/cash`),

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

  /** Release a commitment that is not going to be spent. */
  releaseCommitment: (
    commitmentId: string,
    reason: string,
  ): Promise<{ released: boolean; message: string }> =>
    api(`/api/cash/commitments/${p(commitmentId)}/release`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
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

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

export interface ReviewItem {
  key: string;
  title: string;
  why: string;
  recommendation: string;
  consequence: string;
  urgency: 'URGENT' | 'BLOCKING' | 'WHENEVER';
  underlying: string[];
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
  };
  whatBrainHasDone: CashEvent[];
  whatBrainNeeds: CashNeed[];
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
  };
}

const p = (value: string): string => encodeURIComponent(value);

export const CashApi = {
  view: (projectId: string): Promise<CashView> => api(`/api/projects/${p(projectId)}/cash`),

  activate: (
    projectId: string,
    body: { objective: string; horizonDays?: number },
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

  grantAuthority: (
    projectId: string,
    body: {
      allowedActions: string[];
      maxCommittedCents: number;
      maxPerActionCents: number;
      maxConcurrent?: number;
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

/**
 * The cross-border dealflow kernel over HTTP.
 *
 * Thin by design, following `cashApi.ts`: every decision is the server's, and
 * this file's whole job is to name the routes and the shapes. Every response
 * type is imported type-only from the server so the two halves of the app
 * cannot drift, and nothing from the server is bundled.
 */
import { api } from './api.ts';
import type { DealflowView } from '../../../server/services/dealflow/view.ts';
import type { dealDetail } from '../../../server/services/dealflow/view.ts';
import type { DealflowAccess } from '../../../server/services/dealflow/access.ts';
import type { DealParty, DealPartyKind } from '../../../server/domain/types.ts';
import type { DealObservation, DealObservationKind } from '../../../server/domain/types.ts';

export type { DealPartyKind, DealObservationKind };

export type DealflowViewReading = DealflowView & DealflowAccess;

export type DealDetailReading = Awaited<ReturnType<typeof dealDetail>>;

const p = (value: string): string => encodeURIComponent(value);

export const DealflowApi = {
  view: (projectId: string): Promise<DealflowViewReading> =>
    api(`/api/projects/${p(projectId)}/cash/dealflow`),

  dealDetail: (projectId: string, dealId: string): Promise<DealDetailReading> =>
    api(`/api/projects/${p(projectId)}/cash/dealflow/${p(dealId)}`),

  seedParty: (
    projectId: string,
    body: {
      kind: DealPartyKind;
      name: string;
      equipmentClass: string;
      country?: string;
      note?: string;
    },
  ): Promise<{ party: DealParty; created: boolean; message: string }> =>
    api(`/api/projects/${p(projectId)}/cash/dealflow/parties`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  retireParty: (
    projectId: string,
    partyId: string,
    reason: string,
  ): Promise<{ party: DealParty; message: string }> =>
    api(`/api/projects/${p(projectId)}/cash/dealflow/parties/${p(partyId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ reason }),
    }),

  recordObservation: (
    projectId: string,
    body: {
      kind: DealObservationKind;
      statement: string;
      dealId?: string;
      jurisdiction?: string;
      equipmentClass?: string;
    },
  ): Promise<{ observation: DealObservation; message: string }> =>
    api(`/api/projects/${p(projectId)}/cash/dealflow/observations`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

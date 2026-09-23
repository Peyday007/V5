/**
 * The commercial journey's routes, typed against the server's own shapes.
 *
 * Types are imported from the server rather than restated, because a client
 * type that restates a response is how a field the server sends goes unread —
 * the defect `factoryHttp.test.ts` exists to catch one module along.
 */
import { api } from './api.ts';
import type { CommercialBriefing } from '../../../server/services/cash/commerce/briefing.ts';
import type {
  CashDemandTest,
  CashInvoice,
  CashObligation,
  CashResponse,
  DemandVerdict,
} from '../../../server/domain/commerce.ts';
import type { TestTally } from '../../../server/services/cash/commerce/demand.ts';

export type { CommercialBriefing, CashInvoice, CashObligation };

export interface CommercialTest extends CashDemandTest {
  counts: TestTally;
  responses: CashResponse[];
  pendingVerdict: { verdict: DemandVerdict; reason: string } | null;
}

export interface CommercialReading {
  briefing: CommercialBriefing;
  tests: CommercialTest[];
  obligations: CashObligation[];
  invoices: CashInvoice[];
}

const e = encodeURIComponent;
const post = <T>(path: string, body: unknown): Promise<T> =>
  api(path, { method: 'POST', body: JSON.stringify(body) });

export const CommerceApi = {
  read: (projectId: string): Promise<CommercialReading> => api(`/api/projects/${e(projectId)}/cash/commercial`),
  contact: (testId: string, body: { recipient: string; reference: string }) =>
    post<{ message: string }>(`/api/cash/demand-tests/${e(testId)}/contact`, body),
  respond: (
    projectId: string,
    body: {
      opportunityId: string;
      testId?: string;
      respondent: string;
      kind: string;
      channel: string;
      reference: string;
      excerpt: string;
    },
  ) => post<{ message: string }>(`/api/projects/${e(projectId)}/cash/responses`, body),
  obligation: (obligationId: string, action: string, body: Record<string, unknown>) =>
    post<{ message: string }>(`/api/cash/obligations/${e(obligationId)}/${e(action)}`, body),
  invoiceState: (invoiceId: string, body: Record<string, unknown>) =>
    post<{ message: string }>(`/api/cash/invoices/${e(invoiceId)}/state`, body),
};

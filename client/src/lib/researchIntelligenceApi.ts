/**
 * Research Intelligence's reader, over HTTP.
 *
 * Thin by design, like `registerApi` and `cashApi`: every sentence and every
 * disposition in this payload is the server's, and this file's whole job is to
 * name the one route and import the shape. `ResearchIntelligenceView` and
 * `QuestionView` are the server's own types, re-exported type-only rather than
 * restated — a client holding its own copy of the contract is a second
 * contract, and the copy is the one that drifts.
 */
import { api } from './api.ts';
import type {
  QuestionView,
  ResearchIntelligenceView,
} from '../../../server/services/research/intelligence/view.ts';

export type { QuestionView, ResearchIntelligenceView };

/** What Brain currently believes it was asked, and where the answer stands. */
export function getResearchIntelligence(orchestrationId: string): Promise<ResearchIntelligenceView> {
  return api<ResearchIntelligenceView>(
    `/api/research/${encodeURIComponent(orchestrationId)}/intelligence`,
  );
}

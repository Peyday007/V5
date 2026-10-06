/**
 * Research goals, over HTTP.
 *
 * Read-only and thin: every sentence, count and state is the server's, and the
 * shape is imported from the server rather than restated, because a client
 * holding its own copy of a contract is a second contract. Type-only, so
 * nothing of the server reaches the bundle. There is deliberately no function
 * here that raises a ceiling: the server's sentence says that is a person's
 * decision, and the way to act on it is a new goal — `open`.
 */
import { api } from './api.ts';
import type { GoalBudgetView, StoppingCeiling } from '../../../server/services/research/goalBudgetView.ts';
import type {
  GoalReading,
  PacketKind,
  PacketReading,
  ResearchOverview,
} from '../../../server/services/research/overview.ts';

export type { GoalBudgetView, GoalReading, PacketKind, PacketReading, ResearchOverview, StoppingCeiling };

export const ResearchGoalsApi = {
  /**
   * Open a research goal. The only way a ceiling is raised: a new goal a person
   * decides on, never an edit to the old one. Project ADMIN only; the server
   * refuses anybody else with the same 404 a missing project gives.
   */
  open: (
    projectId: string,
    body: {
      name: string;
      maxPackets: number;
      maxFragments: number;
      deadline: string;
      assignment?: string;
      layerId?: string;
    },
  ): Promise<{ goal: GoalBudgetView }> =>
    api(`/api/projects/${encodeURIComponent(projectId)}/research-goals`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  overview: (projectId: string): Promise<{ overview: ResearchOverview }> =>
    api(`/api/projects/${encodeURIComponent(projectId)}/research/overview`),
  list: (projectId: string): Promise<{ goals: GoalBudgetView[] }> =>
    api(`/api/projects/${encodeURIComponent(projectId)}/research-goals`),
};

/**
 * The world, over HTTP (UI-27-2).
 *
 * One read: `GET /api/projects/:projectId/world`, the typed, versioned
 * presentation adapter the server composes from repositories other routes
 * already serve. The shape is imported from the server rather than restated,
 * type-only, so nothing of the server reaches the bundle and the client cannot
 * hold a second copy of the contract. There is no write here: an action on a
 * record goes through that record's own authorized route.
 */
import { api } from './api.ts';
import type { World } from '../../../server/routes/world.ts';

export type { World };

/** The contract version this client reads. A response at another version is refused rather than misread. */
export const WORLD_CONTRACT_READ = 1 as const;

export class WorldVersionError extends Error {
  constructor(readonly served: unknown) {
    super(`The world was served at contract version ${String(served)}; this page reads version ${WORLD_CONTRACT_READ}.`);
  }
}

export const WorldApi = {
  async world(projectId: string): Promise<World> {
    const world = await api<World>(`/api/projects/${encodeURIComponent(projectId)}/world`);
    if (world.version !== WORLD_CONTRACT_READ) throw new WorldVersionError(world.version);
    return world;
  },
};

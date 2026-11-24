'use client';
import { useBrain } from './use-brain';
import type { ProjectHomes } from './use-session';

/** The project Brain's cash work lives in, among those this person may read. */
export function useHomeProject() {
  const homes = useBrain<ProjectHomes>('/api/projects/homes', { interval: false });
  const projectId = homes.data ? (homes.data.cash ?? homes.data.fallback) : null;
  return { homes, projectId };
}

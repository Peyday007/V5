/**
 * Project seeding (section 20).
 *
 * Seeds one project — Deal Dispatch — with its eight layers in the exact
 * order given. It deliberately does NOT invent document state: layers start
 * empty and NOT_STARTED, and real state arrives by importing the existing PDFs.
 */
import { DEFAULT_VERSION_POLICY, type Layer, type Project } from './domain/types.ts';
import { createLayer, listLayers } from './repos/layers.ts';
import { createProject, getProjectBySlug, listProjects } from './repos/projects.ts';
import { recordEvent } from './repos/events.ts';
import { ensureProjectTree } from './services/storage.ts';
import { getDb } from './db/database.ts';

export const DEAL_DISPATCH_SLUG = 'deal-dispatch';

/** The eight Deal Dispatch layers, in the exact order specified. */
export const DEAL_DISPATCH_LAYERS = [
  'World Model',
  'Taxonomy',
  'Monetization Logic',
  'Discovery Logic',
  'Qualification Logic',
  'Execution Playbooks',
  'Decision Routing Rules',
  'Learning Evaluation',
] as const;

export interface SeedResult {
  created: boolean;
  project: Project;
  layers: Layer[];
}

/**
 * Idempotent. Runs on every boot: creates the project the first time, and
 * afterwards only backfills layers that are missing and re-creates the
 * filesystem tree (so a deleted folder reappears rather than breaking import).
 */
export function seedDealDispatch(): SeedResult {
  const db = getDb();
  return db.transaction(() => {
    const existing = getProjectBySlug(DEAL_DISPATCH_SLUG);
    const project =
      existing ??
      createProject({
        name: 'Deal Dispatch',
        slug: DEAL_DISPATCH_SLUG,
        description:
          'Multi-layer research programme. Each layer is expanded across sibling research ' +
          'runs, audited, synthesised into a canonical document, and then frozen.',
        northStar:
          'A complete, audited, internally consistent model of Deal Dispatch — every layer ' +
          'frozen at a canonical version with its research provenance intact.',
        currentWave: 1,
        versionPolicy: DEFAULT_VERSION_POLICY,
        settings: { maxAutoRedos: DEFAULT_VERSION_POLICY.maxAutoRedos },
      });

    if (!existing) {
      recordEvent({
        projectId: project.id,
        entityType: 'PROJECT',
        entityId: project.id,
        eventType: 'PROJECT_CREATED',
        payload: { name: project.name, seeded: true },
      });
    }

    const present = new Map(listLayers(project.id).map((l) => [l.name, l]));
    const layers: Layer[] = [];
    DEAL_DISPATCH_LAYERS.forEach((name, index) => {
      const found = present.get(name);
      layers.push(
        found ??
          createLayer({
            projectId: project.id,
            name,
            orderIndex: index,
            // No document state is invented; expectations are set by the user
            // or derived after importing existing research.
            expectedVersions: [],
            currentWave: 1,
          }),
      );
    });

    ensureProjectTree(project.slug, layers.map((l) => l.slug));

    return { created: !existing, project, layers };
  });
}

/** Boot hook: seed only when the database has no projects at all. */
export function seedIfEmpty(): SeedResult | null {
  if (listProjects().length > 0) {
    // Still make sure the filesystem tree exists for every known project.
    for (const project of listProjects()) {
      ensureProjectTree(project.slug, listLayers(project.id).map((l) => l.slug));
    }
    return null;
  }
  return seedDealDispatch();
}

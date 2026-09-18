/**
 * How a capability blueprint enters Brain.
 *
 * ---------------------------------------------------------------------------
 * Through the real path, and nowhere near a seed
 * ---------------------------------------------------------------------------
 *
 * A markdown file describing what Brain should be able to do is a research
 * artifact like any other, so §4 applies to it unchanged: it is not a document
 * until it has a row, a canonical name, a stored object and a hash. It goes
 * through `importProjectSource`, which is the same function the master
 * transcript goes through, and then through the extraction queue, which is the
 * same queue every other document's text comes out of.
 *
 * Nothing here writes a faculty. What this module produces is a *readable*
 * source: bytes in the store, a document row, an extraction run with blocks a
 * quote can be anchored in, and a `capability_sources` row saying this document
 * is a blueprint. Everything after that is `extraction.ts`.
 *
 * ---------------------------------------------------------------------------
 * The amendment is a source, not an edit
 * ---------------------------------------------------------------------------
 *
 * The clarification to Faculty 14 could have been applied by rewriting the
 * blueprint. It is not, and the reason is §5: the original keeps its bytes and
 * its hash, the amendment is its own registered document pointing at it with
 * `amends_id`, and a promoted definition records which of the two it read. A
 * source silently rewritten is a provenance chain that resolves to something
 * that was never actually written.
 *
 * ---------------------------------------------------------------------------
 * Where it lives
 * ---------------------------------------------------------------------------
 *
 * Knowledge about Brain is not knowledge about somebody's project, so the
 * registry it feeds is deliberately not project-scoped — the same boundary §31
 * draws for a shared finding. But the *bytes* need a project, because every
 * storage key in this codebase is confined under one (§18), and that
 * confinement is worth more than the tidiness of an unscoped object.
 *
 * So there is one `TECHNICAL`-purpose scope for Brain's own architecture,
 * created the way `queue-scope` and `verification-scope` already are: machinery
 * proving itself, declared rather than counted as somebody's work.
 */
import { hashBuffer } from '../storage.ts';
import { importProjectSource } from '../importer.ts';
import { enqueueExtraction } from '../documents/queue.ts';
import { getCurrentExtractionRun } from '../../repos/extraction.ts';
import { getDocument } from '../../repos/documents.ts';
import { createProject, getProjectBySlug } from '../../repos/projects.ts';
import { createLayer, listLayers } from '../../repos/layers.ts';
import { registerSource, type CapabilitySource, type SourceKind } from '../../repos/faculties.ts';
import { recordEvent } from '../../repos/events.ts';
import type { Project } from '../../domain/types.ts';

/**
 * The scope Brain's own architectural sources live in.
 *
 * `TECHNICAL`, so `projects.purpose` keeps it out of every reading that asks
 * how much of somebody's work is in flight — migration 028's whole point.
 */
export const ARCHITECTURE_SLUG = 'brain-architecture';

/**
 * The layer realization work files under.
 *
 * One, and it is not what the blueprint is filed under: the blueprint is a
 * project source with `layer_id = NULL` (§11), because forcing architectural
 * knowledge into one heading would file most of it under the wrong one. Those
 * are two different facts and I conflated them at first — this scope was
 * created with no layer at all on the strength of the document's own
 * layer-lessness, and running it found the consequence immediately.
 *
 * §30 records the same defect one section along: `standingAuthority` refuses a
 * launch on a project with no layer to file the work under, so a scope without
 * one can open discovery, capture ideas and **launch nothing, for ever**, with
 * every row reading healthy. The remedy there was that activation creates the
 * layer, because that is the moment the project becomes an operation. Here it
 * is the moment the scope is created, for the same reason.
 */
export const ARCHITECTURE_LAYER = 'Capability Realization';

/**
 * Make sure the architecture scope exists, once.
 *
 * Idempotent by slug rather than by a flag, so a restart, a second instance and
 * a re-run all produce one project and one layer.
 */
export async function ensureArchitectureScope(): Promise<Project> {
  const existing = await getProjectBySlug(ARCHITECTURE_SLUG);
  if (existing) {
    await ensureArchitectureLayer(existing.id);
    return existing;
  }
  try {
    const created = await createProject({
      name: 'Brain Architecture',
      slug: ARCHITECTURE_SLUG,
      description:
        "Where Brain's own capability blueprints and their amendments are registered. This is " +
        'machinery describing itself rather than somebody\'s work, which is what `purpose` says.',
      purpose: 'TECHNICAL',
    });
    await ensureArchitectureLayer(created.id);
    return created;
  } catch {
    // Two callers raced. The slug is unique, so the loser reads the winner's
    // row — an ordinary outcome, the same shape as losing any other claim here.
    const raced = await getProjectBySlug(ARCHITECTURE_SLUG);
    if (raced) {
      await ensureArchitectureLayer(raced.id);
      return raced;
    }
    throw new Error('The architecture scope could not be created or read back.');
  }
}

/** Idempotent by name, so a re-run finds the layer rather than adding a second. */
async function ensureArchitectureLayer(projectId: string): Promise<void> {
  const layers = await listLayers(projectId);
  if (layers.some((layer) => layer.name === ARCHITECTURE_LAYER)) return;
  await createLayer({
    projectId,
    name: ARCHITECTURE_LAYER,
    orderIndex: 1,
    notes:
      'Where work on Brain’s own capabilities files. The blueprints themselves are project ' +
      'sources with no layer; this is for what realizing one produces.',
  });
}

export interface RegisteredBlueprint {
  source: CapabilitySource;
  documentId: string;
  extractionRunId: string | null;
  extractionStatus: string | null;
  /** False when these exact bytes were already registered. */
  created: boolean;
  problems: string[];
}

/**
 * Register a blueprint or an amendment, and read it.
 *
 * "Read it" is not decoration. §9 is explicit that a file on disk is not
 * something Brain has read, and every canonical statement this kernel later
 * makes has to resolve to a passage — so a source whose extraction did not
 * reach a usable state is registered and **reported as unreadable** rather than
 * passed on as an empty document.
 */
export async function registerBlueprint(input: {
  filename: string;
  contents: Buffer;
  title: string;
  kind: SourceKind;
  amendsId?: string | null;
  origin: string;
  registeredBy: string;
  projectId?: string;
}): Promise<RegisteredBlueprint> {
  const problems: string[] = [];
  const project =
    input.projectId !== undefined
      ? await requireProject(input.projectId)
      : await ensureArchitectureScope();

  if (input.kind === 'AMENDMENT' && !input.amendsId) {
    throw new Error(
      'An amendment must name the source it amends. An amendment with no lineage is a second ' +
        'blueprint wearing the word, and nothing downstream could tell which one it read.',
    );
  }

  const imported = await importProjectSource({
    projectId: project.id,
    originalFilename: input.filename,
    contents: input.contents,
    scope: 'PROJECT_SOURCE',
    notes: `Capability ${input.kind.toLowerCase()} registered from ${input.origin}.`,
  });
  if (!imported.documentId) {
    throw new Error(`The source could not be registered: ${imported.message}`);
  }

  // Reading it is the next step rather than an afterthought. Through the queue,
  // because two extractions of one document racing leaves both runs superseded
  // by the other — a document with no current reading at all.
  await enqueueExtraction(imported.documentId, { force: false });
  const run = await getCurrentExtractionRun(imported.documentId);
  if (!run) {
    problems.push('The source produced no extraction run, so nothing can be anchored in it.');
  } else if (run.status !== 'READY' && run.status !== 'READY_WITH_WARNINGS') {
    problems.push(
      `The source's extraction is ${run.status}, so it is not evidence: ` +
        `${run.blockedReason ?? 'no reason was recorded'}.`,
    );
  }

  const document = await getDocument(imported.documentId);
  const { source, created } = await registerSource({
    kind: input.kind,
    title: input.title,
    documentId: imported.documentId,
    projectId: project.id,
    amendsId: input.amendsId ?? null,
    contentHash: document?.fileHash ?? hashBuffer(input.contents),
    byteSize: document?.fileSize ?? input.contents.byteLength,
    origin: input.origin,
    registeredBy: input.registeredBy,
  });

  if (created) {
    await recordEvent({
      projectId: project.id,
      layerId: null,
      entityType: 'DOCUMENT',
      entityId: imported.documentId,
      eventType: 'CAPABILITY_SOURCE_REGISTERED',
      payload: {
        sourceId: source.id,
        kind: source.kind,
        version: source.version,
        amendsId: source.amendsId,
        contentHash: source.contentHash,
        extractionRunId: run?.id ?? null,
        extractionStatus: run?.status ?? null,
      },
    });
  }

  return {
    source,
    documentId: imported.documentId,
    extractionRunId: run?.id ?? null,
    extractionStatus: run?.status ?? null,
    created,
    problems,
  };
}

async function requireProject(projectId: string): Promise<Project> {
  const { getProject } = await import('../../repos/projects.ts');
  const project = await getProject(projectId);
  if (!project) throw new Error(`No such project: ${projectId}`);
  return project;
}

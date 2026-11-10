/**
 * Historical memory, over HTTP.
 *
 * Every route resolves the person from the authenticated principal and acts
 * only on rows that person owns; there is no parameter naming whose history to
 * read, and an id that is not theirs is answered exactly as one that does not
 * exist (invariants 21, 23, 30). A worker principal is refused by type: this is
 * a person's private history, not work.
 *
 * Import routes accept the browser session and the person's own bridge
 * credential (`brnc_`), so the terminal importer can stream an export too.
 */
import { Router } from 'express';
import {
  badRequest,
  bodyOf,
  handler,
  notFound,
  optionalString,
  pathId,
  requiredEnum,
  requiredString,
  requirePerson,
} from './helpers.ts';
import { getStorage } from '../services/storage/index.ts';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_BATCH_CONVERSATIONS,
  MemoryNotFound,
  completeArchive,
  getArchive,
  ingestConversations,
  listArchives,
  openArchive,
  storeAttachment,
  type ArchiveSourceFormat,
  type RawConversation,
} from '../services/memory/ingest.ts';
import type { ManifestEntry } from '../services/memory/parse.ts';
import { coverageReport } from '../services/memory/coverage.ts';
import {
  attachmentObject,
  conversationRecord,
  ideaDetail,
  listDiscoveries,
  listHubs,
  listIdeas,
  searchMemory,
  topicHistory,
  topicTree,
} from '../services/memory/views.ts';
import { DECISIONS, DecisionRefused, decide, recordCircumstance, type MemoryDecision } from '../services/memory/rediscover.ts';
import { addPractice, decideHub, movieSchoolFoundation, readCommitments } from '../services/memory/hubs.ts';
import { runMemoryPass } from '../services/memory/pipeline.ts';
import { getDb } from '../db/database.ts';

export const memoryRouter: Router = Router();

const FORMATS: readonly ArchiveSourceFormat[] = ['CHATGPT_OFFICIAL', 'CHATGPT_EXPORTER', 'CHATGPT_MARKDOWN', 'MIXED'];

async function owned<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof MemoryNotFound) throw notFound('Not found.');
    if (error instanceof DecisionRefused) {
      if (/^No such/.test(error.message)) throw notFound('Not found.');
      throw badRequest(error.message);
    }
    throw error;
  }
}

function manifestOf(value: unknown): ManifestEntry[] {
  if (!Array.isArray(value)) throw badRequest('"entries" must be an array.');
  if (value.length > 50_000) throw badRequest('An archive may declare at most 50,000 conversations.');
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw badRequest(`"entries[${index}]" must be an object.`);
    const e = raw as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    return {
      externalId: requiredString(e.externalId, `entries[${index}].externalId`).slice(0, 300),
      title: typeof e.title === 'string' ? e.title : 'Untitled conversation',
      contentHash: requiredString(e.contentHash, `entries[${index}].contentHash`).slice(0, 100),
      nodes: n(e.nodes),
      messages: n(e.messages),
      attachments: n(e.attachments),
      updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : null,
    };
  });
}

memoryRouter.get(
  '/memory/overview',
  handler(async () => {
    const person = requirePerson();
    const coverage = await coverageReport(person.id);
    return {
      coverage,
      archives: await listArchives(person.id),
      discoveries: (await listDiscoveries(person.id, 'OPEN')).length,
    };
  }),
);

memoryRouter.get(
  '/memory/coverage',
  handler(async () => ({ coverage: await coverageReport(requirePerson().id) })),
);

memoryRouter.get(
  '/memory/archives',
  handler(async () => ({ archives: await listArchives(requirePerson().id) })),
);

memoryRouter.post(
  '/memory/archives',
  handler(async (req) => {
    const person = requirePerson();
    const body = bodyOf(req);
    const notes = Array.isArray(body.notes) ? body.notes.filter((n): n is string => typeof n === 'string').map((n) => n.slice(0, 500)) : [];
    return openArchive({
      ownerId: person.id,
      label: optionalString(body.label, 'label') ?? 'ChatGPT export',
      sourceFormat: requiredEnum<ArchiveSourceFormat>(body.sourceFormat, FORMATS, 'sourceFormat'),
      entries: manifestOf(body.entries),
      declaredFiles: typeof body.declaredFiles === 'number' ? Math.max(0, Math.floor(body.declaredFiles)) : 0,
      notes,
    });
  }),
);

memoryRouter.get(
  '/memory/archives/:archiveId',
  handler(async (req) => owned(async () => ({ archive: await getArchive(requirePerson().id, pathId(req, 'archiveId')) }))),
);

memoryRouter.post(
  '/memory/archives/:archiveId/conversations',
  handler(async (req) => {
    const person = requirePerson();
    const body = bodyOf(req);
    if (!Array.isArray(body.conversations)) throw badRequest('"conversations" must be an array.');
    if (body.conversations.length > MAX_BATCH_CONVERSATIONS) {
      throw badRequest(`Send at most ${MAX_BATCH_CONVERSATIONS} conversations per batch.`);
    }
    const conversations: RawConversation[] = body.conversations.map((entry, index) => {
      if (!entry || typeof entry !== 'object') throw badRequest(`"conversations[${index}]" must be an object.`);
      const e = entry as Record<string, unknown>;
      if (e.kind === 'MARKDOWN') {
        return { kind: 'MARKDOWN', name: requiredString(e.name, `conversations[${index}].name`), text: requiredString(e.text, `conversations[${index}].text`) };
      }
      return {
        kind: 'JSON',
        value: e.value,
        format: e.format === 'CHATGPT_OFFICIAL' ? 'CHATGPT_OFFICIAL' : 'CHATGPT_EXPORTER',
      };
    });
    const projectNames: Record<string, string> = {};
    if (body.projectNames && typeof body.projectNames === 'object') {
      for (const [k, v] of Object.entries(body.projectNames as Record<string, unknown>)) {
        if (typeof v === 'string') projectNames[k.slice(0, 200)] = v.slice(0, 300);
      }
    }
    return owned(async () => ({
      results: await ingestConversations({ ownerId: person.id, archiveId: pathId(req, 'archiveId'), conversations, projectNames }),
    }));
  }),
);

memoryRouter.post(
  '/memory/archives/:archiveId/complete',
  handler(async (req) => owned(async () => ({ archive: await completeArchive(requirePerson().id, pathId(req, 'archiveId')) }))),
);

memoryRouter.post(
  '/memory/attachments',
  handler(async (req) => {
    const person = requirePerson();
    const body = bodyOf(req);
    const sourceRef = requiredString(body.sourceRef, 'sourceRef').slice(0, 300);
    const fileName = requiredString(body.fileName, 'fileName');
    const mimeType = optionalString(body.mimeType, 'mimeType') ?? null;
    if (typeof body.base64 !== 'string') {
      // Declared too large to send: recorded as a named gap rather than skipped.
      const size = typeof body.size === 'number' ? body.size : MAX_ATTACHMENT_BYTES + 1;
      return storeAttachment({ ownerId: person.id, sourceRef, fileName, mimeType, bytes: Buffer.alloc(Math.min(size, MAX_ATTACHMENT_BYTES + 1)) });
    }
    const bytes = Buffer.from(body.base64, 'base64');
    return storeAttachment({ ownerId: person.id, sourceRef, fileName, mimeType, bytes });
  }),
);

memoryRouter.get(
  '/memory/attachments/:attachmentId',
  handler(async (req, res) => {
    const person = requirePerson();
    const object = await owned(() => attachmentObject(person.id, pathId(req, 'attachmentId')));
    const bytes = await getStorage().get(object.key);
    res.setHeader('Content-Type', object.mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${object.name.replace(/[^\w.\- ]/g, '_')}"`);
    res.end(bytes);
    return undefined;
  }),
);

memoryRouter.get(
  '/memory/discoveries',
  handler(async (req) => {
    const state = req.query.state === 'DECIDED' ? 'DECIDED' : 'OPEN';
    return { discoveries: await listDiscoveries(requirePerson().id, state) };
  }),
);

memoryRouter.post(
  '/memory/ideas/:ideaId/decide',
  handler(async (req) => {
    const person = requirePerson();
    const body = bodyOf(req);
    return owned(async () => ({
      result: await decide({
        ownerId: person.id,
        ideaId: pathId(req, 'ideaId'),
        decision: requiredEnum<MemoryDecision>(body.decision, DECISIONS, 'decision'),
        feedback: optionalString(body.feedback, 'feedback') ?? null,
        projectId: optionalString(body.projectId, 'projectId') ?? null,
        wantedNow: optionalString(body.wantedNow, 'wantedNow') ?? null,
        branch: body.branch === true,
      }),
    }));
  }),
);

memoryRouter.get(
  '/memory/ideas',
  handler(async (req) => {
    const q = (k: string): string | undefined => (typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined);
    return { ideas: await listIdeas(requirePerson().id, { state: q('state'), kind: q('kind'), q: q('q') }) };
  }),
);

memoryRouter.get(
  '/memory/ideas/:ideaId',
  handler(async (req) => owned(async () => ideaDetail(requirePerson().id, pathId(req, 'ideaId')))),
);

memoryRouter.get(
  '/memory/conversations',
  handler(async (req) => {
    const person = requirePerson();
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    const rows = await getDb().all<{ id: string; title: string; source: string; first_said_at: string | null; last_said_at: string | null; message_count: number; branch_point_count: number; project_name: string | null }>(
      `SELECT id, title, source, first_said_at, last_said_at, message_count, branch_point_count, project_name
         FROM memory_conversations WHERE owner_user_id = ? ORDER BY last_said_at DESC LIMIT 100 OFFSET ?`,
      [person.id, offset],
    );
    return { conversations: rows };
  }),
);

memoryRouter.get(
  '/memory/conversations/:conversationId',
  handler(async (req) =>
    owned(async () => conversationRecord(requirePerson().id, pathId(req, 'conversationId'), req.query.branches === '1')),
  ),
);

memoryRouter.get(
  '/memory/topics',
  handler(async () => ({ topics: await topicTree(requirePerson().id) })),
);

memoryRouter.get(
  '/memory/topics/:topicId',
  handler(async (req) =>
    owned(async () => topicHistory(requirePerson().id, pathId(req, 'topicId'), req.query.role === 'ALL' ? 'ALL' : 'USER')),
  ),
);

memoryRouter.get(
  '/memory/search',
  handler(async (req) => {
    const person = requirePerson();
    const s = (k: string): string | null => (typeof req.query[k] === 'string' && req.query[k] ? (req.query[k] as string) : null);
    const role = s('role');
    return searchMemory(person.id, {
      q: s('q') ?? '',
      from: s('from'),
      to: s('to'),
      role: role === 'USER' || role === 'ASSISTANT' ? role : null,
      order: s('order') === 'OLDEST' ? 'OLDEST' : 'NEWEST',
    });
  }),
);

memoryRouter.get(
  '/memory/hubs',
  handler(async () => ({ hubs: await listHubs(requirePerson().id) })),
);

memoryRouter.post(
  '/memory/hubs/:hubId/decide',
  handler(async (req) => {
    const person = requirePerson();
    const decision = requiredEnum<'ACCEPT' | 'DECLINE'>(bodyOf(req).decision, ['ACCEPT', 'DECLINE'], 'decision');
    try {
      return await decideHub({ ownerId: person.id, hubId: pathId(req, 'hubId'), decision });
    } catch (error) {
      if (error instanceof Error && error.message === 'No such hub.') throw notFound('Not found.');
      throw error;
    }
  }),
);

memoryRouter.get(
  '/memory/commitments',
  handler(async () => ({ commitments: await readCommitments(requirePerson().id) })),
);

memoryRouter.get(
  '/memory/movie-school',
  handler(async () => ({ foundation: await movieSchoolFoundation(requirePerson().id) })),
);

memoryRouter.post(
  '/memory/movie-school/practice',
  handler(async (req) => {
    const person = requirePerson();
    const body = bodyOf(req);
    return addPractice({
      ownerId: person.id,
      kind: requiredEnum<'OBJECTIVE' | 'EXERCISE' | 'ASSESSMENT'>(body.kind, ['OBJECTIVE', 'EXERCISE', 'ASSESSMENT'], 'kind'),
      title: requiredString(body.title, 'title'),
      body: optionalString(body.body, 'body') ?? '',
      basisIdeaId: optionalString(body.basisIdeaId, 'basisIdeaId') ?? null,
    });
  }),
);

memoryRouter.post(
  '/memory/circumstances',
  handler(async (req) => {
    const person = requirePerson();
    const body = bodyOf(req);
    return recordCircumstance({
      ownerId: person.id,
      kind: requiredEnum(body.kind, ['CAPABILITY', 'CAPITAL', 'PRIORITY', 'OBSTACLE_REMOVED', 'OPPORTUNITY', 'FEASIBILITY'] as const, 'kind'),
      statement: requiredString(body.statement, 'statement'),
    });
  }),
);

/** Run one bounded pass now, for this person's history only. */
memoryRouter.post(
  '/memory/process',
  handler(async () => ({ report: await runMemoryPass({ ownerId: requirePerson().id, budgetMs: 25_000 }) })),
);

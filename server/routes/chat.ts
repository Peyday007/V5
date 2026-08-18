/**
 * Chat API.
 *
 * The assistant is a thin shell over the tool layer: every claim it makes comes
 * from a tool call against live state, so a conversation can be thrown away
 * without losing anything (invariants 7 and 12). These routes only carry
 * messages in and the persisted turn out.
 */
import { Router } from 'express';
import { getDefaultProject } from '../repos/projects.ts';
import { getChatHistory, handleChatMessage } from '../services/agent/chat.ts';
import { recomputeProject } from '../services/stateEngine.ts';
import {
  badRequest,
  bodyOf,
  handler,
  optionalString,
  queryOf,
  requireProject,
  requiredString,
} from './helpers.ts';

export const chatRouter = Router();

/**
 * Chat is the one place the user may not have picked a project yet, so an
 * omitted id falls back to the default project rather than failing.
 */
function resolveProjectId(value: unknown): string {
  const explicit = optionalString(value, 'projectId');
  if (explicit) return requireProject(explicit).id;
  const fallback = getDefaultProject();
  if (!fallback) {
    throw badRequest('No project exists yet, so there is nothing to chat about.');
  }
  return fallback.id;
}

chatRouter.get(
  '/',
  handler((req) => {
    const query = queryOf(req);
    const projectId = resolveProjectId(query['projectId']);
    return getChatHistory(projectId, optionalString(query['conversationId'], 'conversationId') ?? null);
  }),
);

chatRouter.post(
  '/',
  handler((req) => {
    const body = bodyOf(req);
    const projectId = resolveProjectId(body['projectId']);
    const content = requiredString(body['content'], 'content');
    const conversationId = optionalString(body['conversationId'], 'conversationId') ?? null;

    const turn = handleChatMessage({ projectId, content, conversationId });
    // A chat turn can freeze a layer or create a run; recomputing here means the
    // next screen the user looks at is already correct.
    recomputeProject(projectId);
    return turn;
  }),
);

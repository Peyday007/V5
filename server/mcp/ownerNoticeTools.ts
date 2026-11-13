/**
 * The owner's conversation reads Brain's notices here (owner, 2026-11-13: "notify me DIRECTLY
 * IN THIS ORIGINAL CLAUDE CODE CONVERSATION").
 *
 * A scheduled task bound to the owner's Claude Code conversation calls `brain_owner_notices`
 * with the goal's project, announces each undelivered notice verbatim, and records it with
 * `brain_owner_notice_delivered`, so a notice is announced once however often the check runs.
 * Both are ordinary authorized operations on the project's own event log (invariant 28): read
 * needs `project:read`; recording delivery appends a receipt and needs `checkpoints:write`.
 */
import { withProjectExistence } from '../services/stateEngine.ts';
import { invalidInput, notFoundError } from './errors.ts';
import { READ_ONLY, MUTATING, authorize, requiredString, type McpTool } from './toolkit.ts';

const noticesTool: McpTool = {
  name: 'brain_owner_notices',
  title: 'Owner notices waiting to be announced',
  description:
    "Notices Brain recorded for the owner and not yet announced in the owner's conversation: a cash goal's plan that " +
    'passed every evidence and feasibility requirement (kind PLAN_READY, text beginning with its completion header), and ' +
    'a verified self-improvement (kind IMPROVEMENT). Each carries the exact text to announce. Empty when nothing qualified.',
  inputSchema: {
    type: 'object',
    properties: { project_id: { type: 'string', description: "The goal's project id." } },
    required: ['project_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Owner notices', ...READ_ONLY },
  run: async (args, { principal }) => {
    const projectId = requiredString(args, 'project_id');
    await authorize(principal, projectId, 'READ', 'project:read');
    const { undeliveredOwnerNotices } = await import('../services/ownerNotices.ts');
    const notices = await withProjectExistence(projectId, () => undeliveredOwnerNotices([projectId]));
    return {
      projectId,
      value: { notices: notices.map((n) => ({ noticeId: n.noticeId, kind: n.kind, readyAt: n.readyAt, subject: n.subject, text: n.text })) },
    };
  },
};

const deliveredTool: McpTool = {
  name: 'brain_owner_notice_delivered',
  title: 'Record that a notice was announced',
  description:
    "Record that an owner notice was announced in the owner's conversation, so it is never announced twice. Idempotent.",
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      notice_id: { type: 'string', description: 'The noticeId from brain_owner_notices.' },
      where: { type: 'string', description: 'Where it was announced, e.g. the Claude Code session id.' },
    },
    required: ['project_id', 'notice_id', 'where'],
    additionalProperties: false,
  },
  annotations: { title: 'Record a notice announced', ...MUTATING },
  run: async (args, { principal }) => {
    const projectId = requiredString(args, 'project_id');
    await authorize(principal, projectId, 'WRITE', 'checkpoints:write');
    const noticeId = requiredString(args, 'notice_id');
    if (!/^(plan-ready|owner-improvement|ops-report)\.[A-Za-z0-9_.-]{1,120}$/.test(noticeId)) throw invalidInput('notice_id is not an owner notice id.');
    const { readOwnerNotice, markOwnerNoticeDelivered } = await import('../services/ownerNotices.ts');
    const notice = await readOwnerNotice(noticeId);
    // A notice in another project is answered exactly as one that does not exist (invariant 30).
    if (!notice || notice.projectId !== projectId) throw notFoundError();
    const done = await markOwnerNoticeDelivered({ noticeId, deliveredBy: `${principal.type}:${principal.id}`, where: requiredString(args, 'where') });
    return { projectId, value: { noticeId, deliveredAt: done?.deliveredAt ?? null } };
  },
};

export const OWNER_NOTICE_TOOLS: readonly McpTool[] = [noticesTool, deliveredTool];

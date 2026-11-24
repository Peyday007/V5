/**
 * The Command Center's one extra door: Brain's read-only operator tools, over
 * the browser session a person already holds.
 *
 * The Command Center (`command/`, served at `/command`) is a window, never a
 * second brain (§25, §57). Almost everything it shows comes from routes that
 * already exist — goals, conversations, Needs you, integrations, the fleet.
 * What had no HTTP route was the operator's reading of the same rows: the goal
 * plan with its committee verdict, capacity, deficiencies, engineering
 * throughput. Those exist as MCP tools, and the rule for a protocol is that it
 * is a door, not a second set of rules (§21, invariant 28). So this route does
 * not re-implement a single one of them: it calls `callTool` — the executor
 * MCP uses — so the tool's own authorization, the per-credential rate slot,
 * the time limit and the `MCP_TOOL_CALL` audit row are the same code path, not
 * a copy that could drift.
 *
 * Two guards keep it a read door:
 *   - persons only (`requirePerson`), the same as the goals door: a worker
 *     already has MCP and gains nothing here;
 *   - the tool must be on `COMMAND_READ_TOOLS` *and* annotated read-only. A
 *     tool whose annotation is ever changed to a mutation drops off this door by
 *     itself rather than silently becoming writable from a browser.
 *
 * Mutations stay on the routes that own them (goal pause/resume, Needs you
 * answers, conversation turns); the Command Center calls those directly.
 */
import { Router } from 'express';
import { handler, notFound, requirePerson } from './helpers.ts';
import { callTool } from '../mcp/execute.ts';
import { findTool } from '../mcp/tools.ts';
import { currentContext } from '../services/identity/context.ts';

export const commandRouter: Router = Router();

/** Read tools the Command Center may call. Read-only annotation is re-checked per call. */
export const COMMAND_READ_TOOLS: readonly string[] = [
  'brain_operator_goals',
  'brain_operator_goal',
  'brain_operator_goal_plan',
  'brain_operator_capacity',
  'brain_operator_integrations',
  'brain_operator_history',
  'brain_operator_deficiencies',
  'brain_operator_engineering',
  'brain_operator_experiments',
  'brain_operator_allocation',
];

/** One argument value from the query string: a string, or a number when it is plainly one. */
function argumentValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return undefined;
  if (/^-?\d+(\.\d+)?$/.test(raw) && raw.length < 16) return Number(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

export function commandReadable(name: string): boolean {
  if (!COMMAND_READ_TOOLS.includes(name)) return false;
  const tool = findTool(name);
  return !!tool && tool.annotations.readOnlyHint === true;
}

commandRouter.get(
  '/command/read/:tool',
  handler(async (req, res) => {
    const principal = requirePerson();
    const name = String(req.params.tool ?? '');
    // Absent and not-allowed are one answer (invariant 23).
    if (!commandReadable(name)) throw notFound('No such route.');
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(req.query)) {
      if (!/^[a-z_]{1,40}$/.test(key)) continue;
      const parsed = argumentValue(value);
      if (parsed !== undefined) args[key] = parsed;
    }
    const context = currentContext();
    const outcome = await callTool({
      toolName: name,
      args,
      principal,
      requestId: principal.requestId,
      clientName: 'brain-command-center',
      protocolVersion: 'command-center',
      userAgent: context?.userAgent ?? null,
      remoteAddr: context?.remoteAddr ?? null,
    });
    const body = outcome.result;
    if (body.isError) {
      const text = body.content[0]?.text ?? 'The read was refused.';
      res.status(422);
      return { error: text, refused: true };
    }
    return { value: body.structuredContent ?? null };
  }),
);

/*
 * Reports, backlog and resources: readings the Command Center shows whole.
 *
 * Each is assembled from the existing readers — the inventory, the engineering
 * outcomes, the deficiencies, the operator's record, the stored hourly reports,
 * the audits, the backlog classifier, the resource reading — never recomputed
 * here. Brain-wide readings carry goals, lessons and titles from every project,
 * so they need operator rights, decided by the same `operatorProjects` the MCP
 * tools use (policy, not memberships). A section whose reader fails is reported
 * as failed with a sentence; the others still arrive.
 */
async function section<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : 'The reading failed.' };
  }
}

async function requireOperatorPerson() {
  const principal = requirePerson();
  const { operatorProjects } = await import('../mcp/operatorTools.ts');
  const projects = await operatorProjects(principal);
  if (projects.length === 0) throw notFound('No such route.');
  return { principal, projects };
}

commandRouter.get(
  '/command/reports',
  handler(async () => {
    const { projects } = await requireOperatorPerson();
    const [{ listInventory }, { engineeringOutcomes, readDeficiencies }, { recentOperatorRuns, listOperatorLearnings }, { listRecordedReports }, { listRecentAudits }, { interventionMetrics }] =
      await Promise.all([
        import('../services/operator/inventory.ts'),
        import('../services/operator/director.ts'),
        import('../repos/operator.ts'),
        import('../services/operator/operationsReport.ts'),
        import('../repos/audits.ts'),
        import('../repos/engineering.ts'),
      ]);
    const [inventory, engineering, deficiencies, runs, learnings, hourly, audits, interventions] = await Promise.all([
      section(() => listInventory()),
      section(() => engineeringOutcomes({ limit: 50, includeClosed: true })),
      section(() => readDeficiencies()),
      section(() => recentOperatorRuns(25)),
      section(() => listOperatorLearnings({ limit: 25 })),
      section(() => listRecordedReports(24)),
      section(() => listRecentAudits(projects, 40)),
      section(() => interventionMetrics()),
    ]);
    return { readAt: new Date().toISOString(), inventory, engineering, deficiencies, runs, learnings, hourly, audits, interventions };
  }),
);

commandRouter.get(
  '/command/backlog',
  handler(async () => {
    await requireOperatorPerson();
    const { readResearchBacklog } = await import('../services/research/backlog.ts');
    return await readResearchBacklog();
  }),
);

commandRouter.get(
  '/command/resources',
  handler(async () => {
    const principal = requirePerson();
    const { listProjects } = await import('../repos/projects.ts');
    const { decideProjectAccess, visibleProjectIds } = await import('../services/identity/policy.ts');
    const all = (await listProjects()).map((p) => p.id);
    if (!visibleProjectIds(principal, all).some((id) => decideProjectAccess(principal, id, 'READ').allowed)) {
      throw notFound('No such route.');
    }
    const { readResources } = await import('../services/operator/resources.ts');
    return await readResources();
  }),
);

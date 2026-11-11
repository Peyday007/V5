/**
 * The terminal where a person records, inspects and runs a browser workflow
 * (ACQ-21-1, ACQ-21-2).
 *
 *   npx tsx server/services/sources/browserWorkflowCli.ts record --file workflow.json --by peyton
 *   npx tsx server/services/sources/browserWorkflowCli.ts show   --host app.example
 *   npx tsx server/services/sources/browserWorkflowCli.ts run    --host app.example --name export-orders [--param from=2026-11-01 ...]
 *
 * Invariant 35: a decision a person makes that has no surface they already use
 * is a terminal, and reaching the shell is the authentication. Recording writes
 * through `recordBrowserWorkflow`, the one writer of BROWSER_WORKFLOW rows that
 * the read path's routines and every run read back. A workflow holds steps and
 * locators, never a credential: an ACCOUNT workflow runs under the session the
 * account browser already holds, and only on a host a person granted with
 * `operatePermissionCli.ts`. Parameter values are never printed or stored.
 */
import { readFile } from 'node:fs/promises';
import { closeDatabase, initDatabase } from '../../db/database.ts';
import {
  withoutQuery,
  readBrowserWorkflows,
  recordBrowserWorkflow,
  runBrowserWorkflow,
  workflowParams,
  type RecordedWorkflow,
  type WorkflowDeps,
  type WorkflowRun,
} from './browserWorkflow.ts';

export interface BrowserWorkflowCliDeps {
  readFile?: (path: string) => Promise<string>;
  record?: typeof recordBrowserWorkflow;
  workflows?: () => Promise<Map<string, RecordedWorkflow[]>>;
  run?: typeof runBrowserWorkflow;
  runDeps?: WorkflowDeps;
}

const USAGE =
  'usage: browserWorkflowCli.ts record --file PATH --by NAME\n' +
  '       browserWorkflowCli.ts show --host H\n' +
  '       browserWorkflowCli.ts run --host H --name N [--param key=value ...]';

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return null;
  const value = argv[at + 1];
  return value && !value.startsWith('--') ? value : null;
}

function params(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  argv.forEach((arg, i) => {
    if (arg !== '--param') return;
    const pair = argv[i + 1] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  });
  return out;
}

function describeRun(run: WorkflowRun): string {
  const lines = [`${run.name} on ${run.host}: ${run.outcome} — ${run.reason}`];
  for (const s of run.steps) lines.push(`  ${s.ok ? 'ok ' : 'NO '} ${s.index}. ${s.kind}: ${s.detail}`);
  if (run.extracted.length) lines.push(`  extracted ${run.extracted.reduce((n, t) => n + t.length, 0)} characters`);
  for (const d of run.downloads) lines.push(`  downloaded ${d.chars} characters from ${withoutQuery(d.url)} (sha256 ${d.sha256.slice(0, 12)})`);
  return lines.join('\n');
}

/** Run one command. Returns the exit code and what to print; never throws for a usage error. */
export async function runBrowserWorkflowCommand(argv: readonly string[], deps: BrowserWorkflowCliDeps = {}): Promise<{ code: number; out: string }> {
  const [command] = argv;
  if (command === 'record') {
    const file = flag(argv, 'file');
    const by = flag(argv, 'by')?.trim() ?? '';
    if (!file || !by) return { code: 2, out: USAGE };
    try {
      const raw = JSON.parse(await (deps.readFile ?? ((p: string) => readFile(p, 'utf8')))(file)) as unknown;
      const w = await (deps.record ?? recordBrowserWorkflow)(raw, by);
      return { code: 0, out: `recorded "${w.name}" on ${w.host} (${w.session}, ${w.steps.length} steps; parameters: ${workflowParams(w).join(', ') || 'none'})` };
    } catch (error) {
      return { code: 1, out: `refused: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const host = flag(argv, 'host')?.trim().toLowerCase() ?? '';
  if (!host || (command !== 'show' && command !== 'run')) return { code: 2, out: USAGE };
  const recorded = (await (deps.workflows ?? readBrowserWorkflows)()).get(host) ?? [];
  if (command === 'show') {
    if (recorded.length === 0) return { code: 0, out: `${host}: no workflow is recorded` };
    return {
      code: 0,
      out: recorded.map((r) => `${host}: "${r.workflow.name}" (${r.workflow.session}, ${r.workflow.steps.length} steps, recorded ${r.recordedAt}; parameters: ${workflowParams(r.workflow).join(', ') || 'none'})`).join('\n'),
    };
  }
  const name = flag(argv, 'name')?.trim() ?? '';
  const found = recorded.find((r) => r.workflow.name === name);
  if (!found) return { code: 1, out: `${host}: no workflow named "${name}" is recorded` };
  const run = await (deps.run ?? runBrowserWorkflow)(found.workflow, params(argv), { caller: 'terminal', ...(deps.runDeps ?? {}) });
  return { code: run.outcome === 'SUCCEEDED' ? 0 : 1, out: describeRun(run) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  await initDatabase();
  try {
    const { robotsAllowFor } = await import('./access.ts');
    const { code, out } = await runBrowserWorkflowCommand(process.argv.slice(2), { runDeps: { robotsAllow: robotsAllowFor } });
    (code === 0 ? console.log : console.error)(out);
    process.exitCode = code;
  } finally {
    await closeDatabase();
  }
}

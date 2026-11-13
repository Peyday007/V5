/**
 * The terminal where a person defines, discovers, approves, retires and runs a
 * browser capability (ACQ-21-5).
 *
 *   npx tsx server/services/sources/browser/capabilityCli.ts show     --host H
 *   npx tsx server/services/sources/browser/capabilityCli.ts define   --file capability.json --by NAME
 *   npx tsx server/services/sources/browser/capabilityCli.ts discover --host H --name N --owner WHO --by NAME
 *   npx tsx server/services/sources/browser/capabilityCli.ts approve  --host H --name N --hash HASH --by NAME [--note TEXT]
 *   npx tsx server/services/sources/browser/capabilityCli.ts retire   --host H --name N --hash HASH --by NAME [--note TEXT]
 *   npx tsx server/services/sources/browser/capabilityCli.ts run      --host H --name N --project P --by NAME
 *                                                                     [--inputs JSON] [--approve-steps 2,5]
 *
 * Invariant 35: a decision a person makes that has no surface they already use
 * is a terminal, and reaching the shell is the authentication — the same door
 * as `operatePermissionCli.ts`. Every command writes through the one writer of
 * its record (`recordBrowserCapability`, `discoverBrowserCapability`,
 * `recordCapabilityDecision`) and every run goes through `operateCapability`,
 * so nothing here is a second path. Approved, input-free reads are then run by
 * the Brain itself on the integrations tick (`schedule.ts`).
 *
 * An approval names the exact content hash `show` prints, so a person approves
 * what they read and nothing newer. `run --approve-steps` is the person at the
 * terminal approving those effectful steps of the current version, each bound
 * to the step fingerprint `show` prints; a step they did not name is refused
 * before submission. Nothing printed carries a credential: output goes through
 * the redactor.
 */
import { readFile } from 'node:fs/promises';
import { closeDatabase, initDatabase } from '../../../db/database.ts';
import { classifyWorkflow, type ApprovedAction } from './actionClass.ts';
import {
  discoverBrowserCapability,
  readBrowserCapabilities,
  recordBrowserCapability,
  recordCapabilityDecision,
  type BrowserCapability,
  type CapabilityDeps,
  type CapabilityRecord,
} from './capability.ts';
import { operateCapability, type OperateCapabilityDeps } from './operate.ts';
import { redactText } from './redaction.ts';
import { scheduledEligibility } from './schedule.ts';

export interface CapabilityCliDeps {
  capabilityDeps?: CapabilityDeps;
  operateDeps?: OperateCapabilityDeps;
  record?: typeof recordBrowserCapability;
  decide?: typeof recordCapabilityDecision;
  discover?: typeof discoverBrowserCapability;
  operate?: typeof operateCapability;
  readFile?: (path: string) => Promise<string>;
  now?: () => Date;
}

const COMMANDS = ['show', 'define', 'discover', 'approve', 'retire', 'run'] as const;

const USAGE = [
  'usage: capabilityCli.ts show --host H',
  '       capabilityCli.ts define --file F.json --by NAME',
  '       capabilityCli.ts discover --host H --name N --owner WHO --by NAME',
  '       capabilityCli.ts approve|retire --host H --name N --hash HASH --by NAME [--note TEXT]',
  '       capabilityCli.ts run --host H --name N --project P --by NAME [--inputs JSON] [--approve-steps 2,5]',
].join('\n');

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return null;
  const value = argv[at + 1];
  return value && !value.startsWith('--') ? value : null;
}

const findRecord = (records: Map<string, CapabilityRecord>, name: string): CapabilityRecord | null => {
  const want = name.trim().toLowerCase();
  for (const r of records.values()) if (r.name.trim().toLowerCase() === want) return r;
  return null;
};

/** One capability, as a person needs it to decide: version, hash, effect, lifecycle and each step's class. */
export function describeCapability(r: CapabilityRecord): string {
  const c = r.current.capability;
  const judgment = classifyWorkflow(c.workflow);
  const lines = [
    `${r.host} · "${r.name}" v${r.current.version} ${r.status}${r.handoff ? ` (handoff: ${r.handoff})` : ''} — ${c.effect}`,
    `  hash ${r.current.contentHash}`,
    `  maintained by ${c.maintenanceOwner}; approved by ${r.approvedBy ?? 'nobody'}; last completed ${r.lastCompletedAt ?? 'never'}${r.fresh ? ' (fresh)' : ''}`,
    `  inputs: ${c.inputs.map((f) => f.name).join(', ') || 'none'}; outputs: ${c.outputs.map((f) => f.name).join(', ') || 'none'}`,
    `  why: ${r.why}`,
    `  scheduled: ${scheduledEligibility(r).why}`,
    ...judgment.steps.map((s) => `  step ${s.index} ${s.kind} ${s.actionClass} ${s.fingerprint.slice(0, 16)}`),
  ];
  return redactText(lines.join('\n'));
}

/** Run one command. Returns the exit code and the text to print; never throws for a usage error. */
export async function runCapabilityCommand(argv: readonly string[], deps: CapabilityCliDeps = {}): Promise<{ code: number; out: string }> {
  const [command] = argv;
  if (!COMMANDS.includes(command as (typeof COMMANDS)[number])) return { code: 2, out: USAGE };
  const by = flag(argv, 'by')?.trim() ?? '';
  const host = flag(argv, 'host')?.trim().toLowerCase() ?? '';
  const name = flag(argv, 'name')?.trim() ?? '';
  const capDeps = deps.capabilityDeps ?? {};
  try {
    if (command === 'define') {
      const file = flag(argv, 'file');
      if (!file || !by) return { code: 2, out: `define needs --file and --by\n${USAGE}` };
      const capability = JSON.parse(await (deps.readFile ?? ((p: string) => readFile(p, 'utf8')))(file)) as BrowserCapability;
      const v = await (deps.record ?? recordBrowserCapability)(capability, by, capDeps);
      return { code: 0, out: `defined "${capability.workflow.name}" v${v.version} on ${capability.workflow.host}: hash ${v.contentHash} (DRAFT until approved)` };
    }

    if (!host) return { code: 2, out: `${command} needs --host\n${USAGE}` };
    if (command === 'show') {
      const records = await readBrowserCapabilities(host, capDeps);
      if (records.size === 0) return { code: 0, out: `${host}: no capability is recorded` };
      return { code: 0, out: [...records.values()].map(describeCapability).join('\n') };
    }

    if (!name || !by) return { code: 2, out: `${command} needs --name and --by\n${USAGE}` };
    if (command === 'discover') {
      const owner = flag(argv, 'owner')?.trim() ?? '';
      if (!owner) return { code: 2, out: `discover names a maintenance owner with --owner\n${USAGE}` };
      const result = await (deps.discover ?? discoverBrowserCapability)(host, name, { maintenanceOwner: owner }, by, capDeps);
      const head = `${result.outcome}: ${redactText(result.reason)}`;
      return { code: result.outcome === 'DRAFTED' ? 0 : 1, out: result.version ? `${head}\n  v${result.version.version} hash ${result.version.contentHash}` : head };
    }

    if (command === 'approve' || command === 'retire') {
      const hash = flag(argv, 'hash')?.trim() ?? '';
      if (!hash) return { code: 2, out: `${command} names the exact version with --hash (from show)\n${USAGE}` };
      const note = flag(argv, 'note');
      await (deps.decide ?? recordCapabilityDecision)(
        { host, name, contentHash: hash, decision: command === 'approve' ? 'APPROVED' : 'RETIRED', by, ...(note ? { note } : {}) },
        capDeps,
      );
      const after = findRecord(await readBrowserCapabilities(host, capDeps), name);
      return { code: 0, out: after ? describeCapability(after) : `${command}d "${name}" on ${host}` };
    }

    // run
    const projectId = flag(argv, 'project')?.trim() ?? '';
    if (!projectId) return { code: 2, out: `run names the project the work belongs to with --project\n${USAGE}` };
    const rawInputs = flag(argv, 'inputs');
    const inputs = rawInputs ? (JSON.parse(rawInputs) as Record<string, string>) : {};
    const record = findRecord(await readBrowserCapabilities(host, capDeps), name);
    if (!record) return { code: 1, out: `refused: no capability "${name}" is recorded for ${host}` };
    const judgment = classifyWorkflow(record.current.capability.workflow);
    const at = (deps.now ?? (() => new Date()))().toISOString();
    const named = (flag(argv, 'approve-steps') ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
    const approvals: ApprovedAction[] = [];
    for (const index of named) {
      const step = judgment.steps.find((s) => s.index === index);
      if (!step) return { code: 2, out: `step ${index} does not exist in v${record.current.version}` };
      approvals.push({ stepIndex: index, fingerprint: step.fingerprint, actionClass: step.actionClass, approvedBy: by, approvedAt: at });
    }
    const result = await (deps.operate ?? operateCapability)(
      { projectId, host, name, inputs, approvals, actor: { type: 'HUMAN', id: by } },
      deps.operateDeps ?? {},
    );
    const ok = result.outcome === 'COMPLETED' || result.outcome === 'DEFERRED';
    return {
      code: ok ? 0 : 1,
      out: redactText(`${result.outcome}${result.failureReason ? ` (${result.failureReason})` : ''}: ${result.detail}${result.effectKey ? `\n  effect key ${result.effectKey}` : ''}`),
    };
  } catch (error) {
    return { code: 1, out: `refused: ${redactText(error instanceof Error ? error.message : String(error))}` };
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  await initDatabase();
  try {
    const { code, out } = await runCapabilityCommand(process.argv.slice(2));
    (code === 0 ? console.log : console.error)(out);
    process.exitCode = code;
  } finally {
    await closeDatabase();
  }
}

/**
 * The terminal way in for a prepared option (GOV-22-2).
 *
 * A prepared option is research a session did cheaply — feasibility, the
 * simplest provider or tool, an interface sketch or source inventory — and it
 * has to reach the rows to be worth anything. This is that entrance, on a
 * terminal where reaching the shell is the authentication (§26), with no
 * administration page:
 *
 *   npx tsx --env-file-if-exists=.env server/services/capability/preparedCommand.ts record <projectId> <option.json>
 *   npx tsx --env-file-if-exists=.env server/services/capability/preparedCommand.ts list [projectId]
 *   npx tsx --env-file-if-exists=.env server/services/capability/preparedCommand.ts advance
 *
 * `record` validates and appends through `recordPreparedOption`, the same
 * function everything else uses, and prints that it is not an integration.
 * `advance` runs the pass the Russell tick already runs, so the handoff and
 * resumption it records can be seen without waiting for the tick.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  advancePreparedOptions,
  countsAsIntegration,
  latestPreparedOptions,
  preparedOptions,
  recordPreparedOption,
  warmCost,
  type ConnectNeedsDeps,
} from './prepared.ts';

export const PREPARED_USAGE = `prepared options (GOV-22-2)
  record <projectId> <option.json>   record a prepared option against a capability-map requirement
  list [projectId]                   the latest prepared option per requirement
  advance                            hand live goals' needs to the Factory and judge resumption, as the tick does`;

/** Runs one command against an initialised database. Returns the lines it would print. */
export async function runPreparedCommand(
  argv: readonly string[],
  deps: { read?: (file: string) => Promise<string>; connect?: ConnectNeedsDeps } = {},
): Promise<string[]> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'record': {
      const [projectId, file] = rest;
      if (!projectId || !file) throw new Error(`usage: record <projectId> <option.json>\n${PREPARED_USAGE}`);
      const raw = await (deps.read ?? ((f: string) => readFile(f, 'utf8')))(file);
      const option = await recordPreparedOption(projectId, JSON.parse(raw) as unknown);
      const cost = warmCost(option);
      return [
        `recorded a prepared option for ${option.requirementId} (${option.feasibility.verdict}, ${option.methods.length} method(s))`,
        `integration: ${String(countsAsIntegration(option))} — only a WORKING proof reading over real attempts makes it one`,
        `workers kept warm: ${cost.workers}`,
        ...cost.refused.map((r) => `not built to keep warm: ${r}`),
      ];
    }
    case 'list': {
      const [projectId] = rest;
      const options = projectId ? await preparedOptions(projectId) : await latestPreparedOptions();
      if (options.size === 0) return ['no prepared options recorded'];
      return [...options.values()].map(
        (o) => `${o.requirementId}: ${o.feasibility.verdict}; ${o.methods.map((m) => `${m.name} [${m.kind}, effort ${m.effort}${m.gates.length ? `, gated ${m.gates.join('+')}` : ''}]`).join('; ')}`,
      );
    }
    case 'advance': {
      const r = await advancePreparedOptions(deps.connect);
      return [
        `goals read: ${r.needs.goals}; handed off: ${r.needs.handedOff}; gated for a person: ${r.needs.gated}`,
        ...r.needs.refused.map((x) => `refused by the Factory contract: ${x}`),
        `handoffs judged: ${r.judged}; resumed: ${r.resumed}`,
      ];
    }
    default:
      return [PREPARED_USAGE];
  }
}

async function main(): Promise<void> {
  const { initDatabase, closeDatabase } = await import('../../db/database.ts');
  await initDatabase();
  try {
    for (const line of await runPreparedCommand(process.argv.slice(2))) process.stdout.write(`${line}\n`);
  } finally {
    await closeDatabase();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String((error as Error).message ?? error)}\n`);
    process.exitCode = 1;
  });
}

/**
 * `npm run engineering` — the engineering connector on a terminal.
 *
 * The same functions the MCP tools call, for a person or a Claude Code session
 * that is not holding the connector, and the one door that may write the
 * stronger evidence sources: CI, OPERATOR and REAL_PRODUCTION rows need a shell
 * (reaching it is the authentication, §26) and `--admin`, which is attribution
 * resolved against `users` rather than trusted.
 *
 *   policy     --paths a,b [--sha S --repo R] [--release] [--full]
 *   preflight  --objective "…" [--paths a,b] [--root-cause "…"] [--proposal "…"]
 *              [--outcome PRODUCTION_WORKING] [--broken] [--blast SMALL|MEDIUM|LARGE]
 *   lookup     --repo owner/name --key PROPERTY [--offline]
 *   record     --repo R --key K --status PROVEN|FAILED --source CI|OPERATOR|REAL_PRODUCTION
 *              --ref "…" [--sha S] [--scope a,b] --admin <email>
 *   invalidate --repo R --scope NAME --reason "…" --admin <email>
 *   next       --outcome LEVEL [--reached LEVEL] [--watch MINUTES] [--wait MINUTES] [--stop]
 *   duplicate  --proposal "…"
 *   idle       [--continue]
 *   report     interventions and the metrics they add up to
 *
 * Prints `ENGINEERING: OK` last, and only when nothing set a failing code.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { getUserByEmail } from '../server/repos/identity.ts';
import {
  EVIDENCE_SOURCES,
  OUTCOME_LEVELS,
  duplicateMechanismCheck,
  fullGateKey,
  nextEngineeringAction,
  preflight,
  testPolicy,
  type EvidenceSource,
  type EvidenceStatus,
  type OutcomeLevel,
} from '../server/domain/engineering.ts';
import { ENGINEERING_TOOLS } from '../server/mcp/engineeringTools.ts';
import {
  connectorCalls,
  interventionMetrics,
  invalidateScope,
  listInterventions,
  recordEvidence,
  recordIntervention,
} from '../server/repos/engineering.ts';
import { lookupEvidence } from '../server/services/engineering/evidence.ts';
import { watchIdle } from '../server/services/engineering/watchdog.ts';

function flag(argv: string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return null;
  const value = argv[at + 1];
  return value === undefined || value.startsWith('--') ? '' : value;
}
const has = (argv: string[], name: string): boolean => argv.includes(`--${name}`);
const list = (value: string | null): string[] =>
  value ? value.split(',').map((one) => one.trim()).filter((one) => one.length > 0) : [];
const out = (value: unknown): void => {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
};

function fail(message: string): never {
  process.stderr.write(`ENGINEERING REFUSED: ${message}\n`);
  process.exit(2);
}

function outcome(value: string | null, fallback: OutcomeLevel): OutcomeLevel {
  if (!value) return fallback;
  if (!(OUTCOME_LEVELS as readonly string[]).includes(value)) fail(`--outcome must be one of ${OUTCOME_LEVELS.join(', ')}`);
  return value as OutcomeLevel;
}

async function resolveAdmin(argv: string[]): Promise<string> {
  const email = flag(argv, 'admin');
  if (!email) fail('--admin <email> says whose authority this carries, and it is required.');
  const person = await getUserByEmail(email);
  if (!person || !person.isBrainAdmin || person.disabled) {
    fail(`"${email}" resolves to no enabled administrator of this Brain (attribution, not authentication).`);
  }
  return person.id;
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === 'help') {
    out('commands: policy, preflight, lookup, record, invalidate, next, duplicate, idle, report');
    return;
  }
  await initDatabase();
  const actor = { actorType: 'OPERATOR', actorId: 'shell' };

  switch (command) {
    case 'policy': {
      const repo = flag(argv, 'repo');
      const sha = flag(argv, 'sha');
      const fullGate: { sqlite?: EvidenceStatus; postgres?: EvidenceStatus } = {};
      if (repo && sha) {
        fullGate.sqlite = (await lookupEvidence({ repository: repo, propertyKey: fullGateKey(sha, 'sqlite'), offline: has(argv, 'offline') })).status;
        fullGate.postgres = (await lookupEvidence({ repository: repo, propertyKey: fullGateKey(sha, 'postgres'), offline: has(argv, 'offline') })).status;
      }
      const policy = testPolicy({
        changedPaths: list(flag(argv, 'paths')),
        sha,
        releaseSha: has(argv, 'release'),
        proposesFullSuite: has(argv, 'full'),
        fullGate,
      });
      if (policy.fullSuiteRefused) {
        await recordIntervention({
          kind: 'REDUNDANT_TEST_BLOCKED',
          rule: 'RULE_3_NO_REDUNDANT_FULL_SUITES',
          attemptedAction: `full suite${sha ? ` on ${sha}` : ''}`,
          replacementAction: policy.commands.join(' && ') || 'no test run',
          minutesAvoided: 20,
          taskRef: flag(argv, 'task'),
          ...actor,
        });
      }
      out({ ...policy, fullGate });
      break;
    }
    case 'preflight': {
      const objective = flag(argv, 'objective');
      if (!objective) fail('--objective is required');
      const blast = flag(argv, 'blast');
      const envelope = preflight({
        objective,
        intendedOutcome: outcome(flag(argv, 'outcome'), 'PRODUCTION_WORKING'),
        changedPaths: list(flag(argv, 'paths')),
        knownRootCause: flag(argv, 'root-cause'),
        productionBroken: has(argv, 'broken'),
        blastRadius: blast === 'MEDIUM' || blast === 'LARGE' ? blast : 'SMALL',
        proposedAction: flag(argv, 'proposal'),
      });
      if (envelope.proposalRefused) {
        await recordIntervention({
          kind: 'OVERENGINEERING_BLOCKED',
          rule: 'RULE_1_MINIMUM_SUFFICIENT_FIX',
          attemptedAction: flag(argv, 'proposal') ?? '',
          replacementAction: envelope.proposalRefused,
          taskRef: flag(argv, 'task'),
          ...actor,
        });
      }
      out(envelope);
      break;
    }
    case 'lookup': {
      const repo = flag(argv, 'repo');
      const key = flag(argv, 'key');
      if (!repo || !key) fail('--repo and --key are required');
      out(await lookupEvidence({ repository: repo, propertyKey: key, offline: has(argv, 'offline') }));
      break;
    }
    case 'record': {
      const repo = flag(argv, 'repo');
      const key = flag(argv, 'key');
      const status = flag(argv, 'status');
      const source = flag(argv, 'source');
      const ref = flag(argv, 'ref');
      if (!repo || !key || !status || !source || !ref) fail('--repo, --key, --status, --source and --ref are required');
      if (!['PROVEN', 'FAILED', 'STALE', 'UNKNOWN'].includes(status)) fail('--status is PROVEN, FAILED, STALE or UNKNOWN');
      if (!(EVIDENCE_SOURCES as readonly string[]).includes(source)) fail(`--source is one of ${EVIDENCE_SOURCES.join(', ')}`);
      const adminId = await resolveAdmin(argv);
      const id = await recordEvidence({
        repository: repo,
        propertyKey: key,
        status: status as EvidenceStatus,
        source: source as EvidenceSource,
        evidenceRef: ref,
        codeSha: flag(argv, 'sha'),
        invalidationScope: list(flag(argv, 'scope')),
        recordedByType: 'OPERATOR',
        recordedById: adminId,
      });
      out({ recorded: id });
      break;
    }
    case 'invalidate': {
      const repo = flag(argv, 'repo');
      const scope = flag(argv, 'scope');
      const reason = flag(argv, 'reason');
      if (!repo || !scope || !reason) fail('--repo, --scope and --reason are required');
      const adminId = await resolveAdmin(argv);
      out({ invalidated: await invalidateScope({ repository: repo, scope, reason, recordedByType: 'OPERATOR', recordedById: adminId }) });
      break;
    }
    case 'next': {
      const watch = flag(argv, 'watch');
      const wait = flag(argv, 'wait');
      const decision = nextEngineeringAction({
        intendedOutcome: outcome(flag(argv, 'outcome'), 'PRODUCTION_WORKING'),
        reached: flag(argv, 'reached') ? outcome(flag(argv, 'reached'), 'PLAN') : null,
        runningProcess: watch ? { observable: true, expectedMinutes: Number(watch) } : null,
        proposedWaitMinutes: wait ? Number(wait) : null,
        proposingToStop: has(argv, 'stop'),
        independentWorkAvailable: has(argv, 'independent'),
      });
      for (const one of decision.interventions) {
        await recordIntervention({
          kind: one.kind,
          rule: one.kind === 'BAD_WAIT_BLOCKED' ? 'RULE_4_NO_DUMB_WAITING' : 'RULE_5_USER_OUTCOME_DEFINES_DONE',
          attemptedAction: one.attempted,
          replacementAction: one.replacement,
          minutesAvoided: one.minutesAvoided,
          taskRef: flag(argv, 'task'),
          ...actor,
        });
      }
      out(decision);
      break;
    }
    case 'duplicate': {
      const proposal = flag(argv, 'proposal');
      if (!proposal) fail('--proposal is required');
      out(duplicateMechanismCheck({ proposal, whyExtensionFails: flag(argv, 'why') }));
      break;
    }
    case 'idle':
      out(await watchIdle({ continueWork: has(argv, 'continue') }));
      break;
    case 'report':
      out({
        servingRevision: process.env.BRAIN_REVISION ?? null,
        metrics: await interventionMetrics(),
        recent: await listInterventions(20),
        connectorCalls: await connectorCalls(ENGINEERING_TOOLS.map((tool) => tool.name)),
      });
      break;
    default:
      process.exitCode = 2;
      process.stderr.write(`ENGINEERING REFUSED: "${command}" is not a command.\n`);
  }
  await closeDatabase();
  if (!process.exitCode) out('ENGINEERING: OK');
}

await main();

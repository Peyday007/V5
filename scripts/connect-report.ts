/**
 * `npm run connect:report` — what a connected site has actually done to Brain.
 *
 * Reading the connector's own rows needs a credential over HTTP, and a
 * credential is precisely the thing that must not travel. So this reads them
 * from inside the container, where reaching the shell is already the
 * authentication, exactly like `verify-hosted.ts` and `connect-site.ts`.
 *
 *   npm run connect:report -- --project prj_xxx [--site deal-dispatch] [--limit 20]
 *
 * It writes nothing. Every projection is derived on the read path already
 * (§25), so asking for one moves no state and costs the site nothing.
 *
 * It prints identifiers, versions, states and Brain's own sentences. It does not
 * print a credential, because it never reads one.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { getProject, getProjectBySlug } from '../server/repos/projects.ts';
import {
  countExternalRecords,
  listExternalRecords,
  listRejections,
} from '../server/repos/externalRecords.ts';
import { listEvents } from '../server/repos/events.ts';
import { projectRecord } from '../server/services/connect/projection.ts';
import { nowIso } from '../server/repos/util.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

const CONNECT_EVENTS = new Set([
  'EXTERNAL_RECORD_IMPORTED',
  'EXTERNAL_RECORD_UPDATED',
  'EXTERNAL_RECORD_REJECTED',
  'EXTERNAL_COMMAND_ACCEPTED',
]);

async function main(): Promise<void> {
  if (!process.env['BRAIN_DATABASE_POOL_SIZE']) process.env['BRAIN_DATABASE_POOL_SIZE'] = '2';
  await initDatabase();

  const projectRef = flag('project');
  const sourceSystem = (flag('site') ?? 'deal-dispatch').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(flag('limit') ?? 20) || 20, 1), 200);

  if (!projectRef) {
    console.error('Usage: --project <project id or slug> [--site deal-dispatch] [--limit 20]');
    console.log('CONNECT-REPORT: FAIL');
    process.exitCode = 1;
    return;
  }
  const project = (await getProject(projectRef)) ?? (await getProjectBySlug(projectRef));
  if (!project) {
    console.error(`No project ${projectRef}.`);
    console.log('CONNECT-REPORT: FAIL');
    process.exitCode = 1;
    return;
  }

  const total = await countExternalRecords({ projectId: project.id, sourceSystem });
  const records = await listExternalRecords({ projectId: project.id, sourceSystem, limit });
  const rejections = (await listRejections({ projectId: project.id, limit: 50 })).filter(
    (rejection) => rejection.sourceSystem === sourceSystem,
  );
  const events = (await listEvents(project.id, 300)).filter((event) =>
    CONNECT_EVENTS.has(event.eventType),
  );

  console.log('');
  console.log(`  project          ${project.name} (${project.id})`);
  console.log(`  source system    ${sourceSystem}`);
  console.log(`  records          ${total} registered`);
  console.log(`  rejections       ${rejections.length} distinct reason/record pairs`);
  console.log(
    `  events           ${events.length} connector events (${
      events.filter((event) => event.eventType === 'EXTERNAL_COMMAND_ACCEPTED').length
    } accepted commands)`,
  );
  console.log('');

  if (records.length > 0) {
    const at = nowIso();
    console.log(`  ${'source id'.padEnd(28)} ${'version'.padEnd(26)} ${'state'.padEnd(16)} title`);
    for (const record of records) {
      const projection = await projectRecord(record, at);
      console.log(
        `  ${record.sourceRecordId.slice(0, 28).padEnd(28)} ${record.sourceVersion
          .slice(0, 26)
          .padEnd(26)} ${projection.state.padEnd(16)} ${record.title.slice(0, 48)}`,
      );
      if (projection.research) {
        console.log(
          `      research: ${projection.research.missionId}${
            projection.research.documentId ? ` filed ${projection.research.documentId}` : ''
          }${projection.research.filedUnder ? ` under ${projection.research.filedUnder}` : ''}`,
        );
      }
      if (record.commandedAt) {
        console.log(
          `      commanded: ${record.commandedCommand} at ${record.commandedAt}` +
            (record.commandedByLabel ? ` (attributed to ${record.commandedByLabel})` : ''),
        );
      }
    }
    console.log('');
  }

  if (rejections.length > 0) {
    console.log('  Refused, and kept rather than dropped:');
    for (const rejection of rejections) {
      console.log(
        `    ${rejection.sourceRecordId || '(no id)'} ${rejection.reason} x${rejection.occurrences} — ${rejection.detail}`,
      );
    }
    console.log('');
  }

  if (events.length > 0) {
    console.log('  Most recent connector events:');
    for (const event of events.slice(0, 12)) {
      const payload = JSON.stringify(event.payload);
      console.log(
        `    ${event.createdAt}  ${event.eventType.padEnd(26)} ${payload.slice(0, 110)}`,
      );
    }
    console.log('');
  }

  console.log('CONNECT-REPORT: OK');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.log('CONNECT-REPORT: FAIL');
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
  });

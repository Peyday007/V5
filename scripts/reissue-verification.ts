/**
 * `npm run reissue:verification` — the operator's hands for one recovery.
 *
 * Deliberately not a console screen. The permanent thing is
 * `services/research/reissue.ts`; this is a way to call it today, and Step 12
 * will call the same service from wherever the Brain's own controls end up. A
 * screen built now would be a third disposable surface and would tempt the
 * logic to live inside it.
 *
 * It runs where `verify-hosted.ts` runs: inside the container, through
 * `flyctl ssh console`. That is the authentication — reaching this shell means
 * holding deploy access to the Brain — but it is not the attribution. The
 * action is recorded against a real administrator, named on the command line
 * and resolved against the database, because an audit row whose actor is "a
 * script" answers nothing a year later.
 *
 *   List what is stranded in a packet:
 *     npm run reissue:verification -- --orchestration orc_xxx
 *
 *   Reissue one, by the id the listing printed:
 *     npm run reissue:verification -- --item wki_xxx --admin someone@example.com
 *
 * No credential is read, printed or required. The administrator is identified,
 * not authenticated, by this path — which is the right trade only because the
 * shell it runs in is already the harder gate.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { initStorage } from '../server/services/storage/index.ts';
import { getUserByEmail } from '../server/repos/identity.ts';
import { getOrchestration } from '../server/repos/research.ts';
import {
  findStrandedVerifications,
  reissueMissingVerification,
} from '../server/services/research/reissue.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  // A small pool, for the reason `verify-hosted.ts` gives at length: this runs
  // beside the Brain and shares its connection allowance.
  if (!process.env['BRAIN_DATABASE_POOL_SIZE']) process.env['BRAIN_DATABASE_POOL_SIZE'] = '2';
  await initDatabase();
  await initStorage();

  const orchestrationId = flag('orchestration');
  const itemId = flag('item');
  const adminEmail = flag('admin');

  try {
    if (orchestrationId && !itemId) {
      const orchestration = await getOrchestration(orchestrationId);
      if (!orchestration) {
        console.log('No such packet.');
        process.exitCode = 1;
        return;
      }
      console.log(`${orchestration.title}`);
      console.log(`  status  ${orchestration.status}`);
      const stranded = await findStrandedVerifications(orchestrationId);
      if (stranded.length === 0) {
        console.log('');
        console.log('No stranded verifications. Nothing here needs reissuing.');
        return;
      }
      console.log('');
      console.log(`${stranded.length} verification(s) finished without recording a verdict:`);
      for (const entry of stranded) {
        console.log('');
        console.log(`  item      ${entry.workItemId}`);
        console.log(`  fragment  ${entry.fragmentKey} (${entry.fragmentStatus})`);
        console.log(`  finished  ${entry.completedAt ?? 'unknown'} after ${entry.attemptCount} attempt(s)`);
      }
      console.log('');
      console.log('Reissue one with:');
      console.log(`  npm run reissue:verification -- --item <item> --admin <email>`);
      return;
    }

    if (!itemId || !adminEmail) {
      console.log('Usage:');
      console.log('  npm run reissue:verification -- --orchestration <orchestrationId>');
      console.log('  npm run reissue:verification -- --item <workItemId> --admin <email>');
      process.exitCode = 2;
      return;
    }

    // Named, resolved, and required to be an administrator. The audit row this
    // produces says who, and "who" has to be a person who exists.
    const admin = await getUserByEmail(adminEmail);
    if (!admin || admin.disabled || !admin.isBrainAdmin) {
      console.log('That address is not an active Brain administrator. Nothing was done.');
      process.exitCode = 1;
      return;
    }

    const result = await reissueMissingVerification({
      workItemId: itemId,
      actor: { type: 'HUMAN', id: admin.id },
    });

    if (result.status === 'ALREADY_REISSUED') {
      console.log(
        `Already reissued: ${result.replacementWorkItemId ?? 'a replacement'} exists for ` +
          `${result.fragmentKey}. Nothing was created.`,
      );
      return;
    }

    console.log(`Reissued the verification for ${result.fragmentKey}.`);
    console.log(`  replaced  ${result.originalWorkItemId}`);
    console.log(`  new item  ${result.replacementWorkItemId}`);
    console.log(`  packet    ${result.advanced?.status ?? 'unchanged'}`);
    if (result.advanced?.enqueued.length) {
      console.log(
        `  queued    ${result.advanced.enqueued.map((entry) => entry.workType).join(', ')}`,
      );
    }
    console.log('');
    console.log('A worker can claim it now. Nothing else was touched: every claim, verdict,');
    console.log('rejection reason and attempt count is exactly as it was.');
  } catch (error) {
    console.log(error instanceof Error ? `Refused: ${error.message}` : String(error));
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

void main();

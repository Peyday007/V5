/**
 * `npm run authorize:gap-policy` — one packet, one authorization, once.
 *
 * Recording an unresolved gap narrows what a packet claims to answer, so it is
 * a decision a person makes about one orchestration. This is how that decision
 * reaches the database today; `services/research/gapPolicy.ts` is the permanent
 * thing, and Step 12 will call it from the Brain's own controls.
 *
 * It runs where `verify-hosted.ts` and `reissue-verification.ts` run: inside the
 * container, through `flyctl ssh console`, from the release pipeline. Reaching
 * that shell is the authentication; the attribution is separate and explicit —
 * the administrator is named on the command line and resolved against the
 * database, because an audit row with no author answers nothing later.
 *
 *   npm run authorize:gap-policy -- --orchestration orc_xxx --admin someone@example.com
 *
 * Idempotent by the packet's own state. Running it again reports the
 * authorization that already exists and rewrites neither its author nor its
 * timestamp. It authorizes exactly the orchestration named and nothing else.
 *
 * No credential is read, printed or required.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { getUserByEmail, listUsers } from '../server/repos/identity.ts';
import { getOrchestration } from '../server/repos/research.ts';
import { authorizeUnresolvedGaps } from '../server/services/research/gapPolicy.ts';
import { advancePacket } from '../server/services/research/packetRunner.ts';
import { listWorkItems } from '../server/repos/workQueue.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  // Small pool: this runs beside the Brain and shares its connection allowance.
  if (!process.env['BRAIN_DATABASE_POOL_SIZE']) process.env['BRAIN_DATABASE_POOL_SIZE'] = '2';
  await initDatabase();

  const orchestrationId = flag('orchestration');
  const adminEmail = flag('admin');
  if (!orchestrationId || !adminEmail) {
    console.error('Usage: --orchestration orc_xxx --admin someone@example.com');
    process.exitCode = 1;
    return;
  }

  const admin = await getUserByEmail(adminEmail);
  if (!admin) {
    /*
     * Name who *could* sign this, rather than only who could not.
     *
     * "No account for x@y" is a dead end: the operator now has to find the
     * address some other way, and the obvious ways are the admin console or a
     * database console — one of which needs the address to sign in and the
     * other is the thing §2 exists to avoid. Reaching this shell is already the
     * authentication, as the header above says, and the console shows an
     * administrator the list of people anyway, so this discloses nothing the
     * same caller cannot already read.
     *
     * Addresses only. No digest, no verifier, no session — a diagnostic about
     * accounts must not become a way to read credentials.
     */
    const admins = (await listUsers()).filter((user) => user.isBrainAdmin && !user.disabledAt);
    console.error(`No account for ${adminEmail}. The authorization needs a real person on it.`);
    console.error(
      admins.length === 0
        ? '  This Brain has no enabled administrator, so nobody can authorize anything yet.'
        : `  Administrators of this Brain: ${admins.map((user) => user.email).join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }
  if (!admin.isBrainAdmin) {
    console.error(`${adminEmail} is not an administrator of this Brain.`);
    process.exitCode = 1;
    return;
  }

  const before = await getOrchestration(orchestrationId);
  if (!before) {
    console.error(`No orchestration ${orchestrationId}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`  packet      ${before.id} — ${before.title}`);
  console.log(`  status      ${before.status}`);

  const result = await authorizeUnresolvedGaps({
    orchestrationId,
    authorizedBy: { id: admin.id, email: admin.email },
  });
  console.log(
    result.status === 'AUTHORIZED'
      ? `  authorized  RECORD_GAPS, by ${adminEmail}, at ${result.orchestration.unresolvedGapAuthorizedAt}`
      : `  already     RECORD_GAPS, authorized at ${result.orchestration.unresolvedGapAuthorizedAt}`,
  );

  // Advancing is the point of authorizing: the packet has been waiting for a
  // decision, and the decision is now made. Idempotent by the runner's own
  // per-target guards, so a repeat run creates nothing.
  const advanced = await advancePacket(orchestrationId);
  console.log(`  advanced    ${advanced.status}${advanced.waitingOn ? ` — ${advanced.waitingOn}` : ''}`);
  for (const entry of advanced.enqueued) console.log(`  queued      ${entry.workType} ${entry.workItemId}`);

  const live = (await listWorkItems(before.projectId, { limit: 200 })).filter(
    (item) =>
      item.orchestrationId === orchestrationId &&
      (item.state === 'QUEUED' || item.state === 'LEASED'),
  );
  console.log(`  claimable   ${live.length}`);
  for (const item of live) console.log(`              ${item.workType} ${item.id} ${item.state}`);

  console.log(`GAP-POLICY: OK ${result.status} claimable=${live.length}`);
}

main()
  .catch((error) => {
    console.error('GAP-POLICY: FAILED', error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());

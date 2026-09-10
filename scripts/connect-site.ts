/**
 * `npm run connect:site` — prepare a connected site's identity, and stop
 * exactly where a secret would start.
 *
 * The rule is in `services/identity/connectSite.ts`; this is the entrance that
 * works when there is no browser. It runs where `verify-hosted.ts` and
 * `authorize-gap-policy.ts` run: inside the container, through
 * `flyctl ssh console`, from the release pipeline — the established way in, for
 * the reason that file gives, that handing a shell operation back to the
 * operator is how a recovery ends up unreachable. Reaching that shell is the
 * authentication; the administrator named on the command line is the
 * attribution, resolved against the database, because an audit row with no
 * author answers nothing later.
 *
 *   npm run connect:site -- --project prj_xxx --admin someone@example.com
 *   npm run connect:site -- --project prj_xxx --check
 *
 * **It never issues a credential and never prints one.** That is the contract
 * rather than caution: a worker credential is shown exactly once at issue and
 * is not recoverable afterwards by anyone, and no credential may appear in a
 * log — and a workflow run log is a log that outlives the run. The console
 * issues it, into one response, to a person who is signed in. What this removes
 * from that person's job is the part with a wrong answer in it.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { getUserByEmail, listUsers } from '../server/repos/identity.ts';
import { listProjects } from '../server/repos/projects.ts';
import {
  BadSiteName,
  NoSuchProject,
  prepareConnectedSite,
  readConnectedSite,
  type ConnectedSiteReport,
} from '../server/services/identity/connectSite.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function has(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function fail(message: string): void {
  console.error(message);
  console.log('CONNECT-SITE: FAIL');
  process.exitCode = 1;
}

async function nameTheProjects(): Promise<void> {
  console.error('This Brain holds:');
  for (const project of await listProjects()) {
    console.error(`  ${project.id}  ${project.slug}  ${project.name}`);
  }
}

async function nameTheAdministrators(): Promise<void> {
  /*
   * Name who *could* sign this, rather than only who could not — the same
   * reasoning `authorize-gap-policy.ts` writes out at length. Addresses only:
   * no digest, no verifier, no session.
   */
  const admins = (await listUsers()).filter((user) => user.isBrainAdmin && !user.disabledAt);
  console.error(
    admins.length === 0
      ? '  This Brain has no enabled administrator, so nobody can grant anything yet.'
      : `  Enabled administrators: ${admins.map((user) => user.email).join(', ')}`,
  );
}

function print(report: ConnectedSiteReport): void {
  console.log('');
  console.log(
    `  site worker      ${report.siteName}${
      report.workerId ? ` (${report.workerId})` : ' — does not exist yet'
    }${report.workerCreated ? ' — created now' : ''}`,
  );
  console.log(`  project          ${report.project.name} (${report.project.id})`);
  console.log(
    `  scopes           ${
      report.scopes
        ? report.scopes.join(', ')
        : 'none — this worker has no membership on that project'
    }`,
  );
  console.log(
    `  credentials      ${report.liveCredentials} live, ${report.revokedCredentials} revoked`,
  );
  console.log(`  used yet         ${report.everUsed ? 'yes' : 'no'}`);
  console.log('');
  if (report.liveCredentials === 0) {
    console.log('  Nothing here can authenticate yet, and that is on purpose: a credential is');
    console.log('  shown once, to a person, in a browser. Sign in to /operator, find this');
    console.log('  worker, press "Issue credential", and paste the value straight into the');
    console.log("  site's BRAIN_TOKEN. It is not recoverable afterwards by anyone.");
  } else {
    console.log('  A live credential already exists. It cannot be read back — if the site does');
    console.log('  not hold it, issue a new one from /operator and revoke this one.');
  }
  console.log('');
}

async function main(): Promise<void> {
  // Small pool: this runs beside the Brain and shares its connection allowance.
  if (!process.env['BRAIN_DATABASE_POOL_SIZE']) process.env['BRAIN_DATABASE_POOL_SIZE'] = '2';
  await initDatabase();

  const siteName = (flag('site') ?? 'deal-dispatch').trim().toLowerCase();
  const projectRef = flag('project');
  const adminEmail = flag('admin');

  if (!projectRef) {
    console.error(
      'Usage: --project <project id or slug> --admin someone@example.com [--site deal-dispatch] [--check]',
    );
    await nameTheProjects();
    fail('No project was named.');
    return;
  }

  try {
    if (has('check')) {
      print(await readConnectedSite(projectRef, siteName));
      console.log('CONNECT-SITE: OK');
      return;
    }

    /*
     * A write needs an administrator; a read does not. Everything the write
     * does lands in `identity_events`, which is read later by somebody asking
     * who gave a machine access to a project, and "the pipeline did" is not an
     * answer to that question.
     */
    if (!adminEmail) {
      console.error('A write needs an administrator to record it against. Pass --admin, or --check to only read.');
      await nameTheAdministrators();
      fail('No administrator was named.');
      return;
    }
    const admin = await getUserByEmail(adminEmail);
    if (!admin || !admin.isBrainAdmin || admin.disabledAt) {
      console.error(`${adminEmail} is not an enabled administrator of this Brain.`);
      await nameTheAdministrators();
      fail('The grant needs a real administrator on it.');
      return;
    }

    print(await prepareConnectedSite({ projectRef, siteName, admin }));
    console.log('CONNECT-SITE: OK');
  } catch (error) {
    if (error instanceof NoSuchProject) {
      console.error(error.message);
      await nameTheProjects();
      fail('The project must exist before a site can be pointed at it.');
      return;
    }
    if (error instanceof BadSiteName) {
      fail('A canonical worker name is lower case letters, digits and hyphens.');
      return;
    }
    throw error;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.log('CONNECT-SITE: FAIL');
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
  });

/**
 * The terminal where a person grants or revokes Brain's permission to operate a
 * site's interface under a named account (ACQ-21-1).
 *
 *   npx tsx server/services/sources/operatePermissionCli.ts grant  --host app.example --account "owner login" --by peyton [--note "…"]
 *   npx tsx server/services/sources/operatePermissionCli.ts revoke --host app.example --by peyton [--note "…"]
 *   npx tsx server/services/sources/operatePermissionCli.ts show   --host app.example
 *
 * Invariant 35: a decision a person makes that has no surface they already use
 * is a terminal, and reaching the shell is the authentication. This is the only
 * producer of `OPERATE_PERMISSION` rows besides code that calls
 * `recordOperatePermission` directly, and it writes through that one writer, so
 * the record the OPERATE judgment reads is the record this command makes.
 *
 * The account is named by reference — a label the person recognizes — never a
 * credential: the writer refuses anything credential-shaped, and nothing here
 * prints or stores a secret. A grant is never authorization to contact
 * strangers, evade a site's defenses or commit the business; those boundaries
 * are judged before any grant is read.
 */
import { closeDatabase, initDatabase } from '../../db/database.ts';
import { readOperatePermission, recordOperatePermission, type OperatePermission } from './acquisition.ts';

export interface OperatePermissionCliDeps {
  record?: typeof recordOperatePermission;
  read?: typeof readOperatePermission;
}

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return null;
  const value = argv[at + 1];
  return value && !value.startsWith('--') ? value : null;
}

const USAGE =
  'usage: operatePermissionCli.ts grant --host H --account REF --by NAME [--note TEXT]\n' +
  '       operatePermissionCli.ts revoke --host H --by NAME [--note TEXT]\n' +
  '       operatePermissionCli.ts show --host H';

function describe(host: string, p: OperatePermission): string {
  return p.permitted
    ? `${host}: Brain may operate this site under "${p.accountRef}" (granted by ${p.grantedBy ?? 'unknown'}${p.at ? ` at ${p.at}` : ''})`
    : `${host}: no standing permission to operate this site${p.grantedBy ? ` (last revoked by ${p.grantedBy}${p.at ? ` at ${p.at}` : ''})` : ''}`;
}

/** Run one command. Returns the exit code and the line to print; never throws for a usage error. */
export async function runOperatePermissionCommand(
  argv: readonly string[],
  deps: OperatePermissionCliDeps = {},
): Promise<{ code: number; out: string }> {
  const [command] = argv;
  const host = flag(argv, 'host')?.trim().toLowerCase() ?? '';
  if (!host || (command !== 'grant' && command !== 'revoke' && command !== 'show')) return { code: 2, out: USAGE };
  const read = deps.read ?? readOperatePermission;
  if (command === 'show') return { code: 0, out: describe(host, await read(host)) };
  const by = flag(argv, 'by')?.trim() ?? '';
  if (!by) return { code: 2, out: `${command} names the person giving it with --by\n${USAGE}` };
  const account = flag(argv, 'account');
  if (command === 'grant' && !account?.trim()) return { code: 2, out: `grant names the account by reference with --account\n${USAGE}` };
  try {
    await (deps.record ?? recordOperatePermission)({ host, granted: command === 'grant', accountRef: account, grantedBy: by, note: flag(argv, 'note') });
  } catch (error) {
    return { code: 1, out: `refused: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { code: 0, out: describe(host, await read(host)) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  await initDatabase();
  try {
    const { code, out } = await runOperatePermissionCommand(process.argv.slice(2));
    (code === 0 ? console.log : console.error)(out);
    process.exitCode = code;
  } finally {
    await closeDatabase();
  }
}

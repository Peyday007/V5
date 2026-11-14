/**
 * The owner's emergency stop, from a terminal (AUTH-34, S-0481).
 *
 * `setEmergencyStop` is the one writer of the stop control, and the action path
 * (`decideAction` → `judgeLive` → `emergencyStopOn`) already reads it, so a stop
 * pauses every externally consequential action while internal work, held
 * commitments and their accounting carry on. Until now nothing a person could
 * reach called that writer. This terminal does, through that same writer and
 * nothing else (§10.3, §20.4). There is deliberately no administration page
 * (invariant 35): reaching this shell is the authentication, and the person is
 * named with `--as` so the row records who stopped Brain and why.
 *
 *   npx tsx server/services/cash/emergencyStopCli.ts status --project ID
 *   npx tsx server/services/cash/emergencyStopCli.ts stop   --project ID --as EMAIL --reason TEXT
 *   npx tsx server/services/cash/emergencyStopCli.ts resume --project ID --as EMAIL --reason TEXT
 *
 * `--project` takes a project id or slug. Only an enabled Brain administrator,
 * or the person who owns the project's Cash Mode, may stop or resume it. A
 * reason is required: the stop is an audit record, not a toggle.
 */
import { getUserByEmail } from '../../repos/identity.ts';
import { getProject, getProjectBySlug } from '../../repos/projects.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import { emergencyStopOn, setEmergencyStop } from './authority.ts';

export interface EmergencyStopCliDeps {
  set?: typeof setEmergencyStop;
  isOn?: typeof emergencyStopOn;
}

const USAGE =
  'usage: emergencyStopCli.ts status --project ID\n' +
  '       emergencyStopCli.ts stop   --project ID --as EMAIL --reason TEXT\n' +
  '       emergencyStopCli.ts resume --project ID --as EMAIL --reason TEXT';

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  const value = at < 0 ? undefined : argv[at + 1];
  return value && !value.startsWith('--') ? value.trim() : null;
}

function describe(projectId: string, on: boolean): string {
  return on
    ? `Emergency stop is ON for ${projectId}: externally consequential actions are paused; internal work, held commitments and their accounting continue.`
    : `Emergency stop is OFF for ${projectId}: actions are judged by the authority in force.`;
}

/** Run one command. Returns the exit code and the text to print; never throws for a usage or authority error. */
export async function runEmergencyStopCommand(
  argv: readonly string[],
  deps: EmergencyStopCliDeps = {},
): Promise<{ code: number; out: string }> {
  const [command] = argv;
  if (command !== 'status' && command !== 'stop' && command !== 'resume') return { code: 2, out: USAGE };
  const ref = flag(argv, 'project');
  if (!ref) return { code: 2, out: USAGE };
  const project = (await getProject(ref)) ?? (await getProjectBySlug(ref));
  if (!project) return { code: 1, out: `No project ${ref}.` };
  const isOn = deps.isOn ?? emergencyStopOn;

  if (command === 'status') return { code: 0, out: describe(project.id, await isOn(project.id)) };

  const email = flag(argv, 'as');
  const reason = flag(argv, 'reason');
  if (!email || !reason) return { code: 2, out: `${command} needs --as EMAIL and --reason TEXT, so the record says who and why.\n${USAGE}` };
  const user = await getUserByEmail(email);
  const mode = await getCashMode(project.id);
  const allowed = !!user && !user.disabledAt && (user.isBrainAdmin || (mode !== null && mode.ownerUserId === user.id));
  if (!allowed) {
    return { code: 1, out: `${email} may not ${command} the emergency stop for ${project.id}: only an enabled Brain administrator or the owner of its Cash Mode may.` };
  }
  await (deps.set ?? setEmergencyStop)({ projectId: project.id, on: command === 'stop', actorUserId: user!.id, reason });
  return { code: 0, out: describe(project.id, await isOn(project.id)) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  void (async () => {
    const { initDatabase, closeDatabase } = await import('../../db/database.ts');
    await initDatabase();
    try {
      const { code, out } = await runEmergencyStopCommand(process.argv.slice(2));
      (code === 0 ? console.log : console.error)(out);
      process.exitCode = code;
    } finally {
      await closeDatabase();
    }
  })();
}

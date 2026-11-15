/**
 * Renew a priority family's window from a terminal (RES-15-4, S-0148).
 *
 * `recordFamilyRenewal` is the one writer of a family's recorded window, and
 * discovery order, the dive pass and the commission pass all read it through
 * `familyDeclarationFor`. This terminal calls that writer and nothing else.
 * There is deliberately no administration page (invariant 35): reaching this
 * shell is the authentication, and the person is named with `--as` so the row
 * records who renewed the priority and why.
 *
 *   npx tsx server/services/cash/familyPriorityCli.ts status --project ID
 *   npx tsx server/services/cash/familyPriorityCli.ts renew  --project ID --as EMAIL --review-by DATE --reason TEXT
 */
import { getUserByEmail } from '../../repos/identity.ts';
import { getProject, getProjectBySlug } from '../../repos/projects.ts';
import { familyCurrent } from './intermediationPositions.ts';
import { familyDeclarationFor, recordFamilyRenewal } from './familyPriority.ts';

const USAGE =
  'usage: familyPriorityCli.ts status --project ID\n' +
  '       familyPriorityCli.ts renew  --project ID --as EMAIL --review-by DATE --reason TEXT';

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  const value = at < 0 ? undefined : argv[at + 1];
  return value && !value.startsWith('--') ? value.trim() : null;
}

async function describe(projectId: string, now: Date): Promise<string> {
  const declaration = await familyDeclarationFor(projectId);
  const current = familyCurrent(declaration, now);
  return `${declaration.key} priority for ${projectId} is ${current ? 'CURRENT' : 'NOT CURRENT'}: since ${declaration.since}, review by ${declaration.reviewBy}.`;
}

/** Run one command. Returns the exit code and the text to print; never throws for a usage or authority error. */
export async function runFamilyPriorityCommand(
  argv: readonly string[],
  now: Date = new Date(),
): Promise<{ code: number; out: string }> {
  const [command] = argv;
  if (command !== 'status' && command !== 'renew') return { code: 2, out: USAGE };
  const ref = flag(argv, 'project');
  if (!ref) return { code: 2, out: USAGE };
  const project = (await getProject(ref)) ?? (await getProjectBySlug(ref));
  if (!project) return { code: 1, out: `No project ${ref}.` };
  if (command === 'status') return { code: 0, out: await describe(project.id, now) };

  const email = flag(argv, 'as');
  const reviewBy = flag(argv, 'review-by');
  const reason = flag(argv, 'reason');
  if (!email || !reviewBy || !reason) {
    return { code: 2, out: `renew needs --as EMAIL, --review-by DATE and --reason TEXT, so the record says who, until when and why.\n${USAGE}` };
  }
  const user = await getUserByEmail(email);
  if (!user) return { code: 1, out: `${email} may not renew the family priority for ${project.id}.` };
  const result = await recordFamilyRenewal({ projectId: project.id, actorUserId: user.id, reviewBy, reason });
  if (result.status === 'REFUSED') return { code: 1, out: result.message };
  return { code: 0, out: await describe(project.id, now) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  void (async () => {
    const { initDatabase, closeDatabase } = await import('../../db/database.ts');
    await initDatabase();
    try {
      const { code, out } = await runFamilyPriorityCommand(process.argv.slice(2));
      (code === 0 ? console.log : console.error)(out);
      process.exitCode = code;
    } finally {
      await closeDatabase();
    }
  })();
}

/**
 * The terminal where a person, or an agent at the shell, starts watching a page
 * and reads what changed on it (§65; invariant 35: reaching the shell is the
 * authentication).
 *
 *   npx tsx server/services/feeds/watchCli.ts add  --project P --url U --reason "why" [--key REGULATION:x] [--every 360] --by NAME
 *   npx tsx server/services/feeds/watchCli.ts list --project P
 *
 * A watch is checked by the cash tick (`checkDueWatchedSources`), never more
 * often than hourly. A change it finds is a change row and a re-read through
 * the claim gate; it is never a fact.
 */
import { closeDatabase, initDatabase } from '../../db/database.ts';
import { sourceChangesFor, watchedSourcesFor, watchSource } from '../../repos/watchedSources.ts';
import { parseBlockerKey } from '../../domain/types.ts';

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return null;
  const value = argv[at + 1];
  return value && !value.startsWith('--') ? value : null;
}

const USAGE =
  'usage: watchCli.ts add --project P --url U --reason TEXT [--key KIND:arg] [--every MINUTES] --by NAME\n' +
  '       watchCli.ts list --project P';

/** Run one command. Returns the exit code and the text to print; never throws for a usage error. */
export async function runWatchCommand(argv: readonly string[]): Promise<{ code: number; out: string }> {
  const [command] = argv;
  const projectId = flag(argv, 'project')?.trim() ?? '';
  if (!projectId || (command !== 'add' && command !== 'list')) return { code: 2, out: USAGE };
  if (command === 'list') {
    const lines: string[] = [];
    for (const source of await watchedSourcesFor(projectId)) {
      const changes = await sourceChangesFor(source.id);
      lines.push(
        `${source.url}  [${source.blockerKey ?? 'no key'}] every ${source.checkIntervalMinutes}m, ` +
          `last read ${source.fetchedAt ?? 'never'}${source.lastError ? `, last error: ${source.lastError}` : ''}, ` +
          `${changes.length} change(s) — ${source.reason}`,
      );
    }
    return { code: 0, out: lines.length > 0 ? lines.join('\n') : 'no watched sources' };
  }
  const url = flag(argv, 'url') ?? '';
  const reason = flag(argv, 'reason') ?? '';
  const by = flag(argv, 'by')?.trim() ?? '';
  if (!url || !reason || !by) return { code: 2, out: `add needs --url, --reason and --by\n${USAGE}` };
  const rawKey = flag(argv, 'key');
  const key = rawKey ? parseBlockerKey(rawKey) : null;
  if (rawKey && !key) return { code: 2, out: `--key ${rawKey} is not a blocker key\n${USAGE}` };
  const every = flag(argv, 'every');
  try {
    const { source, created } = await watchSource({
      projectId,
      url,
      reason,
      blockerKey: key,
      ...(every ? { checkIntervalMinutes: Number(every) } : {}),
      createdBy: by,
    });
    return { code: 0, out: `${created ? 'watching' : 'already watched'}: ${source.url} (${source.id})` };
  } catch (error) {
    return { code: 1, out: `refused: ${error instanceof Error ? error.message : String(error)}` };
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  await initDatabase();
  try {
    const { code, out } = await runWatchCommand(process.argv.slice(2));
    (code === 0 ? console.log : console.error)(out);
    process.exitCode = code;
  } finally {
    await closeDatabase();
  }
}

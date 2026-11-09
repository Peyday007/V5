/**
 * In-process production probes a requirement may name as its verification.
 *
 * An HTTP or bundle check can only see what an unauthenticated GET can see. Most
 * of what an architecture requires is behind a principal or in rows, so a
 * requirement may instead name a probe: a read-only function, registered here
 * in reviewed code, that runs inside the released Brain against its real rows.
 *
 * Probes live under the protected verification path, so no implementing
 * campaign can write or weaken the check it will be judged by (§96). A probe a
 * requirement names that is not registered answers UNKNOWN, never PASS.
 */
import { getDb } from '../../../db/database.ts';

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export type Probe = (args: Record<string, string | number | boolean>) => Promise<ProbeResult>;

const PROBES = new Map<string, Probe>();

export function registerProbe(name: string, probe: Probe): void {
  PROBES.set(name, probe);
}

export function getProbe(name: string): Probe | null {
  return PROBES.get(name) ?? null;
}

export function probeNames(): string[] {
  return [...PROBES.keys()].sort();
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The program's own source is intact: its hash still matches the stored text. */
registerProbe('factory.program.source-intact', async (args) => {
  const { getProgram } = await import('../../../repos/factoryProgram.ts');
  const { sha256 } = await import('./spec.ts');
  const program = await getProgram(str(args.program));
  if (!program) return { ok: false, detail: 'no such program' };
  const ok = sha256(program.sourceText) === program.sourceSha256;
  return { ok, detail: ok ? `source ${program.sourceSha256.slice(0, 12)} intact` : 'the stored source no longer matches its hash' };
});

/** A table this Brain is expected to have exists in the database production runs. */
registerProbe('db.table-exists', async (args) => {
  const table = str(args.table);
  if (!/^[a-z_][a-z0-9_]{1,62}$/.test(table)) return { ok: false, detail: 'not a table name' };
  try {
    await getDb().get(`SELECT 1 AS one FROM ${table} LIMIT 1`);
    return { ok: true, detail: `${table} is readable` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : String(error) };
  }
});

/** A Factory campaign reached LIVE: its release was verified inside the released Brain. */
registerProbe('factory.campaign.live', async (args) => {
  const { getCampaignByChangeRequest } = await import('../../../repos/factory.ts');
  const { objectiveOutcome } = await import('../release/outcome.ts');
  const campaign = await getCampaignByChangeRequest(str(args.changeRequest));
  if (!campaign) return { ok: false, detail: 'no campaign for that change request' };
  const outcome = await objectiveOutcome(campaign);
  return { ok: outcome.status === 'LIVE', detail: `${outcome.status}: ${outcome.detail}` };
});

/** A file is present in the source tree of the revision production runs (optionally containing a text, within a length). */
registerProbe('repo.file-at-revision', async (args) => {
  const { BRAIN_REVISION } = await import('../../../env.ts');
  const { parseRemote, readFile } = await import('../forge.ts');
  if (!BRAIN_REVISION) return { ok: false, detail: 'this process carries no BRAIN_REVISION' };
  const repository = parseRemote(str(args.repository) || 'https://github.com/Peyday007/V5');
  if (!repository) return { ok: false, detail: 'not a repository the forge can read' };
  const reply = await readFile(repository, str(args.path), BRAIN_REVISION);
  const contains = str(args.contains);
  if (!reply.ok || reply.body === null) return { ok: false, detail: `not at ${BRAIN_REVISION.slice(0, 12)}` };
  if (contains && !reply.body.includes(contains)) return { ok: false, detail: `present, without "${contains}"` };
  const maxLines = Number(args.maxLines ?? 0);
  const lines = reply.body.split('\n').length;
  if (maxLines > 0 && lines > maxLines) return { ok: false, detail: `${lines} lines, over ${maxLines}` };
  return { ok: true, detail: `present at ${BRAIN_REVISION.slice(0, 12)} (${lines} lines)` };
});

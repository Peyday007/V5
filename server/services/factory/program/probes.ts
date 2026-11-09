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
  if (!ok) return { ok, detail: 'the stored source no longer matches its hash' };
  // Every release appended since is intact too, numbered without a gap (§97).
  for (const [index, amendment] of program.amendments.entries()) {
    if (amendment.number !== index + 1) return { ok: false, detail: `release ${index + 1} is missing; the next recorded is ${amendment.number}` };
    if (sha256(amendment.sourceText) !== amendment.sourceSha256) return { ok: false, detail: `release ${amendment.number} no longer matches its hash` };
  }
  const minimum = Number(args.releases ?? 0);
  if (program.amendments.length < minimum) return { ok: false, detail: `${program.amendments.length} release(s) appended; ${minimum} expected` };
  return { ok, detail: `source ${program.sourceSha256.slice(0, 12)} intact, ${program.amendments.length} release(s) appended and intact` };
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

/* ------------------------------------------------------------------------- */
/* The Brain architecture program, Release 01 (§97)                            */
/* ------------------------------------------------------------------------- */

/** The submission key the architecture program is filed under on production. */
export const ARCHITECTURE_PROGRAM_KEY = 'brain-architecture';

/**
 * The architecture program itself is the implementation of its governance
 * requirements (verbatim preservation, atomic coverage, one parent status,
 * releases appended without restarting): it exists, is approved, its source
 * and every release are intact, and the installed map still accounts for every
 * normative item of the whole specification. Checked against production rows.
 */
async function architectureProgramHolds(): Promise<ProbeResult> {
  const { getDb: db } = await import('../../../db/database.ts');
  const { getProgram, getMap, getPlan } = await import('../../../repos/factoryProgram.ts');
  const { extractSourceItems, programSource, sha256 } = await import('./spec.ts');
  const { validateRequirementMap } = await import('./map.ts');
  const row = await db().get<{ id: string }>(`SELECT id FROM factory_programs WHERE submission_key = ? ORDER BY created_at LIMIT 1`, [ARCHITECTURE_PROGRAM_KEY]);
  const program = row ? await getProgram(row.id) : null;
  if (!program) return { ok: false, detail: `no program filed under "${ARCHITECTURE_PROGRAM_KEY}"` };
  if (program.state !== 'APPROVED') return { ok: false, detail: `program ${program.id} is ${program.state}` };
  if (sha256(program.sourceText) !== program.sourceSha256) return { ok: false, detail: 'the stored source no longer matches its hash' };
  for (const amendment of program.amendments) {
    if (sha256(amendment.sourceText) !== amendment.sourceSha256) return { ok: false, detail: `release ${amendment.number} no longer matches its hash` };
  }
  const map = await getMap(program.id);
  const plan = await getPlan(program.id);
  if (!map || !plan) return { ok: false, detail: 'no installed map and plan' };
  const items = extractSourceItems(programSource(program));
  const validation = validateRequirementMap(items, map.map);
  if (!validation.ok) return { ok: false, detail: `the installed map no longer accounts for the source: ${validation.errors[0]?.code} ${validation.errors[0]?.subject}` };
  const normative = items.filter((i) => i.normative).length;
  return { ok: true, detail: `program ${program.id}: ${items.length} items (${normative} normative) all accounted for by map v${map.version}, plan v${plan.version}, ${program.amendments.length} release(s) appended` };
}

/** Governance requirements of Release 01 answered by the program itself. */
const RELEASE_01_GOVERNANCE = [
  'r01-a-0002', 'r01-a-0004', 'r01-a-0005', 'r01-a-0006', 'r01-a-0008',
  'r01-b-0010', 'r01-b-0011', 'r01-b-0012', 'r01-b-0013', 'r01-b-0014', 'r01-b-0015', 'r01-b-0016', 'r01-b-0017',
  'r01-b-0018', 'r01-b-0019', 'r01-b-0020', 'r01-b-0021', 'r01-b-0022', 'r01-b-0023', 'r01-b-0024',
  'r01-c-0025', 'r01-c-0026', 'r01-c-0027', 'r01-c-0028', 'r01-c-0029', 'r01-c-0030', 'r01-c-0031',
  'r01-head', 'gov-draft', 'gov-10-1', 'gov-10-2', 'gov-10-3', 'gov-10-4', 'gov-10-5', 'gov-12', 'gov-17', 'gov-17-1',
  'gov-17-2', 'gov-17-4', 'gov-18-7', 'gov-22', 'gov-28', 'gov-28-9', 'gov-38',
];
for (const key of RELEASE_01_GOVERNANCE) registerProbe(`r01.${key}`, architectureProgramHolds);

/**
 * A rollup (a heading whose subsections carry the work, or a §28 gap answered
 * by its elaboration) writes no code. Its own check only confirms the program
 * still holds; it reads PRODUCTION_VERIFIED solely because the status derivation
 * also requires every part it depends on to be verified on production.
 */
const RELEASE_01_ROLLUPS = [
  'com-13', 'causal-14', 'acc-15', 'algo-16', 'vent-24', 'know-25', 'comp-26', 'ui-27',
  'gap-28-1', 'gap-28-2', 'gap-28-3', 'gap-28-4', 'gap-28-5', 'gap-28-6', 'gap-28-7', 'gap-28-8', 'life-29', 'fall-37',
];
for (const key of RELEASE_01_ROLLUPS) registerProbe(`r01.${key}`, architectureProgramHolds);

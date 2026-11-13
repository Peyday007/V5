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
  /** null: nothing answered (the forge's read budget, a timeout). UNKNOWN, never a failure (invariant 26). */
  ok: boolean | null;
  detail: string;
}

export type Probe = (args: Record<string, string | number | boolean>) => Promise<ProbeResult>;

const PROBES = new Map<string, Probe>();

/**
 * A program release's acceptance probes (`r01.…`, `r02.…`) are the judge of
 * the campaigns that implement them, so only this protected module defines
 * them (§96, §97). Production 2026-11-10: a campaign registered its own
 * `r01.com-13-5` from server/services/cash — honest that time, and a hole
 * every time after. Any other module asking for a release name is ignored.
 */
const RELEASE_PROBE = /^r\d{2}\./;

function define(name: string, probe: Probe): void {
  // A second definition would silently replace the first judge (production
  // 2026-11-11: r01.cap-16-3's throughput check was overwritten by its stage check).
  if (PROBES.has(name)) throw new Error(`probe ${name} is defined twice in the protected module`);
  PROBES.set(name, probe);
}

export function registerProbe(name: string, probe: Probe): void {
  if (RELEASE_PROBE.test(name)) {
    console.warn(`[program] refused to register ${name} outside the protected probes module; a campaign may not define its own judge`);
    return;
  }
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
/**
 * Files read at a revision, kept for the process: a file at one commit never
 * changes, and three requirements reading one guide spent three of the 60
 * unauthenticated reads an hour production has.
 */
const filesAtRevision = new Map<string, string | null>();

registerProbe('repo.file-at-revision', async (args) => {
  const { BRAIN_REVISION } = await import('../../../env.ts');
  const { parseRemote, readFile } = await import('../forge.ts');
  if (!BRAIN_REVISION) return { ok: false, detail: 'this process carries no BRAIN_REVISION' };
  const repository = parseRemote(str(args.repository) || 'https://github.com/Peyday007/V5');
  if (!repository) return { ok: false, detail: 'not a repository the forge can read' };
  const key = `${repository.slug}:${str(args.path)}@${BRAIN_REVISION}`;
  let body = filesAtRevision.get(key);
  if (body === undefined) {
    const reply = await readFile(repository, str(args.path), BRAIN_REVISION);
    // A forge that did not answer says nothing about the file (program fpg_2adb7f5e,
    // 2026-11-09: a spent read budget reopened a guide that was there, and opened a
    // repair for it). Only the forge's own "no such file" is an absence.
    if (!reply.ok) return { ok: null, detail: `the forge did not answer: ${reply.reason ?? reply.status}` };
    body = reply.body;
    filesAtRevision.set(key, body);
  }
  const contains = str(args.contains);
  if (body === null) return { ok: false, detail: `not at ${BRAIN_REVISION.slice(0, 12)}` };
  if (contains && !body.includes(contains)) return { ok: false, detail: `present, without "${contains}"` };
  const maxLines = Number(args.maxLines ?? 0);
  const lines = body.split('\n').length;
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
for (const key of RELEASE_01_GOVERNANCE) define(`r01.${key}`, architectureProgramHolds);

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
for (const key of RELEASE_01_ROLLUPS) define(`r01.${key}`, architectureProgramHolds);

/**
 * CAP-16-3, first half: model and verification throughput is restored. Read from
 * the free lane's own item rows over the last six hours: work is being accepted
 * (at least one submission per hour on average) and provider failures are not
 * the majority of outcomes. A window with no lane activity at all is a FAIL, not
 * a pass — an idle lane restores nothing.
 */
const throughputRestored: Probe = async (args) => {
  const hours = Number(args.hours ?? 6);
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const rows = await getDb().all<{ outcome: string; provider_failed: number; n: number }>(
    `SELECT outcome, CASE WHEN reason LIKE '%model call failed%' THEN 1 ELSE 0 END AS provider_failed, COUNT(*) AS n
       FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND at >= ?
      GROUP BY outcome, CASE WHEN reason LIKE '%model call failed%' THEN 1 ELSE 0 END`,
    [since],
  );
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  const submitted = rows.filter((r) => r.outcome === 'SUBMITTED').reduce((s, r) => s + Number(r.n), 0);
  const providerFailed = rows.filter((r) => Number(r.provider_failed) === 1).reduce((s, r) => s + Number(r.n), 0);
  const share = total > 0 ? providerFailed / total : 1;
  const ok = submitted >= hours && share < 0.5;
  return { ok, detail: `${hours}h: ${submitted} accepted of ${total} lane outcomes; ${Math.round(share * 100)}% provider failures` };
};

/** COM-13-3: adopted from the quant campaign (release01/outreachFunnelProbe.ts). */
define('r01.com-13-3', async () => (await import('./release01/outreachFunnelProbe.ts')).outreachFunnelHoldsOnRows());

/**
 * GOV-22-2: a prepared option is recorded cheaply and is never counted as a
 * production integration, and an option with neither a sketch nor a source
 * inventory is refused. Read from the released module's own functions.
 */
define('r01.gov-22-2', async () => {
  let prepared: Record<string, unknown>;
  try {
    prepared = (await import('../../capability/prepared.ts' as string)) as Record<string, unknown>;
  } catch {
    return { ok: false, detail: 'prepared options are not deployed in this Brain' };
  }
  const counts = prepared.countsAsIntegration as ((o: unknown) => boolean) | undefined;
  const validate = prepared.validatePreparedOption as ((o: unknown) => unknown) | undefined;
  if (!counts || !validate) return { ok: false, detail: 'prepared options are not deployed in this Brain' };
  const sample = { requirementId: 'probe', feasibility: { verdict: 'FEASIBLE', note: 'probe' }, methods: [{ name: 'x', kind: 'API', gates: [], effort: 1, sources: ['probe'] }], sourceInventory: ['probe'] };
  let refusedEmpty = false;
  try {
    validate({ ...sample, sourceInventory: undefined });
  } catch {
    refusedEmpty = true;
  }
  const ok = counts(validate(sample)) === false && refusedEmpty;
  return { ok, detail: ok ? 'a prepared option never counts as an integration; an option without sketch or inventory is refused' : 'a prepared option was counted as an integration or an empty one was accepted' };
});

/**
 * COM-13-5: regulated roles are assessed by rights and obligations, never
 * excluded by category. Every opening with a capital structure is assessed by
 * the one role reader; none may be excluded by category, economics count only
 * where a compliant position (its own or a licensed partner's) is established,
 * and at least one assessed opening must be a regulated role — "nothing to look
 * at" is not a demonstration (§39). Adopted from the compliance campaign's own
 * reading of the rows, and held here so later campaigns cannot change it.
 */
define('r01.com-13-5', async () => {
  const exclusions = (await import('../../cash/exclusions.ts')) as unknown as Record<string, unknown>;
  const assess = exclusions.assessOpportunityRole as ((input: { projectId: string; opportunityId: string }) => Promise<{
    excluded: unknown; regulated: boolean; countEconomics: boolean; position: string;
  }>) | undefined;
  if (!assess) return { ok: false, detail: 'the role reader is not deployed in this Brain' };
  const openings = await getDb().all<{ project_id: string; opportunity_id: string }>(
    `SELECT DISTINCT project_id, opportunity_id FROM capital_structures ORDER BY project_id, opportunity_id`,
  );
  // No opening yet is not a defect a repair can fix: UNKNOWN, asked again (§39: never a pass on nothing).
  if (openings.length === 0) return { ok: null, detail: 'no capital_structures rows: no role to assess on production records' };
  let regulated = 0;
  for (const o of openings) {
    const a = await assess({ projectId: o.project_id, opportunityId: o.opportunity_id });
    if (a.excluded !== false) return { ok: false, detail: `opening ${o.opportunity_id} was excluded by category` };
    const compliant = a.position === 'COMPLIANT' || a.position === 'COMPLIANT_VIA_PARTNER';
    if (a.countEconomics !== compliant) return { ok: false, detail: `opening ${o.opportunity_id}: economics counted=${a.countEconomics} with position ${a.position}` };
    if (a.regulated) regulated += 1;
  }
  return regulated > 0
    ? { ok: true, detail: `${regulated} of ${openings.length} opening(s) are regulated roles, all assessed by rights and none excluded by category` }
    : // Not yet demonstrated is UNKNOWN, never a FAIL that reopens the requirement into a repair nobody can make.
      { ok: null, detail: `${openings.length} opening(s) read; none performs a regulated activity, so the behaviour is not yet demonstrated` };
});

/*
 * Release 01 goal probes (GOAL-02, GOAL-09, OPP-04), written by the goals
 * campaign and adopted here after review: their files live under this
 * protected directory, so the campaign that is judged by them can no longer
 * change them. Loaded lazily so this module stays free of import cycles.
 */
async function releaseOne<T>(file: string, pick: (m: T) => Probe): Promise<Probe> {
  return pick((await import(file)) as T);
}
define('r01.goal-02', async (args) => (await releaseOne<typeof import('./release01/metricProbe.ts')>('./release01/metricProbe.ts', (m) => m.goalTwoHoldsOnRows))(args));
define('r01.goal-09', async (args) => (await releaseOne<typeof import('./release01/acceptanceProbe.ts')>('./release01/acceptanceProbe.ts', (m) => m.goalAcceptanceHoldsOnRows))(args));
define('r01.opp-04', async (args) => (await releaseOne<typeof import('./release01/pathwaysProbe.ts')>('./release01/pathwaysProbe.ts', (m) => m.opportunityPathsMarkedOnRows))(args));
define('r01.auth-20-3', async (args) => (await releaseOne<typeof import('./release01/authorityProbe.ts')>('./release01/authorityProbe.ts', (m) => m.graduatedAuthorityHoldsOnRows))(args));
define('r01.auth-21-6', async (args) => (await releaseOne<typeof import('./release01/authorityProbe.ts')>('./release01/authorityProbe.ts', (m) => m.readOnlyNeverActsOnRows))(args));
define('r01.auth-34', async (args) => (await releaseOne<typeof import('./release01/authorityProbe.ts')>('./release01/authorityProbe.ts', (m) => m.policyToActionHoldsOnRows))(args));
define('r01.auto-20-1', async (args) => (await releaseOne<typeof import('./release01/autonomyProbe.ts')>('./release01/autonomyProbe.ts', (m) => m.originationHoldsOnRows))(args));
define('r01.auto-20-2', async (args) => (await releaseOne<typeof import('./release01/autonomyProbe.ts')>('./release01/autonomyProbe.ts', (m) => m.gapLoopHoldsOnRows))(args));
define('r01.auto-20-4', async (args) => (await releaseOne<typeof import('./release01/autonomyProbe.ts')>('./release01/autonomyProbe.ts', (m) => m.gapMeasuresHoldOnRows))(args));
/*
 * ACQ-21-1, ACQ-21-2, ACQ-21-5, CONT-35 and LEARN-15-1: the acquisition,
 * browser-operator, continuity and model-learning campaigns shipped the
 * behaviour, and a campaign does not register its own judge, so these read
 * the rows that behaviour writes (release01/acquisitionProbe.ts,
 * release01/continuityProbe.ts).
 */
define('r01.acq-21-1', async () => (await import('./release01/acquisitionProbe.ts')).separateCapabilitiesOnRows());
define('r01.acq-21-2', async () => (await import('./release01/acquisitionProbe.ts')).methodSelectionOnRows());
define('r01.acq-21-5', async () => (await import('./release01/acquisitionProbe.ts')).browserCapabilitiesOnRows());
define('r01.cont-35', async () => (await import('./release01/continuityProbe.ts')).continuityOnRows());
define('r01.learn-15-1', async () => (await import('./release01/continuityProbe.ts')).ledgerOnRows());
/* GOV-11 and GOV-22-1, for factory-program-d0-p1 (release01/governanceProbe.ts). */
define('r01.gov-11', async () => (await import('./release01/governanceProbe.ts')).registerHoldsOnProduction());
define('r01.gov-22-1', async () => (await import('./release01/governanceProbe.ts')).promotionOnRows());
/**
 * CAP-16-3 is both halves: throughput restored first, and every stage measured
 * (release01/capacityProbe.ts). A throughput failure answers first; otherwise
 * the stage reading decides, with both details stated.
 */
define('r01.cap-16-3', async (args) => {
  const throughput = await throughputRestored(args);
  if (throughput.ok !== true) return throughput;
  const stages = await (await releaseOne<typeof import('./release01/capacityProbe.ts')>('./release01/capacityProbe.ts', (m) => m.stageCapacityHoldsOnRows))(args);
  return { ok: stages.ok, detail: `throughput: ${throughput.detail}; stages: ${stages.detail}` };
});
define('r01.life-29-1', async (args) => (await releaseOne<typeof import('../../cash/deliverables/lifecycleProbes.ts')>('../../cash/deliverables/lifecycleProbes.ts', (m) => m.commitmentsHoldOnRows))(args));
define('r01.life-29-2', async (args) => (await releaseOne<typeof import('../../cash/deliverables/lifecycleProbes.ts')>('../../cash/deliverables/lifecycleProbes.ts', (m) => m.realizationHoldsOnRows))(args));
define('r01.life-29-3', async (args) => (await releaseOne<typeof import('../../cash/deliverables/lifecycleProbes.ts')>('../../cash/deliverables/lifecycleProbes.ts', (m) => m.exceptionsHoldOnRows))(args));
define('r01.tel-07-1', async () => (await import('../../cash/telemetryProbe.ts')).telemetryHoldsOnRows());
define('r01.money-13-4', async () => (await import('./release01/moneyProbe.ts')).moneyVelocityHoldsOnRows());
define('r01.gov-17-3', async () => {
  const { BRAIN_REVISION } = await import('../../../env.ts');
  return (await import('./releaseEvaluation.ts')).releaseEvaluationHoldsOnRows(BRAIN_REVISION);
});

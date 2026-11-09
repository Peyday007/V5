/**
 * The program coordinator: one approved specification carried across many
 * campaigns to a production-verified DONE, using only machinery that already
 * existed for one campaign.
 *
 *   submit   — store the source verbatim, judge the proposed map against it,
 *              derive the plan and judge that the plan covers the map.
 *   approve  — a person approves the whole program once; that approval is what
 *              every campaign it later queues carries (the line's own rule:
 *              Brain decides *when* approved work starts, never *whether*).
 *   tick     — read every campaign's existing outcome; verify integrated
 *              requirements on production; open (or resume) the smallest repair
 *              for the earliest failure; queue every campaign whose dependencies
 *              are live. Idempotent by rows, so a tick that dies, a restart, or a
 *              second process running the same tick changes nothing twice.
 *
 * Each campaign is an ordinary change request: admitted by `line.ts` against
 * capacity and file ownership, planned, implemented, integrated, reviewed and
 * repaired by the remote loop, released by the release gate. The program never
 * runs a unit, never reviews, never merges.
 */
import type {
  CampaignProgress,
  FactoryProgram,
  PlannedCampaign,
  ProgramPlan,
  ProgramReading,
  ProgramValidation,
  RequirementCheck,
  RequirementMap,
  RequirementVerification,
} from '../../../domain/factoryProgram.ts';
import { MAX_REPAIR_EPISODES } from '../../../domain/factoryProgram.ts';
import type { LiveCheck } from '../../../domain/factoryRelease.ts';
import {
  addDiscoveredDependency,
  appendAmendment,
  ensureProgram,
  getMap,
  getPlan,
  getProgram,
  insertMapVersion,
  insertPlanVersion,
  linkCampaign,
  listCampaignLinks,
  listDiscoveredDependencies,
  listPrograms,
  listVerifications,
  markProgramApproved,
  recordVerification,
} from '../../../repos/factoryProgram.ts';
import { recordFactoryEvent } from '../../../repos/factoryFleet.ts';
import { edgesOf, findCycle, parseRequirementMap, validateRequirementMap } from './map.ts';
import { widenScope, campaignIsPrepared, campaignLinePriority, deriveProgramPlan, eligibleCampaigns, promotedRequirements, validateProgramPlan } from './plan.ts';
import { extractSourceItems, itemsMovedBy, programSource, sha256 } from './spec.ts';
import { deriveProgramReading, repairTargets, type StatusInput } from './status.ts';

export class ProgramError extends Error {}

export const PROGRAM_EVENT_KINDS = {
  submitted: 'PROGRAM_SUBMITTED',
  mapRefused: 'PROGRAM_MAP_REFUSED',
  planned: 'PROGRAM_PLANNED',
  approved: 'PROGRAM_APPROVED',
  campaignQueued: 'PROGRAM_CAMPAIGN_QUEUED',
  campaignRefused: 'PROGRAM_CAMPAIGN_REFUSED',
  verified: 'PROGRAM_REQUIREMENT_VERIFIED',
  reopened: 'PROGRAM_REQUIREMENT_REOPENED',
  repairOpened: 'PROGRAM_REPAIR_OPENED',
  replanned: 'PROGRAM_REPLANNED',
  done: 'PROGRAM_DONE',
  amended: 'PROGRAM_AMENDED',
} as const;

/* ------------------------------------------------------------------------- */
/* Ports: the existing machinery, injectable so the coordinator is testable   */
/* ------------------------------------------------------------------------- */

export interface CampaignSubmission {
  projectId: string;
  submissionKey: string;
  objective: string;
  expectedOutcome: string;
  nonGoals: string[];
  acceptanceConditions: Array<{ statement: string; verification: string }>;
  mutationScope: string[];
  repository: string;
  baseBranch: string;
}

export interface ProgramPorts {
  /** Submit (idempotently) one change request; returns its id and risk class. */
  submit(input: CampaignSubmission): Promise<{ changeRequestId: string; riskClass: string }>;
  /** Approve as the program's approver and put it in the line. Idempotent. */
  queue(input: { changeRequestId: string; projectId: string; userId: string; priority: number }): Promise<void>;
  /** Grant automatic release with these live checks. Idempotent. */
  authorizeRelease(input: { changeRequestId: string; userId: string; liveChecks: LiveCheck[]; reason: string }): Promise<void>;
  /**
   * Add paths to a submitted campaign's contract scope, as the program's approver,
   * through the contract's own amendment (recorded with both values). Optional:
   * a port without it leaves submitted scopes as they are.
   */
  extendScope?(input: { changeRequestId: string; add: string[]; userId: string; reason: string }): Promise<void>;
  /** The risk class the contract derived for a change request. */
  riskOf(changeRequestId: string): Promise<string | null>;
  /** What one change request has become, read from the existing campaign rows. */
  progressOf(changeRequestId: string): Promise<Omit<CampaignProgress, 'key'>>;
  /** Run a requirement's checks inside the released Brain. */
  verify(checks: RequirementCheck[]): Promise<{ revision: string | null; checks: RequirementVerification['checks'] }>;
  /** The revision production is running now, or null when this process is not a released Brain. */
  revision(): string | null;
  now(): Date;
}

/* ------------------------------------------------------------------------- */
/* Submission and approval                                                    */
/* ------------------------------------------------------------------------- */

export interface ProgramSubmissionResult {
  program: FactoryProgram;
  created: boolean;
  sourceItems: number;
  normativeItems: number;
  map: ProgramValidation;
  plan: (ProgramValidation & { coverage: Array<{ requirement: string; by: string }> }) | null;
  planned: ProgramPlan | null;
}

async function extraEdgesOf(programId: string): Promise<Map<string, string[]>> {
  const edges = new Map<string, string[]>();
  for (const dep of await listDiscoveredDependencies(programId)) {
    edges.set(dep.requirementKey, [...(edges.get(dep.requirementKey) ?? []), dep.dependsOn]);
  }
  return edges;
}

/**
 * Store a specification and judge a proposed map and plan against it.
 *
 * The source is stored even when the map is refused, so a refusal names line
 * numbers in the text the owner wrote rather than in a copy; the map and plan
 * are stored only when they pass, because an installed map with a hole in it
 * is the thing this whole module exists to prevent.
 */
export async function submitProgram(input: {
  projectId: string;
  title: string;
  sourceText: string;
  map: unknown;
  repository: string;
  baseBranch: string;
  submissionKey?: string;
  actorId?: string | null;
}): Promise<ProgramSubmissionResult> {
  if (input.sourceText.trim().length < 40) throw new ProgramError('A specification has to say something; this one is under 40 characters.');
  const sourceSha256 = sha256(input.sourceText);
  const items = extractSourceItems(input.sourceText);
  const { program, created } = await ensureProgram({
    projectId: input.projectId,
    submissionKey: input.submissionKey ?? `spec:${sourceSha256.slice(0, 24)}`,
    title: input.title.trim().slice(0, 200) || 'Untitled program',
    sourceText: input.sourceText,
    sourceSha256,
    repository: input.repository,
    baseBranch: input.baseBranch,
  });
  if (program.sourceSha256 !== sourceSha256) {
    throw new ProgramError(`Program ${program.id} already exists under this submission key with a different source; a source is never edited. Submit it under a new key.`);
  }
  if (created) {
    await recordFactoryEvent({
      kind: PROGRAM_EVENT_KINDS.submitted,
      evidenceClass: 'MEASURED',
      detail: { programId: program.id, sourceSha256, bytes: input.sourceText.length, items: items.length, normative: items.filter((i) => i.normative).length },
    });
  }
  const result = await proposeMap({ programId: program.id, map: input.map, actorType: 'FACTORY', actorId: input.actorId ?? null, reason: 'architect proposal' });
  return {
    program: (await getProgram(program.id))!,
    created,
    sourceItems: items.length,
    normativeItems: items.filter((i) => i.normative).length,
    map: result.map,
    plan: result.plan,
    planned: result.planned,
  };
}

/**
 * Install a map (and the plan derived from it), or refuse it whole.
 *
 * Before approval a proposal replaces the draft. After approval Factory may only
 * *add* — new requirements and new relationships — and every approved
 * requirement must survive with its meaning and its checks unchanged; only a
 * PERSON changes what was approved.
 */
export async function proposeMap(input: {
  programId: string;
  map: unknown;
  actorType: 'PERSON' | 'FACTORY';
  actorId: string | null;
  reason: string;
  /** Judge the revision as additive even though a person proposes it: an amendment adds, it never rewrites (§97). */
  additive?: boolean;
}): Promise<{ map: ProgramValidation; plan: ProgramSubmissionResult['plan']; planned: ProgramPlan | null; version: number | null }> {
  const program = await getProgram(input.programId);
  if (!program) throw new ProgramError('No such program.');
  if (program.state === 'WITHDRAWN') throw new ProgramError('This program was withdrawn.');
  const items = extractSourceItems(programSource(program));
  let parsed: RequirementMap;
  try {
    parsed = parseRequirementMap(input.map);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { map: { ok: false, errors: [{ code: 'NO_BEHAVIOR', subject: 'map', detail }], warnings: [] }, plan: null, planned: null, version: null };
  }
  const extraEdges = await extraEdgesOf(program.id);
  const approved = program.state === 'APPROVED' && (input.actorType === 'FACTORY' || input.additive) ? await getMap(program.id) : null;
  const mapValidation = validateRequirementMap(items, parsed, { previous: approved?.map ?? null, extraEdges });
  if (!mapValidation.ok) {
    await recordFactoryEvent({
      kind: PROGRAM_EVENT_KINDS.mapRefused,
      evidenceClass: 'MEASURED',
      detail: { programId: program.id, errors: mapValidation.errors.slice(0, 30), errorCount: mapValidation.errors.length },
    });
    return { map: mapValidation, plan: null, planned: null, version: null };
  }
  const current = await getPlan(program.id);
  const links = await listCampaignLinks(program.id);
  const started = new Set(links.map((l) => l.campaignKey));
  const keep = (current?.plan.campaigns ?? []).filter((c) => started.has(c.key) || c.kind !== 'BUILD');
  const planned = deriveProgramPlan(parsed, { extraEdges, keep });
  const planValidation = validateProgramPlan(parsed, planned, { extraEdges });
  if (!planValidation.ok) {
    await recordFactoryEvent({
      kind: PROGRAM_EVENT_KINDS.mapRefused,
      evidenceClass: 'MEASURED',
      detail: { programId: program.id, planErrors: planValidation.errors.slice(0, 30), errorCount: planValidation.errors.length },
    });
    return { map: mapValidation, plan: planValidation, planned, version: null };
  }
  const version = program.mapVersion + 1;
  await insertMapVersion({ programId: program.id, version, map: parsed, actorType: input.actorType, actorId: input.actorId, reason: input.reason });
  await insertPlanVersion({ programId: program.id, version: program.planVersion + 1, mapVersion: version, plan: planned, reason: `map v${version}: ${input.reason}` });
  await recordFactoryEvent({
    kind: PROGRAM_EVENT_KINDS.planned,
    evidenceClass: 'DERIVED',
    detail: {
      programId: program.id,
      mapVersion: version,
      requirements: parsed.requirements.length,
      campaigns: planned.campaigns.length,
      verifyOnly: planned.verifyOnly.length,
      serialized: planned.serialized.length,
    },
  });
  return { map: mapValidation, plan: planValidation, planned, version };
}

export async function approveProgram(input: { programId: string; userId: string; autoRelease: boolean }): Promise<{ ok: boolean; reason?: string; openQuestions: string[] }> {
  const program = await getProgram(input.programId);
  if (!program) throw new ProgramError('No such program.');
  const map = await getMap(program.id);
  const plan = await getPlan(program.id);
  if (!map || !plan) return { ok: false, reason: 'The program has no validated map and plan; nothing would be approved.', openQuestions: [] };
  if (program.state === 'APPROVED') return { ok: true, reason: 'already approved', openQuestions: [] };
  if (program.state !== 'DRAFT') return { ok: false, reason: `The program is ${program.state}.`, openQuestions: [] };
  const openQuestions = map.map.requirements.flatMap((r) =>
    r.ambiguities.filter((a) => a.interpretation === null && !a.resolvedBy).map((a) => `${r.key}: ${a.question}`),
  );
  const moved = await markProgramApproved({ programId: program.id, userId: input.userId, autoRelease: input.autoRelease });
  await recordFactoryEvent({
    kind: PROGRAM_EVENT_KINDS.approved,
    evidenceClass: 'MEASURED',
    detail: {
      programId: program.id,
      userId: input.userId,
      autoRelease: input.autoRelease,
      mapVersion: map.version,
      planVersion: plan.version,
      openQuestions: openQuestions.length,
      // Proposed readings become the owner's here, and are listed so the record says which.
      acceptedInterpretations: map.map.requirements.flatMap((r) =>
        r.ambiguities.filter((a) => a.interpretation !== null).map((a) => ({ requirement: r.key, item: a.item, interpretation: a.interpretation })),
      ),
    },
  });
  return { ok: moved, openQuestions };
}

/**
 * Append a release to a program and map what it adds (§97).
 *
 * The release text is stored verbatim after everything before it, only if no
 * earlier item moves — so every requirement, campaign and verification already
 * recorded still points at the same words. The map that comes with it must
 * cover the release's normative items and keep every earlier requirement with
 * its meaning, checks and relationships unchanged (the additive gate Factory
 * revisions pass); started campaigns are kept, so nothing completed is redone.
 * The same text twice is one amendment. An amendment whose map is refused stays
 * recorded — the refusal names lines in the text the owner wrote — and the next
 * proposal for it is an ordinary `proposeMap`.
 */
export async function amendProgram(input: {
  programId: string;
  title: string;
  sourceText: string;
  map: unknown;
  actorType: 'PERSON' | 'FACTORY';
  actorId: string | null;
}): Promise<{
  amendment: { number: number; created: boolean; sourceSha256: string };
  newItems: number;
  newNormativeItems: number;
  map: ProgramValidation;
  plan: ProgramSubmissionResult['plan'];
  planned: ProgramPlan | null;
  version: number | null;
}> {
  const program = await getProgram(input.programId);
  if (!program) throw new ProgramError('No such program.');
  if (program.state === 'WITHDRAWN') throw new ProgramError('This program was withdrawn.');
  const text = input.sourceText.replace(/\s+$/, '');
  if (text.trim().length < 40) throw new ProgramError('A release has to say something; this one is under 40 characters.');
  const sourceSha256 = sha256(text);
  const before = extractSourceItems(programSource(program));
  const known = program.amendments.find((a) => a.sourceSha256 === sourceSha256);
  if (!known) {
    const after = extractSourceItems(programSource({ ...program, amendments: [...program.amendments, { sourceText: text }] }));
    const moved = itemsMovedBy(before, after);
    if (moved.length > 0) {
      throw new ProgramError(`Appending this release would change earlier items (${moved.slice(0, 5).join(', ')}${moved.length > 5 ? '…' : ''}); a release is appended after a blank line and must start with a heading.`);
    }
  }
  const { amendment, created } = await appendAmendment({
    programId: program.id,
    title: input.title.trim().slice(0, 200) || 'Release',
    sourceText: text,
    sourceSha256,
    actorType: input.actorType,
    actorId: input.actorId,
  });
  const all = extractSourceItems(programSource((await getProgram(program.id))!));
  const added = all.slice(before.length);
  if (created) {
    await recordFactoryEvent({
      kind: PROGRAM_EVENT_KINDS.amended,
      evidenceClass: 'MEASURED',
      detail: { programId: program.id, number: amendment.number, sourceSha256, bytes: text.length, items: added.length, normative: added.filter((i) => i.normative).length, actorType: input.actorType },
    });
  }
  const result = await proposeMap({
    programId: program.id,
    map: input.map,
    actorType: input.actorType,
    actorId: input.actorId,
    reason: `release ${amendment.number}: ${amendment.title}`,
    additive: true,
  });
  return {
    amendment: { number: amendment.number, created, sourceSha256 },
    newItems: created ? added.length : 0,
    newNormativeItems: created ? added.filter((i) => i.normative).length : 0,
    ...result,
  };
}

/**
 * Record a dependency an implementation exposed, and replan what has not started.
 *
 * Factory may add how the work is ordered; it may not change what is required.
 * A dependency that would close a cycle is refused. Campaigns already submitted
 * keep their requirements; only unstarted work is re-derived, and the new plan
 * passes the same coverage gate as the first.
 */
export async function recordDiscoveredDependency(input: {
  programId: string;
  requirementKey: string;
  dependsOn: string;
  reason: string;
  actorType: 'PERSON' | 'FACTORY';
  actorId: string | null;
}): Promise<{ ok: boolean; reason?: string; planVersion?: number }> {
  const program = await getProgram(input.programId);
  if (!program) throw new ProgramError('No such program.');
  const map = await getMap(program.id);
  if (!map) return { ok: false, reason: 'The program has no map.' };
  const keys = new Set(map.map.requirements.map((r) => r.key));
  if (!keys.has(input.requirementKey) || !keys.has(input.dependsOn)) return { ok: false, reason: 'Both requirements must be in the map.' };
  if (input.reason.trim().length < 8) return { ok: false, reason: 'A discovered dependency needs the reason it was discovered.' };
  const extra = await extraEdgesOf(program.id);
  extra.set(input.requirementKey, [...(extra.get(input.requirementKey) ?? []), input.dependsOn]);
  const graph = new Map(map.map.requirements.map((r) => [r.key, edgesOf(r, extra)]));
  const cycle = findCycle(graph);
  if (cycle) return { ok: false, reason: `That would make requirements wait for each other in a circle: ${cycle.join(' → ')}.` };
  await addDiscoveredDependency({ ...input });
  const current = await getPlan(program.id);
  const started = new Set((await listCampaignLinks(program.id)).map((l) => l.campaignKey));
  const keep = (current?.plan.campaigns ?? []).filter((c) => started.has(c.key) || c.kind !== 'BUILD');
  const planned = deriveProgramPlan(map.map, { extraEdges: extra, keep });
  const validation = validateProgramPlan(map.map, planned, { extraEdges: extra });
  if (!validation.ok) {
    return { ok: false, reason: `Replanning refused: ${validation.errors.slice(0, 3).map((e) => e.detail).join(' ')}` };
  }
  const version = (current?.version ?? 0) + 1;
  await insertPlanVersion({ programId: program.id, version, mapVersion: map.version, plan: planned, reason: `${input.requirementKey} depends on ${input.dependsOn}: ${input.reason}` });
  await recordFactoryEvent({
    kind: PROGRAM_EVENT_KINDS.replanned,
    evidenceClass: 'DERIVED',
    detail: { programId: program.id, planVersion: version, requirement: input.requirementKey, dependsOn: input.dependsOn, actorType: input.actorType },
  });
  return { ok: true, planVersion: version };
}

/* ------------------------------------------------------------------------- */
/* Reading                                                                    */
/* ------------------------------------------------------------------------- */

async function refusalsOf(programId: string): Promise<Map<string, string>> {
  const { listFactoryEvents } = await import('../../../repos/factoryFleet.ts');
  const refusals = new Map<string, string>();
  for (const event of await listFactoryEvents(null, { kinds: [PROGRAM_EVENT_KINDS.campaignRefused], limit: 2000 })) {
    const detail = event.detail as { programId?: string; campaign?: string; reason?: string };
    if (detail.programId === programId && detail.campaign) refusals.set(detail.campaign, detail.reason ?? 'refused');
  }
  return refusals;
}

async function statusInput(program: FactoryProgram, ports: Pick<ProgramPorts, 'progressOf'>): Promise<StatusInput & { links: Map<string, string>; refusals: Map<string, string> }> {
  const map = await getMap(program.id);
  const plan = await getPlan(program.id);
  const links = new Map((await listCampaignLinks(program.id)).map((l) => [l.campaignKey, l.changeRequestId]));
  const progress = new Map<string, CampaignProgress>();
  const refusals = await refusalsOf(program.id);
  for (const campaign of plan?.plan.campaigns ?? []) {
    const changeRequestId = links.get(campaign.key) ?? null;
    if (!changeRequestId) {
      const refused = refusals.get(campaign.key) ?? null;
      progress.set(campaign.key, { key: campaign.key, changeRequestId: null, campaignId: null, outcome: null, delivered: false, needsPerson: refused !== null, blocker: refused ? `the contract refused its submission: ${refused}` : null });
      continue;
    }
    progress.set(campaign.key, { key: campaign.key, ...(await ports.progressOf(changeRequestId)) });
  }
  return {
    programId: program.id,
    approved: program.state === 'APPROVED',
    map: map?.map ?? { requirements: [], context: [] },
    plan: plan?.plan ?? { campaigns: [], verifyOnly: [], serialized: [] },
    progress,
    verifications: await listVerifications(program.id),
    extraEdges: await extraEdgesOf(program.id),
    links,
    refusals,
  };
}

export async function readProgram(programId: string, ports: Pick<ProgramPorts, 'progressOf'>): Promise<ProgramReading & { program: FactoryProgram; plan: ProgramPlan; progress: CampaignProgress[] }> {
  const program = await getProgram(programId);
  if (!program) throw new ProgramError('No such program.');
  const input = await statusInput(program, ports);
  return { ...deriveProgramReading(input), program, plan: input.plan, progress: [...input.progress.values()] };
}

/* ------------------------------------------------------------------------- */
/* The tick                                                                   */
/* ------------------------------------------------------------------------- */

/** Verification is repeated at most this often for a requirement whose answer has not changed revision. */
export const REVERIFY_AFTER_MS = 15 * 60_000;

export interface ProgramTickReport {
  programId: string;
  verified: Array<{ requirement: string; outcome: string }>;
  repairs: Array<{ campaign: string; requirement: string; kind: string }>;
  queued: string[];
  refused: Array<{ campaign: string; reason: string }>;
  verdict: ProgramReading['verdict'];
  counts: ProgramReading['counts'];
}

export function campaignObjective(program: FactoryProgram, campaign: PlannedCampaign, map: RequirementMap): CampaignSubmission {
  const byKey = new Map(map.requirements.map((r) => [r.key, r]));
  const items = new Map(extractSourceItems(programSource(program)).map((i) => [i.id, i]));
  const requirements = campaign.implements.map((key) => byKey.get(key)!).filter(Boolean);
  const lines: string[] = [
    campaign.kind === 'BUILD'
      ? `Implement ${requirements.length} requirement(s) of program ${program.id} ("${program.title}").`
      : campaign.kind === 'REPAIR'
        ? `Repair requirement ${campaign.repairOf?.requirement} of program ${program.id}: it failed its checks after release (episode ${campaign.repairOf?.episode}). Find the earliest cause and fix it; do not change what the requirement means.`
        : `Structural review of requirement ${campaign.repairOf?.requirement} of program ${program.id}: ${MAX_REPAIR_EPISODES} repairs did not hold. Find the shared root cause across the failures below and change the structure that keeps producing it.`,
    'Each requirement below quotes the approved specification verbatim; the quote governs over any summary here, and its checks are fixed.',
  ];
  for (const r of requirements) {
    lines.push(
      '',
      `[${r.key}] ${r.title}`,
      `Source (${r.source.join(', ')}): ${r.source.map((id) => `"${items.get(id)?.text.replace(/\s+/g, ' ') ?? id}"`).join(' ')}`,
      `Behavior: ${r.behavior}`,
    );
    if (r.inputs.length) lines.push(`Inputs: ${r.inputs.join('; ')}`);
    if (r.outputs.length) lines.push(`Outputs: ${r.outputs.join('; ')}`);
    if (r.constraints.length) lines.push(`Constraints: ${r.constraints.join('; ')}`);
    if (r.existing) lines.push(`Existing: ${r.existing.paths.join(', ')} — ${r.existing.evidence}`);
    if (r.missingWork) lines.push(`Missing work: ${r.missingWork}`);
    const deps = edgesOf(r);
    if (deps.length) lines.push(`Works with (already live or in earlier campaigns): ${deps.join(', ')}`);
    for (const a of r.ambiguities) if (a.interpretation) lines.push(`Approved reading of ${a.item}: ${a.interpretation}`);
    lines.push(`Checks: ${r.verification.map(describeCheck).join(' | ')}`);
  }
  if (campaign.repairOf) lines.push('', `Failures: ${campaign.repairOf.failures.join(' | ')}`);
  lines.push('', `Tests: write this campaign's own regression tests in ${campaignTestPath(program, campaign)} (owned by this campaign alone).`);
  return {
    projectId: program.projectId,
    submissionKey: `program:${program.id}:${campaign.key}`,
    objective: lines.join('\n').slice(0, 12_000),
    expectedOutcome: `Every listed requirement behaves as stated and passes its own checks in the running Brain: ${campaign.implements.join(', ')}.`,
    nonGoals: ['Changing any requirement, its quoted source or its checks', 'Work for requirements of this program not listed here'],
    acceptanceConditions: requirements.map((r) => ({
      statement: `${r.key}: ${r.behavior}`.slice(0, 1_000),
      verification: r.verification.map(describeCheck).join(' AND ').slice(0, 1_000),
    })),
    mutationScope: [...widenScope(campaign.mutationScope), campaignTestPath(program, campaign)],
    repository: program.repository,
    baseBranch: program.baseBranch,
  };
}

/**
 * The test file a campaign owns beside its source scope. A campaign whose
 * scope named only source files could not add the regression test its own
 * review demanded (production 2026-11-09: quant-d0-p0's repair unit spent three
 * attempts refusing to write outside server/services/cash/funnel.ts). The path
 * is unique to the program and campaign, so it never makes two campaigns wait
 * on each other.
 */
export function campaignTestPath(program: Pick<FactoryProgram, 'id'>, campaign: Pick<PlannedCampaign, 'key'>): string {
  return `tests/program-${program.id.replace(/^fpg_/, '').slice(0, 8)}-${campaign.key}*.test.ts`;
}

export function describeCheck(check: RequirementCheck): string {
  if (check.kind === 'HTTP') return `GET ${check.path} answers ${check.expectStatus}${check.expectText ? ` containing "${check.expectText}"` : ''}`;
  if (check.kind === 'BUNDLE_TEXT') return `the served client bundle contains "${check.text}"`;
  return `probe ${check.probe}(${JSON.stringify(check.args ?? {})}) passes`;
}

function liveChecksOf(campaign: PlannedCampaign, map: RequirementMap): LiveCheck[] {
  const checks: LiveCheck[] = [];
  for (const key of campaign.implements) {
    const r = map.requirements.find((x) => x.key === key);
    for (const check of r?.verification ?? []) {
      if (check.kind === 'HTTP') checks.push({ kind: 'HTTP', path: check.path, expectStatus: check.expectStatus, ...(check.expectText ? { expectText: check.expectText } : {}) });
      if (check.kind === 'BUNDLE_TEXT') checks.push({ kind: 'BUNDLE_TEXT', text: check.text });
    }
  }
  return checks.slice(0, 10);
}

/**
 * One pass over one program. Safe to run concurrently with itself and after any
 * interruption: every write is keyed (submission key, campaign link, queue
 * entry, grant, plan version) and every read is of rows.
 */
export async function tickProgram(programId: string, ports: ProgramPorts): Promise<ProgramTickReport> {
  const program = await getProgram(programId);
  if (!program) throw new ProgramError('No such program.');
  const report: ProgramTickReport = { programId, verified: [], repairs: [], queued: [], refused: [], verdict: 'NOT_DONE', counts: {} as ProgramReading['counts'] };
  if (program.state !== 'APPROVED' || !program.approvedByUserId) {
    const reading = deriveProgramReading(await statusInput(program, ports));
    return { ...report, verdict: reading.verdict, counts: reading.counts };
  }
  let input = await statusInput(program, ports);
  const now = ports.now();

  // 1. Verify on production whatever is integrated and not already answered at this revision.
  let reading = deriveProgramReading(input);
  const latest = new Map<string, RequirementVerification>();
  for (const v of input.verifications) {
    const known = latest.get(v.requirementKey);
    if (!known || known.at <= v.at) latest.set(v.requirementKey, v);
  }
  const revision = ports.revision();
  for (const requirement of reading.requirements) {
    const due = requirement.status === 'INTEGRATED' || requirement.status === 'PRODUCTION_VERIFIED' || requirement.status === 'NOT_DONE';
    if (!due) continue;
    // A reopened requirement is asked again at every new revision, not only once
    // its repair is live: a failure read wrongly (program fpg_2adb7f5e, 2026-11-09:
    // a spent forge budget read as a missing file) then clears itself, and the
    // repair it opened stops mattering. One answer per revision bounds the cost.
    // One answer per revision: a definite answer stands until production changes;
    // an UNKNOWN is asked again after a while.
    const last = latest.get(requirement.key);
    if (last && last.revision === revision) {
      if (last.outcome !== 'UNKNOWN') continue;
      if (now.getTime() - Date.parse(last.at) < REVERIFY_AFTER_MS) continue;
    }
    const def = input.map.requirements.find((r) => r.key === requirement.key)!;
    const result = await ports.verify(def.verification);
    const outcome = result.revision === null || result.checks.some((c) => c.ok === null)
      ? 'UNKNOWN'
      : result.checks.every((c) => c.ok === true) ? 'PASS' : 'FAIL';
    const recorded = await recordVerification({ programId, requirementKey: requirement.key, outcome, revision: result.revision, checks: result.checks, at: now.toISOString() });
    report.verified.push({ requirement: requirement.key, outcome });
    if (outcome === 'FAIL' && last?.outcome !== 'FAIL') {
      await recordFactoryEvent({ kind: PROGRAM_EVENT_KINDS.reopened, evidenceClass: 'MEASURED', detail: { programId, requirement: requirement.key, revision: result.revision, verificationId: recorded.id } });
    } else if (outcome === 'PASS' && last?.outcome !== 'PASS') {
      await recordFactoryEvent({ kind: PROGRAM_EVENT_KINDS.verified, evidenceClass: 'MEASURED', detail: { programId, requirement: requirement.key, revision: result.revision, verificationId: recorded.id } });
    }
  }
  input = await statusInput(program, ports);

  // 2. Repair the earliest failures, smallest first; resume rather than duplicate.
  const targets = repairTargets(input);
  if (targets.length > 0) {
    const current = await getPlan(programId);
    const plan: ProgramPlan = current ? structuredClone(current.plan) : { campaigns: [], verifyOnly: [], serialized: [] };
    let changed = false;
    for (const target of targets) {
      // Exhausted: the requirement reads BLOCKED; no further campaign is opened.
      if (target.kind === 'EXHAUSTED') continue;
      const requirement = input.map.requirements.find((r) => r.key === target.requirement)!;
      const key = `${target.kind === 'STRUCTURAL' ? 'structural' : 'repair'}-${target.requirement.toLowerCase()}-${target.episode}`;
      if (plan.campaigns.some((c) => c.key === key)) continue;
      plan.campaigns.push({
        key,
        kind: target.kind,
        title: `${target.kind === 'STRUCTURAL' ? 'Structural fix' : 'Repair'}: ${target.requirement} (episode ${target.episode})`,
        subsystem: requirement.subsystem,
        implements: [target.requirement],
        dependsOn: [],
        mutationScope: [...new Set([...requirement.paths, ...(requirement.existing?.paths ?? [])])].sort(),
        repairOf: { requirement: target.requirement, episode: target.episode, failures: target.failures },
      });
      report.repairs.push({ campaign: key, requirement: target.requirement, kind: target.kind });
      changed = true;
      await recordFactoryEvent({
        kind: PROGRAM_EVENT_KINDS.repairOpened,
        evidenceClass: 'DERIVED',
        detail: { programId, campaign: key, requirement: target.requirement, episode: target.episode, kind: target.kind, affected: target.affected },
      });
    }
    if (changed && current) {
      await insertPlanVersion({ programId, version: current.version + 1, mapVersion: current.mapVersion, plan, reason: `repairs: ${report.repairs.map((r) => r.campaign).join(', ')}` });
      input = await statusInput(program, ports);
    }
  }

  // 3. Start every campaign whose dependencies are live. Independent ones start together;
  //    the line decides when each is admitted against capacity and file ownership.
  const finished = new Set([...input.progress].filter(([, p]) => p.outcome === 'LIVE').map(([k]) => k));
  const started = new Set(input.links.keys());
  const repairing = new Set(input.plan.campaigns.filter((c) => c.kind !== 'BUILD').map((c) => c.key));
  const ambiguous = (campaign: PlannedCampaign): boolean =>
    campaign.implements.some((key) => input.map.requirements.find((x) => x.key === key)?.ambiguities.some((a) => a.interpretation === null && !a.resolvedBy));
  const queueAndGrant = async (campaign: PlannedCampaign, changeRequestId: string, riskClass: string | null): Promise<void> => {
    await ports.queue({ changeRequestId, projectId: program.projectId, userId: program.approvedByUserId!, priority: repairing.has(campaign.key) ? 1 : campaignLinePriority(input.map, campaign) });
    if (program.autoRelease && (riskClass ?? (await ports.riskOf(changeRequestId))) === 'LOW') {
      await ports.authorizeRelease({
        changeRequestId,
        userId: program.approvedByUserId!,
        liveChecks: liveChecksOf(campaign, input.map),
        reason: `Program ${program.id} was approved with automatic release of its LOW-risk campaigns.`,
      });
    }
  };
  // A linked campaign whose queue step was interrupted is completed now, not forgotten.
  for (const campaign of input.plan.campaigns) {
    const changeRequestId = input.links.get(campaign.key);
    if (changeRequestId && input.progress.get(campaign.key)?.campaignId === null) await queueAndGrant(campaign, changeRequestId, null);
  }
  // Campaigns submitted before they owned a test file get theirs (idempotent: the port adds only what is missing).
  if (ports.extendScope) {
    for (const campaign of input.plan.campaigns) {
      const changeRequestId = input.links.get(campaign.key);
      if (!changeRequestId || input.progress.get(campaign.key)?.outcome === 'LIVE') continue;
      try {
        await ports.extendScope({
          changeRequestId,
          add: [campaignTestPath(program, campaign)],
          userId: program.approvedByUserId!,
          reason: `Program ${program.id}: every campaign owns its own test file, so a review that asks for a regression test can be satisfied.`,
        });
      } catch {
        // Refused or unreachable: the next tick asks again; the campaign is unchanged.
      }
    }
  }
  // Most urgent first; a prepared capability waits until a live requirement needs it.
  const promoted = promotedRequirements(input.map, input.extraEdges);
  const waiting = (campaign: PlannedCampaign): boolean =>
    campaignIsPrepared(input.map, campaign) && !campaign.implements.some((key) => promoted.has(key));
  const eligible = eligibleCampaigns(input.plan, finished, started)
    .filter((campaign) => !waiting(campaign))
    .sort((a, b) => campaignLinePriority(input.map, a) - campaignLinePriority(input.map, b) || a.key.localeCompare(b.key));
  for (const campaign of eligible) {
    if (ambiguous(campaign)) continue;
    let submitted: { changeRequestId: string; riskClass: string };
    try {
      submitted = await ports.submit(campaignObjective(program, campaign, input.map));
    } catch (error) {
      // The contract refused it (a scope outside the project's boundary, say). Said on
      // the program once per reason, and retried each tick in case a person widened it.
      const reason = error instanceof Error ? error.message.slice(0, 500) : String(error);
      report.refused.push({ campaign: campaign.key, reason });
      if (input.refusals.get(campaign.key) !== reason) {
        await recordFactoryEvent({ kind: PROGRAM_EVENT_KINDS.campaignRefused, evidenceClass: 'MEASURED', detail: { programId, campaign: campaign.key, reason } });
      }
      continue;
    }
    const { changeRequestId, riskClass } = submitted;
    const plan = await getPlan(programId);
    await linkCampaign({ programId, campaignKey: campaign.key, changeRequestId, planVersion: plan?.version ?? 1 });
    await queueAndGrant(campaign, changeRequestId, riskClass);
    report.queued.push(campaign.key);
    await recordFactoryEvent({ kind: PROGRAM_EVENT_KINDS.campaignQueued, evidenceClass: 'MEASURED', detail: { programId, campaign: campaign.key, changeRequestId, implements: campaign.implements, riskClass } });
  }

  input = await statusInput(program, ports);
  reading = deriveProgramReading(input);
  if (reading.verdict === 'DONE') {
    const { listFactoryEvents } = await import('../../../repos/factoryFleet.ts');
    const done = (await listFactoryEvents(null, { kinds: [PROGRAM_EVENT_KINDS.done], limit: 500 })).some((e) => (e.detail as { programId?: string }).programId === programId);
    if (!done) await recordFactoryEvent({ kind: PROGRAM_EVENT_KINDS.done, evidenceClass: 'MEASURED', detail: { programId, requirements: reading.requirements.length } });
  }
  return { ...report, verdict: reading.verdict, counts: reading.counts };
}

/** Tick every approved program. One program's failure never stops another's. */
export async function tickAllPrograms(ports: ProgramPorts): Promise<ProgramTickReport[]> {
  const reports: ProgramTickReport[] = [];
  for (const program of await listPrograms(['APPROVED'])) {
    try {
      reports.push(await tickProgram(program.id, ports));
    } catch {
      // The next pass reads the same rows.
    }
  }
  return reports;
}

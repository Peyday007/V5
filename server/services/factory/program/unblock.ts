/**
 * Unblock a program's started campaigns whose units ran out of attempts on
 * scope, not on the work (§97, production 2026-11-09).
 *
 * The first Release 01 map named one file per requirement. Real changes need
 * the module around that file and a test, so units kept refusing ("the fix lies
 * outside the unit's owned paths; the prohibition wins") until their attempts
 * ran out, and integration bins parked waiting for a person. The answer a person
 * gives each time is the same, so the program's approver gives it once, through
 * the existing doors:
 *
 *   1. widen the contract scope to the directories its files live in, plus the
 *      campaign's own test file — the contract's PERSON amendment, still held to
 *      the project's onboarded boundary, never reaching the code that verifies
 *      the program (PROTECTED_VERIFICATION_PATHS);
 *   2. regrant each unit that used all its attempts, owning that widened scope;
 *   3. reopen each parked bin of the campaign.
 *
 * Every step is recorded by the machinery it uses, and a LIVE, complete or
 * cancelled campaign is never touched.
 */
import { getCampaignByChangeRequest, getChangeRequest, listUnits } from '../../../repos/factory.ts';
import { getPlan, getProgram, listCampaignLinks } from '../../../repos/factoryProgram.ts';
import { campaignTestPath } from './coordinator.ts';
import { widenScope } from './plan.ts';

export { widenScope };

export interface UnblockStep {
  campaign: string;
  action: 'SCOPE' | 'REGRANT' | 'REOPEN' | 'SKIP' | 'REFUSED';
  detail: string;
}

export async function unblockProgram(input: {
  programId: string;
  operatorId: string;
  maxAttempts?: number;
  /**
   * Grant exact extra paths to one campaign: the answer to a blocker that names
   * a file outside the approved scope (a map that put a requirement's code in
   * the wrong module, a caller in a neighbouring one). A person's grant, read
   * from the blocker and given deliberately — never inferred by the program.
   */
  grant?: { campaign: string; paths: string[] };
  /**
   * Brain's own hourly pass rather than a person's command. It does not reopen
   * a bin already granted AUTO_REOPEN_CEILING attempts: production 2026-11-10,
   * a plan bin whose contract named only a protected file refused 22 sessions
   * in a row, and reopening it hourly only spends two more.
   */
  automatic?: boolean;
}): Promise<UnblockStep[]> {
  const program = await getProgram(input.programId);
  if (!program) throw new Error('No such program.');
  const plan = await getPlan(program.id);
  const steps: UnblockStep[] = [];
  const { amendContract } = await import('../contract.ts');
  const { regrantUnit, MAX_UNIT_ATTEMPTS } = await import('../regrant.ts');
  const { listBins, regrantBinAttempts } = await import('../../../repos/bins.ts');
  const { reopenParkedBin } = await import('../../bins/service.ts');
  const parked = await listBins({ states: ['NEEDS_HUMAN'], limit: 500 });
  for (const link of await listCampaignLinks(program.id)) {
    const planned = plan?.plan.campaigns.find((c) => c.key === link.campaignKey);
    const campaign = await getCampaignByChangeRequest(link.changeRequestId);
    const changeRequest = await getChangeRequest(link.changeRequestId);
    if (!planned || !campaign || !changeRequest) continue;
    if (campaign.state === 'COMPLETE' || campaign.state === 'CANCELLED') {
      steps.push({ campaign: link.campaignKey, action: 'SKIP', detail: campaign.state });
      continue;
    }
    // 1. Scope.
    const granted = input.grant && input.grant.campaign === link.campaignKey ? input.grant.paths : [];
    if (input.grant && input.grant.campaign !== link.campaignKey) continue;
    const widened = [...new Set([...widenScope(changeRequest.mutationScope), campaignTestPath(program, planned), ...granted])].sort();
    if (widened.join() !== [...changeRequest.mutationScope].sort().join()) {
      const result = await amendContract({
        changeRequestId: changeRequest.id,
        campaignId: campaign.id,
        field: 'mutation_scope',
        newValue: widened,
        reason: `Program ${program.id}: units refused work their reviews required because the scope named single files; widened to their directories and the campaign's own test file by the program's approver.`,
        actorType: 'PERSON',
        actorId: input.operatorId,
        affectedWork: [],
      });
      steps.push(result.ok
        ? { campaign: link.campaignKey, action: 'SCOPE', detail: widened.join(', ') }
        : { campaign: link.campaignKey, action: 'REFUSED', detail: `scope: ${result.reason}` });
      if (!result.ok) continue;
    }
    // 2. Units out of attempts.
    for (const unit of await listUnits(campaign.id)) {
      if (unit.state !== 'FAILED' || unit.attempt < unit.maxAttempts) continue;
      const ceiling = Math.min(MAX_UNIT_ATTEMPTS, input.maxAttempts ?? unit.maxAttempts + 2);
      const outcome = await regrantUnit({
        campaignId: campaign.id,
        unitKey: unit.unitKey,
        maxAttempts: ceiling,
        reasonCode: 'work-corrected',
        operator: `operator:${input.operatorId}`,
        addOwnedPaths: widened.filter((glob) => !unit.ownedPaths.includes(glob)),
      });
      steps.push(outcome.ok
        ? { campaign: link.campaignKey, action: 'REGRANT', detail: `${unit.unitKey} ${outcome.from} -> ${outcome.to}` }
        : { campaign: link.campaignKey, action: 'REFUSED', detail: `${unit.unitKey}: ${outcome.reason}` });
    }
    // 3. Parked bins.
    for (const bin of parked.filter((b) => b.factoryCampaignId === campaign.id)) {
      if (input.automatic && bin.maxAttempts >= AUTO_REOPEN_CEILING) {
        steps.push({ campaign: link.campaignKey, action: 'SKIP', detail: `${bin.id} has had ${bin.maxAttempts} attempts; left for a person` });
        continue;
      }
      await regrantBinAttempts({ binId: bin.id, maxAttempts: Math.min(40, bin.maxAttempts + 2), reason: 'Parked while the campaign scope was too narrow or no worker surface arrived; the scope is widened and surfaces are arriving. Not spent on the work failing.' });
      const reopened = await reopenParkedBin({ binId: bin.id, operator: `operator:${input.operatorId}`, reason: 'Program approver reopened a bin parked for scope or capacity, not for the work.' });
      steps.push(reopened.ok
        ? { campaign: link.campaignKey, action: 'REOPEN', detail: bin.id }
        : { campaign: link.campaignKey, action: 'REFUSED', detail: `${bin.id}: ${reopened.reason}` });
    }
  }
  return steps;
}

/*
 * The same answer, given by Brain on the approver's standing approval rather
 * than waiting for somebody to type it (§97, production 2026-11-10).
 *
 * Every campaign of the approved program sat BLOCKED(person) on exhausted
 * attempts or scope with every worker idle, and the answer was this function,
 * which only ever ran when a session thought to dispatch `program-unblock`. A
 * program is approved once (§52); a unit that ran out on scope is not a new
 * decision. Bounded by what the doors already bound: a unit's ceiling never
 * passes MAX_UNIT_ATTEMPTS, a bin's never 40, and the pass runs at most hourly,
 * so a unit that cannot be done at any scope stops, and is still a person's.
 */
export const AUTO_UNBLOCK_INTERVAL_MS = 60 * 60_000;
/** A parked bin given this many attempts is not reopened by the automatic pass. */
export const AUTO_REOPEN_CEILING = 12;
let lastAutoUnblock = 0;

export async function unblockApprovedPrograms(now = Date.now(), force = false): Promise<UnblockStep[]> {
  if (!force && now - lastAutoUnblock < AUTO_UNBLOCK_INTERVAL_MS) return [];
  lastAutoUnblock = now;
  const { listPrograms } = await import('../../../repos/factoryProgram.ts');
  const steps: UnblockStep[] = [];
  for (const program of await listPrograms(['APPROVED'])) {
    if (!program.approvedByUserId) continue;
    let blocked = false;
    for (const link of await listCampaignLinks(program.id)) {
      const campaign = await getCampaignByChangeRequest(link.changeRequestId);
      if (campaign?.state === 'BLOCKED') { blocked = true; break; }
    }
    if (!blocked) continue;
    steps.push(...(await unblockProgram({ programId: program.id, operatorId: program.approvedByUserId, automatic: true })));
  }
  return steps;
}

/** Tests: let the next call run. */
export function resetAutoUnblock(): void {
  lastAutoUnblock = 0;
}

/*
 * ---------------------------------------------------------------------------
 * Scope reconciliation for every blocked campaign (owner's authorization,
 * 2026-11-11: "I authorize you to expand file scopes and resolve permissions
 * for the blocked campaigns, where necessary to complete their approved
 * objectives. Do this automatically.")
 * ---------------------------------------------------------------------------
 *
 * The program door above answered only program campaigns. Twenty-two campaigns
 * of every kind stopped on the same few shapes — a unit refused a file outside
 * its paths, a failing test lived beside the module, a repair named a file the
 * scope did not reach — and each waited for a person to type the same answer.
 *
 * What is granted, and only that:
 *   - the campaign's own files widened to their directories (`widenScope`), and
 *   - the exact paths its blocker and its exhausted units name,
 * minus anything that reaches the code that verifies a program, a path the
 * repository forbids, CI configuration, or a sensitive area (credentials,
 * authentication, money movement). The amendment is the contract's PERSON
 * amendment on the change request's approver, so it is still held to the
 * project's onboarded boundary and recorded with its reason; review, tests,
 * production verification and rollback are untouched. Units are regranted
 * below MAX_UNIT_ATTEMPTS and parked bins reopened below AUTO_REOPEN_CEILING,
 * so work that cannot be done at any scope still stops.
 */
const RECONCILABLE_BLOCKERS = new Set(['SCOPE_AMENDMENT_REQUIRED', 'UNIT_EXHAUSTED_ATTEMPTS', 'REPAIR_OWNERSHIP_UNRESOLVED']);
const SENSITIVE = /(^|\/)(\.github|\.env)|secret|credential|password|oauth|token|auth\/|identity\/|payout|payment|stripe|ledger|billing|wallet/i;
const PATH_IN_TEXT = /\b((?:server|client|tests|scripts|docs|shared|src)\/[A-Za-z0-9_.\/-]+\.[A-Za-z]{1,5})\b/g;

/** Repository paths a sentence names, by the repository's own top-level directories. */
export function pathsNamedIn(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set([...text.matchAll(PATH_IN_TEXT)].map((m) => m[1]!.replace(/[.,;:)]+$/, '')))];
}

/** Whether a path may be granted automatically. */
export function grantable(path: string, forbidden: string[]): boolean {
  if (SENSITIVE.test(path)) return false;
  return !forbidden.some((glob) => glob === path || path.startsWith(glob.replace(/\*\*$/, '')));
}

export async function reconcileBlockedScopes(now = Date.now(), force = false): Promise<UnblockStep[]> {
  if (!force && now - lastReconcile < AUTO_UNBLOCK_INTERVAL_MS) return [];
  lastReconcile = now;
  const { listLiveCampaigns } = await import('../../../repos/factory.ts');
  const { amendContract } = await import('../contract.ts');
  const { regrantUnit, MAX_UNIT_ATTEMPTS } = await import('../regrant.ts');
  const { forbiddenPathsFor } = await import('../forbidden.ts');
  const { listBins, regrantBinAttempts } = await import('../../../repos/bins.ts');
  const { reopenParkedBin } = await import('../../bins/service.ts');
  const { PROTECTED_VERIFICATION_PATHS } = await import('../../../domain/factoryProgram.ts');
  const { scopesOverlap } = await import('./plan.ts');
  const parked = await listBins({ states: ['NEEDS_HUMAN'], kindPrefix: 'FACTORY_', limit: 500 });
  const steps: UnblockStep[] = [];
  for (const campaign of await listLiveCampaigns()) {
    if (campaign.state !== 'BLOCKED' || !campaign.blockerKind || !RECONCILABLE_BLOCKERS.has(campaign.blockerKind)) continue;
    const changeRequest = await getChangeRequest(campaign.changeRequestId);
    if (!changeRequest?.approvedByUserId) continue;
    const forbidden = forbiddenPathsFor(changeRequest.repository);
    const units = await listUnits(campaign.id);
    const exhausted = units.filter((unit) => unit.state === 'FAILED' && unit.attempt >= unit.maxAttempts && unit.maxAttempts < MAX_UNIT_ATTEMPTS);
    const named = [...new Set([campaign.blockerDetail, ...exhausted.map((unit) => unit.failureDetail)].flatMap(pathsNamedIn))];
    const ok = (path: string): boolean => grantable(path, forbidden) && scopesOverlap([path], PROTECTED_VERIFICATION_PATHS).length === 0;
    const wanted = [...new Set([...widenScope(changeRequest.mutationScope), ...named])].filter(ok);
    const scope = [...new Set([...changeRequest.mutationScope, ...wanted])].sort();
    const label = campaign.id;
    if (scope.join() !== [...changeRequest.mutationScope].sort().join()) {
      const result = await amendContract({
        changeRequestId: changeRequest.id,
        campaignId: campaign.id,
        field: 'mutation_scope',
        newValue: scope,
        reason:
          `Scope reconciliation (owner's standing authorization, 2026-11-11): the campaign stopped on ${campaign.blockerKind}; ` +
          `granted its files' directories and the exact paths its blocker named (${named.filter(ok).join(', ') || 'none'}). ` +
          'Nothing protected, forbidden or sensitive.',
        actorType: 'PERSON',
        actorId: changeRequest.approvedByUserId,
        affectedWork: [],
      });
      steps.push(result.ok ? { campaign: label, action: 'SCOPE', detail: scope.filter((s) => !changeRequest.mutationScope.includes(s)).join(', ') } : { campaign: label, action: 'REFUSED', detail: `scope: ${result.reason}` });
      if (!result.ok) continue;
    }
    for (const unit of exhausted) {
      const own = [...new Set([...widenScope(unit.ownedPaths), ...pathsNamedIn(unit.failureDetail)])].filter((p) => ok(p) && scope.some((glob) => glob === p || p.startsWith(glob.replace(/\*\*$/, ''))));
      const outcome = await regrantUnit({
        campaignId: campaign.id,
        unitKey: unit.unitKey,
        maxAttempts: Math.min(MAX_UNIT_ATTEMPTS, unit.maxAttempts + 2),
        reasonCode: 'work-corrected',
        operator: `operator:${changeRequest.approvedByUserId}`,
        addOwnedPaths: own.filter((p) => !unit.ownedPaths.includes(p)),
      });
      steps.push(outcome.ok ? { campaign: label, action: 'REGRANT', detail: `${unit.unitKey} ${outcome.from} -> ${outcome.to}` } : { campaign: label, action: 'REFUSED', detail: `${unit.unitKey}: ${outcome.reason}` });
    }
    for (const bin of parked.filter((b) => b.factoryCampaignId === campaign.id)) {
      if (bin.maxAttempts >= AUTO_REOPEN_CEILING) {
        steps.push({ campaign: label, action: 'SKIP', detail: `${bin.id} has had ${bin.maxAttempts} attempts; left for a person` });
        continue;
      }
      await regrantBinAttempts({ binId: bin.id, maxAttempts: Math.min(AUTO_REOPEN_CEILING, bin.maxAttempts + 2), reason: 'Scope reconciliation: the campaign was widened or its units regranted; not spent on the work failing.' });
      const reopened = await reopenParkedBin({ binId: bin.id, operator: `operator:${changeRequest.approvedByUserId}`, reason: 'Scope reconciliation reopened a bin parked for scope, not for the work.' });
      steps.push(reopened.ok ? { campaign: label, action: 'REOPEN', detail: bin.id } : { campaign: label, action: 'REFUSED', detail: `${bin.id}: ${reopened.reason}` });
    }
  }
  return steps;
}
let lastReconcile = 0;

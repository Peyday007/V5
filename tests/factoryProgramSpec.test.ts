/**
 * A Factory program's safeguards, judged without a database (§96).
 *
 * The source is the owner's own mission text for this capability, kept as a
 * fixture, plus a generated 126-item architecture across six interdependent
 * subsystems. Each test pins one way a large specification used to be able to
 * lose a requirement: an item nobody cited, two readings of one clause, an
 * ambiguity silently chosen, a relationship dropped between campaigns, a
 * requirement left out of the plan, an "existing" claim with no evidence, a
 * revision that rewrites what a person approved, and a DONE read off a merge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProgramRequirement, RequirementMap, RequirementVerification } from '../server/domain/factoryProgram.ts';
import { extractSourceItems, uncoveredLines } from '../server/services/factory/program/spec.ts';
import { parseRequirementMap, skeletonMap, validateRequirementMap } from '../server/services/factory/program/map.ts';
import { deriveProgramPlan, validateProgramPlan } from '../server/services/factory/program/plan.ts';
import { deriveProgramReading, repairTargets } from '../server/services/factory/program/status.ts';
import { largeSpecification } from './fixtures/factoryProgramLarge.ts';

const mission = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'factory-program-mission.md'), 'utf8');

const codes = (issues: Array<{ code: string }>): string[] => [...new Set(issues.map((i) => i.code))].sort();

describe('the source is read without losing any of it', () => {
  it('locates every line of the owner’s mission in exactly one item, verbatim', () => {
    const items = extractSourceItems(mission);
    expect(uncoveredLines(mission, items)).toEqual([]);
    for (const item of items) expect(mission.slice(item.start, item.end)).toBe(item.text);
    // Every bullet of "Every requirement must have:" is a requirement, though no bullet says "must".
    const identifier = items.find((i) => i.text === '- A stable identifier.');
    expect(identifier?.normative).toBe(true);
    expect(identifier?.section).toEqual(['1. LOSSLESS SPECIFICATION PRESERVATION']);
    // Imperatives and conditional commands are obligations too.
    expect(items.find((i) => i.text.startsWith('Preserve the original document'))?.normative).toBe(true);
    expect(items.find((i) => i.text.startsWith('If production reveals a defect'))?.normative).toBe(true);
    // And the words that make an item open to more than one reading are flagged, not resolved.
    expect(items.find((i) => i.text.startsWith('Use existing status terminology'))?.ambiguityMarkers).toEqual(['where appropriate']);
    expect(items.filter((i) => i.normative).length).toBeGreaterThan(120);
  });

  it('gives the same ids to the same source every time', () => {
    expect(extractSourceItems(mission).map((i) => `${i.id}:${i.start}`)).toEqual(extractSourceItems(mission).map((i) => `${i.id}:${i.start}`));
  });

  it('starts an architect from a skeleton that omits nothing but cannot be installed until it says how each item is verified', () => {
    const items = extractSourceItems(mission);
    const skeleton = skeletonMap(items);
    const verdict = validateRequirementMap(items, skeleton);
    expect(codes(verdict.errors)).toContain('UNVERIFIABLE');
    expect(verdict.errors.some((e) => e.code === 'OMITTED_REQUIREMENT')).toBe(false);
    expect(verdict.errors.some((e) => e.code === 'AMBIGUITY_HIDDEN')).toBe(false);
  });
});

describe('a 100+ requirement architecture decomposes without losing anything', () => {
  const spec = largeSpecification();
  const items = extractSourceItems(spec.source);

  it('is substantially larger than an ordinary objective', () => {
    expect(spec.map.requirements.length).toBeGreaterThanOrEqual(120);
    expect(new Set(spec.map.requirements.map((r) => r.subsystem)).size).toBeGreaterThanOrEqual(6);
    expect(spec.map.requirements.filter((r) => r.kind === 'INTERACTION').length).toBeGreaterThanOrEqual(6);
    expect(spec.map.requirements.filter((r) => r.existing && !r.missingWork).length).toBeGreaterThanOrEqual(15);
  });

  it('validates the map, derives bounded campaigns, and accounts for every requirement exactly once', () => {
    const map = validateRequirementMap(items, spec.map);
    expect(map.errors).toEqual([]);
    const plan = deriveProgramPlan(spec.map);
    const verdict = validateProgramPlan(spec.map, plan);
    expect(verdict.errors).toEqual([]);
    expect(verdict.coverage).toHaveLength(spec.map.requirements.length);
    expect(verdict.coverage.filter((c) => c.by === 'NOBODY')).toEqual([]);
    // Existing functionality is reused, not rebuilt.
    const existing = spec.map.requirements.filter((r) => r.existing && !r.missingWork).map((r) => r.key);
    expect([...plan.verifyOnly].sort()).toEqual(existing.sort());
    expect(plan.campaigns.length).toBeGreaterThanOrEqual(10);
    for (const campaign of plan.campaigns) expect(campaign.implements.length).toBeLessThanOrEqual(8);
    // Every source item a requirement cites is still traceable from the plan.
    const planned = new Set([...plan.campaigns.flatMap((c) => c.implements), ...plan.verifyOnly]);
    for (const r of spec.map.requirements) expect(planned.has(r.key)).toBe(true);
    // Shared ownership is serialized, never left to collide.
    expect(plan.serialized.length).toBeGreaterThan(0);
    // Independent campaigns exist (they can run at the same time).
    expect(plan.campaigns.filter((c) => c.dependsOn.length === 0).length).toBeGreaterThan(1);
  });

  it('carries every cross-campaign requirement dependency as a campaign dependency', () => {
    const plan = deriveProgramPlan(spec.map);
    const owner = new Map(plan.campaigns.flatMap((c) => c.implements.map((k) => [k, c] as const)));
    const reaches = (from: string, to: string): boolean => {
      const stack = [from];
      const seen = new Set<string>();
      while (stack.length) {
        const n = stack.pop()!;
        if (n === to) return true;
        if (seen.has(n)) continue;
        seen.add(n);
        stack.push(...(plan.campaigns.find((c) => c.key === n)?.dependsOn ?? []));
      }
      return false;
    };
    for (const r of spec.map.requirements) {
      for (const dep of [...r.dependsOn, ...r.interactsWith]) {
        const a = owner.get(r.key);
        const b = owner.get(dep);
        if (a && b && a !== b) expect(reaches(a.key, b.key)).toBe(true);
      }
    }
  });

  it('refuses a plan that quietly drops a requirement or implements one twice', () => {
    const plan = deriveProgramPlan(spec.map);
    const dropped = structuredClone(plan);
    const victim = dropped.campaigns[0]!.implements.pop()!;
    expect(codes(validateProgramPlan(spec.map, dropped).errors)).toContain('UNASSIGNED_REQUIREMENT');
    const twice = structuredClone(plan);
    twice.campaigns[1]!.implements.push(victim);
    expect(codes(validateProgramPlan(spec.map, twice).errors)).toContain('DUPLICATE_IMPLEMENTATION');
  });

  it('refuses a plan that loses a relationship between campaigns', () => {
    const plan = deriveProgramPlan(spec.map);
    const cut = structuredClone(plan);
    const dependent = cut.campaigns.find((c) => c.dependsOn.length > 0)!;
    dependent.dependsOn = [];
    expect(codes(validateProgramPlan(spec.map, cut).errors)).toEqual(expect.arrayContaining(['CAMPAIGN_DEPENDENCY_MISSING']));
  });

  it('refuses a campaign whose scope reaches the code that verifies it', () => {
    const plan = deriveProgramPlan(spec.map);
    const sneaky = structuredClone(plan);
    sneaky.campaigns[0]!.mutationScope.push('server/services/factory/program/probes.ts');
    expect(codes(validateProgramPlan(spec.map, sneaky).errors)).toContain('PROTECTED_VERIFICATION_SCOPE');
  });

  it('names an omitted requirement by its source line', () => {
    const map = structuredClone(spec.map);
    const removed = map.requirements.splice(10, 1)[0]!;
    const verdict = validateRequirementMap(items, map);
    const omission = verdict.errors.find((e) => e.code === 'OMITTED_REQUIREMENT');
    expect(omission?.subject).toBe(removed.source[0]);
    expect(omission?.detail).toMatch(/line \d+/);
  });

  it('refuses to set a normative item aside as context', () => {
    const map = structuredClone(spec.map);
    const removed = map.requirements.splice(3, 1)[0]!;
    map.context.push({ item: removed.source[0]!, reason: 'background' });
    expect(codes(validateRequirementMap(items, map).errors)).toContain('CONTEXT_IS_NORMATIVE');
  });

  it('tells a duplicated requirement from a conflicting reading of the same clause', () => {
    const map = structuredClone(spec.map);
    const original = map.requirements[5]!;
    map.requirements.push({ ...structuredClone(original), key: `${original.key}-copy` });
    expect(codes(validateRequirementMap(items, map).errors)).toContain('DUPLICATE_REQUIREMENT');
    const conflict = structuredClone(spec.map);
    const base = conflict.requirements[5]!;
    conflict.requirements.push({ ...structuredClone(base), key: `${base.key}-alt`, behavior: 'Something else entirely is what this clause means.' });
    expect(codes(validateRequirementMap(items, conflict).errors)).toContain('CONFLICTING_INTERPRETATION');
    // Two requirements splitting one clause by exact quotes is a split, not a conflict.
    const split = structuredClone(spec.map);
    const whole = split.requirements[5]!;
    const text = items.find((i) => i.id === whole.source[0])!.text;
    split.requirements[5] = { ...whole, quote: text.slice(2, 20) };
    split.requirements.push({ ...structuredClone(whole), key: `${whole.key}-b`, quote: text.slice(25, 50), behavior: 'The second half of the clause, as its own behavior.' });
    expect(validateRequirementMap(items, split).errors.filter((e) => e.code === 'CONFLICTING_INTERPRETATION')).toEqual([]);
  });

  it('keeps an ambiguity visible instead of letting the map choose silently', () => {
    const map = structuredClone(spec.map);
    const ambiguous = map.requirements.find((r) => r.ambiguities.length > 0)!;
    ambiguous.ambiguities = [];
    expect(codes(validateRequirementMap(items, map).errors)).toContain('AMBIGUITY_HIDDEN');
  });

  it('refuses an existing implementation claimed without evidence, and an unknown dependency', () => {
    const map = structuredClone(spec.map);
    const claimed = map.requirements.find((r) => r.existing)!;
    claimed.existing = { paths: [], evidence: 'the function is named right' };
    map.requirements[0]!.dependsOn.push('REQ-NOPE');
    expect(codes(validateRequirementMap(items, map).errors)).toEqual(expect.arrayContaining(['EXISTING_WITHOUT_EVIDENCE', 'UNKNOWN_DEPENDENCY']));
  });

  it('refuses a dependency cycle', () => {
    const map = structuredClone(spec.map);
    const a = map.requirements[20]!;
    const b = map.requirements[21]!;
    a.dependsOn = [b.key];
    b.dependsOn = [a.key];
    expect(codes(validateRequirementMap(items, map).errors)).toContain('DEPENDENCY_CYCLE');
  });

  it('lets a revision add, and never drop, redefine or disconnect what a person approved', () => {
    const approved = spec.map;
    const dropped = structuredClone(approved);
    dropped.requirements.pop();
    // The dropped requirement's item is still cited elsewhere? Either way the drop is named.
    expect(codes(validateRequirementMap(items, dropped, { previous: approved }).errors)).toContain('REQUIREMENT_DROPPED');
    const weakened = structuredClone(approved);
    weakened.requirements[7]!.verification = [{ kind: 'HTTP', path: '/healthz', expectStatus: 200 }];
    expect(codes(validateRequirementMap(items, weakened, { previous: approved }).errors)).toContain('REQUIREMENT_REDEFINED');
    const disconnected = structuredClone(approved);
    const withEdge = disconnected.requirements.find((r) => r.dependsOn.length > 0)!;
    withEdge.dependsOn = [];
    expect(codes(validateRequirementMap(items, disconnected, { previous: approved }).errors)).toContain('RELATIONSHIP_LOST');
  });

  it('parses a map from JSON exactly, refusing a check of an unknown kind', () => {
    expect(() => parseRequirementMap({ requirements: [{ key: 'A', verification: [{ kind: 'TRUST_ME' }] }] })).toThrow(/HTTP, BUNDLE_TEXT or PROBE/);
    const roundTrip = parseRequirementMap(JSON.parse(JSON.stringify(spec.map)));
    expect(roundTrip.requirements).toHaveLength(spec.map.requirements.length);
  });
});

describe('status is derived, and DONE is earned on production', () => {
  const spec = largeSpecification();
  const plan = deriveProgramPlan(spec.map);
  const allLive = new Map(plan.campaigns.map((c) => [c.key, { key: c.key, changeRequestId: `cr-${c.key}`, campaignId: `fc-${c.key}`, outcome: 'LIVE' as const, delivered: true, needsPerson: false, blocker: null }]));
  let n = 0;
  const pass = (key: string, outcome: RequirementVerification['outcome'] = 'PASS', at = '2026-11-09T10:00:00.000Z'): RequirementVerification => ({
    id: `v${String(n++).padStart(5, '0')}`,
    programId: 'p',
    requirementKey: key,
    outcome,
    revision: 'rev1',
    checks: [{ check: 'c', ok: outcome === 'PASS', detail: '' }],
    at,
  });
  const input = (overrides: Partial<Parameters<typeof deriveProgramReading>[0]> = {}) => ({
    programId: 'p',
    approved: true,
    map: { ...spec.map, requirements: spec.map.requirements.map((r) => ({ ...r, ambiguities: r.ambiguities.map((a) => ({ ...a, interpretation: a.interpretation ?? 'approved reading' })) })) } as RequirementMap,
    plan,
    progress: allLive,
    verifications: [] as RequirementVerification[],
    ...overrides,
  });

  it('does not call merged and deployed work verified', () => {
    const reading = deriveProgramReading(input());
    expect(reading.verdict).toBe('NOT_DONE');
    expect(reading.counts.PRODUCTION_VERIFIED).toBe(0);
    expect(reading.counts.INTEGRATED).toBe(spec.map.requirements.length);
  });

  it('keeps a delivered but unmerged campaign at IMPLEMENTED', () => {
    const progress = new Map([...allLive].map(([k, p]) => [k, { ...p, outcome: 'BLOCKED' as const, needsPerson: true, blocker: 'Read and merge the PR' }]));
    const reading = deriveProgramReading(input({ progress }));
    const built = reading.requirements.filter((r) => r.campaign !== null);
    expect(built.every((r) => r.status === 'IMPLEMENTED')).toBe(true);
  });

  it('is DONE only when every requirement passed on production', () => {
    const all = spec.map.requirements.map((r) => pass(r.key));
    expect(deriveProgramReading(input({ verifications: all })).verdict).toBe('DONE');
    expect(deriveProgramReading(input({ verifications: all.slice(1) })).verdict).toBe('NOT_DONE');
  });

  it('does not pass a dependent because the component under it exists', () => {
    const dependent = spec.map.requirements.find((r) => r.dependsOn.length > 0)!;
    const verifications = spec.map.requirements.filter((r) => r.key !== dependent.dependsOn[0]).map((r) => pass(r.key));
    const reading = deriveProgramReading(input({ verifications }));
    const row = reading.requirements.find((r) => r.key === dependent.key)!;
    expect(row.status).toBe('INTEGRATED');
    expect(row.reason).toMatch(/depends on/);
  });

  it('reopens a requirement production disproves, and its dependents with it', () => {
    const victim = spec.map.requirements.find((r) => spec.map.requirements.some((x) => x.dependsOn.includes(r.key)))!;
    const verifications = [...spec.map.requirements.map((r) => pass(r.key)), pass(victim.key, 'FAIL', '2026-11-09T11:00:00.000Z')];
    const reading = deriveProgramReading(input({ verifications }));
    expect(reading.verdict).toBe('NOT_DONE');
    const row = reading.requirements.find((r) => r.key === victim.key)!;
    expect(row.status).toBe('NOT_DONE');
    expect(row.reopened).toBe(true);
    const dependents = spec.map.requirements.filter((r) => r.dependsOn.includes(victim.key));
    for (const d of dependents) expect(reading.requirements.find((r) => r.key === d.key)!.status).not.toBe('PRODUCTION_VERIFIED');
    // Unaffected requirements keep their verified status.
    const unaffected = reading.requirements.filter((r) => r.status === 'PRODUCTION_VERIFIED');
    expect(unaffected.length).toBeGreaterThan(spec.map.requirements.length / 2);
  });

  it('repairs only the earliest failure, and resumes rather than duplicates an open repair', () => {
    const root = spec.map.requirements.find((r) => r.dependsOn.length === 0 && spec.map.requirements.some((x) => x.dependsOn.includes(r.key)))!;
    const child = spec.map.requirements.find((r) => r.dependsOn.includes(root.key))!;
    const verifications = [pass(root.key, 'FAIL'), pass(child.key, 'FAIL')];
    const targets = repairTargets(input({ verifications }));
    expect(targets.map((t) => t.requirement)).toEqual([root.key]);
    expect(targets[0]!.affected).toContain(child.key);
    expect(targets[0]!.kind).toBe('REPAIR');
    // With that repair opened and not yet live, nothing new is opened.
    const withRepair = structuredClone(plan);
    withRepair.campaigns.push({ key: 'repair-1', kind: 'REPAIR', title: 'r', subsystem: root.subsystem, implements: [root.key], dependsOn: [], mutationScope: root.paths, repairOf: { requirement: root.key, episode: 1, failures: [] } });
    expect(repairTargets(input({ plan: withRepair, verifications }))).toEqual([]);
  });

  it('turns recurring failure into one structural campaign, then stops', () => {
    const root = spec.map.requirements.find((r) => r.paths.length > 0)!;
    const withRepairs = structuredClone(plan);
    const progress = new Map(allLive);
    for (let episode = 1; episode <= 3; episode += 1) {
      withRepairs.campaigns.push({ key: `repair-${episode}`, kind: 'REPAIR', title: 'r', subsystem: root.subsystem, implements: [root.key], dependsOn: [], mutationScope: root.paths, repairOf: { requirement: root.key, episode, failures: [] } });
      progress.set(`repair-${episode}`, { key: `repair-${episode}`, changeRequestId: 'x', campaignId: 'y', outcome: 'LIVE', delivered: true, needsPerson: false, blocker: null });
    }
    const verifications = [pass(root.key, 'FAIL')];
    expect(repairTargets(input({ plan: withRepairs, progress, verifications }))[0]!.kind).toBe('STRUCTURAL');
    withRepairs.campaigns.push({ key: 'structural', kind: 'STRUCTURAL', title: 's', subsystem: root.subsystem, implements: [root.key], dependsOn: [], mutationScope: root.paths, repairOf: { requirement: root.key, episode: 4, failures: [] } });
    progress.set('structural', { key: 'structural', changeRequestId: 'x', campaignId: 'y', outcome: 'LIVE', delivered: true, needsPerson: false, blocker: null });
    expect(repairTargets(input({ plan: withRepairs, progress, verifications }))[0]!.kind).toBe('EXHAUSTED');
    const reading = deriveProgramReading(input({ plan: withRepairs, progress, verifications }));
    expect(reading.requirements.find((r) => r.key === root.key)!.status).toBe('BLOCKED');
  });

  it('blocks a requirement on an open question instead of choosing the owner’s meaning', () => {
    const reading = deriveProgramReading(input({ map: spec.map }));
    const open = reading.requirements.filter((r) => r.status === 'BLOCKED');
    expect(open.length).toBeGreaterThan(0);
    expect(open[0]!.reason).toMatch(/open question/);
  });

  it('is SPECIFIED before approval, whatever the campaigns say', () => {
    const reading = deriveProgramReading(input({ approved: false }));
    expect(reading.requirements.every((r: { status: string }) => r.status === 'SPECIFIED')).toBe(true);
  });
});

// Keep the type import used under isolatedModules.
export type { ProgramRequirement };

describe('the demonstration program run on production', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'specs', 'factory-program-demo.md'), 'utf8');
  const map = parseRequirementMap(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'specs', 'factory-program-demo.map.json'), 'utf8')));
  const items = extractSourceItems(source);

  it('validates against its source and plans into dependent campaigns plus existing work to verify', async () => {
    expect(validateRequirementMap(items, map).errors).toEqual([]);
    const plan = deriveProgramPlan(map);
    expect(validateProgramPlan(map, plan).errors).toEqual([]);
    expect(plan.verifyOnly.sort()).toEqual(['BUILD-1', 'HEALTH-1', 'HEALTH-2']);
    const owner = (key: string) => plan.campaigns.find((c) => c.implements.includes(key))!;
    expect(owner('GUIDE-1').key).toBe(owner('GUIDE-2').key);
    expect(owner('CHECK-1').dependsOn).toContain(owner('GUIDE-1').key);
    expect(owner('LINK-1').dependsOn).toEqual(expect.arrayContaining([owner('GUIDE-1').key, owner('CHECK-1').key]));
  });

  it('compiles every campaign, and the repair the false claim will need, to a LOW-risk objective that may release itself', async () => {
    const { campaignObjective } = await import('../server/services/factory/program/coordinator.ts');
    const { inferRisk } = await import('../server/services/factory/contract.ts');
    const plan = deriveProgramPlan(map);
    const program = { id: 'fpg_demo', title: 'Factory programs, demonstrated', sourceText: source, projectId: 'p', repository: 'https://github.com/Peyday007/V5', baseBranch: 'production' } as never;
    const repair = { key: 'repair-build-1-1', kind: 'REPAIR' as const, title: 'Repair: BUILD-1', subsystem: 'Build page', implements: ['BUILD-1'], dependsOn: [], mutationScope: ['client/src/russell/Build.tsx'], repairOf: { requirement: 'BUILD-1', episode: 1, failures: ['2026-11-09T00:00:00Z served bundle contains "A program…" (not in /assets/index.js)'] } };
    for (const campaign of [...plan.campaigns, repair]) {
      const submission = campaignObjective(program, campaign, map);
      expect(inferRisk(submission.objective), submission.objective).toBe('LOW');
      expect(submission.acceptanceConditions).toHaveLength(campaign.implements.length);
    }
  });
});

/**
 * Acceptance run 13 (frozen df922b3) discovery failure as-02 (d02), kept as regressions on the real published revision
 * archived in docs/planning-session-reliability-2026-11-26/run13-acceptance, with matched controls.
 *
 * as-02, $6,000 in 30 days with $500 and 4 owner hours a week:
 * - the plan marked the SBA count of 36,207,130 US small businesses EVIDENCED and argued the buyer pool was "not the
 *   constraint", although Brain's evidence gate had rejected that claim for its population and definitions;
 * - two of its three openings stated no owner hours, so none could be compared with the hours the goal allows.
 * Both are now Brain's checks: `REJECTED_EVIDENCE_USED`, and `ARITHMETIC_UNSTATED` asking each member's `ownerHours`
 * under an owner-hours limit.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkRevision, type BrainFacts, type GoalContract, type PlanRevisionInput } from '../server/domain/sessionPlanning.ts';

const RUN13 = 'docs/planning-session-reliability-2026-11-26/run13-acceptance';
interface State { value: { contract: GoalContract; final: { plan: PlanRevisionInput } } }
const read = (w: string) => (JSON.parse(fs.readFileSync(`${RUN13}/published/${w}.state.json`, 'utf8')) as State).value;
const SBA = 'https://advocacy.sba.gov/2026/02/03/advocacy-releases-frequently-asked-questions-about-small-businesses-2026/';
// The gate's recorded reason for the SBA claim in the d02 world.
const SBA_REASON = 'Scope does not match on population (mismatch vs "local small-business owner with an outdated or missing website"), definitions (mismatch).';
const brainFor = (plan: PlanRevisionInput, over: Partial<BrainFacts> = {}): BrainFacts => ({
  admittedOpportunityIds: [...new Set([...plan.strategy.opportunityIds, ...(plan.chain ?? []).map((c) => c.opportunityId), ...(plan.excluded ?? []).map((x) => x.opportunityId)])],
  integrity: [], completed: true, error: null, ...over,
});
const codes = (w: string, over: Partial<BrainFacts>, edit: (p: PlanRevisionInput) => PlanRevisionInput = (p) => p) => {
  const s = read(w);
  const plan = edit(structuredClone(s.final.plan));
  return checkRevision(s.contract, plan, brainFor(plan, over), '2026-11-28');
};

describe('run 13, as-02: evidence Brain’s gate rejected is not evidence', () => {
  it('the published d02 plan marks the gate-rejected SBA count EVIDENCED, and is refused', () => {
    const buyers = read('d02').final.plan.quantities.find((q) => q.name === 'buyers')!;
    expect(buyers.status).toBe('EVIDENCED');
    const p = codes('d02', { rejectedSources: { [SBA]: SBA_REASON } }).filter((x) => x.code === 'REJECTED_EVIDENCE_USED');
    expect(p).toHaveLength(1);
    expect(p[0]!.at).toBe('buyers');
    expect(p[0]!.detail).toContain('Scope does not match on population');
  });

  it('controls: the same quantity as an ESTIMATE passes; a quantity also resting on accepted evidence passes; no rejected source, no problem', () => {
    const asEstimate = (p: PlanRevisionInput) => ({ ...p, quantities: p.quantities.map((q) => (q.name === 'buyers' ? { ...q, status: 'ESTIMATE' as const } : q)) });
    expect(codes('d02', { rejectedSources: { [SBA]: SBA_REASON } }, asEstimate).filter((x) => x.code === 'REJECTED_EVIDENCE_USED')).toEqual([]);
    const alsoAccepted = (p: PlanRevisionInput) => ({
      ...p,
      sources: [...p.sources, { ...p.sources[0]!, id: 'src_accepted', url: 'https://example.org/accepted-count' }],
      quantities: p.quantities.map((q) => (q.name === 'buyers' ? { ...q, sources: [...q.sources, 'src_accepted'] } : q)),
    });
    expect(codes('d02', { rejectedSources: { [SBA]: SBA_REASON } }, alsoAccepted).filter((x) => x.code === 'REJECTED_EVIDENCE_USED')).toEqual([]);
    expect(codes('d02', {}).filter((x) => x.code === 'REJECTED_EVIDENCE_USED')).toEqual([]);
  });
});

describe('run 13, as-02: under an owner-hours limit every weighed opening states its owner hours', () => {
  const ownerHourGaps = (over: Partial<BrainFacts>, edit?: (p: PlanRevisionInput) => PlanRevisionInput) =>
    codes('d02', over, edit).filter((x) => x.code === 'ARITHMETIC_UNSTATED' && /ownerHours/.test(x.detail));

  it('the published d02 plan, under its 17-hour limit, states no owner hours for its openings, and is refused', () => {
    const plan = read('d02').final.plan;
    expect((plan.members ?? []).every((m) => (m as { ownerHours?: unknown }).ownerHours === undefined)).toBe(true);
    expect(ownerHourGaps({ hoursCeiling: 17 }).length).toBeGreaterThan(0);
  });

  it('controls: with each opening’s owner hours stated it passes; with no hours limit nothing is asked', () => {
    const withHours = (p: PlanRevisionInput) => ({ ...p, members: (p.members ?? []).map((m) => ({ ...m, ownerHours: 10.5 })) });
    expect(ownerHourGaps({ hoursCeiling: 17 }, withHours)).toEqual([]);
    expect(ownerHourGaps({})).toEqual([]);
  });
});

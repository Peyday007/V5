import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { recordDecision, settleDecision } from '../server/repos/workRouting.ts';
import { buildReport, formatReport, passRate, readRoutingReport, UNKNOWN } from '../server/services/routing/report/index.ts';

let projectId = '';
beforeEach(async () => { projectId = (await freshProject()).project.id; });

describe('routing report', () => {
  it('prints UNKNOWN, never zero, for what it cannot measure', async () => {
    const r = await readRoutingReport(projectId);
    expect(r.decisions).toBe(0);
    expect(r.quality.verificationPassRate).toBe(UNKNOWN);
    expect(r.premiumAllowanceUsed).toBe(UNKNOWN);
    const text = formatReport(r);
    expect(text).toContain('verification pass rate UNKNOWN');
    expect(text).toContain('allowance consumed UNKNOWN');
    expect(text).toContain('no free-model call recorded');
  });

  it('counts each resource class, reuse, prevention, escalation and failure cause per kind of work', async () => {
    const a = await recordDecision({ projectId, workKind: 'screen', resource: 'CODE', reasons: ['detector'] });
    await recordDecision({ projectId, workKind: 'screen', resource: 'CHEAP', reasons: ['measured'] });
    await recordDecision({ projectId, workKind: 'screen', resource: 'STRONG', reasons: ['cheap failed'], escalatedFrom: 'CHEAP', failureClass: 'MALFORMED_OUTPUT' });
    await recordDecision({ projectId, workKind: 'research', resource: 'CHEAP', reasons: ['reuse'], reusedResultId: 'cr_1' });
    const prevented = await recordDecision({ projectId, workKind: 'research', resource: 'STRONG', reasons: ['already answered'] });
    await settleDecision({ projectId, id: a.id, outcome: 'OK', validationResult: 'PASS' });
    await settleDecision({ projectId, id: prevented.id, outcome: 'PREVENTED' });

    const r = await readRoutingReport(projectId);
    expect(r.totals).toEqual({ code: 1, cheap: 2, claude: 2, reused: 1, prevented: 1, escalations: 1 });
    expect(r.failuresByCause).toEqual({ MALFORMED_OUTPUT: 1 });
    expect(r.premiumJobs).toBe(2);
    const screen = r.kinds.find((k) => k.workKind === 'screen')!;
    expect(screen.byResource).toEqual({ CODE: 1, CHEAP: 1, STRONG: 1 });
    expect(screen.validated).toBe(1);
    expect(r.kinds.map((k) => k.workKind)).toEqual(['research', 'screen']);
  });

  it("never reads another project's decisions", async () => {
    const other = (await freshProject()).project.id;
    await recordDecision({ projectId: other, workKind: 'screen', resource: 'STRONG', reasons: ['x'] });
    expect((await readRoutingReport(projectId)).decisions).toBe(0);
  });

  it('reads gate quality as a rate over decided claims only', () => {
    expect(passRate(0, 0)).toBe(UNKNOWN);
    expect(passRate(3, 4)).toBe(0.75);
  });

  it('prints the baseline beside the live figures without subtracting', () => {
    const text = formatReport(buildReport({
      projectId, since: null, decisions: [], providers: [{ model: 'm', calls: 4, valid: 3, reliability: 0.75 }],
      quality: { claimsGated: 4, accepted: 3, rejected: 1, verificationPassRate: 0.75 },
      baseline: { label: 'b', takenAt: 't', readings: { workload: { label: 'b', digest: 'd', items: 7 }, codeCovered: 3, codeSignals: 1, cheapItems: 4, cheapCalls: 8, cheapValidAnswers: 8, cheapFailedAnswers: 0, shortlistEligible: 1, premiumJobsLaunched: 0, unknown: [] } },
    }));
    expect(text).toContain('BASELINE b (stored replay of 7 items');
    expect(text).toContain('not subtracted');
    expect(text).toContain('75.0%');
  });
});

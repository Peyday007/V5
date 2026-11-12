import { describe, expect, it } from 'vitest';
import type { BrowserWorkflow, WorkflowStep } from '../server/services/sources/browserWorkflow.ts';
import {
  authorizeActions,
  classifyWorkflow,
  covers,
  stepFingerprint,
  type ApprovedAction,
} from '../server/services/sources/browser/actionClass.ts';

const wf = (steps: WorkflowStep[], host = 'records.example.org'): BrowserWorkflow => ({
  host,
  name: 'w',
  purpose: 'p',
  account: true,
  origin: 'AUTHORED',
  steps,
});

const approve = (steps: WorkflowStep[], index: number, actionClass: ApprovedAction['actionClass']): ApprovedAction => ({
  stepIndex: index,
  fingerprint: stepFingerprint(steps[index]!),
  actionClass,
  approvedBy: 'person:owner',
  approvedAt: '2026-11-12T00:00:00.000Z',
});

describe('ACQ-21-5 action classification', () => {
  it('classifies navigation, observation, extraction and download as an idempotent read', () => {
    const j = classifyWorkflow(
      wf([
        { kind: 'navigate', url: 'https://records.example.org/reports' },
        { kind: 'wait', text: 'Reports' },
        { kind: 'expect', text: 'Monthly' },
        { kind: 'extract', name: 'table', locator: { role: 'table' } },
        { kind: 'download', name: 'csv', locator: { text: 'Export CSV' } },
      ]),
    );
    expect(j.actionClass).toBe('IDEMPOTENT_READ');
    expect(j.effectSteps).toEqual([]);
    expect(j.firstConsequential).toBeNull();
    for (const s of j.steps) expect(s.evidence.length).toBeGreaterThan(0);
  });

  it('treats a search form and its submit as a read', () => {
    const steps: WorkflowStep[] = [
      { kind: 'fill', locator: { role: 'searchbox' }, value: 'widgets' },
      { kind: 'click', locator: { role: 'button', name: 'Search' } },
      { kind: 'fill', locator: { label: 'Filter by year' }, value: '2025', submit: true },
    ];
    expect(classifyWorkflow(wf(steps)).actionClass).toBe('IDEMPOTENT_READ');
  });

  it('classifies fill + click on a submit control as MUTATION and refuses it without an approval naming that step', () => {
    const steps: WorkflowStep[] = [
      { kind: 'fill', locator: { label: 'Company name' }, value: 'Acme' },
      { kind: 'click', locator: { role: 'button', name: 'Submit' } },
    ];
    const j = classifyWorkflow(wf(steps));
    expect(j.steps[1]!.actionClass).toBe('MUTATION');
    expect(j.actionClass).toBe('MUTATION');
    expect(j.effectSteps).toEqual([1]);

    const refused = authorizeActions(wf(steps), []);
    expect(refused.permitted).toBe(false);
    expect(refused.refusals[0]).toMatchObject({ index: 1, actionClass: 'MUTATION' });

    const wrongStep = authorizeActions(wf(steps), [approve(steps, 0, 'MUTATION')]);
    expect(wrongStep.permitted).toBe(false);

    const ok = authorizeActions(wf(steps), [approve(steps, 1, 'MUTATION')]);
    expect(ok.permitted).toBe(true);
    expect(ok.used).toHaveLength(1);
  });

  it('a generic button that submits a non-search form is a mutation', () => {
    const steps: WorkflowStep[] = [
      { kind: 'fill', locator: { label: 'Address line 1' }, value: '1 Main St' },
      { kind: 'click', locator: { role: 'button', name: 'Continue' } },
    ];
    expect(classifyWorkflow(wf(steps)).steps[1]!.actionClass).toBe('MUTATION');
  });

  it.each([
    ['Buy now'],
    ['Place order'],
    ['Publish'],
    ['Send message'],
    ['Delete record'],
    ['Cancel subscription'],
    ['Transfer funds'],
  ])('detects "%s" as CONSEQUENTIAL before any step runs', (name) => {
    const steps: WorkflowStep[] = [
      { kind: 'navigate', url: 'https://records.example.org/x' },
      { kind: 'click', locator: { role: 'button', name } },
    ];
    const j = classifyWorkflow(wf(steps));
    expect(j.actionClass).toBe('CONSEQUENTIAL');
    expect(j.firstConsequential).toBe(1);
    expect(j.steps[1]!.evidence.join(' ')).toMatch(/destructive or externally consequential/);
  });

  it('detects consequential controls named by test id or selector, and consequential addresses', () => {
    expect(classifyWorkflow(wf([{ kind: 'click', locator: { testId: 'confirm-purchase-btn' } }])).actionClass).toBe('CONSEQUENTIAL');
    expect(classifyWorkflow(wf([{ kind: 'click', locator: { css: '#deleteAccount' } }])).actionClass).toBe('CONSEQUENTIAL');
    expect(classifyWorkflow(wf([{ kind: 'navigate', url: 'https://records.example.org/item/4/delete' }])).actionClass).toBe('CONSEQUENTIAL');
    expect(classifyWorkflow(wf([{ kind: 'navigate', url: 'https://records.example.org/logout' }])).actionClass).toBe('MUTATION');
  });

  it('a MUTATION approval never covers a CONSEQUENTIAL step, and a changed step loses its approval', () => {
    const steps: WorkflowStep[] = [{ kind: 'click', locator: { role: 'button', name: 'Publish' } }];
    expect(authorizeActions(wf(steps), [approve(steps, 0, 'MUTATION')]).permitted).toBe(false);
    expect(authorizeActions(wf(steps), [approve(steps, 0, 'CONSEQUENTIAL')]).permitted).toBe(true);

    const changed: WorkflowStep[] = [{ kind: 'click', locator: { role: 'button', name: 'Publish all' } }];
    const r = authorizeActions(wf(changed), [approve(steps, 0, 'CONSEQUENTIAL')]);
    expect(r.permitted).toBe(false);
    expect(r.refusals[0]!.reason).toMatch(/changed after it was approved/);
    expect(covers('CONSEQUENTIAL', 'MUTATION')).toBe(true);
    expect(covers('MUTATION', 'CONSEQUENTIAL')).toBe(false);
  });

  it('a read-only workflow needs no approval', () => {
    const r = authorizeActions(wf([{ kind: 'navigate', url: 'https://records.example.org/' }]), []);
    expect(r.permitted).toBe(true);
    expect(r.refusals).toEqual([]);
  });

  it('names no host, category or industry: the same steps judge the same on any host', () => {
    const steps: WorkflowStep[] = [
      { kind: 'fill', locator: { label: 'Title' }, value: 't' },
      { kind: 'click', locator: { role: 'button', name: 'Save' } },
      { kind: 'click', locator: { role: 'button', name: 'Send' } },
    ];
    const a = classifyWorkflow(wf(steps, 'a.example.com'));
    const b = classifyWorkflow(wf(steps, 'shop.example.net'));
    expect(a).toEqual(b);
    expect(a.steps.map((s) => s.actionClass)).toEqual(['IDEMPOTENT_READ', 'MUTATION', 'CONSEQUENTIAL']);
  });

  it('fingerprints are stable for equal content regardless of key order', () => {
    const x = stepFingerprint({ kind: 'click', locator: { role: 'button', name: 'Go' } });
    const y = stepFingerprint({ locator: { name: 'Go', role: 'button' }, kind: 'click' } as WorkflowStep);
    expect(x).toBe(y);
  });
});

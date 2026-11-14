/**
 * PORT-05, S-0064: Brain is credited with a delivery capability only on
 * real-world or production evidence, owner-performed delivery is never a
 * self-operable business, and provider-organized delivery keeps the owner
 * physically absent. The judgment is per case, from rows, and recorded with
 * its evidence and reason (`server/services/goals/capabilityCredit.ts`).
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { CapabilityState } from '../server/services/cash/capabilities.ts';
import {
  AI_PERFORMABLE_WORK,
  CAPABILITY_CREDIT_EVENT,
  creditFingerprint,
  judgeCapabilityCredit,
  CREDIT_RECORD_EVERY_MS,
  forgetCreditRecording,
  productionCreditPorts,
  recordCapabilityCredit,
  recordCapabilityCredits,
  recordCapabilityCreditsIfDue,
  type CreditCase,
  type CreditRecordPorts,
} from '../server/services/goals/capabilityCredit.ts';
import { cashEventsOfKind } from '../server/repos/cashMode.ts';
import { freshProject, teardown } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { createWorkstream, linkWorkstream } from '../server/repos/register.ts';
import { assembleGoals } from '../server/services/goals/model.ts';

const states = (entries: Record<string, CapabilityState>): Map<string, CapabilityState> => new Map(Object.entries(entries));

const opening = (over: Partial<CreditCase> = {}): CreditCase => ({
  opportunityId: 'opp_1',
  projectId: 'prj_1',
  requiredCapabilities: [],
  capabilityStates: new Map(),
  fulfillmentOwner: null,
  deliveryMethod: null,
  fulfilments: [],
  fulfilmentEvents: [],
  outcomes: [],
  ...over,
});

describe('capability credit: evidence, never description', () => {
  it('does not credit a delivery that is only described, and names the missing evidence', () => {
    const credit = judgeCapabilityCredit(
      opening({
        requiredCapabilities: ['PRODUCE_SPREADSHEET', 'SEND_A_MESSAGE'],
        capabilityStates: states({ PRODUCE_SPREADSHEET: 'MISSING', SEND_A_MESSAGE: 'PRESENT' }),
        deliveryMethod: 'We build the financial model in a spreadsheet and email it.',
      }),
    );
    expect(credit.mode).toBe('SELF_OPERABLE');
    expect(credit.credited).toBe(false);
    expect(credit.missingEvidence.join(' ')).toContain('PRODUCE_SPREADSHEET reads MISSING');
    expect(credit.missingEvidence.join(' ')).toContain('no delivered, accepted or settled delivery');
    // A commercial capability gates selling, not delivery: it is not a delivery capability.
    expect(credit.deliveryCapabilities.map((c) => c.id)).toEqual(['PRODUCE_SPREADSHEET']);
  });

  it('credits Brain when every delivery capability reads PRESENT, with the capability as evidence', () => {
    const credit = judgeCapabilityCredit(
      opening({ requiredCapabilities: ['PRODUCE_DOCUMENT'], capabilityStates: states({ PRODUCE_DOCUMENT: 'PRESENT' }) }),
    );
    expect(credit.mode).toBe('SELF_OPERABLE');
    expect(credit.credited).toBe(true);
    expect(credit.missingEvidence).toEqual([]);
    expect(credit.evidence).toContainEqual(expect.objectContaining({ kind: 'CAPABILITY', ref: 'PRODUCE_DOCUMENT' }));
    expect(credit.ownerPhysicallyAbsent).toBe(true);
  });

  it('credits Brain from a production delivery row of its own fulfilment, with the row as evidence', () => {
    const credit = judgeCapabilityCredit(
      opening({
        requiredCapabilities: ['BUILD_SOFTWARE'],
        capabilityStates: states({ BUILD_SOFTWARE: 'MISSING' }),
        fulfilments: [{ id: 'ful_1', kind: 'SOFTWARE', performer: 'Software Factory', supplierName: null, declaredBy: 'owner@example' }],
        fulfilmentEvents: [{ id: 'fev_1', fulfillmentId: 'ful_1', kind: 'ACCEPTED', evidenceRef: 'pr#12' }],
      }),
    );
    expect(credit.mode).toBe('SELF_OPERABLE');
    expect(credit.credited).toBe(true);
    expect(credit.evidence).toContainEqual(expect.objectContaining({ kind: 'FULFILMENT_EVENT', ref: 'fev_1' }));
  });

  it('a worker saying WORK_COMPLETE is not a delivery and credits nothing', () => {
    const credit = judgeCapabilityCredit(
      opening({
        requiredCapabilities: ['BUILD_SOFTWARE'],
        capabilityStates: states({ BUILD_SOFTWARE: 'MISSING' }),
        fulfilments: [{ id: 'ful_1', kind: 'SOFTWARE', performer: 'Software Factory', supplierName: null, declaredBy: 'x' }],
        fulfilmentEvents: [{ id: 'fev_1', fulfillmentId: 'ful_1', kind: 'WORK_COMPLETE', evidenceRef: null }],
      }),
    );
    expect(credit.credited).toBe(false);
  });

  it('an unknown capability is not a capability, and an opening nobody established stays undetermined', () => {
    const unknown = judgeCapabilityCredit(opening({ requiredCapabilities: ['PAINT_A_HOUSE'] }));
    expect(unknown.mode).toBeNull();
    expect(unknown.credited).toBe(false);
    expect(unknown.ownerPhysicallyAbsent).toBeNull();
    expect(unknown.missingEvidence.join(' ')).toContain('nobody has established who would perform the delivery');
    expect(unknown.missingEvidence.join(' ')).toContain('PAINT_A_HOUSE reads UNKNOWN');
  });
});

describe('capability credit: who performs it', () => {
  it('classifies owner-performed delivery and never reports it as self-operable', () => {
    const fromRow = judgeCapabilityCredit(
      opening({
        requiredCapabilities: ['PRODUCE_DOCUMENT'],
        capabilityStates: states({ PRODUCE_DOCUMENT: 'PRESENT' }),
        fulfilments: [{ id: 'ful_1', kind: 'PERSON', performer: 'peyton', supplierName: null, declaredBy: 'Peyton' }],
      }),
    );
    expect(fromRow.mode).toBe('OWNER_PERFORMED');
    expect(fromRow.credited).toBe(false);
    expect(fromRow.ownerPhysicallyAbsent).toBe(false);
    expect(fromRow.reason).toContain('never counted as self-operable');

    const stated = judgeCapabilityCredit(opening({ fulfillmentOwner: 'The owner personally visits each site to install it.' }));
    expect(stated.mode).toBe('OWNER_PERFORMED');
    expect(stated.credited).toBe(false);
  });

  it('distinguishes provider-organized delivery: the owner stays physically absent and Brain is credited only with organizing', () => {
    const pending = judgeCapabilityCredit(
      opening({ fulfilments: [{ id: 'ful_2', kind: 'SUPPLIER', performer: 'Acme Print', supplierName: 'Acme Print', declaredBy: 'BRAIN' }] }),
    );
    expect(pending.mode).toBe('PROVIDER_ORGANIZED');
    expect(pending.ownerPhysicallyAbsent).toBe(true);
    expect(pending.credited).toBe(false);
    expect(pending.providerDelivered).toBe(false);

    const delivered = judgeCapabilityCredit(
      opening({
        fulfilments: [{ id: 'ful_2', kind: 'SUPPLIER', performer: 'Acme Print', supplierName: 'Acme Print', declaredBy: 'BRAIN' }],
        fulfilmentEvents: [{ id: 'fev_2', fulfillmentId: 'ful_2', kind: 'DELIVERED', evidenceRef: 'tracking 123' }],
      }),
    );
    expect(delivered.providerDelivered).toBe(true);
    expect(delivered.credited).toBe(false);

    const stated = judgeCapabilityCredit(opening({ deliveryMethod: 'A local contractor does the physical install.' }));
    expect(stated.mode).toBe('PROVIDER_ORGANIZED');
  });

  it('discovery, writing, research, analysis, coding, sales preparation and coordination are AI-performable on any opening', () => {
    const credit = judgeCapabilityCredit(opening());
    expect([...credit.aiPerformable]).toEqual([...AI_PERFORMABLE_WORK]);
    expect(credit.aiPerformable).not.toContain('FULFILMENT');
  });

  it('holds no category whitelist: the same industry words judge differently on different evidence', () => {
    const words = { deliveryMethod: 'Bookkeeping reports for restaurants.' };
    const proven = judgeCapabilityCredit(opening({ ...words, requiredCapabilities: ['PRODUCE_DOCUMENT'], capabilityStates: states({ PRODUCE_DOCUMENT: 'PRESENT' }) }));
    const unproven = judgeCapabilityCredit(opening({ ...words, requiredCapabilities: ['PRODUCE_DOCUMENT'], capabilityStates: states({ PRODUCE_DOCUMENT: 'MISSING' }) }));
    expect(proven.credited).toBe(true);
    expect(unproven.credited).toBe(false);
  });
});

describe('capability credit: recorded once, with evidence and reason', () => {
  it('records a judgment only when it changed', async () => {
    const written: string[] = [];
    let latest: string | null = null;
    const ports: CreditRecordPorts = {
      latestFingerprint: async () => latest,
      record: async (_credit, fingerprint) => {
        written.push(fingerprint);
        latest = fingerprint;
      },
    };
    const credit = judgeCapabilityCredit(opening({ requiredCapabilities: ['PRODUCE_DOCUMENT'], capabilityStates: states({ PRODUCE_DOCUMENT: 'PRESENT' }) }));
    expect((await recordCapabilityCredit(credit, ports)).recorded).toBe(true);
    expect((await recordCapabilityCredit(credit, ports)).recorded).toBe(false);
    const changed = judgeCapabilityCredit(opening({ requiredCapabilities: ['PRODUCE_DOCUMENT'], capabilityStates: states({ PRODUCE_DOCUMENT: 'MISSING' }) }));
    expect(creditFingerprint(changed)).not.toBe(creditFingerprint(credit));
    expect((await recordCapabilityCredit(changed, ports)).recorded).toBe(true);
    expect(written).toHaveLength(2);
  });

  it('writes the judgment to the opening\'s own append-only ledger, with its evidence and reason', async () => {
    const { project } = await freshProject();
    const ports = await productionCreditPorts();
    const credit = judgeCapabilityCredit(
      opening({ projectId: project.id, opportunityId: 'opp_ledger', requiredCapabilities: ['PRODUCE_DOCUMENT'], capabilityStates: states({ PRODUCE_DOCUMENT: 'PRESENT' }) }),
    );
    expect((await recordCapabilityCredit(credit, ports)).recorded).toBe(true);
    expect((await recordCapabilityCredit(credit, ports)).recorded).toBe(false);
    const events = await cashEventsOfKind('opp_ledger', CAPABILITY_CREDIT_EVENT);
    expect(events).toHaveLength(1);
    const detail = events[0]!.detail;
    expect(detail.credited).toBe(true);
    expect(detail.mode).toBe('SELF_OPERABLE');
    expect(detail.evidence).toContainEqual(expect.objectContaining({ kind: 'CAPABILITY', ref: 'PRODUCE_DOCUMENT' }));
    expect(detail.missingEvidence).toEqual([]);
    expect(events[0]!.summary).toContain('Brain is credited');
  });
});

describe('capability credit: the judgment is recorded by the running Brain, not only by a caller', () => {
  afterAll(async () => {
    await teardown();
  });

  async function pursuedOpening(title: string) {
    const projectId = (await freshProject()).project.id;
    const userId = (await createUser({ email: `cc-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    const goal = await createWorkstream({ projectId, title: 'Collect cash', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    const opened = await capture({ projectId, actorRef: userId, ownerUserId: userId, title, mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', industry: 'any', source: 'https://example.com/c' });
    if (!opened.ok) throw new Error(opened.reason);
    await linkWorkstream({ workstreamId: goal.id, kind: 'OPPORTUNITY', ref: opened.value.id, relation: 'PURSUES', recordedBy: 'PERSON', recordedByUserId: userId });
    return { projectId, goalId: goal.id, opportunityId: opened.value.id };
  }

  it('the whole-Brain goals tick judges each pursued opening from its rows and records it on the opening\'s ledger', async () => {
    const { projectId, opportunityId } = await pursuedOpening('Weekly report assembly for clinics');
    forgetCreditRecording();
    // A person's read does not write.
    await assembleGoals({ projectIds: [projectId] });
    expect(await cashEventsOfKind(opportunityId, CAPABILITY_CREDIT_EVENT)).toHaveLength(0);

    const tick = await assembleGoals({ projectIds: null, includeArchived: false });
    expect(tick.creditJudgments).toMatchObject({ failed: [] });
    const events = await cashEventsOfKind(opportunityId, CAPABILITY_CREDIT_EVENT);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ credited: false });
    expect(Array.isArray(events[0]!.detail.missingEvidence)).toBe(true);
    expect(typeof events[0]!.detail.fingerprint).toBe('string');

    // Not due again inside the interval; and when due, an unchanged judgment writes nothing.
    const again = await assembleGoals({ projectIds: null, includeArchived: false });
    expect(again.creditJudgments ?? null).toBeNull();
    const forced = await recordCapabilityCreditsIfDue([opportunityId], { force: true });
    expect(forced).toMatchObject({ judged: 1, recorded: 0 });
    expect(await cashEventsOfKind(opportunityId, CAPABILITY_CREDIT_EVENT)).toHaveLength(1);
  });

  it('runs at most once per interval, and one failing opening never stops the others', async () => {
    forgetCreditRecording();
    const written: string[] = [];
    const ports: CreditRecordPorts = { latestFingerprint: async () => null, record: async (c) => void written.push(c.opportunityId) };
    const deps = {
      ports,
      readCapabilities: async () => new Map(),
      stateOf: async (id: string) => (id === 'opp_gone' ? null : id === 'opp_done' ? 'COLLECTED' : 'READY'),
      readCase: async (id: string) => {
        if (id === 'opp_bad') throw new Error('row unreadable');
        return opening({ opportunityId: id });
      },
    };
    const first = await recordCapabilityCreditsIfDue(['opp_a', 'opp_bad', 'opp_gone', 'opp_done', 'opp_b', 'opp_a'], { nowMs: 10_000_000_000 }, deps);
    expect(first).toMatchObject({ judged: 2, recorded: 2, failed: [{ opportunityId: 'opp_bad' }] });
    expect(written).toEqual(['opp_a', 'opp_b']);
    expect(await recordCapabilityCreditsIfDue(['opp_a'], { nowMs: 10_000_000_000 + CREDIT_RECORD_EVERY_MS - 1 }, deps)).toBeNull();
    expect(await recordCapabilityCreditsIfDue(['opp_a'], { nowMs: 10_000_000_000 + CREDIT_RECORD_EVERY_MS }, deps)).toMatchObject({ judged: 1 });
    expect(await recordCapabilityCredits([], deps)).toEqual({ judged: 0, recorded: 0, failed: [] });
  });

  it('the recorder has a production caller: model.ts runs it on the whole-Brain read', () => {
    const model = readFileSync('server/services/goals/model.ts', 'utf8');
    expect(model).toMatch(/recordCapabilityCreditsIfDue\(pursued/);
  });
});

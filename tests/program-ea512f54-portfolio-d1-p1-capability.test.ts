/**
 * PORT-05, S-0064: Brain is credited with a delivery capability only on
 * real-world or production evidence, owner-performed delivery is never a
 * self-operable business, and provider-organized delivery keeps the owner
 * physically absent. The judgment is per case, from rows, and recorded with
 * its evidence and reason (`server/services/goals/capabilityCredit.ts`).
 */
import { describe, expect, it } from 'vitest';
import type { CapabilityState } from '../server/services/cash/capabilities.ts';
import {
  AI_PERFORMABLE_WORK,
  CAPABILITY_CREDIT_EVENT,
  creditFingerprint,
  judgeCapabilityCredit,
  productionCreditPorts,
  recordCapabilityCredit,
  type CreditCase,
  type CreditRecordPorts,
} from '../server/services/goals/capabilityCredit.ts';
import { cashEventsOfKind } from '../server/repos/cashMode.ts';
import { freshProject } from './helpers.ts';

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

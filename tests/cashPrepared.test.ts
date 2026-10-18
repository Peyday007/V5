/**
 * A prepared decision is Brain's draft, versioned, strict, and moves nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, getOpportunity } from '../server/repos/cashPortfolio.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { cashView } from '../server/services/cash/view.ts';
import {
  PreparedDecisionError,
  prepareDecision,
  preparedDecisions,
} from '../server/services/cash/prepared.ts';
import { getDb } from '../server/db/database.ts';

let projectId = '';
let opportunityId = '';

const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  opportunityId,
  buyerRequest: 'Key PDFs into my template, exactly.',
  buyerRequestUrl: 'https://www.freelancer.com/projects/data-entry/precise-entry-from-pdfs',
  observedAt: '2026-10-18T19:30:00Z',
  observedStatus: 'active, open, 30 bids',
  scope: 'Key every PDF; second-pass reconciliation; anomalies note.',
  priceProposal: 'INR 15,000 for up to 20 PDFs (estimate).',
  priceBasis: 'Low-middle of the published INR 12,500–37,500 range; volume unknown.',
  fulfillment: 'The owner keys it, or a data-entry subcontractor.',
  cashTiming: 'Days after delivery, on milestone release (estimate).',
  openQuestions: ['How many PDFs?'],
  proposalText: 'Accuracy over speed is exactly how I work.',
  submissionBlockers: ['A Freelancer account in good standing is needed to bid.'],
  decisionNeeded: 'Whether to submit this bid from your own account.',
  ...overrides,
});

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `prepared-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  const outcome = await activate({
    projectId,
    ownerUserId: user.id,
    actorUserId: user.id,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
  const piece = await createOpportunity({
    projectId,
    cashModeId: (await getCashMode(projectId))!.id,
    ownerUserId: user.id,
    title: 'Precise Entry From PDFs',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    source: 'RESEARCH',
    currency: 'USD',
  });
  opportunityId = piece.id;
});

describe('prepared decisions', () => {
  it('records Brain’s draft as not sent, versions changes, and ignores a replay', async () => {
    const before = await getOpportunity(opportunityId);
    const first = await prepareDecision({ projectId, body: body() });
    expect(first.written).toBe(true);
    expect(first.decision.version).toBe(1);
    expect(first.decision.preparedBy).toBe('BRAIN');
    expect(first.decision.state).toBe('PREPARED_NOT_SENT');

    const replay = await prepareDecision({ projectId, body: body() });
    expect(replay.written).toBe(false);
    expect(replay.decision.version).toBe(1);

    const revised = await prepareDecision({ projectId, body: body({ observedStatus: 'active, open, 41 bids' }) });
    expect(revised.decision.version).toBe(2);
    const rows = await getDb().all<{ version: number }>(
      'SELECT version FROM cash_prepared_decisions WHERE opportunity_id = ? ORDER BY version',
      [opportunityId],
    );
    expect(rows.map((one) => one.version)).toEqual([1, 2]);

    const latest = await preparedDecisions(projectId);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.observedStatus).toBe('active, open, 41 bids');

    // It moves nothing about the opening itself.
    const after = await getOpportunity(opportunityId);
    expect(after?.state).toBe(before?.state);
    expect(after?.priceCents ?? null).toBe(before?.priceCents ?? null);

    const view = await cashView({ projectId });
    expect(view.prepared.map((one) => one.opportunityId)).toEqual([opportunityId]);
  });

  it('refuses an unknown field, so nothing arrives dressed as an approval', async () => {
    await expect(prepareDecision({ projectId, body: body({ approvedBy: 'owner' }) })).rejects.toBeInstanceOf(
      PreparedDecisionError,
    );
    await expect(prepareDecision({ projectId, body: body({ state: 'SENT' }) })).rejects.toBeInstanceOf(
      PreparedDecisionError,
    );
    expect(await preparedDecisions(projectId)).toHaveLength(0);
  });

  it('refuses an opening outside the project and a malformed source', async () => {
    await expect(prepareDecision({ projectId, body: body({ opportunityId: 'cop_missing' }) })).rejects.toThrow(
      /No opportunity/,
    );
    await expect(prepareDecision({ projectId, body: body({ buyerRequestUrl: 'ftp://x' }) })).rejects.toThrow(
      /http/,
    );
    await expect(prepareDecision({ projectId, body: body({ openQuestions: [''] }) })).rejects.toThrow(/sentences/);
  });

  it('cannot be written as a person or as sent, by the schema itself', async () => {
    await prepareDecision({ projectId, body: body() });
    await expect(
      getDb().run(`UPDATE cash_prepared_decisions SET prepared_by = 'PERSON' WHERE opportunity_id = ?`, [opportunityId]),
    ).rejects.toThrow();
    await expect(
      getDb().run(`UPDATE cash_prepared_decisions SET state = 'SENT' WHERE opportunity_id = ?`, [opportunityId]),
    ).rejects.toThrow();
  });
});

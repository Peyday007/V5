/**
 * ORIGINATED:UNMET_NEED:field-payer — 220 openings blocked on one question.
 *
 * The payer question asked for "the role inside it that decides and pays":
 * the person or office that approves a payment. That is internal and is not
 * published — a federal prize's payer is the sponsoring agency (15 U.S.C.
 * 3719(b)), its public notice need name no approving official (3719(f)), and
 * the staff who disburse are internal (GSA Prize and Challenge Toolkit 2026,
 * §4.2) — so every asking ended without an answer, and asking again only
 * repeated the same demand and then turned to somebody else's comparables.
 *
 * These drive the real pass over a real opening row and assert the need it
 * raises asks for what is published: the paying organisation and how it pays.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { differentMethod, PAYER_ASK, researchGoalPaths } from '../server/services/goals/pathResearch.ts';
import type { PathResearchReading } from '../server/services/goals/pathResearch.ts';
import type { ConsideredOpening } from '../server/services/goals/plan.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
const now = new Date();

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `payer-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function opening(title: string): Promise<string> {
  const o = await createOpportunity({
    projectId,
    cashModeId,
    ownerUserId: userId,
    title,
    mechanism: 'PRODUCTIZED_SERVICE',
    currency: 'USD',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`,
    opportunitySignal: 'RECURRING_OUTSOURCED_WORK',
  });
  return o.id;
}

function reading(id: string): PathResearchReading {
  const one: ConsideredOpening = {
    opportunityId: id,
    title: `Opening ${id}`,
    modelled: true,
    missing: ['REACHABLE_BUYER'],
    supportedReach: 10_000,
    potentialReach: 10_000,
    competitiveAward: false,
    volumeEstablished: true,
    paysOnce: false,
    stage: 'A_THEORETICAL',
  };
  return { considered: [one], target: { remainingCents: 1_000_000 }, researchPriority: [], sales: [], executionPolicy: 'EVIDENCE_FIRST', portfolio: null, pathways: null };
}

describe('field-payer: the payer question asks for the published paying party', () => {
  it('reproduces the failure class: the raised payer need no longer demands an unpublished internal approver', async () => {
    const id = await opening('Paid task: federal government-sponsored prize competition requesting a specific deliverable');
    await researchGoalPaths({ reading: reading(id), projectId, now, dryRun: false });
    const payer = (await listNeeds({ projectId, states: ['OPEN'] })).find((one) => one.requestKey === `question:${id}:payer`);
    expect(payer).toBeDefined();
    const step = payer!.nextStep ?? '';
    // Before the change the question asked for "the role inside it that decides and pays" — an answer nobody publishes.
    expect(step).not.toMatch(/the role inside it that decides and pays/);
    // It asks for the paying organisation and the mechanism by which it pays …
    expect(step).toMatch(/organisation published as paying/);
    expect(step).toMatch(/sponsoring body/);
    expect(step).toMatch(/published mechanism by which it pays/);
    // … says an internal approving official is not required …
    expect(step).toMatch(/internal official or office who approves the payment is not required/);
    // … and keeps the bar: a generic "businesses" payer is still refused.
    expect(step).toMatch(/only described as "businesses" or "companies" is not a payer/);
    expect(step).toMatch(/source and date/);
  });

  it('a payer asked again goes to the documents that assign who pays, not the identical search or comparables', () => {
    const again = differentMethod(PAYER_ASK, 2, 'No published payment-approving official found for this competition.', 'payer');
    expect(again).toMatch(/do not look for a named approving official/);
    expect(again).toMatch(/program or competition rules/);
    expect(again).toMatch(/statute or regulation/);
    expect(again).toMatch(/successor listing/);
    expect(again).toMatch(/USA\.gov/);
    expect(again).not.toMatch(/closest comparable published cases/);
    // The third asking of a payer keeps the rules method: comparables name somebody else's payer.
    expect(differentMethod(PAYER_ASK, 3, 'none', 'payer')).not.toMatch(/closest comparable published cases/);
  });

  it('every other field keeps its re-ask method unchanged', () => {
    expect(differentMethod('Find the price.', 2, 'none', 'revenueRange')).toMatch(/Use other kinds of source/);
    expect(differentMethod('Find the price.', 3, 'none', 'revenueRange')).toMatch(/closest comparable published cases/);
    expect(differentMethod('Find the price.', 2, 'none')).toMatch(/Use other kinds of source/);
  });
});

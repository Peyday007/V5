/**
 * "Has Brain any history with this kind of opportunity" is read from recorded
 * outcomes. It used to be the constant `true`, so no opportunity could ever be
 * held as UNFAMILIAR_TYPE through the real path.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { insertOutcome } from '../server/repos/cashJourney.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { mechanismsWithHistory, screenFactsFor } from '../server/services/cash/worthResearching.ts';
import { screenOpportunity } from '../server/services/cash/screen.ts';

let projectId = '';
let modeId = '';
let userId = '';
const NOW = '2026-10-30T00:00:00.000Z';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({
    email: `hist-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner', password: 'correct horse battery staple',
  })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' })).ok).toBe(true);
  modeId = (await getCashMode(projectId))!.id;
});

const open = (title: string, mechanism: 'EXPLICIT_PAID_REQUEST' | 'RESALE_OR_ASSET') =>
  createOpportunity({ projectId, cashModeId: modeId, ownerUserId: userId, title, mechanism, currency: 'USD' });

// Everything else about the piece is established, so only history is in question.
const screenIt = async (o: Awaited<ReturnType<typeof open>>) => {
  const facts = { ...screenFactsFor(o, await mechanismsWithHistory(projectId)), hasPayer: true, hasPrice: true, sourceObservedAt: NOW, capitalRequiredCents: 0, daysToPayment: 5 };
  return { facts, verdict: screenOpportunity(facts, { metric: 'COLLECTED_CASH', daysLeft: 30, capitalCeilingCents: 1_000_000, capitalBeforeProofCents: null }, NOW) };
};

describe('typeHasHistory is derived from recorded outcomes', () => {
  it('holds a type with no recorded history as UNFAMILIAR_TYPE, never clears or rejects it', async () => {
    const piece = await open('new kind', 'RESALE_OR_ASSET');
    const { facts, verdict } = await screenIt(piece);
    expect(facts.typeHasHistory).toBe(false);
    expect(verdict).toMatchObject({ verdict: 'HOLD', reason: 'UNFAMILIAR_TYPE' });
  });

  it('stops holding it once an outcome is recorded for that mechanism, and only that mechanism', async () => {
    const known = await open('known kind', 'EXPLICIT_PAID_REQUEST');
    const other = await open('other kind', 'RESALE_OR_ASSET');
    await insertOutcome({ projectId, opportunityId: known.id, kind: 'CONTACT_RESULT', mechanism: 'EXPLICIT_PAID_REQUEST', basis: 'a deal', requestKey: 'k1' });
    expect((await screenIt(known)).facts.typeHasHistory).toBe(true);
    expect((await screenIt(known)).verdict.verdict).toBe('CLEAR');
    expect((await screenIt(other)).facts.typeHasHistory).toBe(false);
  });
});

/**
 * A plan refused only for a source-type label is asked again once, with the
 * envelope's own sourceRule, instead of parking at NEEDS_HUMAN. Everything else
 * the envelope refuses still parks, and a second refusal parks naming both.
 *
 * Recorded failure class (PACKETS:NEEDS_HUMAN): fragment "translation-rate-arbitrage"
 * accepts "industry association or research-firm published rate surveys", which
 * this envelope does not admit. Real: the rows, advancePacket, and the cash
 * envelope's own regexes — none is stubbed or loosened.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  getOrchestration,
  listFragments,
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import { recordEvent } from '../server/repos/events.ts';
import { advancePacket } from '../server/services/research/packetRunner.ts';
import { getApprovalEnvelope } from '../server/services/research/approvalEnvelope.ts';
import { createHash } from 'node:crypto';

const ENVELOPE_ID = 'RUSSELL_CASH_DISCOVERY_V1';
const BAD_SOURCE = 'industry association or research-firm published rate surveys (ATA, CSA Research, Slator)';
let projectId = '';
let layerId = '';

async function packetWith(sources: string[], question = 'What do translators charge per word?') {
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'p' });
  const orchestration = await createOrchestration({
    projectId, layerId, runId: run.id, title: 't', assignment: 'a', provider: 'WORKER', autoApprove: false,
  });
  await updateOrchestration(orchestration.id, {
    approvalEnvelopeId: ENVELOPE_ID,
    approvalEnvelopeAuthorizedBy: 'test',
    approvalEnvelopeAuthorizedAt: new Date().toISOString(),
    status: 'PLANNING',
  } as never);
  // The assignment was approved under this envelope when the packet started;
  // that is what a real follow-up plan relies on, so the question under test is
  // only the fragment's own declarations.
  await recordEvent({
    projectId, layerId, entityType: 'RUN', entityId: run.id,
    eventType: 'RESEARCH_PLAN_SYSTEM_APPROVED',
    payload: {
      orchestrationId: orchestration.id, envelopeId: ENVELOPE_ID, fits: true,
      assignmentSha256: createHash('sha256').update('a', 'utf8').digest('hex'),
    },
  } as never);
  await createFragments([{
    orchestrationId: orchestration.id, projectId, layerId, fragmentIndex: 0,
    fragmentKey: 'translation-rate-arbitrage', question, geography: 'United States',
    requiredEvidence: [{ id: 'rates', description: 'published rates', necessity: 'REQUIRED' }],
    acceptableSourceTypes: sources, excludedSourceTypes: [], completionCriteria: ['a quoted rate'],
    dependsOn: [], minIndependentSources: 1, status: 'PLANNED',
  }] as unknown as Parameters<typeof createFragments>[0]);
  return orchestration.id;
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await listLayers(projectId))[0]!.id;
});

describe('envelope source-type refusal is asked again once', () => {
  it('re-asks a source-type-only refusal with the envelope sourceRule instead of parking', async () => {
    const id = await packetWith([BAD_SOURCE]);
    const result = await advancePacket(id);
    expect(result.status).not.toBe('NEEDS_HUMAN');
    const all = await listFragments(id);
    expect(all.map((f) => [f.attempt, f.status])).toEqual(expect.arrayContaining([[1, 'CANCELLED']]));
    const live = (await currentFragments(id))[0]!;
    expect(live.attempt).toBe(2);
    expect(live.parentFragmentId).toBe(all.find((f) => f.attempt === 1)!.id);
    expect(live.acceptableSourceTypes).toContain(getApprovalEnvelope(ENVELOPE_ID)!.sourceRule);
    expect(live.acceptableSourceTypes).not.toContain(BAD_SOURCE);
  });

  it('still parks a refusal for a forbidden action, with the same words', async () => {
    const id = await packetWith(['a marketplace listing'], 'Hire a translator and ask what they charge.');
    const result = await advancePacket(id);
    expect(result.status).toBe('NEEDS_HUMAN');
    const o = (await getOrchestration(id))!;
    expect(JSON.stringify(o)).toContain('instructs the researcher to hire');
    expect(await listFragments(id)).toHaveLength(1);
  });

  it('parks a mixed refusal (source type plus forbidden action) unchanged', async () => {
    const id = await packetWith([BAD_SOURCE], 'Hire a translator and ask what they charge.');
    expect((await advancePacket(id)).status).toBe('NEEDS_HUMAN');
    expect(await listFragments(id)).toHaveLength(1);
  });

  it('parks, naming both refusals, when a plan is refused again while its re-ask is still awaiting approval', async () => {
    const id = await packetWith([BAD_SOURCE]);
    // First pass, through the real code: the label is refused and asked again.
    await advancePacket(id);
    const reasked = (await currentFragments(id)).find((f) => f.attempt === 2)!;
    expect(reasked.repairReason).toContain('ENVELOPE_REASK:');
    // The re-asked attempt is still awaiting approval when the planner proposes a
    // further fragment that names a label the envelope refuses. Nothing here is
    // hand-built except the planner's own proposal, which is its real input.
    await updateFragment(reasked.id, { status: 'PLANNED' });
    await createFragments([{
      orchestrationId: id, projectId, layerId, fragmentIndex: 1,
      fragmentKey: 'second-question', question: 'What do interpreters charge per hour?', geography: 'United States',
      requiredEvidence: [{ id: 'rates', description: 'published rates', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a private purchased contact list'], excludedSourceTypes: [],
      completionCriteria: ['a quoted rate'], dependsOn: [], minIndependentSources: 1, status: 'PLANNED',
    }] as unknown as Parameters<typeof createFragments>[0]);
    const result = await advancePacket(id);
    expect(result.status).toBe('NEEDS_HUMAN');
    const text = JSON.stringify(await getOrchestration(id));
    expect(text).toContain('a private purchased contact list');
    expect(text).toContain('First refusal');
    expect(text).toContain('industry association');
  });
});

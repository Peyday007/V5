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
  updateOrchestration,
} from '../server/repos/research.ts';
import { recordEvent } from '../server/repos/events.ts';
import { advancePacket } from '../server/services/research/packetRunner.ts';
import {
  APPROVAL_ENVELOPES,
  getApprovalEnvelope,
  planFitsEnvelope,
} from '../server/services/research/approvalEnvelope.ts';
import { onlySourceTypeRefusals } from '../server/services/research/replan.ts';
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

  it('parks, naming both refusals, when the re-asked plan is refused again', async () => {
    const id = await packetWith([BAD_SOURCE]);
    // Stop the first re-ask from being approved by hand-building its outcome: the
    // first attempt is superseded and the re-asked attempt still names a label
    // the envelope refuses.
    const first = (await currentFragments(id))[0]!;
    const { updateFragment } = await import('../server/repos/research.ts');
    await updateFragment(first.id, { status: 'CANCELLED', cancelledReason: 'Re-asked once' });
    await createFragments([{
      orchestrationId: id, projectId, layerId, fragmentIndex: 0,
      fragmentKey: first.fragmentKey, question: first.question, geography: 'United States',
      requiredEvidence: first.requiredEvidence,
      acceptableSourceTypes: ['a private purchased contact list'], excludedSourceTypes: [],
      completionCriteria: first.completionCriteria, dependsOn: [], minIndependentSources: 1,
      status: 'PLANNED', attempt: 2, parentFragmentId: first.id,
      repairReason: `ENVELOPE_REASK: fragment "${first.fragmentKey}" accepts "${BAD_SOURCE}", which this envelope does not admit.`,
    }] as unknown as Parameters<typeof createFragments>[0]);
    const result = await advancePacket(id);
    expect(result.status).toBe('NEEDS_HUMAN');
    const text = JSON.stringify(await getOrchestration(id));
    expect(text).toContain('a private purchased contact list');
    expect(text).toContain('First refusal');
    expect(text).toContain('industry association');
    expect(await listFragments(id)).toHaveLength(2);
  });
});

describe('the re-ask recognises the envelope\'s own refusal sentence', () => {
  // Drift guard: replan.ts matches the envelope's wording, so the wording the
  // envelope really produces is what is asserted here, for every envelope. If
  // approvalEnvelope.ts rewords it, this fails loudly instead of the re-ask
  // silently going quiet and packets parking at NEEDS_HUMAN.
  const impossible = 'zzz-no-envelope-admits-this-source-type-zzz';
  for (const envelope of Object.values(APPROVAL_ENVELOPES)) {
    it(`${envelope.id}: a refusal only for source type is recognised`, () => {
      const fragment = {
        fragmentKey: 'drift-guard', question: 'What is the published rate?', geography: 'United States',
        requiredEvidence: [{ id: 'rates', description: 'published rates', necessity: 'REQUIRED' }],
        acceptableSourceTypes: [impossible], excludedSourceTypes: [], completionCriteria: ['a quoted rate'],
        dependsOn: [], minIndependentSources: 99, attempt: 1,
      };
      const verdict = planFitsEnvelope({
        envelope,
        orchestration: { id: 'o', assignment: 'a' } as never,
        fragments: [fragment as never],
        assignmentAlreadyApproved: true,
      });
      const sourceTypeReasons = verdict.reasons.filter((reason) => reason.includes(`"${impossible}"`));
      expect(sourceTypeReasons).toHaveLength(1);
      expect(onlySourceTypeRefusals(sourceTypeReasons)).toBe(true);
      expect(onlySourceTypeRefusals([...sourceTypeReasons, 'fragment "x" instructs the researcher to hire.'])).toBe(false);
    });
  }
});

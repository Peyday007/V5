/**
 * CAUSAL-14-4: "send decision-critical unknowns to targeted research or
 * authorized action". A need the graph names is handed to an existing owner and
 * becomes a row there — a research uncertainty on the orchestration named, or a
 * need in the review a person reads — idempotently, and another project's
 * orchestration is refused exactly like an absent one.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { listUncertainties } from '../server/repos/researchIntelligence.ts';
import { listNeeds } from '../server/repos/cashPortfolio.ts';
import { createProject } from '../server/repos/projects.ts';
import { UnknownOrchestrationError, needKeyOf, sendNeeds, type Need } from '../server/services/quant/needs.ts';

let projectId = '';
let layerId = '';

beforeEach(async () => {
  const fresh = await freshProject();
  projectId = fresh.project.id;
  layerId = fresh.layers[0]!.id;
});

async function orchestrationIn(project: string, layer: string): Promise<string> {
  const run = await createRun({ projectId: project, layerId: layer, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'causal research' });
  const orchestration = await createOrchestration({ projectId: project, layerId: layer, runId: run.id, title: 'causal research', assignment: 'settle the graph unknowns', provider: 'WORKER', autoApprove: false });
  return orchestration.id;
}

const RESEARCH: Need = { subject: 'claim conversion', question: 'What is conversion?', route: 'RESEARCH', permissions: [] };
const ACTION: Need = { subject: 'action a1', question: 'Is ops authorized to send invoices?', route: 'AUTHORIZED_ACTION', permissions: ['billing:write'] };

describe('sending a causal graph’s needs', () => {
  it('opens a research uncertainty on the named orchestration, once', async () => {
    const orchestrationId = await orchestrationIn(projectId, layerId);
    const first = await sendNeeds({ projectId, actorRef: 'usr_test', graphScope: 'key:deal', needs: [RESEARCH], orchestrationId });
    expect(first).toEqual([{ subject: 'claim conversion', sent: true, to: 'RESEARCH_UNCERTAINTY', ref: expect.any(String), created: true }]);
    const rows = await listUncertainties(orchestrationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ question: 'What is conversion?', consumerKind: 'CALCULATION', disposition: 'OPEN', uncertaintyKey: needKeyOf('key:deal', RESEARCH) });

    const again = await sendNeeds({ projectId, actorRef: 'usr_test', graphScope: 'key:deal', needs: [RESEARCH], orchestrationId });
    expect(again[0]).toMatchObject({ sent: true, created: false, ref: first[0]!.sent ? first[0]!.ref : '' });
    expect(await listUncertainties(orchestrationId)).toHaveLength(1);
  });

  it('raises an action’s need in the review, keyed on the authority it lacks, once', async () => {
    const sent = await sendNeeds({ projectId, actorRef: 'usr_test', graphScope: 'key:deal', needs: [ACTION, RESEARCH] });
    expect(sent.map((one) => one.sent && one.to)).toEqual(['REVIEW_NEED', 'REVIEW_NEED']);
    const open = await listNeeds({ projectId, states: ['OPEN'] });
    expect(open).toHaveLength(2);
    expect(open.find((one) => one.blockerKey === 'AUTHORITY:billing:write')).toBeTruthy();
    expect(open.find((one) => one.blockerKey?.startsWith('EVIDENCE:causal-'))?.recommendedPath).toBe('Targeted research: What is conversion?');

    const again = await sendNeeds({ projectId, actorRef: 'usr_test', graphScope: 'key:deal', needs: [ACTION, RESEARCH] });
    expect(again.every((one) => one.sent && !one.created)).toBe(true);
    expect(await listNeeds({ projectId, states: ['OPEN'] })).toHaveLength(2);
  });

  it('refuses another project’s orchestration exactly as an absent one, and writes nothing', async () => {
    const other = await createProject({ name: `other-${Math.random().toString(36).slice(2, 8)}` });
    const foreign = await orchestrationIn(other.id, layerId);
    for (const id of [foreign, 'orc_absent']) {
      await expect(sendNeeds({ projectId, actorRef: 'usr_test', graphScope: 'key:deal', needs: [RESEARCH], orchestrationId: id })).rejects.toBeInstanceOf(UnknownOrchestrationError);
    }
    expect(await listNeeds({ projectId })).toHaveLength(0);
  });
});

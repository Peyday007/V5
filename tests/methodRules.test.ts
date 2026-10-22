/**
 * Method rules: what Brain researched about how to research reaches every
 * research worker's guidance by itself — and only what was accepted, sourced,
 * uncontested and asked by a research goal in the Brain architecture project.
 * Beside it, the two DR_1 notes every fragment pass now carries.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration, insertClaims } from '../server/repos/research.ts';
import { createResearchGoal } from '../server/repos/russellAuthority.ts';
import { listLayers } from '../server/repos/layers.ts';
import { ensureArchitectureScope } from '../server/services/capability/ingest.ts';
import {
  DECISIVE_ASSUMPTION_NOTE,
  DEMAND_EVIDENCE_NOTE,
  MAX_GUIDANCE_METHOD_RULES,
  composeGuidance,
} from '../server/services/research/prompts.ts';
import { readMethodRules, resetMethodRuleCache } from '../server/services/research/methodRules.ts';
import { guidanceFor } from '../server/services/research/guidance.ts';

let userId: string;
let otherProjectId: string;

beforeEach(async () => {
  const fresh = await freshProject();
  otherProjectId = fresh.project.id;
  resetMethodRuleCache();
  userId = (
    await createUser({
      email: `methods-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'The owner',
      password: 'correct horse battery staple',
    })
  ).id;
});

async function goalPacket(projectId: string, key: string): Promise<string> {
  const layer = (await listLayers(projectId))[0]!;
  const goal = await createResearchGoal({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: `Methods ${key}`,
    maxPackets: 2,
    maxFragments: 3,
    deadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'p',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 't',
    assignment: 'a',
    provider: 'WORKER',
    autoApprove: false,
    goal: { goalId: goal.id, packetKey: key },
  } as Parameters<typeof createOrchestration>[0]);
  return orchestration.id;
}

async function claim(
  orchestrationId: string,
  text: string,
  options: { accepted?: boolean; contested?: boolean } = {},
): Promise<void> {
  const [row] = await insertClaims([
    {
      orchestrationId,
      fragmentId: null,
      passId: null,
      passKey: 'SYNTHESIS',
      claim: text,
      sourceUrl: 'https://example.org/method',
      sourceTitle: 'Method',
      sourcePublisher: 'Example',
      sourceDate: '2026-10-01',
      evidenceExcerpt: text,
      evidenceLocator: null,
      evidenceLane: null,
      retrievedAt: null,
      confidence: 0.8,
      contradictionState: options.contested ? 'CONTESTED' : 'UNCHALLENGED',
      validationState: 'SOURCED',
      validationDetail: null,
      sourced: true,
      accepted: options.accepted !== false,
      contentHash: `hash-${text}`,
    },
  ]);
  expect(row).toBeDefined();
}

describe('the DR_1 notes', () => {
  it('ride with every fragment pass and not with a planning pass', () => {
    const fragment = composeGuidance({
      fragment: { fragmentKey: 'payer', question: 'Who pays for this?' },
      siblings: [],
      reachability: [],
      lessons: [],
    });
    expect(fragment.text).toContain(DEMAND_EVIDENCE_NOTE);
    expect(fragment.text).toContain(DECISIVE_ASSUMPTION_NOTE);
    const planning = composeGuidance({ fragment: null, siblings: [], reachability: [], lessons: [] });
    expect(planning.text).not.toContain(DEMAND_EVIDENCE_NOTE);
    expect(planning.text).not.toContain(DECISIVE_ASSUMPTION_NOTE);
  });
});

describe('method rules', () => {
  it('reach a worker in another project from an architecture research goal', async () => {
    const architecture = await ensureArchitectureScope();
    const packet = await goalPacket(architecture.id, 'round-1');
    await claim(packet, 'A paid pilot is stronger demand evidence than a survey.');
    const guidance = await guidanceFor({
      projectId: otherProjectId,
      fragment: null,
      siblings: [],
      surface: null,
    });
    expect(guidance.methodRules.map((entry) => entry.rule)).toEqual([
      'A paid pilot is stronger demand evidence than a survey.',
    ]);
    expect(guidance.text).toContain('METHOD RULES BRAIN RESEARCHED');
    expect(guidance.text).toContain('https://example.org/method');
  });

  it('leave out rejected, contested and non-architecture claims', async () => {
    const architecture = await ensureArchitectureScope();
    const packet = await goalPacket(architecture.id, 'round-1');
    await claim(packet, 'rejected', { accepted: false });
    await claim(packet, 'contested', { contested: true });
    const elsewhere = await goalPacket(otherProjectId, 'round-1');
    await claim(elsewhere, 'a market fact, not a method');
    expect(await readMethodRules()).toEqual([]);
  });

  it('are bounded', async () => {
    const architecture = await ensureArchitectureScope();
    const packet = await goalPacket(architecture.id, 'round-1');
    for (let i = 0; i < MAX_GUIDANCE_METHOD_RULES + 3; i += 1) await claim(packet, `rule ${i}`);
    expect(await readMethodRules()).toHaveLength(MAX_GUIDANCE_METHOD_RULES);
  });
});

describe('choosing which method rules a worker reads', () => {
  const row = (claim: string, topic: string, question: string) => ({
    claim,
    source_url: null,
    topic_key: topic,
    topic_question: question,
  });

  it('puts the rules about this question first, newest first among equals', async () => {
    const { selectMethodRules } = await import('../server/services/research/methodRules.ts');
    const pool = [
      row('Newest rule about pricing from rate cards', 'm05', 'Pricing from public information'),
      row('A source that publishes its method is more reliable', 'm06', 'Judging whether a source can be trusted'),
      row('Undated market figures are unreliable sources', 'm06', 'Judging whether a source can be trusted'),
    ];
    const chosen = selectMethodRules(pool, 'Which source can be trusted here?');
    expect(chosen.map((entry) => entry.rule).slice(0, 2)).toEqual([
      'A source that publishes its method is more reliable',
      'Undated market figures are unreliable sources',
    ]);
  });

  it('lets no one method question fill the block, and drops repeats', async () => {
    const { selectMethodRules, MAX_RULES_PER_TOPIC } = await import('../server/services/research/methodRules.ts');
    const pool = [
      ...Array.from({ length: 10 }, (_, i) => row(`pricing rule ${i}`, 'm05', 'pricing')),
      row('pricing rule 0', 'm07', 'opportunities'),
      row('an opportunity rule', 'm07', 'opportunities'),
    ];
    const chosen = selectMethodRules(pool, 'pricing');
    expect(chosen.filter((entry) => entry.rule.startsWith('pricing rule'))).toHaveLength(MAX_RULES_PER_TOPIC);
    expect(chosen.map((entry) => entry.rule)).toContain('an opportunity rule');
  });
});

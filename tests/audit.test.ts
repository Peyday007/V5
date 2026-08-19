/**
 * The dynamic audit engine (spec section 26).
 *
 * Every scenario drives a scripted provider, so the question under test is
 * always "given this model output, what does the platform do?" — which is the
 * only question that matters for a system whose whole premise is that model
 * prose must never mutate project state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject, teardown, type TestProject } from './helpers.ts';
import type {
  AIProvider,
  AuditRequest,
  AuditResponse,
  ChatRequest,
  ChatResponse,
  ProviderStatus,
  ResearchRequest,
  ResearchResponse,
} from '../server/providers/types.ts';
import { AuditFailure, runDynamicAudit } from '../server/services/audit/pipeline.ts';
import { buildAuditContext } from '../server/services/audit/context.ts';
import { parseJudgePass, parsePrimaryPass } from '../server/services/audit/schema.ts';
import { computeLayerState } from '../server/services/stateEngine.ts';
import { buildPlan } from '../server/services/planner.ts';
import { listAuditsByLayer, listPipelinePasses } from '../server/repos/audits.ts';
import { getDocument } from '../server/repos/documents.ts';
import { handleChatMessage } from '../server/services/agent/chat.ts';
import { getAuditProfile } from '../server/domain/auditProfile.ts';

let fixture: TestProject;

beforeEach(() => {
  fixture = freshProject();
});
afterEach(() => {
  teardown();
});

// ---------------------------------------------------------------------------
// A provider whose answer for each pass the test decides
// ---------------------------------------------------------------------------

interface Script {
  primary?: unknown | string;
  adversarial?: unknown | string;
  judge?: unknown | string;
  /** Throw on this pass instead of answering. */
  throwOn?: 'PRIMARY' | 'ADVERSARIAL' | 'JUDGE';
}

function fence(payload: unknown): string {
  return typeof payload === 'string' ? payload : ['```json', JSON.stringify(payload), '```'].join('\n');
}

const OK_PRIMARY = {
  assignment_satisfied: 'YES',
  requirement_findings: [],
  structural_findings: [],
  boundary_findings: [],
  consistency_findings: [],
  candidate_gaps: [],
  notes: '',
};

const OK_ADVERSARIAL = { attacks: [], strongest_reason_not_to_advance: '' };

function judge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: 'PASS',
    summary: 'The artifact does what it was asked to do.',
    gap_classifications: [],
    required_patches: [],
    other_layer_handoffs: [],
    blocking_dependencies: [],
    synthesis_ready: false,
    freeze_ready: false,
    confidence: 0.8,
    foundational_gap_count: 0,
    targeted_research_runs_required: 0,
    next_action: 'Run World Model v1B.',
    ...overrides,
  };
}

class ScriptedProvider implements AIProvider {
  readonly name = 'scripted';
  readonly prompts: { passKey: string; prompt: string }[] = [];
  #script: Script;

  constructor(script: Script) {
    this.#script = script;
  }

  async audit(request: AuditRequest): Promise<AuditResponse> {
    const passKey = /^BRAIN AUDIT PASS: (\w+)/m.exec(request.prompt)?.[1] ?? 'UNKNOWN';
    this.prompts.push({ passKey, prompt: request.prompt });
    if (this.#script.throwOn === passKey) {
      throw new Error(`scripted provider failure on ${passKey}`);
    }
    if (passKey === 'PRIMARY' || passKey === 'EXTRACTION') {
      return { text: fence(this.#script.primary ?? OK_PRIMARY), externalResponseId: null };
    }
    if (passKey === 'ADVERSARIAL') {
      return { text: fence(this.#script.adversarial ?? OK_ADVERSARIAL), externalResponseId: null };
    }
    return { text: fence(this.#script.judge ?? judge()), externalResponseId: null };
  }

  async chat(): Promise<ChatResponse> {
    throw new Error('not used');
  }
  async runResearch(): Promise<ResearchResponse> {
    throw new Error('not used');
  }
  getStatus(): ProviderStatus {
    return {
      name: this.name,
      available: true,
      reason: 'scripted for tests',
      model: null,
      capabilities: { chat: false, research: false, audit: true },
    };
  }
}

/** Audit one document with a scripted provider. */
function auditDocument(layerName: string, version: string, script: Script) {
  const document = addDocument(fixture, layerName, version, {
    contents: `${layerName} ${version}\n\nSubstantive body text for the auditor to read.`,
  });
  return runDynamicAudit({
    mode: 'SINGLE_DOCUMENT',
    layerId: fixture.layerByName(layerName).id,
    documentId: document.id,
    provider: new ScriptedProvider(script),
  });
}

// ---------------------------------------------------------------------------

describe('assignment failure', () => {
  it('does not PASS a report that omitted a required section', async () => {
    const outcome = await auditDocument('World Model', 'v1', {
      primary: {
        ...OK_PRIMARY,
        assignment_satisfied: 'NO',
        requirement_findings: ['The requested rights-bundle section is absent entirely.'],
      },
      judge: judge({
        verdict: 'REDO',
        summary: 'A major requested section is missing, so the assignment was not performed.',
        next_action: 'Redo World Model v1 with the rights-bundle section included.',
      }),
    });

    expect(outcome.audit.verdict).toBe('REDO');
    expect(outcome.audit.verdict).not.toBe('PASS');
    expect(outcome.layerState.status).toBe('MORE_RESEARCH_REQUIRED');
  });
});

describe('the difference between "more could be" and "more is required"', () => {
  it('does not open research because more examples would be nice', async () => {
    const outcome = await auditDocument('World Model', 'v1', {
      adversarial: {
        attacks: [
          {
            attack: 'More worked examples from other industries would strengthen this.',
            assessment: 'NOT_MATERIAL',
            reasoning: 'The architecture already generalises; examples are illustration, not foundation.',
          },
        ],
        strongest_reason_not_to_advance: '',
      },
      judge: judge({
        gap_classifications: [
          {
            classification: 'OPTIONAL_IMPROVEMENT',
            title: 'More worked examples',
            detail: 'Additional industry examples would aid readers.',
            justification: 'Illustrative only; the architecture already generalises.',
          },
        ],
      }),
    });

    expect(outcome.audit.verdict).toBe('PASS');
    expect(outcome.audit.targetedResearchRunsRequired).toBe(0);
    expect(outcome.audit.foundationalGapCount).toBe(0);
    expect(outcome.researchCandidates).toHaveLength(0);
  });

  it('refuses a MORE_RESEARCH verdict that names no unresolved question', async () => {
    // A verdict demanding research without stating the question is exactly how
    // an auditor manufactures endless work.
    await expect(
      auditDocument('World Model', 'v1', {
        judge: judge({ verdict: 'MORE_RESEARCH', gap_classifications: [] }),
      }),
    ).rejects.toBeInstanceOf(AuditFailure);
  });
});

describe('gap ownership', () => {
  it('routes a profitability gap out of Discovery instead of holding it open', async () => {
    const outcome = await auditDocument('Discovery Logic', 'v1', {
      judge: judge({
        verdict: 'PASS',
        summary: 'Discovery is sound. One issue belongs to another layer.',
        gap_classifications: [
          {
            classification: 'OTHER_LAYER',
            title: 'No profitability calculation',
            detail: 'The report does not decide whether pursuing a signal is economically worthwhile.',
            justification: 'Discovery stops at observability; economic defensibility is Qualification.',
            owning_layer: 'Qualification Logic',
          },
        ],
        other_layer_handoffs: ['Qualification Logic: profitability of a discovered opportunity.'],
        next_action: 'Run Discovery Logic v1B.',
      }),
    });

    expect(outcome.audit.verdict).toBe('PASS');
    expect(outcome.audit.gaps).toHaveLength(1);
    expect(outcome.audit.gaps[0]?.classification).toBe('OTHER_LAYER');
    // The handoff resolves to the real layer, not just a name in prose.
    expect(outcome.audit.gaps[0]?.owningLayerName).toBe('Qualification Logic');
    expect(outcome.audit.gaps[0]?.owningLayerId).toBe(fixture.layerByName('Qualification Logic').id);
    // Discovery is not kept open for it.
    expect(outcome.audit.targetedResearchRunsRequired).toBe(0);
    expect(outcome.researchCandidates).toHaveLength(0);
  });

  it('refuses an OTHER_LAYER gap that names no owning layer', async () => {
    await expect(
      auditDocument('Discovery Logic', 'v1', {
        judge: judge({
          gap_classifications: [
            {
              classification: 'OTHER_LAYER',
              title: 'Something belongs elsewhere',
              detail: 'Unclear where.',
              justification: 'Not this layer.',
            },
          ],
        }),
      }),
    ).rejects.toBeInstanceOf(AuditFailure);
  });
});

describe('non-foundational classifications never block', () => {
  it('treats an unspecified database schema as IMPLEMENTATION_DETAIL', async () => {
    const outcome = await auditDocument('Qualification Logic', 'v1', {
      judge: judge({
        verdict: 'READY_FOR_SYNTHESIS',
        summary: 'The conceptual architecture is complete.',
        synthesis_ready: true,
        gap_classifications: [
          {
            classification: 'IMPLEMENTATION_DETAIL',
            title: 'Database schema unspecified',
            detail: 'No tables or field types are given for the qualification record.',
            justification: 'Needed when building, not to complete the conceptual foundation.',
          },
        ],
        next_action: 'Create Qualification Logic v3.1.',
      }),
    });

    expect(outcome.audit.verdict).toBe('READY_FOR_SYNTHESIS');
    expect(outcome.audit.foundationalGapCount).toBe(0);
    expect(outcome.layerState.status).toBe('SYNTHESIS_READY');
  });

  it('lets a global layer synthesise while a domain plug-in remains outstanding', async () => {
    const outcome = await auditDocument('Qualification Logic', 'v1', {
      judge: judge({
        verdict: 'READY_FOR_SYNTHESIS',
        summary: 'Global qualification is complete; healthcare specifics are a plug-in.',
        synthesis_ready: true,
        gap_classifications: [
          {
            classification: 'DOMAIN_PLUGIN',
            title: 'Healthcare-specific qualification rules absent',
            detail: 'Regulated-care rules are not enumerated.',
            justification: 'Global architecture is complete; specific domains attach later.',
          },
        ],
        next_action: 'Create Qualification Logic v3.1.',
      }),
    });

    expect(outcome.audit.verdict).toBe('READY_FOR_SYNTHESIS');
    expect(outcome.layerState.status).toBe('SYNTHESIS_READY');
  });

  it('does not hold research open for empirical tuning', async () => {
    const outcome = await auditDocument('Decision Routing Rules', 'v1', {
      judge: judge({
        gap_classifications: [
          {
            classification: 'EMPIRICAL_TUNING',
            title: 'Routing thresholds uncalibrated',
            detail: 'The cut-offs need real outcome data.',
            justification: 'Calibration requires operating data, not more desk research.',
          },
        ],
        next_action: 'Run Decision Routing Rules v1B.',
      }),
    });
    expect(outcome.audit.verdict).toBe('PASS');
    expect(outcome.audit.targetedResearchRunsRequired).toBe(0);
  });
});

describe('a genuine foundational gap', () => {
  it('holds the layer open and produces a bounded research candidate', async () => {
    const outcome = await auditDocument('World Model', 'v1', {
      judge: judge({
        verdict: 'MORE_RESEARCH',
        summary: 'The model cannot represent claims, liens or priority between competing creditors.',
        gap_classifications: [
          {
            classification: 'FOUNDATIONAL_GAP',
            title: 'No claim-priority topology',
            detail:
              'Secured transactions, liens and competing claims on the same object cannot be ' +
              'expressed, so any downstream layer reasoning about settlement will be wrong.',
            justification:
              'A major recurring commercial case cannot be represented at all; later layers would ' +
              'inherit the error.',
            research_question:
              'How should claims, liens, encumbrance and priority between competing claimants be ' +
              'represented in the world model?',
            expected_contribution: 'A claim-priority topology usable by Qualification and Execution.',
          },
        ],
        foundational_gap_count: 1,
        next_action: 'Run World Model v1B on claim priority and encumbrance.',
      }),
    });

    expect(outcome.audit.verdict).toBe('MORE_RESEARCH');
    expect(outcome.audit.foundationalGapCount).toBe(1);
    expect(outcome.layerState.status).toBe('MORE_RESEARCH_REQUIRED');

    // Bounded, and carrying its own question — not a speculative pile of runs.
    expect(outcome.researchCandidates).toHaveLength(1);
    expect(outcome.researchCandidates[0]?.researchQuestion).toContain('priority');
    expect(outcome.audit.nextAction).toContain('World Model v1B');
  });
});

describe('the adversarial pass', () => {
  it('can overturn a generous primary audit', async () => {
    const outcome = await auditDocument('World Model', 'v1', {
      primary: { ...OK_PRIMARY, assignment_satisfied: 'YES' },
      adversarial: {
        attacks: [
          {
            attack: 'The document asserts universality but every example is a home-services deal.',
            assessment: 'VALID',
            reasoning: 'The generality claim (G5) is unsupported by the evidence presented.',
          },
        ],
        strongest_reason_not_to_advance: 'The universality claim is unsupported.',
      },
      judge: judge({
        verdict: 'MORE_RESEARCH',
        summary: 'The primary audit missed an unsupported universality claim.',
        gap_classifications: [
          {
            classification: 'FOUNDATIONAL_GAP',
            title: 'Unsupported universality',
            detail: 'Every worked example is one industry, yet the model claims general coverage.',
            justification: 'G5: global architecture must survive unfamiliar industries.',
            research_question: 'Does the model hold in commodity trading, licensing and logistics?',
          },
        ],
        foundational_gap_count: 1,
        next_action: 'Run World Model v1B testing the model against three unfamiliar industries.',
      }),
    });

    expect(outcome.audit.verdict).toBe('MORE_RESEARCH');
    // The attack is kept whether or not it was upheld.
    const attacks = outcome.audit.findings.filter((f) => f.findingType === 'ADVERSARIAL_FINDING');
    expect(attacks).toHaveLength(1);
    expect(attacks[0]?.payload['material']).toBe(true);
  });

  it('does not let cosmetic criticism block a pass', async () => {
    const outcome = await auditDocument('World Model', 'v1', {
      adversarial: {
        attacks: [
          {
            attack: 'The section ordering could be clearer.',
            assessment: 'NOT_MATERIAL',
            reasoning: 'Presentation, not architecture.',
          },
        ],
        strongest_reason_not_to_advance: '',
      },
      judge: judge({ verdict: 'PASS' }),
    });

    expect(outcome.audit.verdict).toBe('PASS');
    const attacks = outcome.audit.findings.filter((f) => f.findingType === 'ADVERSARIAL_FINDING');
    expect(attacks[0]?.payload['material']).toBe(false);
  });
});

describe('missing dependency', () => {
  it('returns BLOCKED naming what is absent', async () => {
    const outcome = await auditDocument('Execution Playbooks', 'v1', {
      judge: judge({
        verdict: 'BLOCKED',
        summary: 'The sibling this work depends on has not been produced.',
        blocking_dependencies: ['Execution Playbooks v1B'],
        next_action: 'Upload the missing Execution Playbooks v1B.',
      }),
    });

    expect(outcome.audit.verdict).toBe('BLOCKED');
    expect(outcome.audit.findings.some((f) => f.content === 'Execution Playbooks v1B')).toBe(true);
    expect(outcome.layerState.status).toBe('BLOCKED');
  });

  it('refuses a BLOCKED verdict that names nothing', async () => {
    await expect(
      auditDocument('Execution Playbooks', 'v1', {
        judge: judge({ verdict: 'BLOCKED', blocking_dependencies: [] }),
      }),
    ).rejects.toBeInstanceOf(AuditFailure);
  });
});

describe('full-layer packet audit', () => {
  it('reads every completed document and can clear the layer for synthesis', async () => {
    const packet = ['v1', 'v1B', 'v1C', 'v1D'];
    for (const version of packet) {
      addDocument(fixture, 'Decision Routing Rules', version, {
        contents: `Decision Routing Rules ${version}\n\nRoute comparison, gates, tradeoffs, authority.`,
      });
    }
    const layer = fixture.layerByName('Decision Routing Rules');
    const provider = new ScriptedProvider({
      judge: judge({
        verdict: 'READY_FOR_SYNTHESIS',
        summary: 'The packet is complete and internally consistent.',
        synthesis_ready: true,
        next_action: 'Create Decision Routing Rules v3.1.',
      }),
    });

    const outcome = await runDynamicAudit({
      mode: 'LAYER_PACKET',
      layerId: layer.id,
      provider,
    });

    expect(outcome.audit.mode).toBe('LAYER_PACKET');
    expect(outcome.audit.auditedDocumentIds).toHaveLength(4);
    expect(outcome.audit.verdict).toBe('READY_FOR_SYNTHESIS');
    expect(outcome.layerState.status).toBe('SYNTHESIS_READY');

    // The packet really was put in front of the model, not just its titles.
    const judgePrompt = provider.prompts.find((p) => p.passKey === 'JUDGE')?.prompt ?? '';
    for (const version of packet) {
      expect(judgePrompt).toContain(`Decision Routing Rules ${version}`);
    }
    expect(judgePrompt).toContain('AUDIT MODE: LAYER_PACKET');

    // And the planner now says what to do next.
    const plan = buildPlan(fixture.project.id);
    expect(plan.nextBestActionText.length).toBeGreaterThan(0);
  });

  it('freezes the layer when the canonical synthesis passes its final audit', async () => {
    for (const version of ['v1', 'v1B']) addDocument(fixture, 'Monetization Logic', version);
    addDocument(fixture, 'Monetization Logic', 'v3.1', { documentType: 'SYNTHESIS' });
    const layer = fixture.layerByName('Monetization Logic');

    const outcome = await runDynamicAudit({
      mode: 'LAYER_PACKET',
      layerId: layer.id,
      provider: new ScriptedProvider({
        judge: judge({
          verdict: 'READY_TO_FREEZE',
          summary: 'The canonical synthesis is sufficient and no global foundational gap remains.',
          freeze_ready: true,
          next_action: 'Freeze Monetization Logic at v3.1.',
        }),
      }),
    });

    expect(outcome.audit.verdict).toBe('READY_TO_FREEZE');
    expect(outcome.layerState.status).toBe('FROZEN');
    expect(computeLayerState(layer.id).canonicalName).toBe('Monetization Logic v3.1');
  });
});

describe('zero-trust: invalid model output never moves the project', () => {
  async function expectNoStateChange(script: Script): Promise<void> {
    const document = addDocument(fixture, 'Taxonomy', 'v1');
    const layer = fixture.layerByName('Taxonomy');
    const before = computeLayerState(layer.id).status;

    await expect(
      runDynamicAudit({
        mode: 'SINGLE_DOCUMENT',
        layerId: layer.id,
        documentId: document.id,
        provider: new ScriptedProvider(script),
      }),
    ).rejects.toBeInstanceOf(AuditFailure);

    expect(computeLayerState(layer.id).status).toBe(before);
    expect(listAuditsByLayer(layer.id)).toHaveLength(0);
    expect(getDocument(document.id)?.status).toBe('COMPLETE');
  }

  it('rejects a verdict that is not one of the nine', async () => {
    await expectNoStateChange({ judge: judge({ verdict: 'LOOKS_GOOD_TO_ME' }) });
  });

  it('never converts a negated verdict into approval', async () => {
    // The single most dangerous failure: "not ready for synthesis" must not
    // become READY_FOR_SYNTHESIS by substring match.
    await expectNoStateChange({ judge: judge({ verdict: 'not ready for synthesis' }) });
  });

  it('rejects a verdict field that lists every option', async () => {
    await expectNoStateChange({
      judge: judge({ verdict: 'PASS | PATCH | REDO | READY_FOR_SYNTHESIS | BLOCKED' }),
    });
  });

  it('rejects an echoed template', async () => {
    await expectNoStateChange({
      judge: judge({ verdict: 'PASS', summary: 'one short paragraph', next_action: '...' }),
    });
  });

  it('rejects prose with no JSON at all', async () => {
    await expectNoStateChange({ judge: 'This report looks broadly fine to me. I would pass it.' });
  });

  it('rejects counts that disagree with the classified gaps', async () => {
    await expectNoStateChange({
      judge: judge({
        verdict: 'MORE_RESEARCH',
        foundational_gap_count: 0,
        gap_classifications: [
          {
            classification: 'FOUNDATIONAL_GAP',
            title: 'Missing concept',
            detail: 'Something important is absent.',
            justification: 'It would weaken the foundation.',
            research_question: 'What is it?',
          },
        ],
      }),
    });
  });

  it('refuses to advance while a foundational gap is open', async () => {
    // Approval is never inferred: PASS cannot coexist with an unresolved gap.
    await expectNoStateChange({
      judge: judge({
        verdict: 'PASS',
        foundational_gap_count: 1,
        gap_classifications: [
          {
            classification: 'FOUNDATIONAL_GAP',
            title: 'Missing concept',
            detail: 'Something important is absent.',
            justification: 'It would weaken the foundation.',
            research_question: 'What is it?',
          },
        ],
      }),
    });
  });

  it('treats a provider error as a failed audit', async () => {
    await expectNoStateChange({ throwOn: 'JUDGE' });
  });

  it('keeps the raw response of a failed pass for debugging', async () => {
    const document = addDocument(fixture, 'Taxonomy', 'v1');
    const layer = fixture.layerByName('Taxonomy');
    let failure: AuditFailure | null = null;
    try {
      await runDynamicAudit({
        mode: 'SINGLE_DOCUMENT',
        layerId: layer.id,
        documentId: document.id,
        provider: new ScriptedProvider({ judge: judge({ verdict: 'NONSENSE' }) }),
      });
    } catch (error) {
      failure = error as AuditFailure;
    }
    expect(failure).toBeInstanceOf(AuditFailure);
    expect(failure?.passKey).toBe('JUDGE');
    const passes = listPipelinePasses(failure!.pipelineId);
    expect(passes.some((pass) => pass.rawResponse?.includes('NONSENSE'))).toBe(true);
    expect(passes.some((pass) => !pass.ok)).toBe(true);
  });

  it('blocks rather than judges an artifact it cannot read', async () => {
    const document = addDocument(fixture, 'Taxonomy', 'v1', { withFile: false });
    const layer = fixture.layerByName('Taxonomy');
    await expect(
      runDynamicAudit({
        mode: 'SINGLE_DOCUMENT',
        layerId: layer.id,
        documentId: document.id,
        provider: new ScriptedProvider({}),
      }),
    ).rejects.toThrow(/cannot read/i);
  });
});

describe('question safety still holds', () => {
  it('asking whether something is ready to freeze does not freeze it', () => {
    addDocument(fixture, 'World Model', 'v3.1', { documentType: 'SYNTHESIS' });
    const layer = fixture.layerByName('World Model');
    handleChatMessage({
      projectId: fixture.project.id,
      content: 'Is World Model ready to freeze?',
    });
    expect(computeLayerState(layer.id).status).not.toBe('FROZEN');
  });
});

describe('the audit context', () => {
  it('puts the exact assignment and the artifact in front of the auditor', async () => {
    const document = addDocument(fixture, 'Discovery Logic', 'v1', {
      contents: 'Discovery Logic v1\n\nDISTINCTIVE-MARKER-TEXT about open-web sensors.',
    });
    const provider = new ScriptedProvider({});
    await runDynamicAudit({
      mode: 'SINGLE_DOCUMENT',
      layerId: fixture.layerByName('Discovery Logic').id,
      documentId: document.id,
      provider,
    });

    const primaryPrompt = provider.prompts.find((p) => p.passKey === 'PRIMARY')?.prompt ?? '';
    expect(primaryPrompt).toContain('DISTINCTIVE-MARKER-TEXT');
    // The layer's own criteria and boundary are stated, not assumed.
    expect(primaryPrompt).toContain('Discovery Logic');
    expect(primaryPrompt).toContain('demand-first discovery');
    expect(primaryPrompt).toContain('This layer does NOT own');
    // The other layers are named so a gap can be routed rather than researched here.
    expect(primaryPrompt).toContain('Qualification Logic');
    // And the global criteria travel with it.
    expect(primaryPrompt).toContain('G5');
  });

  it('marks oversized material for staged extraction instead of dropping it', () => {
    addDocument(fixture, 'Taxonomy', 'v1', { contents: 'x'.repeat(60_000) });
    const context = buildAuditContext({
      mode: 'SINGLE_DOCUMENT',
      layerId: fixture.layerByName('Taxonomy').id,
      documentId: addDocument(fixture, 'Taxonomy', 'v1B', { contents: 'y'.repeat(60_000) }).id,
      contentBudget: 1_000,
    });
    expect(context.requiresStagedExtraction).toBe(true);
    const artifact = context.artifacts[0];
    expect(artifact?.truncated).toBe(true);
    // Truncation is visible, and the link to the original is preserved.
    expect(artifact?.fullLength).toBeGreaterThan(artifact?.text.length ?? 0);
    expect(artifact?.filesystemPath).toBeTruthy();
  });
});

describe('the Deal Dispatch profile', () => {
  it('covers all eight layers and the fourteen global criteria', () => {
    const profile = getAuditProfile('deal-dispatch');
    expect(profile).not.toBeNull();
    expect(profile?.globalCriteria).toHaveLength(14);
    expect(profile?.layers.map((layer) => layer.name)).toEqual([
      'World Model',
      'Taxonomy',
      'Monetization Logic',
      'Discovery Logic',
      'Qualification Logic',
      'Execution Playbooks',
      'Decision Routing Rules',
      'Learning Evaluation',
    ]);
    // Every layer states what it does NOT own, which is what makes a boundary
    // audit possible at all.
    for (const layer of profile?.layers ?? []) {
      expect(layer.owns.length).toBeGreaterThan(0);
      expect(layer.doesNotOwn.length).toBeGreaterThan(0);
      expect(layer.auditFor.length).toBeGreaterThan(0);
    }
    // Taxonomy carries its "do not freeze early" caution.
    const taxonomy = profile?.layers.find((layer) => layer.slug === 'taxonomy');
    expect(taxonomy?.cautions.join(' ')).toMatch(/not prematurely freeze/i);
  });
});

describe('schema validation in isolation', () => {
  it('accepts a well-formed judge object', () => {
    const parsed = parseJudgePass(JSON.stringify(judge()));
    expect(parsed.ok).toBe(true);
  });

  it('reads the last JSON block when the model echoes the template first', () => {
    const reply = [
      'Here is the shape you asked for:',
      '```json',
      JSON.stringify({ verdict: 'PASS | PATCH | REDO', summary: 'one short paragraph' }),
      '```',
      'And my actual answer:',
      '```json',
      JSON.stringify(judge({ verdict: 'REDO', summary: 'Section 3 is a stub.', next_action: 'Redo it.' })),
      '```',
    ].join('\n');
    const parsed = parseJudgePass(reply);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.verdict).toBe('REDO');
  });

  it('rejects a non-boolean synthesis_ready rather than coercing it', () => {
    const parsed = parseJudgePass(JSON.stringify(judge({ synthesis_ready: 'true' })));
    expect(parsed.ok).toBe(false);
  });

  it('requires a research question on a targeted research gap', () => {
    const parsed = parseJudgePass(
      JSON.stringify(
        judge({
          verdict: 'MORE_RESEARCH',
          targeted_research_runs_required: 1,
          gap_classifications: [
            {
              classification: 'TARGETED_RESEARCH_GAP',
              title: 'Something',
              detail: 'Something bounded.',
              justification: 'It matters.',
            },
          ],
        }),
      ),
    );
    expect(parsed.ok).toBe(false);
  });

  it('validates the primary pass assignment verdict strictly', () => {
    expect(parsePrimaryPass(JSON.stringify({ ...OK_PRIMARY, assignment_satisfied: 'MOSTLY' })).ok).toBe(false);
    expect(parsePrimaryPass(JSON.stringify(OK_PRIMARY)).ok).toBe(true);
  });
});

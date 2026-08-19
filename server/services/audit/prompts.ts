/**
 * The audit prompts (sections 3-12, 18, 19).
 *
 * Each pass has a separate role and a separate prompt. That separation is the
 * point: a single "score this report" call reliably produces agreeable prose,
 * whereas a primary auditor, an adversarial critic and a final judge disagree
 * with each other in useful ways.
 *
 * Every prompt ends by demanding one JSON object, because only structured
 * output is allowed to reach project state.
 */
import type { AuditContext, ArtifactContent } from './context.ts';
import { GAP_CATEGORY_RULES } from '../../domain/auditProfile.ts';
import { AUDIT_VERDICTS } from '../../domain/types.ts';

/** Header every prompt carries, so a provider can tell the passes apart. */
export function passHeader(passKey: string, mode: string): string {
  return `BRAIN AUDIT PASS: ${passKey}\nAUDIT MODE: ${mode}`;
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `  - ${item}`).join('\n');
}

function renderArtifact(artifact: ArtifactContent, index: number): string {
  const head = `--- ARTIFACT ${index + 1}: ${artifact.canonicalName} (${artifact.documentType}, ${artifact.status}) ---`;
  if (artifact.unavailableReason) {
    return `${head}\n[NO READABLE CONTENT] ${artifact.unavailableReason}`;
  }
  const note = artifact.truncated
    ? `\n[TRUNCATED: showing ${artifact.text.length} of ${artifact.fullLength} characters. ` +
      'Judge only what you can see; do not assume the remainder is missing or defective.]'
    : '';
  return `${head}${note}\n${artifact.text}`;
}

/** The project's rules, rendered once and reused by every pass. */
export function profileSection(context: AuditContext): string {
  const { profile, layerCriteria, layer } = context;
  if (!profile) {
    return [
      'PROJECT AUDIT CRITERIA',
      'This project has no configured audit profile, so judge against the assignment and',
      'ordinary standards of architectural completeness only. Do not invent project-specific rules.',
    ].join('\n');
  }

  const lines: string[] = [
    'PROJECT AUDIT CRITERIA',
    '',
    profile.premise,
    '',
    'GLOBAL CRITERIA',
    ...profile.globalCriteria.map((criterion) => `  ${criterion.id} ${criterion.name}: ${criterion.statement}`),
    '',
  ];

  if (layerCriteria) {
    lines.push(
      `LAYER UNDER AUDIT: ${layerCriteria.name}`,
      `  This layer owns: ${layerCriteria.owns}`,
      `  This layer does NOT own: ${layerCriteria.doesNotOwn}`,
      '',
      '  Audit whether the work can actually represent:',
      bullets(layerCriteria.auditFor),
      '',
      '  Deliberate limits on what may be demanded of this layer:',
      bullets(layerCriteria.cautions),
      '',
    );
  } else {
    lines.push(`LAYER UNDER AUDIT: ${layer.name} (no layer-specific criteria configured)`, '');
  }

  lines.push(
    'THE OTHER LAYERS (a gap belonging to one of these is a handoff, not research here)',
    ...context.otherLayers.map((other) => `  ${other.name}${other.owns ? `: ${other.owns}` : ''}`),
    '',
    'WHEN MORE RESEARCH IS ACTUALLY REQUIRED',
    ...profile.researchRule.map((rule) => `  - ${rule}`),
  );

  return lines.join('\n');
}

function assignmentSection(context: AuditContext): string {
  const lines: string[] = ['THE ASSIGNMENT'];
  if (context.assignmentPrompt) {
    lines.push(
      'This is the exact prompt the artifact was produced from. Judge the artifact against it.',
      '',
      context.assignmentPrompt,
    );
  } else {
    lines.push(
      'No recorded prompt exists for this artifact (it was imported rather than run through the',
      'platform). Judge it against the layer criteria and the surrounding packet instead, and do',
      'not penalise it for failing an assignment nobody can produce.',
    );
  }
  if (context.requiredAttachments.length > 0) {
    lines.push('', 'REQUIRED ATTACHMENTS (source material it was told to consume)', bullets(context.requiredAttachments));
  }
  return lines.join('\n');
}

function stateSection(context: AuditContext): string {
  const { layerState, dependencies } = context;
  const lines = [
    'CURRENT LAYER STATE (from the database and filesystem, not from any model)',
    `  Layer: ${context.layer.name}`,
    `  Status: ${layerState.status} — ${layerState.reason}`,
    `  Documents present: ${context.presentVersions.join(', ') || 'none'}`,
    `  Documents expected: ${context.expectedVersions.join(', ') || 'none declared'}`,
    `  Missing: ${context.missingVersions.join(', ') || 'none'}`,
    `  Source packet: ${dependencies.summary}`,
  ];
  if (dependencies.missing.length > 0) {
    lines.push(`  Missing dependencies: ${dependencies.missing.join(', ')}`);
  }
  if (dependencies.inconsistent.length > 0) {
    lines.push(`  Registered but file missing: ${dependencies.inconsistent.join(', ')}`);
  }
  if (context.parentFoundation.length > 0) {
    lines.push(
      '  Frozen foundations available to this layer:',
      ...context.parentFoundation.map((entry) => `    ${entry.layerName}: ${entry.canonicalName}`),
    );
  }
  if (context.previousAudits.length > 0) {
    lines.push('  Previous audit verdicts (newest first):');
    for (const audit of context.previousAudits) {
      lines.push(`    ${audit.createdAt.slice(0, 10)} ${audit.verdict} — ${audit.summary.slice(0, 160)}`);
    }
  }
  return lines.join('\n');
}

function artifactSection(context: AuditContext): string {
  const label = context.mode === 'LAYER_PACKET' ? 'THE LAYER PACKET' : 'THE ARTIFACT';
  const preamble =
    context.mode === 'LAYER_PACKET'
      ? [
          `Taken together, these ${context.artifacts.length} document(s) are the layer's entire current`,
          'research packet. Judge the packet as a whole: consider how the documents interact, not the',
          'average quality of each one.',
        ].join('\n')
      : 'This is the artifact under audit.';

  const body = context.artifacts.map(renderArtifact).join('\n\n');
  const siblings =
    context.siblings.length > 0
      ? [
          '',
          'SIBLING DOCUMENTS IN THIS LAYER (context, not under audit)',
          ...context.siblings.map(
            (sibling) =>
              `  ${sibling.canonicalName} (${sibling.status})` +
              (sibling.unavailableReason ? ` — ${sibling.unavailableReason}` : ''),
          ),
        ].join('\n')
      : '';

  return `${label}\n${preamble}\n\n${body}${siblings}`;
}

const GAP_CATEGORY_BLOCK = [
  'GAP CLASSIFICATION — every issue you raise MUST be classified as exactly one of:',
  ...GAP_CATEGORY_RULES.map((rule) => `  ${rule.classification}: ${rule.meaning}`),
  '',
  'Only FOUNDATIONAL_GAP and TARGETED_RESEARCH_GAP may keep a layer open for more research.',
  'The burden for a foundational gap is: would the missing concept materially weaken the',
  'foundation, or cause later layers or builds to reason incorrectly? If not, it is not one.',
].join('\n');

// ---------------------------------------------------------------------------
// Pass A — requirement + structural + boundary + dependency
// ---------------------------------------------------------------------------

export function buildPrimaryPrompt(context: AuditContext): string {
  return [
    passHeader('PRIMARY', context.mode),
    '',
    'You are the primary auditor of a layered research programme. Your job is not to score prose.',
    'It is to decide whether the work is actually strong enough to build on.',
    '',
    profileSection(context),
    '',
    assignmentSection(context),
    '',
    stateSection(context),
    '',
    artifactSection(context),
    '',
    'PERFORM FOUR ASSESSMENTS, IN ORDER.',
    '',
    '1. REQUIREMENT AUDIT — did the artifact accomplish the assignment it was given?',
    '   Check for: omitted major requested sections; superficial treatment of requested areas;',
    '   explicit research questions left unanswered; unsupported conclusions; missing required',
    '   evidence; failure to use the attached foundation material; output that merely restates the',
    '   prompt; research that drifted into another layer; contradictions with explicit instructions.',
    '   Answer YES, PARTIAL or NO.',
    '',
    '2. STRUCTURAL AUDIT — even if it followed the prompt, is the resulting architecture strong enough?',
    '   Look for: missing foundational concepts; over-compressed concepts; concepts incorrectly',
    '   collapsed together; hidden assumptions; states needing separate dimensions; missing actors,',
    '   relations or flows; missing failure states; incorrect universality claims; brittle',
    '   one-industry assumptions; structures that break under adversarial examples; major',
    '   commercially relevant cases that cannot be represented; architecture that describes but',
    '   cannot drive downstream decisions.',
    '   Do NOT manufacture gaps merely because more detail could exist.',
    '',
    '3. BOUNDARY AUDIT — for each gap, does THIS layer actually own it?',
    '   If another layer owns it, classify it OTHER_LAYER and name that layer. Do not open',
    '   research in this layer for a gap it does not own.',
    '',
    '4. DEPENDENCY / CONSISTENCY AUDIT — compare against the parent foundation, siblings, earlier',
    '   corrections, canonical terminology and previous audit findings. Classify each relation as',
    '   CONTRADICTION (materially incompatible claims), REFINEMENT (later work legitimately deepens',
    '   earlier work), SUPERSESSION (later work explicitly replaces an earlier concept),',
    '   PARALLEL_DETAIL (both can coexist) or FALSE_CONFLICT (different layers or abstraction levels',
    '   discussing different questions). Do not treat every wording difference as a contradiction.',
    '',
    GAP_CATEGORY_BLOCK,
    '',
    'Return ONE JSON object and nothing after it:',
    '{',
    '  "assignment_satisfied": "YES" | "PARTIAL" | "NO",',
    '  "requirement_findings": ["..."],',
    '  "structural_findings": ["..."],',
    '  "boundary_findings": ["..."],',
    '  "consistency_findings": [{"relation": "CONTRADICTION", "detail": "..."}],',
    '  "candidate_gaps": [{',
    '    "classification": "FOUNDATIONAL_GAP",',
    '    "title": "short name for the gap",',
    '    "detail": "what specifically is missing or wrong",',
    '    "justification": "why this classification and not another",',
    '    "owning_layer": "layer name, required when classification is OTHER_LAYER",',
    '    "research_question": "the specific unresolved question, required for TARGETED_RESEARCH_GAP",',
    '    "expected_contribution": "what a run answering it would add"',
    '  }],',
    '  "notes": "anything the judge needs that does not fit above"',
    '}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Pass B — adversarial critic
// ---------------------------------------------------------------------------

export function buildAdversarialPrompt(context: AuditContext, primaryRaw: string): string {
  return [
    passHeader('ADVERSARIAL', context.mode),
    '',
    'You are an adversarial critic. Assume the primary auditor was too generous.',
    'Find the strongest reason this work should NOT advance.',
    '',
    profileSection(context),
    '',
    assignmentSection(context),
    '',
    artifactSection(context),
    '',
    'THE PRIMARY AUDITOR SAID:',
    primaryRaw,
    '',
    'Attack the work on: major omissions; circular reasoning; unjustified completeness claims;',
    'unsupported universality; layer leakage; dependency gaps; missing edge cases; false confidence;',
    'weak source usage; hidden implementation assumptions; and architecture that could not survive',
    'unfamiliar commercial environments.',
    '',
    'Then judge YOUR OWN attacks honestly. For each one decide:',
    '  VALID        — this genuinely should stop the work advancing',
    '  NOT_MATERIAL — a real observation, but it does not require action now',
    '',
    'You must not manufacture endless research by listing imaginable improvements. An attack that',
    'amounts to "more examples would be nice", "another industry could be covered", "thresholds need',
    'calibration" or "the implementation is unspecified" is NOT_MATERIAL by definition.',
    '',
    'Return ONE JSON object and nothing after it:',
    '{',
    '  "attacks": [{"attack": "...", "assessment": "VALID" | "NOT_MATERIAL", "reasoning": "..."}],',
    '  "strongest_reason_not_to_advance": "one sentence, or empty if there is genuinely none"',
    '}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Pass C — final judge
// ---------------------------------------------------------------------------

export function buildJudgePrompt(
  context: AuditContext,
  primaryRaw: string,
  adversarialRaw: string,
): string {
  const profile = context.profile;
  return [
    passHeader('JUDGE', context.mode),
    '',
    'You are the final judge. You receive the assignment, the artifact, the project criteria, the',
    'primary audit and the adversarial critique, and you produce exactly one disposition.',
    '',
    profileSection(context),
    '',
    assignmentSection(context),
    '',
    stateSection(context),
    '',
    artifactSection(context),
    '',
    'PRIMARY AUDIT:',
    primaryRaw,
    '',
    'ADVERSARIAL CRITIQUE:',
    adversarialRaw,
    '',
    'You are not obliged to agree with either. Where the adversarial critic found something material',
    'that the primary auditor missed, act on it. Where the critic merely listed improvements, mark it',
    'aside and let the work advance.',
    '',
    GAP_CATEGORY_BLOCK,
    '',
    ...(profile
      ? [
          'SYNTHESIS RULE',
          ...profile.synthesisRule.map((rule) => `  - ${rule}`),
          '',
          'FREEZE RULE',
          ...profile.freezeRule.map((rule) => `  - ${rule}`),
          '',
        ]
      : []),
    `CHOOSE EXACTLY ONE VERDICT from: ${AUDIT_VERDICTS.join(', ')}`,
    '  PASS                — acceptable for its assigned purpose',
    '  KEEP                — acceptable and should be retained as-is',
    '  PATCH               — minor corrections required, but no new research run',
    '  REDO                — the assigned research was materially defective and should be rerun',
    '  MORE_RESEARCH       — one or more genuinely foundational targeted questions remain',
    '  READY_FOR_SYNTHESIS — sibling research suffices to produce the canonical synthesis',
    '  READY_TO_FREEZE     — the canonical layer is sufficient; no global foundational research remains',
    '  MISSING_DEPENDENCY  — a required input document does not exist yet',
    '  BLOCKED             — cannot advance until a named dependency or input arrives',
    '',
    'HARD RULES.',
    '  - The counts you report must equal the gaps you classify. They are cross-checked and a',
    '    mismatch fails the audit.',
    '  - PASS, KEEP, READY_FOR_SYNTHESIS and READY_TO_FREEZE are refused outright if any gap is',
    '    classified FOUNDATIONAL_GAP or TARGETED_RESEARCH_GAP. Resolve the contradiction by',
    '    reclassifying honestly or by choosing a non-advancing verdict.',
    '  - MORE_RESEARCH requires at least one FOUNDATIONAL_GAP or TARGETED_RESEARCH_GAP stating the',
    '    specific unresolved question.',
    '  - BLOCKED requires at least one entry in blocking_dependencies.',
    '  - next_action must be ONE concrete executable instruction, such as',
    '    "Run Discovery Logic v1G.", "Create Qualification Logic v3.1.",',
    '    "Patch World Model synthesis with custody and claim-priority topology; no additional research.",',
    '    or "Upload the missing Execution Playbooks v1B.".',
    '    Never "continue research" or "consider improving this section".',
    '',
    'Return ONE JSON object and nothing after it:',
    '{',
    '  "verdict": "...",',
    '  "summary": "one short paragraph stating what is true and what happens next",',
    '  "gap_classifications": [{',
    '    "classification": "...", "title": "...", "detail": "...", "justification": "...",',
    '    "owning_layer": "...", "research_question": "...", "expected_contribution": "..."',
    '  }],',
    '  "required_patches": ["..."],',
    '  "other_layer_handoffs": ["..."],',
    '  "blocking_dependencies": ["..."],',
    '  "synthesis_ready": false,',
    '  "freeze_ready": false,',
    '  "confidence": 0.0,',
    '  "foundational_gap_count": 0,',
    '  "targeted_research_runs_required": 0,',
    '  "next_action": "..."',
    '}',
  ].join('\n');
}

/**
 * Staged extraction (section 17): when the packet does not fit one call, each
 * document is reduced to findings FIRST, and the reconciliation pass reasons
 * over those findings with links back to the originals.
 */
export function buildExtractionPrompt(context: AuditContext, artifact: ArtifactContent): string {
  return [
    passHeader('EXTRACTION', context.mode),
    '',
    `Extract the auditable substance of one document from the ${context.layer.name} layer.`,
    'You are not judging it yet. Another pass will. Your job is to lose nothing that matters.',
    '',
    profileSection(context),
    '',
    renderArtifact(artifact, 0),
    '',
    'Report the concepts this document establishes, the claims it makes, the questions it answers,',
    'anything it explicitly leaves open, and any place it appears to contradict or supersede other',
    'work. Quote the specific wording for anything a later pass might need to judge.',
    '',
    'Return ONE JSON object and nothing after it:',
    '{',
    '  "assignment_satisfied": "YES" | "PARTIAL" | "NO",',
    '  "requirement_findings": ["what this document establishes or answers"],',
    '  "structural_findings": ["concepts it introduces, and anything structurally weak"],',
    '  "boundary_findings": ["anything that appears to belong to another layer"],',
    '  "consistency_findings": [{"relation": "REFINEMENT", "detail": "..."}],',
    '  "candidate_gaps": [],',
    '  "notes": "explicitly open questions, quoted where useful"',
    '}',
  ].join('\n');
}

/**
 * CLAIMS:SOURCE_PROBLEM — the two recurring rejections, "No source URL was given"
 * and "an organisation describing itself establishes its own claim", are told to
 * every worker in the evidence rules of both research briefs. Prompt text only:
 * nothing here touches the gate that judges the claims.
 */
import { describe, expect, it } from 'vitest';
import {
  buildBundledResearchPrompt,
  buildFragmentResearchPrompt,
} from '../server/services/research/prompts.ts';
import type { Layer, Project, ResearchFragment } from '../server/domain/types.ts';

const project = { id: 'prj_t', name: 'P', slug: 'p', description: 'd' } as unknown as Project;
const layer = { id: 'lay_t', name: 'L', slug: 'l', description: 'd' } as unknown as Layer;
const fragment = {
  id: 'frg_t',
  fragmentKey: 'licence',
  question: 'Is a licence required?',
  requiredEvidence: [{ id: 'registry', description: 'entry', necessity: 'REQUIRED' }],
  acceptableSourceTypes: ['official registry'],
  excludedSourceTypes: [],
  completionCriteria: ['an entry'],
  dependsOn: [],
  minIndependentSources: 1,
} as unknown as ResearchFragment;

const prompts: Record<string, string> = {
  fragment: buildFragmentResearchPrompt({ project, layer, fragment, dependencyClaims: [] }),
  bundled: buildBundledResearchPrompt({
    project,
    layer,
    fragments: [fragment],
    dependencyClaims: [],
    rationale: 'r',
  }),
};

describe.each(Object.entries(prompts))('%s research prompt', (_name, prompt) => {
  it('sends a claim with no source URL to "unresolved", not "claims"', () => {
    expect(prompt).toMatch(/NO SOURCE URL[\s\S]*belongs in "unresolved", never in "claims"/);
  });

  it('words a self-description as what the organisation says, not as fact', () => {
    expect(prompt).toMatch(/SELF-DESCRIPTION[\s\S]*SELF_REPORT/);
    expect(prompt).toContain('"X states that …"');
    expect(prompt).toContain('independent source you also cite');
  });
});

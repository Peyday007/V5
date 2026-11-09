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
import { validateClaim } from '../server/services/research/sources.ts';
import { effectiveStandard } from '../server/services/research/standards.ts';
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

/**
 * The prompt rules are only worth their words if the gate really refuses what
 * they forbid and really accepts what they prescribe. These run the production
 * validators on the claim shapes the rules talk about, so a change to either
 * side that breaks the correspondence fails here.
 */
describe('the rules match what the gate refuses', () => {
  it('refuses a claim with an empty or missing sourceUrl with the recorded reason', () => {
    for (const sourceUrl of [undefined, null, '', '   ']) {
      const v = validateClaim({ claim: 'The registry charges $50.', sourceUrl });
      expect(v.sourced).toBe(false);
      expect(v.validationState).toBe('NO_URL');
      expect(v.validationDetail).toBe(
        "No source URL was given, so this is the tool's assertion rather than evidence.",
      );
    }
  });

  it('accepts the shape the rule prescribes: an absolute http(s) address', () => {
    const v = validateClaim({
      claim: 'The registry charges $50.',
      sourceUrl: 'https://registry.example.gov/fees',
      evidenceExcerpt: 'The filing fee is $50.',
    });
    expect(v.validationState).not.toBe('NO_URL');
    expect(v.sourced).toBe(true);
  });

  it('holds a SELF_REPORT to a second, independent source, with the recorded reason', () => {
    const standard = effectiveStandard({
      claim: 'Acme states that it is the largest supplier.',
      claimType: 'SELF_REPORT',
      primarySource: true,
    });
    expect(standard.minIndependentSources).toBe(2);
    expect(standard.requiresLabel).toBe(true);
    expect(standard.rationale).toContain('independent of that organisation');
  });
});

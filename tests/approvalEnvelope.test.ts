/**
 * Approving a plan without a person, and every way that must not happen.
 *
 * The interesting cases here are all refusals. Automatic approval is only worth
 * having if the envelope is genuinely the thing deciding — so these tests are
 * written as attempts to get a plan approved that should not be.
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ENVELOPES,
  ENVELOPE_VALIDATOR_VERSION,
  MICHIGAN_LICENSING_ASSIGNMENT,
  getApprovalEnvelope,
  planFitsEnvelope,
} from '../server/services/research/approvalEnvelope.ts';
import type { ResearchFragment, ResearchOrchestration } from '../server/domain/types.ts';

const ENVELOPE = APPROVAL_ENVELOPES['STEP10_MICHIGAN_LICENSING_V1']!;

function packet(over: Partial<ResearchOrchestration> = {}): ResearchOrchestration {
  return {
    assignment: MICHIGAN_LICENSING_ASSIGNMENT,
    fixture: false,
    unresolvedGapPolicy: null,
    approvalEnvelopeId: ENVELOPE.id,
    ...over,
  } as unknown as ResearchOrchestration;
}

function fragment(over: Partial<ResearchFragment> = {}): ResearchFragment {
  return {
    fragmentKey: 'licence-trigger',
    question: 'What conduct triggers the Michigan licence requirement?',
    geography: 'Michigan',
    definitions: null,
    population: null,
    completionCriteria: ['a quoted primary provision with its citation'],
    requiredEvidence: ['licence_trigger_definition'],
    acceptableSourceTypes: ['Michigan Occupational Code (statute)'],
    excludedSourceTypes: ['law-firm article'],
    minIndependentSources: 1,
    ...over,
  } as unknown as ResearchFragment;
}

describe('an envelope is named, never supplied', () => {
  it('resolves only ids this build defines', () => {
    expect(getApprovalEnvelope('STEP10_MICHIGAN_LICENSING_V1')).not.toBeNull();
    expect(getApprovalEnvelope('anything-else')).toBeNull();
    // Not reachable through the prototype chain either: an envelope id is a
    // key somebody chose, and "constructor" must not resolve to a function.
    expect(getApprovalEnvelope('constructor')).toBeNull();
    expect(getApprovalEnvelope('__proto__')).toBeNull();
  });

  it('is frozen, so nothing can widen it at runtime', () => {
    expect(Object.isFrozen(APPROVAL_ENVELOPES)).toBe(true);
    expect(Object.isFrozen(ENVELOPE)).toBe(true);
  });
});

describe('a plan inside the envelope is approved', () => {
  it('fits when it is Michigan, primary-sourced and small', () => {
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: packet(),
      fragments: [fragment(), fragment({ fragmentKey: 'real-property-condition' })],
    });
    expect(verdict.reasons).toEqual([]);
    expect(verdict.fits).toBe(true);
    expect(verdict.validatorVersion).toBe(ENVELOPE_VALIDATOR_VERSION);
  });
});

describe('a plan outside the envelope goes to a person', () => {
  it('refuses an assignment that drifted by even one word', () => {
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: packet({ assignment: MICHIGAN_LICENSING_ASSIGNMENT + ' Also cover Ohio.' }),
      fragments: [fragment()],
    });
    expect(verdict.fits).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/not the text this envelope authorizes/);
  });

  it('refuses more fragments than were authorized', () => {
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: packet(),
      fragments: Array.from({ length: 5 }, (_, i) => fragment({ fragmentKey: `f${i}` })),
    });
    expect(verdict.fits).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/at most 4/);
  });

  it('refuses a fragment about another state', () => {
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: packet(),
      fragments: [fragment({ geography: 'Ohio' })],
    });
    expect(verdict.fits).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/not Michigan/);
  });

  it('refuses another state smuggled into the question rather than the geography', () => {
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: packet(),
      fragments: [
        fragment({ question: 'How does Michigan compare with California on this point?' }),
      ],
    });
    expect(verdict.fits).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/reaches outside Michigan/);
  });

  it('refuses a secondary source type', () => {
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: packet(),
      fragments: [fragment({ acceptableSourceTypes: ['a law-firm client alert'] })],
    });
    expect(verdict.fits).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/not a primary statute, regulation or regulator source/);
  });

  it('refuses a fragment that would spend money or act on the world', () => {
    for (const question of [
      'Purchase the annotated code and quote the provision.',
      'Email the Department of Licensing to confirm.',
      'Apply for a determination from the Board.',
    ]) {
      const verdict = planFitsEnvelope({
        envelope: ENVELOPE,
        orchestration: packet(),
        fragments: [fragment({ question })],
      });
      expect(verdict.fits).toBe(false);
      expect(verdict.reasons.join(' ')).toMatch(/outside reading published sources/);
    }
  });

  it('refuses a lowered evidence floor', () => {
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: packet(),
      fragments: [fragment({ minIndependentSources: 0 })],
    });
    expect(verdict.fits).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/below the envelope's floor/);
  });

  it('refuses a fragment with no evidence lanes, so the gate has something to apply', () => {
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: packet(),
      fragments: [fragment({ requiredEvidence: [] })],
    });
    expect(verdict.fits).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/no evidence lanes/);
  });

  it('refuses a fixture, which supplies its own claims instead of researching', () => {
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: packet({ fixture: true }),
      fragments: [fragment()],
    });
    expect(verdict.fits).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/fixture/i);
  });

  it('refuses a packet allowed to declare its own gaps', () => {
    // Otherwise automatic approval plus gap-recording is a Brain that can
    // narrow the question and then call itself finished.
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: packet({ unresolvedGapPolicy: 'RECORD_GAPS' }),
      fragments: [fragment()],
    });
    expect(verdict.fits).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/narrows what it claims to answer/);
  });

  it('refuses an empty plan rather than approving nothing', () => {
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: packet(),
      fragments: [],
    });
    expect(verdict.fits).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/no plan to approve/);
  });

  it('reports every reason, not just the first', () => {
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: packet({ fixture: true }),
      fragments: [fragment({ geography: 'Texas', minIndependentSources: 0 })],
    });
    expect(verdict.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

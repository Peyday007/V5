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
  STATE_LICENSING_ASSIGNMENT_TEMPLATE,
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

describe('the source classes the authorized assignment actually names', () => {
  /*
   * The first real plan was refused, and the refusal was wrong.
   *
   * It declared these four and only these four — they are the four the pinned
   * assignment names in its evidence standard — and three of them matched. The
   * fourth did not, because Michigan publishes its administrative rules as the
   * Michigan Administrative *Code* and the list spelled `administrative rule`.
   *
   * The strings below are verbatim from the plan the worker filed, so this
   * test is the check being applied to the words a planner really used rather
   * than to words chosen to pass it.
   */
  const AS_FILED = [
    'Michigan Occupational Code (MCL) full text',
    'Michigan Administrative Code / R rules',
    'Published LARA guidance',
    'Board of Real Estate Brokers and Salespersons declaratory rulings',
  ];

  it('accepts every one of them, individually', () => {
    for (const source of AS_FILED) {
      const verdict = planFitsEnvelope({
        envelope: ENVELOPE,
        orchestration: packet(),
        fragments: [fragment({ acceptableSourceTypes: [source] })],
      });
      expect(verdict.reasons.join(' '), source).not.toMatch(/accepts/);
    }
  });

  it('approves the plan as filed', () => {
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: packet(),
      fragments: [fragment({ acceptableSourceTypes: AS_FILED })],
    });
    expect(verdict.fits).toBe(true);
  });

  /*
   * And the half that makes the correction a correction rather than a
   * widening: everything the assignment excludes is still refused when a
   * fragment declares it *acceptable*. If any of these ever passes, the list
   * has stopped meaning "primary statutes, regulations and regulator sources".
   */
  const STILL_REFUSED = [
    'Law-firm articles and secondary summaries used to support a claim',
    'Brokerage association guidance pages',
    'Practitioner blog posts and newsletters',
    'Wikipedia and general reference sites',
    'Vendor marketing material',
  ];

  it('still refuses every secondary class, one at a time', () => {
    for (const source of STILL_REFUSED) {
      const verdict = planFitsEnvelope({
        envelope: ENVELOPE,
        orchestration: packet(),
        fragments: [fragment({ acceptableSourceTypes: [source] })],
      });
      expect(verdict.fits, source).toBe(false);
      expect(verdict.reasons.join(' ')).toMatch(/not a primary statute, regulation or regulator/);
    }
  });

  it('refuses a plan that adds one secondary class to the four good ones', () => {
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: packet(),
      fragments: [
        fragment({ acceptableSourceTypes: [...AS_FILED, 'Law-firm client alerts'] }),
      ],
    });
    expect(verdict.fits).toBe(false);
  });

  it('records the validator version that made the decision', () => {
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: packet(),
      fragments: [fragment({ acceptableSourceTypes: AS_FILED })],
    });
    // Bumped when the checks changed meaning, so an approval recorded before
    // the correction and one recorded after are distinguishable in the audit.
    expect(verdict.validatorVersion).toBe(ENVELOPE_VALIDATOR_VERSION);
    expect(verdict.validatorVersion).toBe('2026-09-08.1');
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

/**
 * The narrow test envelope that must not have become a permanent restriction.
 *
 * `RUSSELL_STATE_LICENSING_V1` carried `maxFragments: 1`, chosen because the
 * acceptance needed something small. A number chosen for a test is not a bound
 * on spending — it is a bound on how carefully a real question may be asked,
 * and §12 already says there is no fixed fragment count because the gaps decide
 * it. So the count went and every scope condition stayed, which is the half
 * that was doing the work all along.
 */
describe('the Russell envelope bounds scope rather than counting questions', () => {
  const RUSSELL = APPROVAL_ENVELOPES['RUSSELL_STATE_LICENSING_V1']!;

  function russellPacket(over: Partial<ResearchOrchestration> = {}): ResearchOrchestration {
    return {
      assignment: STATE_LICENSING_ASSIGNMENT_TEMPLATE,
      fixture: false,
      unresolvedGapPolicy: null,
      approvalEnvelopeId: RUSSELL.id,
      ...over,
    } as unknown as ResearchOrchestration;
  }

  function floridaFragment(over: Partial<ResearchFragment> = {}): ResearchFragment {
    return {
      fragmentKey: 'licence-trigger',
      question: 'What conduct triggers the Florida licence requirement?',
      geography: 'Florida',
      definitions: null,
      population: null,
      completionCriteria: ['a quoted primary provision with its citation'],
      requiredEvidence: ['licence_trigger_definition'],
      acceptableSourceTypes: ['Florida Statutes (statute)'],
      excludedSourceTypes: ['law-firm article'],
      minIndependentSources: 1,
      ...over,
    } as unknown as ResearchFragment;
  }

  it('declares no fragment count at all, rather than a large one', () => {
    // A big number would read as a limit, and one day would be.
    expect(RUSSELL.maxFragments).toBeNull();
  });

  it('approves a plan broken into as many bounded questions as the gaps need', () => {
    const verdict = planFitsEnvelope({
      envelope: RUSSELL,
      orchestration: russellPacket(),
      fragments: Array.from({ length: 9 }, (_, i) =>
        floridaFragment({
          fragmentKey: `florida-${i}`,
          question: `Which Florida provision settles point ${i} of the licence trigger?`,
        }),
      ),
    });
    expect(verdict.reasons).toEqual([]);
    expect(verdict.fits).toBe(true);
    expect(verdict.checked.fragments).toBe(9);
    expect(verdict.checked.maxFragments).toBeNull();
  });

  it('still refuses an empty plan, which is not a decomposition', () => {
    const verdict = planFitsEnvelope({
      envelope: RUSSELL,
      orchestration: russellPacket(),
      fragments: [],
    });
    expect(verdict.fits).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/no plan to approve/i);
  });

  it('still refuses a state nobody authorized, however few fragments there are', () => {
    const verdict = planFitsEnvelope({
      envelope: RUSSELL,
      orchestration: russellPacket(),
      fragments: [floridaFragment({ geography: 'Ohio' })],
    });
    expect(verdict.fits).toBe(false);
  });

  it('still refuses one bad fragment hidden among many good ones', () => {
    /*
     * The property that makes removing the count safe: every condition is
     * applied per fragment, so a broader decomposition is more fragments to
     * refuse rather than more room to hide in.
     */
    const verdict = planFitsEnvelope({
      envelope: RUSSELL,
      orchestration: russellPacket(),
      fragments: [
        ...Array.from({ length: 6 }, (_, i) => floridaFragment({ fragmentKey: `ok-${i}` })),
        floridaFragment({
          fragmentKey: 'sneaky',
          acceptableSourceTypes: ['law-firm article'],
        }),
        floridaFragment({ fragmentKey: 'spendy', minIndependentSources: 0 }),
      ],
    });
    expect(verdict.fits).toBe(false);
    expect(verdict.reasons.length).toBeGreaterThanOrEqual(2);
    expect(verdict.reasons.join(' ')).toMatch(/sneaky/);
    expect(verdict.reasons.join(' ')).toMatch(/spendy/);
  });
});

/**
 * Evidence lanes: an id you can match on, a description you can research from,
 * and a necessity that decides whether an empty one fails the fragment.
 *
 * All three exist because the first fresh acceptance packet had none of them.
 * Its lanes were 160-character sentences used as map keys, three per fragment,
 * every one mandatory — including ones whose own text ended "…if any exists on
 * point". It returned 24 accepted claims and covered nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  describeLane,
  isLaneId,
  laneIdFrom,
  laneIds,
  parseLanes,
  requiredLanes,
  serializeLanes,
} from '../server/domain/evidenceLanes.ts';
import { applyGate } from '../server/services/research/gate.ts';
import { laneProblems, explainLaneProblems } from '../server/services/research/lanes.ts';
import type { EvidenceLane, ResearchClaim, ResearchFragment } from '../server/domain/types.ts';

const PROSE =
  "Definitions in NY Real Property Law Art. 12-A deciding whether 'real estate broker' " +
  'activity includes or excludes arranging a business sale with no realty transferred';

function lane(over: Partial<EvidenceLane> = {}): EvidenceLane {
  return { id: 'operative_authority', description: PROSE, necessity: 'REQUIRED', ...over };
}

function fragment(over: Partial<ResearchFragment> = {}): ResearchFragment {
  return {
    id: 'frg_1',
    fragmentKey: 'ny-licence',
    requiredEvidence: [lane()],
    minIndependentSources: 1,
    geography: null,
    timeframe: null,
    population: null,
    definitions: null,
    ...over,
  } as ResearchFragment;
}

function claim(over: Partial<ResearchClaim> = {}): ResearchClaim {
  return {
    id: `clm_${Math.random().toString(36).slice(2, 10)}`,
    claim: 'Section 442-d requires a licence.',
    claimType: 'SOURCED_FACT',
    sourceUrl: 'https://www.nysenate.gov/legislation/laws/RPP/442-D',
    sourcePublisher: 'New York State Senate',
    sourceGroup: null,
    evidenceExcerpt: 'No person shall bring an action…',
    evidenceLocator: '§ 442-d',
    evidenceLane: 'operative_authority',
    retrievalState: 'RETRIEVED',
    contradictionState: 'UNCHALLENGED',
    validationState: 'SOURCED',
    validationDetail: null,
    sourced: true,
    derived: false,
    derivedFrom: [],
    accepted: false,
    primarySource: true,
    confidence: 0.9,
    ...over,
  } as ResearchClaim;
}

function verdictsFor(claims: ResearchClaim[]): Parameters<typeof applyGate>[0]['verification'] {
  return {
    verdicts: new Map(
      claims.map((entry) => [
        entry.id,
        {
          supportsClaim: true,
          scopeMatch: {
            geography: 'MATCH' as const,
            timeframe: 'MATCH' as const,
            population: 'MATCH' as const,
            definitions: 'MATCH' as const,
          },
          note: '',
        },
      ]),
    ),
    sufficiency: 'SUFFICIENT' as const,
    missingLanes: [],
    unresolvedGaps: [],
  };
}

// ---------------------------------------------------------------------------

describe('a lane id', () => {
  it('is machine-shaped, and a sentence is not one', () => {
    expect(isLaneId('operative_authority')).toBe(true);
    expect(isLaneId('exemptions_or_inclusions')).toBe(true);
    expect(isLaneId('regulator_guidance')).toBe(true);

    // The shapes the old lanes had, all refused.
    expect(isLaneId(PROSE)).toBe(false);
    expect(isLaneId('official statistics')).toBe(false);
    expect(isLaneId('Operative_Authority')).toBe(false);
    expect(isLaneId('1_authority')).toBe(false);
    expect(isLaneId('a')).toBe(false);
    expect(isLaneId('x'.repeat(41))).toBe(false);
  });

  /**
   * The property the whole scheme rests on: the same plan, planned twice,
   * produces the same key. A key that drifted between runs would make coverage
   * unmatchable for exactly the reason prose did.
   */
  it('is stable — equivalent plans derive the same id', () => {
    expect(laneIdFrom(PROSE)).toBe(laneIdFrom(PROSE));
    expect(laneIdFrom(PROSE)).toBe(laneIdFrom(`  ${PROSE}  `.replace(/\s+/g, ' ').trim()));
    // Deriving is deterministic across separately parsed copies of one plan.
    const once = parseLanes([PROSE]);
    const twice = parseLanes([PROSE]);
    expect(laneIds(once)).toEqual(laneIds(twice));
  });

  it('is never the prose itself, however long the description', () => {
    const derived = laneIdFrom(PROSE);
    expect(derived).not.toBe(PROSE);
    expect(derived.length).toBeLessThanOrEqual(40);
    expect(isLaneId(derived)).toBe(true);
    // And a description that slugs to nothing usable still yields an id.
    expect(isLaneId(laneIdFrom('— ??? —'))).toBe(true);
  });
});

describe('reading lanes from a row', () => {
  it('reads a bare string as a description with a derived id, still required', () => {
    const [only] = parseLanes(['statute text']);
    expect(only).toEqual({ id: 'statute_text', description: 'statute text', necessity: 'REQUIRED' });
  });

  it('keeps a declared id, description and necessity', () => {
    expect(parseLanes([{ id: 'regulator_guidance', description: PROSE, necessity: 'CONDITIONAL' }]))
      .toEqual([{ id: 'regulator_guidance', description: PROSE, necessity: 'CONDITIONAL' }]);
  });

  it('drops a duplicate id rather than leaving coverage ambiguous', () => {
    const lanes = parseLanes([
      { id: 'operative_authority', description: 'first', necessity: 'REQUIRED' },
      { id: 'operative_authority', description: 'second', necessity: 'OPTIONAL' },
    ]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.description).toBe('first');
  });

  it('round-trips through storage', () => {
    const lanes = [lane(), lane({ id: 'regulator_guidance', necessity: 'CONDITIONAL' })];
    expect(parseLanes(serializeLanes(lanes))).toEqual(lanes);
    expect(parseLanes(JSON.stringify(serializeLanes(lanes)))).toEqual(lanes);
  });

  it('names only the lanes that can fail a fragment', () => {
    const lanes = [
      lane({ id: 'operative_authority', necessity: 'REQUIRED' }),
      lane({ id: 'regulator_guidance', necessity: 'CONDITIONAL' }),
      lane({ id: 'commentary', necessity: 'OPTIONAL' }),
    ];
    expect(laneIds(requiredLanes(lanes))).toEqual(['operative_authority']);
  });
});

describe('coverage', () => {
  it('is satisfied by a claim carrying the lane id', () => {
    const claims = [claim({ evidenceLane: 'operative_authority' })];
    const result = applyGate({ fragment: fragment(), claims, verification: verdictsFor(claims) });

    expect(result.coverage[0]!.lane).toBe('operative_authority');
    expect(result.coverage[0]!.description).toBe(PROSE);
    expect(result.coverage[0]!.meetsThreshold).toBe(true);
    expect(result.sufficiency).toBe('SUFFICIENT');
  });

  it('is not satisfied by a claim carrying the description', () => {
    const claims = [claim({ evidenceLane: PROSE })];
    const result = applyGate({ fragment: fragment(), claims, verification: verdictsFor(claims) });
    expect(result.coverage[0]!.meetsThreshold).toBe(false);
    expect(result.sufficiency).toBe('INSUFFICIENT');
  });

  /**
   * The correction this whole change exists for.
   *
   * "Regulator guidance, if any exists on point" is a question about whether
   * something exists. A fragment that correctly establishes it does not must
   * not be failed for it — an acceptable *category* of source is not
   * automatically a mandatory coverage requirement.
   */
  it('does not block on an absent OPTIONAL or CONDITIONAL lane', () => {
    const claims = [claim({ evidenceLane: 'operative_authority' })];
    const result = applyGate({
      fragment: fragment({
        requiredEvidence: [
          lane({ id: 'operative_authority', necessity: 'REQUIRED' }),
          lane({
            id: 'regulator_guidance',
            description: 'Regulator guidance on business-only sales, if any exists on point.',
            necessity: 'CONDITIONAL',
          }),
          lane({ id: 'commentary', description: 'Secondary commentary.', necessity: 'OPTIONAL' }),
        ],
      }),
      claims,
      verification: verdictsFor(claims),
    });

    expect(result.sufficiency).toBe('SUFFICIENT');
    expect(result.failedConditions).not.toContain('COVERAGE');
    // Reported, though: the conditional question was asked and is open, and a
    // reader needs to know that. The optional one is silent.
    expect(result.reasons.join(' ')).toContain('regulator_guidance');
    expect(result.reasons.join(' ')).not.toContain('commentary');
  });

  it('does block on an absent REQUIRED lane, and names both id and description', () => {
    const claims = [claim({ evidenceLane: 'regulator_guidance' })];
    const result = applyGate({
      fragment: fragment({
        requiredEvidence: [
          lane({ id: 'operative_authority', necessity: 'REQUIRED' }),
          lane({ id: 'regulator_guidance', necessity: 'CONDITIONAL' }),
        ],
      }),
      claims,
      verification: verdictsFor(claims),
    });

    expect(result.sufficiency).toBe('INSUFFICIENT');
    expect(result.failedConditions).toContain('COVERAGE');
    const why = result.reasons.join(' ');
    expect(why).toContain('operative_authority');
    expect(why).toContain(PROSE.slice(0, 30));
  });
});

describe('the refusal a worker reads', () => {
  it('names the permitted ids and their descriptions', () => {
    const frag = fragment({
      requiredEvidence: [
        lane({ id: 'operative_authority', description: 'The statute that settles it.' }),
        lane({ id: 'regulator_guidance', description: 'Guidance, if any.', necessity: 'CONDITIONAL' }),
      ],
    });
    const problems = laneProblems(frag, [{ ...claim({ evidenceLane: null }) }]);
    expect(problems).toHaveLength(1);

    const message = explainLaneProblems(frag, problems);
    expect(message).toContain('operative_authority');
    expect(message).toContain('The statute that settles it.');
    expect(message).toContain('regulator_guidance');
    // It has to point at the id rather than the sentence, which is the mistake.
    expect(message).toMatch(/ids/i);
    expect(message).toContain('evidenceLaneIds');
  });

  it('refuses a claim tagged with the description instead of the id', () => {
    const frag = fragment();
    const problems = laneProblems(frag, [{ ...claim({ evidenceLane: PROSE }) }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.why).toBe('UNDECLARED');
  });
});

describe('a lane rendered for a human', () => {
  it('shows the id, the description, and marks anything not required', () => {
    expect(describeLane(lane({ id: 'operative_authority', description: 'The statute.' })))
      .toBe('operative_authority — The statute.');
    expect(
      describeLane(lane({ id: 'regulator_guidance', description: 'Guidance.', necessity: 'CONDITIONAL' })),
    ).toBe('regulator_guidance (conditional) — Guidance.');
  });
});

/**
 * Knowledge acquisition and mechanism understanding (META-18-2, layers 1–2):
 * claims keep provenance and an explicit status with its reason, unevidenced
 * facets are reported missing rather than filled, and a mechanism is an
 * open-ended causal graph whose unevidenced roles are UNKNOWN.
 */
import { describe, expect, it } from 'vitest';
import {
  acquireKnowledge,
  buildMechanismModel,
  facetOf,
  KNOWLEDGE_FACETS,
  type KnowledgeSourceClaim,
} from '../server/services/research/knowledgeModel.ts';
import { currentClaim } from '../server/services/quant/graph.ts';

const NOW = new Date('2026-11-16T00:00:00Z');

function claim(id: string, over: Partial<KnowledgeSourceClaim> = {}): KnowledgeSourceClaim {
  return {
    id,
    claim: `claim ${id}`,
    claimType: 'SOURCED_FACT',
    sourceUrl: `https://example.org/${id}`,
    sourceTitle: `Source ${id}`,
    sourcePublisher: 'Example Publisher',
    sourceDate: '2026-01-01',
    retrievedAt: '2026-11-01T10:00:00Z',
    retrievalState: 'RETRIEVED',
    evidenceLane: null,
    geography: null,
    timeframe: null,
    population: null,
    definition: null,
    contradictionState: 'UNCHALLENGED',
    contradictionNote: null,
    contradictionKind: null,
    reconciliation: null,
    reconciledClaimId: null,
    accepted: true,
    sourced: true,
    primarySource: true,
    structuralFinding: null,
    laborFinding: null,
    createdAt: '2026-11-01T10:00:00Z',
    ...over,
  };
}

describe('acquireKnowledge', () => {
  const claims: KnowledgeSourceClaim[] = [
    claim('price-a', { structuralFinding: 'UNIT_ECONOMIC', claim: 'Commercial roof inspection costs 400 dollars per site in Texas' }),
    claim('price-b', { structuralFinding: 'UNIT_ECONOMIC', claim: 'Commercial roof inspection costs 1,900 dollars per site in Texas' }),
    claim('buyers', { structuralFinding: 'BUYER_TYPE', claim: 'Property managers buy inspections before renewals' }),
    claim('rule-old', { laborFinding: 'HUMAN_REQUIREMENT', claim: 'A licensed inspector must sign the report', validUntil: '2025-12-31' }),
    claim('eu-rule', { laborFinding: 'HUMAN_REQUIREMENT', claim: 'An EU certified engineer signs the report', geography: 'European Union' }),
    claim('contested', { evidenceLane: 'lane-competition', claim: 'Three national firms hold most contracts', contradictionState: 'CONTESTED', contradictionNote: 'a trade body counts eleven' }),
    claim('stale', { evidenceLane: 'lane-timing', claim: 'Inspections cluster in spring' }),
    claim('fresh', { evidenceLane: 'lane-timing', claim: 'Inspections cluster before insurance renewals', reconciliation: 'UPDATES_STALE', reconciledClaimId: 'stale' }),
    claim('drone-permits', { evidenceLane: 'drone_airspace', claim: 'Drone surveys need a Part 107 waiver near airports' }),
    claim('rejected', { accepted: false, claim: 'Refused at the gate' }),
  ];
  const reading = acquireKnowledge({
    subject: 'commercial roof inspection',
    claims,
    scope: { geography: 'Texas' },
    laneFacets: { 'lane-competition': 'competition', 'lane-timing': 'timing' },
    extraFacets: ['insurance_requirements'],
    now: NOW,
  });
  const byId = new Map(reading.claims.map((one) => [one.id, one]));

  it('gives every claim its source, retrieval date and a status with a reason', () => {
    for (const one of reading.claims.filter((c) => !c.id.startsWith('missing:'))) {
      expect(one.provenance?.sourceUrl).toBeTruthy();
      expect(one.provenance?.retrievedAt).toBe('2026-11-01T10:00:00Z');
      expect(one.reason.length).toBeGreaterThan(0);
    }
    expect(byId.get('buyers')?.status).toBe('SUPPORTED');
    expect(byId.has('rejected')).toBe(false);
  });

  it('returns conflicting, outdated and locally inapplicable claims explicitly', () => {
    expect(byId.get('price-a')?.status).toBe('CONFLICTING');
    expect(byId.get('price-b')?.status).toBe('CONFLICTING');
    expect(byId.get('price-a')?.related).toContain('price-b');
    expect(byId.get('contested')?.status).toBe('CONFLICTING');
    expect(byId.get('contested')?.reason).toContain('eleven');
    expect(byId.get('rule-old')?.status).toBe('OUTDATED');
    expect(byId.get('stale')?.status).toBe('OUTDATED');
    expect(byId.get('stale')?.related).toEqual(['fresh']);
    expect(byId.get('fresh')?.status).toBe('SUPPORTED');
    expect(byId.get('eu-rule')?.status).toBe('LOCALLY_INAPPLICABLE');
    expect(byId.get('eu-rule')?.reason).toContain('European Union');
  });

  it('reports facets nobody has evidenced as missing, never filled', () => {
    expect(reading.needs).toEqual(expect.arrayContaining(['prices', 'rules', 'competition', 'infrastructure', 'performance', 'insurance_requirements']));
    expect(reading.needs).not.toContain('buyer_behavior');
    const prices = byId.get('missing:prices');
    expect(prices?.status).toBe('MISSING');
    expect(prices?.text).toBeNull();
    expect(prices?.provenance).toBeNull();
    expect(prices?.reason).toContain('conflicting');
    for (const facet of KNOWLEDGE_FACETS) expect(reading.facets.some((one) => one.facet === facet)).toBe(true);
  });

  it('opens a facet for a lane no checklist names rather than dropping the claim', () => {
    expect(byId.get('drone-permits')?.facet).toBe('drone_airspace');
    expect(reading.facets.find((one) => one.facet === 'drone_airspace')?.answered).toBe(true);
  });

  it('counts the evidence that exists', () => {
    expect(reading.evidence.claims).toBe(9);
    expect(reading.evidence.byRetrieval.RETRIEVED).toBe(9);
  });

  it('treats an unread or unsourced claim as unresolved, not supported', () => {
    const one = acquireKnowledge({ subject: 's', claims: [claim('pay', { retrievalState: 'PAYWALLED' }), claim('none', { sourceUrl: null, sourced: false })], now: NOW });
    expect(one.claims.find((c) => c.id === 'pay')?.status).toBe('MISSING');
    expect(one.claims.find((c) => c.id === 'none')?.status).toBe('MISSING');
    expect(facetOf(claim('x'))).toBe('unclassified');
  });
});

describe('buildMechanismModel', () => {
  const knowledge = acquireKnowledge({
    subject: 'subcontracted inspection',
    claims: [
      claim('gc', { structuralFinding: 'BUYER_TYPE', claim: 'General contractors commission inspections' }),
      claim('lic', { laborFinding: 'HUMAN_REQUIREMENT', claim: 'Inspectors hold a state licence' }),
      claim('net30', { structuralFinding: 'UNIT_ECONOMIC', claim: 'Payment is net 30 at 450 dollars per inspection' }),
      claim('contested', { contradictionState: 'REFUTED', claim: 'Inspectors carry the liability' }),
    ],
    now: NOW,
  });

  it('names every role, and marks a role without supported evidence unknown rather than valued', () => {
    const result = buildMechanismModel({
      subject: 'subcontracted inspection',
      knowledge,
      roles: {
        initiator: { id: 'gc', label: 'General contractor', evidence: ['gc'] },
        rights: { id: 'licence', label: 'State inspector licence', evidence: ['lic'] },
        moneyMovement: { id: 'pay', label: 'Net-30 invoice payment', evidence: ['net30'], figure: { meaning: 'price per inspection', unit: 'USD', value: 450 } },
        riskBearer: { id: 'liability', label: 'Inspector liability', evidence: ['contested'], figure: { meaning: 'liability cap', unit: 'USD', value: 1_000_000 } },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { model } = result;
    expect(model.roles.map((one) => one.role)).toEqual(['initiator', 'access', 'rights', 'riskBearer', 'trigger', 'deliverer', 'moneyMovement', 'failure', 'reusable']);
    expect(model.unknown).toEqual(['access', 'riskBearer', 'trigger', 'deliverer', 'failure', 'reusable']);
    expect(model.graph.nodes.get('gc')?.attributes.status).toBe('KNOWN');
    expect(model.graph.nodes.get('gc')?.attributes.source).toBe('https://example.org/gc');
    expect(model.graph.nodes.get('unknown:trigger')?.attributes.status).toBe('UNKNOWN');
    expect(currentClaim(model.graph, 'pay')?.value).toBe(450);
    expect(currentClaim(model.graph, 'pay')?.status).toBe('EVIDENCED');
    const liability = currentClaim(model.graph, 'liability');
    expect(liability?.status).toBe('UNKNOWN');
    expect(liability?.value).toBeNull();
    expect(model.roles.find((one) => one.role === 'riskBearer')?.reason).toContain('conflicting');
    expect([...model.graph.relations.values()].some((rel) => rel.type === 'pays' && rel.from === 'pay')).toBe(true);
  });

  it('declares a node and relation type the seed vocabulary lacks, with its reason, and models it', () => {
    const result = buildMechanismModel({
      subject: 'carbon credit retirement',
      knowledge,
      types: [
        { kind: 'node', name: 'registry', reason: 'Credits exist only as entries on a registry no seed type names.' },
        { kind: 'relation', name: 'retires_on', reason: 'Retirement is a registry state change, not a payment or delivery.' },
      ],
      roles: { initiator: { id: 'gc', label: 'Buyer', evidence: ['gc'] } },
      extraNodes: [{ id: 'verra', label: 'Credit registry', type: 'registry', evidence: [] }],
      relations: [{ id: 'r1', type: 'retires_on', from: 'gc', to: 'verra' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.declaredTypes.map((one) => one.name)).toEqual(['registry', 'retires_on']);
    expect(result.model.graph.nodeTypes.get('registry')?.reason).toContain('registry');
    expect(result.model.graph.nodes.get('verra')?.attributes.status).toBe('UNKNOWN');
    expect(result.model.graph.relations.get('r1')?.type).toBe('retires_on');
  });

  it('refuses an undeclared type instead of forcing it into the vocabulary', () => {
    const result = buildMechanismModel({
      subject: 'x',
      knowledge,
      roles: {},
      extraNodes: [{ id: 'z', label: 'Something', type: 'not_declared_type', evidence: [] }],
    });
    expect(result.ok).toBe(false);
  });
});

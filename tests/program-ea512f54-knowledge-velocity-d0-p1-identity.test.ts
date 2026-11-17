/**
 * KNOW-25-1, cross-source identity resolution
 * (`server/services/knowledge/identity.ts`): same-name entities that disagree
 * on a distinguishing attribute are never fused and the collision is
 * reported; the same entity across sources is linked only with a recorded
 * corroboration; established mappings are stable; and a link becomes a
 * variable and a labelled hypothesis only when it bears on a decision input.
 */
import { describe, expect, it } from 'vitest';
import { domainKey, entityIdFor, resolveIdentities, type IdentityRecord } from '../server/services/knowledge/identity.ts';

const r = (ref: string, source: string, name: string, over: Partial<IdentityRecord> = {}): IdentityRecord => ({ ref, source, kind: 'ENTITY', name, ...over });

describe('collisions are resolved before matching', () => {
  it('never fuses same-name entities with different domains or registry ids, and reports the collision', () => {
    const res = resolveIdentities({
      records: [
        r('a', 'feed-1', 'Acme Corp', { domain: 'https://www.acme.com/about' }),
        r('b', 'feed-2', 'ACME Corporation', { domain: 'acme.co.uk' }),
        r('c', 'feed-1', 'Delta LLC', { registryId: 'CIK-1' }),
        r('d', 'feed-3', 'Delta Inc', { registryId: 'CIK-2' }),
      ],
    });
    expect(res.links).toEqual([]);
    expect(res.mappings.a).not.toBe(res.mappings.b);
    expect(res.mappings.c).not.toBe(res.mappings.d);
    expect(res.collisions.map((c) => c.attribute).sort()).toEqual(['domain', 'registryId']);
    expect(res.collisions.find((c) => c.attribute === 'domain')!.values).toEqual(['acme.com', 'acme.co.uk']);
  });

  it('never fuses on a name alone', () => {
    const res = resolveIdentities({ records: [r('a', 'feed-1', 'Acme'), r('b', 'feed-2', 'Acme')] });
    expect(res.links).toEqual([]);
    expect(res.uncorroborated).toEqual([{ kind: 'ENTITY', nameKey: 'acme', refs: ['a', 'b'] }]);
  });

  it('does not grow a cluster through a member that conflicts with another', () => {
    const res = resolveIdentities({
      records: [
        r('a', 'feed-1', 'Acme', { domain: 'acme.com' }),
        r('b', 'feed-2', 'Acme', { domain: 'acme.com', location: 'austin, tx' }),
        r('c', 'feed-3', 'Acme', { location: 'austin, tx', domain: 'acme-tx.com' }),
      ],
    });
    expect(res.links).toHaveLength(1);
    expect(res.links[0]!.refs).toEqual(['a', 'b']);
    expect(res.mappings.c).not.toBe(res.mappings.a);
    expect(res.collisions.some((c) => c.attribute === 'domain')).toBe(true);
  });
});

describe('the same entity across sources is linked with its corroboration', () => {
  it('links by a shared domain, registry id, location or explicit cross-reference, recording which', () => {
    const res = resolveIdentities({
      records: [
        r('a', 'jobs', 'Acme Services LLC', { domain: 'http://acme.com' }),
        r('b', 'news', 'Acme Services', { domain: 'www.acme.com' }),
        r('c', 'filings', 'Acme Holdings', { registryId: 'cik-9' }),
        r('d', 'awards', 'ACME HOLDINGS INC', { registryId: 'CIK-9' }),
        r('e', 'feed-x', 'Widget', { kind: 'PRODUCT', sameAs: ['f'] }),
        r('f', 'feed-y', 'Widget Pro', { kind: 'PRODUCT' }),
      ],
    });
    expect(res.links).toHaveLength(3);
    const byRefs = Object.fromEntries(res.links.map((l) => [l.refs.join(','), l]));
    expect(byRefs['a,b']!.corroboration[0]).toMatchObject({ attribute: 'domain', value: 'acme.com' });
    expect(byRefs['a,b']!.sources).toEqual(['jobs', 'news']);
    expect(byRefs['c,d']!.corroboration[0]).toMatchObject({ attribute: 'registryId', value: 'cik-9' });
    expect(byRefs['e,f']!.corroboration[0]).toMatchObject({ attribute: 'sameAs' });
    expect(domainKey('https://WWW.Acme.com:443/x')).toBe('acme.com');
  });

  it('links locations and periods as well as entities', () => {
    const res = resolveIdentities({
      records: [
        r('l1', 'feed-1', 'Austin', { kind: 'LOCATION', registryId: 'geo:4671654' }),
        r('l2', 'feed-2', 'Austin TX', { kind: 'LOCATION', registryId: 'GEO:4671654' }),
        r('p1', 'feed-1', 'Q4 2026', { kind: 'PERIOD', sameAs: ['p2'] }),
        r('p2', 'feed-2', '2026 Q4', { kind: 'PERIOD' }),
      ],
    });
    expect(res.links.map((l) => l.kind).sort()).toEqual(['LOCATION', 'PERIOD']);
  });
});

describe('established mappings', () => {
  it('are kept stable across runs, and two established entities are never merged', () => {
    const records = [r('a', 'jobs', 'Acme', { domain: 'acme.com' }), r('b', 'news', 'Acme', { domain: 'acme.com' })];
    const first = resolveIdentities({ records });
    expect(first.mappings.a).toBe(first.mappings.b);
    expect(first.mappings.a).toBe(entityIdFor('ENTITY', 'a'));
    // The same input gives the same ids; a new record joins the established id.
    const second = resolveIdentities({ records: [...records, r('c', 'awards', 'Acme Inc', { domain: 'acme.com' })], established: first.mappings });
    expect(second.mappings.a).toBe(first.mappings.a);
    expect(second.mappings.c).toBe(first.mappings.a);
    expect(second.links[0]!.established).toBe(true);
    const apart = resolveIdentities({ records, established: { a: 'ent_one', b: 'ent_two' } });
    expect(apart.mappings).toMatchObject({ a: 'ent_one', b: 'ent_two' });
    expect(apart.collisions[0]).toMatchObject({ attribute: 'established', values: ['ent_one', 'ent_two'] });
  });
});

describe('goal-relevant variables and hypotheses', () => {
  const records = [r('a', 'jobs', 'Acme', { domain: 'acme.com' }), r('b', 'awards', 'Acme', { domain: 'acme.com' }), r('x', 'jobs', 'Other', { domain: 'o.com' }), r('y', 'news', 'Other', { domain: 'o.com' })];

  it('yields a variable and a labelled hypothesis only for a link bearing on a supplied decision input', () => {
    const res = resolveIdentities({ records, decisionInputs: [{ id: 'goal_1:buyer-budget', variable: 'buyerBudget', refs: ['a'] }] });
    expect(res.links).toHaveLength(2);
    expect(res.hypotheses).toHaveLength(1);
    const h = res.hypotheses[0]!;
    expect(h.label).toBe('HYPOTHESIS');
    expect(h.decisionInput).toBe('goal_1:buyer-budget');
    expect(h.entityId).toBe(res.mappings.a);
    expect(h.variables).toEqual([`buyerBudget@${res.mappings.a}`]);
    expect(h.statement).toMatch(/hypothesis/i);
  });

  it('records a link only, with no hypothesis, when no decision input is supplied or it adds nothing', () => {
    expect(resolveIdentities({ records }).hypotheses).toEqual([]);
    expect(resolveIdentities({ records, decisionInputs: [{ id: 'd', variable: 'v', refs: ['a', 'b'] }] }).hypotheses).toEqual([]);
  });
});

describe('no list gates linking', () => {
  it('links any names and kinds by the same rule', () => {
    for (const name of ['Zebra Mining', 'Kindergarten Co-op', 'Ψ Labs', 'A1']) {
      const res = resolveIdentities({ records: [r('a', 's1', name, { domain: 'z.org' }), r('b', 's2', name, { domain: 'z.org' })] });
      expect(res.links, name).toHaveLength(1);
    }
  });
});

/**
 * Cross-source identity resolution (KNOW-25-1, "cross-source reasoning").
 *
 * Records from different permitted feeds often name the same entity,
 * location, product, time period or dependency. They are linked here — but a
 * shared name is never enough. Collisions are resolved before matching: two
 * records are joined only when a distinguishing attribute corroborates it (the
 * same web domain, the same registry or filing id, the same location, or an
 * explicit cross-reference from one to the other), and a distinguishing
 * attribute that disagrees keeps them apart and is reported as a collision.
 * Different entities with similar names are therefore never fused, and a
 * cluster is never grown through a member that conflicts with another.
 *
 * Established mappings (a record already resolved to an entity) are inputs and
 * are kept: a cluster takes the id one of its members was already given, two
 * different established ids are never merged, and a new cluster's id is
 * derived from its oldest member so it is the same on every run.
 *
 * A link becomes goal-relevant variables and a transaction hypothesis — said
 * to be a hypothesis — only when it joins records from more than one source,
 * because only then does it add evidence a decision did not already rest on.
 * Every such link carries its own variables and hypotheses, so whoever stores
 * the link stores them too. A decision input the caller supplies is the
 * decision a hypothesis bears on when it covers a member of the link; a member
 * no supplied input covers bears on the decision its own record already feeds
 * (`record:<ref>`, whatever the caller decides from that record), so a caller
 * that names no goal still gets the link turned into what it changes. The
 * resolution's top-level `hypotheses` list only those bearing on supplied
 * inputs. A link within one source adds no source and is recorded as a link
 * and nothing more.
 *
 * No industry, category or name list gates anything here (R01-A1, §18.1).
 * Pure: nothing is read or stored.
 */
import { createHash } from 'node:crypto';
import { employerKey } from '../feeds/detectors.ts';

export type IdentityKind = 'ENTITY' | 'LOCATION' | 'PRODUCT' | 'PERIOD' | 'DEPENDENCY';

/** A distinguishing attribute: what can corroborate a link, or veto it. */
export type DistinguishingAttribute = 'domain' | 'registryId' | 'location';

export interface IdentityRecord {
  /** A stable reference to the record (a feed item id, a fact key). */
  ref: string;
  source: string;
  kind: IdentityKind;
  name: string;
  domain?: string | null;
  registryId?: string | null;
  location?: string | null;
  /** Refs this record itself says it is the same as. */
  sameAs?: readonly string[];
}

export interface Corroboration {
  between: [string, string];
  attribute: DistinguishingAttribute | 'sameAs';
  value: string;
}

export interface IdentityLink {
  entityId: string;
  kind: IdentityKind;
  nameKey: string;
  refs: string[];
  sources: string[];
  corroboration: Corroboration[];
  /** True when this cluster's id came from an established mapping. */
  established: boolean;
  /**
   * What the link makes available to a decision, one per source joined and per corroborated attribute
   * (`source:<id>@<entity>`, `<attribute>@<entity>=<value>`). Empty for a link within one source.
   */
  variables: string[];
  /**
   * The link as hypotheses, one per decision it bears on: a supplied decision input covering a member,
   * or else the member's own record (`record:<ref>`). Empty for a link within one source.
   */
  hypotheses: LinkHypothesis[];
}

export interface IdentityCollision {
  kind: IdentityKind;
  nameKey: string;
  refs: [string, string];
  /** What kept them apart. */
  attribute: DistinguishingAttribute | 'established';
  values: [string, string];
  reason: string;
}

/** A decision input a link can bear on: its variable, and the refs it already rests on. */
export interface DecisionInput {
  id: string;
  variable: string;
  refs: readonly string[];
}

export interface LinkHypothesis {
  label: 'HYPOTHESIS';
  decisionInput: string;
  entityId: string;
  variables: string[];
  statement: string;
}

export interface IdentityResolution {
  links: IdentityLink[];
  collisions: IdentityCollision[];
  /** Same-name records left apart because nothing corroborated them (not a collision: nothing disagreed either). */
  uncorroborated: { kind: IdentityKind; nameKey: string; refs: [string, string] }[];
  /** Every ref -> its entity id, established ones unchanged. */
  mappings: Record<string, string>;
  hypotheses: LinkHypothesis[];
}

/** A comparable name: legal suffixes off for an entity, otherwise lower-cased alphanumerics. */
export function nameKeyOf(kind: IdentityKind, name: string): string {
  if (kind === 'ENTITY') return employerKey(name) ?? name.trim().toLowerCase();
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** A domain as a comparable host: scheme, `www.` and path removed. */
export function domainKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const host = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0] ?? '';
  return host.includes('.') ? host : null;
}

const norm = (v: string | null | undefined) => (v ? v.trim().toLowerCase().replace(/\s+/g, ' ') : null);

function attributesOf(r: IdentityRecord): Record<DistinguishingAttribute, string | null> {
  return { domain: domainKey(r.domain), registryId: norm(r.registryId), location: norm(r.location) };
}

const ATTRIBUTES: DistinguishingAttribute[] = ['registryId', 'domain', 'location'];

/** The first attribute both records state and disagree on, or null. */
function conflictBetween(a: IdentityRecord, b: IdentityRecord): { attribute: DistinguishingAttribute; values: [string, string] } | null {
  const x = attributesOf(a);
  const y = attributesOf(b);
  for (const attr of ATTRIBUTES) {
    const u = x[attr];
    const v = y[attr];
    if (u && v && u !== v) return { attribute: attr, values: [u, v] };
  }
  return null;
}

/** What corroborates two records being one: a stated cross-reference, or an attribute both state and agree on. */
function corroborationBetween(a: IdentityRecord, b: IdentityRecord): Corroboration | null {
  if ((a.sameAs ?? []).includes(b.ref) || (b.sameAs ?? []).includes(a.ref)) return { between: [a.ref, b.ref], attribute: 'sameAs', value: `${a.ref} = ${b.ref}` };
  const x = attributesOf(a);
  const y = attributesOf(b);
  for (const attr of ATTRIBUTES) {
    const u = x[attr];
    if (u && u === y[attr]) return { between: [a.ref, b.ref], attribute: attr, value: u };
  }
  return null;
}

/** A new cluster's id: derived from its oldest member's ref, so it is the same on every run. */
export function entityIdFor(kind: IdentityKind, ref: string): string {
  return `${kind.toLowerCase()}_${createHash('sha256').update(`${kind}\u0000${ref}`).digest('hex').slice(0, 16)}`;
}

/**
 * Resolve identities across records. A pair is a candidate when it shares a
 * kind and either a name key or a registry id; it is linked only when
 * corroborated and nothing either cluster holds conflicts with the other.
 */
export function resolveIdentities(input: {
  records: readonly IdentityRecord[];
  established?: Readonly<Record<string, string>>;
  decisionInputs?: readonly DecisionInput[];
}): IdentityResolution {
  const established = input.established ?? {};
  const records = [...new Map(input.records.map((r) => [r.ref, r])).values()].sort((a, b) => a.ref.localeCompare(b.ref));
  const parent = new Map(records.map((r) => [r.ref, r.ref]));
  const find = (ref: string): string => {
    let at = ref;
    while (parent.get(at) !== at) at = parent.get(at)!;
    return at;
  };
  const members = (root: string) => records.filter((r) => find(r.ref) === root);
  const corroboration: Corroboration[] = [];
  const collisions: IdentityCollision[] = [];
  const uncorroborated: IdentityResolution['uncorroborated'] = [];

  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      const a = records[i]!;
      const b = records[j]!;
      if (a.kind !== b.kind) continue;
      const nameKey = nameKeyOf(a.kind, a.name);
      const sameName = nameKey !== '' && nameKey === nameKeyOf(b.kind, b.name);
      const ra = attributesOf(a).registryId;
      const sameRegistry = !!ra && ra === attributesOf(b).registryId;
      const crossRef = (a.sameAs ?? []).includes(b.ref) || (b.sameAs ?? []).includes(a.ref);
      if (!sameName && !sameRegistry && !crossRef) continue;
      const ca = find(a.ref);
      const cb = find(b.ref);
      if (ca === cb) continue;
      // Collisions first: anything in one cluster that disagrees with anything in the other keeps them apart.
      let conflict: IdentityCollision | null = null;
      for (const x of members(ca)) {
        for (const y of members(cb)) {
          const c = conflictBetween(x, y);
          if (c) {
            conflict = { kind: a.kind, nameKey, refs: [x.ref, y.ref], attribute: c.attribute, values: c.values, reason: `${c.attribute} differs (${c.values[0]} vs ${c.values[1]}): different ${a.kind.toLowerCase()}s that share a name are not fused` };
            break;
          }
        }
        if (conflict) break;
      }
      if (!conflict) {
        const ea = members(ca).map((m) => established[m.ref]).find(Boolean);
        const eb = members(cb).map((m) => established[m.ref]).find(Boolean);
        if (ea && eb && ea !== eb) {
          conflict = { kind: a.kind, nameKey, refs: [a.ref, b.ref], attribute: 'established', values: [ea, eb], reason: `already established as two entities (${ea}, ${eb}); a new reading does not merge them` };
        }
      }
      if (conflict) {
        collisions.push(conflict);
        continue;
      }
      const why = corroborationBetween(a, b);
      if (!why) {
        uncorroborated.push({ kind: a.kind, nameKey, refs: [a.ref, b.ref] });
        continue;
      }
      corroboration.push(why);
      parent.set(cb < ca ? ca : cb, cb < ca ? cb : ca);
    }
  }

  const roots = [...new Set(records.map((r) => find(r.ref)))].sort();
  const links: IdentityLink[] = [];
  const mappings: Record<string, string> = {};
  for (const root of roots) {
    const group = members(root);
    const first = group[0]!;
    const held = group.map((m) => established[m.ref]).find(Boolean);
    const entityId = held ?? entityIdFor(first.kind, first.ref);
    for (const m of group) mappings[m.ref] = established[m.ref] ?? entityId;
    if (group.length < 2) continue;
    const refs = group.map((m) => m.ref);
    links.push({
      entityId,
      kind: first.kind,
      nameKey: nameKeyOf(first.kind, first.name),
      refs,
      sources: [...new Set(group.map((m) => m.source))].sort(),
      corroboration: corroboration.filter((c) => refs.includes(c.between[0]) && refs.includes(c.between[1])),
      established: !!held,
      variables: [],
      hypotheses: [],
    });
  }

  const hypotheses: LinkHypothesis[] = [];
  const statementOf = (link: IdentityLink, bearing: readonly string[], added: readonly string[], variable: string, decision: string) =>
    `If ${bearing.join(', ')} and ${added.join(', ')} are the same ${link.kind.toLowerCase()} (${[...new Set(link.corroboration.map((c) => `${c.attribute}: ${c.value}`))].join('; ')}), ` +
    `${variable} for ${decision} can draw on ${link.sources.join(' and ')}. A hypothesis until a transaction shows it.`;
  const sourceOf = new Map(records.map((r) => [r.ref, r.source]));
  for (const link of links) {
    if (link.sources.length < 2) continue;
    link.variables = [
      ...link.sources.map((s) => `source:${s}@${link.entityId}`),
      ...[...new Set(link.corroboration.filter((c) => c.attribute !== 'sameAs').map((c) => `${c.attribute}@${link.entityId}=${c.value}`))].sort(),
    ];
    const covered = new Set<string>();
    for (const d of input.decisionInputs ?? []) {
      const bearing = link.refs.filter((r) => d.refs.includes(r));
      if (bearing.length === 0) continue;
      for (const r of bearing) covered.add(r);
      const added = link.refs.filter((r) => !d.refs.includes(r));
      if (added.length === 0) continue;
      const h: LinkHypothesis = {
        label: 'HYPOTHESIS',
        decisionInput: d.id,
        entityId: link.entityId,
        variables: [`${d.variable}@${link.entityId}`],
        statement: statementOf(link, bearing, added, d.variable, d.id),
      };
      hypotheses.push(h);
      link.hypotheses.push(h);
    }
    // A member no supplied input covers bears on the decision its own record feeds; the link adds the
    // records of every other source, which that decision did not rest on.
    for (const ref of link.refs) {
      if (covered.has(ref)) continue;
      const own = sourceOf.get(ref);
      const added = link.refs.filter((r) => sourceOf.get(r) !== own);
      if (added.length === 0) continue;
      link.hypotheses.push({
        label: 'HYPOTHESIS',
        decisionInput: `record:${ref}`,
        entityId: link.entityId,
        variables: link.variables.filter((v) => !v.startsWith(`source:${own}@`)),
        statement: statementOf(link, [ref], added, link.kind.toLowerCase(), `record:${ref}`),
      });
    }
  }
  return { links, collisions, uncorroborated, mappings, hypotheses };
}

/**
 * INST-30 on the manufacturing ladder's own rows: the institutional machinery
 * each live category would need, derived on every kernel pass.
 *
 * `institutions.ts` is the pure derivation; this is the part that builds its
 * `VentureFacts` from rows Brain already holds, and nothing else:
 *
 *  - the venture is the category; its activity is the category's name;
 *  - the owner is the programme's owner;
 *  - a party appears only where filed evidence names one: published demand is
 *    a buyer (and a sale), a distribution channel a distributor (and a sale), a
 *    bought-in component a supplier (and a purchase);
 *  - no jurisdiction, risk, permit or licence is recorded on these rows, so
 *    none is invented: an unstated jurisdiction is the open question the
 *    derivation reports (invariant 34), and feasibility stays UNKNOWN until a
 *    row states one (invariant 39).
 *
 * Read-only, like the venture and competitive readings beside it. A derivation
 * is recomputed from rows on every pass rather than stored, so its obligations
 * and renewal dates are always the current rows' (invariant 45); nothing here
 * creates an entity, opens an account or binds the owner.
 */
import { deriveInstitutions, type FinancialFlow, type InstitutionalDerivation, type VentureFacts, type VentureParty } from './institutions.ts';
import type { LadderSnapshot } from './ladder.ts';
import type { MachineCategory } from '../../domain/types.ts';

export interface CategoryInstitutions {
  categoryId: string;
  name: string;
  derivation: InstitutionalDerivation;
}

/** The venture facts one category's rows state, and nothing they do not. */
export function ventureFactsFor(snapshot: Pick<LadderSnapshot, 'program' | 'evidence' | 'at'>, category: Pick<MachineCategory, 'id' | 'name'>): VentureFacts {
  const parties: VentureParty[] = [{ id: `owner:${snapshot.program.ownerUserId}`, role: 'OWNER', jurisdiction: null }];
  const flows: FinancialFlow[] = [];
  const seen = new Set<string>();
  for (const entry of snapshot.evidence.filter((one) => one.categoryId === category.id)) {
    const role = entry.kind === 'DEMAND_EVIDENCE' ? 'CUSTOMER' : entry.kind === 'DISTRIBUTION_CHANNEL' ? 'DISTRIBUTOR' : entry.kind === 'BOUGHT_IN_COMPONENT' ? 'SUPPLIER' : null;
    if (!role) continue;
    const id = `${role.toLowerCase()}:${entry.subject}`;
    if (seen.has(id)) continue;
    seen.add(id);
    parties.push({ id, role, jurisdiction: null });
    flows.push({ kind: role === 'SUPPLIER' ? 'PURCHASE' : 'SALE', partyId: id });
  }
  return {
    ventureId: category.id,
    activities: [category.name],
    jurisdictions: [],
    parties,
    flows,
    risks: [],
    ipAssets: [],
    claims: [],
    held: [],
    approvals: [],
    economics: null,
    asOf: snapshot.at,
  };
}

/** Every live category's institutional derivation, from the ladder's rows. */
export function institutionsForLadder(snapshot: Pick<LadderSnapshot, 'program' | 'evidence' | 'at' | 'categories'>): CategoryInstitutions[] {
  return snapshot.categories
    .filter((one) => one.retiredAt === null)
    .map((category) => ({ categoryId: category.id, name: category.name, derivation: deriveInstitutions(ventureFactsFor(snapshot, category)) }));
}

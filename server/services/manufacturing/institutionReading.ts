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
 *  - a jurisdiction is one a filed statement names (`statesNamedIn`, the
 *    shared reader), never a default: a category whose rows name none keeps
 *    the open question the derivation reports (invariant 34);
 *  - an established entry barrier is something to obtain from an issuing body,
 *    so it is a PERMIT_REQUIRED claim resolving to the barrier's own source
 *    claim;
 *  - a filed capital figure for an institutional requirement (certification
 *    and approval, intellectual property or a licence) is a COST claim on the
 *    element it prices, resolving to the figure's source claim; every other
 *    capital requirement is the venture's own capital, and is the capital the
 *    venture path costs (`stagesFromReading`), so the institutional plan and
 *    the venture path read the same scenario and the same figures.
 *
 * An element is unpriced only when no filed row prices it. Nothing here
 * invents a figure, a revenue or a running cost: no row states the last two,
 * so they stay null and desirability stays UNKNOWN (invariant 39).
 *
 * Read-only, like the venture and competitive readings beside it. A derivation
 * is recomputed from rows on every pass rather than stored, so its obligations
 * and renewal dates are always the current rows' (invariant 45); nothing here
 * creates an entity, opens an account or binds the owner.
 */
import { deriveInstitutions, type EvidenceClaim, type FinancialFlow, type InstitutionalDerivation, type VentureFacts, type VentureParty } from './institutions.ts';
import type { LadderSnapshot } from './ladder.ts';
import { readLadder, type CategoryReading } from './readiness.ts';
import { statesNamedIn } from '../../domain/jurisdiction.ts';
import { certificationPricesBarrier, type InstitutionalPrerequisite } from './venturePath.ts';
import type { CategoryCapitalEntry, MachineCategory, MachineCapitalRequirement } from '../../domain/types.ts';

export interface CategoryInstitutions {
  categoryId: string;
  name: string;
  derivation: InstitutionalDerivation;
}

/**
 * The capital requirements that are institutional elements rather than the
 * venture's own capital: what an issuing body charges to certify or approve,
 * and what rights to intellectual property cost. Every other requirement
 * (tooling, a facility, stock, working capital, …) is the venture's capital.
 */
const INSTITUTIONAL_REQUIREMENTS: ReadonlySet<MachineCapitalRequirement> = new Set(['CERTIFICATION_AND_APPROVAL', 'INTELLECTUAL_PROPERTY_OR_LICENCE']);

const words = (requirement: string): string => requirement.toLowerCase().replace(/_/g, ' ');

/** The one jurisdiction a statement names, or null when it names none or several. */
function namedJurisdiction(statement: string): string | null {
  const named = statesNamedIn(statement);
  return named.length === 1 ? named[0]! : null;
}

/** The scenario the venture path costs: the cheapest fully priced one, else the first established. */
function pathScenario(reading: CategoryReading | undefined): CategoryCapitalEntry[] {
  const scenario = reading ? reading.capital.cheapestFullyPriced ?? reading.capital.scenarios[0] ?? null : null;
  return scenario ? [...scenario.priced, ...scenario.unpriced] : [];
}

/** The venture facts one category's rows state, and nothing they do not. */
export function ventureFactsFor(
  snapshot: Pick<LadderSnapshot, 'program' | 'evidence' | 'at'>,
  category: Pick<MachineCategory, 'id' | 'name'>,
  reading?: CategoryReading,
): VentureFacts {
  const parties: VentureParty[] = [{ id: `owner:${snapshot.program.ownerUserId}`, role: 'OWNER', jurisdiction: null }];
  const flows: FinancialFlow[] = [];
  const claims: EvidenceClaim[] = [];
  const ipAssets: string[] = [];
  const jurisdictions = new Set<string>();
  const seen = new Set<string>();
  const evidence = snapshot.evidence.filter((one) => one.categoryId === category.id);
  for (const entry of evidence) for (const state of statesNamedIn(entry.statement)) jurisdictions.add(state);
  for (const entry of evidence) {
    const role = entry.kind === 'DEMAND_EVIDENCE' ? 'CUSTOMER' : entry.kind === 'DISTRIBUTION_CHANNEL' ? 'DISTRIBUTOR' : entry.kind === 'BOUGHT_IN_COMPONENT' ? 'SUPPLIER' : null;
    if (!role) continue;
    const id = `${role.toLowerCase()}:${entry.subject}`;
    if (seen.has(id)) continue;
    seen.add(id);
    parties.push({ id, role, jurisdiction: namedJurisdiction(entry.statement) });
    flows.push({ kind: role === 'SUPPLIER' ? 'PURCHASE' : 'SALE', partyId: id });
  }

  // An established entry barrier is a thing to obtain from whoever issues it.
  const barriers = (reading?.evidence.against ?? evidence).filter((one) => one.kind === 'ENTRY_BARRIER');
  for (const barrier of barriers) {
    claims.push({ id: `barrier:${barrier.id}`, sourceId: barrier.sourceClaimId, kind: 'PERMIT_REQUIRED', subject: barrier.subject, jurisdiction: namedJurisdiction(barrier.statement) });
  }

  // The venture path's capital rows: institutional ones price elements, the rest are the venture's capital.
  const entries = pathScenario(reading);
  for (const entry of entries) for (const state of statesNamedIn(entry.statement)) jurisdictions.add(state);
  const venture: { minor: number; currency: string | null; known: boolean } = { minor: 0, currency: null, known: entries.length > 0 };
  for (const entry of entries) {
    const priced = entry.amountLowMinor !== null && entry.amountHighMinor !== null && entry.currency !== null;
    if (INSTITUTIONAL_REQUIREMENTS.has(entry.requirement)) {
      let subject: string;
      if (entry.requirement === 'CERTIFICATION_AND_APPROVAL') {
        // One barrier on record is what the certification figure pays for; otherwise the figure names its own permit.
        if (certificationPricesBarrier(barriers.length)) {
          subject = `PERMIT:${barriers[0]!.subject}`;
        } else {
          const own = `${words(entry.requirement)} for ${category.name}`;
          claims.push({ id: `capital:${entry.id}:requires`, sourceId: entry.sourceClaimId, kind: 'PERMIT_REQUIRED', subject: own, jurisdiction: namedJurisdiction(entry.statement) });
          subject = `PERMIT:${own}`;
        }
      } else {
        const asset = `${words(entry.requirement)} for ${category.name}`;
        if (!ipAssets.includes(asset)) ipAssets.push(asset);
        subject = `IP_OWNERSHIP:${asset}`;
      }
      if (priced) {
        claims.push({
          id: `capital:${entry.id}`,
          sourceId: entry.sourceClaimId,
          kind: 'COST',
          subject,
          jurisdiction: namedJurisdiction(entry.statement),
          amountLowMinor: entry.amountLowMinor,
          amountHighMinor: entry.amountHighMinor,
          currency: entry.currency,
          recurrence: 'ONE_TIME',
        });
      }
      continue;
    }
    // The venture's own capital, read exactly as the venture path reads a stage's budget (its high figure).
    if (!priced || (venture.currency !== null && venture.currency !== entry.currency)) {
      venture.known = false;
      continue;
    }
    venture.minor += entry.amountHighMinor!;
    venture.currency = entry.currency;
  }

  // Every capital row was institutional and priced: the venture's own capital is a known zero in their currency.
  if (venture.known && venture.currency === null) venture.currency = entries.find((one) => one.currency !== null)?.currency ?? null;

  return {
    ventureId: category.id,
    activities: [category.name],
    jurisdictions: [...jurisdictions].sort(),
    parties,
    flows,
    risks: [],
    ipAssets,
    claims,
    held: [],
    approvals: [],
    // No row states revenue or a running cost, so neither is invented; the capital is the path's.
    economics: venture.known && venture.currency !== null
      ? { capitalMinor: venture.minor, monthlyRunningMinor: null, monthlyRevenueMinor: null, currency: venture.currency }
      : null,
    asOf: snapshot.at,
  };
}

/** Every live category's institutional derivation, from the ladder's rows. */
export function institutionsForLadder(snapshot: LadderSnapshot, readings: readonly CategoryReading[] = readLadder(snapshot)): CategoryInstitutions[] {
  const byCategory = new Map(readings.map((one) => [one.categoryId, one]));
  return snapshot.categories
    .filter((one) => one.retiredAt === null)
    .map((category) => ({
      categoryId: category.id,
      name: category.name,
      derivation: deriveInstitutions(ventureFactsFor(snapshot, category, byCategory.get(category.id))),
    }));
}

/**
 * The institutional elements the venture path must carry as stages (INST-30):
 * every element of the best-ranked structure that is not already held and not
 * already a stage of the path. Pure.
 *
 * The path already carries what the ladder's rows price directly — the entry
 * barrier (a PERMIT, or the LICENSE a licence-to-perform barrier becomes), a
 * certification figure's own permit, and the intellectual property a capital
 * row prices — so an element triggered by those claims, priced by a capital
 * row, or naming that asset is not repeated; everything else (contracts,
 * signing authority, accounts, books, tax, entities, insurance, the
 * professionals) is what the plan did not know it needed.
 */
export function pathPrerequisites(one: Pick<CategoryInstitutions, 'name' | 'derivation'>): InstitutionalPrerequisite[] {
  const best = one.derivation.structures[0];
  if (!best) return [];
  const capitalAsset = `${words('INTELLECTUAL_PROPERTY_OR_LICENCE')} for ${one.name}`;
  const carried = (element: (typeof best.elements)[number]): boolean =>
    ((element.kind === 'PERMIT' || element.kind === 'LICENSE') && element.triggeredBy.some((by) => /^claim (?:barrier|capital):/.test(by))) ||
    (element.cost?.claimIds ?? []).some((id) => id.startsWith('capital:')) ||
    (element.kind === 'IP_OWNERSHIP' && element.subject === capitalAsset);
  const kept = best.elements.filter((element) => !element.held && !carried(element));
  const keys = new Set(kept.map((element) => element.key));
  return kept.map((element) => {
    const oneTime = element.cost?.oneTime ?? null;
    const setup: InstitutionalPrerequisite['setup'] = !element.cost
      ? { state: 'UNPRICED' }
      : oneTime
        ? { state: 'PRICED', money: { currency: oneTime.currency, amountMinor: oneTime.highMinor } }
        : { state: 'NONE_FURTHER' };
    return {
      key: element.key,
      kind: element.kind,
      subject: element.subject,
      necessity: element.necessity,
      setup,
      approval: element.approval ? { class: element.approval.class, professionalRole: element.approval.professionalRole } : null,
      // Only prerequisites the path carries are depended on; one it already holds or carries elsewhere is not a stage here.
      prerequisites: element.prerequisites.filter((key) => keys.has(key)),
      evidence: [...element.triggeredBy, ...(element.cost?.claimIds ?? [])],
      enables: element.enables,
    };
  });
}

/**
 * The parties, the compliance envelope, the landed-cost lines, what this trade
 * pays, the pairings between the two sides, and what the attempts taught.
 *
 * Every write here is idempotent by a unique index rather than by a read, for
 * the reason every other repository in this codebase is: the tick runs on more
 * than one instance, both halves of a check-then-write can read "there is no
 * row", and the arbiter has to be the database. A loser reads back the
 * winner's row and carries on, which is an ordinary outcome rather than an
 * error.
 *
 * Nothing here derives anything. There is no stage, no readiness, no landed
 * total and no margin in this file — those are read from these rows by
 * `services/dealflow/`, on the read path, and stored nowhere.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import { equipmentKey } from '../domain/dealflow.ts';
import type {
  CommercialStructure,
  ComplianceLayer,
  CostComponent,
  Deal,
  DealCost,
  DealCostRow,
  DealObservation,
  DealObservationKind,
  DealObservationRow,
  DealParty,
  DealPartyKind,
  DealPartyOrigin,
  DealPartyRow,
  DealRequirement,
  DealRequirementRow,
  DealRound,
  DealRoundPurpose,
  DealRoundState,
  DealRoundRow,
  DealRow,
  DealStructureEvidence,
  DealStructureEvidenceRow,
  RequirementPosture,
} from '../domain/types.ts';

/* --------------------------------------------------------------------------
 * Parties
 * ------------------------------------------------------------------------ */

function mapParty(row: DealPartyRow): DealParty {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as DealPartyKind,
    name: row.name,
    country: row.country,
    equipmentClass: row.equipment_class,
    equipmentKey: row.equipment_key,
    note: row.note,
    decisionMaker: row.decision_maker,
    decisionMakerClaimId: row.decision_maker_claim_id,
    origin: row.origin as DealPartyOrigin,
    sourceClaimId: row.source_claim_id,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Put a party on the map, or find the one already there.
 *
 * The identity is (project, side, name, equipment key), deliberately: two
 * workers reading two sources about the same mine write the same row, and a
 * second would split that party's evidence between rows that nothing joins.
 * The same organisation needing two different classes is genuinely two rows,
 * because a pairing is per class and a supplier of one is not a supplier of
 * the other.
 *
 * `created` is what a caller needs — whether this tick is the one that found
 * it — and it is decided by comparing the id back rather than by the driver's
 * changed count, which the two backends report differently for an insert that
 * conflicted.
 */
export async function createParty(input: {
  projectId: string;
  kind: DealPartyKind;
  name: string;
  country?: string | null;
  equipmentClass: string;
  note?: string | null;
  origin: DealPartyOrigin;
  sourceClaimId?: string | null;
}): Promise<{ party: DealParty; created: boolean }> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('A party must have a name.');
  const equipmentClass = input.equipmentClass.replace(/\s+/g, ' ').trim();
  if (!equipmentClass) throw new Error('A party must name the equipment class it is about.');
  if (input.origin !== 'SEED' && !input.sourceClaimId) {
    throw new Error('Only a seeded party may exist without the claim that established it.');
  }
  const key = equipmentKey(equipmentClass);
  const id = newId('dpt');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO deal_parties
       (id, project_id, kind, name, country, equipment_class, equipment_key, note,
        decision_maker, decision_maker_claim_id, origin, source_claim_id,
        retired_at, retired_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.kind,
      name,
      input.country ?? null,
      equipmentClass,
      key,
      input.note ?? null,
      input.origin,
      input.sourceClaimId ?? null,
      at,
      at,
    ],
  );
  const rows = await getDb().all<DealPartyRow>(
    'SELECT * FROM deal_parties WHERE project_id = ? AND kind = ? AND name = ? AND equipment_key = ?',
    [input.projectId, input.kind, name, key],
  );
  if (!rows[0]) throw new Error('The party disappeared immediately after being written.');
  return { party: mapParty(rows[0]), created: rows[0].id === id };
}

export async function listParties(projectId: string): Promise<DealParty[]> {
  const rows = await getDb().all<DealPartyRow>(
    'SELECT * FROM deal_parties WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapParty);
}

export async function getParty(id: string): Promise<DealParty | null> {
  const rows = await getDb().all<DealPartyRow>('SELECT * FROM deal_parties WHERE id = ?', [id]);
  return rows[0] ? mapParty(rows[0]) : null;
}

/**
 * Attach who decides a purchase, from a claim that said so.
 *
 * Guarded on the column still being null, so the first answer wins and a
 * second cannot silently replace it. §24's `bindRoutineWorker` settled the
 * same question the same way: an observation that quietly re-pointed a row
 * would hide the disagreement rather than surface it. A genuinely better
 * answer is a person's edit, not a later tick's.
 */
export async function attachDecisionMaker(input: {
  partyId: string;
  decisionMaker: string;
  sourceClaimId: string;
}): Promise<boolean> {
  const value = input.decisionMaker.replace(/\s+/g, ' ').trim();
  if (!value) return false;
  const result = await getDb().run(
    `UPDATE deal_parties
        SET decision_maker = ?, decision_maker_claim_id = ?, updated_at = ?
      WHERE id = ? AND decision_maker IS NULL`,
    [value, input.sourceClaimId, nowIso(), input.partyId],
  );
  return (result.changes ?? 0) > 0;
}

export async function retireParty(input: {
  partyId: string;
  reason: string;
}): Promise<DealParty | null> {
  await getDb().run(
    `UPDATE deal_parties SET retired_at = ?, retired_reason = ?, updated_at = ?
      WHERE id = ? AND retired_at IS NULL`,
    [nowIso(), input.reason, nowIso(), input.partyId],
  );
  return getParty(input.partyId);
}

/* --------------------------------------------------------------------------
 * The compliance envelope
 * ------------------------------------------------------------------------ */

function mapRequirement(row: DealRequirementRow): DealRequirement {
  return {
    id: row.id,
    projectId: row.project_id,
    destination: row.destination,
    equipmentClass: row.equipment_class,
    equipmentKey: row.equipment_key,
    layer: row.layer as ComplianceLayer,
    posture: row.posture as RequirementPosture,
    statement: row.statement,
    authority: row.authority,
    effectiveDate: row.effective_date,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function recordRequirement(input: {
  projectId: string;
  destination: string;
  equipmentClass: string;
  layer: ComplianceLayer;
  posture: RequirementPosture;
  statement: string;
  authority?: string | null;
  effectiveDate?: string | null;
  sourceClaimId: string;
}): Promise<{ requirement: DealRequirement; created: boolean }> {
  const id = newId('drq');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO deal_requirements
       (id, project_id, destination, equipment_class, equipment_key, layer, posture,
        statement, authority, effective_date, source_claim_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.destination.replace(/\s+/g, ' ').trim(),
      input.equipmentClass.replace(/\s+/g, ' ').trim(),
      equipmentKey(input.equipmentClass),
      input.layer,
      input.posture,
      input.statement,
      input.authority ?? null,
      input.effectiveDate ?? null,
      input.sourceClaimId,
      at,
      at,
    ],
  );
  const rows = await getDb().all<DealRequirementRow>(
    'SELECT * FROM deal_requirements WHERE source_claim_id = ? AND layer = ?',
    [input.sourceClaimId, input.layer],
  );
  if (!rows[0]) throw new Error('The requirement disappeared immediately after being written.');
  return { requirement: mapRequirement(rows[0]), created: rows[0].id === id };
}

export async function listRequirements(projectId: string): Promise<DealRequirement[]> {
  const rows = await getDb().all<DealRequirementRow>(
    'SELECT * FROM deal_requirements WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapRequirement);
}

/* --------------------------------------------------------------------------
 * The landed cost
 * ------------------------------------------------------------------------ */

function mapCost(row: DealCostRow): DealCost {
  return {
    id: row.id,
    projectId: row.project_id,
    equipmentClass: row.equipment_class,
    equipmentKey: row.equipment_key,
    originCountry: row.origin_country,
    destination: row.destination,
    component: row.component as CostComponent,
    amountCents: row.amount_cents,
    currency: row.currency,
    basis: row.basis,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function recordCost(input: {
  projectId: string;
  equipmentClass: string;
  originCountry?: string | null;
  destination?: string | null;
  component: CostComponent;
  amountCents: number;
  currency: string;
  basis: string;
  sourceClaimId: string;
}): Promise<{ cost: DealCost; created: boolean }> {
  const id = newId('dcs');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO deal_costs
       (id, project_id, equipment_class, equipment_key, origin_country, destination,
        component, amount_cents, currency, basis, source_claim_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.equipmentClass.replace(/\s+/g, ' ').trim(),
      equipmentKey(input.equipmentClass),
      input.originCountry ?? null,
      input.destination ?? null,
      input.component,
      input.amountCents,
      input.currency,
      input.basis,
      input.sourceClaimId,
      at,
      at,
    ],
  );
  const rows = await getDb().all<DealCostRow>(
    'SELECT * FROM deal_costs WHERE source_claim_id = ? AND component = ?',
    [input.sourceClaimId, input.component],
  );
  if (!rows[0]) throw new Error('The cost line disappeared immediately after being written.');
  return { cost: mapCost(rows[0]), created: rows[0].id === id };
}

export async function listCosts(projectId: string): Promise<DealCost[]> {
  const rows = await getDb().all<DealCostRow>(
    'SELECT * FROM deal_costs WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapCost);
}

/* --------------------------------------------------------------------------
 * How this trade pays
 * ------------------------------------------------------------------------ */

function mapStructure(row: DealStructureEvidenceRow): DealStructureEvidence {
  return {
    id: row.id,
    projectId: row.project_id,
    equipmentClass: row.equipment_class,
    equipmentKey: row.equipment_key,
    structure: row.structure as CommercialStructure,
    statement: row.statement,
    rateNote: row.rate_note,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function recordStructureEvidence(input: {
  projectId: string;
  equipmentClass: string;
  structure: CommercialStructure;
  statement: string;
  rateNote?: string | null;
  sourceClaimId: string;
}): Promise<{ evidence: DealStructureEvidence; created: boolean }> {
  const id = newId('dse');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO deal_structure_evidence
       (id, project_id, equipment_class, equipment_key, structure, statement, rate_note,
        source_claim_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.equipmentClass.replace(/\s+/g, ' ').trim(),
      equipmentKey(input.equipmentClass),
      input.structure,
      input.statement,
      input.rateNote ?? null,
      input.sourceClaimId,
      at,
      at,
    ],
  );
  const rows = await getDb().all<DealStructureEvidenceRow>(
    'SELECT * FROM deal_structure_evidence WHERE source_claim_id = ? AND structure = ?',
    [input.sourceClaimId, input.structure],
  );
  if (!rows[0]) throw new Error('The structure evidence disappeared immediately after writing.');
  return { evidence: mapStructure(rows[0]), created: rows[0].id === id };
}

export async function listStructureEvidence(
  projectId: string,
): Promise<DealStructureEvidence[]> {
  const rows = await getDb().all<DealStructureEvidenceRow>(
    'SELECT * FROM deal_structure_evidence WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapStructure);
}

/* --------------------------------------------------------------------------
 * The pairings
 * ------------------------------------------------------------------------ */

function mapDeal(row: DealRow): Deal {
  return {
    id: row.id,
    projectId: row.project_id,
    buyerPartyId: row.buyer_party_id,
    supplierPartyId: row.supplier_party_id,
    equipmentClass: row.equipment_class,
    equipmentKey: row.equipment_key,
    opportunityId: row.opportunity_id,
    blockedReason: row.blocked_reason,
    outcome: row.outcome,
    outcomeNote: row.outcome_note,
    outcomeAt: row.outcome_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function pairDeal(input: {
  projectId: string;
  buyerPartyId: string;
  supplierPartyId: string;
  equipmentClass: string;
}): Promise<{ deal: Deal; created: boolean }> {
  const key = equipmentKey(input.equipmentClass);
  const id = newId('dl');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO deals
       (id, project_id, buyer_party_id, supplier_party_id, equipment_class, equipment_key,
        opportunity_id, blocked_reason, outcome, outcome_note, outcome_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.buyerPartyId,
      input.supplierPartyId,
      input.equipmentClass.replace(/\s+/g, ' ').trim(),
      key,
      at,
      at,
    ],
  );
  const rows = await getDb().all<DealRow>(
    'SELECT * FROM deals WHERE buyer_party_id = ? AND supplier_party_id = ? AND equipment_key = ?',
    [input.buyerPartyId, input.supplierPartyId, key],
  );
  if (!rows[0]) throw new Error('The deal disappeared immediately after being written.');
  return { deal: mapDeal(rows[0]), created: rows[0].id === id };
}

export async function listDeals(projectId: string): Promise<Deal[]> {
  const rows = await getDb().all<DealRow>(
    'SELECT * FROM deals WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapDeal);
}

export async function getDeal(id: string): Promise<Deal | null> {
  const rows = await getDb().all<DealRow>('SELECT * FROM deals WHERE id = ?', [id]);
  return rows[0] ? mapDeal(rows[0]) : null;
}

/**
 * Link a deal to the Cash opportunity it was promoted into.
 *
 * Guarded on the column still being null, so two ticks that both decide a deal
 * is ready produce one opportunity link and the loser is an ordinary outcome.
 * The guard is on a value the caller does not supply, which is the property
 * every compare-and-swap in this codebase rests on.
 */
export async function linkOpportunity(input: {
  dealId: string;
  opportunityId: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE deals SET opportunity_id = ?, updated_at = ?
      WHERE id = ? AND opportunity_id IS NULL`,
    [input.opportunityId, nowIso(), input.dealId],
  );
  return (result.changes ?? 0) > 0;
}

/**
 * Record, or clear, an operational condition stopping a deal.
 *
 * Not a verdict on the deal — an operational fact from a condition somebody
 * can fix — so it is set and cleared freely by whatever derives it, and the
 * caller is responsible for naming the remedy alongside it. Every escalation
 * needs an answering transition.
 */
export async function setDealBlocker(input: {
  dealId: string;
  reason: string | null;
}): Promise<void> {
  await getDb().run('UPDATE deals SET blocked_reason = ?, updated_at = ? WHERE id = ?', [
    input.reason,
    nowIso(),
    input.dealId,
  ]);
}

/**
 * What actually happened, written once.
 *
 * Guarded on the outcome still being null: an outcome that could be rewritten
 * is a history that can be edited, and §5 does not allow one. A correction is
 * a new observation beside it rather than an overwrite of this.
 */
export async function recordDealOutcome(input: {
  dealId: string;
  outcome: string;
  note?: string | null;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE deals SET outcome = ?, outcome_note = ?, outcome_at = ?, updated_at = ?
      WHERE id = ? AND outcome IS NULL`,
    [input.outcome, input.note ?? null, at, at, input.dealId],
  );
  return (result.changes ?? 0) > 0;
}

/* --------------------------------------------------------------------------
 * The rounds
 * ------------------------------------------------------------------------ */

function mapRound(row: DealRoundRow): DealRound {
  return {
    id: row.id,
    projectId: row.project_id,
    cashModeId: row.cash_mode_id,
    purpose: row.purpose as DealRoundPurpose,
    equipmentKey: row.equipment_key,
    equipmentClass: row.equipment_class,
    destination: row.destination,
    partyId: row.party_id,
    dealId: row.deal_id,
    round: row.round,
    candidateId: row.candidate_id,
    state: row.state as DealRoundState,
    openedAt: row.opened_at,
    harvestedAt: row.harvested_at,
    found: row.found,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function openDealRound(input: {
  projectId: string;
  cashModeId: string;
  purpose: DealRoundPurpose;
  equipmentClass?: string | null;
  destination?: string | null;
  partyId?: string | null;
  dealId?: string | null;
  round: number;
  candidateId: string;
}): Promise<{ round: DealRound; created: boolean }> {
  const equipmentClass = input.equipmentClass
    ? input.equipmentClass.replace(/\s+/g, ' ').trim()
    : null;
  const key = equipmentClass ? equipmentKey(equipmentClass) : null;
  const id = newId('drd');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO deal_rounds
       (id, project_id, cash_mode_id, purpose, equipment_key, equipment_class, destination,
        party_id, deal_id, round, candidate_id, state, opened_at, harvested_at, found,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.cashModeId,
      input.purpose,
      key,
      equipmentClass,
      input.destination ?? null,
      input.partyId ?? null,
      input.dealId ?? null,
      input.round,
      input.candidateId,
      at,
      at,
      at,
    ],
  );
  const rows = await getDb().all<DealRoundRow>('SELECT * FROM deal_rounds WHERE id = ?', [id]);
  if (rows[0]) return { round: mapRound(rows[0]), created: true };
  // Lost the race, or asked again on the same key. Read back the winner: a
  // losing insert is an ordinary outcome, not an error.
  const existing = await getDb().all<DealRoundRow>(
    `SELECT * FROM deal_rounds
      WHERE project_id = ? AND purpose = ?
        AND COALESCE(equipment_key, '-') = ?
        AND COALESCE(destination, '-') = ?
        AND COALESCE(party_id, '-') = ?
        AND round = ?`,
    [
      input.projectId,
      input.purpose,
      key ?? '-',
      input.destination ?? '-',
      input.partyId ?? '-',
      input.round,
    ],
  );
  if (!existing[0]) throw new Error('The deal round disappeared immediately after being written.');
  return { round: mapRound(existing[0]), created: false };
}

export async function listDealRounds(projectId: string): Promise<DealRound[]> {
  const rows = await getDb().all<DealRoundRow>(
    'SELECT * FROM deal_rounds WHERE project_id = ? ORDER BY opened_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapRound);
}

export async function openDealRoundsByCandidate(
  projectId: string,
): Promise<Map<string, DealRound>> {
  const rows = await getDb().all<DealRoundRow>(
    "SELECT * FROM deal_rounds WHERE project_id = ? AND state = 'OPEN'",
    [projectId],
  );
  return new Map(rows.map((row) => [row.candidate_id, mapRound(row)]));
}

/**
 * Whether a candidate is a dealflow kernel round.
 *
 * Read by the wind-down guard, which is why `candidate_id` is unique on the
 * table: two rounds sharing one would make this answer ambiguous exactly when
 * it has to be certain.
 */
export async function dealRoundForCandidate(candidateId: string): Promise<DealRound | null> {
  const rows = await getDb().all<DealRoundRow>(
    'SELECT * FROM deal_rounds WHERE candidate_id = ?',
    [candidateId],
  );
  return rows[0] ? mapRound(rows[0]) : null;
}

export async function settleDealRound(input: {
  roundId: string;
  found: number;
}): Promise<DealRound | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE deal_rounds SET state = 'SETTLED', harvested_at = ?, found = ?, updated_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [at, input.found, at, input.roundId],
  );
  const rows = await getDb().all<DealRoundRow>('SELECT * FROM deal_rounds WHERE id = ?', [
    input.roundId,
  ]);
  return rows[0] ? mapRound(rows[0]) : null;
}

/* --------------------------------------------------------------------------
 * What the attempts taught
 * ------------------------------------------------------------------------ */

function mapObservation(row: DealObservationRow): DealObservation {
  return {
    id: row.id,
    projectId: row.project_id,
    dealId: row.deal_id,
    kind: row.kind as DealObservationKind,
    jurisdiction: row.jurisdiction,
    equipmentKey: row.equipment_key,
    statement: row.statement,
    recordedBy: row.recorded_by,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
  };
}

/**
 * One observed outcome. Never a rule.
 *
 * Deliberately not idempotent by content: two attempts that failed the same
 * way are *two* observations, and collapsing them would understate the sample
 * that a derived lesson reports. The sample size is the whole reason a lesson
 * here can be believed.
 */
export async function recordObservation(input: {
  projectId: string;
  dealId?: string | null;
  kind: DealObservationKind;
  jurisdiction?: string | null;
  equipmentClass?: string | null;
  statement: string;
  recordedBy: string;
  sourceClaimId?: string | null;
}): Promise<DealObservation> {
  const id = newId('dob');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO deal_observations
       (id, project_id, deal_id, kind, jurisdiction, equipment_key, statement,
        recorded_by, source_claim_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.dealId ?? null,
      input.kind,
      input.jurisdiction ?? null,
      input.equipmentClass ? equipmentKey(input.equipmentClass) : null,
      input.statement,
      input.recordedBy,
      input.sourceClaimId ?? null,
      at,
    ],
  );
  const rows = await getDb().all<DealObservationRow>(
    'SELECT * FROM deal_observations WHERE id = ?',
    [id],
  );
  if (!rows[0]) throw new Error('The observation disappeared immediately after being written.');
  return mapObservation(rows[0]);
}

export async function listObservations(projectId: string): Promise<DealObservation[]> {
  const rows = await getDb().all<DealObservationRow>(
    'SELECT * FROM deal_observations WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapObservation);
}

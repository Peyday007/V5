/**
 * The puzzle universe, the reusable systems, the puzzles themselves, the
 * products compiled from them, what research established about the trade, the
 * kernel's own questions, and what attempting any of it taught.
 *
 * Every write here is idempotent by a unique index rather than by a read, for
 * the reason every other repository in this codebase is: the tick runs on more
 * than one instance, both halves of a check-then-write can read "there is no
 * row", and the arbiter has to be the database. A loser reads back the
 * winner's row and carries on, which is an ordinary outcome rather than an
 * error.
 *
 * Nothing here derives anything. There is no maturity, no leverage multiplier,
 * no contribution, no qualification verdict and no ledger state in this file —
 * those are read from these rows by `services/puzzle/`, on the read path, and
 * stored nowhere.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import { formatKey as normaliseFormat, labelKey } from '../domain/puzzle.ts';
import type {
  PuzzleConstraint,
  PuzzleConstraintRow,
  PuzzleDemand,
  PuzzleDemandRow,
  PuzzleDifficulty,
  PuzzleEconomic,
  PuzzleEconomicComponent,
  PuzzleEconomicRow,
  PuzzleFormatEntry,
  PuzzleFormatRow,
  PuzzleInstance,
  PuzzleInstanceRow,
  PuzzleMaster,
  PuzzleMasterRow,
  PuzzleObservation,
  PuzzleObservationKind,
  PuzzleObservationRow,
  PuzzleOrigin,
  PuzzleProduct,
  PuzzleProductClass,
  PuzzleProductInstanceRow,
  PuzzleProductRow,
  PuzzleRightsConstraint,
  PuzzleRound,
  PuzzleRoundPurpose,
  PuzzleRoundRow,
  PuzzleRoundState,
  PuzzleRoute,
  PuzzleRouteKind,
  PuzzleRouteRow,
  PuzzleValidationState,
} from '../domain/types.ts';

/* --------------------------------------------------------------------------
 * The universe
 * ------------------------------------------------------------------------ */

function mapFormat(row: PuzzleFormatRow): PuzzleFormatEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    formatKey: row.format_key,
    note: row.note,
    origin: row.origin as PuzzleOrigin,
    sourceClaimId: row.source_claim_id,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Put a format on the map, or find the one already there.
 *
 * The identity is (project, key), so two workers reading two sources about
 * word searches write one row and the first spelling seen is the one shown.
 * `created` is decided by comparing the id back rather than by the driver's
 * changed count, which the two backends report differently for an insert that
 * conflicted.
 */
export async function createPuzzleFormat(input: {
  projectId: string;
  name: string;
  note?: string | null;
  origin: PuzzleOrigin;
  sourceClaimId?: string | null;
}): Promise<{ format: PuzzleFormatEntry; created: boolean }> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('A puzzle format must have a name.');
  if (input.origin !== 'SEED' && !input.sourceClaimId) {
    throw new Error('Only a seeded format may exist without the claim that established it.');
  }
  const key = normaliseFormat(name);
  const id = newId('pzf');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO puzzle_formats
       (id, project_id, name, format_key, note, origin, source_claim_id,
        retired_at, retired_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      name,
      key,
      input.note ?? null,
      input.origin,
      input.sourceClaimId ?? null,
      at,
      at,
    ],
  );
  const rows = await getDb().all<PuzzleFormatRow>(
    'SELECT * FROM puzzle_formats WHERE project_id = ? AND format_key = ?',
    [input.projectId, key],
  );
  if (!rows[0]) throw new Error('The format disappeared immediately after being written.');
  return { format: mapFormat(rows[0]), created: rows[0].id === id };
}

export async function listPuzzleFormats(projectId: string): Promise<PuzzleFormatEntry[]> {
  const rows = await getDb().all<PuzzleFormatRow>(
    'SELECT * FROM puzzle_formats WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapFormat);
}

export async function getPuzzleFormat(id: string): Promise<PuzzleFormatEntry | null> {
  const rows = await getDb().all<PuzzleFormatRow>('SELECT * FROM puzzle_formats WHERE id = ?', [id]);
  return rows[0] ? mapFormat(rows[0]) : null;
}

/** Stop asking about a format. Never a delete — see the migration's header. */
export async function retirePuzzleFormat(input: {
  formatId: string;
  reason: string;
}): Promise<PuzzleFormatEntry | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_formats SET retired_at = ?, retired_reason = ?, updated_at = ?
      WHERE id = ? AND retired_at IS NULL`,
    [at, input.reason, at, input.formatId],
  );
  return getPuzzleFormat(input.formatId);
}

/* --------------------------------------------------------------------------
 * The reusable systems
 * ------------------------------------------------------------------------ */

function mapMaster(row: PuzzleMasterRow): PuzzleMaster {
  let parameters: Record<string, string | number> = {};
  try {
    const parsed: unknown = JSON.parse(row.parameters);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parameters = parsed as Record<string, string | number>;
    }
  } catch {
    /*
     * Unreadable parameters are an empty set rather than a throw, because a
     * master whose JSON somehow broke must still be *visible* — a listing that
     * died would hide every other master beside it. The render then refuses on
     * its own terms, which is where the refusal belongs.
     */
    parameters = {};
  }
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    formatKey: row.format_key,
    corpusId: row.corpus_id,
    parameters,
    difficulty: row.difficulty as PuzzleDifficulty,
    generatorVersion: row.generator_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createPuzzleMaster(input: {
  projectId: string;
  title: string;
  formatName: string;
  corpusId: string;
  parameters: Readonly<Record<string, string | number>>;
  difficulty: PuzzleDifficulty;
  generatorVersion: string;
}): Promise<PuzzleMaster> {
  const id = newId('pzm');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO puzzle_masters
       (id, project_id, title, format_key, corpus_id, parameters, difficulty,
        generator_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.title,
      normaliseFormat(input.formatName),
      input.corpusId,
      JSON.stringify(input.parameters),
      input.difficulty,
      input.generatorVersion,
      at,
      at,
    ],
  );
  const master = await getPuzzleMaster(id);
  if (!master) throw new Error('The master disappeared immediately after being written.');
  return master;
}

export async function getPuzzleMaster(id: string): Promise<PuzzleMaster | null> {
  const rows = await getDb().all<PuzzleMasterRow>('SELECT * FROM puzzle_masters WHERE id = ?', [id]);
  return rows[0] ? mapMaster(rows[0]) : null;
}

export async function listPuzzleMasters(projectId: string): Promise<PuzzleMaster[]> {
  const rows = await getDb().all<PuzzleMasterRow>(
    'SELECT * FROM puzzle_masters WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapMaster);
}

/* --------------------------------------------------------------------------
 * The puzzles
 * ------------------------------------------------------------------------ */

function mapInstance(row: PuzzleInstanceRow): PuzzleInstance {
  let checks: { name: string; ok: boolean; detail: string }[] = [];
  try {
    const parsed: unknown = JSON.parse(row.checks);
    if (Array.isArray(parsed)) {
      checks = parsed as { name: string; ok: boolean; detail: string }[];
    }
  } catch {
    checks = [];
  }
  return {
    id: row.id,
    projectId: row.project_id,
    masterId: row.master_id,
    seed: row.seed,
    contentHash: row.content_hash,
    canonicalHash: row.canonical_hash,
    validationState: row.validation_state as PuzzleValidationState,
    measuredDifficulty: (row.measured_difficulty as PuzzleDifficulty | null) ?? null,
    checks,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Record one puzzle and the verdict on it, in one write.
 *
 * Deliberately not two steps. A row written PENDING and validated afterwards
 * opens a window in which an instance exists with no verdict, and every reader
 * would then have to decide what to do about one — which is how a
 * `PENDING` row ends up being treated as usable by whichever reader forgot.
 * The generator and the validator both run in-process and cost milliseconds,
 * so there is no reason for the window to exist at all.
 *
 * `PENDING` remains in the vocabulary because the schema's CHECK is what makes
 * "validated implies a canonical hash" structural, and a state the constraint
 * describes must be nameable.
 */
export async function recordPuzzleInstance(input: {
  projectId: string;
  masterId: string;
  seed: string;
  contentHash: string;
  canonicalHash: string;
  validationState: Exclude<PuzzleValidationState, 'PENDING'>;
  measuredDifficulty: PuzzleDifficulty | null;
  checks: readonly { name: string; ok: boolean; detail: string }[];
}): Promise<{ instance: PuzzleInstance; created: boolean }> {
  const id = newId('pzi');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO puzzle_instances
       (id, project_id, master_id, seed, content_hash, canonical_hash,
        validation_state, measured_difficulty, checks, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.masterId,
      input.seed,
      input.contentHash,
      input.canonicalHash,
      input.validationState,
      input.measuredDifficulty,
      JSON.stringify(input.checks),
      at,
      at,
    ],
  );
  const rows = await getDb().all<PuzzleInstanceRow>(
    'SELECT * FROM puzzle_instances WHERE master_id = ? AND seed = ?',
    [input.masterId, input.seed],
  );
  if (!rows[0]) throw new Error('The instance disappeared immediately after being written.');
  return { instance: mapInstance(rows[0]), created: rows[0].id === id };
}

export async function listPuzzleInstances(input: {
  projectId: string;
  masterId?: string;
  state?: PuzzleValidationState;
}): Promise<PuzzleInstance[]> {
  const where: string[] = ['project_id = ?'];
  const values: (string | number)[] = [input.projectId];
  if (input.masterId) {
    where.push('master_id = ?');
    values.push(input.masterId);
  }
  if (input.state) {
    where.push('validation_state = ?');
    values.push(input.state);
  }
  const rows = await getDb().all<PuzzleInstanceRow>(
    `SELECT * FROM puzzle_instances WHERE ${where.join(' AND ')}
      ORDER BY created_at ASC, id ASC`,
    values,
  );
  return rows.map(mapInstance);
}

export async function getPuzzleInstance(id: string): Promise<PuzzleInstance | null> {
  const rows = await getDb().all<PuzzleInstanceRow>('SELECT * FROM puzzle_instances WHERE id = ?', [
    id,
  ]);
  return rows[0] ? mapInstance(rows[0]) : null;
}

/**
 * Which canonical forms this project already holds, and how many instances
 * each covers.
 *
 * Read rather than checked per candidate, because duplicate detection is a
 * question about the whole catalog and asking it one row at a time is a query
 * per generated puzzle. The caller compares a new canonical hash against this
 * map before writing, and the unique index on (master, seed) is what makes
 * losing that race harmless.
 */
export async function canonicalCounts(projectId: string): Promise<Map<string, number>> {
  const rows = await getDb().all<{ canonical_hash: string; n: number }>(
    `SELECT canonical_hash, COUNT(*) AS n FROM puzzle_instances
      WHERE project_id = ? AND canonical_hash IS NOT NULL
      GROUP BY canonical_hash`,
    [projectId],
  );
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.canonical_hash, Number(row.n));
  return out;
}

/* --------------------------------------------------------------------------
 * The products
 * ------------------------------------------------------------------------ */

function mapProduct(row: PuzzleProductRow): PuzzleProduct {
  return {
    id: row.id,
    projectId: row.project_id,
    masterId: row.master_id,
    title: row.title,
    productClass: row.product_class as PuzzleProductClass,
    audience: row.audience,
    useOccasion: row.use_occasion,
    language: row.language,
    difficulty: (row.difficulty as PuzzleDifficulty | null) ?? null,
    channel: row.channel,
    buyer: row.buyer,
    instanceCount: Number(row.instance_count),
    opportunityId: row.opportunity_id,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Compile a product from instances that already exist.
 *
 * The instance ids are the product, so they are written in the same call: a
 * product row with no join rows is a product nobody can print, and there is no
 * second step in which somebody could forget to add them. The membership rows
 * are `ON CONFLICT DO NOTHING` so a retry after a lost response finishes the
 * same product rather than refusing it.
 */
export async function createPuzzleProduct(input: {
  projectId: string;
  masterId: string;
  title: string;
  productClass: PuzzleProductClass;
  audience?: string | null;
  useOccasion?: string | null;
  language: string;
  difficulty?: PuzzleDifficulty | null;
  channel?: string | null;
  buyer?: string | null;
  instanceIds: readonly string[];
}): Promise<PuzzleProduct> {
  if (input.instanceIds.length === 0) {
    throw new Error('A product must hold at least one puzzle.');
  }
  const id = newId('pzp');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO puzzle_products
       (id, project_id, master_id, title, product_class, audience, use_occasion,
        language, difficulty, channel, buyer, instance_count, opportunity_id,
        retired_at, retired_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    [
      id,
      input.projectId,
      input.masterId,
      input.title,
      input.productClass,
      input.audience ?? null,
      input.useOccasion ?? null,
      input.language,
      input.difficulty ?? null,
      input.channel ?? null,
      input.buyer ?? null,
      input.instanceIds.length,
      at,
      at,
    ],
  );
  let position = 0;
  for (const instanceId of input.instanceIds) {
    await getDb().run(
      `INSERT INTO puzzle_product_instances (product_id, instance_id, position)
       VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      [id, instanceId, position],
    );
    position += 1;
  }
  const product = await getPuzzleProduct(id);
  if (!product) throw new Error('The product disappeared immediately after being written.');
  return product;
}

export async function getPuzzleProduct(id: string): Promise<PuzzleProduct | null> {
  const rows = await getDb().all<PuzzleProductRow>('SELECT * FROM puzzle_products WHERE id = ?', [
    id,
  ]);
  return rows[0] ? mapProduct(rows[0]) : null;
}

export async function listPuzzleProducts(projectId: string): Promise<PuzzleProduct[]> {
  const rows = await getDb().all<PuzzleProductRow>(
    'SELECT * FROM puzzle_products WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapProduct);
}

/** Which instances each product holds, for the content-overlap reading. */
export async function productMembership(projectId: string): Promise<Map<string, string[]>> {
  const rows = await getDb().all<PuzzleProductInstanceRow>(
    `SELECT pi.* FROM puzzle_product_instances pi
       JOIN puzzle_products p ON p.id = pi.product_id
      WHERE p.project_id = ?
      ORDER BY pi.product_id, pi.position`,
    [projectId],
  );
  const out = new Map<string, string[]>();
  for (const row of rows) {
    out.set(row.product_id, [...(out.get(row.product_id) ?? []), row.instance_id]);
  }
  return out;
}

/**
 * Point a product at the portfolio work it became, once.
 *
 * Guarded on the column still being null, so two ticks that both read a
 * product as ready produce one opportunity and the loser is an ordinary
 * outcome — the same compare-and-swap `linkOpportunity` uses one kernel along,
 * and for the same reason.
 */
export async function linkPuzzleOpportunity(input: {
  productId: string;
  opportunityId: string;
}): Promise<boolean> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_products SET opportunity_id = ?, updated_at = ?
      WHERE id = ? AND opportunity_id IS NULL`,
    [input.opportunityId, at, input.productId],
  );
  const after = await getPuzzleProduct(input.productId);
  return after?.opportunityId === input.opportunityId;
}

export async function retirePuzzleProduct(input: {
  productId: string;
  reason: string;
}): Promise<PuzzleProduct | null> {
  const at = nowIso();
  await getDb().run(
    `UPDATE puzzle_products SET retired_at = ?, retired_reason = ?, updated_at = ?
      WHERE id = ? AND retired_at IS NULL`,
    [at, input.reason, at, input.productId],
  );
  return getPuzzleProduct(input.productId);
}

/* --------------------------------------------------------------------------
 * What research established
 * ------------------------------------------------------------------------ */

function mapDemand(row: PuzzleDemandRow): PuzzleDemand {
  return {
    id: row.id,
    projectId: row.project_id,
    formatKey: row.format_key,
    buyer: row.buyer,
    buyerKey: row.buyer_key,
    statement: row.statement,
    publisher: row.publisher,
    observedOn: row.observed_on,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
  };
}

export async function recordPuzzleDemand(input: {
  projectId: string;
  formatName: string;
  buyer: string;
  statement: string;
  publisher?: string | null;
  observedOn?: string | null;
  sourceClaimId: string;
}): Promise<{ demand: PuzzleDemand; created: boolean }> {
  const buyer = input.buyer.replace(/\s+/g, ' ').trim();
  if (!buyer) throw new Error('A demand signal must name a buyer.');
  const key = normaliseFormat(input.formatName);
  const buyerK = labelKey(buyer);
  const id = newId('pzd');
  await getDb().run(
    `INSERT INTO puzzle_demand
       (id, project_id, format_key, buyer, buyer_key, statement, publisher,
        observed_on, source_claim_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      key,
      buyer,
      buyerK,
      input.statement,
      input.publisher ?? null,
      input.observedOn ?? null,
      input.sourceClaimId,
      nowIso(),
    ],
  );
  const rows = await getDb().all<PuzzleDemandRow>(
    'SELECT * FROM puzzle_demand WHERE project_id = ? AND format_key = ? AND buyer_key = ?',
    [input.projectId, key, buyerK],
  );
  if (!rows[0]) throw new Error('The demand signal disappeared after being written.');
  return { demand: mapDemand(rows[0]), created: rows[0].id === id };
}

export async function listPuzzleDemand(projectId: string): Promise<PuzzleDemand[]> {
  const rows = await getDb().all<PuzzleDemandRow>(
    'SELECT * FROM puzzle_demand WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapDemand);
}

function mapRoute(row: PuzzleRouteRow): PuzzleRoute {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as PuzzleRouteKind,
    formatKey: row.format_key,
    name: row.name,
    nameKey: row.name_key,
    terms: row.terms,
    publisher: row.publisher,
    observedOn: row.observed_on,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
  };
}

export async function recordPuzzleRoute(input: {
  projectId: string;
  kind: PuzzleRouteKind;
  formatName: string;
  name: string;
  terms: string;
  publisher?: string | null;
  observedOn?: string | null;
  sourceClaimId: string;
}): Promise<{ route: PuzzleRoute; created: boolean }> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('A route must have a name.');
  const key = normaliseFormat(input.formatName);
  const nameK = labelKey(name);
  const id = newId('pzr');
  await getDb().run(
    `INSERT INTO puzzle_routes
       (id, project_id, kind, format_key, name, name_key, terms, publisher,
        observed_on, source_claim_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.kind,
      key,
      name,
      nameK,
      input.terms,
      input.publisher ?? null,
      input.observedOn ?? null,
      input.sourceClaimId,
      nowIso(),
    ],
  );
  const rows = await getDb().all<PuzzleRouteRow>(
    `SELECT * FROM puzzle_routes
      WHERE project_id = ? AND kind = ? AND format_key = ? AND name_key = ?`,
    [input.projectId, input.kind, key, nameK],
  );
  if (!rows[0]) throw new Error('The route disappeared after being written.');
  return { route: mapRoute(rows[0]), created: rows[0].id === id };
}

export async function listPuzzleRoutes(projectId: string): Promise<PuzzleRoute[]> {
  const rows = await getDb().all<PuzzleRouteRow>(
    'SELECT * FROM puzzle_routes WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapRoute);
}

function mapEconomic(row: PuzzleEconomicRow): PuzzleEconomic {
  return {
    id: row.id,
    projectId: row.project_id,
    formatKey: row.format_key,
    productClass: row.product_class as PuzzleProductClass,
    component: row.component as PuzzleEconomicComponent,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    basisNote: row.basis_note,
    publisher: row.publisher,
    observedOn: row.observed_on,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
  };
}

export async function recordPuzzleEconomic(input: {
  projectId: string;
  formatName: string;
  productClass: PuzzleProductClass;
  component: PuzzleEconomicComponent;
  amountCents: number;
  currency: string;
  basisNote: string;
  publisher?: string | null;
  observedOn?: string | null;
  sourceClaimId: string;
}): Promise<{ economic: PuzzleEconomic; created: boolean }> {
  const key = normaliseFormat(input.formatName);
  const id = newId('pze');
  await getDb().run(
    `INSERT INTO puzzle_economics
       (id, project_id, format_key, product_class, component, amount_cents,
        currency, basis_note, publisher, observed_on, source_claim_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      key,
      input.productClass,
      input.component,
      input.amountCents,
      input.currency.toUpperCase(),
      input.basisNote,
      input.publisher ?? null,
      input.observedOn ?? null,
      input.sourceClaimId,
      nowIso(),
    ],
  );
  const rows = await getDb().all<PuzzleEconomicRow>(
    `SELECT * FROM puzzle_economics
      WHERE project_id = ? AND format_key = ? AND product_class = ?
        AND component = ? AND source_claim_id = ?`,
    [input.projectId, key, input.productClass, input.component, input.sourceClaimId],
  );
  if (!rows[0]) throw new Error('The figure disappeared after being written.');
  return { economic: mapEconomic(rows[0]), created: rows[0].id === id };
}

export async function listPuzzleEconomics(projectId: string): Promise<PuzzleEconomic[]> {
  const rows = await getDb().all<PuzzleEconomicRow>(
    'SELECT * FROM puzzle_economics WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapEconomic);
}

function mapConstraint(row: PuzzleConstraintRow): PuzzleConstraint {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as PuzzleRightsConstraint,
    subject: row.subject,
    statement: row.statement,
    authority: row.authority,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
  };
}

export async function recordPuzzleConstraint(input: {
  projectId: string;
  kind: PuzzleRightsConstraint;
  subject: string;
  statement: string;
  authority?: string | null;
  sourceClaimId: string;
}): Promise<{ constraint: PuzzleConstraint; created: boolean }> {
  const subject = input.subject.replace(/\s+/g, ' ').trim();
  if (!subject) throw new Error('A rights constraint must name what it is about.');
  const id = newId('pzc');
  await getDb().run(
    `INSERT INTO puzzle_constraints
       (id, project_id, kind, subject, statement, authority, source_claim_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.kind,
      subject,
      input.statement,
      input.authority ?? null,
      input.sourceClaimId,
      nowIso(),
    ],
  );
  const rows = await getDb().all<PuzzleConstraintRow>(
    `SELECT * FROM puzzle_constraints
      WHERE project_id = ? AND kind = ? AND subject = ? AND source_claim_id = ?`,
    [input.projectId, input.kind, subject, input.sourceClaimId],
  );
  if (!rows[0]) throw new Error('The constraint disappeared after being written.');
  return { constraint: mapConstraint(rows[0]), created: rows[0].id === id };
}

export async function listPuzzleConstraints(projectId: string): Promise<PuzzleConstraint[]> {
  const rows = await getDb().all<PuzzleConstraintRow>(
    'SELECT * FROM puzzle_constraints WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapConstraint);
}

/* --------------------------------------------------------------------------
 * The kernel's questions
 * ------------------------------------------------------------------------ */

function mapRound(row: PuzzleRoundRow): PuzzleRound {
  return {
    id: row.id,
    projectId: row.project_id,
    cashModeId: row.cash_mode_id,
    purpose: row.purpose as PuzzleRoundPurpose,
    formatKey: row.format_key,
    productClass: (row.product_class as PuzzleProductClass | null) ?? null,
    candidateId: row.candidate_id,
    round: Number(row.round),
    state: row.state as PuzzleRoundState,
    found: row.found === null ? null : Number(row.found),
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

export async function openPuzzleRound(input: {
  projectId: string;
  cashModeId: string;
  purpose: PuzzleRoundPurpose;
  formatKey: string | null;
  productClass: PuzzleProductClass | null;
  candidateId: string;
  round: number;
}): Promise<{ round: PuzzleRound; created: boolean }> {
  const id = newId('pzq');
  await getDb().run(
    `INSERT INTO puzzle_rounds
       (id, project_id, cash_mode_id, purpose, format_key, product_class,
        candidate_id, round, state, found, created_at, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, ?, NULL)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.cashModeId,
      input.purpose,
      input.formatKey,
      input.productClass,
      input.candidateId,
      input.round,
      nowIso(),
    ],
  );
  /*
   * Read back by the natural key rather than by the candidate: a tick that
   * lost the race on the unique index holds a candidate nothing points at, and
   * looking the round up by that candidate would find nothing and read as a
   * failure rather than as an ordinary loss.
   *
   * The two nullable columns are matched by **building the clause rather than
   * parameterising the nullity test**, because `? IS NULL` is a placeholder
   * with nothing around it for Postgres to infer a type from — ordinary SQLite
   * and `42P18 could not determine data type of parameter` on the backend
   * production runs. §47 records the same shape costing a full Postgres run to
   * find, and `russellFoundationCloseout` refuses it by reading the source.
   * `CAST(? AS TEXT) IS NULL` would also work; emitting `IS NULL` with no
   * parameter at all is simpler and cannot be got wrong a second time.
   */
  const where = ['project_id = ?', 'purpose = ?', 'round = ?'];
  const values: (string | number)[] = [input.projectId, input.purpose, input.round];
  if (input.formatKey === null) where.push('format_key IS NULL');
  else {
    where.push('format_key = ?');
    values.push(input.formatKey);
  }
  if (input.productClass === null) where.push('product_class IS NULL');
  else {
    where.push('product_class = ?');
    values.push(input.productClass);
  }
  const rows = await getDb().all<PuzzleRoundRow>(
    `SELECT * FROM puzzle_rounds WHERE ${where.join(' AND ')}`,
    values,
  );
  if (!rows[0]) throw new Error('The round disappeared immediately after being written.');
  return { round: mapRound(rows[0]), created: rows[0].id === id };
}

/**
 * Close a round with what it established.
 *
 * Guarded on the round still being OPEN, so two passes reading one finished
 * mission settle it once and the count is the first pass's rather than a
 * later pass's re-derivation over rows that have since moved.
 */
export async function settlePuzzleRound(input: {
  roundId: string;
  found: number;
}): Promise<PuzzleRound | null> {
  await getDb().run(
    `UPDATE puzzle_rounds SET state = 'SETTLED', found = ?, settled_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [input.found, nowIso(), input.roundId],
  );
  const rows = await getDb().all<PuzzleRoundRow>('SELECT * FROM puzzle_rounds WHERE id = ?', [
    input.roundId,
  ]);
  return rows[0] ? mapRound(rows[0]) : null;
}

export async function listPuzzleRounds(projectId: string): Promise<PuzzleRound[]> {
  const rows = await getDb().all<PuzzleRoundRow>(
    'SELECT * FROM puzzle_rounds WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapRound);
}

/** The live rounds, keyed by the candidate that asks each one. */
export async function openPuzzleRoundsByCandidate(
  projectId: string,
): Promise<Map<string, PuzzleRound>> {
  const rows = await getDb().all<PuzzleRoundRow>(
    "SELECT * FROM puzzle_rounds WHERE project_id = ? AND state = 'OPEN'",
    [projectId],
  );
  const out = new Map<string, PuzzleRound>();
  for (const row of rows) out.set(row.candidate_id, mapRound(row));
  return out;
}

/** Which kernel question this candidate is asking, if any. Read by the compiler. */
export async function puzzleRoundForCandidate(candidateId: string): Promise<PuzzleRound | null> {
  const rows = await getDb().all<PuzzleRoundRow>(
    'SELECT * FROM puzzle_rounds WHERE candidate_id = ?',
    [candidateId],
  );
  return rows[0] ? mapRound(rows[0]) : null;
}

/* --------------------------------------------------------------------------
 * What actually happened
 * ------------------------------------------------------------------------ */

function mapObservation(row: PuzzleObservationRow): PuzzleObservation {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as PuzzleObservationKind,
    formatKey: row.format_key,
    productId: row.product_id,
    monetizationRoute: row.monetization_route,
    statement: row.statement,
    recordedBy: row.recorded_by,
    createdAt: row.created_at,
  };
}

export async function recordPuzzleObservation(input: {
  projectId: string;
  kind: PuzzleObservationKind;
  formatName?: string | null;
  productId?: string | null;
  monetizationRoute?: string | null;
  statement: string;
  recordedBy: string;
}): Promise<PuzzleObservation> {
  const id = newId('pzo');
  await getDb().run(
    `INSERT INTO puzzle_observations
       (id, project_id, kind, format_key, product_id, monetization_route,
        statement, recorded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.kind,
      input.formatName ? normaliseFormat(input.formatName) : null,
      input.productId ?? null,
      input.monetizationRoute ?? null,
      input.statement,
      input.recordedBy,
      nowIso(),
    ],
  );
  const rows = await getDb().all<PuzzleObservationRow>(
    'SELECT * FROM puzzle_observations WHERE id = ?',
    [id],
  );
  if (!rows[0]) throw new Error('The observation disappeared after being written.');
  return mapObservation(rows[0]);
}

export async function listPuzzleObservations(projectId: string): Promise<PuzzleObservation[]> {
  const rows = await getDb().all<PuzzleObservationRow>(
    'SELECT * FROM puzzle_observations WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapObservation);
}

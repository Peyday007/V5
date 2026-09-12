/**
 * A lens that is asked, and the governed path from asking to a row.
 *
 * `frontier.ts` splits ten lenses into five it answers from rows and five it
 * only *puts*, on the rule that a Brain filling them in from a template would
 * be manufacturing insight. **That rule is right and it is not the whole
 * design.** What it produced was five questions on a screen with nothing behind
 * them — no way to ask, no way to answer, no way for an answer to become
 * anything. That is the defect this repository keeps meeting from the other
 * side: a state that says "only a reader can settle this" with no path a reader
 * can take.
 *
 * So the asked half gets an execution path, and every control that makes it
 * safe is a control this codebase already had:
 *
 *  - **A person opens it.** An inquiry is never started by a model, by a
 *    worker, or by the tick. There is nothing here a machine can ask itself.
 *  - **A worker answers it, through a bin.** Same fleet, same lease, same
 *    fencing, same crash recovery as a Russell turn (§24). No inference is
 *    bought and no second execution path is created.
 *  - **The reply is validated to death before anything is stored.** A closed
 *    structure, exact fields, bounded lengths — and then the condition that
 *    actually does the work: **every finding must name rows this project
 *    already holds**, and one whose references do not resolve *in scope* is
 *    discarded. That is `findings.ts`'s rule — a finding whose quote cannot be
 *    located in the source is discarded — applied to a discovery lens. A model
 *    cannot invent a subject here, because a subject it invented resolves to
 *    nothing.
 *  - **Novelty is checked.** A finding that restates something the project
 *    already holds is discarded naming what it restates, so §29's "restated
 *    existing items do not count as discoveries" is a code path rather than an
 *    instruction.
 *  - **Nothing becomes knowledge.** A surviving finding is a *proposal*. It
 *    becomes a frontier item when a person accepts it, and the acceptance is an
 *    append-only row naming who. §11 again: created as proposed, evidence only
 *    when somebody says so.
 *
 * What this deliberately does **not** do is answer a DERIVED lens. Those are
 * facts read from rows, and asking a model for one would replace a fact with an
 * opinion — the exact inversion §8 exists to prevent. `openInquiry` refuses one
 * by name.
 */
import { getDb } from '../../db/database.ts';
import { newId, nowIso, parseJson, toJson } from '../../repos/util.ts';
import { createBin, getBin, listBinUnitResults } from '../../repos/bins.ts';
import { listCurrentKnowledge } from '../../repos/russellMissions.ts';
import { listFrontier, observeFrontierItem } from '../../repos/russellFrontier.ts';
import { listLayers } from '../../repos/layers.ts';
import { LENSES, type LensKey } from './frontier.ts';
import { overlap } from './similarity.ts';
import type { BinState, RussellVisibility } from '../../domain/types.ts';

/** The one unit an inquiry bin asks for. */
export const INQUIRY_UNIT_KEY = 'lens_findings';

export const INQUIRY_STATES = [
  'REQUESTED',
  'RUNNING',
  'ANSWERED',
  'REFUSED',
  'FAILED',
  'CANCELLED',
] as const;
export type InquiryState = (typeof INQUIRY_STATES)[number];

/** How close a proposal may be to something already held before it is a restatement. */
export const NOVELTY_FLOOR = 0.72;

/** The bounds a reply is held to. Generous enough to be usable, closed enough to be a schema. */
export const INQUIRY_LIMITS = {
  maxFindings: 6,
  subject: 200,
  statement: 600,
  rationale: 800,
  maxReferences: 6,
} as const;

/**
 * One thing a lens proposed, after validation.
 *
 * `references` is the load-bearing field. Every entry resolved to a real row in
 * this project when it was stored, which is what makes the finding a claim
 * *about the project* rather than a sentence about the world.
 */
export interface LensFinding {
  subject: string;
  statement: string;
  rationale: string;
  references: { kind: 'KNOWLEDGE' | 'LAYER' | 'FRONTIER'; id: string }[];
}

export interface LensInquiry {
  id: string;
  projectId: string;
  lens: LensKey;
  question: string;
  subject: string | null;
  state: InquiryState;
  refusalReason: string | null;
  binId: string | null;
  findings: LensFinding[];
  discarded: number;
  discardReasons: string[];
  openedBy: string;
  visibility: RussellVisibility;
  createdAt: string;
  updatedAt: string;
  answeredAt: string | null;
  /** What a person has already decided about each finding, by index. */
  decisions: { findingIndex: number; decision: 'ACCEPTED' | 'DISMISSED'; reason: string | null }[];
}

interface Row {
  id: string;
  project_id: string;
  lens: string;
  question: string;
  subject: string | null;
  state: string;
  refusal_reason: string | null;
  bin_id: string | null;
  findings: string;
  discarded: number;
  discard_reasons: string;
  opened_by: string;
  visibility: string;
  created_at: string;
  updated_at: string;
  answered_at: string | null;
}

function map(row: Row): LensInquiry {
  return {
    id: row.id,
    projectId: row.project_id,
    lens: row.lens as LensKey,
    question: row.question,
    subject: row.subject,
    state: row.state as InquiryState,
    refusalReason: row.refusal_reason,
    binId: row.bin_id,
    findings: parseJson<LensFinding[]>(row.findings, []),
    discarded: row.discarded,
    discardReasons: parseJson<string[]>(row.discard_reasons, []),
    openedBy: row.opened_by,
    visibility: row.visibility as RussellVisibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    answeredAt: row.answered_at,
    decisions: [],
  };
}

/** Which lenses may be asked at all. */
export function askableLenses(): { key: LensKey; question: string }[] {
  return LENSES.filter((lens) => lens.kind === 'ASKED').map((lens) => ({
    key: lens.key,
    question: lens.question,
  }));
}

export function isAskable(lens: string): lens is LensKey {
  return LENSES.some((entry) => entry.key === lens && entry.kind === 'ASKED');
}

/* ==========================================================================
 * Opening one
 * ========================================================================== */

export async function openInquiry(input: {
  projectId: string;
  projectName: string;
  lens: string;
  /** What it is about, chosen by the person asking, or derived when absent. */
  subject?: string | null;
  openedBy: string;
  visibility?: RussellVisibility;
}): Promise<{ ok: true; inquiry: LensInquiry } | { ok: false; reason: string }> {
  const declared = LENSES.find((entry) => entry.key === input.lens);
  if (!declared) return { ok: false, reason: 'There is no lens by that name.' };
  if (declared.kind !== 'ASKED') {
    /*
     * Refused by name rather than allowed and ignored.
     *
     * A DERIVED lens is answered from rows every time the frontier refreshes.
     * Handing that question to a model would produce an opinion where a fact
     * already exists, and the opinion would be the one a person read.
     */
    return {
      ok: false,
      reason: `${declared.question} is answered from the project's own rows on every frontier pass. Asking a worker for it would replace a fact with an opinion.`,
    };
  }

  // One open inquiry per lens per project: a second would race the first to
  // propose the same findings and a person would decide twice.
  const existing = await getDb().get<Row>(
    `SELECT * FROM russell_lens_inquiries
      WHERE project_id = ? AND lens = ? AND state IN ('REQUESTED','RUNNING')
      LIMIT 1`,
    [input.projectId, input.lens],
  );
  if (existing) return { ok: true, inquiry: map(existing) };

  const now = nowIso();
  const id = newId('rli');
  await getDb().run(
    `INSERT INTO russell_lens_inquiries
       (id, project_id, lens, question, subject, state, findings, discarded,
        discard_reasons, opened_by, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'REQUESTED', '[]', 0, '[]', ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      declared.key,
      declared.question,
      input.subject?.trim() || null,
      input.openedBy,
      input.visibility ?? 'SHARED',
      now,
      now,
    ],
  );
  return { ok: true, inquiry: (await getInquiry(id))! };
}

export async function getInquiry(id: string): Promise<LensInquiry | null> {
  const row = await getDb().get<Row>('SELECT * FROM russell_lens_inquiries WHERE id = ?', [id]);
  if (!row) return null;
  const inquiry = map(row);
  inquiry.decisions = await decisionsFor(id);
  return inquiry;
}

export async function listInquiries(input: {
  projectId: string;
  includePrivate?: boolean;
}): Promise<LensInquiry[]> {
  const rows = await getDb().all<Row>(
    input.includePrivate
      ? `SELECT * FROM russell_lens_inquiries WHERE project_id = ? ORDER BY created_at DESC LIMIT 50`
      : `SELECT * FROM russell_lens_inquiries WHERE project_id = ? AND visibility = 'SHARED'
           ORDER BY created_at DESC LIMIT 50`,
    [input.projectId],
  );
  const out: LensInquiry[] = [];
  for (const row of rows) {
    const inquiry = map(row);
    inquiry.decisions = await decisionsFor(row.id);
    out.push(inquiry);
  }
  return out;
}

async function decisionsFor(
  inquiryId: string,
): Promise<LensInquiry['decisions']> {
  const rows = await getDb().all<{
    finding_index: number;
    decision: string;
    reason: string | null;
  }>(
    `SELECT finding_index, decision, reason FROM russell_lens_decisions
      WHERE inquiry_id = ? ORDER BY finding_index`,
    [inquiryId],
  );
  return rows.map((row) => ({
    findingIndex: row.finding_index,
    decision: row.decision as 'ACCEPTED' | 'DISMISSED',
    reason: row.reason,
  }));
}

/* ==========================================================================
 * Carrying it to a worker
 * ========================================================================== */

/**
 * Turn one waiting inquiry into a bin, exactly once.
 *
 * Claim-then-act, like every other effect in this codebase: the state moves to
 * `RUNNING` under a guarded `UPDATE` **before** the bin is created, so a
 * redelivered tick cannot produce two bins for one question. The crash window
 * this opens loses a bin and leaves a visibly `RUNNING` inquiry, which is
 * recoverable; the other order would silently spend two activations.
 */
export async function dispatchInquiry(inquiry: LensInquiry): Promise<string | null> {
  const now = nowIso();
  const claimed = await getDb().run(
    `UPDATE russell_lens_inquiries SET state = 'RUNNING', updated_at = ?
      WHERE id = ? AND state = 'REQUESTED'`,
    [now, inquiry.id],
  );
  if (claimed.changes !== 1) return null;

  const context = await inquiryContext(inquiry.projectId);
  const bin = await createBin({
    projectId: inquiry.projectId,
    kind: 'RUSSELL_TURN',
    title: `Answer one discovery lens: ${inquiry.question}`,
    objective: inquiry.question,
    rationale: 'A person asked a question only a reader of the project can answer.',
    manifest: {
      objective: inquiry.question,
      why: 'One discovery lens, asked by a person, about this project.',
      lineage: {
        projectId: inquiry.projectId,
        layerId: null,
        goal: inquiry.question,
        orchestrationId: null,
      },
      units: [
        {
          key: INQUIRY_UNIT_KEY,
          establishes: 'findings that each name rows this project already holds',
          input: context.rendered,
          transform: 'none',
          dependsOn: [],
        },
      ],
      acceptableSources: ["the project's own knowledge, layers and frontier"],
      excludedSources: ['anything outside this project', 'general knowledge not grounded in a row'],
      /*
       * The schema, written out on the bin the worker reads.
       *
       * `turn.ts` learned this the expensive way twice: a rule enforced against
       * somebody who was never told it is a trap, and a manifest that omits the
       * vocabulary produces a refusal that looks like the worker's fault. So the
       * exact shape, the exact bounds, and — most importantly — the fact that
       * citations must come from the ids in the input are all stated here.
       */
      evidence: [
        'one JSON object with exactly one field: "findings", an array',
        `at most ${INQUIRY_LIMITS.maxFindings} findings, and an empty array is a valid answer`,
        'each finding has exactly: "subject", "statement", "rationale", "references"',
        `"subject" at most ${INQUIRY_LIMITS.subject} characters, "statement" at most ${INQUIRY_LIMITS.statement}, "rationale" at most ${INQUIRY_LIMITS.rationale}`,
        `"references" is 1 to ${INQUIRY_LIMITS.maxReferences} entries of {"kind","id"} where kind is KNOWLEDGE, LAYER or FRONTIER`,
        'every id must be one printed in the input above — an id that is not there discards the finding',
        'a finding that restates something already listed in the input is discarded as a restatement',
      ],
      outputs: ['one submitted unit result whose value is that JSON object'],
      authorizedActions: ['reading this project', 'submitting one unit result'],
      prohibitedActions: [
        'researching anything outside this project',
        'writing knowledge, a document, a claim or an audit',
        'proposing a finding that cites nothing',
      ],
      budgetUnits: 1,
      retry: { maxAttempts: 2, backoffSeconds: 30 },
      stoppingConditions: ['one set of findings has been submitted'],
    },
    completionContract: 'RUSSELL_LENS_V1',
    createdByType: 'SYSTEM',
    createdById: `russell:lens:${inquiry.id}`,
    ready: true,
    priority: 6,
    maxAttempts: 2,
    workloadClass: 'RUSSELL_TURN',
  });

  await getDb().run(
    `UPDATE russell_lens_inquiries SET bin_id = ?, updated_at = ? WHERE id = ?`,
    [bin.id, nowIso(), inquiry.id],
  );
  return bin.id;
}

/**
 * What a lens is allowed to see, and the ids it must cite from.
 *
 * Deliberately just the project's own rows. A lens that could reach outside
 * this project would be able to propose a finding nobody in this scope can
 * check — and for `TRANSFERABLE_LESSON`, which is *about* another project, that
 * is exactly why the lesson must be expressed as a statement about **this**
 * project's rows rather than as a citation of somebody else's.
 */
export async function inquiryContext(projectId: string): Promise<{
  rendered: string;
  knowledgeIds: Set<string>;
  layerIds: Set<string>;
  frontierIds: Set<string>;
  held: string[];
}> {
  const [knowledge, layers, frontier] = await Promise.all([
    listCurrentKnowledge({ projectId, includePrivate: false, limit: 40 }),
    listLayers(projectId),
    listFrontier({ projectId, includePrivate: false }),
  ]);

  const lines: string[] = ['KNOWLEDGE THIS PROJECT HOLDS'];
  for (const row of knowledge) lines.push(`  KNOWLEDGE ${row.id} [${row.kind}] ${row.statement}`);
  lines.push('', 'FOUNDATIONS');
  for (const layer of layers) lines.push(`  LAYER ${layer.id} [${layer.status}] ${layer.name}`);
  lines.push('', 'ALREADY ON THE FRONTIER');
  for (const item of frontier) {
    if (item.resolvedAt !== null) continue;
    lines.push(`  FRONTIER ${item.id} [${item.region}] ${item.subject}`);
  }

  return {
    rendered: lines.join('\n'),
    knowledgeIds: new Set(knowledge.map((row) => row.id)),
    layerIds: new Set(layers.map((row) => row.id)),
    frontierIds: new Set(
      frontier.filter((item) => item.resolvedAt === null).map((item) => item.id),
    ),
    held: [
      ...knowledge.map((row) => row.statement),
      ...frontier.filter((item) => item.resolvedAt === null).map((item) => item.subject),
    ],
  };
}

/* ==========================================================================
 * Validating what came back
 * ========================================================================== */

export interface Validated {
  findings: LensFinding[];
  discarded: number;
  reasons: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Zero-trust validation of a lens reply.
 *
 * Two different kinds of rejection, kept apart because they mean different
 * things to a reader: a **malformed** reply means the worker did not answer the
 * question that was asked, and a **discarded finding** means it answered and
 * this particular proposal did not survive. The second is normal; the first is
 * a failure.
 *
 * Nothing partial is repaired. An unknown field refuses the whole reply, which
 * is `proposal.ts`'s rule and exists for the same reason: a validator that
 * ignores what it does not recognise is a validator somebody can extend from
 * the outside.
 */
export function validateLensReply(
  raw: unknown,
  context: { knowledgeIds: Set<string>; layerIds: Set<string>; frontierIds: Set<string>; held: string[] },
): { ok: true; result: Validated } | { ok: false; reason: string } {
  const record = asRecord(raw);
  if (!record) return { ok: false, reason: 'The reply was not an object.' };

  for (const key of Object.keys(record)) {
    if (key !== 'findings') {
      return { ok: false, reason: `The reply carried an unknown field "${key}".` };
    }
  }
  const list = record['findings'];
  if (!Array.isArray(list)) return { ok: false, reason: '"findings" must be an array.' };
  if (list.length > INQUIRY_LIMITS.maxFindings) {
    return {
      ok: false,
      reason: `At most ${INQUIRY_LIMITS.maxFindings} findings; this reply carried ${list.length}.`,
    };
  }

  const findings: LensFinding[] = [];
  const reasons: string[] = [];
  let discarded = 0;

  for (const entry of list) {
    const item = asRecord(entry);
    if (!item) {
      discarded += 1;
      reasons.push('A finding was not an object.');
      continue;
    }
    for (const key of Object.keys(item)) {
      if (!['subject', 'statement', 'rationale', 'references'].includes(key)) {
        return { ok: false, reason: `A finding carried an unknown field "${key}".` };
      }
    }
    const subject = text(item['subject'], INQUIRY_LIMITS.subject);
    const statement = text(item['statement'], INQUIRY_LIMITS.statement);
    const rationale = text(item['rationale'], INQUIRY_LIMITS.rationale);
    if (!subject || !statement || !rationale) {
      discarded += 1;
      reasons.push('A finding was missing a subject, a statement or a rationale.');
      continue;
    }

    const rawRefs = item['references'];
    if (!Array.isArray(rawRefs) || rawRefs.length === 0) {
      discarded += 1;
      reasons.push(`"${subject}" cited nothing, so it is a claim about the world rather than about this project.`);
      continue;
    }
    if (rawRefs.length > INQUIRY_LIMITS.maxReferences) {
      discarded += 1;
      reasons.push(`"${subject}" cited more rows than a single finding may.`);
      continue;
    }

    /*
     * Every citation must resolve, in scope.
     *
     * This is the whole anti-manufacture control. A model that invented a
     * subject has nothing to point at, and a model that pointed at a real row
     * has said something a person can check in one click. An id that does not
     * resolve discards the finding rather than being dropped from it — keeping
     * the finding minus its evidence would leave a sentence with nothing under
     * it, which is the thing being prevented.
     */
    const references: LensFinding['references'] = [];
    let bad: string | null = null;
    for (const ref of rawRefs) {
      const refRecord = asRecord(ref);
      const kind = refRecord ? refRecord['kind'] : null;
      const id = refRecord ? refRecord['id'] : null;
      if (typeof kind !== 'string' || typeof id !== 'string') {
        bad = 'a citation was not {kind, id}';
        break;
      }
      const resolves =
        (kind === 'KNOWLEDGE' && context.knowledgeIds.has(id)) ||
        (kind === 'LAYER' && context.layerIds.has(id)) ||
        (kind === 'FRONTIER' && context.frontierIds.has(id));
      if (!resolves) {
        bad = `${kind} ${id} is not a row this project holds`;
        break;
      }
      references.push({ kind: kind as LensFinding['references'][number]['kind'], id });
    }
    if (bad !== null) {
      discarded += 1;
      reasons.push(`"${subject}" was discarded because ${bad}.`);
      continue;
    }

    /*
     * Novelty, checked rather than assumed.
     *
     * §29 requires that restated existing items do not count as discoveries.
     * The floor only ever *refuses*: it cannot turn a weak finding into a
     * strong one, and a rewording of something the project already says is
     * named as such rather than silently dropped.
     */
    const restates = context.held.find(
      (existing) => overlap(existing, statement).score >= NOVELTY_FLOOR,
    );
    if (restates) {
      discarded += 1;
      reasons.push(`"${subject}" restates something the project already holds: "${restates}".`);
      continue;
    }

    // And against the other findings in this same reply, so one lens cannot
    // pad its own answer with six wordings of one idea.
    const duplicate = findings.find(
      (already) => overlap(already.statement, statement).score >= NOVELTY_FLOOR,
    );
    if (duplicate) {
      discarded += 1;
      reasons.push(`"${subject}" repeats "${duplicate.subject}" from the same reply.`);
      continue;
    }

    findings.push({ subject, statement, rationale, references });
  }

  return { ok: true, result: { findings, discarded, reasons } };
}

/* ==========================================================================
 * Settling one
 * ========================================================================== */

/** Bin states that mean nothing is ever coming back. */
const ABANDONED: BinState[] = ['FAILED', 'CANCELLED'];

/**
 * Read an inquiry's bin and settle it, exactly once.
 *
 * Every escalation has an answering transition, including this one: a bin that
 * died takes the inquiry to `FAILED` with the bin's own state in the reason,
 * rather than leaving a question that reads as still being worked on.
 */
export async function settleInquiry(
  inquiry: LensInquiry,
): Promise<LensInquiry> {
  if (inquiry.state !== 'RUNNING' || !inquiry.binId) return inquiry;
  const bin = await getBin(inquiry.binId);
  if (!bin) {
    await finish(inquiry.id, { state: 'FAILED', refusalReason: 'The bin carrying this question no longer exists.' });
    return (await getInquiry(inquiry.id))!;
  }

  const results = await listBinUnitResults(bin.id);
  const submitted = results.find((row) => row.unitKey === INQUIRY_UNIT_KEY);
  if (!submitted) {
    if (ABANDONED.includes(bin.state)) {
      await finish(inquiry.id, {
        state: 'FAILED',
        refusalReason: `The worker never answered: the bin ended ${bin.state}.`,
      });
      return (await getInquiry(inquiry.id))!;
    }
    return inquiry;
  }

  const context = await inquiryContext(inquiry.projectId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(submitted.value);
  } catch {
    await finish(inquiry.id, {
      state: 'REFUSED',
      refusalReason: 'The reply was not valid JSON. Nothing was stored.',
    });
    return (await getInquiry(inquiry.id))!;
  }

  const checked = validateLensReply(parsed, context);
  if (!checked.ok) {
    await finish(inquiry.id, { state: 'REFUSED', refusalReason: checked.reason });
    return (await getInquiry(inquiry.id))!;
  }

  const now = nowIso();
  await getDb().run(
    `UPDATE russell_lens_inquiries
        SET state = 'ANSWERED', findings = ?, discarded = ?, discard_reasons = ?,
            answered_at = ?, updated_at = ?
      WHERE id = ? AND state = 'RUNNING'`,
    [
      toJson(checked.result.findings),
      checked.result.discarded,
      toJson(checked.result.reasons),
      now,
      now,
      inquiry.id,
    ],
  );
  return (await getInquiry(inquiry.id))!;
}

async function finish(
  id: string,
  input: { state: InquiryState; refusalReason?: string },
): Promise<void> {
  const now = nowIso();
  await getDb().run(
    `UPDATE russell_lens_inquiries
        SET state = ?, refusal_reason = ?, answered_at = ?, updated_at = ?
      WHERE id = ? AND state IN ('REQUESTED','RUNNING')`,
    [input.state, input.refusalReason ?? null, now, now, id],
  );
}

/* ==========================================================================
 * What a person does with it
 * ========================================================================== */

/**
 * Accept one finding, which is the only way it becomes anything.
 *
 * A `NEW_PATH` frontier item — the region §11 reserves for "something Russell
 * found rather than something anybody asked for" — carrying the lens it came
 * from, so its provenance is visible in the row rather than implied.
 *
 * Guarded by the unique index on (inquiry, finding): deciding twice is an
 * ordinary outcome and the second one changes nothing.
 */
export async function decideFinding(input: {
  inquiryId: string;
  findingIndex: number;
  decision: 'ACCEPTED' | 'DISMISSED';
  reason?: string | null;
  decidedBy: string;
}): Promise<{ ok: true; frontierItemId: string | null } | { ok: false; reason: string }> {
  const inquiry = await getInquiry(input.inquiryId);
  if (!inquiry) return { ok: false, reason: 'No inquiry with that id.' };
  if (inquiry.state !== 'ANSWERED') {
    return { ok: false, reason: 'That inquiry has no findings to decide about.' };
  }
  const finding = inquiry.findings[input.findingIndex];
  if (!finding) return { ok: false, reason: 'No finding at that index.' };

  let frontierItemId: string | null = null;
  if (input.decision === 'ACCEPTED') {
    await observeFrontierItem({
      projectId: inquiry.projectId,
      region: 'NEW_PATH',
      subject: finding.subject,
      detail: finding.statement,
      sourceKind: 'ABSENCE',
      sourceId: inquiry.id,
      lens: inquiry.lens,
      visibility: inquiry.visibility,
    });
    const created = await getDb().get<{ id: string }>(
      `SELECT id FROM russell_frontier
        WHERE project_id = ? AND source_id = ? AND subject = ?
        ORDER BY first_seen_at DESC LIMIT 1`,
      [inquiry.projectId, inquiry.id, finding.subject],
    );
    frontierItemId = created?.id ?? null;
  }

  const inserted = await getDb().run(
    `INSERT INTO russell_lens_decisions
       (id, inquiry_id, finding_index, decision, reason, frontier_item_id, decided_by, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (inquiry_id, finding_index) DO NOTHING`,
    [
      newId('rld'),
      input.inquiryId,
      input.findingIndex,
      input.decision,
      input.reason?.trim() || null,
      frontierItemId,
      input.decidedBy,
      nowIso(),
    ],
  );
  if (inserted.changes !== 1) {
    return { ok: false, reason: 'That finding has already been decided.' };
  }
  return { ok: true, frontierItemId };
}

/** Inquiries waiting for a bin, across every project the tick covers. */
export async function pendingInquiries(limit = 5): Promise<LensInquiry[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM russell_lens_inquiries WHERE state = 'REQUESTED'
      ORDER BY created_at LIMIT ${Math.max(1, Math.min(20, limit))}`,
  );
  return rows.map(map);
}

/** Inquiries with a bin that may have finished. */
export async function runningInquiries(limit = 10): Promise<LensInquiry[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM russell_lens_inquiries WHERE state = 'RUNNING' AND bin_id IS NOT NULL
      ORDER BY updated_at LIMIT ${Math.max(1, Math.min(50, limit))}`,
  );
  return rows.map(map);
}

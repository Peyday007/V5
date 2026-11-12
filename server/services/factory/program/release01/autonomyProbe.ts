/**
 * Production probes for AUTO-20-1, AUTO-20-2 and AUTO-20-4: Brain originating
 * work from its own observations (method inadequacy included), working each
 * capability gap through a recorded loop that checks reuse first and resumes
 * from its rows, and measuring the gaps it identified and closed by itself.
 *
 * They read rows only — `improvement_candidates` and the append-only
 * `improvement_events` the improvement loop writes, the `bin_events` rows of
 * kind `CAPABILITY_GAP_STEP` the gap loop appends (`workload_class` = the gap's
 * weakness key, `provider` = the step, `measures.detail` = what the step
 * recorded), and the Factory release rows a delivery left. Nothing here imports
 * the code under test: a probe that called the loop would be the loop marking
 * its own work.
 *
 * Three answers, each meaning one thing:
 *  - UNKNOWN (`ok: null`): the rows do not yet show the behaviour — nothing has
 *    been originated, no gap step is recorded, nothing has closed. Absence is not
 *    a demonstration (§39), and it is not a defect either.
 *  - FAIL: a row contradicts the requirement — a step recorded without what the
 *    step must carry, acquisition before reuse was searched, an origination with
 *    no judgment, a method called inadequate with no failed attempt behind it, a
 *    gap closed into a second owner.
 *  - PASS: the rows demonstrate it, and none contradicts it.
 */
import { getDb } from '../../../../db/database.ts';
import type { ProbeResult } from '../probes.ts';

const HOUR = 3_600_000;
/** The improvement tick's period. Steps more than one period apart were written by different passes. */
const TICK_MS = 10 * 60_000;

function parse(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const filled = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;
/** The weakness family a candidate key belongs to: `KEY`, `KEY#2`, … all share `KEY`. */
const familyOf = (key: string): string => key.split('#')[0]!;

/* ------------------------------------------------------------------------- */
/* AUTO-20-1: origination                                                     */
/* ------------------------------------------------------------------------- */

/** The observation families the improvement loop originates work from (`ORIGINATED_<FAMILY>` candidates). */
const ORIGIN_FAMILIES = new Set(['GOAL_CONSTRAINT', 'FAILURE_PATTERN', 'IDLE_CAPACITY', 'MISSED_OPPORTUNITY', 'UNMET_NEED']);
const FAILED_METHOD = new Set(['KEPT_NO_EFFECT', 'REVERTED']);

interface CandidateRow {
  id: string;
  weakness_key: string;
  kind: string;
  owner_component: string;
  evidence: string;
  decision: string | null;
  attempt: number | string;
  campaign_id: string | null;
  delivered_ref: string | null;
  created_at: string;
}

async function candidates(where = '', params: string[] = []): Promise<CandidateRow[]> {
  return getDb().all<CandidateRow>(
    `SELECT id, weakness_key, kind, owner_component, evidence, decision, attempt, campaign_id, delivered_ref, created_at
       FROM improvement_candidates ${where} ORDER BY created_at, id`,
    params,
  );
}

/** AUTO-20-1: work originated from goal constraints, failure patterns, idle capacity, missed openings and unmet needs, each with its judgment, and a method judged inadequate from the record. */
export async function originationHoldsOnRows(): Promise<ProbeResult> {
  const all = await candidates();
  const originated = all.filter((c) => c.kind.startsWith('ORIGINATED_'));
  const inadequate = all.filter((c) => parse(c.evidence)['methodInadequacy'] !== undefined);
  if (originated.length === 0 && inadequate.length === 0) {
    return { ok: null, detail: 'no ORIGINATED_* improvement candidate and none judging a method inadequate: Brain has not yet originated work from its own observations on production' };
  }
  const families = new Map<string, number>();
  for (const c of originated) {
    const origination = parse(c.evidence)['origination'] as { family?: unknown; judgment?: unknown; observed?: unknown; methodInadequate?: unknown } | undefined;
    if (!origination || typeof origination !== 'object') return { ok: false, detail: `candidate ${c.weakness_key} is ${c.kind} but carries no origination: the judgment that made an observation into work is not on record` };
    const family = String(origination.family);
    if (!ORIGIN_FAMILIES.has(family)) return { ok: false, detail: `candidate ${c.weakness_key} names origin family ${family}, which no observation produces` };
    if (c.kind !== `ORIGINATED_${family}` || !familyOf(c.weakness_key).startsWith(`ORIGINATED:${family}:`)) {
      return { ok: false, detail: `candidate ${c.weakness_key} (${c.kind}) does not match its own origin family ${family}` };
    }
    if (!filled(origination.judgment)) return { ok: false, detail: `candidate ${c.weakness_key} was originated with no recorded judgment` };
    if (!Array.isArray(origination.observed) || origination.observed.length === 0 || !origination.observed.every(filled)) {
      return { ok: false, detail: `candidate ${c.weakness_key} names no row it was originated from, so its observation cannot be re-read` };
    }
    if (filled(origination.methodInadequate) && parse(c.evidence)['methodInadequacy'] === undefined) {
      return { ok: false, detail: `candidate ${c.weakness_key} observed an inadequate method but its record does not carry the judgment forward` };
    }
    families.set(family, (families.get(family) ?? 0) + 1);
  }
  // A method is judged inadequate only on the record: failed attempts of the same weakness, or a decided repair of the gap that still blocks a goal.
  for (const c of inadequate) {
    const judged = parse(c.evidence)['methodInadequacy'] as { judgment?: unknown; failedAttempts?: unknown } | undefined;
    if (!judged || typeof judged !== 'object' || !filled(judged.judgment)) return { ok: false, detail: `candidate ${c.weakness_key} judges a method inadequate without saying why` };
    const failed = Array.isArray(judged.failedAttempts) ? judged.failedAttempts.map(Number) : [];
    if (failed.length > 0) {
      const base = familyOf(c.weakness_key);
      const members = all.filter((m) => familyOf(m.weakness_key) === base);
      for (const attempt of failed) {
        const member = members.find((m) => Number(m.attempt) === attempt);
        if (!member || !FAILED_METHOD.has(String(member.decision))) {
          return { ok: false, detail: `candidate ${c.weakness_key} names attempt ${attempt} as a failed method, but that attempt ${member ? `was decided ${String(member.decision)}` : 'is not on record'}` };
        }
      }
    } else if (familyOf(c.weakness_key).startsWith('ORIGINATED:GOAL_CONSTRAINT:')) {
      const gap = familyOf(c.weakness_key).slice('ORIGINATED:GOAL_CONSTRAINT:'.length);
      const repaired = all.some((m) => {
        const base = familyOf(m.weakness_key);
        return base.startsWith('CAPABILITY:') && base.endsWith(`.${gap}`) && m.decision !== null;
      });
      if (!repaired) return { ok: false, detail: `candidate ${c.weakness_key} judges an earlier repair of ${gap} inadequate, but no decided repair of it is on record` };
    } else {
      return { ok: false, detail: `candidate ${c.weakness_key} judges a method inadequate but names no failed attempt and no earlier repair` };
    }
  }
  const summary = [...families].map(([family, n]) => `${family} ${n}`).join(', ') || 'none';
  if (families.size < 2) {
    return { ok: null, detail: `originated work so far comes from ${families.size} observation family (${summary}); more than one source of observation is not yet demonstrated` };
  }
  if (inadequate.length === 0) {
    return { ok: null, detail: `${originated.length} originated candidate(s) across ${families.size} families (${summary}); no method has yet been judged inadequate on the record` };
  }
  return {
    ok: true,
    detail: `${originated.length} candidate(s) Brain originated from its own observations across ${families.size} families (${summary}), each with its judgment and the rows it read; ${inadequate.length} judging an earlier method inadequate, each backed by a failed attempt or decided repair on record`,
  };
}

/* ------------------------------------------------------------------------- */
/* AUTO-20-2: the capability-gap loop                                         */
/* ------------------------------------------------------------------------- */

const STEPS = ['NOTICE', 'HYPOTHESIS', 'SEARCH_EXISTING', 'VALUE', 'ACQUIRE', 'VERIFY', 'INTEGRATE', 'CONTINUE'] as const;
type Step = (typeof STEPS)[number];
const CAUSES = new Set(['MISSING_DATASET', 'REASONING_DEFECT', 'PERMISSION_GAP', 'UNAVAILABLE_PROVIDER', 'MARKET_LIMITATION', 'METHOD_INADEQUATE', 'OTHER']);

interface StepRow {
  gap: string;
  step: Step;
  at: string;
  detail: Record<string, unknown>;
}

async function gapSteps(): Promise<{ rows: StepRow[]; malformed: string | null }> {
  const raw = await getDb().all<{ workload_class: string | null; provider: string | null; at: string; measures: string | null }>(
    `SELECT workload_class, provider, at, measures FROM bin_events
      WHERE event_type = ? ORDER BY at, rowid`,
    ['CAPABILITY_GAP_STEP'],
  );
  const rows: StepRow[] = [];
  for (const r of raw) {
    if (!filled(r.workload_class)) return { rows, malformed: `a CAPABILITY_GAP_STEP row at ${r.at} names no gap` };
    const step = STEPS.find((s) => s === r.provider);
    if (!step) return { rows, malformed: `gap ${String(r.workload_class)} recorded ${String(r.provider)}, which is not a step of the loop` };
    const measures = parse(r.measures);
    if (measures['step'] !== step || measures['gap'] !== r.workload_class) {
      return { rows, malformed: `gap ${String(r.workload_class)}'s ${step} row at ${r.at} does not carry its own gap and step` };
    }
    const detail = measures['detail'];
    rows.push({ gap: r.workload_class!, step, at: r.at, detail: detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {} });
  }
  return { rows, malformed: null };
}

/** What each step must carry, as the gap loop refuses a step without it. Null when the row carries it. */
function missingContent(row: StepRow): string | null {
  const d = row.detail;
  switch (row.step) {
    case 'NOTICE':
      return filled(d['observation']) ? null : 'names no observation';
    case 'HYPOTHESIS':
      if (!filled(d['enables']) || !filled(d['measure']) || !filled(d['failureMode'])) return 'does not name what it enables, the measure and how it could fail';
      return CAUSES.has(String(d['cause'])) ? null : `names cause ${String(d['cause'])}`;
    case 'SEARCH_EXISTING':
      return Array.isArray(d['searched']) && d['searched'].length > 0 ? null : 'does not say where it looked';
    case 'VALUE':
      return filled(d['chosen']) && filled(d['alternatives']) ? null : 'does not name the option chosen and the alternatives';
    case 'ACQUIRE':
      return filled(d['owner']) ? null : 'names no existing execution owner';
    case 'VERIFY':
      return filled(d['baseline']) && filled(d['comparison']) ? null : 'records no baseline and real-world comparison';
    case 'INTEGRATE':
      return filled(d['capability']) && filled(d['provenance']) && filled(d['owner']) ? null : 'does not name the capability, its provenance and its owner';
    case 'CONTINUE':
      return filled(d['resumed']) ? null : 'does not say what resumed';
  }
}

/**
 * The loop in order on one gap's rows: notice, hypothesis, a search recorded as
 * preceding acquisition, a valuation that weighed alternatives, acquisition,
 * verification, integration (kept or retired) and continuation. Greedy over
 * the rows, so re-recorded steps and a loop sent back do not hide a pass. Pure.
 */
function completePass(rows: readonly StepRow[]): StepRow[] | null {
  const wanted: Array<(r: StepRow) => boolean> = [
    (r) => r.step === 'NOTICE',
    (r) => r.step === 'HYPOTHESIS',
    (r) => r.step === 'SEARCH_EXISTING' && r.detail['beforeAcquire'] === true,
    (r) => r.step === 'VALUE' && r.detail['evaluated'] === true,
    (r) => r.step === 'ACQUIRE',
    (r) => r.step === 'VERIFY',
    (r) => r.step === 'INTEGRATE',
    (r) => r.step === 'CONTINUE',
  ];
  const pass: StepRow[] = [];
  for (const row of rows) {
    const next = wanted[pass.length];
    if (next && next(row)) pass.push(row);
  }
  return pass.length === wanted.length ? pass : null;
}

/** AUTO-20-2: every gap step recorded with its content, reuse searched before anything is acquired, and a full loop that resumed across passes. */
export async function gapLoopHoldsOnRows(): Promise<ProbeResult> {
  const { rows, malformed } = await gapSteps();
  if (malformed) return { ok: false, detail: malformed };
  if (rows.length === 0) return { ok: null, detail: 'no CAPABILITY_GAP_STEP row: no capability gap has been worked through the loop on production' };
  const byGap = new Map<string, StepRow[]>();
  for (const row of rows) byGap.set(row.gap, [...(byGap.get(row.gap) ?? []), row]);
  for (const [gap, list] of byGap) {
    for (const row of list) {
      const missing = missingContent(row);
      if (missing) return { ok: false, detail: `gap ${gap}'s ${row.step} at ${row.at} ${missing}` };
    }
    const acquired = list.findIndex((r) => r.step === 'ACQUIRE');
    const searched = list.findIndex((r) => r.step === 'SEARCH_EXISTING');
    if (acquired >= 0 && (searched < 0 || searched > acquired)) {
      return { ok: false, detail: `gap ${gap} recorded ACQUIRE at ${list[acquired]!.at} before any SEARCH_EXISTING: it acquired before reuse was checked` };
    }
  }
  const complete: Array<{ gap: string; spanMs: number; passes: number }> = [];
  for (const [gap, list] of byGap) {
    const pass = completePass(list);
    if (!pass) continue;
    const times = pass.map((r) => Date.parse(r.at));
    let passes = 1;
    for (let i = 1; i < times.length; i += 1) if (times[i]! - times[i - 1]! >= TICK_MS) passes += 1;
    complete.push({ gap, spanMs: times[times.length - 1]! - times[0]!, passes });
  }
  const resumed = complete.filter((c) => c.passes >= 2);
  const covered = new Set(rows.map((r) => r.step));
  if (complete.length === 0) {
    return {
      ok: null,
      detail: `${byGap.size} gap(s), ${rows.length} step(s) (${STEPS.filter((s) => covered.has(s)).join(', ')}), every one well-formed and none acquired before searching; no gap has yet run notice → hypothesis → search-first → valued → acquire → verify → integrate → continue`,
    };
  }
  if (resumed.length === 0) {
    return { ok: null, detail: `${complete.length} gap(s) ran the full loop, each inside one pass; continuation across passes, read back from the rows, is not yet demonstrated` };
  }
  const best = resumed.sort((a, b) => b.passes - a.passes)[0]!;
  return {
    ok: true,
    detail:
      `${byGap.size} gap(s), ${rows.length} recorded step(s), all well-formed and none acquired before reuse was searched; ` +
      `${complete.length} ran the full loop in order, ${resumed.length} of them across passes (e.g. ${best.gap}: ${best.passes} passes over ${(best.spanMs / HOUR).toFixed(1)} h)`,
  };
}

/* ------------------------------------------------------------------------- */
/* AUTO-20-4: gaps identified and closed without owner input                  */
/* ------------------------------------------------------------------------- */

const MEASURED = new Set(['KEPT', 'KEPT_NO_EFFECT', 'REVERTED']);
/** The `executed_by_ref` the improvement loop writes on the release grant it gives under the standing order. */
const LOOP_GRANT_REF = 'improvement-loop';

type OwnerInput = 'NONE' | 'OWNER_INPUT' | 'UNMEASURED';

/** Whether a person had to act for a kept gap to reach production, from the rows that would show it. */
async function ownerInputOf(gap: CandidateRow): Promise<{ finding: OwnerInput; reason: string }> {
  const db = getDb();
  const events = await db.all<{ kind: string; detail: string }>(
    `SELECT kind, detail FROM improvement_events WHERE candidate_id = ? AND (kind LIKE 'OWNER_%' OR kind = 'FACTORY_BLOCKED')`,
    [gap.id],
  );
  const owner: string[] = [];
  const unknown: string[] = [];
  for (const event of events) {
    if (event.kind !== 'FACTORY_BLOCKED') {
      owner.push(`recorded ${event.kind}`);
      continue;
    }
    const detail = parse(event.detail);
    if (detail['needsPerson'] === true) owner.push('Factory stopped for a person');
    else if (typeof detail['needsPerson'] !== 'boolean') unknown.push('a Factory stop that does not say whether it waited on a person');
  }
  if (!gap.campaign_id) {
    unknown.push('no Factory campaign links the delivery');
  } else {
    const runs = await db.all<{ merge_sha: string | null; executed_by_ref: string | null }>(
      `SELECT r.merge_sha, g.executed_by_ref FROM factory_release_runs r
         JOIN factory_release_grants g ON g.id = r.grant_id
        WHERE r.state = 'LIVE' AND r.campaign_id = ?`,
      [gap.campaign_id],
    );
    const atMerge = gap.delivered_ref !== null && /^[0-9a-f]{7,40}$/i.test(gap.delivered_ref);
    const live = runs.filter((r) => !atMerge || r.merge_sha === gap.delivered_ref);
    if (live.length === 0) owner.push("merged outside Brain's automatic release");
    else if (!live.some((r) => r.executed_by_ref === LOOP_GRANT_REF)) owner.push('released under a grant a person gave');
  }
  if (owner.length) return { finding: 'OWNER_INPUT', reason: owner.join('; ') };
  if (unknown.length) return { finding: 'UNMEASURED', reason: unknown.join('; ') };
  return { finding: 'NONE', reason: "released by Brain's own release under the standing improvement grant" };
}

/** AUTO-20-4: gaps identified and closed are measurable from rows, at least one closed by Brain alone into the owner it extended. */
export async function gapMeasuresHoldOnRows(): Promise<ProbeResult> {
  const all = await candidates();
  if (all.length === 0) return { ok: null, detail: 'no improvement candidate: Brain has identified no gap on production' };
  const db = getDb();
  const decidedEvents = await db.all<{ candidate_id: string; detail: string; at: string }>(
    `SELECT candidate_id, detail, at FROM improvement_events WHERE kind = 'DECIDED' AND candidate_id IS NOT NULL ORDER BY at, id`,
    [],
  );
  const decidedAt = new Map<string, string>();
  for (const event of decidedEvents) {
    const decision = parse(event.detail)['decision'];
    const candidate = all.find((c) => c.id === event.candidate_id);
    if (!candidate || typeof decision !== 'string' || decision !== candidate.decision || decidedAt.has(candidate.id)) continue;
    decidedAt.set(candidate.id, event.at);
  }
  const measured = all.filter((c) => MEASURED.has(String(c.decision)) && decidedAt.has(c.id));
  for (const c of measured) {
    if (decidedAt.get(c.id)! < c.created_at) return { ok: false, detail: `gap ${c.weakness_key} is recorded decided ${c.decision} at ${decidedAt.get(c.id)}, before it was identified at ${c.created_at}` };
  }
  const kept = measured.filter((c) => c.decision === 'KEPT');
  const untimed = all.filter((c) => MEASURED.has(String(c.decision)) && !decidedAt.has(c.id)).length;

  // Extending the existing owner: a closed gap is integrated into the component that owned the weakness, never a second one.
  const integrations = await db.all<{ workload_class: string; measures: string | null }>(
    `SELECT workload_class, measures FROM bin_events WHERE event_type = 'CAPABILITY_GAP_STEP' AND provider = 'INTEGRATE' AND workload_class IS NOT NULL`,
    [],
  );
  const integratedInto = new Map<string, string[]>();
  for (const row of integrations) {
    const detail = parse(row.measures)['detail'] as Record<string, unknown> | undefined;
    integratedInto.set(row.workload_class, [...(integratedInto.get(row.workload_class) ?? []), String(detail?.['owner'] ?? '')]);
  }
  for (const c of kept) {
    const owners = integratedInto.get(c.weakness_key) ?? [];
    const other = owners.find((o) => o !== c.owner_component);
    if (other !== undefined) return { ok: false, detail: `gap ${c.weakness_key} is owned by ${c.owner_component} but was integrated into ${other || 'no owner'}: it did not extend the existing owner` };
  }

  const findings = new Map<string, { finding: OwnerInput; reason: string }>();
  for (const c of kept) findings.set(c.id, await ownerInputOf(c));
  const alone = kept.filter((c) => findings.get(c.id)!.finding === 'NONE');
  const aloneExtended = alone.filter((c) => (integratedInto.get(c.weakness_key) ?? []).includes(c.owner_component));
  const hours = kept.map((c) => (Date.parse(decidedAt.get(c.id)!) - Date.parse(c.created_at)) / HOUR).sort((a, b) => a - b);
  const median = hours.length === 0 ? null : hours.length % 2 ? hours[(hours.length - 1) / 2]! : (hours[hours.length / 2 - 1]! + hours[hours.length / 2]!) / 2;
  const reverted = measured.filter((c) => c.decision === 'REVERTED').length;
  const noEffect = measured.filter((c) => c.decision === 'KEPT_NO_EFFECT').length;
  const campaigns = [...new Set(measured.map((c) => c.campaign_id).filter((id): id is string => Boolean(id)))];
  const bins = campaigns.length
    ? Number((await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM bins WHERE factory_campaign_id IN (${campaigns.map(() => '?').join(', ')})`, campaigns))?.n ?? 0)
    : 0;
  const ownerCount = (f: OwnerInput) => kept.filter((c) => findings.get(c.id)!.finding === f).length;
  const figures =
    `${all.length} gap(s) identified; ${kept.length} closed (KEPT, timed by its DECIDED event)` +
    (untimed ? `, ${untimed} measured decision(s) with no DECIDED event left untimed` : '') +
    `; owner input: ${alone.length} none, ${ownerCount('OWNER_INPUT')} with, ${ownerCount('UNMEASURED')} unmeasured; ` +
    `median ${median === null ? 'unmeasured' : `${median.toFixed(1)} h`} to use; regressions ${reverted} reverted, ${noEffect} kept without effect; ` +
    `cost: ${bins} Factory bin(s) across ${campaigns.length} campaign(s) of measured attempts`;
  if (kept.length === 0) return { ok: null, detail: `${figures}. No gap has closed yet, so closing without owner input is not demonstrated` };
  if (alone.length === 0) return { ok: null, detail: `${figures}. No closed gap is yet shown on the rows to have reached production without a person` };
  if (aloneExtended.length === 0) return { ok: null, detail: `${figures}. No gap closed without a person has yet recorded its integration into the owner it extended` };
  return { ok: true, detail: `${figures}; ${aloneExtended.length} closed by Brain alone and integrated into the existing owner (e.g. ${aloneExtended[0]!.weakness_key} → ${aloneExtended[0]!.owner_component})` };
}

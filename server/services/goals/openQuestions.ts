/**
 * The owner-decisions and open-questions register of the architecture program
 * (GOV-11, source items S-0097 and S-0098), checked rather than trusted.
 *
 * `docs/programs/brain-architecture/OPEN-QUESTIONS-REGISTER.md` sits beside the
 * program's verbatim source. It promises four things, and this module is the
 * reader that holds it to them:
 *
 *  - every entry's clause is the owner's wording, copied verbatim from the
 *    program source as production stores it (whitespace aside: the source is
 *    extracted from a PDF, so line breaks are not wording);
 *  - every clause the source lists is retained — a later release may append an
 *    entry, never remove one;
 *  - an `OPEN` question carries no default and no decision: its answer cell is
 *    exactly "none recorded" (§7.39 — an unanswered fact is never a favourable
 *    assumption);
 *  - an `ANSWERED` question is a re-map, not a rewrite: its question text is
 *    unchanged, its answer cell points at what carries the answer, and the
 *    owner's wording is appended under the question's id.
 *
 * The source side is read from production rows (the program filed under
 * `brain-architecture`, its source and every appended release); the register
 * side is read from the revision production runs, because the image does not
 * carry `docs/`. No new store, status set or authority path: the program owns
 * its source (§96/§97) and the register owns nothing but its own rows.
 */
import type { SourceItem } from '../../domain/factoryProgram.ts';

export const REGISTER_PATH = 'docs/programs/brain-architecture/OPEN-QUESTIONS-REGISTER.md';

/** The lead-ins of the two source items the register mirrors, as the source words them. */
export const DECISIONS_LEAD = 'Decisions established by the owner';
export const QUESTIONS_LEAD = 'To define as the user continues';

/**
 * The line by which the register says how many of the program's appended releases
 * it has been re-mapped against. A release appended after that number leaves the
 * register behind, and the check fails until somebody re-maps it and moves the
 * number — so "re-map it when the owner answers" is a refusal, not a reminder.
 */
export const RELEASES_MARKER = 'Appended releases mapped:';

/** The number the register's marker line states, or null when it states none. Pure. */
export function releasesMapped(markdown: string): number | null {
  for (const line of markdown.split('\n')) {
    const text = line.replace(/[*_`]/g, '').trim();
    if (!text.startsWith(RELEASES_MARKER)) continue;
    const match = /^\s*(\d+)\b/.exec(text.slice(RELEASES_MARKER.length));
    return match ? Number(match[1]) : null;
  }
  return null;
}

/** An appended release of the program, as the register is compared with it. */
export interface RegisterRelease {
  number: number;
  title: string;
}

/** What an OPEN question's answer cell says. Anything else is a default somebody slipped in. */
export const NO_ANSWER = 'none recorded';

export type RegisterTable = 'DECISIONS' | 'QUESTIONS';

export interface RegisterRow {
  table: RegisterTable;
  id: string;
  status: string;
  clause: string;
  answer: string | null;
}

export interface RegisterCheck {
  ok: boolean;
  errors: string[];
  decisions: number;
  open: number;
  answered: number;
}

/** Whitespace is layout, not wording. Nothing else is normalised. */
export function normaliseClause(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Every table row of the register, with the table it sits in. Pure. */
export function parseRegister(markdown: string): RegisterRow[] {
  const rows: RegisterRow[] = [];
  for (const line of markdown.split('\n')) {
    const cells = line.trim();
    if (!cells.startsWith('|') || !cells.endsWith('|')) continue;
    const parts = cells.slice(1, -1).split('|').map((cell) => cell.trim());
    const id = parts[0] ?? '';
    const match = /^GOV-11-([DQ])\d+$/.exec(id);
    if (!match) continue;
    rows.push({
      table: match[1] === 'D' ? 'DECISIONS' : 'QUESTIONS',
      id,
      status: parts[1] ?? '',
      clause: parts[2] ?? '',
      answer: match[1] === 'Q' ? (parts[3] ?? '') : null,
    });
  }
  return rows;
}

/**
 * The clauses a source item enumerates after its lead-in: "Lead - one. - two."
 * splits into ["one.", "two."]. A hyphen inside a word ("near-term") is not a
 * separator; only a dash standing between spaces is. Pure.
 */
export function clausesOf(itemText: string, lead: string): string[] {
  const text = normaliseClause(itemText);
  if (!text.startsWith(lead)) return [];
  return text
    .slice(lead.length)
    .split(/(?:^|\s)-\s/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/** The source item that opens with a lead-in, or null. */
export function itemLedBy(items: readonly Pick<SourceItem, 'id' | 'text'>[], lead: string): Pick<SourceItem, 'id' | 'text'> | null {
  return items.find((item) => normaliseClause(item.text).startsWith(lead)) ?? null;
}

/**
 * Every clause the program lists under a lead-in, in source order, across every
 * item that opens with it — the base source's and each appended release's. A
 * release that lists further decisions or questions under the same lead-in
 * extends the numbering; it never renumbers an earlier entry. Pure.
 */
export function listedClauses(items: readonly Pick<SourceItem, 'id' | 'text'>[], lead: string): Array<{ itemId: string; clause: string }> {
  return items
    .filter((item) => normaliseClause(item.text).startsWith(lead))
    .flatMap((item) => clausesOf(item.text, lead).map((clause) => ({ itemId: item.id, clause })));
}

/** The owner's wording appended beneath the tables under a question's id, or null when there is none. */
function appendedAnswer(markdown: string, id: string): string | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^#{2,6}\\s+${id}\\b`).test(line.trim()));
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    body.push(line);
  }
  const text = body.join('\n').trim();
  return text.length > 0 ? text : null;
}

/**
 * Hold the register to its promises against the program's source items. Pure:
 * the caller supplies both sides, so the same check runs on production rows and
 * in a test.
 */
export function checkRegister(
  markdown: string,
  items: readonly Pick<SourceItem, 'id' | 'text'>[],
  options: { releases?: readonly RegisterRelease[] } = {},
): RegisterCheck {
  const errors: string[] = [];
  if (options.releases) {
    const mapped = releasesMapped(markdown);
    const appended = options.releases.length;
    if (mapped === null) {
      errors.push(`the register states no "${RELEASES_MARKER} N" line, so nothing says which releases it was re-mapped against`);
    } else if (mapped < appended) {
      const behind = options.releases.slice(mapped).map((r) => `release ${r.number} "${r.title}"`);
      errors.push(`the register is behind the program: ${behind.join(', ')} appended since it was last re-mapped (${mapped} of ${appended})`);
    } else if (mapped > appended) {
      errors.push(`the register claims ${mapped} appended release(s) mapped but the program has ${appended}`);
    }
  }
  const rows = parseRegister(markdown);
  const seen = new Map<string, number>();
  for (const row of rows) seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
  for (const [id, count] of seen) if (count > 1) errors.push(`${id} appears ${count} times`);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const wholeSource = normaliseClause(items.map((item) => item.text).join(' '));

  const sides: Array<{ table: RegisterTable; lead: string; prefix: string }> = [
    { table: 'DECISIONS', lead: DECISIONS_LEAD, prefix: 'GOV-11-D' },
    { table: 'QUESTIONS', lead: QUESTIONS_LEAD, prefix: 'GOV-11-Q' },
  ];
  for (const side of sides) {
    const item = itemLedBy(items, side.lead);
    if (!item) {
      errors.push(`the program source has no item opening "${side.lead}"`);
      continue;
    }
    const expected = listedClauses(items, side.lead);
    if (expected.length === 0) errors.push(`${item.id} enumerates no clause after "${side.lead}"`);
    for (const [index, { itemId, clause }] of expected.entries()) {
      const id = `${side.prefix}${index + 1}`;
      const row = byId.get(id);
      if (!row) {
        errors.push(`${id} (${itemId}) is missing: every listed clause has an entry, and an entry is retained, never removed`);
        continue;
      }
      if (row.table !== side.table) errors.push(`${id} sits in the wrong table`);
      if (normaliseClause(row.clause) !== clause) errors.push(`${id} is not verbatim: "${row.clause}" ≠ "${clause}"`);
    }
  }

  // Entries a later release appended: allowed, but still verbatim from the source.
  for (const row of rows) {
    const index = Number(row.id.replace(/^GOV-11-[DQ]/, '')) - 1;
    const lead = row.table === 'DECISIONS' ? DECISIONS_LEAD : QUESTIONS_LEAD;
    const listed = listedClauses(items, lead).length;
    if (index >= listed && !wholeSource.includes(normaliseClause(row.clause))) {
      errors.push(`${row.id} is not wording the program source contains`);
    }
  }

  let decisions = 0;
  let open = 0;
  let answered = 0;
  for (const row of rows) {
    if (row.table === 'DECISIONS') {
      if (row.status !== 'DECIDED') errors.push(`${row.id} is a decision the owner established; its status is DECIDED, not "${row.status}"`);
      else decisions += 1;
      continue;
    }
    const answer = (row.answer ?? '').trim();
    if (row.status === 'OPEN') {
      open += 1;
      if (answer !== NO_ANSWER) errors.push(`${row.id} is OPEN but carries "${answer}": an open question carries no default and no decision`);
    } else if (row.status === 'ANSWERED') {
      answered += 1;
      if (answer.length === 0 || answer === NO_ANSWER) errors.push(`${row.id} is ANSWERED but names no release or requirement carrying the answer`);
      if (!appendedAnswer(markdown, row.id)) errors.push(`${row.id} is ANSWERED but the owner's wording is not appended under "### ${row.id}"`);
    } else {
      errors.push(`${row.id} has status "${row.status}": a question is OPEN or ANSWERED`);
    }
  }
  return { ok: errors.length === 0, errors, decisions, open, answered };
}

export interface RegisterSources {
  /** The register's text at the revision production runs, or null when it is not there. */
  readRegister: () => Promise<{ text: string | null; where: string }>;
  /**
   * The program's source items and its appended releases, from production rows,
   * or null when no program is filed. `releases` absent means the caller does not
   * know them, and the register's release marker is not compared.
   */
  loadItems: () => Promise<{ programId?: string; items: SourceItem[]; releases?: RegisterRelease[]; where: string } | null>;
}

/** The register at the revision production runs, read through the forge. */
async function registerAtRevision(): Promise<{ text: string | null; where: string }> {
  const { BRAIN_REVISION } = await import('../../env.ts');
  const { parseRemote, readFile } = await import('../factory/forge.ts');
  if (!BRAIN_REVISION) return { text: null, where: 'this process carries no BRAIN_REVISION' };
  const repository = parseRemote('https://github.com/Peyday007/V5');
  if (!repository) return { text: null, where: 'the repository is not one the forge can read' };
  const reply = await readFile(repository, REGISTER_PATH, BRAIN_REVISION);
  return { text: reply.ok ? reply.body : null, where: `${REGISTER_PATH}@${BRAIN_REVISION.slice(0, 12)}` };
}

/** The architecture program's source items, from production rows. */
async function architectureItems(): Promise<{ programId: string; items: SourceItem[]; releases: RegisterRelease[]; where: string } | null> {
  const { getDb } = await import('../../db/database.ts');
  const { getProgram } = await import('../../repos/factoryProgram.ts');
  const { extractSourceItems, programSource } = await import('../factory/program/spec.ts');
  const { ARCHITECTURE_PROGRAM_KEY } = await import('../factory/program/probes.ts');
  const row = await getDb().get<{ id: string }>(
    `SELECT id FROM factory_programs WHERE submission_key = ? ORDER BY created_at LIMIT 1`,
    [ARCHITECTURE_PROGRAM_KEY],
  );
  const program = row ? await getProgram(row.id) : null;
  if (!program) return null;
  return {
    programId: program.id,
    items: extractSourceItems(programSource(program)),
    releases: program.amendments.map((a) => ({ number: a.number, title: a.title })),
    where: `program ${program.id} (${program.amendments.length} release(s))`,
  };
}

/**
 * The register, checked against production: the program's stored source and
 * the register at the running revision. A side that cannot be read is a
 * failure that says which side, never a pass.
 */
export async function checkRegisterOnProduction(
  sources: Partial<RegisterSources> = {},
): Promise<{ ok: boolean; detail: string; check: RegisterCheck | null; programId: string | null; releases: number | null; registerAt: string | null }> {
  const loadItems = sources.loadItems ?? architectureItems;
  const readRegister = sources.readRegister ?? registerAtRevision;
  const program = await loadItems();
  if (!program) return { ok: false, detail: 'no architecture program is filed on production', check: null, programId: null, releases: null, registerAt: null };
  const ids = { programId: program.programId ?? null, releases: program.releases ? program.releases.length : null };
  const register = await readRegister();
  if (register.text === null) return { ok: false, detail: `the register is not readable: ${register.where}`, check: null, ...ids, registerAt: register.where };
  const check = checkRegister(register.text, program.items, program.releases ? { releases: program.releases } : {});
  if (!check.ok) {
    return { ok: false, detail: `${register.where} against ${program.where}: ${check.errors[0]}${check.errors.length > 1 ? ` (+${check.errors.length - 1} more)` : ''}`, check, ...ids, registerAt: register.where };
  }
  return {
    ok: true,
    detail: `${register.where} against ${program.where}: ${check.decisions} decisions verbatim, ${check.open} open question(s) without a default, ${check.answered} answered and re-mapped`,
    check,
    ...ids,
    registerAt: register.where,
  };
}

/**
 * The register kept current on the running Brain, not only in a unit test.
 *
 * From the goals tick, the production check runs against the program's stored
 * source and appended releases and the register at the running revision. The
 * outcome is recorded as a factory event whenever it changes — a release
 * appended through the §97 amendment path, a new revision of the register, or a
 * different first failure — so a register that fell behind a release is flagged
 * on the first pass after the release lands, and the re-map that answers it is
 * recorded when it reaches production. An unchanged outcome records nothing.
 */
export const REGISTER_EVENT_KINDS = {
  current: 'PROGRAM_REGISTER_CURRENT',
  behind: 'PROGRAM_REGISTER_BEHIND',
} as const;

export interface RegisterEvent {
  kind: string;
  detail: Record<string, unknown>;
}

export interface RegisterPassPorts {
  check: () => ReturnType<typeof checkRegisterOnProduction>;
  /** The newest register event, or null when none is recorded. */
  latest: () => Promise<RegisterEvent | null>;
  record: (kind: string, detail: Record<string, unknown>) => Promise<void>;
}

export interface RegisterPassReport {
  ok: boolean;
  recorded: string | null;
  detail: string;
}

/** What makes two outcomes the same outcome: nothing a clock or a retry changes. */
export function registerFingerprint(outcome: { ok: boolean; programId: string | null; releases: number | null; registerAt: string | null; detail: string; check: RegisterCheck | null }): string {
  const first = outcome.ok ? '' : (outcome.check?.errors[0] ?? outcome.detail);
  return [outcome.ok ? 'CURRENT' : 'BEHIND', outcome.programId ?? '-', outcome.releases ?? '-', outcome.registerAt ?? '-', first].join('|');
}

/** One pass: check, and record the outcome when it differs from the last one recorded. */
export async function reconcileRegister(ports: RegisterPassPorts): Promise<RegisterPassReport> {
  const outcome = await ports.check();
  const fingerprint = registerFingerprint(outcome);
  const last = await ports.latest();
  if (last && last.detail.fingerprint === fingerprint) return { ok: outcome.ok, recorded: null, detail: outcome.detail };
  const kind = outcome.ok ? REGISTER_EVENT_KINDS.current : REGISTER_EVENT_KINDS.behind;
  await ports.record(kind, {
    fingerprint,
    programId: outcome.programId,
    appendedReleases: outcome.releases,
    register: outcome.registerAt,
    detail: outcome.detail,
    errors: outcome.check?.errors.slice(0, 20) ?? [],
    decisions: outcome.check?.decisions ?? null,
    open: outcome.check?.open ?? null,
    answered: outcome.check?.answered ?? null,
  });
  return { ok: outcome.ok, recorded: kind, detail: outcome.detail };
}

/** The ports production runs on, imported lazily so the goals tick does not load the factory at module load. */
export async function productionRegisterPorts(): Promise<RegisterPassPorts> {
  const { listFactoryEvents, recordFactoryEvent } = await import('../../repos/factoryFleet.ts');
  return {
    check: () => checkRegisterOnProduction(),
    async latest() {
      // `listFactoryEvents` answers oldest first: the newest outcome is the last row, not the first.
      const newest = (await listFactoryEvents(null, { kinds: [REGISTER_EVENT_KINDS.current, REGISTER_EVENT_KINDS.behind], limit: 5000 })).at(-1);
      return newest ? { kind: newest.kind, detail: newest.detail } : null;
    },
    async record(kind, detail) {
      await recordFactoryEvent({ kind, evidenceClass: 'MEASURED', detail });
    },
  };
}

export const REGISTER_PASS_EVERY_MS = 5 * 60_000;
let lastRegisterPass = 0;

/** At most once every five minutes, from the goals tick. A failure is reported, never thrown into the tick. */
export async function reconcileRegisterIfDue(now = Date.now(), ports?: RegisterPassPorts): Promise<RegisterPassReport | { error: string } | null> {
  if (now - lastRegisterPass < REGISTER_PASS_EVERY_MS) return null;
  lastRegisterPass = now;
  try {
    return await reconcileRegister(ports ?? (await productionRegisterPorts()));
  } catch (error) {
    return { error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}

/*
 * GOV-11's fixed check, `probe r01.gov-11({}) passes`, is not registered here.
 * A probe is the exam a requirement is judged by, and an implementer may not
 * write its own exam (§96): it is registered, and its pass condition defined,
 * in server/services/factory/program/probes.ts under the protected
 * verification path. This module only exports the read that check calls —
 * `checkRegisterOnProduction`, whose `{ ok, detail }` is the production
 * register against the program's stored source and appended releases.
 */

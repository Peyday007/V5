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
  /**
   * Releases of the program the register has not been re-mapped against, by
   * number (0 is the original source). Empty when no releases were supplied.
   */
  behind: number[];
}

/** One release of the program as production stores it: 0 is the original source, then every appended release. */
export interface ProgramRelease {
  number: number;
  title: string;
}

/** What the ledger row for the original source names it. */
export const ORIGINAL_RELEASE = 'original source';

/** One row of the "Releases re-mapped" ledger: which release the register was re-mapped against, and what it answered. */
export interface ReleaseRow {
  id: string;
  number: number;
  release: string;
  answers: string[];
}

/**
 * The release ledger: `| GOV-11-Rn | <release title> | <question ids, or none> |`.
 * A row says the register was re-mapped against release n — every question it
 * answers moved to ANSWERED — so a release with no row is one nobody has
 * re-mapped the register against yet. Pure.
 */
export function parseReleaseLedger(markdown: string): ReleaseRow[] {
  const rows: ReleaseRow[] = [];
  for (const line of markdown.split('\n')) {
    const cells = line.trim();
    if (!cells.startsWith('|') || !cells.endsWith('|')) continue;
    const parts = cells.slice(1, -1).split('|').map((cell) => cell.trim());
    const id = parts[0] ?? '';
    const match = /^GOV-11-R(\d+)$/.exec(id);
    if (!match) continue;
    const answers = (parts[2] ?? '').trim();
    rows.push({
      id,
      number: Number(match[1]),
      release: parts[1] ?? '',
      answers: answers === '' || answers === 'none' ? [] : answers.split(',').map((one) => one.trim()).filter((one) => one.length > 0),
    });
  }
  return rows;
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
  releases?: readonly ProgramRelease[],
): RegisterCheck {
  const errors: string[] = [];
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
    const expected = clausesOf(item.text, side.lead);
    if (expected.length === 0) errors.push(`${item.id} enumerates no clause after "${side.lead}"`);
    for (const [index, clause] of expected.entries()) {
      const id = `${side.prefix}${index + 1}`;
      const row = byId.get(id);
      if (!row) {
        errors.push(`${id} (${item.id}) is missing: an entry is retained, never removed`);
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
    const item = itemLedBy(items, lead);
    const listed = item ? clausesOf(item.text, lead).length : 0;
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

  // The re-map half: every release the program has must be one the register
  // was re-mapped against, so a release appended after the register was last
  // kept is a failure that names it — not something only a reader would notice.
  const ledger = parseReleaseLedger(markdown);
  const ledgerSeen = new Map<string, number>();
  for (const entry of ledger) ledgerSeen.set(entry.id, (ledgerSeen.get(entry.id) ?? 0) + 1);
  for (const [id, count] of ledgerSeen) if (count > 1) errors.push(`${id} appears ${count} times`);
  for (const entry of ledger) {
    for (const answer of entry.answers) {
      const question = byId.get(answer);
      if (!question || question.table !== 'QUESTIONS') errors.push(`${entry.id} says it answered ${answer}, which is not a question in this register`);
      else if (question.status !== 'ANSWERED') errors.push(`${entry.id} says it answered ${answer}, but ${answer} is still ${question.status}`);
    }
  }
  const behind: number[] = [];
  if (releases) {
    const byNumber = new Map(ledger.map((entry) => [entry.number, entry]));
    const known = new Set<number>();
    for (const release of [{ number: 0, title: ORIGINAL_RELEASE }, ...releases.filter((one) => one.number !== 0)]) {
      known.add(release.number);
      const entry = byNumber.get(release.number);
      if (!entry) {
        behind.push(release.number);
        errors.push(`release ${release.number} ("${release.title}") is not re-mapped: the register has fallen behind the program — re-map it and append GOV-11-R${release.number}`);
        continue;
      }
      if (normaliseClause(entry.release) !== normaliseClause(release.title)) {
        errors.push(`${entry.id} names "${entry.release}", but release ${release.number} is "${release.title}"`);
      }
    }
    for (const entry of ledger) if (!known.has(entry.number)) errors.push(`${entry.id} names a release the program does not have`);
  }
  return { ok: errors.length === 0, errors, decisions, open, answered, behind };
}

export interface RegisterSources {
  /** The register's text at the revision production runs, or null when it is not there. */
  readRegister: () => Promise<{ text: string | null; where: string }>;
  /** The program's source items, from production rows, or null when no approved program is filed. */
  loadItems: () => Promise<{ items: SourceItem[]; where: string; releases?: ProgramRelease[] } | null>;
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
async function architectureItems(): Promise<{ items: SourceItem[]; where: string; releases: ProgramRelease[] } | null> {
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
    items: extractSourceItems(programSource(program)),
    where: `program ${program.id} (${program.amendments.length} release(s))`,
    releases: program.amendments.map((amendment) => ({ number: amendment.number, title: amendment.title })),
  };
}

/**
 * The register, checked against production: the program's stored source and
 * the register at the running revision. A side that cannot be read is a
 * failure that says which side, never a pass.
 */
export async function checkRegisterOnProduction(sources: Partial<RegisterSources> = {}): Promise<{ ok: boolean; detail: string; check: RegisterCheck | null }> {
  const loadItems = sources.loadItems ?? architectureItems;
  const readRegister = sources.readRegister ?? registerAtRevision;
  const program = await loadItems();
  if (!program) return { ok: false, detail: 'no architecture program is filed on production', check: null };
  const register = await readRegister();
  if (register.text === null) return { ok: false, detail: `the register is not readable: ${register.where}`, check: null };
  const check = checkRegister(register.text, program.items, program.releases ?? []);
  if (!check.ok) return { ok: false, detail: `${register.where} against ${program.where}: ${check.errors[0]}${check.errors.length > 1 ? ` (+${check.errors.length - 1} more)` : ''}`, check };
  return {
    ok: true,
    detail: `${register.where} against ${program.where}: ${check.decisions} decisions verbatim, ${check.open} open question(s) without a default, ${check.answered} answered and re-mapped, re-mapped through release ${(program.releases ?? []).reduce((max, one) => Math.max(max, one.number), 0)}`,
    check,
  };
}

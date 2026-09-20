/**
 * The question each kernel round actually asks.
 *
 * ---------------------------------------------------------------------------
 * A subject is a path, never a leaf
 * ---------------------------------------------------------------------------
 *
 * "Finishing" is not a researchable subject; "Animation and anime production →
 * TV animation → finishing" is. A question composed from a node's own name
 * alone would be the scope defect §25 records arriving through a foreign key
 * instead of through prose — a worker would research a real subject correctly
 * and answer a different question. So every question below carries the whole
 * path from the root.
 *
 * ---------------------------------------------------------------------------
 * The template is fixed, and the subject is what varies
 * ---------------------------------------------------------------------------
 *
 * `launch()` treats one specification as researchable once, so a question that
 * differed per sprint for the same subject would relaunch work already done.
 * The sprint's objective is carried as *context* — it says which findings are
 * worth reporting — and it can widen nothing: the envelope, the evidence gate
 * and the source classes are all the compiler's.
 *
 * ---------------------------------------------------------------------------
 * The bootstrap names systems to consult, never sectors
 * ---------------------------------------------------------------------------
 *
 * This is the whole of why there is no list of industries in this codebase.
 * Naming NAICS, ISIC, SIC and GICS is naming *sources* — the same thing
 * `proposedSources` already does — and the sectors arrive as claims that
 * cleared the evidence gate. A constant holding them would answer the question
 * the kernel exists to ask, and would be wrong about every economy the
 * classification systems have revised since somebody typed it.
 */
import { SEARCH_BUCKETS, type SearchBucket } from '../cash/discovery.ts';
import type { CashOpportunity } from '../../domain/types.ts';

export const BOOTSTRAP_TITLE = 'Which industries the economy is actually divided into';

export const BOOTSTRAP_QUESTION =
  'Which top-level sectors and major industries do the authoritative industry classification ' +
  'systems declare — NAICS, ISIC, SIC, GICS and the national statistical agencies that ' +
  'publish their own — naming each one as the system itself names it, saying which system ' +
  'declares it, and reporting where two systems divide the same activity differently rather ' +
  'than reconciling them?';

export function bootstrapQuestion(objective: string, round: number): string {
  const parts = [
    BOOTSTRAP_QUESTION,
    `This is the starting map for a short cash sprint whose goal is: ${objective}`,
    'Declare every sector you establish with structural_finding set to SUB_INDUSTRY and ' +
      "structural_subject set to that sector's own name. A sector described in prose and not " +
      'declared does not reach the map.',
  ];
  if (round > 1) {
    parts.push(
      `This is asking ${round - 1 === 1 ? 'again' : `round ${round}`} — report what the ` +
        'classification systems have revised, added or retired since, and say so plainly ' +
        'where nothing has changed.',
    );
  }
  return parts.join(' ');
}

export function mapTitle(path: readonly string[]): string {
  return `What sits underneath ${path[path.length - 1] ?? 'this subject'}`;
}

export function mapQuestion(input: {
  path: readonly string[];
  objective: string;
  round: number;
  childrenSoFar: number;
}): string {
  const subject = input.path.join(' → ');
  const parts = [
    `How is ${subject} actually put together — which narrower industries does it contain, ` +
      'what are the stages of producing and delivering in it, which kinds of organisation pay ' +
      'for work in it, who or what actually performs that work, how does money change hands ' +
      'and on what cycle, and where is supply constrained?',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
    'Declare every level you establish on its claim: structural_finding set to the kind it is ' +
      "and structural_subject set to that subject's own name.",
  ];
  if (input.round > 1 || input.childrenSoFar > 0) {
    parts.push(
      `Brain already holds ${input.childrenSoFar} subject` +
        (input.childrenSoFar === 1 ? '' : 's') +
        ' underneath this one. Report what those do not cover rather than restating them.',
    );
  }
  return parts.join(' ');
}

export function scanTitle(bucket: SearchBucket, path: readonly string[]): string {
  return `${bucket.title} — in ${path[path.length - 1] ?? 'this subject'}`;
}

/**
 * A mechanism question, at last with somewhere to point it.
 *
 * The bucket's own sentence is unchanged and carries the scope in front of it.
 * That ordering matters: the bucket says what kind of opening to look for and
 * the subject says where, and a question that buried the subject at the end
 * would be answered about the economy at large — which is what the ten buckets
 * did before this axis existed, and why production discovery returned
 * transcription rates beside ticket resale beside sneakers.
 */
export function scanQuestion(input: {
  bucket: SearchBucket;
  path: readonly string[];
  objective: string;
  round: number;
  foundSoFar: number;
}): string {
  const subject = input.path.join(' → ');
  const parts = [
    `Within ${subject}: ${input.bucket.question}`,
    `This is for a short cash sprint whose goal is: ${input.objective}`,
  ];
  if (input.round > 1) {
    parts.push(
      `Brain has asked this of this subject ${input.round - 1} time` +
        (input.round === 2 ? '' : 's') +
        ` before and filed ${input.foundSoFar} opening` +
        (input.foundSoFar === 1 ? '' : 's') +
        '. Report what has been published since, and say so plainly where nothing has.',
    );
  }
  return parts.join(' ');
}

export function capitalTitle(opportunity: CashOpportunity): string {
  return `What capital "${clip(opportunity.title, 70)}" actually requires`;
}

/**
 * The capital question, with the opening quoted into it.
 *
 * `validationQuestion` does the same thing for the deep dive and for the same
 * reason: a broad question about how an industry is financed has no single
 * answer, and one about *this* transaction does. What the opening's own source
 * said is carried in, because the requirements follow from what is actually
 * being supplied rather than from the industry in general.
 */
export function capitalQuestion(input: {
  opportunity: CashOpportunity;
  path: readonly string[];
  objective: string;
}): string {
  const where = input.path.length > 0 ? input.path.join(' → ') : (input.opportunity.industry ?? '');
  const parts = [
    `What owner capital does this opening actually require, requirement by requirement, and ` +
      `which published practices in its industry remove, defer or shift each one: ` +
      `"${clip(input.opportunity.title, 240)}"?`,
  ];
  if (input.opportunity.buyingSignal) {
    parts.push(`The published evidence it rests on says: "${clip(input.opportunity.buyingSignal, 400)}"`);
  }
  if (where) parts.push(`It sits in ${where}.`);
  parts.push(
    `This is for a short cash sprint whose goal is: ${input.objective}`,
    'Take the requirements apart rather than reporting a headline startup cost. Declare each ' +
      'requirement with structural_finding set to CAPITAL_REQUIREMENT and each structure with ' +
      'CAPITAL_RESTRUCTURING naming the requirement it answers. Where no source publishes an ' +
      'amount, say so — an unknown amount is recorded as unknown, never as a small one.',
  );
  return parts.join(' ');
}

/** The bucket a scan round names, or null where the round names none. */
export function bucketById(bucketId: string | null): SearchBucket | null {
  if (!bucketId) return null;
  return SEARCH_BUCKETS.find((one) => one.id === bucketId) ?? null;
}

function clip(text: string, max: number): string {
  const tidy = text.replace(/\s+/g, ' ').trim();
  if (tidy.length <= max) return tidy;
  const cut = tidy.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

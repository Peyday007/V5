/**
 * Reading a blueprint: the bin, the validation, the audit, the promotion.
 *
 * ---------------------------------------------------------------------------
 * The shape, and why it is this shape
 * ---------------------------------------------------------------------------
 *
 * A worker reads the source and proposes definitions. Brain validates them
 * deterministically, holds them in `faculty_candidates`, and promotes only what
 * an **independent** audit passed. That is §8 at a new artifact — model prose
 * never mutates project state — and every stage below is one of its clauses.
 *
 * It is built on the bin machinery rather than beside it, because everything a
 * long-running assignment needs already exists there: a lease that expires, a
 * generation that fences, attempts that are counted, a checkpoint that survives
 * a restart, and a dispatcher that finds a surface to run it on. A second
 * orchestration universe would be a second security model, and the second one
 * is always the weaker.
 *
 * ---------------------------------------------------------------------------
 * Four properties worth stating before the code
 * ---------------------------------------------------------------------------
 *
 * **Coverage is checkable because Brain declared the units.** The sections come
 * from the document's own headings (`sections.ts`), so "did the worker read all
 * of it" is a question about rows rather than about a summary. A section with
 * no submitted unit is a section nobody read, and it is named.
 *
 * **A citation is a fact about the document.** Every proposed definition must
 * carry a quote, and the quote must be locatable in the extracted text. The
 * page comes from the block Brain found it in — never from the model — which is
 * exactly what `findings.ts` already does and for exactly the same reason.
 *
 * **A refusal is kept.** A candidate that fails validation is stored `REJECTED`
 * with its reason rather than dropped. A dropped candidate makes a coverage gap
 * look like something nobody proposed, which sends the next reader to the wrong
 * question.
 *
 * **Promotion moves one dimension.** `promoteCandidate` sets `DEFINITION` and
 * nothing else, and `assertIngestionScope` refuses any other. Reading a
 * document about Research Intelligence establishes what Brain is supposed to be
 * able to do and nothing whatsoever about whether it can.
 */
import { createBin, getBin, listBinUnitResults } from '../../repos/bins.ts';
import { getCurrentExtractionRun, listBlocks } from '../../repos/extraction.ts';
import { getDocument } from '../../repos/documents.ts';
import { recordEvent } from '../../repos/events.ts';
import {
  advanceSource,
  getCandidate,
  getSource,
  listCandidates,
  listSources,
  promoteCandidate,
  putCandidate,
  putRelationship,
  setCandidateState,
  getFacultyBySlug,
  type CapabilitySource,
  type FacultyCandidate,
} from '../../repos/faculties.ts';
import {
  coverageProblems,
  DEFINITION_KEYS,
  facultySlug,
  InvalidFacultyDefinition,
  LIST_FIELDS,
  validateFacultyDefinition,
  type FacultyDefinition,
} from '../../domain/faculties.ts';
import { scanSections, sectionUnitKey, type BlueprintSection } from './sections.ts';
import type { Bin, DocumentBlock } from '../../domain/types.ts';

export const EXTRACTION_CONTRACT = 'BLUEPRINT_EXTRACTION_V1';
export const AUDIT_CONTRACT = 'BLUEPRINT_AUDIT_V1';
export const EXTRACTION_KIND = 'CAPABILITY_EXTRACTION';
export const AUDIT_KIND = 'CAPABILITY_AUDIT';
export const CAPABILITY_WORKLOAD_CLASS = 'GENERAL_CAPABILITY_READ';

/** The shortest quote that can anchor. Below this, a match means nothing. */
const MIN_QUOTE_CHARS = 24;

/**
 * The most amendment text a manifest may carry.
 *
 * An amendment longer than this is *named* rather than pasted, because a
 * manifest is stored, shown and read back, and an unbounded one is a way to put
 * a whole second document where a bounded assignment belongs.
 */
const MAX_AMENDMENT_CHARS = 8_000;

/* ------------------------------------------------------------------------- */
/* Reading the source                                                         */
/* ------------------------------------------------------------------------- */

export interface SourceReading {
  source: CapabilitySource;
  blocks: DocumentBlock[];
  sections: BlueprintSection[];
  skipped: string[];
  /** Null when the source is readable; the reason when it is not. */
  unreadable: string | null;
}

/**
 * What Brain can actually see in a source.
 *
 * `unreadable` is never an empty list of sections wearing a different name.
 * §9's rule: a `BLOCKED`, `FAILED` or `INTERRUPTED` document is something the
 * reader does **not** have, and every path must say so rather than treating an
 * empty extraction as an empty document.
 */
export async function readSource(sourceId: string): Promise<SourceReading | null> {
  const source = await getSource(sourceId);
  if (!source) return null;

  const run = await getCurrentExtractionRun(source.documentId);
  if (!run) {
    return {
      source,
      blocks: [],
      sections: [],
      skipped: [],
      unreadable: 'The source has no extraction run, so Brain has not read it.',
    };
  }
  if (run.status !== 'READY' && run.status !== 'READY_WITH_WARNINGS') {
    return {
      source,
      blocks: [],
      sections: [],
      skipped: [],
      unreadable:
        `The source's extraction is ${run.status}: ` +
        `${run.blockedReason ?? 'no reason was recorded'}.`,
    };
  }

  const blocks = await listBlocks(run.id);
  const scan = scanSections(blocks);

  /*
   * An amendment declaring no sections is not an unreadable amendment.
   *
   * This was wrong when it was written and running it found it: the Faculty 14
   * clarification registered cleanly, extracted cleanly, and was then marked
   * FAILED for "declaring no sections this kernel recognises" — which is a
   * correct statement about a *blueprint* and a category error about an
   * amendment. An amendment does not define faculties. It changes what one of
   * them means, and the document it changes is the one with the numbering.
   *
   * So an amendment is never dispatched for extraction at all. It is **carried
   * into the reading of the blueprint it amends**, which is what the operator's
   * own instruction asks for — *preserve the source and amendment with
   * provenance* — and is the only shape that keeps both hashes intact while
   * letting one definition reflect both. `amendmentsFor` below is that carrying.
   */
  const isAmendment = source.kind === 'AMENDMENT';
  return {
    source,
    blocks,
    sections: scan.sections,
    skipped: scan.skipped,
    unreadable:
      !isAmendment && scan.sections.length === 0
        ? 'The source is readable and declares no sections this kernel recognises, so there is ' +
          'nothing to extract. A blueprint numbers its definitions; this document does not.'
        : null,
  };
}

/**
 * The amendments registered against one blueprint, as readable text.
 *
 * Bounded, because a manifest is stored, shown and read back, and an unbounded
 * one is a way to put a whole second document into a prompt. An amendment that
 * does not fit is named with its document id rather than truncated — §27's
 * rule, at a new place: truncation is the one outcome a reader cannot recover
 * from, because it is presented as success.
 */
export async function amendmentsFor(blueprintId: string): Promise<
  Array<{ sourceId: string; documentId: string; title: string; text: string | null }>
> {
  const out: Array<{ sourceId: string; documentId: string; title: string; text: string | null }> = [];
  for (const source of await listSources()) {
    if (source.kind !== 'AMENDMENT' || source.amendsId !== blueprintId) continue;
    const run = await getCurrentExtractionRun(source.documentId);
    if (!run || (run.status !== 'READY' && run.status !== 'READY_WITH_WARNINGS')) {
      out.push({
        sourceId: source.id,
        documentId: source.documentId,
        title: source.title,
        text: null,
      });
      continue;
    }
    const text = (await listBlocks(run.id))
      .map((block) => block.normalizedText)
      .join('\n')
      .trim();
    out.push({
      sourceId: source.id,
      documentId: source.documentId,
      title: source.title,
      text: text.length <= MAX_AMENDMENT_CHARS ? text : null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Hand one registered source to a worker, once.
 *
 * The compare-and-swap is the whole of the concurrency design: two ticks
 * reading one `REGISTERED` source both try to move it to `EXTRACTING`, exactly
 * one matches, and the loser creates no bin. A guard on a value the claimant
 * does not supply, for the seventh time in this codebase.
 *
 * The bin is built **after** the swap rather than before, so a crash between
 * them leaves a source in `EXTRACTING` with no bin — which `recoverExtraction`
 * puts back. The other order leaves an orphan bin a worker can be fired for,
 * and a fire spent on work no source is waiting for is worse than a retry.
 */
export async function dispatchExtraction(sourceId: string): Promise<string | null> {
  const reading = await readSource(sourceId);
  if (!reading) return null;
  if (reading.source.kind === 'AMENDMENT') {
    // Carried, never extracted. See `readSource` for why this is a category
    // distinction rather than a special case.
    return null;
  }
  if (reading.unreadable !== null) {
    await advanceSource({
      id: sourceId,
      from: reading.source.ingestState,
      to: 'FAILED',
      detail: reading.unreadable,
    });
    return null;
  }

  const claimed = await advanceSource({ id: sourceId, from: 'REGISTERED', to: 'EXTRACTING' });
  if (!claimed) return null;

  const document = await getDocument(reading.source.documentId);
  const amendments = await amendmentsFor(sourceId);
  const units = reading.sections.map((section) => ({
    key: sectionUnitKey(section),
    establishes:
      section.kind === 'SHARED_EXECUTIVE'
        ? 'What the Shared Executive is, in the source\'s own terms. It is not a faculty.'
        : `The definition of ${section.title}, as section ${section.number} states it.`,
    // The heading is the input rather than the body: the worker has the whole
    // document, and what a unit needs to say is *which* part of it to answer
    // for. A body pasted here would be a second copy of the source.
    input: `${section.number ?? ''} ${section.title}`.trim(),
    transform: 'NONE',
    dependsOn: [],
  }));

  const bin = await createBin({
    projectId: reading.source.projectId,
    layerId: null,
    kind: EXTRACTION_KIND,
    title: `Read the capability blueprint: ${reading.source.title}`,
    objective:
      `Read the registered source "${reading.source.title}" and propose one structured ` +
      `definition for each of its ${reading.sections.length} declared sections. Every ` +
      'definition must quote the source; a definition whose quote Brain cannot locate in the ' +
      'extracted text is refused, because a citation has to be a fact about the document ' +
      'rather than a claim about it.',
    rationale:
      'Brain holds no canonical account of what it is supposed to be able to do. This is the ' +
      'reading that produces one. Nothing here decides whether any of it is implemented.',
    manifest: {
      objective: `Extract the declared capability definitions from ${reading.source.title}.`,
      why:
        'Brain must be able to say what it is supposed to be able to do before it can say how ' +
        'far it has got. The definitions become candidates, never canonical state: ' +
        'deterministic validation and an independent audit decide what is promoted.',
      lineage: {
        projectId: reading.source.projectId,
        layerId: null,
        goal: 'A canonical account of the faculties this Brain is meant to have.',
        orchestrationId: null,
      },
      units,
      acceptableSources: [
        `The registered source document ${reading.source.documentId}` +
          (document ? ` ("${document.canonicalName}")` : ''),
        ...amendments.map(
          (amendment) =>
            `Amendment ${amendment.sourceId} ("${amendment.title}"), document ` +
            `${amendment.documentId}. It changes what one of these sections means, so a ` +
            'definition it touches must reflect both. The blueprint is not rewritten: both ' +
            'sources keep their bytes, and the promoted definition records which it read.' +
            (amendment.text === null
              ? ' Its text is too long to carry here; read it from the document.'
              : `\n\n${amendment.text}`),
        ),
      ],
      excludedSources: [
        'Any source other than the registered document. This is a reading of one artifact, not ' +
          'research: an outside fact about what a faculty "should" be would have no provenance ' +
          'in the source and is refused at validation.',
        'Your own prior knowledge of what these terms usually mean.',
      ],
      evidence: [
        'An exact quote from the source for every proposed definition, long enough to locate: ' +
          `at least ${MIN_QUOTE_CHARS} characters.`,
      ],
      outputs: [
        'One unit result per declared unit key, whose value is a JSON object with a ' +
          '"definition" and a "quote".',
        /*
         * The definition's own shape, named.
         *
         * `validateFacultyDefinition` runs *after* the lease is gone — which is
         * right, because judging well-formedness inside the contract would
         * charge an attempt against a worker whose reading was fine. The cost
         * of that is that a worker which guesses the field names has its whole
         * reading refused with nothing left to correct it with, having done the
         * work. §27 records the same shape one door along: a contract that does
         * not say what it takes refuses work and says nothing.
         *
         * Composed from the constants the validator itself reads, so the
         * instruction cannot drift from what judges it. An unknown field
         * refuses the whole candidate, so the closed set is stated as closed.
         */
        'The "definition" object carries exactly these keys and no others, because an unknown ' +
          `field refuses the whole candidate: ${DEFINITION_KEYS.join(', ')}.`,
        '"canonicalName", "purpose" and "promisedPower" are required non-empty strings. ' +
          '"centralQuestion" is a string or null. "ordinal" is the section number as a ' +
          'non-negative integer, or null. "slug" is derived from the canonical name and is ' +
          'ignored if you send one.',
        `These are arrays of strings, each present even when the source gives it nothing, in ` +
          `which case send an empty array rather than omitting it: ${LIST_FIELDS.join(', ')}.`,
        '"connections" is an array of objects, each with "kind" and "faculty" — the related ' +
          'faculty by its canonical name as the source writes it — and an optional "note". ' +
          'Send an empty array when the section states none.',
      ],
      authorizedActions: [
        'reading the registered source document',
        'submitting one unit result per declared unit',
      ],
      prohibitedActions: [
        'writing a faculty, a relationship, a document, a claim or an audit',
        'proposing a definition that quotes nothing',
        'asserting anything about whether a faculty is implemented, evaluated or switched on — ' +
          'the source says what Brain should be able to do and nothing about whether it can',
        'reading or researching any source other than the registered document',
      ],
      budgetUnits: reading.sections.length,
      retry: { maxAttempts: 2, backoffSeconds: 60 },
      stoppingConditions: [
        'every declared unit has a submitted result',
        'or the source has been read and a unit genuinely has no answer in it, which is ' +
          'submitted as a definition whose lists are empty rather than left absent',
      ],
    },
    completionContract: EXTRACTION_CONTRACT,
    createdByType: 'SYSTEM',
    createdById: `capability:extract:${sourceId}`,
    ready: true,
    priority: 6,
    maxAttempts: 3,
    workloadClass: CAPABILITY_WORKLOAD_CLASS,
  });

  await advanceSource({
    id: sourceId,
    from: 'EXTRACTING',
    to: 'EXTRACTING',
    detail: `Assigned to bin ${bin.id} with ${units.length} declared section(s).`,
    binId: bin.id,
  });
  return bin.id;
}

/**
 * A source left in `EXTRACTING` with no bin, put back.
 *
 * Derived from rows rather than hooked to the moment a tick died, which is what
 * makes it reach the ones already stranded — the fifth time this codebase has
 * needed that distinction. It never touches a source whose bin exists.
 */
export async function recoverExtraction(): Promise<number> {
  let recovered = 0;
  for (const source of await listSources({ states: ['EXTRACTING', 'AUDITING'] })) {
    if (source.binId !== null && (await getBin(source.binId)) !== null) continue;
    const back = source.ingestState === 'AUDITING' ? 'PROPOSED' : 'REGISTERED';
    const moved = await advanceSource({
      id: source.id,
      from: source.ingestState,
      to: back,
      detail: 'The assignment was claimed and no bin exists for it, so it is offered again.',
    });
    if (moved) recovered += 1;
  }
  return recovered;
}

/* ------------------------------------------------------------------------- */
/* Validation                                                                 */
/* ------------------------------------------------------------------------- */

export interface SettledExtraction {
  sourceId: string;
  binId: string;
  proposed: number;
  validated: number;
  rejected: number;
  /** Declared sections with no submitted unit at all. */
  unanswered: string[];
  problems: string[];
}

function comparable(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Where a quote actually appears, or nothing.
 *
 * The same shape `findings.ts` uses, and the same rule: the page is read off
 * the block Brain found the quote in, never taken from the model. A quote too
 * short to be distinctive anchors nothing — a six-character match against a
 * long document is a coincidence rather than a citation.
 */
function anchorFor(quote: string, blocks: DocumentBlock[]): DocumentBlock | null {
  const needle = comparable(quote);
  if (needle.length < MIN_QUOTE_CHARS) return null;
  return (
    blocks.find((block) => comparable(block.normalizedText).includes(needle)) ??
    blocks.find((block) => comparable(block.rawText).includes(needle)) ??
    null
  );
}

/**
 * Turn a finished extraction bin into candidates.
 *
 * Reads after the lease is gone, deliberately. Validating inside the bin would
 * charge an attempt against a worker whose reading was fine and whose quote
 * happened to be paraphrased, and it would make `brain_bin_complete` fail its
 * own ownership proof — the queue is right to refuse that.
 */
export async function settleExtraction(sourceId: string): Promise<SettledExtraction | null> {
  const reading = await readSource(sourceId);
  if (!reading || reading.source.binId === null) return null;
  const bin = await getBin(reading.source.binId);
  if (!bin) return null;

  const results = await listBinUnitResults(bin.id);
  const byKey = new Map(results.map((row) => [row.unitKey, row]));

  const problems: string[] = [];
  const unanswered: string[] = [];
  let proposed = 0;
  let validated = 0;
  let rejected = 0;

  for (const section of reading.sections) {
    const key = sectionUnitKey(section);
    const submitted = byKey.get(key);
    if (!submitted) {
      unanswered.push(`${key} (${section.title})`);
      continue;
    }
    proposed += 1;

    const outcome = await settleOne({
      section,
      value: submitted.value,
      sourceId,
      binId: bin.id,
      blocks: reading.blocks,
    });
    if (outcome.validated) validated += 1;
    else {
      rejected += 1;
      problems.push(`${key}: ${outcome.reason}`);
    }
  }

  // A worker that submitted units Brain never declared has misread the
  // assignment. Reported rather than stored: a candidate for a section that
  // does not exist has nothing to be checked against.
  const declared = new Set(reading.sections.map(sectionUnitKey));
  for (const row of results) {
    if (!declared.has(row.unitKey)) {
      problems.push(`"${row.unitKey}" was submitted and is not a declared section; it is ignored.`);
    }
  }

  await recordEvent({
    projectId: reading.source.projectId,
    layerId: null,
    entityType: 'DOCUMENT',
    entityId: reading.source.documentId,
    eventType: 'CAPABILITY_SOURCE_READ',
    payload: {
      sourceId,
      binId: bin.id,
      declared: reading.sections.length,
      proposed,
      validated,
      rejected,
      unanswered: unanswered.length,
    },
  });

  await advanceSource({
    id: sourceId,
    from: 'EXTRACTING',
    to: 'PROPOSED',
    detail:
      `${validated} of ${reading.sections.length} declared section(s) produced a validated ` +
      `candidate; ${rejected} were refused and ${unanswered.length} were not answered.`,
  });

  return {
    sourceId,
    binId: bin.id,
    proposed,
    validated,
    rejected,
    unanswered,
    problems,
  };
}

/**
 * One submitted unit, validated whole.
 *
 * Four things have to hold, and each one has its own refusal so a worker
 * correcting its reading is told which: it must be JSON; it must carry a
 * definition the schema accepts; it must carry a quote Brain can locate in the
 * extracted text; and the name it proposes must be the section it was asked
 * about rather than a different one.
 */
async function settleOne(input: {
  section: BlueprintSection;
  value: string;
  sourceId: string;
  binId: string;
  blocks: DocumentBlock[];
}): Promise<{ validated: boolean; reason: string }> {
  const reject = async (
    definition: FacultyDefinition | null,
    reason: string,
  ): Promise<{ validated: boolean; reason: string }> => {
    // A rejection with a parsed definition keeps the definition, so a reader can
    // see what was proposed and why it did not survive. One with nothing
    // parseable has nothing to store beyond the reason, and the placeholder
    // carries the section so the row is still findable.
    await putCandidate({
      sourceId: input.sourceId,
      binId: input.binId,
      definition:
        definition ??
        ({
          slug: facultySlug(input.section.title),
          ordinal: input.section.ordinal,
          canonicalName: input.section.title,
          purpose: '',
          centralQuestion: null,
          promisedPower: '',
          responsibilities: [],
          boundaries: [],
          inputs: [],
          outputs: [],
          activationConditions: [],
          reentryConditions: [],
          dependencies: [],
          infrastructure: [],
          allowedProposals: [],
          invariants: [],
          evaluationRequirements: [],
          failureModes: [],
          connections: [],
        } satisfies FacultyDefinition),
      evidenceQuote: '',
      evidenceBlockId: null,
      evidencePage: null,
      state: 'REJECTED',
      rejectionReason: reason,
    });
    return { validated: false, reason };
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.value);
  } catch {
    return reject(null, 'The submitted value was not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return reject(null, 'The submitted value was not a structured object.');
  }
  const record = parsed as Record<string, unknown>;

  const quote = record['quote'];
  if (typeof quote !== 'string' || quote.trim().length === 0) {
    return reject(null, 'The submission carried no quote, so nothing anchors it to the source.');
  }

  let definition: FacultyDefinition;
  try {
    definition = validateFacultyDefinition(record['definition']);
  } catch (error) {
    if (error instanceof InvalidFacultyDefinition) return reject(null, error.problems.join(' '));
    throw error;
  }

  const anchor = anchorFor(quote, input.blocks);
  if (!anchor) {
    return reject(
      definition,
      `The quote does not appear in the source's extracted text, so the definition has no ` +
        `evidence. A quote must be at least ${MIN_QUOTE_CHARS} characters and copied exactly.`,
    );
  }

  // The name must be the section it was asked about. Without this a worker that
  // answered unit `faculty_07` with faculty 8's definition would produce a
  // candidate that validates perfectly and is filed against the wrong heading —
  // §25's Westbrook defect, at a section number.
  if (input.section.kind === 'FACULTY') {
    const asked = comparable(input.section.title);
    const given = comparable(definition.canonicalName);
    if (!asked.includes(given) && !given.includes(asked)) {
      return reject(
        definition,
        `This unit asked about "${input.section.title}" and the definition names ` +
          `"${definition.canonicalName}". They are refused rather than reconciled: choosing ` +
          'which one to believe is exactly the guess that files work under the wrong heading.',
      );
    }
  }

  const thin = coverageProblems(definition);
  await putCandidate({
    sourceId: input.sourceId,
    binId: input.binId,
    definition,
    evidenceQuote: quote.trim(),
    evidenceBlockId: anchor.id,
    evidencePage: anchor.pageNumber,
    state: 'VALIDATED',
    // Thin is not invalid — an empty list is a claim that the source states
    // none — so it is recorded beside the candidate rather than refusing it.
    rejectionReason:
      thin.length > 0
        ? `Validated, and thin: the source was read as stating no ${thin.join(', ')}.`
        : null,
  });
  return { validated: true, reason: '' };
}

/* ------------------------------------------------------------------------- */
/* The independent audit                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Ask a different session whether the reading is faithful.
 *
 * The independence is the point, and it is enforced where §23 enforces every
 * other one: at assignment, from recorded lineage, before the lease. A session
 * that produced the extraction may not be handed the bin that judges it — which
 * is the same sentence §27 writes about a factory review and §23 writes about
 * an audit role, arriving at a third kind of work.
 */
export async function dispatchAudit(sourceId: string): Promise<string | null> {
  const reading = await readSource(sourceId);
  if (!reading) return null;

  const candidates = await listCandidates({ sourceId, states: ['VALIDATED'] });
  if (candidates.length === 0) {
    await advanceSource({
      id: sourceId,
      from: 'PROPOSED',
      to: 'FAILED',
      detail:
        'No candidate survived validation, so there is nothing to audit. The refusals are on ' +
        'the candidate rows with their reasons.',
    });
    return null;
  }

  const claimed = await advanceSource({ id: sourceId, from: 'PROPOSED', to: 'AUDITING' });
  if (!claimed) return null;

  const units = candidates.map((candidate) => ({
    key: auditUnitKey(candidate),
    establishes:
      `Whether the proposed definition of ${candidate.canonicalName} is a faithful reading of ` +
      'the source, or overreaches it.',
    input: candidate.id,
    transform: 'NONE',
    dependsOn: [],
  }));

  const bin = await createBin({
    projectId: reading.source.projectId,
    layerId: null,
    kind: AUDIT_KIND,
    title: `Audit the reading of: ${reading.source.title}`,
    objective:
      `Read the registered source and the ${candidates.length} proposed definition(s) taken ` +
      'from it, and say for each whether it is faithful to the source, overreaches it, or ' +
      'misses something the source states. You did not write these; judge them.',
    rationale:
      'A reading nobody checked is a reading. Promotion writes what Brain will treat as the ' +
      'canonical account of its own faculties, so the reading is audited by a session that ' +
      'did not produce it.',
    manifest: {
      objective: `Audit the proposed definitions taken from ${reading.source.title}.`,
      why:
        'Only an audited definition may become canonical. An audit that passed everything by ' +
        'default would make the whole candidate stage decoration.',
      lineage: {
        projectId: reading.source.projectId,
        layerId: null,
        goal: 'A canonical account of the faculties this Brain is meant to have.',
        orchestrationId: null,
      },
      units,
      acceptableSources: [`The registered source document ${reading.source.documentId}`],
      excludedSources: [
        'Any source other than the registered document. The question is whether the definition ' +
          'is faithful to *this* source, not whether it is a good definition.',
      ],
      evidence: ['The source text itself, for every verdict that is not PASS.'],
      outputs: [
        'One unit result per candidate, whose value is a JSON object with a "verdict" of ' +
          'FAITHFUL, OVERREACHES or INCOMPLETE, and a "reason".',
      ],
      authorizedActions: ['reading the registered source', 'submitting one verdict per candidate'],
      prohibitedActions: [
        'rewriting a definition — this bin judges, it does not author',
        'passing a definition you did not read the source for',
        'asserting anything about whether a faculty is implemented',
      ],
      budgetUnits: candidates.length,
      retry: { maxAttempts: 2, backoffSeconds: 60 },
      stoppingConditions: ['every candidate has a verdict'],
    },
    completionContract: AUDIT_CONTRACT,
    createdByType: 'SYSTEM',
    createdById: `capability:audit:${sourceId}`,
    ready: true,
    priority: 6,
    maxAttempts: 3,
    workloadClass: CAPABILITY_WORKLOAD_CLASS,
  });

  await advanceSource({
    id: sourceId,
    from: 'AUDITING',
    to: 'AUDITING',
    detail: `Audit assigned to bin ${bin.id} over ${candidates.length} candidate(s).`,
    binId: bin.id,
  });
  return bin.id;
}

export function auditUnitKey(candidate: Pick<FacultyCandidate, 'slug'>): string {
  return `verdict_${candidate.slug.toLowerCase()}`;
}

export const AUDIT_VERDICTS = ['FAITHFUL', 'OVERREACHES', 'INCOMPLETE'] as const;
export type AuditVerdict = (typeof AUDIT_VERDICTS)[number];

export interface SettledAudit {
  sourceId: string;
  binId: string;
  promoted: number;
  refused: number;
  unjudged: string[];
  problems: string[];
}

/**
 * Promote what the audit passed, and only that.
 *
 * A candidate with no verdict is **not** promoted. That is the direction this
 * has to fail in: an unjudged definition that became canonical because nobody
 * got to it is exactly the vacuous satisfaction the candidate stage exists to
 * prevent, and it would be invisible afterwards.
 */
export async function settleAudit(sourceId: string): Promise<SettledAudit | null> {
  const source = await getSource(sourceId);
  if (!source || source.binId === null) return null;
  const bin = await getBin(source.binId);
  if (!bin) return null;

  const results = await listBinUnitResults(bin.id);
  const byKey = new Map(results.map((row) => [row.unitKey, row]));
  const candidates = await listCandidates({ sourceId, states: ['VALIDATED'] });

  const problems: string[] = [];
  const unjudged: string[] = [];
  let promoted = 0;
  let refused = 0;

  for (const candidate of candidates) {
    const submitted = byKey.get(auditUnitKey(candidate));
    if (!submitted) {
      unjudged.push(candidate.slug);
      continue;
    }
    const verdict = parseVerdict(submitted.value);
    if (!verdict.ok) {
      unjudged.push(candidate.slug);
      problems.push(`${candidate.slug}: ${verdict.reason}`);
      continue;
    }
    if (verdict.verdict !== 'FAITHFUL') {
      refused += 1;
      await setCandidateState({
        id: candidate.id,
        state: 'REJECTED',
        rejectionReason: `Audit verdict ${verdict.verdict}: ${verdict.reason}`,
        auditId: bin.id,
      });
      continue;
    }
    await promoteCandidate({
      candidateId: candidate.id,
      auditId: bin.id,
      actorType: 'SYSTEM',
      actorId: `capability:audit:${sourceId}`,
    });
    promoted += 1;
  }

  // Edges are linked after every faculty this source produced exists, because
  // the blueprint's own matrix names faculties in an order that guarantees
  // forward references. Resolving them one at a time would drop every edge
  // pointing at a faculty promoted later in the same pass.
  const linkage = await linkRelationships(sourceId);
  problems.push(...linkage.problems);

  await advanceSource({
    id: sourceId,
    from: 'AUDITING',
    to: promoted > 0 ? 'PROMOTED' : 'FAILED',
    detail:
      promoted > 0
        ? `${promoted} definition(s) promoted, ${refused} refused by the audit, ` +
          `${unjudged.length} left unjudged and therefore not promoted. ` +
          `${linkage.linked} relationship(s) recorded.`
        : 'The audit promoted nothing. Every candidate was refused or left unjudged.',
  });

  for (const candidate of candidates) {
    const after = await getCandidate(candidate.id);
    if (after?.state !== 'PROMOTED') continue;
    await recordEvent({
      projectId: source.projectId,
      layerId: null,
      entityType: 'DOCUMENT',
      entityId: source.documentId,
      eventType: 'FACULTY_PROMOTED',
      payload: {
        sourceId,
        candidateId: candidate.id,
        facultyId: after.promotedFacultyId,
        slug: candidate.slug,
        auditBinId: bin.id,
        evidencePage: candidate.evidencePage,
      },
    });
  }

  return { sourceId, binId: bin.id, promoted, refused, unjudged, problems };
}

function parseVerdict(
  value: string,
): { ok: true; verdict: AuditVerdict; reason: string } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, reason: 'The verdict was not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'The verdict was not a structured object.' };
  }
  const record = parsed as Record<string, unknown>;
  const verdict = record['verdict'];
  // Matched exactly. No substring matching, no "closest verdict", no negation
  // handling — §8's rule, and the reason a verdict is a closed set at all.
  if (typeof verdict !== 'string' || !(AUDIT_VERDICTS as readonly string[]).includes(verdict)) {
    return {
      ok: false,
      reason: `"${String(verdict)}" is not one of ${AUDIT_VERDICTS.join(', ')}.`,
    };
  }
  const reason = record['reason'];
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return { ok: false, reason: 'The verdict carried no reason.' };
  }
  return { ok: true, verdict: verdict as AuditVerdict, reason: reason.trim() };
}

/* ------------------------------------------------------------------------- */
/* Relationships                                                              */
/* ------------------------------------------------------------------------- */

export interface Linkage {
  linked: number;
  problems: string[];
}

/**
 * Resolve the edges every promoted faculty declared.
 *
 * An edge whose target faculty does not exist is **reported, not dropped and
 * not invented**. A blueprint may name a faculty this source did not define, or
 * a worker may have proposed one that the audit refused; either way the honest
 * outcome is that the edge is missing and somebody can see which.
 *
 * Idempotent by the edge itself, so running this after a later promotion adds
 * what became resolvable and re-adds nothing.
 */
export async function linkRelationships(sourceId: string): Promise<Linkage> {
  const promotedCandidates = await listCandidates({ sourceId, states: ['PROMOTED'] });
  const problems: string[] = [];
  let linked = 0;

  for (const candidate of promotedCandidates) {
    if (!candidate.promotedFacultyId) continue;
    for (const connection of candidate.definition.connections ?? []) {
      if (connection.toComponent !== null) {
        const added = await putRelationship({
          fromFacultyId: candidate.promotedFacultyId,
          toFacultyId: null,
          toComponent: connection.toComponent,
          relationship: connection.relationship,
          rationale: connection.rationale,
          sourceId,
        });
        if (added) linked += 1;
        continue;
      }
      if (connection.toFacultySlug === null) continue;
      const target = await getFacultyBySlug(connection.toFacultySlug);
      if (!target) {
        problems.push(
          `${candidate.slug} ${connection.relationship} ${connection.toFacultySlug}: that ` +
            'faculty is not canonical, so the edge is not recorded. It is reported rather than ' +
            'invented — a missing endpoint is a fact about the registry.',
        );
        continue;
      }
      const added = await putRelationship({
        fromFacultyId: candidate.promotedFacultyId,
        toFacultyId: target.id,
        toComponent: null,
        relationship: connection.relationship,
        rationale: connection.rationale,
        sourceId,
      });
      if (added) linked += 1;
    }
  }
  return { linked, problems };
}

/* ------------------------------------------------------------------------- */
/* The tick                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Advance every source that can move, once.
 *
 * Derived from rows rather than hooked to the moment a bin finished, for the
 * reason this codebase has needed five times: it reaches what is already
 * stranded, it survives a tick that died halfway, and it cannot be missed by a
 * path that forgot to call something.
 */
export async function advanceSources(): Promise<{
  dispatched: number;
  settled: number;
  audited: number;
  promoted: number;
  recovered: number;
}> {
  const recovered = await recoverExtraction();
  let dispatched = 0;
  let settled = 0;
  let audited = 0;
  let promoted = 0;

  for (const source of await listSources({ states: ['REGISTERED'] })) {
    if (await dispatchExtraction(source.id)) dispatched += 1;
  }

  for (const source of await listSources({ states: ['EXTRACTING'] })) {
    if (!(await binIsFinished(source.binId))) continue;
    if (await settleExtraction(source.id)) settled += 1;
  }

  for (const source of await listSources({ states: ['PROPOSED'] })) {
    if (await dispatchAudit(source.id)) audited += 1;
  }

  for (const source of await listSources({ states: ['AUDITING'] })) {
    if (!(await binIsFinished(source.binId))) continue;
    const outcome = await settleAudit(source.id);
    if (outcome) promoted += outcome.promoted;
  }

  await settleAmendments();

  return { dispatched, settled, audited, promoted, recovered };
}

/**
 * Whether a bin has finished, from the bin's own state.
 *
 * `COMPLETE` and the terminal failures both count: a bin that ran out of
 * attempts still holds whatever units did arrive, and reading them is strictly
 * better than discarding a partial reading because the bin ended badly. What is
 * *done* with a partial reading is the settle's decision, and it names what was
 * unanswered rather than promoting around it.
 */
async function binIsFinished(binId: string | null): Promise<boolean> {
  if (binId === null) return false;
  const bin = await getBin(binId);
  if (!bin) return false;
  return ['COMPLETE', 'FAILED', 'CANCELLED', 'NEEDS_HUMAN'].includes(bin.state);
}

export type { Bin };


/**
 * An amendment is finished when the blueprint that carried it is.
 *
 * Derived from the blueprint's state rather than hooked to the moment it was
 * promoted, so it reaches the ones already registered and survives a tick that
 * died halfway — the same distinction this repository has needed five times.
 *
 * It records that the amendment was *carried*, which is a weaker and truer
 * claim than that it was applied: whether a particular definition reflects it
 * is a fact about that definition's own text, and the audit is what establishes
 * it. Saying "applied" here would be asserting something no row checked.
 */
export async function settleAmendments(): Promise<number> {
  let settled = 0;
  for (const source of await listSources({ states: ['REGISTERED'] })) {
    if (source.kind !== 'AMENDMENT' || source.amendsId === null) continue;
    const blueprint = await getSource(source.amendsId);
    if (!blueprint || blueprint.ingestState !== 'PROMOTED') continue;
    const moved = await advanceSource({
      id: source.id,
      from: 'REGISTERED',
      to: 'PROMOTED',
      detail:
        `Carried into the reading of ${blueprint.id}, which has been promoted. Whether any ` +
        'particular definition reflects this amendment is a fact about that definition and is ' +
        'what the audit established; this records only that the reader had it.',
    });
    if (moved) settled += 1;
  }
  return settled;
}

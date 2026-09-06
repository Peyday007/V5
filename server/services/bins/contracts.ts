/**
 * What it takes for a bin to be finished, decided by Brain.
 *
 * The rule this module exists to enforce is one sentence: **a worker's
 * statement that it is done is not evidence that it is done.** So
 * `brain_bin_complete` does not complete anything. It asks for an evaluation,
 * and the evaluation reads durable records — rows and stored bytes — and
 * returns a verdict the worker had no hand in.
 *
 * Three properties every contract must have, and which the tests check by
 * inversion rather than by reading:
 *
 *   - **Deterministic.** The same rows give the same verdict, always. Nothing
 *     here consults a clock, a random source, or a model.
 *   - **Replayable.** Evaluating twice changes nothing and answers the same.
 *     A verdict that could only be obtained once is not auditable.
 *   - **Sourced.** Every reason names the record that was missing or wrong, so
 *     a refusal tells the worker what to do next instead of just saying no.
 *
 * Contracts are versioned because missions outlive code. A bin records which
 * contract and which revision judged it, so a bin completed in March can still
 * be explained in September after the contract has moved on.
 */
import { createHash } from 'node:crypto';
import type { Bin, BinManifest, BinUnitSpec } from '../../domain/types.ts';
import { listBinUnitResults } from '../../repos/bins.ts';
import { getOrchestration } from '../../repos/research.ts';
import { listWorkItemsForOrchestration } from '../../repos/workQueue.ts';
import { getDocument } from '../../repos/documents.ts';
import { listAuditsByProject } from '../../repos/audits.ts';
import { readObject, storageKeyOf } from '../storage.ts';

/** What an evaluation concluded, and why. */
export interface ContractVerdict {
  /** True only when the bin may become COMPLETE. */
  satisfied: boolean;
  /**
   * When not satisfied: whether more work could still satisfy it.
   *
   * `RETRY` means the worker should keep going. `HUMAN` means no amount of
   * further work by this worker can resolve it, and the governing invariant
   * requires exactly one precise decision to be named.
   */
  disposition: 'SATISFIED' | 'RETRY' | 'HUMAN';
  /** Every reason, each naming the record that was missing or wrong. */
  reasons: string[];
  /** What the evaluation actually read, for the report and for replay. */
  observed: Record<string, unknown>;
}

function satisfied(observed: Record<string, unknown>): ContractVerdict {
  return { satisfied: true, disposition: 'SATISFIED', reasons: [], observed };
}

function refuse(
  disposition: 'RETRY' | 'HUMAN',
  reasons: string[],
  observed: Record<string, unknown>,
): ContractVerdict {
  return { satisfied: false, disposition, reasons, observed };
}

export function hashUnitValue(value: string): string {
  return createHash('sha256').update(value.trim()).digest('hex');
}

/* ------------------------------------------------------------------------- */
/* The deterministic transforms a generic bin may declare                     */
/* ------------------------------------------------------------------------- */

/**
 * The named pure functions Brain can run itself.
 *
 * This is what makes `DETERMINISTIC_UNITS_V1` a check rather than an echo. The
 * manifest declares an input and a transform; the worker submits an answer;
 * Brain recomputes the answer from the input and compares. A worker that simply
 * returns what it was given fails, which is exactly the property a test bin
 * needs if it is going to prove anything about completion validation.
 *
 * Small and closed on purpose. A transform registry that could run arbitrary
 * expressions would be a work type meaning "run this", which §19 forbids.
 */
export const UNIT_TRANSFORMS: Record<string, (input: string) => string> = {
  /** The sha-256 of the input, lowercase hex. Cheap, and impossible to guess. */
  sha256: (input) => createHash('sha256').update(input).digest('hex'),
  /** The input reversed. Trivial, and still not the input. */
  reverse: (input) => [...input].reverse().join(''),
  /** How many words the input has, as a decimal string. */
  word_count: (input) => String(input.trim().split(/\s+/).filter(Boolean).length),
  /** The input upper-cased. */
  upper: (input) => input.toUpperCase(),
};

export function isKnownTransform(name: string): boolean {
  return Object.hasOwn(UNIT_TRANSFORMS, name);
}

/* ------------------------------------------------------------------------- */
/* DETERMINISTIC_UNITS_V1                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Every declared unit has a stored result, and Brain's own recomputation agrees.
 *
 * Two refusals are worth telling apart and are told apart here: a unit with no
 * result at all is work still to do (`RETRY`), and a unit whose stored answer
 * is wrong is a worker producing bad output (`RETRY` too, because the correct
 * value can still be submitted — but it is counted separately and the reason
 * says which).
 */
async function evaluateDeterministicUnits(bin: Bin): Promise<ContractVerdict> {
  const units: BinUnitSpec[] = bin.manifest.units ?? [];
  const results = await listBinUnitResults(bin.id);
  const byKey = new Map(results.map((row) => [row.unitKey, row]));

  const missing: string[] = [];
  const wrong: string[] = [];
  const unknownTransform: string[] = [];

  for (const unit of units) {
    const stored = byKey.get(unit.key);
    if (!stored) {
      missing.push(unit.key);
      continue;
    }
    const transform = UNIT_TRANSFORMS[unit.transform];
    if (!transform) {
      // The manifest named something Brain cannot compute, so Brain cannot
      // check it. That is a fault in the bin rather than in the worker, and no
      // amount of further work resolves it.
      unknownTransform.push(`${unit.key} (${unit.transform})`);
      continue;
    }
    if (transform(unit.input).trim() !== stored.value.trim()) wrong.push(unit.key);
  }

  // Distinct content is checked because a bin whose every unit stores the same
  // string is a worker answering by rote. With real transforms over distinct
  // inputs the values differ, so a collision is a signal rather than a rule.
  const distinct = new Set(results.map((row) => row.contentHash)).size;

  const observed = {
    unitsDeclared: units.length,
    resultsStored: results.length,
    distinctValues: distinct,
    missing,
    wrong,
    unknownTransform,
  };

  if (unknownTransform.length > 0) {
    return refuse(
      'HUMAN',
      [
        `The manifest names ${unknownTransform.length} transform(s) Brain cannot compute, so it ` +
          `cannot check the answer: ${unknownTransform.join(', ')}. The bin was authored wrong; ` +
          'no further work by a worker can satisfy it.',
      ],
      observed,
    );
  }
  if (units.length === 0) {
    return refuse(
      'HUMAN',
      ['The manifest declares no units, so there is nothing this contract could verify.'],
      observed,
    );
  }
  const reasons: string[] = [];
  if (missing.length > 0) {
    reasons.push(
      `${missing.length} declared unit(s) have no stored result: ${missing.join(', ')}.`,
    );
  }
  if (wrong.length > 0) {
    reasons.push(
      `${wrong.length} unit(s) stored a value that does not match Brain's own recomputation: ` +
        `${wrong.join(', ')}.`,
    );
  }
  if (reasons.length > 0) return refuse('RETRY', reasons, observed);
  return satisfied(observed);
}

/* ------------------------------------------------------------------------- */
/* RESEARCH_PACKET_V1                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Step 9's controls, reused whole rather than restated.
 *
 * Everything this reads was already decided by the machinery that decided it:
 * the gate accepted the claims, the verification passes recorded their
 * verdicts, the synthesis check refused a report citing anything unaccepted,
 * the three audit roles ran in order and only the judge's structured output
 * reached `recordAudit`. This contract does not re-judge any of that. It
 * establishes that the packet actually reached its own terminal state and that
 * the artifact it claims to have filed exists and has bytes.
 *
 * That last clause is not paranoia. Step 9 spent three deploys on a report that
 * said every document in the project was missing, and the difference between
 * "the row says COMPLETE" and "the bytes are in the store" is exactly the
 * difference §9 draws between a document existing and having been read.
 */
/**
 * The packet states in which a report has actually been filed.
 *
 * `COMPLETE` alone was wrong, and it was wrong in the exact way Step 10's own
 * plan predicted: "a bin that drains but cannot terminalize because a contract
 * is stricter than the work path can satisfy". `COMPLETE_WITH_GAPS` is a
 * terminal state of the packet runner — the judge asked for more, the run had
 * nothing left to attempt, a person had authorized the packet to declare that,
 * and the report was filed and audited anyway. Every other clause below still
 * applies to it unchanged: the document must exist, it must have bytes, an
 * audit must have judged it, and no work item may still be open.
 *
 * Refusing it would mean an honestly short packet could never finish its bin,
 * so an unattended fleet would bounce a worker off that bin on every
 * activation, forever, for a packet that is already over. The contract's job is
 * to establish that the packet reached its own terminal state and filed
 * something readable — not to re-judge the verdict, which §8 gives to the
 * judge and this module must not take back.
 *
 * `FAILED`, `CANCELLED` and `NEEDS_HUMAN` are deliberately absent: none of them
 * files a report, so none of them may complete a bin.
 */
const PACKET_FILED: ReadonlySet<string> = new Set(['COMPLETE', 'COMPLETE_WITH_GAPS']);

async function evaluateResearchPacket(bin: Bin): Promise<ContractVerdict> {
  const orchestrationId = bin.orchestrationId;
  if (!orchestrationId) {
    return refuse(
      'HUMAN',
      ['This bin declares RESEARCH_PACKET_V1 but links to no orchestration, so there is no packet to judge.'],
      {},
    );
  }
  const orchestration = await getOrchestration(orchestrationId);
  if (!orchestration) {
    return refuse('HUMAN', [`Orchestration ${orchestrationId} does not exist.`], { orchestrationId });
  }

  const items = await listWorkItemsForOrchestration(orchestrationId);
  const open = items.filter((item) => item.state === 'QUEUED' || item.state === 'LEASED');

  const observed: Record<string, unknown> = {
    orchestrationId,
    orchestrationStatus: orchestration.status,
    workItems: items.length,
    openWorkItems: open.length,
    documentId: orchestration.documentId,
  };

  const reasons: string[] = [];

  // Waiting for a person is not something a worker can retry its way out of.
  //
  // §16 stops a browser-initiated run after planning so somebody can read the
  // plan before anything is spent. For the bin that means the honest verdict is
  // HUMAN, not RETRY: no amount of worker effort advances an unapproved packet,
  // and a bin left RETRYing would bounce a worker off it on every activation,
  // spending the routine's fire budget to be told the same thing again.
  //
  // Refused this way the bin goes NEEDS_HUMAN, which is exactly what it is, and
  // stops being dispatchable — so the fleet is quiet while the plan waits. When
  // the plan is approved the bin is made ready again and the ordinary path
  // takes it from there.
  if (orchestration.status === 'AWAITING_APPROVAL') {
    return refuse(
      'HUMAN',
      [
        'The packet is planned and waiting for a person to approve it. Nothing is spent until ' +
          'somebody reads the plan and approves it, so this bin is not work a worker can finish.',
      ],
      observed,
    );
  }

  if (!PACKET_FILED.has(orchestration.status)) {
    reasons.push(
      `The packet is ${orchestration.status}, which is not a state it files a report in. A bin is ` +
        'terminal when its packet is, and the packet runner decides that from its own fragments, ' +
        'verdicts and audits.',
    );
  }
  if (open.length > 0) {
    reasons.push(
      `${open.length} work item(s) in this packet are still queued or leased, so the packet is ` +
        'not finished whatever its status column says.',
    );
  }

  // The artifact, resolved the way every reader in the app resolves it, and
  // read rather than assumed.
  if (!orchestration.documentId) {
    reasons.push('The packet filed no document, so there is no artifact to point at.');
  } else {
    const document = await getDocument(orchestration.documentId);
    if (!document) {
      reasons.push(`The packet names document ${orchestration.documentId}, which does not exist.`);
    } else {
      observed['documentName'] = document.canonicalName;
      // Resolved the way every reader in the app resolves it, rather than by
      // reading the column: a row written before the storage abstraction still
      // resolves through the filesystem path, and a reporter that reads the
      // column calls a document missing that the Brain can serve perfectly well.
      const key = storageKeyOf(document);
      try {
        const bytes = key ? await readObject(key) : null;
        observed['documentBytes'] = bytes?.length ?? 0;
        if (!bytes || bytes.length === 0) {
          reasons.push(
            `The filed document ${document.id} has no bytes in the configured store. A row that ` +
              'says COMPLETE over an artifact nobody can read is the one thing this check exists for.',
          );
        }
      } catch (error) {
        observed['documentBytes'] = null;
        reasons.push(
          `The filed document ${document.id} could not be read from the store: ` +
            `${error instanceof Error ? error.message : String(error)}.`,
        );
      }
    }
  }

  // The audit trail. `listAuditsByProject` is the same reader the console uses.
  const audits = (await listAuditsByProject(bin.projectId)).filter(
    (audit) => audit.runId === orchestration.runId,
  );
  observed['audits'] = audits.length;
  if (audits.length === 0) {
    reasons.push('No audit was recorded for this packet, so nothing judged the report.');
  }

  if (reasons.length > 0) {
    // A packet that is still running is work in progress; one that has gone
    // terminal without filing cannot be fixed by this worker.
    const terminal = ['COMPLETE', 'COMPLETE_WITH_GAPS', 'FAILED', 'CANCELLED', 'NEEDS_HUMAN'].includes(
      orchestration.status,
    );
    return refuse(terminal && !PACKET_FILED.has(orchestration.status) ? 'HUMAN' : 'RETRY', reasons, observed);
  }
  return satisfied(observed);
}

/* ------------------------------------------------------------------------- */
/* The registry                                                               */
/* ------------------------------------------------------------------------- */

type Evaluator = (bin: Bin) => Promise<ContractVerdict>;

/* ------------------------------------------------------------------------- */
/* SURFACE_PROBE_V1                                                           */
/* ------------------------------------------------------------------------- */

/**
 * What a worker may report about one host, and nothing else.
 *
 * Step 10's real research packet failed because the worker's execution surface
 * could not reach the sources. "Blocked" was the only word available for that,
 * and it is four different facts wearing one label:
 *
 *   HOST_NOT_ALLOWED    the worker's own environment refused the host outright
 *   ORIGIN_REJECTED     the host answered, and refused this client
 *   ROBOTS_RESTRICTED   the host's robots policy excludes automated retrieval
 *   OTHER_FAILURE       something else — DNS, TLS, a timeout, a 5xx
 *   RETRIEVED           the document came back
 *
 * They lead to different actions. The first says the surface is still closed
 * and nothing downstream should be attempted. The middle three say the surface
 * is open and *this* publisher will not serve a robot, so an equally
 * authorized publisher of the same primary law should be used instead. Only
 * the last says research can proceed against that host. Collapsing them is how
 * a fixable configuration and an unfixable source get the same shrug.
 */
export const SURFACE_PROBE_OUTCOMES = [
  'RETRIEVED',
  'HOST_NOT_ALLOWED',
  'ORIGIN_REJECTED',
  'ROBOTS_RESTRICTED',
  'OTHER_FAILURE',
] as const;

export type SurfaceProbeOutcome = (typeof SURFACE_PROBE_OUTCOMES)[number];

export interface SurfaceProbeReading {
  unitKey: string;
  host: string;
  outcome: SurfaceProbeOutcome;
  detail: string;
  recordedAt: string;
  submittedBy: string | null;
}

/**
 * The first token of a stored unit value, if it is one of the five.
 *
 * A value that does not begin with a known outcome is not a probe reading, and
 * is reported as unrecognised rather than guessed at. The rest of the line is
 * free text: the URL, the status code, the byte count, whatever the worker saw.
 */
export function parseProbeOutcome(value: string): SurfaceProbeOutcome | null {
  const first = value.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? '';
  return (SURFACE_PROBE_OUTCOMES as readonly string[]).includes(first)
    ? (first as SurfaceProbeOutcome)
    : null;
}

/**
 * Every declared host has a reading, and every reading is one of the five.
 *
 * **Brain does not judge whether the probe succeeded, and must not.** Whether a
 * government website serves a robot today is not something this platform can
 * establish by asserting it; the only honest thing a contract can require is
 * that a worker actually looked at every host it was asked about and recorded
 * what it saw, in a vocabulary that cannot be fudged into meaning something
 * else later. A probe bin in which every host came back HOST_NOT_ALLOWED is a
 * *satisfied* bin carrying bad news, and reporting bad news is the job.
 *
 * What consumes the readings is `readSurfaceProbe`, and what decides anything
 * on the strength of them is the operator action that cites the bin.
 */
async function evaluateSurfaceProbe(bin: Bin): Promise<ContractVerdict> {
  const units: BinUnitSpec[] = bin.manifest.units ?? [];
  const results = await listBinUnitResults(bin.id);
  const byKey = new Map(results.map((row) => [row.unitKey, row]));

  const missing: string[] = [];
  const unrecognised: string[] = [];
  const outcomes: Record<string, string> = {};

  for (const unit of units) {
    const stored = byKey.get(unit.key);
    if (!stored) {
      missing.push(unit.key);
      continue;
    }
    const outcome = parseProbeOutcome(stored.value);
    if (!outcome) {
      unrecognised.push(unit.key);
      continue;
    }
    outcomes[unit.key] = outcome;
  }

  const observed = {
    hostsDeclared: units.length,
    readingsStored: results.length,
    missing,
    unrecognised,
    outcomes,
    vocabulary: [...SURFACE_PROBE_OUTCOMES],
  };

  if (units.length === 0) {
    return refuse(
      'HUMAN',
      ['The manifest declares no hosts to probe, so there is nothing this contract could verify.'],
      observed,
    );
  }
  const reasons: string[] = [];
  if (missing.length > 0) {
    reasons.push(`${missing.length} declared host(s) have no reading: ${missing.join(', ')}.`);
  }
  if (unrecognised.length > 0) {
    reasons.push(
      `${unrecognised.length} reading(s) do not begin with one of ` +
        `${SURFACE_PROBE_OUTCOMES.join(', ')}: ${unrecognised.join(', ')}. A probe result that ` +
        'cannot be read as one of those is not a result.',
    );
  }
  if (reasons.length > 0) return refuse('RETRY', reasons, observed);
  return satisfied(observed);
}

/**
 * The readings a probe bin holds, for whoever has to act on them.
 *
 * Returns them whatever the bin's state: a half-finished probe still tells you
 * something, and a caller that needs the bin to be COMPLETE can check that
 * itself rather than being handed nothing.
 */
export async function readSurfaceProbe(bin: Bin): Promise<SurfaceProbeReading[]> {
  const units: BinUnitSpec[] = bin.manifest.units ?? [];
  const byKey = new Map((await listBinUnitResults(bin.id)).map((row) => [row.unitKey, row]));
  const readings: SurfaceProbeReading[] = [];
  for (const unit of units) {
    const stored = byKey.get(unit.key);
    if (!stored) continue;
    const outcome = parseProbeOutcome(stored.value);
    if (!outcome) continue;
    readings.push({
      unitKey: unit.key,
      host: unit.input,
      outcome,
      detail: stored.value.trim().slice(outcome.length).trim(),
      recordedAt: stored.createdAt,
      submittedBy: stored.submittedBy,
    });
  }
  return readings;
}

/**
 * One judged idea: is there a plan, and is it structurally a plan?
 *
 * Structure only, for the same reason `evaluateRussellTurn` checks only
 * structure: whether the plan may *cause* anything is decided by `validatePlan`
 * and then by `judge()`, against Brain's own archive check, and a second weaker
 * copy of that here would be worse than a narrow check that says what it
 * checks.
 *
 * `RETRY` rather than `HUMAN` on a missing or unparseable submission: the
 * worker can still submit one, and putting a person in front of an idea that
 * only needed asking again is the queue this platform exists to avoid.
 */
async function evaluateRussellPlan(bin: Bin): Promise<ContractVerdict> {
  const results = await listBinUnitResults(bin.id);
  const submitted = results.find((row) => row.unitKey === 'plan');
  const observed = { unitsSubmitted: results.length, hasPlan: Boolean(submitted) };

  if (!submitted) {
    return refuse('RETRY', ['No plan was submitted, so there is nothing to judge the idea with.'], observed);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(submitted.value);
  } catch {
    return refuse('RETRY', ['The plan was not valid JSON.'], observed);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refuse('RETRY', ['The plan was not a structured object.'], observed);
  }
  const record = parsed as Record<string, unknown>;
  if (!record['observations'] || !record['mission']) {
    return refuse(
      'RETRY',
      ['The plan needs both an "observations" object and a "mission" object.'],
      observed,
    );
  }
  return satisfied(observed);
}

const EVALUATORS: Record<string, Evaluator> = {
  DETERMINISTIC_UNITS_V1: evaluateDeterministicUnits,
  RESEARCH_PACKET_V1: evaluateResearchPacket,
  SURFACE_PROBE_V1: evaluateSurfaceProbe,
  RUSSELL_TURN_V1: evaluateRussellTurn,
  RUSSELL_PLAN_V1: evaluateRussellPlan,
};

/**
 * One conversation turn: is there a proposal, and is it structurally a proposal?
 *
 * Structure only, deliberately. Whether the proposal may *do* what it names is
 * decided later by `validateProposal`, against the conversation owner's
 * authority — and the contract evaluator has no principal, so a check here
 * would either be authorization without an authorizer or a second, weaker copy
 * of the real one. Both are worse than a narrow check that says what it checks.
 *
 * What it does refuse is an empty or unparseable submission, because a bin that
 * passed with nothing in it would resolve a person's question with silence.
 */
async function evaluateRussellTurn(bin: Bin): Promise<ContractVerdict> {
  const results = await listBinUnitResults(bin.id);
  const submitted = results.find((row) => row.unitKey === 'proposal');
  const observed = { unitsSubmitted: results.length, hasProposal: Boolean(submitted) };

  if (!submitted) {
    // RETRY, not HUMAN: the worker can still submit one, and a bin refused to a
    // person for a missing submission would put a queue in front of a question
    // that only needed asking again.
    return refuse(
      'RETRY',
      ['No proposal was submitted, so there is nothing to answer the person with.'],
      observed,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(submitted.value);
  } catch {
    return refuse('RETRY', ['The proposal was not valid JSON.'], observed);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refuse('RETRY', ['The proposal was not a structured object.'], observed);
  }
  if (typeof (parsed as Record<string, unknown>)['action'] !== 'string') {
    return refuse('RETRY', ['The proposal named no action.'], observed);
  }
  return satisfied(observed);
}

/**
 * Evaluate a bin's contract.
 *
 * The only entry point, and the only thing allowed to conclude that a bin is
 * finished. An unknown contract is a refusal rather than a pass: a bin whose
 * standard cannot be evaluated is satisfied vacuously otherwise, which is the
 * outcome this whole module exists to prevent.
 */
export async function evaluateContract(bin: Bin): Promise<ContractVerdict> {
  const evaluator = EVALUATORS[bin.completionContract];
  if (!evaluator) {
    return refuse(
      'HUMAN',
      [
        `No evaluator is registered for completion contract "${bin.completionContract}", so this ` +
          'bin cannot be judged. It is refused rather than passed: a mission with no standard is ' +
          'satisfied vacuously, which is worse than being refused.',
      ],
      { completionContract: bin.completionContract },
    );
  }
  return await evaluator(bin);
}

/** Whether a manifest can be dispatched at all. Checked before a bin goes READY. */
export function manifestProblems(
  contract: string,
  manifest: BinManifest,
): string[] {
  const problems: string[] = [];
  if (!EVALUATORS[contract]) {
    problems.push(`"${contract}" is not a registered completion contract.`);
  }
  if (!manifest.objective || manifest.objective.trim().length === 0) {
    problems.push('The manifest has no objective, so nothing says what the bin is for.');
  }
  if (contract === 'DETERMINISTIC_UNITS_V1') {
    if ((manifest.units ?? []).length === 0) {
      problems.push('DETERMINISTIC_UNITS_V1 requires at least one declared unit.');
    }
    const keys = new Set<string>();
    for (const unit of manifest.units ?? []) {
      if (keys.has(unit.key)) problems.push(`Unit key "${unit.key}" is declared twice.`);
      keys.add(unit.key);
      if (!isKnownTransform(unit.transform)) {
        problems.push(
          `Unit "${unit.key}" names transform "${unit.transform}", which Brain cannot compute — ` +
            'so it could never check the answer.',
        );
      }
    }
  }
  if (contract === 'RESEARCH_PACKET_V1' && !manifest.lineage?.orchestrationId) {
    problems.push('RESEARCH_PACKET_V1 requires the manifest to name the orchestration it drives.');
  }
  if (contract === 'SURFACE_PROBE_V1') {
    if ((manifest.units ?? []).length === 0) {
      problems.push('SURFACE_PROBE_V1 requires at least one declared host to probe.');
    }
    const hosts = new Set<string>();
    for (const unit of manifest.units ?? []) {
      if (hosts.has(unit.key)) problems.push(`Probe key "${unit.key}" is declared twice.`);
      hosts.add(unit.key);
      if (!unit.input || unit.input.trim().length === 0) {
        problems.push(`Probe "${unit.key}" names no host, so there is nothing to reach for.`);
      }
    }
  }
  return problems;
}

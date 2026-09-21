/**
 * A mission specification, written by Brain rather than asked for.
 *
 * This module replaces the `RUSSELL_PLAN` bin. That bin sent a captured idea to
 * a subscription worker and asked it to write the mission specification — the
 * title, the objective, the assignment, why now, the source classes and the
 * evidence bar — and Brain validated the answer and launched from it.
 *
 * It never worked. Across three separate occasions the same worker identity
 * answered with padded placeholders: `{title: 'test', objective: 'test', …}` on
 * 2026-09-07, and `"test placeholder title long enough"` with a fragment called
 * `test-placeholder-fragment` accepting source `"a"` on 2026-09-09 — the second
 * one written to clear `PLAN_MINIMUMS` by length while still saying nothing.
 * Brain refused every one of them correctly, at the floor and then at the
 * approval envelope, and the idea went nowhere each time. The manifest carried
 * the real question, stated the placeholder rule in words, and named the exact
 * bounds; the worker read all of it.
 *
 * So the subsystem is gone rather than defended, and the reasoning is worth
 * keeping because it decides what may replace it:
 *
 * **Specifying is not researching.** What a mission must establish is a
 * restatement of the question somebody already asked, bounded by limits already
 * fixed in code. Nothing in it is a finding about the world. That is why it can
 * be compiled: there is no judgement here that needs a reader.
 *
 * **Researching is still the worker's.** This module writes no claim, cites no
 * source and reaches no conclusion. It says what must be established, from what
 * kinds of source, and what would count as finished. Everything downstream —
 * the search, the claims, the seven evidence conditions, the verification pass,
 * the three audit roles, the synthesis — is unchanged and is still done by the
 * subscription fleet.
 *
 * **The compiler cannot widen its own limits.** The source classes, the
 * jurisdiction, the exclusions and the evidence floor are read from the
 * approval envelope, which lives in `services/research/approvalEnvelope.ts` and
 * is named by id. §16's whole safety argument is that nobody supplies the rules
 * their own plan is judged against, and it applies to a compiler exactly as it
 * applied to a model.
 *
 * **What Brain cannot judge, it does not claim to.** A worker was asked two
 * genuinely semantic things: whether a cheap look would settle the question
 * more cheaply than a packet, and what settling it is worth. A compiler cannot
 * answer either, so it answers neither — `cheapToReduce` is false and
 * `expectedValue` is left unset, and both facts are recorded on the judgment as
 * `NOT_ASSESSED` rather than as an opinion. `judge()` then reaches its neutral
 * outcome, which is `WORTH_DOING` / `QUEUED`.
 *
 * The visible consequence is stated rather than hidden: an idea is no longer
 * sent to `EXPLORE` because a look would be cheap, because nothing can now form
 * that view. The probe path is untouched and still reached the other way — the
 * archive contradicting the idea — and by a person's override.
 *
 * **Half of that has since been corrected, and the correction is recorded
 * rather than quietly applied.** `expectedValue` is still not assessed and this
 * module still forms no view about it. But "whether a cheap look would settle
 * this" turned out to have a form that is not semantic at all: the archive's
 * own coverage verdict. `PRESENT_BUT_UNVERIFIED` and `STALE` mean the project
 * already holds a candidate answer that nothing supports, or one that was true
 * outside the timeframe asked about — and confirming or refuting it is a
 * *presence* question, which is the only kind a bounded probe answers. So
 * `judgeCandidate` derives `cheapToReduce` from those rows and this module
 * still supplies neither observation. A compiler cannot judge whether a look
 * would be worth it; it can read whether there is something to look at.
 */
import { getMessage, listTurns } from '../../repos/russellConversations.ts';
import {
  fillAssignmentTemplate,
  getApprovalEnvelope,
  type ApprovalEnvelope,
} from '../research/approvalEnvelope.ts';
import { properName, statesNamedIn } from '../../domain/jurisdiction.ts';
import { opportunityForOwnCandidate } from '../../repos/cashPortfolio.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import { isSelectableCashEnvelope } from '../cash/lifecycle.ts';
import { profileFor, type CompilerProfile } from './compilerProfiles.ts';
import { manufacturingRoundForCandidate } from '../../repos/manufacturing.ts';
import { puzzleRoundForCandidate } from '../../repos/puzzles.ts';
import { industryRoundForCandidate } from '../../repos/industry.ts';
import { laborRoundForCandidate } from '../../repos/labor.ts';
import { describeSource, subjectContextFor, type SubjectContext } from './subject.ts';
import type {
  EvidenceLane,
  Project,
  RussellCandidate,
} from '../../domain/types.ts';
import type { MissionSpec, PlanObservations } from './planning.ts';

/**
 * Bumped when the compiled output changes meaning.
 *
 * Recorded on the judgment, and load-bearing: `launch()` treats one
 * specification as researchable once, so a compiler change is what legitimately
 * produces a second attempt at an idea. That makes the version a reviewed code
 * change rather than a counter anything can advance.
 *
 * What does the relaunching is the *specification* — `specificationKey` is the
 * objective and the why-now, and this constant is not in it — so bumping this
 * alone re-researches nothing. `2026-09-17.1` is exactly that case: the cash
 * discovery profile's lanes gained an evidence kind, which changes the bar a
 * fragment is judged at and leaves every compiled sentence byte for byte as it
 * was.
 */
export const MISSION_COMPILER_VERSION = '2026-09-17.1';

/**
 * Which envelope a project's compiled missions run under.
 *
 * By project slug, in code, and there is exactly one entry. This is the
 * replacement for `missionSpecFor` writing `RUSSELL_STATE_LICENSING_V1` on
 * every mission regardless of project or subject — an acceptance envelope for a
 * Florida and California licensing question, which listed Michigan in its own
 * `forbiddenScope`. Every genuine Deal Dispatch idea was therefore refused by
 * the only envelope it was allowed to name.
 *
 * A project with no entry compiles nothing. That is deny-by-default: an idea in
 * a project nobody has authorized standing research for is not researched, and
 * the refusal says so.
 */
const ENVELOPE_BY_PROJECT: Readonly<Record<string, string>> = Object.freeze({
  'deal-dispatch': 'RUSSELL_PUBLIC_RECORDS_V1',
});

/**
 * Which envelope a project compiles under, after the map above says nothing.
 *
 * The map is a slug frozen in this repository, which works exactly while the
 * projects that do research are ones this repository knows about. Cash Mode's
 * private operations are projects an operator creates — four of them, named by
 * whoever set them up — so a constant here could never have an entry for them,
 * and the compiler's deny-by-default would refuse every idea in every one of
 * them for ever. Appendix C of the Cash Mode plan records exactly that: four
 * new project names plus a prompt activate nothing.
 *
 * So a second source is read, and the safety property is kept rather than
 * traded away. `cash_modes.envelope_id` is written when a person with ADMIN on
 * that project activates the section, and `services/cash/lifecycle.ts` refuses
 * anything outside `SELECTABLE_CASH_ENVELOPES`. A project may therefore
 * *choose* which reviewed limits apply to it and may not write any: §16's
 * sentence — nobody supplies the limits their own plan is judged against —
 * holds unchanged, because the envelope is still code somebody reviewed and the
 * row only names one.
 *
 * The in-code map wins where it has an entry, so nothing about an existing
 * project's authorization can be changed by activating a cash mode on it.
 */
async function envelopeIdFor(
  project: Project,
  candidate: RussellCandidate,
): Promise<string | null> {
  /*
   * A labor question is judged against the labor envelope, whatever project it
   * is in, and like the manufacturing round below it that is read *before*
   * the slug map. The two are mutually exclusive: a candidate is written into
   * at most one kernel's rounds, by that kernel, so the order between them
   * decides nothing and only their precedence over the map does.
   *
   * The map exists so that a free-form idea in a project cannot escape that
   * project's reviewed limits, and nothing about that changes: a caller cannot
   * reach this branch, because `labor_rounds` is written by the kernel and a
   * row in it is Brain's own statement that this candidate is asking one
   * templated question about one task.
   *
   * It has to be first because the alternative is worse in both directions. On
   * `deal-dispatch` the declared envelope is scoped to Michigan public records
   * and lists every other state in its `forbiddenScope`, so a labor question
   * about a national licensing rule would be refused by `planFitsEnvelope` —
   * the candidate parks, its round never settles, and that purpose can never be
   * asked again. And a labor question compiled under a public-records profile
   * would be answered as a public-records question, which is §25's Westbrook
   * defect: the wrong answer confidently derived.
   *
   * What it widens is one thing, said plainly: the classes of published source
   * a labor question in that project may cite. What it does not widen is
   * anything that acts — `RUSSELL_LABOR_ALLOCATION_V1` carries
   * `CASH_FORBIDDEN_ACTIONS`, which names hiring, engaging a contractor and
   * contacting anybody explicitly, so it is *stricter* than the alternative
   * about the exact risk this subject carries.
   */
  if (await laborRoundForCandidate(candidate.id)) return 'RUSSELL_LABOR_ALLOCATION_V1';

  /*
   * A manufacturing question is decided by the round that asked it, and that
   * is read **before** the project's declared envelope.
   *
   * `manufacturing_rounds` is the exact statement — this candidate is asking
   * this purpose about this category — written by Brain when the round was
   * opened. The project map is a default somebody wrote about the project's
   * *ordinary* research. §27 settles the same precedence one system along: the
   * family comes from the bin's manifest first and its label second, because
   * the manifest is the work and the label is something somebody wrote.
   *
   * **The first version read the project map first, and production would have
   * been the Westbrook defect again.** On the seeded project, which declares
   * `PUBLIC_RECORDS`, the question *"Who is actually buying commercial pressure
   * washers, and how does product reach them?"* compiled with geography
   * `Michigan` and acceptable sources *"county register of deeds, county clerk,
   * municipal clerk"*. Every row around it was healthy, the fragment queued,
   * and a worker would have researched that specification correctly and
   * answered a completely different question. Nothing below the compiler could
   * have caught it: the gate judges evidence against the fragment's declared
   * scope, and the scope was the thing that was wrong.
   *
   * **It changes no pre-existing authorization, which is the property §33
   * protects.** That rule exists so activating a section cannot re-scope ideas
   * a project already had. Nothing here does: a kernel round is work this
   * kernel created, it did not exist before the programme was started, and an
   * ordinary idea in the same project still compiles under the project's own
   * declared envelope. What is refused is judging a question by the completion
   * standard of a question nobody asked.
   *
   * Three envelopes rather than one, because `planFitsEnvelope` pins one
   * assignment template per envelope and the three questions have three
   * completion standards.
   */
  const programme = await manufacturingRoundForCandidate(candidate.id);
  if (programme) {
    if (programme.purpose === 'BOOTSTRAP' || programme.purpose === 'MAP') {
      return 'RUSSELL_MACHINE_LADDER_V1';
    }
    if (programme.purpose === 'DEMAND') return 'RUSSELL_MACHINE_DEMAND_V1';
    return 'RUSSELL_MACHINE_CAPABILITY_V1';
  }

  /*
   * A puzzle question is decided by the round that asked it, read **before**
   * the project's declared envelope, for the two reasons directly above.
   *
   * The purposes map onto three envelopes rather than five, because what
   * `planFitsEnvelope` pins is the assignment template and three templates
   * cover them: what the market publishes, what the rights position is, and
   * what production costs. Asking which formats exist and asking who buys one
   * are the same *kind* of question judged by the same standard — the subject
   * varies and the standard does not.
   *
   * The rights question is separated because its completion standard is the
   * one that genuinely differs: an established absence is the result it exists
   * to produce, and a packet judged by the market template would read "no
   * constraint found" as having found nothing.
   */
  const puzzle = await puzzleRoundForCandidate(candidate.id);
  if (puzzle) {
    if (puzzle.purpose === 'RIGHTS') return 'RUSSELL_PUZZLE_RIGHTS_V1';
    if (puzzle.purpose === 'PRODUCTION') return 'RUSSELL_PUZZLE_PRODUCTION_V1';
    return 'RUSSELL_PUZZLE_MARKET_V1';
  }

  const declared = ENVELOPE_BY_PROJECT[project.slug];
  if (declared) return declared;

  const mode = await getCashMode(project.id);
  if (!mode) return null;
  /*
   * A deep dive on one opening is a different question from the bucket that
   * found it, so it is judged against a different assignment.
   *
   * Decided from a row Brain wrote, never from the idea's prose: an
   * opportunity's `candidate_id` is "the idea this opportunity *is*" — what
   * Brain is researching on that opportunity's own behalf — and a bucket's
   * broad question is recorded as `discovered_by_candidate_id` precisely so
   * the two cannot be confused.
   *
   * It widens nothing. `RUSSELL_CASH_VALIDATION_V1` takes its source classes
   * and its forbidden actions verbatim from the discovery envelope; what
   * differs is the assignment template, because asking a market a broad
   * question and asking one opening what it pays are not the same question and
   * must not be judged by the same completion standard.
   */
  /*
   * A kernel question is decided by the round that asked it.
   *
   * `industry_rounds` is the exact statement — this candidate is asking this
   * purpose about this subject — written by Brain when the round was opened,
   * and it is read before the deep dive's own check because it is the more
   * specific row: a CAPITAL round creates its own candidate, and nothing
   * should have to reason about whether that candidate could also look like
   * an opportunity's own. A SCAN falls through deliberately: searching a
   * subject for openings *is* the discovery question, with a scope at last.
   */
  const kernel = await industryRoundForCandidate(candidate.id);
  if (kernel) {
    if (kernel.purpose === 'BOOTSTRAP' || kernel.purpose === 'MAP') {
      return 'RUSSELL_INDUSTRY_MAP_V1';
    }
    if (kernel.purpose === 'CAPITAL') return 'RUSSELL_CAPITAL_STRUCTURE_V1';
  }
  if (await opportunityForOwnCandidate(project.id, candidate.id)) {
    return 'RUSSELL_CASH_VALIDATION_V1';
  }
  return isSelectableCashEnvelope(mode.envelopeId) ? mode.envelopeId : null;
}


/** One fragment, fully specified, ready for `createFragments` to place. */
export interface PlannedFragment {
  fragmentKey: string;
  question: string;
  geography: string;
  timeframe: string | null;
  population: string | null;
  definitions: string | null;
  requiredEvidence: EvidenceLane[];
  acceptableSourceTypes: string[];
  excludedSourceTypes: string[];
  completionCriteria: string[];
  minIndependentSources: number;
  /**
   * What this fragment waits for. Always empty here.
   *
   * One compiled fragment per idea, so there is nothing for it to depend on —
   * and a dependency between fragments is a decomposition judgement a compiler
   * has no way to make. Present and explicit rather than absent, so the shape
   * matches what a worker's proposal produces.
   */
  dependsOn: string[];
  whyItMatters: string;
  /**
   * What the archive was checked against, and why it did not settle this.
   *
   * A reading, and deliberately on the fragment rather than in the
   * specification: `specificationKey` is the objective and the reason-now, so a
   * number that moves every time a claim is accepted would make the idea's
   * identity move with it. Here it is recorded once, when the fragment is
   * created, and nothing compares it afterwards.
   */
  whyExistingInsufficient: string;
  expectedClaimTypes: string[];
  prohibitedEvidence: string[];
  failureConditions: string[];
}

export interface CompiledMission {
  spec: MissionSpec;
  observations: PlanObservations;
  envelopeId: string;
  /** The decomposition, so nothing downstream has to ask a model for one. */
  fragments: PlannedFragment[];
  /**
   * Where the jurisdiction came from, because a default is not a finding.
   *
   * `SUBJECT` is the strongest: a row about the thing itself said so.
   * `QUESTION` is the person's own words. `ENVELOPE` means neither named one
   * and this is where the project is authorized to look — which the objective
   * says in those terms rather than asserting it about the subject.
   */
  jurisdiction: { value: string; from: 'SUBJECT' | 'QUESTION' | 'ENVELOPE' };
  /**
   * Where this question sits in the launch queue within its priority, declared
   * by the profile. Forwarded rather than decided here — see
   * `CompilerProfile.launchOrdinal`.
   */
  launchOrdinal: number;
  compilerVersion: string;
}

export type CompileResult =
  | { ok: true; mission: CompiledMission }
  | { ok: false; reason: string };

function refuse(reason: string): CompileResult {
  return { ok: false, reason };
}

/** Trim, collapse runs of whitespace, and drop a trailing full stop. */
function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
}

/** Cut to a bound at a word boundary, so a title is never a word sliced in half. */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

/**
 * Which jurisdiction this work is about.
 *
 * Three sources, in this order, and the order is the whole repair:
 *
 *   1. **The subject's own row.** An idea raised from a connected record is
 *      about a thing whose location is a column, not a turn of phrase. That
 *      column outranks everything below it, because the sentence beneath it is
 *      a paraphrase of the same row and a paraphrase can lose a field.
 *   2. **The question's own words.** A question naming a state is about that
 *      state, and if the envelope does not authorize it the compiler refuses
 *      rather than quietly re-scoping the person's question to somewhere it is
 *      allowed to look. Two states named is also a refusal — that is a
 *      decomposition decision, and guessing which is meant would be the
 *      compiler inventing scope.
 *   3. **The envelope's**, and only when neither of the first two says
 *      anything. It is recorded as `ENVELOPE` so the objective can say the
 *      jurisdiction is where this project may *look* rather than where the
 *      subject *is*.
 *
 * The defect this replaces: a record whose row said `state: "OH"` named no
 * state in prose — `OH` is not the word `ohio` — fell through to the envelope,
 * and was compiled as *"Establish, from official Michigan public records, …"*
 * about a deal in Ohio. Research against that specification would have
 * answered a different question correctly, which is worse than not researching.
 *
 * A subject and a question naming **different** states is a refusal rather than
 * a precedence question: two rows disagree about what the work is about, and
 * choosing one would be choosing which to ignore.
 */
function jurisdictionFor(
  question: string,
  envelope: ApprovalEnvelope,
  subject: SubjectContext,
  profile: CompilerProfile,
): { value: string; from: 'SUBJECT' | 'QUESTION' | 'ENVELOPE' } | { refusal: string } {
  const named = statesNamedIn(question).map(properName);
  if (named.length > 1 && profile.multipleJurisdictions === 'REFUSE') {
    return {
      refusal:
        `this question names more than one jurisdiction (${named.join(', ')}), and splitting ` +
        'it into one question per jurisdiction is a decision Brain does not take on its own',
    };
  }
  /*
   * Several jurisdictions, described rather than refused.
   *
   * Refusing is right for a statutory question — "which county's rule applies"
   * is a decomposition decision and guessing would be the compiler inventing
   * scope. It is wrong for market discovery, where two states are genuinely one
   * market, and refusing there would refuse the work the envelope exists to
   * permit. Which of the two applies is the profile's, and is not inferred from
   * the words.
   */
  const fromQuestion =
    named.length > 1
      ? `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
      : (named[0] ?? null);
  const fromSubject = subject.jurisdiction?.value ?? null;

  if (fromSubject && fromQuestion && fromSubject !== fromQuestion) {
    return {
      refusal:
        `the record this is about is in ${fromSubject} and the question is about ` +
        `${fromQuestion}; Brain will not choose which of the two to ignore`,
    };
  }

  const chosen: { value: string; from: 'SUBJECT' | 'QUESTION' | 'ENVELOPE' } = fromSubject
    ? { value: fromSubject, from: 'SUBJECT' }
    : fromQuestion
      ? { value: fromQuestion, from: 'QUESTION' }
      : { value: envelope.jurisdiction, from: 'ENVELOPE' };

  /*
   * The envelope's own jurisdiction needs no check against itself. Anything the
   * subject or the question named does — and a refusal here is an escalation
   * with an answering transition: `judgeCandidate` parks the idea carrying this
   * sentence, so the person who can authorize the jurisdiction can see that it
   * is what is wanted.
   */
  if (chosen.from !== 'ENVELOPE') {
    if (!envelope.geography.test(chosen.value) || envelope.forbiddenScope.test(chosen.value)) {
      const because =
        chosen.from === 'SUBJECT' && subject.jurisdiction
          ? describeSource(subject.jurisdiction.from)
          : 'the question says so';
      return {
        refusal:
          `this work is about ${chosen.value} — ${because} — and the standing authorization ` +
          `for this project covers ${envelope.jurisdiction}. Authorising research in ` +
          `${chosen.value} is a decision for a person`,
      };
    }
  }

  return chosen;
}

/**
 * The source classes, taken from the envelope rather than written here.
 *
 * Every one of these is tested against `envelope.allowedSourceTypes` before it
 * is returned, so a class this list drifted out of alignment with is dropped
 * rather than proposed and refused later. The check is the envelope's; this is
 * only the vocabulary the envelope's own words describe.
 */
function sourceClassesFor(envelope: ApprovalEnvelope, profile: CompilerProfile): string[] {
  return profile.proposedSources.filter((entry) => envelope.allowedSourceTypes.test(entry));
}

/**
 * Compile one candidate into a mission specification.
 *
 * Total and deterministic: the same candidate, project and envelope produce the
 * same specification byte for byte, which is what makes "this specification has
 * already been researched" a decidable question in `launch()`.
 */
export async function compileMission(input: {
  candidate: RussellCandidate;
  project: Project;
  archive: { claimsConsidered: number; contradicting: string[] };
}): Promise<CompileResult> {
  const { candidate, project } = input;

  const envelopeId = await envelopeIdFor(project, candidate);
  if (!envelopeId) {
    return refuse(
      `no standing research authorization is defined for the project "${project.slug}", so ` +
        'Brain has no limits to compile a mission inside',
    );
  }
  const envelope = getApprovalEnvelope(envelopeId);
  if (!envelope) {
    return refuse(`the envelope "${envelopeId}" this project names is not defined in this build`);
  }
  if (envelope.assignmentTemplate === undefined) {
    return refuse(
      `the envelope "${envelopeId}" pins one exact assignment rather than a template, so a ` +
        'compiled question cannot be authorized under it',
    );
  }
  if (envelope.projectSlug && envelope.projectSlug !== project.slug) {
    return refuse(
      `the envelope "${envelopeId}" authorizes work in "${envelope.projectSlug}" and this idea ` +
        `is in "${project.slug}"`,
    );
  }

  /*
   * What kind of question this envelope's work actually is.
   *
   * Widening what a fragment may cite changed nothing about what the compiler
   * wrote, so a marketplace request compiled into a public-records task: every
   * objective said "from official Michigan public records", every source class
   * was a county office, and forums, blogs and social media — where a demand
   * signal lives — were banned outright. An envelope with no profile compiles
   * nothing, because falling back to *some* profile is how the wrong kind of
   * question gets written for an authorization nobody matched it to.
   */
  const profile = profileFor(envelopeId);
  if (!profile) {
    return refuse(
      `the envelope "${envelopeId}" has no compiler profile in this build, so Brain does not ` +
        'know what kind of question it authorizes',
    );
  }

  /*
   * The person's own words, preferred over the captured statement.
   *
   * A candidate's `statement` is a worker's summary of what somebody asked. The
   * message they actually sent is the primary text, so it is what the
   * assignment quotes when it is still there — and the summary is the fallback
   * rather than the source. Neither is a finding; both are the question.
   */
  const asked = await personsRequest(candidate);
  const request = asked ? tidy(asked) : '';
  const statement = tidy(candidate.statement);
  if (!statement) return refuse('this idea has no statement to compile a mission from');

  const question = request || statement;

  /*
   * What the idea is about, from rows.
   *
   * Resolved here rather than inside `jurisdictionFor`, so the compiler's one
   * database read is visible at the top level and the decision function stays
   * pure and directly testable.
   */
  const subject = await subjectContextFor(candidate);
  const jurisdiction = jurisdictionFor(question, envelope, subject, profile);
  if ('refusal' in jurisdiction) return refuse(jurisdiction.refusal);

  const sources = sourceClassesFor(envelope, profile);
  if (sources.length === 0) {
    return refuse(
      `the envelope "${envelopeId}" accepts none of the source classes this compiler knows how ` +
        'to specify, so it cannot write a fragment that could be approved',
    );
  }

  const assignment = fillAssignmentTemplate(envelope.assignmentTemplate, {
    QUESTION: question,
    JURISDICTION: jurisdiction.value,
  });

  /*
   * A title, an objective and a reason, each derived and each honest.
   *
   * The title is the idea's own title. The objective restates the question as
   * something to establish. `whyNow` says what is true of the project right
   * now — that its own archive was checked against a stated number of claims
   * and does not answer this — which is a fact about Brain's state rather than
   * a claim about the subject. None of the three asserts anything about the
   * world, and that is the line this compiler does not cross.
   */
  const title = clamp(tidy(candidate.title) || clamp(question, 80), 160);
  /*
   * The objective says where the answer comes from, and only claims where the
   * subject *is* when something actually said so.
   *
   * With `SUBJECT` or `QUESTION` the jurisdiction is a fact about the work, and
   * the sentence reads as it always did. With `ENVELOPE` nothing named one, so
   * the sentence names the authorization instead — because the alternative is
   * the defect this replaces: a specification asserting that a deal in Ohio is
   * a question about Michigan records, which a worker would then research
   * correctly and answer wrongly.
   */
  const objective = profile.objective({
    question,
    scope: jurisdiction.value,
    from: jurisdiction.from,
  });
  /*
   * Stable over time, and that is load-bearing rather than stylistic.
   *
   * This sentence used to name how many accepted claims the archive check
   * weighed. That number moves — every claim a packet accepts changes it — so
   * the compiled specification for one idea changed between one tick and the
   * next, and "is this the specification the compiler produces" stopped being
   * a decidable question. Two things rest on it being decidable: `launch()`
   * refuses a specification already researched, and the loop identifies a
   * mission from the retired planning subsystem by comparing against this. A
   * drifting specification would have relaunched ideas and retired healthy
   * missions, both silently.
   *
   * The count is still recorded, on the judgment, where it is a reading rather
   * than part of an identity.
   */
  const whyNow =
    "The project's own archive does not answer this, so the answer has to come from outside it.";

  const lanes: EvidenceLane[] = profile.lanes;

  /*
   * What "done" means, and — since 2026-09-11 — what a claim without a source
   * costs, in the place the worker reads before it starts.
   *
   * The second criterion already said every source carries its URL. It did not
   * say what happens to one that does not, and the honest reading of that
   * silence is the one a worker took: seventeen claims submitted, ten of them
   * bare assertions, so the gate's majority-rejection rule blocked the fragment
   * and threw away the seven that *were* sourced. Neither rule is wrong —
   * "there is no source" is not evidence, and a fragment whose sourcing is
   * mostly refused cannot be relied on where it happened to hold up — but a
   * contract that states a requirement without its consequence is one a
   * reasonable worker under-reads.
   *
   * So the consequence is stated, and nothing is relaxed: the gate, the
   * majority rule and the evidence standard are untouched, and the escape for
   * a source found but unreadable is the one the method already describes.
   */
  const completionCriteria = profile.completionCriteria(jurisdiction.value);

  const fragment: PlannedFragment = {
    fragmentKey: profile.fragmentKey,
    question,
    geography: jurisdiction.value,
    timeframe: null,
    population: null,
    definitions: null,
    requiredEvidence: lanes,
    acceptableSourceTypes: sources,
    excludedSourceTypes: profile.excludedSources,
    completionCriteria,
    dependsOn: [],
    minIndependentSources: Math.max(1, envelope.minIndependentSourcesFloor),
    whyItMatters: whyNow,
    whyExistingInsufficient:
      `Checked against ${input.archive.claimsConsidered} accepted claim(s) in this project's ` +
      `archive, ${input.archive.contradicting.length} of which argue against it; none of them ` +
      'settles the question.',
    expectedClaimTypes: profile.expectedClaimTypes,
    prohibitedEvidence: profile.excludedSources,
    failureConditions: profile.failureConditions,
  };

  return {
    ok: true,
    mission: {
      envelopeId,
      compilerVersion: MISSION_COMPILER_VERSION,
      // The profile's own declaration, forwarded. Nothing here decides it.
      launchOrdinal: profile.launchOrdinal,
      jurisdiction,
      fragments: [fragment],
      /*
       * Neither of these is a view Brain holds.
       *
       * `cheapToReduce` false means "no bounded look was proposed", not "a look
       * would not help" — and the judgment records which of those it is.
       * `expectedValue` is absent rather than a number, so `judge()` reaches its
       * own neutral default instead of acting on a figure nobody produced.
       */
      observations: { cheapToReduce: false, expectedValue: 0, blockedBy: null },
      spec: {
        title,
        objective: clamp(objective, 1_800),
        assignment,
        whyNow: clamp(whyNow, 900),
        acceptableSources: sources,
        excludedSources: profile.excludedSources,
        evidence: lanes.map((lane) => `${lane.id}: ${lane.description}`),
        /*
         * No follow-on is declared.
         *
         * The field exists for the one question finishing a mission would
         * obviously leave open, and knowing that requires having read the
         * answer. A compiler has not; inventing one would buy research nobody
         * asked for. The follow-on path stays reachable exactly as it is — from
         * a finished mission's own declaration — and this simply does not
         * declare one.
         */
        followOn: null,
      },
    },
  };
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * What the person actually asked, by id when the idea carries one and from the
 * conversation when it does not.
 *
 * `source_message_id` is written now, but every idea captured before that was
 * true has a null there — and the fallback is not cosmetic. Production's idea
 * carried the worker's restatement, *"the counties Deal Dispatch cares about"*,
 * and the compiled fragment inherited it; the worker researching it reported,
 * correctly, that neither the orchestration nor the project names those
 * counties. A specification faithful to a summary is not faithful to the
 * question.
 *
 * The fallback is the same rule `askedMessageFor` applies to a turn: the last
 * message the person sent at or before the idea was captured. Deterministic —
 * both timestamps are fixed — so the compiled specification stays stable, which
 * `launch()` and the recovery step both depend on.
 *
 * Returns null rather than guessing when there is no such message. The
 * candidate's own statement is then the question, which is what it was always
 * meant to be a summary of.
 */
export async function personsRequest(candidate: RussellCandidate): Promise<string | null> {
  if (candidate.sourceMessageId) {
    const message = await getMessage(candidate.sourceMessageId);
    if (message?.role === 'USER' && message.content.trim()) return message.content;
  }
  if (!candidate.conversationId) return null;
  const turns = await listTurns(candidate.conversationId, 200);
  const before = turns.filter(
    (turn) =>
      turn.role === 'USER' &&
      turn.content.trim().length > 0 &&
      turn.createdAt <= candidate.createdAt,
  );
  return before[before.length - 1]?.content ?? null;
}

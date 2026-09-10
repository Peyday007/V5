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
 */
export const MISSION_COMPILER_VERSION = '2026-09-09.1';

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
): { value: string; from: 'SUBJECT' | 'QUESTION' | 'ENVELOPE' } | { refusal: string } {
  const named = statesNamedIn(question).map(properName);
  if (named.length > 1) {
    return {
      refusal:
        `this question names more than one jurisdiction (${named.join(', ')}), and splitting ` +
        'it into one question per jurisdiction is a decision Brain does not take on its own',
    };
  }
  const fromQuestion = named[0] ?? null;
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
function sourceClassesFor(envelope: ApprovalEnvelope): string[] {
  const proposed = [
    'county register of deeds or recording office',
    'county clerk, assessor, equalization or treasurer office',
    'municipal or township clerk office',
    'state of michigan department or bureau guidance',
    'michigan statute or administrative rule',
    'official county or state open-data portal or fee schedule',
  ];
  return proposed.filter((entry) => envelope.allowedSourceTypes.test(entry));
}

const EXCLUDED_SOURCES = [
  'vendor or software marketing pages',
  'title-company or law-firm articles as sole support',
  'news summaries as sole support',
  'forum posts, blogs and social media',
];

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

  const envelopeId = ENVELOPE_BY_PROJECT[project.slug];
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
  const jurisdiction = jurisdictionFor(question, envelope, subject);
  if ('refusal' in jurisdiction) return refuse(jurisdiction.refusal);

  const sources = sourceClassesFor(envelope);
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
  const objective =
    jurisdiction.from === 'ENVELOPE'
      ? `Establish, from the official ${jurisdiction.value} public records this project is ` +
        `authorized to search — nothing about this names a jurisdiction of its own — ` +
        lowerFirst(question)
      : `Establish, from official ${jurisdiction.value} public records, ${lowerFirst(question)}`;
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

  const lanes: EvidenceLane[] = [
    {
      id: 'official_source',
      description:
        'The official office, statute, rule or portal that states the answer, quoted, with ' +
        'its URL and the date it was published or last updated.',
      necessity: 'REQUIRED',
    },
    {
      id: 'office_variation',
      description:
        'Where the answer differs between offices or counties, the differing official ' +
        'sources named per office — and an explicit statement that it does not differ, if ' +
        'the sources show that.',
      necessity: 'CONDITIONAL',
    },
  ];

  const completionCriteria = [
    'Every part of the question is answered from a quoted official source, or recorded as ' +
      'unresolved naming the offices searched and what was not found.',
    'Every source carries its URL, the office or authority that publishes it, and the date ' +
      'it was published or last updated.',
    `Every finding is about ${jurisdiction.value}; anything found about anywhere else is ` +
      'reported as out of scope rather than used.',
  ];

  const fragment: PlannedFragment = {
    fragmentKey: 'official-record',
    question,
    geography: jurisdiction.value,
    timeframe: null,
    population: null,
    definitions: null,
    requiredEvidence: lanes,
    acceptableSourceTypes: sources,
    excludedSourceTypes: EXCLUDED_SOURCES,
    completionCriteria,
    dependsOn: [],
    minIndependentSources: Math.max(1, envelope.minIndependentSourcesFloor),
    whyItMatters: whyNow,
    whyExistingInsufficient:
      `Checked against ${input.archive.claimsConsidered} accepted claim(s) in this project's ` +
      `archive, ${input.archive.contradicting.length} of which argue against it; none of them ` +
      'settles the question.',
    expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION', 'NEGATIVE_EXISTENCE'],
    prohibitedEvidence: EXCLUDED_SOURCES,
    failureConditions: [
      'No official source can be located for a part of the question.',
      'The only sources found are secondary, so nothing primary supports the answer.',
    ],
  };

  return {
    ok: true,
    mission: {
      envelopeId,
      compilerVersion: MISSION_COMPILER_VERSION,
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
        excludedSources: EXCLUDED_SOURCES,
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

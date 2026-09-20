/**
 * The Human Necessity Test, asked of one task.
 *
 * ---------------------------------------------------------------------------
 * The default is a burden of proof, not an assumption
 * ---------------------------------------------------------------------------
 *
 * The brief's prime directive is that Brain is the production layer and human
 * labor is an escalation layer. Read as a licence to assume, that sentence is
 * a disaster: a task moved to Brain on a hunch is an output nobody produces,
 * or one produced without the licence, signature or physical presence somebody
 * is legally owed. Read as a burden of proof, it is exactly right — nothing
 * may stay with a person because it always has, and every human role has to
 * name which of six reasons justifies it.
 *
 * So this module never answers *yes, Brain can have it* on an absence. It
 * answers `BRAIN_DEFENSIBLE` only when the questions that could stop it are
 * actually answered in the direction that permits it, `HUMAN_REQUIRED` when a
 * reason is established, and `NOT_ESTABLISHED` otherwise — which is most tasks
 * on the day the kernel first sees them, and is the honest reading.
 *
 * ---------------------------------------------------------------------------
 * An unknown is never favourable, and the favourable direction is Brain
 * ---------------------------------------------------------------------------
 *
 * §30 and §38 both record this rule at a money figure, where the cheap-looking
 * answer understates a cost. Here the cheap-looking answer is *Brain can do
 * it*, so an `UNKNOWN` may never stand in for the answer that would move a
 * task to Brain — and, symmetrically, may never be the reason a person is kept
 * either. It is a task, and it says which one.
 *
 * ---------------------------------------------------------------------------
 * Two answers are read, never remembered
 * ---------------------------------------------------------------------------
 *
 * *Can Brain produce this output* and *could another session verify it* are
 * both facts about rows that move under them, so they are re-read on every
 * pass and there is nowhere in the schema to write either down. A fleet that
 * lost its last healthy surface an hour ago must not still be reported as able
 * to produce, and a cached answer is the difference between a reading and a
 * memory of one — `readCapability`'s own rule, at the test that decides
 * whether somebody is needed.
 */
import { readCapability, type CapabilityReading } from '../cash/capabilities.ts';
import { separationCapacity } from '../research/auditAdmission.ts';
import type {
  HumanNecessityReason,
  LaborNecessityAnswer,
  LaborTask,
  NecessityAnswer,
  NecessityQuestion,
} from '../../domain/types.ts';

/**
 * The two questions Brain answers from its own rows.
 *
 * Deliberately outside `NECESSITY_QUESTIONS`, which is the set that can be
 * *stored*. Keeping them in one union and filtering on write would have left
 * one forgotten check between a derived answer and a stale row.
 */
export const DERIVED_QUESTIONS = ['BRAIN_CAN_PRODUCE', 'INDEPENDENT_VERIFICATION_AVAILABLE'] as const;
export type DerivedQuestion = (typeof DERIVED_QUESTIONS)[number];

export type AnyQuestion = NecessityQuestion | DerivedQuestion;

export type AnswerBasis = 'DERIVED' | 'RESEARCHED' | 'PERSON' | 'NOT_ASKED';

export interface QuestionReading {
  question: AnyQuestion;
  /** The brief's own numbering, so a reader can find the question it is. */
  ordinal: number;
  label: string;
  answer: NecessityAnswer;
  basis: AnswerBasis;
  /** The answer in words, or why there is not one. */
  statement: string;
  /**
   * What would answer it.
   *
   * Present whether or not it is answered, because the remedy is a property of
   * the question rather than of today's blank — `card.ts`' rule, at the test
   * that decides whether a person is needed.
   */
  task: string;
  /**
   * Which answer supports producing this with Brain.
   *
   * Carried on the reading rather than known by each consumer, because a
   * consumer that had to remember which questions are inverted is a consumer
   * that will eventually read `REQUIRES_LICENSED_HUMAN: YES` as good news.
   */
  supportsBrainWhen: NecessityAnswer;
  sourceClaimId: string | null;
}

/**
 * What stands between this task and Brain producing it.
 *
 * Derived on every read rather than stored, so a blocker clears itself the
 * moment the thing it names stops being true. That is the fourth time this
 * repository has needed that distinction, and here it is what makes §7's
 * *automation frontier* a live reading rather than a list somebody has to
 * remember to revisit.
 */
export const LABOR_BLOCKERS = [
  'CAPABILITY_MISSING',
  'CAPABILITY_UNKNOWN',
  'LEGAL_ACCOUNTABILITY',
  'PHYSICAL_PRESENCE',
  'RELATIONSHIP_VALUE',
  'QUALITY_UNPROVEN',
  'VERIFICATION_INSUFFICIENT',
  'EXCEPTION_ONLY',
  'NECESSITY_UNANSWERED',
] as const;
export type LaborBlockerKind = (typeof LABOR_BLOCKERS)[number];

export interface LaborBlocker {
  kind: LaborBlockerKind;
  /** What it is, in the words a person decides in. */
  statement: string;
  /** The first thing somebody would actually do about it. */
  remedy: string;
  /** The capability it names, where it names one. */
  capabilityId: string | null;
}

export type NecessityVerdict = 'BRAIN_DEFENSIBLE' | 'HUMAN_REQUIRED' | 'NOT_ESTABLISHED';

export interface NecessityReading {
  taskId: string;
  verdict: NecessityVerdict;
  /**
   * Which of the six classes justifies a person, where one is established.
   *
   * Null for both other verdicts, and null is meaningful: a `NOT_ESTABLISHED`
   * task has no established reason for a person *and* no established case for
   * Brain, which is a third state rather than a weak version of either.
   */
  reason: HumanNecessityReason | null;
  questions: QuestionReading[];
  /** Ordered strongest first. Empty exactly when the verdict is BRAIN_DEFENSIBLE. */
  blockers: LaborBlocker[];
  /**
   * Whether Brain is established to be both faster and cheaper here.
   *
   * Reported beside the verdict and deliberately not part of it. Those two
   * questions decide what is *worth* doing rather than what is *permitted*,
   * and the brief is explicit that the objective is not to maximize automation
   * for its own sake. A task Brain may take and has not been shown to do
   * faster is still a task Brain may take.
   */
  advantage: 'ESTABLISHED' | 'NOT_ESTABLISHED';
  /** The capability reading behind question 2, for anything that wants to say why. */
  capability: CapabilityReading | null;
  /** One sentence a person can read without opening the table. */
  summary: string;
}

interface QuestionMeta {
  ordinal: number;
  label: string;
  task: string;
  supportsBrainWhen: NecessityAnswer;
}

/**
 * The brief's twelve questions, minus the three that are columns or
 * derivations and the one this module computes.
 *
 * A `Record` over the whole union, so a question added to the vocabulary is a
 * compile error here until somebody says what it means and which answer
 * supports Brain.
 */
const META: Readonly<Record<AnyQuestion, QuestionMeta>> = Object.freeze({
  BRAIN_CAN_PRODUCE: {
    ordinal: 2,
    label: 'Can Brain currently produce that output?',
    task: 'Connect the capability this task names, or say which capability it actually needs.',
    supportsBrainWhen: 'YES',
  },
  BRAIN_IS_FASTER: {
    ordinal: 3,
    label: 'Can Brain produce it faster?',
    task: 'Measure both, or record that nothing has been measured. Do not estimate.',
    supportsBrainWhen: 'YES',
  },
  BRAIN_IS_CHEAPER: {
    ordinal: 4,
    label: 'Can Brain produce it cheaper?',
    task: 'Establish what the human path costs per output, from a rate a source publishes.',
    supportsBrainWhen: 'YES',
  },
  BRAIN_QUALITY_AT_LEAST_EQUAL: {
    ordinal: 5,
    label: 'Can Brain produce it at equal or higher quality?',
    task: 'Compare real outputs from both paths, or say plainly that nobody has.',
    supportsBrainWhen: 'YES',
  },
  BRAIN_CAN_SELF_VERIFY: {
    ordinal: 6,
    label: 'Can Brain verify its own output sufficiently?',
    task: 'Say what a correct output looks like and whether Brain can check it against that.',
    supportsBrainWhen: 'YES',
  },
  INDEPENDENT_VERIFICATION_AVAILABLE: {
    ordinal: 7,
    label: 'Can another Brain or agent independently verify the output?',
    task: 'Register a healthy execution surface, so a second session exists to check the first.',
    supportsBrainWhen: 'YES',
  },
  REQUIRES_PHYSICAL_PRESENCE: {
    ordinal: 8,
    label: 'Does execution require physical presence?',
    task: 'Establish from a published source whether the work can be performed remotely.',
    supportsBrainWhen: 'NO',
  },
  REQUIRES_LICENSED_HUMAN: {
    ordinal: 9,
    label: 'Does it require a licence, certification, signature or accountable human review?',
    task: 'Establish from the regulator, statute or contract whether a person must sign.',
    supportsBrainWhen: 'NO',
  },
  HUMAN_INTERACTION_ADDS_VALUE: {
    ordinal: 10,
    label: 'Does human interaction itself materially contribute to the outcome?',
    task: 'Establish whether the buying, trust or negotiation here turns on a person.',
    supportsBrainWhen: 'NO',
  },
  HANDLES_ONLY_EXCEPTIONS: {
    ordinal: 11,
    label: 'Is the person handling only exceptions rather than normal production?',
    task: 'Count what actually reaches the person against what Brain completes.',
    supportsBrainWhen: 'NO',
  },
});

/**
 * The questions that can stop a task being Brain's, and nothing else.
 *
 * Speed and cost are absent on purpose — see `advantage`. Verification is
 * absent because it is a *disjunction* of two questions rather than either of
 * them, and is checked separately below: the brief asks whether Brain can
 * verify itself **or** another agent can, and demanding both would refuse
 * tasks the brief permits.
 */
const GATING: readonly AnyQuestion[] = Object.freeze([
  'BRAIN_CAN_PRODUCE',
  'BRAIN_QUALITY_AT_LEAST_EQUAL',
  'REQUIRES_PHYSICAL_PRESENCE',
  'REQUIRES_LICENSED_HUMAN',
  'HUMAN_INTERACTION_ADDS_VALUE',
]);

/**
 * Which reason a positively-answered question establishes, strongest first.
 *
 * Order is not cosmetic. A task that is both physically performed and legally
 * signed for is reported as `ACCOUNTABILITY_LICENSING`, because that is the
 * constraint no amount of capability removes — and a reader who acted on the
 * weaker one would go looking for a robot.
 */
const ESTABLISHES = Object.freeze([
  { question: 'REQUIRES_LICENSED_HUMAN', reason: 'ACCOUNTABILITY_LICENSING' },
  { question: 'REQUIRES_PHYSICAL_PRESENCE', reason: 'PHYSICAL_EXECUTION' },
  { question: 'HUMAN_INTERACTION_ADDS_VALUE', reason: 'HUMAN_INTERFACE' },
  { question: 'HANDLES_ONLY_EXCEPTIONS', reason: 'EXCEPTION_HANDLING' },
] as const) satisfies readonly { question: AnyQuestion; reason: HumanNecessityReason }[];

/**
 * Read the test for one task.
 *
 * `answers` is passed rather than fetched so a caller reading a whole project
 * makes one query rather than one per task, and so the derived half can be
 * read once for the fleet. Both readings are still *readings*: nothing here
 * caches, and the capability is asked per task because two tasks can name two
 * different capabilities.
 */
export async function assessTask(input: {
  task: LaborTask;
  answers: readonly LaborNecessityAnswer[];
  /**
   * Whether a second authenticated session exists to check the first.
   *
   * Passed in because it is a property of the fleet rather than of the task,
   * and reading it once per task would be the same query as many times as
   * there are tasks. `null` means the reading could not be taken at all, which
   * is `UNKNOWN` rather than `NO` — invariant 39 at the one question whose
   * failure is hardest to notice.
   */
  independentVerification: boolean | null;
}): Promise<NecessityReading> {
  const capability = input.task.capabilityId
    ? await readCapability(input.task.capabilityId)
    : null;

  const live = new Map<NecessityQuestion, LaborNecessityAnswer>();
  for (const one of input.answers) {
    if (one.taskId !== input.task.id || one.supersededAt !== null) continue;
    live.set(one.question, one);
  }

  const questions: QuestionReading[] = [];

  questions.push(deriveCanProduce(input.task, capability));
  questions.push(deriveVerification(input.independentVerification));
  for (const question of Object.keys(META) as AnyQuestion[]) {
    if (question === 'BRAIN_CAN_PRODUCE' || question === 'INDEPENDENT_VERIFICATION_AVAILABLE') {
      continue;
    }
    questions.push(fromRow(question as NecessityQuestion, live.get(question as NecessityQuestion)));
  }
  questions.sort((a, b) => a.ordinal - b.ordinal);

  const byQuestion = new Map(questions.map((one) => [one.question, one]));
  const answerOf = (question: AnyQuestion): NecessityAnswer =>
    byQuestion.get(question)?.answer ?? 'UNKNOWN';

  /*
   * A reason is established by an answer, never by an absence.
   *
   * This is the asymmetry the whole module turns on. A YES to "does this need
   * a licence" establishes that a person is required; the *absence* of an
   * answer establishes nothing at all, and in particular does not establish
   * that no licence is needed. So an unanswered question can never produce
   * `HUMAN_REQUIRED` and can never produce `BRAIN_DEFENSIBLE` either.
   */
  const established = ESTABLISHES.find((one) => answerOf(one.question) === 'YES') ?? null;

  const verified =
    answerOf('BRAIN_CAN_SELF_VERIFY') === 'YES' ||
    answerOf('INDEPENDENT_VERIFICATION_AVAILABLE') === 'YES';

  const blockers = blockersFor({ capability, answerOf, verified });

  const gatingSatisfied = GATING.every((question) => {
    const reading = byQuestion.get(question);
    return reading ? reading.answer === reading.supportsBrainWhen : false;
  });

  let verdict: NecessityVerdict;
  if (established) verdict = 'HUMAN_REQUIRED';
  else if (gatingSatisfied && verified) verdict = 'BRAIN_DEFENSIBLE';
  else verdict = 'NOT_ESTABLISHED';

  const advantage: NecessityReading['advantage'] =
    answerOf('BRAIN_IS_FASTER') === 'YES' && answerOf('BRAIN_IS_CHEAPER') === 'YES'
      ? 'ESTABLISHED'
      : 'NOT_ESTABLISHED';

  return {
    taskId: input.task.id,
    verdict,
    reason: established?.reason ?? null,
    questions,
    blockers: verdict === 'BRAIN_DEFENSIBLE' ? [] : blockers,
    advantage,
    capability,
    summary: summarize({
      task: input.task,
      verdict,
      reason: established?.reason ?? null,
      blockers,
      advantage,
    }),
  };
}

function deriveCanProduce(task: LaborTask, capability: CapabilityReading | null): QuestionReading {
  const meta = META['BRAIN_CAN_PRODUCE'];
  if (!capability) {
    /*
     * A seeded task names no capability, so there is nothing to read.
     *
     * `UNKNOWN` rather than `NO`: nobody said Brain cannot produce this, they
     * said which capability it needs is not recorded. The two have opposite
     * remedies, and §30 records what collapsing them costs.
     */
    return {
      question: 'BRAIN_CAN_PRODUCE',
      ordinal: meta.ordinal,
      label: meta.label,
      answer: 'UNKNOWN',
      basis: 'NOT_ASKED',
      statement:
        `Nothing says which capability producing "${task.output}" would need, so nothing was ` +
        'checked and nothing is claimed about whether Brain can.',
      task: 'Name the capability this task needs, from the ones Brain has a word for.',
      supportsBrainWhen: meta.supportsBrainWhen,
      sourceClaimId: null,
    };
  }
  if (capability.state === 'PRESENT') {
    return {
      question: 'BRAIN_CAN_PRODUCE',
      ordinal: meta.ordinal,
      label: meta.label,
      answer: 'YES',
      basis: 'DERIVED',
      statement: `${capability.id} reads PRESENT right now, from rows rather than from a label.`,
      task: meta.task,
      supportsBrainWhen: meta.supportsBrainWhen,
      sourceClaimId: null,
    };
  }
  if (capability.state === 'MISSING') {
    return {
      question: 'BRAIN_CAN_PRODUCE',
      ordinal: meta.ordinal,
      label: meta.label,
      answer: 'NO',
      basis: 'DERIVED',
      statement:
        `${capability.id} reads MISSING. ` +
        (capability.definition?.requires ?? 'There is no integration of that kind here.'),
      task: capability.definition?.nextStep ?? meta.task,
      supportsBrainWhen: meta.supportsBrainWhen,
      sourceClaimId: null,
    };
  }
  return {
    question: 'BRAIN_CAN_PRODUCE',
    ordinal: meta.ordinal,
    label: meta.label,
    answer: 'UNKNOWN',
    basis: 'DERIVED',
    statement:
      `Brain has no word for "${capability.id}", so nothing was checked. That is not the same ` +
      'fact as this being something Brain cannot do.',
    task: 'Name the capability from the ones Brain understands, or describe what it has to do.',
    supportsBrainWhen: meta.supportsBrainWhen,
    sourceClaimId: null,
  };
}

function deriveVerification(available: boolean | null): QuestionReading {
  const meta = META['INDEPENDENT_VERIFICATION_AVAILABLE'];
  if (available === null) {
    return {
      question: 'INDEPENDENT_VERIFICATION_AVAILABLE',
      ordinal: meta.ordinal,
      label: meta.label,
      answer: 'UNKNOWN',
      basis: 'DERIVED',
      statement:
        'The fleet could not be read, so whether a second session exists to check the first is ' +
        'unknown rather than absent.',
      task: meta.task,
      supportsBrainWhen: meta.supportsBrainWhen,
      sourceClaimId: null,
    };
  }
  return {
    question: 'INDEPENDENT_VERIFICATION_AVAILABLE',
    ordinal: meta.ordinal,
    label: meta.label,
    answer: available ? 'YES' : 'NO',
    basis: 'DERIVED',
    statement: available
      ? 'The fleet holds at least one healthy execution surface, so a second authenticated ' +
        'session can check what a first one produced.'
      : 'No healthy execution surface is registered, so there is nothing to check a first ' +
        'session with.',
    task: meta.task,
    supportsBrainWhen: meta.supportsBrainWhen,
    sourceClaimId: null,
  };
}

function fromRow(
  question: NecessityQuestion,
  row: LaborNecessityAnswer | undefined,
): QuestionReading {
  const meta = META[question];
  if (!row) {
    return {
      question,
      ordinal: meta.ordinal,
      label: meta.label,
      answer: 'UNKNOWN',
      basis: 'NOT_ASKED',
      statement: 'Nobody has answered this.',
      task: meta.task,
      supportsBrainWhen: meta.supportsBrainWhen,
      sourceClaimId: null,
    };
  }
  return {
    question,
    ordinal: meta.ordinal,
    label: meta.label,
    answer: row.answer,
    basis: row.basis,
    statement: row.statement,
    task: meta.task,
    supportsBrainWhen: meta.supportsBrainWhen,
    sourceClaimId: row.sourceClaimId,
  };
}

/**
 * What each establishing question puts between this task and Brain.
 *
 * A `Record` over `ESTABLISHES`' own questions, so the set is total by
 * construction. See the loop in `blockersFor` for what the un-total version
 * cost.
 */
const ESTABLISHED_BLOCKER: Readonly<
  Record<(typeof ESTABLISHES)[number]['question'], { kind: LaborBlockerKind; statement: string; remedy: string }>
> = Object.freeze({
  REQUIRES_LICENSED_HUMAN: {
    kind: 'LEGAL_ACCOUNTABILITY',
    statement: 'A person must hold the licence, sign, or be accountable for this output.',
    remedy:
      'Brain performs everything beneath that boundary and the accountable person receives ' +
      'the smallest possible decision, rather than the raw work.',
  },
  REQUIRES_PHYSICAL_PRESENCE: {
    kind: 'PHYSICAL_PRESENCE',
    statement: 'The work requires physical interaction with the world.',
    remedy:
      'Brain plans, schedules, coordinates and verifies around it; the irreducibly physical ' +
      'part stays with an operator.',
  },
  HUMAN_INTERACTION_ADDS_VALUE: {
    kind: 'RELATIONSHIP_VALUE',
    statement: 'The interaction itself is part of what is being bought.',
    remedy:
      'Brain prepares, prioritizes, researches and follows up so the person spends their ' +
      'time only on the interaction.',
  },
  HANDLES_ONLY_EXCEPTIONS: {
    kind: 'EXCEPTION_ONLY',
    statement:
      'A person is reached only for the cases the ordinary path does not cover, so the role ' +
      'that remains is the exceptions rather than the work.',
    remedy:
      'Brain handles the ordinary path and narrows what counts as an exception; every case it ' +
      'learns to settle is one the person no longer sees.',
  },
});

/**
 * Everything currently standing between this task and Brain, strongest first.
 *
 * A list rather than one value, because §13's *bottlenecks* reading needs to
 * group by what is actually holding work and a task held by two things is held
 * by two things. The frontier then reads the tail: a task with exactly one
 * blocker left is one remedy from moving.
 */
function blockersFor(input: {
  capability: CapabilityReading | null;
  answerOf: (question: AnyQuestion) => NecessityAnswer;
  verified: boolean;
}): LaborBlocker[] {
  const out: LaborBlocker[] = [];
  const { answerOf } = input;

  /*
   * Every question that can establish a human role reports one, and that is a
   * table rather than a sequence of `if`s.
   *
   * It was a sequence of `if`s, and three of the four were written.
   * `HANDLES_ONLY_EXCEPTIONS` establishes `EXCEPTION_HANDLING` in `ESTABLISHES`
   * above and had no branch here, so a task whose only positive answer was that
   * one came back `HUMAN_REQUIRED` **with an empty blocker list** — a task that
   * needs a person, telling the frontier that nothing is in its way. That is
   * the most misleading output this module can produce and it came from the
   * state that looks healthiest.
   *
   * Keyed off `ESTABLISHES` so the two cannot drift: a reason added there with
   * no entry here is a compile error rather than a silent gap, which is the
   * only version of this that stays true.
   */
  for (const { question } of ESTABLISHES) {
    if (answerOf(question) !== 'YES') continue;
    out.push({ ...ESTABLISHED_BLOCKER[question], capabilityId: null });
  }

  if (input.capability?.state === 'MISSING') {
    out.push({
      kind: 'CAPABILITY_MISSING',
      statement: `${input.capability.id} is not connected to this Brain.`,
      remedy: input.capability.definition?.nextStep ?? 'Connect an integration of that kind.',
      capabilityId: input.capability.id,
    });
  } else if (input.capability?.state === 'UNKNOWN') {
    out.push({
      kind: 'CAPABILITY_UNKNOWN',
      statement: `Brain has no word for "${input.capability.id}", so nothing was checked.`,
      remedy: 'Name the capability from the ones Brain understands, or describe what it must do.',
      capabilityId: input.capability.id,
    });
  } else if (!input.capability) {
    out.push({
      kind: 'CAPABILITY_UNKNOWN',
      statement: 'This task names no capability, so whether Brain can produce it was not checked.',
      remedy: 'Name the capability producing this output would need.',
      capabilityId: null,
    });
  }

  if (answerOf('BRAIN_QUALITY_AT_LEAST_EQUAL') !== 'YES') {
    out.push({
      kind: 'QUALITY_UNPROVEN',
      statement:
        answerOf('BRAIN_QUALITY_AT_LEAST_EQUAL') === 'NO'
          ? 'Brain has been compared here and does not reach the quality the human path does.'
          : 'Nothing establishes that Brain reaches the quality the human path does.',
      remedy: META['BRAIN_QUALITY_AT_LEAST_EQUAL'].task,
      capabilityId: null,
    });
  }

  if (!input.verified) {
    out.push({
      kind: 'VERIFICATION_INSUFFICIENT',
      statement:
        'Neither Brain checking its own output nor a second session checking it is established.',
      remedy:
        'Either say what a correct output looks like so Brain can check against it, or register ' +
        'a healthy execution surface so a second session exists.',
      capabilityId: null,
    });
  }

  /*
   * A question that has to be a recorded `NO` and is not one.
   *
   * This exists because of what its absence made the frontier say. The three
   * human questions gate the verdict, so a task with the capability present,
   * the quality answered, verification satisfied and one of them left
   * `UNKNOWN` is correctly `NOT_ESTABLISHED` — and produced **no blockers at
   * all**, which `automationFrontier` orders by and a reader takes as *ready
   * to move now*. The most misleading output this module can produce, from the
   * one state that looks healthiest.
   *
   * So the invariant is restored and is worth stating: the list is empty
   * **exactly** when the verdict is `BRAIN_DEFENSIBLE`. A question answered
   * `YES` is not listed here, because it has already pushed the blocker that
   * says what it established.
   */
  const unanswered = (
    [
      'REQUIRES_LICENSED_HUMAN',
      'REQUIRES_PHYSICAL_PRESENCE',
      'HUMAN_INTERACTION_ADDS_VALUE',
    ] as const
  ).filter((question) => answerOf(question) === 'UNKNOWN');
  if (unanswered.length > 0) {
    out.push({
      kind: 'NECESSITY_UNANSWERED',
      statement:
        `Nothing answers ${unanswered.map((one) => META[one].label).join(' ')} — and an ` +
        'unanswered question is not a no.',
      remedy:
        'Establish from a published source whether a rule requires a person here, or say ' +
        'plainly that the places such a rule would be published were searched and held none.',
      capabilityId: null,
    });
  }

  return out;
}

function summarize(input: {
  task: LaborTask;
  verdict: NecessityVerdict;
  reason: HumanNecessityReason | null;
  blockers: readonly LaborBlocker[];
  advantage: NecessityReading['advantage'];
}): string {
  if (input.verdict === 'HUMAN_REQUIRED') {
    return (
      `A person is established as necessary here, for ${describeReason(input.reason)}. Brain ` +
      'does everything beneath that boundary; what is left is the part only a person can do.'
    );
  }
  if (input.verdict === 'BRAIN_DEFENSIBLE') {
    return input.advantage === 'ESTABLISHED'
      ? 'Brain can produce this, at no worse quality, with the output checkable, and is ' +
          'established to be both faster and cheaper. Nothing here needs a person.'
      : 'Brain can produce this, at no worse quality, with the output checkable, and no reason ' +
          'for a person is established. Whether it is also faster or cheaper has not been ' +
          'measured, and that decides whether it is worth doing rather than whether it is ' +
          'allowed.';
  }
  const first = input.blockers[0];
  return first
    ? `Neither case is established yet. ${first.statement} ${first.remedy}`
    : 'Neither case is established yet, and nothing has been asked.';
}

function describeReason(reason: HumanNecessityReason | null): string {
  switch (reason) {
    case 'ACCOUNTABILITY_LICENSING':
      return 'a licence, signature or accountable review somebody must hold';
    case 'PHYSICAL_EXECUTION':
      return 'physical interaction with the world';
    case 'HUMAN_INTERFACE':
      return 'the interaction itself being part of what is bought';
    case 'EXCEPTION_HANDLING':
      return 'handling only what exceeds Brain’s thresholds';
    case 'EXPERT_JUDGMENT':
      return 'judgement beyond Brain’s verified capability';
    case 'OVERSIGHT_VERIFICATION':
      return 'independent oversight of a consequential output';
    default:
      return 'a reason nothing has recorded';
  }
}

/**
 * The fleet half of the test, read once for a whole project.
 *
 * Wrapped so an unreadable fleet is `null` — *we could not tell* — rather than
 * `false`, which would read as *we checked and there is nothing*. §30 records
 * what collapsing those two costs, and here the cheap collapse would be the
 * expensive one: a verification question answered `NO` by a failed query would
 * hold every task in the project short of Brain for a reason that was never
 * true.
 */
export async function independentVerificationAvailable(): Promise<boolean | null> {
  try {
    return (await separationCapacity()).surfaces >= 1;
  } catch {
    return null;
  }
}

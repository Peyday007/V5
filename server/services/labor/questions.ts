/**
 * The question each labor round actually asks.
 *
 * ---------------------------------------------------------------------------
 * The subject is the output, never the job title
 * ---------------------------------------------------------------------------
 *
 * "Can we automate the account manager" is unanswerable, and a worker asked it
 * would answer something. "Who is permitted to sign a closing statement in
 * Michigan" is answerable from a published source. So every question below is
 * composed from `labor_tasks.output` — the answer to the brief's own first
 * question, *what exact output is this producing* — with the workflow in front
 * of it for scope. A question composed from the task's name alone would be
 * §25's Westbrook defect arriving through a foreign key.
 *
 * ---------------------------------------------------------------------------
 * The template is fixed and the subject is what varies
 * ---------------------------------------------------------------------------
 *
 * `launch()` treats one specification as researchable once, so a question that
 * differed per project for the same task would relaunch work already done.
 *
 * ---------------------------------------------------------------------------
 * Nothing here asks a model what it thinks
 * ---------------------------------------------------------------------------
 *
 * Every one of the three asks what a *published source* establishes, and the
 * declarations they ask for come from closed sets. A question that asked "do
 * you think a person is needed for this" would put a model's opinion into the
 * row that decides whether somebody is employed, which is §8 at the highest
 * stake this codebase has.
 */
import { HUMAN_NECESSITY_REASONS, LABOR_CHANNELS, RATE_BASES } from '../../domain/types.ts';

export interface QuestionSubject {
  /** The workflow's name, for scope. */
  workflow: string;
  /** The task's name. */
  task: string;
  /** What it produces — the thing every question is actually about. */
  output: string;
}

export function necessityTitle(subject: QuestionSubject): string {
  return `Who is permitted to produce ${clip(subject.output, 60)}`;
}

/**
 * What published rule requires a person, and which of six reasons it is.
 *
 * The declaration asked for is `HUMAN_REQUIREMENT` with a subject from the six
 * classes, because that is what makes an answer usable: a paragraph saying a
 * notary must be present is evidence, and only the declaration puts it where
 * `necessity.ts` reads it. §33 records the alternative — a bridge that matched
 * prose against a literal and could never fire.
 *
 * A negative is asked for explicitly and is worth as much as a positive. §14
 * is the standard: a claim that no rule exists is established by a documented
 * search of the places it would be, or not at all — and the *absence* of a
 * licensing requirement is exactly the fact that lets a role be compressed.
 */
export function necessityQuestion(input: {
  subject: QuestionSubject;
  context: string;
  round: number;
}): string {
  const parts = [
    `What do published rules and documented practice say about who may produce ` +
      `${clip(input.subject.output, 200)}, as it is produced in ${input.subject.workflow}: is a ` +
      'licence, certification, registration, signature or accountable human review required by ' +
      'a statute, regulator, buyer’s own terms or platform terms; must any part of it be ' +
      'performed in person; and is there published evidence that the interaction with a person ' +
      'is itself part of what the buyer is paying for?',
    input.context,
    `Declare each requirement you establish with labor_finding set to HUMAN_REQUIREMENT and ` +
      `labor_subject set to which of these it is: ${HUMAN_NECESSITY_REASONS.join(', ')}. A ` +
      'requirement described in prose and not declared answers nothing.',
    'Where you searched the places such a rule would be published and found none, say so as a ' +
      'negative claim naming what you searched. That is not a lesser result: an established ' +
      'absence is what lets this stop needing a person, and an undocumented silence is not.',
  ];
  if (input.round > 1) {
    parts.push(
      `This is asking again — report what has been published, amended or withdrawn since, and ` +
        'say so plainly where nothing has.',
    );
  }
  return parts.join(' ');
}

export function marketTitle(subject: QuestionSubject): string {
  return `Where ${clip(subject.output, 60)} is actually sourced, and at what published rate`;
}

/**
 * §4, as a question about published rates rather than about a hiring plan.
 *
 * Brain proposes no headcount and this question asks for none. What it asks
 * for is what a source publishes: this capability is obtained this way, in
 * this place, at this rate, on this basis. The decision about which to use is
 * a person's, and the brief's own list of things to weigh — supervision
 * burden, turnover, timezone, data restrictions — is asked for as evidence
 * rather than scored.
 */
export function marketQuestion(input: {
  subject: QuestionSubject;
  context: string;
  round: number;
}): string {
  const parts = [
    `How is the capability to produce ${clip(input.subject.output, 200)} actually obtained, and ` +
      'at what published cost: which channels supply it — contractors, employees, specialist ' +
      'freelancers, licensed professionals, fractional specialists, on-demand operators, ' +
      'agencies, managed services or software — in which jurisdictions, at which published ' +
      'rates, and on what basis is each rate quoted?',
    input.context,
    `Declare each one with labor_finding set to SOURCING_CHANNEL and labor_subject set to one ` +
      `of: ${LABOR_CHANNELS.join(', ')}.`,
    `Where a source publishes a rate, set labor_rate_cents in minor units and labor_qualifier ` +
      `to one of ${RATE_BASES.join(', ')}. Where none does, submit the channel with neither — ` +
      'an unknown rate is recorded as unknown, and it is never read as cheap.',
    'Report what published sources say about the things that decide total cost rather than ' +
      'headline rate: supervision burden, turnover, rework, timezone, communication, and any ' +
      'regulatory or data-access restriction on who may do this work from where. A figure is ' +
      'read from a source and never produced.',
  ];
  if (input.round > 1) {
    parts.push('This is asking again — report what rates and restrictions have changed since.');
  }
  return parts.join(' ');
}

export function precedentTitle(subject: QuestionSubject): string {
  return `Whether ${clip(subject.output, 60)} is published as being produced without a person`;
}

/**
 * §7 and §12: has somebody already published doing this without a person?
 *
 * Deliberately the narrowest of the three. It asks for documented instances
 * and for what those instances say about quality and verification, because a
 * precedent with no stated verification is not evidence that the output was
 * any good — and this kernel's `QUALITY_UNPROVEN` blocker is exactly the one a
 * precedent is being asked to move.
 */
export function precedentQuestion(input: {
  subject: QuestionSubject;
  context: string;
  round: number;
}): string {
  const parts = [
    `Is there published evidence of ${clip(input.subject.output, 200)} being produced without a ` +
      'person — by software, by an automated service, or by a tool a buyer accepts — and where ' +
      'there is, what do those sources say about how the output was checked, what quality it ' +
      'reached, and what remained for a person to do?',
    input.context,
    'Declare each one with labor_finding set to SOURCING_CHANNEL and labor_subject set to ' +
      'SOFTWARE_TOOL or MANAGED_SERVICE, with its published price where a source states one. ' +
      'A tool that does this work is a way of obtaining the capability, which is the same row ' +
      'a contractor doing it would produce — what differs is the question, not the finding.',
    'A vendor claiming its own product does this is conclusive about what the vendor says and ' +
      'worth nothing as independent confirmation. Say which it is. A precedent that does not ' +
      'say how the output was verified is reported as such rather than as evidence of quality.',
  ];
  if (input.round > 1) {
    parts.push('This is asking again — report what has been published since.');
  }
  return parts.join(' ');
}

/**
 * The sentence that says which operation this is for, composed by the caller
 * and carried as *context* rather than as scope.
 *
 * It says which findings are worth reporting and it can widen nothing: the
 * envelope, the evidence gate and the source classes are all the compiler's.
 */
export function contextFor(input: { workflow: string }): string {
  return (
    `This is for deciding who or what should produce one step of ${input.workflow}. Brain is ` +
    'the default producer and a person is an escalation, so what is worth reporting is ' +
    'whatever a published source actually establishes — including that it establishes nothing.'
  );
}

function clip(text: string, max: number): string {
  const tidy = text.replace(/\s+/g, ' ').trim();
  if (tidy.length <= max) return tidy;
  const cut = tidy.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

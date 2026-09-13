/**
 * Which project a change request is *about*, and when Brain must ask instead.
 *
 * ---------------------------------------------------------------------------
 * The defect this exists to prevent
 * ---------------------------------------------------------------------------
 *
 * A software request is filed against the conversation's attached project, and
 * that project decides which repository and which directories the work may
 * touch. So a request filed against the wrong project is a change authorized
 * for the wrong code — and it would look completely healthy the whole way: a
 * card with a real scope sentence on it, a person authorizing it, a campaign
 * running, and a worker doing exactly what the contract said in a repository
 * nobody meant.
 *
 * §25 has this defect written down one altitude away. The compiler read a
 * jurisdiction out of a question's prose and fell back to the envelope's when it
 * found none, so a record whose own column said `state: "OH"` compiled as
 * *"…from official Michigan public records, … in Westbrook, OH"*. Every row
 * around it was healthy and the mission ran. **The wrong answer confidently
 * derived is worse than no answer**, and nothing below the compiler could catch
 * it, because the scope was the thing that was wrong.
 *
 * ---------------------------------------------------------------------------
 * Three rules, and they are `jurisdiction.ts`'s
 * ---------------------------------------------------------------------------
 *
 * **A row outranks prose.** The conversation's `project_id` is a row somebody or
 * something decided; the site named in a sentence is a paraphrase. When they
 * agree there is nothing to do. When only the row exists, the row wins.
 *
 * **Disagreement is refused, never chosen between.** A message that names V4 in
 * a thread attached to Deal Dispatch is genuinely ambiguous: the person may have
 * changed subject, or may be mentioning V4 in passing. Picking either reading
 * silently is the Westbrook defect. So nothing is captured and the answer says
 * what is ambiguous — which is the one case where asking is cheaper than being
 * wrong.
 *
 * **Not knowing is an answer.** A thread with no project attached cannot resolve
 * a repository at all, so the request has nowhere to be filed. That is
 * `ASK_WHICH_PROJECT`, which already exists.
 *
 * ---------------------------------------------------------------------------
 * What this is not
 * ---------------------------------------------------------------------------
 *
 * It is **not** a way for a message to *retarget* itself. Naming another project
 * never files the request there, however unambiguous the sentence looks: the
 * conversation's attachment is a row with its own provenance
 * (`attachment_source`), and a sentence is not. All a name can do here is stop a
 * capture that would otherwise have gone somewhere the person may not have
 * meant. It can refuse and it cannot redirect, which is the same shape
 * `capture`'s `duplicateOf` has — a claim that only ever narrows what happens.
 *
 * And it reads project **rows**, never a hard-coded list of site names. A
 * project renamed tomorrow is matched tomorrow, and a project this person may
 * not read is not matched at all.
 */
import { listProjects } from '../../repos/projects.ts';
import { decideProjectAccess } from '../identity/policy.ts';
import { NEGATORS, clauseBefore } from './negation.ts';
import type { Principal, Project } from '../../domain/types.ts';

/**
 * A name worth matching on.
 *
 * Two characters is not a name — it is an initial, a preposition or a typo, and
 * matching on one would make every message about "V2" of anything a
 * disagreement. Long enough to be deliberate, short enough that `V4` and `V5`
 * still count, which is exactly the shape the owner's own sites have.
 */
const MIN_NAME = 2;

/** Where in the text a project's name appears, and how it appears there. */
interface Mention {
  at: number;
  /** A negator governs it: "do not change Brain". */
  excluded: boolean;
  /** A preposition of place governs it: "…in V4", "on V4", "for V4". */
  destination: boolean;
}

/**
 * Prepositions that make a named project the *place* a change goes.
 *
 * Narrow on purpose: `in`, `on`, `for`, `to`, `inside`, `within`, optionally
 * through an article. "…the broken form in V4" names a destination; "V4 is
 * slow" names a subject and decides nothing about where work belongs.
 */
const DESTINATION_LEAD = String.raw`\b(?:in|on|for|to|inside|within|over\s+(?:in|on))\s+(?:the\s+)?$`;

/**
 * What rules a project *out*, which is a wider list than what negates a verb.
 *
 * Everything the gate treats as a negator, plus the forms that only ever appear
 * about a thing rather than an action: bare `not`, `except`, `other than`,
 * `apart from`, `leave`. The asymmetry is deliberate and safe in one direction
 * only — an exclusion can never *choose* a project, so a false one costs a
 * question, while a missed one would file work against something somebody said
 * not to touch.
 */
const EXCLUSION = new RegExp(
  `${NEGATORS.source}|` + String.raw`\b(?:not|except|other than|apart from|besides|leave)\b`,
  'i',
);

function escape(name: string): string {
  return name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every place a name appears, with the two facts about each appearance. */
function mentionsOf(text: string, name: string): Mention[] {
  const trimmed = name.trim();
  if (trimmed.length < MIN_NAME) return [];
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}])(${escape(trimmed)})([^\\p{L}\\p{N}]|$)`,
    'giu',
  );
  const found: Mention[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const at = match.index + (match[1]?.length ?? 0);
    const before = clauseBefore(text, at);
    found.push({
      at,
      excluded: EXCLUSION.test(before),
      destination: new RegExp(DESTINATION_LEAD, 'i').test(before),
    });
  }
  return found;
}

/** Word-boundary match, case-insensitive, on a literal name. */
function mentions(text: string, name: string): boolean {
  return mentionsOf(text, name).length > 0;
}

/** A project this message names, with what the message said about it. */
interface Named {
  id: string;
  name: string;
  /** Every appearance is governed by a negator: the person ruled it out. */
  excluded: boolean;
  /** At least one appearance is a destination: the person said where. */
  destination: boolean;
}

function namedIn(text: string, project: Project): Named | null {
  const found = [...mentionsOf(text, project.name), ...mentionsOf(text, project.slug)];
  if (found.length === 0) return null;
  return {
    id: project.id,
    name: project.name,
    /*
     * Excluded only if *every* appearance is negated. "Do not change Brain, and
     * then change Brain's header" is contradictory rather than an exclusion, and
     * treating one negated mention as a veto over a later plain one would let
     * the earlier half of a sentence silence the later half — the same defect
     * the gate's per-occurrence negation exists to prevent.
     */
    excluded: found.every((mention) => mention.excluded),
    destination: found.some((mention) => mention.destination && !mention.excluded),
  };
}

export type TargetDecision =
  /** The thread's project, or the one destination left once it was ruled out. */
  | { kind: 'RESOLVED'; projectId: string }
  /** No project on the thread: there is nowhere to file this. */
  | { kind: 'NO_PROJECT'; answer: string }
  /** The thread's project was ruled out and nothing else was named. */
  | {
      kind: 'EXCLUDED';
      answer: string;
      named: { id: string; name: string }[];
      choices: { id: string; name: string }[];
      /** Ruled out by the request, and still ruled out by any answer to it. */
      excluded: { id: string; name: string }[];
    }
  /** The message names a different project this person can read. */
  | {
      kind: 'AMBIGUOUS';
      answer: string;
      named: { id: string; name: string }[];
      /**
       * Everything a one-word reply may name.
       *
       * `named` is what the *message* named besides the thread's project, and
       * it is what the question quotes back. `choices` is what an **answer** may
       * be, which has to include the thread's own project: the question is
       * "which of these two", and a list that omitted one of them would refuse
       * half the honest answers.
       */
      choices: { id: string; name: string }[];
      /** Ruled out by the request, and still ruled out by any answer to it. */
      excluded: { id: string; name: string }[];
    };

/**
 * Resolve the project a change request should be filed against.
 *
 * `principal` is not decoration, for the same reason `validateProposal` has no
 * overload without one: a project name is only a disagreement if this person can
 * actually see that project. Matching one they cannot read would both leak that
 * it exists and block a capture on the strength of it.
 */
export async function resolveSoftwareTarget(input: {
  principal: Principal;
  /** The project the conversation is attached to, if any. */
  attachedProjectId: string | null;
  /** The person's own words. */
  askedText: string;
}): Promise<TargetDecision> {
  const { principal, attachedProjectId, askedText } = input;

  if (!attachedProjectId) {
    return {
      kind: 'NO_PROJECT',
      answer:
        'I can have this built, but I need to know which project it belongs to first — that is ' +
        'what decides which repository it may change. Tell me the site and I will write it down ' +
        'for you to authorize.',
    };
  }

  let readable: Project[];
  try {
    readable = (await listProjects()).filter(
      (project) => decideProjectAccess(principal, project.id, 'READ').allowed,
    );
  } catch {
    /*
     * A reading this cannot take is not a disagreement.
     *
     * Failing closed here would mean refusing every capture whenever the project
     * list is briefly unavailable, which turns a transient into a product that
     * declines to work. The row the request is filed against is still the
     * conversation's own attachment, which is the authorization that matters;
     * this check only ever *adds* a refusal, so losing it loses a clarification
     * rather than a control.
     */
    return { kind: 'RESOLVED', projectId: attachedProjectId };
  }

  const attached = readable.find((project) => project.id === attachedProjectId) ?? null;
  const named = readable
    .map((project) => namedIn(askedText, project))
    .filter((entry): entry is Named => entry !== null);

  const attachedNamed = named.find((entry) => entry.id === attachedProjectId) ?? null;
  const others = named.filter((entry) => entry.id !== attachedProjectId && !entry.excluded);
  /*
   * Every project this message ruled out, the attached one included. It travels
   * with the question so that answering it cannot put one back — an exclusion
   * belongs to the request, not to the sentence that happened to carry it.
   */
  const ruledOut = named.filter((entry) => entry.excluded);

  /*
   * ---------------------------------------------------------------------------
   * A sentence can rule the row out. It still cannot replace it.
   * ---------------------------------------------------------------------------
   *
   * The row — the conversation's own attachment — is the default and stays the
   * default: naming another project alongside it is a *disagreement*, which is
   * refused rather than resolved, because the row has provenance and a sentence
   * does not. That is unchanged.
   *
   * What was wrong is that merely *mentioning* the attached project resolved to
   * it. In a Brain-attached thread, "Do not change Brain, but fix the broken
   * form in V4" mentioned Brain, so Brain won — and Brain is the one project the
   * person had explicitly ruled out. **The wrong answer confidently derived is
   * worse than no answer**, and this was the version of it that files work
   * against a project somebody said in the same breath not to touch.
   *
   * So an exclusion is read first, and it only ever *removes* a candidate. Once
   * the row is removed, the row is not the answer to fall back on, and the only
   * thing left is what the sentence said: exactly one readable project named as
   * a destination resolves; anything else is a question.
   */
  const attachedExcluded = attachedNamed?.excluded ?? false;

  if (attachedExcluded) {
    const destinations = others.filter((entry) => entry.destination);
    const candidates = destinations.length > 0 ? destinations : others;
    if (candidates.length === 1) {
      /*
       * Not a redirect on a whim: the person ruled the thread's project out in
       * the same sentence, so there is no row left to defer to, and they named
       * exactly one place the work goes. Refusing here would be asking somebody
       * to repeat what they just said.
       */
      return { kind: 'RESOLVED', projectId: candidates[0]!.id };
    }
    return {
      kind: 'EXCLUDED',
      named: candidates.map((entry) => ({ id: entry.id, name: entry.name })),
      /*
       * Deliberately not including the excluded project. "Never produce a
       * proposal for the project I said not to change" has to survive the
       * answer as well as the question — and an empty list means any readable
       * project may answer, which is right when the person named none.
       */
      choices: candidates.map((entry) => ({ id: entry.id, name: entry.name })),
      excluded: ruledOut.map((entry) => ({ id: entry.id, name: entry.name })),
      answer:
        `You have said not to change ${attachedNamed?.name ?? 'this project'}, and I have not ` +
        'written anything down. ' +
        (candidates.length === 0
          ? 'Which project should the change be made in instead?'
          : `Which should it be — ${listOf(candidates.map((entry) => entry.name))}?`),
    };
  }

  // Nothing else named, or the thread's own project named too — no ambiguity.
  if (others.length === 0) return { kind: 'RESOLVED', projectId: attachedProjectId };
  if (attachedNamed) return { kind: 'RESOLVED', projectId: attachedProjectId };

  return {
    kind: 'AMBIGUOUS',
    named: others.map((entry) => ({ id: entry.id, name: entry.name })),
    choices: [
      ...(attached ? [{ id: attached.id, name: attached.name }] : []),
      ...others.map((entry) => ({ id: entry.id, name: entry.name })),
    ],
    excluded: ruledOut.map((entry) => ({ id: entry.id, name: entry.name })),
    answer:
      `This conversation is about ${attached?.name ?? 'another project'}, and you have named ` +
      `${listOf(others.map((entry) => entry.name))}. Which one should the change be made in? ` +
      'I have not written anything down yet: the project decides which repository and which ' +
      'directories the work may touch, so guessing it is the one mistake here that would look ' +
      'completely fine until the code changed.',
  };
}

/** "A", "A or B", "A, B or C" — composed here so no caller writes its own. */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

/**
 * Which project a short reply settles on, if it settles on one.
 *
 * ---------------------------------------------------------------------------
 * The defect this exists in its present form to prevent
 * ---------------------------------------------------------------------------
 *
 * Brain asked *"Brain or V4?"*, the person answered **"Not Brain"**, and Brain
 * chose **Brain** — because the reply *mentions* Brain and the reply was read
 * for mentions. That is the same defect the question itself was written to
 * correct (mentioning is not choosing), one message later, and worse: here the
 * person was answering a direct question and got the opposite of their answer.
 *
 * So a reply is read exactly as the original request is: every mention carries
 * whether a negator governs it, and an exclusion only ever *removes* a
 * candidate. Three rules, and the third is what stops the answer widening what
 * the question narrowed:
 *
 * 1. **An exclusion in the reply removes that project.** *"Not Brain"* leaves
 *    Brain out, whatever else the sentence does.
 * 2. **Exclusions from the original request are still in force.** They travel
 *    on the question as `excluded`, and are subtracted **before** the offered
 *    list is consulted — including when that list is empty. An empty list means
 *    *the question named no candidates*, never *anything goes*, and treating it
 *    as the second is how a project somebody ruled out comes back.
 * 3. **One remaining candidate is an answer; two are not.** A reply naming
 *    exactly one live project resolves it. A reply that only *rules something
 *    out* resolves only when exactly one candidate is left standing — otherwise
 *    the question stays open, because narrowing three to two is not choosing.
 */
export async function projectNamedInReply(input: {
  principal: Principal;
  replyText: string;
  /** When the question offered a list, only those may answer it. */
  choices?: readonly { id: string; name: string }[];
  /** Projects the original request ruled out. Never selectable, list or none. */
  excluded?: readonly { id: string; name: string }[];
}): Promise<{ id: string; name: string } | null> {
  const { principal, replyText, choices, excluded } = input;
  let readable: Project[];
  try {
    readable = (await listProjects()).filter(
      (project) => decideProjectAccess(principal, project.id, 'READ').allowed,
    );
  } catch {
    return null;
  }

  const ruledOut = new Set((excluded ?? []).map((one) => one.id));
  const named = readable
    .map((project) => namedIn(replyText, project))
    .filter((entry): entry is Named => entry !== null);
  for (const entry of named) {
    if (entry.excluded) ruledOut.add(entry.id);
  }

  /*
   * The candidates still standing. The offered list narrows; the exclusions
   * narrow again, and they are applied to whichever pool the question left —
   * so an empty offer cannot hand back a project the request ruled out.
   */
  const offered = choices && choices.length > 0 ? new Set(choices.map((one) => one.id)) : null;
  const live = readable.filter(
    (project) => !ruledOut.has(project.id) && (offered ? offered.has(project.id) : true),
  );

  const chosen = live.filter((project) =>
    named.some((entry) => entry.id === project.id && !entry.excluded),
  );
  if (chosen.length === 1) return { id: chosen[0]!.id, name: chosen[0]!.name };
  if (chosen.length > 1) return null;

  /*
   * Nothing was named positively. A reply that only excluded something still
   * answers the question when one candidate is left — *"not Brain"* against
   * *"Brain or V4?"* is V4, and asking again would be asking somebody to repeat
   * themselves. It requires an actual exclusion: without one, a pool that
   * happens to hold one project would make *"whichever you think"* an answer.
   */
  const excludedHere = named.some((entry) => entry.excluded);
  if (excludedHere && live.length === 1) return { id: live[0]!.id, name: live[0]!.name };
  return null;
}

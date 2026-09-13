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

/** Word-boundary match, case-insensitive, on a literal name. */
function mentions(text: string, name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < MIN_NAME) return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(text);
}

export type TargetDecision =
  /** The thread's project, and nothing in the message disagrees. */
  | { kind: 'RESOLVED'; projectId: string }
  /** No project on the thread: there is nowhere to file this. */
  | { kind: 'NO_PROJECT'; answer: string }
  /** The message names a different project this person can read. */
  | { kind: 'AMBIGUOUS'; answer: string; named: { id: string; name: string }[] };

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

  const attached = readable.find((project) => project.id === attachedProjectId);
  const named = readable.filter(
    (project) =>
      project.id !== attachedProjectId &&
      (mentions(askedText, project.name) || mentions(askedText, project.slug)),
  );

  // Nothing else named, or the thread's own project named too — no ambiguity.
  if (named.length === 0) return { kind: 'RESOLVED', projectId: attachedProjectId };
  if (attached && (mentions(askedText, attached.name) || mentions(askedText, attached.slug))) {
    return { kind: 'RESOLVED', projectId: attachedProjectId };
  }

  const names = named.map((project) => project.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
  return {
    kind: 'AMBIGUOUS',
    named: named.map((project) => ({ id: project.id, name: project.name })),
    answer:
      `This conversation is about ${attached?.name ?? 'another project'}, and you have named ` +
      `${list}. Which one should the change be made in? I have not written anything down yet: ` +
      'the project decides which repository and which directories the work may touch, so ' +
      'guessing it is the one mistake here that would look completely fine until the code changed.',
  };
}

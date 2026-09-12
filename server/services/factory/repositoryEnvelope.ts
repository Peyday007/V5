/**
 * Which repositories this factory may be pointed at, in code, named by id.
 *
 * The same shape and the same argument as `services/russell/probeEnvelope.ts`:
 * **nobody supplies the limits their own work is judged against.** A submission
 * names a repository and the server decides whether that is one of the ones a
 * person has already agreed the factory may touch. A list in a table would be a
 * list a caller with write access could extend; a list in code is a change
 * somebody reviews.
 *
 * It is not a security boundary on its own and must not be mistaken for one. A
 * worker's ability to push comes from the surface it runs on, and Brain holds no
 * credential for any repository here — so this cannot grant access, and removing
 * an entry cannot revoke it. What it does is narrower and still worth having: it
 * stops a campaign being *created* against a repository nobody authorized, which
 * is the point at which the decision is cheap and reversible.
 *
 * Every entry says what the factory may do there, because "authorized" is not one
 * fact. A repository the factory may open a pull request against is not the same
 * as one it may only read.
 */

/** What the factory is permitted to do in one repository. */
export interface RepositoryGrant {
  /** Stable id, so a campaign records which grant authorized it. */
  id: string;
  /** The remote, exactly as the forge spells it. */
  remote: string;
  /** A person's own words about what this repository is. Shown in the surface. */
  description: string;
  /** The branch a campaign pins against unless a submission names another. */
  defaultBranch: string;
  /** Paths a campaign here may never touch, whatever its contract says. */
  forbiddenPaths: string[];
  /** True when the factory may open or update a pull request here. */
  mayOpenPullRequest: boolean;
}

/**
 * The authorized set.
 *
 * `V5` is deliberately absent. The factory lives in it, and a campaign that could
 * rewrite the machinery executing it is a campaign whose failure mode is
 * unbounded — the one repository where a bad unit cannot be contained by
 * declining a pull request. It is authorized for the *bootstrap* campaign only,
 * which ran locally with a person watching every tick, and that is not this.
 */
export const REPOSITORY_GRANTS: readonly RepositoryGrant[] = [
  /*
   * The factory's own proving ground, and the shape every later entry copies.
   *
   * `brain-worker-bootstrap` is the minimal checkout an unattended Routine
   * attaches so it can use the connector without stopping for approval. Its own
   * README says what it is: no application code, no project data, no credentials,
   * no deployment configuration. That makes it the one repository in this account
   * where a bounded campaign can prove the whole chain — plan, implement,
   * integrate, review, repair — without anything a person depends on being in
   * range of a mistake.
   *
   * It is here so the factory is *demonstrable* rather than merely built, and it
   * is one line to remove. Authorizing the next real repository is this same
   * entry with a different remote: nothing else in the codebase changes, and the
   * three gates after it — a person onboarding it in Build, a surface registered
   * for that worker, and access granted where the worker runs — are all still
   * there.
   */
  {
    id: 'brain-worker-bootstrap',
    remote: 'https://github.com/Peyday007/brain-worker-bootstrap',
    description:
      'The minimal checkout unattended Routines mount for their connector permissions. ' +
      'No application code, no project data, no credentials.',
    defaultBranch: 'main',
    /*
     * The settings file is what every fired worker reads to know it may call the
     * connector without a prompt. A unit that owned it could take the whole fleet
     * out with a diff nobody would read as dangerous, so no unit may own it — the
     * campaign can still read it, and a test that checks it is exactly the kind of
     * change this repository is short of.
     */
    forbiddenPaths: ['.claude/**'],
    mayOpenPullRequest: true,
  },
];

/**
 * **One entry, and it is the factory's own proving ground.**
 *
 * `oakwood-site` was in it. The Oakwood Junk Removal site was revived for one
 * purpose — to be the target the hosted factory proved itself against — and that
 * proof is finished and kept: the campaigns, the commits, the pull request and
 * `docs/FACTORY-EXECUTION-PLANE-EVIDENCE.md` are all still there to read. What it
 * must not remain is a standing authorization, because a repository nobody is
 * working in is a repository nobody is watching, and the factory's own executor
 * must not be whichever target it last proved itself on.
 *
 * So the factory is intact, and what it may be pointed at is one repository that
 * holds nothing anybody depends on. `decideRepository` refuses every other remote,
 * which means no campaign can be created against one until somebody adds it here
 * in a reviewed change — the same shape §24 gives for the approval envelope:
 * nobody supplies the limits their own work is judged against.
 *
 * **Onboarding a repository is three things, and the grant is only the first.**
 * A grant here says the factory may be *pointed* at it; a `worker_routing` row
 * saying some worker may be handed `FACTORY` work for that repository id says who
 * may *execute* it; and the access itself is granted where that worker runs. Add a
 * grant alone and nothing can run it — which is the failure mode worth having,
 * because the alternative is a new repository silently inheriting the executor of
 * the last one.
 */
/**
 * Paths no unit may own in **any** repository, grant or no grant.
 *
 * These were per-grant, and that was a latent bug the empty envelope exposed
 * rather than caused: `forbiddenHere` was the grant's list or nothing, so a
 * repository with no grant forbade nothing, and the protection arrived only if
 * whoever onboarded the next repository remembered to copy it. A rule that has to
 * be remembered per repository is a rule that will be missing from one.
 *
 * A grant may still add to this; it may not subtract from it.
 */
export const UNIVERSAL_FORBIDDEN_PATHS: readonly string[] = [
  // The deployment pipeline. §28's rule is that one branch owns production, and a
  // unit that could edit the workflow enforcing it could edit its way around it.
  '.github/workflows/deploy*',
  // The repository's own history and hooks.
  '.git/**',
];

export const REPOSITORY_ENVELOPE_ID = 'factory-repositories-2026-09-11';

export interface GrantDecision {
  ok: boolean;
  grant: RepositoryGrant | null;
  reason: string | null;
}

/**
 * Is this repository one the factory may be pointed at?
 *
 * Compared on the normalised remote rather than on a name a caller chose, and a
 * miss names the remedy rather than the list — a refusal that enumerated every
 * authorized repository would be telling an unauthorized caller what exists.
 */
export function decideRepository(remote: string): GrantDecision {
  const wanted = normalise(remote);
  if (wanted.length === 0) {
    return { ok: false, grant: null, reason: 'No repository was named.' };
  }
  const grant = REPOSITORY_GRANTS.find((candidate) => normalise(candidate.remote) === wanted);
  if (!grant) {
    return {
      ok: false,
      grant: null,
      reason:
        'That repository is not one this factory is authorized to work in. Authorizing another ' +
        'one is a reviewed change to the envelope in code, deliberately — so that nobody can ' +
        'widen what the factory may touch by making a request. A grant alone is not enough: a ' +
        'worker must also be registered to be handed FACTORY work for that repository, and the ' +
        'access itself is granted where that worker runs.',
    };
  }
  return { ok: true, grant, reason: null };
}

function normalise(remote: string): string {
  return remote
    .trim()
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/** The list a person chooses from. Safe to show: it contains no credential. */
export function listRepositoryGrants(): RepositoryGrant[] {
  return [...REPOSITORY_GRANTS];
}

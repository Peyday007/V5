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
  {
    id: 'oakwood-site',
    remote: 'https://github.com/Peyday007/oakwood-junk-removal',
    description:
      'The Oakwood Junk Removal site: one hand-written page with a quote form, its test ' +
      'harness, its build and its continuous integration.',
    defaultBranch: 'main',
    forbiddenPaths: ['.github/workflows/deploy*', '.git/**'],
    mayOpenPullRequest: true,
  },
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
        'widen what the factory may touch by making a request.',
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

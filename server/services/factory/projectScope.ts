/**
 * What a project may change inside the repository it was authorized for.
 *
 * ---------------------------------------------------------------------------
 * Why an optional `mutationScope` was never a boundary
 * ---------------------------------------------------------------------------
 *
 * `ObjectiveSubmission.mutationScope` is optional and defaults to `['**']`. That
 * is fine as a *narrowing* — a person saying "only touch the build files" — and
 * it is not a boundary, for two reasons that compound:
 *
 *   1. **The default is the widest value.** A submission that omits the field
 *      gets the whole repository, so the safe answer is the one you have to
 *      remember and the unsafe one is free. A control whose default is "no
 *      limit" is a control nobody applied.
 *   2. **Narrowing afterwards cannot reach back past it.** `amendContract`
 *      permits a scope to shrink and never to grow, which is exactly right for
 *      keeping a campaign honest — and it means the *initial* scope is the
 *      widest reach that campaign will ever be judged against. A too-broad first
 *      submission is not correctable by a later amendment; the units are already
 *      planned against the wider surface, and the diff check that rejects work
 *      outside a unit's declared paths is measured against paths that were
 *      allowed to exist.
 *
 * So the boundary has to be established *before* an objective is written, by
 * somebody with ADMIN on the project, and read at submission — which is where
 * this module sits. It is the same shape as the repository envelope one level
 * in: nobody supplies the limits their own work is judged against, and the limit
 * is recorded by the action that authorizes the repository for this project at
 * all rather than by the request that wants to use it.
 *
 * ---------------------------------------------------------------------------
 * Authorization at submission, not only at assignment
 * ---------------------------------------------------------------------------
 *
 * `services/bins/routing.ts` already refuses to hand a repository bin to a
 * worker not registered for that repository, and that check is real. It is also
 * *late*: by the time it fires, a change request exists, a campaign exists, a
 * plan may have been written and bins have been created and fired. Refusing
 * there means the work was created and then could not run.
 *
 * `requireProjectRepository` is the same question asked at the moment it is
 * cheap — before a row exists — and it asks a strictly stronger version of it:
 * not "is some worker registered for this repository" but "is *this project*
 * authorized to change this repository, and within which paths". A project
 * cannot submit against a repository somebody onboarded for a different project.
 *
 * ---------------------------------------------------------------------------
 * A directory, not a pattern
 * ---------------------------------------------------------------------------
 *
 * A person declares directories. This module turns each one into `dir/**`.
 * Nobody types a glob, because a glob is a small language and a boundary written
 * in one is a boundary somebody widens by accident — `sites/*` and `sites/**`
 * differ by a character and by everything.
 */
import {
  getProjectRepository,
  listProjectRepositories,
} from '../../repos/factory.ts';
import { decideRepository } from './repositoryEnvelope.ts';
import { repositoryIdOfRemote } from './onboard.ts';
import type { FactoryProjectRepository, FactoryScopeKind } from '../../domain/factory.ts';

/** The glob a whole-repository boundary is written as. */
export const WHOLE_REPOSITORY_SCOPE: readonly string[] = ['**'];

/** Nobody needs more than this many directories, and a list nobody reads is not a boundary. */
export const MAX_SCOPE_DIRECTORIES = 20;

export class ScopeError extends Error {
  readonly detail: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = 'ScopeError';
    this.detail = detail;
  }
}

/** What a person answers when they onboard a repository for a project. */
export type ScopeDeclaration =
  | { kind: 'WHOLE_REPOSITORY' }
  | { kind: 'DIRECTORIES'; directories: string[] };

/**
 * A directory a person typed, made safe and canonical, or refused by name.
 *
 * Refused rather than sanitised. A path that climbs or carries a wildcard was
 * meant to do something, and quietly turning it into something else that happens
 * to be safe leaves the person believing the boundary says what they wrote.
 */
export function normaliseDirectory(raw: string): string {
  const trimmed = raw.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed.length === 0) throw new ScopeError('A directory cannot be blank.');
  if (trimmed.length > 200) throw new ScopeError(`That directory name is too long: ${trimmed.slice(0, 40)}…`);
  if (trimmed.includes('*') || trimmed.includes('?')) {
    throw new ScopeError(
      `A boundary is a directory rather than a pattern, so "${trimmed}" is refused. ` +
        'Name the folder; Brain writes the pattern.',
    );
  }
  if (trimmed.split('/').some((part) => part === '.' || part === '..' || part === '')) {
    throw new ScopeError(`"${raw.trim()}" is not a directory inside the repository.`);
  }
  return trimmed;
}

/** The declaration as globs. `['**']` iff a person chose the whole repository. */
export function scopeFromDeclaration(declaration: ScopeDeclaration): string[] {
  if (declaration.kind === 'WHOLE_REPOSITORY') return [...WHOLE_REPOSITORY_SCOPE];
  const directories = declaration.directories.map(normaliseDirectory);
  if (directories.length === 0) {
    throw new ScopeError(
      'A directory boundary needs at least one directory. Choose the whole repository ' +
        'instead if that is what this project owns — but choose it, rather than leaving it blank.',
    );
  }
  if (directories.length > MAX_SCOPE_DIRECTORIES) {
    throw new ScopeError(`A boundary may name at most ${MAX_SCOPE_DIRECTORIES} directories.`);
  }
  const unique = [...new Set(directories)].sort();
  return unique.map((directory) => `${directory}/**`);
}

/** The directories behind a stored scope, for showing a person what they declared. */
export function directoriesOf(scope: readonly string[]): string[] {
  return scope
    .filter((pattern) => pattern !== '**')
    .map((pattern) => pattern.replace(/\/\*\*$/, ''));
}

/**
 * Is every requested pattern inside the boundary?
 *
 * A whole-repository boundary contains everything. A directory boundary contains
 * a pattern only when that pattern is one of its directories or lives under one,
 * and `**` is therefore refused by construction rather than by a special case:
 * it is not under anything.
 *
 * Comparison is on the literal prefix rather than on glob semantics on purpose.
 * The boundary's own patterns are built by `scopeFromDeclaration` and are always
 * `dir/**`, so "under this boundary" is a string question, and a string question
 * is one nobody can be clever about.
 */
export function withinBoundary(
  requested: readonly string[],
  boundary: readonly string[],
): { ok: true } | { ok: false; outside: string[] } {
  if (boundary.length === 1 && boundary[0] === '**') return { ok: true };
  const prefixes = directoriesOf(boundary).map((directory) => `${directory}/`);
  const outside = requested.filter((pattern) => {
    const cleaned = pattern.trim().replace(/^\.\//, '').replace(/^\/+/, '');
    if (cleaned === '**' || cleaned === '') return true;
    return !prefixes.some((prefix) => cleaned.startsWith(prefix));
  });
  return outside.length === 0 ? { ok: true } : { ok: false, outside };
}

export interface ResolvedProjectScope {
  grantId: string;
  repositoryId: string;
  repository: string;
  scopeKind: FactoryScopeKind;
  /** The boundary itself. */
  boundary: string[];
  /** What this submission will actually run under: its own narrowing, or the boundary. */
  effective: string[];
}

/**
 * The project's authorization for one repository, and the scope a submission
 * may run under — or a refusal naming which of the two is missing.
 *
 * The three refusals are deliberately different sentences, because they have
 * three different remedies: the repository is not in the envelope at all (a
 * reviewed code change), it is in the envelope but not onboarded for *this*
 * project (an action on Build), or the submission asked for more than the
 * boundary allows (write a narrower objective, or change the boundary
 * deliberately).
 */
export async function resolveProjectScope(input: {
  projectId: string;
  /** The remote as the contract derived it. */
  repository: string;
  /** What the submission asked for, if it narrowed anything. */
  requested?: string[] | undefined;
}): Promise<ResolvedProjectScope> {
  const repositoryId = repositoryIdOfRemote(input.repository);
  if (!repositoryId) {
    throw new ScopeError(
      'That repository is not one this factory can resolve to a forge repository, so no ' +
        'project boundary can be checked against it.',
      { reason: 'REPOSITORY_UNRESOLVABLE' },
    );
  }

  const authorized = decideRepository(input.repository);
  if (!authorized.ok || !authorized.grant) {
    throw new ScopeError(authorized.reason ?? 'That repository is not authorized.', {
      reason: 'REPOSITORY_NOT_AUTHORIZED',
    });
  }

  const row = await getProjectRepository(input.projectId, authorized.grant.id);
  if (!row) {
    throw new ScopeError(
      'This project has not been given that repository. Authorizing a repository in code says ' +
        'the factory may be pointed at it; onboarding it for a project says which project may ' +
        'change it and inside which directories. Do that on Build → Repositories first.',
      { reason: 'REPOSITORY_NOT_ONBOARDED_FOR_PROJECT' },
    );
  }

  const boundary = [...row.pathScope];
  const requested = input.requested && input.requested.length > 0 ? input.requested : null;
  if (!requested) {
    // The boundary itself, never `['**']`. This is the whole correction: a
    // submission that says nothing about its reach gets the reach a person
    // declared for this project, which for a shared repository is one directory.
    return {
      grantId: row.grantId,
      repositoryId: row.repositoryId,
      repository: input.repository,
      scopeKind: row.scopeKind,
      boundary,
      effective: boundary,
    };
  }

  const contained = withinBoundary(requested, boundary);
  if (!contained.ok) {
    throw new ScopeError(
      `This project may change ${describeBoundary(row)} in ${row.repositoryId}, and this ` +
        `objective asked for ${contained.outside.join(', ')}. A submission may narrow the ` +
        'boundary and never widen it — and narrowing it later would not correct this one, ' +
        'because the scope a campaign is planned against is the scope it was submitted with.',
      { reason: 'SCOPE_OUTSIDE_BOUNDARY', outside: contained.outside, boundary },
    );
  }

  return {
    grantId: row.grantId,
    repositoryId: row.repositoryId,
    repository: input.repository,
    scopeKind: row.scopeKind,
    boundary,
    effective: [...requested],
  };
}

/** The boundary in the words a person declared it in. */
export function describeBoundary(row: FactoryProjectRepository): string {
  if (row.scopeKind === 'WHOLE_REPOSITORY') return 'the whole repository';
  const directories = directoriesOf(row.pathScope);
  if (directories.length === 1) return `${directories[0]}/`;
  return `${directories.slice(0, -1).join('/, ')}/ and ${directories[directories.length - 1]}/`;
}

/** Every repository this project has been given, for a picker and for a report. */
export async function projectRepositories(projectId: string): Promise<FactoryProjectRepository[]> {
  return listProjectRepositories(projectId);
}

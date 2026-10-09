/**
 * The owner saying, once, that an approved objective may be released without
 * them — and what "live" means for it.
 *
 * One writer for both doors (a person on Build, and `npm run factory
 * authorize-release` on a terminal) so the two cannot come to validate a grant
 * differently. A grant is a person's decision: the caller resolves the person
 * from the authenticated principal (browser) or from `--admin` against the
 * database (terminal), and nothing in a request body names who granted it.
 *
 * A grant widens nothing. It does not change what a campaign may touch, it does
 * not lower the review floor, and it does not override the paths an automatic
 * release never carries (`RELEASE_EXCLUDED_PATHS`) — those refuse at the gate
 * whatever the grant says.
 */
import { getChangeRequest } from '../../../repos/factory.ts';
import { getGrant, grantRelease, liveGrantFor, revokeGrant } from '../../../repos/factoryRelease.ts';
import type { LiveCheck, ReleaseChannel, ReleaseGrant } from '../../../domain/factoryRelease.ts';

export class ReleaseGrantError extends Error {}

const MAX_CHECKS = 10;
const MAX_TEXT = 300;

function cleanPath(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.length > MAX_TEXT) {
    throw new ReleaseGrantError(`${what} must be a path on this Brain beginning with a single "/".`);
  }
  if (/[\s<>"'`\\]/.test(value) || value.includes('..')) {
    throw new ReleaseGrantError(`${what} contains characters a path on this Brain does not.`);
  }
  return value;
}

function cleanText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_TEXT) {
    throw new ReleaseGrantError(`${what} must be non-empty text of at most ${MAX_TEXT} characters.`);
  }
  return value;
}

/** Validate live checks exactly; an unknown field refuses the whole list. */
export function validateLiveChecks(input: unknown): LiveCheck[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new ReleaseGrantError('liveChecks must be a list.');
  if (input.length > MAX_CHECKS) throw new ReleaseGrantError(`At most ${MAX_CHECKS} live checks.`);
  return input.map((raw, index): LiveCheck => {
    if (typeof raw !== 'object' || raw === null) throw new ReleaseGrantError(`liveChecks[${index}] is not an object.`);
    const check = raw as Record<string, unknown>;
    if (check.kind === 'HTTP') {
      const extra = Object.keys(check).filter((key) => !['kind', 'path', 'expectStatus', 'expectText'].includes(key));
      if (extra.length) throw new ReleaseGrantError(`liveChecks[${index}] carries unknown field(s): ${extra.join(', ')}.`);
      const status = Number(check.expectStatus ?? 200);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new ReleaseGrantError(`liveChecks[${index}].expectStatus is not an HTTP status.`);
      }
      return {
        kind: 'HTTP',
        path: cleanPath(check.path, `liveChecks[${index}].path`),
        expectStatus: status,
        ...(check.expectText === undefined ? {} : { expectText: cleanText(check.expectText, `liveChecks[${index}].expectText`) }),
      };
    }
    if (check.kind === 'BUNDLE_TEXT') {
      const extra = Object.keys(check).filter((key) => !['kind', 'text'].includes(key));
      if (extra.length) throw new ReleaseGrantError(`liveChecks[${index}] carries unknown field(s): ${extra.join(', ')}.`);
      return { kind: 'BUNDLE_TEXT', text: cleanText(check.text, `liveChecks[${index}].text`) };
    }
    throw new ReleaseGrantError(`liveChecks[${index}].kind must be HTTP or BUNDLE_TEXT.`);
  });
}

export interface AuthorizeInput {
  changeRequestId: string;
  userId: string;
  channel: ReleaseChannel;
  executedByRef: string | null;
  reason: string;
  pagePath?: unknown;
  liveChecks?: unknown;
}

export async function authorizeAutomaticRelease(
  input: AuthorizeInput,
): Promise<{ grant: ReleaseGrant; created: boolean }> {
  const changeRequest = await getChangeRequest(input.changeRequestId);
  if (!changeRequest) throw new ReleaseGrantError('No such change request.');
  if (changeRequest.state === 'WITHDRAWN') throw new ReleaseGrantError('A withdrawn objective cannot be released.');
  if (changeRequest.riskClass !== 'LOW') {
    throw new ReleaseGrantError(
      `This objective is risk class ${changeRequest.riskClass}. Only a LOW-risk objective may be released ` +
        'without a person; this one finishes at a pull request.',
    );
  }
  const reason = cleanText(input.reason, 'The reason');
  const pagePath =
    input.pagePath === undefined || input.pagePath === null || input.pagePath === ''
      ? null
      : cleanPath(input.pagePath, 'The page path');
  const liveChecks = validateLiveChecks(input.liveChecks);
  return grantRelease({
    changeRequestId: changeRequest.id,
    projectId: changeRequest.projectId,
    liveChecks,
    pagePath,
    grantedByUserId: input.userId,
    authorityChannel: input.channel,
    executedByRef: input.executedByRef,
    reason,
  });
}

export async function withdrawAutomaticRelease(input: {
  changeRequestId: string;
  userId: string;
  reason: string;
}): Promise<boolean> {
  const grant = await liveGrantFor(input.changeRequestId);
  if (!grant) return false;
  return revokeGrant(grant.id, input.userId, cleanText(input.reason, 'The reason'));
}

export { getGrant, liveGrantFor };

/**
 * Sharing a method across projects and users.
 *
 * Nothing private is ever made readable elsewhere. A PROJECT or USER method is
 * shared by writing a new GENERAL method from its definition, and only if that
 * definition holds no private data. The copy starts PROPOSED: trust is earned
 * on measured results and does not travel with the copy. The original is left
 * exactly as it was, and reads stay filtered by scope in the repository.
 */
import { createSearchMethod, getSearchMethod } from '../../../repos/searchMethods.ts';
import type { SearchMethod, SearchReader } from '../../../domain/searchIntelligence.ts';
import { privateDataIn } from './privacy.ts';

export type ShareResult =
  | { ok: true; method: SearchMethod }
  | { ok: false; reason: string; found?: string[] };

export async function shareAsGeneral(
  reader: SearchReader,
  methodId: string,
  known: { projectIds?: readonly string[]; userIds?: readonly string[]; terms?: readonly string[] } = {},
): Promise<ShareResult> {
  const source = await getSearchMethod(reader, methodId);
  // Not visible and not there are the same answer.
  if (!source) return { ok: false, reason: 'No such method.' };
  if (source.scope === 'GENERAL') return { ok: true, method: source };
  const found = privateDataIn(source, {
    projectIds: [...(known.projectIds ?? []), ...(source.projectId ? [source.projectId] : [])],
    userIds: [...(known.userIds ?? []), ...(source.userId ? [source.userId] : [])],
    terms: known.terms ?? [],
  });
  if (found.length > 0) {
    return { ok: false, reason: 'The definition holds private data, so it cannot be shared.', found };
  }
  const method = await createSearchMethod({
    scope: 'GENERAL',
    methodKey: source.methodKey,
    subjectId: null,
    finds: source.finds,
    usefulWhen: source.usefulWhen,
    sources: source.sources,
    requiredInputs: source.requiredInputs,
    query: source.query,
    checkProcedure: source.checkProcedure,
    limits: source.limits,
    version: source.version,
  });
  return { ok: true, method };
}

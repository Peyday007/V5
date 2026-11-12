/**
 * Sharing a method across projects and users.
 *
 * Nothing private is ever made readable elsewhere. A PROJECT or USER method is
 * shared by writing a new GENERAL method from its definition, and only if that
 * definition holds no private data. The copy starts PROPOSED: trust is earned
 * on measured results and does not travel with the copy. The original is left
 * exactly as it was, and reads stay filtered by scope in the repository.
 *
 * The copy is for the same subject as the original. A subject that is already
 * GENERAL is named as it is; a private learned subject is shared beside the
 * method as a GENERAL subject with the same key, label and description — only
 * if those hold nothing private, and never with the private row's provenance —
 * so the copy and the original are comparable as methods for one subject.
 */
import { createSearchMethod, getLearnedSubject, getSearchMethod, upsertLearnedSubject } from '../../../repos/searchMethods.ts';
import type { SearchMethod, SearchReader } from '../../../domain/searchIntelligence.ts';
import { PrivateDataRefused, privateDataIn } from './privacy.ts';

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
  const knownPrivate = {
    projectIds: [...(known.projectIds ?? []), ...(source.projectId ? [source.projectId] : [])],
    userIds: [...(known.userIds ?? []), ...(source.userId ? [source.userId] : [])],
    terms: known.terms ?? [],
  };
  const found = privateDataIn(source, knownPrivate);
  if (found.length > 0) {
    return { ok: false, reason: 'The definition holds private data, so it cannot be shared.', found };
  }
  let subjectId = source.subjectId;
  const subject = subjectId ? await getLearnedSubject(reader, subjectId) : null;
  if (subject && subject.scope !== 'GENERAL') {
    const inSubject = privateDataIn({
      finds: subject.label, usefulWhen: subject.description, sources: [], requiredInputs: [],
      query: subject.subjectKey, checkProcedure: '', limits: null,
    }, knownPrivate);
    if (inSubject.length > 0) {
      return { ok: false, reason: 'The method\'s subject holds private data, so it cannot be shared.', found: inSubject };
    }
    try {
      subjectId = (await upsertLearnedSubject({
        scope: 'GENERAL', subjectKey: subject.subjectKey, label: subject.label,
        description: subject.description, origin: 'shared', sourceRef: null,
      })).id;
    } catch (err) {
      if (err instanceof PrivateDataRefused) {
        return { ok: false, reason: 'The method\'s subject holds private data, so it cannot be shared.' };
      }
      throw err;
    }
  }
  const method = await createSearchMethod({
    scope: 'GENERAL',
    methodKey: source.methodKey,
    subjectId,
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

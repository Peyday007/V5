/**
 * The answer when Brain could not *check* a credential, as opposed to refusing one.
 *
 * "Not authorized" means a credential was judged and found wanting. A database
 * that did not answer judged nothing, and for a long time both were said in the
 * same two words — `503 {"error":"Not authorized."}` from the HTTP guard and
 * `503 "Not authorized."` from the MCP door — so every Supabase hiccup reached
 * Claude, the worker and the person notified as a connector that had stopped
 * being authorized. Production: `brain_whoami` on Brain Research 1-D answered
 * exactly that during a pooler timeout, about a connector that was fine.
 *
 * Fail closed is unchanged: nothing is served. What changes is the sentence and
 * one header. It names the condition as temporary, says the credential was not
 * judged, and carries `Retry-After`, which is the one hint every HTTP client
 * understands. It names nothing about *what* failed (§17): the category is on
 * the incident record, which Brain owns.
 */
import type { Response } from 'express';
import { classifyInfraFailure, noteInfraFailure } from '../db/infra.ts';

/** Seconds a client is asked to wait before asking again. Short on purpose. */
export const RETRY_AFTER_SECONDS = 5;

export const CREDENTIAL_NOT_CHECKED =
  'Brain is temporarily unable to check credentials (its database did not answer in time). ' +
  'This is not an authorization failure and nothing about your credential changed: retry the same request shortly.';

/**
 * Note the failure where it was felt and set the headers every variant shares.
 *
 * Returns whether it was infrastructure. An unclassified exception — a bug in
 * authentication — is still a credential nobody judged, so the answer is the
 * same 503, but it is logged loudly and recorded as nothing: an incident would
 * excuse no-shows fleet-wide on the strength of a defect.
 */
export function prepareUnavailable(res: Response, surface: string, error: unknown): boolean {
  const kind = classifyInfraFailure(error);
  if (kind) {
    noteInfraFailure(kind, surface);
  } else {
    // eslint-disable-next-line no-console
    console.error(`[brain] ${surface} threw something that is not infrastructure:`, error);
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
  return kind !== null;
}

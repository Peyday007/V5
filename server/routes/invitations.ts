/**
 * The two routes an invited person reaches, and the only two on `/api` that a
 * caller with no Brain account may reach at all.
 *
 * Both are thin wrappers over `services/identity/invitations.ts`, which is where
 * every decision is made — the same rule Step 7 wrote for the MCP boundary and
 * §25 for the connector: a surface that grows its own checks is a second
 * security model, and the second one is always weaker.
 *
 * Three things about their shape are deliberate.
 *
 * **The token arrives in the body, never in the path.** §17 forbids a credential
 * in a URL that gets recorded, and a path segment is recorded by every proxy,
 * access log and browser history between the inviter and the recipient. The link
 * a person clicks carries the token in the URL **fragment**, which is never sent
 * to any server; the client reads it from `location.hash` and posts it here.
 *
 * **Preview is a POST that writes nothing.** It has a body because the token is
 * in the body, not because it mutates: opening an invitation deliberately does
 * not consume it, exactly as a worker invitation's link does not — somebody who
 * loses the tab must not need a new invitation.
 *
 * **Every refusal is one sentence.** Unknown, malformed, expired, already
 * accepted, withdrawn, a project that has gone, an inviter who no longer
 * administers it: one body, naming the remedy rather than the reason. A token
 * holder who could tell those apart could learn about a Brain they cannot see,
 * and invariant 23 is about the body and not only the status.
 */
import { Router } from 'express';
import {
  acceptInvitation,
  previewInvitation,
} from '../services/identity/invitations.ts';
import { bodyOf, handler, notFound } from './helpers.ts';
import { contextFromRequest } from '../services/identity/context.ts';

export const invitationsRouter = Router();

/**
 * What accepting this invitation would do.
 *
 * 404 on refusal, with the service's own sentence, so a caller cannot separate
 * "there is no such invitation" from "there is one and you cannot use it".
 */
invitationsRouter.post(
  '/invitations/preview',
  handler(async (req) => {
    const outcome = await previewInvitation(bodyOf(req)['token']);
    if (!outcome.ok) throw notFound(outcome.reason);
    return outcome.preview;
  }),
);

/**
 * Accept it.
 *
 * Answers no session and sets no cookie. A new account still has to sign in and
 * an existing one may already be signed in somewhere else; either way nothing
 * about the accepting browser becomes an identity here, which is what keeps this
 * route from being a second way to authenticate.
 */
invitationsRouter.post(
  '/invitations/accept',
  handler(async (req) => {
    const body = bodyOf(req);
    const context = contextFromRequest(req);
    const outcome = await acceptInvitation({
      token: body['token'],
      password: body['password'],
      displayName: body['displayName'],
      requestId: context?.requestId ?? null,
      userAgent: context?.userAgent ?? null,
      remoteAddr: context?.remoteAddr ?? null,
    });
    if (!outcome.ok) throw notFound(outcome.reason);
    return outcome;
  }),
);

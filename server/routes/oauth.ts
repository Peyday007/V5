/**
 * The OAuth 2.1 authorization server, for connecting a worker.
 *
 * This exists because of one fact about the outside world: Claude's custom
 * connector offers a name, a URL, and optional OAuth client credentials. It has
 * no field for a static `Authorization` header. So the Step 7 bearer design —
 * correct as it is, and still supported — cannot be used from Claude at all.
 *
 * Step 7 argued against building this, on the grounds that OAuth exists to put
 * a person in front of a consent screen and a worker has no person in its loop.
 * That conflated two moments. The *connection* is authorized by a human in a
 * browser, once. The *tool calls* afterwards are made by a machine with nobody
 * present. OAuth is the mechanism for exactly that shape.
 *
 * ---------------------------------------------------------------------------
 * The invariant
 * ---------------------------------------------------------------------------
 *
 *   The operator authenticates. The **worker** is authorized.
 *
 * A person signs in to the Brain as themselves, chooses which named worker is
 * being connected and with what access, and approves. What Claude receives is a
 * token whose principal is that worker. The approver is recorded on the
 * authorization code for the audit and appears nowhere in the token, so there
 * is no path by which approving a connection could make Claude act as the
 * person who approved it.
 *
 * That is also what makes the operator's requirement real rather than
 * decorative: a worker "plugs in the same way you do", through a Brain sign-in,
 * rather than having a long-lived secret carried by hand into a configuration
 * box.
 */
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { authenticateRequest, originIsSameSite, parseCookies } from '../services/identity/authenticate.ts';
import {
  digestSecret,
  generateOAuthToken,
  generateOpaqueSecret,
  parseOAuthToken,
  verifyPkceS256,
  parseInvitationToken,
} from '../services/identity/secrets.ts';
import {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  clientSecretMatches,
  findLiveToken,
  getClientByClientId,
  issueAuthorizationCode,
  issueToken,
  redeemAuthorizationCode,
  registerClient,
  revokeTokenChain,
} from '../repos/oauth.ts';
import { getWorker, listWorkers, listMembershipsForPrincipal, recordIdentityEvent } from '../repos/identity.ts';
import { getProject } from '../repos/projects.ts';
import {
  createInvitation,
  findLiveInvitation,
  redeemInvitation,
  INVITATION_TTL_MS,
} from '../repos/invitations.ts';
import type { Principal, Worker, WorkerInvitation } from '../domain/types.ts';
import { card, esc, page } from './pages.ts';

export const OAUTH_BASE = '/oauth';

/* ------------------------------------------------------------------------ */
/* Where this server lives                                                   */
/* ------------------------------------------------------------------------ */

/**
 * The issuer, derived from the request rather than configured.
 *
 * A hard-coded issuer is wrong in exactly the environments that matter: the
 * same image runs locally, in CI and in production, and the metadata documents
 * have to name the host the client actually reached. `trust proxy` is set, so
 * this is the external scheme and host rather than the balancer's.
 */
export function issuerFor(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? 'localhost'}`;
}

/* ------------------------------------------------------------------------ */
/* HTML                                                                      */
/* ------------------------------------------------------------------------ */

function errorPage(res: Response, status: number, title: string, detail: string): void {
  res.status(status).type('html').send(
    page(
      title,
      card(
        `<h1>${esc(title)}</h1><div class="err">${esc(detail)}</div>
         <p class="note">Nothing was authorized. You can close this window.</p>`,
      ),
    ),
  );
}

/* ------------------------------------------------------------------------ */
/* Request validation                                                        */
/* ------------------------------------------------------------------------ */

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string;
  resource: string | null;
}

/**
 * Read and check an authorize request.
 *
 * The order matters. `client_id` and `redirect_uri` are validated *first* and
 * any failure there is rendered as a page rather than redirected — redirecting
 * an error to an unvalidated URI is how an open redirector is built. Everything
 * after that may safely be reported back to the client.
 */
function readAuthorizeParams(query: Record<string, unknown>): AuthorizeParams | { error: string } {
  const get = (name: string): string | null => {
    const value = query[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  const clientId = get('client_id');
  if (!clientId) return { error: 'client_id is required.' };

  const redirectUri = get('redirect_uri');
  if (!redirectUri) return { error: 'redirect_uri is required.' };

  if (get('response_type') !== 'code') {
    return { error: 'Only the authorization code flow is supported (response_type=code).' };
  }

  const codeChallenge = get('code_challenge');
  if (!codeChallenge) {
    return { error: 'code_challenge is required. OAuth 2.1 requires PKCE.' };
  }
  const method = get('code_challenge_method') ?? 'plain';
  if (method !== 'S256') {
    // `plain` makes the challenge equal to the verifier, so anybody who saw the
    // authorization request can complete the exchange. Accepting it "for
    // compatibility" would make the protection only as strong as the weakest
    // client that ever connects.
    return { error: 'code_challenge_method must be S256.' };
  }

  return {
    clientId,
    redirectUri,
    state: get('state'),
    codeChallenge,
    scope: get('scope') ?? '',
    resource: get('resource'),
  };
}

/** Exact match against a registered URI. A prefix match is an open redirector. */
function redirectUriIsRegistered(registered: string[], presented: string): boolean {
  return registered.some((uri) => uri === presented);
}

/* ------------------------------------------------------------------------ */
/* Who is approving                                                          */
/* ------------------------------------------------------------------------ */

/**
 * The consent screen requires a signed-in Brain **administrator**.
 *
 * Choosing which identity a remote client may act as is an administrative act:
 * it is the same authority as creating the worker and granting its membership.
 * A project member cannot do it, and a worker certainly cannot — a worker
 * approving its own connection would be a machine widening its own access.
 */
/**
 * The name of the cookie an opened invitation leaves behind.
 *
 * Opening the link does not connect anything — it puts the invitation into the
 * browser that will need it, because Claude constructs the authorize URL itself
 * and there is nowhere to put a token in it. So the sequence is: open the link,
 * then start the connection in Claude, and the consent screen finds it here.
 */
const INVITE_COOKIE = 'brain_invite';

/**
 * An invitation standing in for a signed-in administrator.
 *
 * Deliberately a separate function from `approver` rather than a branch inside
 * it. They authorize different things: an administrator may connect any worker,
 * and an invitation may connect exactly the one it names. Folding them together
 * would make it one forgotten check away from an invitation approving anything,
 * which is the whole risk of sending one over a channel the Brain does not
 * control.
 *
 * A bearer token is ignored here for the same reason it is on the admin path.
 */
async function invitedApproval(
  req: Request,
): Promise<{ invitation: WorkerInvitation; worker: Worker; approvedByUserId: string } | null> {
  if (req.header('authorization')) return null;
  // The application parses cookies itself rather than mounting a parser, so
  // `req.cookies` is always undefined here — reaching for it silently disables
  // this whole path, which is exactly what it did until the tests said so.
  const raw = parseCookies(req.header('cookie'))[INVITE_COOKIE];
  if (typeof raw !== 'string') return null;
  const parsed = parseInvitationToken(raw);
  if (!parsed) return null;

  const invitation = await findLiveInvitation(parsed.prefix, parsed.secret);
  if (!invitation) return null;

  const worker = await getWorker(invitation.workerId);
  // An invitation for a worker that has since been disabled or removed connects
  // nothing. The worker's current state decides, not the invitation's.
  if (!worker || worker.disabled) return null;

  return { invitation, worker, approvedByUserId: invitation.createdByUserId };
}

async function approver(req: Request): Promise<Principal | null> {
  // A bearer token must not authorize a consent screen, so the header is
  // ignored here and only the browser session counts.
  if (req.header('authorization')) return null;
  const outcome = await authenticateRequest(req);
  if (!outcome.ok) return null;
  if (outcome.principal.type !== 'HUMAN') return null;
  if (!outcome.principal.isBrainAdmin) return null;
  if (outcome.principal.mustChangePassword) return null;
  return outcome.principal;
}

async function audit(input: {
  action: string;
  actor: Principal | null;
  targetId: string | null;
  result: 'SUCCESS' | 'DENIED' | 'FAILED';
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await recordIdentityEvent({
      actorType: input.actor ? input.actor.type : 'ANONYMOUS',
      actorId: input.actor?.id ?? null,
      credentialId: input.actor?.credentialId ?? null,
      action: input.action,
      targetType: 'OAUTH',
      targetId: input.targetId,
      result: input.result,
      // Ids and categories only. Never a token, a code, a secret or a challenge.
      metadata: input.metadata ?? {},
    });
  } catch {
    // An audit that cannot be written must not turn an authorization into
    // something else.
  }
}

/* ------------------------------------------------------------------------ */
/* The router                                                                */
/* ------------------------------------------------------------------------ */

export function oauthRouter(): Router {
  const router = Router();

  /* -- Dynamic client registration (RFC 7591) ---------------------------- */

  /**
   * Deliberately unauthenticated, which sounds worse than it is.
   *
   * Claude's connector dialog makes the client id and secret *optional*, so a
   * connector given neither must be able to register itself or it can never
   * connect at all. And a registered client can do nothing on its own: it
   * cannot read, cannot call a tool, and cannot obtain a token without a human
   * completing the consent screen while signed in to the Brain as an
   * administrator. The row confers no access; the approval does.
   */
  router.post('/register', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawUris = body['redirect_uris'];
      const redirectUris = Array.isArray(rawUris)
        ? rawUris.filter((u): u is string => typeof u === 'string')
        : [];

      if (redirectUris.length === 0) {
        res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: 'At least one redirect_uri is required.',
        });
        return;
      }
      // Every redirect must be https, or localhost for a developer client.
      for (const uri of redirectUris) {
        let parsed: URL;
        try {
          parsed = new URL(uri);
        } catch {
          res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'Not a URL.' });
          return;
        }
        const localhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
        if (parsed.protocol !== 'https:' && !localhost) {
          res.status(400).json({
            error: 'invalid_redirect_uri',
            error_description: 'A redirect_uri must use https.',
          });
          return;
        }
      }

      const name = typeof body['client_name'] === 'string' ? body['client_name'] : 'Unnamed client';
      const method =
        body['token_endpoint_auth_method'] === 'client_secret_post' ||
        body['token_endpoint_auth_method'] === 'client_secret_basic'
          ? String(body['token_endpoint_auth_method'])
          : 'none';

      const secret = method === 'none' ? null : generateOpaqueSecret();
      const client = await registerClient({
        clientName: name,
        redirectUris,
        secretDigest: secret ? secret.digest : null,
        tokenAuthMethod: method,
      });

      await audit({
        action: 'OAUTH_CLIENT_REGISTERED',
        actor: null,
        targetId: client.clientId,
        result: 'SUCCESS',
        metadata: { clientName: client.clientName, redirectCount: redirectUris.length },
      });

      res.status(201).json({
        client_id: client.clientId,
        // The only moment the secret exists outside the caller. Never stored.
        ...(secret ? { client_secret: secret.plaintext } : {}),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: client.tokenAuthMethod,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    })();
  });

  /* -- Authorize --------------------------------------------------------- */

  /**
   * Open an invitation.
   *
   * This connects nothing. It puts the invitation into the browser that is
   * about to need it and then gets out of the way, because Claude builds the
   * authorize URL itself and there is nowhere in it to carry a token.
   *
   * Opening deliberately does not spend the invitation. Somebody who closes the
   * tab, or whose first attempt fails, should not need a new link — it is spent
   * when a connection is actually authorized, and nowhere else.
   */
  router.get('/invite/:token', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const parsed = parseInvitationToken(req.params['token'] ?? '');
      const invitation = parsed ? await findLiveInvitation(parsed.prefix, parsed.secret) : null;
      const worker = invitation ? await getWorker(invitation.workerId) : null;

      // Unknown, revoked, spent, expired, and pointing at a worker that has
      // since been removed are one answer. Anything finer tells a person
      // holding a guessed link which part of their guess was right.
      if (!parsed || !invitation || !worker || worker.disabled) {
        await audit({ action: 'OAUTH_INVITE_OPEN', actor: null, targetId: null, result: 'DENIED' });
        errorPage(
          res,
          400,
          'This invitation cannot be used',
          'It may have been used already, withdrawn, or expired. Ask for a new one.',
        );
        return;
      }

      res.cookie(INVITE_COOKIE, req.params['token'] ?? '', {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.protocol === 'https',
        path: '/',
        maxAge: 60 * 60 * 1000,
      });
      await audit({
        action: 'OAUTH_INVITE_OPEN',
        actor: null,
        targetId: invitation.workerId,
        result: 'SUCCESS',
      });

      res.type('html').send(
        page(
          'Invitation accepted',
          card(`<h1>You are ready to connect</h1>
           <p class="sub">This browser can now connect <strong>${esc(worker.displayName)}</strong>,
             and nothing else. Leave this tab open and go back to Claude.</p>
           <div class="grant">
             <dt>Next</dt>
             <dd>In Claude, open <strong>Settings → Connectors</strong>, add a connector pointing at
               <code>${esc(issuerFor(req))}/mcp</code>, then click <strong>Connect</strong>.</dd>
             <dt>What this gives away</dt>
             <dd>Nothing of yours. Claude receives a token for that one worker, which the person who
               invited you can withdraw at any time. No account is created for you, and you are not
               being asked for a password.</dd>
           </div>
           <p class="note">This invitation is good for one connection. If it stops working, ask for
             a fresh link rather than reusing this one.</p>`),
        ),
      );
    })();
  });

  router.get('/authorize', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const params = readAuthorizeParams(req.query as Record<string, unknown>);
      if ('error' in params) {
        errorPage(res, 400, 'This connection request is not valid', params.error);
        return;
      }

      const client = await getClientByClientId(params.clientId);
      if (!client || client.disabledAt !== null) {
        errorPage(res, 400, 'Unknown client', 'That client is not registered with this Brain.');
        return;
      }
      if (!redirectUriIsRegistered(client.redirectUris, params.redirectUri)) {
        // Rendered, never redirected: bouncing to an unregistered URI is the
        // open redirector this check exists to prevent.
        errorPage(res, 400, 'Unregistered redirect', 'That redirect_uri was not registered by this client.');
        return;
      }

      const person = await approver(req);
      if (person) {
        res.type('html').send(await consentPage(req, params, client.clientName, person, null));
        return;
      }

      // No administrator here. An invitation carries one's approval instead,
      // for exactly the worker it names — so the screen offers that worker and
      // no choice, rather than a list.
      const invited = await invitedApproval(req);
      if (invited) {
        res.type('html').send(invitedConsentPage(req, params, client.clientName, invited.worker));
        return;
      }

      res.type('html').send(signInPage(req, params, client.clientName, null));
    })();
  });

  /**
   * Sign in, from the consent screen.
   *
   * This posts to the ordinary sign-in service rather than reimplementing it:
   * same throttle, same refusal text, same session cookie. The only difference
   * is that it lands back on the consent screen instead of the application.
   */
  router.post('/authorize/signin', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      if (!originIsSameSite(req)) {
        errorPage(res, 403, 'Blocked', 'That form was not submitted from this site.');
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const params = readAuthorizeParams(body);
      if ('error' in params) {
        errorPage(res, 400, 'This connection request is not valid', params.error);
        return;
      }
      const client = await getClientByClientId(params.clientId);
      if (!client || !redirectUriIsRegistered(client.redirectUris, params.redirectUri)) {
        errorPage(res, 400, 'Unknown client', 'That client is not registered with this Brain.');
        return;
      }

      // Delegated to the application's own sign-in endpoint so there is exactly
      // one implementation of "is this password right", with one throttle.
      const email = typeof body['email'] === 'string' ? body['email'] : '';
      const password = typeof body['password'] === 'string' ? body['password'] : '';
      const signIn = await fetch(`${issuerFor(req)}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: issuerFor(req) },
        body: JSON.stringify({ email, password }),
      });

      if (!signIn.ok) {
        res.status(401).type('html').send(
          signInPage(req, params, client.clientName, 'That email address and password were not accepted.'),
        );
        return;
      }
      const setCookie = signIn.headers.get('set-cookie');
      if (setCookie) res.setHeader('Set-Cookie', setCookie);

      // Redirect back to the authorize screen rather than rendering it here.
      //
      // The alternative is to re-read the principal from the cookie we have
      // just set, which means constructing something that looks enough like a
      // Request to fool the authenticator — a fake that would silently diverge
      // the first time authentication reads a field the fake does not have.
      // A 303 makes the browser re-ask with the real cookie on a real request,
      // and the GET handler that already knows how to render both states does
      // the rest.
      const back = new URL(`${issuerFor(req)}${OAUTH_BASE}/authorize`);
      back.searchParams.set('response_type', 'code');
      back.searchParams.set('client_id', params.clientId);
      back.searchParams.set('redirect_uri', params.redirectUri);
      back.searchParams.set('code_challenge', params.codeChallenge);
      back.searchParams.set('code_challenge_method', 'S256');
      if (params.scope) back.searchParams.set('scope', params.scope);
      if (params.state) back.searchParams.set('state', params.state);
      if (params.resource) back.searchParams.set('resource', params.resource);
      res.redirect(303, back.toString());
    })();
  });

  /* -- Approve ----------------------------------------------------------- */

  router.post('/authorize/approve', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      if (!originIsSameSite(req)) {
        errorPage(res, 403, 'Blocked', 'That form was not submitted from this site.');
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const params = readAuthorizeParams(body);
      if ('error' in params) {
        errorPage(res, 400, 'This connection request is not valid', params.error);
        return;
      }

      const client = await getClientByClientId(params.clientId);
      if (!client || client.disabledAt !== null) {
        errorPage(res, 400, 'Unknown client', 'That client is not registered with this Brain.');
        return;
      }
      if (!redirectUriIsRegistered(client.redirectUris, params.redirectUri)) {
        errorPage(res, 400, 'Unregistered redirect', 'That redirect_uri was not registered by this client.');
        return;
      }

      const person = await approver(req);
      const invited = person ? null : await invitedApproval(req);
      if (!person && !invited) {
        // Somebody who arrived with an invitation gets told about the
        // invitation, not about administrators. This is the ordinary case of a
        // second click or a back button after connecting, and telling that
        // person they need to be a Brain administrator sounds like a fault in
        // the Brain rather than a link that has already been used.
        //
        // It discloses nothing: they know they had an invitation, and the
        // message is the same one every dead invitation gets.
        const presentedInvitation = parseCookies(req.header('cookie'))[INVITE_COOKIE] !== undefined;
        await audit({
          action: 'OAUTH_AUTHORIZE',
          actor: null,
          targetId: params.clientId,
          result: 'DENIED',
          metadata: { reason: presentedInvitation ? 'INVITATION_NOT_LIVE' : 'NOT_ADMIN' },
        });
        if (presentedInvitation) {
          errorPage(
            res,
            400,
            'This invitation cannot be used',
            'It may have been used already, withdrawn, or expired. Ask for a new one.',
          );
          return;
        }
        errorPage(res, 403, 'Not authorized', 'Only a signed-in Brain administrator may connect a worker.');
        return;
      }

      const workerId = typeof body['worker_id'] === 'string' ? body['worker_id'] : '';

      // The invitation names the worker. The form is a form, and a form can be
      // edited — so on the invited path the posted id is checked against the
      // invitation rather than trusted, and a mismatch is refused outright
      // instead of being quietly corrected. An invitation that could approve a
      // different worker would be an invitation to approve any worker.
      if (invited && workerId !== invited.worker.id) {
        await audit({
          action: 'OAUTH_AUTHORIZE',
          actor: null,
          targetId: invited.worker.id,
          result: 'DENIED',
          metadata: { reason: 'INVITATION_WORKER_MISMATCH' },
        });
        errorPage(res, 403, 'Not authorized', 'That invitation does not cover this worker.');
        return;
      }

      const worker = workerId ? await getWorker(workerId) : null;

      /**
       * Say what went wrong, on whichever screen the caller is actually on.
       *
       * An administrator gets the chooser back with the problem on it. Somebody
       * on an invitation has nothing to choose, so they get a plain refusal
       * rather than a list of workers they were never offered.
       */
      const refuse = async (detail: string): Promise<void> => {
        if (person) {
          res.status(400).type('html').send(
            await consentPage(req, params, client.clientName, person, detail),
          );
          return;
        }
        errorPage(res, 400, 'This connection cannot be completed', detail);
      };

      if (!worker) {
        await refuse('Choose a worker to connect.');
        return;
      }
      if (worker.disabled) {
        await refuse('That worker is disabled.');
        return;
      }
      // A worker with no membership can do nothing, and connecting one is
      // almost certainly a mistake worth catching here rather than at the first
      // puzzling refusal.
      const memberships = await listMembershipsForPrincipal('WORKER', worker.id);
      if (memberships.filter((m) => m.active).length === 0) {
        await refuse(
          'That worker is not a member of any project yet, so it could not do anything. Grant it a project first.',
        );
        return;
      }

      /**
       * Spend the invitation before issuing anything.
       *
       * A single guarded UPDATE, and losing it is an ordinary outcome: an
       * invitation travels over a channel the Brain does not control, so two
       * people opening the same link at once is a case to handle rather than an
       * anomaly. Exactly one of them gets the connection.
       *
       * Deliberately before `issueAuthorizationCode`, not after. Spending first
       * and failing later costs somebody a link; issuing first and failing to
       * spend would leave an invitation that still works after it was used.
       *
       * A second click reaching this point is already filtered out above, since
       * a redeemed invitation stops resolving. What remains is the genuine race:
       * two requests that both read it as live, one of which loses the UPDATE.
       */
      if (invited && !(await redeemInvitation(invited.invitation.id))) {
        await audit({
          action: 'OAUTH_AUTHORIZE',
          actor: null,
          targetId: worker.id,
          result: 'DENIED',
          metadata: { reason: 'INVITATION_ALREADY_USED' },
        });
        errorPage(
          res,
          400,
          'This invitation cannot be used',
          'It may have been used already, withdrawn, or expired. Ask for a new one.',
        );
        return;
      }

      const code = generateOpaqueSecret();
      await issueAuthorizationCode({
        codeDigest: code.digest,
        clientId: params.clientId,
        // The identity the token will carry — chosen here, by a human.
        workerId: worker.id,
        // The human who decided. On the invited path that is whoever created the
        // invitation, not whoever clicked — the recipient authorized nothing,
        // they spent an authorization somebody else had already given.
        approvedByUserId: person ? person.id : invited!.approvedByUserId,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        codeChallengeMethod: 'S256',
        resource: params.resource,
        scope: params.scope,
      });

      await audit({
        action: 'OAUTH_AUTHORIZE',
        actor: person,
        targetId: worker.id,
        result: 'SUCCESS',
        metadata: {
          clientId: params.clientId,
          workerName: worker.name,
          ...(invited ? { via: 'INVITATION', invitationId: invited.invitation.id } : {}),
        },
      });

      // The invitation is spent, so the cookie is litter at best and a puzzle
      // at worst if the same browser connects again later.
      if (invited) res.clearCookie(INVITE_COOKIE, { path: '/' });

      const location = new URL(params.redirectUri);
      location.searchParams.set('code', code.plaintext);
      if (params.state) location.searchParams.set('state', params.state);
      res.redirect(302, location.toString());
    })();
  });

  /* -- Token ------------------------------------------------------------- */

  router.post('/token', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const str = (name: string): string | null => {
        const value = body[name];
        return typeof value === 'string' && value.length > 0 ? value : null;
      };

      const grantType = str('grant_type');
      const clientId = str('client_id') ?? basicClientId(req);
      if (!clientId) {
        res.status(400).json({ error: 'invalid_client' });
        return;
      }

      const client = await getClientByClientId(clientId);
      if (!client || client.disabledAt !== null) {
        res.status(401).json({ error: 'invalid_client' });
        return;
      }
      const presentedSecret = str('client_secret') ?? basicClientSecret(req);
      if (!(await clientSecretMatches(clientId, presentedSecret))) {
        res.status(401).json({ error: 'invalid_client' });
        return;
      }

      if (grantType === 'authorization_code') {
        const code = str('code');
        const verifier = str('code_verifier');
        const redirectUri = str('redirect_uri');
        if (!code || !verifier || !redirectUri) {
          res.status(400).json({ error: 'invalid_request' });
          return;
        }

        // Redeemed as a single guarded write, so two requests carrying the same
        // intercepted code cannot both succeed.
        const record = await redeemAuthorizationCode(digestSecret(code));
        if (!record) {
          res.status(400).json({ error: 'invalid_grant' });
          return;
        }
        if (record.clientId !== clientId || record.redirectUri !== redirectUri) {
          res.status(400).json({ error: 'invalid_grant' });
          return;
        }
        if (!verifyPkceS256(verifier, record.codeChallenge)) {
          await audit({ action: 'OAUTH_TOKEN', actor: null, targetId: record.workerId, result: 'DENIED', metadata: { reason: 'PKCE_FAILED' } });
          res.status(400).json({ error: 'invalid_grant' });
          return;
        }

        const worker = await getWorker(record.workerId);
        if (!worker || worker.disabled) {
          res.status(400).json({ error: 'invalid_grant' });
          return;
        }

        await issueTokenPair(res, {
          clientId,
          workerId: record.workerId,
          scope: record.scope,
          resource: record.resource,
        });
        await audit({
          action: 'OAUTH_TOKEN',
          actor: null,
          targetId: record.workerId,
          result: 'SUCCESS',
          metadata: { clientId, grant: 'authorization_code' },
        });
        return;
      }

      if (grantType === 'refresh_token') {
        const presented = str('refresh_token');
        const parsed = presented ? parseOAuthToken(presented) : null;
        if (!parsed) {
          res.status(400).json({ error: 'invalid_grant' });
          return;
        }
        const existing = await findLiveToken(parsed.prefix, parsed.secret, 'REFRESH');
        if (!existing || existing.clientId !== clientId) {
          res.status(400).json({ error: 'invalid_grant' });
          return;
        }
        const worker = await getWorker(existing.workerId);
        if (!worker || worker.disabled) {
          res.status(400).json({ error: 'invalid_grant' });
          return;
        }
        // Rotation: the presented refresh token and anything minted from it are
        // revoked, so a stolen copy is usable at most once and its use is
        // visible the next time the real client tries.
        await revokeTokenChain(existing.id);
        await issueTokenPair(res, {
          clientId,
          workerId: existing.workerId,
          scope: existing.scope,
          resource: existing.resource,
        });
        await audit({
          action: 'OAUTH_TOKEN',
          actor: null,
          targetId: existing.workerId,
          result: 'SUCCESS',
          metadata: { clientId, grant: 'refresh_token' },
        });
        return;
      }

      res.status(400).json({ error: 'unsupported_grant_type' });
    })();
  });

  return router;
}

/* ------------------------------------------------------------------------ */
/* Token issuance                                                            */
/* ------------------------------------------------------------------------ */

async function issueTokenPair(
  res: Response,
  input: { clientId: string; workerId: string; scope: string; resource: string | null },
): Promise<void> {
  const access = generateOAuthToken();
  const refresh = generateOAuthToken();

  const refreshRow = await issueToken({
    kind: 'REFRESH',
    tokenPrefix: refresh.prefix,
    tokenDigest: refresh.digest,
    clientId: input.clientId,
    workerId: input.workerId,
    scope: input.scope,
    resource: input.resource,
    ttlMs: REFRESH_TOKEN_TTL_MS,
  });

  await issueToken({
    kind: 'ACCESS',
    tokenPrefix: access.prefix,
    tokenDigest: access.digest,
    clientId: input.clientId,
    workerId: input.workerId,
    scope: input.scope,
    resource: input.resource,
    ttlMs: ACCESS_TOKEN_TTL_MS,
    parentTokenId: refreshRow.id,
  });

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    access_token: access.plaintext,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refresh.plaintext,
    scope: input.scope,
  });
}

function basicCredentials(req: Request): { id: string; secret: string } | null {
  const header = req.header('authorization');
  if (!header) return null;
  const match = /^Basic\s+(.+)$/i.exec(header);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1]!.trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon === -1) return null;
    return {
      id: decodeURIComponent(decoded.slice(0, colon)),
      secret: decodeURIComponent(decoded.slice(colon + 1)),
    };
  } catch {
    return null;
  }
}

function basicClientId(req: Request): string | null {
  return basicCredentials(req)?.id ?? null;
}

function basicClientSecret(req: Request): string | null {
  return basicCredentials(req)?.secret ?? null;
}

/* ------------------------------------------------------------------------ */
/* Pages                                                                     */
/* ------------------------------------------------------------------------ */

/** The authorize parameters, carried through a form post unchanged. */
function hiddenFields(params: AuthorizeParams): string {
  const fields: [string, string][] = [
    ['response_type', 'code'],
    ['client_id', params.clientId],
    ['redirect_uri', params.redirectUri],
    ['code_challenge', params.codeChallenge],
    ['code_challenge_method', 'S256'],
    ['scope', params.scope],
  ];
  if (params.state) fields.push(['state', params.state]);
  if (params.resource) fields.push(['resource', params.resource]);
  return fields
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
    .join('');
}

function signInPage(
  _req: Request,
  params: AuthorizeParams,
  clientName: string,
  error: string | null,
): string {
  return page(
    'Sign in to connect a worker',
    card(`<h1>Sign in to the Brain</h1>
     <p class="sub">${esc(clientName)} is asking to connect as one of your workers.
       Sign in to choose which one.</p>
     ${error ? `<div class="err">${esc(error)}</div>` : ''}
     <form method="post" action="${OAUTH_BASE}/authorize/signin">
       ${hiddenFields(params)}
       <label for="email">Email</label>
       <input id="email" name="email" type="email" autocomplete="username" required autofocus>
       <label for="password">Password</label>
       <input id="password" name="password" type="password" autocomplete="current-password" required>
       <button type="submit">Sign in</button>
     </form>
     <p class="note">This is the same account you use for the Brain. Your password is
       never shared with ${esc(clientName)}.</p>`),
  );
}

/**
 * The consent screen somebody reaches through an invitation.
 *
 * One worker, named, with no way to choose another — the approval was made when
 * the invitation was created, and this page is where it is spent rather than
 * where it is decided. It shows what the worker can reach so the person
 * connecting can see what they are lending their account to, and it does not
 * name the projects' contents or anyone's account.
 */
function invitedConsentPage(
  req: Request,
  params: AuthorizeParams,
  clientName: string,
  worker: Worker,
): string {
  return page(
    'Connect',
    card(`<h1>Connect ${esc(worker.displayName)}</h1>
     <p class="sub"><strong>${esc(clientName)}</strong> is asking to act as this worker. It will get
       that worker's access — nothing more, and nothing of yours.</p>
     <div class="grant">
       <dt>Worker</dt><dd><code>${esc(worker.name)}</code></dd>
       <dt>You are</dt>
       <dd>connecting on an invitation. No Brain account is created for you, and you are not signing
         in to anything.</dd>
     </div>
     <form method="post" action="${OAUTH_BASE}/authorize/approve">
       ${hiddenFields(params)}
       <input type="hidden" name="worker_id" value="${esc(worker.id)}">
       <button type="submit">Approve</button>
     </form>
     <p class="note">Whoever invited you can withdraw this at any time, and doing so cuts the
       connection off on its next call. Nothing about your Claude account reaches this Brain — not a
       password, a cookie, or a session.</p>`),
  );
}

async function consentPage(
  _req: Request,
  params: AuthorizeParams,
  clientName: string,
  person: Principal,
  error: string | null,
): Promise<string> {
  /**
   * Disabled workers are not offered, but their existence changes what to say.
   *
   * Filtering first and then reporting an empty list as "no workers yet" tells
   * an operator whose only worker is disabled that the Brain has none — and
   * sends them off to create a duplicate at the exact moment they were trying
   * to restore the one they have. Which is what happened.
   */
  const allWorkers = await listWorkers();
  const workers = allWorkers.filter((worker) => !worker.disabled);
  const someAreDisabled = allWorkers.length > workers.length;

  // Each worker is shown with what it can actually reach, because "approve this
  // connection" is only a meaningful decision if the access it grants is on the
  // screen next to it.
  const described = await Promise.all(
    workers.map(async (worker) => {
      const memberships = (await listMembershipsForPrincipal('WORKER', worker.id)).filter((m) => m.active);
      const projects = await Promise.all(
        memberships.map(async (m) => {
          const project = await getProject(m.projectId);
          return { name: project?.name ?? m.projectId, scopes: m.scopes };
        }),
      );
      return { worker, projects };
    }),
  );

  const options = described
    .map(
      ({ worker, projects }) =>
        `<option value="${esc(worker.id)}">${esc(worker.displayName)} — ${esc(worker.name)}${
          projects.length === 0 ? ' (no project yet)' : ` (${esc(projects.map((p) => p.name).join(', '))})`
        }</option>`,
    )
    .join('');

  const grants = described
    .filter(({ projects }) => projects.length > 0)
    .map(
      ({ worker, projects }) =>
        `<dt>${esc(worker.name)}</dt><dd>${projects
          .map((p) => `${esc(p.name)} — <code>${esc(p.scopes.join(' '))}</code>`)
          .join('<br>')}</dd>`,
    )
    .join('');

  return page(
    'Connect a worker',
    card(`<h1>Connect a worker</h1>
     <p class="sub"><strong>${esc(clientName)}</strong> is asking to act as one of your Brain
       workers. It will get that worker's access — nothing more, and nothing of yours.</p>
     ${error ? `<div class="err">${esc(error)}</div>` : ''}
     ${
       workers.length === 0
         ? someAreDisabled
           ? `<div class="err">Every worker in this Brain is disabled. Enable one in the operator
              console and try again — you do not need to create another.</div>`
           : `<div class="err">This Brain has no workers yet. Create one first.</div>`
         : `<form method="post" action="${OAUTH_BASE}/authorize/approve">
       ${hiddenFields(params)}
       <label for="worker_id">Connect as</label>
       <select id="worker_id" name="worker_id" required>${options}</select>
       <div class="grant"><dl>${grants || '<dt>No access</dt><dd>None of these workers has a project yet.</dd>'}</dl></div>
       <button type="submit">Approve</button>
     </form>`
     }
     <p class="note">Approving as <strong>${esc(person.handle)}</strong>.
       ${esc(clientName)} never sees your password or your own access — it receives a
       token for the worker you choose, which you can revoke at any time.</p>`),
  );
}

/* ------------------------------------------------------------------------ */
/* Discovery                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * The two metadata documents, mounted at the root rather than under /oauth
 * because RFC 9728 and RFC 8414 both put them at fixed well-known paths.
 *
 * Unauthenticated on purpose: a client that has no token yet has to be able to
 * find out how to get one, and neither document says anything about this
 * installation beyond the endpoints it already serves.
 */
export function wellKnownRouter(mcpPath: string): RequestHandler {
  const router = Router();

  router.get('/oauth-protected-resource', (req: Request, res: Response) => {
    const issuer = issuerFor(req);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      resource: `${issuer}${mcpPath}`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      resource_documentation: `${issuer}/`,
    });
  });

  // Some clients look for the resource metadata suffixed with the resource
  // path. Answering both costs nothing and saves a failed discovery.
  router.get(`/oauth-protected-resource${mcpPath}`, (req: Request, res: Response) => {
    const issuer = issuerFor(req);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      resource: `${issuer}${mcpPath}`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
    });
  });

  const asMetadata = (req: Request, res: Response): void => {
    const issuer = issuerFor(req);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      issuer,
      authorization_endpoint: `${issuer}${OAUTH_BASE}/authorize`,
      token_endpoint: `${issuer}${OAUTH_BASE}/token`,
      registration_endpoint: `${issuer}${OAUTH_BASE}/register`,
      scopes_supported: [],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      // S256 only. `plain` is refused at the authorize endpoint, so advertising
      // it would be advertising something that does not work.
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    });
  };

  router.get('/oauth-authorization-server', asMetadata);
  router.get('/openid-configuration', asMetadata);

  return router;
}

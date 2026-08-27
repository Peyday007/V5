/**
 * The operator console: workers, their access, and their live connections.
 *
 * This exists because of a gap Step 8 found rather than a feature anybody asked
 * for. The Step 4 administration API can create a worker, grant it a project
 * and issue it a credential — but only over HTTP. With no screen, the only ways
 * to do it were `curl` from a terminal or a step in a CI job, and both put a
 * plaintext credential somewhere the security rules forbid: a shell history, a
 * scrollback buffer, a workflow log.
 *
 * So the credential has to be creatable, and readable exactly once, **inside a
 * browser the operator already trusts**. That is the whole justification for
 * these pages.
 *
 * They are deliberately plain server-rendered HTML with no JavaScript, for the
 * reason given in `pages.ts`: this is the surface you need when something is
 * broken, and it must not depend on the client bundle having built.
 *
 * Everything here goes through the same Step 4 services the HTTP API uses.
 * There is no privileged path, and no operation available here that an
 * administrator could not already perform.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { authenticateRequest, originIsSameSite } from '../services/identity/authenticate.ts';
import {
  createWorker,
  getWorker,
  getWorkerByName,
  grantMembership,
  issueWorkerCredential,
  listMembershipsForPrincipal,
  listWorkers,
  recordIdentityEvent,
  setWorkerStatus,
} from '../repos/identity.ts';
import { listTokensForWorker, revokeTokensForWorker } from '../repos/oauth.ts';
import { createProject, getProjectBySlug, listProjects } from '../repos/projects.ts';
import { WORKER_SCOPES } from '../domain/types.ts';
import type { Principal, WorkerScope } from '../domain/types.ts';
import { card, esc, page } from './pages.ts';

export const OPERATOR_BASE = '/operator';

/**
 * Who is at the console, and what to do about it.
 *
 * Three outcomes rather than two, and the third one exists because the first
 * version of this got it wrong.
 *
 *   `ADMIN`      — proceed.
 *   `ANONYMOUS`  — nobody is signed in. Offer a sign-in form.
 *   `DENIED`     — somebody *is* signed in and may not be here. 404.
 *
 * The original returned only admin-or-nothing and rendered a bare "Not found"
 * for both of the last two. That hid the console from strangers, which was the
 * point — and it also meant an administrator whose eight-hour session had
 * quietly expired saw a page telling them the console did not exist, with
 * nothing to click and no way to find out why. A security control that is
 * indistinguishable from a broken deployment costs more than it saves.
 *
 * Offering a sign-in form to an anonymous visitor discloses nothing: the Brain
 * already serves a sign-in page at its root to the whole internet. What must
 * stay hidden is whether this *particular path* is anything, to somebody who
 * has already proved they are not an administrator — and that case still gets
 * the 404.
 *
 * A bearer token is refused outright in all three cases. A worker holding a
 * credential must never reach the screen that grants credentials; that is a
 * machine widening its own access, and it is the worst thing this console
 * could allow.
 */
type ConsoleAccess =
  | { state: 'ADMIN'; principal: Principal }
  | { state: 'ANONYMOUS' }
  | { state: 'DENIED' };

async function consoleAccess(req: Request): Promise<ConsoleAccess> {
  if (req.header('authorization')) return { state: 'DENIED' };
  const outcome = await authenticateRequest(req);
  if (!outcome.ok) {
    // No credential at all is "not signed in". A *rejected* one — expired,
    // revoked, disabled — is also not signed in, and offering the form is the
    // useful answer to both.
    return { state: 'ANONYMOUS' };
  }
  if (outcome.principal.type !== 'HUMAN') return { state: 'DENIED' };
  if (!outcome.principal.isBrainAdmin) return { state: 'DENIED' };
  if (outcome.principal.mustChangePassword) return { state: 'DENIED' };
  return { state: 'ADMIN', principal: outcome.principal };
}

/** The mutating routes need admin or nothing; there is no form to offer a POST. */
async function administrator(req: Request): Promise<Principal | null> {
  const access = await consoleAccess(req);
  return access.state === 'ADMIN' ? access.principal : null;
}

function signInPage(error: string | null): string {
  return page(
    'Sign in',
    card(`<h1>Sign in</h1>
      <p class="sub">The worker console needs a Brain administrator.</p>
      ${error ? `<div class="err">${esc(error)}</div>` : ''}
      <form method="post" action="${OPERATOR_BASE}/signin">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required autofocus>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button type="submit">Sign in</button>
      </form>
      <p class="note">This is the same account you use for the Brain.</p>`),
  );
}

async function audit(input: {
  actor: Principal;
  action: string;
  targetId: string | null;
  result: 'SUCCESS' | 'DENIED' | 'FAILED';
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await recordIdentityEvent({
      actorType: input.actor.type,
      actorId: input.actor.id,
      credentialId: input.actor.credentialId,
      action: input.action,
      targetType: 'WORKER',
      targetId: input.targetId,
      result: input.result,
      // Ids and categories only — never a credential, never a token.
      metadata: input.metadata ?? {},
    });
  } catch {
    // Losing the record must not turn the operation into something else.
  }
}

function denied(res: Response): void {
  res.status(404).type('html').send(
    page('Not found', card('<h1>Not found</h1><p class="sub">There is nothing here.</p>')),
  );
}

/* ------------------------------------------------------------------------ */
/* Rendering                                                                 */
/* ------------------------------------------------------------------------ */

interface Flash {
  ok?: string;
  err?: string;
  /** Shown exactly once, and never stored anywhere. */
  secret?: { workerName: string; plaintext: string };
}

async function consolePage(person: Principal, flash: Flash = {}): Promise<string> {
  const workers = await listWorkers();
  const projects = await listProjects();

  const described = await Promise.all(
    workers.map(async (worker) => {
      const memberships = (await listMembershipsForPrincipal('WORKER', worker.id)).filter((m) => m.active);
      const rows = await Promise.all(
        memberships.map(async (m) => {
          const project = projects.find((p) => p.id === m.projectId);
          return { projectId: m.projectId, name: project?.name ?? m.projectId, scopes: m.scopes };
        }),
      );
      const tokens = (await listTokensForWorker(worker.id)).filter(
        (t) => t.kind === 'ACCESS' && t.revokedAt === null && t.expiresAt > new Date().toISOString(),
      );
      return { worker, rows, liveConnections: tokens.length };
    }),
  );

  const workerRows = described
    .map(
      ({ worker, rows, liveConnections }) => `
      <div class="row">
        <div>
          <div class="who"><strong>${esc(worker.displayName)}</strong>
            <span class="pill${worker.disabled ? ' off' : ''}">${worker.disabled ? 'disabled' : 'active'}</span></div>
          <div class="meta"><code>${esc(worker.name)}</code>${
            rows.length === 0
              ? ' · no project yet'
              : ` · ${rows.map((r) => `${esc(r.name)} (${esc(r.scopes.join(' '))})`).join('; ')}`
          }${liveConnections > 0 ? ` · ${liveConnections} live connection(s)` : ''}</div>
        </div>
        <form method="post" action="${OPERATOR_BASE}/workers/${esc(worker.id)}/disabled">
          <input type="hidden" name="disabled" value="${worker.disabled ? 'false' : 'true'}">
          <button type="submit" class="${worker.disabled ? 'secondary' : 'danger'}">
            ${worker.disabled ? 'Enable' : 'Disable'}</button>
        </form>
      </div>`,
    )
    .join('');

  const projectOptions = projects
    .map((project) => `<option value="${esc(project.id)}">${esc(project.name)}</option>`)
    .join('');

  const workerOptions = workers
    .filter((worker) => !worker.disabled)
    .map((worker) => `<option value="${esc(worker.id)}">${esc(worker.name)}</option>`)
    .join('');

  const scopeBoxes = WORKER_SCOPES.map(
    (scope) =>
      `<label><input type="checkbox" name="scopes" value="${esc(scope)}"> <code>${esc(scope)}</code></label>`,
  ).join('');

  const secretCard = flash.secret
    ? card(`<h2>Credential for ${esc(flash.secret.workerName)}</h2>
        <div class="ok">This is the only time it will ever be shown. Copy it now.</div>
        <p><code style="word-break:break-all;user-select:all">${esc(flash.secret.plaintext)}</code></p>
        <p class="note">Paste it straight into wherever it is needed, or into a password manager.
          Do not put it in a chat, a document, a terminal or a repository. The Brain kept only a
          hash of it and cannot show it again — if it is lost, issue a new one and revoke this.</p>
        <p class="note"><strong>You probably do not need this.</strong> A Claude connector
          authenticates through <em>Connect a worker</em> instead, where no secret is handled by
          hand at all. This is for a worker that cannot do OAuth.</p>`)
    : '';

  return page(
    'Workers',
    `${card(`<h1>Workers</h1>
      <p class="sub">Machine identities that can act in this Brain. Signed in as
        <strong>${esc(person.handle)}</strong>.</p>
      ${flash.err ? `<div class="err">${esc(flash.err)}</div>` : ''}
      ${flash.ok ? `<div class="ok">${esc(flash.ok)}</div>` : ''}
      ${workerRows || '<p class="sub">No workers yet.</p>'}`)}
     ${secretCard}
     ${card(`<h2>Create a worker</h2>
       <form method="post" action="${OPERATOR_BASE}/workers">
         <label for="name">Canonical name</label>
         <input id="name" name="name" type="text" required placeholder="claude-max-worker-01"
           pattern="[a-z0-9][a-z0-9-]*" title="Lower case letters, digits and hyphens.">
         <label for="displayName">Display name</label>
         <input id="displayName" name="displayName" type="text" required placeholder="Claude Max Worker 01">
         <button type="submit">Create</button>
       </form>
       <p class="note">A worker is not a person and not a Claude account. It is an identity this
         Brain owns, which you then grant access to one project at a time.</p>`)}
     ${card(`<h2>Create a project</h2>
       <form method="post" action="${OPERATOR_BASE}/projects">
         <label for="project_name">Name</label>
         <input id="project_name" name="name" type="text" required placeholder="Step 8 Acceptance">
         <button type="submit" class="secondary">Create</button>
       </form>
       <p class="note">An empty project with no layers, for pointing a worker at something
         isolated. A test worker should never be granted the project holding real research —
         a mistake there writes fabricated findings into work you rely on.</p>`)}
     ${
       workers.length > 0 && projects.length > 0
         ? card(`<h2>Grant access</h2>
       <form method="post" action="${OPERATOR_BASE}/memberships">
         <label for="worker_id">Worker</label>
         <select id="worker_id" name="worker_id" required>${workerOptions}</select>
         <label for="project_id">Project</label>
         <select id="project_id" name="project_id" required>${projectOptions}</select>
         <fieldset><legend>Scopes</legend><div class="scopes">${scopeBoxes}</div></fieldset>
         <button type="submit">Grant</button>
       </form>
       <p class="note">Grant the fewest scopes the work actually needs. A worker administers
         nothing regardless of what is ticked here — administration is refused to a worker
         principal outright.</p>`)
         : ''
     }
     ${
       workers.length > 0
         ? card(`<h2>Issue a credential</h2>
       <form method="post" action="${OPERATOR_BASE}/credentials">
         <label for="cred_worker">Worker</label>
         <select id="cred_worker" name="worker_id" required>${workerOptions}</select>
         <button type="submit" class="secondary">Issue</button>
       </form>
       <p class="note">Only for a client that cannot do OAuth. Claude connects through
         <em>Connect a worker</em>, which handles this without a secret ever being copied.</p>`)
         : ''
     }`,
  );
}

/* ------------------------------------------------------------------------ */
/* Routes                                                                    */
/* ------------------------------------------------------------------------ */

export function operatorRouter(): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const access = await consoleAccess(req);
      if (access.state === 'ANONYMOUS') {
        res.status(401).type('html').send(signInPage(null));
        return;
      }
      // Somebody who is signed in and may not be here gets the same answer as a
      // route that does not exist. A console that confirms its own existence to
      // a non-administrator is a map of what to attack.
      if (access.state === 'DENIED') {
        denied(res);
        return;
      }
      res.type('html').send(await consolePage(access.principal));
    })();
  });

  /**
   * Sign in, and land back on the console.
   *
   * Delegated to the application's own sign-in endpoint rather than
   * reimplemented, so there is one implementation of "is this password right",
   * with one throttle behind it. The redirect afterwards is what makes the
   * browser re-ask with the cookie it has just been given.
   */
  router.post('/signin', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      if (!originIsSameSite(req)) {
        denied(res);
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const email = typeof body['email'] === 'string' ? body['email'] : '';
      const password = typeof body['password'] === 'string' ? body['password'] : '';
      const origin = `${req.protocol}://${req.get('host') ?? 'localhost'}`;

      const signIn = await fetch(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ email, password }),
      });
      if (!signIn.ok) {
        // One message for every reason, as everywhere else.
        res.status(401).type('html').send(signInPage('That email address and password were not accepted.'));
        return;
      }
      const setCookie = signIn.headers.get('set-cookie');
      if (setCookie) res.setHeader('Set-Cookie', setCookie);
      res.redirect(303, OPERATOR_BASE);
    })();
  });

  router.post('/workers', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const person = await administrator(req);
      if (!person || !originIsSameSite(req)) {
        denied(res);
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
      const displayName = typeof body['displayName'] === 'string' ? body['displayName'].trim() : '';

      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        res.status(400).type('html').send(
          await consolePage(person, { err: 'A canonical name is lower case letters, digits and hyphens.' }),
        );
        return;
      }
      if (await getWorkerByName(name)) {
        res.status(409).type('html').send(
          await consolePage(person, { err: `There is already a worker called ${name}.` }),
        );
        return;
      }

      const worker = await createWorker({
        name,
        displayName: displayName || name,
        workerType: 'MCP',
        description: null,
        createdByType: person.type,
        createdById: person.id,
      });
      await audit({ actor: person, action: 'CREATE_WORKER', targetId: worker.id, result: 'SUCCESS', metadata: { name } });
      res.type('html').send(
        await consolePage(person, { ok: `Created ${name}. Now grant it a project.` }),
      );
    })();
  });

  /**
   * Create an empty project.
   *
   * This is the one thing here that is not identity, and it earns its place by
   * what it prevents. Until now a project could only come from the seeder, so
   * the only project that existed was the one holding real research — and the
   * sole way to give a test worker somewhere to work would have been to grant
   * it that one. An isolated project is what stops a worker's first bounded run
   * writing fabricated findings into work somebody depends on.
   *
   * It creates a project and nothing else: no layers, no documents, no seed.
   */
  router.post('/projects', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const person = await administrator(req);
      if (!person || !originIsSameSite(req)) {
        denied(res);
        return;
      }
      const name = typeof (req.body as Record<string, unknown>)['name'] === 'string'
        ? String((req.body as Record<string, unknown>)['name']).trim()
        : '';
      if (name.length < 2 || name.length > 120) {
        res.status(400).type('html').send(
          await consolePage(person, { err: 'A project name is between 2 and 120 characters.' }),
        );
        return;
      }

      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (await getProjectBySlug(slug)) {
        res.status(409).type('html').send(
          await consolePage(person, { err: `There is already a project at "${slug}".` }),
        );
        return;
      }

      const project = await createProject({ name });
      await audit({
        actor: person,
        action: 'CREATE_PROJECT',
        targetId: project.id,
        result: 'SUCCESS',
        metadata: { slug: project.slug },
      });
      res.type('html').send(
        await consolePage(person, { ok: `Created "${project.name}". It has no layers and no documents.` }),
      );
    })();
  });

  router.post('/memberships', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const person = await administrator(req);
      if (!person || !originIsSameSite(req)) {
        denied(res);
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const workerId = typeof body['worker_id'] === 'string' ? body['worker_id'] : '';
      const projectId = typeof body['project_id'] === 'string' ? body['project_id'] : '';
      // A single checkbox arrives as a string, several as an array.
      const raw = body['scopes'];
      const requested = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];

      // Matched exactly against the enum. An unknown scope is refused rather
      // than dropped, so a typo cannot look like a successful narrower grant.
      const scopes: WorkerScope[] = [];
      for (const scope of requested) {
        if (typeof scope !== 'string' || !(WORKER_SCOPES as readonly string[]).includes(scope)) {
          res.status(400).type('html').send(await consolePage(person, { err: 'Unknown scope.' }));
          return;
        }
        scopes.push(scope as WorkerScope);
      }

      const worker = await getWorker(workerId);
      if (!worker) {
        res.status(404).type('html').send(await consolePage(person, { err: 'No such worker.' }));
        return;
      }

      await grantMembership({
        projectId,
        principalType: 'WORKER',
        principalId: workerId,
        role: null,
        scopes,
        grantedByType: person.type,
        grantedById: person.id,
      });
      await audit({
        actor: person,
        action: 'GRANT_MEMBERSHIP',
        targetId: workerId,
        result: 'SUCCESS',
        metadata: { projectId, scopeCount: scopes.length },
      });
      res.type('html').send(
        await consolePage(person, { ok: `${worker.name} can now reach that project.` }),
      );
    })();
  });

  router.post('/workers/:workerId/disabled', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const person = await administrator(req);
      if (!person || !originIsSameSite(req)) {
        denied(res);
        return;
      }
      const workerId = req.params['workerId'] ?? '';
      const worker = await getWorker(workerId);
      if (!worker) {
        denied(res);
        return;
      }
      const disable = (req.body as Record<string, unknown>)['disabled'] === 'true';
      await setWorkerStatus(workerId, disable ? 'DISABLED' : 'ACTIVE');

      // Disabling ends live connections rather than leaving them running until
      // their tokens expire. Authentication checks the worker's status on every
      // request as well; this is the second of two locks.
      const revoked = disable ? await revokeTokensForWorker(workerId) : 0;

      await audit({
        actor: person,
        action: disable ? 'DISABLE_WORKER' : 'ENABLE_WORKER',
        targetId: workerId,
        result: 'SUCCESS',
        metadata: { name: worker.name, tokensRevoked: revoked },
      });
      res.type('html').send(
        await consolePage(person, {
          ok: disable
            ? `${worker.name} is disabled${revoked > 0 ? ` and ${revoked} connection(s) were ended` : ''}.`
            : `${worker.name} is active again. It will need to be connected again.`,
        }),
      );
    })();
  });

  router.post('/credentials', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const person = await administrator(req);
      if (!person || !originIsSameSite(req)) {
        denied(res);
        return;
      }
      const workerId = typeof (req.body as Record<string, unknown>)['worker_id'] === 'string'
        ? String((req.body as Record<string, unknown>)['worker_id'])
        : '';
      const worker = await getWorker(workerId);
      if (!worker) {
        res.status(404).type('html').send(await consolePage(person, { err: 'No such worker.' }));
        return;
      }

      const issued = await issueWorkerCredential({
        workerId,
        issuedByType: person.type,
        issuedById: person.id,
      });
      await audit({
        actor: person,
        action: 'ISSUE_CREDENTIAL',
        targetId: workerId,
        result: 'SUCCESS',
        // The credential id, never the credential.
        metadata: { credentialId: issued.credential.id },
      });

      // Rendered once, into this response, and never stored or logged.
      res.type('html').send(
        await consolePage(person, {
          secret: { workerName: worker.name, plaintext: issued.plaintext },
        }),
      );
    })();
  });

  return router;
}

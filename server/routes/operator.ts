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
  archiveWorker,
  createWorker,
  getWorker,
  getWorkerByName,
  grantMembership,
  issueWorkerCredential,
  listMembershipsForPrincipal,
  listWorkers,
  recordIdentityEvent,
  revokeMembership,
  setWorkerStatus,
} from '../repos/identity.ts';
import { listTokensForWorker, revokeTokensForWorker } from '../repos/oauth.ts';
import { createInvitation } from '../repos/invitations.ts';
import { createProject, getProject, getProjectBySlug, listProjects } from '../repos/projects.ts';
import { PayloadTooLarge, enqueueWork, listWorkItems } from '../repos/workQueue.ts';
import { InvalidWorkPayload, workType } from '../services/queue/workTypes.ts';
import { CONNECTOR_SCOPES } from '../domain/types.ts';
import type { Principal, WorkItem, WorkerScope } from '../domain/types.ts';
import { generateInvitationToken } from '../services/identity/secrets.ts';
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
  /**
   * What the id names. Most of this console acts on workers, but not all of it
   * — and an audit row that says WORKER over a project id is a record that
   * cannot be read back correctly, which is worse than no record at all.
   */
  targetType?: 'WORKER' | 'PROJECT' | 'WORK_ITEM';
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
      targetType: input.targetType ?? 'WORKER',
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
  /** Also shown exactly once: an invitation link is a credential in a URL. */
  invite?: { workerName: string; url: string; expiresAt: string };
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

  /**
   * One line per membership, each with its own way out.
   *
   * Granting without revoking is not access control, it is a ratchet. This
   * console could give a worker a project and had no way to take it back —
   * revoking existed only over HTTP, so the first misclick on the dropdown was
   * a mistake the screen that caused it could not undo. That happened, on the
   * project holding real research.
   */
  const membershipLines = (
    worker: { id: string },
    rows: { projectId: string; name: string; scopes: string[] }[],
  ): string =>
    rows
      .map(
        (row) => `
        <div class="access">
          <span class="meta">${esc(row.name)} <code>${esc(row.scopes.join(' '))}</code></span>
          <form method="post" action="${OPERATOR_BASE}/memberships/revoke">
            <input type="hidden" name="worker_id" value="${esc(worker.id)}">
            <input type="hidden" name="project_id" value="${esc(row.projectId)}">
            <button type="submit" class="danger">Remove</button>
          </form>
        </div>`,
      )
      .join('');

  const workerRows = described
    .map(
      ({ worker, rows, liveConnections }) => `
      <div class="row">
        <div>
          <div class="who"><strong>${esc(worker.displayName)}</strong>
            <span class="pill${worker.disabled ? ' off' : ''}">${worker.disabled ? 'disabled' : 'active'}</span></div>
          <div class="meta"><code>${esc(worker.name)}</code>${
            rows.length === 0 ? ' · no project yet' : ''
          }${liveConnections > 0 ? ` · ${liveConnections} live connection(s)` : ''}</div>
          ${membershipLines(worker, rows)}
        </div>
        <div class="actions">
          <form method="post" action="${OPERATOR_BASE}/workers/${esc(worker.id)}/disabled">
            <input type="hidden" name="disabled" value="${worker.disabled ? 'false' : 'true'}">
            <button type="submit" class="${worker.disabled ? 'secondary' : 'danger'}">
              ${worker.disabled ? 'Enable' : 'Disable'}</button>
          </form>
          <form method="post" action="${OPERATOR_BASE}/workers/${esc(worker.id)}/invite">
            <button type="submit" class="secondary">Invite</button>
          </form>
          <form method="post" action="${OPERATOR_BASE}/workers/${esc(worker.id)}/archive">
            <input type="hidden" name="confirm" value="${esc(worker.name)}">
            <button type="submit" class="danger">Remove</button>
          </form>
        </div>
      </div>`,
    )
    .join('');

  /**
   * Every select starts on a placeholder that cannot be submitted.
   *
   * A `<select>` with no placeholder is pre-set to its first option, so a form
   * submitted without touching it silently grants whatever happened to sort
   * first. That is how a worker meant for a throwaway project was granted the
   * one holding real research: the dropdown was never opened, and the page gave
   * no sign that a choice had been made for you.
   *
   * `disabled selected value=""` plus `required` turns that silent default into
   * a refusal the browser makes before anything is sent.
   */
  const CHOOSE = '<option value="" disabled selected>— choose —</option>';

  const projectOptions =
    CHOOSE +
    projects
      .map((project) => `<option value="${esc(project.id)}">${esc(project.name)}</option>`)
      .join('');

  /**
   * Queued and in-flight work, per project.
   *
   * Shown because "did the item get created" is otherwise unanswerable from a
   * browser, and an operator who cannot see the queue has no way to tell a
   * worker that has not started from an item that was never enqueued.
   */
  const queues = await Promise.all(
    projects.map(async (project) => ({
      project,
      items: await listWorkItems(project.id, {
        states: ['QUEUED', 'LEASED', 'SUCCEEDED', 'FAILED'],
        limit: 8,
      }),
    })),
  );
  const queueRows = queues
    .filter((entry) => entry.items.length > 0)
    .map(
      (entry) => `
      <div class="row">
        <div>
          <div class="who"><strong>${esc(entry.project.name)}</strong></div>
          <div class="meta">${entry.items
            .map(
              (item) =>
                `<code>${esc(item.id)}</code> ${esc(item.workType)} · ${esc(item.state)}` +
                (item.attemptCount > 0 ? ` · attempt ${item.attemptCount}` : ''),
            )
            .join('<br>')}</div>
        </div>
      </div>`,
    )
    .join('');

  const workerOptions =
    CHOOSE +
    workers
      .filter((worker) => !worker.disabled)
      .map((worker) => `<option value="${esc(worker.id)}">${esc(worker.name)}</option>`)
      .join('');

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

  const inviteCard = flash.invite
    ? card(`<h2>Invitation for ${esc(flash.invite.workerName)}</h2>
        <div class="ok">Send this link to whoever is lending the account. It is shown once.</div>
        <p><code style="word-break:break-all;user-select:all">${esc(flash.invite.url)}</code></p>
        <p class="note">They open it, then add the connector in their own Claude and click Connect.
          They never sign in here, never get an account, and can connect only that one worker, once.
          It expires ${esc(flash.invite.expiresAt.slice(0, 10))}.</p>
        <p class="note">Treat it like a password until it is used: anyone holding it can connect
          that worker. If it goes astray, remove the worker or wait for it to expire — and a used
          invitation is dead, so a link that has already been redeemed is harmless.</p>`)
    : '';

  return page(
    'Workers',
    `${card(`<h1>Workers</h1>
      <p class="sub">Machine identities that can act in this Brain. Signed in as
        <strong>${esc(person.handle)}</strong>.</p>
      ${flash.err ? `<div class="err">${esc(flash.err)}</div>` : ''}
      ${flash.ok ? `<div class="ok">${esc(flash.ok)}</div>` : ''}
      ${workerRows || '<p class="sub">No workers yet.</p>'}
      ${
        workerRows
          ? `<p class="note"><strong>Disable</strong> pauses a worker and can be undone.
             <strong>Remove</strong> cannot: it revokes the worker's credentials, its connections
             and every project it can reach, then retires it permanently. The name stays taken and
             the audit trail stays readable — what goes away is the worker.</p>`
          : ''
      }`)}
     ${inviteCard}
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
         <button type="submit">Grant</button>
       </form>
       <p class="note">The Brain sets what the worker may do — exactly what the remote tools
         require and nothing else. There is no list to compose, because composing it was a job with
         no judgement in it and two ways to get wrong, and both happened here within ten minutes of
         this screen existing.</p>
       <p class="note">A worker administers nothing regardless. It cannot create work, cancel work,
         or reach a project it was not granted — that is decided in the policy, not here.</p>`)
         : ''
     }
     ${
       projects.length > 0
         ? card(`<h2>Give a worker something to do</h2>
       <form method="post" action="${OPERATOR_BASE}/work">
         <label for="work_project">Project</label>
         <select id="work_project" name="project_id" required>${projectOptions}</select>
         <label for="work_note">Note</label>
         <input id="work_note" name="note" type="text" maxlength="500"
           placeholder="Step 8 acceptance item">
         <button type="submit">Queue a synthetic echo</button>
       </form>
       <form method="post" action="${OPERATOR_BASE}/work/summarize">
         <label for="sum_project">Project</label>
         <select id="sum_project" name="project_id" required>${projectOptions}</select>
         <label for="sum_passage">Passage for the worker to read</label>
         <textarea id="sum_passage" name="passage" rows="4" maxlength="4000" required
           placeholder="Paste a paragraph. The worker has to actually read it."></textarea>
         <label for="sum_question">Question (optional)</label>
         <input id="sum_question" name="question" type="text" maxlength="500"
           placeholder="What should it tell you about the passage?">
         <button type="submit" class="secondary">Queue a real reading</button>
       </form>
       <p class="note">Two kinds. <code>SYNTHETIC_ECHO</code> hands a note back, so it proves the
         queue and nothing else — a worker that never read it would look identical to one that did.
         <code>SUMMARIZE_PASSAGE</code> cannot be faked: the worker has to read the passage and
         produce something that depends on it, which costs a little of that account's allowance.
         That cost is the point, because a test that spends nothing has not tested the part where
         spending happens.</p>
       <p class="note">Both stay inside the boundary this queue requires. It is at-least-once, so
         everything it carries must be safe to perform twice — the passage travels in the item,
         nothing is fetched, no document is touched, and a repeat cannot record a second result.</p>
       <p class="note">A worker cannot enqueue its own work. Enqueueing is a project write with no
         scope that grants it, so a machine credential is refused here however it is configured —
         which is why this box exists at all.</p>`)
         : ''
     }
     ${queueRows ? card(`<h2>The queue</h2>${queueRows}`) : ''}
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
   * **Scaffolding**, for the same reason as queueing below: projects had come
   * only from the seeder, so there was no way to make one without a terminal.
   * It belongs in the Brain proper, and Step 12 moves it.
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
        targetType: 'PROJECT',
        targetId: project.id,
        result: 'SUCCESS',
        metadata: { slug: project.slug },
      });
      res.type('html').send(
        await consolePage(person, { ok: `Created "${project.name}". It has no layers and no documents.` }),
      );
    })();
  });

  /**
   * Queue one bounded item, so a worker has something to claim.
   *
   * **Scaffolding.** In the finished product the planner decides what work
   * exists and workers pull it from the queue; nobody hand-queues an item. This
   * box exists because there was no way to put work in the queue from a browser
   * at all, and the alternative was `curl`. Step 12 removes it — see
   * docs/ROADMAP.md. Do not build on it.
   *
   * The same gap as project creation, one step further along: an operator with
   * a connected worker and an empty queue has nothing to point it at, and the
   * only way to put an item there was `curl` — a terminal, for the operation
   * whose whole purpose is proving the browser path works.
   *
   * A worker cannot do this for itself. Enqueueing is a project write and no
   * worker scope grants it, so `decideProjectAccess` refuses a worker principal
   * whatever is ticked on its membership. That is the right shape — a machine
   * that could create its own work could also create work nobody asked for —
   * and it is exactly why a human needs a button.
   *
   * It goes through the same registry the HTTP route uses, so an unregistered
   * type or an oversized payload is refused here for the same reason and with
   * the same message.
   */
  router.post('/work', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const person = await administrator(req);
      if (!person || !originIsSameSite(req)) {
        denied(res);
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const projectId = typeof body['project_id'] === 'string' ? body['project_id'] : '';
      const note = typeof body['note'] === 'string' ? body['note'].trim() : '';

      const project = await getProject(projectId);
      if (!project) {
        res.status(404).type('html').send(await consolePage(person, { err: 'No such project.' }));
        return;
      }

      const definition = workType('SYNTHETIC_ECHO');
      let payload: Record<string, unknown>;
      try {
        payload = definition.validate({ note: note || 'acceptance item' });
      } catch (error) {
        if (error instanceof InvalidWorkPayload) {
          res.status(400).type('html').send(await consolePage(person, { err: error.message }));
          return;
        }
        throw error;
      }

      let item: WorkItem;
      try {
        item = await enqueueWork({
          projectId: project.id,
          workType: definition.type,
          payload,
          requiredScopes: definition.requiredScopes,
          maxAttempts: definition.defaultMaxAttempts,
          createdByType: person.type,
          createdById: person.id,
        });
      } catch (error) {
        if (error instanceof PayloadTooLarge) {
          res.status(400).type('html').send(await consolePage(person, { err: error.message }));
          return;
        }
        throw error;
      }

      await audit({
        actor: person,
        action: 'QUEUE_ENQUEUE',
        targetType: 'WORK_ITEM',
        targetId: item.id,
        result: 'SUCCESS',
        metadata: { projectId: project.id, workType: item.workType },
      });
      res.type('html').send(
        await consolePage(person, {
          ok: `Queued ${item.id} in "${project.name}". A worker holding queue:claim there can take it.`,
        }),
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
      // The Brain composes the set; this form only names a worker and a project.
      //
      // A posted `scopes` field is ignored rather than honoured. The console
      // stopped asking, so anything arriving under that name came from a hand-
      // edited form, and quietly accepting it would put back the exact hazard
      // the picker was removed for — with no screen left to show what happened.
      const scopes: WorkerScope[] = [...CONNECTOR_SCOPES];

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

  /**
   * Take a project away from a worker.
   *
   * Granting without revoking is a ratchet rather than access control, and this
   * console was one: it could hand a worker any project and had no way back,
   * because revoking lived only on the HTTP API. So the first mis-set dropdown
   * granted a test worker the project holding real research, and the screen
   * that did it could not undo it.
   *
   * Revoking is not a weaker membership. The row is marked revoked and
   * `listMembershipsForPrincipal` reads live rows only, so the project stops
   * existing for that worker on its very next call — memberships are read per
   * request rather than frozen into a token, so there is nothing to wait for
   * and nothing to reconnect.
   */
  /**
   * Queue work that the worker has to actually read.
   *
   * `SYNTHETIC_ECHO` proves the queue. It cannot prove that a worker did
   * anything, because handing a note back looks the same whether the passage
   * was read or ignored — which is right for testing claiming and leases, and
   * useless for finding out whether real work flows through the connection.
   *
   * This one costs a little of the connected account's allowance, and that is
   * the point: an end-to-end test that spends nothing has not tested the part
   * where spending happens.
   *
   * It is still inside the boundary the queue requires. The passage travels in
   * the item, bounded, so nothing is fetched and no document is touched, and a
   * redelivery re-reads the same text — the wording of a second summary may
   * differ, and it cannot be recorded, because completion is idempotent by work
   * item.
   */
  router.post('/work/summarize', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const person = await administrator(req);
      if (!person || !originIsSameSite(req)) {
        denied(res);
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const project = await getProject(typeof body['project_id'] === 'string' ? body['project_id'] : '');
      if (!project) {
        res.status(404).type('html').send(await consolePage(person, { err: 'No such project.' }));
        return;
      }

      const definition = workType('SUMMARIZE_PASSAGE');
      let payload: Record<string, unknown>;
      try {
        payload = definition.validate({
          passage: typeof body['passage'] === 'string' ? body['passage'].trim() : '',
          ...(typeof body['question'] === 'string' && body['question'].trim().length > 0
            ? { question: body['question'].trim() }
            : {}),
        });
      } catch (error) {
        if (error instanceof InvalidWorkPayload) {
          res.status(400).type('html').send(await consolePage(person, { err: error.message }));
          return;
        }
        throw error;
      }

      let item: WorkItem;
      try {
        item = await enqueueWork({
          projectId: project.id,
          workType: definition.type,
          payload,
          requiredScopes: definition.requiredScopes,
          maxAttempts: definition.defaultMaxAttempts,
          createdByType: person.type,
          createdById: person.id,
        });
      } catch (error) {
        if (error instanceof PayloadTooLarge) {
          res.status(400).type('html').send(await consolePage(person, { err: error.message }));
          return;
        }
        throw error;
      }

      await audit({
        actor: person,
        action: 'QUEUE_ENQUEUE',
        targetType: 'WORK_ITEM',
        targetId: item.id,
        result: 'SUCCESS',
        metadata: { projectId: project.id, workType: item.workType },
      });
      res.type('html').send(
        await consolePage(person, {
          ok: `Queued ${item.id} in "${project.name}". A connected worker will have to read the passage to finish it.`,
        }),
      );
    })();
  });

  router.post('/memberships/revoke', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const person = await administrator(req);
      if (!person || !originIsSameSite(req)) {
        denied(res);
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const workerId = typeof body['worker_id'] === 'string' ? body['worker_id'] : '';
      const projectId = typeof body['project_id'] === 'string' ? body['project_id'] : '';

      const worker = await getWorker(workerId);
      const project = await getProject(projectId);
      if (!worker || !project) {
        res.status(404).type('html').send(await consolePage(person, { err: 'No such worker or project.' }));
        return;
      }

      const removed = await revokeMembership(project.id, 'WORKER', worker.id);
      await audit({
        actor: person,
        action: 'REVOKE_MEMBERSHIP',
        targetId: worker.id,
        result: removed ? 'SUCCESS' : 'FAILED',
        metadata: { projectId: project.id },
      });
      res.type('html').send(
        await consolePage(person, {
          ok: removed
            ? `${worker.name} can no longer reach "${project.name}". It takes effect on its next call.`
            : `${worker.name} already had no access to "${project.name}".`,
        }),
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

  /**
   * Remove a worker, permanently.
   *
   * The gap this closes: a worker had two states and nothing retired one, so
   * one created by mistake — or created for a person and then used as an
   * example — stayed on this screen forever, in every dropdown and on every
   * consent screen. Disabling hid nothing; it only made the row say "disabled"
   * for good.
   *
   * The hidden `confirm` field carries the worker's own name and must match the
   * row being archived. It is not a security control — an administrator is
   * already authorized — it is a guard against the button next to it. Disable
   * and Remove sit side by side and one of them cannot be undone.
   */
  /**
   * Mint an invitation: your approval, in a link.
   *
   * The connection flow begins and ends in the browser Claude opened, so
   * connecting somebody else's account used to mean standing at their keyboard
   * or making them an administrator. Neither is acceptable — the people lending
   * an account hold no research here and need no login, and administrator
   * rights would let them create workers and grant projects.
   *
   * So the approval moves earlier rather than moving machines. This is that
   * approval, made once, for one named worker, carried to whichever browser
   * needs it.
   *
   * Refused for a worker with no project, for the same reason the consent
   * screen refuses one: a link that connects something which can do nothing
   * wastes somebody else's time and looks broken.
   */
  router.post('/workers/:workerId/invite', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const person = await administrator(req);
      if (!person || !originIsSameSite(req)) {
        denied(res);
        return;
      }
      const worker = await getWorker(req.params['workerId'] ?? '');
      if (!worker) {
        denied(res);
        return;
      }
      if (worker.disabled) {
        res.status(400).type('html').send(
          await consolePage(person, { err: `${worker.name} is disabled, so an invitation for it would connect nothing.` }),
        );
        return;
      }
      const memberships = (await listMembershipsForPrincipal('WORKER', worker.id)).filter((m) => m.active);
      if (memberships.length === 0) {
        res.status(400).type('html').send(
          await consolePage(person, {
            err: `${worker.name} has no project yet, so an invitation for it would connect something that can do nothing. Grant it a project first.`,
          }),
        );
        return;
      }

      const token = generateInvitationToken();
      const invitation = await createInvitation({
        workerId: worker.id,
        tokenPrefix: token.prefix,
        tokenDigest: token.digest,
        createdByUserId: person.id,
      });
      await audit({
        actor: person,
        action: 'CREATE_INVITATION',
        targetId: worker.id,
        result: 'SUCCESS',
        // The invitation's id, never the token.
        metadata: { invitationId: invitation.id },
      });

      const origin = `${req.protocol}://${req.get('host') ?? 'localhost'}`;
      res.type('html').send(
        await consolePage(person, {
          invite: {
            workerName: worker.name,
            url: `${origin}/oauth/invite/${token.plaintext}`,
            expiresAt: invitation.expiresAt,
          },
        }),
      );
    })();
  });

  router.post('/workers/:workerId/archive', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const person = await administrator(req);
      if (!person || !originIsSameSite(req)) {
        denied(res);
        return;
      }
      const worker = await getWorker(req.params['workerId'] ?? '');
      if (!worker) {
        denied(res);
        return;
      }
      const confirm = (req.body as Record<string, unknown>)['confirm'];
      if (confirm !== worker.name) {
        res.status(400).type('html').send(
          await consolePage(person, { err: 'That confirmation did not match the worker. Nothing was removed.' }),
        );
        return;
      }

      await archiveWorker(worker.id);
      await audit({
        actor: person,
        action: 'ARCHIVE_WORKER',
        targetId: worker.id,
        result: 'SUCCESS',
        metadata: { name: worker.name },
      });
      res.type('html').send(
        await consolePage(person, {
          ok: `${worker.name} has been removed. Its access, credentials and connections are revoked, and it cannot be brought back.`,
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

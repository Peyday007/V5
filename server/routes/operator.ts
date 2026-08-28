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
import { listLayers } from '../repos/layers.ts';
import { getDocument } from '../repos/documents.ts';
import { createRun } from '../repos/runs.ts';
import {
  createOrchestration,
  currentFragments,
  listOrchestrationsByProject,
} from '../repos/research.ts';
import { advancePacket, approvePlan } from '../services/research/packetRunner.ts';
import { createFixturePacket } from '../services/research/fixtures.ts';
import { runTypeForNewPacket } from '../services/runArtifacts.ts';
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
  ): string => {
    const held = new Set(rows.map((row) => row.projectId));
    const available = projects.filter((project) => !held.has(project.id));

    /**
     * A membership whose scopes are not what the Brain now grants gets one
     * extra button, and only until it is pressed.
     *
     * The Brain composes the scope set, so when that set changes — Step 9 added
     * the seven research scopes to it — every worker connected before the
     * change is holding the old one. Nothing tells them: the worker claims a
     * research item happily and is then refused by every tool that would let it
     * record anything, with the same NOT_FOUND a missing item gives. That is
     * indistinguishable from a bug, from the outside.
     *
     * Re-granting fixes it, because `grantMembership` upserts the scopes. But
     * the picker below deliberately offers only projects the worker does *not*
     * have, on the reasoning that granting one it already has is a no-op —
     * which stopped being true the moment the set could change. So rather than
     * widen the picker and make every grant ambiguous, the row itself says when
     * it is out of date and offers the one action that fixes it.
     */
    const outOfDate = (scopes: string[]): boolean =>
      [...scopes].sort().join(',') !== [...CONNECTOR_SCOPES].sort().join(',');

    const lines = rows
      .map(
        (row) => `
        <div class="access">
          <span class="meta">${esc(row.name)}${
            outOfDate(row.scopes)
              ? ' — <strong>connected before the research tools existed</strong>'
              : ''
          }</span>
          ${
            outOfDate(row.scopes)
              ? `<form method="post" action="${OPERATOR_BASE}/memberships" class="inline">
            <input type="hidden" name="worker_id" value="${esc(worker.id)}">
            <input type="hidden" name="project_id" value="${esc(row.projectId)}">
            <button type="submit" class="secondary">Update access</button>
          </form>`
              : ''
          }
          <form method="post" action="${OPERATOR_BASE}/memberships/revoke">
            <input type="hidden" name="worker_id" value="${esc(worker.id)}">
            <input type="hidden" name="project_id" value="${esc(row.projectId)}">
            <button type="submit" class="danger">Remove</button>
          </form>
        </div>`,
      )
      .join('');

    // Granting lives on the worker's own row rather than in a card of its own.
    // A separate card meant choosing the worker twice — once in its dropdown and
    // again in your head, against the list right above it — and two screens'
    // worth of controls for one decision. Here the worker is already chosen by
    // being the row you are looking at, and only the projects it does not have
    // are offered, so the choice cannot be a no-op.
    if (available.length === 0) return lines;
    return `${lines}
        <div class="access">
          <form method="post" action="${OPERATOR_BASE}/memberships" class="inline">
            <input type="hidden" name="worker_id" value="${esc(worker.id)}">
            <select name="project_id" required aria-label="Project to grant">
              <option value="" disabled selected>— add a project —</option>
              ${available.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}
            </select>
            <button type="submit" class="secondary">Grant</button>
          </form>
        </div>`;
  };

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
            .map((item) => {
              /**
               * The state alone cannot answer "did it work".
               *
               * SUCCEEDED tells you the queue closed the item. For a passage the
               * worker had to read, the thing you actually want to see is what
               * it produced — and that was recorded on the item all along while
               * this card showed only a status, so the one question the card
               * exists to answer had to be asked somewhere else.
               *
               * A failure's category is here for the same reason: "FAILED" with
               * no reason is a dead end.
               */
              const head =
                `<code>${esc(item.id)}</code> ${esc(item.workType)} · ${esc(item.state)}` +
                (item.attemptCount > 0 ? ` · attempt ${item.attemptCount}` : '');
              const outcome = item.resultSummary
                ? `<div class="result">${esc(item.resultSummary)}</div>`
                : item.failureCategory
                  ? `<div class="result">${esc(item.failureCategory)}</div>`
                  : item.state === 'QUEUED'
                    ? '<div class="result">Waiting. Nothing runs on its own yet — a connected worker has to be asked to claim it.</div>'
                    : '';
              return head + outcome;
            })
            .join('')}</div>
        </div>
      </div>`,
    )
    .join('');

  /**
   * Research packets, and the one screen where a person has to make a decision.
   *
   * A packet in PLANNING with proposed fragments is stopped: the worker read the
   * assignment, decomposed it, and nothing more will happen until somebody
   * approves. That is §16 — a browser-initiated run is planned in full and then
   * stops before anything is spent — and this is where it stops.
   *
   * The whole plan is shown rather than a count. "Approve 6 fragments" is not a
   * decision anybody can make; the six questions, their boundaries and their
   * evidence bars are, and they are exactly what the allowance will be spent on.
   */
  const packetGroups = await Promise.all(
    projects.map(async (project) => ({
      project,
      packets: await Promise.all(
        (await listOrchestrationsByProject(project.id)).slice(0, 6).map(async (orchestration) => ({
          orchestration,
          fragments: await currentFragments(orchestration.id),
          // The whole point of running a packet is reading what it filed, and
          // the main UI has no project switcher — it opens whichever project
          // sorts first. Without a link from here, an operator can watch a
          // packet succeed and have nowhere to go and check its citations.
          document: orchestration.documentId ? await getDocument(orchestration.documentId) : null,
        })),
      ),
    })),
  );

  const packetRows = packetGroups
    .filter((group) => group.packets.length > 0)
    .map((group) => {
      const rows = group.packets
        .map(({ orchestration, fragments, document }) => {
          const awaiting = fragments.filter((fragment) => fragment.status === 'PLANNED');
          const counts = ['ACCEPTED', 'BLOCKED', 'QUEUED', 'VALIDATING']
            .map((state) => ({ state, n: fragments.filter((f) => f.status === state).length }))
            .filter((entry) => entry.n > 0)
            .map((entry) => `${entry.n} ${entry.state.toLowerCase()}`)
            .join(', ');

          const plan =
            awaiting.length === 0
              ? ''
              : `
          <div class="result">
            <strong>${awaiting.length} fragment(s) proposed. Nothing has been spent yet.</strong>
            ${awaiting
              .map(
                (fragment) => `
            <div class="access">
              <span class="meta"><strong>${esc(fragment.fragmentKey)}</strong> — ${esc(fragment.question)}
                <br>${esc(
                  [
                    fragment.geography,
                    fragment.timeframe,
                    fragment.population,
                    `${fragment.minIndependentSources} independent source(s)`,
                    `lanes: ${fragment.requiredEvidence.join(', ') || 'none declared'}`,
                  ]
                    .filter((part) => Boolean(part))
                    .join(' · '),
                )}</span>
            </div>`,
              )
              .join('')}
            <form method="post" action="${OPERATOR_BASE}/packets/${esc(orchestration.id)}/approve">
              <button type="submit">${
                orchestration.fixture
                  ? 'Approve this plan and run the test packet'
                  : 'Approve this plan and start researching'
              }</button>
            </form>
            ${
              orchestration.fixture
                ? `<p class="note">This one spends nothing. Its claims are written into the Brain's
              own source, and approving it runs them through the same acceptance path a worker's
              submission takes — so what you see the gate do here is what it does.</p>`
                : `<p class="note">Approving queues one job per fragment. Each one costs a little of
              the connected account's allowance, and a fragment that cannot clear its own evidence
              bar contributes nothing to the report rather than contributing something weaker.</p>`
            }
          </div>`;

          return `
        <div class="row">
          <div>
            <div class="who"><strong>${esc(orchestration.title)}</strong>${
              orchestration.fixture ? ' <span class="meta">— TEST PACKET</span>' : ''
            }</div>
            <div class="meta"><code>${esc(orchestration.id)}</code> · ${esc(orchestration.status)}${
              counts ? ` · ${esc(counts)}` : ''
            }${orchestration.verdict ? ` · audit ${esc(orchestration.verdict)}` : ''}</div>
            ${
              document && document.storageKey
                ? `<div class="result"><strong>Filed as ${esc(document.canonicalName)}.</strong>
                   <a href="/files/${esc(document.storageKey)}">Open it and check the citations</a> —
                   every claim in the ledger carries its id, its URL and the passage it came from.</div>`
                : ''
            }
            ${
              orchestration.failureReason
                ? `<div class="result">${esc(orchestration.failureReason)}</div>`
                : ''
            }
            ${plan}
          </div>
        </div>`;
        })
        .join('');
      return `<div class="row"><div><div class="who"><strong>${esc(group.project.name)}</strong></div></div></div>${rows}`;
    })
    .join('');

  const layerOptions = (
    await Promise.all(
      projects.map(async (project) =>
        (await listLayers(project.id)).map(
          (layer) =>
            `<option value="${esc(project.id)}:${esc(layer.id)}">${esc(project.name)} — ${esc(
              layer.name,
            )}</option>`,
        ),
      ),
    )
  )
    .flat()
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
       projects.length > 0
         ? card(`<h2>Give a worker something to do</h2>
       <form method="post" action="${OPERATOR_BASE}/work">
         <label for="work_project">Project</label>
         <select id="work_project" name="project_id" required>${projectOptions}</select>
         <label for="work_passage">Passage for the worker to read</label>
         <textarea id="work_passage" name="passage" rows="4" maxlength="4000"
           placeholder="Paste a paragraph. The worker has to actually read it to finish."></textarea>
         <label for="work_question">Question (optional)</label>
         <input id="work_question" name="question" type="text" maxlength="500"
           placeholder="What should it tell you about the passage?">
         <label class="check"><input type="checkbox" name="echo_only" value="true">
           Queue a plain echo instead — proves the queue, spends nothing, and ignores the
           passage</label>
         <button type="submit">Queue it</button>
       </form>
       <p class="note">A reading cannot be faked: the worker has to read the passage and produce
         something that depends on it, which costs a little of that account's allowance. That cost
         is the point, because a test that spends nothing has not tested the part where spending
         happens. An echo hands a note back, so a worker that never read it looks identical to one
         that did — useful for the queue itself, useless for proving work happened.</p>
       <p class="note">Both stay inside what this queue requires. It is at-least-once, so
         everything it carries must be safe to perform twice: the passage travels in the item,
         nothing is fetched, no document is touched, and a repeat cannot record a second result.</p>
       <p class="note">A worker cannot enqueue its own work. Enqueueing is a project write with no
         scope that grants it, so a machine credential is refused here however it is configured —
         which is why this box exists at all.</p>`)
         : ''
     }
     ${
       layerOptions
         ? card(`<h2>Start a research packet</h2>
       <form method="post" action="${OPERATOR_BASE}/packets">
         <label for="packet_layer">Layer this answers for</label>
         <select id="packet_layer" name="target" required>
           <option value="" disabled selected>— choose a layer —</option>
           ${layerOptions}
         </select>
         <label for="packet_title">Title</label>
         <input id="packet_title" name="title" type="text" required maxlength="200"
           placeholder="Licensure of success-fee business brokerage">
         <label for="packet_assignment">The assignment</label>
         <textarea id="packet_assignment" name="assignment" rows="8" required maxlength="8000"
           placeholder="The question, and the boundaries that make an answer checkable: which geography, which timeframe, which population, whose definitions, what would count as done, and what is explicitly out of scope."></textarea>
         <button type="submit">Plan it</button>
       </form>
       <p class="note">This queues one planning job and stops. The worker reads the assignment and
         proposes the bounded fragments that would answer it; <strong>nothing is researched and
         nothing is spent</strong> until you have read the plan and approved it here.</p>
       <p class="note">Write the boundaries into the assignment rather than leaving them implied.
         They become each fragment's evidence bar, and a fragment with no declared scope cannot be
         judged — the plan will be refused rather than accepted loosely.</p>
       <p class="note">A worker cannot start a packet. Enqueueing is a project write that no worker
         scope grants, which is why this box exists.</p>`)
         : ''
     }
     ${card(`<h2>Try it without spending anything</h2>
       <form method="post" action="${OPERATOR_BASE}/packets/fixture">
         <button type="submit" class="secondary">Create a test packet</button>
       </form>
       <p class="note">A packet whose research is written into the Brain's own source rather than
         found by anybody. It goes through the <strong>same</strong> acceptance path a worker's
         submission takes — the same gate, the same seven conditions, the same filing and the same
         ledger — so what you watch it do is what the Brain does.</p>
       <p class="note">Three fragments, chosen to show the three outcomes: one that clears the gate,
         one that clears it while losing an unsourced claim, and one that fails because its only
         source is about a different thing than the fragment asked about. Approving it costs
         nothing.</p>
       <p class="note">It lives in its own project and is labelled a test packet everywhere it
         appears, so it cannot be mistaken for research or reach a layer anything depends on. It
         stops before the audit, which is the one part a fixture cannot honestly stand in for —
         that needs a worker.</p>`)}
     ${packetRows ? card(`<h2>Research packets</h2>${packetRows}`) : ''}
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
      const passage = typeof body['passage'] === 'string' ? body['passage'].trim() : '';
      const question = typeof body['question'] === 'string' ? body['question'].trim() : '';
      const echoOnly = body['echo_only'] === 'true';

      const project = await getProject(projectId);
      if (!project) {
        res.status(404).type('html').send(await consolePage(person, { err: 'No such project.' }));
        return;
      }

      // An echo with a passage would silently throw the passage away, and a
      // reading with nothing to read cannot be done at all. Say so rather than
      // quietly queueing something other than what was asked for.
      if (!echoOnly && passage.length === 0) {
        res.status(400).type('html').send(
          await consolePage(person, {
            err: 'Paste a passage for the worker to read, or tick the box to queue a plain echo instead.',
          }),
        );
        return;
      }

      const definition = workType(echoOnly ? 'SYNTHETIC_ECHO' : 'SUMMARIZE_PASSAGE');
      let payload: Record<string, unknown>;
      try {
        payload = definition.validate(
          echoOnly
            ? { note: 'queue check' }
            : { passage, ...(question.length > 0 ? { question } : {}) },
        );
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
          ok: echoOnly
            ? `Queued ${item.id} in "${project.name}". It hands a note back, so it proves the queue and nothing more.`
            : `Queued ${item.id} in "${project.name}". A connected worker will have to read the passage to finish it.`,
        }),
      );
    })();
  });

  /**
   * Start a research packet: create the run, the orchestration, and stop.
   *
   * The one thing this must not do is start researching. It queues a single
   * planning job, and the plan comes back for a person to read. §16 is explicit
   * that a browser-initiated run is planned in full and then stops before
   * anything is spent, and the temptation here is a single extra call — advance
   * straight through PLANNING — which would spend the allowance on a
   * decomposition nobody had seen.
   *
   * Like project creation and hand-queueing, this is a person doing something a
   * worker must not be able to do for itself. Enqueueing is a project write and
   * no worker scope grants it.
   */
  router.post('/packets', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const person = await administrator(req);
      if (!person || !originIsSameSite(req)) {
        denied(res);
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const target = typeof body['target'] === 'string' ? body['target'] : '';
      const title = typeof body['title'] === 'string' ? body['title'].trim() : '';
      const assignment = typeof body['assignment'] === 'string' ? body['assignment'].trim() : '';

      const [projectId, layerId] = target.split(':');
      if (!projectId || !layerId) {
        res.status(400).type('html').send(await consolePage(person, { err: 'Choose a layer.' }));
        return;
      }
      if (!title || !assignment) {
        res
          .status(400)
          .type('html')
          .send(await consolePage(person, { err: 'A packet needs a title and an assignment.' }));
        return;
      }

      const project = await getProject(projectId);
      const layer = (await listLayers(projectId)).find((candidate) => candidate.id === layerId);
      if (!project || !layer) {
        res.status(404).type('html').send(await consolePage(person, { err: 'No such layer.' }));
        return;
      }

      // The run is the assignment Brain issued, and the orchestration is how it
      // gets carried out. A run always exists — that is what lets an artifact
      // filed by a worker land through exactly the path a hand-uploaded report
      // does, with the same naming, the same versioning and the same lineage.
      const run = await createRun({
        projectId: project.id,
        layerId: layer.id,
        // The run type describes what the work is *for* the layer, and a packet
        // researched by a worker is the same kind of contribution as one
        // researched in process. It is not always FOUNDATION, though: that
        // targets v1 by definition, so a second packet on a layer that already
        // has a document would be declined by the importer as a duplicate.
        runType: await runTypeForNewPacket(layer.id),
        status: 'PLANNED',
        provider: 'WORKER',
        prompt: assignment,
      });

      const orchestration = await createOrchestration({
        projectId: project.id,
        layerId: layer.id,
        runId: run.id,
        title,
        assignment,
        provider: 'WORKER',
        // Nothing about this packet runs without a person, which is what the
        // flag means here. It is not a preference; it is the §16 gate.
        autoApprove: false,
      });

      const advanced = await advancePacket(orchestration.id);

      await audit({
        actor: person,
        action: 'QUEUE_ENQUEUE',
        targetType: 'PROJECT',
        targetId: project.id,
        result: 'SUCCESS',
        metadata: {
          orchestrationId: orchestration.id,
          layer: layer.slug,
          enqueued: advanced.enqueued.length,
        },
      });

      res.type('html').send(
        await consolePage(person, {
          ok:
            `Planning "${title}". A worker will decompose it into fragments and bring the plan ` +
            'back here. Nothing is researched and nothing is spent until you approve it.',
        }),
      );
    })();
  });

  /**
   * Approve a plan, and only then does anything cost anything.
   *
   * This is the single point in the whole packet where a human decision is
   * load-bearing. Everything before it is free; everything after it spends the
   * connected account's allowance, one fragment at a time.
   */
  /**
   * Create a test packet.
   *
   * Here rather than in the API because it is the same kind of thing project
   * creation and hand-queueing are: scaffolding a person needs and a machine
   * must not have. A worker that could manufacture packets could manufacture
   * evidence-shaped rows, and the fact that this particular content is honest
   * is a property of the fixture rather than of the caller.
   */
  router.post('/packets/fixture', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const person = await administrator(req);
      if (!person || !originIsSameSite(req)) {
        denied(res);
        return;
      }

      const packet = await createFixturePacket({ createdByUserId: person.id });

      await audit({
        actor: person,
        action: 'CREATE_PROJECT',
        targetType: 'PROJECT',
        targetId: packet.projectId,
        result: 'SUCCESS',
        metadata: { fixture: true, orchestrationId: packet.orchestration.id },
      });

      res.type('html').send(
        await consolePage(person, {
          ok:
            `Test packet created with ${packet.fragments.length} proposed fragments. Read the ` +
            'plan below and approve it — it spends nothing.',
        }),
      );
    })();
  });

  router.post('/packets/:orchestrationId/approve', (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      const person = await administrator(req);
      if (!person || !originIsSameSite(req)) {
        denied(res);
        return;
      }
      const orchestrationId = req.params['orchestrationId'] ?? '';

      const result = await approvePlan({ orchestrationId, approvedByUserId: person.id });
      if (result.status === 'GONE') {
        res.status(404).type('html').send(await consolePage(person, { err: 'No such packet.' }));
        return;
      }

      await audit({
        actor: person,
        action: 'QUEUE_ENQUEUE',
        targetType: 'WORK_ITEM',
        targetId: orchestrationId,
        result: 'SUCCESS',
        metadata: { approvedPlan: true, enqueued: result.enqueued.length },
      });

      /**
       * Three different things can happen, and the first version of this said
       * the same discouraging sentence for two of them.
       *
       * A fixture that ran successfully queues nothing — because the work is
       * already done — and reporting that as "nothing was queued" reads as a
       * failure of exactly the thing that just worked.
       */
      const message = result.ran
        ? `Ran. ${result.ran.acceptedFragments} fragment(s) cleared the gate and ` +
          `${result.ran.blockedFragments} did not; ${result.ran.acceptedClaims} claim(s) ` +
          `accepted, ${result.ran.rejectedClaims} rejected. Filed as ` +
          `${result.ran.canonicalName ?? 'a document in this project'}. Open the packet below ` +
          'to see which claims were refused and why.'
        : result.enqueued.length > 0
          ? `Approved. ${result.enqueued.length} research job(s) queued — a connected worker ` +
            'will claim them.'
          : `Nothing happened: ${result.waitingOn ?? 'nothing was waiting'}.`;

      res.type('html').send(await consolePage(person, { ok: message }));
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

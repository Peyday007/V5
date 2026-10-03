/**
 * The Industry map screen over the real route over the real database.
 *
 * ---------------------------------------------------------------------------
 * Why this seam needs its own file
 * ---------------------------------------------------------------------------
 *
 * `cashBrowserToDatabase.test.ts` records the reason and §33 records what it
 * cost in production: a component suite over a scripted `fetch` and a service
 * suite with no screen both pass for a control that posts a field the route
 * does not take, or a screen that renders a form for a decision that is not a
 * person's. The seam between them is where those live, and this kernel had
 * *neither* half — three finished routes, covered on both backends, and no
 * screen at all. Nothing in any browser called any of it.
 *
 * ---------------------------------------------------------------------------
 * What is asserted here and nowhere else
 * ---------------------------------------------------------------------------
 *
 * **A01** a project ADMIN seeds a subject through the form and an
 * `industry_nodes` row with origin `SEED` and that name/kind exists and is
 * listed on re-read.
 *
 * **A02** retiring that subject with a reason sets `retired_at` and the
 * reason, and it then renders under retired subjects with that reason rather
 * than disappearing.
 *
 * **A03** a project MEMBER who is not ADMIN sees the seed/retire controls
 * rendered disabled with the server's `capabilities.because`, and a raw POST
 * as that member is refused 404 with no row written.
 *
 * **A04** a capital reading with `executableNow` UNKNOWN or
 * `minimumOwnerCents` null renders the server's unknown reason and no currency
 * figure, asserted against the rendered document.
 *
 * **A05** the seed form's kind options equal exactly the
 * `vocabulary.industryNodeKinds` the server sent, and the request body
 * contains only `name`, `kind`, `description`, `parentId`, `reason`.
 *
 * **A06** a WORKER principal is refused at the GET and at both writes, with
 * `industry_nodes` and `industry_rounds` counts unchanged.
 *
 * **A07** `/industries` parses to INDUSTRIES and INDUSTRIES formats back to
 * `/industries`, and the shell renders the Industry view for it.
 *
 * The jsdom-by-hand construction, the dynamic imports and the real socket are
 * all `machinesBrowserToDatabase`'s and `laborSurface`'s; see their opening
 * comments.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import {
  listIndustryRounds,
  listNodes,
  recordCapitalEntry,
} from '../server/repos/industry.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { cashRouter } from '../server/routes/cash.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { parseRoute, pathFor, type Route } from '../client/src/lib/router.ts';
import { INDUSTRY_NODE_KINDS } from '../server/domain/types.ts';
import type { Layer, Principal, ProjectMembership, ProjectRole } from '../server/domain/types.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1/',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'MutationObserver',
  'DOMParser',
] as const) {
  Object.defineProperty(globalThis, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react');
const { act, createElement } = await import('react');
const { IndustryView } = await import('../client/src/russell/Industry.tsx');

let projectId = '';
let userId = '';
let layer: Layer;
let server: Server | null = null;
const realFetch = globalThis.fetch;

/**
 * Who is driving these requests.
 *
 * Three dimensions, and they are not the same one. A Brain administrator
 * reaches every project by design, so a suite that only ever ran as one could
 * not see a refusal at all; every decision on this screen is project `ADMIN`,
 * so the *level* is what the capabilities actually turn on; and `requirePerson`
 * refuses a WORKER principal by type before either of those is even asked.
 * Reset in `beforeEach`, so a block that lowers any of them cannot leak into
 * the next.
 */
let brainAdmin = true;
let role: ProjectRole = 'ADMIN';
let principalType: 'HUMAN' | 'WORKER' = 'HUMAN';

/** Every request the stubbed `fetch` actually sent, for A05's body check. */
let capturedRequests: { url: string; method: string; body: unknown }[] = [];

function principal(): Principal {
  if (principalType === 'WORKER') {
    return {
      type: 'WORKER',
      id: 'wkr_test',
      handle: 'wkr_test',
      displayName: 'A worker',
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: 'wkc_test',
      authMethod: 'WORKER_BEARER',
      memberships: [],
      requestId: 'req',
    } as Principal;
  }
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
    isBrainAdmin: brainAdmin,
    mustChangePassword: false,
    credentialId: 'ses_browser',
    authMethod: 'SESSION_COOKIE',
    memberships: [
      {
        id: 'mem',
        projectId,
        principalType: 'HUMAN',
        principalId: userId,
        role,
        scopes: ['project:read'],
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: '2026-01-01T00:00:00.000Z',
        active: true,
      } as ProjectMembership,
    ],
    requestId: 'req',
  } as Principal;
}

beforeEach(async () => {
  brainAdmin = true;
  role = 'ADMIN';
  principalType = 'HUMAN';
  capturedRequests = [];
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `industry-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
    isBrainAdmin: true,
  });
  userId = user.id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'ADMIN',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: principal(),
      requestId: newRequestId(),
      method: req.method,
      /*
       * The path the policy module matches on, which is the one the request
       * already carries.
       *
       * `req.path` in a middleware registered with no mount path is the
       * **whole** path — `/api/projects/x/cash/industries` — so prefixing
       * `/api` again yields `/api/api/…`, which matches no pattern in
       * `services/identity/policy.ts` and silently falls to the default
       * `READ`. Every write in this harness would then be authorized at the
       * wrong level, and a refusal asserted against it would be vacuous.
       */
      path: req.path,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api', cashRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res
      .status(typeof error?.status === 'number' ? error.status : 500)
      .json({ error: String(error?.message ?? error) });
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (init?.body) {
      let body: unknown = init.body;
      try {
        body = JSON.parse(String(init.body));
      } catch {
        // Kept as the raw string; nothing here relies on that path.
      }
      capturedRequests.push({ url, method, body });
    }
    return await realFetch(url.startsWith('/') ? `http://127.0.0.1:${port}${url}` : url, init);
  });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function mount(id: string | null = projectId): Promise<void> {
  await act(async () => {
    render(createElement(IndustryView, { projectId: id }));
  });
}

/** The heading every populated render carries, so a mount can be waited on. */
async function mounted(id: string | null = projectId): Promise<void> {
  await mount(id);
  await waitFor(() => expect(screen.getByText('The industry map')).toBeTruthy());
}

function button(label: RegExp): HTMLButtonElement {
  const found = screen
    .getAllByRole('button')
    .find((one) => label.test(one.textContent ?? '')) as HTMLButtonElement | undefined;
  if (!found) throw new Error(`no button matching ${label}`);
  return found;
}

/** Type into the field whose label says this, the way a person does. */
function type(label: string, value: string): void {
  const field = screen.getByLabelText(label) as HTMLInputElement;
  fireEvent.change(field, { target: { value } });
}

/**
 * A real claim, for the one FK `capital_structures.source_claim_id` demands.
 *
 * The kernel's own `finishedRound` helper in `tests/industryKernel.test.ts`
 * builds the identical chain — a run, an orchestration, one accepted fragment
 * — because a capital row traces to a passage or it cannot be written at all.
 * What differs is the destination: that helper feeds a mission the kernel
 * absorbs; this one only needs the claim id `recordCapitalEntry` requires, so
 * it stops the moment the claim exists.
 */
async function makeClaim(): Promise<string> {
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'what this requirement costs',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'what this requirement costs',
    assignment: 'what a supplier actually charges',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'the markets the sprint may look at',
      requiredEvidence: [{ id: 'cost', description: 'what it costs', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a supplier price list'],
      excludedSourceTypes: ['a figure asserted with no source that names it'],
      completionCriteria: ['a published figure, or a documented absence of one'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'capital-requirement',
      question: 'What does this requirement cost?',
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, {
    status: 'ACCEPTED',
    completedAt: new Date().toISOString(),
    blockedReason: null,
  });
  const [claim] = await insertClaims([
    {
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: 'No supplier publishes a price for this.',
      sourceUrl: 'https://example.test/supplier-catalog',
      sourceTitle: 'A supplier catalog',
      sourcePublisher: 'A supplier',
      sourceDate: '2026-09-10',
      evidenceExcerpt: 'price on request',
      evidenceLocator: 'the listing',
      evidenceLane: 'cost',
      retrievedAt: '2026-09-12',
      confidence: 0.5,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: `unknown-capital-claim:${projectId}`,
    },
  ] as unknown as Parameters<typeof insertClaims>[0]);
  return claim!.id;
}

/* ========================================================================= */

describe('the Industry screen, over the real route', () => {
  it('A01: seeds a subject through the form, and the row is there on re-read', async () => {
    await mounted();

    type('Name', 'Commercial pressure washer manufacturing');
    const kindSelect = screen.getByLabelText('Kind') as HTMLSelectElement;
    fireEvent.change(kindSelect, { target: { value: 'SECTOR' } });
    await act(async () => {
      fireEvent.click(button(/Name it/));
    });

    const node = await waitFor(async () => {
      const found = (await listNodes(projectId)).find(
        (one) => one.name === 'Commercial pressure washer manufacturing',
      );
      expect(found).toBeTruthy();
      return found!;
    });
    expect(node.kind).toBe('SECTOR');
    // The one origin Brain itself may never write: this is a person's row.
    expect(node.origin).toBe('SEED');

    // Listed on re-read, scoped to the live-subjects section so the identical
    // name offered as a Parent option in the seed form below cannot satisfy
    // this the way an unscoped query would.
    await waitFor(() => {
      const subjects = document.querySelector('.rs-industry-subjects') as HTMLElement | null;
      expect(subjects).toBeTruthy();
      expect(
        within(subjects!).getByText('Commercial pressure washer manufacturing'),
      ).toBeTruthy();
    });
  });

  it('A02: retires a subject with a reason, and it stays visible under Retired', async () => {
    await mounted();

    type('Name', 'A dead end with nothing underneath it');
    await act(async () => {
      fireEvent.click(button(/Name it/));
    });
    await waitFor(async () => {
      expect(
        (await listNodes(projectId)).some((one) => one.name === 'A dead end with nothing underneath it'),
      ).toBe(true);
    });

    const reasonInput = await waitFor(() => {
      const el = document.querySelector('.rs-industry-subjects') as HTMLElement | null;
      expect(el).toBeTruthy();
      return within(el!).getByPlaceholderText('Why this is a dead end');
    });
    fireEvent.change(reasonInput, { target: { value: 'Nothing published names a buyer for this.' } });
    const retireButton = within(
      document.querySelector('.rs-industry-subjects') as HTMLElement,
    ).getByRole('button', { name: /^Retire$/ });
    await act(async () => {
      fireEvent.click(retireButton);
    });

    const node = await waitFor(async () => {
      const found = (await listNodes(projectId)).find(
        (one) => one.name === 'A dead end with nothing underneath it',
      );
      expect(found?.retiredAt).toBeTruthy();
      return found!;
    });
    expect(node.retiredReason).toBe('Nothing published names a buyer for this.');

    // Renders under Retired with that exact reason rather than disappearing,
    // and the live Subjects section no longer offers it.
    await waitFor(() => {
      const retired = document.querySelector('.rs-industry-retired-section') as HTMLElement | null;
      expect(retired).toBeTruthy();
      expect(within(retired!).getByText('A dead end with nothing underneath it')).toBeTruthy();
      // The reason legitimately appears twice — once as the DEAD_END verdict's
      // own "because" sentence, once on the "Retired <date>: <reason>" line —
      // so this counts occurrences rather than requiring exactly one.
      expect(
        within(retired!).getAllByText(/Nothing published names a buyer for this\./).length,
      ).toBeGreaterThan(0);
    });
    const liveSubjects = document.querySelector('.rs-industry-subjects') as HTMLElement;
    expect(within(liveSubjects).queryByText('A dead end with nothing underneath it')).toBeNull();
  });

  it('A03: disables the seed and retire controls for a member, with the server’s reason, and refuses a raw POST', async () => {
    // A live subject to check the retire control against, written directly
    // rather than through a POST an administrator would have to make first.
    await seedSubject({ projectId, name: 'Existing subject', actorRef: userId });

    brainAdmin = false;
    role = 'MEMBER';
    await mounted();

    // The whole map is still readable — reading is any project member's.
    // Scoped, because the same name legitimately appears again in the "what
    // Brain would ask next" section and as a Parent option in the seed form.
    const subjectsSection = document.querySelector('.rs-industry-subjects') as HTMLElement;
    expect(within(subjectsSection).getByText('Existing subject')).toBeTruthy();

    const because =
      'Naming a subject and retiring one are decisions an administrator of this project ' +
      'makes. You can read the whole map.';
    expect(screen.getAllByText(because).length).toBeGreaterThan(0);

    expect((screen.getByLabelText('Name') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Kind') as HTMLSelectElement).disabled).toBe(true);
    const retireInput = screen.getByPlaceholderText('Why this is a dead end') as HTMLInputElement;
    expect(retireInput.disabled).toBe(true);

    // A hidden button is not authorization, so the route refuses it too.
    const refused = await fetch(`/api/projects/${projectId}/cash/industries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Something a member tried to name' }),
    });
    expect(refused.status).toBe(404);
    expect(await listNodes(projectId)).toHaveLength(1);
  });

  it('A04: renders an unknown capital reading as unknown, never as a currency figure', async () => {
    const outcome = await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    expect(outcome.ok).toBe(true);
    const mode = (await getCashMode(projectId))!;

    const opportunity = await createOpportunity({
      projectId,
      cashModeId: mode.id,
      ownerUserId: userId,
      title: 'A load whose freight nobody has published',
      mechanism: 'SUPPLY_DEMAND_MISMATCH',
      currency: mode.currency,
    });
    const claimId = await makeClaim();
    // No published amount: the one row that withholds the minimum entirely
    // rather than letting the rest of the requirements stand in for it.
    const recorded = await recordCapitalEntry({
      projectId,
      opportunityId: opportunity.id,
      entryKind: 'REQUIREMENT',
      requirement: 'TRANSPORT',
      statement: 'No supplier publishes a price for this.',
      sourceClaimId: claimId,
      amountCents: null,
    });
    expect(recorded).toBeTruthy();

    await mounted();

    const capitalSection = await waitFor(() => {
      const el = document.querySelector('.rs-industry-capital-section') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    expect(within(capitalSection).getByText(opportunity.title)).toBeTruthy();
    // The unknown reason, in the server's own words rather than a placeholder.
    expect(within(capitalSection).getByText('amount unknown')).toBeTruthy();
    expect(
      within(capitalSection).getByText('Not established whether this is executable now'),
    ).toBeTruthy();
    // And never a currency figure: no "Minimum owner capital:" line, and no
    // digit string that could be read as one.
    expect(within(capitalSection).queryByText(/Minimum owner capital/)).toBeNull();
    expect(capitalSection.textContent).not.toMatch(/\$?\d[\d,]*\.\d{2}/);
  });

  it('A05: offers exactly the server’s kind vocabulary, and posts only the declared fields', async () => {
    await mounted();

    const kindSelect = screen.getByLabelText('Kind') as HTMLSelectElement;
    expect([...kindSelect.options].map((one) => one.value)).toEqual([...INDUSTRY_NODE_KINDS]);

    type('Name', 'A tightly declared subject');
    type('Description (optional)', 'What the source said this is.');
    type('Why (optional)', 'Somebody has a reason to look here.');
    await act(async () => {
      fireEvent.click(button(/Name it/));
    });

    await waitFor(async () => {
      expect(
        (await listNodes(projectId)).some((one) => one.name === 'A tightly declared subject'),
      ).toBe(true);
    });

    const posted = capturedRequests.find(
      (one) => one.method === 'POST' && one.url.includes('/cash/industries'),
    );
    expect(posted).toBeTruthy();
    const body = posted!.body as Record<string, unknown>;
    const allowed = new Set(['name', 'kind', 'description', 'parentId', 'reason']);
    for (const key of Object.keys(body)) {
      expect(allowed.has(key), `"${key}" is not one of the declared fields`).toBe(true);
    }
    expect(body['name']).toBe('A tightly declared subject');
    expect(body['description']).toBe('What the source said this is.');
    expect(body['reason']).toBe('Somebody has a reason to look here.');
  });

  it('A06: refuses a WORKER principal at the read and at both writes, and writes nothing', async () => {
    await seedSubject({ projectId, name: 'A subject nobody may touch as a worker', actorRef: userId });
    const beforeNodes = (await listNodes(projectId)).length;
    const beforeRounds = (await listIndustryRounds(projectId)).length;
    const node = (await listNodes(projectId))[0]!;

    principalType = 'WORKER';

    const getResponse = await fetch(`/api/projects/${projectId}/cash/industries`);
    expect(getResponse.status).toBe(404);

    const postResponse = await fetch(`/api/projects/${projectId}/cash/industries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A worker tried to name this' }),
    });
    expect(postResponse.status).toBe(404);

    const patchResponse = await fetch(`/api/projects/${projectId}/cash/industries/${node.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'A worker tried to retire this' }),
    });
    expect(patchResponse.status).toBe(404);

    expect(await listNodes(projectId)).toHaveLength(beforeNodes);
    expect(await listIndustryRounds(projectId)).toHaveLength(beforeRounds);
  });

  it('A07: the route round-trips, and the shell renders the Industry view for it', () => {
    expect(parseRoute('/industries')).toEqual({ name: 'INDUSTRIES' });
    expect(pathFor({ name: 'INDUSTRIES' } as Route)).toBe('/industries');

    const shell = fs.readFileSync('client/src/russell/RussellShell.tsx', 'utf8');
    expect(shell).toMatch(/import \{ IndustryView \} from '\.\/Industry\.tsx';/);
    expect(shell).toContain("{route.name === 'INDUSTRIES' ? <IndustryView projectId={projectId} /> : null}");
  });
});

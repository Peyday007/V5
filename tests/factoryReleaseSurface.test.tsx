/**
 * The release decision, in a browser, over the real route over the real
 * database.
 *
 * ---------------------------------------------------------------------------
 * The gap this closes
 * ---------------------------------------------------------------------------
 *
 * §27 says the factory has **two** decisions that belong to a person and no
 * path around either: approving the objective, and approving the release.
 * `client/src/lib/factoryApi.ts` said so in its own header and then said, on
 * `approve`, that it was *"the only one this screen offers"*. It was.
 *
 * So a campaign that reached `AWAITING_RELEASE` rendered its blocker —
 * *"the reviewable artifact is ready and a person has not answered. This is the
 * one …"* — and nothing beside it to answer with. The route existed, was
 * guarded, and was reachable from a terminal; the product surface had the
 * sentence and not the decision. §24's escalation nobody can resolve, at the
 * one stage whose entire purpose is to wait for a person.
 *
 * ---------------------------------------------------------------------------
 * Why this is a seam test rather than a scripted `fetch`
 * ---------------------------------------------------------------------------
 *
 * `buildRepositories.test.tsx` scripts `fetch` and is right to: what it holds
 * to is how the card *reads*. This one has to establish that pressing the
 * button changes a row — through the real `factoryRouter`, the real policy
 * module and the real repositories — because the defect it guards against is
 * precisely a control that looks right and reaches nothing. §33 records what a
 * component suite and a screenless service suite both pass over.
 *
 * The starting state is made by `requestRelease`, which is the one production
 * writer of that row and what `assembleStage` calls. Everything after it — the
 * projection, the route, the authorization, the guard on `REQUESTED` — is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { factoryRouter } from '../server/routes/factory.ts';
import { ensureChangeRequest, approveChangeRequest, ensureCampaign, patchCampaign } from '../server/repos/factory.ts';
import { requestRelease, getRelease } from '../server/repos/factoryFleet.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import type { Principal, ProjectMembership, ProjectRole } from '../server/domain/types.ts';
import { PROJECT_ROLES } from '../server/domain/types.ts';
import { roleAtLeast } from '../server/services/identity/policy.ts';

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

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const { act, createElement } = await import('react');
const { BuildView } = await import('../client/src/russell/Build.tsx');

const OAKWOOD = 'https://github.com/Peyday007/oakwood-junk-removal';
const BASE = 'a'.repeat(40);
const INTEGRATION = 'c'.repeat(40);

let projectId = '';
let userId = '';
let campaignId = '';
let server: Server | null = null;
const realFetch = globalThis.fetch;
let brainAdmin = true;
let role: ProjectRole = 'ADMIN';

function principal(): Principal {
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

/** The evidence `assembleStage` requests a release with, verbatim in shape. */
const EVIDENCE = {
  integrationBranch: 'factory/round-1',
  integrationSha: INTEGRATION,
  diffRef: 'diff-1',
  unitsIntegrated: 2,
  reviewRounds: 1,
  lastVerdict: 'PASS',
  openFindings: 0,
  independence: 'WORKER_SEPARATED',
};

beforeEach(async () => {
  brainAdmin = true;
  role = 'ADMIN';
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `release-${Math.random().toString(36).slice(2, 10)}@example.test`,
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

  const { changeRequest } = await ensureChangeRequest({
    projectId,
    submissionKey: `release-${Math.random()}`,
    objective: 'Keep the published site free of repository-only files.',
    expectedOutcome: 'The suite fails when they appear.',
    nonGoals: [],
    acceptanceConditions: [
      { id: 'A01', statement: 'the suite asserts it', verification: 'npm test', mandatory: true },
    ],
    repository: OAKWOOD,
    repositoryRoot: '',
    baseBranch: 'main',
    baseSha: BASE,
    environment: 'STAGING',
    riskClass: 'LOW',
    mutationScope: ['**'],
    // The field that makes a release decision arise at all. A campaign whose
    // policy is NONE finishes at the artifact and never asks anybody.
    deploymentPolicy: 'CONTROL_PLANE_AFTER_VERIFICATION',
    rollbackRequirement: 'decline',
    verificationCommands: ['npm test'],
  });
  await approveChangeRequest({
    changeRequestId: changeRequest.id,
    via: 'PERSON',
    userId,
    authorityId: null,
  });
  const { campaign } = await ensureCampaign({
    changeRequestId: changeRequest.id,
    projectId,
    baseSha: BASE,
    laneTarget: 1,
    laneTargetReason: 'test',
    executionMode: 'LOCAL',
  });
  campaignId = campaign.id;
  await requestRelease(campaignId, 'CONTROL_PLANE', EVIDENCE);
  await patchCampaign(campaignId, {
    state: 'AWAITING_RELEASE',
    stageDetail: 'a person decides',
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: principal(),
      requestId: newRequestId(),
      method: req.method,
      // The whole path, which is what the policy module matches on. Prefixing
      // `/api` again would yield `/api/api/…`, match nothing, and authorize
      // every write at the default READ — a refusal asserted against that is
      // vacuous, which reads as coverage.
      path: req.path,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api', factoryRouter);
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
    return await realFetch(url.startsWith('/') ? `http://127.0.0.1:${port}${url}` : url, init);
  });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function mounted(): Promise<void> {
  await act(async () => {
    render(createElement(BuildView, { projectId }));
  });
  await waitFor(() =>
    expect(screen.getByText(/waiting for you to let the work out/)).toBeTruthy(),
  );
}

function button(label: RegExp): HTMLButtonElement {
  const found = screen
    .getAllByRole('button')
    .find((one) => label.test(one.textContent ?? '')) as HTMLButtonElement | undefined;
  if (!found) throw new Error(`no button matching ${label}`);
  return found;
}

/* ========================================================================= */

describe('the release decision, on the surface a person already uses', () => {
  it('shows what is being let out rather than asking about something it will not describe', async () => {
    await mounted();

    /*
     * The stage is still stated — this adds the answer beside the statement of
     * the problem rather than replacing it. `AWAITING_RELEASE` plus *a person
     * decides* is exactly what the screen used to show on its own, with nothing
     * to press.
     */
    expect(screen.getByText(/AWAITING_RELEASE/)).toBeTruthy();
    expect(screen.getByText(/a person decides/)).toBeTruthy();

    // Every key the release was requested with, and its value. A decision card
    // that hid part of what it described would be a confirmation dialog.
    for (const [key, value] of Object.entries(EVIDENCE)) {
      const label = key.replace(/([a-z])([A-Z])/g, '$1 $2');
      expect(screen.getByText(label), `${key} is not on the card`).toBeTruthy();
      expect(screen.getAllByText(String(value)).length, `${key}'s value is missing`).toBeGreaterThan(0);
    }

    // Both answers, because a card that offers one is not a decision.
    expect(button(/Approve the release/)).toBeTruthy();
    expect(button(/Refuse it/)).toBeTruthy();
  });

  it('records an approval against the row, with the person and the reason', async () => {
    await mounted();
    const field = screen.getByLabelText('Why') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'Reviewed the diff; the staging deploy is fine.' } });
    await act(async () => {
      fireEvent.click(button(/Approve the release/));
    });

    const release = await waitFor(async () => {
      const found = await getRelease(campaignId, 'CONTROL_PLANE');
      expect(found?.decision).toBe('APPROVED');
      return found!;
    });
    // Attribution is not authentication, and the row carries both halves it can:
    // who the server resolved, and what they said.
    expect(release.decidedByUserId).toBe(userId);
    expect(release.decidedReason).toContain('Reviewed the diff');
    expect(release.decidedAt).toBeTruthy();

    // And the card goes, because the campaign is no longer waiting on anybody.
    await waitFor(() =>
      expect(screen.queryByText(/waiting for you to let the work out/)).toBeNull(),
    );
  });

  it('records a refusal as a refusal, and a second press changes nothing', async () => {
    await mounted();
    fireEvent.change(screen.getByLabelText('Why'), {
      target: { value: 'The open finding has to land first.' },
    });
    await act(async () => {
      fireEvent.click(button(/Refuse it/));
    });

    const refused = await waitFor(async () => {
      const found = await getRelease(campaignId, 'CONTROL_PLANE');
      expect(found?.decision).toBe('REFUSED');
      return found!;
    });
    expect(refused.decidedReason).toContain('open finding');

    /*
     * The guard, asked directly rather than through a second press the card no
     * longer offers: `answerRelease` is `WHERE decision = 'REQUESTED'`, so a
     * duplicate request answers `answered: false` and re-stamps nobody's
     * decision. A retry after a lost response is the ordinary case.
     */
    const again = await fetch(`/api/factory/campaigns/${campaignId}/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'APPROVED', reason: 'changed my mind' }),
    });
    expect(again.status).toBe(200);
    expect((await again.json()).answered).toBe(false);
    const still = await getRelease(campaignId, 'CONTROL_PLANE');
    expect(still?.decision).toBe('REFUSED');
    expect(still?.decidedReason).toContain('open finding');
  });

  it('refuses a deployment policy on a plane that has no release stage', async () => {
    /*
     * The other half of the same gap, and the half that had to *not* become a
     * control. A browser can only ever pin through the forge — `repositoryRoot`
     * is empty, which is the line `execution_mode` is derived from — and the
     * hosted loop has no release stage, so a `deploymentPolicy` sent from a
     * form would have been recorded on the contract and never read by anything.
     * That is a control that pretends, which is worse than an absent one, so
     * the form does not offer the field and the service refuses the
     * combination by name rather than storing it.
     */
    const { submitObjective } = await import('../server/services/factory/contract.ts');
    /*
     * No forge stub and no repository grant, deliberately: the refusal is a
     * statement about the submission's own two fields, so it has to be
     * reachable without a network and without any row. A version that needed
     * either would be unreachable exactly where a person is most likely to hit
     * it.
     */
    const refused = await submitObjective({
      projectId,
      objective: 'Something pinned through the forge that asks to be released.',
      expectedOutcome: 'It is refused before a campaign exists.',
      repositoryRemote: 'https://github.com/Peyday007/brain-worker-bootstrap',
      deploymentPolicy: 'CONTROL_PLANE_AFTER_VERIFICATION',
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeTruthy();
    expect(String((refused as Error).message)).toMatch(/no release stage/);
    // And the local plane still accepts one, because there it is honoured.
    expect(
      (await getRelease(campaignId, 'CONTROL_PLANE'))?.decision,
      'the local campaign this suite set up is still waiting on a person',
    ).toBe('REQUESTED');
  });

  it('is the server’s decision, not the screen’s', async () => {
    /*
     * A hidden button is not authorization and this card does not claim to be
     * one: it is rendered for everybody who can read the campaign, exactly as
     * the approve control beside it is, and the route decides. So the assertion
     * is on the route, from the same session, with the level lowered.
     *
     * **The role has to be a real one, and this asserts that before it uses
     * it.** An earlier version of this test lowered the level to `'READER'`,
     * which is not a `ProjectRole` at all — `PROJECT_ROLES` is `OWNER`,
     * `ADMIN`, `MEMBER`, `VIEWER`. The refusal still arrived, so the test
     * passed, but it arrived through `roleAtLeast`'s unknown-role branch
     * (`PROJECT_ROLES.indexOf(role) === -1`) rather than through the rank
     * comparison this test exists to exercise. It proved that an impossible
     * role is refused, which nothing in production can produce, instead of
     * that the lowest role a person can actually hold is. That is the vacuous
     * guard this repository keeps correcting, and it survived because
     * `tsconfig.json` did not compile `tests/**\/*.tsx`.
     *
     * So `VIEWER` is named, and its two load-bearing properties are asserted
     * rather than assumed: it *is* a real role, and it is nonetheless below
     * the `MEMBER` that `WRITE` needs. Swap either one and this fails here,
     * naming the reason, instead of passing for the wrong one.
     */
    expect(PROJECT_ROLES).toContain('VIEWER');
    expect(roleAtLeast('VIEWER', 'MEMBER'), 'VIEWER ranks below the MEMBER that WRITE needs').toBe(
      false,
    );

    brainAdmin = false;
    role = 'VIEWER';
    const refused = await fetch(`/api/factory/campaigns/${campaignId}/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'APPROVED', reason: 'not mine to give' }),
    });
    expect(refused.status).toBe(404);
    expect((await getRelease(campaignId, 'CONTROL_PLANE'))?.decision).toBe('REQUESTED');
  });
});

describe('the deliverable of a campaign that ran on a checkout', () => {
  /*
   * `assemble.ts` stops at a reviewed branch and a patch and sets `prRef`, never
   * `prUrl` — publishing is deliberately not the factory's. The card read only
   * `prUrl`, so a finished local campaign said "No pull request yet" while the
   * thing a person needed sat on a named branch.
   */
  it('names the branch and commit instead of saying there is nothing', async () => {
    await patchCampaign(campaignId, {
      state: 'COMPLETE',
      stageDetail: 'assembled',
      prRef: 'factory/campaign/local-1',
      integrationSha: INTEGRATION,
    });
    await act(async () => {
      render(createElement(BuildView, { projectId }));
    });
    await waitFor(() => expect(screen.getByText('factory/campaign/local-1')).toBeTruthy());
    expect(screen.getByText(INTEGRATION.slice(0, 12))).toBeTruthy();
    expect(screen.queryByText(/No pull request yet/)).toBeNull();
  });
});

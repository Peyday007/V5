/**
 * The Design kernel screen over the real route over the real database.
 *
 * ---------------------------------------------------------------------------
 * Why this seam needs its own file
 * ---------------------------------------------------------------------------
 *
 * `laborSurface.test.tsx` records the reason and §33 records what it cost in
 * production: a component suite over a scripted `fetch` and a service suite
 * with no screen both pass for a control that posts a field the route does not
 * take, or a screen that renders nothing at all. §42's kernel had *neither*
 * half of that pair — `server/services/design/` had no HTTP route and no
 * client screen, so everything it derives every tick (which screens it would
 * look at first and why, how weak each of its own abilities is, what it found,
 * what the owner told it, what it learned and what it is trying to become able
 * to do) was readable only from a terminal. This is the seam between them.
 *
 * ---------------------------------------------------------------------------
 * What is asserted here and nowhere else
 * ---------------------------------------------------------------------------
 *
 * **Every sentence on the screen is the server's.** Surfaces, capabilities,
 * findings, cycles, patterns, corrections and expansions are read straight off
 * `designKernelView()`'s own rows, so a person reading the screen and an
 * operator reading `npm run capability` (or the repository directly) are
 * reading one answer.
 *
 * **An unknown is never rendered as a number.** A capability nothing
 * implements has `demandKnown: false`, and the screen must print "not
 * measured" rather than `0` — a zero there would read as a settled absence
 * rather than the absence of a reading, which is exactly the confident wrong
 * answer §30 and §38 both record as worse than no answer.
 *
 * **This is Brain-wide, not project-scoped.** §42's tables carry no
 * `project_id`, so the door is guarded like the other Brain-wide readers —
 * `requirePerson()` then `requireBrainAdmin()`, exactly as `POST
 * /api/people/:userId/claude/adopt` already has it — and a project `ADMIN` is
 * refused the identical way a stranger is.
 *
 * **Reading performs no write.** Two consecutive GETs must leave every
 * `design_*` table exactly as it was, and the client's own api module must
 * issue nothing but that one GET.
 *
 * The jsdom-by-hand construction, the dynamic imports and the real socket are
 * all `machinesBrowserToDatabase`'s; see its opening comment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { ensureArchitectureScope } from '../server/services/capability/ingest.ts';
import { designRouter } from '../server/routes/design.ts';
import { peopleRouter } from '../server/routes/people.ts';
import { russellRouter } from '../server/routes/russell.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { getDb } from '../server/db/database.ts';
import { seedDesignKernel } from '../server/services/design/kernel.ts';
import {
  openCycle,
  closeCycle,
  recordCapture,
  recordFinding,
  recordCorrection,
} from '../server/repos/design.ts';
import { describeCapability, SEED_CAPABILITIES } from '../server/services/design/capabilities.ts';
import { SEED_SURFACES } from '../server/services/design/surfaces.ts';
import { SEED_PATTERNS } from '../server/services/design/patterns.ts';
import type { CaptureReadings } from '../server/domain/design.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';

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

const { cleanup, render, screen, waitFor } = await import('@testing-library/react');
const { act, createElement } = await import('react');
const { DesignKernel } = await import('../client/src/russell/DesignKernel.tsx');
const { parseRoute, pathFor } = await import('../client/src/lib/router.ts');

/** The eight section containers, present whatever the data — §29's rule that a screen must not disappear a section for want of rows. */
const SECTION_CLASSES = [
  'rs-design-runtime',
  'rs-design-surfaces',
  'rs-design-capabilities',
  'rs-design-findings',
  'rs-design-cycles',
  'rs-design-patterns',
  'rs-design-corrections',
  'rs-design-expansions',
];

const DESIGN_TABLES = [
  'design_surfaces',
  'design_cycles',
  'design_captures',
  'design_reviews',
  'design_findings',
  'design_corrections',
  'design_patterns',
  'design_capabilities',
  'design_expansions',
  'design_bin_requests',
];

/**
 * A content hash of every design_* table, order-independent.
 *
 * `cashDashboard.test.ts` establishes the shape: each row is serialized with
 * its keys sorted and the row strings sorted, so a difference in the order two
 * backends return rows in is not a difference in the rows, and any changed
 * column anywhere shows up as an inequality naming its table.
 */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of DESIGN_TABLES) {
    const rows = await getDb().all(`SELECT * FROM ${table}`, []);
    out[table] = rows
      .map((row) =>
        JSON.stringify(
          Object.keys(row as Record<string, unknown>)
            .sort()
            .map((key) => [key, (row as Record<string, unknown>)[key]]),
        ),
      )
      .sort()
      .join('\n');
  }
  return out;
}

const NO_READINGS: CaptureReadings = {
  horizontalOverflow: false,
  clipped: [],
  offenders: [],
  unreachable: [],
  overlaps: [],
  smallTargets: [],
  lowContrast: [],
  reachableControls: [],
  deepestNesting: null,
  counts: { interactive: 0, headings: 0, landmarks: 0, textNodes: 0 },
  outline: [],
  unreadable: [],
  partial: [],
};

/** A capture, so a finding has the row its schema requires it to point at. */
async function makeCapture(surfaceKey: string): Promise<string> {
  const capture = await recordCapture({
    cycleId: null,
    pass: 0,
    surfaceKey,
    screen: surfaceKey.split('/')[0]!,
    stateKey: surfaceKey.split('/')[1] ?? 'default',
    viewportName: 'desktop',
    width: 1280,
    height: 800,
    revision: 'rev-test',
    treeDirty: false,
    contentHash: 'a'.repeat(64),
    byteSize: 1234,
    artifactRef: `design-captures/${surfaceKey}/test.png`,
    engine: 'chromium',
    engineVersion: '141.0',
    readings: NO_READINGS,
    capturedAt: new Date().toISOString(),
  });
  return capture.id;
}

let projectId = '';
let archProjectId = '';
let userId = '';
let otherUserId = '';
let workerId = 'wrk_test';
let server: Server | null = null;
const realFetch = globalThis.fetch;

/**
 * Who is driving these requests.
 *
 * Reset in `beforeEach`, so a block that lowers it cannot leak into the next.
 * `ARCH_ADMIN` is a person who administers the real architecture project — the
 * one project this kernel is Brain-wide over the top of — and must be refused
 * exactly as a stranger is, because §42's tables carry no `project_id` at all.
 */
type Mode = 'BRAIN_ADMIN' | 'MEMBER' | 'ARCH_ADMIN' | 'WORKER' | 'ANONYMOUS';
let mode: Mode = 'BRAIN_ADMIN';

function principalFor(): Principal | null {
  if (mode === 'ANONYMOUS') return null;
  if (mode === 'WORKER') {
    return {
      type: 'WORKER',
      id: workerId,
      handle: 'a-worker',
      displayName: 'A worker',
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: 'cre_worker',
      authMethod: 'WORKER_BEARER',
      memberships: [],
      requestId: 'req',
    } as Principal;
  }
  const membership: ProjectMembership = {
    id: 'mem',
    projectId: mode === 'ARCH_ADMIN' ? archProjectId : projectId,
    principalType: 'HUMAN',
    principalId: mode === 'ARCH_ADMIN' ? otherUserId : userId,
    role: 'ADMIN',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
    grantedAt: '2026-01-01T00:00:00.000Z',
    active: true,
    revokedAt: null,
  };
  return {
    type: 'HUMAN',
    id: mode === 'ARCH_ADMIN' ? otherUserId : userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
    isBrainAdmin: mode === 'BRAIN_ADMIN',
    mustChangePassword: false,
    credentialId: 'ses_browser',
    authMethod: 'SESSION_COOKIE',
    memberships: [membership],
    requestId: 'req',
  } as Principal;
}

let requestLog: { method: string; path: string }[] = [];

beforeEach(async () => {
  mode = 'BRAIN_ADMIN';
  requestLog = [];
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const arch = await ensureArchitectureScope();
  archProjectId = arch.id;

  const user = await createUser({
    email: `design-${Math.random().toString(36).slice(2, 10)}@example.test`,
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

  const other = await createUser({
    email: `design-other-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'A project administrator',
    password: 'correct horse battery staple',
    isBrainAdmin: false,
  });
  otherUserId = other.id;
  await grantMembership({
    projectId: archProjectId,
    principalType: 'HUMAN',
    principalId: otherUserId,
    role: 'ADMIN',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    requestLog.push({ method: req.method, path: req.path });
    attachContext(req, {
      principal: principalFor(),
      requestId: newRequestId(),
      /*
       * `req.path` in a middleware registered with no mount path is the
       * *whole* path — prefixing `/api` again yields `/api/api/…`, which
       * matches no pattern in `services/identity/policy.ts` and would
       * silently authorize every write at the wrong level. §41's own
       * measurement of this exact mistake.
       */
      path: req.path,
      method: req.method,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api', designRouter);
  app.use('/api', peopleRouter);
  app.use('/api', russellRouter);
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

async function mount(): Promise<void> {
  await act(async () => {
    render(createElement(DesignKernel));
  });
  await waitFor(() => expect(screen.getByText('Design kernel')).toBeTruthy());
}

function sectionsPresent(): Set<string> {
  return new Set(
    SECTION_CLASSES.filter((cls) => dom.window.document.querySelector(`.${cls}`) !== null),
  );
}

describe('the Design kernel screen, over the real route', () => {
  it('shows the surfaces, capabilities, patterns and corrections the server derived', async () => {
    await seedDesignKernel();

    // A capture and a finding, so one capability's demand is a real number
    // rather than the absence of a reading.
    const captureId = await makeCapture('russell/default');
    await recordFinding({
      cycleId: null,
      reviewId: null,
      captureId,
      pass: 0,
      surfaceKey: 'russell/default',
      region: 'primary heading',
      lane: 'MEASURED',
      kind: 'CONTRAST_BELOW_FLOOR',
      primitive: 'ACCESSIBILITY',
      statement: 'The primary heading measures 3.1:1 against its surface, under the 4.5:1 floor.',
      whyItMatters: 'Somebody with low vision cannot read the one thing this screen leads with.',
      severity: 'MAJOR',
      evidence: {},
      proposedRepair: 'Use --ink rather than --ink-faint for this heading.',
    });

    const correctionText =
      'Make the primary action smaller — it is fighting the heading for attention.';
    await recordCorrection({
      surfaceKey: 'russell/default',
      beforeCaptureId: null,
      afterCaptureId: null,
      correction: correctionText,
      components: ['primary-button'],
      lesson: null,
      scope: 'SCREEN',
      scopeRef: 'russell/default',
      confidence: 'MEDIUM',
      recordedByUserId: userId,
    });

    await mount();

    // Every registered surface, by its own title — not a paraphrase.
    for (const surface of SEED_SURFACES) {
      expect(screen.getAllByText(surface.title).length).toBeGreaterThan(0);
    }
    expect(dom.window.document.querySelectorAll('.rs-design-ranked > li')).toHaveLength(
      SEED_SURFACES.length,
    );

    // Every registered capability, by the service's own maturity sentence.
    expect(dom.window.document.querySelectorAll('.rs-design-caps > li')).toHaveLength(
      SEED_CAPABILITIES.length,
    );
    for (const seed of SEED_CAPABILITIES) {
      // Every seeded capability is inserted ABSENT/UNTESTED with no
      // observations — `declareCapability` cannot write a state, so this is
      // what the row actually reads until a reading moves it.
      const description = describeCapability({
        ...seed,
        abilityState: 'ABSENT',
        evidenceState: 'UNTESTED',
        observations: 0,
        failures: 0,
      } as any);
      expect(screen.getAllByText(description).length, seed.capabilityKey).toBeGreaterThan(0);
    }

    // Every seed pattern's statement, verbatim.
    expect(dom.window.document.querySelectorAll('.rs-design-pattern-list > li')).toHaveLength(
      SEED_PATTERNS.length,
    );
    for (const pattern of SEED_PATTERNS) {
      expect(screen.getAllByText(pattern.statement).length, pattern.branch ?? '').toBeGreaterThan(
        0,
      );
    }

    // The correction, the exact words a person typed, and its scope.
    const blockquote = screen.getByText(correctionText);
    expect(blockquote.tagName.toLowerCase()).toBe('blockquote');
    expect(screen.getByText('Not yet taken as a lesson.')).toBeTruthy();
    expect(screen.getByText(/screen.*russell\/default.*medium/i)).toBeTruthy();
  }, 60000);

  it('renders an unknown as words, never as a number', async () => {
    await seedDesignKernel();
    const captureId = await makeCapture('russell/default');
    // One finding under ACCESSIBILITY, so MEASURE_ACCESSIBILITY_FLOOR — whose
    // route is declared — reads a real, counted demand.
    await recordFinding({
      cycleId: null,
      reviewId: null,
      captureId,
      pass: 0,
      surfaceKey: 'russell/default',
      region: 'primary heading',
      lane: 'MEASURED',
      kind: 'CONTRAST_BELOW_FLOOR',
      primitive: 'ACCESSIBILITY',
      statement: 'Below the floor.',
      whyItMatters: 'Somebody cannot read it.',
      severity: 'MAJOR',
      evidence: {},
      proposedRepair: 'Use a darker ink.',
    });

    await mount();

    // ABSENT / UNTESTED — the state every seeded capability starts in, and the
    // literal words rather than a percentage, a checkmark or a colour class.
    const measured = screen.getByText(
      'Measure contrast and target size against a stated floor',
    ).closest('li')!;
    expect(measured.querySelector('.rs-design-ability')!.textContent).toBe('absent');
    expect(measured.querySelector('.rs-design-evidence')!.textContent).toBe('untested');
    // The demand is known (a route is declared) and is the one finding above.
    expect(measured.textContent).toMatch(/Demand:\s*1\b/);

    // A capability nothing implements — no route at all — reports its demand
    // as the absence of a reading, never as the zero a percentage would show.
    const unimplemented = screen
      .getByText('Judge interaction on a handheld screen — reach, gesture, thumb travel, sheets')
      .closest('li')!;
    expect(unimplemented.querySelector('.rs-design-ability')!.textContent).toBe('absent');
    expect(unimplemented.querySelector('.rs-design-evidence')!.textContent).toBe('untested');
    expect(unimplemented.textContent).toMatch(/Demand:\s*not measured/);
    expect(unimplemented.textContent).not.toMatch(/Demand:\s*\d/);
  }, 60000);

  it('renders a closed cycle and its open finding, written through the repository', async () => {
    const cycle = await openCycle({
      triggerKind: 'OWNER_REQUEST',
      triggerRef: null,
      surfaceKeys: ['russell/default'],
      revision: 'rev-test',
    });
    const captureId = await makeCapture('russell/default');
    const { finding } = await recordFinding({
      cycleId: cycle.id,
      reviewId: null,
      captureId,
      pass: 0,
      surfaceKey: 'russell/default',
      region: 'primary heading',
      lane: 'MEASURED',
      kind: 'CONTRAST_BELOW_FLOOR',
      primitive: 'ACCESSIBILITY',
      statement: 'The primary heading is below the contrast floor.',
      whyItMatters: 'Low vision cannot read it.',
      severity: 'MAJOR',
      evidence: {},
      proposedRepair: 'Use --ink rather than --ink-faint.',
    });
    const closed = await closeCycle({
      id: cycle.id,
      stopReason: 'REPAIR_EXHAUSTED',
      stopDetail: 'Three repair rounds spent; the contrast finding is still open.',
    });
    expect(closed).toBe(true);

    await mount();

    // The cycle: closed, its trigger, and the reason it stopped — the
    // server's own words, not a state a screen composed.
    expect(screen.getByText('closed')).toBeTruthy();
    expect(screen.getByText('owner request')).toBeTruthy();
    expect(screen.getByText(/0 pass\(es\) — repair exhausted/)).toBeTruthy();
    expect(
      screen.getByText('Three repair rounds spent; the contrast finding is still open.'),
    ).toBeTruthy();

    // The finding: its surface, its severity, its kind — verbatim.
    expect(screen.getByText('russell/default')).toBeTruthy();
    expect(screen.getByText('major')).toBeTruthy();
    expect(screen.getByText('contrast below floor')).toBeTruthy();
    expect(screen.getByText(finding.statement)).toBeTruthy();
    expect(screen.getByText(finding.whyItMatters)).toBeTruthy();
  }, 60000);

  it('renders its own empty sentence per section on an empty database, with the same sections present', async () => {
    await mount();

    expect(screen.getByText('No surface is registered yet.')).toBeTruthy();
    expect(screen.getByText('No capability is registered yet.')).toBeTruthy();
    expect(screen.getByText('Nothing is open.')).toBeTruthy();
    expect(screen.getByText('No cycle has run yet.')).toBeTruthy();
    expect(screen.getByText('No pattern has been recorded yet.')).toBeTruthy();
    expect(screen.getByText('Nothing has been recorded yet.')).toBeTruthy();
    expect(screen.getByText('Nothing has been proposed yet.')).toBeTruthy();

    // The same eight sections exist on an empty kernel as on a populated one —
    // a section must never come and go with the data.
    const empty = sectionsPresent();
    cleanup();

    await seedDesignKernel();
    await mount();
    const populated = sectionsPresent();

    expect([...empty].sort()).toEqual(SECTION_CLASSES.slice().sort());
    expect(populated).toEqual(empty);
  }, 60000);
});

describe('who may read the design kernel, and who may not', () => {
  it('refuses a worker principal with the same 404 a missing route gives', async () => {
    mode = 'WORKER';
    const response = await fetch('/api/design/kernel');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'No such route.' });
  }, 60000);

  /**
   * Four callers, none of them a Brain administrator, refused byte-identically
   * — to each other and to another Brain-wide door's own refusal.
   *
   * §42's tables carry no `project_id`, so a project `ADMIN` — even of the
   * real architecture project this kernel's own expansion loop files research
   * against — is exactly as much a stranger here as somebody signed in on an
   * unrelated project, a worker, or nobody at all. `services/design/scope.ts`
   * only chooses where the kernel *files its own bins*; it is never a
   * readership boundary, and this is the test that would fail if it were
   * mistaken for one.
   */
  it('gives a non-admin person, an architecture-project admin and an anonymous caller the same 404 people/claude/adopt gives', async () => {
    const adoptRefusal = async (): Promise<{ status: number; body: unknown }> => {
      const response = await fetch(`/api/people/${otherUserId}/claude/adopt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      return { status: response.status, body: await response.json() };
    };

    mode = 'MEMBER';
    const nonAdmin = await fetch('/api/design/kernel');
    mode = 'ARCH_ADMIN';
    const archAdmin = await fetch('/api/design/kernel');
    mode = 'ANONYMOUS';
    const anonymous = await fetch('/api/design/kernel');

    for (const response of [nonAdmin, archAdmin, anonymous]) {
      expect(response.status).toBe(404);
    }
    const nonAdminBody = await nonAdmin.json();
    const archAdminBody = await archAdmin.json();
    const anonymousBody = await anonymous.json();
    expect(nonAdminBody).toEqual({ error: 'No such route.' });
    expect(archAdminBody).toEqual(nonAdminBody);
    expect(anonymousBody).toEqual(nonAdminBody);

    // A person who is not authorized to adopt somebody else's connection
    // (they are not a Brain administrator, so `POST .../claude/adopt` also
    // refuses them) gets the identical body — the same guard, at a different
    // door.
    mode = 'MEMBER';
    const otherDoor = await adoptRefusal();
    expect(otherDoor.status).toBe(404);
    expect(otherDoor.body).toEqual(nonAdminBody);
  }, 60000);
});

describe('reading the design kernel performs no write', () => {
  it('leaves every design_* table unchanged across two consecutive reads', async () => {
    await seedDesignKernel();
    const captureId = await makeCapture('russell/default');
    await recordFinding({
      cycleId: null,
      reviewId: null,
      captureId,
      pass: 0,
      surfaceKey: 'russell/default',
      region: 'primary heading',
      lane: 'MEASURED',
      kind: 'CONTRAST_BELOW_FLOOR',
      primitive: 'ACCESSIBILITY',
      statement: 'Below the floor.',
      whyItMatters: 'Somebody cannot read it.',
      severity: 'MAJOR',
      evidence: {},
      proposedRepair: 'Use a darker ink.',
    });
    await recordCorrection({
      surfaceKey: 'russell/default',
      beforeCaptureId: null,
      afterCaptureId: null,
      correction: 'Make the primary action smaller.',
      components: [],
      lesson: null,
      scope: 'ONE_OFF',
      scopeRef: null,
      confidence: 'LOW',
      recordedByUserId: userId,
    });

    const before = await snapshot();
    const first = await fetch('/api/design/kernel');
    expect(first.status).toBe(200);
    const second = await fetch('/api/design/kernel');
    expect(second.status).toBe(200);
    const after = await snapshot();

    expect(after).toEqual(before);
  }, 60000);

  it("issues nothing but the one GET, and the client's own module names no other call", async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('client/src/lib/designKernelApi.ts', 'utf8'),
    );
    // The whole module has exactly one call into `api()`, at the one kernel
    // path, with no second argument that could name a method or a body.
    const calls = [...source.matchAll(/\bapi(?:<[^>]*>)?\(([^)]*)\)/g)].map((match) =>
      match[1]!.trim(),
    );
    expect(calls).toEqual(["'/api/design/kernel'"]);
    expect(source).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i);

    await mount();
    const kernelCalls = requestLog.filter((entry) => entry.path === '/api/design/kernel');
    expect(kernelCalls.length).toBeGreaterThan(0);
    for (const call of requestLog) {
      expect(call.method, `${call.method} ${call.path} was recorded`).toBe('GET');
    }
  }, 60000);
});

describe('the address', () => {
  it("parses and formats '/design', and leaves '/design/decisions' to its own route", async () => {
    expect(parseRoute('/design')).toEqual({ name: 'DESIGN' });
    expect(pathFor({ name: 'DESIGN' })).toBe('/design');

    // The kernel's own door answers.
    await mount();
    expect(screen.getByText('Design kernel')).toBeTruthy();

    // And `russell.ts`'s pre-existing `/design/decisions` door is untouched by
    // mounting this one at the same prefix — a different exact path, guarded
    // by `requirePerson` alone, so a non-admin project member (refused at the
    // kernel above) reaches it without needing to be a Brain administrator.
    mode = 'MEMBER';
    const decisions = await fetch('/api/design/decisions?revision=rev-test');
    expect(decisions.status).toBe(200);
    expect(await decisions.json()).toEqual({ revision: 'rev-test', decisions: [] });

    const kernelAsMember = await fetch('/api/design/kernel');
    expect(kernelAsMember.status).toBe(404);
  }, 60000);
});

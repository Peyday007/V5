/**
 * The answering transition for a source whose reading failed.
 *
 * This exists because production needed it and there was nothing. The first
 * real fired Routine read the blueprint correctly and proposed fifteen
 * definitions; every one was rejected with "A connection carried unknown
 * field(s): kind, faculty, note", because the extraction contract named three
 * field names `validateConnections` refuses. The source went to `FAILED` — and
 * `FAILED` was terminal: `registerSource` dedupes on the content hash so the
 * same bytes could never be registered again, and `advanceSources` only ever
 * dispatches a `REGISTERED` source. Fixing the contract would have changed
 * nothing, because nothing could ask for a second reading.
 *
 * So what is pinned here is mostly what it refuses, and the one thing it must
 * not destroy: the refusals of the reading being replaced, which `putCandidate`
 * would otherwise overwrite in place the moment the next worker submits.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { registerBlueprint } from '../server/services/capability/ingest.ts';
import { reopenFailedSource, failedSources } from '../server/services/capability/reopen.ts';
import { advanceSource, getSource, listCandidates, putCandidate } from '../server/repos/faculties.ts';
import { createUser } from '../server/repos/identity.ts';
import { createBin } from '../server/repos/bins.ts';
import { getSource as readSourceRow } from '../server/repos/faculties.ts';
import { facultySlug } from '../server/domain/faculties.ts';

const BLUEPRINT = [
  '# Brain Intelligence Map',
  '',
  '## 5. The Faculties',
  '',
  '### 5.1 Research Intelligence',
  '',
  'It answers questions about the world from sources it can cite.',
  '',
].join('\n');

let adminEmail = '';
let sourceId = '';

async function register(): Promise<string> {
  const registered = await registerBlueprint({
    filename: 'Brain_Intelligence_Map.md',
    contents: Buffer.from(BLUEPRINT, 'utf8'),
    title: 'Brain Intelligence Map',
    kind: 'BLUEPRINT',
    origin: 'the reopen suite',
    registeredBy: 'test',
  });
  return registered.source.id;
}

/** Put the source where production actually was: read, refused, terminal. */
async function failItWithRefusals(): Promise<string> {
  const source = await readSourceRow(sourceId);
  const bin = await createBin({
    projectId: String(source?.projectId),
    layerId: null,
    kind: 'CAPABILITY_EXTRACTION',
    title: 'Read the capability blueprint',
    objective: 'o',
    rationale: 'r',
    manifest: { objective: 'o', why: 'w', units: [], outputs: [] } as never,
    completionContract: 'BLUEPRINT_EXTRACTION_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
  } as never);
  await advanceSource({ id: sourceId, from: 'REGISTERED', to: 'EXTRACTING', binId: bin.id });
  await putCandidate({
    sourceId,
    binId: bin.id,
    definition: {
      slug: facultySlug('Research Intelligence'),
      ordinal: 1,
      canonicalName: 'Research Intelligence',
      purpose: 'p',
      centralQuestion: null,
      promisedPower: 'q',
      responsibilities: [],
      boundaries: [],
      inputs: [],
      outputs: [],
      activationConditions: [],
      reentryConditions: [],
      dependencies: [],
      infrastructure: [],
      allowedProposals: [],
      invariants: [],
      evaluationRequirements: [],
      failureModes: [],
      connections: [],
    },
    evidenceQuote: 'It answers questions about the world from sources it can cite.',
    evidenceBlockId: null,
    evidencePage: null,
    state: 'REJECTED',
    rejectionReason: 'A connection carried unknown field(s): kind, faculty, note.',
  });
  await advanceSource({
    id: sourceId,
    from: 'EXTRACTING',
    to: 'FAILED',
    detail: 'No candidate survived validation, so there is nothing to audit.',
  });
  return bin.id;
}

beforeEach(async () => {
  await freshProject();
  adminEmail = `reopen-${Date.now()}@example.com`;
  await createUser({
    email: adminEmail,
    displayName: 'The administrator',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  });
  sourceId = await register();
});

describe('reopening a failed source', () => {
  it('refuses a source that is not FAILED, and names the state it is in', async () => {
    const outcome = await reopenFailedSource({
      sourceId,
      requestedByEmail: adminEmail,
      reason: 'the contract was corrected',
    });
    expect(outcome.reopened).toBe(false);
    expect(outcome.reason).toContain('REGISTERED');
    expect((await getSource(sourceId))?.ingestState).toBe('REGISTERED');
  });

  it('refuses an address that is not an enabled administrator', async () => {
    await failItWithRefusals();
    await createUser({
      email: 'ordinary@example.com',
      displayName: 'A member',
      password: 'a-long-enough-password',
      isBrainAdmin: false,
    });
    await expect(
      reopenFailedSource({
        sourceId,
        requestedByEmail: 'ordinary@example.com',
        reason: 'the contract was corrected',
      }),
    ).rejects.toThrow(/no enabled administrator/);
    // And it changed nothing on the way to refusing.
    expect((await getSource(sourceId))?.ingestState).toBe('FAILED');
  });

  it('refuses a reopening with no reason, because a second activation needs one', async () => {
    await failItWithRefusals();
    await expect(
      reopenFailedSource({ sourceId, requestedByEmail: adminEmail, reason: '   ' }),
    ).rejects.toThrow(/must say why/);
    expect((await getSource(sourceId))?.ingestState).toBe('FAILED');
  });

  it('reports a source that does not exist rather than throwing', async () => {
    const outcome = await reopenFailedSource({
      sourceId: 'cps_nothing',
      requestedByEmail: adminEmail,
      reason: 'the contract was corrected',
    });
    expect(outcome.reopened).toBe(false);
    expect(outcome.source).toBeNull();
  });

  it('puts it back, and destroys neither the candidates nor the document', async () => {
    await failItWithRefusals();
    const before = await getSource(sourceId);

    const outcome = await reopenFailedSource({
      sourceId,
      requestedByEmail: adminEmail,
      reason: 'the extraction contract named the wrong connection fields',
    });

    expect(outcome.reopened).toBe(true);
    expect(outcome.source?.ingestState).toBe('REGISTERED');
    // The lineage and the bytes are untouched: this buys a reading, not a new source.
    expect(outcome.source?.id).toBe(before?.id);
    expect(outcome.source?.version).toBe(before?.version);
    expect(outcome.source?.contentHash).toBe(before?.contentHash);
    expect(outcome.source?.documentId).toBe(before?.documentId);
    // The refused candidate keeps its own row and its own reason.
    const candidates = await listCandidates({ sourceId });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.state).toBe('REJECTED');
    expect(candidates[0]?.rejectionReason).toContain('unknown field(s)');
  });

  it('carries the refusals onto the project history, because the next reading overwrites them',
    async () => {
      await failItWithRefusals();
      await reopenFailedSource({
        sourceId,
        requestedByEmail: adminEmail,
        reason: 'the extraction contract named the wrong connection fields',
      });

      const row = await getDb().get<{ payload: string }>(
        `SELECT payload FROM project_events WHERE event_type = 'CAPABILITY_SOURCE_REOPENED'`,
        [] as never[],
      );
      expect(row).toBeTruthy();
      const payload = JSON.parse(String(row?.payload)) as {
        refusals: { rejectionReason: string | null; slug: string }[];
        requestedByEmail: string;
        authorityChannel: string;
        reason: string;
      };
      expect(payload.refusals).toHaveLength(1);
      expect(payload.refusals[0]?.rejectionReason).toContain('kind, faculty, note');
      expect(payload.requestedByEmail).toBe(adminEmail);
      // Attribution is not authentication: the channel defaults to the weaker value.
      expect(payload.authorityChannel).toBe('SHELL');
      expect(payload.reason).toContain('connection fields');

      /*
       * And the reason this event exists at all: the next reading replaces the
       * candidate row in place, so without it the evidence that the contract
       * was wrong would be destroyed by the fix for it.
       */
      await putCandidate({
        sourceId,
        binId: null,
        definition: {
          slug: facultySlug('Research Intelligence'),
          ordinal: 1,
          canonicalName: 'Research Intelligence',
          purpose: 'p',
          centralQuestion: null,
          promisedPower: 'q',
          responsibilities: [],
          boundaries: [],
          inputs: [],
          outputs: [],
          activationConditions: [],
          reentryConditions: [],
          dependencies: [],
          infrastructure: [],
          allowedProposals: [],
          invariants: [],
          evaluationRequirements: [],
          failureModes: [],
          connections: [],
        },
        evidenceQuote: 'It answers questions about the world from sources it can cite.',
        evidenceBlockId: null,
        evidencePage: null,
        state: 'PROPOSED',
        rejectionReason: null,
      });
      const after = await listCandidates({ sourceId });
      expect(after).toHaveLength(1);
      expect(after[0]?.rejectionReason).toBeNull();
      // Gone from the row, still on the history.
      expect(payload.refusals[0]?.rejectionReason).toContain('kind, faculty, note');
    });

  it('is idempotent by effect: the second call finds it already back', async () => {
    await failItWithRefusals();
    const first = await reopenFailedSource({
      sourceId,
      requestedByEmail: adminEmail,
      reason: 'the contract was corrected',
    });
    const second = await reopenFailedSource({
      sourceId,
      requestedByEmail: adminEmail,
      reason: 'the contract was corrected',
    });

    expect(first.reopened).toBe(true);
    expect(second.reopened).toBe(false);
    // The effect is present after either call, which is what idempotency means.
    expect((await getSource(sourceId))?.ingestState).toBe('REGISTERED');
    // And exactly one reopening is on the history.
    const rows = await getDb().all<{ id: string }>(
      `SELECT id FROM project_events WHERE event_type = 'CAPABILITY_SOURCE_REOPENED'`,
      [] as never[],
    );
    expect(rows).toHaveLength(1);
  });

  it('lists what an operator could reopen, and nothing else', async () => {
    expect(await failedSources()).toHaveLength(0);
    await failItWithRefusals();
    const failed = await failedSources();
    expect(failed.map((one) => one.id)).toEqual([sourceId]);
    await reopenFailedSource({
      sourceId,
      requestedByEmail: adminEmail,
      reason: 'the contract was corrected',
    });
    expect(await failedSources()).toHaveLength(0);
  });
});

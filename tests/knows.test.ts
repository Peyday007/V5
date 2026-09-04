/**
 * Knows — the projection over what the Brain already researched.
 *
 * The defect these tests pin down is the one a person actually hit: the Brain
 * held real, accepted, cited research and the Knows surface showed almost
 * nothing, because the only table it read was the one Russell had started
 * filling that week. A projection that is missing is indistinguishable, from
 * the outside, from a Brain that knows nothing.
 *
 * So the properties worth testing are not "does it return rows". They are:
 * does it return the *archive's* rows, does it carry their evidence chain
 * intact, and does it refuse to promote a provisional claim into an accepted
 * one because that would read better.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { createRun } from '../server/repos/runs.ts';
import { knowsForProject, surfaceState } from '../server/services/russell/knows.ts';

let projectId = '';
let layerId = '';
let orchestrationId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await fixture.layerByName('Monetization Logic')).id;
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', provider: 'WORKER' });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: 'Knows fixture',
    assignment: 'project what is already known',
    provider: 'WORKER',
  });
  orchestrationId = orchestration.id;
});

/** One claim, written the way the research engine writes them. */
async function claim(input: {
  id: string;
  claim: string;
  accepted: 0 | 1;
  confidence?: number;
  sourceUrl?: string | null;
  excerpt?: string | null;
  locator?: string | null;
  validation?: string;
  contradiction?: string;
  sourceDate?: string | null;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO research_claims
       (id, orchestration_id, fragment_id, pass_id, pass_key, claim, source_url, source_title,
        source_publisher, source_date, evidence_excerpt, evidence_locator, evidence_lane,
        retrieved_at, confidence, contradiction_state, contradiction_note, validation_state,
        validation_detail, sourced, derived, derived_from, accepted, content_hash, created_at)
     VALUES (?, ?, NULL, NULL, 'RESEARCH', ?, ?, ?, NULL, ?, ?, ?, 'lane-1',
             '2026-08-01T00:00:00.000Z', ?, ?, NULL, ?, NULL, 1, 0, '[]', ?, ?, '2026-08-01T00:00:00.000Z')`,
    [
      input.id,
      orchestrationId,
      input.claim,
      input.sourceUrl ?? null,
      input.sourceUrl ? 'A cited source' : null,
      input.sourceDate ?? null,
      input.excerpt ?? null,
      input.locator ?? null,
      input.confidence ?? 0.9,
      input.contradiction ?? 'UNCHALLENGED',
      input.validation ?? 'VALID',
      input.accepted,
      `hash-${input.id}`,
    ] as never[],
  );
}

describe('the archive is visible, not hidden behind an empty view', () => {
  it('projects accepted research the Brain already holds', async () => {
    await claim({
      id: 'clm_accepted',
      claim: 'Michigan requires a licence for this activity.',
      accepted: 1,
      sourceUrl: 'https://example.gov/mcl/1',
      excerpt: 'A person shall not engage without a licence.',
      locator: 'MCL 339.2401',
    });

    const entries = await knowsForProject({ projectId });
    const found = entries.find((entry) => entry.id === 'clm_accepted'.replace(/^/, 'claim:'));
    expect(found).toBeDefined();
    expect(found!.origin).toBe('RESEARCH_CLAIM');
    expect(found!.status).toBe('ACCEPTED');
    expect(found!.statement).toContain('Michigan');
  });

  it('keeps the evidence chain rather than flattening it to a sentence', async () => {
    await claim({
      id: 'clm_chain',
      claim: 'The fee is recorded in the statute.',
      accepted: 1,
      sourceUrl: 'https://example.gov/mcl/2',
      excerpt: 'The fee shall be one hundred dollars.',
      locator: 'MCL 339.2402',
      sourceDate: '2026-01-15',
    });

    const entry = (await knowsForProject({ projectId })).find((e) => e.id === 'claim:clm_chain');
    // A reader can walk back to the orchestration, the claim, the source and
    // the passage. A copy into another table is what loses exactly this.
    expect(entry!.provenance.orchestrationId).toBe(orchestrationId);
    expect(entry!.provenance.claimId).toBe('clm_chain');
    expect(entry!.provenance.sourceUrl).toBe('https://example.gov/mcl/2');
    expect(entry!.provenance.locator).toBe('MCL 339.2402');
    expect(entry!.detail).toContain('one hundred dollars');
    expect(entry!.asOf).toBe('2026-01-15');
  });

  it('copies nothing — the projection writes no row anywhere', async () => {
    await claim({ id: 'clm_nocopy', claim: 'Nothing should be duplicated.', accepted: 1 });
    const before = await getDb().all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM russell_knowledge',
    );
    await knowsForProject({ projectId });
    await knowsForProject({ projectId });
    const after = await getDb().all<{ n: number }>('SELECT COUNT(*) AS n FROM russell_knowledge');
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});

describe('epistemic status is preserved, never rounded up', () => {
  it('shows a provisional claim as provisional and names what it is missing', async () => {
    // The Florida shape: worth showing, explicitly not accepted, and short of
    // two evidence conditions.
    await claim({
      id: 'clm_provisional',
      claim: 'Florida licensing may require a separate registration.',
      accepted: 0,
      confidence: 0.55,
      sourceUrl: null,
      excerpt: null,
      locator: null,
      validation: 'NO_URL',
    });

    const entry = (await knowsForProject({ projectId })).find(
      (e) => e.id === 'claim:clm_provisional',
    );
    expect(entry!.status).toBe('PROVISIONAL');
    expect(entry!.missingEvidence).toContain('no canonical source URL was recorded');
    expect(entry!.missingEvidence).toContain('the source URL was never validated');
    expect(entry!.missingEvidence).toContain(
      'no passage or locator ties the claim to its source',
    );
  });

  it('never lets an unaccepted claim read as established, however confident it sounds', async () => {
    await claim({
      id: 'clm_confident',
      claim: 'This is stated with great conviction.',
      accepted: 0,
      confidence: 0.99,
      sourceUrl: 'https://example.com/blog',
    });
    const entry = (await knowsForProject({ projectId })).find((e) => e.id === 'claim:clm_confident');
    // The gate's decision outranks the researcher's own score.
    expect(entry!.status).toBe('PROVISIONAL');
    expect(entry!.confidence).not.toBe('ESTABLISHED');
    expect(entry!.confidence).not.toBe('SUPPORTED');
  });

  it('marks a contradicted claim as contradicted rather than dropping it', async () => {
    await claim({
      id: 'clm_contra',
      claim: 'Two sources disagree about the threshold.',
      accepted: 0,
      contradiction: 'CONTRADICTED',
      sourceUrl: 'https://example.com/a',
      excerpt: 'one figure',
    });
    const entry = (await knowsForProject({ projectId })).find((e) => e.id === 'claim:clm_contra');
    expect(entry!.status).toBe('CONTRADICTED');
    expect(entry!.kind).toBe('CONTRADICTION');
  });

  it('records a retained contradiction as missing evidence rather than silently accepting it', async () => {
    await claim({
      id: 'clm_retained',
      claim: 'The disagreement was kept rather than resolved.',
      accepted: 1,
      contradiction: 'RETAINED',
      sourceUrl: 'https://example.com/b',
      excerpt: 'a passage',
    });
    const entry = (await knowsForProject({ projectId })).find((e) => e.id === 'claim:clm_retained');
    expect(entry!.missingEvidence).toContain(
      'a contradiction was recorded and deliberately retained',
    );
  });
});

describe('the project boundary is the same one every other read uses', () => {
  it('does not show another project’s research', async () => {
    await claim({ id: 'clm_mine', claim: 'Belongs here.', accepted: 1 });
    const other = await freshProject();
    const entries = await knowsForProject({ projectId: other.project.id });
    expect(entries.some((entry) => entry.id === 'claim:clm_mine')).toBe(false);
  });
});

describe('an empty surface says which kind of empty it is', () => {
  it('distinguishes genuinely empty from nothing active', async () => {
    expect(surfaceState({ items: [], total: 0 }).emptyReason).toBe('EMPTY');
    // The distinction a filtered list otherwise destroys: there *is* work here,
    // none of it is active. "Nothing yet" would be a lie.
    expect(surfaceState({ items: [], total: 7 }).emptyReason).toBe('NOTHING_ACTIVE');
  });

  it('reports not-connected, stale and unavailable as themselves', async () => {
    expect(surfaceState({ items: [], reason: 'NOT_CONNECTED' }).explanation).toMatch(
      /not connected/,
    );
    expect(surfaceState({ items: [], reason: 'STALE' }).explanation).toMatch(/out of date/);
    expect(surfaceState({ items: [], reason: 'UNAVAILABLE' }).explanation).toMatch(
      /could not be read/,
    );
  });

  it('gives forbidden and unavailable the identical sentence', async () => {
    /*
     * §24's rule at the last hop: the server cannot distinguish absent from
     * forbidden, and the interface must not invent an answer either. Two
     * different words here would be an oracle for what exists.
     */
    expect(surfaceState({ items: [], reason: 'FORBIDDEN' }).explanation).toBe(
      surfaceState({ items: [], reason: 'UNAVAILABLE' }).explanation,
    );
  });

  it('says nothing at all when there is something to show', async () => {
    const state = surfaceState({ items: [1, 2, 3], total: 3 });
    expect(state.emptyReason).toBeNull();
    expect(state.explanation).toBeNull();
  });
});

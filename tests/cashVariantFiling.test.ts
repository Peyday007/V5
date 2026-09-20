/**
 * A cash packet's report, filed into a bucket rather than onto a disk.
 *
 * §33 gave a staged research report a **variant** so that four cash packets
 * answering four different questions stopped filing under one canonical name
 * and burying each other. The separator it used is an em dash. A local disk is
 * perfectly happy with one; object storage is not, and production measured that
 * directly — `400 InvalidKey` on
 * `Opportunity Research v1B — Where the same deliverable has two published
 * prices.md`.
 *
 * The repair for that was `safeSegment`, which reduces a segment to the
 * intersection both stores accept. It is correct, it is tested, and **the live
 * filing path does not call it**: `storeFile` reaches `safeSegment` only
 * through `documentKey`, on the branch taken when an `identity` is supplied,
 * and no caller anywhere in this repository supplies one. Every stored document
 * takes the other branch, where the leaf is `sanitizeFilename`'d alone — which
 * answers a *filesystem* question and lets the em dash straight through. The
 * repair commit touched `storage/keys.ts` and not `storage.ts`, so the two
 * halves were written at two layers with nothing holding them against each
 * other, which is the same sentence §33 already had to write once about this
 * exact pair of functions.
 *
 * Nothing in the suite could see it, because the existing Supabase stand-in
 * accepts any key its caller sends. A stand-in that answers `200` to a key the
 * real store answers `400` to is not standing in for the store; it is standing
 * in for a store that cannot fail. So the fake here enforces **object
 * storage's own character class**, exactly as `tests/storage.test.ts` holds
 * `safeSegment` against that class rather than against Brain's constant — a
 * fake sharing Brain's rule would pass whatever Brain's rule became.
 *
 * What this pins is the outcome rather than the mechanism: a cash-variant
 * report reaches the bucket. How the key is made safe is the repair's business.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { getProject } from '../server/repos/projects.ts';
import { getDocument } from '../server/repos/documents.ts';
import { createRun } from '../server/repos/runs.ts';
import { buildNames } from '../server/domain/naming.ts';
import { registerRunArtifact } from '../server/services/runArtifacts.ts';
import { initStorage, resetStorage } from '../server/services/storage/index.ts';
import type { Layer, Project } from '../server/domain/types.ts';

/**
 * What Supabase Storage accepts in an object key.
 *
 * Deliberately written here rather than imported from `storage/keys.ts`. This
 * is the *store's* rule, and a fake that read Brain's copy of it would agree
 * with Brain by construction and could never disagree with the store.
 */
const OBJECT_STORAGE_KEY = /^[A-Za-z0-9/_!\-.*'() &$@=;:+,?]*$/;

interface Bucket {
  objects: Map<string, Buffer>;
  refused: { key: string; status: number }[];
}

/**
 * Supabase Storage, to the extent this test needs it — and refusing a key it
 * would really refuse.
 */
function bucketFake(): { bucket: Bucket; fetchImpl: typeof fetch } {
  const bucket: Bucket = { objects: new Map(), refused: [] };

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? 'GET';

    if (/\/storage\/v1\/object\/list\/[^/?]+$/.test(href)) {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { prefix?: string };
      const prefix = (parsed.prefix ?? '').replace(/^\/+|\/+$/g, '');
      const names = new Set<string>();
      for (const key of bucket.objects.keys()) {
        const scope = prefix ? `${prefix}/` : '';
        if (!key.startsWith(scope)) continue;
        const rest = key.slice(scope.length);
        const slash = rest.indexOf('/');
        names.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      return new Response(
        JSON.stringify(
          [...names].map((name) => ({
            name,
            id: name,
            metadata: { size: 0 },
            updated_at: '2026-01-01T00:00:00.000Z',
          })),
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const objectMatch = /\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(href);
    if (objectMatch) {
      const key = objectMatch[2]!
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/');

      // The store validates the key before it does anything with it, and a key
      // outside its character class is a 400 rather than a 404: the object was
      // never looked for.
      if (!OBJECT_STORAGE_KEY.test(key)) {
        bucket.refused.push({ key, status: 400 });
        return new Response(
          JSON.stringify({ statusCode: '400', error: 'InvalidKey', message: `Invalid key: ${key}` }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'POST' || method === 'PUT') {
        if (bucket.objects.has(key) && init?.headers && (init.headers as Record<string, string>)['x-upsert'] !== 'true') {
          return new Response('duplicate', { status: 409 });
        }
        bucket.objects.set(key, Buffer.from(init!.body as Uint8Array));
        return new Response('{}', { status: 200 });
      }
      const found = bucket.objects.get(key);
      if (!found) return new Response('not found', { status: 404 });
      return new Response(new Uint8Array(found), {
        status: 200,
        headers: { 'Content-Type': 'text/markdown', 'Content-Length': String(found.byteLength) },
      });
    }
    return new Response('unhandled', { status: 500 });
  }) as unknown as typeof fetch;

  return { bucket, fetchImpl };
}

/** The production canonical name, and the question that produced it. */
const BUCKET_QUESTION = 'Where the same deliverable has two published prices';

let project: Project;
let layer: Layer;
let bucket: Bucket;

beforeEach(async () => {
  const fixture = await freshProject();
  project = (await getProject(fixture.project.id))!;
  layer = (await listLayers(project.id))[0]!;

  const fake = bucketFake();
  bucket = fake.bucket;
  resetStorage();
  await initStorage({
    config: {
      provider: 'supabase',
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role',
      bucket: 'brain',
    },
    fetchImpl: fake.fetchImpl,
    verify: false,
  });
});

afterEach(async () => {
  resetStorage();
  await teardown();
});

async function fileWithVariant(variant: string | null): Promise<ReturnType<typeof registerRunArtifact>> {
  const run = await createRun({
    projectId: project.id,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: BUCKET_QUESTION,
  });
  return registerRunArtifact({
    run,
    layer,
    project,
    variant,
    originalFilename: `${layer.name} v1.md`,
    contents: Buffer.from('# A staged research report\n\nOne paragraph of body.\n', 'utf8'),
    notes: 'A cash packet filing into the bucket.',
  });
}

describe('a staged research report filed into object storage', () => {
  it('reaches the bucket when the packet carries a cash variant', async () => {
    const filed = await fileWithVariant(BUCKET_QUESTION);

    expect(filed.imported.documentId, filed.imported.message).not.toBeNull();
    expect(bucket.refused, 'the store refused the key this filing built').toEqual([]);
    expect(bucket.objects.size).toBe(1);
  });

  it('files without a variant, which is why nothing before Cash Mode saw this', async () => {
    // The control. Every non-cash packet files one document per layer version
    // and its name carries no separator, so this path was never exercised by
    // anything the release gate runs.
    const filed = await fileWithVariant(null);
    expect(filed.imported.documentId).not.toBeNull();
    expect(bucket.refused).toEqual([]);
  });

  it('records an address the store would answer to, not the title a person reads', async () => {
    /*
     * The canonical name keeps its em dash, and should: it is what a person
     * reads, and §33 put the separator there on purpose. What must not carry one
     * is the **key**, which is an address — so this asserts the row, because a
     * later read, a migration and a reconcile all resolve through it.
     *
     * Two facts, so a failure says which half is wrong: the name the platform
     * builds is genuinely outside the store's class, and the key derived from
     * it is not.
     */
    const names = buildNames('Opportunity Research', 'v1B', '.md', BUCKET_QUESTION);
    expect(names.canonicalName, 'the variant separator §33 added').toContain('\u2014');
    expect(OBJECT_STORAGE_KEY.test(names.filename)).toBe(false);

    const filed = await fileWithVariant(BUCKET_QUESTION);
    const document = await getDocument(filed.imported.documentId!);
    const key = document?.storageKey ?? document?.filesystemPath ?? '';
    expect(key, 'the document recorded no address at all').not.toBe('');
    expect(
      OBJECT_STORAGE_KEY.test(key),
      `the store would refuse the key on this row: ${JSON.stringify(key)}`,
    ).toBe(true);
  });
});

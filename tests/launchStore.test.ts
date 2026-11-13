import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FW_API, LISTINGS, PROMO, STORE_DIR, pngSize, readCatalog, runStore } from '../scripts/launch/store.ts';
import type { StageContext } from '../scripts/launch/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const catalog = readCatalog(root);

/** Public templates built from the plan itself, shaped like GET /product-templates/{id}. */
function templateFor(id: string): unknown {
  const ls = LISTINGS.filter((l) => l.templateId === id);
  const first = ls[0]!;
  const row = catalog.get(first.catalogId)!;
  const file = first.file ?? row.designFiles[first.fileIndex ?? 0]!;
  const dims = pngSize(new Uint8Array(fs.readFileSync(path.join(root, STORE_DIR, file))))!;
  const colors = [...new Set(ls.flatMap((l) => l.colors))];
  const sizes = [...new Set(ls.flatMap((l) => l.sizes))];
  return {
    productId: id, slug: first.templateSlug, name: first.templateSlug, supportsBackendRendering: true,
    customizableAreas: [{
      regionId: first.region, name: first.region, available: true, supportsBackendRendering: true,
      dimensions: { pixelsWidth: dims.width, pixelsHeight: dims.height }, placements: [{ id: 'fullSize' }],
    }],
    colorVariants: colors.map((c) => ({
      color: { name: c }, available: true,
      sizeVariants: sizes.map((s, i) => ({ variantId: `prv_${c}_${s}`, size: s, price: { amount: 5 + i }, available: true })),
    })),
  };
}

interface FakeProduct { id: string; name: string; slug: string; access: { type: string }; variants: Array<{ unitPrice: { value: number } }> }

function fakeFourthwall(opts: { failName?: string; promoStatus?: number } = {}) {
  const products: FakeProduct[] = [];
  const promotions: Array<{ id: string; type: string; code: string; status: string; discount: { type: string; percentage: number } }> = [];
  const calls: string[] = [];
  let n = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.replace(FW_API, '')}`);
    if (url.startsWith('https://storage.fake/')) return new Response('', { status: 200 });
    const p = url.replace(FW_API, '');
    const authed = (init?.headers as Record<string, string> | undefined)?.Authorization === `Basic ${Buffer.from('u:p').toString('base64')}`;
    let m: RegExpMatchArray | null;
    if (method === 'GET' && (m = p.match(/^\/product-templates\/(.+)$/))) return json(templateFor(decodeURIComponent(m[1]!)));
    if (!authed) return json({ error: 'unauthorized' }, 401);
    if (method === 'GET' && p === '/shops/current') return json({ id: 'sh_1', status: 'LIVE', publicDomain: 'exactlyonesolution.fourthwall.com' });
    if (method === 'GET' && p.startsWith('/products?')) return json({ results: products, totalPages: 1 });
    if (method === 'POST' && p === '/media/upload-url') {
      const b = JSON.parse(String(init?.body)) as { fileName: string };
      return json({ uploadUrl: `https://storage.fake/${b.fileName}`, fileUrl: `https://cdn.fake/${b.fileName}` }, 201);
    }
    if (method === 'POST' && p === '/media/images') return json({ id: `img_${++n}` }, 201);
    if (method === 'POST' && p === '/products') {
      const b = JSON.parse(String(init?.body)) as { name: string; profitMargin: number; productTemplateId: string; colors: string[]; sizes: string[] };
      if (b.name === opts.failName) return json({ error: 'render failed' }, 400);
      const t = templateFor(b.productTemplateId) as { colorVariants: Array<{ sizeVariants: Array<{ size: string; price: { amount: number } }> }> };
      const bases = t.colorVariants[0]!.sizeVariants.filter((s) => b.sizes.includes(s.size)).map((s) => s.price.amount);
      const prod = { id: `off_${++n}`, name: b.name, slug: `p${n}`, access: { type: 'HIDDEN' }, variants: bases.map((x) => ({ unitPrice: { value: Math.round((x + b.profitMargin) * 100) / 100 } })) };
      products.push(prod);
      return json({ productId: prod.id, images: [] }, 201);
    }
    if (method === 'GET' && p.startsWith('/promotions?')) {
      const codes = new URL(`https://x${p}`).searchParams.getAll('codes');
      return json({ results: promotions.filter((x) => !codes.length || codes.includes(x.code)), totalPages: 1 });
    }
    if (method === 'POST' && p === '/promotions') {
      if (opts.promoStatus) return json({ code: 'PROMOTION_CODE_DUPLICATION' }, opts.promoStatus);
      const b = JSON.parse(String(init?.body)) as { type: string; code: string; discount: { type: string; percentage: number } };
      const promo = { id: `pr_${++n}`, type: b.type, code: b.code, status: 'Live', discount: b.discount };
      promotions.push(promo);
      return json(promo);
    }
    if ((m = p.match(/^\/products\/([^/]+)(\/state)?$/))) {
      const prod = products.find((x) => x.id === m![1]);
      if (!prod) return json({ error: 'not found' }, 404);
      if (method === 'PUT' && m[2]) prod.access = { type: (JSON.parse(String(init?.body)) as { state: string }).state };
      return json(prod);
    }
    return json({ error: `unhandled ${method} ${p}` }, 500);
  }) as typeof fetch;
  return { fetchImpl, products, promotions, calls };
}

const ctx = (fetchImpl: typeof fetch, env: Record<string, string> = { FOURTHWALL_API_USERNAME: 'u', FOURTHWALL_API_PASSWORD: 'p' }, dryRun = false): StageContext => ({
  env: { STORE_CREATE_INTERVAL_MS: '0', ...env }, dryRun, fetch: fetchImpl, log: () => {}, root,
});

describe('launch store stage (Fourthwall)', () => {
  it('creates and publishes every listing, then finds them all on the second run', async () => {
    const fw = fakeFourthwall();
    const first = await runStore(ctx(fw.fetchImpl));
    expect(first.status).toBe('DONE');
    expect(first.items).toHaveLength(LISTINGS.length);
    expect(first.items.every((i) => i.state === 'CREATED')).toBe(true);
    expect(fw.products).toHaveLength(LISTINGS.length);
    expect(fw.products.every((p) => p.access.type === 'PUBLIC')).toBe(true);
    // the catalog's 10 products, two shirts split light/dark
    expect(new Set(LISTINGS.map((l) => l.catalogId)).size).toBe(10);
    // retail read back equals catalog.csv retail_usd
    const tee = fw.products.find((p) => p.name.startsWith('Solve Responsibly') && p.name.endsWith('(Dark Colors)'))!;
    expect(Math.min(...tee.variants.map((v) => v.unitPrice.value))).toBe(catalog.get('02')!.retail);
    expect(first.items[0]!.url).toMatch(/^https:\/\/exactlyonesolution\.fourthwall\.com\/products\//);

    const creates = fw.calls.filter((c) => c === 'POST /products').length;
    const second = await runStore(ctx(fw.fetchImpl));
    expect(second.status).toBe('DONE');
    expect(second.items.every((i) => i.state === 'EXISTS')).toBe(true);
    expect(fw.calls.filter((c) => c === 'POST /products').length).toBe(creates);
    expect(fw.products).toHaveLength(LISTINGS.length);
  });

  it('asks the owner for the API user when there are no credentials, and writes nothing', async () => {
    const fw = fakeFourthwall();
    const r = await runStore(ctx(fw.fetchImpl, {}));
    expect(r.status).toBe('NEEDS_OWNER');
    expect(r.ownerAction).toContain('FOURTHWALL_API_USERNAME');
    expect(r.ownerAction).toContain('FOURTHWALL_API_PASSWORD');
    expect(r.items.every((i) => i.state === 'WOULD_CREATE')).toBe(true);
    expect(fw.calls.every((c) => c.startsWith('GET /product-templates/'))).toBe(true);
  });

  it('keeps going when one product fails, and reports PARTIAL', async () => {
    const failName = catalog.get('06')!.title;
    const fw = fakeFourthwall({ failName });
    const r = await runStore(ctx(fw.fetchImpl));
    expect(r.status).toBe('PARTIAL');
    expect(r.items.filter((i) => i.state === 'FAILED').map((i) => i.key)).toEqual(['06-one-solution-poster']);
    expect(r.items.filter((i) => i.state === 'CREATED')).toHaveLength(LISTINGS.length - 1);
  });

  it('dry run with credentials reads the shop but writes nothing', async () => {
    const fw = fakeFourthwall();
    const r = await runStore(ctx(fw.fetchImpl, undefined, true));
    expect(r.status).toBe('DONE');
    expect(r.items.every((i) => i.state === 'WOULD_CREATE')).toBe(true);
    expect(fw.calls.some((c) => !c.startsWith('GET '))).toBe(false);
  });

  it('creates the launch code once, hands it to the Pinterest stage, and never duplicates it', async () => {
    const fw = fakeFourthwall();
    const first = await runStore(ctx(fw.fetchImpl));
    expect(first.outputs).toEqual({ promoCode: PROMO.code, promoPercent: String(PROMO.percentage) });
    expect(fw.promotions).toEqual([expect.objectContaining({ type: 'SHOP_SINGLE', code: 'PUZZLE10', discount: { type: 'PERCENTAGE', percentage: 10, shipping: 'Excluded' } })]);
    expect(first.items).toHaveLength(LISTINGS.length); // the code is not a product
    const second = await runStore(ctx(fw.fetchImpl));
    expect(second.detail).toContain('code PUZZLE10 exists (Live)');
    expect(fw.calls.filter((c) => c === 'POST /promotions')).toHaveLength(1);

    // a 409 duplication from Fourthwall also means the code exists; any other refusal never fails the store
    const dup = await runStore(ctx(fakeFourthwall({ promoStatus: 409 }).fetchImpl));
    expect(dup.outputs?.promoCode).toBe('PUZZLE10');
    const refused = await runStore(ctx(fakeFourthwall({ promoStatus: 403 }).fetchImpl));
    expect(refused.status).toBe('DONE');
    expect(refused.outputs).toBeUndefined();
    expect(refused.detail).toContain('code PUZZLE10 not available');
  });
});

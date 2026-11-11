/**
 * Print-on-demand store stage of the launch runner: publishes the puzzle-gift
 * catalog to the owner's Fourthwall shop through Fourthwall's official
 * Platform API, so the owner never uploads or designs a product himself.
 *
 * The route (docs.fourthwall.com/guides/create-design-products, read
 * 2026-11-11): request a signed upload URL → PUT the PNG bytes → register the
 * image (imageId) → POST /products with `type: "design"`, a product template,
 * the region's imageId, colors, sizes and `profitMargin` (USD on top of each
 * variant's base cost) → PUT /products/{id}/state PUBLIC. Product templates are
 * public (no auth), so a dry run verifies every template, region, colour, size
 * and variant id against Fourthwall's live catalog now.
 *
 * Idempotent: a run lists the shop's products first and matches by exact name;
 * a listing that exists is never created again, and a hidden one that carries
 * the right price is published. A product is created hidden and only published
 * once its cheapest variant reads back at the catalog's retail price, so a
 * mispriced item never goes on sale. A create whose outcome is unknown (a
 * timeout) is not retried — the next run finds it by name.
 *
 * Credentials: FOURTHWALL_API_USERNAME / FOURTHWALL_API_PASSWORD, the shop's
 * Open API user (Settings → For developers → Create API User).
 *
 *   npx tsx scripts/launch/store.ts dry-run | run
 */
import fs from 'node:fs';
import path from 'node:path';
import type { StageContext, StageResult } from './types.ts';

export const FW_API = 'https://api.fourthwall.com/open-api/v1.0';
export const STORE_DIR = 'fast-cash/launch-2026-11-11/store';
/** Create is rate limited to 5/minute per shop; one every 12.5 s stays under it. */
const DEFAULT_CREATE_INTERVAL_MS = 12_500;

type Placement = { strategy: 'FULL_REGION' } | { strategy: 'PLACEMENT_ID'; placementId: string };

/** One Fourthwall listing. Products 02 and 03 are two listings each (one print file per shirt shade). */
export interface Listing {
  key: string;
  catalogId: string;
  nameSuffix?: string;
  templateId: string;
  templateSlug: string;
  region: string;
  placement: Placement;
  colors: string[];
  sizes: string[];
  /** Print file, relative to STORE_DIR. Defaults to the catalog row's single design file. */
  file?: string;
  /** Which design file of the catalog row (for rows listing two). */
  fileIndex?: number;
  /** Check the file's aspect against each size's own aspect (posters) instead of the template area. */
  aspectFromSizes?: boolean;
  description?: string;
}

const APPAREL_FULL: Placement = { strategy: 'PLACEMENT_ID', placementId: 'fullSize' };
const FULL: Placement = { strategy: 'FULL_REGION' };
const MUG = { templateId: 'pro_4v5OfYhyRx62KW5b7Oj6Uw', templateSlug: 'white-glossy-mug-sublimation', region: 'default', placement: FULL };
const SOFTSTYLE = { templateId: 'pro_O7Dd4-6JTUuq48NSUd3TMg', templateSlug: 'gildan-unisex-softstyle-t-shirt-1', region: 'front_large', placement: APPAREL_FULL, sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL'] };
const SUPERSOFT = { templateId: 'pro_k66ZW4fsRm6c2def3itltA', templateSlug: 'bella-canvas-unisex-supersoft-t-shirt-dtg', region: 'front_large', placement: APPAREL_FULL, sizes: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'] };

// Template ids, regions, colour and size labels are Fourthwall's own, read from
// GET /product-templates/{id} on 2026-11-11. The dry run re-reads every one.
export const LISTINGS: Listing[] = [
  { key: '01-coffee-then-sudoku-mug', catalogId: '01', ...MUG, colors: ['White'], sizes: ['11oz'] },
  { key: '02-solve-responsibly-tee-light', catalogId: '02', nameSuffix: ' (Light Colors)', ...SOFTSTYLE, fileIndex: 0, colors: ['White', 'Sport Grey', 'Ice Grey', 'Daisy'] },
  { key: '02-solve-responsibly-tee-dark', catalogId: '02', nameSuffix: ' (Dark Colors)', ...SOFTSTYLE, fileIndex: 1, colors: ['Black', 'Navy', 'Charcoal', 'Forest Green'] },
  { key: '03-certified-pretty-good-tee-light', catalogId: '03', nameSuffix: ' (Light Colors)', ...SUPERSOFT, fileIndex: 0, colors: ['White', 'Athletic Heather', 'Soft Cream', 'Natural'] },
  { key: '03-certified-pretty-good-tee-dark', catalogId: '03', nameSuffix: ' (Dark Colors)', ...SUPERSOFT, fileIndex: 1, colors: ['Black', 'Navy', 'Heather Navy', 'Dark Grey Heather'] },
  {
    key: '04-merry-and-bright-holiday-sweatshirt', catalogId: '04', templateId: 'pro_14kNy0EJQkqopY-Z9Pm41A', templateSlug: 'gildan-classic-crewneck-sweatshirt-dtg',
    region: 'front_large', placement: APPAREL_FULL, colors: ['Forest Green', 'Black', 'Navy', 'Maroon'], sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL'],
  },
  { key: '05-puzzle-supplies-tote', catalogId: '05', templateId: 'pro_367', templateSlug: 'econscious-eco-friendly-tote-bag', region: 'front', placement: FULL, colors: ['Oyster'], sizes: ['One size'] },
  {
    key: '06-one-solution-poster', catalogId: '06', templateId: 'pro_15bc29bc8a324d449d', templateSlug: 'enhanced-matte-paper-poster-printed',
    region: 'default', placement: FULL, colors: ['White'], sizes: ['12" x 16"', '18" x 24"'], aspectFromSizes: true,
  },
  // Fourthwall's mug wrap is 18:7 for every size; the 15 oz file is padded with white to it.
  { key: '07-large-print-morning-puzzle-mug', catalogId: '07', ...MUG, colors: ['White'], sizes: ['15oz'], file: 'designs/07-large-print-morning-puzzle-mug/print-15oz-fourthwall-5400x2100.png' },
  {
    key: '08-focus-mode-mug', catalogId: '08', templateId: 'pro_7eff6f9b20aa4edb83', templateSlug: 'ceramic-mug-with-color-inside-1',
    region: 'default', placement: FULL, colors: ['Black', 'Red', 'Dark Blue', 'Dark Green', 'Orange'], sizes: ['11oz'],
  },
  { key: '09-sudoku-coaster', catalogId: '09', templateId: 'pro_i5KAb0LiTo2y4xMrB2JORA', templateSlug: 'glossed-cork-coaster', region: 'default', placement: FULL, colors: ['All-Over Print'], sizes: ['3.74″×3.74″'] },
  // The catalog's Spoke "Hardcover Journal - Blank" has supportsBackendRendering=false, so the API
  // cannot create it. The JournalBook hardcover notebook can; its print area is the front cover only,
  // so the cover file carries the answer small and upside-down in the corner.
  {
    key: '10-puzzle-notes-journal', catalogId: '10', templateId: 'pro_SJmfUn0YSOOwCATTBEoQKw', templateSlug: 'hardcover-bound-notebook-journalbook-uv',
    region: 'default', placement: FULL, colors: ['Navy'], sizes: ['One Size'], file: 'designs/10-puzzle-notes-journal/front-journalbook-1678x2501.png',
    description:
      'A lined hardcover notebook (5.5 × 8.5 in, 80 pages) for scratch work, strategies and streaks — with a real sudoku on the front cover ' +
      '(exactly one solution) and its answer printed small and upside-down in the corner.',
  },
];

// ---------------------------------------------------------------- catalog

export interface CatalogRow { id: string; title: string; description: string; retail: number; designFiles: string[] }

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

export function readCatalog(root: string): Map<string, CatalogRow> {
  const [header, ...rows] = parseCsv(fs.readFileSync(path.join(root, STORE_DIR, 'catalog.csv'), 'utf8'));
  if (!header) throw new Error('catalog.csv is empty');
  const col = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`catalog.csv has no ${name} column`);
    return i;
  };
  const [id, title, description, retail, files] = ['id', 'title', 'description', 'retail_usd', 'design_files'].map(col) as [number, number, number, number, number];
  const out = new Map<string, CatalogRow>();
  for (const r of rows) {
    // "designs/x/a.png | b.png": a bare name sits beside the first file.
    const listed = (r[files] ?? '').split('|').map((f) => f.trim()).filter(Boolean);
    const dir = listed[0] ? path.posix.dirname(listed[0]) : '.';
    out.set(r[id]!, {
      id: r[id]!, title: r[title]!, description: r[description]!, retail: Number(r[retail]),
      designFiles: listed.map((f) => (f.includes('/') ? f : `${dir}/${f}`)),
    });
  }
  return out;
}

/** Width and height from a PNG's IHDR, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

// ---------------------------------------------------------------- Fourthwall

interface TemplateSize { variantId: string; size: string; price: { amount: number } | null; available: boolean }
interface Template {
  productId: string; slug: string; name: string; supportsBackendRendering: boolean;
  colorVariants: Array<{ color: { name: string }; available: boolean; sizeVariants: TemplateSize[] }>;
  customizableAreas: Array<{
    regionId?: string | null; name: string; available: boolean; supportsBackendRendering?: boolean | null;
    dimensions?: { pixelsWidth: number; pixelsHeight: number } | null; placements: Array<{ id: string }>;
  }>;
}
interface Offer {
  id: string; name: string; slug: string; access: { type: string };
  variants: Array<{ unitPrice: { value: number } }>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterS?: number) { super(message); }
}

const money = (n: number): string => `$${n.toFixed(2)}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Validated plan for one listing: everything a create needs except the upload. */
interface Planned {
  listing: Listing; name: string; description: string; retail: number; profitMargin: number;
  filePath: string; bytes: Uint8Array; width: number; height: number; variantIds: string[]; notes: string[];
}

export async function runStore(ctx: StageContext): Promise<StageResult> {
  const stage = 'store';
  const user = ctx.env.FOURTHWALL_API_USERNAME;
  const pass = ctx.env.FOURTHWALL_API_PASSWORD;
  const hasCreds = Boolean(user && pass);
  const interval = Number(ctx.env.STORE_CREATE_INTERVAL_MS ?? DEFAULT_CREATE_INTERVAL_MS);
  const auth = hasCreds ? `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` : '';

  async function api<T>(method: string, p: string, body?: unknown, authed = true): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (authed) headers.Authorization = auth;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await ctx.fetch(`${FW_API}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) {
      // Never echo request headers; the body is Fourthwall's own error text.
      const ra = Number(res.headers.get('retry-after'));
      throw new HttpError(res.status, `${method} ${p.split('?')[0]} → ${res.status} ${text.slice(0, 200)}`, Number.isFinite(ra) && ra > 0 ? ra : undefined);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  // ---- 1. validate every listing against the catalog, the files and Fourthwall's public templates
  const catalog = readCatalog(ctx.root);
  const items: StageResult['items'] = [];
  const planned: Planned[] = [];
  const templates = new Map<string, Template>();
  for (const l of LISTINGS) {
    try {
      planned.push(await plan(l));
    } catch (e) {
      items.push({ key: l.key, state: 'FAILED', note: `validation: ${(e as Error).message}` });
    }
  }

  async function plan(l: Listing): Promise<Planned> {
    const row = catalog.get(l.catalogId);
    if (!row) throw new Error(`catalog.csv has no row ${l.catalogId}`);
    const rel = l.file ?? row.designFiles[l.fileIndex ?? 0];
    if (!rel) throw new Error(`catalog row ${l.catalogId} names no design file ${l.fileIndex ?? 0}`);
    const filePath = path.join(ctx.root, STORE_DIR, rel);
    if (!fs.existsSync(filePath)) throw new Error(`missing print file ${rel}`);
    const bytes = new Uint8Array(fs.readFileSync(filePath));
    const dims = pngSize(bytes);
    if (!dims) throw new Error(`${rel} is not a PNG`);
    if (!Number.isFinite(row.retail) || row.retail <= 0) throw new Error(`bad retail_usd ${row.retail}`);

    let t = templates.get(l.templateId);
    if (!t) {
      t = await api<Template>('GET', `/product-templates/${encodeURIComponent(l.templateId)}`, undefined, false);
      templates.set(l.templateId, t);
    }
    if (t.slug !== l.templateSlug) throw new Error(`template ${l.templateId} is now "${t.slug}", expected "${l.templateSlug}"`);
    if (!t.supportsBackendRendering) throw new Error(`template ${t.slug} does not support API (backend) rendering`);
    const area = t.customizableAreas.find((a) => a.regionId === l.region && a.available);
    if (!area) throw new Error(`template ${t.slug} has no available region "${l.region}"`);
    if (area.supportsBackendRendering === false) throw new Error(`region ${l.region} of ${t.slug} cannot be rendered by the API`);
    if (l.placement.strategy === 'PLACEMENT_ID') {
      const id = l.placement.placementId;
      if (!area.placements.some((p) => p.id === id)) throw new Error(`region ${l.region} has no placement ${id}`);
    }
    const notes: string[] = [];
    const fileAspect = dims.width / dims.height;
    if (l.aspectFromSizes) {
      for (const s of l.sizes) {
        const m = /([\d.]+)\D+([\d.]+)/.exec(s);
        if (!m) throw new Error(`cannot read the aspect of size "${s}"`);
        const a = Number(m[1]) / Number(m[2]);
        if (Math.abs(a - fileAspect) / a > 0.01) throw new Error(`${rel} aspect ${fileAspect.toFixed(3)} does not match size ${s} (${a.toFixed(3)})`);
        if (dims.width < Number(m[1]) * 150) notes.push(`under 150 dpi at ${s}`);
      }
    } else if (area.dimensions) {
      const { pixelsWidth: w, pixelsHeight: h } = area.dimensions;
      if (Math.abs(w / h - fileAspect) / (w / h) > 0.01) throw new Error(`${rel} is ${dims.width}×${dims.height}; region ${l.region} is ${w}×${h} (aspect differs)`);
      if (dims.width < w || dims.height < h) throw new Error(`${rel} is ${dims.width}×${dims.height}, below region ${w}×${h}`);
    }

    const variantIds: string[] = [];
    let minBase = Infinity;
    for (const c of l.colors) {
      const cv = t.colorVariants.find((v) => v.color.name === c);
      if (!cv || !cv.available) throw new Error(`colour "${c}" is not available on ${t.slug}`);
      const missing: string[] = [];
      for (const s of l.sizes) {
        const sv = cv.sizeVariants.find((v) => v.size === s && v.available && (v.price?.amount ?? 0) > 0);
        if (!sv) { missing.push(s); continue; }
        variantIds.push(sv.variantId);
        minBase = Math.min(minBase, sv.price!.amount);
      }
      if (missing.length === l.sizes.length) throw new Error(`colour "${c}" has none of sizes ${l.sizes.join(', ')}`);
      if (missing.length) notes.push(`${c} lacks ${missing.join('/')}`);
    }
    const profitMargin = Math.round((row.retail - minBase) * 100) / 100;
    if (profitMargin < 1) throw new Error(`retail ${money(row.retail)} leaves margin ${money(profitMargin)} over base ${money(minBase)}`);
    notes.unshift(`${dims.width}×${dims.height} PNG ok, ${variantIds.length} variants, base ${money(minBase)} + margin ${money(profitMargin)} = ${money(row.retail)}`);
    return {
      listing: l, name: row.title + (l.nameSuffix ?? ''), description: l.description ?? row.description, retail: row.retail, profitMargin,
      filePath, bytes, width: dims.width, height: dims.height, variantIds, notes,
    };
  }

  const ownerAction =
    'After signing up at fourthwall.com (Free plan): Settings → For developers → Open API → "Create API User". ' +
    'Save the Username and Password it shows as the GitHub Actions secrets FOURTHWALL_API_USERNAME and FOURTHWALL_API_PASSWORD ' +
    '(repo Peyday007/V5 → Settings → Secrets and variables → Actions). Brain then creates and publishes every product.';

  if (!hasCreds) {
    for (const p of planned) items.push({ key: p.listing.key, state: 'WOULD_CREATE', note: p.notes.join('; ') });
    const bad = items.filter((i) => i.state === 'FAILED').length;
    return {
      stage, status: 'NEEDS_OWNER', ownerAction, items,
      detail: `${planned.length}/${LISTINGS.length} listings validated against Fourthwall's live catalog${bad ? `, ${bad} failed validation` : ''}; no Fourthwall API credentials`,
    };
  }

  // ---- 2. what already exists in the shop
  let existing: Offer[];
  let shop: { status?: string; publicDomain?: string; domain?: string };
  try {
    shop = await api('GET', '/shops/current');
    existing = [];
    for (let page = 0; page < 50; page++) {
      const r = await api<{ results: Offer[]; totalPages?: number }>('GET', `/products?page=${page}&size=100`);
      existing.push(...r.results);
      if (!r.results.length || page + 1 >= (r.totalPages ?? 1)) break;
    }
  } catch (e) {
    const status = e instanceof HttpError && (e.status === 401 || e.status === 403) ? 'NEEDS_OWNER' : 'FAILED';
    return {
      stage, status, items, detail: `could not read the shop: ${(e as Error).message}`,
      ...(status === 'NEEDS_OWNER' ? { ownerAction: `The Fourthwall API credentials were refused. ${ownerAction}` } : {}),
    };
  }
  const domain = shop.publicDomain || shop.domain;
  const urlOf = (o: { slug?: string }): string | undefined => (domain && o.slug ? `https://${domain}/products/${o.slug}` : undefined);
  const byName = new Map(existing.filter((o) => o.access?.type !== 'ARCHIVED').map((o) => [o.name, o]));
  const priceOk = (o: Offer, retail: number): boolean => {
    const prices = o.variants.map((v) => v.unitPrice?.value).filter((v): v is number => typeof v === 'number');
    return prices.length > 0 && Math.abs(Math.min(...prices) - retail) < 0.005;
  };
  const lowest = (o: Offer): string => money(Math.min(...o.variants.map((v) => v.unitPrice?.value ?? NaN)));

  let lastCreate = 0;
  for (const p of planned) {
    const key = p.listing.key;
    const found = byName.get(p.name);
    try {
      if (found) {
        if (found.access.type === 'PUBLIC') { items.push({ key, state: 'EXISTS', url: urlOf(found) }); continue; }
        if (found.access.type !== 'HIDDEN') { items.push({ key, state: 'EXISTS', url: urlOf(found), note: `access ${found.access.type}, left as is` }); continue; }
        if (!priceOk(found, p.retail)) { items.push({ key, state: 'FAILED', note: `exists hidden at ${lowest(found)}, expected ${money(p.retail)}; not published` }); continue; }
        if (ctx.dryRun) { items.push({ key, state: 'WOULD_CREATE', url: urlOf(found), note: 'exists hidden; would publish' }); continue; }
        await api('PUT', `/products/${found.id}/state`, { state: 'PUBLIC' });
        items.push({ key, state: 'UPDATED', url: urlOf(found), note: 'published' });
        continue;
      }
      if (ctx.dryRun) { items.push({ key, state: 'WOULD_CREATE', note: p.notes.join('; ') }); continue; }

      // upload → register → create (hidden) → read back price → publish
      const fileName = path.basename(p.filePath);
      const size = p.bytes.byteLength;
      const up = await api<{ uploadUrl: string; fileUrl: string }>('POST', '/media/upload-url', { fileName, contentType: 'image/png', size });
      const put = await ctx.fetch(up.uploadUrl, {
        method: 'PUT', headers: { 'Content-Type': 'image/png', 'x-goog-content-length-range': `0,${size}` }, body: p.bytes as unknown as BodyInit,
      });
      if (!put.ok) throw new Error(`upload of ${fileName} → ${put.status}`);
      const img = await api<{ id: string }>('POST', '/media/images', { fileUrl: up.fileUrl, width: p.width, height: p.height });

      const body = {
        type: 'design', productTemplateId: p.listing.templateId, name: p.name, description: p.description,
        regions: [{
          region: p.listing.region, imageId: img.id, placementStrategy: p.listing.placement.strategy,
          ...(p.listing.placement.strategy === 'PLACEMENT_ID' ? { placementId: p.listing.placement.placementId } : {}),
        }],
        colors: p.listing.colors, sizes: p.listing.sizes, profitMargin: p.profitMargin, publishOnCreate: false,
      };
      let created: { productId?: string } | undefined;
      for (let attempt = 1; !created; attempt++) {
        const wait = lastCreate + interval - Date.now();
        if (wait > 0) await sleep(wait);
        lastCreate = Date.now();
        try {
          created = await api<{ productId?: string }>('POST', '/products', body);
        } catch (e) {
          // 429 is a definite refusal, so it is safe to try again; anything else is not retried.
          if (e instanceof HttpError && e.status === 429 && attempt < 4) { await sleep((e.retryAfterS ?? 60) * 1000); continue; }
          throw e;
        }
      }
      if (!created.productId) throw new Error('create returned no productId');
      const offer = await api<Offer>('GET', `/products/${created.productId}`);
      if (!priceOk(offer, p.retail)) {
        items.push({ key, state: 'FAILED', url: urlOf(offer), note: `created hidden but priced ${lowest(offer)}, expected ${money(p.retail)}; not published` });
        continue;
      }
      await api('PUT', `/products/${created.productId}/state`, { state: 'PUBLIC' });
      items.push({ key, state: 'CREATED', url: urlOf(offer), note: `${money(p.retail)}, published` });
    } catch (e) {
      items.push({ key, state: 'FAILED', note: (e as Error).message });
    }
  }

  const failed = items.filter((i) => i.state === 'FAILED').length;
  const ok = items.length - failed;
  const tally = (['CREATED', 'UPDATED', 'EXISTS', 'WOULD_CREATE', 'FAILED'] as const)
    .map((s) => [s, items.filter((i) => i.state === s).length] as const).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ');

  // ---- 3. the launch discount code (not a product: reported in the detail and `outputs`, never in `items`)
  const promo = await ensurePromo(api, ctx.dryRun);
  const outputs = promo.live ? { promoCode: PROMO.code, promoPercent: String(PROMO.percentage) } : undefined;
  const detail = `${LISTINGS.length} listings (10 products): ${tally}${domain ? ` · https://${domain}` : ''} · ${promo.note}`;
  if (ctx.dryRun) return { stage, status: failed ? (ok ? 'PARTIAL' : 'FAILED') : 'DONE', detail: `dry run — ${detail}`, items };
  if (failed) return { stage, status: ok ? 'PARTIAL' : 'FAILED', detail, items, ...(outputs ? { outputs } : {}) };
  // Fourthwall's API cannot change the site status; a shop still "coming soon" takes no orders.
  if (shop.status && shop.status !== 'LIVE') {
    return {
      stage, status: 'NEEDS_OWNER', items, detail: `${detail} · shop status ${shop.status}`, ...(outputs ? { outputs } : {}),
      ownerAction: 'Every product is published. Fourthwall\'s API cannot switch the shop on: in the dashboard, Site design → the status tag at top right → Live → Save (one click, once).',
    };
  }
  return { stage, status: 'DONE', detail, items, ...(outputs ? { outputs } : {}) };
}

// ---------------------------------------------------------------- launch discount code

/**
 * One shop-wide launch code, created through Fourthwall's Promotions API
 * (POST /open-api/v1.0/promotions, type SHOP_SINGLE; docs.fourthwall.com/api-reference/platform/promotions,
 * read 2026-11-11). It costs nothing to create: a buyer who uses it pays 10% less, which comes out
 * of the margin (the smallest margin in catalog.csv, the coaster's $6.75 on $12.99, stays positive).
 * Idempotent by code: the list is read first, and a 409 PROMOTION_CODE_DUPLICATION also means "exists".
 * The Pinterest stage quotes the code only when this reports it Live.
 */
export const PROMO = { code: 'PUZZLE10', percentage: 10 } as const;

interface Promotion { id?: string; code?: string; codes?: Array<{ code?: string }>; status?: string; discount?: { percentage?: number } }

async function ensurePromo(
  api: <T>(method: string, p: string, body?: unknown) => Promise<T>, dryRun: boolean,
): Promise<{ live: boolean; note: string }> {
  const has = (p: Promotion): boolean => p.code === PROMO.code || Boolean(p.codes?.some((c) => c.code === PROMO.code));
  try {
    const list = await api<{ results?: Promotion[] }>('GET', `/promotions?codes=${PROMO.code}&size=100`);
    const found = (list.results ?? []).find(has);
    if (found) return { live: found.status === 'Live', note: `code ${PROMO.code} exists (${found.status ?? 'status unknown'})` };
    if (dryRun) return { live: false, note: `would create code ${PROMO.code} (${PROMO.percentage}% off)` };
    const body = {
      type: 'SHOP_SINGLE', code: PROMO.code,
      discount: { type: 'PERCENTAGE', percentage: PROMO.percentage, shipping: 'Excluded' },
      limits: { oneUsePerCustomer: true },
    };
    let created: Promotion;
    try {
      created = await api<Promotion>('POST', '/promotions', body);
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) return { live: true, note: `code ${PROMO.code} exists` };
      throw e;
    }
    const pct = created.discount?.percentage;
    if (pct !== undefined && pct !== PROMO.percentage) {
      return { live: false, note: `code ${PROMO.code} created but reads back ${pct}% off, expected ${PROMO.percentage}%; not advertised` };
    }
    return { live: (created.status ?? 'Live') === 'Live', note: `code ${PROMO.code} created (${PROMO.percentage}% off, one use per customer)` };
  } catch (e) {
    // The code is a nicety for the pins; its failure never fails the store.
    return { live: false, note: `code ${PROMO.code} not available: ${(e as Error).message}` };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const mode = process.argv[2] ?? 'dry-run';
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  runStore({ env: process.env, dryRun: mode !== 'run', fetch, log: console.log, root })
    .then((r) => {
      console.log(`${r.stage}: ${r.status} — ${r.detail}`);
      if (r.ownerAction) console.log(`OWNER: ${r.ownerAction}`);
      for (const i of r.items) console.log(`  ${i.state.padEnd(12)} ${i.key}${i.url ? ` ${i.url}` : ''}${i.note ? ` · ${i.note}` : ''}`);
      process.exit(r.status === 'FAILED' ? 1 : 0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}

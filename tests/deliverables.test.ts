/**
 * Deliverables: what Brain can produce and check by itself.
 *
 * Every kind is proved by rendering a realistic sample and re-reading the
 * bytes, and every refusal names the problem. These are the capabilities the
 * play buckets read (`PRODUCE_<KIND>`).
 */
import { describe, expect, it } from 'vitest';
import { produce, proveCapabilities } from '../server/services/cash/deliverables/capabilities.ts';
import { messyOrdersCsv, PIPELINE_SAMPLE, SAMPLES } from '../server/services/cash/deliverables/samples.ts';
import { DELIVERABLE_KINDS, validateSubmission } from '../server/services/cash/deliverables/spec.ts';
import { readXlsx, renderXlsx } from '../server/services/cash/deliverables/xlsx.ts';
import { unzip, zip } from '../server/services/cash/deliverables/zip.ts';
import { loadTable, runPipeline, toIsoDate, toNumber } from '../server/services/cash/deliverables/pipeline.ts';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('data work on a supplied file, run by Brain from declared steps', () => {
  it('cleans and aggregates five thousand messy rows, and writes a change log', async () => {
    const produced = await produce(JSON.stringify({ spec: PIPELINE_SAMPLE.spec }), ['DATASET'], { files: new Map([[PIPELINE_SAMPLE.file, messyOrdersCsv()]]) });
    expect(produced.ok, produced.problems.join(' ')).toBe(true);
    const log = produced.files.find((f) => f.name.endsWith('change log.md'))!.bytes.toString();
    expect(log).toMatch(/Read 5020 row/);
    expect(log).toMatch(/Removed 20 duplicate row/);
    expect(log).toMatch(/Result: 12 row/);
    const book = readXlsx(produced.files.find((f) => f.name.endsWith('.xlsx'))!.bytes)[0]!;
    // Twelve region-months, every order counted once: 5000 distinct orders.
    let orders = 0;
    for (let r = 1; r <= book.maxRow; r += 1) orders += Number(book.cells.get(`${r},3`)?.value);
    expect(orders).toBe(5000);
  });

  it('normalises the values clients actually send', () => {
    expect(toNumber('$1,234.50')).toBe(1234.5);
    expect(toNumber('(120)')).toBe(-120);
    expect(toNumber('12%')).toBe(0.12);
    expect(toNumber('n/a')).toBe('n/a');
    expect(toIsoDate('03/04/2025', 'DMY')).toBe('2025-04-03');
    expect(toIsoDate('03/04/2025', 'MDY')).toBe('2025-03-04');
    expect(toIsoDate('31/02/2025', 'DMY')).toBe('31/02/2025');
    expect(toIsoDate(45667, 'YMD')).toBe('2025-01-10');
  });

  it('refuses a step naming a column or file that is not there, rather than guessing', async () => {
    const t = loadTable('a.csv', Buffer.from('Name,Amount\nA,1\nB,2\n'));
    expect(() => runPipeline(t, [{ op: 'sort', column: 'Price', order: 'asc' }], () => t)).toThrow(/No column "Price"/);
    const missing = await produce(JSON.stringify({ spec: { ...PIPELINE_SAMPLE.spec, source: { file: 'other.csv' } } }), undefined, { files: new Map() });
    expect(missing.problems.join(' ')).toMatch(/no file named "other.csv"/);
    expect(validateSubmission(JSON.stringify({ spec: { ...PIPELINE_SAMPLE.spec, steps: [{ op: 'exec', code: 'rm -rf /' }] } })).ok).toBe(false);
  });
});

describe('every category is proved by producing its sample', () => {
  it('renders and verifies all eight samples', async () => {
    const caps = await proveCapabilities();
    for (const kind of DELIVERABLE_KINDS) expect(caps[kind].available, `${kind}: ${caps[kind].detail}`).toBe(true);
  });

  it('computes the formulas it delivers, and refuses one that errors', async () => {
    const book = renderXlsx(SAMPLES.SPREADSHEET.spec.kind === 'SPREADSHEET' ? SAMPLES.SPREADSHEET.spec.sheets : []);
    const summary = readXlsx(book.bytes).find((s) => s.name === 'Summary')!;
    // Month one: 18 000 sales, 5 760 ingredients, 10 350 fixed costs, from a 10 000 opening balance.
    expect(summary.cells.get('4,1')?.value).toBeGreaterThan(10_000);
    expect(summary.cells.get('4,1')?.formula).toBe("MIN('Cash Flow'!H2:H13)");
    const broken = clone(SAMPLES.SPREADSHEET.spec) as { sheets: { rows: unknown[][] }[] };
    broken.sheets[2]!.rows[5] = ['Margin', { f: 'B3/0' }];
    const refused = await produce(JSON.stringify({ spec: broken }));
    expect(refused.ok).toBe(false);
    expect(refused.problems.join(' ')).toMatch(/#DIV\/0!/);
    const unknown = clone(SAMPLES.SPREADSHEET.spec) as { sheets: { rows: unknown[][] }[] };
    unknown.sheets[2]!.rows[5] = ['X', { f: 'XLOOKUP(1,A1:A2,B1:B2)' }];
    expect((await produce(JSON.stringify({ spec: unknown }))).problems.join(' ')).toMatch(/does not evaluate: XLOOKUP/);
  });

  it('refuses what it cannot stand behind, naming each problem', async () => {
    const svg = clone(SAMPLES.GRAPHIC.spec) as { svg: string };
    svg.svg = svg.svg.replace('</svg>', '<script>alert(1)</script></svg>');
    expect((await produce(JSON.stringify({ spec: svg }))).problems.join(' ')).toMatch(/contains a script/);

    const site = clone(SAMPLES.WEBSITE.spec) as { files: { path: string; content: string }[] };
    site.files = site.files.filter((f) => f.path !== 'js/main.js');
    expect((await produce(JSON.stringify({ spec: site }))).problems.join(' ')).toMatch(/js\/main\.js/);

    const code = clone(SAMPLES.CODE.spec) as { files: { path: string; content: string }[] };
    code.files[0]!.content = 'def broken(:\n    pass\n';
    expect((await produce(JSON.stringify({ spec: code }))).problems.join(' ')).toMatch(/summarize\.py:1/);

    const deck = clone(SAMPLES.PRESENTATION.spec) as { slides: { bullets?: string[] }[] };
    deck.slides[1]!.bullets = Array.from({ length: 8 }, () => 'A very long bullet point that keeps going and going well past what any slide can hold at a readable size. '.repeat(2).trim());
    expect((await produce(JSON.stringify({ spec: deck }))).problems.join(' ')).toMatch(/does not fit/);

    expect(validateSubmission(JSON.stringify({ spec: SAMPLES.DATASET.spec, message: 'Email me at a@b.com' })).ok).toBe(false);
    expect(validateSubmission(JSON.stringify({ spec: { ...SAMPLES.DATASET.spec, extra: 1 } })).ok).toBe(false);
    expect((await produce(JSON.stringify({ spec: SAMPLES.DATASET.spec }), ['SPREADSHEET'])).problems.join(' ')).toMatch(/asks for SPREADSHEET/);
  });

  it('refuses an archive entry that would climb out of its folder', () => {
    expect(() => unzip(zip([{ name: '../evil', data: Buffer.from('x') }]))).toThrow();
  });
});

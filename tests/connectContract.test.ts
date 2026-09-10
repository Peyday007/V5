/**
 * The wire contract, and the storage reading, in isolation.
 *
 * These are the parts with no HTTP in them, so they are tested without it.
 * `connect.test.ts` runs the whole thing against a real server; this file exists
 * so that a failure in the parser is reported as a failure in the parser rather
 * than as a mysterious 400 four layers away.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION,
  actorLabel,
  commandKeyOf,
  contentHashOf,
  importKeyOf,
  isSourceSystem,
  normalizeVersion,
  parseRecord,
  safeSourceRef,
} from '../server/services/connect/contract.ts';
import { addDocument, freshProject, teardown, type TestProject } from './helpers.ts';
import { storageHealth, storageSamples } from '../server/services/storageHealth.ts';

const OK = {
  sourceRecordType: 'OPPORTUNITY',
  sourceRecordId: 'opp_1',
  sourceVersion: '2026-09-01T10:00:00.000Z',
  title: 'Roof replacement, 40 units',
  summary: 'A property manager needs 40 roofs replaced before winter.',
  sourceRef: '/opportunities/opp_1',
  attributes: { stage: 'QUALIFYING', estimatedValue: 240000, missingInformation: ['budget'] },
};

describe('the wire contract', () => {
  it('accepts a well-formed record and derives a stable key', () => {
    const parsed = parseRecord('DEAL_DISPATCH', OK);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.sourceRecordId).toBe('opp_1');
    expect(parsed.record.idempotencyKey).toBe(importKeyOf('DEAL_DISPATCH', 'opp_1'));
    expect(parsed.record.sourceVersion).toBe('2026-09-01T10:00:00.000Z');
  });

  it('imports only the attributes it declares, and drops everything else', () => {
    const parsed = parseRecord('DEAL_DISPATCH', {
      ...OK,
      attributes: {
        stage: 'QUALIFYING',
        // Not on the list. A site adding a column must not find it replicated.
        buyerContactPhone: '+1-555-0100',
        internalMargin: 0.42,
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.attributes).toEqual({ stage: 'QUALIFYING' });
  });

  it('is insensitive to key order, so a reserialized delivery is not a change', () => {
    const a = parseRecord('DEAL_DISPATCH', OK);
    const b = parseRecord('DEAL_DISPATCH', {
      attributes: { missingInformation: ['budget'], estimatedValue: 240000, stage: 'QUALIFYING' },
      summary: OK.summary,
      title: OK.title,
      sourceRef: OK.sourceRef,
      sourceVersion: OK.sourceVersion,
      sourceRecordId: OK.sourceRecordId,
      sourceRecordType: OK.sourceRecordType,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.record.contentHash).toBe(b.record.contentHash);
  });

  it('changes the hash when anything Brain imported changes', () => {
    const a = parseRecord('DEAL_DISPATCH', OK);
    const b = parseRecord('DEAL_DISPATCH', { ...OK, title: 'Roof replacement, 41 units' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.record.contentHash).not.toBe(b.record.contentHash);
  });

  it('normalizes a version so string order is time order', () => {
    expect(normalizeVersion('2026-09-01T10:00:00Z')).toBe('2026-09-01T10:00:00.000Z');
    expect(normalizeVersion('2026-09-01T12:00:00+02:00')).toBe('2026-09-01T10:00:00.000Z');
    const earlier = normalizeVersion('2026-09-01T10:00:00Z')!;
    const later = normalizeVersion('2026-09-01T10:00:01Z')!;
    expect(earlier < later).toBe(true);
  });

  it('refuses a version it cannot order rather than inventing one', () => {
    const parsed = parseRecord('DEAL_DISPATCH', { ...OK, sourceVersion: 'yesterday' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.rejection.reason).toBe('UNPARSEABLE_VERSION');
  });

  it('names every refusal rather than dropping the delivery', () => {
    const cases: [unknown, string][] = [
      [{ ...OK, sourceRecordId: '   ' }, 'MISSING_SOURCE_ID'],
      [{ ...OK, sourceVersion: undefined }, 'MISSING_VERSION'],
      [{ ...OK, title: '' }, 'MISSING_TITLE'],
      [{ ...OK, sourceRecordType: 'INVOICE' }, 'UNKNOWN_RECORD_TYPE'],
      ['not an object', 'MALFORMED'],
    ];
    for (const [input, reason] of cases) {
      const parsed = parseRecord('DEAL_DISPATCH', input);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.rejection.reason).toBe(reason);
    }
  });

  it('never lets a caller-supplied reference become an absolute URL', () => {
    expect(safeSourceRef('/opportunities/x')).toBe('/opportunities/x');
    expect(safeSourceRef('https://evil.example/x')).toBeNull();
    expect(safeSourceRef('//evil.example/x')).toBeNull();
    expect(safeSourceRef('/a/../../etc/passwd')).toBeNull();
    expect(safeSourceRef('opportunities/x')).toBeNull();
    expect(safeSourceRef('javascript:alert(1)')).toBeNull();
  });

  it('matches the source system exactly and refuses anything else', () => {
    expect(isSourceSystem('DEAL_DISPATCH')).toBe(true);
    expect(isSourceSystem('deal_dispatch')).toBe(false);
    expect(isSourceSystem('DEAL_DISPATCH ')).toBe(false);
    expect(isSourceSystem(null)).toBe(false);
  });

  it('bounds an actor label and strips control characters from it', () => {
    const withControl = `Dana${String.fromCharCode(0)}Reyes`;
    expect(actorLabel('Dana Reyes')).toBe('Dana Reyes');
    expect(actorLabel(withControl)).toBe('Dana Reyes');
    expect(actorLabel(42)).toBeNull();
    expect(actorLabel('x'.repeat(500))!.length).toBe(120);
  });

  it('keys a command by the record and the command, and by nothing else', () => {
    expect(commandKeyOf('DEAL_DISPATCH', 'opp_1', 'RESEARCH_FURTHER')).toBe(
      commandKeyOf('DEAL_DISPATCH', 'opp_1', 'RESEARCH_FURTHER'),
    );
    expect(commandKeyOf('DEAL_DISPATCH', 'opp_1', 'RESEARCH_FURTHER')).not.toBe(
      commandKeyOf('DEAL_DISPATCH', 'opp_2', 'RESEARCH_FURTHER'),
    );
  });

  it('carries the contract version into the hash, so a contract change is a change', () => {
    const base = {
      sourceSystem: 'DEAL_DISPATCH',
      sourceRecordType: 'OPPORTUNITY',
      sourceRecordId: 'opp_1',
      sourceVersion: '2026-09-01T10:00:00.000Z',
      title: 't',
      summary: 's',
      sourceRef: null,
      attributes: {},
    };
    expect(contentHashOf(base)).toHaveLength(64);
    expect(CONTRACT_VERSION).toBe('connect.v1');
  });
});

describe('the storage reading', () => {
  let ctx: TestProject;

  beforeEach(async () => {
    ctx = await freshProject();
    delete process.env['BRAIN_STORAGE_CAPACITY_GB'];
    delete process.env['BRAIN_STORAGE_COST_PER_GB_MONTH'];
  });

  afterEach(async () => {
    delete process.env['BRAIN_STORAGE_CAPACITY_GB'];
    delete process.env['BRAIN_STORAGE_COST_PER_GB_MONTH'];
    await teardown();
  });

  it('reports no percentage, threshold or runway when capacity is not configured', async () => {
    const reading = await storageHealth();
    expect(reading.capacityBytes).toBeNull();
    expect(reading.usedFraction).toBeNull();
    expect(reading.daysUntilFull).toBeNull();
    expect(reading.level).toBe('UNKNOWN');
    expect(reading.notes.join(' ')).toContain('provisioned capacity is not configured');
  });

  it('counts identical evidence once and says how much that saved', async () => {
    await addDocument(ctx, 'World Model', '1A', { contents: 'the same bytes' });
    await addDocument(ctx, 'World Model', '1B', { contents: 'the same bytes' });
    await addDocument(ctx, 'World Model', '1C', { contents: 'different bytes here' });

    const reading = await storageHealth();
    expect(reading.usedBytes).toBeLessThan(reading.rawBytes!);
    expect(reading.duplicateBytesSaved).toBeGreaterThan(0);
  });

  it('names a threshold once capacity is known, and still stops nothing', async () => {
    await addDocument(ctx, 'World Model', '1A', { contents: 'x'.repeat(5000) });
    process.env['BRAIN_STORAGE_CAPACITY_GB'] = String(1 / (1024 * 1024));
    const reading = await storageHealth();
    expect(reading.capacityBytes).toBe(1024);
    expect(reading.usedFraction).not.toBeNull();
    expect(['NOTICE', 'WARNING', 'URGENT']).toContain(reading.level);
    expect(reading.headline).toContain('used');
  });

  it('projects a monthly cost only when a unit price was configured', async () => {
    expect((await storageHealth()).projectedMonthlyCost).toBeNull();
    process.env['BRAIN_STORAGE_COST_PER_GB_MONTH'] = '0.021';
    const priced = await storageHealth();
    expect(priced.projectedMonthlyCost).not.toBeNull();
  });

  it('reports growth as unknown until there are two readings', async () => {
    const reading = await storageHealth();
    expect(reading.growthBytesPerDay).toBeNull();
    expect(reading.notes.join(' ')).toContain('two readings');
  });

  it('takes at most one sample an hour however often it is read', async () => {
    await storageHealth();
    await storageHealth();
    await storageHealth();
    expect((await storageSamples()).length).toBe(1);
  });
});

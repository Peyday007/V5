/**
 * Two readings that were shipping the database's work into a single-CPU
 * process (2026-10-16), and the host-metrics reader the report now carries.
 *
 * - `latestSnapshots` read a project's whole rank history (89 636 rows) to keep
 *   one per path. It now asks for exactly that row, and must keep the answer
 *   the fold gave: the newest per path, a tie broken by id.
 * - `summarizeHostMetrics` keeps only the families that say whether the host
 *   is the bottleneck, folds CPU by mode and keeps disks by device.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createNode } from '../server/repos/industry.ts';
import { latestSnapshots, recordPath, recordSnapshot } from '../server/repos/monetization.ts';
import { summarizeHostMetrics } from '../scripts/connection-report.ts';

describe('latestSnapshots returns the newest position per path, and only that', () => {
  let projectId = '';
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });

  it('keeps the newest row per path, breaks a tie by id, and reads nothing else', async () => {
    const { node } = await createNode({ projectId, parentId: null, kind: 'SECTOR', name: 'Waste test', origin: 'SEED' });
    const a = (await recordPath({ projectId, industryNodeId: node.id, method: 'DIRECT_SALE' as never, title: 'A', origin: 'SEED' })).path;
    const b = (await recordPath({ projectId, industryNodeId: node.id, method: 'REFERRAL' as never, title: 'B', origin: 'SEED' })).path;
    const snap = (pathId: string, rank: number, at: string) =>
      recordSnapshot({ projectId, pathId, rank, previousRank: null, reason: 'ENTERED_THE_LEDGER', status: 'ACTIVE' as never, criterion: null, evaluatedAt: at });

    await snap(a.id, 9, '2026-10-01T00:00:00.000Z');
    await snap(a.id, 4, '2026-10-03T00:00:00.000Z');
    await snap(a.id, 7, '2026-10-02T00:00:00.000Z');
    const t1 = await snap(b.id, 1, '2026-10-05T00:00:00.000Z');
    const t2 = await snap(b.id, 2, '2026-10-05T00:00:00.000Z');

    const latest = await latestSnapshots(projectId);
    expect(latest.size).toBe(2);
    expect(latest.get(a.id)?.rank).toBe(4);
    // Same instant: the larger id wins, as the oldest-first fold let it.
    expect(latest.get(b.id)?.id).toBe(t1.id > t2.id ? t1.id : t2.id);
    // And only one row per path came back from the database.
    const count = await getDb().get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM monetization_rank_snapshots WHERE project_id = ?',
      [projectId],
    );
    expect(Number(count?.n)).toBe(5);
  });
});

describe('the report reads the database host', () => {
  it('keeps the bottleneck families, folds CPU by mode, keeps disks by device, drops the rest', () => {
    const text = [
      '# HELP node_cpu_seconds_total x',
      'node_cpu_seconds_total{cpu="0",mode="iowait"} 10',
      'node_cpu_seconds_total{cpu="1",mode="iowait"} 5.5',
      'node_cpu_seconds_total{cpu="0",mode="steal"} 2',
      'node_disk_read_bytes_total{device="nvme0n1"} 100',
      'node_disk_read_bytes_total{device="loop0"} 999',
      'node_filesystem_avail_bytes{mountpoint="/data",fstype="ext4"} 42',
      'node_filesystem_avail_bytes{mountpoint="/boot",fstype="ext4"} 1',
      'pg_stat_database_xact_commit{datname="postgres"} 7',
      'node_load1 0.75',
    ].join('\n');
    const m = summarizeHostMetrics(text);
    expect(m.get('node_cpu_seconds_total{mode=iowait}')).toBe(15.5);
    expect(m.get('node_cpu_seconds_total{mode=steal}')).toBe(2);
    expect(m.get('node_disk_read_bytes_total{device=nvme0n1}')).toBe(100);
    expect(m.get('node_filesystem_avail_bytes{mount=/data}')).toBe(42);
    expect(m.get('node_load1')).toBe(0.75);
    expect([...m.keys()].some((k) => k.includes('loop0') || k.includes('/boot') || k.startsWith('pg_'))).toBe(false);
  });
});

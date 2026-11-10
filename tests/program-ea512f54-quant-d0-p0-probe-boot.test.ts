/**
 * COM-13-3: probe r01.com-13-3 must be registered in the released server, not
 * only in a test that imports funnel.ts itself. The program coordinator runs a
 * probe in the server's own process, and a probe nothing on the boot graph
 * registers answers UNKNOWN there ("no such probe is registered"). This walks
 * the static import graph from the server entry point — the graph production
 * loads at start — and requires the probe module on it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?from\s+)?['"](\.[^'"]+\.tsx?)['"]/gm;

function bootGraph(entry: string): Map<string, string | null> {
  const parent = new Map<string, string | null>([[entry, null]]);
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(IMPORT)) {
      const target = path.resolve(path.dirname(file), match[1]!);
      if (parent.has(target)) continue;
      parent.set(target, file);
      stack.push(target);
    }
  }
  return parent;
}

describe('probe r01.com-13-3 is registered by the released server', () => {
  it('is statically reachable from server/index.ts, with no type-only edge', () => {
    const graph = bootGraph(path.join(ROOT, 'server/index.ts'));
    const probe = path.join(ROOT, 'server/services/cash/outreachFunnelProbe.ts');
    expect(graph.has(probe), 'outreachFunnelProbe.ts is not on the server boot graph').toBe(true);
    const source = fs.readFileSync(probe, 'utf8');
    expect(source).toMatch(/registerProbe\(OUTREACH_FUNNEL_PROBE,/);
    expect(source).toMatch(/OUTREACH_FUNNEL_PROBE = 'r01\.com-13-3'/);
  });

  it('is registered once the outreach owner is loaded, without importing funnel.ts first', async () => {
    await import('../server/services/cash/outreach.ts');
    const { getProbe } = await import('../server/services/factory/program/probes.ts');
    expect(getProbe('r01.com-13-3')).not.toBeNull();
  });
});

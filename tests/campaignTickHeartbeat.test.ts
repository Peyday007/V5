import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Deploy 344, 07:54:14Z and 07:56:03Z: `Connection terminated due to connection
 * timeout` at `extendCampaignTick` reached the process as an unhandled rejection
 * twice. The heartbeat was `void extendCampaignTick(...)` inside a `setInterval`,
 * so a pool timeout had nowhere to go. A missed beat is harmless — every lease is
 * guarded — but an escaped rejection is how Node 22 exits (§18). So the class is
 * refused rather than the instance: a promise fired from a timer carries its own
 * catch, everywhere under server/.
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('a promise fired from a timer', () => {
  const sources = files('server').map((path) => ({ path, source: readFileSync(path, 'utf8') }));

  it('reads the tree it claims to guard', () => {
    expect(sources.length).toBeGreaterThan(200);
  });

  it('includes the heartbeats deploy 344 lost', () => {
    const remote = sources.find((s) => s.path.endsWith('factory/remoteLoop.ts'))!;
    expect(remote.source).toMatch(/setInterval\(\(\) => \{\s*void extendCampaignTick/);
  });

  it('always carries its own catch', () => {
    const bare: string[] = [];
    for (const { path, source } of sources) {
      for (const m of source.matchAll(/setInterval\(\(\) => \{\s*void ([^;]*);/g)) {
        if (!m[1]!.includes('.catch(')) bare.push(`${path}: void ${m[1]!.slice(0, 60)}`);
      }
    }
    expect(bare).toEqual([]);
  });
});

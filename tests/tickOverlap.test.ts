/**
 * Every background loop runs one tick at a time.
 *
 * A timer whose tick can outlive its interval starts a second tick beside the
 * first, and on a slow database that is a positive feedback loop: each tick
 * holds a pool connection, the pool fills, every tick gets slower, and more of
 * them start. The Russell loop had no guard — `claimCycle` lets the same owner
 * claim again — and production read "10/10 connection(s) in use, 3 caller(s)
 * waiting" on 2026-09-24. The dispatcher, the factory loop and the connect
 * loop already carried the guard; this holds all four to it, reading the
 * source because the property is that nothing starts, which a behavioural test
 * of one loop cannot show for the others.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOOPS = [
  'server/services/russell/loop.ts',
  'server/services/dispatch/loop.ts',
  'server/services/factory/remoteLoop.ts',
  'server/services/connect/loop.ts',
];

function timerBodies(source: string): string[] {
  const bodies: string[] = [];
  let at = source.indexOf('timer = setInterval(');
  while (at !== -1) {
    bodies.push(source.slice(at, at + 1600));
    at = source.indexOf('timer = setInterval(', at + 1);
  }
  return bodies;
}

describe('a background loop never overlaps itself', () => {
  for (const file of LOOPS) {
    it(`${file} skips a tick while the last one runs`, () => {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      const bodies = timerBodies(source);
      expect(bodies.length, `${file} starts no timer the guard could read`).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body).toMatch(/if \(running\) return;\s*running = true;/);
        expect(body).toMatch(/\.finally\(\(\) => \{\s*running = false;/);
      }
    });
  }
});

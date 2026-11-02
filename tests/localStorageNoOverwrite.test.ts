import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorageProvider } from '../server/services/storage/local.ts';
import { ObjectNotFoundError } from '../server/services/storage/types.ts';

let root: string;
let store: LocalStorageProvider;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-local-store-'));
  store = new LocalStorageProvider(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const put = (key: string, text: string, name: string, overwrite = false) =>
  store.put({ key, body: Buffer.from(text), originalFilename: name, overwrite });

describe('local storage never overwrites silently', () => {
  it('move onto an existing key refuses and touches neither object', async () => {
    await put('p/k1.txt', 'A', 'a.txt');
    await put('p/k2.txt', 'B', 'b.txt');
    await expect(store.move('p/k1.txt', 'p/k2.txt')).rejects.toThrow(/already exists/);
    expect((await store.get('p/k1.txt')).toString()).toBe('A');
    expect((await store.get('p/k2.txt')).toString()).toBe('B');
    expect((await store.head('p/k1.txt'))?.originalFilename).toBe('a.txt');
    expect((await store.head('p/k2.txt'))?.originalFilename).toBe('b.txt');
  });

  it('move to a free key, a missing key and the same key', async () => {
    const original = await put('p/k1.txt', 'A', 'a.txt');
    const moved = await store.move('p/k1.txt', 'p/k3.txt');
    expect(moved.key).toBe('p/k3.txt');
    expect(moved.checksum).toBe(original.checksum);
    expect(moved.originalFilename).toBe('a.txt');
    expect(await store.exists('p/k1.txt')).toBe(false);
    await expect(store.move('p/none.txt', 'p/k4.txt')).rejects.toBeInstanceOf(ObjectNotFoundError);
    expect((await store.move('p/k3.txt', 'p/k3.txt')).checksum).toBe(original.checksum);
  });

  it('concurrent puts without overwrite: exactly one wins', async () => {
    const results = await Promise.allSettled([put('p/race.txt', 'first', 'x'), put('p/race.txt', 'second', 'y')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    expect(bad.length).toBe(1);
    expect(String(bad[0]!.reason.message)).toMatch(/already exists/);
    const winner = results[0]!.status === 'fulfilled' ? 'first' : 'second';
    expect((await store.get('p/race.txt')).toString()).toBe(winner);
  });

  it('overwrite:true still replaces', async () => {
    await put('p/o.txt', 'one', 'o');
    await put('p/o.txt', 'two', 'o', true);
    expect((await store.get('p/o.txt')).toString()).toBe('two');
  });
});

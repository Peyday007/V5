import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { appendVersion, createDeck, currentVersion, diffCards, diffVersions, getDeck, listVersions, setCurrentVersion } from '../server/repos/magicDecks.ts';

let owner = '';
let other = '';
beforeEach(async () => {
  await freshProject();
  const mk = async (n: string) => (await createUser({ email: `${n}-${Math.random().toString(36).slice(2, 8)}@example.com`, displayName: n, password: 'a-long-enough-password' })).id;
  owner = await mk('o');
  other = await mk('x');
});

describe('deck versions', () => {
  it('appends versions, points at the newest, and undo moves only the pointer', async () => {
    const deck = await createDeck({ ownerUserId: owner, name: 'D', format: 'STANDARD' });
    const v1 = (await appendVersion(owner, deck.id, { cards: [{ zone: 'main', cardName: 'Forest', quantity: 4 }] }))!;
    const v2 = (await appendVersion(owner, deck.id, { cards: [{ zone: 'main', cardName: 'Forest', quantity: 3 }, { zone: 'main', cardName: 'Swamp', quantity: 1 }], reason: 'swap' }))!;
    expect([v1.versionNumber, v2.versionNumber]).toEqual([1, 2]);
    expect(v2.parentVersionId).toBe(v1.id);
    expect((await currentVersion(owner, deck.id))?.id).toBe(v2.id);

    expect(await setCurrentVersion(owner, deck.id, v1.id)).toBe(true);
    expect((await getDeck(owner, deck.id))?.currentVersionId).toBe(v1.id);
    expect(await listVersions(owner, deck.id)).toHaveLength(2); // nothing deleted
    expect(await setCurrentVersion(other, deck.id, v1.id)).toBe(false);
  });
  it('a new version after an undo is number 3, never a reuse', async () => {
    const deck = await createDeck({ ownerUserId: owner, name: 'D', format: 'STANDARD' });
    const v1 = (await appendVersion(owner, deck.id, { cards: [] }))!;
    await appendVersion(owner, deck.id, { cards: [] });
    await setCurrentVersion(owner, deck.id, v1.id);
    const v3 = (await appendVersion(owner, deck.id, { cards: [] }))!;
    expect(v3.versionNumber).toBe(3);
    expect(v3.parentVersionId).toBe(v1.id);
  });
  it('diffs as explicit adds, cuts and count changes', async () => {
    const deck = await createDeck({ ownerUserId: owner, name: 'D', format: 'STANDARD' });
    const v1 = (await appendVersion(owner, deck.id, { cards: [{ zone: 'main', cardName: 'A', quantity: 4 }, { zone: 'main', cardName: 'B', quantity: 1 }] }))!;
    const v2 = (await appendVersion(owner, deck.id, { cards: [{ zone: 'main', cardName: 'A', quantity: 3 }, { zone: 'main', cardName: 'C', quantity: 1 }] }))!;
    const d = (await diffVersions(owner, v1.id, v2.id))!;
    expect(d.added.map((c) => c.cardName)).toEqual(['C']);
    expect(d.removed.map((c) => c.cardName)).toEqual(['B']);
    expect(d.changed).toEqual([{ zone: 'main', cardName: 'A', from: 4, to: 3 }]);
    expect(await diffVersions(other, v1.id, v2.id)).toBeNull();
    expect(diffCards([], []).added).toEqual([]);
  });
});

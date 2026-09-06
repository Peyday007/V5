/**
 * The migration has to apply to a database that already has rows in it.
 *
 * The suite proves index creation over an empty table, because every test
 * database starts empty. Production does not: `russell_messages` there holds
 * every turn ever taken, and all of them will have NULL in both new columns.
 * A unique index that refused a second NULL pair would fail the migration on
 * the one database that matters and pass on every one that does not.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { addMessage, createConversation } from '../server/repos/russellConversations.ts';

describe('the attempt index over a populated table', () => {
  it('is creatable when every existing row has NULL in both columns', async () => {
    await freshProject();
    const user = await createUser({
      email: `pop-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Test person',
      password: 'correct horse battery staple',
    });
    const conversation = await createConversation({
      ownerUserId: user.id,
      title: 'A thread',
      projectId: null,
      visibility: 'PRIVATE',
    });
    // Many rows, every one of them (NULL, NULL) — exactly production's shape.
    for (let i = 0; i < 40; i += 1) {
      await addMessage({ conversationId: conversation.id, role: 'USER', content: `turn ${i}` });
    }

    // Drop and re-create the index, which is the operation the migration
    // performs against data that is already there.
    await getDb().run('DROP INDEX idx_russell_messages_attempt');
    await getDb().run(
      'CREATE UNIQUE INDEX idx_russell_messages_attempt ON russell_messages (answers_message_id, attempt)',
    );

    const rows = await getDb().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM russell_messages WHERE answers_message_id IS NULL`,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(40);
  });
});

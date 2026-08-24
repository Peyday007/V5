import { getDb } from '../db/database.ts';
import type {
  Conversation,
  ConversationRow,
  Message,
  MessageRole,
  MessageRow,
} from '../domain/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    projectId: row.project_id,
    layerId: row.layer_id,
    runId: row.run_id,
    title: row.title,
    providerConversationId: row.provider_conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as MessageRole,
    content: row.content,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
  };
}

export async function createConversation(input: {
  projectId: string;
  title: string;
  layerId?: string | null;
  runId?: string | null;
  providerConversationId?: string | null;
}): Promise<Conversation> {
  const ts = nowIso();
  const id = newId('cnv');
  await getDb().run(
    `INSERT INTO conversations (id, project_id, layer_id, run_id, title, provider_conversation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.layerId ?? null, input.runId ?? null, input.title,
      input.providerConversationId ?? null, ts, ts],
  );
  return (await getConversation(id))!;
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const row = await getDb().get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [id]);
  return row ? mapConversation(row) : null;
}

export async function listConversations(projectId: string): Promise<Conversation[]> {
  return (await getDb().all<ConversationRow>(
      'SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC',
      [projectId],
    ))
    .map(mapConversation);
}

/** The single always-on project chat, created on first use. */
export async function getOrCreateMainConversation(projectId: string): Promise<Conversation> {
  const row = await getDb().get<ConversationRow>(
    "SELECT * FROM conversations WHERE project_id = ? AND run_id IS NULL AND title = 'Project Chat' LIMIT 1",
    [projectId],
  );
  if (row) return mapConversation(row);
  return createConversation({ projectId, title: 'Project Chat' });
}

export async function addMessage(input: {
  conversationId: string;
  role: MessageRole;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<Message> {
  const ts = nowIso();
  const id = newId('msg');
  const db = getDb();
  await db.run(
    `INSERT INTO messages (id, conversation_id, role, content, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.conversationId, input.role, input.content, toJson(input.metadata ?? {}), ts],
  );
  await db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [ts, input.conversationId]);
  return (await db.all<MessageRow>('SELECT * FROM messages WHERE id = ?', [id])).map(mapMessage)[0]!;
}

export async function listMessages(conversationId: string, limit = 500): Promise<Message[]> {
  return (await getDb().all<MessageRow>(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid LIMIT ?',
      [conversationId, limit],
    ))
    .map(mapMessage);
}

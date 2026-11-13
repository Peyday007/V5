/**
 * How much of the history is actually here — with denominators, and with every
 * gap named.
 *
 * Three classes, never blurred:
 *
 *   1. **Recovered**: in Brain, stored exactly, provable by its hash.
 *   2. **Discovered, not recovered**: an archive declared it (a conversation in
 *      a manifest, a file a message references) and Brain does not hold it.
 *   3. **Unverifiable**: what no archive Brain has seen could declare —
 *      conversations never exported, or deleted before the export. Brain cannot
 *      count these and says so instead of claiming completeness.
 *
 * Every figure is a COUNT over rows; nothing is estimated.
 */
import { getDb } from '../../db/database.ts';

export interface CoverageReport {
  generatedAt: string;
  archives: { total: number; complete: number; receiving: number };
  conversations: {
    declared: number;
    recovered: number;
    unchanged: number;
    failed: number;
    notYetSent: number;
    fromBridge: number;
    total: number;
    failures: { externalId: string; title: string; error: string | null; attempts: number }[];
  };
  messages: { declared: number; stored: number; onReadPath: number; alternateBranches: number; supersededVersions: number; withText: number };
  branches: { conversationsWithBranches: number; branchPoints: number; alternateNodesStored: number; treeNodesDeclared: number };
  attachments: { referenced: number; recovered: number; referencedOnly: number; failed: number; byKind: Record<string, number> };
  search: { messagesWithText: number; messagesIndexed: number; passages: number; conversationsIndexed: number; conversationsPending: number };
  organization: { topics: number; subtopics: number; merged: number; retired: number; conversationsInTopics: number };
  registry: { ideas: number; byState: Record<string, number>; byKind: Record<string, number>; withEvidence: number; reconstructed: number };
  rediscovery: { open: number; queued: number; decided: number; retired: number; decisions: number };
  hubs: { total: number; byState: Record<string, number> };
  dateRange: { first: string | null; last: string | null; since2025Summer: number; before2025Summer: number };
  classes: { recovered: string; discoveredNotRecovered: string; unverifiable: string };
  gaps: string[];
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const row = await getDb().get<{ n: number | null }>(sql, params as never[]);
  return Number(row?.n ?? 0);
}

async function grouped(sql: string, params: unknown[]): Promise<Record<string, number>> {
  const rows = await getDb().all<{ k: string; n: number }>(sql, params as never[]);
  return Object.fromEntries(rows.map((r) => [r.k, Number(r.n)]));
}

export async function coverageReport(ownerId: string): Promise<CoverageReport> {
  const o = [ownerId];
  const archiveStates = await grouped('SELECT state AS k, COUNT(*) AS n FROM memory_archives WHERE owner_user_id = ? GROUP BY state', o);
  const entryStates = await grouped(
    `SELECT e.state AS k, COUNT(*) AS n FROM memory_archive_entries e JOIN memory_archives a ON a.id = e.archive_id
      WHERE a.owner_user_id = ? GROUP BY e.state`,
    o,
  );
  // A conversation declared by two archives is one conversation: distinct ids.
  const declaredDistinct = await count(
    `SELECT COUNT(DISTINCT e.external_id) AS n FROM memory_archive_entries e JOIN memory_archives a ON a.id = e.archive_id WHERE a.owner_user_id = ?`,
    o,
  );
  const notRecovered = await count(
    `SELECT COUNT(DISTINCT e.external_id) AS n FROM memory_archive_entries e JOIN memory_archives a ON a.id = e.archive_id
      WHERE a.owner_user_id = ?
        AND NOT EXISTS (SELECT 1 FROM memory_conversations c WHERE c.owner_user_id = a.owner_user_id AND c.source = 'CHATGPT' AND c.external_id = e.external_id)`,
    o,
  );
  const failures = await getDb().all<{ external_id: string; title: string; error: string | null; attempts: number }>(
    `SELECT e.external_id, e.title, e.error, e.attempts FROM memory_archive_entries e JOIN memory_archives a ON a.id = e.archive_id
      WHERE a.owner_user_id = ? AND e.state = 'FAILED' ORDER BY e.updated_at DESC LIMIT 50`,
    o,
  );
  const fromBridge = await count(`SELECT COUNT(*) AS n FROM memory_conversations WHERE owner_user_id = ? AND source = 'BRIDGE'`, o);
  const fromArchive = await count(`SELECT COUNT(*) AS n FROM memory_conversations WHERE owner_user_id = ? AND source = 'CHATGPT'`, o);
  const declaredMessages = await count(
    `SELECT SUM(m.declared) AS n FROM (SELECT MAX(e.declared_messages) AS declared FROM memory_archive_entries e
       JOIN memory_archives a ON a.id = e.archive_id WHERE a.owner_user_id = ? GROUP BY e.external_id) m`,
    o,
  );
  const declaredNodes = await count(
    `SELECT SUM(m.declared) AS n FROM (SELECT MAX(e.declared_nodes) AS declared FROM memory_archive_entries e
       JOIN memory_archives a ON a.id = e.archive_id WHERE a.owner_user_id = ? GROUP BY e.external_id) m`,
    o,
  );
  const stored = await count('SELECT COUNT(*) AS n FROM memory_messages WHERE owner_user_id = ?', o);
  const onPath = await count('SELECT COUNT(*) AS n FROM memory_messages WHERE owner_user_id = ? AND on_current_path = 1 AND superseded_in_version IS NULL', o);
  const alternate = await count('SELECT COUNT(*) AS n FROM memory_messages WHERE owner_user_id = ? AND on_current_path = 0 AND superseded_in_version IS NULL', o);
  const superseded = await count('SELECT COUNT(*) AS n FROM memory_messages WHERE owner_user_id = ? AND superseded_in_version IS NOT NULL', o);
  const withText = await count(
    `SELECT COUNT(*) AS n FROM memory_messages WHERE owner_user_id = ? AND role IN ('USER','ASSISTANT') AND hidden = 0 AND LENGTH(TRIM(text)) > 0`,
    o,
  );
  const indexedMessages = await count('SELECT COUNT(DISTINCT message_id) AS n FROM memory_passages WHERE owner_user_id = ?', o);
  const passages = await count('SELECT COUNT(*) AS n FROM memory_passages WHERE owner_user_id = ?', o);
  const convIndexed = await count('SELECT COUNT(*) AS n FROM memory_conversations WHERE owner_user_id = ? AND indexed_version = version', o);
  const convPending = await count('SELECT COUNT(*) AS n FROM memory_conversations WHERE owner_user_id = ? AND indexed_version < version', o);
  const branchConvs = await count('SELECT COUNT(*) AS n FROM memory_conversations WHERE owner_user_id = ? AND branch_point_count > 0', o);
  const branchPoints = await count('SELECT SUM(branch_point_count) AS n FROM memory_conversations WHERE owner_user_id = ?', o);
  const attachmentStates = await grouped('SELECT state AS k, COUNT(*) AS n FROM memory_attachments WHERE owner_user_id = ? GROUP BY state', o);
  const attachmentKinds = await grouped('SELECT kind AS k, COUNT(*) AS n FROM memory_attachments WHERE owner_user_id = ? GROUP BY kind', o);
  const topicStates = await grouped('SELECT state AS k, COUNT(*) AS n FROM memory_topics WHERE owner_user_id = ? GROUP BY state', o);
  const subtopics = await count(`SELECT COUNT(*) AS n FROM memory_topics WHERE owner_user_id = ? AND state = 'ACTIVE' AND parent_topic_id IS NOT NULL`, o);
  const inTopics = await count(
    `SELECT COUNT(DISTINCT m.conversation_id) AS n FROM memory_topic_members m JOIN memory_topics t ON t.id = m.topic_id WHERE t.owner_user_id = ? AND t.state = 'ACTIVE'`,
    o,
  );
  const ideaStates = await grouped('SELECT state AS k, COUNT(*) AS n FROM memory_ideas WHERE owner_user_id = ? GROUP BY state', o);
  const ideaKinds = await grouped('SELECT kind AS k, COUNT(*) AS n FROM memory_ideas WHERE owner_user_id = ? GROUP BY kind', o);
  const withEvidence = await count(
    `SELECT COUNT(DISTINCT e.idea_id) AS n FROM memory_idea_evidence e JOIN memory_ideas i ON i.id = e.idea_id WHERE i.owner_user_id = ?`,
    o,
  );
  const reconstructed = await count('SELECT COUNT(*) AS n FROM memory_ideas WHERE owner_user_id = ? AND reconstructed_at IS NOT NULL', o);
  const discoveryStates = await grouped('SELECT state AS k, COUNT(*) AS n FROM memory_discoveries WHERE owner_user_id = ? GROUP BY state', o);
  const decisions = await count('SELECT COUNT(*) AS n FROM memory_decisions WHERE owner_user_id = ?', o);
  const hubStates = await grouped('SELECT state AS k, COUNT(*) AS n FROM memory_hubs WHERE owner_user_id = ? GROUP BY state', o);
  const range = await getDb().get<{ first: string | null; last: string | null }>(
    'SELECT MIN(first_said_at) AS first, MAX(last_said_at) AS last FROM memory_conversations WHERE owner_user_id = ?',
    o,
  );
  const recent = await count(`SELECT COUNT(*) AS n FROM memory_conversations WHERE owner_user_id = ? AND last_said_at >= '2025-06-01'`, o);
  const older = await count(`SELECT COUNT(*) AS n FROM memory_conversations WHERE owner_user_id = ? AND (last_said_at < '2025-06-01' OR last_said_at IS NULL)`, o);

  const attachmentsReferenced = Object.values(attachmentStates).reduce((s, n) => s + n, 0);
  const total = fromArchive + fromBridge;
  const gaps: string[] = [];
  const archives = Object.values(archiveStates).reduce((s, n) => s + n, 0);
  if (archives === 0) {
    gaps.push(
      'No ChatGPT export has been imported. Until one is, Brain holds only conversations the bridge synced, and nothing older. ' +
        'Request an export in ChatGPT (Settings → Data controls → Export data) and import the zip on the Historical memory page.',
    );
  }
  if (notRecovered > 0) gaps.push(`${notRecovered} declared conversation(s) have not arrived — resume the import with the same file.`);
  if ((entryStates.FAILED ?? 0) > 0) gaps.push(`${entryStates.FAILED} conversation(s) failed to import; each failure is listed with its reason.`);
  if ((attachmentStates.REFERENCED_ONLY ?? 0) > 0) {
    gaps.push(`${attachmentStates.REFERENCED_ONLY} attachment(s) are referenced by messages but their bytes were not in what was imported.`);
  }
  if ((attachmentStates.FAILED ?? 0) > 0) gaps.push(`${attachmentStates.FAILED} attachment(s) could not be stored (each says why).`);
  if (convPending > 0) gaps.push(`${convPending} conversation(s) are stored but not yet indexed for search; indexing continues in the background.`);
  if (withText > indexedMessages) gaps.push(`${withText - indexedMessages} message(s) with text are not yet indexed.`);
  gaps.push(
    'Conversations that were never exported (deleted before the export, or in another account) cannot be detected from here: completeness beyond the declared archives is unverifiable.',
  );

  return {
    generatedAt: new Date().toISOString(),
    archives: { total: archives, complete: archiveStates.COMPLETE ?? 0, receiving: archiveStates.RECEIVING ?? 0 },
    conversations: {
      declared: declaredDistinct,
      recovered: fromArchive,
      unchanged: entryStates.UNCHANGED ?? 0,
      failed: entryStates.FAILED ?? 0,
      notYetSent: notRecovered,
      fromBridge,
      total,
      failures: failures.map((f) => ({ externalId: f.external_id, title: f.title, error: f.error, attempts: f.attempts })),
    },
    messages: { declared: declaredMessages, stored, onReadPath: onPath, alternateBranches: alternate, supersededVersions: superseded, withText },
    branches: {
      conversationsWithBranches: branchConvs,
      branchPoints,
      alternateNodesStored: alternate,
      treeNodesDeclared: declaredNodes,
    },
    attachments: {
      referenced: attachmentsReferenced,
      recovered: attachmentStates.RECOVERED ?? 0,
      referencedOnly: attachmentStates.REFERENCED_ONLY ?? 0,
      failed: attachmentStates.FAILED ?? 0,
      byKind: attachmentKinds,
    },
    search: { messagesWithText: withText, messagesIndexed: indexedMessages, passages, conversationsIndexed: convIndexed, conversationsPending: convPending },
    organization: {
      topics: topicStates.ACTIVE ?? 0,
      subtopics,
      merged: topicStates.MERGED ?? 0,
      retired: topicStates.RETIRED ?? 0,
      conversationsInTopics: inTopics,
    },
    registry: {
      ideas: Object.values(ideaStates).reduce((s, n) => s + n, 0),
      byState: ideaStates,
      byKind: ideaKinds,
      withEvidence,
      reconstructed,
    },
    rediscovery: { open: discoveryStates.OPEN ?? 0, queued: discoveryStates.QUEUED ?? 0, decided: discoveryStates.DECIDED ?? 0, retired: discoveryStates.RETIRED ?? 0, decisions },
    hubs: { total: Object.values(hubStates).reduce((s, n) => s + n, 0), byState: hubStates },
    dateRange: { first: range?.first ?? null, last: range?.last ?? null, since2025Summer: recent, before2025Summer: older },
    classes: {
      recovered: `${total} conversation(s) and ${stored} message node(s) are held exactly, each with its content hash.`,
      discoveredNotRecovered: `${notRecovered} declared conversation(s) and ${(attachmentStates.REFERENCED_ONLY ?? 0) + (attachmentStates.FAILED ?? 0)} referenced attachment(s) are known to exist and are not held.`,
      unverifiable: 'Anything no imported archive declared. Brain makes no claim about it.',
    },
    gaps,
  };
}

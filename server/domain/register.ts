/**
 * The work register's vocabulary, and the conversation entrance's.
 *
 * Two closed sets do the load-bearing work here and both are closed for the
 * same reason this codebase keeps giving: a value nobody declared is a value
 * some reader will interpret, and a reader interpreting is a reader guessing.
 *
 *   * `WorkstreamPurpose` answers the owner's first question — *what is
 *     pursuing money?* — and is **stored**, because intent is the one thing no
 *     amount of reading the graph recovers.
 *   * `WorkstreamState` answers *where has it got to?* and is **derived**, on
 *     every read, from the rows a workstream points at. There is no column for
 *     it anywhere, which is deliberate: §29 records what a stored verdict costs
 *     when the thing it waited on arrives, and §38 refuses to store a tier for
 *     the identical reason.
 *
 * `UNKNOWN` is a member of the state set on purpose. A workstream that points
 * at nothing has not failed and is not proposed — nobody has said. §30 draws
 * that line at a capability and §37 at a self-model reading, and it is the same
 * line: *we could not tell* must never read the same as *we checked*.
 */

// ---------------------------------------------------------------------------
// THE REGISTER
// ---------------------------------------------------------------------------

/**
 * Why this work is being done.
 *
 * Four values and no fifth, in the order the owner asked for them. The
 * distinction that matters most is the first two: `REVENUE_DIRECT` is work
 * whose success is money arriving, and `REVENUE_ENABLING` is work that removes
 * something standing in its way. Collapsing them would make "what is pursuing
 * money" answer with the whole backlog.
 */
export const WORKSTREAM_PURPOSES = [
  'REVENUE_DIRECT',
  'REVENUE_ENABLING',
  'CAPABILITY',
  'LONG_TERM',
] as const;
export type WorkstreamPurpose = (typeof WORKSTREAM_PURPOSES)[number];

export const PURPOSE_LABELS: Record<WorkstreamPurpose, string> = {
  REVENUE_DIRECT: 'Pursuing money directly',
  REVENUE_ENABLING: 'Clearing the way for money',
  CAPABILITY: 'Building a general capability',
  LONG_TERM: 'Serving a longer-term goal',
};

/**
 * Where a workstream has got to.
 *
 * The six the owner named, plus the three a register has to be able to say:
 * `BLOCKED`, `DONE` and `UNKNOWN`. Ordered from least to most advanced, which
 * is what lets a derivation take the furthest thing any linked row can support
 * rather than the first branch that matched.
 */
export const WORKSTREAM_STATES = [
  'UNKNOWN',
  'PROPOSED',
  'IN_PROGRESS',
  'PR_READY',
  'MERGED',
  'DEPLOYED',
  'VERIFIED_LIVE',
  'DONE',
  'BLOCKED',
] as const;
export type WorkstreamState = (typeof WORKSTREAM_STATES)[number];

/**
 * How far along each state is, for choosing between two supported readings.
 *
 * `BLOCKED` is deliberately outside the ladder: it is not *further* than
 * `IN_PROGRESS`, it is a different statement about the same work, and it wins
 * over everything below `MERGED` because a person needs to know work has
 * stopped more than they need to know it started.
 */
export const STATE_RANK: Record<WorkstreamState, number> = {
  UNKNOWN: 0,
  PROPOSED: 1,
  IN_PROGRESS: 2,
  PR_READY: 3,
  MERGED: 4,
  DEPLOYED: 5,
  VERIFIED_LIVE: 6,
  DONE: 7,
  BLOCKED: -1,
};

/** What kind of row a link points at. */
export const LINK_KINDS = [
  'CONVERSATION',
  'BRIDGE_CONVERSATION',
  'PASSAGE',
  'CANDIDATE',
  'MISSION',
  'PACKET',
  'DOCUMENT',
  'AUDIT',
  'CHANGE_REQUEST',
  'CAMPAIGN',
  'BRANCH',
  'PULL_REQUEST',
  'DEPLOY',
  'FACULTY',
  'INDUSTRY_NODE',
  'OPPORTUNITY',
  'HUMAN_REQUEST',
  'WORKSTREAM',
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/**
 * How the piece relates to the workstream.
 *
 * `SOURCE` is where it came from, `PURSUES` is what is being done about it,
 * `EVIDENCE` is what says something happened. The difference is not cosmetic:
 * a derivation reads `PURSUES` and `EVIDENCE` to decide a state and must never
 * read `SOURCE`, because a conversation describing a shipped feature is not the
 * feature shipping.
 */
export const LINK_RELATIONS = ['SOURCE', 'PURSUES', 'EVIDENCE', 'DEPENDS_ON', 'SUPERSEDES'] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

export interface WorkstreamRow {
  id: string;
  project_id: string | null;
  title: string;
  intent: string;
  purpose: string;
  archived_at: string | null;
  archived_reason: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Workstream {
  id: string;
  projectId: string | null;
  title: string;
  intent: string;
  purpose: WorkstreamPurpose;
  archivedAt: string | null;
  archivedReason: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkstreamLinkRow {
  id: string;
  workstream_id: string;
  kind: string;
  ref: string;
  label: string | null;
  relation: string;
  detail: string;
  recorded_by: string;
  recorded_by_user_id: string | null;
  superseded_at: string | null;
  superseded_reason: string | null;
  created_at: string;
}

export interface WorkstreamLink {
  id: string;
  workstreamId: string;
  kind: LinkKind;
  ref: string;
  label: string | null;
  relation: LinkRelation;
  detail: Record<string, unknown>;
  recordedBy: 'BRAIN' | 'PERSON';
  recordedByUserId: string | null;
  supersededAt: string | null;
  supersededReason: string | null;
  createdAt: string;
}

export interface WorkstreamEventRow {
  id: string;
  workstream_id: string;
  kind: string;
  summary: string;
  detail: string;
  actor_ref: string;
  created_at: string;
}

export interface WorkstreamEvent {
  id: string;
  workstreamId: string;
  kind: string;
  summary: string;
  detail: Record<string, unknown>;
  actorRef: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// THE CONVERSATION ENTRANCE
// ---------------------------------------------------------------------------

/**
 * Where a transcript came from.
 *
 * `IMPORT` is its own value rather than a flag on the others, because a pasted
 * export and a live synchronization are different facts about completeness: a
 * live client knows its own conversation is still going, and an import is
 * whatever somebody had at the moment they copied it.
 */
export const BRIDGE_SOURCES = ['CHATGPT', 'CLAUDE', 'OTHER', 'IMPORT'] as const;
export type BridgeSource = (typeof BRIDGE_SOURCES)[number];

/**
 * The transcript's own role vocabulary, which is not Russell's.
 *
 * `russell_messages` may say USER, RUSSELL or SYSTEM. Writing another model's
 * turn as RUSSELL would attribute words to Russell that Russell did not say, so
 * a transcript keeps its own roles here and only the person's own turns are
 * ever projected into a Russell thread.
 */
export const BRIDGE_ROLES = ['USER', 'ASSISTANT', 'SYSTEM', 'TOOL', 'UNKNOWN'] as const;
export type BridgeRole = (typeof BRIDGE_ROLES)[number];

export interface BridgeCredentialRow {
  id: string;
  user_id: string;
  label: string;
  prefix: string;
  verifier: string;
  issued_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  last_used_at: string | null;
}

export interface BridgeCredential {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  issuedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  lastUsedAt: string | null;
}

export interface BridgeConversationRow {
  id: string;
  owner_user_id: string;
  source: string;
  external_id: string;
  title: string;
  russell_conversation_id: string;
  highest_ordinal: number;
  message_count: number;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BridgeConversation {
  id: string;
  ownerUserId: string;
  source: BridgeSource;
  externalId: string;
  title: string;
  russellConversationId: string;
  highestOrdinal: number;
  messageCount: number;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BridgeMessageRow {
  id: string;
  conversation_id: string;
  ordinal: number;
  revision: number;
  external_id: string | null;
  role: string;
  author_label: string | null;
  content: string;
  content_hash: string;
  said_at: string | null;
  received_at: string;
  superseded_at: string | null;
  branch_note: string | null;
}

export interface BridgeMessage {
  id: string;
  conversationId: string;
  ordinal: number;
  revision: number;
  externalId: string | null;
  role: BridgeRole;
  authorLabel: string | null;
  content: string;
  contentHash: string;
  saidAt: string | null;
  receivedAt: string;
  supersededAt: string | null;
  branchNote: string | null;
}

export interface BridgeReceiptRow {
  id: string;
  conversation_id: string;
  request_key: string;
  accepted: number;
  duplicates: number;
  revisions: number;
  branches: number;
  first_ordinal: number | null;
  last_ordinal: number | null;
  missing: string;
  routing: string;
  created_at: string;
  completed_at: string | null;
}

/**
 * What one synchronization did.
 *
 * `missing` is the half a client cannot work out for itself and the half that
 * decides whether anything downstream is trustworthy: a transcript with a hole
 * in it can be read as saying the opposite of what it said, so the receipt
 * names every position this Brain has never been given rather than reporting
 * only what arrived.
 */
export interface BridgeReceipt {
  id: string;
  conversationId: string;
  requestKey: string;
  accepted: number;
  duplicates: number;
  revisions: number;
  branches: number;
  firstOrdinal: number | null;
  lastOrdinal: number | null;
  missing: number[];
  routing: BridgeRouting;
  createdAt: string;
  /**
   * When the delivery this receipt reserved actually finished.
   *
   * `null` is a real state and means *not finished*. The reservation is taken
   * before the messages are written — that is what makes two simultaneous
   * deliveries produce one — and the two are not one transaction, so a process
   * that died between them leaves this null over a partly-written transcript.
   * A retry then carries on rather than replaying, which is safe because every
   * message write is idempotent by position and content hash.
   */
  completedAt: string | null;
}

/**
 * What Brain did with the transcript once it was stored.
 *
 * Deterministic storage cannot understand an arbitrary conversation, so this
 * never claims to. What it records is which of the existing paths the content
 * was handed to — a Russell turn the fleet will answer, a captured idea, a
 * software request — or, when none applied, the reason in words. `NOTHING` with
 * a sentence is an answer; a silent sync is not.
 */
export interface BridgeRouting {
  /**
   * Four outcomes, and the distinction between the first two is the one that
   * would otherwise be a lie.
   *
   *   * `TURN_OPENED` — a bin exists and a worker will answer it. The reply is
   *     not here yet and the client should come back for it.
   *   * `ANSWERED` — Russell settled it in the same request, which is what
   *     happens when it cannot tell which project a thread is about and asks.
   *     Reporting that as `TURN_OPENED` would have a client waiting for a
   *     worker that was never sent for — §24's reassuring pending state, at a
   *     receipt.
   *   * `NOTHING` — nothing was handed over, with the reason.
   *   * `REFUSED` — Russell declined, in its own words.
   */
  outcome: 'TURN_OPENED' | 'ANSWERED' | 'NOTHING' | 'REFUSED';
  /** The Russell message carrying the answer, or waiting to. */
  messageId?: string;
  /** The bin a worker will take. Present only for `TURN_OPENED`. */
  binId?: string | null;
  /** The project Brain resolved the thread to, if any. */
  projectId?: string | null;
  /** Always present. Why this outcome, in words a person can act on. */
  reason: string;
}

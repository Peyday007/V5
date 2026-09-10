/**
 * The wire contract between a connected site and this Brain — frozen, small,
 * and validated with nothing trusted.
 *
 * ---------------------------------------------------------------------------
 * What crosses, and what deliberately does not
 * ---------------------------------------------------------------------------
 *
 * Deal Dispatch is the master of its own operational fields: its pipeline
 * stages, its contacts, its call history, its margins. None of that is imported
 * here and none of it should be, because two uncontrolled masters for one field
 * is the failure this whole design exists to avoid. What crosses is the part
 * Brain can *reason* about — what this record is, what state the site says it
 * is in, what the site thinks it is worth and what it says is blocking it — and
 * that is enough for Brain to decide whether it is worth researching.
 *
 * Brain becomes authoritative for what it derives: the priority, the reason,
 * the research and its verdict. The site stays authoritative for everything it
 * was already authoritative for.
 *
 * ---------------------------------------------------------------------------
 * Everything below is zero-trust
 * ---------------------------------------------------------------------------
 *
 * §8's rule, applied at a new boundary. Enums are matched exactly, an unknown
 * source system or record type refuses the delivery, sizes are bounded before
 * anything is stored, and a `sourceRef` is checked to be a site-relative path
 * rather than accepted as a URL — a caller-supplied absolute reference is how a
 * projection becomes an open redirector on the site that renders it.
 *
 * A refusal names a category and Brain's own sentence about the *shape* of the
 * delivery. It never echoes the delivery, because a rejection ledger that
 * quoted its input would be a place a site's content ends up by accident.
 */
import { createHash } from 'node:crypto';
import {
  EXTERNAL_RECORD_TYPES,
  EXTERNAL_SOURCE_SYSTEMS,
  type ExternalRecordType,
  type ExternalRejectionReason,
  type ExternalSourceSystem,
} from '../../domain/types.ts';

/** The version of the contract itself, carried in every provenance record. */
export const CONTRACT_VERSION = 'connect.v1';

/** Bounds, applied before anything is stored. */
export const MAX_RECORDS_PER_BATCH = 200;
const MAX_TITLE = 300;
const MAX_SUMMARY = 2_000;
const MAX_REF = 300;
const MAX_ATTRIBUTE_KEYS = 24;
const MAX_ATTRIBUTE_TEXT = 400;
const MAX_ATTRIBUTE_LIST = 12;

/** Never let these into a stored string, an id or a path. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;

/**
 * The attributes Brain imports, and no others.
 *
 * An allow-list rather than "everything except": a site that adds a column
 * should not find it silently replicated into Brain, and the rule that Brain
 * imports only what it needs to identify, reason about, prioritize and project
 * back is enforced here rather than trusted to the caller.
 */
export const IMPORTED_ATTRIBUTES = [
  'type',
  'stage',
  'status',
  'priority',
  'state',
  'location',
  'estimatedValue',
  'expectedValue',
  'closingProbability',
  'primaryBlocker',
  'missingInformation',
  'lane',
  'counterparty',
] as const;

export interface AcceptedRecord {
  sourceSystem: ExternalSourceSystem;
  sourceRecordType: ExternalRecordType;
  sourceRecordId: string;
  /** Normalized to `new Date(...).toISOString()`, so string order is time order. */
  sourceVersion: string;
  sourceCreatedAt: string | null;
  sourceRef: string | null;
  title: string;
  summary: string;
  attributes: Record<string, unknown>;
  contentHash: string;
  idempotencyKey: string;
}

export interface RejectedRecord {
  sourceRecordId: string | null;
  reason: ExternalRejectionReason;
  detail: string;
}

export type ParseResult =
  | { ok: true; record: AcceptedRecord }
  | { ok: false; rejection: RejectedRecord };

function clean(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(CONTROL_CHARACTERS, ' ').trim();
  if (!text) return null;
  return text.slice(0, limit);
}

/**
 * A reference the site can resolve and nothing else can abuse.
 *
 * Site-relative, single leading slash, no scheme, no authority, no `..`. A
 * value that is not that is dropped rather than repaired: a reference Brain
 * "fixed" would be one nobody wrote and nobody can check.
 */
export function safeSourceRef(value: unknown): string | null {
  const text = clean(value, MAX_REF);
  if (!text) return null;
  if (!text.startsWith('/')) return null;
  if (text.startsWith('//')) return null;
  if (text.includes('..')) return null;
  if (/[:\\]/.test(text)) return null;
  return text;
}

/**
 * An ISO-8601 instant, normalized.
 *
 * Normalization is load-bearing rather than cosmetic: the staleness guard is a
 * string comparison in SQL, so two spellings of the same instant would compare
 * as different versions and one of them would always lose. Every version that
 * reaches the database has been through here.
 */
export function normalizeVersion(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = new Date(value);
  const ms = parsed.getTime();
  if (!Number.isFinite(ms)) return null;
  return parsed.toISOString();
}

function attributesOf(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const key of IMPORTED_ATTRIBUTES) {
    if (keys >= MAX_ATTRIBUTE_KEYS) break;
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'string') {
      const text = clean(value, MAX_ATTRIBUTE_TEXT);
      if (!text) continue;
      out[key] = text;
    } else if (Array.isArray(value)) {
      const list = value
        .map((entry) => clean(entry, MAX_ATTRIBUTE_TEXT))
        .filter((entry): entry is string => entry !== null)
        .slice(0, MAX_ATTRIBUTE_LIST);
      if (list.length === 0) continue;
      out[key] = list;
    } else {
      continue;
    }
    keys += 1;
  }
  return out;
}

/**
 * A stable digest of exactly what Brain imported.
 *
 * Keys are sorted, so two deliveries that differ only in JSON key order are one
 * import. Nothing about the request contributes — no timestamp, no request id,
 * no credential — because a hash that moved between attempts would make every
 * redelivery look like a change (§20's rule about fingerprints, at this
 * boundary).
 */
export function contentHashOf(record: {
  sourceSystem: string;
  sourceRecordType: string;
  sourceRecordId: string;
  sourceVersion: string;
  title: string;
  summary: string;
  sourceRef: string | null;
  attributes: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify([
    CONTRACT_VERSION,
    record.sourceSystem,
    record.sourceRecordType,
    record.sourceRecordId,
    record.sourceVersion,
    record.title,
    record.summary,
    record.sourceRef,
    Object.keys(record.attributes)
      .sort()
      .map((key) => [key, record.attributes[key]]),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The stable logical key for one record's import.
 *
 * Derived from the record's identity alone. It does not carry the version, so a
 * retried delivery of an update is the same logical operation as the first
 * attempt at it — which is exactly what §20 requires of an effect key.
 */
export function importKeyOf(sourceSystem: string, sourceRecordId: string): string {
  return `connect:${sourceSystem}:${sourceRecordId}`;
}

/**
 * The key for a person's command, stable across every retry of that command.
 *
 * Hashed rather than spelled out, and with a prefix, for the same two reasons
 * `logicalEffectKey` is: the effect engine's key charset is deliberately narrow
 * (a site's record id is not, and a colon is not in it), and a key derived by
 * digest cannot accidentally carry a record's own identifiers into a table that
 * only ever wanted a stable token. Nothing about the request contributes — no
 * clock, no attempt, no credential — so the second delivery of one click
 * produces the same key as the first.
 */
export function commandKeyOf(
  sourceSystem: string,
  sourceRecordId: string,
  command: string,
): string {
  const canonical = JSON.stringify(['connect.command.v1', sourceSystem, sourceRecordId, command]);
  return `cn-${createHash('sha256').update(canonical).digest('hex').slice(0, 48)}`;
}

export function isSourceSystem(value: unknown): value is ExternalSourceSystem {
  return (
    typeof value === 'string' &&
    (EXTERNAL_SOURCE_SYSTEMS as readonly string[]).includes(value)
  );
}

/**
 * Read one delivery, or refuse it with a reason.
 *
 * Refusing is an outcome rather than an exception: one unmappable record in a
 * batch of two hundred must not throw away the other hundred and ninety-nine,
 * and the caller reports every refusal individually.
 */
export function parseRecord(
  sourceSystem: ExternalSourceSystem,
  raw: unknown,
): ParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      rejection: { sourceRecordId: null, reason: 'MALFORMED', detail: 'the entry is not an object' },
    };
  }
  const body = raw as Record<string, unknown>;

  const sourceRecordId = clean(body['sourceRecordId'], 128);
  if (!sourceRecordId) {
    return {
      ok: false,
      rejection: {
        sourceRecordId: null,
        reason: 'MISSING_SOURCE_ID',
        detail: 'the entry carries no source record id',
      },
    };
  }

  const typeValue = typeof body['sourceRecordType'] === 'string' ? body['sourceRecordType'] : '';
  if (!(EXTERNAL_RECORD_TYPES as readonly string[]).includes(typeValue)) {
    return {
      ok: false,
      rejection: {
        sourceRecordId,
        reason: 'UNKNOWN_RECORD_TYPE',
        detail: 'this Brain does not know that kind of record',
      },
    };
  }
  const sourceRecordType = typeValue as ExternalRecordType;

  if (body['sourceVersion'] === undefined || body['sourceVersion'] === null) {
    return {
      ok: false,
      rejection: {
        sourceRecordId,
        reason: 'MISSING_VERSION',
        detail: 'the entry carries no source version, so nothing can order it',
      },
    };
  }
  const sourceVersion = normalizeVersion(body['sourceVersion']);
  if (!sourceVersion) {
    return {
      ok: false,
      rejection: {
        sourceRecordId,
        reason: 'UNPARSEABLE_VERSION',
        detail: 'the source version is not an instant this Brain can order',
      },
    };
  }

  const title = clean(body['title'], MAX_TITLE);
  if (!title) {
    return {
      ok: false,
      rejection: {
        sourceRecordId,
        reason: 'MISSING_TITLE',
        detail: 'the entry has nothing a person could recognise it by',
      },
    };
  }

  const summary = clean(body['summary'], MAX_SUMMARY) ?? title;
  const sourceRef = safeSourceRef(body['sourceRef']);
  const sourceCreatedAt = normalizeVersion(body['sourceCreatedAt']);
  const attributes = attributesOf(body['attributes']);

  const contentHash = contentHashOf({
    sourceSystem,
    sourceRecordType,
    sourceRecordId,
    sourceVersion,
    title,
    summary,
    sourceRef,
    attributes,
  });

  return {
    ok: true,
    record: {
      sourceSystem,
      sourceRecordType,
      sourceRecordId,
      sourceVersion,
      sourceCreatedAt,
      sourceRef,
      title,
      summary,
      attributes,
      contentHash,
      idempotencyKey: importKeyOf(sourceSystem, sourceRecordId),
    },
  };
}

/**
 * The label the site's actor is recorded under.
 *
 * Attribution, never authorization: it is stored so that "who asked for this"
 * is answerable, and it is read by nothing that takes a decision. Bounded and
 * stripped, because it is a string a remote system chose.
 */
export function actorLabel(value: unknown): string | null {
  return clean(value, 120);
}

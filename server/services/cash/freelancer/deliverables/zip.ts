/**
 * The ZIP container every Office file, website bundle and code bundle is.
 *
 * Small on purpose: Brain writes archives it composed itself and reads back
 * archives it wrote (or a client's .xlsx/.docx/.pptx). Deflate comes from
 * Node's zlib, so no dependency is added to the production image.
 *
 * The reader refuses what it cannot read safely: encryption, ZIP64, a path
 * that is absolute or climbs, and an entry that would inflate past the bound.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const MAX_ENTRIES = 2000;
/** Bound on what one archive may inflate to, so a zip bomb is refused rather than read. */
export const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;

function dosTime(): { time: number; date: number } {
  // A fixed instant: the same entries always produce the same bytes.
  return { time: 0, date: (2026 - 1980) << 9 | (1 << 5) | 1 };
}

export function safeEntryName(name: string): boolean {
  if (!name || name.length > 400) return false;
  if (name.startsWith('/') || name.includes('\\') || /^[a-z]:/i.test(name)) return false;
  return !name.split('/').some((part) => part === '..' || part === '.');
}

export function zip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const { time, date } = dosTime();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!safeEntryName(entry.name)) throw new Error(`Unsafe archive entry name: ${entry.name}`);
    if (seen.has(entry.name)) throw new Error(`Duplicate archive entry: ${entry.name}`);
    seen.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const useDeflate = compressed.length < entry.data.length;
    const body = useDeflate ? compressed : entry.data;
    const crc = crc32(entry.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

/** Read every entry. Throws ZipError for anything this reader will not trust. */
export function unzip(archive: Buffer): Map<string, Buffer> {
  let endAt = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 22 - 65535); i -= 1) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      endAt = i;
      break;
    }
  }
  if (endAt < 0) throw new ZipError('Not a ZIP archive: no end-of-directory record.');
  const count = archive.readUInt16LE(endAt + 10);
  const centralAt = archive.readUInt32LE(endAt + 16);
  if (count === 0xffff || centralAt === 0xffffffff) throw new ZipError('ZIP64 archives are not read.');
  if (count > MAX_ENTRIES) throw new ZipError(`Archive has ${count} entries, more than ${MAX_ENTRIES}.`);
  const out = new Map<string, Buffer>();
  let at = centralAt;
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > archive.length || archive.readUInt32LE(at) !== 0x02014b50) throw new ZipError('Corrupt central directory.');
    const flags = archive.readUInt16LE(at + 8);
    const expectedCrc = archive.readUInt32LE(at + 16);
    const method = archive.readUInt16LE(at + 10);
    const compressedSize = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const localAt = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new ZipError(`Entry ${name} is encrypted.`);
    if (name.endsWith('/')) continue;
    if (!safeEntryName(name)) throw new ZipError(`Entry name ${name} is unsafe.`);
    total += size;
    if (total > MAX_UNZIPPED_BYTES) throw new ZipError('Archive inflates past the size bound.');
    if (archive.readUInt32LE(localAt) !== 0x04034b50) throw new ZipError(`Entry ${name} has no local header.`);
    const dataAt = localAt + 30 + archive.readUInt16LE(localAt + 26) + archive.readUInt16LE(localAt + 28);
    const body = archive.subarray(dataAt, dataAt + compressedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = inflateRawSync(body, { maxOutputLength: Math.max(size, 1) + 1024 });
    else throw new ZipError(`Entry ${name} uses compression method ${method}.`);
    if (data.length !== size) throw new ZipError(`Entry ${name} inflated to the wrong size.`);
    if ((crc32(data) >>> 0) !== expectedCrc) {
      throw new ZipError(`Entry ${name} failed its checksum.`);
    }
    out.set(name, data);
  }
  return out;
}

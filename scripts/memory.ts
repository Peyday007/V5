/**
 * `npm run memory -- import <export.zip | folder | file.json…> --url https://brain --key brnc_…`
 *
 * Sends a ChatGPT export to a Brain from a terminal — the path for an archive
 * too large to read comfortably in a browser tab. The same reader and the same
 * batches as the Historical memory page (`server/services/memory/upload.ts`),
 * so it resumes the same way: run it again with the same export and only what
 * Brain does not already hold is sent.
 *
 * The key is the person's own bridge credential (minted in a signed-in browser,
 * `POST /api/bridge/credentials`), read from `--key` or `BRAIN_BRIDGE_KEY`. It
 * is sent only as a bearer header to the Brain named by `--url`, and is never
 * printed. Conversation text is never printed either: progress is counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { uploadArchive, type ArchiveEntrySource } from '../server/services/memory/upload.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

function positional(): string[] {
  const argv = process.argv.slice(2);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i]!.startsWith('--')) {
      i += 1;
      continue;
    }
    out.push(argv[i]!);
  }
  return out;
}

function walk(dir: string, base = dir): ArchiveEntrySource[] {
  const out: ArchiveEntrySource[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(fileEntry(full, path.relative(base, full).split(path.sep).join('/')));
  }
  return out;
}

function fileEntry(full: string, name: string): ArchiveEntrySource {
  return {
    name,
    size: fs.statSync(full).size,
    text: async () => fs.readFileSync(full, 'utf8'),
    base64: async () => fs.readFileSync(full).toString('base64'),
  };
}

async function entriesOf(target: string): Promise<ArchiveEntrySource[]> {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) return walk(target);
  if (/\.zip$/i.test(target)) {
    const zip = await JSZip.loadAsync(fs.readFileSync(target));
    const out: ArchiveEntrySource[] = [];
    zip.forEach((name, entry) => {
      if (entry.dir) return;
      out.push({
        name,
        size: (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? null,
        text: () => entry.async('string'),
        base64: () => entry.async('base64'),
      });
    });
    return out;
  }
  return [fileEntry(target, path.basename(target))];
}

async function main(): Promise<void> {
  const [command, ...targets] = positional();
  if (command !== 'import' || targets.length === 0) {
    console.error('Usage: npm run memory -- import <export.zip | folder | file.json…> --url https://your-brain [--key brnc_…]');
    process.exit(2);
  }
  const url = (flag('url') ?? process.env.BRAIN_URL ?? '').replace(/\/+$/, '');
  const key = flag('key') ?? process.env.BRAIN_BRIDGE_KEY ?? '';
  if (!url) throw new Error('Name the Brain with --url (or BRAIN_URL).');
  if (!key.startsWith('brnc_')) throw new Error('Give your bridge credential with --key brnc_… (or BRAIN_BRIDGE_KEY).');

  const entries: ArchiveEntrySource[] = [];
  for (const target of targets) entries.push(...(await entriesOf(target)));

  const post = async <T>(route: string, body: unknown): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(`${url}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      }).catch((error: unknown) => ({ ok: false, status: 0, text: async () => String(error) }) as Response);
      if (response.ok) return (await response.json()) as T;
      // A transient refusal is retried; the server's writes are idempotent by content.
      if ((response.status === 0 || response.status >= 500 || response.status === 429) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
        continue;
      }
      throw new Error(`${route} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
  };

  let last = '';
  const summary = await uploadArchive({
    label: targets.map((t) => path.basename(t)).join(', '),
    entries,
    post,
    progress: (p) => {
      const line = `${p.phase.toLowerCase()} ${p.done}/${p.total}`;
      if (line !== last) process.stdout.write(`\r  ${line}          `);
      last = line;
    },
  });
  process.stdout.write('\n');
  console.log(`  archive         ${summary.archiveId}`);
  console.log(`  conversations   ${summary.declared} found, ${summary.sent} sent, ${summary.alreadyHeld} already held, ${summary.failed.length} failed`);
  console.log(`  files           ${summary.filesSent} sent, ${summary.filesMissing} referenced but absent, ${summary.filesTooLarge} too large`);
  if (summary.unreadable.length) console.log(`  unreadable      ${summary.unreadable.length} file(s) — see the coverage report`);
  for (const f of summary.failed.slice(0, 20)) console.log(`  failed          ${f.externalId}: ${f.error}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

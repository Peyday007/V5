/**
 * The terminal where a person reads what the acquisition judgment needs from
 * them, and what source discovery found (F-JUDGMENT-NO-CONSUMER).
 *
 *   npx tsx server/services/sources/acquisitionCli.ts handoffs
 *   npx tsx server/services/sources/acquisitionCli.ts discovery --host data.example
 *
 * Invariant 35: a person's part has no administration page; it is a terminal,
 * and reaching the shell is the authentication. `handoffs` lists every open
 * `ACCESS_HANDOFF` — a stop at a genuine access boundary, naming the permitted
 * route to seek and the exact next step — until a later judgment for the host
 * routes without one or a person grants the operate permission. Nothing here
 * writes; nothing here prints a credential.
 */
import { closeDatabase, initDatabase } from '../../db/database.ts';
import { readDiscoveryOnRecord, readOpenHandoffs, type OpenHandoff, type SourceDiscovery } from './acquisition.ts';

export interface AcquisitionCliDeps {
  handoffs?: () => Promise<OpenHandoff[]>;
  discovery?: (host: string) => Promise<SourceDiscovery | null>;
}

const USAGE = 'usage: acquisitionCli.ts handoffs\n       acquisitionCli.ts discovery --host H';

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  const value = at < 0 ? undefined : argv[at + 1];
  return value && !value.startsWith('--') ? value : null;
}

export function describeHandoff(h: OpenHandoff): string {
  return `${h.openedAt}  ${h.capability} ${h.host} — stopped at ${h.boundary}\n    seek: ${h.seek}\n    next: ${h.nextStep}${h.purpose ? `\n    for:  ${h.purpose}` : ''}`;
}

export async function runAcquisitionCommand(argv: readonly string[], deps: AcquisitionCliDeps = {}): Promise<{ code: number; out: string }> {
  const [command] = argv;
  if (command === 'handoffs') {
    const open = await (deps.handoffs ?? readOpenHandoffs)();
    if (open.length === 0) return { code: 0, out: 'No open access handoffs: nothing is waiting on a person.' };
    return { code: 0, out: [`${open.length} open access handoff(s):`, ...open.map(describeHandoff)].join('\n') };
  }
  if (command === 'discovery') {
    const host = flag(argv, 'host')?.trim().toLowerCase();
    if (!host) return { code: 2, out: USAGE };
    const d = await (deps.discovery ?? readDiscoveryOnRecord)(host);
    if (!d) return { code: 0, out: `${host}: no source discovery on record in the window.` };
    return {
      code: 0,
      out: [`${host}: searched "${d.query}"`, `  existing corpora/exports/catalogs: ${d.bulkCandidates.length ? d.bulkCandidates.join(' ') : 'none found'}`, `  pages returned: ${d.candidates.length}`].join('\n'),
    };
  }
  return { code: 2, out: USAGE };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  await initDatabase();
  try {
    const { code, out } = await runAcquisitionCommand(process.argv.slice(2));
    (code === 0 ? console.log : console.error)(out);
    process.exitCode = code;
  } finally {
    await closeDatabase();
  }
}

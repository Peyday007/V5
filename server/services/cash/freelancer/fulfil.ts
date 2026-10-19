/**
 * Doing the work on a won Freelancer job that is not a research report.
 *
 * The route is the one Brain already has for "work a machine with a
 * capability Brain lacks does, returned as structured rows and validated
 * before it is believed": a bin (Step 10). The research fleet's worker reads
 * the brief, the client's messages and the text of the client's files, and
 * submits a deliverable *specification*. It never uploads a file and nothing
 * it sends is executed.
 *
 * The contract's evaluator renders that specification and verifies the bytes
 * (`deliverables/`), so a worker whose spreadsheet has a `#DIV/0!` or whose
 * slide text overflows is told while it still holds the lease and can correct
 * it. When the bin completes, the operation renders again (rendering is
 * deterministic), stores every file under keys built from Brain's own ids,
 * records the version with its checks, and only then delivers.
 *
 * A revision is a new bin and a new version; the version the client already
 * received keeps its row, its files and its checks.
 */
import { createHash } from 'node:crypto';
import { createBin, getBin, listBinUnitResults, markBinReady } from '../../../repos/bins.ts';
import { getDb } from '../../../db/database.ts';
import type { Bin } from '../../../domain/types.ts';
import type { MarketplaceJob, DeliveredFile } from '../../../repos/marketplaceJobs.ts';
import { getStorage } from '../../storage/index.ts';
import { safeSegment } from '../../storage/keys.ts';
import { readObject } from '../../storage.ts';
import { produce, type Produced } from './deliverables/capabilities.ts';
import { messageProblems, type DeliverableKind } from './deliverables/spec.ts';
import { SAMPLES } from './deliverables/samples.ts';
import { readXlsx, sheetAsText } from './deliverables/xlsx.ts';
import { unzip } from './deliverables/zip.ts';
import { textOf } from './deliverables/xml.ts';
import { CATEGORY_LABEL } from './classify.ts';
import { extractPdf } from '../../documents/pdf.ts';
import { extractDocx } from '../../documents/docx.ts';

export const FREELANCE_CONTRACT = 'FREELANCE_DELIVERABLE_V1';
export const FREELANCE_KIND = 'FREELANCE_DELIVERABLE';
/** Research family, so the research Routines that hold the cash project's membership take it. */
export const FREELANCE_WORKLOAD_CLASS = 'RESEARCH_FREELANCE_DELIVERABLE';
export const DELIVERABLE_UNIT = 'deliverable';
export const REPLY_UNIT = 'reply';
/** How many bins one job may spend on authoring and revisions together. */
export const MAX_DELIVERABLE_BINS = 4;
/** How many revisions after a delivery the client is given. */
export const MAX_REVISIONS = 2;
const MAX_CLIENT_TEXT = 18_000;

/* =========================================================================
 * The client's files, read
 * ====================================================================== */

export interface ReadFile {
  name: string;
  text: string;
  readable: boolean;
  note: string;
}

/** Turn one client file into text a worker can read. Never executes anything in it. */
export async function readClientFile(name: string, bytes: Buffer): Promise<ReadFile> {
  const lower = name.toLowerCase();
  try {
    if (lower.endsWith('.pdf')) {
      const pdf = await extractPdf(bytes);
      const text = pdf.pages.map((p) => `[page ${p.pageNumber}]\n${p.blocks.map((b) => b.text).join('\n')}`).join('\n\n');
      const chars = text.replace(/\[page \d+\]/g, '').trim().length;
      return chars > 20
        ? { name, text, readable: true, note: `${pdf.pageCount} page(s)` }
        : { name, text: '', readable: false, note: 'the PDF has no text layer (a scan); ask for a typed copy' };
    }
    if (lower.endsWith('.docx')) {
      const doc = await extractDocx(bytes);
      return { name, text: doc.pages.flatMap((p) => p.blocks.map((b) => b.text)).join('\n'), readable: true, note: 'Word document' };
    }
    if (/\.(xlsx|xlsm)$/.test(lower)) {
      const sheets = readXlsx(bytes);
      return { name, text: sheets.map((s) => `[sheet ${s.name}]\n${sheetAsText(s)}`).join('\n\n'), readable: true, note: `${sheets.length} sheet(s); formulas shown in brackets` };
    }
    if (lower.endsWith('.pptx')) {
      const parts = unzip(bytes);
      const slides = [...parts.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
      return { name, text: slides.map((k, i) => `[slide ${i + 1}]\n${textOf(parts.get(k)!.toString('utf8'), 'a:t').join(' ')}`).join('\n'), readable: true, note: `${slides.length} slide(s), text only` };
    }
    if (/\.(csv|tsv|txt|md|json|xml|html?|css|js|py|sql|yaml|yml)$/.test(lower)) {
      const text = bytes.toString('utf8');
      if (text.includes('\u0000')) return { name, text: '', readable: false, note: 'not a text file' };
      return { name, text, readable: true, note: 'text' };
    }
    return { name, text: '', readable: false, note: 'a file type Brain does not read (images, archives, media); ask for PDF, Word, Excel or text' };
  } catch (error) {
    return { name, text: '', readable: false, note: `could not be read: ${(error as Error).message.slice(0, 120)}` };
  }
}

/* =========================================================================
 * The brief and the bin
 * ====================================================================== */

export interface FulfilmentInput {
  job: MarketplaceJob;
  kinds: DeliverableKind[];
  attempt: number;
  clientMessages: string[];
  files: ReadFile[];
  /** For a revision: what was delivered before, and what the client said about it. */
  previous?: { spec: unknown; version: number } | null;
  /** For a retry after Brain refused a submission: the problems, verbatim. */
  problems?: string[];
}

export function creatorOf(jobId: string, attempt: number): string {
  return `freelancer:deliver:${jobId}:${attempt}`;
}

function clientMaterial(input: FulfilmentInput): string {
  const parts: string[] = [];
  if (input.clientMessages.length) parts.push(`The client's messages, oldest first:\n${input.clientMessages.map((m) => `- ${m}`).join('\n')}`);
  for (const f of input.files) parts.push(f.readable ? `File "${f.name}" (${f.note}):\n${f.text}` : `File "${f.name}": not readable (${f.note}).`);
  let text = parts.join('\n\n');
  if (text.length > MAX_CLIENT_TEXT) {
    const omitted = text.length - MAX_CLIENT_TEXT;
    text = `${text.slice(0, MAX_CLIENT_TEXT)}\n\n[${omitted} further characters of the client's material are not shown here. Work from what is shown; if the missing part is needed, say so in "message" and deliver what the shown material supports.]`;
  }
  return text || 'The client has sent no files or messages beyond the brief.';
}

export async function openDeliverableBin(input: FulfilmentInput): Promise<Bin> {
  const { job } = input;
  const examples = input.kinds
    .map((kind) => `Example of a correct "${kind}" spec (for a different client):\n${JSON.stringify(SAMPLES[kind].spec)}`)
    .join('\n\n');
  const shape =
    input.kinds.length === 1
      ? '{"spec": { ...one spec of kind ' + input.kinds[0] + '... }, "message": "a short note to the client, or omit"}'
      : `{"specs": [ ${input.kinds.map((k) => `{ ...spec of kind ${k}... }`).join(', ')} ], "message": "..."}`;
  const unitInput = [
    `Freelancer job "${job.title}" (${job.url}).`,
    '',
    'The client’s brief, exactly as posted:',
    job.description,
    '',
    clientMaterial(input),
    '',
    input.previous
      ? `This is a REVISION. Version ${input.previous.version} was delivered with this spec; change only what the client asked for:\n${JSON.stringify(input.previous.spec)}`
      : '',
    input.problems?.length ? `Brain refused the previous submission for these reasons; fix every one:\n${input.problems.map((p) => `- ${p}`).join('\n')}` : '',
    '',
    `Deliver: ${input.kinds.map((k) => CATEGORY_LABEL[k]).join(' and ')}. Submit ONE JSON value as this unit: ${shape}.`,
    'Brain renders the files from your spec and checks them before the bin can complete: every formula is computed and',
    'must not error, slide text must fit, the SVG may not contain scripts or external references, websites must link only',
    'to files in the bundle, code must parse. If Brain refuses, it tells you why: correct the unit and complete again.',
    'Use real, specific content for this client; never placeholders like "Lorem ipsum" or "[Company name]".',
    'Do not put contact details, links or payment arrangements in "message": Freelancer forbids them.',
    '',
    examples,
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n');

  const bin = await createBin({
    projectId: job.projectId,
    layerId: null,
    kind: FREELANCE_KIND,
    title: `Freelance deliverable: ${job.title}`.slice(0, 200),
    objective: `Produce the ${input.kinds.map((k) => CATEGORY_LABEL[k]).join(' and ')} this Freelancer client asked for, as a specification Brain renders and verifies.`,
    rationale: 'Brain won this job on the strength of a capability it has proved; the work is authored here and checked by Brain before it reaches the client.',
    manifest: {
      objective: `Author the deliverable for Freelancer job ${job.externalId}.`,
      why: 'A client is paying for this, so it has to be specific, correct and complete; Brain checks the files before delivery.',
      lineage: { projectId: job.projectId, layerId: null, goal: `Deliver "${job.title}"`, orchestrationId: null },
      units: [
        {
          key: DELIVERABLE_UNIT,
          establishes: `the finished ${input.kinds.join(' + ')} for this client`,
          input: unitInput,
          transform: 'NONE',
          dependsOn: [],
        },
      ],
      acceptableSources: ['The client’s brief, messages and files above.', 'Public facts you can verify, where the brief needs them.'],
      excludedSources: ['Invented data presented as the client’s or as fact.', 'Anything behind a login.'],
      evidence: ['Brain renders and verifies the files; the checks are recorded with the delivered version.'],
      outputs: [`One unit result under "${DELIVERABLE_UNIT}" holding the JSON submission.`],
      authorizedActions: ['reading the material above', 'reading public web pages if the brief needs facts', 'submitting one unit result'],
      prohibitedActions: ['contacting the client or anybody else', 'uploading or linking files', 'putting contact details or links in the message'],
      budgetUnits: 1,
      retry: { maxAttempts: 2, backoffSeconds: 120 },
      stoppingConditions: ['the submission passed Brain’s checks and the bin completed', 'or the brief cannot be met, reported as a blocker naming why'],
    },
    completionContract: FREELANCE_CONTRACT,
    createdByType: 'SYSTEM',
    createdById: creatorOf(job.id, input.attempt),
    ready: false,
    priority: 7,
    maxAttempts: 3,
    workloadClass: FREELANCE_WORKLOAD_CLASS,
  });
  await markBinReady(bin.id);
  return bin;
}

/* =========================================================================
 * The contract
 * ====================================================================== */

/** The job a bin was opened for, read from the bin's own creator id rather than from a later write. */
function jobIdOf(bin: Pick<Bin, 'createdById'>): string | null {
  const m = /^freelancer:(?:deliver|reply):([^:]+):/.exec(bin.createdById ?? '');
  return m ? m[1]! : null;
}

async function kindsForBin(bin: Bin): Promise<DeliverableKind[] | null> {
  const jobId = jobIdOf(bin);
  if (!jobId) return null;
  const row = await getDb().get<{ categories: string }>('SELECT categories FROM marketplace_jobs WHERE id = ?', [jobId]);
  if (!row) return null;
  try {
    return (JSON.parse(row.categories) as string[]).filter((c) => c !== 'RESEARCH_REPORT') as DeliverableKind[];
  } catch {
    return null;
  }
}

/** The bin may complete only when its submission renders and passes every check. */
export async function evaluateFreelanceDeliverable(bin: Bin): Promise<{ satisfied: boolean; disposition: 'SATISFIED' | 'RETRY'; reasons: string[]; observed: Record<string, unknown> }> {
  const results = await listBinUnitResults(bin.id);
  if ((bin.createdById ?? '').startsWith('freelancer:reply:')) {
    const reply = results.find((row) => row.unitKey === REPLY_UNIT);
    if (!reply) return { satisfied: false, disposition: 'RETRY', reasons: ['No reply was submitted.'], observed: { units: results.length } };
    const text = reply.value.trim();
    const problems = text.length < 10 ? ['The reply is empty.'] : messageProblems(text);
    return problems.length
      ? { satisfied: false, disposition: 'RETRY', reasons: problems, observed: { chars: text.length } }
      : { satisfied: true, disposition: 'SATISFIED', reasons: [], observed: { chars: text.length } };
  }
  const submitted = results.find((row) => row.unitKey === DELIVERABLE_UNIT);
  if (!submitted) return { satisfied: false, disposition: 'RETRY', reasons: ['No deliverable was submitted.'], observed: { units: results.length } };
  const kinds = await kindsForBin(bin);
  const produced = await produce(submitted.value, kinds ?? undefined);
  const observed = { kinds, files: produced.files.map((f) => f.name), checks: produced.verification?.checks.length ?? 0 };
  return produced.ok
    ? { satisfied: true, disposition: 'SATISFIED', reasons: [], observed }
    : { satisfied: false, disposition: 'RETRY', reasons: produced.problems.slice(0, 25), observed };
}

/* =========================================================================
 * Ingesting a finished bin
 * ====================================================================== */

export interface Ingested {
  produced: Produced;
  files: DeliveredFile[];
  bytes: Map<string, Buffer>;
}

/** Re-render a completed bin's submission and store every file. Idempotent by content: a key is the job, the bin and the name. */
export async function ingestBin(job: MarketplaceJob, binId: string): Promise<Ingested | { refused: string[] }> {
  const bin = await getBin(binId);
  if (!bin) return { refused: ['the bin is gone'] };
  const submitted = (await listBinUnitResults(binId)).find((row) => row.unitKey === DELIVERABLE_UNIT);
  if (!submitted) return { refused: ['the completed bin holds no deliverable'] };
  const kinds = job.categories.filter((c) => c !== 'RESEARCH_REPORT') as DeliverableKind[];
  const produced = await produce(submitted.value, kinds);
  if (!produced.ok) return { refused: produced.problems };
  const store = getStorage();
  const files: DeliveredFile[] = [];
  const bytes = new Map<string, Buffer>();
  for (const file of produced.files) {
    const key = `marketplace/${safeSegment(job.projectId, 'project')}/${safeSegment(job.id, 'job')}/${safeSegment(binId, 'bin')}/${safeSegment(file.name, 'file')}`;
    const meta = await store.put({ key, body: file.bytes, contentType: file.mime, originalFilename: file.name });
    files.push({ name: file.name, mime: file.mime, size: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex'), storageKey: meta.key });
    bytes.set(file.name, file.bytes);
  }
  return { produced, files, bytes };
}

/** Read stored files back, checking each against its recorded hash. */
export async function loadFiles(files: DeliveredFile[]): Promise<{ name: string; base64: string; type: string }[]> {
  const out: { name: string; base64: string; type: string }[] = [];
  for (const f of files) {
    const bytes = await readObject(f.storageKey);
    if (createHash('sha256').update(bytes).digest('hex') !== f.sha256) throw new Error(`${f.name} in the store no longer matches the file Brain verified.`);
    out.push({ name: f.name, base64: bytes.toString('base64'), type: f.mime });
  }
  return out;
}

/* =========================================================================
 * Answering a client's question
 * ====================================================================== */

/**
 * A question from the client, answered by the fleet and sent by Brain.
 *
 * The answer is text only, checked like every message Brain sends under the
 * owner's account: no contact details, no links, nothing that moves the work
 * or the payment off the platform. It commits to nothing the bid did not.
 */
export async function openReplyBin(job: MarketplaceJob, messageId: string, messages: string[]): Promise<Bin> {
  const bin = await createBin({
    projectId: job.projectId,
    layerId: null,
    kind: FREELANCE_KIND,
    title: `Freelance reply: ${job.title}`.slice(0, 200),
    objective: 'Answer the client’s latest message on this Freelancer job, briefly and accurately.',
    rationale: 'A client who asks a question and hears nothing does not award the job, or stops trusting the one in progress.',
    manifest: {
      objective: `Reply to the client on Freelancer job ${job.externalId}.`,
      why: 'Clients decide on and keep working with freelancers who answer.',
      lineage: { projectId: job.projectId, layerId: null, goal: `Answer the client on "${job.title}"`, orchestrationId: null },
      units: [
        {
          key: REPLY_UNIT,
          establishes: 'the reply Brain sends to the client',
          input: [
            `Freelancer job "${job.title}". Brain's job state: ${job.state}. Brain's bid: ${job.currency} ${(job.bidAmountCents ?? 0) / 100}, ${job.bidPeriodDays ?? 4} days.`,
            `Brain delivers: ${job.categories.join(', ') || 'a research report'}.`,
            '',
            'The brief:',
            job.description.slice(0, 5000),
            '',
            'The client’s messages, oldest first (the last one is what to answer):',
            ...messages.slice(-10).map((m) => `- ${m}`),
            '',
            'Submit the reply as plain text, 1 to 6 sentences. Answer the question directly. Do not change the price or the',
            'deadline, do not promise anything outside the brief, and if the client asks for something Brain cannot deliver',
            '(calls, access to their systems, work outside the brief), say so plainly. No email addresses, phone numbers,',
            'links or payment outside Freelancer.',
          ].join('\n'),
          transform: 'NONE',
          dependsOn: [],
        },
      ],
      acceptableSources: ['The brief and messages above.'],
      excludedSources: ['Anything that is not in the brief or the messages.'],
      evidence: ['Brain checks the reply for contact details, links and off-platform terms before sending it.'],
      outputs: [`One unit result under "${REPLY_UNIT}": the reply text.`],
      authorizedActions: ['submitting one unit result'],
      prohibitedActions: ['contacting the client directly', 'changing the price or the deadline'],
      budgetUnits: 1,
      retry: { maxAttempts: 2, backoffSeconds: 60 },
      stoppingConditions: ['the reply was submitted and passed Brain’s checks'],
    },
    completionContract: FREELANCE_CONTRACT,
    createdByType: 'SYSTEM',
    createdById: `freelancer:reply:${job.id}:${messageId}`,
    ready: false,
    priority: 8,
    maxAttempts: 2,
    workloadClass: FREELANCE_WORKLOAD_CLASS,
  });
  await markBinReady(bin.id);
  return bin;
}

export async function replyOf(binId: string): Promise<string | null> {
  const row = (await listBinUnitResults(binId)).find((r) => r.unitKey === REPLY_UNIT);
  return row ? row.value.trim() : null;
}

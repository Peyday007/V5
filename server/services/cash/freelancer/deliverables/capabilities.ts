/**
 * Which kinds of freelance work Brain can deliver, established by doing it.
 *
 * A category is AVAILABLE only when its realistic sample (`samples.ts`) has
 * been validated, rendered into real files and passed every verification
 * check, in this process. Having the code, or a tool installed, is not the
 * same fact, and the job screen reads this rather than a list.
 *
 * The proof runs once per process and is cached; a category that failed says
 * which check failed, so the screen's rejection names the missing capability
 * rather than a job category.
 */
import { DELIVERABLE_KINDS, validateSubmission, type DeliverableKind, type Submission } from './spec.ts';
import { renderDeliverable, type DeliverableFile, type Rendered } from './render.ts';
import { verifyDeliverable, type Verification } from './verify.ts';
import { pythonParserAvailable } from './assets.ts';
import { SAMPLES } from './samples.ts';

export interface CapabilityReading {
  kind: DeliverableKind;
  available: boolean;
  checkedAt: string;
  detail: string;
  files: string[];
}

export interface Produced {
  ok: boolean;
  submission: Submission | null;
  /** Every file, across every spec, in spec order. */
  files: DeliverableFile[];
  rendered: Rendered[];
  verification: Verification | null;
  problems: string[];
}

/**
 * Validate, render and verify one worker submission. Nothing is stored here.
 * `kinds`, when given, is what the job asked for: a submission of anything
 * else is refused, because a correct spreadsheet is the wrong answer to a
 * request for a deck.
 */
export async function produce(raw: string, kinds?: readonly DeliverableKind[]): Promise<Produced> {
  const validated = validateSubmission(raw);
  const fail = (problems: string[], submission: Submission | null = null): Produced => ({ ok: false, submission, files: [], rendered: [], verification: null, problems });
  if (!validated.ok) return fail(validated.problems);
  const submitted = validated.submission.specs.map((s) => s.kind);
  if (kinds && (submitted.length !== kinds.length || submitted.some((k, i) => k !== kinds[i]))) {
    return fail([`The job asks for ${kinds.join(' then ')}; the submission carries ${submitted.join(' then ')}.`], validated.submission);
  }
  const rendered: Rendered[] = [];
  const checks: Verification['checks'] = [];
  for (const [i, spec] of validated.submission.specs.entries()) {
    let one: Rendered;
    try {
      one = await renderDeliverable(spec);
    } catch (error) {
      return fail([`Rendering ${spec.kind} failed: ${(error as Error).message.slice(0, 300)}`], validated.submission);
    }
    rendered.push(one);
    const verified = await verifyDeliverable(spec, one);
    const prefix = validated.submission.specs.length > 1 ? `${i + 1}/${spec.kind} ` : '';
    checks.push(...verified.checks.map((c) => ({ ...c, name: prefix + c.name })));
  }
  const files = rendered.flatMap((r) => r.files);
  const names = files.map((f) => f.name.toLowerCase());
  if (new Set(names).size !== names.length) checks.push({ name: 'file names', ok: false, detail: 'two deliverables produced files with the same name' });
  const verification: Verification = { passed: checks.length > 0 && checks.every((c) => c.ok), checks };
  const problems = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  return { ok: verification.passed, submission: validated.submission, files, rendered, verification, problems };
}

let cached: Promise<Record<DeliverableKind, CapabilityReading>> | null = null;

async function proveOne(kind: DeliverableKind): Promise<CapabilityReading> {
  const checkedAt = new Date().toISOString();
  const produced = await produce(JSON.stringify({ spec: SAMPLES[kind].spec }));
  if (!produced.ok) {
    return { kind, available: false, checkedAt, detail: `its sample failed: ${produced.problems.slice(0, 3).join(' ')}`, files: [] };
  }
  const files = produced.files.map((f) => f.name);
  const passed = produced.verification!.checks.length;
  return { kind, available: true, checkedAt, detail: `sample rendered to ${files.join(', ')} and passed ${passed} check(s)`, files };
}

export function proveCapabilities(): Promise<Record<DeliverableKind, CapabilityReading>> {
  cached ??= (async () => {
    const out = {} as Record<DeliverableKind, CapabilityReading>;
    for (const kind of DELIVERABLE_KINDS) {
      try {
        out[kind] = await proveOne(kind);
      } catch (error) {
        out[kind] = { kind, available: false, checkedAt: new Date().toISOString(), detail: `its sample threw: ${(error as Error).message.slice(0, 200)}`, files: [] };
      }
    }
    return out;
  })();
  return cached;
}

/** Tests prove again after changing the environment. */
export function forgetCapabilities(): void {
  cached = null;
}

/** Languages whose code Brain can check before delivering. */
export function codeLanguages(): { python: boolean; javascript: true } {
  return { python: pythonParserAvailable(), javascript: true };
}

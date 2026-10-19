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
import { renderDeliverable, type Rendered } from './render.ts';
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
  rendered: Rendered | null;
  verification: Verification | null;
  problems: string[];
}

/** Validate, render and verify one worker submission. Nothing is stored here. */
export async function produce(raw: string): Promise<Produced> {
  const validated = validateSubmission(raw);
  if (!validated.ok) return { ok: false, submission: null, rendered: null, verification: null, problems: validated.problems };
  let rendered: Rendered;
  try {
    rendered = await renderDeliverable(validated.submission.spec);
  } catch (error) {
    return { ok: false, submission: validated.submission, rendered: null, verification: null, problems: [`Rendering failed: ${(error as Error).message.slice(0, 300)}`] };
  }
  const verification = await verifyDeliverable(validated.submission.spec, rendered);
  const problems = verification.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  return { ok: verification.passed, submission: validated.submission, rendered, verification, problems };
}

let cached: Promise<Record<DeliverableKind, CapabilityReading>> | null = null;

async function proveOne(kind: DeliverableKind): Promise<CapabilityReading> {
  const checkedAt = new Date().toISOString();
  const produced = await produce(JSON.stringify({ spec: SAMPLES[kind].spec }));
  if (!produced.ok) {
    return { kind, available: false, checkedAt, detail: `its sample failed: ${produced.problems.slice(0, 3).join(' ')}`, files: [] };
  }
  const files = produced.rendered!.files.map((f) => f.name);
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

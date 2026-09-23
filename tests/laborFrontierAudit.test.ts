/**
 * An exhaustive audit of the one property the frontier rests on:
 * **the blocker list is empty exactly when the verdict is `BRAIN_DEFENSIBLE`.**
 *
 * Written as a brute force rather than as cases because the failure it guards
 * is a *combination* nobody thought of: a task that is not established and
 * reports nothing in its way reads, to anybody looking at the frontier, as
 * ready to move to Brain now. That is the most misleading output this module
 * can produce, and it is produced from the state that looks healthiest.
 *
 * ---------------------------------------------------------------------------
 * The first version of this file was vacuous, and that is why it says so
 * ---------------------------------------------------------------------------
 *
 * It ran the same 2 187 combinations against a task naming **no capability**.
 * `deriveCanProduce` answers `UNKNOWN` for such a task — correctly, since
 * nobody said Brain cannot produce it, they said nobody recorded which
 * capability it needs — and `BRAIN_CAN_PRODUCE` is a gating question. So
 * `gatingSatisfied` was false in every single reading, `BRAIN_DEFENSIBLE` was
 * unreachable, and the test asserted one half of a biconditional whose other
 * half never occurred. It passed with `NECESSITY_UNANSWERED` deleted, which is
 * how it was caught.
 *
 * A vacuous guard is worse than none, because it reads as coverage. So this
 * version registers a real healthy Routine, names a capability that genuinely
 * reads `PRESENT` from those rows, and **asserts that both verdicts actually
 * occur** before it trusts the biconditional over them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createAccount, createRoutine } from '../server/repos/fleet.ts';
import { createWorker } from '../server/repos/identity.ts';
import { assessTask } from '../server/services/labor/necessity.ts';
import { NECESSITY_ANSWERS } from '../server/domain/types.ts';
import type {
  LaborNecessityAnswer,
  LaborTask,
  NecessityAnswer,
  NecessityQuestion,
} from '../server/domain/types.ts';

/**
 * The six storable answers that bear on the verdict.
 *
 * `BRAIN_IS_FASTER` and `BRAIN_IS_CHEAPER` are deliberately absent: they feed
 * `advantage` rather than the verdict, so including them would triple the
 * space and vary nothing this asserts.
 */
const QUESTIONS: NecessityQuestion[] = [
  'BRAIN_QUALITY_AT_LEAST_EQUAL',
  'BRAIN_CAN_SELF_VERIFY',
  'REQUIRES_PHYSICAL_PRESENCE',
  'REQUIRES_LICENSED_HUMAN',
  'HUMAN_INTERACTION_ADDS_VALUE',
  'HANDLES_ONLY_EXCEPTIONS',
];

let projectId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
});

/** One healthy execution surface, so `RESEARCH_A_QUESTION` reads PRESENT. */
async function healthyFleet(): Promise<void> {
  const account = await createAccount({
    name: `audit-${Math.random().toString(36).slice(2, 8)}`,
  });
  await createRoutine({
    accountId: account.id,
    routineRef: `trig_${Math.random().toString(36).slice(2, 12)}`,
    name: 'A surface',
    tokenSecretName: 'LABOR_AUDIT_SECRET',
    tokenDigest: 'a'.repeat(64),
    // A real worker row: a Routine bound to an id that resolves to no worker is
    // not a surface anything could authenticate as, and is not counted.
    workerId: (
      await createWorker({
        name: `labor-worker-${Math.random().toString(36).slice(2, 10)}`,
        createdByType: 'SYSTEM',
        createdById: 'labor test',
      })
    ).id,
  });
}

function taskNaming(capabilityId: string | null): LaborTask {
  return {
    id: 'tsk_audit',
    projectId,
    workflowId: 'wfl_audit',
    name: 'audit',
    output: 'an output',
    origin: 'SEED',
    capabilityId,
    declaredByRef: null,
    retiredAt: null,
    retiredReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function answerRow(question: NecessityQuestion, answer: NecessityAnswer): LaborNecessityAnswer {
  return {
    id: `lna_${question}`,
    projectId,
    taskId: 'tsk_audit',
    question,
    answer,
    basis: 'PERSON',
    statement: 'audit fixture',
    sourceClaimId: null,
    answeredByRef: null,
    supersededAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Every combination of the six, over one reading of the fleet. */
function combinations(): { answers: LaborNecessityAnswer[]; picked: string }[] {
  const out: { answers: LaborNecessityAnswer[]; picked: string }[] = [];
  const total = NECESSITY_ANSWERS.length ** QUESTIONS.length;
  for (let n = 0; n < total; n += 1) {
    let rest = n;
    const answers: LaborNecessityAnswer[] = [];
    const picked: string[] = [];
    for (const question of QUESTIONS) {
      const answer = NECESSITY_ANSWERS[rest % NECESSITY_ANSWERS.length] as NecessityAnswer;
      rest = Math.floor(rest / NECESSITY_ANSWERS.length);
      answers.push(answerRow(question, answer));
      picked.push(`${question}=${answer}`);
    }
    out.push({ answers, picked: picked.join(' ') });
  }
  return out;
}

describe('the frontier can never report nothing in the way of a task that is not established', () => {
  it('has an empty blocker list exactly when the verdict is BRAIN_DEFENSIBLE', async () => {
    await healthyFleet();
    const task = taskNaming('RESEARCH_A_QUESTION');
    const failures: string[] = [];
    const seen = new Set<string>();
    let readings = 0;

    for (const independentVerification of [true, false, null]) {
      for (const { answers, picked } of combinations()) {
        const reading = await assessTask({ task, answers, independentVerification });
        readings += 1;
        seen.add(reading.verdict);

        const silent = reading.blockers.length === 0;
        const defensible = reading.verdict === 'BRAIN_DEFENSIBLE';
        if (silent !== defensible) {
          failures.push(
            `verdict=${reading.verdict} blockers=${reading.blockers.length} ` +
              `fleet=${String(independentVerification)} ${picked}`,
          );
        }
      }
    }

    expect(readings).toBe(3 * 3 ** 6);
    /*
     * The anti-vacuity assertion, and the reason this file exists twice.
     *
     * Without it the biconditional above is satisfied by a run in which
     * `BRAIN_DEFENSIBLE` never occurs — which is exactly what the first
     * version did, and it passed with the guard it exists to protect deleted.
     */
    expect([...seen].sort()).toEqual(['BRAIN_DEFENSIBLE', 'HUMAN_REQUIRED', 'NOT_ESTABLISHED']);
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it('never reaches BRAIN_DEFENSIBLE with nothing asked at all', async () => {
    await healthyFleet();
    for (const independentVerification of [true, false, null]) {
      const reading = await assessTask({
        task: taskNaming('RESEARCH_A_QUESTION'),
        answers: [],
        independentVerification,
      });
      expect(reading.verdict).toBe('NOT_ESTABLISHED');
      expect(reading.blockers.length).toBeGreaterThan(0);
    }
  });

  /*
   * And the capability reading is a *reading*: a task naming a capability the
   * fleet cannot currently supply is never defensible, however its six answers
   * come out. This is the half that would be silently lost if `readCapability`
   * ever started answering from a cache.
   */
  it('is never defensible when the capability it needs is not there', async () => {
    const task = taskNaming('RESEARCH_A_QUESTION');
    for (const { answers } of combinations()) {
      const reading = await assessTask({ task, answers, independentVerification: true });
      expect(reading.verdict).not.toBe('BRAIN_DEFENSIBLE');
      expect(reading.blockers.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Join two Step 12B acceptance readings into one matrix, or refuse to.
 *
 * ---------------------------------------------------------------------------
 * Why a combiner has to exist, and why its main job is refusing
 * ---------------------------------------------------------------------------
 *
 * No single run can answer all seventeen scenarios, and that is a property of
 * the deployment rather than a gap in the reporter. A **checkout** run can read
 * the repository tree and the scratch database but has no fleet; a **container**
 * run has the fleet and the scratch database, and `.dockerignore` deliberately
 * keeps `tests/`, `docs/` and `client/src` out of the image. So four rows are
 * only answerable from a checkout and five only from a Brain that has run.
 *
 * The tempting shortcut is to read both and take whichever answer is better.
 * That is how a reader ends up comparing a production reading of *today's* rows
 * with a repository fact from a tree that has since changed — and the combined
 * matrix would look stronger than either run while describing no code that
 * exists. So the single most important thing here is the refusal: **two records
 * are joinable only if they name the same revision**, each revision is attested
 * by something that cannot be wrong about it (git in a clean checkout, or the
 * sha stamped into the image at build time), and anything else stops.
 *
 * What it will not do:
 *
 *  - join records whose revisions differ, or either of which has none;
 *  - join a record taken over a dirty tree, because that revision describes a
 *    tree that exists nowhere;
 *  - pick a winner when two runs that both looked at a scenario disagree. That
 *    is reported as `CONFLICT` and counted against the reading, because two
 *    environments contradicting each other about one scenario means the
 *    scenario is not established — it means something is wrong with how it is
 *    being measured.
 *
 *   npx tsx scripts/step12b-combine.ts <record.json> <record.json> [...]
 */
import fs from 'node:fs';
import path from 'node:path';

type Verdict = 'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED' | 'NOT_RUN' | 'CONFLICT';

/**
 * One condition a scenario is made of, as the reporter recorded it.
 *
 *   held === true    exercised, and it holds.
 *   held === false   exercised, and it does not. That is a defect.
 *   held === null    not exercisable from the environment that ran, and
 *                    `needs` says which one can.
 *   standing         out of reach on purpose — the owner's decision, a
 *                    capability this version refuses, a measurement that would
 *                    spend the subscription. Reported, never counted against.
 */
interface ConditionRecord {
  name: string;
  held: boolean | null;
  saw: string;
  needs?: 'CHECKOUT' | 'PRODUCTION' | 'ISOLATED';
  /**
   * Waiting on somebody — the third shape of `held: null`.
   *
   * `needs` says another environment could answer it; `standing` says this is
   * the answer. Neither is true of a decision a person has not taken, and
   * reporting it either way says something false: the first sends a reader to
   * run the reporter somewhere else, the second calls an ungiven approval an
   * answer. It is `BLOCKED` — an operational fact with an operational remedy.
   */
  awaits?: string;
  /**
   * An owner-approved deferral, and the only thing that takes a condition out
   * of the denominator. It was `standing?: true` — a flag the reporter set on
   * itself — which let a gate pass with a required condition unproved
   * underneath it. A deferral has to name who decided, when, and where it is
   * recorded.
   */
  deferredBy?: { owner: string; recordedAt: string; where: string };
}

interface GateRecord {
  id: string;
  title: string;
  verdict: Exclude<Verdict, 'CONFLICT'>;
  evidenceFrom: 'CHECKOUT' | 'PRODUCTION' | 'ISOLATED';
  detail: string;
  /** Absent in records written before the conditions existed. */
  conditions?: ConditionRecord[];
}

interface Reading {
  step: string;
  ranIn: 'CHECKOUT' | 'PRODUCTION';
  revision: string | null;
  revisionAttestedBy: string;
  treeDirty: boolean;
  generatedAt: string;
  repositoryVisible: boolean;
  operationalReading: { taken: boolean; why?: string; source?: string };
  gates: GateRecord[];
}

/**
 * The seventeen scenarios, named once.
 *
 * A combiner that took whatever gates it was given would declare completion on
 * a reading that held three of them: `counts.PASS === combined.length` is true
 * of any set where everything present passed, including a set that is missing
 * fourteen rows. That is the arithmetic-on-a-fiction §23 already corrected once,
 * at a matrix — the denominator has to be the scenarios, not the rows somebody
 * happened to emit.
 *
 * Declared here rather than read from the first reading, because taking the set
 * from the input means a truncated input defines its own completeness.
 */
const SCENARIOS = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I',
  'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q',
] as const;

function fail(message: string): never {
  console.error(`STEP 12B COMBINE: REFUSED — ${message}`);
  process.exit(1);
}

function read(file: string): Reading {
  const full = path.resolve(file);
  if (!fs.existsSync(full)) fail(`${file} does not exist.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (error) {
    fail(`${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const reading = parsed as Reading;
  if (reading.step !== '12B') fail(`${file} is not a Step 12B reading.`);
  if (!Array.isArray(reading.gates) || reading.gates.length === 0) {
    fail(`${file} carries no gates.`);
  }

  /*
   * A reading has to be about all seventeen scenarios, and about nothing else.
   *
   * Three separate refusals, because they are three different mistakes and a
   * reader needs to know which one happened:
   *
   *   unknown    an id that is not a scenario — a typo, or a gate somebody
   *              added without adding it to the contract. Silently carrying it
   *              would put a row in the matrix that answers to nothing.
   *   duplicate  the same id twice in one reading. `[...new Set(...)]` used to
   *              swallow this, which meant two contradictory records for one
   *              scenario collapsed into whichever came first.
   *   missing    a scenario the reading does not mention at all. This is the
   *              one that mattered: it is indistinguishable from a passing run
   *              once the rows are counted.
   */
  const seen = new Map<string, number>();
  for (const gate of reading.gates) {
    seen.set(gate.id, (seen.get(gate.id) ?? 0) + 1);
  }
  const known = new Set<string>(SCENARIOS);
  const unknown = [...seen.keys()].filter((id) => !known.has(id)).sort();
  if (unknown.length > 0) {
    fail(`${file} carries gate(s) that are not Step 12B scenarios: ${unknown.join(', ')}.`);
  }
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
  if (duplicated.length > 0) {
    fail(
      `${file} carries duplicate record(s) for gate(s) ${duplicated.join(', ')}. Two records for ` +
        'one scenario in one run is a reporter defect, not something to pick between.',
    );
  }
  const absent = SCENARIOS.filter((id) => !seen.has(id));
  if (absent.length > 0) {
    fail(
      `${file} is missing gate(s) ${absent.join(', ')} of the seventeen. A partial reading cannot ` +
        'be combined: a matrix whose denominator is the rows somebody emitted would report ' +
        'completion for a run that never looked at most of it.',
    );
  }

  return reading;
}

function main(): void {
  const files = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  if (files.length < 2) {
    fail('name at least two readings — one from a checkout and one from the deployment.');
  }

  const readings = files.map(read);

  /*
   * The refusals, before anything is combined.
   *
   * Checked in this order deliberately: a missing revision is a worse problem
   * than a mismatched one, because it cannot even be argued about.
   */
  for (const [index, reading] of readings.entries()) {
    if (!reading.revision) {
      fail(
        `${files[index]} names no revision (attested by: ${reading.revisionAttestedBy}). ` +
          'A reading that cannot say which code it describes cannot be combined with one that can.',
      );
    }
    if (reading.treeDirty) {
      fail(
        `${files[index]} was taken over a dirty tree at ${reading.revision.slice(0, 8)}. ` +
          'That revision describes a tree that exists nowhere, so joining it would compare ' +
          'this reading against code nobody can check out. Commit or stash, then re-run.',
      );
    }
  }

  const revisions = new Set(readings.map((reading) => reading.revision as string));
  if (revisions.size !== 1) {
    const named = readings
      .map((reading, index) => `${files[index]} = ${(reading.revision as string).slice(0, 8)}`)
      .join(', ');
    fail(
      `the readings describe different revisions (${named}). Take both at one revision — ` +
        'a combined matrix over two trees would look stronger than either run and describe neither.',
    );
  }
  const revision = [...revisions][0] as string;

  const environments = readings.map((reading) => reading.ranIn);
  if (!environments.includes('CHECKOUT') || !environments.includes('PRODUCTION')) {
    fail(
      `the readings come from ${environments.join(' and ')} only. All seventeen scenarios need ` +
        'one run from a checkout (for the repository facts) and one from the deployment (for the ' +
        'fleet), because neither environment can see the other half.',
    );
  }

  /*
   * One row per scenario, joined at the **condition** level.
   *
   * The obvious design is to pick whichever run's verdict is better, and it is
   * wrong in a way that only shows up once the conditions exist. A checkout run
   * reports PARTIAL on nine scenarios because one condition each needs the
   * deployed Brain's rows; a production run reports PARTIAL on those same nine
   * because it cannot see the repository. Joining the *verdicts* gives PARTIAL
   * agreeing with PARTIAL — and the true answer is that between the two runs
   * every condition was exercised and held.
   *
   * So conditions are unioned by name and the verdict is re-derived with the
   * same rule the reporter uses. A condition one run could not exercise and the
   * other could is **answered**; one neither could reach stays unexercised; one
   * that broke anywhere breaks the scenario, because a defect seen in one
   * environment is a defect.
   *
   * Two runs that exercised the same condition and disagree about it are a
   * CONFLICT — not a tie to break. A condition measured twice with two answers
   * is not established, and what needs fixing is the measurement.
   *
   * Walked in contract order. Every reading has already been checked to carry
   * exactly these seventeen, so this cannot silently shrink.
   */
  const ids: readonly string[] = SCENARIOS;
  const combined: {
    id: string;
    title: string;
    verdict: Verdict;
    from: string;
    detail: string;
  }[] = [];

  const verdictOfConditions = (conditions: ConditionRecord[]): Verdict => {
    if (conditions.length === 0) return 'NOT_RUN';
    const judged = conditions.filter((c) => c.deferredBy === undefined);
    if (judged.some((c) => c.held === false)) return 'FAIL';
    if (judged.length === 0) return 'PASS';
    if (judged.some((c) => c.held === null && c.awaits !== undefined)) return 'BLOCKED';
    if (judged.every((c) => c.held === null)) return 'NOT_RUN';
    if (judged.some((c) => c.held === null)) return 'PARTIAL';
    return 'PASS';
  };

  for (const id of ids) {
    const candidates = readings
      .map((reading, index) => ({
        reading,
        file: files[index] as string,
        gate: reading.gates.find((gate) => gate.id === id),
      }))
      .filter((entry): entry is typeof entry & { gate: GateRecord } => entry.gate !== undefined);

    if (candidates.length === 0) continue;
    const title = candidates[0]!.gate.title;
    const withConditions = candidates.filter(
      (entry) => Array.isArray(entry.gate.conditions) && entry.gate.conditions.length > 0,
    );

    /*
     * A record written before conditions existed still joins, at the verdict
     * level, the way it always did. Refusing it would make the combiner unable
     * to read the records it was built for — and saying which way a row was
     * joined is what stops the weaker join being mistaken for the stronger one.
     */
    if (withConditions.length === 0) {
      const answered = candidates.filter((entry) => entry.gate.verdict !== 'NOT_RUN');
      if (answered.length === 0) {
        combined.push({
          id,
          title,
          verdict: 'NOT_RUN',
          from: candidates.map((entry) => entry.reading.ranIn).join(' + '),
          detail: candidates
            .map((entry) => `${entry.reading.ranIn}: ${entry.gate.detail}`)
            .join(' || '),
        });
        continue;
      }
      const verdicts = new Set(answered.map((entry) => entry.gate.verdict));
      if (verdicts.size > 1) {
        const both = answered
          .map((entry) => `${entry.reading.ranIn}=${entry.gate.verdict}`)
          .join(' vs ');
        combined.push({
          id,
          title,
          verdict: 'CONFLICT',
          from: both,
          detail:
            `two environments disagree about this scenario at one revision (${both}). ` +
            'That is not a tie to break: a scenario measured two ways with two answers is not ' +
            'established, and what needs fixing is the measurement. ' +
            answered.map((entry) => `${entry.reading.ranIn}: ${entry.gate.detail}`).join(' || '),
        });
        continue;
      }
      const decisive = answered.find(
        (entry) =>
          entry.gate.evidenceFrom === entry.reading.ranIn || entry.gate.evidenceFrom === 'ISOLATED',
      );
      const chosen = decisive ?? answered[0]!;
      combined.push({
        id,
        title,
        verdict: chosen.gate.verdict,
        from:
          (answered.length > 1
            ? `${answered.map((entry) => entry.reading.ranIn).join(' + ')} (agreed)`
            : chosen.reading.ranIn) + ' — joined by verdict, no conditions recorded',
        detail: chosen.gate.detail,
      });
      continue;
    }

    /* -- The condition-level join ---------------------------------------- */
    const byName = new Map<string, { condition: ConditionRecord; from: string }[]>();
    for (const entry of withConditions) {
      for (const condition of entry.gate.conditions ?? []) {
        const list = byName.get(condition.name) ?? [];
        list.push({ condition, from: entry.reading.ranIn });
        byName.set(condition.name, list);
      }
    }

    const merged: ConditionRecord[] = [];
    const conflicts: string[] = [];
    const answeredElsewhere: string[] = [];
    for (const [name, entries] of byName) {
      const exercised = entries.filter((entry) => entry.condition.held !== null);
      const outcomes = new Set(exercised.map((entry) => entry.condition.held));
      if (outcomes.size > 1) {
        conflicts.push(
          `${name} — ` +
            exercised.map((entry) => `${entry.from}=${entry.condition.held}`).join(' vs '),
        );
        merged.push({ name, held: false, saw: 'the two runs disagree about it' });
        continue;
      }
      if (exercised.length > 0) {
        const winner = exercised[0]!;
        if (entries.some((entry) => entry.condition.held === null)) {
          answeredElsewhere.push(`${name} (answered by ${winner.from})`);
        }
        merged.push({ ...winner.condition, saw: `${winner.condition.saw} [${winner.from}]` });
        continue;
      }
      merged.push(entries[0]!.condition);
    }

    const verdict = conflicts.length > 0 ? 'CONFLICT' : verdictOfConditions(merged);
    const broke = merged.filter((c) => c.held === false && c.deferredBy === undefined);
    const waiting = merged.filter(
      (c) => c.held === null && c.deferredBy === undefined && c.awaits !== undefined,
    );
    const unreachable = merged.filter(
      (c) => c.held === null && c.deferredBy === undefined && c.awaits === undefined,
    );
    const deferred = merged.filter((c) => c.deferredBy !== undefined);
    const held = merged.filter((c) => c.held === true);
    const judged = merged.filter((c) => c.deferredBy === undefined).length;

    const parts: string[] = [
      `${held.length}/${judged} condition(s) held across ` +
        `${withConditions.map((entry) => entry.reading.ranIn).join(' + ')}.`,
    ];
    if (answeredElsewhere.length > 0) {
      parts.push(
        `${answeredElsewhere.length} of them one run could not reach and the other did: ` +
          `${answeredElsewhere.join('; ')}.`,
      );
    }
    if (conflicts.length > 0) {
      parts.push(
        `${conflicts.length} condition(s) were exercised in both runs with different answers: ` +
          `${conflicts.join('; ')}. A condition measured twice with two answers is not ` +
          'established, and what needs fixing is the measurement.',
      );
    }
    if (broke.length > 0) {
      parts.push(
        `${broke.length} condition(s) were exercised and did NOT hold: ` +
          broke.map((c) => `${c.name} (saw ${c.saw})`).join('; ') +
          '.',
      );
    }
    if (waiting.length > 0) {
      parts.push(
        `${waiting.length} condition(s) are waiting on somebody: ` +
          waiting.map((c) => `${c.awaits} — ${c.name}`).join('; ') +
          '.',
      );
    }
    if (unreachable.length > 0) {
      parts.push(
        `${unreachable.length} condition(s) neither run could exercise: ` +
          unreachable.map((c) => `${c.name} (needs ${c.needs ?? 'another environment'})`).join('; ') +
          '.',
      );
    }
    if (deferred.length > 0) {
      parts.push(
        `${deferred.length} deferred by the owner, and out of the denominator only ` +
          `because of that: ${deferred.map((c) => c.name).join('; ')}.`,
      );
    }
    combined.push({
      id,
      title,
      verdict,
      from: `${withConditions.map((entry) => entry.reading.ranIn).join(' + ')} — joined by condition`,
      detail: parts.join(' '),
    });
  }

  console.log('STEP 12B — combined acceptance matrix');
  console.log(`  revision  ${revision}`);
  for (const [index, reading] of readings.entries()) {
    const operational = reading.operationalReading.taken
      ? `fleet read from ${reading.operationalReading.source}`
      : `fleet NOT read (${reading.operationalReading.why ?? 'no reason recorded'})`;
    console.log(
      `  ${reading.ranIn.padEnd(10)} ${files[index]} — ${reading.generatedAt}, ` +
        `repository ${reading.repositoryVisible ? 'visible' : 'not visible'}, ${operational}`,
    );
    console.log(`             revision attested by ${reading.revisionAttestedBy}`);
  }
  console.log('');

  for (const row of combined) {
    console.log(`${row.id}  ${row.verdict.padEnd(8)} ${row.title}   [${row.from}]`);
    console.log(`     ${row.detail}`);
  }

  const counts = combined.reduce<Record<Verdict, number>>(
    (acc, row) => ({ ...acc, [row.verdict]: acc[row.verdict] + 1 }),
    { PASS: 0, FAIL: 0, PARTIAL: 0, BLOCKED: 0, NOT_RUN: 0, CONFLICT: 0 },
  );
  console.log('');
  console.log(
    `STEP 12B COMBINED — ${counts.PASS} PASS · ${counts.FAIL} FAIL · ${counts.PARTIAL} PARTIAL · ` +
      `${counts.BLOCKED} BLOCKED · ${counts.NOT_RUN} NOT_RUN · ${counts.CONFLICT} CONFLICT ` +
      `(of ${combined.length} scenarios, at ${revision.slice(0, 8)})`,
  );
  /*
   * Completion is all seventeen, not "everything that turned up".
   * `combined.length` is compared to the contract as well as to the count, so a
   * future change that drops a scenario is a loud failure rather than a smaller
   * matrix that passes.
   */
  if (counts.PASS === SCENARIOS.length && combined.length === SCENARIOS.length) {
    console.log(`STEP 12B IS COMPLETE AT THIS REVISION (all ${SCENARIOS.length} scenarios).`);
    return;
  }
  console.log('STEP 12B IS NOT COMPLETE.');
  for (const row of combined.filter((entry) => entry.verdict !== 'PASS')) {
    console.log(`  ${row.id} ${row.verdict} — ${row.title}`);
  }
  process.exitCode = 1;
}

main();

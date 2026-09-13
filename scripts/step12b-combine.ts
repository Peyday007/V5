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

interface GateRecord {
  id: string;
  title: string;
  verdict: Exclude<Verdict, 'CONFLICT'>;
  evidenceFrom: 'CHECKOUT' | 'PRODUCTION' | 'ISOLATED';
  detail: string;
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
   * One row per scenario, from the run whose environment can actually answer it.
   *
   * A record whose verdict is NOT_RUN is not an answer, so it never wins. Two
   * real answers that agree are one answer, noted with both environments. Two
   * that disagree are a CONFLICT — not a tie to be broken, because a scenario
   * two environments describe differently is one nobody has established.
   */
  /*
   * Walked in contract order. Every reading has already been checked to carry
   * exactly these, so this cannot silently shrink.
   */
  const ids: readonly string[] = SCENARIOS;
  const combined: {
    id: string;
    title: string;
    verdict: Verdict;
    from: string;
    detail: string;
  }[] = [];

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
    const answered = candidates.filter((entry) => entry.gate.verdict !== 'NOT_RUN');

    if (answered.length === 0) {
      combined.push({
        id,
        title,
        verdict: 'NOT_RUN',
        from: candidates.map((entry) => entry.reading.ranIn).join(' + '),
        detail: candidates.map((entry) => `${entry.reading.ranIn}: ${entry.gate.detail}`).join(' || '),
      });
      continue;
    }

    /*
     * Prefer the run whose environment the gate declares as decisive. Where the
     * declared environment did not answer, a run that did is still evidence —
     * and which one it was is printed, so nobody has to assume.
     */
    const decisive = answered.find(
      (entry) =>
        entry.gate.evidenceFrom === entry.reading.ranIn ||
        entry.gate.evidenceFrom === 'ISOLATED',
    );
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

    const chosen = decisive ?? answered[0]!;
    combined.push({
      id,
      title,
      verdict: chosen.gate.verdict,
      from:
        answered.length > 1
          ? `${answered.map((entry) => entry.reading.ranIn).join(' + ')} (agreed)`
          : chosen.reading.ranIn,
      detail: chosen.gate.detail,
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

/**
 * What Brain can honestly say about itself.
 *
 * ---------------------------------------------------------------------------
 * The one property this suite is really holding
 * ---------------------------------------------------------------------------
 *
 * **Do not infer deployment or live behaviour from code existence.** Every
 * assertion below is a variation on it: a module on disk must not read as
 * connected, a registered contract with no evaluator must not read as a
 * mechanism, a migration file must not read as applied, and a suite whose name
 * Brain can see must not read as passing.
 *
 * The second property is the three-answer column. `NO` is a reading and
 * `UNKNOWN` is the absence of one, and the live instance is evaluation
 * coverage — `tests/` is not in the deployment image, so a deployed Brain
 * genuinely cannot see it. Every test here runs from a checkout where it *can*,
 * so the unreadable case is forced rather than waited for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  DOCS_ROOT,
  observeSystem,
  REPO_ROOT,
  testsVisible,
} from '../server/services/selfmodel/observe.ts';
import {
  componentHistory,
  getComponent,
  latestScan,
  listComponents,
  scanSystem,
} from '../server/services/selfmodel/scan.ts';
import {
  componentKey,
  describeComponent,
  EVIDENCE_LEVELS,
  unknown,
  yes,
} from '../server/services/selfmodel/levels.ts';
import { hasEvaluator } from '../server/services/bins/contracts.ts';
import { COMPLETION_CONTRACTS } from '../server/domain/types.ts';
import { listWorkTypes } from '../server/services/queue/workTypes.ts';
import {
  MAX_READING_AGE_MS,
  readingStaleness,
  scanIfStale,
} from '../server/services/selfmodel/refresh.ts';

describe('the system self-model', () => {
  beforeEach(async () => {
    await freshProject();
  });

  describe('what a reading may and may not claim', () => {
    it('never reads a module on disk as connected', async () => {
      const pass = await observeSystem();
      const modules = pass.components.filter(
        (c) => c.kind === 'SERVICE_MODULE' || c.kind === 'REPOSITORY_MODULE',
      );
      expect(modules.length).toBeGreaterThan(50);

      for (const module of modules) {
        // A module nothing imports looks identical from inside the process to
        // one imported lazily. Claiming either way would be the inference this
        // whole module refuses to make.
        expect(module.readings.CONNECTED?.answer).toBe('UNKNOWN');
        expect(module.readings.IN_SOURCE?.answer).toBe('YES');
      }
    });

    it('reads a migration file and a migration applied as two different facts', async () => {
      const pass = await observeSystem();
      const migrations = pass.components.filter((c) => c.kind === 'MIGRATION');
      expect(migrations.length).toBeGreaterThan(60);
      // A fresh database has applied the whole chain, so every file is deployed.
      for (const migration of migrations) {
        expect(migration.readings.IN_SOURCE?.answer).toBe('YES');
        expect(migration.readings.DEPLOYED?.answer).toBe('YES');
      }

      // Now take one back out of `schema_migrations` — which is exactly what an
      // instance behind its own code looks like — and the reading must change.
      const highest = await getDb().get<{ version: number }>(
        `SELECT MAX(version) AS version FROM schema_migrations`,
      );
      await getDb().run(`DELETE FROM schema_migrations WHERE version = ?`, [
        Number(highest?.version ?? 0),
      ] as never[]);

      const after = await observeSystem();
      const behind = after.components.filter(
        (c) => c.kind === 'MIGRATION' && c.readings.DEPLOYED?.answer === 'NO',
      );
      expect(behind).toHaveLength(1);
      expect(behind[0]?.readings.IN_SOURCE?.answer).toBe('YES');
      expect(behind[0]?.readings.DEPLOYED?.evidence).toMatch(/behind its own code/);
    });

    it('reads a declared contract with no evaluator as unreachable rather than present', async () => {
      // Every contract in the closed set currently has one; the reading is what
      // would notice if one stopped.
      for (const contract of COMPLETION_CONTRACTS) expect(hasEvaluator(contract)).toBe(true);
      expect(hasEvaluator('NOT_A_CONTRACT_V1')).toBe(false);

      const pass = await observeSystem();
      const contracts = pass.components.filter((c) => c.kind === 'BIN_CONTRACT');
      expect(contracts).toHaveLength(COMPLETION_CONTRACTS.length);
      for (const contract of contracts) {
        expect(contract.readings.CONNECTED?.answer).toBe('YES');
        expect(contract.readings.CONNECTED?.evidence).toMatch(/evaluator is registered/);
      }
    });

    it('will not call a work type production-proven on the machinery proving itself', async () => {
      const pass = await observeSystem();
      const types = pass.components.filter((c) => c.kind === 'WORK_TYPE');
      expect(types).toHaveLength(listWorkTypes().length);
      for (const type of types) {
        // A fresh Brain has run nothing.
        expect(type.readings.OBSERVED_ACTIVE?.answer).toBe('NO');
        expect(type.readings.PRODUCTION_PROVEN?.answer).toBe('NO');
        expect(type.readings.PRODUCTION_PROVEN?.evidence).toMatch(/TECHNICAL scope/);
      }
    });

    it('will not say whether a suite passes, only that it exists', async () => {
      const pass = await observeSystem();
      const suites = pass.components.filter((c) => c.kind === 'EVALUATION_SUITE');
      expect(suites.length).toBeGreaterThan(100);
      for (const suite of suites) {
        expect(suite.readings.IN_SOURCE?.answer).toBe('YES');
        // Reading a filename says it exists. It says nothing about green.
        expect(suite.readings.OBSERVED_ACTIVE?.answer).toBe('UNKNOWN');
        expect(suite.readings.OBSERVED_ACTIVE?.evidence).toMatch(/no record of test runs/);
        // And a suite is deliberately not in the deployment image.
        expect(suite.readings.DEPLOYED?.answer).toBe('NO');
      }
    });

    it('will not claim a tool has been called, because no such ledger exists', async () => {
      const pass = await observeSystem();
      const tools = pass.components.filter((c) => c.kind === 'MCP_TOOL');
      expect(tools.length).toBeGreaterThan(20);
      for (const tool of tools) {
        expect(tool.readings.CONNECTED?.answer).toBe('YES');
        expect(tool.readings.OBSERVED_ACTIVE?.answer).toBe('UNKNOWN');
        expect(tool.readings.OBSERVED_ACTIVE?.evidence).toMatch(/no per-tool call ledger/);
      }
    });

    it('names what it could not read rather than leaving it out', async () => {
      const pass = await observeSystem();
      // From a checkout, `tests/` is visible, so that particular unknown does
      // not apply — but the unstamped revision always does in a test process.
      expect(testsVisible()).toBe(true);
      expect(pass.unreadable.join(' ')).toMatch(/no BRAIN_REVISION/);
    });
  });

  describe('scanning', () => {
    it('records a first reading as no drift at all', async () => {
      const report = await scanSystem('BOOT');
      expect(report.components).toBeGreaterThan(100);
      // A component Brain has never seen is not movement. Counting it as drift
      // would make every fresh deployment look like the system changed under
      // itself, which is the reading nobody would then believe.
      expect(report.drift).toEqual([]);
      expect(await listComponents()).toHaveLength(report.components);
    });

    it('records the second scan with zero drift, and still records it', async () => {
      await scanSystem('BOOT');
      const second = await scanSystem('SCHEDULED');
      expect(second.drift).toEqual([]);
      // "We looked and nothing had changed" is a fact worth having and is the
      // answer most of the time, so the scan row is written either way.
      const latest = await latestScan();
      expect(latest?.reason).toBe('SCHEDULED');
      expect(latest?.scanId).toBe(second.scanId);
    });

    it('notices a level moving, and says what read it', async () => {
      await scanSystem('BOOT');
      const highest = await getDb().get<{ version: number }>(
        `SELECT MAX(version) AS version FROM schema_migrations`,
      );
      await getDb().run(`DELETE FROM schema_migrations WHERE version = ?`, [
        Number(highest?.version ?? 0),
      ] as never[]);

      const after = await scanSystem('MIGRATION_APPLIED');
      const moved = after.drift.filter((d) => d.level === 'DEPLOYED');
      expect(moved).toHaveLength(1);
      expect(moved[0]?.from).toBe('YES');
      expect(moved[0]?.to).toBe('NO');
      expect(moved[0]?.evidence).toMatch(/behind its own code/);

      // Two levels move together, and that is the reading being correct rather
      // than the assertion being loose: this observer ties OBSERVED_ACTIVE to
      // the same fact, because applying *is* the only running a migration does.
      const history = await componentHistory(moved[0]?.componentKey as string);
      expect(history.map((entry) => entry.level).sort()).toEqual([
        'DEPLOYED',
        'OBSERVED_ACTIVE',
      ]);
      expect(history.every((entry) => entry.from === 'YES' && entry.to === 'NO')).toBe(true);
    });

    it('keeps a component that vanished rather than deleting it', async () => {
      await scanSystem('BOOT');
      // A component with no observer behind it any more: written directly,
      // because what is being tested is the scan's handling of a key it no
      // longer sees rather than any particular way of losing one.
      const key = componentKey('SERVICE_MODULE', 'server/services/gone.ts');
      const at = new Date().toISOString();
      await getDb().run(
        `INSERT INTO system_components
           (id, component_key, kind, name, detail, documented, in_source, connected, deployed,
            observed_active, evaluated, production_proven, evidence, revision, observed_at,
            created_at, updated_at)
         VALUES (?, ?, 'SERVICE_MODULE', 'server/services/gone.ts', NULL,
                 'NO','YES','UNKNOWN','YES','UNKNOWN','NO','UNKNOWN','{}', NULL, ?, ?, ?)`,
        ['sys_gone', key, at, at, at] as never[],
      );

      const after = await scanSystem('SCHEDULED');
      const vanished = after.drift.find((d) => d.componentKey === key);
      expect(vanished?.level).toBe('IN_SOURCE');
      expect(vanished?.to).toBe('NO');

      // The row stays. A delete would make a disappearance look like progress.
      const still = await getComponent(key);
      expect(still).not.toBeNull();
      expect(still?.answers.IN_SOURCE).toBe('NO');
      expect(still?.evidence.IN_SOURCE).toMatch(/kept rather than deleted/);
    });

    it('stores a level nobody answered as UNKNOWN, never as absent or false', async () => {
      await scanSystem('BOOT');
      for (const component of await listComponents()) {
        for (const level of EVIDENCE_LEVELS) {
          expect(['YES', 'NO', 'UNKNOWN']).toContain(component.answers[level]);
        }
      }
    });

    it('carries the unreadable list onto the scan row', async () => {
      const report = await scanSystem('REQUESTED');
      const latest = await latestScan();
      expect(latest?.unreadable).toEqual(report.unreadable);
      expect(latest?.unreadable.length).toBeGreaterThan(0);
    });

    it('changes nothing outside its own three tables', async () => {
      const before = await Promise.all(
        ['work_items', 'bins', 'documents', 'faculties', 'projects'].map(async (table) => {
          const row = await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
          return [table, Number(row?.n ?? 0)] as const;
        }),
      );
      await scanSystem('BOOT');
      for (const [table, count] of before) {
        const row = await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
        // A self-model that acted on what it saw would be a control loop whose
        // input is its own output, and the first wrong reading would become a
        // decision.
        expect([table, Number(row?.n ?? 0)]).toEqual([table, count]);
      }
    });
  });

  describe('saying it in words', () => {
    it('composes the seven levels rather than scoring them', () => {
      const sentence = describeComponent({
        name: 'RESEARCH_FRAGMENT',
        readings: {
          IN_SOURCE: yes('server/services/queue/workTypes.ts'),
          CONNECTED: yes('in the registry'),
          EVALUATED: unknown('tests/ is not in the image'),
        },
      });
      expect(sentence).toMatch(/IN_SOURCE, CONNECTED/);
      // An unread level is named as unread rather than omitted, because
      // omitting it is how an unread level becomes an assumed one.
      expect(sentence).toMatch(/EVALUATED/);
      expect(sentence).toMatch(/could not be read from here/);
      // And there is no number anywhere in it.
      expect(sentence).not.toMatch(/\d+%/);
    });
  });

  describe('the deployment image', () => {
    it('copies server and client and not tests or docs, which is why two levels are unknowable', () => {
      // The self-model's own justification for its third answer is a fact about
      // the Dockerfile, so it is asserted against the Dockerfile rather than
      // restated in a comment.
      const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
      expect(dockerfile).toMatch(/COPY server \.\/server/);
      expect(dockerfile).not.toMatch(/COPY tests/);
      // And neither `docs/` nor CLAUDE.md, which is what makes DOCUMENTED
      // unreadable from a deployment too. This assertion is the one that would
      // have caught the original defect: `documentedReading` answered NO.
      expect(dockerfile).not.toMatch(/COPY docs/);
      expect(dockerfile).not.toMatch(/COPY CLAUDE\.md/);
    });

    it('answers DOCUMENTED unknown rather than no when nothing is readable', async () => {
      // Forced rather than waited for: every test runs from a checkout where the
      // documents *are* readable, so the deployed case has to be constructed.
      // Without this the defect is invisible until production, where it would
      // have read five hundred components as undocumented.
      const real = fs.readdirSync;
      const hidden = path.resolve(DOCS_ROOT);
      try {
        // Hide `docs/` and CLAUDE.md the way the image does: not there at all.
        vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, options?: unknown) => {
          if (path.resolve(String(dir)) === hidden) throw new Error('ENOENT');
          return (real as unknown as (d: fs.PathLike, o?: unknown) => unknown)(dir, options);
        }) as typeof fs.readdirSync);
        const readFile = fs.readFileSync;
        vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
          if (String(file).endsWith('CLAUDE.md')) throw new Error('ENOENT');
          return (readFile as unknown as (f: fs.PathOrFileDescriptor, o?: unknown) => unknown)(
            file,
            options,
          );
        }) as typeof fs.readFileSync);

        const pass = await observeSystem();
        const sample = pass.components.filter((c) => c.kind === 'WORK_TYPE');
        expect(sample.length).toBeGreaterThan(0);
        for (const component of sample) {
          expect(component.readings.DOCUMENTED?.answer).toBe('UNKNOWN');
          expect(component.readings.DOCUMENTED?.evidence).toMatch(/would turn "we cannot see"/);
        }
        // And the pass names it, rather than leaving a reader to notice.
        expect(pass.unreadable.join(' ')).toContain('neither `docs/` nor `CLAUDE.md`');
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  describe('knowing when the reading is stale', () => {
    it('is stale before anything has ever been read', async () => {
      const staleness = await readingStaleness();
      expect(staleness.stale).toBe(true);
      expect(staleness.reason).toBe('BOOT');
      expect(staleness.detail).toMatch(/No reading has ever been taken/);
    });

    it('stands after a scan, and a second call does nothing', async () => {
      await scanSystem('BOOT');
      expect((await readingStaleness()).stale).toBe(false);
      // `scanIfStale` returning null is the common answer, and is what makes it
      // safe to call from a tick.
      expect(await scanIfStale()).toBeNull();
    });

    it('goes stale when a migration applies that the reading does not hold', async () => {
      await scanSystem('BOOT');
      await getDb().run(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at)
         VALUES (99999, 'a_migration_the_reading_has_not_seen', 'x', ?)`,
        [new Date().toISOString()] as never[],
      );
      const staleness = await readingStaleness();
      expect(staleness.stale).toBe(true);
      expect(staleness.reason).toBe('MIGRATION_APPLIED');
      expect(staleness.detail).toMatch(/have applied/);
    });

    it('goes stale once the reading is older than the floor', async () => {
      await scanSystem('BOOT');
      const later = Date.now() + MAX_READING_AGE_MS + 1_000;
      const staleness = await readingStaleness(later);
      expect(staleness.stale).toBe(true);
      expect(staleness.reason).toBe('SCHEDULED');
    });

    it('does not call an unstamped process a deployment', async () => {
      // A local checkout reading a production row: unknown lineage must do
      // nothing rather than assert a change, or every developer's first tick
      // would rewrite six hundred rows with weaker evidence.
      await scanSystem('BOOT');
      await getDb().run(`UPDATE system_scans SET revision = 'deadbeef'`);
      const staleness = await readingStaleness();
      expect(staleness.reason).not.toBe('DEPLOYMENT');
      expect(staleness.stale).toBe(false);
    });
  });

  it('closes cleanly', async () => {
    await teardown();
  });
});

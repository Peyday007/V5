/**
 * One branch owns production, and the console stays gone.
 *
 * ---------------------------------------------------------------------------
 * What this is really about
 * ---------------------------------------------------------------------------
 *
 * Three branches deployed to one Fly app on one evening and each overwrote the
 * last. `/operator` came back twice — not because anybody re-added it, but
 * because a branch that predated its removal deployed after the branch that
 * removed it. A feature branch reaching production is not a mistake somebody
 * makes once; it is what a dispatchable deploy workflow does by default.
 *
 * So the rule is a file (`.github/CANONICAL_BRANCH`), the workflow reads that
 * file rather than restating the name, and this suite fails if either the rule
 * or the removal it protects is undone.
 *
 * **It is honest about what it cannot prove.** A guard inside a workflow file
 * cannot bind a branch whose copy of that file predates the guard, because
 * `workflow_dispatch` runs the workflow from the ref it is dispatched on. The
 * control that binds every ref is GitHub's deployment branch policy on the
 * `production` environment, which is repository configuration and not code.
 * What this asserts is that the repository half is in place and that nothing
 * has quietly grown a second way to reach production.
 */
import { describe, expect, it } from 'vitest';
import { FETCH_BLOCKED_PORTS } from './helpers/ports.ts';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string): string => fs.readFileSync(path.join(REPO, file), 'utf8');
const tracked = (): string[] =>
  execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);

const CANONICAL = read('.github/CANONICAL_BRANCH').trim();

describe('one branch owns production', () => {
  it('names the canonical branch in exactly one place', () => {
    expect(CANONICAL).toBe('production');
    // The workflow reads the file. A second copy of the name is a second thing
    // to forget to change.
    const deploy = read('.github/workflows/deploy.yml');
    expect(deploy).toContain('.github/CANONICAL_BRANCH');
    expect(deploy).not.toMatch(/ref_name\s*}}"\s*!=\s*"production"/);
  });

  it('refuses a non-canonical ref before anything else in the deploy runs', () => {
    const deploy = read('.github/workflows/deploy.yml');
    // The guard is a job, and every other job depends on it — a guard that runs
    // beside the deploy rather than before it is not a guard.
    expect(deploy).toMatch(/^ {2}canonical:/m);
    expect(deploy).toMatch(/^ {2}verify:\n {4}needs: canonical/m);
    expect(deploy).toMatch(/needs: verify/);
    // And it refuses an outdated checkout of the right branch too, which is the
    // same failure wearing the correct name.
    expect(deploy).toContain('HEAD..origin/$canonical');
  });

  it('leaves exactly one workflow able to deploy', () => {
    /*
     * A *command*, not the phrase.
     *
     * `step12a-acceptance.yml` carries a product owner's authorization ledger
     * verbatim, and one of those sentences contains the words "flyctl deploy".
     * Matching the phrase would fail on a quotation — a check that goes red on
     * correct content teaches people to delete it. A command sits at the start
     * of its own line inside a `run:` block; quoted prose does not.
     */
    const deploying = tracked()
      .filter((f) => f.startsWith('.github/workflows/'))
      .filter((f) => /^\s*flyctl\s+deploy\b/m.test(read(f)));
    expect(deploying).toEqual(['.github/workflows/deploy.yml']);
  });

  it('keeps the deploy behind the production environment, which is what GitHub can enforce', () => {
    const deploy = read('.github/workflows/deploy.yml');
    // The in-workflow guard cannot bind an older branch's copy of itself. The
    // environment can, so the job must stay attached to it.
    expect(deploy).toMatch(/environment: production/);
  });

  it('asks production itself, because the repository being right proved nothing', () => {
    /*
     * The failure this catches was completely silent. The repository was
     * correct the whole time; production was running a build from before the
     * removal, and no suite could see that because a suite reads the
     * repository. Only asking the deployment can.
     */
    const guard = read('.github/workflows/production-guard.yml');
    expect(guard).toContain('/operator');
    expect(guard).toMatch(/schedule:/);
    expect(guard).toMatch(/cron:/);
    // It must not be able to change anything it is watching.
    expect(guard).not.toMatch(/^\s*flyctl\s+deploy\b/m);
    expect(guard).not.toContain('FLY_API_TOKEN');
    /*
     * And it checks the replacement is still there, not only that the old thing
     * is gone — a Brain with neither would pass the first check alone.
     *
     * The evidence is the deployed client bundle, not an API probe. The
     * authentication gate answers before routing, so a path that does not exist
     * returns 401 exactly like one that does; asserting otherwise would be a
     * check that passes on a build with no Connected sites in it.
     */
    expect(guard).toContain("grep -q 'Connected sites'");
    expect(guard).not.toContain('/api/russell/projects/x/sites');
  });

  it('tells a future session the rule, in the file sessions are told to read', () => {
    const claude = read('CLAUDE.md');
    expect(claude).toContain('.github/CANONICAL_BRANCH');
    expect(claude).toMatch(/canonical/i);
    // The rule is an invariant, not only prose.
    expect(claude).toMatch(/^36\. /m);
  });
});

describe('the restart that makes persistence mean something actually runs', () => {
  /*
   * §27 records three consecutive deploys ending `after the restart: skipped`.
   * `flyctl apps restart` waits for health checks with a deadline shorter than
   * this machine's cold start, exits non-zero, and a failing step with no `if:`
   * skips every step after it — so the post-restart verification was not
   * failing, it was not running. A gate that never runs stops being evidence
   * long before anybody notices.
   *
   * Two properties, and the second is the one that keeps the first honest.
   */
  const deploy = read('.github/workflows/deploy.yml');
  const restart = deploy.slice(
    deploy.indexOf('- name: Restart it'),
    deploy.indexOf('- name: Wait for it to answer after the restart'),
  );

  it('tolerates the health-check deadline, because the poll after it is the judge', () => {
    expect(restart).toMatch(/failed to wait for health checks/);
    expect(restart).toMatch(/context deadline exceeded/);
    // And the thing it defers to has to be there, polling from outside the
    // machine rather than asking the machine about itself.
    expect(deploy).toContain('- name: Wait for it to answer after the restart');
    expect(deploy).toMatch(/healthz/);
  });

  it('does not swallow a restart refused for any other reason', () => {
    // A tolerance that matches everything is not a tolerance, it is a removed
    // check — and it would hide a machine that never restarted at all, which is
    // precisely what the step exists to cause.
    expect(restart).not.toMatch(/\|\|\s*true/);
    expect(restart).toMatch(/::error::/);
    expect(restart).toMatch(/exit 1/);
  });
});

describe('a dispatch surface offers the commands it actually accepts', () => {
  /*
   * `admin.yml` carries the command list twice: once as the input's own
   * `description`, which is a label a person reads, and once as a shell
   * allowlist, which is the control. They drifted — `people list` was added to
   * the label and not to the case — so the workflow offered a command it then
   * refused by name, and the one command that could have proved which image was
   * serving was the command that could not be dispatched.
   *
   * It is the same defect this file already refuses one floor down: a rule
   * written in two places is a rule one of the two copies will be missing. The
   * remedy is not to remember, it is to assert they are the same set — and that
   * every member of it is a command the script on the other end of the SSH
   * session actually implements, because an allowlist may only ever *narrow*
   * what `scripts/admin.ts` can do.
   */
  const workflow = read('.github/workflows/admin.yml');

  const offered = (): string[] => {
    const described = /description: '([^']+)'\n\s+required: true/.exec(workflow);
    expect(described).not.toBeNull();
    return (described?.[1] ?? '').split('|').map((one) => one.trim());
  };

  const allowed = (): string[] => {
    const line = workflow
      .split('\n')
      .find((one) => one.includes("') ;;") && one.includes('|'));
    expect(line).toBeDefined();
    return [...(line ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
  };

  it('describes exactly the commands its allowlist admits', () => {
    expect([...offered()].sort()).toEqual([...allowed()].sort());
  });

  it('admits only commands the deployed script implements', () => {
    const script = read('scripts/admin.ts');
    for (const command of allowed()) {
      expect(script, command).toContain(`case '${command}'`);
    }
  });

  /*
   * `capability.yml` is the same surface one door along and is deliberately a
   * different shape: it has no shell allowlist at all, because the closed set
   * already exists in `scripts/capability.ts` and a second copy in YAML would be
   * the drift above waiting to happen. So there is exactly one thing to assert,
   * and it is the half that can still be wrong — the label a person reads must
   * name commands the script on the other end actually implements. A label
   * offering a command that does not exist sends somebody to dispatch a job that
   * fails for a reason that is about the workflow rather than about their Brain.
   */
  const kernel = read('.github/workflows/capability.yml');

  it('offers only kernel commands the deployed script implements', () => {
    const described = /description: '([^']+)'\n\s+required: true/.exec(kernel);
    expect(described).not.toBeNull();
    const script = read('scripts/capability.ts');
    const offeredHere = (described?.[1] ?? '')
      .split('|')
      .map((one) => one.trim().split(/\s+/)[0] as string);
    expect(offeredHere.length).toBeGreaterThan(5);
    for (const command of offeredHere) {
      expect(script, command).toContain(`case '${command}'`);
    }
  });

  it('never puts a dispatch input into the command it sends, and never evals one', () => {
    /*
     * `flyctl ssh console -C` takes ONE command string, and the shell inside
     * the production container runs it. So an input interpolated into that
     * string is not an argument, it is a command — a quote ends the string and
     * everything after it executes. Anyone who can dispatch this can already
     * dispatch `deploy.yml`, so it is not a privilege escalation; it is still a
     * hole, and the *quieter* half is the ordinary quoting bug, because an
     * authority statement is prose and a truncated one is reported as success.
     *
     * The inputs therefore arrive as environment variables and are parsed with
     * `shlex`, which applies shell quoting rules and executes nothing. `eval`
     * is named here because `eval "set -- $ARGS"` is the tidy-looking version
     * of the same hole: it honours quotes and also runs `$(…)`.
     */
    const run = kernel.slice(kernel.indexOf('- name: Run'));
    expect(run).toContain('COMMAND: ${{ inputs.command }}');
    expect(run).toContain('ARGS: ${{ inputs.args }}');
    expect(run).toContain('shlex.quote');
    // Neither input may appear as an interpolation anywhere in the script body.
    const script = run.slice(run.indexOf('run: |'));
    expect(script).not.toContain('${{ inputs.command }}');
    expect(script).not.toContain('${{ inputs.args }}');
    expect(script).not.toMatch(/\beval\b/);
  });

  it('cannot deploy, and says so by containing no deploy command', () => {
    // The floor `leaves exactly one workflow able to deploy` already sets, said
    // again at the surface most likely to grow one: the kernel's job is to read
    // and advance rows, and building an image is not one of its commands.
    expect(kernel).not.toContain('flyctl deploy');
  });
});

describe('and the console it protects stays gone', () => {
  it('has no operator route module, and refuses the path explicitly', () => {
    expect(fs.existsSync(path.join(REPO, 'server/routes/operator.ts'))).toBe(false);
    const index = read('server/index.ts');
    expect(index).not.toContain('operatorRouter');
    expect(index).toMatch(/'\/operator'/);
    expect(index).toMatch(/404/);
  });

  it('would fail if a merge brought the console back with another branch', () => {
    // The exact way it came back twice: a branch that predates the removal is
    // merged or deployed, and nothing notices because the file simply exists
    // again. Anything that reintroduces it fails here.
    for (const file of tracked()) {
      expect(file).not.toBe('server/routes/operator.ts');
    }
    for (const file of tracked().filter((f) => f.startsWith('client/'))) {
      expect(read(file), file).not.toContain('/operator');
    }
  });
});

describe('every workstream is present in the canonical tree', () => {
  /*
   * Converging three branches is only safe if the convergence is checked. Each
   * of these is a file one branch owned and the others did not, so a merge that
   * dropped a workstream fails here rather than in production.
   */
  const MUST_EXIST: Record<string, string[]> = {
    'Step 12A': [
      'server/services/dispatch/lineageRecovery.ts',
      'server/services/russell/needsHuman.ts',
      'server/db/migrations/035_worker_sessions.sql',
      'scripts/step12a-acceptance.ts',
    ],
    'Website Connection': [
      'server/routes/connect.ts',
      'server/services/connect/sites.ts',
      'server/repos/externalRecords.ts',
      'server/domain/jurisdiction.ts',
      'server/db/migrations/036_external_records.sql',
    ],
    'Software Factory': [
      'server/routes/factory.ts',
      'server/repos/factory.ts',
      'server/repos/factoryFleet.ts',
      'server/services/factory/loop.ts',
      'scripts/factory.ts',
      'server/db/migrations/037_software_factory.sql',
      'server/db/migrations/038_factory_repository_root.sql',
    ],
  };

  for (const [workstream, files] of Object.entries(MUST_EXIST)) {
    it(`still has ${workstream}`, () => {
      for (const file of files) {
        expect(fs.existsSync(path.join(REPO, file)), file).toBe(true);
      }
    });
  }

  /*
   * The Software Factory's amendment ledger, checked rather than assumed.
   *
   * Its commit was called "the amendment ledger gets an operator entrance",
   * which reads alarmingly next to a console that was being deleted the same
   * night. It is not that: "operator" there means the person, and the entrance
   * is `scripts/factory.ts`. So it already sits the way §26 prescribes — the
   * reading on a normal API surface, the mutation on a terminal — and this
   * pins that rather than trusting the reading of one commit message.
   */
  it('keeps the factory amendment ledger readable over the API and writable only from a terminal', () => {
    const routes = read('server/routes/factory.ts');
    expect(routes).toContain('listAmendments');
    expect(routes).toMatch(/'\/factory\/change-requests\/:changeRequestId'/);
    // Reading only: no HTTP route mutates an amendment.
    expect(routes).not.toContain('amendContract');

    const cli = read('scripts/factory.ts');
    expect(cli).toContain('amendContract');

    // And the service still refuses what it always refused.
    const contract = read('server/services/factory/contract.ts');
    expect(contract).toContain('recordAmendment');
  });

  it('has one migration chain per backend, numbered without a gap or a collision', () => {
    for (const [dir, kind] of [
      ['server/db/migrations', 'SQLite'],
      ['server/db/pg-migrations', 'Postgres'],
    ] as const) {
      const versions = fs
        .readdirSync(path.join(REPO, dir))
        .filter((f) => f.endsWith('.sql'))
        .map((f) => Number(f.slice(0, 3)))
        .sort((a, b) => a - b);
      expect(versions.length, kind).toBeGreaterThan(0);
      expect(new Set(versions).size, `${kind} has a duplicate number`).toBe(versions.length);
      for (let i = 1; i < versions.length; i += 1) {
        expect(versions[i]! - versions[i - 1]!, `${kind} jumps at ${versions[i]}`).toBe(1);
      }
    }
  });
  /**
   * A suite that drives a real server binds a port, and `/healthz` is
   * deliberately unauthenticated — so a colliding port does not fail loudly.
   * The second suite's readiness probe finds the *first* suite's server, waits
   * happily for it, and then signs in against a Brain that has a different
   * bootstrap administrator. What it reports is `401`, which reads as a broken
   * sign-in rather than as two suites sharing a number.
   *
   * That is the same shape as the migration collision directly above: two
   * parallel workstreams picking a number, with nothing in either one able to
   * see the other's choice. It happened — `mcp`, `idempotencyHttp` and
   * `russellHttp` held the identical range, and four more pairs overlapped —
   * and it cost a full-suite run before the cause was legible.
   */
  /**
   * Every suite that starts a server declares a range, and two properties of
   * that range are checked here because both have cost real runs.
   */
  const portRanges = (): { file: string; from: number; to: number }[] => {
    const pattern = /const PORT = pickPort\((\d+), (\d+)\);/;
    const ranges: { file: string; from: number; to: number }[] = [];
    for (const file of tracked().filter((f) => f.startsWith('tests/') && f.endsWith('.ts'))) {
      const match = pattern.exec(read(file));
      if (!match) continue;
      const from = Number(match[1]);
      ranges.push({ file, from, to: from + Number(match[2]) - 1 });
    }
    return ranges.sort((a, b) => a.from - b.from);
  };

  it('gives every HTTP suite a port range no other suite can reach', () => {
    const ranges = portRanges();
    expect(ranges.length, 'no suite declares a port at all').toBeGreaterThan(5);

    for (let i = 1; i < ranges.length; i += 1) {
      const earlier = ranges[i - 1]!;
      const later = ranges[i]!;
      expect(
        later.file,
        `${later.file} (${later.from}-${later.to}) can collide with ${earlier.file} (${earlier.from}-${earlier.to})`,
      ).toSatisfy(() => later.from > earlier.to);
    }
  });

  it('lets every suite pick its port through the helper that skips blocked ones', () => {
    /*
     * `fetch` refuses a **bad port** before it opens a socket, so a suite that
     * picked one would poll a perfectly healthy server until its deadline and
     * then report "server never became healthy" — which is false, and cost
     * three full runs to find. `factoryPersistence` drew 6665, 6668 and 6666 on
     * the three occasions it failed.
     *
     * So the shape is pinned rather than the behaviour: a raw
     * `base + Math.random()` cannot be checked for this and must not come back.
     */
    for (const file of tracked().filter((f) => f.startsWith('tests/') && f.endsWith('.test.ts'))) {
      const source = read(file);
      expect(
        source,
        `${file} picks a port without asking whether fetch will dial it`,
      ).not.toMatch(/const PORT = \d+ \+ Math\.floor\(Math\.random/);
    }
  });

  it('refuses a range with no usable port in it at all', () => {
    /*
     * The helper throws on a fully blocked range, which is right — but a range
     * that is *mostly* blocked is the dangerous one, because it works nine
     * times in ten. This reads the list and says so at the range level.
     */
    for (const range of portRanges()) {
      const blocked = [...FETCH_BLOCKED_PORTS].filter(
        (port) => port >= range.from && port <= range.to,
      );
      const usable = range.to - range.from + 1 - blocked.length;
      expect(
        usable,
        `${range.file} (${range.from}-${range.to}) has only ${usable} port(s) fetch will dial`,
      ).toBeGreaterThan(50);
    }
  });
});

describe('and the log surface reads, and only reads', () => {
  /*
   * `logs.yml` exists because the only way to read production's log was to
   * deploy — `deploy.yml` runs `flyctl logs` twice, as diagnosis attached to a
   * deploy — and a deploy replaces the machine, which is how you lose the log
   * you came for. So the surface is worth having and is worth being exactly one
   * thing.
   *
   * "Strictly read-only" is a claim, and a claim about a file is a test that
   * reads the file. It is pinned as a closed set of `flyctl` subcommands rather
   * than as a list of things it must not say, because a ban is complete only
   * against the commands somebody thought of, and this one must stay complete
   * against the ones added later.
   */
  const logs = read('.github/workflows/logs.yml');
  /** The commands, without the prose above them. */
  const BODY = logs.slice(logs.indexOf('run: |'));

  it('runs no flyctl subcommand that could change anything', () => {
    /*
     * Exact command forms rather than bare subcommands, because one of these
     * has mutating siblings under the same first word: `secrets list` reads,
     * and `secrets set`, `secrets unset` and `secrets import` each replace a
     * deployment secret and restart the machine. A set holding `secrets` would
     * admit all four, so what is allowed is the whole command.
     */
    const READS = new Set(['logs', 'status', 'secrets list']);
    const used = [...logs.matchAll(/flyctl\s+([a-z-]+(?:\s+[a-z-]+)?)/g)].map((m) => m[1] ?? '');
    expect(used.length).toBeGreaterThan(0);
    for (const one of used) {
      // A flag is not a second word: `flyctl logs --app` is `logs`. Anything
      // whose first word is not itself a complete read has to match in full.
      const head = one.split(' ')[0] ?? '';
      const ok = READS.has(one) || READS.has(head);
      expect(ok, `logs.yml runs "flyctl ${one}"`).toBe(true);
    }
  });

  it('never writes a deployment secret', () => {
    // Named separately from the set above, so the one command that could
    // restart production from this surface fails by its own name rather than
    // as a set membership somebody could widen without noticing.
    for (const verb of ['secrets set', 'secrets unset', 'secrets import']) {
      expect(BODY, `logs.yml runs "flyctl ${verb}"`).not.toContain(verb);
    }
  });

  it('prints secret names and never a value or a digest', () => {
    // `flyctl secrets list` prints NAME, DIGEST, CREATED AT. A digest is not
    // recoverable, and it is still derived from a secret and has no reader
    // here — §17's rule is about what reaches a log, not about what could be
    // reversed out of it. Only the name column crosses.
    expect(BODY).toMatch(/secrets list[^\n]*\|[^\n]*awk/);
  });

  it('has no way into the machine and no script to run there', () => {
    /*
     * `ssh console` is how every *writing* workflow on this repository reaches
     * the Brain. The absence of it is what makes the subcommand set above a
     * boundary rather than a preference.
     *
     * Asked of the **script body** rather than of the file, for
     * `operatorConsoleRemoved`'s reason: a comment saying "there is no ssh
     * console here, and that is the point" is the kind of prose this repository
     * keeps, and a check that went red on it would be teaching somebody to
     * delete the explanation instead of the command.
     */
    expect(BODY).not.toContain('ssh');
    expect(BODY).not.toContain('scripts/');
    expect(BODY).not.toContain('curl');
  });

  it('lets no input reach a shell', () => {
    expect(BODY).not.toContain('${{ inputs.');
    expect(BODY).not.toMatch(/\beval\b/);
    // Both inputs are compared against a closed class before they are used.
    expect(BODY).toContain('seconds must be a whole number');
    expect(BODY).toContain('pattern must be one of');
  });
});

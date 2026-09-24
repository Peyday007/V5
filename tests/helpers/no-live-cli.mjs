#!/usr/bin/env node
/*
 * What `BRAIN_FACTORY_CLI` points at for the whole test suite.
 *
 * The factory's local executor spawns the Claude CLI, and a developer machine
 * or a cloud session usually has one on PATH, authenticated as *that person*.
 * A test that reached a real spawn would therefore make a live model call on a
 * credential that belongs to nobody's test plan — and would pass or fail on
 * whether somebody happened to be signed in. So every spawn in a test lands
 * here instead, fails, and says so on stderr, where the suite's output is read.
 * A test that genuinely needs a CLI sets `BRAIN_FACTORY_CLI` to its own stub.
 */
process.stderr.write(
  `no-live-cli: a test tried to run the Claude CLI (${process.argv.slice(2).join(' ') || 'no arguments'}). ` +
    'Tests must never make a live model call; point BRAIN_FACTORY_CLI at a stub.\n',
);
process.exit(97);

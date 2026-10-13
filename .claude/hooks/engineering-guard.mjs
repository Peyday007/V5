#!/usr/bin/env node
/**
 * The engineering policy's hard edges, as a Claude Code PreToolUse hook.
 *
 * Deliberately tiny: the policy lives in Brain (`server/domain/engineering.ts`,
 * the `brain_*engineering*` MCP tools and `npm run engineering`). This refuses
 * only the two behaviours a prompt kept failing to stop, and names the way past
 * each so a justified case is never stuck:
 *
 *   1. A full test suite on an intermediate commit. Allowed with
 *      BRAIN_FULL_GATE=1 in front of the command — the release SHA, once.
 *   2. A delayed check-in (send_later) of under 45 minutes, which is almost
 *      always a command that could simply be watched. Allowed when the message
 *      says NOT_OBSERVABLE, i.e. there is genuinely nothing to watch.
 *
 * Exit 2 blocks the call and hands stderr to Claude as the reason.
 *
 * Both checks used to be unreachable or easy to walk past (FAC-8, FAC-9): the
 * send_later branch compared against `mcp__Claude_Code_Remote__send_later`
 * while the tool is actually `mcp__claude-code-remote__send_later`, and the
 * full-suite check was one anchored regex that `npx vitest run --reporter dot`
 * and `scripts/test-postgres.sh run -- npx vitest run` both slipped past. The
 * rule is now stated as what it means — a vitest or `npm test` invocation that
 * names no file or filter — rather than as one spelling of it.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Tokens a command can be run through without changing what it runs. */
const LAUNCHERS = new Set(['npx', 'pnpm', 'yarn', 'bunx', 'exec', 'time', 'nohup', 'env', 'nice']);

/** Vitest options that take the next token as their value. */
const VALUE_OPTIONS = new Set([
  '--reporter', '-r', '--config', '-c', '--root', '--dir', '--pool', '--maxWorkers', '--minWorkers',
  '--outputFile', '--testTimeout', '--hookTimeout', '--retry', '--environment', '--mode',
  '--sequence.seed', '--poolOptions', '--coverage.provider', '--silent',
]);

/**
 * Options that narrow what runs as much as a file does. A shard, a project or
 * a test-name filter is not "the whole suite on an intermediate commit".
 */
const NARROWING_OPTIONS = /^(--shard|--project|-t|--testNamePattern|--changed|--related)(=|$)/;

export function tokenize(segment) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started || current) tokens.push(current);
  return tokens;
}

/** Whether the token at `index` is in command position (not an argument to grep and the like). */
function inCommandPosition(tokens, index) {
  if (index === 0) return true;
  const before = tokens[index - 1];
  // `wrapper run -- <command…>`: what follows a bare `--` is a command of its own.
  if (before === '--') return true;
  // A launcher counts only when it is itself the command: `echo npx vitest run` runs echo.
  if (LAUNCHERS.has(before)) return inCommandPosition(tokens, index - 1);
  // `timeout 600 npx vitest run`
  if (/^\d+[smh]?$/.test(before) && tokens[index - 2] === 'timeout') return inCommandPosition(tokens, index - 2);
  // `env A=1 npx …` after the leading assignments were stripped
  if (/^\w+=/.test(before)) return true;
  return false;
}

/** The arguments after an invocation name no file, filter, shard or project. */
function namesNothing(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') continue;
    // Redirections are the shell's, not vitest's: `2>&1`, `>out.txt`, `> out.txt`.
    if (/^(\d*|&)(>>?|<)$/.test(arg)) {
      i += 1;
      continue;
    }
    if (/^(\d*|&)(>>?|<)/.test(arg)) continue;
    if (NARROWING_OPTIONS.test(arg)) return false;
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && VALUE_OPTIONS.has(arg)) i += 1;
      continue;
    }
    if (/^\d+$/.test(arg)) continue;
    return false; // a positional: a file or a filter
  }
  return true;
}

/** True when one segment of a shell command runs the whole suite. */
export function isFullSuite(segment) {
  const tokens = tokenize(segment.trim());
  while (tokens.length && /^\w+=\S*$/.test(tokens[0])) tokens.shift();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!inCommandPosition(tokens, i)) continue;
    if (token === 'vitest' || /\/vitest(\.mjs)?$/.test(token)) {
      let args = tokens.slice(i + 1);
      if (args[0] === 'run') args = args.slice(1);
      else if (args[0] && !args[0].startsWith('-')) continue; // `vitest list`, `vitest related` …
      if (namesNothing(args)) return true;
    }
    if (token === 'npm') {
      let args = tokens.slice(i + 1);
      if (args[0] === 'run' || args[0] === 'run-script') {
        if (args[1] !== 'test') continue; // `npm run test:impacted` and every other script
        args = args.slice(2);
      } else if (args[0] === 'test' || args[0] === 't') {
        args = args.slice(1);
      } else continue;
      if (namesNothing(args)) return true;
    }
  }
  return false;
}

/** The send_later tool, under either spelling of the server name. */
export function isSendLater(tool) {
  return /^mcp__claude[-_]code[-_]remote__send_later$/i.test(tool);
}

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  const tool = event.tool_name ?? '';
  const input = event.tool_input ?? {};

  if (tool === 'Bash') {
    const command = String(input.command ?? '');
    if (/BRAIN_FULL_GATE=1/.test(command)) process.exit(0);
    // Each segment of a compound command is judged on its own.
    for (const segment of command.split(/&&|\|\||;|\||\n/)) {
      if (isFullSuite(segment)) {
        refuse(
          'ENGINEERING POLICY (rule 3): a full suite on an intermediate commit is refused. Run ' +
            '`npm run typecheck && npm run test:impacted` (or `npx vitest run <files>`), or ask ' +
            '`npm run engineering -- policy --paths <changed>` / brain_test_policy. If this is the ' +
            'release SHA and it has no valid full-gate PASS, prefix the command with BRAIN_FULL_GATE=1.',
        );
      }
    }
  }

  if (isSendLater(tool)) {
    const minutes = Number(input.delay_minutes ?? 0);
    const message = String(input.message ?? '');
    if (minutes > 0 && minutes < 45 && !/NOT_OBSERVABLE/.test(message)) {
      refuse(
        'ENGINEERING POLICY (rule 4): do not schedule a check-in for something you can watch. Run it in ' +
          'the background and react when it ends, or poll it directly. If it genuinely cannot be ' +
          'observed from here, include NOT_OBSERVABLE in the message.',
      );
    }
  }

  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

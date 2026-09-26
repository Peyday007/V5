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
 */
import { readFileSync } from 'node:fs';

let event;
try {
  event = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
const tool = event.tool_name ?? '';
const input = event.tool_input ?? {};

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

if (tool === 'Bash') {
  const command = String(input.command ?? '');
  if (/BRAIN_FULL_GATE=1/.test(command)) process.exit(0);
  // Each segment of a compound command is judged on its own.
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const words = segment.trim().replace(/^(\w+=\S+\s+)+/, '');
    const fullNpm = /^npm (run )?test\s*$/.test(words) || /^npm (run )?test\s+--\s*$/.test(words);
    const vitest = /^(npx )?vitest run(\s+--[\w-]+(=\S+)?)*\s*$/.test(words);
    if (fullNpm || vitest) {
      refuse(
        'ENGINEERING POLICY (rule 3): a full suite on an intermediate commit is refused. Run ' +
          '`npm run typecheck && npm run test:impacted` (or `npx vitest run <files>`), or ask ' +
          '`npm run engineering -- policy --paths <changed>` / brain_test_policy. If this is the ' +
          'release SHA and it has no valid full-gate PASS, prefix the command with BRAIN_FULL_GATE=1.',
      );
    }
  }
}

if (tool === 'mcp__Claude_Code_Remote__send_later') {
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

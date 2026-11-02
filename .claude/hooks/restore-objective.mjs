#!/usr/bin/env node
/**
 * Put the owner's own words back after a compaction.
 *
 * Measured, 2026-11-01: the "Brain V5 AI throughput expansion" session ran past
 * its 1M-token window, the owner's next message failed with "Prompt is too
 * long", and the automatic summary that replaced the conversation recorded the
 * original assignment as "(Earlier truncated task message about throughput
 * expansion — not visible.)". The Magic Deck session's summary said the
 * earliest part "is NOT covered by this summary", and the mechanism-construction
 * session's summaries marked unfinished requests "(completed)". Each session
 * then worked from a paraphrase, and the assignment's completion standard was
 * gone.
 *
 * A summary is a model's paraphrase; the transcript file on disk still holds
 * every message the person actually typed (`origin.kind: "human"`). This
 * SessionStart hook (sources `compact` and `resume`) reads it, writes all of
 * those messages whole to `owner-words.md` beside the transcript, and injects
 * them verbatim — cut to Claude Code's 10,000-character cap on hook context,
 * with an instruction to read the file when anything was cut.
 *
 * It blocks nothing and never fails the session: any error is a silent exit 0.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FIRST_LIMIT = 6_000;
export const LATER_LIMIT = 1_200;
export const LATER_COUNT = 3;
/** Under Claude Code's 10,000-character cap on injected hook context. */
export const INJECT_LIMIT = 9_500;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    if (content.some((part) => part && part.type === 'tool_result')) return null;
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  return null;
}

/** True for a message a person typed, as opposed to a tool result, a notice or a summary. */
export function isHumanMessage(entry) {
  if (!entry || entry.type !== 'user' || entry.isMeta || entry.isCompactSummary) return false;
  const origin = entry.origin && entry.origin.kind;
  if (origin && origin !== 'human') return false;
  const text = textOf(entry.message && entry.message.content);
  if (!text || !text.trim()) return false;
  if (text.startsWith('This session is being continued from a previous conversation')) return false;
  // Older transcripts carry no origin: drop the notices the harness writes as user turns.
  if (!origin && /^\s*<(task-notification|command-|local-command|system-reminder)/.test(text)) return false;
  return true;
}

export function humanMessages(jsonl) {
  const out = [];
  const seen = new Set();
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isHumanMessage(entry)) continue;
    const text = textOf(entry.message.content).trim();
    // A prompt retried after "Prompt is too long" is one instruction, not two.
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ at: entry.timestamp ?? '', text });
  }
  return out;
}

function clip(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[… ${text.length - limit} more characters: read the full file …]`;
}

/** Every message, whole: what `owner-words.md` holds. */
export function composeFull(messages) {
  return messages
    .map((m, i) => `--- ${i === 0 ? 'ORIGINAL ASSIGNMENT' : 'LATER MESSAGE FROM THE OWNER'} (${m.at}) ---\n${m.text}`)
    .join('\n\n');
}

export function composeReminder(messages, fullPath = null) {
  if (messages.length === 0) return '';
  const [first, ...rest] = messages;
  const later = rest.slice(-LATER_COUNT);
  const skipped = rest.length - later.length;
  const cut =
    first.text.length > FIRST_LIMIT || skipped > 0 || later.some((m) => m.text.length > LATER_LIMIT);
  const where = fullPath ?? 'the session transcript';
  const parts = [
    "THE OWNER'S OWN WORDS, RESTORED VERBATIM AFTER CONTEXT COMPACTION.",
    'The summary above is a paraphrase. Where it and these messages disagree, these messages are the assignment.',
    'Re-read the completion requirements and continue until every one is met, or stop only for a reason',
    'CLAUDE.md lets you stop for. A summary saying a request was "completed" is not evidence that it was.',
  ];
  if (cut) parts.push(`Some text below is cut. Read ${where} in full (Read tool) before doing anything else.`);
  parts.push('', `--- ORIGINAL ASSIGNMENT (${first.at}) ---`, clip(first.text, FIRST_LIMIT));
  if (skipped > 0) parts.push('', `(${skipped} earlier follow-up message(s) are only in ${where})`);
  for (const message of later) {
    parts.push('', `--- LATER MESSAGE FROM THE OWNER (${message.at}) ---`, clip(message.text, LATER_LIMIT));
  }
  const out = parts.join('\n');
  return out.length <= INJECT_LIMIT ? out : `${out.slice(0, INJECT_LIMIT)}\n[… cut to fit; read ${where}]`;
}

/** Where the whole text is written: a folder beside the transcript, named after it. */
export function ownerWordsPath(transcriptPath) {
  return path.join(transcriptPath.replace(/\.jsonl$/, ''), 'owner-words.md');
}

export function run(event) {
  const source = event.source ?? '';
  if (source !== 'compact' && source !== 'resume') return '';
  const transcriptPath = event.transcript_path;
  if (!transcriptPath) return '';
  const messages = humanMessages(readFileSync(transcriptPath, 'utf8'));
  if (messages.length === 0) return '';
  let fullPath = null;
  try {
    fullPath = ownerWordsPath(transcriptPath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `${composeFull(messages)}\n`);
  } catch {
    fullPath = null;
  }
  const reminder = composeReminder(messages, fullPath);
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: reminder } });
}

function main() {
  try {
    const out = run(JSON.parse(readFileSync(0, 'utf8')));
    if (out) process.stdout.write(out);
  } catch {
    /* never fail a session over a reminder */
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

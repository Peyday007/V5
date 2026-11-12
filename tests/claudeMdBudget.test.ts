/**
 * CLAUDE.md stays small, and nothing it held was lost when it shrank.
 *
 * Claude Code loads CLAUDE.md whole into every session. It grew from 19 KB
 * (2026-08-20) to 1 MB (2026-11-02), so a fresh session started at ~411k tokens
 * of its 1M window before it read the request; long assignments then overflowed
 * ("Prompt is too long" on the owner's next message) and compaction summaries
 * lost the assignment's own completion requirements. The detail now lives in
 * docs/ARCHITECTURE-RECORD.md under the same section numbers.
 * See docs/CLAUDE-CODE-INCOMPLETE-ASSIGNMENTS-2026-11-02.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** About 10k tokens. Raising it is a decision somebody reviews, not a way round it. */
const CLAUDE_MD_BUDGET_CHARS = 40_000;

describe('CLAUDE.md budget', () => {
  it('fits its budget: detail belongs in docs/ARCHITECTURE-RECORD.md', () => {
    expect(read('CLAUDE.md').length).toBeLessThanOrEqual(CLAUDE_MD_BUDGET_CHARS);
  });

  it('keeps every numbered section somewhere, and indexes each one the record holds', () => {
    const claude = read('CLAUDE.md');
    const record = read('docs/ARCHITECTURE-RECORD.md');
    const inClaude = [...claude.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
    const inRecord = [...record.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
    const all = [...inClaude, ...inRecord].sort((a, b) => a - b);
    // 1..N with no gap and no section in both places.
    expect(all).toEqual(all.map((_, i) => i + 1));
    for (const n of inRecord) expect(claude).toMatch(new RegExp(`^- §${n}\\. `, 'm'));
  });

  it('carries the finishing contract and a status word that cannot say DONE when it is not', () => {
    const claude = read('CLAUDE.md');
    expect(claude).toContain('## Finishing an assignment');
    expect(claude).toContain('**NOT DONE**');
    expect(claude).toContain('Always merge it on your own, never make me merge it.');
    // The old template opened every final report with DONE, finished or not.
    expect(claude).not.toMatch(/The final report is four short parts and nothing else: \*\*DONE\*\*/);
  });
});

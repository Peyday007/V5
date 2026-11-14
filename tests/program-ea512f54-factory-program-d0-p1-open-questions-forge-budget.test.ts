/**
 * GOV-11 register pass must not spend the forge budget factory verification
 * needs: the register at a fixed revision is read once, and a read the forge
 * did not answer (a spent rate limit) is "not read this pass", never BEHIND.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  REGISTER_EVENT_KINDS,
  checkRegisterOnProduction,
  readRegisterOnce,
  reconcileRegister,
  type RegisterEvent,
  type RegisterPassPorts,
  type RegisterRead,
  type RegisterReadAt,
} from '../server/services/goals/openQuestions.ts';
import { extractSourceItems } from '../server/services/factory/program/spec.ts';

// Release 01's two §11 source items, as the program stores them.
const SOURCE = `# 11. Decisions and open questions

Decisions established by the owner - Financial milestones such as 10K/100K/1M are examples, not
hard-coded progressions. - Near-term collected-money objectives matter, but substantial reinvestment is
expected during the build phase. - Different businesses are permitted to have different extraction, growth and
creative-funding roles. - The range of commercial possibilities must not be limited to Brain’s database or to
presently fashionable AI services. - Ideas should morph repeatedly, combine across markets and generate
new opportunities from their own transformed elements. - The user will continue adding and refining the
architecture; preserve the unabridged intent. - Avoid repeated rhetorical restatements and oversimplified
explanations. Engage at a technical and strategic level.

To define as the user continues - Exact mechanics and representation of the ‘thinking map’ and
idea-transforming operations. - What degree of novelty/diversity is useful, and how the system should
prioritize emerging branches. - Capital-governance policies and financial structures for differing business
archetypes. - How aggressively future objectives may consume scarce resources from present obligations. -
Exact target levels for concurrent research throughput, worker utilization and minimum exploration. - Full
product interaction and visualization requirements. - Calibration/decision rules for optional or mandatory
confidence thresholds in future goals.
`;
const REGISTER = readFileSync('docs/programs/brain-architecture/OPEN-QUESTIONS-REGISTER.md', 'utf8');
const RATE_LIMITED = { ok: false, body: null, reason: "The forge's read rate limit is spent until 2026-11-14T01:15:40Z" };

describe('GOV-11 register pass and the forge budget', () => {
  it('reads the register at one revision through the forge once, however many passes run', async () => {
    let reads = 0;
    const readAt: RegisterReadAt = async () => { reads += 1; return { ok: true, body: 'text', reason: null }; };
    const cache = new Map<string, RegisterRead>();
    for (let pass = 0; pass < 12; pass += 1) expect((await readRegisterOnce('rev-a', readAt, cache)).text).toBe('text');
    expect(reads).toBe(1);
    await readRegisterOnce('rev-b', readAt, cache);
    expect(reads).toBe(2);
  });

  it('keeps a definite 404 but asks again after a failed read', async () => {
    const replies = [RATE_LIMITED, { ok: true, body: null, reason: null }];
    let reads = 0;
    const readAt: RegisterReadAt = async () => replies[Math.min(reads++, replies.length - 1)]!;
    const cache = new Map<string, RegisterRead>();
    const first = await readRegisterOnce('rev', readAt, cache);
    expect(first.unread).toContain('rate limit');
    const second = await readRegisterOnce('rev', readAt, cache);
    expect(second).toMatchObject({ text: null });
    expect(second.unread).toBeUndefined();
    await readRegisterOnce('rev', readAt, cache);
    expect(reads).toBe(2);
  });

  it('records no BEHIND for a rate-limited read, so CURRENT does not churn', async () => {
    const items = extractSourceItems(SOURCE);
    const events: RegisterEvent[] = [];
    let limited = false;
    const ports: RegisterPassPorts = {
      check: () => checkRegisterOnProduction({
        loadItems: async () => ({ items, where: 'program' }),
        readRegister: async () => limited
          ? { text: null, where: 'register@rev', unread: RATE_LIMITED.reason }
          : { text: REGISTER, where: 'register@rev' },
      }),
      latest: async () => events.at(-1) ?? null,
      record: async (kind, detail) => { events.push({ kind, detail }); },
    };
    expect((await reconcileRegister(ports)).recorded).toBe(REGISTER_EVENT_KINDS.current);
    limited = true;
    const pass = await reconcileRegister(ports);
    expect(pass.recorded).toBeNull();
    expect(pass.detail).toContain('not read this pass');
    limited = false;
    expect((await reconcileRegister(ports)).recorded).toBeNull();
    expect(events.map((e) => e.kind)).toEqual([REGISTER_EVENT_KINDS.current]);
  });
});

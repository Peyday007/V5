// @vitest-environment jsdom
/**
 * The rendered document shows the reason, the binding limit, what is missing,
 * what would reopen it and what supports it — in words, with no score or
 * percentage — and a piece with no explanation renders nothing extra.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DecisionExplained, StandingLine } from '../client/src/russell/CashStanding.tsx';
import type { DecisionExplanation } from '../client/src/lib/cashDecision.ts';
import type { CashPage } from '../client/src/russell/cashPage.ts';

afterEach(cleanup);

function pageWith(explanation: DecisionExplanation): CashPage {
  return {
    full: { myCurrentWork: { placements: [], standingSurface: { explanations: { op1: explanation } } } },
    frontier: { opportunities: [], standing: undefined },
  } as unknown as CashPage;
}

/** The server composes these; the client test uses literals so it never loads server code. */
const HELD: DecisionExplanation = {
  stance: 'HELD',
  headline: 'Held: it waits on something named.',
  reason: 'It cannot move until the missing fact "payer" on its card is settled.',
  bindingLimit: 'The limit that binds is the missing fact "payer" on its card.',
  missing: ['the missing fact "payer" on its card'],
  reopenWhen: ['the missing fact "payer" on its card is settled'],
  evidence: ['The opening came from a sourced claim that is recorded with its passage.'],
  furtherResearch: 'One narrow factual question would settle it; it costs fleet time, not money.',
};
const REJECTED: DecisionExplanation = {
  stance: 'REJECTED',
  headline: 'Rejected: stopped, and nothing named would reopen it.',
  reason: 'Its closing date has passed.',
  bindingLimit: 'Its closing date has passed.',
  missing: [],
  reopenWhen: [],
  evidence: ['No sourced claim is recorded for this opening.'],
  furtherResearch: 'None; no answer to any question would change this.',
};

describe('the decision, rendered', () => {
  it('shows every question in words, with no score or percentage', () => {
    const e = HELD;
    const { container } = render(<DecisionExplained page={pageWith(e)} id="op1" />);
    for (const label of ['Why', 'What binds it', 'What is missing', 'What would reopen it', 'What supports it', 'What more research would cost']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(container.textContent).toContain('Held');
    expect(container.textContent).toContain('payer');
    expect(container.textContent).not.toMatch(/%|\bscore\b/i);
    expect(container.textContent).not.toMatch(/\d/);
  });

  it('renders nothing for a piece with no explanation', () => {
    const e = HELD;
    const { container } = render(<DecisionExplained page={pageWith(e)} id="nobody" />);
    expect(container.textContent).toBe('');
  });

  it('puts the explanation under the standing line in the portfolio list', () => {
    const e = REJECTED;
    const page = {
      full: {
        myCurrentWork: {
          placements: [{ opportunity: { id: 'op1' }, standing: { kind: 'NOT_WORTH_PURSUING', because: 'It closed.' }, because: '' }],
          standingSurface: { explanations: { op1: e } },
        },
      },
      frontier: { opportunities: [] },
    } as unknown as CashPage;
    const { container } = render(<StandingLine page={page} id="op1" />);
    expect(container.textContent).toContain('It closed.');
    expect(container.textContent).toContain('Rejected');
    expect(container.textContent).toContain('closing date');
  });
});

/**
 * Reading a piece's decision off the payload the server already composed.
 *
 * The server wrote every sentence (`explainStanding`); this file only chooses
 * which of the two payloads a reader has and lays the answer out as labelled
 * lines. It derives nothing and adds no number: a decision is read in words.
 */
import type { CashPage } from '../russell/cashPage.ts';
import type { DecisionExplanation } from '../../../server/services/cash/standingSurface.ts';

export type { DecisionExplanation };

export function explanationFor(page: CashPage, id: string): DecisionExplanation | null {
  return (
    page.full?.myCurrentWork.standingSurface?.explanations?.[id] ??
    page.frontier.standing?.explanations?.[id] ??
    null
  );
}

export interface DecisionLine {
  label: string;
  text: string;
}

/** The labelled lines a person reads, in the order they ask the questions. */
export function decisionLines(e: DecisionExplanation): DecisionLine[] {
  const lines: DecisionLine[] = [
    { label: 'Why', text: e.reason },
    { label: 'What binds it', text: e.bindingLimit },
    {
      label: 'What is missing',
      text: e.missing.length > 0 ? e.missing.join('; ') + '.' : 'Nothing is recorded as missing.',
    },
    {
      label: 'What would reopen it',
      text: e.reopenWhen.length > 0 ? e.reopenWhen.join('; ') + '.' : 'Nothing is named that would reopen it.',
    },
    { label: 'What supports it', text: e.evidence.join(' ') },
    { label: 'What more research would cost', text: e.furtherResearch },
  ];
  return lines;
}

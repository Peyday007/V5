// @vitest-environment jsdom
/**
 * The decision brief as a person sees it.
 *
 * The server tests prove the brief is derived and carried in the thread
 * payload; this proves the screen renders what was sent — the headline, the
 * step and its status, what needs a person, the rejections with their reasons
 * — and composes nothing of its own. The fixture is typed against the server's
 * own `DecisionBrief`, so a field the server stops sending is a compile error
 * here rather than a screen that silently shows less (§35).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ObjectiveBrief } from '../client/src/russell/ObjectiveBrief.tsx';
import type { DecisionBrief } from '../server/services/decision/brief.ts';

afterEach(cleanup);

function brief(): DecisionBrief {
  return {
    objective: {
      id: 'obj_1',
      statement: 'Produce usable cash quickly.',
      sourceKind: 'CASH_MODE',
      sourceRef: 'cmm_1',
      projectId: 'prj_1',
      conversationId: 'rcv_1',
      createdAt: '2026-09-23T10:00:00.000Z',
      closedAt: null,
    },
    context: {
      projectId: 'prj_1',
      projectName: 'Cash Mode 1',
      purpose: 'OPERATIONAL',
      revenue: true,
      intendedOutcome: 'Produce usable cash quickly.',
      constraints: [],
      resources: [],
      authority: {
        research: { granted: true, sentence: 'Research is authorized.' },
        commercial: { granted: false, lines: [], allowedActions: [] },
      },
      capabilities: [],
      questions: [],
      deployableCents: 0,
      currency: 'USD',
    },
    verdict: 'NO_PATH_QUALIFIES',
    headline: 'Nothing qualifies yet. What decides it next: a buyer or user we can actually reach, for "Transcription".',
    reasons: ['1 of 1 stop at the same test: a buyer or user we can actually reach.'],
    leading: {
      ref: 'CASH_OPPORTUNITY:cop_1',
      source: 'CASH_OPPORTUNITY',
      title: 'Transcription',
      how: null,
      standing: 'OPEN',
      because: 'Not yet established.',
      tests: [
        {
          criterion: 'REACH',
          reading: 'UNKNOWN',
          kind: 'UNKNOWN',
          statement: 'How we would be paid is not established.',
          evidenceRef: null,
          task: null,
        },
      ],
      economics: [{ label: 'Expected margin', value: null, kind: 'UNKNOWN', basis: 'Neither half is known.' }],
    },
    alternatives: [],
    rejected: [
      {
        ref: 'CASH_OPPORTUNITY:cop_2',
        source: 'CASH_OPPORTUNITY',
        title: 'NJDOH RFQ',
        how: null,
        standing: 'REJECTED',
        because: 'How long it takes, and whether the window is open: The opening closed on 2026-09-20.',
        tests: [],
        economics: [],
      },
    ],
    counts: { paths: 2, live: 1, rejected: 1, qualifying: 0 },
    proposedStep: null,
    currentStep: {
      step: {
        id: 'ost_1',
        objectiveId: 'obj_1',
        kind: 'QUALIFY_OPENING',
        pathRef: 'CASH_OPPORTUNITY:cop_1',
        serves: 'REACH',
        description: 'Qualify "Transcription" from published sources.',
        workKind: 'OPPORTUNITY',
        workRef: 'cop_1',
        authority: 'AUTHORIZED',
        boundary: null,
        prepared: null,
        stepKey: 'k',
        supersededAt: null,
        supersededReason: null,
        createdAt: '2026-09-23T10:00:00.000Z',
        updatedAt: '2026-09-23T10:00:00.000Z',
      },
      status: 'RUNNING',
      detail: 'Its deep dive is pending.',
    },
    today: ['A deep dive is already running.'],
    needsPerson: ['Contacting a buyer needs a commercial grant.'],
    watch: { continueIf: 'the research establishes a buyer.', reviseIf: null, stopIf: 'every live path is rejected.' },
    history: [],
    text: '',
  };
}

describe('the decision brief on screen', () => {
  it('shows the answer, the step and its status, and what needs a person', () => {
    render(<ObjectiveBrief brief={brief()} />);
    expect(screen.getByText(/Nothing qualifies yet/)).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText(/Qualify "Transcription"/)).toBeTruthy();
    expect(screen.getByText(/needs a commercial grant/)).toBeTruthy();
    expect(screen.getByText(/Rejected on evidence \(1\)/)).toBeTruthy();
    expect(screen.getByText(/The opening closed on 2026-09-20/)).toBeTruthy();
  });

  it('writes an unknown as unknown, never as a figure', () => {
    render(<ObjectiveBrief brief={brief()} />);
    expect(screen.getByText(/Expected margin: not established/)).toBeTruthy();
  });
});

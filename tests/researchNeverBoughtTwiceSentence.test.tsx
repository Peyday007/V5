// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResearchView } from '../client/src/russell/Research.tsx';

vi.mock('../client/src/lib/researchGoalsApi.ts', () => ({
  ResearchGoalsApi: { overview: () => new Promise(() => {}) },
}));

describe('Research never-bought-twice hint', () => {
  it('shows the sentence beneath the heading, even while loading', () => {
    render(<ResearchView projectId="prj_x" />);
    const sentence = screen.getByText('Research Brain can answer from what it holds is never bought twice.');
    expect(sentence.tagName).toBe('P');
    expect(sentence.className).toBe('rs-hint');
    const heading = screen.getByRole('heading', { name: 'Research' });
    expect(heading.nextElementSibling).toBe(sentence);
  });
});

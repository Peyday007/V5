'use client';
import { useBrain } from '@/hooks/use-brain';
import type { GoalBriefing, GoalView } from '@/lib/types';
import { useEffect, useState } from 'react';

/** The goal a plan page is reading: `?goal=` first, else the first active goal with a target. */
export function useGoalChoice() {
  const goals = useBrain<{ briefing: GoalBriefing; goals: GoalView[] }>('/api/goals');
  const [goalId, setGoalId] = useState<string | null>(null);
  useEffect(() => {
    if (goalId || !goals.data) return;
    const fromUrl = new URLSearchParams(window.location.search).get('goal');
    const list = goals.data.goals;
    const pick =
      list.find((g) => g.id === fromUrl) ??
      list.find((g) => g.target && g.lifecycle === 'ACTIVE') ??
      list.find((g) => g.target) ??
      list[0];
    if (pick) setGoalId(pick.id);
  }, [goals.data, goalId]);
  return { goals, goalId, setGoalId };
}

export function GoalPicker({
  goals,
  value,
  onChange
}: {
  goals: GoalView[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  if (goals.length === 0) return null;
  return (
    <select
      aria-label='Goal'
      className='border-input bg-background h-9 w-full max-w-md min-w-0 rounded-md border px-2 text-sm sm:w-auto'
      value={value ?? ''}
      onChange={(e) => {
        onChange(e.target.value);
        const url = new URL(window.location.href);
        url.searchParams.set('goal', e.target.value);
        window.history.replaceState(null, '', url);
      }}
    >
      {goals.map((g) => (
        <option key={g.id} value={g.id}>
          {g.title}
        </option>
      ))}
    </select>
  );
}

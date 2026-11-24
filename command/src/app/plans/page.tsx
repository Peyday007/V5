'use client';
import PageContainer from '@/components/layout/page-container';
import { Details, Empty, Facts, Freshness, Panel, QueryView, StatusPill, TimeAgo, money } from '@/components/brain/display';
import { GoalPicker, useGoalChoice } from '@/components/brain/goal-picker';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTool } from '@/hooks/use-brain';
import { enc } from '@/lib/brain';
import type { PlanSummary } from '@/lib/types';
import Link from 'next/link';

function text(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? 'None' : value.map(text).join('; ');
  const r = value as Record<string, unknown>;
  for (const key of ['sentence', 'label', 'summary', 'question', 'title', 'reason', 'key']) {
    if (typeof r[key] === 'string') return r[key] as string;
  }
  return JSON.stringify(value);
}

function cents(value: unknown, currency = 'USD'): string {
  if (typeof value === 'number') return money(value, currency);
  if (value && typeof value === 'object') {
    const r = value as Record<string, unknown>;
    for (const key of ['p10', 'p50', 'cents', 'value', 'median']) if (typeof r[key] === 'number') return `${money(r[key] as number, currency)} (${key})`;
  }
  return text(value);
}

export default function PlansPage() {
  const { goals, goalId, setGoalId } = useGoalChoice();
  const plan = useTool<PlanSummary>(goalId ? 'brain_operator_goal_plan' : null, goalId ? { goal_id: goalId } : {});

  return (
    <PageContainer
      pageTitle='Commercial plans'
      pageDescription="Brain's planner reading for a goal: the verdict, the chosen strategy, every strategy it simulated and the next test that would change it."
      pageHeaderAction={
        <>
          <Freshness query={plan} />
          <GoalPicker goals={goals.data?.goals ?? []} value={goalId} onChange={setGoalId} />
        </>
      }
    >
      <QueryView query={goals}>
        {(g) => (g.goals.length === 0 ? <Empty>No goals are recorded, so there is no plan to read.</Empty> : null)}
      </QueryView>
      {goalId && (
        <QueryView query={plan} rows={5}>
          {(p) =>
            p.reading === null || (!p.verdict && !p.strategies) ? (
              <Empty>{p.note ?? 'Brain has not read a plan for this goal yet.'}</Empty>
            ) : (
              <>
                <Panel
                  title='Verdict'
                  description={p.readAt ? <>Planner read <TimeAgo at={p.readAt} /></> : undefined}
                  action={<StatusPill status={p.verdict ?? null} />}
                >
                  <Facts
                    items={[
                      { label: 'Kind', value: p.kind === 'OBJECTIVE' ? 'Objective plan' : 'Target plan' },
                      { label: 'Chosen strategy', value: text(p.chosenStrategy) },
                      ...(p.forecast
                        ? [
                            { label: 'Remaining to target', value: typeof p.forecast.remainingCents === 'number' ? money(p.forecast.remainingCents) : '—' },
                            { label: 'Days left', value: p.forecast.daysLeft ?? '—' },
                            { label: 'Conservative settled', value: cents(p.forecast.conservativeSettled) },
                            { label: 'Committee', value: p.forecast.committee ? <StatusPill status={p.forecast.committee.verdict} /> : 'No review recorded' }
                          ]
                        : [])
                    ]}
                  />
                  {p.nextTest !== undefined && p.nextTest !== null && (
                    <p className='mt-4 text-sm text-pretty'>
                      <span className='text-muted-foreground'>Next test: </span>
                      {text(p.nextTest)}
                    </p>
                  )}
                  {p.forecast?.committee && (
                    <Button variant='link' className='mt-2 h-auto p-0' render={<Link href={`/committee/?goal=${enc(p.goalId)}`} />}>
                      Read the committee review →
                    </Button>
                  )}
                </Panel>

                <Panel title='Strategies' description='Each strategy the planner simulated for this goal.' flush>
                  {!p.strategies || p.strategies.length === 0 ? (
                    <div className='px-4'><Empty>The reading lists no strategies.</Empty></div>
                  ) : (
                    <div className='overflow-x-auto'>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className='pl-4'>Strategy</TableHead>
                            <TableHead>Verdict</TableHead>
                            <TableHead>Conservative settled</TableHead>
                            <TableHead className='pr-4'>Failed constraints</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {p.strategies.map((s) => (
                            <TableRow key={s.key}>
                              <TableCell className='max-w-72 pl-4 font-medium whitespace-normal'>{s.label}</TableCell>
                              <TableCell><StatusPill status={s.verdict} /></TableCell>
                              <TableCell className='tabular-nums'>{cents(s.conservativeSettled)}</TableCell>
                              <TableCell className='text-muted-foreground max-w-80 pr-4 text-xs whitespace-normal'>{text(s.constraintsFailed)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </Panel>

                {(p.decision !== undefined || p.interpretation !== undefined) && (
                  <Panel title='Interpretation'>
                    <p className='text-sm text-pretty'>{text(p.interpretation)}</p>
                    <p className='mt-2 text-sm text-pretty'>{text(p.decision)}</p>
                  </Panel>
                )}
                <Details value={p} label='The full planner reading' />
              </>
            )
          }
        </QueryView>
      )}
    </PageContainer>
  );
}

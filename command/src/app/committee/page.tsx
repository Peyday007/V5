'use client';
import PageContainer from '@/components/layout/page-container';
import { Empty, Freshness, Panel, QueryView, Stat, StatusPill, words } from '@/components/brain/display';
import { GoalPicker, useGoalChoice } from '@/components/brain/goal-picker';
import { useTool } from '@/hooks/use-brain';
import type { PlanSummary } from '@/lib/types';

/**
 * The investment committee (§117): six independent roles review every plan,
 * and the committee can only take an acceptance away. This page shows the
 * review Brain stored with the goal's latest plan reading — nothing re-scored.
 */
export default function CommitteePage() {
  const { goals, goalId, setGoalId } = useGoalChoice();
  const plan = useTool<PlanSummary>(goalId ? 'brain_operator_goal_plan' : null, goalId ? { goal_id: goalId } : {});

  return (
    <PageContainer
      pageTitle='Investment committee'
      pageDescription='Every plan is read independently by six roles. A critical defect from any role blocks acceptance; agreement is not evidence.'
      pageHeaderAction={
        <>
          <Freshness query={plan} />
          <GoalPicker goals={goals.data?.goals ?? []} value={goalId} onChange={setGoalId} />
        </>
      }
    >
      <QueryView query={goals}>
        {(g) => (g.goals.length === 0 ? <Empty>No goals are recorded, so the committee has nothing to review.</Empty> : null)}
      </QueryView>
      {goalId && (
        <QueryView query={plan} rows={5}>
          {(p) => {
            const c = p.forecast?.committee;
            if (!c)
              return (
                <Empty>
                  {p.kind === 'OBJECTIVE'
                    ? 'This goal has an objective plan; the committee reviews target plans.'
                    : (p.note ?? 'No committee review is stored with this goal’s latest plan reading.')}
                </Empty>
              );
            return (
              <>
                <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
                  <Stat label='Verdict' value={<StatusPill status={c.verdict} className='text-sm' />} />
                  <Stat label='Blocks acceptance' value={c.blocks ? 'Yes' : 'No'} tone={c.blocks ? 'bad' : 'good'} />
                  <Stat label='Critical defects' value={c.criticalDefects} tone={c.criticalDefects > 0 ? 'bad' : undefined} />
                  <Stat label='Review tier' value={words(c.tier)} hint={c.reviewMs !== null ? `${c.reviewMs} ms` : undefined} />
                </div>
                {c.blocker && (
                  <div className='rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400'>
                    {c.blocker}
                  </div>
                )}
                <div className='grid gap-4 md:grid-cols-2'>
                  {c.roles.map((role) => (
                    <Panel key={role.role} title={words(role.role)} action={<StatusPill status={role.verdict} />}>
                      {role.defects.length === 0 ? (
                        <p className='text-muted-foreground text-sm'>No defects raised.</p>
                      ) : (
                        <ul className='flex flex-col gap-3'>
                          {role.defects.map((d, i) => (
                            <li key={i} className='text-sm'>
                              <div className='flex items-start gap-2'>
                                {d.critical && <StatusPill status='Critical' tone='bad' />}
                                <span className='font-medium text-pretty'>{d.claim}</span>
                              </div>
                              <p className='text-muted-foreground mt-1 text-xs text-pretty'>{d.why}</p>
                              <p className='text-muted-foreground mt-0.5 font-mono text-[11px] break-all'>{d.evidenceRef}</p>
                            </li>
                          ))}
                        </ul>
                      )}
                      {role.open.length > 0 && (
                        <p className='text-muted-foreground mt-3 text-xs'>Open questions: {role.open.join('; ')}</p>
                      )}
                    </Panel>
                  ))}
                </div>
                {c.investigations.length > 0 && (
                  <Panel title='Investigations' description='Facts the roles disagree on, and who established or broke each.'>
                    <ul className='divide-y text-sm'>
                      {c.investigations.map((inv, i) => (
                        <li key={i} className='flex flex-col gap-1 py-2'>
                          <span className='font-medium'>{words(inv.fact)}</span>
                          <span className='text-muted-foreground text-xs'>
                            Established by {inv.established.map(words).join(', ') || 'nobody'} · broken by{' '}
                            {inv.broken.map(words).join(', ') || 'nobody'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Panel>
                )}
              </>
            );
          }}
        </QueryView>
      )}
    </PageContainer>
  );
}

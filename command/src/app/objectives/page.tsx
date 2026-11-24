'use client';
import PageContainer from '@/components/layout/page-container';
import { Empty, Facts, Freshness, Panel, QueryView, StatusPill, TimeAgo, money } from '@/components/brain/display';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { useBrain } from '@/hooks/use-brain';
import { useHomeProject } from '@/hooks/use-homes';
import { BrainError, enc, post } from '@/lib/brain';
import type { DecisionResult, GoalBriefing, GoalView } from '@/lib/types';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

function goalFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('goal');
}

export default function ObjectivesPage() {
  const goals = useBrain<{ briefing: GoalBriefing; goals: GoalView[] }>('/api/goals');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => setOpen(goalFromUrl()), []);

  return (
    <PageContainer
      pageTitle='Financial objectives'
      pageDescription="Each goal Brain is working toward, its target and the ledger's reading of it."
      pageHeaderAction={
        <>
          <Freshness query={goals} />
          <Button onClick={() => setCreating(true)}>
            <Icons.add /> New objective
          </Button>
        </>
      }
    >
      <QueryView query={goals} rows={4}>
        {({ briefing, goals: list }) => (
          <>
            <p className='text-sm text-pretty'>{briefing.headline}</p>
            {list.length === 0 ? (
              <Empty>No objectives are recorded for the projects you can read.</Empty>
            ) : (
              <div className='grid gap-4 md:grid-cols-2'>
                {list.map((g) => (
                  <GoalCard key={g.id} goal={g} onOpen={() => setOpen(g.id)} />
                ))}
              </div>
            )}
          </>
        )}
      </QueryView>
      <GoalSheet id={open} onClose={() => setOpen(null)} />
      <CreateSheet open={creating} onClose={() => setCreating(false)} />
    </PageContainer>
  );
}

function GoalCard({ goal, onOpen }: { goal: GoalView; onOpen: () => void }) {
  const t = goal.target;
  const share = t && t.targetCents > 0 ? Math.min(100, Math.round((t.achievedCents / t.targetCents) * 100)) : null;
  return (
    <Panel
      title={goal.title}
      description={goal.projectName ?? undefined}
      action={<StatusPill status={goal.lifecycle} />}
    >
      <div className='flex flex-col gap-3'>
        {t ? (
          <div className='flex flex-col gap-1.5'>
            <div className='flex items-baseline justify-between gap-2 text-sm'>
              <span className='font-semibold tabular-nums'>{money(t.achievedCents, t.currency)}</span>
              <span className='text-muted-foreground tabular-nums'>of {money(t.targetCents, t.currency)}</span>
            </div>
            <Progress value={share ?? 0} aria-label='Progress to target' />
            <p className='text-muted-foreground text-xs'>
              {t.metricLabel} · {t.daysLeft === null ? 'no due date' : `${t.daysLeft} days left`}
              {t.proven ? ' · payment proven' : ''}
            </p>
          </div>
        ) : (
          <p className='text-muted-foreground text-xs'>No measurable target recorded for this goal.</p>
        )}
        <p className='line-clamp-2 text-sm text-pretty'>
          <span className='text-muted-foreground'>Next: </span>
          {goal.next.action}
        </p>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <span className='text-muted-foreground text-xs'>
            {goal.deadline ? `Due ${goal.deadline}` : 'No deadline'} · updated <TimeAgo at={goal.updatedAt} />
          </span>
          <Button size='sm' variant='outline' onClick={onOpen}>
            Details
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function GoalSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const client = useQueryClient();
  const detail = useBrain<{ goal: GoalView; events: { id: string; kind?: string; summary?: string; createdAt?: string; [k: string]: unknown }[] }>(
    id ? `/api/goals/${enc(id)}` : null
  );
  const [busy, setBusy] = useState(false);

  async function decide(action: 'pause' | 'resume') {
    if (!id) return;
    setBusy(true);
    try {
      const result = await post<DecisionResult>(`/api/goals/${enc(id)}/${action}`, action === 'pause' ? { reason: 'Paused from the command center' } : {});
      if (result.ok) toast.success(result.consequence);
      else toast.error(result.reason ?? 'Brain refused that decision.');
      await client.invalidateQueries({ queryKey: ['brain'] });
    } catch (e) {
      toast.error(e instanceof BrainError ? e.message : 'Brain refused that decision.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className='w-full overflow-y-auto sm:max-w-xl'>
        <SheetHeader>
          <SheetTitle>{detail.data?.goal.title ?? 'Objective'}</SheetTitle>
          <SheetDescription>{detail.data?.goal.intent}</SheetDescription>
        </SheetHeader>
        <div className='flex flex-col gap-5 px-4 pb-6'>
          <QueryView query={detail}>
            {({ goal, events }) => (
              <>
                <div className='flex flex-wrap gap-2'>
                  <StatusPill status={goal.lifecycle} />
                  <StatusPill status={goal.state} />
                  {goal.overdue && <StatusPill status='Overdue' />}
                </div>
                <Facts
                  items={[
                    { label: 'Target', value: goal.target ? money(goal.target.targetCents, goal.target.currency) : 'None recorded' },
                    { label: 'Achieved', value: goal.target ? money(goal.target.achievedCents, goal.target.currency) : '—' },
                    { label: 'Remaining', value: goal.target ? money(goal.target.remainingCents, goal.target.currency) : '—' },
                    { label: 'Capital ceiling', value: goal.target?.capitalCeilingCents != null ? money(goal.target.capitalCeilingCents, goal.target.currency) : 'Not set' },
                    { label: 'Deadline', value: goal.deadline ?? 'None' },
                    { label: 'Commitment', value: goal.commitmentLabel },
                    { label: 'Owner', value: goal.owner?.name ?? 'Nobody named' },
                    { label: 'Purpose', value: goal.purposeLabel }
                  ]}
                />
                <div className='text-sm'>
                  <p className='text-muted-foreground text-xs font-medium uppercase'>Why this state</p>
                  <p className='mt-1 text-pretty'>{goal.stateEvidence}</p>
                </div>
                <div className='text-sm'>
                  <p className='text-muted-foreground text-xs font-medium uppercase'>Waiting on</p>
                  <p className='mt-1 text-pretty'>{goal.waiting.detail}</p>
                </div>
                <div className='text-sm'>
                  <p className='text-muted-foreground text-xs font-medium uppercase'>Next ({goal.next.by.toLowerCase()})</p>
                  <p className='mt-1 text-pretty'>{goal.next.action}</p>
                </div>
                {goal.obligations.length > 0 && (
                  <ul className='list-disc pl-5 text-sm'>
                    {goal.obligations.map((o) => <li key={o}>{o}</li>)}
                  </ul>
                )}
                <div className='flex flex-wrap gap-2'>
                  {goal.lifecycle === 'PAUSED' ? (
                    <Button size='sm' onClick={() => decide('resume')} disabled={busy}><Icons.play /> Resume</Button>
                  ) : (
                    <Button size='sm' variant='outline' onClick={() => decide('pause')} disabled={busy}><Icons.pause /> Pause</Button>
                  )}
                  <Button size='sm' variant='outline' render={<Link href={`/plans/?goal=${enc(goal.id)}`} />}>
                    Commercial plan
                  </Button>
                </div>
                {events.length > 0 && (
                  <div>
                    <p className='text-muted-foreground mb-2 text-xs font-medium uppercase'>History</p>
                    <ul className='flex flex-col gap-2 text-sm'>
                      {events.slice(0, 20).map((e) => (
                        <li key={String(e.id)} className='flex justify-between gap-3 border-b pb-2'>
                          <span className='min-w-0 text-pretty'>{String(e.summary ?? e.kind ?? '')}</span>
                          <span className='text-muted-foreground shrink-0 text-xs'><TimeAgo at={e.createdAt as string} /></span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </QueryView>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CreateSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const { projectId } = useHomeProject();
  const [objective, setObjective] = useState('');
  const [resources, setResources] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!projectId) return;
    setBusy(true);
    try {
      const result = await post<{ ok: boolean; reading?: string; consequence?: string }>('/api/goals', {
        projectId,
        objective: objective.trim(),
        resources: resources.trim() || undefined
      });
      toast.success(result.consequence ?? result.reading ?? 'Objective recorded.');
      setObjective('');
      setResources('');
      await client.invalidateQueries({ queryKey: ['brain'] });
      onClose();
    } catch (e) {
      toast.error(e instanceof BrainError ? e.message : 'Brain did not record that objective.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className='w-full sm:max-w-lg'>
        <SheetHeader>
          <SheetTitle>New objective</SheetTitle>
          <SheetDescription>
            State it in words. Brain reads the target, the deadline and the capital from it, the same way it does from a terminal.
          </SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} className='flex flex-col gap-4 px-4'>
          <div className='flex flex-col gap-2'>
            <Label htmlFor='objective'>Objective</Label>
            <Textarea
              id='objective'
              required
              placeholder='Generate $10,000 within 30 days using at most $3,000 in starting capital.'
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
            />
          </div>
          <div className='flex flex-col gap-2'>
            <Label htmlFor='resources'>What you have to work with (optional)</Label>
            <Input id='resources' value={resources} onChange={(e) => setResources(e.target.value)} />
          </div>
          {!projectId && <p className='text-muted-foreground text-xs'>You have no project Brain can record an objective in.</p>}
          <Button type='submit' disabled={busy || !projectId || !objective.trim()}>
            {busy ? 'Recording…' : 'Record objective'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

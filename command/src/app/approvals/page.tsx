'use client';
import PageContainer from '@/components/layout/page-container';
import { Empty, Freshness, Panel, QueryView, Stat, StatusPill, TimeAgo, money } from '@/components/brain/display';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useBrain } from '@/hooks/use-brain';
import { useHomeProject } from '@/hooks/use-homes';
import { BrainError, enc, post } from '@/lib/brain';
import type { CashView, Inbox, InboxItem } from '@/lib/types';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

export default function ApprovalsPage() {
  const { projectId } = useHomeProject();
  const inbox = useBrain<Inbox>('/api/russell/needs-you/inbox', { interval: 15_000 });
  const cash = useBrain<CashView>(projectId ? `/api/projects/${enc(projectId)}/cash` : null);

  return (
    <PageContainer
      pageTitle='Budgets & approvals'
      pageDescription="The spending authority you set, what is committed against it, the ledger, and every decision Brain is waiting on you for."
      pageHeaderAction={<Freshness query={inbox} />}
    >
      <Panel title='Waiting on you' description='Answer here; Brain records the decision and the work resumes.'>
        <QueryView query={inbox} rows={3}>
          {(data) => (
            <>
              {data.unreadable.length > 0 && (
                <p className='text-muted-foreground mb-3 text-xs'>
                  Could not read: {data.unreadable.map((u) => u.source).join(', ')} (temporary).
                </p>
              )}
              {data.items.length === 0 ? (
                <Empty>Nothing is waiting on you.</Empty>
              ) : (
                <ul className='flex flex-col gap-3'>
                  {data.items.map((item) => (
                    <ApprovalItem key={item.id} item={item} />
                  ))}
                </ul>
              )}
            </>
          )}
        </QueryView>
      </Panel>

      <QueryView query={cash} rows={4}>
        {(view) =>
          view.scope !== 'FULL' || !view.myCash || !view.authority ? (
            <Empty>Your account reads this project's money in shared scope; budgets and the ledger are shown to its owner.</Empty>
          ) : (
            <Budget view={view} />
          )
        }
      </QueryView>
    </PageContainer>
  );
}

function ApprovalItem({ item }: { item: InboxItem }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  async function answer(requestId: string, choice: string) {
    setBusy(choice);
    try {
      await post(`/api/russell/needs-you/${enc(requestId)}/answer`, { choice, reason: null });
      toast.success('Decision recorded.');
      await client.invalidateQueries({ queryKey: ['brain'] });
    } catch (e) {
      toast.error(e instanceof BrainError ? e.message : 'Brain did not accept that answer.');
    } finally {
      setBusy(null);
    }
  }
  const a = item.action;
  return (
    <li className='rounded-lg border p-4'>
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <p className='min-w-0 text-sm font-medium text-pretty'>{item.title}</p>
        <div className='flex items-center gap-2'>
          <StatusPill status={item.category} tone='info' />
          <StatusPill status={item.urgency} />
        </div>
      </div>
      <p className='mt-1 text-sm text-pretty'>{item.reason}</p>
      <p className='text-muted-foreground mt-1 text-xs text-pretty'>If ignored: {item.ifIgnored}</p>
      {item.since && <p className='text-muted-foreground mt-1 text-xs'>Waiting <TimeAgo at={item.since} /></p>}
      <div className='mt-3 flex flex-wrap gap-2'>
        {a.type === 'ANSWER_REQUEST' &&
          a.choices.map((c) => (
            <Button
              key={c.key}
              size='sm'
              variant={a.recommendation === c.key ? 'default' : 'outline'}
              disabled={busy !== null}
              title={c.consequence}
              onClick={() => answer(a.requestId, c.key)}
            >
              {busy === c.key ? 'Recording…' : c.label}
              {a.recommendation === c.key && ' (recommended)'}
            </Button>
          ))}
        {a.type === 'EXTERNAL' && (
          <Button size='sm' variant='outline' render={<a href={a.url} target='_blank' rel='noreferrer' />}>
            {a.label}
          </Button>
        )}
        {(a.type === 'OPEN' || a.type === 'SOFTWARE' || a.type === 'GRANT_RESEARCH_AUTHORITY') && (
          <Button
            size='sm'
            variant='outline'
            render={<a href={a.type === 'OPEN' ? `/${a.destination.toLowerCase()}` : '/needs-you'} />}
          >
            {a.type === 'OPEN' ? a.label : 'Decide in Brain'}
          </Button>
        )}
      </div>
    </li>
  );
}

function Budget({ view }: { view: CashView }) {
  const authority = view.authority!;
  const { position, entries, commitments } = view.myCash!;
  const cur = position.currency;
  return (
    <>
      <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
        <Stat label='Available funds' value={money(position.availableFundsCents, cur)} />
        <Stat label='Deployable' value={money(position.deployableCents, cur)} tone={position.shortfall ? 'bad' : undefined} hint={position.shortfall ? 'Shortfall' : undefined} />
        <Stat label='Committed, unpaid' value={money(position.unpaidCommitmentsCents, cur)} />
        <Stat label='Customer payments' value={money(position.customerPaymentsCents, cur)} />
      </div>
      <Panel
        title='Spending authority'
        description={authority.exists ? 'The ceilings you set. Brain commits nothing outside them.' : 'No spending authority is set, so Brain commits no money.'}
        action={<StatusPill status={authority.exists ? 'Active' : 'None'} tone={authority.exists ? 'good' : 'neutral'} />}
      >
        {authority.exists ? (
          <div className='flex flex-col gap-3'>
            <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
              <Stat label='Per action' value={money(authority.maxPerActionCents, cur)} />
              <Stat label='Total ceiling' value={money(authority.maxCommittedCents, cur)} />
              <Stat label='Committed' value={money(authority.committedCents, cur)} />
              <Stat label='Spent' value={money(authority.spentCents, cur)} />
            </div>
            <ul className='text-muted-foreground list-disc pl-5 text-xs'>
              {authority.lines.map((l) => <li key={l}>{l}</li>)}
            </ul>
          </div>
        ) : (
          <Empty>Set an authority in the Brain console's Cash section when you want Brain to spend.</Empty>
        )}
      </Panel>
      <div className='grid gap-6 lg:grid-cols-2'>
        <Panel title='Commitments' flush>
          {commitments.length === 0 ? (
            <div className='px-4'><Empty>No commitment has been made.</Empty></div>
          ) : (
            <div className='overflow-x-auto'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className='pl-4'>Purpose</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead className='pr-4 text-right'>Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {commitments.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className='max-w-64 pl-4 whitespace-normal'>{c.purpose}</TableCell>
                      <TableCell><StatusPill status={c.state} /></TableCell>
                      <TableCell className='pr-4 text-right tabular-nums'>{money(c.amountCents, c.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Panel>
        <Panel title='Ledger' description='Append-only; newest first as Brain returns it.' flush>
          {entries.length === 0 ? (
            <div className='px-4'><Empty>The ledger has no entries.</Empty></div>
          ) : (
            <div className='max-h-[28rem] overflow-auto'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className='pl-4'>Entry</TableHead>
                    <TableHead className='pr-4 text-right'>Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map(({ entry, effect }) => (
                    <TableRow key={entry.id}>
                      <TableCell className='max-w-72 pl-4 whitespace-normal'>
                        <p className='font-medium'>{entry.kind.replace(/_/g, ' ').toLowerCase()}</p>
                        <p className='text-muted-foreground text-xs'>{effect}</p>
                      </TableCell>
                      <TableCell className='pr-4 text-right tabular-nums'>{money(entry.amountCents, entry.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

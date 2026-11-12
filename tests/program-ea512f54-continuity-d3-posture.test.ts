/**
 * CONT-35 (S-0485, S-0486): how Brain operates during a partial outage.
 *
 * - a dependency refused as unavailable over and over is a recoverable OUTAGE,
 *   and one refused NOT_AUTHORIZED is CONSTRAINED (an account suspended), read
 *   from the effects engine's own rows;
 * - a commitment moves to an alternative only when nothing about the original
 *   is unsettled, only to an alternative somebody declared permitted (and, for
 *   a supplier, contractually workable), never to another account on a
 *   suspended channel, and a time-critical one is escalated rather than left
 *   to wait — with every skipped alternative recorded with its reason;
 * - the posture names what is down, what continues, what is known and what is
 *   uncertain, and an unreadable ledger is reported as such;
 * - the effect ledger restores from a snapshot verifiably, a damaged copy or a
 *   lost commitment is caught, and the drill is a project_events row.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';
import { runExternalEffect } from '../server/services/effects/external.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';
import { OPAQUE, opaqueAdapter, registerSyntheticAdapters, resetSynthetic, setFault, type Fault } from '../server/services/effects/synthetic.ts';
import type { OperationNamespace } from '../server/services/effects/engine.ts';
import { listOperations } from '../server/repos/idempotency.ts';
import { listEvents } from '../server/repos/events.ts';
import {
  CONTINUITY_CLAUSE_OWNERS,
  OUTAGE_THRESHOLD,
  continuityPosture,
  continuitySnapshot,
  dependencyHealth,
  judgeDependency,
  planContinuation,
  runRestoreDrill,
  unreadablePosture,
  verifyContinuityRestore,
  type ContinuationAlternative,
  type ContinuationInput,
  type NamespaceOutcome,
} from '../server/services/effects/posture.ts';
import { runContinuityCommand } from '../server/services/effects/continuity.ts';
import { readFileSync } from 'node:fs';

const NS: OperationNamespace = { name: opaqueAdapter.namespace, version: 1, principalScope: 'PRINCIPAL', retention: 'PERMANENT' };

let projectId = '';
let seq = 0;
const nextKey = (): string => `posture-key-${String(++seq).padStart(8, '0')}`;

async function runWith(fault: Fault, businessId: string): Promise<string> {
  setFault(OPAQUE, fault);
  const out = await runExternalEffect({ adapter: opaqueAdapter, namespace: NS, projectId, key: nextKey(), businessId, payload: { note: 'x' }, principalType: 'HUMAN', principalId: 'usr_one' });
  setFault(OPAQUE, 'NONE');
  return out.operation.id;
}

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  clearAdapters();
  registerSyntheticAdapters();
  resetSynthetic();
});

const NOW = '2026-11-12T12:00:00.000Z';
const at = (minutesAgo: number): string => new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();
const refused = (minutesAgo: number, category: NamespaceOutcome['category']): NamespaceOutcome => ({ at: at(minutesAgo), succeeded: false, category });
const ok = (minutesAgo: number): NamespaceOutcome => ({ at: at(minutesAgo), succeeded: true, category: null });

describe('dependency health', () => {
  it('opens the circuit on consecutive unavailability, and calls a suspension a constraint', () => {
    expect(judgeDependency('mail', [refused(1, 'DEPENDENCY_UNAVAILABLE'), refused(2, 'TIMEOUT'), refused(3, 'DEPENDENCY_UNAVAILABLE')], NOW)).toMatchObject({ status: 'OUTAGE', recoverable: true });
    // A success between the refusals means it is not down.
    expect(judgeDependency('mail', [refused(1, 'DEPENDENCY_UNAVAILABLE'), ok(2), refused(3, 'DEPENDENCY_UNAVAILABLE'), refused(4, 'TIMEOUT')], NOW).status).toBe('HEALTHY');
    expect(judgeDependency('mail', [refused(1, 'NOT_AUTHORIZED'), ok(5)], NOW)).toMatchObject({ status: 'CONSTRAINED', recoverable: false });
    expect(judgeDependency('mail', [ok(1)], NOW).status).toBe('HEALTHY');
    // Old outcomes say nothing about now; no outcome is never "healthy".
    expect(judgeDependency('mail', [refused(90, 'DEPENDENCY_UNAVAILABLE'), refused(91, 'DEPENDENCY_UNAVAILABLE'), refused(92, 'DEPENDENCY_UNAVAILABLE')], NOW).status).toBe('UNKNOWN');
    expect(judgeDependency('mail', [], NOW).status).toBe('UNKNOWN');
  });

  it('reads an outage from real refusals and never counts an unknown outcome as one', async () => {
    // The unknown is sent first: once the refusals open the circuit, a further
    // send on this namespace is withheld unsent (repair-F-CIRCUIT-CLAIM-UNENFORCED,
    // tests/program-ea512f54-continuity-d3-circuit.test.ts), so it could not
    // become an unknown at all. An unknown before the refusals is still not one.
    await runWith('THROW', 'biz-unknown');
    for (let i = 0; i < OUTAGE_THRESHOLD; i += 1) await runWith('REJECT_RETRYABLE', `biz-down-${i}`);
    const [health] = await dependencyHealth(projectId);
    expect(health).toMatchObject({ namespace: NS.name, status: 'OUTAGE', recoverable: true, observed: OUTAGE_THRESHOLD });

    const posture = await continuityPosture(projectId);
    expect(posture.degraded).toBe(true);
    expect(posture.unaffected).not.toContain(NS.name);
    expect(posture.unsettled).toBe(1);
    expect(posture.known.join(' ')).toContain('down (recoverable)');
    expect(posture.uncertain.join(' ')).toContain('may have been accepted');
  });

  it('lists a healthy dependency as unaffected work', async () => {
    await runWith('NONE', 'biz-fine');
    const posture = await continuityPosture(projectId);
    expect(posture).toMatchObject({ degraded: false, unaffected: [NS.name], unsettled: 0 });
  });

  it('serves an unreadable ledger as degraded and uncertain, never as nothing in doubt', () => {
    const p = unreadablePosture('prj_x', NOW);
    expect(p).toMatchObject({ degraded: true, available: false, known: [] });
    expect(p.uncertain[0]).toContain('could not be read');
    expect(readFileSync(new URL('../server/routes/operations.ts', import.meta.url), 'utf8')).toMatch(/\/projects\/:projectId\/continuity'[\s\S]*res\.status\(503\)[\s\S]*unreadablePosture/);
  });
});

const alt = (over: Partial<ContinuationAlternative>): ContinuationAlternative => ({
  namespace: 'alt',
  channel: null,
  permitted: true,
  contractuallyWorkable: null,
  requiresContract: false,
  status: 'HEALTHY',
  ...over,
});
const base = (over: Partial<ContinuationInput>): ContinuationInput => ({
  namespace: 'orig',
  channel: null,
  health: { status: 'OUTAGE', reason: 'down' },
  unsettled: 0,
  timeCritical: false,
  alternatives: [],
  ...over,
});

describe('continuing a commitment', () => {
  it('never moves or resends while the original may have been accepted', () => {
    const d = planContinuation(base({ unsettled: 1, alternatives: [alt({ namespace: 'supplier-b', requiresContract: true, contractuallyWorkable: true })] }));
    expect(d).toMatchObject({ action: 'HOLD_RECONCILE', to: null });
    expect(d.skipped).toEqual([{ namespace: 'supplier-b', why: expect.stringContaining('unsettled') }]);
  });

  it('switches supplier only when the contract is established to allow it', () => {
    const unknown = alt({ namespace: 'supplier-b', requiresContract: true, contractuallyWorkable: null });
    const no = alt({ namespace: 'supplier-c', requiresContract: true, contractuallyWorkable: false });
    const yes = alt({ namespace: 'supplier-d', requiresContract: true, contractuallyWorkable: true });
    const d = planContinuation(base({ alternatives: [unknown, no, yes] }));
    expect(d).toMatchObject({ action: 'REROUTE', to: 'supplier-d' });
    expect(d.skipped.map((s) => s.namespace)).toEqual(['supplier-b', 'supplier-c']);
    expect(d.skipped[0]!.why).toContain('never a yes');
    expect(planContinuation(base({ alternatives: [unknown, no] })).action).toBe('WAIT_RECOVERABLE');
  });

  it('changes to a permitted channel on a suspension, never to another account on the same channel', () => {
    const constrained = { status: 'CONSTRAINED' as const, reason: 'NOT_AUTHORIZED' };
    const sameChannel = alt({ namespace: 'email-account-2', channel: 'email' });
    const unpermitted = alt({ namespace: 'linkedin', channel: 'linkedin', permitted: null });
    const permitted = alt({ namespace: 'phone', channel: 'phone' });
    const d = planContinuation(base({ namespace: 'email-account-1', channel: 'email', health: constrained, alternatives: [sameChannel, unpermitted, permitted] }));
    expect(d).toMatchObject({ action: 'REROUTE', to: 'phone' });
    expect(d.skipped.find((s) => s.namespace === 'email-account-2')!.why).toContain('bypass the constraint');

    // No permitted alternative: an external constraint, not something to retry past.
    expect(planContinuation(base({ namespace: 'email-account-1', channel: 'email', health: constrained, alternatives: [sameChannel] })).action).toBe('EXTERNAL_CONSTRAINT');
  });

  it('escalates a time-critical commitment that cannot move, and proceeds when nothing is down', () => {
    expect(planContinuation(base({ timeCritical: true, alternatives: [alt({ status: 'OUTAGE' })] })).action).toBe('ESCALATE_TIME_CRITICAL');
    expect(planContinuation(base({ health: { status: 'HEALTHY', reason: 'fine' }, alternatives: [alt({})] }))).toMatchObject({ action: 'PROCEED', to: null });
  });

  it('names an owner for every S-0485 clause', () => {
    const clauses = CONTINUITY_CLAUSE_OWNERS.map((c) => c.clause).join(' | ');
    for (const words of ['unaffected work', 'degraded but truthful', 'another model/provider', 'acquisition channel', 'switch suppliers', 'time-critical', 'verified restore', 'external constraint']) {
      expect(clauses).toContain(words);
    }
  });
});

describe('verified restore of the effect ledger', () => {
  it('restores every commitment to the class it had, and records the drill', async () => {
    await runWith('NONE', 'biz-paid');
    await runWith('ACCEPT_THEN_LOSE_RESPONSE', 'biz-unknown');
    await runWith('REJECT_TERMINAL', 'biz-refused');
    const before = JSON.stringify(await getDb().all('SELECT * FROM idempotency_operations ORDER BY id'));

    const drill = await runRestoreDrill(projectId);
    expect(drill).toMatchObject({ verified: true, checksumOk: true, operations: 3, reclassified: [], missingFromLive: [], regressed: [] });
    // The drill reads; it never changes a commitment.
    expect(JSON.stringify(await getDb().all('SELECT * FROM idempotency_operations ORDER BY id'))).toBe(before);
    const event = (await listEvents(projectId)).find((e) => e.payload['kind'] === 'CONTINUITY_RESTORE_DRILL');
    expect(event).toMatchObject({ eventType: 'RECONCILE_COMPLETED', payload: { verified: true, operations: 3 } });
  });

  it('catches a damaged copy and a commitment the live ledger lost', async () => {
    const paid = await runWith('NONE', 'biz-paid');
    const snapshot = await continuitySnapshot(projectId);

    const tampered = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    tampered.operations[0]!.state = 'FAILED';
    const damaged = verifyContinuityRestore(JSON.stringify(tampered));
    expect(damaged.verified).toBe(false);
    expect(damaged.checksumOk).toBe(false);
    expect(damaged.reclassified).toEqual([{ operationId: paid, recorded: 'CONFIRMED', restored: 'FAILED_EXTERNAL_CONSTRAINT' }]);

    const lost = verifyContinuityRestore(JSON.stringify(snapshot), []);
    expect(lost).toMatchObject({ verified: false, missingFromLive: [paid] });
    expect(verifyContinuityRestore('not json').verified).toBe(false);
    expect(verifyContinuityRestore(JSON.stringify(snapshot), await listOperations(projectId)).verified).toBe(true);
  });

  it('is reachable from the operator terminal', async () => {
    await runWith('NONE', 'biz-paid');
    const out = await runContinuityCommand(['snapshot', '--project', projectId]);
    expect(out.code).toBe(0);
    expect(verifyContinuityRestore(out.out).verified).toBe(true);
    expect((await runContinuityCommand(['drill', '--project', projectId])).code).toBe(0);
    expect((await runContinuityCommand(['posture', '--project', projectId])).code).toBe(0);
    expect((await runContinuityCommand(['verify-restore'])).code).toBe(2);
  });
});

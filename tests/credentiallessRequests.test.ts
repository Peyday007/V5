/**
 * A request that reaches /mcp with no credential is not audited row by row, so
 * the process tallies it: otherwise a recovery probe that saw nothing cannot
 * tell a Routine that never called Brain from one whose Claude connector sent
 * no token (Airyn 2-B, 2026-10-15).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clientFamily,
  credentiallessReading,
  noteCredentiallessRequest,
  processReadings,
  resetCredentiallessRequests,
} from '../server/services/infra/incidents.ts';

beforeEach(() => resetCredentiallessRequests());

describe('requests that reach the MCP door with no credential', () => {
  it('are tallied by endpoint and client family, with the newest instants', () => {
    noteCredentiallessRequest('/mcp/factory', 'Claude-User (claude.ai)', new Date('2026-10-15T17:51:00Z'));
    noteCredentiallessRequest('/mcp/factory', 'Claude-User (claude.ai)', new Date('2026-10-15T17:52:00Z'));
    noteCredentiallessRequest('/mcp', 'python-httpx/0.27', new Date('2026-10-15T17:53:00Z'));
    const reading = credentiallessReading();
    expect(reading.byClient[0]).toEqual({ key: '/mcp/factory claude-user', count: 2, first: '2026-10-15T17:51:00.000Z', last: '2026-10-15T17:52:00.000Z' });
    expect(reading.recent).toHaveLength(3);
    expect((processReadings()['credentialless'] as { byClient: unknown[] }).byClient).toHaveLength(2);
  });

  it('keeps nothing but the first word of a user agent, and stays bounded', () => {
    expect(clientFamily('Mozilla/5.0 (secret-ish details)')).toBe('mozilla');
    expect(clientFamily(null)).toBe('none');
    for (let i = 0; i < 500; i += 1) noteCredentiallessRequest(`/mcp/x${i}`, `ua${i}`);
    const reading = credentiallessReading();
    expect(reading.byClient.length).toBeLessThanOrEqual(24);
    expect(reading.recent.length).toBeLessThanOrEqual(40);
  });

  it('is wired into the door for the one refusal that is not audited', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('server/mcp/endpoint.ts', 'utf8');
    expect(src).toMatch(/if \(auth\.reason !== 'NO_CREDENTIALS'\) await auditRefusal\(req, auth\.reason\);\s*else noteCredentiallessRequest\(/);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tokenEventChangesHistory } from '../server/services/fleet/connectorHealth.ts';

/*
 * Connector health caches the token history it reads from identity_events.
 * The token endpoint cleared that cache on every token event, so an ordinary
 * refresh re-ran a 45-day LIKE scan. Production, 2026-10-14 on 412f9a0: 53
 * runs in 49 minutes, mean 14 s, max 60 s. The cache may be cleared only by a
 * row the scan actually reads, and that must stay true if the scan changes.
 */
describe('the token history cache', () => {
  it('is cleared by a refusal and by a recovered refresh', () => {
    expect(tokenEventChangesHistory('DENIED', { reason: 'REUSED' })).toBe(true);
    expect(tokenEventChangesHistory('DENIED', undefined)).toBe(true);
    expect(tokenEventChangesHistory('SUCCESS', { recovered: 'LOST_RESPONSE_RETRY' })).toBe(true);
  });

  it('is kept by an ordinary successful refresh', () => {
    expect(tokenEventChangesHistory('SUCCESS', { grantType: 'refresh_token' })).toBe(false);
    expect(tokenEventChangesHistory('SUCCESS', undefined)).toBe(false);
    expect(tokenEventChangesHistory('FAILED', {})).toBe(false);
  });

  it('reads only the rows the predicate clears on, and the token endpoint asks it', () => {
    const health = fs.readFileSync(path.join('server/services/fleet/connectorHealth.ts'), 'utf8');
    const reads = [...health.matchAll(/action = 'OAUTH_TOKEN' AND result = '(\w+)'/g)].map((m) => m[1]);
    // DENIED, and SUCCESS narrowed to `recovered`. A new kind of row read here
    // must be added to tokenEventChangesHistory, or the cache answers stale.
    expect(reads.sort()).toEqual(['DENIED', 'SUCCESS']);
    expect(health).toMatch(/result = 'SUCCESS'[^`]*metadata LIKE '%"recovered"%'/);
    const oauth = fs.readFileSync(path.join('server/routes/oauth.ts'), 'utf8');
    expect(oauth).toMatch(/OAUTH_TOKEN' && tokenEventChangesHistory\(/);
    expect(oauth).not.toMatch(/if \(input\.action === 'OAUTH_TOKEN'\) forgetTokenHistory/);
  });
});

/**
 * Brain's real MCP endpoint (`mcpRouter`: the same authentication, authorization, protocol
 * handling and tool dispatch the app connector reaches) mounted on one isolated world database,
 * for evaluating app-session planning over the connector's own transport without touching
 * production. Nothing else of the server boots: no ticks, no providers, no outbound work.
 *
 *   npx tsx scripts/planningMcpHost.ts credential --world DIR [--as NAME] [--out FILE] [--fleet]   a worker of its own with the
 *                                                                  operator's scopes on the world's project
 *   npx tsx scripts/planningMcpHost.ts serve --world DIR --port P  serve POST /mcp until killed
 *   npx tsx scripts/planningMcpHost.ts call (--port P | --url https://…/mcp) --credential FILE --tool NAME --args FILE   one tools/call
 *   npx tsx scripts/planningMcpHost.ts probe --url https://…/mcp --credential FILE   tools/list carries every planning tool
 */
import fs from 'node:fs';
import path from 'node:path';

const [cmd = '', ...rest] = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? (rest[i + 1] ?? null) : null;
};
const need = (name: string): string => {
  const v = flag(name);
  if (!v) throw new Error(`--${name} is required for ${cmd}`);
  return v;
};
const PROTOCOL = '2026-07-28';

async function main(): Promise<void> {
  if (cmd === 'call') {
    const name = need('tool');
    const args = flag('args') ? JSON.parse(fs.readFileSync(need('args'), 'utf8')) : {};
    const bearer = fs.readFileSync(need('credential'), 'utf8').trim();
    // --url: any Brain's MCP endpoint (staging or production, for the release's connection test); --port: a local host.
    const endpoint = flag('url') ?? `http://127.0.0.1:${need('port')}/mcp`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'mcp-protocol-version': PROTOCOL, 'mcp-method': 'tools/call', 'mcp-name': name, accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientInfo': { name: 'planning-session', version: '1.0.0' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { process.stdout.write(`${text}\n`); process.exit(1); }
    const result = (body['result'] ?? {}) as Record<string, unknown>;
    process.stdout.write(`${JSON.stringify({ status: response.status, isError: result['isError'] === true, value: result['structuredContent'] ?? result['content'] ?? body['error'] ?? null }, null, 2)}\n`);
    return;
  }
  if (cmd === 'probe') {
    const bearer = fs.readFileSync(need('credential'), 'utf8').trim();
    const response = await fetch(need('url'), {
      method: 'POST',
      headers: { 'mcp-protocol-version': PROTOCOL, 'mcp-method': 'tools/list', accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientInfo': { name: 'planning-release-probe', version: '1.0.0' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    });
    const body = (await response.json().catch(() => ({}))) as { result?: { tools?: { name: string }[] } };
    const names = new Set((body.result?.tools ?? []).map((t) => t.name));
    const { PLANNING_TOOLS } = await import('../server/mcp/planningTools.ts');
    const missing = PLANNING_TOOLS.map((t) => t.name).filter((n) => !names.has(n));
    process.stdout.write(`${JSON.stringify({ status: response.status, planningTools: PLANNING_TOOLS.length - missing.length, missing }, null, 2)}\n`);
    process.exit(missing.length === 0 && response.status === 200 ? 0 : 1);
  }
  const world = need('world');
  const meta = JSON.parse(fs.readFileSync(path.join(world, 'world.json'), 'utf8')) as { projectId: string; userId: string };
  const { initDatabase } = await import('../server/db/database.ts');
  await initDatabase({ dbPath: path.join(world, 'session.db') });
  if (cmd === 'credential') {
    const { createWorker, grantMembership, issueWorkerCredential } = await import('../server/repos/identity.ts');
    const { OPERATOR_SCOPES, CONNECTOR_SCOPES } = await import('../server/domain/types.ts');
    // --fleet: a connected research worker with only the connector set (no operator:act), as a fleet member is.
    const scopes = rest.includes('--fleet') ? [...CONNECTOR_SCOPES] : [...OPERATOR_SCOPES];
    const worker = await createWorker({ name: `planning-${flag('as') ?? 'session'}-${Date.now()}`, displayName: 'Planning session', workerType: 'MCP', description: 'App-session planning evaluation', createdByType: 'HUMAN', createdById: meta.userId } as never);
    await grantMembership({ projectId: meta.projectId, principalType: 'WORKER', principalId: worker.id, role: null, scopes, grantedByType: 'HUMAN', grantedById: meta.userId } as never);
    const issued = await issueWorkerCredential({ workerId: worker.id, issuedByType: 'HUMAN', issuedById: meta.userId });
    const out = flag('out') ?? path.join(world, '.mcp-credential');
    fs.writeFileSync(out, issued.plaintext, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok: true, workerId: worker.id, scopes })}\n`);
    process.exit(0);
  }
  if (cmd === 'serve') {
    const express = (await import('express')).default;
    const { mcpRouter, MCP_PATH } = await import('../server/mcp/endpoint.ts');
    const app = express();
    app.use(MCP_PATH, mcpRouter());
    const port = Number(need('port'));
    app.listen(port, '127.0.0.1', () => process.stdout.write(`serving ${MCP_PATH} on 127.0.0.1:${port}\n`));
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

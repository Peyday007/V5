/**
 * RC1's measured cause (planning failure map; model exam 2026-11-26): the GPU
 * pod's proxy closes a connection idle for 100 seconds, so a reasoning model
 * that thinks longer before answering returned content "" or HTTP 524. A turn
 * without tools is streamed; an endpoint that still answers with plain JSON is
 * read as before.
 */
import { describe, expect, it } from 'vitest';
import { chatFor } from '../server/services/cheap/modelBench.ts';

const endpoint = { label: 't', url: 'https://example.test/v1', key: 'k', model: 'm', usdPerHour: null };

describe('a chat turn without tools is streamed', () => {
  it('asks for a stream and joins the answer from its events', async () => {
    let sent: Record<string, unknown> = {};
    const sse = ['data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}', 'data: {"choices":[{"delta":{"content":"{\\"routes\\":"}}]}', 'data: {"choices":[{"delta":{"content":"[]}"}}],"usage":{"completion_tokens":7}}', 'data: [DONE]', ''].join('\n');
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const r = await chatFor(endpoint, fetchImpl)([{ role: 'user', content: 'x' }]);
    expect(sent['stream']).toBe(true);
    expect(r).toMatchObject({ content: '{"routes":[]}', completionTokens: 7, error: null });
  });
  it('reads a plain JSON answer from an endpoint that does not stream', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    expect((await chatFor(endpoint, fetchImpl)([{ role: 'user', content: 'x' }])).content).toBe('hello');
  });
  it('does not stream a turn with tools', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      sent = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await chatFor(endpoint, fetchImpl)([{ role: 'user', content: 'x' }], [{ type: 'function', function: { name: 'f' } }]);
    expect(sent['stream']).toBeUndefined();
  });
});

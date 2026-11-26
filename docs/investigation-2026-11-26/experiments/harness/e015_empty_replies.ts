// E-015: askModel + chatFor (streaming reader, stripThink) under fake endpoints. No network: fetch is replaced.
import { askModel, routesJson, parseRoutes } from '../../../../server/services/goals/routeProposal.ts';
import { chatFor, stripThink, type ChatFn } from '../../../../server/services/cheap/modelBench.ts';
import { probes, refCtx, write } from './lib.ts';

const ep = { label: 'fake', url: 'http://fake.invalid/v1', key: 'k', model: 'm', usdPerHour: null };
const sse = (events: (object | string)[], opts: { trailingNewline?: boolean; throwAfter?: boolean } = {}) => {
  const enc = new TextEncoder();
  const chunks = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
  if (opts.trailingNewline === false && chunks.length) chunks[chunks.length - 1] = chunks[chunks.length - 1]!.replace(/\n+$/, '');
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i < chunks.length) ctrl.enqueue(enc.encode(chunks[i++]!));
      else if (opts.throwAfter) ctrl.error(new Error('socket hang up (connection reset)'));
      else ctrl.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const json = (status: number, body: object | string) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const delta = (content: string | null, extra: object = {}) => ({ choices: [{ delta: { content, ...extra } }] });

// Sends through the real chatFor with a scripted fetch; records each request's max_tokens and stream flag.
function scripted(responses: (() => Response)[]): { chat: ChatFn; calls: { max_tokens: number; stream: boolean }[] } {
  const calls: { max_tokens: number; stream: boolean }[] = [];
  let n = 0;
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    calls.push({ max_tokens: b.max_tokens, stream: !!b.stream });
    return responses[Math.min(n++, responses.length - 1)]!();
  }) as unknown as typeof fetch;
  return { chat: chatFor(ep, fetchImpl, 10_000), calls };
}
const ROUTE_JSON = '{"routes":[{"title":"A","mechanism":"EXISTING_BUYING_SIGNAL","payer":"P","offer":"O","channel":"C","price":100,"directCost":10,"daysToFirstCash":5}]}';
const cases: Record<string, (() => Response)[]> = {
  i_emptyOnceThenAnswer: [() => sse([delta(''), { choices: [{ delta: {}, finish_reason: 'length' }] }]), () => sse([delta(ROUTE_JSON)])],
  ii_emptyTwice: [() => sse([delta('')]), () => sse([delta('')])],
  iii_http524: [() => json(524, '<html>A timeout occurred</html>')],
  iv_unclosedThink_withDraftJson: [() => sse([delta('<think>The owner wants... draft: {"routes":[{"title":"DRAFT-FROM-REASONING","mechanism":"EXISTING_BUYING_SIGNAL","payer":"P","offer":"O","channel":"C","price":100,"directCost":10,"daysToFirstCash":5}]} hmm, let me reconsider the price')])],
  v_reasoningContentOnly: [() => sse([delta(null, { reasoning_content: `thinking... ${ROUTE_JSON}` }), delta(null, { reasoning_content: ' done' })]), () => sse([delta(null, { reasoning_content: 'still thinking' })])],
  vi_partialThenStreamErrorEvent: [() => sse([delta('{"routes":[{"title":"A","mechanism":"EXISTING_BUYING_SIGNAL","payer":"P"'), { error: { message: 'upstream overloaded' } }])],
  vii_partialThenConnectionReset: [() => sse([delta('{"routes":[{"title":"A","mechanism":"EXISTING_BUYING_SIGNAL","payer":"P"')], { throwAfter: true })],
  viii_lastLineNoTrailingNewline: [() => sse([delta('{"routes":[{"title":"A",'), delta('"mechanism":"EXISTING_BUYING_SIGNAL","payer":"P","offer":"O","channel":"C","price":100,"directCost":10,"daysToFirstCash":5}]}')], { trailingNewline: false })],
  ix_nonStreamed_finishLength_truncated: [() => json(200, { choices: [{ message: { content: '{"routes":[{"title":"A","mechanism":"EXISTING_BUYING_SIGNAL","payer":"P","offer":"O","channel":"C","price":100,"directCost":10,"daysToFirstCash":5},{"title":"B","pay' }, finish_reason: 'length' }], usage: { completion_tokens: 4000 } })],
  x_streamed_finishLength_withUsage: [() => sse([delta('{"routes":[{"title":"A","mechanism":"EXISTING_BUYING_SIGNAL","payer":"P","offer":"O","channel":"C","price":100,"directCost":10,"daysToFirstCash":5},{"title":"B"'), { choices: [{ delta: {}, finish_reason: 'length' }], usage: { completion_tokens: 4000 } }])],
};
const ctx = refCtx(probes().find((c) => c.case === 'probe1_p10_cap')!);
const results: any = {};
for (const [k, responses] of Object.entries(cases)) {
  const { chat, calls } = scripted(responses);
  const raw = await chat([{ role: 'user', content: 'x' }], undefined, 4000);
  const s2 = scripted(responses);
  const asked = await askModel(s2.chat, 'sys', 'user', 4000);
  const parsedRoutes = asked.content ? parseRoutes(routesJson(asked.content), ctx) : null;
  results[k] = {
    chatForOnce: { content: raw.content.slice(0, 160), error: raw.error, completionTokens: raw.completionTokens, resultKeys: Object.keys(raw) },
    askModel: { content: asked.content.slice(0, 160), error: asked.error ?? null, returnedKeys: Object.keys(asked) },
    requests: s2.calls,
    routesKept: parsedRoutes?.routes.map((r) => r.title) ?? null,
    routesRejected: parsedRoutes?.rejected.map((r) => r.rule) ?? null,
  };
  void calls;
}
results.stripThink = {
  closed: stripThink('<think>a</think>{"x":1}'),
  unclosed: stripThink('<think>still reasoning {"x":1}'),
  closeOnly: stripThink('reasoning without open tag</think>{"x":1}'),
};
write('raw/E-015/result.json', results);
console.log(JSON.stringify(results, null, 1));

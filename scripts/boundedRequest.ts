/**
 * One HTTP request with a bound this process actually applies.
 *
 * `fetch` was the obvious thing to use and it cannot do this job. Both hosted
 * verification clients set `AbortSignal.timeout(15 * 60 * 1000)` and both
 * reported, in words, that they had waited fifteen minutes. Neither ever did:
 * undici's **`headersTimeout`** is a separate bound from the signal, it
 * defaults to five minutes, and it is the one that fires. Measured here, on
 * this Node (v22.22.2), against a server that accepts the connection and never
 * answers:
 *
 *     AbortSignal.timeout(400_000)  ->  threw after 300.8s
 *                                       TypeError: fetch failed
 *                                       cause UND_ERR_HEADERS_TIMEOUT
 *
 * Deploy run 274 is that reading twice over: `brain_submit_audit` gave up
 * 320 seconds after the adversarial pass, `brain_submit_synthesis` 336 seconds
 * after the claim before it, and both said "did not answer within 900s". The
 * two failures either side of a restart, the six runs before them, and the
 * §27 entry that reads them as a work item losing a five-minute lease are all
 * the same client-side wall wearing different clothes.
 *
 * Two defects, and the second is the worse one. A bound that does not reach
 * the request it exists for is not a bound — the sentence this repository has
 * had to write seven times. But a bound that then *reports* a wait it never
 * performed is a false measurement, and somebody reading it concludes the
 * judge pass takes longer than fifteen minutes when nothing has ever waited
 * past five.
 *
 * So: `node:http`/`node:https` rather than `fetch`, because there the timeouts
 * are the caller's and there is no default underneath to be surprised by. No
 * dependency is added — `undici`'s `Agent` would also have worked and is not
 * in this repository, and putting one in the production image to configure a
 * timeout is a heavier answer than forty lines of the standard library.
 *
 * **It is not a fix for the slowness and must not be read as one.** What it
 * buys is that the next occurrence either finishes — and the timestamps say
 * what the pass costs — or fails naming the request and the wait it really
 * performed.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface BoundedReply {
  status: number;
  body: string;
  /** Lower-cased, and a repeated header is joined with ', ' as HTTP allows. */
  headers: Record<string, string>;
}

export interface BoundedRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** The whole request, from the first byte sent to the last byte read. */
  timeoutMs: number;
}

/**
 * Redirects are never followed, which is `fetch`'s `redirect: 'manual'` and is
 * what both callers already asked for: the hosted gate asserts on a 302 rather
 * than on wherever it points, and following one would mean a credential
 * travelling to a host nobody checked.
 */
export async function boundedRequest(url: string, init: BoundedRequestInit): Promise<BoundedReply> {
  const target = new URL(url);
  const send = target.protocol === 'http:' ? httpRequest : httpsRequest;
  const started = Date.now();

  /*
   * `content-length` explicitly, because `fetch` set one for a string body and
   * this must not quietly become a chunked request. Nothing on the far side
   * requires it today — `express.json` counts what it buffers — but the point
   * of replacing a client is that the request on the wire stays the request
   * that was being sent.
   *
   * No `accept-encoding`: this client cannot decompress, and HTTP only lets a
   * server compress what the client asked for. Saying nothing is what keeps
   * that true.
   */
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined) {
    headers['content-length'] = String(Buffer.byteLength(init.body, 'utf8'));
  }

  return await new Promise<BoundedReply>((resolve, reject) => {
    let settled = false;
    const waited = () => ((Date.now() - started) / 1000).toFixed(1);

    const req = send(
      target,
      { method: init.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
          }
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers });
        });
        res.on('error', (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          reject(new Error(`the response ended after ${waited()}s: ${error.message}`, { cause: error }));
        });
      },
    );

    /*
     * The only clock in here. `req.setTimeout` is an *inactivity* timer and
     * would cut off exactly the request this exists to let finish — a server
     * that is working and has sent nothing yet is idle by that measure.
     */
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`nothing answered within ${Math.round(init.timeoutMs / 1000)}s`));
    }, init.timeoutMs);

    req.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(new Error(`the connection failed after ${waited()}s: ${error.message}`, { cause: error }));
    });

    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

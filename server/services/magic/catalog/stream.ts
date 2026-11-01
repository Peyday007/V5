/**
 * Incremental extraction of the objects in a top-level JSON array, without
 * ever holding the whole file. It tracks string and brace state byte by byte
 * and yields each element's text, so memory is bounded by one card plus one
 * chunk. Bounded in the other direction too: a single element over
 * `maxObjectBytes` or a stream over `maxTotalBytes` is refused, not truncated.
 */
export class StreamLimitError extends Error {}

export interface StreamOptions {
  maxObjectBytes?: number;
  maxTotalBytes?: number;
  signal?: AbortSignal;
}

export async function* jsonArrayElements(
  chunks: AsyncIterable<Uint8Array>,
  options: StreamOptions = {},
): AsyncGenerator<string> {
  const maxObject = options.maxObjectBytes ?? 4 * 1024 * 1024;
  const maxTotal = options.maxTotalBytes ?? 2 * 1024 * 1024 * 1024;
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false; // saw the opening '['
  let buffer = '';
  for await (const chunk of chunks) {
    if (options.signal?.aborted) throw new Error('cancelled');
    total += chunk.byteLength;
    if (total > maxTotal) throw new StreamLimitError(`The download passed the ${maxTotal} byte limit.`);
    const text = decoder.decode(chunk, { stream: true });
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (!started) {
        if (ch === '[') started = true;
        else if (!/\s/.test(ch)) throw new Error('Expected a JSON array.');
        continue;
      }
      if (depth === 0) {
        if (ch === '{') {
          depth = 1;
          buffer = '{';
        } else if (ch === ']') {
          return;
        }
        continue;
      }
      buffer += ch;
      if (buffer.length > maxObject) throw new StreamLimitError(`One element passed ${maxObject} bytes.`);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          yield buffer;
          buffer = '';
        }
      }
    }
  }
  if (depth !== 0 || !started) throw new Error('The download ended in the middle of the data.');
}

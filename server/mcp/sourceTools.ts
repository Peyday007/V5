/**
 * `brain_fetch_source`: Brain opens a public page for a research worker whose
 * own sandbox cannot.
 *
 * The reader is `services/sources/fetchForWorker.ts`, which says why it exists
 * and what it refuses. This tool adds only the door: a WORKER principal, the
 * `research:read` scope on the project its item actually belongs to, and a
 * **live lease on that item** — so the page is read for research Brain handed
 * out, not for anything a credential holder wanted fetched. It records nothing
 * and decides nothing; the claim the worker files afterwards is judged by the
 * gate exactly as before.
 */
import { notFoundError } from './errors.ts';
import { READ_ONLY, requireOwnedItem, requiredString, workerOnly, type McpTool } from './toolkit.ts';
import { fetchForWorker } from '../services/sources/fetchForWorker.ts';

export const fetchSourceTool: McpTool = {
  name: 'brain_fetch_source',
  title: 'Read a public source through Brain',
  description:
    'Use this when your own environment cannot open a source (DNS failure, proxy 403, ' +
    'allowlist refusal). Brain fetches the public page and returns its text, final URL, ' +
    'status, retrieval time and a hash. You must hold a live lease on the research work item ' +
    'you name. Only public http(s) addresses on ports 80/443 are read. An unreadable page ' +
    'comes back with readable:false and the reason — submit the claim with its retrieval ' +
    'state set, never an inferred page. This changes who opens the page, not which sources ' +
    'your assignment may cite, and it does not judge whether the page supports a claim.',
  inputSchema: {
    type: 'object',
    properties: {
      work_item_id: { type: 'string', description: 'The research item you hold a live lease on.' },
      url: { type: 'string', description: 'The public http(s) URL to read.' },
    },
    required: ['work_item_id', 'url'],
    additionalProperties: false,
  },
  annotations: { title: 'Read a public source through Brain', ...READ_ONLY, openWorldHint: true },
  run: async (args, { principal }) => {
    const workerId = workerOnly(principal);
    const item = await requireOwnedItem(principal, requiredString(args, 'work_item_id'), 'research:read');
    if (!item) throw notFoundError();
    const live =
      item.state === 'LEASED' &&
      item.workerId === workerId &&
      item.leaseExpiresAt !== null &&
      Date.parse(item.leaseExpiresAt) > Date.now();
    // An item this worker does not hold reads exactly like one that does not
    // exist (invariant 23): a credential is not a licence to make Brain fetch.
    if (!live) throw notFoundError();
    const url = requiredString(args, 'url').slice(0, 2048);
    const result = await fetchForWorker(url);
    return { projectId: item.projectId, value: { source: result } };
  },
};

/**
 * Freelancer.com's API, the parts this operation uses.
 *
 * Reading open projects is public and needs no credential, so discovery runs
 * whether or not an account is connected. Everything that acts — a bid, a
 * message, an attachment, a milestone request, accepting an award — goes out
 * under the owner's own account, through `FREELANCER_OAUTH_TOKEN`, a
 * deployment secret read per call and never stored, logged or returned
 * (§17, §54). `FREELANCER_API_BASE` points it at Freelancer's sandbox for a
 * test account.
 *
 * Every call has a bound, and every refusal is reduced to the provider's code
 * and a short message, because provider bodies can echo a request.
 */

export const FREELANCER_TOKEN_ENV = 'FREELANCER_OAUTH_TOKEN';
export const FREELANCER_BASE_ENV = 'FREELANCER_API_BASE';
const DEFAULT_BASE = 'https://www.freelancer.com';
const TIMEOUT_MS = 30_000;

export function freelancerBase(): string {
  const base = process.env[FREELANCER_BASE_ENV]?.trim().replace(/\/+$/, '');
  if (!base) return DEFAULT_BASE;
  // https anywhere (the sandbox), or plain http only to this machine (tests).
  return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(base) || /^http:\/\/127\.0\.0\.1:\d+$/.test(base) ? base : DEFAULT_BASE;
}

export function freelancerToken(): string | null {
  const token = process.env[FREELANCER_TOKEN_ENV]?.trim();
  return token ? token : null;
}

export function freelancerConnected(): { usable: boolean; reason: string } {
  return freelancerToken()
    ? { usable: true, reason: `${FREELANCER_TOKEN_ENV} is set.` }
    : {
        usable: false,
        reason:
          `${FREELANCER_TOKEN_ENV} is not set. Brain reads open jobs without it, and cannot bid, ` +
          'message, deliver or request payment until the owner connects their Freelancer account.',
      };
}

/** A refusal Freelancer stated: nothing happened on its side. */
export class FreelancerRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FreelancerRefused';
  }
}

/** The request may or may not have reached Freelancer: a timeout, a reset, a 5xx. */
export class FreelancerUnknown extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreelancerUnknown';
  }
}

interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT';
  query?: Record<string, string | number | boolean | (string | number)[]>;
  json?: unknown;
  form?: Record<string, string | string[]>;
  files?: { field: string; name: string; bytes: Uint8Array; type: string }[];
  auth?: boolean;
}

function queryString(query: CallOptions['query']): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const one of value) parts.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(one))}`);
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export async function call<T>(path: string, options: CallOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.auth) {
    const token = freelancerToken();
    if (!token) throw new FreelancerRefused(0, 'NOT_CONNECTED', `${FREELANCER_TOKEN_ENV} is not set.`);
    headers['freelancer-oauth-v1'] = token;
  }
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.files) {
    const form = new FormData();
    for (const [key, value] of Object.entries(options.form ?? {})) {
      for (const one of Array.isArray(value) ? value : [value]) form.append(key, one);
    }
    for (const file of options.files) form.append(file.field, new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
    body = form;
  } else if (options.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.form)) {
      for (const one of Array.isArray(value) ? value : [value]) params.append(key, one);
    }
    body = params.toString();
  }
  let response: Response;
  try {
    response = await fetch(`${freelancerBase()}${path}${queryString(options.query)}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new FreelancerUnknown(`Freelancer did not answer: ${(error as Error).name}`);
  }
  type Envelope = { status?: string; result?: T; message?: string; error_code?: string };
  let parsed: Envelope | null = null;
  try {
    parsed = (await response.json()) as Envelope;
  } catch {
    parsed = null;
  }
  if (response.status >= 500) throw new FreelancerUnknown(`Freelancer answered ${response.status}.`);
  if (!response.ok || !parsed || parsed.status !== 'success') {
    if (response.ok && !parsed) throw new FreelancerUnknown('Freelancer answered with a body Brain could not read.');
    throw new FreelancerRefused(
      response.status,
      String(parsed?.error_code ?? 'UNKNOWN'),
      String(parsed?.message ?? `HTTP ${response.status}`).slice(0, 300),
    );
  }
  return parsed.result as T;
}

export interface FreelancerProject {
  id: number;
  owner_id: number;
  title: string;
  seo_url: string;
  status: string;
  frontend_project_status?: string;
  type: string;
  description?: string;
  preview_description?: string;
  currency: { code: string };
  budget: { minimum?: number; maximum?: number };
  bid_stats: { bid_count: number; bid_avg?: number };
  time_submitted: number;
  bidperiod?: number;
  jobs?: { name: string }[];
  upgrades?: Record<string, boolean | null>;
  local?: boolean;
  nonpublic?: boolean;
  language?: string;
}

/** Open projects matching a query. Public: no credential. */
export async function searchProjects(query: string, limit = 50): Promise<FreelancerProject[]> {
  const result = await call<{ projects: FreelancerProject[] }>('/api/projects/0.1/projects/active/', {
    query: {
      query,
      limit,
      full_description: true,
      job_details: true,
      upgrade_details: true,
      compact: true,
    },
  });
  return result.projects ?? [];
}

export async function getProject(id: string | number): Promise<FreelancerProject> {
  return call<FreelancerProject>(`/api/projects/0.1/projects/${id}/`, {
    query: { full_description: true, job_details: true, upgrade_details: true },
  });
}

export async function self(): Promise<{ id: number; username: string }> {
  return call('/api/users/0.1/self/', { auth: true });
}

export interface FreelancerBid {
  id: number;
  project_id: number;
  bidder_id: number;
  amount: number;
  award_status?: string | null;
  retracted?: boolean;
  frontend_bid_status?: string;
}

export async function placeBid(input: {
  projectId: number;
  bidderId: number;
  amount: number;
  period: number;
  description: string;
}): Promise<FreelancerBid> {
  return call<FreelancerBid>('/api/projects/0.1/bids/', {
    method: 'POST',
    auth: true,
    json: {
      project_id: input.projectId,
      bidder_id: input.bidderId,
      amount: input.amount,
      period: input.period,
      description: input.description,
      milestone_percentage: 100,
    },
  });
}

/** This account's bids on one project — how an ambiguous bid is reconciled. */
export async function myBids(projectId: number, bidderId: number): Promise<FreelancerBid[]> {
  const result = await call<{ bids: FreelancerBid[] }>('/api/projects/0.1/bids/', {
    auth: true,
    query: { projects: [projectId], bidders: [bidderId] },
  });
  return result.bids ?? [];
}

export async function acceptAward(bidId: number): Promise<void> {
  await call(`/api/projects/0.1/bids/${bidId}/`, { method: 'PUT', auth: true, query: { action: 'accept' } });
}

export interface FreelancerMessage {
  id: number;
  thread_id: number;
  from_user: number;
  message: string;
  time_created: number;
}

export async function projectThread(projectId: number): Promise<number | null> {
  const result = await call<{ threads: { id: number; context?: { type?: string; id?: number } }[] }>(
    '/api/messages/0.1/threads/',
    { auth: true, query: { context_type: 'project', context: projectId } },
  );
  return result.threads?.[0]?.id ?? null;
}

export async function threadMessages(threadId: number): Promise<FreelancerMessage[]> {
  const result = await call<{ messages: FreelancerMessage[] }>('/api/messages/0.1/messages/', {
    auth: true,
    query: { threads: [threadId], limit: 100 },
  });
  return result.messages ?? [];
}

export async function startThread(employerId: number, projectId: number, message: string): Promise<number> {
  const result = await call<{ id: number }>('/api/messages/0.1/threads/', {
    method: 'POST',
    auth: true,
    form: { 'members[]': [String(employerId)], context_type: 'project', context: String(projectId), message },
  });
  return result.id;
}

export async function postMessage(threadId: number, message: string): Promise<FreelancerMessage> {
  return call<FreelancerMessage>(`/api/messages/0.1/threads/${threadId}/messages/`, {
    method: 'POST',
    auth: true,
    form: { message },
  });
}

export async function postAttachment(
  threadId: number,
  file: { name: string; bytes: Uint8Array; type: string },
): Promise<FreelancerMessage> {
  return call<FreelancerMessage>(`/api/messages/0.1/threads/${threadId}/messages/`, {
    method: 'POST',
    auth: true,
    form: { 'attachments[]': [file.name] },
    files: [{ field: 'files[]', ...file }],
  });
}

export interface FreelancerMilestone {
  transaction_id: number;
  project_id: number;
  bid_id?: number;
  amount: number;
  status: string;
}

export async function projectMilestones(projectId: number): Promise<FreelancerMilestone[]> {
  const result = await call<{ milestones: Record<string, FreelancerMilestone> | FreelancerMilestone[] }>(
    '/api/projects/0.1/milestones/',
    { auth: true, query: { projects: [projectId] } },
  );
  const list = result.milestones ?? [];
  return Array.isArray(list) ? list : Object.values(list);
}

export async function requestMilestone(input: {
  projectId: number;
  bidId: number;
  amount: number;
  description: string;
}): Promise<{ id: number }> {
  return call('/api/projects/0.1/milestone_requests/', {
    method: 'POST',
    auth: true,
    json: { project_id: input.projectId, bid_id: input.bidId, amount: input.amount, description: input.description },
  });
}

export async function requestRelease(milestoneId: number): Promise<void> {
  await call(`/api/projects/0.1/milestones/${milestoneId}/`, {
    method: 'PUT',
    auth: true,
    query: { action: 'request_release' },
  });
}

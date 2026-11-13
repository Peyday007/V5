/**
 * Decomposing a business into observable causal subproblems (CAUSAL-14-7).
 *
 * One vocabulary, used by the HTTP surface for a business a person describes
 * and by the goal portfolio for an opening Brain itself would fulfil, so the
 * links an AI business is decomposed into are the same wherever it is asked.
 */

export interface Subproblem {
  id: string;
  question: string;
  /** The thing that could be seen or measured that would answer it. */
  observable: string;
  dependsOn: string[];
  origin: 'starting' | 'supplied';
  /** UNKNOWN until an observation settles it; what a row states is not an observation. */
  status: 'UNKNOWN';
  /** What the arrangement's own record already says toward it, when it says anything. Never a settlement. */
  stated?: string | null;
}

/**
 * A starting vocabulary of causal links, to be extended and not a checklist: a
 * business that skips one says so, one that needs another adds it, and the model
 * of an AI business uses the same links as any other because its novelty is in the
 * inputs and not in the shape. Each link names what could be observed to settle it.
 */
export const STARTING_LINKS: readonly { id: string; question: string; observable: string; dependsOn: string[] }[] = [
  { id: 'demand', question: 'Who would pay for the output, and how many of them are there?', observable: 'a count of payers from a named source, or priced requests already made', dependsOn: [] },
  { id: 'access', question: 'By what path can those payers be reached or can they reach us?', observable: 'a path that has delivered a conversation, with its provider terms read', dependsOn: ['demand'] },
  { id: 'capability', question: 'Can the AI or supplier produce the output at the required quality?', observable: 'a sample judged against the buyer’s acceptance condition', dependsOn: [] },
  { id: 'unit-cost', question: 'What does one unit of output cost to make, all in?', observable: 'metered cost of producing a unit, from real runs', dependsOn: ['capability'] },
  { id: 'capacity', question: 'How many units can be made and delivered in the period?', observable: 'throughput measured over a period, and the limit that bound it', dependsOn: ['capability'] },
  { id: 'purchase', question: 'What makes a payer agree, and at what price and terms?', observable: 'an agreement, or a refusal with its stated reason', dependsOn: ['access', 'capability'] },
  { id: 'acceptance', question: 'What does the buyer do to accept delivery, and how often is it refused?', observable: 'acceptance and rejection records', dependsOn: ['purchase', 'capacity'] },
  { id: 'payment', question: 'When is payment invoiced, collected and cleared, and what can reverse it?', observable: 'cleared funds against an invoice, and any refund or chargeback', dependsOn: ['acceptance'] },
  { id: 'obligations', question: 'What must be paid out or held back, and when?', observable: 'dated outflows and amounts held against refunds', dependsOn: ['payment'] },
  { id: 'failure', question: 'What shared resource or dependency, if it failed, would stop more than one stream?', observable: 'a named dependency used by more than one stream, with its failure history', dependsOn: ['capability', 'access'] },
];

export type DecomposeResult = { ok: true; subproblems: Subproblem[] } | { ok: false; reason: string; kind: 'bad' | 'unprocessable' };

/**
 * Decompose: drop the starting links the caller says do not apply (each with a
 * reason), add the caller's own subproblems, and check every dependency names a
 * subproblem in the decomposition. `stated` attaches what a record already says
 * toward a link; the link stays UNKNOWN.
 */
export function decompose(
  notApplicable: ReadonlyMap<string, string>,
  supplied: readonly { id: string; question: string; observable: string; dependsOn: string[] }[] = [],
  stated: Readonly<Record<string, string | null>> = {},
): DecomposeResult {
  for (const [id, reason] of notApplicable) {
    if (!STARTING_LINKS.some((link) => link.id === id)) return { ok: false, kind: 'bad', reason: `"notApplicable" names ${id}, which is not a starting link.` };
    if (!reason.trim()) return { ok: false, kind: 'bad', reason: `"notApplicable" for ${id} must say why it does not apply.` };
  }
  const subproblems: Subproblem[] = STARTING_LINKS.filter((link) => !notApplicable.has(link.id)).map((link) => ({
    ...link,
    dependsOn: link.dependsOn.filter((dep) => !notApplicable.has(dep)),
    origin: 'starting' as const,
    status: 'UNKNOWN' as const,
    ...(link.id in stated ? { stated: stated[link.id] ?? null } : {}),
  }));
  const known = new Set(subproblems.map((one) => one.id));
  for (const one of supplied) {
    if (!/^[a-z][a-z0-9-]{1,60}$/.test(one.id)) return { ok: false, kind: 'bad', reason: 'A subproblem id is lowercase words joined by hyphens.' };
    if (known.has(one.id)) return { ok: false, kind: 'bad', reason: `Subproblem ${one.id} already exists.` };
    if (!one.question.trim() || !one.observable.trim()) return { ok: false, kind: 'bad', reason: `Subproblem ${one.id} states its question and what could be observed to answer it.` };
    known.add(one.id);
    subproblems.push({ ...one, origin: 'supplied', status: 'UNKNOWN' });
  }
  for (const one of subproblems) {
    for (const dep of one.dependsOn) if (!known.has(dep)) return { ok: false, kind: 'unprocessable', reason: `Subproblem ${one.id} depends on ${dep}, which is not in this decomposition.` };
  }
  return { ok: true, subproblems };
}

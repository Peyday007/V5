/**
 * Whether the Freelancer operation runs at all.
 *
 * The owner rejected freelance work as a Cash Mode strategy (2026-10-20): Brain
 * does not bid on, prepare, count or ask anybody to connect a freelance
 * marketplace account. Before this switch the operation ran on every Russell
 * tick with no way to stop it short of deleting it — 69 scans and 2 360 jobs
 * screened after the decision — and its prepared bids were read into the Cash
 * job pipeline as execution jobs blocked on `FREELANCER_OAUTH_TOKEN`, so every
 * report asked for exactly the connection the owner had refused.
 *
 * Off unless a deployment sets `BRAIN_FREELANCER_OPERATION=on`. Read per call,
 * so turning it back on needs no redeploy of code, only of the secret.
 *
 * What it stops: the discover/bid/deliver/collect pass and the marketplace
 * jobs' place in the Cash pipeline. What it keeps: every `marketplace_jobs` and
 * `marketplace_deliverables` row, untouched, as history. It is scoped to this
 * one operation and decides nothing else about Cash Mode or Brain.
 */
export const FREELANCER_OPERATION_ENV = 'BRAIN_FREELANCER_OPERATION';

export function freelancerOperationEnabled(): boolean {
  return (process.env[FREELANCER_OPERATION_ENV] ?? '').trim().toLowerCase() === 'on';
}

/** One sentence for a report or a page saying why nothing is happening. */
export const FREELANCER_OPERATION_OFF =
  `The Freelancer operation is off: the owner rejected freelance work for Cash Mode. ` +
  `Its earlier rows are kept as history. ${FREELANCER_OPERATION_ENV}=on turns it back on.`;

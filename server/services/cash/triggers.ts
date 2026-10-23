/**
 * Triggers: jobs nobody posted.
 *
 * Most businesses never ask for help in public, but something happens to them
 * that means they need it soon — a job ad nobody could fill, a platform they
 * depend on shutting down, the same complaint in every review. A trigger is a
 * discovery bucket that asks for *specific named businesses* where one such
 * event happened recently, what job it implies, and a published business
 * contact. Every answer is still a published, dated artefact through the same
 * evidence gate: a trigger asks where to look, never what to conclude.
 *
 * Off until the free-model lane is connected (`triggersEnabled`). Which
 * triggers pay is read from rows on the scoreboard; a
 * trigger that never produces a candidate is visible as such.
 */
import type { SearchBucket } from './discovery.ts';

/**
 * On once the free-model lane is connected, because the lane is what sorts
 * the volume triggers produce (the owner, 2026-10-23: "make it start when I
 * add the free APIs"). `BRAIN_TRIGGERS=on` forces it on, `off` holds it off.
 */
export function triggersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env['BRAIN_TRIGGERS']?.trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return Boolean(env['BRAIN_CHEAP_LLM_URL']?.trim());
}

const ASK =
  'Name each specific business, the date of the event and the source that shows it, the exact ' +
  'job it now needs done, why it needs it soon, and a business email or contact page the ' +
  'business itself publishes. Only events from the last 30 days, and only work deliverable by ' +
  'email as documents, spreadsheets, data, simple websites or graphics?';

export const TRIGGER_BUCKETS: readonly SearchBucket[] = Object.freeze([
  {
    id: 'trigger-stale-job-post',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    deliverable: 'DATASET',
    title: 'Small businesses with a job ad nobody has filled',
    question:
      'Which small businesses have had the same job posting open for 45 days or more for work ' +
      'that is really a bounded task (data entry, spreadsheets, reports, listings, simple web ' +
      `updates), so they would likely pay to have the task done instead? ${ASK}`,
  },
  {
    id: 'trigger-platform-sunset',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    deliverable: 'DATASET',
    title: 'Businesses stuck on a tool that is shutting down',
    question:
      'Which specific businesses publicly use a software product, plugin, website builder or ' +
      'marketplace that has announced it is shutting down, removing a feature or forcing a ' +
      `migration by a stated date, so they must move their data or rebuild a page? ${ASK}`,
  },
  {
    id: 'trigger-review-complaint',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    deliverable: 'WEBSITE',
    title: 'Businesses whose reviews keep naming the same fixable problem',
    question:
      'Which specific small businesses have several recent public reviews naming the same ' +
      'fixable problem — wrong hours, no online booking, no price list, an unusable website, ' +
      `slow replies to quote requests — that a document, page or simple tool would fix? ${ASK}`,
  },
  {
    id: 'trigger-new-location',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    deliverable: 'WEBSITE',
    title: 'Businesses that just opened or announced a new location',
    question:
      'Which specific businesses have just filed, announced or opened a new location, licence ' +
      'or permit, and do not yet have a page, listing, menu, price sheet or forms for it? ' +
      ASK,
  },
  {
    id: 'trigger-new-rule',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    deliverable: 'DOCUMENT',
    title: 'Named businesses a new rule hits before a deadline',
    question:
      'Which specific businesses, by name, fall under a newly published rule, standard or ' +
      'platform policy that requires a document, notice, policy page or data file by a stated ' +
      `date, and have not yet published one? ${ASK}`,
  },
  {
    id: 'trigger-funded-hiring-sales',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    deliverable: 'DATASET',
    title: 'Small companies that just raised money and are hiring salespeople',
    question:
      'Which specific small companies have recently announced funding and are hiring sales or ' +
      'business-development staff, so they need lead lists, prospect research or outreach ' +
      `material now? ${ASK}`,
  },
  {
    id: 'trigger-leadership-change',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    deliverable: 'SPREADSHEET',
    title: 'Small companies with a new owner or new operations lead',
    question:
      'Which specific small companies have publicly announced a new owner, CEO, operations or ' +
      'finance lead in the last 30 days — the period when a new leader buys reports, trackers ' +
      `and process documents? ${ASK}`,
  },
  {
    id: 'trigger-competitor-move',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    deliverable: 'DOCUMENT',
    title: 'Businesses whose direct competitor just changed the game',
    question:
      'Which specific small businesses have a direct local or niche competitor that just ' +
      'launched online booking, a new price list, a new site or a new offer, leaving them ' +
      `visibly behind on the same page or listing? ${ASK}`,
  },
]);

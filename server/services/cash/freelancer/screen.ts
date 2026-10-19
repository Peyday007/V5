/**
 * Whether Brain can deliver a Freelancer job by itself, decided before any bid.
 *
 * Pure over the project as Freelancer published it and the capabilities Brain
 * has proved in this process. The rule is the owner's: a job whose only
 * delivery plan is a person's labour is rejected, not bid on. What Brain can
 * deliver is a research report (the research pipeline, §12) or one of the
 * deliverable kinds whose sample rendered and passed verification
 * (`deliverables/capabilities.ts`). A category name is never a rejection by
 * itself; a capability Brain has not proved, or a blocker in this particular
 * job, is.
 *
 * It fails toward rejection. A missed job costs one bid; a won job nobody can
 * deliver costs a refund, a review and the account's standing.
 */
import type { FreelancerProject } from './client.ts';
import { absorbs, blockersOf, deliverablesOf, namedDeliverables, scoreCategories, CATEGORY_LABEL, codeLanguageOf, needsClientFiles, type JobCategory } from './classify.ts';
import { MAX_BID_USD, MIN_BUDGET_USD, MIN_NET_USD, priceJob, quoteOf, type JobEconomics } from './economics.ts';
import type { DeliverableKind } from './deliverables/spec.ts';

export { MAX_BID_USD, MIN_BUDGET_USD };
export const MAX_AGE_HOURS = 72;
export const MAX_BIDS_ALREADY = 60;
/** One job delivers at most this many kinds of file, e.g. a business plan and its financial model. */
export const MAX_CATEGORIES = 2;

export interface ScreenContext {
  /** Which deliverable kinds passed their proof in this process. */
  available: ReadonlySet<DeliverableKind>;
  /** Whether Brain can parse Python here, so it can check Python before delivering it. */
  python: boolean;
  /**
   * Whether Brain has read a real client attachment through Freelancer's live
   * API. Until it has, jobs needing client files are admitted only while no
   * other such job is active (`clientFileJobsActive`), so the first one is the proof.
   */
  clientFilesProven: boolean;
  clientFileJobsActive: number;
}

/** What the screen assumed before deliverables existed: research reports only. */
export const RESEARCH_ONLY: ScreenContext = { available: new Set(), python: false, clientFilesProven: false, clientFileJobsActive: 1 };

export interface ScreenVerdict {
  deliverable: boolean;
  reasons: string[];
  /** What Brain would deliver, in order. Empty when rejected. */
  categories: JobCategory[];
  needsClientFiles: boolean;
  economics: JobEconomics | null;
}

/**
 * Research is chosen only when the job asks for desk research in its own
 * words; a category tag alone is not enough, because freelancers tag almost
 * anything "Research".
 */
function chooseCategories(found: ReturnType<typeof scoreCategories>, text: string): JobCategory[] {
  const research = /\b(market research|market analysis|competitor|competitive (?:analysis|landscape|research)|industry (?:analysis|report|research|overview)|research report|feasibility|desk research|business research|web research|online research|market sizing|market size|comparison report)\b/.test(text);
  const kinds = deliverablesOf(found);
  // A research report and a business document are one deliverable: the research path writes it.
  if (research && kinds.every((k) => k === 'DOCUMENT')) return ['RESEARCH_REPORT'];
  // Research alongside another kind is written up as a document beside it: the
  // research pipeline files Markdown, and cannot produce a workbook or a deck.
  if (research && !kinds.includes('DOCUMENT')) return (['DOCUMENT', ...kinds] as JobCategory[]).slice(0, 3);
  return kinds.slice(0, 3);
}

export function screenProject(project: FreelancerProject, nowMs: number, context: ScreenContext = RESEARCH_ONLY): ScreenVerdict {
  const reasons: string[] = [];
  const open = project.status === 'active' && (project.frontend_project_status ?? 'open') === 'open';
  if (!open) reasons.push(`not open (${project.status}/${project.frontend_project_status ?? '-'})`);
  if (project.type !== 'fixed') reasons.push('hourly work needs a person on the clock');
  const quote = quoteOf(project.currency);
  if (!quote) reasons.push(`priced in ${project.currency?.code ?? 'an unknown currency'} with no published exchange rate`);
  const min = project.budget?.minimum ?? 0;
  if (quote && min * quote.usdPerUnit < MIN_BUDGET_USD) reasons.push(`budget starts below USD ${MIN_BUDGET_USD}`);
  const ageHours = (nowMs / 1000 - project.time_submitted) / 3600;
  if (ageHours > MAX_AGE_HOURS) reasons.push(`posted ${Math.round(ageHours)}h ago`);
  if ((project.bid_stats?.bid_count ?? 0) > MAX_BIDS_ALREADY) reasons.push(`${project.bid_stats.bid_count} bids already`);
  if (project.local) reasons.push('a local job');
  if (project.nonpublic) reasons.push('not public');
  const upgrades = project.upgrades ?? {};
  for (const flag of ['NDA', 'pf_only', 'qualified', 'sealed', 'enterprise', 'recruiter', 'assisted']) {
    if (upgrades[flag]) reasons.push(`marked ${flag}`);
  }
  if (project.language && project.language !== 'en') reasons.push(`written in ${project.language}`);

  const tags = (project.jobs ?? []).map((one) => one.name.toLowerCase());
  const text = `${project.title}\n${project.description ?? project.preview_description ?? ''}`.toLowerCase();
  const found = scoreCategories(tags, text);
  const categories = chooseCategories(found, text);
  if (categories.length === 0) reasons.push('the request asks for nothing Brain delivers: no research report or deliverable kind in it');
  if (categories.length > MAX_CATEGORIES) reasons.push(`it asks for ${categories.map((c) => CATEGORY_LABEL[c]).join(', ')}: more kinds of deliverable than Brain takes in one job`);
  for (const category of categories) {
    if (category === 'RESEARCH_REPORT') continue;
    if (!context.available.has(category)) reasons.push(`delivery needs ${CATEGORY_LABEL[category]}, which Brain has not proved it can deliver`);
  }
  if (categories.includes('CODE')) {
    const language = codeLanguageOf(text);
    if (!language) reasons.push('the program’s language is not one Brain checks before delivering (Python or JavaScript)');
    else if (language === 'python' && !context.python) reasons.push('Python cannot be checked on this machine, so Python work is not delivered');
  }
  // A kind the client tagged that Brain would not deliver means the job asks for
  // more than Brain would hand over; and its blockers apply whether or not it is delivered.
  const tagged = [
    ...new Set([
      ...found.filter((s) => s.tagHits > 0 && s.category !== 'RESEARCH_REPORT').map((s) => s.category),
      ...namedDeliverables(text),
    ]),
  ];
  for (const kind of tagged) {
    if (categories.length && !categories.includes(kind) && !categories.some((c) => absorbs(c, kind)) && !(kind === 'DOCUMENT' && categories.includes('RESEARCH_REPORT'))) {
      reasons.push(`it also asks for ${CATEGORY_LABEL[kind]}, which this job's deliverable would not cover`);
    }
  }
  const files = needsClientFiles(text);
  // Large data is processed by Brain's pipeline over the client's own file; it
  // only blocks when the rows would have to be gathered by hand.
  reasons.push(...blockersOf(tags, text, [...new Set([...categories, ...tagged])]).filter((r) => !(files && /larger than Brain can pass/.test(r))));
  if (files && !context.clientFilesProven && context.clientFileJobsActive > 0) {
    reasons.push('delivery needs files the client sends, and Brain is already proving it can read those on another job');
  }

  let economics: JobEconomics | null = null;
  if (quote && reasons.length === 0) {
    economics = priceJob({
      quote,
      budgetMin: min,
      budgetMax: project.budget?.maximum ?? null,
      bidAvg: project.bid_stats?.bid_avg ?? null,
      categories,
    });
    if (economics.netUsd < MIN_NET_USD) reasons.push(`after Freelancer’s fee the bid nets USD ${economics.netUsd}, below USD ${MIN_NET_USD}`);
  }
  const deliverable = reasons.length === 0;
  return {
    deliverable,
    reasons: deliverable ? [`a ${categories.map((c) => CATEGORY_LABEL[c]).join(' and ')} Brain can produce and verify`] : reasons,
    categories: deliverable ? categories : [],
    needsClientFiles: files,
    economics: deliverable ? economics : null,
  };
}

/** The research-era bid helper, kept for callers that price a USD research job. */
export function bidAmount(project: FreelancerProject): number {
  const quote = quoteOf(project.currency) ?? { code: 'USD', usdPerUnit: 1, source: 'FREELANCER_PROJECT' as const };
  return priceJob({
    quote,
    budgetMin: project.budget?.minimum ?? MIN_BUDGET_USD,
    budgetMax: project.budget?.maximum ?? null,
    bidAvg: project.bid_stats?.bid_avg ?? null,
    categories: ['RESEARCH_REPORT'],
  }).bid;
}

export function bidPeriodDays(project: FreelancerProject): number {
  return Math.min(Math.max(project.bidperiod ?? 4, 3), 7);
}

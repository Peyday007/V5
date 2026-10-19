/**
 * Whether Brain can deliver a Freelancer job by itself, decided before any bid.
 *
 * Pure over the project as Freelancer published it. The rule is the owner's:
 * a job whose only delivery plan is a person's labour is rejected, not bid on.
 * What Brain can deliver unattended is a written research deliverable built
 * from public sources — a report, an analysis, a comparison, a summary — which
 * is exactly what the research pipeline produces and audits (§12). So a job is
 * DELIVERABLE only when it asks for that, and every other job is REJECTED with
 * the reasons, so the same job is not screened twice and anybody can read why.
 *
 * It fails toward rejection. A missed job costs one bid; a won job nobody can
 * deliver costs a refund, a review and the account's standing.
 */
import type { FreelancerProject } from './client.ts';

/** The ledger's currency. Another currency is rejected rather than converted. */
export const SCREEN_CURRENCY = 'USD';
export const MIN_BUDGET_USD = 30;
export const MAX_BID_USD = 250;
export const MAX_AGE_HOURS = 72;
export const MAX_BIDS_ALREADY = 60;

/** Freelancer job categories whose deliverable is a written research product. */
const RESEARCH_JOBS = new Set([
  'research',
  'market research',
  'research writing',
  'web search',
  'report writing',
  'business analysis',
  'competitive analysis',
  'business plans',
  'technical writing',
  'white papers',
]);

/** Categories that mean delivery needs something Brain does not have. */
const BLOCKING_JOBS = new Set([
  'local job',
  'video services',
  'video editing',
  'animation',
  'graphic design',
  'logo design',
  'photoshop',
  'illustrator',
  'website design',
  'wordpress',
  'php',
  'html',
  'javascript',
  'mobile app development',
  'telemarketing',
  'phone support',
  'sales',
  'data entry',
  'web scraping',
  'virtual assistant',
  'voice talent',
  'photography',
  'field technical support',
  'data collection',
  'translation',
  'transcription',
  'recruitment',
  'lead generation',
  '3d rendering',
  '3d modelling',
  'business plan writing',
  'excel',
  'financial modeling',
]);

/**
 * Phrases in the request that mean the work needs a person, a file Brain cannot
 * receive yet, access to the client's systems, or academic work done for a
 * student. Word-bounded and lower-cased.
 */
const BLOCKING_PHRASES: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(call|calls|phone|zoom|meeting|meetings|interview|interviews|on-?site|in person|visit)\b/, reason: 'delivery needs calls, meetings or presence' },
  { pattern: /\b(attached|attachment|i will send|will provide (?:the )?files?|upload(?:ed)? files?|my files|pdfs? (?:i|we) (?:have|will))\b/, reason: 'delivery needs files the client sends, which Brain cannot receive yet' },
  { pattern: /\b(login|log in|access to (?:my|our)|admin access|credentials|my account|our account)\b/, reason: 'delivery needs access to the client’s systems' },
  { pattern: /\b(essay|assignment|homework|thesis|dissertation|coursework|exam|university paper|my paper|plagiarism)\b/, reason: 'academic work done for a student is refused' },
  { pattern: /\b(video|youtube|tiktok|reel|voice ?over|podcast|logo|design|figma|canva)\b/, reason: 'delivery is media or design, not a written report' },
  { pattern: /\b(cold call|outreach to|contact (?:businesses|companies|leads)|send emails|email list|leads with emails|book appointments)\b/, reason: 'delivery means contacting people on the client’s behalf' },
  { pattern: /\bwikipedia\b/, reason: 'paid Wikipedia editing breaks Wikipedia\u2019s own rules' },
  { pattern: /\b(medical|clinical|legal advice|lawyer|attorney|tax|transfer pricing|accounting|accountant|certified|licensed|cpa|specialist)\b/, reason: 'the work needs a professional credential' },
  { pattern: /\b(simulation|matlab|omnet|python|code|coding|software|script)\b/, reason: 'delivery needs software built or run' },
  { pattern: /\b(excel|google sheets|spreadsheets?|financial (?:models?|projections?)|p&l|cash-?flow|break-?even|valuation|dcf)\b/, reason: 'delivery needs a financial model or spreadsheet, not a report' },
  { pattern: /\b(business plan|pitch deck|investor-ready|presentation|slides|powerpoint)\b/, reason: 'delivery is a business plan or deck, not a research report' },
  { pattern: /\b(3d|render(?:ing)?s?|cad)\b/, reason: 'delivery is media or design, not a written report' },
  { pattern: /\b(ghostwrit|blog posts?|articles? writer|seo content|product descriptions?)\w*\b/, reason: 'content writing is not a research report' },
  { pattern: /\b(native speaker|must be from|only from|us only|uk only|resident of)\b/, reason: 'the client restricts who may do the work' },
];

/**
 * The request must say, in its own words, that it wants research from public
 * sources. A category alone is not enough: freelancers tag almost anything
 * "Research".
 */
const RESEARCH_INTENT =
  /\b(market research|market analysis|competitor|competitive (?:analysis|landscape|research)|industry (?:analysis|report|research|overview)|research report|feasibility|market landscape|landscape (?:analysis|report)|benchmark(?:ing)?|desk research|business research|web research|online research|market sizing|market size|comparison report|compare (?:the )?(?:top|best|leading))\b/;

export interface ScreenVerdict {
  deliverable: boolean;
  reasons: string[];
}

export function screenProject(project: FreelancerProject, nowMs: number): ScreenVerdict {
  const reasons: string[] = [];
  const open = project.status === 'active' && (project.frontend_project_status ?? 'open') === 'open';
  if (!open) reasons.push(`not open (${project.status}/${project.frontend_project_status ?? '-'})`);
  if (project.type !== 'fixed') reasons.push('hourly work needs a person on the clock');
  if (project.currency?.code !== SCREEN_CURRENCY) reasons.push(`priced in ${project.currency?.code}, not ${SCREEN_CURRENCY}`);
  const min = project.budget?.minimum ?? 0;
  if (min < MIN_BUDGET_USD) reasons.push(`budget starts below ${MIN_BUDGET_USD}`);
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

  const jobs = (project.jobs ?? []).map((one) => one.name.toLowerCase());
  const blocking = jobs.filter((one) => BLOCKING_JOBS.has(one));
  if (blocking.length > 0) reasons.push(`needs ${blocking.join(', ')}`);
  if (!jobs.some((one) => RESEARCH_JOBS.has(one))) reasons.push('no research or report category');

  const text0 = `${project.title}\n${project.description ?? project.preview_description ?? ''}`.toLowerCase();
  if (!RESEARCH_INTENT.test(text0)) reasons.push('the request does not ask for desk research Brain can produce');
  const text = `${project.title}\n${project.description ?? project.preview_description ?? ''}`.toLowerCase();
  for (const one of BLOCKING_PHRASES) if (one.pattern.test(text)) reasons.push(one.reason);

  return { deliverable: reasons.length === 0, reasons: reasons.length ? reasons : ['a written research deliverable Brain can produce from public sources'] };
}

/**
 * The bid: inside the published budget, under the ceiling, and a little under
 * the average already bid where there is one. Whole dollars.
 */
export function bidAmount(project: FreelancerProject): number {
  const min = Math.max(project.budget?.minimum ?? MIN_BUDGET_USD, MIN_BUDGET_USD);
  const max = Math.min(project.budget?.maximum ?? min, MAX_BID_USD);
  const avg = project.bid_stats?.bid_avg;
  const target = avg && avg > 0 ? avg * 0.9 : min + (max - min) * 0.3;
  return Math.round(Math.min(Math.max(target, min), Math.max(min, max)));
}

export function bidPeriodDays(project: FreelancerProject): number {
  return Math.min(Math.max(project.bidperiod ?? 4, 3), 5);
}

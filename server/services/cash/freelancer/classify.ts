/**
 * What kind of deliverable a Freelancer job asks for, and what would stop
 * Brain delivering it — read from the job's own tags and words.
 *
 * Two separate questions, deliberately. `categoriesOf` says what is being
 * asked for; `blockersOf` says what about this particular job needs something
 * Brain does not have: a person on a call, access to the client's systems,
 * hosting, a credential, a likeness, an account on a platform. A category name
 * is never a rejection by itself: whether Brain can deliver a category is a
 * capability reading (`deliverables/capabilities.ts`), and whether this job is
 * inside it is decided by the blockers.
 *
 * It fails toward rejection, as the screen always has. A missed job costs one
 * bid; a won job nobody can deliver costs a refund, a review and the
 * account's standing.
 */
import type { DeliverableKind } from './deliverables/spec.ts';

export type JobCategory = 'RESEARCH_REPORT' | DeliverableKind;

export const CATEGORY_LABEL: Record<JobCategory, string> = {
  RESEARCH_REPORT: 'research report',
  SPREADSHEET: 'spreadsheet',
  DOCUMENT: 'business document',
  PRESENTATION: 'presentation',
  DATASET: 'data operations',
  WEBSITE: 'website',
  CODE: 'programming',
  GRAPHIC: 'graphic design',
  MODEL_3D: '3D model',
};

interface Signal {
  tags: string[];
  words: RegExp;
}

/** Freelancer's own job tags, lower-cased, and the words a client uses for each kind. */
const SIGNALS: Record<JobCategory, Signal> = {
  RESEARCH_REPORT: {
    tags: ['research', 'market research', 'research writing', 'web search', 'business analysis', 'competitive analysis', 'report writing'],
    words: /\b(market research|market analysis|competitor|competitive (?:analysis|landscape|research)|industry (?:analysis|report|research|overview)|research report|feasibility|market landscape|landscape (?:analysis|report)|benchmark(?:ing)?|desk research|business research|web research|online research|market sizing|market size|comparison report|compare (?:the )?(?:top|best|leading))\b/,
  },
  SPREADSHEET: {
    tags: ['excel', 'spreadsheets', 'google sheets', 'financial modeling', 'financial analysis', 'microsoft excel'],
    words: /\b(excel|spreadsheets?|google sheets?|xlsx|financial (?:models?|projections?|forecasts?)|cash-?flow (?:model|forecast|projection)|budget(?:ing)? (?:template|sheet|model)|pricing (?:calculator|sheet|model)|formulas?|pivot tables?|break-?even (?:analysis|model)|p&l (?:model|template)|3-?statement)\b/,
  },
  DOCUMENT: {
    tags: ['business plans', 'business plan writing', 'proposal writing', 'technical writing', 'white papers', 'business writing', 'grant writing', 'report writing', 'research writing'],
    // "proposal" only as a document someone wants written: "submit your
    // proposal" is Freelancer's own boilerplate for a bid, on every kind of job.
    words: /\b(business plan|(?<!(?:your|submit|send|bid|bidding) )proposal(?! through)|white ?paper|report|standard operating procedures?|sops?|policy document|company profile|executive summary|user manual|handbook|case study|grant application|rfp response|tender document)\b/,
  },
  PRESENTATION: {
    tags: ['powerpoint', 'presentations', 'pitch deck', 'google slides', 'presentation design'],
    words: /\b(power ?point|pptx?|pitch deck|slide ?deck|slides|presentation|google slides|investor deck|sales deck)\b/,
  },
  DATASET: {
    tags: ['data entry', 'data cleansing', 'data cleaning', 'data processing', 'data analysis', 'data management', 'data mining', 'data extraction', 'web scraping', 'data visualization', 'excel vba'],
    words: /\b(data (?:entry|cleaning|cleansing|extraction|conversion|processing|analysis|mining|scraping|collection|visuali[sz]ation)|clean (?:up )?(?:the |my |this )?(?:data|list|spreadsheet|csv)|scrap(?:e|ing)|csv|json|convert (?:pdfs?|data|files?) (?:to|into)|pdf to (?:excel|csv|word)|dedup(?:e|licat)|compile a (?:list|database)|build a (?:list|database))\b/,
  },
  WEBSITE: {
    tags: ['html', 'css', 'website design', 'web design', 'landing pages', 'html5', 'frontend development', 'web development'],
    words: /\b(landing page|one-?page (?:site|website)|single-?page (?:site|website)|static (?:site|website)|html(?:5)?(?: ?\/ ?| and )?css|coming soon page|portfolio (?:site|website)|html email (?:template)?|email template|web page|website)\b/,
  },
  CODE: {
    tags: ['python', 'javascript', 'node.js', 'software development', 'scripting & automation', 'automation', 'api', 'api integration', 'bug fixing', 'typescript'],
    words: /\b(python|javascript|node(?:\.js)?|script|automat(?:e|ion)|api integration|bug fix|fix (?:a |the |my )?bug|command[- ]line tool|cli tool|parser|scraper)\b/,
  },
  GRAPHIC: {
    tags: ['graphic design', 'logo design', 'banner design', 'flyer design', 'poster design', 'illustrator', 'adobe illustrator', 'social media graphics', 'brochure design', 'infographics', 'canva', 'vector design'],
    words: /\b(logo|banner|flyer|poster|social media (?:graphics?|posts? design|creatives?)|ad (?:graphics?|creatives?|design)|infographic|brochure|business card|thumbnail|vector|svg|icon set|instagram post design)\b/,
  },
  MODEL_3D: {
    tags: ['3d modelling', '3d rendering', '3d design', 'blender', '3d visualization', '3d model maker', '3d modeling'],
    words: /\b(3d (?:model(?:l?ing)?|render(?:ing)?s?|design|visuali[sz]ation|mock-?up)|blender|stl|obj file|gltf|glb)\b/,
  },
};

export interface CategoryScore {
  category: JobCategory;
  score: number;
  tagHits: number;
}

/** Which categories a job mentions, strongest signal first. A tag counts double. */
export function scoreCategories(tags: string[], text: string): CategoryScore[] {
  const scored: CategoryScore[] = [];
  for (const [category, signal] of Object.entries(SIGNALS) as [JobCategory, Signal][]) {
    const tagHits = tags.filter((t) => signal.tags.includes(t)).length;
    const wordHits = (text.match(new RegExp(signal.words.source, 'g')) ?? []).length;
    const score = tagHits * 2 + Math.min(wordHits, 4);
    if (score > 0) scored.push({ category, score, tagHits });
  }
  return scored.sort((a, b) => b.score - a.score);
}

export function categoriesOf(tags: string[], text: string): JobCategory[] {
  return scoreCategories(tags, text).map((s) => s.category);
}

/**
 * Pairs that are one deliverable, not two: a cleaned dataset delivered as a
 * workbook is a spreadsheet job, a script that processes data is a program, a
 * website carries its own scripts and graphics. The stronger of the pair stays.
 */
const ONE_DELIVERABLE: [JobCategory, JobCategory][] = [
  ['SPREADSHEET', 'DATASET'],
  ['CODE', 'DATASET'],
  ['WEBSITE', 'CODE'],
  ['WEBSITE', 'GRAPHIC'],
  ['PRESENTATION', 'GRAPHIC'],
  ['DOCUMENT', 'GRAPHIC'],
];

/**
 * The deliverables a job asks for: the strongest kind, plus a second only when
 * it carries a job tag and a strong signal of its own — a CSV the client sends
 * as input is not a dataset they want back.
 */
/** Whether two kinds are one deliverable (see ONE_DELIVERABLE). */
export function absorbs(a: JobCategory, b: JobCategory): boolean {
  return ONE_DELIVERABLE.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

export function deliverablesOf(scores: CategoryScore[]): JobCategory[] {
  const kinds = scores.filter((s) => s.category !== 'RESEARCH_REPORT');
  const out: JobCategory[] = [];
  for (const s of kinds) {
    if (out.length > 0 && (s.tagHits === 0 || s.score < 3)) continue;
    if (out.some((kept) => ONE_DELIVERABLE.some(([a, b]) => (a === kept && b === s.category) || (b === kept && a === s.category)))) continue;
    out.push(s.category);
  }
  return out;
}

interface Blocker {
  pattern: RegExp;
  reason: string;
  /** Only for these categories; every category when absent. */
  only?: JobCategory[];
}

/** Tags that mean the job needs a person, a platform account or a capability Brain does not have. */
export const BLOCKING_TAGS: Record<string, string> = {
  'local job': 'a local job needs somebody present',
  'video services': 'video production is not a capability Brain has',
  'video editing': 'video production is not a capability Brain has',
  'video production': 'video production is not a capability Brain has',
  animation: 'animation is not a capability Brain has',
  '3d animation': 'animation is not a capability Brain has',
  'after effects': 'video production is not a capability Brain has',
  'voice talent': 'a voice needs a person',
  'voice over': 'a voice needs a person',
  telemarketing: 'telemarketing needs a person on the phone',
  'phone support': 'phone support needs a person',
  sales: 'selling on the client’s behalf needs a person',
  'lead generation': 'lead generation means contacting or listing people on the client’s behalf',
  recruitment: 'recruitment needs a person',
  'virtual assistant': 'virtual assistance means ongoing access to the client’s accounts',
  photography: 'photography needs somebody present',
  'field technical support': 'field support needs somebody present',
  translation: 'translation is not yet a verified capability',
  transcription: 'transcription needs audio Brain cannot hear',
  wordpress: 'WordPress work needs access to the client’s site',
  shopify: 'Shopify work needs access to the client’s store',
  wix: 'Wix work needs access to the client’s site',
  php: 'PHP work needs a server Brain cannot run',
  'mobile app development': 'mobile apps are outside what Brain can build and test',
  android: 'mobile apps are outside what Brain can build and test',
  iphone: 'mobile apps are outside what Brain can build and test',
  'ios development': 'mobile apps are outside what Brain can build and test',
  'game development': 'games are outside what Brain can build and test',
  unity: 'games are outside what Brain can build and test',
  'unreal engine': 'games are outside what Brain can build and test',
  blockchain: 'blockchain work carries financial risk Brain does not take',
  'smart contracts': 'blockchain work carries financial risk Brain does not take',
  seo: 'SEO needs ongoing access to the client’s site',
  'social media marketing': 'social media marketing means posting from the client’s accounts',
  'social media management': 'social media management means posting from the client’s accounts',
  'email marketing': 'email marketing means sending on the client’s behalf',
  autocad: 'engineering CAD is outside the 3D Brain produces',
  solidworks: 'engineering CAD is outside the 3D Brain produces',
  'cad/cam': 'engineering CAD is outside the 3D Brain produces',
  'fusion 360': 'engineering CAD is outside the 3D Brain produces',
  revit: 'architectural CAD is outside the 3D Brain produces',
  'interior design': 'interior design needs judgement on a real space',
  'architectural rendering': 'architectural visualisation is outside the 3D Brain produces',
  'photo editing': 'photo retouching is not a capability Brain has',
  'photo retouching': 'photo retouching is not a capability Brain has',
  illustration: 'drawn illustration is not a capability Brain has',
  'character design': 'character design is not a capability Brain has',
  bookkeeping: 'bookkeeping needs access to the client’s books',
  accounting: 'accounting needs a professional credential',
  quickbooks: 'bookkeeping needs access to the client’s books',
  xero: 'bookkeeping needs access to the client’s books',
  'content writing': 'content writing is not one of Brain’s verified categories',
  'article writing': 'content writing is not one of Brain’s verified categories',
  ghostwriting: 'content writing is not one of Brain’s verified categories',
  copywriting: 'content writing is not one of Brain’s verified categories',
  'academic writing': 'academic writing is refused',
  'scientific writing': 'academic writing is refused',
  'article rewriting': 'rewriting somebody’s text to pass as new is refused',
  'pcb layout': 'electronics design needs a qualified engineer and EDA tools',
  electronics: 'electronics design needs a qualified engineer and EDA tools',
  'altium designer': 'electronics design needs a qualified engineer and EDA tools',
  'building inspection': 'an inspection needs somebody present',
  typescript: 'TypeScript is not a language Brain checks before delivering',
  manufacturing: 'manufacturing is physical production Brain does not do',
  'product sourcing': 'product sourcing means dealing with suppliers on the client’s behalf',
  'fashion design': 'fashion design is not a capability Brain has',
  'textile engineering': 'the work needs a qualified engineer',
  'fashion consulting': 'fashion consulting is not a capability Brain has',
  'test automation': 'test automation runs against the client’s own application',
  // Production, 2026-10-21: "Premium Service Google Ad Campaign" reached
  // PREPARED. A campaign runs inside the client's ad account and spends the
  // client's budget; nothing Brain renders is the campaign.
  'google adwords': 'running ads needs the client’s ad account and their ad spend',
  'google ads': 'running ads needs the client’s ad account and their ad spend',
  ppc: 'running ads needs the client’s ad account and their ad spend',
  'facebook ads': 'running ads needs the client’s ad account and their ad spend',
  'facebook marketing': 'running ads needs the client’s ad account and their ad spend',
  'digital marketing': 'marketing means acting from the client’s accounts',
  'internet marketing': 'marketing means acting from the client’s accounts',
  origami: 'a folding design has to be folded to be checked, which Brain cannot do',
  'arts & crafts': 'a craft design has to be made to be checked, which Brain cannot do',
};

/** Engineering disciplines whose work needs a qualified engineer, whatever the deliverable looks like. */
const ENGINEERING_TAG = /\b(civil|structural|electrical|mechanical|chemical|building|construction|petroleum|aerospace|automotive|marine) engineering\b|\bpcb\b|\bcircuit design\b/;

const BLOCKERS: Blocker[] = [
  { pattern: /\b(call|calls|phone|zoom|google meet|meeting|meetings|interview|interviews|on-?site|in person|visit|present (?:to|at))\b/, reason: 'delivery needs calls, meetings or presence' },
  { pattern: /\b(login|log in|access to (?:my|our)|admin (?:access|panel)|credentials|my account|our account|cpanel|ftp|ssh|hosting|deploy(?:ment)?|domain setup|server setup|aws|azure|vps)\b/, reason: 'delivery needs access to the client’s systems or hosting' },
  { pattern: /\b(essay|assignment|homework|thesis|dissertation|coursework|exam|quiz|university paper|my paper|plagiarism|research paper for my|lab report)\b/, reason: 'academic work done for a student is refused' },
  { pattern: /\b(video|youtube channel|tiktok|reels?|voice ?over|podcast|animation|animated|motion graphics?|gif)\b/, reason: 'delivery is video, audio or animation' },
  { pattern: /\b(cold call|outreach to|contact (?:businesses|companies|leads|prospects)|send (?:the )?emails|email list|emails? (?:and|&) phone|phone numbers?|leads with (?:emails?|contacts?)|book appointments|appointment setting|lead lists?|contact details of|decision[- ]makers?)\b/, reason: 'delivery means contacting or listing people on the client’s behalf' },
  { pattern: /\b(bloomberg terminal|bloomberg access|refinitiv|eikon|capital ?iq|pitchbook|factset|crunchbase pro|statista (?:premium|account)|semrush|ahrefs|similarweb pro|zoominfo|apollo\.io|lexisnexis|westlaw|paid database|subscription database|your (?:own )?(?:licen[cs]e|subscription))\b/, reason: 'the work needs access to a paid data service Brain does not hold' },
  { pattern: /\[(?:number|date|x|amount|insert[^\]]*)\]/, reason: 'the brief still carries an unfilled placeholder, so its terms are not settled' },
  { pattern: /\b(thousands of (?:rows|records|entries|products|listings|files|pages)|\d{2,3},?\d{3}\+? (?:rows|records|entries|products|listings|lines)|millions? of (?:rows|records)|large dataset|big data|several (?:excel )?workbooks|multiple (?:excel )?workbooks|every sheet|all (?:the )?sheets|\d{3,} (?:pdfs|files|pages|invoices|documents))\b/, reason: 'the data is larger than Brain can pass through one deliverable without the client’s own file', only: ['DATASET', 'SPREADSHEET'] },
  { pattern: /\bwikipedia\b/, reason: 'paid Wikipedia editing breaks Wikipedia’s own rules' },
  { pattern: /\b(ad campaigns?|google ads|adwords|ppc|pay[- ]per[- ]click|meta ads|facebook ads|ads manager|ad spend|run (?:the |my |our )?ads)\b/, reason: 'running ads needs the client’s ad account and their ad spend' },
  // A design whose correctness is physical — it folds, sews or knits — cannot
  // be verified from the file Brain renders.
  { pattern: /\b(origami|kirigami|paper ?craft|sewing patterns?|knitting|crochet|embroidery|quilt(?:ing)? patterns?|woodworking plans?)\b/, reason: 'a folding or craft design has to be made to be checked, which Brain cannot do' },
  { pattern: /\b\d{1,3}(?:\.\d)?k\+? (?:rows|records|entries|data entries|products|listings|lines|items|photos|images)\b/, reason: 'the data is larger than Brain can pass through one deliverable without the client’s own file', only: ['DATASET', 'SPREADSHEET'] },
  // A supplier advertising itself ("our factory network can support designers…")
  // posts as a project. There is nothing to deliver and nobody buying.
  { pattern: /\b(looking to connect with|(?:our|my) (?:factory|factories|factory network|company|agency|team) (?:can|could|will) (?:support|help|work with|offer)|(?:manufacturing|production|sourcing|business) (?:partner(?:ship)?|collaboration)|what we can (?:work with you on|offer)|tell us about your (?:designs?|products?|business|brand|requirements))\b/, reason: 'the post advertises the client’s own services rather than asking for a deliverable' },
  // ISO/SOC certification is granted by an accredited body after an audit of the
  // client's own organisation; nothing Brain writes certifies anybody.
  { pattern: /\b(iso[ -]?\d{4,5}(?:-\d)?|soc ?2|certification (?:partner|body|audit|consultant|process|support)|accredited|lead auditor|internal audit)\b/, reason: 'certification needs an accredited body auditing the client’s organisation' },
  { pattern: /\b(medical|clinical|legal (?:advice|document|contract)|lawyer|attorney|tax (?:return|filing|advice)|transfer pricing|audit(?:ed)? (?:financial|accounts)|accountant|certified|licensed|cpa|chartered|stamped|pe stamp)\b/, reason: 'the work needs a professional credential' },
  { pattern: /\b(native speaker|must be from|only from|us only|uk only|resident of|based in|located in|local to|timezone overlap)\b/, reason: 'the client restricts who may do the work' },
  { pattern: /\b(long[- ]term|ongoing|full[- ]time|part[- ]time|daily tasks?|every day|weekly basis|monthly retainer|per hour|hourly)\b/, reason: 'the client wants ongoing work, not one deliverable' },
  { pattern: /\b(no ai|not ai|ai[- ]generated (?:is )?not|without ai|human[- ]written|by a human|human (?:editor|writer)|ai detect(?:ion|or)|chatgpt (?:is )?not allowed|(?:not |without )sounding robotic|machine-generated)\b/, reason: 'the client refuses AI-produced work' },
  // Brain's bid says the work is AI-assisted. A client who requires it be done
  // by hand, without tools, would be told one thing and given another.
  { pattern: /\b(no (?:scraping|automation|automated|bots?|scripts?)\b|without (?:any )?(?:scraping|automation|automated|bots?|scripts?)\b|(?:everything|all of it|all (?:the )?work|it) (?:is |must be |has to be |will be )?(?:done|entered|typed|copied) (?:by hand|manually)|(?:must|should) not be automated|automation (?:is )?not (?:allowed|permitted))/, reason: 'the client requires the work done by hand, without tools' },
  { pattern: /\b(journal|manuscript|ieee|peer[- ]review|publication-ready|conference paper)\b/, reason: 'academic writing is refused' },
  { pattern: /\b(apply (?:for|to) (?:jobs|roles|positions)|submit (?:the )?applications?|complete the (?:online )?application|on my behalf|on our behalf|in my name)\b/, reason: 'the work means acting on the client’s behalf' },
  { pattern: /\b(continuously|regularly|recurring|repeatedly|as needed|as and when)\b/, reason: 'the client wants ongoing work, not one deliverable' },
  { pattern: /\b((?:pull|clone|fork) (?:the |our |my )?(?:existing )?(?:repo|repository)|existing (?:framework|codebase|code ?base|repo|repository|project|application|app)|our (?:codebase|repo|repository|app|application|framework))\b/, reason: 'the work is inside the client’s existing codebase, which Brain cannot run' },
  { pattern: /\b(exact (?:fonts?|layout|replica)|mirror(?:s|ing)? the (?:original|layout|printed)|indistinguishable|pixel[- ]perfect|1-to-1|one-to-one|exactly where|down to the smallest detail|same fonts|identical (?:layout|format(?:ting)?))\b/, reason: 'the client wants a layout-faithful copy of an original, which Brain does not reproduce' },
  { pattern: /\b(scans?|scanned|handwrit\w*|paper (?:records|documents|forms)|hard-?copy|printed (?:forms?|documents?|originals?)|photos? of (?:the )?(?:documents?|forms?|receipts?|pages?)|images? of (?:the )?(?:documents?|text|forms?)|typing from images)\b/, reason: 'the source is scans or paper, which Brain does not transcribe reliably enough to promise accuracy' },
  { pattern: /\b(within (?:the next )?(?:an? |one |1 |2 |two |few )?hours?|next hour|urgent(?:ly)?|asap|today|tonight|right now|immediately)\b/, reason: 'the deadline is shorter than Brain’s worker can promise' },
  { pattern: /\b(linkedin|facebook|instagram|google maps|amazon|zillow|tiktok|twitter|x\.com|indeed|glassdoor|yelp)\b/, reason: 'the data is on a platform whose terms forbid automated collection', only: ['DATASET'] },
  { pattern: /\b(logo contest|unlimited revisions)\b/, reason: 'open-ended revision work is refused', only: ['GRAPHIC'] },
  { pattern: /\b(illustrat(?:e|ion)|hand[- ]drawn|mascot|character|cartoon|caricature|tattoo|anime|portrait|retouch|photoshop (?:my|our|the) photos?|remove (?:the )?background|photo manipulation|realistic|t-?shirt print|cmyk|print-ready|bleed)\b/, reason: 'the design needs drawing, photo work or print preparation Brain does not do', only: ['GRAPHIC'] },
  { pattern: /\b(character|rig(?:ging)?|sculpt|zbrush|organic|photo-?real(?:istic)?|interior|architectur\w*|floor ?plan|site plan|landscape|hectares?|building|house|cad drawing|technical drawing|tolerances?|injection mould|engineering|animation|vr|ar |game asset|unreal|unity|metahuman|avatar|jewel(?:le)?ry)\b/, reason: 'the 3D work needs more than placed primitive shapes', only: ['MODEL_3D'] },
  { pattern: /\b(wordpress|shopify|wix|squarespace|webflow|woocommerce|magento|elementor|php|laravel|django|backend|database|login system|user accounts?|payment gateway|checkout|e-?commerce|cms|my (?:existing )?(?:site|website)|our (?:existing )?(?:site|website)|fix (?:my|our|the) (?:site|website)|redesign|seo|react native|next\.js app|mern|full[- ]stack)\b/, reason: 'the site needs a platform, a server or the client’s existing site', only: ['WEBSITE'] },
  { pattern: /\b(mobile app|android|ios|desktop app|gui|game|trading bot|crypto|forex|mt[45]|metatrader|arbitrage bot|smart contract|solidity|machine learning model|train (?:a |the )?model|gpu|deep learning|real[- ]time|websocket server|kubernetes|docker|microservices?|c\+\+|c#|java\b|\.net|rust|golang|php|ruby|selenium grid|captcha|bypass)\b/, reason: 'the program needs a platform, a runtime or a risk Brain does not take on', only: ['CODE'] },
  { pattern: /\b(macro|vba|power ?bi|tableau|power query|apps script|dashboard (?:in|with) (?:power|tableau|looker)|looker|odoo|sap|salesforce|crm|erp|quickbooks|xero|my (?:existing )?(?:sheet|spreadsheet|workbook|file))\b/, reason: 'the spreadsheet needs macros, a BI platform or the client’s existing systems', only: ['SPREADSHEET'] },
  { pattern: /\b(into (?:our|my|the) (?:system|crm|website|portal|database|erp|shopify|platform)|upload(?:ing)? (?:to|into) (?:our|my|the)|product listings? on|data entry (?:in|into)|typing from (?:images|scans|handwrit))\b/, reason: 'the data has to be entered into the client’s own system', only: ['DATASET'] },
  { pattern: /\b(design (?:the )?slides? (?:in|with) (?:canva|keynote|prezi)|keynote|prezi|animated (?:slides|presentation)|video presentation|present it)\b/, reason: 'the deck needs a tool or a presenter Brain does not provide', only: ['PRESENTATION'] },
];

export function blockersOf(tags: string[], text: string, categories: JobCategory[]): string[] {
  const reasons = new Set<string>();
  for (const tag of tags) {
    const reason = BLOCKING_TAGS[tag];
    if (reason) reasons.add(reason);
    if (ENGINEERING_TAG.test(tag)) reasons.add('the work needs a qualified engineer');
  }
  if (text.replace(/\s+/g, ' ').length < 220) reasons.add('the request is too short to say what would be delivered');
  for (const blocker of BLOCKERS) {
    if (blocker.only && !blocker.only.some((c) => categories.includes(c))) continue;
    if (blocker.pattern.test(text)) reasons.add(blocker.reason);
  }
  return [...reasons];
}

/** Whether the client will hand over files Brain must read to do the work. */
export function needsClientFiles(text: string): boolean {
  return /\b(attached|attachment|i will (?:send|share|provide)|will (?:send|share|provide) (?:the |you )?(?:files?|data|documents?|pdfs?|spreadsheet|list|code)|upload(?:ed)? files?|my files|(?:existing|current) (?:spreadsheet|file|document|deck|code|script)|pdfs? (?:i|we) (?:have|will))\b/.test(text);
}

/** Which language a programming job is in, when it says. */
export function codeLanguageOf(text: string): 'python' | 'javascript' | null {
  if (/\bpython\b|\.py\b|pandas|django|flask/.test(text)) return 'python';
  if (/\b(javascript|node(?:\.js)?|js\b|typescript)\b/.test(text)) return 'javascript';
  return null;
}

/**
 * The kinds a brief names in its own list of deliverables. A client who writes
 * "Deliverables: a cleaned file, a script and a slide deck" is owed all three,
 * so a kind named there that Brain would not deliver refuses the job.
 */
export function namedDeliverables(text: string): JobCategory[] {
  const at = text.search(/\bdeliverables?\b|\byou will (?:deliver|provide)\b|\bi expect\b|\bi need back\b|\bfinal (?:output|files?)\b/);
  if (at < 0) return [];
  const section = text.slice(at, at + 900);
  return (Object.entries(SIGNALS) as [JobCategory, Signal][])
    .filter(([category, signal]) => category !== 'RESEARCH_REPORT' && signal.words.test(section))
    .map(([category]) => category);
}

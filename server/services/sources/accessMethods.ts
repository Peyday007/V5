/**
 * The selection space for getting at a source or an action (ACQ-21-1, ACQ-21-2).
 *
 * Six classes of method are data, not a hierarchy: which one fits is judged per
 * need from the evidence the caller holds, and the judgment is returned with its
 * reason and the constraints it must honour so it can be recorded. Nothing here
 * performs an access, owns a schedule or stores anything — `access.ts` stays the
 * one place that opens sources and records them.
 *
 * Operating a system and acquiring information are separate capabilities, and
 * neither is authority to contact strangers, evade a site's defences or make a
 * commitment: a boundary (authentication, owner consent, a challenge, a bot
 * restriction) ends in HUMAN_HANDOFF naming the permitted route, never in a
 * workaround.
 */

export const METHOD_CLASSES = ['NATIVE', 'BULK', 'HTTP', 'BROWSER', 'MODEL_ASSISTED', 'HUMAN_HANDOFF'] as const;
export type MethodClass = (typeof METHOD_CLASSES)[number];

/** What each class covers. Illustrative of a space, not a closed list of means. */
export const METHOD_CATALOG: Readonly<Record<MethodClass, readonly string[]>> = {
  NATIVE: ['official API', 'authenticated export', 'webhook', 'event subscription', 'CLI client', 'standard protocol', 'connected application'],
  BULK: ['public archive', 'downloadable dataset', 'periodic export', 'RSS/Atom feed', 'sitemap', 'published index', 'research repository', 'open-data catalog', 'file server', 'licensed data product'],
  HTTP: ['ordinary request', 'stable JSON/CSV/XML/HTML document', 'structured-data annotation', 'permitted paginated download'],
  BROWSER: ['authorized browser session', 'navigation and search', 'filtering and form entry', 'download handling', 'bounded workflow'],
  MODEL_ASSISTED: ['interpret an unfamiliar interface', 'recover from a permitted UI change', 'propose a reusable automation'],
  HUMAN_HANDOFF: ['permitted access', 'official export', 'licence', 'partner integration', 'a specific human step'],
};

/** Per-case evidence. Every field is optional: an unstated fact is unknown, never assumed favourable. */
export interface AccessEvidence {
  /** An official API, export, webhook, CLI or connected application exists and is usable. */
  nativeAvailable?: boolean;
  /** A bulk corpus, export, feed, sitemap or catalog covers the need. */
  bulkAvailable?: boolean;
  /** Plain HTTP returns the content (stable document, permitted pagination). */
  httpReadable?: boolean;
  /** The interactive interface is the supported way in, and an authorized session exists. */
  interfaceOnly?: boolean;
  authorizedSession?: boolean;
  /** The interface is unfamiliar or has changed since a routine last worked. */
  interfaceUnfamiliar?: boolean;
  /** How many times a model-assisted routine ran against this interface, and how often it succeeded unchanged. */
  recurrence?: { runs: number; stable: number };
  /** The boundary the last attempt met, if any. */
  boundary?: 'AUTHENTICATION' | 'OWNER_CONSENT' | 'CAPTCHA' | 'BOT_RESTRICTION' | 'PAYMENT' | 'LEGAL';
  /** Access needs a paid licence or authorized account the company has not been given. */
  needsLicence?: boolean;
  /** What a person has already been granted, e.g. an official export or a licence, by name. */
  permittedRoute?: string;
  /** Terms the source states, honoured whichever method is chosen. */
  terms?: { robotsDisallows?: boolean; rateLimited?: boolean; rateLimitPerMinute?: number; privacyRestricted?: boolean; licenceLimitsUse?: string };
  /** Relative cost of each class in cents per read, where measured. */
  costCents?: Partial<Record<MethodClass, number>>;
  /** Observed reliability 0..1 per class on this source, where measured. */
  reliability?: Partial<Record<MethodClass, number>>;
}

export interface AccessSelection {
  method: MethodClass;
  /** Why this one, in the evidence's own terms. */
  why: string;
  /** What the chosen route must honour. */
  constraints: readonly string[];
  /** Every class that was weighed and why it was set aside. */
  considered: readonly { method: MethodClass; fit: boolean; note: string }[];
  /** A stable recurring model-assisted pattern should become a tested script. */
  convertToScript: boolean;
  /** For HUMAN_HANDOFF: the permitted route to seek, named. */
  handoff: string | null;
}

/** Runs of an unchanged model-assisted routine after which it is worth a tested script. */
export const SCRIPT_CONVERSION_RUNS = 3;

const BOUNDARY_ROUTE: Record<NonNullable<AccessEvidence['boundary']>, string> = {
  AUTHENTICATION: 'an authorized account, or an official export or partner integration that does not need the login',
  OWNER_CONSENT: "the account owner's consent for this use",
  CAPTCHA: 'an official export, a licence or a partner integration; the challenge is not solved by Brain',
  BOT_RESTRICTION: 'permission from the site, an official export, a licence or a partner integration',
  PAYMENT: 'a person to approve the purchase or licence under the existing spending authority',
  LEGAL: 'a person to judge the legal position before any access',
};

/**
 * Chooses a method class for one need from its evidence. Pure.
 * Favours reliable, permitted, low-cost routes; the order of preference is
 * the evidence's, so a measured-unreliable native route does not win by name.
 */
export function selectAccessMethod(evidence: AccessEvidence = {}): AccessSelection {
  const constraints: string[] = ['honour the source terms, rate limits, privacy and licensing for the use made of what is retrieved'];
  const t = evidence.terms;
  if (t?.rateLimitPerMinute !== undefined) constraints.push(`at most ${t.rateLimitPerMinute} requests a minute`);
  if (t?.rateLimited) constraints.push('the source answered 429: slow down and honour its Retry-After before reading again');
  if (t?.robotsDisallows) constraints.push('robots.txt disallows automated reads of this path');
  if (t?.privacyRestricted) constraints.push('the material is privacy-restricted: use only as the permission allows');
  if (t?.licenceLimitsUse) constraints.push(`licence limits use: ${t.licenceLimitsUse}`);

  const considered: { method: MethodClass; fit: boolean; note: string }[] = [];
  const note = (method: MethodClass, fit: boolean, text: string) => considered.push({ method, fit, note: text });

  // A boundary is a stop, not a obstacle to route around.
  if (evidence.boundary || evidence.needsLicence || (t?.robotsDisallows && !evidence.permittedRoute && !evidence.nativeAvailable && !evidence.bulkAvailable)) {
    const route =
      evidence.permittedRoute ??
      (evidence.boundary ? BOUNDARY_ROUTE[evidence.boundary] : evidence.needsLicence ? BOUNDARY_ROUTE.PAYMENT : 'permission from the site, an official export or a licence');
    for (const m of METHOD_CLASSES) if (m !== 'HUMAN_HANDOFF') note(m, false, 'not used: an access boundary stops automation here');
    note('HUMAN_HANDOFF', true, `stop at the boundary and seek ${route}`);
    return {
      method: 'HUMAN_HANDOFF',
      why: `${evidence.boundary ?? (evidence.needsLicence ? 'a licence is required' : 'robots.txt disallows')}: stop at the boundary and seek ${route}; defences are not bypassed`,
      constraints,
      considered,
      convertToScript: false,
      handoff: route,
    };
  }

  const rank = (m: MethodClass): number => {
    const rel = evidence.reliability?.[m];
    const cost = evidence.costCents?.[m];
    return (rel ?? 0.5) * 100 - (cost ?? 0);
  };
  const candidates: MethodClass[] = [];
  const fits: Record<Exclude<MethodClass, 'HUMAN_HANDOFF'>, boolean | undefined> = {
    NATIVE: evidence.nativeAvailable,
    BULK: evidence.bulkAvailable,
    HTTP: evidence.httpReadable,
    BROWSER: evidence.interfaceOnly && evidence.authorizedSession,
    MODEL_ASSISTED: evidence.interfaceOnly && evidence.authorizedSession && evidence.interfaceUnfamiliar,
  };
  for (const m of ['NATIVE', 'BULK', 'HTTP', 'BROWSER', 'MODEL_ASSISTED'] as const) {
    const ok = Boolean(fits[m]);
    note(m, ok, ok ? 'the evidence supports it' : fits[m] === undefined ? 'no evidence it is available' : 'the evidence says it is not available');
    if (ok) candidates.push(m);
  }
  // A familiar interface is a reusable routine, not model-per-click.
  const browserIdx = candidates.indexOf('BROWSER');
  const modelIdx = candidates.indexOf('MODEL_ASSISTED');
  if (browserIdx >= 0 && modelIdx >= 0 && !evidence.interfaceUnfamiliar) candidates.splice(modelIdx, 1);

  if (candidates.length === 0) {
    note('HUMAN_HANDOFF', true, 'no permitted automated route is evidenced');
    return {
      method: 'HUMAN_HANDOFF',
      why: 'no permitted automated route is evidenced for this need; seek an official export, a licence, a partner integration or a specific human step',
      constraints,
      considered,
      convertToScript: false,
      handoff: evidence.permittedRoute ?? 'an official export, a licence, a partner integration or a specific human step',
    };
  }
  // Bulk and native before bespoke access, unless measurement says otherwise: sorted by measured fitness, stable on the spec's own order.
  const best = [...candidates].sort((a, b) => rank(b) - rank(a) || candidates.indexOf(a) - candidates.indexOf(b))[0]!;
  note('HUMAN_HANDOFF', false, 'no boundary met');
  const r = evidence.recurrence;
  const convertToScript = best === 'MODEL_ASSISTED' && Boolean(r && r.runs >= SCRIPT_CONVERSION_RUNS && r.stable === r.runs);
  return {
    method: best,
    why: `${best} fits: ${considered.find((c) => c.method === best)?.note}; chosen on measured reliability and cost where stated, otherwise on the order existing corpora and first-party routes before a bespoke one`,
    constraints,
    considered,
    convertToScript,
    handoff: null,
  };
}

/** Which class an existing read route belongs to, for recording a read already made. */
export function classOfRoute(route: string): MethodClass {
  switch (route) {
    case 'CONNECTOR':
      return 'NATIVE';
    case 'SITEMAP':
    case 'ARCHIVE':
      return 'BULK';
    case 'BROWSER':
      return 'BROWSER';
    default:
      return 'HTTP';
  }
}

/**
 * HTTP results that are a boundary and end in a human step, never a fallback.
 * A 403 is the site refusing this reader, and a robots.txt block (`robotsBlocked`:
 * the one route that would have worked was refused by the site's own rules) is the
 * same refusal stated in advance — both are the bot-restriction boundary.
 */
export function boundaryOfRead(read: { readable: boolean; reason?: string; status?: number | null; robotsBlocked?: boolean }): AccessEvidence['boundary'] | null {
  if (read.readable) return null;
  if (read.reason === 'CHALLENGE') return 'CAPTCHA';
  if (read.reason === 'HTTP_ERROR') {
    if (read.status === 401) return 'AUTHENTICATION';
    if (read.status === 402) return 'PAYMENT';
    if (read.status === 403) return 'BOT_RESTRICTION';
    if (read.status === 451) return 'LEGAL';
  }
  // The site's own HTTP answer (a 404, a 500) is not a block; only a read that needed the refused route is.
  if (read.robotsBlocked && read.reason !== 'HTTP_ERROR') return 'BOT_RESTRICTION';
  return null;
}

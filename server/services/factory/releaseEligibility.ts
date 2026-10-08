/**
 * Which changes may be released without a person, decided from the paths alone.
 *
 * The owner's rule is that ordinary, low-risk work flows from an approved
 * objective to production unattended, while a change to credentials, security,
 * financial authority or the deployment controls themselves always waits for a
 * person. This module is that rule and nothing else: a pure function over the
 * list of files a change actually moved — read from the repository, never from
 * a worker's account of what it did — answering ELIGIBLE or MANUAL with every
 * reason named.
 *
 * **Deny by default.** A path is eligible only when it sits on the low-risk
 * surface *and* belongs to no protected class. Anything unrecognised — a new
 * top-level directory, a lockfile, the agent instructions — is manual, because
 * the expensive mistake here is an automatic release of something nobody looked
 * at, and the cheap one is a person pressing merge on something harmless.
 *
 * **It cannot be widened by the change it judges.** The release workflow runs
 * this module from the *canonical branch's* checkout, never from the pull
 * request's, and the module itself (with everything else that decides whether a
 * release happens) is in the `DEPLOYMENT_CONTROLS` class — so a change that
 * edits the classifier is manual by the classifier's own reading, and cannot
 * classify itself eligible.
 *
 * The patterns describe this repository's layout. A release authorization names
 * one repository (see `repos/releaseAuthorizations.ts`), so a repository whose
 * layout these do not describe is not given one.
 */
import { matchesGlob } from './glob.ts';

export const PROTECTED_CLASSES = [
  'CREDENTIALS',
  'SECURITY',
  'FINANCIAL_AUTHORITY',
  'DEPLOYMENT_CONTROLS',
  /** Schema is irreversible once applied (§3), so it is never low risk. */
  'SCHEMA',
  /** A dependency change is a supply-chain change, however small the diff. */
  'DEPENDENCIES',
] as const;
export type ProtectedClass = (typeof PROTECTED_CLASSES)[number];

/** A `Record` over the union, so a class added above is a compile error until it says what it covers. */
export const PROTECTED_PATHS: Record<ProtectedClass, readonly string[]> = {
  CREDENTIALS: [
    '**/.env',
    '**/.env.*',
    '**/*secret*',
    '**/*Secret*',
    '**/*credential*',
    '**/*Credential*',
    'server/config.ts',
    'server/services/identity/secrets.ts',
    'server/services/identity/tokenTouch.ts',
    'server/routes/oauth.ts',
  ],
  SECURITY: [
    'server/services/identity/**',
    'server/routes/guard.ts',
    'server/routes/auth.ts',
    'server/routes/access.ts',
    'server/routes/admin.ts',
    'server/routes/passkeys.ts',
    'server/routes/helpers.ts',
    'server/routes/unavailable.ts',
    'server/mcp/endpoint.ts',
    'server/mcp/execute.ts',
    'server/services/bins/routing.ts',
    'server/services/effects/**',
    'server/services/storage/keys.ts',
    'server/services/research/approvalEnvelope.ts',
    'server/services/research/independence.ts',
    'server/services/research/auditEligibility.ts',
    'server/services/russell/probeEnvelope.ts',
    'server/services/audit/schema.ts',
  ],
  FINANCIAL_AUTHORITY: [
    'server/services/cash/authority.ts',
    'server/services/cash/discoveryAuthority.ts',
    'server/services/cash/perform.ts',
    'server/services/cash/effects.ts',
    'server/services/cash/money.ts',
    'server/services/cash/invoicing.ts',
    'server/services/cash/providers/**',
    'server/services/cash/journey/fulfillment.ts',
    'server/services/russell/authority.ts',
    'server/repos/cashAuthority.ts',
    'server/repos/cashLedger.ts',
    'server/repos/cashFulfillment.ts',
    'server/routes/cash.ts',
  ],
  DEPLOYMENT_CONTROLS: [
    '.github/**',
    '.claude/**',
    'fly.toml',
    'Dockerfile',
    '.dockerignore',
    'server/index.ts',
    'server/bootRetry.ts',
    'server/bootFailure.ts',
    'server/services/factory/repositoryEnvelope.ts',
    'server/services/factory/projectScope.ts',
    'server/services/factory/forbidden.ts',
    'server/services/factory/releaseEligibility.ts',
    'server/services/factory/release.ts',
    'server/repos/releaseAuthorizations.ts',
    'scripts/release-eligibility.ts',
    'scripts/test-pg.mjs',
    'scripts/verify-hosted.ts',
  ],
  SCHEMA: ['server/db/**'],
  DEPENDENCIES: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc'],
};

/**
 * The only places an automatic release may touch at all. Everything outside
 * them is `OUTSIDE_LOW_RISK_SURFACE` — which is how `CLAUDE.md`, `scripts/`
 * and any new top-level directory stay manual without being named.
 */
export const LOW_RISK_SURFACE: readonly string[] = [
  'client/**',
  'server/**',
  'tests/**',
  'docs/**',
  'objectives/**',
  'blueprints/**',
];

export type ReleaseReason =
  | { kind: 'PROTECTED'; class: ProtectedClass; path: string }
  | { kind: 'OUTSIDE_LOW_RISK_SURFACE'; path: string }
  | { kind: 'NOTHING_CHANGED' }
  | { kind: 'DIFF_TRUNCATED' };

export interface ReleaseClassification {
  eligible: boolean;
  /** Every reason, not the first: a person deciding a manual release should see all of them. */
  reasons: ReleaseReason[];
  /** The protected classes touched, deduplicated, in declaration order. */
  classes: ProtectedClass[];
  paths: string[];
}

export function protectedClassesOf(path: string): ProtectedClass[] {
  return PROTECTED_CLASSES.filter((cls) => PROTECTED_PATHS[cls].some((glob) => matchesGlob(path, glob)));
}

export function classifyRelease(
  paths: readonly string[],
  options: { truncated?: boolean } = {},
): ReleaseClassification {
  const unique = [...new Set(paths.map((one) => one.trim()).filter(Boolean))].sort();
  const reasons: ReleaseReason[] = [];
  if (options.truncated) reasons.push({ kind: 'DIFF_TRUNCATED' });
  if (unique.length === 0) reasons.push({ kind: 'NOTHING_CHANGED' });
  const classes = new Set<ProtectedClass>();
  for (const path of unique) {
    for (const cls of protectedClassesOf(path)) {
      classes.add(cls);
      reasons.push({ kind: 'PROTECTED', class: cls, path });
    }
    if (!LOW_RISK_SURFACE.some((glob) => matchesGlob(path, glob))) {
      reasons.push({ kind: 'OUTSIDE_LOW_RISK_SURFACE', path });
    }
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    classes: PROTECTED_CLASSES.filter((cls) => classes.has(cls)),
    paths: unique,
  };
}

export function describeReleaseReason(reason: ReleaseReason): string {
  switch (reason.kind) {
    case 'PROTECTED':
      return `${reason.path} is ${reason.class.toLowerCase().replace(/_/g, ' ')}, which always needs a person.`;
    case 'OUTSIDE_LOW_RISK_SURFACE':
      return `${reason.path} is outside the low-risk surface, so a person decides.`;
    case 'NOTHING_CHANGED':
      return 'The change moves no files, so there is nothing to release.';
    case 'DIFF_TRUNCATED':
      return 'The forge truncated the file list, and a list that is cut short cannot prove the change is low risk.';
  }
}

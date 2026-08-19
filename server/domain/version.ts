/**
 * Versioning engine (section 8).
 *
 * Version strings are NEVER compared lexicographically: `v1J` < `v2` but
 * `"v1J" > "v2"` as plain strings. Everything sorts on `sortKey`.
 *
 * Supported shapes: v1, v1A, v1B … v1J, v2, v3.1, v3.1A, v3.1B
 */
import { DEFAULT_VERSION_POLICY, type ParsedVersion, type VersionPolicy } from './types.ts';

const VERSION_RE = /^\s*[vV]?(\d+)(?:\.(\d+))?\s*([A-Za-z]{1,3})?\s*$/;

/**
 * The same shape, unanchored, for finding versions mentioned inside prose.
 *
 * The leading `v` is required here where it is optional above: parsing a field
 * that is known to hold a version can accept a bare "1", but scanning a
 * paragraph cannot — every quantity in the text would match.
 */
export const VERSION_RE_SOURCE = 'v\\d+(?:\\.\\d+)?[A-Za-z]{0,3}';

/** `A` → 1, `Z` → 26, `AA` → 27 (bijective base-26). `''` → 0. */
export function branchToIndex(branch: string): number {
  let index = 0;
  for (const char of branch.toUpperCase()) {
    const value = char.charCodeAt(0) - 64; // 'A' = 1
    if (value < 1 || value > 26) return 0;
    index = index * 26 + value;
  }
  return index;
}

/** Inverse of {@link branchToIndex}. `0` → `''`. */
export function indexToBranch(index: number): string {
  if (index <= 0) return '';
  let remaining = index;
  let out = '';
  while (remaining > 0) {
    const rem = (remaining - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return out;
}

function buildSortKey(major: number, minor: number, branchIndex: number): string {
  return [
    String(major).padStart(4, '0'),
    String(minor).padStart(4, '0'),
    String(branchIndex).padStart(4, '0'),
  ].join('.');
}

/** Parse a version string into comparable components. Never throws. */
export function parseVersion(input: string | null | undefined): ParsedVersion {
  const raw = (input ?? '').trim();
  const match = VERSION_RE.exec(raw);
  if (!match) {
    return {
      raw,
      normalized: raw,
      major: 0,
      minor: 0,
      branch: '',
      branchIndex: 0,
      sortKey: `9999.9999.9999.${raw.toLowerCase()}`,
      valid: false,
    };
  }
  const major = Number(match[1]);
  const hasExplicitMinor = match[2] !== undefined;
  const minor = hasExplicitMinor ? Number(match[2]) : 0;
  const branch = (match[3] ?? '').toUpperCase();
  const branchIndex = branchToIndex(branch);
  const normalized = `v${major}${hasExplicitMinor ? `.${minor}` : ''}${branch}`;
  return {
    raw,
    normalized,
    major,
    minor,
    branch,
    branchIndex,
    sortKey: buildSortKey(major, minor, branchIndex),
    valid: true,
  };
}

export function isValidVersion(input: string | null | undefined): boolean {
  return parseVersion(input).valid;
}

/** Canonical rendering, e.g. `V1g` → `v1G`. */
export function normalizeVersion(input: string): string {
  return parseVersion(input).normalized;
}

export function versionSortKey(input: string): string {
  return parseVersion(input).sortKey;
}

/** Negative when `a` precedes `b`. Use as an Array#sort comparator. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a).sortKey;
  const right = parseVersion(b).sortKey;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortVersions(versions: string[]): string[] {
  return [...versions].sort(compareVersions);
}

export function maxVersion(versions: string[]): string | null {
  return sortVersions(versions.filter(Boolean)).at(-1) ?? null;
}

/**
 * Which wave a version belongs to under the project's policy.
 * Wave 1 = foundation (`v1`), wave 2 = sibling expansions (`v1B`…),
 * wave 3 = canonical synthesis (`v3.1`).
 */
export function waveForVersion(version: string, policy: VersionPolicy = DEFAULT_VERSION_POLICY): number {
  const parsed = parseVersion(version);
  if (!parsed.valid) return 0;
  const foundation = parseVersion(policy.foundationVersion);
  const synthesis = parseVersion(policy.synthesisVersion);

  if (parsed.major === synthesis.major && parsed.minor === synthesis.minor) {
    return policy.synthesisWave;
  }
  if (parsed.major === foundation.major && parsed.minor === foundation.minor) {
    return parsed.branchIndex === 0 ? 1 : 2;
  }
  if (parsed.major >= synthesis.major) return policy.synthesisWave;
  return parsed.branchIndex === 0 ? 1 : 2;
}

/**
 * The next sibling expansion version for a layer.
 *
 * With only `v1` present the policy's `expansionStartBranch` decides whether the
 * next document is `v1A` or (Deal Dispatch convention) `v1B`. Once a branch
 * exists we simply take the highest branch and add one.
 */
export function nextExpansionVersion(
  existingVersions: string[],
  policy: VersionPolicy = DEFAULT_VERSION_POLICY,
): string {
  const foundation = parseVersion(policy.foundationVersion);
  const family = existingVersions
    .map(parseVersion)
    .filter((v) => v.valid && v.major === foundation.major && v.minor === foundation.minor);

  const highestBranch = family.reduce((max, v) => Math.max(max, v.branchIndex), 0);
  const nextIndex =
    highestBranch === 0 ? branchToIndex(policy.expansionStartBranch) || 1 : highestBranch + 1;
  return `${foundation.normalized}${indexToBranch(nextIndex)}`;
}

/**
 * The canonical synthesis version. Fixed by policy — the platform never
 * invents `v3.2` on its own.
 */
export function synthesisVersion(policy: VersionPolicy = DEFAULT_VERSION_POLICY): string {
  return parseVersion(policy.synthesisVersion).normalized;
}

/**
 * Versions that make up the source packet consumed by a synthesis run:
 * every wave-1/wave-2 document in the layer, in order.
 */
export function synthesisSourceVersions(
  existingVersions: string[],
  policy: VersionPolicy = DEFAULT_VERSION_POLICY,
): string[] {
  const synthesis = parseVersion(policy.synthesisVersion);
  return sortVersions(
    existingVersions.filter((v) => {
      const parsed = parseVersion(v);
      if (!parsed.valid) return false;
      if (parsed.major === synthesis.major && parsed.minor === synthesis.minor) return false;
      return parsed.major < synthesis.major || waveForVersion(v, policy) < policy.synthesisWave;
    }),
  );
}

/** Extract the first version token from arbitrary text, e.g. a filename. */
export function extractVersionToken(text: string): string | null {
  const match = /(?:^|[\s_\-([])v(\d+(?:\.\d+)?[A-Za-z]{0,3})(?=$|[\s_\-.)\]]|\.pdf)/i.exec(text);
  if (!match?.[1]) return null;
  // Guard against swallowing a file extension, e.g. "v1.pdf" → "1", not "1.p".
  const candidate = `v${match[1]}`.replace(/\.$/, '');
  const parsed = parseVersion(candidate);
  return parsed.valid ? parsed.normalized : null;
}

/**
 * Naming engine (section 10).
 *
 * Naming is enforced by the platform, never trusted to a model. Every target
 * document derives all three names from (layer name, version) by one function,
 * and the platform — not the model's report title — decides the filename on disk.
 */
import { normalizeVersion } from './version.ts';

export interface CanonicalNames {
  canonicalName: string;
  conversationTitle: string;
  filename: string;
}

/** Characters SQLite is fine with but filesystems are not. */
const ILLEGAL_FILENAME_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export function sanitizeFilename(input: string): string {
  const cleaned = input
    .replace(ILLEGAL_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 180);
  const safe = cleaned.length > 0 ? cleaned : 'untitled';
  return RESERVED_WINDOWS_NAMES.test(safe) ? `_${safe}` : safe;
}

export function buildCanonicalName(layerName: string, version: string): string {
  return `${layerName.trim()} ${normalizeVersion(version)}`.trim();
}

/**
 * The single source of truth for the three names attached to a document.
 * `Qualification Logic` + `v3.1` →
 *   canonical_name       "Qualification Logic v3.1"
 *   conversation_title   "Qualification Logic v3.1"
 *   filename             "Qualification Logic v3.1.pdf"
 */
export function buildNames(layerName: string, version: string, extension = '.pdf'): CanonicalNames {
  const canonicalName = buildCanonicalName(layerName, version);
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  return {
    canonicalName,
    conversationTitle: canonicalName,
    filename: `${sanitizeFilename(canonicalName)}${ext}`,
  };
}

/**
 * Filename the platform will use when storing an artifact for a document.
 * The model-supplied title is deliberately ignored.
 */
export function filenameForDocument(canonicalName: string, originalFilename: string): string {
  const match = /(\.[A-Za-z0-9]{1,8})$/.exec(originalFilename);
  const ext = match?.[1]?.toLowerCase() ?? '.pdf';
  return `${sanitizeFilename(canonicalName)}${ext}`;
}

export function normalizeName(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Compare two names ignoring case and whitespace noise. */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeName(a);
  return left.length > 0 && left === normalizeName(b);
}

/**
 * Hardened naming instructions injected into every compiled prompt.
 * This project has had repeated AI naming failures; the rules are stated
 * explicitly and then re-checked at the end of the prompt.
 */
export function namingRulesBlock(names: CanonicalNames): string {
  return [
    'NAMING IS MANDATORY AND NON-NEGOTIABLE.',
    '',
    `Report title / canonical name : ${names.canonicalName}`,
    `Conversation title            : ${names.conversationTitle}`,
    `Output filename               : ${names.filename}`,
    '',
    'Rules:',
    `1. The document title MUST be exactly "${names.canonicalName}" — same words, same spacing, same capitalisation.`,
    '2. Do NOT add a subtitle, date, wave number, author, or descriptive suffix to the title.',
    '3. Do NOT invent a different version number. The version is fixed above.',
    '4. Do NOT rename the layer, abbreviate it, or pluralise it.',
    '5. If you believe the assigned version is wrong, say so in the body — do not silently change the title.',
  ].join('\n');
}

/** Final self-check appended as the last section of every compiled prompt. */
export function finalNamingCheckBlock(names: CanonicalNames): string {
  return [
    'FINAL NAMING CHECK — perform this before returning your answer.',
    '',
    `[ ] The title of this document reads exactly: ${names.canonicalName}`,
    `[ ] The conversation is titled exactly: ${names.conversationTitle}`,
    '[ ] No extra words were appended to the title.',
    '[ ] The version string in the title matches the version assigned above.',
    '',
    'If any box cannot be ticked, correct the title before returning.',
  ].join('\n');
}

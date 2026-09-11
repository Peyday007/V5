/**
 * What a worker is allowed to tell Brain about a repository, and nothing else.
 *
 * The factory's oldest rule is that a worker's summary is never evidence. That
 * was easy to keep when Brain held the checkout: it read the diff itself. With
 * the work on a permanent worker and the repository somewhere Brain cannot see,
 * the rule has to survive a different way — so a report is split in two.
 *
 *   * **What only the worker can say**: the branch it pushed, the commit it
 *     landed, the commands it ran and what they exited with. Parsed here, with a
 *     closed vocabulary and an unknown field refusing the whole report, exactly
 *     as `services/russell/proposal.ts` treats a proposal.
 *   * **What Brain checks for itself**: that the branch really is at that commit,
 *     and that the files the range touched are inside the paths the unit
 *     declared. That is `forge.ts`, and it asks the repository rather than the
 *     worker.
 *
 * So a worker can lie about its commands and it cannot lie about the repository.
 * The first is bounded by the review that follows; the second is not a matter of
 * trust at all.
 *
 * An unknown field refuses the *whole* report rather than being ignored. A report
 * with a field Brain does not understand is a report written against a different
 * contract, and silently dropping it is how a worker comes to believe it told
 * Brain something it did not.
 */
import { FactoryError } from './errors.ts';

/** What a unit report may conclude. Matched exactly; there is no closest match. */
export const FACTORY_REPORT_OUTCOMES = ['IMPLEMENTED', 'BLOCKED'] as const;
export type FactoryReportOutcome = (typeof FACTORY_REPORT_OUTCOMES)[number];

export interface FactoryCommandRun {
  command: string;
  exitCode: number;
}

export interface FactoryUnitReport {
  unitKey: string;
  outcome: FactoryReportOutcome;
  /** The branch the worker pushed. Brain compares it to the branch it named. */
  branch: string;
  /** The commit the branch now points at. Brain confirms this with the forge. */
  headSha: string;
  /** What the worker says it changed. Never the input to the ownership check. */
  filesChanged: string[];
  commands: FactoryCommandRun[];
  summary: string;
  /** Set only when the outcome is BLOCKED, and then required. */
  blockedReason: string | null;
}

const UNIT_REPORT_FIELDS = new Set([
  'unitKey',
  'outcome',
  'branch',
  'headSha',
  'filesChanged',
  'commands',
  'summary',
  'blockedReason',
]);

const REVIEW_VERDICTS = ['PASS', 'CHANGES_REQUIRED', 'BLOCKED'] as const;
export type FactoryReviewReportVerdict = (typeof REVIEW_VERDICTS)[number];

const FINDING_SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR'] as const;

export interface FactoryReviewFinding {
  key: string;
  severity: (typeof FINDING_SEVERITIES)[number];
  category: string;
  statement: string;
  evidence: string;
  acceptanceConditionId: string | null;
}

export interface FactoryReviewReport {
  verdict: FactoryReviewReportVerdict;
  reviewedSha: string;
  summary: string;
  findings: FactoryReviewFinding[];
}

const REVIEW_REPORT_FIELDS = new Set(['verdict', 'reviewedSha', 'summary', 'findings']);
const FINDING_FIELDS = new Set([
  'key',
  'severity',
  'category',
  'statement',
  'evidence',
  'acceptanceConditionId',
]);

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function unknownFields(value: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function asObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function stringArray(raw: unknown, field: string, errors: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`\`${field}\` is a list of strings.`);
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      errors.push(`\`${field}\` contains an entry that is not a non-empty string.`);
      continue;
    }
    out.push(entry.trim());
  }
  return out;
}

/** A 40-character lowercase hex sha, and nothing that merely looks like one. */
export function isCommitSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/**
 * Parse one unit report.
 *
 * `headSha` is required for an `IMPLEMENTED` outcome and optional for a `BLOCKED`
 * one, and that is a correction recorded rather than quietly applied. It used to
 * be required for both, on the reasoning that a worker which got far enough to
 * push has a commit. Some do; a worker blocked *before* pushing — no credential,
 * a refused host, a conflict it was told not to resolve — has nothing to report,
 * and a schema that cannot express that forces it to invent a sha or be refused
 * for ever. **An honest blocker is a result, and a contract that cannot accept one
 * turns it into an exhausted bin.** That is what happened to the first hosted
 * integration: the worker reported BLOCKED with the operation that was refused,
 * the parser demanded a commit for a branch it had deliberately not pushed, and
 * the bin retired at `NEEDS_HUMAN` having said exactly the right thing twice.
 */
export function parseUnitReport(raw: unknown): Parsed<FactoryUnitReport> {
  const errors: string[] = [];
  const value = asObject(raw);
  if (!value) return { ok: false, errors: ['The report is not a structured object.'] };

  const unexpected = unknownFields(value, UNIT_REPORT_FIELDS);
  if (unexpected.length > 0) {
    return {
      ok: false,
      errors: [
        `The report carries ${unexpected.length} field(s) this contract does not define: ` +
          `${unexpected.join(', ')}. The whole report is refused rather than the fields ignored — ` +
          'a report written against a different contract is not a report against this one.',
      ],
    };
  }

  const unitKey = typeof value['unitKey'] === 'string' ? value['unitKey'].trim() : '';
  if (unitKey.length === 0) errors.push('`unitKey` is required.');

  const outcomeRaw = value['outcome'];
  const outcome = FACTORY_REPORT_OUTCOMES.find((candidate) => candidate === outcomeRaw);
  if (!outcome) {
    errors.push(
      `\`outcome\` must be exactly one of ${FACTORY_REPORT_OUTCOMES.join(', ')}; ` +
        `got ${JSON.stringify(outcomeRaw)}.`,
    );
  }

  const branch = typeof value['branch'] === 'string' ? value['branch'].trim() : '';
  if (branch.length === 0) errors.push('`branch` is required.');

  const headSha = value['headSha'];
  if (outcome === 'IMPLEMENTED' && !isCommitSha(headSha)) {
    errors.push(
      '`headSha` must be a 40-character lowercase hex commit sha for an IMPLEMENTED unit. ' +
        'If nothing was pushed, report BLOCKED and say which operation was refused.',
    );
  }

  const filesChanged = stringArray(value['filesChanged'], 'filesChanged', errors);

  const commands: FactoryCommandRun[] = [];
  const commandsRaw = value['commands'];
  if (commandsRaw !== undefined) {
    if (!Array.isArray(commandsRaw)) {
      errors.push('`commands` is a list.');
    } else {
      for (const entry of commandsRaw) {
        const command = asObject(entry);
        if (!command) {
          errors.push('`commands` contains an entry that is not an object.');
          continue;
        }
        const name = typeof command['command'] === 'string' ? command['command'].trim() : '';
        const exitCode = command['exitCode'];
        if (name.length === 0 || typeof exitCode !== 'number' || !Number.isInteger(exitCode)) {
          errors.push('Each command needs a `command` string and an integer `exitCode`.');
          continue;
        }
        commands.push({ command: name, exitCode });
      }
    }
  }

  const summary = typeof value['summary'] === 'string' ? value['summary'].trim() : '';
  if (summary.length === 0) errors.push('`summary` is required.');

  const blockedRaw = value['blockedReason'];
  const blockedReason =
    typeof blockedRaw === 'string' && blockedRaw.trim().length > 0 ? blockedRaw.trim() : null;
  if (outcome === 'BLOCKED' && !blockedReason) {
    errors.push('A BLOCKED outcome must say why, in `blockedReason`.');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      unitKey,
      outcome: outcome as FactoryReportOutcome,
      branch,
      // Empty for a blocked unit, which pushed nothing. Every consumer checks the
      // outcome before it reads this.
      headSha: isCommitSha(headSha) ? headSha : '',
      filesChanged,
      commands,
      summary,
      blockedReason,
    },
  };
}

/** Parse one review report. `PASS` alongside a BLOCKER finding is refused. */
export function parseReviewReport(raw: unknown): Parsed<FactoryReviewReport> {
  const errors: string[] = [];
  const value = asObject(raw);
  if (!value) return { ok: false, errors: ['The review is not a structured object.'] };

  const unexpected = unknownFields(value, REVIEW_REPORT_FIELDS);
  if (unexpected.length > 0) {
    return {
      ok: false,
      errors: [`The review carries fields this contract does not define: ${unexpected.join(', ')}.`],
    };
  }

  const verdict = REVIEW_VERDICTS.find((candidate) => candidate === value['verdict']);
  if (!verdict) {
    errors.push(`\`verdict\` must be exactly one of ${REVIEW_VERDICTS.join(', ')}.`);
  }
  const reviewedSha = value['reviewedSha'];
  if (!isCommitSha(reviewedSha)) {
    errors.push('`reviewedSha` must be a 40-character lowercase hex commit sha.');
  }
  const summary = typeof value['summary'] === 'string' ? value['summary'].trim() : '';
  if (summary.length === 0) errors.push('`summary` is required.');

  const findings: FactoryReviewFinding[] = [];
  const findingsRaw = value['findings'];
  if (findingsRaw !== undefined) {
    if (!Array.isArray(findingsRaw)) {
      errors.push('`findings` is a list.');
    } else {
      const keys = new Set<string>();
      for (const entry of findingsRaw) {
        const finding = asObject(entry);
        if (!finding) {
          errors.push('`findings` contains an entry that is not an object.');
          continue;
        }
        const bad = unknownFields(finding, FINDING_FIELDS);
        if (bad.length > 0) {
          errors.push(`A finding carries undefined fields: ${bad.join(', ')}.`);
          continue;
        }
        const key = typeof finding['key'] === 'string' ? finding['key'].trim() : '';
        const severity = FINDING_SEVERITIES.find((candidate) => candidate === finding['severity']);
        const category = typeof finding['category'] === 'string' ? finding['category'].trim() : '';
        const statement = typeof finding['statement'] === 'string' ? finding['statement'].trim() : '';
        const evidence = typeof finding['evidence'] === 'string' ? finding['evidence'].trim() : '';
        if (key.length === 0 || !severity || statement.length === 0 || evidence.length === 0) {
          errors.push(
            'Each finding needs a `key`, an exact `severity`, a `statement` and `evidence`.',
          );
          continue;
        }
        if (keys.has(key)) {
          errors.push(`Finding key "${key}" appears twice.`);
          continue;
        }
        keys.add(key);
        const conditionRaw = finding['acceptanceConditionId'];
        findings.push({
          key,
          severity,
          category: category.length > 0 ? category : 'unclassified',
          statement,
          evidence,
          acceptanceConditionId:
            typeof conditionRaw === 'string' && conditionRaw.trim().length > 0
              ? conditionRaw.trim()
              : null,
        });
      }
    }
  }

  // The same refusal `review.ts` already makes locally, for the same reason: a
  // pass that carries a blocker is two statements that cannot both be true, and
  // recording either of them would be choosing one on the worker's behalf.
  if (verdict === 'PASS' && findings.some((finding) => finding.severity === 'BLOCKER')) {
    errors.push('A PASS verdict cannot carry a BLOCKER finding.');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      verdict: verdict as FactoryReviewReportVerdict,
      reviewedSha: reviewedSha as string,
      summary,
      findings,
    },
  };
}

export function reportRefused(errors: string[]): FactoryError {
  return new FactoryError(`The report was refused: ${errors.join(' ')}`, {
    reason: 'REPORT_REFUSED',
    errors,
  });
}

/* ------------------------------------------------------------------------- */
/* The integration report                                                     */
/* ------------------------------------------------------------------------- */

/**
 * What an integrator says it did.
 *
 * A unit report is about one branch; this is about the one branch that carries
 * the campaign — the integration branch a pull request's head points at. It is a
 * separate report and a separate bin because integrating is a separate decision:
 * a unit is verified for staying inside its own paths, and the integration is
 * verified for carrying every unit and nothing else, and the two questions are
 * answered against different commit ranges.
 *
 * `outcome` carries the same two words a unit report does, and for the same
 * reason: the honest answer to a merge conflict or a red verification is that the
 * integration did not happen, which is a fact Brain records rather than a failure
 * it hides. An integrator that could not get the tree green is told not to push —
 * and therefore has no commit to name, which is why `headSha` is required only of
 * an integration that actually landed. Requiring it of both is what made the
 * first hosted integration's correct BLOCKED report unsubmittable.
 */
export interface FactoryIntegrationMerge {
  unitKey: string;
  branch: string;
  headSha: string;
}

export interface FactoryIntegrationReport {
  outcome: FactoryReportOutcome;
  /** The branch Brain named for this campaign. Compared, never trusted. */
  integrationBranch: string;
  /** Where that branch now points. Confirmed with the forge. */
  headSha: string;
  /** The unit branches it claims to carry. Each one's containment is confirmed. */
  merged: FactoryIntegrationMerge[];
  /** Units whose branches would not merge, with the conflict the worker saw. */
  conflicts: string[];
  /** The contract's own commands, run on the merged tree. */
  commands: FactoryCommandRun[];
  summary: string;
  blockedReason: string | null;
}

const INTEGRATION_REPORT_FIELDS = new Set([
  'outcome',
  'integrationBranch',
  'headSha',
  'merged',
  'conflicts',
  'commands',
  'summary',
  'blockedReason',
]);

const MERGE_FIELDS = new Set(['unitKey', 'branch', 'headSha']);

function commandRuns(raw: unknown, errors: string[]): FactoryCommandRun[] {
  const commands: FactoryCommandRun[] = [];
  if (raw === undefined) return commands;
  if (!Array.isArray(raw)) {
    errors.push('`commands` is a list.');
    return commands;
  }
  for (const entry of raw) {
    const command = asObject(entry);
    if (!command) {
      errors.push('`commands` contains an entry that is not an object.');
      continue;
    }
    const unexpected = unknownFields(command, new Set(['command', 'exitCode']));
    if (unexpected.length > 0) {
      errors.push(`A command entry carries unknown field(s): ${unexpected.join(', ')}.`);
      continue;
    }
    const name = typeof command['command'] === 'string' ? command['command'].trim() : '';
    const exitCode = command['exitCode'];
    if (name.length === 0 || typeof exitCode !== 'number' || !Number.isInteger(exitCode)) {
      errors.push('Each command needs a `command` string and an integer `exitCode`.');
      continue;
    }
    commands.push({ command: name, exitCode });
  }
  return commands;
}

export function parseIntegrationReport(raw: unknown): Parsed<FactoryIntegrationReport> {
  const errors: string[] = [];
  const value = asObject(raw);
  if (!value) return { ok: false, errors: ['The integration report is not a structured object.'] };

  const unexpected = unknownFields(value, INTEGRATION_REPORT_FIELDS);
  if (unexpected.length > 0) {
    return {
      ok: false,
      errors: [
        `The integration report carries ${unexpected.length} field(s) this contract does not ` +
          `define: ${unexpected.join(', ')}. The whole report is refused.`,
      ],
    };
  }

  const outcomeRaw = value['outcome'];
  const outcome = FACTORY_REPORT_OUTCOMES.find((candidate) => candidate === outcomeRaw);
  if (!outcome) {
    errors.push(
      `\`outcome\` must be exactly one of ${FACTORY_REPORT_OUTCOMES.join(', ')}; ` +
        `got ${JSON.stringify(outcomeRaw)}.`,
    );
  }

  const integrationBranch =
    typeof value['integrationBranch'] === 'string' ? value['integrationBranch'].trim() : '';
  if (integrationBranch.length === 0) errors.push('`integrationBranch` is required.');

  const headSha = value['headSha'];
  if (outcome === 'IMPLEMENTED' && !isCommitSha(headSha)) {
    errors.push(
      '`headSha` must be a 40-character lowercase hex commit sha for an integration that ' +
        'landed. A BLOCKED integration pushed nothing and needs none.',
    );
  }

  const merged: FactoryIntegrationMerge[] = [];
  const mergedRaw = value['merged'];
  if (!Array.isArray(mergedRaw)) {
    errors.push('`merged` is a list of the unit branches this integration carries.');
  } else {
    const seen = new Set<string>();
    for (const entry of mergedRaw) {
      const row = asObject(entry);
      if (!row) {
        errors.push('`merged` contains an entry that is not an object.');
        continue;
      }
      const extra = unknownFields(row, MERGE_FIELDS);
      if (extra.length > 0) {
        errors.push(`A merged entry carries unknown field(s): ${extra.join(', ')}.`);
        continue;
      }
      const unitKey = typeof row['unitKey'] === 'string' ? row['unitKey'].trim() : '';
      const branch = typeof row['branch'] === 'string' ? row['branch'].trim() : '';
      if (unitKey.length === 0 || branch.length === 0 || !isCommitSha(row['headSha'])) {
        errors.push(
          'Each merged entry needs a `unitKey`, a `branch` and a 40-character hex `headSha`.',
        );
        continue;
      }
      if (seen.has(unitKey)) {
        // Two entries for one unit would make "which commit did this unit land
        // as" ambiguous, and an ambiguous answer is worse than none.
        errors.push(`\`merged\` names "${unitKey}" more than once.`);
        continue;
      }
      seen.add(unitKey);
      merged.push({ unitKey, branch, headSha: row['headSha'] as string });
    }
  }

  const conflicts = stringArray(value['conflicts'], 'conflicts', errors);
  const commands = commandRuns(value['commands'], errors);

  const summary = typeof value['summary'] === 'string' ? value['summary'].trim() : '';
  if (summary.length === 0) errors.push('`summary` is required.');

  const blockedRaw = value['blockedReason'];
  const blockedReason =
    typeof blockedRaw === 'string' && blockedRaw.trim().length > 0 ? blockedRaw.trim() : null;
  if (outcome === 'BLOCKED' && !blockedReason) {
    errors.push('A BLOCKED integration must say why, in `blockedReason`.');
  }
  if (outcome === 'IMPLEMENTED' && merged.length === 0) {
    errors.push(
      'An integration that carries no unit branch is not an integration. Report BLOCKED with ' +
        'the reason instead.',
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      outcome: outcome as FactoryReportOutcome,
      integrationBranch,
      // Empty when the integration was blocked: the branch did not move, so there
      // is no commit to name. `ingestIntegrateBin` reads the outcome first.
      headSha: isCommitSha(headSha) ? headSha : '',
      merged,
      conflicts,
      commands,
      summary,
      blockedReason,
    },
  };
}

/* ------------------------------------------------------------------------- */
/* The delivery report                                                        */
/* ------------------------------------------------------------------------- */

/**
 * What a worker says about the pull request it opened or updated.
 *
 * Brain supplies the title and the body, so this report carries neither: the only
 * facts it adds are which request now exists and what its head is, and both are
 * then read back from the forge. A worker that wrote its own body would be
 * authoring the account of work it did itself, which is the one thing §25 says a
 * summary may never be.
 */
export interface FactoryDeliveryReport {
  outcome: FactoryReportOutcome;
  pullRequest: number | null;
  headSha: string;
  /** `OPENED` or `UPDATED`, so "exactly once" is answerable from the row. */
  action: string;
  summary: string;
  blockedReason: string | null;
}

const DELIVERY_FIELDS = new Set([
  'outcome',
  'pullRequest',
  'headSha',
  'action',
  'summary',
  'blockedReason',
]);

const DELIVERY_ACTIONS = ['OPENED', 'UPDATED'] as const;

export function parseDeliveryReport(raw: unknown): Parsed<FactoryDeliveryReport> {
  const errors: string[] = [];
  const value = asObject(raw);
  if (!value) return { ok: false, errors: ['The delivery report is not a structured object.'] };

  const unexpected = unknownFields(value, DELIVERY_FIELDS);
  if (unexpected.length > 0) {
    return {
      ok: false,
      errors: [
        `The delivery report carries field(s) this contract does not define: ` +
          `${unexpected.join(', ')}. The whole report is refused.`,
      ],
    };
  }

  const outcomeRaw = value['outcome'];
  const outcome = FACTORY_REPORT_OUTCOMES.find((candidate) => candidate === outcomeRaw);
  if (!outcome) {
    errors.push(
      `\`outcome\` must be exactly one of ${FACTORY_REPORT_OUTCOMES.join(', ')}; ` +
        `got ${JSON.stringify(outcomeRaw)}.`,
    );
  }

  const numberRaw = value['pullRequest'];
  let pullRequest: number | null = null;
  if (typeof numberRaw === 'number' && Number.isInteger(numberRaw) && numberRaw > 0) {
    pullRequest = numberRaw;
  } else if (numberRaw !== null && numberRaw !== undefined) {
    errors.push('`pullRequest` is the request number, as a positive integer.');
  }
  if (outcome === 'IMPLEMENTED' && pullRequest === null) {
    errors.push('A delivered pull request has a number.');
  }

  const headSha = value['headSha'];
  if (outcome === 'IMPLEMENTED' && !isCommitSha(headSha)) {
    errors.push('`headSha` must be the 40-character hex commit the request now points at.');
  }

  const actionRaw = value['action'];
  const action = DELIVERY_ACTIONS.find((candidate) => candidate === actionRaw);
  if (outcome === 'IMPLEMENTED' && !action) {
    errors.push(`\`action\` must be exactly one of ${DELIVERY_ACTIONS.join(', ')}.`);
  }

  const summary = typeof value['summary'] === 'string' ? value['summary'].trim() : '';
  if (summary.length === 0) errors.push('`summary` is required.');

  const blockedRaw = value['blockedReason'];
  const blockedReason =
    typeof blockedRaw === 'string' && blockedRaw.trim().length > 0 ? blockedRaw.trim() : null;
  if (outcome === 'BLOCKED' && !blockedReason) {
    errors.push('A BLOCKED delivery must say why, in `blockedReason`.');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      outcome: outcome as FactoryReportOutcome,
      pullRequest,
      headSha: isCommitSha(headSha) ? headSha : '',
      action: action ?? '',
      summary,
      blockedReason,
    },
  };
}

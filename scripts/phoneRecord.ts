/**
 * What a deployed phone reading is, and what makes one evidence about a
 * particular Brain at a particular revision.
 *
 * ---------------------------------------------------------------------------
 * Why this is a module rather than two copies
 * ---------------------------------------------------------------------------
 *
 * `visual-qa.ts --deployed` writes the record and `step12b-acceptance.ts` reads
 * it. The shape was declared separately in each, and the reader validated
 * nothing at all — it cast the parsed JSON (`JSON.parse(...) as
 * DeployedPhoneRecord`), which is not a check. So any JSON object became a
 * record; a reading of somebody else's deployment was read as evidence about
 * this one; a `revisionMatches: true` sitting beside two revisions that differ
 * was believed; and findings the harness itself recorded were never consulted.
 *
 * One definition and one validator, imported by both, for the reason
 * `restorationOf` lives beside the rollback it describes: **a rule applied by
 * one of two readers is worse than none**, and the one nobody runs is the one
 * that drifts.
 *
 * Pure, and it takes the facts it judges against as arguments — the intended
 * host and the revision being judged — so nothing here can decide what it is
 * evidence *about*. That decision belongs to the reporter, which reads it from
 * the repository (`fly.toml`, and git) rather than from the attachment.
 */

export interface DeployedPhoneRecord {
  /** The origin inspected. Never a credential, and never a path. */
  brain: string;
  inspectedAt: string;
  /**
   * The revision the deployed Brain reports for **itself**, from the
   * authenticated `/api/health`. `null` when this person is not a Brain
   * administrator there, or when nothing stamped the build.
   */
  deployedRevision: string | null;
  /** What the caller said this reading is *for*, so a mismatch is visible. */
  expectedRevision: string | null;
  revisionMatches: boolean | null;
  /** Did a question a person typed get a completed answer, readable on screen? */
  answeredQuestion: {
    found: boolean;
    status: string | null;
    conversationId: string | null;
    /** The first words of the answer, which is what the screen check looks for. */
    excerpt: string | null;
    readOnScreen: boolean;
    screenSaw: string | null;
  };
  /** Was the work *that conversation caused* readable as a conclusion? */
  missionLinkedResult: {
    found: boolean;
    missionId: string | null;
    /** The mission came from the conversation whose answer was read. */
    missionFromConversation: boolean;
    knowledgeId: string | null;
    statement: string | null;
    citesDocument: boolean;
    citesAudit: boolean;
    readOnScreen: boolean;
    screenSaw: string | null;
  };
  screenshots: string[];
  /** What the harness itself found outstanding on that run. */
  findings: string[];
}

/** Is this parsed JSON shaped like a reading at all? */
export function isPhoneRecord(value: unknown): value is DeployedPhoneRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<DeployedPhoneRecord>;
  const answered = record.answeredQuestion;
  const linked = record.missionLinkedResult;
  return (
    typeof record.brain === 'string' &&
    typeof record.inspectedAt === 'string' &&
    !Number.isNaN(Date.parse(record.inspectedAt)) &&
    (record.deployedRevision === null || typeof record.deployedRevision === 'string') &&
    (record.expectedRevision === null || typeof record.expectedRevision === 'string') &&
    (record.revisionMatches === null || typeof record.revisionMatches === 'boolean') &&
    typeof answered === 'object' &&
    answered !== null &&
    typeof answered.found === 'boolean' &&
    typeof answered.readOnScreen === 'boolean' &&
    typeof linked === 'object' &&
    linked !== null &&
    typeof linked.found === 'boolean' &&
    typeof linked.missionFromConversation === 'boolean' &&
    typeof linked.readOnScreen === 'boolean' &&
    Array.isArray(record.screenshots) &&
    Array.isArray(record.findings) &&
    record.findings.every((finding) => typeof finding === 'string')
  );
}

/**
 * Every way a reading can fail to be about this run, named.
 *
 * Separate strings rather than one boolean, because they send a reader
 * somewhere different: a wrong host means the reading is of somebody else's
 * Brain, a wrong revision means it is of this Brain before or after the tree
 * being judged, and a contradictory flag means the record is not internally
 * consistent — at which point none of its other fields can be trusted either.
 *
 * `intendedHost` and `revision` are `null` when the caller genuinely cannot
 * establish them (a run inside the deployed image carries no `fly.toml` and no
 * git). That is an absence and it is reported as a problem, never waved
 * through: a reading that cannot be bound to a deployment is not weaker
 * evidence about it, it is evidence about something unidentified.
 */
export function phoneRecordProblems(
  record: DeployedPhoneRecord,
  against: { intendedHost: string | null; revision: string | null },
): string[] {
  const problems: string[] = [];

  let host: string | null = null;
  try {
    const url = new URL(record.brain);
    host = url.hostname;
    if (url.protocol !== 'https:') {
      problems.push(`the reading names ${record.brain}, which is not https`);
    }
  } catch {
    problems.push(`the reading names ${record.brain}, which is not an origin`);
  }
  if (against.intendedHost === null) {
    problems.push('this run cannot say which Brain was intended, so nothing can be bound to one');
  } else if (host !== null && host !== against.intendedHost) {
    problems.push(
      `the reading is of ${host} and this tree deploys ${against.intendedHost} — ` +
        'a reading of another deployment is evidence about something else',
    );
  }

  if (record.deployedRevision === null) {
    problems.push(
      'the reading names no deployed revision. `/api/health` returns one only to a Brain ' +
        'administrator, so a reading taken by somebody else cannot be bound to a deployment',
    );
  } else if (!/^[0-9a-f]{40}$/.test(record.deployedRevision)) {
    problems.push('deployedRevision is not a 40-character commit id');
  } else if (against.revision === null) {
    problems.push('this run cannot name its own revision, so nothing can be bound to it');
  } else if (record.deployedRevision !== against.revision) {
    problems.push(
      `the reading is of ${record.deployedRevision.slice(0, 8)} and this run is ` +
        against.revision.slice(0, 8),
    );
  }

  /*
   * The flag, against the two values it is a claim about.
   *
   * `revisionMatches` is the harness's own summary of its own inputs, and a
   * summary that disagrees with them is the one thing a reader must never take
   * at face value. Refused rather than silently recomputed: a record that
   * contradicts itself is not one whose other fields are trustworthy.
   */
  const bothPresent = record.deployedRevision !== null && record.expectedRevision !== null;
  if (record.revisionMatches !== null && bothPresent) {
    const actually = record.deployedRevision === record.expectedRevision;
    if (record.revisionMatches !== actually) {
      problems.push(
        `revisionMatches says ${record.revisionMatches} while the reading names ` +
          `${record.deployedRevision?.slice(0, 8)} deployed and ` +
          `${record.expectedRevision?.slice(0, 8)} expected`,
      );
    }
  } else if (record.revisionMatches === true && !bothPresent) {
    problems.push('revisionMatches is true while one of the two revisions it compares is absent');
  }

  return problems;
}

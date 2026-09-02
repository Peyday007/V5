/**
 * Audit independence, as a fact about execution rather than a naming convention.
 *
 * Step 10 ran three audit roles — primary, adversarial, judge — and they were
 * three prompts. Nothing stopped one session from performing all three, and
 * nothing recorded that it had. The pipeline's own comment says the roles are
 * separate "so running them together would produce three independent opinions
 * rather than one argument", which is true about the *prompts* and says nothing
 * about who ran them.
 *
 * That gap is invisible while one worker exists, which is exactly why Step 11
 * closes it: with a fleet, the same session performing its own adversarial
 * review is no longer a theoretical objection, it is the default outcome of a
 * worker that drains a bin and asks for another.
 *
 * So a pass records the worker, Routine, account and session that produced it,
 * and this module decides whether a set of passes satisfies a versioned policy.
 * The decision is over lineage columns only — never over the role name the
 * submitter claimed, because a submitter claiming a role is the thing being
 * checked.
 */
import type { ResearchPass } from '../../domain/types.ts';

/**
 * How separate the roles have to be.
 *
 * Versioned because it is a policy, and because a packet audited under one
 * level must stay explicable after the level changes. `SESSION` is the floor
 * that costs nothing to meet with one account; `ACCOUNT` is the level a real
 * fleet can meet and the one Step 11 is asked to prove.
 */
export const INDEPENDENCE_LEVELS = ['NONE', 'SESSION', 'WORKER', 'ACCOUNT'] as const;
export type IndependenceLevel = (typeof INDEPENDENCE_LEVELS)[number];

export const INDEPENDENCE_POLICY_VERSION = 'INDEPENDENCE_V1';

export interface AuditLineage {
  role: 'PRIMARY' | 'ADVERSARIAL' | 'JUDGE';
  workerId: string | null;
  routineId: string | null;
  accountId: string | null;
  sessionRef: string | null;
}

export interface IndependenceVerdict {
  ok: boolean;
  level: IndependenceLevel;
  policyVersion: string;
  violations: string[];
  /** What was compared, so a refusal can be read without the rows. */
  observed: AuditLineage[];
}

/**
 * The dimension a level compares on.
 *
 * Returned as a getter rather than branched on at each call site, so adding a
 * level cannot leave one comparison behind on the old rule.
 */
function dimension(level: IndependenceLevel): {
  key: (l: AuditLineage) => string | null;
  noun: string;
} {
  switch (level) {
    case 'ACCOUNT':
      return { key: (l) => l.accountId, noun: 'account' };
    case 'WORKER':
      return { key: (l) => l.workerId, noun: 'worker' };
    case 'SESSION':
    default:
      return { key: (l) => l.sessionRef, noun: 'session' };
  }
}

/**
 * Does this packet's audit lineage satisfy the policy?
 *
 * Three rules, and the first is the one that matters most:
 *
 *   1. **The synthesis cannot audit itself.** A session that wrote the report
 *      reviewing its own report is not an audit at any level, so this is
 *      checked even at `NONE`.
 *   2. **Primary and adversarial must differ**, at the configured dimension.
 *      They are an argument; one voice performing both is a monologue.
 *   3. **The judge must differ from both**, and should differ from the
 *      synthesis where capacity allows.
 *
 * Unknown lineage is a violation, not a pass. A pass that recorded no session
 * cannot be shown to be independent, and "we could not tell" must never read
 * the same as "we checked".
 */
export function checkIndependence(input: {
  level: IndependenceLevel;
  synthesis: AuditLineage | null;
  audits: AuditLineage[];
}): IndependenceVerdict {
  const { level, synthesis, audits } = input;
  const violations: string[] = [];
  const observed = [...(synthesis ? [synthesis] : []), ...audits];

  const byRole = new Map<string, AuditLineage>();
  for (const lineage of audits) byRole.set(lineage.role, lineage);

  const { key, noun } = dimension(level);

  // (1) Self-audit, checked at every level including NONE.
  if (synthesis) {
    for (const audit of audits) {
      if (audit.sessionRef && synthesis.sessionRef && audit.sessionRef === synthesis.sessionRef) {
        violations.push(
          `The ${audit.role} audit ran in the same session as the synthesis ` +
            `(${audit.sessionRef}). A report cannot review itself.`,
        );
      }
    }
  }

  if (level === 'NONE') {
    return {
      ok: violations.length === 0,
      level,
      policyVersion: INDEPENDENCE_POLICY_VERSION,
      violations,
      observed,
    };
  }

  const primary = byRole.get('PRIMARY');
  const adversarial = byRole.get('ADVERSARIAL');
  const judge = byRole.get('JUDGE');

  // (2) and (3): every pair that must differ, with unknown counted as a failure.
  const mustDiffer: [AuditLineage | undefined, AuditLineage | undefined, string][] = [
    [primary, adversarial, 'PRIMARY and ADVERSARIAL'],
    [judge, primary, 'JUDGE and PRIMARY'],
    [judge, adversarial, 'JUDGE and ADVERSARIAL'],
  ];

  for (const [a, b, label] of mustDiffer) {
    if (!a || !b) continue;
    const ka = key(a);
    const kb = key(b);
    if (ka === null || kb === null) {
      violations.push(
        `${label} cannot be compared: one of them recorded no ${noun}. Unrecorded lineage is ` +
          'not evidence of independence.',
      );
      continue;
    }
    if (ka === kb) {
      violations.push(`${label} shared the same ${noun} (${ka}).`);
    }
  }

  return {
    ok: violations.length === 0,
    level,
    policyVersion: INDEPENDENCE_POLICY_VERSION,
    violations,
    observed,
  };
}

/** The pass ordinals the audit roles occupy, mirroring `auditBrief.ts`. */
const ROLE_BY_ORDINAL: Record<number, AuditLineage['role']> = {
  5: 'PRIMARY',
  6: 'ADVERSARIAL',
  7: 'JUDGE',
};

/** Read lineage out of the recorded passes. Nothing is inferred or defaulted. */
export function lineageFromPasses(passes: ResearchPass[]): {
  synthesis: AuditLineage | null;
  audits: AuditLineage[];
} {
  const audits: AuditLineage[] = [];
  let synthesis: AuditLineage | null = null;

  for (const pass of passes) {
    // These were read through a cast while the columns existed and the view
    // type did not — which is precisely how this module came to look wired
    // when nothing wrote them. They are real fields now, so read them as such.
    const lineage = {
      workerId: pass.executorWorkerId ?? null,
      routineId: pass.executorRoutineId ?? null,
      accountId: pass.executorAccountId ?? null,
      sessionRef: pass.executorSessionRef ?? null,
    };
    if (pass.passKey === 'SYNTHESIS' && pass.status === 'COMPLETE') {
      synthesis = { role: 'PRIMARY', ...lineage };
      continue;
    }
    if (pass.passKey !== 'AUDIT' || pass.status !== 'COMPLETE') continue;
    const role = ROLE_BY_ORDINAL[pass.ordinal];
    if (!role) continue;
    audits.push({ role, ...lineage });
  }
  return { synthesis, audits };
}

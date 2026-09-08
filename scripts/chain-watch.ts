/**
 * Watch the acceptance chain, from the outside, changing nothing.
 *
 * The acceptance reporter prints verdicts against a scope pinned in code, so it
 * answers "has the standard been met" and cannot answer "where has the run got
 * to". This answers the second question: the same rows, no judgement, at any
 * moment.
 *
 * It runs **inside the machine**, like every other production read here. The
 * first version ran from a checkout against `BRAIN_DATABASE_URL`, on the
 * assumption that it was a repository secret because `step12a-inspect.yml`
 * guards on one — it is not, it is a Fly secret, and that guard has always been
 * skipping silently. Recorded rather than quietly corrected: a guard that has
 * never fired is indistinguishable from one that always passes.
 *
 * **Read-only, and deliberately content-blind.** No message body, no candidate
 * statement, no probe page, no credential. A reason is reported as present and
 * how long it is, never quoted: the standing rule is that diagnostics carry
 * structure and not content, and "a reason is stored" is a structural fact.
 *
 * It reports; it does not judge. Deciding whether a condition is met is
 * `scripts/step12a-acceptance.ts`'s job against pinned scope, and a second
 * opinion that could disagree with it would be worse than none.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';

const SLUG = process.env['CHAIN_PROJECT'] ?? 'deal-dispatch';
/** A conversation to anchor on. Omitted, the most recent one in the project. */
const ANCHOR = process.env['CHAIN_CONVERSATION'] ?? '';

function line(label: string, value: string | number | null): void {
  console.log(`  ${label.padEnd(26)} ${value ?? '—'}`);
}

async function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  try {
    return await getDb().all<T>(sql, params as never[]);
  } catch (error) {
    console.log(`  ! ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function main(): Promise<void> {
  await initDatabase();

  const projects = await all<{ id: string; name: string }>(
    `SELECT id, name FROM projects WHERE slug = ?`,
    [SLUG],
  );
  const project = projects[0];
  if (!project) {
    console.log(`No project with slug ${SLUG}.`);
    return;
  }
  console.log(`PROJECT  ${project.name}  ${project.id}`);

  /* --------------------------------------------------------------- authority */
  const goals = await all<{
    id: string;
    name: string;
    state: string;
    max_missions: number;
    max_fragments: number;
    max_concurrent: number;
    max_probes: number;
    owner_user_id: string;
    expires_at: string | null;
    created_at: string;
  }>(
    `SELECT id, name, state, max_missions, max_fragments, max_concurrent, max_probes,
            owner_user_id, expires_at, created_at
       FROM russell_goals WHERE project_id = ? ORDER BY created_at DESC`,
    [project.id],
  );
  console.log('');
  console.log(`STANDING AUTHORITY  ${goals.length} grant(s)`);
  for (const goal of goals) {
    line('id / state', `${goal.id} ${goal.state}`);
    line('name', goal.name);
    line(
      'limits',
      `missions ${goal.max_missions} · fragments ${goal.max_fragments} · ` +
        `concurrent ${goal.max_concurrent} · probes ${goal.max_probes}`,
    );
    line('owner / granted', `${goal.owner_user_id} ${goal.created_at}`);
    line('expires', goal.expires_at);

    /*
     * What has actually been spent against it, per kind, from the rows.
     *
     * The limits above are what the card *says*; these are what the counters
     * *count*, and on 2026-09-08 they turned out not to be the same thing. Two
     * of the four kinds have no producer at all — nothing anywhere reserves a
     * FRAGMENT or a PROBE — so those ceilings read zero for ever however much
     * research runs. Printing the kinds rather than a total is what makes that
     * visible instead of inferable.
     *
     * `live` is what `maxConcurrent` counts and `committed` is what the total
     * ceilings count, named the same way `authorityFor` names them so a reading
     * here and a reading on the card cannot drift.
     */
    const reservations = await all<{
      kind: string;
      state: string;
      amount: number;
      expires_at: string;
      settled_at: string | null;
      released_at: string | null;
    }>(
      `SELECT kind, state, amount, expires_at, settled_at, released_at
         FROM russell_budget_reservations WHERE goal_id = ?
        ORDER BY kind, rowid`,
      [goal.id],
    );
    const now = new Date().toISOString();
    for (const kind of ['MISSION', 'FRAGMENT', 'PROBE']) {
      const mine = reservations.filter((row) => row.kind === kind);
      const committed = mine.filter(
        (row) => row.state === 'SETTLED' || (row.state === 'HELD' && row.expires_at > now),
      ).length;
      const live = mine.filter((row) => row.state === 'HELD' && row.expires_at > now).length;
      const lapsed = mine.filter((row) => row.state === 'HELD' && row.expires_at <= now).length;
      const released = mine.filter((row) => row.state === 'RELEASED').length;
      line(
        `spent ${kind.toLowerCase()}`,
        `rows ${mine.length} · committed ${committed} · live ${live} · ` +
          `lapsed ${lapsed} · released ${released}`,
      );
    }
    console.log('');
  }
  if (goals.length === 0) {
    console.log('  none — every judged idea will park, correctly, until one exists.');
    console.log('');
  }

  /* ------------------------------------------------------------ the anchor */
  const conversations = await all<{
    id: string;
    title: string;
    visibility: string;
    project_id: string | null;
    attachment_source: string;
    created_at: string;
    turns: number;
  }>(
    ANCHOR
      ? `SELECT c.id, c.title, c.visibility, c.project_id, c.attachment_source, c.created_at,
                (SELECT COUNT(*) FROM russell_messages m WHERE m.conversation_id = c.id) AS turns
           FROM russell_conversations c WHERE c.id = ?`
      : `SELECT c.id, c.title, c.visibility, c.project_id, c.attachment_source, c.created_at,
                (SELECT COUNT(*) FROM russell_messages m WHERE m.conversation_id = c.id) AS turns
           FROM russell_conversations c WHERE c.project_id = ?
          ORDER BY c.created_at DESC LIMIT 5`,
    [ANCHOR || project.id],
  );

  console.log(ANCHOR ? 'ANCHOR' : 'FIVE MOST RECENT CONVERSATIONS');
  for (const conversation of conversations) {
    console.log(
      `  ${conversation.id}  ${conversation.created_at}  ${conversation.visibility}  ` +
        `${conversation.attachment_source}  turns=${conversation.turns}`,
    );
  }
  console.log('');

  const anchor = ANCHOR || conversations[0]?.id;
  if (!anchor) return;
  console.log(`CHAIN FROM  ${anchor}`);
  console.log('');

  /* -------------------------------------------------------------- the turns */
  const messages = await all<{
    id: string;
    role: string;
    status: string;
    answers_message_id: string | null;
    attempt: number | null;
    length: number;
    created_at: string;
  }>(
    `SELECT id, role, status, answers_message_id, attempt, LENGTH(content) AS length, created_at
       FROM russell_messages WHERE conversation_id = ? ORDER BY created_at, rowid`,
    [anchor],
  );
  console.log(`TURNS  ${messages.length}`);
  for (const message of messages) {
    console.log(
      `  ${message.id}  ${message.role.padEnd(7)} ${message.status.padEnd(9)} ` +
        `answers=${message.answers_message_id ?? '—'} attempt=${message.attempt ?? '—'} ` +
        `chars=${message.length}`,
    );
  }
  console.log('');

  /* ---------------------------------------------------------- the candidates */
  const candidates = await all<{
    id: string;
    state: string;
    priority: string | null;
    canonical_candidate_id: string | null;
    reason_length: number | null;
    override_user_id: string | null;
    superseded: number;
    follow_on_of_mission_id: string | null;
    created_at: string;
  }>(
    `SELECT id, state, priority, canonical_candidate_id,
            LENGTH(reason) AS reason_length, override_user_id,
            CASE WHEN superseded_decision IS NULL THEN 0 ELSE 1 END AS superseded,
            follow_on_of_mission_id, created_at
       FROM russell_candidates WHERE conversation_id = ? ORDER BY created_at, rowid`,
    [anchor],
  );
  console.log(`IDEAS  ${candidates.length}`);
  for (const candidate of candidates) {
    console.log(
      `  ${candidate.id}  ${candidate.state.padEnd(9)} ${(candidate.priority ?? '—').padEnd(12)} ` +
        `canonical=${candidate.canonical_candidate_id ?? '—'} reasonChars=${candidate.reason_length ?? 0} ` +
        `override=${candidate.override_user_id ? 'yes' : 'no'} superseded=${candidate.superseded ? 'yes' : 'no'} ` +
        `followOnOf=${candidate.follow_on_of_mission_id ?? '—'}`,
    );
  }
  const ids = candidates.map((candidate) => candidate.id);
  const bind = ids.map(() => '?').join(',');

  if (ids.length) {
    const merges = await all<{
      candidate_id: string;
      canonical_id: string;
      action: string;
      method: string;
    }>(
      `SELECT candidate_id, canonical_id, action, method FROM russell_candidate_merges
        WHERE candidate_id IN (${bind}) ORDER BY created_at, rowid`,
      ids,
    );
    console.log('');
    console.log(`MERGES  ${merges.length}`);
    for (const merge of merges) {
      console.log(`  ${merge.candidate_id} -> ${merge.canonical_id}  ${merge.action} ${merge.method}`);
    }

    const probes = await all<{
      id: string;
      candidate_id: string;
      state: string;
      outcome: string | null;
      max_lookups: number;
      used: number;
    }>(
      `SELECT p.id, p.candidate_id, p.state, p.outcome, p.max_lookups,
              (SELECT COUNT(*) FROM russell_probe_observations o WHERE o.probe_id = p.id) AS used
         FROM russell_probes p WHERE p.candidate_id IN (${bind}) ORDER BY p.created_at, p.rowid`,
      ids,
    );
    console.log('');
    console.log(`PROBES  ${probes.length}`);
    for (const probe of probes) {
      console.log(
        `  ${probe.id}  ${probe.state.padEnd(9)} ${(probe.outcome ?? '—').padEnd(10)} ` +
          `lookups ${probe.used}/${probe.max_lookups}`,
      );
    }
  }

  /* ----------------------------------------------------------- the missions */
  const missions = await all<{
    id: string;
    state: string;
    orchestration_id: string | null;
    bin_id: string | null;
    document_id: string | null;
    audit_id: string | null;
    writeback_at: string | null;
    next_mission_id: string | null;
    waiting_on: string | null;
  }>(
    `SELECT id, state, orchestration_id, bin_id, document_id, audit_id,
            writeback_at, next_mission_id, waiting_on
       FROM russell_missions WHERE conversation_id = ? ORDER BY created_at, rowid`,
    [anchor],
  );
  console.log('');
  console.log(`MISSIONS  ${missions.length}`);
  for (const mission of missions) {
    console.log(
      `  ${mission.id}  ${mission.state.padEnd(10)} orch=${mission.orchestration_id ?? '—'} ` +
        `bin=${mission.bin_id ?? '—'} doc=${mission.document_id ?? '—'} audit=${mission.audit_id ?? '—'}`,
    );
    console.log(
      `      writeback=${mission.writeback_at ?? '—'} next=${mission.next_mission_id ?? '—'} ` +
        `waitingOn=${mission.waiting_on ? 'set' : '—'}`,
    );
  }

  /* ------------------------------------------------------ the audit lineage */
  const orchestrationIds = missions
    .map((mission) => mission.orchestration_id)
    .filter((id): id is string => Boolean(id));
  if (orchestrationIds.length) {
    const passes = await all<{
      orchestration_id: string;
      pass_key: string;
      status: string;
      executor_worker_id: string | null;
      executor_account_id: string | null;
      executor_session_ref: string | null;
      completed_at: string | null;
    }>(
      `SELECT orchestration_id, pass_key, status, executor_worker_id, executor_account_id,
              executor_session_ref, completed_at
         FROM research_passes
        WHERE orchestration_id IN (${orchestrationIds.map(() => '?').join(',')})
          AND pass_key = 'AUDIT'
        ORDER BY ordinal`,
      orchestrationIds,
    );
    console.log('');
    console.log(`AUDIT PASSES  ${passes.length}`);
    for (const pass of passes) {
      console.log(
        `  ${pass.status.padEnd(10)} worker=${pass.executor_worker_id ?? '—'} ` +
          `account=${pass.executor_account_id ?? '—'} session=${pass.executor_session_ref ?? '—'} ` +
          `done=${pass.completed_at ?? '—'}`,
      );
    }
    const sessions = new Set(passes.map((pass) => pass.executor_session_ref).filter(Boolean));
    line('distinct sessions', sessions.size);
    line('predicted (future:)', [...sessions].filter((s) => String(s).startsWith('future:')).length);
  }

  /* -------------------------------------------------------- the human asks */
  const requests = await all<{
    id: string;
    state: string;
    mission_id: string | null;
    answered_by_user_id: string | null;
    answered_choice: string | null;
    answered_at: string | null;
  }>(
    `SELECT id, state, mission_id, answered_by_user_id, answered_choice, answered_at
       FROM russell_human_requests WHERE conversation_id = ?
          OR mission_id IN (${missions.length ? missions.map(() => '?').join(',') : "''"})
      ORDER BY created_at, rowid`,
    [anchor, ...missions.map((mission) => mission.id)],
  );
  console.log('');
  console.log(`NEEDS YOU  ${requests.length}`);
  for (const request of requests) {
    console.log(
      `  ${request.id}  ${request.state.padEnd(9)} mission=${request.mission_id ?? '—'} ` +
        `choice=${request.answered_choice ?? '—'} by=${request.answered_by_user_id ?? '—'} ` +
        `at=${request.answered_at ?? '—'}`,
    );
  }

  /* ---------------------------------------------------------- the cycle */
  const cycles = await all<{
    state: string;
    cursor_at: string | null;
    generation: number;
    pause_reason: string | null;
    last_error: string | null;
    last_ran_at: string | null;
    max_launches_per_cycle: number;
    max_events_per_cycle: number;
  }>(
    `SELECT state, cursor_at, generation, pause_reason, last_error, last_ran_at,
            max_launches_per_cycle, max_events_per_cycle
       FROM russell_cycle`,
  );
  console.log('');
  console.log('LOOP');
  for (const cycle of cycles) {
    line('state / cursor', `${cycle.state} ${cycle.cursor_at ?? '—'} gen=${cycle.generation}`);
    line('paused because', cycle.pause_reason);
    // The last tick, and whether it threw. A loop that is RUNNING and failing
    // every pass reports the same state as one that is working.
    line('last ran / last error', `${cycle.last_ran_at ?? '—'} ${cycle.last_error ?? 'none'}`);
    /*
     * The per-tick bounds, printed because a zero here stops the run silently.
     * A loop that is RUNNING and permitted to launch nothing looks identical to
     * one with nothing to launch, and only one of those is a problem.
     */
    line(
      'per tick',
      `launches ${cycle.max_launches_per_cycle} · events ${cycle.max_events_per_cycle}`,
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());

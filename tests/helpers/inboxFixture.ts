/**
 * The Needs You inbox, derived from the older fixtures a component suite
 * already scripts (Integration 3).
 *
 * The page reads `GET /api/russell/needs-you/inbox` now. Suites written
 * against the three-source page script `/needs-you` and `/authority`; this
 * turns those same bodies into the inbox the server would compose from them,
 * following `server/services/russell/inbox.ts` field for field, so every
 * existing card assertion still exercises the real card. The server's own
 * mapping is asserted against real rows in `tests/needsYouInbox.test.ts`.
 */
interface LegacyNeedsYou {
  requests: {
    id: string;
    missionId?: string | null;
    authorityNeeded: string;
    whyNotRussell: string;
    recommendation?: string | null;
    choices: { key: string; label: string; consequence: string }[];
    urgency: 'URGENT' | 'BLOCKING' | 'WHENEVER';
    createdAt?: string;
  }[];
  software: {
    request: { id: string; title: string; state: string; createdAt?: string; updatedAt?: string };
    line: string;
    awaitingPerson: boolean;
  }[];
}

export const INBOX_CATEGORIES = [
  { key: 'AUTHORITY', label: 'Permission to act' },
  { key: 'BUDGET', label: 'Budget and ceilings' },
  { key: 'JUDGMENT', label: 'Your judgment' },
  { key: 'RESEARCH_JUDGMENT', label: 'Research that needs your judgment' },
  { key: 'BUYER', label: 'Buyers and agreements' },
  { key: 'INVOICE', label: 'Invoice details' },
  { key: 'FINANCIAL', label: 'Money that needs a person' },
  { key: 'RELEASE', label: 'Approve, merge or release a build' },
  { key: 'CONNECTION', label: 'Connections and accounts' },
  { key: 'OTHER', label: 'Other decisions' },
];

export function inboxFromLegacy(legacy: LegacyNeedsYou, grantMissing: boolean): unknown {
  const items: unknown[] = [];
  if (grantMissing) {
    items.push({
      id: 'authority:research',
      category: 'AUTHORITY',
      title: 'Let Russell research in this project',
      reason: 'Starting research spends shared capacity.',
      ifIgnored: 'Russell starts no research here.',
      requestedAction: 'Approve the standing research permission.',
      affects: 'This project',
      continuing: 'Nothing else can start research until this is answered.',
      urgency: 'BLOCKING',
      since: null,
      action: { type: 'GRANT_RESEARCH_AUTHORITY' },
    });
  }
  for (const request of legacy.requests ?? []) {
    items.push({
      id: `request:${request.id}`,
      category: request.missionId ? 'RESEARCH_JUDGMENT' : 'JUDGMENT',
      title: request.authorityNeeded,
      reason: request.whyNotRussell,
      ifIgnored: 'The work this is about stays stopped at this question.',
      requestedAction: 'Choose one of the answers below.',
      affects: 'This project',
      continuing: 'Brain carries on with everything else meanwhile.',
      urgency: request.urgency,
      since: request.createdAt ?? null,
      action: {
        type: 'ANSWER_REQUEST',
        requestId: request.id,
        choices: request.choices,
        recommendation: request.recommendation ?? null,
      },
    });
  }
  for (const entry of legacy.software ?? []) {
    if (entry.request.state !== 'PROPOSED' && !entry.awaitingPerson) continue;
    items.push({
      id: `software:${entry.request.id}`,
      category: entry.request.state === 'PROPOSED' ? 'AUTHORITY' : 'RELEASE',
      title: entry.request.state === 'PROPOSED' ? `Authorize a change: ${entry.request.title}` : entry.request.title,
      reason: entry.request.state === 'PROPOSED' ? 'Changing code is a decision a person makes.' : entry.line,
      ifIgnored: 'Nothing is built and nothing is spent.',
      requestedAction: 'Answer it on the card below.',
      affects: entry.request.title,
      continuing: 'Brain carries on with everything else meanwhile.',
      urgency: 'WHENEVER',
      since: entry.request.createdAt ?? null,
      action: { type: 'SOFTWARE', requestId: entry.request.id },
    });
  }
  return { items, categories: INBOX_CATEGORIES, unreadable: [] };
}

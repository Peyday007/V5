/**
 * Work this Brain is holding that the register does not account for.
 *
 * The register stores an **intent** and a **purpose**, and neither of those can
 * be derived — so nothing here invents a workstream. §8's rule at a new
 * artefact: a machine composing "what this work is for" would be manufacturing
 * exactly the judgment a person is supposed to supply, and it would read like a
 * decision somebody made.
 *
 * What *can* be derived, and is the difference between a register and a list
 * somebody remembered to type, is the **absence**: a campaign nobody filed, a
 * software request nobody filed, a mission nobody filed. So this answers one
 * question — *what is happening that nothing in the register mentions?* — and
 * offers each one for filing rather than filing it.
 *
 * It is a projection. It writes nothing, and a test asserts that.
 */
import type { LinkKind } from '../../domain/register.ts';
import { listLiveCampaigns, listChangeRequests } from '../../repos/factory.ts';
import { listMissions } from '../../repos/russellMissions.ts';
import { listSoftwareRequests } from '../../repos/russellSoftware.ts';
import { getDb } from '../../db/database.ts';

export interface UnfiledItem {
  kind: LinkKind;
  ref: string;
  title: string;
  /** What state that row is in, in its own words. */
  status: string;
  projectId: string | null;
  /** Why this is worth filing, from the row rather than from a template. */
  why: string;
}

/**
 * Every ref the register already points at, in one query.
 *
 * One read rather than a lookup per candidate: the alternative is a read
 * amplification nobody notices until the register is large, and this is the
 * page a person opens first.
 */
async function alreadyFiled(): Promise<Set<string>> {
  const rows = await getDb().all<{ kind: string; ref: string }>(
    `SELECT kind, ref FROM workstream_links WHERE superseded_at IS NULL`,
  );
  return new Set(rows.map((row) => `${row.kind}:${row.ref}`));
}

export async function unfiledWork(projectIds: string[]): Promise<UnfiledItem[]> {
  const filed = await alreadyFiled();
  const items: UnfiledItem[] = [];

  const push = (item: UnfiledItem): void => {
    if (filed.has(`${item.kind}:${item.ref}`)) return;
    items.push(item);
  };

  /*
   * A live campaign is the clearest case: something is running in the factory
   * and the register cannot say what it is for.
   */
  for (const campaign of await listLiveCampaigns()) {
    if (!projectIds.includes(campaign.projectId)) continue;
    push({
      kind: 'CAMPAIGN',
      ref: campaign.id,
      title: `Campaign on ${campaign.integrationBranch}`,
      status: campaign.state,
      projectId: campaign.projectId,
      why: `A campaign is ${campaign.state} and nothing in the register says what it is for.`,
    });
  }

  for (const projectId of projectIds) {
    for (const request of await listChangeRequests(projectId)) {
      if (request.state === 'WITHDRAWN') continue;
      push({
        kind: 'CHANGE_REQUEST',
        ref: request.id,
        title: request.objective,
        status: request.state,
        projectId,
        why:
          request.state === 'DRAFT'
            ? 'A change request is waiting for a person to approve it.'
            : 'An approved change request is not accounted for in the register.',
      });
    }

    /*
     * A software request that has not become a change request yet has nothing
     * a `CHANGE_REQUEST` link could resolve.
     *
     * The first version of this filed it under its own `rsr_` id anyway, which
     * `readChangeRequest` would then report as missing for ever — a link whose
     * target is gone, on a row that is perfectly healthy. A register that told
     * somebody their work had vanished would be worse than one that had never
     * mentioned it, which is §27's cries-wolf rule at a new reader.
     *
     * So it is offered **only once it has one**. Until then it is the
     * conversation's own business and the bridge's status answers it, which is
     * where a person asking "what happened to what I said" is already looking.
     */
    for (const request of await listSoftwareRequests({ projectId })) {
      if (request.state === 'DECLINED') continue;
      if (!request.changeRequestId) continue;
      push({
        kind: 'CHANGE_REQUEST',
        ref: request.changeRequestId,
        title: request.title,
        status: request.state,
        projectId,
        why: `A software change came out of a conversation and is ${request.state}.`,
      });
    }

    for (const mission of await listMissions({ projectId, states: ['RUNNING', 'NEEDS_HUMAN'] })) {
      push({
        kind: 'MISSION',
        ref: mission.id,
        title: mission.objective,
        status: mission.state,
        projectId,
        why:
          mission.state === 'NEEDS_HUMAN'
            ? 'A mission is waiting on a decision and the register does not mention it.'
            : 'A mission is running and the register does not mention it.',
      });
    }
  }

  return items;
}

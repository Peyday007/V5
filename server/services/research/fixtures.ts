/**
 * Test packets: the machinery, exercised with content nobody has to trust.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * A research packet costs a real account's allowance, and until somebody has
 * watched one go through, there is no way to know whether it is worth spending.
 * That is a bad order to do things in: the first packet is both the thing being
 * tested and the thing being paid for, and if the pipeline mishandles it you
 * have paid to find that out.
 *
 * So a fixture packet runs everything the Brain does by itself — the plan, the
 * approval gate, all seven evidence conditions, acceptance and rejection,
 * dependency ordering, the synthesis, citation resolution, the filed artifact
 * and its ledger — against claims written into this file. Nothing is generated.
 * Nothing is fetched. No allowance is touched.
 *
 * ---------------------------------------------------------------------------
 * What it is not, and the line it must not cross
 * ---------------------------------------------------------------------------
 *
 * `routes/research.ts` refuses to run staged research against a provider that
 * returns placeholder content, and says why: it "would produce a report with
 * invented citations", which is the worst thing this platform could produce.
 * That rule is not being worked around here and this is not a way to do it.
 *
 * The difference is that **nothing invents anything.** Every claim below is a
 * statement somebody wrote down, with a stable primary source, chosen so a
 * reader can check it in under a minute. A fixture packet is a rehearsal with a
 * real script, not a performance by an actor who does not know the lines.
 *
 * Three things keep it from ever being mistaken for research:
 *
 *   - It lives in its own project. It physically cannot reach a layer that
 *     holds work anybody depends on.
 *   - The orchestration row carries `fixture = 1`, so every query that needs to
 *     ask can, rather than inferring from a title.
 *   - The filed document says what it is in its first line, before anything
 *     that could be read as a finding.
 *
 * ---------------------------------------------------------------------------
 * Where it stops, and why that is the honest place
 * ---------------------------------------------------------------------------
 *
 * At the audit. Everything before it is Brain code deciding things, and a
 * fixture exercises that for real. The audit is a model reading a document and
 * forming a judgement, and there is no way to fake that half which would not
 * amount to writing a verdict into `audits` that nobody reached. §8 exists to
 * prevent exactly that, and it does not have an exception for convenience.
 *
 * So the packet files its document and stops, saying so. Watching the audit run
 * needs a worker, which is the one part of this that costs something.
 */
import type { Layer, Project, ResearchFragment, ResearchOrchestration } from '../../domain/types.ts';
import { createLayer, listLayers } from '../../repos/layers.ts';
import { createProject, getProjectBySlug } from '../../repos/projects.ts';
import { createRun } from '../../repos/runs.ts';
import { recordEvent } from '../../repos/events.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  finishPass,
  getOrchestration,
  listClaimsForFragment,
  startPass,
  updateOrchestration,
} from '../../repos/research.ts';
import crypto from 'node:crypto';
import { recordFragmentClaims, gateFragment, type ClaimVerification } from './submission.ts';
import { fileResearchPacket } from './filing.ts';
import { runTypeForNewPacket } from '../runArtifacts.ts';
import type { ParsedClaim } from './schema.ts';

/** The project every fixture packet lives in, and nothing else does. */
export const FIXTURE_PROJECT_SLUG = 'test-packets';
export const FIXTURE_PROJECT_NAME = 'Test Packets';
export const FIXTURE_LAYER_NAME = 'Protocol Notes';

/** The first line of every fixture report, before anything readable as a finding. */
export const FIXTURE_BANNER =
  '> **This is a test packet.** Its research was written into the Brain\'s own source ' +
  'rather than found by anybody, so that the pipeline could be exercised without ' +
  'spending an account\'s allowance. The claims below are real and checkable, and none ' +
  'of them is evidence for anything. Nothing here was produced by a model.';

/** A claim as the fixture states it, plus how the verification pass judged it. */
interface FixtureClaim {
  claim: ParsedClaim;
  supportsClaim: boolean;
  scope: ClaimVerification['scopeMatch'];
  note: string;
}

interface FixtureFragment {
  key: string;
  question: string;
  geography: string | null;
  timeframe: string | null;
  definitions: string | null;
  requiredEvidence: string[];
  acceptableSourceTypes: string[];
  excludedSourceTypes: string[];
  completionCriteria: string[];
  dependsOn: string[];
  minIndependentSources: number;
  claims: FixtureClaim[];
  sufficiency: 'SUFFICIENT' | 'INSUFFICIENT';
  missingLanes: string[];
  /** What this fragment is here to demonstrate, for whoever reads the console. */
  demonstrates: string;
}

function claim(input: {
  text: string;
  url?: string;
  title?: string;
  publisher?: string;
  date?: string;
  excerpt?: string;
  locator?: string;
  lane?: string;
  primary?: boolean;
  type?: ParsedClaim['claimType'];
}): ParsedClaim {
  return {
    claim: input.text,
    claimType: input.type ?? 'SOURCED_FACT',
    primarySource: input.primary ?? true,
    searchedRepositories: [],
    sourceUrl: input.url ?? null,
    sourceTitle: input.title ?? null,
    sourcePublisher: input.publisher ?? null,
    sourceDate: input.date ?? null,
    evidenceExcerpt: input.excerpt ?? null,
    evidenceLocator: input.locator ?? null,
    retrievedAt: null,
    confidence: 0.9,
    evidenceLane: input.lane ?? null,
    derived: false,
    derivedFrom: [],
  };
}

const MATCH: ClaimVerification['scopeMatch'] = {
  geography: 'MATCH',
  timeframe: 'MATCH',
  population: 'MATCH',
  definitions: 'MATCH',
};

/**
 * The fixture's subject: the specifications this Brain's own remote boundary
 * rests on.
 *
 * Chosen deliberately over anything commercial. These are permanent documents
 * at stable URLs, the claims are checkable in about a minute, and nobody could
 * mistake a packet about RFC section numbering for the answer to a business
 * question. A fixture that reads like real research is a fixture somebody will
 * eventually cite.
 *
 * Three fragments, because there are exactly three outcomes worth watching: a
 * fragment that clears the gate, one that clears it while losing a claim, and
 * one that does not clear it at all.
 */
const FRAGMENTS: FixtureFragment[] = [
  {
    key: 'metadata-document',
    question: 'What does RFC 9728 require a protected resource to publish about itself?',
    geography: null,
    timeframe: 'RFC 9728 as published',
    definitions: 'Protected resource meaning an OAuth 2.0 resource server.',
    requiredEvidence: ['specification'],
    acceptableSourceTypes: ['RFC', 'W3C recommendation'],
    excludedSourceTypes: ['blog post', 'vendor documentation'],
    completionCriteria: ['One RFC section that names the metadata document and its location.'],
    dependsOn: [],
    minIndependentSources: 1,
    sufficiency: 'SUFFICIENT',
    missingLanes: [],
    demonstrates: 'A fragment where every claim clears the gate.',
    claims: [
      {
        claim: claim({
          text:
            'RFC 9728 defines a protected resource metadata document served at ' +
            '/.well-known/oauth-protected-resource.',
          url: 'https://www.rfc-editor.org/rfc/rfc9728.html',
          title: 'OAuth 2.0 Protected Resource Metadata',
          publisher: 'RFC Editor',
          date: '2025',
          excerpt: 'The well-known URI path suffix used is oauth-protected-resource.',
          locator: 'section 3',
          lane: 'specification',
        }),
        supportsClaim: true,
        scope: MATCH,
        note: 'The section defines the path suffix directly.',
      },
      {
        claim: claim({
          text:
            'RFC 9728 specifies that a protected resource signals where to authenticate using a ' +
            'WWW-Authenticate response header field.',
          url: 'https://www.rfc-editor.org/rfc/rfc9728.html',
          title: 'OAuth 2.0 Protected Resource Metadata',
          publisher: 'RFC Editor',
          date: '2025',
          excerpt: 'the resource_metadata parameter of the WWW-Authenticate header field',
          locator: 'section 5.1',
          lane: 'specification',
        }),
        supportsClaim: true,
        scope: MATCH,
        note: 'Named in the section on using the metadata.',
      },
    ],
  },
  {
    key: 'client-registration',
    question: 'How does a client with no pre-issued credentials obtain them?',
    geography: null,
    timeframe: 'RFC 7591 as published',
    definitions: 'Client meaning an OAuth 2.0 client as that RFC defines it.',
    requiredEvidence: ['specification'],
    acceptableSourceTypes: ['RFC'],
    excludedSourceTypes: ['blog post'],
    completionCriteria: ['One RFC section describing the registration request.'],
    dependsOn: ['metadata-document'],
    minIndependentSources: 1,
    sufficiency: 'SUFFICIENT',
    missingLanes: [],
    demonstrates:
      'A fragment that clears the gate while losing a claim — the unsourced one is ' +
      'stored, marked and excluded rather than dropped.',
    claims: [
      {
        claim: claim({
          text:
            'RFC 7591 defines a client registration endpoint that accepts an HTTP POST of client ' +
            'metadata and returns issued client credentials.',
          url: 'https://www.rfc-editor.org/rfc/rfc7591.html',
          title: 'OAuth 2.0 Dynamic Client Registration Protocol',
          publisher: 'RFC Editor',
          date: '2015',
          excerpt: 'The client registration endpoint is an OAuth 2.0 endpoint',
          locator: 'section 3',
          lane: 'specification',
        }),
        supportsClaim: true,
        scope: MATCH,
        note: 'Section 3 defines the endpoint and its request.',
      },
      {
        // No URL. Stored, marked NO_URL, and refused by the gate's first
        // condition — which is the behaviour worth watching, because leaving it
        // out would make the ledger look better than the research was.
        claim: claim({
          text: 'Most authorization servers probably support dynamic registration by now.',
          type: 'UNSUPPORTED_ASSERTION',
          primary: false,
          lane: 'specification',
        }),
        supportsClaim: false,
        scope: MATCH,
        note: 'Nothing supports this. It is here to be rejected.',
      },
    ],
  },
  {
    key: 'session-identifiers',
    question: 'Does the 2026-07-28 MCP revision still issue session identifiers?',
    geography: null,
    timeframe: 'the 2026-07-28 revision specifically',
    definitions: 'Session identifier meaning the Mcp-Session-Id header of earlier revisions.',
    requiredEvidence: ['specification'],
    acceptableSourceTypes: ['protocol specification'],
    excludedSourceTypes: ['blog post'],
    completionCriteria: ['A statement from the revision itself, not from an earlier one.'],
    dependsOn: ['metadata-document'],
    minIndependentSources: 1,
    sufficiency: 'INSUFFICIENT',
    missingLanes: ['specification'],
    demonstrates:
      'A fragment that does not clear the gate at all, because its only source is about ' +
      'a different revision than the one asked about. It contributes nothing to the report.',
    claims: [
      {
        claim: claim({
          text: 'The MCP specification describes an Mcp-Session-Id header issued at initialization.',
          url: 'https://modelcontextprotocol.io/specification/2025-11-25',
          title: 'Model Context Protocol specification',
          publisher: 'Model Context Protocol',
          date: '2025-11-25',
          excerpt: 'the server MAY assign a session ID at initialization time',
          locator: 'transports',
          lane: 'specification',
        }),
        supportsClaim: true,
        // The source is real and says what the claim says. It is about the
        // wrong revision, which is the seventh condition doing its job: a
        // correct fact, correctly cited, answering a different question.
        scope: { ...MATCH, timeframe: 'MISMATCH' },
        note: 'This is the 2025-11-25 revision. The fragment asked about 2026-07-28.',
      },
    ],
  },
];

/** The report, written against the fragments that were accepted. */
function fixtureReport(accepted: { key: string; claimIds: string[] }[]): string {
  const lines = [
    FIXTURE_BANNER,
    '',
    '# Protocol notes — a test packet',
    '',
    'What this packet exists to show is not its subject. It is that the pipeline behind it',
    'made three different decisions, for three stated reasons, and that every sentence below',
    'resolves to a claim the gate accepted.',
    '',
  ];
  for (const fragment of accepted) {
    lines.push(`## ${fragment.key}`, '');
    for (const id of fragment.claimIds) {
      lines.push(`- Established, and cited as [${id}] in the ledger below.`);
    }
    lines.push('');
  }
  // Deliberately no "what this does not settle" heading here: `filing.ts` adds
  // one from `stillMissing`, and writing a second produced two headings of the
  // same name in the filed document — an empty one and the real one.
  lines.push(
    'A fragment that could not clear its evidence gate contributed nothing at all — not a',
    'weaker version of its findings, nothing — which is the property the whole engine exists',
    'for. What those fragments failed to establish is listed below rather than written around.',
  );
  return lines.join('\n');
}

/** The project fixture packets live in, created on first use. */
async function fixtureProject(): Promise<{ project: Project; layer: Layer }> {
  const existing = await getProjectBySlug(FIXTURE_PROJECT_SLUG);
  const project = existing ?? (await createProject({ name: FIXTURE_PROJECT_NAME }));

  const layers = await listLayers(project.id);
  const found = layers.find((candidate) => candidate.name === FIXTURE_LAYER_NAME);
  if (found) return { project, layer: found };

  const layer = await createLayer({
    projectId: project.id,
    name: FIXTURE_LAYER_NAME,
    orderIndex: layers.length,
  });
  return { project, layer };
}

/**
 * A real pass row for a fixture pass.
 *
 * The first version of this used an invented id and the database refused it —
 * `research_claims.pass_id` is a foreign key, which is the schema enforcing
 * something §12 already required: every pass is written down, with the exact
 * prompt and its hash, before anything is recorded against it.
 *
 * A fixture has no prompt because nothing was asked of a model, so what is
 * stored is what actually determined the content: this file. Storing an empty
 * string would satisfy the column and record nothing, and the provider is named
 * `FIXTURE` rather than borrowing a model's name it never called.
 */
async function fixturePass(input: {
  orchestrationId: string;
  fragmentId: string | null;
  passKey: Parameters<typeof startPass>[0]['passKey'];
  ordinal: number;
  source: string;
  raw: unknown;
}): Promise<string> {
  const pass = await startPass({
    orchestrationId: input.orchestrationId,
    fragmentId: input.fragmentId,
    passKey: input.passKey,
    ordinal: input.ordinal,
    attempt: 1,
    provider: 'FIXTURE',
    model: null,
    prompt: input.source,
    promptSha256: crypto.createHash('sha256').update(input.source, 'utf8').digest('hex'),
  });
  await finishPass(pass.id, {
    status: 'COMPLETE',
    rawResponse: JSON.stringify(input.raw),
    parsed: input.raw,
  });
  return pass.id;
}

export interface FixturePacket {
  orchestration: ResearchOrchestration;
  fragments: ResearchFragment[];
  projectId: string;
  layerId: string;
}

/**
 * Create a fixture packet, planned and awaiting approval.
 *
 * It stops in exactly the place a real one does, because that is the screen
 * worth rehearsing: the operator reads the proposed fragments and decides. The
 * only difference is that approving this one spends nothing.
 */
export async function createFixturePacket(input: {
  createdByUserId: string;
}): Promise<FixturePacket> {
  const { project, layer } = await fixtureProject();

  const run = await createRun({
    projectId: project.id,
    layerId: layer.id,
    // Not always FOUNDATION: that targets v1 by definition, so a second
    // fixture packet in this layer would collide with the first.
    runType: await runTypeForNewPacket(layer.id),
    status: 'PLANNED',
    provider: 'FIXTURE',
    prompt: 'A test packet. Its content is written into the Brain rather than researched.',
  });

  const orchestration = await createOrchestration({
    projectId: project.id,
    layerId: layer.id,
    runId: run.id,
    title: 'Test packet — protocol notes',
    assignment:
      'Exercise the packet pipeline end to end using claims written into the Brain\'s own ' +
      'source. Every claim is real and checkable; none of it is evidence for anything, and ' +
      'no allowance is spent producing it.',
    provider: 'FIXTURE',
    autoApprove: false,
    fixture: true,
  });

  const fragments = await createFragments(
    FRAGMENTS.map((fragment, index) => ({
      orchestrationId: orchestration.id,
      projectId: project.id,
      layerId: layer.id,
      fragmentIndex: index,
      fragmentKey: fragment.key,
      question: fragment.question,
      geography: fragment.geography,
      timeframe: fragment.timeframe,
      population: null,
      definitions: fragment.definitions,
      requiredEvidence: fragment.requiredEvidence,
      acceptableSourceTypes: fragment.acceptableSourceTypes,
      excludedSourceTypes: fragment.excludedSourceTypes,
      completionCriteria: fragment.completionCriteria,
      dependsOn: fragment.dependsOn,
      minIndependentSources: fragment.minIndependentSources,
      whyItMatters: fragment.demonstrates,
      status: 'PLANNED' as const,
    })),
  );

  await recordEvent({
    projectId: project.id,
    layerId: layer.id,
    entityType: 'RUN',
    entityId: run.id,
    eventType: 'RESEARCH_PLANNED',
    payload: {
      orchestrationId: orchestration.id,
      fixture: true,
      fragments: fragments.length,
      createdByUserId: input.createdByUserId,
    },
  });

  return { orchestration, fragments, projectId: project.id, layerId: layer.id };
}

export interface FixtureRunReport {
  acceptedFragments: number;
  blockedFragments: number;
  acceptedClaims: number;
  rejectedClaims: number;
  documentId: string | null;
  canonicalName: string | null;
  /** Why it stopped where it did. Always populated. */
  stoppedBecause: string;
}

/**
 * Run an approved fixture packet through the real acceptance path.
 *
 * The word "real" is load-bearing. This does not simulate the gate; it calls
 * `recordFragmentClaims` and `gateFragment` — the same two functions the MCP
 * submission path and the in-process orchestrator both call — and then
 * `fileResearchPacket`, which is the same function that files a worker's
 * report. So what an operator sees a fixture do is what the Brain does.
 *
 * What is fixture is the *input*: the claims, and the two verification
 * judgements a reader of a source has to make. Everything downstream of those
 * is the production decision path, unmodified.
 */
export async function runFixturePacket(orchestrationId: string): Promise<FixtureRunReport> {
  const orchestration = await getOrchestration(orchestrationId);
  if (!orchestration) throw new Error('No such packet.');
  if (!orchestration.fixture) {
    // A guard rather than a nicety. This path supplies its own claims, so
    // pointing it at a real orchestration would write fixture content into
    // somebody's research.
    throw new Error('That packet is not a fixture, and this path only runs fixtures.');
  }

  const fragments = await currentFragments(orchestrationId);
  await updateOrchestration(orchestrationId, { status: 'RESEARCHING' });

  let acceptedFragments = 0;
  let blockedFragments = 0;
  let acceptedClaims = 0;
  let rejectedClaims = 0;
  const acceptedByFragment: { key: string; claimIds: string[] }[] = [];

  // In declared order, so a fragment that depends on another is researched
  // after it — the same ordering the runner enforces for a real packet.
  for (const fixture of FRAGMENTS) {
    const fragment = fragments.find((candidate) => candidate.fragmentKey === fixture.key);
    if (!fragment || fragment.status === 'CANCELLED') continue;

    const passId = await fixturePass({
      orchestrationId: orchestration.id,
      fragmentId: fragment.id,
      passKey: 'TARGETED',
      ordinal: 2,
      source: `services/research/fixtures.ts — fragment "${fixture.key}"`,
      raw: fixture.claims,
    });

    const stored = await recordFragmentClaims({
      orchestration,
      fragment,
      passId,
      passKey: 'TARGETED',
      claims: fixture.claims.map((entry) => entry.claim),
    });

    const verifications: ClaimVerification[] = stored.map((row, index) => {
      const source = fixture.claims[index]!;
      return {
        claimId: row.id,
        supportsClaim: source.supportsClaim,
        scopeMatch: source.scope,
        note: source.note,
      };
    });

    const gate = await gateFragment({
      fragment,
      verifications,
      sufficiency: fixture.sufficiency,
      missingLanes: fixture.missingLanes,
      unresolvedGaps: [],
    });

    acceptedClaims += gate.acceptedClaims;
    rejectedClaims += gate.rejectedClaims;

    if (gate.integrity === 'PASS' && gate.sufficiency === 'SUFFICIENT') {
      acceptedFragments += 1;
      const rows = await listClaimsForFragment(fragment.id);
      acceptedByFragment.push({
        key: fragment.fragmentKey,
        claimIds: rows.filter((row) => row.accepted).map((row) => row.id),
      });
    } else {
      blockedFragments += 1;
    }
  }

  if (acceptedByFragment.length === 0) {
    await updateOrchestration(orchestrationId, {
      status: 'NEEDS_HUMAN',
      failureReason: 'No fixture fragment cleared its gate, which should not happen.',
      completedAt: new Date().toISOString(),
    });
    return {
      acceptedFragments,
      blockedFragments,
      acceptedClaims,
      rejectedClaims,
      documentId: null,
      canonicalName: null,
      stoppedBecause: 'nothing cleared the gate',
    };
  }

  const cited = acceptedByFragment.flatMap((entry) => entry.claimIds);
  const synthesisPass = await fixturePass({
    orchestrationId: orchestration.id,
    fragmentId: null,
    passKey: 'SYNTHESIS',
    ordinal: 4,
    source: 'services/research/fixtures.ts — synthesis',
    raw: { citedClaimIds: cited },
  });
  const filed = await fileResearchPacket({
    orchestration,
    reportText: fixtureReport(acceptedByFragment),
    citedClaimIds: cited,
    stillMissing: FRAGMENTS.filter(
      (fixture) => !acceptedByFragment.some((entry) => entry.key === fixture.key),
    ).map((fixture) => `${fixture.key}: ${fixture.question}`),
    passId: synthesisPass,
  });

  // Stopped rather than audited, and the reason is written onto the row so the
  // console does not have to explain it and cannot get it wrong.
  const stoppedBecause =
    'Filed. The audit is the one part a fixture cannot stand in for — it is a model reading ' +
    'the document and forming a judgement, and writing a verdict nobody reached is what §8 ' +
    'exists to prevent. Connect a worker to see that half run.';
  await updateOrchestration(orchestrationId, {
    status: 'NEEDS_HUMAN',
    failureReason: stoppedBecause,
    completedAt: new Date().toISOString(),
  });

  return {
    acceptedFragments,
    blockedFragments,
    acceptedClaims,
    rejectedClaims,
    documentId: filed.documentId,
    canonicalName: (filed.value['canonicalName'] as string | null) ?? null,
    stoppedBecause,
  };
}

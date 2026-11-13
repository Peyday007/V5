/**
 * The integration registry (§103): every external service Brain and its
 * connected projects use, in one declared list.
 *
 * ---------------------------------------------------------------------------
 * What was wrong
 * ---------------------------------------------------------------------------
 *
 * Each integration was wired where it was first needed, so each one knew only
 * its own setting and nobody knew the whole. The Neighbor Card workflow said
 * "where the Instantly key already is" and the key had never been put there:
 * six hourly passes failed with `INSTANTLY_API_KEY is not configured` while
 * the owner's workspace was connected to every Claude session and to V2. V2's
 * Google Places key lived in V2's Vercel project and Brain had no way to use
 * it. Every gap was found by a person, one at a time.
 *
 * ---------------------------------------------------------------------------
 * The rule
 * ---------------------------------------------------------------------------
 *
 * An integration exists in Brain when it is declared here, and only then:
 *
 *  - **where its credentials live** (the deployment's environment, a GitHub
 *    Actions secret, or a connected project's own deployment), by setting
 *    name — never a value, which stays a deployment secret (§54, invariant 22);
 *  - **how each credential can arrive without a person** (`delivery`): copied
 *    from a GitHub secret, sealed from an authorized connector, generated, or
 *    reached through a connected project that holds it;
 *  - **which Brain components use it**, with the file that does;
 *  - **how its health is read** — present, well-formed, and a live probe that
 *    sends nothing — and **what the owner must do** when no automatic path
 *    exists, which is the only sentence ever shown to him.
 *
 * `tests/integrationRegistry.test.ts` reads every environment variable the
 * server and the workflows touch and refuses one that names a credential no
 * entry declares, so a future integration cannot be wired around this list.
 */

export type IntegrationLocation =
  /** The production Brain machine's environment (Fly secrets). */
  | 'DEPLOYMENT'
  /** A GitHub Actions repository secret, read by a workflow, never by the machine. */
  | 'GITHUB_ACTIONS'
  /** Another project's deployment; Brain reaches the service through it. */
  | 'CONNECTED_PROJECT';

/** How a missing credential can be supplied without the owner. */
export type CredentialDelivery =
  /** `integrations.yml` copies a same-named GitHub secret to the deployment. */
  | 'GITHUB_SECRET'
  /** A session holding an authorized connector seals a credential to the deployment's key. */
  | 'CONNECTOR_SEALED'
  /** `integrations.yml` generates it (a key pair Brain owns). */
  | 'GENERATED'
  /** Written by the workflow that runs the service (a URL, a pod id). */
  | 'WORKFLOW'
  /** Only the owner can supply it. */
  | 'OWNER';

export interface CredentialSpec {
  /** The setting's name. Never its value. */
  name: string;
  where: IntegrationLocation;
  required: boolean;
  /** Ways it can arrive, in the order the repair tries them. */
  delivery: CredentialDelivery[];
  /** A cheap well-formedness check; failing it is MISCONFIGURED, not MISSING. */
  shape?: RegExp;
}

export interface Consumer {
  component: string;
  path: string;
}

export interface IntegrationDefinition {
  id: string;
  name: string;
  /** What the service is for, in one line a person reads. */
  purpose: string;
  /** Which project holds the connection. */
  heldBy: 'BRAIN' | 'V2';
  credentials: CredentialSpec[];
  consumers: Consumer[];
  capabilities: string[];
  /** The live probe this registry can run (`probes.ts`), or null when presence is all that can be read. */
  probe: string | null;
  /** Calls a day Brain may make when the service bills per call; null when it does not. */
  dailyCeiling: number | null;
  /** The one thing only the owner can do when every automatic path is exhausted. */
  ownerAction: string;
}

const fly = (name: string, delivery: CredentialDelivery[], extra: Partial<CredentialSpec> = {}): CredentialSpec => ({
  name,
  where: 'DEPLOYMENT',
  required: true,
  delivery,
  ...extra,
});
const actions = (name: string, extra: Partial<CredentialSpec> = {}): CredentialSpec => ({
  name,
  where: 'GITHUB_ACTIONS',
  required: true,
  delivery: ['OWNER'],
  ...extra,
});

export const SIGNING_KEY_ENV = 'BRAIN_INTEGRATION_SIGNING_KEY';
export const SEAL_KEY_ENV = 'BRAIN_INTEGRATION_SEAL_KEY';

export const INTEGRATIONS: IntegrationDefinition[] = [
  {
    id: 'instantly',
    name: 'Instantly',
    purpose: "The owner's cold-email workspace: campaigns, leads, sending accounts, replies (§94).",
    heldBy: 'BRAIN',
    credentials: [
      fly('INSTANTLY_API_KEY', ['GITHUB_SECRET', 'CONNECTOR_SEALED', 'OWNER'], { shape: /^\S{20,}$/ }),
      fly('BRAIN_INSTANTLY_CAMPAIGN_ID', ['OWNER'], { required: false, shape: /^[0-9a-f-]{36}$/i }),
    ],
    consumers: [
      { component: 'Neighbor Card mailer (hourly sync, refill, report)', path: 'server/services/cash/neighborCard.ts' },
      { component: 'Expansion businesses outreach read', path: 'server/services/cash/expansionOutreach.ts' },
      { component: 'Launch: Neighbor Card replies', path: 'scripts/launch/mailerReplies.ts' },
      { component: 'Cash: CONTACT_BUYER effect and reply sync', path: 'server/services/cash/providers/instantly.ts' },
      { component: 'Goals: measured outreach capacity', path: 'server/services/cash/providers/instantlySync.ts' },
    ],
    capabilities: ['SEND_A_MESSAGE', 'READ_REPLIES', 'MEASURE_OUTREACH_CAPACITY'],
    probe: 'instantly',
    dailyCeiling: null,
    ownerAction:
      'In Instantly → Settings → Integrations → API keys, create a key with all:all scope and save it as the GitHub ' +
      'repository secret INSTANTLY_API_KEY; the next Integrations run puts it on Brain.',
  },
  {
    id: 'google-places',
    name: 'Google Places (through V2)',
    purpose: "Business discovery: V2's Places API (New) key, used by Brain through V2's signed bridge, never copied.",
    heldBy: 'V2',
    credentials: [
      fly(SIGNING_KEY_ENV, ['GENERATED']),
      {
        name: 'GOOGLE_PLACES_API_KEY',
        where: 'CONNECTED_PROJECT',
        required: true,
        delivery: ['OWNER'],
      },
    ],
    consumers: [
      { component: 'Neighbor Card mailer: business discovery', path: 'server/services/cash/neighborCard.ts' },
      { component: 'V2 Dispatch Board lead sourcing', path: 'Peyday007/V2 src/lib/places.ts' },
    ],
    capabilities: ['DISCOVER_LOCAL_BUSINESSES'],
    probe: 'v2-places',
    // Text Search with a website field bills per call after 1,000 free a month;
    // one call an hourly pass stays inside the free allowance.
    dailyCeiling: 24,
    ownerAction:
      "Google refuses V2's GOOGLE_PLACES_API_KEY. In Google Cloud Console, on the project that key belongs to: confirm " +
      'billing is active, enable Places API (New), and allow Places API (New) in the key\'s API restrictions with ' +
      "Application restrictions set to None (V2 → Admin → Diagnostics → Places shows Google's full refusal). Brain " +
      'uses the key through V2 as soon as Google accepts it; nothing needs to be copied.',
  },
  {
    id: 'v2',
    name: 'V2 Dispatch Board',
    purpose: 'The owner\'s earlier project (Vercel + Supabase); Brain reaches its services through its signed bridge.',
    heldBy: 'V2',
    credentials: [
      fly(SIGNING_KEY_ENV, ['GENERATED']),
      // V2's own connections, held in its Vercel project (inventory; Brain reads none of them).
      ...['INSTANTLY_API_KEY', 'INSTANTLY_WEBHOOK_SECRET', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'DEEPGRAM_API_KEY', 'APOLLO_API_KEY', 'PDL_API_KEY',
        'SIGNALHIRE_API_KEY', 'SEARCH_API_KEY', 'GOOGLE_CSE_ID', 'ADMIN_PASSWORD', 'WORKER_SECRET'].map((name): CredentialSpec => ({
        name: `V2:${name}`,
        where: 'CONNECTED_PROJECT',
        required: false,
        delivery: ['OWNER'],
      })),
    ],
    consumers: [
      { component: 'Integration bridge client', path: 'server/services/integrations/v2Bridge.ts' },
      { component: "V2's own dialer, sourcing and Instantly push", path: 'Peyday007/V2 src/lib' },
    ],
    capabilities: ['CONNECTED_PROJECT_BRIDGE'],
    probe: 'v2-bridge',
    dailyCeiling: null,
    ownerAction: 'Nothing: the bridge key is generated and pinned in V2 by Brain sessions.',
  },
  {
    id: 'credential-seal',
    name: 'Credential seal',
    purpose: 'The deployment\'s own key: a session holding an authorized connector seals a credential to it, and only this machine can open it.',
    heldBy: 'BRAIN',
    credentials: [fly(SEAL_KEY_ENV, ['GENERATED'])],
    consumers: [{ component: 'Integrations workflow: sealed delivery', path: 'scripts/integrations.ts' }],
    capabilities: ['RECEIVE_SEALED_CREDENTIALS'],
    probe: null,
    dailyCeiling: null,
    ownerAction: 'Nothing: generated by the Integrations workflow.',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    purpose: 'Payment links, invoices and settlements (§54).',
    heldBy: 'BRAIN',
    credentials: [
      fly('STRIPE_SECRET_KEY', ['GITHUB_SECRET', 'OWNER'], { shape: /^(sk|rk)_(test|live)_\S+$/ }),
    ],
    consumers: [
      { component: 'Launch: payment links', path: 'scripts/launch/run.ts' },
      { component: 'Cash: ISSUE_AN_INVOICE and TAKE_A_PAYMENT', path: 'server/services/cash/providers/stripe.ts' },
    ],
    capabilities: ['ISSUE_AN_INVOICE', 'TAKE_A_PAYMENT'],
    probe: 'stripe',
    dailyCeiling: null,
    ownerAction:
      'Create and verify the Stripe account and save its secret key as the GitHub repository secret STRIPE_SECRET_KEY.',
  },
  {
    id: 'resend',
    name: 'Resend',
    purpose: 'Transactional email, implemented and not selected (the owner sends through Instantly).',
    heldBy: 'BRAIN',
    credentials: [
      fly('RESEND_API_KEY', ['GITHUB_SECRET', 'OWNER'], { required: false, shape: /^re_\S+$/ }),
      fly('BRAIN_MESSAGING_FROM', ['OWNER'], { required: false }),
    ],
    consumers: [{ component: 'Cash: CONTACT_BUYER (when selected)', path: 'server/services/cash/providers/resend.ts' }],
    capabilities: ['SEND_A_MESSAGE'],
    probe: null,
    dailyCeiling: null,
    ownerAction: 'Nothing unless Resend is chosen over Instantly.',
  },
  {
    id: 'supabase',
    name: 'Supabase (database and storage)',
    purpose: "Brain's authoritative state in cloud mode: Postgres and the document bucket (§18).",
    heldBy: 'BRAIN',
    credentials: [
      fly('BRAIN_DATABASE_URL', ['OWNER']),
      fly('SUPABASE_URL', ['OWNER']),
      fly('SUPABASE_SERVICE_ROLE_KEY', ['OWNER']),
    ],
    consumers: [
      { component: 'Every repository', path: 'server/db/database.ts' },
      { component: 'Document store', path: 'server/services/storage.ts' },
    ],
    capabilities: ['PERSIST_STATE', 'STORE_DOCUMENTS'],
    probe: 'database',
    dailyCeiling: null,
    ownerAction: 'Nothing while Brain boots; the deployment cannot start without these.',
  },
  {
    id: 'anthropic',
    name: 'Anthropic API',
    purpose: 'Direct model calls when a deployment selects the Anthropic provider instead of Claude routines.',
    heldBy: 'BRAIN',
    credentials: [fly('ANTHROPIC_API_KEY', ['OWNER'], { required: false, shape: /^sk-ant-\S+$/ })],
    consumers: [{ component: 'Model providers', path: 'server/providers' }],
    capabilities: ['MODEL_CALLS'],
    probe: null,
    dailyCeiling: null,
    ownerAction: 'Nothing unless the Anthropic provider is selected.',
  },
  {
    id: 'openai',
    name: 'OpenAI-compatible API',
    purpose: 'Direct model calls when a deployment selects an OpenAI-compatible provider.',
    heldBy: 'BRAIN',
    credentials: [fly('OPENAI_API_KEY', ['OWNER'], { required: false })],
    consumers: [{ component: 'Model providers', path: 'server/providers' }],
    capabilities: ['MODEL_CALLS'],
    probe: null,
    dailyCeiling: null,
    ownerAction: 'Nothing unless an OpenAI-compatible provider is selected.',
  },
  {
    id: 'omniroute',
    name: 'OmniRoute',
    purpose: 'The model router the cheap-lane workflow can use.',
    heldBy: 'BRAIN',
    credentials: [actions('OMNIROUTE_API_KEY', { required: false }), actions('OMNIROUTE_PASSWORD', { required: false })],
    consumers: [{ component: 'Cheap lane workflow', path: '.github/workflows/cheap-lane.yml' }],
    capabilities: ['CHEAP_MODEL_READS'],
    probe: null,
    dailyCeiling: null,
    ownerAction: 'Nothing unless OmniRoute is chosen.',
  },
  {
    id: 'claude-routines',
    name: 'Claude routines',
    purpose: 'The Claude accounts Brain fires research and factory work on (§22, §23).',
    heldBy: 'BRAIN',
    credentials: [fly('BRAIN_ROUTINE_TOKEN', ['OWNER'])],
    consumers: [{ component: 'Dispatch: firing routines', path: 'server/services/dispatch/fire.ts' }],
    capabilities: ['RESEARCH_A_QUESTION', 'BUILD_SOFTWARE'],
    probe: null,
    dailyCeiling: null,
    ownerAction: 'Reconnect an account only when Fleet says "Reconnect required".',
  },
  {
    id: 'cheap-lane',
    name: 'Cheap model lane (RunPod vLLM)',
    purpose: 'The low-cost model Brain uses for bulk reading (§85, §86).',
    heldBy: 'BRAIN',
    credentials: [
      fly('BRAIN_CHEAP_LLM_KEY', ['WORKFLOW'], { required: false }),
      fly('BRAIN_RUNPOD_API_KEY', ['WORKFLOW'], { required: false }),
      actions('RUNPOD_API_KEY', { required: false }),
      actions('RUNPOD_VLLM_KEY', { required: false }),
      actions('RUNPOD_VLLM_URL', { required: false }),
    ],
    consumers: [{ component: 'Free lane and cheap reads', path: 'server/services/cheap' }],
    capabilities: ['CHEAP_MODEL_READS'],
    probe: null,
    dailyCeiling: null,
    ownerAction: 'Nothing: the Cheap lane workflow writes these from its repository secrets.',
  },
  {
    id: 'browser',
    name: 'Browser automation',
    purpose: 'A hosted browser Brain drives for pages that need one.',
    heldBy: 'BRAIN',
    credentials: [
      fly('BRAIN_BROWSER_MCP_URL', ['WORKFLOW'], { required: false }),
      // A browser signed in to an account Brain may operate (sources/browserWorkflow.ts); optional.
      fly('BRAIN_BROWSER_SESSION_MCP_URL', ['OWNER'], { required: false }),
    ],
    consumers: [
      { component: 'Sources: browser reads', path: 'server/services/sources' },
      { component: 'Browser capabilities: approved reads on the integrations tick', path: 'server/services/sources/browser/schedule.ts' },
      { component: 'Browser capabilities: define, approve, retire and run at the terminal', path: 'server/services/sources/browser/capabilityCli.ts' },
    ],
    capabilities: ['READ_SCRIPTED_PAGES', 'RUN_APPROVED_BROWSER_ROUTINES'],
    probe: null,
    dailyCeiling: null,
    ownerAction: 'Nothing: the Browser workflow writes the URL.',
  },
  {
    id: 'open-source-agents',
    name: 'Open-source agents (Sellbird, Browser Use)',
    purpose:
      "Prospect contact research on a private CPU app (§104): Sellbird reads who decides and the addresses a business " +
      'publishes; Browser Use reads JavaScript-only sites with the RunPod model, read-only and checked against the page.',
    heldBy: 'BRAIN',
    credentials: [
      fly('BRAIN_AGENTS_URL', ['WORKFLOW'], { required: false, shape: /^http:\/\/[a-z0-9-]+\.flycast(:\d+)?$/ }),
      fly('BRAIN_AGENTS_KEY', ['WORKFLOW'], { required: false, shape: /^[0-9a-f]{64}$/ }),
    ],
    consumers: [
      { component: 'Neighbor Card refill: addresses the plain reader missed', path: 'server/services/cash/neighborCard.ts' },
      { component: 'Agents client and records', path: 'server/services/agents/client.ts' },
    ],
    capabilities: ['FIND_DECISION_MAKERS', 'FIND_PUBLISHED_CONTACTS', 'READ_SCRIPTED_SITES'],
    probe: 'agents',
    dailyCeiling: null,
    ownerAction: 'Nothing: the Agents workflow deploys the service and writes both settings.',
  },
  {
    id: 'operator',
    name: 'Operator (Hermes Agent)',
    purpose:
      "Brain's general operator (§106): Hermes Agent on a private app directs every goal through Brain's operator " +
      "tools, thinking with the free switchboard and the RunPod GPU, with a credential Brain mints for each run.",
    heldBy: 'BRAIN',
    credentials: [
      fly('BRAIN_OPERATOR_URL', ['WORKFLOW'], { required: false, shape: /^http:\/\/[a-z0-9-]+\.flycast(:\d+)?$/ }),
      fly('BRAIN_OPERATOR_KEY', ['WORKFLOW'], { required: false, shape: /^[0-9a-f]{64}$/ }),
    ],
    consumers: [
      { component: 'Operator runs, started by the durable tick', path: 'server/services/operator/run.ts' },
      { component: 'Operator tools on the MCP door', path: 'server/mcp/operatorTools.ts' },
    ],
    capabilities: ['DIRECT_GOALS', 'SEND_FIXES_TO_FACTORY'],
    probe: null,
    dailyCeiling: null,
    ownerAction: 'Nothing: the Agents workflow (operator-deploy) deploys the service and writes both settings.',
  },
  {
    id: 'etsy',
    name: 'Etsy',
    purpose: 'The puzzle shop listings (launch).',
    heldBy: 'BRAIN',
    credentials: [actions('ETSY_API_KEY'), actions('ETSY_SHARED_SECRET'), actions('ETSY_REDIRECT_URI', { required: false })],
    consumers: [{ component: 'Launch: Etsy', path: 'scripts/launch/etsy.ts' }],
    capabilities: ['LIST_PRODUCTS'],
    probe: null,
    dailyCeiling: null,
    ownerAction: 'Approve the Etsy app and sign in once when the Launch run asks.',
  },
  {
    id: 'pinterest',
    name: 'Pinterest',
    purpose: 'Puzzle acquisition pins (launch).',
    heldBy: 'BRAIN',
    credentials: [
      actions('PINTEREST_APP_ID'),
      actions('PINTEREST_APP_SECRET'),
      actions('PINTEREST_REDIRECT_URI', { required: false }),
      actions('PINTEREST_STANDARD_ACCESS', { required: false }),
    ],
    consumers: [{ component: 'Launch: Pinterest', path: 'scripts/launch/run.ts' }],
    capabilities: ['PUBLISH_PINS'],
    probe: null,
    dailyCeiling: null,
    ownerAction: 'Approve the Pinterest app and sign in once when the Launch run asks.',
  },
  {
    id: 'fourthwall',
    name: 'Fourthwall',
    purpose: 'The merch storefront (launch).',
    heldBy: 'BRAIN',
    credentials: [actions('FOURTHWALL_API_USERNAME'), actions('FOURTHWALL_API_PASSWORD')],
    consumers: [{ component: 'Launch: Fourthwall', path: 'scripts/launch/run.ts' }],
    capabilities: ['LIST_PRODUCTS'],
    probe: null,
    dailyCeiling: null,
    ownerAction: 'Save the Fourthwall API username and password as GitHub repository secrets.',
  },
  {
    id: 'fly',
    name: 'Fly.io',
    purpose: 'Where Brain runs; every workflow that reaches the machine uses this token.',
    heldBy: 'BRAIN',
    credentials: [actions('FLY_API_TOKEN'), actions('FLY_ORG_TOKEN', { required: false })],
    consumers: [{ component: 'Deploy and every machine workflow', path: '.github/workflows/deploy.yml' }],
    capabilities: ['DEPLOY', 'REACH_THE_MACHINE'],
    probe: null,
    dailyCeiling: null,
    ownerAction: 'Nothing while deploys succeed.',
  },
];

export function integration(id: string): IntegrationDefinition {
  const found = INTEGRATIONS.find((one) => one.id === id);
  if (!found) throw new Error(`No integration "${id}" is declared in the registry.`);
  return found;
}

/** Every deployment setting a GitHub secret of the same name may supply. */
export function githubSyncable(): string[] {
  return [...new Set(INTEGRATIONS.flatMap((one) => one.credentials)
    .filter((c) => c.where === 'DEPLOYMENT' && c.delivery.includes('GITHUB_SECRET'))
    .map((c) => c.name))].sort();
}

/** Every deployment setting a connector-holding session may seal to the machine. */
export function sealable(): string[] {
  return [...new Set(INTEGRATIONS.flatMap((one) => one.credentials)
    .filter((c) => c.where === 'DEPLOYMENT' && c.delivery.includes('CONNECTOR_SEALED'))
    .map((c) => c.name))].sort();
}

/** Every setting name the registry declares anywhere. */
export function declaredSettings(): Set<string> {
  return new Set(INTEGRATIONS.flatMap((one) => one.credentials.map((c) => c.name)));
}

/**
 * Inviting a person, and their accepting. The journey §26 did not have.
 *
 * ---------------------------------------------------------------------------
 * Why this exists at all
 * ---------------------------------------------------------------------------
 *
 * Until this module a person was **granted** a membership at
 * `POST /api/projects/:id/members`, by somebody who already held their user id.
 * Nobody was ever invited and nobody ever accepted, so the only people who could
 * be added to a project were people a Brain administrator had already made an
 * account for. The only `invitations` table in the repository was
 * `worker_invitations`, and a worker is not a person: it holds no threads, reads
 * no project, and what it redeems is an OAuth consent screen.
 *
 * So this is the worker invitation's safety properties applied to the other kind
 * of principal, and none of them is reinvented:
 *
 *   * the token is shown **once**, at issue, and stored as a sha-256 digest;
 *   * it is **single use** and expiring, and spent by one guarded `UPDATE`;
 *   * issuing is a person's decision at `ADMIN` on that project — the level
 *     `/api/projects/:id/members` already carries, because inviting *is* a
 *     membership grant — and a worker principal is refused **by type**;
 *   * the membership created is the role the **invitation** named, never one the
 *     acceptor chose;
 *   * absent, expired, already used and withdrawn are one refusal with one body.
 *
 * ---------------------------------------------------------------------------
 * The two questions this had to answer, and how
 * ---------------------------------------------------------------------------
 *
 * **Who is the acceptor?** Whoever holds the link. That is the model every email
 * invitation has, and it is the same authority `oauth.ts` already grants an
 * invited browser: possession of a 256-bit secret that a named administrator
 * issued over a channel they chose. What the acceptor cannot do is choose *who
 * they are* or *what they get* — the email and the role are read from the row.
 *
 * **What if the invited person has no Brain account?** Then accepting has to be
 * able to make one, or the invitation is a dead end for the one person it was
 * written for, and §24 is explicit that a state a person cannot resolve is stuck
 * rather than waiting. But creating a user is `decideBrainAdmin`'s to authorize,
 * and a project ADMIN is not necessarily a Brain administrator — so **the
 * authority is re-read at the moment the effect happens**, from the inviter's
 * current rows, and never baked into the invitation. That is §17's own rule
 * ("membership and scopes are read on every request rather than baked into a
 * token") applied to the one power this journey needs and does not itself hold.
 *
 * Two consequences worth stating because they are deliberate:
 *
 *   * An inviter who has since lost `ADMIN` on the project cannot let anybody in
 *     through a link they left behind. The invitation is not consumed by that
 *     refusal, so a fresh administrator re-inviting is the remedy.
 *   * An invitation to an address with no account, issued by somebody who is not
 *     a Brain administrator, refuses with the remedy named and **keeps the
 *     invitation live**, so it works the moment the account exists.
 *
 * Nothing here widens any authorization rule. It reaches `grantMembership` and
 * `createUser`, which are the same two functions the administrative routes
 * reach, with the same authority required and re-checked.
 */
import {
  createUser,
  getUser,
  getUserByEmail,
  grantMembership,
  listMembershipsForPrincipal,
  normalizeEmail,
  recordIdentityEvent,
} from '../../repos/identity.ts';
import {
  acceptProjectInvitation,
  createProjectInvitation,
  findLiveProjectInvitation,
  getProjectInvitation,
  listProjectInvitations,
  revokeProjectInvitation,
  revokeUnusedInvitationsFor,
} from '../../repos/projectInvitations.ts';
import { getProject } from '../../repos/projects.ts';
import { recordEvent } from '../../repos/events.ts';
import { generateInvitationToken, parseInvitationToken } from './secrets.ts';
import { assertUsablePassword, WeakPasswordError } from './secrets.ts';
import { decideBrainAdmin, decideProjectAccess } from './policy.ts';
import { PROJECT_ROLES } from '../../domain/types.ts';
import type {
  Principal,
  ProjectInvitation,
  ProjectRole,
  User,
} from '../../domain/types.ts';

/**
 * The role an invitation carries when nobody says otherwise.
 *
 * `MEMBER`, because it is the level that can do the work without being able to
 * change who else may — which is what somebody being invited to help almost
 * always means, and is the least surprising thing to be prefilled with.
 */
export const DEFAULT_INVITED_ROLE: ProjectRole = 'MEMBER';

/** Every role an invitation may name. The same set `/members` already accepts. */
export const INVITABLE_ROLES: readonly ProjectRole[] = PROJECT_ROLES;

/**
 * The one refusal an invitation token ever gets.
 *
 * Unknown, malformed, expired, already accepted and withdrawn all produce this
 * exact string, because the differences between them are what somebody holding a
 * guessed or intercepted link would like to learn. It names the **remedy**
 * instead of the reason, which is the only thing the legitimate recipient
 * actually needs — §24's answering transition, in a sentence.
 */
export const INVITATION_REFUSAL =
  'This invitation cannot be used. It may have expired, already been accepted, or been ' +
  'withdrawn — an invitation is single use and short-lived on purpose. Ask whoever invited ' +
  'you to send a new one.';

/** The same 404 body a project invitation id gets whether it is absent or not yours. */
export const INVITATION_NOT_FOUND = 'No invitation with that id.';

export interface IssuedInvitation {
  invitation: ProjectInvitation;
  /**
   * Shown once and never recoverable.
   *
   * The token is in the **fragment**, which browsers do not send to a server and
   * no access log records. §17 forbids a credential in a URL that gets recorded,
   * and a path segment is recorded by every proxy between here and the
   * recipient.
   */
  invitationUrl: string;
  expiresAt: string;
  /** Whether a Brain account already exists for that address. */
  accountExists: boolean;
  /**
   * What accepting will do, in the words the inviter should read before they
   * send the link. Composed here rather than in the client, so the sentence a
   * person is shown and the branch the server will actually take are one thing.
   */
  whatHappensNext: string;
  /** How many still-unused invitations for this address this one replaced. */
  replaced: number;
}

export type InviteOutcome =
  | { ok: true; issued: IssuedInvitation }
  | { ok: false; reason: string };

export type AcceptOutcome =
  | {
      ok: true;
      projectId: string;
      projectName: string;
      role: ProjectRole;
      /** The person the invitation resolved to. Never the acceptor's choosing. */
      userId: string;
      email: string;
      createdAccount: boolean;
      /** True when they still have to sign in — a new account has no session. */
      signInRequired: boolean;
    }
  | { ok: false; reason: string };

/**
 * Read `role` from a caller without letting them invent one.
 *
 * Exactly the shape `admin.ts`'s `readRole` has, deliberately: the same closed
 * set, matched exactly, upper-cased first. A second, looser reader would be a
 * second place the role contract could drift.
 */
export function readInvitedRole(value: unknown): ProjectRole | null {
  if (value === undefined || value === null || value === '') return DEFAULT_INVITED_ROLE;
  if (typeof value !== 'string') return null;
  const raw = value.trim().toUpperCase();
  return INVITABLE_ROLES.find((role) => role === raw) ?? null;
}

/**
 * A structurally plausible email, and nothing more.
 *
 * Deliberately not a validator that tries to be clever: the address is going to
 * be compared against `users.email` by exact match after normalisation, and the
 * only failure worth refusing early is something that is not an address at all.
 */
export function readInvitedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = normalizeEmail(value);
  if (trimmed.length === 0 || trimmed.length > 320) return null;
  if (/\s/.test(trimmed)) return null;
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return null;
  const domain = trimmed.slice(at + 1);
  if (domain.length < 3 || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    return null;
  }
  return trimmed;
}

/**
 * A principal for a user, from rows, for one authorization question.
 *
 * Not a session and not a request: `credentialId` says so in its own value, so a
 * row written while this is in scope can never be mistaken for something that
 * person did in a browser. It exists because the inviter's authority has to be
 * re-read at the moment the effect happens, and `decideProjectAccess` takes a
 * `Principal` rather than a `User`.
 */
async function principalForInviter(user: User, requestId: string): Promise<Principal> {
  return {
    type: 'HUMAN',
    id: user.id,
    handle: user.email,
    displayName: user.displayName,
    isBrainAdmin: user.isBrainAdmin,
    mustChangePassword: user.mustChangePassword,
    credentialId: `invitation:inviter:${user.id}`,
    authMethod: 'SESSION_COOKIE',
    memberships: (await listMembershipsForPrincipal('HUMAN', user.id)).filter((m) => m.active),
    requestId,
  };
}

/**
 * What accepting will actually do, in the words the inviter reads first.
 *
 * Composed on the server from the same three facts the acceptance branches on —
 * whether an account exists, whether it is usable, and whether this inviter may
 * authorize making one — so the sentence a person is shown before they send the
 * link cannot disagree with the branch the server will take when it is opened.
 * A client that wrote this itself would eventually write a fourth case.
 */
function whatAcceptingWillDo(input: {
  email: string;
  role: ProjectRole;
  existing: User | null;
  inviterMayCreateAccount: boolean;
}): string {
  const { email, role, existing } = input;
  if (existing?.disabledAt) {
    return (
      `${email} has a Brain account and it is disabled, so accepting will be refused until a ` +
      'Brain administrator enables it. The invitation stays valid until then.'
    );
  }
  if (existing) {
    return (
      `${email} already has a Brain account. Opening the link signs their account into this ` +
      `project as ${role.toLowerCase()}.`
    );
  }
  if (input.inviterMayCreateAccount) {
    return (
      `${email} has no Brain account yet. Opening the link lets them choose a password, which ` +
      `creates their account and puts them on this project as ${role.toLowerCase()}.`
    );
  }
  return (
    `${email} has no Brain account yet, and creating one is a Brain administrator's to ` +
    'authorize. Ask one to create the account; this invitation keeps working the moment it ' +
    'exists, and does not need re-sending.'
  );
}

/**
 * Issue one invitation.
 *
 * The two authorization questions are asked here as well as at the route, and
 * that is not belt-and-braces for its own sake: it makes both rules assertable
 * from rows by anything that drives this service — the acceptance reporter does
 * exactly that — rather than only through an HTTP status.
 *
 * A worker principal is refused **by type**. There is no membership
 * configuration that makes a machine into a person, and a machine that could
 * invite people would be creating principals nobody asked for.
 */
export async function inviteToProject(input: {
  principal: Principal | null;
  projectId: string;
  email: unknown;
  role: unknown;
  note?: string | null;
  /** Where the link points. Brain's own origin; never anything a caller sent. */
  origin: string;
  ttlMs?: number;
}): Promise<InviteOutcome> {
  const principal = input.principal;
  if (!principal || principal.type !== 'HUMAN') {
    return {
      ok: false,
      reason:
        'Only a signed-in person may invite somebody to a project. A worker principal is ' +
        'refused here by type, whatever its membership says.',
    };
  }
  if (!decideProjectAccess(principal, input.projectId, 'ADMIN').allowed) {
    // The same words a missing project gets, for invariant 23's reason.
    return { ok: false, reason: 'No project with that id.' };
  }
  const project = await getProject(input.projectId);
  if (!project) return { ok: false, reason: 'No project with that id.' };

  const email = readInvitedEmail(input.email);
  if (!email) {
    return { ok: false, reason: 'Give the email address to invite, as a plain address.' };
  }
  const role = readInvitedRole(input.role);
  if (!role) {
    return {
      ok: false,
      reason: `A role must be one of: ${INVITABLE_ROLES.join(', ')}.`,
    };
  }

  const existing = await getUserByEmail(email);
  if (existing && existing.id === principal.id) {
    return { ok: false, reason: 'You are already on this project — that is your own address.' };
  }

  /*
   * Re-inviting replaces rather than accumulates.
   *
   * `connectSite`'s property, for `connectSite`'s reason: there is then never
   * more than one live secret to reason about, and "the invitation I sent them"
   * is unambiguous. It is also the answering transition for an expired one —
   * inviting again is the whole remedy, and it withdraws what it supersedes.
   */
  const replaced = await revokeUnusedInvitationsFor(
    project.id,
    email,
    'Replaced by a newer invitation to the same address.',
  );

  const token = generateInvitationToken();
  const invitation = await createProjectInvitation({
    projectId: project.id,
    invitedEmail: email,
    role,
    tokenPrefix: token.prefix,
    tokenDigest: token.digest,
    invitedByUserId: principal.id,
    note: input.note ?? null,
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  });

  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: principal.id,
    credentialId: principal.credentialId,
    action: 'INVITE_PERSON',
    targetType: 'PROJECT_INVITATION',
    // The invitation's **id**. Never the token, never the prefix, and never
    // anything the secret could be reconstructed from.
    targetId: invitation.id,
    projectId: project.id,
    result: 'SUCCESS',
    requestId: principal.requestId,
    metadata: {
      invitationId: invitation.id,
      role,
      invitedEmail: email,
      accountExists: existing !== null,
      replaced,
      expiresAt: invitation.expiresAt,
    },
  });
  // The project's own history should show who was offered access, the same way
  // it shows who was granted it.
  await recordEvent({
    projectId: project.id,
    entityType: 'USER',
    entityId: existing?.id ?? email,
    eventType: 'ACCESS_INVITED',
    payload: { invitationId: invitation.id, role, by: principal.id },
  });

  return {
    ok: true,
    issued: {
      invitation,
      // The fragment, not the path. A `#` is never sent to a server and never
      // written to an access log, so the token cannot be recorded by getting
      // near one — §17's rule about a credential in a URL.
      invitationUrl: `${input.origin.replace(/\/+$/, '')}/invite#${token.plaintext}`,
      expiresAt: invitation.expiresAt,
      accountExists: existing !== null,
      whatHappensNext: whatAcceptingWillDo({
        email,
        role,
        existing,
        inviterMayCreateAccount: decideBrainAdmin(principal).allowed,
      }),
      replaced,
    },
  };
}

/**
 * What a holder of a live invitation is told before they accept.
 *
 * Reads and creates nothing — opening the link deliberately does not consume it,
 * exactly as a worker invitation's does not: a person who loses the tab, or whose
 * first attempt fails, must not need a new invitation.
 */
export interface InvitationPreview {
  projectName: string;
  role: ProjectRole;
  roleExplanation: string;
  invitedEmail: string;
  invitedByName: string;
  expiresAt: string;
  /** True when accepting will have to make the account, so a password is asked. */
  accountNeeded: boolean;
  /** False when `accountNeeded` and the inviter cannot authorize creating one. */
  acceptable: boolean;
  /** Why not, when it is not. Always a remedy rather than a reason to retry. */
  blockedReason: string | null;
}

const ROLE_EXPLANATION: Record<ProjectRole, string> = {
  OWNER: 'You will be able to do anything on this project, including changing who else can.',
  ADMIN: 'You will be able to work on this project and change who else can reach it.',
  MEMBER: 'You will be able to read this project and work on it.',
  VIEWER: 'You will be able to read this project.',
};

export type PreviewOutcome =
  | { ok: true; preview: InvitationPreview }
  | { ok: false; reason: string };

/**
 * Resolve a presented token to what accepting would do.
 *
 * Every failure — malformed, unknown, expired, spent, withdrawn, a project that
 * has gone, an inviter who no longer administers it — is the same
 * `INVITATION_REFUSAL`, because a token holder learning *which* of those it is
 * learns something about a Brain they cannot otherwise see.
 */
export async function previewInvitation(token: unknown): Promise<PreviewOutcome> {
  const resolved = await resolveInvitation(token);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const { invitation, project, inviter } = resolved;

  const invited = await getUserByEmail(invitation.invitedEmail);
  const accountNeeded = invited === null;
  const accountDisabled = invited !== null && invited.disabledAt !== null;
  const inviterPrincipal = await principalForInviter(inviter, `invitation:preview:${invitation.id}`);
  const mayCreateAccount = decideBrainAdmin(inviterPrincipal).allowed;

  /*
   * Acceptable means the button will work, not that the invitation is valid.
   *
   * Both ways it can be false are conditions somebody else has to resolve — an
   * account that does not exist and an inviter who cannot make one, or an
   * account that exists and is disabled — and in both the invitation stays
   * live, so the remedy is the whole answer. A page that offered Accept and
   * then refused would be the dead end §24 keeps finding.
   */
  const acceptable = accountDisabled ? false : !accountNeeded || mayCreateAccount;
  return {
    ok: true,
    preview: {
      projectName: project.name,
      role: invitation.role,
      roleExplanation: ROLE_EXPLANATION[invitation.role],
      invitedEmail: invitation.invitedEmail,
      invitedByName: inviter.displayName || inviter.email,
      expiresAt: invitation.expiresAt,
      accountNeeded,
      acceptable,
      blockedReason: acceptable
        ? null
        : accountDisabled
          ? 'The Brain account for this address is disabled. Ask a Brain administrator to ' +
            'enable it — this invitation stays valid until then, and does not need re-sending.'
          : 'There is no Brain account for this address yet, and the person who invited you is ' +
            'not able to create one. Ask a Brain administrator to make the account — this ' +
            'invitation will work the moment it exists, and does not need re-sending.',
    },
  };
}

interface Resolved {
  ok: true;
  invitation: ProjectInvitation;
  project: { id: string; name: string };
  inviter: User;
}

/**
 * Token to invitation, project and inviter — or the one refusal.
 *
 * The inviter's **current** authority is checked here, so a link left behind by
 * somebody who has since lost `ADMIN` on the project lets nobody in. It does not
 * consume the invitation: the remedy is a present administrator inviting again,
 * and burning the row would make that a second decision rather than one.
 */
async function resolveInvitation(
  token: unknown,
): Promise<Resolved | { ok: false; reason: string }> {
  if (typeof token !== 'string') return { ok: false, reason: INVITATION_REFUSAL };
  const parsed = parseInvitationToken(token);
  if (!parsed) return { ok: false, reason: INVITATION_REFUSAL };

  const invitation = await findLiveProjectInvitation(parsed.prefix, parsed.secret);
  if (!invitation) return { ok: false, reason: INVITATION_REFUSAL };

  const project = await getProject(invitation.projectId);
  if (!project) return { ok: false, reason: INVITATION_REFUSAL };

  const inviter = await getUser(invitation.invitedByUserId);
  if (!inviter || inviter.disabledAt) return { ok: false, reason: INVITATION_REFUSAL };

  const inviterPrincipal = await principalForInviter(inviter, `invitation:resolve:${invitation.id}`);
  if (!decideProjectAccess(inviterPrincipal, invitation.projectId, 'ADMIN').allowed) {
    return { ok: false, reason: INVITATION_REFUSAL };
  }

  return { ok: true, invitation, project: { id: project.id, name: project.name }, inviter };
}

/**
 * Accept one.
 *
 * The order is the whole of it:
 *
 *   1. resolve the token, the project and the inviter's current authority;
 *   2. resolve *who the invitation names* — never anything the caller said about
 *      themselves — and create that account only if the inviter may authorize it;
 *   3. spend the invitation with the guarded `UPDATE`, which is the moment two
 *      requests holding one link are separated;
 *   4. grant the membership the **invitation** named.
 *
 * Step 3 before step 4 is deliberate. Granting first would let a withdrawn or
 * already-spent invitation put somebody on a project, which is the one outcome
 * that must be impossible. The window it leaves — a crash between spending and
 * granting — loses a membership and keeps a visible spent invitation, whose
 * remedy is an administrator inviting again; the reverse window would grant
 * access nobody authorized, and no remedy undoes that having happened.
 */
export async function acceptInvitation(input: {
  token: unknown;
  password?: unknown;
  displayName?: unknown;
  /** For the audit only: how the request reached Brain. Never an identity. */
  requestId?: string | null;
  userAgent?: string | null;
  remoteAddr?: string | null;
}): Promise<AcceptOutcome> {
  const resolved = await resolveInvitation(input.token);
  if (!resolved.ok) {
    // Denied, by **category**, with no token, no prefix and no email: §17's rule
    // that an identity event records what kind of refusal happened rather than
    // what was tried.
    await recordIdentityEvent({
      actorType: 'ANONYMOUS',
      action: 'ACCEPT_PROJECT_INVITATION',
      targetType: 'PROJECT_INVITATION',
      result: 'DENIED',
      reason: 'INVALID_CREDENTIALS',
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      ...(input.remoteAddr ? { remoteAddr: input.remoteAddr } : {}),
      metadata: { category: 'UNUSABLE_INVITATION' },
    });
    return { ok: false, reason: resolved.reason };
  }
  const { invitation, project, inviter } = resolved;

  const inviterPrincipal = await principalForInviter(inviter, `invitation:accept:${invitation.id}`);
  let invited = await getUserByEmail(invitation.invitedEmail);
  let createdAccount = false;

  if (invited && invited.disabledAt) {
    return {
      ok: false,
      reason:
        'The account for this address is disabled, so it cannot be put on a project. Ask a ' +
        'Brain administrator to enable it; this invitation stays valid until then.',
    };
  }

  if (!invited) {
    /*
     * Creating the account is `decideBrainAdmin`'s to authorize, and it is read
     * here — now — from the inviter's current rows rather than from anything
     * stored on the invitation. An invitation that cannot create an account says
     * so with the remedy and is **not** consumed, so it works the moment a Brain
     * administrator makes the account.
     */
    if (!decideBrainAdmin(inviterPrincipal).allowed) {
      await recordIdentityEvent({
        actorType: 'ANONYMOUS',
        action: 'ACCEPT_PROJECT_INVITATION',
        targetType: 'PROJECT_INVITATION',
        targetId: invitation.id,
        projectId: project.id,
        result: 'DENIED',
        reason: 'NOT_BRAIN_ADMIN',
        ...(input.requestId ? { requestId: input.requestId } : {}),
        metadata: { invitationId: invitation.id, category: 'ACCOUNT_CREATION_NOT_AUTHORIZED' },
      });
      return {
        ok: false,
        reason:
          'There is no Brain account for this address yet, and the person who invited you is ' +
          'not able to create one. Ask a Brain administrator to make the account — this ' +
          'invitation will work the moment it exists, and does not need re-sending.',
      };
    }
    const password = input.password;
    if (typeof password !== 'string') {
      return { ok: false, reason: 'Choose a password to finish setting up your account.' };
    }
    try {
      assertUsablePassword(password);
    } catch (error) {
      if (error instanceof WeakPasswordError) return { ok: false, reason: error.message };
      throw error;
    }
    const displayName =
      typeof input.displayName === 'string' && input.displayName.trim().length > 0
        ? input.displayName.trim().slice(0, 120)
        : invitation.invitedEmail;
    /*
     * Two requests holding one link, for an address with no account, both reach
     * here — and `users.email` is unique, so the second `INSERT` fails.
     *
     * That is the database arbitrating, which is right; what would be wrong is
     * letting it surface as an error. The loser re-reads the row it collided
     * with and carries on to the guarded `UPDATE` below, which is the statement
     * that actually decides who spent the invitation. So a race produces one
     * account, one membership and one ordinary refusal, rather than a 500 that
     * tells the second person their invitation is broken.
     *
     * The re-read is the condition, not the error text: a collision is only a
     * collision if the row it collided with is now there. Anything else rethrows.
     */
    try {
      invited = await createUser({
        // The address comes from the **invitation**, so an acceptor cannot make
        // an account for somebody else by asking.
        email: invitation.invitedEmail,
        displayName,
        password,
        // Never, whoever invited them. Brain-wide administration is not
        // something a project-scoped invitation may confer.
        isBrainAdmin: false,
        createdByType: 'HUMAN',
        createdById: inviter.id,
      });
      createdAccount = true;
    } catch (error) {
      const raced = await getUserByEmail(invitation.invitedEmail);
      if (!raced) throw error;
      invited = raced;
    }
  }

  const accepted = await acceptProjectInvitation(invitation.id, invited.id);
  if (!accepted) {
    // Lost the guarded UPDATE: somebody else's request spent this invitation
    // between the read and the write, or it was withdrawn in that window. The
    // same body an unknown token gets — the loser learns nothing.
    await recordIdentityEvent({
      actorType: 'ANONYMOUS',
      action: 'ACCEPT_PROJECT_INVITATION',
      targetType: 'PROJECT_INVITATION',
      targetId: invitation.id,
      projectId: project.id,
      result: 'DENIED',
      reason: 'INVALID_CREDENTIALS',
      ...(input.requestId ? { requestId: input.requestId } : {}),
      metadata: { invitationId: invitation.id, category: 'ALREADY_SPENT' },
    });
    return { ok: false, reason: INVITATION_REFUSAL };
  }

  await grantMembership({
    projectId: project.id,
    principalType: 'HUMAN',
    principalId: invited.id,
    // The role the invitation named. Nothing the acceptor sent reaches this.
    role: invitation.role,
    scopes: [],
    grantedByType: 'HUMAN',
    grantedById: inviter.id,
  });

  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: invited.id,
    action: 'ACCEPT_PROJECT_INVITATION',
    targetType: 'PROJECT_INVITATION',
    targetId: invitation.id,
    projectId: project.id,
    result: 'SUCCESS',
    ...(input.requestId ? { requestId: input.requestId } : {}),
    metadata: {
      invitationId: invitation.id,
      role: invitation.role,
      invitedBy: inviter.id,
      createdAccount,
    },
  });
  await recordEvent({
    projectId: project.id,
    entityType: 'USER',
    entityId: invited.id,
    eventType: 'ACCESS_GRANTED',
    payload: {
      role: invitation.role,
      scopes: [],
      by: inviter.id,
      byType: 'HUMAN',
      via: 'INVITATION',
      invitationId: invitation.id,
    },
  });

  return {
    ok: true,
    projectId: project.id,
    projectName: project.name,
    role: invitation.role,
    userId: invited.id,
    email: invited.email,
    createdAccount,
    // An acceptance hands out no session. A new account has to sign in, and an
    // existing one may already be signed in elsewhere; either way nothing about
    // the acceptor's browser becomes an identity here.
    signInRequired: true,
  };
}

/**
 * Withdraw one.
 *
 * An id that does not exist and an id belonging to a project this caller may not
 * administer are the same 404 with the same body, so an invitation id is not an
 * oracle for a Brain somebody cannot see.
 */
export async function withdrawInvitation(input: {
  principal: Principal | null;
  projectId: string;
  invitationId: string;
  reason?: string | null;
}): Promise<{ ok: true; withdrawn: boolean; alreadyFinished: boolean } | { ok: false; reason: string }> {
  const principal = input.principal;
  if (!principal || principal.type !== 'HUMAN') {
    return { ok: false, reason: INVITATION_NOT_FOUND };
  }
  if (!decideProjectAccess(principal, input.projectId, 'ADMIN').allowed) {
    return { ok: false, reason: INVITATION_NOT_FOUND };
  }
  const invitation = await getProjectInvitation(input.invitationId);
  // Another project's invitation is reported as one that does not exist.
  if (!invitation || invitation.projectId !== input.projectId) {
    return { ok: false, reason: INVITATION_NOT_FOUND };
  }

  const withdrawn = await revokeProjectInvitation(invitation.id, input.reason ?? 'Withdrawn.');
  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: principal.id,
    credentialId: principal.credentialId,
    action: 'REVOKE_PROJECT_INVITATION',
    targetType: 'PROJECT_INVITATION',
    targetId: invitation.id,
    projectId: invitation.projectId,
    result: withdrawn ? 'SUCCESS' : 'FAILED',
    requestId: principal.requestId,
    metadata: { invitationId: invitation.id },
  });
  return {
    ok: true,
    withdrawn,
    // Not a failure: it had already been accepted or already withdrawn, and
    // saying which is what tells the administrator there is nothing to do.
    alreadyFinished: !withdrawn,
  };
}

/** How one invitation reads to the administrators of its project. */
export interface InvitationSummary {
  id: string;
  email: string;
  role: ProjectRole;
  roleLabel: string;
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
  state: 'PENDING' | 'EXPIRED' | 'ACCEPTED' | 'WITHDRAWN';
  /** The plain sentence, composed on the server rather than in the client. */
  status: string;
  /** What a person can do about it, when it is not simply waiting. */
  remedy: string | null;
}

const ROLE_LABEL: Record<ProjectRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Administrator',
  MEMBER: 'Member',
  VIEWER: 'Viewer',
};

/**
 * The invitations on a project, as sentences.
 *
 * An expired one is **shown** rather than hidden, with its remedy named, because
 * §24's rule is that an escalation with no answering transition is stuck: an
 * invitation that quietly disappeared when it aged out would leave a person
 * wondering whether it had ever been sent.
 */
export async function invitationsForProject(projectId: string): Promise<InvitationSummary[]> {
  const now = new Date().toISOString();
  const rows = await listProjectInvitations(projectId);
  const out: InvitationSummary[] = [];
  for (const invitation of rows) {
    const inviter = await getUser(invitation.invitedByUserId);
    const invitedByName = inviter ? inviter.displayName || inviter.email : 'somebody who has left';
    const state: InvitationSummary['state'] =
      invitation.acceptedAt !== null
        ? 'ACCEPTED'
        : invitation.revokedAt !== null
          ? 'WITHDRAWN'
          : invitation.expiresAt <= now
            ? 'EXPIRED'
            : 'PENDING';
    out.push({
      id: invitation.id,
      email: invitation.invitedEmail,
      role: invitation.role,
      roleLabel: ROLE_LABEL[invitation.role],
      invitedByName,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      state,
      status:
        state === 'ACCEPTED'
          ? `Accepted ${invitation.acceptedAt!.slice(0, 10)}.`
          : state === 'WITHDRAWN'
            ? `Withdrawn${invitation.revokedReason ? ` — ${invitation.revokedReason}` : '.'}`
            : state === 'EXPIRED'
              ? `Expired ${invitation.expiresAt.slice(0, 10)} without being accepted.`
              : `Waiting to be accepted. Expires ${invitation.expiresAt.slice(0, 10)}.`,
      // Only one state has something a person can do about it, and it says so
      // rather than leaving an expired invitation looking like one that was
      // never sent. The others are history.
      remedy:
        state === 'EXPIRED' ? 'Invite them again — a new invitation replaces this one.' : null,
    });
  }
  return out;
}

# External actions (§51)

How Brain does something outside itself — a message, an email, an invoice — and
knows what actually happened.

## What was true before this build (read from production, 2026-09-23)

- `flyctl secrets list` on `northline-brain` names 24 secrets: the database,
  the store, and fifteen Routine tokens. **No messaging, email, invoicing or
  payment credential exists in the deployment.** The capability reader's
  "MISSING" for SEND_A_MESSAGE, ISSUE_AN_INVOICE, TAKE_A_PAYMENT,
  PUBLISH_A_LISTING and SIGN_AN_AGREEMENT was therefore accurate.
- The live sprint (`prj_22fb4fec295f403a8a22`, `cash-report` run 47) holds 40
  opportunities: 40 signals, 0 candidates, 0 qualified, **0 ready**, and
  `commercial_grant=ABSENT`. So *no piece is blocked on messaging today*: what
  blocks them is qualification, and — for any contact at all — a standing
  commercial authority nobody has granted.
- Eight deep dives sit at `NEEDS_PERSON` and reach the owner only if the owner
  opens Brain.

That decided the order:

1. **Owner notification (ntfy)** — the one external action that is useful
   today, reaches no third party, needs no account, and turns "a decision is
   waiting" from a row into a message on a phone. It is also the only provider
   a proof could honestly be run against from here.
2. **Email (Resend)** — the first commercial act every READY piece hits
   (`CONTACT_BUYER`). Built, contract-tested, and waiting on an account.
3. **Invoice and payment (Stripe)** — after contact. Built with issued, paid
   and settled as three separate read-backs, test mode first.

Publishing and signing are **not** built, and not for want of time:
`PUBLISH_EXTERNALLY` and `IDENTITY_BEARING_ACT` are in
`ALWAYS_PROHIBITED_COMMERCIAL`. A connector would not change what a grant may
carry, and changing that is a policy decision, not a connection.

## The path

`server/services/external/actions.ts`:

| stage | what is checked or recorded |
|---|---|
| **prepare** | the project's live connection for the provider, read *now* (deployed secret + provider answered for that exact credential within 24h + live mode); a valid destination; for anybody other than the owner, a standing commercial authority covering `CONTACT_BUYER` / `QUOTE_AND_INVOICE`; the opening and conversation belong to the project. A failure writes nothing and names the remedy. |
| **approve** | every action except a message to the owner's own phone waits for a project ADMIN (`requirePerson`). All preconditions are asked again. |
| **execute** | Step 6 `runExternalEffect`, key `xac.<actionId>` (nothing else contributes). Preconditions asked a third time. Rate limit → waits and retries under the same key. Refusal → `REFUSED`. Unknown → `UNCERTAIN`, never resent automatically; a reconcilable provider is asked again on the tick. |
| **read back** | the provider is asked, by its own identifier, what state the effect produced — and first whether the object is this action's at all (ntfy tag, Stripe `metadata[brain]`, Resend recipient), so an identifier a person supplies for someone else's object reads `NOT_THIS_ACTION` and records nothing. Email: `ACCEPTED` (queued/sent — **never** "delivered") → `DELIVERED`/`BOUNCED`/`DELAYED`/…; invoice: `ISSUED` → `PAYMENT_ATTEMPTED` (a declined attempt, no money) → `PAYMENT_MADE` → `FUNDS_SETTLED` with the provider fee and net; ntfy: `PUBLISHED`. |
| **return** | once (`claimReturn`): a SYSTEM message in the originating Russell conversation ("the provider accepted it … reading it back says …", never "done" about something only accepted), a `project_events` row, and — for an opening — a cash event, the opening's recorded commercial act with the provider identifier as its reference, and (live money only) `CUSTOMER_PAYMENT`, `SETTLEMENT` (gross) and `COST` (the fee), so available funds come out at the net. |

### Crash and ambiguity

- **Accepted, then Brain died before the receipt was written.** The action is
  left `SENDING`; five minutes later the tick hands the Step 6 operation back to
  recovery (`releaseAbandonedOperation`). ntfy is *asked* (and the message is
  found, not re-sent); Resend and Stripe repeat the **same** idempotency key, so
  the provider returns what it already made. Past 22 hours — inside the
  providers' 24-hour key windows — nothing is repeated: the action goes
  `UNCERTAIN` for a person.
- **Step 6 defect fixed on the way.** `latestSentAttempt` filtered on
  `provider_key IS NOT NULL`, and only idempotent adapters have one, so crash
  recovery could not see a reconcilable or opaque attempt and **sent it again**.
  It reads the attempt phase now; `tests/idempotency.test.ts` holds the opaque
  case and `tests/externalActionBoundaries.test.ts` the ntfy one.
- **Intent recorded, provider never answered.** No receipt, no read-back and no
  "sent" anywhere; the action is `UNCERTAIN` and is never resent automatically
  (ntfy reconciliation never answers ABSENT). A transport error to Resend or
  Stripe before any reply is retried only under the same key.
- **Money.** Written only when the connection reads HEALTHY *and* the invoice
  says `livemode: true`. Each entry is keyed, so a second read-back writes
  nothing, and a refused entry (no sprint, no `ACCEPT_PAYMENT` grant) is retried
  on the next read-back rather than lost.

A Russell turn may propose `PREPARE_EXTERNAL_ACTION` (NOTIFY_OWNER or
SEND_EMAIL only); it lands as a prepared row under the conversation owner's
authority. A proposal is never an approval — an email waits for an administrator
whatever the worker wrote — and a recipient address must appear in something the
person wrote in that conversation, or nothing is prepared. A refusal is posted
in the conversation by the server. Nothing can record a commercial act as
performed **by Brain** without a provider-confirmed external action carrying the
same reference: `recordAction` refuses it, whoever calls. Cash Mode's `advanceWithinAuthority` no longer records a contact that
never happened: for a READY piece whose card holds an email address, it prepares
an approval-gated email, and the piece moves to EXECUTING only when the provider
confirms a send.

## Credentials

Never stored, logged, returned or put in a URL Brain logs. A connection holds
the **name** of a deployment secret that Brain assigns
(`BRAIN_EXT_<PROVIDER>_<8 hex of the project id>`); an administrator sets the
value in Fly (which restarts the machine), then presses **Check**. Each check
records a sha-256 of the credential it checked, so a rotated secret reads
`CREDENTIAL_CHANGED` until it is checked again. Revoking stops use immediately;
reconnecting creates a new row that must be checked before anything reads it as
available.

## Proof

`npx tsx scripts/prove-external-action.ts` — a real Brain, real HTTP routes, a
real provider. Run on 2026-09-23:

```
STEP capability before connecting: NOTIFY_OWNER MISSING — No connection for this provider exists on this project.
STEP capability with a row and no secret: MISSING — WAITING_FOR_SECRET
STEP restarted with the secret deployed: BRAIN_EXT_NTFY_B53830F2
STEP check: HEALTHY — The ntfy server answered healthy, and the topic is well formed.
STEP capability after a real check: PRESENT
STEP action: CONFIRMED providerRef=qQrFq73pRfjQ operation=idop_1221510a39984437aaf9 readback=NOT_VISIBLE_YET
STEP read back again: PUBLISHED — message qQrFq73pRfjQ is there, published at 2026-09-23T16:05:00Z
STEP independent provider read: {"id":"qQrFq73pRfjQ","title":"Brain: external action proof"}
STEP returned to the conversation: the SYSTEM message carries the provider identifier
STEP same request again: {"created":false,"sameAction":true}
STEP capability after revoking: MISSING
STEP prepare after revoking: 422 — …has no live connection to it.
STEP credential: absent from the server log and from the database file
EXTERNAL-PROVE: OK provider=ntfy.sh receipt=qQrFq73pRfjQ readback=PUBLISHED
```

The first read-back said `NOT_VISIBLE_YET`: ntfy writes its cache about a second
after it answers a publish. That measurement is why ntfy reconciliation never
answers ABSENT — "not in the topic yet" would otherwise license a resend.

What this does **not** prove: the Resend and Stripe drivers are exercised by
`tests/externalActions.test.ts` against a scripted provider, not against a real
account. Neither has run against a real API yet.

## What a person does to finish live acceptance

Production project ids and the secret names Brain will ask for:

| project | ntfy | Resend | Stripe |
|---|---|---|---|
| cash sprint `prj_22fb4fec295f403a8a22` | `BRAIN_EXT_NTFY_5AC32D4C` | `BRAIN_EXT_RESEND_5AC32D4C` | `BRAIN_EXT_STRIPE_5AC32D4C` |
| Deal Dispatch `prj_9d86dfaec863473cb498` | `BRAIN_EXT_NTFY_68CB2498` | `BRAIN_EXT_RESEND_68CB2498` | `BRAIN_EXT_STRIPE_68CB2498` |

1. **Owner notifications (no account, no cost):** after this ships, open
   External actions on the sprint project → Connect "Push messages to your own
   phone". Install ntfy, subscribe to a long random topic, and run
   `flyctl secrets set BRAIN_EXT_NTFY_5AC32D4C=<topic>`. Press Check, then
   prepare "A message to my phone". The waiting deep dives start reaching the
   phone on the next tick.
2. **Stripe, test mode first:** a restricted **test** key
   (`rk_test_…`) as `BRAIN_EXT_STRIPE_5AC32D4C`; connect with your own address;
   issue a test invoice to yourself; pay it with card `4242 4242 4242 4242`;
   watch it read back `ISSUED` → `PAYMENT_MADE` → `FUNDS_SETTLED`. Only then the
   live key.
3. **Email:** a Resend account with a verified domain, the key as
   `BRAIN_EXT_RESEND_5AC32D4C`, a From address on that domain, and a first
   email to your own address.
4. **Anything to a third party** additionally needs the standing commercial
   authority (`CONTACT_BUYER`, `QUOTE_AND_INVOICE`) that production does not
   have, and a person approving each action. Both are deliberately yours.

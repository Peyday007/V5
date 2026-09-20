# The conversation entrance

What this is, how to connect a conversation client to it, and — the half that
matters more — exactly what it does and does not do.

---

## What it is

A conversation held in somebody else's client is the largest body of decisions
this Brain has never been able to read. The bridge is a way *in* for that: a
transcript arrives exactly as it was said, keeps its order, becomes a source a
workstream can point at, and the person's own words are handed to the machinery
Russell already has.

It is **not** a second Russell, a second queue or a second set of rules. Every
gate a person typing into Russell meets is the gate a synced message meets,
because a synced message *is* a person's message in a person's thread.

---

## The credential

`brnc_…`, minted in a browser, shown once.

It is the only bearer in this Brain that resolves to a **person** rather than a
worker. Three properties bound it, and each is a refusal rather than a promise:

- **It is not an administrator.** `authenticateBridge` writes
  `isBrainAdmin: false` unconditionally, however the account behind it is
  configured. So everything an administrator may do stays behind the session
  cookie, and a leaked bridge key loses that person's conversations and nothing
  else.
- **It cannot mint another credential.** Minting refuses any caller that arrived
  on one. A key that could mint keys survives its own revocation: you revoke the
  one you know about and the one it made is still there.
- **It cannot be somebody else.** Every route resolves the subject from the
  authenticated principal. There is no path segment naming a user.

A worker principal is refused **by type** at every bridge route, reads included.

### One consequence worth knowing before you connect

A bridge credential resolves to the person **and drops Brain administration**,
which means it reaches exactly the projects that person holds a *membership row*
on — not the ones they can reach by being an administrator.

That is the intended trade and not an oversight: a key pasted into a chat client
should not be able to read every project in the Brain. It has a visible
consequence for an owner who administers projects they never explicitly joined —
Brain will answer *"I am not sure which project this is about yet"* however
clearly the message names one, because the project is not a candidate for that
credential at all.

The remedy is one membership grant, and it is the same one every other member
already has.

Revoking is immediate: the credential is resolved from rows on every request, so
it stops working on the next call rather than when a token happens to expire.

---

## Connecting ChatGPT

ChatGPT reaches an external service through a **custom GPT Action**. What
follows is the whole of the setup.

1. **Mint a credential.** In Brain: *Work → The work register* is the surface
   the register lives on; the credential itself is minted by
   `POST /api/bridge/credentials` with `{"label": "ChatGPT"}` from a signed-in
   browser session. Copy the `secret` — it starts `brnc_` and is not recoverable
   afterwards by anyone, including an administrator.

2. **In ChatGPT**, open *Explore GPTs → Create → Configure → Create new action*.

3. **Authentication**: choose *API Key*, auth type *Bearer*, and paste the
   secret.

4. **Schema**: paste the OpenAPI document below, replacing `YOUR-BRAIN-HOST`
   with this Brain's host.

5. **Privacy policy**: required by ChatGPT for a published GPT; any URL you
   control will do for a private one.

```yaml
openapi: 3.1.0
info:
  title: Brain conversation bridge
  version: '1.0'
servers:
  - url: https://YOUR-BRAIN-HOST
paths:
  /api/bridge/conversations/sync:
    post:
      operationId: syncConversation
      summary: Send this conversation to Brain and get a receipt.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [source, externalId, title, messages]
              properties:
                source:
                  type: string
                  enum: [CHATGPT]
                externalId:
                  type: string
                  description: A stable id for this conversation. Reuse it every time.
                title: { type: string }
                interpret:
                  type: boolean
                  description: False when back-filling history rather than asking for something.
                messages:
                  type: array
                  items:
                    type: object
                    required: [ordinal, role, content]
                    properties:
                      ordinal:
                        type: integer
                        description: Position in the conversation, from zero.
                      role:
                        type: string
                        enum: [USER, ASSISTANT, SYSTEM, TOOL, UNKNOWN]
                      content: { type: string }
                      externalId: { type: string }
                      saidAt: { type: string }
      responses:
        '200': { description: A receipt. }
  /api/bridge/conversations/{conversationId}/status:
    get:
      operationId: conversationStatus
      summary: Ask what Brain did with what was said.
      parameters:
        - name: conversationId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200': { description: Turns, software requests, workstreams, and what needs a person. }
  /api/bridge/conversations/{conversationId}/transcript:
    get:
      operationId: conversationTranscript
      summary: Read back the transcript Brain holds.
      parameters:
        - name: conversationId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200': { description: The messages, in order. }
```

6. **Instructions for the GPT.** Put this in its instructions so it calls the
   action rather than waiting to be asked:

   > After each of my messages, call `syncConversation` with the whole
   > conversation so far: `source` `CHATGPT`, a stable `externalId` you choose
   > once and reuse, the title, and every message with its `ordinal` counting
   > from zero. Re-sending messages already sent is free and correct. When I ask
   > what Brain is doing, call `conversationStatus` and tell me what it says —
   > including anything under `needsYou`.

---

## When synchronization actually happens

**It happens when the client calls the action, and not otherwise.** There is no
push from ChatGPT to Brain, and nothing in Brain polls ChatGPT. That is a
property of the platform rather than a gap in this implementation, and it has
three consequences worth being plain about:

- **A conversation you never sync is invisible to Brain.** Nothing here can
  reach your chat history.
- **A model that forgets to call the action has not synced.** The instructions
  above make it call on every turn, and a model is not a scheduler.
- **A missed sync is visible.** Every conversation carries `lastSyncAt` and
  `messageCount`, and every receipt names the positions Brain has never been
  given. A transcript with a hole reports the hole rather than reading as whole.

**The manual import is a fallback and is labelled as one.** It is genuinely
useful — it is how a year of existing conversations gets in — and it is not the
automatic bridge. Do not read "I imported an export" as "the bridge is working".

---

## Importing what already exists

`POST /api/bridge/conversations/import` takes `{"body": "…"}` and reads it two
ways, saying which happened:

| `format` | What it read |
| --- | --- |
| `CHATGPT_EXPORT` | `conversations.json` from *Settings → Data controls → Export data*. Walked along the conversation's own chain, not the object order, and it says which regenerated branches it did **not** read. |
| `MARKED_TEXT` | A paste with `You:` / `ChatGPT:` / `Assistant:` markers. Multi-paragraph turns stay whole. |
| `SINGLE_BLOCK` | A paste with no markers at all. Kept as **one** passage of role `UNKNOWN`, because inventing speakers would be making up who said what. |

Imports default to `interpret: false`: history is not a question anybody is
asking, and opening a turn per imported batch would send a worker for a
six-month-old decision.

---

## What Brain does with a sync

1. **Stores it exactly.** Byte for byte, with the hash beside it. Nothing trims,
   re-wraps or re-encodes.
2. **Orders it.** By the client's own `ordinal`, so out-of-order delivery is
   reordered and a gap is reported.
3. **Keeps corrections.** An edited message becomes a new revision and the
   previous one is superseded and kept. A fork — a different message at an
   occupied position with nothing linking it — is kept as a fork rather than
   resolved by picking one.
4. **Hands your own latest turn to Russell.** `beginTurn` persists a PENDING row
   and a bin, which the fixed-subscription fleet answers. **No inference is
   bought**: the deployed Brain has no `ANTHROPIC_API_KEY` and no
   `BRAIN_PROVIDER`, and this changes nothing about that.
5. **Resolves the project itself**, from existing records and rules
   (`routeMessage`), or says it cannot and asks.

The other model's turns are **stored and never acted on**. Imported text is
untrusted data throughout: nothing found inside a transcript is executed, and
none of it moves project state by itself.

### The receipt's four outcomes

| `routing.outcome` | Means |
| --- | --- |
| `TURN_OPENED` | A bin exists; a worker will answer. `binId` is on the receipt. |
| `ANSWERED` | Russell settled it in the same request — usually by asking which project this is about. **Nobody was sent for.** |
| `NOTHING` | Nothing was handed over, with the reason (a back-fill, or no person-turn). |
| `REFUSED` | Russell declined, in its own words. |

`TURN_OPENED` and `ANSWERED` are distinguished deliberately. A client told a
worker is coming when none was sent for is the reassuring pending state §24
corrects, arriving at a receipt.

---

## Retries

A retry is not a second delivery. The idempotency key is built from the
authenticated person, the conversation Brain resolved, and a fingerprint of the
batch's own content — never from a clock, an attempt number or a request id,
all of which change on the retry.

And it means what §20 says it means: **the effect is present after either call,
not that the second call does nothing.** A replay returns the receipt the first
attempt produced, with `performed: false` so a client can tell a replay from a
delivery.

Re-sending content that already exists is separately free: a message whose
position, id and hash already match is counted as a duplicate and not written
again, so a client that sends its whole transcript every turn is cheap and
correct.

---

## The return path

`GET /api/bridge/conversations/{id}/status` answers, from rows:

- the turns Russell has taken, and what a pending one is waiting for;
- the software changes the conversation asked for, each with its change request,
  its campaign, and any blocker **in the campaign's own words**;
- the workstreams the register says this conversation feeds, each with its
  derived state and the row that decided it;
- `needsYou` — what a person has to do, deduplicated, and empty when there is
  nothing.

Nothing in it is composed prose about progress. Every line resolves to a row and
says which.

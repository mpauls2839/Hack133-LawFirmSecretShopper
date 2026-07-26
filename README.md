# Intake Grader

Audits how service businesses handle inbound customer inquiries. Paste a business URL and
the system works out how to contact them, opens a conversation as a fabricated but
realistic prospective customer, keeps working that conversation through autoresponders and
AI bots until it reaches a real human or a booked meeting, then produces a scorecard.

Build spec: [`INTAKE_GRADER_SPEC.md`](./INTAKE_GRADER_SPEC.md).

---

## Where the spec did not survive contact with the platform

Everything below was verified against the live platform on 2026-07-26, not assumed. Each
one changed the design, so each one is recorded.

### `openclaw_identity` does not exist

Spec section 2 calls per-agent phone and email "the one thing that changes the whole
design". Authenticated `maritime templates --json` returns five templates — `openclaw`,
`zeroclaw`, `hermes`, `openclaw_browser`, `flue` — and none of them is
`openclaw_identity`. Grepping the entire CLI manifest for `inkbox`, `identity`, `phone`,
`sms` and `email` returns nothing, and no command provisions a number.

**Fallback taken**, as the spec instructs: a single shared number
(the GoHighLevel sub-account's) plus `contact_id` correlation. Each run binds to one CRM
contact and inbound polling is scoped to that contact's conversation.

### `maritime chat --conversation-id` does not isolate context

```
run-B: "Remember this code: ZEPHYR-8814"   → ok
run-B: "What was the code?"                → ZEPHYR-8814   (expected)
run-C: "What was the code?"                → ZEPHYR-8814   (LEAKED)
```

A fresh conversation id reads another conversation's history. The spec's claim that
"thirty fabricated identities cannot bleed into each other" does not hold for one agent
driven by conversation id.

**Consequence:** the router owns all state and passes full context on every call. Agent
memory is never relied on for anything.

### The LLM proxy is an OpenAI passthrough

`https://api.maritime.sh/api/llm/v1` has no `/models` endpoint and rejects both `mk_`
control-plane keys and login JWTs (`invalid_issuer`). It only accepts the per-agent
`OPENAI_API_KEY=mllm_<agentId>_…` that the platform injects **inside** a container.

Tested from inside: `gpt-4o-mini`, `gpt-4.1-mini`, `gpt-5-mini`, `gpt-5` all answer.
`gemma-4-12b`, `glm-5.2` and `deepseek-v4` all 404, so spec section 6's open-weight
two-tier plan is not deployable here. The tier split survives with `gpt-4o-mini` fast and
`gpt-5` deep, both in env so a swap needs no code change. Note `gpt-5` rejects
`max_tokens` and requires `max_completion_tokens`.

This is why the router runs as a Maritime agent: it is the only place the judge works, and
it means no provider key of ours exists anywhere.

### The platform's own template image has no CA certificates

`/etc/ssl/certs` is empty in `flue`, so every HTTPS call fails with "failed to verify the
legitimacy of the server" and the agent is dead on arrival — the platform's own health
watchdog flagged it as such. `openclaw` ships 285 certs and works. Our `Dockerfile`
installs `ca-certificates` explicitly rather than inheriting the problem.

### `maritime chat` reports success on failure

Not-ready responses arrive with exit code 0 and `"ok": true`:

```json
{ "ok": true, "response": "Your agent isn't reachable right now. Please resend…" }
{ "ok": true, "response": "Your agent is still starting up. Please resend…" }
```

The spec's "branch on exit code, never on string matching" cannot hold for this command.

### `maritime deploy` cannot redeploy a repo-built agent

It tries to pull `maritime-agent-<id>`, which was never pushed:

```
pull access denied for maritime-agent-38569611, repository does not exist
```

Redeploying means delete plus `create --repo`. See the deploy section below.

### GoHighLevel needs different API versions per endpoint group

The spec warns they differ. They do:

| endpoints | `Version` header |
|---|---|
| `/locations/*`, `/contacts/*` | `2021-07-28` |
| `/conversations/*` | `2021-04-15` (07-28 is rejected) |

Two more things worth knowing: the location record's `phone` field is **not** the sending
number, so the real one must be configured and confirmed by receipt; and a location with
"no duplicate contacts" rejects a create but returns the existing contact id in
`meta.contactId`, which is the contact you actually want.

---

## Design choices that depart from the spec

**Lifecycle and outcome are separate columns.** The spec has one state machine ending in a
terminal state that is then overwritten by `GRADED`. Splitting them means grading cannot
change what happened.

**`PROMISE_KEPT` is not an outcome.** A kept callback *is* a human on the line, so it
resolves to `HUMAN_*` or `BOOKED_*` and `promise.kept` becomes its own boolean axis.

**`DEFLECTED` buckets as `not_handled` for screening.** It ranks above a bot loop for
engagement, but the matter was not taken on — so declining what you advertise is the
expensive miss and declining what you do not is correct. Bucketing it as `handled` scored
a correct decline as wasted time.

**Tier 1 is split in two.** `classify.ts` answers only "who is talking and what did they
commit to"; `respond.ts` writes persona voice. One call emitting classification *and* a
reply cannot be asserted against a fixture, and a refusal on the reply half would destroy
the classification half.

**Outbound delay is a queue row.** The spec's "wait 2 to 5 minutes then send" contradicts
its own requirement that nothing long-running lives in memory. Delays are `send_queue`
rows drained by the sweeper, so a restart loses no turns.

---

## Guardrails, enforced in code

Section 11 of the spec is prose. These are the mechanisms:

| rule | mechanism |
|---|---|
| One inquiry per business per cycle | `UNIQUE INDEX` on `(target_id, cycle)` — a second attempt raises a constraint error |
| Nothing sends by accident | Three independent gates: kill switch, `ALLOW_LIVE_SENDS`, per-domain allowlist. All must pass |
| A replayed webhook cannot double-text | `UNIQUE INDEX` on `(provider, provider_id)` |
| A webhook and the sweeper cannot race | Per-run single-writer lock with stale-lock expiry |
| Never solve a CAPTCHA | No solving code path exists; recorded as `UNREACHABLE` with the vendor named |
| Never sign or accept terms | Persona replies pass a forbidden-phrase filter; a match falls back to a template |
| Close every conversation, cancel every booking | Cleanup pass in the sweeper; opt-outs are honoured with silence instead |
| Honour "stop" immediately | `OPTED_OUT` terminates on the flag, before sender type is even considered |
| Every outbound is auditable | Append-only `event_log` |
| Fictional identities only | Persona email is a reserved `.test` domain; phone is in the 555-01xx range |

An empty allowlist means no target can be contacted at all, which is the default.

---

## Running locally

```bash
npm install
cp .env.example .env      # nothing needs filling in for tests or the mock loop
npm test                  # 44 tests, no network
npm start                 # router on :3000, UI at /
```

The judge falls back to a deterministic stub when no usable key is present, so the whole
pipeline runs offline. `GET /api/health` reports which judge is live and why.

### A full loop with no transport at all

```bash
FAST_CLOCK=true node --env-file=.env scripts/live-run.ts --mock
```

Runs against an in-process mock business. Four profiles: `well_run`, `sloppy`,
`promise_breaker`, `declines`. Nothing opens a socket.

### A live run against a phone you own

```bash
node --env-file=.env scripts/live-run.ts --phone +1XXXXXXXXXX
node --env-file=.env scripts/live-run.ts --status <run_id>
node --env-file=.env scripts/live-run.ts --halt        # kill switch
```

Requires `ALLOW_LIVE_SENDS=true` and the target domain in `config/allowlist.txt`.

---

## Deploying to Maritime

```bash
maritime create intake-router \
  --repo https://github.com/<owner>/Hack133-LawFirmSecretShopper \
  --branch feat/intake-grader-router \
  --public --port 3000 --always-on

maritime env import intake-router ./agent.env
```

`--always-on` matters: a sleeping webhook receiver drops events. To ship new code, delete
and recreate — `maritime deploy` cannot rebuild a repo-built agent (see above).

`EXPOSED_PORT` should match the `--port` you passed. The platform injects its own `PORT`
which disagrees with the port it routes to, so the server binds both.

### Endpoints

| | |
|---|---|
| `GET /` | Scorecard UI |
| `GET /api/health` | Adapter, judge, gates, allowlist |
| `GET /api/health/calibration` | Runs the labeled set against the live judge; 503 below the gate |
| `GET /api/health/models` | Which models the proxy actually serves |
| `POST /api/targets` | `{ url }` → contact profile plus reachability verdict |
| `POST /api/runs` | `{ target_id }` → opens a run |
| `GET /api/runs`, `GET /api/runs/:id` | Runs and full transcripts |
| `POST /api/inbound/:provider` | Webhook receiver, deduped |
| `POST /api/control/halt`, `/resume` | Kill switch |
| `POST /api/control/sweep` | Force a sweep |

---

## The persona

One fixed persona in [`config/persona.md`](./config/persona.md), re-seeded from markdown on
every boot so it can be edited without touching code. Frontmatter carries the structured
fields; `need_tags` is the entire qualification mechanism — it is compared against the
service tags extracted from the target's own site, so the same persona flips between
qualified and unqualified for free depending on the business.

The name is fictional, the email domain is a reserved TLD that can never resolve, and the
phone is in the fictional 555-01xx range. Naming a real company as a counterparty is
prohibited: law firms run conflict checks and log intake, so a fabricated matter naming a
real defendant can pollute a real case record later.

---

## Calibration

20 hand-labeled inbound messages in `src/judge/calibration.json`, six of them verbatim
from a live run where a human played the firm. The gate is 80% agreement, asserted in
tests and exposed at `/api/health/calibration`.

Building it caught four defects that were already in the code:

- Bare `stop` matched anywhere in a body, so "I had to stop at the hospital" read as an
  opt-out request and would have ended a live run silently.
- Human tells were far too narrow, so real typed messages classified as bots — which would
  have made every time-to-human and turns-in-automation figure wrong.
- Relative time offers ("a call after 30 minutes") were missed, so the persona kept
  demanding a human it had already reached.
- `callback_promised` required the commitment verb adjacent to the subject, so "a
  specialist will review your information and be in touch" never matched. Without it
  `PROMISE_BROKEN` could not fire on the most common phrasing there is.

Both judges currently score 85%, and they miss different cases. The deterministic
backstops hold in every case, which is why the remaining misses are cosmetic: a calendar
link means `booking_offered` and an opt-out terminates the run regardless of what any
model called the sender.

---

## Known gaps

- Inbound is polled rather than webhook-driven. `POST /api/inbound/:provider` exists and
  dedupes, but the GHL workflow webhook is not wired.
- Email and web-form channels are stubs behind the same interface. SMS is the only
  implemented transport.
- The sub-account used for development has its own live automation in it, which is why
  polling is scoped to a run's own conversation and history is primed as already-seen
  before the first turn.
- Three calibration cases still miss, all conservative (human read as `ai_agent`, never
  the reverse). They are recorded in the fixture with notes.

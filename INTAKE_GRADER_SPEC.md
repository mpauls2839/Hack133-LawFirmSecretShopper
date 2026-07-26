# Intake Grader — Build Spec

Build a system that audits how service businesses handle inbound customer inquiries. Paste a business URL, and the system works out how to contact them, opens a conversation as a fabricated but realistic prospective customer, keeps working that conversation through autoresponders and AI bots until it reaches a real human or a booked meeting, then produces a scorecard.

Target: working end to end demo in one day. Prefer the shortest path that runs. Cut scope from the bottom of the build order, never from the middle.

---

## 0. Before writing any code

Run these and read the output. Do not guess flags.

```bash
npm install -g maritime-cli        # requires Node 18+
maritime guide --json              # live manifest of every command and flag
maritime templates                 # available agent templates
```

`maritime guide --json` exists specifically so an AI agent can drive the CLI without drift. Use it as the source of truth over anything in this document.

Auth for non-interactive use:

```bash
maritime keys create --name intake-grader --json    # returns mk_...
export MARITIME_TOKEN=mk_xxxxxxxxxxxx
```

Every CLI command takes `--json`. On success one JSON value goes to stdout with stderr empty. On failure one `{ ok: false, error: { code, message } }` goes to stderr with stdout empty. Exit codes: 0 success, 1 generic, 2 auth, 3 not found, 4 usage. Branch on exit code, never on string matching.

---

## 1. Architecture

Three pieces. Keep them separate.

**Router (always on).** One small service. Owns the database, receives inbound message events, resolves them to a run, wakes the right persona agent, persists state. Also serves the scorecard UI. Deploy as a Maritime agent with a public URL:

```bash
maritime create intake-router --repo https://github.com/<you>/intake-grader \
  --public --port 3000 --always-on
```

`--always-on` matters. Default agents auto-sleep, and a sleeping webhook receiver drops events.

**Persona agents (sleeping).** One agent per run. Each holds its persona, its target, and its transcript. Sleeps between turns, wakes in roughly 840ms from a VM snapshot when the router messages it. Compute bills only while awake.

**Judge.** Two open-weight models called through Maritime's OpenAI compatible LLM proxy at `https://api.maritime.sh/api/llm/v1`. Maritime injects a per-agent proxy token, so standard OpenAI style env vars work unchanged.

---

## 2. The one thing that changes the whole design

Maritime ships a template called `openclaw_identity`: OpenClaw with a phone number and email attached via Inkbox.

That means each persona agent can own its own phone number and email address. Consequences:

- Routing is solved. Inbound messages arrive at the agent that owns that number. No shared-number correlation, no conversation-id lookup table, no plus-addressing hacks.
- The second-number problem is solved. The persona has a real sending identity that is not your CRM number.
- Per-run isolation is structural. Thirty fabricated identities cannot bleed into each other because they are thirty micro-VMs.

Build on `openclaw_identity` as the persona template. Verify per-agent number provisioning early, in the first hour, because everything downstream assumes it. If it does not work, fall back to a single shared number plus a `contact_id` correlation table, and say so in the README.

---

## 3. Data model

```
target
  id, url, name, category, city
  phones[]      { number, line_type: mobile|landline|voip|unknown, sms_capable }
  emails[]
  form          { url, fields[], captcha: bool }
  chat_widget   vendor | null
  stated_hours  free text ("open 24 hours", "9-5 M-F")
  services[]    from site copy, drives qualification
  reachable     bool
  unreachable_reason  string | null

persona
  id, name, contact_details, backstory, need, urgency, budget
  behavior_rules  when to answer, when to push, when to go quiet

run
  id, target_id, persona_id, channel
  qualified          bool, derived, not hand-tagged
  agent_name         maritime agent for this run
  state              see section 5
  t0                 first contact timestamp
  transcript[]       { direction, body, ts, sender_type, flags }
  promise            { made_at, stated_window, kept: bool|null }
  terminal_reason
  scorecard          json
```

---

## 4. Pipeline

### 4.1 Ingest

Fetch the homepage and `/contact-us` (or whatever the nav links to). Two pages only, no crawler.

Extract deterministically where possible:
- `tel:` hrefs for phones
- `mailto:` hrefs for emails
- `<form>` action and inputs, plus presence of any recaptcha/hcaptcha/turnstile script
- footer text for hours

Use the model only for the fuzzy part: read the page copy and return the services list plus a normalized business category.

### 4.2 Channel capability check

For each phone, look up line type before attempting SMS. Landlines silently eat texts and you will waste an hour. If a lookup provider is not wired, attempt once and treat the carrier error as the verdict, then cache it.

Set `reachable = false` when there is no SMS-capable number, no email, and the form is CAPTCHA gated. Do not solve CAPTCHAs. `UNREACHABLE` is a legitimate and interesting result: a business advertising 24/7 availability with no asynchronous channel is a real finding, and it goes in the report.

### 4.3 Qualification

Compare persona need against `target.services`. Qualified or unqualified falls out automatically. This is why a pasted URL is enough: one paste gives you the target and its correct label. The same persona against a different business flips the label for free, so three personas against ten targets yields thirty labeled cells with no manual tagging.

### 4.4 First contact

Pick the best usable channel: SMS-capable number, then email, then ungated form. Send. Stamp `t0`. Agent sleeps.

### 4.5 The turn loop

1. Inbound event hits the router (webhook from the channel, or the persona agent's own trigger).
2. Router resolves the run and wakes the agent:
   ```bash
   maritime chat <agent> "<inbound message>" --conversation-id <run_id> --json
   ```
3. Agent classifies the sender, decides continue or terminate, and returns structured output (section 6).
4. Router applies the state transition, waits a randomized 2 to 5 minutes, sends the reply, persists, done.
5. Nothing runs until the next inbound event.

Hard caps: 12 turns, 72 hours wall clock.

### 4.6 Sweeper

Cron trigger every 10 to 15 minutes. Handles everything the inbound path cannot:

- Silence past threshold, and no nudge sent yet, send nudge. Max 2 nudges.
- Silence past cutoff, close as `NO_RESPONSE`.
- Turn cap hit, close as `STALLED`.
- Promise timer expired, mark `promise.kept = false`.

Business hours aware. An 11pm inquiry answered at 9am is not a slow business, and raw elapsed time will libel them. Compute both raw elapsed and business-hours elapsed, and grade on the second unless the business advertises 24/7, in which case grade on the first. Grading a business against its own marketing claim is the most defensible thing this system does.

### 4.7 Cleanup

Cancel anything booked. Send a short closing message. Never sign anything, never accept a retainer.

---

## 5. States

```
CREATED -> CONTACTED -> AWAITING_REPLY -> IN_CONVERSATION -> <terminal> -> GRADED -> CLEANED_UP
```

Terminal states, ordered best to worst. This ladder is the product, not a pass/fail bit.

1. `BOOKED_WITH_SPECIALIST` — meeting scheduled with someone who handles this matter
2. `BOOKED_GENERIC` — meeting scheduled, specialist unconfirmed
3. `HUMAN_SPECIALIST` — live human, right person, no booking
4. `HUMAN_GENERIC` — live human, wrong person or gatekeeper only
5. `PROMISE_KEPT` — callback promised and it actually arrived in the stated window
6. `PROMISE_BROKEN` — callback promised, never arrived
7. `BOT_LOOP` — never escaped the automation
8. `DEFLECTED` — correctly declined or referred elsewhere (this is the *correct* outcome for an unqualified persona)
9. `NO_RESPONSE`
10. `UNREACHABLE` — no usable channel existed

`PROMISE_BROKEN` must be distinguishable from `NO_RESPONSE`. Businesses that promise and vanish are the most damning finding available and the design has to separate them.

---

## 6. Judge

Two tiers. Do not use one model for both.

**Tier 1, per inbound message, small and fast.** Gemma 4 12B or Qwen3.6-27B. Both run on a single 24GB card or hosted cheaply. Strict JSON, no prose:

```json
{
  "sender_type": "autoresponder | ai_agent | human",
  "flags": {
    "price_given": false,
    "question_answered": false,
    "meeting_offered": false,
    "booking_link": false,
    "callback_promised": false,
    "promised_window": null,
    "specialist_identified": false,
    "specialist_role": null
  },
  "next_state": "IN_CONVERSATION",
  "reply": "text to send, or null if terminating"
}
```

**Tier 2, once at terminal, stronger model.** GLM-5.2 is the strongest all-round open-weight model as of July 2026 (MIT licensed, 744B MoE, GPQA Diamond 91.2, SWE-bench Pro 62.1). DeepSeek V4 is the cheaper alternative with a 1M context window. Reads the full transcript, emits the scorecard plus a two sentence narrative.

Note: Kimi K3 (2.8T MoE, released July 16) benchmarks above both, but weights do not ship until July 27, so it is not deployable today. Leave the model name in an env var so it can be swapped without a code change.

**Deterministic backstops.** Cheaper and more reliable than any model. Compute these in code, not in a prompt:
- Calendar link present in body implies `meeting_offered` and `booking_link`
- Reply body identical or near-identical to a previous reply implies `autoresponder`
- Every latency number comes from timestamps, never from the model
- Regex for a stated callback window ("within 24 hours", "shortly", "today")

Model output and deterministic checks disagree? Deterministic wins.

**Calibration, do not skip.** Hand label 20 inbound messages for `sender_type` before trusting tier 1. Ten minutes of work, and it is the difference between a scorecard and a random number generator. Store the labeled set as a fixture and assert against it in a test.

---

## 7. Scorecard

Per run:
- time to first reply (raw and business hours)
- time to first human
- time to booking offer
- turns spent in automation before a human appeared
- sender type of first reply
- question answered, price disclosed, follow-up count
- promise made, promise kept
- terminal state
- screening verdict: correct or incorrect given `qualified`

The screening verdict is a confusion matrix, not a pass/fail:

| | reached human or booked | never handled |
|---|---|---|
| qualified persona | correct | miss, expensive |
| unqualified persona | wasted time, mild fail | correct |

Keep two scores separate and never merge them. **Harness score**: did the agent complete its mission. **Business score**: did the business behave correctly. An unqualified persona that books a meeting is a harness success and a business failure.

---

## 8. Maritime commands you will actually use

```bash
# persona fleet, 2 to 50 agents in one call, $1 wallet each up front
maritime create persona --template openclaw_identity --count 10 --json

# template a tuned persona agent, then clone per run
maritime blueprint create persona-1 --name "injury-persona-v1" --visibility private
maritime blueprint deploy injury-persona-v1 --name run-0042

# wake and drive
maritime chat run-0042 "<inbound>" --conversation-id run-0042 --json

# secrets
maritime env set run-0042 PERSONA_JSON='...' TARGET_JSON='...'
maritime env reload run-0042

# what is wired to this agent
maritime triggers run-0042

# debugging
maritime logs run-0042 -f
maritime status run-0042
```

Fan out across a fleet with `maritime list --json | jq | xargs`.

---

## 9. Build order

Ship in this order. Each step must run before the next starts.

1. Verify `openclaw_identity` gives a per-agent phone number and email. First hour. Everything depends on it.
2. Ingest plus channel capability check. Test against 3 hardcoded URL fixtures.
3. Database, run table, state machine. No messaging yet, drive transitions with a test harness.
4. One full loop against your own mock business. Two configurations, one tuned well, one deliberately sloppy.
5. Tier 1 judge plus the 20 message calibration fixture.
6. Sweeper with timeouts and the promise timer.
7. Tier 2 judge and the scorecard.
8. Scorecard UI.

Cut list, in order: aggregate benchmark view, multi-channel fallback, WhatsApp, anything voice, and the UI down to a JSON dump.

Assign the UI to someone at the start. It is what is on screen at the end and it must not be the last thing anyone begins.

---

## 10. Demo

Do not let the demo depend on a stranger replying on time.

- Live on stage: one run against your own mock business, well-configured and sloppy side by side, state machine advancing in real time.
- Pre-collected: real runs started early in the day, shown as finished scorecards.
- Include at least one `UNREACHABLE` and one `PROMISE_BROKEN` in the deck of results. Those two are the findings people remember.

---

## 11. Guardrails, non-negotiable

- One inquiry per business per cycle. This is a measurement tool, not a load generator.
- Fictional persona names. Do not name real companies as counterparties. Law firms run conflict checks and log intake, and a fabricated matter naming a real defendant can pollute that record and affect a real case later.
- Never solve a CAPTCHA. Record it as `UNREACHABLE` and move on.
- Never sign anything, accept a retainer, or agree to terms.
- Close every conversation politely. Cancel every booking. Ghosting a receptionist who did their job well is the part that would sting if it were your business.
- No crisis-service targets. Intake lines with limited human capacity behind them are out of scope unless the organization asked to be audited.

---

## 12. Environment

```
MARITIME_TOKEN=mk_...
MARITIME_LLM_BASE=https://api.maritime.sh/api/llm/v1
JUDGE_FAST_MODEL=gemma-4-12b
JUDGE_DEEP_MODEL=glm-5.2
GHL_PIT=pit-...                # private integration token, all scopes
GHL_API_BASE=https://services.leadconnectorhq.com
GHL_API_VERSION=2021-07-28     # confirm per endpoint group, they differ
GHL_LOCATION_ID=...
ROUTER_PUBLIC_URL=...
```

GoHighLevel calls need the `Version` header on every request. Poll `/conversations` every 30 seconds for inbound rather than wiring workflow webhooks on day one, then swap to webhooks if time allows. Dedupe on message id, the same event can arrive twice.

---

## 13. Definition of done

- A pasted URL produces a contact profile with a reachability verdict.
- A run opens, survives at least three turns against a bot, and reaches a terminal state.
- The sweeper closes an abandoned run without anything long-running in memory.
- The scorecard separates harness success from business success.
- Tier 1 judge agrees with the hand-labeled fixture at least 80 percent of the time.
- One live run completes on stage without a human touching a keyboard.

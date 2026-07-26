# Hack133 — Law Firm Secret Shopper

Event-driven SMS secret-shopper agent. This repo implements the **event trigger lifecycle** for a single conversation:

1. CLI sends the initial SMS to a law firm.
2. Twilio inbound webhooks wake the Maritime-hosted service.
3. A provider-neutral decision boundary classifies booking links and drafts replies.
4. QStash delivers delayed send jobs and an exact 12-hour expiry job.
5. The conversation stops on **booking link detected** or **12-hour expiry**. Later inbound SMS is recorded and acknowledged with empty TwiML, but no reply is sent.

## Architecture

```
Law firm SMS → Twilio webhook → Maritime service (ack empty TwiML)
                              → SQLite persist
                              → QStash process-inbound
                              → Turn decider (stub/openai/anthropic)
                              → QStash delayed send-reply → Twilio REST
CLI start     → Twilio initial SMS + QStash expire-conversation @ 12h
```

## Quick start

```bash
npm install
cp .env.example .env
cp config/persona.example.json config/persona.json
# edit .env and config/persona.json
```

Required secrets in `.env`:

| Variable | Purpose |
|---|---|
| `PUBLIC_BASE_URL` | Public HTTPS URL of this service (Twilio + QStash callbacks) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | Twilio SMS |
| `QSTASH_TOKEN` / `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` | Durable wake-ups |
| `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL` | `stub` (default), `openai`, or `anthropic` |

### Run locally

```bash
npm run dev
```

Point Twilio's "A message comes in" webhook to:

```text
https://<your-public-url>/webhooks/twilio/sms
```

Start one conversation:

```bash
npm run start:conversation -- config/persona.json
```

### Deploy on Maritime

1. Set the same env vars as secrets in Maritime.
2. Deploy this Node service so it sleeps when idle.
3. Use the Maritime public URL as `PUBLIC_BASE_URL`.
4. Configure the Twilio webhook to that URL.
5. Run `npm run start:conversation` against the deployed database volume (or from a one-shot job that shares storage).

Twilio inbound SMS is what wakes the sleeping agent. QStash HTTP callbacks wake it for delayed replies and the 12-hour cutoff.

## HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness |
| `POST` | `/webhooks/twilio/sms` | Twilio inbound SMS (empty TwiML ack) |
| `POST` | `/jobs/process-inbound` | QStash: run turn decision |
| `POST` | `/jobs/send-reply` | QStash: send delayed SMS |
| `POST` | `/jobs/expire-conversation` | QStash: mark expired at TTL |

## Tests

```bash
npm test
npm run typecheck
```

## Manual smoke test

1. Set `REPLY_DELAY_SECONDS=5` and optionally `CONVERSATION_TTL_HOURS=0.05` (~3 minutes) for a short expiry drill.
2. Start the service and expose it publicly (Maritime or a tunnel).
3. Configure the Twilio webhook.
4. Run `npm run start:conversation -- config/persona.json`.
5. Reply from the target phone with a normal answer. Confirm the service wakes and sends a delayed reply.
6. Reply with a Calendly/Cal.com link. Confirm status becomes `goal_reached` and no further replies are sent.
7. Or wait for the short TTL, confirm status becomes `expired`, then send another SMS and confirm empty TwiML ack with no outbound reply.

## Out of scope (this slice)

- Persona prompt quality / authoring UX
- Silence-based follow-up campaigns
- WhatsApp
- Multi-conversation scale
- Dashboards / analytics

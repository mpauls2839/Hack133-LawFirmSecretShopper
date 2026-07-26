# Hack133 — Law Firm Secret Shopper

Always-on intake grader: paste a law firm URL, establish first contact (SMS or form), run a persona conversation, and score the firm's response.

## Quick start

```bash
cp .env.example .env
npm install
npx playwright install chromium
npm run dev
```

**Keys by mode**

| Mode | Secrets you need |
|------|------------------|
| Unit tests / mock loop | None |
| Front-door browser agent | One LLM key: `OPENAI_API_KEY` (or run inside Maritime, which injects it) |
| Live SMS | Same LLM key + `GHL_PIT`/`GHL_PRIVATE_TOKEN`, `GHL_LOCATION_ID`, `GHL_FROM_NUMBER`, then `ALLOW_LIVE_SENDS=true` and allowlist the domain |

QStash, `LLM_PROVIDER`, and `DATA_DIR` are unused on this branch. `GHL_PRIVATE_TOKEN` and `PUBLIC_BASE_URL` are accepted as aliases.

## Front-door agent

`POST /api/frontdoor` with `{ "url": "https://www.hickeylawfirm.com/" }` runs a Playwright MCP browser agent that:

1. **Prefers** submitting the firm's intake form with our receiving number (`FRONTDOOR_INBOUND_NUMBER`, default `+17407614801`).
2. Attempts captchas when present and **submits live** (bypasses `ALLOW_LIVE_SENDS` / allowlist by design).
3. **Falls back** to discovering a firm phone to text when the form cannot be submitted.
4. Opens a run automatically:
   - Form path → await-inbound run (system waits for the firm to text us).
   - SMS path → queues first contact to the discovered number (still gated by `ALLOW_LIVE_SENDS` + allowlist for the actual SMS).

```bash
curl -s localhost:3000/api/frontdoor \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.hickeylawfirm.com/"}' | jq .
```

Simulate a firm reply after a form submission:

```bash
curl -s localhost:3000/api/inbound/mock \
  -H 'content-type: application/json' \
  -d '{"provider_id":"sim1","from":"+13055551212","to":"+17407614801","body":"Hi Dana, thanks for reaching out — when was the accident?"}'
```

## Other endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Adapter, judge, frontdoor status |
| POST | `/api/targets` | HTTP ingest only (no browser) |
| POST | `/api/runs` | Open a conversation run |
| POST | `/api/inbound/:provider` | Webhook / simulated inbound |
| GET | `/api/frontdoor/awaiting` | Path B queue depth |

## Safety

Outbound SMS still requires `ALLOW_LIVE_SENDS=true` and the domain on `config/allowlist.txt`. Front-door **form submission** intentionally does not. Use mock adapter (`DEFAULT_CHANNEL_DRIVER=mock`) for local demos.

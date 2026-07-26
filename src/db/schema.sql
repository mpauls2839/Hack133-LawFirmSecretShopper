-- Intake Grader schema. Router owns all durable state (spec improvement #5:
-- persona agents are stateless executors, this DB is the source of truth).
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
  id                 TEXT PRIMARY KEY,
  url                TEXT NOT NULL,
  domain             TEXT NOT NULL,
  name               TEXT,
  category           TEXT,
  city               TEXT,
  timezone           TEXT NOT NULL DEFAULT 'America/New_York',
  services_json      TEXT NOT NULL DEFAULT '[]',
  stated_hours_text  TEXT,
  hours_json         TEXT NOT NULL DEFAULT '[]',
  hours_confidence   TEXT NOT NULL DEFAULT 'none',   -- none|low|high
  claims_247         INTEGER NOT NULL DEFAULT 0,
  chat_widget        TEXT,                            -- vendor or NULL
  form_json          TEXT,                            -- { url, fields[], captcha }
  reachable          INTEGER NOT NULL DEFAULT 0,
  unreachable_reason TEXT,
  ingest_notes_json  TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_domain ON targets(domain);

CREATE TABLE IF NOT EXISTS target_phones (
  id         TEXT PRIMARY KEY,
  target_id  TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  number     TEXT NOT NULL,
  line_type  TEXT NOT NULL DEFAULT 'unknown',        -- mobile|landline|voip|unknown
  sms_capable INTEGER,                               -- NULL = unchecked
  checked_at TEXT,
  source     TEXT NOT NULL DEFAULT 'tel_href',
  UNIQUE(target_id, number)
);

CREATE TABLE IF NOT EXISTS target_emails (
  id        TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  email     TEXT NOT NULL,
  source    TEXT NOT NULL DEFAULT 'mailto_href',
  UNIQUE(target_id, email)
);

CREATE TABLE IF NOT EXISTS personas (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  contact_json        TEXT NOT NULL,                 -- { email, phone, preferred_channel }
  backstory           TEXT NOT NULL,
  case_facts          TEXT NOT NULL DEFAULT '',
  need                TEXT NOT NULL,
  need_tags_json      TEXT NOT NULL DEFAULT '[]',    -- drives qualification (spec 4.3)
  urgency             TEXT NOT NULL,
  budget              TEXT NOT NULL,
  behavior_rules_json TEXT NOT NULL DEFAULT '{}',
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id                  TEXT PRIMARY KEY,
  target_id           TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  persona_id          TEXT NOT NULL REFERENCES personas(id),
  cycle               TEXT NOT NULL,                 -- one inquiry per business per cycle
  channel             TEXT,                          -- sms|email|form|mock
  channel_address     TEXT,                          -- number / email / form url actually used
  qualified           INTEGER NOT NULL DEFAULT 0,
  qualification_reason TEXT,
  agent_name          TEXT,
  live                INTEGER NOT NULL DEFAULT 0,    -- 1 only when a real send left the box
  -- Transport correlation, persisted rather than held in memory: the router is long-lived
  -- and a restart must not orphan an open conversation. This is the shared-number
  -- fallback's routing key, since per-agent identities are unavailable.
  provider            TEXT,
  provider_contact_id TEXT,
  provider_conversation_id TEXT,
  state               TEXT NOT NULL,                 -- lifecycle: CREATED..CLEANED_UP
  terminal_state      TEXT,                          -- outcome ladder, survives GRADED/CLEANED_UP
  terminal_reason     TEXT,
  t0                  TEXT,
  last_inbound_at     TEXT,
  last_outbound_at    TEXT,
  turns               INTEGER NOT NULL DEFAULT 0,
  nudges_sent         INTEGER NOT NULL DEFAULT 0,
  first_reply_at      TEXT,
  first_reply_sender  TEXT,
  first_human_at      TEXT,
  booking_offered_at  TEXT,
  turns_in_automation INTEGER,
  promise_made_at     TEXT,
  promise_window_text TEXT,
  promise_deadline    TEXT,
  promise_kept        INTEGER,                       -- NULL unresolved / 0 broken / 1 kept
  -- Details the persona had to invent because the brief did not cover them. Persisted so
  -- the same answer is given every time it is asked; contradicting yourself is the tell.
  improvised_facts_json TEXT NOT NULL DEFAULT '{}',
  scorecard_json      TEXT,
  narrative           TEXT,
  locked_at           TEXT,                          -- single-writer lock (spec improvement #3)
  closed_at           TEXT,
  cleanup_state       TEXT NOT NULL DEFAULT 'not_needed', -- not_needed|pending|done|failed
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
-- Guardrail as a constraint, not a convention: one open inquiry per business per cycle.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_per_target_cycle ON runs(target_id, cycle);
CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
-- Inbound routing lookups. A webhook arrives knowing a contact or conversation, not a run.
CREATE INDEX IF NOT EXISTS idx_runs_provider_contact ON runs(provider_contact_id);
CREATE INDEX IF NOT EXISTS idx_runs_provider_conversation ON runs(provider_conversation_id);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  direction    TEXT NOT NULL,                        -- in|out
  body         TEXT NOT NULL,
  ts           TEXT NOT NULL,
  sender_type  TEXT,                                 -- autoresponder|ai_agent|human|persona
  flags_json   TEXT,
  classifier   TEXT,                                 -- which driver produced sender_type
  provider     TEXT,
  provider_id  TEXT,                                 -- dedupe key, same event can arrive twice
  kind         TEXT,                                 -- first_contact|reply|nudge|closing
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_provider_id
  ON messages(provider, provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id, ts);

-- Outbound never sleeps in memory (spec improvement #4): delay is a row, sweeper drains it.
CREATE TABLE IF NOT EXISTS send_queue (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                         -- first_contact|reply|nudge|closing
  body        TEXT NOT NULL,
  send_after  TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending',       -- pending|sent|failed|cancelled
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  provider_id TEXT,
  created_at  TEXT NOT NULL,
  sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_send_queue_due ON send_queue(state, send_after);

-- Append-only. Every outbound attempt and every state change lands here.
CREATE TABLE IF NOT EXISTS event_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  run_id    TEXT,
  type      TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_event_log_run ON event_log(run_id, id);

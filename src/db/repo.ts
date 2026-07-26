import { db, id, nowIso, logEvent } from './index.ts';
import { assertTransition, isOutcome } from '../domain/states.ts';
import type {
  Direction,
  Flags,
  FormProfile,
  HoursWindow,
  Message,
  MessageKind,
  Persona,
  Phone,
  Run,
  Scorecard,
  SenderType,
  Target,
} from '../domain/types.ts';

const j = (v: unknown): string => JSON.stringify(v ?? null);
const p = <T>(s: string | null | undefined, dflt: T): T => {
  if (!s) return dflt;
  try {
    return JSON.parse(s) as T;
  } catch {
    return dflt;
  }
};

// ---------------------------------------------------------------- targets ---

export type TargetInput = {
  url: string;
  domain: string;
  name?: string | null;
  category?: string | null;
  city?: string | null;
  timezone: string;
  services: string[];
  stated_hours_text?: string | null;
  hours: HoursWindow[];
  hours_confidence: Target['hours_confidence'];
  claims_247: boolean;
  chat_widget?: string | null;
  form?: FormProfile | null;
  reachable: boolean;
  unreachable_reason?: string | null;
  ingest_notes: string[];
  phones: Array<Pick<Phone, 'number' | 'line_type' | 'sms_capable'> & { source?: string }>;
  emails: string[];
};

function hydrateTarget(row: any): Target {
  const phones = db()
    .prepare('SELECT * FROM target_phones WHERE target_id = ? ORDER BY rowid')
    .all(row.id) as any[];
  const emails = db()
    .prepare('SELECT email FROM target_emails WHERE target_id = ? ORDER BY rowid')
    .all(row.id) as Array<{ email: string }>;
  return {
    id: row.id,
    url: row.url,
    domain: row.domain,
    name: row.name,
    category: row.category,
    city: row.city,
    timezone: row.timezone,
    services: p<string[]>(row.services_json, []),
    stated_hours_text: row.stated_hours_text,
    hours: p<HoursWindow[]>(row.hours_json, []),
    hours_confidence: row.hours_confidence,
    claims_247: !!row.claims_247,
    chat_widget: row.chat_widget,
    form: p<FormProfile | null>(row.form_json, null),
    reachable: !!row.reachable,
    unreachable_reason: row.unreachable_reason,
    ingest_notes: p<string[]>(row.ingest_notes_json, []),
    phones: phones.map((f) => ({ ...f, sms_capable: f.sms_capable === null ? null : !!f.sms_capable })),
    emails: emails.map((e) => e.email),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const targets = {
  upsert(input: TargetInput): Target {
    const existing = db().prepare('SELECT * FROM targets WHERE domain = ?').get(input.domain) as any;
    const ts = nowIso();
    const targetId = existing?.id ?? id('tgt');
    const cols = {
      url: input.url,
      domain: input.domain,
      name: input.name ?? null,
      category: input.category ?? null,
      city: input.city ?? null,
      timezone: input.timezone,
      services_json: j(input.services),
      stated_hours_text: input.stated_hours_text ?? null,
      hours_json: j(input.hours),
      hours_confidence: input.hours_confidence,
      claims_247: input.claims_247 ? 1 : 0,
      chat_widget: input.chat_widget ?? null,
      form_json: input.form ? j(input.form) : null,
      reachable: input.reachable ? 1 : 0,
      unreachable_reason: input.unreachable_reason ?? null,
      ingest_notes_json: j(input.ingest_notes),
      updated_at: ts,
    };
    if (existing) {
      const set = Object.keys(cols).map((k) => `${k} = @${k}`).join(', ');
      db().prepare(`UPDATE targets SET ${set} WHERE id = @id`).run({ ...cols, id: targetId });
    } else {
      const keys = ['id', ...Object.keys(cols), 'created_at'];
      db()
        .prepare(
          `INSERT INTO targets (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`,
        )
        .run({ ...cols, id: targetId, created_at: ts });
    }

    db().prepare('DELETE FROM target_phones WHERE target_id = ?').run(targetId);
    const insPhone = db().prepare(
      'INSERT OR IGNORE INTO target_phones (id, target_id, number, line_type, sms_capable, checked_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const phone of input.phones) {
      insPhone.run(
        id('ph'),
        targetId,
        phone.number,
        phone.line_type,
        phone.sms_capable === null || phone.sms_capable === undefined ? null : phone.sms_capable ? 1 : 0,
        phone.sms_capable === null || phone.sms_capable === undefined ? null : ts,
        phone.source ?? 'tel_href',
      );
    }
    db().prepare('DELETE FROM target_emails WHERE target_id = ?').run(targetId);
    const insEmail = db().prepare(
      'INSERT OR IGNORE INTO target_emails (id, target_id, email, source) VALUES (?, ?, ?, ?)',
    );
    for (const email of input.emails) insEmail.run(id('em'), targetId, email, 'mailto_href');

    return hydrateTarget(db().prepare('SELECT * FROM targets WHERE id = ?').get(targetId));
  },

  get(targetId: string): Target | null {
    const row = db().prepare('SELECT * FROM targets WHERE id = ?').get(targetId) as any;
    return row ? hydrateTarget(row) : null;
  },

  byDomain(domain: string): Target | null {
    const row = db().prepare('SELECT * FROM targets WHERE domain = ?').get(domain) as any;
    return row ? hydrateTarget(row) : null;
  },

  list(): Target[] {
    return (db().prepare('SELECT * FROM targets ORDER BY created_at DESC').all() as any[]).map(
      hydrateTarget,
    );
  },

  setReachability(targetId: string, reachable: boolean, reason: string | null, notes: string[]): void {
    db()
      .prepare(
        'UPDATE targets SET reachable = ?, unreachable_reason = ?, ingest_notes_json = ?, updated_at = ? WHERE id = ?',
      )
      .run(reachable ? 1 : 0, reason, j(notes), nowIso(), targetId);
  },

  setPhoneCapability(phoneId: string, lineType: string, smsCapable: boolean): void {
    db()
      .prepare('UPDATE target_phones SET line_type = ?, sms_capable = ?, checked_at = ? WHERE id = ?')
      .run(lineType, smsCapable ? 1 : 0, nowIso(), phoneId);
  },
};

// --------------------------------------------------------------- personas ---

function hydratePersona(row: any): Persona {
  return {
    id: row.id,
    name: row.name,
    contact: p(row.contact_json, { email: '', phone: '', preferred_channel: 'mock' as const }),
    backstory: row.backstory,
    need: row.need,
    need_tags: p<string[]>(row.need_tags_json, []),
    case_facts: row.case_facts ?? '',
    urgency: row.urgency,
    budget: row.budget,
    behavior_rules: p(row.behavior_rules_json, {
      answer_when: [],
      push_when: [],
      go_quiet_when: [],
      never: [],
    }),
  };
}

export const personas = {
  upsert(persona: Persona): Persona {
    db()
      .prepare(
        `INSERT INTO personas (id, name, contact_json, backstory, case_facts, need, need_tags_json, urgency, budget, behavior_rules_json, active, created_at)
         VALUES (@id, @name, @contact_json, @backstory, @case_facts, @need, @need_tags_json, @urgency, @budget, @behavior_rules_json, 1, @created_at)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, contact_json = excluded.contact_json, backstory = excluded.backstory,
           case_facts = excluded.case_facts,
           need = excluded.need, need_tags_json = excluded.need_tags_json, urgency = excluded.urgency,
           budget = excluded.budget, behavior_rules_json = excluded.behavior_rules_json`,
      )
      .run({
        id: persona.id,
        name: persona.name,
        contact_json: j(persona.contact),
        backstory: persona.backstory,
        case_facts: persona.case_facts ?? '',
        need: persona.need,
        need_tags_json: j(persona.need_tags),
        urgency: persona.urgency,
        budget: persona.budget,
        behavior_rules_json: j(persona.behavior_rules),
        created_at: nowIso(),
      });
    return personas.get(persona.id)!;
  },

  get(personaId: string): Persona | null {
    const row = db().prepare('SELECT * FROM personas WHERE id = ?').get(personaId) as any;
    return row ? hydratePersona(row) : null;
  },

  list(): Persona[] {
    return (db().prepare('SELECT * FROM personas WHERE active = 1 ORDER BY created_at').all() as any[]).map(
      hydratePersona,
    );
  },

  /** Single fixed persona for now; the table is here so a fleet can land later. */
  fixed(): Persona | null {
    return personas.list()[0] ?? null;
  },
};

// ------------------------------------------------------------------- runs ---

function hydrateRun(row: any): Run {
  return {
    id: row.id,
    target_id: row.target_id,
    persona_id: row.persona_id,
    cycle: row.cycle,
    channel: row.channel,
    channel_address: row.channel_address,
    qualified: !!row.qualified,
    qualification_reason: row.qualification_reason,
    agent_name: row.agent_name,
    live: !!row.live,
    provider: row.provider,
    provider_contact_id: row.provider_contact_id,
    provider_conversation_id: row.provider_conversation_id,
    state: row.state,
    terminal_state: row.terminal_state,
    terminal_reason: row.terminal_reason,
    t0: row.t0,
    last_inbound_at: row.last_inbound_at,
    last_outbound_at: row.last_outbound_at,
    turns: row.turns,
    nudges_sent: row.nudges_sent,
    first_reply_at: row.first_reply_at,
    first_reply_sender: row.first_reply_sender,
    first_human_at: row.first_human_at,
    booking_offered_at: row.booking_offered_at,
    turns_in_automation: row.turns_in_automation,
    promise_made_at: row.promise_made_at,
    promise_window_text: row.promise_window_text,
    promise_deadline: row.promise_deadline,
    promise_kept: row.promise_kept === null ? null : !!row.promise_kept,
    improvised_facts: p<Record<string,string>>(row.improvised_facts_json, {}),
    scorecard: p<Scorecard | null>(row.scorecard_json, null),
    narrative: row.narrative,
    closed_at: row.closed_at,
    cleanup_state: row.cleanup_state,
    created_at: row.created_at,
    updated_at: row.updated_at,
  } as Run;
}

export type RunPatch = Partial<{
  channel: string | null;
  channel_address: string | null;
  agent_name: string | null;
  live: boolean;
  provider: string | null;
  provider_contact_id: string | null;
  provider_conversation_id: string | null;
  terminal_state: string | null;
  terminal_reason: string | null;
  t0: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  turns: number;
  nudges_sent: number;
  first_reply_at: string | null;
  first_reply_sender: string | null;
  first_human_at: string | null;
  booking_offered_at: string | null;
  turns_in_automation: number | null;
  promise_made_at: string | null;
  promise_window_text: string | null;
  promise_deadline: string | null;
  promise_kept: boolean | null;
  improvised_facts: Record<string, string>;
  scorecard: Scorecard | null;
  narrative: string | null;
  closed_at: string | null;
  cleanup_state: string;
  qualified: boolean;
  qualification_reason: string | null;
}>;

const RUN_COLUMN: Record<string, string> = { scorecard: 'scorecard_json', improvised_facts: 'improvised_facts_json' };

function applyPatch(runId: string, patch: RunPatch): void {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets: string[] = [];
  const params: Record<string, unknown> = { run_id: runId, updated_at: nowIso() };
  for (const [key, value] of entries) {
    sets.push(`${RUN_COLUMN[key] ?? key} = @${key}`);
    if (key === 'scorecard' || key === 'improvised_facts') params[key] = value === null ? null : JSON.stringify(value);
    else if (typeof value === 'boolean') params[key] = value ? 1 : 0;
    else params[key] = value;
  }
  db()
    .prepare(`UPDATE runs SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @run_id`)
    .run(params);
}

export class RunBusy extends Error {
  constructor(runId: string) {
    super(`run ${runId} is locked by another worker`);
    this.name = 'RunBusy';
  }
}

const LOCK_STALE_MS = 120_000;

export const runs = {
  create(input: {
    target_id: string;
    persona_id: string;
    cycle: string;
    qualified: boolean;
    qualification_reason: string;
    agent_name?: string | null;
  }): Run {
    const runId = id('run');
    const ts = nowIso();
    db()
      .prepare(
        `INSERT INTO runs (id, target_id, persona_id, cycle, qualified, qualification_reason, agent_name, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?)`,
      )
      .run(
        runId,
        input.target_id,
        input.persona_id,
        input.cycle,
        input.qualified ? 1 : 0,
        input.qualification_reason,
        input.agent_name ?? null,
        ts,
        ts,
      );
    logEvent(runId, 'run_created', { target_id: input.target_id, cycle: input.cycle });
    return runs.get(runId)!;
  },

  get(runId: string): Run | null {
    const row = db().prepare('SELECT * FROM runs WHERE id = ?').get(runId) as any;
    return row ? hydrateRun(row) : null;
  },

  openForTarget(targetId: string, cycle: string): Run | null {
    const row = db()
      .prepare('SELECT * FROM runs WHERE target_id = ? AND cycle = ?')
      .get(targetId, cycle) as any;
    return row ? hydrateRun(row) : null;
  },

  list(): Run[] {
    return (db().prepare('SELECT * FROM runs ORDER BY created_at DESC').all() as any[]).map(hydrateRun);
  },

  /**
   * Inbound routing. A webhook knows a contact or a conversation, never a run id, so the
   * binding has to be resolvable from the database rather than from process memory —
   * otherwise a router restart orphans every conversation already in flight.
   *
   * Open runs win over closed ones: the same business texted in a later cycle should not
   * resolve to last week's finished run.
   */
  byProviderIds(ids: { conversationId?: string | null; contactId?: string | null }): Run | null {
    const openFirst = "ORDER BY CASE WHEN state IN ('TERMINAL','GRADED','CLEANED_UP') THEN 1 ELSE 0 END, created_at DESC";
    if (ids.conversationId) {
      const row = db()
        .prepare(`SELECT * FROM runs WHERE provider_conversation_id = ? ${openFirst} LIMIT 1`)
        .get(ids.conversationId) as any;
      if (row) return hydrateRun(row);
    }
    if (ids.contactId) {
      const row = db()
        .prepare(`SELECT * FROM runs WHERE provider_contact_id = ? ${openFirst} LIMIT 1`)
        .get(ids.contactId) as any;
      if (row) return hydrateRun(row);
    }
    return null;
  },

  /** Runs still capable of receiving inbound, used to scope polling. */
  active(): Run[] {
    return runs.inStates(['CREATED', 'CONTACTED', 'AWAITING_REPLY', 'IN_CONVERSATION']);
  },

  inStates(states: string[]): Run[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => '?').join(', ');
    return (
      db().prepare(`SELECT * FROM runs WHERE state IN (${placeholders})`).all(...states) as any[]
    ).map(hydrateRun);
  },

  patch(runId: string, patch: RunPatch): Run {
    applyPatch(runId, patch);
    return runs.get(runId)!;
  },

  /**
   * Guarded lifecycle move. Illegal edges throw instead of silently corrupting a run,
   * which is what keeps a webhook and the sweeper from racing a run into nonsense.
   */
  transition(runId: string, to: string, patch: RunPatch = {}): Run {
    const current = runs.get(runId);
    if (!current) throw new Error(`run ${runId} not found`);
    if (current.state === to && to !== 'AWAITING_REPLY' && to !== 'IN_CONVERSATION') {
      return runs.patch(runId, patch);
    }
    assertTransition(current.state, to);
    if (to === 'TERMINAL') {
      const outcome = patch.terminal_state ?? current.terminal_state;
      if (!isOutcome(outcome)) throw new Error(`TERMINAL requires a valid terminal_state, got ${outcome}`);
      patch = { closed_at: nowIso(), ...patch };
    }
    applyPatch(runId, { ...patch });
    db().prepare('UPDATE runs SET state = ?, updated_at = ? WHERE id = ?').run(to, nowIso(), runId);
    logEvent(runId, 'state_change', { from: current.state, to, terminal_state: patch.terminal_state ?? null });
    return runs.get(runId)!;
  },

  /** Single-writer lock per run. Stale locks expire so a crash cannot wedge a run. */
  async withLock<T>(runId: string, fn: (run: Run) => Promise<T> | T): Promise<T> {
    const ts = nowIso();
    const cutoff = new Date(Date.now() - LOCK_STALE_MS).toISOString();
    const res = db()
      .prepare(
        'UPDATE runs SET locked_at = ? WHERE id = ? AND (locked_at IS NULL OR locked_at < ?)',
      )
      .run(ts, runId, cutoff);
    if (res.changes === 0) throw new RunBusy(runId);
    try {
      const run = runs.get(runId);
      if (!run) throw new Error(`run ${runId} not found`);
      return await fn(run);
    } finally {
      db().prepare('UPDATE runs SET locked_at = NULL WHERE id = ?').run(runId);
    }
  },
};

// --------------------------------------------------------------- messages ---

function hydrateMessage(row: any): Message {
  return {
    id: row.id,
    run_id: row.run_id,
    direction: row.direction,
    body: row.body,
    ts: row.ts,
    sender_type: row.sender_type,
    flags: p<Flags | null>(row.flags_json, null),
    classifier: row.classifier,
    provider: row.provider,
    provider_id: row.provider_id,
    kind: row.kind,
  };
}

export const messages = {
  /**
   * Returns `{ inserted: false }` when the provider replays an event we already stored.
   * Dedupe is a unique index, not a hope.
   */
  add(input: {
    run_id: string;
    direction: Direction;
    body: string;
    ts?: string;
    sender_type?: SenderType | null;
    flags?: Flags | null;
    classifier?: string | null;
    provider?: string | null;
    provider_id?: string | null;
    kind?: MessageKind | null;
  }): { inserted: boolean; message: Message } {
    if (input.provider_id) {
      const dupe = db()
        .prepare('SELECT * FROM messages WHERE provider = ? AND provider_id = ?')
        .get(input.provider ?? null, input.provider_id) as any;
      if (dupe) return { inserted: false, message: hydrateMessage(dupe) };
    }
    const msgId = id('msg');
    const ts = input.ts ?? nowIso();
    db()
      .prepare(
        `INSERT INTO messages (id, run_id, direction, body, ts, sender_type, flags_json, classifier, provider, provider_id, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msgId,
        input.run_id,
        input.direction,
        input.body,
        ts,
        input.sender_type ?? null,
        input.flags ? j(input.flags) : null,
        input.classifier ?? null,
        input.provider ?? null,
        input.provider_id ?? null,
        input.kind ?? null,
        nowIso(),
      );
    return { inserted: true, message: hydrateMessage(db().prepare('SELECT * FROM messages WHERE id = ?').get(msgId)) };
  },

  forRun(runId: string): Message[] {
    return (
      db().prepare('SELECT * FROM messages WHERE run_id = ? ORDER BY ts, rowid').all(runId) as any[]
    ).map(hydrateMessage);
  },

  lastOutbound(runId: string): Message | null {
    const row = db()
      .prepare("SELECT * FROM messages WHERE run_id = ? AND direction = 'out' ORDER BY ts DESC, rowid DESC LIMIT 1")
      .get(runId) as any;
    return row ? hydrateMessage(row) : null;
  },

  /** Writes back what the judge perceived, on the message it belongs to. */
  setJudgement(messageId: string, senderType: SenderType, flags: Flags, classifier: string): void {
    db()
      .prepare('UPDATE messages SET sender_type = ?, flags_json = ?, classifier = ? WHERE id = ?')
      .run(senderType, j(flags), classifier, messageId);
  },

  inboundBodies(runId: string): string[] {
    return (
      db()
        .prepare("SELECT body FROM messages WHERE run_id = ? AND direction = 'in' ORDER BY ts")
        .all(runId) as Array<{ body: string }>
    ).map((r) => r.body);
  },
};

// ------------------------------------------------------------- send queue ---

export type QueuedSend = {
  id: string;
  run_id: string;
  kind: MessageKind;
  body: string;
  send_after: string;
  state: 'pending' | 'sent' | 'failed' | 'cancelled';
  attempts: number;
  last_error: string | null;
};

export const sendQueue = {
  enqueue(input: { run_id: string; kind: MessageKind; body: string; delayMs: number }): QueuedSend {
    const qid = id('snd');
    const sendAfter = new Date(Date.now() + Math.max(0, input.delayMs)).toISOString();
    db()
      .prepare(
        'INSERT INTO send_queue (id, run_id, kind, body, send_after, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(qid, input.run_id, input.kind, input.body, sendAfter, 'pending', nowIso());
    logEvent(input.run_id, 'send_enqueued', { kind: input.kind, send_after: sendAfter });
    return sendQueue.get(qid)!;
  },

  get(qid: string): QueuedSend | null {
    return (db().prepare('SELECT * FROM send_queue WHERE id = ?').get(qid) as QueuedSend) ?? null;
  },

  due(limit = 25): QueuedSend[] {
    return db()
      .prepare("SELECT * FROM send_queue WHERE state = 'pending' AND send_after <= ? ORDER BY send_after LIMIT ?")
      .all(nowIso(), limit) as QueuedSend[];
  },

  /**
   * Atomically takes ownership of a queued send. Returns false if someone else already
   * has it.
   *
   * Two sweeps overlapping — the interval timer and a manually triggered one — both read
   * the same pending row and both sent it, so the business received the identical message
   * twice. Reading then sending is not safe; the claim has to be a conditional UPDATE.
   */
  claim(queueId: string): boolean {
    const res = db()
      .prepare("UPDATE send_queue SET state = 'sending', attempts = attempts + 1 WHERE id = ? AND state = 'pending'")
      .run(queueId);
    return res.changes === 1;
  },

  /** Hands an unsent claim back, so a crash mid-send does not strand the message. */
  release(queueId: string): void {
    db().prepare("UPDATE send_queue SET state = 'pending' WHERE id = ? AND state = 'sending'").run(queueId);
  },

  pendingForRun(runId: string): QueuedSend[] {
    return db()
      .prepare("SELECT * FROM send_queue WHERE run_id = ? AND state = 'pending'")
      .all(runId) as QueuedSend[];
  },

  /**
   * When the earliest pending send comes due.
   *
   * Lets the drain be scheduled for that exact instant instead of being discovered by the
   * next sweep tick, which otherwise adds up to a full interval of dead air to every reply.
   */
  nextDueAt(): string | null {
    const row = db()
      .prepare("SELECT send_after FROM send_queue WHERE state = 'pending' ORDER BY send_after LIMIT 1")
      .get() as { send_after: string } | undefined;
    return row?.send_after ?? null;
  },

  markSent(qid: string, providerId: string | null): void {
    db()
      .prepare("UPDATE send_queue SET state = 'sent', sent_at = ?, provider_id = ? WHERE id = ?")
      .run(nowIso(), providerId, qid);
  },

  markFailed(qid: string, error: string, retry: boolean): void {
    const next = new Date(Date.now() + 5 * 60_000).toISOString();
    if (retry) {
      db()
        .prepare("UPDATE send_queue SET state = 'pending', last_error = ?, send_after = ? WHERE id = ?")
        .run(error, next, qid);
    } else {
      db()
        .prepare("UPDATE send_queue SET state = 'failed', last_error = ? WHERE id = ?")
        .run(error, qid);
    }
  },

  cancelPending(runId: string, reason: string): number {
    const res = db()
      .prepare("UPDATE send_queue SET state = 'cancelled', last_error = ? WHERE run_id = ? AND state = 'pending'")
      .run(reason, runId);
    if (res.changes > 0) logEvent(runId, 'sends_cancelled', { reason, count: res.changes });
    return res.changes;
  },
};

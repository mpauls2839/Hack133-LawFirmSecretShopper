import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Conversation,
  ConversationSnapshot,
  ConversationStatus,
  Job,
  JobStatus,
  JobType,
  Message,
  MessageDirection,
} from "../domain/conversation.js";

export interface CreateConversationInput {
  campaignId: string;
  firmName: string;
  firmPhone: string;
  fromPhone: string;
  personaJson: string;
  startedAt: Date;
  expiresAt: Date;
}

export interface InsertMessageInput {
  conversationId: string;
  direction: MessageDirection;
  body: string;
  providerMessageId?: string | null;
  createdAt?: Date;
}

export interface InsertJobInput {
  conversationId: string;
  type: JobType;
  payload: unknown;
  externalId?: string | null;
}

export interface ConversationSummary {
  id: string;
  firmName: string;
  firmPhone: string;
  fromPhone: string;
  status: ConversationStatus;
  startedAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage: {
    body: string;
    direction: MessageDirection;
    createdAt: string;
  } | null;
}

export class ConversationStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        firm_name TEXT NOT NULL,
        firm_phone TEXT NOT NULL,
        from_phone TEXT NOT NULL,
        status TEXT NOT NULL,
        persona_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        stop_reason TEXT,
        booking_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        body TEXT NOT NULL,
        provider_message_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_provider_id
        ON messages(provider_message_id)
        WHERE provider_message_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        external_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_external_id
        ON jobs(external_id)
        WHERE external_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS processed_events (
        event_key TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
    `);
  }

  resetAll(): void {
    this.db.exec(`
      DELETE FROM jobs;
      DELETE FROM messages;
      DELETE FROM conversations;
      DELETE FROM processed_events;
    `);
  }

  createConversation(input: CreateConversationInput): Conversation {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: randomUUID(),
      campaignId: input.campaignId,
      firmName: input.firmName,
      firmPhone: input.firmPhone,
      fromPhone: input.fromPhone,
      status: "active",
      personaJson: input.personaJson,
      startedAt: input.startedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      stopReason: null,
      bookingUrl: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO conversations (
          id, campaign_id, firm_name, firm_phone, from_phone, status,
          persona_json, started_at, expires_at, stop_reason, booking_url,
          created_at, updated_at
        ) VALUES (
          @id, @campaignId, @firmName, @firmPhone, @fromPhone, @status,
          @personaJson, @startedAt, @expiresAt, @stopReason, @bookingUrl,
          @createdAt, @updatedAt
        )`,
      )
      .run(conversation);

    return conversation;
  }

  getActiveConversation(): Conversation | null {
    const row = this.db
      .prepare(`SELECT * FROM conversations WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`)
      .get();
    return row ? mapConversation(row as Record<string, unknown>) : null;
  }

  getLatestConversation(): Conversation | null {
    const row = this.db
      .prepare(`SELECT * FROM conversations ORDER BY created_at DESC LIMIT 1`)
      .get();
    return row ? mapConversation(row as Record<string, unknown>) : null;
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
    return row ? mapConversation(row as Record<string, unknown>) : null;
  }

  getConversationByPhones(firmPhone: string, fromPhone: string): Conversation | null {
    const row = this.db
      .prepare(
        `SELECT * FROM conversations
         WHERE firm_phone = ? AND from_phone = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(firmPhone, fromPhone);
    return row ? mapConversation(row as Record<string, unknown>) : null;
  }

  getSnapshot(conversationId: string): ConversationSnapshot | null {
    const conversation = this.getConversation(conversationId);
    if (!conversation) {
      return null;
    }
    const messages = this.listMessages(conversationId);
    return { conversation, messages };
  }

  getLatestSnapshot(): ConversationSnapshot | null {
    const conversation = this.getLatestConversation();
    if (!conversation) {
      return null;
    }
    return this.getSnapshot(conversation.id);
  }

  listConversationSummaries(): ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT
           c.id,
           c.firm_name,
           c.firm_phone,
           c.from_phone,
           c.status,
           c.started_at,
           c.updated_at,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
           (
             SELECT m.body FROM messages m
             WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC, m.rowid DESC
             LIMIT 1
           ) AS last_body,
           (
             SELECT m.direction FROM messages m
             WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC, m.rowid DESC
             LIMIT 1
           ) AS last_direction,
           (
             SELECT m.created_at FROM messages m
             WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC, m.rowid DESC
             LIMIT 1
           ) AS last_created_at
         FROM conversations c
         ORDER BY c.created_at DESC`,
      )
      .all();

    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      const lastBody = r.last_body == null ? null : String(r.last_body);
      const lastDirection = r.last_direction == null ? null : (r.last_direction as MessageDirection);
      const lastCreatedAt = r.last_created_at == null ? null : String(r.last_created_at);

      return {
        id: String(r.id),
        firmName: String(r.firm_name),
        firmPhone: String(r.firm_phone),
        fromPhone: String(r.from_phone),
        status: r.status as ConversationStatus,
        startedAt: String(r.started_at),
        updatedAt: String(r.updated_at),
        messageCount: Number(r.message_count),
        lastMessage:
          lastBody != null && lastDirection != null && lastCreatedAt != null
            ? {
                body: lastBody,
                direction: lastDirection,
                createdAt: lastCreatedAt,
              }
            : null,
      };
    });
  }

  listMessages(conversationId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(conversationId);
    return rows.map((row) => mapMessage(row as Record<string, unknown>));
  }

  insertMessage(input: InsertMessageInput): { message: Message; inserted: boolean } {
    if (input.providerMessageId) {
      const existing = this.db
        .prepare(`SELECT * FROM messages WHERE provider_message_id = ?`)
        .get(input.providerMessageId);
      if (existing) {
        return { message: mapMessage(existing as Record<string, unknown>), inserted: false };
      }
    }

    const message: Message = {
      id: randomUUID(),
      conversationId: input.conversationId,
      direction: input.direction,
      body: input.body,
      providerMessageId: input.providerMessageId ?? null,
      createdAt: (input.createdAt ?? new Date()).toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO messages (
          id, conversation_id, direction, body, provider_message_id, created_at
        ) VALUES (
          @id, @conversationId, @direction, @body, @providerMessageId, @createdAt
        )`,
      )
      .run(message);

    return { message, inserted: true };
  }

  markMessageSent(messageId: string, providerMessageId: string): void {
    this.db
      .prepare(`UPDATE messages SET provider_message_id = ? WHERE id = ?`)
      .run(providerMessageId, messageId);
  }

  insertJob(input: InsertJobInput): Job {
    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      conversationId: input.conversationId,
      type: input.type,
      status: "pending",
      payloadJson: JSON.stringify(input.payload),
      externalId: input.externalId ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    this.db
      .prepare(
        `INSERT INTO jobs (
          id, conversation_id, type, status, payload_json, external_id,
          created_at, updated_at, completed_at
        ) VALUES (
          @id, @conversationId, @type, @status, @payloadJson, @externalId,
          @createdAt, @updatedAt, @completedAt
        )`,
      )
      .run(job);

    return job;
  }

  getJob(id: string): Job | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
    return row ? mapJob(row as Record<string, unknown>) : null;
  }

  updateJobStatus(
    id: string,
    status: JobStatus,
    extras: { externalId?: string | null; completedAt?: Date | null } = {},
  ): Job | null {
    const now = new Date().toISOString();
    const completedAt =
      extras.completedAt === undefined
        ? status === "completed" || status === "failed" || status === "skipped"
          ? now
          : null
        : extras.completedAt
          ? extras.completedAt.toISOString()
          : null;

    this.db
      .prepare(
        `UPDATE jobs
         SET status = ?,
             updated_at = ?,
             completed_at = COALESCE(?, completed_at),
             external_id = COALESCE(?, external_id)
         WHERE id = ?`,
      )
      .run(status, now, completedAt, extras.externalId ?? null, id);

    return this.getJob(id);
  }

  claimJob(id: string): Job | null {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'processing', updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now, id);

    if (result.changes === 0) {
      return this.getJob(id);
    }
    return this.getJob(id);
  }

  markGoalReached(conversationId: string, bookingUrl: string, reason = "booking_link"): Conversation | null {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE conversations
         SET status = 'goal_reached',
             booking_url = ?,
             stop_reason = ?,
             updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(bookingUrl, reason, now, conversationId);
    return this.getConversation(conversationId);
  }

  markExpired(conversationId: string, reason = "ttl_elapsed"): Conversation | null {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE conversations
         SET status = 'expired',
             stop_reason = ?,
             updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(reason, now, conversationId);
    return this.getConversation(conversationId);
  }

  markDeclined(conversationId: string, reason = "firm_declined"): Conversation | null {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE conversations
         SET status = 'declined',
             stop_reason = ?,
             updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(reason, now, conversationId);
    return this.getConversation(conversationId);
  }

  /** Returns true if this is the first time seeing the event key. */
  claimEvent(eventKey: string): boolean {
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(`INSERT INTO processed_events (event_key, created_at) VALUES (?, ?)`)
        .run(eventKey, now);
      return true;
    } catch {
      return false;
    }
  }

  private readonly mutexes = new Map<string, Promise<unknown>>();

  /**
   * Serialize async work per conversation so duplicate/fast events
   * cannot produce two concurrent replies.
   */
  async withConversationLock<T>(conversationId: string, fn: () => Promise<T> | T): Promise<T> {
    const key = `conversation:${conversationId}`;
    const previous = this.mutexes.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutexes.set(key, previous.catch(() => undefined).then(() => gate));

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function mapConversation(row: Record<string, unknown>): Conversation {
  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    firmName: String(row.firm_name),
    firmPhone: String(row.firm_phone),
    fromPhone: String(row.from_phone),
    status: row.status as ConversationStatus,
    personaJson: String(row.persona_json),
    startedAt: String(row.started_at),
    expiresAt: String(row.expires_at),
    stopReason: row.stop_reason == null ? null : String(row.stop_reason),
    bookingUrl: row.booking_url == null ? null : String(row.booking_url),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMessage(row: Record<string, unknown>): Message {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    direction: row.direction as MessageDirection,
    body: String(row.body),
    providerMessageId: row.provider_message_id == null ? null : String(row.provider_message_id),
    createdAt: String(row.created_at),
  };
}

function mapJob(row: Record<string, unknown>): Job {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    type: row.type as JobType,
    status: row.status as JobStatus,
    payloadJson: String(row.payload_json),
    externalId: row.external_id == null ? null : String(row.external_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
}

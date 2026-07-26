import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FakeScheduler } from "../src/adapters/scheduler.js";
import { FakeMessagingAdapter } from "../src/adapters/messaging.js";
import { parseGhlInboundMessage } from "../src/adapters/gohighlevel.js";
import { StubTurnDecider } from "../src/agent/turn.js";
import { extractUrls } from "../src/agent/urls.js";
import { classifyBookingUrls } from "../src/agent/turn.js";
import { loadEnv, resetEnvCache, type Env } from "../src/config/env.js";
import {
  canProcessInbound,
  canSendOutbound,
  type Conversation,
} from "../src/domain/conversation.js";
import { ConversationService } from "../src/services/conversation-service.js";
import { ConversationStore } from "../src/storage/sqlite.js";
import type { PersonaConfig } from "../src/config/persona.js";

const persona: PersonaConfig["persona"] = {
  name: "Alex Rivera",
  summary: "Busy professional after a car accident",
  problem: "Rear-ended at a stoplight; minor injuries",
  goals: ["Get a booking link"],
  tone: "polite and concise",
};

function makePersonaConfig(overrides: Partial<PersonaConfig> = {}): PersonaConfig {
  return {
    campaignId: "test-campaign",
    firmName: "Test Law",
    firmPhone: "+15559876543",
    fromPhone: "+15551234567",
    initialMessage: "Hi, do you handle personal injury cases?",
    persona,
    replyDelaySeconds: 0,
    ...overrides,
  };
}

describe("URL helpers", () => {
  it("extracts and strips trailing punctuation from URLs", () => {
    expect(extractUrls("Book here: https://calendly.com/firm/intro.")).toEqual([
      "https://calendly.com/firm/intro",
    ]);
  });

  it("classifies known booking domains", () => {
    expect(classifyBookingUrls(["https://example.com/page"])).toBeNull();
    expect(classifyBookingUrls(["https://calendly.com/x/y"])).toBe(
      "https://calendly.com/x/y",
    );
  });
});

describe("GoHighLevel inbound parsing", () => {
  it("parses flat InboundMessage SMS payloads", () => {
    const parsed = parseGhlInboundMessage({
      type: "InboundMessage",
      locationId: "loc_1",
      messageId: "msg_1",
      contactId: "contact_1",
      body: "Hello there",
      messageType: "SMS",
      from: "+15559876543",
      to: "+15551234567",
    });

    expect(parsed).toEqual({
      messageId: "msg_1",
      from: "+15559876543",
      to: "+15551234567",
      text: "Hello there",
      messageType: "SMS",
      locationId: "loc_1",
      contactId: "contact_1",
    });
  });

  it("ignores non-SMS inbound events", () => {
    expect(
      parseGhlInboundMessage({
        type: "InboundMessage",
        messageId: "msg_2",
        messageType: "Email",
        from: "+15559876543",
        to: "+15551234567",
        body: "hi",
      }),
    ).toBeNull();
  });

  it("parses Workflow customData / contact.phone payloads", () => {
    const parsed = parseGhlInboundMessage({
      type: "InboundMessage",
      locationId: "loc_wf",
      contact: { id: "contact_wf", phone: "+18476917564" },
      customData: {
        messageId: "msg_wf_1",
        to: "+17407614801",
        body: "Yes we handle personal injury",
        messageType: "SMS",
      },
    });

    expect(parsed).toEqual({
      messageId: "msg_wf_1",
      from: "+18476917564",
      to: "+17407614801",
      text: "Yes we handle personal injury",
      messageType: "SMS",
      locationId: "loc_wf",
      contactId: "contact_wf",
    });
  });

  it("parses nested data payloads", () => {
    const parsed = parseGhlInboundMessage({
      type: "InboundMessage",
      data: {
        locationId: "loc_nested",
        messageId: "msg_nested",
        contactId: "contact_nested",
        messageType: "SMS",
        from: "+18476917564",
        to: "+17407614801",
        body: "Nested reply",
      },
    });

    expect(parsed).toEqual({
      messageId: "msg_nested",
      from: "+18476917564",
      to: "+17407614801",
      text: "Nested reply",
      messageType: "SMS",
      locationId: "loc_nested",
      contactId: "contact_nested",
    });
  });

  it("parses Workflow Customer Replied contact envelopes", () => {
    const parsed = parseGhlInboundMessage(
      {
        contact_id: "c_wf_1",
        first_name: "Alex",
        phone: "+18476917564",
        location: { id: "jC52WuYhSqW0DhSRzG3j", name: "Demo" },
        message: {
          id: "msg_reply_1",
          body: "Yes we handle personal injury",
          type: "SMS",
        },
        workflow: { id: "wf_1", name: "Secret Shopper Inbound SMS" },
        triggerData: {},
        customData: {},
      },
      { defaultTo: "+17407614801" },
    );

    expect(parsed).toEqual({
      messageId: "msg_reply_1",
      from: "+18476917564",
      to: "+17407614801",
      text: "Yes we handle personal injury",
      messageType: "SMS",
      locationId: "jC52WuYhSqW0DhSRzG3j",
      contactId: "c_wf_1",
    });
  });

  it("synthesizes a stable messageId when Workflow omits message.id", () => {
    const payload = {
      contact_id: "c_wf_2",
      phone: "+18476917564",
      message: { body: "Can you call me?" },
      workflow: { id: "wf_1" },
      customData: {},
    };
    const first = parseGhlInboundMessage(payload, { defaultTo: "+17407614801" });
    const second = parseGhlInboundMessage(payload, { defaultTo: "+17407614801" });
    expect(first?.from).toBe("+18476917564");
    expect(first?.to).toBe("+17407614801");
    expect(first?.text).toBe("Can you call me?");
    expect(first?.messageId).toMatch(/^wf:c_wf_2:/);
    expect(second?.messageId).toBe(first?.messageId);
  });
});

describe("lifecycle helpers", () => {
  const base: Conversation = {
    id: "c1",
    campaignId: "camp",
    firmName: "Firm",
    firmPhone: "+15559876543",
    fromPhone: "+15551234567",
    status: "active",
    personaJson: "{}",
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    stopReason: null,
    bookingUrl: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("allows processing only while active and before expiry", () => {
    expect(canProcessInbound(base)).toBe(true);
    expect(canSendOutbound({ ...base, status: "goal_reached" })).toBe(false);
    expect(
      canProcessInbound({
        ...base,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ).toBe(false);
  });
});

describe("ConversationStore", () => {
  let store: ConversationStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `secret-shopper-${Date.now()}-${Math.random()}.db`);
    store = new ConversationStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dbPath, { force: true });
  });

  it("deduplicates messages by provider id", () => {
    const conversation = store.createConversation({
      campaignId: "c",
      firmName: "F",
      firmPhone: "+15559876543",
      fromPhone: "+15551234567",
      personaJson: "{}",
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const first = store.insertMessage({
      conversationId: conversation.id,
      direction: "inbound",
      body: "hello",
      providerMessageId: "SM1",
    });
    const second = store.insertMessage({
      conversationId: conversation.id,
      direction: "inbound",
      body: "hello",
      providerMessageId: "SM1",
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.message.id).toBe(first.message.id);
  });

  it("transitions active -> goal_reached and active -> expired", () => {
    const conversation = store.createConversation({
      campaignId: "c",
      firmName: "F",
      firmPhone: "+15559876543",
      fromPhone: "+15551234567",
      personaJson: "{}",
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const reached = store.markGoalReached(conversation.id, "https://calendly.com/x");
    expect(reached?.status).toBe("goal_reached");
    expect(store.markExpired(conversation.id)?.status).toBe("goal_reached");

    const other = store.createConversation({
      campaignId: "c2",
      firmName: "F2",
      firmPhone: "+15551111111",
      fromPhone: "+15552222222",
      personaJson: "{}",
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(store.markExpired(other.id)?.status).toBe("expired");
  });

  it("claims events once", () => {
    expect(store.claimEvent("ghl:inbound:SM1")).toBe(true);
    expect(store.claimEvent("ghl:inbound:SM1")).toBe(false);
  });
});

describe("event system integration", () => {
  let dbPath: string;
  let store: ConversationStore;
  let messaging: FakeMessagingAdapter;
  let scheduler: FakeScheduler;
  let service: ConversationService;
  let env: Env;

  beforeEach(() => {
    resetEnvCache();
    dbPath = path.join(os.tmpdir(), `secret-shopper-${Date.now()}-${Math.random()}.db`);
    env = loadEnv({
      PUBLIC_BASE_URL: "http://localhost:3000",
      DATA_DIR: path.dirname(dbPath),
      REPLY_DELAY_SECONDS: "0",
      CONVERSATION_TTL_HOURS: "12",
      GHL_VALIDATE_SIGNATURE: "false",
      QSTASH_VALIDATE_SIGNATURE: "false",
      LLM_PROVIDER: "stub",
    });
    env = { ...env, databasePath: dbPath };

    store = new ConversationStore(dbPath);
    messaging = new FakeMessagingAdapter();
    scheduler = new FakeScheduler();
    service = new ConversationService(store, messaging, scheduler, new StubTurnDecider(), env);

    scheduler.onSchedule = async (input) => {
      if (input.type === "process-inbound") {
        await service.handleProcessInbound(input.jobId);
      } else if (input.type === "send-reply") {
        await service.handleSendReply(input.jobId);
      } else if (input.type === "expire-conversation") {
        await service.handleExpire(input.jobId);
      }
    };
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dbPath, { force: true });
    resetEnvCache();
  });

  it("starts a conversation, sends the initial SMS, and schedules expiry", async () => {
    const result = await service.startConversation(makePersonaConfig());
    expect(result.conversationId).toBeTruthy();
    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0]?.body).toContain("personal injury");
    expect(scheduler.scheduled.some((j) => j.type === "expire-conversation")).toBe(true);
    expect(store.getConversation(result.conversationId)?.status).toBe("active");
  });

  it("processes an inbound SMS and sends a delayed reply", async () => {
    const started = await service.startConversation(makePersonaConfig());
    const accepted = await service.acceptInbound({
      messageSid: "SM_IN_1",
      from: "+15559876543",
      to: "+15551234567",
      body: "Yes, we handle personal injury cases.",
    });

    expect(accepted.accepted).toBe(true);
    expect(accepted.reason).toBe("queued");
    expect(messaging.sent.length).toBeGreaterThanOrEqual(2);
    expect(messaging.sent.at(-1)?.body.toLowerCase()).toMatch(/consult|next step|schedule/);
    expect(store.getConversation(started.conversationId)?.status).toBe("active");
  });

  it("deduplicates inbound MessageSid", async () => {
    await service.startConversation(makePersonaConfig());
    const first = await service.acceptInbound({
      messageSid: "SM_DUP",
      from: "+15559876543",
      to: "+15551234567",
      body: "Hello",
    });
    const second = await service.acceptInbound({
      messageSid: "SM_DUP",
      from: "+15559876543",
      to: "+15551234567",
      body: "Hello",
    });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe("duplicate_message");
  });

  it("stops on booking link and suppresses further replies", async () => {
    const started = await service.startConversation(makePersonaConfig());
    const beforeCount = messaging.sent.length;

    await service.acceptInbound({
      messageSid: "SM_BOOK",
      from: "+15559876543",
      to: "+15551234567",
      body: "You can book here: https://calendly.com/test-firm/intro",
    });

    const conversation = store.getConversation(started.conversationId);
    expect(conversation?.status).toBe("goal_reached");
    expect(conversation?.bookingUrl).toBe("https://calendly.com/test-firm/intro");
    expect(messaging.sent.length).toBe(beforeCount);

    await service.acceptInbound({
      messageSid: "SM_AFTER",
      from: "+15559876543",
      to: "+15551234567",
      body: "Did you get the link?",
    });

    expect(messaging.sent.length).toBe(beforeCount);
    expect(store.getConversation(started.conversationId)?.status).toBe("goal_reached");
  });

  it("expires via expire-conversation and then stays silent", async () => {
    scheduler.onSchedule = async (input) => {
      if (input.type === "process-inbound") {
        await service.handleProcessInbound(input.jobId);
      } else if (input.type === "send-reply") {
        await service.handleSendReply(input.jobId);
      }
    };

    const started = await service.startConversation(makePersonaConfig());
    const expireJob = scheduler.scheduled.find((j) => j.type === "expire-conversation");
    expect(expireJob).toBeTruthy();

    const result = await service.handleExpire(expireJob!.jobId);
    expect(result.status).toBe("expired");
    expect(store.getConversation(started.conversationId)?.status).toBe("expired");

    const before = messaging.sent.length;
    await service.acceptInbound({
      messageSid: "SM_LATE",
      from: "+15559876543",
      to: "+15551234567",
      body: "Are you still there?",
    });
    expect(messaging.sent.length).toBe(before);
  });

  it("treats expiry as no-op after goal reached", async () => {
    scheduler.onSchedule = async (input) => {
      if (input.type === "process-inbound") {
        await service.handleProcessInbound(input.jobId);
      } else if (input.type === "send-reply") {
        await service.handleSendReply(input.jobId);
      }
    };

    const started = await service.startConversation(makePersonaConfig());
    await service.acceptInbound({
      messageSid: "SM_BOOK2",
      from: "+15559876543",
      to: "+15551234567",
      body: "https://cal.com/firm/meeting",
    });
    expect(store.getConversation(started.conversationId)?.status).toBe("goal_reached");

    const expireJob = scheduler.scheduled.find((j) => j.type === "expire-conversation")!;
    const result = await service.handleExpire(expireJob.jobId);
    expect(result.status).toBe("noop_goal_reached");
    expect(store.getConversation(started.conversationId)?.status).toBe("goal_reached");
  });

  it("skips delayed send if conversation became terminal", async () => {
    scheduler.onSchedule = async () => {
      // manual control
    };

    const started = await service.startConversation(makePersonaConfig());
    const accepted = await service.acceptInbound({
      messageSid: "SM_DELAY",
      from: "+15559876543",
      to: "+15551234567",
      body: "Yes we can help",
    });
    expect(accepted.jobId).toBeTruthy();

    await service.handleProcessInbound(accepted.jobId!);
    const sendJob = scheduler.scheduled.find((j) => j.type === "send-reply");
    expect(sendJob).toBeTruthy();

    store.markGoalReached(started.conversationId, "https://calendly.com/x");
    const sendResult = await service.handleSendReply(sendJob!.jobId);
    expect(sendResult.status).toBe("skipped_terminal");
  });
});

describe("HTTP routes", () => {
  let dbPath: string;
  let store: ConversationStore;
  let messaging: FakeMessagingAdapter;
  let scheduler: FakeScheduler;
  let service: ConversationService;
  let env: Env;

  beforeEach(async () => {
    resetEnvCache();
    dbPath = path.join(os.tmpdir(), `secret-shopper-${Date.now()}-${Math.random()}.db`);
    env = {
      ...loadEnv({
        PUBLIC_BASE_URL: "http://localhost:3000",
        DATA_DIR: path.dirname(dbPath),
        REPLY_DELAY_SECONDS: "0",
        GHL_VALIDATE_SIGNATURE: "false",
        QSTASH_VALIDATE_SIGNATURE: "false",
        LLM_PROVIDER: "stub",
      }),
      databasePath: dbPath,
    };
    store = new ConversationStore(dbPath);
    messaging = new FakeMessagingAdapter();
    scheduler = new FakeScheduler();
    service = new ConversationService(store, messaging, scheduler, new StubTurnDecider(), env);
    scheduler.onSchedule = async (input) => {
      if (input.type === "process-inbound") {
        await service.handleProcessInbound(input.jobId);
      } else if (input.type === "send-reply") {
        await service.handleSendReply(input.jobId);
      }
    };
    await service.startConversation(makePersonaConfig());
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dbPath, { force: true });
    resetEnvCache();
  });

  it("rejects invalid GoHighLevel signatures", async () => {
    messaging.validSignatures = false;
    const app = createApp({ env, service, messaging, scheduler });
    const res = await request(app).post("/webhooks/gohighlevel").send({
      type: "InboundMessage",
      messageId: "SM1",
      messageType: "SMS",
      from: "+15559876543",
      to: "+15551234567",
      body: "Hi",
    });
    expect(res.status).toBe(403);
  });

  it("acknowledges valid inbound SMS with JSON", async () => {
    const app = createApp({ env, service, messaging, scheduler });
    const res = await request(app).post("/webhooks/gohighlevel").send({
      type: "InboundMessage",
      messageId: "SM_HTTP_1",
      messageType: "SMS",
      from: "+15559876543",
      to: "+15551234567",
      body: "Yes, we handle those cases.",
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(messaging.sent.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects invalid QStash signatures", async () => {
    scheduler.validSignatures = false;
    const app = createApp({ env, service, messaging, scheduler });
    const res = await request(app)
      .post("/jobs/process-inbound")
      .send({ jobId: "missing", conversationId: "x", type: "process-inbound" });
    expect(res.status).toBe(403);
  });

  it("handles job callbacks idempotently", async () => {
    const app = createApp({ env, service, messaging, scheduler });

    scheduler.onSchedule = async () => undefined;
    const accepted = await service.acceptInbound({
      messageSid: "SM_JOB_1",
      from: "+15559876543",
      to: "+15551234567",
      body: "Can we schedule a consult?",
    });

    const first = await request(app)
      .post("/jobs/process-inbound")
      .send({
        jobId: accepted.jobId,
        conversationId: accepted.conversationId,
        type: "process-inbound",
      });
    const second = await request(app)
      .post("/jobs/process-inbound")
      .send({
        jobId: accepted.jobId,
        conversationId: accepted.conversationId,
        type: "process-inbound",
      });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.status).toMatch(/completed|skipped|reply_scheduled|goal_reached|no_reply/);
  });
});

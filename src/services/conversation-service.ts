import type { Env } from "../config/env.js";
import type { PersonaConfig } from "../config/persona.js";
import type { TurnDecider } from "../agent/turn.js";
import type { SchedulerAdapter } from "../adapters/scheduler.js";
import type { MessagingAdapter } from "../adapters/messaging.js";
import {
  canProcessInbound,
  canSendOutbound,
  type Job,
} from "../domain/conversation.js";
import type { ConversationStore } from "../storage/sqlite.js";

export interface InboundSmsEvent {
  messageSid: string;
  from: string;
  to: string;
  body: string;
}

export class ConversationService {
  constructor(
    private readonly store: ConversationStore,
    private readonly messaging: MessagingAdapter,
    private readonly scheduler: SchedulerAdapter,
    private readonly decider: TurnDecider,
    private readonly env: Env,
  ) {}

  async startConversation(config: PersonaConfig): Promise<{
    conversationId: string;
    initialMessageSid: string;
    expiresAt: string;
  }> {
    const fromPhone = config.fromPhone ?? this.env.GHL_FROM_NUMBER;
    if (!fromPhone) {
      throw new Error("fromPhone or GHL_FROM_NUMBER is required");
    }

    const startedAt = new Date();
    const expiresAt = new Date(
      startedAt.getTime() + this.env.CONVERSATION_TTL_HOURS * 60 * 60 * 1000,
    );

    const conversation = this.store.createConversation({
      campaignId: config.campaignId,
      firmName: config.firmName,
      firmPhone: normalizePhone(config.firmPhone),
      fromPhone: normalizePhone(fromPhone),
      personaJson: JSON.stringify(config.persona),
      startedAt,
      expiresAt,
    });

    const sent = await this.messaging.sendSms({
      to: conversation.firmPhone,
      from: conversation.fromPhone,
      body: config.initialMessage,
      contactName: config.firmName,
    });

    this.store.insertMessage({
      conversationId: conversation.id,
      direction: "outbound",
      body: config.initialMessage,
      providerMessageId: sent.messageId,
      createdAt: startedAt,
    });

    const expireJob = this.store.insertJob({
      conversationId: conversation.id,
      type: "expire-conversation",
      payload: { reason: "ttl_elapsed" },
    });

    const delaySeconds = Math.max(
      0,
      Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    );

    const scheduled = await this.scheduler.schedule({
      type: "expire-conversation",
      jobId: expireJob.id,
      conversationId: conversation.id,
      delaySeconds,
      payload: { reason: "ttl_elapsed" },
    });

    this.store.updateJobStatus(expireJob.id, "pending", {
      externalId: scheduled.messageId,
    });

    return {
      conversationId: conversation.id,
      initialMessageSid: sent.messageId,
      expiresAt: conversation.expiresAt,
    };
  }

  /**
   * Persist an inbound SMS and enqueue immediate processing.
   * Returns whether a new event was accepted.
   */
  async acceptInbound(event: InboundSmsEvent): Promise<{
    accepted: boolean;
    reason: string;
    conversationId?: string;
    jobId?: string;
  }> {
    const firmPhone = normalizePhone(event.from);
    const fromPhone = normalizePhone(event.to);

    const conversation = this.store.getConversationByPhones(firmPhone, fromPhone);
    if (!conversation) {
      return { accepted: false, reason: "no_matching_conversation" };
    }

    const eventKey = `ghl:inbound:${event.messageSid}`;
    if (!this.store.claimEvent(eventKey)) {
      return {
        accepted: false,
        reason: "duplicate_message",
        conversationId: conversation.id,
      };
    }

    const { message, inserted } = this.store.insertMessage({
      conversationId: conversation.id,
      direction: "inbound",
      body: event.body,
      providerMessageId: event.messageSid,
    });

    if (!inserted) {
      return {
        accepted: false,
        reason: "duplicate_message",
        conversationId: conversation.id,
      };
    }

    // Always acknowledge/persist terminal inbound SMS, but only queue processing while active.
    if (!canProcessInbound(conversation)) {
      return {
        accepted: true,
        reason: "conversation_terminal_recorded",
        conversationId: conversation.id,
      };
    }

    const job = this.store.insertJob({
      conversationId: conversation.id,
      type: "process-inbound",
      payload: {
        messageId: message.id,
        providerMessageId: event.messageSid,
        body: event.body,
      },
    });

    const scheduled = await this.scheduler.schedule({
      type: "process-inbound",
      jobId: job.id,
      conversationId: conversation.id,
      payload: {
        messageId: message.id,
        providerMessageId: event.messageSid,
        body: event.body,
      },
    });

    this.store.updateJobStatus(job.id, "pending", {
      externalId: scheduled.messageId,
    });

    return {
      accepted: true,
      reason: "queued",
      conversationId: conversation.id,
      jobId: job.id,
    };
  }

  async handleProcessInbound(jobId: string): Promise<{ status: string }> {
    const job = this.store.getJob(jobId);
    if (!job) {
      return { status: "missing_job" };
    }
    if (job.status === "completed" || job.status === "skipped") {
      return { status: job.status };
    }

    const outcome = await this.store.withConversationLock(job.conversationId, async () => {
      const claimed = this.store.claimJob(jobId);
      if (!claimed) {
        return { status: "missing_job" as const };
      }
      if (claimed.status !== "processing") {
        return { status: claimed.status };
      }

      try {
        const snapshot = this.store.getSnapshot(job.conversationId);
        if (!snapshot) {
          this.store.updateJobStatus(jobId, "failed");
          return { status: "missing_conversation" as const };
        }

        if (!canProcessInbound(snapshot.conversation)) {
          this.store.updateJobStatus(jobId, "skipped");
          return { status: "skipped_terminal" as const };
        }

        const payload = JSON.parse(job.payloadJson) as {
          body: string;
          messageId: string;
        };
        const persona = JSON.parse(snapshot.conversation.personaJson) as PersonaConfig["persona"];

        const decision = await this.decider.decide({
          snapshot,
          inboundBody: payload.body,
          persona,
        });

        if (decision.bookingLinkDetected && decision.bookingUrl) {
          this.store.markGoalReached(job.conversationId, decision.bookingUrl);
          this.store.updateJobStatus(jobId, "completed");
          return { status: "goal_reached" as const };
        }

        if (decision.declineDetected) {
          this.store.markDeclined(
            job.conversationId,
            decision.declineReason ?? "firm_declined",
          );
          this.store.updateJobStatus(jobId, "completed");
          return { status: "declined" as const };
        }

        if (!decision.replyText) {
          this.store.updateJobStatus(jobId, "completed");
          return { status: "no_reply" as const };
        }

        const pendingMessage = this.store.insertMessage({
          conversationId: job.conversationId,
          direction: "outbound",
          body: decision.replyText,
          providerMessageId: null,
        }).message;

        const sendJob = this.store.insertJob({
          conversationId: job.conversationId,
          type: "send-reply",
          payload: {
            messageId: pendingMessage.id,
            body: decision.replyText,
          },
        });

        this.store.updateJobStatus(jobId, "completed");
        return {
          status: "reply_scheduled" as const,
          sendJobId: sendJob.id,
          conversationId: job.conversationId,
          messageId: pendingMessage.id,
          body: decision.replyText,
        };
      } catch (error) {
        this.store.updateJobStatus(jobId, "failed");
        throw error;
      }
    });

    if (outcome.status === "reply_scheduled" && "sendJobId" in outcome) {
      const scheduled = await this.scheduler.schedule({
        type: "send-reply",
        jobId: outcome.sendJobId,
        conversationId: outcome.conversationId,
        delaySeconds: this.env.REPLY_DELAY_SECONDS,
        payload: {
          messageId: outcome.messageId,
          body: outcome.body,
        },
      });
      this.store.updateJobStatus(outcome.sendJobId, "pending", {
        externalId: scheduled.messageId,
      });
    }

    return { status: outcome.status };
  }

  async handleSendReply(jobId: string): Promise<{ status: string; sid?: string }> {
    const job = this.store.getJob(jobId);
    if (!job) {
      return { status: "missing_job" };
    }
    if (job.status === "completed" || job.status === "skipped") {
      return { status: job.status };
    }

    return this.store.withConversationLock(job.conversationId, async () => {
      const claimed = this.store.claimJob(jobId);
      if (!claimed || claimed.status !== "processing") {
        return { status: claimed?.status ?? "missing_job" };
      }

      try {
        const conversation = this.store.getConversation(job.conversationId);
        if (!conversation) {
          this.store.updateJobStatus(jobId, "failed");
          return { status: "missing_conversation" };
        }

        if (!canSendOutbound(conversation)) {
          this.store.updateJobStatus(jobId, "skipped");
          return { status: "skipped_terminal" };
        }

        const payload = JSON.parse(job.payloadJson) as {
          messageId: string;
          body: string;
        };

        // Idempotency: if this outbound message already has a provider id, skip.
        const messages = this.store.listMessages(job.conversationId);
        const target = messages.find((m) => m.id === payload.messageId);
        if (target?.providerMessageId) {
          this.store.updateJobStatus(jobId, "completed");
          return { status: "already_sent", sid: target.providerMessageId };
        }

        const sent = await this.messaging.sendSms({
          to: conversation.firmPhone,
          from: conversation.fromPhone,
          body: payload.body,
          contactName: conversation.firmName,
        });

        this.store.markMessageSent(payload.messageId, sent.messageId);
        this.store.updateJobStatus(jobId, "completed");
        return { status: "sent", sid: sent.messageId };
      } catch (error) {
        this.store.updateJobStatus(jobId, "failed");
        throw error;
      }
    });
  }

  async handleExpire(jobId: string): Promise<{ status: string }> {
    const job = this.store.getJob(jobId);
    if (!job) {
      return { status: "missing_job" };
    }
    if (job.status === "completed" || job.status === "skipped") {
      return { status: job.status };
    }

    return this.store.withConversationLock(job.conversationId, async () => {
      const claimed = this.store.claimJob(jobId);
      if (!claimed || claimed.status !== "processing") {
        return { status: claimed?.status ?? "missing_job" };
      }

      const conversation = this.store.getConversation(job.conversationId);
      if (!conversation) {
        this.store.updateJobStatus(jobId, "failed");
        return { status: "missing_conversation" };
      }

      if (conversation.status === "goal_reached") {
        this.store.updateJobStatus(jobId, "skipped");
        return { status: "noop_goal_reached" };
      }
      if (conversation.status === "declined") {
        this.store.updateJobStatus(jobId, "skipped");
        return { status: "noop_declined" };
      }
      if (conversation.status === "expired") {
        this.store.updateJobStatus(jobId, "skipped");
        return { status: "already_expired" };
      }

      this.store.markExpired(job.conversationId, "ttl_elapsed");
      this.store.updateJobStatus(jobId, "completed");
      return { status: "expired" };
    });
  }

  getJob(jobId: string): Job | null {
    return this.store.getJob(jobId);
  }
}

export function normalizePhone(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("+")) {
    return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  return trimmed;
}

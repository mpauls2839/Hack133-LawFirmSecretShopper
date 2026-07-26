export type ConversationStatus = "active" | "goal_reached" | "expired" | "declined";

export type MessageDirection = "inbound" | "outbound";

export type JobType =
  | "process-inbound"
  | "send-reply"
  | "expire-conversation";

export type JobStatus = "pending" | "processing" | "completed" | "failed" | "skipped";

export interface Conversation {
  id: string;
  campaignId: string;
  firmName: string;
  firmPhone: string;
  fromPhone: string;
  status: ConversationStatus;
  personaJson: string;
  startedAt: string;
  expiresAt: string;
  stopReason: string | null;
  bookingUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  body: string;
  providerMessageId: string | null;
  createdAt: string;
}

export interface Job {
  id: string;
  conversationId: string;
  type: JobType;
  status: JobStatus;
  payloadJson: string;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ConversationSnapshot {
  conversation: Conversation;
  messages: Message[];
}

export function isTerminal(status: ConversationStatus): boolean {
  return status === "goal_reached" || status === "expired" || status === "declined";
}

export function canProcessInbound(conversation: Conversation, now = new Date()): boolean {
  if (conversation.status !== "active") {
    return false;
  }
  return new Date(conversation.expiresAt).getTime() > now.getTime();
}

export function canSendOutbound(conversation: Conversation, now = new Date()): boolean {
  return canProcessInbound(conversation, now);
}

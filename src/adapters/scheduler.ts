import { Client, Receiver } from "@upstash/qstash";
import type { Env } from "../config/env.js";
import type { JobType } from "../domain/conversation.js";

export interface ScheduleJobInput {
  type: JobType;
  jobId: string;
  conversationId: string;
  delaySeconds?: number;
  payload?: Record<string, unknown>;
}

export interface ScheduleJobResult {
  messageId: string;
}

export interface SchedulerAdapter {
  schedule(input: ScheduleJobInput): Promise<ScheduleJobResult>;
  verifySignature(signature: string | undefined, body: string, url: string): Promise<boolean>;
}

export class QStashScheduler implements SchedulerAdapter {
  private client: Client | null = null;
  private receiver: Receiver | null = null;
  private receiverInitialized = false;

  constructor(private readonly env: Env) {}

  private getClient(): Client {
    if (!this.env.QSTASH_TOKEN) {
      throw new Error("QSTASH_TOKEN is required");
    }
    if (!this.client) {
      this.client = new Client({ token: this.env.QSTASH_TOKEN });
    }
    return this.client;
  }

  private getReceiver(): Receiver | null {
    if (!this.receiverInitialized) {
      this.receiverInitialized = true;
      if (this.env.QSTASH_CURRENT_SIGNING_KEY && this.env.QSTASH_NEXT_SIGNING_KEY) {
        this.receiver = new Receiver({
          currentSigningKey: this.env.QSTASH_CURRENT_SIGNING_KEY,
          nextSigningKey: this.env.QSTASH_NEXT_SIGNING_KEY,
        });
      }
    }
    return this.receiver;
  }

  async schedule(input: ScheduleJobInput): Promise<ScheduleJobResult> {
    const url = `${this.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/jobs/${input.type}`;
    const body = {
      jobId: input.jobId,
      conversationId: input.conversationId,
      type: input.type,
      ...(input.payload ?? {}),
    };

    const result = await this.getClient().publishJSON({
      url,
      body,
      delay: input.delaySeconds && input.delaySeconds > 0 ? input.delaySeconds : undefined,
      retries: 3,
    });

    return { messageId: result.messageId };
  }

  async verifySignature(
    signature: string | undefined,
    body: string,
    url: string,
  ): Promise<boolean> {
    if (!this.env.QSTASH_VALIDATE_SIGNATURE) {
      return true;
    }
    const receiver = this.getReceiver();
    if (!signature || !receiver) {
      return false;
    }
    try {
      return await receiver.verify({
        signature,
        body,
        url,
      });
    } catch {
      return false;
    }
  }
}

export class FakeScheduler implements SchedulerAdapter {
  readonly scheduled: ScheduleJobInput[] = [];
  private counter = 0;
  validSignatures = true;
  /** Optional sink invoked immediately (or after delaySeconds via setTimeout) for tests. */
  onSchedule?: (input: ScheduleJobInput) => Promise<void> | void;

  async schedule(input: ScheduleJobInput): Promise<ScheduleJobResult> {
    this.counter += 1;
    this.scheduled.push(input);
    const messageId = `qstash_fake_${this.counter}`;

    if (this.onSchedule) {
      const run = () => this.onSchedule?.(input);
      if (input.delaySeconds && input.delaySeconds > 0) {
        setTimeout(() => {
          void run();
        }, input.delaySeconds * 1000);
      } else {
        await run();
      }
    }

    return { messageId };
  }

  async verifySignature(
    _signature: string | undefined,
    _body: string,
    _url: string,
  ): Promise<boolean> {
    return this.validSignatures;
  }
}

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
  private readonly client: Client;
  private readonly receiver: Receiver | null;

  constructor(private readonly env: Env) {
    if (!env.QSTASH_TOKEN) {
      throw new Error("QSTASH_TOKEN is required");
    }
    this.client = new Client({ token: env.QSTASH_TOKEN });
    if (env.QSTASH_CURRENT_SIGNING_KEY && env.QSTASH_NEXT_SIGNING_KEY) {
      this.receiver = new Receiver({
        currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
        nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
      });
    } else {
      this.receiver = null;
    }
  }

  async schedule(input: ScheduleJobInput): Promise<ScheduleJobResult> {
    const url = `${this.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/jobs/${input.type}`;
    const body = {
      jobId: input.jobId,
      conversationId: input.conversationId,
      type: input.type,
      ...(input.payload ?? {}),
    };

    const result = await this.client.publishJSON({
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
    if (!signature || !this.receiver) {
      return false;
    }
    try {
      return await this.receiver.verify({
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

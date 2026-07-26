import { Router, type Request, type Response } from "express";
import type { SchedulerAdapter } from "../adapters/scheduler.js";
import type { ConversationService } from "../services/conversation-service.js";
import type { Env } from "../config/env.js";
import type { JobType } from "../domain/conversation.js";

const JOB_TYPES: JobType[] = [
  "process-inbound",
  "send-reply",
  "expire-conversation",
];

export function createJobsRouter(deps: {
  service: ConversationService;
  scheduler: SchedulerAdapter;
  env: Env;
}): Router {
  const router = Router();

  router.post("/jobs/:type", async (req: Request, res: Response) => {
    const type = req.params.type as JobType;
    if (!JOB_TYPES.includes(type)) {
      res.status(404).json({ error: "unknown_job_type" });
      return;
    }

    const rawBody = getRawBody(req);
    const signature = headerValue(req, "upstash-signature");
    const url = `${deps.env.PUBLIC_BASE_URL.replace(/\/$/, "")}${req.originalUrl}`;

    const valid = await deps.scheduler.verifySignature(signature, rawBody, url);
    if (!valid) {
      res.status(403).json({ error: "invalid_qstash_signature" });
      return;
    }

    let payload: { jobId?: string; conversationId?: string; type?: string };
    try {
      payload = typeof req.body === "object" && req.body ? req.body : JSON.parse(rawBody);
    } catch {
      res.status(400).json({ error: "invalid_json" });
      return;
    }

    if (!payload.jobId) {
      res.status(400).json({ error: "missing_job_id" });
      return;
    }

    try {
      let result: { status: string };
      switch (type) {
        case "process-inbound":
          result = await deps.service.handleProcessInbound(payload.jobId);
          break;
        case "send-reply":
          result = await deps.service.handleSendReply(payload.jobId);
          break;
        case "expire-conversation":
          result = await deps.service.handleExpire(payload.jobId);
          break;
        default:
          res.status(404).json({ error: "unknown_job_type" });
          return;
      }
      res.status(200).json(result);
    } catch (error) {
      console.error(`Job ${type} failed`, error);
      res.status(500).json({ error: "job_failed" });
    }
  });

  return router;
}

function getRawBody(req: Request): string {
  const raw = (req as Request & { rawBody?: Buffer | string }).rawBody;
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  return typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

import { Router, type Request, type Response } from "express";
import { ZodError } from "zod";
import { personaConfigSchema } from "../config/persona.js";
import type { ConversationService } from "../services/conversation-service.js";
import type { Env } from "../config/env.js";

export function createConversationsRouter(deps: {
  service: ConversationService;
  env: Env;
}): Router {
  const router = Router();

  router.post("/conversations/start", async (req: Request, res: Response) => {
    const expected = deps.env.START_CONVERSATION_TOKEN;
    if (!expected) {
      res.status(503).json({ error: "start_endpoint_disabled" });
      return;
    }

    const provided = headerValue(req, "x-start-token");
    if (!provided || provided !== expected) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    let config;
    try {
      config = personaConfigSchema.parse(req.body);
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({ error: "invalid_persona", issues: error.issues });
        return;
      }
      throw error;
    }

    if (config.replyDelaySeconds !== undefined) {
      deps.env.REPLY_DELAY_SECONDS = config.replyDelaySeconds;
    }

    try {
      const result = await deps.service.startConversation(config);
      res.status(200).json({
        ok: true,
        conversationId: result.conversationId,
        initialMessageSid: result.initialMessageSid,
        expiresAt: result.expiresAt,
        firmPhone: config.firmPhone,
        publicBaseUrl: deps.env.PUBLIC_BASE_URL,
      });
    } catch (error) {
      console.error("[conversations/start] failed", error);
      res.status(500).json({
        error: "start_failed",
        message: error instanceof Error ? error.message : "unknown_error",
      });
    }
  });

  return router;
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

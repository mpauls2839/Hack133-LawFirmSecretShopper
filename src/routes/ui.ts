import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { ZodError } from "zod";
import { personaConfigSchema } from "../config/persona.js";
import type { Env } from "../config/env.js";
import type { ConversationService } from "../services/conversation-service.js";
import type { ConversationStore } from "../storage/sqlite.js";

const PERSONA_PATH = path.resolve("config/persona.json");

function loadPersonaFile(): unknown {
  if (!fs.existsSync(PERSONA_PATH)) {
    throw new Error(
      `Persona config not found at ${PERSONA_PATH}. Copy config/persona.example.json to config/persona.json.`,
    );
  }
  return JSON.parse(fs.readFileSync(PERSONA_PATH, "utf8"));
}

export function createUiRouter(deps: {
  service: ConversationService;
  store: ConversationStore;
  env: Env;
}): Router {
  const router = Router();

  router.get("/ui/config", (_req: Request, res: Response) => {
    try {
      const raw = loadPersonaFile();
      const config = personaConfigSchema.parse(raw);
      res.json({
        firmName: config.firmName,
        firmPhone: config.firmPhone,
        fromPhone: config.fromPhone ?? deps.env.GHL_FROM_NUMBER ?? null,
        initialMessage: config.initialMessage,
      });
    } catch (error) {
      console.error("[ui/config] failed", error);
      res.status(500).json({
        error: "config_load_failed",
        message: error instanceof Error ? error.message : "unknown_error",
      });
    }
  });

  router.post("/ui/start", async (req: Request, res: Response) => {
    try {
      const raw = loadPersonaFile() as Record<string, unknown>;
      const body = (req.body ?? {}) as {
        firmName?: string;
        firmPhone?: string;
        initialMessage?: string;
      };

      const merged = {
        ...raw,
        ...(body.firmName !== undefined ? { firmName: body.firmName } : {}),
        ...(body.firmPhone !== undefined ? { firmPhone: body.firmPhone } : {}),
        ...(body.initialMessage !== undefined
          ? { initialMessage: body.initialMessage }
          : {}),
      };

      const config = personaConfigSchema.parse(merged);

      if (config.replyDelaySeconds !== undefined) {
        deps.env.REPLY_DELAY_SECONDS = config.replyDelaySeconds;
      }

      const result = await deps.service.startConversation(config);
      res.status(200).json({
        ok: true,
        conversationId: result.conversationId,
        initialMessageSid: result.initialMessageSid,
        expiresAt: result.expiresAt,
        firmPhone: config.firmPhone,
        firmName: config.firmName,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({ error: "invalid_persona", issues: error.issues });
        return;
      }
      console.error("[ui/start] failed", error);
      res.status(500).json({
        error: "start_failed",
        message: error instanceof Error ? error.message : "unknown_error",
      });
    }
  });

  router.get("/ui/conversation", (_req: Request, res: Response) => {
    const snapshot = deps.store.getLatestSnapshot();
    if (!snapshot) {
      res.json(null);
      return;
    }

    const { conversation, messages } = snapshot;
    res.json({
      id: conversation.id,
      status: conversation.status,
      firmName: conversation.firmName,
      firmPhone: conversation.firmPhone,
      fromPhone: conversation.fromPhone,
      bookingUrl: conversation.bookingUrl,
      stopReason: conversation.stopReason,
      startedAt: conversation.startedAt,
      expiresAt: conversation.expiresAt,
      messages: messages.map((m) => ({
        direction: m.direction,
        body: m.body,
        createdAt: m.createdAt,
      })),
    });
  });

  return router;
}

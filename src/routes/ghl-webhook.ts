import { Router, type Request, type Response } from "express";
import type { MessagingAdapter } from "../adapters/messaging.js";
import { parseGhlInboundMessage } from "../adapters/gohighlevel.js";
import type { ConversationService } from "../services/conversation-service.js";
import type { Env } from "../config/env.js";

export function createGhlWebhookRouter(deps: {
  service: ConversationService;
  messaging: MessagingAdapter;
  env: Env;
}): Router {
  const router = Router();

  router.post("/webhooks/gohighlevel", async (req: Request, res: Response) => {
    const rawBody = getRawBody(req);
    const ghlSignature = headerValue(req, "x-ghl-signature");
    const legacySignature = headerValue(req, "x-wh-signature");

    if (!deps.messaging.verifyWebhookSignature(ghlSignature, legacySignature, rawBody)) {
      console.warn("[ghl-webhook] rejected: invalid_ghl_signature", {
        hasGhlSignature: Boolean(ghlSignature && ghlSignature !== "N/A"),
        hasLegacySignature: Boolean(legacySignature && legacySignature !== "N/A"),
        validateSignature: deps.env.GHL_VALIDATE_SIGNATURE,
      });
      res.status(403).json({ error: "invalid_ghl_signature" });
      return;
    }

    const inbound = parseGhlInboundMessage(req.body, {
      defaultTo: deps.env.GHL_FROM_NUMBER,
    });
    if (!inbound) {
      const bodyKeys =
        req.body && typeof req.body === "object" ? Object.keys(req.body as object) : [];
      const root = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      console.info("[ghl-webhook] ignored: unrecognized_or_non_sms", {
        bodyKeys,
        hasPhone: typeof root.phone === "string",
        hasMessage: root.message !== undefined,
        hasCustomData: root.customData !== undefined,
        defaultTo: deps.env.GHL_FROM_NUMBER ?? null,
      });
      // Acknowledge non-SMS or unrecognized events so GHL does not retry forever.
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    if (deps.env.GHL_LOCATION_ID && inbound.locationId && inbound.locationId !== deps.env.GHL_LOCATION_ID) {
      console.info("[ghl-webhook] ignored: wrong_location", {
        expected: deps.env.GHL_LOCATION_ID,
        got: inbound.locationId,
        messageId: inbound.messageId,
      });
      res.status(200).json({ ok: true, ignored: true, reason: "wrong_location" });
      return;
    }

    try {
      const result = await deps.service.acceptInbound({
        messageSid: inbound.messageId,
        from: inbound.from,
        to: inbound.to,
        body: inbound.text,
      });
      console.info("[ghl-webhook] acceptInbound", {
        messageId: inbound.messageId,
        from: inbound.from,
        to: inbound.to,
        accepted: result.accepted,
        reason: result.reason,
        conversationId: result.conversationId,
        jobId: result.jobId,
      });
      res.status(200).json({ ok: true, ...result });
    } catch (error) {
      console.error("[ghl-webhook] accept_failed", error);
      // Still ack to avoid aggressive retries for app bugs.
      res.status(200).json({ ok: false, error: "accept_failed" });
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

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
      res.status(403).json({ error: "invalid_ghl_signature" });
      return;
    }

    const inbound = parseGhlInboundMessage(req.body);
    if (!inbound) {
      // Acknowledge non-SMS or unrecognized events so GHL does not retry forever.
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    if (deps.env.GHL_LOCATION_ID && inbound.locationId && inbound.locationId !== deps.env.GHL_LOCATION_ID) {
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
      res.status(200).json({ ok: true, ...result });
    } catch (error) {
      console.error("Failed to accept GoHighLevel inbound SMS", error);
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

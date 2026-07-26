import crypto from "node:crypto";
import type { Env } from "../config/env.js";
import type { MessagingAdapter, SendSmsInput, SendSmsResult } from "./messaging.js";

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const CONVERSATIONS_VERSION = "2021-04-15";
const CONTACTS_VERSION = "2021-07-28";

/** Official HighLevel Ed25519 public key for X-GHL-Signature. */
const GHL_ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

/** Legacy RSA public key for X-WH-Signature (deprecated Sept 2026). */
const GHL_LEGACY_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAokvo/r9tVgcfZ5DysOSC
Frm602qYV0MaAiNnX9O8KxMbiyRKWeL9JpCpVpt4XHIcBOK4u3cLSqJGOLaPuXw6
dO0t6Q/ZVdAV5Phz+ZtzPL16iCGeK9po6D6JHBpbi989mmzMryUnQJezlYJ3DVfB
csedpinheNnyYeFXolrJvcsjDtfAeRx5ByHQmTnSdFUzuAnC9/GepgLT9SM4nCpv
uxmZMxrJt5Rw+VUaQ9B8JSvbMPpez4peKaJPZHBbU3OdeCVx5klVXXZQGNHOs8gF
3kvoV5rTnXV0IknLBXlcKKAQLZcY/Q9rG6Ifi9c+5vqlvHPCUJFT5XUGG5RKgOKUJ
062fRtN+rLYZUV+BjafxQauvC8wSWeYja63VSUruvmNj8xkx2zE/Juc+yjLjTXpI
ocmaiFeAO6fUtNjDeFVkhf5LNb59vECyrHD2SQIrhgXpO4Q3dVNA5rw576PwTzNh
/AMfHKIjE4xQA1SZuYJmNnmVZLIZBlQAF9Ntd03rfadZ+yDiOXCCs9FkHibELhCH
ULgCsnuDJHcrGNd5/Ddm5hxGQ0ASitgHeMZ0kcIOwKDOzOU53lDza6/Y09T7sYJP
Qe7z0cvj7aE4B+Ax1ZoZGPzpJlZtGXCsu9aTEGEnKzmsFqwcSsnw3JB31IGKAykT
1hhTiaCeIY/OwwwNUY2yvcCAwEAAQ==
-----END PUBLIC KEY-----`;

export class LiveGoHighLevelAdapter implements MessagingAdapter {
  private readonly contactCache = new Map<string, string>();
  private resolvedLocationId: string | null = null;

  constructor(private readonly env: Env) {
    if (!env.GHL_PRIVATE_TOKEN) {
      throw new Error("GHL_PRIVATE_TOKEN is required");
    }
  }

  async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
    const contactId = await this.upsertContact(input.to, input.contactName);
    const response = await fetch(`${GHL_API_BASE}/conversations/messages`, {
      method: "POST",
      headers: this.headers(CONVERSATIONS_VERSION),
      body: JSON.stringify({
        type: "SMS",
        contactId,
        message: input.body,
        fromNumber: input.from,
        toNumber: input.to,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GoHighLevel send SMS failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      messageId?: string;
      conversationId?: string;
    };

    if (!data.messageId) {
      throw new Error("GoHighLevel send SMS response missing messageId");
    }

    return {
      messageId: data.messageId,
      contactId,
      conversationId: data.conversationId,
    };
  }

  verifyWebhookSignature(
    signatureHeader: string | undefined,
    legacySignatureHeader: string | undefined,
    rawBody: string,
  ): boolean {
    if (!this.env.GHL_VALIDATE_SIGNATURE) {
      return true;
    }

    if (signatureHeader && signatureHeader !== "N/A") {
      return verifyEd25519(rawBody, signatureHeader, GHL_ED25519_PUBLIC_KEY);
    }

    if (legacySignatureHeader && legacySignatureHeader !== "N/A") {
      return verifyLegacyRsa(rawBody, legacySignatureHeader, GHL_LEGACY_RSA_PUBLIC_KEY);
    }

    return false;
  }

  private async resolveLocationId(): Promise<string> {
    if (this.env.GHL_LOCATION_ID) {
      return this.env.GHL_LOCATION_ID;
    }
    if (this.resolvedLocationId) {
      return this.resolvedLocationId;
    }

    const response = await fetch(`${GHL_API_BASE}/locations/search`, {
      method: "GET",
      headers: this.headers(CONTACTS_VERSION),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `GoHighLevel location lookup failed (${response.status}): ${text}. ` +
          `Set GHL_LOCATION_ID in .env (from the sub-account URL: /v2/location/<LOCATION_ID>/...).`,
      );
    }

    const data = (await response.json()) as {
      locations?: Array<{ id?: string }>;
      location?: { id?: string };
    };
    const locations = data.locations ?? (data.location?.id ? [data.location] : []);
    const ids = locations.map((loc) => loc.id).filter((id): id is string => Boolean(id));

    if (ids.length === 1) {
      this.resolvedLocationId = ids[0]!;
      return this.resolvedLocationId;
    }

    throw new Error(
      ids.length === 0
        ? "GoHighLevel returned no locations. Set GHL_LOCATION_ID in .env (copy it from the sub-account URL)."
        : `GoHighLevel returned ${ids.length} locations. Set GHL_LOCATION_ID in .env to one of: ${ids.join(", ")}`,
    );
  }

  private async upsertContact(phone: string, contactName?: string): Promise<string> {
    const cached = this.contactCache.get(phone);
    if (cached) {
      return cached;
    }

    const locationId = await this.resolveLocationId();
    const nameParts = splitName(contactName ?? "Secret Shopper");
    const response = await fetch(`${GHL_API_BASE}/contacts/upsert`, {
      method: "POST",
      headers: this.headers(CONTACTS_VERSION),
      body: JSON.stringify({
        locationId,
        phone,
        firstName: nameParts.firstName,
        lastName: nameParts.lastName,
        name: contactName ?? "Secret Shopper",
        tags: ["secret-shopper"],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GoHighLevel contact upsert failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      contact?: { id?: string };
      id?: string;
    };
    const contactId = data.contact?.id ?? data.id;
    if (!contactId) {
      throw new Error("GoHighLevel contact upsert response missing contact id");
    }

    this.contactCache.set(phone, contactId);
    return contactId;
  }

  private headers(version: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.env.GHL_PRIVATE_TOKEN}`,
      Version: version,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { firstName: "Secret", lastName: "Shopper" };
  }
  if (parts.length === 1) {
    return { firstName: parts[0]!, lastName: "Lead" };
  }
  return {
    firstName: parts[0]!,
    lastName: parts.slice(1).join(" "),
  };
}

export function verifyEd25519(rawBody: string, signature: string, publicKeyPem: string): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(rawBody, "utf8"),
      publicKeyPem,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

export function verifyLegacyRsa(rawBody: string, signature: string, publicKeyPem: string): boolean {
  try {
    const verifier = crypto.createVerify("SHA256");
    verifier.update(rawBody);
    return verifier.verify(publicKeyPem, signature, "base64");
  } catch {
    return false;
  }
}

/**
 * Normalize GoHighLevel inbound SMS payloads.
 * Accepts marketplace InboundMessage shapes and Workflow Customer Replied
 * envelopes (contact dump with nested `message` / `customData` / `phone`).
 */
export function parseGhlInboundMessage(
  body: unknown,
  options?: { defaultTo?: string },
): {
  messageId: string;
  from: string;
  to: string;
  text: string;
  messageType: string;
  locationId?: string;
  contactId?: string;
} | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const root = body as Record<string, unknown>;
  const nested =
    root.data && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : null;
  const customData =
    root.customData && typeof root.customData === "object"
      ? (root.customData as Record<string, unknown>)
      : nested?.customData && typeof nested.customData === "object"
        ? (nested.customData as Record<string, unknown>)
        : null;
  const contact =
    root.contact && typeof root.contact === "object"
      ? (root.contact as Record<string, unknown>)
      : nested?.contact && typeof nested.contact === "object"
        ? (nested.contact as Record<string, unknown>)
        : null;
  const messageObj = asRecord(
    firstDefined(
      [customData, nested, root].filter((layer): layer is Record<string, unknown> => layer !== null),
      ["message"],
    ),
  );

  // Prefer the most specific layer first (customData → message → data → root).
  const layers = [customData, messageObj, nested, root].filter(
    (layer): layer is Record<string, unknown> => layer !== null,
  );

  const type = String(
    firstString(root, "type") ??
      firstString(nested, "type") ??
      firstString(customData, "type") ??
      "",
  );
  // Workflow contact webhooks often omit type; only reject explicit non-inbound types.
  if (type && type !== "InboundMessage" && !isWorkflowContactEnvelope(root)) {
    return null;
  }

  const messageType = String(
    asNonEmptyString(firstDefined(layers, ["messageType", "messageTypeString", "type"])) ??
      "SMS",
  );
  const messageTypeId = Number(firstDefined(layers, ["messageTypeId"]));
  const explicitChannel = layers.some(
    (layer) =>
      layer.messageType !== undefined ||
      layer.messageTypeString !== undefined ||
      layer.messageTypeId !== undefined,
  );
  const looksLikeSms =
    !explicitChannel ||
    messageType.toUpperCase().includes("SMS") ||
    messageType === "TYPE_SMS" ||
    messageTypeId === 2;

  if (!looksLikeSms) {
    return null;
  }

  const contactId =
    asNonEmptyString(firstDefined(layers, ["contactId", "contact_id"])) ??
    asNonEmptyString(contact?.id) ??
    asNonEmptyString(root.contact_id);

  const from =
    asNonEmptyString(firstDefined(layers, ["from", "phone"])) ??
    asNonEmptyString(contact?.phone) ??
    asNonEmptyString(messageObj?.from) ??
    asNonEmptyString(messageObj?.phone) ??
    "";

  const to =
    asNonEmptyString(firstDefined(layers, ["to", "toNumber", "to_number"])) ??
    asNonEmptyString(messageObj?.to) ??
    asNonEmptyString(options?.defaultTo) ??
    "";

  const text =
    asNonEmptyString(firstDefined(layers, ["body", "text", "messageBody"])) ??
    asNonEmptyString(messageObj?.body) ??
    asNonEmptyString(messageObj?.message) ??
    asNonEmptyString(messageObj?.text) ??
    // Only treat root `message` as text when it is a string (Workflow uses an object).
    asNonEmptyString(typeof root.message === "string" ? root.message : undefined) ??
    "";

  const messageId =
    asNonEmptyString(firstDefined(layers, ["messageId", "message_id"])) ??
    asNonEmptyString(messageObj?.id) ??
    asNonEmptyString(messageObj?.messageId) ??
    asNonEmptyString(root.webhookId) ??
    // Stable fallback so Workflow retries stay idempotent.
    (from || contactId
      ? `wf:${contactId ?? from}:${stableIdSuffix(text || from)}`
      : "");

  if (!messageId || !from || !to) {
    return null;
  }

  const location =
    asRecord(root.location) ?? asRecord(nested?.location) ?? asRecord(customData?.location);
  const locationId =
    asNonEmptyString(firstDefined(layers, ["locationId", "location_id"])) ??
    asNonEmptyString(location?.id) ??
    asNonEmptyString(root.locationId);

  return {
    messageId,
    from,
    to,
    text,
    messageType: messageType.includes("SMS") || messageType === "TYPE_SMS" ? messageType : "SMS",
    locationId,
    contactId: contactId ?? undefined,
  };
}

function isWorkflowContactEnvelope(root: Record<string, unknown>): boolean {
  return (
    (typeof root.phone === "string" || typeof root.contact_id === "string") &&
    (root.message !== undefined || root.customData !== undefined || root.workflow !== undefined)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function stableIdSuffix(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function firstString(
  obj: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  if (!obj) {
    return undefined;
  }
  return asNonEmptyString(obj[key]);
}

function firstDefined(
  layers: Record<string, unknown>[],
  keys: string[],
): unknown {
  for (const layer of layers) {
    for (const key of keys) {
      const value = layer[key];
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
  }
  return undefined;
}

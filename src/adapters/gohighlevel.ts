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
 * Normalize GoHighLevel InboundMessage payloads.
 * Marketplace webhooks are often flat; workflow webhooks may nest under `data`.
 */
export function parseGhlInboundMessage(body: unknown): {
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
  const payload = nested ?? root;

  const type = String(root.type ?? payload.type ?? "");
  if (type && type !== "InboundMessage") {
    return null;
  }

  const messageType = String(
    payload.messageType ?? payload.messageTypeString ?? root.messageType ?? "SMS",
  );
  const messageTypeId = Number(payload.messageTypeId ?? root.messageTypeId);
  const looksLikeSms =
    messageType.toUpperCase().includes("SMS") ||
    messageType === "TYPE_SMS" ||
    messageTypeId === 2 ||
    (!payload.messageType && !payload.messageTypeString && !payload.messageTypeId);

  if (!looksLikeSms) {
    return null;
  }

  const messageId = String(
    payload.messageId ?? payload.id ?? root.messageId ?? root.webhookId ?? "",
  );
  const from = String(payload.from ?? payload.phone ?? "");
  const to = String(payload.to ?? "");
  const text = String(payload.body ?? payload.message ?? payload.text ?? "");

  if (!messageId || !from || !to) {
    return null;
  }

  return {
    messageId,
    from,
    to,
    text,
    messageType,
    locationId:
      typeof payload.locationId === "string"
        ? payload.locationId
        : typeof root.locationId === "string"
          ? root.locationId
          : undefined,
    contactId: typeof payload.contactId === "string" ? payload.contactId : undefined,
  };
}

/**
 * GoHighLevel adapter. Verified against the LawSB mock sub-account 2026-07-26:
 *
 *  - Version header differs per endpoint group, exactly as the spec warns:
 *      /locations/*, /contacts/*      -> 2021-07-28
 *      /conversations/*               -> 2021-04-15  (07-28 is rejected)
 *  - POST /conversations/messages returns { conversationId, messageId }.
 *  - The location record's `phone` is NOT the sending number. Sends leave from the
 *    number GHL has attached (+1 740-761-4801 on this sub-account), so the real
 *    sending identity has to be configured, not read from /locations.
 *  - The sub-account has its own live automation. Polling MUST be scoped to the
 *    conversation a run owns, or a stranger's messages land in our transcript.
 */
import { config } from '../config.ts';
import { logEvent } from '../db/index.ts';
import type { ChannelAdapter, InboundEvent, InboundSink, SendArgs, SendResult } from './types.ts';

const CONVERSATIONS_VERSION = '2021-04-15';
const CONTACTS_VERSION = '2021-07-28';

type Json = Record<string, any>;

function headers(version: string, withBody: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${config.channel.ghl.pit}`,
    Version: version,
    accept: 'application/json',
    ...(withBody ? { 'content-type': 'application/json' } : {}),
  };
}

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; version: string } = { version: CONTACTS_VERSION },
): Promise<{ status: number; body: Json; ok: boolean }> {
  const base = config.channel.ghl.apiBase.replace(/\/$/, '');
  const res = await fetch(`${base}${path}`, {
    method,
    headers: headers(opts.version, !!opts.body),
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: Json = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: res.status, body, ok: res.ok };
}

/** Carrier verdicts that mean "this number will never accept SMS". Never retried. */
const PERMANENT = /21614|21408|21606|21610|30006|not a valid mobile|landline|unsubscribed|opted out|blacklist/i;

export type GhlRunBinding = {
  contact_id: string;
  conversation_id: string | null;
};

/** run_id -> GHL ids. Persisted on the run by the caller; this is the hot cache. */
const bindings = new Map<string, GhlRunBinding>();

export function bindRun(runId: string, binding: GhlRunBinding): void {
  bindings.set(runId, binding);
}

export function bindingFor(runId: string): GhlRunBinding | null {
  return bindings.get(runId) ?? null;
}

export function runIdForConversation(conversationId: string): string | null {
  for (const [runId, b] of bindings) if (b.conversation_id === conversationId) return runId;
  return null;
}

/**
 * Finds or creates the contact that represents the *business* we are texting.
 * In this design the CRM contact is the counterparty, and the run is correlated by
 * contact id — the shared-number fallback the spec calls for when per-agent identities
 * are unavailable.
 */
export async function ensureContact(input: {
  phone: string;
  name: string;
  runId: string;
}): Promise<{ contact_id: string } | { error: string }> {
  const lookup = await api('GET', `/contacts/lookup?phone=${encodeURIComponent(input.phone)}`, {
    version: CONTACTS_VERSION,
  });
  const existing = lookup.body?.contacts?.[0]?.id;
  if (lookup.ok && existing) return { contact_id: existing };

  const created = await api('POST', '/contacts/', {
    version: CONTACTS_VERSION,
    body: {
      locationId: config.channel.ghl.locationId,
      firstName: input.name.split(' ')[0] || 'Intake',
      lastName: input.name.split(' ').slice(1).join(' ') || 'Grader',
      phone: input.phone,
      source: `intake-grader ${input.runId}`,
    },
  });
  const id = created.body?.contact?.id ?? created.body?.id;
  if (created.ok && id) return { contact_id: id };

  // Locations with "no duplicate contacts" reject the create but name the existing
  // contact in the error payload. That is the contact we want, so use it.
  const duplicate = created.body?.meta?.contactId;
  if (created.status === 400 && duplicate) {
    logEvent(null, 'ghl_contact_reused', { contact_id: duplicate, phone: input.phone });
    return { contact_id: duplicate };
  }
  return { error: `contact create failed: HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 200)}` };
}

let pollTimer: NodeJS.Timeout | null = null;
/** provider_id values already handed to the sink. Dedupe also lives in the DB. */
const seen = new Set<string>();

export const ghlAdapter: ChannelAdapter = {
  name: 'ghl',

  available(): boolean {
    return !!config.channel.ghl.pit && !!config.channel.ghl.locationId;
  },

  supports(channel): boolean {
    return channel === 'sms' || channel === 'email';
  },

  async send(args: SendArgs): Promise<SendResult> {
    const binding = bindings.get(args.run.id);
    if (!binding?.contact_id) {
      return { ok: false, error: `run ${args.run.id} has no GHL contact binding`, retryable: false };
    }

    const res = await api('POST', '/conversations/messages', {
      version: CONVERSATIONS_VERSION,
      body:
        args.channel === 'email'
          ? { type: 'Email', contactId: binding.contact_id, message: args.body, subject: 'Question about my accident' }
          : { type: 'SMS', contactId: binding.contact_id, message: args.body },
    });

    if (!res.ok) {
      const detail = JSON.stringify(res.body).slice(0, 300);
      const permanent = PERMANENT.test(detail) || res.status === 400 || res.status === 422;
      logEvent(args.run.id, 'ghl_send_failed', { status: res.status, detail, permanent });
      return { ok: false, error: `HTTP ${res.status}: ${detail}`, retryable: !permanent };
    }

    const conversationId = res.body?.conversationId ?? binding.conversation_id;
    if (conversationId && conversationId !== binding.conversation_id) {
      bindings.set(args.run.id, { ...binding, conversation_id: conversationId });
    }
    return { ok: true, provider_id: res.body?.messageId ?? null, note: `conversation ${conversationId}` };
  },

  /**
   * Polls only the conversations bound to active runs. Webhooks come later; polling
   * first is the spec's day-one choice and it avoids needing a public URL.
   */
  start(sink: InboundSink): void {
    if (pollTimer) return;
    const tick = async (): Promise<void> => {
      for (const [runId, binding] of [...bindings]) {
        if (!binding.conversation_id) continue;
        try {
          const res = await api('GET', `/conversations/${binding.conversation_id}/messages?limit=20`, {
            version: CONVERSATIONS_VERSION,
          });
          if (!res.ok) continue;
          const list: Json[] = res.body?.messages?.messages ?? res.body?.messages ?? [];
          // Oldest first so a burst of replies is delivered in order.
          for (const m of [...list].reverse()) {
            const id = m.id ?? m.messageId;
            const inbound = m.direction === 'inbound';
            if (!id || !inbound || seen.has(id)) continue;
            seen.add(id);
            const body = String(m.body ?? '').trim();
            if (!body) continue;
            await sink({
              provider: 'ghl',
              provider_id: id,
              from: m.contactId ?? binding.contact_id,
              to: config.channel.ghl.fromNumber,
              body,
              ts: m.dateAdded ?? new Date().toISOString(),
              run_id: runId,
            } satisfies InboundEvent);
          }
        } catch (err) {
          logEvent(runId, 'ghl_poll_error', { error: (err as Error).message });
        }
      }
    };
    pollTimer = setInterval(() => void tick(), config.channel.ghl.pollMs);
    pollTimer.unref?.();
    void tick();
  },

  stop(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  },
};

/**
 * Marks history as already-seen so a fresh run does not ingest a conversation's backlog.
 * The mock sub-account has real prior traffic in it; without this the first poll would
 * replay months of someone else's messages into turn one.
 */
export async function primeConversation(runId: string, conversationId: string): Promise<number> {
  const res = await api('GET', `/conversations/${conversationId}/messages?limit=100`, {
    version: CONVERSATIONS_VERSION,
  });
  if (!res.ok) return 0;
  const list: Json[] = res.body?.messages?.messages ?? res.body?.messages ?? [];
  let primed = 0;
  for (const m of list) {
    const id = m.id ?? m.messageId;
    if (id && !seen.has(id)) {
      seen.add(id);
      primed += 1;
    }
  }
  logEvent(runId, 'ghl_conversation_primed', { conversation_id: conversationId, primed });
  return primed;
}

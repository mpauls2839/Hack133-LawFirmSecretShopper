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
import { runs } from '../db/repo.ts';
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

/**
 * Bindings live on the run row, not in a Map. The router is long-lived and always-on, and
 * an in-memory binding means a restart orphans every conversation in flight — inbound
 * would arrive with no run to attach it to and be silently dropped.
 */
export function bindRun(runId: string, binding: GhlRunBinding): void {
  runs.patch(runId, {
    provider: 'ghl',
    provider_contact_id: binding.contact_id,
    provider_conversation_id: binding.conversation_id,
  });
}

export function bindingFor(runId: string): GhlRunBinding | null {
  const run = runs.get(runId);
  if (!run?.provider_contact_id) return null;
  return { contact_id: run.provider_contact_id, conversation_id: run.provider_conversation_id };
}

/** Resolve an inbound event to a run by whichever id the provider gave us. */
export function runForProviderIds(ids: {
  conversationId?: string | null;
  contactId?: string | null;
}): string | null {
  return runs.byProviderIds(ids)?.id ?? null;
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
/** Kept so a webhook can trigger an immediate read without waiting for the next tick. */
let activeSink: InboundSink | null = null;
/** provider_id values already handed to the sink. Dedupe also lives in the DB. */
const seen = new Set<string>();

/**
 * Reads one run's conversation and delivers anything new.
 *
 * This is the single source of inbound truth, used by both the poll timer and the webhook.
 * GoHighLevel's workflow webhook action fires "containing the contact's details" — it does
 * not reliably carry a message id or body, so a webhook is treated as a signal that
 * something arrived rather than as the message itself. Reading back from the API also means
 * the body, timestamp and id are the provider's own values, which is what dedupe and the
 * history floor depend on.
 */
export async function drainConversation(runId: string, sink: InboundSink): Promise<number> {
  const run = runs.get(runId);
  if (!run || run.provider !== 'ghl' || !run.provider_conversation_id) return 0;

  let delivered = 0;
  try {
    const res = await api('GET', `/conversations/${run.provider_conversation_id}/messages?limit=20`, {
      version: CONVERSATIONS_VERSION,
    });
    if (!res.ok) return 0;
    const list: Json[] = res.body?.messages?.messages ?? res.body?.messages ?? [];

    /**
     * Hard floor on message age. A shared CRM number carries unrelated history, and the
     * conversation a run binds to may already contain prior traffic — including our own
     * earlier runs. Anything dated before this run opened is history.
     *
     * This must be a timestamp comparison, not the seen-set: that set is process-local, so
     * priming it in one process does nothing for another and a restart empties it. Either
     * case replays old messages as live replies, which fabricates an entire conversation
     * and drove a real run to a terminal state in twelve seconds with nobody having texted.
     */
    const floor = new Date(run.t0 ?? run.created_at).getTime();

    // Oldest first so a burst of replies is delivered in order.
    for (const m of [...list].reverse()) {
      const id = m.id ?? m.messageId;
      const inbound = m.direction === 'inbound';
      if (!id || !inbound || seen.has(id)) continue;
      const body = String(m.body ?? '').trim();
      if (!body) continue;

      const at = new Date(m.dateAdded ?? 0).getTime();
      if (!Number.isFinite(at) || at < floor) {
        seen.add(id);
        logEvent(runId, 'inbound_predates_run', {
          provider_id: id,
          at: m.dateAdded ?? null,
          run_opened: run.t0 ?? run.created_at,
        });
        continue;
      }
      seen.add(id);
      delivered += 1;
      await sink({
        provider: 'ghl',
        provider_id: id,
        from: m.contactId ?? run.provider_contact_id ?? 'unknown',
        to: config.channel.ghl.fromNumber,
        body,
        ts: m.dateAdded ?? new Date().toISOString(),
        run_id: runId,
      } satisfies InboundEvent);
    }
  } catch (err) {
    logEvent(runId, 'ghl_poll_error', { error: (err as Error).message });
  }
  return delivered;
}

async function pollAllRuns(sink: InboundSink): Promise<void> {
  for (const run of runs.active()) {
    if (run.provider === 'ghl') await drainConversation(run.id, sink);
  }
}

/**
 * Webhook entry point for a payload that identifies a contact but carries no usable
 * message. Resolves the run and reads the conversation immediately, so latency is the
 * webhook's rather than the poll interval's.
 */
export async function drainForContact(ids: {
  contactId?: string | null;
  conversationId?: string | null;
}): Promise<{ run_id: string | null; delivered: number }> {
  const run = runs.byProviderIds(ids);
  if (!run) return { run_id: null, delivered: 0 };
  if (!activeSink) return { run_id: run.id, delivered: 0 };
  return { run_id: run.id, delivered: await drainConversation(run.id, activeSink) };
}

export const ghlAdapter: ChannelAdapter = {
  name: 'ghl',

  available(): boolean {
    return !!config.channel.ghl.pit && !!config.channel.ghl.locationId;
  },

  supports(channel): boolean {
    return channel === 'sms' || channel === 'email';
  },

  async send(args: SendArgs): Promise<SendResult> {
    const binding = bindingFor(args.run.id);
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
      bindRun(args.run.id, { ...binding, conversation_id: conversationId });
    }
    return { ok: true, provider_id: res.body?.messageId ?? null, note: `conversation ${conversationId}` };
  },

  /**
   * Polls only the conversations bound to still-open runs. This is the backstop now that
   * webhooks are wired: a missed or misconfigured webhook must not silently stall a run,
   * and dedupe on (provider, provider_id) means both paths can deliver the same message
   * safely. Set GHL_POLL_MS=0 to run webhook-only.
   */
  start(sink: InboundSink): void {
    activeSink = sink;
    if (pollTimer || config.channel.ghl.pollMs <= 0) return;
    pollTimer = setInterval(() => void pollAllRuns(sink), config.channel.ghl.pollMs);
    pollTimer.unref?.();
    void pollAllRuns(sink);
  },

  stop(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  },
};

/**
 * Parses a GoHighLevel workflow webhook into our inbound shape.
 *
 * GHL has no webhook-registration API for a Private Integration Token, so the hook is a
 * Workflow action configured in the UI, and its payload shape varies by trigger and by how
 * the action is set up — fields appear at the top level, under `message`, or under
 * `customData`. Rather than assume one shape, every known location is checked.
 *
 * Returns a reason instead of throwing: a webhook we cannot parse must still be answered
 * 200 and logged, because a 500 makes the provider retry the same bad payload forever.
 */
export function parseGhlWebhook(payload: Record<string, any>): {
  event?: Omit<InboundEvent, 'run_id'> & { conversation_id: string | null; contact_id: string | null };
  skip?: string;
} {
  const msg = payload.message ?? payload.Message ?? payload.customData ?? {};
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      for (const source of [payload, msg]) {
        const value = source?.[key];
        if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
      }
    }
    return null;
  };

  const body = pick('body', 'message_body', 'messageBody', 'text', 'sms_body');
  const providerId = pick('messageId', 'message_id', 'id', 'msgId');
  const contactId = pick('contactId', 'contact_id');
  const conversationId = pick('conversationId', 'conversation_id');
  const direction = (pick('direction', 'messageDirection') ?? '').toLowerCase();
  const type = (pick('messageType', 'message_type', 'type') ?? '').toLowerCase();

  // Our own outbound comes back through the same workflow. Ingesting it would have the
  // persona replying to itself, so anything not clearly inbound is dropped.
  if (direction && direction !== 'inbound') return { skip: `direction is ${direction}` };
  if (!direction && type && /outbound/.test(type)) return { skip: `type is ${type}` };
  if (!body) return { skip: 'no message body in payload' };
  if (!providerId) return { skip: 'no message id to dedupe on' };
  if (!contactId && !conversationId) return { skip: 'no contact or conversation id to route by' };

  return {
    event: {
      provider: 'ghl',
      provider_id: providerId,
      from: contactId ?? conversationId ?? 'unknown',
      to: config.channel.ghl.fromNumber,
      body,
      ts: pick('dateAdded', 'date_added', 'timestamp', 'createdAt') ?? new Date().toISOString(),
      contact_id: contactId,
      conversation_id: conversationId,
    },
  };
}

/**
 * Marks a message id as already delivered. Called when the webhook path handles an event
 * so the poller does not re-deliver it. Dedupe in the database is the real guarantee; this
 * just avoids the wasted round trip.
 */
export function markSeen(providerId: string): void {
  seen.add(providerId);
}

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

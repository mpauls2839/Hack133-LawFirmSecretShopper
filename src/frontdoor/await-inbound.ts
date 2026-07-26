/**
 * FIFO registry of runs waiting for an unsolicited inbound SMS to our number
 * (Path B: form submitted with FRONTDOOR_INBOUND_NUMBER).
 *
 * When the firm texts us from an unknown number, sink() claims the oldest
 * awaiting run and binds the GHL contact to that sender.
 */
import { config } from '../config.ts';
import { logEvent } from '../db/index.ts';

export type AwaitInboundEntry = {
  run_id: string;
  target_id: string;
  inbound_number: string;
  enqueued_at: string;
};

const queue: AwaitInboundEntry[] = [];

export function enqueueAwaitInbound(entry: Omit<AwaitInboundEntry, 'enqueued_at'>): AwaitInboundEntry {
  const full: AwaitInboundEntry = { ...entry, enqueued_at: new Date().toISOString() };
  queue.push(full);
  logEvent(entry.run_id, 'await_inbound_enqueued', {
    inbound_number: entry.inbound_number,
    queue_depth: queue.length,
  });
  return full;
}

export function peekAwaitInbound(inboundNumber?: string): AwaitInboundEntry | null {
  const want = normalizePhone(inboundNumber ?? config.frontdoor.inboundNumber);
  return queue.find((e) => normalizePhone(e.inbound_number) === want) ?? null;
}

/** Claim and remove the oldest awaiting run for this inbound number. */
export function claimAwaitInbound(inboundNumber?: string): AwaitInboundEntry | null {
  const want = normalizePhone(inboundNumber ?? config.frontdoor.inboundNumber);
  const idx = queue.findIndex((e) => normalizePhone(e.inbound_number) === want);
  if (idx < 0) return null;
  const [claimed] = queue.splice(idx, 1);
  logEvent(claimed.run_id, 'await_inbound_claimed', {
    inbound_number: claimed.inbound_number,
    queue_depth: queue.length,
  });
  return claimed;
}

export function cancelAwaitInbound(runId: string): boolean {
  const idx = queue.findIndex((e) => e.run_id === runId);
  if (idx < 0) return false;
  queue.splice(idx, 1);
  logEvent(runId, 'await_inbound_cancelled', { queue_depth: queue.length });
  return true;
}

export function listAwaitInbound(): AwaitInboundEntry[] {
  return [...queue];
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (raw.trim().startsWith('+') && digits.length >= 8) return `+${digits}`;
  return digits ? `+${digits}` : raw.trim();
}

/** True when `to` looks like our front-door inbound number. */
export function isOurInboundNumber(to: string): boolean {
  const ours = normalizePhone(config.frontdoor.inboundNumber);
  const theirs = normalizePhone(to);
  if (!to || !ours) return false;
  return theirs === ours || theirs.endsWith(ours.slice(-10)) || ours.endsWith(theirs.slice(-10));
}

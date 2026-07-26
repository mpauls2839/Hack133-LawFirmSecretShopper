import type { ChannelName, MessageKind, Persona, Run, Target } from '../domain/types.ts';

export type SendArgs = {
  run: Run;
  target: Target;
  persona: Persona;
  channel: ChannelName;
  address: string;
  body: string;
  kind: MessageKind;
};

export type SendResult =
  | { ok: true; provider_id: string | null; note?: string }
  | { ok: false; error: string; retryable: boolean };

export type InboundEvent = {
  provider: string;
  /** Dedupe key. The same event can arrive twice. */
  provider_id: string;
  from: string;
  to: string;
  body: string;
  ts: string;
  /** Set when the transport already knows the run (per-agent identity, or a mock). */
  run_id?: string;
  /** GHL conversation id when known (discovery / webhook). Used to bind after claim. */
  conversation_id?: string;
};

export type InboundSink = (event: InboundEvent) => Promise<void>;

export type ChannelAdapter = {
  name: string;
  /** False means credentials or transport are missing; the router will not select it. */
  available(): boolean;
  supports(channel: ChannelName): boolean;
  send(args: SendArgs): Promise<SendResult>;
  /** Per-run sending identity (phone + email) where the transport can provision one. */
  provisionIdentity?(run: Run): Promise<{ agent_name: string; phone?: string; email?: string } | null>;
  /** Pollers start here. Webhook-driven adapters ignore it. */
  start?(sink: InboundSink): void;
  stop?(): void;
};

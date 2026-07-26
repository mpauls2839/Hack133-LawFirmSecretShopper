/**
 * Mock business. Two configurations, one tuned well and one deliberately sloppy
 * (spec 9.4), so the whole loop is exercisable with nothing outside this process.
 *
 * This is also the demo safety net: the stage run does not depend on a stranger replying.
 */
import { config } from '../config.ts';
import { logEvent } from '../db/index.ts';
import type { ChannelAdapter, InboundEvent, InboundSink, SendArgs, SendResult } from './types.ts';

export type MockProfile = 'well_run' | 'sloppy' | 'promise_breaker' | 'declines';

type ScriptStep = {
  /** Seconds after our outbound that this reply arrives. */
  after: number;
  body: string;
};

/** Nothing after the last step: the run must be closed by the sweeper, not by a script. */
const SCRIPTS: Record<MockProfile, ScriptStep[]> = {
  well_run: [
    {
      after: 95,
      body:
        "Hi Dana, this is Marcy at the front desk — sorry you're dealing with that. Do you know if a police report was filed, and have you seen a doctor yet?",
    },
    {
      after: 210,
      body:
        "Thanks. Don't give the other insurer a recorded statement yet. Our personal injury attorney, Ruth Alvarez, handles rear-end cases like this. Consultations are free and we work on contingency, so nothing out of pocket.",
    },
    {
      after: 160,
      body:
        'Ruth has 4:30pm today or 9:15am tomorrow. Which works? I can text you a confirmation either way.',
    },
    {
      after: 90,
      body: "You're all set — appointment confirmed for 4:30pm today with Ruth. She'll call this number.",
    },
  ],
  sloppy: [
    {
      after: 4,
      body:
        'Thank you for contacting us! Your message is important to us. Our regular business hours are Mon-Fri 9am-5pm. Reply STOP to opt out. Msg&data rates may apply.',
    },
    {
      after: 22,
      body:
        "Hi there! I'm the virtual assistant for the firm. To better assist you, please answer a few quick questions. First: what type of case do you have? Reply with a number: 1) Auto 2) Slip and fall 3) Other",
    },
    {
      after: 18,
      body:
        'Got it. On a scale of 1-10, how severe are your injuries? Also, please confirm the date of the incident in MM/DD/YYYY format.',
    },
    {
      after: 25,
      body:
        'Thank you! Someone from our team will review your information and be in touch. Our regular business hours are Mon-Fri 9am-5pm.',
    },
    {
      after: 30,
      body:
        'Thank you for contacting us! Your message is important to us. Our regular business hours are Mon-Fri 9am-5pm.',
    },
  ],
  promise_breaker: [
    {
      after: 6,
      body:
        'Thanks for reaching out to the firm. We have received your inquiry and someone will get back to you within 24 hours.',
    },
    // Deliberately nothing else. The promise timer must catch this.
  ],
  declines: [
    {
      after: 140,
      body:
        "Hi Dana, this is Tom. I'm sorry, we don't handle auto injury cases — we only do estate planning and probate. I'd refer you to a personal injury firm; the state bar referral line can point you to one.",
    },
  ],
};

type MockRunState = { profile: MockProfile; step: number; timers: NodeJS.Timeout[] };

const state = new Map<string, MockRunState>();
let sink: InboundSink | null = null;

/** Pick which mock business this run is talking to. */
export function setMockProfile(runId: string, profile: MockProfile): void {
  const existing = state.get(runId);
  if (existing) existing.profile = profile;
  else state.set(runId, { profile, step: 0, timers: [] });
}

export function mockProfileFor(runId: string): MockProfile {
  return state.get(runId)?.profile ?? 'well_run';
}

/** Domain suffix convention lets a pasted fixture URL select the mock's behaviour. */
export function profileFromDomain(domain: string): MockProfile {
  if (/sloppy/.test(domain)) return 'sloppy';
  if (/promise|ghost/.test(domain)) return 'promise_breaker';
  if (/decline|estate|probate/.test(domain)) return 'declines';
  return 'well_run';
}

export function clearMockRun(runId: string): void {
  const s = state.get(runId);
  for (const t of s?.timers ?? []) clearTimeout(t);
  state.delete(runId);
}

export function clearAllMockRuns(): void {
  for (const runId of [...state.keys()]) clearMockRun(runId);
}

function scheduleInbound(runId: string, address: string, step: ScriptStep, index: number): void {
  const s = state.get(runId);
  if (!s || !sink) return;
  const delayMs = config.fastClock ? 5 : step.after * 1000;
  const event: InboundEvent = {
    provider: 'mock',
    provider_id: `mock_${runId}_${index}`,
    from: address,
    to: 'persona',
    body: step.body,
    ts: new Date(Date.now() + delayMs).toISOString(),
    run_id: runId,
  };
  const timer = setTimeout(() => {
    sink?.(event).catch((err) => logEvent(runId, 'mock_inbound_error', { error: (err as Error).message }));
  }, delayMs);
  timer.unref?.();
  s.timers.push(timer);
}

export const mockAdapter: ChannelAdapter = {
  name: 'mock',
  available: () => true,
  supports: () => true,

  async send(args: SendArgs): Promise<SendResult> {
    const runId = args.run.id;
    if (!state.has(runId)) {
      state.set(runId, { profile: profileFromDomain(args.target.domain), step: 0, timers: [] });
    }
    const s = state.get(runId)!;
    const script = SCRIPTS[s.profile];
    const index = s.step;
    s.step += 1;

    // A closing message gets no reply; the mock business is done with us.
    if (args.kind !== 'closing' && index < script.length) {
      scheduleInbound(runId, args.address || `mock:${args.target.domain}`, script[index], index);
    }
    return { ok: true, provider_id: `mock_out_${runId}_${index}`, note: `mock profile ${s.profile}` };
  },

  start(inboundSink: InboundSink) {
    sink = inboundSink;
  },

  stop() {
    clearAllMockRuns();
    sink = null;
  },
};

/** Test hook: deliver the next scripted reply immediately instead of on a timer. */
export function mockScript(profile: MockProfile): ScriptStep[] {
  return SCRIPTS[profile];
}
